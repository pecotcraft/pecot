"""Check that docstrings and ``help=`` in cli/commands/ have no Japanese characters (spec 021 FR-012)."""

from __future__ import annotations

import ast
import re
from collections.abc import Iterator
from pathlib import Path

import pytest

COMMANDS_DIR = Path(__file__).resolve().parents[2] / "commands"
COMMAND_FILES = sorted(COMMANDS_DIR.glob("*.py"))

# Kana and CJK ideographs with their extensions. Also CJK punctuation and full-width forms.
JAPANESE = re.compile(
    "[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]"
)

_DOCSTRING_OWNERS = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)


def _fixed_text(node: ast.expr) -> str:
    """Return the fixed part of a string expression. Interpolated values are left out."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(_fixed_text(value) for value in node.values)
    if isinstance(node, ast.BinOp):
        return _fixed_text(node.left) + _fixed_text(node.right)
    return ""


def _docstrings(tree: ast.Module) -> Iterator[tuple[int, str]]:
    """Yield the line and text of each docstring, including private functions."""
    for node in ast.walk(tree):
        if not isinstance(node, _DOCSTRING_OWNERS):
            continue
        docstring = ast.get_docstring(node, clean=False)
        if docstring is None:
            continue
        first = node.body[0]
        yield first.lineno, docstring


def _help_strings(tree: ast.Module) -> Iterator[tuple[int, str]]:
    """Yield the line and fixed text of each ``help=`` keyword argument."""
    for node in ast.walk(tree):
        if isinstance(node, ast.keyword) and node.arg == "help":
            yield node.value.lineno, _fixed_text(node.value)


def _japanese_texts(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found = [*_docstrings(tree), *_help_strings(tree)]
    return [
        f"{path.name}:{line}: {text.strip()[:40]!r}"
        for line, text in sorted(found)
        if JAPANESE.search(text)
    ]


def test_command_files_exist() -> None:
    assert COMMAND_FILES, f"no Python files in {COMMANDS_DIR}"


@pytest.mark.parametrize("path", COMMAND_FILES, ids=lambda path: path.name)
def test_no_japanese_in_docstrings_and_help(path: Path) -> None:
    found = _japanese_texts(path)
    assert not found, "Japanese text in docstrings or help=:\n" + "\n".join(found)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ('"""日本語"""', 1),
        ('def f():\n    """カタカナ"""', 1),
        ('typer.Option(help="ひらがな")', 1),
        ('typer.Option(help=f"{x} 漢字")', 1),
        ('typer.Option(help="full-width （）")', 1),
        ('"""English only — ok → §"""', 0),
        ('typer.Option(help=f"{日本}")', 0),
        ('typer.echo("行の出力")', 0),
    ],
)
def test_detector(source: str, expected: int, tmp_path: Path) -> None:
    sample = tmp_path / "sample.py"
    sample.write_text(source, encoding="utf-8")
    assert len(_japanese_texts(sample)) == expected
