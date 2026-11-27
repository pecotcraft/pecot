"""check-pytest-titles.py のテスト。一時ディレクトリに test_*.py を書き、hook に渡して結果を見る。"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import allure
import pytest

_HOOK = Path(__file__).resolve().parents[1] / "pre-commit" / "check-pytest-titles.py"

_TITLED = '@allure.title("題です")\n'
_QUOTES = '"' * 3


def _check(tmp_path: Path, body: str) -> subprocess.CompletedProcess[str]:
    target = tmp_path / "test_sample.py"
    target.write_text("import allure\n\n\n" + body, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(_HOOK), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )


@allure.title("題と 1 段落の docstring を持つテストは止めない")
@pytest.mark.parametrize(
    "body",
    [
        _TITLED + 'def test_a() -> None:\n    """1 行の説明です。"""\n',
        _TITLED
        + 'def test_a() -> None:\n    """1 行目の説明です。\n    続けて書いた 2 行目です。\n    """\n',
        _TITLED + 'async def test_a() -> None:\n    """非同期のテストの説明です。"""\n',
        "class TestGroup:\n    "
        + _TITLED
        + '    def test_a(self) -> None:\n        """クラスの中のテストの説明です。"""\n',
        '@allure.title("値 {value} の題です")\n@pytest.mark.parametrize("value", [1])\n'
        'def test_a(value: int) -> None:\n    """表で回すテストの説明です。"""\n',
        "def helper() -> None:\n    pass\n\n\nclass Helper:\n    def test_a(self) -> None:\n        pass\n",
    ],
    ids=["one-line", "multi-line", "async", "class", "parametrize", "not-a-test"],
)
def test_passes_when_title_and_docstring_exist(tmp_path: Path, body: str) -> None:
    """題と説明がそろったテスト関数や、テストではない関数を hook に渡すテストです。どの場合も、終了コード 0 で終わり、標準エラーに何も出力しないことを確認します。"""
    with allure.step("hook を動かす"):
        result = _check(tmp_path, body)
    with allure.step("終了コードと標準エラーを比べる"):
        assert (result.returncode, result.stderr) == (0, "")


@allure.title("{reason}テストを、場所と理由を添えて止める")
@pytest.mark.parametrize(
    ("body", "reason", "message"),
    [
        (
            'def test_a() -> None:\n    """説明です。"""\n',
            "題の無い",
            "文字列を渡す @allure.title（題）が無い",
        ),
        (
            '@allure.title("")\ndef test_a() -> None:\n    """説明です。"""\n',
            "空の題の",
            "文字列を渡す @allure.title（題）が無い",
        ),
        (
            '@allure.title(TITLE)\ndef test_a() -> None:\n    """説明です。"""\n',
            "変数で渡した題の",
            "文字列を渡す @allure.title（題）が無い",
        ),
        (
            _TITLED + "def test_a() -> None:\n    pass\n",
            "docstring の無い",
            "docstring（説明）が無い",
        ),
        (
            _TITLED
            + f"def test_a() -> None:\n    {_QUOTES}\n    改行で始まる説明です。\n    {_QUOTES}\n",
            "docstring が改行で始まる",
            "docstring が 1 行目から始まっていない",
        ),
        (
            _TITLED
            + f"def test_a() -> None:\n    {_QUOTES}1 段落目です。\n\n    2 段落目です。\n    {_QUOTES}\n",
            "docstring に空行がある",
            "docstring に空行がある（1 段落で書く）",
        ),
    ],
    ids=[
        "no-title",
        "empty-title",
        "variable-title",
        "no-docstring",
        "leading-newline",
        "blank-line",
    ],
)
def test_reports_missing_title_or_docstring(
    tmp_path: Path, body: str, reason: str, message: str
) -> None:
    """題か説明が欠けているテスト関数を hook に渡すテストです。終了コード 1 で終わり、`ファイル:行: 関数名: 理由` の形の行と、規約のファイルへの案内を出力することを確認します。"""
    with allure.step("hook を動かす"):
        result = _check(tmp_path, body)
    with allure.step("終了コードと、場所と理由の行を比べる"):
        first = result.stderr.splitlines()[0]
        assert result.returncode == 1
        assert first.startswith(f"{tmp_path / 'test_sample.py'}:")
        assert first.endswith(f": test_a: {message}")
        assert ".claude/rules/test-conventions.md" in result.stderr


@allure.title("題と説明の両方が無いテストは、2 つの理由を 2 行で出す")
def test_reports_each_problem_on_its_own_line(tmp_path: Path) -> None:
    """題と docstring の両方が欠けているテスト関数を hook に渡すテストです。題の欠けと説明の欠けを、この順に 1 行ずつ出力することを確認します。"""
    with allure.step("hook を動かす"):
        result = _check(tmp_path, "def test_a() -> None:\n    pass\n")
    with allure.step("理由の行を順に比べる"):
        lines = [line for line in result.stderr.splitlines() if ": test_a: " in line]
        assert [line.split(": test_a: ")[1] for line in lines] == [
            "文字列を渡す @allure.title（題）が無い",
            "docstring（説明）が無い",
        ]
