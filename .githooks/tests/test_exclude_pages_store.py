"""`.devcontainer/scripts/exclude-pages-store.sh` が pages-store を origin からの取得の対象から外すことを確かめる (#763)。"""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

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


def test_excludes_pages_store_and_removes_tracking_ref(
    git_repo: Callable[..., Path], git: Git, run_script: RunScript, tmp_path: Path
) -> None:
    src = _source(git_repo, git)
    clone = _clone(git, src, tmp_path / "clone")
    assert "refs/remotes/origin/pages-store" in _remote_refs(git, clone)

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


def test_defaults_to_repo_holding_the_script(
    git_repo: Callable[..., Path], git: Git, run_script: RunScript, tmp_path: Path
) -> None:
    src = _source(git_repo, git)
    clone = _clone(git, src, tmp_path / "clone")
    script = clone / ".devcontainer" / "scripts" / "exclude-pages-store.sh"
    script.parent.mkdir(parents=True)
    shutil.copy(_SCRIPT, script)

    result = run_script(script, cwd=tmp_path)

    assert result.returncode == 0, result.stderr
    assert _fetch_refspecs(git, clone) == [_DEFAULT_FETCH, _EXCLUDE]
    assert _remote_refs(git, clone) == ["refs/remotes/origin/HEAD", "refs/remotes/origin/main"]


def test_leaves_repo_without_origin_unchanged(
    git_repo: Callable[..., Path], git: Git, run_script: RunScript
) -> None:
    repo = git_repo("lone", initial_branch="main")

    result = run_script(_SCRIPT, str(repo))

    assert result.returncode == 0, result.stderr
    remotes = subprocess.run(
        ["git", "config", "--get-regexp", "^remote\\."], cwd=repo, capture_output=True, text=True
    )
    assert (remotes.returncode, remotes.stdout) == (1, "")
