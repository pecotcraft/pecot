"""cli/session.py - session management commands

Shows the flag state, branch information, and the inferred Issue.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

import typer

from cli.commands._output import Output
from cli.commands._work_target import record_work_target
from cli.commands.options import DirectoryOption
from cli.commands.pr import extract_issue_number_from_branch
from cli.core.config import load_active_config
from cli.core.errors import PecotError
from cli.core.git import git_current_branch, origin_repo
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.ref_parser import RefParseError, parse_issue_ref
from cli.core.state import FLAG_PECOT_ACTIVE, flag_exists, read_flag

_OUT = Output(dry_run=False)

# データクラス


@dataclass
class FlagStatus:
    """State of a flag"""

    name: str
    exists: bool
    content: str


# ユーティリティ関数


ALL_FLAGS = [
    FLAG_PECOT_ACTIVE,
]


def _collect_flag_statuses() -> list[FlagStatus]:
    """Collect whether each flag exists and what it contains

    Returns:
        List of FlagStatus
    """
    statuses: list[FlagStatus] = []
    for flag_name in ALL_FLAGS:
        exists = flag_exists(flag_name)
        content = ""
        if exists:
            raw = read_flag(flag_name)
            content = raw if raw else ""
        statuses.append(FlagStatus(name=flag_name, exists=exists, content=content))
    return statuses


# CLIコマンド


def flag_status(
    directory: DirectoryOption = ...,  # type: ignore[assignment]
) -> None:
    """Show the session flag state, branch information, and inferred Issue

    This is a diagnostic tool, so it shows ``unknown`` / ``none`` instead of failing when a value cannot be read.
    """
    # 1. ブランチ情報取得
    branch = git_current_branch(directory)
    branch_display = branch if branch else "unknown"

    # 2. リポジトリ情報取得
    origin = origin_repo(directory)
    repo_display = f"{origin[1]}/{origin[2]}" if origin else "unknown"

    # 3. Issue番号推定
    issue_display = "none"
    if branch:
        issue_number = extract_issue_number_from_branch(branch)
        if issue_number is not None:
            issue_display = f"#{issue_number}"

    # 4. フラグ状態収集
    flag_statuses = _collect_flag_statuses()

    # 5. 出力
    lines = [
        "# Session status",
        "",
        f"- Branch: {branch_display}",
        f"- Repository: {repo_display}",
        f"- Inferred Issue: {issue_display}",
        "",
        "| Flag | State | Content |",
        "|------|-------|---------|",
    ]
    for fs in flag_statuses:
        state = "set" if fs.exists else "unset"
        lines.append(f"| {fs.name} | {state} | {fs.content} |")

    # 6. アクティブIssue情報の表示
    lines.extend(_active_issue_lines(flag_statuses))
    _OUT.data("\n".join(lines))


def _active_issue_lines(flag_statuses: list[FlagStatus]) -> list[str]:
    """Fetch the active Issue through the GitHub API and return the Markdown lines

    Parses the Issue reference from the .pecot-active flag,
    then fetches the title and state through the GitHub API.
    On a failure, prints only a warning and returns no lines.

    Args:
        flag_statuses: List of flag states
    """
    # .pecot-active フラグを探す
    active_flag = next(
        (fs for fs in flag_statuses if fs.name == FLAG_PECOT_ACTIVE and fs.exists and fs.content),
        None,
    )
    if active_flag is None:
        return []

    # Issue参照をパース（.pecot-active フラグは常に owner/repo/N 形式で書かれる）
    try:
        ref = parse_issue_ref(active_flag.content)
    except RefParseError:
        return []

    owner, repo, number = ref.repo.owner, ref.repo.repo, ref.number

    # 設定からホスト情報を取得
    config = load_active_config()
    if config is None:
        _OUT.warning("cannot read the active Issue: no active project")
        return []

    # GitHub APIでIssue情報を取得
    try:
        client = GitHubClient(host=config.host)
        issue = client.get_issue_slim(owner, repo, number, comment_limit=0)
    except GitHubAPIError as e:
        _OUT.warning(f"cannot read the active Issue: {e}")
        return []

    lines = ["", "## Active Issue", "", f"#{issue['number']} {issue['title']} ({issue['state']})"]
    body = issue.get("body", "")
    if body:
        lines.extend(["", body])
    return lines


# flag_restore コマンド


def _fetch_issue_title(issue_ref: str) -> str:
    """Fetch the Issue title for the session name. Return an empty string when the config is missing or unreadable or the API fails (restore goes on)."""
    try:
        config = load_active_config()
        if config is None:
            return ""
        ref = parse_issue_ref(issue_ref)
        issue = GitHubClient(host=config.host).get_issue_slim(
            ref.repo.owner, ref.repo.repo, ref.number, comment_limit=0
        )
    except PecotError:
        return ""
    return issue.get("title", "")


def flag_restore(
    issue: Annotated[
        str | None,
        typer.Option("--issue", "-i", help="Issue reference (owner/repo/number)"),
    ] = None,
    directory: DirectoryOption = ...,  # type: ignore[assignment]
) -> None:
    """Restore lost session flags (such as .pecot-active) from the branch information"""
    # 1. issue_ref を確定
    if issue is not None:
        # --issue 指定あり → パース（フル形式必須）
        try:
            ref = parse_issue_ref(issue)
        except RefParseError as e:
            _OUT.error(e.message)
            raise typer.Exit(code=2) from e
        owner, repo, number = ref.repo.owner, ref.repo.repo, ref.number
    else:
        # --issue 未指定 → ブランチから自動推定
        branch = git_current_branch(directory)
        if branch is None:
            _OUT.error("cannot read the branch name")
            raise typer.Exit(code=1)

        extracted_number = extract_issue_number_from_branch(branch)
        if extracted_number is None:
            _OUT.error(
                f"cannot infer the Issue number from the branch name: {branch}\n"
                "run: pecot session restore --issue <owner/repo/N>"
            )
            raise typer.Exit(code=1)

        origin = origin_repo(directory)
        if origin is None:
            _OUT.error("cannot read the repository information")
            raise typer.Exit(code=1)

        _host, owner, repo = origin
        number = extracted_number

    # 2. フラグ復元（セッション名用のタイトルは取れたときだけ添える）
    title = _fetch_issue_title(f"{owner}/{repo}/{number}")
    record_work_target(_OUT, owner, repo, number, title, fail_with_exit=True)
