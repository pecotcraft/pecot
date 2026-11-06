"""with-timing.sh のユニットテスト（#1083）。

ラッパーは `with-timing.sh <hook-id> <script> [args...]` で子を実行する。
終了後に `<repo_root>/.pecot/tmp/githooks-timing.tsv` へ hook 行（5 列 TSV）を 1 行追記する。
そして子の exit code を返す。
記録できない状況（記録先が書けない・git 管理外）でも、子の exit code は変えない。
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

import pytest

_LIB = Path(__file__).resolve().parents[1] / "lib" / "timing.sh"

_TIMING_RELPATH = Path(".pecot/tmp/githooks-timing.tsv")
_WRAPPER_RELPATH = ".githooks/lib/with-timing.sh"

# 子として渡す bash 本文。引数を 1 行ずつ・stdin をそのまま stdout へ出し、$EXIT_CODE で終わる。
_CHILD = 'for a in "$@"; do echo "ARG:$a"; done; cat; exit "${EXIT_CODE:-0}"'


@pytest.fixture
def repo(git_repo: Callable[..., Path]) -> Path:
    return git_repo("repo")


def _wrap(
    script_dir: Path,
    run_script,
    cwd: Path,
    hook_id: str = "probe-hook",
    *child_args: str,
    exit_code: int = 0,
    stdin: str = "",
    env: dict | None = None,
) -> subprocess.CompletedProcess:
    return run_script(
        script_dir.parent / "lib" / "with-timing.sh",
        hook_id,
        "bash",
        "-c",
        _CHILD,
        "child",
        *child_args,
        stdin=stdin,
        cwd=cwd,
        env={"EXIT_CODE": str(exit_code), **(env or {})},
    )


def _rows(repo: Path) -> list[list[str]]:
    path = repo / _TIMING_RELPATH
    if not path.exists():
        return []
    return [line.split("\t") for line in path.read_text().splitlines()]


@pytest.mark.parametrize("code", [0, 3])
def test_propagates_child_exit_code(script_dir: Path, run_script, repo: Path, code: int) -> None:
    """子の exit code をそのまま返し、補足列にも rc=<n> で残す。"""
    result = _wrap(script_dir, run_script, repo, exit_code=code)
    assert result.returncode == code
    rows = _rows(repo)
    assert len(rows) == 1
    assert rows[0][4] == f"rc={code}"


def test_passes_args_and_stdin_through(script_dir: Path, run_script, repo: Path) -> None:
    """子へ引数（空白入りを含む）と stdin をそのまま渡す。"""
    result = _wrap(
        script_dir, run_script, repo, "probe-hook", "one", "two words", stdin="from-stdin\n"
    )
    assert result.returncode == 0
    assert result.stdout == "ARG:one\nARG:two words\nfrom-stdin\n"


def test_hook_row_format(script_dir: Path, run_script, repo: Path) -> None:
    """hook 行は 5 列: 時刻 / hook / hook id / 秒（小数 1 桁）/ rc=<n>。"""
    _wrap(script_dir, run_script, repo, "nx-affected-lint")
    rows = _rows(repo)
    assert len(rows) == 1
    ts, kind, name, sec, detail = rows[0]
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}", ts)
    assert kind == "hook"
    assert name == "nx-affected-lint"
    assert re.fullmatch(r"\d+\.\d", sec)
    assert detail == "rc=0"


def test_one_row_per_invocation(script_dir: Path, run_script, repo: Path) -> None:
    """起動 1 回につき 1 行だけ追記する（2 回で 2 行）。"""
    _wrap(script_dir, run_script, repo, "first")
    assert [r[2] for r in _rows(repo)] == ["first"]
    _wrap(script_dir, run_script, repo, "second", exit_code=1)
    assert [(r[2], r[4]) for r in _rows(repo)] == [("first", "rc=0"), ("second", "rc=1")]


def test_unwritable_record_keeps_exit_code(script_dir: Path, run_script, repo: Path) -> None:
    """記録先を作れない（.pecot/tmp をファイルで塞ぐ）場合も子の exit code を返す。"""
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / "tmp").write_text("blocker\n")
    result = _wrap(script_dir, run_script, repo, exit_code=3, stdin="x\n")
    assert result.returncode == 3
    assert result.stdout == "x\n"
    assert result.stderr == ""
    assert (repo / ".pecot" / "tmp").is_file()


def test_outside_git_keeps_exit_code(script_dir: Path, run_script, tmp_path: Path) -> None:
    """git 管理外の cwd でも子を実行し exit code を返す（記録はしない）。"""
    plain = tmp_path / "plain"
    plain.mkdir()
    result = _wrap(
        script_dir,
        run_script,
        plain,
        exit_code=3,
        env={"GIT_CEILING_DIRECTORIES": str(tmp_path)},
    )
    assert result.returncode == 3
    assert not (plain / _TIMING_RELPATH).exists()


def test_usage_error_without_child(script_dir: Path, run_script, repo: Path) -> None:
    """子のコマンドが無い呼び出しは usage を出して exit 2（記録しない）。"""
    result = run_script(script_dir.parent / "lib" / "with-timing.sh", "probe-hook", cwd=repo)
    assert result.returncode == 2
    assert "usage" in result.stderr
    assert _rows(repo) == []


def test_wrapper_is_executable_in_git(script_dir: Path) -> None:
    """pre-commit は language: unsupported_script の entry を直接実行するため git mode 100755 が要る。"""
    repo_root = script_dir.parents[1]
    staged = subprocess.run(
        ["git", "ls-files", "-s", _WRAPPER_RELPATH],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    if staged:
        assert staged.split()[0] == "100755"
    else:
        # commit 前（未追跡）の作業ツリーでは、追加時に 100755 で記録される実行ビットを見る。
        assert os.access(repo_root / _WRAPPER_RELPATH, os.X_OK)


@pytest.mark.parametrize("arg", ["", "abc", "12x", "-5"])
def test_elapsed_sec_invalid_start_returns_zero(arg: str) -> None:
    """開始時刻が空・数字以外のときは算術展開に入れず 0.0 を返す。"""
    result = subprocess.run(
        ["bash", "-c", 'source "$1"; timing_elapsed_sec "$2"', "x", str(_LIB), arg],
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert result.returncode == 0
    assert result.stdout == "0.0\n"
    assert result.stderr == ""


def _start_blocking_child(script_dir: Path, repo: Path, tmp_path: Path):
    """sleep を子にしたラッパーを別セッションで起動し、子の pid が書かれるまで待つ。"""
    pidfile = tmp_path / "child.pid"
    proc = subprocess.Popen(
        [
            "bash",
            str(script_dir.parent / "lib" / "with-timing.sh"),
            "sig-hook",
            "bash",
            "-c",
            'echo $$ > "$1"; exec sleep 30',
            "child",
            str(pidfile),
        ],
        cwd=repo,
        start_new_session=True,
    )
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if pidfile.exists() and pidfile.read_text().endswith("\n"):
            return proc, int(pidfile.read_text())
        time.sleep(0.05)
    proc.kill()
    raise AssertionError("child did not start")


def test_sigint_to_process_group_records_rc_130(
    script_dir: Path, repo: Path, tmp_path: Path
) -> None:
    """プロセスグループへ SIGINT が届いても hook 行を rc=130 で残し、同じ code で終わる。"""
    proc, _ = _start_blocking_child(script_dir, repo, tmp_path)
    os.killpg(proc.pid, signal.SIGINT)
    assert proc.wait(timeout=20) == 130
    rows = _rows(repo)
    assert [(r[1], r[2], r[4]) for r in rows] == [("hook", "sig-hook", "rc=130")]


def test_sigterm_to_child_records_rc_143(script_dir: Path, repo: Path, tmp_path: Path) -> None:
    """子だけが SIGTERM で終了しても hook 行を rc=143 で残し、同じ code で終わる。"""
    proc, child_pid = _start_blocking_child(script_dir, repo, tmp_path)
    os.kill(child_pid, signal.SIGTERM)
    assert proc.wait(timeout=20) == 143
    rows = _rows(repo)
    assert [(r[1], r[2], r[4]) for r in rows] == [("hook", "sig-hook", "rc=143")]
