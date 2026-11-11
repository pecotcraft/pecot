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

from cli.commands._output import Operation, Output, Verb
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
from cli.core.git import git_toplevel, primary_remote_name, primary_remote_repo
from cli.core.github import GitHubAPIError, GitHubClient, GitHubNotFoundError
from cli.core.github.errors import describe_api_error
from cli.core.ref_parser import RefParseError, parse_pr_ref
from cli.core.release import ReleaseError, run_preflight
from cli.core.security_alerts import (
    ScanAlertStatus,
    SecurityAlertError,
    fetch_code_scanning_status,
    fetch_secret_scanning_status,
)

_OUT = Output(dry_run=False)

# ヘルパー関数


def resolve_release_target_repo(
    ctx: typer.Context | None, cwd: Path | None = None
) -> tuple[str, str]:
    """Decide the target (owner, repo) of the release commands.

    Order: the ``@require_repo_match`` result, the global ``--repo``, then the git remote (origin, else the first remote).
    Raises ``typer.Exit(1)`` when none of them works.
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
            _OUT.error(f"invalid --repo format: {explicit!r}\nspecify it as owner/repo")
            raise typer.Exit(1)
        return parts[0], parts[1]

    origin = primary_remote_repo(cwd)
    if origin is None:
        _OUT.error("could not read the repository from the git remote")
        raise typer.Exit(1)
    _host, owner, repo = origin
    return owner, repo


def _resolve_package_context(
    out: Output,
    repo_obj: Repository | None,
    package: str | None,
    git_root: Path,
    owner: str,
    repo: str,
) -> tuple[Path, str | None]:
    """Resolve the 4 branches of packages present or not x --package given or not.

    Returns (changelog_path, tag_prefix): the prefix is the package name in monorepo mode, else None.
    Raises typer.Exit(1) on an inconsistency.
    """
    if repo_obj and repo_obj.packages:
        names = ", ".join(p.name for p in repo_obj.packages)
        if package is None:
            out.error(f"{owner}/{repo} is a monorepo\nspecify --package (available: {names})")
            raise typer.Exit(1)
        pkg = repo_obj.find_package(package)
        if pkg is None:
            out.error(
                f"package '{package}' is not registered in {owner}/{repo}\navailable: {names}"
            )
            raise typer.Exit(1)
        return git_root / pkg.changelog, pkg.name

    if package is not None:
        out.error(
            f"{owner}/{repo} has no packages configured\n--package can only be used in a monorepo"
        )
        raise typer.Exit(1)

    changelog_file = repo_obj.changelog_file if repo_obj else None
    return resolve_changelog_path(git_root, changelog_file), None


def _require_branch_setting(
    out: Output, branch: str | None, kind: str, owner: str, repo: str
) -> str:
    """If develop_branch / release_branch is not set, show how to set it and exit 1"""
    if not branch:
        out.error(
            f"{kind}_branch is not set for {owner}/{repo}\n"
            f"set it with: pecot project set-repo {owner}/{repo} --{kind}-branch <branch>"
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
    out: Output,
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
    git_root = git_toplevel(cwd)
    if git_root is None:
        out.error("could not find the root directory of the git repository")
        raise typer.Exit(1)

    owner, repo = resolve_release_target_repo(ctx, cwd)

    config = load_active_config()
    if config is None:
        out.error("no active project\nrun: pecot project activate <PROJECT>")
        raise typer.Exit(1)

    repo_obj = config.find_repository(owner, repo)
    if nx_alerts_only and repo_obj is not None and repo_obj.effective_release_type == "nx":
        _reject_nx_arguments(out, version, package)
        changelog_path = resolve_changelog_path(git_root, repo_obj.changelog_file)
        return _ReleaseContext(config, owner, repo, repo_obj, changelog_path, None)
    changelog_path, tag_prefix = _resolve_package_context(
        out, repo_obj, package, git_root, owner, repo
    )
    return _ReleaseContext(config, owner, repo, repo_obj, changelog_path, tag_prefix)


def _reject_nx_arguments(out: Output, version: str | None, package: str | None) -> None:
    """An nx repository accepts neither the version argument nor --package (exit 1 if given)"""
    if version is not None or package is not None:
        out.error(
            "the version argument and --package cannot be used when release_type is nx\n"
            "run it without arguments (Nx Release decides the version)"
        )
        raise typer.Exit(1)


def _alert_label(number: int, package: str | None, severity: str | None = None) -> str:
    detail = ", ".join(v for v in (package, severity) if v)
    return f"#{number} ({detail})" if detail else f"#{number}"


def _warn_alerts_unavailable(out: Output, reason: str) -> None:
    """Warn that Dependabot alerts could not be fetched, in 2 lines. Only the first line of the reason is used"""
    lines = reason.strip().splitlines()
    first = lines[0].strip().rstrip(".").rstrip() if lines else ""
    out.warning(f"could not check Dependabot alerts. The release is not blocked.\nreason: {first}")


def _check_dependabot_alerts(out: Output, config: ProjectConfig, owner: str, repo: str) -> None:
    """Open Dependabot alerts only produce a warning and do not stop the release"""
    try:
        client = GitHubClient(host=config.host)
        status = fetch_dependabot_alert_status(client, config.host, owner, repo)
    except DependabotAlertError as e:
        _warn_alerts_unavailable(out, str(e))
        return
    except GitHubAPIError as e:
        _warn_alerts_unavailable(out, e.message)
        return

    if not status.enabled:
        out.done(Operation(Verb.SKIP, "Dependabot alerts (feature disabled)"))
        return
    if status.open_count == 0:
        out.count("open Dependabot alerts", 0)
        return
    severity = f" (highest severity: {status.max_severity})" if status.max_severity else ""
    listing = "".join(
        f"\n{_alert_label(a.number, a.package, a.severity)}" for a in status.open_alerts
    )
    noun = "alert" if status.open_count == 1 else "alerts"
    out.warning(
        f"{status.open_count} open Dependabot {noun}{severity}. The release is not blocked."
        f"{listing}\n→ {status.alerts_url}"
    )


def _check_scanning_alerts(
    out: Output,
    name: str,
    fetch: Callable[[GitHubClient, str, str, str], ScanAlertStatus],
    config: ProjectConfig,
    owner: str,
    repo: str,
) -> None:
    """Exit 1 if there is an open code scanning / secret scanning alert. A repository with the feature disabled passes"""
    try:
        status: ScanAlertStatus = fetch(GitHubClient(host=config.host), config.host, owner, repo)
    except SecurityAlertError as e:
        out.error(f"could not check {name}: {e}")
        raise typer.Exit(1) from None
    if not status.enabled:
        out.done(Operation(Verb.SKIP, f"{name} (feature disabled)"))
        return
    if status.open_count == 0:
        out.count(f"open {name} alerts", 0)
        return
    listing = "".join(f"\n#{n}" for n in status.open_numbers)
    out.error(
        f"{name} has {status.open_count} open {'alert' if status.open_count == 1 else 'alerts'}"
        f"{listing}\n→ {status.alerts_url}\n"
        "close them (fixed, or dismissed with a reason) and run again"
    )
    raise typer.Exit(1)


def _check_alerts(out: Output, config: ProjectConfig, owner: str, repo: str) -> None:
    """Check Dependabot, code scanning, and secret scanning. Dependabot only warns;
    exit 1 if either code scanning or secret scanning fails

    Even if one kind fails first, the rest are still checked before the exit code is decided.
    """
    checks: list[Callable[[], None]] = [
        lambda: _check_dependabot_alerts(out, config, owner, repo),
        lambda: _check_scanning_alerts(
            out, "code scanning", fetch_code_scanning_status, config, owner, repo
        ),
        lambda: _check_scanning_alerts(
            out, "secret scanning", fetch_secret_scanning_status, config, owner, repo
        ),
    ]
    failed = False
    for check in checks:
        try:
            check()
        except typer.Exit:
            failed = True
        except (httpx.HTTPError, PecotError) as e:
            out.error(f"could not check alerts: {e}")
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
    """Run the pre-release checks (preflight); for an nx repository only the alerts are checked

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
    out = Output(False)
    cwd = Path.cwd()
    rc = _load_release_context(out, ctx, cwd, package, version=version, nx_alerts_only=True)
    config, owner, repo = rc.config, rc.owner, rc.repo
    is_nx = rc.repo_obj is not None and rc.repo_obj.effective_release_type == "nx"

    _check_alerts(out, config, owner, repo)
    if is_nx:
        return

    develop_branch = _require_branch_setting(
        out, config.get_develop_branch(owner, repo), "develop", owner, repo
    )
    release_branch = _require_branch_setting(
        out, config.get_release_branch(owner, repo), "release", owner, repo
    )

    remote = primary_remote_name(cwd) or "origin"
    try:
        result = run_preflight(
            changelog_path=rc.changelog_path,
            develop_branch=develop_branch,
            release_branch=release_branch,
            version=version,
            cwd=cwd,
            tag_prefix=rc.tag_prefix,
            remote=remote,
        )
    except ReleaseError as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    out.count(
        f"commits to release ({remote}/{result.develop_branch} -> {remote}/{result.release_branch})",
        result.diff_count,
    )
    out.data(f"version: {result.version}\ntag: {result.tag_name}\n\n{result.release_notes}")


def _read_release_notes(out: Output, changelog_path: Path, version: str) -> str:
    """Get the release notes for the version from the CHANGELOG (exit 1 if missing)"""
    try:
        return extract_version_release_notes(changelog_path, version)
    except FileNotFoundError:
        out.error(f"{changelog_path.name} not found: {changelog_path}")
        raise typer.Exit(1) from None
    except VersionNotFoundError as e:
        out.error(str(e))
        raise typer.Exit(1) from None


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
    """Create a GitHub release and its tag (the release notes come from the CHANGELOG)

    Gets the release notes from CHANGELOG.md
    and creates the release and the tag together through the GitHub API.
    No git tag or git push is needed.

    Examples:
        # Create a release
        $ pecot release create 0.6.1

        # Dry-run
        $ pecot release create 0.6.1 --dry-run
    """
    out = Output(dry_run)
    cwd = Path.cwd()

    try:
        validate_semver(version)
    except Exception as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    rc = _load_release_context(out, ctx, cwd, package)
    config, owner, repo, tag_prefix = rc.config, rc.owner, rc.repo, rc.tag_prefix

    release_notes = _read_release_notes(out, rc.changelog_path, version)

    release_branch = _require_branch_setting(
        out, config.get_release_branch(owner, repo), "release", owner, repo
    )

    tag_name = f"{tag_prefix}-v{version}" if tag_prefix else f"v{version}"
    release_name = f"{tag_prefix} v{version}" if tag_prefix else tag_name
    op = Operation(Verb.CREATE, f"release {tag_name} on {release_branch}")

    if dry_run:
        out.planned(op)
        out.data(release_notes)
        return

    client = GitHubClient(host=config.host)

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
        out.error(f"could not create release {tag_name} in {owner}/{repo}: {describe_api_error(e)}")
        raise typer.Exit(1) from None

    out.done(op)
    out.data(str(result.get("html_url", "")))


def _fetch_release_pr(
    out: Output, config: ProjectConfig, owner: str, repo: str, pr_number: int
) -> tuple[GitHubClient, dict[str, Any]]:
    """Initialize the client and get the PR information (exit 1 on failure)"""
    try:
        client = GitHubClient(host=config.host)
        pr = client.get_pull_request_slim(owner, repo, pr_number)
    except GitHubNotFoundError:
        out.error(f"PR {owner}/{repo}/{pr_number} not found")
        raise typer.Exit(1) from None
    except GitHubAPIError as e:
        out.error(f"could not read PR {owner}/{repo}/{pr_number}: {describe_api_error(e)}")
        raise typer.Exit(1) from None
    return client, pr


def _check_release_pr(
    out: Output,
    pr: dict[str, Any],
    config: ProjectConfig,
    owner: str,
    repo: str,
    pr_number: int,
    admin: bool,
) -> None:
    """Check the PR state and verify the base branch (it must equal release_branch)"""
    if pr["state"] == "MERGED":
        out.error(f"PR #{pr_number} is already merged")
        raise typer.Exit(1)

    if pr["state"] == "CLOSED":
        out.error(f"PR #{pr_number} is closed")
        raise typer.Exit(1)

    if pr["mergeable"] == "CONFLICTING" and not admin:
        out.error(
            f"PR #{pr_number} has conflicts that must be resolved\n"
            "to try a forced merge, add --admin"
        )
        raise typer.Exit(1)

    release_branch = _require_branch_setting(
        out, config.get_release_branch(owner, repo), "release", owner, repo
    )

    if pr["base_ref"] != release_branch:
        out.error(
            f"the base branch of PR #{pr_number} does not match release_branch\n"
            f"base: {pr['base_ref']}\n"
            f"release_branch: {release_branch}"
        )
        raise typer.Exit(1)


def _delete_release_head_branch(
    out: Output, client: GitHubClient, owner: str, repo: str, head_branch: str
) -> None:
    """Delete the remote head branch (a failure is only a warning)"""
    try:
        client.delete_branch(owner, repo, head_branch)
        out.done(Operation(Verb.DELETE, f"remote branch {head_branch} in {owner}/{repo}"))
    except GitHubAPIError as e:
        out.warning(f"deleting remote branch {head_branch} failed: {describe_api_error(e)}")


@require_repo_match(mode="reject")
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
    out = Output(dry_run)
    config = load_active_config()
    if config is None:
        out.error("no active project\nrun: pecot project activate <PROJECT>")
        raise typer.Exit(1)

    try:
        ref = parse_pr_ref(pr_ref)
    except RefParseError as e:
        out.error(e.message)
        raise typer.Exit(2) from None

    owner, repo, pr_number = ref.repo.owner, ref.repo.repo, ref.number

    client, pr = _fetch_release_pr(out, config, owner, repo, pr_number)
    _check_release_pr(out, pr, config, owner, repo, pr_number, admin)

    head_branch = pr["head_ref"]
    op = Operation(
        Verb.MERGE,
        f"PR {owner}/{repo}/{pr_number} ({head_branch} -> {pr['base_ref']}, merge commit)",
    )
    if dry_run:
        out.planned(op)
        return

    try:
        client.merge_pull_request(owner, repo, pr_number, merge_method="merge")
    except GitHubAPIError as e:
        out.error(f"could not merge PR {owner}/{repo}/{pr_number}: {describe_api_error(e)}")
        raise typer.Exit(1) from None

    out.done(op)

    if delete_branch:
        _delete_release_head_branch(out, client, owner, repo, head_branch)
