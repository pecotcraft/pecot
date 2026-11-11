"""commands/_tracker_sync.py - shared code for the sync commands that feed a Tracker (security, dependabot)

Holds target repository and active project resolution, the ``--dry-run`` option, the API error text, and the multiple-Tracker warning.
Per-kind code (fetching the list, building rows, rewrite steps) stays in each command.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

import httpx
import typer

from cli.commands._output import Operation, Output
from cli.commands.release import resolve_release_target_repo
from cli.core.config import ProjectConfig, load_active_config
from cli.core.github import GitHubAPIError, GitHubClient

DryRunOption = Annotated[
    bool,
    typer.Option("--dry-run", help="Show the planned Tracker changes without changing anything"),
]


def load_target(ctx: typer.Context, out: Output) -> tuple[ProjectConfig, str, str]:
    """Resolve the target repository (git origin, ``--repo`` first) and the active project

    Used by ``pecot security sync`` and ``pecot dependabot sync``.

    Raises:
        typer.Exit(1): when the repository or the active project cannot be resolved
    """
    owner, repo = resolve_release_target_repo(ctx, Path.cwd())
    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)
    return config, owner, repo


def make_client(out: Output, config: ProjectConfig) -> GitHubClient:
    """Create the GitHub client; an auth or API error becomes an ``error:`` line and exit 1

    Raises:
        typer.Exit(1): when the client cannot be created (for example, no token)
    """
    try:
        return GitHubClient(host=config.host)
    except GitHubAPIError as e:
        out.error(e.message)
        raise typer.Exit(1) from None


def api_error_detail(e: GitHubAPIError | httpx.HTTPError) -> str:
    """Text to show for an API error"""
    return e.message if isinstance(e, GitHubAPIError) else str(e)


def settle(out: Output, op: Operation) -> None:
    """Print the line for an operation without an API call (plan in dry-run, result otherwise)"""
    out.planned(op)
    out.done(op)


def warn_extra_trackers(out: Output, tracker: dict[str, Any] | None, others: list[int]) -> None:
    """Warn when several Trackers are open (use the lowest number, leave the others open)"""
    if not others:
        return
    listed = ", ".join(f"#{n}" for n in others)
    used = f"#{tracker['number']}" if tracker else "none"
    out.warning(f"multiple open Trackers; using {used} (lowest number) and leaving {listed} open")
