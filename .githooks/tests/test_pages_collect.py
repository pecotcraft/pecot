"""pages_site/collect.py のテスト。JUnit を側の artifact へ写し、レーンごとの数と出どころを job summary に書く。"""

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
    out = tmp_path / "side"
    root = tmp_path / "repo"
    root.mkdir()
    return lanes, out, root


def _drop(root: Path, junit: str, body: str) -> None:
    target = root / junit
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")


def _run(lanes: Path, out: Path, root: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(_COLLECT),
            "--lanes",
            str(lanes),
            "--out",
            str(out),
            "--root",
            str(root),
            "--side",
            "pr",
            "--pr",
            "12",
            "--sha",
            "0123456789abcdef0123456789abcdef01234567",
            *extra,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def test_copies_each_junit_into_the_side_and_counts(scene: tuple[Path, Path, Path]) -> None:
    lanes, out, root = scene
    _drop(root, "plugins/a/cli/test-results/junit.xml", _FLAT)
    _drop(root, "plugins/b/cli/test-results/junit-b.xml", _NESTED)

    result = _run(lanes, out, root)

    assert result.returncode == 0, result.stderr
    assert (out / "junit/plugins/a/cli/test-results/junit.xml").read_text(encoding="utf-8") == _FLAT
    assert (out / "junit/plugins/b/cli/test-results/junit-b.xml").read_text(
        encoding="utf-8"
    ) == _NESTED
    assert "| a:test-cli | 4 | 2 | 1 | 0 | 1 | この run |" in result.stdout
    assert "| b:test-cli | 3 | 1 | 1 | 1 | 0 | この run |" in result.stdout
    assert "| レーン | tests | passed | failures | errors | skipped | 出どころ |" in result.stdout


def test_summary_names_side_and_commit(scene: tuple[Path, Path, Path]) -> None:
    lanes, out, root = scene
    _drop(root, "plugins/a/cli/test-results/junit.xml", _FLAT)
    _drop(root, "plugins/b/cli/test-results/junit-b.xml", _FLAT)

    out = _run(lanes, out, root).stdout

    assert "PR #12" in out
    assert "0123456789abcdef0123456789abcdef01234567" in out


def test_missing_lane_is_named_and_fails_but_other_rows_stay(
    scene: tuple[Path, Path, Path],
) -> None:
    lanes, out, root = scene
    _drop(root, "plugins/a/cli/test-results/junit.xml", _FLAT)

    result = _run(lanes, out, root)

    assert result.returncode == 1
    assert "b:test-cli" in result.stderr
    assert "| a:test-cli | 4 | 2 | 1 | 0 | 1 |" in result.stdout
    assert "| b:test-cli | JUnit 無し |" in result.stdout


def test_unreadable_junit_counts_as_missing(scene: tuple[Path, Path, Path]) -> None:
    lanes, out, root = scene
    _drop(root, "plugins/a/cli/test-results/junit.xml", _FLAT)
    _drop(root, "plugins/b/cli/test-results/junit-b.xml", "<testsuites>")

    result = _run(lanes, out, root)

    assert result.returncode == 1
    assert "b:test-cli" in result.stderr
    assert "| b:test-cli | JUnit を読めない |" in result.stdout


# --ran（ci.yml の pages-preview）: ci が動かしたレーンは ci の JUnit、ほかは開発版の JUnit で埋める

_DEV_SHA = "fedcba9876543210fedcba9876543210fedcba98"
_A = "plugins/a/cli/test-results/junit.xml"
_B = "plugins/b/cli/test-results/junit-b.xml"


def _run_pr(
    scene: tuple[Path, Path, Path], ran: str
) -> tuple[subprocess.CompletedProcess[str], Path]:
    lanes, out, root = scene
    filled = out.parent / "filled.json"
    result = _run(
        lanes,
        out,
        root,
        "--ran",
        ran,
        "--ci-dir",
        str(root.parent / "ci"),
        "--dev-dir",
        str(root.parent / "dev"),
        "--dev-sha",
        _DEV_SHA,
        "--filled-out",
        str(filled),
    )
    return result, filled


def test_mixes_ci_and_dev_junit_and_writes_filled(scene: tuple[Path, Path, Path]) -> None:
    lanes, out, root = scene
    _drop(root.parent / "ci", _A, _FLAT)
    _drop(root.parent / "dev", f"junit/{_B}", _NESTED)
    # ci が動かしたレーンでも、作業ツリーの古い JUnit は使わない。
    _drop(root, _A, _NESTED)

    result, filled = _run_pr(scene, json.dumps([{"lane": "a:test-cli", "slug": "a-test-cli"}]))

    assert result.returncode == 0, result.stderr
    for base in (out / "junit", root):
        assert (base / _A).read_text(encoding="utf-8") == _FLAT
        assert (base / _B).read_text(encoding="utf-8") == _NESTED
    assert json.loads(filled.read_text(encoding="utf-8")) == ["b:test-cli"]
    assert "| a:test-cli | 4 | 2 | 1 | 0 | 1 | この PR の ci |" in result.stdout
    assert "| b:test-cli | 3 | 1 | 1 | 1 | 0 | 開発版 fedcba9 |" in result.stdout


def test_lanes_without_junit_entry_in_ran_are_ignored(scene: tuple[Path, Path, Path]) -> None:
    _, _, root = scene
    _drop(root.parent / "dev", f"junit/{_A}", _FLAT)
    _drop(root.parent / "dev", f"junit/{_B}", _FLAT)

    result, filled = _run_pr(scene, json.dumps([{"lane": "a:test-skills", "slug": "x"}]))

    assert result.returncode == 0, result.stderr
    assert json.loads(filled.read_text(encoding="utf-8")) == ["a:test-cli", "b:test-cli"]


@pytest.mark.parametrize("ran", ["", "[]"])
def test_no_ran_lanes_fills_everything_from_dev(scene: tuple[Path, Path, Path], ran: str) -> None:
    _, _, root = scene
    _drop(root.parent / "dev", f"junit/{_A}", _FLAT)
    _drop(root.parent / "dev", f"junit/{_B}", _FLAT)

    result, filled = _run_pr(scene, ran)

    assert result.returncode == 0, result.stderr
    assert json.loads(filled.read_text(encoding="utf-8")) == ["a:test-cli", "b:test-cli"]


def test_ran_lane_without_ci_junit_fails_without_filling(scene: tuple[Path, Path, Path]) -> None:
    _, out, root = scene
    # 開発版にあっても、ci が動かしたレーンを開発版の合格で隠さない。
    _drop(root.parent / "dev", f"junit/{_A}", _FLAT)
    _drop(root.parent / "dev", f"junit/{_B}", _FLAT)

    result, _ = _run_pr(scene, json.dumps([{"lane": "a:test-cli"}]))

    assert result.returncode == 1
    assert "a:test-cli" in result.stderr
    assert "| a:test-cli | ci の JUnit 無し |" in result.stdout
    assert not (out / "junit" / _A).exists()
    assert not (root / _A).exists()


def test_lane_missing_in_dev_fails(scene: tuple[Path, Path, Path]) -> None:
    _, _, root = scene
    _drop(root.parent / "ci", _A, _FLAT)

    result, _ = _run_pr(scene, json.dumps([{"lane": "a:test-cli"}]))

    assert result.returncode == 1
    assert "b:test-cli" in result.stderr
    assert "| b:test-cli | 開発版にこのレーンの JUnit 無し |" in result.stdout


@pytest.mark.parametrize("ran", ["{}", '["a:test-cli"]', '[{"slug": "a"}]', "not json"])
def test_bad_ran_fails(scene: tuple[Path, Path, Path], ran: str) -> None:
    result, _ = _run_pr(scene, ran)
    assert result.returncode == 1
    assert "ERROR" in result.stderr


def test_ran_needs_ci_and_dev_dirs(scene: tuple[Path, Path, Path]) -> None:
    lanes, out, root = scene
    result = _run(lanes, out, root, "--ran", "[]")
    assert result.returncode == 2
    assert "--ci-dir" in result.stderr
