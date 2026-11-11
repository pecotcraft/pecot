"""tests/cli/test_session.py - session.pyのCLIテスト

セッション管理コマンド（フラグ状態表示）のテスト。
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from cli.commands.main import app
from cli.commands.session import _active_issue_lines, _collect_flag_statuses
from cli.core.github import GitHubAPIError

runner = CliRunner()


# _collect_flag_statuses のユニットテスト


class TestCollectFlagStatuses:
    """_collect_flag_statuses のテスト"""

    def test_all_flags_exist(self, tmp_path: Path) -> None:
        """全フラグが存在する場合"""
        with (
            patch("cli.commands.session.flag_exists", return_value=True),
            patch("cli.commands.session.read_flag", return_value="test-content"),
        ):
            result = _collect_flag_statuses()

        assert len(result) == 1
        for fs in result:
            assert fs.exists is True
            assert fs.content == "test-content"

    def test_partial_flags_exist(self, tmp_path: Path) -> None:
        """一部のフラグだけ存在する場合"""
        exists_map = {
            ".pecot-active": True,
        }
        content_map = {
            ".pecot-active": "owner/repo/123",
        }

        def mock_flag_exists(name: str) -> bool:
            return exists_map.get(name, False)

        def mock_read_flag(name: str) -> str | None:
            return content_map.get(name)

        with (
            patch("cli.commands.session.flag_exists", side_effect=mock_flag_exists),
            patch("cli.commands.session.read_flag", side_effect=mock_read_flag),
        ):
            result = _collect_flag_statuses()

        assert len(result) == 1
        # .pecot-active
        assert result[0].name == ".pecot-active"
        assert result[0].exists is True
        assert result[0].content == "owner/repo/123"

    def test_no_flags_exist(self) -> None:
        """全フラグが存在しない場合"""
        with (
            patch("cli.commands.session.flag_exists", return_value=False),
        ):
            result = _collect_flag_statuses()

        assert len(result) == 1
        for fs in result:
            assert fs.exists is False
            assert fs.content == ""


# flag_status コマンドの統合テスト


class TestFlagStatusCommand:
    """flag_status コマンドのテスト"""

    def test_normal_output(self, tmp_path: Path) -> None:
        """正常系: ブランチ・リポジトリ・フラグすべてあり"""
        exists_map = {
            ".pecot-active": True,
        }
        content_map = {
            ".pecot-active": "acme-labs/ai-engineer-starter-kit/867",
        }

        def mock_flag_exists(name: str) -> bool:
            return exists_map.get(name, False)

        def mock_read_flag(name: str) -> str | None:
            return content_map.get(name)

        with (
            patch(
                "cli.commands.session.git_current_branch",
                return_value="feat/20260202-120000/867",
            ),
            patch(
                "cli.commands.session.origin_repo",
                return_value=("github.com", "acme-labs", "ai-engineer-starter-kit"),
            ),
            patch("cli.commands.session.flag_exists", side_effect=mock_flag_exists),
            patch("cli.commands.session.read_flag", side_effect=mock_read_flag),
            patch("cli.commands.session.load_active_config", return_value=None),
        ):
            result = runner.invoke(app, ["session", "status", "-D", str(tmp_path)])

        assert result.exit_code == 0
        assert "# Session status" in result.output
        assert "- Branch: feat/20260202-120000/867" in result.output
        assert "- Repository: acme-labs/ai-engineer-starter-kit" in result.output
        assert "- Inferred Issue: #867" in result.output
        assert "| .pecot-active | set | acme-labs/ai-engineer-starter-kit/867 |" in result.output
        assert ".plan-post-pending" not in result.output

    def test_data_goes_to_stdout_and_warning_to_stderr(self, tmp_path: Path) -> None:
        """Markdown は stdout に 1 回、Issue を読めない warning は stderr に出る"""
        with (
            patch("cli.commands.session.git_current_branch", return_value="feat/x/7"),
            patch("cli.commands.session.origin_repo", return_value=("github.com", "acme", "demo")),
            patch("cli.commands.session.flag_exists", return_value=True),
            patch("cli.commands.session.read_flag", return_value="acme/demo/7"),
            patch("cli.commands.session.load_active_config", return_value=None),
        ):
            result = runner.invoke(app, ["session", "status", "-D", str(tmp_path)])

        assert result.exit_code == 0
        assert result.stdout == (
            "# Session status\n"
            "\n"
            "- Branch: feat/x/7\n"
            "- Repository: acme/demo\n"
            "- Inferred Issue: #7\n"
            "\n"
            "| Flag | State | Content |\n"
            "|------|-------|---------|\n"
            "| .pecot-active | set | acme/demo/7 |\n"
        )
        assert result.stderr == "warning: cannot read the active Issue: no active project\n"

    def test_unknown_branch(self, tmp_path: Path) -> None:
        """ブランチ不明時は unknown と表示"""
        with (
            patch("cli.commands.session.git_current_branch", return_value=None),
            patch(
                "cli.commands.session.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.session.flag_exists", return_value=False),
        ):
            result = runner.invoke(app, ["session", "status", "-D", str(tmp_path)])

        assert result.exit_code == 0
        assert "- Branch: unknown" in result.output
        assert "- Inferred Issue: none" in result.output

    def test_unknown_repo(self, tmp_path: Path) -> None:
        """リポジトリ不明時は unknown と表示"""
        with (
            patch(
                "cli.commands.session.git_current_branch",
                return_value="feat/test/123",
            ),
            patch("cli.commands.session.origin_repo", return_value=None),
            patch("cli.commands.session.flag_exists", return_value=False),
        ):
            result = runner.invoke(app, ["session", "status", "-D", str(tmp_path)])

        assert result.exit_code == 0
        assert "- Repository: unknown" in result.output
        assert "- Inferred Issue: #123" in result.output

    def test_no_flags(self, tmp_path: Path) -> None:
        """フラグなし環境でも正常終了"""
        with (
            patch(
                "cli.commands.session.git_current_branch",
                return_value="main",
            ),
            patch(
                "cli.commands.session.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.session.flag_exists", return_value=False),
        ):
            result = runner.invoke(app, ["session", "status", "-D", str(tmp_path)])

        assert result.exit_code == 0
        assert "- Inferred Issue: none" in result.output
        # 全フラグが unset で表示
        assert "| .pecot-active | unset |  |" in result.output
        assert ".plan-post-pending" not in result.output

    def test_branch_without_issue_number(self, tmp_path: Path) -> None:
        """Issue番号がないブランチの場合 none と表示"""
        with (
            patch(
                "cli.commands.session.git_current_branch",
                return_value="feat/no-issue-number",
            ),
            patch(
                "cli.commands.session.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.session.flag_exists", return_value=False),
        ):
            result = runner.invoke(app, ["session", "status", "-D", str(tmp_path)])

        assert result.exit_code == 0
        assert "- Inferred Issue: none" in result.output


# _active_issue_lines のユニットテスト


class TestShowActiveIssue:
    """_active_issue_lines のテスト"""

    def test_issue_info_displayed(self, capsys: object) -> None:
        """正常系: .pecot-activeにIssue参照があり、API成功 → タイトル・状態が表示"""
        from unittest.mock import MagicMock

        from cli.commands.session import FlagStatus

        flag_statuses = [
            FlagStatus(name=".pecot-active", exists=True, content="owner/repo/42"),
        ]

        mock_config = MagicMock()
        mock_config.host = "github.com"
        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "number": 42,
            "state": "OPEN",
            "title": "[Task] テスト用Issue",
            "body": "## 概要\nテスト用の本文です",
        }

        with (
            patch("cli.commands.session.load_active_config", return_value=mock_config),
            patch("cli.commands.session.GitHubClient", return_value=mock_client),
        ):
            lines = _active_issue_lines(flag_statuses)

        text = "\n".join(lines)
        assert "## Active Issue" in text
        assert "#42 [Task] テスト用Issue (OPEN)" in text
        assert "## 概要" in text
        assert "テスト用の本文です" in text
        mock_client.get_issue_slim.assert_called_once_with("owner", "repo", 42, comment_limit=0)

    def test_api_failure_shows_warning(self, capsys: object) -> None:
        """API失敗時: 警告メッセージが表示される"""
        from unittest.mock import MagicMock

        from cli.commands.session import FlagStatus

        flag_statuses = [
            FlagStatus(name=".pecot-active", exists=True, content="owner/repo/42"),
        ]

        mock_config = MagicMock()
        mock_config.host = "github.com"
        mock_client = MagicMock()
        mock_client.get_issue_slim.side_effect = GitHubAPIError("接続タイムアウト")

        with (
            patch("cli.commands.session.load_active_config", return_value=mock_config),
            patch("cli.commands.session.GitHubClient", return_value=mock_client),
        ):
            lines = _active_issue_lines(flag_statuses)

        captured = capsys.readouterr()  # type: ignore[union-attr]
        assert "warning: cannot read the active Issue:" in captured.err
        assert "接続タイムアウト" in captured.err
        assert lines == []
        assert captured.out == ""

    def test_no_active_flag_no_output(self, capsys: object) -> None:
        """フラグなし: Issue情報セクションが表示されない"""
        from cli.commands.session import FlagStatus

        flag_statuses = [
            FlagStatus(name=".pecot-active", exists=False, content=""),
        ]

        assert _active_issue_lines(flag_statuses) == []

        captured = capsys.readouterr()  # type: ignore[union-attr]
        assert captured.out == ""

    def test_no_active_config_shows_warning(self, capsys: object) -> None:
        """設定なし: 警告メッセージが表示される"""
        from cli.commands.session import FlagStatus

        flag_statuses = [
            FlagStatus(name=".pecot-active", exists=True, content="owner/repo/42"),
        ]

        with patch("cli.commands.session.load_active_config", return_value=None):
            lines = _active_issue_lines(flag_statuses)

        captured = capsys.readouterr()  # type: ignore[union-attr]
        assert captured.err == "warning: cannot read the active Issue: no active project\n"
        assert lines == []
        assert captured.out == ""

    def test_invalid_issue_ref_no_output(self, capsys: object) -> None:
        """不正なIssue参照: 何も表示しない"""
        from cli.commands.session import FlagStatus

        flag_statuses = [
            FlagStatus(name=".pecot-active", exists=True, content="invalid-ref"),
        ]

        assert _active_issue_lines(flag_statuses) == []

        captured = capsys.readouterr()  # type: ignore[union-attr]
        assert captured.out == ""


# Issue 参照のパーステストは tests/core/test_ref_parser.py に統合済み


# flag_restore コマンドの統合テスト


class TestFlagRestoreCommand:
    """flag_restore コマンドのテスト"""

    def test_restore_auto_detect(self, tmp_path: Path) -> None:
        """ブランチ名から自動推定して復元成功"""
        with (
            patch(
                "cli.commands.session.git_current_branch",
                return_value="feat/session-restore/870",
            ),
            patch(
                "cli.commands.session.origin_repo",
                return_value=("github.com", "acme-labs", "ai-engineer-starter-kit"),
            ),
            patch("cli.commands.session.load_active_config", return_value=None),
            patch("cli.commands._work_target.write_work_target") as mock_write,
        ):
            result = runner.invoke(app, ["session", "restore", "-D", str(tmp_path)])

        assert result.exit_code == 0
        assert "set: work target acme-labs/ai-engineer-starter-kit/870" in result.output
        assert "ブランチ" not in result.output
        # アクティブ設定が無いときはタイトル無しで記録する（復元は止めない）
        mock_write.assert_called_once_with("acme-labs/ai-engineer-starter-kit/870", "")

    def test_restore_records_session_title_from_issue(self, tmp_path: Path) -> None:
        """設定があれば Issue タイトルを取ってセッション名の材料として渡す"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {"title": "[Task] 復元テスト"}
        with (
            patch("cli.commands.session.load_active_config", return_value=mock_config),
            patch("cli.commands.session.GitHubClient", return_value=mock_client),
            patch("cli.commands._work_target.write_work_target") as mock_write,
        ):
            result = runner.invoke(
                app, ["session", "restore", "--issue", "owner/repo/123", "-D", str(tmp_path)]
            )

        assert result.exit_code == 0
        mock_client.get_issue_slim.assert_called_once_with("owner", "repo", 123, comment_limit=0)
        mock_write.assert_called_once_with("owner/repo/123", "[Task] 復元テスト")

    def test_restore_continues_when_title_fetch_fails(self, tmp_path: Path) -> None:
        """タイトル取得の API 失敗は復元を止めない（タイトル無しで記録）"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = MagicMock()
        mock_client.get_issue_slim.side_effect = GitHubAPIError("boom")
        with (
            patch("cli.commands.session.load_active_config", return_value=mock_config),
            patch("cli.commands.session.GitHubClient", return_value=mock_client),
            patch("cli.commands._work_target.write_work_target") as mock_write,
        ):
            result = runner.invoke(
                app, ["session", "restore", "--issue", "owner/repo/123", "-D", str(tmp_path)]
            )

        assert result.exit_code == 0
        mock_write.assert_called_once_with("owner/repo/123", "")

    def test_restore_stops_when_config_is_broken(self, tmp_path: Path) -> None:
        """設定ファイルが不正で ConfigError になったら error: の行で止まる（記録しない）"""
        from cli.core.config import ConfigError

        with (
            patch(
                "cli.commands.session.load_active_config",
                side_effect=ConfigError("invalid config file: x.json: boom"),
            ),
            patch("cli.commands._work_target.write_work_target") as mock_write,
        ):
            result = runner.invoke(
                app, ["session", "restore", "--issue", "owner/repo/123", "-D", str(tmp_path)]
            )

        assert result.exit_code == 1
        assert "error: invalid config file: x.json: boom" in result.output
        mock_write.assert_not_called()

    @staticmethod
    def _write_active_config(root: Path, content: str) -> None:
        projects = root / ".pecot" / "config" / "projects"
        projects.mkdir(parents=True)
        (projects / "broken.json").write_text(content)
        (projects / ".active").write_text("broken.json\n")

    @pytest.mark.parametrize("content", ["not json", '{"host":"github.com"}'])
    def test_restore_real_broken_config_exits_1(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, content: str
    ) -> None:
        """実ファイルの JSON 不正・形式違いは exit 1、error: の行、Traceback 無し、.pecot-active 無し"""
        self._write_active_config(tmp_path, content)
        monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))

        result = runner.invoke(
            app, ["session", "restore", "--issue", "owner/repo/123", "-D", str(tmp_path)]
        )

        assert result.exit_code == 1
        assert "error: invalid config file" in result.output
        assert "Traceback" not in result.output
        assert not (tmp_path / ".pecot" / "state" / ".pecot-active").exists()

    def test_restore_manual_issue(self, tmp_path: Path) -> None:
        """--issue owner/repo/123 で手動指定成功"""
        with (
            patch("cli.commands.session.load_active_config", return_value=None),
            patch("cli.commands._work_target.write_work_target") as mock_write,
        ):
            result = runner.invoke(
                app,
                [
                    "session",
                    "restore",
                    "--issue",
                    "owner/repo/123",
                    "-D",
                    str(tmp_path),
                ],
            )

        assert result.exit_code == 0
        assert "set: work target owner/repo/123" in result.output
        mock_write.assert_called_once_with("owner/repo/123", "")

    def test_restore_branch_without_issue(self, tmp_path: Path) -> None:
        """Issue番号なしブランチでエラー + HINTメッセージ"""
        with (
            patch(
                "cli.commands.session.git_current_branch",
                return_value="feat/no-issue-number",
            ),
        ):
            result = runner.invoke(app, ["session", "restore", "-D", str(tmp_path)])

        assert result.exit_code == 1
        assert (
            "error: cannot infer the Issue number from the branch name: feat/no-issue-number\n"
            "  run: pecot session restore --issue <owner/repo/N>\n"
        ) in result.output

    def test_restore_branch_not_found(self, tmp_path: Path) -> None:
        """ブランチ取得失敗でエラー"""
        with patch("cli.commands.session.git_current_branch", return_value=None):
            result = runner.invoke(app, ["session", "restore", "-D", str(tmp_path)])

        assert result.exit_code == 1
        assert "error: cannot read the branch name" in result.output

    def test_restore_repo_not_found(self, tmp_path: Path) -> None:
        """リポジトリ情報取得失敗でエラー"""
        with (
            patch(
                "cli.commands.session.git_current_branch",
                return_value="feat/test/789",
            ),
            patch(
                "cli.commands.session.origin_repo",
                return_value=None,
            ),
        ):
            result = runner.invoke(app, ["session", "restore", "-D", str(tmp_path)])

        assert result.exit_code == 1
        assert "error: cannot read the repository information" in result.output

    def test_restore_invalid_issue_ref(self, tmp_path: Path) -> None:
        """不正な --issue 形式でエラー"""
        result = runner.invoke(
            app,
            ["session", "restore", "--issue", "invalid-format", "-D", str(tmp_path)],
        )

        assert result.exit_code == 2
        assert result.output.startswith("error: ")
        assert "owner/repo/N" in result.output


class TestStatusWithBrokenConfig:
    """session status: 不正な設定は warning の行を出して表を出し、終了コード 0"""

    def test_warns_and_exits_0(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        TestFlagRestoreCommand._write_active_config(tmp_path, '{"host":"github.com"}')
        state = tmp_path / ".pecot" / "state"
        state.mkdir(parents=True)
        (state / ".pecot-active").write_text("owner/repo/42\n")
        monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))

        result = runner.invoke(app, ["session", "status", "-D", str(tmp_path)])

        assert result.exit_code == 0
        assert "warning: cannot read the active Issue: invalid config file" in result.output
        assert "Traceback" not in result.output
        assert "| .pecot-active | set |" in result.output
