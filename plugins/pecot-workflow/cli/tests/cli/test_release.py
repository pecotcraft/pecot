"""tests/cli/test_release.py - release コマンドのテスト

release preflight / release create / release merge コマンドのCLIテスト。
core関数をモックして検証する。
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
import pytest
import typer.testing

from cli.commands.main import app
from cli.core.dependabot import DependabotAlertError, DependabotAlertStatus, OpenAlert
from cli.core.github import GitHubAuthError
from cli.core.release import PreflightResult, ReleaseError
from cli.core.repo_resolver import RepoRef
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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.primary_remote_name", return_value="origin"),
            patch("cli.commands.release.run_preflight", return_value=preflight_result),
        ):
            result = runner.invoke(app, ["release", "preflight"])

        assert result.exit_code == 0
        assert result.stdout == "version: 0.6.1\ntag: v0.6.1\n\n### 追加\n\n- 新機能\n"
        assert (
            "count: commits to release (origin/develop-aist -> origin/main): 5\n" in result.stderr
        )

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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.primary_remote_name", return_value="origin"),
            patch("cli.commands.release.run_preflight", return_value=preflight_result),
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1"])

        assert result.exit_code == 0
        assert result.stdout.startswith("version: 0.6.1\ntag: v0.6.1\n")
        assert (
            "count: commits to release (origin/develop-aist -> origin/main): 3\n" in result.stderr
        )

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
                "cli.commands.release.primary_remote_repo",
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
                "cli.commands.release.primary_remote_repo",
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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.primary_remote_name", return_value="origin"),
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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["release", "create", "0.6.1"])

        assert result.exit_code == 0
        assert "created: release v0.6.1 on main\n" in result.stderr
        assert result.stdout == "https://ghes.example.com/owner/repo/releases/tag/v0.6.1\n"

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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "create", "0.6.1", "--dry-run"])

        assert result.exit_code == 0
        assert "dry-run: would create release v0.6.1 on main\n" in result.stderr
        assert result.stdout == "### 追加\n\n- 新機能\n"

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
                "cli.commands.release.primary_remote_repo",
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
                "cli.commands.release.primary_remote_repo",
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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.primary_remote_name", return_value="origin"),
            patch("cli.commands.release.run_preflight", return_value=preflight_result) as mock_pf,
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1"])

        assert result.exit_code == 0
        # tag_prefix=None で呼ばれる
        assert mock_pf.call_args.kwargs["tag_prefix"] is None
        assert mock_pf.call_args.kwargs["remote"] == "origin"

    def test_non_origin_remote_is_used(self) -> None:
        """origin が無く別名の remote だけのとき、その remote とリポを対象にする"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"
        mock_config.find_repository.return_value.changelog_file = None
        mock_config.find_repository.return_value.packages = None
        preflight_result = PreflightResult(
            version="0.6.1",
            release_notes="notes",
            develop_branch="develop-aist",
            release_branch="main",
            diff_count=2,
            tag_name="v0.6.1",
        )

        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "up-owner", "up-repo"),
            ),
            patch("cli.commands.release.primary_remote_name", return_value="upstream"),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.run_preflight", return_value=preflight_result) as mock_pf,
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1"])

        assert result.exit_code == 0
        assert mock_pf.call_args.kwargs["remote"] == "upstream"
        assert "commits to release (upstream/develop-aist -> upstream/main): 2" in result.stderr
        mock_config.get_develop_branch.assert_called_with("up-owner", "up-repo")

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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app, ["release", "preflight", "0.6.1", "--package", "pecot-workflow"]
            )

        assert result.exit_code == 1
        assert "error: owner/repo has no packages configured" in result.stderr

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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1"])

        assert result.exit_code == 1
        assert "specify --package (available: pecot-workflow, pecot-visual)" in result.stderr

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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
            patch("cli.commands.release.primary_remote_name", return_value="origin"),
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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "preflight", "0.6.1", "--package", "unknown"])

        assert result.exit_code == 1
        assert "package 'unknown' is not registered in owner/repo" in result.stderr


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
                "cli.commands.release.primary_remote_repo",
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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["release", "create", "0.6.1"])

        assert result.exit_code == 1
        assert "specify --package (available: pecot-workflow, pecot-visual)" in result.stderr

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
                "cli.commands.release.primary_remote_repo",
                return_value=("github.com", "owner", "repo"),
            ),
            patch("cli.commands.release.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app, ["release", "create", "0.6.1", "--package", "pecot-workflow"]
            )

        assert result.exit_code == 1
        assert "error: owner/repo has no packages configured" in result.stderr


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
        assert "merged: PR owner/repo/100 (develop-aist -> main, merge commit)\n" in result.stderr
        mock_client.merge_pull_request.assert_called_once_with(
            "owner", "repo", 100, merge_method="merge"
        )

    def test_repo_mismatch_is_rejected(self) -> None:
        """--repo が現在の remote と食い違うと、GitHub を呼ばず終了コード 1 で拒否する"""
        mock_client = MagicMock()
        with (
            patch("cli.commands.release.load_active_config", return_value=_mock_config()),
            patch("cli.commands.release.GitHubClient", return_value=mock_client),
            patch(
                "cli.core.repo_resolver._detect_current_git_repo",
                return_value=(RepoRef(owner="acme", repo="current"), "origin"),
            ),
        ):
            result = runner.invoke(
                app, ["--repo", "acme/other", "release", "merge", "owner/repo/100"]
            )
        assert result.exit_code == 1
        assert "differs from the current Git remote" in result.stderr
        mock_client.merge_pull_request.assert_not_called()

    def test_short_ref_points_to_full_form_only(self) -> None:
        """短い形の参照は、--repo を案内せずフル形式だけを案内する"""
        with patch("cli.commands.release.load_active_config", return_value=_mock_config()):
            result = runner.invoke(app, ["release", "merge", "100"])
        assert result.exit_code != 0
        assert "use the full form 'owner/repo/N'" in result.stderr
        assert "pass --repo" not in result.stderr

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
        assert (
            "dry-run: would merge PR owner/repo/100 (develop-aist -> main, merge commit)\n"
            in result.stderr
        )
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
        assert "error: PR #100 is already merged" in result.stderr

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
        assert "error: PR #100 is closed" in result.stderr

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
        assert "error: PR #100 has conflicts that must be resolved" in result.stderr

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
        assert "merged: PR owner/repo/100 (develop-aist -> main, merge commit)\n" in result.stderr

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
        assert "deleted: remote branch develop-aist in owner/repo\n" in result.stderr
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
        assert "warning: deleting remote branch develop-aist failed: 削除失敗\n" in result.stderr
        assert "warning" not in result.stdout

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
    code_scanning: ScanAlertStatus | Exception | None = None,
    secret_scanning: ScanAlertStatus | Exception | None = None,
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
        patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
        patch(
            "cli.commands.release.primary_remote_repo",
            return_value=("ghes.example.com", "owner", "repo"),
        ),
        patch("cli.commands.release.load_active_config", return_value=config),
        patch("cli.commands.release.GitHubClient"),
        patch("cli.commands.release.fetch_dependabot_alert_status", fetch),
        patch("cli.commands.release.primary_remote_name", return_value="origin"),
        patch("cli.commands.release.run_preflight", run_pf),
    ):
        result = runner.invoke(app, ["release", "preflight", *(args or [])])
    return result, run_pf


class TestReleasePreflightScanning:
    """code scanning・secret scanning の open の alert でも preflight が止まる"""

    def test_all_zero_passes_and_shows_three_lines(self) -> None:
        result, run_pf = _invoke_preflight(_alert_config())

        assert result.exit_code == 0
        assert "count: open Dependabot alerts: 0\n" in result.stderr
        assert "count: open code scanning alerts: 0\n" in result.stderr
        assert "count: open secret scanning alerts: 0\n" in result.stderr
        run_pf.assert_called_once()

    def test_open_code_scanning_fails_with_numbers(self) -> None:
        status = ScanAlertStatus(
            enabled=True, open_count=1, alerts_url="https://x/cs", open_numbers=[10]
        )
        result, run_pf = _invoke_preflight(_alert_config(), code_scanning=status)

        assert result.exit_code == 1
        assert (
            "error: code scanning has 1 open alert\n"
            "  #10\n"
            "  → https://x/cs\n"
            "  close them (fixed, or dismissed with a reason) and run again\n"
        ) in result.stderr
        assert result.stdout == ""
        run_pf.assert_not_called()

    def test_disabled_scanning_passes(self) -> None:
        off = ScanAlertStatus(enabled=False, open_count=0, alerts_url="https://x/s")
        result, _ = _invoke_preflight(_alert_config(), code_scanning=off, secret_scanning=off)

        assert result.exit_code == 0
        assert "skipped: code scanning (feature disabled)\n" in result.stderr
        assert "skipped: secret scanning (feature disabled)\n" in result.stderr

    def test_all_three_are_checked_before_exit(self) -> None:
        """Dependabot の警告があっても、残りの 2 種の結果まで表示してから終える"""
        bad = ScanAlertStatus(
            enabled=True, open_count=2, alerts_url="https://x/ss", open_numbers=[3, 4]
        )
        result, _ = _invoke_preflight(
            _alert_config(),
            status=_alert_status(open_count=1, max_severity="high"),
            secret_scanning=bad,
        )

        assert result.exit_code == 1
        assert "warning: 1 open Dependabot alert (highest severity: high)" in result.stderr
        assert "count: open code scanning alerts: 0\n" in result.stderr
        assert "error: secret scanning has 2 open alerts\n" in result.stderr

    def test_undeterminable_scanning_fails(self) -> None:
        result, run_pf = _invoke_preflight(
            _alert_config(), secret_scanning=SecurityAlertError("権限不足")
        )

        assert result.exit_code == 1
        assert "error: could not check secret scanning: 権限不足\n" in result.stderr
        run_pf.assert_not_called()

    def test_network_error_does_not_skip_remaining_checks(self) -> None:
        """通信エラーでも残りの種類を確かめてから exit 1（traceback で終わらない）"""
        result, run_pf = _invoke_preflight(
            _alert_config(), code_scanning=httpx.ConnectError("down")
        )

        assert result.exit_code == 1
        assert "Traceback" not in result.output
        assert "error: could not check alerts: down\n" in result.stderr
        assert "count: open Dependabot alerts: 0\n" in result.stderr
        assert "count: open secret scanning alerts: 0\n" in result.stderr
        run_pf.assert_not_called()

    def test_nx_also_checks_scanning(self) -> None:
        bad = ScanAlertStatus(enabled=True, open_count=1, alerts_url="u", open_numbers=[1])
        result, _ = _invoke_preflight(_alert_config(release_type="nx"), code_scanning=bad)

        assert result.exit_code == 1


class TestReleasePreflightDependabot:
    """open の Dependabot alert は警告だけで、preflight を止めない"""

    def test_open_alerts_warn_and_pass(self) -> None:
        status = _alert_status(
            open_count=2,
            max_severity="medium",
            open_alerts=[
                OpenAlert(number=14, package="glob", severity="medium"),
                OpenAlert(number=15, package="minimatch", severity="medium"),
            ],
        )
        result, run_pf = _invoke_preflight(_alert_config(), status=status)

        assert result.exit_code == 0
        assert (
            "warning: 2 open Dependabot alerts (highest severity: medium). "
            "The release is not blocked.\n"
            "  #14 (glob, medium)\n"
            "  #15 (minimatch, medium)\n"
            f"  → {ALERTS_URL}\n"
        ) in result.stderr
        assert result.stdout.startswith("version: 0.6.1\n")
        run_pf.assert_called_once()

    def test_single_alert_uses_singular_and_omits_missing_fields(self) -> None:
        status = _alert_status(
            open_count=1,
            max_severity=None,
            open_alerts=[
                OpenAlert(number=3, package=None, severity=None),
            ],
        )
        result, _ = _invoke_preflight(_alert_config(), status=status)

        assert result.exit_code == 0
        assert "warning: 1 open Dependabot alert. The release is not blocked." in result.stderr
        assert "\n  #3\n" in result.stderr

    def test_label_uses_only_the_present_value(self) -> None:
        status = _alert_status(
            open_count=2,
            max_severity="high",
            open_alerts=[
                OpenAlert(number=4, package="glob", severity=None),
                OpenAlert(number=5, package=None, severity="high"),
            ],
        )
        result, _ = _invoke_preflight(_alert_config(), status=status)

        assert result.exit_code == 0
        assert "  #4 (glob)\n" in result.stderr
        assert "  #5 (high)\n" in result.stderr

    def test_open_alerts_do_not_hide_code_scanning_failure(self) -> None:
        bad = ScanAlertStatus(enabled=True, open_count=1, alerts_url="u", open_numbers=[10])
        result, run_pf = _invoke_preflight(
            _alert_config(),
            status=_alert_status(open_count=1, max_severity="high"),
            code_scanning=bad,
        )

        assert result.exit_code == 1
        assert "warning: 1 open Dependabot alert" in result.stderr
        assert "error: code scanning has 1 open alert" in result.stderr
        run_pf.assert_not_called()

    def test_zero_alerts_pass(self) -> None:
        result, run_pf = _invoke_preflight(_alert_config())

        assert result.exit_code == 0
        assert "count: open Dependabot alerts: 0\n" in result.stderr
        assert result.stdout.startswith("version: 0.6.1\n")
        run_pf.assert_called_once()

    def test_alerts_disabled_pass(self) -> None:
        result, _ = _invoke_preflight(_alert_config(), status=_alert_status(enabled=False))

        assert result.exit_code == 0
        assert "skipped: Dependabot alerts (feature disabled)\n" in result.stderr
        assert result.stdout.startswith("version: 0.6.1\n")

    @pytest.mark.parametrize(
        "reason",
        [
            "owner/repo: Dependabot alerts は有効ですが一覧を取得できません（権限不足の可能性）",
            "owner/repo: GitHub APIエラー: 500",
            "owner/repo: 認証に失敗しました (401)",
            "owner/repo: 通信に失敗しました: down",
        ],
    )
    def test_alert_error_warns_and_passes(self, reason: str) -> None:
        result, run_pf = _invoke_preflight(
            _alert_config(), alert_error=DependabotAlertError(reason)
        )

        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        assert "warning: could not check Dependabot alerts. The release is not blocked." in lines
        assert f"  reason: {reason}" in lines
        assert "count: open code scanning alerts: 0" in lines
        assert result.stdout.startswith("version: 0.6.1\n")
        run_pf.assert_called_once()

    def test_github_api_error_warns_and_passes(self) -> None:
        result, _ = _invoke_preflight(_alert_config(), alert_error=GitHubAuthError("bad token"))

        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        assert "warning: could not check Dependabot alerts. The release is not blocked." in lines
        assert "  reason: bad token" in lines

    def test_reason_uses_first_line_without_trailing_period(self) -> None:
        result, _ = _invoke_preflight(
            _alert_config(), alert_error=GitHubAuthError("authentication failed.\n1. gh auth login")
        )

        lines = result.stderr.splitlines()
        assert "  reason: authentication failed" in lines
        assert not any("gh auth login" in line for line in lines)

    def test_release_branch_unset_fails_after_alert_line(self) -> None:
        result, _ = _invoke_preflight(_alert_config(release_branch=None))

        assert result.exit_code == 1
        assert "count: open Dependabot alerts: 0\n" in result.stderr
        assert (
            "error: release_branch is not set for owner/repo\n"
            "  set it with: pecot project set-repo owner/repo --release-branch <branch>\n"
        ) in result.stderr


class TestReleasePreflightNx:
    """release_type: nx は alert の確認だけを行う"""

    def test_nx_checks_alerts_only(self) -> None:
        result, run_pf = _invoke_preflight(_alert_config(release_type="nx"))

        assert result.exit_code == 0
        assert "count: open Dependabot alerts: 0\n" in result.stderr
        assert result.stdout == ""
        run_pf.assert_not_called()

    def test_nx_open_dependabot_alerts_warn_and_pass(self) -> None:
        result, _ = _invoke_preflight(
            _alert_config(release_type="nx"),
            status=_alert_status(open_count=1, max_severity="critical"),
        )

        assert result.exit_code == 0
        assert "warning: 1 open Dependabot alert (highest severity: critical)" in result.stderr
        assert result.stdout == ""

    def test_nx_rejects_version(self) -> None:
        result, run_pf = _invoke_preflight(_alert_config(release_type="nx"), ["1.0.0"])

        assert result.exit_code == 1
        assert "error: the version argument and --package cannot be used" in result.stderr
        assert result.stdout == ""
        run_pf.assert_not_called()

    def test_nx_rejects_package(self) -> None:
        config = _alert_config(release_type="nx")
        # packages 設定ありの nx リポに --package で向けても拒否される
        config.find_repository.return_value = _mock_repo_with_packages()
        config.find_repository.return_value.effective_release_type = "nx"
        result, run_pf = _invoke_preflight(config, ["--package", "pecot-workflow"])

        assert result.exit_code == 1
        assert "error: the version argument and --package cannot be used" in result.stderr
        assert "is a monorepo" not in result.stderr
        run_pf.assert_not_called()

    def test_nx_with_packages_passes_without_arguments(self) -> None:
        config = _alert_config(release_type="nx")
        config.find_repository.return_value = _mock_repo_with_packages()
        config.find_repository.return_value.effective_release_type = "nx"
        result, run_pf = _invoke_preflight(config)

        assert result.exit_code == 0
        assert "count: open Dependabot alerts: 0\n" in result.stderr
        assert result.stdout == ""
        run_pf.assert_not_called()

    def test_github_auth_error_exits_without_traceback(self) -> None:
        config = _alert_config()
        with (
            patch("cli.commands.release.git_toplevel", return_value=Path("/repo")),
            patch(
                "cli.commands.release.primary_remote_repo",
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
        assert "Traceback" not in result.output
        assert "  reason: トークンが見つかりません" in result.stderr.splitlines()
        assert "error: could not check alerts: トークンが見つかりません\n" in result.stderr
        assert result.stdout == ""
