"""hooks-config.json 個別無効化テスト（test_hooks_config_disable.bats からの移植・SC-004）。

各フック機能を hooks-config.json で false に設定すると動作しないことを検証する。
GIT_* 隔離・test git repo 生成・hooks-config 隔離は conftest の fixture が担保する。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

_COMMIT_SUCCESS_JSON = json.dumps(
    {
        "tool_input": {"command": 'git commit -m "feat: add auth"'},
        "tool_response": {
            "stdout": "[feat/test abc1234] feat: add auth\n 1 file changed, 1 insertion(+)",
            "interrupted": False,
        },
    }
)

_GH_PR_CREATE_JSON = json.dumps(
    {"tool_input": {"command": 'gh pr create --title "feat: test" --body "test"'}}
)


def _pecot_skill_json(skill: str = "pecot-w") -> str:
    return json.dumps({"tool_input": {"skill": skill}})


@pytest.fixture
def disable_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    """bats setup() 相当: PECOT_HOOKS_CONFIG_PATH / CLAUDE_PROJECT_DIR を設定する。

    hooks-config の内容は各テストが書く。config path を返す。
    """
    config_path = tmp_path / "hooks-config.json"
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(config_path))
    project = tmp_path / "project"
    (project / "tmp").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    return config_path


# サブスクリプトは stdin の JSON を読まず PECOT_HOOK_* / PECOT_POST_* を読む。エントリと同じ前段
# （hook-input.sh / project-root.sh + bash-post-match.sh）を source してから起動する。
# エントリ（hooks/ 直下）は stdin をそのまま渡す。
_SOURCE_HOOK_INPUT = (
    'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"'
)
_SOURCE_POST_MATCH = (
    "PECOT_PROJECT_ROOT_LAZY=1; "
    'source "$(dirname "$1")/../core/project-root.sh" "$2" && '
    'source "$(dirname "$1")/bash-post-match.sh" "$2" && exec bash "$1"'
)


def _run(argv: list[str], stdin: str, cwd: str | Path | None = None) -> subprocess.CompletedProcess:
    script = Path(argv[-1])
    if script.parent.name == "post-tool-use":
        argv = ["bash", "-c", _SOURCE_POST_MATCH, "_", str(script), stdin]
        stdin = ""
    elif script.parent.name == "lib" or script.parent.parent.name == "lib":
        argv = ["bash", "-c", _SOURCE_HOOK_INPUT, "_", str(script), stdin]
        stdin = ""
    return subprocess.run(
        argv,
        input=stdin,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=25,
    )


# commit-info-display: false / true


def test_commit_info_display_false_no_output(
    disable_env: Path,
    core_dir: Path,
    git_repo: Callable[..., Path],
):
    disable_env.write_text(json.dumps({"commit-info-display": False}))
    script = core_dir.parent / "post-tool-use" / "commit-info-display.sh"
    repo = git_repo()

    result = _run(["bash", str(script)], _COMMIT_SUCCESS_JSON, cwd=repo)
    assert result.returncode == 0
    assert result.stdout == ""


def test_commit_info_display_true_has_output(
    disable_env: Path,
    core_dir: Path,
    git_repo: Callable[..., Path],
):
    disable_env.write_text(json.dumps({"commit-info-display": True}))
    script = core_dir.parent / "post-tool-use" / "commit-info-display.sh"
    repo = git_repo()

    result = _run(["bash", str(script)], _COMMIT_SUCCESS_JSON, cwd=repo)
    assert result.returncode == 0
    assert "note: commit complete" in result.stdout


# claude-bash-guards: false / true


def _setup_plugin_root(
    tmp_path: Path,
    core_dir: Path,
    adapter_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CLAUDE_PLUGIN_ROOT に core/adapters の symlink を配置する（bats と同一構成）。"""
    plugin_root = tmp_path / "plugin"
    (plugin_root / "hooks" / "lib").mkdir(parents=True)
    (plugin_root / "hooks" / "lib" / "core").symlink_to(core_dir)
    (plugin_root / "hooks" / "lib" / "adapters").symlink_to(adapter_dir)
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin_root))


def test_claude_bash_guards_false_gh_pr_not_blocked(
    disable_env: Path,
    project_root: Path,
    core_dir: Path,
    adapter_dir: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    disable_env.write_text(json.dumps({"claude-bash-guards": False}))
    pre_tool_use_bash = (
        project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use-bash.sh"
    )
    _setup_plugin_root(tmp_path, core_dir, adapter_dir, monkeypatch)

    result = _run(["bash", str(pre_tool_use_bash)], _GH_PR_CREATE_JSON)
    assert result.returncode == 0
    # ブロック JSON が出力されないことを確認
    assert '"permissionDecision": "deny"' not in result.stdout
    assert '"decision"' not in result.stdout


def test_claude_bash_guards_true_gh_pr_blocked(
    disable_env: Path,
    project_root: Path,
    core_dir: Path,
    adapter_dir: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    disable_env.write_text(json.dumps({"claude-bash-guards": True}))
    pre_tool_use_bash = (
        project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use-bash.sh"
    )
    _setup_plugin_root(tmp_path, core_dir, adapter_dir, monkeypatch)

    result = _run(["bash", str(pre_tool_use_bash)], _GH_PR_CREATE_JSON)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout


# pecot-skill-reminder: false / true


def test_pecot_skill_reminder_false_no_warning(disable_env: Path, core_dir: Path):
    disable_env.write_text(json.dumps({"pecot-skill-reminder": False}))
    script = core_dir.parent / "post-tool-use" / "pecot-skill-reminder.sh"

    result = _run(["bash", str(script)], _pecot_skill_json("pecot-w"))
    assert result.returncode == 0
    assert result.stdout == ""


def test_pecot_skill_reminder_true_has_warning(disable_env: Path, core_dir: Path):
    disable_env.write_text(json.dumps({"pecot-skill-reminder": True}))
    script = core_dir.parent / "post-tool-use" / "pecot-skill-reminder.sh"

    result = _run(["bash", str(script)], _pecot_skill_json("pecot-w"))
    assert result.returncode == 0
    assert "note: pecot-workflow skill started" in result.stdout


def test_pecot_skill_reminder_false_a_quick_no_warning(disable_env: Path, core_dir: Path):
    disable_env.write_text(json.dumps({"pecot-skill-reminder": False}))
    script = core_dir.parent / "post-tool-use" / "pecot-skill-reminder.sh"

    result = _run(["bash", str(script)], _pecot_skill_json("pecot-w:w-quick"))
    assert result.returncode == 0
    assert result.stdout == ""


# external-post-check のキー: false で ask（exit 11）が抑止され、true で ask される。
# pecot-pr-create-ask・pecot-issue-create-ask は MCP ハンドラの pecot-post-ask.sh が見る。


@pytest.mark.parametrize(
    ("config_key", "command"),
    [
        ("gh-pr-merge-ask", "gh pr merge 810"),
    ],
)
def test_external_post_key_false_passes(
    disable_env: Path,
    core_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    config_key: str,
    command: str,
):
    disable_env.write_text(json.dumps({config_key: False}))
    monkeypatch.setenv("HOOK_COMMAND", command)
    script = core_dir / "external-post-check.sh"

    result = _run(["bash", str(script)], "")
    assert result.returncode == 0
    assert result.stdout == ""


@pytest.mark.parametrize(
    ("config_key", "command", "expected_exit"),
    [
        ("gh-pr-merge-ask", "gh pr merge 810", 11),
    ],
)
def test_external_post_key_true_asks(
    disable_env: Path,
    core_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    config_key: str,
    command: str,
    expected_exit: int,
):
    disable_env.write_text(json.dumps({config_key: True}))
    monkeypatch.setenv("HOOK_COMMAND", command)
    script = core_dir / "external-post-check.sh"

    result = _run(["bash", str(script)], "")
    assert result.returncode == expected_exit
    assert "warning: external-post-check:" in result.stdout


# pecot-cli-deny: false で deny（exit 1）が抑止され、true で deny される


def test_pecot_cli_deny_key_false_passes(
    disable_env: Path, core_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    disable_env.write_text(json.dumps({"pecot-cli-deny": False}))
    monkeypatch.setenv("HOOK_COMMAND", "pecot issue read 1")

    result = _run(["bash", str(core_dir / "pecot-cli-deny.sh")], "")
    assert result.returncode == 0
    assert result.stdout == ""


def test_pecot_cli_deny_key_true_denies(
    disable_env: Path, core_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    disable_env.write_text(json.dumps({"pecot-cli-deny": True}))
    monkeypatch.setenv("HOOK_COMMAND", "pecot issue read 1")

    result = _run(["bash", str(core_dir / "pecot-cli-deny.sh")], "")
    assert result.returncode == 1
    assert "MCP tool issue_read" in result.stdout
