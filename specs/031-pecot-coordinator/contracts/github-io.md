# Contract: スレッドの GitHub の読み書きと、使う手

スレッドが使う pecot-workflow の GitHub の読み書きを、この表の手に移す（FR-013〜FR-019）。
GitHub Actions だけで動く処理（`auto_*`・`review_finish`・`board_sync`・`tracker_sync`）は `actions/` に移し、この表に載せない（FR-010・FR-012）。

調べた元:

- GitHub MCP Server のソース: github/github-mcp-server の commit `7edc2dd123a8923db389de8772170663cb2d8e17`（2026-11-25）。ツールの入力は `pkg/github/__toolsnaps__/*.snap`、Insiders は `docs/insiders-features.md`
- pecot-workflow の呼び出し: `plugins/pecot-workflow/cli/src/infra/github/` と、それを呼ぶ `commands/`
- クラウドのスレッドでの確かめ（2026-11-26、利用者がスレッドに残した記録）
- このスレッドでの確かめ（2026-11-26）: claude.ai のコネクタの GitHub 公式の MCP で、sandbox の Issue（pecotcraft/pecot-sandbox#632、題に `[cuj 756-m7q2]`）に書いた。クラウドのスレッドと同じく claude.ai のサーバーからつなぐ MCP
- Phase 2 の確かめ（2026-11-26、#789）: claude.ai のコネクタを toolset ごとに 3 つ（`/x/projects`・`/insiders`・`/x/actions`）つなぎ、sandbox で動かした。操作と結果は [verification/github-io.md](../verification/github-io.md)

「手」の列の値:

- `公式の MCP`: GitHub MCP Server の一般のツールにある
- `Insiders`: `/insiders` の URL か `X-MCP-Insiders: true` のときだけ出る試験中のツール
- `actions/`: 公式の MCP に無いので、`actions/` のワークフローの中で行う。スキルが `actions_run_trigger` で起動する（FR-016）

つなぐ URL は 1 つにつき toolset を 1 つしか選べない。
claude.ai のコネクタはヘッダーを渡せないので、既定の toolset と Insiders（`/insiders`）、`projects`（`/x/projects`）、`actions`（`/x/actions`）の 3 つのコネクタに分けてつなぐ。
GitHub Copilot CLI は、組み込みの GitHub MCP に `--add-github-mcp-toolset projects`・`--add-github-mcp-toolset actions` を足し、設定の `githubMcpInsiders` で Insiders を有効にする。

## 1. 公式の MCP で行う

| 読み書き | 今の pecot-workflow のツール | GitHub 公式の MCP のツール | 2026-11-26 の実物 |
|---|---|---|---|
| Issue の起票・題・本文・ラベル・Issue type・milestone | `issue_create`・`issue_edit` | `issue_write`（create・update）・`update_issue_*` | 起票・ラベルは通った |
| Issue を閉じる・開き直す（`state_reason`） | `session_finish`・`issue_reopen` | `issue_write`（update の `state`・`state_reason`） | 閉じるのは `not_planned`・`completed` が、そのとおり残った。開き直しは `state: open` だけを渡す。Phase 2 では `state_reason: reopened` が入力の検証で断られ、渡さずに開くと GitHub が `REOPENED` にした |
| Issue fields の値を書く・消す | `issue_create`・`issue_edit` の `attributes` | `issue_write` の `issue_fields`（single select は `field_option_name`、日付は `value`、消すときは `delete: true`） | 2026-11-26 に通った。書く・消すの両方 |
| 親（sub-issue） | `issue_create` の `parent_epic` | `sub_issue_write`・`issue_write` の `parent_issue_number` | `sub_issue_write` は通った |
| Issue へのコメント | `issue_comment` | `add_issue_comment`・`update_issue_comment` | 通った。本文は変わらない |
| Issue・PR・ボードの読み取り | `issue_show`・`issue_check`・`board_show`・`pr_show`・`pr_check` | `issue_read`・`list_issues`・`search_issues`・`pull_request_read`・`projects_get`・`projects_list` | 通った |
| ボードに足す・外す | `board_add`・`issue_create` | `projects_write`（`add_project_item`・`delete_project_item`） | 通った |
| 進行の欄・ボードのフィールドを書く・消す | `board_move`・`session_start`・`issue_edit` | `projects_write`（`update_project_item`。Issue の番号で item を引き、single select は値の名前で渡し、`null` で消す） | 通った。single select・日付を書いて、`null` で消せた |
| アーカイブした item を戻す | `issue_reopen` | `projects_write` で外して足し直し、`Status` を `null` で消してから欄を書き直し、最後に `issue_write` で開く | 通った。アーカイブした item は書き換えられず、足し直すと欄が消えた別の item になる。`Status` が `Done` のまま開くと、ボードの自動化が Issue を閉じ直す。この順で、`issue_reopen` と同じ状態に戻った |
| ボードとビューを作る | `project_create` | `projects_write`（`create_project`・`create_project_view`） | 通った。pecot の欄と、ビューの列・行の分け方は作れないので、`actions/` の `project-fields`・`project-view` で足す |
| ブランチを作る | `session_start` | `create_branch` | 通った |
| PR を作る・本文・draft・base を変える | `pr_create`・`pr_restack` | `create_pull_request`・`update_pull_request` | 作成は通った。本文は変わらない |
| スタック PR を親のマージの後に載せ替える | `pr_restack` | 行わない。Stacks に登録した PR は、親のマージの後に GitHub が載せ替える | 通った。`update_pull_request_branch` はスタック PR を 403 で断った |
| 担当者・レビュアー | `issue_create`・`pr_create` | `issue_write` の `assignees`・`update_pull_request` の `reviewers` | 通った。App が作った PR に、利用者をレビュアーとして頼めた。今の `pr_create` はレビュアーを頼まない |
| リリース・タグの読み取り | `release_check` | `list_releases`・`get_latest_release`・`get_release_by_tag`・`list_tags` | `list_releases`・`list_tags` は 2026-11-26 に通った（sandbox にはまだ無いので空） |
| ブランチ間の commit の数 | `release_check` | `list_commits` を数える | 2026-11-26 に通った |
| リポの持ち主の種類・既定のブランチ | `project_*`・`release_*` | 既定のブランチは `search_repositories`（`minimal_output: false`）。持ち主の種類は `get_me` の login と比べ、同じなら人、違えば組織とする | 通った。ボードを作れるのは自分か、自分が入っている組織だけなので、login と違う持ち主は組織になる |
| ファイルの commit | （git） | `push_files`・`create_or_update_file` | 通った |
| `actions/` のワークフローを起動して結果を読む | なし（新しい） | `actions_run_trigger`・`actions_list`・`actions_get`・`get_job_logs` | 通った。起動は run の ID を返さないので、`run-name` に入れた値を `list_workflow_runs` の `display_title` で探す。job summary を読むツールは無いので、結果は `get_job_logs` でログの行から読む |

## 2. Insiders で行う

| 読み書き | 今の pecot-workflow のツール | GitHub 公式の MCP のツール | 2026-11-26 の実物 |
|---|---|---|---|
| 前提（blocked-by）を付ける・外す・読む | `issue_create` の `blocked_by`・`issue_block`・`issue_unblock`・`issue_show` | `issue_dependency_write`・`issue_dependency_read` | 通った。前提だけを書くので、カードの `Blocked` への移動は `projects_write` で別に行う |

## 3. `actions/` で行う

token の列の値は、[contracts/actions-interface.md](actions-interface.md) の 2 節に書く。

| 読み書き | 今の pecot-workflow のツール | 今の呼び方 | 2026-11-26 の実物 |
|---|---|---|---|
| ブランチと Issue のつながり（Development 欄） | `session_start` | GraphQL `createLinkedBranch` | 通った |
| スタック PR の登録・読み取り | `pr_create`・`pr_merge` | REST Stacks API | 通った |
| ボードのフィールドを作る・名前を変える・消す・選択肢を直す | `project_init` | GraphQL `createProjectV2Field`・`updateProjectV2Field`・`deleteProjectV2Field` | 通った |
| ビューの列・行の分け方 | `project_create` | REST `POST /orgs/{org}/projectsV2/{number}/views` の `group_by`・`vertical_group_by` | 通った |
| リポをボードにつなぐ | `project_link` | GraphQL `linkProjectV2ToRepository` | 通った |
| リポの「head ブランチを自動で消す」設定を読む | なし（新しい。FR-018） | REST `GET /repos/{owner}/{repo}` の `delete_branch_on_merge` | 通った。公式の MCP の `search_repositories` は返さない |
| Actions の secret と variable の名前の一覧 | `workflow_doctor` | REST `/actions/secrets`・`/actions/variables` | 試した 3 つの token は、どれも権限が無く 403 だった |
| リリースを作る | `release_create` | REST `POST /releases` | 通った |

## 4. 行わない

| 読み書き | 扱い |
|---|---|
| リモートのブランチを消す（`session_finish`・`branch_delete`・`release_merge`） | pecot は消さない。リポの「head ブランチを自動で消す」設定に任せる（FR-018） |
| マージ（`pr_merge` の本来の使い方） | 利用者が GitHub の画面で行う |
| 非同期のマージ（`merge-async`。sandbox で画面のマージを再現する） | merge queue のあるリポでは、Actions の token も公式の MCP の `merge_pull_request` も、キューに入れられなかった。sandbox の CUJ では、今の `pr merge` と同じく、手元の利用者の token で入れる |
