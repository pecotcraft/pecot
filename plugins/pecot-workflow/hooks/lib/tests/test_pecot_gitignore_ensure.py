"""pecot-gitignore-ensure.sh のユニットテスト。

中身は許可の一覧で、実 git リポで、除外されるパスと戻るパスを確かめる。
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
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project_dir))
    return subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=25)


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=25
    )


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x\n")


def _tracked(repo: Path) -> bool:
    return _git(repo, "ls-files", "--error-unmatch", "--", ".pecot/.gitignore").returncode == 0


def test_print_outputs_definition_without_writing(
    ensure_script: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    result = subprocess.run(
        ["bash", str(ensure_script), "--print"], capture_output=True, text=True, timeout=25
    )
    assert result.returncode == 0
    lines = [ln for ln in result.stdout.splitlines() if ln and not ln.startswith("#")]
    assert lines == [
        "*",
        "!/config/",
        "/config/*",
        "!/config/worktree-config.json",
        "!/config/.worktreeignore",
        "!/config/projects/",
        "/config/projects/*",
        "!/config/projects/*.json",
    ]
    assert not (tmp_path / ".pecot").exists()


def test_written_without_pecot_dir_and_matches_print(
    ensure_script: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    project = tmp_path / "proj"
    project.mkdir()

    assert _run(ensure_script, project, monkeypatch).returncode == 0
    printed = subprocess.run(
        ["bash", str(ensure_script), "--print"], capture_output=True, text=True, timeout=25
    ).stdout
    assert (project / ".pecot" / ".gitignore").read_text() == printed


def test_allowlist_ignores_generated_and_keeps_config(
    ensure_script: Path,
    tmp_path: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo("repo")
    assert _run(ensure_script, repo, monkeypatch).returncode == 0
    pecot = repo / ".pecot"

    ignored = [
        "tmp/debug/plan-post-flow.log",
        "tmp/.session-start-common.lock",
        "state/x.json",
        "README.md",
        "CHANGELOG.md",
        "config/hooks-config.json",
        "config/hooks-config.json.sample",
        "config/hosts.json",
        "config/.env",
        "config/projects/.active",
        ".gitignore",
    ]
    kept = [
        "config/worktree-config.json",
        "config/.worktreeignore",
        "config/projects/x.json",
    ]
    for rel in ignored + kept:
        if rel != ".gitignore":
            _touch(pecot / rel)
    # WT 側を再現: work が共有先を指す symlink
    shared = tmp_path / "shared-work"
    shared.mkdir()
    (pecot / "work").symlink_to(shared)
    ignored.append("work")

    for rel in ignored:
        check = _git(repo, "check-ignore", f".pecot/{rel}")
        assert check.returncode == 0, f"{rel} は ignore されるはず"
    for rel in kept:
        check = _git(repo, "check-ignore", f".pecot/{rel}")
        assert check.returncode == 1, f"{rel} は ignore されないはず"


def test_tracked_gitignore_shows_diff_as_modified(
    ensure_script: Path, git_repo: Callable[..., Path], monkeypatch: pytest.MonkeyPatch
):
    repo = git_repo("repo")
    assert _run(ensure_script, repo, monkeypatch).returncode == 0
    assert _git(repo, "add", "-f", ".pecot/.gitignore").returncode == 0
    assert _git(repo, "commit", "--quiet", "-m", "track").returncode == 0

    (repo / ".pecot" / ".gitignore").write_text("*\n# 変更\n")
    status = _git(repo, "status", "--porcelain", "--", ".pecot/.gitignore")
    assert status.stdout.startswith(" M ")


def test_existing_untracked_old_content_overwritten(
    ensure_script: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo("repo")
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / ".gitignore").write_text("state/\n/.gitignore\n")

    assert _run(ensure_script, repo, monkeypatch).returncode == 0
    lines = (repo / ".pecot" / ".gitignore").read_text().splitlines()
    assert "state/" not in lines
    assert "/.gitignore" not in lines
    assert "!/config/" in lines


def test_non_git_dir_existing_content_overwritten(
    ensure_script: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    project = tmp_path / "plain"
    (project / ".pecot").mkdir(parents=True)
    (project / ".pecot" / ".gitignore").write_text("stale\n")

    assert _run(ensure_script, project, monkeypatch).returncode == 0
    assert "stale" not in (project / ".pecot" / ".gitignore").read_text().splitlines()


def test_tracked_gitignore_not_touched(
    ensure_script: Path, git_repo: Callable[..., Path], monkeypatch: pytest.MonkeyPatch
):
    repo = git_repo("repo")
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / ".gitignore").write_text("stale\n")
    assert _git(repo, "add", "-f", ".pecot/.gitignore").returncode == 0
    assert _git(repo, "commit", "--quiet", "-m", "track old").returncode == 0
    assert _tracked(repo)

    assert _run(ensure_script, repo, monkeypatch).returncode == 0
    assert (repo / ".pecot" / ".gitignore").read_text() == "stale\n"
    assert _git(repo, "status", "--porcelain").stdout == ""
