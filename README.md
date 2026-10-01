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

```bash
cd cli && cargo install --path .
```

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
