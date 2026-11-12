"""pre-tool-use-mcp.sh のユニットテスト（test_pre_mcp.bats 移植）。

deny・ask・allow の順序を検証する。
deny は PR 作成 MCP ツール（github / githubEnterprise）の常時ブロック。
ask は pecot-workflow の投稿ツールの確認、allow は context7 の自動許可。
非 PR MCP ツール・tool_name 欠落時のすり抜けも検証する。
ask の網羅的なケースは cli-node/tests/hooks/pecot-post-ask.test.ts にある。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def hook_script(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use-mcp.sh"


@pytest.fixture
def state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    project = tmp_path / "project"
    sd = project / ".pecot" / "state"
    sd.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    return sd


def _run(hook_script: Path, stdin: str) -> subprocess.CompletedProcess:
    # エントリは stdin の JSON を project-root.sh で読む（ハンドラは PECOT_HOOK_* を読む）。
    return subprocess.run(
        ["bash", str(hook_script)],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=25,
    )


# PR作成: pecot-activeフラグなし → ブロック（常時ブロック）。


def test_pr_create_no_active_blocks(state_dir, hook_script):
    # .pecot-active は作成しない（不存在状態）。
    input_json = '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout


def test_pr_create_enterprise_no_active_blocks(state_dir, hook_script):
    input_json = '{"tool_name":"mcp__githubEnterprise__create_pull_request","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout


# PR作成: pecot-activeフラグあり → ブロック。


def test_pr_create_with_active_blocks(state_dir, hook_script):
    (state_dir / ".pecot-active").write_text("org/repo/123\n")
    input_json = '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout


def test_pr_create_block_reason_includes_a_pr(state_dir, hook_script):
    (state_dir / ".pecot-active").write_text("org/repo/123\n")
    input_json = '{"tool_name":"mcp__githubEnterprise__create_pull_request","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert "pecot-w:w-pr" in result.stdout


# 非PR MCPツール: 何も出力されない（すり抜け）。


def test_non_pr_mcp_no_output(state_dir, hook_script):
    (state_dir / ".pecot-active").write_text("org/repo/123\n")
    input_json = '{"tool_name":"mcp__drawio__open_drawio_mermaid","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert result.stdout == ""


def test_no_tool_name_no_output(state_dir, hook_script):
    result = _run(hook_script, '{"tool_input":{}}')
    assert result.returncode == 0
    assert result.stdout == ""


# context7 読み取りツール: 自動許可（context7-allow）。


def test_context7_resolve_library_id_allows(state_dir, hook_script, hooks_config):
    hooks_config.write({})
    input_json = '{"tool_name":"mcp__plugin_pecot-w_context7__resolve-library-id","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "allow"' in result.stdout
    assert '"hookEventName": "PreToolUse"' in result.stdout


def test_context7_query_docs_allows(state_dir, hook_script, hooks_config):
    hooks_config.write({})
    input_json = '{"tool_name":"mcp__plugin_pecot-w_context7__query-docs","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "allow"' in result.stdout


def test_context7_prefix_mismatch_no_allow(state_dir, hook_script, hooks_config):
    # プラグイン名プレフィックスまで完全一致した場合のみ許可する。
    hooks_config.write({})
    input_json = '{"tool_name":"mcp__context7__resolve-library-id","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert result.stdout == ""


def test_context7_allow_config_disable(state_dir, hook_script, hooks_config):
    hooks_config.write({"context7-allow": False})
    input_json = '{"tool_name":"mcp__plugin_pecot-w_context7__query-docs","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert result.stdout == ""


def test_context7_copilot_tool_name_no_allow(state_dir, hook_script, hooks_config):
    # context7-allow は、Claude Code のツール名専用。
    # Copilot のツール名（<mcpServers のキー>-<ツール名>）では、allow が出ない。
    # Copilot では context7 が OAuth を要して呼べず、allow の働き方は #789 の領分。
    hooks_config.write({})
    input_json = '{"tool_name":"context7-query-docs","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert "permissionDecision" not in result.stdout


def test_copilot_github_mcp_pr_create_denies(state_dir, hook_script, hooks_config):
    # Copilot CLI 1.0.103 の MCP ツール名は <mcpServers のキー>-<ツール名>。
    # 組み込みの GitHub MCP の PR 作成（--enable-all-github-mcp-tools）を、起点にして踏む。
    # 経由するのは Copilot の hooks.json の matcher。`mcp__.*|github-mcp-server-create_pull_request|pecot-workflow-.*`。
    hooks_config.write({})
    input_json = '{"tool_name":"github-mcp-server-create_pull_request","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout
    assert "pecot-w:w-pr" in result.stdout


def test_pr_create_block_wins_over_allow_chain(state_dir, hook_script, hooks_config):
    # deny 系（pr-create-block）が allow ハンドラーより先段で評価される。
    hooks_config.write({})
    input_json = '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"permissionDecision": "allow"' not in result.stdout


# pecot-workflow の投稿ツール: ask（pecot-post-ask）。

_PECOT_TOOL_PREFIX = "mcp__plugin_pecot-w_pecot-workflow__"


def test_pecot_pr_create_asks(state_dir, hook_script, hooks_config):
    hooks_config.write({})
    input_json = f'{{"tool_name":"{_PECOT_TOOL_PREFIX}pr_create","tool_input":{{}}}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "ask"' in result.stdout
    assert "external-post-check: the MCP tool pr_create" in result.stdout


def test_pecot_issue_create_prepare_passes(state_dir, hook_script, hooks_config):
    hooks_config.write({})
    input_json = (
        f'{{"tool_name":"{_PECOT_TOOL_PREFIX}issue_create","tool_input":{{"prepare":true}}}}'
    )
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert result.stdout == ""


def test_pecot_issue_quick_prepare_still_asks(state_dir, hook_script, hooks_config):
    # issue_quick の入力に prepare は無いので、prepare: true でも ask にする。
    hooks_config.write({})
    input_json = (
        f'{{"tool_name":"{_PECOT_TOOL_PREFIX}issue_quick","tool_input":{{"prepare":true}}}}'
    )
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "ask"' in result.stdout


def test_pecot_non_post_tool_no_output(state_dir, hook_script, hooks_config):
    hooks_config.write({})
    input_json = f'{{"tool_name":"{_PECOT_TOOL_PREFIX}issue_read","tool_input":{{}}}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert result.stdout == ""


def test_pr_create_block_stays_deny_with_ask_stage(state_dir, hook_script, hooks_config):
    # ask の段を足しても、GitHub の PR 作成は deny のまま。
    hooks_config.write({})
    input_json = '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"permissionDecision": "ask"' not in result.stdout


def test_ask_stage_keeps_context7_allow(state_dir, hook_script, hooks_config):
    # ask の段を通っても、対象外のツール名の allow は変わらない。
    hooks_config.write({})
    input_json = '{"tool_name":"mcp__plugin_pecot-w_context7__query-docs","tool_input":{}}'
    result = _run(hook_script, input_json)
    assert result.returncode == 0
    assert '"permissionDecision": "allow"' in result.stdout
    assert '"permissionDecision": "ask"' not in result.stdout
