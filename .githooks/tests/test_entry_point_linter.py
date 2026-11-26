"""check-entry-point-logic.sh のユニットテスト（test_entry_point_linter.bats 移植）。"""

from __future__ import annotations

from pathlib import Path

import allure


@allure.title("正常なエントリポイントを渡すと、PASS を出力して成功で終わる")
def test_valid_entry_point_passes(script_dir: Path, tmp_path: Path, run_script) -> None:
    """`check-entry-point-logic.sh` に、`lib/` のスクリプトを呼ぶだけのエントリポイントを渡した場合のテストです。終了コード 0 で終わり、`PASS` を出力することを確認します。"""
    with allure.step("正常なエントリポイントを書き、check-entry-point-logic.sh を動かす"):
        test_file = tmp_path / "good-entry.sh"
        test_file.write_text(
            "#!/bin/bash\n"
            "# Good entry point\n"
            'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
            'LIB="$SCRIPT_DIR/lib"\n'
            'source "$LIB/core/config.sh"\n'
            "INPUT=$(cat)\n"
            '"$LIB/core/handler.sh"\n'
            "exit 0\n"
        )
        result = run_script(script_dir / "check-entry-point-logic.sh", str(test_file))

    with allure.step("終了コード 0 と PASS の表示を確かめる"):
        assert result.returncode == 0
        assert "PASS" in (result.stdout + result.stderr)


@allure.title("エントリポイントに if 文のロジックがあると、違反の案内を出力して失敗で終わる")
def test_logic_violation_shows_guidance(script_dir: Path, tmp_path: Path, run_script) -> None:
    """エントリポイントに `if` 文のロジックがある場合のテストです。終了コード 1 で終わり、`VIOLATION` と、ルールと修正方法の案内を出力することを確認します。"""
    with allure.step("ロジックを含むエントリポイントを書き、check-entry-point-logic.sh を動かす"):
        test_file = tmp_path / "bad-entry.sh"
        test_file.write_text(
            '#!/bin/bash\nif [ -f /tmp/test ]; then\n    echo "logic in entry point"\nfi\n'
        )
        result = run_script(script_dir / "check-entry-point-logic.sh", str(test_file))

    with allure.step("終了コード 1 と、ガイダンスの表示を確かめる"):
        assert result.returncode == 1
        out = result.stdout + result.stderr
        assert "VIOLATION" in out
        assert "ルール:" in out
        assert "修正方法:" in out
        assert "lib/ 配下のスクリプトに移動してください" in out


@allure.title("エントリポイントに for 文のロジックがあると、違反の理由を出力する")
def test_violation_shows_reason(script_dir: Path, tmp_path: Path, run_script) -> None:
    """エントリポイントに `for` 文のロジックがある場合のテストです。終了コード 1 で終わり、違反の理由として、ディスパッチャー層についての説明を出力することを確認します。"""
    with allure.step("for ループを含むエントリポイントを書き、check-entry-point-logic.sh を動かす"):
        test_file = tmp_path / "bad-entry2.sh"
        test_file.write_text('#!/bin/bash\nfor f in *.sh; do\n    echo "$f"\ndone\n')
        result = run_script(script_dir / "check-entry-point-logic.sh", str(test_file))

    with allure.step("終了コード 1 と、違反の理由の表示を確かめる"):
        assert result.returncode == 1
        out = result.stdout + result.stderr
        assert "理由:" in out
        assert "ディスパッチャー層" in out
