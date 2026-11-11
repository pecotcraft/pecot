"""cli/repo.py - repository commands

Provides the create-branch and delete-branch commands.
"""

from __future__ import annotations

from pathlib import Path

import typer

from cli.commands._output import Operation, Output, Verb
from cli.commands._repo_policy import require_repo_match
from cli.commands._work_target import record_work_target
from cli.core.config import ProjectConfig, load_active_config
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.ref_parser import RefParseError, parse_issue_ref, parse_repo_ref
from cli.core.repo_resolver import AmbiguousRepoError, ResolveSource, resolve_repo
from cli.core.state import FLAG_PECOT_ACTIVE, read_flag

_NO_ACTIVE_PROJECT = "no active project\nrun: pecot project activate <PROJECT>"


def _reject_cwd_repo_mismatch(out: Output, owner: str, repo: str) -> None:
    """A-1. Stop with exit 2 if the repository of the CWD git remote differs from the Issue ref"""
    try:
        cwd_resolved = resolve_repo(None, cwd=Path.cwd())
    except AmbiguousRepoError:
        cwd_resolved = None
    if (
        cwd_resolved is not None
        and cwd_resolved.source is ResolveSource.CURRENT_GIT
        and (cwd_resolved.repo.owner, cwd_resolved.repo.repo) != (owner, repo)
    ):
        out.error(
            f"the repository of the work Issue ({owner}/{repo}) differs from "
            f"the CWD git remote ({cwd_resolved.repo.owner}/{cwd_resolved.repo.repo})\n"
            "move to the worktree of the target repository and run again:\n"
            f"<project-root>/base/{repo}/ or <project-root>/<wtN>/{repo}/\n"
            "create one with /pecot-w:w-worktree-add only if the repository has no worktree\n"
            "to issue the command on purpose from outside the CWD (for example in a script), "
            "give --allow-cross-repo"
        )
        raise typer.Exit(2)


def _resolve_base_branch(
    out: Output,
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
    branch_name: str,
    base: str | None,
) -> str:
    """3. Decide the base branch (--base first, otherwise develop_branch from the config)"""
    if base:
        return base
    repo_config = config.find_repository(owner, repo)
    if not repo_config or not repo_config.develop_branch:
        out.error(
            f"develop_branch is not set for {owner}/{repo}\n"
            f"set it with: pecot project set-repo {owner}/{repo} --develop-branch develop\n"
            f"or give the base: pecot create-branch {owner}/{repo}/{issue_number} "
            f"{branch_name} --base main"
        )
        raise typer.Exit(1)
    return repo_config.develop_branch


def _guard_active_overwrite(out: Output, client: GitHubClient, issue_ref_full: str) -> None:
    """A-2. Stop with exit 2 if .pecot-active points to another OPEN Issue"""
    existing = read_flag(FLAG_PECOT_ACTIVE) or ""
    if not existing or existing == issue_ref_full:
        return
    try:
        existing_ref = parse_issue_ref(existing)
    except RefParseError:
        out.warning(f"the content of .pecot-active ({existing!r}) is malformed; overwriting it")
        return
    issue_info = client.get_issue_slim(
        existing_ref.repo.owner, existing_ref.repo.repo, existing_ref.number
    )
    existing_state = issue_info.get("state")
    if existing_state == "OPEN":
        out.error(
            f"this worktree is already working on another Issue ({existing}, OPEN)\n"
            "overwriting .pecot-active could mix up the tasks\n"
            "finish the other Issue first, or create another worktree with "
            "/pecot-w:w-worktree-add and run /pecot-w:w-active again in its session\n"
            "if it is stale and you want to overwrite it on purpose, give --force-overwrite-active"
        )
        raise typer.Exit(2)
    if existing_state == "CLOSED":
        out.warning(f".pecot-active points to closed Issue {existing}; overwriting it")
    else:
        out.warning(
            f"the state of {existing} in .pecot-active is unexpected ({existing_state!r}); "
            "overwriting it"
        )


def _set_issue_status_active(
    out: Output,
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
) -> None:
    """7.5. Set the status of the project item to active (a failure is only a warning)"""
    target = f"Issue {owner}/{repo}/{issue_number} status active"
    try:
        item_id = client.get_item_id_by_issue(
            project_id=config.project.id,
            owner=owner,
            repo=repo,
            issue_number=issue_number,
        )
        if not item_id:
            out.warning(f"could not set {target}: the Issue is not on the project board")
            return
        field_id = config.get_field_id("workflow")
        option_id = config.get_option_id("workflow", "active")
        if not (field_id and option_id):
            out.warning(f"could not set {target}: the workflow status field has no 'active' option")
            return
        client.update_project_item_field(config.project.id, item_id, field_id, option_id)
        out.done(Operation(Verb.SET, target))
    except GitHubAPIError as e:
        # The branch is already created, so a status failure does not stop the command
        out.warning(f"could not set {target}: {e.message}")


@require_repo_match(mode="reject")
def create_branch(
    ctx: typer.Context,
    issue_ref: str = typer.Argument(..., help="Issue reference (owner/repo/123)"),
    branch_name: str = typer.Argument(..., help="Name of the branch to create"),
    base: str | None = typer.Option(
        None, "--base", "-b", help="Base branch (default: develop_branch from the config)"
    ),
    checkout: bool = typer.Option(
        True, "--checkout/--no-checkout", help="Kept for compatibility; has no effect"
    ),
    allow_cross_repo: bool = typer.Option(
        False,
        "--allow-cross-repo",
        "-X",
        help="Allow the CWD repository to differ from the Issue ref (for scripts and runs outside the CWD)",
    ),
    force_overwrite_active: bool = typer.Option(
        False,
        "--force-overwrite-active",
        "-F",
        help="Disable the .pecot-active overwrite guard (when sure it is stale)",
    ),
) -> None:
    """Create a branch linked to an Issue (shown in the Development section of the Issue)

    Uses the GitHub GraphQL API (createLinkedBranch) to create a branch
    linked in the Development section of the Issue.
    Provides the same function as gh issue develop.
    """
    out = Output(dry_run=False)
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        out.error(_NO_ACTIVE_PROJECT)
        raise typer.Exit(1)

    # 2. issue_ref をパース（フル形式必須、base_repo は渡さない）
    try:
        ref = parse_issue_ref(issue_ref)
    except RefParseError as e:
        out.error(e.message)
        raise typer.Exit(2) from None

    owner, repo, issue_number = ref.repo.owner, ref.repo.repo, ref.number

    # A-1. CWD–Issue ref リポ整合チェック
    if not allow_cross_repo:
        _reject_cwd_repo_mismatch(out, owner, repo)

    # 3. ベースブランチ決定（ローカル設定から）
    base_branch = _resolve_base_branch(out, config, owner, repo, issue_number, branch_name, base)

    final_branch_name = f"{branch_name}/{issue_number}"
    try:
        client = GitHubClient(host=config.host)

        # A-2. .pecot-active 上書きガード
        issue_ref_full = f"{owner}/{repo}/{issue_number}"
        if not force_overwrite_active:
            _guard_active_overwrite(out, client, issue_ref_full)

        # 4. リポジトリがプロジェクトに含まれているか確認
        if not config.is_repo_in_project(owner, repo, client):
            out.error(f"{owner}/{repo} is not in the project")
            raise typer.Exit(1)

        # 5. Issue Node ID とタイトル取得（タイトルはセッション名用）
        issue_node_id, issue_title = client.get_issue_node_id_and_title(owner, repo, issue_number)

        # 6. ベースブランチの commit SHA 取得
        base_sha = client.get_branch_sha(owner, repo, base_branch)

        # 7. リンクブランチ作成（ブランチ名末尾にIssue番号を自動付与）
        created_branch = client.create_linked_branch(
            issue_id=issue_node_id,
            oid=base_sha,
            name=final_branch_name,
        )
        out.done(
            Operation(Verb.CREATE, f"branch {created_branch} in {owner}/{repo} from {base_branch}")
        )

        # 7.5. プロジェクトアイテムのステータスをactiveに更新
        _set_issue_status_active(out, client, config, owner, repo, issue_number)

        # 9. 作業対象を .pecot-active と .pecot-session-title に保存（hook の自動投稿とセッション名用）
        record_work_target(out, owner, repo, issue_number, issue_title)

    except GitHubAPIError as e:
        out.error(f"could not create branch {final_branch_name} in {owner}/{repo}: {e.message}")
        raise typer.Exit(1) from None


@require_repo_match(mode="reject")
def delete_branch(
    ctx: typer.Context,
    repo_ref: str = typer.Argument(
        ...,
        help="Repository reference (owner/repo)",
    ),
    branch: str = typer.Argument(
        ...,
        help="Name of the branch to delete",
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        "-n",
        help="Show what would be deleted without deleting anything",
    ),
) -> None:
    """Delete a remote branch (a protected branch is never deleted)

    Deletes the remote branch safely through the GitHub REST API,
    even where a PreToolUse hook blocks git push and the gh CLI.
    Deleting a protected branch (default, develop, release) is blocked.
    """
    out = Output(dry_run=dry_run)
    # 1. repo_ref をパース
    try:
        repo_ref_obj = parse_repo_ref(repo_ref)
    except RefParseError as e:
        out.error(e.message)
        raise typer.Exit(2) from None

    owner, repo = repo_ref_obj.owner, repo_ref_obj.repo

    # 2. 設定取得
    config = load_active_config()
    if config is None:
        out.error(_NO_ACTIVE_PROJECT)
        raise typer.Exit(1)

    # 3. 保護ブランチ収集
    protected_branches: set[str] = set()

    # 設定から develop_branch, release_branch を取得
    repo_config = config.find_repository(owner, repo)
    if repo_config:
        if repo_config.develop_branch:
            protected_branches.add(repo_config.develop_branch)
        if repo_config.release_branch:
            protected_branches.add(repo_config.release_branch)

    # API からデフォルトブランチを取得
    try:
        client = GitHubClient(host=config.host)
        default_branch = client.get_repository_default_branch(owner, repo)
        protected_branches.add(default_branch)
    except GitHubAPIError as e:
        out.error(f"could not read the default branch of {owner}/{repo}: {e.message}")
        raise typer.Exit(1) from None

    # 4. 保護ブランチチェック
    if branch in protected_branches:
        out.error(
            f"{branch} is a protected branch\nprotected: {', '.join(sorted(protected_branches))}"
        )
        raise typer.Exit(1)

    # 5. dry-run
    target = Operation(Verb.DELETE, f"remote branch {branch} in {owner}/{repo}")
    if dry_run:
        out.planned(target)
        return

    # 6. 削除実行
    try:
        client.delete_branch(owner, repo, branch)
    except GitHubAPIError as e:
        out.error(f"could not delete remote branch {branch} in {owner}/{repo}: {e.message}")
        raise typer.Exit(1) from None
    out.done(target)
    # WIPブランチも連動削除
    wip_branch = f"wip/{branch}"
    try:
        client.delete_branch(owner, repo, wip_branch)
    except GitHubAPIError:
        return  # 存在しない場合は無視
    out.done(Operation(Verb.DELETE, f"remote branch {wip_branch} in {owner}/{repo}"))
