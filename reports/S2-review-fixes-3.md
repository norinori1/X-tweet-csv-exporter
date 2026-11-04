# S2 review fixes (3rd round) — 58c8b76

- Repo: norinori1/X-tweet-csv-exporter (this worktree).
- Branch: `norinori1/xtce-s2-new`.
- Base commit under review: `58c8b76` (`fix(s2): propagate cross-tab clears and fence cross-origin writes`).
- Scope: the third review's three findings. No push, no PR.
- Tests remain fully synthetic (fake fetch/XHR, fake `chrome.storage.local`,
  fake timers, fake message bus, fake service-worker runtime); no network and
  no real extension APIs are used.

> `reports/S2-review-fixes-2.md` describes the now-removed writer-lease design.
> Its lease/TTL section is superseded by this report; the clearEpoch work it
> describes is retained.

## 1. Why the lease could not be fixed

The reviewed commit published a per-user lease in `chrome.storage.local` with
`expiresAt = now + 60 s`, then read the peer's lease, then read the snapshot,
then wrote it. That is not a fencing protocol:

- A writer can pause **after** registering the lease and **before** issuing
  `chrome.storage.local.set` (or while that set is in flight). The peer sees
  the lease expire, writes its own snapshot, and the first writer's late set
  then lands on top and overwrites it. The TTL only bounds how long the peer
  waits; it does not order the writes.
- `read-before-set` cannot fence a `chrome.storage.set` that the browser has
  already accepted. Re-reading the lease or the snapshot immediately before
  the set does not stop an older in-flight set from completing afterwards.
- The same-origin fallback in `withUserLock` was
  `Promise.resolve().then(task)` when `navigator.locks` was unavailable. That
  silently removed serialization while the store still reported success.
- `navigator.locks` is origin-scoped, so it can never serialize x.com against
  twitter.com in the first place.

A TTL is therefore not a fencing token, and this change does not claim it is.
The lease is removed entirely rather than tuned.

### Direct demonstration against 58c8b76

A temporary script loaded `git show 58c8b76:src/store.js` in a Node vm with a
controllable clock and a deferrable `set` gate. It ran three scenarios:

1. **Lease TTL:** A (x.com) acquires the lease and its snapshot set is held.
   The clock advances past the lease expiry. B (twitter.com) sees the expired
   lease, reads `[1]`, and writes `[1, 3]`. A's held set then lands and writes
   `[1, 2]`, so B's record 3 is gone.
2. **No-lock fallback:** two same-origin stores with no `withLock` option use
   the default no-op lock. A's snapshot set is held; B reads `[1]` and writes
   `[1, 3]`; A's late set writes `[1, 2]`. The same record loss occurs.
3. **No storage / no coordinator:** `flushNow()` resolves (silent success)
   instead of surfacing a coordination failure.

```text
lease-TTL scenario: after peer write = [1, 3], after late writer = [1, 2]
no-lock scenario: after peer write = [1, 3], after late writer = [1, 2]
no-storage/no-coordinator scenario: flush resolved
```

The new suite's corresponding tests assert the opposite: a write held past the
old TTL stays queued, the final snapshot is `[1, 2, 3]`, and an unavailable
coordinator rejects with `XTCE_COORDINATION_UNAVAILABLE` without writing.

## 2. Replacement: one MV3 service worker + per-user queue

### Ownership

- `src/background.js` is registered as the MV3 extension service worker
  (`manifest.background.service_worker`). It is the only context that writes
  user snapshots to `chrome.storage.local`.
- `src/coordinator.js` is the storage authority. It is loaded only in the
  service worker (and in the Node tests), never in a page content script.
- Content scripts (`src/content.js`) send `XTCE_COORDINATE` messages. The
  store (`src/store.js`) only decides *what* to ask for; it has no storage
  adapter and cannot write directly.

### Serialization

- The coordinator keeps one promise chain per username. Every ingest and clear
  is a complete read-modify-write inside that chain. A second commit for the
  same user does not even read storage until the first commit has settled.
- Both x.com and twitter.com tabs talk to the same service-worker context, so
  the queue is shared across both origins and every tab. There is no
  origin-scoped lock in the design. Chrome runs one service-worker instance
  per extension profile; the queue relies on that single-instance property,
  and the journal covers the restart boundary.
- There is no TTL. A held write blocks the user's queue for as long as it is
  in flight. A failed write releases the queue and the peer can proceed.
- Ingest semantics:
  - stored `clearEpoch > expectedEpoch`: the batch predates a clear this tab
    did not observe. Nothing is written; the coordinator returns the
    authoritative post-clear payload so the tab adopts the clear.
  - stored `clearEpoch < expectedEpoch`: the tab knows a newer clear; the
    stale stored records are dropped and the incoming post-clear records are
    written with the tab's epoch.
  - equal: union by tweet id; the tab's in-memory record wins for duplicates.
- Clear semantics: allocate `max(storedEpoch, expectedEpoch) + 1`, write an
  empty payload. Two clear requests during one in-flight clear each get their
  own pass and epoch.

### Service-worker lifecycle

- The `onMessage` listener returns `true` and calls `sendResponse` only after
  the commit (journal write, snapshot write, journal removal) settles. A write
  is never acknowledged before it is durable.
- The per-user queue is in-memory by design. Chrome may evict an idle worker;
  when it does, the queue is empty or the interrupted commit left a journal.
  A restarted worker rebuilds the queue and reads all state from storage.
- **Write-ahead journal.** Before every snapshot write the coordinator writes
  `xtce:wal:<user>` containing the complete next payload, then writes the
  snapshot, then removes the journal. If the worker is evicted between those
  steps, the next worker's `recoverAll()` (startup) or per-request `recover()`
  rewrites the snapshot from the journal before serving that user. The journal
  is not a lease and never expires; it is the last intended payload.
- If the worker cannot answer (eviction, port closed), the content script
  rejects with `XTCE_COORDINATION_UNAVAILABLE`; if it does not answer within
  15 s, it rejects with `XTCE_COORDINATION_TIMEOUT`. The store keeps the
  bucket dirty and retries with exponential backoff. Commits are idempotent
  (ingest is a union, clear allocates a fresh epoch).
- A commit interrupted and later repaired may be committed even though the
  original tab saw an error. This is intentional durability; the retry merges
  rather than overwriting.

### Fail closed

There is no direct-storage fallback and no lock-only fallback. The coordinator
rejects and writes nothing when:

- the service worker is unreachable or the message fails
  (`XTCE_COORDINATION_UNAVAILABLE`);
- the response does not arrive in time (`XTCE_COORDINATION_TIMEOUT`);
- the stored snapshot has no usable `records` array, an unsupported version,
  or a different username (`XTCE_STORAGE_CORRUPT`);
- the write-ahead journal is unreadable (`XTCE_WAL_CORRUPT`);
- the request is malformed (`XTCE_COORDINATION_PROTOCOL`);
- a legacy `withLock` / `origin` / `peerOrigins` / `coordinationTtl` option is
  passed to `createStore` (it throws instead of silently degrading).

`chrome.runtime.lastError` is converted to a rejection, never swallowed.

## 3. Changes by file

| File | Change |
| --- | --- |
| `src/coordinator.js` | New. Per-user promise queue, ingest/clear read-modify-write, clearEpoch rules, write-ahead journal, startup/per-request recovery, strict payload/journal/request validation, `read` prefers a journal, `recoverAll`, `waitForIdle`. |
| `src/background.js` | New. MV3 service worker: `importScripts('store.js', 'coordinator.js')`, `chrome.storage.local` promise adapter, startup recovery, `onMessage` validation (extension id / page origin), response only after commit, error serialization. |
| `src/store.js` | Persistence now goes through a `coordinator` with `read`/`commit`; removed the storage adapter, `withLock`, origin/peer lease code, `coordinationKey`/`COORDINATION_PREFIX`; added fail-closed read/commit validation, clear tokens for repeated clears, commit-response reconciliation with clearEpoch and restore versions; exports `WAL_PREFIX`, `COORDINATE_MESSAGE`, `PAYLOAD_VERSION`, `isValidRecord`, `recordId`. |
| `src/content.js` | Removed the direct `chrome.storage.local` adapter and all `navigator.locks` code. Added the `XTCE_COORDINATE` message client with timeout and `lastError` handling, result-shape validation, WAL-key filtering in `onChanged`, and fail-closed errors for S3. |
| `manifest.json` | Registers `src/background.js` as the classic service worker. |
| `tests/collector.test.mjs` | Coordinator/background harnesses, shared-backend two-tab tests, held-write-beyond-TTL test, unavailable/timeout/messaging tests, journal restart/recovery tests, malformed data tests, legacy-option test, repeated-clear test. 74 groups. |
| `tests/parser.test.mjs` | Manifest assertions for the service worker. 9 groups. |
| `README.md` | Service-worker coordinator, queue, journal, lifecycle, fail-closed, error codes; removed the lease/TTL claims and limitations. |
| `reports/S2-review-fixes-3.md` | This report. |

## 4. Deterministic regressions

The key new tests are:

- `a write held past the old 60 s lease TTL cannot be overtaken by the peer`:
  A's snapshot set is deferred, the fake clock advances by 120 s (past the
  removed 60 s TTL), B's flush is started, and the test asserts B is still
  pending, only one user snapshot set was issued, and the held write is still
  the only one. Releasing A yields `[1, 2, 3]`; no `xtce_coord_*` key exists.
- `serialization does not depend on navigator.locks or a shared page lock`:
  both store sandboxes have no `navigator` at all; two stores still merge to
  `[1, 2, 3]` through the shared coordinator.
- `two origins share one coordinator and a held write is not overwritten`:
  content-level x.com and twitter.com tabs share one coordinator; A's set is
  held, B waits, `navigator.locks` is never called, and the final stored and
  both in-memory states are `[1, 2, 3]`.
- `content collector fails closed when the service worker is unavailable`:
  no `sendMessage`, no direct storage write, `XTCE_COORDINATION_UNAVAILABLE`
  surfaced, no lock fallback.
- `content collector surfaces extension messaging failures as unavailable`:
  a `chrome.runtime.lastError` from a closed port is surfaced and no snapshot
  is written.
- `content collector times out a hung commit instead of reporting success`:
  the commit never settles; the 25 ms test timeout rejects with
  `XTCE_COORDINATION_TIMEOUT` and no snapshot is written.
- `content collector never uses navigator.locks when the coordinator works`.
- `a failed held write releases the queue and the peer merges on retry`.
- `an interrupted commit is repaired from the journal after a worker restart`:
  the first worker's snapshot set is held, a second worker starts, and its
  recovery rewrites the journal payload; the final snapshot contains both
  records and the journal is removed.
- `background service worker repairs a journal on startup`.
- `background service worker answers only after the coordinator commit`.
- `background service worker rejects messages from other extensions`.
- `a malformed write-ahead journal fails closed without touching the snapshot`.
- `a malformed stored snapshot is never treated as empty`.
- `the coordinator rejects malformed requests`.
- `a store without a coordinator fails closed and never writes`.
- `a store fails closed on a coordinator snapshot without records`.
- `a store rejects legacy lock/lease options instead of silently degrading`.
- `two clear requests during one clear write are both applied`.
- All previous clear-propagation, ordering, attribution and parser tests still
  pass.

## 5. Test commands and results

```text
$ node tests/parser.test.mjs
PASS (9 test groups)

$ node tests/collector.test.mjs
PASS (74 test groups)
```

`node --check` was run on `src/store.js`, `src/coordinator.js`,
`src/background.js`, `src/content.js` and `tests/collector.test.mjs`.
`git diff --check` is clean.

## 6. Remaining risks / decisions

- **Storage operation ordering assumption.** The journal repair assumes the
  extension's `chrome.storage.local` backend applies a `set` that was issued
  earlier before a `set` issued later. If that assumption were violated, an
  orphaned in-flight set could land after a repair. While the journal exists,
  reads prefer it; after the journal is removed, a late rollback would not be
  detectable. This is a single-writer + durable-journal + backend-ordering
  argument, not a TTL or a lease, and the report does not claim more.
- **Worker eviction mid-commit.** The client sees a messaging error or its
  timeout, keeps the bucket dirty and retries; the journal repairs the
  interrupted write. The queue itself is intentionally in-memory and rebuilt
  from storage on the next worker start.
- **Hung storage operation.** A storage call that never settles stalls that
  user's queue (fail closed); the client times out and retries. The queue only
  resumes if the call eventually settles or the worker is restarted.
- **Full snapshot per commit.** The content script sends the user's complete
  in-memory snapshot to the service worker. Very large profiles may hit
  message/storage limits; quota failures are surfaced and retried.
- **Clear-wins window.** Records received between a cross-tab clear commit and
  this tab processing it are discarded. This is intentional; no resurrection
  is preferred over at-least-once receipt in that sub-second window.
- **No real-device verification.** The GraphQL payload and X's routing still
  need owner verification on a real browser.
- Nothing was pushed.
