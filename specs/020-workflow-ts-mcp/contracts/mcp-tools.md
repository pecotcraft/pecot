# Contract: pecot-workflow の MCP ツール

ツールの一覧・入力・振る舞いの正は `plugins/pecot-workflow/interface/` の定義書です。この文書と食い違うときは、定義書に従います（FR-018）。

## サーバ

| 項目 | 値 |
|---|---|
| サーバ名 | `pecot-workflow` |
| 起動 | `bin/pecot mcp`（stdio） |
| Claude Code の登録 | `.mcp.json` の `mcpServers.pecot-workflow`。`command` は `${CLAUDE_PLUGIN_ROOT}/bin/pecot`、`args` は `["mcp"]` |
| Copilot CLI の登録 | root の `mcp.json`（Agent Plugins 1.0）。`command` は `./bin/pecot`、`args` は `["mcp"]`、`type` は `stdio`。`env` は付けない（research R-11） |
| 単体配布の登録 | npm の `@pecot/workflow-mcp`。`command` は `npx`、`args` は `["-y", "@pecot/workflow-mcp"]`。hooks は含まない（research R-14） |
| データ置き場 | `CLAUDE_PLUGIN_DATA` → `PLUGIN_DATA` → 既定の場所（今の `bin/_lib.sh` の順） |
| クライアントに見える名前 | Claude Code は `mcp__plugin_pecot-w_pecot-workflow__<tool>`、Copilot CLI は `pecot-workflow-<tool>`（research R-5） |

## hooks のガードを持つツール

| ツール | CLI | hooks のガード |
|---|---|---|
| `issue_create` | `pecot issue create` | ask（`prepare` が true なら素通し） |
| `issue_quick` | `pecot issue quick` | ask（同上） |
| `pr_create` | `pecot pr create` | ask（`prepare` か `dry_run` が true なら素通し） |
| `worktree_link` | `pecot worktree link` | 入力 `overwrite`（既定 false）。CLI の対話確認の代わり（research R-7） |

グローバルオプション `--repo` は、全ツールの入力 `repo`（省略可）で受ける。`--show-repo` と `--version` はツールにしない（CLI の表示用）。

## 結果

[data-model.md](../data-model.md) の ToolResult。`content[0].text` は CLI の stdout と同じ文字列。

## 確かめること

| 確認 | 方法 |
|---|---|
| ツールの数と名前 | `tools/list` が定義書（`interface/generated.json`）の項目と一致する |
| 入力の対応 | 各ツールの JSON Schema のプロパティが、CLI のオプション（`--show-repo`・`--version` を除く）と 1 対 1 |
| 結果の同一性 | 前後比較のシナリオを MCP 経由でも流し、stdout と終了コードが CLI と一致する |
