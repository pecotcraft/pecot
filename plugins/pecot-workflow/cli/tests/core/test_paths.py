"""tests/core/test_paths.py - パス解決のテスト"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from cli.core.paths import (
    ACTIVE_PROJECT_FILENAME,
    CONFIG_DIR,
    HOOKS_CONFIG_FILENAME,
    OUTPUT_DIR,
    PECOT_DIR,
    STATE_DIR,
    WORK_DIR,
    WORKTREE_CONFIG_FILENAME,
    WORKTREE_IGNORE_FILENAME,
    OutputPathReservationError,
    get_output_dir,
    get_project_root,
    reserve_output_path,
    reserved_output_path,
)
from cli.tests.conftest import git_init_and_commit


def _fixed_datetime(now: datetime) -> MagicMock:
    """``cli.core.paths.datetime`` 差し替え用の mock（now() は固定値を返す）"""
    fake = MagicMock()
    fake.now.return_value = now
    return fake


class TestPathConstants:
    """.pecot/ 配下のパス定数"""

    def test_values(self) -> None:
        assert PECOT_DIR == ".pecot"
        assert STATE_DIR == ".pecot/state"
        assert WORK_DIR == ".pecot/work"
        assert CONFIG_DIR == ".pecot/config"
        assert OUTPUT_DIR == ".pecot/tmp/output"
        assert WORKTREE_CONFIG_FILENAME == ".pecot/config/worktree-config.json"
        assert WORKTREE_IGNORE_FILENAME == ".pecot/config/.worktreeignore"
        assert HOOKS_CONFIG_FILENAME == ".pecot/config/hooks-config.json"
        assert ACTIVE_PROJECT_FILENAME == ".pecot/config/projects/.active"


class TestGetProjectRoot:
    """get_project_root関数のテスト"""

    def test_uses_claude_project_dir_env(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """CLAUDE_PROJECT_DIR環境変数が設定されていれば使用"""
        from cli.core.paths import get_project_root

        monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
        assert get_project_root() == tmp_path

    def test_uses_git_root_when_no_env(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """環境変数がなければgitルートで解決"""
        import subprocess

        from cli.core.paths import get_project_root

        # GIT_*環境変数をクリア（git pushフック内等で汚染されるため）
        for key in list(os.environ):
            if key.startswith("GIT_"):
                monkeypatch.delenv(key, raising=False)

        # tmp_pathにgitリポジトリを作成
        subprocess.run(["git", "init"], cwd=str(tmp_path), capture_output=True, check=True)

        monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
        monkeypatch.chdir(tmp_path)

        result = get_project_root()
        assert result == tmp_path

    def test_raises_when_no_git_and_no_env(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """git外かつ環境変数なしでProjectRootNotFoundErrorを送出"""
        from cli.core.paths import ProjectRootNotFoundError, get_project_root

        monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
        # git管理外のディレクトリに移動
        non_git_dir = tmp_path / "not-a-repo"
        non_git_dir.mkdir()
        monkeypatch.chdir(non_git_dir)

        with pytest.raises(ProjectRootNotFoundError):
            get_project_root()

    def test_git_based_root_resolves_to_repo_root(self) -> None:
        """GIT_* を除いた git_toplevel がリポジトリルートを指す"""
        from cli.core.git import git_toplevel

        root = git_toplevel(strip_git_env=True)
        assert root is not None
        # リポジトリルートにはpyproject.tomlが存在する
        assert (root / "pyproject.toml").exists()

    def test_env_overrides_git(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """環境変数がgitルートより優先される"""
        from cli.core.git import git_toplevel
        from cli.core.paths import get_project_root

        monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))

        result = get_project_root()
        assert result == tmp_path
        assert result != git_toplevel(strip_git_env=True)


class TestGetProjectRootSessionWork:
    """worktree の .pecot/work（base への symlink）配下では起動した worktree を基準にする"""

    @pytest.fixture
    def layout(
        self, session_work_layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> dict[str, Path]:
        monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
        monkeypatch.setenv("PECOT_SESSION_PROJECT_DIR", str(session_work_layout["wt"]))
        return session_work_layout

    def test_cwd_in_work_resolves_to_session_worktree(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(layout["base"] / ".pecot" / "work" / "1244")
        assert get_project_root() == layout["wt"]

    def test_cwd_in_work_via_wt_link_resolves_to_session_worktree(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(layout["wt"] / ".pecot" / "work" / "1244")
        assert get_project_root() == layout["wt"]

    def test_cwd_is_work_itself(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(layout["base"] / ".pecot" / "work")
        assert get_project_root() == layout["wt"]

    def test_subdirectory_of_work(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sub = layout["base"] / ".pecot" / "work" / "1244" / "sub" / "deep"
        sub.mkdir(parents=True)
        monkeypatch.chdir(sub)
        assert get_project_root() == layout["wt"]

    def test_work2_is_not_work(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(layout["base"] / ".pecot" / "work2")
        assert get_project_root() == layout["base"]

    def test_cwd_outside_work_uses_git(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(layout["base"])
        assert get_project_root() == layout["base"]

    def test_other_repo_work_uses_that_repo(
        self, layout: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        other = (tmp_path / "other").resolve()
        other.mkdir()
        git_init_and_commit(other, {"README.md": "x"})
        task = other / ".pecot" / "work" / "9"
        task.mkdir(parents=True)
        monkeypatch.chdir(task)
        assert get_project_root() == other

    def test_nested_git_repo_in_work_uses_nested_toplevel(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        clone = layout["base"] / ".pecot" / "work" / "1244" / "clone"
        clone.mkdir()
        git_init_and_commit(clone, {"README.md": "x"})
        (clone / "src").mkdir()
        monkeypatch.chdir(clone / "src")
        assert get_project_root() == clone

    def test_session_dir_is_resolved(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("PECOT_SESSION_PROJECT_DIR", f"{layout['wt']}/")
        monkeypatch.chdir(layout["base"] / ".pecot" / "work" / "1244")
        assert get_project_root() == layout["wt"]

    def test_cwd_oserror_falls_back_to_git(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(layout["base"] / ".pecot" / "work" / "1244")

        def _raise() -> Path:
            raise FileNotFoundError("cwd removed")

        monkeypatch.setattr(Path, "cwd", _raise)
        with patch("cli.core.paths.git_toplevel", return_value=layout["base"]):
            assert get_project_root() == layout["base"]

    def test_unset_session_dir_uses_git(
        self, layout: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("PECOT_SESSION_PROJECT_DIR", raising=False)
        monkeypatch.chdir(layout["base"] / ".pecot" / "work" / "1244")
        assert get_project_root() == layout["base"]

    def test_claude_project_dir_takes_precedence(
        self, layout: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
        monkeypatch.chdir(layout["base"] / ".pecot" / "work" / "1244")
        assert get_project_root() == tmp_path


class TestGetOutputDir:
    """get_output_dir関数のテスト"""

    def test_returns_path(self) -> None:
        """Pathオブジェクトを返す"""
        result = get_output_dir()
        assert isinstance(result, Path)

    def test_ends_with_pecot_tmp_output(self) -> None:
        """パスが.pecot/tmp/outputで終わる"""
        result = get_output_dir()
        assert result.parts[-3:] == (".pecot", "tmp", "output")

    def test_based_on_project_root(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """プロジェクトルート基準のパスを返す"""
        monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
        assert get_output_dir() == tmp_path / ".pecot" / "tmp" / "output"

    def test_is_absolute(self) -> None:
        """絶対パスを返す"""
        result = get_output_dir()
        assert result.is_absolute()

    def test_no_args_required(self) -> None:
        """引数なしで呼び出せる"""
        get_output_dir()


class TestReserveOutputPath:
    """reserve_output_path関数のテスト"""

    def test_same_now_returns_next_second(self, tmp_path: Path) -> None:
        """同一 now() で 2 回呼ぶと HHMMSS と HHMMSS+1 の別パスになる"""
        output_dir = tmp_path / "output"
        fake_dt = _fixed_datetime(datetime(2026, 5, 13, 10, 0, 0))

        with patch("cli.core.paths.datetime", fake_dt):
            first = reserve_output_path(output_dir, lambda ts: f"comment-plan-{ts}.md")
            second = reserve_output_path(output_dir, lambda ts: f"comment-plan-{ts}.md")

        assert first.name == "comment-plan-20260513-100000.md"
        assert second.name == "comment-plan-20260513-100001.md"
        assert first.exists()
        assert second.exists()

    def test_calls_now_once_per_reservation(self, tmp_path: Path) -> None:
        """1 予約につき datetime.now() は 1 回だけ呼ばれる"""
        output_dir = tmp_path / "output"
        (output_dir).mkdir(parents=True)
        (output_dir / "pr-create-20260513-100000.md").write_text("先客", encoding="utf-8")
        fake_dt = _fixed_datetime(datetime(2026, 5, 13, 10, 0, 0))

        with patch("cli.core.paths.datetime", fake_dt):
            reserve_output_path(output_dir, lambda ts: f"pr-create-{ts}.md")

        assert fake_dt.now.call_count == 1

    def test_skips_preexisting_candidates_without_touching_them(self, tmp_path: Path) -> None:
        """候補名が 2 件先在すると +2 秒の名前を返し、先客の内容は不変"""
        output_dir = tmp_path / "output"
        output_dir.mkdir(parents=True)
        existing = [
            output_dir / "pr-create-20260513-100000.md",
            output_dir / "pr-create-20260513-100001.md",
        ]
        for index, path in enumerate(existing):
            path.write_text(f"SENTINEL-{index}", encoding="utf-8")
        fake_dt = _fixed_datetime(datetime(2026, 5, 13, 10, 0, 0))

        with patch("cli.core.paths.datetime", fake_dt):
            reserved = reserve_output_path(output_dir, lambda ts: f"pr-create-{ts}.md")

        assert reserved.name == "pr-create-20260513-100002.md"
        for index, path in enumerate(existing):
            assert path.read_text(encoding="utf-8") == f"SENTINEL-{index}"

    def test_creates_empty_file_and_parent_dirs(self, tmp_path: Path) -> None:
        """output_dir が無くても親ごと作成し、返り値のファイルは空"""
        output_dir = tmp_path / "missing" / "output"

        reserved = reserve_output_path(output_dir, lambda ts: f"comment-plan-{ts}.md")

        assert output_dir.is_dir()
        assert reserved.is_file()
        assert reserved.read_text(encoding="utf-8") == ""

    def test_raises_when_all_candidates_taken(self, tmp_path: Path) -> None:
        """name_for が定数名を返すと max_attempts 回で例外"""
        output_dir = tmp_path / "output"
        output_dir.mkdir(parents=True)
        (output_dir / "fixed.md").write_text("先客", encoding="utf-8")
        fake_dt = _fixed_datetime(datetime(2026, 5, 13, 10, 0, 0))

        with (
            patch("cli.core.paths.datetime", fake_dt),
            pytest.raises(OutputPathReservationError) as excinfo,
        ):
            reserve_output_path(output_dir, lambda _ts: "fixed.md", max_attempts=3)

        message = str(excinfo.value)
        assert "3 件の候補名がすべて使用済み" in message
        assert str(output_dir / "fixed.md") in message
        assert (output_dir / "fixed.md").read_text(encoding="utf-8") == "先客"


class TestReservedOutputPath:
    """reserved_output_path コンテキストマネージャのテスト"""

    def test_yields_reserved_path_and_keeps_it_on_success(self, tmp_path: Path) -> None:
        """正常終了なら書き込んだ内容がそのまま残る"""
        output_dir = tmp_path / "output"
        fake_dt = _fixed_datetime(datetime(2026, 5, 13, 10, 0, 0))

        with patch("cli.core.paths.datetime", fake_dt):
            with reserved_output_path(output_dir, lambda ts: f"pr-create-{ts}.md") as path:
                path.write_text("本文", encoding="utf-8")

        assert path.name == "pr-create-20260513-100000.md"
        assert path.read_text(encoding="utf-8") == "本文"

    def test_removes_file_when_body_raises(self, tmp_path: Path) -> None:
        """書き込み中の例外で 0 バイトのファイルが残らない"""
        output_dir = tmp_path / "output"
        fake_dt = _fixed_datetime(datetime(2026, 5, 13, 10, 0, 0))
        reserved: Path | None = None

        with patch("cli.core.paths.datetime", fake_dt), pytest.raises(RuntimeError):
            with reserved_output_path(output_dir, lambda ts: f"pr-create-{ts}.md") as path:
                reserved = path
                assert path.is_file()
                raise RuntimeError("書き込み失敗")

        assert reserved is not None
        assert not reserved.exists()
        assert list(output_dir.iterdir()) == []

    def test_next_reservation_reuses_freed_name(self, tmp_path: Path) -> None:
        """撤去した候補名は同一秒の次の予約で再利用される"""
        output_dir = tmp_path / "output"
        fake_dt = _fixed_datetime(datetime(2026, 5, 13, 10, 0, 0))

        with patch("cli.core.paths.datetime", fake_dt):
            with pytest.raises(RuntimeError):
                with reserved_output_path(output_dir, lambda ts: f"pr-create-{ts}.md"):
                    raise RuntimeError("書き込み失敗")
            with reserved_output_path(output_dir, lambda ts: f"pr-create-{ts}.md") as second:
                second.write_text("本文", encoding="utf-8")

        assert second.name == "pr-create-20260513-100000.md"

    def test_reservation_error_propagates(self, tmp_path: Path) -> None:
        """予約自体に失敗した場合は with ブロックに入らず例外が伝播する"""
        output_dir = tmp_path / "output"
        output_dir.mkdir(parents=True)
        (output_dir / "fixed.md").write_text("先客", encoding="utf-8")
        fake_dt = _fixed_datetime(datetime(2026, 5, 13, 10, 0, 0))
        entered = False

        with (
            patch("cli.core.paths.datetime", fake_dt),
            pytest.raises(OutputPathReservationError),
        ):
            with reserved_output_path(output_dir, lambda _ts: "fixed.md", max_attempts=2):
                entered = True

        assert entered is False
        assert (output_dir / "fixed.md").read_text(encoding="utf-8") == "先客"
