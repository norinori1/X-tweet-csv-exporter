# X Tweet CSV Exporter (Local)

ある人物のXの公開ツイートを、完全ローカルでCSV/JSONにエクスポートするChrome拡張（個人用・無料・APIキー不要）。

**Status: S2 (collector)** — MV3 の雛形、GraphQL パーサー、MAIN world の fetch/XHR インターセプター、プロフィール単位の収集・保存まで実装済みです。1 回目のレビュー指摘（早期レスポンスの取りこぼし、レスポンスの帰属、復元と書込みの競合、複数タブ、quota エラー）、2 回目のレビュー指摘（クロスタブの clear 伝播・復活、x.com / twitter.com 間の書込み競合）、3 回目のレビュー指摘（ライターリースの TTL は fencing token にならないこと、in-flight `chrome.storage.set` を read-before-set で fence できないこと、`navigator.locks` 不在時の暗黙の直列化解除）も反映済みです。保存の read-modify-write は MV3 service worker の単一コーディネーターがユーザー単位のキューで直列化します。UI・CSV/JSON ダウンロードは S3 で追加します。

## 構成

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3。権限は `storage` と x.com / twitter.com のホスト権限のみ。MAIN / ISOLATED とも `document_start`。`src/background.js` を service worker として登録 |
| `src/parser.js` | X の GraphQL レスポンスから CSV レコードを作る純粋関数（DOM/通信なし） |
| `src/interceptor.js` | MAIN world。`fetch` / XHR をフックし、リクエスト時点のルートを付けて `XTCE_TWEETS` を postMessage。collector の READY までバッファ |
| `src/coordinator.js` | 保存の唯一の authority。ユーザー単位の promise キューで read-modify-write を直列化し、clearEpoch の判定、write-ahead journal（`xtce:wal:<user>`）による中断復旧、不正 payload の fail-closed 検証を行う。service worker とテストからのみ読み込む |
| `src/background.js` | MV3 service worker。`chrome.runtime.onMessage` で content script の `XTCE_COORDINATE` を受け、`src/coordinator.js` に渡す。commit が完了するまで応答せず、起動時に journal を修復する |
| `src/store.js` | 純粋なユーザー別ストア（id 重複排除、SPA 切替、500ms スロットル保存、復元の直列化、clearEpoch による clear 伝播、エラー保持・リトライ）。永続化は coordinator に委譲し、直接 storage を書かない |
| `src/content.js` | ISOLATED world。document_start で待受・READY ハンドシェイク、リクエスト時ルートへの帰属、author フィルタ、service worker への coordinator RPC（timeout / lastError を surface）、onChanged の clear 反映、S3 用 API |
| `tests/parser.test.mjs` | 合成フィクスチャによる Node テスト（S1） |
| `tests/collector.test.mjs` | fetch/XHR・store・content 配線・順序/帰属/永続化/clear 伝播/coordinator の直列化・journal 復旧・fail-closed の Node テスト（S2） |
| `reports/S1-report.md` / `reports/S2-report.md` / `reports/S2-review-fixes.md` / `reports/S2-review-fixes-2.md` / `reports/S2-review-fixes-3.md` | 各スライスとレビュー対応の作業レポート |

## 収集の仕組み

1. MAIN / ISOLATED とも `document_start` で起動します。MAIN world の `src/interceptor.js` が `fetch` と `XMLHttpRequest` をフックし、ISOLATED world の `src/content.js` はメッセージリスナーを設置して `XTCE_COLLECTOR_READY` を送ります。どちらの world が先に起動しても、interceptor は READY を受け取るまでバッチを保持して後から再生します（最大 50 バッチ）。
2. 対象は x.com 自身の `/i/api/graphql/`（または `/i/api/2/`）で、UserTweets など既定のタイムライン操作のみです。拡張自身はリクエストを作りません。レスポンスの JSON を `window.__XTCE_parse.extractFromGraphQL` に渡し、空でなければ `{type:"XTCE_TWEETS", tweets, source:{pathname, search, operation}}` を送ります。`source` はリクエスト開始時点のルートです。
3. collector は `source` からリクエスト時のバケットを決めます（`/alice` の first segment、または `/search?q=from:alice`）。遅れて届いた Alice のレスポンスが Bob のバケットに入ることはありません。pushState 直後でも、メッセージ受信時に現在のルートへ即座に追従するため、500ms ポーリングを待たずに新しいバケットへ入ります。
4. 保存するのは `author_username` がリクエスト時のバケットと一致するレコードだけです。TweetDetail の他人の返信や Likes の他人のツイートは、人物のエクスポートを汚さないよう破棄します。
5. 変更は MV3 service worker（`src/background.js`）に `XTCE_COORDINATE` として送り、`src/coordinator.js` が `chrome.storage.local` の `xtce_<username>` に約 500ms スロットルで保存します。content script は snapshot を直接書きません。coordinator はユーザー単位の promise キューを持ち、x.com / twitter.com / 全タブの read-modify-write を同じキューで直列化します（Chrome は extension ごとに service worker を 1 つ実行します）。`navigator.locks` は origin 単位で両ドメインを直列化できないため使用しません。queue は TTL で失効せず、先行する commit が完了するまで次の commit は storage を読みません。
6. 保存形式は `{version: 2, username, updatedAt, clearEpoch, records: [...]}` です。clear は `clearEpoch` を 1 つ進めて `records: []` を書きます。別タブは onChanged で空の snapshot を受け取っても無視せず、新しい epoch ならメモリを空にします。onChanged を取りこぼした stale タブでも、次の commit が coordinator 側で storage の epoch を読み直し、古い snapshot を書き戻しません。commit 中に新しい clear を観測した場合は、その commit の応答をメモリに merge せず、採用済みの状態で storage を修復します。キー削除（`chrome.storage.local.remove` / `clear`）も clear として扱います。
7. coordinator は commit の前に `xtce:wal:<username>` へ「次に書く完全な payload」を journal として書き、snapshot を書き、最後に journal を消します。service worker が eviction などで snapshot 書込み中に落ちても、次の worker が journal から snapshot を修復してからそのユーザーの要求を処理します。journal は TTL 付きリースではなく、最後に commit しようとした payload そのものです。service worker は commit が終わるまで `sendResponse` を呼ばず、`onMessage` から `true` を返して message channel を開いたままにします。worker が応答前に消えた場合、content script は `XTCE_COORDINATION_TIMEOUT` / `XTCE_COORDINATION_UNAVAILABLE` で失敗し、dirty のまま指数バックオフで再試行します（commit は id 和集合と clearEpoch により冪等）。
8. coordinator に到達できない、storage の payload / journal が読めない、要求が不正、という場合は **fail closed** です。snapshot を直接書く fallback も、`navigator.locks` だけに頼る fallback もありません。`chrome.runtime.lastError` は握りつぶさず reject に変換し、失敗したバケットは dirty のまま保持して指数バックオフで再試行し、`getState().error` / `getLastError()` で S3 に通知します。quota エラーは code なし、coordinator の失敗は `XTCE_COORDINATION_UNAVAILABLE` / `XTCE_COORDINATION_TIMEOUT`、不正データは `XTCE_STORAGE_CORRUPT` / `XTCE_WAL_CORRUPT`、不正要求は `XTCE_COORDINATION_PROTOCOL` です。

## S3 向け API

ISOLATED world の `globalThis.__XTCE_content` に以下を公開しています。S3 は同じ `src/content.js` に実装されるため、モジュール内から直接呼ぶこともできます。

- `getState()` — `{ username, count, records, error }`。`records` は追加順（CSV 化の際は `created_at_iso` 昇順にソートする）。`error` は `{message, operation, username, at, code}` または `null`
- `getUsername()` — 現在のバケット名（`getState()` より軽い）
- `subscribe(fn)` — 変更時に `fn(state)` を呼ぶ。戻り値は解除関数
- `clearCurrent()` — 現在のユーザーのメモリと保存バケットを空にする。coordinator / storage の失敗で reject
- `flush()` — 保留中の保存を即時実行する。coordinator / storage の失敗で reject
- `getLastError()` — 直近の storage エラー（なければ `null`）。`code` は `XTCE_COORDINATION_UNAVAILABLE` / `XTCE_COORDINATION_TIMEOUT` / `XTCE_STORAGE_CORRUPT` / `XTCE_WAL_CORRUPT` / `XTCE_COORDINATION_PROTOCOL` を取り得る。quota など storage 自体の失敗は code なし
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
- 保存の read-modify-write は MV3 service worker（`src/background.js` + `src/coordinator.js`）のユーザー単位キューだけで直列化します。`navigator.locks` は使いません。同一 origin の複数タブも x.com / twitter.com の混在も同じキューに入ります。service worker に到達できない、または応答が timeout した場合、そのタブは `XTCE_COORDINATION_UNAVAILABLE` / `XTCE_COORDINATION_TIMEOUT` を surface して fail closed し、snapshot を直接書きません。
- service worker は idle で eviction され得ます。キューはメモリ上にしかありませんが、eviction 時は commit が動いていないか、動いていたなら journal が残っています。新しい worker は `xtce:wal:<user>` から snapshot を修復してからそのユーザーの要求を処理します。journal は TTL 付きリースではなく「最後に commit しようとした完全な payload」で、失効しません。
- 修復の順序保証は、同一 extension の `chrome.storage.local` がある `set` を、それより後に発行された `set` より先に適用する（storage backend が操作を直列化する）という前提に依存します。この前提が破れると、eviction 前の in-flight `set` が修復後に着地し得ます。その場合でも journal が残っている間は read が journal を優先しますが、journal 削除後の巻き戻りまでは検出できません。これは TTL やリースではなく、単一 writer + durable journal + storage の操作順序による保証です。
- commit が中断されると、元のタブにはエラーが見えますが、journal が後から修復されて commit されることがあります。これはデータを失わないための意図的な挙動で、再試行は id 和集合と clearEpoch により冪等です。
- 1 回の commit はユーザーの全 in-memory snapshot を service worker に送り、`chrome.storage.local` に書きます。数千件規模では message / storage のサイズに注意が必要です。quota エラーは S3 に通知し、dirty のまま再試行しますが、空きができるまで storage には反映されません。
- clear は「clear を観測する前に受信したレコード」に対して優先します。clear コミット直後〜他タブが onChanged を処理するまでの極小ウィンドウで受信した新規レコードは、復活を防ぐため破棄されることがあります。
- 別タブの `clearCurrent` は、他タブの未保存レコードも含めて削除します（clearEpoch の伝播）。ただし上記ウィンドウのレコードは保存されない場合があります。
- interceptor のバッファは最大 50 バッチです。collector がまったく起動しない異常時は古いバッチから捨てます。
- 実際の GraphQL ペイロード形状は変更されうるため、実データでの確認は未実施です。
