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
