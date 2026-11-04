"""tests/core/test_errors.py - core/errors.py と独自例外の階層のテスト"""

from __future__ import annotations

import pytest

from cli.core.changelog import ChangelogError, InvalidVersionError, VersionNotFoundError
from cli.core.config import ConfigError
from cli.core.errors import PecotError
from cli.core.frontmatter import FrontmatterError
from cli.core.github import (
    GitHubAPIError,
    GitHubAuthError,
    GitHubNotFoundError,
    GitHubRateLimitError,
)
from cli.core.paths import OutputPathReservationError, ProjectRootNotFoundError
from cli.core.ref_parser import RefParseError
from cli.core.release import ReleaseError
from cli.core.repo_resolver import AmbiguousRepoError
from cli.core.worktree_links import WorktreeConfigError


def test_pecot_error_is_exception() -> None:
    assert issubclass(PecotError, Exception)
    with pytest.raises(PecotError, match="boom"):
        raise PecotError("boom")


@pytest.mark.parametrize(
    "exc",
    [
        ProjectRootNotFoundError,
        OutputPathReservationError,
        ReleaseError,
        WorktreeConfigError,
        ConfigError,
        ChangelogError,
        InvalidVersionError,
        VersionNotFoundError,
        RefParseError,
        GitHubAPIError,
        GitHubAuthError,
        GitHubNotFoundError,
        GitHubRateLimitError,
        AmbiguousRepoError,
        FrontmatterError,
    ],
)
def test_all_custom_errors_derive_from_pecot_error(exc: type[Exception]) -> None:
    assert issubclass(exc, PecotError)


def test_internal_hierarchy_is_kept() -> None:
    assert issubclass(InvalidVersionError, ChangelogError)
    assert issubclass(VersionNotFoundError, ChangelogError)
    assert issubclass(GitHubAuthError, GitHubAPIError)
    assert issubclass(GitHubNotFoundError, GitHubAPIError)
    assert issubclass(GitHubRateLimitError, GitHubAPIError)
