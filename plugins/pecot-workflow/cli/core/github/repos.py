"""リポジトリ・ブランチ・リリース操作の API。"""

from __future__ import annotations

from typing import Any

from cli.core.github.client import GitHubClientBase
from cli.core.github.errors import GitHubAPIError, GitHubNotFoundError
from cli.core.github.queries import (
    MUTATION_CREATE_LINKED_BRANCH,
    QUERY_GET_REPOSITORY_ID,
)


class ReposAPI(GitHubClientBase):
    """リポジトリ・ブランチ・リリース操作の API。"""

    def get_repository_id(self, owner: str, name: str) -> str:
        """リポジトリのGraphQL Node IDを取得

        Args:
            owner: リポジトリオーナー
            name: リポジトリ名

        Returns:
            GraphQL Node ID

        Raises:
            GitHubNotFoundError: リポジトリが見つからない場合
        """
        result = self._execute_graphql(
            QUERY_GET_REPOSITORY_ID,
            {"owner": owner, "name": name},
        )

        repository = result.get("repository")
        if not repository:
            raise GitHubNotFoundError(f"リポジトリが見つかりません: {owner}/{name}")

        return repository["id"]

    def get_branch_sha(self, owner: str, repo: str, branch: str) -> str:
        """ブランチの最新commit SHAを取得（REST API）

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            branch: ブランチ名

        Returns:
            commit SHA

        Raises:
            GitHubNotFoundError: ブランチが見つからない場合
            GitHubAPIError: その他のAPIエラー
        """
        response = self._rest_request("get", f"/repos/{owner}/{repo}/git/ref/heads/{branch}")
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()["object"]["sha"]

    def create_linked_branch(
        self,
        issue_id: str,
        oid: str,
        name: str,
        repository_id: str | None = None,
    ) -> str:
        """Issueに紐づいたブランチを作成（GraphQL）

        gh issue develop と同等の機能を提供する。

        Args:
            issue_id: IssueのGraphQL Node ID。
            oid: ベースブランチのcommit SHA（GitObjectID）。
            name: 作成するブランチ名。
            repository_id: リポジトリのNode ID（省略時はIssueと同じリポジトリ）。

        Returns:
            作成されたブランチ名

        Raises:
            GitHubAPIError: ブランチ作成に失敗した場合
        """
        input_data: dict[str, Any] = {
            "issueId": issue_id,
            "oid": oid,
            "name": name,
        }
        if repository_id:
            input_data["repositoryId"] = repository_id

        result = self._execute_graphql(
            MUTATION_CREATE_LINKED_BRANCH,
            {"input": input_data},
        )

        linked_branch = result.get("createLinkedBranch", {}).get("linkedBranch")
        if not linked_branch:
            raise GitHubAPIError("リンクブランチの作成に失敗しました")

        return linked_branch["ref"]["name"]

    def delete_branch(
        self,
        owner: str,
        repo: str,
        branch: str,
    ) -> None:
        """ブランチを削除

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            branch: ブランチ名

        Raises:
            GitHubAPIError: 削除に失敗した場合（保護されたブランチ等）
        """
        response = self._rest_request("delete", f"/repos/{owner}/{repo}/git/refs/heads/{branch}")
        if not response.is_success:
            self._handle_http_error(response)

    def create_release(
        self,
        owner: str,
        repo: str,
        tag_name: str,
        name: str,
        body: str,
        target_commitish: str = "main",
        draft: bool = False,
        prerelease: bool = False,
    ) -> dict[str, Any]:
        """GitHubリリースを作成

        POST /repos/{owner}/{repo}/releases でリリースを作成する。
        target_commitish指定でタグも自動作成されるため、
        git tag + git push が不要になる。

        Args:
            owner: リポジトリオーナー。
            repo: リポジトリ名。
            tag_name: タグ名（例: "v0.6.1"）。
            name: リリース名（例: "v0.6.1"）。
            body: リリースノート。
            target_commitish: タグのターゲット（デフォルト: "main"）。
            draft: ドラフトリリース（デフォルト: False）。
            prerelease: プレリリース（デフォルト: False）。

        Returns:
            作成されたリリース情報の辞書（id, html_url, tag_name等）

        Raises:
            GitHubAPIError: リリース作成に失敗した場合
        """
        data: dict[str, Any] = {
            "tag_name": tag_name,
            "name": name,
            "body": body,
            "target_commitish": target_commitish,
            "draft": draft,
            "prerelease": prerelease,
        }

        response = self._rest_request("post", f"/repos/{owner}/{repo}/releases", json=data)
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()

    def get_repository_default_branch(self, owner: str, repo: str) -> str:
        """リポジトリのデフォルトブランチ名を取得

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名

        Returns:
            デフォルトブランチ名（例: "main"）

        Raises:
            GitHubNotFoundError: リポジトリが見つからない場合
            GitHubAPIError: API呼び出しに失敗した場合
        """
        response = self._rest_request("get", f"/repos/{owner}/{repo}")
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()["default_branch"]

    def list_open_dependabot_alerts(self, owner: str, repo: str) -> list[dict[str, Any]]:
        """open な Dependabot alert を全件取得（REST API）

        一覧は cursor 方式のページングで ``page`` パラメータを持たない。
        2 ページ目以降は Link ヘッダの ``rel="next"`` の絶対 URL をそのまま
        辿る（params を再送すると cursor と二重指定になる）。

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名

        Returns:
            alert オブジェクトのリスト

        Raises:
            GitHubAPIError: alerts 無効（403）等で一覧を取得できない場合
        """
        return self._list_all(
            f"/repos/{owner}/{repo}/dependabot/alerts", {"state": "open", "per_page": 100}
        )

    def _list_all(self, url: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        """一覧 API を Link ヘッダの ``rel="next"`` で最後まで辿って集める

        2 ページ目以降は絶対 URL をそのまま辿る（params を再送すると cursor と二重指定になる）。
        """
        items: list[dict[str, Any]] = []
        next_params: dict[str, Any] | None = params
        while True:
            response = self._rest_request("get", url, params=next_params)
            if not response.is_success:
                self._handle_http_error(response)
            items.extend(response.json())
            next_link = response.links.get("next")
            if not next_link:
                return items
            url = next_link["url"]
            next_params = None

    def get_dependabot_alert(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        """Dependabot alert を 1 件取得（REST API）

        Raises:
            GitHubNotFoundError: alert が無い場合
            GitHubAPIError: その他のAPIエラー
        """
        response = self._rest_request("get", f"/repos/{owner}/{repo}/dependabot/alerts/{number}")
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()

    def list_open_code_scanning_alerts(
        self, owner: str, repo: str, ref: str = "refs/heads/main"
    ) -> list[dict[str, Any]]:
        """open な code scanning alert を ref 指定で全件取得（REST API）

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            ref: 対象の ref（例: ``refs/heads/main``）

        Raises:
            GitHubAPIError: GHAS 無し（403）・analysis 無し（404）等で一覧を取得できない場合
        """
        return self._list_all(
            f"/repos/{owner}/{repo}/code-scanning/alerts",
            {"state": "open", "ref": ref, "per_page": 100},
        )

    def get_code_scanning_alert(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        """code scanning alert を 1 件取得（REST API）

        Raises:
            GitHubNotFoundError: alert が無い場合
            GitHubAPIError: その他のAPIエラー
        """
        response = self._rest_request("get", f"/repos/{owner}/{repo}/code-scanning/alerts/{number}")
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()

    def list_open_secret_scanning_alerts(self, owner: str, repo: str) -> list[dict[str, Any]]:
        """open な secret scanning alert を全件取得（REST API）

        secret の値が応答に載らないよう、必ず ``hide_secret=true`` を付ける。

        Raises:
            GitHubAPIError: secret scanning 無効（404）等で一覧を取得できない場合
        """
        return self._list_all(
            f"/repos/{owner}/{repo}/secret-scanning/alerts",
            {"state": "open", "hide_secret": "true", "per_page": 100},
        )

    def get_secret_scanning_alert(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        """secret scanning alert を 1 件取得（REST API、``hide_secret=true``）

        Raises:
            GitHubNotFoundError: alert が無い場合
            GitHubAPIError: その他のAPIエラー
        """
        response = self._rest_request(
            "get",
            f"/repos/{owner}/{repo}/secret-scanning/alerts/{number}",
            params={"hide_secret": "true"},
        )
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()

    def is_dependabot_alerts_enabled(self, owner: str, repo: str) -> bool:
        """リポジトリで Dependabot alerts が有効かを取得（REST API）

        GET /repos/{owner}/{repo}/vulnerability-alerts は有効で 204、
        無効で 404 を返す。

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名

        Returns:
            有効なら True、無効なら False

        Raises:
            GitHubAPIError: 204 / 404 以外の応答
        """
        response = self._rest_request("get", f"/repos/{owner}/{repo}/vulnerability-alerts")
        if response.status_code == 204:
            return True
        if response.status_code == 404:
            return False
        self._handle_http_error(response)
