"""exit-plan-mode-first-block のテスト（test_exit_plan_mode_first_block.bats 移植）。

PreToolUse(ExitPlanMode) で、初回ブロック→2回目通過する挙動を検証する。
あわせて、次の項目も検証する。
hooks-config 制御・ブロックメッセージ内容・.pecot 不在すり抜け・gitignore 先行生成・CLAUDE_PLUGIN_ROOT リソース参照。
JSON stdin を logic/entry スクリプトに流す。
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest


@pytest.fixture
def epm_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, project_root: Path) -> dict:
    """bats setup() 相当。hooks-config・CLAUDE_PROJECT_DIR・state を用意する。"""
    config = tmp_path / "hooks-config.json"
    config.write_text('{"exit-plan-mode-first-block": true}')
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(config))

    project = tmp_path / "project"
    (project / ".pecot" / "state").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    hooks = project_root / "plugins" / "pecot-workflow" / "hooks"
    return {
        "config": config,
        "project": project,
        "state_dir": project / ".pecot" / "state",
        "flag_file": project / ".pecot" / "state" / ".exit-plan-confirmed",
        "logic_script": hooks / "lib" / "pre-tool-use" / "exit-plan-mode-first-block.sh",
        "entry_script": hooks / "pre-tool-use-exit-plan-mode.sh",
        "project_root": project_root,
    }


# 正常系: 初回ブロック→2回目通過。


def test_first_blocks_and_creates_flag(epm_env, run_script) -> None:
    result = run_script(epm_env["logic_script"], stdin="{}")
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout
    assert "計画確認リマインド" in result.stdout
    assert epm_env["flag_file"].is_file()


def test_second_passes_flag_remains(epm_env, run_script) -> None:
    epm_env["flag_file"].write_text("2026-03-25 10:00:00\n")
    result = run_script(epm_env["logic_script"], stdin="{}")
    assert result.returncode == 0
    assert result.stdout == ""
    assert epm_env["flag_file"].is_file()


# hooks-config 制御。


def test_config_false_no_flag_passes(epm_env, run_script) -> None:
    epm_env["config"].write_text('{"exit-plan-mode-first-block": false}')
    result = run_script(epm_env["logic_script"], stdin="{}")
    assert result.returncode == 0
    assert result.stdout == ""
    assert not epm_env["flag_file"].is_file()


def test_config_false_with_flag_passes_flag_kept(epm_env, run_script) -> None:
    epm_env["config"].write_text('{"exit-plan-mode-first-block": false}')
    epm_env["flag_file"].write_text("2026-03-25 10:00:00\n")
    result = run_script(epm_env["logic_script"], stdin="{}")
    assert result.returncode == 0
    assert result.stdout == ""
    assert epm_env["flag_file"].is_file()


# ブロックメッセージ内容。


def test_block_message_content(epm_env, run_script) -> None:
    result = run_script(epm_env["logic_script"], stdin="{}")
    assert result.returncode == 0
    assert "w-tech-advisor" in result.stdout
    assert "w-e2e-planner" in result.stdout
    assert "反映済み" in result.stdout
    assert "レビューステップ" in result.stdout
    assert "再レビューは不要" in result.stdout
    # レビュアー spawn 指示は EnterPlanMode 前（SKILL.md のレビューステップ）へ移動済み。
    assert "単発 spawn" not in result.stdout
    assert "レビュー依頼" not in result.stdout
    assert "フィードバックを計画に反映" not in result.stdout
    assert "計画承認後の実装フェーズで起動" not in result.stdout
    assert "w-e2e-tester" not in result.stdout


# エントリスクリプト経由。


def test_entry_script_first_blocks_second_passes(epm_env, run_script) -> None:
    # 初回: ブロック。
    result = run_script(epm_env["entry_script"], stdin="{}")
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert epm_env["flag_file"].is_file()

    # 2回目: 通過（フラグは残る）。
    result = run_script(epm_env["entry_script"], stdin="{}")
    assert result.returncode == 0
    assert result.stdout == ""
    assert epm_env["flag_file"].is_file()


# pecot 未使用リポ（.pecot 不在）。


def test_pecot_absent_passes_no_create(epm_env, run_script) -> None:
    pecot = epm_env["project"] / ".pecot"
    shutil.rmtree(pecot)

    result = run_script(epm_env["logic_script"], stdin="{}")
    assert result.returncode == 0
    assert result.stdout == ""
    assert not pecot.is_dir()


# pecot 利用リポ・.gitignore 不在: block と同時に .gitignore を先行生成。


def test_gitignore_generated_on_block(epm_env, run_script) -> None:
    pecot = epm_env["project"] / ".pecot"
    shutil.rmtree(pecot)
    pecot.mkdir(parents=True)
    assert not (pecot / ".gitignore").is_file()

    result = run_script(epm_env["logic_script"], stdin="{}")
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert epm_env["flag_file"].is_file()
    assert (pecot / ".gitignore").is_file()


# CLAUDE_PLUGIN_ROOT 設定時: プラグインルート配下のリソースを参照。


def test_plugin_root_reads_remind_md(epm_env, run_script, monkeypatch) -> None:
    plugin_root = epm_env["project"].parent / "plugin"
    (plugin_root / "hooks" / "templates").mkdir(parents=True)
    src = (
        epm_env["project_root"]
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "templates"
        / "exit-plan-mode-remind.md"
    )
    (plugin_root / "hooks" / "templates" / "exit-plan-mode-remind.md").write_bytes(src.read_bytes())
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin_root))

    result = run_script(epm_env["logic_script"], stdin="{}")
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout
    assert "計画確認リマインド" in result.stdout
    assert epm_env["flag_file"].is_file()


def test_plugin_root_state_dir_stays_in_project(epm_env, run_script, monkeypatch) -> None:
    plugin_root = epm_env["project"].parent / "plugin"
    (plugin_root / "hooks" / "templates").mkdir(parents=True)
    src = (
        epm_env["project_root"]
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "templates"
        / "exit-plan-mode-remind.md"
    )
    (plugin_root / "hooks" / "templates" / "exit-plan-mode-remind.md").write_bytes(src.read_bytes())
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin_root))

    result = run_script(epm_env["logic_script"], stdin="{}")
    assert result.returncode == 0
    assert (epm_env["project"] / ".pecot" / "state" / ".exit-plan-confirmed").is_file()
    assert not (plugin_root / ".pecot" / "state" / ".exit-plan-confirmed").is_file()
