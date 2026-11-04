# X Tweet CSV Exporter (Local)

ある人物のXの公開ツイートを、完全ローカルでCSV/JSONにエクスポートするChrome拡張（個人用・無料・APIキー不要）。

**Status: S1 (parser only)** — 現時点では MV3 の雛形と GraphQL パーサー＋テストのみです。画面・収集処理・エクスポートは S2/S3 で追加します。

## 構成

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3。権限は `storage` と x.com / twitter.com のホスト権限のみ |
| `src/parser.js` | X の GraphQL レスポンスから CSV レコードを作る純粋関数（DOM/通信なし） |
| `tests/parser.test.mjs` | 合成フィクスチャによる Node テスト |
| `reports/S1-report.md` | S1 の作業レポート |

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
```

Node.js 18+ 想定（実行環境: v24.15.0）。依存パッケージのインストールは不要です。

## 既知の制限（S1 時点）

- 実機の X での動作確認は未実施（合成フィクスチャのみ）。
- UI・収集・エクスポートは未実装（S2/S3）。
- 実際の GraphQL ペイロードの細部は変更されうるため、S2 で実データ確認が必要。
