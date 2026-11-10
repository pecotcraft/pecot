"""Check that string literals in cli/commands/ have no Japanese characters (spec 021 FR-012)."""

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

# Text written to GitHub keeps its language (research R10). Keyed by (file name, assigned name).
GITHUB_TEXT: frozenset[tuple[str, str]] = frozenset({("issue.py", "_QUICK_BODY_FOOTER")})


def _assigned_names(node: ast.stmt) -> list[str]:
    targets = node.targets if isinstance(node, ast.Assign) else [getattr(node, "target", None)]
    return [target.id for target in targets if isinstance(target, ast.Name)]


def _github_text_nodes(tree: ast.Module, file_name: str) -> tuple[set[int], set[str]]:
    """Return the ids of the nodes under GITHUB_TEXT assignments, and the names found."""
    excluded: set[int] = set()
    found: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign | ast.AnnAssign) or node.value is None:
            continue
        for name in _assigned_names(node):
            if (file_name, name) in GITHUB_TEXT:
                found.add(name)
                excluded.update(id(child) for child in ast.walk(node.value))
    return excluded, found


def _string_constants(tree: ast.Module, excluded: set[int]) -> Iterator[tuple[int, str]]:
    """Yield each string constant once: docstrings, ``help=``, and fixed parts of f-strings."""
    for node in ast.walk(tree):
        if id(node) in excluded:
            continue
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            yield node.lineno, node.value


def _japanese_texts(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    excluded, _ = _github_text_nodes(tree, path.name)
    return [
        f"{path.name}:{line}: {text.strip()[:40]!r}"
        for line, text in sorted(_string_constants(tree, excluded))
        if JAPANESE.search(text)
    ]


def test_command_files_exist() -> None:
    assert COMMAND_FILES, f"no Python files in {COMMANDS_DIR}"


@pytest.mark.parametrize("path", COMMAND_FILES, ids=lambda path: path.name)
def test_no_japanese_in_string_literals(path: Path) -> None:
    found = _japanese_texts(path)
    assert not found, "Japanese text in string literals:\n" + "\n".join(found)


@pytest.mark.parametrize(("file_name", "name"), sorted(GITHUB_TEXT))
def test_github_text_names_exist(file_name: str, name: str) -> None:
    path = COMMANDS_DIR / file_name
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    _, found = _github_text_nodes(tree, file_name)
    assert name in found, f"{file_name} has no assignment to {name}; update GITHUB_TEXT"


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ('"""日本語"""', 1),
        ('def f():\n    """カタカナ"""', 1),
        ('typer.Option(help="ひらがな")', 1),
        ('typer.Option(help=f"{x} 漢字")', 1),
        ('typer.Option(help="full-width （）")', 1),
        ('typer.echo("行の出力")', 1),
        ('raise typer.BadParameter(f"{value} は不正")', 1),
        ('"""English only — ok → §"""', 0),
        ('typer.Option(help=f"{日本}")', 0),
        ('_QUICK_BODY_FOOTER = f"{x} 本文"', 0),
        ('OTHER = f"{x} 本文"', 1),
    ],
)
def test_detector(source: str, expected: int, tmp_path: Path) -> None:
    sample = tmp_path / "issue.py"
    sample.write_text(source, encoding="utf-8")
    assert len(_japanese_texts(sample)) == expected
