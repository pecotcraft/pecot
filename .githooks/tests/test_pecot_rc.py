"""`.devcontainer/scripts/pecot-rc.sh` が作業ツリーのプラグインを渡して claude remote-control を起動することを確かめる (#675)。"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO_ROOT / ".devcontainer" / "scripts" / "pecot-rc.sh"


def _fake_claude(tmp_path: Path) -> dict[str, str]:
    """引数を 1 行ずつ、最後に CLAUDE_CODE_PLUGIN_DIRS を出す偽の claude を PATH の先頭に置く。"""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    claude = bin_dir / "claude"
    claude.write_text(
        '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "DIRS=%s\\n" "$CLAUDE_CODE_PLUGIN_DIRS"\n',
        encoding="utf-8",
    )
    claude.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    return env


def _git_repo(path: Path) -> Path:
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    return path.resolve()


def test_passes_worktree_plugins_and_args_from_subdirectory(tmp_path: Path) -> None:
    env = _fake_claude(tmp_path)
    repo = _git_repo(tmp_path / "wt")
    sub = repo / "plugins"
    sub.mkdir()

    result = subprocess.run(
        ["bash", str(_SCRIPT), "--spawn", "worktree", "--name", "a b"],
        cwd=sub,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )

    lines = result.stdout.splitlines()
    assert lines[:7] == [
        "remote-control",
        "--permission-mode",
        "auto",
        "--spawn",
        "worktree",
        "--name",
        "a b",
    ]
    assert lines[7] == "DIRS=" + ":".join(
        str(repo / "plugins" / name) for name in ("pecot-workflow", "pecot-tools", "pecot-visual")
    )


@pytest.mark.parametrize("mode_args", [["--permission-mode", "plan"], ["--permission-mode=plan"]])
def test_keeps_permission_mode_given_by_caller(tmp_path: Path, mode_args: list[str]) -> None:
    env = _fake_claude(tmp_path)
    repo = _git_repo(tmp_path / "wt")

    result = subprocess.run(
        ["bash", str(_SCRIPT), "--spawn", "worktree", *mode_args],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )

    assert result.stdout.splitlines()[:-1] == ["remote-control", "--spawn", "worktree", *mode_args]


def test_stops_outside_git_worktree(tmp_path: Path) -> None:
    env = _fake_claude(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    env["GIT_CEILING_DIRECTORIES"] = str(tmp_path)

    result = subprocess.run(
        ["bash", str(_SCRIPT)], cwd=outside, env=env, capture_output=True, text=True
    )

    assert result.returncode == 1
    assert "git の作業ツリーの中で打ってください" in result.stderr
    assert result.stdout == ""
