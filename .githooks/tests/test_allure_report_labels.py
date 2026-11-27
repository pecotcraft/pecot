"""pytest のレーンが Allure の結果を残す仕組みのテスト。

run.sh が nx のレーンのときだけ --alluredir と -o を渡すことと、conftest が -o の値をラベルにすることを見る。
conftest が --alluredir に動かした環境（Python の版のパラメータと、OS の environment.properties）を残すことも見る。
"""

from __future__ import annotations

import json
import platform
import re
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


def _layers(result: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [label for label in result if label["name"] == "layer"]


_LAYER_TABLE = "# 層の表\nunit suite/\nintegration suite/sub/test_nested.py\n"


@allure.title(
    "{param_id} の conftest は、project の test-layers.txt で {test_file} に当たる規則のうち、パスの長いものの層を付ける"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
@pytest.mark.parametrize(
    ("test_file", "expected"),
    [("test_sample.py", "unit"), ("sub/test_nested.py", "integration")],
)
def test_layer_label_from_project_table(
    tmp_path: Path, conftest: str, test_file: str, expected: str
) -> None:
    """`project.json` と `test-layers.txt` を持つディレクトリで pytest を実行したときの、層のラベルのテストです。ディレクトリとファイルの規則のうち、パスの長い規則の層が `layer` として 1 つだけ付くことを確認します。"""
    with allure.step("project.json と層の表を置き、-o のラベル付きで pytest を動かす"):
        (tmp_path / "project.json").write_text("{}", encoding="utf-8")
        (tmp_path / "test-layers.txt").write_text(_LAYER_TABLE, encoding="utf-8")
        results = tmp_path / "allure-results"
        done = _run_pytest(
            tmp_path, conftest, "def test_a() -> None:\n    pass\n",
            "--alluredir", str(results), "-o", "pecot_report_project=githooks",
            test_file=test_file,
        )  # fmt: skip
    with allure.step("layer のラベルを比べる"):
        assert done.returncode == 0, done.stdout + done.stderr
        [result] = _labels(results)
        assert _layers(result) == [{"name": "layer", "value": expected}]


@allure.title("{param_id} の conftest は、{case}ときに layer のラベルを足さない")
@pytest.mark.parametrize("conftest", _CONFTESTS)
@pytest.mark.parametrize(
    ("case", "table", "body", "expected"),
    [
        ("層の表が無い", None, "def test_a() -> None:\n    pass\n", []),
        (
            "どの規則にも当たらない",
            "unit other/\n",
            "def test_a() -> None:\n    pass\n",
            [],
        ),
        (
            "テストが自分で layer を付けた",
            _LAYER_TABLE,
            'import allure\n\n\n@allure.label("layer", "e2e")\ndef test_a() -> None:\n    pass\n',
            [{"name": "layer", "value": "e2e"}],
        ),
    ],
    ids=["no-table", "no-match", "own-layer"],
)
def test_layer_label_is_not_added(
    tmp_path: Path, conftest: str, case: str, table: str | None, body: str, expected: list[Any]
) -> None:
    """層の表から `layer` を付けない場合の、conftest のテストです。表が無い・規則に当たらない・テストが自分で層を付けた場合に、表の層を追加しないことを確認します。"""
    with allure.step(f"{case}状態で、-o のラベル付きで pytest を動かす"):
        (tmp_path / "project.json").write_text("{}", encoding="utf-8")
        if table is not None:
            (tmp_path / "test-layers.txt").write_text(table, encoding="utf-8")
        results = tmp_path / "allure-results"
        done = _run_pytest(
            tmp_path,
            conftest,
            body,
            "--alluredir",
            str(results),
            "-o",
            "pecot_report_project=githooks",
        )
    with allure.step("layer のラベルを比べる"):
        assert done.returncode == 0, done.stdout + done.stderr
        [result] = _labels(results)
        assert _layers(result) == expected


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


def _severity(results: Path) -> dict[str, list[str]]:
    """テストの名前ごとの、severity のラベルの値。"""
    found: dict[str, list[str]] = {}
    for path in sorted(results.glob("*-result.json")):
        result = json.loads(read_output(path))
        found[result["name"]] = [
            label["value"] for label in result["labels"] if label["name"] == "severity"
        ]
    return found


@allure.title(
    "-o で project を指定すると、{param_id} の conftest はすべての結果に minor の severity を 1 つ付ける"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_severity_minor_is_added_to_every_result(tmp_path: Path, conftest: str) -> None:
    """`-o` で project を指定して pytest を実行したときの、重大度のラベルのテストです。severity を書いていない 2 件のテストの結果に、`minor` の severity が 1 つずつ付くことを確認します。"""
    with allure.step("2 つのテストを -o のラベル付きで pytest に動かす"):
        results = tmp_path / "allure-results"
        body = "def test_a() -> None:\n    pass\n\n\ndef test_b() -> None:\n    pass\n"
        done = _run_pytest(
            tmp_path, conftest, body,
            "--alluredir", str(results), "-o", "pecot_report_project=githooks", "-o", "pecot_report_lane=test-ci",
        )  # fmt: skip
    with allure.step("結果ごとに minor の severity が 1 つ付くことを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert _severity(results) == {"test_a": ["minor"], "test_b": ["minor"]}


@allure.title(
    "関数とクラスに @allure.severity を付けたテストは、{param_id} の conftest が付ける minor でなく、書いた段階を持つ"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_severity_written_in_test_is_kept(tmp_path: Path, conftest: str) -> None:
    """テストに `@allure.severity` の印を書いて pytest を実行したときの、重大度のラベルのテストです。関数に付けた `trivial` とクラスに付けた `critical` がそのまま残り、印の無いテストだけが `minor` になることを確認します。"""
    with allure.step("関数とクラスに severity の印を付けたテストを、-o のラベル付きで動かす"):
        results = tmp_path / "allure-results"
        body = (
            "import allure\n\n\n"
            "@allure.severity(allure.severity_level.TRIVIAL)\n"
            "def test_function() -> None:\n    pass\n\n\n"
            "@allure.severity(allure.severity_level.CRITICAL)\n"
            "class TestClass:\n    def test_method(self) -> None:\n        pass\n\n\n"
            "def test_plain() -> None:\n    pass\n"
        )
        done = _run_pytest(
            tmp_path, conftest, body,
            "--alluredir", str(results), "-o", "pecot_report_project=githooks", "-o", "pecot_report_lane=test-ci",
        )  # fmt: skip
    with allure.step("書いた段階が残り、印の無いテストだけが minor になることを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert _severity(results) == {
            "test_function": ["trivial"],
            "test_method": ["critical"],
            "test_plain": ["minor"],
        }


@allure.title("-o を指定しないと、{param_id} の conftest は結果に severity のラベルを付けない")
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_without_ini_labels_no_severity(tmp_path: Path, conftest: str) -> None:
    """`-o` を指定せずに pytest を実行したときの、重大度のラベルのテストです。結果に severity のラベルが 1 つも付いていないことを確認します。"""
    with allure.step("-o を渡さずに pytest を動かす"):
        results = tmp_path / "allure-results"
        done = _run_pytest(
            tmp_path, conftest, "def test_a() -> None:\n    pass\n", "--alluredir", str(results)
        )
    with allure.step("severity のラベルが付かないことを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert _severity(results) == {"test_a": []}


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


# allure-js-commons を依存に持つ project。node の import をここから解く。
_JS_COMMONS = _REPO / "libs/interface-spec"

_TWO_TESTS = (
    "import pytest\n\n\n"
    "def test_a() -> None:\n    pass\n\n\n"
    '@pytest.mark.parametrize("n", [1, 2])\n'
    "def test_b(n: int) -> None:\n    pass\n"
)

# 同じ名前の fixture で conftest の autouse の fixture を上書きし、パラメータを付けない実行を作る。
_WITHOUT_PYTHON_PARAMETER = (
    "\n\n@pytest.fixture\ndef allure_python_parameter() -> None:\n    pass\n"
)


def _results(results: Path) -> list[dict[str, Any]]:
    return [json.loads(read_output(path)) for path in sorted(results.glob("*-result.json"))]


def _python_parameters(result: dict[str, Any]) -> list[dict[str, Any]]:
    # パラメータの無い結果は parameters の欄を持たない。
    return [
        {key: parameter.get(key) for key in ("name", "value", "excluded")}
        for parameter in result.get("parameters", [])
        if parameter["name"] == "Python"
    ]


def _expected_python_parameter() -> list[dict[str, Any]]:
    # allure-pytest は文字列の値を引用符で囲んで書く。
    return [{"name": "Python", "value": f"'{platform.python_version()}'", "excluded": True}]


def _fallback_os() -> str:
    return f"{platform.system()} {platform.release()}"


def _stringify_env_info(info: dict[str, str]) -> str:
    """allure-js-commons の stringifyEnvInfo が書く environment.properties の中身を返す。"""
    script = (
        "const { stringifyEnvInfo } = await import('allure-js-commons/sdk/reporter');"
        "process.stdout.write(stringifyEnvInfo(JSON.parse(process.argv[1])));"
    )
    done = run_attached(
        ["node", "--input-type=module", "-e", script, json.dumps(info)],
        cwd=_JS_COMMONS,
        capture_output=True,
        text=True,
        check=True,
    )
    return done.stdout


@allure.title(
    "--alluredir を指定すると、{param_id} の conftest はどの結果にも Python の版を excluded のパラメータで 1 つ付け、historyId を変えない"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_alluredir_adds_excluded_python_parameter(tmp_path: Path, conftest: str) -> None:
    """`--alluredir` を指定して pytest を実行したときの、`Python` のパラメータのテストです。どの結果にも `excluded` の `Python` のパラメータが 1 つ付き、付けない実行と `historyId` が同じであることを確認します。"""
    with allure.step("parametrize を含む 3 件のテストを --alluredir 付きで動かす"):
        (tmp_path / "with").mkdir()
        with_results = tmp_path / "with/allure-results"
        done = _run_pytest(
            tmp_path / "with", conftest, _TWO_TESTS, "--alluredir", str(with_results)
        )
        assert done.returncode == 0, done.stdout + done.stderr
    with allure.step("パラメータの fixture を上書きした同じテストを --alluredir 付きで動かす"):
        (tmp_path / "without").mkdir()
        without_results = tmp_path / "without/allure-results"
        done = _run_pytest(
            tmp_path / "without", conftest, _TWO_TESTS + _WITHOUT_PYTHON_PARAMETER,
            "--alluredir", str(without_results),
        )  # fmt: skip
        assert done.returncode == 0, done.stdout + done.stderr
    with allure.step(
        "Python のパラメータが 1 つずつ付き、historyId が上書きした実行と同じことを確かめる"
    ):
        with_python = _results(with_results)
        without_python = _results(without_results)
        assert len(with_python) == 3
        for result in with_python:
            assert _python_parameters(result) == _expected_python_parameter()
        assert [_python_parameters(result) for result in without_python] == [[], [], []]
        assert {result["name"]: result["historyId"] for result in with_python} == {
            result["name"]: result["historyId"] for result in without_python
        }


_DEBIAN = 'NAME="Debian"\n'
_FEDORA = "PRETTY_NAME='Fedora Linux 41'\n"

# 行は (題の場面, /etc/os-release の中身, /usr/lib/os-release の中身, OS の値)。None はファイルが無いこと。
_OS_RELEASE_CASES = [
    pytest.param(
        "/etc/os-release の PRETTY_NAME に空白・記号・ASCII の外の文字があると",
        _DEBIAN + 'PRETTY_NAME=" Debian\\\\GNU=Linux: 13\t(trixie) éĀ😀\u0085\x7f \\"x\\""\n',
        _FEDORA,
        ' Debian\\GNU=Linux: 13\t(trixie) éĀ😀\u0085\x7f "x"',
        id="pretty-name",
    ),
    pytest.param(
        "/etc/os-release が無いと",
        None,
        _FEDORA,
        "Fedora Linux 41",
        id="usr-lib",
    ),
    pytest.param(
        "/etc/os-release に PRETTY_NAME の行が無いと",
        _DEBIAN,
        _FEDORA,
        _fallback_os(),
        id="no-pretty-name",
    ),
    pytest.param(
        "os-release がどちらも無いと",
        None,
        None,
        _fallback_os(),
        id="no-os-release",
    ),
]


@allure.title(
    "{case}、{conftest} の conftest は OS だけの environment.properties を allure-js-commons と同じ形で書く"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
@pytest.mark.parametrize(("case", "etc", "usr_lib", "expected"), _OS_RELEASE_CASES)
def test_alluredir_writes_os_environment_properties(
    tmp_path: Path, conftest: str, case: str, etc: str | None, usr_lib: str | None, expected: str
) -> None:
    """os-release の置き場所を差し替え、`--alluredir` を指定して pytest を実行したときの、`environment.properties` のテストです。`PRETTY_NAME` か代わりの値を `OS` の 1 行だけで、allure-js-commons の `stringifyEnvInfo` と同じ形に書くことを確認します。"""
    with allure.step(f"os-release の置き場所を差し替えて pytest を動かす（{case}）"):
        paths: list[str] = []
        for name, text in (("etc-os-release", etc), ("usr-lib-os-release", usr_lib)):
            path = tmp_path / name
            if text is not None:
                path.write_text(text, encoding="utf-8")
            paths.append(str(path))
        results = tmp_path / "allure-results"
        body = (
            "import conftest\n\n"
            f"conftest._OS_RELEASE_PATHS = ({paths[0]!r}, {paths[1]!r})\n\n\n"
            "def test_a() -> None:\n    pass\n"
        )
        done = _run_pytest(tmp_path, conftest, body, "--alluredir", str(results))
    with allure.step(
        "environment.properties が stringifyEnvInfo の OS の 1 行と同じことを確かめる"
    ):
        assert done.returncode == 0, done.stdout + done.stderr
        expected_text = _stringify_env_info({"OS": expected})
        assert read_output(results / "environment.properties") == expected_text


@allure.title(
    "environment.properties が既にあると、{param_id} の conftest はファイルを書き換えない"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_alluredir_keeps_existing_environment_properties(tmp_path: Path, conftest: str) -> None:
    """結果のディレクトリに `environment.properties` が存在する状態で、`--alluredir` を指定して pytest を実行したときのテストです。既存のファイルの中身が変わらないことを確認します。"""
    with allure.step("vitest の書いた environment.properties を置いて pytest を動かす"):
        results = tmp_path / "allure-results"
        results.mkdir()
        existing = "OS=vitest\nNode.js=v24.0.0"
        (results / "environment.properties").write_text(existing, encoding="utf-8")
        done = _run_pytest(
            tmp_path, conftest, "def test_a() -> None:\n    pass\n", "--alluredir", str(results)
        )
    with allure.step("environment.properties が置いたときのままであることを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert read_output(results / "environment.properties") == existing


@allure.title(
    "--alluredir を指定しないと、{param_id} の conftest は Python のパラメータを付けず、environment.properties を書かない"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_without_alluredir_no_parameter_or_environment(tmp_path: Path, conftest: str) -> None:
    """`--alluredir` を指定せずに pytest を実行したときのテストです。Allure のパラメータを付ける呼び出しが 1 回も無く、`environment.properties` がどこにも作成されないことを確認します。"""
    with allure.step("パラメータの呼び出しを記録するテストを --alluredir 無しで動かす"):
        body = (
            "import allure_commons\n\n"
            "calls: list[str] = []\n\n\n"
            "class _Spy:\n"
            "    @allure_commons.hookimpl\n"
            "    def add_parameter(self, name, value, excluded, mode) -> None:\n"
            "        calls.append(name)\n\n\n"
            "allure_commons.plugin_manager.register(_Spy())\n\n\n"
            "def test_a() -> None:\n    pass\n\n\n"
            "def test_b() -> None:\n    assert calls == []\n"
        )
        done = _run_pytest(tmp_path, conftest, body)
    with allure.step("パラメータの呼び出しが無く、environment.properties が無いことを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr
        assert list(tmp_path.rglob("environment.properties")) == []


@allure.title(
    "xdist の worker 2 つで動かしても、{param_id} の conftest は environment.properties を 1 つ正しく書く"
)
@pytest.mark.parametrize("conftest", _CONFTESTS)
def test_xdist_writes_environment_properties_once(tmp_path: Path, conftest: str) -> None:
    """`-n 2` で xdist の worker に分けて pytest を実行したときのテストです。xdist を使わない実行と同じ `OS` の 1 行の `environment.properties` が 1 つだけ作成されることを確認します。worker の結果に `Python` のパラメータが付くことも確認します。"""
    body = "".join(f"def test_{name}() -> None:\n    pass\n\n\n" for name in "abcd")
    with allure.step("4 件のテストを xdist を使わずに --alluredir 付きで動かす"):
        (tmp_path / "serial").mkdir()
        serial = tmp_path / "serial/allure-results"
        done = _run_pytest(tmp_path / "serial", conftest, body, "--alluredir", str(serial))
        assert done.returncode == 0, done.stdout + done.stderr
    with allure.step("同じテストを -n 2 と --alluredir 付きで動かす"):
        (tmp_path / "xdist").mkdir()
        results = tmp_path / "xdist/allure-results"
        done = _run_pytest(
            tmp_path / "xdist", conftest, body, "-n", "2", "--alluredir", str(results)
        )
    with allure.step(
        "environment.properties が 1 つで、どの結果にも Python のパラメータがあることを確かめる"
    ):
        assert done.returncode == 0, done.stdout + done.stderr
        assert [path.name for path in (tmp_path / "xdist").rglob("environment.properties")] == [
            "environment.properties"
        ]
        written_env = read_output(results / "environment.properties")
        assert re.fullmatch(r"OS=[^\n]+", written_env), written_env
        assert written_env == read_output(serial / "environment.properties")
        written = _results(results)
        assert len(written) == 4
        for result in written:
            assert _python_parameters(result) == _expected_python_parameter()


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
