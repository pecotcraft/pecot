"""pre-tool-use-websearch.sh のユニットテスト。

WebSearch（読み取り専用）の自動許可 JSON 出力と、config の設定による無効化を検証する。
対象ツールの限定は、hooks.json の matcher "WebSearch" が担う。
そのため、エントリは入力によらず allow を返す。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def hook_script(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use-websearch.sh"


def _run(hook_script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(hook_script)],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_websearch_allows(hook_script, hooks_config):
    hooks_config.write({})
    result = _run(hook_script, '{"tool_name":"WebSearch","tool_input":{"query":"x"}}')
    assert result.returncode == 0
    assert '"permissionDecision": "allow"' in result.stdout
    assert '"hookEventName": "PreToolUse"' in result.stdout


def test_websearch_config_disable(hook_script, hooks_config):
    hooks_config.write({"websearch-allow": False})
    result = _run(hook_script, '{"tool_name":"WebSearch","tool_input":{"query":"x"}}')
    assert result.returncode == 0
    assert result.stdout == ""
