"""tests/core/test_config.py - config.pyのユニットテスト

Pydanticモデル、Enum、設定操作関数のテスト。
ファイルシステム操作はtmp_pathとmonkeypatchでモック化。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from cli.core.config import (
    ConfigError,
    FieldOptions,
    Package,
    Priority,
    Project,
    ProjectConfig,
    ProjectFields,
    Repository,
    Size,
    WorkflowStatus,
    get_active_config_path,
    load_active_config,
    load_config,
    save_config,
    set_active_config,
)

# テストデータ


def create_sample_config_dict() -> dict[str, Any]:
    """テスト用の設定辞書を作成"""
    return {
        "host": "ghes.example.com",
        "owner": "test-owner",
        "workflow_suffix": "test",
        "project": {
            "number": 1,
            "id": "PVT_test123",
            "board_url": "https://ghes.example.com/users/test-owner/projects/1",
            "fields": {
                "workflow": {
                    "id": "FIELD_workflow",
                    "options": {
                        "backlog": "opt_backlog",
                        "ready": "opt_ready",
                        "active": "opt_active",
                        "in_review": "opt_in_review",
                        "archived": "opt_archived",
                    },
                },
                "priority": {
                    "id": "FIELD_priority",
                    "options": {
                        "high": "opt_high",
                        "medium": "opt_medium",
                        "low": "opt_low",
                    },
                },
                "size": {
                    "id": "FIELD_size",
                    "options": {
                        "xs": "opt_xs",
                        "s": "opt_s",
                        "m": "opt_m",
                        "l": "opt_l",
                    },
                },
            },
        },
        "repositories": [
            {
                "owner": "test-owner",
                "name": "test-repo",
                "develop_branch": "develop",
            },
            {
                "owner": "test-owner",
                "name": "another-repo",
            },
        ],
    }


def create_sample_config() -> ProjectConfig:
    """テスト用のProjectConfigを作成"""
    return ProjectConfig.model_validate(create_sample_config_dict())


# Enumテスト


class TestWorkflowStatus:
    """WorkflowStatus Enumのテスト"""

    def test_values(self) -> None:
        """全ステータス値が定義されている"""
        assert WorkflowStatus.BACKLOG.value == "backlog"
        assert WorkflowStatus.PENDING.value == "pending"
        assert WorkflowStatus.READY.value == "ready"
        assert WorkflowStatus.ACTIVE.value == "active"
        assert WorkflowStatus.IN_REVIEW.value == "in_review"
        assert WorkflowStatus.ARCHIVED.value == "archived"

    def test_is_str_enum(self) -> None:
        """str Enum として文字列を比較できる"""
        assert WorkflowStatus.ACTIVE == "active"
        assert WorkflowStatus.ACTIVE.value == "active"


class TestPriority:
    """Priority Enumのテスト"""

    def test_values(self) -> None:
        """全優先度値が定義されている"""
        assert Priority.HIGH.value == "high"
        assert Priority.MEDIUM.value == "medium"
        assert Priority.LOW.value == "low"


class TestSize:
    """Size Enumのテスト"""

    def test_values(self) -> None:
        """全サイズ値が定義されている"""
        assert Size.XS.value == "xs"
        assert Size.S.value == "s"
        assert Size.M.value == "m"
        assert Size.L.value == "l"


# Pydanticモデルテスト


class TestFieldOptions:
    """FieldOptionsモデルのテスト"""

    def test_basic_creation(self) -> None:
        """基本的なインスタンス作成"""
        field = FieldOptions(
            id="FIELD_123",
            options={"active": "opt_active", "done": "opt_done"},
        )
        assert field.id == "FIELD_123"
        assert field.options == {"active": "opt_active", "done": "opt_done"}

    def test_get_option_id_found(self) -> None:
        """オプションIDを取得（存在する場合）"""
        field = FieldOptions(
            id="FIELD_123",
            options={"active": "opt_active"},
        )
        assert field.get_option_id("active") == "opt_active"

    def test_get_option_id_not_found(self) -> None:
        """オプションIDを取得（存在しない場合）"""
        field = FieldOptions(
            id="FIELD_123",
            options={"active": "opt_active"},
        )
        assert field.get_option_id("nonexistent") is None


class TestProjectFields:
    """ProjectFieldsモデルのテスト"""

    def test_workflow_required(self) -> None:
        """workflowは必須"""
        workflow = FieldOptions(id="WF", options={"active": "a"})
        fields = ProjectFields(workflow=workflow)
        assert fields.workflow == workflow
        assert fields.priority is None
        assert fields.size is None

    def test_all_fields(self) -> None:
        """全フィールドを設定"""
        workflow = FieldOptions(id="WF", options={})
        priority = FieldOptions(id="PR", options={})
        size = FieldOptions(id="SZ", options={})
        fields = ProjectFields(workflow=workflow, priority=priority, size=size)
        assert fields.workflow == workflow
        assert fields.priority == priority
        assert fields.size == size

    def test_get_field_workflow(self) -> None:
        """get_field: workflowを取得"""
        workflow = FieldOptions(id="WF", options={})
        fields = ProjectFields(workflow=workflow)
        assert fields.get_field("workflow") == workflow

    def test_get_field_priority(self) -> None:
        """get_field: priorityを取得"""
        workflow = FieldOptions(id="WF", options={})
        priority = FieldOptions(id="PR", options={})
        fields = ProjectFields(workflow=workflow, priority=priority)
        assert fields.get_field("priority") == priority

    def test_get_field_not_found(self) -> None:
        """get_field: 存在しないフィールド"""
        workflow = FieldOptions(id="WF", options={})
        fields = ProjectFields(workflow=workflow)
        assert fields.get_field("nonexistent") is None


class TestProject:
    """Projectモデルのテスト"""

    def test_basic_creation(self) -> None:
        """基本的なインスタンス作成"""
        workflow = FieldOptions(id="WF", options={})
        fields = ProjectFields(workflow=workflow)
        project = Project(number=1, id="PVT_123", fields=fields)
        assert project.number == 1
        assert project.id == "PVT_123"
        assert project.board_url is None
        assert project.fields == fields

    def test_with_board_url(self) -> None:
        """board_urlを含むインスタンス作成"""
        workflow = FieldOptions(id="WF", options={})
        fields = ProjectFields(workflow=workflow)
        project = Project(
            number=1,
            id="PVT_123",
            board_url="https://github.com/users/test/projects/1",
            fields=fields,
        )
        assert project.board_url == "https://github.com/users/test/projects/1"


class TestRepository:
    """Repositoryモデルのテスト"""

    def test_basic_creation(self) -> None:
        """基本的なインスタンス作成"""
        repo = Repository(owner="test-owner", name="test-repo")
        assert repo.owner == "test-owner"
        assert repo.name == "test-repo"
        assert repo.develop_branch is None

    def test_with_develop_branch(self) -> None:
        """develop_branchを含むインスタンス作成"""
        repo = Repository(owner="test-owner", name="test-repo", develop_branch="develop")
        assert repo.develop_branch == "develop"

    def test_with_release_branch(self) -> None:
        """release_branchを含むインスタンス作成"""
        repo = Repository(
            owner="test-owner", name="test-repo", develop_branch="develop", release_branch="main"
        )
        assert repo.release_branch == "main"

    def test_release_branch_default_none(self) -> None:
        """release_branchのデフォルトはNone"""
        repo = Repository(owner="test-owner", name="test-repo")
        assert repo.release_branch is None

    def test_with_changelog_file(self) -> None:
        """changelog_fileを含むインスタンス作成"""
        repo = Repository(
            owner="test-owner",
            name="test-repo",
            changelog_file="AIST-CHANGELOG.md",
        )
        assert repo.changelog_file == "AIST-CHANGELOG.md"

    def test_changelog_file_default_none(self) -> None:
        """changelog_fileのデフォルトはNone"""
        repo = Repository(owner="test-owner", name="test-repo")
        assert repo.changelog_file is None

    def test_full_name(self) -> None:
        """full_nameプロパティ"""
        repo = Repository(owner="test-owner", name="test-repo")
        assert repo.full_name == "test-owner/test-repo"

    def test_packages_default_none(self) -> None:
        """packagesのデフォルトはNone"""
        repo = Repository(owner="test-owner", name="test-repo")
        assert repo.packages is None

    def test_with_packages(self) -> None:
        """packagesを含むインスタンス作成"""
        repo = Repository(
            owner="test-owner",
            name="test-repo",
            packages=[
                Package(name="pecot", changelog="plugins/pecot-workflow/CHANGELOG.md"),
                Package(name="pecotv", changelog="plugins/pecot-visual/CHANGELOG.md"),
            ],
        )
        assert repo.packages is not None
        assert len(repo.packages) == 2
        assert repo.packages[0].name == "pecot"
        assert repo.packages[0].changelog == "plugins/pecot-workflow/CHANGELOG.md"

    def test_packages_and_changelog_file_conflict(self) -> None:
        """packagesとchangelog_fileの同時指定はValidationError"""
        from pydantic import ValidationError

        with pytest.raises(ValidationError, match="同時指定できません"):
            Repository(
                owner="test-owner",
                name="test-repo",
                changelog_file="CHANGELOG.md",
                packages=[Package(name="pecot", changelog="plugins/pecot-workflow/CHANGELOG.md")],
            )

    def test_find_package(self) -> None:
        """find_package: パッケージ検索"""
        repo = Repository(
            owner="test-owner",
            name="test-repo",
            packages=[
                Package(name="pecot", changelog="plugins/pecot-workflow/CHANGELOG.md"),
                Package(name="pecotv", changelog="plugins/pecot-visual/CHANGELOG.md"),
            ],
        )
        pkg = repo.find_package("pecot")
        assert pkg is not None
        assert pkg.changelog == "plugins/pecot-workflow/CHANGELOG.md"

    def test_find_package_not_found(self) -> None:
        """find_package: 存在しないパッケージ"""
        repo = Repository(
            owner="test-owner",
            name="test-repo",
            packages=[Package(name="pecot", changelog="plugins/pecot-workflow/CHANGELOG.md")],
        )
        assert repo.find_package("unknown") is None

    def test_find_package_no_packages(self) -> None:
        """find_package: packages未設定ならNone"""
        repo = Repository(owner="test-owner", name="test-repo")
        assert repo.find_package("pecot") is None

    def test_packages_round_trip(self, tmp_path: Path) -> None:
        """packages 設定の JSON ラウンドトリップ"""
        config_dict = create_sample_config_dict()
        # 1つ目のリポを monorepo 化（changelog_fileは無いので排他問題なし）
        config_dict["repositories"][0] = {
            "owner": "test-owner",
            "name": "test-repo",
            "develop_branch": "develop",
            "release_branch": "main",
            "packages": [
                {"name": "pecot", "changelog": "plugins/pecot-workflow/CHANGELOG.md"},
                {"name": "pecotv", "changelog": "plugins/pecot-visual/CHANGELOG.md"},
            ],
        }
        config = ProjectConfig.model_validate(config_dict)

        output_file = tmp_path / "output.json"
        save_config(config, output_file)

        loaded = load_config(output_file)
        repo = loaded.find_repository("test-owner", "test-repo")
        assert repo is not None
        assert repo.packages is not None
        assert len(repo.packages) == 2
        assert repo.packages[0].name == "pecot"
        assert repo.find_package("pecotv").changelog == "plugins/pecot-visual/CHANGELOG.md"


class TestProjectConfig:
    """ProjectConfigモデルのテスト"""

    def test_from_dict(self) -> None:
        """辞書からインスタンス作成"""
        config = create_sample_config()
        assert config.host == "ghes.example.com"
        assert config.owner == "test-owner"
        assert config.project.number == 1
        assert len(config.repositories) == 2

    def test_get_field_id(self) -> None:
        """get_field_id: フィールドIDを取得"""
        config = create_sample_config()
        assert config.get_field_id("workflow") == "FIELD_workflow"
        assert config.get_field_id("priority") == "FIELD_priority"
        assert config.get_field_id("size") == "FIELD_size"

    def test_get_field_id_not_found(self) -> None:
        """get_field_id: 存在しないフィールド"""
        config = create_sample_config()
        assert config.get_field_id("nonexistent") is None

    def test_get_option_id(self) -> None:
        """get_option_id: オプションIDを取得"""
        config = create_sample_config()
        assert config.get_option_id("workflow", "active") == "opt_active"
        assert config.get_option_id("priority", "high") == "opt_high"

    def test_get_option_id_not_found(self) -> None:
        """get_option_id: 存在しないオプション"""
        config = create_sample_config()
        assert config.get_option_id("workflow", "nonexistent") is None
        assert config.get_option_id("nonexistent", "active") is None

    def test_find_repository(self) -> None:
        """find_repository: リポジトリを検索"""
        config = create_sample_config()
        repo = config.find_repository("test-owner", "test-repo")
        assert repo is not None
        assert repo.name == "test-repo"

    def test_find_repository_not_found(self) -> None:
        """find_repository: 存在しないリポジトリ"""
        config = create_sample_config()
        assert config.find_repository("test-owner", "nonexistent") is None

    def test_find_repository_by_name(self) -> None:
        """find_repository_by_name: 名前のみで検索"""
        config = create_sample_config()
        repo = config.find_repository_by_name("test-repo")
        assert repo is not None
        assert repo.owner == "test-owner"

    def test_find_repository_by_name_not_found(self) -> None:
        """find_repository_by_name: 存在しないリポジトリ"""
        config = create_sample_config()
        assert config.find_repository_by_name("nonexistent") is None

    def test_is_repo_in_project(self) -> None:
        """is_repo_in_project: リポジトリ登録確認（API経由）"""
        config = create_sample_config()

        # GitHubClientをモックしてAPI呼び出しをシミュレート
        mock_client = MagicMock()
        mock_client.get_linked_repositories_cached.return_value = [
            {"owner": "test-owner", "name": "test-repo"},
            {"owner": "test-owner", "name": "another-repo"},
        ]

        # clientを渡した場合
        assert config.is_repo_in_project("test-owner", "test-repo", mock_client) is True
        assert config.is_repo_in_project("test-owner", "nonexistent", mock_client) is False

        # clientを省略した場合（新しいGitHubClientが作成される）
        with patch("cli.core.github.GitHubClient", return_value=mock_client):
            assert config.is_repo_in_project("test-owner", "test-repo") is True
            assert config.is_repo_in_project("test-owner", "nonexistent") is False

    def test_get_develop_branch(self) -> None:
        """get_develop_branch: 開発ブランチを取得"""
        config = create_sample_config()
        assert config.get_develop_branch("test-owner", "test-repo") == "develop"
        assert config.get_develop_branch("test-owner", "another-repo") is None
        assert config.get_develop_branch("test-owner", "nonexistent") is None

    def test_get_release_branch(self) -> None:
        """get_release_branch: リリースブランチを取得"""
        config_dict = create_sample_config_dict()
        config_dict["repositories"][0]["release_branch"] = "main"
        config = ProjectConfig.model_validate(config_dict)
        assert config.get_release_branch("test-owner", "test-repo") == "main"
        assert config.get_release_branch("test-owner", "another-repo") is None
        assert config.get_release_branch("test-owner", "nonexistent") is None

    def test_release_branch_serialization(self, tmp_path: Path) -> None:
        """release_branchを含む設定のシリアライズ・デシリアライズ"""
        config_dict = create_sample_config_dict()
        config_dict["repositories"][0]["release_branch"] = "main"
        config = ProjectConfig.model_validate(config_dict)

        output_file = tmp_path / "output.json"
        save_config(config, output_file)

        loaded = load_config(output_file)
        assert loaded.get_release_branch("test-owner", "test-repo") == "main"
        assert loaded.get_release_branch("test-owner", "another-repo") is None

    def test_workflow_field_name(self) -> None:
        """workflow_field_nameプロパティがpecot-workflow-{suffix}を返す"""
        config = create_sample_config()
        assert config.workflow_field_name == "pecot-workflow-test"

    def test_workflow_suffix_required(self) -> None:
        """workflow_suffixが未指定の場合はValidationError"""
        from pydantic import ValidationError

        config_dict = create_sample_config_dict()
        del config_dict["workflow_suffix"]
        with pytest.raises(ValidationError):
            ProjectConfig.model_validate(config_dict)


# 例外クラステスト


class TestConfigError:
    """ConfigError例外のテスト"""

    def test_basic_error(self) -> None:
        """基本的なエラー"""
        with pytest.raises(ConfigError, match="テストエラー"):
            raise ConfigError("テストエラー")


# 設定操作関数テスト


class TestLoadConfig:
    """load_config関数のテスト"""

    def test_load_valid_config(self, tmp_path: Path) -> None:
        """有効な設定ファイルを読み込み"""
        config_file = tmp_path / "test.json"
        config_file.write_text(json.dumps(create_sample_config_dict()))

        config = load_config(config_file)
        assert config.host == "ghes.example.com"
        assert config.owner == "test-owner"

    def test_load_nonexistent_file(self, tmp_path: Path) -> None:
        """存在しないファイルはエラー"""
        with pytest.raises(ConfigError, match="設定ファイルが見つかりません"):
            load_config(tmp_path / "nonexistent.json")

    def test_load_invalid_json(self, tmp_path: Path) -> None:
        """不正なJSONはエラー"""
        import json

        config_file = tmp_path / "invalid.json"
        config_file.write_text("not valid json")

        with pytest.raises(json.JSONDecodeError):
            load_config(config_file)


class TestSaveConfig:
    """save_config関数のテスト"""

    def test_save_config(self, tmp_path: Path) -> None:
        """設定を保存"""
        config = create_sample_config()
        output_file = tmp_path / "output.json"

        save_config(config, output_file)

        assert output_file.exists()
        loaded = json.loads(output_file.read_text())
        assert loaded["host"] == "ghes.example.com"

    def test_save_creates_parent_dir(self, tmp_path: Path) -> None:
        """親ディレクトリがなければ作成"""
        config = create_sample_config()
        output_file = tmp_path / "subdir" / "output.json"

        save_config(config, output_file)

        assert output_file.exists()

    def test_save_excludes_none(self, tmp_path: Path) -> None:
        """Noneフィールドは出力しない"""
        workflow = FieldOptions(id="WF", options={})
        fields = ProjectFields(workflow=workflow)  # priority, sizeはNone
        project = Project(number=1, id="PVT", fields=fields)
        config = ProjectConfig(
            host="github.com", owner="test", workflow_suffix="test", project=project
        )

        output_file = tmp_path / "output.json"
        save_config(config, output_file)

        loaded = json.loads(output_file.read_text())
        assert "priority" not in loaded["project"]["fields"]
        assert "size" not in loaded["project"]["fields"]


class TestActiveConfig:
    """アクティブ設定関連関数のテスト"""

    def test_get_active_config_path_no_file(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """.activeファイルがない場合はNone"""
        import cli.core.config as config_module

        monkeypatch.setattr(config_module, "get_projects_dir", lambda: tmp_path)

        assert get_active_config_path() is None

    def test_get_active_config_path_with_file(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """.activeファイルがある場合はパスを返す"""
        import cli.core.config as config_module

        active_file = tmp_path / ".active"
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(create_sample_config_dict()))
        active_file.write_text(str(config_file))

        monkeypatch.setattr(config_module, "get_projects_dir", lambda: tmp_path)

        result = get_active_config_path()
        assert result == config_file

    def test_get_active_config_path_invalid_path(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """.activeファイルの指す先のパスが無い場合はNone"""
        import cli.core.config as config_module

        active_file = tmp_path / ".active"
        active_file.write_text("/nonexistent/path.json")

        monkeypatch.setattr(config_module, "get_projects_dir", lambda: tmp_path)

        assert get_active_config_path() is None

    def test_load_active_config(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """アクティブ設定をロード"""
        import cli.core.config as config_module

        active_file = tmp_path / ".active"
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(create_sample_config_dict()))
        active_file.write_text(str(config_file))

        monkeypatch.setattr(config_module, "get_projects_dir", lambda: tmp_path)

        config = load_active_config()
        assert config is not None
        assert config.host == "ghes.example.com"

    def test_load_active_config_none(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """アクティブ設定がない場合はNone"""
        import cli.core.config as config_module

        monkeypatch.setattr(config_module, "get_projects_dir", lambda: tmp_path)

        assert load_active_config() is None

    def test_set_active_config(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """アクティブ設定を設定"""
        import cli.core.config as config_module

        projects_dir = tmp_path / "projects"
        projects_dir.mkdir()
        active_file = projects_dir / ".active"
        config_file = projects_dir / "config.json"
        config_file.write_text(json.dumps(create_sample_config_dict()))

        monkeypatch.setattr(config_module, "get_projects_dir", lambda: projects_dir)

        set_active_config(config_file)

        assert active_file.exists()
        assert active_file.read_text().strip() == "config.json"
        assert (
            active_file.parent / active_file.read_text().strip()
        ).resolve() == config_file.resolve()

    def test_set_active_config_nonexistent(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """存在しないファイルはエラー"""
        import cli.core.config as config_module

        monkeypatch.setattr(config_module, "get_projects_dir", lambda: tmp_path)

        with pytest.raises(ConfigError, match="設定ファイルが見つかりません"):
            set_active_config(tmp_path / "nonexistent.json")
