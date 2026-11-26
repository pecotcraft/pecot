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

import pytest

_REPO = Path(__file__).resolve().parents[2]
_RUN_SH = _REPO / ".githooks/tests/run.sh"
_CONFTESTS = [
    ".githooks/tests/conftest.py",
    "libs/interface-spec/docs/tests/conftest.py",
]


def _run_pytest(
    tmp_path: Path, conftest: str, test_body: str, *args: str
) -> subprocess.CompletedProcess[str]:
    suite = tmp_path / "suite"
    suite.mkdir()
    shutil.copy(_REPO / conftest, suite / "conftest.py")
    (suite / "test_sample.py").write_text(test_body, encoding="utf-8")
    return subprocess.run(
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
        json.loads(path.read_text(encoding="utf-8"))["labels"]
        for path in sorted(results.glob("*-result.json"))
    ]


@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_ini_labels_are_added_to_every_result(tmp_path: Path, conftest: str) -> None:
    """-o でラベルを渡すと、どの結果にも project と lane のラベルが 1 つずつ付く。"""
    results = tmp_path / "allure-results"
    body = "def test_a() -> None:\n    pass\n\n\ndef test_b() -> None:\n    pass\n"
    done = _run_pytest(
        tmp_path, conftest, body,
        "--alluredir", str(results), "-o", "pecot_report_project=githooks", "-o", "pecot_report_lane=test-ci",
    )  # fmt: skip
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


@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_without_ini_labels_no_project_or_lane_label(tmp_path: Path, conftest: str) -> None:
    """-o を渡さないと、結果に project と lane のラベルを付けない。"""
    results = tmp_path / "allure-results"
    done = _run_pytest(
        tmp_path, conftest, "def test_a() -> None:\n    pass\n", "--alluredir", str(results)
    )
    assert done.returncode == 0, done.stdout + done.stderr
    labels = _labels(results)
    assert len(labels) == 1
    assert [label for label in labels[0] if label["name"] in {"project", "lane"}] == []


@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_without_ini_labels_allure_is_not_imported(tmp_path: Path, conftest: str) -> None:
    """-o を渡さないと、allure-pytest を外しても conftest は allure を読まずに通る。"""
    body = "import sys\n\n\ndef test_a() -> None:\n    assert 'allure' not in sys.modules\n"
    done = _run_pytest(tmp_path, conftest, body, "-p", "no:allure_pytest")
    assert done.returncode == 0, done.stdout + done.stderr


@pytest.fixture
def run_sh_copy(tmp_path: Path, mock_bin: Any) -> Path:
    """run.sh を tmp の .githooks/tests/ に写し、uvx を引数を 1 行ずつ書くスタブに替える。"""
    tests_dir = tmp_path / ".githooks/tests"
    tests_dir.mkdir(parents=True)
    shutil.copy(_RUN_SH, tests_dir / "run.sh")
    mock_bin.install("uvx", f'printf "%s\\n" "$@" > "{tmp_path}/uvx-args"\n')
    return tests_dir / "run.sh"


def test_run_sh_in_nx_lane_passes_alluredir_and_labels(
    tmp_path: Path, run_sh_copy: Path, run_script: Callable[..., subprocess.CompletedProcess[str]]
) -> None:
    """nx のレーンから動くと、前の結果を消し、--alluredir と project・lane の -o を pytest に渡す。"""
    results = tmp_path / ".githooks/test-results/test-ci/allure-results"
    results.mkdir(parents=True)
    (results / "stale-result.json").write_text("{}", encoding="utf-8")
    done = run_script(
        run_sh_copy, env={"NX_TASK_TARGET_PROJECT": "githooks", "NX_TASK_TARGET_TARGET": "test-ci"}
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert not results.exists()
    args = (tmp_path / "uvx-args").read_text(encoding="utf-8").splitlines()
    start = args.index("--alluredir")
    assert args[start : start + 6] == [
        "--alluredir",
        str(results),
        "-o",
        "pecot_report_project=githooks",
        "-o",
        "pecot_report_lane=test-ci",
    ]


def test_run_sh_outside_nx_passes_no_alluredir(
    tmp_path: Path, run_sh_copy: Path, run_script: Callable[..., subprocess.CompletedProcess[str]]
) -> None:
    """nx の外で動くと、pytest に --alluredir と -o を渡さない。"""
    done = run_script(
        run_sh_copy
    )  # NX_TASK_TARGET_* は conftest の autouse の fixture が外している
    assert done.returncode == 0, done.stdout + done.stderr
    args = (tmp_path / "uvx-args").read_text(encoding="utf-8").splitlines()
    assert "--alluredir" not in args
    assert "-o" not in args
