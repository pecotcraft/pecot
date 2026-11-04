"""core/paths.py - 作業リポジトリ基準のパス解決

``.pecot/`` 配下のパス定義の唯一の置き場。
get_project_root() で作業リポジトリのルートを解決し、一時ファイルの出力先を固定する。
"""

from __future__ import annotations

import os
from collections.abc import Callable, Generator
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from cli.core.errors import PecotError
from cli.core.git import git_toplevel

# プロジェクトルート基準の相対パス
PECOT_DIR = ".pecot"
# フック状態の保存先
STATE_DIR = f"{PECOT_DIR}/state"
# 人・エージェントの作業ファイル置き場（タスクID = Issue 番号単位）
WORK_DIR = f"{PECOT_DIR}/work"
# 設定ファイルの置き場
CONFIG_DIR = f"{PECOT_DIR}/config"
# CLI / hooks 専用の一時ファイル置き場
TMP_DIR = f"{PECOT_DIR}/tmp"
# CLI が生成する一時ファイルの出力先
OUTPUT_DIR = f"{TMP_DIR}/output"

# .pecot/ 配下の生成物を git 管理外にする ignore（hook と pecot worktree が生成）
PECOT_GITIGNORE_FILENAME = f"{PECOT_DIR}/.gitignore"

# ワークツリー設定（symlink / setup_command）
WORKTREE_CONFIG_FILENAME = f"{CONFIG_DIR}/worktree-config.json"
# ワークツリー作成時のコピー除外パターン（gitignore 形式）
WORKTREE_IGNORE_FILENAME = f"{CONFIG_DIR}/.worktreeignore"
# フック設定
HOOKS_CONFIG_FILENAME = f"{CONFIG_DIR}/hooks-config.json"
# アクティブなプロジェクト設定のポインタ
ACTIVE_PROJECT_FILENAME = f"{CONFIG_DIR}/projects/.active"


class ProjectRootNotFoundError(PecotError):
    """プロジェクトルートが見つからない場合の例外"""


class OutputPathReservationError(PecotError):
    """候補名を使い切っても出力パスを予約できなかった"""


def _session_work_owner() -> Path | None:
    """cwd がセッションの worktree の .pecot/work の実体配下なら、その worktree を返す

    セッション開始時の SessionStart hook が CLAUDE_ENV_FILE 経由で
    PECOT_SESSION_PROJECT_DIR に書いた値を起点にする。git は呼ばない。
    hooks の project-root.sh と同じ判定を使う。
    cwd の文字列が ``*/.pecot/work`` 系で、実体が起点の .pecot/work の実体配下にある。
    かつ途中に ``.git`` を持つディレクトリ（入れ子の git リポ）が無いときだけ対象にする。
    """
    session_dir = os.environ.get("PECOT_SESSION_PROJECT_DIR")
    if not session_dir:
        return None
    try:
        cwd = Path.cwd()
        work_real = (Path(session_dir) / WORK_DIR).resolve()
        cwd_real = cwd.resolve()
    except OSError:
        return None
    cwd_str = str(cwd)
    if not (cwd_str.endswith(f"/{WORK_DIR}") or f"/{WORK_DIR}/" in cwd_str):
        return None
    if cwd_real != work_real and work_real not in cwd_real.parents:
        return None
    for directory in (cwd_real, *cwd_real.parents):
        if directory == work_real:
            break
        if (directory / ".git").exists():
            return None
    return Path(session_dir).resolve()


def get_project_root() -> Path:
    """プロジェクトルートを取得

    1. CLAUDE_PROJECT_DIR 環境変数があれば使用する（テスト上書き用）。
    2. cwd が PECOT_SESSION_PROJECT_DIR の .pecot/work 配下（入れ子の git リポを除く）なら、その実体パス。
       worktree の .pecot/work は base への symlink で、そこでは git toplevel が base になる。
    3. なければ git rev-parse --show-toplevel で解決する（GIT_* 環境変数を除いて実行）。

    Returns:
        プロジェクトルートのPath

    Raises:
        ProjectRootNotFoundError: gitリポジトリ外で、環境変数も未設定の場合
    """
    env_root = os.environ.get("CLAUDE_PROJECT_DIR")
    if env_root:
        return Path(env_root)

    session_root = _session_work_owner()
    if session_root is not None:
        return session_root

    # git push 等のフック内では GIT_DIR 等が設定され、CWD の代わりに参照される。
    # そのため GIT_* を除いて CWD 基準で解決する
    git_root = git_toplevel(strip_git_env=True)
    if git_root is not None:
        return git_root

    raise ProjectRootNotFoundError(
        "プロジェクトルートが見つかりません。"
        "gitリポジトリ内で実行するか、CLAUDE_PROJECT_DIR環境変数を設定してください。"
    )


def get_output_dir() -> Path:
    """出力ディレクトリを取得（プロジェクトルート基準）

    Returns:
        出力ディレクトリのパス（{project_root}/.pecot/tmp/output）
    """
    return get_project_root() / OUTPUT_DIR


def reserve_output_path(
    output_dir: Path,
    name_for: Callable[[str], str],
    *,
    max_attempts: int = 60,
) -> Path:
    """output_dir 配下に空ファイルを排他作成して返す

    ``name_for`` には ``%Y%m%d-%H%M%S`` 形式の文字列 ts を渡し、返ってきた名前で
    ``output_dir`` 配下に排他作成する。既に同名が存在する場合は ts を 1 秒進めた
    候補で再試行する。

    ts は生成物の一意性と生成順の目安であり、実時刻の記録ではない。衝突が起きた
    分だけ実時刻より先に進む（進み幅は衝突件数分で有界、生成順は保存される）。

    Args:
        output_dir: 出力先ディレクトリ（存在しなければ親ごと作成する）
        name_for: ts から出力名を組み立てる関数
        max_attempts: 試行する候補名の数

    Returns:
        排他作成した空ファイルの ``output_dir`` 配下のパス

    Raises:
        OutputPathReservationError: max_attempts 個の候補すべてが既存だった場合
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    base = datetime.now()
    path = output_dir
    for offset in range(max_attempts):
        ts = (base + timedelta(seconds=offset)).strftime("%Y%m%d-%H%M%S")
        path = output_dir / name_for(ts)
        try:
            path.touch(exist_ok=False)
        except FileExistsError:
            continue
        return path
    raise OutputPathReservationError(
        f"出力パスを予約できませんでした（{max_attempts} 件の候補名がすべて使用済み。最後の候補: {path}）"
    )


@contextmanager
def reserved_output_path(
    output_dir: Path,
    name_for: Callable[[str], str],
    *,
    max_attempts: int = 60,
) -> Generator[Path, None, None]:
    """reserve_output_path で予約したパスを yield し、例外時は予約を撤去する

    予約（排他作成）から書き込みまでの間で異常終了しても、
    0 バイトのファイルを出力先へ残さない。
    with ブロックを正常に抜けた場合は何もしない。

    Args:
        output_dir: 出力先ディレクトリ（存在しなければ親ごと作成する）
        name_for: ts から出力名を組み立てる関数
        max_attempts: 試行する候補名の数

    Yields:
        排他作成した空ファイルの ``output_dir`` 配下のパス

    Raises:
        OutputPathReservationError: max_attempts 個の候補すべてが既存だった場合
    """
    path = reserve_output_path(output_dir, name_for, max_attempts=max_attempts)
    try:
        yield path
    except BaseException:
        path.unlink(missing_ok=True)
        raise
