"""check-engines-node-drift.sh のユニットテスト（test_check_engines_node_drift.bats 移植）。

hook は git ls-files を使って対象を列挙するため、テスト用に一時的な git リポジトリを
構築し、その中で hook を起動する。node 依存（hook が node を使う）はそのまま subprocess
で実行する。GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する。
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import allure
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


@allure.title("すべての package.json の engines.node が期待値なら、成功で終わる")
def test_all_expected_passes(script_dir: Path, drift_repo: Path, run_script, git) -> None:
    """`plugins/pecot-visual` 配下の `package.json` の `engines.node` を対象にする、`check-engines-node-drift.sh` のテストです。任意の深さにある 3 件がすべて期待値の場合に、終了コード 0 で終わることを確認します。"""
    with allure.step("期待値の package.json を 3 つ用意して hook を動かす"):
        _make_pkg(git, drift_repo, "assets/slidev", EXPECTED)
        _make_pkg(git, drift_repo, "assets/slidev/runtime", EXPECTED)
        # glob は plugins/pecot-visual/** 全体。assets/ 配下に限らず、任意の深さの
        # package.json が対象に含まれる（nested/deck は合成パス）。
        _make_pkg(git, drift_repo, "nested/deck", EXPECTED)
        result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0


@allure.title("1 件の engines.node が期待値と異なると、期待値と実際の値を出力して失敗で終わる")
def test_one_drift_fails_with_got(script_dir: Path, drift_repo: Path, run_script, git) -> None:
    """1 件の `engines.node` が `>=22.6.0` で、期待値と異なる場合のテストです。終了コード 1 で終わり、期待値と実際の値を並べたメッセージと、許可リストの機構が存在しない旨を出力することを確認します。"""
    with allure.step("1 つだけ違う版の package.json を用意して hook を動かす"):
        _make_pkg(git, drift_repo, "assets/slidev", ">=22.6.0")
        _make_pkg(git, drift_repo, "assets/slidev/runtime", EXPECTED)
        result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)

    with allure.step("終了コード 1 と got の表記を確かめる"):
        assert result.returncode == 1
        out = result.stdout + result.stderr
        assert (
            f'plugins/pecot-visual/assets/slidev/package.json: expected "{EXPECTED}", got ">=22.6.0"'
            in out
        )
        assert "allow-list 機構はありません" in out


@allure.title("engines.node が存在しない package.json があると、理由を出力して失敗で終わる")
def test_missing_engines_fails(script_dir: Path, drift_repo: Path, run_script, git) -> None:
    """`package.json` に `engines` のキーが存在しない場合のテストです。終了コード 1 で終わり、`missing engines.node` を出力することを確認します。"""
    with allure.step("engines の無い package.json を用意して hook を動かす"):
        _make_pkg(git, drift_repo, "assets/slidev", "MISSING")
        result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)

    with allure.step("終了コード 1 と missing engines.node の表示を確かめる"):
        assert result.returncode == 1
        assert "missing engines.node" in (result.stdout + result.stderr)


@allure.title("2 件の package.json が違反していると、両方のパスを出力して失敗で終わる")
def test_two_violations_both_reported(script_dir: Path, drift_repo: Path, run_script, git) -> None:
    """2 件の `package.json` の `engines.node` が、どちらも期待値と異なる場合のテストです。終了コード 1 で終わり、2 件のパスをどちらも出力することを確認します。"""
    with allure.step("2 つの package.json を違う版にして hook を動かす"):
        _make_pkg(git, drift_repo, "assets/slidev", ">=22.6.0")
        _make_pkg(git, drift_repo, "assets/slidev/runtime", ">=20.0.0")
        result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)

    with allure.step("両方の違反が出力に出ることを確かめる"):
        assert result.returncode == 1
        out = result.stdout + result.stderr
        assert "plugins/pecot-visual/assets/slidev/package.json" in out
        assert "plugins/pecot-visual/assets/slidev/runtime/package.json" in out


@allure.title("node_modules の中の package.json は、違反していても対象にしない")
def test_node_modules_violation_ignored(
    script_dir: Path, drift_repo: Path, run_script, git
) -> None:
    """`node_modules` の中に、期待値と異なる `engines.node` の `package.json` がある場合のテストです。対象外のため、終了コード 0 で終わることを確認します。"""
    with allure.step("node_modules 配下に違う版の package.json を置いて hook を動かす"):
        _make_pkg(git, drift_repo, "assets/slidev", EXPECTED)
        nm = drift_repo / "plugins/pecot-visual/assets/slidev/node_modules/foo/package.json"
        nm.parent.mkdir(parents=True, exist_ok=True)
        nm.write_text(json.dumps({"name": "foo", "engines": {"node": ">=18"}}, indent=2) + "\n")
        git(drift_repo, "add", "-f", str(nm.relative_to(drift_repo)))
        result = run_script(script_dir / "check-engines-node-drift.sh", cwd=drift_repo)

    with allure.step("終了コード 0（対象外）を確かめる"):
        assert result.returncode == 0
