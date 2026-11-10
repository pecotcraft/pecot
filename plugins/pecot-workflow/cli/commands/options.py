"""cli/options.py - shared CLI option type definitions

Gathers the --directory / -D option reused by several commands in one place.
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
        help="Target Git repository (absolute or relative path)",
        exists=True,
        file_okay=False,
        dir_okay=True,
        resolve_path=True,
    ),
]


# --repo / --show-repo オプション（マルチリポ対応 FR-001 / FR-002）


def _validate_repo_option(value: str | None) -> str | None:
    """Typer callback that validates the ``--repo`` value."""
    if value is None:
        return None
    from cli.core.repo_resolver import RepoRef

    try:
        RepoRef.parse(value)
    except ValueError as e:
        raise typer.BadParameter(f"expected 'owner/repo' ({e})") from None
    return value


RepoOption = Annotated[
    str | None,
    typer.Option(
        "--repo",
        help="Target repository, given explicitly as 'owner/repo'",
        callback=_validate_repo_option,
    ),
]

ShowRepoOption = Annotated[
    bool,
    typer.Option(
        "--show-repo",
        help="Show the resolved repository and where it came from, then exit",
    ),
]
