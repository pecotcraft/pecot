"""cli/commands/_output.py - CLI の出力の行をそろえる共通の関数

行の形は ``specs/021-cli-output-functions/contracts/output-lines.md`` の決まりに従う。
コマンドのコードは ``Output`` を受け取り、sys.stdout / sys.stderr に直接触れない。
行はすべて英語で書く。
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
    """操作の動詞。値は plan の行に使う語の名前。"""

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
        """result の行の前置きに使う過去分詞。"""
        return _PAST[self.value]


@dataclass(frozen=True)
class Operation:
    """plan と result の行の元になる操作（動詞と対象）。"""

    verb: Verb
    target: str


def _message_lines(prefix: str, message: str) -> str:
    """前置きを付け、2 行目以降を空白 2 つで字下げし、末尾に改行を 1 つ付ける。"""
    body = message.rstrip("\n").replace("\n", "\n  ")
    return f"{prefix}: {body}\n"


class Output:
    """行を出す関数の集まり。dry_run は起動時に決まり、途中で変えない。"""

    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run

    @staticmethod
    def _err(text: str) -> None:
        sys.stderr.write(text)

    def planned(self, op: Operation) -> None:
        """dry-run のときだけ plan の行を stderr へ出す。"""
        if not self.dry_run:
            return
        if op.verb is Verb.UNCHANGED:
            self._err(f"dry-run: would leave {op.target} unchanged\n")
        else:
            self._err(f"dry-run: would {op.verb.value} {op.target}\n")

    def done(self, op: Operation) -> None:
        """dry-run でないときだけ result の行を stderr へ出す。"""
        if self.dry_run:
            return
        self._err(f"{op.verb.past}: {op.target}\n")

    def warning(self, message: str) -> None:
        """warning の行を stderr へ出す。"""
        self._err(_message_lines("warning", message))

    def error(self, message: str) -> None:
        """error の行を stderr へ出す。"""
        self._err(_message_lines("error", message))

    def count(self, label: str, value: int | None) -> None:
        """count の行を stderr へ出す。値が None のときは ``unknown``。"""
        shown = "unknown" if value is None else str(value)
        self._err(f"count: {label}: {shown}\n")

    def data(self, text: str) -> None:
        """中身をそのまま stdout へ出す。末尾に改行が無ければ 1 つ足す。"""
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
