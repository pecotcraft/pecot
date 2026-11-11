"""cli/security.py - command that puts security alerts into a board Tracker

``pecot security sync`` rewrites the list in the body of one open Tracker to the current state of the alerts.
A Tracker is created only when none is open and there are alerts to list.
A human closes the Tracker and moves it to Archived.
The same command runs from the Actions schedule and by hand.
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
    make_client,
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
    """Fetch the open alerts of the three kinds

    Returns:
        (alerts per kind, kinds whose list could not be fetched, kinds whose feature is disabled).
        Rows of either kind are left alone and nothing is added. Only the kinds that could not be fetched count toward exit code 1.
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
    """Operations on the Tracker, grouped by execution stage"""

    create: list[Operation]
    rewrite: list[Operation]

    def all(self) -> list[Operation]:
        return [*self.create, *self.rewrite]


def _operations(plan: TrackerPlan, tracker: int | None, title: str, unchanged: bool) -> _Stages:
    """Turn the operations on the Tracker into Operations per stage"""
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
    """Rewrite the open Tracker's list of open security alerts

    Targets: open alerts from Dependabot, code scanning (main), and secret scanning.
    Finds one open Tracker labeled security-alert (an Issue whose body has the markers).
    Rewrites the table between list-begin and list-end in its body with the rows of open alerts.
    Only when no Tracker is open and there are rows to list, creates a Tracker and puts it on the board in Backlog.
    A human closes the Tracker and moves it to Archived.
    Kinds whose list could not be fetched are left alone, and the command ends with exit code 1.

    Examples:
        $ pecot security sync --dry-run
        $ pecot security sync
    """
    out = Output(dry_run)
    config, owner, repo = load_target(ctx, out)
    client = make_client(out, config)

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
    """Create and rewrite the Tracker and put it on the board. Return the number of failures"""
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
