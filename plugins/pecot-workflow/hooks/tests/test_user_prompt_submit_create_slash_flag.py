"""user-prompt-submit/create-slash-flag.sh のユニットテスト。

w-pr 検知で、pr-create-slash-pending を作成することを検証する。
起票系 4 コマンドの検知では、issue-create-slash-pending（内容 = 起点コマンド名）を作成する。
4 コマンドは、w-quick / w-ready / w-backlog / w-issueize。

UserPromptSubmit の .prompt にはユーザーの生入力がそのまま渡り、Claude Code は
プラグインコマンドを名前空間なしの短縮形（`/w-pr`）でも受け付ける。フル修飾
（`/pecot-w:w-pr`）と短縮形の双方で検知することを固定する（#939）。

フラグは「投稿成功まで生存する一発券」（削除は CLI 消費・セッション開始掃除）で
あり、本スクリプトは設置のみを行う。非対象プロンプトで既存フラグを削除しない
ことも検証する（ターン跨ぎ聞き返しフローの生存要件）。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

_ISSUE_COMMANDS = ["w-quick", "w-ready", "w-backlog", "w-issueize"]


@pytest.fixture
def script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "user-prompt-submit"
        / "create-slash-flag.sh"
    )


@pytest.fixture
def ctx(tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch):
    project = tmp_path / "project"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    hooks_config.write({"pr-create-slash-flag": True, "issue-create-slash-flag": True})
    return {
        "pr_flag": state_dir / "pr-create-slash-pending",
        "issue_flag": state_dir / "issue-create-slash-pending",
        "config": hooks_config,
    }


def _run(script: Path, prompt: str) -> subprocess.CompletedProcess:
    """プロンプト文字列を UserPromptSubmit JSON に包んで実行する。

    改行・引用符を含むプロンプトを扱うため、stdin は json.dumps で組み立てる
    （文字列連結だと `\\n` のエスケープ段数をテスト側で数える必要が出る）。
    """
    return subprocess.run(
        ["bash", str(script)],
        input=json.dumps({"prompt": prompt}),
        capture_output=True,
        text=True,
        timeout=25,
    )


@pytest.mark.parametrize("prompt", ["/pecot-w:w-pr", "/w-pr"])
def test_a_pr_creates_pr_flag(ctx, script, prompt):
    """フル修飾・短縮形のどちらでも pr フラグが立つこと。"""
    result = _run(script, prompt)
    assert result.returncode == 0
    assert ctx["pr_flag"].is_file()
    assert not ctx["issue_flag"].is_file()


@pytest.mark.parametrize("prompt", ["/pecot-w:w-pr レビュー用に作成", "/w-pr レビュー用に作成"])
def test_a_pr_with_args_creates_pr_flag(ctx, script, prompt):
    result = _run(script, prompt)
    assert result.returncode == 0
    assert ctx["pr_flag"].is_file()


@pytest.mark.parametrize("prefix", ["/pecot-w:", "/"])
@pytest.mark.parametrize("origin", _ISSUE_COMMANDS)
def test_issue_commands_create_issue_flag_with_origin(ctx, script, prefix, origin):
    """短縮形でも issue フラグが立ち、内容は名前空間なしの起点コマンド名になること。"""
    result = _run(script, f"{prefix}{origin} 何かする")
    assert result.returncode == 0
    assert ctx["issue_flag"].is_file()
    assert ctx["issue_flag"].read_text().strip() == origin
    assert not ctx["pr_flag"].is_file()


@pytest.mark.parametrize(
    "prompt",
    [
        "/pecot-w:w-prfoo",
        "/w-prfoo",
        "/pecot-w:w-quickfoo",
        "/w-quickfoo",
        "/pecot-w:w-active",  # 起票しないコマンドは対象外
        "/w-active",
        "PRを作って",
        "issueを起票して",
    ],
)
def test_non_target_prompt_no_flag(ctx, script, prompt):
    result = _run(script, prompt)
    assert result.returncode == 0
    assert not ctx["pr_flag"].is_file()
    assert not ctx["issue_flag"].is_file()


def test_pr_flag_disabled_via_config(ctx, script):
    ctx["config"].write({"pr-create-slash-flag": False, "issue-create-slash-flag": True})
    result = _run(script, "/pecot-w:w-pr")
    assert result.returncode == 0
    assert not ctx["pr_flag"].is_file()


def test_issue_flag_disabled_via_config(ctx, script):
    ctx["config"].write({"pr-create-slash-flag": True, "issue-create-slash-flag": False})
    result = _run(script, "/pecot-w:w-quick 何か直す")
    assert result.returncode == 0
    assert not ctx["issue_flag"].is_file()


def test_multiline_prompt_command_on_second_line_no_flag(ctx, script):
    """先頭行のみを判定対象にする。2 行目以降のスラッシュコマンドは対象外。"""
    result = _run(script, "手順:\n/pecot-w:w-quick を使う")
    assert result.returncode == 0
    assert not ctx["issue_flag"].is_file()


def test_multiline_prompt_shorthand_on_second_line_no_flag(ctx, script):
    """短縮形の捕捉を足しても、先頭行のみ判定という設計は変わらないこと。"""
    result = _run(script, "手順:\n/w-quick を使う")
    assert result.returncode == 0
    assert not ctx["issue_flag"].is_file()


def test_existing_flags_survive_normal_prompt(ctx, script):
    """非対象プロンプトで既存フラグを削除しない（ターン跨ぎ聞き返しフローの生存）。"""
    ctx["pr_flag"].touch()
    ctx["issue_flag"].write_text("w-quick\n")
    result = _run(script, "補足: リポは aist-plugin で")
    assert result.returncode == 0
    assert ctx["pr_flag"].is_file()
    assert ctx["issue_flag"].is_file()


def test_existing_issue_flag_overwritten_by_new_command(ctx, script):
    """起票系コマンドの再実行で内容（起点コマンド名）が更新される。"""
    ctx["issue_flag"].write_text("w-quick\n")
    result = _run(script, "/pecot-w:w-issueize specs/1/tasks.md")
    assert result.returncode == 0
    assert ctx["issue_flag"].read_text().strip() == "w-issueize"


def test_pecot_dir_missing_writes_nothing(
    script, hooks_config, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """`.pecot` が無いプロジェクトではフラグを立てず、ディレクトリも作らないこと。

    pecot 未使用リポで `.pecot` を新規作成しないのは、gitignore-before-write 規約（#666）による。
    書き込みを止めているのは pecot_state_dir_ensure のガードだけ。
    これが外れると、CLAUDE_PROJECT_DIR 配下（未設定なら空展開でルート直下）に `.pecot/state` が生える。
    検証先を存在しない tmp パスに固定し、実 FS の状態へ依存させない。
    """
    hooks_config.write({"pr-create-slash-flag": True, "issue-create-slash-flag": True})
    project = tmp_path / "missing-project"
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    result = _run(script, "/w-pr")

    assert result.returncode == 0
    assert not project.exists()
