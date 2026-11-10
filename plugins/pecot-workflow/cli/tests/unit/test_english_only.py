"""Check that Japanese text stays out of the CLI sources (spec 021).

- ``cli/commands/``: docstrings and ``help=`` (FR-012).
- ``cli/core/``: every string literal, except the ones listed in ``CORE_JAPANESE_ALLOWED`` (FR-007, SC-007).
"""

from __future__ import annotations

import ast
import re
from collections.abc import Iterator
from dataclasses import dataclass
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


# Every string literal under a source tree. It is used for cli/core/ and can be reused for cli/commands/.

CORE_DIR = Path(__file__).resolve().parents[2] / "core"
CORE_FILES = sorted(CORE_DIR.rglob("*.py"))


@dataclass(frozen=True)
class Literal:
    """A string literal with the name of the function or assignment target that holds it."""

    line: int
    scope: str
    text: str


@dataclass(frozen=True)
class Allowed:
    """A Japanese literal that stays: (path from the tree root, scope, text) plus why."""

    path: str
    scope: str
    text: str


def _target_name(node: ast.AST) -> str | None:
    target = node.targets[0] if isinstance(node, ast.Assign) else getattr(node, "target", None)
    if isinstance(target, ast.Name):
        return target.id
    if isinstance(target, ast.Attribute):
        return target.attr
    return None


def _walk_literals(node: ast.AST, scope: str, out: list[Literal]) -> None:
    for child in ast.iter_child_nodes(node):
        if (
            isinstance(child, ast.Expr)
            and isinstance(child.value, (ast.Constant, ast.JoinedStr))
            and (isinstance(child.value, ast.JoinedStr) or isinstance(child.value.value, str))
        ):
            # A string statement: a docstring or an attribute docstring.
            continue
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            _walk_literals(child, child.name, out)
            continue
        if isinstance(child, (ast.Assign, ast.AnnAssign)) and scope == "<module>":
            name = _target_name(child)
            if name is not None:
                _walk_literals(child, name, out)
                continue
        if isinstance(child, ast.Constant) and isinstance(child.value, str):
            out.append(Literal(child.lineno, scope, child.value))
        elif isinstance(child, ast.JoinedStr):
            # One literal for the fixed parts. The parts and format specs are not counted again.
            fixed = "".join(
                v.value
                for v in child.values
                if isinstance(v, ast.Constant) and isinstance(v.value, str)
            )
            out.append(Literal(child.lineno, scope, fixed))
            for value in child.values:
                if isinstance(value, ast.FormattedValue):
                    _walk_literals(value, scope, out)
        else:
            _walk_literals(child, scope, out)


def string_literals(path: Path) -> list[Literal]:
    """Return every string literal in the file except string statements (docstrings)."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    out: list[Literal] = []
    _walk_literals(tree, "<module>", out)
    return out


def japanese_literals(path: Path, root: Path, allowed: tuple[Allowed, ...]) -> list[str]:
    """Return ``file:line: text`` for each Japanese literal that is not in the allowed list."""
    rel = path.relative_to(root).as_posix()
    keys = {(a.path, a.scope, a.text) for a in allowed}
    return [
        f"{rel}:{lit.line}: {lit.scope}: {lit.text.strip()[:60]!r}"
        for lit in string_literals(path)
        if JAPANESE.search(lit.text) and (rel, lit.scope, lit.text) not in keys
    ]


# The Japanese that stays in cli/core/. None of it is CLI output.
# Each one is a body written to GitHub.
# Or it is a file written to the user's repository.
# Or it is a set of characters used to judge text.
CORE_JAPANESE_ALLOWED: tuple[Allowed, ...] = (
    # The form of the body written to GitHub; the template has the same string.
    Allowed("sections.py", "PLAN_FOLD_SUMMARY", '<summary align="right">詳細はこちら</summary>'),
    # Characters that end a sentence and close a bracket in Japanese text.
    Allowed("sections.py", "_SENTENCE_END_CHARS", "。！？!?"),
    Allowed("sections.py", "_CLOSING_BRACKETS", "」』）】〕〉》］｝\"'”’)]}"),
    # A value in the table written to the Tracker body on GitHub.
    Allowed("security_alerts.py", "_advisory_row", "不明"),
    # Contents of the .env that `ensure_env_file` writes to the user's project. `worktree init`
    # does not print it, and English would split old and new files by language.
    Allowed("github/auth.py", "ensure_env_file", "# 必要なスコープ: "),
    Allowed(
        "github/auth.py",
        "ensure_env_file",
        "# pecot-cli 認証設定\n# 各トークンの値を設定してください\n#\n# トークン作成時は必要なスコープを付与してください\n",
    ),
    Allowed("github/auth.py", "ensure_env_file", "\n# \n# 取得先: \n\n=\n"),
    # Contents of the .worktreeignore that `worktree init` writes to the user's repository.
    Allowed(
        "worktree_links.py",
        "DEFAULT_WORKTREEIGNORE_CONTENT",
        "# Git メタデータ\n.git/\n\n# Python キャッシュ。\n__pycache__/\n*.pyc\n*.pyo\n.venv/\nvenv/\n*.egg-info/\n"
        ".pytest_cache/\n.mypy_cache/\n.ruff_cache/\n.tox/\n\n# カバレッジ\nhtmlcov/\n.coverage\n\n"
        "# ビルド生成物\ndist/\nbuild/\n\n# JS 依存\nnode_modules/\n\n"
        "# pecot の実行時状態・一時領域（config は worktree-config の links 経由で symlink）\n.pecot/\ntmp/\n\n"
        "# Nx ビルド状態（version-plans は残すので .nx/ 丸ごとは除外しない）\n.nx/workspace-data/\n",
    ),
    # The `description` fields of the worktree config that `worktree init` writes to the user's repository.
    Allowed("worktree_links.py", "get_default_config", "ローカル向け CLAUDE 指示（Git 管理外）"),
    Allowed("worktree_links.py", "get_default_config", "環境変数（Git 管理外）"),
    Allowed("worktree_links.py", "get_default_config", "Claude Code のローカル設定"),
    Allowed(
        "worktree_links.py", "get_default_config", "pecot hooks 有効/無効設定（main WT と共有）"
    ),
    Allowed("worktree_links.py", "get_default_config", "active project ポインタ（main WT と共有）"),
    Allowed("worktree_links.py", "get_default_config", "作業ファイル置き場（main WT の  を共有）"),
    Allowed(
        "worktree_links.py",
        "get_default_config",
        "wtN/<repo> から base/<target_repo>/<target_path> への相対 symlink 設定。"
        " target_repo は WT 間で共有したいファイルを置くメインリポ名に置換し、"
        " 不要な link は削除してください。",
    ),
)


def test_core_files_exist() -> None:
    assert CORE_FILES, f"no Python files in {CORE_DIR}"


@pytest.mark.parametrize("path", CORE_FILES, ids=lambda path: path.relative_to(CORE_DIR).as_posix())
def test_no_japanese_in_core_literals(path: Path) -> None:
    found = japanese_literals(path, CORE_DIR, CORE_JAPANESE_ALLOWED)
    assert not found, "Japanese string literals in cli/core/:\n" + "\n".join(found)


@pytest.mark.parametrize("allowed", CORE_JAPANESE_ALLOWED, ids=lambda a: f"{a.path}:{a.scope}")
def test_core_allowed_entry_still_in_source(allowed: Allowed) -> None:
    literals = string_literals(CORE_DIR / allowed.path)
    assert any(lit.scope == allowed.scope and lit.text == allowed.text for lit in literals), (
        f"{allowed.path}: {allowed.scope} no longer holds this text; remove it from CORE_JAPANESE_ALLOWED"
    )


def _japanese_in_source(source: str, tmp_path: Path) -> list[str]:
    sample = tmp_path / "sample.py"
    sample.write_text(source, encoding="utf-8")
    return japanese_literals(sample, tmp_path, ())


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ('raise ValueError("失敗")', 1),
        ('raise ValueError(f"失敗: {v}")', 1),
        ('raise ValueError(f"{a}と{b}")', 1),
        ('raise ValueError(f"{v:>10}")', 0),
        ('X = "日本語"', 1),
        ('def f():\n    """日本語の docstring"""', 0),
        ('X = 1\n"""属性の docstring"""', 0),
        ('class C:\n    x: int\n    """属性の docstring"""', 0),
        ('print("a" + "日本語")', 1),
        ("print(f\"{x or '不明'}\")", 1),
        ('raise ValueError("English only")', 0),
    ],
)
def test_core_literal_detector(source: str, expected: int, tmp_path: Path) -> None:
    assert len(_japanese_in_source(source, tmp_path)) == expected


def test_core_literal_detector_scope(tmp_path: Path) -> None:
    sample = tmp_path / "sample.py"
    sample.write_text('X = "日"\ndef f():\n    return "本"\n', encoding="utf-8")
    scopes = {lit.scope for lit in string_literals(sample)}
    assert scopes == {"X", "f"}
