"""tests/cli/test_repo_policy.py - ``@require_repo_match`` decorator の契約テスト。

Issue #58 Item 1 の契約は次のとおり。
decorator が explicit ``--repo`` パスで採用した ``RepoRef`` を、
``ctx.obj["_policy_resolved_repo"]`` に格納する。
body 側 (release.py / changelog.py) は duck-typing (``.owner`` / ``.repo``) で読む。

ここでは decorator を直接関数に装着し、``click.Context`` を手動で作って呼び出す。
これで 3 つの explicit パス (Git 外 / 一致 / warn 警告後) と explicit 未指定パスを網羅する。

``TestFindTyperContextViaCLIRunner`` は、``_find_typer_context`` の duck-typing を直接検証する。
呼び出しは ``typer.testing.CliRunner`` 経由で行う。
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
import typer
from typer.core import TyperCommand
from typer.testing import CliRunner

from cli.commands._repo_policy import require_repo_match
from cli.core.repo_resolver import RepoRef, ResolvedRepo, ResolveSource

KEY = "_policy_resolved_repo"


def _make_ctx(repo: str | None) -> typer.Context:
    """``ctx.obj["repo"]`` を持つ最小の typer.Context を構築する。"""
    _noop = TyperCommand(name="_noop", callback=lambda: None)
    ctx = typer.Context(_noop)
    ctx.obj = {"repo": repo}
    return ctx


def _resolved(owner: str, repo: str) -> ResolvedRepo:
    return ResolvedRepo(
        repo=RepoRef(owner=owner, repo=repo),
        source=ResolveSource.CURRENT_GIT,
        remote_name="origin",
    )


class TestPolicyResolvedRepoPopulation:
    """explicit ``--repo`` 指定時の動きを検証する。

    decorator が 3 パスそれぞれで、``ctx.obj["_policy_resolved_repo"]`` に ``RepoRef`` を populate する。
    """

    def test_warn_explicit_no_current_git_populates(self) -> None:
        """Git 外 / remote 不在パスでも populate される。"""
        captured: dict[str, Any] = {}

        @require_repo_match(mode="warn")
        def target(ctx: typer.Context) -> None:
            captured["obj"] = dict(ctx.obj) if isinstance(ctx.obj, dict) else None

        ctx = _make_ctx("acme-labs/aist-plugin")
        with patch(
            "cli.commands._repo_policy._detect_current_via_resolver",
            return_value=None,
        ):
            target(ctx=ctx)

        ref = ctx.obj[KEY]
        assert isinstance(ref, RepoRef)
        assert ref.owner == "acme-labs"
        assert ref.repo == "aist-plugin"
        # body 実行時点で既に populate されていること (order invariant)
        assert captured["obj"][KEY] is ref

    def test_warn_explicit_matches_populates(self) -> None:
        """一致パスでも populate される (pass-through)。"""

        @require_repo_match(mode="warn")
        def target(ctx: typer.Context) -> None:
            pass

        ctx = _make_ctx("acme-labs/pecot-cli")
        with patch(
            "cli.commands._repo_policy._detect_current_via_resolver",
            return_value=_resolved("acme-labs", "pecot-cli"),
        ):
            target(ctx=ctx)

        ref = ctx.obj[KEY]
        assert isinstance(ref, RepoRef)
        assert (ref.owner, ref.repo) == ("acme-labs", "pecot-cli")

    def test_warn_explicit_mismatch_populates_after_warning(self) -> None:
        """mismatch warn パスでも populate される (警告後 pass-through)。"""

        @require_repo_match(mode="warn")
        def target(ctx: typer.Context) -> None:
            pass

        ctx = _make_ctx("acme-labs/aist-plugin")
        with patch(
            "cli.commands._repo_policy._detect_current_via_resolver",
            return_value=_resolved("acme-labs", "pecot-cli"),
        ):
            target(ctx=ctx)

        ref = ctx.obj[KEY]
        assert isinstance(ref, RepoRef)
        assert (ref.owner, ref.repo) == ("acme-labs", "aist-plugin")

    def test_reject_explicit_matches_populates(self) -> None:
        """mode=reject でも explicit 一致パスで populate される。"""

        @require_repo_match(mode="reject")
        def target(ctx: typer.Context) -> None:
            pass

        ctx = _make_ctx("acme-labs/pecot-cli")
        with patch(
            "cli.commands._repo_policy._detect_current_via_resolver",
            return_value=_resolved("acme-labs", "pecot-cli"),
        ):
            target(ctx=ctx)

        ref = ctx.obj[KEY]
        assert isinstance(ref, RepoRef)
        assert (ref.owner, ref.repo) == ("acme-labs", "pecot-cli")

    def test_reject_explicit_mismatch_does_not_populate(self) -> None:
        """mode=reject の mismatch は exit 1 で populate せず pass-through しない。"""

        @require_repo_match(mode="reject")
        def target(ctx: typer.Context) -> None:  # pragma: no cover
            raise AssertionError("body が呼ばれてはならない")

        ctx = _make_ctx("acme-labs/aist-plugin")
        with patch(
            "cli.commands._repo_policy._detect_current_via_resolver",
            return_value=_resolved("acme-labs", "pecot-cli"),
        ):
            with pytest.raises(typer.Exit):
                target(ctx=ctx)

        assert KEY not in ctx.obj


class TestPolicyResolvedRepoNotPopulated:
    """explicit ``--repo`` 未指定パスでは populate されない。"""

    def test_no_explicit_with_current_git_skips_population(self) -> None:
        """--repo 未指定 + Git 内解決の従来パス — populate しない (最小差分方針)。"""

        @require_repo_match(mode="warn")
        def target(ctx: typer.Context) -> None:
            pass

        ctx = _make_ctx(None)
        with patch(
            "cli.commands._repo_policy._detect_current_via_resolver",
            return_value=_resolved("acme-labs", "pecot-cli"),
        ):
            target(ctx=ctx)

        assert KEY not in ctx.obj


class TestFindTyperContextViaCLIRunner:
    """``typer.testing.CliRunner`` 経由で ``_find_typer_context`` の
    duck-typing 分岐が Context を正しく検出できることを検証する。

    CliRunner が渡す Context は typer._click.core.Context の直接インスタンスになる。
    そのため ``isinstance(ctx, typer.Context)`` が False になる場合がある。
    ``_is_context`` の duck-typing フォールバックが機能していることを確認する。
    """

    def test_runner_invoke_detects_context_via_duck_typing(self) -> None:
        """CliRunner.invoke 経由で @require_repo_match が Context を検出する。

        ``_policy_resolved_repo`` を ctx.obj に格納できることを検証する。
        """
        captured: dict[str, Any] = {}

        app = typer.Typer()

        @app.command()
        @require_repo_match(mode="warn")
        def cmd(ctx: typer.Context, repo: str = typer.Option("")) -> None:
            if isinstance(ctx.obj, dict):
                captured["obj"] = dict(ctx.obj)

        runner = CliRunner()
        with patch(
            "cli.commands._repo_policy._detect_current_via_resolver",
            return_value=None,
        ):
            result = runner.invoke(
                app,
                ["--repo", "acme-labs/aist-plugin"],
                obj={"repo": "acme-labs/aist-plugin"},
            )

        assert result.exit_code == 0, result.output
        ref = captured.get("obj", {}).get(KEY)
        assert isinstance(ref, RepoRef), f"RepoRef が格納されていない: {captured}"
        assert ref.owner == "acme-labs"
        assert ref.repo == "aist-plugin"
