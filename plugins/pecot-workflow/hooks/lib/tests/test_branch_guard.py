"""branch-guard.sh の is_feature_branch 関数のテスト（test_branch_guard.bats 移植）。

is_feature_branch は source が必要な関数のため、bash -c で source してから
呼ぶ形で実行する。GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


def _is_feature_branch(core_dir: Path, repo_dir: Path) -> subprocess.CompletedProcess:
    """is_feature_branch を source 経由で呼び CompletedProcess を返す。

    exit 0 = feature ブランチ（true）、exit 非 0 = 非 feature ブランチ（false）。
    """
    return subprocess.run(
        [
            "bash",
            "-c",
            'source "$1/branch-guard.sh" && is_feature_branch "$2"',
            "_",
            str(core_dir),
            str(repo_dir),
        ],
        capture_output=True,
        text=True,
        timeout=25,
    )


def _checkout(repo_dir: Path, branch: str) -> None:
    # -B は対象ブランチが既存でも作成/リセットして checkout する。git_repo の
    # 初期コミットが乗る既定ブランチ名は init.defaultBranch に依存する（環境次第で
    # main）。`("main", False)` ケースで既定ブランチ名と衝突しても `-b` のような
    # 既存ブランチ作成エラーにならないよう -B を使う。
    subprocess.run(
        ["git", "-C", str(repo_dir), "checkout", "-B", branch],
        check=True,
        capture_output=True,
        text=True,
    )


# is_feature_branch: ブランチ判定テスト


@pytest.mark.parametrize(
    ("branch", "is_feature"),
    [
        ("feat/add-auth", True),
        ("fix/login-bug", True),
        ("wt1", False),
        ("wt2", False),
        ("develop-aist", False),
        ("main", False),
    ],
)
def test_is_feature_branch_by_name(
    core_dir: Path,
    git_repo,
    hooks_config,  # noqa: ARG001 — PECOT_HOOKS_CONFIG_PATH を tmp に隔離する
    branch: str,
    is_feature: bool,
) -> None:
    repo_dir = git_repo()
    _checkout(repo_dir, branch)

    result = _is_feature_branch(core_dir, repo_dir)

    if is_feature:
        assert result.returncode == 0
    else:
        assert result.returncode != 0


# hooks-config.json 制御テスト


def test_hooks_config_disabled_returns_feature_for_all_branches(
    core_dir: Path,
    git_repo,
    hooks_config,
) -> None:
    """branch-guard: false → WT ブランチでも feature 扱い（常に true）。"""
    hooks_config.write({"branch-guard": False})
    repo_dir = git_repo()
    _checkout(repo_dir, "wt1")

    result = _is_feature_branch(core_dir, repo_dir)

    assert result.returncode == 0


def test_hooks_config_enabled_uses_normal_judgement(
    core_dir: Path,
    git_repo,
    hooks_config,
) -> None:
    """branch-guard: true → 通常判定（develop-aist は非 feature）。"""
    hooks_config.write({"branch-guard": True})
    repo_dir = git_repo()
    _checkout(repo_dir, "develop-aist")

    result = _is_feature_branch(core_dir, repo_dir)

    assert result.returncode != 0


# エッジケース


def test_non_git_repo_is_not_feature(
    core_dir: Path,
    tmp_path: Path,
    hooks_config,  # noqa: ARG001 — PECOT_HOOKS_CONFIG_PATH を tmp に隔離する
) -> None:
    non_repo_dir = tmp_path / "not-a-repo"
    non_repo_dir.mkdir()

    result = _is_feature_branch(core_dir, non_repo_dir)

    assert result.returncode != 0


def test_detached_head_is_not_feature(
    core_dir: Path,
    git_repo,
    hooks_config,  # noqa: ARG001 — PECOT_HOOKS_CONFIG_PATH を tmp に隔離する
) -> None:
    repo_dir = git_repo()
    commit_hash = subprocess.run(
        ["git", "-C", str(repo_dir), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    subprocess.run(
        ["git", "-C", str(repo_dir), "checkout", commit_hash],
        check=True,
        capture_output=True,
        text=True,
    )

    result = _is_feature_branch(core_dir, repo_dir)

    assert result.returncode != 0
