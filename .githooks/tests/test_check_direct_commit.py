"""check-direct-commit.sh のユニットテスト（test_check_direct_commit.bats 移植）。

hook は commit-msg stage で動き、protected branch (main / wtN) への直接コミットを block する。
ただし message が "chore(release)" で始まる commit は、**どの branch でも例外的に許可** する。
この commit は、Nx Release が発行する release commit を指す。
単一ブランチ (trunk-based) 運用では、release commit が main 上に直接載る。
そのため main でも、release 例外を機能させる必要がある（#648）。

current branch は `git rev-parse --abbrev-ref HEAD` で判定する。
そのため temp repo では、初期 commit を作って branch を born させてから checkout する。
GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する。
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest


@pytest.fixture
def direct_commit_repo(git_repo: Callable[..., Path], git) -> Path:
    """main 上に初期コミット済みの temp repo を作る（各 .bats の setup 相当）。"""
    repo = git_repo("repo", initial_branch="main")
    (repo / "README.md").write_text("init\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-q", "-m", "chore: init")
    return repo


def _run_hook_on(
    script_dir: Path,
    repo: Path,
    run_script,
    git,
    branch: str,
    msg: str,
):
    """指定 branch を main 起点で checkout し、commit message file で hook を run。"""
    git(repo, "checkout", "-q", "-B", branch, "main")
    msg_file = repo / ".commit-msg"
    msg_file.write_text(f"{msg}\n")
    return run_script(
        script_dir.parent / "commit-msg" / "check-direct-commit.sh",
        str(msg_file),
        cwd=repo,
    )


def test_main_release_commit_allowed(
    script_dir: Path, direct_commit_repo: Path, run_script, git
) -> None:
    """main + chore(release): → 許可（単一ブランチ release commit, #648）。"""
    result = _run_hook_on(
        script_dir, direct_commit_repo, run_script, git, "main", "chore(release): publish"
    )
    assert result.returncode == 0


def test_main_normal_commit_blocked(
    script_dir: Path, direct_commit_repo: Path, run_script, git
) -> None:
    """main + 通常コミット → block。"""
    result = _run_hook_on(script_dir, direct_commit_repo, run_script, git, "main", "fix: something")
    assert result.returncode != 0
    assert "main への変更は feature branch からのPRのみ許可" in (result.stdout + result.stderr)


def test_develop_pecot_normal_commit_allowed(
    script_dir: Path, direct_commit_repo: Path, run_script, git
) -> None:
    """develop-aist + 通常コミット → 許可（保護対象から撤去済 #702）。"""
    result = _run_hook_on(
        script_dir, direct_commit_repo, run_script, git, "develop-aist", "fix: something"
    )
    assert result.returncode == 0


def test_wtn_normal_commit_blocked(
    script_dir: Path, direct_commit_repo: Path, run_script, git
) -> None:
    """wtN + 通常コミット → block。"""
    result = _run_hook_on(script_dir, direct_commit_repo, run_script, git, "wt1", "fix: something")
    assert result.returncode != 0


def test_wtn_release_commit_allowed(
    script_dir: Path, direct_commit_repo: Path, run_script, git
) -> None:
    """wtN + chore(release): → 許可。"""
    result = _run_hook_on(
        script_dir, direct_commit_repo, run_script, git, "wt1", "chore(release): publish"
    )
    assert result.returncode == 0


def test_feature_branch_normal_commit_allowed(
    script_dir: Path, direct_commit_repo: Path, run_script, git
) -> None:
    """feature branch + 通常コミット → 許可。"""
    result = _run_hook_on(
        script_dir, direct_commit_repo, run_script, git, "feat/some-feature", "fix: something"
    )
    assert result.returncode == 0
