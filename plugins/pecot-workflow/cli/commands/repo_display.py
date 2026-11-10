"""cli/repo_display.py - helper for ``--show-repo`` output."""

from __future__ import annotations

import typer

from cli.core.repo_resolver import ResolvedRepo, ResolveSource


def print_resolved_repo(resolved: ResolvedRepo) -> None:
    """Write the result of ``resolve_repo`` to stdout in the ``--show-repo`` format."""
    typer.echo(f"resolved: {resolved.repo.owner}/{resolved.repo.repo}")
    if resolved.source is ResolveSource.EXPLICIT:
        typer.echo("source:   explicit")
    else:
        typer.echo(f"source:   current-git ({resolved.remote_name})")
