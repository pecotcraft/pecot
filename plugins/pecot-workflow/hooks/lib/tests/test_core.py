"""コアスクリプトのユニットテスト（test_core.bats 移植・84 @test）。

検証する対象は次のとおり。
git-no-verify-check / git-checkout-check。
gh-command-check / git-worktree-branch-check / claude-bash-guards。
HOOK_COMMAND 等を env で注入して、コアスクリプトを実行する。
GIT_* 隔離・test git repo・mock コマンドは、conftest の fixture を利用する。
fixture は、_isolate_git_env autouse / git_repo / mock_bin 相当の env 操作。

git を実行するケースは、bats の `env -u GIT_* bash -c "cd <repo> && <script>"` を踏襲する。
ただし、GIT_* の剥がしは、conftest の _isolate_git_env autouse が os.environ から済ませている。
そのため、ここでは個別の env -u を書かない（cwd= でリポへ移動するだけ）。
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest


def _run_core(
    script: Path,
    *,
    cwd: Path | None = None,
    env: dict[str, str | None] | None = None,
) -> subprocess.CompletedProcess:
    """コアスクリプトを実行する。env の値が None のキーは os.environ から除去する。"""
    merged = {**os.environ}
    if env:
        for key, value in env.items():
            if value is None:
                merged.pop(key, None)
            else:
                merged[key] = value
    return subprocess.run(
        [str(script)],
        capture_output=True,
        text=True,
        timeout=25,
        cwd=cwd,
        env=merged,
    )


def _checkout(repo: Path, branch: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-b", branch, "--quiet"],
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def no_verify_script(core_dir: Path) -> Path:
    return core_dir / "git-no-verify-check.sh"


@pytest.fixture
def checkout_script(core_dir: Path) -> Path:
    return core_dir / "git-checkout-check.sh"


@pytest.fixture
def gh_script(core_dir: Path) -> Path:
    return core_dir / "gh-command-check.sh"


@pytest.fixture
def wt_script(core_dir: Path) -> Path:
    return core_dir / "git-worktree-branch-check.sh"


@pytest.fixture
def external_post_script(core_dir: Path) -> Path:
    return core_dir / "external-post-check.sh"


# git-no-verify-check


@pytest.mark.parametrize(
    "command",
    [
        "git commit --no-verify",
        "git push --no-verify",
        "git commit -n",
        'echo test && git commit --no-verify -m "msg"',
        "echo ok && git commit -n",
        "git push -n",
        "git -C /repo commit -n",
        "echo ng || git commit -n",
        "git commit -m 'my message' -n",
        "git merge --no-verify",
        "git Commit -n",
        # 単独 & (バックグラウンド区切り) の後続も検出すること
        "echo x & git commit --no-verify -m x",
        "echo x&git commit -n",
        "echo x & git push --no-verify",
    ],
)
def test_no_verify_blocks(no_verify_script, command) -> None:
    result = _run_core(no_verify_script, env={"HOOK_COMMAND": command})
    assert result.returncode == 1


@pytest.mark.parametrize(
    "command",
    [
        'git commit -m "message"',
        'echo "--no-verify"',
        "git log --no-merges",
        "git status --short | head -n 5",
        "git log --oneline; sed -n 200,215p file.md",
        'git commit -m "msg" && grep -n foo bar.txt',
        'git commit -m "use -n flag"',
        "git merge --no-verify-signatures",
        "git diff --stat || sed -n 1,5p file.md",
        "git log -n 5",
        "git rev-list -n 5 HEAD",
        "git tag -n",
        # & 分割後のセグメントが commit/push でなければ素通しすること
        "sleep 1 & git log -n 5",
        "git push 2>&1",
    ],
)
def test_no_verify_allows(no_verify_script, command) -> None:
    result = _run_core(no_verify_script, env={"HOOK_COMMAND": command})
    assert result.returncode == 0
    assert result.stdout == ""


def test_no_verify_block_message_contains_flag(no_verify_script) -> None:
    result = _run_core(no_verify_script, env={"HOOK_COMMAND": "git commit --no-verify"})
    assert result.returncode == 1
    assert "--no-verify" in result.stdout


def test_no_verify_block_message_content(no_verify_script) -> None:
    result = _run_core(no_verify_script, env={"HOOK_COMMAND": "git commit --no-verify"})
    assert result.returncode == 1
    assert "error: git-no-verify-check:" in result.stdout
    assert "When a hook reports an error:" in result.stdout
    assert "Fix the root cause of the violation" in result.stdout


def test_no_verify_unset_command_exit_2(no_verify_script) -> None:
    result = _run_core(no_verify_script, env={"HOOK_COMMAND": None})
    assert result.returncode == 2


# git-checkout-check


def test_checkout_warns_on_untracked(checkout_script, git_repo) -> None:
    repo = git_repo()
    (repo / "untracked-file.txt").touch()
    result = _run_core(
        checkout_script,
        cwd=repo,
        env={"HOOK_COMMAND": "git checkout main", "HOOK_WORKING_DIR": str(repo)},
    )
    assert result.returncode == 0
    assert "untracked" in result.stdout


@pytest.mark.parametrize(
    "command",
    ["git switch\tmain", "git  checkout main", "git\tcheckout\tmain", "git switch  main"],
)
def test_checkout_detects_tab_and_multiple_space_separators(
    checkout_script, git_repo, command
) -> None:
    repo = git_repo()
    (repo / "untracked-file.txt").touch()
    result = _run_core(
        checkout_script,
        cwd=repo,
        env={"HOOK_COMMAND": command, "HOOK_WORKING_DIR": str(repo)},
    )
    assert result.returncode == 0
    assert "untracked" in result.stdout


def test_checkout_empty_without_untracked(checkout_script, git_repo) -> None:
    repo = git_repo()
    result = _run_core(
        checkout_script,
        cwd=repo,
        env={"HOOK_COMMAND": "git checkout main", "HOOK_WORKING_DIR": str(repo)},
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_checkout_b_new_branch_with_untracked_warns(checkout_script, git_repo) -> None:
    repo = git_repo()
    (repo / "untracked-file.txt").touch()
    result = _run_core(
        checkout_script,
        cwd=repo,
        env={"HOOK_COMMAND": "git checkout -b new-branch", "HOOK_WORKING_DIR": str(repo)},
    )
    assert result.returncode == 0
    assert "untracked" in result.stdout


def test_checkout_cd_chain_targets_other_repo(
    checkout_script, git_repo: Callable[..., Path]
) -> None:
    """cd <別リポ> && git checkout は cd 先の untracked を見る（#1087）。"""
    primary = git_repo("primary")
    secondary = git_repo("secondary")
    (secondary / "untracked-file.txt").touch()
    result = _run_core(
        checkout_script,
        cwd=primary,
        env={
            "HOOK_COMMAND": f"cd {secondary} && git checkout main",
            "HOOK_WORKING_DIR": str(primary),
        },
    )
    assert result.returncode == 0
    assert "untracked-file.txt" in result.stdout


def test_checkout_tool_cwd_targets_other_repo(
    checkout_script, git_repo: Callable[..., Path]
) -> None:
    """HOOK_TOOL_CWD（Priority 3）は HOOK_WORKING_DIR より優先され別リポの untracked を拾う。"""
    primary = git_repo("primary")
    secondary = git_repo("secondary")
    (secondary / "untracked-file.txt").touch()
    result = _run_core(
        checkout_script,
        cwd=primary,
        env={
            "HOOK_COMMAND": "git checkout main",
            "HOOK_TOOL_CWD": str(secondary),
            "HOOK_WORKING_DIR": str(primary),
        },
    )
    assert result.returncode == 0
    assert "untracked-file.txt" in result.stdout


def test_checkout_non_checkout_command_empty(checkout_script) -> None:
    result = _run_core(checkout_script, env={"HOOK_COMMAND": "git status"})
    assert result.returncode == 0
    assert result.stdout == ""


def test_checkout_unset_command_exit_2(checkout_script) -> None:
    result = _run_core(checkout_script, env={"HOOK_COMMAND": None})
    assert result.returncode == 2


# gh-command-check


@pytest.mark.parametrize(
    ("command", "marker"),
    [
        ("gh pr create --title test", "gh pr create"),
        ("GH_HOST=ghes.example.com gh pr create", None),
        ("echo test && gh pr create --title foo", None),
        ("/usr/bin/gh pr create --title test", None),
        ("gh pr create", None),
        ("gh issue create --title test", "gh issue create"),
        ("echo test && gh issue create --title foo", None),
        ("/usr/bin/gh issue create", None),
        # 単独 & (バックグラウンド区切り) の後続も検出すること（#935 必須ケース）。
        ("echo x & gh pr create", None),
        ("echo x & gh issue create", None),
        ("echo x&gh pr create", None),
        ("echo x & GH_HOST=y gh pr create", None),
        ("echo a & echo b & gh pr create", None),
        ("GH_HOST=x gh pr create & echo y", None),
        # 改行連結の後続も検出すること
        ("echo x\ngh pr create", None),
        ("echo x\ngh issue create", None),
        # タブ・連続空白の区切りも検出すること（[[:space:]]）。
        ("gh\tpr create", None),
        ("gh  pr\tcreate --title t", None),
        ("gh\tissue  create", None),
        ("echo a;  gh\tpr create", None),
        ("GH_HOST=x\tgh pr create", None),
    ],
)
def test_gh_command_blocks(gh_script, command, marker) -> None:
    result = _run_core(gh_script, env={"HOOK_COMMAND": command})
    assert result.returncode == 1
    if marker:
        assert marker in result.stdout


@pytest.mark.parametrize(
    "command",
    [
        "gh pr list",
        "gh issue list",
        "gh auth status",
        "gh api repos/owner/repo",
        "gh issue view 123",
        "gh pr view 456",
        "gh pr merge 789",
        "GH_HOST=ghes.example.com gh pr list",
        "echo test && gh issue view 123",
        "/usr/bin/gh project list",
        'echo "gh pr create"',
        "cat high.txt",
        # & を含むが create ではない / 連結でもない形は素通しすること
        "gh pr list 2>&1",
        "gh pr list 2>&1 | grep create",
        "sleep 1 & gh pr view 1",
        'gh api "search?a=1&b=2"',
        # ヒアドキュメント本文は実行されないため、行頭に現れても素通しすること
        # （改行正規化を `<<` 込みコマンドに適用しない根拠となるケース）。
        "cat > doc.md <<EOF\ngh pr create is banned\nEOF",
    ],
)
def test_gh_command_allows(gh_script, command) -> None:
    result = _run_core(gh_script, env={"HOOK_COMMAND": command})
    assert result.returncode == 0
    assert result.stdout == ""


def test_gh_command_unset_command_exit_2(gh_script) -> None:
    result = _run_core(gh_script, env={"HOOK_COMMAND": None})
    assert result.returncode == 2


# external-post-check: gh pr merge のユーザー承認ガード（exit 11 = ask）。
# pecot の起動は pecot-cli-deny.sh が deny する。MCP ツールの投稿の ask は pecot-post-ask.sh が持つ。
# そのため external-post-check.sh は、pecot の起動を判定しない（素通しにする）。


@pytest.mark.parametrize(
    "command",
    [
        "gh pr merge 789",
        "gh pr merge --squash",
        "GH_HOST=ghes.example.com gh pr merge 810",
        "git push && gh pr merge 1",
        "git push & gh pr merge 1",  # 単独 & の後続も検出すること
        "/usr/bin/gh pr merge 1",
        # リダイレクト 2>&1 は & 分割で断片化するが、起動形のセグメントは残ること
        "gh pr merge 1 2>&1 | tail -5",
        "(gh pr merge 1) && echo done",
        "echo $(gh pr merge 1)",
        "gh pr merge 1 --help && gh pr merge 2",
        # pecot の起動があっても、gh pr merge 側で ask になること
        "pecot pr create --prepare && gh pr merge 810",
    ],
)
def test_gh_pr_merge_asks(external_post_script, command) -> None:
    result = _run_core(external_post_script, env={"HOOK_COMMAND": command})
    assert result.returncode == 11
    assert "warning: external-post-check:" in result.stdout


@pytest.mark.parametrize(
    "command",
    [
        # pecot の起動は判定しない（deny は pecot-cli-deny.sh）。
        "pecot pr create x.md",
        "pecot pr create --prepare",
        "pecot issue quick -r owner/repo -m x",
        "pecot issue create x.md",
        "$PECOT pr create ./x.md",
        '"${CLAUDE_PLUGIN_ROOT}/bin/pecot" issue create x.md',
        "pecot pr cleanup 810",
        "pecot pr read acme-labs/aist-plugin/810",
        # 文字列内・ファイル名内。
        'echo "gh pr merge"',
        "cat gh-pr-merge-notes.txt",
        # gh の別の操作。
        "gh pr view 810",
        "gh pr list",
    ],
)
def test_external_post_passes(external_post_script, command) -> None:
    result = _run_core(external_post_script, env={"HOOK_COMMAND": command})
    assert result.returncode == 0
    assert result.stdout == ""


def test_pr_external_gh_merge_guides_to_w_merge(external_post_script) -> None:
    result = _run_core(external_post_script, env={"HOOK_COMMAND": "gh pr merge 810"})
    assert result.returncode == 11
    assert "/pecot-w:w-merge" in result.stdout
    assert "the MCP tool pr_cleanup" in result.stdout
    assert "pecot pr cleanup" not in result.stdout


def test_pr_external_unset_command_exit_2(external_post_script) -> None:
    result = _run_core(external_post_script, env={"HOOK_COMMAND": None})
    assert result.returncode == 2


# merge-slash-pending フラグ（/pecot-w:w-merge 起点の ask 免除）。
# 存在確認のみで判定し削除しない（消費しない）ため、いずれのケースもフラグ残存を assert する。
@pytest.fixture
def merge_slash_flag(tmp_path: Path) -> dict:
    """HOOK_WORKING_DIR 配下に merge-slash-pending を置いた環境。"""
    project = tmp_path / "merge-slash-project"
    state = project / ".pecot" / "state"
    state.mkdir(parents=True)
    flag = state / "merge-slash-pending"
    flag.touch()
    return {"env": {"HOOK_WORKING_DIR": str(project)}, "flag": flag}


@pytest.mark.parametrize("command", ["gh pr merge 810", "gh pr merge 810 --squash --auto"])
def test_gh_merge_passes_with_merge_slash_flag_and_flag_remains(
    external_post_script, merge_slash_flag, command
) -> None:
    result = _run_core(
        external_post_script, env={**merge_slash_flag["env"], "HOOK_COMMAND": command}
    )
    assert result.returncode == 0
    assert result.stdout == ""
    assert merge_slash_flag["flag"].is_file()


def test_gh_merge_asks_without_merge_slash_flag(external_post_script, tmp_path) -> None:
    project = tmp_path / "noflag-merge-project"
    (project / ".pecot" / "state").mkdir(parents=True)
    result = _run_core(
        external_post_script,
        env={"HOOK_WORKING_DIR": str(project), "HOOK_COMMAND": "gh pr merge 810"},
    )
    assert result.returncode == 11
    assert "warning: external-post-check:" in result.stdout


@pytest.mark.parametrize("flag_name", ["pr-create-slash-pending", "issue-create-slash-pending"])
def test_other_slash_flags_not_applied_to_gh_merge(
    external_post_script, tmp_path, flag_name
) -> None:
    """/w-pr・起票系の免除フラグは gh pr merge を免除しない。"""
    project = tmp_path / "other-flag-project"
    state = project / ".pecot" / "state"
    state.mkdir(parents=True)
    flag = state / flag_name
    flag.touch()
    result = _run_core(
        external_post_script,
        env={"HOOK_WORKING_DIR": str(project), "HOOK_COMMAND": "gh pr merge 810"},
    )
    assert result.returncode == 11
    assert flag.is_file()


def test_gh_merge_passes_when_ask_disabled_via_config(external_post_script, tmp_path) -> None:
    config = tmp_path / "hooks-config.json"
    config.write_text('{"gh-pr-merge-ask": false}')
    result = _run_core(
        external_post_script,
        env={"HOOK_COMMAND": "gh pr merge 810", "PECOT_HOOKS_CONFIG_PATH": str(config)},
    )
    assert result.returncode == 0
    assert result.stdout == ""


# すり抜け回帰（改行区切り・decoy クオート文字列）。いずれも実コマンドを検出して ask（exit 11）になること。
@pytest.mark.parametrize(
    "command",
    [
        # 改行区切りは ; と同じ区切りとして扱う。
        "echo done\ngh pr merge 5",
        # decoy のクオート内 -n を除外フラグと誤認せず、後続の実コマンドを検出。
        'echo "&& gh pr merge -n stuff" && gh pr merge 5',
    ],
)
def test_pr_external_bypass_regressions(external_post_script, command) -> None:
    result = _run_core(external_post_script, env={"HOOK_COMMAND": command})
    assert result.returncode == 11
    assert "warning: external-post-check:" in result.stdout


# gh pr merge は確認フラグ免除を持たない（--dry-run/-n でも無条件 ask）。
@pytest.mark.parametrize(
    "command",
    [
        "gh pr merge 810 --dry-run",
        "gh pr merge 810 -n",
    ],
)
def test_pr_external_gh_merge_ignores_skip_flags(external_post_script, command) -> None:
    result = _run_core(external_post_script, env={"HOOK_COMMAND": command})
    assert result.returncode == 11
    assert "warning: external-post-check:" in result.stdout


# git-worktree-branch-check


def _run_wt_in_repo(
    wt_script: Path, repo: Path, command: str, working_dir: Path | None
) -> subprocess.CompletedProcess:
    """cd <repo> 相当で wt-check を実行する（HOOK_WORKING_DIR は引数で指定）。"""
    env: dict[str, str | None] = {"HOOK_COMMAND": command}
    if working_dir is None:
        env["HOOK_WORKING_DIR"] = None
    else:
        env["HOOK_WORKING_DIR"] = str(working_dir)
    return _run_core(wt_script, cwd=repo, env=env)


# --- コマンド検出 ---


def test_wt_detects_commit(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt3")
    result = _run_wt_in_repo(wt_script, repo, 'git commit -m "msg"', repo)
    assert result.returncode == 1
    assert "commit" in result.stdout


def test_wt_detects_push(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt1")
    result = _run_wt_in_repo(wt_script, repo, "git push", repo)
    assert result.returncode == 1
    assert "push" in result.stdout


def test_wt_detects_chained_commit(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt2")
    result = _run_wt_in_repo(wt_script, repo, 'echo test && git commit -m "msg"', repo)
    assert result.returncode == 1


@pytest.mark.parametrize(
    ("command", "word"),
    [
        ("git\tcommit -m x", "commit"),
        ("git  commit -m x", "commit"),
        ("echo a;  git\tcommit -m x", "commit"),
        ("git\tpush", "push"),
        ("git  push", "push"),
        ("echo a &&\tgit  push", "push"),
    ],
)
def test_wt_detects_tab_and_multiple_space_separators(wt_script, git_repo, command, word) -> None:
    repo = git_repo()
    _checkout(repo, "wt3")
    result = _run_wt_in_repo(wt_script, repo, command, repo)
    assert result.returncode == 1
    assert word in result.stdout


def test_wt_detects_git_c_commit(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt4")
    # bats 版は cd せず HOOK_WORKING_DIR のみ（git -C で repo 指定）。
    result = _run_core(
        wt_script,
        env={"HOOK_COMMAND": f"git -C {repo} commit -m msg", "HOOK_WORKING_DIR": str(repo)},
    )
    assert result.returncode == 1


def test_wt_ignores_status(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt1")
    result = _run_core(
        wt_script,
        env={"HOOK_COMMAND": "git status", "HOOK_WORKING_DIR": str(repo)},
    )
    assert result.returncode == 0
    assert result.stdout == ""


# --- ブランチパターン判定 ---


def test_wt_blocks_commit_on_wt3(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt3")
    result = _run_wt_in_repo(wt_script, repo, 'git commit -m "test"', repo)
    assert result.returncode == 1
    assert "'wt3'" in result.stdout


def test_wt_blocks_commit_on_wt10(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt10")
    result = _run_wt_in_repo(wt_script, repo, 'git commit -m "test"', repo)
    assert result.returncode == 1
    assert "'wt10'" in result.stdout


def test_wt_blocks_push_on_wt1(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt1")
    result = _run_wt_in_repo(wt_script, repo, "git push origin wt1", repo)
    assert result.returncode == 1
    assert "push" in result.stdout


def test_wt_allows_commit_on_feature(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "feat/test-feature")
    result = _run_wt_in_repo(wt_script, repo, 'git commit -m "test"', repo)
    assert result.returncode == 0
    assert result.stdout == ""


def test_wt_blocks_commit_on_develop_pecot(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "develop-aist")
    result = _run_wt_in_repo(wt_script, repo, 'git commit -m "test"', repo)
    assert result.returncode == 1
    assert "'develop-aist'" in result.stdout


def test_wt_allows_commit_on_main(wt_script, git_repo) -> None:
    repo = git_repo()
    # main は既定ブランチと衝突しうるため -B 相当（失敗しても続行）。
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-B", "main", "--quiet"],
        capture_output=True,
        text=True,
    )
    result = _run_wt_in_repo(wt_script, repo, 'git commit -m "test"', repo)
    assert result.returncode == 0
    assert result.stdout == ""


def test_wt_allows_wt_prefix_without_number(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt-feature")
    result = _run_wt_in_repo(wt_script, repo, 'git commit -m "test"', repo)
    assert result.returncode == 0
    assert result.stdout == ""


# --- エッジケース ---


def test_wt_allows_commit_on_detached_head(wt_script, git_repo) -> None:
    repo = git_repo()
    head = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    subprocess.run(
        ["git", "-C", str(repo), "checkout", head, "--quiet"],
        check=True,
        capture_output=True,
        text=True,
    )
    result = _run_wt_in_repo(wt_script, repo, 'git commit -m "test"', repo)
    assert result.returncode == 0
    assert result.stdout == ""


def test_wt_unset_command_exit_2(wt_script) -> None:
    result = _run_core(wt_script, env={"HOOK_COMMAND": None})
    assert result.returncode == 2


# claude-bash-guards: CLAUDE_PLUGIN_ROOT 設定時のプラグイン環境テスト。


def test_claude_bash_guards_blocks_no_verify_in_plugin_env(
    project_root: Path, core_dir: Path, tmp_path: Path
) -> None:
    plugin_root = tmp_path / "plugin"
    plugin_core = plugin_root / "hooks" / "lib" / "core"
    plugin_core.mkdir(parents=True)
    for name in (
        "git-checkout-check.sh",
        "gh-command-check.sh",
        "git-worktree-branch-check.sh",
        "git-no-verify-check.sh",
        "external-post-check.sh",
        "config-dispatcher.sh",
        "hook-message.sh",
    ):
        dest = plugin_core / name
        dest.write_bytes((core_dir / name).read_bytes())
        dest.chmod(0o755)

    project = tmp_path / "project"
    (project / ".pecot" / "state").mkdir(parents=True)
    config = tmp_path / "hooks-config.json"
    config.write_text('{"claude-bash-guards": true}')

    guards_script = (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "adapters"
        / "claude-bash-guards.sh"
    )

    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"',
            "_",
            str(guards_script),
            '{"tool_input":{"command":"git commit --no-verify"}}',
        ],
        capture_output=True,
        text=True,
        timeout=25,
        env={
            **os.environ,
            "CLAUDE_PLUGIN_ROOT": str(plugin_root),
            "CLAUDE_PROJECT_DIR": str(project),
            "PECOT_HOOKS_CONFIG_PATH": str(config),
        },
    )
    assert result.returncode == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert '"decision"' not in result.stdout
    assert "--no-verify" in result.stdout


def test_wt_allows_commit_in_non_git_repo(wt_script, tmp_path) -> None:
    non_git = tmp_path / "non-git"
    non_git.mkdir(parents=True)
    result = _run_core(
        wt_script,
        cwd=non_git,
        env={"HOOK_COMMAND": 'git commit -m "test"', "HOOK_WORKING_DIR": str(non_git)},
    )
    assert result.returncode == 0
    assert result.stdout == ""


# --- メッセージ内容確認 ---


def test_wt_block_message_contains_commit(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt1")
    result = _run_wt_in_repo(wt_script, repo, 'git commit -m "test"', repo)
    assert result.returncode == 1
    assert "commit" in result.stdout
    assert "feature" in result.stdout


def test_wt_block_message_contains_push(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt2")
    result = _run_wt_in_repo(wt_script, repo, "git push", repo)
    assert result.returncode == 1
    assert "push" in result.stdout
    assert "feature" in result.stdout


# --- クロスリポジトリ: pwd と HOOK_WORKING_DIR が異なるリポジトリを指す ---


def test_wt_cross_repo_c_feat_working_protected_allows(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    primary = git_repo("primary")
    _checkout(primary, "wt1")
    secondary = git_repo("secondary")
    _checkout(secondary, "feat/awesome")
    # bats 版は cd せず HOOK_WORKING_DIR=primary、git -C secondary。
    result = _run_core(
        wt_script,
        env={
            "HOOK_COMMAND": f"git -C {secondary} commit -m msg",
            "HOOK_WORKING_DIR": str(primary),
        },
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_wt_cross_repo_c_protected_working_feat_blocks(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    primary = git_repo("primary")
    _checkout(primary, "feat/main-work")
    secondary = git_repo("secondary")
    _checkout(secondary, "wt2")
    result = _run_core(
        wt_script,
        env={
            "HOOK_COMMAND": f"git -C {secondary} commit -m msg",
            "HOOK_WORKING_DIR": str(primary),
        },
    )
    assert result.returncode == 1
    assert "'wt2'" in result.stdout


def test_wt_working_dir_priority_feat_over_pwd_protected(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    primary = git_repo("primary")
    _checkout(primary, "feat/work")
    secondary = git_repo("secondary")
    _checkout(secondary, "wt1")
    # cd secondary（保護）だが HOOK_WORKING_DIR=primary（feat）優先 → 許可。
    result = _run_core(
        wt_script,
        cwd=secondary,
        env={"HOOK_COMMAND": 'git commit -m "msg"', "HOOK_WORKING_DIR": str(primary)},
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_wt_working_dir_priority_protected_over_pwd_feat(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    primary = git_repo("primary")
    _checkout(primary, "wt2")
    secondary = git_repo("secondary")
    _checkout(secondary, "feat/other")
    result = _run_core(
        wt_script,
        cwd=secondary,
        env={"HOOK_COMMAND": 'git commit -m "msg"', "HOOK_WORKING_DIR": str(primary)},
    )
    assert result.returncode == 1
    assert "'wt2'" in result.stdout


def test_wt_fallback_to_pwd_when_working_dir_unset(wt_script, git_repo) -> None:
    repo = git_repo()
    _checkout(repo, "wt1")
    result = _run_core(
        wt_script,
        cwd=repo,
        env={"HOOK_COMMAND": 'git commit -m "msg"', "HOOK_WORKING_DIR": None},
    )
    assert result.returncode == 1
    assert "'wt1'" in result.stdout


# 対象リポジトリの解決順は、cd チェイン / HOOK_TOOL_CWD > HOOK_WORKING_DIR。
# セッション起点（HOOK_WORKING_DIR）だけを見ると、別 checkout を対象にした操作を、起点リポジトリのブランチで判定してしまう。
# これが #1087 の事例。


def test_wt_cd_chain_protected_over_working_dir_feat_blocks(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    primary = git_repo("primary")
    _checkout(primary, "feat/work")
    secondary = git_repo("secondary")
    _checkout(secondary, "wt5")
    result = _run_core(
        wt_script,
        cwd=primary,
        env={
            "HOOK_COMMAND": f'cd {secondary} && git commit -m "msg"',
            "HOOK_WORKING_DIR": str(primary),
        },
    )
    assert result.returncode == 1
    assert "'wt5'" in result.stdout


def test_wt_cd_chain_feat_over_working_dir_protected_allows(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    primary = git_repo("primary")
    _checkout(primary, "wt1")
    secondary = git_repo("secondary")
    _checkout(secondary, "feat/other")
    result = _run_core(
        wt_script,
        cwd=primary,
        env={
            "HOOK_COMMAND": f'cd {secondary} && git commit -m "msg"',
            "HOOK_WORKING_DIR": str(primary),
        },
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_wt_tool_cwd_protected_over_working_dir_feat_blocks(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    primary = git_repo("primary")
    _checkout(primary, "feat/work")
    secondary = git_repo("secondary")
    _checkout(secondary, "wt6")
    result = _run_core(
        wt_script,
        cwd=primary,
        env={
            "HOOK_COMMAND": 'git commit -m "msg"',
            "HOOK_TOOL_CWD": str(secondary),
            "HOOK_WORKING_DIR": str(primary),
        },
    )
    assert result.returncode == 1
    assert "'wt6'" in result.stdout


def test_wt_tool_cwd_feat_over_working_dir_protected_allows(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    primary = git_repo("primary")
    _checkout(primary, "wt2")
    secondary = git_repo("secondary")
    _checkout(secondary, "feat/other")
    result = _run_core(
        wt_script,
        cwd=primary,
        env={
            "HOOK_COMMAND": 'git commit -m "msg"',
            "HOOK_TOOL_CWD": str(secondary),
            "HOOK_WORKING_DIR": str(primary),
        },
    )
    assert result.returncode == 0
    assert result.stdout == ""


# cd チェインの解決は、「git ワークツリーとして解決できた cd 先」だけを採用する。
# ディレクトリ存在だけで確定すると、非 git ディレクトリへの cd が、「git リポジトリでなければ許可」の分岐へ進む。
# その結果、ガードがすり抜ける（#1087 の回帰）。


def test_wt_cd_chain_non_git_falls_through_to_tool_cwd_blocks(
    wt_script, git_repo: Callable[..., Path], tmp_path: Path
) -> None:
    """`cd <非 git dir> && git commit` は cd を採らず Priority 3 以降で判定する。"""
    plain = tmp_path / "plain-dir"
    plain.mkdir()
    protected = git_repo("protected")
    _checkout(protected, "wt7")
    result = _run_core(
        wt_script,
        cwd=protected,
        env={
            "HOOK_COMMAND": f'cd {plain} && git commit -m "msg"',
            "HOOK_TOOL_CWD": str(protected),
            "HOOK_WORKING_DIR": str(protected),
        },
    )
    assert result.returncode == 1
    assert "'wt7'" in result.stdout


def test_wt_multi_cd_chain_skips_non_git_and_blocks_on_protected(
    wt_script, git_repo: Callable[..., Path], tmp_path: Path
) -> None:
    """多段 cd の先頭が非 git なら後段の cd も評価する（後段の保護ブランチで block）。"""
    plain = tmp_path / "plain-dir"
    plain.mkdir()
    protected = git_repo("protected")
    _checkout(protected, "wt8")
    # 解決に失敗すると HOOK_WORKING_DIR（feat）で判定され許可になるため、
    # block されること自体が後段の cd を評価した証拠になる。
    session = git_repo("session")
    _checkout(session, "feat/session-work")
    result = _run_core(
        wt_script,
        cwd=session,
        env={
            "HOOK_COMMAND": f'cd {plain} && cd {protected} && git commit -m "msg"',
            "HOOK_WORKING_DIR": str(session),
        },
    )
    assert result.returncode == 1
    assert "'wt8'" in result.stdout


def test_wt_relative_cd_resolves_against_tool_cwd_blocks(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    """相対 `cd` はフックプロセスの pwd ではなく HOOK_TOOL_CWD を基点に解決する。"""
    # 同名 `target` をツール cwd 側とフック pwd 側の両方に置き、選ばれた側を
    # ブランチ名で判別する（ツール cwd 側が wt9 → block）。
    tool_side = git_repo("tool-base/target")
    _checkout(tool_side, "wt9")
    hook_side = git_repo("hook-base/target")
    _checkout(hook_side, "feat/hook-side")
    result = _run_core(
        wt_script,
        cwd=hook_side.parent,
        env={
            "HOOK_COMMAND": 'cd target && git commit -m "msg"',
            "HOOK_TOOL_CWD": str(tool_side.parent),
            "HOOK_WORKING_DIR": str(hook_side.parent),
        },
    )
    assert result.returncode == 1
    assert "'wt9'" in result.stdout


def test_wt_cd_chain_protected_over_working_dir_feat_blocks_push(
    wt_script, git_repo: Callable[..., Path]
) -> None:
    """cd チェイン経由の push も commit と同じく cd 先のブランチで判定する。"""
    primary = git_repo("primary")
    _checkout(primary, "feat/work")
    secondary = git_repo("secondary")
    _checkout(secondary, "wt5")
    result = _run_core(
        wt_script,
        cwd=primary,
        env={
            "HOOK_COMMAND": f"cd {secondary} && git push origin HEAD",
            "HOOK_WORKING_DIR": str(primary),
        },
    )
    assert result.returncode == 1
    assert "'wt5'" in result.stdout
    assert "push" in result.stdout
