# CLAUDE.md — kwnote (MEMORY SUPPORT SYSTEM)

間隔反復（spaced repetition）で「ぶんしょう（sentences）」と「一問一答（Q&A）」を復習する学習支援アプリ。
同じデータを **Web アプリ（PC / スマホ）** と **Rust 製 CLI/TUI（`kwnote`）** で扱い、QR・テキスト・ファイル・LAN で同期する。

## ファイル構成

| パス | 役割 |
|---|---|
| `index.htm` | Web アプリ本体（GitHub Pages / `file://` / `kwnote serve` から開く） |
| `script.js` | 画面・状態・キー操作（j/k/Shift+J/K/Enter/c）・登録/編集/削除・同期ボタンの配線 |
| `sync.js` | `KWSync`: マージ規則、同期コード（QR/テキスト）、LAN サーバー通信、QR 表示/読み取りダイアログ |
| `qr.js` | `KWQR`: 依存ゼロの QR エンコーダ（byte mode, v1–40, L/M/Q/H） |
| `style.css` | Windows XP 風スタイル（作者の意図。崩さない） |
| `sw.js` / `manifest.webmanifest` / `icon.svg` | PWA（https / localhost のときだけ SW 登録） |
| `Cargo.toml`（ルート） | Cargo workspace（members = `cli`）。`cross` は workspace ルートしか Docker にマウントしないため、`cli/` が埋め込む `../../index.htm` 等が見えるようルートを workspace にしている。`Cargo.lock`・`target/` もルート |
| `cli/` | Rust CLI。`model.rs`(データ・マージ・スケジュール) `store.rs`(保存) `codec.rs`(同期コード/QR) `server.rs`(LAN サーバー) `client.rs`(`kwnote sync`) `tui.rs`(vim 風 TUI) `update.rs`(自己アップデート) `main.rs`(サブコマンド)。`build.rs` が target triple を埋め込む |
| `cli/examples/qr_fixtures.rs` | `qr.js` 検証用の参照 QR 行列（Rust `qrcode` crate） |
| `tests/*.mjs` | Node 製の相互運用テスト（下記） |
| `.github/workflows/` | CI（`ci.yml`）とリリース（`release.yml`） |
| `install.sh` / `install.ps1` | `curl … \| sh` / `irm … \| iex` 用インストーラ（OS・CPU 判定 → 最新リリース取得 → SHA256 検証） |

Web 側は**ビルド工程なし・クラシック `<script>`**（ES modules は `file://` で動かないため使わない）。外部依存は、カメラ読み取りで `BarcodeDetector` が無い環境（iPhone Safari 等）だけ遅延ロードする jsQR（jsDelivr, SRI 固定）のみ。

## データモデル（Web と CLI で共通・最重要）

`{ version: 2, items: [...], sentences: [...], settings: { n: [1,3,7,14], order?, limit?, updatedAt } }`

- Web の保存先は localStorage の `srs_items` / `srs_sentences` / `srs_settings`（既存ユーザーのデータがあるのでキー名を変えない）。同期サーバー設定は `kw_sync`。
- CLI の保存先は `--data` → `$KWNOTE_DATA` → `<data dir>/kwnote/data.json`（macOS: `~/Library/Application Support/kwnote/`）。設定（remote・サーバーキー）は `--data` に関係なく `<data dir>/kwnote/config.json`。`KWNOTE_HOME` でディレクトリごと差し替え可（テストで使う）。
- item: `id, question, answer, note, registeredDate(YYYY-MM-DD), completedTurns[1..4], updatedAt(ms), deleted?`
  sentence: `id, text, registeredDate, completedTurns, updatedAt, deleted?`
- **スケジュール**: turn t の予定日 = `registeredDate + n[t-1]` 日（累積ではない）。最初の未完了 turn の予定日 ≤ 基準日なら「今日の分」。`dueTurn`(script.js) と `due_turn`(model.rs) は同じ意味を保つ。
- **settings**（`normSettings`/`PRESETS`/`ORDERS`(script.js) ⇔ `Settings`/`PRESETS`/`Order`(model.rs)）:
  - `n` の**個数 = 表示回数（turn 数）**。入力 UI は 1〜20（`MAX_TURNS`）。読み込みは何個でも可、空や壊れた値は既定 `[1,3,7,14]`、負数・数字以外は 0。`completedTurns` は 1〜255 を保持する（v1.0.2 までの CLI は 1〜4 以外を捨てるが、同値タイの和集合で戻る）。
  - `order`: `random`（既定）/`due`（予定日が古い順）/`oldest`/`newest`（登録日順）。`limit`: 今日のリストの各表の上限（0/なし = 無制限）。Rust では `extra` に入れたまま扱う（無いものを書き足さない＝JSON がそのまま往復する）。
  - 設定 UI はほかの項目を消さない（Web の `applySettings` は既存の settings に上書き）。
- **今日のリスト**（`buildToday`(script.js) ⇔ `build_today`(model.rs)）: 引き継ぐ行（carry）を先頭に、残りの今日の分を `order` で並べて `limit` まで足す。終えた行もその日のうちはリストに残り上限に数える。端末ごとに保存（Web: localStorage `kw_today`、TUI: `<home>/today.json`）し、同じ日・同じ設定なら起動時にそのまま復元、設定が変わったら「終えた行」だけ残して作り直す。同期では共有しない。
- **削除はトゥームストーン**（`deleted: true`）。レコードを配列から消すと同期で復活するので消さない。
- **変更時は必ず `updatedAt` を更新し、しかも直前の値より厳密に大きくする**（JS `nextStamp` / Rust `next_stamp`・`Record::touch`）。同一ミリ秒で同値になると下のタイ規則で `deleted` が OR され、「削除→元に戻す」が失われる（実際に起きたバグ）。
- 未知フィールドは保持する（Rust は `#[serde(flatten)] extra`）。旧データ（`updatedAt` なし・`note: null` 等）も読めること。

### マージ規則（`sync.js mergeDocs` ⇔ `model.rs merge_docs`、必ず両方同時に変更）

1. `id` で突き合わせ、`updatedAt` が大きい方を採用
2. 同値で内容が違う場合は `completedTurns` を和集合、`deleted` を OR（旧データ救済）
3. settings は `settings.updatedAt` が大きい方
4. 並び順は「手元の順 + 相手にしか無いものを末尾」

すべての取り込み（QR・テキスト・ファイル・LAN）はこのマージ。上書きは `kwnote import --replace` だけ（Web には上書き手段を置かない）。

## 同期方式

- **同期コード** (`codec.rs` ⇔ `KWSync.encodeFrames/decodeAny`):
  `payload = base64url('z' + zlib(JSON))`（`CompressionStream('deflate')` が無ければ `'j' + JSON`）。
  `frame = "KW1:<sid>:<i>:<n>:<chunk>"`（i は 1 始まり、sid は payload の FNV-1a 下位 24bit）。
  1 フレーム = 1 QR。複数フレームはアニメーション表示し、受信側は順不同で集める。改行で連結したものがテキスト版コード。
- **LAN**: `kwnote serve`（既定 `0.0.0.0:7878`）が Web アプリ一式を `include_str!` で埋め込んで配信し、API を提供:
  `GET /api/info`（認証なし）, `GET /api/data`, `POST /api/sync`（クライアント doc を受けてマージ・保存し、マージ結果を返す）。
  認証はペアリングキー（`X-Kwnote-Key` ヘッダ or `?key=`）。表示 URL の `#key=...` を Web アプリが拾って `kw_sync` に保存し URL から消す。CORS と `Access-Control-Allow-Private-Network` 付き。
  Web は変更 1.2 秒後・起動時・タブ復帰時に自動同期。応答待ちの間の編集は「応答をローカルにマージ」で守り、再同期する。
- **CLI 同士**: `kwnote sync http://<host>:7878 --key <key>`（URL とキーは config に記憶）。
- `store::commit` は「ディスクを読み直してマージしてから書く」ので TUI と `serve` の同時起動は安全。TUI は 1 秒ごとにファイル更新を検知して取り込む。

### ブラウザの制約（仕様として理解しておく）

- カメラ（SCAN QR）は secure context（https / localhost）のみ。`http://192.168.x.x` で開いたスマホでは使えない → その場合は LAN 同期そのものを使う。
- https のページ（GitHub Pages 等）から http の LAN サーバーへは mixed content で接続不可。LAN 同期はサーバーが配信するページで行う。
- localStorage はオリジン単位。GitHub Pages 版と LAN 版は別データになり、同期コード/QR/ファイルで橋渡しする。

## キー操作

- **Web はオリジナルの `j` / `k` / `Enter` / `c` に、表の切り替え `Shift+J`（もんだいへ）/ `Shift+K`（ぶんしょうへ）を足しただけ（+ `Esc` で入力欄から抜ける・ダイアログを閉じる）。モード表示・コマンド欄・Undo は無い。** 利用者は Vimium 等のブラウザ拡張を使うので、これ以上キーを増やさない（以前 vim 風キーを足して `x`・`t`・`u`・`d`・`/`・`?` などが Vimium と衝突した。`J`/`K` は Vimium のタブ移動と重なるが利用者の指定）。ほかの機能はボタンで提供する（今日⇄全部、全部表示の ✎/🗑 と絞り込み）。
- 選択（フォーカス）は両方の表にあり、`focusPane` 側に j/k/c/Enter が効く（見出しに ▶）。ぶんしょうの完了は `c`（スマホは Sure / 右スワイプ）。Shift 判定は `e.shiftKey` で行う（Caps Lock だけなら通常の j/k）。
- スマホの下部ボタンは ▲ ▼ ⇄ Show Sure の 5 つだけにする。
- 入力欄フォーカス中（チェックボックス等は除く）・IME 変換中（`isComposing`/keyCode 229）はキーを奪わない。フォームの Enter は「次の欄 / 最後の欄で登録」。
- **TUI（`cli/src/tui.rs`）は vim 風のまま**（端末なので Vimium と無関係）: `j/k`・回数・`gg/G`・`h/l` でペイン切替・`c`・`u`・`o`・`e`・`dd`・`/`・`t`・`:` コマンド・`?`。キー一覧は `HELP` 定数と README の「TUI のキー操作」を揃える。設定は `:set`（`n=` `nN=` `turns=` `preset=` `order=` `limit=`）。設定の項目を増やすときは Web の設定欄・`kwnote settings`・`:set`・README を揃える。

## 開発コマンド

```bash
cd cli && cargo build            # Web ファイルを埋め込むので、Web を変えたら serve 用に再ビルド
cd cli && cargo test             # model/codec/TUI（TestBackend で実キー操作→描画を検証。保存するテストは temp_data() で直列化）
cd cli && cargo clippy && cargo fmt
cd cli && cargo run -q --example qr_fixtures > /tmp/qr.json && node ../tests/qr_crosscheck.mjs /tmp/qr.json
node tests/sync_interop.mjs      # 要 target/debug/kwnote（ルートで cargo build）。JS⇔Rust の同期コード往復とマージ一致（乱数200件）
for f in script.js sync.js qr.js sw.js; do node --check $f; done
node tests/web_version.mjs --fix # Web ファイル（style.css/qr.js/sync.js/script.js）を変えたら必ず実行
```

## CI・リリース

- `.github/workflows/ci.yml`: push(master)/PR で Rust（ubuntu/macos/windows: fmt・clippy `-D warnings`・test）と Web（構文・manifest・QR 照合・JS⇔Rust 相互運用）。
- `.github/workflows/release.yml`: `v*` タグの push で、タグと `cli/Cargo.toml` の version 一致を確認 → CI → 26 ターゲットをビルド → `SHA256SUMS` を付けて GitHub Release を作成。
  - ネイティブ runner（cargo）: linux gnu x86_64/aarch64, macOS x86_64/aarch64, windows msvc x86_64/i686/aarch64。
  - `cross`（Docker）: linux musl/gnu の x86・ARM 各種・riscv64gc・powerpc64le・s390x・loongarch64、Android 3 種、FreeBSD/NetBSD/illumos、windows-gnu。Linux 系は `cross run`（QEMU）で `--version`・`add`・`list` のスモークテストまで行う。
  - 手動実行（workflow_dispatch, 入力 `tag`/`publish`）: 既存リリースに**足りないアセットだけ追加**し `SHA256SUMS` を作り直す。バイナリに入るもの（`cli/src`, `build.rs`, Web ファイル, Cargo.lock の内容）がタグと完全一致しないと失敗する。`publish` 無しならビルドだけのドライラン。
  - ターゲットを増やすときは release.yml の matrix、`install.sh`/`install.ps1` の判定、README の対応表を揃える。
- リリース手順: `cli/Cargo.toml` の version を上げる → `cargo build`（Cargo.lock 更新）→ commit → master に push → `git tag vX.Y.Z && git push origin vX.Y.Z`。
- `kwnote update`（`cli/src/update.rs`）はアセット名 `kwnote-<target triple>[.exe]` と `SHA256SUMS` に依存する。target triple は `build.rs` が `KWNOTE_TARGET` として埋め込む。アセット名・ターゲットを変えるときは両方を合わせる。リポジトリは `KWNOTE_UPDATE_REPO` で差し替え可（既定 `igarinpiano/kwnote`）。

## 開発上の注意

- **キャッシュ対策**: GitHub Pages は全ファイルを 10 分キャッシュするため、`index.htm` だけ新しく JS が古い、という混在が起きる（実際に「スマホで古い Done 列が出る・⇄ が効かない」として起きた）。対策は 3 つ: (1) `index.htm` は `style.css?v=<ハッシュ>` のように読み込み、ハッシュは `tests/web_version.mjs --fix` が中身から計算する（CI が古いと失敗させる）、(2) `sw.js` はネットワーク優先かつ毎回再検証（`cache: "no-cache"`）、(3) 新しい Service Worker に切り替わったらページを 1 回だけ自動リロード。`sw.js` の中身を変えたら `CACHE` 名も上げる。
- `qr.js` を触ったら `qr_crosscheck.mjs`（Rust `qrcode` crate と行列が完全一致するか、8 マスク総当たり）を必ず通す。
- マージ・フォーマットを触ったら `sync_interop.mjs` を通す。
- macOS: ビルド済みバイナリを `cp` で上書きすると署名キャッシュで SIGKILL されることがある（`rm` してからコピー）。

## 作風

- 既存コードは ES5 風（`var`, `function`, セミコロン, 2 スペース）。Web 側はこの書き方に合わせる。
- タイトルや表記（「ツステム」「Interaval」等）は作者の意図的な味なので直さない。XP 風 UI も維持。
- UI 文言は日本語主体＋英語併記。
