# S2 review fixes — d16483a

> Superseded on two points by `reports/S2-review-fixes-2.md` (base 8d17d85):
> cross-tab `clearCurrent` propagation is now implemented with `clearEpoch`
> (not left as a known limit), and x.com/twitter.com writers are coordinated
> through a shared-storage lease because Web Locks are origin-scoped.

- Repo: norinori1/X-tweet-csv-exporter (this worktree).
- Branch: `norinori1/xtce-s2-new`.
- Base commit under review: `d16483a` (`feat(s2): add GraphQL interceptor and per-user collector`).
- Scope: the five change requests from the coordinator's review. No push, no PR.
- Tests are still fully synthetic (fake fetch/XHR, fake `chrome.storage.local`,
  fake timers and a two-world message bus); no network and no real extension
  APIs are used.

## Review items and fixes

### 1. Early responses were lost between MAIN document_start and isolated document_idle

**Problem.** The interceptor starts at `document_start`, the collector at
`document_idle`. Any timeline response in that window was posted before the
collector's `message` listener existed and disappeared.

**Fix.**

- The ISOLATED content script now also runs at `document_start`.
- Startup is an explicit handshake, because the two worlds have no ordering
  guarantee:
  - the collector installs its listener, then posts `XTCE_COLLECTOR_READY`;
  - the interceptor installs its listener and posts
    `XTCE_INTERCEPTOR_HELLO` (plus a second hello on the next task);
  - the interceptor buffers `XTCE_TWEETS` batches until READY, then replays
    them in order (bounded to 50 batches).
- The collector also answers a HELLO with READY, so either load order works.

**Regression.** `tests/collector.test.mjs` now has a two-world harness where
the MAIN interceptor and ISOLATED collector share a fake `window.postMessage`
bus, `location` and storage:

- `early timeline batches are replayed when the collector loads later` — two
  fetches happen before the collector exists, then the collector loads and
  receives both batches in order;
- `collector-first startup still receives a later interceptor batch` — the
  opposite ordering;
- a unit-level `interceptor buffers timeline batches until the collector is
  ready` test covers the buffer itself.

### 2. Response attribution used the route at receipt / 500 ms polling

**Problem.** `content.js` resolved the bucket from the current route when the
message arrived. A delayed Alice response after navigating to Bob went into
Bob's bucket; a response immediately after `pushState` went into the previous
bucket because polling had not run yet. `TweetDetail` replies and `Likes`
records by other authors were also ingested into the profile bucket.

**Fix.**

- The interceptor stamps every batch with the request-time route and operation:
  `source: { pathname, search, operation }`. `fetch` captures it when the
  wrapped fetch is called; XHR captures it in the wrapped `send`.
- The collector resolves the bucket from `source`, not from the live route.
  `ingestFor(user, records)` restores that user's bucket before mutating it, so
  a late response can safely go to a non-current bucket without overwriting
  stored records.
- The live route is still synced immediately on message receipt (not on the
  500 ms tick), so `getState()` reflects `pushState` right away.
- Batches without a valid `source` are rejected.
- Conservative author filter: only records whose `author_username` matches the
  request-time bucket are kept. `TweetDetail` replies by other people and
  other authors' `Likes` entries are dropped; a like of the user's own tweet
  remains.

**Regressions.**

- `interceptor stamps the request-time route and operation` (fetch and XHR,
  including a route change while the response is pending).
- `a delayed Alice response after navigating to Bob stays in the Alice bucket`
  (two-world, no polling tick, asserts Bob storage stays absent and live state
  switches to Bob).
- `a response right after pushState lands in the new bucket` (two-world, no
  polling tick, seeded Bob bucket).
- `content collector catches up to pushState without waiting for the poll`.
- `content collector filters other authors from TweetDetail and Likes` (mixed
  authors; also the `/search?q=from:alice` case).
- `content collector rejects wrong-origin, wrong-type, malformed and unbound
  messages`.

### 3. Restore was asynchronous but ingest/flush/clear could run before it settled

**Problem.** A flush could write a partial in-memory snapshot before the read
finished, deleting stored records. A clear followed by a delayed restore could
resurrect the old body.

**Fix.**

- Per-user mutation state:
  - `loaded` / in-flight `restorePromises` (restore-once);
  - `restoreVersions` invalidates a restore that started before a clear;
  - `revisions` detects new batches that arrive while a write is in flight;
  - `clearPending` keeps the clear intent across a failed empty write;
  - per-user `flushChains` serialize writes inside the tab.
- Merge writes always wait for restore, then re-read storage under the user
  lock and merge before writing. A failed read does not write anything; the
  bucket stays dirty and is retried.
- `clearCurrent` increments the restore version, marks the bucket loaded and
  cleared, then writes an empty payload. An in-flight restore that resolves
  later sees the version mismatch and does not merge. A failed clear remains
  `clearPending` and is retried as an empty write, so a retry cannot merge the
  old body back.
- `ingestFor` captures the clear version before waiting for the restore and
  drops a batch that was received for a pre-clear context.

**Regressions (deferred-read tests).**

- `store waits for an in-flight restore before writing a merge` — no `set`
  before the deferred `get` resolves; final storage has both records.
- `store does not write a partial snapshot when the read fails and retries` —
  the deferred read rejects, no write happens, the error is exposed, and the
  retry writes the union.
- `store clearCurrent is not undone by a delayed restore`.
- `store retries a failed clear without resurrecting records`.

### 4. Two tabs on the same user overwrote whole snapshots

**Problem.** Each tab wrote its own in-memory snapshot, so the last writer
deleted the other tab's tweets.

**Fix.**

- Merge-on-write: every merge write re-reads the latest stored snapshot under
  a per-user lock and merges missing ids before writing. In Chrome the lock is
  `navigator.locks.request('xtce_lock_<user>', ...)`; Web Locks are
  origin-scoped, so separate tabs serialize. If Web Locks is unavailable the
  store falls back to its in-process chain plus read-merge-write.
- `chrome.storage.onChanged` merges records written by another tab into the
  in-memory bucket and notifies S3, so the UI also sees the other tab's data.
- New batches that arrive while a write is in flight keep the bucket dirty and
  trigger another merge pass instead of being dropped.

**Regression.** `two stores on the same user merge interleaved writes` uses a
shared fake storage and a shared fake lock manager. It holds the first writer's
`set` open, starts the second writer, proves the second is blocked, releases
the first, and asserts the final snapshot is the union `[1,2]`. It then
interleaves another pair of writes and asserts `[1,2,3,4]`. The second store
also has the first store's record merged into its in-memory state.
`store merges records written by another tab without marking them dirty` and
`content collector merges records written by another tab` cover
`mergeExternal` / `chrome.storage.onChanged`.

### 5. The storage adapter swallowed chrome.runtime.lastError

**Problem.** `content.js` consumed `chrome.runtime.lastError` and resolved, so
quota failures looked successful. The store never kept a dirty retry and S3
had no way to display the failure.

**Fix.**

- `storage.get` / `storage.set` read `chrome.runtime.lastError` inside the
  callback and reject with an `Error`; synchronous throws are rejected too.
- Store failures keep the bucket dirty, record
  `{message, operation, username, at}`, notify subscribers and schedule an
  exponential-backoff retry (`persistDelay * 2^n`, capped at 30 s). Successful
  writes/restores clear the error.
- `getState()` includes `error`; `getLastError()` and `clearError()` are
  exposed on `__XTCE_content`. `flush()` and `clearCurrent()` reject on
  failure, while the `pagehide` listener catches its own rejection.

**Regressions.**

- `store propagates quota failures, keeps the bucket dirty and retries`.
- `store retries a failed clear without resurrecting records`.
- `content collector propagates chrome.runtime.lastError and retries quota
  failures` (the fake Chrome sets `lastError` only during the callback).
- `content collector exposes storage read failures instead of treating them
  as empty`.

## Files changed

| File | Change |
| --- | --- |
| `manifest.json` | ISOLATED collector moved from `document_idle` to `document_start`. |
| `src/interceptor.js` | Request-time `source` stamp, READY/HELLO handshake, bounded pending buffer, XHR handler cleanup on reuse. |
| `src/content.js` | Immediate listener + READY, route-bound ingestion, conservative author filter, `ingestFor`, live-route catch-up, `navigator.locks`, `chrome.storage.onChanged`, lastError propagation, error API. |
| `src/store.js` | Restore/mutation serialization, clear versioning, merge-on-write under lock, dirty retry with backoff, error state, `ingestFor` / `mergeExternal` / `getUsername` / `getLastError` / `clearError`. |
| `tests/collector.test.mjs` | Two-world ordering harness, deferred-read tests, interleaved-write test, quota/read-failure tests, author/attribution tests; 44 groups. |
| `tests/parser.test.mjs` | Manifest assertion follows the collector to `document_start`. |
| `README.md` | Flow, S3 API, error handling and known limits updated. |
| `reports/S2-review-fixes.md` | This report. |

## Test commands and results

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
ok - store waits for an in-flight restore before writing a merge
ok - store does not write a partial snapshot when the read fails and retries
ok - store clearCurrent is not undone by a delayed restore
ok - store retries a failed clear without resurrecting records
ok - store propagates quota failures, keeps the bucket dirty and retries
ok - two stores on the same user merge interleaved writes
ok - store merges records written by another tab without marking them dirty
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
ok - early timeline batches are replayed when the collector loads later
ok - collector-first startup still receives a later interceptor batch
ok - a delayed Alice response after navigating to Bob stays in the Alice bucket
ok - a response right after pushState lands in the new bucket
PASS (44 test groups)
```

Both exited `0`. `node --check` was also run on all changed JS files.

## Remaining risks / decisions

- **Conservative author filter**: a `Likes` batch on `/alice/likes` normally
  contains only other people's tweets and is therefore dropped. That is the
  deliberate "do not pollute a person export" choice; if likes need to be
  exported, S3 should define a separate bucket rather than mixing them into
  the profile's post export.
- **Cross-tab clear**: merge writes are coordinated, but a `clearCurrent` in
  one tab can be followed by another tab's still-in-memory merge write. That is
  a destructive-operation race, not a lost-tweet race; it is recorded as a
  known limit instead of adding a tombstone protocol to S2.
- **Web Locks fallback**: without `navigator.locks` the store still merges on
  write but simultaneous writers are best-effort. Target Chrome MV3 has Web
  Locks.
- **Buffer bound**: the interceptor keeps at most 50 batches while the
  collector is absent; this is an abnormal-case bound, not a normal path.
- **S3 UI timing**: because `content.js` now runs at `document_start`, S3 must
  wait for DOM construction (`DOMContentLoaded`) before drawing the panel.
- **No real-device verification**: still synthetic only. Real GraphQL payload
  drift and X's actual request routing remain owner-verification items.
- Nothing was pushed.
