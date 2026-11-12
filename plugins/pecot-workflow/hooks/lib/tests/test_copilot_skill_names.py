"""Copilot CLI の Skill 入力（名前空間なしのスキル名）のテスト（#1229 T050 追加確認）。

Copilot CLI 1.0.103 の skill ツールは、`tool_name: "skill"`（小文字）で、`tool_input.skill` が名前空間なし（`w-help`）で届く。
同名のスキルが複数あるときだけ、`<プラグイン名>:<名前>` で届く。
接頭辞（`w-`）だけで判定すると、他のプラグインの同名スキルを取り違える。
そのため、名前空間なしの名前は、自プラグインの `skills/<名前>/SKILL.md` が実在するときだけ、自プラグインのスキルとして扱う。

エントリ（pre-tool-use-skill.sh / post-tool-use-skill.sh）に Copilot 形式の入力を流して固定する。
com.github.copilot/hooks/hooks.json の matcher `Skill|skill` が起動を担保し、ここでは起動後の判定を見る。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest


@pytest.fixture
def project(
    git_repo: Callable[..., Path], project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    repo = git_repo("skill-proj")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    # スキルの実在確認は CLAUDE_PLUGIN_ROOT/skills/<名前>/SKILL.md を見る。
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(project_root / "plugins" / "pecot-workflow"))
    return repo


def _run(entry: Path, event: str, skill: str, cwd: Path, **extra) -> subprocess.CompletedProcess:
    payload = {
        "hook_event_name": event,
        "tool_name": "skill",
        "tool_input": {"skill": skill},
        "cwd": str(cwd),
        "session_id": "copilot-session",
        **extra,
    }
    return subprocess.run(
        ["bash", str(entry)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=25,
    )


@pytest.fixture
def pre_entry(hooks_dir: Path) -> Path:
    return hooks_dir / "pre-tool-use-skill.sh"


@pytest.fixture
def post_entry(hooks_dir: Path) -> Path:
    return hooks_dir / "post-tool-use-skill.sh"


# PreToolUse: pecot-skill-compliance / pecot-dir-init-detect


@pytest.mark.parametrize("skill", ["w-help", "pecot-w:w-help"])
def test_pre_injects_workflow_notes_for_own_skill(pre_entry, project, skill) -> None:
    result = _run(pre_entry, "PreToolUse", skill, project)
    assert result.returncode == 0
    hso = json.loads(result.stdout)["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert "note: notes for the pecot-workflow skills" in hso["additionalContext"]


def test_pre_initializes_pecot_dir_for_namespaceless_own_skill(pre_entry, project) -> None:
    assert not (project / ".pecot").exists()
    _run(pre_entry, "PreToolUse", "w-help", project)
    assert (project / ".pecot").is_dir()


@pytest.mark.parametrize(
    "skill",
    [
        "v-slidev",  # pecot-visual のスキル（pecot-workflow の skills/ に無い）
        "w-no-such-skill",  # `w-` で始まるが実在しない
        "../hooks",  # パス遡上
        "pecot-v:v-slidev",  # 他の名前空間
        "",
    ],
)
def test_pre_ignores_skills_not_owned_by_this_plugin(pre_entry, project, skill) -> None:
    result = _run(pre_entry, "PreToolUse", skill, project)
    assert result.returncode == 0
    assert result.stdout == ""
    assert not (project / ".pecot").exists()


# PostToolUse: pecot-skill-reminder


def test_post_a_quick_without_namespace_sets_issue_pending_and_reminds(post_entry, project) -> None:
    (project / ".pecot" / "state").mkdir(parents=True)
    result = _run(
        post_entry,
        "PostToolUse",
        "w-quick",
        project,
        tool_result={"result_type": "success", "text_result_for_llm": 'Skill "w-quick" loaded'},
    )
    assert result.returncode == 0
    assert (project / ".pecot" / "state" / "issue-pending").read_text().strip() == "w-quick"
    assert (
        "note: pecot-workflow skill started"
        in json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
    )
    # Copilot CLI の PostToolUse はトップレベルの additionalContext だけをモデルに渡す。
    out = json.loads(result.stdout)
    assert out["additionalContext"] == out["hookSpecificOutput"]["additionalContext"]
    assert "note: pecot-workflow skill started" in out["additionalContext"]


def test_post_a_help_without_namespace_has_no_output(post_entry, project) -> None:
    (project / ".pecot" / "state").mkdir(parents=True)
    result = _run(post_entry, "PostToolUse", "w-help", project)
    assert result.returncode == 0
    assert result.stdout == ""
    assert not (project / ".pecot" / "state" / "issue-pending").exists()


def test_post_other_plugin_skill_with_same_prefix_is_not_treated_as_own(
    post_entry, project
) -> None:
    (project / ".pecot" / "state").mkdir(parents=True)
    result = _run(post_entry, "PostToolUse", "w-quick-clone", project)
    assert result.stdout == ""
    assert not (project / ".pecot" / "state" / "issue-pending").exists()


def test_post_exit_plan_mode_emits_top_level_additional_context(hooks_dir, project) -> None:
    """ExitPlanMode の案内も merge を通り、Copilot CLI が読むトップレベルの additionalContext に出る。"""
    (project / ".pecot" / "state").mkdir(parents=True)
    (project / ".pecot" / "state" / ".pecot-active").write_text("org/repo/1\n")
    result = _run(
        hooks_dir / "post-tool-use-exit-plan-mode.sh",
        "PostToolUse",
        "x",
        project,
        tool_name="ExitPlanMode",
    )
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert "Plan comment update" in out["additionalContext"]
    assert out["hookSpecificOutput"]["additionalContext"] == out["additionalContext"]
    assert out["hookSpecificOutput"]["hookEventName"] == "PostToolUse"
