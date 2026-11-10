"""cli/repo_display.py - helper for ``--show-repo`` output."""

from __future__ import annotations

from cli.commands._output import Output
from cli.core.repo_resolver import ResolvedRepo, ResolveSource

_OUT = Output(dry_run=False)


def print_resolved_repo(resolved: ResolvedRepo) -> None:
    """Write the result of ``resolve_repo`` to stdout in the ``--show-repo`` format."""
    lines = [f"resolved: {resolved.repo.owner}/{resolved.repo.repo}"]
    if resolved.source is ResolveSource.EXPLICIT:
        lines.append("source:   explicit")
    else:
        lines.append(f"source:   current-git ({resolved.remote_name})")
    _OUT.data("\n".join(lines))
