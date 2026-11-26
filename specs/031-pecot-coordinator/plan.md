# Implementation Plan: pecot-coordinator プラグインを作り、claude.ai のプロジェクトの coordinator とクラウドのスレッドが pecot の流れで動く

**Branch**: `feat/breakdown-pecot-coordinator/756` | **Date**: 2026-11-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/031-pecot-coordinator/spec.md`

## Summary

この Epic は次の 5 つの塊で進める。調べた結果と判断の理由は [research.md](research.md) にある。

1. **検証**: プロジェクト指示の振り分け、GitHub 公式の MCP の試していない手と Actions の token、claude.ai への配布を、実物で確かめる。手の有無はソースで調べ済み（[contracts/github-io.md](contracts/github-io.md)）
2. **`actions/` を作る**: Actions のテンプレートと、Actions だけで動くスクリプトを、AI と無関係な `actions/` に移す。利用者のリポは `uses:` で呼ぶ。共有する部品は `libs/workflow-core` に切り出す。公式の MCP に手の無い操作のワークフローもここに置く
3. **既存のプラグインを claude.ai に載せる**: 3 つのプラグインの `bin/` をなくす。MCP は npm に出している版を `npx` で起動する。CLI の入口もなくし、機能は MCP のツールだけで公開する。直したツールは、作業ツリーで build し、MCP Inspector の CLI で呼んで試す（research の R2・R10）
4. **pecot-workflow の作り替え**: スキルが呼ぶ pecot-workflow のツールは計算だけを行い、GitHub の読み書きはスキルが GitHub 公式の MCP で行う。手の無い操作は、スキルが `actions/` のワークフローを起動して行う
5. **pecot-coordinator**: coordinator のスキルだけを持つプラグインを作り、このリポのプロジェクト指示を固有の値だけに書き直す

## Technical Context

**Language/Version**: TypeScript（MCP のサーバ・action のスクリプト・スキルのテスト。vitest）、Markdown（`SKILL.md`・検証の記録）、GitHub Actions の YAML（`action.yml`・雛形）、JSON（マニフェスト・`mcp.json`・marketplace）

**Primary Dependencies**: GitHub 公式の MCP（リモートは `https://api.githubcopilot.com/mcp/`・`/mcp/x/projects`、blocked-by は `/insiders`）、
GitHub Actions の JavaScript の action（`runs.using: node24`、rollup でまとめた `dist/`）、claude.ai のプラグイン（Add marketplace）、Claude Code のプラグインの同期（`<name>@synced`）

**Storage**: なし。検証の記録は `specs/031-pecot-coordinator/verification/` に Markdown で置く

**Testing**: MCP Inspector の CLI（版を固定し、build した作業ツリーのサーバのツールを呼ぶ）、vitest（`libs/workflow-core`・`actions/` のスクリプト・pecot-workflow の計算とスキルの形・pecot-coordinator の `test-skills`）、既存のプラグインの各レーン、sandbox への CUJ（手元とクラウドのスレッド。
`actions/` の action は sandbox のワークフローから `uses:` で呼ぶ）

**Target Platform**: claude.ai（Chat のプロジェクト）、Claude Code on the web（クラウドのスレッド）、手元の Claude Code と GitHub Copilot CLI、GitHub Actions

**Project Type**: 新しい nx project 3 つ（`actions/`・`libs/workflow-core`・`plugins/pecot-coordinator`）、配布するプラグインの作り替え（pecot-workflow）と構成の是正（3 つ）

**Performance Goals**: なし。SC-012（利用者が答える質問が今より増えない）を手順で確かめる

**Constraints**: スレッドの GitHub の読み書きは GitHub 公式の MCP だけ（FR-013）。手の無い操作は `actions/` の中だけ（FR-016）。pecot はブランチを消さない（FR-018）。`actions/` は AI に向けたものを持たない（FR-010）。本文とボードの欄は今と同じ形（FR-020）。機能を落とさない（FR-021）。
古い雛形は一度で切り替える（FR-029）。検証の書き込みは検証用のリポとボードだけ（FR-005）

**Scale/Scope**: pecot-workflow の `cli/src/commands/` は 74 ファイル、`cli/src/infra/github/` は約 5,400 行。Actions だけで使う処理は `auto_*`・`review_finish`・`board_sync`・`tracker_sync`。
雛形は `pecot-board-sync.yml`・`pecot-handoff.yml`・`pecot-review.yml`

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判断 | 理由 |
|---|---|---|
| I. ライブラリ優先 | 合格 | 共有する決まり（前提の判定・本文の組み立て・GitHub の読み書き）を `libs/workflow-core` に置き、pecot-workflow と `actions/` はそれを呼ぶ入口だけを持つ |
| II. テキストのインタフェース（5.0.0） | 合格 | この計画で 4.0.0 の「CLI インタフェース」から直す（research の R10）。プラグインは機能を MCP のツールだけで公開する。スキルが呼ぶ計算のツールは、GitHub 公式の MCP で読んだ結果を JSON で受け、書き込む中身を JSON で返す。`actions/` の action は入力を `action.yml` の `inputs` で受ける |
| III. テストファースト | 合格 | 移す処理は、新しい置き場所を指すテストに先に直す。計算のツールの入出力は定義書とテストに先に書く。pecot-coordinator の `test-skills` も先に書く |
| IV. 標準準拠 | 合格 | プラグインの形は claude.ai の文書と Agent Plugins 1.0（R1・R2）、action の形と版の管理は GitHub の文書（R5）、タグの形は Dependabot のソース（R6）に合わせる。スレッドの読み書きは GitHub 公式の MCP のツールに従い、包む層を作らない |
| V. 品質の自動チェック | 合格 | 新しい 3 つの project を lint・test・knip の対象に入れる。`actions/` の `dist/` が source と食い違わないことを CI で止める。pecot-coordinator を `claude plugin validate --strict` の対象に入れる |
| VI. 層の分離 | 合格 | ドメイン層（`libs/workflow-core` の domain）は I/O を持たない。GitHub の I/O は、スレッドではエージェントの MCP のツール、Actions では `libs/workflow-core` のインフラ層が受け持つ |
| VII. シンプルさ | 合格 | 新しい project は 3 つで、どれも置き場所の決まりと役割の分け方（FR-010・FR-023）から要る。クラウドのスレッド向けのスキルは別に作らない |
| VIII. 抽象化しない | 合格 | GitHub 公式の MCP のツールをスキルから直接呼ぶ。action は処理ごとに 1 つで、共通の包みを作らない |
| IX. 統合を先にするテスト | 合格 | 試していない手と token を Phase 2 で実物で試してから作り替える。作り替えた後は、sandbox への CUJ を手元とクラウドのスレッドで流す |

Phase 1 の後の再確認（2026-11-26）: 合格。ルート直下に `actions/` を足すのは、利用者が 2026-11-26 に許した。`.claude/rules/repo-root-layout.md` の一覧と hook の `ALLOWED` を同じ変更で直す。原則 II は、利用者が 2026-11-26 に許した直しで 5.0.0 にし、この計画の PR で入れる。

## Project Structure

### Documentation (this feature)

```text
specs/031-pecot-coordinator/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── github-io.md                    # スレッドの読み書きと、使う手
│   ├── actions-interface.md            # actions/ の action の一覧と入出力
│   └── project-instruction-values.md   # プロジェクト指示に書く固有の値
├── verification/                       # Phase 1〜3 が作る
└── tasks.md                            # /speckit-tasks
```

### Source Code (repository root)

```text
actions/                              # 新しい nx project（AI と無関係）
├── <処理>/action.yml                  # 一覧は contracts/actions-interface.md
├── <処理>/dist/index.js               # rollup でまとめたもの。commit する
├── src/                               # 処理ごとの入口
├── templates/                         # 利用者のリポに置く、uses で呼ぶ短いワークフロー
├── tests/
├── project.json・package.json・CHANGELOG.md
└── README.md                          # 導入の手順と、要る secret・variable

libs/workflow-core/                   # 新しい nx project。pecot-workflow と actions/ が取り込む
├── src/domain/                        # plugins/pecot-workflow/cli/src/domain/ から移す
├── src/infra/github/                  # 同じく。actions/ が使う
└── src/commands-shared/               # 両方が使う処理の共通の部品

plugins/pecot-workflow/
├── bin/                               # 消す。.mcp.json・mcp.json は npx で @pecot/workflow-mcp@<版> を起動する
├── CONTRIBUTING.md                    # 試験環境の bin/pecot を、MCP Inspector の --cli に
├── cli/src/cli.ts                     # 消す。CLI の入口を持たない
├── cli/src/commands/                  # スキルが呼ぶ計算の処理だけが残る
├── cli/src/mcp/                       # エージェントが使うツールだけを、サーバに直に登録する
├── cli/templates/workflow/            # 消す（actions/templates/ へ）
└── skills/                            # 計算 → GitHub 公式の MCP で書く、の形に直す

plugins/pecot-visual/bin/             # 消す。npx で @pecot/visual-mcp@<版> を起動する
plugins/pecot-tools/bin/              # 消す。npx で @pecot/tools-mcp@<版> を起動する

plugins/pecot-coordinator/            # 新しい nx project
├── .claude-plugin/plugin.json・plugin.json
├── skills/c-coordinate/SKILL.md
├── interface/authored.yaml・tests/skills/
├── project.json・package.json・CHANGELOG.md
└── README.md                          # 入れ方と、プロジェクト指示に書く値の一覧と例

.github/workflows/                     # このリポの board-sync・review・handoff・アラートの同期を uses: ./actions/<処理> に
.claude/rules/repo-root-layout.md・.githooks/pre-commit/check-root-entries.sh   # actions を足す
.claude-plugin/marketplace.json        # pecot-c を足す
nx.json                                # release に actions（タグ pecot-actions/v{version}）・pecot-coordinator・workflow-core を足す
```

**Structure Decision**: `actions/` はルート直下の 1 つの nx project で、処理ごとに 1 つの action を持つ。共有する部品は `libs/workflow-core` に置き、pecot-workflow と `actions/` のどちらも取り込む。
pecot-coordinator は `plugins/` の下の 1 つのプラグインで、スキルの名前は `c-` で始め、marketplace の名前は `pecot-c`。

## フェーズの見通し

tasks.md で決める。前提の形だけ先に書く。

| フェーズ | 中身 | 前提 |
|---|---|---|
| 1 | 検証: プロジェクト指示の振り分け（US1） | なし |
| 2 | 検証: 公式の MCP の試していない手と、`actions/` の処理ごとの token（US2） | なし |
| 3 | 検証: claude.ai への配布と、読まれるか（US3） | なし |
| 4 | 共有する部品を `libs/workflow-core` に切り出す。pecot-workflow の動きは変えない | なし |
| 5 | `actions/` を作り、Actions だけの処理と雛形を移して `uses:` で呼ぶ形にする。MCP から外す。古い雛形を見つけて書き換える（US5・FR-010〜FR-012・FR-029・FR-030） | 4 |
| 6 | `actions/` に、手の無い操作とリリースのワークフローを足す（FR-016・FR-017） | 2・5 |
| 7 | pecot-workflow の `bin/` と CLI の入口をなくし、MCP を npm の版で起動する。試験環境の手順を MCP Inspector に書き換える（US4・R10） | 5 |
| 8 | pecot-visual の `bin/` と CLI の入口をなくし、MCP を npm の版で起動する。`bin/pecotv` のミラーに頼るフック（eslint・text-lint・参照の検証・テーマの読み取り）を、MCP のツールと Claude Code の `mcp_tool` のフックに移す。setup.sh・Chromium の準備の頼り先も直す（US4・R11） | なし |
| 9 | pecot-tools の `bin/` と CLI の入口をなくし、MCP を npm の版で起動する（US4） | なし |
| 10 | pecot-workflow: 計算のツールの形を決め、Issue のまとまりを作り替える（US6・FR-019） | 2・7 |
| 11 | pecot-workflow: ボード・セッション・PR・プロジェクトの設定・リリースのまとまりを作り替える（US6・FR-016〜FR-018） | 6 のリリース・10 |
| 12 | pecot-workflow: スキルが呼ばなくなった GitHub の I/O を消し、試験環境の手順をクラウドから行えるようにする（FR-022・SC-005） | 11 |
| 13 | pecot-coordinator の nx project と coordinator のスキル（US7） | 1・3 |
| 14 | クラウドのスレッドで流れを確かめ、プロジェクト指示を書き直す（US8） | 12・13 のリリース |

## Complexity Tracking

該当なし。
