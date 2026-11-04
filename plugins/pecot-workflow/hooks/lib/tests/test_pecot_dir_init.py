"""pecot-dir-init.sh のユニットテスト（test_pecot_dir_init.bats からの移植）。

対象は、新規作成、CLAUDE_PROJECT_DIR ガード、mtime ガード、冪等性、hosts.json/.env 保護。
あわせて、gitignore-ensure の先行化（コピーより前に .gitignore を更新する契約）も対象とする。

GIT_* 隔離・test git repo 生成は conftest の fixture（_isolate_git_env / git_repo）が担保する。
"""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

# このテストは mock git を埋め込まないため REAL_GIT の事前解決は不要。git の presence は
# git_repo フィクスチャの subprocess git 呼び出し（check=True）が実行時に担保する。
# モジュールロード時 assert は collection error の原因になりうるため置かない。


@pytest.fixture
def init_script(core_dir: Path) -> Path:
    return core_dir / "pecot-dir-init.sh"


@pytest.fixture
def dir_init_env(
    tmp_path: Path,
    project_root: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    """bats setup() 相当: CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT / PLUGIN_HOOKS を設定し
    project ディレクトリを作って返す。"""
    project = tmp_path / "project"
    project.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(project_root / "plugins" / "pecot-workflow"))
    monkeypatch.setenv("PLUGIN_HOOKS", str(project_root / "plugins" / "pecot-workflow" / "hooks"))
    return project


def _run(script: Path, cwd: str | Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(script)],
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=25,
    )


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    """test git repo に対する素の git 呼び出し（GIT_* は conftest autouse で剥がれ済み）。"""
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=25,
    )


# 新規作成。


def test_pecot_dir_created_when_absent(init_script: Path, dir_init_env: Path):
    project = dir_init_env
    result = _run(init_script)
    assert result.returncode == 0

    pecot = project / ".pecot"
    assert (pecot).is_dir()
    assert (pecot / "state").is_dir()
    assert (pecot / "tmp").is_dir()
    assert (pecot / "work").is_dir()
    assert (pecot / "config").is_dir()
    assert (pecot / ".gitignore").is_file()
    # .gitkeep は作らない（dir-init と CLI の mkdir -p で十分。git 追跡は共有物の commit が担う）。
    assert not (pecot / "config" / ".gitkeep").exists()
    assert not (pecot / "config" / "projects" / ".gitkeep").exists()
    assert (pecot / "config" / "hosts.json").is_file()
    assert (pecot / "config" / ".env").is_file()
    assert (pecot / "state" / ".plugin-sync-version").is_file()

    gitignore_lines = (pecot / ".gitignore").read_text().splitlines()
    assert "config/hosts.json" in gitignore_lines
    assert "config/hosts.json.sample" in gitignore_lines
    assert "config/.env" in gitignore_lines
    assert "config/.env.sample" in gitignore_lines


# CLAUDE_PROJECT_DIR ガード。


def test_no_op_when_claude_project_dir_unset(
    init_script: Path,
    dir_init_env: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    result = _run(init_script)
    assert result.returncode == 0
    # プロジェクトディレクトリは元のままで .pecot は存在しない。
    assert not (dir_init_env / ".pecot").exists()


# mtime ガード。


def _setup_isolated_plugin_hooks(
    tmp_path: Path,
    project_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    fixed_ts: str,
) -> None:
    """mtime ガードテスト用: PLUGIN_HOOKS をテスト用コピーに切り替え plugin.json の mtime を固定。

    bats _setup_isolated_plugin_hooks 相当。
    スクリプト内の `${_HOOKS_ROOT}/../.claude-plugin/plugin.json` 解決に合わせる。
    plugin-root/{hooks, .claude-plugin} は、兄弟で配置する。
    fixed_ts は touch -t 形式。
    """
    plugin_root = tmp_path / "plugin-isolated"
    plugin_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        project_root / "plugins" / "pecot-workflow" / "hooks",
        plugin_root / "hooks",
    )
    shutil.copytree(
        project_root / "plugins" / "pecot-workflow" / ".claude-plugin",
        plugin_root / ".claude-plugin",
    )
    subprocess.run(
        ["touch", "-t", fixed_ts, str(plugin_root / ".claude-plugin" / "plugin.json")],
        check=True,
    )
    monkeypatch.setenv("PLUGIN_HOOKS", str(plugin_root / "hooks"))


def _mtime(path: Path) -> int:
    return int(path.stat().st_mtime)


def test_marker_newer_than_plugin_json_skips_sync(
    init_script: Path,
    dir_init_env: Path,
    tmp_path: Path,
    project_root: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = dir_init_env
    _setup_isolated_plugin_hooks(tmp_path, project_root, monkeypatch, "202001010000")

    # 初回実行で初期化。
    assert _run(init_script).returncode == 0

    # README.md の mtime を過去に戻す。
    readme = project / ".pecot" / "README.md"
    assert readme.is_file()
    subprocess.run(["touch", "-t", "200001010000", str(readme)], check=True)
    before = _mtime(readme)

    # マーカーを plugin.json (2020) より新しくする。
    subprocess.run(
        ["touch", "-t", "202501010000", str(project / ".pecot" / "state" / ".plugin-sync-version")],
        check=True,
    )

    assert _run(init_script).returncode == 0

    # README.md は更新されていない（mtime 据え置き）。
    assert _mtime(readme) == before


def test_marker_older_than_plugin_json_updates_sync(
    init_script: Path,
    dir_init_env: Path,
    tmp_path: Path,
    project_root: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    project = dir_init_env
    _setup_isolated_plugin_hooks(tmp_path, project_root, monkeypatch, "202001010000")

    assert _run(init_script).returncode == 0

    readme = project / ".pecot" / "README.md"
    assert readme.is_file()
    subprocess.run(["touch", "-t", "200001010000", str(readme)], check=True)
    before = _mtime(readme)

    # マーカーを plugin.json (2020) より古くする。
    subprocess.run(
        ["touch", "-t", "201001010000", str(project / ".pecot" / "state" / ".plugin-sync-version")],
        check=True,
    )

    assert _run(init_script).returncode == 0

    # README.md は更新されている（mtime が新しくなる）。
    assert _mtime(readme) > before


# hosts.json / .env の保護。


def test_existing_hosts_and_env_not_overwritten(init_script: Path, dir_init_env: Path):
    project = dir_init_env
    config = project / ".pecot" / "config"
    config.mkdir(parents=True)
    (config / "hosts.json").write_text('{"custom": true}')
    (config / ".env").write_text("MY_CUSTOM_TOKEN=secret")

    result = _run(init_script)
    assert result.returncode == 0

    # カスタム内容が保持されている。
    assert (config / "hosts.json").read_text() == '{"custom": true}'
    assert (config / ".env").read_text() == "MY_CUSTOM_TOKEN=secret"


# gitignore-ensure 先行化（コピーより前に .gitignore を更新する契約）。


def test_old_gitignore_repo_leaves_no_untracked(
    init_script: Path,
    dir_init_env: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    """旧内容（tmp/ のみ）の .pecot/.gitignore を実 git リポに配置しても untracked が残らない。"""
    repo = git_repo("repo")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / ".gitignore").write_text("tmp/\n")

    result = _run(init_script)
    assert result.returncode == 0

    status = _git(repo, "status", "--porcelain", "-uall", "--", ".pecot/")
    assert status.returncode == 0
    assert status.stdout == ""


def test_first_copy_failure_leaves_no_untracked(
    init_script: Path,
    dir_init_env: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    """最初のコピー対象（hooks-config.json）が dangling symlink で失敗しても untracked なし。"""
    repo = git_repo("repo")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    (repo / ".pecot" / "config").mkdir(parents=True)
    (repo / ".pecot" / ".gitignore").write_text("tmp/\n")
    (repo / ".pecot" / "config" / "hooks-config.json").symlink_to(
        repo.parent / "nonexistent" / "target"
    )

    result = _run(init_script)
    # 最初のコピーが dangling symlink で失敗し set -e で非 0 終了する。
    assert result.returncode != 0

    status = _git(repo, "status", "--porcelain", "-uall", "--", ".pecot/")
    assert status.returncode == 0
    assert status.stdout == ""


def test_mid_copy_failure_leaves_no_untracked(
    init_script: Path,
    dir_init_env: Path,
    git_repo: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
):
    """README の cp が dangling symlink で失敗しても（中盤失敗）untracked が残らない。"""
    repo = git_repo("repo")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / ".gitignore").write_text("tmp/\n")
    (repo / ".pecot" / "README.md").symlink_to(repo.parent / "nonexistent" / "target")

    result = _run(init_script)
    # cp 失敗で set -e により非 0 終了する。
    assert result.returncode != 0

    status = _git(repo, "status", "--porcelain", "-uall", "--", ".pecot/")
    assert status.returncode == 0
    assert status.stdout == ""
