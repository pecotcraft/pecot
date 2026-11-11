"""tests/cli/test_show_repo.py - ``pecot --show-repo`` (Phase 3 US1 / T023)。

CliRunner で CLI の実入出力と exit code を検証する。
"""

from __future__ import annotations

from unittest.mock import patch

from typer.testing import CliRunner
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands.main import app
from cli.core.repo_resolver import RepoRef

runner = CliRunner()


class TestShowRepoExplicit:
    @add_test_properties(verifies=["PW-COMMON-05", "PW-COMMON-06"])
    def test_explicit_repo(self) -> None:
        result = runner.invoke(app, ["--repo", "owner/repoA", "--show-repo"])
        assert result.exit_code == 0
        assert result.stdout == "resolved: owner/repoA\nsource:   explicit\n"


class TestShowRepoCurrentGit:
    @add_test_properties(verifies=["PW-COMMON-05", "PW-COMMON-07"])
    def test_current_git_origin(self) -> None:
        with patch(
            "cli.core.repo_resolver._detect_current_git_repo",
            return_value=(RepoRef(owner="owner", repo="repoA"), "origin"),
        ):
            result = runner.invoke(app, ["--show-repo"])
        assert result.exit_code == 0
        assert result.stdout == "resolved: owner/repoA\nsource:   current-git (origin)\n"


class TestShowRepoAmbiguous:
    @add_test_properties(verifies=["PW-COMMON-11"])
    def test_outside_git_without_repo(self) -> None:
        with patch(
            "cli.core.repo_resolver._detect_current_git_repo",
            return_value=None,
        ):
            result = runner.invoke(app, ["--show-repo"])
        assert result.exit_code == 2
        assert "repository is ambiguous" in result.stderr


class TestShowRepoInvalid:
    @add_test_properties(verifies=["PW-COMMON-10"])
    def test_invalid_repo_value(self) -> None:
        result = runner.invoke(app, ["--repo", "invalid", "--show-repo"])
        assert result.exit_code == 2
        combined = (result.stderr or "") + (result.output or "")
        assert "owner/repo" in combined


class TestShowRepoWithSubcommand:
    def test_subcommand_plus_show_repo_exits_before_subcommand(self) -> None:
        """サブコマンド併用時も ``--show-repo`` が優先して exit する (MVP 仕様)。"""
        result = runner.invoke(app, ["--repo", "owner/repoA", "--show-repo", "issue"])
        assert result.exit_code == 0
        assert result.stdout == "resolved: owner/repoA\nsource:   explicit\n"
