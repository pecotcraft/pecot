"""pecot-state-guard.sh のユニットテスト（test_pecot_state_guard.bats 移植）。

.pecot 配下への書き込みガード（gitignore-before-write 規約）の単一実装を検証する。
pecot_state_dir_ensure を source 経由で呼び、終了コードと副作用（.gitignore 生成・
ディレクトリ作成）を観測する。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


def _run_ensure(
    guard_script: Path,
    target_dir: str,
    *,
    unset_project_dir: bool = False,
) -> subprocess.CompletedProcess:
    """source guard && pecot_state_dir_ensure <dir> を実行する。

    unset_project_dir=True のとき CLAUDE_PROJECT_DIR を unset してから呼ぶ。
    GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する。
    """
    prefix = "unset CLAUDE_PROJECT_DIR; " if unset_project_dir else ""
    return subprocess.run(
        [
            "bash",
            "-c",
            f'{prefix}source "$1"; pecot_state_dir_ensure "$2"',
            "_",
            str(guard_script),
            target_dir,
        ],
        capture_output=True,
        text=True,
        timeout=25,
    )


@pytest.fixture
def guard_script(core_dir: Path) -> Path:
    return core_dir / "pecot-state-guard.sh"


@pytest.fixture
def pecot_dir(claude_project_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """conftest の claude_project_dir は .pecot を作成済みのため、ガード本来の
    「.pecot 不在」ケースを再現できるよう一旦削除して空の project を返す。"""
    pecot = claude_project_dir / ".pecot"
    if pecot.exists():
        for child in sorted(pecot.iterdir(), reverse=True):
            child.unlink()
        pecot.rmdir()
    return pecot


# .pecot 不在: return 1・.pecot を新規作成しない


def test_pecot_absent_returns_1_no_create(guard_script: Path, pecot_dir: Path) -> None:
    result = _run_ensure(guard_script, str(pecot_dir / "state"))
    assert result.returncode != 0
    assert not pecot_dir.is_dir()


# .pecot あり・.gitignore 不在: .gitignore 生成後に mkdir される


def test_gitignore_absent_generates_then_mkdir(guard_script: Path, pecot_dir: Path) -> None:
    pecot_dir.mkdir(parents=True)
    assert not (pecot_dir / ".gitignore").is_file()

    result = _run_ensure(guard_script, str(pecot_dir / "state"))
    assert result.returncode == 0

    gitignore = pecot_dir / ".gitignore"
    assert gitignore.is_file()
    assert (pecot_dir / "state").is_dir()
    # pecot-gitignore-ensure.sh の生成内容（許可の一覧）が含まれる
    assert "*" in gitignore.read_text().splitlines()


# .pecot あり・.gitignore あり: 既存 .gitignore の内容を変更しない


def test_existing_gitignore_unchanged(guard_script: Path, pecot_dir: Path) -> None:
    pecot_dir.mkdir(parents=True)
    (pecot_dir / ".gitignore").write_text("sentinel-existing-content\n")

    result = _run_ensure(guard_script, str(pecot_dir / "state"))
    assert result.returncode == 0

    assert (pecot_dir / ".gitignore").read_text() == "sentinel-existing-content\n"
    assert (pecot_dir / "state").is_dir()


# 深い dir 引数（tmp/debug）でも動作する


def test_deep_dir_argument_created(guard_script: Path, pecot_dir: Path) -> None:
    pecot_dir.mkdir(parents=True)
    (pecot_dir / ".gitignore").write_text("x\n")

    result = _run_ensure(guard_script, str(pecot_dir / "tmp" / "debug"))
    assert result.returncode == 0
    assert (pecot_dir / "tmp" / "debug").is_dir()


# CLAUDE_PROJECT_DIR 未設定: return 1


def test_project_dir_unset_returns_1(
    guard_script: Path,
    tmp_path: Path,
    claude_project_dir,  # noqa: ARG001 — fixture 経由で .pecot 隔離するが本ケースは unset を別途指定
) -> None:
    target = tmp_path / "should-not-be-created" / "state"
    result = _run_ensure(guard_script, str(target), unset_project_dir=True)
    assert result.returncode != 0
    assert not target.parent.is_dir()
