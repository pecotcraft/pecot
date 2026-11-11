"""tests/core/test_repo_resolver.py - repo_resolver.py の単体テスト

Phase 2 Foundational (T012) — RepoRef / ResolvedRepo の型・バリデータテスト。
Phase 3 US1 (T020-T022) — ``_detect_current_git_repo`` / ``resolve_repo`` のテスト。
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError
from ub_test_reports.pytest_plugin import add_test_properties

from cli.core.repo_resolver import (
    AmbiguousRepoError,
    RepoRef,
    ResolvedRepo,
    ResolveSource,
    _detect_current_git_repo,
    resolve_repo,
)


def _fake_git_factory(
    *,
    inside_worktree: bool = True,
    remotes: list[str] | None = None,
    remote_urls: dict[str, str] | None = None,
):
    """``run_git`` の side_effect 用フェイク。``args[0]`` で分岐する。

    - ``rev-parse --is-inside-work-tree`` → ``inside_worktree`` に応じて true/false
    - ``remote`` → ``remotes`` 行を改行区切りで返す
    - ``remote get-url <name>`` → ``remote_urls[name]`` を返す
    """

    remotes = remotes or []
    remote_urls = remote_urls or {}

    def _fake(args: list[str], cwd: Path, **kwargs: object) -> MagicMock:
        cp = MagicMock()
        if args[0] == "rev-parse":
            cp.returncode = 0 if inside_worktree else 128
            cp.stdout = "true\n" if inside_worktree else ""
            cp.stderr = "" if inside_worktree else "fatal: not a git repository"
            return cp
        if args[0] == "remote" and len(args) == 1:
            cp.returncode = 0
            cp.stdout = "\n".join(remotes) + ("\n" if remotes else "")
            cp.stderr = ""
            return cp
        if args[0] == "remote" and len(args) >= 3 and args[1] == "get-url":
            name = args[2]
            url = remote_urls.get(name, "")
            cp.returncode = 0 if url else 128
            cp.stdout = url + "\n" if url else ""
            cp.stderr = "" if url else "fatal: No such remote"
            return cp
        raise AssertionError(f"unexpected git args: {args}")

    return _fake


class TestRepoRefParseSuccess:
    @pytest.mark.parametrize(
        "raw,owner,repo",
        [
            ("owner/repo", "owner", "repo"),
            ("owner.io/my-repo", "owner.io", "my-repo"),
            ("my_org/my_repo", "my_org", "my_repo"),
            ("a.b.c/x.y.z", "a.b.c", "x.y.z"),
            ("my-org/my-repo", "my-org", "my-repo"),
            ("A/B", "A", "B"),
        ],
    )
    def test_parse_valid(self, raw: str, owner: str, repo: str) -> None:
        ref = RepoRef.parse(raw)
        assert ref.owner == owner
        assert ref.repo == repo


class TestRepoRefParseFailure:
    @pytest.mark.parametrize(
        "raw",
        [
            "",
            "ownerrepo",
            "owner/repo/extra",
            "owner/",
            "/repo",
            "owner//repo",
            "owner/repo/",
            " owner/repo",
            "owner/repo ",
            "owner /repo",
            "owner@bad/repo",
            "owner/repo name",
            "オーナー/リポ",
            "owner/repo#123",
        ],
    )
    def test_parse_invalid(self, raw: str) -> None:
        with pytest.raises((ValueError, ValidationError)):
            RepoRef.parse(raw)


class TestRepoRefFieldValidation:
    def test_direct_construction_invalid_owner(self) -> None:
        with pytest.raises(ValidationError):
            RepoRef(owner="bad owner", repo="repo")

    def test_direct_construction_invalid_repo(self) -> None:
        with pytest.raises(ValidationError):
            RepoRef(owner="owner", repo="bad@repo")

    def test_direct_construction_empty(self) -> None:
        with pytest.raises(ValidationError):
            RepoRef(owner="", repo="repo")


class TestRepoRefFullName:
    def test_full_name(self) -> None:
        ref = RepoRef(owner="owner", repo="repo")
        assert ref.full_name == "owner/repo"

    def test_full_name_with_dots(self) -> None:
        ref = RepoRef.parse("a.io/b.c")
        assert ref.full_name == "a.io/b.c"


class TestResolvedRepoValid:
    def test_explicit_without_remote_name(self) -> None:
        rr = ResolvedRepo(
            repo=RepoRef(owner="o", repo="r"),
            source=ResolveSource.EXPLICIT,
        )
        assert rr.source is ResolveSource.EXPLICIT
        assert rr.remote_name is None

    def test_current_git_with_remote_name(self) -> None:
        rr = ResolvedRepo(
            repo=RepoRef(owner="o", repo="r"),
            source=ResolveSource.CURRENT_GIT,
            remote_name="origin",
        )
        assert rr.remote_name == "origin"


class TestResolvedRepoCrossFieldValidator:
    def test_current_git_without_remote_name_raises(self) -> None:
        with pytest.raises(ValidationError):
            ResolvedRepo(
                repo=RepoRef(owner="o", repo="r"),
                source=ResolveSource.CURRENT_GIT,
                remote_name=None,
            )

    def test_current_git_empty_remote_name_raises(self) -> None:
        with pytest.raises(ValidationError):
            ResolvedRepo(
                repo=RepoRef(owner="o", repo="r"),
                source=ResolveSource.CURRENT_GIT,
                remote_name="",
            )

    def test_explicit_with_remote_name_raises(self) -> None:
        with pytest.raises(ValidationError):
            ResolvedRepo(
                repo=RepoRef(owner="o", repo="r"),
                source=ResolveSource.EXPLICIT,
                remote_name="origin",
            )


class TestAmbiguousRepoError:
    def test_is_exception(self) -> None:
        assert issubclass(AmbiguousRepoError, Exception)
        with pytest.raises(AmbiguousRepoError):
            raise AmbiguousRepoError("ambiguous")


class TestDetectCurrentGitRepo:
    """``_detect_current_git_repo`` のテスト (Phase 3 US1 / T020)。"""

    def test_not_inside_git_returns_none(self) -> None:
        fake = _fake_git_factory(inside_worktree=False)
        with patch("cli.core.repo_resolver.run_git", side_effect=fake):
            assert _detect_current_git_repo(Path("/tmp")) is None

    def test_origin_only(self) -> None:
        fake = _fake_git_factory(
            remotes=["origin"],
            remote_urls={"origin": "git@github.com:owner/repoA.git"},
        )
        with patch("cli.core.repo_resolver.run_git", side_effect=fake):
            result = _detect_current_git_repo(Path("/tmp"))
        assert result is not None
        ref, remote = result
        assert ref == RepoRef(owner="owner", repo="repoA")
        assert remote == "origin"

    def test_origin_preferred_over_upstream(self) -> None:
        fake = _fake_git_factory(
            remotes=["origin", "upstream"],
            remote_urls={
                "origin": "git@github.com:o/origin-repo.git",
                "upstream": "git@github.com:o/upstream-repo.git",
            },
        )
        with patch("cli.core.repo_resolver.run_git", side_effect=fake):
            result = _detect_current_git_repo(Path("/tmp"))
        assert result is not None
        ref, remote = result
        assert remote == "origin"
        assert ref.repo == "origin-repo"

    @add_test_properties(verifies=["PW-COMMON-08"])
    def test_upstream_only_fallback(self) -> None:
        fake = _fake_git_factory(
            remotes=["upstream"],
            remote_urls={"upstream": "https://github.com/o/up.git"},
        )
        with patch("cli.core.repo_resolver.run_git", side_effect=fake):
            result = _detect_current_git_repo(Path("/tmp"))
        assert result is not None
        ref, remote = result
        assert remote == "upstream"
        assert ref == RepoRef(owner="o", repo="up")

    def test_no_remotes_returns_none(self) -> None:
        fake = _fake_git_factory(remotes=[])
        with patch("cli.core.repo_resolver.run_git", side_effect=fake):
            assert _detect_current_git_repo(Path("/tmp")) is None

    def test_unparseable_url_propagates_valueerror(self) -> None:
        fake = _fake_git_factory(
            remotes=["origin"],
            remote_urls={"origin": "foo.bar"},
        )
        with patch("cli.core.repo_resolver.run_git", side_effect=fake):
            with pytest.raises(ValueError):
                _detect_current_git_repo(Path("/tmp"))


class TestResolveRepo:
    """``resolve_repo`` のテスト (Phase 3 US1 / T021)。"""

    def test_explicit_wins_without_git_call(self) -> None:
        with patch("cli.core.repo_resolver.run_git") as mock_git:
            result = resolve_repo("a/b", cwd=Path("/tmp"))
        mock_git.assert_not_called()
        assert result.repo == RepoRef(owner="a", repo="b")
        assert result.source is ResolveSource.EXPLICIT
        assert result.remote_name is None

    def test_current_git_origin(self) -> None:
        fake = _fake_git_factory(
            remotes=["origin"],
            remote_urls={"origin": "git@github.com:o/r.git"},
        )
        with patch("cli.core.repo_resolver.run_git", side_effect=fake):
            result = resolve_repo(None, cwd=Path("/tmp"))
        assert result.source is ResolveSource.CURRENT_GIT
        assert result.remote_name == "origin"
        assert result.repo == RepoRef(owner="o", repo="r")

    def test_ambiguous_when_outside_git(self) -> None:
        fake = _fake_git_factory(inside_worktree=False)
        with patch("cli.core.repo_resolver.run_git", side_effect=fake):
            with pytest.raises(AmbiguousRepoError):
                resolve_repo(None, cwd=Path("/tmp"))

    def test_invalid_explicit_raises_valueerror(self) -> None:
        with pytest.raises(ValueError):
            resolve_repo("invalid", cwd=Path("/tmp"))
