"""session-start/create-slash-cleanup.sh のユニットテスト。

前セッションの未消費フラグを、セッション開始時に削除することを検証する。
対象のフラグは、pr-create-slash-pending / issue-create-slash-pending。
config 無効時の残存も、あわせて検証する。
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
        / "create-slash-cleanup.sh"
    )


@pytest.fixture
def ctx(tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch):
    project = tmp_path / "project"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    hooks_config.write({"create-slash-cleanup": True})
    return {
        "pr_flag": state_dir / "pr-create-slash-pending",
        "issue_flag": state_dir / "issue-create-slash-pending",
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


def test_both_flags_deleted(ctx, hook_script):
    ctx["pr_flag"].touch()
    ctx["issue_flag"].write_text("w-quick\n")
    result = _run(hook_script)
    assert result.returncode == 0
    assert not ctx["pr_flag"].is_file()
    assert not ctx["issue_flag"].is_file()


def test_no_flag_no_error(ctx, hook_script):
    result = _run(hook_script)
    assert result.returncode == 0
    assert not ctx["pr_flag"].is_file()
    assert not ctx["issue_flag"].is_file()


def test_disabled_via_config_flags_remain(ctx, hook_script):
    ctx["config"].write({"create-slash-cleanup": False})
    ctx["pr_flag"].touch()
    ctx["issue_flag"].write_text("w-quick\n")
    result = _run(hook_script)
    assert result.returncode == 0
    assert ctx["pr_flag"].is_file()
    assert ctx["issue_flag"].is_file()


def test_config_missing_defaults_true_deletes_flags(ctx, hook_script, tmp_path, monkeypatch):
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(tmp_path / "nonexistent-hooks-config.json"))
    ctx["pr_flag"].touch()
    ctx["issue_flag"].write_text("w-quick\n")
    result = _run(hook_script)
    assert result.returncode == 0
    assert not ctx["pr_flag"].is_file()
    assert not ctx["issue_flag"].is_file()
