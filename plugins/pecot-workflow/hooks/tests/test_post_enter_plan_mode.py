"""post-tool-use-enter-plan-mode.sh のユニットテスト（test_post_enter_plan_mode.bats 移植）。

plan-mode-reminder テンプレートの注入と JSON 妥当性を検証する。mode 分岐はなく、
config は hook 有効化のみ設定する。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

_JQ = shutil.which("jq")


@pytest.fixture
def hook_script(project_root: Path) -> Path:
    return (
        project_root / "plugins" / "pecot-workflow" / "hooks" / "post-tool-use-enter-plan-mode.sh"
    )


@pytest.fixture
def env_setup(
    project_root: Path,
    tmp_path: Path,
    hooks_config,
    monkeypatch: pytest.MonkeyPatch,
):
    """CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT を構築しテンプレを配置する。"""
    project = tmp_path / "project"
    plugin = tmp_path / "plugin"
    (project / ".pecot" / "state").mkdir(parents=True)
    templates = plugin / "hooks" / "templates"
    templates.mkdir(parents=True)
    shutil.copy(
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "templates"
        / "plan-mode-reminder.md",
        templates,
    )
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))
    # plan-mode-reminder.sh は mode 分岐なし。config は hook 有効化のみ設定する。
    hooks_config.write({"plan-mode-reminder": True})
    return hooks_config


def _run(hook_script: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(hook_script)],
        input="{}",
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_includes_four_points(env_setup, hook_script):
    result = _run(hook_script)
    assert result.returncode == 0
    assert "mode: shared" in result.stdout
    assert "# 【pecot計画モード】" in result.stdout
    assert "$PECOT issue comment --prepare -t plan" in result.stdout
    assert "Context は Context" in result.stdout
    assert "推奨方針は Approach" in result.stdout
    assert "主要ファイルと再利用する既存関数は Files" in result.stdout
    assert "検証は `## PECOT-Workflow` の E2E" in result.stdout
    assert "越境" in result.stdout


def test_output_is_valid_json(env_setup, hook_script):
    result = _run(hook_script)
    assert result.returncode == 0
    if _JQ is not None:
        jq = subprocess.run([_JQ, "."], input=result.stdout, capture_output=True, text=True)
        assert jq.returncode == 0
    else:
        json.loads(result.stdout)


def test_empty_config_common_template(env_setup, hook_script):
    env_setup.write({})
    result = _run(hook_script)
    assert result.returncode == 0
    assert "mode: shared" in result.stdout
    assert "# 【pecot計画モード】" in result.stdout
    assert "$PECOT issue comment --prepare -t plan" in result.stdout
