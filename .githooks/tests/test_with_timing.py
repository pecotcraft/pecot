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
import sys
import time
from collections.abc import Callable
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

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
    return [line.split("\t") for line in read_output(path).splitlines()]


@allure.title("子の終了コードが {code} のとき、そのコードで終了し、記録にも `rc={code}` を残す")
@pytest.mark.parametrize("code", [0, 3])
def test_propagates_child_exit_code(script_dir: Path, run_script, repo: Path, code: int) -> None:
    """`with-timing.sh` が実行する子の終了コードのテストです。ラッパーが子と同じ終了コードで終了し、記録の補足の列に、`rc=` に続けて同じ値が 1 行だけ残ることを確認します。"""
    result = _wrap(script_dir, run_script, repo, exit_code=code)
    with allure.step("終了コードと記録の行を確かめる"):
        assert result.returncode == code
        rows = _rows(repo)
        assert len(rows) == 1
        assert rows[0][4] == f"rc={code}"


@allure.title("子のコマンドに、空白を含む引数と標準入力をそのまま渡す")
def test_passes_args_and_stdin_through(script_dir: Path, run_script, repo: Path) -> None:
    """`with-timing.sh` に引数と標準入力を渡して実行した場合のテストです。空白を含む引数が分割されず、標準入力の内容と合わせて子の出力に現れることを確認します。"""
    result = _wrap(
        script_dir, run_script, repo, "probe-hook", "one", "two words", stdin="from-stdin\n"
    )
    with allure.step("終了コードと子の出力を確かめる"):
        assert result.returncode == 0
        assert result.stdout == "ARG:one\nARG:two words\nfrom-stdin\n"


@allure.title("記録の行は、時刻・hook・hook id・秒・`rc=` の 5 列で作成される")
def test_hook_row_format(script_dir: Path, run_script, repo: Path) -> None:
    """`with-timing.sh` が追記する 1 行の形式のテストです。時刻が ISO 形式で、種別が `hook`、hook id が指定した値、秒が小数 1 桁、補足が `rc=0` であることを確認します。"""
    _wrap(script_dir, run_script, repo, "nx-affected-lint")
    rows = _rows(repo)
    with allure.step("記録の行の各列の形を確かめる"):
        assert len(rows) == 1
        ts, kind, name, sec, detail = rows[0]
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}", ts)
        assert kind == "hook"
        assert name == "nx-affected-lint"
        assert re.fullmatch(r"\d+\.\d", sec)
        assert detail == "rc=0"


@allure.title("起動のたびに、記録を 1 行ずつ追記する")
def test_one_row_per_invocation(script_dir: Path, run_script, repo: Path) -> None:
    """`with-timing.sh` を 2 回続けて実行した場合のテストです。1 回目と 2 回目の hook id と終了コードが、この順に 2 行として記録されることを確認します。"""
    _wrap(script_dir, run_script, repo, "first")
    with allure.step("1 回目の記録の行を確かめる"):
        assert [r[2] for r in _rows(repo)] == ["first"]
        _wrap(script_dir, run_script, repo, "second", exit_code=1)
        assert [(r[2], r[4]) for r in _rows(repo)] == [("first", "rc=0"), ("second", "rc=1")]


@allure.title("記録先を作成できなくても、子の終了コードと出力は変えない")
def test_unwritable_record_keeps_exit_code(script_dir: Path, run_script, repo: Path) -> None:
    """`.pecot/tmp` をファイルで塞いで記録先を作成できなくした場合のテストです。子の終了コード 3 と標準出力がそのまま返り、標準エラー出力が空で、塞いだファイルが残ることを確認します。"""
    (repo / ".pecot").mkdir()
    (repo / ".pecot" / "tmp").write_text("blocker\n")
    result = _wrap(script_dir, run_script, repo, exit_code=3, stdin="x\n")
    with allure.step("終了コードと出力と塞いだファイルを確かめる"):
        assert result.returncode == 3
        assert result.stdout == "x\n"
        assert result.stderr == ""
        assert (repo / ".pecot" / "tmp").is_file()


@allure.title("git の管理外で実行しても、子の終了コードを返し、記録は作成しない")
def test_outside_git_keeps_exit_code(script_dir: Path, run_script, tmp_path: Path) -> None:
    """git の管理外のディレクトリで `with-timing.sh` を実行した場合のテストです。子の終了コード 3 がそのまま返り、記録のファイルが作成されないことを確認します。"""
    plain = tmp_path / "plain"
    plain.mkdir()
    result = _wrap(
        script_dir,
        run_script,
        plain,
        exit_code=3,
        env={"GIT_CEILING_DIRECTORIES": str(tmp_path)},
    )
    with allure.step("終了コードと記録が無いことを確かめる"):
        assert result.returncode == 3
        assert not (plain / _TIMING_RELPATH).exists()


@allure.title("子のコマンドを指定しないと、usage を表示して終了コード 2 で終了する")
def test_usage_error_without_child(script_dir: Path, run_script, repo: Path) -> None:
    """子のコマンドを指定せずに `with-timing.sh` を実行した場合のテストです。終了コードが 2 になり、標準エラー出力に `usage` が含まれ、記録は作成されないことを確認します。"""
    result = run_script(script_dir.parent / "lib" / "with-timing.sh", "probe-hook", cwd=repo)
    with allure.step("終了コードと usage の出力と記録が無いことを確かめる"):
        assert result.returncode == 2
        assert "usage" in result.stderr
        assert _rows(repo) == []


@allure.title("`with-timing.sh` は、git のモードを、実行可能な 100755 にする")
def test_wrapper_is_executable_in_git(script_dir: Path) -> None:
    """`.githooks/lib/with-timing.sh` のファイルモードのテストです。pre-commit が直接実行できるよう、git の記録が 100755 であることを確認します。まだ追跡されていない場合は、実行権限が付いていることを確認します。"""
    with allure.step("git の実行権限を調べる"):
        repo_root = script_dir.parents[1]
        staged = run_attached(
            ["git", "ls-files", "-s", _WRAPPER_RELPATH],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    with allure.step("実行権限の形式を確かめる"):
        if staged:
            assert staged.split()[0] == "100755"
        else:
            # commit 前（未追跡）の作業ツリーでは、追加時に 100755 で記録される実行ビットを見る。
            assert os.access(repo_root / _WRAPPER_RELPATH, os.X_OK)


@allure.title("開始時刻が {arg} のとき、経過秒として 0.0 を返す")
@pytest.mark.parametrize("arg", ["", "abc", "12x", "-5"])
def test_elapsed_sec_invalid_start_returns_zero(arg: str) -> None:
    """`timing_elapsed_sec` に、空や数字ではない開始時刻を渡した場合のテストです。算術展開に入らず、終了コード 0 で `0.0` を出力し、標準エラー出力が空であることを確認します。"""
    with allure.step("不正な開始時刻で経過秒の関数を呼ぶ"):
        result = run_attached(
            ["bash", "-c", 'source "$1"; timing_elapsed_sec "$2"', "x", str(_LIB), arg],
            capture_output=True,
            text=True,
            timeout=25,
        )
    with allure.step("終了コードと 0.0 の出力を確かめる"):
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


@allure.title("プロセスグループに SIGINT が届くと、`rc=130` を記録し、同じコードで終了する")
def test_sigint_to_process_group_records_rc_130(
    script_dir: Path, repo: Path, tmp_path: Path
) -> None:
    """ラッパーを別のセッションで起動し、プロセスグループへ SIGINT を送った場合のテストです。ラッパーが終了コード 130 で終了し、hook の行が `rc=130` で 1 行だけ記録されることを確認します。"""
    with allure.step("子を起動してプロセスグループへ SIGINT を送る"):
        proc, _ = _start_blocking_child(script_dir, repo, tmp_path)
        os.killpg(proc.pid, signal.SIGINT)
    with allure.step("終了コードと rc=130 の記録を確かめる"):
        assert proc.wait(timeout=20) == 130
        rows = _rows(repo)
        assert [(r[1], r[2], r[4]) for r in rows] == [("hook", "sig-hook", "rc=130")]


@allure.title("子のプロセスだけが SIGTERM で終了すると、`rc=143` を記録し、同じコードで終了する")
def test_sigterm_to_child_records_rc_143(script_dir: Path, repo: Path, tmp_path: Path) -> None:
    """ラッパーの子のプロセスだけに SIGTERM を送った場合のテストです。ラッパーが終了コード 143 で終了し、hook の行が `rc=143` で 1 行だけ記録されることを確認します。"""
    with allure.step("子を起動して子へ SIGTERM を送る"):
        proc, child_pid = _start_blocking_child(script_dir, repo, tmp_path)
        os.kill(child_pid, signal.SIGTERM)
    with allure.step("終了コードと rc=143 の記録を確かめる"):
        assert proc.wait(timeout=20) == 143
        rows = _rows(repo)
        assert [(r[1], r[2], r[4]) for r in rows] == [("hook", "sig-hook", "rc=143")]
