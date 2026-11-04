"""cli/worktree.py - ワークツリー操作コマンド実装

ワークツリー関連のユーティリティ関数とCLIコマンドを提供。
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

from cli.commands._repo_policy import require_repo_match
from cli.commands.options import DirectoryOption

if TYPE_CHECKING:
    from cli.core.worktree import CopyResult, SetupResult
    from cli.core.worktree_links import SymlinkResult, WorktreeConfig

# CLIコマンド


def _echo_link_results(linked_files: list[SymlinkResult]) -> None:
    """シンボリックリンク作成結果の件数とエラー"""
    link_created = [r for r in linked_files if r.action == "created"]
    link_skipped = [r for r in linked_files if r.action == "skipped"]
    link_errors = [r for r in linked_files if r.action == "error"]
    typer.echo(f"  リンク: {len(link_created)}件")
    if link_skipped:
        typer.echo(f"  リンクスキップ: {len(link_skipped)}件")
    if link_errors:
        typer.echo(f"  リンクエラー: {len(link_errors)}件")
        for err in link_errors:
            typer.echo(f"    {err.symlink_path}: {err.message}", err=True)


def _echo_copy_results(copied_files: list[CopyResult]) -> None:
    """未追跡ファイルコピー結果の件数とエラー"""
    copied = [r for r in copied_files if r.action == "copied"]
    skipped = [r for r in copied_files if r.action == "skipped"]
    errors = [r for r in copied_files if r.action == "error"]
    typer.echo(f"  コピー: {len(copied)}件")
    if skipped:
        typer.echo(f"  スキップ: {len(skipped)}件")
    if errors:
        typer.echo(f"  エラー: {len(errors)}件")
        for copy_err in errors:
            typer.echo(f"    {copy_err.source}: {copy_err.message}", err=True)


def _echo_setup_result(sr: SetupResult) -> None:
    """セットアップコマンド実行結果"""
    if sr.returncode == 0:
        typer.echo(f"  セットアップ: ✓ (exit 0) {sr.command}")
    elif sr.returncode == -1:
        typer.echo(f"  セットアップ: ⏱ (timeout) {sr.command}", err=True)
    else:
        typer.echo(f"  セットアップ: ✗ (exit {sr.returncode}) {sr.command}", err=True)
    if sr.stdout.strip():
        for line in sr.stdout.rstrip("\n").split("\n"):
            typer.echo(f"    out: {line}")
    if sr.stderr.strip():
        for line in sr.stderr.rstrip("\n").split("\n"):
            typer.echo(f"    err: {line}", err=True)


@require_repo_match(mode="reject")
def worktree_add(
    ctx: typer.Context,
    directory: DirectoryOption = ...,  # type: ignore[assignment]
    base: Annotated[
        str | None,
        typer.Option(
            "--base",
            help="ベースブランチ（デフォルト: 現在のブランチ）",
        ),
    ] = None,
    path: Annotated[
        Path | None,
        typer.Option(
            "--path",
            help="WT作成先パス（デフォルト: <project_root>/<自動採番>/<リポ名>）",
            resolve_path=True,
        ),
    ] = None,
    no_copy: Annotated[
        bool,
        typer.Option(
            "--no-copy",
            help="未追跡ファイルコピーをスキップ",
        ),
    ] = False,
    no_link: Annotated[
        bool,
        typer.Option(
            "--no-link",
            help="シンボリックリンク作成をスキップ",
        ),
    ] = False,
    setup: Annotated[
        str | None,
        typer.Option(
            "--setup",
            help="作成後に実行するコマンド",
        ),
    ] = None,
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            help="実行せずプレビューのみ",
        ),
    ] = False,
    allow_existing_branch: Annotated[
        bool,
        typer.Option(
            "--allow-existing-branch",
            "--force",
            help="既存ブランチの upstream が develop_branch と違っても再利用を許可",
        ),
    ] = False,
) -> None:
    """新しいワークツリーを作成する"""
    from cli.core.worktree import create_worktree, ensure_devcontainer_environment

    ensure_devcontainer_environment()

    try:
        result = create_worktree(
            cwd=directory,
            base_branch=base,
            path=path,
            copy=not no_copy,
            link=not no_link,
            setup_command=setup,
            dry_run=dry_run,
            allow_existing_branch=allow_existing_branch,
        )
    except RuntimeError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None

    # 結果出力
    if dry_run:
        typer.echo("--- dry-run モード（実行されません）---")

    typer.echo(f"ワークツリー: {result.name}")
    typer.echo(f"  パス: {result.path}")
    typer.echo(f"  ブランチ: {result.branch}")
    typer.echo(f"  ベース: {result.base_branch}")

    if result.linked_files:
        _echo_link_results(result.linked_files)

    if result.copied_files:
        _echo_copy_results(result.copied_files)

    # セットアップコマンド実行結果
    if result.setup_result is not None:
        _echo_setup_result(result.setup_result)


@require_repo_match(mode="reject")
def worktree_remove(
    ctx: typer.Context,
    name: Annotated[
        str,
        typer.Argument(
            help="削除するWT名（ブランチ名）",
        ),
    ],
    directory: DirectoryOption = ...,  # type: ignore[assignment]
    force: Annotated[
        bool,
        typer.Option(
            "--force",
            help="変更があっても強制削除",
        ),
    ] = False,
    keep_branch: Annotated[
        bool,
        typer.Option(
            "--keep-branch",
            help="ブランチを残す",
        ),
    ] = False,
) -> None:
    """ワークツリーを削除する"""
    from cli.core.worktree import ensure_devcontainer_environment, remove_worktree

    ensure_devcontainer_environment()

    try:
        remove_worktree(
            cwd=directory,
            name=name,
            force=force,
            keep_branch=keep_branch,
        )
    except RuntimeError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None

    typer.echo(f"ワークツリー '{name}' を削除しました。")
    if not keep_branch:
        typer.echo(f"  ブランチ '{name}' も削除しました。")


@require_repo_match(mode="reject")
def worktree_init(
    ctx: typer.Context,
    directory: DirectoryOption = ...,  # type: ignore[assignment]
) -> None:
    """ワークツリー設定ファイルをメインWTに作成する

    デフォルトテンプレートを以下の 2 ファイルとして書き出す。
      - .pecot/config/worktree-config.json  (symlink / setup_command)
      - .pecot/config/.worktreeignore       (コピー除外パターン)
    """
    from cli.core.config import load_active_config
    from cli.core.paths import WORKTREE_CONFIG_FILENAME, WORKTREE_IGNORE_FILENAME
    from cli.core.worktree import ensure_devcontainer_environment, find_main_worktree
    from cli.core.worktree_links import (
        DEFAULT_WORKTREEIGNORE_CONTENT,
        get_default_config,
        save_config,
    )

    ensure_devcontainer_environment()

    try:
        main_wt = find_main_worktree(directory)
    except RuntimeError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None

    config_path = main_wt / WORKTREE_CONFIG_FILENAME
    ignore_path = main_wt / WORKTREE_IGNORE_FILENAME

    if config_path.exists() or ignore_path.exists():
        if config_path.exists():
            typer.echo(f"設定ファイルは既に存在します: {config_path}")
        if ignore_path.exists():
            typer.echo(f"設定ファイルは既に存在します: {ignore_path}")
        raise typer.Exit(1)

    # 共有 3 リンクの target_repo の決定: active project の aggregation_repo があればそのリポ名、
    # 無ければ自リポ名（モノレポは自リポに共有ファイルを置く）
    target_repo = main_wt.name
    try:
        project_config = load_active_config()
        aggregation_ref = project_config.aggregation_repo_ref if project_config else None
        if aggregation_ref is not None:
            target_repo = aggregation_ref.repo
    except Exception:
        pass

    # デフォルトテンプレートを書き出し
    config = get_default_config(target_repo=target_repo, self_repo=main_wt.name)
    save_config(config, config_path)
    typer.echo(f"設定ファイルを作成しました: {config_path}")

    ignore_path.parent.mkdir(parents=True, exist_ok=True)
    ignore_path.write_text(DEFAULT_WORKTREEIGNORE_CONTENT, encoding="utf-8")
    typer.echo(f"設定ファイルを作成しました: {ignore_path}")

    typer.echo("")
    typer.echo("設定ファイルを編集して環境に合わせて調整してください:")
    typer.echo(f"  {config_path}")
    typer.echo(f"  {ignore_path}")


def _resolve_link_targets(directory: Path, main_wt: Path, all_worktrees: bool) -> list[Path]:
    """対象WT決定（--all なら全サブWT、それ以外は CWD の WT。メインWTでの単発指定は exit 1）"""
    from cli.core.worktree import get_worktree_dirs

    if all_worktrees:
        try:
            return get_worktree_dirs(directory)
        except RuntimeError as e:
            typer.echo(f"エラー: {e}", err=True)
            raise typer.Exit(1) from None
    resolved_dir = directory.resolve()
    resolved_main = main_wt.resolve()
    if resolved_dir == resolved_main:
        typer.echo("エラー: メインWTでは --all オプションを使用してください", err=True)
        raise typer.Exit(1)
    return [resolved_dir]


def _echo_link_preview(
    targets: list[Path], config: WorktreeConfig, project_root: Path, repo_dir_name: str
) -> None:
    """dry-run モードのリンク計画表示"""
    typer.echo("--- dry-run モード（実行されません）---")
    for target_wt in targets:
        set_name = target_wt.parent.name
        typer.echo(f"\n対象: {target_wt}")
        for link in config.links:
            symlink_path = project_root / set_name / repo_dir_name / link.path
            target_abs = project_root / "base" / link.target_repo / link.target_path
            exists_marker = ""
            if symlink_path.is_symlink():
                exists_marker = " [既存リンク→更新]"
            elif symlink_path.exists():
                exists_marker = " [リアルファイル→要確認]"
            if not target_abs.exists():
                exists_marker = " [ターゲット不在→スキップ]"
            typer.echo(f"  {symlink_path} -> {target_abs}{exists_marker}")


def _confirm_overwrite(symlink_path: Path, target_path: Path) -> bool:
    return typer.confirm(
        f"  リアルファイルが存在します: {symlink_path}\n  上書きしてよいですか",
        default=False,
    )


def _apply_links_to_worktree(
    target_wt: Path,
    config: WorktreeConfig,
    project_root: Path,
    repo_dir_name: str,
    force: bool,
    all_worktrees: bool,
) -> tuple[int, int, int]:
    """1 WT にリンクを作成し、結果を表示して (作成, スキップ, エラー) 件数を返す"""
    from cli.core.worktree_links import create_symlinks_safe

    set_name = target_wt.parent.name
    typer.echo(f"\n対象: {target_wt}")

    # --force は確認なし上書き、--all は確認なしスキップ、単発は対話確認
    callback = None if force or all_worktrees else _confirm_overwrite
    results = create_symlinks_safe(
        config,
        project_root,
        set_name,
        repo_dir_name,
        force=force,
        confirm_callback=callback,
    )

    created = [r for r in results if r.action == "created"]
    skipped = [r for r in results if r.action == "skipped"]
    errors = [r for r in results if r.action == "error"]

    if created:
        typer.echo(f"  リンク作成: {len(created)}件")
    if skipped:
        typer.echo(f"  スキップ: {len(skipped)}件")
        for r in skipped:
            typer.echo(f"    {r.symlink_path}: {r.message}")
    if errors:
        typer.echo(f"  エラー: {len(errors)}件")
        for r in errors:
            typer.echo(f"    {r.symlink_path}: {r.message}", err=True)
    return len(created), len(skipped), len(errors)


@require_repo_match(mode="reject")
def worktree_link(
    ctx: typer.Context,
    directory: DirectoryOption = ...,  # type: ignore[assignment]
    force: Annotated[
        bool,
        typer.Option(
            "--force",
            help="リアルファイル/ディレクトリを確認なしで上書き",
        ),
    ] = False,
    all_worktrees: Annotated[
        bool,
        typer.Option(
            "--all",
            help="全サブワークツリーに適用",
        ),
    ] = False,
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            help="実行せずプレビューのみ",
        ),
    ] = False,
) -> None:
    """既存ワークツリーにシンボリックリンクを適用/更新する"""
    from cli.core.worktree import (
        detect_project_root,
        ensure_devcontainer_environment,
        find_main_worktree,
    )

    ensure_devcontainer_environment()
    from cli.core.worktree_links import find_config_file, load_config

    # 設定ファイル取得
    config_path = find_config_file(directory)
    if config_path is None:
        typer.echo("エラー: 設定ファイルが見つかりません", err=True)
        typer.echo(
            "  → pecot worktree init -D <directory> で設定ファイルを作成してください", err=True
        )
        raise typer.Exit(1)

    config = load_config(config_path)

    # メインWT取得 & プロジェクトルート検出
    try:
        main_wt = find_main_worktree(directory)
        project_root = detect_project_root(directory)
    except RuntimeError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None

    repo_dir_name = main_wt.name

    # 対象WT決定
    targets = _resolve_link_targets(directory, main_wt, all_worktrees)
    if not targets:
        typer.echo("サブワークツリーがありません。")
        return

    # dry-run モード
    if dry_run:
        _echo_link_preview(targets, config, project_root, repo_dir_name)
        return

    # リンク作成
    total_created = 0
    total_skipped = 0
    total_errors = 0

    for target_wt in targets:
        created, skipped, errors = _apply_links_to_worktree(
            target_wt, config, project_root, repo_dir_name, force, all_worktrees
        )
        total_created += created
        total_skipped += skipped
        total_errors += errors

    # サマリ（複数WTの場合）
    if len(targets) > 1:
        typer.echo(
            f"\n合計: 作成 {total_created}件, スキップ {total_skipped}件, エラー {total_errors}件"
        )
