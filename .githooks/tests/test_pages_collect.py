"""pages_site/collect.py のテスト。落とした JUnit を置き直し、レーンごとの数を job summary に書く。"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_COLLECT = _REPO / ".githooks/scripts/pages_site/collect.py"

_LANES = [
    {"plugin": "a", "target": "a:test-cli", "junit": "plugins/a/cli/test-results/junit.xml"},
    {"plugin": "b", "target": "b:test-cli", "junit": "plugins/b/cli/test-results/junit-b.xml"},
]

_FLAT = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="4" failures="1" errors="0">
  <testsuite name="x.test.ts" tests="4">
    <testcase classname="x" name="ok 1"/>
    <testcase classname="x" name="ok 2"/>
    <testcase classname="x" name="ng"><failure message="expected 1">stack</failure></testcase>
    <testcase classname="x" name="skip"><skipped/></testcase>
  </testsuite>
</testsuites>
"""

# 属性の数（tests="99"）は数えない。<testcase> の子の要素だけで数える。
_NESTED = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="99">
  <testsuite name="outer">
    <testsuite name="inner">
      <testcase classname="y" name="ok"/>
      <testcase classname="y" name="boom"><error message="TypeError"/></testcase>
    </testsuite>
    <testcase classname="y" name="ng"><failure/></testcase>
  </testsuite>
</testsuites>
"""


@pytest.fixture()
def scene(tmp_path: Path) -> tuple[Path, Path, Path]:
    lanes = tmp_path / "junit-lanes.json"
    lanes.write_text(json.dumps(_LANES), encoding="utf-8")
    downloaded = tmp_path / "dl"
    root = tmp_path / "repo"
    root.mkdir()
    return lanes, downloaded, root


def _drop(downloaded: Path, slug: str, name: str, body: str) -> None:
    target = downloaded / f"pages-junit-{slug}" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")


def _run(lanes: Path, downloaded: Path, root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(_COLLECT),
            "--lanes",
            str(lanes),
            "--downloaded",
            str(downloaded),
            "--root",
            str(root),
            "--side",
            "pr",
            "--pr",
            "12",
            "--sha",
            "0123456789abcdef0123456789abcdef01234567",
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def test_places_each_junit_at_its_lane_path_and_counts(scene: tuple[Path, Path, Path]) -> None:
    lanes, downloaded, root = scene
    _drop(downloaded, "a-test-cli", "junit.xml", _FLAT)
    _drop(downloaded, "b-test-cli", "junit-b.xml", _NESTED)

    result = _run(lanes, downloaded, root)

    assert result.returncode == 0, result.stderr
    assert (root / "plugins/a/cli/test-results/junit.xml").read_text(encoding="utf-8") == _FLAT
    assert (root / "plugins/b/cli/test-results/junit-b.xml").read_text(encoding="utf-8") == _NESTED
    assert "| a:test-cli | 4 | 2 | 1 | 0 | 1 |" in result.stdout
    assert "| b:test-cli | 3 | 1 | 1 | 1 | 0 |" in result.stdout


def test_summary_names_side_and_commit(scene: tuple[Path, Path, Path]) -> None:
    lanes, downloaded, root = scene
    _drop(downloaded, "a-test-cli", "junit.xml", _FLAT)
    _drop(downloaded, "b-test-cli", "junit-b.xml", _FLAT)

    out = _run(lanes, downloaded, root).stdout

    assert "PR #12" in out
    assert "0123456789abcdef0123456789abcdef01234567" in out


def test_missing_lane_is_named_and_fails_but_other_rows_stay(
    scene: tuple[Path, Path, Path],
) -> None:
    lanes, downloaded, root = scene
    _drop(downloaded, "a-test-cli", "junit.xml", _FLAT)

    result = _run(lanes, downloaded, root)

    assert result.returncode == 1
    assert "b:test-cli" in result.stderr
    assert "| a:test-cli | 4 | 2 | 1 | 0 | 1 |" in result.stdout
    assert "| b:test-cli | JUnit 無し |" in result.stdout


def test_unreadable_junit_counts_as_missing(scene: tuple[Path, Path, Path]) -> None:
    lanes, downloaded, root = scene
    _drop(downloaded, "a-test-cli", "junit.xml", _FLAT)
    _drop(downloaded, "b-test-cli", "junit-b.xml", "<testsuites>")

    result = _run(lanes, downloaded, root)

    assert result.returncode == 1
    assert "b:test-cli" in result.stderr
    assert "| b:test-cli | JUnit を読めない |" in result.stdout
