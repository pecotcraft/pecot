"""plan-issue-poster / plan-flag-setter の tool 名ガードのユニットテスト
（test_plan_mode_tool_guard.bats 移植）。

Copilot CLI は matcher を honor せず、全ツールで PostToolUse/PreToolUse を発火させる。
そのため、両スクリプトは冒頭の tool 名ガードで、ExitPlanMode / EnterPlanMode 以外を弾く。
JSON stdin を流し、ログ・フラグファイルの副作用を検証する。
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def guard_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, project_root: Path) -> dict:
    project = tmp_path
    (project / ".pecot" / "state").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    lib = project_root / "plugins" / "pecot-workflow" / "hooks" / "lib"
    return {
        "project": project,
        "state_dir": project / ".pecot" / "state",
        "debug_log": project / ".pecot" / "tmp" / "debug" / "plan-post-flow.log",
        "plan_issue_poster": lib / "post-tool-use" / "plan-issue-poster.sh",
        "plan_flag_setter": lib / "pre-tool-use" / "plan-flag-setter.sh",
    }


# plan-issue-poster.sh — ExitPlanMode 以外を弾く。


def test_poster_copilot_bash_no_log(guard_env, run_script) -> None:
    result = run_script(
        guard_env["plan_issue_poster"], stdin='{"tool_name":"bash","tool_input":{"command":"ls"}}'
    )
    assert result.returncode == 0
    assert result.stdout == ""
    assert not guard_env["debug_log"].is_file()


def test_poster_bash_keeps_quick_mode(guard_env, run_script) -> None:
    quick_mode = guard_env["state_dir"] / ".pecot-quick-mode"
    quick_mode.touch()
    result = run_script(guard_env["plan_issue_poster"], stdin='{"tool_name":"Bash"}')
    assert result.returncode == 0
    assert quick_mode.is_file()
    assert not guard_env["debug_log"].is_file()


def test_poster_exit_plan_mode_logs_start(guard_env, run_script) -> None:
    result = run_script(guard_env["plan_issue_poster"], stdin='{"tool_name":"ExitPlanMode"}')
    assert result.returncode == 0
    assert guard_env["debug_log"].is_file()
    assert "ExitPlanMode PostToolUse: start" in guard_env["debug_log"].read_text()


# plan-flag-setter.sh — EnterPlanMode 以外を弾く。


def test_flag_setter_copilot_bash_keeps_confirmed(guard_env, run_script) -> None:
    confirmed = guard_env["state_dir"] / ".exit-plan-confirmed"
    confirmed.touch()
    result = run_script(
        guard_env["plan_flag_setter"], stdin='{"tool_name":"bash","tool_input":{"command":"ls"}}'
    )
    assert result.returncode == 0
    assert confirmed.is_file()


def test_flag_setter_enter_plan_mode_removes_confirmed(guard_env, run_script) -> None:
    confirmed = guard_env["state_dir"] / ".exit-plan-confirmed"
    confirmed.touch()
    result = run_script(
        guard_env["plan_flag_setter"],
        stdin='{"tool_name":"EnterPlanMode","session_id":"s1"}',
    )
    assert result.returncode == 0
    assert not confirmed.is_file()
