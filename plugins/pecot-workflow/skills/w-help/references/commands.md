<!-- このファイルは生成物です。手で直さず、`pnpm -C libs/interface-spec exec tsx src/cli.ts commands-md --write` で作り直してください。 -->

# コマンド一覧

引数と詳しい振る舞いは `pecot <コマンド> --help` で確かめてください。

## board

| コマンド | 説明 |
| --- | --- |
| `board add` | Add an Issue to the project board with a GraphQL mutation (for an Issue created outside pecot) |
| `board move` | Update the status of an Issue on the project board by Issue number (pecot commands normally set the status themselves) |
| `board show` | Show the dashboard of the project board |
| `board sync` | Move the Issues in Ready, Blocked, Active and In Review to the columns and Status values their judgment calls for |

## branch

| コマンド | 説明 |
| --- | --- |
| `branch delete` | Delete a remote branch (a protected branch is never deleted) |

## issue

| コマンド | 説明 |
| --- | --- |
| `issue block` | Add a blocked-by (prerequisite) to an Issue, or change the wait kind and reason of an existing one |
| `issue comment` | Post a comment on an Issue |
| `issue create` | Create Issues from Markdown files with frontmatter |
| `issue quick` | Create an Issue at once from a free-format message |
| `issue reopen` | Reopen a closed Issue (also sets the status on the board) |
| `issue show` | Fetch Issue details efficiently (GraphQL, only the needed fields) |
| `issue unblock` | Remove a blocked-by (prerequisite) from an Issue |

## pr

| コマンド | 説明 |
| --- | --- |
| `pr check` | Show all the information to check before creating a PR |
| `pr create` | Create a PR (pull request) |
| `pr show` | Get PR details efficiently (GraphQL, only the needed fields) |

## project

| コマンド | 説明 |
| --- | --- |
| `project activate` | Activate an initialized project |
| `project create` | Create a new project (to add the fields to an existing project, use project init) |
| `project get` | Show the value of a key of the project config (aggregation_repo: the Epic aggregation repository) |
| `project init` | Add pecot-workflow fields to an existing project, and add the Blocked and Needs Attention options to the fields that already exist |
| `project link` | Add or update a repository in the project config |
| `project list` | List available projects |
| `project search` | Search projects through the GitHub API |
| `project set` | Set a key of the project config (aggregation_repo: the Epic aggregation repository) |
| `project unset` | Clear a key of the project config; without aggregation_repo, creating an Epic needs --repo |

## release

| コマンド | 説明 |
| --- | --- |
| `release check` | Run the pre-release checks; for an nx repository only the alerts are checked |
| `release create` | Create a GitHub release and its tag (the release notes come from the CHANGELOG) |
| `release merge` | Merge a release PR with a regular merge |

## session

| コマンド | 説明 |
| --- | --- |
| `session finish` | Clean up after a merged PR (close related Issues, delete branches, local cleanup) |
| `session restore` | Restore lost session flags (such as .pecot-active) from the branch information |
| `session show` | Show the session flag state, branch information, and inferred Issue |
| `session start` | Create a branch linked to an Issue (shown in the Development section of the Issue) |

## tracker

| コマンド | 説明 |
| --- | --- |
| `tracker sync` | Rewrite the open Tracker's list for a source: Dependabot PRs waiting for a human decision, or open security alerts |

## worktree

| コマンド | 説明 |
| --- | --- |
| `worktree add` | Create a new worktree |
| `worktree init` | Create the worktree config files in the main worktree |
| `worktree link` | Apply or update symlinks in existing worktrees |
| `worktree remove` | Remove a worktree |
