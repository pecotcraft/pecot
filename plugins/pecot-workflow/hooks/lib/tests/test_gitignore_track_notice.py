"""gitignore-track-notice.sh のユニットテスト。

.pecot/.gitignore の追跡の案内（未追跡 → 追跡を始める手順、定義の行の欠け → 直す手順）を検証する。
GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する。
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
        / "gitignore-track-notice.sh"
    )


@pytest.fixture
def definition(core_dir: Path) -> str:
    return subprocess.run(
        ["bash", str(core_dir / "pecot-gitignore-ensure.sh"), "--print"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


@pytest.fixture
def no_config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """hooks-config.json 不在前提（既定値 true で有効）に固定する。"""
    path = tmp_path / "no-such-hooks-config.json"
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(path))
    return path


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    )


def _run_notice(
    notice_script: Path, project_dir: Path, *, config_path: str | None = None
) -> subprocess.CompletedProcess:
    env = {**os.environ, "CLAUDE_PROJECT_DIR": str(project_dir)}
    if config_path is not None:
        env["PECOT_HOOKS_CONFIG_PATH"] = config_path
    return subprocess.run([str(notice_script)], capture_output=True, text=True, timeout=25, env=env)


def _repo_with_gitignore(git_repo: Callable[..., Path], content: str, *, tracked: bool) -> Path:
    repo = git_repo("repo")
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / ".gitignore").write_bytes(content.encode())
    if tracked:
        _git(repo, "add", "-f", ".pecot/.gitignore")
        _git(repo, "commit", "--quiet", "-m", "track gitignore")
    return repo


def test_untracked_outputs_track_notice(
    notice_script, git_repo, definition, no_config_path
) -> None:
    repo = _repo_with_gitignore(git_repo, definition, tracked=False)
    result = _run_notice(notice_script, repo)
    assert result.returncode == 0
    assert "git add -f .pecot/.gitignore" in result.stdout
    assert len(result.stdout.splitlines()) == 1


def test_tracked_missing_lines_outputs_fix_notice(
    notice_script, core_dir, git_repo, no_config_path
) -> None:
    repo = _repo_with_gitignore(git_repo, "*\n", tracked=True)
    result = _run_notice(notice_script, repo)
    assert result.returncode == 0
    ensure = core_dir / "pecot-gitignore-ensure.sh"
    assert f"{ensure} --print > .pecot/.gitignore" in result.stdout


def test_tracked_with_extra_lines_only_no_output(
    notice_script, git_repo, definition, no_config_path
) -> None:
    repo = _repo_with_gitignore(git_repo, definition + "/my-extra/\n", tracked=True)
    result = _run_notice(notice_script, repo)
    assert result.returncode == 0
    assert result.stdout == ""


def test_tracked_crlf_no_output(notice_script, git_repo, definition, no_config_path) -> None:
    repo = _repo_with_gitignore(git_repo, definition.replace("\n", "\r\n"), tracked=True)
    result = _run_notice(notice_script, repo)
    assert result.returncode == 0
    assert result.stdout == ""


def test_tracked_and_matching_no_output(
    notice_script, git_repo, definition, no_config_path
) -> None:
    repo = _repo_with_gitignore(git_repo, definition, tracked=True)
    result = _run_notice(notice_script, repo)
    assert result.returncode == 0
    assert result.stdout == ""


def test_missing_file_no_output(notice_script, git_repo, no_config_path) -> None:
    repo = git_repo("repo")
    result = _run_notice(notice_script, repo)
    assert result.returncode == 0
    assert result.stdout == ""


def test_disabled_via_config_no_output(notice_script, git_repo, definition, tmp_path) -> None:
    repo = _repo_with_gitignore(git_repo, definition, tracked=False)
    config = tmp_path / "hooks-config.json"
    config.write_text('{"gitignore-track-notice": false}')
    result = _run_notice(notice_script, repo, config_path=str(config))
    assert result.returncode == 0
    assert result.stdout == ""


def test_non_git_dir_no_output(notice_script, tmp_path, definition, no_config_path) -> None:
    project_dir = tmp_path / "plain"
    (project_dir / ".pecot").mkdir(parents=True)
    (project_dir / ".pecot" / ".gitignore").write_text(definition)
    result = _run_notice(notice_script, project_dir)
    assert result.returncode == 0
    assert result.stdout == ""
