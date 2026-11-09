"""cli/release.py - リリース操作コマンド実装

release preflight / release create コマンドを提供。
シェルスクリプト (release-preflight.sh, create-github-release.sh) を
Python CLIに置き換える。
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
    EXCEPTIONS_PATH,
    DependabotAlertError,
    DependabotException,
    OpenAlert,
    fetch_dependabot_alert_status,
    load_dependabot_exceptions,
    max_severity_of,
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
    """release系コマンドの操作対象 (owner, repo) を決定する (FR-009b)。

    decorator ``@require_repo_match`` 経由なら、
    ``ctx.obj["_policy_resolved_repo"]`` に ``RepoRef`` が入っている。
    そのため、``.owner`` / ``.repo`` を duck-typing で読んで即採用する (二重解決の回避)。

    decorator 未経由 (unit test で直接呼ばれるケース等) は従来の決定順:

    1. グローバル ``--repo`` (``ctx.obj["repo"]``) が明示されていればその値を採用する。
    2. それ以外は git remote (origin) から自動検出する。
    3. いずれも取れなければ ``typer.Exit(1)`` とする。
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


def load_target(ctx: typer.Context) -> tuple[ProjectConfig, str, str]:
    """対象リポ（git の origin、--repo 優先）とアクティブなプロジェクトを解決する

    ``pecot security sync`` と ``pecot dependabot sync`` が使う。

    Raises:
        typer.Exit(1): リポかアクティブなプロジェクトが解決できないとき
    """
    owner, repo = resolve_release_target_repo(ctx, Path.cwd())
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)
    return config, owner, repo


def _resolve_package_context(
    repo_obj: Repository | None,
    package: str | None,
    git_root: Path,
    owner: str,
    repo: str,
) -> tuple[Path, str | None]:
    """packages 有無 × --package 有無の 4 分岐を解決する。

    Returns:
        (changelog_path, tag_prefix) — tag_prefix は monorepo 時のみ
        package 名、単一モード時は None。

    Raises:
        typer.Exit(1): 不整合（packages 未設定で --package 指定など）時。
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
    """develop_branch / release_branch が未設定なら設定方法を出して exit 1"""
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
    """release preflight / create が共通で解決する対象"""

    config: ProjectConfig
    owner: str
    repo: str
    repo_obj: Repository | None
    changelog_path: Path
    tag_prefix: str | None
    git_root: Path


def _load_release_context(
    ctx: typer.Context,
    cwd: Path,
    package: str | None,
    *,
    version: str | None = None,
    nx_alerts_only: bool = False,
) -> _ReleaseContext:
    """git root・対象リポ・プロジェクト設定・CHANGELOG パスを解決する（失敗時は exit 1）

    ``nx_alerts_only`` が真で対象リポが nx のときは、version 引数と ``--package`` を拒否する。
    package の解決も飛ばす（packages 設定があっても nx では使わないため）。
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
        return _ReleaseContext(config, owner, repo, repo_obj, changelog_path, None, git_root)
    changelog_path, tag_prefix = _resolve_package_context(repo_obj, package, git_root, owner, repo)
    return _ReleaseContext(config, owner, repo, repo_obj, changelog_path, tag_prefix, git_root)


def _reject_nx_arguments(version: str | None, package: str | None) -> None:
    """nx のリポでは version 引数と --package を受け付けない（指定されていれば exit 1）"""
    if version is not None or package is not None:
        typer.echo(
            "エラー: release_type が nx のリポでは version 引数と --package を指定できません。"
            "引数なしで実行してください（version は Nx Release が決めます）。",
            err=True,
        )
        raise typer.Exit(1)


def _alert_label(number: int, package: str | None, severity: str | None = None) -> str:
    detail = "・".join(v for v in (package, severity) if v)
    return f"#{number}（{detail}）" if detail else f"#{number}"


def _report_exceptions(exceptions: list[DependabotException], open_alerts: list[OpenAlert]) -> None:
    """例外で通す alert と、要らなくなった例外を表示する"""
    open_numbers = {a.number for a in open_alerts}
    for e in exceptions:
        label = _alert_label(e.alert, e.package)
        if e.alert in open_numbers:
            typer.echo(f"警告: 例外として通す Dependabot alert {label}")
            typer.echo(f"    理由: {e.reason}")
            typer.echo(f"    見直し: {e.reevaluate}")
        else:
            typer.echo(
                f"警告: 例外の Dependabot alert {label}は open ではありません。"
                f"{EXCEPTIONS_PATH} から外してください。"
            )


def _check_dependabot_alerts(config: ProjectConfig, owner: str, repo: str, git_root: Path) -> None:
    """例外に載らない open の Dependabot alert があれば exit 1。alerts 無効のリポは通す

    例外は ``.github/dependabot-exceptions.json`` から読む。例外に載った open の alert は、
    理由と見直し条件を表示して通す。例外に載っているのに open でない alert は表示だけする。
    """
    try:
        exceptions = load_dependabot_exceptions(git_root)
        client = GitHubClient(host=config.host)
        status = fetch_dependabot_alert_status(client, config.host, owner, repo)
    except DependabotAlertError as e:
        typer.echo(f"エラー: Dependabot alert の状態を確認できません: {e}", err=True)
        raise typer.Exit(1) from None
    except GitHubAPIError as e:
        typer.echo(f"エラー: {e.message}", err=True)
        raise typer.Exit(1) from None

    if not status.enabled:
        typer.echo("✓ Dependabot alerts: 無効")
        return
    if exceptions:
        _report_exceptions(exceptions, status.open_alerts)
    excepted = {e.alert for e in exceptions or []}
    remaining = [a for a in status.open_alerts if a.number not in excepted]
    count = status.open_count - (len(status.open_alerts) - len(remaining))
    if status.open_count == 0:
        typer.echo("✓ Dependabot alerts: open 0")
        return
    if count == 0:
        typer.echo(f"✓ Dependabot alerts: open {status.open_count}（すべて例外）")
        return
    severity = max_severity_of(remaining) if exceptions else status.max_severity
    scope = "例外に載らない " if exceptions else ""
    listing = "".join(f"  {_alert_label(a.number, a.package, a.severity)}\n" for a in remaining)
    typer.echo(
        f"エラー: {scope}Dependabot alert が open {count} 件"
        f"（最高 severity: {severity}）\n"
        f"{listing}"
        f"→ {status.alerts_url}\n"
        "  解消（fixed）か理由付きの dismiss で 0 件にしてから再実行してください。\n"
        f"  修正版に上げられない alert は、理由と見直し条件を {EXCEPTIONS_PATH} に載せて通せます。",
        err=True,
    )
    raise typer.Exit(1)


def _check_scanning_alerts(
    name: str,
    fetch: Callable[[GitHubClient, str, str, str], ScanAlertStatus],
    config: ProjectConfig,
    owner: str,
    repo: str,
) -> None:
    """code scanning / secret scanning の open の alert があれば exit 1。無効のリポは通す

    この 2 種は dismiss が閉じる手段なので、Dependabot のような例外の仕組みを持たない。
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


def _check_alerts(config: ProjectConfig, owner: str, repo: str, git_root: Path) -> None:
    """Dependabot・code scanning・secret scanning の 3 つを確かめ、1 つでも失敗なら exit 1

    先に失敗した種類があっても残りを確かめてから終了コードを決める（一度で全部が分かる）。
    """
    checks: list[Callable[[], None]] = [
        lambda: _check_dependabot_alerts(config, owner, repo, git_root),
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
            help="リリースバージョン（省略時はCHANGELOGから自動検出）",
        ),
    ] = None,
    package: Annotated[
        str | None,
        typer.Option(
            "--package",
            help="monorepo 時のパッケージ名（packages 設定済リポで必須）",
        ),
    ] = None,
) -> None:
    """リリース前チェック（preflight）

    open の Dependabot・code scanning・secret scanning の alert を確かめる。
    1 件でもあれば失敗する。Dependabot は例外に載せた alert を除く。
    あわせて、CHANGELOG.md確認、バージョン検証、タグ不存在確認、
    ブランチ差分確認、リリースノート抽出をまとめて行う。
    release_type が nx のリポでは alert の確認だけを行う。

    Examples:
        # バージョン自動検出
        $ pecot release preflight

        # バージョン指定
        $ pecot release preflight 0.6.1
    """
    cwd = Path.cwd()
    rc = _load_release_context(ctx, cwd, package, version=version, nx_alerts_only=True)
    config, owner, repo = rc.config, rc.owner, rc.repo
    is_nx = rc.repo_obj is not None and rc.repo_obj.effective_release_type == "nx"

    typer.echo("=== Release Preflight Check ===\n")
    _check_alerts(config, owner, repo, rc.git_root)
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
    """CHANGELOG から該当バージョンのリリースノートを取得（無ければ exit 1）"""
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
    """release create --dry-run のプレビュー"""
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
            help="リリースバージョン（例: 0.6.1）",
        ),
    ],
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            help="実行せずにプレビューのみ表示",
        ),
    ] = False,
    package: Annotated[
        str | None,
        typer.Option(
            "--package",
            help="monorepo 時のパッケージ名（packages 設定済リポで必須）",
        ),
    ] = None,
) -> None:
    """GitHubリリースとタグを作成

    CHANGELOG.mdからリリースノートを取得し、
    GitHub APIでリリースとタグを同時作成する。
    git tag + git push が不要。

    Examples:
        # リリース作成
        $ pecot release create 0.6.1

        # ドライラン
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
    """3. クライアント初期化・PR情報取得（失敗時は exit 1）"""
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
    """4〜5. PRの状態チェックと base ブランチ検証（release_branch と一致すること）"""
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
    """8. head ブランチを削除し、削除できたかを返す"""
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
        typer.Argument(help="PR参照 (owner/repo/123形式)"),
    ],
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            "-n",
            help="ドライラン（実際にはマージしない）",
        ),
    ] = False,
    delete_branch: Annotated[
        bool,
        typer.Option(
            "--delete-branch",
            "-d",
            help="マージ後にブランチを削除",
        ),
    ] = False,
    admin: Annotated[
        bool,
        typer.Option(
            "--admin",
            help="管理者権限でマージ（マージ可能性チェックをスキップ）",
        ),
    ] = False,
) -> None:
    """リリースPRをregular mergeでマージ

    merge method を merge (regular) に固定し、
    squash merge による merge-base 破壊を防止する。

    リリースPR（develop-aist → main 等）専用。
    base ブランチが release_branch と一致することを検証する。

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
