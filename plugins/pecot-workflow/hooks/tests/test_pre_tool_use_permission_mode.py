"""pre-tool-use-bash.sh の permission_mode 非依存性テスト（T019）。

contracts/hook-flow.md PreToolUse/Bash 契約は次のとおり。
core ガード群は、permission mode に依存せず発火する。
対象は、external-post-check / git-no-verify-check / gh-command-check 等。
通常モードの調査フェーズ（permission_mode=default）でも、plan mode 滞在中（permission_mode=plan）でも、同一の deny/ask を返す。
これを、実 hook JSON（permission_mode フィールド込み）を entry スクリプトに流す end-to-end で固定する。

block/ask ロジック自体は lib/tests/test_core.py が網羅する。
本ファイルは、「permission_mode 混入時も同結果」の 1 点に絞る。
claude-adapter / claude-bash-guards は、PECOT_HOOK_COMMAND のみ参照し、permission_mode を読まない。
そのため、adapter/core 直叩きでは混入を再現できない。
entry `pre-tool-use-bash.sh` に、実 JSON を流す。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest


@pytest.fixture
def pre_tool_use_bash(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use-bash.sh"


def _run_entry(script: Path, payload: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(script)],
        input=payload,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=25,
    )


def _assert_ask(result: subprocess.CompletedProcess) -> None:
    assert result.returncode == 0
    assert '"permissionDecision"' in result.stdout
    assert '"ask"' in result.stdout


def _assert_deny(result: subprocess.CompletedProcess) -> None:
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout


_DECISIONS = {"ask": _assert_ask, "deny": _assert_deny}

# 操作 × 期待判定（発火ガード）は次のとおり。
#   pecot pr create <file>       → ask   （external-post-check / pecot-pr-create-ask）。
#   gh pr merge <n>             → ask   （external-post-check / gh-pr-merge-ask）。
#   git commit --no-verify      → deny  （git-no-verify-check）。
#   gh pr create                → deny  （gh-command-check / gh-pr-create-check）。
#   pecot issue quick -m <msg>   → ask   （external-post-check / pecot-issue-create-ask）。
_CASES = [
    ("pecot pr create x.md", "ask"),
    ("gh pr merge 1", "ask"),
    ("git commit --no-verify -m x", "deny"),
    ("gh pr create", "deny"),
    ("pecot issue quick -m x -r owner/repo", "ask"),
]


@pytest.mark.parametrize("permission_mode", ["default", "plan"])
@pytest.mark.parametrize("command,expected", _CASES)
def test_guard_result_independent_of_permission_mode(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
    permission_mode: str,
    command: str,
    expected: str,
):
    # 環境: feature ブランチの git repo・.pecot-active あり
    repo = git_repo()
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-b", "feat/regression/820", "--quiet"],
        check=True,
        capture_output=True,
    )
    state = repo / ".pecot" / "state"
    state.mkdir(parents=True)
    (state / ".pecot-active").write_text("org/repo/820\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))

    payload = json.dumps(
        {
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "permission_mode": permission_mode,
        }
    )
    result = _run_entry(pre_tool_use_bash, payload, cwd=repo)
    _DECISIONS[expected](result)
