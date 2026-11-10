"""cli/security.py - security alert をボードの Tracker に載せるコマンド

``pecot security sync`` は open の Tracker 1 件の本文の一覧を、alert の今の状態で書き直す。
Tracker は、open のものが無く、表に載せる alert があるときだけ立てる。
閉じる操作と Archived へ移す操作は人が行う。
Actions の schedule と手元の両方から同じコマンドで動かす。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import NamedTuple

import httpx
import typer

from cli.commands._output import Operation, Output, Verb
from cli.commands._tracker_sync import (
    DryRunOption,
    api_error_detail,
    load_target,
    settle,
    warn_extra_trackers,
)
from cli.core.config import ProjectConfig
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


def _fetch_open_alerts(
    out: Output, client: GitHubClient, host: str, owner: str, repo: str
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
            out.error(
                f"could not list {KIND_LABELS[kind]} alerts (leaving its rows untouched): {e}"
            )
            continue
        if raws is None:
            disabled.add(kind)
            settle(out, Operation(Verb.SKIP, f"{KIND_LABELS[kind]} alerts (feature disabled)"))
            continue
        found[kind] = normalize_alerts(kind, raws, host, owner, repo)
    return found, failed, disabled


class _Stages(NamedTuple):
    """Tracker に対する事柄を、実行の段ごとに分けた Operation の並び"""

    create: list[Operation]
    rewrite: list[Operation]

    def all(self) -> list[Operation]:
        return [*self.create, *self.rewrite]


def _operations(plan: TrackerPlan, tracker: int | None, title: str, unchanged: bool) -> _Stages:
    """Tracker に対する事柄を段ごとの Operation にする"""
    if tracker is None:
        if not plan.create:
            return _Stages([Operation(Verb.SKIP, "Tracker creation")], [])
        created = [
            Operation(
                Verb.CREATE,
                f'Tracker "{title}" with priority {max_priority(plan.entries)}',
            )
        ]
        created += [
            Operation(Verb.ADD, f"{e.kind} #{e.number} to new Tracker") for e in plan.entries
        ]
        return _Stages(created, [])
    if unchanged:
        return _Stages([], [Operation(Verb.UNCHANGED, f"Tracker #{tracker}")])
    rewrite = [
        Operation(Verb.ADD, f"{e.kind} #{e.number} to Tracker #{tracker}") for e in plan.added
    ]
    rewrite += [
        Operation(Verb.REMOVE, f"{e.kind} #{e.number} from Tracker #{tracker}")
        for e in plan.removed
    ]
    if not rewrite:
        rewrite = [Operation(Verb.UPDATE, f"Tracker #{tracker} body")]
    return _Stages([], rewrite)


def security_sync(ctx: typer.Context, dry_run: DryRunOption = False) -> None:
    """open の security alert を、open の Tracker の一覧に書き直す

    対象: Dependabot・code scanning（main）・secret scanning の open の alert。
    ラベル security-alert の open の Tracker（本文に印がある Issue）を 1 件探す。
    その本文の list-begin から list-end の間の表を、open の alert の行で書き直す。
    open の Tracker が無く、表に載せる行があるときだけ、Tracker を立ててボードの Backlog に載せる。
    閉じる操作と Archived へ移す操作は人が行う。
    一覧を取れなかった種類は行に触れず、最後に終了コード 1 で終わる。

    Examples:
        $ pecot security sync --dry-run
        $ pecot security sync
    """
    out = Output(dry_run)
    config, owner, repo = load_target(ctx, out)
    client = GitHubClient(host=config.host)

    alerts, failed, disabled = _fetch_open_alerts(out, client, config.host, owner, repo)
    try:
        issues = client.list_issues_by_label(owner, repo, ALERT_LABEL)
    except (GitHubAPIError, httpx.HTTPError) as e:
        out.error(f"could not list issues: {api_error_detail(e)}")
        raise typer.Exit(1) from None

    tracker, others = find_tracker(issues, TRACKER_RE)
    warn_extra_trackers(out, tracker, others)
    existing_body = (tracker.get("body") or "") if tracker else None
    try:
        entries = parse_tracker_entries(existing_body) if tracker else None
    except SecurityAlertError as e:
        label = f"Tracker #{tracker['number']}" if tracker else "Tracker"
        out.error(f"{label}: {e}")
        raise typer.Exit(1) from None

    plan = plan_tracker(alerts, entries, failed, disabled)

    today = datetime.now(timezone.utc).date()
    title = build_tracker_title(today)
    body = render_tracker_body(
        plan.entries, config.host, owner, repo, existing_body, disabled, failed
    )
    number = int(tracker["number"]) if tracker else None
    unchanged = number is not None and body == (existing_body or "").replace("\r\n", "\n")
    stages = _operations(plan, number, title, unchanged)
    for op in stages.all():
        out.planned(op)

    failures = (
        0
        if dry_run
        else _apply(out, client, config, owner, repo, plan, title, body, stages, number, unchanged)
    )
    if failed or failures:
        raise typer.Exit(1)


def _apply(
    out: Output,
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    plan: TrackerPlan,
    title: str,
    body: str,
    stages: _Stages,
    number: int | None,
    unchanged: bool,
) -> int:
    """Tracker を立てる・書き直す・ボードへ載せる。失敗した件数を返す"""
    priority = max_priority(plan.entries)
    try:
        if number is None:
            if not plan.create:
                for op in stages.create:
                    out.done(op)
                return 0
            issue = create_issue(client, owner, repo, title, body, [ALERT_LABEL])
            for op in stages.create:
                out.done(op)
            put_on_board(
                client, config, owner, repo, issue["number"], priority, only_if_empty=False
            )
            return 0
        failures = 0
        updated = True
        if not unchanged:
            try:
                client.update_issue_body(owner, repo, number, body)
            except (GitHubAPIError, httpx.HTTPError) as e:
                # 422 を含む。本文は書き直されていないので、次の実行でやり直す
                failures += 1
                updated = False
                out.error(f"could not update Tracker #{number} body: {api_error_detail(e)}")
        if updated:
            for op in stages.rewrite:
                out.done(op)
        # 作った後にボード登録が失敗した実行を直す。Status・Priority は空のときだけ入れる
        put_on_board(client, config, owner, repo, number, priority, only_if_empty=True)
        return failures
    except (GitHubAPIError, httpx.HTTPError) as e:
        out.error(f"Tracker: {api_error_detail(e)}")
        return 1
