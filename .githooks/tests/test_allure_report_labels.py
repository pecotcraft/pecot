"""pytest のレーンが Allure の結果を残す仕組みのテスト。

run.sh が nx のレーンのときだけ --alluredir と -o を渡すことと、conftest が -o の値をラベルにすることを見る。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
_RUN_SH = _REPO / ".githooks/tests/run.sh"
_CONFTESTS = [
    ".githooks/tests/conftest.py",
    "libs/interface-spec/docs/tests/conftest.py",
]


def _run_pytest(
    tmp_path: Path, conftest: str, test_body: str, *args: str, test_file: str = "test_sample.py"
) -> subprocess.CompletedProcess[str]:
    suite = tmp_path / "suite"
    suite.mkdir()
    shutil.copy(_REPO / conftest, suite / "conftest.py")
    (suite / test_file).parent.mkdir(parents=True, exist_ok=True)
    (suite / test_file).write_text(test_body, encoding="utf-8")
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
        check=False,
    )


def _labels(results: Path) -> list[list[dict[str, Any]]]:
    return [
        json.loads(read_output(path))["labels"] for path in sorted(results.glob("*-result.json"))
    ]


def _hierarchy(result: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # allure-pytest は印のラベルを集合にまとめるので、並びが実行ごとに変わる。
    found = [label for label in result if label["name"] in {"epic", "feature", "story"}]
    return sorted(found, key=lambda label: label["name"])


@allure.title(
    "-o でラベルを指定すると、{param_id} の conftest はすべての結果に project と lane のラベルを 1 つずつ付ける"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_ini_labels_are_added_to_every_result(tmp_path: Path, conftest: str) -> None:
    """pytest を `--alluredir` と `-o` を指定して実行したときに、Allure の結果ファイルに付くラベルのテストです。2 件のテストのどちらの結果にも、指定した project と lane のラベルが 1 つずつだけ付いていることを確認します。"""
    with allure.step("2 つのテストを -o のラベル付きで pytest に動かす"):
        results = tmp_path / "allure-results"
        body = "def test_a() -> None:\n    pass\n\n\ndef test_b() -> None:\n    pass\n"
        done = _run_pytest(
            tmp_path, conftest, body,
            "--alluredir", str(results), "-o", "pecot_report_project=githooks", "-o", "pecot_report_lane=test-ci",
        )  # fmt: skip
    with allure.step("結果ごとに project と lane のラベルが 1 つずつ付くことを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        labels = _labels(results)
        assert len(labels) == 2
        for result in labels:
            assert [label for label in result if label["name"] == "project"] == [
                {"name": "project", "value": "githooks"}
            ]
            assert [label for label in result if label["name"] == "lane"] == [
                {"name": "lane", "value": "test-ci"}
            ]


@allure.title(
    "nx.json が上に無いと、{param_id} の conftest は rootpath からのパスで epic・feature・story を 1 つずつ付ける"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_hierarchy_labels_without_nx_json_use_rootpath(tmp_path: Path, conftest: str) -> None:
    """`nx.json` の無いディレクトリで pytest を実行したときの、機能の階層のラベルのテストです。どの結果にも、project の epic と、rootpath からのパスの feature・story が 1 つずつ付くことを確認します。"""
    with allure.step("nx.json の無い一時ディレクトリで、2 つのテストを -o のラベル付きで動かす"):
        results = tmp_path / "allure-results"
        body = "def test_a() -> None:\n    pass\n\n\ndef test_b() -> None:\n    pass\n"
        done = _run_pytest(
            tmp_path, conftest, body,
            "--alluredir", str(results), "-o", "pecot_report_project=githooks", "-o", "pecot_report_lane=test-ci",
        )  # fmt: skip
    with allure.step(
        "結果ごとに epic・feature・story が 1 つずつ付き、feature が . になることを確かめる"
    ):
        assert done.returncode == 0, done.stdout + done.stderr
        labels = _labels(results)
        assert len(labels) == 2
        for result in labels:
            assert _hierarchy(result) == [
                {"name": "epic", "value": "githooks"},
                {"name": "feature", "value": "."},
                {"name": "story", "value": "test_sample.py"},
            ]


@allure.title(
    "上に nx.json があると、{param_id} の conftest は nx.json のディレクトリからのパスを feature と story にする"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_hierarchy_labels_use_the_directory_of_nx_json(tmp_path: Path, conftest: str) -> None:
    """`nx.json` の下の入れ子のディレクトリのテストを実行したときの、機能の階層のラベルのテストです。feature がテストのディレクトリ、story がテストのファイルの、`nx.json` からのパスになることを確認します。"""
    with allure.step("nx.json の下の入れ子のディレクトリのテストを、-o のラベル付きで動かす"):
        (tmp_path / "nx.json").write_text("{}", encoding="utf-8")
        results = tmp_path / "allure-results"
        done = _run_pytest(
            tmp_path, conftest, "def test_a() -> None:\n    pass\n",
            "--alluredir", str(results), "-o", "pecot_report_project=githooks",
            test_file="sub/test_nested.py",
        )  # fmt: skip
    with allure.step("feature が入れ子のディレクトリ、story がファイルのパスになることを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        [result] = _labels(results)
        assert _hierarchy(result) == [
            {"name": "epic", "value": "githooks"},
            {"name": "feature", "value": "suite/sub"},
            {"name": "story", "value": "suite/sub/test_nested.py"},
        ]


@allure.title(
    "project の値が空だと、{param_id} の conftest は epic を付けず、feature と story を付ける"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_without_project_no_epic(tmp_path: Path, conftest: str) -> None:
    """`-o` で lane だけを指定して pytest を実行したときの、機能の階層のラベルのテストです。結果に epic が付かず、feature と story が付くことを確認します。"""
    with allure.step("lane だけを -o で渡して pytest を動かす"):
        results = tmp_path / "allure-results"
        done = _run_pytest(
            tmp_path, conftest, "def test_a() -> None:\n    pass\n",
            "--alluredir", str(results), "-o", "pecot_report_lane=test-ci",
        )  # fmt: skip
    with allure.step("epic が無く、feature と story があることを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        [result] = _labels(results)
        assert _hierarchy(result) == [
            {"name": "feature", "value": "."},
            {"name": "story", "value": "test_sample.py"},
        ]


@allure.title(
    "-o を指定しないと、{param_id} の conftest は結果に project・lane・epic・feature・story のラベルを付けない"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_without_ini_labels_no_project_or_lane_label(tmp_path: Path, conftest: str) -> None:
    """`-o` を指定せずに pytest を実行したときに、Allure の結果ファイルに付くラベルのテストです。結果に `project`・`lane` と機能の階層のラベルが 1 つも付いていないことを確認します。"""
    with allure.step("-o を渡さずに pytest を動かす"):
        results = tmp_path / "allure-results"
        done = _run_pytest(
            tmp_path, conftest, "def test_a() -> None:\n    pass\n", "--alluredir", str(results)
        )
    with allure.step("project・lane・epic・feature・story のラベルが付かないことを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        labels = _labels(results)
        assert len(labels) == 1
        assert [label for label in labels[0] if label["name"] in {"project", "lane"}] == []
        assert _hierarchy(labels[0]) == []


@allure.title(
    "-o を指定しないと、allure-pytest を無効にしても docs の conftest は allure を読み込まずに成功する"
)
def test_without_ini_labels_docs_conftest_does_not_import_allure(tmp_path: Path) -> None:
    """`-o` を指定せず、`-p no:allure_pytest` で allure-pytest を無効にして実行したときの、docs の conftest のテストです。テストが成功し、`allure` モジュールが読み込まれていないことを確認します。"""
    with allure.step("allure-pytest を外して docs の conftest で pytest を動かす"):
        body = "import sys\n\n\ndef test_a() -> None:\n    assert 'allure' not in sys.modules\n"
        done = _run_pytest(tmp_path, _CONFTESTS[1], body, "-p", "no:allure_pytest")
    with allure.step("終了コード 0 で allure を読み込まないことを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr


@pytest.fixture
def run_sh_copy(tmp_path: Path, mock_bin: Any) -> Path:
    """run.sh を tmp の .githooks/tests/ に写し、uvx と step-gate.sh を引数を 1 行ずつ書くスタブに替える。"""
    tests_dir = tmp_path / ".githooks/tests"
    tests_dir.mkdir(parents=True)
    shutil.copy(_RUN_SH, tests_dir / "run.sh")
    mock_bin.install("uvx", f'printf "%s\\n" "$@" > "{tmp_path}/uvx-args"\n')
    gate = tmp_path / ".githooks/scripts/test_report/step-gate.sh"
    gate.parent.mkdir(parents=True)
    gate.write_text(f'#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "{tmp_path}/gate-args"\n')
    return tests_dir / "run.sh"


@allure.title(
    "nx のレーンから run.sh を実行すると、前回の結果を削除し、--alluredir と project・lane の -o を pytest に渡す"
)
def test_run_sh_in_nx_lane_passes_alluredir_and_labels(
    tmp_path: Path, run_sh_copy: Path, run_script: Callable[..., subprocess.CompletedProcess[str]]
) -> None:
    """nx のレーン（`NX_TASK_TARGET_TARGET` を指定した場合）で `run.sh` を実行したときのテストです。前回の結果のディレクトリを削除し、`pytest` に `--alluredir` と project・lane の `-o` を渡し、結果を step の gate に渡すことを確認します。"""
    results = tmp_path / ".githooks/test-results/test-ci/allure-results"
    results.mkdir(parents=True)
    (results / "stale-result.json").write_text("{}", encoding="utf-8")
    done = run_script(
        run_sh_copy, env={"NX_TASK_TARGET_PROJECT": "githooks", "NX_TASK_TARGET_TARGET": "test-ci"}
    )
    with allure.step("nx のレーンで動かして pytest と gate の引数を確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert not results.exists()
        args = read_output(tmp_path / "uvx-args").splitlines()
        start = args.index("--alluredir")
        assert args[start : start + 6] == [
            "--alluredir",
            str(results),
            "-o",
            "pecot_report_project=githooks",
            "-o",
            "pecot_report_lane=test-ci",
        ]
        gate_args = read_output(tmp_path / "gate-args").splitlines()
        assert gate_args == [str(results)]


@allure.title("nx の外で run.sh を実行すると、pytest に --alluredir と -o を渡さない")
def test_run_sh_outside_nx_passes_no_alluredir(
    tmp_path: Path, run_sh_copy: Path, run_script: Callable[..., subprocess.CompletedProcess[str]]
) -> None:
    """nx の外（`NX_TASK_TARGET_*` を指定しない場合）で `run.sh` を実行したときのテストです。`pytest` へ `--alluredir` と `-o` を渡さず、step の gate も実行しないことを確認します。"""
    done = run_script(
        run_sh_copy
    )  # NX_TASK_TARGET_* は conftest の autouse の fixture が外している
    with allure.step("nx の外で動かして pytest に渡る引数と gate を確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        args = read_output(tmp_path / "uvx-args").splitlines()
        assert "--alluredir" not in args
        assert "-o" not in args
        assert not (tmp_path / "gate-args").exists()
