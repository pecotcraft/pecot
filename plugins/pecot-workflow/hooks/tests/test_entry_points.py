"""post-tool-use-bash.sh / post-tool-use-skill.sh エントリーポイントの統合テスト。

test_entry_points.bats からの移植。エントリスクリプトへ JSON stdin を流し、
hookSpecificOutput への注入を検証する。GIT_* 隔離・test git repo 生成は conftest の
fixture を消費する。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest


@pytest.fixture
def entry_bash(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "post-tool-use-bash.sh"


@pytest.fixture
def entry_skill(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "post-tool-use-skill.sh"


@pytest.fixture
def test_repo(
    git_repo: Callable[..., Path],
    hooks_config,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    """test repo を作り、CLAUDE_PROJECT_DIR をそこへ向ける。

    設定は、auto-push=false / commit-info-display=true / pecot-skill-reminder=true。
    """
    hooks_config.write(
        {
            "auto-push": False,
            "commit-info-display": True,
            "pecot-skill-reminder": True,
        }
    )
    repo = git_repo()
    # commit-info-display が git log -1 を使うため、意味のあるコミットを作成。
    (repo / "test-file.txt").write_text("test content\n")
    subprocess.run(["git", "-C", str(repo), "add", "test-file.txt"], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "commit", "--quiet", "-m", "feat: add auth"],
        check=True,
    )
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    return repo


def _run_entry(script: Path, stdin: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(script)],
        input=stdin,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=25,
    )


# post-tool-use-bash.sh テスト。


def test_post_bash_commit_success_includes_commit_done(test_repo, entry_bash):
    input_json = json.dumps(
        {
            "tool_input": {"command": 'git commit -m "feat: add auth"'},
            "tool_response": {
                "stdout": "[feat/test abc1234] feat: add auth\n 1 file changed, 1 insertion(+)",
                "interrupted": False,
            },
        }
    )
    result = _run_entry(entry_bash, input_json, test_repo)
    assert result.returncode == 0
    assert "note: commit complete" in result.stdout
    assert "hookSpecificOutput" in result.stdout


def test_post_bash_non_commit_command_empty_output(test_repo, entry_bash):
    input_json = json.dumps(
        {
            "tool_input": {"command": "git status"},
            "tool_response": {
                "stdout": "On branch main\nnothing to commit",
                "interrupted": False,
            },
        }
    )
    result = _run_entry(entry_bash, input_json, test_repo)
    assert result.returncode == 0
    assert result.stdout == ""


# post-tool-use-skill.sh テスト。


def test_post_skill_pecot_skill_includes_workflow_message(test_repo, entry_skill):
    input_json = '{"tool_input":{"skill":"pecot-w"}}'
    result = _run_entry(entry_skill, input_json, test_repo)
    assert result.returncode == 0
    assert "note: pecot-workflow skill started" in result.stdout
    assert "hookSpecificOutput" in result.stdout


def test_post_skill_other_skill_empty_output(test_repo, entry_skill):
    input_json = '{"tool_input":{"skill":"other-skill"}}'
    result = _run_entry(entry_skill, input_json, test_repo)
    assert result.returncode == 0
    assert result.stdout == ""
