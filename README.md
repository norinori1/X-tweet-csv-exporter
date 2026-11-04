# X Tweet CSV Exporter (Local)

ある人物のXの公開ツイートを、完全ローカルでCSV/JSONにエクスポートするChrome拡張（個人用・無料・APIキー不要）。

**Status: S2 (collector)** — MV3 の雛形、GraphQL パーサー、MAIN world の fetch/XHR インターセプター、プロフィール単位の収集・保存まで実装済みです。レビュー指摘（早期レスポンスの取りこぼし、レスポンスの帰属、復元と書込みの競合、複数タブ、quota エラー）も反映済みです。UI・CSV/JSON ダウンロードは S3 で追加します。

## 構成

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3。権限は `storage` と x.com / twitter.com のホスト権限のみ。MAIN / ISOLATED とも `document_start` |
| `src/parser.js` | X の GraphQL レスポンスから CSV レコードを作る純粋関数（DOM/通信なし） |
| `src/interceptor.js` | MAIN world。`fetch` / XHR をフックし、リクエスト時点のルートを付けて `XTCE_TWEETS` を postMessage。collector の READY までバッファ |
| `src/store.js` | 純粋なユーザー別ストア（id 重複排除、SPA 切替、500ms スロットル保存、復元の直列化、read-merge-write、エラー保持・リトライ） |
| `src/content.js` | ISOLATED world。document_start で待受・READY ハンドシェイク、リクエスト時ルートへの帰属、author フィルタ、`chrome.storage.local` 永続化、S3 用 API |
| `tests/parser.test.mjs` | 合成フィクスチャによる Node テスト（S1） |
| `tests/collector.test.mjs` | fetch/XHR・ストア・content 配線・順序/帰属/永続化の Node テスト（S2） |
| `reports/S1-report.md` / `reports/S2-report.md` / `reports/S2-review-fixes.md` | 各スライスとレビュー対応の作業レポート |

## 収集の仕組み

1. MAIN / ISOLATED とも `document_start` で起動します。MAIN world の `src/interceptor.js` が `fetch` と `XMLHttpRequest` をフックし、ISOLATED world の `src/content.js` はメッセージリスナーを設置して `XTCE_COLLECTOR_READY` を送ります。どちらの world が先に起動しても、interceptor は READY を受け取るまでバッチを保持して後から再生します（最大 50 バッチ）。
2. 対象は x.com 自身の `/i/api/graphql/`（または `/i/api/2/`）で、UserTweets など既定のタイムライン操作のみです。拡張自身はリクエストを作りません。レスポンスの JSON を `window.__XTCE_parse.extractFromGraphQL` に渡し、空でなければ `{type:"XTCE_TWEETS", tweets, source:{pathname, search, operation}}` を送ります。`source` はリクエスト開始時点のルートです。
3. collector は `source` からリクエスト時のバケットを決めます（`/alice` の first segment、または `/search?q=from:alice`）。遅れて届いた Alice のレスポンスが Bob のバケットに入ることはありません。pushState 直後でも、メッセージ受信時に現在のルートへ即座に追従するため、500ms ポーリングを待たずに新しいバケットへ入ります。
4. 保存するのは `author_username` がリクエスト時のバケットと一致するレコードだけです。TweetDetail の他人の返信や Likes の他人のツイートは、人物のエクスポートを汚さないよう破棄します。
5. 変更は `chrome.storage.local` の `xtce_<username>` に約 500ms スロットルで保存します。初回ロード・SPA 遷移時に復元し、復元が終わるまで merge 書込みは行いません。書込みは毎回 storage を読み直して merge する read-merge-write で、`navigator.locks` があればユーザー単位で直列化します。別タブの書込みは `chrome.storage.onChanged` でもメモリに merge します。保存形式は `{version, username, updatedAt, records: [...]}` です。
6. `chrome.runtime.lastError` は握りつぶさず reject に変換します。失敗したバケットは dirty のまま保持して指数バックオフで再試行し、`getState().error` / `getLastError()` で S3 に通知します。

## S3 向け API

ISOLATED world の `globalThis.__XTCE_content` に以下を公開しています。S3 は同じ `src/content.js` に実装されるため、モジュール内から直接呼ぶこともできます。

- `getState()` — `{ username, count, records, error }`。`records` は追加順（CSV 化の際は `created_at_iso` 昇順にソートする）。`error` は `{message, operation, username, at}` または `null`
- `getUsername()` — 現在のバケット名（`getState()` より軽い）
- `subscribe(fn)` — 変更時に `fn(state)` を呼ぶ。戻り値は解除関数
- `clearCurrent()` — 現在のユーザーのメモリと保存バケットを空にする。storage 失敗時は reject
- `flush()` — 保留中の保存を即時実行する。storage 失敗時は reject
- `getLastError()` — 直近の storage エラー（なければ `null`）
- `clearError()` — 表示用のエラーを消す

S3 の UI は `document_start` で読み込まれるため、DOM の構築を待ってからパネルを描画してください（`DOMContentLoaded` 以降）。

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
- `author_username` がリクエスト時のバケットと一致しないレコードは破棄します。この保守的なフィルタにより、`TweetDetail` の他人の返信や `Likes` の他人のツイートは入りません（Likes は本人のツイートを Like した場合だけ残ります）。Likes を本人のエクスポートに含める仕様にする場合は、S3 で別バケットを定義してください。
- 複数タブの merge は `navigator.locks` がある Chrome で直列化されます。Web Locks が使えない環境では read-merge-write のみのベストエフォートです。また、別タブの `clearCurrent` は他タブの未保存レコードまで消すことは保証しません（merge 書込みの消失防止が対象）。
- interceptor のバッファは最大 50 バッチです。collector がまったく起動しない異常時は古いバッチから捨てます。
- `chrome.storage.local` の容量（既定 10MB 目安）を超える履歴は保存しきれない可能性があります。quota エラーは S3 に通知し、dirty のまま再試行しますが、空きができるまで storage には反映されません。
- 実際の GraphQL ペイロード形状は変更されうるため、実データでの確認は未実施です。
