"""cli/options.py - 共通CLIオプション型定義

複数コマンドで再利用される --directory / -D オプションを一箇所に集約。
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

# --directory / -D オプション共通パラメータ

# 必須版（worktree / session 系で directory: DirectoryOption = ... として使用）
DirectoryOption = Annotated[
    Path,
    typer.Option(
        "--directory",
        "-D",
        help="対象Gitリポジトリ（絶対パスまたは相対パス）",
        exists=True,
        file_okay=False,
        dir_okay=True,
        resolve_path=True,
    ),
]


# --repo / --show-repo オプション（マルチリポ対応 FR-001 / FR-002）


def _validate_repo_option(value: str | None) -> str | None:
    """``--repo`` の値を検証する typer callback。"""
    if value is None:
        return None
    from cli.core.repo_resolver import RepoRef

    try:
        RepoRef.parse(value)
    except ValueError as e:
        raise typer.BadParameter(f"'owner/repo' 形式で指定してください ({e})") from None
    return value


RepoOption = Annotated[
    str | None,
    typer.Option(
        "--repo",
        help="操作対象リポジトリを 'owner/repo' 形式で明示指定 (FR-001)",
        callback=_validate_repo_option,
    ),
]

ShowRepoOption = Annotated[
    bool,
    typer.Option(
        "--show-repo",
        help="解決されたリポジトリと解決元を表示して終了 (FR-002)",
    ),
]
