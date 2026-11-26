"""test_report/report-lanes.json の決まりと、test_report/lanes.py が出す GitHub Actions の matrix のテスト。"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

import pytest

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
    "pecot-visual:test-cli",
    "pecot-visual:test-slidev",
    "pecot-workflow:test-cli",
    "pecot-workflow:test-hooks",
    "pecot-workflow:test-skills",
    "text-rules:test-unit",
    "workflow-core:test-unit",
]


def _project_files() -> list[str]:
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


def test_project_files_include_all_kinds() -> None:
    # 集め方が狭まると、下の突き合わせが抜けに気づかず通るので、置き場所の 4 種類を確かめる。
    files = _project_files()
    assert ".githooks/project.json" in files
    assert ".nx/nx-release/project.json" in files
    assert "libs/interface-spec/project.json" in files
    assert "plugins/pecot-workflow/project.json" in files


def test_every_test_target_is_listed() -> None:
    listed = {(entry["project"], entry["target"]) for entry in _entries()}
    missing = sorted(f"{p}:{t}" for p, t in set(_test_targets()) - listed)
    assert missing == [], f"report-lanes.json に無い target: {missing}"


def test_every_entry_is_a_real_target() -> None:
    targets = _test_targets()
    unknown = sorted(
        f"{entry['project']}:{entry['target']}"
        for entry in _entries()
        if (entry["project"], entry["target"]) not in targets
    )
    assert unknown == [], f"nx に無い target: {unknown}"


def test_entries_are_unique() -> None:
    ids = _entry_ids()
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("entry", _entries(), ids=_entry_ids())
def test_entry_has_either_results_or_excluded(entry: dict[str, Any]) -> None:
    assert set(entry) <= {"project", "target", "plugin", "results", "excluded"}
    kinds = [key for key in ("results", "excluded") if key in entry]
    assert len(kinds) == 1, f"results と excluded のどちらか一方だけが要ります: {kinds}"
    assert isinstance(entry[kinds[0]], str) and entry[kinds[0]]


def test_included_lanes_match_the_list() -> None:
    included = sorted(f"{e['project']}:{e['target']}" for e in _entries() if "results" in e)
    assert included == _INCLUDED


def test_excluded_reasons() -> None:
    reasons = {
        f"{e['project']}:{e['target']}": e["excluded"] for e in _entries() if "excluded" in e
    }
    assert set(reasons.values()) == {"bash の *.test.sh"}


@pytest.mark.parametrize(
    "entry",
    [e for e in _entries() if "results" in e],
    ids=lambda e: f"{e['project']}:{e['target']}",
)
def test_results_is_in_outputs(entry: dict[str, Any]) -> None:
    root, definition = _test_targets()[(entry["project"], entry["target"])]
    outputs = [
        output.replace("{projectRoot}", root).replace("{workspaceRoot}/", "").rstrip("/")
        for output in definition.get("outputs", [])
    ]
    assert entry["results"] in outputs, (
        f"{entry['project']}:{entry['target']} の outputs: {outputs}"
    )


@pytest.mark.parametrize(
    "entry",
    [e for e in _entries() if "results" in e],
    ids=lambda e: f"{e['project']}:{e['target']}",
)
def test_results_path_shape(entry: dict[str, Any]) -> None:
    # allure-reporter.ts と run.sh が、この形でディレクトリを作る。
    assert PurePosixPath(entry["results"]).name == "allure-results"
    root = _roots()[entry["project"]]
    assert entry["results"] == f"{root}/test-results/{entry['target']}/allure-results"


@pytest.mark.parametrize("entry", _entries(), ids=_entry_ids())
def test_plugin_only_for_plugins(entry: dict[str, Any]) -> None:
    root = _roots()[entry["project"]]
    if PurePosixPath(root).parent == PurePosixPath("plugins"):
        assert entry.get("plugin") == entry["project"]
    else:
        assert "plugin" not in entry


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(_LANES), *args], capture_output=True, text=True, check=False
    )


def _js_slug(lanes: list[str]) -> list[str]:
    """ci.yml の matrix を作る list-test-lanes.sh の JS の式で slug を作る。"""
    source = _LIST_TEST_LANES.read_text(encoding="utf-8")
    match = re.search(r"slug: (lane\.replace\(/.+?/g, \"-\"\))", source)
    assert match, "list-test-lanes.sh に slug の式が見つかりません"
    script = f"const lanes = JSON.parse(process.argv[1]); console.log(JSON.stringify(lanes.map((lane) => {match.group(1)})));"
    out = subprocess.run(
        ["node", "-e", script, json.dumps(lanes)], capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout)


def test_real_lanes_make_one_job_per_lane_on_one_line() -> None:
    result = _run()
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


def test_slug_matches_ci_matrix(tmp_path: Path) -> None:
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
    assert result.returncode == 0, result.stderr
    by_lane = {job["lane"]: job["slug"] for job in json.loads(result.stdout)}
    assert [by_lane[lane] for lane in lanes] == _js_slug(lanes)
    assert "p:test-z" not in by_lane


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
    path = tmp_path / "report-lanes.json"
    path.write_text(json.dumps(lanes), encoding="utf-8")
    result = _run(str(path))
    assert result.returncode == 1
    assert result.stdout == ""
    assert message in result.stderr
    assert result.stderr.count("\n") == 1


def test_missing_file_stops(tmp_path: Path) -> None:
    result = _run(str(tmp_path / "none.json"))
    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr.startswith("ERROR: ")
