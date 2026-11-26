# Tasks: pecot-coordinator プラグインを作り、claude.ai のプロジェクトの coordinator とクラウドのスレッドが pecot の流れで動く

**Input**: `specs/031-pecot-coordinator/` の設計の文書

**Prerequisites**: [plan.md](plan.md)・[spec.md](spec.md)・[research.md](research.md)・[data-model.md](data-model.md)・[contracts/](contracts/)・[quickstart.md](quickstart.md)

**Tests**: constitution の原則 III に従い、実装のタスクの前にテストのタスクを置く。テストは Red を確かめてから実装する。公開面の振る舞いは各プラグインの `interface/authored.yaml` に項目として書き、テストは `verifies` で項目の ID を書く。

**CUJ**: 外へ書き込む確かめは `pecotcraft/pecot-sandbox` とボード「pecot sandbox」だけに流す。書き込む前に `plugins/pecot-workflow/CONTRIBUTING.md` の「3. 試験環境」を読む。

**Organization**: フェーズは plan の「フェーズの見通し」の 14 個に合わせる。1 フェーズが 1 つの Issue になる。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: ほかのファイルを触り、終わっていないタスクに頼らないので、並べて進められる
- **[Story]**: spec のユーザーストーリー（US1〜US8）。Phase 4 は全体の土台なので付けない

## Path Conventions

- 新しい nx project: `actions/`・`libs/workflow-core/`・`plugins/pecot-coordinator/`
- 検証の記録: `specs/031-pecot-coordinator/verification/`
- 作業ファイル: `.pecot/work/<Issue番号>/`

---

## Phase 1: プロジェクト指示とプラグインの線を引く（US1, P1）

**Goal**: 今のプロジェクト指示の文を 1 つずつ、スキルへ移すもの・固有の値として残すもの・リポの CLAUDE.md に送るものに振り分ける（FR-001・FR-005・FR-006）

**Independent Test**: 振り分けの一覧に、行き先の無い文が 0 件で、スキルへ移す文に固有の名前が無い（SC-001）

- [x] T001 [US1] 今のプロジェクト指示の全文を、文ごとに 1 行にして `specs/031-pecot-coordinator/verification/project-instructions.md` に写す。写した日付を添える
- [x] T002 [US1] 各文に、行き先（スキルへ移す・固有の値・リポの CLAUDE.md）と理由を書く in `specs/031-pecot-coordinator/verification/project-instructions.md`
- [x] T003 [US1] スキルへ移す文から、このリポ・利用者・端末に固有の名前を抜き出して値に分け、文を書き直す in `specs/031-pecot-coordinator/verification/project-instructions.md`
- [x] T004 [US1] 値の一覧を確定する。「未定」の値（クラウドのスレッドの上限など）は利用者に確かめて決め、`specs/031-pecot-coordinator/contracts/project-instruction-values.md` に書く
- [x] T005 [US1] 行き先の無い文と、固有の名前が残るスキルへ移す文を数え、0 件であることを `specs/031-pecot-coordinator/verification/project-instructions.md` の末尾に書く

---

## Phase 2: GitHub 公式の MCP の試していない手と、Actions の token を確かめる（US2, P1）

**Goal**: [contracts/github-io.md](contracts/github-io.md) の「未確認」の行と、`actions/` の処理ごとに要る token を、実物で決める（FR-002・FR-003・FR-005・FR-006）

**Independent Test**: リモート MCP だけで sandbox の Issue 1 件を起票から閉じるまで動かし、pecot-workflow で同じ操作をした Issue とボードの欄と比べる（SC-002）

- [ ] T006 [US2] `plugins/pecot-workflow/CONTRIBUTING.md` の「3. 試験環境」に従って sandbox を揃える。確かめで作るものの題は `[cuj <Issue番号>-<4文字>]` の形にする
- [ ] T007 [US2] クラウドのスレッドから `projects_write` の `add_project_item`・`update_project_item`・`delete_project_item` で、sandbox のボードの item を足し、進行の欄・single select・日付を書いて消す
- [ ] T008 [US2] アーカイブした item を `projects_write` で外して足し直し、欄を書き直して、今の `issue_reopen` と同じ状態に戻るかを確かめる
- [ ] T009 [US2] `projects_write` の `create_project`・`create_project_view` で sandbox の持ち主にボードとビューを作り、今の `project_create` の結果と比べる。片付けは CONTRIBUTING の手順に従う
- [ ] T010 [US2] Insiders（`/insiders`）の `issue_dependency_write`・`issue_dependency_read` で blocked-by を付け・読み・外し、今の `issue_block`・`issue_unblock` の結果と比べる
- [ ] T011 [US2] base に遅れた sandbox の PR で `update_pull_request_branch` を呼び、今の `pr_restack` と同じ結果になるかを確かめる
- [ ] T012 [US2] PR を作った人と別の sandbox の collaborator を、`update_pull_request` の `reviewers` で頼み、今の `pr_create` と同じになるかを確かめる
- [ ] T013 [US2] リモート MCP の actions の toolset の `actions_run_trigger` で sandbox の `workflow_dispatch` を起動し、`actions_get`・`actions_list` で job summary を読めるかを確かめる
- [ ] T014 [US2] リポの「head ブランチを自動で消す」設定（`delete_branch_on_merge`）を公式の MCP で読めるかを確かめる。読めなければ、`github-ops` に読む operation を足すと記録する
- [ ] T015 [US2] 手元の Claude Code が claude.ai のコネクタの GitHub 公式の MCP を使えること（PAT を使わない）と、Copilot CLI の組み込みの GitHub MCP で要る toolset を確かめる
- [ ] T016 [US2] sandbox に `workflow_dispatch` の試しのワークフローを置き、Stacks API・`merge-async`・ボードの欄の作成・リポとボードのつなぎ込みを、`GITHUB_TOKEN` と App の token で試す
- [ ] T017 [US2] 同じワークフローで、Actions の secret と variable の名前の一覧と、tracker-sync の書き込みを、`GITHUB_TOKEN` と App の token で試す
- [ ] T018 [US2] リモート MCP だけで sandbox の Issue 1 件を起票から閉じるまで動かし、pecot-workflow で同じ操作をした Issue とボードの欄との差を `specs/031-pecot-coordinator/verification/github-io.md` に書く
- [ ] T019 [US2] T007〜T017 の操作・結果・読んだ版と日付を `specs/031-pecot-coordinator/verification/github-io.md` に書く
- [ ] T020 [US2] 結果で `specs/031-pecot-coordinator/contracts/github-io.md` の「未確認」の行と、`specs/031-pecot-coordinator/contracts/actions-interface.md` の「token」の列を埋める

---

## Phase 3: claude.ai への配り方と、読まれるかを確かめる（US3, P1）

**Goal**: プラグインを claude.ai に入れる経路と、coordinator とクラウドのスレッドで読まれるかを、実物で決める（FR-004・FR-005・FR-006）

**Independent Test**: スキルを 1 つだけ持つ試しのプラグインを claude.ai に入れ、coordinator とクラウドのスレッドがそのスキルを使う

- [ ] T021 [US3] スキルを 1 つだけ持ち、`bin/` を持たない試しのプラグインと marketplace を `pecotcraft/pecot-sandbox` に置く
- [ ] T022 [US3] 利用者に claude.ai の個人の Add marketplace で試しのプラグインを入れてもらう。手順は画面の場所とボタンの名前まで書いて渡す
- [ ] T023 [US3] 経路ごとに入ったかと、止まったときの文を `specs/031-pecot-coordinator/verification/distribution.md` に書く
- [ ] T024 [US3] coordinator とクラウドのスレッドに試しのスキルを使わせ、読まれたかを `specs/031-pecot-coordinator/verification/distribution.md` に書く
- [ ] T025 [US3] 試しのプラグインの版を上げ、次に起動したスレッドに新しい版が届くかを `specs/031-pecot-coordinator/verification/distribution.md` に書く
- [ ] T026 [US3] クラウドの VM で、`npx --prefix=<データ置き場> -y @pecot/workflow-mcp@9.0.0` が initialize に答えるかと、pnpm の install が npm に届くかを確かめて書く
- [ ] T027 [US3] 結果が research の R3 と食い違う点と、後続のフェーズの形を変える点を `specs/031-pecot-coordinator/verification/distribution.md` に書く

---

## Phase 4: 共有する部品を libs/workflow-core に切り出す（Foundational）

**Goal**: pecot-workflow と `actions/` が共有する部品を `libs/workflow-core` に移す。pecot-workflow の動きは変えない（research の R8）

**Independent Test**: pecot-workflow の変更のあるレーンが通り、MCP のツールの一覧と各ツールの結果が移す前と同じ

- [ ] T028 `libs/workflow-core/` の nx project を作る（`project.json`・`package.json`・`tsconfig.json`・`tsconfig.build.json`・`vitest.config.ts`）。形は `libs/text-rules/` に揃える
- [ ] T029 `libs/workflow-core/eslint.config.js` に、層の向きと domain からの I/O の禁止を、`plugins/pecot-workflow/cli/eslint.config.js` と同じ決まりで置く
- [ ] T030 `plugins/pecot-workflow/cli/src/domain/` を、テストと一緒に `libs/workflow-core/src/domain/` に移す
- [ ] T031 `plugins/pecot-workflow/cli/src/infra/github/` を、テストと一緒に `libs/workflow-core/src/infra/github/` に移す
- [ ] T032 R8 で挙げた共有の部品（`cli/src/commands/issue-shared.ts` など）を、テストと一緒に `libs/workflow-core/src/commands-shared/` に移す
- [ ] T033 pecot-workflow の import を `libs/workflow-core` に向け、`plugins/pecot-workflow/cli` の build が `libs/workflow-core` を同梱するようにする
- [ ] T034 `libs/workflow-core` の test・lint のレーンを足し、`.githooks/tests/test_nx_affected_mapping.py` と knip の対象に入れる
- [ ] T035 `CLAUDE.md` のリポジトリ構成の表に `libs/workflow-core` を足す
- [ ] T036 version plan を `.nx/version-plans/` に足す。pecot-workflow は動きを変えないので patch にする
- [ ] T037 CUJ: 作業ツリーで build し、リポの外で MCP Inspector の `--cli`（版を固定）で `tools/list` を呼び、移す前と同じ 45 個のツールが出ることを確かめる

---

## Phase 5: actions/ を作り、Actions だけの処理と雛形を移す（US5, P2）

**Goal**: Actions のテンプレートと、Actions だけで動くスクリプトを `actions/` に移し、利用者のリポは `uses:` で呼ぶ。pecot-workflow の MCP から Actions だけのツールを外す（FR-010〜FR-012・FR-029・FR-030）

**Independent Test**: pecot-workflow のツールの一覧に Actions だけのものが無く、`actions/` の雛形で sandbox のワークフローが今と同じ結果になる（SC-004）

### Tests for User Story 5

- [ ] T038 [US5] 今の pecot-workflow の 45 個のツールと、Actions のワークフローの処理の行き先（残す・`actions/` へ移す・消す）の一覧を `specs/031-pecot-coordinator/verification/feature-inventory.md` に書く（FR-021）
- [ ] T039 [US5] ルート直下の一覧に `actions` を足す。`.claude/rules/repo-root-layout.md` の表と `.githooks/pre-commit/check-root-entries.sh` の `ALLOWED` を同じ変更で直し、`test_check_root_entries.py` を通す
- [ ] T040 [US5] `actions/` の nx project を作る（`project.json`・`package.json`・`tsconfig.json`・`vitest.config.ts`・`eslint.config.js`・`rollup.config.mjs`・`CHANGELOG.md`）。`CLAUDE.md` の表に足す
  - lint と knip の対象に入れ、層の向きの決まりを `actions/eslint.config.js` に置く
- [ ] T041 [P] [US5] `board-sync` の入口のテストを書き、今の `board sync` と同じ処理を呼ぶことを確かめる in `actions/tests/board-sync.test.ts`
- [ ] T042 [P] [US5] `session-finish` の入口のテストを書く。今の `session finish --skip-local-cleanup` と同じ片付けで、ブランチを消さない in `actions/tests/session-finish.test.ts`
- [ ] T043 [P] [US5] `tracker-sync` の入口のテストを書く（security・dependabot） in `actions/tests/tracker-sync.test.ts`
- [ ] T044 [P] [US5] `review-finish` の入口のテストを書く（今の `review finish --ensure`） in `actions/tests/review-finish.test.ts`
- [ ] T045 [P] [US5] `auto-gate`・`auto-start`・`auto-finish` の入口のテストを書く in `actions/tests/auto.test.ts`
- [ ] T046 [P] [US5] `plugins/pecot-workflow/cli/tests/*-workflow-template.test.ts` を `actions/tests/templates/` に移し、雛形が `uses: pecotcraft/pecot/actions/<処理>@pecot-actions/v<版>` で呼ぶ形を確かめるように直す
- [ ] T047 [P] [US5] `actions/` の中に、スキル・MCP・エージェントに向けたファイルと文が無いことのテストを書く in `actions/tests/no-agent-content.test.ts`
- [ ] T048 [P] [US5] pecot-workflow の MCP のツールの一覧に `auto_gate`・`auto_start`・`auto_finish`・`review_finish`・`board_sync`・`tracker_sync` が無いことのテストを書く in `plugins/pecot-workflow/cli/tests/mcp/`
- [ ] T049 [P] [US5] `workflow_doctor` が、`.github/workflows/` で `@pecot/workflow-mcp` を `npx` で呼ぶ古い雛形を見つけて返すことのテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`

### Implementation for User Story 5

- [ ] T050 [US5] 処理ごとの入口を `actions/src/<処理>.ts` に書き、`libs/workflow-core` を呼ぶ。入力は `action.yml` の `inputs` から読む
- [ ] T051 [US5] 処理ごとの `actions/<処理>/action.yml` を書く（`runs.using: node24`・`main: dist/index.js`・`inputs` に `token`）。一覧は [contracts/actions-interface.md](contracts/actions-interface.md) の 1 節
- [ ] T052 [US5] rollup で `actions/<処理>/dist/index.js` を作って commit する。source と `dist/` の食い違いを止める target を `actions/project.json` に置き、`ci.yml` で動かす
- [ ] T053 [US5] `plugins/pecot-workflow/cli/templates/workflow/` の 3 つの雛形を `actions/templates/` に移し、`uses:` で版のタグを指して呼ぶ形に書き換える
- [ ] T054 [US5] このリポの `pecot-board-sync.yml`・`pecot-review.yml`・`pecot-handoff.yml`・`security-alerts.yml`・`dependabot-prs.yml` の CLI を呼ぶ step を、`uses: ./actions/<処理>` に書き換える
- [ ] T055 [US5] `auto_gate`・`auto_start`・`auto_finish`・`review_finish`・`board_sync`・`tracker_sync` を、pecot-workflow のツール・CLI のコマンド・npm の package から消す in `plugins/pecot-workflow/cli/src/`
- [ ] T056 [US5] `session_finish` から Actions だけの片付けの道（`--skip-local-cleanup`）を外し、スキルが使う手元の片付けだけを残す in `plugins/pecot-workflow/cli/src/commands/session-finish.ts`
- [ ] T057 [US5] 消したツールの項目を `plugins/pecot-workflow/interface/authored.yaml` から消し、`generated.json` を作り直して `interface-spec:lint-defs` を通す
- [ ] T058 [US5] `workflow_install` が `actions/templates/` の雛形を置くようにし、pecot-workflow の build が雛形を同梱する in `plugins/pecot-workflow/cli/src/commands/workflow.ts`
- [ ] T059 [US5] `workflow_doctor` に、古い雛形の検出と、`actions/` が入っていないときの案内を足す（FR-010・FR-030） in `plugins/pecot-workflow/cli/src/commands/workflow.ts`
- [ ] T060 [US5] 古い雛形を見つけたら、エージェントが `actions/templates/` の雛形で置き換える PR を出す手順を `plugins/pecot-workflow/skills/w-onboarding/SKILL.md` に書く
- [ ] T061 [US5] `nx.json` の release に `actions` を足し、タグを `pecot-actions/v{version}` にする。npm には出さない
- [ ] T062 [US5] `actions/README.md` に、導入の手順と、要る secret・variable を書く
- [ ] T063 [US5] version plan を足す。pecot-workflow はメジャー（FR-029）、`actions` は最初の版
- [ ] T064 [US5] CUJ: sandbox の `.github/workflows/` に `actions/templates/` の雛形を置き（`uses:` は確かめるブランチの ref）、PR のマージと Issue の移動の結果を今の雛形と比べる
- [ ] T065 [US5] CUJ: 古い雛形を置いた sandbox で `workflow_doctor` を呼び、古い雛形として返ることを確かめる

---

## Phase 6: actions/ に手の無い操作とリリースのワークフローを足す（US6, P2）

**Goal**: 公式の MCP に手の無い操作を、`pecot-github-ops.yml` と `github-ops` の action で行えるようにする（FR-016・FR-017）

**Independent Test**: sandbox の `pecot-github-ops.yml` を、GitHub 公式の MCP の `actions_run_trigger` で operation ごとに起動し、結果を読める

- [ ] T066 [P] [US6] `github-ops` の operation ごとのテストを書く（[contracts/actions-interface.md](contracts/actions-interface.md) の 2 節と、Phase 2 で足したもの） in `actions/tests/github-ops/`
- [ ] T067 [US6] operation ごとの処理を `actions/src/github-ops.ts` に書き、`libs/workflow-core/src/infra/github/` を呼ぶ。結果は job summary に JSON で出す
- [ ] T068 [US6] `actions/github-ops/action.yml` を書く（`operation` と、operation ごとの `inputs`・`token`）。`dist/` を作って commit する
- [ ] T069 [US6] `actions/templates/pecot-github-ops.yml` を書く（`workflow_dispatch` の `inputs`・`permissions`・Phase 2 で決めた token）
- [ ] T070 [US6] このリポの `.github/workflows/pecot-github-ops.yml` を足し、`uses: ./actions/github-ops` で呼ぶ
- [ ] T071 [US6] `actions/README.md` に、`pecot-github-ops.yml` の導入と、operation ごとの token を書く
- [ ] T072 [US6] version plan を足す（`actions` は minor）
- [ ] T073 [US6] CUJ: sandbox に `pecot-github-ops.yml` を置き（`uses:` は確かめるブランチの ref）、`actions_run_trigger` で operation ごとに起動して、`actions_get` で結果を読む

---

## Phase 7: pecot-workflow の bin/ と CLI の入口をなくす（US4, P1）

**Goal**: pecot-workflow は直下に `bin/` を持たず、MCP は npm の版を `npx` で起動し、機能は MCP のツールだけで公開する（FR-007〜FR-009・research の R2・R10）

**Independent Test**: `claude plugin validate --strict` が通り、Claude Code で MCP とフックが今どおり動き、作業ツリーの build を Inspector の `--cli` で呼べる

- [ ] T074 [US4] `.mcp.json` と `mcp.json` の形のテストを書く。`npx`・`--prefix` はデータ置き場・`@pecot/workflow-mcp@<版>`、playwright の `--prefix` もデータ置き場 in `plugins/pecot-workflow/cli/tests/`
- [ ] T075 [US4] ツールをサーバに直に登録する形のテストを書き、CLI の入口が無いことを確かめる in `plugins/pecot-workflow/cli/src/mcp/tests/`
- [ ] T076 [US4] `plugins/pecot-workflow/.mcp.json` と `mcp.json` を、`npx` で npm の版を起動する形に直す（Claude Code は `${CLAUDE_PLUGIN_DATA}`、Agent Plugins は `${PLUGIN_DATA}`）
- [ ] T077 [US4] `plugins/pecot-workflow/cli/src/mcp/server.ts` に、ツールを直に登録する形を書く。CLI のコマンドを 1 つずつツールとして出す作りをやめる
- [ ] T078 [US4] `plugins/pecot-workflow/cli/src/cli.ts` と、CLI だけが使う部品を消す。`cli/package.json` の `bin` は、引数なしで MCP のサーバを起動する入口を指す
- [ ] T079 [US4] `plugins/pecot-workflow/bin/` と、`bin/` だけが使う `runtime-lock.yaml`・`runtime-workspace.yaml`・`cli/tests/bootstrap/`・`test-bootstrap` のレーンを消す
- [ ] T080 [US4] T079 で消したものの参照を直す（`.pre-commit-config.yaml`・`nx.json`・`.github/dependabot.yml`・`dependabot-commit.yml`・`.githooks/tests/`・`CLAUDE.md` の表）
- [ ] T081 [US4] リリースで `.mcp.json`・`mcp.json` の `@pecot/workflow-mcp@<版>` を同じ版に書き換える仕組みを足し、`plugins/pecot-workflow/scripts/release/tests/publish-mcp-dist.test.sh` を直す
- [ ] T082 [US4] `release-check` の入口のテストを書き、今の `release check` と同じ判定になることを確かめる in `actions/tests/release-check.test.ts`
- [ ] T083 [US4] `.github/workflows/release.yml` の preflight の `bin/pecot release check` を、`uses: ./actions/release-check` に直す。`actions/release-check/action.yml`・入口・`dist/` を足す
- [ ] T084 [US4] `.devcontainer/scripts/post-create.sh` の `bin/pecot worktree add` を、build したサーバの `worktree_add` を Inspector の `--cli`（版を固定）で呼ぶ形に直す
- [ ] T085 [US4] `.githooks/pre-commit/check-entry-point-logic.sh` を、CLI の入口が無く、MCP のサーバとフックが入口になる形に合わせて直す
- [ ] T086 [US4] `plugins/pecot-workflow/CONTRIBUTING.md` の「3. 試験環境」の `bin/pecot <コマンド>` を、作業ツリーで build して Inspector の `--cli` で呼ぶ形に書き換える（リポの外で打つ）
- [ ] T087 [US4] スキル・`README.md`・`CONTRIBUTING.md` から、PATH のコマンドと `bin/` を前提にする箇所を消す（FR-009） in `plugins/pecot-workflow/`
- [ ] T088 [US4] `.specify/memory/constitution.md` の Sync Impact Report の Follow-up TODO（CONTRIBUTING の書き換え）を済みにする
- [ ] T089 [US4] version plan を足す（pecot-workflow はメジャー）
- [ ] T090 [US4] CUJ: `claude plugin validate --strict` を通し、子の Claude Code に `--plugin-dir` で入れて、npx で npm の版のサーバが起動し、スキルとフックが今どおり動くことを確かめる
- [ ] T091 [US4] CUJ: 作業ツリーで build し、リポの外で Inspector の `--cli` で `tools/list` と `tools/call` が通ることを確かめる

---

## Phase 8: pecot-visual の bin/ と CLI の入口をなくし、フックを MCP のツールに移す（US4, P1）

**Goal**: pecot-visual は直下に `bin/` を持たず、MCP は npm の版を起動する。PostToolUse のフックは `mcp_tool` でツールを呼ぶ（FR-007〜FR-009・research の R11）

**Independent Test**: スライドのファイルを Claude Code で編集すると、`mcp_tool` のフックが呼んだツールの結果がエージェントに届く

- [ ] T092 [P] [US4] フックが呼ぶツール（eslint と text-lint の lint・参照の検証・テーマの読み取り）のテストを書く。結果は `hookSpecificOutput.additionalContext` in `plugins/pecot-visual/cli/src/mcp/tests/`
- [ ] T093 [P] [US4] `hooks/hooks.json` の PostToolUse（Write・Edit）が `type: "mcp_tool"`・`server: "plugin:pecot-v:pecot-visual"` を使うことのテストを書く in `plugins/pecot-visual/hooks/tests/`
- [ ] T094 [P] [US4] `.mcp.json` と `mcp.json` の形のテストを書く（`npx`・`--prefix` はデータ置き場・`@pecot/visual-mcp@<版>`） in `plugins/pecot-visual/cli/tests/`
- [ ] T095 [US4] T092 の 3 つのツールを pecot-visual の MCP に足し、`plugins/pecot-visual/interface/authored.yaml` に項目を足す
- [ ] T096 [US4] `plugins/pecot-visual/hooks/hooks.json` の PostToolUse を、`mcp_tool` で `input` に `${tool_input.file_path}` を渡す形に直す
- [ ] T097 [US4] `hooks/post-tool-use-write.sh`・`post-tool-use-edit.sh`・`hooks/lib/post-tool-use/` と、`hooks/lib/core/hook-paths.sh` の実行用ミラーを読む部分を消す in `plugins/pecot-visual/`
- [ ] T098 [US4] `plugins/pecot-visual/com.github.copilot/hooks/` から動かなくなる PostToolUse のフックを外し、`README.md` に Copilot CLI では動かないことを書く
- [ ] T099 [US4] `plugins/pecot-visual/.mcp.json` と `mcp.json` を、`npx` で npm の版を起動する形に直す
- [ ] T100 [US4] ツールをサーバに直に登録する形のテストを書き、CLI の入口が無いことを確かめる in `plugins/pecot-visual/cli/src/mcp/tests/`
- [ ] T101 [US4] `plugins/pecot-visual/cli/src/cli.ts` を消し、ツールをサーバに直に登録する。`cli/package.json` の `bin` をサーバの入口にする
- [ ] T102 [US4] `setup.sh` と Chromium の準備が `runtime_setup` とデータ置き場を使い、`bin/` を呼ばないことのテストを書く in `plugins/pecot-visual/cli/tests/`
- [ ] T103 [US4] `plugins/pecot-visual/setup.sh` と Chromium の準備が `bin/` に頼る箇所を、`runtime_setup` のツールとデータ置き場に直す
- [ ] T104 [US4] `plugins/pecot-visual/bin/`・`runtime-lock.yaml`・`runtime-workspace.yaml`・`cli/tests/bootstrap/`・`test-bootstrap` のレーンを消し、参照を直す
- [ ] T105 [US4] リリースの版の書き換えを足し、`plugins/pecot-visual/scripts/release/tests/publish-mcp-dist.test.sh` を直す
- [ ] T106 [US4] スキル・`README.md` から、PATH のコマンドと `bin/` を前提にする箇所を消す in `plugins/pecot-visual/`
- [ ] T107 [US4] version plan を足す（pecot-visual はメジャー）
- [ ] T108 [US4] CUJ: プラグインを `.pecot/work/<Issue番号>/` に写し、`.mcp.json` を作業ツリーの build を `node` で起動する形にする。子の `claude -p --plugin-dir` でスライドを編集し、lint の結果が届くかを見る
- [ ] T109 [US4] CUJ: `claude plugin validate --strict` を通し、リポの外で Inspector の `--cli` で `tools/list` と `tools/call` が通ることを確かめる

---

## Phase 9: pecot-tools の bin/ と CLI の入口をなくす（US4, P1）

**Goal**: pecot-tools は直下に `bin/` を持たず、MCP は npm の版を起動する（FR-007〜FR-009）

**Independent Test**: `claude plugin validate --strict` が通り、Claude Code で pecot-tools の MCP のツールが今どおり動く

- [ ] T110 [US4] `.mcp.json` と `mcp.json` の形のテストを書く（`npx`・`--prefix` はデータ置き場・`@pecot/tools-mcp@<版>`） in `plugins/pecot-tools/cli/tests/`
- [ ] T111 [US4] `plugins/pecot-tools/.mcp.json` と `mcp.json` を、`npx` で npm の版を起動する形に直す
- [ ] T112 [US4] ツールをサーバに直に登録する形のテストを書き、CLI の入口が無いことを確かめる in `plugins/pecot-tools/cli/src/mcp/tests/`
- [ ] T113 [US4] `plugins/pecot-tools/cli/src/cli.ts` を消し、ツールをサーバに直に登録する。`cli/package.json` の `bin` をサーバの入口にする
- [ ] T114 [US4] `plugins/pecot-tools/setup.sh` を消す（`bin/pecot-tools` の起動を促すだけのため）。README などの参照も直す
- [ ] T115 [US4] `plugins/pecot-tools/bin/`・`runtime-lock.yaml`・`runtime-workspace.yaml`・`cli/tests/bootstrap/`・`test-bootstrap` のレーンを消し、参照を直す
- [ ] T116 [US4] リリースの版の書き換えを足し、`plugins/pecot-tools/scripts/release/tests/publish-mcp-dist.test.sh` を直す
- [ ] T117 [US4] `README.md` から、PATH のコマンドと `bin/` を前提にする箇所を消す in `plugins/pecot-tools/`
- [ ] T118 [US4] version plan を足す（pecot-tools はメジャー）
- [ ] T119 [US4] CUJ: `claude plugin validate --strict` を通し、子の Claude Code に入れてツールが動くことと、Inspector の `--cli` で作業ツリーの build を呼べることを確かめる

---

## Phase 10: pecot-workflow の計算のツールの形を決め、Issue のまとまりを作り替える（US6, P2）

**Goal**: Issue の起票・編集・コメント・前提を、計算は pecot-workflow のツール、読み書きは GitHub 公式の MCP で行う（FR-013〜FR-015・FR-019・FR-020）

**Independent Test**: sandbox で w-ready・w-quick を、作業ツリーの build を読ませたプラグインで流し、Issue の本文と欄が今の pecot-workflow のものと同じになる

### Tests for User Story 6（Issue）

- [ ] T120 [US6] 計算のツールの入出力の形を `plugins/pecot-workflow/interface/authored.yaml` に書く。入力は公式の MCP で読んだ結果の JSON、出力は書く中身と、書くのに使う公式の MCP のツールの名前
- [ ] T121 [P] [US6] `issue_create` の計算（テンプレートの検証・本文・ラベル・Issue type・fields・親・ボードの欄）のテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T122 [P] [US6] `issue_edit`・`issue_attributes` の計算のテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T123 [P] [US6] `issue_comment` の計算のテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T124 [P] [US6] `issue_check`・`issue_show` の判定（公式の MCP で読んだ Issue とボードから、着手できるかを返す）のテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T125 [P] [US6] `issue_block`・`issue_unblock` の計算（`issue_dependency_write` に渡す中身）のテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T126 [P] [US6] `issue_reopen` の計算（`issue_write` で開き直し、アーカイブした item を `projects_write` で戻す手順）のテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T127 [P] [US6] 計算のツールが `libs/workflow-core/src/infra/github/` と GitHub の client を import しないことのテストを書く（SC-005） in `plugins/pecot-workflow/cli/tests/`
- [ ] T128 [P] [US6] Issue のまとまりのスキルが、計算の結果をどの公式の MCP のツールで書くかを示し、ツールの基本の使い方を書かないことのテストを書く（FR-015） in `plugins/pecot-workflow/cli/tests/skills/`

### Implementation for User Story 6（Issue）

- [ ] T129 [US6] T121〜T126 の計算を `plugins/pecot-workflow/cli/src/commands/issue-*.ts` に書く。GitHub を呼ぶ部分を消す
- [ ] T130 [US6] 計算のツールを MCP のサーバに登録し、`authored.yaml` の項目と `generated.json` を合わせる
- [ ] T131 [US6] スキルが公式の MCP のツールを、つなぎ先の名前に頼らずツールの名前（`issue_write` など）で指す決まりと、つながっていない・読み取りだけのときの案内を `skills/w-help/SKILL.md` に書く
- [ ] T132 [US6] `w-ready`・`w-quick`・`w-backlog`・`w-issueize`・`w-breakdown` の Issue の手順を、計算のツール → 公式の MCP で書く形に直す in `plugins/pecot-workflow/skills/`
- [ ] T133 [US6] blocked-by の読み書きを Insiders の `issue_dependency_write`・`issue_dependency_read` で行う形に直す（FR-019）。名前か形が変わったら止める in `plugins/pecot-workflow/skills/`
- [ ] T134 [US6] version plan を足す
- [ ] T135 [US6] CUJ: T108 と同じく、プラグインを写して `.mcp.json` を作業ツリーの build にし、子の `claude -p --plugin-dir` で sandbox に w-ready・w-quick を流す。本文と欄を今のものと比べる

---

## Phase 11: ボード・セッション・PR・プロジェクトの設定・リリースのまとまりを作り替える（US6, P2）

**Goal**: 残りのまとまりも、計算は pecot-workflow のツール、読み書きは公式の MCP、手の無い操作は `pecot-github-ops.yml` で行う。pecot はブランチを消さない（FR-013〜FR-018・FR-020・FR-021）

**Independent Test**: sandbox の Issue 1 件を、作業ツリーの build を読ませたプラグインで w-active → w-pr → マージ待ちまで流し、本文・欄・Development 欄・blocked-by が今と同じで、利用者に頼む手作業が 0 件（SC-006・SC-008）

### Tests for User Story 6（ボード・セッション・PR・設定・リリース）

- [ ] T136 [P] [US6] `board_add`・`board_move`・`board_show` の計算（`projects_write` に渡す中身・ボードの読み取りからの判定）のテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T137 [P] [US6] `session_start`・`session_show` の計算（`create_branch`・`github-ops` の `link-branch`・ボードの移動）のテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T138 [P] [US6] `session_finish` の計算（閉じる `state_reason`・手元の片付け。リモートのブランチを消さない）のテストを書く in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T139 [P] [US6] `pr_create`・`pr_restack`・`pr_check`・`pr_show` の計算のテストを書く（本文・`stack-register`・`reviewers`・`update_pull_request_branch`） in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T140 [P] [US6] `pr_merge` の計算のテストを書く（sandbox で画面のマージを再現する `merge-async`。マージは利用者が画面で行う） in `plugins/pecot-workflow/cli/src/commands/tests/`
- [ ] T141 [P] [US6] `project_create`・`project_init`・`project_link`・`project_get`・`project_set`・`project_activate`・`project_list`・`project_search`・`project_unset` の計算のテストを書く（`create_project`・`owner-type`・`project-fields`・`project-link`）
- [ ] T142 [P] [US6] `release_check`・`release_create`・`release_merge` の計算のテストを書く（`list_releases`・`list_tags`・`list_commits`・`release-create`。ブランチを消さない）
- [ ] T143 [P] [US6] このまとまりのスキルが、公式の MCP のツールと `pecot-github-ops.yml` の起動をどの場面で使うかを示し、利用者に起動を頼まないことのテストを書く in `plugins/pecot-workflow/cli/tests/skills/`

### Implementation for User Story 6（ボード・セッション・PR・設定・リリース）

- [ ] T144 [US6] T136〜T142 の計算を `plugins/pecot-workflow/cli/src/commands/` の各ファイルに書き、GitHub を呼ぶ部分を消す。MCP の登録と `authored.yaml` を合わせる
- [ ] T145 [US6] `branch_delete` のツールと、`session_finish`・`release_merge` のリモートのブランチを消す道を消す（FR-018）
- [ ] T146 [US6] `w-onboarding` と `plugins/pecot-workflow/CONTRIBUTING.md` に、リポの「head ブランチを自動で消す」設定が有効かを確かめる手順を足す（FR-018）
- [ ] T147 [US6] `w-active`・`w-pr`・`w-merge`・`w-onboarding`・`w-repo-add` の手順を、計算 → 公式の MCP で書く、手の無い操作は `pecot-github-ops.yml` を起動して結果を読む形に直す
- [ ] T148 [US6] `w-release` を、利用者に頼まれたらエージェントがリリースのワークフローを起動する形に直す（FR-017） in `plugins/pecot-workflow/skills/w-release/SKILL.md`
- [ ] T149 [US6] ワークフローが失敗するか終わらないときに止まり、実行の URL を示す手順と、5xx の後に書いたものを読んで確かめてからやり直す手順をスキルに書く
- [ ] T150 [US6] version plan を足す（ツールの入出力が変わるのでメジャー）
- [ ] T151 [US6] CUJ: T135 と同じ形で、sandbox の Issue を w-active → 実装 → w-pr → マージ待ちまで流し、今のものと比べる。クラウドのスレッドでの確かめは T176 で行う

---

## Phase 12: スキルが呼ばなくなった GitHub の I/O を消し、試験環境をクラウドから扱えるようにする（US6, P2）

**Goal**: pecot-workflow のプラグインから GitHub を直に呼ぶコードを無くし、試験環境の手順をクラウドのスレッドから行えるようにする（FR-014・FR-022・SC-005）

**Independent Test**: pecot-workflow のツールに GitHub を直に呼ぶものが 0 件で、クラウドのスレッドから sandbox を揃えて片付けられる

- [ ] T152 [US6] pecot-workflow の `cli/` から `libs/workflow-core/src/infra/github/` を import しないことを、`plugins/pecot-workflow/cli/eslint.config.js` の決まりで止める
- [ ] T153 [US6] スキルが呼ばなくなった GitHub の I/O（`cli/src/commands/github-client.ts` など）と、それだけが使うテストの部品（`cli/tests/fake-github/` など）を消し、knip を通す
- [ ] T154 [US6] `plugins/pecot-workflow/CONTRIBUTING.md` の「3. 試験環境」の揃える・片付ける手順を、公式の MCP と `pecot-github-ops.yml` で行う形に書き換える（FR-022）
- [ ] T155 [US6] version plan を足す
- [ ] T156 [US6] `specs/031-pecot-coordinator/verification/feature-inventory.md` の一覧と、作り替えた後のツール・action を突き合わせ、使えなくなった機能が 0 件（ブランチの削除を除く）かを書く（SC-007）
- [ ] T157 [US6] CUJ: クラウドのスレッドから、CONTRIBUTING の手順で sandbox を揃え、題の形で見分けて片付ける

---

## Phase 13: pecot-coordinator のプラグインと coordinator のスキルを作る（US7, P2）

**Goal**: coordinator の判断と手順を持つスキルだけのプラグインを作る（FR-023〜FR-028）

**Independent Test**: 子の Claude Code に `--plugin-dir` で入れると `c-coordinate` が読まれ、`test-skills` が通る

### Tests for User Story 7

- [ ] T158 [US7] `plugins/pecot-coordinator/` の nx project を作る（`project.json`・`package.json`・`vitest.config.ts`・`CHANGELOG.md`・`.claude-plugin/plugin.json`・`plugin.json`）。`CLAUDE.md` の表に足す
- [ ] T159 [P] [US7] スキルの形のテストを書く（frontmatter の `name`・`description`・XML のタグが無い・参照の切れが無い） in `plugins/pecot-coordinator/tests/skills/`
- [ ] T160 [P] [US7] スキルに固有の値（Phase 1 の値の一覧にある、このリポの名前・wt の名前・sandbox の名前など）が無いことのテストを書く。探す語は、`specs/031-pecot-coordinator/verification/project-instructions.md` の「数え」の節で原文から拾った語も含める in `plugins/pecot-coordinator/tests/skills/`
- [ ] T161 [P] [US7] プラグインがスキルとマニフェストだけを持ち、MCP のサーバと `bin/` を持たないことのテストを書く（FR-023） in `plugins/pecot-coordinator/tests/`

### Implementation for User Story 7

- [ ] T162 [US7] `plugins/pecot-coordinator/skills/c-coordinate/SKILL.md` に、Phase 1 で「スキルへ移す」とした判断と手順を書く
- [ ] T163 [US7] `c-coordinate` に、値をプロジェクト指示から名前で読む手順と、値が無いときに推測せず書くよう案内する手順を書く（FR-025）
- [ ] T164 [US7] `c-coordinate` に、Actions のプロジェクトが利用者のリポに入っていないときの案内（FR-010）と、claude.ai に入れたプラグインの版とリポの最新の版のずれを利用者に伝える手順を書く
- [ ] T165 [US7] `c-coordinate` に、RC の wt とクラウドのスレッドを作業場所として扱い、同じ Issue を 2 か所に割り振らない手順を書く（FR-027）。クラウドのスレッドは pecot-workflow のスキルで進める（FR-028）
- [ ] T166 [US7] `c-coordinate` に、スキルとプロジェクト指示が食い違うときはプロジェクト指示を優先し、食い違いを利用者に伝える手順を書く
- [ ] T180 [US7] Phase 1 で pecot-w のスキルに「未記載」とした文（`specs/031-pecot-coordinator/verification/project-instructions.md` の 13・14）を書く。
  承認を求めるときに続け方で auto を選ぶよう添えることと、実装の後に w-pr へ進むことを、`plugins/pecot-workflow/skills/w-active/SKILL.md` の Step 10・Step 11 に書く。
  pecot-workflow の version plan を足す
- [ ] T167 [US7] `plugins/pecot-coordinator/interface/authored.yaml` にスキルの項目を書き、テストの `verifies` と合わせる
- [ ] T168 [US7] `plugins/pecot-coordinator/README.md` に、入れ方と、プロジェクト指示に書く値の一覧と例を書く（FR-026）
- [ ] T169 [US7] `.claude-plugin/marketplace.json` に `pecot-c` を足し、`nx.json` の release と `claude plugin validate --strict` の対象に入れる
- [ ] T170 [US7] version plan を足す（pecot-coordinator は最初の版）
- [ ] T171 [US7] CUJ: 子の Claude Code に `--plugin-dir` で入れ、`c-coordinate` が読まれることを確かめる

---

## Phase 14: クラウドのスレッドで流れを確かめ、このリポのプロジェクト指示を書き直す（US8, P3）

**Goal**: claude.ai に入れたプラグインで、coordinator とクラウドのスレッドが pecot の流れを最後まで進め、このリポのプロジェクト指示が固有の値だけになる（SC-003・SC-009〜SC-012）

**Independent Test**: coordinator が起動したクラウドのスレッドが、pecot-workflow を直す Issue を着手から PR のマージ待ちまで進め、sandbox への確かめを VM の中から流す

- [ ] T172 [US8] 利用者に、4 つのプラグインと `actions` のリリースを頼む。エージェントがリリースのワークフローを起動する
- [ ] T173 [US8] 利用者に claude.ai の Add marketplace で 4 つのプラグインを入れてもらい、拒まれたものが 0 件かを `specs/031-pecot-coordinator/verification/cloud-flow.md` に書く（SC-003）
- [ ] T174 [US8] このリポのプロジェクト指示を、Phase 1 の値の一覧の形で書き直した案を `specs/031-pecot-coordinator/verification/cloud-flow.md` に書き、利用者に claude.ai の設定へ貼ってもらう
- [ ] T175 [US8] 書き直したプロジェクト指示で coordinator に割り振りを頼み、書き直す前と同じ判断になるかと、利用者が答えた質問の数を書く（SC-011・SC-012）
- [ ] T176 [US8] coordinator が起動したクラウドのスレッドに pecot-workflow を直す Issue を進めさせ、着手から PR のマージ待ちまでの流れを書く。本文・欄・Development 欄・blocked-by を、手元のスレッドで流したものと比べる（SC-006）
- [ ] T177 [US8] そのスレッドで、sandbox への確かめを VM の中から最後まで流し、結果を書く（SC-010）
- [ ] T178 [US8] 利用者に、sandbox を扱う claude.ai のプロジェクトを作ってもらう。手順は画面の場所とボタンの名前まで書いて渡す
- [ ] T179 [US8] このリポ以外のプロジェクト（sandbox のプロジェクト）で、プラグインと値だけのプロジェクト指示で US7 の確かめを流し、結果を書く（SC-009）

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 5 | 4 | スタック可 | Phase 5 の action が、Phase 4 で切り出した `libs/workflow-core` を呼ぶ |
| 6 | 2 | スタック可 | `github-ops` の operation と token が、Phase 2 の記録で決まる |
| 6 | 5 | スタック可 | `github-ops` を、Phase 5 で作る `actions/` の project と build の形に足す。sandbox の雛形は、確かめるブランチの ref を `uses:` で指せる |
| 7 | 5 | スタック可 | Phase 5 で、Actions だけの処理と、それを `bin/pecot` で呼ぶワークフローが無くなってから `bin/` を消す |
| 7 | 3 | スタック可 | MCP を npx で npm の版から起動する形が、Phase 3 のクラウドの VM での確かめの記録で決まる |
| 8 | 3 | スタック可 | 同じく、Phase 3 の記録で npx の起動の形が決まる |
| 9 | 3 | スタック可 | 同じく、Phase 3 の記録で npx の起動の形が決まる |
| 10 | 2 | スタック可 | 計算のツールの出力の形が、Phase 2 で書けると分かった公式の MCP の手で決まる |
| 10 | 7 | スタック可 | 計算のツールを、Phase 7 で直したツールを直に登録するサーバに足す |
| 11 | 6 | スタック可 | 手の無い操作を、Phase 6 の `pecot-github-ops.yml` で行う。sandbox の雛形は、確かめるブランチの ref を `uses:` で指せる |
| 11 | 10 | スタック可 | Phase 10 で決めた計算のツールの形で、残りのまとまりを作り替える |
| 12 | 11 | スタック可 | スキルが呼ばなくなる GitHub の I/O は、Phase 11 の作り替えで決まる |
| 13 | 1 | スタック可 | スキルに書く判断と手順が、Phase 1 の振り分けで決まる |
| 13 | 3 | スタック可 | プラグインの形が、Phase 3 の配布の記録で決まる |
| 14 | 8 | スタック不可 | claude.ai の Add marketplace は既定のブランチのプラグインを入れる。`bin/` を消した pecot-visual が既定のブランチに無いと、SC-003 を確かめられない |
| 14 | 9 | スタック不可 | 同じく、`bin/` を消した pecot-tools が既定のブランチに無いと、SC-003 を確かめられない |
| 14 | 12 | スタック不可 | クラウドのスレッドは既定のブランチから配られた pecot-workflow を読み、MCP は npm に公開した版を起動する。Phase 12 までがリリースされていないと流れを確かめられない |
| 14 | 13 | スタック不可 | coordinator が読む pecot-coordinator は、claude.ai に入れた marketplace の既定のブランチから配られる |

### User Story Dependencies

- US1・US2・US3（Phase 1〜3）は検証で、ほかに頼らない。結果で後続のフェーズの形を見直す
- US5（Phase 5）は Phase 4 の土台に頼る
- US4（Phase 7〜9）は、どれも US3 の記録に頼る。pecot-workflow だけは、US5 にも頼る
- US6（Phase 6・10〜12）は US2・US5・US4 の pecot-workflow に頼る
- US7（Phase 13）は US1・US3 に頼る
- US8（Phase 14）は、ほかのすべてが既定のブランチに入り、リリースされてから始める

### Within Each User Story

- テストを書いて Red を確かめてから実装する
- `authored.yaml` の項目とテストの `verifies` を同じ変更で合わせる
- CUJ はフェーズの最後に流す

### Parallel Opportunities

- Phase 1・2・3・4 は、前提が無いので並べて始められる。Phase 8・9 は、Phase 3 の記録ができれば始められる
- 各フェーズの [P] のテストは、ほかのファイルを触るので並べて書ける
- Phase 13 は、Phase 1・3 が済めば Phase 5〜12 と並べて進められる

---

## Parallel Example: User Story 5

```text
T041 actions/tests/board-sync.test.ts
T042 actions/tests/session-finish.test.ts
T043 actions/tests/tracker-sync.test.ts
T044 actions/tests/review-finish.test.ts
T045 actions/tests/auto.test.ts
```

---

## Implementation Strategy

### 検証を先に（Phase 1〜3）

1. Phase 1〜3 を済ませ、記録で plan と後続のフェーズの形を見直す
2. 形が変わるなら、後続のフェーズの Issue を直してから着手する

### 少しずつ届ける

1. Phase 4 → 5 → 6 で、`actions/` を入れて Actions の処理を移す
2. Phase 7〜9 で、3 つのプラグインを claude.ai に載る形にする
3. Phase 10 → 11 → 12 で、スレッドの GitHub の読み書きを公式の MCP に移す
4. Phase 13 で pecot-coordinator を作り、Phase 14 で全体を確かめる

---

## Notes

- 確かめで作った sandbox のものは、CONTRIBUTING の手順で片付ける
- フェーズの記録で後続の形が変わったら、tasks.md ではなく後続のフェーズの Issue を直す
