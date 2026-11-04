"""PreToolUse の応答形式のテスト（#1229 T051）。

契約（contracts/hooks.md §2）は次のとおり。
- 確認が必要な操作は `hookSpecificOutput.permissionDecision: "ask"` で返す（deny に置き換えない）。
- PreToolUse の拒否は `hookSpecificOutput.permissionDecision: "deny"` と `permissionDecisionReason` で返す。
  トップレベルの `decision: "block"` は使わない。
  Copilot CLI 1.0.103 はトップレベルの decision を無視するため、deny が働かない。
- 統合後の `pre-tool-use-bash.sh` を通しても、判定とその理由は、リマインダーと同時に当たっても落ちない。

入力形式は、両クライアントとも snake_case の `tool_name` / `tool_input` / `cwd`。
Copilot CLI 1.0.103 の実機記録は .pecot/work/1229/firing-before/RECORD.md にある。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

CLIENTS = ["claude", "copilot"]


def _bash_payload(client: str, command: str, cwd: Path) -> dict:
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "cwd": str(cwd),
        "session_id": "sess-1229",
    }
    if client == "claude":
        payload["transcript_path"] = str(cwd / "transcript.jsonl")
        payload["permission_mode"] = "default"
    return payload


@pytest.fixture
def project(
    git_repo: Callable[..., Path],
    hooks_config,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    """feat ブランチの git リポ（.pecot あり）。リマインダー以外の既定の無効化を揃える。"""
    repo = git_repo("proj")
    subprocess.run(["git", "checkout", "-q", "-b", "feat/guard/1229"], cwd=repo, check=True)
    (repo / ".pecot" / "state").mkdir(parents=True)
    hooks_config.write({})
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    return repo


def _hso(result: subprocess.CompletedProcess) -> dict:
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip(), "出力が空（判定が落ちている）"
    out = json.loads(result.stdout)
    assert "hookSpecificOutput" in out, f"hookSpecificOutput が無い: {out}"
    return out


def _assert_decision(result, decision: str, reason_contains: str) -> dict:
    out = _hso(result)
    hso = out["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["permissionDecision"] == decision
    reason = hso.get("permissionDecisionReason", "")
    assert reason, "permissionDecisionReason が空"
    assert reason_contains in reason
    assert "decision" not in out, "トップレベルの decision は使わない"
    assert "reason" not in out, "トップレベルの reason は使わない"
    assert "reason" not in hso, "reason ではなく permissionDecisionReason に書く"
    return out


# ask（確認が必要な操作）: deny に置き換えない。


@pytest.mark.parametrize("client", CLIENTS)
@pytest.mark.parametrize(
    "command",
    [
        "pecot issue create .pecot/work/1229/issue.md",
        'pecot issue quick -r owner/repo -m "summary"',
        "pecot pr create",
        "gh pr merge 999999",
    ],
)
def test_ask_for_external_post(run_hook_entry, project, client, command) -> None:
    result = run_hook_entry("pre-tool-use-bash.sh", _bash_payload(client, command, project))
    _assert_decision(result, "ask", "external-post-check")


# deny（禁止操作）: hookSpecificOutput.permissionDecision で出す。


@pytest.mark.parametrize("client", CLIENTS)
def test_deny_git_no_verify(run_hook_entry, project, client) -> None:
    result = run_hook_entry(
        "pre-tool-use-bash.sh", _bash_payload(client, "git commit --no-verify -m x", project)
    )
    _assert_decision(result, "deny", "git-no-verify-check")


@pytest.mark.parametrize("client", CLIENTS)
@pytest.mark.parametrize(
    ("command", "marker"),
    [
        ("gh pr create --title t", "gh-pr-create-check"),
        ("gh issue create --title t", "gh-issue-create-check"),
    ],
)
def test_deny_gh_command_check(run_hook_entry, project, client, command, marker) -> None:
    result = run_hook_entry("pre-tool-use-bash.sh", _bash_payload(client, command, project))
    _assert_decision(result, "deny", marker)


@pytest.mark.parametrize("client", CLIENTS)
def test_deny_worktree_branch_check(run_hook_entry, project, client) -> None:
    subprocess.run(["git", "checkout", "-q", "-b", "wt3"], cwd=project, check=True)
    result = run_hook_entry(
        "pre-tool-use-bash.sh", _bash_payload(client, "git commit -m x", project)
    )
    _assert_decision(result, "deny", "git-worktree-branch-check")


def test_deny_exit_plan_mode_first_block(run_hook_entry, project) -> None:
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "ExitPlanMode",
        "tool_input": {"plan": "p"},
        "cwd": str(project),
    }
    result = run_hook_entry("pre-tool-use-exit-plan-mode.sh", payload)
    _assert_decision(result, "deny", "計画確認リマインド")


def test_deny_mcp_pr_create(run_hook_entry, project) -> None:
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "mcp__github__create_pull_request",
        "tool_input": {"title": "t"},
        "cwd": str(project),
    }
    result = run_hook_entry("pre-tool-use-mcp.sh", payload)
    _assert_decision(result, "deny", "PR保護")


# allow: 理由が残る。


@pytest.mark.parametrize("client", CLIENTS)
def test_allow_tech_advisor_clone(run_hook_entry, project, client) -> None:
    command = "git clone https://github.com/owner/repo.git .pecot/work/1229/tech-advisor/repo"
    result = run_hook_entry("pre-tool-use-bash.sh", _bash_payload(client, command, project))
    _assert_decision(result, "allow", "tech-advisor-clone-allow")


# 統合後のエントリ: リマインダーと判定が同時に当たっても、判定が落ちない。
# `git switch` は issue-pending のリマインダーの対象で、`/tmp/...` は tmp-path-warner の対象。
# 判定（ask / deny）と 2 つのリマインダーの additionalContext が、1 つの JSON に載る。


@pytest.fixture
def issue_pending(project: Path) -> None:
    (project / ".pecot" / "state" / "issue-pending").write_text("w-quick\n")


def _assert_reminders(out: dict) -> None:
    ctx = out["hookSpecificOutput"].get("additionalContext", "")
    assert "Issue 起票が未完了" in ctx
    assert "/tmp/" in ctx


@pytest.mark.parametrize("client", CLIENTS)
def test_ask_survives_reminders(run_hook_entry, project, issue_pending, client) -> None:
    command = "git switch feat/other; gh pr merge 999999 --body-file /tmp/note-1229"
    result = run_hook_entry("pre-tool-use-bash.sh", _bash_payload(client, command, project))
    out = _assert_decision(result, "ask", "external-post-check")
    _assert_reminders(out)


@pytest.mark.parametrize("client", CLIENTS)
def test_deny_survives_reminders(run_hook_entry, project, issue_pending, client) -> None:
    command = "git switch feat/other; git commit --no-verify -F /tmp/note-1229"
    result = run_hook_entry("pre-tool-use-bash.sh", _bash_payload(client, command, project))
    out = _assert_decision(result, "deny", "git-no-verify-check")
    _assert_reminders(out)


@pytest.mark.parametrize("client", CLIENTS)
def test_tmp_reminder_delivered_through_bash_entry(run_hook_entry, project, client) -> None:
    result = run_hook_entry(
        "pre-tool-use-bash.sh", _bash_payload(client, "cat /tmp/x-1229", project)
    )
    out = _hso(result)
    assert out["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    assert "/tmp/" in out["hookSpecificOutput"]["additionalContext"]
    assert "permissionDecision" not in out["hookSpecificOutput"]


@pytest.mark.parametrize("client", CLIENTS)
def test_issue_pending_reminder_delivered_through_bash_entry(
    run_hook_entry, project, issue_pending, client
) -> None:
    result = run_hook_entry(
        "pre-tool-use-bash.sh", _bash_payload(client, "git switch feat/other", project)
    )
    out = _hso(result)
    assert "Issue 起票が未完了" in out["hookSpecificOutput"]["additionalContext"]


@pytest.mark.parametrize("client", CLIENTS)
def test_plain_command_has_no_output(run_hook_entry, project, client) -> None:
    result = run_hook_entry("pre-tool-use-bash.sh", _bash_payload(client, "echo hi", project))
    assert result.returncode == 0
    assert result.stdout.strip() == ""
