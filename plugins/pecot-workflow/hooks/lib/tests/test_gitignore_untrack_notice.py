"""gitignore-untrack-notice.sh のユニットテスト（test_gitignore_untrack_notice.bats 移植）。

.pecot/.gitignore が tracked な既存リポを検知して untrack 案内を出すことを検証する。
GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する（bats の env -u GIT_* 相当）。
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest


@pytest.fixture
def notice_script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "session-start"
        / "gitignore-untrack-notice.sh"
    )


@pytest.fixture
def no_config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """hooks-config.json 不在前提（既定値 true で有効）に固定する。"""
    path = tmp_path / "no-such-hooks-config.json"
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(path))
    return path


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )


def _run_notice(
    notice_script: Path,
    project_dir: Path,
    *,
    config_path: str | None = None,
    unset_config: bool = False,
) -> subprocess.CompletedProcess:
    """CLAUDE_PROJECT_DIR=<project_dir> で notice スクリプトを実行する。

    unset_config=True のとき PECOT_HOOKS_CONFIG_PATH を除去する（既定パス解決手段を踏む）。
    """
    env = {**os.environ, "CLAUDE_PROJECT_DIR": str(project_dir)}
    if unset_config:
        env.pop("PECOT_HOOKS_CONFIG_PATH", None)
    elif config_path is not None:
        env["PECOT_HOOKS_CONFIG_PATH"] = config_path
    return subprocess.run(
        [str(notice_script)],
        capture_output=True,
        text=True,
        timeout=25,
        env=env,
    )


def _make_tracked_repo(git_repo: Callable[..., Path]) -> Path:
    repo = git_repo("repo")
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / ".gitignore").write_text("/.gitignore\n")
    _git(repo, "add", "-f", ".pecot/.gitignore")
    _git(repo, "commit", "--quiet", "-m", "track gitignore")
    return repo


def test_tracked_repo_outputs_untrack_notice(notice_script, git_repo, no_config_path) -> None:
    repo = _make_tracked_repo(git_repo)
    result = _run_notice(notice_script, repo)
    assert result.returncode == 0
    assert "git rm --cached .pecot/.gitignore" in result.stdout


def test_untracked_repo_no_output(notice_script, git_repo, no_config_path) -> None:
    repo = git_repo("repo")
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / ".gitignore").write_text("/.gitignore\n")
    result = _run_notice(notice_script, repo)
    assert result.returncode == 0
    assert result.stdout == ""


def test_after_untrack_no_output_and_clean(notice_script, git_repo, no_config_path) -> None:
    repo = _make_tracked_repo(git_repo)
    _git(repo, "rm", "--cached", "--quiet", ".pecot/.gitignore")
    _git(repo, "commit", "--quiet", "-m", "untrack gitignore")

    # 既定パス解決手段を踏むため PECOT_HOOKS_CONFIG_PATH を除去して実行
    result = _run_notice(notice_script, repo, unset_config=True)
    assert result.returncode == 0
    assert result.stdout == ""

    # self-ignore（/.gitignore）により worktree が clean
    status = _git(repo, "status", "--porcelain")
    assert status.stdout == ""


def test_disabled_via_config_no_output(notice_script, git_repo, tmp_path) -> None:
    repo = _make_tracked_repo(git_repo)
    config = tmp_path / "hooks-config.json"
    config.write_text('{"gitignore-untrack-notice": false}')
    result = _run_notice(notice_script, repo, config_path=str(config))
    assert result.returncode == 0
    assert result.stdout == ""


def test_non_git_dir_no_output(notice_script, tmp_path, no_config_path) -> None:
    project_dir = tmp_path / "plain"
    (project_dir / ".pecot").mkdir(parents=True)
    (project_dir / ".pecot" / ".gitignore").write_text("/.gitignore\n")
    result = _run_notice(notice_script, project_dir)
    assert result.returncode == 0
    assert result.stdout == ""
