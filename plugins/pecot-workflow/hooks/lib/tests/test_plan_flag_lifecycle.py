"""プランモードのフラグのライフサイクルのテスト。

- EnterPlanMode 以外のツールでは、plan-flag-setter は `.exit-plan-confirmed` を消さない。
- EnterPlanMode では `.exit-plan-confirmed` を消し、初回 ExitPlanMode の deny をプランモードごとに 1 回出す。
- 計画の Issue 投稿はエージェントの手順に移したため、`.plan-post-pending` はどの入力でも作らない。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def flag_setter(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "pre-tool-use"
        / "plan-flag-setter.sh"
    )


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    project = tmp_path / "project"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    (state_dir / ".pecot-active").write_text("org/repo/123\n")
    return {
        "state_dir": state_dir,
        "pending": state_dir / ".plan-post-pending",
        "exit_confirmed": state_dir / ".exit-plan-confirmed",
    }


def _run(script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(script)], input=stdin, capture_output=True, text=True, timeout=25
    )


@pytest.mark.parametrize("tool_name", ["Bash", "Read", "Agent", "Edit", "Grep"])
def test_non_plan_tool_keeps_exit_confirmed(env, flag_setter, tool_name):
    """EnterPlanMode 以外のツールでは何もしない。"""
    env["exit_confirmed"].write_text("2026-07-24 10:00:00\n")

    r = _run(flag_setter, json.dumps({"tool_name": tool_name, "session_id": "sess-1"}))

    assert r.returncode == 0
    assert env["exit_confirmed"].is_file()
    assert not env["pending"].exists()


def test_enter_plan_mode_resets_confirmed_without_pending(env, flag_setter):
    """EnterPlanMode で `.exit-plan-confirmed` を消し、`.plan-post-pending` は作らない。"""
    env["exit_confirmed"].write_text("2026-07-24 10:00:00\n")

    r = _run(flag_setter, json.dumps({"tool_name": "EnterPlanMode", "session_id": "sess-enter"}))

    assert r.returncode == 0
    assert not env["exit_confirmed"].exists()
    assert not env["pending"].exists()
