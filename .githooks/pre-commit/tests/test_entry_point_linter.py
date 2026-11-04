"""check-entry-point-logic.sh のユニットテスト（test_entry_point_linter.bats 移植）。"""

from __future__ import annotations

from pathlib import Path


def test_valid_entry_point_passes(script_dir: Path, tmp_path: Path, run_script) -> None:
    """正常なエントリポイントは PASS。"""
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
    assert result.returncode == 0
    assert "PASS" in (result.stdout + result.stderr)


def test_logic_violation_shows_guidance(script_dir: Path, tmp_path: Path, run_script) -> None:
    """ロジック違反時にガイダンスを表示。"""
    test_file = tmp_path / "bad-entry.sh"
    test_file.write_text(
        '#!/bin/bash\nif [ -f /tmp/test ]; then\n    echo "logic in entry point"\nfi\n'
    )
    result = run_script(script_dir / "check-entry-point-logic.sh", str(test_file))
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "VIOLATION" in out
    assert "ルール:" in out
    assert "修正方法:" in out
    assert "lib/ 配下のスクリプトに移動してください" in out


def test_violation_shows_reason(script_dir: Path, tmp_path: Path, run_script) -> None:
    """違反時に理由を表示。"""
    test_file = tmp_path / "bad-entry2.sh"
    test_file.write_text('#!/bin/bash\nfor f in *.sh; do\n    echo "$f"\ndone\n')
    result = run_script(script_dir / "check-entry-point-logic.sh", str(test_file))
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "理由:" in out
    assert "ディスパッチャー層" in out
