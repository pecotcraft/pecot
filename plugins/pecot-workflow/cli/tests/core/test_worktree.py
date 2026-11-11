"""tests/core/test_worktree.py - core/worktree.py のテスト (v2 配置規約)

プロジェクト単位 wtN 構成 (`<root>/base/<repo>`, `<root>/wtN/<repo>`) の
新配置規約を前提としたテスト。
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pathspec
import pytest
from ub_test_reports.pytest_plugin import add_test_properties

from cli.core.repo_resolver import RepoRef
from cli.core.worktree import (
    SetupResult,
    WorktreeCreateResult,
    _run_effective_setup,
    _run_setup_command,
    _should_exclude,
    copy_files,
    create_worktree,
    detect_project_root,
    ensure_devcontainer_environment,
    filter_copyable_files,
    find_main_worktree,
    get_current_worktree_name,
    get_next_set_name,
    get_untracked_files,
    get_worktree_list,
    is_worktree_env,
    remove_worktree,
)


def _make_spec(lines: list[str]) -> pathspec.PathSpec:
    return pathspec.GitIgnoreSpec.from_lines(lines)


# get_worktree_list のテスト


def _porcelain(*entries: tuple[str, str | None]) -> str:
    """``git worktree list --porcelain`` 形式の出力を作る（branch が None なら detached）"""
    blocks = []
    for path, branch in entries:
        tail = f"branch refs/heads/{branch}" if branch else "detached"
        blocks.append(f"worktree {path}\nHEAD {'a' * 40}\n{tail}\n")
    return "\n".join(blocks)


class TestGetWorktreeList:
    def test_parse_normal_output(self) -> None:
        mock_output = _porcelain(("/home/user/repo", "main"), ("/home/user/wt1/repo", "wt1"))
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=mock_output)
            result = get_worktree_list()
        assert len(result) == 2
        assert result[0].branch == "main"
        assert result[1].branch == "wt1"

    def test_parse_path_with_spaces(self) -> None:
        mock_output = _porcelain(("/home/my user/repo", "main"), ("/home/my user/wt 1/repo", "wt1"))
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=mock_output)
            result = get_worktree_list()
        assert [w.path for w in result] == ["/home/my user/repo", "/home/my user/wt 1/repo"]
        assert result[1].branch == "wt1"

    def test_parse_detached_head(self) -> None:
        mock_output = _porcelain(("/home/user/repo", None))
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=mock_output)
            result = get_worktree_list()
        assert len(result) == 1
        assert result[0].branch is None

    def test_empty_output(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="")
            assert get_worktree_list() == []


# find_main_worktree のテスト


class TestFindMainWorktree:
    def test_returns_first_worktree_path(self) -> None:
        mock_output = _porcelain(("/home/user/repo", "main"), ("/home/user/wt/wt1", "wt1"))
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=mock_output)
            result = find_main_worktree(Path("/home/user/wt/wt1"))
        assert result == Path("/home/user/repo")

    def test_command_failure_raises(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="error")
            with pytest.raises(RuntimeError, match="cannot get the worktree list"):
                find_main_worktree(Path("/tmp/nonexistent"))


# detect_project_root のテスト


class TestDetectProjectRoot:
    def test_base_direct(self, tmp_path: Path) -> None:
        """base 直下: main_wt = <root>/base/<repo> を返す"""
        root = tmp_path / "workspaces"
        repo = root / "base" / "myrepo"
        repo.mkdir(parents=True)
        with patch("cli.core.worktree.find_main_worktree", return_value=repo):
            result = detect_project_root(repo)
        assert result == root

    def test_from_wt1(self, tmp_path: Path) -> None:
        """wt1 から呼び出し: main_wt が base/<repo> を指していれば同じ root を返す"""
        root = tmp_path / "workspaces"
        repo = root / "base" / "myrepo"
        wt1_repo = root / "wt1" / "myrepo"
        repo.mkdir(parents=True)
        wt1_repo.mkdir(parents=True)
        with patch("cli.core.worktree.find_main_worktree", return_value=repo):
            result = detect_project_root(wt1_repo)
        assert result == root

    def test_non_base_raises(self, tmp_path: Path) -> None:
        """base 以外で呼び出し: RuntimeError"""
        repo = tmp_path / "elsewhere" / "myrepo"
        repo.mkdir(parents=True)
        with patch("cli.core.worktree.find_main_worktree", return_value=repo):
            with pytest.raises(RuntimeError) as exc_info:
                detect_project_root(repo)
        msg = str(exc_info.value)
        # 4ブロック構成を検証
        assert "current:" in msg
        assert "expected:" in msg
        assert "why base/" in msg
        assert "migration steps" in msg

    def test_symlink_resolution(self, tmp_path: Path) -> None:
        """シンボリックリンク経由: resolve() で正規化してから確認"""
        root = tmp_path / "workspaces"
        real_repo = root / "base" / "myrepo"
        real_repo.mkdir(parents=True)
        link_path = tmp_path / "alias"
        os.symlink(real_repo, link_path)
        with patch("cli.core.worktree.find_main_worktree", return_value=link_path):
            result = detect_project_root(link_path)
        assert result == root


# get_next_set_name のテスト


class TestGetNextSetName:
    def test_empty_root_returns_wt1(self, tmp_path: Path) -> None:
        """既存 wtN セット無し → wt1"""
        root = tmp_path / "project"
        root.mkdir()
        assert get_next_set_name(root, "myrepo") == "wt1"

    def test_nonexistent_root_returns_wt1(self, tmp_path: Path) -> None:
        assert get_next_set_name(tmp_path / "nonexistent", "myrepo") == "wt1"

    def test_joins_existing_set_when_repo_missing(self, tmp_path: Path) -> None:
        """wt1/ が存在するが wt1/myrepo が無い → wt1 に参加"""
        (tmp_path / "wt1").mkdir()
        assert get_next_set_name(tmp_path, "myrepo") == "wt1"

    def test_skips_set_where_repo_exists(self, tmp_path: Path) -> None:
        """wt1/myrepo が既にある / wt2/ は空 → wt2 に参加"""
        (tmp_path / "wt1" / "myrepo").mkdir(parents=True)
        (tmp_path / "wt2").mkdir()
        assert get_next_set_name(tmp_path, "myrepo") == "wt2"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-04"])
    def test_new_set_when_all_existing_have_repo(self, tmp_path: Path) -> None:
        """全セットに該当リポ参加済 → max+1 で新セット"""
        (tmp_path / "wt1" / "myrepo").mkdir(parents=True)
        (tmp_path / "wt2" / "myrepo").mkdir(parents=True)
        assert get_next_set_name(tmp_path, "myrepo") == "wt3"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-03"])
    def test_picks_lowest_available_set(self, tmp_path: Path) -> None:
        """複数の空き（参加可能）セット中では最小番号"""
        (tmp_path / "wt1").mkdir()  # 参加可能
        (tmp_path / "wt3").mkdir()  # 参加可能
        assert get_next_set_name(tmp_path, "myrepo") == "wt1"

    def test_new_set_skips_gap(self, tmp_path: Path) -> None:
        """wt1/repo, wt3/repo 埋まっていて wt2 が無いケース → max(=3)+1 = wt4
        （穴埋めは行わない。ロジックは「参加できるなら既存、できないなら max+1」）"""
        (tmp_path / "wt1" / "myrepo").mkdir(parents=True)
        (tmp_path / "wt3" / "myrepo").mkdir(parents=True)
        assert get_next_set_name(tmp_path, "myrepo") == "wt4"

    def test_all_used_raises(self, tmp_path: Path) -> None:
        """全セットに参加済み + max_n まで埋まっている → RuntimeError"""
        for i in range(1, 10):
            (tmp_path / f"wt{i}" / "myrepo").mkdir(parents=True)
        with pytest.raises(RuntimeError, match="are in use"):
            get_next_set_name(tmp_path, "myrepo")

    def test_ignores_base_dir(self, tmp_path: Path) -> None:
        """base ディレクトリは無視される"""
        (tmp_path / "base").mkdir()
        assert get_next_set_name(tmp_path, "myrepo") == "wt1"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-03"])
    def test_avoids_claimed_name(self, tmp_path: Path) -> None:
        """wt1 が claimed にあれば、wt1/ が空でも避けて wt2"""
        (tmp_path / "wt1").mkdir()
        (tmp_path / "wt2").mkdir()
        assert get_next_set_name(tmp_path, "myrepo", claimed={"wt1"}) == "wt2"

    def test_claimed_raises_max(self, tmp_path: Path) -> None:
        """<root>/wt1 が無くても claimed の番号は max に入る"""
        assert get_next_set_name(tmp_path, "myrepo", claimed={"wt1"}) == "wt2"

    def test_claimed_ignores_non_matching_names(self, tmp_path: Path) -> None:
        assert get_next_set_name(tmp_path, "myrepo", claimed={"feat/x", "main"}) == "wt1"

    def test_ignores_non_wt_dirs(self, tmp_path: Path) -> None:
        (tmp_path / "foo").mkdir()
        (tmp_path / "wt1").mkdir()
        # wt1 は該当リポ未参加 → wt1 に join
        assert get_next_set_name(tmp_path, "myrepo") == "wt1"


# create_worktree のテスト (新配置規約)


class TestCreateWorktree:
    def _setup_fake_project(self, tmp_path: Path) -> tuple[Path, Path]:
        from cli.tests.conftest import make_worktree_required_configs

        root = tmp_path / "workspaces"
        repo = root / "base" / "myrepo"
        repo.mkdir(parents=True)
        make_worktree_required_configs(repo, ignore_content=".git/\n__pycache__/\n")
        return root, repo

    def _make_config(self, registered: bool = True) -> MagicMock:
        """アクティブプロジェクト設定のモック

        registered=True: myowner/myrepo が登録済み
        registered=False: 空の repositories
        """
        cfg = MagicMock()
        repo_mock = MagicMock(owner="myowner", name="myrepo")
        cfg.repositories = [repo_mock] if registered else []
        cfg.find_repository.side_effect = lambda owner, name: (
            repo_mock if registered and owner == "myowner" and name == "myrepo" else None
        )
        cfg.get_develop_branch.return_value = "develop"
        return cfg

    def _remote_repos(self) -> list[tuple[str, MagicMock]]:
        return [("origin", MagicMock(owner="myowner", repo="myrepo"))]

    def test_path_uses_new_placement(self, tmp_path: Path) -> None:
        """dry_run で path が <root>/<name>/<repo_dir_name> になる"""
        root, repo = self._setup_fake_project(tmp_path)

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                dry_run=True,
            )

        assert result.path == root / "wt1" / "myrepo"
        assert result.name == "wt1"
        assert result.branch == "wt1"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-04"])
    def test_auto_name_uses_get_next_set_name(self, tmp_path: Path) -> None:
        """name 省略時は プロジェクトルート基準で番号決定

        wt1 に該当リポが既に参加済みなので、新セット wt2 が採番される。
        """
        root, repo = self._setup_fake_project(tmp_path)
        (root / "wt1" / "myrepo").mkdir(parents=True)

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
        ):
            result = create_worktree(
                cwd=repo,
                base_branch="develop",
                dry_run=True,
            )

        assert result.name == "wt2"
        assert result.path == root / "wt2" / "myrepo"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-03"])
    def test_auto_joins_existing_set(self, tmp_path: Path) -> None:
        """別リポが作った wt1/ へ該当リポが未参加 → wt1 に参加"""
        root, repo = self._setup_fake_project(tmp_path)
        # 別リポ myrepo-B が既に wt1 に参加している状態
        (root / "wt1" / "myrepo-B").mkdir(parents=True)

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
        ):
            result = create_worktree(
                cwd=repo,
                base_branch="develop",
                dry_run=True,
            )

        assert result.name == "wt1"
        assert result.path == root / "wt1" / "myrepo"

    def test_existing_branch_upstream_mismatch_raises(self, tmp_path: Path) -> None:
        """既存ブランチ衝突: upstream が develop_branch と違う場合 RuntimeError"""
        root, repo = self._setup_fake_project(tmp_path)

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "for-each-ref"]:
                return MagicMock(returncode=0, stdout="origin/other-branch\n", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("subprocess.run", side_effect=fake_run),
        ):
            with pytest.raises(RuntimeError, match="upstream differs from the expected one"):
                create_worktree(
                    cwd=repo,
                    name="wt1",
                    base_branch="develop",
                    link=False,
                    copy=False,
                )

    @add_test_properties(verifies=["PW-WORKTREE-ADD-12"])
    def test_existing_branch_allow_existing_bypasses_guard(self, tmp_path: Path) -> None:
        """--allow-existing-branch で衝突ガードをバイパス"""
        root, repo = self._setup_fake_project(tmp_path)

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:3] == ["git", "worktree", "add"]:
                # 本来ここで WT を作る。テストではパスだけ作る
                path_arg = Path(cmd[3])
                path_arg.mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                link=False,
                copy=False,
                allow_existing_branch=True,
            )

        assert result.path == root / "wt1" / "myrepo"

    def test_orphan_branch_is_deleted_and_recreated(self, tmp_path: Path) -> None:
        """孤児ブランチ: upstream 一致・worktreepath 空 → branch -D 後に -b --track で再作成"""
        root, repo = self._setup_fake_project(tmp_path)

        branch_d_calls: list[list[str]] = []
        worktree_add_calls: list[list[str]] = []

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "for-each-ref"]:
                fmt = cmd[2]  # "--format=%(upstream:short)" or "--format=%(worktreepath)"
                if "upstream:short" in fmt:
                    return MagicMock(returncode=0, stdout="origin/develop\n", stderr="")
                if "worktreepath" in fmt:
                    return MagicMock(returncode=0, stdout="\n", stderr="")
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:3] == ["git", "branch", "-D"]:
                branch_d_calls.append(list(cmd))
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:3] == ["git", "worktree", "add"]:
                worktree_add_calls.append(list(cmd))
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                link=False,
                copy=False,
            )

        # branch -D が呼ばれた
        assert len(branch_d_calls) == 1
        assert branch_d_calls[0] == ["git", "branch", "-D", "wt1"]
        # worktree add が -b --track 形式で呼ばれた
        assert len(worktree_add_calls) == 1
        add_cmd = worktree_add_calls[0]
        assert "-b" in add_cmd
        assert "--track" in add_cmd
        assert "origin/develop" in add_cmd
        assert result.path == root / "wt1" / "myrepo"

    def test_bound_branch_is_reused_without_branch_D(self, tmp_path: Path) -> None:
        """bind 済みブランチ: worktreepath 非空 → branch -D は呼ばれず既存ブランチ再利用"""
        root, repo = self._setup_fake_project(tmp_path)

        branch_d_calls: list[list[str]] = []
        worktree_add_calls: list[list[str]] = []

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "for-each-ref"]:
                fmt = cmd[2]
                if "upstream:short" in fmt:
                    return MagicMock(returncode=0, stdout="origin/develop\n", stderr="")
                if "worktreepath" in fmt:
                    return MagicMock(
                        returncode=0, stdout="/workspaces/wt1/aist-plugin\n", stderr=""
                    )
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:3] == ["git", "branch", "-D"]:
                branch_d_calls.append(list(cmd))
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:3] == ["git", "worktree", "add"]:
                worktree_add_calls.append(list(cmd))
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                link=False,
                copy=False,
            )

        # branch -D は呼ばれない
        assert len(branch_d_calls) == 0
        # worktree add が -b なし形式（既存ブランチ再利用）で呼ばれた
        assert len(worktree_add_calls) == 1
        add_cmd = worktree_add_calls[0]
        assert "-b" not in add_cmd
        assert result.path == root / "wt1" / "myrepo"

    def test_orphan_with_mismatched_upstream_still_raises(self, tmp_path: Path) -> None:
        """orphan かつ upstream 不一致 → upstream 不一致 RuntimeError が先に発火"""
        root, repo = self._setup_fake_project(tmp_path)

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "for-each-ref"]:
                fmt = cmd[2]
                if "upstream:short" in fmt:
                    return MagicMock(returncode=0, stdout="origin/other-branch\n", stderr="")
                if "worktreepath" in fmt:
                    return MagicMock(returncode=0, stdout="\n", stderr="")
                return MagicMock(returncode=0, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("subprocess.run", side_effect=fake_run),
        ):
            with pytest.raises(RuntimeError, match="upstream differs from the expected one"):
                create_worktree(
                    cwd=repo,
                    name="wt1",
                    base_branch="develop",
                    link=False,
                    copy=False,
                )

    @add_test_properties(verifies=["PW-WORKTREE-ADD-12"])
    def test_allow_existing_branch_skips_orphan_detection(self, tmp_path: Path) -> None:
        """allow_existing_branch=True のとき worktreepath が空でも branch -D を呼ばない"""
        root, repo = self._setup_fake_project(tmp_path)

        branch_d_calls: list[list[str]] = []
        worktree_add_calls: list[list[str]] = []

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "for-each-ref"]:
                raise AssertionError(
                    "allow_existing_branch=True のとき for-each-ref は呼ばれてはいけない"
                )
            if cmd[:3] == ["git", "branch", "-D"]:
                branch_d_calls.append(list(cmd))
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:3] == ["git", "worktree", "add"]:
                worktree_add_calls.append(list(cmd))
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                link=False,
                copy=False,
                allow_existing_branch=True,
            )

        # branch -D は呼ばれない
        assert len(branch_d_calls) == 0
        # worktree add が -b なし形式（既存ブランチ再利用）で呼ばれた
        assert len(worktree_add_calls) == 1
        add_cmd = worktree_add_calls[0]
        assert "-b" not in add_cmd
        assert result.path == root / "wt1" / "myrepo"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-10"])
    def test_setup_command_cli_takes_priority_over_config(self, tmp_path: Path) -> None:
        """CLI --setup 明示が config.setup_command より優先される"""
        root, repo = self._setup_fake_project(tmp_path)

        fake_config = MagicMock()
        fake_config.setup_command = "echo from-config"
        fake_config.links = []

        executed: list[tuple[str, Path]] = []

        def fake_run_setup(command: str, cwd: Path, timeout: int | None = None):  # type: ignore[no-untyped-def]
            from cli.core.worktree import SetupResult

            executed.append((command, cwd))
            return SetupResult(command=command, returncode=0, stdout="ok\n", stderr="")

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:3] == ["git", "worktree", "add"]:
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=1, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("cli.core.worktree_links.find_config_file", return_value=tmp_path / "cfg"),
            patch("cli.core.worktree_links.load_config", return_value=fake_config),
            patch("cli.core.worktree._run_setup_command", side_effect=fake_run_setup),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                setup_command="echo from-cli",
                copy=False,
                link=False,
            )

        assert len(executed) == 1
        assert executed[0][0] == "echo from-cli"
        assert result.setup_result is not None
        assert result.setup_result.command == "echo from-cli"
        assert result.setup_result.returncode == 0

    @add_test_properties(verifies=["PW-WORKTREE-ADD-11"])
    def test_setup_command_from_config_used_when_cli_absent(self, tmp_path: Path) -> None:
        """CLI 未指定なら config.setup_command が使われる"""
        root, repo = self._setup_fake_project(tmp_path)

        fake_config = MagicMock()
        fake_config.setup_command = "echo from-config"
        fake_config.links = []

        executed: list[str] = []

        def fake_run_setup(command: str, cwd: Path, timeout: int | None = None):  # type: ignore[no-untyped-def]
            from cli.core.worktree import SetupResult

            executed.append(command)
            return SetupResult(command=command, returncode=0, stdout="", stderr="")

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:3] == ["git", "worktree", "add"]:
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=1, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("cli.core.worktree_links.find_config_file", return_value=tmp_path / "cfg"),
            patch("cli.core.worktree_links.load_config", return_value=fake_config),
            patch("cli.core.worktree._run_setup_command", side_effect=fake_run_setup),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                copy=False,
                link=False,
            )

        assert executed == ["echo from-config"]
        assert result.setup_result is not None
        assert result.setup_result.command == "echo from-config"

    def test_setup_command_skipped_when_both_none(self, tmp_path: Path) -> None:
        """CLI なし & config.setup_command=None なら実行しない"""
        root, repo = self._setup_fake_project(tmp_path)

        fake_config = MagicMock()
        fake_config.setup_command = None
        fake_config.links = []

        def fake_run_setup(command: str, cwd: Path, timeout: int | None = None):  # type: ignore[no-untyped-def]
            raise AssertionError("should not be called")

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:3] == ["git", "worktree", "add"]:
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=1, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("cli.core.worktree_links.find_config_file", return_value=tmp_path / "cfg"),
            patch("cli.core.worktree_links.load_config", return_value=fake_config),
            patch("cli.core.worktree._run_setup_command", side_effect=fake_run_setup),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                copy=False,
                link=False,
            )

        assert result.setup_result is None

    def test_setup_timeout_from_config_passed_to_subprocess(self, tmp_path: Path) -> None:
        """config.setup_command_timeout が subprocess.run の timeout 引数に渡される"""
        root, repo = self._setup_fake_project(tmp_path)

        fake_config = MagicMock()
        fake_config.setup_command = "echo hi"
        fake_config.setup_command_timeout = 30
        fake_config.links = []

        captured_timeouts: list[int | None] = []

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd == "echo hi" and kwargs.get("shell") is True:
                captured_timeouts.append(kwargs.get("timeout"))
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:3] == ["git", "worktree", "add"]:
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=1, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("cli.core.worktree_links.find_config_file", return_value=tmp_path / "cfg"),
            patch("cli.core.worktree_links.load_config", return_value=fake_config),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                copy=False,
                link=False,
            )

        assert captured_timeouts == [30]
        assert result.setup_result is not None
        assert result.setup_result.returncode == 0
        assert root.exists()

    def test_setup_command_failure_does_not_raise(self, tmp_path: Path) -> None:
        """setup_command が非ゼロ終了でも例外は投げず SetupResult に結果を載せる"""
        root, repo = self._setup_fake_project(tmp_path)

        fake_config = MagicMock()
        fake_config.setup_command = None
        fake_config.links = []

        def fake_run_setup(command: str, cwd: Path, timeout: int | None = None):  # type: ignore[no-untyped-def]
            from cli.core.worktree import SetupResult

            return SetupResult(command=command, returncode=42, stdout="", stderr="boom\n")

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:3] == ["git", "worktree", "add"]:
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=1, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("cli.core.worktree_links.find_config_file", return_value=tmp_path / "cfg"),
            patch("cli.core.worktree_links.load_config", return_value=fake_config),
            patch("cli.core.worktree._run_setup_command", side_effect=fake_run_setup),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                setup_command="exit 42",
                copy=False,
                link=False,
            )

        # 作成は成功している
        assert result.path == root / "wt1" / "myrepo"
        # setup_result は残っている
        assert result.setup_result is not None
        assert result.setup_result.returncode == 42
        assert result.setup_result.stderr == "boom\n"

    def test_unregistered_repo_raises(self, tmp_path: Path) -> None:
        """cwd のリポジトリが active project に登録されていないと RuntimeError"""
        root, repo = self._setup_fake_project(tmp_path)

        cfg = MagicMock()
        cfg.repositories = [MagicMock(owner="foo", name="bar")]
        cfg.find_repository.return_value = None

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=cfg),
        ):
            with pytest.raises(RuntimeError) as exc_info:
                create_worktree(
                    cwd=repo,
                    name="wt1",
                    base_branch="develop",
                    dry_run=True,
                )

        msg = str(exc_info.value)
        assert "is not registered" in msg
        assert "pecot project set-repo myowner/myrepo" in msg
        assert "pecot project activate <PROJECT>" in msg

    def test_symlinked_paths_excluded_from_copy(self, tmp_path: Path) -> None:
        """symlink 登録済みの .claude/settings.local.json が
        git ls-files --others --ignored に出ていても Step 7 のコピーから除外される

        `symlinked_paths` セットは Step 6 で作成成功した symlink の相対パスが入り、
        Step 7 で `Path.is_relative_to` により除外される。
        """
        root, repo = self._setup_fake_project(tmp_path)

        # symlink 対象のファイルを登録した config を差し込む
        from cli.core.worktree_links import WorktreeConfig, WorktreeLinkItem

        fake_config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path=".claude/settings.local.json",
                    target_repo="shared-repo",
                    target_path=".claude/settings.local.json",
                ),
            ]
        )

        # symlink ターゲットの実体を作る (shared-repo/.claude/settings.local.json)
        shared = root / "base" / "shared-repo"
        (shared / ".claude").mkdir(parents=True)
        (shared / ".claude" / "settings.local.json").write_text("{}")

        # git ls-files --others --ignored が返すファイルは次の 2 つ。
        # - .claude/settings.local.json → symlink 対象なのでコピー除外されるべき
        # - .env → symlink 未登録なのでコピーされるべき
        untracked = [
            Path(".claude/settings.local.json"),
            Path(".env"),
        ]
        # メイン WT 側に両方のソースを用意（copy_files が実際にコピーするため）
        (repo / ".claude").mkdir(parents=True)
        (repo / ".claude" / "settings.local.json").write_text("main-content")
        (repo / ".env").write_text("FOO=bar\n")

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:3] == ["git", "worktree", "add"]:
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=1, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=untracked),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("cli.core.worktree_links.load_config", return_value=fake_config),
            patch("subprocess.run", side_effect=fake_run),
        ):
            result = create_worktree(
                cwd=repo,
                name="wt1",
                base_branch="develop",
                copy=True,
                link=True,
            )

        copied_sources = [
            Path(cr.source).name for cr in result.copied_files if cr.action == "copied"
        ]
        assert ".env" in copied_sources
        # symlink 登録済みファイルはコピー対象外
        assert "settings.local.json" not in copied_sources
        # symlink 自体は残っている
        symlink_in_wt = result.path / ".claude" / "settings.local.json"
        assert symlink_in_wt.is_symlink()

    def test_broken_worktree_config_raises_runtime_error(self, tmp_path: Path) -> None:
        """不正 JSON の worktree-config.json は hard error で RuntimeError

        設定ファイル不在と同様、読み込み失敗は warning 続行ではなく exit 1 に揃える。
        """
        root, repo = self._setup_fake_project(tmp_path)
        # _setup_fake_project が置いた有効な config を意図的に壊す
        cfg_path = repo / ".pecot" / "config" / "worktree-config.json"
        cfg_path.write_text("{ this is not valid json", encoding="utf-8")

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:3] == ["git", "worktree", "add"]:
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=1, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("cli.core.worktree._read_remote_repos", return_value=self._remote_repos()),
            patch("cli.core.worktree.load_active_config", return_value=self._make_config()),
            patch("subprocess.run", side_effect=fake_run),
        ):
            with pytest.raises(RuntimeError) as exc_info:
                create_worktree(
                    cwd=repo,
                    name="wt1",
                    base_branch="develop",
                    copy=False,
                    link=False,
                )

        msg = str(exc_info.value)
        assert "failed to load the worktree config" in msg
        assert "worktree-config.json" in msg
        assert "fix the config file and run it again" in msg


# _run_effective_setup の警告


class TestRunEffectiveSetupWarning:
    @staticmethod
    def _warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
        return [r for r in caplog.records if r.levelno >= logging.WARNING]

    def test_failure_is_one_warning_with_out_and_err(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        fake = SetupResult(command="make", returncode=42, stdout="hi\nthere\n", stderr="oops\n")
        config = MagicMock(setup_command=None, setup_command_timeout=None)
        with patch("cli.core.worktree._run_setup_command", return_value=fake):
            _run_effective_setup("make", config, tmp_path)
        records = self._warnings(caplog)
        assert [(r.levelno, r.getMessage()) for r in records] == [
            (
                logging.WARNING,
                "setup command failed (exit 42): make\nout: hi\nout: there\nerr: oops",
            )
        ]
        assert records[0].args == ()

    def test_timeout_is_one_warning(self, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
        fake = SetupResult(
            command="sleep 600", returncode=-1, stdout="", stderr="timeout after 60 seconds"
        )
        config = MagicMock(setup_command=None, setup_command_timeout=60)
        with patch("cli.core.worktree._run_setup_command", return_value=fake):
            _run_effective_setup("sleep 600", config, tmp_path)
        assert [(r.levelno, r.getMessage()) for r in self._warnings(caplog)] == [
            (
                logging.WARNING,
                "setup command timed out: sleep 600\nerr: timeout after 60 seconds",
            )
        ]

    def test_success_logs_nothing(self, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
        fake = SetupResult(command="true", returncode=0, stdout="done\n", stderr="")
        config = MagicMock(setup_command=None, setup_command_timeout=None)
        with patch("cli.core.worktree._run_setup_command", return_value=fake):
            _run_effective_setup("true", config, tmp_path)
        assert self._warnings(caplog) == []


# _run_setup_command のテスト


class TestRunSetupCommand:
    def test_success_captures_stdout(self, tmp_path: Path) -> None:
        """成功ケース: stdout が SetupResult に載る"""
        result = _run_setup_command("echo hello", cwd=tmp_path)
        assert result.command == "echo hello"
        assert result.returncode == 0
        assert result.stdout == "hello\n"
        assert result.stderr == ""

    def test_failure_preserves_stderr_and_returncode(self, tmp_path: Path) -> None:
        """失敗ケース: returncode と stderr が載り、例外は投げない"""
        # sh -c 経由で標準エラーに出してから exit 1
        result = _run_setup_command(">&2 echo boom; exit 1", cwd=tmp_path)
        assert result.returncode == 1
        assert "boom" in result.stderr

    def test_cwd_is_honored(self, tmp_path: Path) -> None:
        """cwd 引数が shell のカレントに反映される"""
        result = _run_setup_command("pwd", cwd=tmp_path)
        assert result.returncode == 0
        # tmp_path と出力が一致（末尾改行を除く）。symlink 解決差を避けるため endswith で検証。
        assert str(tmp_path.resolve()) in result.stdout

    def test_timeout_captured_as_returncode_minus_one(self, tmp_path: Path) -> None:
        """timeout 超過 → returncode=-1 で捕捉、例外は投げない"""
        result = _run_setup_command("sleep 5", cwd=tmp_path, timeout=1)
        assert result.returncode == -1
        assert "timeout" in result.stderr
        assert "1 seconds" in result.stderr
        assert result.command == "sleep 5"

    def test_stdin_is_devnull(self, tmp_path: Path) -> None:
        """stdin は DEVNULL なので対話プロンプトでも stall せずに即 EOF

        `read` は EOF で非 0 exit するが、timeout ではなく即座に終わることを
        timeout=1 の経過秒がほぼ 0 であることで担保する
        """
        import time

        start = time.monotonic()
        result = _run_setup_command("read line; echo got=$line", cwd=tmp_path, timeout=3)
        elapsed = time.monotonic() - start
        # DEVNULL のおかげで read は即 EOF → 1秒もかからない
        assert elapsed < 2.0
        # timeout 起因ではない（-1 ではない）
        assert result.returncode != -1


# remove_worktree のテスト


class TestRemoveWorktree:
    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-05"])
    def test_empty_set_dir_is_removed(self, tmp_path: Path) -> None:
        """削除後、<root>/<name>/ が空なら rmdir"""
        root = tmp_path / "workspaces"
        repo = root / "base" / "myrepo"
        repo.mkdir(parents=True)
        set_dir = root / "wt1"
        set_dir.mkdir()

        # git worktree list の出力: メイン + wt1
        list_output = _porcelain((str(repo), "main"), (str(set_dir / "myrepo"), "wt1"))

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:3] == ["git", "worktree", "list"]:
                return MagicMock(returncode=0, stdout=list_output, stderr="")
            if cmd[:3] == ["git", "worktree", "remove"]:
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "branch"]:
                return MagicMock(returncode=0, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("subprocess.run", side_effect=fake_run),
        ):
            remove_worktree(cwd=repo, name="wt1")

        assert not set_dir.exists()

    def test_non_empty_set_dir_is_kept(self, tmp_path: Path) -> None:
        """他リポの WT が残っている場合は rmdir しない"""
        root = tmp_path / "workspaces"
        repo = root / "base" / "myrepo"
        repo.mkdir(parents=True)
        set_dir = root / "wt1"
        set_dir.mkdir()
        (set_dir / "other-repo").mkdir()

        list_output = _porcelain((str(repo), "main"), (str(set_dir / "myrepo"), "wt1"))

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:3] == ["git", "worktree", "list"]:
                return MagicMock(returncode=0, stdout=list_output, stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("subprocess.run", side_effect=fake_run),
        ):
            remove_worktree(cwd=repo, name="wt1")

        assert set_dir.exists()
        assert (set_dir / "other-repo").exists()

    def _run_remove(self, tmp_path: Path, branch_result: MagicMock, keep_branch: bool = False):  # type: ignore[no-untyped-def]
        root = tmp_path / "workspaces"
        repo = root / "base" / "myrepo"
        repo.mkdir(parents=True)
        list_output = _porcelain((str(repo), "main"), (str(root / "wt1" / "myrepo"), "wt1"))

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            if cmd[:3] == ["git", "worktree", "list"]:
                return MagicMock(returncode=0, stdout=list_output, stderr="")
            if cmd[:2] == ["git", "branch"]:
                return branch_result
            return MagicMock(returncode=0, stdout="", stderr="")

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch("subprocess.run", side_effect=fake_run),
        ):
            return remove_worktree(cwd=repo, name="wt1", keep_branch=keep_branch)

    def test_returns_none_when_branch_deleted(self, tmp_path: Path) -> None:
        assert self._run_remove(tmp_path, MagicMock(returncode=0, stdout="", stderr="")) is None

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-09"])
    def test_returns_stderr_when_branch_delete_fails(self, tmp_path: Path) -> None:
        failed = MagicMock(returncode=1, stdout="", stderr="error: branch 'wt1' not found\n")
        assert self._run_remove(tmp_path, failed) == "error: branch 'wt1' not found"

    def test_returns_exit_code_when_stderr_empty(self, tmp_path: Path) -> None:
        failed = MagicMock(returncode=1, stdout="", stderr="")
        assert self._run_remove(tmp_path, failed) == "git branch -D exited with 1"

    def test_returns_none_with_keep_branch(self, tmp_path: Path) -> None:
        failed = MagicMock(returncode=1, stdout="", stderr="boom")
        assert self._run_remove(tmp_path, failed, keep_branch=True) is None


# get_untracked_files のテスト (維持)


class TestGetUntrackedFiles:
    def test_returns_relative_paths(self) -> None:
        mock_output = ".env\nconfig/local.json\n"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=mock_output)
            result = get_untracked_files(Path("/repo"))
        assert result == [Path(".env"), Path("config/local.json")]

    def test_empty_output(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="")
            assert get_untracked_files(Path("/repo")) == []


# filter_copyable_files のテスト (維持)


class TestFilterCopyableFiles:
    def test_filter_excludes(self) -> None:
        spec = _make_spec(
            [
                ".git/",
                "__pycache__/",
                "*.pyc",
                "node_modules/",
            ]
        )
        files = [
            Path(".env"),
            Path(".git/config"),
            Path("__pycache__/foo.pyc"),
            Path("src/app.py"),
            Path("node_modules/pkg/index.js"),
        ]
        result = filter_copyable_files(files, spec)
        assert Path(".env") in result
        assert Path("src/app.py") in result
        assert Path(".git/config") not in result
        assert Path("__pycache__/foo.pyc") not in result
        assert Path("node_modules/pkg/index.js") not in result


class TestShouldExclude:
    def test_default_patterns_cover_legacy_set(self) -> None:
        """現行デフォルト .worktreeignore の 18 項目は全て True になる"""
        from cli.core.worktree_links import DEFAULT_WORKTREEIGNORE_CONTENT

        spec = _make_spec(DEFAULT_WORKTREEIGNORE_CONTENT.splitlines())
        # 以下は DEFAULT に列挙された除外対象（または子ファイル）
        excluded = [
            Path(".git/config"),
            Path("__pycache__/foo.pyc"),
            Path("foo.pyc"),
            Path("foo.pyo"),
            Path(".venv/bin/python"),
            Path("venv/lib/x.so"),
            Path("myproj.egg-info/PKG-INFO"),
            Path(".pytest_cache/CACHEDIR.TAG"),
            Path(".mypy_cache/3.13/foo"),
            Path(".ruff_cache/0.9.0"),
            Path(".tox/py312/bin"),
            Path("htmlcov/index.html"),
            Path(".coverage"),
            Path("dist/foo.whl"),
            Path("build/lib/x.py"),
            Path("node_modules/pkg/index.js"),
            Path(".pecot/config/worktree-config.json"),
            Path("tmp/scratch.txt"),
        ]
        for path in excluded:
            assert _should_exclude(path, spec), f"should exclude: {path}"

    def test_negation_pattern_saves_subpath(self) -> None:
        """`!` 否定パターンで特定サブパスを除外から外せる"""
        spec = _make_spec(
            [
                ".nx/",
                "!.nx/version-plans/",
            ]
        )
        # .nx/ 配下の任意ファイルは除外
        assert _should_exclude(Path(".nx/workspace-data/cache.db"), spec)
        # ただし .nx/version-plans/ 配下は否定で救う
        assert not _should_exclude(Path(".nx/version-plans/my-plan.md"), spec)


# copy_files のテスト (維持)


class TestCopyFiles:
    def test_copies_files(self, tmp_path: Path) -> None:
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        (src / "a.txt").write_text("hello")
        (src / "sub").mkdir()
        (src / "sub" / "b.txt").write_text("world")

        results = copy_files(src, dst, [Path("a.txt"), Path("sub/b.txt")])
        assert all(r.action == "copied" for r in results)
        assert (dst / "a.txt").read_text() == "hello"
        assert (dst / "sub" / "b.txt").read_text() == "world"

    def test_missing_source_skipped(self, tmp_path: Path) -> None:
        src = tmp_path / "src"
        dst = tmp_path / "dst"
        src.mkdir()
        dst.mkdir()
        results = copy_files(src, dst, [Path("missing.txt")])
        assert results[0].action == "skipped"


# is_worktree_env / get_worktree_dirs / get_current_worktree_name (維持)


class TestIsWorktreeEnv:
    def test_main_wt(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout="/repo/.git\n"),
                MagicMock(returncode=0, stdout="/repo/.git\n"),
            ]
            assert is_worktree_env(Path("/repo")) is False

    def test_sub_wt(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout="/repo/.git/worktrees/wt1\n"),
                MagicMock(returncode=0, stdout="/repo/.git\n"),
            ]
            assert is_worktree_env(Path("/repo/wt1")) is True

    def test_not_a_repo_raises(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.CalledProcessError(
                returncode=128, cmd="git", stderr="fatal: not a git repository"
            )
            with pytest.raises(RuntimeError, match="not a git repository"):
                is_worktree_env(Path("/tmp"))


class TestGetCurrentWorktreeName:
    def test_returns_wt_name_from_sub_worktree(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout="/repo/.git/worktrees/wt2\n"),
                MagicMock(returncode=0, stdout="/repo/.git\n"),
                MagicMock(returncode=1, stdout=""),
                MagicMock(returncode=0, stdout="/workspaces/wt2/aist-roadmap\n"),
            ]
            assert get_current_worktree_name(Path("/workspaces/wt2/aist-roadmap")) == "wt2"

    def test_returns_none_for_main_worktree(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout="/repo/.git\n"),
                MagicMock(returncode=0, stdout="/repo/.git\n"),
            ]
            assert get_current_worktree_name(Path("/repo")) is None

    def test_returns_base_for_base_layout(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout="/repo/.git/worktrees/base\n"),
                MagicMock(returncode=0, stdout="/repo/.git\n"),
                MagicMock(returncode=1, stdout=""),
                MagicMock(returncode=0, stdout="/workspaces/base/aist-roadmap\n"),
            ]
            assert get_current_worktree_name(Path("/workspaces/base/aist-roadmap")) == "base"

    def test_returns_none_when_toplevel_fails(self) -> None:
        """記録が無く、--show-toplevel が失敗したら None を返す"""
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout="/repo/.git/worktrees/wt2\n"),
                MagicMock(returncode=0, stdout="/repo/.git\n"),
                MagicMock(returncode=1, stdout=""),
                subprocess.CalledProcessError(128, "git"),
            ]
            assert get_current_worktree_name(Path("/workspaces/wt2/x")) is None

    @add_test_properties(verifies=["PW-PR-CLEANUP-06"])
    def test_returns_recorded_name(self, tmp_path: Path) -> None:
        """記録があれば置き場所の親ディレクトリ名より優先する"""
        marker = tmp_path / "pecot-worktree-name"
        marker.write_text("wt1\n", encoding="utf-8")
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout="/repo/.git/worktrees/x\n"),
                MagicMock(returncode=0, stdout="/repo/.git\n"),
                MagicMock(returncode=0, stdout=f"{marker}\n"),
            ]
            assert get_current_worktree_name(Path("/elsewhere/x")) == "wt1"

    def test_returns_none_when_no_record_and_parent_is_not_wt(self) -> None:
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout="/repo/.git/worktrees/x\n"),
                MagicMock(returncode=0, stdout="/repo/.git\n"),
                MagicMock(returncode=1, stdout=""),
                MagicMock(returncode=0, stdout="/elsewhere/x\n"),
            ]
            assert get_current_worktree_name(Path("/elsewhere/x")) is None


# ensure_devcontainer_environment のテスト


class TestEnsureDevcontainerEnvironment:
    def test_dockerenv_file_present_passes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """/.dockerenv があれば通過（env vars が空でも OK）"""
        for var in ("REMOTE_CONTAINERS", "CODESPACES", "DEVCONTAINER"):
            monkeypatch.delenv(var, raising=False)
        with patch("cli.core.worktree.Path") as mock_path:
            dockerenv_mock = MagicMock()
            dockerenv_mock.exists.return_value = True
            mock_path.return_value = dockerenv_mock
            # 他の Path() 呼び出しには影響しないよう、関数内は /.dockerenv だけ見る
            ensure_devcontainer_environment()

    def test_remote_containers_env_passes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("REMOTE_CONTAINERS", "true")
        monkeypatch.delenv("CODESPACES", raising=False)
        monkeypatch.delenv("DEVCONTAINER", raising=False)
        with patch("cli.core.worktree.Path") as mock_path:
            dockerenv_mock = MagicMock()
            dockerenv_mock.exists.return_value = False
            mock_path.return_value = dockerenv_mock
            ensure_devcontainer_environment()

    def test_codespaces_env_passes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("REMOTE_CONTAINERS", raising=False)
        monkeypatch.setenv("CODESPACES", "true")
        monkeypatch.delenv("DEVCONTAINER", raising=False)
        with patch("cli.core.worktree.Path") as mock_path:
            dockerenv_mock = MagicMock()
            dockerenv_mock.exists.return_value = False
            mock_path.return_value = dockerenv_mock
            ensure_devcontainer_environment()

    def test_devcontainer_env_passes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("REMOTE_CONTAINERS", raising=False)
        monkeypatch.delenv("CODESPACES", raising=False)
        monkeypatch.setenv("DEVCONTAINER", "1")
        with patch("cli.core.worktree.Path") as mock_path:
            dockerenv_mock = MagicMock()
            dockerenv_mock.exists.return_value = False
            mock_path.return_value = dockerenv_mock
            ensure_devcontainer_environment()

    def test_host_environment_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """dockerenv なし & env vars なし → RuntimeError"""
        for var in ("REMOTE_CONTAINERS", "CODESPACES", "DEVCONTAINER"):
            monkeypatch.delenv(var, raising=False)
        with patch("cli.core.worktree.Path") as mock_path:
            dockerenv_mock = MagicMock()
            dockerenv_mock.exists.return_value = False
            mock_path.return_value = dockerenv_mock
            with pytest.raises(RuntimeError) as exc_info:
                ensure_devcontainer_environment()
        msg = str(exc_info.value)
        assert "devcontainer" in msg
        assert "prepare .devcontainer/ in the project" in msg
        assert "Reopen in Container" in msg
        assert "a-dcgen" not in msg


# create_worktree の auto-prune (stale worktree メタデータ自動掃除)


_GIT_ENV_LEAK_KEYS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
)


def _clean_git_env() -> dict[str, str]:
    env = os.environ.copy()
    for key in _GIT_ENV_LEAK_KEYS:
        env.pop(key, None)
    return env


def _git(cwd: Path, *args: str) -> None:
    # env を親から隔離しないと pre-push 配下の GIT_DIR 伝搬で
    # tmp_path ではなく実リポの .git/config に core.bare=true が書かれる
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
        env=_clean_git_env(),
    )


@pytest.mark.skipif(
    not subprocess.run(["which", "git"], capture_output=True).stdout,
    reason="git required",
)
class TestCreateWorktreeAutoPrune:
    """rebuild 後に `.git/worktrees/<name>/` だけ残って実体が消えたケース。

    （stale）で create_worktree が自動 prune → 正常に再作成できることを検証。
    """

    def test_stale_metadata_is_pruned_and_recreated(self, tmp_path: Path) -> None:
        root = tmp_path / "workspaces"
        repo = root / "base" / "myrepo"
        remote = tmp_path / "remotes" / "myrepo"

        # 実 git repo を仕立てる（+ bare origin）
        repo.mkdir(parents=True)
        _git(repo, "init", "--initial-branch=main", "-q")
        _git(repo, "config", "user.email", "t@example.com")
        _git(repo, "config", "user.name", "t")
        (repo / "README.md").write_text("hi")
        _git(repo, "add", ".")
        _git(repo, "commit", "-m", "init", "-q")
        _git(repo, "branch", "develop")
        remote.mkdir(parents=True)
        _git(remote, "init", "--bare", "-q")
        _git(repo, "remote", "add", "origin", str(remote))
        _git(repo, "push", "origin", "main", "-q")
        _git(repo, "push", "origin", "develop", "-q")

        # 必須設定ファイル (worktree-config.json / .worktreeignore) を配置
        from cli.tests.conftest import make_worktree_required_configs

        make_worktree_required_configs(repo, ignore_content=".git/\n")

        # 先に手動で wt1 を作ってから、実体ディレクトリを消して stale 状態を再現
        wt1_path = root / "wt1" / "myrepo"
        _git(repo, "worktree", "add", str(wt1_path), "-b", "wt1", "--track", "origin/develop")
        assert wt1_path.exists()
        # git は worktree メタデータを target-path basename で記録する
        metadata_dir = repo / ".git" / "worktrees" / wt1_path.name
        assert metadata_dir.exists()

        # 実体だけ削除（メタデータは残す）→ stale
        import shutil as _shutil

        _shutil.rmtree(wt1_path)
        assert metadata_dir.exists()  # メタデータはまだ残っている

        # active project config モック（repo 登録済み）
        cfg = MagicMock()
        repo_mock = MagicMock(owner="test-owner", name="myrepo")
        cfg.repositories = [repo_mock]
        cfg.find_repository.side_effect = lambda owner, name: (
            repo_mock if owner == "test-owner" and name == "myrepo" else None
        )
        cfg.get_develop_branch.return_value = "develop"

        with (
            patch("cli.core.worktree.load_active_config", return_value=cfg),
            patch(
                "cli.core.worktree._read_remote_repos",
                return_value=[("origin", RepoRef(owner="test-owner", repo="myrepo"))],
            ),
        ):
            # 既存 wt1 ブランチ（upstream: origin/develop）は再利用
            result = create_worktree(cwd=repo, copy=False, link=False, allow_existing_branch=True)

        # 正常に wt1 が再作成されていること
        assert result.name == "wt1"
        assert result.path == wt1_path
        assert wt1_path.exists()
        # 新しい worktree メタデータ（basename=myrepo）が復活
        assert metadata_dir.exists()

    def test_prune_is_invoked_before_add(self, tmp_path: Path) -> None:
        """`git worktree prune` が main_wt をカレントにして呼ばれることを検証。"""
        root = tmp_path / "workspaces"
        repo = root / "base" / "myrepo"
        repo.mkdir(parents=True)
        # 必須設定ファイル (worktree-config.json / .worktreeignore) を配置
        from cli.tests.conftest import make_worktree_required_configs

        make_worktree_required_configs(repo, ignore_content=".git/\n")

        calls: list[list[str]] = []
        prune_cwd: list[Path] = []

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            calls.append(list(cmd))
            if cmd[:3] == ["git", "worktree", "prune"]:
                prune_cwd.append(Path(kwargs.get("cwd")))
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:3] == ["git", "worktree", "add"]:
                Path(cmd[3]).mkdir(parents=True, exist_ok=True)
                return MagicMock(returncode=0, stdout="", stderr="")
            if cmd[:2] == ["git", "show-ref"]:
                return MagicMock(returncode=1, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")

        cfg = MagicMock()
        cfg.repositories = [MagicMock(owner="test-owner", name="myrepo")]
        cfg.find_repository.return_value = MagicMock()
        cfg.get_develop_branch.return_value = "develop"

        with (
            patch("cli.core.worktree.find_main_worktree", return_value=repo),
            patch(
                "cli.core.worktree._read_remote_repos",
                return_value=[("origin", MagicMock(owner="test-owner", repo="myrepo"))],
            ),
            patch("cli.core.worktree.load_active_config", return_value=cfg),
            patch("cli.core.worktree.get_untracked_files", return_value=[]),
            patch("subprocess.run", side_effect=fake_run),
        ):
            create_worktree(cwd=repo, base_branch="develop", copy=False, link=False)

        # prune が呼ばれ、main_wt がカレントであること
        prune_calls = [c for c in calls if c[:3] == ["git", "worktree", "prune"]]
        add_calls = [c for c in calls if c[:3] == ["git", "worktree", "add"]]
        assert len(prune_calls) == 1
        assert len(add_calls) == 1
        assert prune_cwd == [repo]
        # prune は add より前に呼ばれている
        prune_idx = calls.index(prune_calls[0])
        add_idx = calls.index(add_calls[0])
        assert prune_idx < add_idx


@pytest.mark.skipif(
    not subprocess.run(["which", "git"], capture_output=True).stdout,
    reason="git required",
)
class TestCreateWorktreePrimaryRemote:
    """origin の無いリポで使う remote を決める（実 git で remote の選択まで通す）"""

    def _make_repo(
        self,
        tmp_path: Path,
        remote_names: list[str],
        repo_names: dict[str, str] | None = None,
    ) -> tuple[Path, Path]:
        """remote の URL は GitHub の形に置く（push のあとで置くので remote-tracking の ref は残る）

        repo_names: remote 名 -> 指すリポ名（省略した remote は myrepo）
        """
        from cli.tests.conftest import make_worktree_required_configs

        root = tmp_path / "workspaces"
        repo = root / "base" / "myrepo"
        repo.mkdir(parents=True)
        _git(repo, "init", "--initial-branch=main", "-q")
        _git(repo, "config", "user.email", "t@example.com")
        _git(repo, "config", "user.name", "t")
        (repo / "README.md").write_text("hi")
        _git(repo, "add", ".")
        _git(repo, "commit", "-m", "init", "-q")
        _git(repo, "branch", "develop")
        for remote_name in remote_names:
            remote = tmp_path / "remotes" / remote_name
            remote.mkdir(parents=True)
            _git(remote, "init", "--bare", "-q")
            _git(repo, "remote", "add", remote_name, str(remote))
            _git(repo, "push", remote_name, "main", "develop", "-q")
            repo_name = (repo_names or {}).get(remote_name, "myrepo")
            _git(
                repo,
                "remote",
                "set-url",
                remote_name,
                f"https://github.com/test-owner/{repo_name}.git",
            )
        make_worktree_required_configs(repo, ignore_content=".git/\n")
        return root, repo

    def _config(self) -> MagicMock:
        """test-owner/myrepo だけが登録済み"""
        cfg = MagicMock()
        repo_mock = MagicMock(owner="test-owner", name="myrepo")
        cfg.repositories = [repo_mock]
        cfg.find_repository.side_effect = lambda owner, name: (
            repo_mock if owner == "test-owner" and name == "myrepo" else None
        )
        cfg.get_develop_branch.return_value = "develop"
        return cfg

    def _create(self, repo: Path, **kwargs: bool) -> WorktreeCreateResult:
        with patch("cli.core.worktree.load_active_config", return_value=self._config()):
            return create_worktree(cwd=repo, copy=False, link=False, **kwargs)

    def _upstream(self, repo: Path, branch: str) -> str:
        return subprocess.run(
            ["git", "for-each-ref", "--format=%(upstream:short)", f"refs/heads/{branch}"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
            env=_clean_git_env(),
        ).stdout.strip()

    @add_test_properties(verifies=["PW-WORKTREE-ADD-02", "PW-WORKTREE-ADD-06"])
    def test_upstream_is_first_remote_without_origin(self, tmp_path: Path) -> None:
        _root, repo = self._make_repo(tmp_path, ["upstream"])

        self._create(repo)

        assert self._upstream(repo, "wt1") == "upstream/develop"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-02", "PW-WORKTREE-ADD-06"])
    def test_upstream_is_origin_when_origin_and_other_remote_exist(self, tmp_path: Path) -> None:
        _root, repo = self._make_repo(tmp_path, ["aaa", "origin"])

        self._create(repo)

        assert self._upstream(repo, "wt1") == "origin/develop"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-45", "PW-WORKTREE-ADD-46"])
    def test_existing_branch_is_compared_with_first_remote_upstream(self, tmp_path: Path) -> None:
        _root, repo = self._make_repo(tmp_path, ["upstream", "zzz"])
        _git(repo, "branch", "--track", "wt1", "zzz/develop")

        with pytest.raises(RuntimeError) as exc:
            self._create(repo)

        message = str(exc.value)
        assert "current: zzz/develop" in message
        assert "expected: upstream/develop" in message

    @add_test_properties(verifies=["PW-WORKTREE-ADD-39"])
    def test_no_remote_stops_without_creating_worktree(self, tmp_path: Path) -> None:
        root, repo = self._make_repo(tmp_path, [])

        with (
            patch("cli.core.worktree.load_active_config", return_value=self._config()),
            pytest.raises(RuntimeError) as exc,
        ):
            create_worktree(cwd=repo, copy=False, link=False)

        assert str(exc.value) == (
            "cannot get the repository information: "
            "check that a git remote is set to a GitHub repository URL"
        )
        assert not (root / "wt1").exists()

    @add_test_properties(verifies=["PW-WORKTREE-ADD-02"])
    def test_existing_branch_matching_first_remote_upstream_is_reused(self, tmp_path: Path) -> None:
        _root, repo = self._make_repo(tmp_path, ["upstream"])
        _git(repo, "branch", "--track", "wt1", "upstream/develop")

        result = self._create(repo, allow_existing_branch=True)

        assert result.path.exists()
        assert self._upstream(repo, "wt1") == "upstream/develop"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-52"])
    def test_registered_remote_is_used_without_origin(self, tmp_path: Path) -> None:
        _root, repo = self._make_repo(tmp_path, ["fork", "upstream"], {"fork": "other"})

        self._create(repo)

        assert self._upstream(repo, "wt1") == "upstream/develop"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-37", "PW-WORKTREE-ADD-52"])
    def test_first_remote_is_reported_when_none_is_registered(self, tmp_path: Path) -> None:
        root, repo = self._make_repo(
            tmp_path, ["fork", "upstream"], {"fork": "other", "upstream": "another"}
        )

        with pytest.raises(RuntimeError) as exc:
            self._create(repo)

        assert "repository test-owner/other is not registered" in str(exc.value)
        assert not (root / "wt1").exists()
