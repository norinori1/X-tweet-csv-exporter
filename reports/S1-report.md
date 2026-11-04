# S1 Report — Scaffold + GraphQL parser

- Worker: dsh (DeepSeek V4.1 Flash), dispatched by the Orca coordinator.
- Repo: norinori1/X-tweet-csv-exporter (this worktree, not the Documents clone).
- Worktree/branch: `C:\Users\Takumi\orca\workspaces\X-tweet-csv-exporter\xtce-s1-new`, branch `norinori1/xtce-s1-new`.
- Not pushed, no PR, no external requests.

## What was built

| File | Contents |
| --- | --- |
| `manifest.json` | MV3, name/version per task, `permissions: ["storage"]`, host permissions for `https://x.com/*` and `https://twitter.com/*` only. One `document_start` MAIN-world content script loading `src/parser.js` (permitted by the S1 task). No popup/UI yet. |
| `src/parser.js` | Dependency-free, DOM-free, network-free parser. Exposes `window.__XTCE_parse = { extractFromGraphQL, extractTweetResult, toCSV, CSV_COLUMNS }`; also assigns `globalThis.__XTCE_parse` so Node `vm` tests can load it. |
| `tests/parser.test.mjs` | Inline synthetic `UserTweets`-shaped fixture + 9 test groups. Exit 0 on success. |
| `README.md` | Title, one-line description, `Status: S1 (parser only)`, API/CSV notes, test command. |
| `reports/S1-report.md` | This report. |

## Parser behaviour

- `extractFromGraphQL(payload)` walks any GraphQL object/array and collects exact
  `tweet_results.result` nodes (including through `TimelineTimelineModule` items).
  The walk does not descend into a found `tweet_results`, so nested retweet/quoted
  originals are never emitted as records.
- `extractTweetResult(result)` unwraps `TweetWithVisibilityResults.tweet`, returns
  `null` for `TweetTombstone` (and unusable nodes), and maps a Tweet to the frozen
  CSV record shape.
- Long posts: `note_tweet.note_tweet_results.result.text` and its `entity_set`
  win over `legacy.full_text` / `legacy.entities`.
- Author: `core.user_results.result.legacy.screen_name` / `.name`, with a fallback
  to the newer `core.user_results.result.core` fields.
- Counts: `legacy.favorite_count` etc. to numbers; `view_count` from `views.count`.
- Media: photos use `media_url_https`; videos / animated GIFs use the highest-bitrate
  `video/mp4` variant. Types keep the payload's `photo` / `video` / `animated_gif`.
- CSV: frozen header order, UTF-8 BOM (U+FEFF), CRLF, RFC 4180 escaping (comma,
  double quote, CR, LF), lowercase `true`/`false` for booleans. A trailing CRLF is
  written after the last row. Multi-value columns are joined with a single space
  (hashtags, mentions, expanded URLs and media values cannot contain spaces).
- `source` is HTML-stripped to the app label (e.g. `Twitter for iPhone`).
- Dates are parsed manually from X's `Wed May 01 12:34:56 +0000 2024` form with
  timezone math, then emitted as ISO 8601 UTC; `Date` parsing is only a fallback.

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
ok - manifest stays inside the S1 frozen scope
PASS (9 test groups)
```

`$LASTEXITCODE` was `0`. The fixture covers: normal tweet with photo + video,
retweet (asserts nested id 9002 and quoted id 9003 are absent), long post
(note_tweet wins), visibility-wrapped tweet inside a timeline module, reply
fields, tombstone skipped, cursor ignored, and CSV BOM/header/escaping/booleans.

## Frozen-scope checks

- `permissions` is exactly `["storage"]`; `host_permissions` is exactly the two
  X/Twitter origins. No `tabs`, no `webRequest`, no `<all_urls>`.
- No network code, no telemetry, no API keys, no dependencies, no build step.
- CSV column order matches the brief exactly and is asserted by the test.
- Retweeted and quoted originals are not separate records (asserted).
- No storage APIs are touched in S1 (collected data will live in `chrome.storage.local` in S2).

## Decisions and uncertainties about X's payload shape

- **Multi-value delimiter**: the brief does not specify one. I used a single space
  because hashtags/mentions/URLs/media URLs cannot contain spaces; easy to switch
  to ` | ` or newline if the owner prefers.
- **`source`**: X stores an HTML anchor. I emit the visible app name rather than
  raw HTML. If exact payload fidelity is preferred, this is a one-line change.
- **Videos without MP4**: if a video has no `video/mp4` variant (only HLS), the
  fallback is `media_url_https` (a thumbnail). Real payloads normally include MP4.
- **note_tweet entity_set**: I assume `note_tweet.note_tweet_results.result.entity_set`;
  if a future payload omits it, hashtags/mentions/urls fall back to legacy entities
  and could be incomplete.
- **Author fallback**: `legacy` is used first as requested, but newer user results
  sometimes put `screen_name`/`name` under `core`; the fallback covers that.
- **GraphQL drift**: only a synthetic fixture was exercised by design. Real payload
  verification (and any operation-specific shapes) belongs to S2; X changes these
  schemas without notice.
- **Branch naming**: the issue text asks for `feat/s1-parser`, but this Orca worktree
  was already checked out on `norinori1/xtce-s1-new`; the commit is made there so the
  orchestrator's review/push flow stays on the worktree branch. No push was done.
- **S2 bridge**: the S1 parser is declared as a MAIN-world content script. The S2
  isolated-world content script cannot read `window.__XTCE_parse` directly and will
  need a bridge (postMessage/custom event) or its own copy; noted for S2 planning.
