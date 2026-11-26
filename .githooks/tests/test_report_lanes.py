"""test_report/report-lanes.json の決まりと、test_report/lanes.py が出す GitHub Actions の matrix のテスト。"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import run_attached  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
_REPORT_LANES = _REPO / ".githooks/scripts/test_report/report-lanes.json"
_LANES = _REPO / ".githooks/scripts/test_report/lanes.py"
_LIST_TEST_LANES = _REPO / ".githooks/ci/list-test-lanes.sh"

_INCLUDED = [
    "githooks:test-checks",
    "githooks:test-ci",
    "githooks:test-nx-affected",
    "githooks:test-nx-cache",
    "interface-spec:test-site",
    "interface-spec:test-unit",
    "nx-release:test-unit",
    "pecot-tools:test-cli",
    "pecot-tools:test-release",
    "pecot-visual:test-cli",
    "pecot-visual:test-compare",
    "pecot-visual:test-hooks",
    "pecot-visual:test-release",
    "pecot-visual:test-skills",
    "pecot-visual:test-slidev",
    "pecot-workflow:test-bootstrap",
    "pecot-workflow:test-cli",
    "pecot-workflow:test-hooks",
    "pecot-workflow:test-release",
    "pecot-workflow:test-skills",
    "text-rules:test-unit",
    "workflow-core:test-unit",
]


def _project_files() -> list[str]:
    # リポのファイルの一覧はテストの入力で、テスト対象の出力でないので添付しない。
    out = subprocess.run(
        ["git", "ls-files"], cwd=_REPO, capture_output=True, text=True, check=True
    ).stdout
    return [path for path in out.splitlines() if PurePosixPath(path).name == "project.json"]


def _test_targets() -> dict[tuple[str, str], tuple[str, dict[str, Any]]]:
    """全部の project.json の test-* の target（nx:noop を除く）を、(project, target) から (project の root, 定め) で引く。"""
    found: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
    for path in _project_files():
        project = json.loads((_REPO / path).read_text(encoding="utf-8"))
        root = str(PurePosixPath(path).parent)
        for target, definition in project.get("targets", {}).items():
            if target.startswith("test-") and definition.get("executor") != "nx:noop":
                found[(project["name"], target)] = (root, definition)
    return found


def _entries() -> list[dict[str, Any]]:
    return json.loads(_REPORT_LANES.read_text(encoding="utf-8"))


def _entry_ids() -> list[str]:
    return [f"{entry['project']}:{entry['target']}" for entry in _entries()]


def _roots() -> dict[str, str]:
    return {project: root for (project, _), (root, _) in _test_targets().items()}


@allure.title("`project.json` の収集結果に、置き場所の 4 種類がすべて含まれる")
def test_project_files_include_all_kinds() -> None:
    """`git ls-files` から `project.json` を集める処理のテストです。`.githooks`・`.nx/nx-release`・`libs`・`plugins` の 4 種類の置き場所が、いずれも収集結果に含まれることを確認します。"""
    with allure.step("project.json の一覧を読む"):
        # 集め方が狭まると、下の突き合わせが抜けに気づかず通るので、置き場所の 4 種類を確かめる。
        files = _project_files()
    with allure.step("全種類のプロジェクトのファイルが含まれることを確かめる"):
        assert ".githooks/project.json" in files
        assert ".nx/nx-release/project.json" in files
        assert "libs/interface-spec/project.json" in files
        assert "plugins/pecot-workflow/project.json" in files


@allure.title("nx の test target は、すべて report-lanes.json に載っている")
def test_every_test_target_is_listed() -> None:
    """`project.json` に定義された `test-` で始まる target（`nx:noop` を除く）のテストです。`report-lanes.json` に載っていない target が 1 件も存在しないことを確認します。"""
    with allure.step("nx の test target を読む"):
        listed = {(entry["project"], entry["target"]) for entry in _entries()}
        missing = sorted(f"{p}:{t}" for p, t in set(_test_targets()) - listed)
    with allure.step("すべてが report-lanes.json に載っていることを確かめる"):
        assert missing == [], f"report-lanes.json に無い target: {missing}"


@allure.title("report-lanes.json の項目は、すべて実在する nx の target を指す")
def test_every_entry_is_a_real_target() -> None:
    """`report-lanes.json` の各項目のテストです。project と target の組み合わせが、nx に存在しない項目が 1 件も存在しないことを確認します。"""
    with allure.step("report-lanes.json の項目を読む"):
        targets = _test_targets()
        unknown = sorted(
            f"{entry['project']}:{entry['target']}"
            for entry in _entries()
            if (entry["project"], entry["target"]) not in targets
        )
    with allure.step("すべてが nx の実在の target であることを確かめる"):
        assert unknown == [], f"nx に無い target: {unknown}"


@allure.title("report-lanes.json の項目は、project と target の組み合わせが重ならない")
def test_entries_are_unique() -> None:
    """`report-lanes.json` の項目の識別子（`project:target`）に、重複が存在しないことを確認するテストです。"""
    with allure.step("項目の識別子を集める"):
        ids = _entry_ids()
    with allure.step("識別子が重ならないことを確かめる"):
        assert len(ids) == len(set(ids))


@allure.title("項目 {param_id} は、results と excluded のどちらか一方だけを持つ")
@pytest.mark.parametrize("entry", _entries(), ids=_entry_ids())
def test_entry_has_either_results_or_excluded(entry: dict[str, Any]) -> None:
    """`report-lanes.json` の各項目のテストです。使える項目名が決まった範囲に収まり、`results` と `excluded` のうち一方だけが存在し、値が空でない文字列であることを確認します。"""
    with allure.step("項目のキーの種類を確かめる"):
        assert set(entry) <= {"project", "target", "plugin", "results", "excluded"}
        kinds = [key for key in ("results", "excluded") if key in entry]
        assert len(kinds) == 1, f"results と excluded のどちらか一方だけが要ります: {kinds}"
        assert isinstance(entry[kinds[0]], str) and entry[kinds[0]]


@allure.title("レポートに載せるレーンは、期待する一覧と一致する")
def test_included_lanes_match_the_list() -> None:
    """`results` を持つ項目、つまりレポートに載せるレーンのテストです。レーンの一覧が、期待する一覧と過不足なく一致することを確認します。"""
    with allure.step("results を持つ項目を集める"):
        included = sorted(f"{e['project']}:{e['target']}" for e in _entries() if "results" in e)
    with allure.step("含めるレーンが期待の一覧と同じことを確かめる"):
        assert included == _INCLUDED


@allure.title("report-lanes.json に、除外するレーンは存在しない")
def test_excluded_reasons() -> None:
    """`excluded` を持つ項目のテストです。すべてのレーンをレポートへ載せる今の構成で、除外するレーンが 1 つも存在しないことを確認します。"""
    with allure.step("除外の理由を集める"):
        reasons = {
            f"{e['project']}:{e['target']}": e["excluded"] for e in _entries() if "excluded" in e
        }
    with allure.step("除外するレーンが無いことを確かめる"):
        assert reasons == {}


@allure.title("レーン {param_id} の results は、target の outputs に含まれる")
@pytest.mark.parametrize(
    "entry",
    [e for e in _entries() if "results" in e],
    ids=lambda e: f"{e['project']}:{e['target']}",
)
def test_results_is_in_outputs(entry: dict[str, Any]) -> None:
    """レポートに載せる各レーンの `results` のテストです。`project.json` の `outputs` から求めたパスの一覧に、`results` の値が含まれることを確認します。"""
    with allure.step("target の outputs を読む"):
        root, definition = _test_targets()[(entry["project"], entry["target"])]
        outputs = [
            output.replace("{projectRoot}", root).replace("{workspaceRoot}/", "").rstrip("/")
            for output in definition.get("outputs", [])
        ]
    with allure.step("results が outputs に入っていることを確かめる"):
        assert entry["results"] in outputs, (
            f"{entry['project']}:{entry['target']} の outputs: {outputs}"
        )


@allure.title("レーン {param_id} の results は、project のルート配下の決まった形にする")
@pytest.mark.parametrize(
    "entry",
    [e for e in _entries() if "results" in e],
    ids=lambda e: f"{e['project']}:{e['target']}",
)
def test_results_path_shape(entry: dict[str, Any]) -> None:
    """レポートに載せる各レーンの `results` のテストです。名前が `allure-results` で、パスが `<project のルート>/test-results/<target>/allure-results` の形であることを確認します。"""
    with allure.step("results の path の形を確かめる"):
        # allure-reporter.ts と run.sh が、この形でディレクトリを作る。
        assert PurePosixPath(entry["results"]).name == "allure-results"
        root = _roots()[entry["project"]]
        assert entry["results"] == f"{root}/test-results/{entry['target']}/allure-results"


@allure.title("項目 {param_id} は、プラグインの project にだけ plugin を持つ")
@pytest.mark.parametrize("entry", _entries(), ids=_entry_ids())
def test_plugin_only_for_plugins(entry: dict[str, Any]) -> None:
    """`report-lanes.json` の各項目の `plugin` のテストです。`plugins` 直下の project では `plugin` が project 名と一致し、それ以外の project では `plugin` が存在しないことを確認します。"""
    with allure.step("プロジェクトの場所を読む"):
        root = _roots()[entry["project"]]
    with allure.step("plugin の項目がプラグインにだけあることを確かめる"):
        if PurePosixPath(root).parent == PurePosixPath("plugins"):
            assert entry.get("plugin") == entry["project"]
        else:
            assert "plugin" not in entry


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return run_attached(
        [sys.executable, str(_LANES), *args], capture_output=True, text=True, check=False
    )


def _js_slug(lanes: list[str]) -> list[str]:
    """ci.yml の matrix を作る list-test-lanes.sh の JS の式で slug を作る。"""
    source = _LIST_TEST_LANES.read_text(encoding="utf-8")
    match = re.search(r"slug: (lane\.replace\(/.+?/g, \"-\"\))", source)
    assert match, "list-test-lanes.sh に slug の式が見つかりません"
    script = f"const lanes = JSON.parse(process.argv[1]); console.log(JSON.stringify(lanes.map((lane) => {match.group(1)})));"
    out = run_attached(
        ["node", "-e", script, json.dumps(lanes)], capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout)


@allure.title("実際の report-lanes.json から、すべてのレーンの job を 1 行の JSON で出力する")
def test_real_lanes_make_one_job_per_lane_on_one_line() -> None:
    """`lanes.py` を引数なしで実行した場合のテストです。標準出力が改行 1 つの JSON で、job の順序と先頭の内容が期待どおりであり、slug が ci.yml の matrix と一致することを確認します。"""
    with allure.step("実際のレーンの一覧で CLI を動かす"):
        result = _run()
    with allure.step("終了コード・1 行の matrix・レーンごとの job を確かめる"):
        assert result.returncode == 0, result.stderr
        assert result.stdout.count("\n") == 1
        matrix = json.loads(result.stdout)
        assert [job["lane"] for job in matrix] == _INCLUDED
        assert matrix[0] == {
            "lane": "githooks:test-checks",
            "slug": "githooks-test-checks",
            "results": ".githooks/test-results/test-checks/allure-results",
        }
        assert {job["slug"] for job in matrix} == set(_js_slug(_INCLUDED))


@allure.title("レーン名から作る slug は、ci.yml の matrix の式と一致する")
def test_slug_matches_ci_matrix(tmp_path: Path) -> None:
    """記号や空白を含むレーン名を持つ `report-lanes.json` から、`lanes.py` が slug を作る場合のテストです。`list-test-lanes.sh` の JavaScript の式と同じ slug になり、除外したレーンは出力に含まれないことを確認します。"""
    with allure.step("記号を含むレーン名の一覧を書いて CLI を動かす"):
        lanes = ["p:test-a", "p/x:test b", "p.q_r:test-c"]
        path = tmp_path / "report-lanes.json"
        path.write_text(
            json.dumps(
                [
                    {"project": lane.split(":")[0], "target": lane.split(":")[1], "results": f"{i}"}
                    for i, lane in enumerate(lanes)
                ]
                + [{"project": "p", "target": "test-z", "excluded": "bash の *.test.sh"}]
            ),
            encoding="utf-8",
        )
        result = _run(str(path))
    with allure.step("slug が CI の matrix と合うことを確かめる"):
        assert result.returncode == 0, result.stderr
        by_lane = {job["lane"]: job["slug"] for job in json.loads(result.stdout)}
        assert [by_lane[lane] for lane in lanes] == _js_slug(lanes)
        assert "p:test-z" not in by_lane


@allure.title("{param_id} の形式の report-lanes.json を渡すと、1 行のエラーで止まる")
@pytest.mark.parametrize(
    ("lanes", "message"),
    [
        (
            [
                {"project": "p", "target": "test/a", "results": "a"},
                {"project": "p", "target": "test:a", "results": "b"},
            ],
            "p-test-a",
        ),
        ([{"project": "p", "results": "a"}], "#1"),
        ([{"project": "p", "target": "test-a", "results": "a", "excluded": "x"}], "#1"),
        ([{"project": "p", "target": "test-a"}], "#1"),
        ({"project": "p"}, "配列"),
    ],
    ids=["duplicate-slug", "missing-target", "both-kinds", "no-kind", "not-a-list"],
)
def test_broken_lanes_stop_with_one_line(tmp_path: Path, lanes: object, message: str) -> None:
    """形式が正しくない `report-lanes.json` を渡した場合のテストです。終了コードが 1 になり、標準出力が空で、標準エラー出力に原因を示す 1 行のメッセージが表示されることを確認します。"""
    with allure.step("読めないレーンの一覧を書いて CLI を動かす"):
        path = tmp_path / "report-lanes.json"
        path.write_text(json.dumps(lanes), encoding="utf-8")
        result = _run(str(path))
    with allure.step("終了コード 1 と 1 行のエラーの出力を確かめる"):
        assert result.returncode == 1
        assert result.stdout == ""
        assert message in result.stderr
        assert result.stderr.count("\n") == 1


@allure.title("report-lanes.json が存在しないと、`ERROR:` で始まるメッセージを表示して止まる")
def test_missing_file_stops(tmp_path: Path) -> None:
    """存在しないファイルのパスを渡して `lanes.py` を実行した場合のテストです。終了コードが 1 になり、標準出力が空で、標準エラー出力が `ERROR: ` で始まることを確認します。"""
    with allure.step("存在しないファイルで CLI を動かす"):
        result = _run(str(tmp_path / "none.json"))
    with allure.step("終了コード 1 と ERROR の出力を確かめる"):
        assert result.returncode == 1
        assert result.stdout == ""
        assert result.stderr.startswith("ERROR: ")
