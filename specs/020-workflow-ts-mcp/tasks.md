---

description: "pecot-workflow の TypeScript 化と MCP 化（再設計）のタスク一覧"
---

# Tasks: pecot-workflow の TypeScript 化と MCP 化（再設計）

**Input**: `specs/020-workflow-ts-mcp/` の設計文書（2026-11-11 に作り直した）

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、contracts/、quickstart.md

**Tests**: 憲法 II（TDD）を守る。テストを先に書き、失敗を確かめてから実装する。
コマンドの移植では、済みの前後比較のシナリオと、定義書の振る舞いの項目を先行のテストとして使う。
モックは I/O 境界だけに使う。I/O 境界とは、偽の GitHub サーバ、一時 git リポ、shell の子プロセスを指す。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの番号は plan.md の「フェーズ」と同じ。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US5） |

パスは `plugins/pecot-workflow/` 起点で書く。例は `cli/`・`cli-node/`・`hooks/`・`skills/`・`bin/`・`interface/`・`project.json`。

`plugins/pecot-tools/`・`plugins/pecot-visual/`・`libs/`・`.github/`・`.nx/`・`nx.json`・`CLAUDE.md` などは、リポ root 起点で書く。

## 全フェーズに共通の完了条件

- pre-commit と pre-push を `--no-verify` なしで通す
- pecot-workflow の version plan を `.nx/version-plans/` に足す。CHANGELOG は手で編集しない
- 新しい識別子・ファイル名・テストの値に、ベンダー名とブランドの語を含めない
- `cli-node/vitest.config.ts` のカバレッジの閾値を下げない
- フェーズ 11 より前は、配布物の振る舞いを変えない（spec FR-014）
- フェーズ 11 より前は、`interface/generated.json` を Node から書かない（spec FR-020）
- `interface/authored.yaml` の項目の ID と文を変えない（spec FR-022）

## コマンドを移すフェーズ（2〜6）に共通の完了条件

- 該当の前後比較のシナリオが、`cli-node/tests/parity/parity.test.ts` で golden と一致する。golden は書き換えない
- `cli-node/scripts/export-interface.ts --check` の差が 0 件（contracts/interface.md）
- 移したコマンドの振る舞いの項目が、全部 vitest のケースにつながる。ケースの最初で `verifies(context, 'PW-…')` を呼ぶ
- 項目のケースの期待値は、項目の文と、今つながっている pytest のケースから取る。`tests/parity/` の下には ID を書かない
- 出力は `createOutput`（`cli-node/src/commands/output.ts`）を通す。`tests/direct-output-lint.test.ts` が通る
- 項目のケースは、移植と同じ変更で書く。先に書いて失敗を確かめてもよく、順は問わない（憲章 II）
- pytest の側のつなぎ（`@add_test_properties(verifies=[...])`）は消さない

---

## Phase 1: 準備（golden の差、依存の停止、定義書との比較）

**Purpose**: 移植の基準を今の Python にそろえる。移行中に基準が動かないようにする。定義書と比べる仕組みを、最初のコマンドを移す前に入れる

- [ ] T001 `cli/` で `uv sync` を実行し、`cli-node/` で `record:parity:check` を流す。差が research.md の R-0 の 5 件であることを確かめる。結果を `.pecot/work/<Issue番号>/` に残す。
- [ ] T002 T001 の 5 件の原因を調べる。この 1 回は、Python を変えない PR で記録し直してよい（spec FR-007 の例外）。Python の出力が変わっていたなら、その 5 件だけを `record:parity <id>...` で記録し直す。
  実行する環境で変わる値なら、`cli-node/tests/parity/run.ts` の置き換えの規則に足す。どちらの場合も、`record:parity:check` の差を 0 にする。
- [ ] T003 [P] `.github/dependabot.yml` の uv のエントリに `open-pull-requests-limit: 0` を付ける。対象は `/plugins/pecot-workflow/cli` である。理由を同じファイルの 1 行のコメントに書く（research R-15）。
- [ ] T004 `cli-node/tests/interface-export.test.ts` に `--check` のテストを先に書く。見本のコマンド定義を `main` に渡して確かめる。
  確かめるのは contracts/interface.md の「切り替えの前」の列の 5 行である。差があるときは、標準エラーに項目の ID と欄が出ることも確かめる。
- [ ] T005 `cli-node/scripts/export-interface.ts` に `--check` を実装する。比べ方は `libs/interface-spec/src/domain/diff.ts` の `diffGenerated`・`formatStale` を使う。
  `libs/interface-spec` は、`cli-node/eslint.config.js` の `describe-title` と同じく相対パスで import する。項目と欄を絞る機能が足りなければ、`libs/interface-spec` の側に足し、そのテストも足す。`--write` は使い方のエラー（終了コード 2）にする。
- [ ] T006 同じ `interface-export.test.ts` に、移したコマンドの項目のつなぎの確認を足す。決めは contracts/interface.md の「移したコマンドの項目のつなぎ」にある。
  登録が 0 件の間は、共通の項目 `PW-COMMON` だけを確かめる。見本のコマンドと見本の ID で、無い ID を並べて失敗することを確かめる。
- [ ] T007 `project.json` の `test-cli` の inputs に、`interface/generated.json` と `interface/authored.yaml` を足す。T005 で `libs/interface-spec` を読むなら、そのパスも足す。
- [ ] T008 共通の項目 `PW-COMMON` の 17 個を、`cli-node/tests/commands/common.test.ts` のケースにつなぐ。対象は `cli-node/src/cli.ts` のグローバルオプションと例外の扱いである。
  コマンドの要る項目は、見本のコマンド定義を `COMMANDS` の代わりに渡して確かめる。Python と違う振る舞いがあれば、`cli.ts` の側を直す。

**Checkpoint**: `record:parity:check` の差が 0。dependabot は uv の版の更新の PR を出さない。`--check` が登録 0 件で通る。共通の項目 17 個が vitest につながる

---

## Phase 2: User Story 1 — project とグループ無しのコマンドを移す (Priority: P1)

**Goal**: project の 10 個とグループ無しの 4 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の該当シナリオが golden と一致する。該当は `project-*`・`add-to-project-*`・`update-issue-status-*`・`create-branch-*`・`delete-branch-*`・`global-*` の 6 種。
`--check` が 14 項目で差 0。振る舞いの項目 157 個が vitest につながる

- [ ] T009 [P] [US1] `cli/commands/project.py` を `cli-node/src/commands/project.ts` に移す。`registry.ts` の `COMMANDS` に 10 個を足す。
- [ ] T010 [P] [US1] `cli/commands/main.py` の 4 個を `cli-node/src/commands/top.ts` に移し、`COMMANDS` に足す。4 個は `add-to-project`・`update-issue-status`・`create-branch`・`delete-branch` である。
- [ ] T011 [US1] rich の表の整形を、golden と文字単位で一致させる。直す先は `cli-node/src/domain/format.ts` と `src/commands/cell-table.ts` である。
- [ ] T012 [US1] project の項目 82 個とグループ無しの 4 個の項目 75 個を、vitest のケースにつなぐ。置き場は `cli-node/tests/commands/project.test.ts` と `top.test.ts` である。
- [ ] T013 [US1] `export-interface.ts --check` を流し、14 項目の `input` と `cli` の差を 0 にする。差があれば `project.ts` と `top.ts` のコマンド定義を直す。

**Checkpoint**: 該当シナリオが全部一致する。`--check` の差が 0。該当の項目が全部つながる

---

## Phase 3: User Story 1 — issue と session のコマンドを移す (Priority: P1)

**Goal**: issue の 5 個と session の 2 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の `issue-*`・`session-*` のシナリオが golden と一致する。`--check` が 7 項目で差 0。振る舞いの項目 181 個が vitest につながる

- [ ] T014 [P] [US1] `cli/commands/issue.py` を `cli-node/src/commands/issue.ts` に移し、`COMMANDS` に 5 個を足す。`--prepare` の下書きを含める。実投稿の成功時にスラッシュコマンドのフラグを消す処理も含める。
- [ ] T015 [P] [US1] `cli/commands/session.py` を `cli-node/src/commands/session.ts` に移し、`COMMANDS` に 2 個を足す。
- [ ] T016 [US1] Python が書いた状態を Node が読むシナリオ（`*-python-state`）が、issue と session で一致することを確かめる。食い違えば `cli-node/src/infra/state-store.ts` と `config-store.ts` を直す。
- [ ] T017 [US1] issue の項目 138 個と session の項目 43 個を、vitest のケースにつなぐ。置き場は `cli-node/tests/commands/issue.test.ts` と `session.test.ts` である。
- [ ] T018 [US1] `export-interface.ts --check` を流し、7 項目の `input` と `cli` の差を 0 にする。

**Checkpoint**: 該当シナリオが全部一致する。`--check` の差が 0。該当の項目が全部つながる

---

## Phase 4: User Story 1 — pr のコマンドを移す (Priority: P1)

**Goal**: pr の 4 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の `pr-*` のシナリオが golden と一致する。`--check` が 4 項目で差 0。振る舞いの項目 107 個が vitest につながる

- [ ] T019 [US1] `cli/commands/pr.py` の `create` と `read` を `cli-node/src/commands/pr.ts` に移し、`COMMANDS` に足す。`--prepare` と `--dry-run` を含める。
- [ ] T020 [US1] `pr.py` の `preflight` と `cleanup` を同じ `pr.ts` に移し、`COMMANDS` に足す。git の呼び出しは `src/infra/git.ts` を通す。
- [ ] T021 [US1] pr の項目 107 個を、`cli-node/tests/commands/pr.test.ts` のケースにつなぐ。
- [ ] T022 [US1] `export-interface.ts --check` を流し、4 項目の `input` と `cli` の差を 0 にする。

**Checkpoint**: 該当シナリオが全部一致する。`--check` の差が 0。該当の項目が全部つながる

---

## Phase 5: User Story 1 — worktree と release のコマンドを移す (Priority: P1)

**Goal**: worktree の 4 個と release の 3 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の `worktree-*`・`release-*` のシナリオが golden と一致する。`--check` が 7 項目で差 0。振る舞いの項目 217 個が vitest につながる

- [ ] T023 [P] [US1] `cli/commands/worktree.py` を `cli-node/src/commands/worktree.ts` に移し、`COMMANDS` に 4 個を足す。`worktree link` は `interactive: true` にする。CLI の上書き確認は今の対話のまま残す。
- [ ] T024 [P] [US1] `cli/commands/release.py` を `cli-node/src/commands/release.ts` に移し、`COMMANDS` に 3 個を足す。
- [ ] T025 [US1] worktree の項目 129 個と release の項目 88 個を、vitest のケースにつなぐ。置き場は `cli-node/tests/commands/worktree.test.ts` と `release.test.ts` である。
- [ ] T026 [US1] `export-interface.ts --check` を流し、7 項目の `input` と `cli` の差を 0 にする。

**Checkpoint**: 該当シナリオが全部一致する。`--check` の差が 0。該当の項目が全部つながる

---

## Phase 6: User Story 1 — security-sync と dependabot-sync を移し、34 個をそろえる (Priority: P1)

**Goal**: 同期の 2 個が Node で動き、registry が 34 個になる

**Independent Test**: `parity.test.ts` の全件が一致する。registry の数が 34。`--check` が 34 項目で差 0（SC-010）。振る舞いの項目 769 個が全部 vitest につながる

- [ ] T027 [P] [US1] `cli/commands/security.py` を `cli-node/src/commands/security.ts` に移す。`COMMANDS` に `security-sync` を足す。`_tracker_sync.py` と `cli/core/security_alerts.py` の要る分も移す。
- [ ] T028 [P] [US1] `cli/commands/dependabot.py` を `cli-node/src/commands/dependabot.ts` に移す。`COMMANDS` に `dependabot-sync` を足す。`cli/core/dependabot_prs.py` の要る分も移す。
- [ ] T029 [US1] 同期の 2 個の項目 90 個を、vitest のケースにつなぐ。置き場は `cli-node/tests/commands/security.test.ts` と `dependabot.test.ts` である。
- [ ] T030 [US1] `cli-node/src/commands/tests/registry.test.ts` にテストを足す。`COMMANDS` が 34 個であることと、ID が `interface/generated.json` の項目の ID と同じ集合であることを確かめる。
- [ ] T031 [US1] `export-interface.ts --check` を 34 個がそろった状態で流し、差が 0 件であることを確かめる。項目のつなぎの確認が 769 個で通ることも確かめる。
- [ ] T032 [US1] `project info` の起動から結果までを、Python と Node で 5 回ずつ計る。中央値を `.pecot/work/<Issue番号>/` に記録する。Node が Python 以下であることを確かめる（SC-009）。

**Checkpoint**: 全件が一致し、registry が 34 個。`--check` が 34 項目で差 0。配布物は Python のまま

---

## Phase 7: User Story 2 — MCP サーバ (Priority: P2)

**Goal**: registry から 34 個の MCP ツールを公開する。プラグインにはまだ登録しない

**Independent Test**: `tools/list` が 34 個で定義書と一致する。MCP 経由でも前後比較の全件が golden と一致する

- [ ] T033 [US2] `cli-node/package.json` に `@modelcontextprotocol/server` を足す。devDependencies には `@modelcontextprotocol/client` を足す。版は `plugins/pecot-tools/cli/package.json` と同じにする。
- [ ] T034 [US2] `cli-node/tests/mcp/tools-list.test.ts` を先に書く。ツールの数と名前が registry と一致することを確かめる。
  各ツールの入力が、`interface/generated.json` の同じ項目の `input` に `repo` を足したものと一致することも確かめる。
- [ ] T035 [US2] `cli-node/src/mcp/server.ts`・`serve.ts`・`result.ts` を作り、`COMMANDS` からツールを登録する。結果の形は data-model.md の ToolResult に従う。`content[0].text` は stdout、`isError` は `exitCode !== 0` とする。
- [ ] T036 [US2] `worktree_link` は入力 `overwrite` で受ける。既定は false で、false なら上書きせず、対象を一覧で返す。置き場は T035 と同じ `src/mcp/` である。
- [ ] T037 [US2] `cli-node/src/cli.ts` に `mcp` サブコマンドを足し、stdio で MCP サーバを起動する。`mcp` はツールにしない。
- [ ] T038 [US2] `cli-node/tests/parity/parity.test.ts` に MCP 経由の起動を足す。各シナリオのツールを `@modelcontextprotocol/client` で呼び、stdout と終了コードを golden と比べる。時間のかかる `release_*` も完了まで待つ。

**Checkpoint**: MCP 経由でも全件が一致する。プラグインの `.mcp.json` は変えていない

---

## Phase 8: User Story 3 — hooks のガード (Priority: P3)

**Goal**: 投稿の ask を MCP ツールで判定する。Bash の `pecot` の deny の判定を用意する。どちらも、配布物の振る舞いはまだ変えない

**Independent Test**: 今の確認・阻止の条件が、MCP の入力 JSON で同じ判定と文言になる。2 つのクライアントの名前の形で通る

- [ ] T039 [P] [US3] `cli-node/tests/hooks/pecot-post-ask.test.ts` を先に書く。contracts/hooks-guard.md の「投稿の ask」の全行を、2 つのクライアントの名前で流す。文言は今の `pecot-issue-create-ask`・`pecot-pr-create-ask` と一致させる。
- [ ] T040 [US3] `hooks/lib/mcp-handlers/pecot-post-ask.sh` を作る。
  `PECOT_HOOK_TOOL_NAME` から `<tool>` を取り出し、`tool_input` を jq で読む。`mcp-dispatcher.sh` からは、`pr-create-block.sh` の後、`context7-allow.sh` の前に呼ぶ。
- [ ] T041 [P] [US3] `cli-node/tests/hooks/pecot-cli-deny.test.ts` を先に書く。34 サブコマンドの起動形のそれぞれで deny になり、理由に対応するツール名が入ることを確かめる。起動形は contracts/hooks-guard.md の表にある。
- [ ] T042 [US3] `hooks/lib/core/pecot-cli-deny.sh` を作る。セグメントの分け方と起動形の見つけ方は、`external-post-check.sh` の処理を使う。サブコマンド別の許可・阻止は持たない。`pre-tool-use-bash.sh` からはまだ呼ばない。
- [ ] T043 [P] [US3] 案内文の移行後の文を用意し、テストで固定する。対象は `gh-command-check.sh`、`pecot-issue-pending-reminder.sh`、`plan-issue-poster.sh` の失敗時の案内である。差し替えはフェーズ 11 で行う。

**Checkpoint**: 新しい判定のテストが通る。今の Bash の判定と案内文は変わっていない

---

## Phase 9: User Story 3 — Copilot CLI でのツール名を実物で確かめる (Priority: P3)

**Goal**: Copilot CLI が MCP ツールに付ける名前と hooks の入力を実物で採る。research R-5 の推定を確かめる

**Independent Test**: 実物のツール名が contracts/hooks-guard.md の形と一致する。違えば、直した後に T039 のテストが通る

- [ ] T044 [US3] 開発用の登録で、GitHub Copilot CLI から MCP サーバを起動する。登録には作業ツリーの `bin/pecot` と `PECOT_BOOTSTRAP_SKIP=1` を使う。`project_info` を呼び、PreToolUse の hooks が受ける JSON を `.pecot/work/<Issue番号>/` に保存する。
- [ ] T045 [US3] T044 の名前が `pecot-workflow-<tool>` と違えば、`pecot-post-ask.sh` の取り出しを直す。contracts/hooks-guard.md、data-model.md、T039 のテストの名前も直す。同じなら、確かめた日付と Copilot CLI の版を research.md の R-5 に書く。

**Checkpoint**: Copilot CLI の名前の形が確定している

---

## Phase 10: User Story 4 — hooks のテストを vitest に移す (Priority: P4)

**Goal**: hooks の pytest を vitest の `hooks` project に移す

**Independent Test**: vitest の件数が 1,569 以上。起動スクリプトの一覧が `baseline.json` の `hooks.scripts` を全部含む

- [ ] T046 [P] [US4] `hooks/tests/` の pytest（27 ファイル）を、vitest で `cli-node/tests/hooks/` に移す。
  shell は `child_process.spawnSync` で起動し、stdin・env・終了コード・stdout を確かめる。今の pass 2 の条件（空の設定と `GIT_DIR` の export）も残す。
- [ ] T047 [P] [US4] `hooks/lib/tests/` の pytest（35 ファイル）を、同じ方法で移す。
- [ ] T048 [US4] `cli-node/tests/hooks/baseline-scripts.test.ts` に、件数が `hooks.testCount` 以上であることの確認を足す。
  `test-hooks` レーンは、移行中は pytest と vitest の両方を流す。直す先は `project.json` と `scripts/ci/run-tests.sh` である。

**Checkpoint**: vitest だけで hooks の全ケースが流れる。pytest もまだ残っている

---

## Phase 11: 切り替え — Node・MCP・Agent Plugins 1.0・定義書の元を 1 回で切り替える (Priority: P2〜P4)

**Goal**: スキル・hooks・CLI・manifest・定義書の書き出しの元をそろえて切り替える。利用者に届く振る舞いを変えるのは、この PR だけ

**Independent Test**: エージェントに Bash で `pecot` を呼ばせる記述が 0 件。`interface/generated.json` の差分が各項目の `surfaces.mcp` だけ。
Claude Code と GitHub Copilot CLI で quickstart.md の CUJ 1〜7 と 9 が通る

- [ ] T049 [P] [US2] `cli-node/tests/skills/tool-names.test.ts` を先に書く。本文にある MCP ツール名が全部 `COMMANDS` にあることを確かめる。対象はスキル・agents・hooks テンプレートである。
  `pecot <サブコマンド>` の残りが、テストの持つ一覧と同じであることも確かめる。一覧に載せるのは、利用者が端末で打つコマンドの説明だけである（research R-19）。
- [ ] T050 [P] [US2] `test-skills` レーンを vitest に替える。`skills/w-onboarding/scripts/tests/` の pytest も vitest に移す。直す先は `project.json` と `scripts/ci/run-tests.sh` である。
- [ ] T051 [US2] スキルなどの `pecot <サブコマンド>` を、MCP ツールの呼び出しに書き換える。対象は 27 ファイル 197 箇所のうち、エージェントに実行させる記述である。コードブロックの外でも、手順として実行を指示する文は対象にする。
  内訳は `skills/*/SKILL.md` 15 ファイル、`skills/*/references/` 11 ファイル、`hooks/templates/` 1 ファイルである。`skills/w-help/references/commands.md` は手で直さない。
- [ ] T052 [US3] `hooks/pre-tool-use-bash.sh` から `lib/core/pecot-cli-deny.sh` を呼ぶ。`lib/core/external-post-check.sh` の pecot の判定を外し、`gh pr merge` の ask だけを残す。案内文を T043 の文に差し替え、テストを同じ変更に合わせる。
- [ ] T053 [US1] `bin/_lib.sh` に、pecot-tools の `bin/_lib.sh` から `plugin_runtime_*` と Node の下限の確認を写す。`bin/pecot` は実行用ミラー方式に書き換える。`PECOT_BOOTSTRAP_SKIP=1` は `cli-node/dist/cli.js` を直接起動する。
- [ ] T054 [US1] 初回起動で `${DATA}/venv/` を消す処理を `bin/pecot` に入れる。`.inuse` のロックを持つ世代は、次回の起動で消す。
- [ ] T055 [P] [US1] `plugins/pecot-tools/cli/tests/bootstrap/` から 3 本を `cli-node/tests/bootstrap/` に写す。
  3 本は `data-dir.sh`・`run.sh`・`stub-root.sh`。Python と uv の無い `PATH` で、初回起動がミラーを作ることを確かめる。古い venv が消えることと、Node が無いと理由を返して止まることも確かめる。
- [ ] T056 [US2] `.mcp.json` に `pecot-workflow` を足す。`command` は `${CLAUDE_PLUGIN_ROOT}/bin/pecot`、`args` は `["mcp"]` である。context7 は残し、`env` は書かない。
- [ ] T057 [US2] root に `plugin.json` と `mcp.json` を置く。`plugin.json` は `$schema` 1.0.0、name `pecot-w` である。`mcp.json` は `pecot-workflow` と context7 を持つ。
- [ ] T058 [US2] `hooks/hooks-copilot.json` を `com.github.copilot/hooks/hooks.json` に移す。matcher に `pecot-workflow-.*` を足す。
  agents を `com.github.copilot/agents/` に置く。`.github/plugin/plugin.json` と `hooks/hooks-copilot.json` を消す。
- [ ] T059 [US2] `cli-node/tests/bootstrap/manifest.sh` を作る。中身は `plugins/pecot-visual/cli/tests/bootstrap/manifest.sh` と同じ確認にする。両形式の name・version・MCP サーバと args の一致を固定する。
- [ ] T060 [US2] `project.json` の `release.version.manifestRootsToUpdate` を直す。`.github/plugin` を `{projectRoot}` に替える。`.nx/nx-release/src/version-actions.js` とそのテストの、旧形式の参照も直す。
- [ ] T061 [US1] `cli-node/scripts/export-interface.ts` に `--write` を実装し、`interface/generated.json` を Node から書く。`--check` は、全部の項目の全部の欄を比べるように替える（contracts/interface.md の「切り替えの後」）。
  `generated.json` の差分が各項目の `surfaces.mcp` だけであることを確かめる。`input` か `cli` に差が出たら、コマンド定義の側を直す。
- [ ] T062 [US1] `scripts/interface/export.py` と `cli/tests/unit/test_interface_export.py` を消す。
  `cli-node/tests/interface-export/typer-sample.json` と、それを読むテストも消す。`project.json` の `test-py`・`lint-py` の inputs から、消したパスを外す。
- [ ] T063 [US1] `libs/interface-spec/targets.json` の pecot-workflow の `sources` を替える。
  替えた後は `cli-node/src/**/*.ts`・`bin/*`・`hooks/**/*.sh` である。`libs/interface-spec/project.json` の `lint-defs` の inputs も同じに替える。`interface-spec:lint-defs` が通ることを確かめる。
- [ ] T064 version plan に、Node と MCP への切り替えを書く。旧形式の manifest の削除も書く。Python と uv が要らなくなったことも書く。CUJ 1〜7 と 9 を、Claude Code と Copilot CLI の両方で実行する。結果は `.pecot/work/<Issue番号>/` に残す。

**Checkpoint**: 切り替えの版を出せる。定義書は Node の実装を写している。Python の CLI とテストはまだ残っている

---

## Phase 12: User Story 4 — Python を消し、cli-node を cli に移す (Priority: P4)

**Goal**: pecot-workflow に Python の CLI・テスト・レーンが残らない。定義書の仕組みも Python を読まない

**Independent Test**: Python と pytest の無い環境で、pecot-workflow の全レーンが通る。カバレッジが 91.0 以上。quickstart.md の「走査」で、Python の残りが 0 件。
`interface-spec:lint-defs` に `has no test` の行が無い（SC-011）

- [ ] T065 [US4] `cli/` の Python を消す。対象は `commands/`・`core/`・`tests/`・`pyproject.toml`・`uv.lock`・`__init__.py`・`__main__.py`・`py.typed` である。`cli/templates/` は Node の CLI が読むので残す。
- [ ] T066 [US4] hooks とスキルの pytest を消す。対象は `hooks/tests/`・`hooks/lib/tests/`・`hooks/conftest.py`・`skills/w-onboarding/scripts/tests/` の Python。
- [ ] T067 [US4] `cli-node/` を `cli/` に移す。`project.json` の inputs と `--filter`、`bin/pecot`・`bin/_lib.sh` のパスを直す。`pnpm-workspace.yaml`、knip と ESLint の設定、`vitest.config.ts` の参照も直す。
- [ ] T068 [US4] `project.json` から `test-py` と `lint-py` を外し、`test` と `lint` の dependsOn を直す。
  `scripts/ci/run-tests.sh` と `run-lint.sh` から py と pytest を外す。`scripts/ci/python-version.sh` と `compare_junit.py` を消す。
- [ ] T069 [US4] `libs/interface-spec/targets.json` の pecot-workflow を、移した後のパスに直す。
  `sources` は `cli/src/**/*.ts`・`bin/*`・`hooks/**/*.sh` にする。`tests` は `cli/tests/**/*.ts`・`cli/src/**/tests/**/*.ts` にする。
  `libs/interface-spec/project.json` の `lint-defs` の inputs も同じに直す。`libs/interface-spec/docs/conf.py` の `iface_junit` は、Python の JUnit を外し、Node の JUnit のパスを直す。
- [ ] T070 [US4] `interface-spec:lint-defs` を流し、振る舞いの項目 769 個が全部つながることを確かめる（SC-011）。`libs/interface-spec/README.md` の手順で定義書の HTML を作り、Python を読まずに出来ることも確かめる。
- [ ] T071 [US4] `record.ts` と `record:parity*` のスクリプトを消す。golden は Node の回帰テストの期待値として残す。
- [ ] T072 [US4] `nx.json` の `pecotPluginTestGlobals` / `pecotPluginLintGlobals` から、uv と Python の参照を外す。
  外すのは runtime 入力、`cli/pyproject.toml`、`cli/uv.lock`、`python-version.sh` である。代わりに `pnpm-lock.yaml` などの Node の入力を足す。
- [ ] T073 [US4] `.pre-commit-config.yaml` の ruff の `--config` を、root の `pyproject.toml` に向ける。`check-nx-env-inputs` の files を Node の構成に直す。
- [ ] T074 [P] [US4] `.github/dependabot.yml` から uv（`/plugins/pecot-workflow/cli`）のエントリを消す。ファイル先頭の uv についての説明も消す。

**Checkpoint**: Python なしで全レーンが通る。つながらない項目が 0 件

---

## Phase 13: User Story 5 — npm の単体配布を始める (Priority: P5)

**Goal**: リリースのたびに、`@pecot/workflow-mcp` を npm へ出す

**Independent Test**: dry-run の配布ツリーを `npx` で起動し、34 個のツールが使える。リリースで `@pecot/workflow-mcp` が npm に出る

- [ ] T075 [US5] `plugins/pecot-tools/scripts/release/` のスクリプトとテストを `scripts/release/` に写す。
  写すのは `publish-mcp-dist.sh`・`finalize-dist.mjs`・`mcp-dist-README.md`・`tests/` の 4 つ。パッケージ名は `@pecot/workflow-mcp`、bin は `bin/pecot-workflow-mcp.mjs` にする。
- [ ] T076 [US5] 配布の README に、hooks のガードが無いことを書く。投稿の確認は MCP クライアント自身に任せることも書く。置き場は `scripts/release/mcp-dist-README.md` である。
- [ ] T077 [US5] `project.json` の `nx-release-publish` を publish スクリプトに置き換え、`test-release` レーンを足す。冪等性は pecot-tools と同じく、HEAD の `pecot-workflow-v<version>` タグで判定する。
- [ ] T078 [US5] `.github/workflows/publish-npm.yml` のタグの形と説明に、`pecot-workflow-v<version>` を足す。このタグを `@pecot/workflow-mcp` に解決させる。
- [ ] T079 [US5] npm 側の trusted publisher の設定手順を Issue に書き、利用者の設定を待つ。設定の後、リリースで `@pecot/workflow-mcp` が出ることを確かめる。プラグインの無い MCP クライアントで、quickstart.md の CUJ 8 が通ることも確かめる。

**Checkpoint**: 単体配布が始まる

---

## Phase 14: Polish — 文書と関連 Epic への引き渡し

**Purpose**: 移行の結果を文書と関連 Epic に反映する

- [ ] T080 [P] `README.md` と `CONTRIBUTING.md` から、Python と uv の前提を消す。MCP ツールの使い方と、単体配布の登録を書く。
- [ ] T081 [P] `CLAUDE.md` のリポジトリ構成の表から `test-py` を外し、pecot-workflow のレーンを今の形に直す。`.githooks/README.md` に Python のレーンの記述があれば、同じに直す。
- [ ] T082 Epic #41 に、pecot-workflow の manifest と準拠範囲が片づいたことをコメントする。#41 の本文は書き換えない。
- [ ] T083 quickstart.md を最初から最後まで実行し、SC-001〜SC-011 の結果を `.pecot/work/<Issue番号>/` に残す。
- [x] T084 旧 sub-issue #17〜#27 を not planned で close する（spec FR-017）。2026-11-05 に済んだ（2026-11-05 の tasks の T063）。

---

## Dependencies & Execution Order

### フェーズの依存

| フェーズ | 始められる時期 |
|---|---|
| 1 | 最初 |
| 2〜5（US1） | 1 の後。互いに独立で、並べて進めてよい |
| 6（US1） | T027〜T029 は 1 の後ならいつでも。T030〜T032 は 2〜5 の後 |
| 7（US2） | 2〜6 の後 |
| 8（US3） | 1 の後ならいつでも。7 と並べてよい |
| 9（US3） | 7 と 8 の後 |
| 10（US4） | 1 の後ならいつでも。8 で足した hooks のテストも移す |
| 11（切り替え） | 2〜10 が全部終わってから |
| 12（US4） | 11 の後 |
| 13（US5） | 12 の後 |
| 14 | 最後 |

### ユーザーストーリーの依存

| ストーリー | 依存 |
|---|---|
| US1 | 単独で確かめられる（前後比較と定義書） |
| US2 | US1 に依存する。registry が 34 個そろってから MCP を作る |
| US3 | 判定は US1・US2 と独立に作れる。発火するのは切り替えの後 |
| US4 | hooks のテストの移行は独立。Python の削除は切り替えの後 |
| US5 | US4 の後 |

## Parallel Example

```text
# Phase 1 の後、次を並べて進められる
Phase 2: T009 project.ts / T010 top.ts
Phase 3: T014 issue.ts / T015 session.ts
Phase 4: T019〜T020 pr.ts
Phase 5: T023 worktree.ts / T024 release.ts
Phase 6: T027 security.ts / T028 dependabot.ts
Phase 8: T039〜T043 hooks のガード
Phase 10: T046 hooks/tests の移行 / T047 hooks/lib/tests の移行
```

並べて進めるフェーズは、`registry.ts` の `COMMANDS` で重なる。後から入る PR が rebase で取り込む。

## Implementation Strategy

### MVP

MVP は Phase 1〜6（US1）とする。Node の CLI が、前後比較の全件と定義書の 34 項目で Python と一致すれば、以降のフェーズはこの結果の上に積める。
配布物はまだ Python のままで、利用者への影響は無い。

### 増やし方

1. Phase 1〜6 で、Node の CLI がそろい、振る舞いの項目が全部 vitest につながる
2. Phase 7〜10 で、MCP サーバ・hooks の判定・Copilot CLI の名前・hooks のテストがそろう。配布物は変わらない
3. Phase 11 で、1 回の PR とリリースで切り替える。定義書の書き出しの元も Node に替わる
4. Phase 12〜13 で、Python を消し、単体配布を始める
5. Phase 14 で、文書を片づける
