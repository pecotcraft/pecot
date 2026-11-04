"""cli/repo_display.py - ``--show-repo`` 出力ヘルパー (FR-002)。"""

from __future__ import annotations

import typer

from cli.core.repo_resolver import ResolvedRepo, ResolveSource


def print_resolved_repo(resolved: ResolvedRepo) -> None:
    """``resolve_repo`` の結果を ``--show-repo`` フォーマットで stdout に出力する。"""
    typer.echo(f"resolved: {resolved.repo.owner}/{resolved.repo.repo}")
    if resolved.source is ResolveSource.EXPLICIT:
        typer.echo("source:   explicit")
    else:
        typer.echo(f"source:   current-git ({resolved.remote_name})")
