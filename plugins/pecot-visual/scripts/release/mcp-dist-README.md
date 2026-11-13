# @pecot/visual-mcp

pecot-v（pecot-visual）プラグインの MCP サーバを単体で配布したものです。プラグインを導入していない環境でも、
MCP クライアントに 1 エントリ登録するだけで pecot-visual のツールが使えます。

ツールが担うのは生成・変換の実行部です。
スライドや図をどう組み立てるか、どの品質基準で仕上げるかは、pecot-visual のスキル指示文が担います。
これらはレイアウト仕様とスタイルリファレンスにあたります。
そのため、ツールだけを登録してもスキルなしでは期待する成果物になりません。

## 前提

- Node.js 24 系は 24.22.1 以上、26 系は 26.12.1 以上（脆弱性の修正を含まないバージョンでは起動しない）
- Windows ネイティブ環境は対象外（Linux / macOS / WSL2 で使用する）
- 使用するスキルの指示文をエージェントに読み込ませること。対象は `pecotcraft/pecot` の
  `plugins/pecot-visual/skills/<スキル名>/` 配下の `SKILL.md` と `references/`
  （v-slidev / v-drawio / v-evidence）。読み込ませる手段は MCP クライアント側の機能
  （システムプロンプト等）に依る

## 登録

使用する MCP クライアントの設定に次の 1 エントリを追加します。

```json
{
  "mcpServers": {
    "pecot-visual": {
      "command": "npx",
      "args": ["-y", "--prefix=/", "@pecot/visual-mcp"]
    }
  }
}
```

`--prefix=/` は、pnpm の `devEngines` を宣言したリポジトリの中で起動しても止まらないようにするための指定です。
`--prefix` を付けないと、そのリポジトリを cwd にした npx が `EBADDEVENGINES` で止まります。
npm には devEngines の判定だけを外す公式の手段が無く、要望（npm/rfcs#830）は not_planned で閉じています。

パッケージは `--package=` ではなく、位置引数で渡してください。
`--package=` で渡すと、npm が `npm_config_package` をサーバの子プロセスに残します。
すると、テーマの依存の取得（pnpm と corepack のどちらも無いとき）が打つ npx が、これを読んで別のパッケージを実行します。

`--prefix=/` には次の副作用があります。

- 利用者のリポジトリの `.npmrc` を読まず、globalconfig も `/etc/npmrc` になる。registry・proxy・cafile は `~/.npmrc` に置く
- `npm_config_prefix=/` などの環境変数がサーバに引き継がれる。サーバの子で `npm i -g` を打つと `/lib/node_modules` を向く

`setup` は `npm install --prefix` で置き場を明示します。
テーマの依存の取得（pnpm）は、talk-dir を cwd か `--dir` で指します。どちらも、この副作用の影響を受けません。

この副作用を避けたいときは、先に `npm i -g @pecot/visual-mcp` で入れて、コマンドを直接登録します。

```json
{
  "mcpServers": {
    "pecot-visual": {
      "command": "pecot-visual-mcp"
    }
  }
}
```

依存の置き場を変えるときは、登録に `env` で `PLUGIN_DATA` を書きます（「初回の操作」を参照）。
`PLUGIN_DATA` はこの登録専用の置き場です。シェルで export すると、ほかのツールも同じ置き場を使ってしまうので避けてください。

```json
{
  "mcpServers": {
    "pecot-visual": {
      "command": "npx",
      "args": ["-y", "--prefix=/", "@pecot/visual-mcp"],
      "env": { "PLUGIN_DATA": "/home/<user>/pecot-visual-data" }
    }
  }
}
```

Windows の MCP クライアントから使う場合は WSL2 経由で起動します。

```json
{
  "mcpServers": {
    "pecot-visual": {
      "command": "wsl",
      "args": ["npx", "-y", "--prefix=/", "@pecot/visual-mcp"]
    }
  }
}
```

WSL 側に `PLUGIN_DATA` を渡すには、`env` を `args` に含めます。Windows 側の `env` は `WSLENV` に載せないと WSL へ渡りません。

```json
{
  "mcpServers": {
    "pecot-visual": {
      "command": "wsl",
      "args": ["env", "PLUGIN_DATA=/home/<user>/pecot-visual-data", "npx", "-y", "--prefix=/", "@pecot/visual-mcp"]
    }
  }
}
```

WSL 内の npx が非ログインシェルの PATH に無い場合は、次のように指定します。
`"args": ["-e", "bash", "-lc", "npx -y --prefix=/ @pecot/visual-mcp"]`

ツールのパス引数には `C:\...` と `\\wsl.localhost\<distro>\...` をそのまま渡せます。
変換の対象はツール引数のみです。spec ファイル等の中身に書かれたパスは変換しません。
応答の `artifacts` と `data` は、ドライブレター形式なら `/mnt/<drive>/...`、UNC 形式なら
WSL 内の絶対パス（例: `/home/alice/deck`）で返ります。
`/etc/wsl.conf` の `[automount] root` を既定から変えている場合は、その値を環境変数
`PECOTV_WSL_MOUNT_ROOT` に設定してください。

版を固定する場合はパッケージ名の後ろに `@<version>` を付けます（例: `@pecot/visual-mcp@1.2.3`）。

## 初回の操作

`setup` ツールを 1 回呼んでください。スライド変換・スクリーンショット系が使う重量依存
（Slidev / dom-to-pptx / Chromium、所要は約 80 秒）を取得します。取得結果は永続し、
サーバを再起動しても再実行は不要です。

依存は `$XDG_DATA_HOME/pecot/pecot-visual/mcp-dist/` に置きます。
`XDG_DATA_HOME` が無ければ、`~/.local/share/pecot/pecot-visual/mcp-dist/` に置きます。
登録の `env` に `PLUGIN_DATA` を書いたときは、そのディレクトリの `mcp-dist/` に置きます。
置き場を変えたあとは `setup` を呼び直してください。
既存デッキの `node_modules` のリンクは、`slide_sync` で張り直してください。

通信を復号するプロキシの配下で使うときは、プロキシの CA 証明書を、Node の環境変数 `NODE_EXTRA_CA_CERTS` に PEM ファイルのパスで渡してください。
pecot は証明書を同梱しません。登録の `env` に書けば、`setup` の取得と、テーマの依存の取得（pnpm）にも使われます。
WSL 経由で登録するときは、`PLUGIN_DATA` と同じく、`args` の `env` に WSL 側のパスで含めてください。

`setup` 未実行でも使えるツール: `drawio_create` / `evidence_create` / `slide_lint` / `slide_page` / `slide_theme`

`setup` 実行後に使えるツール: `slide_create` / `slide_sync` / `slide_convert` /
`slide_dev` / `drawio_export`

`drawio_create` は URL の生成だけなら `setup` は不要ですが、PNG 出力を指定する場合は
Chromium を使うため `setup` が必要です。

## ツール

| ツール | 用途 |
|---|---|
| `setup` | 永続依存（Slidev ランタイム・Chromium）の取得 |
| `slide_create` | Slidev プロジェクトの新規作成 |
| `slide_sync` | テーマを参照する talk-dir は、依存の版でテーマを取得して node_modules を張り直し、生成ファイル（vite.config.ts・start.mjs）を本体の今の内容にそろえる。旧形式の talk-dir は `theme` で指定したテーマを参照する形へ移す |
| `slide_lint` | Slidev ページの ESLint チェック |
| `slide_convert` | Slidev → PPTX 変換 |
| `slide_dev` | Slidev プレビュー（dev サーバ）の起動・停止と閲覧 URL の取得 |
| `slide_page` | 指定レイアウトのスケルトンページ生成とレイアウト仕様の取得 |
| `slide_theme` | talk-dir が参照するテーマの宣言（書体・文字サイズ・PPTX の書体とリンク色・lint の規則）とレイアウトの一覧の取得 |
| `drawio_create` | draw.io ダイアグラムの URL / PNG 生成 |
| `drawio_export` | draw.io ダイアグラムの画像書き出し（SVG と PDF） |
| `evidence_create` | スクリーンショットからエビデンス xlsx を生成 |

## 失敗したとき

`setup` が必要なツールを `setup` 前に呼ぶと、`setup` を案内する応答が返ります。`setup` を呼んでから再実行してください。

`EBADDEVENGINES` で止まるときは、登録の `args` に `--prefix=/` が付いているか確認してください。

## 版

npm の版は pecot-v（pecot-visual）プラグインの版と一致します。
