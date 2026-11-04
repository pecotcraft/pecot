"""cli/_repo_policy.py - ``--repo`` 不一致方針 decorator (FR-009a / FR-009b)。

``pecot worktree`` / ``pecot create-branch`` / ``pecot delete-branch`` などは「ローカル Git を破壊する操作系」に当たる。
``pecot release`` などは「GitHub API 側への操作中心」に当たる。
両者では、``--repo`` とカレント Git remote が食い違ったときの扱いを分ける必要がある (research.md Decision 6)。

この decorator は両パターンを統一的に宣言できるようにするためのもの。
``mode="reject"`` は不一致で ``typer.Exit(1)``、``mode="warn"`` は stderr 警告を
出して ``--repo`` 値を採用して処理を続行する。

決定木 (FR-009a / FR-009b):

1. ``ctx.obj["repo"]`` (グローバル ``--repo``) が None の場合。
   - カレント Git remote を解決できれば後続処理へ制御移譲 (従来挙動)
   - Git 外で解決できなければ ``typer.Exit(1)`` + "リポジトリが曖昧です" stderr
     → 操作系コマンドは ``--repo`` か Git コンテキストの少なくとも一方が必須。
2. ``ctx.obj["repo"]`` が指定ありの場合。
   - カレント Git remote が取得できない (Git 外 / remote 無し) → 明示値をそのまま採用して後続処理へ。
     (比較対象が無い = 不一致と見なさない)
   - Git remote 取得成功 && 明示値と一致 → 何もせず後続処理へ
   - Git remote 取得成功 && 不一致 && mode="reject" → ``typer.Exit(1)``
   - Git remote 取得成功 && 不一致 && mode="warn"   → stderr に警告出力 + 後続処理へ

エラー／警告メッセージは ``contracts/cli-commands.md`` §76-79 / §94-96 の固定文言と厳密に一致させる。
(後続の e2e テストで stderr を確認するため)
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
    """グローバル ``--repo`` 値を ctx.obj から安全に取り出す。

    Typer は親 callback で ``ctx.obj["repo"]`` にグローバル ``--repo`` 値を
    格納している (cli/main.py:89-90)。callback 側で ``ctx.obj`` が
    ``dict`` でない場合や、``ctx`` 自身が None の場合は None を返す。
    """
    if ctx is None or ctx.obj is None:
        return None
    obj: Any = ctx.obj
    if not isinstance(obj, dict):
        return None
    value = cast("dict[str, Any]", obj).get("repo")
    return value if isinstance(value, str) else None


def _detect_current_via_resolver(cwd: Path) -> ResolvedRepo | None:
    """カレント Git remote からのリポ解決 (未検出時は None)。"""
    from cli.core.repo_resolver import AmbiguousRepoError, resolve_repo

    try:
        return resolve_repo(None, cwd=cwd)
    except AmbiguousRepoError:
        return None


def _store_resolved_repo(ctx: typer.Context | None, ref: RepoRef) -> None:
    """decorator が explicit ``--repo`` パスで採用した ``RepoRef`` を ctx に格納。

    body 側 (release.py など) が二重解決せずに済むよう、
    decorator 採用値を ``ctx.obj["_policy_resolved_repo"]`` に載せる。
    body は ``read_resolved_repo`` 経由で読み出す。
    このキー名と duck-typing 契約は本モジュール内に閉じ込める。
    ``ctx.obj`` が dict でなければ書き込みをスキップする (body 側で None fallback)。
    """
    obj: Any = ctx.obj if ctx is not None else None
    if ctx is None or not isinstance(obj, dict):
        return
    cast("dict[str, Any]", obj)["_policy_resolved_repo"] = ref


def read_resolved_repo(ctx: typer.Context | None) -> tuple[str, str] | None:
    """body 側から decorator 採用済みの (owner, repo) を読み出す。

    ``_store_resolved_repo`` の対。キー名と duck-typing 規約は
    ``_repo_policy.py`` に閉じ込める。decorator 未経由 (直接呼び出し) や
    explicit ``--repo`` 未指定で populate されなかったケースは ``None``。
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
    """FR-009a / FR-009b: ``--repo`` とカレント Git remote の不一致時ポリシー。

    Args:
        mode: ``"reject"`` で exit 1、``"warn"`` で stderr 警告 + 続行。

    Returns:
        Typer コマンド関数を包むデコレータ。対象関数は第 1 引数として
        ``ctx: typer.Context`` を受け取る形に揃えておくこと。
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
    """click/typer Context かどうかを判定する。

    isinstance を fast-path として先に試し、外れた場合のみ duck-typing にフォールバックする。

    typer 0.26.0+ は click を vendored モジュール (typer._click) に格納しており、
    外部 click とは型が分離する。
    isinstance(x, typer.Context) は、runner 経由の Context（typer._click.core.Context 直接）で False になる。
    そのため private API を参照せず duck-typing で補完する。
    判定には属性の組み合わせ（obj / info_name / params）を使う。
    Typer コマンドの通常引数型（str / int / Path / Pydantic モデル等）には、この 3 つが同時に存在しない。
    """
    return isinstance(obj, typer.Context) or (
        hasattr(obj, "obj") and hasattr(obj, "info_name") and hasattr(obj, "params")
    )


def _find_typer_context(
    args: tuple[object, ...], kwargs: dict[str, object]
) -> typer.Context | None:
    """関数呼び出し引数の中から click/typer Context を見つけ出す。

    Typer 0.26.0+ では vendored click のため isinstance(x, typer.Context) が
    runner 経由で False になる場合がある。duck-typing (_is_context) で判定する。
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
