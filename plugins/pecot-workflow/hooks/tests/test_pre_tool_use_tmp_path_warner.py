"""pre-tool-use/tmp-path-warner.sh のユニットテスト（test_pre_tool_use_tmp_path_warner.bats 移植）。

検証する項目は次のとおり。
Bash コマンド中の /tmp/ 利用検知と .pecot/work/ 誘導、whitelist（find/ls 等の system 調査）。
command-prefix（sudo/env）skip、単語境界・引用符内検出、警告の 1 回集約。
"""

from __future__ import annotations

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
        / "pre-tool-use"
        / "tmp-path-warner.sh"
    )


@pytest.fixture
def config(tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch):
    project = tmp_path / "project"
    project.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    hooks_config.write({"tmp-path-warner": True})
    return hooks_config


# サブスクリプトは stdin の JSON を読まず、PECOT_HOOK_*（hook-input.sh が export）だけを読む。
# そのため、エントリの project-root.sh と同じく hook-input.sh を source してから、対象を起動する。
_SOURCE_HOOK_INPUT = (
    'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"'
)


def _run(script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", _SOURCE_HOOK_INPUT, "_", str(script), stdin],
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_bash_tmp_foo_shows_reminder(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"mkdir -p /tmp/release-smoke"}}',
    )
    assert result.returncode == 0
    assert "Bash コマンドに" in result.stdout
    assert ".pecot/work/" in result.stdout
    assert "PreToolUse" in result.stdout


def test_bash_pecot_work_no_output(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"mkdir -p .pecot/work/655/release-smoke"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_bash_find_tmp_ignored(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"find /tmp/foo -name *.log"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_bash_ls_tmp_ignored(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"ls /tmp/foo"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_bash_tmpfs_word_boundary_ignored(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"cat /tmpfs/data"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_bash_quoted_tmp_foo_shows_reminder(config, script):
    # JSON フィールド command の値は `echo "target=/tmp/foo"`。
    # PreToolUse の実 payload では escape された double quote として届く。
    # regex 境界 `=` で発火することと、double quote 内 path も検出されることを担保。
    result = _run(
        script,
        r'{"tool_name":"Bash","tool_input":{"command":"echo \"target=/tmp/foo\""}}',
    )
    assert result.returncode == 0
    assert ".pecot/work/" in result.stdout


def test_bash_sudo_find_prefix_skip_whitelist(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"sudo find /tmp/foo -name *.log"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_bash_env_ls_prefix_skip_whitelist(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"env ls /tmp/foo"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_bash_sudo_rm_prefix_skip_still_warns(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"sudo rm -rf /tmp/foo"}}',
    )
    assert result.returncode == 0
    assert ".pecot/work/" in result.stdout


def test_bash_multiple_tmp_paths_single_warning(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"mv /tmp/a /tmp/b"}}',
    )
    assert result.returncode == 0
    # additionalContext の出現回数が 1 回（grep -q で短絡しているため）。
    assert result.stdout.count("additionalContext") == 1


def test_bash_single_quote_tmp_foo_shows_reminder(config, script):
    # command の値: awk -v p='/tmp/foo' "BEGIN{print p}"。
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"awk -v p=\'/tmp/foo\' \\"BEGIN{print p}\\""}}',
    )
    assert result.returncode == 0
    assert ".pecot/work/" in result.stdout


def test_bash_out_equals_tmp_foo_shows_reminder(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"some-cmd --out=/tmp/foo"}}',
    )
    assert result.returncode == 0
    assert ".pecot/work/" in result.stdout


def test_no_tool_name_early_exit(config, script):
    result = _run(
        script,
        '{"tool_input":{"command":"mkdir -p /tmp/foo"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_no_command_key_early_exit(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_empty_command_early_exit(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":""}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_edit_tool_not_bash_no_output(config, script):
    result = _run(
        script,
        '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_tmp_alone_no_trailing_slash_no_output(config, script):
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"echo /tmp"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_disabled_via_config_no_output(config, script):
    config.write({"tmp-path-warner": False})
    result = _run(
        script,
        '{"tool_name":"Bash","tool_input":{"command":"mkdir -p /tmp/foo"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""
