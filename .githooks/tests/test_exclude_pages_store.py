"""`.devcontainer/scripts/exclude-pages-store.sh` が pages-store を origin からの取得の対象から外すことを確かめる (#763)。"""

from __future__ import annotations

import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import allure
from attach import run_attached  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO_ROOT / ".devcontainer" / "scripts" / "exclude-pages-store.sh"

_DEFAULT_FETCH = "+refs/heads/*:refs/remotes/origin/*"
_EXCLUDE = "^refs/heads/pages-store"

Git = Callable[..., subprocess.CompletedProcess]
RunScript = Callable[..., subprocess.CompletedProcess]


def _commit(git: Git, repo: Path, name: str) -> None:
    (repo / name).write_text(name, encoding="utf-8")
    git(repo, "add", name)
    git(repo, "commit", "-q", "-m", name)


def _source(git_repo: Callable[..., Path], git: Git) -> Path:
    """main と pages-store を持つ取得元。"""
    src = git_repo("src", initial_branch="main")
    _commit(git, src, "main.txt")
    git(src, "switch", "-q", "--orphan", "pages-store")
    _commit(git, src, "store.txt")
    git(src, "switch", "-q", "main")
    return src


def _clone(git: Git, src: Path, dest: Path) -> Path:
    git(src.parent, "clone", "-q", str(src), str(dest))
    return dest


def _fetch_refspecs(git: Git, repo: Path) -> list[str]:
    return git(repo, "config", "--get-all", "remote.origin.fetch").stdout.splitlines()


def _remote_refs(git: Git, repo: Path) -> list[str]:
    return git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes").stdout.splitlines()


@allure.title(
    "exclude-pages-store.sh を実行すると、pages-store を取得の対象から外し、追跡する ref を削除する"
)
def test_excludes_pages_store_and_removes_tracking_ref(
    git_repo: Callable[..., Path], git: Git, run_script: RunScript, tmp_path: Path
) -> None:
    """pages-store ブランチを持つ取得元から clone したリポジトリで、`exclude-pages-store.sh` を 2 回実行するテストです。fetch の refspec に除外の指定が 1 つだけ加わり、`fetch --prune` のあとも `pages-store` が取得されないことを確認します。"""
    with allure.step("pages-store を持つ取得元を clone する"):
        src = _source(git_repo, git)
        clone = _clone(git, src, tmp_path / "clone")
        assert "refs/remotes/origin/pages-store" in _remote_refs(git, clone)

    with allure.step("exclude-pages-store.sh を 2 回動かし、取得の対象と追跡 ref を確かめる"):
        for _ in range(2):
            result = run_script(_SCRIPT, str(clone))
            assert result.returncode == 0, result.stderr

        assert _fetch_refspecs(git, clone) == [_DEFAULT_FETCH, _EXCLUDE]
        assert _remote_refs(git, clone) == ["refs/remotes/origin/HEAD", "refs/remotes/origin/main"]

        _commit(git, src, "main2.txt")
        git(src, "switch", "-q", "pages-store")
        _commit(git, src, "store2.txt")
        git(src, "switch", "-q", "main")
        git(clone, "fetch", "-q", "--prune")

        assert git(clone, "branch", "-r", "--format=%(refname:short)").stdout.splitlines() == [
            "origin",
            "origin/main",
        ]
        assert git(clone, "rev-parse", "origin/main").stdout == git(src, "rev-parse", "main").stdout


@allure.title("引数を渡さずに実行すると、スクリプトを含むリポジトリを対象にする")
def test_defaults_to_repo_holding_the_script(
    git_repo: Callable[..., Path], git: Git, run_script: RunScript, tmp_path: Path
) -> None:
    """リポジトリの中に置いた `exclude-pages-store.sh` を、別のディレクトリから引数なしで実行するテストです。スクリプトを含むリポジトリで、`pages-store` が取得の対象から外れることを確認します。"""
    with allure.step("clone の中に script を写し、引数なしで動かす"):
        src = _source(git_repo, git)
        clone = _clone(git, src, tmp_path / "clone")
        script = clone / ".devcontainer" / "scripts" / "exclude-pages-store.sh"
        script.parent.mkdir(parents=True)
        shutil.copy(_SCRIPT, script)

        result = run_script(script, cwd=tmp_path)

    with allure.step("script のあるリポの取得の対象と追跡 ref が変わることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert _fetch_refspecs(git, clone) == [_DEFAULT_FETCH, _EXCLUDE]
        assert _remote_refs(git, clone) == ["refs/remotes/origin/HEAD", "refs/remotes/origin/main"]


@allure.title("origin が存在しないリポジトリでは、何も変更しない")
def test_leaves_repo_without_origin_unchanged(
    git_repo: Callable[..., Path], git: Git, run_script: RunScript
) -> None:
    """`origin` を持たないリポジトリで `exclude-pages-store.sh` を実行するテストです。終了コード 0 で終わり、`remote.*` の設定が追加されないことを確認します。"""
    with allure.step("origin の無いリポで exclude-pages-store.sh を動かす"):
        repo = git_repo("lone", initial_branch="main")

        result = run_script(_SCRIPT, str(repo))

    with allure.step("終了コード 0 で、remote の設定が増えないことを確かめる"):
        assert result.returncode == 0, result.stderr
        remotes = run_attached(
            ["git", "config", "--get-regexp", "^remote\\."],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        assert (remotes.returncode, remotes.stdout) == (1, "")
