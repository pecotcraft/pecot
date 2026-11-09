"""tests/cli/test_issue.py - issue.pyのCLIテスト

add-to-project, update-issue-status, issue create コマンドのテスト。
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import typer
from typer.testing import CliRunner, Result

from cli.commands.issue import (
    _ORDER_PATTERN,
    TYPE_DEFAULT_STATUS,
    _build_issue_title,
    _check_duplicate_order,
    _format_issue_markdown,
    _issue_file_keys,
    _validate_issue_template,
)
from cli.commands.main import app
from cli.core.github import GitHubAPIError
from cli.core.sections import PLAN_FOLD_SUMMARY

runner = CliRunner()


# テスト用の共通Issue本文テンプレート（taskテンプレート準拠 / Goal-Acceptance）
MINIMAL_TASK_BODY = """## Goal — 達成したい状態

実現したい状態

## Acceptance — 達成判定

- **条件1** — 確認: pytest
"""

# テスト用のbugテンプレート（Problem / Acceptance）
MINIMAL_BUG_BODY = """## Problem — バグ概要

コマンド実行で異常終了する。環境は linux。

| Expected | Actual |
|---|---|
| 正常動作 | 異常動作 |

### Repro

1. ステップ1。

## Acceptance — 修復された状態

- **条件1** — 確認: pytest
"""

# テスト用のepicテンプレート（AS-IS / TO-BE / GAP）
MINIMAL_EPIC_BODY = """## AS-IS — 現状

現状の事実

## TO-BE — 完了時の状態

完了時にどうなっているか

## GAP — 埋めるべき差分

AS-IS と TO-BE の差
"""

# epic 雛形に現れてはならない記法（#958 で撤去した凡例・チェックリスト・リンク欄）
EPIC_TEMPLATE_FORBIDDEN_TOKENS = (
    "- [ ]",
    "凡例",
    "🏃",
    "✋",
    "💪",
    "▌",
    "担当者",
    "Issue リンク",
)


# parse_issue_ref テストは tests/core/test_ref_parser.py に移動


# --- _build_issue_title テスト ---


class TestBuildIssueTitle:
    """_build_issue_title 関数のテスト"""

    def test_task_without_parent_epic(self) -> None:
        """parent_epicなしの場合、従来通りプレフィックスのみ"""
        result = _build_issue_title("task", "タイトル")
        assert result == "[Task] タイトル"

    def test_task_with_parent_epic_and_order(self) -> None:
        """parent_epic+orderでEpic番号付きタイトル"""
        result = _build_issue_title("task", "タイトル", parent_epic=353, order=1)
        assert result == "[Task] #353-01: タイトル"

    def test_bug_with_parent_epic_and_order(self) -> None:
        """Bug型でparent_epic+order"""
        result = _build_issue_title("bug", "バグ名", parent_epic=100, order=2)
        assert result == "[Bug] #100-02: バグ名"

    def test_title_with_existing_prefix(self) -> None:
        """既にプレフィックスがあるタイトルで重複しない"""
        result = _build_issue_title("task", "[Task] タイトル", parent_epic=353, order=3)
        assert result == "[Task] #353-03: タイトル"

    def test_parent_epic_only_without_order(self) -> None:
        """parent_epicのみでorderなし→従来通りプレフィックスのみ"""
        result = _build_issue_title("task", "タイトル", parent_epic=353, order=None)
        assert result == "[Task] タイトル"

    def test_epic_type(self) -> None:
        """Epic型のプレフィックス"""
        result = _build_issue_title("epic", "大きな機能")
        assert result == "[Epic] 大きな機能"

    def test_order_double_digit(self) -> None:
        """orderが2桁の場合のゼロパディング"""
        result = _build_issue_title("task", "タスク", parent_epic=100, order=12)
        assert result == "[Task] #100-12: タスク"

    def test_unknown_type_with_parent_epic(self) -> None:
        """未知のタイプでparent_epic+order"""
        result = _build_issue_title("unknown", "タイトル", parent_epic=50, order=1)
        assert result == "#50-01: タイトル"

    def test_parallel_adds_letter_after_order(self) -> None:
        """枝の文字が段の直後に付く"""
        result = _build_issue_title("task", "タイトル", parent_epic=189, order=4, parallel="a")
        assert result == "[Task] #189-04a: タイトル"

    def test_parallel_none_is_same_as_before(self) -> None:
        """枝なしは従来のタイトルと一字一句同じ"""
        result = _build_issue_title("task", "タイトル", parent_epic=189, order=4, parallel=None)
        assert result == "[Task] #189-04: タイトル"

    def test_parallel_ignored_without_order(self) -> None:
        """orderなしでは枝があっても従来通りプレフィックスのみ"""
        result = _build_issue_title("task", "タイトル", parent_epic=189, parallel="a")
        assert result == "[Task] タイトル"


# --- _check_duplicate_order テスト ---


class TestCheckDuplicateOrder:
    """_check_duplicate_order 関数のテスト"""

    def test_no_duplicate(self) -> None:
        """重複なしの場合は正常終了"""
        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "sub_issues": [
                {"number": 10, "state": "OPEN", "title": "[Task] #353-01: タスクA"},
                {"number": 11, "state": "OPEN", "title": "[Task] #353-02: タスクB"},
            ],
        }
        # order=3 は重複しない
        _check_duplicate_order(mock_client, "owner", "repo", 353, 3)

    def test_duplicate_open_issue_raises_error(self) -> None:
        """同じorderのオープンIssueがある場合はエラー"""
        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "sub_issues": [
                {"number": 10, "state": "OPEN", "title": "[Task] #353-01: タスクA"},
                {"number": 11, "state": "OPEN", "title": "[Task] #353-02: タスクB"},
            ],
        }
        with pytest.raises(typer.Exit):
            _check_duplicate_order(mock_client, "owner", "repo", 353, 2)

    def test_closed_issue_also_duplicate(self) -> None:
        """クローズされたIssueも重複とみなす（orderは再利用不可）"""
        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "sub_issues": [
                {"number": 10, "state": "CLOSED", "title": "[Task] #353-01: タスクA"},
            ],
        }
        with pytest.raises(typer.Exit):
            _check_duplicate_order(mock_client, "owner", "repo", 353, 1)

    def test_error_message_shows_next_available_order(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """エラーメッセージに次の空きorder番号が表示される"""
        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "sub_issues": [
                {"number": 10, "state": "OPEN", "title": "[Task] #353-01: タスクA"},
                {"number": 11, "state": "CLOSED", "title": "[Task] #353-02: タスクB"},
                {"number": 12, "state": "OPEN", "title": "[Task] #353-03: タスクC"},
            ],
        }
        with pytest.raises(typer.Exit):
            _check_duplicate_order(mock_client, "owner", "repo", 353, 2)
        captured = capsys.readouterr()
        assert "次に使用可能なorder: 4" in captured.err

    def test_different_epic_not_duplicate(self) -> None:
        """異なるEpicのorderは重複とみなさない"""
        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "sub_issues": [
                {"number": 10, "state": "OPEN", "title": "[Task] #999-01: 別Epicのタスク"},
            ],
        }
        # parent_epic=353 で検索しているが、サブIssueのタイトルは #999
        _check_duplicate_order(mock_client, "owner", "repo", 353, 1)

    def test_no_sub_issues(self) -> None:
        """サブIssueがない場合は正常終了"""
        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "sub_issues": [],
        }
        _check_duplicate_order(mock_client, "owner", "repo", 353, 1)

    def test_api_error_continues(self) -> None:
        """API取得失敗時は警告のみで続行"""
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.get_issue_slim.side_effect = GitHubAPIError("Not found", 404)
        # エラーにならず正常終了
        _check_duplicate_order(mock_client, "owner", "repo", 353, 1)

    @pytest.mark.parametrize(
        ("title", "expected"),
        [
            ("[Task] #353-01: 旧形式", ("353", "01", None)),
            ("[Task] #353-04a: 枝つき", ("353", "04", "a")),
            ("#353-12d: 接頭辞なし", ("353", "12", "d")),
        ],
    )
    def test_order_pattern_parses_old_and_new_numbers(
        self, title: str, expected: tuple[str, str, str | None]
    ) -> None:
        """旧形式と枝つきの番号を同じパターンで読める"""
        match = _ORDER_PATTERN.search(title)
        assert match is not None
        assert match.groups() == expected

    @staticmethod
    def _client_with(*titles: str) -> MagicMock:
        client = MagicMock()
        client.get_issue_slim.return_value = {
            "sub_issues": [
                {"number": 10 + i, "state": "OPEN", "title": t} for i, t in enumerate(titles)
            ],
        }
        return client

    def test_same_order_same_parallel_is_duplicate(self) -> None:
        """同じ段・同じ枝は重複"""
        client = self._client_with("[Task] #353-04a: A")
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4, "a")

    def test_same_order_different_parallel_is_not_duplicate(self) -> None:
        """同じ段で枝が違えば重複ではない"""
        client = self._client_with("[Task] #353-04a: A", "[Task] #353-04b: B")
        _check_duplicate_order(client, "owner", "repo", 353, 4, "c")

    def test_new_branchless_conflicts_with_existing_branch(self) -> None:
        """枝なしの新規は、同じ段の枝ありの既存と衝突する"""
        client = self._client_with("[Task] #353-04a: A")
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4)

    def test_new_branch_conflicts_with_existing_branchless(self) -> None:
        """枝ありの新規は、同じ段の枝なしの既存と衝突する"""
        client = self._client_with("[Task] #353-04: A")
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4, "a")

    def test_different_order_with_parallel_is_not_duplicate(self) -> None:
        """段が違えば枝が同じでも重複ではない"""
        client = self._client_with("[Task] #353-04a: A")
        _check_duplicate_order(client, "owner", "repo", 353, 5, "a")

    def test_error_message_shows_number_with_letter(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """エラーメッセージに NNa の形で番号が出る"""
        client = self._client_with("[Task] #353-04a: A")
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4, "a")
        err = capsys.readouterr().err
        assert "order=04a" in err
        assert "#10 [Task] #353-04a: A" in err
        assert "次に使用可能な番号: 04b" in err

    def test_error_message_aligns_both_sides_with_two_digits(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """枝が絡む重複は、両側を NN と枝の文字の形でそろえて表示する"""
        client = self._client_with("[Task] #353-04: A")
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4, "a")
        err = capsys.readouterr().err
        assert "order=04a と重複するIssue（04）が既に存在します" in err

    def test_multiple_duplicates_show_first_match(self, capsys: pytest.CaptureFixture[str]) -> None:
        """重複が複数あるときは最初の一致を表示する"""
        client = self._client_with("[Task] #353-04a: A", "[Task] #353-04b: B")
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4)
        err = capsys.readouterr().err
        assert "#10 [Task] #353-04a: A" in err
        assert "#11" not in err

    def test_branch_conflict_suggests_first_unused_letter(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """枝の衝突では、その段で使われていない最初の枝の文字を案内する"""
        client = self._client_with("[Task] #353-04a: A", "[Task] #353-04c: C")
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4, "a")
        assert "次に使用可能な番号: 04b" in capsys.readouterr().err

    def test_branch_conflict_with_branchless_existing_suggests_next_order(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """枝なしの既存と衝突するときは、最大の段の次を案内する"""
        client = self._client_with("[Task] #353-04: A")
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4, "a")
        assert "次に使用可能なorder: 5" in capsys.readouterr().err

    def test_branch_conflict_without_unused_letter_suggests_next_order(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """同じ段の枝を a から z まで使い切っているときは、最大の段の次を案内する"""
        titles = [f"[Task] #353-04{c}: {c}" for c in "abcdefghijklmnopqrstuvwxyz"]
        client = self._client_with(*titles)
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4, "a")
        assert "次に使用可能なorder: 5" in capsys.readouterr().err

    def test_error_message_without_letters_is_same_as_before(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """枝なし同士の重複は従来と同じ文言になる"""
        client = self._client_with("[Task] #353-04: A")
        with pytest.raises(typer.Exit):
            _check_duplicate_order(client, "owner", "repo", 353, 4)
        err = capsys.readouterr().err
        assert "エラー: Epic #353 に order=4 のIssueが既に存在します" in err
        assert "重複するIssue" not in err


# --- _resolve_parent_epic_ref テスト ---


class TestResolveParentEpicRef:
    """_resolve_parent_epic_ref 関数のテスト"""

    def _make_config(self, aggregation: str | None) -> MagicMock:
        from cli.core.repo_resolver import RepoRef

        mock_config = MagicMock()
        if aggregation is None:
            mock_config.aggregation_repo_ref = None
        else:
            owner, repo = aggregation.split("/")
            mock_config.aggregation_repo_ref = RepoRef(owner=owner, repo=repo)
        return mock_config

    def test_int_with_aggregation_repo_resolves_to_aggregation(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """整数指定 + aggregation_repo 設定時 → aggregation_repo の Issue として解決 + note"""
        from cli.commands.issue import _resolve_parent_epic_ref

        config = self._make_config("acme-labs/aist-roadmap")
        ref = _resolve_parent_epic_ref(21, config, "acme-labs", "pecot-cli")

        assert ref.repo.owner == "acme-labs"
        assert ref.repo.repo == "aist-roadmap"
        assert ref.number == 21
        captured = capsys.readouterr()
        assert "note:" in captured.err
        assert "aggregation_repo" in captured.err
        assert "acme-labs/aist-roadmap" in captured.err

    def test_int_without_aggregation_repo_falls_back_to_task_repo(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """整数指定 + aggregation_repo 未設定時 → task repo にフォールバック、note なし"""
        from cli.commands.issue import _resolve_parent_epic_ref

        config = self._make_config(None)
        ref = _resolve_parent_epic_ref(21, config, "acme-labs", "pecot-cli")

        assert ref.repo.owner == "acme-labs"
        assert ref.repo.repo == "pecot-cli"
        assert ref.number == 21
        captured = capsys.readouterr()
        assert "note:" not in captured.err

    def test_int_with_aggregation_equal_to_task_repo_no_note(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """整数指定 + aggregation_repo と task repo が同じ場合は note 出力なし"""
        from cli.commands.issue import _resolve_parent_epic_ref

        config = self._make_config("acme-labs/pecot-cli")
        ref = _resolve_parent_epic_ref(21, config, "acme-labs", "pecot-cli")

        assert ref.repo.owner == "acme-labs"
        assert ref.repo.repo == "pecot-cli"
        captured = capsys.readouterr()
        assert "note:" not in captured.err

    def test_string_owner_repo_n_overrides_base(self) -> None:
        """owner/repo/N 主軸形式は base_repo を無視して指定リポに解決"""
        from cli.commands.issue import _resolve_parent_epic_ref

        config = self._make_config("agg/repo")
        ref = _resolve_parent_epic_ref("other/target/42", config, "task-owner", "task-repo")

        assert ref.repo.owner == "other"
        assert ref.repo.repo == "target"
        assert ref.number == 42

    def test_invalid_format_raises_bad_parameter(self) -> None:
        """不正な形式は typer.BadParameter を投げる"""
        from cli.commands.issue import _resolve_parent_epic_ref

        config = self._make_config("agg/repo")
        with pytest.raises(typer.BadParameter, match="parent_epic 解決失敗"):
            _resolve_parent_epic_ref("invalid-format", config, "owner", "repo")


# --- add-to-project コマンドテスト ---


class TestAddToProjectCommand:
    """add-to-project コマンドのテスト"""

    def test_no_active_config(self) -> None:
        """アクティブ設定がない場合はエラー"""
        with patch("cli.commands.issue.load_active_config", return_value=None):
            result = runner.invoke(app, ["add-to-project", "owner/repo/123"])
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output

    def test_invalid_issue_ref(self) -> None:
        """不正なIssue参照形式はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["add-to-project", "invalid-format"])
            assert result.exit_code == 2
            assert "不正な参照形式" in result.output

    def test_repo_not_in_project(self) -> None:
        """リポジトリがプロジェクトに含まれていない場合はエラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "project-owner"
        mock_config.project.number = 1
        mock_config.is_repo_in_project.return_value = False

        mock_client = MagicMock()

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["add-to-project", "owner/repo/123"])
            assert result.exit_code == 1
            assert "プロジェクトに含まれていません" in result.output

    def test_add_success(self) -> None:
        """正常にプロジェクトに追加"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["add-to-project", "owner/repo/123"])
            assert result.exit_code == 0
            assert "追加完了" in result.output
            assert "owner/repo/123" in result.output

            # API呼び出し確認
            mock_client.get_issue_node_id.assert_called_once_with("owner", "repo", 123)
            mock_client.add_to_project.assert_called_once_with("PVT_123", "I_abc123")

    def test_add_with_status(self) -> None:
        """--status オプション付きで追加"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_active"

        mock_client = MagicMock()
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["add-to-project", "owner/repo/123", "--status", "active"])
            assert result.exit_code == 0
            assert "追加完了" in result.output
            assert "ステータス設定: active" in result.output

            # ステータス更新API呼び出し確認
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_123", "PVTI_456", "PVTF_workflow", "opt_active"
            )

    def test_add_with_invalid_status(self) -> None:
        """存在しないステータスを指定した場合は警告"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None
        mock_config.get_option_id.return_value = None

        mock_client = MagicMock()
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["add-to-project", "owner/repo/123", "--status", "invalid"])
            assert result.exit_code == 0
            assert "追加完了" in result.output
            assert "警告" in result.output
            assert "invalid" in result.output

    def test_github_api_error(self) -> None:
        """GitHub APIエラー時"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.get_issue_node_id.side_effect = GitHubAPIError(
            "Issue not found", status_code=404
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["add-to-project", "owner/repo/123"])
            assert result.exit_code == 1
            assert "GitHub APIエラー" in result.output

    def test_add_with_default_status(self) -> None:
        """--status 未指定時にデフォルトで ready が設定される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_ready"

        mock_client = MagicMock()
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            # --status を指定しない
            result = runner.invoke(app, ["add-to-project", "owner/repo/123"])
            assert result.exit_code == 0
            assert "追加完了" in result.output
            # デフォルトで ready が設定される
            assert "ステータス設定: ready" in result.output

            # ステータス更新API呼び出し確認（デフォルト ready）
            mock_config.get_option_id.assert_called_with("workflow", "ready")
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_123", "PVTI_456", "PVTF_workflow", "opt_ready"
            )

    def test_help_shows_default_status(self) -> None:
        """ヘルプにデフォルト値 [default: ready] が表示される"""
        result = runner.invoke(app, ["add-to-project", "--help"])
        assert result.exit_code == 0
        assert "[default: ready]" in result.output


# --- update-issue-status コマンドテスト ---


class TestUpdateIssueStatusCommand:
    """update-issue-status コマンドのテスト"""

    def test_no_active_config(self) -> None:
        """アクティブ設定がない場合はエラー"""
        with patch("cli.commands.issue.load_active_config", return_value=None):
            result = runner.invoke(app, ["update-issue-status", "owner/repo/123", "active"])
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output

    def test_invalid_issue_ref(self) -> None:
        """不正なIssue参照形式はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["update-issue-status", "invalid-format", "active"])
            assert result.exit_code == 2
            assert "不正な参照形式" in result.output

    def test_repo_not_in_project(self) -> None:
        """リポジトリがプロジェクトに含まれていない場合はエラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "project-owner"
        mock_config.project.number = 1
        mock_config.is_repo_in_project.return_value = False

        mock_client = MagicMock()

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["update-issue-status", "owner/repo/123", "active"])
            assert result.exit_code == 1
            assert "プロジェクトに含まれていません" in result.output

    def test_invalid_status(self) -> None:
        """不正なステータスはエラー"""
        mock_config = MagicMock()
        mock_config.is_repo_in_project.return_value = True

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["update-issue-status", "owner/repo/123", "invalid"])
            assert result.exit_code == 1
            assert "backlog/pending/ready/active/in_review/archived" in result.output

    def test_issue_not_in_board(self) -> None:
        """Issueがボードにない場合はエラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.get_item_id_by_issue.return_value = None

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["update-issue-status", "owner/repo/123", "active"])
            assert result.exit_code == 1
            assert "ボードに存在しません" in result.output

    def test_update_success(self) -> None:
        """正常にステータス更新"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_active"

        mock_client = MagicMock()
        mock_client.get_item_id_by_issue.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["update-issue-status", "owner/repo/123", "active"])
            assert result.exit_code == 0
            assert "更新完了" in result.output
            assert "active" in result.output

            # API呼び出し確認
            mock_client.get_item_id_by_issue.assert_called_once_with(
                "PVT_123", "owner", "repo", 123
            )
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_123", "PVTI_456", "PVTF_workflow", "opt_active"
            )

    def test_update_all_statuses(self) -> None:
        """全ステータス（backlog/pending/ready/active/in_review/archived）が使用可能"""
        for status in ["backlog", "pending", "ready", "active", "in_review", "archived"]:
            mock_config = MagicMock()
            mock_config.host = "ghes.example.com"
            mock_config.project.id = "PVT_123"
            mock_config.is_repo_in_project.return_value = True
            mock_config.get_field_id.return_value = "PVTF_workflow"
            mock_config.get_option_id.return_value = f"opt_{status}"

            mock_client = MagicMock()
            mock_client.get_item_id_by_issue.return_value = "PVTI_456"

            with (
                patch("cli.commands.issue.load_active_config", return_value=mock_config),
                patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            ):
                result = runner.invoke(app, ["update-issue-status", "owner/repo/123", status])
                assert result.exit_code == 0, f"Status '{status}' failed: {result.output}"

    def test_github_api_error(self) -> None:
        """GitHub APIエラー時"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.get_item_id_by_issue.side_effect = GitHubAPIError("API error", status_code=500)

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["update-issue-status", "owner/repo/123", "active"])
            assert result.exit_code == 1
            assert "GitHub APIエラー" in result.output


# --- issue reopen コマンドテスト ---


class TestIssueReopenCommand:
    """issue reopen コマンドのテスト"""

    def test_no_active_config(self) -> None:
        """アクティブ設定がない場合はエラー"""
        with patch("cli.commands.issue.load_active_config", return_value=None):
            result = runner.invoke(app, ["issue", "reopen", "owner/repo/123"])
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output

    def test_invalid_issue_ref(self) -> None:
        """不正なIssue参照形式はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "reopen", "invalid-format"])
            assert result.exit_code == 2
            assert "不正な参照形式" in result.output

    def test_repo_not_in_project(self) -> None:
        """リポジトリがプロジェクトに含まれていない場合はエラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = False

        mock_client = MagicMock()

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "reopen", "owner/repo/123"])
            assert result.exit_code == 1
            assert "プロジェクトに含まれていません" in result.output

    def test_reopen_success(self) -> None:
        """基本的な再オープン成功"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.reopen_issue.return_value = {"state": "open", "number": 123}

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.time.sleep"),
        ):
            result = runner.invoke(app, ["issue", "reopen", "owner/repo/123"])
            assert result.exit_code == 0
            assert "Issue再オープン完了" in result.output
            assert "owner/repo/123" in result.output

            # API呼び出し確認（1回目: ステータス更新前、2回目: Automation対策）
            assert mock_client.reopen_issue.call_count == 2
            mock_client.reopen_issue.assert_called_with("owner", "repo", 123)

    def test_reopen_with_status(self) -> None:
        """--statusオプション指定での再オープン"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_active"

        mock_client = MagicMock()
        mock_client.reopen_issue.return_value = {"state": "open", "number": 123}
        mock_client.get_item_id_by_issue.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.time.sleep"),
        ):
            result = runner.invoke(app, ["issue", "reopen", "owner/repo/123", "--status", "active"])
            assert result.exit_code == 0
            assert "Issue再オープン完了" in result.output
            assert "ステータスを更新: active" in result.output

            # API呼び出し確認（1回目: ステータス更新前、2回目: Automation対策）
            assert mock_client.reopen_issue.call_count == 2
            mock_client.reopen_issue.assert_called_with("owner", "repo", 123)
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_123", "PVTI_456", "PVTF_workflow", "opt_active"
            )

    def test_reopen_with_comment(self) -> None:
        """--commentオプション指定での再オープン"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_ready"

        mock_client = MagicMock()
        mock_client.reopen_issue.return_value = {"state": "open", "number": 123}
        mock_client.get_item_id_by_issue.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.time.sleep"),
        ):
            result = runner.invoke(
                app,
                ["issue", "reopen", "owner/repo/123", "--comment", "追加対応が必要"],
            )
            assert result.exit_code == 0
            assert "Issue再オープン完了" in result.output
            assert "コメントを投稿しました" in result.output

            # API呼び出し確認（1回目: ステータス更新前、2回目: Automation対策）
            assert mock_client.reopen_issue.call_count == 2
            mock_client.reopen_issue.assert_called_with("owner", "repo", 123)
            mock_client.add_issue_comment.assert_called_once_with(
                "owner", "repo", 123, "追加対応が必要"
            )

    def test_reopen_not_on_board(self) -> None:
        """ボードに存在しない場合は警告のみ"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.reopen_issue.return_value = {"state": "open", "number": 123}
        mock_client.get_item_id_by_issue.return_value = None

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "reopen", "owner/repo/123"])
            assert result.exit_code == 0
            assert "Issue再オープン完了" in result.output
            assert "警告: Issue #123 はプロジェクトボードに存在しません" in result.output

            # Issue再オープンは2回実行されるが、ステータス更新は行われない
            assert mock_client.reopen_issue.call_count == 2
            mock_client.reopen_issue.assert_called_with("owner", "repo", 123)
            mock_client.update_project_item_field.assert_not_called()

    def test_reopen_state_not_open(self) -> None:
        """2回目のreopenでstateがopenにならない場合はエラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.reopen_issue.side_effect = [
            {"state": "open", "number": 123},  # 1回目: 成功
            {"state": "closed", "number": 123},  # 2回目: Automationで戻された
        ]

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.time.sleep"),
        ):
            result = runner.invoke(app, ["issue", "reopen", "owner/repo/123"])
            assert result.exit_code == 1
            assert "警告: Issueのstateが 'open' になりませんでした" in result.output

    def test_invalid_status(self) -> None:
        """不正なステータス値はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app, ["issue", "reopen", "owner/repo/123", "--status", "invalid"]
            )
            assert result.exit_code == 1
            assert "backlog/pending/ready/active/in_review/archived" in result.output


# --- ヘルプ表示テスト ---


class TestIssueCommandsHelp:
    """issue系コマンドのヘルプ表示テスト"""

    def test_add_to_project_help(self) -> None:
        """add-to-project --help"""
        result = runner.invoke(app, ["add-to-project", "--help"])
        assert result.exit_code == 0
        assert "owner/repo/123" in result.output or "Issue" in result.output

    def test_update_issue_status_help(self) -> None:
        """update-issue-status --help"""
        result = runner.invoke(app, ["update-issue-status", "--help"])
        assert result.exit_code == 0
        assert "backlog" in result.output or "status" in result.output.lower()


# --- issue create コマンドテスト ---


class TestIssueCreatePrepareCommand:
    """issue create --prepare コマンドのテスト"""

    def test_prepare_task_template(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """task テンプレートを準備"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app,
            [
                "issue",
                "create",
                "--prepare",
                "--template",
                "task",
                "--repo",
                "acme-labs/aist-plugin",
            ],
        )

        assert result.exit_code == 0
        assert "issue-task-" in result.output
        files = list(output_dir.glob("issue-task-*.md"))
        assert len(files) == 1
        content = files[0].read_text()
        assert "type: task" in content
        assert "parent_epic" in content
        assert "owner/repo/number" in content
        assert "aggregation_repo" in content

    def test_prepare_bug_template(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """bug テンプレートを準備"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app,
            [
                "issue",
                "create",
                "--prepare",
                "--template",
                "bug",
                "--repo",
                "acme-labs/aist-plugin",
            ],
        )

        assert result.exit_code == 0
        assert "issue-bug-" in result.output
        files = list(output_dir.glob("issue-bug-*.md"))
        assert len(files) == 1
        content = files[0].read_text()
        assert "type: bug" in content
        assert "parent_epic" in content
        assert "owner/repo/number" in content
        assert "aggregation_repo" in content

    def test_prepare_epic_template(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """epic テンプレートを準備"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(app, ["issue", "create", "--prepare", "--template", "epic"])

        assert result.exit_code == 0
        assert "issue-epic-" in result.output
        files = list(output_dir.glob("issue-epic-*.md"))
        assert len(files) == 1

        content = files[0].read_text(encoding="utf-8")
        # AS-IS / TO-BE / GAP の 3 見出し構成であること
        for heading in ("## AS-IS — ", "## TO-BE — ", "## GAP — "):
            assert heading in content, f"{heading} が雛形にありません"
        # 撤去した記法が復活していないこと（雛形は逐語コピーされるため本文全体を見る）。
        # チェックボックス記法だけは冒頭の書き方コメントが禁止記法として名指しするため、
        # コメント終端より後ろの本文部で見る
        body = content.split("-->", 1)[1]
        for forbidden in EPIC_TEMPLATE_FORBIDDEN_TOKENS:
            target = body if forbidden == "- [ ]" else content
            assert forbidden not in target, f"{forbidden} が雛形に残っています"

    def test_prepare_default_template_is_task(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--template を省略した場合はデフォルトで task"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app, ["issue", "create", "--prepare", "--repo", "acme-labs/aist-plugin"]
        )

        assert result.exit_code == 0
        assert "issue-task-" in result.output

    def test_prepare_short_option(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """短縮オプション -p が動作する"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app,
            ["issue", "create", "-p", "--template", "task", "--repo", "acme-labs/aist-plugin"],
        )

        assert result.exit_code == 0
        assert "issue-task-" in result.output

    def test_no_args_shows_error(self) -> None:
        """引数なしでエラーメッセージを表示"""
        result = runner.invoke(app, ["issue", "create"])

        assert result.exit_code == 1
        assert "引数が不足しています" in result.output
        assert "テンプレート準備" in result.output
        assert "直接投稿" in result.output

    def test_prepare_with_suffix(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """--suffix 指定時はファイル名へ反映される"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app,
            [
                "issue",
                "create",
                "--prepare",
                "--template",
                "task",
                "--suffix",
                "setup-auth",
                "--repo",
                "acme-labs/aist-plugin",
            ],
        )

        assert result.exit_code == 0
        assert "setup-auth" in result.output
        files = list(output_dir.glob("issue-task-*-setup-auth.md"))
        assert len(files) == 1
        assert "repository: acme-labs/aist-plugin" in files[0].read_text()

    def test_prepare_with_suffix_short_option(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """短縮オプション -s が動作する"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app,
            [
                "issue",
                "create",
                "-p",
                "--template",
                "task",
                "-s",
                "add-api",
                "--repo",
                "acme-labs/aist-plugin",
            ],
        )

        assert result.exit_code == 0
        assert "add-api" in result.output
        files = list(output_dir.glob("issue-task-*-add-api.md"))
        assert len(files) == 1
        assert "repository: acme-labs/aist-plugin" in files[0].read_text()

    def test_prepare_without_suffix_unchanged(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """サフィックス未指定時は従来通りのファイル名"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app,
            [
                "issue",
                "create",
                "--prepare",
                "--template",
                "task",
                "--repo",
                "acme-labs/aist-plugin",
            ],
        )

        assert result.exit_code == 0
        output_filename = Path(result.output.strip()).name
        # タイムスタンプ部分の後にサフィックスがないことを確認
        # フォーマット: issue-task-YYYYMMDD-HHMMSS.md
        parts = output_filename.removesuffix(".md").split("-")
        # issue, task, YYYYMMDD, HHMMSS の4パートのみ
        assert len(parts) == 4

    @pytest.mark.parametrize(
        ("suffix", "name_suffix"),
        [
            pytest.param("phase1", "-phase1", id="with-suffix"),
            pytest.param(None, "", id="without-suffix"),
        ],
    )
    def test_prepare_same_second_creates_distinct_files(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        suffix: str | None,
        name_suffix: str,
    ) -> None:
        """同一秒に 2 回実行しても上書きせず別ファイルになる（--suffix 有無の両方）"""
        from datetime import datetime as real_datetime

        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)
        fake_dt = MagicMock()
        fake_dt.now.return_value = real_datetime(2026, 5, 13, 10, 0, 0)

        argv = [
            "issue",
            "create",
            "--prepare",
            "--template",
            "task",
            *(["--suffix", suffix] if suffix else []),
            "--repo",
            "acme-labs/aist-plugin",
        ]
        with patch("cli.core.paths.datetime", fake_dt):
            result1 = runner.invoke(app, argv)
            result2 = runner.invoke(app, argv)

        assert result1.exit_code == 0, result1.output
        assert result2.exit_code == 0, result2.output
        assert Path(result1.output.strip()).name == f"issue-task-20260513-100000{name_suffix}.md"
        assert Path(result2.output.strip()).name == f"issue-task-20260513-100001{name_suffix}.md"

        files = sorted(output_dir.glob(f"issue-task-*{name_suffix}.md"))
        assert len(files) == 2
        for file in files:
            if suffix:
                assert suffix in _issue_file_keys(file)
            assert "repository: acme-labs/aist-plugin" in file.read_text(encoding="utf-8")

    def test_prepare_reservation_error_exits_one(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """出力パス予約に失敗すると exit 1 で例外メッセージを表示する"""
        import cli.commands.issue as issue_module
        from cli.core.paths import OutputPathReservationError

        message = "出力パスを予約できませんでした（候補を使い切りました）"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: tmp_path / "pecot")

        def _raise(*_args: object, **_kwargs: object) -> object:
            raise OutputPathReservationError(message)

        monkeypatch.setattr(issue_module, "reserved_output_path", _raise)

        result = runner.invoke(
            app,
            ["issue", "create", "--prepare", "--template", "task", "--repo", "owner/repo"],
        )

        assert result.exit_code == 1
        assert f"エラー: {message}" in result.output
        assert not (tmp_path / "pecot").exists()

    def test_prepare_task_requires_repo(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--template task で --repo 省略は exit 2"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(app, ["issue", "create", "--prepare", "--template", "task"])

        assert result.exit_code == 2
        assert "--repo owner/repo" in result.output
        assert "必須" in result.output

    def test_prepare_bug_requires_repo(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--template bug で --repo 省略は exit 2"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(app, ["issue", "create", "--prepare", "--template", "bug"])

        assert result.exit_code == 2
        assert "--repo owner/repo" in result.output
        assert "必須" in result.output

    def test_prepare_task_implement_requires_repo(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--template task-implement で --repo 省略は exit 2"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app, ["issue", "create", "--prepare", "--template", "task-implement"]
        )

        assert result.exit_code == 2
        assert "--repo owner/repo" in result.output
        assert "必須" in result.output

    def test_prepare_repo_invalid_format_no_slash(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--repo にスラッシュ無しは exit 2"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app,
            ["issue", "create", "--prepare", "--template", "task", "--repo", "aist-plugin"],
        )

        assert result.exit_code == 2
        assert "不正なリポジトリ形式" in result.output

    def test_prepare_repo_invalid_format_too_many_segments(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--repo に 3 セグメントは exit 2"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app, ["issue", "create", "--prepare", "--template", "task", "--repo", "a/b/c"]
        )

        assert result.exit_code == 2
        assert "不正なリポジトリ形式" in result.output

    def test_prepare_repo_invalid_format_empty(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--repo に空文字は exit 2"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app, ["issue", "create", "--prepare", "--template", "task", "--repo", ""]
        )

        assert result.exit_code == 2
        assert "不正なリポジトリ形式" in result.output

    def test_prepare_repo_invalid_format_empty_repo_segment(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--repo に空の repo セグメント (foo/) は exit 2"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app, ["issue", "create", "--prepare", "--template", "task", "--repo", "foo/"]
        )

        assert result.exit_code == 2
        assert "不正なリポジトリ形式" in result.output

    def test_prepare_repo_invalid_format_empty_owner_segment(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--repo に空の owner セグメント (/foo) は exit 2"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app, ["issue", "create", "--prepare", "--template", "task", "--repo", "/foo"]
        )

        assert result.exit_code == 2
        assert "不正なリポジトリ形式" in result.output

    def test_prepare_repo_invalid_format_whitespace_segments(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--repo にスペース混じりセグメント ( a / b ) は exit 2"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app, ["issue", "create", "--prepare", "--template", "task", "--repo", " a / b "]
        )

        assert result.exit_code == 2
        assert "不正なリポジトリ形式" in result.output

    def test_prepare_repo_written_into_frontmatter(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--repo 指定時に frontmatter の repository: 行に書き込まれる"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app,
            [
                "issue",
                "create",
                "--prepare",
                "--template",
                "task",
                "--repo",
                "acme-labs/aist-plugin",
            ],
        )

        assert result.exit_code == 0
        files = list(output_dir.glob("issue-task-*.md"))
        assert len(files) == 1
        content = files[0].read_text()
        assert "repository: acme-labs/aist-plugin" in content
        assert 'repository: ""' not in content

    def test_prepare_epic_repo_optional(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """--template epic は --repo 無しでも成功し repository: \"\" を維持"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(app, ["issue", "create", "--prepare", "--template", "epic"])

        assert result.exit_code == 0
        files = list(output_dir.glob("issue-epic-*.md"))
        assert len(files) == 1
        content = files[0].read_text()
        assert 'repository: ""' in content

    def test_template_files_have_empty_repository_line(self) -> None:
        """4 テンプレ全てが repository: \"\" 行を含む（置換ロジック保護）"""
        from cli.commands.issue import TEMPLATES_DIR

        for name in ("task", "bug", "epic", "task-implement"):
            template_path = TEMPLATES_DIR / f"{name}.md"
            content = template_path.read_text(encoding="utf-8")
            assert 'repository: ""' in content, f'{name}.md missing repository: "" line'


class TestIssueCreateCommand:
    """issue create コマンドのテスト"""

    # --- 正常系テスト ---

    def test_create_minimal_success(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """正常系: 最小構成（title/type/repository/status）でIssue作成"""
        # テストファイル作成
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            """---
title: テスト機能の実装
type: task
repository: owner/repo
status: ready
---

## タスク概要

テスト本文
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_ready"

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
        }
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_789"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),  # バリデーションをスキップ
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0
            assert "https://ghes.example.com/owner/repo/issues/456" in result.output

            # API呼び出し確認（プレフィックスが付与される）
            mock_client.create_issue.assert_called_once_with(
                owner="owner",
                repo="repo",
                title="[Task] テスト機能の実装",
                body="## タスク概要\n\nテスト本文",
                labels=None,
            )
            mock_client.get_issue_node_id.assert_called_once_with("owner", "repo", 456)
            mock_client.add_to_project.assert_called_once_with("PVT_123", "I_abc123")

    def test_create_full_success(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """正常系: フル構成（全フィールド指定）でIssue作成"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            '---\ntitle: "[Task] 新機能の実装"\n'
            """type: task
repository: owner/repo
status: ready
priority: high
size: m
labels:
  - enhancement
  - skill
parent_epic: 100
order: 1
---

"""
            "## タスク概要\n\n詳細な説明。\n",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.aggregation_repo_ref = None

        # フィールドIDとオプションID
        def get_field_id(name: str) -> str | None:
            return {
                "workflow": "PVTF_workflow",
                "priority": "PVTF_priority",
                "size": "PVTF_size",
            }.get(name)

        def get_option_id(field: str, value: str) -> str | None:
            options = {
                ("workflow", "ready"): "opt_ready",
                ("priority", "high"): "opt_high",
                ("size", "m"): "opt_m",
            }
            return options.get((field, value))

        mock_config.get_field_id.side_effect = get_field_id
        mock_config.get_option_id.side_effect = get_option_id

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
        }
        mock_client.get_issue_node_id.side_effect = lambda o, r, n: {
            456: "I_new456",
            100: "I_epic100",
        }.get(n, f"I_{n}")
        mock_client.add_to_project.return_value = "PVTI_789"
        mock_client.add_sub_issue.return_value = {
            "parent_number": 100,
            "child_number": 456,
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),  # バリデーションをスキップ
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0
            assert "https://ghes.example.com/owner/repo/issues/456" in result.output

            # Issue作成確認（ラベル付き、order付きタイトル）
            mock_client.create_issue.assert_called_once_with(
                owner="owner",
                repo="repo",
                title="[Task] #100-01: 新機能の実装",
                body="## タスク概要\n\n詳細な説明。",
                labels=["enhancement", "skill"],
            )

            # フィールド設定確認
            update_calls = mock_client.update_project_item_field.call_args_list
            assert len(update_calls) == 3  # status, priority, size

            # サブIssue紐づけ確認
            mock_client.add_sub_issue.assert_called_once_with("I_epic100", "I_new456")

    def test_create_with_parent_epic_and_order(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """正常系: parent_epic+orderでタイトルにEpic番号が付与される"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            '---\ntitle: "認証機能の実装"\n'
            """type: task
repository: owner/repo
status: ready
parent_epic: 353
order: 3
---

"""
            "## タスク概要\n\n認証機能。\n",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.aggregation_repo_ref = None
        mock_config.get_field_id.return_value = None
        mock_config.get_option_id.return_value = None

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 500,
            "html_url": "https://ghes.example.com/owner/repo/issues/500",
        }
        mock_client.get_issue_node_id.side_effect = lambda o, r, n: {
            500: "I_new500",
            353: "I_epic353",
        }.get(n, f"I_{n}")
        mock_client.add_to_project.return_value = "PVTI_999"
        mock_client.add_sub_issue.return_value = {
            "parent_number": 353,
            "child_number": 500,
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0

            # タイトルにEpic番号+orderが含まれることを確認
            mock_client.create_issue.assert_called_once_with(
                owner="owner",
                repo="repo",
                title="[Task] #353-03: 認証機能の実装",
                body="## タスク概要\n\n認証機能。",
                labels=None,
            )

    def _invoke_create_with_parallel(
        self, tmp_path: Path, existing_titles: list[str]
    ) -> tuple[Result, MagicMock]:
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            '---\ntitle: "認証機能の実装"\n'
            "type: task\nrepository: owner/repo\nstatus: ready\n"
            "parent_epic: 353\norder: 3\nparallel: a\n---\n\n"
            "## タスク概要\n\n認証機能。\n",
            encoding="utf-8",
        )
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.aggregation_repo_ref = None
        mock_config.get_field_id.return_value = None
        mock_config.get_option_id.return_value = None

        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "sub_issues": [
                {"number": 10 + i, "state": "OPEN", "title": t}
                for i, t in enumerate(existing_titles)
            ],
        }
        mock_client.create_issue.return_value = {
            "number": 500,
            "html_url": "https://ghes.example.com/owner/repo/issues/500",
        }
        mock_client.get_issue_node_id.side_effect = lambda o, r, n: f"I_{n}"
        mock_client.add_to_project.return_value = "PVTI_999"
        mock_client.add_sub_issue.return_value = {"parent_number": 353, "child_number": 500}

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
        return result, mock_client

    def test_create_with_parallel_adds_letter_to_title(self, tmp_path: Path) -> None:
        """正常系: parallel があるとタイトルに枝の文字が付く"""
        result, mock_client = self._invoke_create_with_parallel(tmp_path, [])
        assert result.exit_code == 0
        mock_client.create_issue.assert_called_once_with(
            owner="owner",
            repo="repo",
            title="[Task] #353-03a: 認証機能の実装",
            body="## タスク概要\n\n認証機能。",
            labels=None,
        )

    def test_create_with_parallel_passes_when_sibling_has_other_letter(
        self, tmp_path: Path
    ) -> None:
        """正常系: 同じ段の既存が別の枝なら重複にならない"""
        result, mock_client = self._invoke_create_with_parallel(
            tmp_path, ["[Task] #353-03b: 別の枝"]
        )
        assert result.exit_code == 0
        assert (
            mock_client.create_issue.call_args.kwargs["title"] == "[Task] #353-03a: 認証機能の実装"
        )

    def test_create_with_parallel_exits_when_sibling_is_branchless(self, tmp_path: Path) -> None:
        """異常系: 同じ段の既存が枝なしなら重複で終了する"""
        result, mock_client = self._invoke_create_with_parallel(
            tmp_path, ["[Task] #353-03: 旧形式"]
        )
        assert result.exit_code == 1
        mock_client.create_issue.assert_not_called()

    # --- 異常系テスト ---

    def test_create_no_active_config(self, tmp_path: Path) -> None:
        """異常系: アクティブ設定がない場合はエラー"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            """---
title: test
type: task
repository: owner/repo
status: ready
---

body
""",
            encoding="utf-8",
        )

        with patch("cli.commands.issue.load_active_config", return_value=None):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output

    def test_create_direct_invalid_repo_shape(self) -> None:
        """異常系: 直接投稿で --repo が不正形式 (foo/) なら exit 2"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "create",
                    "-t",
                    "title",
                    "-r",
                    "foo/",
                    "-m",
                    "## タスク概要\n\n本文",
                ],
            )
            assert result.exit_code == 2
            assert "不正なリポジトリ形式" in result.output

    def test_create_file_not_found(self) -> None:
        """異常系: ファイルが存在しない場合はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "create", "/nonexistent/file.md"])
            assert result.exit_code == 1
            assert "ファイルが見つかりません" in result.output

    def test_create_validation_error(self, tmp_path: Path) -> None:
        """異常系: フロントマターバリデーションエラー"""
        # 必須フィールド（repository）が欠落
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            """---
title: test
type: task
---

body
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 1
            assert "バリデーションエラー" in result.output or "repository" in result.output

    def test_create_repo_not_in_project(self, tmp_path: Path) -> None:
        """異常系: リポジトリがプロジェクトに含まれていない場合はエラー"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            f"""---
title: test
type: task
repository: unknown/repo
status: ready
---

{MINIMAL_TASK_BODY}""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = False

        mock_client = MagicMock()

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 1
            assert "プロジェクトに紐づいていません" in result.output

    def test_create_github_api_error(self, tmp_path: Path) -> None:
        """異常系: GitHub APIエラー（Issue作成失敗）"""
        from cli.core.github import GitHubAPIError

        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            f"""---
title: test
type: task
repository: owner/repo
status: ready
---

{MINIMAL_TASK_BODY}""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.create_issue.side_effect = GitHubAPIError(
            "Repository not found", status_code=404
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 1
            assert "Issue作成失敗" in result.output

    def test_create_board_add_failure_partial_success(self, tmp_path: Path) -> None:
        """異常系: ボード追加失敗時は警告を出してIssue URLを返す（部分成功）"""
        from cli.core.github import GitHubAPIError

        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            f"""---
title: test
type: task
repository: owner/repo
status: ready
---

{MINIMAL_TASK_BODY}""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
        }
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.side_effect = GitHubAPIError(
            "Project not found", status_code=404
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            # 部分成功なのでexit_code=0
            assert result.exit_code == 0
            # 警告メッセージ
            assert "警告" in result.output
            assert "ボード追加失敗" in result.output
            # Issue URLは出力される
            assert "https://ghes.example.com/owner/repo/issues/456" in result.output

    def test_create_sub_issue_link_failure_exits(self, tmp_path: Path) -> None:
        """異常系: サブIssue紐づけ失敗時は URL 先出し→エラー→exit 1 で停止"""
        from cli.core.github import GitHubAPIError

        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            f"""---
title: test
type: task
repository: owner/repo
status: ready
parent_epic: 999
order: 1
---

{MINIMAL_TASK_BODY}""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.aggregation_repo_ref = None
        mock_config.get_field_id.return_value = None
        mock_config.get_option_id.return_value = None

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
        }
        # get_issue_slim は _check_duplicate_order で呼ばれる（空の sub_issues を返す）
        mock_client.get_issue_slim.return_value = {"sub_issues": []}
        mock_client.get_issue_node_id.side_effect = lambda o, r, n: {
            456: "I_new456",
            999: "I_epic999",
        }.get(n, f"I_{n}")
        mock_client.add_to_project.return_value = "PVTI_789"
        mock_client.add_sub_issue.side_effect = GitHubAPIError("Epic not found", status_code=404)

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 1
            # 手動修復のため、URL を先に stdout へ出している
            assert "https://ghes.example.com/owner/repo/issues/456" in result.output
            # エラーメッセージ（stderr 含め mix されて output に入る）
            assert "サブIssue紐づけ失敗" in result.output

    # --- プレフィックス自動付与テスト ---

    def test_create_adds_task_prefix(self, tmp_path: Path) -> None:
        """type: task の場合、タイトルに [Task] プレフィックスを付与"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            f"""---
title: テスト機能の実装
type: task
repository: owner/repo
status: ready
---

{MINIMAL_TASK_BODY}""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_ready"

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
        }
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_789"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0

            # プレフィックスが付与されていることを確認
            mock_client.create_issue.assert_called_once()
            call_kwargs = mock_client.create_issue.call_args[1]
            assert call_kwargs["title"] == "[Task] テスト機能の実装"

    def test_create_adds_bug_prefix(self, tmp_path: Path) -> None:
        """type: bug の場合、タイトルに [Bug] プレフィックスを付与"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            f"""---
title: ボタンが押せない
type: bug
repository: owner/repo
status: ready
---

{MINIMAL_BUG_BODY}""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_ready"

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
        }
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_789"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0

            call_kwargs = mock_client.create_issue.call_args[1]
            assert call_kwargs["title"] == "[Bug] ボタンが押せない"

    def test_create_adds_epic_prefix(self, tmp_path: Path) -> None:
        """type: epic の場合、タイトルに [Epic] プレフィックスを付与"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            f"""---
title: ユーザー認証機能の実装
type: epic
repository: owner/repo
status: backlog
---

{MINIMAL_EPIC_BODY}""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_backlog"

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
        }
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_789"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0

            call_kwargs = mock_client.create_issue.call_args[1]
            assert call_kwargs["title"] == "[Epic] ユーザー認証機能の実装"

    def test_create_no_duplicate_prefix(self, tmp_path: Path) -> None:
        """既にプレフィックスがある場合は重複付与しない"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            '---\ntitle: "[Task] 既存のプレフィックス付きタイトル"\n'
            "type: task\nrepository: owner/repo\nstatus: ready\n---\n\n"
            f"{MINIMAL_TASK_BODY}",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_ready"

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
        }
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_789"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0

            # 重複付与されていないことを確認
            call_kwargs = mock_client.create_issue.call_args[1]
            assert call_kwargs["title"] == "[Task] 既存のプレフィックス付きタイトル"
            # [Task] [Task] にはなっていない
            assert not call_kwargs["title"].startswith("[Task] [Task]")

    # --- ヘルプ表示テスト ---

    def test_create_help(self) -> None:
        """issue create --help"""
        result = runner.invoke(app, ["issue", "create", "--help"])
        assert result.exit_code == 0
        assert "create" in result.output.lower() or "作成" in result.output


# --- issue comment prepare コマンドテスト ---


class TestIssueCommentTemplateRequired:
    """コメントのテンプレートは既定が無く、指定しないと止まる"""

    @pytest.mark.parametrize(
        "args",
        [
            ["issue", "comment", "--prepare"],
            ["issue", "comment", "-m", "## Merge — x", "--issue", "owner/repo/1"],
        ],
        ids=["prepare", "message"],
    )
    def test_missing_template_option_exits_1(self, args: list[str]) -> None:
        result = runner.invoke(app, args)

        assert result.exit_code == 1
        assert (
            "エラー: -t でテンプレートを指定してください"
            "（plan / merge-diff / review-findings / review-resolution / precede-notify）"
        ) in result.output

    def test_file_without_template_exits_1(self, tmp_path: Path) -> None:
        comment_file = tmp_path / "comment.md"
        comment_file.write_text(
            '---\nissue_ref: "owner/repo/1"\n---\n\n## Merge — x\n', encoding="utf-8"
        )

        with patch("cli.commands.issue.load_active_config", return_value=MagicMock()):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert result.exit_code == 1
        assert "エラー: frontmatter の template を指定してください" in result.output


class TestIssueCommentPrepareCommand:
    """issue comment --prepare コマンドのテスト"""

    def test_prepare_merge_diff_template(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """merge-diff テンプレートを準備"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(app, ["issue", "comment", "-t", "merge-diff", "--prepare"])

        assert result.exit_code == 0
        assert "comment-merge-diff-" in result.output
        files = list(output_dir.glob("comment-merge-diff-*.md"))
        assert len(files) == 1
        content = files[0].read_text()
        assert "template: merge-diff" in content
        assert "issue_ref:" in content

    def test_prepare_with_issue_ref(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """--issue オプションでissue_refが設定される"""
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(
            app, ["issue", "comment", "-t", "merge-diff", "--prepare", "--issue", "owner/repo/123"]
        )

        assert result.exit_code == 0
        files = list(output_dir.glob("comment-merge-diff-*.md"))
        assert len(files) == 1
        content = files[0].read_text()
        assert 'issue_ref: "owner/repo/123"' in content

    def test_prepare_same_second_keeps_each_issue_ref(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """同一秒 2 連続でも上書きせず、各ファイルに個別の issue_ref が残る"""
        from datetime import datetime as real_datetime

        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)
        fake_dt = MagicMock()
        fake_dt.now.return_value = real_datetime(2026, 5, 13, 10, 0, 0)

        with patch("cli.core.paths.datetime", fake_dt):
            result1 = runner.invoke(
                app,
                ["issue", "comment", "-t", "merge-diff", "--prepare", "--issue", "owner/repo/1056"],
            )
            result2 = runner.invoke(
                app,
                ["issue", "comment", "-t", "merge-diff", "--prepare", "--issue", "owner/repo/1057"],
            )

        assert result1.exit_code == 0, result1.output
        assert result2.exit_code == 0, result2.output
        file1 = Path(result1.output.strip())
        file2 = Path(result2.output.strip())
        assert file1.name == "comment-merge-diff-20260513-100000.md"
        assert file2.name == "comment-merge-diff-20260513-100001.md"
        assert 'issue_ref: "owner/repo/1056"' in file1.read_text(encoding="utf-8")
        assert 'issue_ref: "owner/repo/1057"' in file2.read_text(encoding="utf-8")

    def test_prepare_reservation_error_exits_one(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """出力パス予約に失敗すると exit 1 で例外メッセージを表示する"""
        import cli.commands.issue as issue_module
        from cli.core.paths import OutputPathReservationError

        message = "出力パスを予約できませんでした（候補を使い切りました）"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: tmp_path / "pecot")

        def _raise(*_args: object, **_kwargs: object) -> object:
            raise OutputPathReservationError(message)

        monkeypatch.setattr(issue_module, "reserved_output_path", _raise)

        result = runner.invoke(app, ["issue", "comment", "-t", "merge-diff", "--prepare"])

        assert result.exit_code == 1
        assert f"エラー: {message}" in result.output
        assert not (tmp_path / "pecot").exists()

    def test_prepare_template_not_found(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """テンプレートが見つからない場合はエラー"""
        import cli.commands.issue as issue_module

        empty_templates = tmp_path / "empty_templates"
        empty_templates.mkdir()
        monkeypatch.setattr(issue_module, "COMMENT_TEMPLATES_DIR", empty_templates)

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        result = runner.invoke(app, ["issue", "comment", "-t", "merge-diff", "--prepare"])

        assert result.exit_code == 1
        assert "テンプレートが見つかりません" in result.output

    def test_prepare_help(self) -> None:
        """issue comment --help"""
        result = runner.invoke(app, ["issue", "comment", "--help"])
        assert result.exit_code == 0
        assert "テンプレート" in result.output or "template" in result.output.lower()


# --- issue comment --file コマンドテスト ---


class TestIssueCommentCreateCommand:
    """issue comment --file コマンドのテスト"""

    def test_create_success(self, tmp_path: Path) -> None:
        """正常系: コメント投稿成功"""
        comment_file = tmp_path / "comment.md"
        # テンプレートのすべてのセクションを含むコメント
        comment_file.write_text(
            '---\nissue_ref: "owner/repo/123"\ntemplate: merge-diff\n---\n\n'
            """## Merge — タスク1完了

### Variance — タスク1完了

- **タスク1** — pytest で確認。

### Impact — 次のタスク

- **次のタスク** — 詳細は `.pecot/work/123/plan.md`。
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {
            "id": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/123#issuecomment-456",
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])
            assert result.exit_code == 0
            assert "コメント投稿完了" in result.output
            assert "owner/repo/123" in result.output

            # API呼び出し確認
            mock_client.add_issue_comment.assert_called_once()
            call_args = mock_client.add_issue_comment.call_args
            assert call_args[0][0] == "owner"
            assert call_args[0][1] == "repo"
            assert call_args[0][2] == 123
            # 4番目の引数はコメント本文
            assert "### Variance —" in call_args[0][3]

    def test_create_no_active_config(self, tmp_path: Path) -> None:
        """異常系: アクティブ設定がない場合はエラー"""
        comment_file = tmp_path / "comment.md"
        comment_file.write_text(
            """---
issue_ref: "owner/repo/123"
---

body
""",
            encoding="utf-8",
        )

        with patch("cli.commands.issue.load_active_config", return_value=None):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output

    def test_create_invalid_issue_ref(self, tmp_path: Path) -> None:
        """異常系: 不正なissue_ref形式はエラー"""
        comment_file = tmp_path / "comment.md"
        comment_file.write_text(
            """---
issue_ref: "invalid-format"
---

body
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])
            assert result.exit_code == 2
            assert "不正な参照形式" in result.output

    def test_create_missing_required_sections(self, tmp_path: Path) -> None:
        """異常系: 必須セクションが不足している場合はエラー"""
        comment_file = tmp_path / "comment.md"
        comment_file.write_text(
            """---
issue_ref: "owner/repo/123"
template: merge-diff
---

## 進捗報告

テスト本文（セクションなし）
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])
            assert result.exit_code == 3
            assert "不足セクション" in result.output

    def test_create_github_api_error(self, tmp_path: Path) -> None:
        """異常系: GitHub APIエラー"""
        from cli.core.github import GitHubAPIError

        comment_file = tmp_path / "comment.md"
        # テンプレートのすべてのセクションを含むコメント
        comment_file.write_text(
            """---
issue_ref: "owner/repo/123"
template: merge-diff
---

## Merge — テスト

### Variance — テスト
- テスト

### Impact — テスト
- テスト
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.add_issue_comment.side_effect = GitHubAPIError(
            "Issue not found", status_code=404
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])
            assert result.exit_code == 1
            assert "コメント投稿失敗" in result.output

    def test_create_help(self) -> None:
        """issue comment --help で位置引数FILEが表示される"""
        result = runner.invoke(app, ["issue", "comment", "--help"])
        assert result.exit_code == 0
        assert "FILE" in result.output or "file" in result.output.lower()


_MERGE_DIFF_BODY = """## Merge — タスク1完了

### Variance — タスク1完了

- **タスク1** — pytest で確認。

### Impact — 次のタスク

- **次のタスク** — 詳細は `.pecot/work/123/plan.md`。
"""


def _host_of(url: str) -> str:
    return url.split("/")[2]


class TestIssueCommentUpdateByFile:
    """issue comment <file> の comment_url による書き戻しと更新"""

    def _config(self, host: str = "github.com") -> MagicMock:
        config = MagicMock()
        config.host = host
        config.is_repo_in_project.return_value = True
        return config

    def _write(self, path: Path, extra: str = "") -> Path:
        path.write_text(
            f'---\nissue_ref: "owner/repo/123"\ntemplate: merge-diff\n{extra}---\n\n{_MERGE_DIFF_BODY}',
            encoding="utf-8",
        )
        return path

    @pytest.mark.parametrize(
        "url",
        [
            "https://github.com/owner/repo/issues/123#issuecomment-456",
            "https://github.com/owner/repo/pull/123#issuecomment-456",
            "https://ghes.example.com/owner/repo/pull/123#issuecomment-456",
        ],
    )
    def test_new_post_writes_back_comment_url(self, tmp_path: Path, url: str) -> None:
        """新規投稿の後、frontmatter に comment_url を書き戻す。本文は変えない"""
        comment_file = self._write(tmp_path / "comment.md")
        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {"id": 456, "html_url": url}

        with (
            patch(
                "cli.commands.issue.load_active_config", return_value=self._config(_host_of(url))
            ),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert result.exit_code == 0, result.output
        content = comment_file.read_text(encoding="utf-8")
        assert content.startswith(
            f'---\nissue_ref: "owner/repo/123"\ntemplate: merge-diff\ncomment_url: "{url}"\n---\n'
        )
        assert content.endswith(_MERGE_DIFF_BODY)
        mock_client.update_issue_comment.assert_not_called()

    def test_pr_comment_round_trip_updates_instead_of_posting_again(self, tmp_path: Path) -> None:
        """PR へのコメントを 1 回目で投稿し、2 回目は書き戻された /pull/ の URL で書き換える"""
        comment_file = self._write(tmp_path / "comment.md")
        url = "https://github.com/owner/repo/pull/123#issuecomment-456"
        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {"id": 456, "html_url": url}
        mock_client.update_issue_comment.return_value = {"id": 456, "html_url": url}

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            first = runner.invoke(app, ["issue", "comment", str(comment_file)])
            second = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert first.exit_code == 0, first.output
        assert second.exit_code == 0, second.output
        assert mock_client.add_issue_comment.call_count == 1
        args = mock_client.update_issue_comment.call_args[0]
        assert args[:3] == ("owner", "repo", 456)

    @pytest.mark.parametrize(
        "url",
        [
            "https://github.com/owner/repo/issues/123#issuecomment-456",
            "https://github.com/owner/repo/pull/123#issuecomment-456",
            "https://ghes.example.com/owner/repo/pull/123#issuecomment-456",
        ],
    )
    def test_comment_url_updates_existing_comment(self, tmp_path: Path, url: str) -> None:
        """comment_url があれば、新しく投稿せずにそのコメントを書き換える"""
        comment_file = self._write(tmp_path / "comment.md", f'comment_url: "{url}"\n')
        mock_client = MagicMock()
        mock_client.update_issue_comment.return_value = {"id": 456, "html_url": url}

        with (
            patch(
                "cli.commands.issue.load_active_config", return_value=self._config(_host_of(url))
            ),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert result.exit_code == 0, result.output
        assert "コメント更新完了: owner/repo/123" in result.output
        assert url in result.output
        mock_client.add_issue_comment.assert_not_called()
        args = mock_client.update_issue_comment.call_args[0]
        assert args[:3] == ("owner", "repo", 456)
        assert "### Variance —" in args[3]

    @pytest.mark.parametrize(
        "url",
        [
            "https://github.com/other/repo/issues/123#issuecomment-456",
            "https://github.com/owner/repo/issues/124#issuecomment-456",
            "https://github.com/owner/repo/pull/124#issuecomment-456",
        ],
    )
    def test_comment_url_for_other_issue_is_rejected(self, tmp_path: Path, url: str) -> None:
        """issue_ref と別の Issue を指す comment_url では、API を呼ばずに止める"""
        comment_file = self._write(tmp_path / "comment.md", f'comment_url: "{url}"\n')
        mock_client = MagicMock()

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert result.exit_code == 1
        assert "違う Issue を指しています" in result.output
        mock_client.add_issue_comment.assert_not_called()
        mock_client.update_issue_comment.assert_not_called()

    def test_comment_url_for_other_host_is_rejected(self, tmp_path: Path) -> None:
        """設定のホストと違うホストの comment_url では、API を呼ばずに止める"""
        url = "https://ghes.example.com/owner/repo/pull/123#issuecomment-456"
        comment_file = self._write(tmp_path / "comment.md", f'comment_url: "{url}"\n')
        mock_client = MagicMock()

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._config("github.com")),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert result.exit_code == 1
        assert (
            "comment_url のホスト（ghes.example.com）が設定のホスト（github.com）と違います"
            in result.output
        )
        mock_client.add_issue_comment.assert_not_called()
        mock_client.update_issue_comment.assert_not_called()

    @pytest.mark.parametrize(
        "url",
        [
            "https://github.com/owner/repo/issues/123",
            "https://github.com/owner/repo/pull/123/files#issuecomment-456",
            "https://github.com/owner/repo/pull/123#discussion_r456",
        ],
    )
    def test_malformed_comment_url_shows_expected_form(self, tmp_path: Path, url: str) -> None:
        """形の違う comment_url では、API を呼ばずに期待する形を案内して止める"""
        comment_file = self._write(tmp_path / "comment.md", f'comment_url: "{url}"\n')
        mock_client = MagicMock()

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert result.exit_code == 1
        assert "形が違います" in result.output
        assert "/{issues|pull}/<番号>#issuecomment-<id>" in result.output
        mock_client.add_issue_comment.assert_not_called()
        mock_client.update_issue_comment.assert_not_called()

    def test_update_failure_exits_1(self, tmp_path: Path) -> None:
        """更新の API が失敗したら exit 1"""
        url = "https://github.com/owner/repo/issues/123#issuecomment-456"
        comment_file = self._write(tmp_path / "comment.md", f'comment_url: "{url}"\n')
        mock_client = MagicMock()
        mock_client.update_issue_comment.side_effect = GitHubAPIError("Not Found", status_code=404)

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert result.exit_code == 1
        assert "コメント更新失敗" in result.output


# --- issue comment 直接投稿コマンドテスト ---


class TestCommentDirectCommand:
    """issue comment 直接投稿コマンドのテスト"""

    def test_direct_success_with_valid_message(self) -> None:
        """正常系: テンプレート準拠のコメント投稿"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {
            "id": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/123#issuecomment-456",
        }

        # テンプレートのすべてのセクションを含むメッセージ
        valid_message = """## Merge — タスク完了

### Variance — タスク完了
- **タスク完了** — pytest で確認

### Impact — 次のタスク
- **次のタスク** — 判断待ちなし
"""

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "-t",
                    "merge-diff",
                    "--message",
                    valid_message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 0
            assert "コメント投稿完了" in result.output

    def test_direct_validation_missing_sections(self) -> None:
        """異常系: 必須セクション不足でエラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "-t",
                    "merge-diff",
                    "--message",
                    "テンプレート非準拠",
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 3
            assert "不足セクション" in result.output

    def test_direct_no_active_config(self) -> None:
        """異常系: アクティブ設定がない場合はエラー"""
        with patch("cli.commands.issue.load_active_config", return_value=None):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "-t",
                    "merge-diff",
                    "--message",
                    "test",
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output

    def test_direct_invalid_issue_ref(self) -> None:
        """異常系: 不正なissue_ref形式はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "-t",
                    "merge-diff",
                    "--message",
                    "## test",
                    "--issue",
                    "invalid-format",
                ],
            )
            assert result.exit_code == 2
            assert "不正な参照形式" in result.output

    def test_direct_github_api_error(self) -> None:
        """異常系: GitHub APIエラー"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.add_issue_comment.side_effect = GitHubAPIError(
            "Issue not found", status_code=404
        )

        # テンプレートのすべてのセクションを含むメッセージ
        valid_message = """## Merge — テスト

### Variance — テスト
- テスト

### Impact — テスト
- テスト
"""

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "-t",
                    "merge-diff",
                    "--message",
                    valid_message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 1
            assert "コメント投稿失敗" in result.output

    def test_direct_missing_issue_option(self) -> None:
        """異常系: -m指定時に--issueがないとエラー"""
        result = runner.invoke(
            app, ["issue", "comment", "-t", "merge-diff", "--message", "## test"]
        )
        assert result.exit_code == 1
        assert "-m使用時は --issue (Issue参照) が必須です" in result.output

    def test_direct_review_findings_template_success(self) -> None:
        """正常系: review-findings テンプレートでのコメント投稿"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {
            "id": 789,
            "html_url": "https://ghes.example.com/owner/repo/issues/123#issuecomment-789",
        }

        valid_message = """## Findings — PR #123 のレビュー指摘 0 件

### General — 非インライン指摘なし
- 非インライン指摘なし

### Disposition — 指摘なし
- 指摘なし
"""

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    "review-findings",
                    "--message",
                    valid_message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 0
            assert "コメント投稿完了" in result.output

            mock_client.add_issue_comment.assert_called_once()
            call_args = mock_client.add_issue_comment.call_args
            assert call_args[0][0] == "owner"
            assert call_args[0][1] == "repo"
            assert call_args[0][2] == 123
            assert call_args[0][3].startswith("## ")

    def test_direct_review_resolution_template_success(self) -> None:
        """正常系: review-resolution テンプレートでのコメント投稿"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {
            "id": 790,
            "html_url": "https://ghes.example.com/owner/repo/issues/123#issuecomment-790",
        }

        valid_message = """## Resolution — PR #123 の対応報告 (対応なし)

### Decision — 提案どおり
- 提案どおり。

### Applied — 補足なし
- 補足なし。

### Declined — 対応しなかった指摘なし
- 対応しなかった指摘なし。
"""

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    "review-resolution",
                    "--message",
                    valid_message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 0
            assert "コメント投稿完了" in result.output

            mock_client.add_issue_comment.assert_called_once()
            call_args = mock_client.add_issue_comment.call_args
            assert call_args[0][0] == "owner"
            assert call_args[0][1] == "repo"
            assert call_args[0][2] == 123
            assert call_args[0][3].startswith("## ")

    def test_direct_review_summary_template_rejected(self) -> None:
        """異常系: 廃止された review-summary テンプレは enum エラーで弾かれる"""
        result = runner.invoke(
            app,
            [
                "issue",
                "comment",
                "--template",
                "review-summary",
                "--message",
                "## dummy",
                "--issue",
                "owner/repo/123",
            ],
        )
        # typer の Invalid value で exit code 2 が仕様
        assert result.exit_code == 2
        assert "review-summary" in result.output or "Invalid value" in result.output

    def test_direct_precede_notify_template_success(self) -> None:
        """正常系: precede-notify テンプレートでのコメント投稿"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {
            "id": 901,
            "html_url": "https://ghes.example.com/owner/repo/issues/123#issuecomment-901",
        }

        valid_message = """## Notice — 先行PR #100 の完了通知

### Changes — foo.py の API 変更
- foo.py の API を変更。

### Checks — 呼び出し側の追従
- 呼び出し側の追従が必要。
"""

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    "precede-notify",
                    "--message",
                    valid_message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 0
            assert "コメント投稿完了" in result.output

            mock_client.add_issue_comment.assert_called_once()
            call_args = mock_client.add_issue_comment.call_args
            assert call_args[0][0] == "owner"
            assert call_args[0][1] == "repo"
            assert call_args[0][2] == 123
            assert "### Changes" in call_args[0][3]
            assert "### Checks" in call_args[0][3]

    def test_direct_merge_diff_template_em_dash_success(self) -> None:
        """正常系: merge-diff テンプレートの em-dash 形式本文が validation を通る"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {
            "id": 902,
            "html_url": "https://ghes.example.com/owner/repo/issues/123#issuecomment-902",
        }

        valid_message = """## Merge — #200 サンプルタスク完了

### Variance — 計画通り完了
- 計画通り完了

### Impact — 後続なし
- 後続タスクへの影響なし
"""

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    "merge-diff",
                    "--message",
                    valid_message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 0
            assert "コメント投稿完了" in result.output

            mock_client.add_issue_comment.assert_called_once()
            call_args = mock_client.add_issue_comment.call_args
            assert "### Variance" in call_args[0][3]
            assert "### Impact" in call_args[0][3]

    def test_direct_merge_diff_template_legacy_no_em_dash_rejected(self) -> None:
        """旧フォーマット (英語ラベルなし / em-dash サマリなし) の本文は validation で reject される。

        テンプレ実体 (`templates/comment/merge-diff.md`) は h3 を
        `### <英語ラベル> — <日本語サマリ>` 形式に統一済み。
        旧来の `### 計画との差分` 系見出しは新ラベル (`Variance` 等) と
        em-dash サマリの両方を欠くため、`validate_sections` で不足扱いになる。
        過去に投稿された旧フォーマットコメントは、遡って直す対象にしない (Issue #553 Acceptance 5)。
        """
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        legacy_message = """## マージ完了: #201 サンプル

### 計画との差分
- 計画通り完了

### 後続への影響
- 影響する後続タスクなし
"""

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    "merge-diff",
                    "--message",
                    legacy_message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 3
            assert "不足セクション" in result.output
            assert "Variance" in result.output

    def test_direct_merge_diff_template_h2_placeholder_rejected(self) -> None:
        """h2 サマリにテンプレのプレースホルダが残ったまま投稿しようとすると reject される。

        新形式テンプレ (`## Merge — <…>`) で h3 は埋まっていても、
        h2 サマリに `<…>` プレースホルダが残っていることがある。
        その本文は見出しのプレースホルダ検出（`validate_body_style`）で reject される。
        プレースホルダ文は上限 50 文字に収まるため、サマリ規則では止まらない。
        """
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        message = """## Merge — <#<issue番号> <タイトル> の完了サマリを1行で>

### Variance — 計画通り完了
- 計画通り完了

### Impact — 後続なし
- 後続タスクへの影響なし
"""

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    "merge-diff",
                    "--message",
                    message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 3
            assert "見出しサマリの規則違反" not in result.output
            assert "未編集プレースホルダ" in result.output

    def test_direct_merge_diff_h3_summary_51_chars_rejected(self) -> None:
        """異常系: merge-diff の h3 サマリが51文字だと comment コマンドで reject される。

        merge-diff は SUMMARY_MAX_CHARS=50 検証下に入った。
        h3 サマリ超過が exit 3 になり、不足セクションとは別の行で報告されることを回帰固定する。
        """
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        over = "あ" * 51
        message = f"""## Merge — テスト

### Variance — {over}
- テスト

### Impact — テスト
- テスト
"""

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    "merge-diff",
                    "--message",
                    message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 3
            assert (
                "エラー: 見出しサマリの規則違反: ### Variance — サマリが51文字です" in result.output
            )
            assert "不足セクション" not in result.output

    def test_direct_plan_template_success(self) -> None:
        """正常系: plan テンプレートの記入例本文が validation を通る"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {
            "id": 903,
            "html_url": "https://ghes.example.com/owner/repo/issues/123#issuecomment-903",
        }

        valid_message = self._plan_body(folded=True, filler=10)

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    "plan",
                    "--message",
                    valid_message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 0
            assert "コメント投稿完了" in result.output

            mock_client.add_issue_comment.assert_called_once()
            call_args = mock_client.add_issue_comment.call_args
            assert "### Context" in call_args[0][3]
            assert "### Notes" in call_args[0][3]
            assert "### E2E" in call_args[0][3]

    @staticmethod
    def _plan_body(*, folded: bool, filler: int = 8500) -> str:
        """Approach の末尾に filler 文字の細部を置いた plan 本文（folded なら details に畳む）"""
        detail = "あ" * filler
        if folded:
            detail = f"<details>\n{PLAN_FOLD_SUMMARY}\n\n{detail}\n\n</details>"
        return f"""## Plan

plan テンプレの見出しを名前だけにする。

### Context

comment テンプレの見出しを Claude Code の標準に揃える。

### Approach

plan テンプレを唯一の置き場にし、見出しを閉じた集合にする。

{detail}

### Files

- `templates/comment/plan.md`

<details>
{PLAN_FOLD_SUMMARY}

- `templates/comment/plan.md` — 見出しを名前だけにする

</details>

### Notes

なし

## PECOT-Workflow

テンプレを取って確かめる。

### E2E

`pecot issue comment --prepare -t plan` でテンプレを取って確かめる。

<details>
{PLAN_FOLD_SUMMARY}

CUJ 1

- 誰が — 利用者
- 起点 — `pecot issue comment --prepare -t plan`
- テスト手順
  1. テンプレを取る
- 合格基準 — 見出しが名前だけになっている

</details>
"""

    @staticmethod
    @contextmanager
    def _github_mocks(*, in_project: bool = False) -> Iterator[MagicMock]:
        """config / GitHubClient を差し替え、モックした client を返す"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = in_project
        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {"id": 1, "html_url": "https://x/1"}
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            yield mock_client

    def _invoke_direct(self, template: str, message: str) -> tuple[Result, MagicMock]:
        with self._github_mocks() as client:
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    template,
                    "--message",
                    message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
        return result, client

    def _invoke_file(self, path: Path) -> tuple[Result, MagicMock]:
        with self._github_mocks(in_project=True) as client:
            result = runner.invoke(app, ["issue", "comment", str(path)])
        return result, client

    def test_direct_plan_visible_over_old_limit_passes(self) -> None:
        """正常系: 折りたたみの外が 8000 文字を超えても plan は通る（#1330）"""
        result, client = self._invoke_direct("plan", self._plan_body(folded=False))
        assert result.exit_code == 0, result.output
        assert "折りたたみの規則違反" not in result.output
        client.add_issue_comment.assert_called_once()

    def test_direct_plan_visible_folded_passes(self) -> None:
        """正常系: 同じ分量を details に畳めば plan は通る"""
        result, client = self._invoke_direct("plan", self._plan_body(folded=True))
        assert result.exit_code == 0
        client.add_issue_comment.assert_called_once()

    def test_direct_plan_other_summary_rejected(self) -> None:
        """異常系: plan の <summary> が既定の形でなければ exit 3 で投稿されない"""
        message = self._plan_body(folded=True, filler=10).replace(
            PLAN_FOLD_SUMMARY, "<summary>理由</summary>", 1
        )
        result, client = self._invoke_direct("plan", message)
        assert result.exit_code == 3
        assert (
            f"エラー: 折りたたみの規則違反: <summary>理由</summary> は {PLAN_FOLD_SUMMARY} にしてください"
            in result.output
        )
        client.add_issue_comment.assert_not_called()

    def test_direct_merge_diff_long_body_not_limited(self) -> None:
        """merge-diff は折りたたみの規則の対象外"""
        message = f"""## Merge — 長い

### Variance — 確認済み

- **タスク** — 確認済み。{"あ" * 8500}

### Impact — 次

- **次** — 詳細は `.pecot/work/123/plan.md`
"""
        result, client = self._invoke_direct("merge-diff", message)
        assert result.exit_code == 0
        assert "折りたたみの規則違反" not in result.output
        client.add_issue_comment.assert_called_once()

    def test_file_plan_leading_guide_comment_headings_not_counted(self, tmp_path: Path) -> None:
        """正常系: --prepare 雛形の冒頭ガイドコメントにある見出し行は、余計な見出しとして数えない"""
        guide = "<!--\n書き方:\n### 例の見出し — コメントの中\n-->\n\n"
        comment_file = tmp_path / "plan.md"
        comment_file.write_text(
            '---\nissue_ref: "owner/repo/123"\ntemplate: plan\n---\n\n'
            + guide
            + self._plan_body(folded=False, filler=10),
            encoding="utf-8",
        )
        result, client = self._invoke_file(comment_file)
        assert result.exit_code == 0, result.output
        client.add_issue_comment.assert_called_once()

    def test_direct_plan_extra_heading_rejected(self) -> None:
        """異常系: テンプレに無い見出しの plan は exit 3 で、見出し名と Notes への案内を示し投稿されない"""
        message = self._plan_body(folded=False, filler=10).replace(
            "### Notes\n", "### 指示との差分\n\nあり。\n\n### Notes\n"
        )
        result, client = self._invoke_direct("plan", message)
        assert result.exit_code == 3
        assert "エラー: テンプレに無い見出し: ### 指示との差分" in result.output
        assert "### Notes に書いてください" in result.output
        client.add_issue_comment.assert_not_called()

    def test_direct_plan_legacy_headings_rejected(self) -> None:
        """異常系: 旧形式（Goal / Steps / Risks / Tests）の plan は不足とテンプレに無い見出しの両方で止まる"""
        legacy = """## Plan — 旧形式

### Goal — 到達点

到達点。

### Approach — 方針

- **方針**

### Steps — 手順

### Risks — なし

### Tests — 検証
"""
        result, client = self._invoke_direct("plan", legacy)
        assert result.exit_code == 3
        assert "エラー: 不足セクション:" in result.output
        assert "### Context" in result.output
        assert "エラー: テンプレに無い見出し: ### Goal, ### Steps, ### Risks, ### Tests" in (
            result.output
        )
        client.add_issue_comment.assert_not_called()

    def test_direct_plan_h4_heading_in_details_passes(self) -> None:
        """正常系: details の中の h4 小見出しは縛らない"""
        message = self._plan_body(folded=False, filler=10).replace(
            "- `templates/comment/plan.md` — 見出しを 8 つにする",
            "#### CUJ 1\n\n- `templates/comment/plan.md` — 見出しを 8 つにする",
        )
        result, client = self._invoke_direct("plan", message)
        assert result.exit_code == 0, result.output
        client.add_issue_comment.assert_called_once()

    def test_direct_merge_diff_extra_heading_not_closed(self) -> None:
        """merge-diff は見出しを閉じない（テンプレに無い見出しを足せる）"""
        message = """## Merge — 追加見出し

### Variance — 確認済み

- **タスク** — 確認済み。

### Impact — 次

- **次** — 詳細は `.pecot/work/123/plan.md`

### 補足 — 追加

- 補足。
"""
        result, client = self._invoke_direct("merge-diff", message)
        assert result.exit_code == 0, result.output
        assert "テンプレに無い見出し" not in result.output
        client.add_issue_comment.assert_called_once()

    def test_direct_plan_unclosed_details_rejected(self) -> None:
        """異常系: 未閉じ <details> の plan は折りたたみの規則違反で exit 3、投稿されない"""
        message = self._plan_body(folded=False, filler=10).replace(
            "plan テンプレを唯一の置き場にし、見出しを閉じた集合にする。",
            f"plan テンプレを唯一の置き場にし、見出しを閉じた集合にする。\n\n<details>\n{PLAN_FOLD_SUMMARY}",
            1,
        )
        result, client = self._invoke_direct("plan", message)
        assert result.exit_code == 3
        assert "エラー: 折りたたみの規則違反:" in result.output
        client.add_issue_comment.assert_not_called()

    def test_direct_merge_diff_legacy_japanese_headings_rejected(self) -> None:
        """異常系: 旧日本語見出しの merge-diff 本文は英語テンプレに対して不足扱いになる。

        テンプレ見出しを英語へ統一したため、旧見出しのまま投稿すると
        全セクションが missing になることを回帰固定する。
        """
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        legacy_message = """## 作業報告 — テスト

### 完了した作業 — テスト
- テスト。

### 現在の状態 — テスト
- テスト。

### 次にやること — テスト
- テスト。

### 注意事項・コンテキスト — テスト
- テスト。

#### 残タスク
- テスト。

#### 確認・検証すべきこと
- テスト。

#### 参照すべきファイル・ドキュメント
- テスト。

#### なぜこの実装にしたか
- テスト。

#### 調査で判明した重要な情報
- テスト。

#### 注意点・ハマりポイント
- テスト。
"""

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "--template",
                    "merge-diff",
                    "--message",
                    legacy_message,
                    "--issue",
                    "owner/repo/123",
                ],
            )
            assert result.exit_code == 3
            assert "不足セクション" in result.output
            assert "### Variance — <サマリ>" in result.output
            assert "### Impact — <サマリ>" in result.output

    def test_direct_help(self) -> None:
        """issue comment --help"""
        result = runner.invoke(app, ["issue", "comment", "--help"])
        assert result.exit_code == 0
        assert "message" in result.output.lower() or "コメント" in result.output


# --- issue read コマンドテスト ---


class TestIssueReadCommand:
    """issue read コマンドのテスト"""

    def test_read_basic(self) -> None:
        """正常系: 基本的なIssue読み取り"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "number": 435,
            "state": "OPEN",
            "title": "[Task] テストタスク",
            "body": "## タスク概要\n\n実装する。",
            "comments": {"total_count": 3, "nodes": []},
            "parent": None,
            "sub_issues": [],
            "linked_branches": [],
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "read", "owner/repo/435"])
            assert result.exit_code == 0
            assert "#435" in result.output
            assert "[Task] テストタスク" in result.output
            assert "OPEN" in result.output

    def test_read_with_parent(self) -> None:
        """正常系: 親Issue付きのIssue"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "number": 435,
            "state": "OPEN",
            "title": "[Task] サブタスク",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": {
                "number": 353,
                "title": "[Epic] 親エピック",
                "state": "OPEN",
                "owner": "owner",
                "repo": "repo",
            },
            "sub_issues": [],
            "linked_branches": [],
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "read", "owner/repo/435"])
            assert result.exit_code == 0
            assert "**Parent:** #353" in result.output
            assert "親エピック" in result.output

    def test_read_with_parent_cross_repo(self) -> None:
        """正常系: 親Issueがクロスリポの場合は owner/repo#N 形式で表示"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "number": 435,
            "state": "OPEN",
            "title": "[Task] サブタスク",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": {
                "number": 353,
                "title": "[Epic] 親エピック",
                "state": "OPEN",
                "owner": "other-owner",
                "repo": "other-repo",
            },
            "sub_issues": [],
            "linked_branches": [],
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "read", "owner/repo/435"])
            assert result.exit_code == 0
            assert "other-owner/other-repo#353" in result.output
            assert "**Parent:** #353" not in result.output

    def test_read_with_parent_repository_null(self) -> None:
        """正常系: parent.repository 欠損時は同リポ扱い（`**Parent:** #N ...`）にフォールバック"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "number": 435,
            "state": "OPEN",
            "title": "[Task] サブタスク",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": {
                "number": 353,
                "title": "[Epic] 親エピック",
                "state": "OPEN",
                "owner": None,
                "repo": None,
            },
            "sub_issues": [],
            "linked_branches": [],
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "read", "owner/repo/435"])
            assert result.exit_code == 0
            assert "**Parent:** #353 [Epic] 親エピック (OPEN)" in result.output
            assert "None/None" not in result.output
            assert "owner/repo#353" not in result.output

    def test_read_with_sub_issues(self) -> None:
        """正常系: サブIssue付きのIssue"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "number": 353,
            "state": "OPEN",
            "title": "[Epic] エピック",
            "body": "本文",
            "comments": {"total_count": 5, "nodes": []},
            "parent": None,
            "sub_issues": [
                {"number": 435, "state": "OPEN", "title": "[Task] タスク1"},
                {"number": 436, "state": "CLOSED", "title": "[Task] タスク2"},
            ],
            "linked_branches": [],
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "read", "owner/repo/353"])
            assert result.exit_code == 0
            assert "#435" in result.output
            assert "#436" in result.output
            assert "タスク1" in result.output
            assert "タスク2" in result.output

    def test_read_with_linked_branches(self) -> None:
        """正常系: リンクブランチ付きのIssue"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "number": 435,
            "state": "OPEN",
            "title": "[Task] タスク",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": None,
            "sub_issues": [],
            "linked_branches": ["feat/issue-435-task"],
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "read", "owner/repo/435"])
            assert result.exit_code == 0
            assert "feat/issue-435-task" in result.output

    def test_read_json_output(self) -> None:
        """正常系: JSON形式出力"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {
            "number": 435,
            "state": "OPEN",
            "title": "[Task] テストタスク",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": None,
            "sub_issues": [],
            "linked_branches": [],
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "read", "owner/repo/435", "--json"])
            assert result.exit_code == 0
            # JSON形式の出力を確認
            import json

            data = json.loads(result.output)
            assert data["number"] == 435
            assert data["state"] == "OPEN"

    def test_read_no_active_config(self) -> None:
        """異常系: アクティブ設定がない場合はエラー"""
        with patch("cli.commands.issue.load_active_config", return_value=None):
            result = runner.invoke(app, ["issue", "read", "owner/repo/435"])
            assert result.exit_code == 1
            assert "アクティブなプロジェクト" in result.output

    def test_read_invalid_issue_ref(self) -> None:
        """異常系: 不正なissue_ref形式はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "read", "invalid-format"])
            assert result.exit_code == 2
            assert "不正な参照形式" in result.output

    def test_read_issue_not_found(self) -> None:
        """異常系: Issueが見つからない場合"""
        from cli.core.github import GitHubNotFoundError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_issue_slim.side_effect = GitHubNotFoundError(
            "Issueが見つかりません: owner/repo/999"
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "read", "owner/repo/999"])
            assert result.exit_code == 1
            assert "見つかりません" in result.output

    def test_read_help(self) -> None:
        """issue read --help"""
        result = runner.invoke(app, ["issue", "read", "--help"])
        assert result.exit_code == 0
        assert "issue" in result.output.lower() or "read" in result.output.lower()


# --- _format_issue_markdown 関数テスト ---


class TestFormatIssueMarkdown:
    """_format_issue_markdown 関数のテスト"""

    def test_basic_issue(self) -> None:
        """基本的なIssue情報のフォーマット"""
        issue = {
            "number": 123,
            "title": "[Task] テスト機能の実装",
            "state": "OPEN",
            "body": "## タスク概要\n\n実装する。",
            "comments": {"total_count": 5, "nodes": []},
            "parent": None,
            "sub_issues": [],
            "linked_branches": [],
            "linked_prs": [],
        }
        result = _format_issue_markdown(issue)

        assert "## #123 [Task] テスト機能の実装" in result
        assert "**State:** OPEN" in result
        assert "**Comments:** 5" in result
        assert "## タスク概要" in result

    def test_with_linked_prs_merged(self) -> None:
        """リンクPR（MERGED）の表示"""
        issue = {
            "number": 460,
            "title": "[Task] リンクPR表示",
            "state": "OPEN",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": None,
            "sub_issues": [],
            "linked_branches": [],
            "linked_prs": [
                {"number": 455, "title": "feat: 新機能追加", "state": "MERGED"},
            ],
        }
        result = _format_issue_markdown(issue)

        assert "**Linked PRs:**" in result
        assert "[✓] #455 feat: 新機能追加 (MERGED)" in result

    def test_with_linked_prs_open(self) -> None:
        """リンクPR（OPEN）の表示"""
        issue = {
            "number": 460,
            "title": "[Task] リンクPR表示",
            "state": "OPEN",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": None,
            "sub_issues": [],
            "linked_branches": [],
            "linked_prs": [
                {"number": 456, "title": "fix: バグ修正", "state": "OPEN"},
            ],
        }
        result = _format_issue_markdown(issue)

        assert "**Linked PRs:**" in result
        assert "[○] #456 fix: バグ修正 (OPEN)" in result

    def test_with_multiple_linked_prs(self) -> None:
        """複数のリンクPR表示"""
        issue = {
            "number": 460,
            "title": "[Task] リンクPR表示",
            "state": "OPEN",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": None,
            "sub_issues": [],
            "linked_branches": [],
            "linked_prs": [
                {"number": 455, "title": "feat: 新機能追加", "state": "MERGED"},
                {"number": 456, "title": "fix: バグ修正", "state": "OPEN"},
                {"number": 457, "title": "docs: ドキュメント更新", "state": "CLOSED"},
            ],
        }
        result = _format_issue_markdown(issue)

        assert "**Linked PRs:**" in result
        # MERGEDは✓
        assert "[✓] #455 feat: 新機能追加 (MERGED)" in result
        # OPEN/CLOSEDは○
        assert "[○] #456 fix: バグ修正 (OPEN)" in result
        assert "[○] #457 docs: ドキュメント更新 (CLOSED)" in result

    def test_without_linked_prs(self) -> None:
        """リンクPRがない場合はセクションを表示しない"""
        issue = {
            "number": 123,
            "title": "[Task] テスト",
            "state": "OPEN",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": None,
            "sub_issues": [],
            "linked_branches": [],
            "linked_prs": [],
        }
        result = _format_issue_markdown(issue)

        assert "**Linked PRs:**" not in result

    def test_linked_prs_key_missing(self) -> None:
        """linked_prsキーがない場合もセクションを表示しない"""
        issue = {
            "number": 123,
            "title": "[Task] テスト",
            "state": "OPEN",
            "body": "本文",
            "comments": {"total_count": 0, "nodes": []},
            "parent": None,
            "sub_issues": [],
            "linked_branches": [],
            # linked_prs キーなし
        }
        result = _format_issue_markdown(issue)

        assert "**Linked PRs:**" not in result


# --- _issue_create_from_file のテンプレートバリデーションテスト ---


class TestIssueCreateFromFileValidation:
    """_issue_create_from_file のテンプレートバリデーションテスト"""

    def test_create_from_file_valid_task_template(self, tmp_path: Path) -> None:
        """正常系: taskテンプレートに準拠したファイルからIssue作成"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            "---\ntitle: テスト機能の実装\n"
            "type: task\nrepository: owner/repo\nstatus: ready\n---\n\n"
            """## Goal — 達成したい状態

実現したい状態。

## Acceptance — 達成判定

- **条件1** — 確認: pytest
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_ready"

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
        }
        mock_client.get_issue_node_id.return_value = "I_abc123"
        mock_client.add_to_project.return_value = "PVTI_789"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0
            assert "https://ghes.example.com/owner/repo/issues/456" in result.output

    def test_create_from_file_missing_required_section(self, tmp_path: Path) -> None:
        """異常系: 必須セクション不足でエラー"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            """---
title: テスト機能の実装
type: task
repository: owner/repo
status: ready
---

## Goal — 達成したい状態

実現したい状態
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient") as mock_gh_class,
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 1
            assert "エラー: 不足セクション:" in result.output
            # GitHubClientが呼ばれていないことを確認（バリデーションで早期終了）
            mock_gh_class.assert_not_called()

    def test_create_from_file_valid_bug_template(self, tmp_path: Path) -> None:
        """正常系: bugテンプレートに準拠したファイルからIssue作成"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            """---
title: バグ修正
type: bug
repository: owner/repo
status: ready
---

## Problem — バグ概要

コマンド実行で異常終了する。環境は linux。

| Expected | Actual |
|---|---|
| 正常動作 | 異常動作 |

### Repro

1. ステップ1。

## Acceptance — 修復された状態

- **条件1** — 確認: pytest
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_ready"

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 457,
            "html_url": "https://ghes.example.com/owner/repo/issues/457",
        }
        mock_client.get_issue_node_id.return_value = "I_abc124"
        mock_client.add_to_project.return_value = "PVTI_790"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0
            assert "https://ghes.example.com/owner/repo/issues/457" in result.output

    def test_create_from_file_valid_epic_template(self, tmp_path: Path) -> None:
        """正常系: epicテンプレートに準拠したファイルからIssue作成"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            "---\ntitle: Epic実装\n"
            "type: epic\nrepository: owner/repo\nstatus: backlog\n---\n\n"
            """## AS-IS — 現状

現状の事実。

## TO-BE — 完了時の状態

完了時にどうなっているか。

## GAP — 埋めるべき差分

AS-IS と TO-BE の差。
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_backlog"

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 458,
            "html_url": "https://ghes.example.com/owner/repo/issues/458",
        }
        mock_client.get_issue_node_id.return_value = "I_abc125"
        mock_client.add_to_project.return_value = "PVTI_791"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0
            assert "https://ghes.example.com/owner/repo/issues/458" in result.output

        # epic の既定 status (backlog) で workflow option を引き当てて field 更新する
        mock_config.get_option_id.assert_any_call("workflow", "backlog")
        assert any(
            call.args[3] == "opt_backlog"
            for call in mock_client.update_project_item_field.call_args_list
        ), "status=backlog の option_id (opt_backlog) で update_project_item_field が呼ばれていない"


# --- _validate_issue_template 共通関数のテスト ---


class TestValidateIssueTemplate:
    """_validate_issue_template 共通関数のテスト"""

    def test_valid_template(self, tmp_path: Path) -> None:
        """正常系: 有効なテンプレート"""
        # taskテンプレートに準拠した本文 (Goal-Acceptance)
        body = """## Goal — 達成したい状態

実現したい状態

## Acceptance — 達成判定

- **条件1** — 確認: pytest
"""
        # 例外が発生しないことを確認
        _validate_issue_template("task", body)

    def test_missing_sections(self, tmp_path: Path) -> None:
        """異常系: 必須セクション不足"""
        body = """## タスク概要

テスト本文
"""
        with pytest.raises(typer.Exit) as exc_info:
            _validate_issue_template("task", body)
        assert exc_info.value.exit_code == 1

    def test_empty_required_sections(self, tmp_path: Path) -> None:
        """正常系: required_sectionsが空の場合はバリデーションをスキップ"""
        # テンプレートファイルが存在しない場合を想定
        body = "任意の本文"
        # テンプレートが存在しない場合、バリデーションはスキップされる
        # 例外が発生しないことを確認
        with patch("cli.commands.issue.extract_sections_from_template", return_value=[]):
            _validate_issue_template("task", body)

    def test_valid_task_implement_template(self) -> None:
        """正常系: task-implementテンプレートに準拠した本文"""
        body = """## Goal

フェーズ1の実装。

## Tasks

- T001 説明（cli/commands/issue.py）。

## Acceptance

- Checkpoint: フェーズ1が単独で動く。

## Artifacts

`.specify/feature/`
"""
        _validate_issue_template("task-implement", body)

    def test_task_implement_missing_sections(self) -> None:
        """異常系: task-implementテンプレートの必須セクション不足"""
        body = """## Overview

テスト本文
"""
        with pytest.raises(typer.Exit) as exc_info:
            _validate_issue_template("task-implement", body)
        assert exc_info.value.exit_code == 1

    def test_task_missing_em_dash_summary(self) -> None:
        """異常系: em-dash サマリ欠落（## Goal のみ）は不足扱い"""
        body = """## Goal

実現したい状態

## Acceptance — 達成判定

- **条件1** — 確認: pytest
"""
        with pytest.raises(typer.Exit) as exc_info:
            _validate_issue_template("task", body)
        assert exc_info.value.exit_code == 1

    def test_task_unedited_placeholder_in_heading(self) -> None:
        """異常系: 見出しに <placeholder> が残っているケースは不足扱い"""
        body = """## Goal — <達成したい状態を1行で>

実現したい状態

## Acceptance — 達成判定

- **条件1** — 確認: pytest
"""
        with pytest.raises(typer.Exit) as exc_info:
            _validate_issue_template("task", body)
        assert exc_info.value.exit_code == 1

    def test_task_summary_exactly_50_chars_passes(self) -> None:
        """正常系: em-dash サマリが50文字ちょうどなら通過する"""
        summary = "あ" * 50
        body = f"""## Goal — {summary}

実現したい状態

## Acceptance — 達成判定

- **条件1** — 確認: pytest
"""
        # 例外が発生しないことを確認
        _validate_issue_template("task", body)

    def test_task_summary_51_chars_fails(self) -> None:
        """異常系: em-dash サマリが51文字だと不足扱いになる"""
        summary = "あ" * 51
        body = f"""## Goal — {summary}

実現したい状態

## Acceptance — 達成判定

- **条件1** — 確認: pytest
"""
        with pytest.raises(typer.Exit) as exc_info:
            _validate_issue_template("task", body)
        assert exc_info.value.exit_code == 1


# --- issue quick コマンドテスト ---


class TestIssueQuickCommandErrors:
    """issue quick コマンドのエラーケーステスト"""

    @pytest.fixture(autouse=True)
    def _mock_state_flags(self) -> None:
        """write_flag/touch_flagをモックし、テストが実stateディレクトリに書き込むのを防止"""
        with (
            patch("cli.core.state.write_flag"),
            patch("cli.core.state.touch_flag"),
        ):
            yield

    def test_quick_empty_message_error(self) -> None:
        """メッセージが空の場合はエラー"""
        mock_config = MagicMock()

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "quick", "-r", "owner/repo", "-m", ""])
            assert result.exit_code == 1
            assert "メッセージが空です" in result.output

    def test_quick_whitespace_only_message_error(self) -> None:
        """メッセージが空白のみの場合はエラー"""
        mock_config = MagicMock()

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "quick", "-r", "owner/repo", "-m", "   "])
            assert result.exit_code == 1
            assert "メッセージが空です" in result.output

    def test_quick_invalid_repository_format(self) -> None:
        """リポジトリ形式が不正（owner/repo以外）"""
        mock_config = MagicMock()

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            # owner/repoではなくowner形式
            result = runner.invoke(app, ["issue", "quick", "-r", "invalid", "-m", "test"])
            assert result.exit_code == 1
            assert "不正なリポジトリ形式" in result.output

    def test_quick_invalid_repository_format_three_parts(self) -> None:
        """リポジトリ形式が不正（owner/repo/extra）"""
        mock_config = MagicMock()

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "quick", "-r", "owner/repo/extra", "-m", "test"])
            assert result.exit_code == 1
            assert "不正なリポジトリ形式" in result.output

    def test_quick_no_project_config(self) -> None:
        """プロジェクト設定がない場合"""
        with patch("cli.commands.issue.load_active_config", return_value=None):
            result = runner.invoke(app, ["issue", "quick", "-r", "owner/repo", "-m", "test"])
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output

    def test_quick_repo_not_in_project(self) -> None:
        """リポジトリがプロジェクトに含まれていない場合"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = False

        mock_client = MagicMock()

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "quick", "-r", "owner/repo", "-m", "test"])
            assert result.exit_code == 1
            assert "プロジェクトに紐づいていません" in result.output

    def test_quick_issue_creation_failure(self) -> None:
        """Issue作成失敗時のエラーハンドリング"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.create_issue.side_effect = GitHubAPIError(
            "API error", 500, "Internal Server Error"
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "quick", "-r", "owner/repo", "-m", "test"])
            assert result.exit_code == 1
            assert "Issue作成失敗" in result.output

    def test_quick_board_addition_failure(self) -> None:
        """ボード追加失敗時の警告表示"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "I_test123",
        }
        mock_client.add_to_project.side_effect = GitHubAPIError(
            "Board addition failed", 500, "Error"
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "quick", "-r", "owner/repo", "-m", "test"])
            assert result.exit_code == 0  # 警告だが成功扱い
            assert "ボード追加失敗" in result.output
            assert "https://ghes.example.com/owner/repo/issues/123" in result.output

    def test_quick_with_parent_epic_option(self) -> None:
        """--parent-epic オプション指定時（aggregation_repo 未設定 → task repo にフォールバック）"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.aggregation_repo_ref = None
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_active"

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "I_test123",
        }
        mock_client.add_to_project.return_value = "PVTI_456"
        mock_client.get_issue_node_id.return_value = "I_parent353"
        # _check_duplicate_order が呼ばれないようにするため order は未指定

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            # --no-branch を指定してブランチ作成をスキップ（テストを簡略化）
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "-m",
                    "test",
                    "--parent-epic",
                    "353",
                    "--no-branch",
                ],
            )
            assert result.exit_code == 0
            assert "Linking to parent epic owner/repo/353" in result.output
            assert "Linked to owner/repo/353" in result.output

            # Epic紐づけAPI呼び出し確認（task repo にフォールバック）
            mock_client.get_issue_node_id.assert_any_call("owner", "repo", 353)
            mock_client.add_sub_issue.assert_called_once_with("I_parent353", "I_test123")

    def test_quick_epic_link_failure(self) -> None:
        """親Epic紐づけ失敗時は URL 先出し→エラー→exit 1 で停止"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.aggregation_repo_ref = None
        mock_config.get_field_id.return_value = None  # フィールド設定なし

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "I_test123",
        }
        mock_client.add_to_project.return_value = "PVTI_456"
        mock_client.add_sub_issue.side_effect = GitHubAPIError("Link failed", 500, "Error")

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "-m",
                    "test",
                    "--parent-epic",
                    "353",
                    "--no-branch",
                ],
            )
            assert result.exit_code == 1
            # URL を先に stdout へ出している
            assert "https://ghes.example.com/owner/repo/issues/123" in result.output
            assert "サブIssue紐づけ失敗" in result.output

    def test_quick_with_no_branch_option(self) -> None:
        """--no-branch オプション時はブランチ作成しない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None  # フィールド設定なし

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "I_test123",
        }
        mock_client.add_to_project.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("subprocess.run") as mock_run,
        ):
            # subprocess.runの戻り値を正しく設定（get_git_root()で使用される）
            mock_result = MagicMock()
            mock_result.stdout = "/tmp/mock-repo\n"
            mock_result.returncode = 0
            mock_run.return_value = mock_result
            result = runner.invoke(
                app, ["issue", "quick", "-r", "owner/repo", "-m", "test", "--no-branch"]
            )
            assert result.exit_code == 0
            # ブランチ作成がスキップされたので、git fetch と git checkout を呼ばない。
            # git rev-parse (get_git_root) だけは .pecot-active 書き込み時に呼ぶ。
            fetch_calls = [c for c in mock_run.call_args_list if c[0][0][:2] == ["git", "fetch"]]
            checkout_calls = [
                c for c in mock_run.call_args_list if c[0][0][:2] == ["git", "checkout"]
            ]
            assert len(fetch_calls) == 0
            assert len(checkout_calls) == 0

    def test_quick_title_truncation(self) -> None:
        """タイトルが50文字で切り詰められることを確認"""
        long_message = "a" * 100  # 100文字のメッセージ

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "I_test123",
        }
        mock_client.add_to_project.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app, ["issue", "quick", "-r", "owner/repo", "-m", long_message, "--no-branch"]
            )
            assert result.exit_code == 0

            # create_issueの呼び出し引数を確認
            mock_client.create_issue.assert_called_once()
            call_kwargs = mock_client.create_issue.call_args.kwargs
            title = call_kwargs["title"]

            # タイトルは "[Task] " + 50文字 = 最大57文字
            assert title.startswith("[Task] ")
            assert len(title) <= 57
            # 本文から取った50文字部分を確認
            title_body = title[7:]  # "[Task] "を除く
            assert len(title_body) <= 50

    def test_quick_title_whitespace_normalization(self) -> None:
        """タイトル内の空白が正規化されることを確認"""
        message = "test\n\nmessage  with   spaces"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "I_test123",
        }
        mock_client.add_to_project.return_value = "PVTI_456"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app, ["issue", "quick", "-r", "owner/repo", "-m", message, "--no-branch"]
            )
            assert result.exit_code == 0

            # create_issueの呼び出し引数を確認
            mock_client.create_issue.assert_called_once()
            call_kwargs = mock_client.create_issue.call_args.kwargs
            title = call_kwargs["title"]

            # 空白が単一スペースに正規化されている
            assert title == "[Task] test message with spaces"

    def test_quick_no_develop_branch_raises_error(self) -> None:
        """develop_branchが未設定の場合はエラーを発生（ブランチ作成時）"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.project.id = "PVT_test123"
        mock_repo = MagicMock()
        mock_repo.develop_branch = None
        mock_config.find_repository.return_value = mock_repo

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "I_kwDOtest123",
        }
        mock_client.add_to_project.return_value = "item123"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "quick", "-r", "owner/repo", "-m", "test"])
            assert result.exit_code == 1
            assert "develop_branch が設定されていません" in result.output


# --- issue comment コマンドテスト ---


class TestIssueCommentDirect:
    """issue comment -m のテスト"""

    def test_comment_direct_missing_message(self) -> None:
        """-m未指定（引数なし）でエラー"""
        result = runner.invoke(app, ["issue", "comment"])
        assert result.exit_code == 1
        assert "引数が不足しています" in result.output

    def test_comment_direct_missing_issue_ref(self) -> None:
        """--issue未指定でエラー"""
        mock_config = MagicMock()

        with patch("cli.commands.issue.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["issue", "comment", "-t", "merge-diff", "-m", "test"])
            assert result.exit_code == 1
            assert "--issue" in result.output
            assert "必須です" in result.output

    def test_comment_direct_no_active_config(self) -> None:
        """アクティブ設定がない場合はエラー"""
        with patch("cli.commands.issue.load_active_config", return_value=None):
            result = runner.invoke(
                app,
                ["issue", "comment", "-t", "merge-diff", "-m", "test", "--issue", "owner/repo/123"],
            )
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output


# --- issue quick コマンド拡張機能のテスト ---


class TestIssueQuickEnhancements:
    """issue quick コマンドの拡張機能（--type, --no-branch時の.pecot-active書き込み）のテスト"""

    @pytest.fixture(autouse=True)
    def _mock_state_flags(self) -> None:
        """write_flag/touch_flagをモックし、テストが実stateディレクトリに書き込むのを防止"""
        with (
            patch("cli.core.state.write_flag"),
            patch("cli.core.state.touch_flag"),
        ):
            yield

    def test_issue_quick_default_type_is_task(self) -> None:
        """--type 省略時はデフォルトで task になる"""
        from unittest.mock import MagicMock, patch

        # GitHubClient のモック
        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "MDU6SXNzdWUxMjM=",
        }
        mock_client.get_issue_node_id.return_value = "MDU6SXNzdWUxMjM="
        mock_client.add_to_project.return_value = "item123"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        # workflow/priority/size を解決できるようにし、Set fields の表示形式を検証する。
        mock_config.get_field_id.side_effect = lambda field: {
            "workflow": "field_workflow",
            "priority": "field_priority",
            "size": "field_size",
        }.get(field)
        mock_config.get_option_id.side_effect = lambda field, value: {
            ("workflow", "active"): "option_active",
            ("priority", "medium"): "option_medium",
            ("size", "s"): "option_s",
        }.get((field, value))

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                ["issue", "quick", "-r", "owner/repo", "-m", "テストメッセージ", "--no-branch"],
            )

            # 成功確認
            assert result.exit_code == 0

            # create_issue が正しい引数で呼ばれたことを確認
            mock_client.create_issue.assert_called_once()
            call_args = mock_client.create_issue.call_args[1]
            assert call_args["title"] == "[Task] テストメッセージ"

            # quick（task 既定）の Set fields 表示形式が enum 値（active/medium/s）
            # で出力されること（#670、direct/file と 3 方式で一致）。
            assert "Set fields: status: active, priority: medium, size: s" in result.output

    def test_issue_quick_body_preserves_message_and_appends_footer(self) -> None:
        """body はフリーフォーマット本文を保持し、末尾に規約参照フッターを付加する（#682）"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 200,
            "html_url": "https://ghes.example.com/owner/repo/issues/200",
            "node_id": "MDU6SXNzdWUyMDA=",
        }
        mock_client.get_issue_node_id.return_value = "MDU6SXNzdWUyMDA="
        mock_client.add_to_project.return_value = "item200"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                ["issue", "quick", "-r", "owner/repo", "-m", "テストメッセージ本文", "--no-branch"],
            )

            assert result.exit_code == 0

            from cli.commands.issue import _QUICK_BODY_FOOTER

            body = mock_client.create_issue.call_args[1]["body"]
            assert body == "テストメッセージ本文" + "\n\n" + _QUICK_BODY_FOOTER

    def test_issue_quick_body_footer_rstrip_boundary(self) -> None:
        """末尾改行付き message でも rstrip + 空行区切りで body が組み立てられる（#682）"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 201,
            "html_url": "https://ghes.example.com/owner/repo/issues/201",
            "node_id": "MDU6SXNzdWUyMDE=",
        }
        mock_client.get_issue_node_id.return_value = "MDU6SXNzdWUyMDE="
        mock_client.add_to_project.return_value = "item201"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                ["issue", "quick", "-r", "owner/repo", "-m", "テスト\n\n", "--no-branch"],
            )

            assert result.exit_code == 0

            from cli.commands.issue import _QUICK_BODY_FOOTER

            body = mock_client.create_issue.call_args[1]["body"]
            # 末尾改行は rstrip され、本文とフッターの間は空行 1 つだけになる
            assert body == "テスト" + "\n\n" + _QUICK_BODY_FOOTER

    def test_issue_quick_epic_body_appends_footer(self) -> None:
        """--type epic でも body 末尾に規約参照フッターが付く（分岐なし、#682）"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 202,
            "html_url": "https://ghes.example.com/owner/repo/issues/202",
            "node_id": "MDU6SXNzdWUyMDI=",
        }
        mock_client.get_issue_node_id.return_value = "MDU6SXNzdWUyMDI="
        mock_client.add_to_project.return_value = "item202"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "--type",
                    "epic",
                    "-m",
                    "新機能実装",
                    "--no-branch",
                ],
            )

            assert result.exit_code == 0

            from cli.commands.issue import _QUICK_BODY_FOOTER

            body = mock_client.create_issue.call_args[1]["body"]
            assert body == "新機能実装" + "\n\n" + _QUICK_BODY_FOOTER

    def test_issue_quick_with_type_bug(self) -> None:
        """--type bug でバグIssueを作成"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 124,
            "html_url": "https://ghes.example.com/owner/repo/issues/124",
            "node_id": "MDU6SXNzdWUxMjQ=",
        }
        mock_client.add_to_project.return_value = "item124"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "--type",
                    "bug",
                    "-m",
                    "バグ報告",
                    "--no-branch",
                ],
            )

            assert result.exit_code == 0
            call_args = mock_client.create_issue.call_args[1]
            assert call_args["title"] == "[Bug] バグ報告"

    def test_issue_quick_with_type_epic_status_backlog(self) -> None:
        """--type epic でEpicを作成、ステータスは backlog"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 125,
            "html_url": "https://ghes.example.com/owner/repo/issues/125",
            "node_id": "MDU6SXNzdWUxMjU=",
        }
        mock_client.add_to_project.return_value = "item125"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        # workflow フィールドの設定
        mock_config.get_field_id.side_effect = lambda field: {
            "workflow": "field_workflow",
            "priority": "field_priority",
            "size": "field_size",
        }.get(field)
        mock_config.get_option_id.side_effect = lambda field, value: {
            ("workflow", "backlog"): "option_backlog",
            ("workflow", "active"): "option_active",
            ("priority", "medium"): "option_medium",
            ("size", "s"): "option_s",
        }.get((field, value))

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "--type",
                    "epic",
                    "-m",
                    "新機能実装",
                    "--no-branch",
                ],
            )

            assert result.exit_code == 0

            # タイトル確認
            call_args = mock_client.create_issue.call_args[1]
            assert call_args["title"] == "[Epic] 新機能実装"

            # ステータスが backlog に設定されたことを確認
            update_calls = mock_client.update_project_item_field.call_args_list
            # 最初の呼び出しがステータス設定
            status_call = update_calls[0]
            assert status_call[0][0] == "PVT_123"  # project_id
            assert status_call[0][1] == "item125"  # item_id
            assert status_call[0][2] == "field_workflow"  # field_id
            assert status_call[0][3] == "option_backlog"  # option_id

    def test_issue_quick_with_type_tracker_backlog_without_size(self) -> None:
        """--type tracker は backlog で起票し、size を設定しない"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 126,
            "html_url": "https://ghes.example.com/owner/repo/issues/126",
            "node_id": "MDU6SXNzdWUxMjY=",
        }
        mock_client.add_to_project.return_value = "item126"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.side_effect = lambda field: {
            "workflow": "field_workflow",
            "priority": "field_priority",
            "size": "field_size",
        }.get(field)
        mock_config.get_option_id.side_effect = lambda field, value: {
            ("workflow", "backlog"): "option_backlog",
            ("workflow", "active"): "option_active",
            ("priority", "medium"): "option_medium",
            ("size", "s"): "option_s",
        }.get((field, value))

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "--type",
                    "tracker",
                    "-m",
                    "束ねる対象",
                    "--no-branch",
                ],
            )

        assert result.exit_code == 0
        assert mock_client.create_issue.call_args[1]["title"] == "[Tracker] 束ねる対象"
        assert "Set fields: status: backlog, priority: medium" in result.output
        assert "size" not in result.output.split("Set fields:", 1)[1].splitlines()[0]
        field_ids = [c[0][2] for c in mock_client.update_project_item_field.call_args_list]
        assert "field_size" not in field_ids

    def test_issue_quick_no_branch_writes_pecot_active(self) -> None:
        """--no-branch でも .pecot-active に書き込む"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 126,
            "html_url": "https://ghes.example.com/owner/repo/issues/126",
            "node_id": "MDU6SXNzdWUxMjY=",
        }
        mock_client.add_to_project.return_value = "item126"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None

        # write_flag のモック（インポート先でパッチ）
        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.core.state.write_flag") as mock_write,
        ):
            result = runner.invoke(
                app,
                ["issue", "quick", "-r", "owner/repo", "-m", "テスト", "--no-branch"],
            )

            assert result.exit_code == 0

            # .pecot-active とセッション名（モックの Issue にタイトルが無いので番号だけ）を書く
            from cli.core.state import FLAG_PECOT_ACTIVE, FLAG_PECOT_SESSION_TITLE

            mock_write.assert_any_call(FLAG_PECOT_ACTIVE, "owner/repo/126")
            mock_write.assert_any_call(FLAG_PECOT_SESSION_TITLE, "#126")

    def test_issue_quick_epic_skips_size_field(self) -> None:
        """Epic の場合は size フィールドを設定しない"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 127,
            "html_url": "https://ghes.example.com/owner/repo/issues/127",
            "node_id": "MDU6SXNzdWUxMjc=",
        }
        mock_client.add_to_project.return_value = "item127"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        # フィールド設定
        mock_config.get_field_id.side_effect = lambda field: {
            "workflow": "field_workflow",
            "priority": "field_priority",
            "size": "field_size",
        }.get(field)
        mock_config.get_option_id.side_effect = lambda field, value: {
            ("workflow", "backlog"): "option_backlog",
            ("workflow", "active"): "option_active",
            ("priority", "medium"): "option_medium",
            ("size", "s"): "option_s",
        }.get((field, value))

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "--type",
                    "epic",
                    "-m",
                    "Epic",
                    "--no-branch",
                ],
            )

            assert result.exit_code == 0

            # update_project_item_field の呼び出しを確認
            update_calls = mock_client.update_project_item_field.call_args_list

            # size フィールドに対する呼び出しがないことを確認
            size_calls = [c for c in update_calls if c[0][2] == "field_size"]
            assert len(size_calls) == 0

    def test_issue_quick_epic_with_parent_shows_warning(self) -> None:
        """Epic に親Epic を指定すると警告が表示される"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 128,
            "html_url": "https://ghes.example.com/owner/repo/issues/128",
            "node_id": "MDU6SXNzdWUxMjg=",
        }
        mock_client.add_to_project.return_value = "item128"
        mock_client.get_issue_node_id.return_value = "MDU6SXNzdWUxMDA="

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.aggregation_repo_ref = None
        mock_config.get_field_id.return_value = None

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "--type",
                    "epic",
                    "-m",
                    "サブEpic",
                    "--parent-epic",
                    "100",
                    "--no-branch",
                ],
            )

            assert result.exit_code == 0

            # 警告メッセージが出力されたことを確認
            assert "警告: Epicに親Epicを指定することは推奨されません" in result.output

    def test_issue_quick_touches_quick_mode_flag(self) -> None:
        """taskタイプでクイックモードフラグが作成される"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 130,
            "html_url": "https://ghes.example.com/owner/repo/issues/130",
            "node_id": "MDU6SXNzdWUxMzA=",
        }
        mock_client.add_to_project.return_value = "item130"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.core.state.touch_flag") as mock_touch,
        ):
            result = runner.invoke(
                app,
                ["issue", "quick", "-r", "owner/repo", "-m", "テスト", "--no-branch"],
            )

            assert result.exit_code == 0

            from cli.core.state import FLAG_PECOT_QUICK_MODE

            mock_touch.assert_called_once_with(FLAG_PECOT_QUICK_MODE)

    def test_issue_quick_epic_skips_quick_mode_flag(self) -> None:
        """epicタイプではクイックモードフラグが作成されない"""
        from unittest.mock import MagicMock, patch

        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 131,
            "html_url": "https://ghes.example.com/owner/repo/issues/131",
            "node_id": "MDU6SXNzdWUxMzE=",
        }
        mock_client.add_to_project.return_value = "item131"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.core.state.touch_flag") as mock_touch,
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "--type",
                    "epic",
                    "-m",
                    "Epicテスト",
                    "--no-branch",
                ],
            )

            assert result.exit_code == 0
            mock_touch.assert_not_called()


# --- parent_epic クロスリポ対応の統合テスト（Bug #69） ---


class TestParentEpicCrossRepo:
    """Bug #69: parent_epic のクロスリポ対応と aggregation_repo 基準解決"""

    def _make_config(self, aggregation: str | None = "roadmap_owner/roadmap") -> MagicMock:
        from cli.core.repo_resolver import RepoRef

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = None
        mock_config.get_option_id.return_value = None
        if aggregation is None:
            mock_config.aggregation_repo_ref = None
            mock_config.aggregation_repo = None
        else:
            owner, repo = aggregation.split("/")
            mock_config.aggregation_repo_ref = RepoRef(owner=owner, repo=repo)
            mock_config.aggregation_repo = aggregation
        return mock_config

    def test_from_file_cross_repo_owner_repo_n_string(self, tmp_path: Path) -> None:
        """frontmatter parent_epic に owner/repo/N 形式でクロスリポ親リンク"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            "---\ntitle: クロスリポ親テスト\n"
            'type: task\nrepository: task_owner/task_repo\nstatus: ready\nparent_epic: "roadmap_owner/roadmap/21"\norder: 1\n---\n\n'
            f"{MINIMAL_TASK_BODY}",
            encoding="utf-8",
        )

        mock_config = self._make_config()
        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 500,
            "html_url": "https://ghes.example.com/task_owner/task_repo/issues/500",
        }
        mock_client.get_issue_slim.return_value = {"sub_issues": []}
        mock_client.get_issue_node_id.side_effect = lambda o, r, n: f"I_{o}_{r}_{n}"
        mock_client.add_to_project.return_value = "PVTI_999"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0

            # 親 Epic 解決は roadmap_owner/roadmap/21 で行われる
            mock_client.get_issue_node_id.assert_any_call("roadmap_owner", "roadmap", 21)
            # add_sub_issue は parent=roadmap のノードID、child=新規Issueノード
            mock_client.add_sub_issue.assert_called_once()
            call_args = mock_client.add_sub_issue.call_args
            assert call_args.args[0] == "I_roadmap_owner_roadmap_21"
            # _check_duplicate_order も親 Epic repo に対して呼ばれる
            mock_client.get_issue_slim.assert_called_once()
            slim_call = mock_client.get_issue_slim.call_args
            assert slim_call.args[0] == "roadmap_owner"
            assert slim_call.args[1] == "roadmap"
            assert slim_call.args[2] == 21

    def test_from_file_int_resolves_to_aggregation_repo(self, tmp_path: Path) -> None:
        """frontmatter の整数 parent_epic は aggregation_repo 基準で解決される"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            "---\ntitle: 整数 parent_epic テスト\n"
            "type: task\nrepository: task_owner/task_repo\nstatus: ready\nparent_epic: 21\norder: 1\n---\n\n"
            f"{MINIMAL_TASK_BODY}",
            encoding="utf-8",
        )

        mock_config = self._make_config()
        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 501,
            "html_url": "https://ghes.example.com/task_owner/task_repo/issues/501",
        }
        mock_client.get_issue_slim.return_value = {"sub_issues": []}
        mock_client.get_issue_node_id.side_effect = lambda o, r, n: f"I_{o}_{r}_{n}"
        mock_client.add_to_project.return_value = "PVTI_999"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0
            # stderr に note
            assert "note:" in result.output
            assert "aggregation_repo" in result.output

            # aggregation_repo (roadmap_owner/roadmap) #21 として解決されている
            mock_client.get_issue_node_id.assert_any_call("roadmap_owner", "roadmap", 21)
            # _check_duplicate_order も親 Epic repo (aggregation_repo) に対して呼ばれる
            slim_call = mock_client.get_issue_slim.call_args
            assert slim_call.args[0] == "roadmap_owner"
            assert slim_call.args[1] == "roadmap"

    def test_quick_cross_repo_parent_epic_option(self) -> None:
        """quick CLI --parent-epic owner/repo/N 形式でクロスリポ親リンク"""
        mock_config = self._make_config()
        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 600,
            "html_url": "https://ghes.example.com/task_owner/task_repo/issues/600",
            "node_id": "I_new600",
        }
        mock_client.get_issue_node_id.side_effect = lambda o, r, n: f"I_{o}_{r}_{n}"
        mock_client.add_to_project.return_value = "PVTI_abc"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "task_owner/task_repo",
                    "-m",
                    "quick cross-repo test",
                    "--parent-epic",
                    "roadmap_owner/roadmap/21",
                    "--no-branch",
                ],
            )
            assert result.exit_code == 0
            # 親 Epic 解決は owner/repo/N で指定されたリポに対して
            mock_client.get_issue_node_id.assert_any_call("roadmap_owner", "roadmap", 21)
            mock_client.add_sub_issue.assert_called_once()

    def test_link_failure_exits_with_url_first(self, tmp_path: Path) -> None:
        """get_issue_node_id が GitHubAPIError を投げる → URL 先出し + exit 1"""
        from cli.core.github import GitHubAPIError

        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            "---\ntitle: リンク失敗テスト\n"
            'type: task\nrepository: task_owner/task_repo\nstatus: ready\nparent_epic: "roadmap_owner/roadmap/21"\norder: 1\n---\n\n'
            f"{MINIMAL_TASK_BODY}",
            encoding="utf-8",
        )

        mock_config = self._make_config()
        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 700,
            "html_url": "https://ghes.example.com/task_owner/task_repo/issues/700",
        }
        mock_client.get_issue_slim.return_value = {"sub_issues": []}

        # 新規 Issue ノード取得は成功、親 Epic のノード取得は失敗
        def node_id_side_effect(o: str, r: str, n: int) -> str:
            if (o, r, n) == ("roadmap_owner", "roadmap", 21):
                raise GitHubAPIError("Epic not found", 404)
            return f"I_{o}_{r}_{n}"

        mock_client.get_issue_node_id.side_effect = node_id_side_effect
        mock_client.add_to_project.return_value = "PVTI_999"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 1
            # URL が先に出る（手動修復のため）
            url_idx = result.output.find("https://ghes.example.com/task_owner/task_repo/issues/700")
            err_idx = result.output.find("サブIssue紐づけ失敗")
            assert url_idx >= 0
            assert err_idx >= 0
            assert url_idx < err_idx

    def test_check_duplicate_order_targets_parent_epic_repo(self, tmp_path: Path) -> None:
        """回帰: _check_duplicate_order は親 Epic repo に対して呼ばれる（task repo ではない）"""
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            "---\ntitle: duplicate order 回帰テスト\n"
            'type: task\nrepository: task_owner/task_repo\nstatus: ready\nparent_epic: "roadmap_owner/roadmap/21"\norder: 5\n---\n\n'
            f"{MINIMAL_TASK_BODY}",
            encoding="utf-8",
        )

        mock_config = self._make_config()
        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 800,
            "html_url": "https://ghes.example.com/task_owner/task_repo/issues/800",
        }
        mock_client.get_issue_slim.return_value = {"sub_issues": []}
        mock_client.get_issue_node_id.side_effect = lambda o, r, n: f"I_{o}_{r}_{n}"
        mock_client.add_to_project.return_value = "PVTI_999"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0

            # 親 Epic repo (roadmap_owner/roadmap) に対して呼ばれたことを確認
            mock_client.get_issue_slim.assert_called_once()
            slim_call = mock_client.get_issue_slim.call_args
            assert slim_call.args[0] == "roadmap_owner"
            assert slim_call.args[1] == "roadmap"
            assert slim_call.args[2] == 21


# --- status × type 整合性検証テスト（#669） ---


class TestIssueCreateStatusValidation:
    """起票時の status が型対応テンプレート既定値と整合するか検証する（#669）。

    direct（``-m``）と file の両方で、別テンプレートの配置値
    （例: ``--type bug --status backlog``）と enum 外の値を拒否する。
    status 未指定時は型既定値（task/bug → ready、epic → backlog）を充填する。
    """

    def _make_config(self, aggregation: str | None = None) -> MagicMock:
        """workflow フィールドが解決できる config モックを返す。

        ``get_option_id("workflow", <status>)`` は status ごとに別 option_id を返す。
        そのため、既定値充填後にどの status で update が呼ばれたか検証できる。
        """
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True

        def get_field_id(name: str) -> str | None:
            return {"workflow": "PVTF_workflow"}.get(name)

        def get_option_id(field: str, value: str) -> str | None:
            if field != "workflow":
                return None
            # 本番の get_option_id は options dict を文字列キーで引く。
            # WorkflowStatus 等は (str, Enum) なので enum を渡しても文字列値で
            # 一致するため、文字列キーの dict 引きで本番挙動を忠実に再現する。
            return {
                "ready": "opt_ready",
                "backlog": "opt_backlog",
                "active": "opt_active",
                "pending": "opt_pending",
                "in_review": "opt_in_review",
                "archived": "opt_archived",
            }.get(value)

        mock_config.get_field_id.side_effect = get_field_id
        mock_config.get_option_id.side_effect = get_option_id
        mock_config.aggregation_repo = aggregation
        return mock_config

    def _make_client(self, number: int = 700) -> MagicMock:
        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": number,
            "html_url": f"https://ghes.example.com/owner/repo/issues/{number}",
            "node_id": "I_abc",
        }
        mock_client.get_issue_node_id.return_value = "I_abc"
        mock_client.add_to_project.return_value = "PVTI_789"
        return mock_client

    # --- direct（-m） ---

    # bug/task の direct 拒否は status 検証（_issue_create_direct 冒頭の step 0）で exit する。
    # load_active_config / GitHubClient 生成の前なので、I/O モックは一切不要。
    # epic は repo 解決で先に load_active_config を呼ぶため、別テストで config をモックする。
    # create_issue.assert_not_called() は client を生成しないため検証対象が存在せず省略。
    # 代わりに、検証を抜けると未モックの load_active_config / GitHubClient へ進む。
    # そこで exit_code 1 や期待メッセージの崩れが回帰検出になる（モック不在＝検出器）。
    @pytest.mark.parametrize(
        ("issue_type", "body", "status", "expected_msg"),
        [
            # 別テンプレートの配置値（enum 内・型に矛盾）
            ("bug", MINIMAL_BUG_BODY, "backlog", "type 'bug' の起票時 status は 'ready' のみです"),
            # 実害 #665 の回帰防止
            (
                "task",
                MINIMAL_TASK_BODY,
                "backlog",
                "type 'task' の起票時 status は 'ready' のみです",
            ),
            # F-01: enum 内だが型既定外（active）も拒否する
            (
                "task",
                MINIMAL_TASK_BODY,
                "active",
                "type 'task' の起票時 status は 'ready' のみです",
            ),
            # enum 外の値は不正ステータスとして拒否
            ("task", MINIMAL_TASK_BODY, "foo", "不正なステータス: foo"),
        ],
    )
    def test_direct_status_type_mismatch_rejected(
        self, issue_type: str, body: str, status: str, expected_msg: str
    ) -> None:
        """direct（bug/task）: 型既定外・enum 外の status は I/O 到達前に exit 1"""
        result = runner.invoke(
            app,
            [
                "issue",
                "create",
                "-t",
                "タイトル",
                "-r",
                "owner/repo",
                "--type",
                issue_type,
                "--status",
                status,
                "-m",
                body,
            ],
        )
        assert result.exit_code == 1
        assert expected_msg in result.output

    def test_direct_epic_status_pending_rejected(self) -> None:
        """direct（epic）: enum 内だが既定外の status（pending）は exit 1。

        epic は repo 解決のため _issue_create_direct 到達前に
        load_active_config を呼ぶので、config だけはモックする（F-01）。
        """
        mock_config = self._make_config(aggregation="owner/repo")
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "create",
                    "-t",
                    "Epic",
                    "--type",
                    "epic",
                    "--status",
                    "pending",
                    "-m",
                    MINIMAL_EPIC_BODY,
                ],
            )
            assert result.exit_code == 1
            assert "type 'epic' の起票時 status は 'backlog' のみです" in result.output
            assert "指定: pending" in result.output
            mock_client.create_issue.assert_not_called()

    def test_direct_task_default_status_ready_applied(self) -> None:
        """direct: --type task で status 未指定 → ready の option で update される"""
        mock_config = self._make_config()
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "create",
                    "-t",
                    "タスク",
                    "-r",
                    "owner/repo",
                    "--type",
                    "task",
                    "-m",
                    MINIMAL_TASK_BODY,
                ],
            )
            assert result.exit_code == 0
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_123", "PVTI_789", "PVTF_workflow", "opt_ready"
            )
            assert "status: ready" in result.output

    def test_direct_epic_default_status_backlog_applied(self) -> None:
        """direct: --type epic で status 未指定（-r 無し、aggregation_repo ルーティング）
        → backlog の option で update される"""
        mock_config = self._make_config(aggregation="owner/repo")
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "create",
                    "-t",
                    "Epic",
                    "--type",
                    "epic",
                    "-m",
                    MINIMAL_EPIC_BODY,
                ],
            )
            assert result.exit_code == 0
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_123", "PVTI_789", "PVTF_workflow", "opt_backlog"
            )
            assert "status: backlog" in result.output

    def test_direct_tracker_title_prefix_and_backlog_status(self) -> None:
        """direct: --type tracker は題が [Tracker] で始まり、Status が backlog になる"""
        mock_config = self._make_config()
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "create",
                    "-t",
                    "束ねる対象",
                    "-r",
                    "owner/repo",
                    "--type",
                    "tracker",
                    "-m",
                    MINIMAL_EPIC_BODY,
                ],
            )
            assert result.exit_code == 0
            assert mock_client.create_issue.call_args[1]["title"] == "[Tracker] 束ねる対象"
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_123", "PVTI_789", "PVTF_workflow", "opt_backlog"
            )
            assert "status: backlog" in result.output

    def test_direct_tracker_status_ready_rejected(self) -> None:
        """direct: --type tracker --status ready は型既定でないので exit 1"""
        mock_client = self._make_client()
        with patch("cli.commands.issue.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "create",
                    "-t",
                    "束ねる対象",
                    "-r",
                    "owner/repo",
                    "--type",
                    "tracker",
                    "--status",
                    "ready",
                    "-m",
                    MINIMAL_EPIC_BODY,
                ],
            )
        assert result.exit_code == 1
        assert "type 'tracker' の起票時 status は 'backlog' のみです" in result.output
        assert "指定: ready" in result.output
        mock_client.create_issue.assert_not_called()

    def test_direct_task_status_ready_explicit_success(self) -> None:
        """direct: --type task --status ready の明示指定は従来どおり成功"""
        mock_config = self._make_config()
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "create",
                    "-t",
                    "タスク",
                    "-r",
                    "owner/repo",
                    "--type",
                    "task",
                    "--status",
                    "ready",
                    "-m",
                    MINIMAL_TASK_BODY,
                ],
            )
            assert result.exit_code == 0
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_123", "PVTI_789", "PVTF_workflow", "opt_ready"
            )
            # direct（-m）でも Set fields 行が enum 値で表示されること
            # （#670、quick/file と 3 方式で一致）。
            assert "Set fields: status: ready" in result.output

    # --- file 指定 ---

    def _write_file(self, tmp_path: Path, frontmatter: str, body: str) -> Path:
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(f"---\n{frontmatter}\n---\n\n{body}", encoding="utf-8")
        return issue_file

    def test_file_bug_status_backlog_rejected(self, tmp_path: Path) -> None:
        """file: frontmatter type:bug status:backlog は exit 1、Issue 未作成"""
        issue_file = self._write_file(
            tmp_path,
            "title: バグ\ntype: bug\nrepository: owner/repo\nstatus: backlog",
            MINIMAL_BUG_BODY,
        )
        mock_config = self._make_config()
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 1
            assert "type 'bug' の起票時 status は 'ready' のみです" in result.output
            mock_client.create_issue.assert_not_called()

    def test_file_epic_status_ready_rejected(self, tmp_path: Path) -> None:
        """file: frontmatter type:epic status:ready は exit 1、Issue 未作成"""
        issue_file = self._write_file(
            tmp_path,
            "title: Epic\ntype: epic\nrepository: owner/repo\nstatus: ready",
            MINIMAL_EPIC_BODY,
        )
        mock_config = self._make_config()
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 1
            assert "type 'epic' の起票時 status は 'backlog' のみです" in result.output
            mock_client.create_issue.assert_not_called()

    def test_file_task_status_ready_success(self, tmp_path: Path) -> None:
        """file: type:task status:ready は従来どおり成功"""
        issue_file = self._write_file(
            tmp_path,
            "title: タスク\ntype: task\nrepository: owner/repo\nstatus: ready",
            MINIMAL_TASK_BODY,
        )
        mock_config = self._make_config()
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0
            mock_client.create_issue.assert_called_once()
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_123", "PVTI_789", "PVTF_workflow", "opt_ready"
            )
            # Set fields: の表示は enum repr（WorkflowStatus.READY）ではなく
            # enum 値（ready）であること（#670）。
            assert "Set fields: status: ready" in result.output
            assert "WorkflowStatus." not in result.output

    def test_file_set_fields_uses_enum_values_not_repr(self, tmp_path: Path) -> None:
        """file: status/priority/size を全設定して起票する。
        Set fields: 行が enum repr（WorkflowStatus.READY 等）ではなく enum 値で表示される（#670）。"""
        issue_file = self._write_file(
            tmp_path,
            (
                "title: タスク\ntype: task\nrepository: owner/repo\n"
                "status: ready\npriority: high\nsize: s"
            ),
            MINIMAL_TASK_BODY,
        )
        mock_config = self._make_config()
        # priority / size フィールドも解決できるよう field/option を拡張する。
        mock_config.get_field_id.side_effect = lambda name: {
            "workflow": "PVTF_workflow",
            "priority": "PVTF_priority",
            "size": "PVTF_size",
        }.get(name)
        # 本番同様に文字列値キーの dict で引く（enum 渡しでも値で一致する）。
        mock_config.get_option_id.side_effect = lambda field, value: {
            "ready": "opt_ready",
            "high": "opt_high",
            "s": "opt_s",
        }.get(value)
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0
            set_fields_line = next(
                line for line in result.output.splitlines() if "Set fields:" in line
            )
            assert set_fields_line.strip() == "Set fields: status: ready, priority: high, size: s"
            assert "WorkflowStatus." not in result.output
            assert "Priority." not in result.output
            assert "Size." not in result.output
            # 3 フィールドそれぞれが enum 値由来の option_id で update されること。
            assert mock_client.update_project_item_field.call_count == 3
            mock_client.update_project_item_field.assert_any_call(
                "PVT_123", "PVTI_789", "PVTF_workflow", "opt_ready"
            )
            mock_client.update_project_item_field.assert_any_call(
                "PVT_123", "PVTI_789", "PVTF_priority", "opt_high"
            )
            mock_client.update_project_item_field.assert_any_call(
                "PVT_123", "PVTI_789", "PVTF_size", "opt_s"
            )

    def test_file_task_implement_template_success(self, tmp_path: Path) -> None:
        """file: template:task-implement type:task status:ready は成功。

        検証キーが ``fm.template`` ではなく ``fm.type`` であることの回帰防止。
        （task-implement テンプレでも type は task なので ready で整合する）。
        """
        issue_file = self._write_file(
            tmp_path,
            (
                "title: 実装\ntype: task\ntemplate: task-implement\n"
                "repository: owner/repo\nstatus: ready"
            ),
            MINIMAL_TASK_BODY,
        )
        mock_config = self._make_config()
        mock_client = self._make_client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
            assert result.exit_code == 0
            mock_client.create_issue.assert_called_once()

    # --- テンプレ整合 ---

    def test_templates_status_matches_type_default(self) -> None:
        """templates/issue/{epic,task,bug,task-implement}.md の status が
        TYPE_DEFAULT_STATUS と一致することを保証する。"""
        from cli.commands.issue import TEMPLATES_DIR

        for template_name in ("epic", "task", "bug", "task-implement"):
            template_path = TEMPLATES_DIR / f"{template_name}.md"
            # テンプレは title/repository が空のため、検証を回避して frontmatter のみ読む
            text = template_path.read_text(encoding="utf-8")
            # frontmatter の status: 行を抽出
            status_line = next(line for line in text.splitlines() if line.startswith("status:"))
            status_value = status_line.split(":", 1)[1].strip()
            type_line = next(line for line in text.splitlines() if line.startswith("type:"))
            type_value = type_line.split(":", 1)[1].strip()
            assert status_value == TYPE_DEFAULT_STATUS[type_value], (
                f"{template_name}.md: status={status_value} != "
                f"TYPE_DEFAULT_STATUS[{type_value}]={TYPE_DEFAULT_STATUS[type_value]}"
            )


# --- issue create 一括投稿（複数ファイル + プレースホルダ + フラグ消費） ---


class TestIssueCreateBulk:
    """issue create の複数ファイル一括投稿・プレースホルダ展開・免除フラグ消費のテスト"""

    _ISSUE_MD = """---
title: {title}
type: task
repository: {repository}
status: ready
---

## タスク概要

{body}
"""

    def _write_issue_file(
        self, tmp_path: Path, name: str, *, title: str, body: str, repository: str = "owner/repo"
    ) -> Path:
        issue_file = tmp_path / name
        issue_file.write_text(
            self._ISSUE_MD.format(title=title, repository=repository, body=body),
            encoding="utf-8",
        )
        return issue_file

    def _make_config(self) -> MagicMock:
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "opt_ready"
        return mock_config

    def _make_client(self, numbers: list[int]) -> MagicMock:
        mock_client = MagicMock()
        mock_client.create_issue.side_effect = [
            {"number": n, "html_url": f"https://ghes.example.com/owner/repo/issues/{n}"}
            for n in numbers
        ]
        mock_client.get_issue_node_id.return_value = "I_node"
        mock_client.add_to_project.return_value = "PVTI_item"
        return mock_client

    def _state_project(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        """CLAUDE_PROJECT_DIR を tmp に向けて免除フラグを設置する。"""
        project = tmp_path / "state-project"
        state = project / ".pecot" / "state"
        state.mkdir(parents=True)
        flag = state / "issue-create-slash-pending"
        flag.write_text("w-issueize\n")
        monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
        return flag

    def test_bulk_create_resolves_placeholder_and_consumes_flag(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """一括投稿: 後続ファイルの {{issue:<suffix>}} が先行 Issue 番号に展開され、
        全件成功でフラグが消費される。"""
        flag = self._state_project(tmp_path, monkeypatch)
        f1 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase1.md",
            title="Phase 1",
            body="基盤",
        )
        f2 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase2.md",
            title="Phase 2",
            body="{{issue:phase1}} に依存",
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._make_config()),
            patch("cli.commands.issue.GitHubClient", return_value=self._make_client([101, 102])),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(f1), str(f2)])
            assert result.exit_code == 0, result.output
            assert "issues/101" in result.output
            assert "issues/102" in result.output
        assert not flag.is_file()

    def test_bulk_create_second_body_has_resolved_number(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._state_project(tmp_path, monkeypatch)
        f1 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase1.md",
            title="Phase 1",
            body="基盤",
        )
        f2 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase2.md",
            title="Phase 2",
            body="{{issue:phase1}} に依存",
        )
        mock_client = self._make_client([101, 102])

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._make_config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(f1), str(f2)])
            assert result.exit_code == 0, result.output

        second_body = mock_client.create_issue.call_args_list[1][1]["body"]
        assert "#101 に依存" in second_body
        assert "{{issue:" not in second_body

    def test_bulk_create_cross_repo_placeholder_uses_full_ref(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """リポが異なる先行 Issue は owner/repo#N 形式で展開される。"""
        self._state_project(tmp_path, monkeypatch)
        f1 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase1.md",
            title="Phase 1",
            body="基盤",
            repository="owner/other",
        )
        f2 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase2.md",
            title="Phase 2",
            body="{{issue:phase1}} に依存",
        )
        mock_client = self._make_client([101, 102])

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._make_config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(f1), str(f2)])
            assert result.exit_code == 0, result.output

        second_body = mock_client.create_issue.call_args_list[1][1]["body"]
        assert "owner/other#101 に依存" in second_body

    def test_bulk_create_forward_reference_fails_without_posting(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """前方参照は投稿開始前にエラーとなり、1 件も投稿されない。"""
        flag = self._state_project(tmp_path, monkeypatch)
        f1 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase1.md",
            title="Phase 1",
            body="{{issue:phase2}} を先取り",
        )
        f2 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase2.md",
            title="Phase 2",
            body="後続",
        )
        mock_client = self._make_client([101, 102])

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._make_config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(f1), str(f2)])
            assert result.exit_code == 1
        mock_client.create_issue.assert_not_called()
        assert flag.is_file()

    def test_bulk_create_duplicate_file_fails(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        flag = self._state_project(tmp_path, monkeypatch)
        f1 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase1.md",
            title="Phase 1",
            body="基盤",
        )
        mock_client = self._make_client([101])

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._make_config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(f1), str(f1)])
            assert result.exit_code == 1
            assert "重複" in result.output
        mock_client.create_issue.assert_not_called()
        assert flag.is_file()

    def test_bulk_create_missing_file_fails_without_posting(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        flag = self._state_project(tmp_path, monkeypatch)
        f1 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase1.md",
            title="Phase 1",
            body="基盤",
        )
        mock_client = self._make_client([101])

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._make_config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(f1), str(tmp_path / "missing.md")])
            assert result.exit_code == 1
        mock_client.create_issue.assert_not_called()
        assert flag.is_file()

    def test_bulk_create_midway_failure_keeps_flag(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """途中失敗時はフラグを消費しない（残件リトライを許す）。"""
        flag = self._state_project(tmp_path, monkeypatch)
        f1 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase1.md",
            title="Phase 1",
            body="基盤",
        )
        f2 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase2.md",
            title="Phase 2",
            body="{{issue:phase1}} に依存",
        )
        mock_client = self._make_client([101])
        mock_client.create_issue.side_effect = [
            {"number": 101, "html_url": "https://ghes.example.com/owner/repo/issues/101"},
            GitHubAPIError("boom"),
        ]

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._make_config()),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(f1), str(f2)])
            assert result.exit_code == 1
        assert mock_client.create_issue.call_count == 2
        assert flag.is_file()

    def test_single_file_create_consumes_flag(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """単一ファイル投稿も成功時にフラグを消費する。"""
        flag = self._state_project(tmp_path, monkeypatch)
        f1 = self._write_issue_file(
            tmp_path,
            "issue-task-implement-20260817-000000-phase1.md",
            title="Phase 1",
            body="基盤",
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=self._make_config()),
            patch("cli.commands.issue.GitHubClient", return_value=self._make_client([101])),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(f1)])
            assert result.exit_code == 0, result.output
        assert not flag.is_file()

    def test_quick_consumes_flag_on_success(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """issue quick も投稿成功時にフラグを消費する。"""
        flag = self._state_project(tmp_path, monkeypatch)
        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "I_node123",
        }
        mock_client.add_to_project.return_value = "item123"
        mock_config = self._make_config()

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                ["issue", "quick", "-r", "owner/repo", "-m", "テスト", "--no-branch"],
            )
            assert result.exit_code == 0, result.output
        assert not flag.is_file()

    def test_quick_failure_keeps_flag(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """issue quick の投稿失敗時はフラグを消費しない。"""
        flag = self._state_project(tmp_path, monkeypatch)
        mock_client = MagicMock()
        mock_client.create_issue.side_effect = GitHubAPIError("boom")
        mock_config = self._make_config()

        with (
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app,
                ["issue", "quick", "-r", "owner/repo", "-m", "テスト", "--no-branch"],
            )
            assert result.exit_code == 1
        assert flag.is_file()


class TestIssuePendingConsume:
    """起票成功で issue-pending（起票未完了リマインドのフラグ）を CLI が消すことのテスト（#1259）。

    hooks が Bash 出力の `Created: #N` を見て消す処理は撤去済みなので、出力が絞られても
    消えることを CLI 側で保証する。
    """

    _ISSUE_MD = """---
title: Phase 1
type: task
repository: owner/repo
status: ready
---

## タスク概要

{body}
"""

    @pytest.fixture
    def flag(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        project = tmp_path / "pending-project"
        state = project / ".pecot" / "state"
        state.mkdir(parents=True)
        path = state / "issue-pending"
        path.write_text("w-quick\n")
        monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
        return path

    @staticmethod
    def _config() -> MagicMock:
        config = MagicMock()
        config.host = "ghes.example.com"
        config.project.id = "PVT_123"
        config.is_repo_in_project.return_value = True
        config.aggregation_repo_ref = None
        config.get_field_id.return_value = "PVTF_workflow"
        config.get_option_id.return_value = "opt_ready"
        return config

    @staticmethod
    def _client() -> MagicMock:
        client = MagicMock()
        client.create_issue.return_value = {
            "number": 123,
            "html_url": "https://ghes.example.com/owner/repo/issues/123",
            "node_id": "I_node123",
        }
        client.get_issue_node_id.return_value = "I_node"
        client.get_issue_slim.return_value = {"sub_issues": []}
        client.add_to_project.return_value = "PVTI_item"
        return client

    def _file(self, tmp_path: Path, body: str) -> Path:
        issue_file = tmp_path / "issue-task-20260817-000000-pending.md"
        issue_file.write_text(self._ISSUE_MD.format(body=body), encoding="utf-8")
        return issue_file

    def test_quick_success_consumes_issue_pending(self, flag: Path) -> None:
        with (
            patch("cli.commands.issue.GitHubClient", return_value=self._client()),
            patch("cli.commands.issue.load_active_config", return_value=self._config()),
        ):
            result = runner.invoke(
                app, ["issue", "quick", "-r", "owner/repo", "-m", "テスト", "--no-branch"]
            )
        assert result.exit_code == 0, result.output
        assert "Created: #123" in result.output
        assert not flag.exists()

    def test_create_file_success_consumes_issue_pending(self, tmp_path: Path, flag: Path) -> None:
        issue_file = self._file(tmp_path, "基盤")
        with (
            patch("cli.commands.issue.load_active_config", return_value=self._config()),
            patch("cli.commands.issue.GitHubClient", return_value=self._client()),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
        assert result.exit_code == 0, result.output
        assert "Created: #123" in result.output
        assert not flag.exists()

    def test_create_direct_success_consumes_issue_pending(self, flag: Path) -> None:
        with (
            patch("cli.commands.issue.load_active_config", return_value=self._config()),
            patch("cli.commands.issue.GitHubClient", return_value=self._client()),
            patch("cli.commands.issue._validate_issue_template"),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "create",
                    "-t",
                    "タイトル",
                    "-r",
                    "owner/repo",
                    "-m",
                    "## タスク概要\n\n基盤",
                ],
            )
        assert result.exit_code == 0, result.output
        assert "Created: #123" in result.output
        assert not flag.exists()

    def test_template_validation_error_keeps_issue_pending(
        self, tmp_path: Path, flag: Path
    ) -> None:
        """GitHub 接続前のテンプレ検証エラー（プレースホルダ残り）では起票されず、フラグも残る。"""
        issue_file = self._file(tmp_path, "<ここに概要を書く>")
        client = self._client()
        with (
            patch("cli.commands.issue.load_active_config", return_value=self._config()),
            patch("cli.commands.issue.GitHubClient", return_value=client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])
        assert result.exit_code == 1
        client.create_issue.assert_not_called()
        assert flag.is_file()

    def test_parent_epic_link_failure_still_consumes_issue_pending(self, flag: Path) -> None:
        """起票は成功済みなので、その後の親 Epic 紐づけが exit 1 でもフラグは消える。"""
        client = self._client()
        client.add_sub_issue.side_effect = GitHubAPIError("Link failed", 500, "Error")
        with (
            patch("cli.commands.issue.load_active_config", return_value=self._config()),
            patch("cli.commands.issue.GitHubClient", return_value=client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "quick",
                    "-r",
                    "owner/repo",
                    "-m",
                    "テスト",
                    "--parent-epic",
                    "353",
                    "--no-branch",
                ],
            )
        assert result.exit_code == 1
        assert "サブIssue紐づけ失敗" in result.output
        assert not flag.exists()


# --- 投稿本文の記法チェック（#962） ---


_VALID_TASK_BODY = """## Goal — 検証を厳しくする

投稿本文の記法違反を CLI が弾く。

## Acceptance — 記法違反が reject される

- **チェックボックスを弾く** — 確認: pytest
"""

_VALID_MERGE_DIFF_BODY = """## Merge — 実装完了

### Variance — 記法チェックを追加

- **記法チェック** — pytest で確認。

### Impact — レビュー依頼

- **PR 作成** — 判断が要る点なし。
"""


class TestBodyStyleRejectionRoutes:
    """issue create / comment（ファイル・-m）で記法違反が reject される"""

    def _issue_file(self, tmp_path: Path, body: str) -> Path:
        issue_file = tmp_path / "issue.md"
        issue_file.write_text(
            "---\n"
            "title: 記法チェック\n"
            "type: task\n"
            "repository: owner/repo\n"
            "status: ready\n"
            "---\n\n" + body,
            encoding="utf-8",
        )
        return issue_file

    def _comment_file(self, tmp_path: Path, body: str) -> Path:
        comment_file = tmp_path / "comment.md"
        comment_file.write_text(
            '---\nissue_ref: "owner/repo/123"\ntemplate: merge-diff\n---\n\n' + body,
            encoding="utf-8",
        )
        return comment_file

    def test_issue_create_rejects_checkbox(self, tmp_path: Path) -> None:
        """issue create: 本文のチェックボックス記法で exit 1（API に到達しない）"""
        body = _VALID_TASK_BODY + "\n- [ ] 残タスク\n"
        issue_file = self._issue_file(tmp_path, body)

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient") as mock_gh_class,
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])

        assert result.exit_code == 1
        assert "使用できない記法" in result.output
        assert "チェックボックス記法" in result.output
        mock_gh_class.assert_not_called()

    def test_issue_create_rejects_placeholder(self, tmp_path: Path) -> None:
        """issue create: 本文に残った `<...>` で exit 1"""
        body = _VALID_TASK_BODY + "\n- **<観測できる状態>** — 確認: <判定手段>\n"
        issue_file = self._issue_file(tmp_path, body)

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient") as mock_gh_class,
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])

        assert result.exit_code == 1
        assert "<観測できる状態>" in result.output
        mock_gh_class.assert_not_called()

    def test_issue_create_accepts_fenced_checkbox_and_html(self, tmp_path: Path) -> None:
        """issue create: フェンス内の `- [ ]`・許可 HTML タグ・autolink は通る"""
        body = (
            _VALID_TASK_BODY
            + "\n```markdown\n- [ ] 雛形の例\n<未編集>\n```\n\n"
            + "<details><summary>ログ</summary>\n\n本文\n\n</details>\n\n"
            + "<https://ghes.example.com/acme-labs/aist-plugin/issues/962>\n"
        )
        issue_file = self._issue_file(tmp_path, body)

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.project.id = "PVT_123"
        mock_config.is_repo_in_project.return_value = True
        mock_client = MagicMock()
        mock_client.create_issue.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/issues/456",
            "node_id": "I_456",
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])

        assert result.exit_code == 0, result.output
        assert mock_client.create_issue.call_count == 1

    def test_comment_from_file_rejects_checkbox(self, tmp_path: Path) -> None:
        """issue comment（ファイル）: チェックボックス記法で exit 3"""
        comment_file = self._comment_file(tmp_path, _VALID_MERGE_DIFF_BODY + "\n- [x] 完了\n")

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient") as mock_gh_class,
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert result.exit_code == 3
        assert "使用できない記法" in result.output
        mock_gh_class.assert_not_called()

    def test_comment_direct_rejects_placeholder(self) -> None:
        """issue comment -m: 本文に残った `<...>` で exit 3"""
        message = _VALID_MERGE_DIFF_BODY + "\n- **<次にやること>** — 未定\n"

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient") as mock_gh_class,
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "-t",
                    "merge-diff",
                    "-m",
                    message,
                    "--issue",
                    "owner/repo/123",
                ],
            )

        assert result.exit_code == 3
        assert "<次にやること>" in result.output
        mock_gh_class.assert_not_called()

    def test_comment_from_file_validation_failure_exits_3(self, tmp_path: Path) -> None:
        """issue comment（ファイル）: テンプレ検証の失敗は exit 3（hooks が通信失敗と区別する）"""
        comment_file = self._comment_file(tmp_path, "## 進捗\n\n- 見出しなし\n- ✅ 完了\n")

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient") as mock_gh_class,
        ):
            result = runner.invoke(app, ["issue", "comment", str(comment_file)])

        assert result.exit_code == 3
        lines = result.output.splitlines()
        assert any(line.startswith("エラー: 不足セクション: ") for line in lines)
        assert "エラー: 使用できない記法: 絵文字は使用できません" in lines
        mock_gh_class.assert_not_called()

    def test_comment_direct_validation_failure_exits_3(self) -> None:
        """issue comment -m: サマリ規則違反は専用のエラー行で報告し exit 3"""
        message = _VALID_MERGE_DIFF_BODY.replace("## Merge — 実装完了", "## Merge — all done")

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient") as mock_gh_class,
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "-t",
                    "merge-diff",
                    "-m",
                    message,
                    "--issue",
                    "owner/repo/123",
                ],
            )

        assert result.exit_code == 3
        lines = result.output.splitlines()
        assert any(line.startswith("エラー: 見出しサマリの規則違反: ## Merge — ") for line in lines)
        assert not any(line.startswith("エラー: 不足セクション:") for line in lines)
        mock_gh_class.assert_not_called()

    def test_comment_api_failure_keeps_exit_1(self) -> None:
        """issue comment -m: 投稿の通信失敗は検証失敗と区別して exit 1"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = MagicMock()
        mock_client.add_issue_comment.side_effect = GitHubAPIError("boom", status_code=502)

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app,
                [
                    "issue",
                    "comment",
                    "-t",
                    "merge-diff",
                    "-m",
                    _VALID_MERGE_DIFF_BODY,
                    "--issue",
                    "owner/repo/123",
                ],
            )

        assert result.exit_code == 1
        assert "コメント投稿失敗" in result.output

    def test_issue_create_summary_violation_has_its_own_line(self, tmp_path: Path) -> None:
        """issue create: サマリ規則違反は「不足セクション」と別の行で報告し exit 1"""
        body = _VALID_TASK_BODY.replace("## Goal — 検証を厳しくする", "## Goal — tighten checks")
        issue_file = self._issue_file(tmp_path, body)

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient") as mock_gh_class,
        ):
            result = runner.invoke(app, ["issue", "create", str(issue_file)])

        assert result.exit_code == 1
        lines = result.output.splitlines()
        assert any(line.startswith("エラー: 見出しサマリの規則違反: ## Goal — ") for line in lines)
        assert not any(line.startswith("エラー: 不足セクション:") for line in lines)
        mock_gh_class.assert_not_called()


# --- comment 雛形ラウンドトリップテスト（#958 F-02 / F-06） ---

# `--prepare` 雛形の見出しは全て `## 名前 — <サマリ>` 形式
_HEADING_SUMMARY_RE = re.compile(r"^(#{2,6} .+?) — <[^>]*>$", re.MULTILINE)
# 投稿本文の見出し行に残ってはならない未編集プレースホルダ
_HEADING_PLACEHOLDER_RE = re.compile(r"^#{2,6} .*<[^>]+>.*$", re.MULTILINE)
# 本文側の未編集プレースホルダ（改行を跨がせない）
_BODY_PLACEHOLDER_RE = re.compile(r"<(?!/?(?:details|summary)[\s>])[^<>\n]+>")


def _fill_placeholders(content: str) -> str:
    """雛形の `<...>` を実コンテンツに置換する（#962 で本文側も reject 対象）

    入れ子（`<... `<Issue番号>` ...>`）があるため、変化しなくなるまで繰り返す。
    """
    content = _HEADING_SUMMARY_RE.sub(r"\1 — 見本サマリ", content)
    while True:
        filled = _BODY_PLACEHOLDER_RE.sub("見本", content)
        if filled == content:
            return content
        content = filled


COMMENT_TEMPLATE_IDS = [
    "merge-diff",
    "plan",
    "merge-diff",
    "precede-notify",
    "review-findings",
    "review-resolution",
]


class TestPreparedCommentRoundtrip:
    """``issue comment --prepare`` の雛形をそのまま投稿処理に流す検証"""

    @pytest.mark.parametrize("template", COMMENT_TEMPLATE_IDS)
    def test_prepared_comment_roundtrip(
        self, template: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """見出しサマリを埋めるだけで投稿でき、本文にガイドコメントが残らない

        テンプレート実体と検証器の食い違い、および冒頭ガイドコメントの
        投稿本文への混入（#958 F-02）を 6 種すべてで検出する。
        """
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        prepare_result = runner.invoke(
            app,
            ["issue", "comment", "--prepare", "-t", template, "--issue", "owner/repo/123"],
        )
        assert prepare_result.exit_code == 0, prepare_result.output

        prepared = list(output_dir.glob(f"comment-{template}-*.md"))
        assert len(prepared) == 1
        file = prepared[0]
        file.write_text(
            _fill_placeholders(file.read_text(encoding="utf-8")),
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_client = MagicMock()
        mock_client.add_issue_comment.return_value = {
            "id": 1,
            "html_url": "https://ghes.example.com/owner/repo/issues/123#issuecomment-1",
        }

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch("cli.commands.issue.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["issue", "comment", str(file)])

        assert result.exit_code == 0, result.output
        posted_body = mock_client.add_issue_comment.call_args[0][3]
        assert "<!--" not in posted_body, f"{template}: 冒頭ガイドコメントが投稿された"
        leftover = _HEADING_PLACEHOLDER_RE.search(posted_body)
        assert leftover is None, f"{template}: 見出しに未編集プレースホルダ {leftover}"
