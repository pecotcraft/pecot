"""check-test-layers.py のテスト。一時の git のリポに project と層の表を置き、hook に渡して結果を見る。"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import allure
import pytest

_HOOK = Path(__file__).resolve().parents[1] / "pre-commit" / "check-test-layers.py"

_FILES = {
    "plugins/p/project.json": "{}",
    "plugins/p/cli/src/a.test.ts": "",
    "plugins/p/cli/tests/b.test.ts": "",
    "plugins/p/cli/tests/c.test.mjs": "",
    "plugins/p/cli/tests/fixtures/d.test.ts": "",
    "plugins/p/cli/tests/e2e/h.test.ts": "",
    "plugins/p/hooks/tests/e.bats": "",
    ".githooks/project.json": "{}",
    ".githooks/tests/test_f.py": "",
    ".githooks/tests/conftest.py": "",
    ".github/board-sync/handler.test.mjs": "",
}

_TABLES = {
    "plugins/p/test-layers.txt": (
        "# 層の表\nunit cli/\nintegration cli/tests/\ne2e cli/tests/e2e/\nintegration hooks/\n"
    ),
    ".githooks/test-layers.txt": "integration tests/\n",
}


def _check(tmp_path: Path, tables: dict[str, str]) -> subprocess.CompletedProcess[str]:
    with allure.step("一時の git のリポにファイルと層の表を置く"):
        for path, text in {**_FILES, **tables}.items():
            (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
            (tmp_path / path).write_text(text, encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
        subprocess.run(["git", "-C", str(tmp_path), "add", "."], check=True)
    with allure.step("hook を動かす"):
        return subprocess.run(
            [sys.executable, str(_HOOK), "--root", str(tmp_path)],
            capture_output=True,
            text=True,
            check=False,
        )


@allure.title("すべてのテストのファイルの層が表で決まると、hook は何も出さずに 0 で終わる")
def test_passes_when_every_test_file_has_a_layer(tmp_path: Path) -> None:
    """層の表がすべてのテストのファイルに当たる場合の、`check-test-layers.py` のテストです。fixture の中のテストのファイルも外側の表で層が決まり、テストでない補助と project に属さないファイルを見ずに、終了コード 0 で終わることを確認します。"""
    result = _check(tmp_path, _TABLES)
    with allure.step("終了コードと標準エラーを比べる"):
        assert (result.returncode, result.stderr) == (0, "")


@allure.title("{case}と、hook は {expected} を出して 1 で終わる")
@pytest.mark.parametrize(
    ("case", "tables", "expected"),
    [
        (
            "表の無い project がある",
            {"plugins/p/test-layers.txt": _TABLES["plugins/p/test-layers.txt"]},
            ".githooks/tests/test_f.py: 層が決まっていない",
        ),
        (
            "どの規則にも当たらないテストのファイルがある",
            {**_TABLES, "plugins/p/test-layers.txt": "unit cli/\n"},
            "plugins/p/hooks/tests/e.bats: 層が決まっていない",
        ),
        (
            "層の名前が誤っている",
            {**_TABLES, ".githooks/test-layers.txt": "Integration tests/\n"},
            ".githooks/test-layers.txt:1: 層 'Integration' は unit・integration・e2e のどれでもない",
        ),
        (
            "2 つに分かれない行がある",
            {**_TABLES, ".githooks/test-layers.txt": "integration tests/\nunit\n"},
            ".githooks/test-layers.txt:2: 「<層> <パス>」の 2 つに分かれていない",
        ),
        (
            "どのファイルにも勝たない規則がある",
            {**_TABLES, ".githooks/test-layers.txt": "integration tests/\nunit scripts/\n"},
            ".githooks/test-layers.txt:2: 'scripts/' に当たるテストのファイルが無い",
        ),
        (
            "テストのファイルにいちばん近い project.json の横に表が無い",
            {
                **_TABLES,
                "plugins/p/cli/tests/fixtures/sub/project.json": "{}",
                "plugins/p/cli/tests/fixtures/sub/g.test.ts": "",
            },
            "plugins/p/cli/tests/fixtures/sub/g.test.ts: 層が決まっていない",
        ),
        (
            "どの規則にも当たらない bats のファイルがある",
            {**_TABLES, "plugins/p/scripts/tests/h.bats": ""},
            "plugins/p/scripts/tests/h.bats: 層が決まっていない",
        ),
    ],
    ids=["no-table", "no-match", "bad-layer", "bad-line", "unused-rule", "nearest-project", "bats"],
)
def test_reports_problem_with_place(
    tmp_path: Path, case: str, tables: dict[str, str], expected: str
) -> None:
    """層の表に抜けや誤りがある場合の、`check-test-layers.py` のテストです。問題の場所と理由を 1 行で標準エラーに出力し、終了コード 1 で終わることを確認します。"""
    result = _check(tmp_path, tables)
    with allure.step("終了コードと標準エラーの行を比べる"):
        assert result.returncode == 1
        assert expected in result.stderr.splitlines()
