"""GitHub API 操作の例外クラス。"""

from __future__ import annotations

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
