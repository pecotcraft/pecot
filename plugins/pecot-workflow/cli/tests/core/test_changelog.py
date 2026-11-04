"""tests/core/test_changelog.py - changelog.pyのユニットテスト

CHANGELOG.md検証ロジックと例外クラスのテスト。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from cli.core.changelog import (
    CHANGELOG_FALLBACK_FILES,
    DEFAULT_CHANGELOG_FILE,
    ChangelogError,
    InvalidVersionError,
    VersionNotFoundError,
    extract_version_release_notes,
    get_latest_version,
    resolve_changelog_path,
    validate_semver,
)

# 例外クラステスト


class TestChangelogError:
    """ChangelogError例外のテスト"""

    def test_basic_error(self) -> None:
        """基本的なエラー"""
        error = ChangelogError("テストエラー")
        assert str(error) == "テストエラー"


class TestInvalidVersionError:
    """InvalidVersionError例外のテスト"""

    def test_inheritance(self) -> None:
        """ChangelogErrorを継承"""
        error = InvalidVersionError("無効なバージョン")
        assert isinstance(error, ChangelogError)


class TestVersionNotFoundError:
    """VersionNotFoundError例外のテスト"""

    def test_inheritance(self) -> None:
        """ChangelogErrorを継承"""
        error = VersionNotFoundError("バージョンが見つかりません")
        assert isinstance(error, ChangelogError)


# バージョン検証テスト


class TestValidateSemver:
    """validate_semver()のテスト"""

    def test_valid_versions(self) -> None:
        """有効なバージョン形式"""
        validate_semver("0.3.2")
        validate_semver("1.0.0")
        validate_semver("10.20.30")

    def test_invalid_versions(self) -> None:
        """無効なバージョン形式"""
        with pytest.raises(InvalidVersionError):
            validate_semver("v0.3.2")  # vプレフィックス禁止

        with pytest.raises(InvalidVersionError):
            validate_semver("0.3")  # X.Y形式はNG

        with pytest.raises(InvalidVersionError):
            validate_semver("abc")  # 文字列はNG

        with pytest.raises(InvalidVersionError):
            validate_semver("1.2.3.4")  # 4つはNG


# CHANGELOG.mdパーステスト


class TestGetLatestVersion:
    """get_latest_version()のテスト"""

    def test_get_latest_version(self, tmp_path: Path) -> None:
        """最新バージョンを取得"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(
            """# 変更履歴

## [Unreleased]

## [0.3.1] - 2026-01-19

### 追加

- 新機能

## [0.3.0] - 2026-01-18
""",
            encoding="utf-8",
        )

        version = get_latest_version(changelog)
        assert version == "0.3.1"

    def test_version_not_found(self, tmp_path: Path) -> None:
        """バージョンが見つからない"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(
            """# 変更履歴

## [Unreleased]

最初のリリース前
""",
            encoding="utf-8",
        )

        with pytest.raises(VersionNotFoundError):
            get_latest_version(changelog)

    def test_file_not_found(self, tmp_path: Path) -> None:
        """ファイルが存在しない"""
        changelog = tmp_path / "CHANGELOG.md"

        with pytest.raises(FileNotFoundError):
            get_latest_version(changelog)


# バージョン別リリースノート抽出テスト


class TestExtractVersionReleaseNotes:
    """extract_version_release_notes()のテスト"""

    def test_extract_existing_version(self, tmp_path: Path) -> None:
        """存在するバージョンのリリースノートを抽出"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(
            """# 変更履歴

## [Unreleased]

## [0.6.1] - 2026-02-20

### 追加

- 新機能A
- 新機能B

### 修正

- バグ修正

## [0.6.0] - 2026-02-15

### 追加

- 旧機能
""",
            encoding="utf-8",
        )

        content = extract_version_release_notes(changelog, "0.6.1")
        assert "### 追加" in content
        assert "- 新機能A" in content
        assert "- 新機能B" in content
        assert "### 修正" in content
        assert "- バグ修正" in content
        assert "## [0.6.0]" not in content
        assert "- 旧機能" not in content

    def test_extract_older_version(self, tmp_path: Path) -> None:
        """古いバージョンのリリースノートを抽出"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(
            """# 変更履歴

## [0.6.1] - 2026-02-20

### 追加

- 新機能

## [0.6.0] - 2026-02-15

### 追加

- 旧機能
""",
            encoding="utf-8",
        )

        content = extract_version_release_notes(changelog, "0.6.0")
        assert "- 旧機能" in content
        assert "- 新機能" not in content

    def test_version_not_found(self, tmp_path: Path) -> None:
        """存在しないバージョンでVersionNotFoundError"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(
            """# 変更履歴

## [0.6.0] - 2026-02-15

### 追加

- 機能
""",
            encoding="utf-8",
        )

        with pytest.raises(VersionNotFoundError, match="9.9.9"):
            extract_version_release_notes(changelog, "9.9.9")

    def test_empty_release_notes(self, tmp_path: Path) -> None:
        """空のリリースノート"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(
            """# 変更履歴

## [0.6.1] - 2026-02-20

## [0.6.0] - 2026-02-15
""",
            encoding="utf-8",
        )

        content = extract_version_release_notes(changelog, "0.6.1")
        assert content == ""

    def test_last_version_no_trailing_section(self, tmp_path: Path) -> None:
        """最後のバージョン（後続セクションなし）"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(
            """# 変更履歴

## [0.1.0] - 2026-01-01

### 追加

- 初回リリース
""",
            encoding="utf-8",
        )

        content = extract_version_release_notes(changelog, "0.1.0")
        assert "- 初回リリース" in content

    def test_file_not_found(self, tmp_path: Path) -> None:
        """ファイルが存在しない"""
        changelog = tmp_path / "CHANGELOG.md"

        with pytest.raises(FileNotFoundError):
            extract_version_release_notes(changelog, "0.6.1")


# CHANGELOGパス解決テスト


class TestResolveChangelogPath:
    """resolve_changelog_path()のテスト"""

    def test_explicit_changelog_file(self, tmp_path: Path) -> None:
        """明示指定のファイル名を使用"""
        result = resolve_changelog_path(tmp_path, "CUSTOM-CHANGELOG.md")
        assert result == tmp_path / "CUSTOM-CHANGELOG.md"

    def test_fallback_to_changelog_md(self, tmp_path: Path) -> None:
        """CHANGELOG.md存在時にそれを返す"""
        (tmp_path / "CHANGELOG.md").write_text("# Changelog\n")
        result = resolve_changelog_path(tmp_path)
        assert result == tmp_path / "CHANGELOG.md"

    def test_fallback_to_pecot_changelog(self, tmp_path: Path) -> None:
        """CHANGELOG.mdなし、AIST-CHANGELOG.md存在時"""
        (tmp_path / "AIST-CHANGELOG.md").write_text("# Changelog\n")
        result = resolve_changelog_path(tmp_path)
        assert result == tmp_path / "AIST-CHANGELOG.md"

    def test_both_exist_prefers_changelog_md(self, tmp_path: Path) -> None:
        """両方存在時はCHANGELOG.md優先"""
        (tmp_path / "CHANGELOG.md").write_text("# Changelog\n")
        (tmp_path / "AIST-CHANGELOG.md").write_text("# PECOT Changelog\n")
        result = resolve_changelog_path(tmp_path)
        assert result == tmp_path / "CHANGELOG.md"

    def test_none_found_returns_default(self, tmp_path: Path) -> None:
        """どちらもなし時はデフォルト返却"""
        result = resolve_changelog_path(tmp_path)
        assert result == tmp_path / DEFAULT_CHANGELOG_FILE

    def test_explicit_overrides_fallback(self, tmp_path: Path) -> None:
        """明示指定はフォールバックに優先"""
        (tmp_path / "CHANGELOG.md").write_text("# Changelog\n")
        result = resolve_changelog_path(tmp_path, "AIST-CHANGELOG.md")
        assert result == tmp_path / "AIST-CHANGELOG.md"

    def test_constants(self) -> None:
        """定数の値と整合性が正しい"""
        assert DEFAULT_CHANGELOG_FILE == "CHANGELOG.md"
        assert "CHANGELOG.md" in CHANGELOG_FALLBACK_FILES
        assert "AIST-CHANGELOG.md" in CHANGELOG_FALLBACK_FILES
        assert CHANGELOG_FALLBACK_FILES[0] == DEFAULT_CHANGELOG_FILE
        assert len(CHANGELOG_FALLBACK_FILES) == len(set(CHANGELOG_FALLBACK_FILES))
