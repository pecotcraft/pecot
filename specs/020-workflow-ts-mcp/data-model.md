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

- 一覧は 34 要素。`toolName` は重複しない
- 出力は `createOutput`（`src/commands/output.ts`）を通す。`CommandIo` に直接書かない
- 一覧から書き出した項目（`exportEntries`）が、定義書の同じ ID の項目と `input`・`cli` で一致する
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
| 記録済み | 228 件（2026-11-11）。Python の実出力から作った |
| ずれ | Python の CLI か依存が変わり、`record:parity:check` に差が出る |
| 記録し直し | ずれを起こした PR の中で `record:parity` を流す。Node も同じ PR で直す |
| 回帰の期待値 | Python の削除の後。`record.ts` は消え、golden は Node の回帰テストとして残る |

## InterfaceEntry（定義書の項目）

`plugins/pecot-workflow/interface/generated.json` の `entries` の 1 要素。形式は spec 022 の `contracts/definition-format.md`。

| フィールド | 内容 | Python の書き出し | Node の書き出し |
|---|---|---|---|
| `id` | `PW-ISSUE-CREATE` など。コマンドのパスから作る | ある | 同じ |
| `name` / `description` | コマンドのパスと 1 行の説明 | ある | 同じ |
| `surfaces.cli.path` | CLI のパス | ある | 同じ |
| `surfaces.mcp.tool` | MCP ツールの名前 | 無い | ある |
| `input` | 引数の JSON Schema。グローバルの `repo` は含めない | ある | 同じ（`--check` が比べる） |
| `cli` | 位置引数の順と、フラグの名前 | ある | 同じ（`--check` が比べる） |

状態の移り変わり:

| 状態 | 書き出しの元 | Node の役割 |
|---|---|---|
| 切り替えの前 | Python（`scripts/interface/export.py`） | `--check` で、登録したコマンドの `input` と `cli` を比べるだけ |
| 切り替え（フェーズ 11） | Node（`export-interface.ts --write`） | `generated.json` を書く。差分は `surfaces.mcp` だけ |
| Python の削除の後 | Node | 同じ。`lint-defs` が読む先も Node だけになる |

## BehaviorItem（振る舞いの項目）

`interface/authored.yaml` の各項目が持つ、振る舞いの 1 文と ID。769 個。

| フィールド | 内容 |
|---|---|
| `id` | `PW-ISSUE-CREATE-01` など。項目の ID に連番を付ける。共通のものは `PW-COMMON-NN` |
| 文 | EARS の型の 1 文。変えない |
| つなぎ | テストのファイルに ID の文字列があること。pytest は `@add_test_properties(verifies=[...])`、vitest は `verifies(context, 'PW-…')` |

規則:

- コマンドを Node に移したら、その項目は全部 vitest のケースにつながる。`tests/parity/` の下にはつながない
- Python を消すまで、pytest の側のつなぎも残す
- ID と文は、この移行では変えない

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
| Copilot CLI | `pecot-workflow-<tool>`（フェーズ 9 で確かめる） | 接頭辞 `pecot-workflow-` を外す |

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
