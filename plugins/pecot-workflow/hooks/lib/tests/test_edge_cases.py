"""エントリーポイントのエッジケーステスト（test_edge_cases.bats 移植）。

set -e がないエントリーポイントで、スクリプト不在・権限なし時の動作を検証する。
  - 存在しないコマンド → exit 127
  - 権限なしコマンド → exit 126
  - set -e なしのため各行の失敗は無視され、最後の行の exit code がスクリプト全体の終了コード
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


def _make_entry(entry_dir: Path, lines: list[str]) -> Path:
    """エントリーポイントスクリプトを生成する（bats _create_entry_script 相当）。"""
    entry = entry_dir / "entry.sh"
    body = "#!/bin/bash\n" + "\n".join(lines) + "\n"
    entry.write_text(body)
    entry.chmod(0o755)
    return entry


def _make_dummy(path: Path, message: str) -> None:
    path.write_text(f'#!/bin/bash\necho "{message}"\n')
    path.chmod(0o755)


def _run(entry: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(entry)],
        capture_output=True,
        text=True,
        timeout=25,
    )


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    entry_dir = tmp_path / "entry"
    scripts_dir = tmp_path / "scripts"
    entry_dir.mkdir(parents=True)
    scripts_dir.mkdir(parents=True)
    return entry_dir, scripts_dir


# (a) ロジックスクリプト不在時の動作


def test_nonexistent_script_exit_127(dirs) -> None:
    entry_dir, scripts_dir = dirs
    entry = _make_entry(entry_dir, [f'"{scripts_dir}/nonexistent.sh"'])
    result = _run(entry)
    assert result.returncode == 127
    # stderr にスクリプトパスを含むエラーメッセージが出る（combined で確認）
    assert "nonexistent.sh" in result.stdout + result.stderr


def test_nonexistent_then_valid_exit_0(dirs) -> None:
    entry_dir, scripts_dir = dirs
    _make_dummy(scripts_dir / "valid.sh", "valid-output")
    entry = _make_entry(
        entry_dir,
        [f'"{scripts_dir}/nonexistent.sh"', f'"{scripts_dir}/valid.sh"'],
    )
    result = _run(entry)
    assert result.returncode == 0
    assert "valid-output" in result.stdout + result.stderr


def test_all_nonexistent_exit_127(dirs) -> None:
    entry_dir, scripts_dir = dirs
    entry = _make_entry(
        entry_dir,
        [
            f'"{scripts_dir}/missing1.sh"',
            f'"{scripts_dir}/missing2.sh"',
            f'"{scripts_dir}/missing3.sh"',
        ],
    )
    result = _run(entry)
    assert result.returncode == 127
    combined = result.stdout + result.stderr
    assert "missing1.sh" in combined
    assert "missing2.sh" in combined
    assert "missing3.sh" in combined


# (b) 実行権限なし時の動作


def test_no_permission_script_exit_126(dirs) -> None:
    entry_dir, scripts_dir = dirs
    no_perm = scripts_dir / "no_perm.sh"
    no_perm.write_text('#!/bin/bash\necho "should-not-appear"\n')
    no_perm.chmod(0o644)
    entry = _make_entry(entry_dir, [f'"{no_perm}"'])
    result = _run(entry)
    assert result.returncode == 126
    combined = result.stdout + result.stderr
    assert "no_perm.sh" in combined
    assert "should-not-appear" not in combined


def test_no_permission_then_valid_exit_0(dirs) -> None:
    entry_dir, scripts_dir = dirs
    no_perm = scripts_dir / "no_perm.sh"
    no_perm.write_text('#!/bin/bash\necho "should-not-appear"\n')
    no_perm.chmod(0o644)
    _make_dummy(scripts_dir / "valid_after.sh", "after-output")
    entry = _make_entry(entry_dir, [f'"{no_perm}"', f'"{scripts_dir}/valid_after.sh"'])
    result = _run(entry)
    assert result.returncode == 0
    assert "after-output" in result.stdout + result.stderr
