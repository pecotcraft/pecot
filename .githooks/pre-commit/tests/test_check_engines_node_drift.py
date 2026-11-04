"""check-engines-node-drift.sh のユニットテスト（test_check_engines_node_drift.bats 移植）。

hook は git ls-files を使って対象を列挙するため、テスト用に一時的な git リポジトリを
構築し、その中で hook を起動する。node 依存（hook が node を使う）はそのまま subprocess
で実行する。GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する。
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest

EXPECTED = "^24.22.1 || >=26.12.1"


@pytest.fixture
def drift_repo(git_repo: Callable[..., Path]) -> Path:
    """temp git repo（init/config 済み）を作る（各 .bats の setup 相当）。"""
    return git_repo("repo")


def _make_pkg(git, repo: Path, rel: str, node_value: str) -> None:
    """plugins/pecot-visual/<rel>/package.json を作る。

    node_value が "MISSING" なら engines キー無し、それ以外は engines.node の値。
    """
    path = repo / "plugins" / "pecot-visual" / rel / "package.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    if node_value == "MISSING":
        pkg = {"name": "x", "version": "0.0.0"}
    else:
        pkg = {"name": "x", "version": "0.0.0", "engines": {"node": node_value}}
    path.write_text(json.dumps(pkg, indent=2) + "\n")
    git(repo, "add", str(path.relative_to(repo)))


def test_all_expected_passes(script_dir: Path, drift_repo: Path, run_script, git) -> None:
    """(a) 全 package.json が期待値 → exit 0。"""
    _make_pkg(git, drift_repo, "assets/slidev", EXPECTED)
    _make_pkg(git, drift_repo, "assets/slidev/runtime", EXPECTED)
    # glob は plugins/pecot-visual/** 全体。assets/ 配下に限らず、任意の深さの
    # package.json が対象に含まれる（nested/deck は合成パス）。
    _make_pkg(git, drift_repo, "nested/deck", EXPECTED)
    result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)
    assert result.returncode == 0


def test_one_drift_fails_with_got(script_dir: Path, drift_repo: Path, run_script, git) -> None:
    """(b) 1 ファイル ">=22.6.0" → exit 1, got 表記を含む。"""
    _make_pkg(git, drift_repo, "assets/slidev", ">=22.6.0")
    _make_pkg(git, drift_repo, "assets/slidev/runtime", EXPECTED)
    result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert (
        f'plugins/pecot-visual/assets/slidev/package.json: expected "{EXPECTED}", got ">=22.6.0"'
        in out
    )
    assert "allow-list 機構はありません" in out


def test_missing_engines_fails(script_dir: Path, drift_repo: Path, run_script, git) -> None:
    """(c) engines キー欠落 → exit 1, missing engines.node を含む。"""
    _make_pkg(git, drift_repo, "assets/slidev", "MISSING")
    result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)
    assert result.returncode == 1
    assert "missing engines.node" in (result.stdout + result.stderr)


def test_two_violations_both_reported(script_dir: Path, drift_repo: Path, run_script, git) -> None:
    """(d) 2 ファイル違反 → exit 1, 両方が出力に含まれる。"""
    _make_pkg(git, drift_repo, "assets/slidev", ">=22.6.0")
    _make_pkg(git, drift_repo, "assets/slidev/runtime", ">=20.0.0")
    result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "plugins/pecot-visual/assets/slidev/package.json" in out
    assert "plugins/pecot-visual/assets/slidev/runtime/package.json" in out


def test_node_modules_violation_ignored(
    script_dir: Path, drift_repo: Path, run_script, git
) -> None:
    """(e) node_modules/ 配下違反は exit 0（glob 対象外）。"""
    _make_pkg(git, drift_repo, "assets/slidev", EXPECTED)
    nm = drift_repo / "plugins/pecot-visual/assets/slidev/node_modules/foo/package.json"
    nm.parent.mkdir(parents=True, exist_ok=True)
    nm.write_text(json.dumps({"name": "foo", "engines": {"node": ">=18"}}, indent=2) + "\n")
    git(drift_repo, "add", "-f", str(nm.relative_to(drift_repo)))
    result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)
    assert result.returncode == 0
