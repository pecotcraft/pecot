"""test_report/bats の run.sh と allure-formatter.sh が、bats の @test ごとに Allure の結果を書くことのテスト。

本物の bats（root の node_modules）を動かす。tmp_path をリポのルートに見立て、仕組みのファイルを写す。
"""

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
_REPORT = ".githooks/scripts/test_report"
_LANE = {"NX_TASK_TARGET_PROJECT": "pecot-visual", "NX_TASK_TARGET_TARGET": "test-compare"}
_SETUP = "setup() {\n    bats_load_library pecot-bats\n}\n\n"

pytestmark = pytest.mark.skipif(
    not (_REPO / "node_modules/.bin/bats").exists(), reason="root の node_modules に bats が要る"
)


@pytest.fixture(autouse=True)
def _repo(tmp_path: Path) -> Path:
    """tmp_path をリポのルートに見立て、run.sh・formatter・pecot-bats・allure-result.sh を写し、node_modules をつなぐ。"""
    shutil.copytree(_REPO / _REPORT / "bats", tmp_path / _REPORT / "bats")
    shutil.copy(_REPO / _REPORT / "allure-result.sh", tmp_path / _REPORT)
    (tmp_path / "node_modules").symlink_to(_REPO / "node_modules")
    return tmp_path


def _case(title: str, *commands: str) -> str:
    """題と本体のコマンドから、@test を 1 つ組み立てる。"""
    body = "".join(f"    {command}\n" for command in commands)
    return '@test "' + title + '" {\n' + body + "}\n\n"


def _write_test(directory: Path, *cases: str, prelude: str = "") -> Path:
    with allure.step("bats のテストのファイルを書く"):
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "sample.bats"
        path.write_text(_SETUP + prelude + "".join(cases), encoding="utf-8")
        return path


def _run(
    tmp_path: Path, *tests: Path, results: Path | None, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    with allure.step("run.sh でテストのファイルを動かす"):
        extra = {"PECOT_REPORT_RESULTS": str(results)} if results else {}
        base = {k: v for k, v in os.environ.items() if k != "PECOT_REPORT_RESULTS"}
        return run_attached(
            ["bash", str(tmp_path / _REPORT / "bats/run.sh"), *map(str, tests)],
            cwd=tmp_path,
            env={**base, **_LANE, **extra, **(env or {})},
            capture_output=True,
            text=True,
        )


def _results(directory: Path) -> dict[str, dict[str, Any]]:
    with allure.step("書かれた Allure の結果を読む"):
        found = [json.loads(read_output(path)) for path in directory.glob("*-result.json")]
        return {result["name"]: result for result in found}


def _label(result: dict[str, Any], name: str) -> list[str]:
    return [label["value"] for label in result["labels"] if label["name"] == name]


@allure.title("@test ごとに、状態・説明・理由・期待値と実際の値を持つ結果を 1 件書く")
def test_one_result_per_test(tmp_path: Path) -> None:
    """通る・失敗する・飛ばす `@test` を持つファイルを、結果のディレクトリを指定して `run.sh` で実行するテストです。`@test` ごとに状態と説明を持つ結果が書かれ、`assert_equal` の失敗には理由・期待値・実際の値が入り、終了コード 1 で終わることを確認します。"""
    test = _write_test(
        tmp_path / "suite",
        _case("通る", 'explains "通るテストです。"', "run true", "assert_success"),
        _case("等しくない", 'explains "失敗するテストです。"', 'assert_equal "a" "b"'),
        _case("飛ばす", 'explains "飛ばすテストです。"', 'skip "環境が無い"'),
    )
    done = _run(tmp_path, test, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("終了コードと、@test ごとの状態・説明・理由を比べる"):
        assert done.returncode == 1, done.stdout + done.stderr
        got = {
            name: (r["status"], r.get("description"), r["statusDetails"].get("message"))
            for name, r in results.items()
        }
        assert got == {
            "通る": ("passed", "通るテストです。", None),
            "等しくない": ("failed", "失敗するテストです。", "values do not equal"),
            "飛ばす": ("skipped", "飛ばすテストです。", "環境が無い"),
        }
        details = results["等しくない"]["statusDetails"]
        # assert_equal は、実際の値・期待値の順に取る。
        assert (details["expected"], details["actual"]) == ("b", "a")
        assert "values do not equal" in details["trace"]
        assert "FAILED: 1 本のテストが失敗しました" in done.stderr


@allure.title("複数行の期待値と実際の値を、行を保ったまま expected と actual に入れる")
def test_multiline_expected_and_actual(tmp_path: Path) -> None:
    """`assert_equal` に改行を含む値を渡して失敗した `@test` のテストです。bats-assert が複数行で出す期待値と実際の値が、改行を保ったまま結果の `expected` と `actual` に入ることを確認します。"""
    test = _write_test(
        tmp_path / "suite",
        _case(
            "複数行",
            'explains "複数行の値を比べるテストです。"',
            "assert_equal \"$(printf 'a\\nb')\" \"$(printf 'a\\nc')\"",
        ),
    )
    _run(tmp_path, test, results=tmp_path / "results")
    [result] = _results(tmp_path / "results").values()

    with allure.step("expected と actual を比べる"):
        details = result["statusDetails"]
        assert (details["expected"], details["actual"]) == ("a\nc", "a\nb")


@allure.title("bats-assert を使わずに失敗した @test は、失敗したコマンドの行を理由にする")
def test_plain_failure_uses_failed_command(tmp_path: Path) -> None:
    """`[ 1 -eq 2 ]` のような、bats-assert の関数でないコマンドが失敗した `@test` のテストです。結果の理由に、bats が出す失敗したコマンドの行が入ることを確認します。"""
    test = _write_test(
        tmp_path / "suite",
        _case("コマンドの失敗", 'explains "コマンドの失敗のテストです。"', "[ 1 -eq 2 ]"),
    )
    _run(tmp_path, test, results=tmp_path / "results")
    [result] = _results(tmp_path / "results").values()

    with allure.step("状態と理由を比べる"):
        assert result["status"] == "failed"
        assert "[ 1 -eq 2 ]' failed" in result["statusDetails"]["message"]


@allure.title(
    "結果にはレーン・ファイルのパス・機能の階層・枠組みのラベルを付け、時刻はミリ秒で持つ"
)
def test_labels_and_times(tmp_path: Path) -> None:
    """bats のテストの結果に付くラベルと時刻のテストです。レーン・パス・機能の階層と `framework=bats` のラベルが付き、`fullName` にレーンとパスと題が入り、start と stop がミリ秒であることを確認します。"""
    test = _write_test(tmp_path / "plugins/p/tests", _case("通る", 'explains "通るテストです。"'))
    _run(tmp_path, test, results=tmp_path / "results")
    [result] = _results(tmp_path / "results").values()

    with allure.step("ラベル・fullName・時刻を比べる"):
        path = "plugins/p/tests/sample.bats"
        assert _label(result, "project") == ["pecot-visual"]
        assert _label(result, "lane") == ["test-compare"]
        assert _label(result, "parentSuite") == [path]
        assert _label(result, "epic") == ["pecot-visual"]
        assert _label(result, "feature") == ["plugins/p/tests"]
        assert _label(result, "story") == [path]
        assert _label(result, "language") == ["bash"]
        assert _label(result, "framework") == ["bats"]
        assert result["fullName"] == f"pecot-visual:test-compare {path}#通る"
        assert isinstance(result["start"], int) and isinstance(result["stop"], int)
        assert 1_000_000_000_000 < result["start"] <= result["stop"]


@allure.title("説明の無い passed の @test があると、ファイルと題を並べてレーンを止める")
def test_missing_description_fails_the_run(tmp_path: Path) -> None:
    """`explains` を呼ばない `@test` を持つファイルを、結果のディレクトリを指定して実行するテストです。passed の `@test` だけを説明の抜けとして表示し、bats が通っても終了コード 1 で終わることを確認します。"""
    test = _write_test(
        tmp_path / "suite",
        _case("説明が無い", "true"),
        _case("説明が無く失敗する", "false"),
    )
    done = _run(tmp_path, test, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("終了コードと、説明の抜けの一覧を比べる"):
        assert done.returncode == 1
        missing = done.stderr.split("MISSING:")[1].split("FAILED:")[0]
        assert " passed の @test が 1 件あります:\n  suite/sample.bats: 説明が無い\n" in missing
        assert "説明が無く失敗する" not in missing
        assert "description" not in results["説明が無い"]


@allure.title("setup_file で失敗したファイルは、broken の結果にする")
def test_setup_file_failure_is_broken(tmp_path: Path) -> None:
    """`setup_file` が失敗する bats のファイルのテストです。bats が出すファイルの単位の失敗が、状態 broken の結果として書かれ、終了コード 1 で終わることを確認します。"""
    test = _write_test(
        tmp_path / "suite",
        _case("届かない", 'explains "届かないテストです。"'),
        prelude="setup_file() {\n    false\n}\n\n",
    )
    done = _run(tmp_path, test, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("状態を比べる"):
        assert done.returncode == 1
        assert [r["status"] for r in results.values()] == ["broken"]
        assert "MISSING" not in done.stderr


@allure.title("bats がファイルを読み込めないと、題「読み込む」の broken の結果を書く")
def test_load_failure_is_broken(tmp_path: Path) -> None:
    """同じ題の `@test` が重なり、bats がファイルを読み込む段階で止まる場合のテストです。題「読み込む」の broken の結果が、終了コードを含む理由と stderr の末尾を添えて書かれることを確認します。"""
    test = _write_test(
        tmp_path / "suite",
        _case("同じ題", 'explains "1 つ目です。"'),
        _case("同じ題", 'explains "2 つ目です。"'),
    )
    done = _run(tmp_path, test, results=tmp_path / "results")
    results = _results(tmp_path / "results")

    with allure.step("題・状態・理由・trace を比べる"):
        assert done.returncode == 1
        assert list(results) == ["読み込む"]
        result = results["読み込む"]
        assert result["status"] == "broken"
        assert result["statusDetails"]["message"].startswith(
            "bats がテストを読み込めず、終了コード "
        )
        assert "同じ題" in result["statusDetails"]["trace"]
        assert _label(result, "parentSuite") == ["suite/sample.bats"]


@allure.title("時間の上限で打ち切られた @test は、秒数を理由にした broken の結果にする")
def test_timeout_is_broken(tmp_path: Path) -> None:
    """`BATS_TEST_TIMEOUT` を超えて打ち切られた `@test` のテストです。結果の状態が broken になり、理由に上限の秒数が入ることを確認します。"""
    test = _write_test(tmp_path / "suite", _case("長い", 'explains "長いテストです。"', "sleep 5"))
    _run(tmp_path, test, results=tmp_path / "results", env={"BATS_TEST_TIMEOUT": "1"})
    [result] = _results(tmp_path / "results").values()

    with allure.step("状態と理由を比べる"):
        assert result["status"] == "broken"
        assert result["statusDetails"]["message"] == "1 秒で打ち切られた"


@allure.title("結果のディレクトリを渡さないと、結果を書かず、説明の抜けでも止めない")
def test_outside_lane_writes_nothing(tmp_path: Path) -> None:
    """`PECOT_REPORT_RESULTS` を渡さずに `run.sh` を実行した場合のテストです。`explains` の無い `@test` があっても終了コード 0 で終わり、結果のファイルを書かないことを確認します。"""
    test = _write_test(
        tmp_path / "suite",
        _case("説明つき", 'explains "説明つきのテストです。"'),
        _case("説明なし", "true"),
    )
    done = _run(tmp_path, test, results=None)

    with allure.step("終了コードと、結果が無いことを比べる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert "ok 1 説明つき" in done.stdout
        assert not (tmp_path / "results").exists()


@allure.title("同じファイルの @test を、並べて同時に動かす")
def test_runs_tests_in_parallel(tmp_path: Path) -> None:
    """互いに相手の目印のファイルを待つ 2 つの `@test` を、`run.sh` で実行するテストです。2 つが同時に動くことで両方とも passed になり、終了コード 0 で終わることを確認します。"""
    waits = [
        ('touch "$BATS_FILE_TMPDIR/' + mine + '"', *_wait_for(other))
        for mine, other in (("a", "b"), ("b", "a"))
    ]
    test = _write_test(
        tmp_path / "suite",
        _case("目印 a", 'explains "a を置いて b を待つテストです。"', *waits[0]),
        _case("目印 b", 'explains "b を置いて a を待つテストです。"', *waits[1]),
    )
    done = _run(tmp_path, test, results=tmp_path / "results")

    with allure.step("終了コードと状態を比べる"):
        assert done.returncode == 0, done.stdout + done.stderr
        statuses = {name: r["status"] for name, r in _results(tmp_path / "results").items()}
        assert statuses == {"目印 a": "passed", "目印 b": "passed"}


def _wait_for(name: str) -> tuple[str, ...]:
    """相手の目印のファイルを、5 秒まで待つコマンド。"""
    path = '"$BATS_FILE_TMPDIR/' + name + '"'
    return (
        "for _ in $(seq 50); do",
        "    [ -e " + path + " ] && break",
        "    sleep 0.1",
        "done",
        "[ -e " + path + " ]",
    )


@allure.title("テストと被テストのスクリプトには、結果のディレクトリを渡さない")
def test_results_dir_is_not_passed_to_tests(tmp_path: Path) -> None:
    """結果のディレクトリを指定して `run.sh` を実行し、`@test` の中で環境変数を読むテストです。`@test` の中では `PECOT_REPORT_RESULTS` が空で、被テストのスクリプトに渡らないことを確認します。"""
    test = _write_test(
        tmp_path / "suite",
        _case(
            "渡らない",
            'explains "環境変数を読むテストです。"',
            '[ -z "${PECOT_REPORT_RESULTS:-}" ]',
        ),
    )
    done = _run(tmp_path, test, results=tmp_path / "results")

    with allure.step("終了コードと状態を比べる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert _results(tmp_path / "results")["渡らない"]["status"] == "passed"


@allure.title("explains に {param_id} の値を渡すと、その @test を失敗にする")
@pytest.mark.parametrize(
    "argument",
    [
        pytest.param('""', id="空"),
        pytest.param("\"$(printf 'a\\nb')\"", id="改行を含む"),
        pytest.param('"a" "b"', id="2 つ"),
    ],
)
def test_explains_rejects_bad_value(tmp_path: Path, argument: str) -> None:
    """`explains` に空の値・改行を含む値・2 つの値を渡した `@test` のテストです。`explains` が理由を出して失敗し、その `@test` が failed になることを確認します。"""
    test = _write_test(tmp_path / "suite", _case("不正な説明", f"explains {argument}"))
    _run(tmp_path, test, results=tmp_path / "results")
    [result] = _results(tmp_path / "results").values()

    with allure.step("状態と trace を比べる"):
        assert result["status"] == "failed"
        assert "空でなく改行の無い説明を 1 つ渡してください" in result["statusDetails"]["trace"]


@allure.title("実際の Allure で結果を読み込むと、説明・状態・期待値と実際の値がレポートに含まれる")
@pytest.mark.skipif(shutil.which("pnpm") is None, reason="pnpm が要る")
def test_real_allure_reads_the_results(tmp_path: Path) -> None:
    """bats のテストの結果を、実際の Allure 3 で `allure generate` して読み込んだ場合のテストです。通る `@test` と失敗する `@test` の状態・説明・期待値と実際の値、`framework` のラベルがレポートに含まれることを確認します。"""
    test = _write_test(
        tmp_path / "suite",
        _case("通る", 'explains "通るテストです。"'),
        _case("等しくない", 'explains "失敗するテストです。"', 'assert_equal "a" "b"'),
    )
    _run(tmp_path, test, results=tmp_path / "results")
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

    with allure.step("状態・説明・期待と実際・ラベルを比べる"):
        assert sorted(by_name) == ["等しくない", "通る"]
        assert by_name["通る"]["status"] == "passed"
        assert by_name["通る"]["descriptionHtml"].strip() == "<p>通るテストです。</p>"
        error = by_name["等しくない"]["error"]
        assert (error["message"], error["expected"], error["actual"]) == (
            "values do not equal",
            "b",
            "a",
        )
        labels = {label["name"]: label["value"] for label in by_name["通る"]["labels"]}
        assert (labels["framework"], labels["parentSuite"]) == ("bats", "suite/sample.bats")
