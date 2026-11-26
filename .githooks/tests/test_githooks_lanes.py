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

import allure
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


@allure.title("test の起点の target は、すべてのレーンをまとめて実行する")
def test_test_entry_bundles_exactly_the_lanes() -> None:
    """`.githooks/project.json` の `test` の target のテストです。executor が `nx:noop` で、`dependsOn` が `test-` で始まるレーンの集合と一致することを確認します。"""
    with allure.step("githooks の project.json から test target を読む"):
        entry = _PROJECT["targets"]["test"]

    with allure.step("nx:noop で、全レーンを依存に持つことを確かめる"):
        assert entry["executor"] == "nx:noop"
        assert set(entry["dependsOn"]) == set(_LANES)


@allure.title("tests の各テストのファイルは、ちょうど 1 つのレーンに載る")
def test_every_test_file_is_in_exactly_one_lane() -> None:
    """`.githooks/tests` にあるすべての `test_*.py` と、レーンの command に載るファイルのテストです。載っていないファイルも二重に載っているファイルも存在せず、2 つの一覧が一致することを確認します。"""
    with allure.step("tests/ のファイルと、レーンの command のテストを集める"):
        on_disk = {path.name for path in (_GITHOOKS_DIR / "tests").glob("test_*.py")}
        listed = [name for lane in _LANES.values() for name in _command_tests(lane)]

    with allure.step("すべてのテストがちょうど 1 つのレーンに載ることを確かめる"):
        assert sorted(listed) == sorted(on_disk), (
            f"載っていない: {sorted(on_disk - set(listed))}、"
            f"二重に載っている: {sorted({n for n in listed if listed.count(n) > 1})}"
        )


@allure.title("{lane_name} の command は、各テストを .githooks/tests からのパスで指定する")
@pytest.mark.parametrize("lane_name", sorted(_LANES))
def test_command_names_the_full_path_of_each_test(lane_name: str) -> None:
    """レーンの command に書かれたテストのパスのテストです。すべてのパスが `.githooks/tests/<ファイル名>` の形で、実際にファイルが存在することを確認します。"""
    with allure.step("レーンの command が、実在するテストのフルパスを指すことを確かめる"):
        for word in _command_words(_LANES[lane_name]):
            assert word == f".githooks/tests/{Path(word).name}", f"{lane_name}: {word}"
            assert (_GITHOOKS_DIR.parent / word).is_file(), f"{lane_name}: {word} が無い"


@allure.title("{lane_name} は、広い入力を使わず、必要な入力だけを宣言する")
@pytest.mark.parametrize("lane_name", sorted(_LANES))
def test_lane_declares_narrow_inputs(lane_name: str) -> None:
    """レーンの `inputs` のテストです。`default` などの広い入力を含まず、`test_*.py` の glob は `test-checks` だけが持ち、ほかのレーンは自分のテストのファイルを入力に挙げていることを確認します。"""
    with allure.step("レーンの inputs を読む"):
        inputs = _LANES[lane_name]["inputs"]

    with allure.step("広い入力が無く、重複せず、テストごとの入力があることを確かめる"):
        assert not _BROAD_INPUTS & {i for i in inputs if isinstance(i, str)}
        assert (_TEST_GLOB in inputs) == (lane_name == _GLOB_LANE)
        assert len(inputs) == len({json.dumps(i, sort_keys=True) for i in inputs}), "重複した入力"
        if lane_name != _GLOB_LANE:
            for name in _command_tests(_LANES[lane_name]):
                assert f"{{projectRoot}}/tests/{name}" in inputs, (
                    f"{lane_name} の inputs に {name} が無い"
                )


@allure.title("{lane_name} は、共通の install の target を待つ")
@pytest.mark.parametrize("lane_name", sorted(_LANES))
def test_lane_waits_for_the_shared_install(lane_name: str) -> None:
    """レーンの `dependsOn` のテストです。`pecot` の project の `install` の target が含まれていることを確認します。"""
    with allure.step("レーンが共有の install を待つことを確かめる"):
        assert {"projects": ["pecot"], "target": "install"} in _LANES[lane_name]["dependsOn"]


@allure.title("test-checks のレーンは、text-rules の build を待つ")
def test_checks_lane_waits_for_the_text_rules_build() -> None:
    """`test-checks` の `dependsOn` のテストです。`test_check_text.py` が使う `libs/text-rules/dist` を作るため、`text-rules` の `build` の target が含まれていることを確認します。"""
    with allure.step("test-checks が text-rules の build を待つことを確かめる"):
        assert {"projects": ["text-rules"], "target": "build"} in _LANES["test-checks"]["dependsOn"]


@allure.title("{lane_name} は、共通の入力を使う")
@pytest.mark.parametrize("lane_name", sorted(_LANES))
def test_lane_uses_the_shared_inputs(lane_name: str) -> None:
    """レーンの `inputs` のテストです。`githooksTestGlobals` を含み、`githooksGraphInputs` は `test-nx-cache` など 3 つのレーンだけが含むことを確認します。"""
    with allure.step("レーンの inputs を読む"):
        inputs = _LANES[lane_name]["inputs"]

    with allure.step("共通の入力を使うことを確かめる"):
        assert "githooksTestGlobals" in inputs
        assert ("githooksGraphInputs" in inputs) == (
            lane_name in {"test-nx-cache", "test-nx-affected", "test-checks"}
        )
