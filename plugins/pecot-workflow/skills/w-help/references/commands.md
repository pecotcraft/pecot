<!-- このファイルは生成物です。手で直さず、`pnpm -C libs/interface-spec exec tsx src/cli.ts commands-md --write` で作り直してください。 -->

# コマンド一覧

引数と詳しい振る舞いは `pecot <コマンド> --help` で確かめてください。

## auto

| コマンド | 説明 |
| --- | --- |
| `auto finish` | Finish an automated fix run: post the result comment, set the waiting Status and remove the trigger label |
| `auto gate` | Decide from a GitHub Actions event whether the automated fix runs, and of what kind |
| `auto start` | Start an automated fix run: restore the Status the automation wrote and print the context to continue |

## board

| コマンド | 説明 |
| --- | --- |
| `board add` | Add an Issue to the project board with a GraphQL mutation (for an Issue created outside pecot) |
| `board move` | Update the status of an Issue on the project board by Issue number (pecot commands normally set the status themselves) |
| `board show` | Show the dashboard of the project board |
| `board sync` | Move the Issues in Ready, Blocked, Active and In Review to the columns and Status values their judgment calls for, and delete the Archived items beyond the latest 20 from the board |

## branch

| コマンド | 説明 |
| --- | --- |
| `branch delete` | Delete a remote branch (a protected branch is never deleted) |

## issue

| コマンド | 説明 |
| --- | --- |
| `issue attributes` | List the attributes an Issue of the repository can have: fields of the configured board, Issue fields, and built-in ones |
| `issue block` | Add a blocked-by (prerequisite) to an Issue, or change the wait kind and reason of an existing one |
| `issue check` | Check Markdown files for issue create and show their order numbers, prerequisites and how to proceed, without creating anything |
| `issue comment` | Post a comment on an Issue |
| `issue create` | Create Issues from Markdown files with frontmatter |
| `issue edit` | Write, change or remove the values of the attributes of an Issue by name (the attributes that issue_attributes lists) |
| `issue reopen` | Reopen a closed Issue (also sets the status on the board) |
| `issue show` | Fetch Issue details efficiently (GraphQL, only the needed fields) |
| `issue unblock` | Remove a blocked-by (prerequisite) from an Issue |

## pr

| コマンド | 説明 |
| --- | --- |
| `pr check` | Show all the information to check before creating a PR |
| `pr create` | Create a PR (pull request) |
| `pr merge` | Merge a PR with the asynchronous merge API (a PR in a stack must be the bottom one) |
| `pr restack` | Restack the current branch onto the new position of its base branch |
| `pr show` | Get PR details efficiently (GraphQL, only the needed fields) |

## project

| コマンド | 説明 |
| --- | --- |
| `project activate` | Activate an initialized project |
| `project create` | Create a new project with the pecot-workflow fields, and the pecot-lane field and the Lanes view from lanes (to add the fields to an existing project, use project init) |
| `project get` | Show the value of a key of the project config (aggregation_repo: the Epic aggregation repository) |
| `project init` | Add the pecot-status field to an existing project, rename the old suffixed workflow field to pecot-status, add the Blocked and Needs Attention options to the fields that already exist, and add the lanes to the pecot-lane field with a Lanes view. The fields pecot does not use (pecot-priority, pecot-size, and the old suffixed workflow field when pecot-status also exists) are listed in migration.pending_delete, and deleted only with confirm_delete |
| `project link` | Add or update a repository in the project config |
| `project list` | List available projects |
| `project search` | Search projects through the GitHub API, and show which are initialized and which is active |
| `project set` | Set a key of the project config (aggregation_repo: the Epic aggregation repository) |
| `project unset` | Clear a key of the project config; without aggregation_repo, creating an Epic needs the target repository given explicitly |

## release

| コマンド | 説明 |
| --- | --- |
| `release check` | Run the pre-release checks; for an nx repository only the alerts are checked |
| `release create` | Create a GitHub release and its tag (the release notes come from the CHANGELOG) |
| `release merge` | Merge a release PR with a regular merge |

## review

| コマンド | 説明 |
| --- | --- |
| `review finish` | Finish an automated review: post a comment on the PR only when the review stopped (failed, limit or setup-missing) |

## session

| コマンド | 説明 |
| --- | --- |
| `session finish` | Clean up after a merged PR (close related Issues, delete branches, local cleanup) |
| `session show` | Show the branch, repository and work Issue of the session |
| `session start` | Create a branch linked to an Issue (shown in the Development section of the Issue) |

## tracker

| コマンド | 説明 |
| --- | --- |
| `tracker sync` | Rewrite the open Tracker's list for a source: Dependabot PRs waiting for a human decision, or open security alerts |

## workflow

| コマンド | 説明 |
| --- | --- |
| `workflow doctor` | Check that the repository has the workflow file and the settings it needs |
| `workflow install` | Write a GitHub Actions workflow template of pecot into the repository |

## worktree

| コマンド | 説明 |
| --- | --- |
| `worktree add` | Create a new worktree |
| `worktree init` | Create the worktree config files in the main worktree |
| `worktree link` | Apply or update symlinks in existing worktrees |
| `worktree remove` | Remove a worktree |
