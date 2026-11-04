"""session-start/issue-pending-cleanup.sh のユニットテスト。

team-flag-cleanup.sh から責務移設した issue-pending フラグの stale クリーンアップを
検証する。フラグ削除と、config 無効時の残存を確認する。
"""

from __future__ import annotations

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
        / "issue-pending-cleanup.sh"
    )


@pytest.fixture
def ctx(tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch):
    project = tmp_path / "project"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    hooks_config.write({"issue-pending-cleanup": True})
    return {
        "state_dir": state_dir,
        "issue_pending": state_dir / "issue-pending",
        "config": hooks_config,
    }


def _run(hook_script: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(hook_script)],
        input="",
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_issue_pending_deleted(ctx, hook_script):
    ctx["issue_pending"].write_text("w-quick\n")
    result = _run(hook_script)
    assert result.returncode == 0
    assert not ctx["issue_pending"].is_file()


def test_no_flag_no_error(ctx, hook_script):
    result = _run(hook_script)
    assert result.returncode == 0
    assert not ctx["issue_pending"].is_file()


def test_disabled_via_config_flag_remains(ctx, hook_script):
    ctx["config"].write({"issue-pending-cleanup": False})
    ctx["issue_pending"].write_text("w-ready\n")
    result = _run(hook_script)
    assert result.returncode == 0
    assert ctx["issue_pending"].is_file()


def test_config_missing_defaults_true_deletes_flag(ctx, hook_script, tmp_path, monkeypatch):
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(tmp_path / "nonexistent-hooks-config.json"))
    ctx["issue_pending"].write_text("w-quick\n")
    result = _run(hook_script)
    assert result.returncode == 0
    assert not ctx["issue_pending"].is_file()
