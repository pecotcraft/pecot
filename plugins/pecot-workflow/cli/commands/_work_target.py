"""cli/commands/_work_target.py - record the work target (.pecot-active) and print the result line"""

from __future__ import annotations

import typer

from cli.commands._output import Operation, Output, Verb
from cli.core.paths import WORK_DIR
from cli.core.state import ensure_work_dir, write_work_target


def record_work_target(
    out: Output,
    owner: str,
    repo_name: str,
    issue_number: int,
    title: str,
    *,
    fail_with_exit: bool = False,
) -> None:
    """Write .pecot-active and print the ``set: work target ...`` line.

    A failure is a warning by default. With ``fail_with_exit`` it is an error and exits with 1.
    """
    issue_ref = f"{owner}/{repo_name}/{issue_number}"
    try:
        write_work_target(issue_ref, title)
        target = f"work target {issue_ref}"
        if ensure_work_dir(issue_ref):
            target += f" (work directory {WORK_DIR}/{issue_number}/)"
    except Exception as e:
        if fail_with_exit:
            out.error(f"could not record the work target: {e}")
            raise typer.Exit(1) from None
        out.warning(f"could not record the work target: {e}")
        return
    out.done(Operation(Verb.SET, target))
