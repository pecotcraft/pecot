"""exit-plan-remind の tool 名ガードのユニットテスト
（test_plan_mode_tool_guard.bats 移植）。

Copilot CLI は matcher を honor せず、全ツールで PostToolUse/PreToolUse を発火させる。
そのため、冒頭の tool 名ガードで ExitPlanMode 以外を弾く。
JSON stdin を流し、出力とフラグファイルの副作用を検証する。
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
        "exit_plan_remind": lib / "post-tool-use" / "exit-plan-remind.sh",
    }


# exit-plan-remind.sh — ExitPlanMode 以外を弾く。


def test_remind_copilot_bash_no_output(guard_env, run_script) -> None:
    (guard_env["state_dir"] / ".pecot-active").write_text("org/repo/1\n")
    result = run_script(
        guard_env["exit_plan_remind"], stdin='{"tool_name":"bash","tool_input":{"command":"ls"}}'
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_remind_bash_keeps_quick_mode(guard_env, run_script) -> None:
    quick_mode = guard_env["state_dir"] / ".pecot-quick-mode"
    quick_mode.touch()
    result = run_script(guard_env["exit_plan_remind"], stdin='{"tool_name":"Bash"}')
    assert result.returncode == 0
    assert quick_mode.is_file()
