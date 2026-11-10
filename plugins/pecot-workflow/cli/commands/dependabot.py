"""cli/dependabot.py - 人の判断を待つ dependabot の PR をボードの Tracker に載せるコマンド

``pecot dependabot sync`` は open の Tracker 1 件の本文の一覧を、待つ PR の今の状態で書き直す。
Tracker は、open のものが無く、載せる PR があるときだけ立てる。
載せる PR が無くなれば、Tracker を閉じる（security alert の Tracker とは別で、閉じる操作もこのコマンドが行う）。
Actions の schedule と手元の両方から同じコマンドで動かす。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, NamedTuple

import httpx
import typer

from cli.commands._output import Operation, Output, Verb
from cli.commands._tracker_sync import (
    DryRunOption,
    api_error_detail,
    load_target,
    warn_extra_trackers,
)
from cli.core.config import ProjectConfig
from cli.core.dependabot_prs import (
    PR_LABEL,
    PRIORITY,
    TRACKER_RE,
    DependabotPrError,
    PrEntry,
    PrPlan,
    build_tracker_title,
    checks_label,
    parse_tracker_pr_numbers,
    plan_tracker,
    render_tracker_body,
    rollup_state,
    waiting_reasons,
)
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.issue_board import create_issue, put_on_board
from cli.core.tracker_body import find_tracker


def _entries(waiting: list[tuple[dict[str, Any], list[str]]]) -> list[PrEntry]:
    """待つ PR（PR と理由の組）を表の行にする"""
    return [
        PrEntry(
            number=int(pr["number"]),
            title=str(pr.get("title") or ""),
            url=str(pr.get("url") or ""),
            reasons=tuple(reasons),
            checks=checks_label(rollup_state(pr)),
        )
        for pr, reasons in waiting
    ]


class _Stages(NamedTuple):
    """Tracker に対する事柄を、実行の段ごとに分けた Operation の並び"""

    create: list[Operation]
    rewrite: list[Operation]
    close: list[Operation]

    def all(self) -> list[Operation]:
        return [*self.create, *self.rewrite, *self.close]


def _operations(plan: PrPlan, tracker: int | None, title: str, unchanged: bool) -> _Stages:
    """Tracker に対する事柄を段ごとの Operation にする"""
    if tracker is None:
        if not plan.create:
            return _Stages([Operation(Verb.SKIP, "Tracker creation")], [], [])
        created = [Operation(Verb.CREATE, f'Tracker "{title}"')]
        created += [
            Operation(Verb.ADD, f"PR #{e.number} to new Tracker ({', '.join(e.reasons)})")
            for e in plan.entries
        ]
        return _Stages(created, [], [])
    if unchanged and not plan.close:
        return _Stages([], [Operation(Verb.UNCHANGED, f"Tracker #{tracker}")], [])
    rewrite = [
        Operation(Verb.ADD, f"PR #{e.number} to Tracker #{tracker} ({', '.join(e.reasons)})")
        for e in plan.added
    ]
    rewrite += [Operation(Verb.REMOVE, f"PR #{n} from Tracker #{tracker}") for n in plan.removed]
    if not rewrite and not unchanged:
        rewrite = [Operation(Verb.UPDATE, f"Tracker #{tracker} body")]
    close = [Operation(Verb.CLOSE, f"Tracker #{tracker}")] if plan.close else []
    return _Stages([], rewrite, close)


def dependabot_sync(ctx: typer.Context, dry_run: DryRunOption = False) -> None:
    """人の判断を待つ dependabot の PR を、open の Tracker の一覧に書き直す

    対象は open の dependabot の PR で、次のどちらかに当たるもの。理由の無い PR は載せない。

    - 自動マージの対象外（major・playwright・update-type 不明）
    - 自動マージの対象で、検証・競合・queue の状態が止まっている

    ラベル dependabot-pr の open の Tracker（本文に印がある Issue）を 1 件探し、
    その本文の list-begin から list-end の間の表を書き直す。
    open の Tracker が無く、載せる PR があるときだけ、Tracker を立ててボードの Backlog（Priority medium）に載せる。
    載せる PR が無くなれば、一覧を `none` にして Tracker を閉じる。
    PR の一覧を取れなければ、本文に触らず終了コード 1 で終わる。
    open の Tracker が複数あれば、番号が最小のものを使い、ほかは閉じずに警告する。
    使う Tracker の list-begin / list-end の印が 1 組でなければ、終了コード 1 で止まる。
    ほかの Tracker があっても使わない。security sync と同じで、印は人が直す。

    Examples:
        $ pecot dependabot sync --dry-run
        $ pecot dependabot sync
    """
    out = Output(dry_run)
    config, owner, repo = load_target(ctx, out)
    client = GitHubClient(host=config.host)

    try:
        prs = client.list_open_dependabot_pull_requests(owner, repo)
        issues = client.list_issues_by_label(owner, repo, PR_LABEL)
    except (GitHubAPIError, httpx.HTTPError) as e:
        out.error(f"could not list pull requests or issues: {api_error_detail(e)}")
        raise typer.Exit(1) from None

    tracker, others = find_tracker(issues, TRACKER_RE)
    warn_extra_trackers(out, tracker, others)
    existing_body = (tracker.get("body") or "") if tracker else None
    try:
        old_numbers = parse_tracker_pr_numbers(existing_body) if tracker else None
    except DependabotPrError as e:
        label = f"Tracker #{tracker['number']}" if tracker else "Tracker"
        out.error(f"{label}: {e}")
        raise typer.Exit(1) from None

    now = datetime.now(timezone.utc)
    waiting = [(pr, reasons) for pr in prs if (reasons := waiting_reasons(pr, now))]
    no_rollup = sum(1 for pr, _ in waiting if rollup_state(pr) is None)
    out.count("open dependabot PRs", len(prs))
    out.count("PRs awaiting a decision", len(waiting))
    out.count("PRs awaiting a decision without check results", no_rollup)
    plan = plan_tracker(_entries(waiting), old_numbers)
    title = build_tracker_title(now.date())
    body = render_tracker_body(plan.entries, existing_body)
    number = int(tracker["number"]) if tracker else None
    unchanged = number is not None and body == (existing_body or "").replace("\r\n", "\n")
    stages = _operations(plan, number, title, unchanged)
    for op in stages.all():
        out.planned(op)

    if dry_run:
        return
    if _apply(out, client, config, owner, repo, plan, title, body, stages, number, unchanged):
        raise typer.Exit(1)


def _apply(
    out: Output,
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    plan: PrPlan,
    title: str,
    body: str,
    stages: _Stages,
    number: int | None,
    unchanged: bool,
) -> int:
    """Tracker を立てる・書き直す・閉じる・ボードへ載せる。失敗した件数を返す"""
    try:
        if number is None:
            if not plan.create:
                for op in stages.create:
                    out.done(op)
                return 0
            issue = create_issue(client, owner, repo, title, body, [PR_LABEL])
            for op in stages.create:
                out.done(op)
            put_on_board(
                client, config, owner, repo, issue["number"], PRIORITY, only_if_empty=False
            )
            return 0
        if not unchanged:
            try:
                client.update_issue_body(owner, repo, number, body)
            except (GitHubAPIError, httpx.HTTPError) as e:
                # 本文が書き直されていないので、閉じずに次の実行でやり直す
                out.error(f"could not update Tracker #{number} body: {api_error_detail(e)}")
                return 1
        for op in stages.rewrite:
            out.done(op)
        if stages.close:
            try:
                client.close_issue(owner, repo, number, state_reason="completed")
            except (GitHubAPIError, httpx.HTTPError) as e:
                out.error(
                    f"could not close Tracker #{number} after setting its list to none;"
                    f" will retry on the next run: {api_error_detail(e)}"
                )
                return 1
            out.done(stages.close[0])
            return 0
        # 作った後にボード登録が失敗した実行を直す。Status・Priority は空のときだけ入れる
        put_on_board(client, config, owner, repo, number, PRIORITY, only_if_empty=True)
        return 0
    except (GitHubAPIError, httpx.HTTPError) as e:
        out.error(f"Tracker: {api_error_detail(e)}")
        return 1
