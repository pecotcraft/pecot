"""tests/e2e/test_worktree_project_set.py - プロジェクト単位 wtN 構成 E2E

tmp_path に擬似プロジェクト (base/repo-A / base/repo-B) を git init で構築する。
create_worktree → create_symlinks → remove_worktree の一連のフローが期待通り動作することを検証する。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from cli.core.paths import WORKTREE_CONFIG_FILENAME, WORKTREE_IGNORE_FILENAME
from cli.core.worktree import create_worktree, remove_worktree
from cli.core.worktree_links import (
    DEFAULT_WORKTREEIGNORE_CONTENT,
    WorktreeConfig,
    WorktreeLinkItem,
    _compute_relative_target,
    create_symlinks_safe,
    get_default_config,
    save_config,
)


def _write_default_ignore(main_wt: Path) -> None:
    """create_worktree が必須にしている .worktreeignore を仕立てる

    e2e では worktree-config.json 側を各テストが事前に ``save_config`` で置く。
    そのためこの helper では ignore 側だけ DEFAULT 内容で配置する。
    """
    ignore_path = main_wt / WORKTREE_IGNORE_FILENAME
    ignore_path.parent.mkdir(parents=True, exist_ok=True)
    ignore_path.write_text(DEFAULT_WORKTREEIGNORE_CONTENT, encoding="utf-8")


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


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    # env を親から隔離しないと pre-push 配下の GIT_DIR 伝搬で
    # tmp_path ではなく実リポの .git/config に core.bare=true が書かれる
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
        env=_clean_git_env(),
    )


def _init_repo(repo_dir: Path, default_branch: str = "develop") -> None:
    repo_dir.mkdir(parents=True, exist_ok=True)
    _git(repo_dir, "init", "--initial-branch=main", "-q")
    _git(repo_dir, "config", "user.email", "test@example.com")
    _git(repo_dir, "config", "user.name", "Test")
    (repo_dir / "README.md").write_text("hi")
    _git(repo_dir, "add", ".")
    _git(repo_dir, "commit", "-m", "init", "-q")
    # develop ブランチを作成して upstream エミュレーション用に remote を仕立てる
    _git(repo_dir, "branch", default_branch)


def _setup_remote(repo_dir: Path, remote_dir: Path, branch: str, repo_name: str) -> None:
    """擬似 origin リモートを bare リポで作る"""
    remote_dir.mkdir(parents=True, exist_ok=True)
    _git(remote_dir, "init", "--bare", "-q")
    _git(repo_dir, "remote", "add", "origin", str(remote_dir))
    _git(repo_dir, "push", "origin", "main", "-q")
    _git(repo_dir, "push", "origin", branch, "-q")


def _build_project(tmp_path: Path) -> tuple[Path, Path, Path]:
    """<root>/base/repo-A / <root>/base/repo-B / aist-roadmap を構築"""
    root = tmp_path / "workspaces"
    base = root / "base"
    base.mkdir(parents=True)

    repo_a = base / "repo-A"
    repo_b = base / "repo-B"
    roadmap = base / "aist-roadmap"

    for r in (repo_a, repo_b, roadmap):
        _init_repo(r, default_branch="develop")
        _setup_remote(r, tmp_path / "remotes" / r.name, branch="develop", repo_name=r.name)

    # aist-roadmap に共有ターゲット設置
    (roadmap / "CLAUDE.local.md").write_text("shared-local")
    (roadmap / ".claude").mkdir()
    (roadmap / ".claude" / "settings.local.json").write_text("{}")

    return root, repo_a, repo_b


@pytest.mark.skipif(
    not subprocess.run(["which", "git"], capture_output=True).stdout,
    reason="git required",
)
class TestProjectSetE2E:
    def test_two_repos_share_wt1(self, tmp_path: Path) -> None:
        root, repo_a, repo_b = _build_project(tmp_path)

        # 各リポに worktree-config.json (v3) を配置
        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path="CLAUDE.local.md",
                    target_repo="aist-roadmap",
                    target_path="CLAUDE.local.md",
                ),
                WorktreeLinkItem(
                    path=".claude/settings.local.json",
                    target_repo="aist-roadmap",
                    target_path=".claude/settings.local.json",
                ),
            ]
        )
        save_config(config, repo_a / WORKTREE_CONFIG_FILENAME)
        save_config(config, repo_b / WORKTREE_CONFIG_FILENAME)
        _write_default_ignore(repo_a)
        _write_default_ignore(repo_b)

        # active project 設定のモック (repo-A, repo-B 登録済み)
        cfg = MagicMock()
        repo_a_mock = MagicMock(owner="test-owner", name="repo-A")
        repo_b_mock = MagicMock(owner="test-owner", name="repo-B")
        cfg.repositories = [repo_a_mock, repo_b_mock]
        cfg.find_repository.side_effect = lambda owner, name: (
            {"repo-A": repo_a_mock, "repo-B": repo_b_mock}.get(name)
            if owner == "test-owner"
            else None
        )
        cfg.get_develop_branch.return_value = "develop"

        # 実際の origin URL はローカル bare リポなので
        # origin_repo が None を返す。cwd から repo 名を決めて返すモック。
        def fake_origin_repo(cwd: Path | None = None) -> tuple[str, str, str]:
            name = Path(cwd).name if cwd else ""
            return ("github.com", "test-owner", name)

        # wt1 を両リポで作成
        with (
            patch("cli.core.worktree.load_active_config", return_value=cfg),
            patch(
                "cli.core.worktree.origin_repo",
                side_effect=fake_origin_repo,
            ),
        ):
            result_a = create_worktree(
                cwd=repo_a,
                name="wt1",
                base_branch="develop",
                copy=False,
            )
            result_b = create_worktree(
                cwd=repo_b,
                name="wt1",
                base_branch="develop",
                copy=False,
            )

        # 配置検証
        assert result_a.path == root / "wt1" / "repo-A"
        assert result_b.path == root / "wt1" / "repo-B"
        assert result_a.path.exists()
        assert result_b.path.exists()

        # symlink 検証 (CLAUDE.local.md: 2段)
        link_a = result_a.path / "CLAUDE.local.md"
        assert link_a.is_symlink()
        assert os.readlink(link_a) == "../../base/aist-roadmap/CLAUDE.local.md"
        assert link_a.resolve().read_text() == "shared-local"

        # symlink 検証 (ネスト: 3段)
        link_nested = result_a.path / ".claude" / "settings.local.json"
        assert link_nested.is_symlink()
        assert os.readlink(link_nested) == "../../../base/aist-roadmap/.claude/settings.local.json"

        # remove_worktree: 1 リポ削除しても wt1/ はまだ残る
        remove_worktree(cwd=repo_a, name="wt1", force=True)
        assert not (root / "wt1" / "repo-A").exists()
        assert (root / "wt1" / "repo-B").exists()
        assert (root / "wt1").exists()

        # 両リポ削除すると wt1/ も消える
        remove_worktree(cwd=repo_b, name="wt1", force=True)
        assert not (root / "wt1").exists()

    def test_auto_name_aligns_across_repos(self, tmp_path: Path) -> None:
        """name 省略で add を両リポに連打すると自動で同じ wt1 に揃う"""
        root, repo_a, repo_b = _build_project(tmp_path)

        # 必須設定ファイル（worktree-config.json / .worktreeignore）を両リポに配置
        empty_config = WorktreeConfig(links=[])
        save_config(empty_config, repo_a / WORKTREE_CONFIG_FILENAME)
        save_config(empty_config, repo_b / WORKTREE_CONFIG_FILENAME)
        _write_default_ignore(repo_a)
        _write_default_ignore(repo_b)

        cfg = MagicMock()
        repo_a_mock = MagicMock(owner="test-owner", name="repo-A")
        repo_b_mock = MagicMock(owner="test-owner", name="repo-B")
        cfg.repositories = [repo_a_mock, repo_b_mock]
        cfg.find_repository.side_effect = lambda owner, name: (
            {"repo-A": repo_a_mock, "repo-B": repo_b_mock}.get(name)
            if owner == "test-owner"
            else None
        )
        cfg.get_develop_branch.return_value = "develop"

        def fake_origin_repo(cwd: Path | None = None) -> tuple[str, str, str]:
            name = Path(cwd).name if cwd else ""
            return ("github.com", "test-owner", name)

        with (
            patch("cli.core.worktree.load_active_config", return_value=cfg),
            patch(
                "cli.core.worktree.origin_repo",
                side_effect=fake_origin_repo,
            ),
        ):
            # repo-A: 最初の add → wt1
            result_a = create_worktree(cwd=repo_a, copy=False, link=False)
            # repo-B: 2回目の add (name 省略) → wt1/repo-B が無いので wt1 に参加
            result_b = create_worktree(cwd=repo_b, copy=False, link=False)

        assert result_a.name == "wt1"
        assert result_b.name == "wt1"
        assert result_a.path == root / "wt1" / "repo-A"
        assert result_b.path == root / "wt1" / "repo-B"

        # 片付け
        with patch("cli.core.worktree.load_active_config", return_value=cfg):
            remove_worktree(cwd=repo_a, name="wt1", force=True)
            remove_worktree(cwd=repo_b, name="wt1", force=True)

    def test_pecot_work_shared_via_self_link(self, tmp_path: Path) -> None:
        """`.pecot/work` の self link で main WT の作業ファイル置き場が WT 間共有される"""
        root, repo_a, _ = _build_project(tmp_path)

        # main WT 側に .pecot/work 実体を用意（pecot-dir-init 相当）
        work_root = repo_a / ".pecot" / "work"
        work_root.mkdir(parents=True)
        (work_root / "100").mkdir()
        (work_root / "100" / "note.md").write_text("from-base")

        config = get_default_config(target_repo="repo-A", self_repo="repo-A")
        save_config(config, repo_a / WORKTREE_CONFIG_FILENAME)
        _write_default_ignore(repo_a)

        cfg = MagicMock()
        repo_a_mock = MagicMock(owner="test-owner", name="repo-A")
        cfg.repositories = [repo_a_mock]
        cfg.find_repository.side_effect = lambda owner, name: (
            repo_a_mock if owner == "test-owner" and name == "repo-A" else None
        )
        cfg.get_develop_branch.return_value = "develop"

        def fake_origin_repo(cwd: Path | None = None) -> tuple[str, str, str]:
            name = Path(cwd).name if cwd else ""
            return ("github.com", "test-owner", name)

        with (
            patch("cli.core.worktree.load_active_config", return_value=cfg),
            patch(
                "cli.core.worktree.origin_repo",
                side_effect=fake_origin_repo,
            ),
        ):
            result = create_worktree(
                cwd=repo_a,
                name="wt1",
                base_branch="develop",
                copy=False,
            )

        link = result.path / ".pecot" / "work"
        assert link.is_symlink()
        work_link_item = next((item for item in config.links if item.path == ".pecot/work"), None)
        assert work_link_item is not None
        assert os.readlink(link) == _compute_relative_target(work_link_item)
        # main WT の内容が WT 側から見える
        assert (link / "100" / "note.md").read_text() == "from-base"
        # WT 側からの書き込みが main WT に残る
        (link / "200").mkdir()
        (link / "200" / "evidence.txt").write_text("from-wt")
        assert (work_root / "200" / "evidence.txt").read_text() == "from-wt"

        # 片付け
        with patch("cli.core.worktree.load_active_config", return_value=cfg):
            remove_worktree(cwd=repo_a, name="wt1", force=True)
        # WT 削除後も main WT の共有実体は残る
        assert (work_root / "200" / "evidence.txt").exists()

    def test_pecot_work_real_dir_preserved_on_safe_skip(self, tmp_path: Path) -> None:
        """WT 側に中身入りの実ディレクトリ .pecot/work が既存のときの動作を確認する。

        create_symlinks_safe(force=False, confirm_callback=None) は action="skipped" を返す。
        実ディレクトリとその中身を保持する（F-01 回帰テスト）。
        """
        root, repo_a, _ = _build_project(tmp_path)

        # main WT 側に .pecot/work ターゲットを用意
        work_target = repo_a / ".pecot" / "work"
        work_target.mkdir(parents=True)

        # WT 側に中身入りの実ディレクトリを配置
        wt_work = root / "wt1" / "repo-A" / ".pecot" / "work"
        wt_work.mkdir(parents=True)
        (wt_work / "existing.txt").write_text("do-not-remove")

        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path=".pecot/work",
                    target_repo="repo-A",
                    target_path=".pecot/work",
                ),
            ]
        )

        results = create_symlinks_safe(
            config,
            project_root=root,
            set_name="wt1",
            repo_name="repo-A",
            force=False,
            confirm_callback=None,
        )

        assert len(results) == 1
        result = results[0]
        assert result.action == "skipped"
        # 実ディレクトリは symlink に置き換えられていない
        assert wt_work.is_dir() and not wt_work.is_symlink()
        # 中身も保持されている
        assert (wt_work / "existing.txt").read_text() == "do-not-remove"

    def test_setup_command_from_config_executed(self, tmp_path: Path) -> None:
        """config.setup_command が WT 作成直後に実行され結果が SetupResult に載る"""
        root, repo_a, _ = _build_project(tmp_path)

        # setup_command 付きの config (v3) を repo_a に配置
        marker = tmp_path / "marker.txt"
        config = WorktreeConfig(
            setup_command=f"echo from-config > {marker}",
        )
        save_config(config, repo_a / WORKTREE_CONFIG_FILENAME)
        _write_default_ignore(repo_a)

        cfg = MagicMock()
        repo_a_mock = MagicMock(owner="test-owner", name="repo-A")
        cfg.repositories = [repo_a_mock]
        cfg.find_repository.side_effect = lambda owner, name: (
            repo_a_mock if owner == "test-owner" and name == "repo-A" else None
        )
        cfg.get_develop_branch.return_value = "develop"

        def fake_origin_repo(cwd: Path | None = None) -> tuple[str, str, str]:
            name = Path(cwd).name if cwd else ""
            return ("github.com", "test-owner", name)

        with (
            patch("cli.core.worktree.load_active_config", return_value=cfg),
            patch(
                "cli.core.worktree.origin_repo",
                side_effect=fake_origin_repo,
            ),
        ):
            result = create_worktree(
                cwd=repo_a,
                name="wt1",
                base_branch="develop",
                copy=False,
                link=False,
            )

        assert result.setup_result is not None
        assert result.setup_result.returncode == 0
        assert result.setup_result.command.startswith("echo from-config")
        assert marker.exists()
        assert marker.read_text().strip() == "from-config"

        # 片付け
        with patch("cli.core.worktree.load_active_config", return_value=cfg):
            remove_worktree(cwd=repo_a, name="wt1", force=True)


@pytest.mark.skipif(
    not subprocess.run(["which", "git"], capture_output=True).stdout,
    reason="git required",
)
class TestWorktreeOrphanBranchE2E:
    def test_orphan_branch_is_recreated_from_latest_upstream(self, tmp_path: Path) -> None:
        """prune 後も残る孤児ローカルブランチが再 add で最新 tip から作り直される。

        再現: wt1 作成 → 実体と .git/worktrees/wt1 を削除（refs/heads/wt1 は残す）
        → upstream に新 commit → 再 add。修正前は古い tip で checkout されていた。
        """
        import shutil

        root = tmp_path / "workspaces"
        base = root / "base"
        base.mkdir(parents=True)
        repo = base / "myrepo"
        _init_repo(repo, default_branch="develop")
        _setup_remote(repo, tmp_path / "remotes" / "myrepo", branch="develop", repo_name="myrepo")

        save_config(WorktreeConfig(links=[]), repo / WORKTREE_CONFIG_FILENAME)
        _write_default_ignore(repo)

        cfg = MagicMock()
        repo_mock = MagicMock(owner="test-owner", name="myrepo")
        cfg.repositories = [repo_mock]
        cfg.find_repository.return_value = repo_mock
        cfg.get_develop_branch.return_value = "develop"

        def fake_origin_repo(cwd: Path | None = None) -> tuple[str, str, str]:
            return ("github.com", "test-owner", "myrepo")

        with (
            patch("cli.core.worktree.load_active_config", return_value=cfg),
            patch(
                "cli.core.worktree.origin_repo",
                side_effect=fake_origin_repo,
            ),
        ):
            first = create_worktree(
                cwd=repo, name="wt1", base_branch="develop", copy=False, link=False
            )
            initial_tip = _git(first.path, "rev-parse", "HEAD").stdout.strip()

            # 孤児化: 実体ディレクトリを消す。
            # .git/worktrees メタデータは create_worktree 内部の `git worktree prune` が掃除する。
            # そのため refs/heads/wt1 だけが残った「孤児ブランチ」状態になる。
            shutil.rmtree(first.path)

            # upstream 側を進める
            _git(repo, "checkout", "develop", "-q")
            (repo / "advance.md").write_text("advance")
            _git(repo, "add", ".")
            _git(repo, "commit", "-m", "advance tip", "-q")
            _git(repo, "push", "origin", "develop", "-q")
            _git(repo, "fetch", "origin", "-q")
            new_tip = _git(repo, "rev-parse", "origin/develop").stdout.strip()
            assert new_tip != initial_tip

            # refs/heads/wt1 はまだ古い tip を指している（= 孤児 & stale）
            stale_wt1_tip = _git(repo, "rev-parse", "wt1").stdout.strip()
            assert stale_wt1_tip == initial_tip

            second = create_worktree(
                cwd=repo, name="wt1", base_branch="develop", copy=False, link=False
            )

        head_after = _git(second.path, "rev-parse", "HEAD").stdout.strip()
        assert head_after == new_tip, (
            f"orphan branch should be recreated from origin/develop tip "
            f"(expected {new_tip[:7]}, got {head_after[:7]})"
        )
        upstream_after = _git(
            repo, "for-each-ref", "--format=%(upstream:short)", "refs/heads/wt1"
        ).stdout.strip()
        assert upstream_after == "origin/develop"
