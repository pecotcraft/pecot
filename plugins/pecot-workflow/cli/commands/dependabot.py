"""cli/dependabot.py - 人の判断を待つ dependabot の PR をボードの Tracker に載せるコマンド

``pecot dependabot sync`` は open の Tracker 1 件の本文の一覧を、待つ PR の今の状態で書き直す。
Tracker は、open のものが無く、載せる PR があるときだけ立てる。
載せる PR が無くなれば、Tracker を閉じる（security alert の Tracker とは別で、閉じる操作もこのコマンドが行う）。
Actions の schedule と手元の両方から同じコマンドで動かす。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any

import httpx
import typer

from cli.commands.release import load_target
from cli.core.config import ProjectConfig
from cli.core.dependabot_prs import (
    PR_LABEL,
    PRIORITY,
    TRACKER_RE,
    DependabotPrError,
    TrackerEntry,
    TrackerPlan,
    build_tracker_title,
    first_node,
    parse_tracker_entries,
    plan_tracker,
    render_tracker_body,
    waiting_reasons,
)
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.github.auth import as_dict
from cli.core.issue_board import create_issue, put_on_board
from cli.core.tracker_body import find_tracker

DryRunOption = Annotated[
    bool,
    typer.Option(
        "--dry-run", help="Tracker を立てる・書き直す・閉じる予定を表示するだけで、何も変更しない"
    ),
]


def _detail(e: GitHubAPIError | httpx.HTTPError) -> str:
    return e.message if isinstance(e, GitHubAPIError) else str(e)


def _entries(prs: list[dict[str, Any]], now: datetime) -> list[TrackerEntry]:
    """待つ PR だけを行にする。rollup が null の PR の件数をログに出す"""
    entries: list[TrackerEntry] = []
    no_rollup = 0
    for pr in prs:
        commit = as_dict(as_dict(first_node(pr.get("headCommits"))).get("commit"))
        if commit.get("statusCheckRollup") is None:
            no_rollup += 1
        reasons = waiting_reasons(pr, now)
        if reasons:
            entries.append(
                TrackerEntry(
                    number=int(pr["number"]),
                    title=str(pr.get("title") or ""),
                    url=str(pr.get("url") or ""),
                    reasons=tuple(reasons),
                )
            )
    typer.echo(f"open の dependabot の PR: {len(prs)} 件（検証の結果が null: {no_rollup} 件）")
    return entries


def _echo_plan(plan: TrackerPlan, tracker: int | None, title: str, dry_run: bool) -> None:
    prefix = "[dry-run] " if dry_run else ""
    if tracker is None:
        if not plan.create:
            typer.echo(f"{prefix}Tracker を立てません（人の判断を待つ PR がありません）")
            return
        typer.echo(f"{prefix}Tracker を立てる: {title}（{len(plan.entries)} 件）")
        for e in plan.entries:
            typer.echo(f"{prefix}Tracker に載せる: PR #{e.number}（{'・'.join(e.reasons)}）")
        return
    for e in plan.added:
        typer.echo(f"{prefix}Tracker #{tracker} に足す: PR #{e.number}（{'・'.join(e.reasons)}）")
    for n in plan.removed:
        typer.echo(f"{prefix}Tracker #{tracker} から外す: PR #{n}")


def dependabot_sync(ctx: typer.Context, dry_run: DryRunOption = False) -> None:
    """人の判断を待つ dependabot の PR を、open の Tracker の一覧に書き直す

    対象は open の dependabot の PR で、次のどちらかに当たるもの。理由の無い PR は載せない。

    - 自動マージの対象外（major・playwright・update-type 不明）
    - 自動マージの対象で、検証・競合・queue の状態が止まっている

    ラベル dependabot-pr の open の Tracker（本文に印がある Issue）を 1 件探し、
    その本文の list-begin から list-end の間の表を書き直す。
    open の Tracker が無く、載せる PR があるときだけ、Tracker を立ててボードの Backlog（Priority medium）に載せる。
    載せる PR が無くなれば、表を空にして Tracker を閉じる。
    PR の一覧を取れなければ、本文に触らず終了コード 1 で終わる。

    Examples:
        $ pecot dependabot sync --dry-run
        $ pecot dependabot sync
    """
    config, owner, repo = load_target(ctx)
    client = GitHubClient(host=config.host)

    try:
        prs = client.list_open_dependabot_pull_requests(owner, repo)
        issues = client.list_issues_by_label(owner, repo, PR_LABEL)
    except (GitHubAPIError, httpx.HTTPError) as e:
        typer.echo(f"エラー: PR または Issue の一覧を取得できません: {_detail(e)}", err=True)
        raise typer.Exit(1) from None

    tracker, others = find_tracker(issues, TRACKER_RE)
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
        old_numbers = parse_tracker_entries(existing_body) if tracker else None
    except DependabotPrError as e:
        label = f"Tracker #{tracker['number']}" if tracker else "Tracker"
        typer.echo(f"エラー: {label}: {e}", err=True)
        raise typer.Exit(1) from None

    now = datetime.now(timezone.utc)
    plan = plan_tracker(_entries(prs, now), old_numbers)
    title = build_tracker_title(now.date())
    body = render_tracker_body(plan.entries, existing_body)
    number = int(tracker["number"]) if tracker else None
    unchanged = number is not None and body == (existing_body or "").replace("\r\n", "\n")
    prefix = "[dry-run] " if dry_run else ""
    if number is not None and unchanged and not plan.close:
        typer.echo(f"{prefix}Tracker #{number} は変わらない")
    else:
        _echo_plan(plan, number, title, dry_run)
        if number is not None and not (plan.added or plan.removed or plan.close):
            typer.echo(f"{prefix}Tracker #{number} の本文を書き直す")
        if number is not None and plan.close and dry_run:
            typer.echo(f"[dry-run] Tracker #{number} を閉じる")

    if dry_run:
        return
    if _apply(client, config, owner, repo, plan, number, title, body, unchanged):
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
    """Tracker を立てる・書き直す・閉じる・ボードへ載せる。失敗した件数を返す"""
    try:
        if number is None:
            if not plan.create:
                return 0
            issue = create_issue(client, owner, repo, title, body, [PR_LABEL])
            typer.echo(f"立てた: Tracker #{issue['number']}")
            put_on_board(
                client, config, owner, repo, issue["number"], PRIORITY, only_if_empty=False
            )
            return 0
        if not unchanged:
            try:
                client.update_issue_body(owner, repo, number, body)
                typer.echo(f"書き直した: Tracker #{number}")
            except (GitHubAPIError, httpx.HTTPError) as e:
                # 本文が書き直されていないので、閉じずに次の実行でやり直す
                typer.echo(
                    f"エラー: Tracker #{number} の本文を書き直せません: {_detail(e)}", err=True
                )
                return 1
        if plan.close:
            client.close_issue(owner, repo, number, state_reason="completed")
            typer.echo(f"閉じた: Tracker #{number}")
            return 0
        # 作った後にボード登録が失敗した実行を直す。Status・Priority は空のときだけ入れる
        put_on_board(client, config, owner, repo, number, PRIORITY, only_if_empty=True)
        return 0
    except (GitHubAPIError, httpx.HTTPError) as e:
        typer.echo(f"エラー: Tracker: {_detail(e)}", err=True)
        return 1
