"""pre-tool-use-exit-plan-mode.sh（exit-plan-mode-first-block.sh）のユニットテスト。
（test_pre_tool_use_exit_plan_mode_first_block.bats 移植）。

検証する項目は次のとおり。
初回 ExitPlanMode ブロック要否、確認済みフラグありの 2 回目すり抜け、quick モードのスキップ。
mode 分岐は廃止済みで、レビュー指摘の反映確認リマインドが、単一テンプレで注入される。
レビュアー spawn 指示は、EnterPlanMode 前へ移動済み。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def hook_script(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use-exit-plan-mode.sh"


@pytest.fixture
def ctx(
    project_root: Path,
    tmp_path: Path,
    hooks_config,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "project"
    plugin = tmp_path / "plugin"
    state_dir = project / ".pecot" / "state"
    templates_dst = plugin / "hooks" / "templates"
    state_dir.mkdir(parents=True)
    templates_dst.mkdir(parents=True)
    templates = project_root / "plugins" / "pecot-workflow" / "hooks" / "templates"
    shutil.copy(templates / "exit-plan-mode-remind.md", templates_dst)

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))
    hooks_config.write({"exit-plan-mode-first-block": True})
    return {
        "state_dir": state_dir,
        "confirmed": state_dir / ".exit-plan-confirmed",
        "config": hooks_config,
    }


def _run(hook_script: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(hook_script)],
        input='{"tool_name":"ExitPlanMode"}',
        capture_output=True,
        text=True,
        timeout=25,
    )


# 初回 ExitPlanMode は hookSpecificOutput.permissionDecision:deny でブロックされ、reason に反映確認を含む。


def test_first_exit_blocks(ctx, hook_script):
    result = _run(hook_script)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout
    assert ctx["confirmed"].is_file()


def test_reason_includes_reflection_check(ctx, hook_script):
    result = _run(hook_script)
    assert result.returncode == 0
    assert "mode: shared" in result.stdout
    assert "w-tech-advisor" in result.stdout
    assert "w-e2e-planner" in result.stdout
    assert "反映済み" in result.stdout
    assert "レビューステップ" in result.stdout
    # レビュアー spawn 指示は EnterPlanMode 前（SKILL.md のレビューステップ）へ移動済み。
    assert "単発 spawn" not in result.stdout
    assert "レビュー依頼" not in result.stdout


def test_reason_includes_cross_repo_check(ctx, hook_script):
    result = _run(hook_script)
    assert result.returncode == 0
    assert "越境" in result.stdout
    assert "パッチ退避" in result.stdout
    assert "issue-flow-rules.md §6" in result.stdout


def test_confirmed_flag_second_call_passes(ctx, hook_script):
    ctx["confirmed"].write_text("")
    result = _run(hook_script)
    assert result.returncode == 0
    assert result.stdout == ""


# quick モード: ブロックされない。


def test_quick_mode_not_blocked(ctx, hook_script):
    (ctx["state_dir"] / ".pecot-quick-mode").touch()
    result = _run(hook_script)
    assert result.returncode == 0
    assert result.stdout == ""
    assert not ctx["confirmed"].is_file()


# SC-001（008-plan-mode-minimization 不変条件 1）。
# ExitPlanMode 前リマインドのテンプレ本文は、plan mode 中のレビュアー spawn ではなく、次のガードを持つ。
# 「未レビュー時は plan mode 内で spawn せず通常モードのレビューステップへ戻す」というガードで、これを本文レベルで固定する。


def test_remind_template_file_forbids_plan_mode_spawn(project_root):
    body = (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "templates"
        / "exit-plan-mode-remind.md"
    ).read_text()
    # 未レビュー時は plan mode 内 spawn を禁じ、通常モードのレビューステップへ戻すガード。
    assert "plan mode 内で spawn せず" in body
    assert "レビューステップ" in body


# 越境ガード（#951）: テンプレ本文は test_reason_includes_cross_repo_check が stdout で
# 固定する。ここは本文が指す参照先（定義元の §6 見出し）の実在を担保する。


def test_rules_doc_has_cross_repo_section(project_root):
    body = (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "skills"
        / "w-help"
        / "references"
        / "issue-flow-rules.md"
    ).read_text()
    assert "## 6. 変更対象のリポジトリ限定" in body
