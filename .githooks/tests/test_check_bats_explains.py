"""check-bats-explains.py のテスト。一時ディレクトリに .bats を書き、hook に渡して結果を見る。"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import allure
import pytest

_HOOK = Path(__file__).resolve().parents[1] / "pre-commit" / "check-bats-explains.py"


def _check(tmp_path: Path, body: str) -> subprocess.CompletedProcess[str]:
    target = tmp_path / "sample.bats"
    target.write_text("setup() {\n    bats_load_library pecot-bats\n}\n\n" + body, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(_HOOK), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )


@allure.title("本体の先頭で説明の文字列を渡して explains を呼ぶ @test は止めない")
@pytest.mark.parametrize(
    "body",
    [
        '@test "題です" {\n    explains "説明です。"\n    true\n}\n',
        "@test '題です' {\n    explains '説明です。'\n    true\n}\n",
        '@test "題です" {\n    # 前置きのコメント\n    explains "説明です。"\n}\n',
        'check_one() {\n    explains "動的なテストの説明です。"\n    [ -n "$1" ]\n}\n'
        'bats_test_function --description "動的な題" -- check_one a\n',
        'function check_two {\n    explains "動的なテストの説明です。"\n}\n'
        "bats_test_function --tags a -- check_two\n",
        "helper() {\n    true\n}\n",
    ],
    ids=[
        "double-quote",
        "single-quote",
        "comment-before",
        "dynamic",
        "dynamic-function",
        "no-test",
    ],
)
def test_passes_when_explains_comes_first(tmp_path: Path, body: str) -> None:
    """bats のテストのファイルを hook に渡すテストです。どの `@test` と `bats_test_function` の関数も本体の先頭で `explains` を呼ぶ場合に、終了コード 0 で終わり、標準エラーに何も出力しないことを確認します。"""
    with allure.step("hook を動かす"):
        result = _check(tmp_path, body)
    with allure.step("終了コードと標準エラーを比べる"):
        assert (result.returncode, result.stderr) == (0, "")


@allure.title("{reason}@test を、場所と理由を添えて止める")
@pytest.mark.parametrize(
    ("body", "reason", "message"),
    [
        (
            '@test "題です" {\n    true\n}\n',
            "explains の無い",
            "本体の最初のコマンドが explains（説明）でない",
        ),
        (
            '@test "題です" {\n    run true\n    explains "説明です。"\n}\n',
            "explains が先頭でない",
            "本体の最初のコマンドが explains（説明）でない",
        ),
        (
            '@test "題です" {\n}\n',
            "本体が空の",
            "本体が空で、explains（説明）が無い",
        ),
        (
            '@test "題です" {\n    explains ""\n}\n',
            "空の説明を渡す",
            "explains に、1 行で書いた空でない文字列のリテラルを渡していない",
        ),
        (
            '@test "題です" {\n    explains "$DESCRIPTION"\n}\n',
            "変数で説明を渡す",
            "explains に、1 行で書いた空でない文字列のリテラルを渡していない",
        ),
        (
            '@test "題です" {\n    explains "1 行目です。\n2 行目です。"\n}\n',
            "説明が改行を含む",
            "explains に、1 行で書いた空でない文字列のリテラルを渡していない",
        ),
    ],
    ids=["missing", "not-first", "empty-body", "empty", "variable", "newline"],
)
def test_reports_test_without_explains(
    tmp_path: Path, body: str, reason: str, message: str
) -> None:
    """説明の付け方が決まりに合わない `@test` を hook に渡すテストです。終了コード 1 で終わり、`ファイル:行: 題: 理由` の形の行と、規約のファイルへの案内を出力することを確認します。"""
    with allure.step("hook を動かす"):
        result = _check(tmp_path, body)
    with allure.step("終了コードと、場所と理由の行を比べる"):
        assert result.returncode == 1
        assert result.stderr.splitlines()[0] == f"{tmp_path / 'sample.bats'}:5: 題です: {message}"
        assert ".claude/rules/test-conventions.md" in result.stderr


@allure.title("bats_test_function の関数が explains で始まらないと、関数名を添えて止める")
@pytest.mark.parametrize(
    ("body", "message"),
    [
        (
            'check_one() {\n    true\n}\nbats_test_function --description "題" -- check_one\n',
            "本体の最初のコマンドが explains（説明）でない",
        ),
        (
            'bats_test_function --description "題" -- check_one\n',
            "bats_test_function の関数の定義が無い",
        ),
    ],
    ids=["no-explains", "no-definition"],
)
def test_reports_dynamic_test_without_explains(tmp_path: Path, body: str, message: str) -> None:
    """`bats_test_function` で作るテストを hook に渡すテストです。呼ぶ関数の本体が `explains` で始まらない場合と、関数の定義が無い場合に、関数名と理由を添えて終了コード 1 で止めることを確認します。"""
    with allure.step("hook を動かす"):
        result = _check(tmp_path, body)
    with allure.step("終了コードと理由の行を比べる"):
        assert result.returncode == 1
        assert result.stderr.splitlines()[0].endswith(f": check_one: {message}")
