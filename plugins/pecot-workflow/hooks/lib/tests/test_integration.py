"""アダプター経由 + エントリ sh 経由の統合テスト（test_integration.bats からの移植）。

claude-adapter.sh / pre-tool-use-bash.sh を通したコアスクリプトの、deny・許可・警告の挙動を検証する。
Copilot CLI も、PascalCase の定義では snake_case の tool_input を送る。
そのため、Copilot 専用の手段（copilot-adapter.sh / copilot-bash-guards.sh）は無く、同じエントリを通す（#1229 T050 確認）。
GIT_* 隔離・test git repo 生成は、conftest の fixture（_isolate_git_env / git_repo / claude_adapter）が担保する。
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


def _run_stdin(
    argv: list[str],
    stdin: str,
    cwd: str | Path | None = None,
) -> subprocess.CompletedProcess:
    """素の subprocess で argv を実行し stdin を流す（GIT_* は conftest autouse で剥がれ済み）。"""
    return subprocess.run(
        argv,
        input=stdin,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=25,
    )


# Claude Code アダプター経由。


def test_claude_adapter_block_json_on_blocked(claude_adapter, core_dir: Path):
    result = claude_adapter("gh pr create", core_dir / "gh-command-check.sh")
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout


def test_claude_adapter_empty_output_on_allowed(claude_adapter, core_dir: Path):
    result = claude_adapter("git status", core_dir / "gh-command-check.sh")
    assert result.returncode == 0
    assert result.stdout == ""


def test_claude_adapter_warning_on_checkout_untracked(
    claude_adapter,
    core_dir: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    (repo / "untracked-file.txt").touch()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))

    result = claude_adapter("git checkout main", core_dir / "git-checkout-check.sh", cwd=repo)
    assert result.returncode == 0
    assert "untracked" in result.stdout


def test_claude_adapter_empty_command_empty_output(claude_adapter, core_dir: Path):
    result = claude_adapter("", core_dir / "gh-command-check.sh")
    assert result.returncode == 0
    assert result.stdout == ""


# Claude Code エントリ sh 経由（hooks/pre-tool-use-bash.sh）。


def test_claude_entry_gh_command_block(
    pre_tool_use_bash: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    payload = json.dumps({"tool_input": {"command": "gh pr create"}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout


def test_claude_entry_no_verify_block(
    pre_tool_use_bash: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    payload = json.dumps({"tool_input": {"command": "git commit --no-verify"}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout
    assert "--no-verify" in result.stdout


def test_claude_entry_allowed_empty_output(
    pre_tool_use_bash: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    payload = json.dumps({"tool_input": {"command": "git status"}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload)
    assert result.returncode == 0
    assert result.stdout == ""


# Claude Code エントリ sh 経由: 入力 JSON の cwd で対象リポジトリを解決する（#1087）。


def _checkout_branch(repo: Path, branch: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-b", branch, "--quiet"],
        check=True,
        capture_output=True,
    )


def test_claude_entry_tool_cwd_protected_blocks(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    """cwd が保護ブランチの checkout を指せば、セッション起点が feat でも block する。"""
    session = git_repo("session")
    _checkout_branch(session, "feat/session-work")
    target = git_repo("target")
    _checkout_branch(target, "wt7")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(session))

    payload = json.dumps({"cwd": str(target), "tool_input": {"command": "git commit -m x"}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload, cwd=session)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert "'wt7'" in result.stdout


def test_claude_entry_tool_cwd_feat_allows(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    """cwd が feature ブランチの checkout を指せば、セッション起点が保護でも許可する。"""
    session = git_repo("session")
    _checkout_branch(session, "wt7")
    target = git_repo("target")
    _checkout_branch(target, "feat/target-work")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(session))

    payload = json.dumps({"cwd": str(target), "tool_input": {"command": "git commit -m x"}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload, cwd=session)
    assert result.returncode == 0
    assert result.stdout == ""


# Claude Code エントリ sh 経由: external-post-check（exit 11 → ask JSON）。


@pytest.mark.parametrize(
    "command",
    [
        "gh pr merge 810",
        "pecot pr create ./x.md",
        "pecot issue quick -m x -r owner/repo",
        "pecot issue create x.md",
    ],
)
def test_claude_entry_external_ask(
    pre_tool_use_bash: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    command: str,
):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    payload = json.dumps({"tool_input": {"command": command}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload)
    assert result.returncode == 0
    assert '"permissionDecision"' in result.stdout
    assert '"ask"' in result.stdout
    assert "external-post-check" in result.stdout


def test_claude_entry_issue_create_slash_flag_passes(
    pre_tool_use_bash: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "project"
    state = project / ".pecot" / "state"
    state.mkdir(parents=True)
    (state / "issue-create-slash-pending").write_text("w-quick\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    payload = json.dumps({"tool_input": {"command": "pecot issue quick -m x -r owner/repo"}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload)
    assert result.returncode == 0
    assert result.stdout == ""


def test_claude_entry_deny_wins_over_ask(
    pre_tool_use_bash: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    # gh pr create（deny/exit 1）と gh pr merge（ask/exit 11）が同居する場合は、deny が勝つ。
    # ガード実行順で、gh-command-check が external-post-check より先に動くため。
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    payload = json.dumps({"tool_input": {"command": "gh pr create && gh pr merge 1"}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout
    assert '"ask"' not in result.stdout


def test_claude_entry_pr_external_dry_run_pass(
    pre_tool_use_bash: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    payload = json.dumps({"tool_input": {"command": "pecot pr create x.md --dry-run"}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload)
    assert result.returncode == 0
    assert result.stdout == ""


# Copilot CLI（snake_case の tool_input が届く。エントリ pre-tool-use-bash.sh を通す）。


def _copilot_tool_payload(command: str) -> str:
    """Copilot CLI 1.0.103 の PreToolUse 入力（PascalCase 定義: snake_case、ツール名は Claude 名）。"""
    return json.dumps(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "session_id": "copilot-session",
        }
    )


def test_copilot_entry_no_verify_deny(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    # エントリポイントの project-root.sh が揃える基準ディレクトリを再現する。
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    result = _run_stdin(
        ["bash", str(pre_tool_use_bash)],
        _copilot_tool_payload("git commit --no-verify"),
        cwd=repo,
    )
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    # Copilot CLI はトップレベルの decision を無視するため、deny は hookSpecificOutput で出す。
    assert '"decision"' not in result.stdout
    assert "git-no-verify-check" in result.stdout


def test_copilot_entry_allowed_empty_output(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    result = _run_stdin(
        ["bash", str(pre_tool_use_bash)],
        _copilot_tool_payload("git status"),
        cwd=repo,
    )
    assert result.returncode == 0
    assert result.stdout == ""


@pytest.mark.parametrize("with_pecot_flag", [True, False])
def test_copilot_entry_gh_command_deny(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
    with_pecot_flag: bool,
):
    repo = git_repo()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    if with_pecot_flag:
        state = repo / ".pecot" / "state"
        state.mkdir(parents=True)
        (state / ".pecot-active").touch()

    result = _run_stdin(
        ["bash", str(pre_tool_use_bash)],
        _copilot_tool_payload("gh pr create"),
        cwd=repo,
    )
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert "gh-pr-create-check" in result.stdout


def test_copilot_entry_non_bash_tool_ignored(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    payload = json.dumps(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "report_intent",
            "tool_input": {"intent": "t"},
        }
    )
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload, cwd=repo)
    assert result.returncode == 0
    assert result.stdout == ""


# Copilot CLI: external-post-check（exit 11 → ask。deny に置き換えない）。
# Copilot CLI は、ask を -p / autopilot では自前で deny 扱いにする（1.0.97〜）。
# 対話モードでは、確認ダイアログを出す。
# hook 側で ask を deny に変換しない。


@pytest.mark.parametrize(
    "command",
    [
        "gh pr merge 810",
        "pecot pr create ./x.md",
        "pecot issue quick -m x -r owner/repo",
    ],
)
def test_copilot_entry_external_ask(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    command: str,
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    result = _run_stdin(
        ["bash", str(pre_tool_use_bash)],
        _copilot_tool_payload(command),
        cwd=repo,
    )
    assert result.returncode == 0
    assert '"permissionDecision": "ask"' in result.stdout
    assert "external-post-check" in result.stdout
    assert '"permissionDecision": "deny"' not in result.stdout


def test_copilot_entry_pr_external_dry_run_pass(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    result = _run_stdin(
        ["bash", str(pre_tool_use_bash)],
        _copilot_tool_payload("pecot pr create x.md --dry-run"),
        cwd=repo,
    )
    assert result.returncode == 0
    assert result.stdout == ""


# Claude Code アダプター経由: git-worktree-branch-check。


def test_claude_adapter_wt_branch_block(
    claude_adapter,
    core_dir: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-b", "wt1", "--quiet"],
        check=True,
        capture_output=True,
    )
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))

    result = claude_adapter(
        "git commit -m test", core_dir / "git-worktree-branch-check.sh", cwd=repo
    )
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout


def test_claude_adapter_feature_branch_empty_output(
    claude_adapter,
    core_dir: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-b", "feat/test-feature", "--quiet"],
        check=True,
        capture_output=True,
    )
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))

    result = claude_adapter("git commit -m test", core_dir / "git-worktree-branch-check.sh")
    assert result.returncode == 0
    assert result.stdout == ""


# Claude Code エントリ sh 経由: git-worktree-branch-check。


def test_claude_entry_wt_branch_block(
    pre_tool_use_bash: Path,
    core_dir: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-b", "wt3", "--quiet"],
        check=True,
        capture_output=True,
    )
    # コアスクリプトを配置（エントリ sh が CLAUDE_PROJECT_DIR 配下を参照するため）。
    (repo / "hooks" / "lib").mkdir(parents=True)
    (repo / "hooks" / "lib" / "core").symlink_to(core_dir)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))

    payload = json.dumps({"tool_input": {"command": "git commit -m test"}})
    result = _run_stdin(["bash", str(pre_tool_use_bash)], payload, cwd=repo)
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout


# Copilot CLI: git-worktree-branch-check（エントリ）。


def test_copilot_entry_wt_branch_deny(
    pre_tool_use_bash: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    repo = git_repo()
    # エントリポイントの project-root.sh が揃える基準ディレクトリを再現する。
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-b", "wt4", "--quiet"],
        check=True,
        capture_output=True,
    )

    result = _run_stdin(
        ["bash", str(pre_tool_use_bash)],
        _copilot_tool_payload("git commit -m test"),
        cwd=repo,
    )
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert "protected branch" in result.stdout
