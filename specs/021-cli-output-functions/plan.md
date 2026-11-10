# Implementation Plan: CLI の出力を共通の関数だけが書き、行の形がコマンドによらずそろう

**Branch**: `021-cli-output-functions` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/021-cli-output-functions/spec.md`

## Summary

4 つの CLI（pecot-workflow の Python と `cli-node/`、pecot-visual、pecot-tools）に、行の種類ごとの共通の関数を足す。
種類は error・warning・note・plan・result・count・data の 7 つ。
行は git と同じ小文字の前置きと英文で書き、data だけを stdout に出す。
plan と result は 1 つの操作から作り、dry-run かどうかで一方だけが出る。
pecot-workflow の 675 か所の `typer.echo` と help の文言を、コマンドのグループごとの PR で英語の共通の関数に移す。
各 PR で pytest の期待値と parity の golden を記録し直す。
移し終えた範囲から ruff と eslint で直接の出力を止める。
pecot-visual・pecot-tools は、MCP ツールが返す結果の文言と説明文も英語にする。
最後は、hooks がエージェントへ返すメッセージを英語にする。

## Technical Context

| 項目 | 内容 |
|---|---|
| Language/Version | Python 3.10 以上（pecot-workflow の CLI）、TypeScript、Bash（hooks）。Node の版の下限は `plugins/pecot-visual/cli/src/node-runtime.ts` の表にある |
| Primary Dependencies | typer（Python の CLI）、`@modelcontextprotocol/sdk`（MCP サーバ）、ruff、eslint |
| Storage | N/A |
| Testing | pytest（`cli/tests/`・`hooks/tests/`）、vitest、`*.test.sh`（pecot-visual の hooks）、parity の golden 224 件 |
| Target Platform | Claude Code と GitHub Copilot CLI が動く Linux・macOS、GitHub Actions の runner |
| Project Type | CLI と MCP サーバ。プラグインとして配布する |
| Performance Goals | N/A（出力の形だけを変える） |

**Constraints**:

- pecot-visual・pecot-tools の stdout は MCP の JSON-RPC だけが使う
- golden は Python を変える PR の中でだけ記録し直す（spec 020 の FR-007）
- 終了コードを変えない
- GitHub に書く本文は変えない

**Scale/Scope**: 次の量を移す。

- Python の `typer.echo` 675 か所と、help の文言 118 か所と docstring
- pytest の出力の比較 865 行と、golden 224 件
- Node の直接の出力 約 22 か所
- MCP ツールの結果とエラーの文言（`mcp/` の下で日本語を含むファイル 33）と、ツールの説明文 35 か所
- pecot-tools の `src/` で日本語を含むファイル 32
- hooks の日本語の行 217 行

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | 合格 | 共通の関数はプレゼンテーション層に置く。pecot-visual の domain 層は出力先のインターフェースだけを受け取り、実装は infra 層が持つ。層の依存は既存の `import-x/no-restricted-paths` と `test_architecture.py` が確かめる |
| II. TDD | 合格 | 共通の関数は `cases.json` の具体的な期待の行と比べるテストを先に書く。コマンドの移行は pytest の期待値と golden を同じ PR で直す。モックは書き込み先だけにする |
| III. コード品質 | 合格 | 直接の出力を止める lint（ruff の `T20`・`TID251`、eslint）を足す。英語の固定の文言はテストで確かめる |
| IV. YAGNI | 合格 | 共有のライブラリを作らず、各 CLI に 50 行ほどのモジュールを置く（research R6）。進捗の行は消す（R4） |
| V. 本体優先 | 合格 | speckit 成果物は新規の一式だけを作る |

Phase 1 の設計の後も、同じ判定になる。

## Project Structure

### Documentation (this feature)

```text
specs/021-cli-output-functions/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── output-lines.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

```text
plugins/pecot-workflow/
├── cli/
│   ├── commands/
│   │   ├── _output.py            # 新規。共通の関数（Output・Verb・Operation）
│   │   ├── _tracker_sync.py      # 移す（US1）
│   │   ├── security.py           # 移す（US1）
│   │   ├── dependabot.py         # 移す（US1）
│   │   └── issue.py ほか          # 移す（US2）。help と docstring も英語にする
│   ├── pyproject.toml            # ruff の T20・TID251 を足す（US3）
│   └── tests/unit/
│       ├── test_output.py        # 新規。cases.json と比べる
│       └── test_english_only.py  # 新規。commands/ のリテラルに日本語が無い
├── cli-node/
│   ├── src/commands/output.ts    # 新規。Python と同じ共通の関数
│   ├── src/cli.ts                # 直接の出力を移す
│   ├── eslint.config.js          # 直接の出力を止める
│   └── tests/
│       ├── output/cases.json     # 新規。Python と Node の期待の行
│       ├── output/output.test.ts # 新規
│       └── parity/golden/        # PR ごとに記録し直す
└── hooks/
    ├── lib/                      # メッセージを英語にする
    └── tests/test_english_only.py

plugins/pecot-visual/
├── cli/tests/diagnostics-cases.json # 新規。error・warning・note の期待の行
├── cli/src/diagnostics.ts        # 新規。error・warning・note
├── cli/src/domain/               # 出力先のインターフェースを受け取る形に直す
├── cli/src/mcp/tools/            # 結果の message と説明文を英語にする
├── cli/tests/unit/english-only.test.ts  # 新規。src/ のリテラルに日本語が無い
├── cli/eslint.config.js
└── hooks/                        # メッセージを英語にする。tests/english-only.test.sh を足す

plugins/pecot-tools/
├── cli/tests/diagnostics-cases.json # 新規。error・warning・note の期待の行
├── cli/src/diagnostics.ts        # 新規
├── cli/src/mcp/                  # 結果の message と説明文を英語にする
├── cli/tests/english-only.test.ts # 新規
└── cli/eslint.config.js

.githooks/tests/test_cli_output_lines_match.py  # 新規。3 プラグインの期待の行が同じ
```

**Structure Decision**: 既存の各プラグインの構成に、共通の関数のモジュールを 1 つずつ足す。新しい project・ディレクトリは作らない。

## 実装の段階と PR

| 段階 | 中身 | 対応 | golden |
|---|---|---|---|
| 1 | Python と Node の共通の関数、`cases.json`、契約のテスト | US4・FR-001〜005・FR-009 | 変わらない |
| 2 | `security sync`・`dependabot sync`・`_tracker_sync.py` を移し、英語にする | US1・FR-003・FR-004 | 該当シナリオを記録し直す |
| 3 | 全コマンドの docstring と `help=` を英語にする | US2・FR-012 | help を記録したものを記録し直す |
| 4 | `issue` を移す | US2 | 該当シナリオを記録し直す |
| 5 | `pr` を移す | US2 | 同上 |
| 6 | `project` を移す。進捗の行を消し、見出しと項目名を英語にする | US2・FR-012 | 同上 |
| 7 | `release`・`worktree`・`repo`・`session`・`main` を移す。英語の文言のテストを全リテラルに広げる | US2・FR-012 | 同上 |
| 8 | ruff の `T20`・`TID251` と `cli-node/` の eslint を有効にする。`cli-node/src/cli.ts` などを移す | US3・FR-007 | 変わらない |
| 9 | pecot-visual の診断行を共通の関数に移し、eslint を有効にする | US5・FR-010・FR-013 | 対象外 |
| 10 | pecot-visual の MCP ツールの結果の文言と説明文を英語にし、英語のテストを足す | US5・FR-015 | 対象外 |
| 11 | pecot-tools の診断行・MCP ツールの文言と説明文を英語にする。3 プラグインの行が同じことを root のテストで守る | US5・FR-010・FR-015 | 対象外 |
| 12 | pecot-workflow・pecot-visual の hooks のメッセージを英語にし、英語のテストを足す | FR-014 | 対象外 |

- 段階 2〜7 は、それぞれ出力の文字列で判定するスキル・hooks・テンプレートを同じ PR で確かめて直す（FR-011）
- 段階 4〜7 は段階 3 の後で、互いに独立していて、どの順でも進められる。段階 8 は 2〜7 が済んでから進める。段階 9・12 は段階 1 の後ならいつでも進められ、10・11 は 9 の後に進める
- 各 PR は、変えたプラグインの version plan を足す。出力の形が変わるので、利用環境のエージェントに見える変更として扱う

## Complexity Tracking

憲章の違反は無い。
