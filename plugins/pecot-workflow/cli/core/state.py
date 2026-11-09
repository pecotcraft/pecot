"""core/state.py - フック状態管理のコア機能

スキルディレクトリ内にフラグファイルを保存・管理する。
"""

from __future__ import annotations

import re
from pathlib import Path

from cli.core.paths import (
    STATE_DIR,
    WORK_DIR,
    ProjectRootNotFoundError,
    get_project_root,
)

# フラグファイル名の定数
FLAG_PECOT_ACTIVE = ".pecot-active"
# セッション名（hooks の session-title.sh が Claude Code の sessionTitle に流す）。
# .pecot-active と同じタイミングで write_work_target が書く
FLAG_PECOT_SESSION_TITLE = ".pecot-session-title"
FLAG_PECOT_QUICK_MODE = ".pecot-quick-mode"
# auto-push が wip/ へ push して紐づけ済みであることを示す。
# 設置は hooks の auto-push.sh。pecot pr merge の後片付けで削除する
FLAG_WIP_BRANCH_LINKED = ".wip-branch-linked"

# スラッシュコマンド起点の外部反映免除フラグ。
# 設置は hooks の create-slash-flag.sh、確認は external-post-check.sh。
# CLI が実投稿成功時に削除する。
FLAG_PR_CREATE_SLASH_PENDING = "pr-create-slash-pending"
FLAG_ISSUE_CREATE_SLASH_PENDING = "issue-create-slash-pending"

# 起票未完了のリマインド用フラグ。
# 設置は hooks の pecot-issue-pending-state.sh と pecot-skill-reminder.sh。
# 確認は pecot-issue-pending-reminder.sh。
# CLI が起票成功時に削除する。
FLAG_ISSUE_PENDING = "issue-pending"


def get_state_dir(*, create: bool = False) -> Path:
    """状態ディレクトリのパスを取得

    Args:
        create: Trueの場合、ディレクトリが存在しなければ作成

    Returns:
        状態ディレクトリのPath
    """
    project_root = get_project_root()
    state_dir = project_root / STATE_DIR

    if create and not state_dir.exists():
        state_dir.mkdir(parents=True, exist_ok=True)

    return state_dir


def ensure_work_dir(issue_ref: str) -> Path | None:
    """作業ディレクトリ .pecot/work/<Issue番号>/ を作成して返す

    .pecot-active へ作業対象を記録するタイミング（create-branch / issue quick / session restore）で呼ぶ。
    エージェントへの「作業ファイル置き場」案内に使う。

    Args:
        issue_ref: Issue 参照（"owner/repo/N" または "N"）

    Returns:
        作成した work ディレクトリの Path。作成できない場合は None
        （作業フロー自体は止めない）
    """
    number = issue_ref.rstrip("/").rsplit("/", 1)[-1]
    if not number.isdigit():
        return None
    try:
        work_dir = get_project_root() / WORK_DIR / number
        work_dir.mkdir(parents=True, exist_ok=True)
    except (ProjectRootNotFoundError, OSError):
        return None
    return work_dir


def touch_flag(flag_name: str) -> None:
    """フラグファイルを作成

    Args:
        flag_name: フラグファイル名（例: ".pecot-active"）
    """
    state_dir = get_state_dir(create=True)
    flag_file = state_dir / flag_name
    flag_file.touch()


def remove_flag(flag_name: str) -> None:
    """フラグファイルを削除

    Args:
        flag_name: フラグファイル名

    Note:
        ファイルが存在しなくてもエラーにならない
    """
    state_dir = get_state_dir()
    flag_file = state_dir / flag_name
    flag_file.unlink(missing_ok=True)


def consume_flag(flag_name: str) -> None:
    """実投稿成功時にスラッシュコマンド免除フラグを消費（削除）する

    投稿自体は成功しているため、フラグ解決の失敗（git リポ外等）で
    コマンドを失敗させない。

    Args:
        flag_name: フラグファイル名
    """
    try:
        remove_flag(flag_name)
    except Exception:
        pass


def flag_exists(flag_name: str) -> bool:
    """フラグファイルの存在を確認

    Args:
        flag_name: フラグファイル名

    Returns:
        ファイルが存在すればTrue
    """
    state_dir = get_state_dir()
    flag_file = state_dir / flag_name
    return flag_file.is_file()


def write_flag(flag_name: str, content: str) -> None:
    """フラグファイルに内容を書き込み

    Args:
        flag_name: フラグファイル名
        content: 書き込む内容
    """
    state_dir = get_state_dir(create=True)
    flag_file = state_dir / flag_name
    flag_file.write_text(content)


SESSION_TITLE_MAX_CHARS = 40
_ISSUE_TYPE_PREFIX_RE = re.compile(r"^\[(?:Task|Bug|Epic)\]\s*")


def format_session_title(issue_number: int, title: str) -> str:
    """セッション名 `#<番号> <Issue タイトル>` を組み立てる

    先頭の種別接頭辞（`[Task]` 等）を落とし、全体を SESSION_TITLE_MAX_CHARS 文字で切る。
    タイトルが空なら `#<番号>` だけにする。
    """
    body = _ISSUE_TYPE_PREFIX_RE.sub("", title or "").strip()
    name = f"#{issue_number} {body}" if body else f"#{issue_number}"
    return name[:SESSION_TITLE_MAX_CHARS].rstrip()


def write_work_target(issue_ref: str, title: str) -> None:
    """作業対象を記録する（.pecot-active と .pecot-session-title を同時に書く）

    Args:
        issue_ref: Issue 参照（"owner/repo/N"）
        title: Issue タイトル。取得できなかったときは空文字

    Raises:
        ValueError: issue_ref の末尾が数字でないとき（何も書かない）
    """
    number = int(issue_ref.rstrip("/").rsplit("/", 1)[-1])
    write_flag(FLAG_PECOT_ACTIVE, issue_ref)
    write_flag(FLAG_PECOT_SESSION_TITLE, format_session_title(number, title))


def read_flag(flag_name: str) -> str | None:
    """フラグファイルの内容を読み取り

    Args:
        flag_name: フラグファイル名

    Returns:
        ファイル内容。存在しない場合はNone
    """
    state_dir = get_state_dir()
    flag_file = state_dir / flag_name
    if flag_file.is_file():
        return flag_file.read_text().strip()
    return None
