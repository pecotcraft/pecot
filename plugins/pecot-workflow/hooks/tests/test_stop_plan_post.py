"""stop-plan-post.sh / pre-tool-use-exit-plan-mode.sh のエントリ経由の結合テスト。

計画をコンテキストのクリアで承認する手段は、次の 2 段になっている。
旧セッションの PreToolUse(ExitPlanMode) が、`.plan-post-pending` に計画ファイルのパスを書く（plan-path-recorder.sh）。
新しいセッションの Stop が、投稿する（plan-post-fallback.sh）。
どちらも、cwd が base 実体の `.pecot/work/N` でも、セッションの worktree の state を読み書きする。
worktree の `.pecot/work` は、base への symlink になっている。
投稿は `pecot_bin_mock` で bin/pecot を差し替え、投稿内容を <marker>.body の写しで検証する。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

_HOOKS = ("plugins", "pecot-workflow", "hooks")
_FLAG = ".plan-post-pending"


@pytest.fixture
def ctx(
    project_root: Path,
    tmp_path: Path,
    work_layout,
    hooks_config,
    pecot_bin_mock,
    monkeypatch: pytest.MonkeyPatch,
) -> dict:
    """CLAUDE_PROJECT_DIR を worktree に向け、base と worktree の両方に別の Issue のフラグを置く。"""
    wt, base = work_layout["wt"], work_layout["base"]
    for root, number in ((wt, 123), (base, 999)):
        state = root / ".pecot" / "state"
        state.mkdir(parents=True)
        (state / ".pecot-active").write_text(f"org/repo/{number}\n")
        (state / _FLAG).write_text(f"old-session:org/repo/{number}\n")
        (root / ".pecot" / "tmp" / "debug").mkdir(parents=True)
    plugin = tmp_path / "plugin"
    pecot_bin_mock.install(plugin)
    home = tmp_path / "home"
    plan_dir = home / ".claude" / "plans"
    plan_dir.mkdir(parents=True)
    plan_file = plan_dir / "clear-slug.md"
    plan_file.write_text("# Clear Plan\n")
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "type": "user",
                "message": {"role": "user", "content": "Implement the following plan:\n\n# P\n"},
            }
        )
        + "\n"
    )
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(wt))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))
    monkeypatch.setenv("HOME", str(home))
    hooks_config.write({})
    return {
        "entry_dir": project_root.joinpath(*_HOOKS),
        "cwd": work_layout["work"] / "1244",
        "wt_flag": wt / ".pecot" / "state" / _FLAG,
        "base_flag": base / ".pecot" / "state" / _FLAG,
        "wt_quick": wt / ".pecot" / "state" / ".pecot-quick-mode",
        "plan_file": plan_file,
        "transcript": transcript,
        "marker": pecot_bin_mock.marker,
        "body": pecot_bin_mock.body,
    }


def _run_entry(ctx: dict, script: str, payload: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(ctx["entry_dir"] / script)],
        input=json.dumps({**payload, "cwd": str(ctx["cwd"])}),
        capture_output=True,
        text=True,
        timeout=25,
    )


def _exit_plan_input(ctx: dict) -> dict:
    return {
        "hook_event_name": "PreToolUse",
        "tool_name": "ExitPlanMode",
        "session_id": "old-session",
        "tool_input": {"planFilePath": str(ctx["plan_file"])},
    }


def _stop_input(ctx: dict) -> dict:
    return {
        "hook_event_name": "Stop",
        "session_id": "new-session",
        "transcript_path": str(ctx["transcript"]),
    }


def test_recorder_writes_plan_path_to_session_worktree_flag(ctx) -> None:
    ctx["wt_quick"].touch()  # first-block を通す（記録の対象にする）

    result = _run_entry(ctx, "pre-tool-use-exit-plan-mode.sh", _exit_plan_input(ctx))

    assert result.returncode == 0
    assert ctx["wt_flag"].read_text() == f"old-session:org/repo/123\n{ctx['plan_file']}\n"
    assert ctx["base_flag"].read_text() == "old-session:org/repo/999\n"


def test_stop_posts_to_session_worktree_issue(ctx) -> None:
    ctx["wt_flag"].write_text(f"old-session:org/repo/123\n{ctx['plan_file']}\n")

    result = _run_entry(ctx, "stop-plan-post.sh", _stop_input(ctx))

    assert result.returncode == 0
    assert ctx["body"].read_text() == (
        '---\nissue_ref: "org/repo/123"\ntemplate: plan\n---\n\n# Clear Plan\n'
    )
    assert not ctx["wt_flag"].exists()
    assert ctx["base_flag"].read_text() == "old-session:org/repo/999\n"


def test_recorded_flag_is_posted_by_stop(ctx) -> None:
    """PreToolUse の記録から新しいセッションの Stop の投稿まで、worktree の state で完結する。"""
    ctx["wt_quick"].touch()
    _run_entry(ctx, "pre-tool-use-exit-plan-mode.sh", _exit_plan_input(ctx))

    result = _run_entry(ctx, "stop-plan-post.sh", _stop_input(ctx))

    assert result.returncode == 0
    assert 'issue_ref: "org/repo/123"' in ctx["body"].read_text()
    assert not ctx["wt_flag"].exists()
    assert ctx["base_flag"].read_text() == "old-session:org/repo/999\n"
