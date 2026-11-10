"""cli/repo.py - repository commands

Provides the create-branch and delete-branch commands.
"""

from __future__ import annotations

from pathlib import Path

import typer

from cli.commands._repo_policy import require_repo_match
from cli.core.config import ProjectConfig, load_active_config
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.paths import WORK_DIR
from cli.core.ref_parser import RefParseError, parse_issue_ref, parse_repo_ref
from cli.core.repo_resolver import AmbiguousRepoError, ResolveSource, resolve_repo
from cli.core.state import FLAG_PECOT_ACTIVE, ensure_work_dir, read_flag, write_work_target


def _reject_cwd_repo_mismatch(owner: str, repo: str) -> None:
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
        typer.echo(
            f"error: 作業対象 Issue のリポ ({owner}/{repo}) と CWD git remote "
            f"({cwd_resolved.repo.owner}/{cwd_resolved.repo.repo}) が異なります。",
            err=True,
        )
        typer.echo(
            "       対象リポの WT に移動してから再実行してください:",
            err=True,
        )
        typer.echo(
            f"         <project-root>/base/{repo}/ または <project-root>/<wtN>/{repo}/",
            err=True,
        )
        typer.echo(
            "       対象リポの WT が無い場合のみ /pecot-w:w-worktree-add で作成してください。",
            err=True,
        )
        typer.echo(
            "       スクリプト等で意図的に CWD 外から発行する場合は --allow-cross-repo を指定してください。",
            err=True,
        )
        raise typer.Exit(2)


def _resolve_base_branch(
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
    branch_name: str,
    base: str | None,
) -> str:
    """3. Decide the base branch (--base first, otherwise develop_branch from the config)"""
    if base:
        # ユーザーが明示的に指定した場合はそれを使用
        return base
    repo_config = config.find_repository(owner, repo)
    # 設定から取得を試みる
    if not repo_config or not repo_config.develop_branch:
        typer.echo(
            f"エラー: リポジトリ {owner}/{repo} の develop_branch が設定されていません",
            err=True,
        )
        typer.echo("", err=True)
        typer.echo("以下のコマンドで設定してください:", err=True)
        typer.echo(f"  pecot project set-repo {owner}/{repo} --develop-branch develop", err=True)
        typer.echo("  # または: --develop-branch develop-aist, --develop-branch main", err=True)
        typer.echo("", err=True)
        typer.echo("または、--base オプションでベースブランチを指定してください:", err=True)
        typer.echo(
            f"  pecot create-branch {owner}/{repo}/{issue_number} {branch_name} --base main",
            err=True,
        )
        raise typer.Exit(1)
    return repo_config.develop_branch


def _guard_active_overwrite(client: GitHubClient, issue_ref_full: str) -> None:
    """A-2. Stop with exit 2 if .pecot-active points to another OPEN Issue"""
    existing = read_flag(FLAG_PECOT_ACTIVE) or ""
    if not existing or existing == issue_ref_full:
        return
    try:
        existing_ref = parse_issue_ref(existing)
    except RefParseError:
        typer.echo(
            f"note: .pecot-active の内容 {repr(existing)} が不正な形式のため stale と判断、上書きします",
            err=True,
        )
        return
    issue_info = client.get_issue_slim(
        existing_ref.repo.owner, existing_ref.repo.repo, existing_ref.number
    )
    existing_state = issue_info.get("state")
    if existing_state == "OPEN":
        typer.echo(
            f"error: この WT は既に別 Issue ({existing}, OPEN) を進行中です。",
            err=True,
        )
        typer.echo(
            "       .pecot-active を上書きすると別タスクと取り違える可能性があります。",
            err=True,
        )
        typer.echo("       - 別 Issue を先に片付ける、または", err=True)
        typer.echo(
            "       - /pecot-w:w-worktree-add で別 WT を作成し、新 WT のセッションで /pecot-w:w-active を再実行",
            err=True,
        )
        typer.echo("       してください。", err=True)
        typer.echo(
            "       stale だと確信していて意図的に上書きする場合は --force-overwrite-active を指定してください。",
            err=True,
        )
        raise typer.Exit(2)
    elif existing_state == "CLOSED":
        typer.echo(
            f"note: .pecot-active の {existing} は CLOSED のため stale と判断、上書きします",
            err=True,
        )
    else:
        typer.echo(
            f"note: .pecot-active の {existing} の state "
            f"({repr(existing_state)}) は想定外のため stale 扱いで上書きします",
            err=True,
        )


def _set_issue_status_active(
    client: GitHubClient, config: ProjectConfig, owner: str, repo: str, issue_number: int
) -> None:
    """7.5. Set the status of the project item to active (failures are ignored)"""
    try:
        item_id = client.get_item_id_by_issue(
            project_id=config.project.id,
            owner=owner,
            repo=repo,
            issue_number=issue_number,
        )
        if item_id:
            field_id = config.get_field_id("workflow")
            option_id = config.get_option_id("workflow", "active")
            if field_id and option_id:
                client.update_project_item_field(config.project.id, item_id, field_id, option_id)
                typer.echo("ステータスを 'active' に設定しました")
    except GitHubAPIError:
        # ステータス更新に失敗してもブランチ作成は成功しているため続行
        pass


def _print_checkout_guide(owner: str, repo: str, created_branch: str) -> None:
    """8. Guide the branch switch (show the concrete commands)"""
    from cli.core.worktree import get_current_worktree_name

    typer.echo("")
    try:
        wt_name = get_current_worktree_name(Path.cwd())
    except Exception:
        wt_name = None

    if wt_name:
        typer.echo(f"★ {owner}/{repo} のワークツリー({wt_name})で以下を実行してください:")
    else:
        typer.echo(f"★ {owner}/{repo} で以下のコマンドを実行してブランチを切り替えてください:")
    typer.echo("  git fetch origin")
    typer.echo(f"  git checkout {created_branch}")


@require_repo_match(mode="reject")
def create_branch(
    ctx: typer.Context,
    issue_ref: str = typer.Argument(..., help="Issue reference (owner/repo/123)"),
    branch_name: str = typer.Argument(..., help="Name of the branch to create"),
    base: str | None = typer.Option(
        None, "--base", "-b", help="Base branch (default: develop_branch from the config)"
    ),
    checkout: bool = typer.Option(
        True, "--checkout/--no-checkout", help="Check out the branch after creating it"
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
    """Create a branch linked to an Issue

    Uses the GitHub GraphQL API (createLinkedBranch) to create a branch
    linked in the Development section of the Issue.
    Provides the same function as gh issue develop.
    """
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. issue_ref をパース（フル形式必須、base_repo は渡さない）
    try:
        ref = parse_issue_ref(issue_ref)
    except RefParseError as e:
        typer.echo(e.message, err=True)
        raise typer.Exit(2) from None

    owner, repo, issue_number = ref.repo.owner, ref.repo.repo, ref.number

    # A-1. CWD–Issue ref リポ整合チェック
    if not allow_cross_repo:
        _reject_cwd_repo_mismatch(owner, repo)

    # 3. ベースブランチ決定（ローカル設定から）
    base_branch = _resolve_base_branch(config, owner, repo, issue_number, branch_name, base)

    try:
        client = GitHubClient(host=config.host)

        # A-2. .pecot-active 上書きガード
        issue_ref_full = f"{owner}/{repo}/{issue_number}"
        if not force_overwrite_active:
            _guard_active_overwrite(client, issue_ref_full)

        # 4. リポジトリがプロジェクトに含まれているか確認
        if not config.is_repo_in_project(owner, repo, client):
            typer.echo(f"リポジトリ {owner}/{repo} はプロジェクトに含まれていません", err=True)
            raise typer.Exit(1)

        # 5. Issue Node ID とタイトル取得（タイトルはセッション名用）
        issue_node_id, issue_title = client.get_issue_node_id_and_title(owner, repo, issue_number)

        # 6. ベースブランチの commit SHA 取得
        base_sha = client.get_branch_sha(owner, repo, base_branch)

        # 7. リンクブランチ作成（ブランチ名末尾にIssue番号を自動付与）
        final_branch_name = f"{branch_name}/{issue_number}"
        typer.echo(f"ブランチ作成中: {final_branch_name} (from {base_branch})")
        created_branch = client.create_linked_branch(
            issue_id=issue_node_id,
            oid=base_sha,
            name=final_branch_name,
        )

        typer.echo(f"作成完了: {created_branch}")
        typer.echo(f"Issue #{issue_number} にリンクしました")

        # 7.5. プロジェクトアイテムのステータスをactiveに更新
        _set_issue_status_active(client, config, owner, repo, issue_number)

        # 8. ブランチ切り替え案内（具体的なコマンドを表示）
        if checkout:
            _print_checkout_guide(owner, repo, created_branch)

        # 9. 作業対象を .pecot-active と .pecot-session-title に保存（hook の自動投稿とセッション名用）
        write_work_target(issue_ref_full, issue_title)
        typer.echo(f"作業対象を記録: {issue_ref_full}")
        if ensure_work_dir(issue_ref_full):
            typer.echo(f"作業ファイル置き場: {WORK_DIR}/{issue_ref_full.rsplit('/', 1)[-1]}/")

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
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
    """Delete a remote branch

    Deletes the remote branch safely through the GitHub REST API,
    even where a PreToolUse hook blocks git push and the gh CLI.
    Deleting a protected branch (default, develop, release) is blocked.
    """
    # 1. repo_ref をパース
    try:
        repo_ref_obj = parse_repo_ref(repo_ref)
    except RefParseError as e:
        typer.echo(e.message, err=True)
        raise typer.Exit(2) from None

    owner, repo = repo_ref_obj.owner, repo_ref_obj.repo

    # 2. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("アクティブなプロジェクトがありません", err=True)
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
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None

    # 4. 保護ブランチチェック
    if branch in protected_branches:
        typer.echo(
            f"エラー: '{branch}' は保護ブランチのため削除できません",
            err=True,
        )
        typer.echo(f"保護ブランチ: {', '.join(sorted(protected_branches))}", err=True)
        raise typer.Exit(1)

    # 5. dry-run
    if dry_run:
        typer.echo(f"[dry-run] 削除対象: {owner}/{repo} のブランチ '{branch}'")
        typer.echo(f"[dry-run] 保護ブランチ: {', '.join(sorted(protected_branches))}")
        return

    # 6. 削除実行
    try:
        client.delete_branch(owner, repo, branch)
        typer.echo(f"ブランチ '{branch}' を削除しました ({owner}/{repo})")
        # WIPブランチも連動削除
        wip_branch = f"wip/{branch}"
        try:
            client.delete_branch(owner, repo, wip_branch)
            typer.echo(f"  ✔ WIPブランチ '{wip_branch}' も削除しました")
        except GitHubAPIError:
            pass  # 存在しない場合は無視
    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None
