"""pages_site/lanes.py のテスト。junit-lanes.json から GitHub Actions の matrix の JSON を作る。"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_LANES = _REPO / ".githooks/scripts/pages_site/lanes.py"
_LIST_TEST_LANES = _REPO / ".githooks/ci/list-test-lanes.sh"


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


def test_real_lanes_make_four_jobs_on_one_line() -> None:
    result = _run()
    assert result.returncode == 0, result.stderr
    assert result.stdout.count("\n") == 1
    matrix = json.loads(result.stdout)
    assert matrix == [
        {
            "lane": "pecot-tools:test-cli",
            "slug": "pecot-tools-test-cli",
            "junit": "plugins/pecot-tools/cli/test-results/junit.xml",
        },
        {
            "lane": "pecot-visual:test-cli",
            "slug": "pecot-visual-test-cli",
            "junit": "plugins/pecot-visual/cli/test-results/junit.xml",
        },
        {
            "lane": "pecot-workflow:test-cli",
            "slug": "pecot-workflow-test-cli",
            "junit": "plugins/pecot-workflow/cli/test-results/junit.xml",
        },
        {
            "lane": "pecot-workflow:test-hooks",
            "slug": "pecot-workflow-test-hooks",
            "junit": "plugins/pecot-workflow/cli/test-results/junit-hooks.xml",
        },
    ]


def test_slug_matches_ci_matrix(tmp_path: Path) -> None:
    lanes = ["p:test-a", "p/x:test b", "p.q_r:test-c"]
    path = tmp_path / "junit-lanes.json"
    path.write_text(
        json.dumps(
            [
                {"plugin": t.split(":")[0], "target": t, "junit": f"{i}.xml"}
                for i, t in enumerate(lanes)
            ]
        ),
        encoding="utf-8",
    )
    result = _run(str(path))
    assert result.returncode == 0, result.stderr
    by_lane = {job["lane"]: job["slug"] for job in json.loads(result.stdout)}
    assert [by_lane[lane] for lane in lanes] == _js_slug(lanes)


@pytest.mark.parametrize(
    ("lanes", "message"),
    [
        (
            [
                {"plugin": "p", "target": "p:test/a", "junit": "a.xml"},
                {"plugin": "p", "target": "p:test:a", "junit": "b.xml"},
            ],
            "p-test-a",
        ),
        ([{"plugin": "p", "junit": "a.xml"}], "#1"),
    ],
    ids=["duplicate-slug", "missing-key"],
)
def test_broken_lanes_stop_with_one_line(
    tmp_path: Path, lanes: list[dict[str, str]], message: str
) -> None:
    path = tmp_path / "junit-lanes.json"
    path.write_text(json.dumps(lanes), encoding="utf-8")
    result = _run(str(path))
    assert result.returncode == 1
    assert result.stdout == ""
    assert message in result.stderr
    assert result.stderr.count("\n") == 1
