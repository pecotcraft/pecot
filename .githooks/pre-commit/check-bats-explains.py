#!/usr/bin/env python3
"""bats の @test が、本体の先頭で explains（テストレポートの説明）を呼ぶかを確かめる。

決まりは .claude/rules/test-conventions.md の「bash のテスト」。引数のファイルだけを読む。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

CONVENTION = ".claude/rules/test-conventions.md"

_TEST = re.compile(r"""^\s*@test\s+(?P<q>["'])(?P<title>.*)(?P=q)\s*\{\s*$""")
_DYNAMIC = re.compile(r"^\s*bats_test_function\b.*?\s--\s+(?P<function>[A-Za-z_][\w-]*)")
_FUNCTION = r"^\s*(?:function\s+)?{name}\s*(?:\(\s*\))?\s*\{{\s*$"
_EXPLAINS = re.compile(r"""^\s*explains(?:\s|$)""")
_EXPLAINS_LITERAL = re.compile(
    r"""^\s*explains\s+(?:"(?P<d>(?:[^"\\$`]|\\.)+)"|'(?P<s>[^']+)')\s*$"""
)


def _first_command(lines: list[str], start: int) -> tuple[int, str] | None:
    """start 行より後の、空行とコメントを除いた最初の行（1 始まりの行番号と中身）。"""
    for index in range(start, len(lines)):
        stripped = lines[index].strip()
        if stripped and not stripped.startswith("#"):
            return index + 1, lines[index]
    return None


def _explains_problem(first: tuple[int, str] | None) -> str | None:
    if first is None or first[1].strip() == "}":
        return "本体が空で、explains（説明）が無い"
    line = first[1]
    if not _EXPLAINS.match(line):
        return "本体の最初のコマンドが explains（説明）でない"
    if line.rstrip().endswith("\\") or not _EXPLAINS_LITERAL.match(line):
        return "explains に、1 行で書いた空でない文字列のリテラルを渡していない"
    return None


def problems(path: Path) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    found: list[str] = []
    for number, line in enumerate(lines, start=1):
        test = _TEST.match(line)
        if test:
            problem = _explains_problem(_first_command(lines, number))
            if problem is not None:
                found.append(f"{path}:{number}: {test.group('title')}: {problem}")
            continue
        dynamic = _DYNAMIC.match(line)
        if dynamic:
            name = dynamic.group("function")
            pattern = re.compile(_FUNCTION.format(name=re.escape(name)))
            definition = next((i for i, text in enumerate(lines) if pattern.match(text)), None)
            if definition is None:
                found.append(f"{path}:{number}: {name}: bats_test_function の関数の定義が無い")
                continue
            problem = _explains_problem(_first_command(lines, definition + 1))
            if problem is not None:
                found.append(f"{path}:{number}: {name}: {problem}")
    return found


def main(arguments: list[str]) -> int:
    found = [line for argument in arguments for line in problems(Path(argument))]
    for line in found:
        print(line, file=sys.stderr)
    if found:
        print(
            f"\nbats の @test の本体の先頭で explains を呼んでください（{CONVENTION}）",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
