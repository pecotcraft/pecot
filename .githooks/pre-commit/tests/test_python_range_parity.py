"""Python の対応範囲の宣言が一致していることの確認。

対応範囲は 4 か所（root / pecot-workflow cli の pyproject.toml と uv.lock の
requires-python）に宣言される。python-version.sh の `PY` 変数は devcontainer の
system python に解決させる版で、宣言範囲に含まれていなければならない。run-tests.sh /
run-lint.sh はこれを source し、`uv sync` の `--python` に使う。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import tomllib
from packaging.specifiers import SpecifierSet
from packaging.version import Version

_CI_SCRIPTS = ("run-tests.sh", "run-lint.sh")
_PY_ASSIGNMENT = re.compile(r"^PY=(\S+)$", re.MULTILINE)
_SOURCE_PYTHON_VERSION = re.compile(r'^source "\$\{SCRIPT_DIR\}/python-version\.sh"$', re.MULTILINE)
_CI_DIR = "plugins/pecot-workflow/scripts/ci"


@pytest.fixture
def repo_root(script_dir: Path) -> Path:
    return script_dir.parents[1]


def _requires_python(path: Path) -> SpecifierSet:
    data = tomllib.loads(path.read_text())
    if path.name == "pyproject.toml":
        return SpecifierSet(data["project"]["requires-python"])
    return SpecifierSet(data["requires-python"])


def _declared_ranges(repo_root: Path) -> dict[str, SpecifierSet]:
    cli = repo_root / "plugins/pecot-workflow/cli"
    paths = [
        repo_root / "pyproject.toml",
        repo_root / "uv.lock",
        cli / "pyproject.toml",
        cli / "uv.lock",
    ]
    return {str(p.relative_to(repo_root)): _requires_python(p) for p in paths}


def _ci_python(repo_root: Path) -> str:
    text = (repo_root / _CI_DIR / "python-version.sh").read_text()
    matches = _PY_ASSIGNMENT.findall(text)
    assert len(matches) == 1, f"python-version.sh の PY= 代入が 1 つではありません: {matches}"
    return matches[0]


def test_declared_ranges_are_identical(repo_root: Path) -> None:
    ranges = _declared_ranges(repo_root)
    assert len(set(ranges.values())) == 1, ranges


def test_ci_python_is_within_declared_range(repo_root: Path) -> None:
    version = _ci_python(repo_root)
    for name, spec in _declared_ranges(repo_root).items():
        assert Version(version) in spec, f"PY={version} が {name} の範囲 {spec} の外"


@pytest.mark.parametrize("script", _CI_SCRIPTS)
def test_ci_scripts_sync_with_shared_python(repo_root: Path, script: str) -> None:
    text = (repo_root / _CI_DIR / script).read_text()
    assert not _PY_ASSIGNMENT.search(text), f"{script} が PY= を自前で定義しています"
    assert _SOURCE_PYTHON_VERSION.search(text), (
        f"{script} が python-version.sh を source していません"
    )
    sync_lines = [line for line in text.splitlines() if line.lstrip().startswith("uv sync")]
    assert len(sync_lines) == 1, f"{script} の uv sync が 1 行ではありません: {sync_lines}"
    assert '--python "$PY"' in sync_lines[0], (
        f"{script} の uv sync が PY を使っていません: {sync_lines[0]}"
    )
