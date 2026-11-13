---
paths:
  - "plugins/*/.claude-plugin/plugin.json"
  - "plugins/*/plugin.json"
  - "plugins/*/.github/plugin/plugin.json"
  - "plugins/*/.mcp.json"
  - "plugins/*/mcp.json"
  - "plugins/*/hooks/hooks*.json"
  - "plugins/*/com.github.copilot/**"
  - "plugins/*/bin/_lib.sh"
  - ".claude-plugin/marketplace.json"
  - ".github/plugin/marketplace.json"
  - "README.md"
  - "plugins/*/README.md"
  - "plugins/*/scripts/release/mcp-dist-README.md"
---

# manifest・データ置き場・名前・README を編集する前に

## manifest は 2 重に持つ

3 プラグインは、2 つのクライアントが別のファイルを読むため manifest を 2 組持ちます。

| クライアント | 読むファイル |
|:-----------|:----------|
| Claude Code | `.claude-plugin/plugin.json` と `.mcp.json`（`$schema` は無視する） |
| GitHub Copilot CLI | `$schema` が Agent Plugins 1.0.0 の、ルートの `plugin.json` と `mcp.json`（`.claude-plugin/` より優先する） |

- `name`・`version`・MCP サーバのキー・`command`・`args` を 2 組で一致させる。`version` はリリース時に nx が両方を書き換える
- `mcp.json` に `env` を書かない。置き場はクライアントが MCP へ渡す `PLUGIN_DATA`・`CLAUDE_PLUGIN_DATA` で決まる
- `.github/plugin/plugin.json` は持たない。Copilot CLI は 1.0 形式のプラグインでは読まない
- Copilot CLI の hooks は `com.github.copilot/hooks/hooks.json` に置く。エージェントは `com.github.copilot/agents`（`../agents` への相対 symlink）に置く
- リモートの MCP サーバの `type` は、`.mcp.json` が `"http"`、`mcp.json` が `"streamable-http"` にする。1.0 のスキーマは `http` を認めない。`url` は同値
- 一致は `plugins/{pecot-visual,pecot-tools}/cli/tests/bootstrap/manifest.sh` が確認する。pecot-workflow は `plugins/pecot-workflow/cli/tests/bootstrap/manifest.sh` が確認する

## データ置き場は 3 段で解決する

3 プラグインの `bin/_lib.sh` の data-dir ブロックは逐語一致です（`cli/tests/bootstrap/lib-consistency.sh` が確認）。
解決順は次のとおりです。

1. `CLAUDE_PLUGIN_DATA`
2. `PLUGIN_DATA`
3. `$XDG_DATA_HOME/pecot/<project 名>`（`XDG_DATA_HOME` が絶対パスでなければ `~/.local/share/pecot/<project 名>`）

- プラグイン別の変数（`PECOT_DATA_DIR` など）を足さない。
  SessionStart の hook で置き場を Bash へ渡す仕組みも作らない。クライアントが置き場を渡さない起動は 3 段目で解決される
- `PLUGIN_DATA` は 1 プラグイン専用の置き場で、project 名の階層が付かない。
  単体配布の MCP 登録の `env` にだけ書く案内にし、シェルで export する案内を書かない。複数プラグインが同じ `runtime/` を奪い合うためである
- pecot-workflow も `${データ置き場}/runtime/` に実行用ミラーを作る。旧方式の `venv/` は、`bin/pecot` が解決した置き場と既定の場所の 2 か所から、毎回の起動で片づける（使用中の世代は次回に回す）
- pecot-visual の単体配布も同じ順で、解決した置き場の `mcp-dist/` に依存を置く。
  bash は `plugin_data_dir_normalize`、TypeScript は `cli/src/infra/_shared/dependency-root.ts` が解決する。
  2 つは同じ入力で同じ結果になる。テストがこれを固定している。
  片方だけ変えない

## 名前は 4 層に分ける

| 層 | 名前 | 使う場所 |
|:--|:----|:-------|
| 利用者が入力する層 | `pecot-w` / `pecot-v` / `pecot-t` | プラグイン名、スキルの名前空間、Copilot のインストール先 |
| リポの層 | `pecot-workflow` / `pecot-visual` / `pecot-tools` | ディレクトリ、nx project、release group、タグ、MCP サーバのキー |
| CLI の層 | `pecot` / `pecotv` / `pecot-tools` | コマンド名、作業ディレクトリ（`.pecot/` / `.pecotv/`）、npm・Python のパッケージ名、stderr の接頭辞。据え置く |
| 単体配布の層 | `@pecot/visual-mcp` / `@pecot/tools-mcp` / `@pecot/workflow-mcp`（bin は `pecot-visual-mcp` / `pecot-tools-mcp` / `pecot-workflow-mcp`） | MCP の単体配布の npm のパッケージ名と bin。スコープ `@pecot` の後ろに機能の名前を置く |

MCP サーバのキーはリポの層（`pecot-visual` / `pecot-visual-playwright` / `pecot-tools`）にします。Copilot CLI はキーを
そのままツール名の前置きにし、同名のキーは後から読んだものが勝つためです。キー・`MCP_SERVER_NAME`・スキルとエージェント本文の
サーバ名・単体配布の登録例を同時に揃えます。

pecot-tools のパッケージ名・配布物名・MCP サーバのキーには `aws` を入れません。awscli 以外の CLI を足すときは、
ツール名の接頭辞（`aws_` など）だけを分けて同じサーバに同居させます。

## 利用者向け README を書く

対象はルート `README.md`、3 プラグインの `README.md`、単体配布の `scripts/release/mcp-dist-README.md` 3 本です。読者は導入して使う人です。
各行に「読者がこれで何をするか」があるものだけ残します。

骨組みは次のとおりです。持たない節は作りません。

- プラグイン README: 1 文の紹介 → スキル／エージェント／MCP ツール → 動作要件 → 設定（利用者が変えられる環境変数） → ライセンス
- 単体配布 README: 1 文の紹介 → 前提 → 登録（版の固定を含む） → 初回の操作 → ツール → 失敗したとき → 版
- バッジは動作前提 → 技術スタックの順で、shields.io の `flat-square`。
  バージョンは実際の下限に合わせる。
  Node.js は `plugins/pecot-visual/cli/src/node-runtime.ts` の表に合わせる

置かないもの:

- 開発者向けの記述（元ファイルのパス、同期機構、実装経緯、ハッシュやロックの内部、開発手順、テストハーネス、リリース手順、命名の理由、「自動生成なので直接編集しない」）。内部の仕組みは `bin/_lib.sh` のコメント、開発手順は `CLAUDE.md` と w-release スキルに書く
- 旧名からの移行手順。利用者が読む変更点は version-plan（CHANGELOG）に書く
