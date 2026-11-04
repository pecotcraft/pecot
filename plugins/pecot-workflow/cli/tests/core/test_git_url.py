"""tests/core/test_git_url.py - core/git_url.py のユニットテスト"""

from __future__ import annotations

import pytest

from cli.core.git_url import parse_remote_url


class TestParseRemoteUrl:
    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("https://github.com/owner/repo.git", ("github.com", "owner", "repo")),
            ("https://github.com/owner/repo", ("github.com", "owner", "repo")),
            ("http://ghe.example/owner/repo.git", ("ghe.example", "owner", "repo")),
            ("git@ghes.example.com:owner/repo.git", ("ghes.example.com", "owner", "repo")),
            ("git@github.com:owner/repo", ("github.com", "owner", "repo")),
            ("https://github.com/o/foo.github.io.git", ("github.com", "o", "foo.github.io")),
            ("git@github.com:o/foo.github.io", ("github.com", "o", "foo.github.io")),
            ("  https://github.com/owner/repo.git\n", ("github.com", "owner", "repo")),
            (
                "ssh://git@ghes.example.com/acme-labs/aist-plugin.git",
                ("ghes.example.com", "acme-labs", "aist-plugin"),
            ),
            ("ssh://git@github.com:22/owner/repo.git", ("github.com", "owner", "repo")),
            ("ssh://github.com/owner/repo", ("github.com", "owner", "repo")),
            ("ssh://git@github.com/owner/repo.git/", ("github.com", "owner", "repo")),
            ("ssh://git@github.com/owner/repo/", ("github.com", "owner", "repo")),
            ("ssh://git@github.com/o/foo.github.io.git", ("github.com", "o", "foo.github.io")),
        ],
    )
    def test_valid(self, url: str, expected: tuple[str, str, str]) -> None:
        assert parse_remote_url(url) == expected

    @pytest.mark.parametrize(
        "url",
        [
            "invalid-url",
            "/local/bare/repo",
            "https://github.com/owner",
            "",
            "ssh://git@github.com/owner",
            "ssh://git@github.com/a/b/c",
            "ssh://git@github.com:abc/owner/repo.git",
        ],
    )
    def test_invalid(self, url: str) -> None:
        with pytest.raises(ValueError, match="unexpected remote URL format"):
            parse_remote_url(url)
