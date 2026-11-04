"""lib/core/project-root.sh の解決順テスト。

入力 JSON の .cwd → CLAUDE_PROJECT_DIR → プロセスの pwd の順に、候補を試す。
GIT_* を外した `git rev-parse --show-toplevel` が成功した最初の値を、CLAUDE_PROJECT_DIR に export する。
どれも git 外なら、CLAUDE_PROJECT_DIR は変更しない。
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

_UNSET = "<unset>"


@pytest.fixture
def project_root_sh(core_dir: Path) -> Path:
    return core_dir / "project-root.sh"


def _resolve(
    script: Path,
    payload: dict | None,
    *,
    cwd: Path,
    project_dir: str | None,
    extra_env: dict | None = None,
) -> str:
    """project-root.sh を source した後の CLAUDE_PROJECT_DIR を返す（未設定は _UNSET）。"""
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
    if project_dir is not None:
        env["CLAUDE_PROJECT_DIR"] = project_dir
    env.update(extra_env or {})
    input_json = json.dumps(payload) if payload is not None else ""
    result = subprocess.run(
        [
            "bash",
            "-c",
            f'source "$1" "$2"; printf "%s" "${{CLAUDE_PROJECT_DIR-{_UNSET}}}"',
            "bash",
            str(script),
            input_json,
        ],
        capture_output=True,
        text=True,
        cwd=cwd,
        env=env,
        timeout=25,
        check=True,
    )
    return result.stdout


def _real(path: Path) -> str:
    return str(path.resolve())


def test_tool_cwd_subdir_resolves_to_its_toplevel(project_root_sh, git_repo, tmp_path):
    repo = git_repo("tool-repo")
    sub = repo / "a" / "b"
    sub.mkdir(parents=True)
    session = git_repo("session-repo")

    resolved = _resolve(project_root_sh, {"cwd": str(sub)}, cwd=tmp_path, project_dir=str(session))
    assert resolved == _real(repo)


def test_falls_back_to_project_dir_when_cwd_outside_git(project_root_sh, git_repo, tmp_path):
    session = git_repo("session-repo")
    sub = session / "sub"
    sub.mkdir()
    loose = tmp_path / "loose"
    loose.mkdir()

    resolved = _resolve(project_root_sh, {"cwd": str(loose)}, cwd=tmp_path, project_dir=str(sub))
    assert resolved == _real(session)


def test_falls_back_to_pwd_when_no_cwd_and_no_project_dir(project_root_sh, git_repo):
    repo = git_repo("pwd-repo")
    sub = repo / "deep"
    sub.mkdir()

    resolved = _resolve(project_root_sh, {"session_id": "s"}, cwd=sub, project_dir=None)
    assert resolved == _real(repo)


def test_all_outside_git_leaves_unset(project_root_sh, tmp_path):
    loose = tmp_path / "loose"
    loose.mkdir()

    resolved = _resolve(project_root_sh, {"cwd": str(loose)}, cwd=loose, project_dir=None)
    assert resolved == _UNSET


def test_all_outside_git_keeps_given_project_dir(project_root_sh, tmp_path):
    loose = tmp_path / "loose"
    loose.mkdir()
    given = tmp_path / "given"
    given.mkdir()

    resolved = _resolve(project_root_sh, {"cwd": str(loose)}, cwd=loose, project_dir=str(given))
    assert resolved == str(given)


def test_empty_input_uses_project_dir(project_root_sh, git_repo, tmp_path):
    session = git_repo("session-repo")
    assert _resolve(project_root_sh, None, cwd=tmp_path, project_dir=str(session)) == _real(session)


def test_exported_git_dir_does_not_leak(project_root_sh, git_repo, tmp_path):
    """pre-push 等で GIT_DIR が export されていても cwd 側の toplevel を返す。"""
    repo = git_repo("tool-repo")
    other = git_repo("other-repo")

    resolved = _resolve(
        project_root_sh,
        {"cwd": str(repo)},
        cwd=tmp_path,
        project_dir=None,
        extra_env={"GIT_DIR": str(other / ".git"), "GIT_WORK_TREE": str(other)},
    )
    assert resolved == _real(repo)


# worktree の .pecot/work（base への symlink）配下。


@pytest.mark.parametrize("sub", ["1244", "1244/sub", ""])
def test_cwd_in_work_resolves_to_session_worktree(project_root_sh, work_layout, sub):
    cwd = work_layout["work"] / sub
    resolved = _resolve(
        project_root_sh,
        {"cwd": str(cwd)},
        cwd=work_layout["base"],
        project_dir=str(work_layout["wt"]),
    )
    assert resolved == _real(work_layout["wt"])


def test_cwd_in_work_via_worktree_link_resolves_to_session_worktree(project_root_sh, work_layout):
    cwd = work_layout["wt_work"] / "1244"
    resolved = _resolve(
        project_root_sh, {"cwd": str(cwd)}, cwd=cwd, project_dir=str(work_layout["wt"])
    )
    assert resolved == _real(work_layout["wt"])


def test_cwd_in_base_work_with_base_session_stays_base(project_root_sh, work_layout):
    cwd = work_layout["work"] / "1244"
    resolved = _resolve(
        project_root_sh, {"cwd": str(cwd)}, cwd=cwd, project_dir=str(work_layout["base"])
    )
    assert resolved == _real(work_layout["base"])


def test_cwd_outside_work_ignores_session_worktree(project_root_sh, work_layout):
    resolved = _resolve(
        project_root_sh,
        {"cwd": str(work_layout["base"])},
        cwd=work_layout["base"],
        project_dir=str(work_layout["wt"]),
    )
    assert resolved == _real(work_layout["base"])


def test_work_lookalike_dir_is_not_matched(project_root_sh, work_layout):
    cwd = work_layout["base"] / ".pecot" / "work2"
    resolved = _resolve(
        project_root_sh, {"cwd": str(cwd)}, cwd=cwd, project_dir=str(work_layout["wt"])
    )
    assert resolved == _real(work_layout["base"])


def test_cwd_in_work_without_project_dir_falls_back_to_cwd_toplevel(project_root_sh, work_layout):
    cwd = work_layout["work"] / "1244"
    resolved = _resolve(project_root_sh, {"cwd": str(cwd)}, cwd=cwd, project_dir=None)
    assert resolved == _real(work_layout["base"])


def test_dangling_work_link_falls_back_to_cwd_toplevel(project_root_sh, work_layout):
    work_link = work_layout["wt_work"]
    work_link.unlink()
    work_link.symlink_to("../../missing/.pecot/work")
    cwd = work_layout["work"] / "1244"
    resolved = _resolve(
        project_root_sh, {"cwd": str(cwd)}, cwd=cwd, project_dir=str(work_layout["wt"])
    )
    assert resolved == _real(work_layout["base"])


def test_exported_git_dir_does_not_leak_in_work(project_root_sh, work_layout, git_repo):
    other = git_repo("other-repo")
    cwd = work_layout["work"] / "1244"
    resolved = _resolve(
        project_root_sh,
        {"cwd": str(cwd)},
        cwd=cwd,
        project_dir=str(work_layout["wt"]),
        extra_env={"GIT_DIR": str(other / ".git"), "GIT_WORK_TREE": str(other)},
    )
    assert resolved == _real(work_layout["wt"])


def test_resolved_value_is_idempotent_in_work(project_root_sh, work_layout):
    cwd = work_layout["work"] / "1244"
    first = _resolve(
        project_root_sh, {"cwd": str(cwd)}, cwd=cwd, project_dir=str(work_layout["wt"])
    )
    second = _resolve(project_root_sh, {"cwd": str(cwd)}, cwd=cwd, project_dir=first)
    assert second == first == _real(work_layout["wt"])


def test_nested_git_repo_in_work_resolves_to_its_own_toplevel(project_root_sh, work_layout):
    """.pecot/work/N に clone した入れ子のリポは、セッションの worktree ではなくそのリポが基準。"""
    nested = work_layout["work"] / "1244" / "clone"
    nested.mkdir()
    subprocess.run(["git", "init", "--quiet"], cwd=nested, check=True)
    (nested / "src").mkdir()
    for cwd in (nested, nested / "src"):
        resolved = _resolve(
            project_root_sh, {"cwd": str(cwd)}, cwd=cwd, project_dir=str(work_layout["wt"])
        )
        assert resolved == _real(nested)


def test_nested_git_file_in_work_resolves_to_its_own_toplevel(project_root_sh, work_layout):
    """入れ子が .git ディレクトリでなく .git ファイル（worktree・submodule）でも対象外。"""
    nested = work_layout["work"] / "1244" / "linked"
    subprocess.run(
        ["git", "worktree", "add", "-q", "-b", "nested/x", str(nested)],
        cwd=work_layout["base"],
        check=True,
    )
    assert (nested / ".git").is_file()
    resolved = _resolve(
        project_root_sh, {"cwd": str(nested)}, cwd=nested, project_dir=str(work_layout["wt"])
    )
    assert resolved == _real(nested)


def test_cwd_in_other_repo_work_resolves_to_that_repo(project_root_sh, work_layout, git_repo):
    """別リポの .pecot/work/N は、前置きの case に当たってもセッションの worktree にしない。"""
    other = git_repo("other-repo")
    cwd = other / ".pecot" / "work" / "1244"
    cwd.mkdir(parents=True)
    resolved = _resolve(
        project_root_sh, {"cwd": str(cwd)}, cwd=cwd, project_dir=str(work_layout["wt"])
    )
    assert resolved == _real(other)


def test_original_project_dir_is_exported_before_overwrite(project_root_sh, git_repo):
    """上書き前の CLAUDE_PROJECT_DIR を PECOT_ORIGINAL_CLAUDE_PROJECT_DIR に残す。"""
    origin = git_repo("origin-repo")
    other = git_repo("other-repo")
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
    env["CLAUDE_PROJECT_DIR"] = str(origin)
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1" "$2"; printf "%s|%s" "$CLAUDE_PROJECT_DIR" "$PECOT_ORIGINAL_CLAUDE_PROJECT_DIR"',
            "bash",
            str(project_root_sh),
            json.dumps({"cwd": str(other)}),
        ],
        capture_output=True,
        text=True,
        cwd=other,
        env=env,
        timeout=25,
    )
    assert result.stdout == f"{_real(other)}|{origin}"
