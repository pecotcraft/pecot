"""session-start/git-sync.sh のユニットテスト。

upstream の無いリポで git pull が失敗しても、git のエラーは stderr だけに出る。
hook の stdout（SessionStart ではモデルの文脈に入る）には入り込まないことを検証する。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def hook_script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "session-start"
        / "git-sync.sh"
    )


@pytest.fixture
def repo(tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch) -> Path:
    project = tmp_path / "project"
    project.mkdir()
    git_env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.com",
    }
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=project, check=True)
    subprocess.run(
        ["git", "commit", "-q", "--allow-empty", "-m", "init"],
        cwd=project,
        check=True,
        env=git_env,
    )
    # uvx の有無に依存しないよう、スタブを PATH 先頭に置く。
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "uvx"
    stub.write_text("#!/bin/sh\nexit 0\n")
    stub.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    hooks_config.write({"git-sync": True})
    return project


def _run(hook_script: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(hook_script)],
        input="",
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_pull_failure_without_upstream_keeps_stdout_empty(repo, hook_script):
    result = _run(hook_script)
    assert result.returncode == 0
    assert result.stdout == ""
    assert "tracking information" in result.stderr
