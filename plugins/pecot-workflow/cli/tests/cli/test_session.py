"""tests/cli/test_session.py - session.pyのCLIテスト

セッション管理コマンド（フラグ状態表示）のテスト。
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner

from cli.commands.main import app
from cli.commands.session import _collect_flag_statuses, _show_active_issue
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
        assert "=== フラグ状態 ===" in result.output
        assert "ブランチ: feat/20260202-120000/867" in result.output
        assert "リポジトリ: acme-labs/ai-engineer-starter-kit" in result.output
        assert "推定Issue: #867" in result.output
        assert "| .pecot-active | ✓ | acme-labs/ai-engineer-starter-kit/867 |" in result.output
        assert ".plan-post-pending" not in result.output

    def test_unknown_branch(self, tmp_path: Path) -> None:
        """ブランチ不明時は (unknown) と表示"""
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
        assert "ブランチ: (unknown)" in result.output
        assert "推定Issue: (none)" in result.output

    def test_unknown_repo(self, tmp_path: Path) -> None:
        """リポジトリ不明時は (unknown) と表示"""
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
        assert "リポジトリ: (unknown)" in result.output
        assert "推定Issue: #123" in result.output

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
        assert "推定Issue: (none)" in result.output
        # 全フラグが "-" で表示
        assert "| .pecot-active | - |  |" in result.output
        assert ".plan-post-pending" not in result.output

    def test_branch_without_issue_number(self, tmp_path: Path) -> None:
        """Issue番号がないブランチの場合 (none) と表示"""
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
        assert "推定Issue: (none)" in result.output


# _show_active_issue のユニットテスト


class TestShowActiveIssue:
    """_show_active_issue のテスト"""

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
            _show_active_issue(flag_statuses)

        captured = capsys.readouterr()  # type: ignore[union-attr]
        assert "=== アクティブIssue ===" in captured.out
        assert "#42 [Task] テスト用Issue (OPEN)" in captured.out
        assert "## 概要" in captured.out
        assert "テスト用の本文です" in captured.out
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
            _show_active_issue(flag_statuses)

        captured = capsys.readouterr()  # type: ignore[union-attr]
        assert "⚠ Issue情報の取得に失敗しました" in captured.err
        assert "接続タイムアウト" in captured.err
        assert "⚠" not in captured.out
        assert "=== アクティブIssue ===" not in captured.out

    def test_no_active_flag_no_output(self, capsys: object) -> None:
        """フラグなし: Issue情報セクションが表示されない"""
        from cli.commands.session import FlagStatus

        flag_statuses = [
            FlagStatus(name=".pecot-active", exists=False, content=""),
        ]

        _show_active_issue(flag_statuses)

        captured = capsys.readouterr()  # type: ignore[union-attr]
        assert captured.out == ""

    def test_no_active_config_shows_warning(self, capsys: object) -> None:
        """設定なし: 警告メッセージが表示される"""
        from cli.commands.session import FlagStatus

        flag_statuses = [
            FlagStatus(name=".pecot-active", exists=True, content="owner/repo/42"),
        ]

        with patch("cli.commands.session.load_active_config", return_value=None):
            _show_active_issue(flag_statuses)

        captured = capsys.readouterr()  # type: ignore[union-attr]
        assert "⚠ Issue情報の取得に失敗しました" in captured.err
        assert "アクティブ設定が見つかりません" in captured.err
        assert "⚠" not in captured.out

    def test_invalid_issue_ref_no_output(self, capsys: object) -> None:
        """不正なIssue参照: 何も表示しない"""
        from cli.commands.session import FlagStatus

        flag_statuses = [
            FlagStatus(name=".pecot-active", exists=True, content="invalid-ref"),
        ]

        _show_active_issue(flag_statuses)

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
            patch("cli.commands.session.write_work_target") as mock_write,
        ):
            result = runner.invoke(app, ["session", "restore", "-D", str(tmp_path)])

        assert result.exit_code == 0
        assert "ブランチ: feat/session-restore/870" in result.output
        assert "推定Issue: acme-labs/ai-engineer-starter-kit/870" in result.output
        assert "復元完了: .pecot-active → acme-labs/ai-engineer-starter-kit/870" in result.output
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
            patch("cli.commands.session.write_work_target") as mock_write,
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
            patch("cli.commands.session.write_work_target") as mock_write,
        ):
            result = runner.invoke(
                app, ["session", "restore", "--issue", "owner/repo/123", "-D", str(tmp_path)]
            )

        assert result.exit_code == 0
        mock_write.assert_called_once_with("owner/repo/123", "")

    def test_restore_continues_when_config_is_broken(self, tmp_path: Path) -> None:
        """設定ファイルが不正で ConfigError になっても復元は止めない（タイトル無しで記録）"""
        from cli.core.config import ConfigError

        with (
            patch("cli.commands.session.load_active_config", side_effect=ConfigError("broken")),
            patch("cli.commands.session.write_work_target") as mock_write,
        ):
            result = runner.invoke(
                app, ["session", "restore", "--issue", "owner/repo/123", "-D", str(tmp_path)]
            )

        assert result.exit_code == 0
        mock_write.assert_called_once_with("owner/repo/123", "")

    def test_restore_manual_issue(self, tmp_path: Path) -> None:
        """--issue owner/repo/123 で手動指定成功"""
        with (
            patch("cli.commands.session.load_active_config", return_value=None),
            patch("cli.commands.session.write_work_target") as mock_write,
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
        assert "復元完了: .pecot-active → owner/repo/123" in result.output
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
        assert "Issue番号を推定できません" in result.output
        assert "HINT" in result.output

    def test_restore_branch_not_found(self, tmp_path: Path) -> None:
        """ブランチ取得失敗でエラー"""
        with patch("cli.commands.session.git_current_branch", return_value=None):
            result = runner.invoke(app, ["session", "restore", "-D", str(tmp_path)])

        assert result.exit_code == 1
        assert "ブランチ名を取得できません" in result.output

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
        assert "リポジトリ情報を取得できません" in result.output

    def test_restore_invalid_issue_ref(self, tmp_path: Path) -> None:
        """不正な --issue 形式でエラー"""
        result = runner.invoke(
            app,
            ["session", "restore", "--issue", "invalid-format", "-D", str(tmp_path)],
        )

        assert result.exit_code == 2
        assert "owner/repo/N" in result.output or "不正な参照形式" in result.output
