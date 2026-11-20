"""`pecot-open.sh`・`pecot-open-mobile.sh` の `--rc` が、新しいペインにだけ `pecot-rc.sh` を送ることを確かめる (#675)。

ホストの docker を偽物に替え、コンテナの中の tmux への呼び出しを記録する。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TMUX_DIR = _REPO_ROOT / ".devcontainer" / "tmux"
_RC = ".devcontainer/scripts/pecot-rc.sh"
_FAKE_DOCKER = """#!/bin/bash
case "$1" in
  ps) echo fakecid ;;
  exec)
    while [[ "$1" != fakecid ]]; do shift; done; shift
    [[ "$1" == tmux ]] || exit 0
    shift
    printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
    for a in "$@"; do
      case "$a" in
        has-session) exit "$FAKE_HAS_SESSION" ;;
        list-panes) printf '%%0\\n%%1\\n%%2\\n%%3\\n'; exit 0 ;;
      esac
    done
    ;;
esac
"""


def _run(tmp_path: Path, script: str, args: list[str], *, existing: bool) -> tuple[list[str], str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(_FAKE_DOCKER, encoding="utf-8")
    docker.chmod(0o755)
    log = tmp_path / "tmux.log"
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        PATH=f"{bin_dir}{os.pathsep}{env['PATH']}",
        FAKE_TMUX_LOG=str(log),
        FAKE_HAS_SESSION="0" if existing else "1",
    )
    result = subprocess.run(
        ["bash", str(_TMUX_DIR / script), "--layout", "parallel-a", *args],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    calls = log.read_text(encoding="utf-8").splitlines()
    return [c.split(" send-keys ", 1)[1] for c in calls if " send-keys " in c], result.stderr


def test_pc_sends_rc_to_every_new_pane(tmp_path: Path) -> None:
    sent, _ = _run(tmp_path, "pecot-open.sh", ["--rc"], existing=False)
    assert sent == [f"-t %{i} {_RC} Enter" for i in range(4)]


def test_mobile_sends_rc_to_every_new_session(tmp_path: Path) -> None:
    sent, _ = _run(tmp_path, "pecot-open-mobile.sh", ["--rc"], existing=False)
    assert sent == [f"-t =pecot-base-parallel-a_wt{i}-pecot: {_RC} Enter" for i in range(1, 5)]


@pytest.mark.parametrize("script", ["pecot-open.sh", "pecot-open-mobile.sh"])
def test_existing_session_gets_no_rc(tmp_path: Path, script: str) -> None:
    sent, stderr = _run(tmp_path, script, ["--rc"], existing=True)
    assert sent == []
    assert "Remote Control を起動しません" in stderr


@pytest.mark.parametrize("script", ["pecot-open.sh", "pecot-open-mobile.sh"])
def test_without_rc_sends_nothing(tmp_path: Path, script: str) -> None:
    sent, _ = _run(tmp_path, script, [], existing=False)
    assert sent == []
