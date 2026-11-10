"""project `githooks` のレーン（.githooks/project.json）の振り分けを確かめる。

tests/ の全テストが、ちょうど 1 本のレーンの command に載っていることを見る。
載っていないテストは CI で動かず、2 本に載るテストは二重に動く。
各レーンは inputs を明示する。書かないと targetDefaults の `default`（.githooks/** 全体）が当たり、
.githooks/ のどの変更でもレーンが動く。
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path

import pytest

_GITHOOKS_DIR = Path(__file__).resolve().parents[1]
_PROJECT = json.loads((_GITHOOKS_DIR / "project.json").read_text(encoding="utf-8"))
_LANES = {
    name: target
    for name, target in _PROJECT["targets"].items()
    if name.startswith("test-") and target["executor"] != "nx:noop"
}


def _command_tests(lane: dict) -> list[str]:
    """レーンの command に載るテストのファイル名。"""
    words = shlex.split(lane["options"]["command"])
    return [Path(word).name for word in words if word.endswith(".py")]


def test_lanes_are_the_expected_ones() -> None:
    assert set(_LANES) == {"test-nx-cache", "test-nx-affected", "test-ci", "test-checks"}
    entry = _PROJECT["targets"]["test"]
    assert entry["executor"] == "nx:noop"
    assert set(entry["dependsOn"]) == set(_LANES)


def test_every_test_file_is_in_exactly_one_lane() -> None:
    on_disk = {path.name for path in (_GITHOOKS_DIR / "tests").glob("test_*.py")}
    listed = [name for lane in _LANES.values() for name in _command_tests(lane)]
    assert sorted(listed) == sorted(on_disk), (
        f"載っていない: {sorted(on_disk - set(listed))}、"
        f"二重に載っている: {sorted({n for n in listed if listed.count(n) > 1})}"
    )


@pytest.mark.parametrize("lane_name", sorted(_LANES))
def test_lane_declares_inputs_without_default(lane_name: str) -> None:
    inputs = _LANES[lane_name]["inputs"]
    assert "default" not in inputs
    for name in _command_tests(_LANES[lane_name]):
        assert f"{{projectRoot}}/tests/{name}" in inputs, f"{lane_name} の inputs に {name} が無い"


@pytest.mark.parametrize("lane_name", sorted(_LANES))
def test_lane_waits_for_the_shared_install(lane_name: str) -> None:
    assert {"projects": ["pecot"], "target": "install"} in _LANES[lane_name]["dependsOn"]
