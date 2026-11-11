"""tests/cli/test_project.py - project.pyのCLIテスト

project系サブコマンドのテスト。
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner, Result

from cli.commands.main import app
from cli.commands.project import _build_board_url, _build_repositories
from cli.core.config import Repository
from cli.core.dependabot import DependabotAlertError, DependabotAlertStatus
from cli.core.github import GitHubAPIError, GitHubNotFoundError

runner = CliRunner()


# project list コマンドテスト


class TestProjectListNewCommand:
    """project list コマンドのテスト"""

    def test_project_list_empty(self, tmp_path: Path) -> None:
        """プロジェクト設定がない場合"""
        with patch("cli.commands.project.get_projects_dir", return_value=tmp_path):
            result = runner.invoke(app, ["project", "list"])
            assert result.exit_code == 0
            assert result.stdout == "=== Projects ===\n  none\n"
            assert result.stderr == ""

    def test_project_list_multiple(self, tmp_path: Path) -> None:
        """複数プロジェクト設定がある場合"""
        # テスト用設定ファイル作成
        (tmp_path / "github.com_foo_bar.json").write_text("{}")
        (tmp_path / "ghes.example.com_test_proj.json").write_text("{}")

        with (
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.get_active_config_path", return_value=None),
        ):
            result = runner.invoke(app, ["project", "list"])
            assert result.exit_code == 0
            assert "github.com_foo_bar" in result.output
            assert "ghes.example.com_test_proj" in result.output

    def test_project_list_outputs_in_filename_order(self, tmp_path: Path) -> None:
        """名前の順と違う順に作った設定ファイルが、ファイル名の順に 1 行ずつ出る"""
        for name in ("github.com_c_proj", "github.com_a_proj", "github.com_b_proj"):
            (tmp_path / f"{name}.json").write_text("{}")

        with (
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.get_active_config_path", return_value=None),
        ):
            result = runner.invoke(app, ["project", "list"])

        assert result.exit_code == 0
        assert result.stdout == (
            "=== Projects ===\n  github.com_a_proj\n  github.com_b_proj\n  github.com_c_proj\n"
        )

    def test_project_list_with_active_marker(self, tmp_path: Path) -> None:
        """アクティブマーカー表示"""
        config_file = tmp_path / "github.com_active_proj.json"
        config_file.write_text("{}")
        (tmp_path / "github.com_other_proj.json").write_text("{}")

        with (
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.get_active_config_path", return_value=config_file),
        ):
            result = runner.invoke(app, ["project", "list"])
            assert result.exit_code == 0
            assert "[ACTIVE]" in result.output
            assert "github.com_active_proj" in result.output


# set-repo コマンドテスト


class TestSetRepoCommand:
    """project set-repo コマンドのテスト"""

    def test_set_repo_no_config(self) -> None:
        """アクティブ設定がない場合はエラー"""
        with patch("cli.commands.project.load_active_config", return_value=None):
            result = runner.invoke(app, ["project", "set-repo", "owner/repo"])
            assert result.exit_code == 1
            assert result.stdout == ""
            assert result.stderr == (
                "error: no active project\n  run: pecot project activate <PROJECT>\n"
            )

    def test_set_repo_invalid_format(self) -> None:
        """owner/repo形式でない場合はエラー"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"

        with patch("cli.commands.project.load_active_config", return_value=mock_config):
            # owner/repo形式でない
            result = runner.invoke(app, ["project", "set-repo", "invalid"])
            assert result.exit_code == 1
            assert result.stderr == (
                "error: give the repository as owner/repo\n"
                "  example: pecot project set-repo example-org/my-repo\n"
            )

    def test_set_repo_owner_mismatch(self) -> None:
        """リポジトリオーナーとプロジェクトオーナーが異なる場合はエラー"""
        mock_config = MagicMock()
        mock_config.owner = "project-owner"

        with patch("cli.commands.project.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["project", "set-repo", "different-owner/repo"])
            assert result.exit_code == 1
            assert result.stderr == (
                "error: repository owner different-owner differs from project owner "
                "project-owner\n"
                "  GitHub Projects V2 links only repositories of the project owner\n"
            )

    def test_set_repo_new_add(self, tmp_path: Path) -> None:
        """新規リポジトリ追加（リンク成功時）"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.host = "ghes.example.com"
        mock_config.project.number = 1
        mock_config.repositories = []
        mock_config.find_repository.return_value = None

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch(
                "cli.commands.project._link_project_repository",
                return_value=("linked", ""),
            ),
            patch("cli.commands.project.save_config") as mock_save,
        ):
            result = runner.invoke(
                app, ["project", "set-repo", "test-owner/new-repo", "--develop-branch", "main"]
            )
            assert result.exit_code == 0
            assert result.stdout == ""
            assert result.stderr == (
                "added: test-owner/new-repo to project #1\n"
                f"added: test-owner/new-repo to {mock_config_path}\n"
            )
            mock_save.assert_called_once()

    def test_set_repo_link_failure(self, tmp_path: Path) -> None:
        """新規リポジトリ追加時にリンク失敗した場合はエラー"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.host = "ghes.example.com"
        mock_config.project.number = 1
        mock_config.repositories = []
        mock_config.find_repository.return_value = None

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch(
                "cli.commands.project._link_project_repository",
                return_value=("failed", "Repository not found"),
            ),
            patch("cli.commands.project.save_config") as mock_save,
        ):
            result = runner.invoke(app, ["project", "set-repo", "test-owner/nonexistent-repo"])
            assert result.exit_code == 1
            assert result.stderr == (
                "error: could not link test-owner/nonexistent-repo to project #1: "
                "Repository not found\n"
            )
            mock_save.assert_not_called()

    def test_set_repo_update_existing(self, tmp_path: Path) -> None:
        """既存リポジトリのdevelop_branch更新"""
        mock_repo = MagicMock()
        mock_repo.owner = "test-owner"
        mock_repo.name = "existing-repo"
        mock_repo.develop_branch = "old-branch"

        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.repositories = [mock_repo]
        mock_config.find_repository.return_value = mock_repo

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch("cli.commands.project.save_config") as mock_save,
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "set-repo",
                    "test-owner/existing-repo",
                    "--develop-branch",
                    "new-branch",
                ],
            )
            assert result.exit_code == 0
            assert result.stdout == ""
            assert result.stderr == f"updated: test-owner/existing-repo in {mock_config_path}\n"
            mock_save.assert_called_once()

    def test_set_repo_default_develop_branch(self, tmp_path: Path) -> None:
        """--develop-branchを指定しない場合はNone"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.host = "ghes.example.com"
        mock_config.project.number = 1
        mock_config.repositories = []
        mock_config.find_repository.return_value = None

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch(
                "cli.commands.project._link_project_repository",
                return_value=("linked", ""),
            ),
            patch("cli.commands.project.save_config") as mock_save,
        ):
            result = runner.invoke(app, ["project", "set-repo", "test-owner/repo"])
            assert result.exit_code == 0
            mock_save.assert_called_once()

    def test_set_repo_with_packages_new(self, tmp_path: Path) -> None:
        """--package 複数指定で新規リポ追加"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.host = "ghes.example.com"
        mock_config.project.number = 1
        mock_config.repositories = []
        mock_config.find_repository.return_value = None

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch(
                "cli.commands.project._link_project_repository",
                return_value=(True, "linked"),
            ),
            patch("cli.commands.project.save_config") as mock_save,
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "set-repo",
                    "test-owner/monorepo",
                    "--package",
                    "foo:packages/foo/CHANGELOG.md",
                    "--package",
                    "bar:packages/bar/CHANGELOG.md",
                ],
            )
            assert result.exit_code == 0
            mock_save.assert_called_once()
            # config.repositories に Repository が append されたことを確認
            added_repo = mock_config.repositories[0]
            assert added_repo.packages is not None
            assert len(added_repo.packages) == 2
            assert added_repo.packages[0].name == "foo"
            assert added_repo.packages[0].changelog == "packages/foo/CHANGELOG.md"
            assert added_repo.packages[1].name == "bar"
            assert added_repo.changelog_file is None

    def test_set_repo_package_invalid_format(self) -> None:
        """--package が NAME:PATH 形式でない場合はエラー"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        with patch("cli.commands.project.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                ["project", "set-repo", "test-owner/repo", "--package", "nocolonhere"],
            )
            assert result.exit_code == 1
            assert "NAME:PATH" in result.output

    def test_set_repo_package_with_changelog_file_exclusive(self) -> None:
        """--package と --changelog-file の同時指定はエラー"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        with patch("cli.commands.project.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                [
                    "project",
                    "set-repo",
                    "test-owner/repo",
                    "--package",
                    "foo:FOO.md",
                    "--changelog-file",
                    "CHANGELOG.md",
                ],
            )
            assert result.exit_code == 1
            assert (
                result.stderr == "error: --package and --changelog-file cannot be used together\n"
            )

    def test_set_repo_package_duplicate_name(self) -> None:
        """--package の NAME 重複はエラー"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        with patch("cli.commands.project.load_active_config", return_value=mock_config):
            result = runner.invoke(
                app,
                [
                    "project",
                    "set-repo",
                    "test-owner/repo",
                    "--package",
                    "foo:A.md",
                    "--package",
                    "foo:B.md",
                ],
            )
            assert result.exit_code == 1
            assert result.stderr == "error: --package NAME is duplicated: 'foo'\n"

    def test_set_repo_clear_packages(self, tmp_path: Path) -> None:
        """--clear-packages で既存 packages を削除"""
        mock_repo = MagicMock()
        mock_repo.owner = "test-owner"
        mock_repo.name = "existing"
        mock_repo.packages = [MagicMock(name="pecot")]

        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.repositories = [mock_repo]
        mock_config.find_repository.return_value = mock_repo

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch("cli.commands.project.save_config"),
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "set-repo",
                    "test-owner/existing",
                    "--clear-packages",
                ],
            )
            assert result.exit_code == 0
            assert mock_repo.packages is None


# _link_project_repository 関数テスト


class TestLinkProjectRepository:
    """_link_project_repository 関数のテスト（GraphQL版）"""

    def test_link_success(self) -> None:
        """リンク成功"""
        mock_client = MagicMock()
        mock_client.link_repository_to_project.return_value = ("linked", "")

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            from cli.commands.project import _link_project_repository

            outcome, detail = _link_project_repository("ghes.example.com", 1, "owner", "owner/repo")
            assert outcome == "linked"
            assert detail == ""
            mock_client.link_repository_to_project.assert_called_once_with(
                "owner", 1, "owner", "repo"
            )

    def test_link_already_linked(self) -> None:
        """既にリンク済み"""
        mock_client = MagicMock()
        mock_client.link_repository_to_project.return_value = (
            "already_linked",
            "already linked",
        )

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            from cli.commands.project import _link_project_repository

            outcome, detail = _link_project_repository("github.com", 1, "owner", "owner/repo")
            assert outcome == "already_linked"
            assert detail == "already linked"

    def test_link_failure(self) -> None:
        """リンク失敗"""
        mock_client = MagicMock()
        mock_client.link_repository_to_project.return_value = ("failed", "Repository not found")

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            from cli.commands.project import _link_project_repository

            outcome, detail = _link_project_repository("github.com", 1, "owner", "owner/repo")
            assert outcome == "failed"
            assert detail == "Repository not found"

    def test_link_api_error(self) -> None:
        """GitHubAPIErrorが発生した場合"""
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.link_repository_to_project.side_effect = GitHubAPIError("API Error")

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            from cli.commands.project import _link_project_repository

            outcome, detail = _link_project_repository("github.com", 1, "owner", "owner/repo")
            assert outcome == "failed"
            assert detail == "API Error"

    def test_link_repo_name_without_owner(self) -> None:
        """repo名にownerが含まれない場合"""
        mock_client = MagicMock()
        mock_client.link_repository_to_project.return_value = ("linked", "")

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            from cli.commands.project import _link_project_repository

            outcome, _detail = _link_project_repository("github.com", 1, "owner", "repo")
            assert outcome == "linked"
            # owner引数がrepo_ownerとして使われる
            mock_client.link_repository_to_project.assert_called_once_with(
                "owner", 1, "owner", "repo"
            )


# _slugify ヘルパー関数テスト


class TestBuildBoardUrl:
    """_build_board_url のテスト（GitHub API の値を使い、推測しない）"""

    FILTER = (
        "%20pecot-workflow-acme%3APending%2CBacklog%2CReady%2CActive%2CArchived%2C%22In%20Review%22"
    )

    def _field(self, field_id: str, database_id: int | None) -> dict[str, Any]:
        field: dict[str, Any] = {"id": field_id, "name": "pecot-workflow-acme"}
        if database_id is not None:
            field["databaseId"] = database_id
        return field

    def test_orgs_url_with_new_format_id(self) -> None:
        """orgs URL と新形式 ID でも databaseId を使って layout=board を付ける"""
        url = _build_board_url(
            "https://github.com/orgs/pecotcraft/projects/1",
            self._field("PVTSSF_lADOFO6i_s4BpvQezhoJc_g", 436827128),
            1,
        )
        assert url == (
            "https://github.com/orgs/pecotcraft/projects/1/views/1"
            "?layout=board&verticalGroupedBy%5BcolumnId%5D=436827128"
            f"&filterQuery={self.FILTER}"
        )

    def test_users_url_with_old_format_id(self) -> None:
        """users URL と旧形式 ID でも databaseId を使う"""
        url = _build_board_url(
            "https://ghes.example.com/users/acme-labs/projects/1",
            self._field("MDI2OlByb2plY3RWMlNpbmdsZVNlbGVjdEZpZWxkODA2NjE=", 80661),
            1,
        )
        assert url == (
            "https://ghes.example.com/users/acme-labs/projects/1/views/1"
            "?layout=board&verticalGroupedBy%5BcolumnId%5D=80661"
            f"&filterQuery={self.FILTER}"
        )

    def test_without_database_id(self) -> None:
        """databaseId が無いときは layout と views を付けない"""
        url = _build_board_url(
            "https://github.com/orgs/pecotcraft/projects/1",
            self._field("MDI2OlByb2plY3RWMlNpbmdsZVNlbGVjdEZpZWxkODA2NjE=", None),
            1,
        )
        assert url == f"https://github.com/orgs/pecotcraft/projects/1?filterQuery={self.FILTER}"
        assert "layout" not in url
        assert "/views/" not in url

    def test_without_view_number(self) -> None:
        """ビュー番号が無いときは layout と views を付けない"""
        url = _build_board_url(
            "https://github.com/orgs/pecotcraft/projects/1",
            self._field("PVTSSF_lADOFO6i_s4BpvQezhoJc_g", 436827128),
            None,
        )
        assert url == f"https://github.com/orgs/pecotcraft/projects/1?filterQuery={self.FILTER}"
        assert "layout" not in url
        assert "/views/" not in url


class TestBuildRepositories:
    """_build_repositories の並びとメタ引き継ぎのテスト"""

    def test_keeps_existing_order_drops_unlinked_appends_new(self) -> None:
        """既存設定の順を保ち、リンクが外れたものは落とし、新規は末尾に足す"""
        existing = {
            "o/A": Repository(owner="o", name="A", develop_branch="dev-a"),
            "o/B": Repository(owner="o", name="B", develop_branch="dev-b"),
            "o/C": Repository(owner="o", name="C", develop_branch="dev-c", release_branch="main"),
        }
        linked = [
            {"owner": "o", "name": "C"},
            {"owner": "o", "name": "A"},
            {"owner": "o", "name": "D"},
        ]

        result = _build_repositories(linked, existing)

        assert [r.name for r in result] == ["A", "C", "D"]
        assert result[0].develop_branch == "dev-a"
        assert result[1].develop_branch == "dev-c"
        assert result[1].release_branch == "main"
        assert result[2].develop_branch is None


class TestSlugify:
    """_slugify ヘルパー関数のテスト"""

    def test_slugify_basic(self) -> None:
        """基本的なslug化"""
        from cli.commands.project import _slugify

        assert _slugify("AI Starter Kit Development") == "ai-starter-kit-development"

    def test_slugify_special_chars(self) -> None:
        """特殊文字を含む場合"""
        from cli.commands.project import _slugify

        assert _slugify("Project (Test) #1") == "project-test-1"

    def test_slugify_already_lowercase(self) -> None:
        """既に小文字の場合"""
        from cli.commands.project import _slugify

        assert _slugify("simple-project") == "simple-project"

    def test_slugify_japanese(self) -> None:
        """日本語を含む場合（除去される）"""
        from cli.commands.project import _slugify

        assert _slugify("テスト Project") == "-project"


# _validate_workflow_field ヘルパー関数テスト


class TestValidateWorkflowField:
    """_validate_workflow_field ヘルパー関数のテスト"""

    def test_valid_workflow_field(self) -> None:
        """有効なpecot-workflowフィールド"""
        from cli.commands.project import _validate_workflow_field

        fields = [
            {
                "name": "pecot-workflow-test",
                "id": "field-id",
                "options": [
                    {"name": "Backlog", "id": "opt1"},
                    {"name": "Pending", "id": "opt-pend"},
                    {"name": "Ready", "id": "opt2"},
                    {"name": "Active", "id": "opt3"},
                    {"name": "In Review", "id": "opt-ir"},
                    {"name": "Archived", "id": "opt4"},
                ],
            }
        ]
        workflow_field, missing = _validate_workflow_field(fields)
        assert workflow_field is not None
        assert workflow_field["name"] == "pecot-workflow-test"
        assert missing == []

    def test_missing_options(self) -> None:
        """オプションが不足している場合"""
        from cli.commands.project import _validate_workflow_field

        fields = [
            {
                "name": "pecot-workflow-test",
                "id": "field-id",
                "options": [
                    {"name": "Backlog", "id": "opt1"},
                    {"name": "Ready", "id": "opt2"},
                ],
            }
        ]
        workflow_field, missing = _validate_workflow_field(fields)
        assert workflow_field is not None
        assert set(missing) == {"Pending", "Active", "In Review", "Archived"}

    def test_no_workflow_field(self) -> None:
        """pecot-workflowフィールドがない場合"""
        from cli.commands.project import _validate_workflow_field

        fields = [
            {"name": "Status", "id": "status-id", "options": []},
            {"name": "Priority", "id": "priority-id", "options": []},
        ]
        workflow_field, missing = _validate_workflow_field(fields)
        assert workflow_field is None
        assert missing == []

    def test_workflow_without_options(self) -> None:
        """pecot-workflowフィールドはあるがoptionsがない場合"""
        from cli.commands.project import _validate_workflow_field

        fields = [{"name": "pecot-workflow-test", "id": "field-id"}]
        workflow_field, missing = _validate_workflow_field(fields)
        assert workflow_field is None

    def test_in_review_required(self) -> None:
        """In Reviewが必須オプションに含まれている"""
        from cli.commands.project import _validate_workflow_field

        fields = [
            {
                "name": "pecot-workflow-test",
                "id": "field-id",
                "options": [
                    {"name": "Backlog", "id": "opt1"},
                    {"name": "Ready", "id": "opt2"},
                    {"name": "Active", "id": "opt3"},
                    {"name": "Archived", "id": "opt4"},
                ],
            }
        ]
        workflow_field, missing = _validate_workflow_field(fields)
        assert workflow_field is not None
        assert set(missing) == {"Pending", "In Review"}


# WORKFLOW_FIELD_OPTIONS 定数テスト


class TestWorkflowFieldOptions:
    """WORKFLOW_FIELD_OPTIONS定数のテスト"""

    def test_contains_in_review(self) -> None:
        """In Reviewオプションが含まれている"""
        from cli.commands.project import WORKFLOW_FIELD_OPTIONS

        option_names = [opt["name"] for opt in WORKFLOW_FIELD_OPTIONS]
        assert "In Review" in option_names

    def test_in_review_position(self) -> None:
        """In ReviewはActiveとArchivedの間にある"""
        from cli.commands.project import WORKFLOW_FIELD_OPTIONS

        option_names = [opt["name"] for opt in WORKFLOW_FIELD_OPTIONS]
        active_idx = option_names.index("Active")
        in_review_idx = option_names.index("In Review")
        archived_idx = option_names.index("Archived")
        assert active_idx < in_review_idx < archived_idx

    def test_in_review_color(self) -> None:
        """In ReviewのカラーはYELLOW"""
        from cli.commands.project import WORKFLOW_FIELD_OPTIONS

        in_review = next(opt for opt in WORKFLOW_FIELD_OPTIONS if opt["name"] == "In Review")
        assert in_review["color"] == "YELLOW"


# project list コマンドテスト (GitHub API経由)


class TestProjectSearchCommand:
    """pecot project search コマンドのテスト"""

    def test_project_search_success(self) -> None:
        """正常にプロジェクト一覧を表示"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Project One", "url": "https://github.com/user/projects/1"},
            {"number": 2, "title": "Project Two", "url": "https://github.com/user/projects/2"},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(app, ["project", "search", "test-owner"])
            assert result.exit_code == 0
            assert result.stderr == ""
            assert result.stdout.startswith("=== Projects of test-owner (github.com) ===\n")
            assert "Title" in result.stdout
            assert "Project One" in result.stdout
            assert "Project Two" in result.stdout

    def test_project_search_with_host(self) -> None:
        """--hostオプション指定"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Enterprise Project", "url": "https://ghes.example.com/..."},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client) as mock_cls:
            result = runner.invoke(
                app, ["project", "search", "test-owner", "--host", "ghes.example.com"]
            )
            assert result.exit_code == 0
            mock_cls.assert_called_with(host="ghes.example.com")
            expected = "=== Projects of test-owner (ghes.example.com) ==="
            assert result.stdout.splitlines().count(expected) == 1

    def test_project_search_empty(self) -> None:
        """プロジェクトがない場合"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = []

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(app, ["project", "search", "test-owner"])
            assert result.exit_code == 1
            assert result.stdout == ""
            assert result.stderr == "error: no projects found for test-owner\n"

    def test_project_search_api_error(self) -> None:
        """GitHub APIエラー"""
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.list_projects.side_effect = GitHubAPIError("API Error", status_code=500)

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(app, ["project", "search", "test-owner"])
            assert result.exit_code == 1
            assert result.stdout == ""
            assert result.stderr == "error: could not list projects (status 500): API Error\n"

    def test_project_search_long_title_truncated(self) -> None:
        """長いタイトルは省略される"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {
                "number": 1,
                "title": "This is a very long project title that should be truncated",
                "url": "https://github.com/...",
            },
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(app, ["project", "search", "test-owner"])
            assert result.exit_code == 0
            assert "..." in result.output


# project init コマンドテスト


class TestProjectInitCommand:
    """pecot project init コマンドのテスト"""

    def test_init_success(self) -> None:
        """正常にpecot-workflow関連フィールドを作成"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "project-id-123", "url": "..."},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "project-id-123",
            "fields": {
                "nodes": [
                    {"name": "Status", "id": "status-id"},
                ]
            },
        }
        # 3フィールド分の作成結果を返す
        mock_client.create_project_field.side_effect = [
            {
                "id": "new-workflow-field-id",
                "name": "pecot-workflow-test",
                "options": [
                    {"id": "opt1", "name": "Backlog"},
                    {"id": "opt-pending", "name": "Pending"},
                    {"id": "opt2", "name": "Ready"},
                    {"id": "opt3", "name": "Active"},
                    {"id": "opt4", "name": "Archived"},
                ],
            },
            {"id": "new-priority-field-id", "name": "pecot-priority", "options": []},
            {"id": "new-size-field-id", "name": "pecot-size", "options": []},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "init", "test-owner", "Test Project", "--suffix", "test"]
            )
            assert result.exit_code == 0
            assert result.stdout == ""
            assert result.stderr == (
                "created: field pecot-workflow-test (ID: new-workflow-field-id)\n"
                "created: field pecot-priority (ID: new-priority-field-id)\n"
                "created: field pecot-size (ID: new-size-field-id)\n"
            )
            assert mock_client.create_project_field.call_count == 3

    def test_init_already_exists(self) -> None:
        """既にpecot-workflowフィールドが存在する場合はスキップ（priority/sizeは作成）"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "project-id-123", "url": "..."},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "project-id-123",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-test",
                        "id": "existing-workflow-id",
                        "options": [
                            {"name": "Backlog", "id": "opt1"},
                            {"name": "Pending", "id": "opt-pending"},
                            {"name": "Ready", "id": "opt2"},
                            {"name": "Active", "id": "opt3"},
                            {"name": "In Review", "id": "opt-ir"},
                            {"name": "Archived", "id": "opt4"},
                        ],
                    }
                ]
            },
        }

        # priority と size は作成される
        mock_client.create_project_field.side_effect = [
            {"id": "priority-id", "name": "pecot-priority", "options": []},
            {"id": "size-id", "name": "pecot-size", "options": []},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "init", "test-owner", "Test Project", "--suffix", "test"]
            )
            assert result.exit_code == 0
            assert result.stderr == (
                "skipped: field pecot-workflow-test (already exists)\n"
                "created: field pecot-priority (ID: priority-id)\n"
                "created: field pecot-size (ID: size-id)\n"
            )
            assert mock_client.create_project_field.call_count == 2

    def test_init_project_not_found(self) -> None:
        """プロジェクトが見つからない場合"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Other Project", "id": "...", "url": "..."},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "init", "test-owner", "Nonexistent", "--suffix", "test"]
            )
            assert result.exit_code == 1
            assert result.stdout == ""
            assert result.stderr == (
                "error: project not found: Nonexistent\n  available projects:\n  - Other Project\n"
            )

    def test_init_with_host_option(self) -> None:
        """--hostオプション指定"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Enterprise Project", "id": "project-id", "url": "..."},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "project-id",
            "fields": {"nodes": []},
        }
        # 3フィールド分
        mock_client.create_project_field.side_effect = [
            {"id": "workflow-id", "name": "pecot-workflow-test", "options": []},
            {"id": "priority-id", "name": "pecot-priority", "options": []},
            {"id": "size-id", "name": "pecot-size", "options": []},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client) as mock_cls:
            result = runner.invoke(
                app,
                [
                    "project",
                    "init",
                    "test-owner",
                    "Enterprise Project",
                    "--host",
                    "ghes.example.com",
                    "--suffix",
                    "test",
                ],
            )
            assert result.exit_code == 0
            mock_cls.assert_called_with(host="ghes.example.com")

    def test_init_api_error(self) -> None:
        """GitHub APIエラー"""
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.list_projects.side_effect = GitHubAPIError("API Error")

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "init", "test-owner", "Test Project", "--suffix", "test"]
            )
            assert result.exit_code == 1
            assert result.stderr == "error: could not initialize project fields: API Error\n"

    def test_init_field_creation_error(self) -> None:
        """フィールド作成時のAPIエラー"""
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "project-id", "url": "..."},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "project-id",
            "fields": {"nodes": []},
        }
        mock_client.create_project_field.side_effect = GitHubAPIError("Field creation failed")

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "init", "test-owner", "Test Project", "--suffix", "test"]
            )
            assert result.exit_code == 1
            assert result.stderr == (
                "error: could not initialize project fields: Field creation failed\n"
            )

    def test_init_creates_all_three_fields(self) -> None:
        """3フィールドすべて作成"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "project-id-123", "url": "..."},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "project-id-123",
            "fields": {"nodes": []},  # フィールドなし
        }

        # 3つのフィールド作成結果を返す
        mock_client.create_project_field.side_effect = [
            {"id": "workflow-id", "name": "pecot-workflow-test", "options": []},
            {"id": "priority-id", "name": "pecot-priority", "options": []},
            {"id": "size-id", "name": "pecot-size", "options": []},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "init", "test-owner", "Test Project", "--suffix", "test"]
            )
            assert result.exit_code == 0
            assert result.stderr == (
                "created: field pecot-workflow-test (ID: workflow-id)\n"
                "created: field pecot-priority (ID: priority-id)\n"
                "created: field pecot-size (ID: size-id)\n"
            )
            assert mock_client.create_project_field.call_count == 3

    def test_init_skips_existing_priority_field(self) -> None:
        """priorityフィールドが既存の場合はスキップ"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "project-id-123", "url": "..."},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "project-id-123",
            "fields": {
                "nodes": [
                    {"name": "pecot-priority", "id": "existing-priority-id"},
                ]
            },
        }

        # workflowとsizeのみ作成
        mock_client.create_project_field.side_effect = [
            {"id": "workflow-id", "name": "pecot-workflow-test", "options": []},
            {"id": "size-id", "name": "pecot-size", "options": []},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "init", "test-owner", "Test Project", "--suffix", "test"]
            )
            assert result.exit_code == 0
            assert result.stderr == (
                "created: field pecot-workflow-test (ID: workflow-id)\n"
                "skipped: field pecot-priority (already exists)\n"
                "created: field pecot-size (ID: size-id)\n"
            )
            assert mock_client.create_project_field.call_count == 2

    def test_init_skips_existing_size_field(self) -> None:
        """sizeフィールドが既存の場合はスキップ"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "project-id-123", "url": "..."},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "project-id-123",
            "fields": {
                "nodes": [
                    {"name": "pecot-size", "id": "existing-size-id"},
                ]
            },
        }

        # workflowとpriorityのみ作成
        mock_client.create_project_field.side_effect = [
            {"id": "workflow-id", "name": "pecot-workflow-test", "options": []},
            {"id": "priority-id", "name": "pecot-priority", "options": []},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "init", "test-owner", "Test Project", "--suffix", "test"]
            )
            assert result.exit_code == 0
            assert result.stderr == (
                "created: field pecot-workflow-test (ID: workflow-id)\n"
                "created: field pecot-priority (ID: priority-id)\n"
                "skipped: field pecot-size (already exists)\n"
            )
            assert mock_client.create_project_field.call_count == 2

    def test_init_all_fields_exist(self) -> None:
        """すべてのフィールドが既存の場合はすべてスキップ"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "project-id-123", "url": "..."},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "project-id-123",
            "fields": {
                "nodes": [
                    {"name": "pecot-workflow-test", "id": "existing-workflow-id"},
                    {"name": "pecot-priority", "id": "existing-priority-id"},
                    {"name": "pecot-size", "id": "existing-size-id"},
                ]
            },
        }

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "init", "test-owner", "Test Project", "--suffix", "test"]
            )
            assert result.exit_code == 0
            assert result.stderr == (
                "skipped: field pecot-workflow-test (already exists)\n"
                "skipped: field pecot-priority (already exists)\n"
                "skipped: field pecot-size (already exists)\n"
            )
            # フィールド作成は呼ばれない
            mock_client.create_project_field.assert_not_called()


# _has_field ヘルパー関数テスト


class TestHasField:
    """_has_field ヘルパー関数のテスト"""

    def test_has_field_exists(self) -> None:
        """フィールドが存在する場合"""
        from cli.commands.project import _has_field

        fields = [
            {"name": "pecot-workflow-test", "id": "workflow-id"},
            {"name": "pecot-priority", "id": "priority-id"},
        ]
        assert _has_field(fields, "pecot-workflow-test") is True
        assert _has_field(fields, "pecot-priority") is True

    def test_has_field_not_exists(self) -> None:
        """フィールドが存在しない場合"""
        from cli.commands.project import _has_field

        fields = [
            {"name": "pecot-workflow-test", "id": "workflow-id"},
        ]
        assert _has_field(fields, "pecot-priority") is False
        assert _has_field(fields, "pecot-size") is False

    def test_has_field_empty_list(self) -> None:
        """フィールドリストが空の場合"""
        from cli.commands.project import _has_field

        fields: list[dict] = []
        assert _has_field(fields, "pecot-workflow-test") is False


# project create コマンドテスト


class TestProjectCreateCommand:
    """pecot project create コマンドのテスト"""

    def test_create_success(self, tmp_path: Path) -> None:
        """正常にプロジェクト作成・init・syncを実行"""
        mock_client = MagicMock()
        # get_owner_node_id
        mock_client.get_owner_node_id.return_value = "U_owner123"
        # create_project
        mock_client.create_project.return_value = {
            "id": "PVT_new123",
            "number": 42,
            "title": "New Project",
            "url": "https://github.com/users/test-owner/projects/42",
        }
        # list_projects - 1回目（存在確認）: 空、2回目以降（init/sync）: プロジェクトあり
        list_call_count = [0]

        def list_projects_side_effect(owner: str, limit: int = 20) -> list:
            list_call_count[0] += 1
            if list_call_count[0] == 1:
                # create内での存在確認: まだ存在しない
                return []
            else:
                # init/sync内部での呼び出し: 作成済み
                return [{"number": 42, "title": "New Project", "id": "PVT_new123", "url": "..."}]

        mock_client.list_projects.side_effect = list_projects_side_effect

        # get_project_fields - init時は空、sync時はフィールドあり
        fields_call_count = [0]

        def get_project_fields_side_effect(owner: str, number: int) -> dict:
            fields_call_count[0] += 1
            if fields_call_count[0] == 1:
                # init呼び出し時: まだフィールドなし
                return {"id": "PVT_new123", "fields": {"nodes": []}}
            else:
                # sync呼び出し時: フィールド追加済み
                return {
                    "id": "PVT_new123",
                    "fields": {
                        "nodes": [
                            {
                                "name": "pecot-workflow-test",
                                "id": "MDI2OlByb2plY3RWMlNpbmdsZVNlbGVjdEZpZWxkMTIzNDU=",
                                "options": [
                                    {"name": "Backlog", "id": "opt1"},
                                    {"name": "Pending", "id": "opt-pending"},
                                    {"name": "Ready", "id": "opt2"},
                                    {"name": "Active", "id": "opt3"},
                                    {"name": "In Review", "id": "opt-ir"},
                                    {"name": "Archived", "id": "opt4"},
                                ],
                            }
                        ]
                    },
                }

        mock_client.get_project_fields.side_effect = get_project_fields_side_effect
        # create_project_field (init内部で呼ばれる)
        mock_client.create_project_field.return_value = {
            "id": "new-workflow-id",
            "name": "pecot-workflow-test",
            "options": [
                {"id": "opt1", "name": "Backlog"},
                {"id": "opt-pending", "name": "Pending"},
                {"id": "opt2", "name": "Ready"},
                {"id": "opt3", "name": "Active"},
                {"id": "opt4", "name": "Archived"},
            ],
        }
        # get_linked_repositories (create から呼ばれる _sync_project_config 内で使用)
        mock_client.get_linked_repositories.return_value = []

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.save_config") as mock_save,
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app, ["project", "create", "test-owner", "New Project", "--suffix", "test"]
            )
            assert result.exit_code == 0
            config_name = "github.com_test-owner_new-project_test"
            assert result.stdout == ""
            assert result.stderr == (
                "created: project #42 https://github.com/users/test-owner/projects/42\n"
                "created: field pecot-workflow-test (ID: new-workflow-id)\n"
                "created: field pecot-priority (ID: new-workflow-id)\n"
                "created: field pecot-size (ID: new-workflow-id)\n"
                f"created: config file {tmp_path / (config_name + '.json')}\n"
                f"set: active project to {config_name}\n"
            )
            mock_client.get_owner_node_id.assert_called_once_with("test-owner")
            mock_client.create_project.assert_called_once()
            mock_save.assert_called()

    def test_create_with_host(self, tmp_path: Path) -> None:
        """--hostオプション指定"""
        mock_client = MagicMock()
        mock_client.get_owner_node_id.return_value = "U_owner123"
        mock_client.create_project.return_value = {
            "id": "PVT_new123",
            "number": 1,
            "title": "Enterprise Project",
            "url": "https://ghes.example.com/users/test-owner/projects/1",
        }

        # list_projects - 1回目（存在確認）: 空、2回目以降（init/sync）: プロジェクトあり
        list_call_count = [0]

        def list_projects_side_effect(owner: str, limit: int = 20) -> list:
            list_call_count[0] += 1
            if list_call_count[0] == 1:
                return []  # 存在確認時: まだ存在しない
            else:
                return [
                    {"number": 1, "title": "Enterprise Project", "id": "PVT_new123", "url": "..."}
                ]

        mock_client.list_projects.side_effect = list_projects_side_effect

        # get_project_fields - init時は空、sync時はフィールドあり
        fields_call_count = [0]

        def get_project_fields_side_effect(owner: str, number: int) -> dict:
            fields_call_count[0] += 1
            if fields_call_count[0] == 1:
                return {"id": "PVT_new123", "fields": {"nodes": []}}
            else:
                return {
                    "id": "PVT_new123",
                    "fields": {
                        "nodes": [
                            {
                                "name": "pecot-workflow-test",
                                "id": "MDI2OlByb2plY3RWMlNpbmdsZVNlbGVjdEZpZWxkMTIzNDU=",
                                "options": [
                                    {"name": "Backlog", "id": "opt1"},
                                    {"name": "Pending", "id": "opt-pending"},
                                    {"name": "Ready", "id": "opt2"},
                                    {"name": "Active", "id": "opt3"},
                                    {"name": "In Review", "id": "opt-ir"},
                                    {"name": "Archived", "id": "opt4"},
                                ],
                            }
                        ]
                    },
                }

        mock_client.get_project_fields.side_effect = get_project_fields_side_effect
        mock_client.create_project_field.return_value = {
            "id": "new-workflow-id",
            "name": "pecot-workflow-test",
            "options": [
                {"id": "opt1", "name": "Backlog"},
                {"id": "opt-pending", "name": "Pending"},
                {"id": "opt2", "name": "Ready"},
                {"id": "opt3", "name": "Active"},
                {"id": "opt4", "name": "Archived"},
            ],
        }
        mock_client.get_linked_repositories.return_value = []

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client) as mock_cls,
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.save_config"),
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "create",
                    "test-owner",
                    "Enterprise Project",
                    "--host",
                    "ghes.example.com",
                    "--suffix",
                    "test",
                ],
            )
            assert result.exit_code == 0
            # GitHubClientが正しいhostで呼ばれたか
            calls = mock_cls.call_args_list
            assert any(call[1].get("host") == "ghes.example.com" for call in calls)

    def test_create_owner_not_found(self) -> None:
        """オーナーが見つからない場合"""
        mock_client = MagicMock()
        mock_client.get_owner_node_id.side_effect = GitHubNotFoundError(
            "オーナーが見つかりません: nonexistent"
        )

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "create", "nonexistent", "Project", "--suffix", "test"]
            )
            assert result.exit_code == 1
            assert result.stderr == "error: owner not found: nonexistent\n"

    def test_create_project_api_error(self) -> None:
        """プロジェクト作成時のAPIエラー"""
        mock_client = MagicMock()
        mock_client.get_owner_node_id.return_value = "U_owner123"
        mock_client.list_projects.return_value = []  # 存在確認時: なし
        mock_client.create_project.side_effect = GitHubAPIError("プロジェクト作成失敗")

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "create", "test-owner", "Project", "--suffix", "test"]
            )
            assert result.exit_code == 1
            assert result.stderr == "error: could not create project: プロジェクト作成失敗\n"

    def test_create_duplicate_title(self) -> None:
        """同名プロジェクトが既に存在する場合"""
        mock_client = MagicMock()
        mock_client.get_owner_node_id.return_value = "U_owner123"
        # list_projectsが同名プロジェクトを返す
        mock_client.list_projects.return_value = [
            {
                "number": 1,
                "title": "Existing Project",
                "id": "PVT_existing",
                "url": "https://github.com/users/test-owner/projects/1",
            }
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "create", "test-owner", "Existing Project", "--suffix", "test"]
            )
            assert result.exit_code == 1
            assert result.stderr == (
                "error: project already exists: Existing Project\n"
                "  url: https://github.com/users/test-owner/projects/1\n"
            )


# activate コマンドテスト


class TestActivateCommand:
    """project activate コマンドのテスト"""

    def test_activate_no_owner_uses_authenticated_user(self) -> None:
        """--owner 省略時は認証ユーザーを使用"""
        mock_client = MagicMock()
        mock_client.get_authenticated_user.return_value = {"login": "auth-user", "id": 123}
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "My Project", "id": "PVT_1"},
        ]
        mock_client.get_project_fields.return_value = {
            "fields": {"nodes": [{"name": "pecot-workflow-test", "id": "field-1"}]}
        }

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_active_config_path", return_value=None),
        ):
            result = runner.invoke(app, ["project", "activate", "--host", "github.com"])
            assert result.exit_code == 0
            assert result.stderr == ""
            assert result.stdout.startswith("=== Initialized projects (github.com/auth-user) ===\n")

    def test_activate_auth_error_shows_hint(self) -> None:
        """認証エラー時はヒントを表示"""
        mock_client = MagicMock()
        mock_client.get_authenticated_user.side_effect = GitHubAPIError("Auth failed")

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(app, ["project", "activate", "--host", "github.com"])
            assert result.exit_code == 1
            assert result.stdout == ""
            assert result.stderr == (
                "error: could not read the authenticated user: Auth failed\n"
                "  pass --owner to give the owner explicitly\n"
            )

    def test_activate_by_name_success(self, tmp_path: Path) -> None:
        """プロジェクト名でアクティベート成功"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "PVT_1"},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "url": "https://github.com/users/test-owner/projects/1",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-test",
                        "id": "field-1",
                        "options": [
                            {"id": "opt-1", "name": "Backlog"},
                            {"id": "opt-pend", "name": "Pending"},
                            {"id": "opt-2", "name": "Ready"},
                            {"id": "opt-3", "name": "Active"},
                            {"id": "opt-ir", "name": "In Review"},
                            {"id": "opt-4", "name": "Archived"},
                        ],
                    }
                ]
            },
        }
        mock_client.get_linked_repositories.return_value = []

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "activate",
                    "Test Project",
                    "--host",
                    "github.com",
                    "--owner",
                    "test-owner",
                ],
            )
            assert result.exit_code == 0
            config_name = "github.com_test-owner_test-project_test"
            assert result.stdout == ""
            assert result.stderr == (
                f"created: config file {tmp_path / (config_name + '.json')}\n"
                f"set: active project to {config_name}\n"
            )

    def test_activate_by_name_not_found(self) -> None:
        """存在しないプロジェクト名を指定"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Other Project", "id": "PVT_1"},
        ]

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app,
                [
                    "project",
                    "activate",
                    "Non Existent",
                    "--host",
                    "github.com",
                    "--owner",
                    "test-owner",
                ],
            )
            assert result.exit_code == 1
            assert result.stdout == ""
            assert result.stderr == (
                "error: project not found: Non Existent\n  available projects:\n  - Other Project\n"
            )

    def test_activate_list_initialized_projects(self) -> None:
        """init済みプロジェクト一覧を表示"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Project One", "id": "PVT_1"},
            {"number": 2, "title": "Project Two", "id": "PVT_2"},
        ]

        # Project One はinit済み（pecot-workflowフィールドあり）
        # Project Two はinit未済み
        def mock_get_project_fields(owner: str, number: int) -> dict | None:
            if number == 1:
                return {
                    "fields": {
                        "nodes": [
                            {"name": "pecot-workflow-test", "id": "field-1"},
                            {"name": "Status", "id": "field-2"},
                        ]
                    }
                }
            elif number == 2:
                return {
                    "fields": {
                        "nodes": [
                            {"name": "Status", "id": "field-2"},
                        ]
                    }
                }
            return None

        mock_client.get_project_fields.side_effect = mock_get_project_fields

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_active_config_path", return_value=None),
        ):
            result = runner.invoke(
                app, ["project", "activate", "--host", "github.com", "--owner", "test-owner"]
            )
            assert result.exit_code == 0
            assert result.stderr == ""
            assert "=== Initialized projects (github.com/test-owner) ===" in result.stdout
            assert "#1: Project One" in result.stdout
            # Project Two はinit未済みなので表示されない
            assert "#2: Project Two" not in result.stdout

    def test_activate_no_initialized_projects(self) -> None:
        """init済みプロジェクトがない場合"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Project One", "id": "PVT_1"},
        ]
        mock_client.get_project_fields.return_value = {
            "fields": {"nodes": [{"name": "Status", "id": "field-1"}]}
        }

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "activate", "--host", "github.com", "--owner", "test-owner"]
            )
            assert result.exit_code == 0
            assert result.stdout == "=== Initialized projects (github.com/test-owner) ===\n  none\n"
            assert result.stderr == ""

    def test_activate_with_active_marker(self) -> None:
        """アクティブなプロジェクトにマーカー表示"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Active Project", "id": "PVT_1"},
        ]
        mock_client.get_project_fields.return_value = {
            "fields": {"nodes": [{"name": "pecot-workflow-test", "id": "field-1"}]}
        }

        mock_config = MagicMock()
        mock_config.host = "github.com"
        mock_config.owner = "test-owner"
        mock_config.project.number = 1

        mock_config_path = MagicMock()

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch("cli.commands.project.load_config", return_value=mock_config),
        ):
            result = runner.invoke(
                app, ["project", "activate", "--host", "github.com", "--owner", "test-owner"]
            )
            assert result.exit_code == 0
            assert "[ACTIVE]" in result.stdout

    def test_activate_project_success(self, tmp_path: Path) -> None:
        """プロジェクトのアクティベート成功"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "PVT_1"},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "url": "https://github.com/users/test-owner/projects/1",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-test",
                        "id": "field-1",
                        "options": [
                            {"id": "opt-1", "name": "Backlog"},
                            {"id": "opt-pend", "name": "Pending"},
                            {"id": "opt-2", "name": "Ready"},
                            {"id": "opt-3", "name": "Active"},
                            {"id": "opt-ir", "name": "In Review"},
                            {"id": "opt-4", "name": "Archived"},
                        ],
                    }
                ]
            },
        }
        mock_client.get_linked_repositories.return_value = []

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app, ["project", "activate", "1", "--host", "github.com", "--owner", "test-owner"]
            )
            assert result.exit_code == 0
            config_name = "github.com_test-owner_test-project_test"
            assert result.stderr == (
                f"created: config file {tmp_path / (config_name + '.json')}\n"
                f"set: active project to {config_name}\n"
            )

    def test_activate_project_not_found(self) -> None:
        """存在しないプロジェクト番号を指定"""
        mock_client = MagicMock()
        mock_client.get_project_fields.return_value = None

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "activate", "999", "--host", "github.com", "--owner", "test-owner"]
            )
            assert result.exit_code == 1
            assert result.stderr == "error: project #999 not found\n"

    def test_activate_project_not_initialized(self) -> None:
        """init未済みのプロジェクトを指定"""
        mock_client = MagicMock()
        mock_client.get_project_fields.return_value = {
            "title": "Not Initialized Project",
            "fields": {"nodes": [{"name": "Status", "id": "field-1"}]},
        }

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "activate", "1", "--host", "github.com", "--owner", "test-owner"]
            )
            assert result.exit_code == 1
            assert result.stderr == (
                'error: project "Not Initialized Project" is not initialized\n'
                "  run: pecot project init --host github.com --suffix <suffix> test-owner "
                '"Not Initialized Project"\n'
            )

    def test_activate_with_host_option(self) -> None:
        """--host オプションでGHE指定"""
        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "GHE Project", "id": "PVT_1"},
        ]
        mock_client.get_project_fields.return_value = {
            "fields": {"nodes": [{"name": "pecot-workflow-test", "id": "field-1"}]}
        }

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_active_config_path", return_value=None),
        ):
            result = runner.invoke(
                app,
                ["project", "activate", "--host", "ghes.example.com", "--owner", "test-owner"],
            )
            assert result.exit_code == 0
            expected = "=== Initialized projects (ghes.example.com/test-owner) ==="
            assert result.stdout.splitlines().count(expected) == 1

    def test_activate_api_error(self) -> None:
        """GitHub APIエラー"""
        mock_client = MagicMock()
        mock_client.list_projects.side_effect = GitHubAPIError("API Error")

        with patch("cli.commands.project.GitHubClient", return_value=mock_client):
            result = runner.invoke(
                app, ["project", "activate", "--host", "github.com", "--owner", "test-owner"]
            )
            assert result.exit_code == 1
            assert result.stderr == "error: could not activate project: API Error\n"

    def test_activate_host_option_required(self) -> None:
        """--hostオプションが必須であることを確認"""
        result = runner.invoke(app, ["project", "activate", "--owner", "test-owner"])
        assert result.exit_code == 1
        assert result.stderr.startswith("error: --host is required\n  example: pecot project")
        assert result.stdout == ""

    def test_activate_with_config_filepath(self, tmp_path: Path) -> None:
        """設定ファイルパス（相対パス）で同期してアクティベート"""
        # テスト用設定ファイルを作成
        config_file = tmp_path / "test_config.json"
        config_content = """{
            "host": "ghes.example.com",
            "owner": "test-owner",
            "project": {
                "number": 1,
                "id": "PVT_1",
                "board_url": "https://ghes.example.com/users/test-owner/projects/1",
                "fields": {
                    "workflow": {
                        "id": "field-1",
                        "options": {
                            "backlog": "opt-1",
                            "pending": "opt-pending",
                            "ready": "opt-2",
                            "active": "opt-3",
                            "archived": "opt-4"
                        }
                    }
                }
            },
            "repositories": []
        }"""
        config_file.write_text(config_content)

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "test-owner"
        mock_config.project.number = 1

        mock_client = MagicMock()
        # get_project_fields - プロジェクト情報を取得してタイトルを得る
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-test",
                        "id": "MDI2OlByb2plY3RWMlNpbmdsZVNlbGVjdEZpZWxkMTIzNDU=",
                        "options": [
                            {"name": "Backlog", "id": "opt1"},
                            {"name": "Pending", "id": "opt-pending"},
                            {"name": "Ready", "id": "opt2"},
                            {"name": "Active", "id": "opt3"},
                            {"name": "In Review", "id": "opt-ir"},
                            {"name": "Archived", "id": "opt4"},
                        ],
                    }
                ]
            },
        }
        # list_projects - _sync_project_config内で使用
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "PVT_1", "url": "..."},
        ]
        mock_client.get_linked_repositories.return_value = []

        with (
            patch("cli.commands.project.load_config", return_value=mock_config),
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.save_config"),
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app, ["project", "activate", str(config_file), "--host", "ghes.example.com"]
            )
            assert result.exit_code == 0
            assert "set: active project to " in result.stderr

    def test_activate_keeps_repository_order_of_existing_config(self, tmp_path: Path) -> None:
        """リンク順が既存設定と違っても、保存される repositories は既存設定の並びを保つ"""
        config_file = tmp_path / "test_config.json"
        config_file.write_text("{}")
        # _sync_project_config が読む既存設定ファイル（host_owner_slug_suffix.json）
        (tmp_path / "ghes.example.com_test-owner_test-project_test.json").write_text("{}")

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "test-owner"
        mock_config.project.number = 1
        mock_config.aggregation_repo = None
        mock_config.repositories = [
            Repository(owner="test-owner", name="a", develop_branch="dev-a"),
            Repository(owner="test-owner", name="b"),
            Repository(owner="test-owner", name="c", develop_branch="dev-c"),
        ]

        mock_client = MagicMock()
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "views": {"nodes": [{"number": 1}]},
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-test",
                        "id": "PVTSSF_x",
                        "databaseId": 123,
                        "options": [
                            {"name": n, "id": f"o-{n}"}
                            for n in (
                                "Backlog",
                                "Pending",
                                "Ready",
                                "Active",
                                "In Review",
                                "Archived",
                            )
                        ],
                    }
                ]
            },
        }
        mock_client.list_projects.return_value = [
            {
                "number": 1,
                "title": "Test Project",
                "id": "PVT_1",
                "url": "https://ghes.example.com/users/test-owner/projects/1",
            },
        ]
        mock_client.get_linked_repositories.return_value = [
            {"owner": "test-owner", "name": "c"},
            {"owner": "test-owner", "name": "a"},
            {"owner": "test-owner", "name": "b"},
        ]

        with (
            patch("cli.commands.project.load_config", return_value=mock_config),
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.save_config") as mock_save,
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app, ["project", "activate", str(config_file), "--host", "ghes.example.com"]
            )

        assert result.exit_code == 0
        saved = mock_save.call_args.args[0]
        assert [r.name for r in saved.repositories] == ["a", "b", "c"]
        assert saved.repositories[0].develop_branch == "dev-a"
        assert saved.project.board_url.startswith(
            "https://ghes.example.com/users/test-owner/projects/1/views/1?layout=board"
        )
        assert "verticalGroupedBy%5BcolumnId%5D=123" in saved.project.board_url

    def _invoke_activate_from_file(
        self,
        tmp_path: Path,
        project_fields: dict[str, Any] | None,
    ) -> Result:
        """設定ファイル経由の activate を、get_project_fields の戻り値を指定して起動"""
        config_file = tmp_path / "test_config.json"
        config_file.write_text("{}")

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "test-owner"
        mock_config.project.number = 1

        mock_client = MagicMock()
        mock_client.get_project_fields.return_value = project_fields

        with (
            patch("cli.commands.project.load_config", return_value=mock_config),
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
        ):
            return runner.invoke(
                app, ["project", "activate", str(config_file), "--host", "ghes.example.com"]
            )

    def test_activate_config_file_project_not_found(self, tmp_path: Path) -> None:
        """プロジェクトが取れなくても読み込み失敗の行は付かない"""
        result = self._invoke_activate_from_file(tmp_path, None)

        assert result.exit_code == 1
        assert result.stderr == "error: project #1 not found\n"

    def test_activate_config_file_empty_title(self, tmp_path: Path) -> None:
        """タイトルが取れなくても読み込み失敗の行は付かない"""
        result = self._invoke_activate_from_file(tmp_path, {"title": ""})

        assert result.exit_code == 1
        assert result.stderr == "error: could not read the title of project #1\n"

    def test_activate_config_file_load_error(self, tmp_path: Path) -> None:
        """設定ファイルの読み込みに失敗したときは読み込み失敗を案内する"""
        config_file = tmp_path / "test_config.json"
        config_file.write_text("{}")

        with (
            patch("cli.commands.project.load_config", side_effect=ValueError("broken")),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
        ):
            result = runner.invoke(
                app, ["project", "activate", str(config_file), "--host", "ghes.example.com"]
            )

        assert result.exit_code == 1
        assert result.stderr == "error: could not load config file test_config.json: broken\n"

    def test_activate_with_config_filename(self, tmp_path: Path) -> None:
        """設定ファイル名で同期してアクティベート"""
        # テスト用設定ファイルを作成
        config_file = tmp_path / "ghes.example.com_test-owner_project.json"
        config_file.write_text("{}")

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "test-owner"
        mock_config.project.number = 1

        mock_client = MagicMock()
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-test",
                        "id": "MDI2OlByb2plY3RWMlNpbmdsZVNlbGVjdEZpZWxkMTIzNDU=",
                        "options": [
                            {"name": "Backlog", "id": "opt1"},
                            {"name": "Pending", "id": "opt-pending"},
                            {"name": "Ready", "id": "opt2"},
                            {"name": "Active", "id": "opt3"},
                            {"name": "In Review", "id": "opt-ir"},
                            {"name": "Archived", "id": "opt4"},
                        ],
                    }
                ]
            },
        }
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "PVT_1", "url": "..."},
        ]
        mock_client.get_linked_repositories.return_value = []

        with (
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.load_config", return_value=mock_config),
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.save_config"),
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "activate",
                    "ghes.example.com_test-owner_project.json",
                    "--host",
                    "ghes.example.com",
                ],
            )
            assert result.exit_code == 0
            assert "set: active project to " in result.stderr

    def test_activate_config_filename_without_json_extension(self, tmp_path: Path) -> None:
        """設定ファイル名（.json拡張子なし）で同期してアクティベート"""
        # テスト用設定ファイルを作成
        config_file = tmp_path / "ghes.example.com_test-owner_project.json"
        config_file.write_text("{}")

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "test-owner"
        mock_config.project.number = 1

        mock_client = MagicMock()
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-test",
                        "id": "MDI2OlByb2plY3RWMlNpbmdsZVNlbGVjdEZpZWxkMTIzNDU=",
                        "options": [
                            {"name": "Backlog", "id": "opt1"},
                            {"name": "Pending", "id": "opt-pending"},
                            {"name": "Ready", "id": "opt2"},
                            {"name": "Active", "id": "opt3"},
                            {"name": "In Review", "id": "opt-ir"},
                            {"name": "Archived", "id": "opt4"},
                        ],
                    }
                ]
            },
        }
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "PVT_1", "url": "..."},
        ]
        mock_client.get_linked_repositories.return_value = []

        with (
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.load_config", return_value=mock_config),
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.save_config"),
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "activate",
                    "ghes.example.com_test-owner_project",
                    "--host",
                    "ghes.example.com",
                ],
            )
            assert result.exit_code == 0
            assert "set: active project to " in result.stderr

    def test_activate_config_filename_without_host_option(self, tmp_path: Path) -> None:
        """設定ファイル名で--hostなしで同期してアクティベート可能"""
        # テスト用設定ファイルを作成
        config_file = tmp_path / "ghes.example.com_test-owner_project.json"
        config_file.write_text("{}")

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "test-owner"
        mock_config.project.number = 1

        mock_client = MagicMock()
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-test",
                        "id": "MDI2OlByb2plY3RWMlNpbmdsZVNlbGVjdEZpZWxkMTIzNDU=",
                        "options": [
                            {"name": "Backlog", "id": "opt1"},
                            {"name": "Pending", "id": "opt-pending"},
                            {"name": "Ready", "id": "opt2"},
                            {"name": "Active", "id": "opt3"},
                            {"name": "In Review", "id": "opt-ir"},
                            {"name": "Archived", "id": "opt4"},
                        ],
                    }
                ]
            },
        }
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "PVT_1", "url": "..."},
        ]
        mock_client.get_linked_repositories.return_value = []

        with (
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.load_config", return_value=mock_config),
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.save_config"),
            patch("cli.commands.project.set_active_config"),
        ):
            # --host オプションなしで設定ファイル名を指定
            result = runner.invoke(
                app, ["project", "activate", "ghes.example.com_test-owner_project"]
            )
            assert result.exit_code == 0
            assert "set: active project to " in result.stderr

    def test_activate_config_filepath_without_host_option(self, tmp_path: Path) -> None:
        """設定ファイルパスで--hostなしで同期してアクティベート可能"""
        # テスト用設定ファイルを作成
        config_file = tmp_path / "test_config.json"
        config_file.write_text("{}")

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "test-owner"
        mock_config.project.number = 1

        mock_client = MagicMock()
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-test",
                        "id": "MDI2OlByb2plY3RWMlNpbmdsZVNlbGVjdEZpZWxkMTIzNDU=",
                        "options": [
                            {"name": "Backlog", "id": "opt1"},
                            {"name": "Pending", "id": "opt-pending"},
                            {"name": "Ready", "id": "opt2"},
                            {"name": "Active", "id": "opt3"},
                            {"name": "In Review", "id": "opt-ir"},
                            {"name": "Archived", "id": "opt4"},
                        ],
                    }
                ]
            },
        }
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "PVT_1", "url": "..."},
        ]
        mock_client.get_linked_repositories.return_value = []

        with (
            patch("cli.commands.project.load_config", return_value=mock_config),
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.save_config"),
            patch("cli.commands.project.set_active_config"),
        ):
            # --host オプションなしでファイルパスを指定
            result = runner.invoke(app, ["project", "activate", str(config_file)])
            assert result.exit_code == 0
            assert "set: active project to " in result.stderr

    def test_activate_name_without_host_shows_error(self) -> None:
        """名前指定時に--hostなしだとエラー（設定ファイルに一致しない場合）"""
        result = runner.invoke(app, ["project", "activate", "NonexistentProject"])
        assert result.exit_code == 1
        assert result.stderr.startswith("error: --host is required\n")
        # ファイル指定で回避できることを例として表示
        assert (
            "  example: pecot project activate "
            "ghes.example.com_example-org_example-project_example-org\n"
        ) in result.stderr

    def test_activate_preserves_release_type_and_packages(self, tmp_path: Path) -> None:
        """既存設定の release_type と packages が _sync_project_config で保持される"""
        # ファイル名は _sync_project_config 内の {host}_{owner}_{slug}_{workflow-suffix}.json に従う。
        # host=github.com, owner=test-owner。
        # slug=_slugify("Test Project")="test-project"。
        # suffix=_extract_workflow_suffix("pecot-workflow-x")="x"。
        config_file = tmp_path / "github.com_test-owner_test-project_x.json"
        status_options = {
            "backlog": "b",
            "pending": "p",
            "ready": "r",
            "active": "a",
            "in_review": "i",
            "archived": "z",
        }
        existing = {
            "host": "github.com",
            "owner": "test-owner",
            "workflow_suffix": "x",
            "project": {
                "number": 1,
                "id": "PVT_1",
                "board_url": "https://github.com/users/test-owner/projects/1",
                "fields": {
                    "workflow": {"id": "f1", "options": status_options},
                },
            },
            "repositories": [
                {
                    "owner": "test-owner",
                    "name": "nx-repo",
                    "develop_branch": "develop",
                    "release_branch": "main",
                    "release_type": "nx",
                    "packages": [
                        {"name": "pkg-a", "changelog": "a/CHANGELOG.md"},
                        {"name": "pkg-b", "changelog": "b/CHANGELOG.md"},
                    ],
                }
            ],
        }
        config_file.write_text(json.dumps(existing))

        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "PVT_1"},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "url": "https://github.com/users/test-owner/projects/1",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-x",
                        "id": "f1",
                        "options": [
                            {"id": "b", "name": "Backlog"},
                            {"id": "p", "name": "Pending"},
                            {"id": "r", "name": "Ready"},
                            {"id": "a", "name": "Active"},
                            {"id": "i", "name": "In Review"},
                            {"id": "z", "name": "Archived"},
                        ],
                    }
                ]
            },
        }
        mock_client.get_linked_repositories.return_value = [
            {"owner": "test-owner", "name": "nx-repo"}
        ]

        saved_configs: list = []

        def capture_save(config, path):  # type: ignore[no-untyped-def]
            saved_configs.append(config)

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.save_config", side_effect=capture_save),
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app,
                ["project", "activate", "1", "--host", "github.com", "--owner", "test-owner"],
            )
            assert result.exit_code == 0

        assert saved_configs, "save_config が呼ばれていない"
        saved = saved_configs[-1]
        repo = next(r for r in saved.repositories if r.name == "nx-repo")
        assert repo.release_type == "nx", f"release_type が保持されていない: {repo.release_type}"
        assert repo.packages is not None, "packages が保持されていない"
        assert len(repo.packages) == 2
        assert [p.name for p in repo.packages] == ["pkg-a", "pkg-b"]

    def test_activate_preserves_aggregation_repo(self, tmp_path: Path) -> None:
        """既存設定の aggregation_repo が _sync_project_config で保持される"""
        config_file = tmp_path / "github.com_test-owner_test-project_x.json"
        status_options = {
            "backlog": "b",
            "pending": "p",
            "ready": "r",
            "active": "a",
            "in_review": "i",
            "archived": "z",
        }
        existing = {
            "host": "github.com",
            "owner": "test-owner",
            "workflow_suffix": "x",
            "project": {
                "number": 1,
                "id": "PVT_1",
                "board_url": "https://github.com/users/test-owner/projects/1",
                "fields": {
                    "workflow": {"id": "f1", "options": status_options},
                },
            },
            "repositories": [
                {
                    "owner": "test-owner",
                    "name": "repo-a",
                    "develop_branch": "develop",
                },
            ],
            "aggregation_repo": "test-owner/agg-repo",
        }
        config_file.write_text(json.dumps(existing))

        mock_client = MagicMock()
        mock_client.list_projects.return_value = [
            {"number": 1, "title": "Test Project", "id": "PVT_1"},
        ]
        mock_client.get_project_fields.return_value = {
            "id": "PVT_1",
            "title": "Test Project",
            "url": "https://github.com/users/test-owner/projects/1",
            "fields": {
                "nodes": [
                    {
                        "name": "pecot-workflow-x",
                        "id": "f1",
                        "options": [
                            {"id": "b", "name": "Backlog"},
                            {"id": "p", "name": "Pending"},
                            {"id": "r", "name": "Ready"},
                            {"id": "a", "name": "Active"},
                            {"id": "i", "name": "In Review"},
                            {"id": "z", "name": "Archived"},
                        ],
                    }
                ]
            },
        }
        mock_client.get_linked_repositories.return_value = [
            {"owner": "test-owner", "name": "repo-a"}
        ]

        saved_configs: list = []

        def capture_save(config, path):  # type: ignore[no-untyped-def]
            saved_configs.append(config)

        with (
            patch("cli.commands.project.GitHubClient", return_value=mock_client),
            patch("cli.commands.project.get_projects_dir", return_value=tmp_path),
            patch("cli.commands.project.save_config", side_effect=capture_save),
            patch("cli.commands.project.set_active_config"),
        ):
            result = runner.invoke(
                app,
                ["project", "activate", "1", "--host", "github.com", "--owner", "test-owner"],
            )
            assert result.exit_code == 0

        assert saved_configs, "save_config が呼ばれていない"
        saved = saved_configs[-1]
        assert saved.aggregation_repo == "test-owner/agg-repo", (
            f"aggregation_repo が保持されていない: {saved.aggregation_repo}"
        )


# release_branch 関連テスト


class TestSetRepoReleaseBranch:
    """project set-repo コマンドの --release-branch テスト"""

    def test_set_repo_with_release_branch_new(self, tmp_path: Path) -> None:
        """新規リポジトリ追加時に --release-branch を設定"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.host = "ghes.example.com"
        mock_config.project.number = 1
        mock_config.repositories = []
        mock_config.find_repository.return_value = None

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch(
                "cli.commands.project._link_project_repository",
                return_value=("linked", ""),
            ),
            patch("cli.commands.project.save_config") as mock_save,
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "set-repo",
                    "test-owner/new-repo",
                    "--develop-branch",
                    "develop",
                    "--release-branch",
                    "main",
                ],
            )
            assert result.exit_code == 0
            assert result.stderr.endswith(f"added: test-owner/new-repo to {mock_config_path}\n")
            mock_save.assert_called_once()

    def test_set_repo_update_release_branch(self, tmp_path: Path) -> None:
        """既存リポジトリの release_branch を更新"""
        mock_repo = MagicMock()
        mock_repo.owner = "test-owner"
        mock_repo.name = "existing-repo"
        mock_repo.develop_branch = "develop"
        mock_repo.release_branch = None

        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.repositories = [mock_repo]
        mock_config.find_repository.return_value = mock_repo

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch("cli.commands.project.save_config") as mock_save,
        ):
            result = runner.invoke(
                app,
                ["project", "set-repo", "test-owner/existing-repo", "--release-branch", "main"],
            )
            assert result.exit_code == 0
            assert result.stderr == f"updated: test-owner/existing-repo in {mock_config_path}\n"
            mock_save.assert_called_once()
            # release_branchが設定されたことを確認
            assert mock_repo.release_branch == "main"

    def test_set_repo_no_release_branch_preserves_existing(self, tmp_path: Path) -> None:
        """--release-branch 未指定時は既存値を保持"""
        mock_repo = MagicMock()
        mock_repo.owner = "test-owner"
        mock_repo.name = "existing-repo"
        mock_repo.develop_branch = "develop"
        mock_repo.release_branch = "main"

        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.repositories = [mock_repo]
        mock_config.find_repository.return_value = mock_repo

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch("cli.commands.project.save_config"),
        ):
            result = runner.invoke(
                app,
                ["project", "set-repo", "test-owner/existing-repo", "--develop-branch", "new-dev"],
            )
            assert result.exit_code == 0
            # release_branchは変更されていない（Noneではないので上書きされない）
            assert mock_repo.release_branch == "main"


# changelog_file 関連テスト


class TestSetRepoChangelogFile:
    """project set-repo コマンドの --changelog-file テスト"""

    def test_set_repo_with_changelog_file_new(self, tmp_path: Path) -> None:
        """新規リポジトリ追加時に --changelog-file を設定"""
        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.host = "ghes.example.com"
        mock_config.project.number = 1
        mock_config.repositories = []
        mock_config.find_repository.return_value = None

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch(
                "cli.commands.project._link_project_repository",
                return_value=("linked", ""),
            ),
            patch("cli.commands.project.save_config") as mock_save,
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "set-repo",
                    "test-owner/new-repo",
                    "--develop-branch",
                    "develop",
                    "--changelog-file",
                    "AIST-CHANGELOG.md",
                ],
            )
            assert result.exit_code == 0
            assert result.stderr.endswith(f"added: test-owner/new-repo to {mock_config_path}\n")
            mock_save.assert_called_once()

    def test_set_repo_update_changelog_file(self, tmp_path: Path) -> None:
        """既存リポジトリの changelog_file を更新"""
        mock_repo = MagicMock()
        mock_repo.owner = "test-owner"
        mock_repo.name = "existing-repo"
        mock_repo.develop_branch = "develop"
        mock_repo.changelog_file = None
        mock_repo.packages = None

        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.repositories = [mock_repo]
        mock_config.find_repository.return_value = mock_repo

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch("cli.commands.project.save_config") as mock_save,
        ):
            result = runner.invoke(
                app,
                [
                    "project",
                    "set-repo",
                    "test-owner/existing-repo",
                    "--changelog-file",
                    "AIST-CHANGELOG.md",
                ],
            )
            assert result.exit_code == 0
            assert result.stderr == f"updated: test-owner/existing-repo in {mock_config_path}\n"
            mock_save.assert_called_once()
            # changelog_fileが設定されたことを確認
            assert mock_repo.changelog_file == "AIST-CHANGELOG.md"

    def test_set_repo_no_changelog_file_preserves_existing(self, tmp_path: Path) -> None:
        """--changelog-file 未指定時は既存値を保持"""
        mock_repo = MagicMock()
        mock_repo.owner = "test-owner"
        mock_repo.name = "existing-repo"
        mock_repo.develop_branch = "develop"
        mock_repo.changelog_file = "AIST-CHANGELOG.md"

        mock_config = MagicMock()
        mock_config.owner = "test-owner"
        mock_config.repositories = [mock_repo]
        mock_config.find_repository.return_value = mock_repo

        mock_config_path = tmp_path / "test.json"
        mock_config_path.write_text("{}")

        with (
            patch("cli.commands.project.load_active_config", return_value=mock_config),
            patch("cli.commands.project.get_active_config_path", return_value=mock_config_path),
            patch("cli.commands.project.save_config"),
        ):
            result = runner.invoke(
                app,
                ["project", "set-repo", "test-owner/existing-repo", "--develop-branch", "new-dev"],
            )
            assert result.exit_code == 0
            # changelog_fileは変更されていない
            assert mock_repo.changelog_file == "AIST-CHANGELOG.md"


# project info コマンドの aggregation_repo 表示テスト


class TestInfoAggregationRepoDisplay:
    """project info が aggregation_repo を Markdown / JSON 双方に出力するテスト"""

    def _build_config(self, aggregation_repo: str | None) -> MagicMock:
        config = MagicMock()
        config.host = "ghes.example.com"
        config.owner = "test-owner"
        config.project.id = "PVT_1"
        config.project.number = 1
        config.workflow_field_name = "pecot-workflow-test"
        config.repositories = []
        config.aggregation_repo = aggregation_repo
        return config

    def test_info_markdown_shows_aggregation_repo_when_set(self) -> None:
        config = self._build_config("test-owner/agg-repo")
        config_path = MagicMock()
        config_path.stem = "test-project"
        client = MagicMock()
        client.list_project_items.return_value = []
        with (
            patch("cli.commands.project.load_active_config", return_value=config),
            patch("cli.commands.project.get_active_config_path", return_value=config_path),
            patch("cli.commands.project.GitHubClient", return_value=client),
        ):
            result = runner.invoke(app, ["project", "info"])

        assert result.exit_code == 0, result.output
        assert "- Roadmap repo: `test-owner/agg-repo`" in result.stdout
        assert "- Roadmap repo: none" not in result.stdout
        assert result.stderr == ""

    def test_info_markdown_shows_unset_when_not_configured(self) -> None:
        config = self._build_config(None)
        config_path = MagicMock()
        config_path.stem = "test-project"
        client = MagicMock()
        client.list_project_items.return_value = []
        with (
            patch("cli.commands.project.load_active_config", return_value=config),
            patch("cli.commands.project.get_active_config_path", return_value=config_path),
            patch("cli.commands.project.GitHubClient", return_value=client),
        ):
            result = runner.invoke(app, ["project", "info"])

        assert result.exit_code == 0, result.output
        assert "- Roadmap repo: none" in result.stdout

    def test_info_markdown_sections_in_order(self) -> None:
        """Markdown 出力は Overview・Registered repositories・Board status の 3 節をこの順で出す"""
        config = self._build_config("test-owner/agg-repo")
        config_path = MagicMock()
        config_path.stem = "test-project"
        client = MagicMock()
        client.list_project_items.return_value = []
        with (
            patch("cli.commands.project.load_active_config", return_value=config),
            patch("cli.commands.project.get_active_config_path", return_value=config_path),
            patch("cli.commands.project.GitHubClient", return_value=client),
        ):
            result = runner.invoke(app, ["project", "info"])

        assert result.exit_code == 0, result.output
        headings = [line for line in result.stdout.splitlines() if line.startswith("## ")]
        assert headings == ["## Overview", "## Registered repositories", "## Board status"]

    def test_info_json_includes_aggregation_repo_when_set(self) -> None:
        config = self._build_config("test-owner/agg-repo")
        config_path = MagicMock()
        config_path.stem = "test-project"
        client = MagicMock()
        client.list_project_items.return_value = []
        with (
            patch("cli.commands.project.load_active_config", return_value=config),
            patch("cli.commands.project.get_active_config_path", return_value=config_path),
            patch("cli.commands.project.GitHubClient", return_value=client),
        ):
            result = runner.invoke(app, ["project", "info", "--json"])

        assert result.exit_code == 0, result.output
        payload = json.loads(result.stdout)
        assert payload["project"]["aggregation_repo"] == "test-owner/agg-repo"

    def test_info_json_includes_aggregation_repo_as_null_when_unset(self) -> None:
        config = self._build_config(None)
        config_path = MagicMock()
        config_path.stem = "test-project"
        client = MagicMock()
        client.list_project_items.return_value = []
        with (
            patch("cli.commands.project.load_active_config", return_value=config),
            patch("cli.commands.project.get_active_config_path", return_value=config_path),
            patch("cli.commands.project.GitHubClient", return_value=client),
        ):
            result = runner.invoke(app, ["project", "info", "--json"])

        assert result.exit_code == 0, result.output
        payload = json.loads(result.stdout)
        assert "aggregation_repo" in payload["project"]
        assert payload["project"]["aggregation_repo"] is None


class TestInfoDependabotAlerts:
    """project info が登録リポごとの Dependabot alert の状態を出力するテスト"""

    ENABLED = DependabotAlertStatus(
        enabled=True,
        open_count=0,
        max_severity=None,
        alerts_url="https://ghes.example.com/test-owner/repo-a/security/dependabot",
    )
    DISABLED = DependabotAlertStatus(
        enabled=False,
        open_count=0,
        max_severity=None,
        alerts_url="https://ghes.example.com/test-owner/repo-b/security/dependabot",
    )

    @staticmethod
    def _by_name(**results: Any) -> MagicMock:
        """取得は並列なので、呼ばれた順ではなくリポジトリの名前で結果を返す偽物を作る"""

        def fetch(_client: Any, _host: str, _owner: str, name: str) -> DependabotAlertStatus:
            result = results[name.replace("-", "_")]
            if isinstance(result, Exception):
                raise result
            return result

        return MagicMock(side_effect=fetch)

    def _invoke(self, fetch: MagicMock, *args: str):  # type: ignore[no-untyped-def]
        config = MagicMock()
        config.host = "ghes.example.com"
        config.owner = "test-owner"
        config.project.id = "PVT_1"
        config.project.number = 1
        config.workflow_field_name = "pecot-workflow-test"
        config.aggregation_repo = None
        config.repositories = [
            Repository(owner="test-owner", name="repo-a", release_type="nx"),
            Repository(owner="test-owner", name="repo-b"),
        ]
        config_path = MagicMock()
        config_path.stem = "test-project"
        client = MagicMock()
        client.list_project_items.return_value = []
        with (
            patch("cli.commands.project.load_active_config", return_value=config),
            patch("cli.commands.project.get_active_config_path", return_value=config_path),
            patch("cli.commands.project.GitHubClient", return_value=client),
            patch("cli.commands.project.fetch_dependabot_alert_status", fetch),
        ):
            return runner.invoke(app, ["project", "info", *args])

    def test_lines_for_enabled_and_disabled(self) -> None:
        fetch = self._by_name(repo_a=self.ENABLED, repo_b=self.DISABLED)

        result = self._invoke(fetch)

        assert result.exit_code == 0, result.output
        lines = result.stdout.splitlines()
        a = lines.index("    release_type: nx")
        assert lines[a + 1] == "    dependabot_alerts: open 0"
        b = lines.index("    release_type: single")
        assert lines[b + 1] == "    dependabot_alerts: disabled"

    def test_failure_is_shown_and_does_not_stop(self) -> None:
        fetch = self._by_name(
            repo_a=DependabotAlertError("test-owner/repo-a: GitHub APIエラー: 500"),
            repo_b=self.DISABLED,
        )

        result = self._invoke(fetch)

        assert result.exit_code == 0, result.output
        assert (
            "    dependabot_alerts: fetch failed (test-owner/repo-a: GitHub APIエラー: 500)"
            in result.stdout
        )
        assert "    dependabot_alerts: disabled" in result.stdout

    def test_json_includes_dependabot_alerts(self) -> None:
        fetch = self._by_name(repo_a=self.ENABLED, repo_b=DependabotAlertError("理由"))

        result = self._invoke(fetch, "--json")

        assert result.exit_code == 0, result.output
        repos = json.loads(result.stdout)["repositories"]
        assert repos[0]["dependabot_alerts"] == {
            "enabled": True,
            "open_count": 0,
            "max_severity": None,
            "alerts_url": "https://ghes.example.com/test-owner/repo-a/security/dependabot",
        }
        assert repos[1]["dependabot_alerts"] == {"error": "理由"}

    def test_fetches_repos_in_parallel(self) -> None:
        """登録リポの取得が並行して実行される（直列だと Barrier が timeout して exit 1 になる）"""
        barrier = threading.Barrier(2, timeout=5)

        def fetch(_client: Any, _host: str, _owner: str, name: str) -> DependabotAlertStatus:
            try:
                barrier.wait()
            except threading.BrokenBarrierError as e:
                raise RuntimeError(
                    "2 リポの取得が並行して実行されなかった（Barrier timeout）"
                ) from e
            return self.ENABLED if name == "repo-a" else self.DISABLED

        result = self._invoke(MagicMock(side_effect=fetch))

        assert result.exit_code == 0, result.output
        lines = [
            line.strip()
            for line in result.stdout.splitlines()
            if line.strip().startswith("dependabot_alerts")
        ]
        assert lines == ["dependabot_alerts: open 0", "dependabot_alerts: disabled"]


# project info コマンドのエラー時のテスト


class TestInfoErrorPaths:
    """project info の設定なし / GitHub APIエラーの場合"""

    def test_info_no_config(self) -> None:
        """設定がない場合はエラー"""
        with patch("cli.commands.project.load_active_config", return_value=None):
            result = runner.invoke(app, ["project", "info"])

        assert result.exit_code == 1
        # 案内の 2 行だけが出て、握り直しの「unexpected error: 1」は付かない
        assert result.stdout == ""
        assert result.stderr == (
            "error: no active project\n  run: pecot project activate <PROJECT>\n"
        )

    def test_info_github_api_error(self) -> None:
        """GitHub APIエラー時"""
        config = MagicMock()
        config.host = "github.com"
        config.owner = "test"
        config.project.id = "PVT_test"
        config.repositories = []

        client = MagicMock()
        client.list_project_items.side_effect = GitHubAPIError("API error", status_code=500)

        with (
            patch("cli.commands.project.load_active_config", return_value=config),
            patch("cli.commands.project.GitHubClient", return_value=client),
        ):
            result = runner.invoke(app, ["project", "info"])

        assert result.exit_code == 1
        assert result.stdout == ""
        assert result.stderr == "error: could not read project board (status 500): API error\n"
