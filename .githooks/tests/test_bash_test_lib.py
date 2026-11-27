"""test_report/bash-test.sh が、bash のテストの確かめを 1 つずつ Allure の結果にすることのテスト。"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
_LIB_PATH = ".githooks/scripts/test_report/bash-test.sh"
_LANE = {"NX_TASK_TARGET_PROJECT": "pecot-visual", "NX_TASK_TARGET_TARGET": "test-hooks"}


@pytest.fixture(autouse=True)
def _repo(tmp_path: Path) -> Path:
    """tmp_path をリポのルートに見立て、bash-test.sh と、それが読む allure-result.sh を同じ場所に写す。"""
    lib = tmp_path / _LIB_PATH
    lib.parent.mkdir(parents=True)
    shutil.copy(_REPO / _LIB_PATH, lib)
    shutil.copy((_REPO / _LIB_PATH).parent / "allure-result.sh", lib.parent)
    return tmp_path


def _write_test(directory: Path, body: str, *, options: str = "set -u") -> Path:
    with allure.step("bash のテストのファイルを書く"):
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "sample.test.sh"
        lib = Path(*[".."] * len(directory.relative_to(_root(directory)).parts)) / _LIB_PATH
        source = f'. "$(dirname "$0")/{lib.as_posix()}"'
        path.write_text(f"#!/bin/bash\n{options}\n{source}\n{body}\n", encoding="utf-8")
        return path


def _root(path: Path) -> Path:
    return next(parent for parent in [path, *path.parents] if (parent / _LIB_PATH).is_file())


def _run_files(
    tmp_path: Path, *tests: Path, results: Path | None, lane: dict[str, str] = _LANE
) -> subprocess.CompletedProcess[str]:
    """runner と同じく、bash-test.sh を読んだシェルから bt_run_files でファイルを動かす。"""
    with allure.step("bt_run_files でテストのファイルを動かす"):
        runner = tmp_path / "runner.sh"
        runner.write_text(
            f'. "{tmp_path / _LIB_PATH}"\nPECOT_REPORT_RESULTS="{results or ""}"\nbt_run_files "$@"\n',
            encoding="utf-8",
        )
        return run_attached(
            ["bash", str(runner), *map(str, tests)],
            cwd=tmp_path,
            env={**os.environ, **lane},
            capture_output=True,
            text=True,
        )


def _run_file(
    tmp_path: Path, test: Path, *, results: Path | None, lane: dict[str, str] = _LANE
) -> subprocess.CompletedProcess[str]:
    return _run_files(tmp_path, test, results=results, lane=lane)


def _results(directory: Path) -> list[dict[str, Any]]:
    with allure.step("書かれた Allure の結果を読む"):
        found = [json.loads(read_output(path)) for path in sorted(directory.glob("*-result.json"))]
        return sorted(found, key=lambda result: result["stop"])


def _label(result: dict[str, Any], name: str) -> list[str]:
    return [label["value"] for label in result["labels"] if label["name"] == name]


@allure.title("bash のテストに確認を書くと、確認 1 つにつき状態と理由を持つ結果が 1 つ書かれる")
def test_one_result_per_check_with_status_and_reason(tmp_path: Path) -> None:
    """`bash-test.sh` の確認用の関数が、Allure の結果を書くときのテストです。通る確認・落ちる確認・飛ばす確認が、確認ごとに 1 つの結果として状態と理由つきで書かれ、落ちた確認があるファイルは終了コード 1 で終わることを確認します。"""
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
    results = _results(tmp_path / "results")

    with allure.step("終了コードと、確かめごとの状態と理由を確かめる"):
        assert done.returncode == 1, done.stdout + done.stderr
        got = [(r["name"], r["status"], r["statusDetails"].get("message")) for r in results]
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


@allure.title("bt_eq で値が異なると、結果に expected と actual を書く")
def test_eq_has_expected_and_actual(tmp_path: Path) -> None:
    """`bt_eq` で 2 つの値が異なる場合のテストです。Allure が差分を表示できるように、結果に期待値（`expected`）と実際の値（`actual`）が書かれることを確認します。"""
    test = _write_test(tmp_path / "suite", 'bt_eq "等しい" "a" "b"\nbt_finish')
    _run_file(tmp_path, test, results=tmp_path / "results")
    [result] = _results(tmp_path / "results")

    with allure.step("expected と actual を確かめる"):
        assert result["statusDetails"]["expected"] == "a"
        assert result["statusDetails"]["actual"] == "b"


@allure.title(
    "結果にはレーン・ファイルのパス・機能の階層・host・thread のラベルを付け、fullName にはレーンとパスと題を含める"
)
def test_labels_and_full_name(tmp_path: Path) -> None:
    """bash のテストの結果に付くラベルと `fullName` のテストです。project・lane・parentSuite・epic・feature・story などのラベルが付き、`fullName` にレーンとファイルのパスと題が含まれることを確認します。"""
    test = _write_test(tmp_path / "plugins/p/tests", 'bt_pass "通る"\nbt_finish')
    _run_file(tmp_path, test, results=tmp_path / "results")
    [result] = _results(tmp_path / "results")

    with allure.step("ラベル・fullName・時刻を確かめる"):
        path = "plugins/p/tests/sample.test.sh"
        assert _label(result, "project") == ["pecot-visual"]
        assert _label(result, "lane") == ["test-hooks"]
        assert _label(result, "parentSuite") == [path]
        assert _label(result, "epic") == ["pecot-visual"]
        assert _label(result, "feature") == ["plugins/p/tests"]
        assert _label(result, "story") == [path]
        assert _label(result, "language") == ["bash"]
        assert _label(result, "framework") == ["bash"]
        assert len(_label(result, "host")) == 1
        assert len(_label(result, "thread")) == 1
        assert result["fullName"] == f"pecot-visual:test-hooks {path}#通る"
        assert result["stage"] == "finished"
        assert isinstance(result["start"], int) and isinstance(result["stop"], int)
        assert result["start"] <= result["stop"]
        assert _label(result, "layer") == []


def _project(root: Path, table: str | None) -> None:
    with allure.step("project.json と層の表を置く"):
        root.mkdir(parents=True, exist_ok=True)
        (root / "project.json").write_text("{}", encoding="utf-8")
        if table is not None:
            (root / "test-layers.txt").write_text(table, encoding="utf-8")


@allure.title(
    "{case}テストのファイルの結果に、project の test-layers.txt で引いた層 {expected} を付ける"
)
@pytest.mark.parametrize(
    ("case", "table", "expected"),
    [
        ("ディレクトリの規則に当たる", "# 層の表\nintegration tests/\n", ["integration"]),
        (
            "ファイルの規則にも当たる",
            "integration tests/\n  e2e   tests/sample.test.sh\n",
            ["e2e"],
        ),
        ("どの規則にも当たらない", "unit other/\n", []),
        ("層の表の無い project の", None, []),
    ],
    ids=["directory", "file", "no-match", "no-table"],
)
def test_layer_label_from_project_table(
    tmp_path: Path, case: str, table: str | None, expected: list[str]
) -> None:
    """bash のテストの結果に付く層のラベルのテストです。テストのファイルの属する project の `test-layers.txt` で、当たる規則のうちパスの長いものの層が `layer` として付くことを確認します。"""
    _project(tmp_path / "plugins/p", table)
    test = _write_test(tmp_path / "plugins/p/tests", 'bt_pass "通る"\nbt_finish')
    _run_file(tmp_path, test, results=tmp_path / "results")
    [result] = _results(tmp_path / "results")

    with allure.step("layer のラベルを比べる"):
        assert _label(result, "layer") == expected


@allure.title("bt_finish の前で終わったファイルの broken の結果にも、層のラベルを付ける")
def test_broken_result_has_layer(tmp_path: Path) -> None:
    """`bt_finish` を呼ぶ前に終わったテストのファイルについて、runner が書く broken の結果のテストです。runner 自身の場所ではなく、テストのファイルの project の層の表で引いた `layer` が付くことを確認します。"""
    _project(tmp_path / "plugins/p", "integration tests/\n")
    test = _write_test(tmp_path / "plugins/p/tests", 'bt_pass "通る"\nexit 3')
    _run_file(tmp_path, test, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("broken の結果と layer を比べる"):
        assert [(r["name"], r["status"], _label(r, "layer")) for r in results] == [
            ("通る", "passed", ["integration"]),
            ("最後まで動く", "broken", ["integration"]),
        ]


@allure.title(
    "runner が .. を含むパスでファイルを渡しても、parentSuite はリポのルートからの正規のパスになる"
)
def test_path_with_dot_dot_is_normalized(tmp_path: Path) -> None:
    """`..` を含むパスでテストのファイルを渡した場合のテストです。parentSuite のラベルが、リポのルートからの正規のパスになることを確認します。"""
    test = _write_test(tmp_path / "plugins/p/tests", 'bt_pass "通る"\nbt_finish')
    detour = tmp_path / "plugins/p/../../plugins/p/tests" / test.name
    _run_file(tmp_path, detour, results=tmp_path / "results")
    [result] = _results(tmp_path / "results")

    with allure.step("parentSuite・feature・story が正規のパスであることを確かめる"):
        assert _label(result, "parentSuite") == ["plugins/p/tests/sample.test.sh"]
        assert _label(result, "feature") == ["plugins/p/tests"]
        assert _label(result, "story") == ["plugins/p/tests/sample.test.sh"]


@allure.title(
    "リポのルートの直下のテストのファイルは、feature が . になり、story がファイルの名前になる"
)
def test_file_at_repo_root_has_dot_as_feature(tmp_path: Path) -> None:
    """リポのルートの直下に置いたテストのファイルのテストです。feature のラベルが `.`、story のラベルがファイルの名前になることを確認します。"""
    test = _write_test(tmp_path, 'bt_pass "通る"\nbt_finish')
    _run_file(tmp_path, test, results=tmp_path / "results")
    [result] = _results(tmp_path / "results")

    with allure.step("feature と story を確かめる"):
        assert _label(result, "feature") == ["."]
        assert _label(result, "story") == ["sample.test.sh"]


@allure.title("nx の project が無いと、epic と project を付けず、feature と story は付ける")
def test_without_project_no_epic(tmp_path: Path) -> None:
    """`NX_TASK_TARGET_PROJECT` が空の場合のテストです。結果に epic と project のラベルが付かず、feature と story のラベルが付くことを確認します。"""
    test = _write_test(tmp_path / "suite", 'bt_pass "通る"\nbt_finish')
    _run_file(tmp_path, test, results=tmp_path / "results", lane={"NX_TASK_TARGET_PROJECT": ""})
    [result] = _results(tmp_path / "results")

    with allure.step("epic と project が無く、feature と story があることを確かめる"):
        assert _label(result, "epic") == []
        assert _label(result, "project") == []
        assert _label(result, "feature") == ["suite"]
        assert _label(result, "story") == ["suite/sample.test.sh"]


@allure.title("{param_id} のレーンの確認の結果には、場所から決めた段階の severity を 1 つ付ける")
@pytest.mark.parametrize(
    ("project", "lane", "expected"),
    [
        ("pecot-tools", "test-release", "blocker"),
        ("githooks", "test-ci", "minor"),
        ("pecot-visual", "test-hooks", "normal"),
    ],
    ids=[
        "pecot-tools:test-release",
        "githooks:test-ci",
        "pecot-visual:test-hooks",
    ],
)
def test_severity_defaults_by_lane(tmp_path: Path, project: str, lane: str, expected: str) -> None:
    """`bt_severity` を呼ばないテストのファイルの、重大度のラベルのテストです。nx の project とレーンから重大度の表で決めた段階が、結果の severity に 1 つだけ付くことを確認します。"""
    test = _write_test(tmp_path / "suite", 'bt_pass "通る"\nbt_finish')
    lane_env = {"NX_TASK_TARGET_PROJECT": project, "NX_TASK_TARGET_TARGET": lane}
    _run_file(tmp_path, test, results=tmp_path / "results", lane=lane_env)
    [result] = _results(tmp_path / "results")

    with allure.step("severity の値を確かめる"):
        assert _label(result, "severity") == [expected]


@allure.title(
    "bt_severity を呼ぶと、その後の確認の結果だけが、場所から決まる段階の代わりに渡した段階を持つ"
)
def test_bt_severity_applies_to_later_checks(tmp_path: Path) -> None:
    """テストのファイルの途中で `bt_severity trivial` を呼んだ場合のテストです。呼ぶ前の確認はレーンから決まる `normal`、呼んだ後の確認は `trivial` の severity を持つことを確認します。"""
    body = 'bt_pass "前"\nbt_severity trivial\nbt_pass "後"\nbt_fail "後で落ちる" "理由"\nbt_finish'
    test = _write_test(tmp_path / "suite", body)
    _run_file(tmp_path, test, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("確認ごとの severity を確かめる"):
        got = [(r["name"], _label(r, "severity")) for r in results]
        assert got == [("前", ["normal"]), ("後", ["trivial"]), ("後で落ちる", ["trivial"])]


@allure.title("bt_severity に 5 つの段階のほかを渡すと、理由を標準エラーに出してファイルを止める")
def test_bt_severity_rejects_unknown_level(tmp_path: Path) -> None:
    """`bt_severity` に、Allure の 5 つの段階に無い値を渡した場合のテストです。理由が標準エラーに表示されてファイルが止まり、「最後まで動く」がレーンから決まる段階の broken として書かれることを確認します。"""
    test = _write_test(tmp_path / "suite", 'bt_severity urgent\nbt_pass "後"\nbt_finish')
    done = _run_file(tmp_path, test, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("終了コード・標準エラー・broken の 1 件を確かめる"):
        assert done.returncode == 1
        assert (
            "bt_severity の段階は blocker・critical・normal・minor・trivial のどれか" in done.stderr
        )
        assert "urgent" in done.stderr
        got = [(r["name"], r["status"], _label(r, "severity")) for r in results]
        assert got == [("最後まで動く", "broken", ["normal"])]


@allure.title(
    "題と理由に引用符・バックスラッシュ・制御文字・日本語を含めても、JSON の文字列として正しく書く"
)
def test_json_escapes_quotes_backslashes_and_control_characters(tmp_path: Path) -> None:
    """題と理由に特殊な文字を含めた場合のテストです。引用符・バックスラッシュ・改行・タブ・制御文字・日本語が、JSON にエスケープされて書かれ、読み戻すと元の文字列と一致することを確認します。"""
    body = (
        'bt_fail "題 \\"引用\\" \\\\ 日本語" "$(printf \'1行目\\n2行目\\tタブ\\001\')"\nbt_finish'
    )
    test = _write_test(tmp_path / "suite", body)
    _run_file(tmp_path, test, results=tmp_path / "results")
    [result] = _results(tmp_path / "results")

    with allure.step("題と理由が元の文字のまま読めることを確かめる"):
        assert result["name"] == '題 "引用" \\ 日本語'
        assert result["statusDetails"]["message"] == "1行目\n2行目\tタブ\x01"


@allure.title("結果のディレクトリを指定しないと、画面に出力するだけで結果のファイルは書かない")
def test_without_results_dir_prints_only(tmp_path: Path) -> None:
    """結果の出力先（`PECOT_REPORT_RESULTS`）を指定せずに実行した場合のテストです。`PASS: 通る` が標準出力に表示され、Allure の結果ファイルが 1 つも作成されないことを確認します。"""
    test = _write_test(tmp_path / "suite", 'bt_pass "通る"\nbt_finish')
    done = _run_file(tmp_path, test, results=None)

    with allure.step("印字があり、結果のファイルが無いことを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert "PASS: 通る" in done.stdout
        assert list(tmp_path.rglob("*-result.json")) == []


@allure.title("runner を通さず bash で直接実行しても、確認の結果と終了コードは変わらない")
def test_run_directly_without_runner(tmp_path: Path) -> None:
    """テストのファイルを runner を通さずに `bash` で直接実行した場合のテストです。落ちる確認があるため終了コード 1 で終わり、`PASS` と `FAIL` の行が標準出力に表示されることを確認します。"""
    test = _write_test(tmp_path / "suite", 'bt_pass "通る"\nbt_fail "落ちる" "理由"\nbt_finish')
    with allure.step("runner を通さず bash でファイルを動かす"):
        done = run_attached(["bash", str(test)], capture_output=True, text=True)

    with allure.step("終了コードと印字を確かめる"):
        assert done.returncode == 1
        assert "PASS: 通る" in done.stdout
        assert "FAIL: 落ちる — 理由" in done.stdout


@allure.title("1 つのファイルで同じ題の確認が 2 回あると、2 回目を別の結果として失敗にする")
def test_duplicate_title_fails_as_a_separate_result(tmp_path: Path) -> None:
    """同じファイルの中で、同じ題の確認を 2 回実行した場合のテストです。2 回目は題に「（2 回目）」が付いた別の結果になって失敗し、終了コード 1 で終わることを確認します。"""
    test = _write_test(tmp_path / "suite", 'bt_pass "同じ"\nbt_pass "同じ"\nbt_finish')
    done = _run_file(tmp_path, test, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("2 回目が別の題の failed になることを確かめる"):
        assert done.returncode == 1
        got = [(r["name"], r["status"]) for r in results]
        assert got == [("同じ", "passed"), ("同じ（2 回目）", "failed")]
        assert len({r["fullName"] for r in results}) == 2


@allure.title("サブシェルの中で確認が失敗しても、ファイルの終了コードと失敗の件数に数える")
def test_failure_in_subshell_is_counted(tmp_path: Path) -> None:
    """`( ... )` のサブシェルの中で、確認が落ちた場合のテストです。ファイルが終了コード 1 で終わり、集計に `FAIL: 1` が表示されることを確認します。"""
    test = _write_test(tmp_path / "suite", '( bt_fail "中で落ちる" "理由" )\nbt_finish')
    done = _run_file(tmp_path, test, results=tmp_path / "results")

    with allure.step("終了コードと数を確かめる"):
        assert done.returncode == 1
        assert "PASS: 0 / FAIL: 1 / SKIP: 0" in done.stdout


@allure.title(
    "bt_finish の前でファイルが終了すると、「最後まで動く」を broken として書き、それまでの確認は残す（{param_id}）"
)
@pytest.mark.parametrize(
    ("options", "stop", "code"),
    [("set -eu", "false", 1), ("set -u", ': "$UNDEFINED_IN_TEST"', 1), ("set -u", "exit 0", 1)],
    ids=["set-e", "set-u", "exit-0"],
)
def test_file_stopped_before_finish_is_broken(
    tmp_path: Path, options: str, stop: str, code: int
) -> None:
    """`bt_finish` を呼ぶ前にテストのファイルが終了した場合のテストです。`set -e` や `set -u` による停止、`exit 0` の場合に、「最後まで動く」という結果が broken として書かれ、それまでの確認の結果は残ることを確認します。"""
    test = _write_test(tmp_path / "suite", f'bt_pass "前"\n{stop}\nbt_finish', options=options)
    done = _run_file(tmp_path, test, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("終了コードと、broken の 1 件を確かめる"):
        assert done.returncode == code
        got = [(r["name"], r["status"]) for r in results]
        assert got == [("前", "passed"), ("最後まで動く", "broken")]


@allure.title(
    "ファイルが途中で止まると、broken の結果の trace に stderr の末尾を含め、stderr もそのまま出力する"
)
def test_broken_has_the_tail_of_stderr(tmp_path: Path) -> None:
    """テストのファイルが未定義の変数で途中停止した場合のテストです。broken の結果の `trace` に、止まった原因を示す stderr の末尾が含まれ、stderr にも同じ内容がそのまま出力されることを確認します。"""
    test = _write_test(
        tmp_path / "suite", 'echo "前提が崩れた" >&2\n: "$UNDEFINED_IN_TEST"\nbt_finish'
    )
    done = _run_file(tmp_path, test, results=tmp_path / "results")
    [broken] = _results(tmp_path / "results")

    with allure.step("trace と stderr に止まった原因の行があることを確かめる"):
        trace = broken["statusDetails"]["trace"]
        assert "前提が崩れた" in trace
        assert "UNDEFINED_IN_TEST: unbound variable" in trace
        assert "UNDEFINED_IN_TEST: unbound variable" in done.stderr


@allure.title(
    "bt_run_files は失敗したファイルがあっても最後まで実行し、失敗したファイルの一覧を出力して 1 で終わる"
)
def test_run_files_runs_every_file_and_lists_failures(tmp_path: Path) -> None:
    """`bt_run_files` で複数のテストのファイルを実行した場合のテストです。最初のファイルが失敗しても 2 つ目まで実行され、失敗したファイルが標準エラーに一覧表示されて、終了コード 1 で終わることを確認します。"""
    first = _write_test(tmp_path / "a", 'bt_fail "落ちる" "理由"\nbt_finish')
    second = _write_test(tmp_path / "b", 'bt_pass "通る"\nbt_finish')
    done = _run_files(tmp_path, first, second, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("両方の確かめが残り、落ちたファイルが一覧に出ることを確かめる"):
        assert done.returncode == 1
        assert [r["name"] for r in results] == ["落ちる", "通る"]
        assert f"{first} (exit 1)" in done.stderr


@allure.title("テストのファイルから起動した別の bash のテストは、レーンの結果に書き込まない")
def test_grandchild_does_not_write_to_the_lane(tmp_path: Path) -> None:
    """テストのファイルの中から、別の bash のテストを起動した場合のテストです。孫にあたるテストの結果は書かれず、起動したファイルの確認の結果だけが残ることを確認します。"""
    inner = _write_test(tmp_path / "inner", 'bt_pass "孫"\nbt_finish')
    outer = _write_test(tmp_path / "outer", f'bash "{inner}" > /dev/null\nbt_pass "子"\nbt_finish')
    _run_file(tmp_path, outer, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("子の確かめだけが残ることを確かめる"):
        assert [r["name"] for r in results] == ["子"]


@allure.title("確認を含まないファイルを runner で実行しても、一時ディレクトリにファイルを残さない")
def test_leaves_no_temporary_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """確認を 1 つも含まないテストのファイルを runner で実行した場合のテストです。`TMPDIR` のディレクトリにファイルが残らず、`PASS: 0 / FAIL: 0 / SKIP: 0` が表示されることを確認します。"""
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setenv("TMPDIR", str(temp))
    empty = _write_test(tmp_path / "empty", "bt_finish")
    done = _run_files(tmp_path, empty, results=tmp_path / "results")

    with allure.step("一時ディレクトリが空のままであることを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert "No such file" not in done.stderr
        assert "PASS: 0 / FAIL: 0 / SKIP: 0" in done.stdout
        assert list(temp.iterdir()) == []


@allure.title(
    "実際の Allure で結果を読み込むと、題・状態・理由・期待値と実際の値・ラベルがレポートに含まれる"
)
@pytest.mark.skipif(shutil.which("pnpm") is None, reason="pnpm が要る")
def test_real_allure_reads_the_results(tmp_path: Path) -> None:
    """bash のテストが書いた結果を、実際の Allure 3 で `allure generate` して読み込んだ場合のテストです。通る確認と失敗する確認の題・状態・理由・期待値と実際の値、さらに project・lane・parentSuite・severity のラベルがレポートに含まれることを確認します。"""
    _project(tmp_path / "suite", "integration sample.test.sh\n")
    test = _write_test(tmp_path / "suite", 'bt_pass "通る"\nbt_eq "等しい" "a" "b"\nbt_finish')
    _run_file(tmp_path, test, results=tmp_path / "results")
    report = tmp_path / "report"
    with allure.step("allure generate でレポートを作る"):
        done = run_attached(
            [
                "pnpm",
                "exec",
                "allure",
                "generate",
                "--output",
                str(report),
                str(tmp_path / "results"),
            ],
            cwd=_REPO,
            capture_output=True,
            text=True,
        )
    with allure.step("レポートが読んだテストの結果を集める"):
        assert done.returncode == 0, done.stdout + done.stderr
        read = [
            json.loads(read_output(path)) for path in (report / "data/test-results").glob("*.json")
        ]
        by_name = {r["name"]: r for r in read}

    with allure.step("題・状態・理由・期待と実際・ラベルを確かめる"):
        assert sorted(by_name) == ["等しい", "通る"]
        assert by_name["通る"]["status"] == "passed"
        assert by_name["等しい"]["status"] == "failed"
        error = by_name["等しい"]["error"]
        assert (error["message"], error["expected"], error["actual"]) == (
            "期待 [a] / 実際 [b]",
            "a",
            "b",
        )
        labels = {label["name"]: label["value"] for label in by_name["通る"]["labels"]}
        assert (labels["project"], labels["lane"], labels["parentSuite"]) == (
            "pecot-visual",
            "test-hooks",
            "suite/sample.test.sh",
        )
        assert (labels["epic"], labels["feature"], labels["story"]) == (
            "pecot-visual",
            "suite",
            "suite/sample.test.sh",
        )
        assert labels["layer"] == "integration"
        assert labels["severity"] == "normal"
