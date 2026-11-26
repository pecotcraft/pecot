"""test_report/bash-test.sh が、bash のテストの確かめを 1 つずつ Allure の結果にすることのテスト。"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

_REPO = Path(__file__).resolve().parents[2]
_LIB_PATH = ".githooks/scripts/test_report/bash-test.sh"
_LANE = {"NX_TASK_TARGET_PROJECT": "pecot-visual", "NX_TASK_TARGET_TARGET": "test-hooks"}


@pytest.fixture(autouse=True)
def _repo(tmp_path: Path) -> Path:
    """tmp_path をリポのルートに見立て、bash-test.sh を同じ場所に写す。"""
    lib = tmp_path / _LIB_PATH
    lib.parent.mkdir(parents=True)
    shutil.copy(_REPO / _LIB_PATH, lib)
    return tmp_path


def _write_test(directory: Path, body: str, *, options: str = "set -u") -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "sample.test.sh"
    lib = Path(*[".."] * len(directory.relative_to(_root(directory)).parts)) / _LIB_PATH
    source = f'. "$(dirname "$0")/{lib.as_posix()}"'
    path.write_text(f"#!/bin/bash\n{options}\n{source}\n{body}\n", encoding="utf-8")
    return path


def _root(path: Path) -> Path:
    return next(parent for parent in [path, *path.parents] if (parent / _LIB_PATH).is_file())


def _run_files(
    tmp_path: Path, *tests: Path, results: Path | None
) -> subprocess.CompletedProcess[str]:
    """runner と同じく、bash-test.sh を読んだシェルから bt_run_files でファイルを動かす。"""
    runner = tmp_path / "runner.sh"
    runner.write_text(
        f'. "{tmp_path / _LIB_PATH}"\nPECOT_REPORT_RESULTS="{results or ""}"\nbt_run_files "$@"\n',
        encoding="utf-8",
    )
    return subprocess.run(
        ["bash", str(runner), *map(str, tests)],
        cwd=tmp_path,
        env={**os.environ, **_LANE},
        capture_output=True,
        text=True,
        check=False,
    )


def _run_file(
    tmp_path: Path, test: Path, *, results: Path | None
) -> subprocess.CompletedProcess[str]:
    return _run_files(tmp_path, test, results=results)


def _results(directory: Path) -> list[dict[str, Any]]:
    found = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(directory.glob("*-result.json"))
    ]
    return sorted(found, key=lambda result: result["stop"])


def _label(result: dict[str, Any], name: str) -> list[str]:
    return [label["value"] for label in result["labels"] if label["name"] == name]


def test_one_result_per_check_with_status_and_reason(tmp_path: Path) -> None:
    """確かめ 1 つに結果 1 つを書き、状態と理由を持たせる。落ちた確かめがあればファイルは 1 で終わる。"""
    body = "\n".join(
        [
            'bt_pass "通る"',
            'bt_fail "落ちる" "理由がある"',
            'bt_skip "飛ばす" "環境が無い"',
            'bt_eq "等しい" "a" "b"',
            'bt_ne "違う" "a" "a"',
            'bt_contains "含む" "zz" "abc"',
            'bt_not_contains "含まない" "b" "abc"',
            "bt_finish",
        ]
    )
    test = _write_test(tmp_path / "suite", body)
    done = _run_file(tmp_path, test, results=tmp_path / "results")

    assert done.returncode == 1, done.stdout + done.stderr
    got = [
        (r["name"], r["status"], r["statusDetails"].get("message"))
        for r in _results(tmp_path / "results")
    ]
    assert got == [
        ("通る", "passed", None),
        ("落ちる", "failed", "理由がある"),
        ("飛ばす", "skipped", "環境が無い"),
        ("等しい", "failed", "期待 [a] / 実際 [b]"),
        ("違う", "failed", "[a] と違う値のはずが、同じだった"),
        ("含む", "failed", "「zz」を含まない: abc"),
        ("含まない", "failed", "「b」を含む: abc"),
    ]
    assert "PASS: 1 / FAIL: 5 / SKIP: 1" in done.stdout


def test_eq_has_expected_and_actual(tmp_path: Path) -> None:
    """bt_eq は、Allure が差分を出せるよう expected と actual を書く。"""
    test = _write_test(tmp_path / "suite", 'bt_eq "等しい" "a" "b"\nbt_finish')
    _run_file(tmp_path, test, results=tmp_path / "results")

    [result] = _results(tmp_path / "results")
    assert result["statusDetails"]["expected"] == "a"
    assert result["statusDetails"]["actual"] == "b"


def test_labels_and_full_name(tmp_path: Path) -> None:
    """ラベルはレーン・ファイルのパス・host・thread を持ち、fullName はレーンとパスと題を持つ。"""
    test = _write_test(tmp_path / "plugins/p/tests", 'bt_pass "通る"\nbt_finish')
    _run_file(tmp_path, test, results=tmp_path / "results")

    [result] = _results(tmp_path / "results")
    path = "plugins/p/tests/sample.test.sh"
    assert _label(result, "project") == ["pecot-visual"]
    assert _label(result, "lane") == ["test-hooks"]
    assert _label(result, "parentSuite") == [path]
    assert _label(result, "language") == ["bash"]
    assert _label(result, "framework") == ["bash"]
    assert len(_label(result, "host")) == 1
    assert len(_label(result, "thread")) == 1
    assert result["fullName"] == f"pecot-visual:test-hooks {path}#通る"
    assert result["stage"] == "finished"
    assert isinstance(result["start"], int) and isinstance(result["stop"], int)
    assert result["start"] <= result["stop"]


def test_path_with_dot_dot_is_normalized(tmp_path: Path) -> None:
    """runner が .. を含むパスで渡しても、parentSuite はリポのルートからの正規のパスになる。"""
    test = _write_test(tmp_path / "plugins/p/tests", 'bt_pass "通る"\nbt_finish')
    detour = tmp_path / "plugins/p/../../plugins/p/tests" / test.name
    _run_file(tmp_path, detour, results=tmp_path / "results")

    [result] = _results(tmp_path / "results")
    assert _label(result, "parentSuite") == ["plugins/p/tests/sample.test.sh"]


def test_json_escapes_quotes_backslashes_and_control_characters(tmp_path: Path) -> None:
    """題と理由の引用符・バックスラッシュ・改行・タブ・制御文字・日本語を、JSON の文字列として書く。"""
    body = (
        'bt_fail "題 \\"引用\\" \\\\ 日本語" "$(printf \'1行目\\n2行目\\tタブ\\001\')"\nbt_finish'
    )
    test = _write_test(tmp_path / "suite", body)
    _run_file(tmp_path, test, results=tmp_path / "results")

    [result] = _results(tmp_path / "results")
    assert result["name"] == '題 "引用" \\ 日本語'
    assert result["statusDetails"]["message"] == "1行目\n2行目\tタブ\x01"


def test_without_results_dir_prints_only(tmp_path: Path) -> None:
    """結果のディレクトリが無いと、印字だけで結果を書かない。"""
    test = _write_test(tmp_path / "suite", 'bt_pass "通る"\nbt_finish')
    done = _run_file(tmp_path, test, results=None)

    assert done.returncode == 0, done.stdout + done.stderr
    assert "PASS: 通る" in done.stdout
    assert list(tmp_path.rglob("*-result.json")) == []


def test_run_directly_without_runner(tmp_path: Path) -> None:
    """runner を通さず bash で打っても、確かめと終了コードは今までどおり。"""
    test = _write_test(tmp_path / "suite", 'bt_pass "通る"\nbt_fail "落ちる" "理由"\nbt_finish')
    done = subprocess.run(["bash", str(test)], capture_output=True, text=True, check=False)

    assert done.returncode == 1
    assert "PASS: 通る" in done.stdout
    assert "FAIL: 落ちる — 理由" in done.stdout


def test_duplicate_title_fails_as_a_separate_result(tmp_path: Path) -> None:
    """1 ファイルで題が重なると、2 回目を別の 1 件の failed にする。"""
    test = _write_test(tmp_path / "suite", 'bt_pass "同じ"\nbt_pass "同じ"\nbt_finish')
    done = _run_file(tmp_path, test, results=tmp_path / "results")

    assert done.returncode == 1
    got = [(r["name"], r["status"]) for r in _results(tmp_path / "results")]
    assert got == [("同じ", "passed"), ("同じ（2 回目）", "failed")]
    assert len({r["fullName"] for r in _results(tmp_path / "results")}) == 2


def test_failure_in_subshell_is_counted(tmp_path: Path) -> None:
    """( ... ) の中で落ちた確かめも、ファイルの終了コードに数える。"""
    test = _write_test(tmp_path / "suite", '( bt_fail "中で落ちる" "理由" )\nbt_finish')
    done = _run_file(tmp_path, test, results=tmp_path / "results")

    assert done.returncode == 1
    assert "PASS: 0 / FAIL: 1 / SKIP: 0" in done.stdout


@pytest.mark.parametrize(
    ("options", "stop", "code"),
    [("set -eu", "false", 1), ("set -u", ': "$UNDEFINED_IN_TEST"', 1), ("set -u", "exit 0", 1)],
    ids=["set-e", "set-u", "exit-0"],
)
def test_file_stopped_before_finish_is_broken(
    tmp_path: Path, options: str, stop: str, code: int
) -> None:
    """bt_finish の前で終わると「最後まで動く」を broken として書き、それまでの確かめは残す。"""
    test = _write_test(tmp_path / "suite", f'bt_pass "前"\n{stop}\nbt_finish', options=options)
    done = _run_file(tmp_path, test, results=tmp_path / "results")

    assert done.returncode == code
    got = [(r["name"], r["status"]) for r in _results(tmp_path / "results")]
    assert got == [("前", "passed"), ("最後まで動く", "broken")]


def test_run_files_runs_every_file_and_lists_failures(tmp_path: Path) -> None:
    """bt_run_files は落ちたファイルの後も最後まで動かし、落ちたファイルの一覧を出して 1 を返す。"""
    first = _write_test(tmp_path / "a", 'bt_fail "落ちる" "理由"\nbt_finish')
    second = _write_test(tmp_path / "b", 'bt_pass "通る"\nbt_finish')
    done = _run_files(tmp_path, first, second, results=tmp_path / "results")

    assert done.returncode == 1
    assert [r["name"] for r in _results(tmp_path / "results")] == ["落ちる", "通る"]
    assert f"{first} (exit 1)" in done.stderr


def test_grandchild_does_not_write_to_the_lane(tmp_path: Path) -> None:
    """テストのファイルが動かした別の bash のテストは、レーンの結果に書かない。"""
    inner = _write_test(tmp_path / "inner", 'bt_pass "孫"\nbt_finish')
    outer = _write_test(tmp_path / "outer", f'bash "{inner}" > /dev/null\nbt_pass "子"\nbt_finish')
    _run_file(tmp_path, outer, results=tmp_path / "results")

    assert [r["name"] for r in _results(tmp_path / "results")] == ["子"]


def test_leaves_no_temporary_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """runner と、確かめの無いファイルを動かしても、一時ディレクトリに何も残さない。"""
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setenv("TMPDIR", str(temp))
    empty = _write_test(tmp_path / "empty", "bt_finish")
    done = _run_files(tmp_path, empty, results=tmp_path / "results")

    assert done.returncode == 0, done.stdout + done.stderr
    assert "No such file" not in done.stderr
    assert "PASS: 0 / FAIL: 0 / SKIP: 0" in done.stdout
    assert list(temp.iterdir()) == []


@pytest.mark.skipif(shutil.which("pnpm") is None, reason="pnpm が要る")
def test_real_allure_reads_the_results(tmp_path: Path) -> None:
    """Allure 3 が書いた結果を読み、題・状態・理由をレポートに載せる。"""
    test = _write_test(tmp_path / "suite", 'bt_pass "通る"\nbt_eq "等しい" "a" "b"\nbt_finish')
    _run_file(tmp_path, test, results=tmp_path / "results")
    report = tmp_path / "report"
    done = subprocess.run(
        ["pnpm", "exec", "allure", "generate", "--output", str(report), str(tmp_path / "results")],
        cwd=_REPO,
        capture_output=True,
        text=True,
        check=False,
    )

    assert done.returncode == 0, done.stdout + done.stderr
    read = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in (report / "data/test-results").glob("*.json")
    ]
    got = sorted((r["name"], r["status"], (r.get("error") or {}).get("message")) for r in read)
    assert got == [("等しい", "failed", "期待 [a] / 実際 [b]"), ("通る", "passed", None)]
