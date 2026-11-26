# Contract: スレッドの GitHub の読み書きと、使う手

スレッドが使う pecot-workflow の GitHub の読み書きを、この表の手に移す（FR-013〜FR-019）。
GitHub Actions だけで動く処理（`auto_*`・`review_finish`・`board_sync`・`tracker_sync`）は `actions/` に移し、この表に載せない（FR-010・FR-012）。

調べた元:

- GitHub MCP Server のソース: github/github-mcp-server の commit `7edc2dd123a8923db389de8772170663cb2d8e17`（2026-11-25）。ツールの入力は `pkg/github/__toolsnaps__/*.snap`、Insiders は `docs/insiders-features.md`
- pecot-workflow の呼び出し: `plugins/pecot-workflow/cli/src/infra/github/` と、それを呼ぶ `commands/`
- クラウドのスレッドでの確かめ（2026-11-26、利用者がスレッドに残した記録）
- このスレッドでの確かめ（2026-11-26）: claude.ai のコネクタの GitHub 公式の MCP で、sandbox の Issue（pecotcraft/pecot-sandbox#632、題に `[cuj 756-m7q2]`）に書いた。クラウドのスレッドと同じく claude.ai のサーバーからつなぐ MCP

「手」の列の値:

- `公式の MCP`: GitHub MCP Server の一般のツールにある
- `Insiders`: `/insiders` の URL か `X-MCP-Insiders: true` のときだけ出る試験中のツール
- `actions/`: 公式の MCP に無いので、`actions/` のワークフローの中で行う。スキルが `actions_run_trigger` で起動する（FR-016）

## 1. 公式の MCP で行う

| 読み書き | 今の pecot-workflow のツール | GitHub 公式の MCP のツール | 2026-11-26 の実物 |
|---|---|---|---|
| Issue の起票・題・本文・ラベル・Issue type・milestone | `issue_create`・`issue_edit` | `issue_write`（create・update）・`update_issue_*` | 起票・ラベルは通った |
| Issue を閉じる・開き直す（`state_reason`） | `session_finish`・`issue_reopen` | `issue_write`（update の `state`・`state_reason`） | 2026-11-26 に通った。`not_planned`・`completed`・開き直し（`reopened`）が、そのとおり残った |
| Issue fields の値を書く・消す | `issue_create`・`issue_edit` の `attributes` | `issue_write` の `issue_fields`（single select は `field_option_name`、日付は `value`、消すときは `delete: true`） | 2026-11-26 に通った。書く・消すの両方 |
| 親（sub-issue） | `issue_create` の `parent_epic` | `sub_issue_write`・`issue_write` の `parent_issue_number` | `sub_issue_write` は通った |
| Issue へのコメント | `issue_comment` | `add_issue_comment`・`update_issue_comment` | 通った。本文は変わらない |
| Issue・PR・ボードの読み取り | `issue_show`・`issue_check`・`board_show`・`pr_show`・`pr_check` | `issue_read`・`list_issues`・`search_issues`・`pull_request_read`・`projects_get`・`projects_list` | 通った |
| ボードに足す・外す | `board_add`・`issue_create` | `projects_write`（`add_project_item`・`delete_project_item`） | 未確認（Phase 2） |
| 進行の欄・ボードのフィールドを書く・消す | `board_move`・`session_start`・`issue_edit` | `projects_write`（`update_project_item`。Issue の番号で item を引き、single select は値の名前で渡し、`null` で消す） | 未確認（Phase 2） |
| アーカイブした item を戻す | `issue_reopen` | `projects_write` で外して足し直し、欄を書き直す | 未確認（Phase 2） |
| ボードとビューを作る | `project_create` | `projects_write`（`create_project`・`create_project_view`） | 未確認（Phase 2） |
| ブランチを作る | `session_start` | `create_branch` | 通った |
| PR を作る・本文・draft・base を変える | `pr_create`・`pr_restack` | `create_pull_request`・`update_pull_request` | 作成は通った。本文は変わらない |
| PR のブランチを base に追いつかせる | `pr_restack` | `update_pull_request_branch` | 未確認（Phase 2） |
| 担当者・レビュアー | `issue_create`・`pr_create` | `issue_write` の `assignees`・`update_pull_request` の `reviewers` | 担当者は 2026-11-26 に通った。レビュアーは、作った人と別の人が要るので Phase 2 |
| リリース・タグの読み取り | `release_check` | `list_releases`・`get_latest_release`・`get_release_by_tag`・`list_tags` | `list_releases`・`list_tags` は 2026-11-26 に通った（sandbox にはまだ無いので空） |
| ブランチ間の commit の数 | `release_check` | `list_commits` を数える | 2026-11-26 に通った |
| リポの持ち主の種類・既定のブランチ | `project_*`・`release_*` | 既定のブランチは `search_repositories`（`minimal_output: false`）。持ち主の種類は返らない | 既定のブランチは 2026-11-26 に引けた。持ち主の種類を返す手は無かった（`search_repositories` の結果に持ち主の種類が無く、`search_users` は人だけを探す）。作ったボードは設定の `board_url` の `/orgs/`・`/users/` で分かるが、ボードを作る前に要る `create_project` の `owner_type` は、`actions/` の `github-ops` で読む |
| ファイルの commit | （git） | `push_files`・`create_or_update_file` | 通った |
| `actions/` のワークフローを起動して結果を読む | なし（新しい） | `actions_run_trigger`・`actions_get`・`actions_list` | リモート MCP の actions の toolset は未確認（Phase 2）。セッション付属の GitHub MCP では起動できた |

## 2. Insiders で行う

| 読み書き | 今の pecot-workflow のツール | GitHub 公式の MCP のツール | 2026-11-26 の実物 |
|---|---|---|---|
| 前提（blocked-by）を付ける・外す・読む | `issue_create` の `blocked_by`・`issue_block`・`issue_unblock`・`issue_show` | `issue_dependency_write`・`issue_dependency_read` | 未確認（Phase 2） |

## 3. `actions/` で行う

| 読み書き | 今の pecot-workflow のツール | 今の呼び方 | 2026-11-26 の実物 |
|---|---|---|---|
| ブランチと Issue のつながり（Development 欄） | `session_start` | GraphQL `createLinkedBranch` | sandbox で、`workflow_dispatch` のワークフローが `GITHUB_TOKEN` で作れた |
| スタック PR の登録・読み取り | `pr_create`・`pr_merge` | REST Stacks API | 未確認（Phase 2） |
| 非同期のマージ（sandbox で画面のマージを再現する） | `pr_merge` | REST `merge-async` | 未確認（Phase 2） |
| ボードのフィールドを作る・名前を変える・消す・選択肢を直す | `project_init` | GraphQL `createProjectV2Field`・`updateProjectV2Field`・`deleteProjectV2Field` | 未確認（Phase 2） |
| リポをボードにつなぐ | `project_link` | GraphQL `linkProjectV2ToRepository` | 未確認（Phase 2） |
| Actions の secret と variable の名前の一覧 | `workflow_doctor` | REST `/actions/secrets`・`/actions/variables` | 未確認（Phase 2） |
| リリースを作る | `release_create` | REST `POST /releases` | 未確認。タグの push はクラウドの VM のプロキシが拒む |

## 4. 行わない

| 読み書き | 扱い |
|---|---|
| リモートのブランチを消す（`session_finish`・`branch_delete`・`release_merge`） | pecot は消さない。リポの「head ブランチを自動で消す」設定に任せる（FR-018） |
| マージ（`pr_merge` の本来の使い方） | 利用者が GitHub の画面で行う |
