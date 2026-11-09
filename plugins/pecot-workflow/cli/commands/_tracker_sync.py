"""commands/_tracker_sync.py - Tracker に載せる sync コマンド（security・dependabot）で共通に使う処理

対象リポとアクティブなプロジェクトの解決、``--dry-run`` の option、API エラーの文言、複数 Tracker の警告を置く。
種類ごとに違う処理（一覧の取得・行の組み立て・書き直しの手順）は各コマンドに置く。
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

import httpx
import typer

from cli.commands.release import resolve_release_target_repo
from cli.core.config import ProjectConfig, load_active_config
from cli.core.github import GitHubAPIError

DryRunOption = Annotated[
    bool,
    typer.Option("--dry-run", help="Tracker への変更の予定を表示するだけで、何も変更しない"),
]


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


def api_error_detail(e: GitHubAPIError | httpx.HTTPError) -> str:
    """API エラーの表示用の文言"""
    return e.message if isinstance(e, GitHubAPIError) else str(e)


def warn_extra_trackers(tracker: dict[str, Any] | None, others: list[int]) -> None:
    """open の Tracker が複数あるときの警告（番号が最小のものを使い、ほかは閉じない）"""
    if not others:
        return
    listed = "・".join(f"#{n}" for n in others)
    used = f"#{tracker['number']}" if tracker else "なし"
    typer.echo(
        f"警告: open の Tracker が複数あります。番号が最小の {used}"
        f" を使い、ほか（{listed}）は閉じません",
        err=True,
    )
