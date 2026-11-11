"""tests/core/test_worktree_links.py - worktree_links.py のテスト (v3)"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError

from cli.core.paths import WORKTREE_CONFIG_FILENAME, WORKTREE_IGNORE_FILENAME
from cli.core.worktree_links import (
    DEFAULT_WORKTREEIGNORE_CONTENT,
    WorktreeConfig,
    WorktreeConfigError,
    WorktreeLinkItem,
    _pecot_gitignore_ensure_script,
    _process_link,
    create_symlinks,
    create_symlinks_safe,
    get_default_config,
    load_config,
    load_copy_exclude_spec,
    save_config,
)
from cli.tests.conftest import git_init_and_commit

# WorktreeLinkItem


class TestWorktreeLinkItem:
    def test_basic(self) -> None:
        item = WorktreeLinkItem(
            path="CLAUDE.local.md",
            target_repo="aist-roadmap",
            target_path="CLAUDE.local.md",
        )
        assert item.path == "CLAUDE.local.md"
        assert item.target_repo == "aist-roadmap"
        assert item.target_path == "CLAUDE.local.md"

    def test_nested_path(self) -> None:
        item = WorktreeLinkItem(
            path=".claude/settings.local.json",
            target_repo="aist-roadmap",
            target_path=".claude/settings.local.json",
        )
        assert item.path == ".claude/settings.local.json"

    def test_absolute_path_rejected(self) -> None:
        with pytest.raises(ValidationError):
            WorktreeLinkItem(path="/abs", target_repo="repo", target_path="x")

    def test_parent_path_rejected(self) -> None:
        with pytest.raises(ValidationError):
            WorktreeLinkItem(path="../foo", target_repo="repo", target_path="x")

    def test_target_repo_with_slash_rejected(self) -> None:
        with pytest.raises(ValidationError):
            WorktreeLinkItem(path="x", target_repo="a/b", target_path="x")

    def test_empty_target_repo_rejected(self) -> None:
        with pytest.raises(ValidationError):
            WorktreeLinkItem(path="x", target_repo="", target_path="x")


# WorktreeConfig


class TestWorktreeConfig:
    def test_default(self) -> None:
        config = WorktreeConfig()
        assert config.version == 3
        assert config.links == []
        assert config.setup_command is None

    def test_version_must_be_3(self) -> None:
        with pytest.raises(ValidationError):
            WorktreeConfig(version=2)  # type: ignore[arg-type]

    def test_setup_command_accepted(self) -> None:
        config = WorktreeConfig(setup_command="uv sync")
        assert config.setup_command == "uv sync"

    def test_setup_command_timeout_accepted(self) -> None:
        config = WorktreeConfig(setup_command_timeout=600)
        assert config.setup_command_timeout == 600

    def test_setup_command_timeout_zero_rejected(self) -> None:
        with pytest.raises(ValidationError):
            WorktreeConfig(setup_command_timeout=0)

    def test_setup_command_timeout_negative_rejected(self) -> None:
        with pytest.raises(ValidationError):
            WorktreeConfig(setup_command_timeout=-1)


# load_config / save_config


class TestLoadSaveConfig:
    def test_roundtrip(self, tmp_path: Path) -> None:
        config = WorktreeConfig(
            description="test",
            links=[
                WorktreeLinkItem(
                    path="CLAUDE.local.md",
                    target_repo="aist-roadmap",
                    target_path="CLAUDE.local.md",
                ),
            ],
        )
        path = tmp_path / "config.json"
        save_config(config, path)
        loaded = load_config(path)
        assert loaded.version == 3
        assert loaded.links[0].path == "CLAUDE.local.md"
        assert loaded.links[0].target_repo == "aist-roadmap"
        assert loaded.setup_command is None

    def test_roundtrip_with_setup_command(self, tmp_path: Path) -> None:
        """setup_command を含む round-trip"""
        config = WorktreeConfig(
            setup_command="bash -lc 'uv sync && pnpm install'",
            links=[
                WorktreeLinkItem(
                    path="CLAUDE.local.md",
                    target_repo="aist-roadmap",
                    target_path="CLAUDE.local.md",
                ),
            ],
        )
        path = tmp_path / "config.json"
        save_config(config, path)

        # JSON に setup_command フィールドが直接現れていること
        raw = json.loads(path.read_text())
        assert raw["setup_command"] == "bash -lc 'uv sync && pnpm install'"
        assert raw["version"] == 3

        loaded = load_config(path)
        assert loaded.setup_command == "bash -lc 'uv sync && pnpm install'"

    def test_setup_command_omitted_when_none(self, tmp_path: Path) -> None:
        """setup_command が None のとき JSON には書き出さない"""
        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path="CLAUDE.local.md",
                    target_repo="aist-roadmap",
                    target_path="CLAUDE.local.md",
                ),
            ],
        )
        path = tmp_path / "config.json"
        save_config(config, path)
        raw = json.loads(path.read_text())
        assert "setup_command" not in raw

    def test_missing_file_raises(self, tmp_path: Path) -> None:
        with pytest.raises(WorktreeConfigError, match="not found"):
            load_config(tmp_path / "missing.json")

    def test_invalid_json_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "bad.json"
        path.write_text("{ not json")
        with pytest.raises(WorktreeConfigError, match="parse error"):
            load_config(path)

    def test_version_2_rejected(self, tmp_path: Path) -> None:
        """旧 v2 スキーマは受理しない（後方互換なし）"""
        path = tmp_path / "old.json"
        path.write_text(
            json.dumps(
                {
                    "version": 2,
                    "links": [
                        {
                            "path": ".env",
                            "target_repo": "r",
                            "target_path": ".env",
                        }
                    ],
                }
            )
        )
        with pytest.raises(WorktreeConfigError):
            load_config(path)


# get_default_config


class TestGetDefaultConfig:
    def test_target_repo_is_shared_by_three_links(self) -> None:
        config = get_default_config("my-shared")
        assert config.version == 3
        paths = [link.path for link in config.links]
        assert paths == ["CLAUDE.local.md", ".env", ".claude/settings.local.json"]
        assert all(link.target_repo == "my-shared" for link in config.links)
        assert config.setup_command is None

    def test_default_omits_self_links(self) -> None:
        """self_repo 未指定時は hooks-config.json / projects/.active / .pecot/work の link を含まない"""
        config = get_default_config("shared")
        paths = [link.path for link in config.links]
        assert ".pecot/config/hooks-config.json" not in paths
        assert ".pecot/config/projects/.active" not in paths
        assert ".pecot/work" not in paths

    def test_self_repo_adds_self_links(self) -> None:
        """self_repo 指定時は hooks-config.json / projects/.active / .pecot/work の link が追加される"""
        config = get_default_config(target_repo="shared", self_repo="myrepo")
        by_path = {link.path: link for link in config.links}
        hooks = by_path[".pecot/config/hooks-config.json"]
        active = by_path[".pecot/config/projects/.active"]
        work = by_path[".pecot/work"]
        assert hooks.target_repo == "myrepo"
        assert hooks.target_path == ".pecot/config/hooks-config.json"
        assert active.target_repo == "myrepo"
        assert active.target_path == ".pecot/config/projects/.active"
        assert work.target_repo == "myrepo"
        assert work.target_path == ".pecot/work"
        # 共有 link 側の target_repo は影響を受けない
        assert by_path["CLAUDE.local.md"].target_repo == "shared"

    def test_default_serializes_without_setup_command(self, tmp_path: Path) -> None:
        """デフォルト template の save 結果に setup_command キーが出ない"""
        config = get_default_config("shared")
        path = tmp_path / "config.json"
        save_config(config, path)
        raw = json.loads(path.read_text())
        assert "setup_command" not in raw


# DEFAULT_WORKTREEIGNORE_CONTENT


class TestDefaultWorktreeIgnore:
    def test_includes_common_patterns(self) -> None:
        lines = DEFAULT_WORKTREEIGNORE_CONTENT.splitlines()
        for pattern in (".git/", "__pycache__/", "node_modules/", ".pecot/", "tmp/"):
            assert pattern in lines, f"{pattern} がデフォルト .worktreeignore に含まれていない"

    def test_includes_nx_workspace_data(self) -> None:
        """Nx ビルド状態は WT 間で共有させない"""
        assert ".nx/workspace-data/" in DEFAULT_WORKTREEIGNORE_CONTENT.splitlines()


# create_symlinks (中心となるテスト)


def _setup_project(tmp_path: Path) -> Path:
    """<root>/base/aist-roadmap と <root>/base/myrepo を構築"""
    root = tmp_path / "workspaces"
    (root / "base" / "aist-roadmap").mkdir(parents=True)
    (root / "base" / "myrepo").mkdir(parents=True)
    # ターゲットファイル作成
    (root / "base" / "aist-roadmap" / "CLAUDE.local.md").write_text("shared")
    (root / "base" / "aist-roadmap" / ".claude").mkdir()
    (root / "base" / "aist-roadmap" / ".claude" / "settings.local.json").write_text("{}")
    # wt1 set ディレクトリ (空)
    (root / "wt1" / "myrepo").mkdir(parents=True)
    return root


class TestCreateSymlinks:
    def test_root_path_two_levels(self, tmp_path: Path) -> None:
        """ルート直下パス (CLAUDE.local.md) は 2 段相対リンク"""
        root = _setup_project(tmp_path)
        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path="CLAUDE.local.md",
                    target_repo="aist-roadmap",
                    target_path="CLAUDE.local.md",
                )
            ]
        )

        results = create_symlinks(config, root, "wt1", "myrepo")

        assert len(results) == 1
        assert results[0].action == "created"

        symlink = root / "wt1" / "myrepo" / "CLAUDE.local.md"
        assert symlink.is_symlink()
        link_target = os.readlink(symlink)
        assert link_target == "../../base/aist-roadmap/CLAUDE.local.md"
        # dangling でないこと
        assert symlink.resolve().read_text() == "shared"

    def test_nested_path_three_levels(self, tmp_path: Path) -> None:
        """ネストパス (.claude/settings.local.json) は 3 段相対リンク"""
        root = _setup_project(tmp_path)
        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path=".claude/settings.local.json",
                    target_repo="aist-roadmap",
                    target_path=".claude/settings.local.json",
                )
            ]
        )

        results = create_symlinks(config, root, "wt1", "myrepo")

        assert results[0].action == "created"
        symlink = root / "wt1" / "myrepo" / ".claude" / "settings.local.json"
        assert symlink.is_symlink()
        link_target = os.readlink(symlink)
        assert link_target == "../../../base/aist-roadmap/.claude/settings.local.json"
        assert symlink.resolve().read_text() == "{}"

    def test_target_missing_skipped(self, tmp_path: Path) -> None:
        root = _setup_project(tmp_path)
        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path=".env",
                    target_repo="aist-roadmap",
                    target_path=".env",
                )
            ]
        )
        results = create_symlinks(config, root, "wt1", "myrepo")
        assert results[0].action == "skipped"

    def test_dangling_symlink_target_skipped(self, tmp_path: Path) -> None:
        """ターゲットが dangling symlink の場合は skipped になり識別可能な message を返す"""
        root = _setup_project(tmp_path)
        # base/aist-roadmap/dangling.md を dangling symlink として置く
        dangling = root / "base" / "aist-roadmap" / "dangling.md"
        dangling.symlink_to("/nonexistent/target")
        assert not dangling.exists()
        assert dangling.is_symlink()

        link = WorktreeLinkItem(
            path="dangling.md",
            target_repo="aist-roadmap",
            target_path="dangling.md",
        )
        result = _process_link(link, root, "wt1", "myrepo", lambda _p, _t: True)

        assert result.action == "skipped"
        assert "dangling" in result.message

    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        root = _setup_project(tmp_path)
        # wt1/myrepo だけ存在、中間ディレクトリなし
        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path=".claude/settings.local.json",
                    target_repo="aist-roadmap",
                    target_path=".claude/settings.local.json",
                )
            ]
        )
        results = create_symlinks(config, root, "wt1", "myrepo")
        assert results[0].action == "created"
        assert (root / "wt1" / "myrepo" / ".claude").is_dir()

    def test_replaces_existing_symlink(self, tmp_path: Path) -> None:
        root = _setup_project(tmp_path)
        existing = root / "wt1" / "myrepo" / "CLAUDE.local.md"
        existing.symlink_to("/tmp/old-target")

        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path="CLAUDE.local.md",
                    target_repo="aist-roadmap",
                    target_path="CLAUDE.local.md",
                )
            ]
        )
        results = create_symlinks(config, root, "wt1", "myrepo")
        assert results[0].action == "created"
        assert os.readlink(existing) == "../../base/aist-roadmap/CLAUDE.local.md"


# create_symlinks_safe


def _pecot_links_project(tmp_path: Path) -> tuple[Path, WorktreeConfig]:
    """base/myrepo に .pecot/ 配下の link 先を置き、wt1/myrepo を git リポジトリにする"""
    root = _setup_project(tmp_path)
    base = root / "base" / "myrepo"
    (base / ".pecot" / "config").mkdir(parents=True)
    (base / ".pecot" / "config" / "hooks-config.json").write_text("{}")
    (base / ".pecot" / "work").mkdir()
    git_init_and_commit(root / "wt1" / "myrepo", {"README.md": "x"})
    config = WorktreeConfig(
        links=[
            WorktreeLinkItem(
                path=".pecot/config/hooks-config.json",
                target_repo="myrepo",
                target_path=".pecot/config/hooks-config.json",
            ),
            WorktreeLinkItem(path=".pecot/work", target_repo="myrepo", target_path=".pecot/work"),
        ]
    )
    return root, config


def _porcelain(repo: Path) -> str:
    return subprocess.run(
        ["git", "status", "--porcelain"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout


class TestPecotGitignoreEnsureScript:
    """.pecot/.gitignore の生成スクリプトの探索（非 editable の venv では __file__ がプラグイン外を指す、#1230）"""

    _REL = Path("hooks") / "lib" / "core" / "pecot-gitignore-ensure.sh"

    def test_prefers_claude_plugin_root(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        script = tmp_path / self._REL
        script.parent.mkdir(parents=True)
        script.write_text("#!/bin/bash\n")
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(tmp_path))
        assert _pecot_gitignore_ensure_script() == script

    def test_specified_root_without_script_returns_env_candidate(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """指定されているのにスクリプトが無いときは、env 側の候補を返す（警告に出るパスが正しい）。"""
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(tmp_path))
        assert _pecot_gitignore_ensure_script() == tmp_path / self._REL

    def test_missing_script_warns_with_env_candidate(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(tmp_path / "plugin"))
        root, config = _pecot_links_project(tmp_path)

        with caplog.at_level(logging.WARNING, logger="cli.core.worktree_links"):
            create_symlinks(config, root, "wt1", "myrepo")

        assert str(tmp_path / "plugin" / self._REL) in caplog.text

    def test_source_tree_when_root_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CLAUDE_PLUGIN_ROOT", raising=False)
        resolved = _pecot_gitignore_ensure_script()
        assert resolved.is_file()
        assert resolved.parts[-4:] == self._REL.parts

    def test_ensure_runs_script_from_plugin_root(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """source 相対にスクリプトが無い配置（非 editable の venv）でも、CLAUDE_PLUGIN_ROOT から呼べる。"""
        marker = tmp_path / "marker"
        script = tmp_path / "plugin" / self._REL
        script.parent.mkdir(parents=True)
        script.write_text(f'#!/bin/bash\necho "$CLAUDE_PROJECT_DIR" > "{marker}"\n')
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(tmp_path / "plugin"))
        root, config = _pecot_links_project(tmp_path)
        wt = root / "wt1" / "myrepo"

        create_symlinks(config, root, "wt1", "myrepo")

        assert marker.read_text().strip() == str(wt)


class TestPecotGitignore:
    """.pecot/ 配下の link を張ると WT に .pecot/.gitignore が実ファイルででき、未追跡が出ない (#1219)"""

    def test_create_symlinks_leaves_no_untracked(self, tmp_path: Path) -> None:
        root, config = _pecot_links_project(tmp_path)
        wt = root / "wt1" / "myrepo"

        create_symlinks(config, root, "wt1", "myrepo")

        gitignore = wt / ".pecot" / ".gitignore"
        assert gitignore.is_file()
        assert not gitignore.is_symlink(), "git は symlink の .gitignore を読まない"
        assert _porcelain(wt) == ""

    def test_create_symlinks_safe_leaves_no_untracked(self, tmp_path: Path) -> None:
        root, config = _pecot_links_project(tmp_path)
        wt = root / "wt1" / "myrepo"

        create_symlinks_safe(config, root, "wt1", "myrepo")

        assert (wt / ".pecot" / ".gitignore").is_file()
        assert _porcelain(wt) == ""

    def test_no_pecot_link_does_not_create_pecot_dir(self, tmp_path: Path) -> None:
        root = _setup_project(tmp_path)
        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path="CLAUDE.local.md",
                    target_repo="aist-roadmap",
                    target_path="CLAUDE.local.md",
                )
            ]
        )

        create_symlinks(config, root, "wt1", "myrepo")

        assert not (root / "wt1" / "myrepo" / ".pecot").exists()


class TestCreateSymlinksSafe:
    def test_real_file_force_overwrite(self, tmp_path: Path) -> None:
        root = _setup_project(tmp_path)
        existing = root / "wt1" / "myrepo" / "CLAUDE.local.md"
        existing.write_text("real content")

        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path="CLAUDE.local.md",
                    target_repo="aist-roadmap",
                    target_path="CLAUDE.local.md",
                )
            ]
        )
        results = create_symlinks_safe(config, root, "wt1", "myrepo", force=True)
        assert results[0].action == "created"
        assert existing.is_symlink()

    def test_real_file_no_force_skipped(self, tmp_path: Path) -> None:
        root = _setup_project(tmp_path)
        existing = root / "wt1" / "myrepo" / "CLAUDE.local.md"
        existing.write_text("real content")

        config = WorktreeConfig(
            links=[
                WorktreeLinkItem(
                    path="CLAUDE.local.md",
                    target_repo="aist-roadmap",
                    target_path="CLAUDE.local.md",
                )
            ]
        )
        results = create_symlinks_safe(config, root, "wt1", "myrepo", force=False)
        assert results[0].action == "skipped"
        assert not existing.is_symlink()


# 定数


class TestConstants:
    def test_config_filename(self) -> None:
        assert WORKTREE_CONFIG_FILENAME == ".pecot/config/worktree-config.json"

    def test_copy_exclude_filename(self) -> None:
        assert WORKTREE_IGNORE_FILENAME == ".pecot/config/.worktreeignore"


# load_copy_exclude_spec


class TestLoadCopyExcludeSpec:
    def _write(self, main_wt: Path, content: str) -> Path:
        ignore_path = main_wt / WORKTREE_IGNORE_FILENAME
        ignore_path.parent.mkdir(parents=True, exist_ok=True)
        ignore_path.write_text(content, encoding="utf-8")
        return ignore_path

    def test_missing_raises(self, tmp_path: Path) -> None:
        """.worktreeignore が無ければ WorktreeConfigError"""
        with pytest.raises(WorktreeConfigError) as exc_info:
            load_copy_exclude_spec(tmp_path)
        assert ".worktreeignore" in str(exc_info.value)
        assert "pecot worktree init" in str(exc_info.value)

    def test_basic_patterns_matched(self, tmp_path: Path) -> None:
        """基本の gitignore パターンがマッチする"""
        self._write(tmp_path, ".git/\n__pycache__/\n*.pyc\n")
        spec = load_copy_exclude_spec(tmp_path)
        assert spec.match_file(".git/config")
        assert spec.match_file("__pycache__/foo.pyc")
        assert spec.match_file("mod.pyc")
        assert not spec.match_file("README.md")

    def test_comments_and_blank_lines_ignored(self, tmp_path: Path) -> None:
        """空行 / # コメントは pathspec が自動でスキップする"""
        self._write(
            tmp_path,
            "# header comment\n\n.git/\n# another comment\n\n*.pyc\n",
        )
        spec = load_copy_exclude_spec(tmp_path)
        assert spec.match_file(".git/HEAD")
        assert spec.match_file("foo.pyc")
        assert not spec.match_file("foo.md")

    def test_negation_roundtrip(self, tmp_path: Path) -> None:
        """`!` 否定パターンが round-trip で機能する"""
        self._write(
            tmp_path,
            ".nx/\n!.nx/version-plans/\n",
        )
        spec = load_copy_exclude_spec(tmp_path)
        assert spec.match_file(".nx/workspace-data/cache.db")
        assert not spec.match_file(".nx/version-plans/my-plan.md")

    def test_default_content_loads_cleanly(self, tmp_path: Path) -> None:
        """DEFAULT_WORKTREEIGNORE_CONTENT をそのまま書き出してロードできる"""
        self._write(tmp_path, DEFAULT_WORKTREEIGNORE_CONTENT)
        spec = load_copy_exclude_spec(tmp_path)
        # DEFAULT に列挙されたパターンが働くか代表値で検証
        assert spec.match_file(".git/config")
        assert spec.match_file(".venv/bin/python")
        assert spec.match_file("__pycache__/foo.pyc")
        assert spec.match_file("node_modules/pkg/index.js")
        assert spec.match_file(".pecot/config/x.json")
        assert spec.match_file("tmp/scratch.txt")
        # 普通のソースは通る
        assert not spec.match_file("src/main.py")
        assert not spec.match_file("README.md")

    def test_empty_file_passes_everything(self, tmp_path: Path) -> None:
        """空 .worktreeignore → 誤って空コミットされても全ファイル通過

        誰もマッチしない空 spec は filter_copyable_files が 0 件除外となり、
        未追跡ファイル全てがコピー候補になる。リグレッション防止用。
        """
        from cli.core.worktree import filter_copyable_files

        self._write(tmp_path, "")
        spec = load_copy_exclude_spec(tmp_path)
        files = [
            Path(".git/HEAD"),
            Path("__pycache__/x.pyc"),
            Path(".venv/bin/python"),
            Path("node_modules/pkg/index.js"),
            Path("src/main.py"),
        ]
        # 空 spec は全通過 (警告発動ではなく「コピー暴走を止める」観点の保証)
        result = filter_copyable_files(files, spec)
        assert set(result) == set(files)

    def test_all_invalid_patterns_emit_warning(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        """有効行は 1 本以上あるが spec がマッチ対象を 1 本も持たない場合 warning"""
        import logging

        # pathspec は "/" 単体や空白のみの行を silent で取り込み、regex=None で残す。
        # こういう誰にもマッチしない pattern しか無いケースが warning のターゲット。
        self._write(
            tmp_path,
            "# comment\n\n/\n   \n",
        )
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="cli.core.worktree_links"):
            spec = load_copy_exclude_spec(tmp_path)
        # spec は誰にもマッチしない
        assert not spec.match_file("anything")
        # warning が出ている
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert any("all patterns" in r.getMessage() for r in warnings)

    def test_empty_file_no_warning(self, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
        """空 .worktreeignore は warning なしで全通過"""
        import logging

        self._write(tmp_path, "")
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="cli.core.worktree_links"):
            spec = load_copy_exclude_spec(tmp_path)
        # 空 spec: どのファイルもマッチしない = 全通過
        assert not spec.match_file(".git/config")
        assert not spec.match_file("src/main.py")
        # warning は出ない
        warnings = [
            r for r in caplog.records if r.levelno == logging.WARNING and "無効" in r.getMessage()
        ]
        assert warnings == []

    def test_only_comments_and_blanks_no_warning(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        """コメントと空行だけ（有効行 0）なら warning なし"""
        import logging

        self._write(tmp_path, "# c1\n\n# c2\n\n")
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="cli.core.worktree_links"):
            spec = load_copy_exclude_spec(tmp_path)
        assert not spec.match_file(".git/config")
        warnings = [
            r for r in caplog.records if r.levelno == logging.WARNING and "無効" in r.getMessage()
        ]
        assert warnings == []


# tracked file guard (#231)


class TestProcessLinkTrackedGuard:
    def _make_project(self, tmp_path: Path) -> Path:
        """<root>/base/aist-roadmap にターゲットファイルを用意"""
        root = tmp_path / "workspaces"
        target_repo = root / "base" / "aist-roadmap"
        target_repo.mkdir(parents=True)
        (target_repo / "README.md").write_text("LINK-TARGET")
        (target_repo / "docs").mkdir()
        (target_repo / "docs" / "index.md").write_text("LINK-TARGET-DOC")
        return root

    def test_process_link_skips_tracked_file(self, tmp_path: Path) -> None:
        root = self._make_project(tmp_path)
        wt_repo = root / "wt1" / "myrepo"
        wt_repo.mkdir(parents=True)
        canary = "TRACKED-CANARY-12345"
        git_init_and_commit(wt_repo, {"README.md": canary})

        link = WorktreeLinkItem(
            path="README.md",
            target_repo="aist-roadmap",
            target_path="README.md",
        )
        result = _process_link(link, root, "wt1", "myrepo", lambda _p, _t: True)

        assert result.action == "error"
        readme = wt_repo / "README.md"
        assert not readme.is_symlink()
        assert readme.read_text() == canary

    def test_process_link_skips_tracked_directory(self, tmp_path: Path) -> None:
        root = self._make_project(tmp_path)
        wt_repo = root / "wt1" / "myrepo"
        wt_repo.mkdir(parents=True)
        canary = "TRACKED-DIR-CANARY"
        git_init_and_commit(wt_repo, {"docs/index.md": canary})

        link = WorktreeLinkItem(
            path="docs",
            target_repo="aist-roadmap",
            target_path="docs",
        )
        result = _process_link(link, root, "wt1", "myrepo", lambda _p, _t: True)

        assert result.action == "error"
        docs = wt_repo / "docs"
        assert docs.is_dir() and not docs.is_symlink()
        assert (docs / "index.md").read_text() == canary

    def test_tracked_path_logs_one_warning(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        root = self._make_project(tmp_path)
        wt_repo = root / "wt1" / "myrepo"
        wt_repo.mkdir(parents=True)
        git_init_and_commit(wt_repo, {"README.md": "x"})
        link = WorktreeLinkItem(
            path="README.md", target_repo="aist-roadmap", target_path="README.md"
        )
        with caplog.at_level(logging.WARNING, logger="cli.core.worktree_links"):
            _process_link(link, root, "wt1", "myrepo", lambda _p, _t: True)
        assert [(r.levelno, r.getMessage()) for r in caplog.records] == [
            (
                logging.WARNING,
                f"symlink creation skipped because the path is tracked by git: {wt_repo / 'README.md'}",
            )
        ]

    def test_oserror_logs_one_warning(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        root = self._make_project(tmp_path)
        wt_repo = root / "wt1" / "myrepo"
        wt_repo.mkdir(parents=True)
        (wt_repo / "a").write_text("file")
        (root / "base" / "aist-roadmap" / "b").write_text("shared")
        link = WorktreeLinkItem(path="a/b", target_repo="aist-roadmap", target_path="b")
        with caplog.at_level(logging.WARNING, logger="cli.core.worktree_links"):
            result = _process_link(link, root, "wt1", "myrepo", lambda _p, _t: True)
        assert result.action == "error"
        assert len(caplog.records) == 1
        assert caplog.records[0].levelno == logging.WARNING
        assert (
            caplog.records[0]
            .getMessage()
            .startswith(f"failed to create the symlink: {wt_repo / 'a' / 'b'} -> ")
        )

    def test_process_link_creates_symlink_for_untracked_path(self, tmp_path: Path) -> None:
        root = self._make_project(tmp_path)
        wt_repo = root / "wt1" / "myrepo"
        wt_repo.mkdir(parents=True)
        # README.md だけ tracked にして、別パス untracked.md は untracked のまま
        git_init_and_commit(wt_repo, {"keep.md": "x"})
        # untracked のリアルファイルを置く（is_symlink でなく exists() 分岐に入るケース）
        (wt_repo / "untracked.md").write_text("local-only")
        # ターゲットファイルを用意
        (root / "base" / "aist-roadmap" / "untracked.md").write_text("shared")

        link = WorktreeLinkItem(
            path="untracked.md",
            target_repo="aist-roadmap",
            target_path="untracked.md",
        )
        result = _process_link(link, root, "wt1", "myrepo", lambda _p, _t: True)

        assert result.action == "created"
        assert (wt_repo / "untracked.md").is_symlink()

    def test_process_link_creates_symlink_when_repo_not_git(self, tmp_path: Path) -> None:
        root = self._make_project(tmp_path)
        wt_repo = root / "wt1" / "myrepo"
        wt_repo.mkdir(parents=True)
        # git init しない。リアルファイルを置く
        (wt_repo / "README.md").write_text("local-only")

        link = WorktreeLinkItem(
            path="README.md",
            target_repo="aist-roadmap",
            target_path="README.md",
        )
        result = _process_link(link, root, "wt1", "myrepo", lambda _p, _t: True)

        assert result.action == "created"
        assert (wt_repo / "README.md").is_symlink()
