<!-- このファイルは生成物です。手で直さず、`pnpm -C libs/interface-spec exec tsx src/cli.ts commands-md --write` で作り直してください。 -->

# ツール一覧

入力と詳しい振る舞いは、MCP のツールの定義（tools/list）で確かめてください。

## board

| ツール | 説明 |
| --- | --- |
| `board_check` | Check the arguments for projects_write (method update_project_item) against the pecot rules before writing: the field and option are on the board, and Ready or Blocked matches the judgment of the prerequisites. Reads and writes nothing on GitHub; pass the results of the official reads in reads. |
| `board_show` | Show the open items of the project board by column, the readiness of the Ready and Blocked Issues whose prerequisites were read, and the Issues per pecot-lane value. Reads and writes nothing on GitHub; pass the results of the official reads in reads. |

## branch

| ツール | 説明 |
| --- | --- |
| `branch_check` | Check the params for the link-branch operation of pecot-github-ops against the pecot rules before creating the branch: the Issue is open and its prerequisites allow starting, the base is the stack branch or the develop branch, the branch name ends with the Issue number, and the working directory is in the repository of the Issue. Reads and writes nothing on GitHub; pass the results of the official reads in reads. |

## issue

| ツール | 説明 |
| --- | --- |
| `issue_check` | Check the arguments for issue_write (and the board fields and blocked-by written after it) against the pecot rules before writing: the template of the body, the title prefix and order, the type, the Issue and board fields, the column to place the Issue in, and the prerequisites. A batch create gives the order numbers and how each Issue proceeds. Reads and writes nothing on GitHub; pass the results of the official reads in reads. |
| `issue_comment_check` | Check the arguments for add_issue_comment or update_issue_comment against the pecot rules before writing: the bundled comment template the body follows, and with update, that the comment belongs to the Issue. Reads and writes nothing on GitHub; pass the results of the official reads in reads. |
| `issue_dependency_check` | Check the arguments for issue_dependency_write against the pecot rules before writing: the direction, wait kind and reason, a self reference or cycle, whether the blocked-by is already there, and the column the waiting Issue should move to after the change. Reads and writes nothing on GitHub; pass the results of the official reads in reads. |

## pr

| ツール | 説明 |
| --- | --- |
| `pr_check` | Check the arguments for create_pull_request, update_pull_request or merge_pull_request against the pecot rules before writing: the bundled PR template the body follows, the Issue the body closes, the base branch of a stacked branch, the title scope, unpushed or uncommitted work (create), and with merge, the state, head, stack position and merge method of the PR. Reads and writes nothing on GitHub; pass the results of the official reads in reads. |
| `pr_restack` | Restack the current branch onto the new position of its base branch. Reads nothing on GitHub; pass the results of the official reads in reads |

## project

| ツール | 説明 |
| --- | --- |
| `project_activate` | Write the project config of an initialized board from the official GitHub MCP reads in reads, and make it the active project. The registered repositories are kept from the existing config |
| `project_check` | Check the arguments for projects_write create_project (the title is free for the owner), or the changes for the project-fields operation of github-ops against the pecot field rules: after the changes, the board has pecot-status, the Needs Attention option of Status and the pecot-lane values. Reads and writes nothing on GitHub; pass the results of the official reads in reads. |
| `project_get` | Show the value of a key of the project config (aggregation_repo: the Epic aggregation repository), or without key, the overview of the active project and its registered repositories with their branches and release type |
| `project_link` | Add or update a repository in the project config. It does not link the repository to the board on GitHub; do that with the project-link operation of github-ops |
| `project_list` | List available projects |
| `project_set` | Set a key of the project config (aggregation_repo: the Epic aggregation repository) |
| `project_unset` | Clear a key of the project config; without aggregation_repo, creating an Epic needs the target repository given explicitly |

## release

| ツール | 説明 |
| --- | --- |
| `release_check` | Check the params for the release-create operation of github-ops before the release: no open code scanning or secret scanning alert (open Dependabot alerts only warn), the tag is new on the local repository, the remote and GitHub, the body is the CHANGELOG section of the version, and sha is the head of the release branch with commits since the previous release tag. For an nx repository only the alerts are checked. Reads the local git and the git remote, not the GitHub API; pass the results of the official reads in reads. |

## session

| ツール | 説明 |
| --- | --- |
| `session_finish` | Clean up the local side after a merged PR: check out the develop branch (or the worktree branch), pull it, delete the local head branch and remove the work records. Also returns the readiness changes of the Issues waiting for the closed Issues and the stacked Issues to restack. It closes no Issue and moves no card; pecot-board-sync does it on the merge. Reads nothing on GitHub; pass the results of the official reads in reads. |
| `session_show` | Show the branch, repository, work Issue, stack record, the base branch to compare against and the worktree of the session. Reads nothing on GitHub; read the Issue and the PRs stacked above with the official GitHub MCP |
| `session_start` | Record the start of work on a branch created with the link-branch operation: the base (.pecot-base), the work directory and the session name. Also reports a merged PR of the current branch whose local cleanup is left |

## workflow

| ツール | 説明 |
| --- | --- |
| `workflow_doctor` | Check that the repository has the workflow file and the settings it needs. The secrets and variables come from the workflow-doctor operation of github-ops in reads.settings; without it they are skipped |
| `workflow_install` | Write a GitHub Actions workflow template of pecot into the repository |

## worktree

| ツール | 説明 |
| --- | --- |
| `worktree_add` | Create a new worktree |
| `worktree_init` | Create the worktree config files in the main worktree |
| `worktree_link` | Apply or update symlinks in existing worktrees |
| `worktree_remove` | Remove a worktree |
