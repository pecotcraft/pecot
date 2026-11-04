"""MCP ハンドラのユニットテスト（test_mcp_handlers.bats 移植）。

対象: pr-create-block.sh。MCP の PR 作成ツールを常時ブロックし、非 PR ツール・
tool_name 欠落ではすり抜けすることを検証する。JSON stdin を流す。
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def handler(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "mcp-handlers"
        / "pr-create-block.sh"
    )


@pytest.fixture
def mcp_env(claude_project_dir: Path) -> dict:
    """CLAUDE_PROJECT_DIR/.pecot/state を用意する（conftest が .pecot を作成済み）。"""
    state_dir = claude_project_dir / ".pecot" / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    return {"project": claude_project_dir, "state_dir": state_dir}


def test_github_pr_create_no_flag_blocks(handler, mcp_env, run_hook_script) -> None:
    result = run_hook_script(handler, '{"tool_name":"mcp__github__create_pull_request"}')
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout


def test_githubenterprise_pr_create_with_flag_blocks(handler, mcp_env, run_hook_script) -> None:
    (mcp_env["state_dir"] / ".pecot-active").touch()
    result = run_hook_script(handler, '{"tool_name":"mcp__githubEnterprise__create_pull_request"}')
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert "pecot-w:w-pr" in result.stdout


def test_github_pr_create_with_flag_blocks(handler, mcp_env, run_hook_script) -> None:
    (mcp_env["state_dir"] / ".pecot-active").touch()
    result = run_hook_script(handler, '{"tool_name":"mcp__github__create_pull_request"}')
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout


def test_non_pr_mcp_tool_no_output(handler, mcp_env, run_hook_script) -> None:
    result = run_hook_script(handler, '{"tool_name":"mcp__github__list_issues"}')
    assert result.returncode == 0
    assert result.stdout == ""


def test_missing_tool_name_no_output(handler, mcp_env, run_hook_script) -> None:
    result = run_hook_script(handler, '{"other_field":"value"}')
    assert result.returncode == 0
    assert result.stdout == ""


def test_copilot_github_mcp_pr_create_denies(handler, mcp_env, run_hook_script) -> None:
    # Copilot CLI の MCP ツール名は <mcpServers のキー>-<ツール名>（組み込み GitHub MCP の PR 作成）
    result = run_hook_script(handler, '{"tool_name":"github-mcp-server-create_pull_request"}')
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout
    assert "pecot-w:w-pr" in result.stdout


def test_copilot_other_github_mcp_tool_no_output(handler, mcp_env, run_hook_script) -> None:
    result = run_hook_script(handler, '{"tool_name":"github-mcp-server-get_file_contents"}')
    assert result.returncode == 0
    assert result.stdout == ""
