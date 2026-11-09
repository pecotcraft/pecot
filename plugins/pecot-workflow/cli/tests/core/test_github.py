"""tests/core/test_github.py - github.pyのユニットテスト

GitHubClientクラスと例外クラスのテスト。
HTTPリクエストとsubprocessをモック化。
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest

from cli.core.github import (
    GitHubAPIError,
    GitHubAuthError,
    GitHubClient,
    GitHubNotFoundError,
    GitHubRateLimitError,
)
from cli.core.github.auth import (
    clear_hosts_config_cache,
    ensure_env_file,
    get_env_var_name,
    get_host_config,
    load_env_file,
    load_hosts_config,
)
from cli.core.github.client import resolve_api_url_override

# 例外クラステスト


class TestGitHubAPIError:
    """GitHubAPIError例外のテスト"""

    def test_basic_error(self) -> None:
        """基本的なエラー"""
        error = GitHubAPIError("テストエラー")
        assert error.message == "テストエラー"
        assert error.status_code is None
        assert error.response_body is None
        assert str(error) == "テストエラー"

    def test_with_status_code(self) -> None:
        """ステータスコード付きエラー"""
        error = GitHubAPIError("エラー", status_code=500, response_body='{"error": "test"}')
        assert error.status_code == 500
        assert error.response_body == '{"error": "test"}'


class TestGitHubAuthError:
    """GitHubAuthError例外のテスト"""

    def test_inheritance(self) -> None:
        """GitHubAPIErrorを継承"""
        error = GitHubAuthError("認証エラー")
        assert isinstance(error, GitHubAPIError)


class TestGitHubNotFoundError:
    """GitHubNotFoundError例外のテスト"""

    def test_inheritance(self) -> None:
        """GitHubAPIErrorを継承"""
        error = GitHubNotFoundError("リソースが見つかりません")
        assert isinstance(error, GitHubAPIError)


class TestGitHubRateLimitError:
    """GitHubRateLimitError例外のテスト"""

    def test_inheritance(self) -> None:
        """GitHubAPIErrorを継承"""
        error = GitHubRateLimitError("レート制限")
        assert isinstance(error, GitHubAPIError)


# ホスト設定管理テスト


class TestHostsConfig:
    """ホスト設定管理のテスト"""

    @pytest.fixture(autouse=True)
    def setup(self) -> None:
        """各テスト前にキャッシュをクリア"""
        clear_hosts_config_cache()
        yield
        clear_hosts_config_cache()

    def test_load_hosts_config_from_file(self, tmp_path: Path) -> None:
        """hosts.jsonからホスト設定を読み込み"""
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {
                    "env_var": "PECOT_GITHUB_COM_TOKEN",
                    "token_url": "https://github.com/settings/tokens",
                    "description": "GitHub.com",
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            config = load_hosts_config()
            assert config == hosts_data

    def test_load_hosts_config_file_not_found(self, tmp_path: Path) -> None:
        """hosts.jsonが存在しない場合は空の設定"""
        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            config = load_hosts_config()
            assert config == {"hosts": {}}

    def test_load_hosts_config_cached(self, tmp_path: Path) -> None:
        """ホスト設定がキャッシュされる"""
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {"hosts": {"github.com": {"env_var": "TEST_TOKEN"}}}
        hosts_file.write_text(json.dumps(hosts_data))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            config1 = load_hosts_config()
            # ファイルを削除
            hosts_file.unlink()
            # キャッシュが返される
            config2 = load_hosts_config()
            assert config1 == config2

    def test_get_host_config_found(self, tmp_path: Path) -> None:
        """定義済みホストの設定を取得"""
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "ghes.example.com": {
                    "env_var": "PECOT_GITHUB_GHES_TOKEN",
                    "token_url": "https://ghes.example.com/settings/tokens",
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            host_config = get_host_config("ghes.example.com")
            assert host_config is not None
            assert host_config["env_var"] == "PECOT_GITHUB_GHES_TOKEN"

    def test_get_host_config_not_found(self, tmp_path: Path) -> None:
        """未定義ホストはNoneを返す"""
        hosts_file = tmp_path / "hosts.json"
        hosts_file.write_text(json.dumps({"hosts": {}}))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            host_config = get_host_config("unknown.host.com")
            assert host_config is None

    def test_get_env_var_name_from_config(self, tmp_path: Path) -> None:
        """hosts.jsonから環境変数名を取得"""
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {"env_var": "PECOT_GITHUB_COM_TOKEN"},
                "ghes.example.com": {"env_var": "PECOT_GITHUB_GHES_TOKEN"},
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            assert get_env_var_name("github.com") == "PECOT_GITHUB_COM_TOKEN"
            clear_hosts_config_cache()

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            assert get_env_var_name("ghes.example.com") == "PECOT_GITHUB_GHES_TOKEN"

    def test_get_env_var_name_fallback(self, tmp_path: Path) -> None:
        """未定義ホストはフォールバック命名規則を適用"""
        hosts_file = tmp_path / "hosts.json"
        hosts_file.write_text(json.dumps({"hosts": {}}))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            # ドットをアンダースコアに変換
            assert get_env_var_name("gitlab.example.com") == "PECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN"

    def test_get_env_var_name_github_com_without_hosts_json(self, tmp_path: Path) -> None:
        """hosts.json が無い checkout でも、github.com は PECOT_GITHUB_COM_TOKEN を読む"""
        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            assert not (tmp_path / "hosts.json").exists()
            assert get_env_var_name("github.com") == "PECOT_GITHUB_COM_TOKEN"

    def test_get_env_var_name_hosts_json_overrides_default(self, tmp_path: Path) -> None:
        """hosts.json の定義は既定の対応より優先する"""
        hosts_file = tmp_path / "hosts.json"
        hosts_file.write_text(json.dumps({"hosts": {"github.com": {"env_var": "MY_TOKEN"}}}))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            assert get_env_var_name("github.com") == "MY_TOKEN"


class TestLoadEnvFile:
    """環境変数ファイル読み込みのテスト"""

    def test_load_env_file_basic(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """基本的なKEY=VALUE形式の読み込み"""
        env_file = tmp_path / ".env"
        env_file.write_text("TEST_KEY=test_value\nANOTHER_KEY=another_value\n")

        # 既存の環境変数をクリア
        monkeypatch.delenv("TEST_KEY", raising=False)
        monkeypatch.delenv("ANOTHER_KEY", raising=False)

        load_env_file(env_file)

        assert os.environ.get("TEST_KEY") == "test_value"
        assert os.environ.get("ANOTHER_KEY") == "another_value"

    def test_load_env_file_skip_comments(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """コメント行をスキップ"""
        env_file = tmp_path / ".env"
        env_file.write_text("# This is a comment\nVALID_KEY=valid_value\n# Another comment\n")

        monkeypatch.delenv("VALID_KEY", raising=False)

        load_env_file(env_file)

        assert os.environ.get("VALID_KEY") == "valid_value"

    def test_load_env_file_skip_empty_lines(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """空行をスキップ"""
        env_file = tmp_path / ".env"
        env_file.write_text("\n\nEMPTY_TEST_KEY=value\n\n")

        monkeypatch.delenv("EMPTY_TEST_KEY", raising=False)

        load_env_file(env_file)

        assert os.environ.get("EMPTY_TEST_KEY") == "value"

    def test_load_env_file_no_overwrite(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """既存の環境変数を上書きしない"""
        env_file = tmp_path / ".env"
        env_file.write_text("EXISTING_KEY=new_value\n")

        monkeypatch.setenv("EXISTING_KEY", "original_value")

        load_env_file(env_file)

        # 元の値が保持される
        assert os.environ.get("EXISTING_KEY") == "original_value"

    def test_load_env_file_not_found(self, tmp_path: Path) -> None:
        """ファイルが存在しない場合は何もしない"""
        env_file = tmp_path / "nonexistent.env"
        # エラーが発生しないことを確認
        load_env_file(env_file)


class TestEnsureEnvFile:
    """_ensure_env_file関数のテスト"""

    @pytest.fixture(autouse=True)
    def setup(self) -> None:
        """各テスト前にキャッシュをクリア"""
        clear_hosts_config_cache()
        yield
        clear_hosts_config_cache()

    def test_ensure_env_file_creates_new_file(self, tmp_path: Path) -> None:
        """新規.envファイルを作成"""
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "ghes.example.com": {
                    "env_var": "PECOT_GITHUB_GHES_TOKEN",
                    "token_url": "https://ghes.example.com/settings/tokens",
                    "description": "GitHub Enterprise Server",
                    "scopes": ["repo", "read:org", "project"],
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            env_file = ensure_env_file("ghes.example.com")

            assert env_file.exists()
            content = env_file.read_text()
            assert "PECOT_GITHUB_GHES_TOKEN=" in content
            assert "ghes.example.com/settings/tokens" in content
            assert "repo, read:org, project" in content
            assert "GitHub Enterprise Server" in content

    def test_ensure_env_file_appends_to_existing(self, tmp_path: Path) -> None:
        """既存.envファイルに追記"""
        # 既存の.envファイル
        env_file = tmp_path / ".env"
        env_file.write_text("EXISTING_VAR=value\n")

        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {
                    "env_var": "PECOT_GITHUB_COM_TOKEN",
                    "token_url": "https://github.com/settings/tokens",
                    "description": "GitHub.com",
                    "scopes": ["repo"],
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            result = ensure_env_file("github.com")

            content = result.read_text()
            # 既存の内容が保持される
            assert "EXISTING_VAR=value" in content
            # 新しい環境変数が追加される
            assert "PECOT_GITHUB_COM_TOKEN=" in content

    def test_ensure_env_file_skips_existing_var(self, tmp_path: Path) -> None:
        """既に環境変数が定義されている場合は追記しない"""
        env_file = tmp_path / ".env"
        env_file.write_text("PECOT_GITHUB_COM_TOKEN=existing_token\n")

        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {
                    "env_var": "PECOT_GITHUB_COM_TOKEN",
                    "token_url": "https://github.com/settings/tokens",
                    "description": "GitHub.com",
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            ensure_env_file("github.com")

            content = env_file.read_text()
            # 環境変数は1回だけ
            assert content.count("PECOT_GITHUB_COM_TOKEN") == 1

    def test_ensure_env_file_unknown_host_fallback(self, tmp_path: Path) -> None:
        """未定義ホストでもフォールバック命名規則で.envを生成"""
        hosts_file = tmp_path / "hosts.json"
        hosts_file.write_text(json.dumps({"hosts": {}}))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            env_file = ensure_env_file("gitlab.example.com")

            content = env_file.read_text()
            assert "PECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN=" in content

    def test_ensure_env_file_no_scopes(self, tmp_path: Path) -> None:
        """スコープが定義されていない場合はスコープ行を出力しない"""
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {
                    "env_var": "PECOT_GITHUB_COM_TOKEN",
                    "token_url": "https://github.com/settings/tokens",
                    "description": "GitHub.com",
                    # scopes なし
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        with patch("cli.core.github.auth.get_config_dir", return_value=tmp_path):
            env_file = ensure_env_file("github.com")

            content = env_file.read_text()
            assert "必要なスコープ:" not in content


# GitHubClient初期化テスト


class TestGitHubClientInit:
    """GitHubClient初期化のテスト"""

    @pytest.fixture(autouse=True)
    def setup(self) -> None:
        """各テスト前にキャッシュをクリア"""
        clear_hosts_config_cache()
        yield
        clear_hosts_config_cache()

    def test_init_with_token(self) -> None:
        """トークン指定で初期化"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            assert client.host == "github.com"
            assert client.token == "test_token"
            assert client.api_url == "https://api.github.com"
            assert client.graphql_url == "https://api.github.com/graphql"

    def test_init_ghes(self) -> None:
        """GitHub Enterprise Server用URL設定"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="ghes.example.com", token="test_token")
            assert client.api_url == "https://ghes.example.com/api/v3"
            assert client.graphql_url == "https://ghes.example.com/api/graphql"

    def test_init_get_token_from_env(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """環境変数からトークン取得（優先順位1）"""
        # hosts.json を作成
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "ghes.example.com": {
                    "env_var": "PECOT_GITHUB_GHES_TOKEN",
                    "token_url": "https://ghes.example.com/settings/tokens",
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        # 環境変数を設定
        monkeypatch.setenv("PECOT_GITHUB_GHES_TOKEN", "env_token_from_test")

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch.object(GitHubClient, "_setup_clients"),
        ):
            client = GitHubClient(host="ghes.example.com")
            # 環境変数のトークンが使われる
            assert client.token == "env_token_from_test"

    def test_init_get_token_from_env_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """config/.envファイルからトークン取得"""
        # hosts.json を作成
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {
                    "env_var": "PECOT_GITHUB_COM_TOKEN",
                    "token_url": "https://github.com/settings/tokens",
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        # .envファイルを作成
        env_file = tmp_path / ".env"
        env_file.write_text("PECOT_GITHUB_COM_TOKEN=token_from_env_file\n")

        # 環境変数をクリア
        monkeypatch.delenv("PECOT_GITHUB_COM_TOKEN", raising=False)

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch.object(GitHubClient, "_setup_clients"),
        ):
            client = GitHubClient(host="github.com")
            # .envファイルのトークンが使われる
            assert client.token == "token_from_env_file"

    def test_init_get_token_from_root_env_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """ルート .env からトークン取得（config/.env にない場合のフォールバック）"""
        # hosts.json を作成
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {
                    "env_var": "PECOT_GITHUB_COM_TOKEN",
                    "token_url": "https://github.com/settings/tokens",
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        # config/.env は作成しない（トークンなし）
        # ルート .env にトークンを配置
        root_dir = tmp_path / "root"
        root_dir.mkdir()
        root_env_file = root_dir / ".env"
        root_env_file.write_text("GITHUB_COM_TOKEN=root_token\n")

        # 環境変数をクリア
        monkeypatch.delenv("PECOT_GITHUB_COM_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_COM_TOKEN", raising=False)

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch("cli.core.github.auth.get_project_root", return_value=root_dir),
            patch.object(GitHubClient, "_setup_clients"),
        ):
            client = GitHubClient(host="github.com")
            assert client.token == "root_token"

    def test_init_config_env_takes_priority_over_root_env(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """config/.env のトークンがルート .env より優先される"""
        # hosts.json を作成
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {
                    "env_var": "PECOT_GITHUB_COM_TOKEN",
                    "token_url": "https://github.com/settings/tokens",
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        # config/.env にトークンを配置
        env_file = tmp_path / ".env"
        env_file.write_text("PECOT_GITHUB_COM_TOKEN=config_token\n")

        # ルート .env にもトークンを配置
        root_dir = tmp_path / "root"
        root_dir.mkdir()
        root_env_file = root_dir / ".env"
        root_env_file.write_text("GITHUB_COM_TOKEN=root_token\n")

        # 環境変数をクリア
        monkeypatch.delenv("PECOT_GITHUB_COM_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_COM_TOKEN", raising=False)

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch("cli.core.github.auth.get_project_root", return_value=root_dir),
            patch.object(GitHubClient, "_setup_clients"),
        ):
            client = GitHubClient(host="github.com")
            # config/.env が優先される
            assert client.token == "config_token"

    def test_init_root_env_takes_priority_over_gh(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """ルート .env のトークンが gh auth token より優先される"""
        # hosts.json を作成
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {
                    "env_var": "PECOT_GITHUB_COM_TOKEN",
                    "token_url": "https://github.com/settings/tokens",
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        # config/.env は作成しない
        # ルート .env にトークンを配置
        root_dir = tmp_path / "root"
        root_dir.mkdir()
        root_env_file = root_dir / ".env"
        root_env_file.write_text("GITHUB_COM_TOKEN=root_com_token\n")

        # 環境変数をクリア
        monkeypatch.delenv("PECOT_GITHUB_COM_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_COM_TOKEN", raising=False)

        mock_result = MagicMock()
        mock_result.stdout = "gh_token_should_not_be_used\n"

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch("cli.core.github.auth.get_project_root", return_value=root_dir),
            patch("subprocess.run", return_value=mock_result) as mock_run,
            patch.object(GitHubClient, "_setup_clients"),
        ):
            client = GitHubClient(host="github.com")
            # ルート .env が gh より優先される
            assert client.token == "root_com_token"
            # gh auth token は呼ばれない
            mock_run.assert_not_called()

    def test_init_root_env_unmapped_host_falls_through(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """ROOT_ENV_VAR_MAP にないホストは gh auth token にフォールバック"""
        # hosts.json を作成（空）
        hosts_file = tmp_path / "hosts.json"
        hosts_file.write_text(json.dumps({"hosts": {}}))

        # ルート .env にトークンを配置（マッピングにないホスト用）
        root_dir = tmp_path / "root"
        root_dir.mkdir()
        root_env_file = root_dir / ".env"
        root_env_file.write_text("SOME_TOKEN=unused\n")

        # 環境変数をクリア
        monkeypatch.delenv("PECOT_GITHUB_GITLAB_EXAMPLE_COM_TOKEN", raising=False)

        mock_result = MagicMock()
        mock_result.stdout = "gh_fallback_token\n"

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch("cli.core.github.auth.get_project_root", return_value=root_dir),
            patch("subprocess.run", return_value=mock_result) as mock_run,
            patch.object(GitHubClient, "_setup_clients"),
        ):
            client = GitHubClient(host="gitlab.example.com")
            # マッピングにないホストは gh にフォールバック
            assert client.token == "gh_fallback_token"
            mock_run.assert_called_once()

    def test_init_get_token_from_gh(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """gh auth tokenからトークン取得（フォールバック）"""
        # hosts.json を作成（空）
        hosts_file = tmp_path / "hosts.json"
        hosts_file.write_text(json.dumps({"hosts": {}}))

        # 環境変数をクリア
        monkeypatch.delenv("PECOT_GITHUB_GITHUB_COM_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_COM_TOKEN", raising=False)

        mock_result = MagicMock()
        mock_result.stdout = "gh_token_123\n"

        # ルート .env が存在しないディレクトリを指す
        empty_root = tmp_path / "empty_root"
        empty_root.mkdir()

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch("cli.core.github.auth.get_project_root", return_value=empty_root),
            patch("subprocess.run", return_value=mock_result) as mock_run,
            patch.object(GitHubClient, "_setup_clients"),
        ):
            client = GitHubClient(host="github.com")
            assert client.token == "gh_token_123"
            mock_run.assert_called_once_with(
                ["gh", "auth", "token"],
                capture_output=True,
                text=True,
                check=True,
            )

    def test_init_get_token_from_gh_ghes(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """gh auth tokenからGHES用トークン取得"""
        # hosts.json を作成（空）
        hosts_file = tmp_path / "hosts.json"
        hosts_file.write_text(json.dumps({"hosts": {}}))

        # 環境変数をクリア
        monkeypatch.delenv("PECOT_GITHUB_GHES_EXAMPLE_COM_TOKEN", raising=False)

        mock_result = MagicMock()
        mock_result.stdout = "ghes_token_456\n"

        # ルート .env が存在しないディレクトリを指す
        empty_root = tmp_path / "empty_root"
        empty_root.mkdir()

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch("cli.core.github.auth.get_project_root", return_value=empty_root),
            patch("subprocess.run", return_value=mock_result) as mock_run,
            patch.object(GitHubClient, "_setup_clients"),
        ):
            client = GitHubClient(host="ghes.example.com")
            assert client.token == "ghes_token_456"
            mock_run.assert_called_once_with(
                ["gh", "auth", "token", "-h", "ghes.example.com"],
                capture_output=True,
                text=True,
                check=True,
            )

    def test_init_auth_error_with_guidance(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """認証エラー時に.envファイルを自動生成し誘導メッセージを表示"""
        # hosts.json を作成
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "ghes.example.com": {
                    "env_var": "PECOT_GITHUB_GHES_TOKEN",
                    "token_url": "https://ghes.example.com/settings/tokens",
                    "description": "GitHub Enterprise Server",
                    "scopes": ["repo", "read:org", "project"],
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        # 環境変数をクリア
        monkeypatch.delenv("PECOT_GITHUB_GHES_TOKEN", raising=False)

        # ルート .env が存在しないディレクトリを指す
        empty_root = tmp_path / "empty_root"
        empty_root.mkdir()

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch("cli.core.github.auth.get_project_root", return_value=empty_root),
            patch(
                "subprocess.run",
                side_effect=subprocess.CalledProcessError(1, "gh", stderr="auth error"),
            ),
        ):
            with pytest.raises(GitHubAuthError) as exc_info:
                GitHubClient(host="ghes.example.com")

            # エラーメッセージに誘導が含まれる
            error_msg = str(exc_info.value)
            assert "PECOT_GITHUB_GHES_TOKEN" in error_msg
            assert "https://ghes.example.com/settings/tokens" in error_msg
            assert "gh auth login -h ghes.example.com" in error_msg
            assert "repo, read:org, project" in error_msg  # スコープ情報

            # .envファイルが自動生成されている
            env_file = tmp_path / ".env"
            assert env_file.exists()
            env_content = env_file.read_text()
            assert "PECOT_GITHUB_GHES_TOKEN=" in env_content

    def test_init_gh_not_found_with_guidance(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """ghコマンドが見つからない場合も.envを自動生成し誘導メッセージを表示"""
        # hosts.json を作成
        hosts_file = tmp_path / "hosts.json"
        hosts_data = {
            "hosts": {
                "github.com": {
                    "env_var": "PECOT_GITHUB_COM_TOKEN",
                    "token_url": "https://github.com/settings/tokens",
                    "description": "GitHub.com",
                    "scopes": ["repo"],
                }
            }
        }
        hosts_file.write_text(json.dumps(hosts_data))

        # 環境変数をクリア
        monkeypatch.delenv("PECOT_GITHUB_COM_TOKEN", raising=False)
        monkeypatch.delenv("GITHUB_COM_TOKEN", raising=False)

        # ルート .env が存在しないディレクトリを指す
        empty_root = tmp_path / "empty_root"
        empty_root.mkdir()

        with (
            patch("cli.core.github.auth.get_config_dir", return_value=tmp_path),
            patch("cli.core.github.auth.get_project_root", return_value=empty_root),
            patch("subprocess.run", side_effect=FileNotFoundError()),
        ):
            with pytest.raises(GitHubAuthError) as exc_info:
                GitHubClient(host="github.com")

            # エラーメッセージに誘導が含まれる
            error_msg = str(exc_info.value)
            assert "PECOT_GITHUB_COM_TOKEN" in error_msg
            assert "https://github.com/settings/tokens" in error_msg

            # .envファイルが自動生成されている
            env_file = tmp_path / ".env"
            assert env_file.exists()


# GitHubClientエラーハンドリングテスト


class TestGitHubClientErrorHandling:
    """_handle_http_error メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント"""
        with patch.object(GitHubClient, "_setup_clients"):
            return GitHubClient(host="github.com", token="test_token")

    def test_handle_401_error(self, client: GitHubClient) -> None:
        """401エラー → GitHubAuthError"""
        response = MagicMock(spec=httpx.Response)
        response.status_code = 401
        response.text = "Unauthorized"

        with pytest.raises(GitHubAuthError, match="認証に失敗"):
            client._handle_http_error(response)

    def test_handle_404_error(self, client: GitHubClient) -> None:
        """404エラー → GitHubNotFoundError"""
        response = MagicMock(spec=httpx.Response)
        response.status_code = 404
        response.text = "Not Found"
        response.url = "https://api.github.com/repos/test/test"

        with pytest.raises(GitHubNotFoundError, match="リソースが見つかりません"):
            client._handle_http_error(response)

    def test_handle_403_rate_limit(self, client: GitHubClient) -> None:
        """403エラー（rate limit）→ GitHubRateLimitError"""
        response = MagicMock(spec=httpx.Response)
        response.status_code = 403
        response.text = "API rate limit exceeded"

        with pytest.raises(GitHubRateLimitError, match="レート制限"):
            client._handle_http_error(response)

    def test_handle_403_other(self, client: GitHubClient) -> None:
        """403エラー（その他）→ GitHubAPIError"""
        response = MagicMock(spec=httpx.Response)
        response.status_code = 403
        response.text = "Forbidden"

        with pytest.raises(GitHubAPIError, match="アクセスが拒否"):
            client._handle_http_error(response)

    def test_handle_500_error(self, client: GitHubClient) -> None:
        """500エラー → GitHubAPIError"""
        response = MagicMock(spec=httpx.Response)
        response.status_code = 500
        response.text = "Internal Server Error"

        with pytest.raises(GitHubAPIError, match="GitHub APIエラー: 500"):
            client._handle_http_error(response)


# GitHubClient REST APIテスト


class TestGitHubClientRestAPI:
    """REST APIメソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            client._used_fallback = True  # gh auth token によるフォールバックを抑制
            return client

    def test_create_issue_success(self, client: GitHubClient) -> None:
        """create_issue: 成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "number": 124,
            "title": "New Issue",
        }
        client._rest.post.return_value = mock_response

        result = client.create_issue("owner", "repo", "New Issue", "Body text", ["bug"])

        assert result["number"] == 124
        client._rest.post.assert_called_once_with(
            "/repos/owner/repo/issues",
            json={"title": "New Issue", "body": "Body text", "labels": ["bug"]},
        )

    def test_create_issue_without_labels(self, client: GitHubClient) -> None:
        """create_issue: ラベルなし"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {"number": 125}
        client._rest.post.return_value = mock_response

        client.create_issue("owner", "repo", "Title", "Body")

        client._rest.post.assert_called_once_with(
            "/repos/owner/repo/issues",
            json={"title": "Title", "body": "Body"},
        )

    def test_add_issue_comment_success(self, client: GitHubClient) -> None:
        """add_issue_comment: 成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {"id": 456, "body": "Test comment"}
        client._rest.post.return_value = mock_response

        result = client.add_issue_comment("owner", "repo", 123, "Test comment")

        assert result["id"] == 456
        client._rest.post.assert_called_once_with(
            "/repos/owner/repo/issues/123/comments",
            json={"body": "Test comment"},
        )

    def test_update_issue_comment_success(self, client: GitHubClient) -> None:
        """update_issue_comment: コメント ID 宛てに PATCH する"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {"id": 456, "body": "New"}
        client._rest.patch.return_value = mock_response

        result = client.update_issue_comment("owner", "repo", 456, "New")

        assert result["id"] == 456
        client._rest.patch.assert_called_once_with(
            "/repos/owner/repo/issues/comments/456",
            json={"body": "New"},
        )

    def test_list_open_dependabot_alerts_single_page(self, client: GitHubClient) -> None:
        """list_open_dependabot_alerts: 1 ページ"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = [{"number": 1}, {"number": 2}]
        mock_response.links = {}
        client._rest.get.return_value = mock_response

        result = client.list_open_dependabot_alerts("owner", "repo")

        assert result == [{"number": 1}, {"number": 2}]
        client._rest.get.assert_called_once_with(
            "/repos/owner/repo/dependabot/alerts",
            params={"state": "open", "per_page": 100},
        )

    def test_list_open_dependabot_alerts_follows_next_link(self, client: GitHubClient) -> None:
        """list_open_dependabot_alerts: 2 ページ目は絶対 URL を params 無しで辿る"""
        next_url = "https://api.example.com/repos/owner/repo/dependabot/alerts?after=abc"
        first = MagicMock()
        first.is_success = True
        first.json.return_value = [{"number": 1}]
        first.links = {"next": {"url": next_url, "rel": "next"}}
        second = MagicMock()
        second.is_success = True
        second.json.return_value = [{"number": 2}]
        second.links = {}
        client._rest.get.side_effect = [first, second]

        result = client.list_open_dependabot_alerts("owner", "repo")

        assert result == [{"number": 1}, {"number": 2}]
        calls = client._rest.get.call_args_list
        assert len(calls) == 2
        assert calls[0].args == ("/repos/owner/repo/dependabot/alerts",)
        assert calls[0].kwargs == {"params": {"state": "open", "per_page": 100}}
        assert calls[1].args == (next_url,)
        assert calls[1].kwargs == {"params": None}

    def test_list_open_code_scanning_alerts_no_ref(self, client: GitHubClient) -> None:
        """list_open_code_scanning_alerts: ref を付けず（既定ブランチ）、Link を辿る"""
        next_url = "https://api.example.com/repos/owner/repo/code-scanning/alerts?page=2"
        first = MagicMock()
        first.is_success = True
        first.json.return_value = [{"number": 1}]
        first.links = {"next": {"url": next_url, "rel": "next"}}
        second = MagicMock()
        second.is_success = True
        second.json.return_value = [{"number": 2}]
        second.links = {}
        client._rest.get.side_effect = [first, second]

        result = client.list_open_code_scanning_alerts("owner", "repo")

        assert result == [{"number": 1}, {"number": 2}]
        calls = client._rest.get.call_args_list
        assert calls[0].args == ("/repos/owner/repo/code-scanning/alerts",)
        assert calls[0].kwargs == {"params": {"state": "open", "per_page": 100}}
        assert calls[1].args == (next_url,)
        assert calls[1].kwargs == {"params": None}

    def test_list_open_secret_scanning_alerts_hides_secret(self, client: GitHubClient) -> None:
        """list_open_secret_scanning_alerts: 必ず hide_secret=true を付ける"""
        response = MagicMock()
        response.is_success = True
        response.json.return_value = [{"number": 1}]
        response.links = {}
        client._rest.get.return_value = response

        assert client.list_open_secret_scanning_alerts("owner", "repo") == [{"number": 1}]
        client._rest.get.assert_called_once_with(
            "/repos/owner/repo/secret-scanning/alerts",
            params={"state": "open", "hide_secret": "true", "per_page": 100},
        )

    @pytest.mark.parametrize(
        ("body", "expected"),
        [
            ({"security_and_analysis": {"secret_scanning": {"status": "disabled"}}}, "disabled"),
            ({"security_and_analysis": {"secret_scanning": {"status": "enabled"}}}, "enabled"),
            ({"security_and_analysis": None}, None),
            ({"name": "repo"}, None),
        ],
    )
    def test_get_secret_scanning_status(
        self, client: GitHubClient, body: dict[str, Any], expected: str | None
    ) -> None:
        """get_secret_scanning_status: security_and_analysis が無ければ None（権限不足）"""
        response = MagicMock()
        response.is_success = True
        response.json.return_value = body
        client._rest.get.return_value = response

        assert client.get_secret_scanning_status("owner", "repo") == expected
        client._rest.get.assert_called_once_with("/repos/owner/repo")

    def test_list_issues_by_label_all_states_without_pulls(self, client: GitHubClient) -> None:
        """list_issues_by_label: open と closed を引き、PR を除く"""
        response = MagicMock()
        response.is_success = True
        response.json.return_value = [{"number": 1}, {"number": 2, "pull_request": {}}]
        response.links = {}
        client._rest.get.return_value = response

        assert client.list_issues_by_label("owner", "repo", "security-alert") == [{"number": 1}]
        client._rest.get.assert_called_once_with(
            "/repos/owner/repo/issues",
            params={"state": "all", "labels": "security-alert", "per_page": 100},
        )

    def test_list_open_dependabot_alerts_forbidden(self, client: GitHubClient) -> None:
        """list_open_dependabot_alerts: 403 は GitHubAPIError（status_code 403）"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 403
        mock_response.text = '{"message":"Dependabot alerts are disabled for this repository."}'
        client._rest.get.return_value = mock_response

        with pytest.raises(GitHubAPIError) as exc_info:
            client.list_open_dependabot_alerts("owner", "repo")

        assert exc_info.value.status_code == 403
        assert "disabled" in (exc_info.value.response_body or "")

    @pytest.mark.parametrize(("status_code", "expected"), [(204, True), (404, False)])
    def test_is_dependabot_alerts_enabled(
        self, client: GitHubClient, status_code: int, expected: bool
    ) -> None:
        """is_dependabot_alerts_enabled: 204 は有効、404 は無効"""
        mock_response = MagicMock()
        mock_response.status_code = status_code
        client._rest.get.return_value = mock_response

        assert client.is_dependabot_alerts_enabled("owner", "repo") is expected
        client._rest.get.assert_called_once_with("/repos/owner/repo/vulnerability-alerts")

    def test_is_dependabot_alerts_enabled_forbidden(self, client: GitHubClient) -> None:
        """is_dependabot_alerts_enabled: 403 は例外"""
        mock_response = MagicMock()
        mock_response.status_code = 403
        mock_response.text = "forbidden"
        client._rest.get.return_value = mock_response

        with pytest.raises(GitHubAPIError) as exc_info:
            client.is_dependabot_alerts_enabled("owner", "repo")

        assert exc_info.value.status_code == 403

    def test_get_authenticated_user_success(self, client: GitHubClient) -> None:
        """get_authenticated_user: 成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "login": "test-user",
            "id": 12345,
            "name": "Test User",
            "email": "test@example.com",
        }
        client._rest.get.return_value = mock_response

        result = client.get_authenticated_user()

        assert result["login"] == "test-user"
        assert result["id"] == 12345
        client._rest.get.assert_called_once_with("/user")

    def test_get_authenticated_user_auth_error(self, client: GitHubClient) -> None:
        """get_authenticated_user: 認証エラー"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"
        client._rest.get.return_value = mock_response

        with pytest.raises(GitHubAuthError):
            client.get_authenticated_user()


# GitHubClient GraphQL APIテスト


class TestGitHubClientGraphQL:
    """GraphQL APIメソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._graphql = MagicMock()
            client._used_fallback = True  # gh auth token によるフォールバックを抑制
            return client
        """_execute_graphql: 成功"""
        client._graphql.execute.return_value = {"data": "test"}

        result = client._execute_graphql("query { test }", {"var": "value"})

        assert result == {"data": "test"}

    def test_execute_graphql_auth_error(self, client: GitHubClient) -> None:
        """_execute_graphql: 認証エラー"""
        client._graphql.execute.side_effect = Exception("401 Unauthorized")

        with pytest.raises(GitHubAuthError, match="GraphQL認証エラー"):
            client._execute_graphql("query { test }")

    def test_execute_graphql_rate_limit(self, client: GitHubClient) -> None:
        """_execute_graphql: レート制限"""
        client._graphql.execute.side_effect = Exception("API rate limit exceeded")

        with pytest.raises(GitHubRateLimitError, match="GraphQLレート制限"):
            client._execute_graphql("query { test }")

    def test_execute_graphql_other_error(self, client: GitHubClient) -> None:
        """_execute_graphql: その他のエラー"""
        client._graphql.execute.side_effect = Exception("Some other error")

        with pytest.raises(GitHubAPIError, match="GraphQLクエリ実行エラー"):
            client._execute_graphql("query { test }")

    def test_get_issue_node_id_success(self, client: GitHubClient) -> None:
        """get_issue_node_id: 成功"""
        client._graphql.execute.return_value = {"repository": {"issue": {"id": "I_kwDOtest123"}}}

        result = client.get_issue_node_id("owner", "repo", 123)

        assert result == "I_kwDOtest123"

    def test_get_issue_node_id_and_title_success(self, client: GitHubClient) -> None:
        """get_issue_node_id_and_title: Node ID とタイトルを 1 回のクエリで返す"""
        client._graphql.execute.return_value = {
            "repository": {"issue": {"id": "I_kwDOtest123", "title": "[Task] 題名"}}
        }

        result = client.get_issue_node_id_and_title("owner", "repo", 123)

        assert result == ("I_kwDOtest123", "[Task] 題名")
        assert client._graphql.execute.call_count == 1

    def test_get_issue_node_id_and_title_issue_not_found(self, client: GitHubClient) -> None:
        """get_issue_node_id_and_title: Issueが見つからない"""
        client._graphql.execute.return_value = {"repository": {"issue": None}}

        with pytest.raises(GitHubNotFoundError, match="Issueが見つかりません"):
            client.get_issue_node_id_and_title("owner", "repo", 999)

    def test_get_issue_node_id_repo_not_found(self, client: GitHubClient) -> None:
        """get_issue_node_id: リポジトリが見つからない"""
        client._graphql.execute.return_value = {"repository": None}

        with pytest.raises(GitHubNotFoundError, match="リポジトリが見つかりません"):
            client.get_issue_node_id("owner", "nonexistent", 123)

    def test_get_issue_node_id_issue_not_found(self, client: GitHubClient) -> None:
        """get_issue_node_id: Issueが見つからない"""
        client._graphql.execute.return_value = {"repository": {"issue": None}}

        with pytest.raises(GitHubNotFoundError, match="Issueが見つかりません"):
            client.get_issue_node_id("owner", "repo", 999)

    def test_list_project_items_single_page(self, client: GitHubClient) -> None:
        """list_project_items: 1ページ分"""
        client._graphql.execute.return_value = {
            "node": {
                "items": {
                    "nodes": [{"id": "item1"}, {"id": "item2"}],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            }
        }

        result = client.list_project_items("PVT_test123")

        assert len(result) == 2
        assert result[0]["id"] == "item1"

    def test_list_project_items_pagination(self, client: GitHubClient) -> None:
        """list_project_items: ページネーション"""
        # 1ページ目
        page1 = {
            "node": {
                "items": {
                    "nodes": [{"id": "item1"}],
                    "pageInfo": {"hasNextPage": True, "endCursor": "cursor1"},
                }
            }
        }
        # 2ページ目
        page2 = {
            "node": {
                "items": {
                    "nodes": [{"id": "item2"}],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            }
        }
        client._graphql.execute.side_effect = [page1, page2]

        result = client.list_project_items("PVT_test123")

        assert len(result) == 2
        assert client._graphql.execute.call_count == 2

    def test_list_project_items_with_limit(self, client: GitHubClient) -> None:
        """list_project_items: 件数制限"""
        client._graphql.execute.return_value = {
            "node": {
                "items": {
                    "nodes": [{"id": f"item{i}"} for i in range(10)],
                    "pageInfo": {"hasNextPage": True, "endCursor": "cursor"},
                }
            }
        }

        result = client.list_project_items("PVT_test123", limit=5)

        assert len(result) == 5

    def test_list_project_items_empty(self, client: GitHubClient) -> None:
        """list_project_items: 空の結果"""
        client._graphql.execute.return_value = {"node": None}

        result = client.list_project_items("PVT_invalid")

        assert result == []

    def test_add_to_project_success(self, client: GitHubClient) -> None:
        """add_to_project: 成功"""
        client._graphql.execute.return_value = {
            "addProjectV2ItemById": {"item": {"id": "PVTI_test123"}}
        }

        result = client.add_to_project("PVT_proj", "I_issue")

        assert result == "PVTI_test123"

    def test_add_to_project_failure(self, client: GitHubClient) -> None:
        """add_to_project: 失敗"""
        client._graphql.execute.return_value = {"addProjectV2ItemById": {"item": None}}

        with pytest.raises(GitHubAPIError, match="プロジェクトへの追加に失敗"):
            client.add_to_project("PVT_proj", "I_issue")

    def test_update_project_item_field_success(self, client: GitHubClient) -> None:
        """update_project_item_field: 成功"""
        client._graphql.execute.return_value = {
            "updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_test"}}
        }

        result = client.update_project_item_field("PVT_proj", "PVTI_item", "FIELD_id", "OPT_id")

        assert result == "PVTI_test"

    def test_update_project_item_field_failure(self, client: GitHubClient) -> None:
        """update_project_item_field: 失敗"""
        client._graphql.execute.return_value = {
            "updateProjectV2ItemFieldValue": {"projectV2Item": None}
        }

        with pytest.raises(GitHubAPIError, match="フィールドの更新に失敗"):
            client.update_project_item_field("PVT_proj", "PVTI_item", "FIELD_id", "OPT_id")

    def test_add_sub_issue_success(self, client: GitHubClient) -> None:
        """add_sub_issue: 成功"""
        client._graphql.execute.return_value = {
            "addSubIssue": {
                "issue": {"number": 100},
                "subIssue": {"number": 101},
            }
        }

        result = client.add_sub_issue("I_parent", "I_child")

        assert result["parent_number"] == 100
        assert result["child_number"] == 101

    def test_add_sub_issue_failure(self, client: GitHubClient) -> None:
        """add_sub_issue: 失敗"""
        client._graphql.execute.return_value = {"addSubIssue": {"issue": None, "subIssue": None}}

        with pytest.raises(GitHubAPIError, match="サブIssueの紐づけに失敗"):
            client.add_sub_issue("I_parent", "I_child")

    def test_delete_project_item_success(self, client: GitHubClient) -> None:
        """delete_project_item: 成功"""
        client._graphql.execute.return_value = {
            "deleteProjectV2Item": {"deletedItemId": "PVTI_deleted"}
        }

        result = client.delete_project_item("PVT_proj", "PVTI_item")

        assert result == "PVTI_deleted"

    def test_delete_project_item_failure(self, client: GitHubClient) -> None:
        """delete_project_item: 失敗"""
        client._graphql.execute.return_value = {"deleteProjectV2Item": {"deletedItemId": None}}

        with pytest.raises(GitHubAPIError, match="プロジェクトアイテムの削除に失敗"):
            client.delete_project_item("PVT_proj", "PVTI_item")

    def test_get_linked_repositories_user(self, client: GitHubClient) -> None:
        """get_linked_repositories: userクエリ成功"""
        client._graphql.execute.return_value = {
            "user": {
                "projectV2": {
                    "repositories": {
                        "nodes": [
                            {"owner": {"login": "owner1"}, "name": "repo1"},
                            {"owner": {"login": "owner2"}, "name": "repo2"},
                        ]
                    }
                }
            }
        }

        result = client.get_linked_repositories("testuser", 1)

        assert len(result) == 2
        assert result[0] == {"owner": "owner1", "name": "repo1"}

    def test_get_linked_repositories_org(self, client: GitHubClient) -> None:
        """get_linked_repositories: orgクエリにフォールバック"""
        # userクエリは失敗
        user_response = {"user": None}
        # orgクエリは成功
        org_response = {
            "organization": {
                "projectV2": {
                    "repositories": {"nodes": [{"owner": {"login": "org"}, "name": "repo"}]}
                }
            }
        }
        client._graphql.execute.side_effect = [user_response, org_response]

        result = client.get_linked_repositories("testorg", 1)

        assert len(result) == 1
        assert result[0] == {"owner": "org", "name": "repo"}

    def test_get_linked_repositories_empty(self, client: GitHubClient) -> None:
        """get_linked_repositories: 空の結果"""
        client._graphql.execute.side_effect = [
            {"user": None},
            {"organization": None},
        ]

        result = client.get_linked_repositories("unknown", 1)

        assert result == []

    def test_get_linked_repositories_filters_none(self, client: GitHubClient) -> None:
        """get_linked_repositories: Noneノードをフィルタ"""
        client._graphql.execute.return_value = {
            "user": {
                "projectV2": {
                    "repositories": {
                        "nodes": [
                            {"owner": {"login": "owner1"}, "name": "repo1"},
                            None,  # Noneノード
                            {"owner": {"login": "owner2"}, "name": "repo2"},
                        ]
                    }
                }
            }
        }

        result = client.get_linked_repositories("testuser", 1)

        assert len(result) == 2


# GitHubClientコンテキストマネージャテスト


class TestGitHubClientContextManager:
    """コンテキストマネージャのテスト"""

    def test_context_manager(self) -> None:
        """with文でクローズされる"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._rest = MagicMock()

            with client as c:
                assert c is client

            client._rest.close.assert_called_once()

    def test_close(self) -> None:
        """close()でRESTクライアントがクローズ"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._rest = MagicMock()

            client.close()

            client._rest.close.assert_called_once()


# GitHubClient Project/Repository ID取得テスト


class TestGitHubClientProjectRepositoryID:
    """プロジェクト・リポジトリID取得メソッドのテスト"""

    def test_get_project_id_user(self) -> None:
        """userプロジェクトのID取得"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        client._graphql.execute.return_value = {"user": {"projectV2": {"id": "PVT_test123"}}}

        result = client.get_project_id("testuser", 1)
        assert result == "PVT_test123"

    def test_get_project_id_org(self) -> None:
        """organizationプロジェクトのID取得"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        # userクエリは失敗
        client._graphql.execute.side_effect = [
            {"user": None},  # userクエリ失敗
            {"organization": {"projectV2": {"id": "PVT_org456"}}},  # orgクエリ成功
        ]

        result = client.get_project_id("testorg", 1)
        assert result == "PVT_org456"

    def test_get_project_id_not_found(self) -> None:
        """プロジェクトが見つからない場合"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        client._graphql.execute.side_effect = [
            {"user": None},
            {"organization": None},
        ]

        with pytest.raises(GitHubNotFoundError) as exc_info:
            client.get_project_id("unknown", 1)
        assert "プロジェクトが見つかりません" in str(exc_info.value)

    def test_get_repository_id_success(self) -> None:
        """リポジトリID取得成功"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        client._graphql.execute.return_value = {"repository": {"id": "R_test789"}}

        result = client.get_repository_id("owner", "repo")
        assert result == "R_test789"

    def test_get_repository_id_not_found(self) -> None:
        """リポジトリが見つからない場合"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        client._graphql.execute.return_value = {"repository": None}

        with pytest.raises(GitHubNotFoundError) as exc_info:
            client.get_repository_id("owner", "nonexistent")
        assert "リポジトリが見つかりません" in str(exc_info.value)


# GitHubClient リポジトリリンクテスト


class TestGitHubClientLinkRepository:
    """リポジトリリンクメソッドのテスト"""

    def test_link_repository_to_project_success(self) -> None:
        """リンク成功"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        client._graphql.execute.side_effect = [
            {"user": {"projectV2": {"id": "PVT_proj"}}},  # get_project_id
            {"repository": {"id": "R_repo"}},  # get_repository_id
            {
                "linkProjectV2ToRepository": {
                    "repository": {"id": "R_repo", "nameWithOwner": "owner/repo"}
                }
            },  # link mutation
        ]

        success, message = client.link_repository_to_project("owner", 1, "owner", "repo")
        assert success is True
        assert "リンクしました" in message
        assert "owner/repo" in message

    def test_link_repository_to_project_already_linked(self) -> None:
        """既にリンク済み"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        client._graphql.execute.side_effect = [
            {"user": {"projectV2": {"id": "PVT_proj"}}},
            {"repository": {"id": "R_repo"}},
            Exception("already linked"),  # mutation fails with already linked
        ]

        success, message = client.link_repository_to_project("owner", 1, "owner", "repo")
        assert success is True
        assert "リンク済み" in message

    def test_link_repository_to_project_project_not_found(self) -> None:
        """プロジェクトが見つからない"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        client._graphql.execute.side_effect = [
            {"user": None},
            {"organization": None},
        ]

        success, message = client.link_repository_to_project("owner", 1, "owner", "repo")
        assert success is False
        assert "失敗" in message

    def test_link_repository_to_project_repo_not_found(self) -> None:
        """リポジトリが見つからない"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        client._graphql.execute.side_effect = [
            {"user": {"projectV2": {"id": "PVT_proj"}}},
            {"repository": None},
        ]

        success, message = client.link_repository_to_project("owner", 1, "owner", "nonexistent")
        assert success is False
        assert "失敗" in message

    def test_link_repository_to_project_api_error(self) -> None:
        """APIエラー"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test")
            client._graphql = MagicMock()

        client._graphql.execute.side_effect = [
            {"user": {"projectV2": {"id": "PVT_proj"}}},
            {"repository": {"id": "R_repo"}},
            Exception("Some API error"),
        ]

        success, message = client.link_repository_to_project("owner", 1, "owner", "repo")
        assert success is False
        assert "失敗" in message


# GitHubClient get_item_id_by_issue テスト


class TestGetItemIdByIssue:
    """get_item_id_by_issue メソッドのテスト（高速版：Issue起点）"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._graphql = MagicMock()
            return client

    def test_found(self, client: GitHubClient) -> None:
        """存在するIssue → item_id返却"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "projectItems": {
                        "nodes": [
                            {"id": "PVTI_item1", "project": {"id": "PVT_proj"}},
                            {"id": "PVTI_item2", "project": {"id": "PVT_other"}},
                        ]
                    }
                }
            }
        }

        result = client.get_item_id_by_issue("PVT_proj", "owner", "repo", 123)

        assert result == "PVTI_item1"

    def test_not_found_issue(self, client: GitHubClient) -> None:
        """Issueが存在しない → None"""
        client._graphql.execute.return_value = {"repository": {"issue": None}}

        result = client.get_item_id_by_issue("PVT_proj", "owner", "repo", 999)

        assert result is None

    def test_not_in_project(self, client: GitHubClient) -> None:
        """Issueが指定プロジェクトに紐づいていない → None"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "projectItems": {
                        "nodes": [
                            {"id": "PVTI_item1", "project": {"id": "PVT_other"}},
                        ]
                    }
                }
            }
        }

        result = client.get_item_id_by_issue("PVT_proj", "owner", "repo", 123)

        assert result is None

    def test_repo_not_found(self, client: GitHubClient) -> None:
        """リポジトリが存在しない → None"""
        client._graphql.execute.return_value = {"repository": None}

        result = client.get_item_id_by_issue("PVT_proj", "owner", "repo", 123)

        assert result is None

    def test_empty_project_items(self, client: GitHubClient) -> None:
        """Issueがどのプロジェクトにも紐づいていない → None"""
        client._graphql.execute.return_value = {
            "repository": {"issue": {"projectItems": {"nodes": []}}}
        }

        result = client.get_item_id_by_issue("PVT_proj", "owner", "repo", 123)

        assert result is None

    def test_null_item_skipped(self, client: GitHubClient) -> None:
        """Nullアイテムはスキップされる"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "projectItems": {
                        "nodes": [
                            None,
                            {"id": "PVTI_item1", "project": {"id": "PVT_proj"}},
                        ]
                    }
                }
            }
        }

        result = client.get_item_id_by_issue("PVT_proj", "owner", "repo", 123)

        assert result == "PVTI_item1"


# GitHubClient ブランチ操作テスト


class TestGitHubClientBranchOperations:
    """ブランチ操作メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            client._graphql = MagicMock()
            return client

    # get_branch_sha テスト

    def test_get_branch_sha_success(self, client: GitHubClient) -> None:
        """get_branch_sha: 成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "ref": "refs/heads/develop",
            "object": {
                "sha": "abc123def456",
                "type": "commit",
            },
        }
        client._rest.get.return_value = mock_response

        result = client.get_branch_sha("owner", "repo", "develop")

        assert result == "abc123def456"
        client._rest.get.assert_called_once_with("/repos/owner/repo/git/ref/heads/develop")

    def test_get_branch_sha_not_found(self, client: GitHubClient) -> None:
        """get_branch_sha: ブランチが存在しない"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 404
        mock_response.text = "Not Found"
        mock_response.url = "https://api.github.com/repos/owner/repo/git/ref/heads/nonexistent"
        client._rest.get.return_value = mock_response

        with pytest.raises(GitHubNotFoundError, match="リソースが見つかりません"):
            client.get_branch_sha("owner", "repo", "nonexistent")

    # create_linked_branch テスト

    def test_create_linked_branch_success(self, client: GitHubClient) -> None:
        """create_linked_branch: 成功"""
        client._graphql.execute.return_value = {
            "createLinkedBranch": {
                "linkedBranch": {
                    "ref": {
                        "name": "feat/test-branch",
                        "prefix": "refs/heads/",
                    }
                }
            }
        }

        result = client.create_linked_branch(
            issue_id="I_kwDOtest123",
            oid="abc123def456",
            name="feat/test-branch",
        )

        assert result == "feat/test-branch"

    def test_create_linked_branch_with_repository_id(self, client: GitHubClient) -> None:
        """create_linked_branch: repositoryId指定"""
        client._graphql.execute.return_value = {
            "createLinkedBranch": {
                "linkedBranch": {
                    "ref": {
                        "name": "feat/cross-repo-branch",
                        "prefix": "refs/heads/",
                    }
                }
            }
        }

        result = client.create_linked_branch(
            issue_id="I_kwDOtest123",
            oid="abc123def456",
            name="feat/cross-repo-branch",
            repository_id="R_kwDOrepo456",
        )

        assert result == "feat/cross-repo-branch"

    def test_create_linked_branch_failure(self, client: GitHubClient) -> None:
        """create_linked_branch: 失敗（linkedBranchがNone）"""
        client._graphql.execute.return_value = {"createLinkedBranch": {"linkedBranch": None}}

        with pytest.raises(GitHubAPIError, match="リンクブランチの作成に失敗"):
            client.create_linked_branch(
                issue_id="I_kwDOtest123",
                oid="abc123def456",
                name="feat/test-branch",
            )

    def test_create_linked_branch_already_exists(self, client: GitHubClient) -> None:
        """create_linked_branch: 同名ブランチが既に存在"""
        client._graphql.execute.side_effect = Exception(
            "A branch named 'feat/existing-branch' already exists"
        )

        with pytest.raises(GitHubAPIError, match="GraphQLクエリ実行エラー"):
            client.create_linked_branch(
                issue_id="I_kwDOtest123",
                oid="abc123def456",
                name="feat/existing-branch",
            )


# GitHubClient create_project_field テスト


class TestCreateProjectField:
    """create_project_field メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._graphql = MagicMock()
            return client

    def test_create_project_field_success(self, client: GitHubClient) -> None:
        """create_project_field: 成功"""
        client._graphql.execute.return_value = {
            "createProjectV2Field": {
                "projectV2Field": {
                    "id": "PVTSSF_new123",
                    "name": "pecot-workflow",
                    "options": [
                        {"id": "opt1", "name": "Backlog"},
                        {"id": "opt2", "name": "Ready"},
                        {"id": "opt3", "name": "Active"},
                        {"id": "opt4", "name": "Archived"},
                    ],
                }
            }
        }

        result = client.create_project_field(
            project_id="PVT_test123",
            name="pecot-workflow",
            options=[
                {"name": "Backlog", "color": "RED", "description": "Epic置き場"},
                {"name": "Ready", "color": "GREEN", "description": "未着手"},
                {"name": "Active", "color": "BLUE", "description": "作業中"},
                {"name": "Archived", "color": "PURPLE", "description": "退避"},
            ],
        )

        assert result["id"] == "PVTSSF_new123"
        assert result["name"] == "pecot-workflow"
        assert len(result["options"]) == 4

    def test_create_project_field_failure(self, client: GitHubClient) -> None:
        """create_project_field: 失敗（レスポンスがNone）"""
        client._graphql.execute.return_value = {"createProjectV2Field": {"projectV2Field": None}}

        with pytest.raises(GitHubAPIError, match="フィールドの作成に失敗"):
            client.create_project_field(
                project_id="PVT_test123",
                name="pecot-workflow",
                options=[{"name": "Test", "color": "RED", "description": "test"}],
            )

    def test_create_project_field_api_error(self, client: GitHubClient) -> None:
        """create_project_field: APIエラー"""
        client._graphql.execute.side_effect = Exception("GraphQL error")

        with pytest.raises(GitHubAPIError, match="GraphQLクエリ実行エラー"):
            client.create_project_field(
                project_id="PVT_test123",
                name="pecot-workflow",
                options=[{"name": "Test", "color": "RED", "description": "test"}],
            )


# GitHubClient get_owner_node_id テスト


class TestGetOwnerNodeId:
    """get_owner_node_id メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._graphql = MagicMock()
            return client

    def test_user_success(self, client: GitHubClient) -> None:
        """ユーザーのnode_id取得成功"""
        client._graphql.execute.return_value = {"user": {"id": "U_kgDOtest123"}}

        result = client.get_owner_node_id("testuser")

        assert result == "U_kgDOtest123"

    def test_org_success(self, client: GitHubClient) -> None:
        """組織のnode_id取得成功（userクエリがNOT_FOUNDで例外→orgにフォールバック）"""
        client._graphql.execute.side_effect = [
            Exception("Could not resolve to a User with the login of 'testorg'. NOT_FOUND"),
            {"organization": {"id": "O_kgDOorg456"}},  # orgクエリ成功
        ]

        result = client.get_owner_node_id("testorg")

        assert result == "O_kgDOorg456"

    def test_not_found(self, client: GitHubClient) -> None:
        """オーナーが見つからない場合（userは例外、orgの応答はnull）"""
        client._graphql.execute.side_effect = [
            Exception("Could not resolve to a User with the login of 'nonexistent'. NOT_FOUND"),
            {"organization": None},
        ]

        with pytest.raises(GitHubNotFoundError, match="オーナーが見つかりません"):
            client.get_owner_node_id("nonexistent")

    def test_org_query_error_propagates(self, client: GitHubClient) -> None:
        """organizationクエリの例外はGitHubAPIErrorのまま伝播する"""
        client._graphql.execute.side_effect = [
            Exception("Could not resolve to a User with the login of 'testorg'. NOT_FOUND"),
            Exception("Bad credentials"),
        ]

        with pytest.raises(GitHubAPIError, match="Bad credentials") as exc_info:
            client.get_owner_node_id("testorg")

        assert not isinstance(exc_info.value, GitHubNotFoundError)


# GitHubClient create_project テスト


class TestCreateProject:
    """create_project メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._graphql = MagicMock()
            return client

    def test_create_success(self, client: GitHubClient) -> None:
        """プロジェクト作成成功"""
        client._graphql.execute.return_value = {
            "createProjectV2": {
                "projectV2": {
                    "id": "PVT_kwHOtest123",
                    "number": 42,
                    "title": "New Project",
                    "url": "https://github.com/users/owner/projects/42",
                }
            }
        }

        result = client.create_project("U_owner123", "New Project")

        assert result["id"] == "PVT_kwHOtest123"
        assert result["number"] == 42
        assert result["title"] == "New Project"

    def test_create_failure(self, client: GitHubClient) -> None:
        """プロジェクト作成失敗"""
        client._graphql.execute.return_value = {"createProjectV2": {"projectV2": None}}

        with pytest.raises(GitHubAPIError, match="プロジェクトの作成に失敗"):
            client.create_project("U_owner123", "New Project")

    def test_create_api_error(self, client: GitHubClient) -> None:
        """API エラー"""
        client._graphql.execute.side_effect = Exception("GraphQL error")

        with pytest.raises(GitHubAPIError):
            client.create_project("U_owner123", "New Project")


# GitHubClient get_issue_kind テスト


class TestGetIssueKind:
    """get_issue_kind メソッドのテスト（Epic 判定用軽量クエリ + schema fallback）"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="ghes.example.com", token="test_token")
            client._graphql = MagicMock()
            return client

    def test_get_issue_kind_epic(self, client: GitHubClient) -> None:
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 100,
                    "state": "OPEN",
                    "issueType": {"name": "Epic"},
                    "subIssues": {"totalCount": 2},
                }
            }
        }

        result = client.get_issue_kind("owner", "repo", 100)

        assert result == {
            "number": 100,
            "state": "OPEN",
            "issue_type": "Epic",
            "sub_issues_total": 2,
        }

    def test_get_issue_kind_task(self, client: GitHubClient) -> None:
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 101,
                    "state": "OPEN",
                    "issueType": {"name": "Task"},
                    "subIssues": {"totalCount": 0},
                }
            }
        }

        result = client.get_issue_kind("owner", "repo", 101)

        assert result["issue_type"] == "Task"
        assert result["sub_issues_total"] == 0

    def test_get_issue_kind_no_issue_type(self, client: GitHubClient) -> None:
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 102,
                    "state": "OPEN",
                    "issueType": None,
                    "subIssues": {"totalCount": 3},
                }
            }
        }

        result = client.get_issue_kind("owner", "repo", 102)

        assert result["issue_type"] is None
        assert result["sub_issues_total"] == 3

    def test_get_issue_kind_not_found(self, client: GitHubClient) -> None:
        client._graphql.execute.return_value = {"repository": {"issue": None}}

        with pytest.raises(GitHubNotFoundError):
            client.get_issue_kind("owner", "repo", 999)

    def test_get_issue_kind_schema_fallback(self, client: GitHubClient) -> None:
        """issueType 未対応 GHES では Phase1 単独クエリで再取得して成功する。"""
        with patch.object(client, "_execute_graphql") as mock_exec:
            mock_exec.side_effect = [
                GitHubAPIError(
                    "GraphQLクエリ実行エラー: Cannot query field 'issueType' on type 'Issue'"
                ),
                {
                    "repository": {
                        "issue": {
                            "number": 200,
                            "state": "OPEN",
                            "subIssues": {"totalCount": 4},
                        }
                    }
                },
            ]

            result = client.get_issue_kind("owner", "repo", 200)

            assert mock_exec.call_count == 2
            assert result == {
                "number": 200,
                "state": "OPEN",
                "issue_type": None,
                "sub_issues_total": 4,
            }


# GitHubClient get_issue_slim テスト


class TestGetIssueSlim:
    """get_issue_slim メソッドのテスト（GraphQLで効率的にIssue取得）"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="ghes.example.com", token="test_token")
            client._graphql = MagicMock()
            return client

    def test_basic_issue(self, client: GitHubClient) -> None:
        """基本的なIssue取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 435,
                    "state": "OPEN",
                    "title": "[Task] pecot issue readコマンドの実装",
                    "body": "## タスク概要\n\n実装する。",
                    "comments": {"totalCount": 3},
                    "parent": None,
                    "subIssues": {"nodes": []},
                    "linkedBranches": {"nodes": []},
                }
            }
        }

        result = client.get_issue_slim("owner", "repo", 435)

        assert result["number"] == 435
        assert result["state"] == "OPEN"
        assert result["title"] == "[Task] pecot issue readコマンドの実装"
        assert result["body"] == "## タスク概要\n\n実装する。"
        assert result["comments"]["total_count"] == 3
        assert result["comments"]["nodes"] == []
        assert result["parent"] is None
        assert result["sub_issues"] == []
        assert result["linked_branches"] == []

    def test_with_parent(self, client: GitHubClient) -> None:
        """親Issue付きのIssue取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 435,
                    "state": "OPEN",
                    "title": "[Task] サブタスク",
                    "body": "本文",
                    "comments": {"totalCount": 0},
                    "parent": {
                        "number": 353,
                        "title": "[Epic] 親エピック",
                        "state": "OPEN",
                        "repository": {
                            "owner": {"login": "other-owner"},
                            "name": "other-repo",
                        },
                    },
                    "subIssues": {"nodes": []},
                    "linkedBranches": {"nodes": []},
                }
            }
        }

        result = client.get_issue_slim("owner", "repo", 435)

        assert result["parent"] is not None
        assert result["parent"]["number"] == 353
        assert result["parent"]["title"] == "[Epic] 親エピック"
        assert result["parent"]["state"] == "OPEN"
        assert result["parent"]["owner"] == "other-owner"
        assert result["parent"]["repo"] == "other-repo"

    def test_with_sub_issues(self, client: GitHubClient) -> None:
        """サブIssue付きのIssue取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 353,
                    "state": "OPEN",
                    "title": "[Epic] 親エピック",
                    "body": "エピック本文",
                    "comments": {"totalCount": 5},
                    "parent": None,
                    "subIssues": {
                        "nodes": [
                            {"number": 435, "state": "OPEN", "title": "[Task] タスク1"},
                            {"number": 436, "state": "CLOSED", "title": "[Task] タスク2"},
                        ]
                    },
                    "linkedBranches": {"nodes": []},
                }
            }
        }

        result = client.get_issue_slim("owner", "repo", 353)

        assert len(result["sub_issues"]) == 2
        assert result["sub_issues"][0]["number"] == 435
        assert result["sub_issues"][0]["state"] == "OPEN"
        assert result["sub_issues"][1]["number"] == 436
        assert result["sub_issues"][1]["state"] == "CLOSED"

    def test_sub_issues_fetched_across_pages(self, client: GitHubClient) -> None:
        """サブIssueが 20 件を超えるときは続きのページまで全件取得する"""

        def subs(start: int, end: int) -> list[dict[str, object]]:
            return [
                {"number": n, "state": "OPEN", "title": f"[Task] {n}"} for n in range(start, end)
            ]

        client._graphql.execute.side_effect = [
            {
                "repository": {
                    "issue": {
                        "number": 353,
                        "state": "OPEN",
                        "title": "[Epic] 親エピック",
                        "body": "",
                        "comments": {"totalCount": 0},
                        "parent": None,
                        "subIssues": {
                            "nodes": subs(1, 21),
                            "pageInfo": {"hasNextPage": True, "endCursor": "c1"},
                        },
                        "linkedBranches": {"nodes": []},
                    }
                }
            },
            {
                "repository": {
                    "issue": {
                        "subIssues": {
                            "nodes": subs(21, 26),
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                        }
                    }
                }
            },
        ]

        result = client.get_issue_slim("owner", "repo", 353)

        assert [s["number"] for s in result["sub_issues"]] == list(range(1, 26))
        assert client._graphql.execute.call_count == 2
        assert client._graphql.execute.call_args_list[1].args[0].variable_values["after"] == "c1"

    def test_sub_issues_single_request_when_within_first_page(self, client: GitHubClient) -> None:
        """サブIssueが 1 ページに収まるときはリクエストを 1 回で終える"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 353,
                    "state": "OPEN",
                    "title": "[Epic] 親エピック",
                    "body": "",
                    "comments": {"totalCount": 0},
                    "parent": None,
                    "subIssues": {
                        "nodes": [{"number": 1, "state": "OPEN", "title": "[Task] 1"}],
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                    },
                    "linkedBranches": {"nodes": []},
                }
            }
        }

        result = client.get_issue_slim("owner", "repo", 353)

        assert [s["number"] for s in result["sub_issues"]] == [1]
        assert client._graphql.execute.call_count == 1

    def test_with_linked_branches(self, client: GitHubClient) -> None:
        """リンクブランチ付きのIssue取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 435,
                    "state": "OPEN",
                    "title": "[Task] タスク",
                    "body": "本文",
                    "comments": {"totalCount": 0},
                    "parent": None,
                    "subIssues": {"nodes": []},
                    "linkedBranches": {
                        "nodes": [
                            {"ref": {"name": "feat/issue-435-task"}},
                            {"ref": {"name": "fix/issue-435-hotfix"}},
                        ]
                    },
                }
            }
        }

        result = client.get_issue_slim("owner", "repo", 435)

        assert len(result["linked_branches"]) == 2
        assert result["linked_branches"][0] == "feat/issue-435-task"
        assert result["linked_branches"][1] == "fix/issue-435-hotfix"

    def test_issue_not_found(self, client: GitHubClient) -> None:
        """Issueが見つからない場合"""
        client._graphql.execute.return_value = {"repository": {"issue": None}}

        with pytest.raises(GitHubNotFoundError, match="Issueが見つかりません"):
            client.get_issue_slim("owner", "repo", 999)

    def test_repository_not_found(self, client: GitHubClient) -> None:
        """リポジトリが見つからない場合"""
        client._graphql.execute.return_value = {"repository": None}

        with pytest.raises(GitHubNotFoundError, match="リポジトリが見つかりません"):
            client.get_issue_slim("owner", "nonexistent", 435)

    def test_with_linked_prs(self, client: GitHubClient) -> None:
        """リンクPR付きのIssue取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 460,
                    "state": "OPEN",
                    "title": "[Task] リンクPR表示の実装",
                    "body": "本文",
                    "comments": {"totalCount": 2},
                    "parent": None,
                    "subIssues": {"nodes": []},
                    "linkedBranches": {"nodes": []},
                    "timelineItems": {
                        "nodes": [
                            {
                                "__typename": "ConnectedEvent",
                                "subject": {
                                    "number": 455,
                                    "title": "feat: 新機能追加",
                                    "state": "MERGED",
                                },
                            },
                            {
                                "__typename": "CrossReferencedEvent",
                                "source": {
                                    "number": 456,
                                    "title": "fix: バグ修正",
                                    "state": "OPEN",
                                },
                            },
                        ]
                    },
                }
            }
        }

        result = client.get_issue_slim("owner", "repo", 460)

        assert len(result["linked_prs"]) == 2
        assert result["linked_prs"][0]["number"] == 455
        assert result["linked_prs"][0]["title"] == "feat: 新機能追加"
        assert result["linked_prs"][0]["state"] == "MERGED"
        assert result["linked_prs"][1]["number"] == 456
        assert result["linked_prs"][1]["state"] == "OPEN"

    def test_linked_prs_deduplication(self, client: GitHubClient) -> None:
        """リンクPRの重複除去"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 460,
                    "state": "OPEN",
                    "title": "テスト",
                    "body": "本文",
                    "comments": {"totalCount": 0},
                    "parent": None,
                    "subIssues": {"nodes": []},
                    "linkedBranches": {"nodes": []},
                    "timelineItems": {
                        "nodes": [
                            {
                                "__typename": "ConnectedEvent",
                                "subject": {
                                    "number": 455,
                                    "title": "feat: 新機能追加",
                                    "state": "MERGED",
                                },
                            },
                            {
                                "__typename": "CrossReferencedEvent",
                                "source": {
                                    "number": 455,  # 同じPR番号
                                    "title": "feat: 新機能追加",
                                    "state": "MERGED",
                                },
                            },
                        ]
                    },
                }
            }
        }

        result = client.get_issue_slim("owner", "repo", 460)

        # 重複除去されて1つのみ
        assert len(result["linked_prs"]) == 1
        assert result["linked_prs"][0]["number"] == 455

    def test_linked_prs_none(self, client: GitHubClient) -> None:
        """リンクPRがない場合"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 460,
                    "state": "OPEN",
                    "title": "テスト",
                    "body": "本文",
                    "comments": {"totalCount": 0},
                    "parent": None,
                    "subIssues": {"nodes": []},
                    "linkedBranches": {"nodes": []},
                    "timelineItems": {"nodes": []},
                }
            }
        }

        result = client.get_issue_slim("owner", "repo", 460)

        assert result["linked_prs"] == []

    def test_linked_prs_filters_issues(self, client: GitHubClient) -> None:
        """リンクPR抽出時にIssue（PRではないもの）は除外"""
        client._graphql.execute.return_value = {
            "repository": {
                "issue": {
                    "number": 460,
                    "state": "OPEN",
                    "title": "テスト",
                    "body": "本文",
                    "comments": {"totalCount": 0},
                    "parent": None,
                    "subIssues": {"nodes": []},
                    "linkedBranches": {"nodes": []},
                    "timelineItems": {
                        "nodes": [
                            {
                                "__typename": "CrossReferencedEvent",
                                "source": None,  # Issueからの参照（sourceがない）
                            },
                            {
                                "__typename": "ConnectedEvent",
                                "subject": {
                                    "number": 455,
                                    "title": "PR",
                                    "state": "OPEN",
                                },
                            },
                        ]
                    },
                }
            }
        }

        result = client.get_issue_slim("owner", "repo", 460)

        assert len(result["linked_prs"]) == 1
        assert result["linked_prs"][0]["number"] == 455


# GitHubClient Pull Request操作テスト


class TestCreatePullRequest:
    """create_pull_request メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            return client

    def test_create_success(self, client: GitHubClient) -> None:
        """PR作成成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "number": 42,
            "title": "feat: 新機能追加",
            "html_url": "https://github.com/owner/repo/pull/42",
            "state": "open",
        }
        client._rest.post.return_value = mock_response

        result = client.create_pull_request(
            owner="owner",
            repo="repo",
            title="feat: 新機能追加",
            body="## Added — 機能A追加\n\n- 機能A追加\n\nRefs #123",
            head="feat/issue-123",
            base="develop",
        )

        assert result["number"] == 42
        assert result["title"] == "feat: 新機能追加"
        client._rest.post.assert_called_once_with(
            "/repos/owner/repo/pulls",
            json={
                "title": "feat: 新機能追加",
                "body": "## Added — 機能A追加\n\n- 機能A追加\n\nRefs #123",
                "head": "feat/issue-123",
                "base": "develop",
                "draft": False,
            },
        )

    def test_create_draft_pr(self, client: GitHubClient) -> None:
        """ドラフトPR作成"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "number": 43,
            "title": "WIP: 作業中",
            "draft": True,
        }
        client._rest.post.return_value = mock_response

        result = client.create_pull_request(
            owner="owner",
            repo="repo",
            title="WIP: 作業中",
            body="作業中です",
            head="feat/wip",
            base="develop",
            draft=True,
        )

        assert result["draft"] is True
        client._rest.post.assert_called_once()
        call_args = client._rest.post.call_args
        assert call_args[1]["json"]["draft"] is True

    def test_create_validation_error(self, client: GitHubClient) -> None:
        """PR作成時のバリデーションエラー（422）"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 422
        mock_response.text = "Validation failed: base branch does not exist"

        client._rest.post.return_value = mock_response

        with pytest.raises(GitHubAPIError, match="422"):
            client.create_pull_request(
                owner="owner",
                repo="repo",
                title="Test",
                body="body",
                head="feat/test",
                base="nonexistent",
            )

    def test_create_already_exists(self, client: GitHubClient) -> None:
        """同じhead→baseのPRが既に存在"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 422
        mock_response.text = "A pull request already exists"

        client._rest.post.return_value = mock_response

        with pytest.raises(GitHubAPIError):
            client.create_pull_request(
                owner="owner",
                repo="repo",
                title="Test",
                body="body",
                head="feat/existing",
                base="develop",
            )


class TestGetPullRequestSlim:
    """get_pull_request_slim メソッドのテスト（GraphQLで効率的にPR取得）"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="ghes.example.com", token="test_token")
            client._graphql = MagicMock()
            return client

    def test_basic_pr(self, client: GitHubClient) -> None:
        """基本的なPR取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "pullRequest": {
                    "number": 42,
                    "state": "OPEN",
                    "title": "feat: 新機能追加",
                    "body": "## Added — 機能A追加\n\n- 機能A追加\n\nRefs #123",
                    "headRefName": "feat/issue-123",
                    "baseRefName": "develop",
                    "isDraft": False,
                    "mergeable": "MERGEABLE",
                    "comments": {"totalCount": 3},
                    "closingIssuesReferences": {"nodes": []},
                    "reviews": {"nodes": []},
                }
            }
        }

        result = client.get_pull_request_slim("owner", "repo", 42)

        assert result["number"] == 42
        assert result["state"] == "OPEN"
        assert result["title"] == "feat: 新機能追加"
        assert result["head_ref"] == "feat/issue-123"
        assert result["base_ref"] == "develop"
        assert result["is_draft"] is False
        assert result["mergeable"] == "MERGEABLE"
        assert result["comments"] == 3
        assert result["closing_issues"] == []
        assert result["referenced_issues"] == [{"number": 123, "title": ""}]
        assert result["reviews"] == []

    def test_draft_pr(self, client: GitHubClient) -> None:
        """ドラフトPR取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "pullRequest": {
                    "number": 43,
                    "state": "OPEN",
                    "title": "WIP: 作業中",
                    "body": "作業中",
                    "headRefName": "feat/wip",
                    "baseRefName": "develop",
                    "isDraft": True,
                    "mergeable": "UNKNOWN",
                    "comments": {"totalCount": 0},
                    "closingIssuesReferences": {"nodes": []},
                    "reviews": {"nodes": []},
                }
            }
        }

        result = client.get_pull_request_slim("owner", "repo", 43)

        assert result["is_draft"] is True
        assert result["mergeable"] == "UNKNOWN"

    def test_with_closing_issues(self, client: GitHubClient) -> None:
        """関連Issue付きPR取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "pullRequest": {
                    "number": 44,
                    "state": "OPEN",
                    "title": "fix: バグ修正",
                    "body": "Fixes #123, Closes #456",
                    "headRefName": "fix/bug",
                    "baseRefName": "develop",
                    "isDraft": False,
                    "mergeable": "MERGEABLE",
                    "comments": {"totalCount": 1},
                    "closingIssuesReferences": {
                        "nodes": [
                            {"number": 123, "title": "バグ報告"},
                            {"number": 456, "title": "関連Issue"},
                        ]
                    },
                    "reviews": {"nodes": []},
                }
            }
        }

        result = client.get_pull_request_slim("owner", "repo", 44)

        assert len(result["closing_issues"]) == 2
        assert result["closing_issues"][0]["number"] == 123
        assert result["closing_issues"][0]["title"] == "バグ報告"
        assert result["closing_issues"][1]["number"] == 456
        assert result["referenced_issues"] == []

    def test_with_refs_issues(self, client: GitHubClient) -> None:
        """Refs #XXXからreferenced_issuesを抽出"""
        client._graphql.execute.return_value = {
            "repository": {
                "pullRequest": {
                    "number": 50,
                    "state": "OPEN",
                    "title": "feat: テスト",
                    "body": "変更内容\n\nRefs #935",
                    "headRefName": "feat/test",
                    "baseRefName": "develop",
                    "isDraft": False,
                    "mergeable": "MERGEABLE",
                    "comments": {"totalCount": 0},
                    "closingIssuesReferences": {"nodes": []},
                    "reviews": {"nodes": []},
                }
            }
        }

        result = client.get_pull_request_slim("owner", "repo", 50)

        assert result["closing_issues"] == []
        assert result["referenced_issues"] == [{"number": 935, "title": ""}]

    def test_refs_excludes_closing_issues(self, client: GitHubClient) -> None:
        """Refs #XXXがClosing Issuesと重複する場合は除外される"""
        client._graphql.execute.return_value = {
            "repository": {
                "pullRequest": {
                    "number": 51,
                    "state": "OPEN",
                    "title": "fix: バグ修正",
                    "body": "Fixes #123\n\nRefs #123\nRefs #456",
                    "headRefName": "fix/bug",
                    "baseRefName": "develop",
                    "isDraft": False,
                    "mergeable": "MERGEABLE",
                    "comments": {"totalCount": 0},
                    "closingIssuesReferences": {
                        "nodes": [
                            {"number": 123, "title": "バグ報告"},
                        ]
                    },
                    "reviews": {"nodes": []},
                }
            }
        }

        result = client.get_pull_request_slim("owner", "repo", 51)

        assert len(result["closing_issues"]) == 1
        assert result["closing_issues"][0]["number"] == 123
        assert result["referenced_issues"] == [{"number": 456, "title": ""}]

    def test_with_reviews(self, client: GitHubClient) -> None:
        """レビュー付きPR取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "pullRequest": {
                    "number": 45,
                    "state": "OPEN",
                    "title": "feat: レビュー待ち",
                    "body": "本文",
                    "headRefName": "feat/review",
                    "baseRefName": "develop",
                    "isDraft": False,
                    "mergeable": "MERGEABLE",
                    "comments": {"totalCount": 0},
                    "closingIssuesReferences": {"nodes": []},
                    "reviews": {
                        "nodes": [
                            {"state": "APPROVED", "author": {"login": "reviewer1"}},
                            {"state": "CHANGES_REQUESTED", "author": {"login": "reviewer2"}},
                        ]
                    },
                }
            }
        }

        result = client.get_pull_request_slim("owner", "repo", 45)

        assert len(result["reviews"]) == 2
        assert result["reviews"][0]["state"] == "APPROVED"
        assert result["reviews"][0]["author"] == "reviewer1"
        assert result["reviews"][1]["state"] == "CHANGES_REQUESTED"
        assert result["reviews"][1]["author"] == "reviewer2"

    def test_merged_pr(self, client: GitHubClient) -> None:
        """マージ済みPR取得"""
        client._graphql.execute.return_value = {
            "repository": {
                "pullRequest": {
                    "number": 46,
                    "state": "MERGED",
                    "title": "feat: マージ済み機能",
                    "body": "本文",
                    "headRefName": "feat/merged",
                    "baseRefName": "develop",
                    "isDraft": False,
                    "mergeable": "UNKNOWN",
                    "comments": {"totalCount": 5},
                    "closingIssuesReferences": {"nodes": []},
                    "reviews": {"nodes": []},
                }
            }
        }

        result = client.get_pull_request_slim("owner", "repo", 46)

        assert result["state"] == "MERGED"

    def test_pr_not_found(self, client: GitHubClient) -> None:
        """PRが見つからない場合"""
        client._graphql.execute.return_value = {"repository": {"pullRequest": None}}

        with pytest.raises(GitHubNotFoundError, match="PRが見つかりません"):
            client.get_pull_request_slim("owner", "repo", 999)

    def test_repository_not_found(self, client: GitHubClient) -> None:
        """リポジトリが見つからない場合"""
        client._graphql.execute.return_value = {"repository": None}

        with pytest.raises(GitHubNotFoundError, match="リポジトリが見つかりません"):
            client.get_pull_request_slim("owner", "nonexistent", 42)

    def test_null_author_in_review(self, client: GitHubClient) -> None:
        """レビューにauthorがnullの場合"""
        client._graphql.execute.return_value = {
            "repository": {
                "pullRequest": {
                    "number": 47,
                    "state": "OPEN",
                    "title": "test",
                    "body": "body",
                    "headRefName": "feat/test",
                    "baseRefName": "develop",
                    "isDraft": False,
                    "mergeable": "MERGEABLE",
                    "comments": {"totalCount": 0},
                    "closingIssuesReferences": {"nodes": []},
                    "reviews": {
                        "nodes": [
                            {"state": "APPROVED", "author": None},  # 削除されたユーザー等
                        ]
                    },
                }
            }
        }

        result = client.get_pull_request_slim("owner", "repo", 47)

        assert len(result["reviews"]) == 1
        assert result["reviews"][0]["state"] == "APPROVED"
        assert result["reviews"][0]["author"] is None


# GitHubClient merge_pull_request テスト


class TestMergePullRequest:
    """merge_pull_request メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            return client

    def test_merge_success_squash(self, client: GitHubClient) -> None:
        """squashマージ成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "sha": "abc123def456",
            "merged": True,
            "message": "Pull Request successfully merged",
        }
        client._rest.put.return_value = mock_response

        result = client.merge_pull_request("owner", "repo", 42)

        assert result["merged"] is True
        assert result["sha"] == "abc123def456"
        client._rest.put.assert_called_once()
        call_args = client._rest.put.call_args
        assert call_args[0][0] == "/repos/owner/repo/pulls/42/merge"
        assert call_args[1]["json"]["merge_method"] == "squash"

    def test_merge_success_merge(self, client: GitHubClient) -> None:
        """通常マージ成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "sha": "xyz789",
            "merged": True,
            "message": "Pull Request successfully merged",
        }
        client._rest.put.return_value = mock_response

        result = client.merge_pull_request("owner", "repo", 42, merge_method="merge")

        assert result["merged"] is True
        call_args = client._rest.put.call_args
        assert call_args[1]["json"]["merge_method"] == "merge"

    def test_merge_success_rebase(self, client: GitHubClient) -> None:
        """rebaseマージ成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "sha": "rebase123",
            "merged": True,
            "message": "Pull Request successfully merged",
        }
        client._rest.put.return_value = mock_response

        result = client.merge_pull_request("owner", "repo", 42, merge_method="rebase")

        assert result["merged"] is True
        call_args = client._rest.put.call_args
        assert call_args[1]["json"]["merge_method"] == "rebase"

    def test_merge_not_found(self, client: GitHubClient) -> None:
        """PRが見つからない場合"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 404
        mock_response.text = "Not Found"
        mock_response.url = "https://api.github.com/repos/owner/repo/pulls/999/merge"
        client._rest.put.return_value = mock_response

        with pytest.raises(GitHubNotFoundError, match="リソースが見つかりません"):
            client.merge_pull_request("owner", "repo", 999)

    def test_merge_conflict(self, client: GitHubClient) -> None:
        """マージコンフリクトの場合"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 405
        mock_response.text = "Pull Request is not mergeable"
        client._rest.put.return_value = mock_response

        with pytest.raises(GitHubAPIError, match="405"):
            client.merge_pull_request("owner", "repo", 42)

    def test_merge_already_merged(self, client: GitHubClient) -> None:
        """既にマージ済みの場合"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 422
        mock_response.text = "Pull Request is not open"
        client._rest.put.return_value = mock_response

        with pytest.raises(GitHubAPIError, match="422"):
            client.merge_pull_request("owner", "repo", 42)


# GitHubClient close_issue テスト


class TestCloseIssue:
    """close_issue メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            return client

    def test_close_success(self, client: GitHubClient) -> None:
        """Issueクローズ成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "number": 123,
            "state": "closed",
            "title": "Test Issue",
            "state_reason": "completed",
        }
        client._rest.patch.return_value = mock_response

        result = client.close_issue("owner", "repo", 123)

        assert result["state"] == "closed"
        assert result["number"] == 123
        client._rest.patch.assert_called_once_with(
            "/repos/owner/repo/issues/123",
            json={"state": "closed", "state_reason": "completed"},
        )

    def test_close_with_not_planned(self, client: GitHubClient) -> None:
        """not_planned理由でクローズ"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "number": 124,
            "state": "closed",
            "state_reason": "not_planned",
        }
        client._rest.patch.return_value = mock_response

        result = client.close_issue("owner", "repo", 124, state_reason="not_planned")

        assert result["state"] == "closed"
        call_args = client._rest.patch.call_args
        assert call_args[1]["json"]["state_reason"] == "not_planned"

    def test_close_not_found(self, client: GitHubClient) -> None:
        """Issueが見つからない場合"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 404
        mock_response.text = "Not Found"
        mock_response.url = "https://api.github.com/repos/owner/repo/issues/999"
        client._rest.patch.return_value = mock_response

        with pytest.raises(GitHubNotFoundError, match="リソースが見つかりません"):
            client.close_issue("owner", "repo", 999)

    def test_close_already_closed(self, client: GitHubClient) -> None:
        """既にクローズ済みの場合も成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "number": 125,
            "state": "closed",
            "state_reason": "completed",
        }
        client._rest.patch.return_value = mock_response

        result = client.close_issue("owner", "repo", 125)

        assert result["state"] == "closed"


# GitHubClient update_issue_body テスト


class TestUpdateIssueBody:
    """update_issue_body メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            return client

    def test_patches_only_the_body(self, client: GitHubClient) -> None:
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {"number": 7, "body": "new"}
        client._rest.patch.return_value = mock_response

        result = client.update_issue_body("owner", "repo", 7, "new")

        assert result["body"] == "new"
        client._rest.patch.assert_called_once_with(
            "/repos/owner/repo/issues/7", json={"body": "new"}
        )

    def test_not_found(self, client: GitHubClient) -> None:
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 404
        mock_response.text = "Not Found"
        mock_response.url = "https://api.github.com/repos/owner/repo/issues/7"
        client._rest.patch.return_value = mock_response

        with pytest.raises(GitHubNotFoundError):
            client.update_issue_body("owner", "repo", 7, "x")

    def test_422_raises_api_error(self, client: GitHubClient) -> None:
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 422
        mock_response.text = '{"message": "Validation Failed"}'
        mock_response.url = "https://api.github.com/repos/owner/repo/issues/7"
        client._rest.patch.return_value = mock_response

        with pytest.raises(GitHubAPIError) as excinfo:
            client.update_issue_body("owner", "repo", 7, "x" * 70000)
        assert excinfo.value.status_code == 422


# GitHubClient reopen_issue テスト


class TestReopenIssue:
    """reopen_issue メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            return client

    def test_reopen_issue_success(self, client: GitHubClient) -> None:
        """Issue再オープン成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "number": 123,
            "state": "open",
            "title": "Test Issue",
        }
        client._rest.patch.return_value = mock_response

        result = client.reopen_issue("owner", "repo", 123)

        assert result["state"] == "open"
        assert result["number"] == 123
        client._rest.patch.assert_called_once_with(
            "/repos/owner/repo/issues/123",
            json={"state": "open", "state_reason": "reopened"},
        )

    def test_reopen_issue_not_found(self, client: GitHubClient) -> None:
        """Issueが見つからない場合"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 404
        mock_response.text = "Not Found"
        mock_response.url = "https://api.github.com/repos/owner/repo/issues/999"
        client._rest.patch.return_value = mock_response

        with pytest.raises(GitHubNotFoundError, match="リソースが見つかりません"):
            client.reopen_issue("owner", "repo", 999)

    def test_reopen_issue_ghes(self, client: GitHubClient) -> None:
        """GitHub Enterprise環境での再オープン"""
        # GHES環境のクライアント
        with patch.object(GitHubClient, "_setup_clients"):
            ghes_client = GitHubClient(host="ghes.example.com", token="test_token")
            ghes_client._rest = MagicMock()

        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "number": 456,
            "state": "open",
            "title": "GHES Issue",
        }
        ghes_client._rest.patch.return_value = mock_response

        result = ghes_client.reopen_issue("org", "repo", 456)

        assert result["state"] == "open"
        assert result["number"] == 456
        ghes_client._rest.patch.assert_called_once_with(
            "/repos/org/repo/issues/456",
            json={"state": "open", "state_reason": "reopened"},
        )


# GitHubClient delete_branch テスト


class TestDeleteBranch:
    """delete_branch メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            return client

    def test_delete_success(self, client: GitHubClient) -> None:
        """ブランチ削除成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.status_code = 204
        client._rest.delete.return_value = mock_response

        client.delete_branch("owner", "repo", "feat/test-branch")

        client._rest.delete.assert_called_once_with(
            "/repos/owner/repo/git/refs/heads/feat/test-branch"
        )

    def test_delete_branch_not_found(self, client: GitHubClient) -> None:
        """ブランチが見つからない場合"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 422
        mock_response.text = "Reference does not exist"
        mock_response.url = "https://api.github.com/repos/owner/repo/git/refs/heads/nonexistent"
        client._rest.delete.return_value = mock_response

        with pytest.raises(GitHubAPIError, match="422"):
            client.delete_branch("owner", "repo", "nonexistent")

    def test_delete_protected_branch(self, client: GitHubClient) -> None:
        """保護されたブランチの場合"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 403
        mock_response.text = "Cannot delete a protected branch"
        client._rest.delete.return_value = mock_response

        with pytest.raises(GitHubAPIError, match="アクセスが拒否"):
            client.delete_branch("owner", "repo", "main")


# GitHubClient get_repository_default_branch テスト


class TestGetRepositoryDefaultBranch:
    """get_repository_default_branch メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            return client

    def test_default_branch_main(self, client: GitHubClient) -> None:
        """デフォルトブランチがmainの場合"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "name": "repo",
            "default_branch": "main",
        }
        client._rest.get.return_value = mock_response

        result = client.get_repository_default_branch("owner", "repo")

        assert result == "main"
        client._rest.get.assert_called_once_with("/repos/owner/repo")

    def test_default_branch_master(self, client: GitHubClient) -> None:
        """デフォルトブランチがmasterの場合"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "name": "repo",
            "default_branch": "master",
        }
        client._rest.get.return_value = mock_response

        result = client.get_repository_default_branch("owner", "repo")

        assert result == "master"

    def test_repository_not_found(self, client: GitHubClient) -> None:
        """リポジトリが見つからない場合"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 404
        mock_response.text = "Not Found"
        mock_response.url = "https://api.github.com/repos/owner/nonexistent"
        client._rest.get.return_value = mock_response

        with pytest.raises(GitHubNotFoundError):
            client.get_repository_default_branch("owner", "nonexistent")


# create_release テスト


class TestCreateRelease:
    """create_release メソッドのテスト"""

    @pytest.fixture
    def client(self) -> GitHubClient:
        """テスト用クライアント（モック済み）"""
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="test_token")
            client._rest = MagicMock()
            return client

    def test_create_release_success(self, client: GitHubClient) -> None:
        """リリース作成成功"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "id": 1,
            "tag_name": "v0.6.1",
            "name": "v0.6.1",
            "html_url": "https://github.com/owner/repo/releases/tag/v0.6.1",
        }
        client._rest.post.return_value = mock_response

        result = client.create_release(
            owner="owner",
            repo="repo",
            tag_name="v0.6.1",
            name="v0.6.1",
            body="### 追加\n\n- 新機能",
        )

        assert result["tag_name"] == "v0.6.1"
        assert "html_url" in result
        client._rest.post.assert_called_once()
        call_args = client._rest.post.call_args
        assert call_args[0][0] == "/repos/owner/repo/releases"
        assert call_args[1]["json"]["tag_name"] == "v0.6.1"
        assert call_args[1]["json"]["target_commitish"] == "main"

    def test_create_release_custom_target(self, client: GitHubClient) -> None:
        """カスタムターゲットでリリース作成"""
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {"id": 2, "tag_name": "v1.0.0"}
        client._rest.post.return_value = mock_response

        client.create_release(
            owner="owner",
            repo="repo",
            tag_name="v1.0.0",
            name="v1.0.0",
            body="Release notes",
            target_commitish="release",
            draft=True,
            prerelease=True,
        )

        call_args = client._rest.post.call_args
        json_data = call_args[1]["json"]
        assert json_data["target_commitish"] == "release"
        assert json_data["draft"] is True
        assert json_data["prerelease"] is True

    def test_create_release_api_error(self, client: GitHubClient) -> None:
        """API エラーの場合"""
        mock_response = MagicMock()
        mock_response.is_success = False
        mock_response.status_code = 422
        mock_response.text = "Validation Failed"
        client._rest.post.return_value = mock_response

        with pytest.raises(GitHubAPIError):
            client.create_release(
                owner="owner",
                repo="repo",
                tag_name="v0.6.1",
                name="v0.6.1",
                body="notes",
            )


class TestAuthHeaderPrefix:
    """Authorization ヘッダーのプレフィックスがホスト種別に応じて設定される"""

    def test_github_com_uses_bearer(self) -> None:
        """github.com は Bearer プレフィックスを使用"""
        client = GitHubClient(host="github.com", token="ghp_test123")
        assert client._rest.headers["authorization"] == "Bearer ghp_test123"
        client.close()

    def test_ghe_server_uses_token(self) -> None:
        """GHE Server は token プレフィックスを使用（gh CLI 互換）"""
        client = GitHubClient(host="ghes.example.com", token="gho_test123")
        assert client._rest.headers["authorization"] == "token gho_test123"
        client.close()

    def test_other_ghe_server_uses_token(self) -> None:
        """他の GHE Server も token プレフィックスを使用"""
        client = GitHubClient(host="ghe.example.org", token="ghp_abc")
        assert client._rest.headers["authorization"] == "token ghp_abc"
        client.close()


class TestTokenFallback:
    """401時にgh auth tokenへフォールバックしてリトライ"""

    def test_rest_fallback_on_401(self, capsys: pytest.CaptureFixture[str]) -> None:
        """REST API 401→gh auth tokenフォールバック→リトライ成功、stderr警告出力"""
        client = GitHubClient(host="ghes.example.com", token="expired_token")

        response_401 = MagicMock(spec=httpx.Response)
        response_401.status_code = 401
        response_401.is_success = False

        response_200 = MagicMock(spec=httpx.Response)
        response_200.status_code = 200
        response_200.is_success = True
        response_200.json.return_value = {"login": "testuser"}

        call_count = 0

        def mock_get(url, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return response_401
            return response_200

        # _setup_clientsをモックして、リビルド後も同じモック関数を使う
        original_setup = client._setup_clients

        def patched_setup():
            original_setup()
            client._rest.get = mock_get

        with patch.object(client, "_get_token_from_gh", return_value="fresh_token"):
            with patch.object(client, "_setup_clients", side_effect=patched_setup):
                client._rest.get = mock_get
                result = client._rest_request("get", "/user")

        assert result.status_code == 200
        assert client.token == "fresh_token"
        assert client._used_fallback is True

        captured = capsys.readouterr()
        assert "環境変数のトークンが無効です" in captured.err
        assert "gh auth token にフォールバック" in captured.err
        assert ".env のトークンを更新するか削除" in captured.err
        client.close()

    def test_no_retry_if_already_fallen_back(self) -> None:
        """既にフォールバック済みの場合は再試行しない"""
        client = GitHubClient(host="ghes.example.com", token="expired_token")
        client._used_fallback = True

        response_401 = MagicMock(spec=httpx.Response)
        response_401.status_code = 401
        response_401.is_success = False

        client._rest.get = MagicMock(return_value=response_401)
        result = client._rest_request("get", "/user")

        assert result.status_code == 401
        assert client.token == "expired_token"
        client.close()

    def test_no_retry_if_same_token(self) -> None:
        """フォールバック先も同じトークンの場合はリトライしない"""
        client = GitHubClient(host="ghes.example.com", token="same_token")

        response_401 = MagicMock(spec=httpx.Response)
        response_401.status_code = 401
        response_401.is_success = False

        client._rest.get = MagicMock(return_value=response_401)

        with patch.object(client, "_get_token_from_gh", return_value="same_token"):
            result = client._rest_request("get", "/user")

        assert result.status_code == 401
        assert client.token == "same_token"
        assert client._used_fallback is True
        client.close()


class TestPecotGithubApiUrl:
    """PECOT_GITHUB_API_URL による接続先の差し替え"""

    @pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
    def test_accepts_loopback_hosts(self, monkeypatch: pytest.MonkeyPatch, host: str) -> None:
        """受け付ける 2 つのホストで REST と GraphQL の URL を組み立てる"""
        monkeypatch.setenv("PECOT_GITHUB_API_URL", f"http://{host}:8123")
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="ghes.example.com", token="t")
        assert client.api_url == f"http://{host}:8123"
        assert client.graphql_url == f"http://{host}:8123/graphql"
        assert client.host == "ghes.example.com"

    def test_trailing_slash_is_removed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("PECOT_GITHUB_API_URL", "http://127.0.0.1:9/")
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="github.com", token="t")
        assert client.api_url == "http://127.0.0.1:9"
        assert client.graphql_url == "http://127.0.0.1:9/graphql"

    @pytest.mark.parametrize(
        "value",
        [
            "http://example.com",
            "https://127.0.0.1:8123",
            "https://localhost",
            "http://localhost.example.com",
            "http://127.0.0.1.example.com",
            "http://127.0.0.1:8123?a=1",
            "http://127.0.0.1:8123#frag",
            "http://127.0.0.1:notaport",
            "http://127.0.0.1:99999",
            "http://user@127.0.0.1:8123",
            "127.0.0.1:8123",
            "ftp://127.0.0.1",
        ],
    )
    def test_rejects_other_values(self, monkeypatch: pytest.MonkeyPatch, value: str) -> None:
        monkeypatch.setenv("PECOT_GITHUB_API_URL", value)
        with pytest.raises(ValueError, match="http://127.0.0.1 か http://localhost") as exc:
            resolve_api_url_override()
        assert str(exc.value).endswith(f": {value}")

    @pytest.mark.parametrize("value", [None, ""])
    def test_unset_and_empty_keep_default_urls(
        self, monkeypatch: pytest.MonkeyPatch, value: str | None
    ) -> None:
        if value is None:
            monkeypatch.delenv("PECOT_GITHUB_API_URL", raising=False)
        else:
            monkeypatch.setenv("PECOT_GITHUB_API_URL", value)
        assert resolve_api_url_override() is None
        with patch.object(GitHubClient, "_setup_clients"):
            client = GitHubClient(host="ghes.example.com", token="t")
        assert client.api_url == "https://ghes.example.com/api/v3"
        assert client.graphql_url == "https://ghes.example.com/api/graphql"
