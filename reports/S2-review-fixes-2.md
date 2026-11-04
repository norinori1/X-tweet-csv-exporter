# S2 review fixes (2nd round) — 8d17d85

- Repo: norinori1/X-tweet-csv-exporter (this worktree).
- Branch: `norinori1/xtce-s2-new`.
- Base commit under review: `8d17d85` (`fix(s2): harden collector ordering, attribution and persistence`).
- Scope: the two change requests from the coordinator's re-review. No push, no PR.
- Tests remain fully synthetic (fake fetch/XHR, fake `chrome.storage.local`,
  fake timers, fake message bus, fake per-origin locks); no network and no real
  extension APIs are used.

## Review items and fixes

### 1. Cross-tab clears were not propagated and stale tabs resurrected records

**Problem.** `handleStorageChanged` in `src/content.js` returned early for an
empty `records` array, and `mergeExternal` in `src/store.js` could only add
records. Tab A's `clearCurrent()` wrote `{records: []}`, tab B ignored the
change, kept its old in-memory records, and a later ingest/flush wrote them
back. A missed `onChanged` event (frozen/suspended tab) had the same effect
through the merge re-read. An in-flight merge write could also overwrite the
clear payload.

**Fix.**

- Payload format is now version 2 with a monotonically increasing
  `clearEpoch`: `{version: 2, username, updatedAt, clearEpoch, records}`.
  Legacy payloads are epoch 0.
- `clearCurrent()` allocates `max(storedEpoch, knownEpoch) + 1` under the
  user lock and writes an empty body. A failed clear keeps `clearPending` and
  retries with a higher epoch; it can never fall back to a read-merge of the
  old body.
- `mergeExternal(username, value, options)` now accepts the full stored payload
  (not just the records array) and an explicit `{removed: true}` for a deleted
  key. A newer `clearEpoch` calls `adoptClear()`, which empties the in-memory
  bucket, cancels pending merge dirtiness, bumps the restore/revision versions,
  and preserves a local `clearPending`. An older epoch is ignored entirely.
- `content.js` no longer filters empty snapshots. It passes `change.newValue`
  whole, and treats `newValue === undefined`/`null` as a removed bucket.
  Writer-lease keys are excluded from the user-bucket path.
- The merge write re-reads the payload inside the lock. If the stored epoch is
  newer, it adopts the clear, keeps only the stored post-clear records, and
  returns without writing the stale bucket. If the stored epoch is older than
  the tab's known clear (a stale snapshot), it does not merge it back and
  rewrites the clear marker with the current bucket.
- In-flight write repair: the merge/clear task records the epoch it writes.
  If a newer clear is adopted while that write is in flight, the write's
  completion handler re-marks the bucket dirty and schedules a repair pass with
  the adopted epoch. A clear queued behind an in-flight merge is serialized by
  the per-user flush chain and always runs after it.
- `getState().error` / `getLastError()` now include `code` (used by S3 to tell
  coordination failures apart from quota failures).

**Semantics.** Clear wins over any batch that was in memory when the tab
observed the clear. The only records dropped beyond the cleared set are those
received in the tiny window between the clear commit and the tab processing
`onChanged`; this is the deliberate conservative trade-off that guarantees no
resurrection. It is documented in the README.

### 2. `navigator.locks` is origin-scoped, so x.com and twitter.com could overwrite each other

**Problem.** Web Locks are per page origin. x.com and twitter.com tabs share
`chrome.storage.local` but cannot see each other's `navigator.locks`. The old
`read-merge-write under a lock` claim only held for same-origin tabs; a
cross-origin pair could both read the same snapshot and write whole-snapshot
payloads, losing one side. The previous test used one shared fake lock for both
stores, which hid exactly this bug (the review explicitly forbids claiming
cross-tab safety from a shared fake lock alone).

**Fix.** The store now uses a **shared-storage writer lease** that does not
depend on Web Locks:

- The store is created with `origin` and `peerOrigins` (`src/content.js`
  passes `https://x.com` / `https://twitter.com`, the only manifest hosts).
- Before every user-snapshot write (merge or clear), under the same-origin
  lock, the store writes its own per-user lease
  `xtce_coord_<encoded-origin>_<user>` = `{origin, username, at, expiresAt,
  token}` and **then** reads the peer origin's lease key via
  `chrome.storage.local.get([...])`.
- If a live peer lease exists, the write fails closed with
  `XTCE_CROSS_ORIGIN_BUSY` (message names the peer origin). The user snapshot
  is not touched; the bucket stays dirty and is retried with backoff. The
  lease is released after the write, so the loser can merge later.
- Malformed or unreadable peer leases and a storage adapter without
  `getMany` / `remove` also fail closed (`XTCE_CROSS_ORIGIN_BUSY` /
  `XTCE_COORDINATION_UNAVAILABLE`); nothing is reported as success.
- Safety argument: every writer registers *before* it reads. If both origins
  proceeded, each would have read after its own registration but before the
  other's registration, which is a cycle that cannot happen in a sequentially
  consistent `chrome.storage.local` (the same backend serializes extension
  storage operations). If one origin reads late, it sees the other's live
  lease and refuses. A crashed writer leaves a lease that expires after 60 s,
  so the other origin recovers without a reload.
- Same-origin tabs continue to use `navigator.locks`, which is correct for
  one origin; cross-origin safety is provided by the lease, not by the lock.

**Regressions.** New tests use a lock manager that serializes only inside one
domain, so two origin critical sections genuinely overlap:

- `separate-origin lock domains overlap yet never overwrite each other` —
  holds A's user-snapshot write open, starts B, asserts the two domain locks
  overlapped (`maxActive >= 2`), asserts B rejected with
  `XTCE_CROSS_ORIGIN_BUSY` and never wrote the snapshot, then releases A and
  proves B's retry merges to `[1, 2, 3]`.
- `simultaneous cross-origin lease registrations let only one writer proceed`
  — defers A's lease registration; B registers, reads no A lease and starts its
  user write; A's late registration then observes B's lease and fails closed.
  Only B's snapshot lands.
- `a malformed peer lease fails closed without touching the snapshot` — a live,
  unreadable lease blocks the write; an expired lease is ignored and the retry
  succeeds.
- `a failed peer lease read fails closed and also succeeds on retry` — the
  registry read rejects; no snapshot write; the retry succeeds.
- `a storage adapter without shared-lease APIs fails closed` — no lease
  support means no write (not a silent best-effort).
- The existing same-origin `two stores on the same user merge interleaved
  writes` test still uses a shared lock and now only claims same-origin
  behaviour; the report does not derive cross-origin safety from it.

### Deterministic clear-interleaving regressions

Store level:

- `store applies an external clear snapshot instead of ignoring it`
- `store ignores a stale snapshot with an older clear epoch`
- `store removes a deleted storage key from memory without writing it back`
- `a stale tab re-reads the clear epoch and does not resurrect records`
  (simulates a missed `onChanged`)
- `a clear queued behind an in-flight merge write still wins` (deferred
  snapshot write)
- `a cross-tab clear observed during a clear write cannot be overwritten`
  (deferred clear write + newer epoch + repair pass)

Content level (two collector instances sharing storage and a change bus):

- `content collector applies an empty cross-tab snapshot as a clear`
- `content collector treats a removed storage key as a clear`
- `a stale tab adopts a live tab clear and never resurrects the records`
  (tab A clears, tab B's onChanged drops its memory, B's later ingest persists
  only the new tweet)
- `a cross-tab clear invalidates an in-flight restore` (deferred read returns
  the pre-clear body; the epoch adoption prevents it from being merged)
- `a tab that missed onChanged still refuses to resurrect on flush`
  (stale dirty batch, clear committed directly to storage)
- `content collector surfaces a peer-origin writer conflict` (S3-visible code
  and origin in `getLastError()`)

## Non-vacuous check against the reviewed commit

The new test file was copied into a temporary tree with `src/store.js` and
`src/content.js` from `8d17d85` and run there:

```text
FAIL (17 of 61 test groups failed)
```

Failures included `store applies an external clear snapshot ...`,
`a stale tab re-reads the clear epoch ...`, `separate-origin lock domains ...`,
`content collector applies an empty cross-tab snapshot ...`,
`a stale tab adopts a live tab clear ...`, `a cross-tab clear invalidates an
in-flight restore`, and `a tab that missed onChanged ...`. The temporary tree
was removed afterwards; the current tree is the fixed one.

## Test commands and results

```text
$ node tests/parser.test.mjs
ok - parser loads in vm and exposes the frozen API
...
ok - manifest keeps the frozen permissions and the S2 content-script wiring
PASS (9 test groups)

$ node tests/collector.test.mjs
ok - store loads in vm and exposes the S2 helpers
...
ok - a response right after pushState lands in the new bucket
PASS (61 test groups)
```

Both exited `0`. `node --check` was run on `src/store.js`,
`src/content.js` and `tests/collector.test.mjs`.

## Files changed

| File | Change |
| --- | --- |
| `src/store.js` | `clearEpoch` payload v2, `adoptClear`, payload-aware `mergeExternal`, removed-key handling, stale-snapshot refusal, in-flight epoch repair, cross-origin lease acquire/release, error `code`. |
| `src/content.js` | Shared-lease adapter (`getMany` / `remove`), `origin`/`peerOrigins`, empty-snapshot and removed-key clear propagation, lease-key filtering. |
| `tests/collector.test.mjs` | Deferred read snapshots at read time, keyed set/read hooks, per-domain lock manager, 17 new regression groups (61 total), auto `onChanged` bus for two-tab tests. |
| `README.md` | Payload v2, clearEpoch flow, lease flow, S3 error codes, updated limitations. |
| `reports/S2-review-fixes-2.md` | This report. |

## Remaining risks / decisions

- **Clear-wins window**: records received between a cross-tab clear commit and
  this tab processing it are discarded. This is intentional; no resurrection
  is preferred over at-least-once receipt in that sub-second window.
- **Same-origin without Web Locks**: same-origin tabs still rely on
  `navigator.locks`. If it is unavailable, read-merge-write remains
  best-effort (unchanged limitation, target Chrome MV3 has Web Locks).
  Cross-origin does not rely on it.
- **Lease consistency assumption**: the safety argument assumes
  `chrome.storage.local` read-after-write ordering inside the extension, which
  is how Chrome implements the shared storage backend. Lease keys are
  extension-private and the extension never uses `local.clear()`.
- **Lease TTL**: an abandoned lease blocks the other origin for up to 60 s
  (surfaced as an error, never an overwrite). Lease acquisition is inside the
  same-origin user lock, so same-origin tabs do not contend on it.
- **Lease storage overhead**: one extra key per writing origin/user, plus
  one `set`, one multi-get and one `remove` per write (writes are already
  throttled to ~500 ms).
- **No real-device verification**: still synthetic. Real GraphQL payload drift
  and X's actual routing remain owner-verification items.
- Nothing was pushed.
