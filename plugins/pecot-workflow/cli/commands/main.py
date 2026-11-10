"""Main pecot CLI application

CLI definition built with Typer.
"""

from pathlib import Path

import typer

from cli import __version__
from cli.commands._output import Output
from cli.commands.dependabot import dependabot_sync as dependabot_sync_command
from cli.commands.issue import add_to_project as add_to_project_command
from cli.commands.issue import issue_comment as issue_comment_command
from cli.commands.issue import issue_create as issue_create_command
from cli.commands.issue import issue_quick_command, issue_reopen_command
from cli.commands.issue import issue_read as issue_read_command
from cli.commands.issue import update_issue_status as update_issue_status_command
from cli.commands.options import RepoOption, ShowRepoOption
from cli.commands.pr import pr_cleanup as pr_cleanup_command
from cli.commands.pr import pr_create as pr_create_command
from cli.commands.pr import pr_preflight as pr_preflight_command
from cli.commands.pr import pr_read as pr_read_command
from cli.commands.project import create as create_command
from cli.commands.project import info as info_command
from cli.commands.project import init as init_command
from cli.commands.project import project_activate as project_activate_command
from cli.commands.project import project_list as project_list_command
from cli.commands.project import project_set_repo as project_set_repo_command
from cli.commands.project import search_github_projects as search_github_projects_command
from cli.commands.project import (
    set_aggregation_repo_command,
    show_aggregation_repo_command,
    unset_aggregation_repo_command,
)
from cli.commands.release import release_create as release_create_command
from cli.commands.release import release_merge as release_merge_command
from cli.commands.release import release_preflight as release_preflight_command
from cli.commands.repo import create_branch as create_branch_command
from cli.commands.repo import delete_branch as delete_branch_command
from cli.commands.repo_display import print_resolved_repo
from cli.commands.security import security_sync as security_sync_command
from cli.commands.session import flag_restore as flag_restore_command
from cli.commands.session import flag_status as flag_status_command
from cli.commands.worktree import (
    worktree_add,
    worktree_init,
    worktree_link,
    worktree_remove,
)
from cli.core.github.client import resolve_api_url_override
from cli.core.repo_resolver import AmbiguousRepoError, resolve_repo

_OUT = Output(dry_run=False)

# メインアプリケーション
app = typer.Typer(
    name="pecot",
    help="pecot-workflow CLI - work tracking on GitHub Projects",
    no_args_is_help=True,
)


def version_callback(value: bool) -> None:
    """Callback that shows the version"""
    if value:
        _OUT.data(f"pecot version {__version__}")
        raise typer.Exit()


@app.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    version: bool | None = typer.Option(
        None,
        "--version",
        "-v",
        callback=version_callback,
        is_eager=True,
        help="Show the version",
    ),
    repo: RepoOption = None,
    show_repo: ShowRepoOption = False,
) -> None:
    """pecot-workflow CLI - work tracking on GitHub Projects"""
    try:
        resolve_api_url_override()
    except ValueError as e:
        _OUT.error(str(e))
        raise typer.Exit(1) from e

    ctx.ensure_object(dict)
    ctx.obj["repo"] = repo

    if show_repo:
        try:
            resolved = resolve_repo(repo, cwd=Path.cwd())
        except ValueError as e:
            _OUT.error(f"--repo: {e}")
            raise typer.Exit(2) from e
        except AmbiguousRepoError as e:
            _OUT.error(str(e))
            raise typer.Exit(2) from e
        print_resolved_repo(resolved)
        raise typer.Exit(0)


# サブコマンドグループ
project_app = typer.Typer(help="Manage projects through the GitHub API")
project_app.command(name="list")(project_list_command)
project_app.command(name="search")(search_github_projects_command)
project_app.command(name="init")(init_command)
project_app.command(name="create")(create_command)
project_app.command(name="info")(info_command)
project_app.command(name="activate")(project_activate_command)
project_app.command(name="set-repo")(project_set_repo_command)
project_app.command(name="set-aggregation-repo")(set_aggregation_repo_command)
project_app.command(name="unset-aggregation-repo")(unset_aggregation_repo_command)
project_app.command(name="show-aggregation-repo")(show_aggregation_repo_command)
app.add_typer(project_app, name="project")

# issue サブコマンドグループ
issue_app = typer.Typer(help="Work with Issues")
issue_app.command(name="create")(issue_create_command)
issue_app.command(name="quick")(issue_quick_command)
issue_app.command(name="read")(issue_read_command)
issue_app.command(name="comment")(issue_comment_command)
issue_app.command(name="reopen")(issue_reopen_command)

app.add_typer(issue_app, name="issue")

# pr サブコマンドグループ
pr_app = typer.Typer(help="Work with PRs")
pr_app.command(name="create")(pr_create_command)
pr_app.command(name="read")(pr_read_command)
pr_app.command(name="cleanup")(pr_cleanup_command)
pr_app.command(name="preflight")(pr_preflight_command)

app.add_typer(pr_app, name="pr")

# session サブコマンドグループ
session_app = typer.Typer(help="Manage the session")
session_app.command(name="status")(flag_status_command)
session_app.command(name="restore")(flag_restore_command)
app.add_typer(session_app, name="session")

# release サブコマンドグループ
release_app = typer.Typer(help="Work with releases")
release_app.command(name="preflight")(release_preflight_command)
release_app.command(name="create")(release_create_command)
release_app.command(name="merge")(release_merge_command)
app.add_typer(release_app, name="release")

# security サブコマンドグループ
security_app = typer.Typer(help="Put security alerts into a Tracker")
security_app.command(name="sync")(security_sync_command)
app.add_typer(security_app, name="security")

# dependabot サブコマンドグループ
dependabot_app = typer.Typer(help="Put Dependabot PRs waiting for a human decision into a Tracker")
dependabot_app.command(name="sync")(dependabot_sync_command)
app.add_typer(dependabot_app, name="dependabot")

# worktree サブコマンドグループ
worktree_app = typer.Typer(help="Work with worktrees")
worktree_app.command(name="init")(worktree_init)
worktree_app.command(name="add")(worktree_add)
worktree_app.command(name="link")(worktree_link)
worktree_app.command(name="remove")(worktree_remove)
app.add_typer(worktree_app, name="worktree")

# issue.py からコマンドを登録
app.command(name="add-to-project")(add_to_project_command)
app.command(name="update-issue-status")(update_issue_status_command)

# repo.py からコマンドを登録
app.command(name="create-branch")(create_branch_command)
app.command(name="delete-branch")(delete_branch_command)


if __name__ == "__main__":
    app()
