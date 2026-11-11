"""tests/cli/test_worktree_repo_policy.py - T050 / FR-009a.

`@require_repo_match(mode="reject")` が装着された worktree / branch 系コマンドを扱う。
``--repo`` とカレント Git remote が不一致のとき、exit 1 で拒否することを CliRunner + patch で検証する。

stderr の文言は ``contracts/cli-commands.md:76-79`` の固定メッセージと
一致すること。
"""

from __future__ import annotations

from unittest.mock import patch

from typer.testing import CliRunner

from cli.commands.main import app
from cli.core.repo_resolver import RepoRef

runner = CliRunner()


def _patch_current_git(owner: str = "acme-labs", repo: str = "pecot-cli"):
    return patch(
        "cli.core.repo_resolver._detect_current_git_repo",
        return_value=(RepoRef(owner=owner, repo=repo), "origin"),
    )


class TestWorktreeMismatchReject:
    """FR-009a: worktree 系コマンドは不一致で exit 1。"""

    def test_worktree_init_mismatch(self, tmp_path) -> None:
        with _patch_current_git():
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/aist-plugin",
                    "worktree",
                    "init",
                    "-D",
                    str(tmp_path),
                ],
            )
        assert result.exit_code == 1
        assert "differs from the current Git remote" in result.stderr

    def test_worktree_add_mismatch(self, tmp_path) -> None:
        with _patch_current_git():
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/aist-plugin",
                    "worktree",
                    "add",
                    "-D",
                    str(tmp_path),
                ],
            )
        assert result.exit_code == 1
        assert "differs from the current Git remote" in result.stderr

    def test_worktree_remove_mismatch(self, tmp_path) -> None:
        with _patch_current_git():
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/aist-plugin",
                    "worktree",
                    "remove",
                    "wt-1",
                    "-D",
                    str(tmp_path),
                ],
            )
        assert result.exit_code == 1
        assert "differs from the current Git remote" in result.stderr

    def test_worktree_link_mismatch(self, tmp_path) -> None:
        with _patch_current_git():
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/aist-plugin",
                    "worktree",
                    "link",
                    "--dry-run",
                    "-D",
                    str(tmp_path),
                ],
            )
        assert result.exit_code == 1
        assert "differs from the current Git remote" in result.stderr


class TestBranchMismatchReject:
    """FR-009a: create-branch / delete-branch は不一致で exit 1。"""

    def test_create_branch_mismatch(self) -> None:
        with _patch_current_git():
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/aist-plugin",
                    "create-branch",
                    "acme-labs/pecot-cli/44",
                    "feat/x",
                ],
            )
        assert result.exit_code == 1
        assert (
            "error: --repo acme-labs/aist-plugin differs from the current Git remote "
            "(acme-labs/pecot-cli)\n"
            "  this command works only on the repository of the current Git remote\n"
        ) == result.stderr

    def test_delete_branch_mismatch(self) -> None:
        with _patch_current_git():
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/aist-plugin",
                    "delete-branch",
                    "acme-labs/pecot-cli",
                    "feat/x",
                ],
            )
        assert result.exit_code == 1
        assert "differs from the current Git remote" in result.stderr


class TestMatchPassesThrough:
    """一致時は decorator が素通しで、後続処理に制御が移ること。"""

    def test_worktree_link_match_passes(self, tmp_path) -> None:
        with _patch_current_git(owner="acme-labs", repo="pecot-cli"):
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/pecot-cli",
                    "worktree",
                    "link",
                    "--dry-run",
                    "-D",
                    str(tmp_path),
                ],
            )
        # --dry-run: decorator を素通しして link 本体に入っても書き込みを起こさせない
        # 不一致エラーは出ない。exit code はコマンド側処理に依存するが
        # decorator 由来のエラー文言は absent。
        assert "differs from the current Git remote" not in result.stderr
