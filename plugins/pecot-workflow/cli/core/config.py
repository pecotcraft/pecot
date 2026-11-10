"""core/config.py - Pydantic設定モデルと設定操作関数

このモジュールはプロジェクト設定ファイル（JSON）の読み書きと
Pydanticモデルによる型安全な設定管理を提供する。

既存のBashスクリプト（lib/config.sh）との互換性を維持しつつ、
Python環境での利用を可能にする。
"""

from __future__ import annotations

import json
import os
import re
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from cli.core.errors import PecotError
from cli.core.paths import CONFIG_DIR

if TYPE_CHECKING:
    from cli.core.github import GitHubClient
    from cli.core.repo_resolver import RepoRef

_AGGREGATION_REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

# Enumクラス


class WorkflowStatus(str, Enum):
    """ワークフローステータス（必須フィールド）

    GitHub Projects V2のワークフローフィールドで使用されるステータス値。
    """

    BACKLOG = "backlog"
    PENDING = "pending"
    READY = "ready"
    ACTIVE = "active"
    IN_REVIEW = "in_review"
    ARCHIVED = "archived"


class Priority(str, Enum):
    """優先度（オプショナルフィールド）

    タスクの優先度を表す。プロジェクトによっては未設定の場合がある。
    """

    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class Size(str, Enum):
    """サイズ（オプショナルフィールド）

    タスクの見積もりサイズを表す。プロジェクトによっては未設定の場合がある。
    """

    XS = "xs"
    S = "s"
    M = "m"
    L = "l"


# Pydanticモデル


class FieldOptions(BaseModel):
    """プロジェクトフィールドのオプション定義

    GitHub Projects V2の単一選択フィールド（SingleSelectField）を表す。

    Attributes:
        id: GraphQL フィールドID
        options: オプション名からオプションIDへのマッピング
    """

    id: str
    options: dict[str, str]  # option_name -> option_id

    def get_option_id(self, option_name: str) -> str | None:
        """オプション名からIDを取得

        Args:
            option_name: オプション名（例: "active", "high"）

        Returns:
            オプションID、見つからない場合はNone
        """
        return self.options.get(option_name)


class ProjectFields(BaseModel):
    """プロジェクトのフィールド定義

    GitHub Projects V2で使用されるカスタムフィールドを管理する。
    workflowは必須、priority/sizeはオプション。

    Attributes:
        workflow: ワークフローステータスフィールド（必須）
        priority: 優先度フィールド（オプション）
        size: サイズフィールド（オプション）
    """

    workflow: FieldOptions
    priority: FieldOptions | None = None
    size: FieldOptions | None = None

    def get_field(self, field_name: str) -> FieldOptions | None:
        """フィールド名からFieldOptionsを取得

        Args:
            field_name: フィールド名（"workflow", "priority", "size"）

        Returns:
            FieldOptionsオブジェクト、見つからない場合はNone
        """
        return getattr(self, field_name, None)


class Project(BaseModel):
    """GitHub Projects V2プロジェクト定義

    Attributes:
        number: プロジェクト番号（URLで使用）。
        id: GraphQL プロジェクトID。
        board_url: ボードURL（オプション、表示用）。
        fields: プロジェクトフィールド定義。
    """

    number: int
    id: str
    board_url: str | None = None
    fields: ProjectFields


class Package(BaseModel):
    """monorepo 内の個別パッケージ定義

    1 リポジトリに複数 CHANGELOG（per-package バージョニング）が存在する
    ケースで使用する。`name` はタグ prefix（`<name>-v<ver>`）にも用いられる。

    Attributes:
        name: パッケージ名（タグ prefix に使用、例: "pecot"）。
            タグ名に安全な文字のみ許可（`[A-Za-z0-9_.-]+`）。
        changelog: リポ root 相対の CHANGELOG パス（例: "plugins/pecot-workflow/CHANGELOG.md"）
    """

    name: str = Field(pattern=r"^[A-Za-z0-9_.-]+$", min_length=1)
    changelog: str = Field(min_length=1)


ReleaseType = Literal["single", "multi", "nx"]


class Repository(BaseModel):
    """リポジトリ定義

    プロジェクトに紐づくリポジトリの情報を管理する。

    Attributes:
        owner: リポジトリオーナー（ユーザー名またはorg名）。
        name: リポジトリ名。
        develop_branch: 開発ブランチ名（オプション）。
        release_branch: リリースブランチ名（オプション）。
        changelog_file: CHANGELOGファイル名（オプション、None=デフォルト動作）。
        packages: monorepo の per-package 定義（オプション、changelog_file と排他）。
        release_type: リリース種別の明示宣言（オプション）。
          - "single": 1 CHANGELOG + 1 タグ (`v<ver>`) の単一リポ
          - "multi":  packages ごとの CHANGELOG + `<pkg>-v<ver>` タグの monorepo
          - "nx":     Nx Release 方式 (.nx/nx-release/ と連携)。
          - None:     明示宣言なし。packages 有なら "multi"、無なら "single" 扱い
          w-release スキルはこの値で進め方を選ぶ。
    """

    owner: str
    name: str
    develop_branch: str | None = None
    release_branch: str | None = None
    changelog_file: str | None = None
    packages: list[Package] | None = None
    release_type: ReleaseType | None = None

    @model_validator(mode="after")
    def _check_changelog_file_and_packages_exclusive(self) -> Repository:
        """changelog_file と packages の同時指定を拒否

        monorepo 構成（packages 設定あり）では CHANGELOG は package ごとに
        管理するため、リポ全体の changelog_file は意味を持たない。
        """
        if self.packages and self.changelog_file:
            raise ValueError(
                "changelog_file and packages cannot be set together; "
                "in a monorepo, use packages[].changelog instead"
            )
        return self

    @property
    def effective_release_type(self) -> ReleaseType:
        """release_type が未指定の場合に packages 有無から推測した実効値。

        - 明示設定 → その値
        - 未設定 + packages 有 → "multi"
        - 未設定 + packages 無 → "single"
        """
        if self.release_type is not None:
            return self.release_type
        return "multi" if self.packages else "single"

    def find_package(self, name: str) -> Package | None:
        """パッケージ名で Package を検索

        Args:
            name: パッケージ名

        Returns:
            Package オブジェクト、見つからない場合は None
        """
        if not self.packages:
            return None
        for pkg in self.packages:
            if pkg.name == name:
                return pkg
        return None

    @property
    def full_name(self) -> str:
        """owner/name形式のフルネームを返す"""
        return f"{self.owner}/{self.name}"


class ProjectConfig(BaseModel):
    """プロジェクト設定のルートモデル

    設定ファイル（JSON）のルート構造を表す。
    複数のリポジトリを1つのプロジェクトに紐づけることができる。

    Attributes:
        host: GitHubホスト（例: "github.com", "ghes.example.com"）。
        owner: プロジェクトオーナー。
        workflow_suffix: ワークフローフィールド名のサフィックス。
        project: プロジェクト定義。
        repositories: 紐づくリポジトリのリスト。
    """

    host: str
    owner: str
    workflow_suffix: str
    project: Project
    repositories: list[Repository] = Field(default_factory=list[Repository])
    aggregation_repo: str | None = None

    @field_validator("aggregation_repo")
    @classmethod
    def _validate_aggregation_repo(cls, v: str | None) -> str | None:
        """aggregation_repo の形式バリデーション (FR-016)

        None (未指定) は許容。指定される場合は 'owner/repo' 形式で
        各セグメントは [A-Za-z0-9_.-]+ であること。
        """
        if v is None:
            return v
        if not _AGGREGATION_REPO_PATTERN.fullmatch(v):
            raise ValueError(f"aggregation_repo must be in 'owner/repo' form: {repr(v)}")
        return v

    @property
    def aggregation_repo_ref(self) -> RepoRef | None:
        """aggregation_repo を RepoRef に変換して返す (未設定なら None)"""
        from cli.core.repo_resolver import RepoRef

        return RepoRef.parse(self.aggregation_repo) if self.aggregation_repo else None

    @property
    def workflow_field_name(self) -> str:
        """GitHub Projects V2のworkflowフィールド名を返す"""
        return f"pecot-workflow-{self.workflow_suffix}"

    # フィールド操作メソッド

    def get_field_id(self, field_name: str) -> str | None:
        """フィールドIDを取得

        Args:
            field_name: フィールド名

        Returns:
            フィールドID、見つからない場合はNone
        """
        field = self.project.fields.get_field(field_name)
        return field.id if field else None

    def get_option_id(self, field_name: str, option_name: str) -> str | None:
        """オプションIDを取得

        Args:
            field_name: フィールド名
            option_name: オプション名

        Returns:
            オプションID、見つからない場合はNone
        """
        field = self.project.fields.get_field(field_name)
        return field.get_option_id(option_name) if field else None

    # リポジトリ操作メソッド

    def find_repository(self, owner: str, name: str) -> Repository | None:
        """リポジトリを検索

        Args:
            owner: リポジトリオーナー
            name: リポジトリ名

        Returns:
            Repositoryオブジェクト、見つからない場合はNone
        """
        for repo in self.repositories:
            if repo.owner == owner and repo.name == name:
                return repo
        return None

    def find_repository_by_name(self, name: str) -> Repository | None:
        """リポジトリ名のみで検索

        アクティブ設定内での検索用。ownerを指定せずにリポジトリを検索する。

        Args:
            name: リポジトリ名

        Returns:
            Repositoryオブジェクト、見つからない場合はNone
        """
        for repo in self.repositories:
            if repo.name == name:
                return repo
        return None

    def is_repo_in_project(self, owner: str, name: str, client: GitHubClient | None = None) -> bool:
        """リポジトリがプロジェクトにリンクされているか確認（API経由）

        GitHub APIを使用してプロジェクトにリンクされているリポジトリ一覧を取得し、
        指定されたリポジトリが含まれているかを確認する。

        Args:
            owner: リポジトリオーナー
            name: リポジトリ名
            client: GitHubClientインスタンス（省略時は新規作成）

        Returns:
            リンクされている場合True
        """
        if client is None:
            from cli.core.github import GitHubClient

            client = GitHubClient(host=self.host)

        repos = client.get_linked_repositories_cached(self.owner, self.project.number)
        return any(r.get("owner") == owner and r.get("name") == name for r in repos)

    def get_develop_branch(self, owner: str, name: str) -> str | None:
        """リポジトリの開発ブランチを取得

        Args:
            owner: リポジトリオーナー
            name: リポジトリ名

        Returns:
            開発ブランチ名、見つからない場合はNone
        """
        repo = self.find_repository(owner, name)
        return repo.develop_branch if repo else None

    def get_release_branch(self, owner: str, name: str) -> str | None:
        """リポジトリのリリースブランチを取得

        Args:
            owner: リポジトリオーナー
            name: リポジトリ名

        Returns:
            リリースブランチ名、見つからない場合はNone
        """
        repo = self.find_repository(owner, name)
        return repo.release_branch if repo else None


# 例外クラス


class ConfigError(PecotError):
    """設定操作エラーの基底クラス"""

    pass


# パス定数


def get_config_dir() -> Path:
    """設定ディレクトリのパスを取得

    Returns:
        設定ディレクトリの絶対パス (.../config/)
    """
    from cli.core.state import get_project_root

    return get_project_root() / CONFIG_DIR


def get_projects_dir() -> Path:
    """プロジェクト設定ディレクトリのパスを取得

    Returns:
        プロジェクト設定ディレクトリの絶対パス (.../config/projects/)
    """
    return get_config_dir() / "projects"


# 設定操作関数


def load_config(path: Path | str) -> ProjectConfig:
    """JSONファイルからProjectConfigを読み込み

    Args:
        path: 設定ファイルのパス

    Returns:
        ProjectConfigオブジェクト

    Raises:
        ConfigError: ファイルが見つからない場合
        ValidationError: JSONの形式が不正な場合
    """
    path = Path(path)
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")

    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    return ProjectConfig.model_validate(data)


def save_config(config: ProjectConfig, path: Path | str) -> None:
    """ProjectConfigをJSONファイルに保存

    Args:
        config: 保存するProjectConfig
        path: 保存先のパス
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with path.open("w", encoding="utf-8") as f:
        json.dump(config.model_dump(exclude_none=True), f, indent=2, ensure_ascii=False)
        f.write("\n")  # 末尾改行


def get_active_config_path() -> Path | None:
    """.activeファイルからアクティブ設定のパスを取得

    `.active` の中身は、`.active` のあるディレクトリを基準とした相対パス。

    Returns:
        アクティブ設定ファイルのパス、設定されていない場合はNone
    """
    active_file = get_projects_dir() / ".active"
    if not active_file.exists():
        return None

    raw = active_file.read_text().strip()
    if not raw:
        return None

    config_path = (active_file.parent / raw).resolve()
    if config_path.exists():
        return config_path
    return None


def load_active_config() -> ProjectConfig | None:
    """アクティブ設定をロード

    Returns:
        ProjectConfigオブジェクト、アクティブ設定がない場合はNone
    """
    config_path = get_active_config_path()
    if config_path is None:
        return None
    return load_config(config_path)


def set_active_config(path: Path | str) -> None:
    """アクティブ設定を設定

    Args:
        path: 設定ファイルのパス

    Raises:
        ConfigError: ファイルが見つからない場合
    """
    path = Path(path)
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")

    active_file = get_projects_dir() / ".active"
    active_file.parent.mkdir(parents=True, exist_ok=True)
    rel = os.path.relpath(path.absolute(), active_file.parent.absolute())
    active_file.write_text(rel + "\n")


# モジュールエクスポート

__all__ = [
    # Enums
    "WorkflowStatus",
    "Priority",
    "Size",
    # Models
    "FieldOptions",
    "ProjectFields",
    "Project",
    "Package",
    "Repository",
    "ProjectConfig",
    # Exceptions
    "ConfigError",
    # Path functions
    "get_config_dir",
    "get_projects_dir",
    # Config functions
    "load_config",
    "save_config",
    "load_active_config",
    "get_active_config_path",
    "set_active_config",
]
