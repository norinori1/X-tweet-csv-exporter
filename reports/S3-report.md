# S3 Report — Panel UI + export + README

> **S3 review follow-up.** The review found the README overstating storage and
> durability: it said collected data lives only in `xtce_<user>` although every
> commit also writes a full copy to `xtce:wal:<user>`, and it did not qualify
> crash recovery or cross-tab behaviour as synthetic-only. The README now
> documents the journal copy and its capacity cost, restores the S2-established
> limitations (journal duplication while committing, surfaced quota failures,
> and recovery ordering dependent on storage-backend operation ordering), uses
> the exclusive `until:2021-01-01` boundary for all of 2020, and states that
> recovery/cross-tab behaviour is synthetic-tested only with the owner's
> real-Chrome gate. No source or test files changed; all three suites were
> re-run for this follow-up.

- Worker: dsh (DeepSeek V4.1 Flash), dispatched by the Orca coordinator.
- Repo: norinori1/X-tweet-csv-exporter (this worktree).
- Worktree/branch: `C:\Users\Takumi\orca\workspaces\X-tweet-csv-exporter\xtce-s3-new`,
  branch `norinori1/xtce-s3-new`.
- Issue: [#3 [S3] Panel UI + export + README](https://github.com/norinori1/X-tweet-csv-exporter/issues/3).
- Base: `68edf09` (origin/main, "S2: Collect GraphQL timeline responses locally (#5)").
  S2 was independently reviewed and merged (PR #5) before this slice. S2's task and
  push task are `completed` in the orchestration task list; this worker did not push.

## What was built

| File | Contents |
| --- | --- |
| `src/csv.js` | New shared CSV builder: frozen 27-column order, RFC 4180 escaping, UTF-8 BOM, CRLF. Loaded in MAIN before `parser.js` and in ISOLATED before `panel.js`. |
| `src/parser.js` | Refactored to consume `globalThis.__XTCE_csv`; `toCSV`/`CSV_COLUMNS` are the same objects the panel uses. Parsing behaviour is unchanged. |
| `src/panel.js` | New ISOLATED-world content script: bottom-right collapsible panel, `@username` / count / status, auto-scroll start/stop with stall detection, CSV/JSON Blob downloads, clear. Uses only `globalThis.__XTCE_content` and `globalThis.__XTCE_csv`; never touches `chrome.storage.local`. |
| `src/panel.css` | New dark, X-like panel CSS scoped under `#xtce-panel`, `z-index: 2147483647`, fixed box only (no overlay, no page-click interception outside the panel). |
| `popup.html` | New action popup: open profile → start → download, replies/search tips, and "everything is local". |
| `manifest.json` | Adds `action.default_popup`; loads `src/csv.js` first in both worlds, `src/panel.js` in ISOLATED, and registers `src/panel.css` via `content_scripts.css`. Permissions and host permissions are unchanged. |
| `tests/panel.test.mjs` | New S3 suite (18 groups): fake DOM, fake clock, fake S2 content API, fake Blob/object URLs. Covers rendering, collapse, state/error display, auto-scroll timing/stall/slow retry/growth reset/user switch, CSV/JSON downloads, empty export, clear success/failure, filename helpers, sort order, `DOMContentLoaded` boot, and safety properties. |
| `tests/parser.test.mjs` | Loads `src/csv.js` before `parser.js`; asserts parser delegates to the shared builder; manifest group updated to the S3 wiring. |
| `tests/collector.test.mjs` | Loads `src/csv.js` before `parser.js` in the two vm harnesses; manifest group updated to the S3 wiring and file list. |
| `README.md` | Full Japanese README: install, profile/replies/search usage (exclusive `until:` boundary), panel controls, CSV columns/format, JSON format, storage/privacy (snapshot plus the WAL copy and its capacity cost), architecture, tests, known limits (synthetic-only recovery/cross-tab, quota, backend-ordering assumption), real-device checklist. |
| `reports/S3-report.md` | This report. |

No new permissions, no new dependencies, no build step, and no request made by the
extension itself. Nothing was pushed.

## Design

### Shared CSV builder (`src/csv.js`)

The S2 parser owned `toCSV` / `CSV_COLUMNS`. The panel is in the ISOLATED world, so
the builder was moved to `src/csv.js` and loaded before both consumers:

```json
MAIN:     ["src/csv.js", "src/parser.js", "src/interceptor.js"]
ISOLATED: ["src/csv.js", "src/store.js", "src/content.js", "src/panel.js"]
```

`parser.js` fails fast with a clear error if `__XTCE_csv` is missing (so a wiring
mistake is visible in tests instead of silently using a second implementation).
`tests/parser.test.mjs` asserts `csvApi.toCSV === parser.toCSV` and
`csvApi.CSV_COLUMNS === parser.CSV_COLUMNS`; the existing BOM/escaping/header tests
now exercise the shared implementation.

### Panel (`src/panel.js`, `src/panel.css`)

- `document_start` load; the panel mounts on `DOMContentLoaded` when `document.body`
  exists. Loaded as a separate content-script file after `content.js` (still a
  content script; `manifest.json` registers it), which keeps the S2 collector file
  unchanged apart from the shared builder.
- Layout: fixed bottom-right 300px box, collapsible body, `#xtce-panel` id, no
  full-screen wrapper, so clicks outside the panel reach the page.
- Fields: `@username` (`—` on non-profile pages), record count, status line.
- Buttons: 自動スクロール開始, 停止, CSV ダウンロード, JSON ダウンロード, クリア.
- State: subscribes to `__XTCE_content.subscribe`; `update()` renders state and errors.
  Storage errors are shown as `保存エラー: <message> (<code>)` and disappear when the
  store clears the error.
- Clear: calls `clearCurrent()` synchronously (the store empties memory immediately),
  shows `クリアしています…`, then `クリアしました（@user）` only after the coordinator
  commit resolves. Rejections show `クリアに失敗しました: ...`.

### Auto-scroll

`createAutoScroller` uses an injected clock so it is testable:

- Scrolls to the bottom immediately and every **1800 ms**.
- Each tick compares the current count with the previous tick. After **6 consecutive
  no-growth checks**, it switches to a **5000 ms** retry interval and status
  `応答がありません。間隔を延ばして再試行しています…`.
- After **3 more no-growth retries**, it stops and shows
  `タイムラインの末尾、またはレート制限の可能性があります`.
- Growth at any point resets both counters and returns to the fast interval.
- Manual stop shows `停止しました`; profile changes stop auto-scroll with
  `ユーザーが切り替わったため自動スクロールを停止しました`.
- Manual scrolling still collects through S2; auto-scroll is only a convenience.

The 1.8 s / 6 / 5 s / 3 constants are the defaults in `panel.js` (`DEFAULTS`) and are
covered by `tests/panel.test.mjs`.

### Downloads

- CSV: a copy of the current bucket is sorted by `created_at_iso` ascending (stable),
  serialized by `src/csv.js` (BOM, fixed header, CRLF), wrapped in a
  `text/csv;charset=utf-8` Blob, clicked through a hidden `<a download>`, and the
  object URL is revoked after 1 s.
- JSON: the same sorted array, `JSON.stringify(..., null, 2) + "\n"`,
  `application/json;charset=utf-8`.
- Filenames: `tweets_<sanitized-username>_<yyyy-mm-dd-hhmmss>.<csv|json>` in the
  browser's local time. Missing/invalid usernames become `unknown`; characters
  outside `[A-Za-z0-9_]` are removed.
- Empty buckets show `ダウンロードできるツイートがありません` and do not create a file.
- Blob/anchor failures are caught and shown in the status line.

### Manifest, popup and CSS

- `action.default_popup: "popup.html"`; no new permission (action is not a permission).
- `content_scripts.css: ["src/panel.css"]` on the isolated entry.
- CSS is scoped under `#xtce-panel`, uses `box-sizing: border-box`, sets a dark X-like
  palette, hover/focus/disabled states, `[hidden]` for the collapsed body, and never
  uses a full-screen fixed element.

## Tests (all re-run for S3)

Environment: Node.js v24.15.0, no dependencies.

```text
$ node tests/parser.test.mjs
ok - parser loads in vm and exposes the frozen API
ok - parser delegates CSV serialization to the shared src/csv.js
ok - walks the timeline and skips tombstone and cursor entries
ok - maps a normal tweet, its entities, media and views
ok - flags a retweet and keeps the nested original out of the records
ok - prefers note_tweet text and its entity_set for long posts
ok - unwraps TweetWithVisibilityResults and maps reply fields
ok - extractTweetResult returns null for tombstones and empty input
ok - toCSV writes BOM, frozen header, CRLF rows and RFC escaping
ok - manifest keeps the frozen permissions and the S3 content-script wiring
PASS (10 test groups)
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
ok - store waits for an in-flight restore before writing a merge
ok - store does not write a partial snapshot when the read fails and retries
ok - store clearCurrent is not undone by a delayed restore
ok - store retries a failed clear without resurrecting records
ok - store propagates quota failures, keeps the bucket dirty and retries
ok - two stores on the same user merge interleaved writes
ok - store merges records written by another tab without marking them dirty
ok - store applies an external clear snapshot instead of ignoring it
ok - store ignores a stale snapshot with an older clear epoch
ok - store removes a deleted storage key from memory without writing it back
ok - a stale tab re-reads the clear epoch and does not resurrect records
ok - a clear queued behind an in-flight merge write still wins
ok - a cross-tab clear observed during a clear write cannot be overwritten
ok - a write held past the old 60 s lease TTL cannot be overtaken by the peer
ok - serialization does not depend on navigator.locks or a shared page lock
ok - a failed held write releases the queue and the peer merges on retry
ok - a store without a coordinator fails closed and never writes
ok - a store fails closed on a coordinator snapshot without records
ok - two clear requests during one clear write are both applied
ok - a store rejects legacy lock/lease options instead of silently degrading
ok - an interrupted commit is repaired from the journal after a worker restart
ok - a malformed write-ahead journal fails closed without touching the snapshot
ok - a malformed stored snapshot is never treated as empty
ok - the coordinator rejects malformed requests
ok - background service worker answers only after the coordinator commit
ok - background service worker rejects messages from other extensions
ok - background service worker repairs a journal on startup
ok - manifest wires MAIN interceptor and isolated collector with frozen permissions
ok - interceptor hooks fetch and posts extracted target tweets
ok - interceptor accepts URL and Request-like fetch inputs
ok - interceptor accepts every listed operation and ignores other URLs
ok - interceptor hooks XHR open/send for text and json responses
ok - interceptor ignores non-target, failed and malformed XHR responses
ok - interceptor never surfaces parser/JSON failures into page code
ok - interceptor installs only once
ok - interceptor buffers timeline batches until the collector is ready
ok - interceptor stamps the request-time route and operation
ok - content collector receives batches, dedupes and persists
ok - content collector restores an existing bucket on load
ok - content collector rejects wrong-origin, wrong-type, malformed and unbound messages
ok - content collector switches and restores per-user buckets on SPA navigation
ok - content collector uses /search?q=from:user and ignores /home
ok - content collector flushes on pagehide and clearCurrent empties the bucket
ok - content collector exposes getState/getUsername/subscribe/error API for S3
ok - content collector filters other authors from TweetDetail and Likes
ok - content collector catches up to pushState without waiting for the poll
ok - content collector merges records written by another tab
ok - content collector propagates chrome.runtime.lastError and retries quota failures
ok - content collector exposes storage read failures instead of treating them as empty
ok - content collector applies an empty cross-tab snapshot as a clear
ok - content collector treats a removed storage key as a clear
ok - a stale tab adopts a live tab clear and never resurrects the records
ok - a cross-tab clear invalidates an in-flight restore
ok - a tab that missed onChanged still refuses to resurrect on flush
ok - content collector fails closed when the service worker is unavailable
ok - content collector surfaces extension messaging failures as unavailable
ok - content collector never uses navigator.locks when the coordinator works
ok - content collector times out a hung commit instead of reporting success
ok - two origins share one coordinator and a held write is not overwritten
ok - early timeline batches are replayed when the collector loads later
ok - collector-first startup still receives a later interceptor batch
ok - a delayed Alice response after navigating to Bob stays in the Alice bucket
ok - a response right after pushState lands in the new bucket
PASS (74 test groups)
```

```text
$ node tests/panel.test.mjs
ok - panel mounts bottom-right with username, count, status and five controls
ok - panel is collapsible and restores its body
ok - panel follows content state updates and shows storage errors
ok - auto-scroll ticks every 1.8s and scrolls to the bottom
ok - auto-scroll slows after 6 stalled checks and stops after slow retries
ok - count growth resets the stall counter and resumes the fast interval
ok - auto-scroll stops when the profile changes
ok - start is refused on non-profile pages
ok - CSV download sorts ascending, keeps BOM and names the file
ok - JSON download writes the same ascending order and .json name
ok - empty export reports that there is nothing to download
ok - download failures are surfaced in the status line
ok - clear empties the current bucket immediately and reports success
ok - clear failure is surfaced without claiming success
ok - filename helpers handle @, invalid characters and unknown users
ok - sortRecordsAsc keeps records ordered by created_at_iso
ok - boot() mounts after DOMContentLoaded with the page APIs
ok - panel code is storage-free, XSS-free and CSS is scoped/above the page
PASS (18 test groups)
```

All three exited `0`. `node --check` passed for every `src/*.js` and
`tests/*.test.mjs`, and `manifest.json` parses as JSON. The tests are fully
synthetic (fake DOM, clock, fetch/XHR, storage, Blob/object URLs); they do not
contact X or any other server.

## Frozen-scope check

- `manifest.permissions` is still `["storage"]`; host permissions are still only
  `https://x.com/*` and `https://twitter.com/*`. There is no `tabs`, `webRequest`,
  `<all_urls>`, or new permission.
- No analytics, telemetry, remote config or API keys. The extension itself makes no
  network requests; the interceptor only reads X's own GraphQL responses.
- Collected data stays in `chrome.storage.local`: the snapshot is `xtce_<username>`,
  and while a commit is in flight a full copy of the next snapshot is also in
  `xtce:wal:<username>` until the commit removes it. Nothing leaves the browser; the
  panel talks only to the S2 content API and never calls storage directly.
- No build step and no dependencies were added.
- No push was performed.

## Files changed

```text
M  README.md
M  manifest.json
M  src/parser.js
M  tests/collector.test.mjs
M  tests/parser.test.mjs
A  popup.html
A  src/csv.js
A  src/panel.css
A  src/panel.js
A  tests/panel.test.mjs
A  reports/S3-report.md
```

The review follow-up commit changes only `README.md` and `reports/S3-report.md`;
no source, test, manifest or popup file changed.

## Decisions, uncertainties and known limits

- **Panel file split**: S2's README said S3 would live inside `content.js`. This slice
  puts the UI in `src/panel.js` (loaded immediately after `content.js` in the same
  ISOLATED world) so the S2 collector file stays reviewable and unchanged, while the
  panel is still a registered content script. It only consumes `__XTCE_content`.
- **Branch name**: the issue text asks for `feat/s3-ui`, but this Orca worktree branch
  is `norinori1/xtce-s3-new`. As with S2, the commit stays on the worktree branch for
  the orchestrator's review/push flow. Nothing was pushed.
- **Auto-scroll heuristic**: "with a slower retry" is implemented as 6 fast no-growth
  checks → 5 s interval → 3 more no-growth checks → stop. A growing count resets the
  counters. This deliberately conflates "end of timeline" and "rate limit", as the
  required status text says; it is a heuristic, not a proof of either.
- **Filename timezone**: `yyyy-mm-dd-hhmmss` uses the browser's local time, not UTC.
- **JSON shape**: the download is the sorted record array (same record shape as the
  CSV columns), not a wrapper object with metadata.
- **Profile switch mid-scroll**: auto-scroll stops rather than continuing to scroll
  the new profile; starting again is a deliberate action.
- **Real X is untested**: no browser/X session was available in this worker. The
  GraphQL payload assumptions are S1's; panel scrolling assumes X's main timeline
  uses window scrolling, and `documentElement/body.scrollHeight` is used as the bottom.
  If X changes its scroll container, manual scrolling still collects.
- **Storage quota and journal overhead**: `chrome.storage.local` has a roughly
  10 MB default quota. Every commit writes the complete next snapshot to
  `xtce:wal:<username>` before the snapshot, so the same data exists twice while
  committing and the effective capacity can be materially below 10 MB. Quota
  failures are surfaced in the panel (with `code` when present); S2 keeps the
  bucket dirty and retries instead of truncating or dropping silently.
- **Crash-recovery ordering assumption**: journal repair re-writes the snapshot
  and then removes the journal, relying on the `chrome.storage.local` backend
  applying operations in issue order. This is a single-writer + durable-journal +
  backend-ordering argument, not an unconditional guarantee; after the journal is
  removed, a late orphaned write would not be detectable. This limitation is
  unchanged from S2 and is now documented in the README again.
- **Synthetic-only durability and cross-tab evidence**: journal recovery,
  service-worker restart, two-tab merge, cross-origin serialization and clear
  propagation are covered only by fake storage/tabs/clocks in
  `tests/collector.test.mjs`. They are not verified in real Chrome; the owner's
  real-device check remains the gate.
- **Search date boundary**: X's `until:` is exclusive, so the README example uses
  `until:2021-01-01` to cover all of 2020 and says so explicitly. A literal
  `until:2020-12-31` would exclude Dec 31.
- **Panel CSS**: X can change its DOM/CSS, and the panel is intentionally a fixed
  overlay at maximum z-index. It is scoped to `#xtce-panel`, but a future X redesign
  may require visual tweaks.
- **Real-device check is the owner's next step**: load the unpacked extension, open a
  profile, start auto-scroll, confirm the count grows, download CSV/JSON, check Excel
  BOM behaviour, open the replies tab and a date-sliced search, then clear and reload
  to confirm the bucket does not come back. The check should also cover the
  synthetic-only paths: a service-worker restart mid-collection (journal recovery)
  and two tabs collecting/clearing the same user.

## What remains

- Orchestrator review of this branch (including this README/report follow-up); if it
  passes, push the branch, open a PR that closes #3, squash-merge it, then the owner
  performs the real-device check. That check should include service-worker
  restart/recovery and two-tab clear/merge, which are synthetic-only here. This
  worker did not push, open a PR, or claim that the extension works on real X.
