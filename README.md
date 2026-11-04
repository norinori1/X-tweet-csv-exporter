# X Tweet CSV Exporter (Local)

ある人物のXの公開ツイートを、完全ローカルでCSV/JSONにエクスポートするChrome拡張（個人用・無料・APIキー不要）。

**Status: S2 (collector)** — MV3 の雛形、GraphQL パーサー、MAIN world の fetch/XHR インターセプター、プロフィール単位の収集・保存まで実装済みです。UI・CSV/JSON ダウンロードは S3 で追加します。

## 構成

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3。権限は `storage` と x.com / twitter.com のホスト権限のみ |
| `src/parser.js` | X の GraphQL レスポンスから CSV レコードを作る純粋関数（DOM/通信なし） |
| `src/interceptor.js` | MAIN world。`fetch` / XHR をフックし、対象 GraphQL レスポンスを `XTCE_TWEETS` として postMessage |
| `src/store.js` | 純粋なユーザー別ストア（id 重複排除、SPA 切替、500ms スロットル保存、復元） |
| `src/content.js` | ISOLATED world。メッセージ受信、プロフィール判定、`chrome.storage.local` 永続化、S3 用 API |
| `tests/parser.test.mjs` | 合成フィクスチャによる Node テスト（S1） |
| `tests/collector.test.mjs` | fetch/XHR・ストア・content 配線の Node テスト（S2） |
| `reports/S1-report.md` / `reports/S2-report.md` | 各スライスの作業レポート |

## 収集の仕組み

1. `document_start` の MAIN world で `src/interceptor.js` が `fetch` と `XMLHttpRequest` をフックします。対象は x.com 自身の `/i/api/graphql/`（または `/i/api/2/`）で、UserTweets など既定のタイムライン操作のみです。拡張自身はリクエストを作りません。
2. レスポンスの JSON を `window.__XTCE_parse.extractFromGraphQL` に渡し、空でなければ `window.postMessage({type:"XTCE_TWEETS", tweets}, location.origin)` を送ります。
3. `document_idle` の ISOLATED world で `src/content.js` が同一 origin のメッセージだけを受け取り、現在のプロフィール（`/alice` の first segment、または `/search?q=from:alice`）の Map に id で重複排除しながら追加します。
4. 変更は `chrome.storage.local` の `xtce_<username>` に約 500ms スロットルで保存し、初回ロード・SPA 遷移時にそのユーザーのバケットを復元します。保存形式は `{version, username, updatedAt, records: [...]}` です。

## S3 向け API

ISOLATED world の `globalThis.__XTCE_content` に以下を公開しています。S3 は同じ `src/content.js` に実装されるため、モジュール内から直接呼ぶこともできます。

- `getState()` — `{ username, count, records }`。`records` は追加順（CSV 化の際は `created_at_iso` 昇順にソートする）
- `subscribe(fn)` — 変更時に `fn(state)` を呼ぶ。戻り値は解除関数
- `clearCurrent()` — 現在のユーザーのメモリと保存バケットを空にする
- `flush()` — 保留中の保存を即時実行する

## パーサー API

`window.__XTCE_parse`（MAIN world）に以下を公開します。Node の `vm` でも読み込めます。

- `extractFromGraphQL(payload)` — payload 内の全 `tweet_results.result` をレコード配列に変換
- `extractTweetResult(result)` — 1 件をレコードに変換（tombstone は `null`）
- `toCSV(records)` — UTF-8 BOM 付き CSV 文字列（ヘッダーは固定順、CRLF）
- `CSV_COLUMNS` — 固定カラム順の配列

### 変換メモ

- 長文は `note_tweet.note_tweet_results.result.text` とその `entity_set` を優先。
- リツイートは `is_retweet=true` と `retweeted_status_id` のみ。埋め込まれた元ツイートは別レコードにしません。
- 引用も同様に `quoted_status_id` のみで、引用元は別レコードにしません。
- メディアは写真 = `media_url_https`、動画/GIF = 最高ビットレートの `video/mp4`。
- 複数値（hashtags / mentions / urls / media_urls / media_types）は空白区切り。
- 真偽値は `true` / `false`。`source` は HTML タグを除いたアプリ名。
- `created_at_iso` は UTC の ISO 8601。

## テスト

```sh
node tests/parser.test.mjs
node tests/collector.test.mjs
```

Node.js 18+ 想定（実行環境: v24.15.0）。依存パッケージのインストールは不要です。

## 既知の制限（S2 時点）

- 実機の X での動作確認は未実施（合成フィクスチャと fake fetch/XHR のみ）。
- UI・CSV/JSON ダウンロードは未実装（S3）。
- プロフィール・検索（`from:user`）以外のページ（home / explore / bookmarks など）では保存先ユーザーを決められないため、受信したバッチは破棄します。
- 実際の GraphQL ペイロード形状は変更されうるため、実データでの確認は未実施です。
- `chrome.storage.local` の容量（既定 10MB 目安）を超える履歴は保存しきれない可能性があります。
