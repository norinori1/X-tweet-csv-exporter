# X Tweet CSV Exporter (Local)

ある人物の X（Twitter）の公開ツイートを、**完全ローカル**で CSV / JSON にエクスポートする Chrome 拡張（Manifest V3）です。API キー不要、外部サーバーなし、アカウント登録なし。

**Status: S3（実装完了・実機確認待ち）** — パーサー、タイムライン収集、フローティングパネル、CSV / JSON ダウンロード、README まで実装済みです。自動テスト（S1 + S2 + S3）はすべて PASS。**実機の X での動作確認はまだ行っていません**（テストは合成フィクスチャのみ）。オーナーによる実機確認待ちです。

## できること

- プロフィールのタイムライン（ツイート / 返信 / メディア）と検索結果を、スクロールに追従して自動収集。
- 右下のパネルからワンクリックで CSV / JSON をダウンロード。
- CSV は Excel で文字化けしない **UTF-8 BOM 付き**、固定 27 列、`created_at_iso` 昇順。
- データは `chrome.storage.local` にだけ保存。外部への送信・解析・テレメトリーは一切ありません。

## インストール

1. Chrome で `chrome://extensions` を開きます。
2. 右上の「デベロッパーモード」をオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」を押し、このリポジトリのフォルダ（`manifest.json` がある階層）を選びます。
4. ツールバーの拡張アイコンをピン留めすると、使い方のポップアップを開けます。

x.com にログインした状態で使ってください。権限は `storage` と `https://x.com/*` / `https://twitter.com/*` のホスト権限だけです。

## 使い方

### 1. プロフィールのツイートを収集する

1. `https://x.com/<ユーザー名>` を開きます。
2. 右下のパネルに現在の `@ユーザー名` と取得件数が表示されます。
3. **「自動スクロール開始」** を押すと、約 1.8 秒ごとにページ最下部へスクロールし、X が追加読み込みしたツイートを取り込みます。
4. 取得件数が増えなくなったら **「停止」** を押します（自動でも止まります。下記）。
5. **「CSV ダウンロード」** または **「JSON ダウンロード」** を押します。

手動でスクロールしても収集されます。自動スクロール中に手動で動かしてもかまいません。

### 2. 返信も含める

プロフィールの「返信」タブ（`https://x.com/<ユーザー名>/with_replies`）を開いてから、同じ手順で収集します。返信タブで取得した分は同じユーザーのバケットにマージされます。

### 3. 古い投稿を深く掘る（検索ページ）

X のタイムラインは過去すべてを返すわけではありません。古い投稿は検索ページで期間を区切って収集します。

1. `https://x.com/search?q=from%3A<ユーザー名>%20since%3A2020-01-01%20until%3A2021-01-01&f=live` を開く（検索欄に `from:<ユーザー名> since:2020-01-01 until:2021-01-01` と入力して「最新」でも可）。`since:` はその日を含み、`until:` はその日を含みません。上の例は 2020-01-01〜2020-12-31 を対象にします。
2. 検索結果のページでもパネルは使えます。収集結果は `xtce_<ユーザー名>` バケットにマージされます。
3. 期間をずらして繰り返すと、タイムラインで取り切れなかった投稿を補えます。

### 4. パネルの操作

| ボタン | 動作 |
| --- | --- |
| 自動スクロール開始 | 約 1.8 秒間隔で最下部へスクロール。件数が 6 回連続で増えないと間隔を 5 秒に落として再試行し、さらに 3 回増えなければ「タイムラインの末尾、またはレート制限の可能性があります」と表示して停止します |
| 停止 | 自動スクロールを止めます（手動スクロールでの収集は継続） |
| CSV ダウンロード | `created_at_iso` 昇順の CSV を保存 |
| JSON ダウンロード | 同じ順序の JSON 配列を保存 |
| クリア | 現在のユーザーのメモリと `chrome.storage.local` のバケットを空にします（確認ダイアログなし。完了後に「クリアしました」と表示） |
| 折りたたみ（▾ / ▸） | パネルを畳んでページの表示を邪魔しないようにします |

パネルは右下の固定ボックスだけで、ページの他の場所のクリックを遮りません。プロフィール以外のページでは「自動スクロール開始」は無効になります。

## 出力ファイル

ファイル名は `tweets_<ユーザー名>_<yyyy-mm-dd-hhmmss>.csv` / `.json`（端末のローカル時刻）です。

### CSV

- UTF-8（BOM 付き）、CRLF、ヘッダー 1 行 + データ行。
- 列順は固定です（変更しません）。

```
id, created_at_iso, text, url, author_username, author_name,
like_count, retweet_count, reply_count, quote_count, bookmark_count,
view_count, hashtags, mentions, urls, media_urls, media_types,
is_reply, in_reply_to_status_id, in_reply_to_username,
is_retweet, retweeted_status_id, is_quote, quoted_status_id,
conversation_id, lang, source
```

- `created_at_iso` は UTC の ISO 8601。並び順はこの列の昇順です。
- 複数値（`hashtags` / `mentions` / `urls` / `media_urls` / `media_types`）は空白区切り。
- 真偽値は `true` / `false`。`source` は HTML タグを除いたアプリ名。
- カンマ・ダブルクォート・改行を含む値は RFC 4180 形式でクォートします。
- 長文は `note_tweet` の全文を優先します。リツイート / 引用元は別レコードにせず、`retweeted_status_id` / `quoted_status_id` だけを記録します。

### JSON

`created_at_iso` 昇順のレコード配列です（UTF-8、BOM なし、2 スペース整形）。

## データの保存場所とプライバシー

- 収集データのスナップショットは `chrome.storage.local` の `xtce_<ユーザー名>` キーに保存します（`{version, username, updatedAt, clearEpoch, records}`）。
- 書込みは write-ahead journal 方式です。commit 中は、次に書く完全なスナップショットの複製を `xtce:wal:<ユーザー名>` キーにも一時保存し、スナップショットの書込み後に journal を削除します。commit が中断した場合は、次回の service worker 起動時の修復まで journal が残ります。そのため commit 中は同じデータが 2 つのキーに存在し、`chrome.storage.local` の実効容量は約 10 MB を大きく下回ることがあります。
- 拡張は x.com 自身が行う GraphQL リクエストの**レスポンスを読むだけ**で、拡張から外部ネットワークへリクエストを送りません。解析・テレメトリー・リモート設定・API キーはありません。
- 保存の read-modify-write は MV3 の service worker（`src/background.js` + `src/coordinator.js`）がユーザー単位のキューで直列化する設計です。複数タブや x.com / twitter.com の混在でも同じキューを使う設計ですが、これは合成テスト（fake storage / fake tab）でのみ検証しており、実 Chrome の複数タブ同時操作では未検証です（オーナー実機確認待ち）。
- クリアは `clearEpoch` を進めて空のスナップショットを書く設計で、別タブの古いスナップショットが後から復活しないことを合成テストで確認しています。実 Chrome のタブ間タイミングでの clear 伝播は未検証です。
- service worker が commit 中に中断した場合、次回起動時に `xtce:wal:<ユーザー名>` からスナップショットを修復する設計です。この修復の順序は、`chrome.storage.local` のバックエンドが発行順に操作を適用するという前提に依存しており、無条件の保証ではありません。実 Chrome での worker eviction / 復旧も未検証です（合成テストのみ）。
- 失敗時は fail closed で、直接 storage に書くフォールバックはありません。
- 拡張を削除するか Chrome の拡張機能データを消すと、保存データも削除されます。

## 構成

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3。権限は `storage` と x.com / twitter.com のホスト権限のみ。MAIN / ISOLATED とも `document_start`。`src/background.js` を service worker、`popup.html` を action popup として登録 |
| `src/csv.js` | CSV の唯一の実装。固定列順・RFC 4180 エスケープ・UTF-8 BOM・CRLF。MAIN（parser）と ISOLATED（panel）の両方から使う |
| `src/parser.js` | X の GraphQL レスポンスから CSV レコードを作る純粋関数（DOM / 通信なし）。CSV 生成は `src/csv.js` に委譲 |
| `src/interceptor.js` | MAIN world。`fetch` / XHR をフックし、対象の GraphQL レスポンスを `XTCE_TWEETS` として ISOLATED world に postMessage。collector の READY までバッファ |
| `src/coordinator.js` | 保存の唯一の authority。ユーザー単位キュー、clearEpoch、write-ahead journal、fail-closed 検証 |
| `src/background.js` | MV3 service worker。content script からの `XTCE_COORDINATE` を coordinator に渡し、commit 完了まで応答を待つ |
| `src/store.js` | 純粋なユーザー別ストア（id 重複排除、SPA 切替、500 ms スロットル保存、復元、clear 伝播、エラー保持・リトライ） |
| `src/content.js` | ISOLATED world の collector。メッセージ受信、リクエスト時ルートへの帰属、author フィルタ、coordinator RPC、S3 向け `globalThis.__XTCE_content` API |
| `src/panel.js` | S3 のフローティングパネル。状態表示、自動スクロール（停止検出）、CSV / JSON ダウンロード、クリア |
| `src/panel.css` | パネルのダークテーマ。`#xtce-panel` 配下にスコープし、ページのクリックを遮らない |
| `popup.html` | 拡張アイコンの短い使い方（プロフィール → 開始 → ダウンロード、すべてローカル） |
| `tests/parser.test.mjs` | S1 のパーサー / CSV テスト（合成 GraphQL フィクスチャ） |
| `tests/collector.test.mjs` | S2 の interceptor / store / content / coordinator テスト（fake fetch / XHR / storage / clock） |
| `tests/panel.test.mjs` | S3 のパネル / 自動スクロール / ダウンロード / clear テスト（fake DOM / clock） |
| `reports/` | 各スライスとレビュー対応の作業レポート |

## テスト

Node.js 18+（実行環境: v24.15.0）。依存パッケージのインストールは不要です。

```sh
node tests/parser.test.mjs
node tests/collector.test.mjs
node tests/panel.test.mjs
```

すべて PASS で終了コード 0 です（S3 時点: 10 / 74 / 18 テストグループ）。テストはすべて合成データで、実機の X やネットワークにはアクセスしません。

## 既知の制限

- **「全件」は X のタイムラインが返す範囲**です。プロフィールのタイムラインは過去すべてを返さないため、古い投稿は検索の `from: since: until:` で期間を区切って補ってください（`until:` は排他的で、その日を含みません。終了日を含めたい場合は翌日を指定します）。
- 実機の X での動作確認は未実施です。合成フィクスチャと fake fetch / XHR / storage のみで検証しています。特に write-ahead journal による復旧、service worker の再起動、複数タブ間の直列化 / clear 伝播は合成テストだけであり、実 Chrome では未検証です（オーナー実機確認がゲート）。実データの GraphQL 形状は変更されうるため、パースできない場合は `src/parser.js` の更新が必要です。
- レート制限や X 側の応答停止で新しいツイートが返らなくなると、自動スクロールの停止検出（6 回 + 低速 3 回）が働いて止まります。これは「タイムラインの末尾」と「レート制限」を区別しません。時間を置いて再開してください。
- 保護アカウントは、ログイン中のオーナーが見られる範囲だけ収集できます。非公開の投稿は取得できません。
- プロフィール / 検索（`from:user`）以外のページ（home / explore / bookmarks など）では保存先ユーザーを決められないため、受信バッチは破棄されます。
- `author_username` がリクエスト時のバケットと一致しないレコードは破棄します（TweetDetail の他人の返信や、Likes の他人のツイートを混ぜないため）。
- 返信タブ / メディアタブで収集した内容は同じユーザーのバケットにマージされます。タイムラインで取得済みの投稿は id で重複排除されます。
- `chrome.storage.local` の quota は約 10 MB です。commit 中はスナップショットの完全な複製が write-ahead journal（`xtce:wal:<ユーザー名>`）にもう 1 つ存在するため、実効容量は 10 MB を大きく下回ることがあります。quota エラーはパネルのステータスに表示され、空きができるまで storage への反映を再試行します（メモリ上のデータは保持）。数千件規模では注意してください。
- クリアは現在のユーザーのバケットだけを対象にします。別タブの未保存レコードも clearEpoch で削除される設計ですが（合成テストで確認、実 Chrome のタブ間タイミングでは未検証）、clear 直後の極小ウィンドウで受信したレコードは復活防止のため保存されないことがあります。
- write-ahead journal の修復順序は、`chrome.storage.local` のバックエンドが発行順に操作を適用するという前提に依存しており、無条件の保証ではありません。
- パネルは `document_start` で読み込まれ、`DOMContentLoaded` 後に描画されます。X のページ構造や CSS が大きく変わると、パネルの見た目に影響する可能性があります。
- 自動スクロールはウィンドウスクロールを前提にしています。X がスクロールコンテナを変更した場合は、手動スクロールでの収集に切り替えてください。

## 開発メモ

- 追加の権限、ビルド工程、外部依存はありません。`manifest.json` を読み込むだけで動きます。
- S3 のパネルは S2 の `globalThis.__XTCE_content` API だけを使い、`chrome.storage.local` を直接読み書きしません。
- CSV の列順・エスケープ・BOM を変えるときは `src/csv.js` と `tests/parser.test.mjs` / `tests/panel.test.mjs` をセットで更新してください（parser と panel が同じ実装を共有しています）。
- 実機確認の観点: プロフィールで件数が増えるか、返信タブ・検索でも収集できるか、CSV が Excel で文字化けしないか、クリア後に再読込しても復活しないか、別タブと同時に使っても壊れないか。
