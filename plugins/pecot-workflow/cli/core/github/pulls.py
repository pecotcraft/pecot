"""Pull Request 操作の API。"""

from __future__ import annotations

from typing import Any

from cli.core.github.client import GitHubClientBase
from cli.core.github.errors import GitHubNotFoundError
from cli.core.github.queries import (
    QUERY_GET_PULL_REQUEST_SLIM,
    QUERY_GET_PULL_REQUEST_WITH_REVIEWS,
)
from cli.core.ref_parser import extract_refs_issue_numbers
from cli.core.repo_resolver import RepoRef


class PullsAPI(GitHubClientBase):
    """Pull Request 操作の API。"""

    def create_pull_request(
        self,
        owner: str,
        repo: str,
        title: str,
        body: str,
        head: str,
        base: str,
        draft: bool = False,
    ) -> dict[str, Any]:
        """PRを作成

        Args:
            owner: リポジトリオーナー。
            repo: リポジトリ名。
            title: PRタイトル。
            body: PR本文。
            head: ヘッドブランチ。
            base: ベースブランチ。
            draft: ドラフトPR（デフォルトFalse）。

        Returns:
            作成されたPR情報の辞書

        Raises:
            GitHubAPIError: PR作成に失敗した場合
        """
        data: dict[str, Any] = {
            "title": title,
            "body": body,
            "head": head,
            "base": base,
            "draft": draft,
        }

        response = self._rest_request("post", f"/repos/{owner}/{repo}/pulls", json=data)
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()

    def get_pull_request_slim(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        """PR詳細を効率的に取得（GraphQL、必要なフィールドのみ）

        REST APIと比較して、以下の利点がある:
        - 不要なフィールドを除外
        - 関連Issue、レビューを1クエリで取得
        - トークン消費を大幅削減

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            number: PR番号

        Returns:
            PR情報の辞書:
            - number: PR番号
            - state: 状態（OPEN/CLOSED/MERGED）
            - title: タイトル
            - body: 本文
            - head_ref: ヘッドブランチ名
            - base_ref: ベースブランチ名
            - is_draft: ドラフトかどうか
            - mergeable: マージ可能かどうか
            - comments: コメント数
            - closing_issues: 関連Issueリスト（number, title）
            - reviews: レビューリスト（state, author）

        Raises:
            GitHubNotFoundError: リポジトリまたはPRが見つからない場合
            GitHubAPIError: その他のAPIエラー
        """
        pr = self._fetch_pull_request(QUERY_GET_PULL_REQUEST_SLIM, owner, repo, number)

        return {
            **self._format_pull_request_base(pr, owner, repo),
            "reviews": [
                {
                    "state": review["state"],
                    "author": review["author"]["login"] if review.get("author") else None,
                }
                for review in pr.get("reviews", {}).get("nodes", [])
                if review
            ],
        }

    def get_pull_request_with_reviews(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        """PR詳細をレビュー情報付きで取得

        get_pull_request_slimの拡張版。レビュー本文、行コメント（reviewThreads）を含む。
        --reviews オプション用。

        Args:
            owner: リポジトリオーナー
            repo: リポジトリ名
            number: PR番号

        Returns:
            PR情報の辞書:
            - 基本フィールド（get_pull_request_slimと同じ）
            - reviews: レビューリスト（state, author, body, submitted_at）
            - review_threads: 行コメントリスト（is_resolved, path, line, comments）

        Raises:
            GitHubNotFoundError: リポジトリまたはPRが見つからない場合
            GitHubAPIError: その他のAPIエラー
        """
        pr = self._fetch_pull_request(QUERY_GET_PULL_REQUEST_WITH_REVIEWS, owner, repo, number)

        return {
            **self._format_pull_request_base(pr, owner, repo),
            "reviews": [
                {
                    "state": review["state"],
                    "author": (
                        review["author"]["login"]
                        if review.get("author") and review["author"].get("login")
                        else None
                    ),
                    "body": review.get("body") or "",
                    "submitted_at": review.get("submittedAt"),
                }
                for review in pr.get("reviews", {}).get("nodes", [])
                if review
            ],
            "review_threads": [
                {
                    "is_resolved": thread["isResolved"],
                    "path": thread.get("path"),
                    "line": thread.get("line"),
                    "comments": [
                        {
                            "author": (
                                comment["author"]["login"]
                                if comment.get("author") and comment["author"].get("login")
                                else None
                            ),
                            "body": comment.get("body") or "",
                            "created_at": comment.get("createdAt"),
                        }
                        for comment in thread.get("comments", {}).get("nodes", [])
                        if comment
                    ],
                }
                for thread in pr.get("reviewThreads", {}).get("nodes", [])
                if thread
            ],
        }

    def _fetch_pull_request(self, query: str, owner: str, repo: str, number: int) -> dict[str, Any]:
        """PR 取得クエリを実行し pullRequest ノードを返す

        Raises:
            GitHubNotFoundError: リポジトリまたはPRが見つからない場合
            GitHubAPIError: その他のAPIエラー
        """
        result = self._execute_graphql(
            query,
            {"owner": owner, "repo": repo, "number": number},
        )

        repository = result.get("repository")
        if not repository:
            raise GitHubNotFoundError(f"リポジトリが見つかりません: {owner}/{repo}")

        pr = repository.get("pullRequest")
        if not pr:
            raise GitHubNotFoundError(f"PRが見つかりません: {owner}/{repo}/{number}")
        return pr

    @staticmethod
    def _format_pull_request_base(pr: dict[str, Any], owner: str, repo: str) -> dict[str, Any]:
        """PR の基本フィールドと closing_issues / referenced_issues を整形"""
        # Closing Issues（GitHub自動検出）
        closing_issues = [
            {
                "number": issue["number"],
                "title": issue["title"],
            }
            for issue in pr.get("closingIssuesReferences", {}).get("nodes", [])
            if issue
        ]

        # Refs #XXX（PR本文から抽出、Closing Issuesと重複しないもの）
        closing_numbers = {i["number"] for i in closing_issues}
        refs_numbers = extract_refs_issue_numbers(pr.get("body"), RepoRef(owner=owner, repo=repo))
        referenced_issues = [
            {"number": n, "title": ""} for n in sorted(refs_numbers - closing_numbers)
        ]

        return {
            "number": pr["number"],
            "state": pr["state"],
            "title": pr["title"],
            "body": pr["body"],
            "head_ref": pr["headRefName"],
            "base_ref": pr["baseRefName"],
            "is_draft": pr["isDraft"],
            "mergeable": pr["mergeable"],
            "comments": pr["comments"]["totalCount"],
            "closing_issues": closing_issues,
            "referenced_issues": referenced_issues,
        }

    def merge_pull_request(
        self,
        owner: str,
        repo: str,
        number: int,
        merge_method: str = "squash",
    ) -> dict[str, Any]:
        """PRをマージ

        Args:
            owner: リポジトリオーナー。
            repo: リポジトリ名。
            number: PR番号。
            merge_method: マージ方法（"merge", "squash", "rebase"）デフォルトはsquash。

        Returns:
            マージ結果の辞書:
            - sha: マージコミットのSHA
            - merged: マージ成功したかどうか
            - message: メッセージ

        Raises:
            GitHubNotFoundError: PRが見つからない場合
            GitHubAPIError: マージに失敗した場合
        """
        data: dict[str, Any] = {
            "merge_method": merge_method,
        }

        response = self._rest_request(
            "put", f"/repos/{owner}/{repo}/pulls/{number}/merge", json=data
        )
        if not response.is_success:
            self._handle_http_error(response)
        return response.json()
