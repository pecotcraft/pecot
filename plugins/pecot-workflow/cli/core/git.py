"""core/git.py - git コマンド実行の唯一の窓口

git の subprocess 呼び出しはすべて ``run_git`` を経由する。
値を返す helper（``git_toplevel`` 等）は失敗時に ``None`` を返す。

このモジュールは CLI 内の他モジュールのうち ``cli.core.git_url`` だけを import する。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from cli.core.git_url import parse_remote_url


def run_git(
    args: list[str],
    cwd: Path | None = None,
    *,
    check: bool,
    strip_git_env: bool = False,
) -> subprocess.CompletedProcess[str]:
    """git コマンドを実行する

    Args:
        args: git のサブコマンドと引数（先頭に ``"git"`` を含めない）。
        cwd: 作業ディレクトリ（加工せず subprocess に渡す）。
        check: True なら非 0 終了で ``CalledProcessError`` を送出する。
        strip_git_env: True なら ``GIT_*`` 環境変数を除いた環境で実行する。
            git フック内では ``GIT_DIR`` 等が設定されて CWD の代わりに参照される。
            CWD 基準で解決したいときに使う。

    Returns:
        ``capture_output=True, text=True`` で実行した結果

    Raises:
        subprocess.CalledProcessError: ``check=True`` で非 0 終了した場合
        FileNotFoundError: git が見つからない場合
    """
    env = (
        # interface-env: none
        {k: v for k, v in os.environ.items() if not k.startswith("GIT_")} if strip_git_env else None
    )
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=check,
        env=env,
    )


def git_toplevel(cwd: Path | None = None, *, strip_git_env: bool = False) -> Path | None:
    """git リポジトリ（ワークツリー）のルートを返す

    Args:
        cwd: 起点ディレクトリ（None なら CWD）
        strip_git_env: ``run_git`` の同名引数

    Returns:
        ルートの Path。git 外・git 不在なら None
    """
    try:
        result = run_git(
            ["rev-parse", "--show-toplevel"],
            cwd,
            check=True,
            strip_git_env=strip_git_env,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return Path(result.stdout.strip())


def git_remote_url(cwd: Path | None = None, remote: str = "origin") -> str | None:
    """remote の URL を返す

    Returns:
        URL（strip 済み）。remote 不在・git 外なら None
    """
    try:
        result = run_git(["remote", "get-url", remote], cwd, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return result.stdout.strip()


def git_current_branch(cwd: Path | None = None) -> str | None:
    """現在のブランチ名を返す

    Returns:
        ブランチ名（detached HEAD では ``"HEAD"``）。git 外なら None
    """
    try:
        result = run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return result.stdout.strip()


def origin_repo(cwd: Path | None = None) -> tuple[str, str, str] | None:
    """origin の URL から ``(host, owner, repo)`` を返す

    Returns:
        ``(host, owner, repo)``。origin 不在・git 外・URL 形式不一致なら None
    """
    url = git_remote_url(cwd)
    if url is None:
        return None
    try:
        return parse_remote_url(url)
    except ValueError:
        return None
