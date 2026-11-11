"""tests/cli/test_main.py - main.pyのCLIテスト

Typer CLIアプリケーションのテスト。
CliRunnerを使用してコマンドを実行。
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from cli import __version__
from cli.commands.main import app

runner = CliRunner()


# バージョン表示テスト


class TestVersionCommand:
    """バージョン表示のテスト"""

    def test_version_flag(self) -> None:
        """--version フラグでバージョン表示"""
        result = runner.invoke(app, ["--version"])
        assert result.exit_code == 0
        assert __version__ in result.stdout

    def test_version_short_flag(self) -> None:
        """-v フラグでバージョン表示"""
        result = runner.invoke(app, ["-v"])
        assert result.exit_code == 0
        assert __version__ in result.stdout


# ヘルプ表示テスト


class TestHelpCommand:
    """ヘルプ表示のテスト"""

    def test_help_flag(self) -> None:
        """--help フラグでヘルプ表示"""
        result = runner.invoke(app, ["--help"])
        assert result.exit_code == 0
        assert "pecot-workflow CLI" in result.stdout

    def test_no_args_shows_help(self) -> None:
        """引数なしでヘルプ表示"""
        result = runner.invoke(app, [])
        # no_args_is_help=True なのでヘルプが表示される（exit_code=2はTyperの仕様）
        # stderrに出力される場合があるため、outputで確認
        assert "Usage:" in result.output or result.exit_code == 2


# PECOT_GITHUB_API_URL の起動時の確認


class TestApiUrlOverrideGuard:
    """不正な PECOT_GITHUB_API_URL では、サブコマンドの前に止まる"""

    def test_invalid_value_stops_with_exit_1(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("PECOT_GITHUB_API_URL", "https://example.com")
        result = runner.invoke(app, ["session", "status"])
        assert result.exit_code == 1
        assert result.output.strip() == (
            "error: PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: "
            "https://example.com"
        )
        assert result.exception is None or isinstance(result.exception, SystemExit)

    def test_valid_value_does_not_stop(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        # --version は eager の callback で先に終わるので、main の本体まで届くサブコマンドで確かめる
        monkeypatch.setenv("PECOT_GITHUB_API_URL", "http://127.0.0.1:9")
        result = runner.invoke(app, ["session", "status", "-D", str(tmp_path)])
        assert result.exit_code == 0
        assert "PECOT_GITHUB_API_URL は" not in result.output


# ルートの網（PecotError を error: の 1 行と終了コード 1 にする）


class TestPecotErrorNet:
    def test_project_root_not_found_is_error_line(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        from cli.core.paths import ProjectRootNotFoundError

        monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
        monkeypatch.delenv("PECOT_SESSION_PROJECT_DIR", raising=False)
        monkeypatch.chdir(tmp_path)
        err = ProjectRootNotFoundError("project root not found: test")
        with patch("cli.commands.session.flag_exists", side_effect=err):
            result = runner.invoke(app, ["session", "status", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: project root not found: test" in result.stderr.splitlines()
        assert "Traceback" not in result.output + result.stderr

    def test_missing_token_is_error_line(self, tmp_path: Path) -> None:
        from cli.core.github import GitHubAuthError
        from cli.core.github.client import GitHubClientBase

        config = MagicMock(host="github.com")
        with (
            patch("cli.commands.issue.load_active_config", return_value=config),
            patch("cli.commands.issue._report_template_violations", return_value=False),
            patch.object(
                GitHubClientBase, "_get_token", side_effect=GitHubAuthError("could not get a token")
            ),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "-i",
                    "o/r/1",
                    "-m",
                    "x",
                    "--template",
                    "plan",
                ],
            )
        assert result.exit_code == 1
        assert any(line.startswith("error: ") for line in result.stderr.splitlines())
        assert "Traceback" not in result.output + result.stderr
