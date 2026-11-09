"""Bash の PreToolUse / PostToolUse でのリポジトリ解決回数と commit 検出のテスト（#1229 T053）。

PATH 先頭に置いた `git` のシム（conftest の git_call_log）で `rev-parse` の呼び出しを
サブコマンド別に数える。
数えるのは「リポジトリ解決」で、次の 2 つがある。
- `--show-toplevel`: project-root.sh によるプロジェクトルート解決
- `--is-inside-work-tree`: git-repo-resolver.sh の `_resolve_repo_dir` / is_feature_branch の判定

期待値は次のとおり（contracts/hooks.md §SC-009）。
- `ls`: Pre の `--show-toplevel` 1 回だけ。Post は解決しない
- commit: Pre / Post 各 1 回の `--show-toplevel`。Post の `_resolve_repo_dir` は 1 回
  is_feature_branch の判定を含めて、`--is-inside-work-tree` は 2 回まで。
- `pecot issue create`: Pre 1、Post は解決しない
- cwd が .pecot/work 配下: 判定が通れば 1 回（セッションの toplevel）。
  判定が外れるのは、別リポの .pecot/work・入れ子のリポ・link 切れのとき。
  この場合は、セッションの toplevel と cwd の候補で 2 回。

後半は、移行前から通るべき特性テスト。
対象は `git -C <path> commit` と `cd <path> && ... && git commit` の Claude 形式 Post。
どちらでも commit-info-display と auto-push が揃って動く。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

BRANCH = "feat/count/1229"
_ORIGIN_URL = "git@github.com:testowner/testrepo.git"


@pytest.fixture
def sandbox(
    tmp_path: Path,
    git_repo: Callable[..., Path],
    hooks_config,
    mock_bin,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[Path, Path]:
    """(repo, bare) を返す。

    条件は、active な Issue の feat ブランチ・.pecot あり・auto-push 有効・gh は常に失敗。
    auto-push は origin の URL を owner/repo として読むため、origin は GitHub 形式の URL にする。
    push だけを pushInsteadOf で bare に向ける。
    """
    repo = git_repo("proj")
    bare = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    subprocess.run(["git", "remote", "add", "origin", _ORIGIN_URL], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", f"url.{bare}.pushInsteadOf", _ORIGIN_URL], cwd=repo, check=True
    )
    subprocess.run(["git", "checkout", "-q", "-b", BRANCH], cwd=repo, check=True)
    (repo / ".pecot" / "state").mkdir(parents=True)
    (repo / ".pecot" / "state" / ".pecot-active").write_text("testowner/testrepo/1229\n")
    hooks_config.write({"auto-push": True})
    mock_bin.install("gh", "exit 1\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    return repo, bare


def _commit(repo: Path, name: str = "f.txt") -> str:
    """実際に commit して、その成功出力（`[branch sha] x ...`）を返す。"""
    (repo / name).write_text(name)
    subprocess.run(["git", "add", name], cwd=repo, check=True)
    out = subprocess.run(
        ["git", "commit", "-m", "x"], cwd=repo, check=True, capture_output=True, text=True
    )
    return out.stdout


def _pre(command: str, cwd: Path) -> dict:
    return {
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "cwd": str(cwd),
        "session_id": "s",
    }


def _post_claude(command: str, stdout: str, cwd: Path) -> dict:
    return {
        "hook_event_name": "PostToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "tool_response": {"stdout": stdout, "stderr": "", "interrupted": False},
        "cwd": str(cwd),
        "session_id": "s",
    }


def _post_copilot(command: str, stdout: str, cwd: Path) -> dict:
    # Copilot CLI 1.0.103: tool_response は来ず、tool_result.text_result_for_llm に出力が入る。
    # Bash は末尾に `<shellId: N completed with exit code 0>` が付く。
    return {
        "hook_event_name": "PostToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "tool_result": {
            "result_type": "success",
            "text_result_for_llm": f"{stdout}\n<shellId: 0 completed with exit code 0>",
        },
        "cwd": str(cwd),
        "session_id": "s",
    }


def _additional_context(result: subprocess.CompletedProcess) -> str:
    assert result.returncode == 0, result.stderr
    if not result.stdout.strip():
        return ""
    return json.loads(result.stdout).get("hookSpecificOutput", {}).get("additionalContext", "")


# 解決回数。


def test_ls_resolves_once_in_pre_and_never_in_post(run_hook_entry, sandbox, git_call_log) -> None:
    repo, _ = sandbox
    git_call_log.reset()
    run_hook_entry("pre-tool-use-bash.sh", _pre("ls", repo))
    assert git_call_log.rev_parse_counts() == {"--show-toplevel": 1}

    git_call_log.reset()
    run_hook_entry("post-tool-use-bash.sh", _post_claude("ls", "f.txt\n", repo))
    assert git_call_log.rev_parse_counts() == {}


@pytest.mark.parametrize("client", ["claude", "copilot"])
def test_commit_resolves_once_in_pre_and_once_in_post(
    run_hook_entry, sandbox, git_call_log, client
) -> None:
    repo, _ = sandbox
    git_call_log.reset()
    run_hook_entry("pre-tool-use-bash.sh", _pre("git commit -m x", repo))
    assert git_call_log.rev_parse_counts().get("--show-toplevel") == 1

    stdout = _commit(repo)
    post = _post_claude if client == "claude" else _post_copilot
    git_call_log.reset()
    result = run_hook_entry("post-tool-use-bash.sh", post("git commit -m x", stdout, repo))
    counts = git_call_log.rev_parse_counts()
    assert counts.get("--show-toplevel") == 1
    assert counts.get("--is-inside-work-tree", 0) <= 2, counts
    assert "【コミット完了】" in _additional_context(result)


def test_issue_create_resolves_once_in_pre_and_not_in_post(
    run_hook_entry, sandbox, git_call_log
) -> None:
    repo, _ = sandbox
    command = "pecot issue create .pecot/work/1229/issue.md"
    git_call_log.reset()
    run_hook_entry("pre-tool-use-bash.sh", _pre(command, repo))
    assert git_call_log.rev_parse_counts().get("--show-toplevel") == 1

    git_call_log.reset()
    run_hook_entry("post-tool-use-bash.sh", _post_claude(command, "Created: #12\n", repo))
    counts = git_call_log.rev_parse_counts()
    # issue-pending は CLI が消すため、起票の Post は何も解決しない。
    assert counts == {}


def test_cwd_in_work_resolves_once(run_hook_entry, work_layout, git_call_log) -> None:
    """worktree の .pecot/work（base への symlink）配下の cwd でも --show-toplevel は 1 回。"""
    git_call_log.reset()
    run_hook_entry(
        "pre-tool-use-bash.sh",
        _pre("ls", work_layout["work"] / "1244"),
        env={"CLAUDE_PROJECT_DIR": str(work_layout["wt"])},
    )
    assert git_call_log.rev_parse_counts() == {"--show-toplevel": 1}


def test_cwd_in_other_repo_work_resolves_twice(
    run_hook_entry, work_layout, git_repo, git_call_log
) -> None:
    """別リポの .pecot/work 配下は判定が外れ、セッションの toplevel と cwd の 2 回。"""
    other = git_repo("other-repo")
    cwd = other / ".pecot" / "work" / "1244"
    cwd.mkdir(parents=True)
    git_call_log.reset()
    run_hook_entry(
        "pre-tool-use-bash.sh",
        _pre("ls", cwd),
        env={"CLAUDE_PROJECT_DIR": str(work_layout["wt"])},
    )
    assert git_call_log.rev_parse_counts() == {"--show-toplevel": 2}


def test_cwd_in_nested_repo_in_work_resolves_twice(
    run_hook_entry, work_layout, git_call_log
) -> None:
    """.pecot/work 配下の入れ子のリポは判定が外れ、セッションの toplevel と cwd の 2 回。"""
    nested = work_layout["work"] / "1244" / "clone"
    nested.mkdir()
    subprocess.run(["git", "init", "--quiet"], cwd=nested, check=True)
    git_call_log.reset()
    run_hook_entry(
        "pre-tool-use-bash.sh",
        _pre("ls", nested),
        env={"CLAUDE_PROJECT_DIR": str(work_layout["wt"])},
    )
    assert git_call_log.rev_parse_counts() == {"--show-toplevel": 2}


# 特性テスト（移行前から通る）: commit の検出形。


def _assert_wip_pushed(bare: Path) -> None:
    ref = subprocess.run(
        ["git", "--git-dir", str(bare), "rev-parse", "--verify", f"refs/heads/wip/{BRANCH}"],
        capture_output=True,
        text=True,
    )
    assert ref.returncode == 0, f"bare に wip/{BRANCH} が push されていない: {ref.stderr}"


def test_git_dash_c_commit_runs_commit_info_and_auto_push(
    run_hook_entry, sandbox, tmp_path
) -> None:
    repo, bare = sandbox
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    stdout = _commit(repo)
    result = run_hook_entry(
        "post-tool-use-bash.sh",
        _post_claude(f"git -C {repo} commit -m x", stdout, elsewhere),
        cwd=elsewhere,
    )
    assert "【コミット完了】" in _additional_context(result)
    _assert_wip_pushed(bare)


def test_compound_cd_add_commit_runs_commit_info_and_auto_push(
    run_hook_entry, sandbox, tmp_path
) -> None:
    repo, bare = sandbox
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    stdout = _commit(repo)
    result = run_hook_entry(
        "post-tool-use-bash.sh",
        _post_claude(f"cd {repo} && git add . && git commit -m x", stdout, elsewhere),
        cwd=elsewhere,
    )
    assert "【コミット完了】" in _additional_context(result)
    _assert_wip_pushed(bare)


def test_commit_post_output_has_top_level_additional_context(run_hook_entry, sandbox) -> None:
    """Copilot CLI 1.0.103 は PostToolUse ではトップレベルの additionalContext だけをモデルに渡す。"""
    repo, _ = sandbox
    stdout = _commit(repo)
    result = run_hook_entry("post-tool-use-bash.sh", _post_copilot("git commit -m x", stdout, repo))
    data = json.loads(result.stdout)
    assert "【コミット完了】" in data["additionalContext"]
    assert data["additionalContext"] == data["hookSpecificOutput"]["additionalContext"]


# commit と issue 起票を 1 つのコマンドで行ったとき（F-03）。


def test_commit_and_issue_create_in_one_command_run_all_subscripts(
    run_hook_entry, sandbox, git_call_log
) -> None:
    repo, bare = sandbox
    stdout = _commit(repo) + "Created: #12\n"
    git_call_log.reset()
    result = run_hook_entry(
        "post-tool-use-bash.sh",
        _post_claude("git commit -m x && pecot issue create x.md", stdout, repo),
    )
    assert "【コミット完了】" in _additional_context(result)
    _assert_wip_pushed(bare)
    counts = git_call_log.rev_parse_counts()
    assert counts.get("--show-toplevel") == 1
    assert counts.get("--is-inside-work-tree", 0) <= 2, counts


# 上限を超えるコマンド（F-04）。

# 環境変数 1 個が 128KiB を超えると execve が失敗する。heredoc 付きの約 130KiB のコマンド。
_BIG_BODY = "x" * 130_000


def _big_command(head: str) -> str:
    return f"{head} && cat <<'EOF' > .pecot/work/1229/big.txt\n{_BIG_BODY}\nEOF"


def test_oversize_command_is_not_passed_through_in_pre(run_hook_entry, sandbox) -> None:
    repo, _ = sandbox
    result = run_hook_entry(
        "pre-tool-use-bash.sh", _pre(_big_command("git commit --no-verify -m x"), repo)
    )
    assert result.returncode == 0, result.stderr
    assert "Argument list too long" not in result.stderr
    hso = json.loads(result.stdout)["hookSpecificOutput"]
    assert hso["permissionDecision"] == "ask"
    assert "大きすぎる" in hso["permissionDecisionReason"]


def test_oversize_command_still_gets_tmp_reminder(run_hook_entry, sandbox) -> None:
    repo, _ = sandbox
    result = run_hook_entry("pre-tool-use-bash.sh", _pre(_big_command("cat /tmp/x-1229"), repo))
    assert result.returncode == 0, result.stderr
    hso = json.loads(result.stdout)["hookSpecificOutput"]
    assert hso["permissionDecision"] == "ask"
    assert "/tmp/" in hso["additionalContext"]


def test_oversize_command_still_gets_issue_pending_reminder(run_hook_entry, sandbox) -> None:
    repo, _ = sandbox
    (repo / ".pecot" / "state" / "issue-pending").write_text("w-quick\n")
    result = run_hook_entry(
        "pre-tool-use-bash.sh", _pre(_big_command("git switch feat/other"), repo)
    )
    hso = json.loads(result.stdout)["hookSpecificOutput"]
    assert "Issue 起票が未完了" in hso["additionalContext"]


def test_oversize_commit_is_still_detected_in_post(run_hook_entry, sandbox) -> None:
    repo, bare = sandbox
    stdout = _commit(repo)
    result = run_hook_entry(
        "post-tool-use-bash.sh",
        _post_claude(_big_command("git commit --no-verify -m x"), stdout, repo),
    )
    assert "Argument list too long" not in result.stderr
    assert "【コミット完了】" in _additional_context(result)
    _assert_wip_pushed(bare)


def test_command_just_under_the_limit_is_still_guarded_by_core(run_hook_entry, sandbox) -> None:
    repo, _ = sandbox
    command = "# " + "x" * 50_000 + "\ngit commit --no-verify -m x"
    result = run_hook_entry("pre-tool-use-bash.sh", _pre(command, repo))
    hso = json.loads(result.stdout)["hookSpecificOutput"]
    assert hso["permissionDecision"] == "deny"
