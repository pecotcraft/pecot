"""cli/security.py - security alert をボードの Tracker に載せるコマンド

``pecot security sync`` は open の Tracker 1 件の本文の一覧を、alert の今の状態で書き直す。
Tracker は、open のものが無く、表に載せる alert があるときだけ立てる。
閉じる操作と Archived へ移す操作は人が行う。
Actions の schedule と手元の両方から同じコマンドで動かす。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

import httpx
import typer

from cli.commands.release import resolve_release_target_repo
from cli.core.config import ProjectConfig, load_active_config
from cli.core.dependabot import (
    DependabotAlertError,
    DependabotException,
    load_dependabot_exceptions,
)
from cli.core.git import git_toplevel
from cli.core.github import GitHubAPIError, GitHubClient
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
    Alert,
    AlertKind,
    SecurityAlertError,
    TrackerPlan,
    build_tracker_title,
    find_tracker,
    list_open_alerts,
    max_priority,
    normalize_alerts,
    parse_tracker_entries,
    plan_tracker,
    render_tracker_body,
)

DryRunOption = Annotated[
    bool,
    typer.Option(
        "--dry-run", help="Tracker を立てる・書き直す予定を表示するだけで、何も変更しない"
    ),
]

_BOARD_STATUS = "backlog"


def _load_target(ctx: typer.Context) -> tuple[ProjectConfig, str, str]:
    """対象リポ（git の origin、--repo 優先）とアクティブなプロジェクトを解決する"""
    owner, repo = resolve_release_target_repo(ctx, Path.cwd())
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)
    return config, owner, repo


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


def _put_on_board(
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
    priority: str | None,
    *,
    only_if_empty: bool,
) -> None:
    """ボードへの追加と、Status（Backlog）・Priority の設定（何度やっても同じ結果になる）

    ``only_if_empty`` なら、ボード項目のそのフィールドが空のときだけ入れる。
    人が動かした Status や Priority を、次の実行が戻さない。
    途中で失敗して空のままの項目は直る。
    """
    item_id, _ = add_issue_to_board(client, config, owner, repo, issue_number, None)
    fields = [("workflow", _BOARD_STATUS)]
    if priority is not None:
        fields.append(("priority", priority))
    for field_name, option in fields:
        if only_if_empty and item_has_field_value(
            client, config, owner, repo, issue_number, item_id, field_name
        ):
            continue
        set_issue_field(client, config, item_id, field_name, option)


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
    config, owner, repo = _load_target(ctx)
    exceptions = _load_exceptions()
    client = GitHubClient(host=config.host)

    alerts, failed, disabled = _fetch_open_alerts(client, config.host, owner, repo)
    try:
        issues = client.list_issues_by_label(owner, repo, ALERT_LABEL)
    except (GitHubAPIError, httpx.HTTPError) as e:
        detail = e.message if isinstance(e, GitHubAPIError) else str(e)
        typer.echo(f"エラー: Issue の一覧を取得できません: {detail}", err=True)
        raise typer.Exit(1) from None

    tracker, others = find_tracker(issues)
    if others:
        listed = "・".join(f"#{n}" for n in others)
        used = f"#{tracker['number']}" if tracker else "なし"
        typer.echo(
            f"警告: open の Tracker が複数あります。番号が最小の {used}"
            f" を使い、ほか（{listed}）は閉じません",
            err=True,
        )
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
            _put_on_board(
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
                detail = e.message if isinstance(e, GitHubAPIError) else str(e)
                typer.echo(f"エラー: Tracker #{number} の本文を書き直せません: {detail}", err=True)
        # 作った後にボード登録が失敗した実行を直す。Status・Priority は空のときだけ入れる
        _put_on_board(client, config, owner, repo, number, priority, only_if_empty=True)
        return failures
    except (GitHubAPIError, httpx.HTTPError) as e:
        detail = e.message if isinstance(e, GitHubAPIError) else str(e)
        typer.echo(f"エラー: Tracker: {detail}", err=True)
        return 1
