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


def _command_words(lane: dict) -> list[str]:
    return [word for word in shlex.split(lane["options"]["command"]) if word.endswith(".py")]


def _command_tests(lane: dict) -> list[str]:
    """レーンの command に載るテストのファイル名。"""
    return [Path(word).name for word in _command_words(lane)]


# 新しいテストのファイルは test-checks の glob で拾い、レーンへの未登録を見る確認を動かす。
_GLOB_LANE = "test-checks"
_TEST_GLOB = "{projectRoot}/tests/test_*.py"
_BROAD_INPUTS = {
    "default",
    "production",
    "{projectRoot}/**/*",
    "{projectRoot}/tests/**/*",
    "{projectRoot}/tests/*",
}


def test_test_entry_bundles_exactly_the_lanes() -> None:
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
def test_command_names_the_full_path_of_each_test(lane_name: str) -> None:
    for word in _command_words(_LANES[lane_name]):
        assert word == f".githooks/tests/{Path(word).name}", f"{lane_name}: {word}"
        assert (_GITHOOKS_DIR.parent / word).is_file(), f"{lane_name}: {word} が無い"


@pytest.mark.parametrize("lane_name", sorted(_LANES))
def test_lane_declares_narrow_inputs(lane_name: str) -> None:
    """広い入力を書くと、.githooks/ のどの変更でもレーンが動く。

    例外は test-checks の tests/test_*.py だけで、新しいテストのファイルを拾う。
    """
    inputs = _LANES[lane_name]["inputs"]
    assert not _BROAD_INPUTS & {i for i in inputs if isinstance(i, str)}
    assert (_TEST_GLOB in inputs) == (lane_name == _GLOB_LANE)
    assert len(inputs) == len({json.dumps(i, sort_keys=True) for i in inputs}), "重複した入力"
    if lane_name != _GLOB_LANE:
        for name in _command_tests(_LANES[lane_name]):
            assert f"{{projectRoot}}/tests/{name}" in inputs, (
                f"{lane_name} の inputs に {name} が無い"
            )


@pytest.mark.parametrize("lane_name", sorted(_LANES))
def test_lane_waits_for_the_shared_install(lane_name: str) -> None:
    assert {"projects": ["pecot"], "target": "install"} in _LANES[lane_name]["dependsOn"]


def test_checks_lane_waits_for_the_text_rules_build() -> None:
    """test_check_text.py が使う libs/text-rules/dist を、text-rules:build が用意する。"""
    assert {"projects": ["text-rules"], "target": "build"} in _LANES["test-checks"]["dependsOn"]


@pytest.mark.parametrize("lane_name", sorted(_LANES))
def test_lane_uses_the_shared_inputs(lane_name: str) -> None:
    inputs = _LANES[lane_name]["inputs"]
    assert "githooksTestGlobals" in inputs
    assert ("githooksGraphInputs" in inputs) == (
        lane_name in {"test-nx-cache", "test-nx-affected", "test-checks"}
    )
