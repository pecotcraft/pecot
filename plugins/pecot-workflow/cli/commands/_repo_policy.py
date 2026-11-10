"""cli/_repo_policy.py - decorator for the ``--repo`` mismatch policy

Commands such as ``pecot worktree`` / ``pecot create-branch`` / ``pecot delete-branch`` are "operations that destroy local Git state".
Commands such as ``pecot release`` are "mostly operations against the GitHub API".
The two need different handling when ``--repo`` and the current Git remote disagree.

This decorator declares both patterns in one way.
``mode="reject"`` exits with ``typer.Exit(1)`` on a mismatch. ``mode="warn"`` prints a
warning to stderr, adopts the ``--repo`` value, and continues.

Decision tree:

1. ``ctx.obj["repo"]`` (the global ``--repo``) is None.
   - If the current Git remote resolves, hand control to the body (existing behavior).
   - If it cannot be resolved outside Git, ``typer.Exit(1)`` with an "ambiguous repository" message on stderr.
     Such commands need ``--repo`` or a Git context, at least one of them.
2. ``ctx.obj["repo"]`` is given.
   - The current Git remote cannot be obtained (outside Git / no remote): adopt the explicit value and continue.
     (Nothing to compare against, so it is not a mismatch.)
   - Git remote obtained and matches the explicit value: do nothing and continue.
   - Git remote obtained, mismatch, mode="reject": ``typer.Exit(1)``.
   - Git remote obtained, mismatch, mode="warn": warn on stderr and continue.

The error and warning messages must match the fixed text in ``contracts/cli-commands.md`` §76-79 / §94-96 exactly.
(Later e2e tests check stderr.)
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, TypeVar, cast

import typer

if TYPE_CHECKING:
    from cli.core.repo_resolver import RepoRef, ResolvedRepo

F = TypeVar("F", bound=Callable[..., object])

Mode = Literal["reject", "warn"]


def _extract_explicit_repo(ctx: typer.Context | None) -> str | None:
    """Safely read the global ``--repo`` value from ctx.obj.

    The parent callback stores the global ``--repo`` value in ``ctx.obj["repo"]``
    (cli/main.py:89-90). Return None when ``ctx.obj`` is not a ``dict``
    or ``ctx`` itself is None.
    """
    if ctx is None or ctx.obj is None:
        return None
    obj: Any = ctx.obj
    if not isinstance(obj, dict):
        return None
    value = cast("dict[str, Any]", obj).get("repo")
    return value if isinstance(value, str) else None


def _detect_current_via_resolver(cwd: Path) -> ResolvedRepo | None:
    """Resolve the repository from the current Git remote (None when not found)."""
    from cli.core.repo_resolver import AmbiguousRepoError, resolve_repo

    try:
        return resolve_repo(None, cwd=cwd)
    except AmbiguousRepoError:
        return None


def _store_resolved_repo(ctx: typer.Context | None, ref: RepoRef) -> None:
    """Store in ctx the ``RepoRef`` the decorator adopted on the explicit ``--repo`` path.

    So that the body (release.py etc.) does not resolve twice, put the value
    the decorator adopted in ``ctx.obj["_policy_resolved_repo"]``.
    The body reads it through ``read_resolved_repo``.
    The key name and the duck-typing contract stay inside this module.
    Skip the write when ``ctx.obj`` is not a dict (the body falls back to None).
    """
    obj: Any = ctx.obj if ctx is not None else None
    if ctx is None or not isinstance(obj, dict):
        return
    cast("dict[str, Any]", obj)["_policy_resolved_repo"] = ref


def read_resolved_repo(ctx: typer.Context | None) -> tuple[str, str] | None:
    """Read the (owner, repo) the decorator adopted, from the body side.

    Pair of ``_store_resolved_repo``. The key name and duck-typing rule stay in
    ``_repo_policy.py``. Returns ``None`` when the decorator was not used
    (direct call) or no explicit ``--repo`` was given, so nothing was populated.
    """
    obj: Any = ctx.obj if ctx is not None else None
    if ctx is None or not isinstance(obj, dict):
        return None
    ref = cast("dict[str, Any]", obj).get("_policy_resolved_repo")
    owner = getattr(ref, "owner", None)
    repo = getattr(ref, "repo", None)
    if isinstance(owner, str) and isinstance(repo, str):
        return owner, repo
    return None


def require_repo_match(mode: Mode) -> Callable[[F], F]:
    """Policy for a mismatch between ``--repo`` and the current Git remote.

    Args:
        mode: ``"reject"`` exits with 1; ``"warn"`` warns on stderr and continues.

    Returns:
        A decorator that wraps a Typer command function. The target function
        must take ``ctx: typer.Context`` as its first argument.
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args: object, **kwargs: object) -> object:
            from cli.core.repo_resolver import RepoRef, ResolveSource

            ctx = _find_typer_context(args, kwargs)
            if ctx is None:
                # Typer 経由ではなく直接 Python 関数呼び出しされたケース
                # (既存のユニットテスト互換性のため、ポリシー適用をスキップ)。
                return func(*args, **kwargs)

            explicit = _extract_explicit_repo(ctx)
            resolved = _detect_current_via_resolver(Path.cwd())

            if explicit is None:
                if resolved is None:
                    # --repo 無し + Git 外 → 曖昧。呼び出し側に任せず、
                    # 統一メッセージで exit 1 (cli-commands.md §42-46 の
                    # 「リポジトリが曖昧です」メッセージを再利用)。
                    typer.echo(
                        "error: リポジトリが曖昧です。--repo <owner/repo> を明示してください。",
                        err=True,
                    )
                    raise typer.Exit(1)
                # Git 内で解決できたので従来挙動へ
                return func(*args, **kwargs)

            # 明示値あり
            try:
                explicit_ref = RepoRef.parse(explicit)
            except ValueError as e:
                # options.py の validator で弾かれる想定だが念のため
                typer.echo(
                    f"error: --repo の形式が不正です: {repr(explicit)}",
                    err=True,
                )
                raise typer.Exit(1) from e

            if resolved is None or resolved.source is not ResolveSource.CURRENT_GIT:
                # Git 外 / remote 不在 → 比較対象が無いので明示値を採用
                _store_resolved_repo(ctx, explicit_ref)
                return func(*args, **kwargs)

            current_ref = resolved.repo
            if current_ref == explicit_ref:
                _store_resolved_repo(ctx, explicit_ref)
                return func(*args, **kwargs)

            # 不一致
            if mode == "reject":
                typer.echo(
                    f"error: --repo {explicit_ref.full_name} とカレント Git remote "
                    f"({current_ref.full_name}) が不一致です。",
                    err=True,
                )
                typer.echo(
                    "       worktree / branch はローカル Git 破壊防止のため拒否します。",
                    err=True,
                )
                raise typer.Exit(1)

            # mode == "warn"
            typer.echo(
                f"warning: --repo {explicit_ref.full_name} を採用します "
                f"(カレント Git remote: {current_ref.full_name})。",
                err=True,
            )
            _store_resolved_repo(ctx, explicit_ref)
            return func(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


def _is_context(obj: object) -> bool:
    """Tell whether the object is a click/typer Context.

    Try isinstance first as a fast path and fall back to duck-typing only when it misses.

    typer 0.26.0+ keeps click as a vendored module (typer._click), so its types
    are separate from the external click.
    isinstance(x, typer.Context) is False for a Context created via the runner (typer._click.core.Context directly).
    So duck-typing fills the gap without touching a private API.
    The check uses a combination of attributes (obj / info_name / params).
    Ordinary Typer argument types (str / int / Path / Pydantic models, etc.) never have all three.
    """
    return isinstance(obj, typer.Context) or (
        hasattr(obj, "obj") and hasattr(obj, "info_name") and hasattr(obj, "params")
    )


def _find_typer_context(
    args: tuple[object, ...], kwargs: dict[str, object]
) -> typer.Context | None:
    """Find the click/typer Context among the call arguments.

    With Typer 0.26.0+ and its vendored click, isinstance(x, typer.Context) can be
    False via the runner, so use duck-typing (_is_context).
    """
    for name in ("ctx", "context"):
        candidate = kwargs.get(name)
        if _is_context(candidate):
            return cast(typer.Context, candidate)
    for arg in args:
        if _is_context(arg):
            return cast(typer.Context, arg)
    return None


__all__ = ["read_resolved_repo", "require_repo_match"]
