"""Issue 操作の API。"""

from __future__ import annotations

from typing import Any

from cli.core.github.auth import as_dict
from cli.core.github.client import GitHubClientBase
from cli.core.github.errors import GitHubAPIError, GitHubNotFoundError
from cli.core.github.queries import (
    MUTATION_ADD_SUB_ISSUE,
    QUERY_GET_ISSUE_KIND,
    QUERY_GET_ISSUE_KIND_PHASE1,
    QUERY_GET_ISSUE_NODE_ID,
    QUERY_GET_ISSUE_SLIM,
    QUERY_GET_SUB_ISSUES_PAGE,
)


class IssuesAPI(GitHubClientBase):
    """Issue 操作の API。"""

    def create_issue(
        self,
        owner: str,
        repo: str,
        title: str,
        body: str = "",
        labels: list[str] | None = None,
    ) -> dict[str, Any]:
        """Issueを作成

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            title: Issueタイトル
            body: Issue本文
            labels: ラベルリスト

        Returns:
            作成されたIssue情報の辞書

        Raises:
            GitHubAPIError: Issue作成に失敗した場合
        """
        data: dict[str, Any] = {
            "title": title,
            "body": body,
        }
        if labels:
            data["labels"] = labels

        response = self._rest_request("post", f"/repos/{owner}/{repo}/issues", json=data)
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()

    def list_issues_by_label(self, owner: str, repo: str, label: str) -> list[dict[str, Any]]:
        """ラベルの付いた Issue を open・closed の両方で全件取得（REST API）

        Pull Request は除く。2 ページ目以降は Link ヘッダの ``rel="next"`` の絶対 URL を
        params 無しで辿る。

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            label: ラベル名

        Returns:
            Issue オブジェクトのリスト

        Raises:
            GitHubAPIError: 一覧を取得できない場合
        """
        issues: list[dict[str, Any]] = []
        url = f"/repos/{owner}/{repo}/issues"
        params: dict[str, Any] | None = {"state": "all", "labels": label, "per_page": 100}
        while True:
            response = self._rest_request("get", url, params=params)
            if not response.is_success:
                self._handle_http_error(response)
            issues.extend(i for i in response.json() if "pull_request" not in i)
            next_link = response.links.get("next")
            if not next_link:
                return issues
            url = next_link["url"]
            params = None

    def add_issue_comment(self, owner: str, repo: str, number: int, body: str) -> dict[str, Any]:
        """Issueにコメントを追加

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            number: Issue番号
            body: コメント本文

        Returns:
            作成されたコメント情報の辞書

        Raises:
            GitHubNotFoundError: Issueが見つからない場合
            GitHubAPIError: コメント追加に失敗した場合
        """
        response = self._rest_request(
            "post",
            f"/repos/{owner}/{repo}/issues/{number}/comments",
            json={"body": body},
        )
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()

    def get_issue_node_id(self, owner: str, repo: str, number: int) -> str:
        """Issue番号からGraphQL Node IDを取得

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            number: Issue番号

        Returns:
            GraphQL Node ID

        Raises:
            GitHubNotFoundError: Issueが見つからない場合
        """
        return self.get_issue_node_id_and_title(owner, repo, number)[0]

    def get_issue_node_id_and_title(self, owner: str, repo: str, number: int) -> tuple[str, str]:
        """Issue番号からGraphQL Node IDとタイトルを1回のクエリで取得

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            number: Issue番号

        Returns:
            (GraphQL Node ID, タイトル)

        Raises:
            GitHubNotFoundError: Issueが見つからない場合
        """
        result = self._execute_graphql(
            QUERY_GET_ISSUE_NODE_ID,
            {"owner": owner, "repo": repo, "number": number},
        )

        repository = result.get("repository")
        if not repository:
            raise GitHubNotFoundError(f"リポジトリが見つかりません: {owner}/{repo}")

        issue = repository.get("issue")
        if not issue:
            raise GitHubNotFoundError(f"Issueが見つかりません: {owner}/{repo}/{number}")

        return issue["id"], issue.get("title", "")

    def add_sub_issue(self, parent_issue_id: str, child_issue_id: str) -> dict[str, int]:
        """サブIssueを紐づけ

        Args:
            parent_issue_id: 親IssueのGraphQL Node ID
            child_issue_id: 子IssueのGraphQL Node ID

        Returns:
            紐づけ結果（親・子のIssue番号）

        Raises:
            GitHubAPIError: 紐づけに失敗した場合
        """
        result = self._execute_graphql(
            MUTATION_ADD_SUB_ISSUE,
            {"parentId": parent_issue_id, "childId": child_issue_id},
        )

        add_result = result.get("addSubIssue", {})
        parent = add_result.get("issue")
        child = add_result.get("subIssue")

        if not parent or not child:
            raise GitHubAPIError("サブIssueの紐づけに失敗しました")

        return {
            "parent_number": parent["number"],
            "child_number": child["number"],
        }

    def get_issue_kind(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        """Issue 種別を軽量に取得する。

        Returns:
            辞書: {number, state, issue_type, sub_issues_total}。
            issue_type は issueType フィールド非対応 GHES では None になりうる。

        Raises:
            GitHubNotFoundError: リポジトリまたは Issue が見つからない場合
            GitHubAPIError: その他の API エラー
        """
        variables = {"owner": owner, "repo": repo, "number": number}
        try:
            result = self._execute_graphql(QUERY_GET_ISSUE_KIND, variables)
        except GitHubAPIError as e:
            msg = e.message or ""
            schema_error_phrases = ("Cannot query field", "doesn't exist", "Unknown field")
            if "issueType" in msg and any(phrase in msg for phrase in schema_error_phrases):
                return self._get_issue_kind_phase1(owner, repo, number)
            raise

        repo_data = result.get("repository")
        if repo_data is None:
            raise GitHubNotFoundError(f"リポジトリが見つかりません: {owner}/{repo}")
        issue = repo_data.get("issue")
        if issue is None:
            raise GitHubNotFoundError(f"Issueが見つかりません: {owner}/{repo}/{number}")
        return {
            "number": issue["number"],
            "state": issue["state"],
            "issue_type": as_dict(issue.get("issueType")).get("name"),
            "sub_issues_total": as_dict(issue.get("subIssues")).get("totalCount", 0),
        }

    def _get_issue_kind_phase1(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        """issueType フィールド非対応 GHES 用の Phase1 単独判定。"""
        variables = {"owner": owner, "repo": repo, "number": number}
        result = self._execute_graphql(QUERY_GET_ISSUE_KIND_PHASE1, variables)
        repo_data = result.get("repository")
        if repo_data is None:
            raise GitHubNotFoundError(f"リポジトリが見つかりません: {owner}/{repo}")
        issue = repo_data.get("issue")
        if issue is None:
            raise GitHubNotFoundError(f"Issueが見つかりません: {owner}/{repo}/{number}")
        return {
            "number": issue["number"],
            "state": issue["state"],
            "issue_type": None,
            "sub_issues_total": as_dict(issue.get("subIssues")).get("totalCount", 0),
        }

    def get_issue_slim(
        self, owner: str, repo: str, number: int, comment_limit: int = 5
    ) -> dict[str, Any]:
        """Issue詳細を効率的に取得（GraphQL、必要なフィールドのみ）

        REST APIのIssue取得と比較して、以下の利点がある。
        - 不要なフィールド（reactions, API URLs等）を除外
        - 親Issue、サブIssue、リンクブランチを1クエリで取得
        - トークン消費を減らせる。

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            number: Issue番号
            comment_limit: 取得するコメント数（デフォルト: 5）

        Returns:
            Issue情報の辞書:
            - number: Issue番号
            - state: 状態（OPEN/CLOSED）
            - title: タイトル
            - body: 本文
            - comments: コメント情報（total_count, nodes）
            - parent: 親Issue情報（number, title, state）またはNone
            - sub_issues: サブIssueリスト（number, title, state）
            - linked_branches: リンクブランチ名リスト

        Raises:
            GitHubNotFoundError: リポジトリまたはIssueが見つからない場合
            GitHubAPIError: その他のAPIエラー
        """
        result = self._execute_graphql(
            QUERY_GET_ISSUE_SLIM,
            {"owner": owner, "repo": repo, "number": number, "commentLimit": comment_limit},
        )

        repository = result.get("repository")
        if not repository:
            raise GitHubNotFoundError(f"リポジトリが見つかりません: {owner}/{repo}")

        issue = repository.get("issue")
        if not issue:
            raise GitHubNotFoundError(f"Issueが見つかりません: {owner}/{repo}/{number}")

        sub_issue_nodes = self._collect_sub_issue_nodes(owner, repo, number, issue)

        # レスポンスを整形
        return {
            "number": issue["number"],
            "state": issue["state"],
            "title": issue["title"],
            "body": issue["body"],
            "comments": {
                "total_count": issue["comments"]["totalCount"],
                "nodes": [
                    {
                        "author": comment["author"]["login"] if comment.get("author") else "ghost",
                        "created_at": comment["createdAt"],
                        "body": comment["body"],
                    }
                    for comment in issue.get("comments", {}).get("nodes", [])
                    if comment
                ],
            },
            "parent": self._format_parent(issue.get("parent")),
            "sub_issues": [
                {
                    "number": sub["number"],
                    "state": sub["state"],
                    "title": sub["title"],
                }
                for sub in sub_issue_nodes
                if sub
            ],
            "linked_branches": [
                branch["ref"]["name"]
                for branch in issue.get("linkedBranches", {}).get("nodes", [])
                if branch and branch.get("ref")
            ],
            "linked_prs": self._extract_linked_prs(issue.get("timelineItems", {})),
        }

    def _collect_sub_issue_nodes(
        self, owner: str, repo: str, number: int, issue: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """サブIssueの全件を返す。先頭ページで足りないときだけ続きを取得する。"""
        sub_issues = as_dict(issue.get("subIssues"))
        nodes = list(sub_issues.get("nodes", []))
        page_info = as_dict(sub_issues.get("pageInfo"))
        while page_info.get("hasNextPage") and page_info.get("endCursor"):
            result = self._execute_graphql(
                QUERY_GET_SUB_ISSUES_PAGE,
                {"owner": owner, "repo": repo, "number": number, "after": page_info["endCursor"]},
            )
            page = as_dict(as_dict(as_dict(result.get("repository")).get("issue")).get("subIssues"))
            nodes.extend(page.get("nodes", []))
            page_info = as_dict(page.get("pageInfo"))
        return nodes

    @staticmethod
    def _format_parent(parent: dict[str, Any] | None) -> dict[str, Any] | None:
        """parent GraphQL ノードを辞書に整形（キーは number / title / state / owner / repo）"""
        if not parent:
            return None
        repository = as_dict(parent.get("repository"))
        owner_node = as_dict(repository.get("owner"))
        return {
            "number": parent["number"],
            "title": parent["title"],
            "state": parent["state"],
            "owner": owner_node.get("login"),
            "repo": repository.get("name"),
        }

    def _extract_linked_prs(self, timeline_items: dict[str, Any]) -> list[dict[str, Any]]:
        """timelineItemsからリンクPR情報を抽出

        CONNECTED_EVENTとCROSS_REFERENCED_EVENTからPR情報を取得し、
        PR番号で重複除去して返す。

        Args:
            timeline_items: timelineItemsフィールドのレスポンス

        Returns:
            PR情報のリスト（number, title, stateを含む辞書）
        """
        seen_numbers: set[int] = set()
        prs: list[dict[str, Any]] = []

        nodes = timeline_items.get("nodes", [])
        for node in nodes:
            if not node:
                continue

            # ConnectedEvent: subject にPR情報がある
            pr_data = node.get("subject")
            # CrossReferencedEvent: source にPR情報がある
            if not pr_data:
                pr_data = node.get("source")

            if not pr_data:
                continue

            pr_number = pr_data.get("number")
            if not pr_number or pr_number in seen_numbers:
                continue

            seen_numbers.add(pr_number)
            prs.append(
                {
                    "number": pr_number,
                    "title": pr_data.get("title", ""),
                    "state": pr_data.get("state", ""),
                }
            )

        return prs

    def close_issue(
        self,
        owner: str,
        repo: str,
        number: int,
        state_reason: str = "completed",
    ) -> dict[str, Any]:
        """Issueをクローズ

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            number: Issue番号
            state_reason: クローズ理由（"completed" または "not_planned"）

        Returns:
            更新されたIssue情報の辞書

        Raises:
            GitHubNotFoundError: Issueが見つからない場合
            GitHubAPIError: クローズに失敗した場合
        """
        data: dict[str, Any] = {
            "state": "closed",
            "state_reason": state_reason,
        }

        response = self._rest_request("patch", f"/repos/{owner}/{repo}/issues/{number}", json=data)
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()

    def update_issue_body(self, owner: str, repo: str, number: int, body: str) -> dict[str, Any]:
        """Issue の本文を丸ごと置き換える（REST の PATCH）

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            number: Issue番号
            body: 新しい本文

        Returns:
            更新されたIssue情報の辞書

        Raises:
            GitHubNotFoundError: Issueが見つからない場合
            GitHubAPIError: 更新に失敗した場合（本文が上限を超える 422 を含む）
        """
        response = self._rest_request(
            "patch", f"/repos/{owner}/{repo}/issues/{number}", json={"body": body}
        )
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()

    def reopen_issue(
        self,
        owner: str,
        repo: str,
        number: int,
    ) -> dict[str, Any]:
        """Issueを再オープン

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            number: Issue番号

        Returns:
            更新されたIssue情報の辞書

        Raises:
            GitHubNotFoundError: Issueが見つからない場合
            GitHubAPIError: 再オープンに失敗した場合
        """
        data: dict[str, Any] = {"state": "open", "state_reason": "reopened"}

        response = self._rest_request("patch", f"/repos/{owner}/{repo}/issues/{number}", json=data)
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()
