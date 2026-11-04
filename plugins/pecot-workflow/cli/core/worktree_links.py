"""core/worktree_links.py - ワークツリー設定の管理

プロジェクト単位 wtN 構成（`<root>/base/<repo>` と `<root>/wtN/<repo>`）の設定を扱う。
次の 2 ファイルの読み書きを提供する。
`.pecot/config/worktree-config.json` は、シンボリックリンクと setup コマンドを保持する。
`.pecot/config/.worktreeignore`（pathspec gitignore 形式）は、コピー除外パターンを定義する。

設定ファイルは各リポジトリの main WT ルート（`<root>/base/<repo>/`）に配置し、
Pydantic v2 モデルで型安全なバリデーションを行う。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import pathspec
from pydantic import BaseModel, Field, field_validator

from cli.core.errors import PecotError
from cli.core.git import run_git
from cli.core.paths import (
    ACTIVE_PROJECT_FILENAME,
    HOOKS_CONFIG_FILENAME,
    PECOT_DIR,
    PECOT_GITIGNORE_FILENAME,
    WORK_DIR,
    WORKTREE_CONFIG_FILENAME,
    WORKTREE_IGNORE_FILENAME,
)
from cli.core.worktree import find_main_worktree

logger = logging.getLogger(__name__)

# 定数


DEFAULT_WORKTREEIGNORE_CONTENT = """\
# Git メタデータ
.git/

# Python キャッシュ。
__pycache__/
*.pyc
*.pyo
.venv/
venv/
*.egg-info/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/

# カバレッジ
htmlcov/
.coverage

# ビルド生成物
dist/
build/

# JS 依存
node_modules/

# pecot の実行時状態・一時領域（config は worktree-config の links 経由で symlink）
.pecot/
tmp/

# Nx ビルド状態（version-plans は残すので .nx/ 丸ごとは除外しない）
.nx/workspace-data/
"""
"""`pecot worktree init` で生成される .worktreeignore のデフォルト内容"""

# データクラス


@dataclass
class SymlinkResult:
    """シンボリックリンク作成結果

    Attributes:
        symlink_path: シンボリックリンクのパス。
        target_path: ターゲットパス（絶対パス）。
        action: 実行アクション（"created" | "skipped" | "error"）。
        message: 追加メッセージ（エラー詳細など）。
    """

    symlink_path: Path
    target_path: Path
    action: str  # "created" | "skipped" | "error"
    message: str = ""


# 例外クラス


class WorktreeConfigError(PecotError):
    """ワークツリー設定操作時の例外"""

    pass


# Pydanticモデル


def _validate_relative_path(v: str, field_name: str) -> str:
    if not v or not v.strip():
        raise ValueError(f"{field_name} は空にできません")
    if v.startswith("/"):
        raise ValueError(f"絶対パスは使用できません: {v}")
    if ".." in v.split("/"):
        raise ValueError(f"親ディレクトリ参照は使用できません: {v}")
    return v


class WorktreeLinkItem(BaseModel):
    """個別リンク定義

    Attributes:
        path: wt 側リポジトリルートからの相対パス（symlink の配置先）。
        target_repo: base 直下のリポジトリ名（symlink ターゲットの所在）。
        target_path: `base/<target_repo>/` 配下の相対パス。
        description: 説明。
    """

    path: str
    target_repo: str
    target_path: str
    description: str | None = None

    @field_validator("path")
    @classmethod
    def _v_path(cls, v: str) -> str:
        return _validate_relative_path(v, "path")

    @field_validator("target_path")
    @classmethod
    def _v_target_path(cls, v: str) -> str:
        return _validate_relative_path(v, "target_path")

    @field_validator("target_repo")
    @classmethod
    def _v_target_repo(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("target_repo は空にできません")
        if "/" in v:
            raise ValueError(f"target_repo にスラッシュは含められません: {v}")
        if v in ("..", "."):
            raise ValueError(f"target_repo が不正です: {v}")
        return v


class WorktreeConfig(BaseModel):
    """ワークツリー設定全体 (v3)

    Attributes:
        version: フォーマットバージョン（常に 3）。
        description: 説明。
        links: リンク定義の配列。
        setup_command: WT 作成直後にサブ WT ルートで実行するコマンド（shell 経由）。
        setup_command_timeout: setup_command の timeout 秒数（None なら無制限）。
    """

    version: Literal[3] = 3
    description: str | None = None
    links: list[WorktreeLinkItem] = Field(default_factory=list[WorktreeLinkItem])
    setup_command: str | None = None
    setup_command_timeout: int | None = None

    @field_validator("setup_command_timeout")
    @classmethod
    def _v_setup_command_timeout(cls, v: int | None) -> int | None:
        if v is not None and v <= 0:
            raise ValueError(f"setup_command_timeout は正の整数で指定してください: {v}")
        return v


# 設定操作関数


def load_config(path: Path | str) -> WorktreeConfig:
    """JSONファイルから WorktreeConfig を読み込み"""
    path = Path(path)
    if not path.exists():
        raise WorktreeConfigError(f"設定ファイルが見つかりません: {path}")

    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        raise WorktreeConfigError(f"JSONパースエラー: {path}: {e}") from e

    try:
        return WorktreeConfig.model_validate(data)
    except Exception as e:
        raise WorktreeConfigError(f"設定ファイルの検証に失敗しました: {path}: {e}") from e


def save_config(config: WorktreeConfig, path: Path | str) -> None:
    """WorktreeConfig を JSON ファイルに保存"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with path.open("w", encoding="utf-8") as f:
        json.dump(config.model_dump(exclude_none=True), f, indent=2, ensure_ascii=False)
        f.write("\n")


def find_config_file(cwd: Path | None = None) -> Path | None:
    """メインWTルートから設定ファイルを検索"""
    if cwd is None:
        cwd = Path.cwd()

    try:
        main_wt = find_main_worktree(cwd)
    except RuntimeError:
        return None

    config_path = main_wt / WORKTREE_CONFIG_FILENAME
    if config_path.exists():
        return config_path
    return None


def load_copy_exclude_spec(main_wt: Path) -> pathspec.GitIgnoreSpec:
    """メインWT配下の .worktreeignore を pathspec として読み込む

    ``.pecot/config/.worktreeignore`` を gitignore パターンとして解釈する。
    空行と ``#`` 行は pathspec が自動的にスキップする。

    不正な gitignore パターンは pathspec が silent ignore する。
    そのため、空行・コメント行を除いた有効行が 1 つ以上あるのに spec へパターンが 1 本も載らなかった場合は warning を出す。

    Args:
        main_wt: メインWTのパス

    Returns:
        PathSpec インスタンス

    Raises:
        WorktreeConfigError: ``.worktreeignore`` が存在しない場合
    """
    path = main_wt / WORKTREE_IGNORE_FILENAME
    if not path.exists():
        raise WorktreeConfigError(
            f"コピー除外設定が見つかりません: {WORKTREE_IGNORE_FILENAME}\n"
            "  pecot worktree init でテンプレートを生成してください。"
        )

    raw_lines = path.read_text(encoding="utf-8").splitlines()
    effective_lines = [
        line for line in raw_lines if line.strip() and not line.lstrip().startswith("#")
    ]
    spec = pathspec.GitIgnoreSpec.from_lines(raw_lines)

    # pathspec は `/` 単体や空白のみの行などを `regex=None` の pattern として
    # silent に取り込む。こういう「誰にもマッチしない」パターンしか残らなかったら
    # ユーザーの意図通りではない可能性が高いので warning を出す。
    matchable = [p for p in spec.patterns if getattr(p, "regex", None) is not None]
    if effective_lines and not matchable:
        logger.warning(
            "%s の全パターンが無効です (有効行 %d 本を silent ignore)。"
            " gitignore 構文を確認してください。",
            path,
            len(effective_lines),
        )

    return spec


def get_default_config(
    target_repo: str,
    self_repo: str | None = None,
) -> WorktreeConfig:
    """デフォルト設定テンプレートを生成

    Args:
        target_repo: 共有対象リポジトリ名（base 直下のリポ名。既定値は無く、必須）
        self_repo: 自リポジトリ名。指定すると hooks-config.json / projects/.active /
            .pecot/work の link（自リポの main WT を指す）が追加される。

    Returns:
        CLAUDE.local.md / .env / .claude/settings.local.json の 3 リンクを含むテンプレート。
        self_repo 指定時は hooks-config.json / projects/.active / .pecot/work のリンクも含む。
    """
    links = [
        WorktreeLinkItem(
            path="CLAUDE.local.md",
            target_repo=target_repo,
            target_path="CLAUDE.local.md",
            description="ローカル向け CLAUDE 指示（Git 管理外）",
        ),
        WorktreeLinkItem(
            path=".env",
            target_repo=target_repo,
            target_path=".env",
            description="環境変数（Git 管理外）",
        ),
        WorktreeLinkItem(
            path=".claude/settings.local.json",
            target_repo=target_repo,
            target_path=".claude/settings.local.json",
            description="Claude Code のローカル設定",
        ),
    ]
    if self_repo is not None:
        links.append(
            WorktreeLinkItem(
                path=HOOKS_CONFIG_FILENAME,
                target_repo=self_repo,
                target_path=HOOKS_CONFIG_FILENAME,
                description="pecot hooks 有効/無効設定（main WT と共有）",
            )
        )
        links.append(
            WorktreeLinkItem(
                path=ACTIVE_PROJECT_FILENAME,
                target_repo=self_repo,
                target_path=ACTIVE_PROJECT_FILENAME,
                description="active project ポインタ（main WT と共有）",
            )
        )
        links.append(
            WorktreeLinkItem(
                path=WORK_DIR,
                target_repo=self_repo,
                target_path=WORK_DIR,
                description=f"作業ファイル置き場（main WT の {WORK_DIR} を共有）",
            )
        )
    return WorktreeConfig(
        version=3,
        description=(
            "wtN/<repo> から base/<target_repo>/<target_path> への相対 symlink 設定。"
            " target_repo は WT 間で共有したいファイルを置くメインリポ名に置換し、"
            " 不要な link は削除してください。"
        ),
        links=links,
    )


# Symlink 生成


def _compute_relative_target(
    link: WorktreeLinkItem,
) -> str:
    """link から symlink 相対ターゲット文字列を計算

    symlink の配置先は ``<root>/<set>/<repo>/<path>``。その親ディレクトリから
    ``<root>`` まで遡る段数は ``len(Path(path).parts) - 1 + 2`` で求める。
    （+2 は ``<set>/<repo>/`` 分）。
    """
    depth = len(Path(link.path).parts) - 1 + 2
    prefix = "../" * depth
    return f"{prefix}base/{link.target_repo}/{link.target_path}"


def _resolve_absolute_target(project_root: Path, link: WorktreeLinkItem) -> Path:
    return project_root / "base" / link.target_repo / link.target_path


def _is_tracked_in_repo(repo_root: Path, rel_path: str) -> bool:
    """repo_root のリポジトリで rel_path が tracked かどうかを判定する。

    `git ls-files -- <path>` の出力が非空なら tracked。対象がディレクトリでも
    配下の tracked file 一覧が返るので、ファイル／ディレクトリのどちらでも拾える。
    .git 不在・git CLI 不在・cwd 不在などの異常系は False（ガード無し）に倒す。
    """
    try:
        result = run_git(["ls-files", "--", rel_path], repo_root, check=False)
    except OSError:
        return False
    if result.returncode != 0:
        return False
    return bool(result.stdout.strip())


def _process_link(
    link: WorktreeLinkItem,
    project_root: Path,
    set_name: str,
    repo_name: str,
    overwrite_strategy: Callable[[Path, Path], bool],
) -> SymlinkResult:
    """1 本の link 定義を実際のファイルシステム操作に変換する

    Args:
        link: リンク定義。
        project_root: プロジェクトルート。
        set_name: WT セット名。
        repo_name: wt 側リポジトリのディレクトリ名。
        overwrite_strategy: リアルファイル／ディレクトリが配置先に存在する時の
            上書き可否判定。``(symlink_path, target_abs_path) -> bool``。
            既存 symlink は常に張り替えるので呼ばれない。
    """
    symlink_path = project_root / set_name / repo_name / link.path
    abs_target = _resolve_absolute_target(project_root, link)
    rel_target = _compute_relative_target(link)

    if not abs_target.exists():
        if abs_target.is_symlink():
            logger.warning("ターゲットが dangling symlink です: %s", abs_target)
            return SymlinkResult(
                symlink_path=symlink_path,
                target_path=abs_target,
                action="skipped",
                message=f"ターゲットが dangling symlink です: {abs_target}",
            )
        logger.warning("ターゲットが存在しません: %s", abs_target)
        return SymlinkResult(
            symlink_path=symlink_path,
            target_path=abs_target,
            action="skipped",
            message=f"ターゲットが存在しません: {abs_target}",
        )

    try:
        symlink_path.parent.mkdir(parents=True, exist_ok=True)

        if symlink_path.is_symlink():
            symlink_path.unlink()
        elif symlink_path.exists():
            repo_root = project_root / set_name / repo_name
            if _is_tracked_in_repo(repo_root, link.path):
                logger.error("git 管理対象のため symlink 作成をスキップ: %s", symlink_path)
                return SymlinkResult(
                    symlink_path=symlink_path,
                    target_path=abs_target,
                    action="error",
                    message=f"git 管理対象のため symlink 作成を中止: {link.path}",
                )
            if not overwrite_strategy(symlink_path, abs_target):
                return SymlinkResult(
                    symlink_path=symlink_path,
                    target_path=abs_target,
                    action="skipped",
                    message=f"リアルファイルが存在します: {symlink_path}",
                )
            if symlink_path.is_dir():
                shutil.rmtree(symlink_path)
            else:
                symlink_path.unlink()

        symlink_path.symlink_to(rel_target)
        return SymlinkResult(
            symlink_path=symlink_path,
            target_path=abs_target,
            action="created",
        )
    except OSError as e:
        logger.error(
            "シンボリックリンク作成失敗: %s -> %s: %s",
            symlink_path,
            rel_target,
            e,
        )
        return SymlinkResult(
            symlink_path=symlink_path,
            target_path=abs_target,
            action="error",
            message=str(e),
        )


# .pecot/.gitignore の生成スクリプト。中身の本体は hook 側に置き、CLI は複製せずに呼ぶ。
_PECOT_GITIGNORE_ENSURE_REL = Path("hooks") / "lib" / "core" / "pecot-gitignore-ensure.sh"


def _pecot_gitignore_ensure_script() -> Path:
    """生成スクリプトのパスを返す。

    導入先の CLI は非 editable の venv に入るため、``__file__`` はプラグイン外を指す。
    bin/pecot が export する ``CLAUDE_PLUGIN_ROOT`` が指定されていれば、その配下の候補を返す。
    スクリプトの有無は問わない（無ければ呼び出し側の警告に、見当違いでない候補パスが出る）。
    未指定（ソースツリーで直接動かす）ときだけ ``__file__`` 相対
    （``plugins/pecot-workflow/cli/core`` の 2 つ上）を返す。
    """
    root = os.environ.get("CLAUDE_PLUGIN_ROOT", "").strip()
    if root:
        return Path(root) / _PECOT_GITIGNORE_ENSURE_REL
    return Path(__file__).resolve().parents[2] / _PECOT_GITIGNORE_ENSURE_REL


def _ensure_pecot_gitignore(config: WorktreeConfig, wt_root: Path) -> None:
    """``.pecot/`` 配下へ link を張る前に、WT の ``.pecot/.gitignore`` を用意する (#1219)

    link 先の symlink（hooks-config.json・projects/・work 等）は ``.pecot/.gitignore`` が ignore する前提。
    ただしこのファイルを作るのは Claude Code の hook だけ。
    既定の ``.worktreeignore`` は ``.pecot/`` をコピー対象から外す。
    そのため WT を作った直後は symlink が未追跡として出る。
    symlink にした ``.gitignore`` は git が読まないので実ファイルで置く。

    生成に失敗しても link 作成は続ける（未追跡が見えるだけで、作業は妨げない）。
    """
    if not any(link.path.startswith(f"{PECOT_DIR}/") for link in config.links):
        return
    script = _pecot_gitignore_ensure_script()
    if not script.is_file():
        logger.warning(
            "%s の生成スクリプトが見つかりません: %s",
            PECOT_GITIGNORE_FILENAME,
            script,
        )
        return
    result = subprocess.run(
        ["bash", str(script)],
        env={**os.environ, "CLAUDE_PROJECT_DIR": str(wt_root)},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        logger.warning(
            "%s を生成できませんでした: %s", PECOT_GITIGNORE_FILENAME, result.stderr.strip()
        )


def create_symlinks(
    config: WorktreeConfig,
    project_root: Path,
    set_name: str,
    repo_name: str,
) -> list[SymlinkResult]:
    """シンボリックリンクを作成（既存ファイル/ディレクトリは常に上書き）

    Args:
        config: 設定
        project_root: プロジェクトルート
        set_name: WTセット名（例: "wt1"）
        repo_name: wt 側リポジトリのディレクトリ名

    Returns:
        SymlinkResult のリスト
    """
    _ensure_pecot_gitignore(config, project_root / set_name / repo_name)
    return [
        _process_link(
            link, project_root, set_name, repo_name, overwrite_strategy=lambda _p, _t: True
        )
        for link in config.links
    ]


def create_symlinks_safe(
    config: WorktreeConfig,
    project_root: Path,
    set_name: str,
    repo_name: str,
    force: bool = False,
    confirm_callback: Callable[[Path, Path], bool] | None = None,
) -> list[SymlinkResult]:
    """シンボリックリンクを安全に作成（既存ファイルの競合処理付き）

    create_symlinks と異なり、リアルファイル／ディレクトリが存在する場合に
    ``force`` または ``confirm_callback`` で上書き可否を制御する。
    """

    def strategy(symlink_path: Path, abs_target: Path) -> bool:
        if force:
            return True
        if confirm_callback is not None:
            return confirm_callback(symlink_path, abs_target)
        return False

    _ensure_pecot_gitignore(config, project_root / set_name / repo_name)
    return [
        _process_link(link, project_root, set_name, repo_name, overwrite_strategy=strategy)
        for link in config.links
    ]


# モジュールエクスポート

__all__ = [
    # Constants
    "DEFAULT_WORKTREEIGNORE_CONTENT",
    # Data classes
    "SymlinkResult",
    # Exceptions
    "WorktreeConfigError",
    # Models
    "WorktreeLinkItem",
    "WorktreeConfig",
    # Functions
    "load_config",
    "save_config",
    "find_config_file",
    "load_copy_exclude_spec",
    "get_default_config",
    "create_symlinks",
    "create_symlinks_safe",
]
