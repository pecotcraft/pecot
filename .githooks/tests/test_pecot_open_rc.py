"""`pecot-open.sh`・`pecot-open-mobile.sh` の `--rc` が、新しいペインにだけ `pecot-rc.sh` を送ることを確かめる (#675)。

ホストの docker を偽物に替え、コンテナの中の tmux への呼び出しを記録する。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

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
    result = run_attached(
        ["bash", str(_TMUX_DIR / script), "--layout", "parallel-a", *args],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    calls = read_output(log).splitlines()
    return [c.split(" send-keys ", 1)[1] for c in calls if " send-keys " in c], result.stderr


@allure.title(
    "`pecot-open.sh --rc` を新しいセッションで実行すると、すべてのペインに `pecot-rc.sh` を送る"
)
def test_pc_sends_rc_to_every_new_pane(tmp_path: Path) -> None:
    """`pecot-open.sh` に `--rc` を指定して、新しいセッションを作成した場合のテストです。ホストの docker を偽物に置き換え、4 つのペインのすべてに `pecot-rc.sh` を実行する `send-keys` が送信されることを確認します。"""
    with allure.step("偽の docker で pecot-open.sh を --rc 付きで動かす"):
        sent, _ = _run(tmp_path, "pecot-open.sh", ["--rc"], existing=False)
    with allure.step("新しいペインのすべてに pecot-rc.sh を送ることを確かめる"):
        assert sent == [f"-t %{i} {_RC} Enter" for i in range(4)]


@allure.title(
    "`pecot-open-mobile.sh --rc` を新しいセッションで実行すると、すべてのセッションに `pecot-rc.sh` を送る"
)
def test_mobile_sends_rc_to_every_new_session(tmp_path: Path) -> None:
    """`pecot-open-mobile.sh` に `--rc` を指定して、新しいセッションを作成した場合のテストです。ホストの docker を偽物に置き換え、4 つのセッションのすべてに `pecot-rc.sh` を実行する `send-keys` が送信されることを確認します。"""
    with allure.step("偽の docker で pecot-open-mobile.sh を --rc 付きで動かす"):
        sent, _ = _run(tmp_path, "pecot-open-mobile.sh", ["--rc"], existing=False)
    with allure.step("新しいセッションのすべてに pecot-rc.sh を送ることを確かめる"):
        assert sent == [f"-t =pecot-base-parallel-a_wt{i}-pecot: {_RC} Enter" for i in range(1, 5)]


@allure.title(
    "{script} に --rc を指定しても、既存のセッションには `pecot-rc.sh` を送らず、警告を表示する"
)
@pytest.mark.parametrize("script", ["pecot-open.sh", "pecot-open-mobile.sh"])
def test_existing_session_gets_no_rc(tmp_path: Path, script: str) -> None:
    """既存のセッションがある状態で `--rc` を指定したときの、`pecot-open.sh` と `pecot-open-mobile.sh` のテストです。`send-keys` が 1 件も送信されず、標準エラー出力に「Remote Control を起動しません」と表示されることを確認します。"""
    with allure.step("既存のセッションを置き、--rc 付きで動かす"):
        sent, stderr = _run(tmp_path, script, ["--rc"], existing=True)
    with allure.step("何も送らず、起動しない旨が stderr に出ることを確かめる"):
        assert sent == []
        assert "Remote Control を起動しません" in stderr


@allure.title("{script} に --rc を指定しないと、`pecot-rc.sh` を送らない")
@pytest.mark.parametrize("script", ["pecot-open.sh", "pecot-open-mobile.sh"])
def test_without_rc_sends_nothing(tmp_path: Path, script: str) -> None:
    """`--rc` を指定せずに新しいセッションを作成した場合の、`pecot-open.sh` と `pecot-open-mobile.sh` のテストです。`send-keys` が 1 件も送信されないことを確認します。"""
    with allure.step("--rc 無しで動かす"):
        sent, _ = _run(tmp_path, script, [], existing=False)
    with allure.step("何も送らないことを確かめる"):
        assert sent == []
