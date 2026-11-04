"""config-dispatcher.sh のテスト（test_config_dispatcher.bats 移植）。

pecot_hook_enabled 関数の 8 パターンと、hooks-config.json による各 hook 無効化の
統合テスト、PLUGIN_HOOKS 解決を検証する。pecot_hook_enabled は source が必要な関数の
ため bash -c で source してから呼ぶ。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def dispatcher(core_dir: Path) -> Path:
    return core_dir / "config-dispatcher.sh"


@pytest.fixture
def config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """PECOT_HOOKS_CONFIG_PATH を tmp の hooks-config.json に向ける（書き込みは各テストが行う）。"""
    path = tmp_path / "hooks-config.json"
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(path))
    return path


def _hook_enabled(
    dispatcher: Path,
    hook: str,
    default: str,
    *,
    capture_stderr: bool = False,
) -> subprocess.CompletedProcess:
    """source dispatcher && pecot_hook_enabled <hook> <default> を実行する。"""
    return subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; pecot_hook_enabled "$2" "$3"',
            "_",
            str(dispatcher),
            hook,
            default,
        ],
        capture_output=True,
        text=True,
        timeout=25,
    )


# pecot_hook_enabled テスト（8パターン）


def test_config_false_returns_disabled(dispatcher, config_path) -> None:
    config_path.write_text('{"test-hook": false}')
    assert _hook_enabled(dispatcher, "test-hook", "true").returncode != 0


def test_config_true_returns_enabled(dispatcher, config_path) -> None:
    config_path.write_text('{"test-hook": true}')
    assert _hook_enabled(dispatcher, "test-hook", "false").returncode == 0


def test_no_key_default_true_enabled(dispatcher, config_path) -> None:
    config_path.write_text('{"other-hook": false}')
    assert _hook_enabled(dispatcher, "test-hook", "true").returncode == 0


def test_no_key_default_false_disabled(dispatcher, config_path) -> None:
    config_path.write_text('{"other-hook": true}')
    assert _hook_enabled(dispatcher, "test-hook", "false").returncode != 0


def test_missing_file_default_true_enabled(dispatcher, config_path) -> None:
    config_path.unlink(missing_ok=True)
    assert _hook_enabled(dispatcher, "test-hook", "true").returncode == 0


def test_missing_file_default_false_disabled(dispatcher, config_path) -> None:
    config_path.unlink(missing_ok=True)
    assert _hook_enabled(dispatcher, "test-hook", "false").returncode != 0


def test_syntax_error_warns_and_uses_default(dispatcher, config_path) -> None:
    config_path.write_text("{invalid json}")
    result = _hook_enabled(dispatcher, "test-hook", "true")
    # return 0（デフォルト値 true = 有効）
    assert result.returncode == 0
    # stderr に WARNING が含まれる
    assert "WARNING" in result.stderr


def test_empty_file_uses_default(dispatcher, config_path) -> None:
    config_path.write_text("")
    assert _hook_enabled(dispatcher, "test-hook", "true").returncode == 0


# 統合テスト: hooks-config.json によるスクリプト無効化


def _run_gh_check(core_dir: Path, command: str, config_path: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(core_dir / "gh-command-check.sh")],
        capture_output=True,
        text=True,
        timeout=25,
        env={
            **os.environ,
            "HOOK_COMMAND": command,
            "PECOT_HOOKS_CONFIG_PATH": str(config_path),
        },
    )


def test_gh_pr_create_disabled_by_config(core_dir, config_path) -> None:
    config_path.write_text('{"gh-pr-create-check": false}')
    result = _run_gh_check(core_dir, "gh pr create --title test", config_path)
    assert result.returncode == 0
    assert result.stdout == ""


def test_gh_issue_create_disabled_by_config(core_dir, config_path) -> None:
    config_path.write_text('{"gh-issue-create-check": false}')
    result = _run_gh_check(core_dir, "gh issue create --title test", config_path)
    assert result.returncode == 0
    assert result.stdout == ""


def test_gh_pr_disabled_still_blocks_issue(core_dir, config_path) -> None:
    config_path.write_text('{"gh-pr-create-check": false}')
    result = _run_gh_check(core_dir, "gh issue create --title test", config_path)
    assert result.returncode == 1
    assert "gh issue create" in result.stdout


def test_gh_issue_disabled_still_blocks_pr(core_dir, config_path) -> None:
    config_path.write_text('{"gh-issue-create-check": false}')
    result = _run_gh_check(core_dir, "gh pr create --title test", config_path)
    assert result.returncode == 1
    assert "gh pr create" in result.stdout


def test_both_disabled_both_pass(core_dir, config_path) -> None:
    config_path.write_text('{"gh-pr-create-check": false, "gh-issue-create-check": false}')

    result = _run_gh_check(core_dir, "gh pr create --title test", config_path)
    assert result.returncode == 0
    assert result.stdout == ""

    result = _run_gh_check(core_dir, "gh issue create --title test", config_path)
    assert result.returncode == 0
    assert result.stdout == ""


def test_claude_adapter_disabled_by_config(adapter_dir, core_dir, config_path, tmp_path) -> None:
    """claude-adapter.sh（Pattern B）が hooks-config.json false で無効化される。

    bats 版は claude-adapter.sh を source し run_claude_guard を呼ぶ。同じ手段を bash -c で再現する。
    """
    config_path.write_text('{"claude-adapter": false}')
    project = tmp_path / "adapter-project"
    project.mkdir(parents=True)
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; echo \'{"tool_input":{"command":"gh pr create"}}\' '
            '| run_claude_guard "$2"',
            "_",
            str(adapter_dir / "claude-adapter.sh"),
            str(core_dir / "gh-command-check.sh"),
        ],
        capture_output=True,
        text=True,
        timeout=25,
        env={
            **os.environ,
            "PECOT_HOOKS_CONFIG_PATH": str(config_path),
            "CLAUDE_PROJECT_DIR": str(project),
        },
    )
    assert result.stdout == ""


# 統合テスト: 新規フック追加フロー（US2）

_NEW_HOOK_SCRIPT = """#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$CONFIG_DISPATCHER_PATH"
pecot_hook_enabled "new-test-hook" true || exit 0
echo "hook executed"
"""


def _run_new_hook(
    tmp_path: Path, dispatcher: Path, config_path: Path
) -> subprocess.CompletedProcess:
    script = tmp_path / "new-hook.sh"
    script.write_text(_NEW_HOOK_SCRIPT)
    script.chmod(0o755)
    return subprocess.run(
        ["bash", str(script)],
        capture_output=True,
        text=True,
        timeout=25,
        env={
            **os.environ,
            "PECOT_HOOKS_CONFIG_PATH": str(config_path),
            "CONFIG_DISPATCHER_PATH": str(dispatcher),
        },
    )


def test_new_hook_runs_when_enabled(tmp_path, dispatcher, config_path) -> None:
    config_path.write_text('{"new-test-hook": true}')
    result = _run_new_hook(tmp_path, dispatcher, config_path)
    assert result.returncode == 0
    assert result.stdout.strip() == "hook executed"


def test_new_hook_early_returns_when_disabled(tmp_path, dispatcher, config_path) -> None:
    config_path.write_text('{"new-test-hook": false}')
    result = _run_new_hook(tmp_path, dispatcher, config_path)
    assert result.returncode == 0
    assert result.stdout == ""


def test_new_hook_default_runs_when_missing(tmp_path, dispatcher, config_path) -> None:
    config_path.unlink(missing_ok=True)
    result = _run_new_hook(tmp_path, dispatcher, config_path)
    assert result.returncode == 0
    assert result.stdout.strip() == "hook executed"


# PLUGIN_HOOKS 解決テスト

_PLUGIN_HOOKS_SCRIPT = """#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$CONFIG_DISPATCHER_PATH"
echo "$PLUGIN_HOOKS"
"""


def _run_plugin_hooks(
    tmp_path: Path,
    dispatcher: Path,
    config_path: Path,
    plugin_root: str | None,
) -> subprocess.CompletedProcess:
    script = tmp_path / "check-plugin-hooks.sh"
    script.write_text(_PLUGIN_HOOKS_SCRIPT)
    script.chmod(0o755)
    config_path.write_text("{}")
    env = {
        **os.environ,
        "PECOT_HOOKS_CONFIG_PATH": str(config_path),
        "CONFIG_DISPATCHER_PATH": str(dispatcher),
    }
    if plugin_root is None:
        env.pop("CLAUDE_PLUGIN_ROOT", None)
    else:
        env["CLAUDE_PLUGIN_ROOT"] = plugin_root
    return subprocess.run(
        ["bash", str(script)],
        capture_output=True,
        text=True,
        timeout=25,
        env=env,
    )


def test_plugin_hooks_from_claude_plugin_root(tmp_path, dispatcher, config_path) -> None:
    plugin_root = tmp_path / "my-plugin"
    result = _run_plugin_hooks(tmp_path, dispatcher, config_path, str(plugin_root))
    assert result.returncode == 0
    assert result.stdout.strip() == f"{plugin_root}/hooks"


def test_plugin_hooks_script_dir_fallback(tmp_path, dispatcher, config_path) -> None:
    """CLAUDE_PLUGIN_ROOT 未設定時は SCRIPT_DIR フォールバックで解決される。

    SCRIPT_DIR は test_script のディレクトリ（tmp_path）で lib/ を含まないため
    cd "${SCRIPT_DIR%/lib/*}" は tmp_path そのもの。
    """
    result = _run_plugin_hooks(tmp_path, dispatcher, config_path, None)
    assert result.returncode == 0
    assert result.stdout.strip() == str(tmp_path)
