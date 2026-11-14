<!-- このファイルは生成物です。手で直さず、`pnpm -C libs/interface-spec exec tsx src/cli.ts commands-md --write` で作り直してください。 -->

# コマンド一覧

引数と詳しい振る舞いは `pecot <コマンド> --help` で確かめてください。

## aggregation

| コマンド | 説明 |
| --- | --- |
| `aggregation set` | Set the Epic aggregation repository (``aggregation_repo``) |
| `aggregation show` | Show the Epic aggregation repository (``aggregation_repo``) |
| `aggregation unset` | Clear the Epic aggregation repository (``aggregation_repo``); creating an Epic after this needs --repo |

## board

| コマンド | 説明 |
| --- | --- |
| `board add` | Add an Issue to the project board with a GraphQL mutation (for an Issue created outside pecot) |
| `board move` | Update the status of an Issue on the project board by Issue number (pecot commands normally set the status themselves) |
| `board sync` | Move the Issues in Ready, Blocked, Active and In Review to the columns and Status values their judgment calls for |

## branch

| コマンド | 説明 |
| --- | --- |
| `branch create` | Create a branch linked to an Issue (shown in the Development section of the Issue) |
| `branch delete` | Delete a remote branch (a protected branch is never deleted) |

## dependabot

| コマンド | 説明 |
| --- | --- |
| `dependabot sync` | Rewrite the open Tracker's list of Dependabot PRs waiting for a human decision |

## issue

| コマンド | 説明 |
| --- | --- |
| `issue block` | Add a blocked-by (prerequisite) to an Issue, or change the wait kind and reason of an existing one |
| `issue comment` | Post a comment on an Issue |
| `issue create` | Create Issues from Markdown files with frontmatter |
| `issue quick` | Create an Issue at once from a free-format message |
| `issue read` | Fetch Issue details efficiently (GraphQL, only the needed fields) |
| `issue reopen` | Reopen a closed Issue (also sets the status on the board) |
| `issue unblock` | Remove a blocked-by (prerequisite) from an Issue |

## pr

| コマンド | 説明 |
| --- | --- |
| `pr cleanup` | Clean up after a merged PR (close related Issues, delete branches, local cleanup) |
| `pr create` | Create a PR (pull request) |
| `pr preflight` | Show all the information to check before creating a PR |
| `pr read` | Get PR details efficiently (GraphQL, only the needed fields) |

## project

| コマンド | 説明 |
| --- | --- |
| `project activate` | Activate an initialized project |
| `project create` | Create a new project (to add the fields to an existing project, use project init) |
| `project info` | Show the project info dashboard |
| `project init` | Add pecot-workflow fields to an existing project, and add the Blocked and Needs Attention options to the fields that already exist |
| `project list` | List available projects |
| `project search` | Search projects through the GitHub API |

## release

| コマンド | 説明 |
| --- | --- |
| `release create` | Create a GitHub release and its tag (the release notes come from the CHANGELOG) |
| `release merge` | Merge a release PR with a regular merge |
| `release preflight` | Run the pre-release checks (preflight); for an nx repository only the alerts are checked |

## repo

| コマンド | 説明 |
| --- | --- |
| `repo set` | Add or update a repository in the project config |

## security

| コマンド | 説明 |
| --- | --- |
| `security sync` | Rewrite the open Tracker's list of open security alerts |

## session

| コマンド | 説明 |
| --- | --- |
| `session restore` | Restore lost session flags (such as .pecot-active) from the branch information |
| `session status` | Show the session flag state, branch information, and inferred Issue |

## worktree

| コマンド | 説明 |
| --- | --- |
| `worktree add` | Create a new worktree |
| `worktree init` | Create the worktree config files in the main worktree |
| `worktree link` | Apply or update symlinks in existing worktrees |
| `worktree remove` | Remove a worktree |
