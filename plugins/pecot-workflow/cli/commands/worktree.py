"""cli/worktree.py - worktree commands

Provides worktree utility functions and CLI commands.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

from cli.commands._output import Operation, Output, Verb
from cli.commands._repo_policy import require_repo_match
from cli.commands.options import DirectoryOption

if TYPE_CHECKING:
    from cli.core.worktree import CopyResult
    from cli.core.worktree_links import SymlinkResult, WorktreeConfig

# CLI commands


def _echo_link_results(linked_files: list[SymlinkResult], out: Output) -> None:
    """Print the counts of symlink creation (the cause of each error is logged by core)"""
    link_created = [r for r in linked_files if r.action == "created"]
    link_skipped = [r for r in linked_files if r.action == "skipped"]
    link_errors = [r for r in linked_files if r.action == "error"]
    out.count("symlinks created", len(link_created))
    if link_skipped:
        out.count("symlinks skipped", len(link_skipped))
    if link_errors:
        out.count("symlink errors", len(link_errors))


def _echo_copy_results(copied_files: list[CopyResult], out: Output) -> None:
    """Print the counts and errors of copying untracked files"""
    copied = [r for r in copied_files if r.action == "copied"]
    skipped = [r for r in copied_files if r.action == "skipped"]
    errors = [r for r in copied_files if r.action == "error"]
    out.count("files copied", len(copied))
    if skipped:
        out.count("files skipped", len(skipped))
    if errors:
        out.count("copy errors", len(errors))
        for copy_err in errors:
            out.warning(f"copy {copy_err.source}: {copy_err.message}")


@require_repo_match(mode="reject")
def worktree_add(
    ctx: typer.Context,
    directory: DirectoryOption = ...,  # type: ignore[assignment]
    base: Annotated[
        str | None,
        typer.Option(
            "--base",
            help="Base branch (default: the current branch)",
        ),
    ] = None,
    path: Annotated[
        Path | None,
        typer.Option(
            "--path",
            help="Where to create the worktree (default: <project_root>/<auto-numbered>/<repository name>)",
            resolve_path=True,
        ),
    ] = None,
    no_copy: Annotated[
        bool,
        typer.Option(
            "--no-copy",
            help="Skip copying untracked files",
        ),
    ] = False,
    no_link: Annotated[
        bool,
        typer.Option(
            "--no-link",
            help="Skip creating symlinks",
        ),
    ] = False,
    setup: Annotated[
        str | None,
        typer.Option(
            "--setup",
            help="Command to run after creation",
        ),
    ] = None,
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            help="Show what would happen without changing anything",
        ),
    ] = False,
    allow_existing_branch: Annotated[
        bool,
        typer.Option(
            "--allow-existing-branch",
            "--force",
            help="Allow reusing an existing branch even if its upstream differs from develop_branch",
        ),
    ] = False,
) -> None:
    """Create a new worktree"""
    from cli.core.worktree import create_worktree, ensure_devcontainer_environment

    out = Output(dry_run)

    try:
        ensure_devcontainer_environment()
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
        out.error(str(e))
        raise typer.Exit(1) from None

    op = Operation(
        Verb.CREATE,
        f"worktree {result.name} at {result.path} (branch {result.branch} from {result.base_branch})",
    )
    out.planned(op)
    out.done(op)
    out.data(str(result.path))

    if result.linked_files:
        _echo_link_results(result.linked_files, out)

    if result.copied_files:
        _echo_copy_results(result.copied_files, out)


@require_repo_match(mode="reject")
def worktree_remove(
    ctx: typer.Context,
    name: Annotated[
        str,
        typer.Argument(
            help="Name of the worktree to remove (the branch name)",
        ),
    ],
    directory: DirectoryOption = ...,  # type: ignore[assignment]
    force: Annotated[
        bool,
        typer.Option(
            "--force",
            help="Force removal even if there are changes",
        ),
    ] = False,
    keep_branch: Annotated[
        bool,
        typer.Option(
            "--keep-branch",
            help="Keep the branch",
        ),
    ] = False,
) -> None:
    """Remove a worktree"""
    from cli.core.worktree import ensure_devcontainer_environment, remove_worktree

    out = Output(False)

    try:
        ensure_devcontainer_environment()
        remove_worktree(
            cwd=directory,
            name=name,
            force=force,
            keep_branch=keep_branch,
        )
    except RuntimeError as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    out.done(Operation(Verb.REMOVE, f"worktree {name}"))
    if not keep_branch:
        out.done(Operation(Verb.DELETE, f"local branch {name}"))


@require_repo_match(mode="reject")
def worktree_init(
    ctx: typer.Context,
    directory: DirectoryOption = ...,  # type: ignore[assignment]
) -> None:
    """Create the worktree config files in the main worktree

    Writes the default template as the following 2 files.
      - .pecot/config/worktree-config.json  (symlink / setup_command)
      - .pecot/config/.worktreeignore       (patterns excluded from copying)
    """
    from cli.core.config import load_active_config
    from cli.core.paths import WORKTREE_CONFIG_FILENAME, WORKTREE_IGNORE_FILENAME
    from cli.core.worktree import ensure_devcontainer_environment, find_main_worktree
    from cli.core.worktree_links import (
        DEFAULT_WORKTREEIGNORE_CONTENT,
        get_default_config,
        save_config,
    )

    out = Output(False)

    try:
        ensure_devcontainer_environment()
        main_wt = find_main_worktree(directory)
    except RuntimeError as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    config_path = main_wt / WORKTREE_CONFIG_FILENAME
    ignore_path = main_wt / WORKTREE_IGNORE_FILENAME

    if config_path.exists() or ignore_path.exists():
        existing = [str(p) for p in (config_path, ignore_path) if p.exists()]
        out.error("\n".join(["worktree config already exists", *existing]))
        raise typer.Exit(1)

    # target_repo of the 3 shared links: aggregation_repo of the active project, else this repo
    target_repo = main_wt.name
    try:
        project_config = load_active_config()
        aggregation_ref = project_config.aggregation_repo_ref if project_config else None
        if aggregation_ref is not None:
            target_repo = aggregation_ref.repo
    except Exception:
        pass

    config = get_default_config(target_repo=target_repo, self_repo=main_wt.name)
    save_config(config, config_path)
    out.done(Operation(Verb.CREATE, f"worktree config {config_path}"))

    ignore_path.parent.mkdir(parents=True, exist_ok=True)
    ignore_path.write_text(DEFAULT_WORKTREEIGNORE_CONTENT, encoding="utf-8")
    out.done(Operation(Verb.CREATE, f"worktree ignore file {ignore_path}"))


def _resolve_link_targets(
    directory: Path, main_wt: Path, all_worktrees: bool, out: Output
) -> list[Path]:
    """Decide the target worktrees (all sub-worktrees with --all, otherwise the worktree of the CWD; a single target in the main worktree exits 1)"""
    from cli.core.worktree import get_worktree_dirs

    if all_worktrees:
        try:
            return get_worktree_dirs(directory)
        except RuntimeError as e:
            out.error(str(e))
            raise typer.Exit(1) from None
    resolved_dir = directory.resolve()
    resolved_main = main_wt.resolve()
    if resolved_dir == resolved_main:
        out.error("use --all in the main worktree")
        raise typer.Exit(1)
    return [resolved_dir]


def _echo_link_preview(
    targets: list[Path],
    config: WorktreeConfig,
    project_root: Path,
    repo_dir_name: str,
    out: Output,
) -> None:
    """Show the link plan in dry-run mode"""
    for target_wt in targets:
        set_name = target_wt.parent.name
        for link in config.links:
            symlink_path = project_root / set_name / repo_dir_name / link.path
            target_abs = project_root / "base" / link.target_repo / link.target_path
            if not target_abs.exists():
                op = Operation(Verb.SKIP, f"symlink {symlink_path} (target missing)")
            elif symlink_path.is_symlink():
                op = Operation(Verb.UPDATE, f"symlink {symlink_path} -> {target_abs}")
            elif symlink_path.exists():
                op = Operation(
                    Verb.UPDATE,
                    f"symlink {symlink_path} -> {target_abs} (real file, asks first)",
                )
            else:
                op = Operation(Verb.CREATE, f"symlink {symlink_path} -> {target_abs}")
            out.planned(op)


def _confirm_overwrite(symlink_path: Path, target_path: Path) -> bool:
    return typer.confirm(
        f"real file exists: {symlink_path}\noverwrite it?",
        default=False,
        err=True,
    )


def _apply_links_to_worktree(
    target_wt: Path,
    config: WorktreeConfig,
    project_root: Path,
    repo_dir_name: str,
    force: bool,
    all_worktrees: bool,
    out: Output,
) -> tuple[int, int, int]:
    """Create links in one worktree, show the result, and return the (created, skipped, error) counts"""
    from cli.core.worktree_links import create_symlinks_safe

    set_name = target_wt.parent.name

    # --force overwrites without asking, --all skips without asking, a single target asks
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

    out.count(f"symlinks created in {target_wt}", len(created))
    for r in skipped:
        out.done(Operation(Verb.SKIP, f"symlink {r.symlink_path} ({r.message})"))
    return len(created), len(skipped), len(errors)


@require_repo_match(mode="reject")
def worktree_link(
    ctx: typer.Context,
    directory: DirectoryOption = ...,  # type: ignore[assignment]
    force: Annotated[
        bool,
        typer.Option(
            "--force",
            help="Overwrite real files and directories without asking",
        ),
    ] = False,
    all_worktrees: Annotated[
        bool,
        typer.Option(
            "--all",
            help="Apply to all sub-worktrees",
        ),
    ] = False,
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            help="Show what would happen without changing anything",
        ),
    ] = False,
) -> None:
    """Apply or update symlinks in existing worktrees"""
    from cli.core.worktree import (
        detect_project_root,
        ensure_devcontainer_environment,
        find_main_worktree,
    )

    out = Output(dry_run)
    from cli.core.worktree_links import WorktreeConfigError, find_config_file, load_config

    try:
        ensure_devcontainer_environment()
    except RuntimeError as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    config_path = find_config_file(directory)
    if config_path is None:
        out.error("worktree config not found\nrun: pecot worktree init -D <directory>")
        raise typer.Exit(1)

    try:
        config = load_config(config_path)
    except WorktreeConfigError as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    # main worktree and project root
    try:
        main_wt = find_main_worktree(directory)
        project_root = detect_project_root(directory)
    except RuntimeError as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    repo_dir_name = main_wt.name

    targets = _resolve_link_targets(directory, main_wt, all_worktrees, out)
    if not targets:
        out.count("sub-worktrees", 0)
        return

    if dry_run:
        _echo_link_preview(targets, config, project_root, repo_dir_name, out)
        return

    total_created = 0
    total_skipped = 0
    total_errors = 0

    for target_wt in targets:
        created, skipped, errors = _apply_links_to_worktree(
            target_wt, config, project_root, repo_dir_name, force, all_worktrees, out
        )
        total_created += created
        total_skipped += skipped
        total_errors += errors

    if len(targets) > 1:
        out.count("symlinks created", total_created)
        out.count("symlinks skipped", total_skipped)
        out.count("symlink errors", total_errors)
