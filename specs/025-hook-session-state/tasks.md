---

description: "pecot-workflow のフックを棚卸しし、状態をファイルに頼らない形にし、Claude Code の現行のプラグイン仕様に合わせる のタスク一覧"
---

# Tasks: pecot-workflow のフックを棚卸しし、状態をファイルに頼らない形にし、Claude Code の現行のプラグイン仕様に合わせる

**Input**: `specs/025-hook-session-state/` の設計文書

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、quickstart.md と、contracts/ の 2 つの文書

**Tests**: 憲法 II（TDD）を守る。契約の表の行ごとに、先に期待を書き換えたテストを落とし、失敗を確かめてから直す。消す振る舞いは、テストも消す。期待は、フックの出力の JSON・終了コード・出力の行・書かれるファイルで比べる。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの順は、plan.md の「進め方」の順と同じ。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US6） |

パスはリポ root 起点で書く。次の略し方を使う。

| 略 | 指す場所 |
|---|---|
| `p-w/` | `plugins/pecot-workflow/` |
| `lib/` | `p-w/hooks/lib/` |
| `src/` | `p-w/cli/src/` |
| `tests/` | `p-w/cli/tests/` |
| `SPEC/` | `specs/025-hook-session-state/` |

## 全フェーズに共通の完了条件

- pre-commit を `--no-verify` なしで通す
- 設定キーを消すフェーズは、次の 3 つを同じ集合に保つ
  - `p-w/hooks/hooks-config.json.sample`
  - `p-w/hooks/README.md` の設定キーの表
  - スクリプトの `pecot_hook_enabled` の呼び出し
- フックを消すフェーズは、2 つの定義ファイルの両方から外す
  - `p-w/hooks/hooks.json`
  - `p-w/com.github.copilot/hooks/hooks.json`
- スクリプトを消すフェーズは、そのテストと、テストが使う fixture も消す
- MCP ツールの入力・出力を変えるフェーズは、次の 3 つを同じ PR で済ませる
  - `p-w/interface/authored.yaml` の項目を直し、確かめるテストに `verifies` を付ける
  - `p-w/cli/scripts/export-interface.ts --write` で `p-w/interface/generated.json` を書き出し直す
  - parity の `tests/parity/scenarios/` と `golden/` を直す
- 配布物が変わるフェーズは、version plan を `.nx/version-plans/` に足す。CHANGELOG は手で編集しない
- 各テストのカバレッジの閾値を下げない（憲法 III）
- スキル・エージェント・README の文から、消した仕組みの記述を除く

---

## Phase 1: 設計を左右する点を、実機で先に確かめる

**Goal**: research.md の R2 と R8 の「実機で確かめる点」に、結果と確かめた日が付いている。見込みと違った点は、後のフェーズを直してある

**Independent Test**: research.md の R2・R8 の表のすべての行に、結果・版・日付が書かれている

- [ ] T001 検証用のスキルを手元のプラグインに足し、frontmatter の `hooks` が登録されるかを確かめる。結果を `SPEC/research.md` の R2 に書く
  - フックの形: PostToolUse、matcher `ExitPlanMode`、`once: true`
- [ ] T002 同じスキルで、残りの 3 点を確かめる。結果を `SPEC/research.md` の R2 に書く
  - `command` の `${CLAUDE_PLUGIN_ROOT}` が展開されるか
  - `once: true` で 1 回で外れるか
  - resume の後に登録し直されるか
- [ ] T003 [P] GitHub Copilot CLI で、frontmatter に `hooks` のあるスキルを起動する。結果を `SPEC/research.md` の R2 と R5 に書く
  - エラーにならないか
  - フックを読むか
- [ ] T004 [P] speckit の git 拡張が、新しいブランチを作らずに通るかを確かめる。結果を `SPEC/research.md` の R8 に書く
  - `GIT_BRANCH_NAME` に今のブランチ名を渡し、`--allow-existing-branch` を付ける
  - 動かすのは `.specify/extensions/git/scripts/bash/create-new-feature-branch.sh`
- [ ] T005 結果が見込みと違うときは、`SPEC/plan.md` と、この tasks.md の Phase 6・Phase 7 を直す。直した点をユーザーに知らせる

---

## Phase 2: 承認と免除を撤廃する (US1、P1)

**Goal**: PR の作成・起票・マージで、プラグインのフックが承認を求めない。Bash の `pecot`、GitHub MCP の PR 作成、大きすぎるコマンドも止めない

**Independent Test**: 4 つの操作の hook 入力を、スラッシュコマンドの有無を変えて流す。どれにも ask と deny が返らない

**契約**: contracts/hook-behavior.md の「止める・承認を求める」

- [ ] T006 [US1] 期待を書き換え、落ちることを確かめる。`gh pr merge`・`pecot …`・大きすぎるコマンドに、何も返らないことを期待する
  - `tests/hooks/lib/bash-guard-responses.test.ts`
  - `tests/hooks/lib/integration.test.ts`
  - 古い版の免除のフラグを置いた状態の入力を 1 つ足し、結果が変わらないことを期待する（FR-004）
- [ ] T007 [US1] `lib/adapters/claude-bash-guards.sh` から、3 つの段を外す
  - `pecot-cli-deny`
  - `external-post-check`（`gh pr merge` の ask）
  - 大きすぎるコマンドの ask
- [ ] T008 [US1] MCP の PreToolUse を外す
  - 2 つの定義ファイルのエントリを外す
  - `p-w/hooks/pre-tool-use-mcp.sh` を消す
  - `lib/mcp-handlers/` を消す（`context7-allow.sh` も一緒に消える）
- [ ] T009 [US1] 呼ばれなくなるスクリプトを消す
  - `lib/core/pecot-cli-deny.sh`
  - `lib/core/external-post-check.sh`
  - `lib/core/pecot-tool-names.sh`
  - `lib/core/command-segments.sh`
  - `lib/adapters/claude-adapter.sh`
- [ ] T010 [US1] 免除のフラグを作る側と掃除を消す
  - `lib/user-prompt-submit/create-slash-flag.sh` を消す
  - `lib/session-start/create-slash-cleanup.sh` を消す
  - `p-w/hooks/user-prompt-submit.sh` と `lib/session-start-common.sh` の呼び出しを外す
- [ ] T011 [US1] `lib/core/mcp-guidance.sh` から、ask の案内の関数を消す
- [ ] T012 [P] [US1] CLI から、免除のフラグの消費を消す
  - `src/domain/state.ts` の定数 3 つ
  - `src/commands/pr.ts`・`issue-create.ts`・`issue-quick.ts` の `consumeFlag` の呼び出し
- [ ] T013 [US1] 消したもののテストを消す
  - `tests/hooks/pecot-cli-deny.test.ts`
  - `tests/hooks/pecot-post-ask.test.ts`
  - `tests/hooks/pre-mcp.test.ts`
  - `tests/hooks/session-start-create-slash-cleanup.test.ts`
  - `tests/hooks/user-prompt-submit-create-slash-flag.test.ts`
  - `tests/hooks/lib/mcp-handlers.test.ts`
  - `tests/hooks/lib/mcp-definitions.test.ts`
- [ ] T014 [US1] `tests/hook-tool-names.test.ts` を直す。`pecot-tool-names.sh` を読むので、テストごと消すか、読む先を定義書に変える
  - `p-w/project.json` の `test-cli` の inputs から、`pecot-tool-names.sh` を外す
- [ ] T015 [US1] 設定キーを、sample と `p-w/hooks/README.md` から除く
  - `pecot-cli-deny`・`pr-create-block`・`context7-allow`・`claude-adapter`
  - `pecot-pr-create-ask`・`pecot-issue-create-ask`・`gh-pr-merge-ask`
  - `pr-create-slash-flag`・`issue-create-slash-flag`・`merge-slash-flag`・`create-slash-cleanup`
- [ ] T016 [US1] 文書から、承認と免除の記述を除く。grep で洗う
  - `p-w/skills/w-help/references/flags.md`
  - `p-w/skills/` の w-pr・w-merge・w-quick・w-ready・w-backlog・w-issueize の SKILL.md
  - `p-w/agents/`
  - `p-w/skills/w-onboarding/` の SKILL.md と参照（FR-006）
- [ ] T017 [US1] `p-w/interface/authored.yaml` から、免除のフラグを消す記述を除く。`generated.json` を書き出し直す
  - 対象は `pr_create`・`issue_create`・`issue_quick`・`pr_cleanup`
- [ ] T018 [US1] spec 024 の該当の Issue に、コメントで知らせる
  - 対象は、tasks の「`pr_merge` を確認にかける」項目を持つ Issue
  - この Epic で ask を撤廃したので、項目を外してほしいと書く
- [ ] T019 [US1] `SPEC/quickstart.md` の 2 を実機で確かめ、結果を PR に貼る

---

## Phase 3: リマインダー・動作安定用・通知音・自動 push を撤廃する (US2、P1)

**Goal**: フックが会話に足す注意・案内が、計画の承認の後の案内と `/tmp` の促しの 2 つだけになる。Stop と Notification のフックが無い

**Independent Test**: 撤廃したフックが反応していた 7 つの hook 入力を流す。撤廃した注意が出ず、`.pecot/state/` にフラグができない

**契約**: contracts/hook-behavior.md の「文脈を足す」

**前提**: Phase 2（同じスクリプトを触る）

- [ ] T020 [US2] 期待を書き換え、落ちることを確かめる。契約の「変更の後」を期待する
  - `tests/hooks/lib/hooks-definitions.test.ts`
  - `tests/hooks/lib/session-start-features.test.ts`
  - `tests/hooks/lib/user-prompt-submit-features.test.ts`
  - `tests/hooks/lib/integration.test.ts`
- [ ] T021 [US2] 2 つの定義ファイルから、エントリを外す
  - PreToolUse の Edit 系・WebSearch
  - PostToolUse の Skill・Bash
  - Stop と Notification
- [ ] T022 [US2] `hooks.json` が直に呼ぶスクリプトを、`p-w/hooks/` から消す
  - `pre-tool-use.sh`・`pre-tool-use-websearch.sh`
  - `post-tool-use-skill.sh`・`post-tool-use-bash.sh`
  - `stop.sh`・`stop-copilot.sh`・`notification.sh`
- [ ] T023 [US2] サブスクリプトを消す（1）
  - `lib/notification/` と `lib/stop/`
  - `lib/pre-tool-use/` の `pecot-issue-pending-reminder.sh`・`pecot-skill-compliance.sh`・`websearch-allow.sh`
  - `lib/post-tool-use/` の `auto-push.sh`・`bash-post-match.sh`・`commit-info-display.sh`・`pecot-skill-reminder.sh`
- [ ] T024 [US2] サブスクリプトを消す（2）
  - `lib/user-prompt-submit/` の `pecot-issue-pending-state.sh`・`workflow-compliance-injector.sh`
  - `lib/session-start/` の `gitignore-track-notice.sh`・`issue-pending-cleanup.sh`・`plugin-update-notice.sh`
  - `lib/session-start/` の `session-project-dir.sh`・`vscode-workspace-detector.sh`
  - `lib/core/` の `branch-guard.sh`・`git-checkout-check.sh`
- [ ] T025 [US2] 消したものの呼び出しを外す
  - `p-w/hooks/pre-tool-use-skill.sh`（`.pecot` の初期化だけを残す）
  - `p-w/hooks/user-prompt-submit.sh`（初期化の検出だけを残す）
  - `lib/session-start-common.sh`
  - `lib/adapters/claude-bash-guards.sh`（`git-checkout-check` の段）
- [ ] T026 [US2] `lib/core/mcp-guidance.sh` から、リマインドの案内の関数を消す。使わなくなった `p-w/hooks/templates/` のファイルも消す
- [ ] T027 [P] [US2] CLI から、消した状態の扱いを除く
  - `src/domain/state.ts` の `FLAG_ISSUE_PENDING`・`FLAG_WIP_BRANCH_LINKED`
  - `src/commands/issue-create.ts`・`issue-quick.ts` の `consumeFlag`
  - `src/commands/pr.ts` の片付けの対象
  - `src/commands/repository.ts` の `wip/` ブランチの連動の削除
- [ ] T028 [US2] 消したもののテストを消す。`tests/hooks/` を、消したスクリプトの名前で洗う
  - `pre-tool-use.test.ts`・`pre-tool-use-websearch.test.ts`
  - `post-tool-use-pecot-skill-reminder.test.ts`・`pre-tool-use-pecot-issue-pending-reminder.test.ts`
  - `stop-misplaced-pecot-notice.test.ts`・`session-start-issue-pending-cleanup.test.ts`
  - `user-prompt-submit-pecot-issue-pending-state.test.ts`
  - `lib/auto-push.test.ts`・`lib/branch-guard.test.ts`・`lib/bash-post-match.test.ts`
  - `lib/notification-entries.test.ts`・`lib/gitignore-track-notice.test.ts`・`lib/plugin-update-notice.test.ts`
- [ ] T029 [US2] 残りの設定キーを、sample と `p-w/hooks/README.md` から除く。残るキーの数を PR に書く
  - 対象は、`SPEC/research.md` の R1 で「消す」としたキーのうち、Phase 2 で消していないもの
- [ ] T030 [US2] `tests/hooks/lib/hooks-config-disable.test.ts` にテストを足す。撤廃したキーが残る設定でも、エラーにならない（FR-023）
- [ ] T031 [US2] 文書から、撤廃した注意と自動 push の記述を除く
  - `p-w/skills/w-help/` の SKILL.md と参照
  - `p-w/README.md` と `p-w/hooks/README.md`
- [ ] T032 [US2] `p-w/interface/authored.yaml` から、`issue-pending`・`.wip-branch-linked` を消す記述を除く。`generated.json` を書き出し直す
- [ ] T033 [US2] `SPEC/quickstart.md` の 2 の 3 番を実機で確かめ、結果を PR に貼る

---

## Phase 4: 残るフックを手直しする (US3、P2)

**Goal**: 残ったフックが判定の表のとおりになっている。初期値と止める対象が直っている

**Independent Test**: R1 の表を、2 つの定義ファイルと README の設定キーと比べる。表に無いフックと、「消す」としたのに残るフックが無い

**前提**: Phase 3

- [ ] T034 [US3] `tests/hooks/lib/hooks-definitions.test.ts` にテストを足す。登録したスクリプトと設定キーが、決めた一覧と同じ集合になる
- [ ] T035 [P] [US3] `git-no-verify-check` の期待を先に書く。初期値では何も返さず、有効にすると次の形を止める
  - `--no-verify`、`-n` のまとめ書き、引用符で囲んだ形
  - `-c core.hooksPath=`、`git config core.hooksPath`
  - `SKIP=`、`HUSKY=0`
- [ ] T036 [US3] `lib/core/git-no-verify-check.sh` を直し、T035 を通す。初期値を無効にする（スクリプトの既定と sample の両方）
- [ ] T037 [P] [US3] `lib/core/git-worktree-branch-check.sh` の対象から `develop-aist` を外す。テストを先に直す
- [ ] T038 [P] [US3] `git-sync` の初期値を無効にする。期待を先に直す
  - `lib/session-start/git-sync.sh` の既定と sample
  - `tests/hooks/session-start-git-sync.test.ts`
- [ ] T039 [US3] `p-w/hooks/hooks.json` の SessionStart の matcher に `compact` を足す。テストで 2 点を確かめる
  - compact では `.gitignore` の補完だけが動く
  - compact ではセッション名を返さない
- [ ] T040 [US3] `lib/` の関数とスクリプトを grep し、どこからも呼ばれないものを消す。knip と shellcheck を通す
- [ ] T041 [US3] `p-w/hooks/README.md` の設定キーの表で、`git-sync` と `git-no-verify-check` の初期値を直す
- [ ] T041a [US3] Copilot CLI 向けの定義で残る deny と allow の期待を、テストで固定する（SC-007）
  - `tests/hooks/lib/hooks-definitions.test.ts` と `integration.test.ts` に、Copilot CLI の形の hook 入力を足す
  - 対象は `gh pr create`・`gh issue create`・待機用のブランチへの commit・`tech-advisor-clone-allow`

---

## Phase 5: 作業中の Issue を git から求める (US6、P2)

**Goal**: 作業中の Issue が、remote とブランチ名の末尾の番号で決まる。`.pecot-active` を書かず、読まない

**Independent Test**: 紐づいたブランチを別の場所に clone し直す。`.pecot/state/` の無い状態で `pr_create` の下書きを作り、`Closes` が同じ Issue を指す

**契約**: contracts/work-target.md

**前提**: 無い。Phase 2〜4 と並べて進められる。重なるファイル（Parallel Example の一覧）では、先に main へ入った変更を取り込む

- [ ] T042 [US6] `src/domain/tests/branch-name.test.ts` に、契約の「求め方」の表の 6 行を入れる。落ちることを確かめる
- [ ] T043 [US6] `src/domain/branch-name.ts` に、作業中の Issue を返す規則を足す。入力は remote の owner/repo とブランチ名で、I/O を持たせない
- [ ] T044 [US6] `src/infra/git.ts` に、ディレクトリを受けて作業中の Issue を返す関数を足す。`gitCurrentBranch` と `primaryRemoteRepository` を使う
- [ ] T045 [US6] `tests/interface/create-branch.test.ts` の期待を先に直す
  - `.pecot-active` ができない
  - リポが違えば、いつも終了コード 2 になる
  - `allow_cross_repo`・`force_overwrite_active` を渡すと弾かれる
- [ ] T046 [US6] `src/commands/repository.ts` を直す
  - `guardActiveOverwrite` と入力 2 つを除く
  - `rejectCwdRepositoryMismatch` をいつも呼ぶ
  - 案内の文から `--allow-cross-repo` を除く
- [ ] T047 [US6] 作業対象の記録を直す。`src/commands/tests/work-target.test.ts` を先に直す
  - `src/commands/work-target.ts` と `src/infra/state-store.ts` で、`.pecot-active` を書かない
  - 題名のキャッシュと作業ディレクトリだけを作る
  - 結果の行を、作業ディレクトリを作った行に変える
- [ ] T048 [US6] `tests/interface/issue-quick.test.ts` の期待を先に直す。契約の `issue_quick` の表の行を期待する
  - `repo` がセッションのリポと違い、ブランチを作るときは、起票の前に終了コード 2 で止まる
  - `no_branch` のときは、リポが違っても起票する
- [ ] T049 [US6] `src/commands/issue-quick.ts` を直し、T048 を通す。`no_branch` のときは、作業ディレクトリだけを作る
- [ ] T050 [US6] `src/commands/pr.ts` を直す。`tests/interface/pr.test.ts` を先に直す
  - `Closes` の補完を、T044 の関数に変える
  - 片付けの対象を `.pecot-session-title` だけにする
- [ ] T051 [US6] `src/commands/session.ts` の `session_status` を直す。`tests/interface/session-status.test.ts` を先に直す
  - フラグの表をやめる
  - 作業中の Issue と、その題名・状態・本文を出す
- [ ] T052 [US6] `session_restore` を除く
  - `src/commands/session.ts` の `RESTORE`
  - `tests/interface/session-restore.test.ts`
  - parity の `session-restore-*` のシナリオと golden
- [ ] T053 [US6] コマンドの数を固定しているテストを直す（`tests/hook-tool-names.test.ts` は、T014 で残したときだけ直す）
  - `src/commands/tests/registry.test.ts`
  - `tests/parity/commands.ts`
- [ ] T054 [US6] `src/domain/state.ts` から、`FLAG_PECOT_ACTIVE` と `planWorkTarget` の `active` を除く。使わなくなった関数を、knip で洗って消す
- [ ] T055 [P] [US6] `session-title` の期待を先に直す。fixture に git のリポを作り、ブランチ名の末尾の番号でセッション名が決まることを期待する
  - `tests/hooks/lib/session-title.test.ts`
  - `tests/hooks/user-prompt-submit-title.test.ts`
- [ ] T056 [US6] `lib/core/session-title.sh` を直す。番号を `git -C "$CLAUDE_PROJECT_DIR"` のブランチ名から求める。ほかの出す条件は変えない
- [ ] T057 [US6] `lib/post-tool-use/exit-plan-remind.sh` を直す。`tests/hooks/post-exit-plan-mode.test.ts` を先に直す
  - 「作業中の Issue が無ければ出さない」を、ブランチ名からの判定に変える
- [ ] T058 [US6] `.pecot-active` を fixture に置くだけのテストを洗い、置くのをやめる
  - `tests/hooks/lib/cross-repository.test.ts`・`plan-mode-tool-guard.test.ts`
  - `tests/hooks/state-directory-resolution.test.ts`・`pre-tool-use-permission-mode.test.ts`
  - Phase 3 が先に入り、テストごと消えていれば飛ばす
- [ ] T059 [US6] `p-w/interface/authored.yaml` を、契約に合わせて直す
  - `create_branch`・`issue_quick`・`pr_create`・`pr_cleanup`・`session_status` の項目を直す
  - `session_restore` を除く
  - `generated.json` と `p-w/skills/w-help/references/commands.md` を作り直す
- [ ] T060 [P] [US6] `p-w/skills/w-active/SKILL.md` から、次の記述を除く
  - `.pecot-active` の確認
  - `force_overwrite_active` と `allow_cross_repo`
- [ ] T061 [P] [US6] `p-w/skills/w-quick/SKILL.md` から、別のリポの worktree で checkout する手順を除く。起票先は、セッションのリポにする
- [ ] T062 [P] [US6] `p-w/skills/w-help/references/flags.md` を、残る状態のファイルだけの表に書き直す
- [ ] T063 [P] [US6] `p-w/skills/w-help/references/issue-flow-rules.md` の §5・§6 を書き直す
  - 作業中の Issue を、remote とブランチ名で説明する
  - ガードの表から、上書きガードと `allow_cross_repo` を除く
- [ ] T064 [P] [US6] `p-w/agents/w-implementer.md` を直す。編集してよいリポを、作業中の worktree の remote のリポとする
  - `tests/hooks/lib/agent-definitions.test.ts` の期待を合わせる
- [ ] T065 [US6] `SPEC/quickstart.md` の 4 を実機で確かめ、結果を PR に貼る

---

## Phase 6: 計画の承認の後の案内を、スキルの frontmatter のフックに移す (US4、P2)

**Goal**: w-active か w-quick を起動したセッションにだけ、計画の承認の後の案内が出る。`.pecot-quick-mode` が無い

**Independent Test**: 同じ worktree に 2 つのセッションを開き、片方で w-quick を起動して計画を承認する。そのセッションにだけ、計画の更新の案内が出る

**契約**: contracts/hook-behavior.md の「計画の承認の後の案内」

**前提**: Phase 1（T001・T002 の結果）、Phase 3、Phase 5（T057）

- [ ] T066 [US4] `tests/hooks/post-exit-plan-mode.test.ts` の期待を先に書く
  - `--mode=active` は、計画の更新と実装の引き継ぎを出す
  - `--mode=quick` は、計画の更新だけを出す
  - `.pecot-quick-mode` があっても読まない
- [ ] T067 [US4] `lib/post-tool-use/exit-plan-remind.sh` に `--mode=active|quick` を足す。`.pecot-quick-mode` の読み取りと削除を除く
- [ ] T068 [US4] `p-w/skills/w-active/SKILL.md` の frontmatter に `hooks` を足す。パスの書き方は T002 の結果に従う
  - フックの形: PostToolUse、matcher `ExitPlanMode`、`once: true`、引数 `--mode=active`
- [ ] T069 [US4] `p-w/skills/w-quick/SKILL.md` の frontmatter に、同じ形で `--mode=quick` のフックを足す
- [ ] T070 [US4] 2 つの定義ファイルから、ExitPlanMode のエントリを外す。`p-w/hooks/post-tool-use-exit-plan-mode.sh` を消す
- [ ] T071 [US4] `.pecot-quick-mode` を消す。`tests/interface/issue-quick.test.ts` を先に直す
  - `src/domain/state.ts` の定数
  - `src/commands/issue-quick.ts` の `touchFlag`
  - `src/commands/pr.ts` の片付け
  - `p-w/interface/authored.yaml` の記述
- [ ] T072 [US4] `tests/skills/` にテストを足す。w-active と w-quick の `hooks` が決めた形で、呼ぶスクリプトがある
- [ ] T073 [US4] スキルの frontmatter を検証するテストや lint が `hooks` を弾かないかを確かめる。弾くなら許す
- [ ] T074 [US4] `SPEC/quickstart.md` の 3 を実機で確かめ、結果を PR に貼る。Copilot CLI で w-quick がエラーにならないことも確かめる

---

## Phase 7: w-breakdown を、分解のタスクのブランチで動かす (US6、P2)

**Goal**: w-breakdown が、分解の作業をタスクとして Epic の下に起票し、そのブランチで speckit を進める

**Independent Test**: 検証用の Epic で w-breakdown を起動する。Epic の下にタスクができて Active に載り、`NNN-<名前>` のブランチができない

**契約**: contracts/work-target.md の「w-breakdown」

**前提**: Phase 1（T004 の結果）、Phase 5

- [ ] T075 [US6] `p-w/skills/w-breakdown/SKILL.md` に、タスクを起票する手順を足す
  - 対象の Epic を決めた後、`issue_quick` を `parent_epic` 付きで呼ぶ
  - 結果のブランチを checkout する
- [ ] T076 [US6] 同じ SKILL.md に、speckit の git 拡張の扱いを書く
  - ブランチを作る場面では、`GIT_BRANCH_NAME` に今のブランチ名を渡し、`--allow-existing-branch` を付ける
  - 拡張が無いリポでは、何もしない
- [ ] T077 [US6] 同じ SKILL.md に、再開の手順を書く。`.specify/feature.json` が無いときは、`specs/` の該当のディレクトリを指す形で書き直す
- [ ] T078 [US6] 同じ SKILL.md の終わりを直す。成果物を w-pr でタスクを閉じる PR にし、その後に w-issueize へ進む
- [ ] T079 [US6] スキルの文を確かめる既存のテスト（`tests/skills/`）を通す。ツールの名前と入力の書き方を、ほかのスキルに合わせる
- [ ] T080 [US6] `SPEC/quickstart.md` の 5 を実機で確かめ、結果を PR に貼る

---

## Phase 8: README と実機の記録を、現行の版にする (US5、P3)

**Goal**: `p-w/hooks/README.md` が、残ったフック・推奨設定・対応バージョン・実機の記録を、現行の版で載せている

**Independent Test**: README の対応バージョンの表と実機の記録の表に、確かめた版と日付がある。R6 の表のすべての行に、対応が書かれている

**前提**: Phase 2〜7

- [ ] T081 [US5] `p-w/hooks/README.md` に、推奨設定の節を足す
  - pecot のマーケットプレイスの自動更新
  - Claude Code の通知（`preferredNotifChannel`・プッシュ通知・端末の状態の表示）
  - Copilot CLI の通知（`beep`・`notifications`）
- [ ] T082 [US5] Copilot CLI の `beep: true` がターンの完了で鳴るかを実機で確かめ、T081 の書き方を決める
- [ ] T083 [US5] `p-w/hooks/README.md` の状態の表を、`SPEC/data-model.md` の「状態の置き場」に合わせる
- [ ] T084 [US5] `SPEC/research.md` の R6 で「使っていないことを確かめる」とした項目を、grep で確かめる。使っていれば直す（FR-051）
- [ ] T085 [US5] 現行の両クライアントで、残ったフックを 1 つずつ動かす。`p-w/hooks/README.md` の実機の記録の表を書き直す
  - 版・日付・結果を書く
  - `SPEC/quickstart.md` の 6 の表の行を、すべて含める
- [ ] T086 [US5] `p-w/hooks/README.md` の対応バージョンを直す。最低対応版を、frontmatter のフックを確かめた版に上げ、根拠を書く
- [ ] T087 [US5] README と実物を比べるテスト（`tests/hooks/readme-flow-table-sync.test.ts` など）を通す
- [ ] T088 `SPEC/research.md` の R1 の表を、最後に見直す。2 つの定義ファイル・sample・README と比べ、食い違いを直す（SC-005）

---

## Dependencies

```text
Phase 1 ──────────────┬──────────────► Phase 6
                      └──────────────► Phase 7
Phase 2 ► Phase 3 ► Phase 4
          Phase 3 ───────────────────► Phase 6
Phase 5 ─────────────────────────────► Phase 6
Phase 5 ─────────────────────────────► Phase 7
Phase 2〜7 ──────────────────────────► Phase 8
```

| ストーリー | フェーズ | ほかのストーリーへの依存 |
|---|---|---|
| US1 | 2 | 無い |
| US2 | 3 | US1（同じスクリプトを触る） |
| US3 | 4 | US2 |
| US6 | 5・7 | 無い |
| US4 | 6 | US2・US6 |
| US5 | 8 | すべて |

## Parallel Example

- Phase 1 は、T003 と T004 を T001 と並べて進められる
- Phase 5 は、Phase 2〜4 と別の担当で並べて進められる。重なるファイルは次のとおり
  - `src/commands/pr.ts`
  - `src/commands/issue-quick.ts`
  - `src/domain/state.ts`
  - `tests/hooks/` のうち、Phase 3 が消すスクリプトのテスト
  - `p-w/interface/authored.yaml`
- Phase 5 の中では、文書の T060〜T064 を並べて進められる

## Implementation Strategy

- 最小の出荷は Phase 2（US1）だ。承認が無くなるだけで、利用者の体験が変わる
- Phase 3 までで、SC-001・SC-004 を満たす
- Phase 5 は、クラウドのセッションでの作業に要る。Phase 2〜4 を待たずに始める
- Phase 6 は、Phase 1 の結果で形が変わる。frontmatter のフックが登録されないときは、今の `hooks.json` のエントリを残す
