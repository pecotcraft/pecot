"""cli/security.py - security alert をボードの Tracker に載せるコマンド

``pecot security sync`` は open の Tracker 1 件の本文の一覧を、alert の今の状態で書き直す。
Tracker は、open のものが無く、表に載せる alert があるときだけ立てる。
閉じる操作と Archived へ移す操作は人が行う。
Actions の schedule と手元の両方から同じコマンドで動かす。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import httpx
import typer

from cli.commands._tracker_sync import (
    DryRunOption,
    api_error_detail,
    load_target,
    warn_extra_trackers,
)
from cli.core.config import ProjectConfig
from cli.core.dependabot import (
    DependabotAlertError,
    DependabotException,
    load_dependabot_exceptions,
)
from cli.core.git import git_toplevel
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.issue_board import create_issue, put_on_board
from cli.core.security_alerts import (
    ALERT_KINDS,
    ALERT_LABEL,
    KIND_LABELS,
    TRACKER_RE,
    Alert,
    AlertKind,
    SecurityAlertError,
    TrackerPlan,
    build_tracker_title,
    list_open_alerts,
    max_priority,
    normalize_alerts,
    parse_tracker_entries,
    plan_tracker,
    render_tracker_body,
)
from cli.core.tracker_body import find_tracker


def _load_exceptions() -> list[DependabotException]:
    """cwd のリポの例外ファイルを読む。ファイルが無ければ空"""
    git_root = git_toplevel(Path.cwd())
    if git_root is None:
        typer.echo("エラー: gitリポジトリのルートディレクトリが見つかりません", err=True)
        raise typer.Exit(1)
    try:
        return load_dependabot_exceptions(git_root) or []
    except DependabotAlertError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None


def _fetch_open_alerts(
    client: GitHubClient, host: str, owner: str, repo: str
) -> tuple[dict[AlertKind, list[Alert]], set[AlertKind], set[AlertKind]]:
    """3 種の open の alert を取る

    Returns:
        (種類ごとの alert, 一覧を取れなかった種類, 機能が無効の種類)。
        どちらの種類も行に触れず、足さない。取れなかった種類だけが終了コード 1 に数えられる。
    """
    found: dict[AlertKind, list[Alert]] = {}
    failed: set[AlertKind] = set()
    disabled: set[AlertKind] = set()
    for kind in ALERT_KINDS:
        try:
            raws = list_open_alerts(client, kind, owner, repo)
        except SecurityAlertError as e:
            failed.add(kind)
            typer.echo(
                f"エラー: {KIND_LABELS[kind]} の一覧を取得できません（その種類の行に触れません）: {e}",
                err=True,
            )
            continue
        if raws is None:
            disabled.add(kind)
            typer.echo(f"{KIND_LABELS[kind]}: 無効のため飛ばします")
            continue
        found[kind] = normalize_alerts(kind, raws, host, owner, repo)
    return found, failed, disabled


def _echo_plan(plan: TrackerPlan, tracker: int | None, title: str, dry_run: bool) -> None:
    prefix = "[dry-run] " if dry_run else ""
    if tracker is None:
        if not plan.create:
            typer.echo(f"{prefix}Tracker を立てません（open で例外に無い alert がありません）")
            return
        typer.echo(
            f"{prefix}Tracker を立てる: {title}"
            f"（{len(plan.entries)} 件・Priority: {max_priority(plan.entries)}）"
        )
        for e in plan.entries:
            typer.echo(f"{prefix}Tracker に載せる: {e.kind} #{e.number}")
        return
    for e in plan.added:
        typer.echo(f"{prefix}Tracker #{tracker} に足す: {e.kind} #{e.number}")
    for e in plan.removed:
        typer.echo(f"{prefix}Tracker #{tracker} から外す: {e.kind} #{e.number}")


def security_sync(ctx: typer.Context, dry_run: DryRunOption = False) -> None:
    """open の security alert を、open の Tracker の一覧に書き直す

    対象: Dependabot・code scanning（main）・secret scanning の open の alert。
    ラベル security-alert の open の Tracker（本文に印がある Issue）を 1 件探す。
    その本文の list-begin から list-end の間の表を、open の alert から例外を引いた行で書き直す。
    open の Tracker が無く、表に載せる行があるときだけ、Tracker を立ててボードの Backlog に載せる。
    例外は、cwd のリポの .github/dependabot-exceptions.json から読む（載る alert は表に載せない）。
    閉じる操作と Archived へ移す操作は人が行う。
    一覧を取れなかった種類は行に触れず、最後に終了コード 1 で終わる。

    Examples:
        $ pecot security sync --dry-run
        $ pecot security sync
    """
    config, owner, repo = load_target(ctx)
    exceptions = _load_exceptions()
    client = GitHubClient(host=config.host)

    alerts, failed, disabled = _fetch_open_alerts(client, config.host, owner, repo)
    try:
        issues = client.list_issues_by_label(owner, repo, ALERT_LABEL)
    except (GitHubAPIError, httpx.HTTPError) as e:
        typer.echo(f"エラー: Issue の一覧を取得できません: {api_error_detail(e)}", err=True)
        raise typer.Exit(1) from None

    tracker, others = find_tracker(issues, TRACKER_RE)
    warn_extra_trackers(tracker, others)
    existing_body = (tracker.get("body") or "") if tracker else None
    try:
        entries = parse_tracker_entries(existing_body) if tracker else None
    except SecurityAlertError as e:
        label = f"Tracker #{tracker['number']}" if tracker else "Tracker"
        typer.echo(f"エラー: {label}: {e}", err=True)
        raise typer.Exit(1) from None

    plan = plan_tracker(alerts, exceptions, entries, failed, disabled)

    today = datetime.now(timezone.utc).date()
    title = build_tracker_title(today)
    body = render_tracker_body(
        plan.entries, config.host, owner, repo, existing_body, disabled, failed
    )
    number = int(tracker["number"]) if tracker else None
    unchanged = number is not None and body == (existing_body or "").replace("\r\n", "\n")
    if number is not None and unchanged:
        typer.echo(f"{'[dry-run] ' if dry_run else ''}Tracker #{number} は変わらない")
    else:
        _echo_plan(plan, number, title, dry_run)
        if number is not None and not (plan.added or plan.removed):
            typer.echo(f"{'[dry-run] ' if dry_run else ''}Tracker #{number} の本文を書き直す")

    failures = (
        0 if dry_run else _apply(client, config, owner, repo, plan, number, title, body, unchanged)
    )
    if failed or failures:
        raise typer.Exit(1)


def _apply(
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    plan: TrackerPlan,
    number: int | None,
    title: str,
    body: str,
    unchanged: bool,
) -> int:
    """Tracker を立てる・書き直す・ボードへ載せる。失敗した件数を返す"""
    priority = max_priority(plan.entries)
    try:
        if number is None:
            if not plan.create:
                return 0
            issue = create_issue(client, owner, repo, title, body, [ALERT_LABEL])
            typer.echo(f"立てた: Tracker #{issue['number']}")
            put_on_board(
                client, config, owner, repo, issue["number"], priority, only_if_empty=False
            )
            return 0
        failures = 0
        if not unchanged:
            try:
                client.update_issue_body(owner, repo, number, body)
                typer.echo(f"書き直した: Tracker #{number}")
            except (GitHubAPIError, httpx.HTTPError) as e:
                # 422 を含む。本文は書き直されていないので、次の実行でやり直す
                failures += 1
                typer.echo(
                    f"エラー: Tracker #{number} の本文を書き直せません: {api_error_detail(e)}",
                    err=True,
                )
        # 作った後にボード登録が失敗した実行を直す。Status・Priority は空のときだけ入れる
        put_on_board(client, config, owner, repo, number, priority, only_if_empty=True)
        return failures
    except (GitHubAPIError, httpx.HTTPError) as e:
        typer.echo(f"エラー: Tracker: {api_error_detail(e)}", err=True)
        return 1
