"""GitHub API クライアント（REST + GraphQL、github.com と GHES に対応）。"""

from __future__ import annotations

from cli.core.github.errors import (
    GitHubAPIError,
    GitHubAuthError,
    GitHubNotFoundError,
    GitHubRateLimitError,
)
from cli.core.github.issues import IssuesAPI
from cli.core.github.projects import ProjectsAPI
from cli.core.github.pulls import PullsAPI
from cli.core.github.repos import ReposAPI

__all__ = [
    "GitHubAPIError",
    "GitHubAuthError",
    "GitHubClient",
    "GitHubNotFoundError",
    "GitHubRateLimitError",
]


class GitHubClient(IssuesAPI, ProjectsAPI, PullsAPI, ReposAPI):
    """GitHub API クライアント。操作は責務別の API クラスから合成する。

    Example:
        >>> client = GitHubClient(host="ghes.example.com")

        >>> issue = client.get_issue_slim("owner", "repo", 123)
    """
