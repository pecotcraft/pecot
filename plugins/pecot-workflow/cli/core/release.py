"""core/release.py - リリース操作のコアロジック

リリース前チェック（preflight）のビジネスロジックを提供する。
CLI層（cli/release.py）から呼び出される。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from pydantic import BaseModel

from cli.core.changelog import (
    VersionNotFoundError,
    extract_version_release_notes,
    get_latest_version,
    validate_semver,
)
from cli.core.errors import PecotError
from cli.core.git import run_git

# 例外クラス


class ReleaseError(PecotError):
    """リリース操作エラーの基底クラス"""

    pass


# データモデル


class PreflightResult(BaseModel):
    """preflight チェック結果

    Attributes:
        version: リリースバージョン（例: "0.6.1"）。
        release_notes: CHANGELOG.mdから抽出したリリースノート。
        develop_branch: 開発ブランチ名。
        release_branch: リリースブランチ名。
        diff_count: develop→releaseの差分コミット数。
        tag_name: 作成予定のタグ名（例: "v0.6.1" または "pecot-workflow-v0.6.1"）。
    """

    version: str
    release_notes: str
    develop_branch: str
    release_branch: str
    diff_count: int
    tag_name: str


# ヘルパー関数


def _run_git(args: list[str], cwd: Path | None = None) -> str:
    """gitコマンドを実行して標準出力を返す

    Args:
        args: gitのサブコマンドと引数
        cwd: 作業ディレクトリ

    Returns:
        コマンドの標準出力（strip済み）

    Raises:
        ReleaseError: コマンド実行に失敗した場合
    """
    try:
        result = run_git(args, cwd, check=True)
    except subprocess.CalledProcessError as e:
        raise ReleaseError(f"git command failed: git {' '.join(args)}\n{e.stderr.strip()}") from e
    return result.stdout.strip()


# コアロジック


def run_preflight(
    changelog_path: Path,
    develop_branch: str,
    release_branch: str,
    version: str | None = None,
    cwd: Path | None = None,
    tag_prefix: str | None = None,
) -> PreflightResult:
    """リリース前チェックを実行

    以下を検証する:
    1. CHANGELOG.mdの存在
    2. バージョンの検出または検証
    3. タグが存在しないこと（ローカル+リモート）
    4. develop→releaseの差分確認
    5. リリースノートの抽出

    Args:
        changelog_path: CHANGELOG.mdのパス。
        develop_branch: 開発ブランチ名。
        release_branch: リリースブランチ名。
        version: リリースバージョン（Noneの場合はCHANGELOGから自動検出）。
        cwd: gitコマンドの作業ディレクトリ。
        tag_prefix: タグ prefix（monorepo 時に指定、None なら `v<ver>`、
            指定時は `<tag_prefix>-v<ver>`）。

    Returns:
        PreflightResult: チェック結果

    Raises:
        ReleaseError: チェックに失敗した場合
    """
    # 1. CHANGELOG.md の存在確認
    if not changelog_path.exists():
        raise ReleaseError(f"CHANGELOG.md not found: {changelog_path}")

    # 2. バージョンの決定
    if version is None:
        try:
            version = get_latest_version(changelog_path)
        except VersionNotFoundError as e:
            raise ReleaseError(str(e)) from e
    else:
        validate_semver(version)

    # 3. タグ不存在確認（ローカル）
    tag_name = f"{tag_prefix}-v{version}" if tag_prefix else f"v{version}"
    local_tags = _run_git(["tag", "-l", tag_name], cwd=cwd)
    if tag_name in local_tags.splitlines():
        raise ReleaseError(f"tag already exists locally: {tag_name}")

    # タグ不存在確認（リモート）
    try:
        remote_tags = _run_git(["ls-remote", "--tags", "origin", f"refs/tags/{tag_name}"], cwd=cwd)
        if remote_tags:
            raise ReleaseError(f"tag already exists on the remote: {tag_name}")
    except ReleaseError:
        # ls-remote自体が失敗した場合は再raise
        # ただし「タグが存在する」エラーはそのまま上げる
        raise

    # 4. ブランチ差分確認
    _run_git(["fetch", "origin", release_branch, develop_branch], cwd=cwd)

    diff_output = _run_git(
        ["rev-list", "--count", f"origin/{release_branch}..origin/{develop_branch}"],
        cwd=cwd,
    )
    diff_count = int(diff_output)

    if diff_count == 0:
        raise ReleaseError(
            f"no difference between origin/{release_branch} and origin/{develop_branch}: "
            "there is nothing to release"
        )

    # 5. リリースノート抽出
    try:
        release_notes = extract_version_release_notes(changelog_path, version)
    except VersionNotFoundError as e:
        raise ReleaseError(str(e)) from e

    return PreflightResult(
        version=version,
        release_notes=release_notes,
        develop_branch=develop_branch,
        release_branch=release_branch,
        diff_count=diff_count,
        tag_name=tag_name,
    )
