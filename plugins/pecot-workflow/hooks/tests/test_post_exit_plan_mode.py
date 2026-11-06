"""post-tool-use-exit-plan-mode.sh のユニットテスト。

計画の Issue 投稿は、確認を求める前にエージェントが済ませる（w-active / w-quick の手順）。
ExitPlanMode の後のフックは投稿せず、次の案内だけを返す。

- 承認した計画が投稿した版から変わっていれば、投稿したファイルを直して投稿し直すこと
- quick 以外では、w-implementer への引き継ぎ
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def hook_script(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "post-tool-use-exit-plan-mode.sh"


@pytest.fixture
def ctx(
    project_root: Path,
    tmp_path: Path,
    hooks_config,
    monkeypatch: pytest.MonkeyPatch,
    pecot_bin_mock,
):
    project = tmp_path / "project"
    plugin = tmp_path / "plugin"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)

    templates = project_root / "plugins" / "pecot-workflow" / "hooks" / "templates"
    copied = plugin / "hooks" / "templates"
    copied.mkdir(parents=True)
    for name in ("exit-plan-implementer-remind.md", "exit-plan-comment-update.md"):
        shutil.copy(templates / name, copied)
    pecot_bin_mock.install(plugin)

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))
    hooks_config.write({})
    return {
        "project": project,
        "state_dir": state_dir,
        "pecot_active": state_dir / ".pecot-active",
        "quick_mode": state_dir / ".pecot-quick-mode",
        "marker": pecot_bin_mock.marker,
    }


def _run(hook_script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(hook_script)], input=stdin, capture_output=True, text=True, timeout=25
    )


_EXIT_PLAN = json.dumps({"tool_name": "ExitPlanMode"})


def _context(result: subprocess.CompletedProcess) -> str:
    return json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]


def test_no_pecot_active_no_output(ctx, hook_script):
    result = _run(hook_script, _EXIT_PLAN)
    assert result.returncode == 0
    assert result.stdout == ""


def test_pecot_absent_exits_clean(ctx, hook_script):
    """pecot 未使用リポ（.pecot 不在）では何も書かず、.pecot を作らない（#666）。"""
    shutil.rmtree(ctx["project"] / ".pecot")
    result = _run(hook_script, _EXIT_PLAN)
    assert result.returncode == 0
    assert result.stdout == ""
    assert not (ctx["project"] / ".pecot").exists()


def test_shared_mode_guides_comment_update_and_implementer(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    result = _run(hook_script, _EXIT_PLAN)
    assert result.returncode == 0
    context = _context(result)
    assert "計画のコメントの更新" in context
    assert "pecot issue comment" in context
    assert "実装の引き継ぎ" in context
    assert "コミットは main の責務" in context
    assert "team_name" not in context


def test_quick_mode_guides_comment_update_only_and_clears_flag(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    ctx["quick_mode"].touch()
    result = _run(hook_script, _EXIT_PLAN)
    assert result.returncode == 0
    context = _context(result)
    assert "計画のコメントの更新" in context
    assert "実装の引き継ぎ" not in context
    assert not ctx["quick_mode"].exists()


def test_does_not_post_to_issue(ctx, hook_script):
    """bin/pecot があっても、ExitPlanMode の後に投稿しない。"""
    ctx["pecot_active"].write_text("org/repo/123\n")
    result = _run(hook_script, _EXIT_PLAN)
    assert result.returncode == 0
    assert not ctx["marker"].exists()
    assert not (ctx["project"] / ".pecot" / "tmp" / "plan-post").exists()


def test_work_link_cwd_reads_session_worktree_state(ctx, hook_script, work_layout, monkeypatch):
    """cwd が base 実体の .pecot/work/N でも、worktree の .pecot-active を読む。"""
    wt = work_layout["wt"]
    (wt / ".pecot" / "state").mkdir(parents=True)
    (wt / ".pecot" / "state" / ".pecot-active").write_text("org/repo/123\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(wt))
    payload = json.dumps({"tool_name": "ExitPlanMode", "cwd": str(work_layout["work"] / "1244")})

    result = _run(hook_script, payload)

    assert result.returncode == 0
    assert "計画のコメントの更新" in _context(result)
