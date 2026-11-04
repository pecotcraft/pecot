"""post-tool-use/pecot-skill-reminder.sh のユニットテスト
（test_post_tool_use_pecot_skill_reminder.bats 移植）。

主に issue-pending フラグ作成の検証。pecot-w:w-quick / pecot-w:w-ready 起動でフラグが
作成され（中身がスキル名）、対象外スキルでは作成されないことを検証する。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "post-tool-use"
        / "pecot-skill-reminder.sh"
    )


@pytest.fixture
def flag(tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch) -> Path:
    project = tmp_path / "project"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    hooks_config.write({"pecot-skill-reminder": True})
    return state_dir / "issue-pending"


# サブスクリプトは stdin の JSON を読まず、PECOT_HOOK_*（hook-input.sh が export）だけを読む。
# そのため、エントリの project-root.sh と同じく hook-input.sh を source してから、対象を起動する。
_SOURCE_HOOK_INPUT = (
    'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"'
)


def _run(script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", _SOURCE_HOOK_INPUT, "_", str(script), stdin],
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_a_quick_creates_flag_with_content(flag, script):
    result = _run(script, '{"tool_input":{"skill":"pecot-w:w-quick"}}')
    assert result.returncode == 0
    assert flag.is_file()
    assert flag.read_text().strip() == "w-quick"


def test_a_ready_creates_flag_with_content(flag, script):
    result = _run(script, '{"tool_input":{"skill":"pecot-w:w-ready"}}')
    assert result.returncode == 0
    assert flag.is_file()
    assert flag.read_text().strip() == "w-ready"


def test_a_task_no_flag(flag, script):
    result = _run(script, '{"tool_input":{"skill":"pecot-w:w-task"}}')
    assert result.returncode == 0
    assert not flag.is_file()


def test_unrelated_skill_no_flag(flag, script):
    result = _run(script, '{"tool_input":{"skill":"some-other-skill"}}')
    assert result.returncode == 0
    assert not flag.is_file()


def test_quick_then_ready_overwrites_content(flag, script):
    _run(script, '{"tool_input":{"skill":"pecot-w:w-quick"}}')
    assert flag.read_text().strip() == "w-quick"

    _run(script, '{"tool_input":{"skill":"pecot-w:w-ready"}}')
    assert flag.read_text().strip() == "w-ready"


def test_a_quick_keeps_reminder_output(flag, script):
    result = _run(script, '{"tool_input":{"skill":"pecot-w:w-quick"}}')
    assert result.returncode == 0
    assert "pecot-workflowスキル起動" in result.stdout
