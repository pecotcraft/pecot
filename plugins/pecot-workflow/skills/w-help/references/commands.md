<!-- このファイルは生成物です。手で直さず、`pnpm -C libs/interface-spec exec tsx src/cli.ts commands-md --write` で作り直してください。 -->

# コマンド一覧

引数と詳しい振る舞いは `pecot <コマンド> --help` で確かめてください。

## dependabot

| コマンド | 説明 |
| --- | --- |
| `dependabot sync` | Rewrite the open Tracker's list of Dependabot PRs waiting for a human decision |

## issue

| コマンド | 説明 |
| --- | --- |
| `issue comment` | Post a comment on an Issue |
| `issue create` | Create Issues from Markdown files with frontmatter |
| `issue quick` | Create an Issue at once from a free-format message |
| `issue read` | Fetch Issue details efficiently (GraphQL, only the needed fields) |
| `issue reopen` | Reopen a closed Issue (also sets the status on the board) |

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
| `project set-aggregation-repo` | Set the Epic aggregation repository (``aggregation_repo``) |
| `project set-repo` | Add or update a repository in the project config |
| `project show-aggregation-repo` | Show the Epic aggregation repository (``aggregation_repo``) |
| `project unset-aggregation-repo` | Clear the Epic aggregation repository (``aggregation_repo``); creating an Epic after this needs --repo |

## release

| コマンド | 説明 |
| --- | --- |
| `release create` | Create a GitHub release and its tag (the release notes come from the CHANGELOG) |
| `release merge` | Merge a release PR with a regular merge |
| `release preflight` | Run the pre-release checks (preflight); for an nx repository only the alerts are checked |

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

## その他

| コマンド | 説明 |
| --- | --- |
| `add-to-project` | Add an Issue to the project board with a GraphQL mutation (for an Issue created outside pecot) |
| `create-branch` | Create a branch linked to an Issue (shown in the Development section of the Issue) |
| `delete-branch` | Delete a remote branch (a protected branch is never deleted) |
| `update-issue-status` | Update the status of an Issue on the project board by Issue number (pecot commands normally set the status themselves) |
