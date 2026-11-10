"""pre-tool-use/pecot-issue-pending-reminder.sh のユニットテスト。
（test_pre_tool_use_pecot_issue_pending_reminder.bats 移植）。

issue-pending フラグ（w-quick / w-ready / 未知値）と tool_name の組み合わせを検証する。
検証するのは、リマインダーの出し分け。
案内文は、`pecot issue quick` / `issue create` のコマンドを示す。
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
        / "pre-tool-use"
        / "pecot-issue-pending-reminder.sh"
    )


@pytest.fixture
def ctx(tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch):
    project = tmp_path / "project"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    hooks_config.write({"pecot-issue-pending-reminder": True})
    return {
        "flag": state_dir / "issue-pending",
        "config": hooks_config,
    }


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


def test_no_flag_no_output(ctx, script):
    result = _run(script, '{"tool_name":"Edit","tool_input":{}}')
    assert result.returncode == 0
    assert result.stdout == ""


def test_quick_flag_edit_shows_quick_reminder(ctx, script):
    ctx["flag"].write_text("w-quick\n")
    result = _run(script, '{"tool_name":"Edit","tool_input":{}}')
    assert result.returncode == 0
    assert "warning: Issue filing is not complete" in result.stdout
    assert "pecot issue quick" in result.stdout
    assert "PreToolUse" in result.stdout


def test_ready_flag_enter_plan_mode_shows_ready_reminder(ctx, script):
    ctx["flag"].write_text("w-ready\n")
    result = _run(script, '{"tool_name":"EnterPlanMode","tool_input":{}}')
    assert result.returncode == 0
    assert "warning: Subtask Issue" in result.stdout
    assert "pecot issue create --prepare" in result.stdout


def test_flag_bash_git_checkout_shows_reminder(ctx, script):
    ctx["flag"].write_text("w-quick\n")
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"git checkout feat/foo"}}',
    )
    assert result.returncode == 0
    assert "warning: Issue filing is not complete" in result.stdout


def test_flag_bash_git_switch_shows_reminder(ctx, script):
    ctx["flag"].write_text("w-quick\n")
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"git switch feat/foo"}}',
    )
    assert result.returncode == 0
    assert "warning: Issue filing is not complete" in result.stdout


def test_flag_bash_unrelated_no_output(ctx, script):
    ctx["flag"].write_text("w-quick\n")
    result = _run(script, '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}')
    assert result.returncode == 0
    assert result.stdout == ""


def test_flag_read_no_output(ctx, script):
    ctx["flag"].write_text("w-quick\n")
    result = _run(script, '{"tool_name":"Read","tool_input":{}}')
    assert result.returncode == 0
    assert result.stdout == ""


def test_flag_write_shows_reminder(ctx, script):
    ctx["flag"].write_text("w-ready\n")
    result = _run(script, '{"tool_name":"Write","tool_input":{}}')
    assert result.returncode == 0
    assert "Issue" in result.stdout


def test_unknown_flag_value_fallback_message(ctx, script):
    ctx["flag"].write_text("w-unknown\n")
    result = _run(script, '{"tool_name":"Edit","tool_input":{}}')
    assert result.returncode == 0
    assert "warning: Issue filing is not complete" in result.stdout
    assert "pecot issue quick" in result.stdout
    assert "pecot issue create" in result.stdout


def test_flag_multiedit_shows_reminder(ctx, script):
    ctx["flag"].write_text("w-quick\n")
    result = _run(
        script,
        '{"tool_name":"MultiEdit","tool_input":{"file_path":"/tmp/foo.py"}}',
    )
    assert result.returncode == 0
    assert "warning: Issue filing is not complete" in result.stdout


def test_edit_on_pecot_tmp_output_no_reminder(ctx, script):
    ctx["flag"].write_text("w-ready\n")
    result = _run(
        script,
        '{"tool_name":"Edit","tool_input":{"file_path":"/workspaces/foo/.pecot/tmp/output/issue-foo.md"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_write_on_pecot_tmp_output_no_reminder(ctx, script):
    ctx["flag"].write_text("w-ready\n")
    result = _run(
        script,
        '{"tool_name":"Write","tool_input":{"file_path":"/workspaces/foo/.pecot/tmp/output/issue-bar.md"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_disabled_via_config_no_output(ctx, script):
    ctx["config"].write({"pecot-issue-pending-reminder": False})
    ctx["flag"].write_text("w-quick\n")
    result = _run(script, '{"tool_name":"Edit","tool_input":{}}')
    assert result.returncode == 0
    assert result.stdout == ""
