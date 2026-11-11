"""core/worktree.py - ワークツリー管理コアロジック

ワークツリーの作成・削除・ファイルコピーの
コアビジネスロジックを提供する。

全ての関数はcwd引数で対象リポジトリを指定する。
pecot CLI は作業リポジトリの中で実行されるが、worktree コマンドは
別のリポジトリを対象にするため、cwd引数が必須。
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import pathspec
from pydantic import ValidationError

from cli.core.config import ProjectConfig, load_active_config
from cli.core.git import git_toplevel, primary_remote_name, primary_remote_repo, run_git
from cli.core.repo_resolver import RepoRef

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from cli.core.worktree_links import SymlinkResult, WorktreeConfig

logger = logging.getLogger(__name__)

# 環境ガード


def ensure_devcontainer_environment() -> None:
    """pecot worktree 系コマンドが devcontainer 内で実行されていることを確認

    devcontainer 外（host 直接）での実行はサポート外。プロジェクトの
    devcontainer が整えるマウント構造（/workspaces/<project>/base/<repo>）に
    依存するため、外で動かしても動作は保証しない。

    検出方法（いずれかでヒットすれば通過）は次のとおり。
      - ``/.dockerenv`` ファイルの存在
      - 環境変数 ``REMOTE_CONTAINERS`` / ``CODESPACES`` / ``DEVCONTAINER`` のいずれかが設定されている。

    Raises:
        RuntimeError: いずれも満たさない場合
    """
    if Path("/.dockerenv").exists():
        return
    for env_var in ("REMOTE_CONTAINERS", "CODESPACES", "DEVCONTAINER"):
        # interface-env: REMOTE_CONTAINERS CODESPACES DEVCONTAINER
        if os.environ.get(env_var):
            return
    raise RuntimeError(
        "this command must run inside a devcontainer\n"
        "the current environment does not have the mount layout pecot expects "
        "(/workspaces/<project>/base/<repo>)\n"
        "prepare .devcontainer/ in the project, run Reopen in Container in VS Code, and run it again"
    )


# データクラス


@dataclass
class CopyResult:
    """ファイルコピー結果

    Attributes:
        source: コピー元パス。
        dest: コピー先パス。
        action: 実行アクション（"copied" | "skipped" | "error"）。
        message: 追加メッセージ（エラー詳細など）。
    """

    source: Path
    dest: Path
    action: str  # "copied" | "skipped" | "error"
    message: str = ""


@dataclass
class SetupResult:
    """setup_command 実行結果

    Attributes:
        command: 実行したコマンド文字列
        returncode: 終了コード
        stdout: 標準出力
        stderr: 標準エラー出力
    """

    command: str
    returncode: int
    stdout: str
    stderr: str


@dataclass
class WorktreeCreateResult:
    """ワークツリー作成結果

    Attributes:
        name: WT名。
        path: WTパス。
        branch: ブランチ名。
        base_branch: ベースブランチ名。
        copied_files: コピー結果リスト。
        linked_files: シンボリックリンク作成結果リスト。
        setup_result: setup_command の実行結果（実行しなかった場合は None）。
    """

    name: str
    path: Path
    branch: str
    base_branch: str
    copied_files: list[CopyResult] = field(default_factory=list[CopyResult])
    # SymlinkResult は循環 import 回避のため TYPE_CHECKING 限定 import。
    # 実行時に名前解決できないため list[SymlinkResult] を default_factory に
    # 渡せず、cast で型だけ付与する（実体は空 list を返す list）。
    linked_files: list[SymlinkResult] = field(
        default_factory=cast("Callable[[], list[SymlinkResult]]", list)
    )
    setup_result: SetupResult | None = None


# Git操作関数


@dataclass
class WorktreeInfo:
    """ワークツリー情報"""

    path: str
    commit: str
    branch: str | None


def get_worktree_list(cwd: Path | None = None) -> list[WorktreeInfo]:
    """git worktree listの結果をパース

    Args:
        cwd: 対象ディレクトリ（省略時: カレントディレクトリ）

    Returns:
        WorktreeInfoのリスト
    """
    result = run_git(["worktree", "list"], cwd, check=False)
    if result.returncode != 0:
        return []

    worktrees: list[WorktreeInfo] = []
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue

        # フォーマット: /path/to/worktree  abc123 [branch-name]
        # または: /path/to/worktree  abc123 (detached HEAD)
        match = re.match(r"^(\S+)\s+(\S+)\s+\[([^\]]+)\]", line)
        if match:
            worktrees.append(
                WorktreeInfo(
                    path=match.group(1),
                    commit=match.group(2),
                    branch=match.group(3),
                )
            )
        else:
            # detached HEAD の場合
            match = re.match(r"^(\S+)\s+(\S+)", line)
            if match:
                worktrees.append(
                    WorktreeInfo(
                        path=match.group(1),
                        commit=match.group(2),
                        branch=None,
                    )
                )

    return worktrees


def find_main_worktree(cwd: Path) -> Path:
    """メインワークツリーのパスを取得

    git worktree list の最初のエントリがメインWT。

    Args:
        cwd: 対象ディレクトリ（任意のWT内でOK）

    Returns:
        メインWTの絶対パス

    Raises:
        RuntimeError: git worktree list の実行に失敗した場合
    """
    result = run_git(["worktree", "list"], cwd, check=False)
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"cannot get the worktree list: {result.stderr}")

    first_line = result.stdout.strip().split("\n")[0]
    match = re.match(r"^(\S+)", first_line)
    if not match:
        raise RuntimeError("cannot get the worktree list: parse error")

    return Path(match.group(1))


def is_worktree_env(cwd: Path) -> bool:
    """サブワークツリー環境かどうかを判定

    git rev-parse --git-dir と --git-common-dir を比較する。
    サブWTでは git-dir がメインの .git を指すため、両者が異なる。

    Args:
        cwd: 判定対象ディレクトリ

    Returns:
        サブWT環境なら True、メインWT/通常リポジトリなら False

    Raises:
        RuntimeError: Gitリポジトリ外で実行した場合、またはgitコマンド失敗時
    """
    try:
        git_dir_result = run_git(["rev-parse", "--git-dir"], cwd, check=True)
        common_dir_result = run_git(["rev-parse", "--git-common-dir"], cwd, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"not a git repository: {e.stderr.strip()}") from e

    git_dir = Path(git_dir_result.stdout.strip()).resolve()
    common_dir = Path(common_dir_result.stdout.strip()).resolve()
    return git_dir != common_dir


def get_worktree_dirs(cwd: Path) -> list[Path]:
    """サブワークツリーのパス一覧を取得

    get_worktree_list() を利用して全WTを取得し、
    最初のエントリ（メインWT）を除外したサブWTのパスを返す。

    Args:
        cwd: 対象ディレクトリ（任意のWT内でOK）

    Returns:
        サブWTの絶対パスのリスト

    Raises:
        RuntimeError: ワークツリー一覧を取得できない場合
    """
    entries = get_worktree_list(cwd=cwd)
    if not entries:
        raise RuntimeError("cannot get the worktree list")

    # 最初のエントリ（メインWT）を除外
    return [Path(entry.path) for entry in entries[1:]]


WORKTREE_NAME_MARKER = "pecot-worktree-name"


def _read_worktree_name_marker(cwd: Path) -> str | None:
    """worktree add が git の管理ディレクトリに書いた wtN を読む。無ければ None"""
    result = run_git(
        ["rev-parse", "--path-format=absolute", "--git-path", WORKTREE_NAME_MARKER],
        cwd,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        text = Path(result.stdout.strip()).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def _write_worktree_name_marker(path: Path, name: str) -> None:
    """新しい worktree の git の管理ディレクトリに wtN を記録する。失敗は warning"""
    try:
        result = run_git(
            ["rev-parse", "--path-format=absolute", "--git-path", WORKTREE_NAME_MARKER],
            path,
            check=True,
        )
        Path(result.stdout.strip()).write_text(name + "\n", encoding="utf-8")
    except (subprocess.CalledProcessError, OSError) as e:
        logger.warning("failed to record the worktree name %s: %s", name, e)


def get_claimed_set_names(main_wt: Path) -> set[str]:
    """このリポの worktree が使っている wtN（記録と、wtN ブランチの checkout）の集合"""
    names: set[str] = set()
    common = run_git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"], main_wt, check=False
    )
    if common.returncode == 0 and common.stdout.strip():
        for marker in (Path(common.stdout.strip()) / "worktrees").glob(f"*/{WORKTREE_NAME_MARKER}"):
            try:
                text = marker.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if text:
                names.add(text)
    refs = run_git(
        ["for-each-ref", "--format=%(refname:short)%00%(worktreepath)", "refs/heads/"],
        main_wt,
        check=False,
    )
    if refs.returncode == 0:
        for line in refs.stdout.splitlines():
            branch, _, wt_path = line.partition("\0")
            if wt_path and re.fullmatch(r"wt\d+", branch):
                names.add(branch)
    return names


def get_current_worktree_name(cwd: Path) -> str | None:
    """現在のサブワークツリー名を返す

    worktree add の記録を先に読み、無ければ置き場所の親ディレクトリが wtN か base のときだけその名前を返す。
    サブWT環境でないか、どちらも無ければ None。

    Raises:
        RuntimeError: Gitリポジトリ外で実行した場合（``is_worktree_env`` 由来）
    """
    if not is_worktree_env(cwd):
        return None

    recorded = _read_worktree_name_marker(cwd)
    if recorded:
        return recorded
    toplevel = git_toplevel(cwd)
    if toplevel is None:
        return None
    parent = toplevel.parent.name
    if re.fullmatch(r"wt\d+|base", parent):
        return parent
    return None


def detect_project_root(cwd: Path) -> Path:
    """プロジェクトルートを検出

    呼び出し側リポジトリの main_wt を正規化し、
    ``<root>/base/<repo>`` の形になっているか確認する。

    Args:
        cwd: 対象ディレクトリ（任意のWT内でOK）

    Returns:
        プロジェクトルートの絶対パス（`<root>`）

    Raises:
        RuntimeError: ``<root>/base/<repo>`` 形式でない場合
    """
    main_wt = find_main_worktree(cwd)
    resolved = main_wt.resolve()
    if resolved.parent.name != "base":
        expected = resolved.parent / "base" / resolved.name
        raise RuntimeError(
            "this repository is not placed in the layout pecot expects for a project\n"
            "\n"
            f"  current: {resolved}\n"
            f"  expected: {expected}\n"
            "\n"
            "why base/ is needed:\n"
            "  the devcontainer mounts the parallel sets (wt1, wt2...) selectively, so base/ "
            "separates the resident set from the parallel sets\n"
            "\n"
            "migration steps (the cwd goes away, so close this CLI session first):\n"
            "  1. close this CLI session\n"
            f"  2. in another terminal, run:\n"
            f"       mkdir -p {resolved.parent}/base\n"
            f"       mv {resolved} {resolved.parent}/base/\n"
            f"  3. restart the CLI in {resolved.parent}/base/{resolved.name}/"
        )
    return resolved.parent.parent


def get_next_set_name(
    project_root: Path,
    repo_dir_name: str,
    prefix: str = "wt",
    max_n: int = 9,
    claimed: Iterable[str] = (),
) -> str:
    """プロジェクトルート基準で対象リポの参加先セット名を決定

    対象は ``<project_root>/wtN`` と claimed（このリポの worktree が使う wtN）の番号。
    ``wtN/<repo_dir_name>`` が無く、claimed に無い最小の N に参加する。
    全部使用中なら ``max(N)+1``、番号が無ければ ``wt1`` を返す。

    Args:
        project_root: プロジェクトルート。
        repo_dir_name: 対象リポのディレクトリ名（main_wt の basename）。
        prefix: プレフィクス（デフォルト: "wt"）。
        max_n: 最大番号（デフォルト: 9）。

    Returns:
        参加先セット名（例: "wt2"）。

    Raises:
        RuntimeError: 全セットに参加済みで max_n を超える場合
    """
    existing: list[int] = []
    if project_root.exists():
        pattern = re.compile(rf"^{re.escape(prefix)}(\d+)$")
        for entry in project_root.iterdir():
            if entry.is_dir():
                m = pattern.match(entry.name)
                if m:
                    existing.append(int(m.group(1)))

    claimed_names = set(claimed)
    claimed_pattern = re.compile(rf"^{re.escape(prefix)}(\d+)$")
    for claimed_name in claimed_names:
        m = claimed_pattern.match(claimed_name)
        if m and int(m.group(1)) not in existing:
            existing.append(int(m.group(1)))

    if not existing:
        return f"{prefix}1"

    existing.sort()

    # 2. 既存セットで該当リポが未登場のものがあればそこに参加
    for n in existing:
        if (
            not (project_root / f"{prefix}{n}" / repo_dir_name).exists()
            and f"{prefix}{n}" not in claimed_names
        ):
            return f"{prefix}{n}"

    # 3. 全セットに参加済 → 新セット
    new_n = existing[-1] + 1
    if new_n > max_n:
        raise RuntimeError(f"all of {prefix}1 to {prefix}{max_n} are in use: no free set")
    return f"{prefix}{new_n}"


# 未追跡ファイル操作


def get_untracked_files(cwd: Path) -> list[Path]:
    """git管理外（gitignored）ファイルの一覧を取得

    Args:
        cwd: 対象ディレクトリ（メインWTのルート）

    Returns:
        相対パスのリスト
    """
    result = run_git(["ls-files", "--others", "--ignored", "--exclude-standard"], cwd, check=False)
    if result.returncode != 0 or not result.stdout.strip():
        return []

    return [Path(line) for line in result.stdout.strip().split("\n") if line]


def _should_exclude(file_path: Path, spec: pathspec.PathSpec[Any]) -> bool:
    """除外パターンにマッチするか判定

    Args:
        file_path: チェック対象の相対パス
        spec: .worktreeignore から読み込んだ pathspec

    Returns:
        除外すべき場合True
    """
    return spec.match_file(str(file_path))


def filter_copyable_files(files: list[Path], spec: pathspec.PathSpec[Any]) -> list[Path]:
    """コピー対象外のファイルを除外

    Args:
        files: 相対パスのリスト
        spec: .worktreeignore から読み込んだ pathspec

    Returns:
        フィルタ後のリスト
    """
    return [f for f in files if not _should_exclude(f, spec)]


def copy_files(source_root: Path, dest_root: Path, files: list[Path]) -> list[CopyResult]:
    """ファイルをコピー

    Args:
        source_root: コピー元のルートディレクトリ
        dest_root: コピー先のルートディレクトリ
        files: コピーする相対パスのリスト

    Returns:
        CopyResultのリスト
    """
    results: list[CopyResult] = []

    for rel_path in files:
        src = source_root / rel_path
        dst = dest_root / rel_path

        if not src.exists():
            results.append(
                CopyResult(
                    source=src,
                    dest=dst,
                    action="skipped",
                    message="source file does not exist",
                )
            )
            continue

        try:
            # 親ディレクトリを作成
            dst.parent.mkdir(parents=True, exist_ok=True)

            if src.is_dir():
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                # シンボリックリンクの場合はリンク先をコピー（follow_symlinks=True）
                shutil.copy2(src, dst, follow_symlinks=True)

            results.append(CopyResult(source=src, dest=dst, action="copied"))
        except OSError as e:
            results.append(
                CopyResult(
                    source=src,
                    dest=dst,
                    action="error",
                    message=str(e),
                )
            )

    return results


# オーケストレーション

_NO_REMOTE_MESSAGE = "cannot get the repository information: check that a git remote is set"


def _get_repo_info(cwd: Path) -> RepoRef:
    """主の remote（origin、無ければ最初の remote）からリポジトリ情報を取得

    Args:
        cwd: 対象ディレクトリ

    Returns:
        RepoRef

    Raises:
        RuntimeError: リポジトリ情報を取得できない場合
    """
    primary = primary_remote_repo(cwd)
    info: RepoRef | None = None
    if primary is not None:
        _host, owner, repo = primary
        try:
            info = RepoRef(owner=owner, repo=repo)
        except ValidationError:
            info = None
    if info is None:
        raise RuntimeError(_NO_REMOTE_MESSAGE)
    return info


def _load_copy_exclude_spec_or_raise(main_wt: Path) -> tuple[Path, pathspec.GitIgnoreSpec]:
    """1.1 必須設定ファイルの存在チェック（無ければ早期エラー、init を促す）

    Returns:
        (ワークツリー設定ファイルのパス, コピー除外 spec)
    """
    from cli.core.paths import WORKTREE_CONFIG_FILENAME
    from cli.core.worktree_links import WorktreeConfigError, load_copy_exclude_spec

    worktree_config_path = main_wt / WORKTREE_CONFIG_FILENAME
    if not worktree_config_path.exists():
        raise RuntimeError(
            f"worktree config not found: {WORKTREE_CONFIG_FILENAME}\n"
            "  run pecot worktree init to generate the template"
        )

    try:
        return worktree_config_path, load_copy_exclude_spec(main_wt)
    except WorktreeConfigError as e:
        raise RuntimeError(str(e)) from e


def _require_registered_repo(cwd: Path) -> tuple[RepoRef, ProjectConfig]:
    """1.5 リポジトリ登録チェック（アクティブプロジェクト配下か確認）"""
    repo_info = _get_repo_info(cwd)
    config = load_active_config()
    if config is None:
        raise RuntimeError(
            "project config not found\n"
            "  hint: run pecot project activate <PROJECT> to set the project"
        )
    if config.find_repository(repo_info.owner, repo_info.repo) is None:
        registered = (
            "\n".join(f"  - {r.owner}/{r.name}" for r in config.repositories)
            if config.repositories
            else "  (none registered)"
        )
        raise RuntimeError(
            f"repository {repo_info.owner}/{repo_info.repo} is not registered in the "
            "active pecot project\n"
            "\n"
            "registered repositories:\n"
            f"{registered}\n"
            "\n"
            "to add this repository to the pecot project:\n"
            f"  pecot project set-repo {repo_info.owner}/{repo_info.repo}\n"
            "\n"
            "to switch to another project:\n"
            "  pecot project activate <PROJECT>"
        )
    return repo_info, config


def _default_base_branch(config: ProjectConfig, repo_info: RepoRef) -> str:
    """3. ベースブランチ決定（プロジェクト設定の develop_branch を使用）"""
    develop_branch = config.get_develop_branch(repo_info.owner, repo_info.repo)
    if not develop_branch:
        repo_full = f"{repo_info.owner}/{repo_info.repo}"
        raise RuntimeError(
            f"develop_branch is not set for repository {repo_full}\n"
            "  add develop_branch to repositories in the project config file\n"
            "  or pass --base explicitly"
        )
    return develop_branch


def _load_worktree_config_or_raise(worktree_config_path: Path) -> WorktreeConfig:
    """ワークツリー設定を読み込む（設定は Step 1.1 で存在確認済み）"""
    from cli.core.worktree_links import WorktreeConfigError, load_config

    try:
        return load_config(worktree_config_path)
    except WorktreeConfigError as e:
        # 設定ファイルは存在するが読み込み/検証に失敗（不正 JSON、スキーマ違反等）。
        # 設定ファイル不在と同様に hard error として扱い、ユーザーに修正を促す。
        raise RuntimeError(
            f"failed to load the worktree config: {worktree_config_path}: {e}\n"
            "  fix the config file and run it again"
        ) from e


def _create_worktree_symlinks(
    worktree_config: WorktreeConfig,
    project_root: Path,
    path: Path,
) -> tuple[list[SymlinkResult], set[Path]]:
    """6. シンボリックリンク作成。(結果, 作成成功したリンクの WT 相対パス) を返す"""
    from cli.core.worktree_links import create_symlinks

    linked_files = create_symlinks(worktree_config, project_root, path)

    # 作成成功したシンボリックリンクのパスを記録（コピー除外用）
    symlinked_paths: set[Path] = set()
    for lr in linked_files:
        if lr.action == "created":
            try:
                symlinked_paths.add(lr.symlink_path.relative_to(path))
            except ValueError:
                pass
    return linked_files, symlinked_paths


def _copy_untracked_to_worktree(
    main_wt: Path,
    path: Path,
    copy_exclude_spec: pathspec.GitIgnoreSpec,
    symlinked_paths: set[Path],
) -> list[CopyResult]:
    """7. 未追跡ファイルコピー（シンボリックリンク対象を除外）"""
    untracked = get_untracked_files(main_wt)
    copyable = filter_copyable_files(untracked, copy_exclude_spec)

    # シンボリックリンク対象を除外
    if symlinked_paths:
        copyable = [f for f in copyable if not any(f.is_relative_to(sp) for sp in symlinked_paths)]

    if copyable:
        return copy_files(main_wt, path, copyable)
    return []


def _format_setup_failure(sr: SetupResult) -> str:
    """Build the one-message warning of a failed setup command (head line plus out/err lines)"""
    if sr.returncode == -1:
        head = f"setup command timed out: {sr.command}"
    else:
        head = f"setup command failed (exit {sr.returncode}): {sr.command}"
    lines = [head]
    if sr.stdout.strip():
        lines += [f"out: {line}" for line in sr.stdout.rstrip("\n").split("\n")]
    if sr.stderr.strip():
        lines += [f"err: {line}" for line in sr.stderr.rstrip("\n").split("\n")]
    return "\n".join(lines)


def _run_effective_setup(
    setup_command: str | None, worktree_config: WorktreeConfig, path: Path
) -> SetupResult | None:
    """8. セットアップコマンド実行

    優先順位: CLI --setup 明示 > config.setup_command > skip
    """
    effective_setup = setup_command
    if effective_setup is None:
        effective_setup = worktree_config.setup_command

    if not effective_setup:
        return None
    setup_result = _run_setup_command(
        effective_setup, cwd=path, timeout=worktree_config.setup_command_timeout
    )
    if setup_result.returncode != 0:
        logger.warning(_format_setup_failure(setup_result))
    return setup_result


def create_worktree(
    cwd: Path,
    name: str | None = None,
    base_branch: str | None = None,
    path: Path | None = None,
    copy: bool = True,
    link: bool = True,
    setup_command: str | None = None,
    dry_run: bool = False,
    allow_existing_branch: bool = False,
) -> WorktreeCreateResult:
    """ワークツリーを作成

    注記:
        CLI (``pecot worktree add``) は NAME 位置引数を廃止しているため、
        常に ``name=None`` で呼ばれる（プロジェクトルート基準で自動採番）。
        SDK/直接利用で明示 name を渡すことは可能だが、セット整合性が
        ユーザー責務になる。

    Args:
        cwd: 対象Gitリポジトリのパス。
        name: WT名（省略時: 自動決定）。
        base_branch: ベースブランチ（省略時: プロジェクト設定の develop_branch）。
        path: WT作成先パス（省略時: ``<project_root>/<name>/<repo_dir_name>``）。
        copy: 未追跡ファイルをコピーするか（デフォルト: True）。
        link: シンボリックリンクを作成するか（デフォルト: True）。
        setup_command: 作成後に実行するコマンド。
        dry_run: プレビューのみ（デフォルト: False）。
        allow_existing_branch: 既存ブランチの upstream が develop_branch と
            異なる場合でも再利用を許可する（デフォルト: False）。

    Returns:
        WorktreeCreateResult

    Raises:
        RuntimeError: 作成に失敗した場合、またはプロジェクトルート/既存ブランチ衝突時
    """
    # 1. メインWT検出 & プロジェクトルート
    main_wt = find_main_worktree(cwd)
    project_root = detect_project_root(cwd)

    # 1.1 必須設定ファイルの存在チェック（無ければ早期エラー、init を促す）
    worktree_config_path, copy_exclude_spec = _load_copy_exclude_spec_or_raise(main_wt)

    # 1.2 container rebuild 後の stale worktree メタデータを事前に掃除。
    #     `.git/worktrees/<name>/` だけ残って実体が消えているケース（rebuild や
    #     手動 rm -rf のあと）で add が衝突エラーになるのを防ぐ。
    run_git(["worktree", "prune"], main_wt, check=False)

    # 1.5 リポジトリ登録チェック（アクティブプロジェクト配下か確認）
    repo_info, config = _require_registered_repo(cwd)

    # 2. 名前決定（プロジェクトセットへの自動参加）
    if name is None:
        name = get_next_set_name(project_root, main_wt.name, claimed=get_claimed_set_names(main_wt))

    # 3. ベースブランチ決定（プロジェクト設定の develop_branch を使用）
    if base_branch is None:
        base_branch = _default_base_branch(config, repo_info)

    # 4. パス計算: <project_root>/<name>/<repo_dir_name>
    repo_dir_name = main_wt.name
    if path is None:
        path = project_root / name / repo_dir_name

    # dry-run時はここで結果を返す
    if dry_run:
        return WorktreeCreateResult(
            name=name,
            path=path,
            branch=name,
            base_branch=base_branch,
            copied_files=[],
            linked_files=[],
        )

    # 5. git worktree add
    remote = primary_remote_name(cwd)
    if remote is None:
        raise RuntimeError(_NO_REMOTE_MESSAGE)
    _run_git_worktree_add(
        cwd=cwd,
        remote=remote,
        path=path,
        name=name,
        base_branch=base_branch,
        allow_existing_branch=allow_existing_branch,
    )
    _write_worktree_name_marker(path, name)

    # 6〜8. シンボリックリンク作成・未追跡ファイルコピー・セットアップコマンド実行
    result = WorktreeCreateResult(name=name, path=path, branch=name, base_branch=base_branch)
    _populate_worktree(
        result,
        main_wt,
        project_root,
        worktree_config_path,
        copy_exclude_spec,
        link=link,
        copy=copy,
        setup_command=setup_command,
    )
    return result


def _populate_worktree(
    result: WorktreeCreateResult,
    main_wt: Path,
    project_root: Path,
    worktree_config_path: Path,
    copy_exclude_spec: pathspec.GitIgnoreSpec,
    *,
    link: bool,
    copy: bool,
    setup_command: str | None,
) -> None:
    """git worktree add 後の 6〜8 を実行し、結果を result に格納する"""
    # 6. シンボリックリンク作成（設定は Step 1.1 で存在確認済み）
    worktree_config = _load_worktree_config_or_raise(worktree_config_path)
    symlinked_paths: set[Path] = set()
    if link:
        result.linked_files, symlinked_paths = _create_worktree_symlinks(
            worktree_config, project_root, result.path
        )

    # 7. 未追跡ファイルコピー（シンボリックリンク対象を除外）
    if copy:
        result.copied_files = _copy_untracked_to_worktree(
            main_wt, result.path, copy_exclude_spec, symlinked_paths
        )

    # 8. セットアップコマンド実行
    result.setup_result = _run_effective_setup(setup_command, worktree_config, result.path)


def _run_git_worktree_add(
    cwd: Path,
    remote: str,
    path: Path,
    name: str,
    base_branch: str | None,
    allow_existing_branch: bool,
) -> None:
    """`git worktree add` を実行し、既存ブランチ衝突ガードも含めて処理する

    Args:
        cwd: 対象 Git リポジトリのパス（メイン WT でも サブ WT でも可）。
        remote: 主の remote 名（origin、無ければ最初の remote）。
        path: 作成先 WT パス。
        name: ブランチ名 / WT 名。
        base_branch: upstream 期待値 (`<remote>/<base_branch>`)。
        allow_existing_branch: 既存ブランチの upstream 不一致を許容するか。

    Raises:
        RuntimeError: 既存ブランチの upstream 不一致、または git worktree add 失敗時
    """
    branch_exists = (
        run_git(
            ["show-ref", "--verify", "--quiet", f"refs/heads/{name}"], cwd, check=False
        ).returncode
        == 0
    )

    if branch_exists:
        if not allow_existing_branch:
            upstream_result = run_git(
                ["for-each-ref", "--format=%(upstream:short)", f"refs/heads/{name}"],
                cwd,
                check=False,
            )
            current_upstream = upstream_result.stdout.strip() or None
            expected_upstream = f"{remote}/{base_branch}" if base_branch else None
            if current_upstream != expected_upstream:
                raise RuntimeError(
                    f"branch '{name}' already exists and its upstream differs from the expected one "
                    f"(current: {current_upstream or '(unset)'}, expected: {expected_upstream}): "
                    "pass --allow-existing-branch to reuse it"
                )

            # upstream 一致かつ bind なし → prune に取り残された孤児ブランチとみなし除去
            wt_path_result = run_git(
                ["for-each-ref", "--format=%(worktreepath)", f"refs/heads/{name}"], cwd, check=False
            )
            if wt_path_result.returncode == 0 and not wt_path_result.stdout.strip():
                run_git(["branch", "-D", name], cwd, check=False)
                branch_exists = False

    if branch_exists:
        args = ["worktree", "add", str(path), name]
    else:
        args = ["worktree", "add", str(path), "-b", name]
        if base_branch:
            args.extend(["--track", f"{remote}/{base_branch}"])

    result = run_git(args, cwd, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"failed to create the worktree: {result.stderr}")


def _run_setup_command(command: str, cwd: Path, timeout: int | None = None) -> SetupResult:
    """setup_command を shell 経由で実行して結果を構造化して返す

    stdin は常に ``DEVNULL`` に差し向けて対話プロンプトで stall しないようにする。
    ``timeout`` 秒を超えた場合は子プロセスを kill し、``returncode=-1`` の
    SetupResult を返す（例外は投げない）。``-1`` は timeout 起因の sentinel。

    Args:
        command: 実行する shell コマンド文字列
        cwd: 実行ディレクトリ（通常は作成されたサブ WT ルート）
        timeout: タイムアウト秒数（None なら無制限）

    Returns:
        SetupResult（returncode / stdout / stderr / command）
    """
    try:
        proc = subprocess.run(
            command,
            cwd=cwd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired as e:
        stdout = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        stderr = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        return SetupResult(
            command=command,
            returncode=-1,
            stdout=stdout,
            stderr=f"{stderr}timeout after {timeout} seconds".lstrip(),
        )
    return SetupResult(
        command=command,
        returncode=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
    )


def remove_worktree(
    cwd: Path,
    name: str,
    force: bool = False,
    keep_branch: bool = False,
) -> str | None:
    """ワークツリーを削除

    Args:
        cwd: 対象Gitリポジトリのパス
        name: WT名（ブランチ名）
        force: 強制削除（デフォルト: False）
        keep_branch: ブランチを残す（デフォルト: False）

    Returns:
        ローカルブランチの削除に失敗したときはその理由。成功時と keep_branch 時は None

    Raises:
        RuntimeError: 削除に失敗した場合
    """
    # 1. WTパスを特定
    result = run_git(["worktree", "list"], cwd, check=False)

    wt_path: str | None = None
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        match = re.match(r"^(\S+)\s+(\S+)\s+\[([^\]]+)\]", line)
        if match and match.group(3) == name:
            wt_path = match.group(1)
            break

    if wt_path is None:
        raise RuntimeError(f"worktree not found: {name}")

    # 2. git worktree remove
    args = ["worktree", "remove", wt_path]
    if force:
        args.append("--force")

    result = run_git(args, cwd, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"failed to remove the worktree: {result.stderr}")

    # 3. ブランチ削除（失敗は worktree 削除後なので例外にせず理由を返す）
    branch_error: str | None = None
    if not keep_branch:
        branch_result = run_git(["branch", "-D", name], cwd, check=False)
        if branch_result.returncode != 0:
            branch_error = (
                branch_result.stderr or ""
            ).strip() or f"git branch -D exited with {branch_result.returncode}"

    # 4. プロジェクトルート配下の <name> ディレクトリが空なら rmdir
    try:
        project_root = detect_project_root(cwd)
    except RuntimeError:
        project_root = None

    if project_root is not None:
        set_dir = project_root / name
        if set_dir.exists() and set_dir.is_dir():
            try:
                next(set_dir.iterdir())
            except StopIteration:
                try:
                    set_dir.rmdir()
                except OSError as e:
                    logger.warning("failed to remove the set directory: %s: %s", set_dir, e)

    return branch_error
