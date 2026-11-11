"""tests/cli/test_ops_ambiguous.py - T052 / FR-009 曖昧時。

``--repo`` 未明示 + Git 外 (=``_detect_current_git_repo`` が None を返す) の状況を扱う。
この状況で worktree/branch/release 系コマンドを呼ぶと exit 1 になる。
"the repository is ambiguous"を stderr に出力することを検証する。

決定は ``cli/_repo_policy.py::require_repo_match`` 側。
既存コマンド側が独自に ambiguous 判定していても、decorator が先に
確定したメッセージで exit するため stderr 文言は一貫する。
"""

from __future__ import annotations

from unittest.mock import patch

from typer.testing import CliRunner
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands.main import app

runner = CliRunner()


def _patch_no_git():
    return patch(
        "cli.core.repo_resolver._detect_current_git_repo",
        return_value=None,
    )


AMBIGUOUS_MSG = "error: the repository is ambiguous\n  give --repo <owner/repo>\n"


class TestAmbiguousOps:
    """--repo 無し + Git 外 で 3 コマンドが exit 1 + 曖昧メッセージ。"""

    def test_worktree_link_ambiguous(self, tmp_path) -> None:
        with _patch_no_git():
            result = runner.invoke(app, ["worktree", "link", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert AMBIGUOUS_MSG in result.stderr

    @add_test_properties(verifies=["PW-COMMON-17", "PW-CREATE-BRANCH-26", "PW-CREATE-BRANCH-27"])
    def test_create_branch_ambiguous(self) -> None:
        with _patch_no_git():
            result = runner.invoke(
                app,
                [
                    "create-branch",
                    "acme-labs/pecot-cli/44",
                    "feat/x",
                ],
            )
        assert result.exit_code == 1
        assert AMBIGUOUS_MSG in result.stderr

    @add_test_properties(verifies=["PW-RELEASE-PREFLIGHT-36", "PW-RELEASE-PREFLIGHT-37"])
    def test_release_preflight_ambiguous(self) -> None:
        with _patch_no_git():
            result = runner.invoke(app, ["release", "preflight", "0.99.0"])
        assert result.exit_code == 1
        assert AMBIGUOUS_MSG in result.stderr


class TestExplicitRepoOutsideGitPasses:
    """Git 外でも ``--repo`` 明示あれば decorator は素通し (比較対象なし)。"""

    def test_worktree_link_explicit_outside_git(self, tmp_path) -> None:
        with _patch_no_git():
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
        # decorator 由来の「曖昧です」エラーは出ない
        assert AMBIGUOUS_MSG not in result.stderr
