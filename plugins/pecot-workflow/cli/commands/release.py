"""cli/release.py - release commands

Provides the release preflight / release create commands.
Replaces the shell scripts (release-preflight.sh, create-github-release.sh)
with the Python CLI.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, cast

import httpx
import typer

from cli.commands._repo_policy import read_resolved_repo, require_repo_match
from cli.core.changelog import (
    VersionNotFoundError,
    extract_version_release_notes,
    resolve_changelog_path,
    validate_semver,
)
from cli.core.config import ProjectConfig, Repository, load_active_config
from cli.core.dependabot import (
    DependabotAlertError,
    fetch_dependabot_alert_status,
)
from cli.core.errors import PecotError
from cli.core.git import git_toplevel, origin_repo
from cli.core.github import GitHubAPIError, GitHubClient, GitHubNotFoundError
from cli.core.ref_parser import RefParseError, parse_pr_ref
from cli.core.release import ReleaseError, run_preflight
from cli.core.security_alerts import (
    ScanAlertStatus,
    SecurityAlertError,
    fetch_code_scanning_status,
    fetch_secret_scanning_status,
)

# ヘルパー関数


def resolve_release_target_repo(
    ctx: typer.Context | None, cwd: Path | None = None
) -> tuple[str, str]:
    """Decide the target (owner, repo) of the release commands.

    When the call goes through the ``@require_repo_match`` decorator,
    ``ctx.obj["_policy_resolved_repo"]`` holds a ``RepoRef``.
    So read ``.owner`` / ``.repo`` by duck-typing and adopt them at once (avoids resolving twice).

    Without the decorator (a direct call from a unit test, for example), the order is as before:

    1. If the global ``--repo`` (``ctx.obj["repo"]``) is given, adopt that value.
    2. Otherwise detect it from the git remote (origin).
    3. If neither works, raise ``typer.Exit(1)``.
    """
    resolved = read_resolved_repo(ctx)
    if resolved is not None:
        return resolved

    explicit: str | None = None
    obj: Any = ctx.obj if ctx is not None else None
    if isinstance(obj, dict):
        value = cast("dict[str, Any]", obj).get("repo")
        if isinstance(value, str):
            explicit = value

    if explicit is not None:
        parts = explicit.split("/")
        if len(parts) != 2:
            typer.echo(
                f"エラー: --repo の形式が不正です: {repr(explicit)} "
                "('owner/repo' 形式で指定してください)",
                err=True,
            )
            raise typer.Exit(1)
        return parts[0], parts[1]

    origin = origin_repo(cwd)
    if origin is None:
        typer.echo("エラー: originリモートからリポジトリ情報を取得できません", err=True)
        raise typer.Exit(1)
    _host, owner, repo = origin
    return owner, repo


def _resolve_package_context(
    repo_obj: Repository | None,
    package: str | None,
    git_root: Path,
    owner: str,
    repo: str,
) -> tuple[Path, str | None]:
    """Resolve the 4 branches of packages present or not x --package given or not.

    Returns:
        (changelog_path, tag_prefix) - tag_prefix is the package name
        in monorepo mode and None in single mode.

    Raises:
        typer.Exit(1): on an inconsistency (--package given without packages configured, etc.).
    """
    if repo_obj and repo_obj.packages:
        if package is None:
            names = ", ".join(p.name for p in repo_obj.packages)
            typer.echo(
                f"エラー: {owner}/{repo} は monorepo 構成です。"
                f"--package を指定してください。利用可能: {names}",
                err=True,
            )
            raise typer.Exit(1)
        pkg = repo_obj.find_package(package)
        if pkg is None:
            names = ", ".join(p.name for p in repo_obj.packages)
            typer.echo(
                f"エラー: パッケージ '{package}' は {owner}/{repo} に登録されていません。"
                f"利用可能: {names}",
                err=True,
            )
            raise typer.Exit(1)
        return git_root / pkg.changelog, pkg.name

    if package is not None:
        typer.echo(
            f"エラー: {owner}/{repo} に packages 設定がありません。"
            "--package は monorepo 構成のリポでのみ使用できます。",
            err=True,
        )
        raise typer.Exit(1)

    changelog_file = repo_obj.changelog_file if repo_obj else None
    return resolve_changelog_path(git_root, changelog_file), None


def _require_branch_setting(branch: str | None, kind: str, owner: str, repo: str) -> str:
    """If develop_branch / release_branch is not set, show how to set it and exit 1"""
    if not branch:
        typer.echo(
            f"エラー: {kind}_branchが設定されていません。\n"
            f"→ pecot project set-repo {owner}/{repo} "
            f"--{kind}-branch <ブランチ名> で設定してください。",
            err=True,
        )
        raise typer.Exit(1)
    return branch


@dataclass(frozen=True)
class _ReleaseContext:
    """What release preflight / create both resolve"""

    config: ProjectConfig
    owner: str
    repo: str
    repo_obj: Repository | None
    changelog_path: Path
    tag_prefix: str | None


def _load_release_context(
    ctx: typer.Context,
    cwd: Path,
    package: str | None,
    *,
    version: str | None = None,
    nx_alerts_only: bool = False,
) -> _ReleaseContext:
    """Resolve the git root, target repository, project config, and CHANGELOG path (exit 1 on failure)

    When ``nx_alerts_only`` is true and the target repository is nx, reject the version argument and ``--package``.
    Also skip package resolution (nx does not use packages even if they are configured).
    """
    # git root 取得
    git_root = git_toplevel(cwd)
    if git_root is None:
        typer.echo("エラー: gitリポジトリのルートディレクトリが見つかりません", err=True)
        raise typer.Exit(1)

    # リポジトリ情報取得: グローバル --repo 優先 (FR-009b)
    owner, repo = resolve_release_target_repo(ctx, cwd)

    # プロジェクト設定からブランチ情報取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # CHANGELOGパス解決 + package 分岐
    repo_obj = config.find_repository(owner, repo)
    if nx_alerts_only and repo_obj is not None and repo_obj.effective_release_type == "nx":
        _reject_nx_arguments(version, package)
        changelog_path = resolve_changelog_path(git_root, repo_obj.changelog_file)
        return _ReleaseContext(config, owner, repo, repo_obj, changelog_path, None)
    changelog_path, tag_prefix = _resolve_package_context(repo_obj, package, git_root, owner, repo)
    return _ReleaseContext(config, owner, repo, repo_obj, changelog_path, tag_prefix)


def _reject_nx_arguments(version: str | None, package: str | None) -> None:
    """An nx repository accepts neither the version argument nor --package (exit 1 if given)"""
    if version is not None or package is not None:
        typer.echo(
            "エラー: release_type が nx のリポでは version 引数と --package を指定できません。"
            "引数なしで実行してください（version は Nx Release が決めます）。",
            err=True,
        )
        raise typer.Exit(1)


def _alert_label(number: int, package: str | None, severity: str | None = None) -> str:
    detail = ", ".join(v for v in (package, severity) if v)
    return f"#{number} ({detail})" if detail else f"#{number}"


def _warn_alerts_unavailable(reason: str) -> None:
    """Print the warning that Dependabot alerts could not be fetched, in 2 lines. Only the first line of the reason is used"""
    lines = reason.strip().splitlines()
    first = lines[0].strip().rstrip("。.").rstrip() if lines else ""
    typer.echo("Warning: Could not check Dependabot alerts. The release is not blocked.")
    typer.echo(f"  Reason: {first}")


def _check_dependabot_alerts(config: ProjectConfig, owner: str, repo: str) -> None:
    """Open Dependabot alerts only produce a warning and do not stop the release

    A repository with alerts disabled, or with 0 open alerts, prints a check mark. Failing to fetch the list is also only a warning.
    """
    try:
        client = GitHubClient(host=config.host)
        status = fetch_dependabot_alert_status(client, config.host, owner, repo)
    except DependabotAlertError as e:
        _warn_alerts_unavailable(str(e))
        return
    except GitHubAPIError as e:
        _warn_alerts_unavailable(e.message)
        return

    if not status.enabled:
        typer.echo("✓ Dependabot alerts: 無効")
        return
    if status.open_count == 0:
        typer.echo("✓ Dependabot alerts: open 0")
        return
    noun = "alert" if status.open_count == 1 else "alerts"
    listing = "".join(
        f"  {_alert_label(a.number, a.package, a.severity)}\n" for a in status.open_alerts
    )
    severity = f" (highest severity: {status.max_severity})" if status.max_severity else ""
    typer.echo(
        f"Warning: {status.open_count} open Dependabot {noun}{severity}. "
        "The release is not blocked.\n"
        f"{listing}"
        f"→ {status.alerts_url}"
    )


def _check_scanning_alerts(
    name: str,
    fetch: Callable[[GitHubClient, str, str, str], ScanAlertStatus],
    config: ProjectConfig,
    owner: str,
    repo: str,
) -> None:
    """Exit 1 if there is an open code scanning / secret scanning alert. A repository with the feature disabled passes

    Unlike Dependabot, these two kinds stop the release on an open alert. Dismissing is the way to close one.
    """
    try:
        status: ScanAlertStatus = fetch(GitHubClient(host=config.host), config.host, owner, repo)
    except SecurityAlertError as e:
        typer.echo(f"エラー: {name} の状態を確認できません: {e}", err=True)
        raise typer.Exit(1) from None
    if not status.enabled:
        typer.echo(f"✓ {name}: 無効")
        return
    if status.open_count == 0:
        typer.echo(f"✓ {name}: open 0")
        return
    listing = "".join(f"  #{n}\n" for n in status.open_numbers)
    typer.echo(
        f"エラー: {name} の alert が open {status.open_count} 件\n"
        f"{listing}"
        f"→ {status.alerts_url}\n"
        "  解消（fixed）か理由付きの dismiss で 0 件にしてから再実行してください。",
        err=True,
    )
    raise typer.Exit(1)


def _check_alerts(config: ProjectConfig, owner: str, repo: str) -> None:
    """Check Dependabot, code scanning, and secret scanning. Dependabot only warns;
    exit 1 if either code scanning or secret scanning fails

    Even if one kind fails first, the rest are still checked before the exit code is decided (everything shows up in one run).
    """
    checks: list[Callable[[], None]] = [
        lambda: _check_dependabot_alerts(config, owner, repo),
        lambda: _check_scanning_alerts(
            "code scanning", fetch_code_scanning_status, config, owner, repo
        ),
        lambda: _check_scanning_alerts(
            "secret scanning", fetch_secret_scanning_status, config, owner, repo
        ),
    ]
    failed = False
    for check in checks:
        try:
            check()
        except typer.Exit:
            failed = True
        except (httpx.HTTPError, PecotError) as e:
            typer.echo(f"エラー: alert の状態を確認できません: {e}", err=True)
            failed = True
    if failed:
        raise typer.Exit(1)


# コマンド実装


@require_repo_match(mode="warn")
def release_preflight(
    ctx: typer.Context,
    version: Annotated[
        str | None,
        typer.Argument(
            help="Release version (detected from the CHANGELOG when omitted)",
        ),
    ] = None,
    package: Annotated[
        str | None,
        typer.Option(
            "--package",
            help="Package name in a monorepo (required for repositories with packages configured)",
        ),
    ] = None,
) -> None:
    """Run the pre-release checks (preflight)

    Checks the open Dependabot, code scanning, and secret scanning alerts.
    A single open code scanning or secret scanning alert fails the check.
    Dependabot only warns and does not stop.
    Also checks CHANGELOG.md, validates the version, confirms the tag does not exist,
    checks the branch diff, and extracts the release notes.
    For a repository whose release_type is nx, only the alerts are checked.

    Examples:
        # Detect the version automatically
        $ pecot release preflight

        # Give the version
        $ pecot release preflight 0.6.1
    """
    cwd = Path.cwd()
    rc = _load_release_context(ctx, cwd, package, version=version, nx_alerts_only=True)
    config, owner, repo = rc.config, rc.owner, rc.repo
    is_nx = rc.repo_obj is not None and rc.repo_obj.effective_release_type == "nx"

    typer.echo("=== Release Preflight Check ===\n")
    _check_alerts(config, owner, repo)
    if is_nx:
        # version 整合・タグ・差分は Nx Release が担うため alert の確認だけで終える
        typer.echo("\n=== Preflight Check Passed ===")
        return

    develop_branch = config.get_develop_branch(owner, repo)
    release_branch = config.get_release_branch(owner, repo)
    develop_branch = _require_branch_setting(develop_branch, "develop", owner, repo)
    release_branch = _require_branch_setting(release_branch, "release", owner, repo)

    try:
        result = run_preflight(
            changelog_path=rc.changelog_path,
            develop_branch=develop_branch,
            release_branch=release_branch,
            version=version,
            cwd=cwd,
            tag_prefix=rc.tag_prefix,
        )
    except ReleaseError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None

    # 結果表示
    if version is None:
        typer.echo(f"✓ Auto-detected version: {result.version}")
    else:
        typer.echo(f"✓ Version {result.version} found in CHANGELOG.md")

    typer.echo(f"✓ Tag {result.tag_name} does not exist")
    typer.echo(
        f"✓ {result.diff_count} commits to release "
        f"(origin/{result.develop_branch} → origin/{result.release_branch})"
    )

    typer.echo("\n=== Preflight Check Passed ===\n")
    typer.echo(f"Version: {result.version}\n")
    typer.echo("Release Notes:")
    typer.echo(result.release_notes)


def _read_release_notes(changelog_path: Path, version: str) -> str:
    """Get the release notes for the version from the CHANGELOG (exit 1 if missing)"""
    try:
        return extract_version_release_notes(changelog_path, version)
    except FileNotFoundError:
        typer.echo(f"エラー: {changelog_path.name}が見つかりません: {changelog_path}", err=True)
        raise typer.Exit(1) from None
    except VersionNotFoundError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None


def _echo_release_dry_run(
    owner: str,
    repo: str,
    tag_name: str,
    release_branch: str,
    release_name: str,
    release_notes: str,
) -> None:
    """Preview for release create --dry-run"""
    typer.echo("[DRY RUN] リリース作成プレビュー\n")
    typer.echo(f"  リポジトリ: {owner}/{repo}")
    typer.echo(f"  タグ: {tag_name}")
    typer.echo(f"  ターゲット: {release_branch}")
    typer.echo(f"  リリース名: {release_name}")
    typer.echo("\n  リリースノート:")
    for line in release_notes.splitlines():
        typer.echo(f"    {line}")


@require_repo_match(mode="warn")
def release_create(
    ctx: typer.Context,
    version: Annotated[
        str,
        typer.Argument(
            help="Release version (for example 0.6.1)",
        ),
    ],
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            help="Show what would happen without changing anything",
        ),
    ] = False,
    package: Annotated[
        str | None,
        typer.Option(
            "--package",
            help="Package name in a monorepo (required for repositories with packages configured)",
        ),
    ] = None,
) -> None:
    """Create a GitHub release and its tag

    Gets the release notes from CHANGELOG.md
    and creates the release and the tag together through the GitHub API.
    No git tag or git push is needed.

    Examples:
        # Create a release
        $ pecot release create 0.6.1

        # Dry-run
        $ pecot release create 0.6.1 --dry-run
    """
    cwd = Path.cwd()

    # バージョン検証
    try:
        validate_semver(version)
    except Exception as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None

    rc = _load_release_context(ctx, cwd, package)
    config, owner, repo, tag_prefix = rc.config, rc.owner, rc.repo, rc.tag_prefix

    # リリースノート取得
    release_notes = _read_release_notes(rc.changelog_path, version)

    release_branch = _require_branch_setting(
        config.get_release_branch(owner, repo), "release", owner, repo
    )

    tag_name = f"{tag_prefix}-v{version}" if tag_prefix else f"v{version}"
    release_name = f"{tag_prefix} v{version}" if tag_prefix else tag_name

    # dry-runモード
    if dry_run:
        _echo_release_dry_run(owner, repo, tag_name, release_branch, release_name, release_notes)
        return

    # GitHubクライアント初期化
    client = GitHubClient(host=config.host)

    # リリース作成
    typer.echo(f"Creating GitHub release: {tag_name}...")

    try:
        result = client.create_release(
            owner=owner,
            repo=repo,
            tag_name=tag_name,
            name=release_name,
            body=release_notes,
            target_commitish=release_branch,
        )
    except GitHubAPIError as e:
        typer.echo(f"エラー: リリース作成に失敗しました: {e.message}", err=True)
        raise typer.Exit(1) from None

    release_url = result.get("html_url", "")
    typer.echo(f"✓ GitHub release created: {tag_name}")
    typer.echo(f"\nRelease URL: {release_url}")


def _fetch_release_pr(
    config: ProjectConfig, owner: str, repo: str, pr_number: int
) -> tuple[GitHubClient, dict[str, Any]]:
    """3. Initialize the client and get the PR information (exit 1 on failure)"""
    try:
        client = GitHubClient(host=config.host)
        pr = client.get_pull_request_slim(owner, repo, pr_number)
    except GitHubNotFoundError:
        typer.echo(f"エラー: PRが見つかりません: {owner}/{repo}/{pr_number}", err=True)
        raise typer.Exit(1) from None
    except GitHubAPIError as e:
        typer.echo(f"エラー: {e.message}", err=True)
        raise typer.Exit(1) from None
    return client, pr


def _check_release_pr(
    pr: dict[str, Any], config: ProjectConfig, owner: str, repo: str, pr_number: int, admin: bool
) -> None:
    """4-5. Check the PR state and verify the base branch (it must equal release_branch)"""
    if pr["state"] == "MERGED":
        typer.echo(f"エラー: PR #{pr_number} は既にマージ済みです", err=True)
        raise typer.Exit(1)

    if pr["state"] == "CLOSED":
        typer.echo(f"エラー: PR #{pr_number} はクローズされています", err=True)
        raise typer.Exit(1)

    if pr["mergeable"] == "CONFLICTING" and not admin:
        typer.echo(f"エラー: PR #{pr_number} にコンフリクトがあります。解消が必要です", err=True)
        typer.echo("  ヒント: --admin オプションで強制マージを試行できます", err=True)
        raise typer.Exit(1)

    release_branch = _require_branch_setting(
        config.get_release_branch(owner, repo), "release", owner, repo
    )

    if pr["base_ref"] != release_branch:
        typer.echo(
            f"エラー: PR #{pr_number} のbaseブランチが release_branch と一致しません\n"
            f"  base: {pr['base_ref']}\n"
            f"  release_branch: {release_branch}",
            err=True,
        )
        raise typer.Exit(1)


def _delete_release_head_branch(
    client: GitHubClient, owner: str, repo: str, head_branch: str
) -> bool:
    """8. Delete the head branch and return whether it was deleted"""
    typer.echo(f"\nブランチ '{head_branch}' を削除中...")
    try:
        client.delete_branch(owner, repo, head_branch)
        typer.echo(f"  ✔ ブランチ '{head_branch}' を削除しました")
        return True
    except GitHubAPIError as e:
        typer.echo(f"  ⚠ ブランチ削除に失敗: {e.message}", err=True)
        return False


@require_repo_match(mode="warn")
def release_merge(
    ctx: typer.Context,
    pr_ref: Annotated[
        str,
        typer.Argument(help="PR reference (owner/repo/123)"),
    ],
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            "-n",
            help="Show what would happen without merging",
        ),
    ] = False,
    delete_branch: Annotated[
        bool,
        typer.Option(
            "--delete-branch",
            "-d",
            help="Delete the branch after merging",
        ),
    ] = False,
    admin: Annotated[
        bool,
        typer.Option(
            "--admin",
            help="Merge with admin rights (skip the mergeability check)",
        ),
    ] = False,
) -> None:
    """Merge a release PR with a regular merge

    Fixes the merge method to merge (regular)
    to prevent squash merge from breaking the merge-base.

    For release PRs only (develop-aist -> main, etc.).
    Verifies that the base branch equals release_branch.

    Examples:
        pecot release merge owner/repo/123

        pecot release merge owner/repo/123 --dry-run

        pecot release merge owner/repo/123 --delete-branch
    """
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. pr_ref をパース（フル形式必須、base_repo は渡さない）
    try:
        ref = parse_pr_ref(pr_ref)
    except RefParseError as e:
        typer.echo(f"エラー: {e.message}", err=True)
        raise typer.Exit(2) from None

    owner, repo, pr_number = ref.repo.owner, ref.repo.repo, ref.number
    label = f"{owner}/{repo}/{pr_number}"

    # 3. クライアント初期化・PR情報取得
    client, pr = _fetch_release_pr(config, owner, repo, pr_number)

    # 4〜5. PRの状態チェック・baseブランチ検証
    _check_release_pr(pr, config, owner, repo, pr_number, admin)

    # 6. dry-runモード
    if dry_run:
        typer.echo("=== ドライラン（実際にはマージしません） ===\n")
        typer.echo(f"PR: {label}")
        typer.echo(f"タイトル: {pr['title']}")
        typer.echo(f"ブランチ: {pr['head_ref']} → {pr['base_ref']}")
        typer.echo("マージ方法: merge (regular)")
        return

    # 7. マージ実行（merge method 固定）
    try:
        result = client.merge_pull_request(owner, repo, pr_number, merge_method="merge")
    except GitHubAPIError as e:
        typer.echo(f"エラー: マージに失敗しました: {e.message}", err=True)
        raise typer.Exit(1) from None

    typer.echo(f"✔ PR #{pr_number} をマージしました (SHA: {result.get('sha', 'N/A')[:7]})")

    # 8. ブランチ削除（オプション）
    head_branch = pr["head_ref"]
    branch_deleted = delete_branch and _delete_release_head_branch(client, owner, repo, head_branch)

    # 9. サマリー出力
    typer.echo("\n=== マージ完了 ===")
    typer.echo(f"PR: {label}")
    typer.echo(f"タイトル: {pr['title']}")
    typer.echo("マージ方法: merge (regular)")
    if branch_deleted:
        typer.echo(f"削除したブランチ: {head_branch}")
