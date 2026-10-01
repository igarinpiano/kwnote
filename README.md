# kwnote — MEMORY SUPPORT SYSTEM

間隔反復で「ぶんしょう」と「一問一答」を覚えるための学習支援ツール。
Web アプリ（PC・スマホ）と、vim 風キー操作のターミナル版 `kwnote`（Rust）が同じデータを共有します。

## Web アプリ

`index.htm` をブラウザで開くだけ（GitHub Pages などに置けばスマホからも使え、ホーム画面に追加すればオフラインでも動きます）。

- 復習: `j`/`k` で移動、`Enter` で答え、`c` で OK、`u` で元に戻す。`?` でキー一覧
- スマホ: 下のボタン、または行を **右スワイプ = Sure / 左スワイプ = Show**。`⋯` から編集・削除・同期
- 登録・編集（`e`）・削除（`dd`）、検索（`/`）、全件表示（`t`）

## 同期（どれでも OK・すべてマージ）

| 方法 | 手順 |
|---|---|
| **QR** | 送る側で **SHOW QR**、受け取る側で **SCAN QR**。データが多いと QR が自動で切り替わるので、全部そろうまで映すだけ。反対向きにも一度やると両方が同じになります |
| **LAN** | PC で `kwnote serve` → 表示された QR をスマホのカメラで読むと、アプリがその PC から開いて自動同期。PC のブラウザは `http://localhost:7878` |
| **テキスト** | **COPY CODE** → メッセージ等で送る → 相手の Backup 欄に貼って **LOAD** |
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
kwnote code            # テキスト版同期コード（Web の LOAD に貼る）
kwnote import FILE     # JSON / 同期コードを取り込み（マージ）
kwnote export -o backup.json
kwnote settings 1 3 7 14                 # 復習間隔（日）
```

TUI の `:` コマンド: `:sync` `:qr` `:date 2026-10-01`（`+1` `-1` `today` も可）`:set n=1,3,7,14` `:all` `:today` `:stats` `:q`
