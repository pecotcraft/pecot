"""cli/session.py - セッション管理コマンド実装

フラグ状態・ブランチ情報・Issue推定結果を一覧表示する。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

import typer

from cli.commands.options import DirectoryOption
from cli.commands.pr import extract_issue_number_from_branch
from cli.core.config import load_active_config
from cli.core.errors import PecotError
from cli.core.git import git_current_branch, origin_repo
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.paths import WORK_DIR
from cli.core.ref_parser import RefParseError, parse_issue_ref
from cli.core.state import (
    FLAG_PECOT_ACTIVE,
    ensure_work_dir,
    flag_exists,
    read_flag,
    write_work_target,
)

# データクラス


@dataclass
class FlagStatus:
    """フラグの状態"""

    name: str
    exists: bool
    content: str


# ユーティリティ関数


ALL_FLAGS = [
    FLAG_PECOT_ACTIVE,
]


def _collect_flag_statuses() -> list[FlagStatus]:
    """全フラグの存在有無・内容を収集

    Returns:
        FlagStatusのリスト
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
    """セッションのフラグ状態・ブランチ情報・Issue推定結果を表示

    診断ツールのため、取得失敗時もエラー終了せず (unknown) / (none) で表示する。
    """
    # 1. ブランチ情報取得
    branch = git_current_branch(directory)
    branch_display = branch if branch else "(unknown)"

    # 2. リポジトリ情報取得
    origin = origin_repo(directory)
    repo_display = f"{origin[1]}/{origin[2]}" if origin else "(unknown)"

    # 3. Issue番号推定
    issue_display = "(none)"
    if branch:
        issue_number = extract_issue_number_from_branch(branch)
        if issue_number is not None:
            issue_display = f"#{issue_number}"

    # 4. フラグ状態収集
    flag_statuses = _collect_flag_statuses()

    # 5. 出力
    typer.echo("=== フラグ状態 ===")
    typer.echo("")
    typer.echo(f"ブランチ: {branch_display}")
    typer.echo(f"リポジトリ: {repo_display}")
    typer.echo(f"推定Issue: {issue_display}")
    typer.echo("")
    typer.echo("| フラグ | 状態 | 内容 |")
    typer.echo("|-------|------|------|")
    for fs in flag_statuses:
        mark = "✓" if fs.exists else "-"
        typer.echo(f"| {fs.name} | {mark} | {fs.content} |")

    # 6. アクティブIssue情報の表示
    _show_active_issue(flag_statuses)


def _show_active_issue(flag_statuses: list[FlagStatus]) -> None:
    """アクティブIssueの情報をGitHub APIで取得・表示

    .pecot-activeフラグの内容からIssue参照をパースし、
    GitHub APIでタイトル・状態を取得して表示する。
    API失敗時は警告のみ表示して続行する。

    Args:
        flag_statuses: フラグ状態のリスト
    """
    # .pecot-active フラグを探す
    active_flag = next(
        (fs for fs in flag_statuses if fs.name == FLAG_PECOT_ACTIVE and fs.exists and fs.content),
        None,
    )
    if active_flag is None:
        return

    # Issue参照をパース（.pecot-active フラグは常に owner/repo/N 形式で書かれる）
    try:
        ref = parse_issue_ref(active_flag.content)
    except RefParseError:
        return

    owner, repo, number = ref.repo.owner, ref.repo.repo, ref.number

    # 設定からホスト情報を取得
    config = load_active_config()
    if config is None:
        typer.echo("", err=True)
        typer.echo("⚠ Issue情報の取得に失敗しました: アクティブ設定が見つかりません", err=True)
        return

    # GitHub APIでIssue情報を取得
    try:
        client = GitHubClient(host=config.host)
        issue = client.get_issue_slim(owner, repo, number, comment_limit=0)
    except GitHubAPIError as e:
        typer.echo("", err=True)
        typer.echo(f"⚠ Issue情報の取得に失敗しました: {e}", err=True)
        return

    # Issue情報を表示
    typer.echo("")
    typer.echo("=== アクティブIssue ===")
    typer.echo(f"#{issue['number']} {issue['title']} ({issue['state']})")
    body = issue.get("body", "")
    if body:
        typer.echo("")
        typer.echo(body)


# flag_restore コマンド


def _fetch_issue_title(issue_ref: str) -> str:
    """セッション名用に Issue タイトルを取る。設定が無い・読めない・API 失敗なら空文字（復元は止めない）"""
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
        typer.Option("--issue", "-i", help="Issue参照 (owner/repo/number)"),
    ] = None,
    directory: DirectoryOption = ...,  # type: ignore[assignment]
) -> None:
    """消失したセッションフラグ(.pecot-active等)をブランチ情報から復元"""
    # 1. issue_ref を確定
    if issue is not None:
        # --issue 指定あり → パース（フル形式必須）
        try:
            ref = parse_issue_ref(issue)
        except RefParseError as e:
            typer.echo(f"ERROR: {e.message}", err=True)
            raise typer.Exit(code=2) from e
        issue_ref = f"{ref.repo.owner}/{ref.repo.repo}/{ref.number}"
    else:
        # --issue 未指定 → ブランチから自動推定
        branch = git_current_branch(directory)
        if branch is None:
            typer.echo("ERROR: ブランチ名を取得できません", err=True)
            raise typer.Exit(code=1)

        extracted_number = extract_issue_number_from_branch(branch)
        if extracted_number is None:
            typer.echo(
                f"ERROR: ブランチ名からIssue番号を推定できません: {branch}",
                err=True,
            )
            typer.echo(
                "HINT: --issue owner/repo/number で手動指定してください",
                err=True,
            )
            raise typer.Exit(code=1)

        origin = origin_repo(directory)
        if origin is None:
            typer.echo("ERROR: リポジトリ情報を取得できません", err=True)
            raise typer.Exit(code=1)

        _host, owner, repo = origin
        issue_ref = f"{owner}/{repo}/{extracted_number}"
        typer.echo(f"ブランチ: {branch}")
        typer.echo(f"推定Issue: {issue_ref}")

    # 2. フラグ復元（セッション名用のタイトルは取れたときだけ添える）
    write_work_target(issue_ref, _fetch_issue_title(issue_ref))
    typer.echo(f"復元完了: {FLAG_PECOT_ACTIVE} → {issue_ref}")
    if ensure_work_dir(issue_ref):
        typer.echo(f"作業ファイル置き場: {WORK_DIR}/{issue_ref.rsplit('/', 1)[-1]}/")
