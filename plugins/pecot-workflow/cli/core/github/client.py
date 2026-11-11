"""GitHub API クライアントの基底（認証・HTTP/GraphQL 実行・エラー変換）。"""

from __future__ import annotations

import logging
import os
import subprocess
from typing import TYPE_CHECKING, Any, NoReturn
from urllib.parse import urlsplit

import httpx
from gql import Client, GraphQLRequest
from gql.transport.httpx import HTTPXTransport

from cli.core.github import auth
from cli.core.github.errors import (
    GitHubAPIError,
    GitHubAuthError,
    GitHubNotFoundError,
    GitHubRateLimitError,
)

if TYPE_CHECKING:
    from typing_extensions import Self

logger = logging.getLogger(__name__)

_LOOPBACK_HOSTS = ("127.0.0.1", "localhost")

TOKEN_FALLBACK_WARNING = (
    "the token in the environment variable is invalid (401 Unauthorized); fell back to gh auth token\n"
    "update or remove the token in .env"
)


def resolve_api_url_override() -> str | None:
    """PECOT_GITHUB_API_URL を検証して返す。未設定・空文字なら None。

    前後比較のテストが GitHub の代わりに偽サーバへ向けるための差し替え口。
    ループバックの http URL だけを受け付け、それ以外は ValueError にする。
    """
    raw = os.environ.get("PECOT_GITHUB_API_URL", "")
    if raw == "":
        return None
    message = (
        f"PECOT_GITHUB_API_URL accepts only an http://127.0.0.1 or http://localhost URL: {raw}"
    )
    try:
        parts = urlsplit(raw)
        # port は参照したときに不正な値を検出する
        _ = parts.port
    except ValueError as e:
        raise ValueError(message) from e
    if parts.scheme != "http" or parts.hostname not in _LOOPBACK_HOSTS:
        raise ValueError(message)
    if parts.query or parts.fragment or parts.username is not None or parts.password is not None:
        raise ValueError(message)
    return raw.rstrip("/")


class GitHubClientBase:
    """GitHub API クライアント（REST + GraphQL統合）

    GHES（GitHub Enterprise Server）とgithub.comの両方に対応する。

    認証優先順位:
    1. token引数（明示指定）
    2. 環境変数（config/.envから読み込み）
    3. gh auth token（フォールバック）

    Attributes:
        host: GitHubホスト（例: "github.com", "ghes.example.com"）。
        token: 認証トークン。
        api_url: REST API ベースURL。
        graphql_url: GraphQL API URL。

    Example:
        >>> client = GitHubClient(host="ghes.example.com")

        >>> issue = client.get_issue_slim("owner", "repo", 123)

        >>> print(issue["title"])
    """

    def __init__(
        self,
        host: str = "github.com",
        token: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        """初期化

        Args:
            host: GitHubホスト（デフォルト: "github.com"）。
            token: 認証トークン（Noneの場合は環境変数またはgh auth tokenから取得）。
            timeout: HTTPリクエストタイムアウト秒数（デフォルト: 30.0）。

        Raises:
            GitHubAuthError: トークン取得に失敗した場合
        """
        self.host = host
        self.token = token or self._get_token(host)
        self.timeout = timeout

        self._used_fallback = False

        # キャッシュ用辞書
        self._linked_repos_cache: dict[str, list[dict[str, str]]] = {}

        self._setup_urls()
        self._setup_clients()

    def _get_token(self, host: str) -> str:
        """トークンを優先順位に従って取得

        優先順位:
        1. config/.env の PECOT_GITHUB_*_TOKEN
        2. ルート .env の GITHUB_COM_TOKEN
        3. gh auth token（フォールバック）

        Args:
            host: GitHubホスト

        Returns:
            認証トークン

        Raises:
            GitHubAuthError: トークン取得に失敗した場合
        """
        # 1-2. 環境変数から取得を試みる（config/.env → ルート .env）
        token = self._get_token_from_env(host)
        if token:
            return token

        # 3. gh auth tokenにフォールバック
        return self._get_token_from_gh(host)

    def _get_token_from_env(self, host: str) -> str | None:
        """環境変数からトークンを取得

        優先順位:
        1. config/.env の PECOT_GITHUB_*_TOKEN
        2. ルート .env の GITHUB_COM_TOKEN

        Args:
            host: GitHubホスト

        Returns:
            トークン（見つからない場合はNone）
        """
        # 1. config/.envをロード
        env_file = auth.get_config_dir() / ".env"
        auth.load_env_file(env_file)

        # ホストに対応する環境変数名を取得
        env_name = auth.get_env_var_name(host)
        # interface-env: PECOT_GITHUB_*_TOKEN
        token = os.environ.get(env_name)
        if token:
            return token

        # 2. ルート .env をフォールバック読み込み
        root_env_file = auth.get_project_root() / ".env"
        auth.load_env_file(root_env_file)

        root_env_name = auth.ROOT_ENV_VAR_MAP.get(host)
        if root_env_name:
            # interface-env: GITHUB_COM_TOKEN
            return os.environ.get(root_env_name)

        return None

    def _get_token_from_gh(self, host: str) -> str:
        """gh auth tokenからトークンを取得

        Args:
            host: GitHubホスト

        Returns:
            認証トークン

        Raises:
            GitHubAuthError: トークン取得に失敗した場合
        """
        try:
            if host == "github.com":
                cmd = ["gh", "auth", "token"]
            else:
                cmd = ["gh", "auth", "token", "-h", host]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
            )
            return result.stdout.strip()
        except subprocess.CalledProcessError:
            raise GitHubAuthError(self._build_auth_error_message(host)) from None
        except FileNotFoundError:
            raise GitHubAuthError(self._build_auth_error_message(host)) from None

    def _build_auth_error_message(self, host: str) -> str:
        """認証エラーメッセージを構築し、.envファイルを自動生成

        .envファイルが存在しない場合は自動生成する。
        存在する場合は、当該ホストの環境変数が未設定なら追記する。

        Args:
            host: GitHubホスト

        Returns:
            エラーメッセージ
        """
        # .envファイルを自動生成/更新
        env_file = auth.ensure_env_file(host)

        env_var_name = auth.get_env_var_name(host)
        host_config = auth.get_host_config(host)
        token_url = host_config["token_url"] if host_config else f"https://{host}/settings/tokens"
        scopes: list[str] = host_config.get("scopes", []) if host_config else []

        scopes_line = f"   required scopes: {', '.join(scopes)}" if scopes else ""

        return f"""authentication error: could not get a GitHub API token

{env_file} was generated. Set the token as follows:

1. get a token: {token_url}
{scopes_line}

2. edit {env_file} and set the token in {env_var_name}

or authenticate with the GitHub CLI:
   gh auth login -h {host}"""

    def _setup_urls(self) -> None:
        """ホスト種別に応じたURL構造を設定"""
        # 起動時の確認は main の callback が済ませている。ここでは値を読むだけ
        override = resolve_api_url_override()
        if override is not None:
            self.api_url = override
            self.graphql_url = f"{override}/graphql"
        elif self.host == "github.com":
            self.api_url = "https://api.github.com"
            self.graphql_url = "https://api.github.com/graphql"
        else:
            # GitHub Enterprise Server
            self.api_url = f"https://{self.host}/api/v3"
            self.graphql_url = f"https://{self.host}/api/graphql"

    def _setup_clients(self) -> None:
        """httpx + gqlクライアントを初期化"""
        # github.com は Bearer、GHE Server は token（gh CLI 互換）
        auth_prefix = "Bearer" if self.host == "github.com" else "token"
        headers = {
            "Authorization": f"{auth_prefix} {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

        # REST APIクライアント
        self._rest = httpx.Client(
            base_url=self.api_url,
            headers=headers,
            timeout=self.timeout,
        )

        # GraphQL APIクライアント
        transport = HTTPXTransport(
            url=self.graphql_url,
            headers=headers,
            timeout=self.timeout,
        )
        self._graphql = Client(transport=transport, fetch_schema_from_transport=False)

    def _retry_with_fallback_token(self) -> bool:
        """envトークンが失効した場合、gh auth tokenにフォールバック"""
        if self._used_fallback:
            return False
        self._used_fallback = True
        try:
            new_token = self._get_token_from_gh(self.host)
        except GitHubAuthError:
            return False
        if new_token == self.token:
            return False
        # core cannot import Output; the handler in commands/_output.py adds the prefix and indent.
        logger.warning(TOKEN_FALLBACK_WARNING)
        self.token = new_token
        self.close()
        self._setup_clients()
        return True

    def _rest_request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """REST APIリクエスト（401時フォールバック付き）"""
        response = getattr(self._rest, method)(url, **kwargs)
        if response.status_code == 401 and self._retry_with_fallback_token():
            response = getattr(self._rest, method)(url, **kwargs)
        return response

    def close(self) -> None:
        """クライアントをクリーンアップ"""
        if hasattr(self, "_rest"):
            self._rest.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _handle_http_error(self, response: httpx.Response) -> NoReturn:
        """HTTPエラーレスポンスを、ステータスコード別の例外へ変換

        Args:
            response: httpx.Response

        Raises:
            GitHubAuthError: 401 Unauthorized。
            GitHubNotFoundError: 404 Not Found。
            GitHubRateLimitError: 403 Forbidden (rate limit)。
            GitHubAPIError: その他のエラー。
        """
        if response.status_code == 401:
            raise GitHubAuthError(
                "authentication failed: check the token",
                status_code=401,
                response_body=response.text,
            )
        elif response.status_code == 404:
            raise GitHubNotFoundError(
                f"resource not found: {response.url}",
                status_code=404,
                response_body=response.text,
            )
        elif response.status_code == 403:
            if "rate limit" in response.text.lower():
                raise GitHubRateLimitError(
                    "API rate limit reached",
                    status_code=403,
                    response_body=response.text,
                )
            raise GitHubAPIError(
                "access denied",
                status_code=403,
                response_body=response.text,
            )
        else:
            raise GitHubAPIError(
                f"GitHub API error: {response.status_code}",
                status_code=response.status_code,
                response_body=response.text,
            )

    def _execute_graphql(
        self, query: str, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """GraphQLクエリを実行してエラーをハンドリング

        Args:
            query: GraphQLクエリ文字列
            variables: クエリ変数

        Returns:
            GraphQLレスポンスのデータ

        Raises:
            GitHubAPIError: GraphQLエラーが発生した場合
        """
        try:
            result = self._graphql.execute(GraphQLRequest(query, variable_values=variables or {}))
            return dict(result) if result else {}
        except Exception as e:
            error_msg = str(e)
            if "401" in error_msg or "Unauthorized" in error_msg:
                if self._retry_with_fallback_token():
                    try:
                        result = self._graphql.execute(
                            GraphQLRequest(query, variable_values=variables or {})
                        )
                        return dict(result) if result else {}
                    except Exception as retry_e:
                        error_msg = str(retry_e)
                        if "401" in error_msg or "Unauthorized" in error_msg:
                            raise GitHubAuthError(
                                f"GraphQL authentication error: {error_msg}"
                            ) from retry_e
                        if "rate limit" in error_msg.lower():
                            raise GitHubRateLimitError(
                                f"GraphQL rate limit error: {error_msg}"
                            ) from retry_e
                        raise GitHubAPIError(f"GraphQL query error: {error_msg}") from retry_e
                raise GitHubAuthError(f"GraphQL authentication error: {error_msg}") from e
            if "rate limit" in error_msg.lower():
                raise GitHubRateLimitError(f"GraphQL rate limit error: {error_msg}") from e
            raise GitHubAPIError(f"GraphQL query error: {error_msg}") from e

    def get_authenticated_user(self) -> dict[str, Any]:
        """認証ユーザー情報を取得

        Returns:
            ユーザー情報の辞書（login, id, name, email など）

        Raises:
            GitHubAuthError: 認証に失敗した場合
            GitHubAPIError: その他のAPIエラー
        """
        response = self._rest_request("get", "/user")
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()
