"""pre-tool-use.sh のユニットテスト（#1229 T054）。

PreToolUse(Edit|Write|MultiEdit|NotebookEdit|EnterPlanMode) のエントリ。Issue 起票忘れの
リマインダー（pecot-issue-pending-reminder）だけを merge 経由で返す。コンテキストクリア後の
計画投稿は Stop の stop-plan-post.sh に移したため、ここでは
`.plan-post-pending` を触らない。Bash は pre-tool-use-bash.sh が受け持つ。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def hook_script(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use.sh"


@pytest.fixture
def ctx(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    project = tmp_path / "project"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    return {
        "state_dir": state_dir,
        "pending": state_dir / ".plan-post-pending",
        "issue_pending": state_dir / "issue-pending",
    }


def _run(hook_script: Path, payload: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(hook_script)],
        input=json.dumps({"hook_event_name": "PreToolUse", **payload}),
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_no_flag_no_output(ctx, hook_script):
    result = _run(hook_script, {"tool_name": "Edit", "tool_input": {"file_path": "/x"}})
    assert result.returncode == 0
    assert result.stdout == ""


@pytest.mark.parametrize(
    ("tool_name", "tool_input"),
    [
        ("Edit", {"file_path": "/work/a.py"}),
        ("Write", {"file_path": "/work/a.py"}),
        ("MultiEdit", {"file_path": "/work/a.py"}),
        ("NotebookEdit", {"notebook_path": "/work/a.ipynb"}),
        ("EnterPlanMode", {}),
        # Copilot CLI の Edit は tool_input.path（file_path ではない）
        ("Edit", {"path": "/work/a.py", "old_str": "a", "new_str": "b"}),
    ],
)
def test_issue_pending_reminder_is_returned(ctx, hook_script, tool_name, tool_input):
    ctx["issue_pending"].write_text("w-quick\n")
    result = _run(hook_script, {"tool_name": tool_name, "tool_input": tool_input})
    assert result.returncode == 0
    hso = json.loads(result.stdout)["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert "Issue 起票が未完了" in hso["additionalContext"]


def test_edit_under_pecot_tmp_output_is_exempt(ctx, hook_script):
    ctx["issue_pending"].write_text("w-quick\n")
    result = _run(
        hook_script,
        {"tool_name": "Write", "tool_input": {"file_path": "/p/.pecot/tmp/output/x.md"}},
    )
    assert result.stdout == ""


def test_apply_patch_string_tool_input_does_not_break(ctx, hook_script):
    """Copilot の apply_patch は tool_input が文字列。パースで落ちず、Edit 扱いでリマインドする。"""
    ctx["issue_pending"].write_text("w-quick\n")
    result = _run(hook_script, {"tool_name": "Edit", "tool_input": "*** Begin Patch\n..."})
    assert result.returncode == 0
    assert (
        "Issue 起票が未完了" in json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
    )


def test_plan_post_pending_flag_is_not_touched(ctx, hook_script):
    """計画投稿のフォールバックは SessionStart(clear) へ移した。ここではフラグを消費しない。"""
    ctx["pending"].write_text("old-session:org/repo/100\n/p/plan.md\n")
    result = _run(
        hook_script,
        {"tool_name": "Edit", "session_id": "new-session", "tool_input": {"file_path": "/x"}},
    )
    assert result.stdout == ""
    assert ctx["pending"].read_text() == "old-session:org/repo/100\n/p/plan.md\n"


def test_edit_in_work_link_ignores_base_issue_pending(
    work_layout, hook_script, monkeypatch: pytest.MonkeyPatch
):
    """cwd が base 実体の .pecot/work/N でも、セッションの worktree の state を読む。"""
    (work_layout["base"] / ".pecot" / "state").mkdir(parents=True)
    (work_layout["base"] / ".pecot" / "state" / "issue-pending").write_text("w-ready\n")
    (work_layout["wt"] / ".pecot" / "state").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(work_layout["wt"]))

    result = _run(
        hook_script,
        {
            "tool_name": "Write",
            "tool_input": {"file_path": "/work/a.py"},
            "cwd": str(work_layout["work"] / "1244"),
        },
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_edit_in_base_work_with_base_session_still_reminds(
    work_layout, hook_script, monkeypatch: pytest.MonkeyPatch
):
    """セッションが base なら従来どおり base の issue-pending を読む（対照）。"""
    (work_layout["base"] / ".pecot" / "state").mkdir(parents=True)
    (work_layout["base"] / ".pecot" / "state" / "issue-pending").write_text("w-ready\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(work_layout["base"]))

    result = _run(
        hook_script,
        {
            "tool_name": "Write",
            "tool_input": {"file_path": "/work/a.py"},
            "cwd": str(work_layout["work"] / "1244"),
        },
    )
    hso = json.loads(result.stdout)["hookSpecificOutput"]
    assert "サブタスク Issue の起票が未完了です。" in hso["additionalContext"]
