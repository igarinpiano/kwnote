# kwnote — MEMORY SUPPORT SYSTEM

間隔反復で「ぶんしょう」と「一問一答」を覚えるための学習支援ツール。
Web アプリ（PC・スマホ）と、vim 風キー操作のターミナル版 `kwnote`（Rust）が同じデータを共有します。

## Web アプリ

`index.htm` をブラウザで開くだけ（GitHub Pages などに置けばスマホからも使え、ホーム画面に追加すればオフラインでも動きます）。

- PC のキー操作: `j`/`k` で選択移動、`Shift+J` でもんだい・`Shift+K` でぶんしょうに切り替え（▶ が付いている方が操作対象）、`Enter` で答えの表示、`c` で OK（もう一度押すと取消）。入力欄にカーソルがあるときは無効
- ぶんしょうも、選んで `c`（スマホは Sure）で OK にするとターンが進みます
- **今日 → 全部** で全件表示に切り替え。各行の **✎** で編集、**🗑** で削除、検索欄で絞り込み
- スマホ: 下のボタン（▲ ▼ ⇄ Show Sure。⇄ でぶんしょう／もんだい切替）、または行を **右スワイプ = Sure / 左スワイプ = Show**
- Vimium を使っている場合: `Shift+J` / `Shift+K` は Vimium の「前／次のタブ」と重なるので、このページでは Vimium を無効にするか、除外キーに `J K` を追加してください

## 同期（どれでも OK・すべてマージ）

| 方法 | 手順 |
|---|---|
| **QR** | 送る側で **SHOW QR**、受け取る側で **SCAN QR**。データが多いと QR が自動で切り替わるので、全部そろうまで映すだけ。反対向きにも一度やると両方が同じになります |
| **LAN** | PC で `kwnote serve` → 表示された QR をスマホのカメラで読むと、アプリがその PC から開いて自動同期。PC のブラウザは `http://localhost:7878` |
| **テキスト** | **COPY CODE** → メッセージ等で送る → 相手の **PASTE CODE** に貼って LOAD |
| **ファイル** | **SAVE FILE** / **SHARE**（AirDrop 等）→ 相手で **OPEN FILE** |
| **CLI 同士** | `kwnote sync http://<PC の IP>:7878 --key <キー>` |

新しく更新された方が勝ち、削除も伝わります。

## CLI / TUI（Rust）

### インストール

**macOS / Linux / BSD / Android (Termux)**

```sh
curl -fsSL https://raw.githubusercontent.com/igarinpiano/kwnote/master/install.sh | sh
```

（`| bash` でも可。`wget -qO- … | sh` でも動きます）

**Windows（PowerShell）**

```powershell
irm https://raw.githubusercontent.com/igarinpiano/kwnote/master/install.ps1 | iex
```

OS と CPU を自動判定し、最新リリースからバイナリを取得して `SHA256SUMS` で検証してからインストールします。
既定の置き場所は `~/.local/bin`（Termux は `$PREFIX/bin`、Windows は `%LOCALAPPDATA%\Programs\kwnote`。Windows ではユーザー PATH に自動追加）。

| 環境変数 | 意味 |
|---|---|
| `KWNOTE_VERSION=v1.0.0` | バージョンを指定（既定は最新） |
| `KWNOTE_INSTALL_DIR=/usr/local/bin` | インストール先（書き込めない場所なら `sudo` を付けて実行） |
| `KWNOTE_TARGET=…` | 自動判定の代わりにターゲットを指定（`install.sh` のみ） |

**アップデート**: `kwnote update`（`--check` で確認だけ、`--tag v1.0.0` で特定バージョン）。

### 対応プラットフォーム

| OS | CPU | アセット名 `kwnote-…` |
|---|---|---|
| macOS | Apple silicon / Intel | `aarch64-apple-darwin` / `x86_64-apple-darwin` |
| Linux（静的リンク・どのディストロでも可） | x86_64 / arm64 / x86 / ARMv7 / ARMv6 (Raspberry Pi) | `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl` / `i686-unknown-linux-musl` / `armv7-unknown-linux-musleabihf` / `arm-unknown-linux-musleabihf` |
| Linux（glibc） | 上記に加えて RISC-V / POWER (ppc64le) / IBM Z (s390x) / LoongArch | `x86_64-` `aarch64-` `i686-` `armv7-…-gnueabihf` `arm-…-gnueabihf` `riscv64gc-` `powerpc64le-` `s390x-` `loongarch64-` + `unknown-linux-gnu` |
| Android（Termux） | arm64 / ARMv7 / x86_64 | `aarch64-linux-android` / `armv7-linux-androideabi` / `x86_64-linux-android` |
| FreeBSD / NetBSD / illumos | x86_64 | `x86_64-unknown-freebsd` / `x86_64-unknown-netbsd` / `x86_64-unknown-illumos` |
| Windows | x64 / ARM64 / x86 | `x86_64-pc-windows-msvc` / `aarch64-pc-windows-msvc` / `i686-pc-windows-msvc`（MinGW 版 `x86_64-pc-windows-gnu` も） |

手動で入れる場合は [Releases](https://github.com/igarinpiano/kwnote/releases/latest) から該当ファイルをダウンロードし、`kwnote`（Windows は `kwnote.exe`）という名前で PATH に置きます。
macOS でブラウザからダウンロードした場合は「開発元を確認できません」と出るので、一度だけ `xattr -d com.apple.quarantine <ファイル>` を実行してください（インストールスクリプトや `kwnote update` では不要）。

一覧にない環境ではソースからビルドできます: `cargo install --git https://github.com/igarinpiano/kwnote.git kwnote`

### 使い方

```bash
kwnote                                   # 復習 TUI（vim 風: j/k, Enter, c, u, o, e, dd, /, :, ?）
kwnote add qa "apple" "りんご" -n fruit  # 一問一答を登録
kwnote add s "Practice makes perfect."   # ぶんしょうを登録
kwnote list            # 今日の分（--all で全件, --json）
kwnote stats           # 件数・明日の分など
kwnote serve           # LAN 同期サーバー（Web アプリも配信）
kwnote sync [URL]      # 別 PC の serve と同期
kwnote qr              # 同期用 QR をターミナルにアニメ表示（Web の SCAN QR で読む）
kwnote code            # テキスト版同期コード（Web の PASTE CODE に貼る）
kwnote import FILE     # JSON / 同期コードを取り込み（マージ）
kwnote export -o backup.json
kwnote settings 1 3 7 14                 # 復習間隔（日）
```

## コマンド・オプション一覧

`kwnote --help`、`kwnote <コマンド> --help` でも確認できます。

### 共通オプション（どのコマンドにも付けられる）

| オプション | 説明 |
|---|---|
| `--data <FILE>` | 使うデータファイル。試しに使うときや複数のデータを使い分けるときに。既定は `$KWNOTE_DATA`、それも無ければ OS のデータフォルダの `kwnote/data.json`（macOS: `~/Library/Application Support/kwnote/data.json`、Linux: `~/.local/share/kwnote/data.json`、Windows: `%APPDATA%\kwnote\data.json`）。場所は `kwnote path` で確認 |
| `--date <DATE>` | 基準日。`2026-10-01` のような日付、`today`、`+N`（N 日後）、`-N`（N 日前）。復習・`list`・`stats` では「その日に何が出題されるか」、`add` では**登録日**になる |
| `-h`, `--help` | ヘルプを表示 |
| `-V`, `--version` | バージョンを表示 |

### `kwnote` / `kwnote review` — 復習画面（TUI）

引数なしで起動すると今日の分の復習画面が開きます。`--date +1` で明日の分を先取りできます。キー操作は[下の表](#tui-のキー操作)を参照。

### `kwnote add` — 登録

| 形 | 説明 |
|---|---|
| `kwnote add qa <QUESTION> <ANSWER>` | 一問一答を登録（`qa` は `q` と略せる） |
| `-n`, `--note <NOTE>` | 補足（Supplement）。省略時は空 |
| `kwnote add sentence <TEXT>` | ぶんしょうを登録（`sentence` は `s` と略せる） |

```bash
kwnote add q "apple" "りんご" -n "fruit"
kwnote --date -3 add s "Practice makes perfect."   # 3 日前に登録した扱いにする
```

空白を含む文は `"…"` で囲みます。

### `kwnote list` — 一覧表示

| オプション | 説明 |
|---|---|
| （なし） | 基準日に出題されるものだけを `[T<ターン> <予定日>] 問題 → 答え (補足)` の形で表示 |
| `-a`, `--all` | 削除済み以外のすべてを表示（全ターン完了したものは `done`） |
| `--json` | JSON で出力（id・ターン・予定日つき。スクリプト向け） |

### `kwnote stats` — 統計

件数、基準日の分、明日の分、全ターン完了の数、復習間隔を表示します。オプションは共通のものだけです。

### `kwnote settings [N1 N2 N3 N4]` — 復習間隔

引数なしで現在の設定を表示します。4 つの数を渡すと「登録日から何日後に 1〜4 回目を復習するか」を設定します（既定 `1 3 7 14`。必ず 4 つ、0 以上）。設定も同期されます。

```bash
kwnote settings 1 3 7 14
```

### `kwnote export` — 書き出し

| オプション | 説明 |
|---|---|
| （なし） | 全データを JSON で標準出力へ（Web の SAVE FILE と同じ形式） |
| `-o`, `--output <FILE>` | ファイルに書き出す |

### `kwnote import <FILE>` — 取り込み

`<FILE>` には JSON（Web の SAVE FILE）か同期コード（`KW1:…`、COPY CODE / `kwnote code`）を指定します。`-` を指定すると標準入力から読みます。

| オプション | 説明 |
|---|---|
| （なし） | 手元のデータと**マージ**（新しく更新された方が残り、削除も反映） |
| `--replace` | 手元のデータを捨てて**丸ごと置き換え** |

```bash
kwnote import backup.json
pbpaste | kwnote import -          # クリップボードの同期コードを取り込む（macOS）
```

### `kwnote code` — テキスト版の同期コード

全データを同期コード（`KW1:…` の行）で出力します。Web の PASTE CODE に貼って LOAD すると取り込めます。

| オプション | 説明 |
|---|---|
| `--chunk <N>` | 1 行（= QR 1 枚）あたりの文字数。既定 `360`。`--chunk 100000000` のように大きくすると 1 行にまとまる |

### `kwnote qr` — 同期用 QR をターミナルに表示

`kwnote code` と同じ内容を、切り替わる QR コードとして表示します。Web アプリの SCAN QR で読み取ります。

| オプション | 説明 |
|---|---|
| `--chunk <N>` | QR 1 枚あたりの文字数（既定 `360`）。ターミナルが狭くて QR が入らないときは `200` などに下げる（枚数は増える） |

表示中のキー: `Space` 一時停止 / `h` `l`（`←` `→`）前・次の QR / `+` 速く・`-` 遅く / `q` `Esc` 終了

### `kwnote serve` — LAN 同期サーバー

Web アプリを配信し、同期を受け付けます。起動すると URL と、それを開くための QR が表示されます。止めるのは `Ctrl-C`。

| オプション | 説明 |
|---|---|
| `-p`, `--port <PORT>` | 待ち受けるポート。既定 `7878` |
| `--bind <ADDR>` | 待ち受けるアドレス。既定 `0.0.0.0`（同じネットワークの全端末から）。`127.0.0.1` にするとこの PC からだけ |
| `--no-auth` | ペアリングキー無しで同期を許可（信頼できるネットワーク専用） |
| `--regen-key` | ペアリングキーを作り直す（以前つないだ端末は QR を読み直す必要あり） |
| `--no-qr` | URL の QR を表示しない |

ペアリングキーは初回に作られて設定ファイルに保存され、次回以降も同じものが使われます。

### `kwnote sync [URL]` — 別の PC と同期

別の PC で動いている `kwnote serve` と双方向に同期します。URL とキーは記憶されるので、2 回目からは `kwnote sync` だけで済みます。

| 引数・オプション | 説明 |
|---|---|
| `[URL]` | 相手の URL（例 `http://192.168.1.20:7878`）。`serve` が表示した `…/#key=…` をそのまま渡すとキーも読み取る |
| `--key <KEY>` | ペアリングキー（相手の `serve` の表示に出ている） |

### `kwnote update` — アップデート

GitHub の最新リリースを取得し、`SHA256SUMS` で検証してから自分自身を置き換えます。

| オプション | 説明 |
|---|---|
| （なし） | 新しいバージョンがあれば更新 |
| `--check` | 確認だけして、更新はしない |
| `--force` | 最新版でも入れ直す |
| `--tag <TAG>` | 指定したバージョンを入れる（例 `--tag v1.0.0`。古いバージョンにも戻せる） |

`/usr/local/bin` などに置いている場合は、書き込み権限が必要です（`sudo kwnote update`）。

### `kwnote path`

使っているデータファイルの場所を表示します。

### 環境変数

| 変数 | 説明 |
|---|---|
| `KWNOTE_DATA` | データファイルの場所（`--data` が優先） |
| `KWNOTE_HOME` | データと設定（同期先・ペアリングキー）を置くフォルダごと変更 |
| `KWNOTE_UPDATE_REPO` | `kwnote update` の取得元リポジトリ（既定 `igarinpiano/kwnote`） |
| `GITHUB_TOKEN` | `kwnote update` が GitHub API の回数制限に引っかかるときに設定 |

## TUI のキー操作

vim と同じ感覚で操作できます（ターミナル版のみ。Web 版は `j` `k` `Shift+J` `Shift+K` `Enter` `c` だけです）。数字を先に打つと回数指定になります（`5j` で 5 行下、`3G` で 3 行目）。

| キー | 動作 |
|---|---|
| `j` `k` / `↓` `↑` / `Ctrl-n` `Ctrl-p` | 下・上へ移動 |
| `gg` / `G`（`Home` / `End`） | 先頭・末尾へ |
| `Ctrl-d` / `Ctrl-u` | 半ページ下・上 |
| `Ctrl-f` / `Ctrl-b`（`PageDown` / `PageUp`） | 1 ページ下・上 |
| `h` `l` / `Tab` / `Ctrl-w w` | ぶんしょう ⇄ もんだい を切り替え（`←` でぶんしょう、`→` でもんだい） |
| `Enter` / `Space` / `za` | 答えを表示・隠す |
| `zR` / `zM` | すべて表示・すべて隠す |
| `c` | OK（このターンを完了。もう一度押すと取り消し） |
| `u` | 直前の変更（OK・編集・削除）を元に戻す |
| `o` `a` `i` | 新規登録（入力画面へ） |
| `e` | 選択中の項目を編集 |
| `dd` / `x` | 選択中の項目を削除（`y` で確定） |
| `/文字列` → `n` / `N` | 検索、次・前の一致へ |
| `t` | 表示切替: 今日の分 ⇄ 全部 |
| `r` | 今日の一覧をシャッフルし直す |
| `s` | 記憶している同期先と同期 |
| `?` / `F1` | ヘルプ |
| `q` / `Ctrl-c` | 終了（変更は毎回自動保存） |

**入力画面**: `Tab` `↓` `Ctrl-n` 次の欄 / `Shift-Tab` `↑` `Ctrl-p` 前の欄 / `Enter` 次の欄へ、最後の欄で保存 / `Esc` キャンセル。編集キーは `Ctrl-a` `Ctrl-e`（行頭・行末）、`Ctrl-b` `Ctrl-f`（左右）、`Ctrl-h` `Ctrl-d`（1 文字削除）、`Ctrl-u` `Ctrl-k`（行頭まで・行末まで削除）、`Ctrl-w`（1 語削除）。最後の欄は登録日で、`today` `+N` `-N` も使えます。

**`:` コマンド**（`Esc` でキャンセル）:

| コマンド | 動作 |
|---|---|
| `:q` `:q!` `:wq` `:x` | 終了 |
| `:w` | 保存（普段から自動保存されている） |
| `:e!` | データファイルを読み直す |
| `:sync [URL] [KEY]` | 同期（引数なしなら記憶している同期先） |
| `:date 2026-10-01` | 基準日を変更（`today` `+1` `-1` も可） |
| `:set` / `:set n=1,3,7,14` / `:set n2=4` | 復習間隔の表示・設定（全部、または 1 つだけ） |
| `:qr [N]` | 同期用 QR を表示（`N` は 1 枚あたりの文字数） |
| `:all` / `:today` | 両方の一覧を全部・今日の分に |
| `:stats` | 統計を表示 |
| `:help` | ヘルプ |
