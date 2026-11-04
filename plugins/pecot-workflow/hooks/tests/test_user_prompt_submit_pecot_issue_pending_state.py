"""user-prompt-submit/pecot-issue-pending-state.sh のユニットテスト。
（test_user_prompt_submit_pecot_issue_pending_state.bats 移植）。

スラッシュコマンド経由の w-quick / w-ready 検知で、issue-pending フラグを作成する。
対象外スキル・部分一致・通常プロンプト・config 無効時は、作成しないことを検証する。

UserPromptSubmit の .prompt にはユーザーの生入力がそのまま渡る。
Claude Code は、プラグインコマンドを名前空間なしの短縮形（`/w-quick`）でも受け付ける。
フル修飾（`/pecot-w:w-quick`）と短縮形の双方で検知することを固定する（#939）。
"""

from __future__ import annotations

import json
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
        / "user-prompt-submit"
        / "pecot-issue-pending-state.sh"
    )


@pytest.fixture
def ctx(tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch):
    project = tmp_path / "project"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    hooks_config.write({"pecot-issue-pending-state": True})
    return {"flag": state_dir / "issue-pending", "config": hooks_config}


def _run(script: Path, prompt: str) -> subprocess.CompletedProcess:
    """プロンプト文字列を UserPromptSubmit JSON に包んで実行する。

    改行・引用符を含むプロンプトを扱うため、stdin は json.dumps で組み立てる。
    """
    return subprocess.run(
        ["bash", str(script)],
        input=json.dumps({"prompt": prompt}),
        capture_output=True,
        text=True,
        timeout=25,
    )


@pytest.mark.parametrize("prefix", ["/pecot-w:", "/"])
def test_a_quick_creates_flag_with_content(ctx, script, prefix):
    result = _run(script, f"{prefix}w-quick READMEのtypo修正")
    assert result.returncode == 0
    assert ctx["flag"].is_file()
    assert ctx["flag"].read_text().strip() == "w-quick"


@pytest.mark.parametrize("prefix", ["/pecot-w:", "/"])
def test_a_ready_creates_flag_with_content(ctx, script, prefix):
    result = _run(script, f"{prefix}w-ready Epic配下にサブタスク")
    assert result.returncode == 0
    assert ctx["flag"].is_file()
    assert ctx["flag"].read_text().strip() == "w-ready"


@pytest.mark.parametrize("prompt", ["/pecot-w:w-quick", "/w-quick"])
def test_a_quick_standalone_creates_flag(ctx, script, prompt):
    result = _run(script, prompt)
    assert result.returncode == 0
    assert ctx["flag"].is_file()


@pytest.mark.parametrize("prompt", ["/pecot-w:w-active", "/w-active"])
def test_a_active_no_flag(ctx, script, prompt):
    result = _run(script, prompt)
    assert result.returncode == 0
    assert not ctx["flag"].is_file()


@pytest.mark.parametrize("prompt", ["/pecot-w:w-quickfoo", "/w-quickfoo"])
def test_a_quickfoo_partial_match_no_flag(ctx, script, prompt):
    result = _run(script, prompt)
    assert result.returncode == 0
    assert not ctx["flag"].is_file()


@pytest.mark.parametrize("prompt", ["手順:\n/pecot-w:w-quick を使う", "手順:\n/w-quick を使う"])
def test_command_on_second_line_no_flag(ctx, script, prompt):
    """先頭行のみを判定対象にする。2 行目以降のスラッシュコマンドは対象外。

    地の文でコマンド名に言及しただけの入力で起票リマインダーを起動しないため
    （create-slash-flag.sh と同じ判定スコープ）。
    """
    result = _run(script, prompt)
    assert result.returncode == 0
    assert not ctx["flag"].is_file()


def test_normal_prompt_no_flag(ctx, script):
    result = _run(script, "普通のメッセージ")
    assert result.returncode == 0
    assert not ctx["flag"].is_file()


def test_disabled_via_config_no_flag(ctx, script):
    ctx["config"].write({"pecot-issue-pending-state": False})
    result = _run(script, "/pecot-w:w-quick")
    assert result.returncode == 0
    assert not ctx["flag"].is_file()
