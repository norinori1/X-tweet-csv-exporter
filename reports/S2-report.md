# S2 Report — Interceptor + collector

> Review follow-up: the five change requests on `d16483a` (early-response
> ordering, request-time attribution/author filtering, restore-vs-mutation
> serialization, two-tab merge, and storage error propagation) are implemented
> and documented in [`reports/S2-review-fixes.md`](S2-review-fixes.md). The
> sections below describe the original S2 slice and are kept for history.

- Worker: dsh (DeepSeek V4.1 Flash), dispatched by the Orca coordinator.
- Repo: norinori1/X-tweet-csv-exporter (this worktree).
- Worktree/branch: `C:\Users\Takumi\orca\workspaces\X-tweet-csv-exporter\xtce-s2-new`,
  branch `norinori1/xtce-s2-new`.
- Base: `f9e6ee7` (origin/main, S1 squash merge of PR #4). S1 was independently
  reviewed before this slice; PR #4 is merged. No push, no PR; the extension
  itself makes no external requests.

## What was built

| File | Contents |
| --- | --- |
| `src/interceptor.js` | MAIN-world `document_start` script. Wraps `window.fetch` and `XMLHttpRequest.prototype.open/send`, filters same-origin `/i/api/graphql/` or `/i/api/2/` timeline URLs, parses JSON, runs `window.__XTCE_parse.extractFromGraphQL`, and posts `{type:"XTCE_TWEETS", tweets}` to `location.origin` when non-empty. |
| `src/store.js` | Pure, dependency-free per-user store. Map buckets keyed by tweet id, dedupe (newest record wins), per-user switch/restore, 500 ms trailing-throttle persistence through an injected `get`/`set` adapter, clear and subscribe. |
| `src/content.js` | ISOLATED-world collector. Origin/type-checked message listener, route resolution, `chrome.storage.local` adapter, SPA polling + popstate/hashchange, pagehide flush, and the S3-facing `globalThis.__XTCE_content` API. |
| `manifest.json` | Two content-script entries: `src/parser.js` + `src/interceptor.js` in MAIN at `document_start`; `src/store.js` + `src/content.js` in ISOLATED at `document_idle`. Same two matches and the same `storage`-only permissions as S1. |
| `tests/collector.test.mjs` | 26 Node test groups covering the store, interceptor, content wiring and manifest. Uses fake fetch/XHR, fake `chrome.storage.local`, fake timers/clocks; no network. |
| `tests/parser.test.mjs` | Updated only the manifest group to expect the S2 content-script wiring (S1 parser assertions are unchanged and still pass). |
| `README.md` | Status moved to S2, file table, collection flow, storage key/format, S3 API, test commands, known limits. |
| `reports/S2-report.md` | This report. |

## Design

### Interceptor (`src/interceptor.js`)

- Installed at `document_start` before x.com scripts, guarded by
  `window.__XTCE_INTERCEPTOR__` so a double load cannot double-wrap.
- Target filter: same origin as the page, URL contains `/i/api/graphql/` or
  `/i/api/2/`, and the pathname/query names one of `UserTweets`,
  `UserTweetsAndReplies`, `UserMedia`, `Likes`, `SearchTimeline`, `TweetDetail`,
  `Bookmarks`, `ListLatestTweetsTimeline`, `HomeTimeline`,
  `HomeLatestTimeline`.
- `fetch`: the original promise is returned untouched; a response branch clones
  it and reads `json()`. The clone is registered before the page's own
  continuation, so it happens before the page consumes the body.
- XHR: `open` records the URL in a WeakMap; `send` attaches a `load` listener
  (replacing an earlier one if the XHR object is reused). `responseType` `""`,
  `text`, `json`, `arraybuffer` and `blob` are handled; non-2xx/304 and
  unreadable bodies are skipped.
- Every hook path, JSON parse, parser call and `postMessage` is wrapped in
  `try/catch`; rejected fetch promises are swallowed for instrumentation but
  still reach the page unchanged.

### Store (`src/store.js`)

- `buckets: Map<username, Map<id, record>>`. Duplicate ids do not increase the
  count; the newest payload replaces the old object so refreshed engagement
  counts are kept.
- `usernameFromPath` implements the S2 rule exactly: first path segment,
  lowercased, 1-15 `[A-Za-z0-9_]`, reserved route list excluded.
- `usernameFromLocation` adds one deliberate fallback: on `/search` it reads
  the first `from:user` operator from `q`. This lets S3's date-sliced search
  deep scan persist into the same `xtce_<user>` bucket instead of dropping the
  batch. Profile routes always win.
- Persistence: `chrome.storage.local["xtce_<username>"] =
  {version:1, username, updatedAt, records:[...]}`. Writes are trailing-throttled
  to one batch per 500 ms and chained so an older snapshot cannot overwrite a
  newer one. `switchUser`/`pagehide` flush immediately; `clearCurrent` queues an
  empty write after pending writes.
- Restore accepts both the object payload above and a bare records array; it
  merges missing ids and keeps an in-memory record that arrived while storage
  was loading. A failed read clears the `loaded` flag so a later switch retries.
- Subscribers receive a fresh `{username, count, records}` snapshot on switch,
  ingest and clear. `subscribe` returns an unsubscribe function and does not
  call the listener immediately.

### Content script (`src/content.js`)

- Message listener checks `event.origin === location.origin` and the
  `isTweetMessage` shape before ingesting. Wrong-origin, wrong-type and
  malformed messages are dropped.
- Route changes: x.com uses `history.pushState`, which cannot be observed from
  an isolated world, so the route is re-resolved every 500 ms and on
  `popstate`/`hashchange`. `store.switchUser` no-ops when the username is
  unchanged, so tab changes under one profile do not re-read storage.
- `pagehide` flushes pending writes. Storage adapter consumes
  `chrome.runtime.lastError` and degrades to memory-only if the extension
  context is invalidated.
- S3 API on `globalThis.__XTCE_content`: `getState`, `subscribe`,
  `clearCurrent`, `flush`, documented in the README and below.

### Manifest

```json
[
  { "js": ["src/parser.js", "src/interceptor.js"], "run_at": "document_start", "world": "MAIN" },
  { "js": ["src/store.js", "src/content.js"], "run_at": "document_idle", "world": "ISOLATED" }
]
```

Matches are exactly `https://x.com/*` and `https://twitter.com/*`;
`permissions` is still `["storage"]`; no `tabs`, `webRequest`, `<all_urls>`, or
new host permissions.

## Test command and result

```text
$ node tests/parser.test.mjs
ok - parser loads in vm and exposes the frozen API
ok - walks the timeline and skips tombstone and cursor entries
ok - maps a normal tweet, its entities, media and views
ok - flags a retweet and keeps the nested original out of the records
ok - prefers note_tweet text and its entity_set for long posts
ok - unwraps TweetWithVisibilityResults and maps reply fields
ok - extractTweetResult returns null for tombstones and empty input
ok - toCSV writes BOM, frozen header, CRLF rows and RFC escaping
ok - manifest keeps the frozen permissions and the S2 content-script wiring
PASS (9 test groups)
```

```text
$ node tests/collector.test.mjs
ok - store loads in vm and exposes the S2 helpers
ok - usernameFromPath extracts profiles and rejects reserved/invalid routes
ok - usernameFromLocation falls back to /search?q=from:user
ok - isTweetMessage validates the interceptor message shape
ok - store dedupes by id and keeps the newest record
ok - store ignores malformed records and coerces numeric ids
ok - store switches per-user buckets and persists each one
ok - store restores object and bare-array payloads from storage
ok - store throttles persistence into one write per 500 ms window
ok - store clearCurrent empties memory and the persisted bucket
ok - store notifies subscribers and unsubscribes cleanly
ok - manifest wires MAIN interceptor and isolated collector with frozen permissions
ok - interceptor hooks fetch and posts extracted target tweets
ok - interceptor accepts URL and Request-like fetch inputs
ok - interceptor accepts every listed operation and ignores other URLs
ok - interceptor hooks XHR open/send for text and json responses
ok - interceptor ignores non-target, failed and malformed XHR responses
ok - interceptor never surfaces parser/JSON failures into page code
ok - interceptor installs only once
ok - content collector receives batches, dedupes and persists
ok - content collector restores an existing bucket on load
ok - content collector rejects wrong-origin, wrong-type and malformed messages
ok - content collector switches and restores per-user buckets on SPA navigation
ok - content collector uses /search?q=from:user and ignores /home
ok - content collector flushes on pagehide and clearCurrent empties the bucket
ok - content collector exposes getState/subscribe for S3
PASS (26 test groups)
```

Both exited `0`. The tests are fully synthetic (fake fetch/XHR, fake storage,
fake timers); they do not contact X or any other server. `node --check` was also
run on the three new source files and the test file.

## How S3 should consume the store

In the isolated world (or directly inside `src/content.js`, since S3 is planned
to live in this same file):

```js
const { username, count, records } = globalThis.__XTCE_content.getState();
const unsubscribe = globalThis.__XTCE_content.subscribe((state) => render(state));
// CSV: sort a copy of records by created_at_iso ascending, then feed S1's
// parser.toCSV(records) so the frozen column order/BOM/CRLF stay identical.
await globalThis.__XTCE_content.clearCurrent();
await globalThis.__XTCE_content.flush();
```

`records` is in insertion order and each object has the S1 record shape (the
27 CSV columns). The S3 panel should call `getState()` once and then rely on
`subscribe`; the listener is not invoked on registration. `clearCurrent` is
already implemented in the store and content API, so S3 only needs the UI and
download wiring.

## Frozen-scope checks

- Manifest `permissions` is exactly `["storage"]` and `host_permissions` is
  exactly the two X/Twitter origins. No `tabs`, no `webRequest`, no
  `<all_urls>`, no new permissions.
- No network requests are made by the extension. The interceptor only reads
  responses the page already requested; it never calls fetch/XHR itself.
- No telemetry, remote config, API keys or dependencies. No build step.
- Collected data stays in `chrome.storage.local` under `xtce_<username>`.
- CSV columns are untouched (S1 parser and its test are unchanged apart from
  the manifest-wiring assertion).
- Retweeted/quoted originals still never become separate records (S1 parser
  tests unchanged and passing).

## What remains

- Coordinator: independent review of this diff, re-run both test commands, then
  push `norinori1/xtce-s2-new`, open a PR, squash-merge it into `main` and delete
  the branch. Nothing has been pushed.
- S3: floating panel, auto-scroll with stall detection, CSV/JSON download,
  `src/panel.css`, `popup.html` and the full README. The store API, clear and
  search `from:` bucketing are already in place.
- Owner: real-device verification in Chrome after S3. This report does not
  claim the extension "works on X"; only the synthetic tests pass.

## Decisions, uncertainties and known limits

- **Branch name**: the issue text asks for `feat/s2-collector`, but this Orca
  worktree was created on `norinori1/xtce-s2-new`. Following the S1 precedent
  and the orchestrator's review/push flow, the commit stays on the worktree
  branch. No push was done.
- **Search fallback is an addition**: the S2 spec only defines the first path
  segment. I added `/search?q=from:user` because S3's documented deep scan uses
  that page and its batches would otherwise have no bucket. Profile detection
  still follows the S2 rule exactly; only the no-profile search route gets the
  fallback. Home/explore/bookmarks batches are still discarded.
- **Non-profile pages**: home, explore, bookmarks, list pages etc. have no
  single profile username, so `getState().username` is `null` and batches are
  ignored. If S3 needs Bookmark/Home collection, it must define a bucket rule
  (e.g. group by `record.author_username`) when it extends `content.js`.
- **SPA detection**: `history.pushState` is invisible from an isolated world;
  polling every 500 ms is the reliable option. A slow in-flight response that
  resolves after a route change can be attributed to the new route's bucket
  (the message format is exactly the specified `{type, tweets}` and carries no
  source URL). This is a narrow race, not exercised by the tests.
- **Same-origin restriction**: the interceptor ignores cross-origin URLs even
  if they contain the GraphQL marker. X's internal GraphQL calls are
  same-origin; this keeps the extension from parsing responses that are not
  part of the page's own timeline traffic.
- **XHR response types**: `text`/`json`/`arraybuffer`/`blob` are supported, but
  real X clients normally use fetch or text XHR. Blob parsing is asynchronous
  via `FileReader`; unusual response types are skipped safely.
- **Storage quota**: `chrome.storage.local` has a roughly 10 MB default quota
  and no `unlimitedStorage` permission is allowed by the brief. Long histories
  may exceed it; the store keeps working in memory and the next full write can
  recover once space is available. Not load-tested.
- **Mixed-author responses**: the S2 contract assigns every record in a batch to
  the current route's profile bucket. `Likes` (on `/user/likes`) and
  `TweetDetail` (on `/user/status/id`, whose payload can include replies by
  other people) therefore store other authors' tweets in that user's bucket.
  That matches the literal S2 rule ("per current profile"), but S3 may want to
  filter `author_username` for profile exports or add operation metadata if
  likes/reply participants must be excluded.
- **Real payload drift**: no real x.com session or payload was used (owner
  real-device verification is the gate). The synthetic fixture follows the S1
  shape; operation names and nesting are the main drift risks.
- **S1 test update**: `tests/parser.test.mjs` previously asserted a one-entry
  manifest. It now asserts the two S2 entries so the S1 suite stays green; the
  parser/CSV assertions themselves were not changed.
