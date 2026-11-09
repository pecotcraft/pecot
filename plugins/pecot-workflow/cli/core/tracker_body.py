"""core/tracker_body.py - Tracker の本文の一覧の範囲と、open の Tracker の探し方

security alert の Tracker（``pecot-alert``）と dependabot の PR の Tracker（``pecot-dependabot-pr``）が共有する。
印の正規表現と、印が不正なときのエラー型は呼び出し側が渡す。
種類によらない本文の処理（改行の正規化・表のセル）もここに置く。
行の書式・本文の組み立て・差分の判定は、種類ごとに扱いが違うので共通にしない。
"""

from __future__ import annotations

import re
from typing import Any, cast

from cli.core.errors import PecotError


def normalize_newlines(text: str) -> str:
    """改行を ``\\n`` にそろえる"""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def cell(text: str) -> str:
    """表のセルに入る文。``|`` と改行と ``<`` を無害にする"""
    one_line = re.sub(r"\s*[\r\n]+\s*", " ", text).strip()
    return one_line.replace("<", "&lt;").replace("|", "\\|")


def list_region(
    body: str, begin_re: re.Pattern[str], end_re: re.Pattern[str], error: type[PecotError]
) -> tuple[int, int]:
    """本文の一覧の範囲（begin の印の直後, end の印の先頭）。印の組が 1 組でなければエラー

    Raises:
        PecotError: ``error`` で渡した型（派生）。印の欠け・重なり・順序の逆転があるとき
    """
    begins = list(begin_re.finditer(body))
    ends = list(end_re.finditer(body))
    if len(begins) != 1 or len(ends) != 1 or begins[0].end() > ends[0].start():
        raise error(
            "Tracker の本文の list-begin / list-end の印が 1 組ではないため、一覧を書き直せません"
        )
    return begins[0].end(), ends[0].start()


def find_tracker(
    issues: list[dict[str, Any]], tracker_re: re.Pattern[str]
) -> tuple[dict[str, Any] | None, list[int]]:
    """ラベルで引いた Issue から、open の Tracker を探す

    本文に Tracker の印があり、open のものを対象にする。複数あれば番号が最小のものを使い、
    ほかの番号を返す（警告用。sync は閉じない）。
    """
    found = sorted(
        (
            i
            for i in issues
            if i.get("state") == "open"
            and isinstance(i.get("body"), str)
            and tracker_re.search(cast("str", i["body"]))
        ),
        key=lambda i: cast("int", i["number"]),
    )
    if not found:
        return None, []
    return found[0], [cast("int", i["number"]) for i in found[1:]]
