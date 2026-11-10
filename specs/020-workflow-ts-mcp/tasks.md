---

description: "pecot-workflow の TypeScript 化と MCP 化（再設計）のタスク一覧"
---

# Tasks: pecot-workflow の TypeScript 化と MCP 化（再設計）

> [!NOTE]
> このファイルは計画の記録である。各フェーズは `/pecot-w:w-issueize` で Epic の sub-issue にし、進捗は sub-issue で管理する。
> このファイルのチェックボックスは付けない。実装は `/pecot-w:w-active` で行い、speckit の implement は使わない。

**Input**: `specs/020-workflow-ts-mcp/` の設計文書

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、contracts/、quickstart.md

**Tests**: 憲法 II（TDD）を守る。テストを先に書き、失敗を確かめてから実装する。コマンドの移植では、済みの前後比較のシナリオを先行のテストとして使う。モックは I/O 境界だけに使う。I/O 境界とは、偽の GitHub サーバ、一時 git リポ、shell の子プロセスを指す。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの番号は plan.md の「フェーズ」と同じ。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US5） |

パスは `plugins/pecot-workflow/` 起点で書く。例は `cli/`・`cli-node/`・`hooks/`・`skills/`・`bin/`・`project.json`。

`plugins/pecot-tools/`・`plugins/pecot-visual/`・`.github/`・`.nx/`・`nx.json`・`CLAUDE.md` などは、リポ root 起点で書く。

## 全フェーズに共通の完了条件

- pre-commit と pre-push を `--no-verify` なしで通す
- pecot-workflow の version plan を `.nx/version-plans/` に足す。CHANGELOG は手で編集しない
- 新しい識別子・ファイル名・テストの値に、ベンダー名とブランドの語を含めない
- `cli-node/vitest.config.ts` のカバレッジの閾値を下げない
- フェーズ 10 より前は、配布物の振る舞いを変えない（spec FR-014）

---

## Phase 1: 準備（golden の記録し直しと依存の停止）

**Purpose**: 移植の基準を今の Python にそろえる。移行中に基準が動かないようにする

- [ ] T001 `cli/` で `uv sync` を実行し、`record:parity:check` を流す。差の出るシナリオが、research.md の R-0 にある 12 件であることを確かめる。12 件はすべて `*-usage` と `global-*` のヘルプ表示である。
- [ ] T002 T001 の 12 件だけを `record:parity <id>...` で記録し直す。更新先は `cli-node/tests/parity/golden/` である。`record:parity:check` の差が 0 になることを確かめる。
- [ ] T003 Node 側の使い方エラーとヘルプの整形を、記録し直した golden に合わせる。対象は `cli-node/src/commands/usage-error.ts`・`help.ts`・`value-types.ts` と単体テストである。typer 0.27.3 の書式にそろえる。
- [ ] T004 [P] `.github/dependabot.yml` の uv のエントリに `open-pull-requests-limit: 0` を付ける。対象は `/plugins/pecot-workflow/cli` である。止める理由と、フェーズ 11 で消すことを、同じファイルのコメントに書く（research R-15）。

**Checkpoint**: `record:parity:check` の差が 0。dependabot は uv の版の更新の PR を出さない

---

## Phase 2: User Story 1 — project とグループ無しのコマンドを移す (Priority: P1)

**Goal**: project の 10 個とグループ無しの 4 個が、Node で Python と同じ結果を返す

**Independent Test**: `cli-node/tests/parity/parity.test.ts` の該当シナリオが golden と一致する。該当は `project-*`・`add-to-project-*`・`update-issue-status-*`・`create-branch-*`・`delete-branch-*`・`global-*` の 6 種

- [ ] T005 [P] [US1] `cli/commands/project.py` を `cli-node/src/commands/project.ts` に移す。`registry.ts` の `COMMANDS` に 10 個を足す。
- [ ] T006 [P] [US1] `cli/commands/main.py` のグループ無しの 4 個を移す。移し先は `cli-node/src/commands/top.ts` で、`COMMANDS` に足す。
- [ ] T007 [US1] rich の表の整形を、golden と文字単位で一致させる。直す先は `cli-node/src/domain/format.ts` と `src/commands/cell-table.ts` である。

**Checkpoint**: 該当シナリオが全部一致する

---

## Phase 3: User Story 1 — issue と session のコマンドを移す (Priority: P1)

**Goal**: issue の 5 個と session の 2 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の `issue-*`・`session-*` のシナリオが golden と一致する

- [ ] T008 [P] [US1] `cli/commands/issue.py` を `cli-node/src/commands/issue.ts` に移し、`COMMANDS` に 5 個を足す。`--prepare` の下書きを含める。実投稿の成功時にスラッシュコマンドのフラグを消す処理も含める。
- [ ] T009 [P] [US1] `cli/commands/session.py` を `cli-node/src/commands/session.ts` に移し、`COMMANDS` に 2 個を足す。
- [ ] T010 [US1] Python が書いた状態を Node が読むシナリオ（`*-python-state`）が、issue と session で一致することを確かめる。食い違えば `cli-node/src/infra/state-store.ts` と `config-store.ts` を直す。

**Checkpoint**: 該当シナリオが全部一致する

---

## Phase 4: User Story 1 — pr のコマンドを移す (Priority: P1)

**Goal**: pr の 4 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の `pr-*` のシナリオが golden と一致する

- [ ] T011 [US1] `cli/commands/pr.py` の `create` と `read` を移す。移し先は `cli-node/src/commands/pr.ts` で、`COMMANDS` に足す。`--prepare` と `--dry-run` を含める。
- [ ] T012 [US1] `pr.py` の `merge` と `preflight` を同じ `pr.ts` に移し、`COMMANDS` に足す。git の呼び出しは `src/infra/git.ts` を通す。

**Checkpoint**: 該当シナリオが全部一致する

---

## Phase 5: User Story 1 — worktree と release のコマンドを移し、32 個をそろえる (Priority: P1)

**Goal**: worktree の 4 個と release の 3 個が Node で動き、registry が 32 個になる

**Independent Test**: `parity.test.ts` の 213 件が全部一致する。registry の数が 32

- [ ] T013 [P] [US1] `cli/commands/worktree.py` を `cli-node/src/commands/worktree.ts` に移し、`COMMANDS` に 4 個を足す。`worktree link` は `interactive: true` にする。CLI の上書き確認は今の対話のまま残す。
- [ ] T014 [P] [US1] `cli/commands/release.py` を `cli-node/src/commands/release.ts` に移し、`COMMANDS` に 3 個を足す。
- [ ] T015 [US1] `cli-node/src/commands/tests/registry.test.ts` にテストを足す。`COMMANDS` が 32 個であることと、`toolName` が contracts/mcp-tools.md の一覧と同じであることを確かめる。
- [ ] T016 [US1] `project info` の起動から結果までを、Python と Node で 5 回ずつ計る。中央値を `.pecot/work/<Issue番号>/` に記録する。Node が Python 以下であることを確かめる（SC-009）。

**Checkpoint**: 213 件が一致し、registry が 32 個。配布物は Python のまま

---

## Phase 6: User Story 2 — MCP サーバ (Priority: P2)

**Goal**: registry から 32 個の MCP ツールを公開する。プラグインにはまだ登録しない

**Independent Test**: `tools/list` が 32 個で registry と一致する。MCP 経由でも 213 件が golden と一致する

- [ ] T017 [US2] `cli-node/package.json` に `@modelcontextprotocol/server` を足す。devDependencies には `@modelcontextprotocol/client` を足す。版は `plugins/pecot-tools/cli/package.json` と同じにする。
- [ ] T018 [US2] `cli-node/tests/mcp/tools-list.test.ts` を先に書く。ツールの数と名前が registry と一致することを確かめる。各ツールの入力のプロパティが、CLI のオプションと 1 対 1 であることも確かめる。`--show-repo` と `--version` は除く。
- [ ] T019 [US2] `cli-node/src/mcp/server.ts`・`serve.ts`・`result.ts` を作り、`COMMANDS` からツールを登録する。結果の形は data-model.md の ToolResult に従う。`content[0].text` は stdout、`isError` は `exitCode !== 0` とする。
- [ ] T020 [US2] `worktree_link` は入力 `overwrite` で受ける。既定は false で、false なら上書きせず、対象を一覧で返す。置き場は T019 と同じ `src/mcp/` である。
- [ ] T021 [US2] `cli-node/src/cli.ts` に `mcp` サブコマンドを足し、stdio で MCP サーバを起動する。`mcp` はツールにしない。
- [ ] T022 [US2] `cli-node/tests/parity/parity.test.ts` に MCP 経由の起動を足す。各シナリオのツールを `@modelcontextprotocol/client` で呼び、stdout と終了コードを golden と比べる。時間のかかる `release_*` も完了まで待つ。

**Checkpoint**: MCP 経由でも 213 件が一致する。プラグインの `.mcp.json` は変えていない

---

## Phase 7: User Story 3 — hooks のガード (Priority: P3)

**Goal**: 投稿の ask を MCP ツールで判定する。Bash の `pecot` の deny の判定を用意する。どちらも、配布物の振る舞いはまだ変えない

**Independent Test**: 今の確認・阻止の条件が、MCP の入力 JSON で同じ判定と文言になる。2 つのクライアントの名前の形で通る

- [ ] T023 [P] [US3] `cli-node/tests/hooks/pecot-post-ask.test.ts` を先に書く。contracts/hooks-guard.md の「投稿の ask」の全行を、2 つのクライアントの名前で流す。文言は今の `pecot-issue-create-ask`・`pecot-pr-create-ask` と一致させる。
- [ ] T024 [US3] `hooks/lib/mcp-handlers/pecot-post-ask.sh` を作る。`PECOT_HOOK_TOOL_NAME` から `<tool>` を取り出し、`tool_input` を jq で読む。`mcp-dispatcher.sh` からは、`pr-create-block.sh` の後、`context7-allow.sh` の前に呼ぶ。
- [ ] T025 [P] [US3] `cli-node/tests/hooks/pecot-cli-deny.test.ts` を先に書く。32 サブコマンドの起動形のそれぞれで deny になり、理由に対応するツール名が入ることを確かめる。起動形は contracts/hooks-guard.md の表にある。
- [ ] T026 [US3] `hooks/lib/core/pecot-cli-deny.sh` を作る。セグメントの分け方と起動形の見つけ方は、`external-post-check.sh` の処理を使う。サブコマンド別の許可・阻止は持たない。`pre-tool-use-bash.sh` からはまだ呼ばない。
- [ ] T027 [P] [US3] 案内文の移行後の文を用意し、テストで固定する。対象は `gh-command-check.sh`、`pecot-issue-pending-reminder.sh`、`plan-issue-poster.sh` の失敗時の案内である。差し替えはフェーズ 10 で行う。

**Checkpoint**: 新しい判定のテストが通る。今の Bash の判定と案内文は変わっていない

---

## Phase 8: User Story 3 — Copilot CLI でのツール名を実物で確かめる (Priority: P3)

**Goal**: Copilot CLI が MCP ツールに付ける名前と hooks の入力を実物で採る。research R-5 の推定を確かめる

**Independent Test**: 実物のツール名が contracts/hooks-guard.md の形と一致する。違えば、直した後に T023 のテストが通る

- [ ] T028 [US3] 開発用の登録で、GitHub Copilot CLI から MCP サーバを起動する。登録には作業ツリーの `bin/pecot` と `PECOT_BOOTSTRAP_SKIP=1` を使う。`project_info` を呼び、PreToolUse の hooks が受ける JSON を `.pecot/work/<Issue番号>/` に保存する。
- [ ] T029 [US3] T028 の名前が `pecot-workflow-<tool>` と違えば、`pecot-post-ask.sh` の取り出しを直す。contracts/hooks-guard.md、data-model.md、T023 のテストの名前も直す。同じなら、確かめた日付と Copilot CLI の版を research.md の R-5 に書く。

**Checkpoint**: Copilot CLI の名前の形が確定している

---

## Phase 9: User Story 4 — hooks のテストを vitest に移す (Priority: P4)

**Goal**: hooks の pytest 1,569 件を vitest の `hooks` project に移す

**Independent Test**: vitest の件数が 1,569 以上。起動スクリプトの一覧が `baseline.json` の `hooks.scripts` を全部含む

- [ ] T030 [P] [US4] `hooks/tests/` の 30 ファイルを、vitest で `cli-node/tests/hooks/` に移す。shell は `child_process.spawnSync` で起動し、stdin・env・終了コード・stdout を確かめる。今の pass 2 の条件（空の設定と `GIT_DIR` の export）も残す。
- [ ] T031 [P] [US4] `hooks/lib/tests/` の 37 ファイルを、同じ方法で移す。
- [ ] T032 [US4] `cli-node/tests/hooks/baseline-scripts.test.ts` に、件数が `hooks.testCount` 以上であることの確認を足す。`scripts/ci/run-tests.sh --scope=hooks` は、移行中は pytest と vitest の両方を流す。

**Checkpoint**: vitest だけで hooks の全ケースが流れる。pytest もまだ残っている

---

## Phase 10: 切り替え — Node・MCP・Agent Plugins 1.0 に 1 回で切り替える (Priority: P2〜P4)

**Goal**: スキル・hooks・CLI・manifest をそろえて切り替える。利用者に届く振る舞いを変えるのは、この PR だけ

**Independent Test**: `$PECOT` が 0 件。Claude Code と GitHub Copilot CLI で quickstart.md の CUJ 1〜7 と 9 が通る

- [ ] T033 [P] [US2] `cli-node/tests/skills/tool-names.test.ts` を先に書く。本文にある MCP ツール名が全部 `COMMANDS` にあることを確かめる。対象はスキル・agents・hooks テンプレートである。`$PECOT` とランチャー変数の説明が 0 件であることも確かめる。
- [ ] T034 [P] [US2] `test-skills` レーンを vitest に替える。`skills/w-onboarding/scripts/tests/` の pytest も vitest に移す。直す先は `project.json` と `scripts/ci/run-tests.sh` である。
- [ ] T035 [US2] スキル 15 ファイル・agents・hooks テンプレート 2 ファイルの `$PECOT` 79 箇所を、MCP ツールの呼び出しに書き換える。対象は `skills/*/SKILL.md`・`agents/*.md`・`hooks/templates/plan-mode-reminder*.md` である。「pecot CLI ランチャー」の節は消す。
- [ ] T036 [US3] `hooks/pre-tool-use-bash.sh` から `lib/core/pecot-cli-deny.sh` を呼ぶ。`lib/core/external-post-check.sh` の pecot の判定を外し、`gh pr merge` の ask だけを残す。案内文を T027 の文に差し替え、テストを同じ変更に合わせる。
- [ ] T037 [US1] `bin/_lib.sh` に、pecot-tools の `bin/_lib.sh` から `plugin_runtime_*` と Node の下限の確認を写す。`bin/pecot` は実行用ミラー方式に書き換える。`PECOT_BOOTSTRAP_SKIP=1` は `cli-node/dist/cli.js` を直接起動する。
- [ ] T038 [US1] 初回起動で `${DATA}/venv/` を消す処理を `bin/pecot` に入れる。`.inuse` のロックを持つ世代は、次回の起動で消す。
- [ ] T039 [P] [US1] `plugins/pecot-tools/cli/tests/bootstrap/` から 3 本を `cli-node/tests/bootstrap/` に写す。
  3 本は `data-dir.sh`・`run.sh`・`stub-root.sh`。Python と uv の無い `PATH` で、初回起動がミラーを作ることを確かめる。古い venv が消えることと、Node が無いと理由を返して止まることも確かめる。
- [ ] T040 [US2] `.mcp.json` に `pecot-workflow` を足す。`command` は `${CLAUDE_PLUGIN_ROOT}/bin/pecot`、`args` は `["mcp"]` である。context7 は残し、`env` は書かない。
- [ ] T041 [US2] root に `plugin.json` と `mcp.json` を置く。`plugin.json` は `$schema` 1.0.0、name `pecot-w` である。`mcp.json` は `pecot-workflow` と context7 を持つ。
- [ ] T042 [US2] `hooks/hooks-copilot.json` を `com.github.copilot/hooks/hooks.json` に移す。matcher に `pecot-workflow-.*` を足す。
  agents を `com.github.copilot/agents/` に置く。`.github/plugin/plugin.json` と `hooks/hooks-copilot.json` を消す。
- [ ] T043 [US2] `cli-node/tests/bootstrap/manifest.sh` を作る。中身は `plugins/pecot-visual/cli/tests/bootstrap/manifest.sh` と同じ確認にする。両形式の name・version・MCP サーバと args の一致を固定する。
- [ ] T044 [US2] `project.json` の `release.version.manifestRootsToUpdate` を直す。`.github/plugin` を `{projectRoot}` に替える。`.nx/nx-release/src/version-actions.js` とそのテストの、旧形式の参照も直す。
- [ ] T045 version plan に、Node と MCP への切り替えを書く。旧形式の manifest の削除も書く。Python と uv が要らなくなったことも書く。CUJ 1〜7 と 9 を、Claude Code と Copilot CLI の両方で実行する。結果は `.pecot/work/<Issue番号>/` に残す。

**Checkpoint**: 切り替えの版を出せる。Python の CLI とテストはまだ残っている

---

## Phase 11: User Story 4 — Python を消し、cli-node を cli に移す (Priority: P4)

**Goal**: pecot-workflow に Python の CLI・テスト・レーンが残らない

**Independent Test**: Python と pytest の無い環境で、pecot-workflow の全レーンが通る。カバレッジが 91.0 以上。quickstart.md の「走査」で、Python の残りが 0 件

- [ ] T046 [US4] `cli/` の Python を消す。対象は `commands/`・`core/`・`tests/`・`pyproject.toml`・`uv.lock`・`__init__.py`・`__main__.py`・`py.typed` である。`cli/templates/` は Node の CLI が読むので残す。
- [ ] T047 [US4] hooks とスキルの pytest を消す。対象は `hooks/tests/`・`hooks/lib/tests/`・`hooks/conftest.py`・`skills/w-onboarding/scripts/tests/` の Python。
- [ ] T048 [US4] `cli-node/` を `cli/` に移す。`project.json` の inputs と `--filter`、`bin/pecot`・`bin/_lib.sh` のパスを直す。`pnpm-workspace.yaml`、knip と ESLint の設定、`vitest.config.ts` の参照も直す。
- [ ] T049 [US4] `project.json` から `test-py` を外し、`test` の dependsOn を直す。`scripts/ci/run-tests.sh` と `run-lint.sh` から py と pytest を外す。`scripts/ci/python-version.sh` と `compare_junit.py` を消す。
- [ ] T050 [US4] `record.ts` と `record:parity*` のスクリプトを消す。golden は Node の回帰テストの期待値として残す。
- [ ] T051 [US4] `nx.json` の `pecotPluginTestGlobals` / `pecotPluginLintGlobals` から、uv と Python の参照を外す。
  外すのは runtime 入力、`cli/pyproject.toml`、`cli/uv.lock`、`python-version.sh` である。代わりに `pnpm-lock.yaml` などの Node の入力を足す。
- [ ] T052 [US4] `.pre-commit-config.yaml` の ruff の `--config` を、root の `pyproject.toml` に向ける。`check-nx-env-inputs` の files を Node の構成に直す。
- [ ] T053 [P] [US4] `.github/dependabot.yml` から uv（`/plugins/pecot-workflow/cli`）のエントリを消す。ファイル先頭の uv についての説明も消す。

**Checkpoint**: Python なしで全レーンが通る

---

## Phase 12: User Story 5 — npm の単体配布を始める (Priority: P5)

**Goal**: リリースのたびに、`@pecot/workflow-mcp` を npm へ出す

**Independent Test**: dry-run の配布ツリーを `npx` で起動し、32 個のツールが使える。リリースで `@pecot/workflow-mcp` が npm に出る

- [ ] T054 [US5] `plugins/pecot-tools/scripts/release/` のスクリプトとテストを `scripts/release/` に写す。
  写すのは `publish-mcp-dist.sh`・`finalize-dist.mjs`・`mcp-dist-README.md`・`tests/` の 4 つ。パッケージ名は `@pecot/workflow-mcp`、bin は `bin/pecot-workflow-mcp.mjs` にする。
- [ ] T055 [US5] 配布の README に、hooks のガードが無いことを書く。投稿の確認は MCP クライアント自身に任せることも書く。置き場は `scripts/release/mcp-dist-README.md` である。
- [ ] T056 [US5] `project.json` の `nx-release-publish` を publish スクリプトに置き換え、`test-release` レーンを足す。冪等性は pecot-tools と同じく、HEAD の `pecot-workflow-v<version>` タグで判定する。
- [ ] T057 [US5] `.github/workflows/publish-npm.yml` のタグの形と説明に、`pecot-workflow-v<version>` を足す。このタグを `@pecot/workflow-mcp` に解決させる。
- [ ] T058 [US5] npm 側の trusted publisher の設定手順を Issue に書き、利用者の設定を待つ。設定の後、リリースで `@pecot/workflow-mcp` が出ることを確かめる。プラグインの無い MCP クライアントで、quickstart.md の CUJ 8 が通ることも確かめる。

**Checkpoint**: 単体配布が始まる

---

## Phase 13: Polish — 文書と関連 Epic への引き渡し

**Purpose**: 移行の結果を文書と関連 Epic に反映し、旧 sub-issue を片づける

- [ ] T059 [P] `README.md` と `CONTRIBUTING.md` から、Python と uv の前提を消す。MCP ツールの使い方と、単体配布の登録を書く。
- [ ] T060 [P] `CLAUDE.md` のリポジトリ構成の表と「テスト・lint の実行」から、`test-py` と `--scope=py` を外す。
- [ ] T061 Epic #41 に、pecot-workflow の manifest と準拠範囲が片づいたことをコメントする。#41 の本文は書き換えない。
- [ ] T062 quickstart.md を最初から最後まで実行し、SC-001〜SC-009 の結果を `.pecot/work/<Issue番号>/` に残す。
- [ ] T063 旧 sub-issue #17〜#27 を not planned で close する（spec FR-017）。2026-11-05 に済んだ。

---

## Dependencies & Execution Order

### フェーズの依存

| フェーズ | 始められる時期 |
|---|---|
| 1 | 最初 |
| 2〜5（US1） | 1 の後。互いに独立で、並べて進めてよい |
| 6（US2） | 2〜5 の後 |
| 7（US3） | 1 の後ならいつでも。6 と並べてよい |
| 8（US3） | 6 と 7 の後 |
| 9（US4） | 1 の後ならいつでも。7 で足した hooks のテストも移す |
| 10（切り替え） | 2〜9 が全部終わってから |
| 11（US4） | 10 の後 |
| 12（US5） | 11 の後 |
| 13 | 最後 |

### ユーザーストーリーの依存

| ストーリー | 依存 |
|---|---|
| US1 | 単独で確かめられる（前後比較） |
| US2 | US1 に依存する。registry が 32 個そろってから MCP を作る |
| US3 | 判定は US1・US2 と独立に作れる。発火するのは切り替えの後 |
| US4 | hooks のテストの移行は独立。Python の削除は切り替えの後 |
| US5 | US4 の後 |

## Parallel Example

```text
# Phase 1 の後、次を並べて進められる
Phase 2: T005 project.ts / T006 top.ts
Phase 3: T008 issue.ts / T009 session.ts
Phase 4: T011〜T012 pr.ts
Phase 5: T013 worktree.ts / T014 release.ts
Phase 7: T023〜T027 hooks のガード
Phase 9: T030 hooks/tests の移行 / T031 hooks/lib/tests の移行
```

## Implementation Strategy

### MVP

MVP は Phase 1〜5（US1）とする。Node の CLI が 213 件で Python と一致すれば、以降のフェーズはこの結果の上に積める。配布物はまだ Python のままで、利用者への影響は無い。

### 増やし方

1. Phase 1〜5 で、Node の CLI がそろう
2. Phase 6〜9 で、MCP サーバ・hooks の判定・Copilot CLI の名前・hooks のテストがそろう。配布物は変わらない
3. Phase 10 で、1 回の PR とリリースで切り替える
4. Phase 11〜12 で、Python を消し、単体配布を始める
5. Phase 13 で、文書と旧 Issue を片づける
