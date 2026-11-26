#!/usr/bin/env python3
"""pytest の test_* 関数が、Allure の題（@allure.title）と説明（1 段落の docstring）を持つかを確かめる。

決まりは .claude/rules/test-conventions.md の「pytest の題と説明」。引数のファイルだけを読む。
"""

from __future__ import annotations

import ast
import sys
from collections.abc import Iterator
from pathlib import Path

CONVENTION = ".claude/rules/test-conventions.md"

FunctionNode = ast.FunctionDef | ast.AsyncFunctionDef


def _tests(tree: ast.Module) -> Iterator[FunctionNode]:
    for node in tree.body:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name.startswith(
            "test_"
        ):
            yield node
        elif isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
            for member in node.body:
                if isinstance(
                    member, ast.FunctionDef | ast.AsyncFunctionDef
                ) and member.name.startswith("test_"):
                    yield member


def _has_title(function: FunctionNode) -> bool:
    for decorator in function.decorator_list:
        if not isinstance(decorator, ast.Call):
            continue
        callee = decorator.func
        is_title = (
            isinstance(callee, ast.Attribute)
            and callee.attr == "title"
            and isinstance(callee.value, ast.Name)
            and callee.value.id == "allure"
        )
        if not is_title or not decorator.args:
            continue
        first = decorator.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str) and first.value.strip():
            return True
    return False


def _docstring_problem(function: FunctionNode) -> str | None:
    raw = ast.get_docstring(function, clean=False)
    if raw is None or not raw.strip():
        return "docstring（説明）が無い"
    if raw[0].isspace():
        return "docstring が 1 行目から始まっていない"
    if any(not line.strip() for line in raw.rstrip().splitlines()):
        return "docstring に空行がある（1 段落で書く）"
    return None


def problems(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: list[str] = []
    for function in _tests(tree):
        where = f"{path}:{function.lineno}: {function.name}"
        if not _has_title(function):
            found.append(f"{where}: 文字列を渡す @allure.title（題）が無い")
        problem = _docstring_problem(function)
        if problem is not None:
            found.append(f"{where}: {problem}")
    return found


def main(arguments: list[str]) -> int:
    found = [line for argument in arguments for line in problems(Path(argument))]
    for line in found:
        print(line, file=sys.stderr)
    if found:
        print(f"\npytest のテストに題と説明を付けてください（{CONVENTION}）", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
