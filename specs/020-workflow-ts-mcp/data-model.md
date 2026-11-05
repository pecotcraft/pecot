# Data Model: pecot-workflow の TypeScript 化と MCP 化（再設計）

## CommandDefinition（コマンドの定義）

`cli-node/src/commands/registry.ts` の `COMMANDS` の 1 要素。型は済み。CLI と MCP の両方がこれから作られる。

| フィールド | 型 | 内容 |
|---|---|---|
| `path` | `readonly string[]` | `['issue', 'create']`、`['add-to-project']` |
| `toolName` | `string` | `path` から作る。`issue_create`、`add_to_project` |
| `description` | `string` | typer の help の 1 行目と同じ文 |
| `input` | zod の object | 引数とオプションに、グローバルの `repo` を足したもの。名前は CLI のオプション名の `-` を `_` にしたもの |
| `positional` | `readonly string[]` | `input` のうち CLI で位置引数になるもの（順序つき） |
| `shortFlags` / `negations` | `ReadonlyMap<string, string>` | `-D` のような短いオプションと、`--no-checkout` のような否定形 |
| `interactive` | `boolean` | CLI でだけ利用者に問うか（`worktree link` だけ true） |
| `parse` / `run` | 関数 | 入力の検証と実行。終了コードを返し、出力は `CommandIo` に書く |

規則:

- 一覧は 32 要素。`toolName` は重複しない
- `input` の既定値は CLI のオプションの既定値と同じ
- CLI と MCP は同じ `run` を呼ぶ。分岐は `interactive` の扱いだけ

## ToolResult（MCP の結果）

| フィールド | 型 | 内容 |
|---|---|---|
| `content[0].text` | `string` | `stdout` そのもの。スキルは今の CLI の出力と同じ Markdown を読む |
| `isError` | `boolean` | `exitCode !== 0` |
| `structuredContent.exitCode` | `number` | CLI の終了コード |
| `structuredContent.stdout` | `string` | |
| `structuredContent.stderr` | `string` | 失敗時の文言。今の CLI と同じ |

## ParityScenario と Golden（済み）

形式は [contracts/parity.md](./contracts/parity.md)。

| フィールド | 内容 |
|---|---|
| `id` | `issue-create-basic` など。ファイル名と同じ |
| `command` | `path` と CLI の引数列 |
| `setup` | 一時 git リポの状態、データ置き場の中身、env |
| `github` | 偽の GitHub サーバの応答の列 |
| golden | `stdout`、`stderr`、`exitCode`、書き込みの要求の列、終わった後の `.pecot/` とデータ置き場 |

状態の移り変わり:

| 状態 | 移る条件 |
|---|---|
| 記録済み | 213 件。Python の実出力から作った |
| ずれ | Python の CLI か依存が変わり、`record:parity:check` に差が出る |
| 記録し直し | ずれを起こした PR の中で `record:parity` を流す。Node も同じ PR で直す |
| 回帰の期待値 | Python の削除の後。`record.ts` は消え、golden は Node の回帰テストとして残る |

## Baseline（済み）

`cli-node/tests/parity/baseline.json`。書き換えない。

| フィールド | 値 |
|---|---|
| `measuredAt` | `2026-10-29T16:46:19Z` |
| `commit` | 旧リポの `ba0dedf2` |
| `cli.lineCoverage` | 91.0 |
| `hooks.testCount` | 1,569 |
| `hooks.scripts` | テストが起動する hooks のスクリプトの一覧 |

## McpToolName（クライアントに見える名前）

| クライアント | 形 | 取り出し |
|---|---|---|
| Claude Code | `mcp__plugin_pecot-w_pecot-workflow__<tool>` | 接頭辞 `mcp__plugin_pecot-w_pecot-workflow__` を外す |
| Copilot CLI | `pecot-workflow-<tool>`（フェーズ 8 で確かめる） | 接頭辞 `pecot-workflow-` を外す |

## 状態ファイル（変えない）

| 置き場 | 内容 | 扱い |
|---|---|---|
| データ置き場 `config/` | ボードの設定、hosts | Python と同じ形式で読み書きする |
| リポの `.pecot/` | セッション状態、スラッシュコマンドのフラグ、下書き | 同じ |
| データ置き場 `venv/` | Python の venv | 切り替えの版が初回起動で消す |
| データ置き場 `runtime/` | Node の実行用ミラー | 新規。`<deps-hash>-<src-hash>/` |

## Distribution（配布の形）

| 形 | 中身 | 登録 |
|---|---|---|
| プラグイン（Claude Code） | `.claude-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json`、skills、agents | marketplace の `pecot-w` |
| プラグイン（Copilot CLI） | root の `plugin.json`・`mcp.json`、`com.github.copilot/`、skills | 同じ |
| 単体配布 | MCP サーバだけ。hooks・skills は無い | `npx -y @pecot/workflow-mcp` |
