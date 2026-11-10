"""core/changelog.py - CHANGELOG.md検証ロジック

このモジュールはCHANGELOG.mdのパース、検証、バージョン管理機能を提供する。
Keep a Changelog形式とセマンティックバージョニングに準拠する。
"""

from __future__ import annotations

import re
from pathlib import Path

from cli.core.errors import PecotError

# 例外クラス


class ChangelogError(PecotError):
    """CHANGELOG.md操作エラーの基底クラス"""

    pass


class InvalidVersionError(ChangelogError):
    """無効なバージョン形式

    セマンティックバージョニング形式（X.Y.Z）に準拠していない場合に発生する。
    """

    pass


class VersionNotFoundError(ChangelogError):
    """バージョンが見つからない

    CHANGELOG.mdにバージョン情報が存在しない場合に発生する。
    """

    pass


# セマンティックバージョニング

# セマンティックバージョニング正規表現（X.Y.Z形式。先頭に `v` は付けない）
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


def validate_semver(version: str) -> None:
    """セマンティックバージョニング形式を検証

    Args:
        version: バージョン文字列（例: 1.2.3）

    Raises:
        InvalidVersionError: 無効なバージョン形式の場合

    Examples:
        >>> validate_semver("1.2.3")  # OK

        >>> validate_semver("v1.2.3")  # NG: vプレフィックス禁止
        Traceback (most recent call last):
        ...
        InvalidVersionError: 無効なバージョン形式: v1.2.3

        >>> validate_semver("1.2")  # NG: X.Y.Z形式が必須
        Traceback (most recent call last):
        ...
        InvalidVersionError: 無効なバージョン形式: 1.2
    """
    if not SEMVER_PATTERN.match(version):
        raise InvalidVersionError(
            f"invalid version format: {version}\nuse semantic versioning (X.Y.Z)"
        )


# CHANGELOGパス解決

DEFAULT_CHANGELOG_FILE = "CHANGELOG.md"
CHANGELOG_FALLBACK_FILES = ["CHANGELOG.md", "AIST-CHANGELOG.md"]


def resolve_changelog_path(git_root: Path, changelog_file: str | None = None) -> Path:
    """CHANGELOGファイルのパスを解決

    解決順序:
    1. changelog_file が明示指定 → それを使用する。
    2. フォールバック: CHANGELOG.md → AIST-CHANGELOG.md の順に存在確認する。
    3. どれもなし → CHANGELOG.md を返す（呼び出し側でFileNotFoundError）

    Args:
        git_root: gitリポジトリのルートディレクトリ
        changelog_file: 明示指定のCHANGELOGファイル名（Noneでフォールバック）

    Returns:
        CHANGELOGファイルの絶対パス（存在しない場合もパスのみ返却）
    """
    if changelog_file:
        return git_root / changelog_file

    for candidate in CHANGELOG_FALLBACK_FILES:
        path = git_root / candidate
        if path.exists():
            return path

    return git_root / DEFAULT_CHANGELOG_FILE


# CHANGELOG.md パース

# バージョン行の正規表現: ## [X.Y.Z] - YYYY-MM-DD
VERSION_LINE_PATTERN = re.compile(r"^##\s+\[(\d+\.\d+\.\d+)\]")


def get_latest_version(changelog_path: Path) -> str:
    """CHANGELOG.mdから最新バージョンを取得

    ## [X.Y.Z] 形式の最初のバージョンを返す。
    Unreleasedセクションはスキップする。

    Args:
        changelog_path: CHANGELOG.mdのパス

    Returns:
        最新バージョン（例: 0.3.1）

    Raises:
        VersionNotFoundError: バージョンが見つからない場合

    Examples:
        CHANGELOG.md:
        ```
        ## [Unreleased]

        ## [0.3.1] - 2026-01-19
        ## [0.3.0] - 2026-01-18
        ```
        >>> get_latest_version(Path("CHANGELOG.md"))
        '0.3.1'
    """
    if not changelog_path.exists():
        raise FileNotFoundError(f"CHANGELOG.md not found: {changelog_path}")

    content = changelog_path.read_text(encoding="utf-8")

    for line in content.splitlines():
        match = VERSION_LINE_PATTERN.match(line)
        if match:
            return match.group(1)

    raise VersionNotFoundError(
        "no version found in CHANGELOG.md\nfor a first release, specify the version manually"
    )


def extract_version_release_notes(changelog_path: Path, version: str) -> str:
    """指定バージョンのリリースノートを抽出

    ## [X.Y.Z] の次の行から次の ## セクションまでの内容を返す。

    Args:
        changelog_path: CHANGELOG.mdのパス
        version: バージョン文字列（例: 0.6.1）

    Returns:
        リリースノートの内容

    Raises:
        FileNotFoundError: CHANGELOG.mdが見つからない場合。
        VersionNotFoundError: 指定バージョンが見つからない場合。

    Examples:
        CHANGELOG.md:
        ```
        ## [0.6.1] - 2026-02-20

        ### 追加

        - 新機能A

        ## [0.6.0] - 2026-02-15
        ```

        >>> extract_version_release_notes(Path("CHANGELOG.md"), "0.6.1")
        '### 追加\\n\\n- 新機能A'
    """
    if not changelog_path.exists():
        raise FileNotFoundError(f"CHANGELOG.md not found: {changelog_path}")

    content = changelog_path.read_text(encoding="utf-8")
    lines = content.splitlines()

    version_pattern = re.compile(rf"^##\s+\[{re.escape(version)}\]")
    in_version = False
    version_lines: list[str] = []

    for line in lines:
        if version_pattern.match(line):
            in_version = True
            continue

        if in_version:
            # 次の ## セクションが来たら終了
            if line.startswith("## "):
                break
            version_lines.append(line)

    if not in_version:
        raise VersionNotFoundError(f"version not found in CHANGELOG.md: {version}")

    return "\n".join(version_lines).strip()
