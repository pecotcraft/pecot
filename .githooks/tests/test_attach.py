"""attach.py が、子プロセスの出力と書き出したファイルを Allure の添付に残すことのテスト。

pytest を子で動かし、--alluredir に残った結果の添付を読む。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import allure

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import run_attached  # noqa: E402

_ATTACH = Path(__file__).resolve().parent / "attach.py"

_HEADER = """\
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import attach_output, read_output, run_attached  # noqa: E402

EMIT = ["bash", str(Path(__file__).with_name("emit.sh"))]
"""

# stdout・stderr・終了コード・待つ秒を引数で受ける。bash -c に値を渡さない（.claude/rules/test-conventions.md）。
_EMIT = 'printf "%s" "$1"; printf "%s" "$2" >&2; sleep "${4:-0}"; exit "$3"\n'


def _run_pytest(tmp_path: Path, body: str, *args: str) -> subprocess.CompletedProcess[str]:
    suite = tmp_path / "suite"
    suite.mkdir()
    shutil.copy(_ATTACH, suite / "attach.py")
    (suite / "emit.sh").write_text(_EMIT, encoding="utf-8")
    (suite / "test_sample.py").write_text(_HEADER + body, encoding="utf-8")
    return run_attached(
        [
            sys.executable,
            "-m",
            "pytest",
            str(suite),
            "-q",
            "-p",
            "no:cacheprovider",
            "--rootdir",
            str(suite),
            *args,
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )


def _attachments(results: Path) -> dict[str, list[tuple[str, str, str]]]:
    """テストの名前ごとに、添付の（名前・型・中身）を、setup と本体の順に並べる。"""

    def collect(node: dict[str, Any]) -> list[dict[str, Any]]:
        found = list(node.get("attachments", []))
        for step in node.get("steps", []):
            found += collect(step)
        return found

    by_test: dict[str, list[tuple[str, str, str]]] = {}
    for path in sorted(results.glob("*-result.json")):
        result = json.loads(path.read_text(encoding="utf-8"))
        by_test[result["name"]] = [
            (item["name"], item["type"], (results / item["source"]).read_text(encoding="utf-8"))
            for item in collect(result)
        ]
    return by_test


def test_run_attached_attaches_stdout_and_stderr(tmp_path: Path) -> None:
    """run_attached は、コマンドと終了コードを名前にして、空でない stdout と stderr を添付し、結果をそのまま返す。"""
    body = """
def test_run() -> None:
    done = run_attached([*EMIT, "out", "err", "3"], capture_output=True, text=True)
    assert (done.returncode, done.stdout, done.stderr) == (3, "out", "err")
"""
    with allure.step("run_attached を呼ぶテストを子の pytest で動かす"):
        results = tmp_path / "allure-results"
        done = _run_pytest(tmp_path, body, "--alluredir", str(results))
    with allure.step("stdout と stderr の添付を比べる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert _attachments(results)["test_run"] == [
            (
                f"bash {tmp_path}/suite/emit.sh out err 3（終了コード 3） stdout",
                "text/plain",
                "out",
            ),
            (
                f"bash {tmp_path}/suite/emit.sh out err 3（終了コード 3） stderr",
                "text/plain",
                "err",
            ),
        ]


def test_run_attached_check_attaches_before_raising(tmp_path: Path) -> None:
    """check=True で終了コードが 0 でないとき、出力を添付してから CalledProcessError を投げる。"""
    body = """
def test_check() -> None:
    run_attached([*EMIT, "", "broken", "1"], capture_output=True, text=True, check=True)
"""
    with allure.step("check=True で落ちるテストを子の pytest で動かす"):
        results = tmp_path / "allure-results"
        done = _run_pytest(tmp_path, body, "--alluredir", str(results))
    with allure.step("CalledProcessError と stderr の添付を確かめる"):
        assert done.returncode == 1
        assert "CalledProcessError" in done.stdout
        assert _attachments(results)["test_check"] == [
            (
                f"bash {tmp_path}/suite/emit.sh  broken 1（終了コード 1） stderr",
                "text/plain",
                "broken",
            ),
        ]


def test_run_attached_timeout_attaches_partial_output(tmp_path: Path) -> None:
    """timeout で止まると、そこまでの出力を添付してから TimeoutExpired を投げる。"""
    body = """
def test_timeout() -> None:
    run_attached([*EMIT, "started", "", "0", "5"], capture_output=True, text=True, timeout=1)
"""
    with allure.step("timeout で止まるテストを子の pytest で動かす"):
        results = tmp_path / "allure-results"
        done = _run_pytest(tmp_path, body, "--alluredir", str(results))
    with allure.step("TimeoutExpired と途中までの出力の添付を確かめる"):
        assert done.returncode == 1
        assert "TimeoutExpired" in done.stdout
        assert _attachments(results)["test_timeout"] == [
            (
                f"bash {tmp_path}/suite/emit.sh started  0 5（timeout） stdout",
                "text/plain",
                "started",
            ),
        ]


def test_attach_output_and_read_output(tmp_path: Path) -> None:
    """出力が両方空なら空の stdout を 1 つ添付し、読んだファイルは中身を拡張子の型で添付する。"""
    body = """
def test_files(tmp_path: Path) -> None:
    attach_output("server", "", "", 0)
    (tmp_path / "report.md").write_text("# Title\\n", encoding="utf-8")
    (tmp_path / "result.json").write_text('{"a": 1}', encoding="utf-8")
    assert read_output(tmp_path / "report.md") == "# Title\\n"
    assert read_output(tmp_path / "result.json") == '{"a": 1}'
"""
    with allure.step("attach_output と read_output を呼ぶテストを子の pytest で動かす"):
        results = tmp_path / "allure-results"
        done = _run_pytest(tmp_path, body, "--alluredir", str(results))
    with allure.step("出力とファイルの添付を比べる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert _attachments(results)["test_files"] == [
            ("server（終了コード 0） stdout", "text/plain", ""),
            ("report.md", "text/plain", "# Title\n"),
            ("result.json", "application/json", '{"a": 1}'),
        ]


def test_without_alluredir_nothing_is_written(tmp_path: Path) -> None:
    """--alluredir が無いと、添付せずに結果をそのまま返す。"""
    body = """
def test_run() -> None:
    done = run_attached([*EMIT, "out", "", "0"], capture_output=True, text=True, check=True)
    assert done.stdout == "out"
"""
    with allure.step("--alluredir を渡さずに子の pytest を動かす"):
        done = _run_pytest(tmp_path, body)
    with allure.step("通って、結果のディレクトリが無いことを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert not (tmp_path / "allure-results").exists()
