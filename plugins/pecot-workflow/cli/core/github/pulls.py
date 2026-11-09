"""Pull Request 操作の API。"""

from __future__ import annotations

from typing import Any, cast

from cli.core.github.client import GitHubClientBase
from cli.core.github.errors import GitHubNotFoundError
from cli.core.github.queries import (
    MUTATION_ENQUEUE_PULL_REQUEST,
    QUERY_GET_COMMIT_CHECK_CONTEXTS,
    QUERY_GET_MERGE_QUEUE_STATUS,
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
            - id: PR の node id
            - head_oid: ヘッドコミットの SHA
            - is_merge_queue_enabled: ベースブランチでマージキューが有効か
            - is_in_merge_queue: マージキューに入っているか
            - has_auto_merge_request: 自動マージが予約されているか

        Raises:
            GitHubNotFoundError: リポジトリまたはPRが見つからない場合
            GitHubAPIError: その他のAPIエラー
        """
        pr = self._fetch_pull_request(QUERY_GET_PULL_REQUEST_SLIM, owner, repo, number)

        return {
            **self._format_pull_request_base(pr, owner, repo),
            "id": pr["id"],
            "head_oid": pr.get("headRefOid"),
            "is_merge_queue_enabled": pr.get("isMergeQueueEnabled") is True,
            "is_in_merge_queue": pr.get("isInMergeQueue") is True,
            "has_auto_merge_request": pr.get("autoMergeRequest") is not None,
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

    def enqueue_pull_request(self, pr_id: str, expected_head_oid: str | None) -> dict[str, Any]:
        """PR をマージキューに入れる

        Returns:
            {"position": int | None, "state": str | None}。entry が無ければ両方 None。

        Raises:
            GitHubAPIError: キューへの投入に失敗した場合（メッセージに GitHub の理由を含む）
        """
        result = self._execute_graphql(
            MUTATION_ENQUEUE_PULL_REQUEST,
            {"pullRequestId": pr_id, "expectedHeadOid": expected_head_oid},
        )
        entry = _as_dict(_as_dict(result.get("enqueuePullRequest")).get("mergeQueueEntry"))
        return {"position": entry.get("position"), "state": entry.get("state")}

    def get_merge_queue_status(self, owner: str, repo: str, number: int) -> dict[str, Any]:
        """PR のマージキューの状況を 1 回の GraphQL で取得する

        Returns:
            - state: OPEN / MERGED / CLOSED
            - merge_commit_oid: マージコミットの SHA（未マージは None）
            - is_in_merge_queue: キューに入っているか
            - entry: {"state", "position", "head_oid"}（キューに無ければ None）
            - removed: 最後の投入より後に除外されたか
            - removed_reason: その除外の reason

        Raises:
            GitHubNotFoundError: リポジトリまたはPRが見つからない場合
        """
        pr = self._fetch_pull_request(QUERY_GET_MERGE_QUEUE_STATUS, owner, repo, number)

        nodes = _as_dict_list(_as_dict(pr.get("timelineItems")).get("nodes"))
        added_times: list[str] = [
            str(n["createdAt"]) for n in nodes if n.get("__typename") == "AddedToMergeQueueEvent"
        ]
        last_added = max(added_times) if added_times else None
        # ISO 8601 の UTC 文字列は辞書順で時刻順になる
        removed_events = [
            n
            for n in nodes
            if n.get("__typename") == "RemovedFromMergeQueueEvent"
            and (last_added is None or str(n["createdAt"]) > last_added)
        ]
        latest_removed = max(removed_events, key=lambda n: str(n["createdAt"]), default=None)

        raw_entry = pr.get("mergeQueueEntry")
        entry = _as_dict(raw_entry)
        return {
            "state": pr["state"],
            "merge_commit_oid": _as_dict(pr.get("mergeCommit")).get("oid"),
            "is_in_merge_queue": pr.get("isInMergeQueue") is True,
            "entry": (
                {
                    "state": entry.get("state"),
                    "position": entry.get("position"),
                    "head_oid": _as_dict(entry.get("headCommit")).get("oid"),
                }
                if raw_entry
                else None
            ),
            "removed": latest_removed is not None,
            "removed_reason": latest_removed.get("reason") if latest_removed else None,
        }

    def get_failed_checks(self, owner: str, repo: str, oid: str) -> list[str]:
        """コミットの statusCheckRollup から、失敗したチェックの名前を返す"""
        result = self._execute_graphql(
            QUERY_GET_COMMIT_CHECK_CONTEXTS, {"owner": owner, "repo": repo, "oid": oid}
        )
        commit = _as_dict(_as_dict(result.get("repository")).get("object"))
        rollup = _as_dict(commit.get("statusCheckRollup"))
        nodes = _as_dict_list(_as_dict(rollup.get("contexts")).get("nodes"))

        failed_runs = {"FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"}
        failed: list[str] = []
        for node in nodes:
            kind = node.get("__typename")
            if kind == "CheckRun" and node.get("conclusion") in failed_runs:
                failed.append(str(node["name"]))
            elif kind == "StatusContext" and node.get("state") in {"FAILURE", "ERROR"}:
                failed.append(str(node["context"]))
        return failed

    def get_merge_group_failed_jobs(
        self, owner: str, repo: str, base: str, number: int
    ) -> list[str]:
        """マージキューの検証ラン（merge_group）で失敗したジョブ名を返す

        PR の最新の merge_group ラン（head_branch が gh-readonly-queue/{base}/pr-{number}- で
        始まるもの）を選ぶ。該当ランが無ければ空リスト。
        """
        response = self._rest_request(
            "get",
            f"/repos/{owner}/{repo}/actions/runs",
            params={"event": "merge_group", "per_page": 20},
        )
        if not response.is_success:
            self._handle_http_error(response)
        prefix = f"gh-readonly-queue/{base}/pr-{number}-"
        runs = [
            r
            for r in _as_dict_list(_as_dict(response.json()).get("workflow_runs"))
            if str(r.get("head_branch") or "").startswith(prefix)
        ]
        if not runs:
            return []
        latest = max(runs, key=lambda r: str(r.get("created_at") or ""))

        response = self._rest_request(
            "get",
            f"/repos/{owner}/{repo}/actions/runs/{latest['id']}/jobs",
            params={"per_page": 100},
        )
        if not response.is_success:
            self._handle_http_error(response)
        failed_conclusions = {"failure", "timed_out", "cancelled"}
        return [
            str(j["name"])
            for j in _as_dict_list(_as_dict(response.json()).get("jobs"))
            if j.get("conclusion") in failed_conclusions
        ]


def _as_dict(value: object) -> dict[str, Any]:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else {}


def _as_dict_list(value: object) -> list[dict[str, Any]]:
    items = cast("list[Any]", value) if isinstance(value, list) else []
    return [cast("dict[str, Any]", v) for v in items if isinstance(v, dict)]
