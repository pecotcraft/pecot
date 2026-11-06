"""user-prompt-submit ロジックスクリプトのユニットテスト
（test_user_prompt_submit_features.bats 移植）。

workflow-compliance-injector を検証する。
テストは 2 種類ある。
JSON stdin を流すものと、state ファイルの配置で挙動が変わるもの。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def ups_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, project_root: Path) -> dict:
    """bats setup() 相当。CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT / PLUGIN_HOOKS と
    state ディレクトリを用意する。
    """
    project = tmp_path / "project"
    plugin = tmp_path / "plugin"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))
    monkeypatch.setenv("PLUGIN_HOOKS", str(plugin / "hooks"))

    return {
        "project": project,
        "plugin": plugin,
        "state_dir": state_dir,
        "script_dir": project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "user-prompt-submit",
        "project_root": project_root,
    }


def _run_piped(run_script, script: Path, stdin: str):
    """JSON stdin をスクリプトに流す（bats の bash -c 'echo ... | "$1"' 相当）。"""
    return run_script(script, stdin=stdin)


# workflow-compliance-injector.sh


@pytest.mark.parametrize(
    "prompt",
    [
        "/pecot-w:w-active",
        "/w-active",  # 名前空間なしの短縮形（#939）
        "/w-pr レビュー用に作成",
    ],
)
def test_workflow_injector_pecot_command_outputs_notes(ups_env, run_script, prompt: str) -> None:
    """名前空間付き・短縮形のどちらの入力でも指示テキストを出すこと。

    UserPromptSubmit の .prompt にはユーザーの生入力がそのまま渡るため、短縮形で
    起動されたときは名前空間が付かない。フル修飾だけを見ていると注入が不発になる。
    """
    result = _run_piped(
        run_script,
        ups_env["script_dir"] / "workflow-compliance-injector.sh",
        f'{{"prompt": "{prompt}"}}',
    )
    assert result.returncode == 0
    assert "pecot workflow notes" in result.stdout


@pytest.mark.parametrize(
    "prompt",
    [
        "/pecotfoo",
        "/help",
        "/v-slidev",
        # ハイフン形は Claude Code が正規形へ変換するため .prompt に現れない（#939 確認）。
        # 捕捉対象から外した判断をここで固定する。
        "/pecot-a-active",
    ],
)
def test_workflow_injector_non_pecot_slash_no_output(ups_env, run_script, prompt: str) -> None:
    """pecot コマンドとして .prompt に現れない入力では出力しないこと。

    短縮形の捕捉は `w-` プレフィックス（pecot の命名規約）に限る。`/` 全般へ広げると
    あらゆるスラッシュコマンドに指示テキストが入り込む。
    """
    result = _run_piped(
        run_script,
        ups_env["script_dir"] / "workflow-compliance-injector.sh",
        f'{{"prompt": "{prompt}"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


@pytest.mark.parametrize("prompt", ["手順:\n/w-pr を使う", "手順:\n/pecot-w:w-pr を使う"])
def test_workflow_injector_command_on_second_line_no_output(
    ups_env, run_script, prompt: str
) -> None:
    """先頭行のみを判定対象にする。2 行目以降のスラッシュコマンドは対象外。

    地の文でコマンド名に言及しただけの入力に指示テキストを混ぜないため
    （create-slash-flag.sh と同じ判定スコープ）。改行を含むため stdin は
    json.dumps で組み立てる。
    """
    result = _run_piped(
        run_script,
        ups_env["script_dir"] / "workflow-compliance-injector.sh",
        json.dumps({"prompt": prompt}),
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_workflow_injector_normal_text_no_output(ups_env, run_script) -> None:
    result = _run_piped(
        run_script,
        ups_env["script_dir"] / "workflow-compliance-injector.sh",
        '{"prompt": "hello world"}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_workflow_injector_empty_prompt_no_output(ups_env, run_script) -> None:
    result = _run_piped(
        run_script,
        ups_env["script_dir"] / "workflow-compliance-injector.sh",
        '{"prompt": ""}',
    )
    assert result.returncode == 0
    assert result.stdout == ""
