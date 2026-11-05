# S4 Report — Fix ISOLATED-world `csv.js` injection (Issue #7)

- Worker: dsh (DeepSeek V4.1 Flash), dispatched by the Orca coordinator.
- Repo: norinori1/X-tweet-csv-exporter (this worktree).
- Worktree/branch: `C:\Users\Takumi\orca\workspaces\X-tweet-csv-exporter\xtce-s4-csv-isolated`,
  branch `norinori1/xtce-s4-csv-isolated`.
- Issue: [#7 [S4] Panel never renders in real Chrome: csv.js is not injected into the ISOLATED world](https://github.com/norinori1/X-tweet-csv-exporter/issues/7).
- Base: `064c9c5` (`origin/main`, "S3: Add export panel and usage guide (#6)").
- PR: **not opened by this worker** — the orchestrator reviews independently and handles the PR/merge.

## Problem and root cause

S3 added `src/csv.js` to both content-script entries so the MAIN-world parser and the
ISOLATED-world panel share one CSV builder. That works in the unit-test harness (which
loads the file explicitly) but not in Chrome: the browser does not inject the same file
path into a second world. With

```json
MAIN:     ["src/csv.js", "src/parser.js", "src/interceptor.js"]
ISOLATED: ["src/csv.js", "src/store.js", "src/content.js", "src/panel.js"]
```

the ISOLATED context received only `store.js`, `content.js` and `panel.js` after a page
reload; `csv.js` was silently skipped, no error was thrown. Consequently
`globalThis.__XTCE_csv` was `undefined` in the ISOLATED world, `panel.js createPanel()`
returned `null`, and the panel never rendered on x.com. All 102 unit test groups passed
because the failure is only observable in a real browser.

Muse verified the root cause and the fix end-to-end in a real Chrome via CDP (Chrome for
Testing 157, fresh profile): with this fix the panel renders, shows idle status, and all
buttons are present.

## Changes

| File | Change |
| --- | --- |
| `src/csv-isolated.js` | New file, byte-identical copy of `src/csv.js` (2,809 bytes; copied with `Copy-Item`, content untouched, no line-ending normalization). |
| `manifest.json` | ISOLATED entry only: `"src/csv.js"` → `"src/csv-isolated.js"`. MAIN entry, matches, `css`, `run_at`, `world`, permissions, host permissions and version are unchanged. |
| `tests/parser.test.mjs` | `content_scripts[1].js` expectation updated to `['src/csv-isolated.js', 'src/store.js', 'src/content.js', 'src/panel.js']`. |
| `tests/collector.test.mjs` | Same manifest expectation updated, plus a regression assertion in the same manifest test: reads `src/csv-isolated.js` and asserts strict equality with the already-loaded `src/csv.js` source, with a comment explaining that Chrome does not inject the same file path into a second world, so the isolated copy must stay byte-identical. |
| `reports/S4-report.md` | This report. |

Diff summary (`git diff --stat`, plus the untracked new file):

```
 manifest.json            |  2 +-
 tests/collector.test.mjs | 14 +++++++++++++-
 tests/parser.test.mjs    |  2 +-
 3 files changed, 15 insertions(+), 3 deletions(-)
 src/csv-isolated.js      | new file, 2,809 bytes (byte-identical copy)
```

No changes to the content of `src/csv.js`, parser/interceptor/store/content/panel logic,
`popup.html`, `README.md`, dependencies, or the version number. The MAIN world still
loads the original `src/csv.js`.

## Tests (all run for S4)

| Command | Result |
| --- | --- |
| `node tests/parser.test.mjs` | **PASS (10 test groups)** — exit 0 |
| `node tests/collector.test.mjs` | **PASS (74 test groups)** — exit 0 |
| `node tests/panel.test.mjs` | **PASS (18 test groups)** — exit 0 |
| `cmp src/csv.js src/csv-isolated.js` (byte comparison) | **identical** — 2,809 bytes each, SHA-256 `D332E59A56D8539DAAB1750C6EFDD885BD7A9535680D6BDD13E6526B64C6BBB9` for both |

The collector manifest test now fails if the two copies drift, and the parser manifest
test fails if the ISOLATED entry ever points back at `src/csv.js`.

## Frozen-scope check

- Only the four files above (+ this report) differ from `064c9c5`.
- `git status` shows exactly: modified `manifest.json`, `tests/parser.test.mjs`,
  `tests/collector.test.mjs`; untracked `src/csv-isolated.js` and `reports/S4-report.md`.
- `src/csv.js` itself is untouched (identical blob at HEAD as at base).

## What remains

The orchestrator performs the independent review and opens/merges the PR. A real-browser
re-check against the pushed branch is the final gate; the synthetic suites cannot detect
cross-world injection behaviour.
