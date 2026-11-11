"""GitHub API 操作の例外クラス。"""

from __future__ import annotations

import json
from typing import Any, cast

from cli.core.errors import PecotError


class GitHubAPIError(PecotError):
    """GitHub API操作エラーの基底クラス

    Attributes:
        message: エラーメッセージ
        status_code: HTTPステータスコード（該当する場合）
        response_body: レスポンスボディ（該当する場合）
    """

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        response_body: str | None = None,
    ) -> None:
        self.message = message
        self.status_code = status_code
        self.response_body = response_body
        super().__init__(self.message)


class GitHubAuthError(GitHubAPIError):
    """認証エラー（401 Unauthorized）

    トークンが無効または期限切れの場合に発生する。
    """

    pass


class GitHubNotFoundError(GitHubAPIError):
    """リソースが見つからない（404 Not Found）

    指定されたリポジトリ、Issue、プロジェクト等が存在しない場合に発生する。
    """

    pass


class GitHubRateLimitError(GitHubAPIError):
    """レート制限エラー（403 Forbidden - rate limit exceeded）

    APIレート制限を超えると発生する。
    """

    pass


def describe_api_error(error: GitHubAPIError) -> str:
    """GitHubAPIError の message に、応答本文 JSON の message と errors[].message を添える

    本文が JSON でない（HTML 等）・どちらも無いときは添えない。
    422 では理由が errors[].message にだけ入ることがある（例: "Validation Failed" の詳細）。
    """
    try:
        body = json.loads(error.response_body or "")
    except ValueError:
        return error.message
    if not isinstance(body, dict):
        return error.message
    data = cast("dict[str, Any]", body)
    details: list[str] = []
    top = data.get("message")
    if isinstance(top, str) and top.strip():
        details.append(top.strip())
    errors = data.get("errors")
    if isinstance(errors, list):
        for item in cast("list[Any]", errors):
            if isinstance(item, dict):
                msg = cast("dict[str, Any]", item).get("message")
                if isinstance(msg, str) and msg.strip():
                    details.append(msg.strip())
    if not details:
        return error.message
    return f"{error.message} {' '.join(details)}"


def is_missing_ref_error(e: GitHubAPIError) -> bool:
    """Whether this error means the branch (ref) no longer exists"""
    if e.status_code not in (404, 422):
        return False
    return e.response_body is not None and "Reference does not exist" in e.response_body
