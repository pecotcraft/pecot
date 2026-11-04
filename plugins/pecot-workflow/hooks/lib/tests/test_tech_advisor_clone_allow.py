"""tech-advisor-clone-allow コアスクリプトと adapters 統合の自動許可テスト。

w-tech-advisor の定型 clone だけが、自動許可（core: exit 10 / adapters: allow JSON）となる。
定型 clone は、.pecot/work/<数字>/tech-advisor/<名前> 宛の単一の git clone を指す。
envelope 外・コマンド連結・パス遡上・既存 deny ガード該当コマンドは、従来フローのままであることを検証する。
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

ENVELOPE_CMD = "git clone --depth 1 https://github.com/foo/bar .pecot/work/788/tech-advisor/bar"


@pytest.fixture
def allow_script(core_dir: Path) -> Path:
    return core_dir / "tech-advisor-clone-allow.sh"


@pytest.fixture
def claude_bash_guards_script(adapter_dir: Path) -> Path:
    return adapter_dir / "claude-bash-guards.sh"


def _run_core(
    script: Path,
    command: str,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    env = {**os.environ, "HOOK_COMMAND": command}
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["bash", str(script)],
        capture_output=True,
        text=True,
        timeout=25,
        env=env,
    )


# claude-bash-guards は stdin の JSON を読まず PECOT_HOOK_*（hook-input.sh が export）を読む。
_SOURCE_HOOK_INPUT = (
    'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"'
)


def _run_adapter(script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", _SOURCE_HOOK_INPUT, "_", str(script), stdin],
        capture_output=True,
        text=True,
        timeout=25,
    )


# core: envelope 一致 → exit 10（allow 判定）。


def test_envelope_https_allows(allow_script, hooks_config):
    hooks_config.write({})
    result = _run_core(allow_script, ENVELOPE_CMD)
    assert result.returncode == 10
    assert "自動許可" in result.stdout


def test_envelope_git_at_allows(allow_script, hooks_config):
    hooks_config.write({})
    cmd = "git clone git@github.com:foo/bar.git .pecot/work/12/tech-advisor/bar"
    result = _run_core(allow_script, cmd)
    assert result.returncode == 10


def test_envelope_no_options_allows(allow_script, hooks_config):
    hooks_config.write({})
    cmd = "git clone https://github.com/foo/bar .pecot/work/3/tech-advisor/bar"
    result = _run_core(allow_script, cmd)
    assert result.returncode == 10


def test_envelope_trailing_slash_and_dotted_name_allows(allow_script, hooks_config):
    hooks_config.write({})
    cmd = "git clone https://github.com/foo/bar.js .pecot/work/788/tech-advisor/bar.js/"
    result = _run_core(allow_script, cmd)
    assert result.returncode == 10


def test_envelope_equals_option_allows(allow_script, hooks_config):
    hooks_config.write({})
    cmd = (
        "git clone --depth=1 --branch=v1.0 https://github.com/foo/bar"
        " .pecot/work/788/tech-advisor/bar"
    )
    result = _run_core(allow_script, cmd)
    assert result.returncode == 10


# core: allowlist 内オプション → exit 10（F-01）。


@pytest.mark.parametrize(
    "command",
    [
        # 空白区切りの文字列値（--branch）も allowlist 内オプションなら許可。
        "git clone --branch main https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        "git clone --single-branch https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        "git clone --no-tags https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        "git clone --quiet https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        "git clone --filter=blob:none https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        "git clone --filter tree:0 https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        "git clone --depth 1 --single-branch https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
    ],
)
def test_allowlisted_option_allows(allow_script, hooks_config, command):
    hooks_config.write({})
    result = _run_core(allow_script, command)
    assert result.returncode == 10


# core: allowlist 外オプション（危険オプション含む） → exit 0（F-01 負テスト）。


@pytest.mark.parametrize(
    "command",
    [
        "git clone --upload-pack=/bin/sh https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        "git clone --template=/etc/passwd https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        "git clone --separate-git-dir=/tmp/x https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        "git clone --recurse-submodules https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
        # allowlist 外の未知オプション。
        "git clone --verbose https://github.com/foo/bar .pecot/work/788/tech-advisor/bar",
    ],
)
def test_disallowed_option_no_allow(allow_script, hooks_config, command):
    hooks_config.write({})
    result = _run_core(allow_script, command)
    assert result.returncode == 0
    assert result.stdout == ""


# core: DEST の絶対パス / ./ 前置形（F-02）。


def test_dest_dot_slash_prefix_allows(allow_script, hooks_config):
    hooks_config.write({})
    cmd = "git clone https://github.com/foo/bar ./.pecot/work/788/tech-advisor/bar"
    result = _run_core(allow_script, cmd)
    assert result.returncode == 10


def test_dest_absolute_under_project_allows(allow_script, hooks_config):
    hooks_config.write({})
    cmd = "git clone https://github.com/foo/bar /workspaces/proj/.pecot/work/788/tech-advisor/bar"
    result = _run_core(allow_script, cmd, extra_env={"HOOK_WORKING_DIR": "/workspaces/proj"})
    assert result.returncode == 10


def test_dest_absolute_outside_project_no_allow(allow_script, hooks_config):
    hooks_config.write({})
    cmd = "git clone https://github.com/foo/bar /tmp/.pecot/work/788/tech-advisor/bar"
    result = _run_core(allow_script, cmd, extra_env={"HOOK_WORKING_DIR": "/workspaces/proj"})
    assert result.returncode == 0
    assert result.stdout == ""


# core: envelope 外 → exit 0（判定なし・無出力）。


@pytest.mark.parametrize(
    "command",
    [
        # clone 先が tech-advisor 配下でない。
        "git clone https://github.com/foo/bar .pecot/work/788/lib/bar",
        "git clone https://github.com/foo/bar /tmp/bar",
        "git clone https://github.com/foo/bar bar",
        # コマンド連結・展開。
        ENVELOPE_CMD + " && rm -rf important",
        "git clone https://github.com/foo/bar .pecot/work/788/tech-advisor/bar; ls",
        "git clone $(echo url) .pecot/work/788/tech-advisor/bar",
        # パス遡上。
        "git clone https://github.com/foo/bar .pecot/work/788/tech-advisor/../escape",
        # Issue 番号が数字でない。
        "git clone https://github.com/foo/bar .pecot/work/abc/tech-advisor/bar",
        # clone 以外。
        "git checkout main",
    ],
)
def test_out_of_envelope_no_allow(allow_script, hooks_config, command):
    hooks_config.write({})
    result = _run_core(allow_script, command)
    assert result.returncode == 0
    assert result.stdout == ""


def test_multiline_command_no_allow(allow_script, hooks_config):
    hooks_config.write({})
    result = _run_core(allow_script, ENVELOPE_CMD + "\nrm -rf important")
    assert result.returncode == 0
    assert result.stdout == ""


# core: HOOK_COMMAND 未設定・空文字 → exit 2 + stderr（F-03）。


def test_empty_command_exit_2(allow_script, hooks_config):
    hooks_config.write({})
    result = _run_core(allow_script, "")
    assert result.returncode == 2
    assert result.stdout == ""
    assert "HOOK_COMMAND environment variable is required" in result.stderr


def test_unset_command_exit_2(allow_script, hooks_config):
    hooks_config.write({})
    env = {**os.environ}
    env.pop("HOOK_COMMAND", None)
    result = subprocess.run(
        ["bash", str(allow_script)],
        capture_output=True,
        text=True,
        timeout=25,
        env=env,
    )
    assert result.returncode == 2
    assert "HOOK_COMMAND environment variable is required" in result.stderr


# core: config の設定で無効化できる。


def test_config_disable_no_allow(allow_script, hooks_config):
    hooks_config.write({"tech-advisor-clone-allow": False})
    result = _run_core(allow_script, ENVELOPE_CMD)
    assert result.returncode == 0
    assert result.stdout == ""


# claude-bash-guards: allow JSON 出力と deny ガード温存。


def test_claude_adapter_envelope_allows(
    claude_bash_guards_script, claude_project_dir, hooks_config
):
    hooks_config.write({})
    stdin = json.dumps({"tool_input": {"command": ENVELOPE_CMD}})
    result = _run_adapter(claude_bash_guards_script, stdin)
    assert result.returncode == 0
    assert '"permissionDecision": "allow"' in result.stdout
    assert '"hookEventName": "PreToolUse"' in result.stdout


def test_claude_adapter_deny_guard_wins(
    claude_bash_guards_script, claude_project_dir, hooks_config
):
    hooks_config.write({})
    stdin = json.dumps({"tool_input": {"command": "git commit --no-verify -m x"}})
    result = _run_adapter(claude_bash_guards_script, stdin)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"permissionDecision": "allow"' not in result.stdout


def test_claude_adapter_benign_command_silent(
    claude_bash_guards_script, claude_project_dir, hooks_config
):
    hooks_config.write({})
    stdin = json.dumps({"tool_input": {"command": "ls -la"}})
    result = _run_adapter(claude_bash_guards_script, stdin)
    assert result.returncode == 0
    assert result.stdout == ""


# claude-bash-guards: envelope 形状＋チェーン構文 → allow が出ない（F-06）。


def test_claude_adapter_envelope_with_chaining_no_allow(
    claude_bash_guards_script, claude_project_dir, hooks_config
):
    # tech-advisor-clone-allow の envelope に見える形状でも && が付くと不一致 →
    # allow が出ないことを adapter レベルで固定する。
    hooks_config.write({})
    stdin = json.dumps({"tool_input": {"command": ENVELOPE_CMD + " && rm -rf important"}})
    result = _run_adapter(claude_bash_guards_script, stdin)
    assert result.returncode == 0
    assert "permissionDecision" not in result.stdout


# Copilot CLI 1.0.103: 同じガードが snake_case の入力で動く（camelCase の手段は無い）。


def _copilot_stdin(command: str) -> str:
    return json.dumps(
        {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}}
    )


def test_copilot_snake_case_envelope_allows(
    claude_bash_guards_script, claude_project_dir, hooks_config
):
    hooks_config.write({})
    result = _run_adapter(claude_bash_guards_script, _copilot_stdin(ENVELOPE_CMD))
    assert result.returncode == 0
    assert '"permissionDecision": "allow"' in result.stdout


def test_copilot_snake_case_deny_guard_wins(
    claude_bash_guards_script, claude_project_dir, hooks_config
):
    hooks_config.write({})
    result = _run_adapter(claude_bash_guards_script, _copilot_stdin("git commit --no-verify -m x"))
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
