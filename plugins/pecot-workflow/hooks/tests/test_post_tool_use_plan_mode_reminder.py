"""post-tool-use/plan-mode-reminder.sh のユニットテスト
（test_post_tool_use_plan_mode_reminder.bats 移植）。

次の 3 点を検証する。
通常モード（plan-mode-reminder.md）とクイックモード（plan-mode-reminder-quick.md）のテンプレ出し分け。
CLAUDE_PLUGIN_ROOT の参照。刈り込み済みセクションの非混入。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "post-tool-use"
        / "plan-mode-reminder.sh"
    )


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
    archive_dir = plugin / "hooks" / "templates"
    state_dir.mkdir(parents=True)
    archive_dir.mkdir(parents=True)
    templates = project_root / "plugins" / "pecot-workflow" / "hooks" / "templates"
    shutil.copy(templates / "plan-mode-reminder.md", archive_dir)
    shutil.copy(templates / "plan-mode-reminder-quick.md", archive_dir)

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))
    hooks_config.write({"plan-mode-reminder": True})
    return {
        "state_dir": state_dir,
        "config": hooks_config,
        "project": project,
        "plugin": plugin,
        "templates": templates,
    }


def _run(script: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(script)],
        input="{}",
        capture_output=True,
        text=True,
        timeout=25,
    )


# 通常モード: plan-mode-reminder.md（team/single 共通）が読み込まれる


def test_normal_mode_outputs_reminder(ctx, script):
    result = _run(script)
    assert result.returncode == 0
    assert "mode: shared" in result.stdout
    assert "# 【pecot計画モード】" in result.stdout
    assert "投稿したファイル" in result.stdout


def test_common_template_mode_independent(ctx, script):
    ctx["config"].write({"plan-mode-reminder": True})
    result = _run(script)
    assert result.returncode == 0
    assert "mode: shared" in result.stdout
    assert "投稿したファイル" in result.stdout


# クイックモード: plan-mode-reminder-quick.md が読み込まれる


def test_quick_mode_outputs_quick_template(ctx, script):
    (ctx["state_dir"] / ".pecot-quick-mode").touch()
    result = _run(script)
    assert result.returncode == 0
    assert "pecotクイックモード計画" in result.stdout
    assert "サブエージェントを起動せず main が実装します" in result.stdout


# hooks-config で無効化時は出力されない


def test_disabled_via_config_no_output(ctx, script):
    ctx["config"].write({"plan-mode-reminder": False})
    result = _run(script)
    assert result.returncode == 0
    assert result.stdout == ""


# CLAUDE_PLUGIN_ROOT 設定時: プラグインルート配下のテンプレートを参照


def test_plugin_root_reads_normal_template(ctx, script, monkeypatch):
    # プラグイン環境をシミュレート
    plugin = ctx["plugin"]
    (plugin / "hooks" / "templates").mkdir(parents=True, exist_ok=True)
    shutil.copy(ctx["templates"] / "plan-mode-reminder.md", plugin / "hooks" / "templates")
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))

    # CLAUDE_PROJECT_DIR 配下には templates を配置しない（プラグイン分離検証）
    claude_hooks = ctx["project"] / ".claude" / "hooks"
    if claude_hooks.exists():
        shutil.rmtree(claude_hooks)
    (ctx["project"] / ".pecot" / "state").mkdir(parents=True, exist_ok=True)

    result = _run(script)
    assert result.returncode == 0
    assert "# 【pecot計画モード】" in result.stdout
    assert "投稿したファイル" in result.stdout


def test_plugin_root_reads_quick_template(ctx, script, monkeypatch):
    plugin = ctx["plugin"]
    (plugin / "hooks" / "templates").mkdir(parents=True, exist_ok=True)
    shutil.copy(ctx["templates"] / "plan-mode-reminder-quick.md", plugin / "hooks" / "templates")
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))

    claude_hooks = ctx["project"] / ".claude" / "hooks"
    if claude_hooks.exists():
        shutil.rmtree(claude_hooks)
    (ctx["project"] / ".pecot" / "state").mkdir(parents=True, exist_ok=True)
    (ctx["project"] / ".pecot" / "state" / ".pecot-quick-mode").touch()

    result = _run(script)
    assert result.returncode == 0
    assert "pecotクイックモード計画" in result.stdout
    assert "サブエージェントを起動せず main が実装します" in result.stdout


# コマンド衛生ガイダンス（negative）: Claude Code 既定動作の再述だったため、#829 で
# ガイダンス自体を両モードのテンプレから撤去した。再混入を防ぐために固定する。
# stdout を調べる方式だと、テンプレの解決先が変わって stdout が空になったとき、
# 負アサートが意味なく成立してしまう。そのためテンプレ本文を直接読んで確かめる。


def test_normal_template_no_command_hygiene(ctx):
    body = (ctx["templates"] / "plan-mode-reminder.md").read_text()
    assert "投稿したファイル" in body
    assert "コマンド衛生" not in body
    assert "インタープリタ" not in body


def test_quick_template_no_command_hygiene(ctx):
    body = (ctx["templates"] / "plan-mode-reminder-quick.md").read_text()
    assert "サブエージェントを起動せず main が実装します" in body
    assert "コマンド衛生" not in body
    assert "インタープリタ" not in body


# 越境ガード（#951）: 通常 / quick 双方のテンプレに越境ガードが含まれることを、実際に
# 注入される stdout で固定する。quick は ExitPlanMode の初回 block が働かないため、
# EnterPlanMode 後に注入されるこのテンプレが quick 側で唯一の注入点。


def test_normal_mode_includes_cross_repo_guard(ctx, script):
    result = _run(script)
    assert result.returncode == 0
    assert "越境" in result.stdout
    assert "パッチ退避" in result.stdout
    assert "issue-flow-rules.md §6" in result.stdout


def test_quick_mode_includes_cross_repo_guard(ctx, script):
    (ctx["state_dir"] / ".pecot-quick-mode").touch()
    result = _run(script)
    assert result.returncode == 0
    assert "越境" in result.stdout
    assert "パッチ退避" in result.stdout
    assert "issue-flow-rules.md §6" in result.stdout


def test_does_not_include_dropped_parallel_decision_table(ctx, script):
    result = _run(script)
    assert result.returncode == 0
    assert "並列分割の判定基準" not in result.stdout
    assert "並列実装" + "可能性" not in result.stdout
    assert "独立した作業単位" not in result.stdout


def test_cuj_template_does_not_carry_precondition_row(ctx, script):
    result = _run(script)
    assert result.returncode == 0
    assert "**前提**:" not in result.stdout


# 刈り込みで削除した 3 セクションが両モードのテンプレに残っていないこと（negative）


def test_does_not_include_pruned_sections(ctx, script):
    result = _run(script)
    assert result.returncode == 0
    assert "### 作業情報" not in result.stdout
    assert "Issue 本文の取り扱い" not in result.stdout
    assert "スコープ外判断" not in result.stdout


def test_quick_does_not_include_pruned_sections(ctx, script):
    (ctx["state_dir"] / ".pecot-quick-mode").touch()
    result = _run(script)
    assert result.returncode == 0
    assert "### 作業情報" not in result.stdout
    assert "Issue 本文の取り扱い" not in result.stdout
    assert "スコープ外判断" not in result.stdout


# クイックモードテンプレに通常版の判定基準表が混入していないこと（negative）


def test_quick_does_not_include_parallel_default_guidance_table(ctx, script):
    (ctx["state_dir"] / ".pecot-quick-mode").touch()
    result = _run(script)
    assert result.returncode == 0
    assert "並列実装" + "可能性" not in result.stdout
    assert "並列分割の判定基準" not in result.stdout
    assert "**前提**:" not in result.stdout


# 計画は plan mode の前に Issue へ投稿済み。テンプレは投稿した計画を写して承認を求めることだけを案内する。


def test_normal_template_assumes_plan_posted(ctx, script):
    result = _run(script)
    assert result.returncode == 0
    assert "投稿済み" in result.stdout


def test_quick_template_assumes_plan_posted(ctx, script):
    (ctx["state_dir"] / ".pecot-quick-mode").touch()
    result = _run(script)
    assert result.returncode == 0
    assert "投稿済み" in result.stdout


def test_normal_template_no_draft_creation_guidance(ctx, script):
    result = _run(script)
    assert result.returncode == 0
    assert "追加してください" not in result.stdout


def test_quick_template_no_draft_creation_guidance(ctx, script):
    (ctx["state_dir"] / ".pecot-quick-mode").touch()
    result = _run(script)
    assert result.returncode == 0
    assert "追加してください" not in result.stdout


# SC-001（008-plan-mode-minimization 不変条件 1）: plan mode 突入テンプレ本文に
# 調査・レビュアー spawn を指示する文言が無い。injector の静的 heredoc では負アサートが
# vacuous になるため、実リスク面であるテンプレ本文を直接読んで固定する。


def test_reminder_template_file_no_reviewer_spawn_directive(ctx):
    body = (ctx["templates"] / "plan-mode-reminder.md").read_text()
    # レビュアー（w-tech-advisor）の spawn 指示はテンプレ本文に無い。
    # 表中の w-implementer / w-e2e-planner は実装フェーズの構成要素で、plan mode 中の
    # レビュアー spawn ではない。w-tech-advisor はレビュー専任のため不在が SC-001 の目印。
    assert "w-tech-advisor" not in body
