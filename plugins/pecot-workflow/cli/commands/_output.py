"""cli/commands/_output.py - shared functions that align the lines the CLI prints

The line format follows ``specs/021-cli-output-functions/contracts/output-lines.md``.
Command code receives an ``Output`` and never touches sys.stdout / sys.stderr directly.
All lines are written in English.
"""

from __future__ import annotations

import enum
import sys
from dataclasses import dataclass

_PAST: dict[str, str] = {
    "create": "created",
    "update": "updated",
    "delete": "deleted",
    "add": "added",
    "remove": "removed",
    "close": "closed",
    "merge": "merged",
    "move": "moved",
    "set": "set",
    "skip": "skipped",
    "unchanged": "unchanged",
}


class Verb(enum.Enum):
    """Operation verb. The value is the word used in a plan line."""

    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    ADD = "add"
    REMOVE = "remove"
    CLOSE = "close"
    MERGE = "merge"
    MOVE = "move"
    SET = "set"
    SKIP = "skip"
    UNCHANGED = "unchanged"

    @property
    def past(self) -> str:
        """Past participle used as the prefix of a result line."""
        return _PAST[self.value]


@dataclass(frozen=True)
class Operation:
    """Operation (verb and target) that plan and result lines are built from."""

    verb: Verb
    target: str


def _message_lines(prefix: str, message: str) -> str:
    """Add the prefix, indent the second and later lines by two spaces, and end with one newline."""
    body = message.rstrip("\n").replace("\n", "\n  ")
    return f"{prefix}: {body}\n"


class Output:
    """Functions that print lines. dry_run is fixed at startup and never changes."""

    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run

    @staticmethod
    def _err(text: str) -> None:
        sys.stderr.write(text)

    def planned(self, op: Operation) -> None:
        """Write a plan line to stderr only in dry-run."""
        if not self.dry_run:
            return
        if op.verb is Verb.UNCHANGED:
            self._err(f"dry-run: would leave {op.target} unchanged\n")
        else:
            self._err(f"dry-run: would {op.verb.value} {op.target}\n")

    def done(self, op: Operation) -> None:
        """Write a result line to stderr only outside dry-run."""
        if self.dry_run:
            return
        self._err(f"{op.verb.past}: {op.target}\n")

    def warning(self, message: str) -> None:
        """Write a warning line to stderr."""
        self._err(_message_lines("warning", message))

    def error(self, message: str) -> None:
        """Write an error line to stderr."""
        self._err(_message_lines("error", message))

    def count(self, label: str, value: int | None) -> None:
        """Write a count line to stderr. ``unknown`` when the value is None."""
        shown = "unknown" if value is None else str(value)
        self._err(f"count: {label}: {shown}\n")

    def data(self, text: str) -> None:
        """Write the text to stdout as is, adding a newline if it has none."""
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
