# 検証: 機能の行き先の一覧（Phase 5）

Issue #792（T038）の記録。Phase 5 を始める前の pecot-workflow の MCP の 45 個のツールと、Actions のワークフローの処理が、どこへ行くかを並べる（FR-021）。

行き先は 3 つ。

- 残す: pecot-workflow の MCP のツールのまま残す
- `actions/` へ移す: `actions/<処理>/` の action にする。MCP からは消す
- 消す: どこにも残さない

## MCP のツール

| ツール | 行き先 | 移す先・補足 |
|---|---|---|
| `auto_finish` | `actions/` へ移す | `actions/auto-finish`。w-auto は結果のファイルを書き、ワークフローの Finish の step が呼ぶ |
| `auto_gate` | `actions/` へ移す | `actions/auto-gate` |
| `auto_start` | `actions/` へ移す | `actions/auto-start`。文脈は JSON のファイルで w-auto に渡す |
| `board_add` | 残す | |
| `board_move` | 残す | |
| `board_show` | 残す | |
| `board_sync` | `actions/` へ移す | `actions/board-sync` |
| `branch_delete` | 残す | |
| `issue_attributes` | 残す | |
| `issue_block` | 残す | |
| `issue_check` | 残す | |
| `issue_comment` | 残す | |
| `issue_create` | 残す | |
| `issue_edit` | 残す | |
| `issue_reopen` | 残す | |
| `issue_show` | 残す | |
| `issue_unblock` | 残す | |
| `pr_check` | 残す | |
| `pr_create` | 残す | |
| `pr_merge` | 残す | |
| `pr_restack` | 残す | |
| `pr_show` | 残す | |
| `project_activate` | 残す | |
| `project_create` | 残す | |
| `project_get` | 残す | |
| `project_init` | 残す | |
| `project_link` | 残す | |
| `project_list` | 残す | |
| `project_search` | 残す | |
| `project_set` | 残す | |
| `project_unset` | 残す | |
| `release_check` | 残す | Actions で動かす版は Phase 7（T082・T083）で `actions/release-check` に足す |
| `release_create` | 残す | |
| `release_merge` | 残す | |
| `review_finish` | `actions/` へ移す | `actions/review-finish` |
| `session_finish` | 残す | 入力 `skip_local_cleanup` だけを消す。GitHub 側の片付けは `libs/workflow-core` に移し、`actions/session-finish` と共有する |
| `session_show` | 残す | |
| `session_start` | 残す | |
| `tracker_sync` | `actions/` へ移す | `actions/tracker-sync`（`source` で security・dependabot を選ぶ） |
| `workflow_doctor` | 残す | `npx` で CLI を呼ぶ古い雛形を `outdated` で返す |
| `workflow_install` | 残す | 雛形の `@pecot-actions/v<版>` を commit の SHA に直して置く |
| `worktree_add` | 残す | |
| `worktree_init` | 残す | |
| `worktree_link` | 残す | |
| `worktree_remove` | 残す | |

残すのは 39 個、`actions/` へ移すのは 6 個、消すのは 0 個。

## Actions のワークフローの処理

| ワークフロー | 処理 | 今の呼び方 | 行き先 |
|---|---|---|---|
| 雛形 `pecot-board-sync.yml` | マージ後の片付け | `npx @pecot/workflow-mcp session finish --skip-local-cleanup --delete-branch` | `actions/session-finish`。ブランチは消さない（FR-018） |
| 雛形 `pecot-board-sync.yml` | ボードの同期 | `npx @pecot/workflow-mcp board sync` | `actions/board-sync` |
| 雛形 `pecot-review.yml` | レビューの後始末 | `npx @pecot/workflow-mcp review finish --ensure` | `actions/review-finish` |
| 雛形 `pecot-auto.yml` | 起動の判定 | `npx @pecot/workflow-mcp auto gate` | `actions/auto-gate` |
| 雛形 `pecot-auto.yml` | 着手・結果の報告 | w-auto の AI が `auto_start`・`auto_finish` を呼ぶ | AI の前後の step の `actions/auto-start`・`actions/auto-finish` |
| 雛形 `pecot-auto.yml` | 準備の不足の報告 | `npx @pecot/workflow-mcp auto finish --result setup-missing` | `actions/auto-finish` |
| 雛形 `pecot-handoff.yml` | マージの引き継ぎ | claude-code-action で w-handoff を動かす | 変えない（AI の処理） |
| このリポの `security-alerts.yml` | security の Tracker | `plugins/pecot-workflow/bin/pecot tracker sync security` | `uses: ./actions/tracker-sync` |
| このリポの `dependabot-prs.yml` | Dependabot の Tracker | `plugins/pecot-workflow/bin/pecot tracker sync dependabot` | `uses: ./actions/tracker-sync` |

雛形は `actions/templates/` に移し、`uses: pecotcraft/pecot/actions/<処理>@pecot-actions/v<版>` で呼ぶ。このリポの写しは `uses: ./actions/<処理>` で呼ぶ。

## 作り替えた後（Phase 9）

Issue #799（T156）の記録。上の 45 個のツールと Actions の処理を、作り替えた後の手と突き合わせた（SC-007）。

使えなくなった機能は、`branch_delete` のリモートのブランチの削除だけである。pecot はリモートのブランチを消さず（FR-018）、マージした PR の head はリポの「head ブランチを自動で消す」（`delete_branch_on_merge`）で GitHub が消す。
pecot-workflow の MCP のツールは 25 個になり、どれも GitHub の API を呼ばない。cli から GitHub の client を辿れないことは、eslint の決まりと `cli/tests/sc005-no-github-io.test.ts` が止める。

### MCP のツール

| 前のツール | 今の手 |
|---|---|
| `auto_finish`・`auto_gate`・`auto_start` | `actions/auto-finish`・`actions/auto-gate`・`actions/auto-start` |
| `board_add` | `board_check` に通してから、公式の MCP の `projects_write`（`add_project_item`・`update_project_item`） |
| `board_move` | `board_check` に通してから、`projects_write`（`update_project_item`） |
| `board_show` | `board_show`。ボードは公式の MCP で読み、`reads` で渡す |
| `board_sync` | `actions/board-sync` |
| `branch_delete` | なし。`delete_branch_on_merge` に任せる |
| `issue_attributes` | `issue_check` に通してから、`issue_write`（`issue_fields`・`type`）と `projects_write` |
| `issue_block`・`issue_unblock` | `issue_dependency_check` に通してから、`issue_dependency_write` と `projects_write` |
| `issue_check` | `issue_check`。`issue_write` に渡す値を確かめる |
| `issue_comment` | `issue_comment_check` に通してから、`add_issue_comment`・`update_issue_comment` |
| `issue_create` | `issue_check`（`create`）に通してから、`issue_write`・`sub_issue_write`・`issue_dependency_write`・`projects_write` |
| `issue_edit` | `issue_check`（`update`）に通してから、`issue_write` |
| `issue_reopen` | `projects_write`（`add_project_item`）でカードを戻し、`issue_check`（`update`）に通してから `issue_write`（`state: open`）で開く。手順は `skills/w-help/references/issue-reopen.md` |
| `issue_show` | 公式の MCP の `issue_read` |
| `pr_check` | `pr_check`（`create`・`update`・`merge`） |
| `pr_create` | `pr_check`（`create`）に通してから、`create_pull_request`。スタック PR は github-ops の `stack-register` |
| `pr_merge` | `pr_check`（`merge`）に通してから、`merge_pull_request`。feature PR は利用者が画面でマージする |
| `pr_restack` | `pr_restack`。手元の git の rebase と push だけを行う |
| `pr_show` | 公式の MCP の `pull_request_read` |
| `project_activate`・`project_get`・`project_link`・`project_list`・`project_set`・`project_unset` | 同じ名前のツール。手元の設定ファイルだけを読み書きする。`project_activate` はボードを `reads` で受ける |
| `project_create` | `project_check`（`create`）に通してから、`projects_write`（`create_project`）。欄とビューは github-ops の `project-fields`・`project-view` |
| `project_init` | `project_check`（`fields`）に通してから、github-ops の `project-fields`・`project-view` |
| `project_search` | 公式の MCP の `projects_list`（`list_projects`） |
| `release_check` | `release_check`（MCP）と `actions/release-check`（Actions） |
| `release_create` | `release_check` に通してから、github-ops の `release-create` |
| `release_merge` | `pr_check`（`merge`）に通してから、`merge_pull_request` |
| `review_finish` | `actions/review-finish` |
| `session_finish` | `session_finish`（手元の片付け）と `actions/session-finish`（GitHub 側の片付け） |
| `session_show`・`session_start` | 同じ名前のツール。`session_start` は手元に作業を記録するだけで、ブランチは `branch_check` に通してから github-ops の `link-branch` で作る |
| `tracker_sync` | `actions/tracker-sync`（`source` は security・dependabot・issue-surface） |
| `workflow_doctor` | `workflow_doctor`。secret・variable の名前と置いた雛形は、github-ops の `workflow-doctor` で読んで渡す |
| `workflow_install` | `workflow_install` |
| `worktree_add`・`worktree_init`・`worktree_link`・`worktree_remove` | 同じ名前のツール |

### Actions の処理とこのリポの運用

| 処理 | 今の手 |
|---|---|
| 上の表の Actions の処理 | 上の表の行き先のとおり。雛形は `actions/templates/` にある |
| Issue の機能の写しと今のスキーマの比べ（`issue-surface-drift.yml`） | `uses: ./actions/tracker-sync`（`source: issue-surface`）。前は cli の `scripts/github-surface/drift.ts` が GitHub の client で書いていた |
| 試験環境を比べる・片付ける（`sandbox-diff.sh`・`sandbox-sweep.sh`） | このリポの `sandbox-ops.yml` を、公式の MCP の `actions_run_trigger` で起動する。手順は `plugins/pecot-workflow/CONTRIBUTING.md` の「3. 試験環境」 |
