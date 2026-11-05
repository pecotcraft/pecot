"""tests/cli/test_release.py - release コマンドのテスト

release preflight / release create / release merge コマンドのCLIテスト。
core関数をモックして検証する。
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import typer.testing

from cli.commands.main import app
from cli.core.dependabot import DependabotAlertError, DependabotAlertStatus, OpenAlert
from cli.core.github import GitHubAuthError
from cli.core.release import PreflightResult, ReleaseError
from cli.core.security_alerts import ScanAlertStatus, SecurityAlertError

runner = typer.testing.CliRunner()

ALERTS_URL = "https://ghes.example.com/owner/repo/security/dependabot"


def _alert_status(
    *,
    enabled: bool = True,
    open_count: int = 0,
    max_severity: str | None = None,
    open_alerts: list[OpenAlert] | None = None,
) -> DependabotAlertStatus:
    return DependabotAlertStatus(
        enabled=enabled,
        open_count=open_count,
        max_severity=max_severity,
        alerts_url=ALERTS_URL,
        open_alerts=open_alerts or [],
    )


# release preflight テスト


@pytest.mark.usefixtures("no_open_alerts")
class TestReleasePreflight:
    """release preflight コマンドのテスト"""

    def test_success_with_auto_detect(self) -> None:
        """バージョン自動検出で成功"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        preflight_result = PreflightResult(
            version="0.6.1",
            release_notes="### 追加\n\n- 新機能",
            develop_branch="develop-aist",
            release_branch="main",
            diff_count=5,
            tag_name="v0.6.1",
        )

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.run_preflight", return_value=preflight_result),
        ):
            result = runner.invoke(app, ["release", "preflight"])

        assert result.exit_code == 0
        assert "Auto-detected version: 0.6.1" in result.output
        assert "Preflight Check Passed" in result.output
        assert "新機能" in result.output

    def test_success_with_version(self) -> None:
        """バージョン指定で成功"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        preflight_result = PreflightResult(
            version="0.6.1",
            release_notes="### 追加\n\n- 新機能",
            develop_branch="develop-aist",
            release_branch="main",
            diff_count=3,
            tag_name="v0.6.1",
        )

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.run_preflight", return_value=preflight_result),
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1"])

        assert result.exit_code == 0
        assert "Version 0.6.1 found in CHANGELOG.md" in result.output

    def test_no_git_root(self) -> None:
        """gitリポジトリが見つからない"""
        with patch("cli.commands.release.git_toplevel", return_value=None):
            result = runner.invoke(app, ["release", "preflight"])

        assert result.exit_code == 1

    def test_no_active_config(self) -> None:
        """アクティブプロジェクトがない"""
        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=None),
        ):
            result = runner.invoke(app, ["release", "preflight"])

        assert result.exit_code == 1

    def test_no_develop_branch(self) -> None:
        """develop_branchが未設定"""
        mock_config = MagicMock()
        mock_config.get_develop_branch.return_value = None
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "preflight"])

        assert result.exit_code == 1
        assert "develop_branch" in result.output

    def test_preflight_error(self) -> None:
        """preflightチェックエラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch(
                "cli.commands.release.run_preflight",
                side_effect=ReleaseError("タグ v0.6.1 はローカルに既に存在します"),
            ),
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1"])

        assert result.exit_code == 1


# release create テスト


class TestReleaseCreate:
    """release create コマンドのテスト"""

    def test_success(self) -> None:
        """リリース作成成功"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        mock_client = MagicMock()
        mock_client.create_release.return_value = {
            "html_url": "https://ghes.example.com/owner/repo/releases/tag/v0.6.1",
            "tag_name": "v0.6.1",
        }

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.extract_version_release_notes",
                return_value="### 追加\n\n- 新機能",
            ),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "create", "0.6.1"])

        assert result.exit_code == 0
        assert "GitHub release created: v0.6.1" in result.output
        assert "Release URL:" in result.output

    def test_dry_run(self) -> None:
        """ドライランモード"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.extract_version_release_notes",
                return_value="### 追加\n\n- 新機能",
            ),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "create", "0.6.1", "--dry-run"])

        assert result.exit_code == 0
        assert "DRY RUN" in result.output
        assert "v0.6.1" in result.output
        assert "owner/repo" in result.output

    def test_invalid_version(self) -> None:
        """無効なバージョン形式"""
        result = runner.invoke(app, ["release", "create", "invalid"])

        assert result.exit_code == 1

    def test_no_git_root(self) -> None:
        """gitリポジトリが見つからない"""
        with patch("cli.commands.release.git_toplevel", return_value=None):
            result = runner.invoke(app, ["release", "create", "0.6.1"])

        assert result.exit_code == 1

    def test_api_error(self) -> None:
        """APIエラーの場合"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        mock_client = MagicMock()
        mock_client.create_release.side_effect = GitHubAPIError("Validation Failed")

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.extract_version_release_notes",
                return_value="notes",
            ),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "create", "0.6.1"])

        assert result.exit_code == 1

    def test_no_release_branch(self) -> None:
        """release_branchが未設定"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_release_branch.return_value = None
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.extract_version_release_notes",
                return_value="notes",
            ),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "create", "0.6.1"])

        assert result.exit_code == 1
        assert "release_branch" in result.output


# --package オプションの分岐テスト


def _mock_repo_with_packages() -> MagicMock:
    """packages=[pecot-workflow, pecot-visual] のリポエントリ mock"""
    repo_obj = MagicMock()
    repo_obj.changelog_file = None
    pecot_pkg = MagicMock()
    pecot_pkg.name = "pecot-workflow"
    pecot_pkg.changelog = "plugins/pecot-workflow/CHANGELOG.md"
    pecotv_pkg = MagicMock()
    pecotv_pkg.name = "pecot-visual"
    pecotv_pkg.changelog = "plugins/pecot-visual/CHANGELOG.md"
    repo_obj.packages = [pecot_pkg, pecotv_pkg]

    def _find_package(name: str) -> MagicMock | None:
        for p in repo_obj.packages:
            if p.name == name:
                return p
        return None

    repo_obj.find_package.side_effect = _find_package
    return repo_obj


@pytest.mark.usefixtures("no_open_alerts")
class TestReleasePreflightPackage:
    """release preflight の --package 分岐テスト"""

    def test_packages_unset_without_package_works(self) -> None:
        """packages 未設定 + --package なし → 従来動作"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        preflight_result = PreflightResult(
            version="0.6.1",
            release_notes="### 追加\n\n- 新機能",
            develop_branch="develop-aist",
            release_branch="main",
            diff_count=5,
            tag_name="v0.6.1",
        )

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.run_preflight", return_value=preflight_result) as mock_pf,
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1"])

        assert result.exit_code == 0
        # tag_prefix=None で呼ばれる
        assert mock_pf.call_args.kwargs["tag_prefix"] is None

    def test_packages_unset_with_package_errors(self) -> None:
        """packages 未設定 + --package → エラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app, ["release", "preflight", "0.6.1", "--package", "pecot-workflow"]
            )

        assert result.exit_code == 1
        assert "packages 設定がありません" in result.output

    def test_packages_set_without_package_errors(self) -> None:
        """packages 設定済 + --package なし → エラー（利用可能リスト表示）"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value = _mock_repo_with_packages()

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1"])

        assert result.exit_code == 1
        assert "--package を指定してください" in result.output
        assert "pecot-workflow" in result.output
        assert "pecot-visual" in result.output

    def test_packages_set_with_package_uses_prefix(self) -> None:
        """packages 設定済 + --package pecot → tag_prefix=pecot で preflight 呼出"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value = _mock_repo_with_packages()

        preflight_result = PreflightResult(
            version="0.6.1",
            release_notes="### 追加\n\n- 新機能",
            develop_branch="develop-aist",
            release_branch="main",
            diff_count=5,
            tag_name="pecot-workflow-v0.6.1",
        )

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.run_preflight", return_value=preflight_result) as mock_pf,
        ):
            result = runner.invoke(
                app, ["release", "preflight", "0.6.1", "--package", "pecot-workflow"]
            )

        assert result.exit_code == 0
        assert mock_pf.call_args.kwargs["tag_prefix"] == "pecot-workflow"
        assert mock_pf.call_args.kwargs["changelog_path"] == Path(
            "/repo/plugins/pecot-workflow/CHANGELOG.md"
        )
        assert "pecot-workflow-v0.6.1" in result.output

    def test_packages_set_with_unknown_package_errors(self) -> None:
        """packages 設定済 + --package 未登録名 → エラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value = _mock_repo_with_packages()

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1", "--package", "unknown"])

        assert result.exit_code == 1
        assert "登録されていません" in result.output


class TestReleaseCreatePackage:
    """release create の --package 分岐テスト"""

    def test_packages_set_with_package_creates_prefixed_tag(self) -> None:
        """packages 設定済 + --package pecot → <plugin>-v<ver> タグで create"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value = _mock_repo_with_packages()

        mock_client = MagicMock()
        mock_client.create_release.return_value = {
            "html_url": "https://ghes.example.com/owner/repo/releases/tag/pecot-workflow-v0.6.1",
            "tag_name": "pecot-workflow-v0.6.1",
        }

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.extract_version_release_notes",
                return_value="### 追加\n\n- 新機能",
            ),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app, ["release", "create", "0.6.1", "--package", "pecot-workflow"]
            )

        assert result.exit_code == 0
        mock_client.create_release.assert_called_once()
        call_kwargs = mock_client.create_release.call_args.kwargs
        assert call_kwargs["tag_name"] == "pecot-workflow-v0.6.1"
        assert call_kwargs["name"] == "pecot-workflow v0.6.1"

    def test_packages_set_without_package_errors(self) -> None:
        """packages 設定済 + --package なし → エラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value = _mock_repo_with_packages()

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "create", "0.6.1"])

        assert result.exit_code == 1
        assert "--package を指定してください" in result.output

    def test_packages_unset_with_package_errors(self) -> None:
        """packages 未設定 + --package → エラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app, ["release", "create", "0.6.1", "--package", "pecot-workflow"]
            )

        assert result.exit_code == 1
        assert "packages 設定がありません" in result.output


# release merge テスト


def _make_pr_data(
    *,
    state: str = "OPEN",
    mergeable: str = "MERGEABLE",
    base_ref: str = "main",
    head_ref: str = "develop-aist",
    title: str = "release: v0.7.0",
    body: str = "",
) -> dict:
    """テスト用PR情報を生成"""
    return {
        "number": 100,
        "state": state,
        "title": title,
        "body": body,
        "head_ref": head_ref,
        "base_ref": base_ref,
        "is_draft": False,
        "mergeable": mergeable,
        "comments": 0,
        "closing_issues": [],
        "referenced_issues": [],
        "reviews": [],
    }


def _mock_config(*, release_branch: str | None = "main") -> MagicMock:
    """テスト用config mockを生成"""
    config = MagicMock()
    config.host = "ghes.example.com"
    config.get_release_branch.return_value = release_branch
    return config


class TestReleaseMerge:
    """release merge コマンドのテスト"""

    def test_success(self) -> None:
        """正常マージ（merge method="merge" で呼ばれることを検証）"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data()
        mock_client.merge_pull_request.return_value = {
            "sha": "abc1234567890",
            "merged": True,
            "message": "Pull Request successfully merged",
        }

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100"])

        assert result.exit_code == 0
        assert "マージしました" in result.output
        assert "merge (regular)" in result.output
        mock_client.merge_pull_request.assert_called_once_with(
            "owner", "repo", 100, merge_method="merge"
        )

    def test_dry_run(self) -> None:
        """ドライラン出力（merge (regular) 表示の検証）"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data()

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100", "--dry-run"])

        assert result.exit_code == 0
        assert "ドライラン" in result.output
        assert "merge (regular)" in result.output
        mock_client.merge_pull_request.assert_not_called()

    def test_already_merged(self) -> None:
        """MERGED 状態でエラー"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data(state="MERGED")

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100"])

        assert result.exit_code == 1
        assert "マージ済み" in result.output

    def test_closed_pr(self) -> None:
        """CLOSED 状態でエラー"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data(state="CLOSED")

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100"])

        assert result.exit_code == 1
        assert "クローズ" in result.output

    def test_conflicting_pr(self) -> None:
        """CONFLICTING 状態でエラー"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data(mergeable="CONFLICTING")

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100"])

        assert result.exit_code == 1
        assert "コンフリクト" in result.output

    def test_conflicting_with_admin(self) -> None:
        """CONFLICTING + --admin で成功"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data(mergeable="CONFLICTING")
        mock_client.merge_pull_request.return_value = {
            "sha": "abc1234567890",
            "merged": True,
            "message": "Pull Request successfully merged",
        }

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100", "--admin"])

        assert result.exit_code == 0
        assert "マージしました" in result.output

    def test_wrong_base_branch(self) -> None:
        """base が release_branch でない場合エラー"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data(base_ref="develop-aist")

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100"])

        assert result.exit_code == 1
        assert "release_branch" in result.output
        assert "develop-aist" in result.output

    def test_release_branch_not_configured(self) -> None:
        """release_branch 未設定でエラー"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data()

        with (
            patch(
                "cli.commands.release.load_active_config",
                return_value=_mock_config(release_branch=None),
            ),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100"])

        assert result.exit_code == 1
        assert "release_branch" in result.output

    def test_delete_branch(self) -> None:
        """--delete-branch で削除成功"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data()
        mock_client.merge_pull_request.return_value = {
            "sha": "abc1234567890",
            "merged": True,
            "message": "Pull Request successfully merged",
        }

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100", "--delete-branch"])

        assert result.exit_code == 0
        assert "削除しました" in result.output
        mock_client.delete_branch.assert_called_once_with("owner", "repo", "develop-aist")

    def test_delete_branch_failure_warns_on_stderr(self) -> None:
        """--delete-branch の削除失敗は ⚠ を stderr に出し、マージ自体は成功"""
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = _make_pr_data()
        mock_client.merge_pull_request.return_value = {
            "sha": "abc1234567890",
            "merged": True,
            "message": "Pull Request successfully merged",
        }
        mock_client.delete_branch.side_effect = GitHubAPIError("削除失敗")

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100", "--delete-branch"])

        assert result.exit_code == 0
        assert "⚠ ブランチ削除に失敗: 削除失敗" in result.stderr
        assert "⚠" not in result.stdout

    def test_no_issue_close(self) -> None:
        """Issue 自動クローズが行われないことを検証"""
        mock_client = MagicMock()
        pr_data = _make_pr_data(body="Closes #42\nFixes #43")
        pr_data["closing_issues"] = [{"number": 42, "title": "bug"}]
        mock_client.get_pull_request_slim.return_value = pr_data
        mock_client.merge_pull_request.return_value = {
            "sha": "abc1234567890",
            "merged": True,
            "message": "Pull Request successfully merged",
        }

        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "merge", "owner/repo/100"])

        assert result.exit_code == 0
        mock_client.close_issue.assert_not_called()


# release preflight: Dependabot alert / nx 方式


def _alert_config(
    *, release_type: str = "single", release_branch: str | None = "main"
) -> MagicMock:
    config = MagicMock()
    config.host = "ghes.example.com"
    config.get_develop_branch.return_value = "develop-aist"
    config.get_release_branch.return_value = release_branch
    repo_obj = config.find_repository.return_value
    repo_obj.changelog_file = None
    repo_obj.packages = None
    repo_obj.effective_release_type = release_type
    return config


_PREFLIGHT_RESULT = PreflightResult(
    version="0.6.1",
    release_notes="### 追加\n\n- 新機能",
    develop_branch="develop-aist",
    release_branch="main",
    diff_count=5,
    tag_name="v0.6.1",
)


def _invoke_preflight(
    config: MagicMock,
    args: list[str] | None = None,
    *,
    status: DependabotAlertStatus | None = None,
    alert_error: Exception | None = None,
    code_scanning: ScanAlertStatus | SecurityAlertError | None = None,
    secret_scanning: ScanAlertStatus | SecurityAlertError | None = None,
    git_root: Path = Path("/repo"),
) -> tuple[typer.testing.Result, MagicMock]:
    """alert 判定を差し替えて ``pecot release preflight`` を起動し、run_preflight の mock も返す"""
    fetch = MagicMock(return_value=status or _alert_status(), side_effect=alert_error)
    run_pf = MagicMock(return_value=_PREFLIGHT_RESULT)
    zero = ScanAlertStatus(enabled=True, open_count=0, alerts_url="https://x/scan")
    cs = MagicMock(side_effect=None, return_value=zero)
    ss = MagicMock(side_effect=None, return_value=zero)
    for mock, given in ((cs, code_scanning), (ss, secret_scanning)):
        if isinstance(given, Exception):
            mock.side_effect = given
        elif given is not None:
            mock.return_value = given
    with (
        patch("cli.commands.release.fetch_code_scanning_status", cs),
        patch("cli.commands.release.fetch_secret_scanning_status", ss),
        patch("cli.commands.release.git_toplevel", return_value=git_root),
        patch(
            "cli.commands.release.origin_repo", return_value=("ghes.example.com", "owner", "repo")
        ),
        patch("cli.commands.release.load_active_config", return_value=config),
        patch("cli.commands.release.GitHubClient"),
        patch("cli.commands.release.fetch_dependabot_alert_status", fetch),
        patch("cli.commands.release.run_preflight", run_pf),
    ):
        result = runner.invoke(app, ["release", "preflight", *(args or [])])
    return result, run_pf


class TestReleasePreflightScanning:
    """code scanning・secret scanning の open の alert でも preflight が止まる"""

    def test_all_zero_passes_and_shows_three_lines(self) -> None:
        result, run_pf = _invoke_preflight(_alert_config())

        assert result.exit_code == 0
        assert "✓ Dependabot alerts: open 0" in result.output
        assert "✓ code scanning: open 0" in result.output
        assert "✓ secret scanning: open 0" in result.output
        run_pf.assert_called_once()

    def test_open_code_scanning_fails_with_numbers(self) -> None:
        status = ScanAlertStatus(
            enabled=True, open_count=1, alerts_url="https://x/cs", open_numbers=[10]
        )
        result, run_pf = _invoke_preflight(_alert_config(), code_scanning=status)

        assert result.exit_code == 1
        assert "code scanning の alert が open 1 件" in result.stderr
        assert "#10" in result.stderr
        assert "https://x/cs" in result.stderr
        assert "Preflight Check Passed" not in result.output
        run_pf.assert_not_called()

    def test_disabled_scanning_passes(self) -> None:
        off = ScanAlertStatus(enabled=False, open_count=0, alerts_url="https://x/s")
        result, _ = _invoke_preflight(_alert_config(), code_scanning=off, secret_scanning=off)

        assert result.exit_code == 0
        assert "✓ code scanning: 無効" in result.output
        assert "✓ secret scanning: 無効" in result.output

    def test_all_three_are_checked_before_exit(self) -> None:
        """Dependabot が止まっても、残りの 2 種の結果まで表示してから終える"""
        bad = ScanAlertStatus(
            enabled=True, open_count=2, alerts_url="https://x/ss", open_numbers=[3, 4]
        )
        result, _ = _invoke_preflight(
            _alert_config(),
            status=_alert_status(open_count=1, max_severity="high"),
            secret_scanning=bad,
        )

        assert result.exit_code == 1
        assert "Dependabot alert が open 1 件" in result.stderr
        assert "✓ code scanning: open 0" in result.output
        assert "secret scanning の alert が open 2 件" in result.stderr

    def test_undeterminable_scanning_fails(self) -> None:
        result, run_pf = _invoke_preflight(
            _alert_config(), secret_scanning=SecurityAlertError("権限不足")
        )

        assert result.exit_code == 1
        assert "secret scanning の状態を確認できません: 権限不足" in result.stderr
        run_pf.assert_not_called()

    def test_nx_also_checks_scanning(self) -> None:
        bad = ScanAlertStatus(enabled=True, open_count=1, alerts_url="u", open_numbers=[1])
        result, _ = _invoke_preflight(_alert_config(release_type="nx"), code_scanning=bad)

        assert result.exit_code == 1


class TestReleasePreflightDependabot:
    """open の Dependabot alert で preflight が止まる"""

    def test_open_alerts_fail(self) -> None:
        result, run_pf = _invoke_preflight(
            _alert_config(), status=_alert_status(open_count=3, max_severity="high")
        )

        assert result.exit_code == 1
        assert "Dependabot alert が open 3 件（最高 severity: high）" in result.stderr
        assert ALERTS_URL in result.stderr
        assert "Preflight Check Passed" not in result.output
        run_pf.assert_not_called()

    def test_zero_alerts_pass(self) -> None:
        result, run_pf = _invoke_preflight(_alert_config())

        assert result.exit_code == 0
        assert "✓ Dependabot alerts: open 0" in result.output
        assert "Preflight Check Passed" in result.output
        run_pf.assert_called_once()

    def test_alerts_disabled_pass(self) -> None:
        result, _ = _invoke_preflight(_alert_config(), status=_alert_status(enabled=False))

        assert result.exit_code == 0
        assert "✓ Dependabot alerts: 無効" in result.output
        assert "Preflight Check Passed" in result.output

    @pytest.mark.parametrize(
        "reason",
        [
            "owner/repo: Dependabot alerts は有効ですが一覧を取得できません",
            "owner/repo: GitHub APIエラー: 500",
        ],
    )
    def test_alert_error_fails_with_reason(self, reason: str) -> None:
        result, run_pf = _invoke_preflight(
            _alert_config(), alert_error=DependabotAlertError(reason)
        )

        assert result.exit_code == 1
        assert reason in result.stderr
        assert "Preflight Check Passed" not in result.output
        run_pf.assert_not_called()

    def test_release_branch_unset_fails_after_alert_line(self) -> None:
        result, _ = _invoke_preflight(_alert_config(release_branch=None))

        assert result.exit_code == 1
        assert "✓ Dependabot alerts: open 0" in result.output
        assert "release_branchが設定されていません" in result.stderr


def _write_exceptions(git_root: Path, exceptions: list[dict[str, object]]) -> None:
    path = git_root / ".github" / "dependabot-exceptions.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"exceptions": exceptions}, ensure_ascii=False), encoding="utf-8")


def _exception(alert: int, package: str = "minimatch") -> dict[str, object]:
    return {
        "alert": alert,
        "package": package,
        "reason": "親が修正版を受け入れない",
        "reevaluate": "親が修正版を受け入れたら上げる",
    }


_MINIMATCH = OpenAlert(number=17, package="minimatch", severity="medium")
_GRAPHQL = OpenAlert(number=16, package="graphql-core", severity="high")


class TestReleasePreflightDependabotExceptions:
    """例外ファイルに載った open の alert だけを通す"""

    def test_all_open_alerts_excepted_pass(self, tmp_path: Path) -> None:
        _write_exceptions(tmp_path, [_exception(17)])
        status = _alert_status(open_count=1, max_severity="medium", open_alerts=[_MINIMATCH])

        result, _ = _invoke_preflight(_alert_config(), status=status, git_root=tmp_path)

        assert result.exit_code == 0
        assert "例外として通す Dependabot alert #17（minimatch）" in result.output
        assert "理由: 親が修正版を受け入れない" in result.output
        assert "見直し: 親が修正版を受け入れたら上げる" in result.output
        assert "✓ Dependabot alerts: open 1（すべて例外）" in result.output

    def test_alert_outside_exceptions_fails(self, tmp_path: Path) -> None:
        _write_exceptions(tmp_path, [_exception(17)])
        status = _alert_status(
            open_count=2, max_severity="high", open_alerts=[_MINIMATCH, _GRAPHQL]
        )

        result, run_pf = _invoke_preflight(_alert_config(), status=status, git_root=tmp_path)

        assert result.exit_code == 1
        assert (
            "例外に載らない Dependabot alert が open 1 件（最高 severity: high）" in result.stderr
        )
        assert "#16（graphql-core・high）" in result.stderr
        assert "#17" not in result.stderr
        run_pf.assert_not_called()

    def test_exception_for_closed_alert_is_reported(self, tmp_path: Path) -> None:
        _write_exceptions(tmp_path, [_exception(19, "glob")])

        result, _ = _invoke_preflight(_alert_config(), git_root=tmp_path)

        assert result.exit_code == 0
        assert "例外の Dependabot alert #19（glob）は open ではありません" in result.output
        assert "✓ Dependabot alerts: open 0" in result.output

    def test_exception_without_reason_fails(self, tmp_path: Path) -> None:
        entry = _exception(17)
        entry["reason"] = " "
        _write_exceptions(tmp_path, [entry])

        result, run_pf = _invoke_preflight(_alert_config(), git_root=tmp_path)

        assert result.exit_code == 1
        assert ".github/dependabot-exceptions.json を読めません" in result.stderr
        run_pf.assert_not_called()

    def test_open_alert_message_suggests_exceptions_file(self) -> None:
        result, _ = _invoke_preflight(
            _alert_config(), status=_alert_status(open_count=1, max_severity="low")
        )

        assert result.exit_code == 1
        assert ".github/dependabot-exceptions.json に載せて通せます" in result.stderr


class TestReleasePreflightNx:
    """release_type: nx は alert の確認だけを行う"""

    def test_nx_checks_alerts_only(self) -> None:
        result, run_pf = _invoke_preflight(_alert_config(release_type="nx"))

        assert result.exit_code == 0
        assert "=== Release Preflight Check ===" in result.output
        assert "✓ Dependabot alerts: open 0" in result.output
        assert "=== Preflight Check Passed ===" in result.output
        assert "Auto-detected version" not in result.output
        assert "Release Notes:" not in result.output
        run_pf.assert_not_called()

    def test_nx_open_alerts_fail(self) -> None:
        result, _ = _invoke_preflight(
            _alert_config(release_type="nx"),
            status=_alert_status(open_count=1, max_severity="critical"),
        )

        assert result.exit_code == 1
        assert "open 1 件（最高 severity: critical）" in result.stderr
        assert "Preflight Check Passed" not in result.output

    def test_nx_rejects_version(self) -> None:
        result, run_pf = _invoke_preflight(_alert_config(release_type="nx"), ["1.0.0"])

        assert result.exit_code == 1
        assert "version 引数と --package を指定できません" in result.stderr
        assert "Preflight Check Passed" not in result.output
        run_pf.assert_not_called()

    def test_nx_rejects_package(self) -> None:
        config = _alert_config(release_type="nx")
        # packages 設定ありの nx リポに --package で向けても拒否される
        config.find_repository.return_value = _mock_repo_with_packages()
        config.find_repository.return_value.effective_release_type = "nx"
        result, run_pf = _invoke_preflight(config, ["--package", "pecot-workflow"])

        assert result.exit_code == 1
        assert "version 引数と --package を指定できません" in result.stderr
        assert "monorepo 構成です" not in result.stderr
        run_pf.assert_not_called()

    def test_nx_with_packages_passes_without_arguments(self) -> None:
        config = _alert_config(release_type="nx")
        config.find_repository.return_value = _mock_repo_with_packages()
        config.find_repository.return_value.effective_release_type = "nx"
        result, run_pf = _invoke_preflight(config)

        assert result.exit_code == 0
        assert "✓ Dependabot alerts: open 0" in result.output
        assert "=== Preflight Check Passed ===" in result.output
        run_pf.assert_not_called()

    def test_github_auth_error_exits_without_traceback(self) -> None:
        config = _alert_config()
        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.origin_repo",
                return_value=("ghes.example.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=config),
            patch(
                "cli.commands.release.GitHubClient",
                side_effect=GitHubAuthError("トークンが見つかりません"),
            ),
        ):
            result = runner.invoke(app, ["release", "preflight"])

        assert result.exit_code == 1
        assert "エラー: トークンが見つかりません" in result.stderr
        assert "Preflight Check Passed" not in result.output
