"""tests/core/test_release.py - release.pyのユニットテスト

ReleaseError, PreflightResult, run_preflight() のテスト。
gitコマンドはsubprocess.runをモックして検証する。
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from cli.core.release import (
    PreflightResult,
    ReleaseError,
    _run_git,
    run_preflight,
)

# 例外クラステスト


class TestReleaseError:
    """ReleaseError例外のテスト"""

    def test_basic_error(self) -> None:
        """基本的なエラー"""
        error = ReleaseError("テストエラー")
        assert str(error) == "テストエラー"

    def test_inheritance(self) -> None:
        """Exceptionを継承"""
        error = ReleaseError("テスト")
        assert isinstance(error, Exception)


# PreflightResult テスト


class TestPreflightResult:
    """PreflightResultモデルのテスト"""

    def test_create(self) -> None:
        """正常に作成できる"""
        result = PreflightResult(
            version="0.6.1",
            release_notes="### 追加\n\n- 新機能",
            develop_branch="develop-aist",
            release_branch="main",
            diff_count=5,
            tag_name="v0.6.1",
        )
        assert result.version == "0.6.1"
        assert result.release_notes == "### 追加\n\n- 新機能"
        assert result.develop_branch == "develop-aist"
        assert result.release_branch == "main"
        assert result.diff_count == 5
        assert result.tag_name == "v0.6.1"


# _run_git テスト


class TestRunGit:
    """_run_git() ヘルパーのテスト"""

    def test_success(self) -> None:
        """正常なgitコマンド実行"""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(stdout="output\n", returncode=0)
            result = _run_git(["status"])
            assert result == "output"
            mock_run.assert_called_once()

    def test_failure_raises_release_error(self) -> None:
        """コマンド失敗時にReleaseErrorを送出"""
        import subprocess

        with patch(
            "subprocess.run", side_effect=subprocess.CalledProcessError(1, "git", stderr="error")
        ):
            with pytest.raises(ReleaseError, match="git コマンド失敗"):
                _run_git(["invalid-command"])

    def test_cwd_passed(self) -> None:
        """cwdが正しく渡される"""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(stdout="", returncode=0)
            _run_git(["status"], cwd=Path("/tmp"))
            call_kwargs = mock_run.call_args[1]
            assert call_kwargs["cwd"] == Path("/tmp")


# run_preflight テスト


SAMPLE_CHANGELOG = """# 変更履歴

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
"""


class TestRunPreflight:
    """run_preflight()のテスト"""

    def test_success_with_version(self, tmp_path: Path) -> None:
        """バージョン指定での正常実行"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(SAMPLE_CHANGELOG, encoding="utf-8")

        with patch("cli.core.release._run_git") as mock_git:
            # tag -l: タグが存在しない
            # ls-remote: リモートタグなし
            # fetch: 成功
            # rev-list: 差分5件
            mock_git.side_effect = ["", "", "", "5"]

            result = run_preflight(
                changelog_path=changelog,
                develop_branch="develop-aist",
                release_branch="main",
                version="0.6.1",
                cwd=tmp_path,
            )

        assert result.version == "0.6.1"
        assert "新機能A" in result.release_notes
        assert result.develop_branch == "develop-aist"
        assert result.release_branch == "main"
        assert result.diff_count == 5

    def test_success_auto_detect_version(self, tmp_path: Path) -> None:
        """バージョン自動検出での正常実行"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(SAMPLE_CHANGELOG, encoding="utf-8")

        with patch("cli.core.release._run_git") as mock_git:
            mock_git.side_effect = ["", "", "", "3"]

            result = run_preflight(
                changelog_path=changelog,
                develop_branch="develop-aist",
                release_branch="main",
                version=None,
                cwd=tmp_path,
            )

        assert result.version == "0.6.1"

    def test_changelog_not_found(self, tmp_path: Path) -> None:
        """CHANGELOG.mdが存在しない"""
        changelog = tmp_path / "CHANGELOG.md"

        with pytest.raises(ReleaseError, match="CHANGELOG.mdが見つかりません"):
            run_preflight(
                changelog_path=changelog,
                develop_branch="develop-aist",
                release_branch="main",
                version="0.6.1",
            )

    def test_tag_already_exists_locally(self, tmp_path: Path) -> None:
        """ローカルタグが既に存在する"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(SAMPLE_CHANGELOG, encoding="utf-8")

        with patch("cli.core.release._run_git") as mock_git:
            mock_git.return_value = "v0.6.1"

            with pytest.raises(ReleaseError, match="ローカルに既に存在します"):
                run_preflight(
                    changelog_path=changelog,
                    develop_branch="develop-aist",
                    release_branch="main",
                    version="0.6.1",
                    cwd=tmp_path,
                )

    def test_tag_already_exists_remotely(self, tmp_path: Path) -> None:
        """リモートタグが既に存在する"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(SAMPLE_CHANGELOG, encoding="utf-8")

        with patch("cli.core.release._run_git") as mock_git:
            # tag -l: ローカルタグなし
            # ls-remote: リモートタグあり
            mock_git.side_effect = ["", "abc123\trefs/tags/v0.6.1"]

            with pytest.raises(ReleaseError, match="リモートに既に存在します"):
                run_preflight(
                    changelog_path=changelog,
                    develop_branch="develop-aist",
                    release_branch="main",
                    version="0.6.1",
                    cwd=tmp_path,
                )

    def test_no_diff(self, tmp_path: Path) -> None:
        """ブランチ間に差分がない"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(SAMPLE_CHANGELOG, encoding="utf-8")

        with patch("cli.core.release._run_git") as mock_git:
            mock_git.side_effect = ["", "", "", "0"]

            with pytest.raises(ReleaseError, match="差分がありません"):
                run_preflight(
                    changelog_path=changelog,
                    develop_branch="develop-aist",
                    release_branch="main",
                    version="0.6.1",
                    cwd=tmp_path,
                )

    def test_tag_name_without_prefix(self, tmp_path: Path) -> None:
        """tag_prefix=None の場合、tag_name は v<ver> 形式になる"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(SAMPLE_CHANGELOG, encoding="utf-8")

        with patch("cli.core.release._run_git") as mock_git:
            mock_git.side_effect = ["", "", "", "5"]

            result = run_preflight(
                changelog_path=changelog,
                develop_branch="develop-aist",
                release_branch="main",
                version="0.6.1",
                cwd=tmp_path,
            )

        assert result.tag_name == "v0.6.1"

    def test_tag_name_with_prefix(self, tmp_path: Path) -> None:
        """tag_prefix 指定時、tag_name は <prefix>-v<ver> 形式になる

        ローカル・リモートのタグ検索も prefix 付きタグ名で実行されること。
        """
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(SAMPLE_CHANGELOG, encoding="utf-8")

        with patch("cli.core.release._run_git") as mock_git:
            mock_git.side_effect = ["", "", "", "5"]

            result = run_preflight(
                changelog_path=changelog,
                develop_branch="develop-aist",
                release_branch="main",
                version="0.6.1",
                cwd=tmp_path,
                tag_prefix="pecot-workflow",
            )

        assert result.tag_name == "pecot-workflow-v0.6.1"
        first_call_args = mock_git.call_args_list[0][0][0]
        assert "pecot-workflow-v0.6.1" in first_call_args
        second_call_args = mock_git.call_args_list[1][0][0]
        assert "refs/tags/pecot-workflow-v0.6.1" in second_call_args

    def test_version_not_in_changelog(self, tmp_path: Path) -> None:
        """指定バージョンがCHANGELOGに存在しない"""
        changelog = tmp_path / "CHANGELOG.md"
        changelog.write_text(SAMPLE_CHANGELOG, encoding="utf-8")

        with patch("cli.core.release._run_git") as mock_git:
            mock_git.side_effect = ["", "", "", "5"]

            with pytest.raises(ReleaseError, match="見つかりません"):
                run_preflight(
                    changelog_path=changelog,
                    develop_branch="develop-aist",
                    release_branch="main",
                    version="9.9.9",
                    cwd=tmp_path,
                )
