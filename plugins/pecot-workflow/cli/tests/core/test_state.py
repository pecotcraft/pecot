"""tests/core/test_state.py - 状態管理コア機能のテスト"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from ub_test_reports.pytest_plugin import add_test_properties


class TestGetStateDir:
    """get_state_dir関数のテスト"""

    def test_returns_state_dir_path(self, tmp_path: Path) -> None:
        """状態ディレクトリのパスを返す"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import get_state_dir

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            result = get_state_dir()
            expected = tmp_path / STATE_DIR
            assert result == expected

    def test_creates_dir_if_not_exists(self, tmp_path: Path) -> None:
        """ディレクトリが存在しなければ作成"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import get_state_dir

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            state_dir = tmp_path / STATE_DIR
            assert not state_dir.exists()

            result = get_state_dir(create=True)

            assert result == state_dir
            assert state_dir.exists()


class TestTouchFlag:
    """touch_flag関数のテスト"""

    def test_creates_flag_file(self, tmp_path: Path) -> None:
        """フラグファイルを作成"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import touch_flag

        state_dir = tmp_path / STATE_DIR
        state_dir.mkdir(parents=True)

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            touch_flag(".test-flag")

            flag_file = state_dir / ".test-flag"
            assert flag_file.exists()

    def test_creates_state_dir_if_not_exists(self, tmp_path: Path) -> None:
        """状態ディレクトリがなければ作成"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import touch_flag

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            state_dir = tmp_path / STATE_DIR
            assert not state_dir.exists()

            touch_flag(".test-flag")

            assert state_dir.exists()
            assert (state_dir / ".test-flag").exists()


class TestRemoveFlag:
    """remove_flag関数のテスト"""

    def test_removes_flag_file(self, tmp_path: Path) -> None:
        """フラグファイルを削除"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import remove_flag

        state_dir = tmp_path / STATE_DIR
        state_dir.mkdir(parents=True)
        flag_file = state_dir / ".test-flag"
        flag_file.touch()

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            remove_flag(".test-flag")

            assert not flag_file.exists()

    def test_no_error_when_file_not_exists(self, tmp_path: Path) -> None:
        """存在しないファイルでもエラーにならない"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import remove_flag

        state_dir = tmp_path / STATE_DIR
        state_dir.mkdir(parents=True)

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            # エラーが発生しないことを確認
            remove_flag(".nonexistent-flag")


class TestFlagExists:
    """flag_exists関数のテスト"""

    def test_returns_true_when_exists(self, tmp_path: Path) -> None:
        """ファイルが存在すればTrue"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import flag_exists

        state_dir = tmp_path / STATE_DIR
        state_dir.mkdir(parents=True)
        (state_dir / ".test-flag").touch()

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            assert flag_exists(".test-flag") is True

    def test_returns_false_when_not_exists(self, tmp_path: Path) -> None:
        """ファイルが存在しなければFalse"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import flag_exists

        state_dir = tmp_path / STATE_DIR
        state_dir.mkdir(parents=True)

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            assert flag_exists(".nonexistent-flag") is False

    def test_returns_false_when_state_dir_not_exists(self, tmp_path: Path) -> None:
        """状態ディレクトリがなければFalse"""
        from cli.core.state import flag_exists

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            assert flag_exists(".test-flag") is False


class TestEnsureWorkDir:
    """ensure_work_dir関数のテスト"""

    @add_test_properties(
        verifies=["PW-ISSUE-QUICK-09", "PW-ISSUE-QUICK-11", "PW-SESSION-RESTORE-06"]
    )
    def test_creates_work_dir_from_full_ref(self, tmp_path: Path) -> None:
        """owner/repo/N 形式から .pecot/work/N/ を作成して返す"""
        from cli.core.state import ensure_work_dir

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            result = ensure_work_dir("acme-labs/aist-plugin/655")

        assert result == tmp_path / ".pecot" / "work" / "655"
        assert result.is_dir()

    def test_creates_work_dir_from_number_only(self, tmp_path: Path) -> None:
        """番号のみの参照でも作成できる"""
        from cli.core.state import ensure_work_dir

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            result = ensure_work_dir("42")

        assert result == tmp_path / ".pecot" / "work" / "42"
        assert result.is_dir()

    def test_idempotent_when_dir_exists(self, tmp_path: Path) -> None:
        """既存ディレクトリでもエラーにならない"""
        from cli.core.state import ensure_work_dir

        (tmp_path / ".pecot" / "work" / "655").mkdir(parents=True)
        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            result = ensure_work_dir("acme-labs/aist-plugin/655")

        assert result is not None
        assert result.is_dir()

    def test_returns_none_for_non_numeric_ref(self, tmp_path: Path) -> None:
        """末尾が Issue 番号でない参照は None（ディレクトリも作らない）"""
        from cli.core.state import ensure_work_dir

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            assert ensure_work_dir("not-a-ref") is None
        assert not (tmp_path / ".pecot" / "work").exists()

    def test_returns_none_when_project_root_not_found(self) -> None:
        """プロジェクトルート不明でも例外を投げず None"""
        from cli.core.paths import ProjectRootNotFoundError
        from cli.core.state import ensure_work_dir

        with patch(
            "cli.core.state.get_project_root",
            side_effect=ProjectRootNotFoundError("not found"),
        ):
            assert ensure_work_dir("acme-labs/aist-plugin/655") is None


class TestFormatSessionTitle:
    """format_session_title 関数のテスト（Claude Code のセッション名）"""

    @add_test_properties(verifies=["PW-SESSION-RESTORE-05"])
    def test_strips_issue_type_prefix(self) -> None:
        """先頭の種別接頭辞 [Task] を落として `#<番号> <タイトル>` にする"""
        from cli.core.state import format_session_title

        assert format_session_title(12, "[Task] 題名") == "#12 題名"

    @add_test_properties(verifies=["PW-SESSION-RESTORE-04"])
    def test_truncates_to_40_chars(self) -> None:
        """全体を 40 文字で切る（末尾の空白は落とす）"""
        from cli.core.state import SESSION_TITLE_MAX_CHARS, format_session_title

        title = "あ" * 50
        result = format_session_title(1253, title)
        assert result == "#1253 " + "あ" * (SESSION_TITLE_MAX_CHARS - len("#1253 "))
        assert len(result) == SESSION_TITLE_MAX_CHARS

    def test_does_not_truncate_exactly_40_chars(self) -> None:
        """ちょうど 40 文字なら切らない"""
        from cli.core.state import SESSION_TITLE_MAX_CHARS, format_session_title

        title = "あ" * (SESSION_TITLE_MAX_CHARS - len("#1253 "))
        result = format_session_title(1253, title)
        assert result == f"#1253 {title}"
        assert len(result) == SESSION_TITLE_MAX_CHARS

    def test_drops_trailing_space_at_cut_position(self) -> None:
        """切った位置が空白なら末尾の空白を落とす"""
        from cli.core.state import format_session_title

        # "#1253 " + "あ"*33 + " " でちょうど 40 文字目が空白
        result = format_session_title(1253, "あ" * 33 + " " + "い" * 10)
        assert result == "#1253 " + "あ" * 33

    def test_keeps_non_issue_type_bracket_prefix(self) -> None:
        """[Task]/[Bug]/[Epic] 以外の先頭の [...] は意味のある接頭辞として残す"""
        from cli.core.state import format_session_title

        assert format_session_title(9, "[pecot-visual] 修正") == "#9 [pecot-visual] 修正"
        assert format_session_title(9, "[Epic] 親") == "#9 親"

    def test_number_only_when_title_empty(self) -> None:
        """タイトルが空・接頭辞だけなら番号だけにする"""
        from cli.core.state import format_session_title

        assert format_session_title(7, "") == "#7"
        assert format_session_title(7, "[Bug]   ") == "#7"


class TestWriteWorkTarget:
    """write_work_target 関数のテスト"""

    @add_test_properties(
        verifies=["PW-CREATE-BRANCH-08", "PW-SESSION-RESTORE-03", "PW-SESSION-RESTORE-04"]
    )
    def test_writes_active_and_session_title(self, tmp_path: Path) -> None:
        """.pecot-active と .pecot-session-title を同時に書く"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import (
            FLAG_PECOT_ACTIVE,
            FLAG_PECOT_SESSION_TITLE,
            write_work_target,
        )

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            write_work_target("acme-labs/aist-plugin/1253", "[Task] 題名")

        state_dir = tmp_path / STATE_DIR
        assert (state_dir / FLAG_PECOT_ACTIVE).read_text() == "acme-labs/aist-plugin/1253"
        assert (state_dir / FLAG_PECOT_SESSION_TITLE).read_text() == "#1253 題名"

    @add_test_properties(verifies=["PW-SESSION-RESTORE-09"])
    def test_session_title_number_only_without_title(self, tmp_path: Path) -> None:
        """タイトルが取れなかったときは番号だけのセッション名を書く"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import FLAG_PECOT_SESSION_TITLE, write_work_target

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            write_work_target("owner/repo/5", "")

        assert (tmp_path / STATE_DIR / FLAG_PECOT_SESSION_TITLE).read_text() == "#5"

    @add_test_properties(verifies=["PW-SESSION-RESTORE-07"])
    def test_second_write_overwrites_first(self, tmp_path: Path) -> None:
        """続けて 2 回書くと、.pecot-active と .pecot-session-title は 2 回目の値になる"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import (
            FLAG_PECOT_ACTIVE,
            FLAG_PECOT_SESSION_TITLE,
            write_work_target,
        )

        with patch("cli.core.state.get_project_root", return_value=tmp_path):
            write_work_target("acme-labs/aist-plugin/1", "[Task] 最初")
            write_work_target("acme-labs/aist-plugin/2", "[Task] 次")

        state_dir = tmp_path / STATE_DIR
        assert (state_dir / FLAG_PECOT_ACTIVE).read_text() == "acme-labs/aist-plugin/2"
        assert (state_dir / FLAG_PECOT_SESSION_TITLE).read_text() == "#2 次"

    def test_non_numeric_ref_writes_nothing(self, tmp_path: Path) -> None:
        """番号が数字でない参照は ValueError で止まり、どのフラグも書かない"""
        from cli.core.paths import STATE_DIR
        from cli.core.state import write_work_target

        with (
            patch("cli.core.state.get_project_root", return_value=tmp_path),
            pytest.raises(ValueError),
        ):
            write_work_target("owner/repo/abc", "題名")

        state_dir = tmp_path / STATE_DIR
        assert not state_dir.exists() or not list(state_dir.iterdir())
