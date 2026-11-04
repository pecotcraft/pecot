"""pecot-gitignore-ensure.sh のユニットテスト（test_pecot_gitignore_ensure.bats からの移植）。

.pecot/.gitignore を repo root の .gitignore 設定に依存せず生成することを検証する。
GIT_* 隔離・test git repo 生成は conftest の fixture（_isolate_git_env / git_repo）が担保する。
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest


@pytest.fixture
def ensure_script(core_dir: Path) -> Path:
    return core_dir / "pecot-gitignore-ensure.sh"


def _run(
    script: Path,
    project_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> subprocess.CompletedProcess:
    """CLAUDE_PROJECT_DIR を project_dir に向けて ensure スクリプトを実行する。"""
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project_dir))
    return subprocess.run(
        ["bash", str(script)],
        capture_output=True,
        text=True,
        timeout=25,
    )


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_gitignore_generated_without_pecot_dir(
    ensure_script: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "proj"
    project.mkdir()

    result = _run(ensure_script, project, monkeypatch)
    assert result.returncode == 0
    assert (project / ".pecot" / ".gitignore").is_file()


def test_runtime_dirs_ignored(
    ensure_script: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "proj"
    project.mkdir()

    result = _run(ensure_script, project, monkeypatch)
    assert result.returncode == 0

    lines = (project / ".pecot" / ".gitignore").read_text().splitlines()
    assert "tmp/" in lines
    assert "state/" in lines
    # work は WT 側で symlink になるため trailing slash なし
    assert "work" in lines


def test_symlinked_work_is_ignored(
    ensure_script: Path,
    tmp_path: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo("repo")
    result = _run(ensure_script, repo, monkeypatch)
    assert result.returncode == 0

    # WT 側を再現: .pecot/work が main WT を指す symlink
    shared = tmp_path / "shared-work"
    shared.mkdir()
    (repo / ".pecot" / "work").symlink_to(shared)

    check = _git(repo, "check-ignore", ".pecot/work")
    assert check.returncode == 0
    assert ".pecot/work" in check.stdout.splitlines()


def test_existing_gitignore_overwritten_with_latest(
    ensure_script: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "proj"
    (project / ".pecot").mkdir(parents=True)
    (project / ".pecot" / ".gitignore").write_text("stale\n")

    result = _run(ensure_script, project, monkeypatch)
    assert result.returncode == 0

    lines = (project / ".pecot" / ".gitignore").read_text().splitlines()
    assert "stale" not in lines
    assert "tmp/" in lines


def test_lock_and_debug_ignored(
    ensure_script: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo("repo")
    # repo root の .gitignore に tmp/ パターンは無い前提

    result = _run(ensure_script, repo, monkeypatch)
    assert result.returncode == 0

    (repo / ".pecot" / "tmp" / "debug").mkdir(parents=True)
    (repo / ".pecot" / "state").mkdir(parents=True, exist_ok=True)
    (repo / ".pecot" / "tmp" / ".session-start-common.lock").touch()
    (repo / ".pecot" / "tmp" / "debug" / "plan-post-flow.log").touch()

    # check-ignore は 1 パスでも一致すれば exit 0 のため、3 パス全てが ignore 対象で
    # あることを出力行で個別に検証する。
    check = _git(
        repo,
        "check-ignore",
        ".pecot/tmp/.session-start-common.lock",
        ".pecot/tmp/debug/plan-post-flow.log",
        ".pecot/state",
    )
    assert check.returncode == 0
    out_lines = check.stdout.splitlines()
    assert ".pecot/tmp/.session-start-common.lock" in out_lines
    assert ".pecot/tmp/debug/plan-post-flow.log" in out_lines
    assert ".pecot/state" in out_lines


def test_self_ignore_line_present(
    ensure_script: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "proj"
    project.mkdir()

    result = _run(ensure_script, project, monkeypatch)
    assert result.returncode == 0

    lines = (project / ".pecot" / ".gitignore").read_text().splitlines()
    assert "/.gitignore" in lines


def test_gitignore_self_ignored_in_untracked_repo(
    ensure_script: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo("repo")
    result = _run(ensure_script, repo, monkeypatch)
    assert result.returncode == 0

    check = _git(repo, "check-ignore", ".pecot/.gitignore")
    assert check.returncode == 0
    assert ".pecot/.gitignore" in check.stdout.splitlines()


def test_tracked_repo_index_unchanged(
    ensure_script: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    """tracked リポで実行しても index が変化しない（untrack しない）。"""
    repo = git_repo("repo")

    # 旧内容の .pecot/.gitignore を commit して tracked 状態を再現
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / ".gitignore").write_text("stale\n")
    assert _git(repo, "add", "-f", ".pecot/.gitignore").returncode == 0
    assert _git(repo, "commit", "--quiet", "-m", "track old gitignore").returncode == 0

    before = _git(repo, "rev-parse", "HEAD").stdout.strip()

    result = _run(ensure_script, repo, monkeypatch)
    assert result.returncode == 0

    # tracked のまま（ls-files に残る）
    assert _git(repo, "ls-files", "--error-unmatch", "--", ".pecot/.gitignore").returncode == 0

    # HEAD（index コミット）が動いていない＝スクリプトは index を変異させていない
    after = _git(repo, "rev-parse", "HEAD").stdout.strip()
    assert before == after

    # staged な変更が無い（index と HEAD が一致）
    assert _git(repo, "diff", "--cached", "--quiet").returncode == 0
