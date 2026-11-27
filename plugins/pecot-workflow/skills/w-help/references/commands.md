<!-- このファイルは生成物です。手で直さず、`pnpm -C libs/interface-spec exec tsx src/cli.ts commands-md --write` で作り直してください。 -->

# ツール一覧

入力と詳しい振る舞いは、MCP のツールの定義（tools/list）で確かめてください。

## board

| ツール | 説明 |
| --- | --- |
| `board_add` | Add an Issue to the project board with a GraphQL mutation (for an Issue created outside pecot) |
| `board_move` | Update the status of an Issue on the project board by Issue number (pecot commands normally set the status themselves) |
| `board_show` | Show the dashboard of the project board |

## branch

| ツール | 説明 |
| --- | --- |
| `branch_delete` | Delete a remote branch (a protected branch is never deleted) |

## issue

| ツール | 説明 |
| --- | --- |
| `issue_attributes` | List the attributes an Issue of the repository can have: fields of the configured board, Issue fields, and built-in ones |
| `issue_block` | Add a blocked-by (prerequisite) to an Issue, or change the wait kind and reason of an existing one |
| `issue_check` | Check Markdown files for issue create and show their order numbers, prerequisites and how to proceed, without creating anything |
| `issue_comment` | Post a comment on an Issue |
| `issue_create` | Create Issues from Markdown files with frontmatter |
| `issue_edit` | Write, change or remove the values of the attributes of an Issue by name (the attributes that issue_attributes lists) |
| `issue_reopen` | Reopen a closed Issue (also sets the status on the board) |
| `issue_show` | Fetch Issue details efficiently (GraphQL, only the needed fields) |
| `issue_unblock` | Remove a blocked-by (prerequisite) from an Issue |

## pr

| ツール | 説明 |
| --- | --- |
| `pr_check` | Show all the information to check before creating a PR |
| `pr_create` | Create a PR (pull request) |
| `pr_merge` | Merge a PR with the asynchronous merge API (a PR in a stack must be the bottom one) |
| `pr_restack` | Restack the current branch onto the new position of its base branch |
| `pr_show` | Get PR details efficiently (GraphQL, only the needed fields) |

## project

| ツール | 説明 |
| --- | --- |
| `project_activate` | Activate an initialized project |
| `project_create` | Create a new project with the pecot-workflow fields, and the pecot-lane field and the Lanes view from lanes (to add the fields to an existing project, use project init) |
| `project_get` | Show the value of a key of the project config (aggregation_repo: the Epic aggregation repository) |
| `project_init` | Add the pecot-status field to an existing project, rename the old suffixed workflow field to pecot-status, add the Blocked and Needs Attention options to the fields that already exist, and add the lanes to the pecot-lane field with a Lanes view. The fields pecot does not use (pecot-priority, pecot-size, and the old suffixed workflow field when pecot-status also exists) are listed in migration.pending_delete, and deleted only with confirm_delete |
| `project_link` | Add or update a repository in the project config |
| `project_list` | List available projects |
| `project_search` | Search projects through the GitHub API, and show which are initialized and which is active |
| `project_set` | Set a key of the project config (aggregation_repo: the Epic aggregation repository) |
| `project_unset` | Clear a key of the project config; without aggregation_repo, creating an Epic needs the target repository given explicitly |

## release

| ツール | 説明 |
| --- | --- |
| `release_check` | Run the pre-release checks; for an nx repository only the alerts are checked |
| `release_create` | Create a GitHub release and its tag (the release notes come from the CHANGELOG) |
| `release_merge` | Merge a release PR with a regular merge |

## session

| ツール | 説明 |
| --- | --- |
| `session_finish` | Clean up after a merged PR (close related Issues, delete branches, local cleanup) |
| `session_show` | Show the branch, repository and work Issue of the session |
| `session_start` | Create a branch linked to an Issue (shown in the Development section of the Issue) |

## workflow

| ツール | 説明 |
| --- | --- |
| `workflow_doctor` | Check that the repository has the workflow file and the settings it needs |
| `workflow_install` | Write a GitHub Actions workflow template of pecot into the repository |

## worktree

| ツール | 説明 |
| --- | --- |
| `worktree_add` | Create a new worktree |
| `worktree_init` | Create the worktree config files in the main worktree |
| `worktree_link` | Apply or update symlinks in existing worktrees |
| `worktree_remove` | Remove a worktree |
