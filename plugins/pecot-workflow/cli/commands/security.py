"""cli/security.py - security alert をボードの Issue に載せるコマンド

``pecot security sync`` は open の alert を Issue にし、閉じた alert の Issue を閉じる。
``pecot security review-exceptions`` は Dependabot の例外の見直しの Issue を作る。
Actions の schedule と手元の両方から同じコマンドで動かす。
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Literal, cast

import httpx
import typer

from cli.commands.release import resolve_release_target_repo
from cli.core.config import ProjectConfig, load_active_config
from cli.core.dependabot import DependabotAlertError, load_dependabot_exceptions
from cli.core.git import git_toplevel
from cli.core.github import GitHubAPIError, GitHubClient, GitHubNotFoundError
from cli.core.issue_board import (
    add_issue_to_board,
    create_issue,
    item_has_field_value,
    set_issue_field,
)
from cli.core.security_alerts import (
    ALERT_KINDS,
    ALERT_LABEL,
    KIND_LABELS,
    REVIEW_MARKER,
    REVIEW_TITLE,
    Alert,
    AlertKind,
    SecurityAlertError,
    SyncPlan,
    build_issue_body,
    build_issue_title,
    build_review_body,
    close_reason,
    list_open_alerts,
    normalize_alerts,
    plan_sync,
)

DryRunOption = Annotated[
    bool,
    typer.Option("--dry-run", help="作る・reopen する・閉じる予定を表示するだけで、何も変更しない"),
]

_BOARD_STATUS = "ready"


def _load_target(ctx: typer.Context) -> tuple[ProjectConfig, str, str]:
    """対象リポ（git の origin、--repo 優先）とアクティブなプロジェクトを解決する"""
    owner, repo = resolve_release_target_repo(ctx, Path.cwd())
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)
    return config, owner, repo


def _fetch_open_alerts(
    client: GitHubClient, host: str, owner: str, repo: str
) -> tuple[dict[AlertKind, list[Alert]], set[AlertKind], bool]:
    """3 種の open の alert を取る

    Returns:
        (種類ごとの alert, 作る・閉じるを飛ばす種類, 一覧を取れなかった種類があるか)。
        機能が無効のリポの種類は飛ばすだけで、取れなかったものには数えない。
    """
    found: dict[AlertKind, list[Alert]] = {}
    skipped: set[AlertKind] = set()
    failed = False
    for kind in ALERT_KINDS:
        try:
            raws = list_open_alerts(client, kind, owner, repo)
        except SecurityAlertError as e:
            skipped.add(kind)
            failed = True
            typer.echo(
                f"エラー: {KIND_LABELS[kind]} の一覧を取得できません（作る・閉じるを飛ばします）: {e}",
                err=True,
            )
            continue
        if raws is None:
            skipped.add(kind)
            typer.echo(f"{KIND_LABELS[kind]}: 無効のため飛ばします")
            continue
        found[kind] = normalize_alerts(kind, raws, host, owner, repo)
    return found, skipped, failed


def _echo_plan(plan: SyncPlan, dry_run: bool) -> None:
    prefix = "[dry-run] " if dry_run else ""
    for a in plan.create:
        typer.echo(f"{prefix}作る: {a.kind} #{a.number}（Priority: {a.priority}）")
    for a, n in plan.reopen:
        typer.echo(f"{prefix}reopen する: {a.kind} #{a.number}（Issue #{n}）")
    for kind, number, n in plan.close:
        typer.echo(f"{prefix}閉じる候補: {kind} #{number}（Issue #{n}）")
    for kind, number, n, keep in plan.duplicates:
        typer.echo(f"{prefix}重複を閉じる: {kind} #{number}（Issue #{n}、残す Issue #{keep}）")
    typer.echo(
        f"{prefix}作る {len(plan.create)} 件・reopen {len(plan.reopen)} 件・"
        f"閉じる候補 {len(plan.close)} 件・重複 {len(plan.duplicates)} 件・"
        f"既にある {len(plan.ensure)} 件"
    )


StatusMode = Literal["always", "if-empty"]


def _put_on_board(
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
    priority: str,
    status_mode: StatusMode,
) -> None:
    """ボードへの追加と、Status・Priority の設定（何度やっても同じ結果になる）

    Status は ``always`` なら Ready にする（作った・reopen した直後）。``if-empty`` は
    ボード項目の Status が空のときだけ Ready にする。着手して Active にした Issue を
    次の実行が Ready に戻さず、途中で失敗して空のままの Issue は直る。
    """
    item_id, _ = add_issue_to_board(client, config, owner, repo, issue_number, None)
    if status_mode == "always" or not item_has_field_value(
        client, config, owner, repo, issue_number, item_id, "workflow"
    ):
        set_issue_field(client, config, item_id, "workflow", _BOARD_STATUS)
    set_issue_field(client, config, item_id, "priority", priority)


def _close_stale(
    client: GitHubClient, owner: str, repo: str, kind: AlertKind, number: int, issue_number: int
) -> bool:
    """alert を単体で確かめ、閉じている・無いときだけ Issue を閉じる。閉じたら True"""
    raw: dict[str, Any] | None
    try:
        if kind == "dependabot":
            raw = client.get_dependabot_alert(owner, repo, number)
        elif kind == "code-scanning":
            raw = client.get_code_scanning_alert(owner, repo, number)
        else:
            raw = client.get_secret_scanning_alert(owner, repo, number)
    except GitHubNotFoundError:
        raw = None
    reason = close_reason(kind, raw)
    if reason is None:
        typer.echo(f"飛ばす: {kind} #{number} は open のため Issue #{issue_number} を閉じません")
        return False
    # 閉じてから理由を付ける（閉じるのに失敗した実行がコメントだけ残すと、次の実行で重複する）
    client.close_issue(owner, repo, issue_number)
    client.add_issue_comment(owner, repo, issue_number, reason)
    typer.echo(f"閉じた: {kind} #{number}（Issue #{issue_number}）")
    return True


def _apply_plan(
    client: GitHubClient, config: ProjectConfig, owner: str, repo: str, plan: SyncPlan
) -> int:
    """計画を実行し、失敗した件数を返す。1 件の失敗で全体を止めない"""
    failures = 0
    host = config.host

    def run(label: str, action: Any) -> None:
        nonlocal failures
        try:
            action()
        except (GitHubAPIError, httpx.HTTPError) as e:
            failures += 1
            detail = e.message if isinstance(e, GitHubAPIError) else str(e)
            typer.echo(f"エラー: {label}: {detail}", err=True)

    for alert in plan.create:

        def create(alert: Alert = alert) -> None:
            issue = create_issue(
                client,
                owner,
                repo,
                build_issue_title(alert),
                build_issue_body(alert, host, owner, repo),
                [ALERT_LABEL],
            )
            typer.echo(f"作った: {alert.kind} #{alert.number}（Issue #{issue['number']}）")
            _put_on_board(client, config, owner, repo, issue["number"], alert.priority, "always")

        run(f"{alert.kind} #{alert.number} の Issue 作成", create)

    for alert, number in plan.reopen:

        def reopen(alert: Alert = alert, number: int = number) -> None:
            client.reopen_issue(owner, repo, number)
            typer.echo(f"reopen した: {alert.kind} #{alert.number}（Issue #{number}）")
            _put_on_board(client, config, owner, repo, number, alert.priority, "always")

        run(f"{alert.kind} #{alert.number} の reopen", reopen)

    for alert, number in plan.ensure:
        run(
            f"Issue #{number} のボード登録",
            lambda alert=alert, number=number: _put_on_board(
                client, config, owner, repo, number, alert.priority, "if-empty"
            ),
        )

    for kind, alert_number, issue_number in plan.close:

        def close(
            kind: AlertKind = kind,
            alert_number: int = alert_number,
            issue_number: int = issue_number,
        ) -> None:
            _close_stale(client, owner, repo, kind, alert_number, issue_number)

        run(f"{kind} #{alert_number} の Issue #{issue_number} を閉じる", close)

    for kind, alert_number, issue_number, keep in plan.duplicates:

        def close_duplicate(
            kind: AlertKind = kind,
            alert_number: int = alert_number,
            issue_number: int = issue_number,
            keep: int = keep,
        ) -> None:
            client.close_issue(owner, repo, issue_number, "not_planned")
            client.add_issue_comment(
                owner, repo, issue_number, f"同じ alert の Issue #{keep} と重複のため閉じます。"
            )
            typer.echo(f"閉じた: {kind} #{alert_number} の重複（Issue #{issue_number}）")

        run(f"{kind} #{alert_number} の重複 Issue #{issue_number} を閉じる", close_duplicate)
    return failures


def security_sync(ctx: typer.Context, dry_run: DryRunOption = False) -> None:
    """open の security alert を Issue にし、閉じた alert の Issue を閉じる

    対象: Dependabot・code scanning（main）・secret scanning の open の alert。
    alert ごとに、ラベル security-alert の Issue を作ってボードの Ready に載せる。
    対応する open の alert が無い Issue は、alert を確かめてから閉じる。
    一覧を取れなかった種類は作る・閉じるを飛ばし、最後に終了コード 1 で終わる。

    Examples:
        $ pecot security sync --dry-run
        $ pecot security sync
    """
    config, owner, repo = _load_target(ctx)
    client = GitHubClient(host=config.host)

    alerts, skipped, list_failed = _fetch_open_alerts(client, config.host, owner, repo)
    try:
        issues = client.list_issues_by_label(owner, repo, ALERT_LABEL)
    except (GitHubAPIError, httpx.HTTPError) as e:
        detail = e.message if isinstance(e, GitHubAPIError) else str(e)
        typer.echo(f"エラー: Issue の一覧を取得できません: {detail}", err=True)
        raise typer.Exit(1) from None

    plan = plan_sync(alerts, issues, skipped)
    _echo_plan(plan, dry_run)
    failures = 0 if dry_run else _apply_plan(client, config, owner, repo, plan)
    if list_failed or failures:
        raise typer.Exit(1)


def security_review_exceptions(ctx: typer.Context, dry_run: DryRunOption = False) -> None:
    """Dependabot の例外の見直しの Issue を作る

    作業ツリーの .github/dependabot-exceptions.json に例外が 1 件以上あり、
    見直しの Issue が open で無いときだけ作る。

    Examples:
        $ pecot security review-exceptions --dry-run
        $ pecot security review-exceptions
    """
    config, owner, repo = _load_target(ctx)
    git_root = git_toplevel(Path.cwd())
    if git_root is None:
        typer.echo("エラー: gitリポジトリのルートディレクトリが見つかりません", err=True)
        raise typer.Exit(1)
    try:
        exceptions = load_dependabot_exceptions(git_root)
    except DependabotAlertError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None
    if not exceptions:
        typer.echo("例外が無いため、見直しの Issue は作りません")
        return

    client = GitHubClient(host=config.host)
    try:
        issues = client.list_issues_by_label(owner, repo, ALERT_LABEL)
        existing = [
            i
            for i in issues
            if i.get("state") == "open" and REVIEW_MARKER in cast("str", i.get("body") or "")
        ]
        if existing:
            number = existing[0]["number"]
            typer.echo(f"見直しの Issue #{number} が open のため、作りません")
            if not dry_run:
                # 作った後にボードの登録が失敗した実行を、次の実行で直す
                _put_on_board(client, config, owner, repo, number, "medium", "if-empty")
            return
        if dry_run:
            typer.echo(f"[dry-run] 作る: 例外の見直し（例外 {len(exceptions)} 件）")
            return
        issue = create_issue(
            client,
            owner,
            repo,
            REVIEW_TITLE,
            build_review_body(exceptions, config.host, owner, repo),
            [ALERT_LABEL],
        )
        typer.echo(f"作った: 例外の見直し（Issue #{issue['number']}）")
        _put_on_board(client, config, owner, repo, issue["number"], "medium", "always")
    except (GitHubAPIError, httpx.HTTPError) as e:
        detail = e.message if isinstance(e, GitHubAPIError) else str(e)
        typer.echo(f"エラー: {detail}", err=True)
        raise typer.Exit(1) from None
