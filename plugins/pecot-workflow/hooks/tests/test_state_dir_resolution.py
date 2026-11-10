"""hooks と pecot CLI が同じ `.pecot/state` を指すことの結合テスト。

Claude Code は hooks に、CLAUDE_PROJECT_DIR（セッション開始時のディレクトリ）と入力 JSON の cwd（Bash ツールの cd に追随）を渡す。
Bash ツールから呼ぶ CLI には、CLAUDE_PROJECT_DIR を渡さない（CLI は cwd の git toplevel を使う）。
Bash ツールで別の worktree のサブディレクトリへ cd した状態を再現する。
その状態で、エントリポイント経由の hook と同じ cwd の CLI が、同じ worktree の `.pecot/state` を使うことを検証する。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.fixture
def exit_plan_mode_entry(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "post-tool-use-exit-plan-mode.sh"


@pytest.fixture
def worktree(git_repo) -> dict[str, Path]:
    """`.pecot/` と `.pecot-active` を持つ git リポと、そのサブディレクトリ。"""
    repo = git_repo("worktree")
    state_dir = repo / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    (repo / ".pecot" / ".gitignore").write_text("state/\ntmp/\n")
    (state_dir / ".pecot-active").write_text("org/repo/123\n")
    sub = repo / "plugins" / "pecot-workflow"
    sub.mkdir(parents=True)
    return {"repo": repo.resolve(), "sub": sub, "state_dir": state_dir}


@pytest.fixture
def session_dir(tmp_path: Path) -> Path:
    """セッション開始時の CLAUDE_PROJECT_DIR（別ディレクトリ。こちらにも .pecot を置く）。"""
    session = tmp_path / "session"
    (session / ".pecot" / "state").mkdir(parents=True)
    return session


def test_hook_and_cli_resolve_to_tool_cwd_toplevel(
    exit_plan_mode_entry: Path,
    worktree: dict[str, Path],
    session_dir: Path,
    tmp_path: Path,
    hooks_config,
):
    hooks_config.write({})
    # exit-plan-remind は、ExitPlanMode で .pecot-quick-mode を消す。両方に置き、消える側で解決先を見る。
    (worktree["state_dir"] / ".pecot-quick-mode").write_text("x\n")
    (session_dir / ".pecot" / "state" / ".pecot-quick-mode").write_text("x\n")
    payload = json.dumps(
        {
            "session_id": "sess-1185",
            "tool_name": "ExitPlanMode",
            "cwd": str(worktree["sub"]),
        }
    )

    hook = subprocess.run(
        ["bash", str(exit_plan_mode_entry)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=25,
        env={**os.environ, "CLAUDE_PROJECT_DIR": str(session_dir)},
    )
    assert hook.returncode == 0, hook.stderr

    assert not (worktree["state_dir"] / ".pecot-quick-mode").exists()
    assert (session_dir / ".pecot" / "state" / ".pecot-quick-mode").is_file()

    # Bash ツールから呼ぶ CLI と同じ条件: CLAUDE_PROJECT_DIR なし・cwd はサブディレクトリ。
    cli_env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
    home = tmp_path / "home"
    home.mkdir()
    cli_env["HOME"] = str(home)
    status = subprocess.run(
        [sys.executable, "-m", "cli", "session", "status", "-D", str(worktree["sub"])],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=worktree["sub"],
        env=cli_env,
    )
    assert status.returncode == 0, status.stderr
    assert "| .pecot-active | set | org/repo/123 |" in status.stdout
