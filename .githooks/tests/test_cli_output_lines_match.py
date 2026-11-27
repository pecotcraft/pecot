"""3 プラグインの診断行の期待（error・warning・note）が同じ集合であることの確認（#215）。"""

from __future__ import annotations

import json
from pathlib import Path

import allure
import pytest

_FILES = {
    "pecot-workflow": "libs/workflow-core/tests/output/cases.json",
    "pecot-visual": "plugins/pecot-visual/cli/tests/diagnostics-cases.json",
    "pecot-tools": "plugins/pecot-tools/cli/tests/diagnostics-cases.json",
}


def _cases(root: Path, kind: str) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for plugin, rel in _FILES.items():
        items = json.loads((root / rel).read_text())
        result[plugin] = {
            json.dumps({k: v for k, v in item.items() if k != "dryRun"}, sort_keys=True)
            for item in items
            if item["kind"] == kind
        }
    return result


@pytest.fixture
def root(script_dir: Path) -> Path:
    return script_dir.parents[1]


@allure.title("3 つのプラグインの {kind} の診断行の期待は、同じ集合になる")
@pytest.mark.parametrize("kind", ["error", "warning"])
def test_error_and_warning_cases_match_across_plugins(root: Path, kind: str) -> None:
    """3 つのプラグインの診断行の期待（`error` と `warning`）のテストです。どのプラグインにも該当する要素が存在し、`pecot-workflow` を基準にして、ほかの 2 つの集合が一致していることを確認します。"""
    with allure.step("3 プラグインの診断行の期待を集める"):
        by_plugin = _cases(root, kind)
    with allure.step("どのプラグインも pecot-workflow と同じ集合であることを確かめる"):
        for plugin, cases in by_plugin.items():
            assert cases, f"{plugin} に kind={kind} の要素がありません"
        reference = by_plugin["pecot-workflow"]
        for plugin, cases in by_plugin.items():
            assert cases == reference, f"{plugin} の kind={kind} が pecot-workflow と異なります"


@allure.title("note の診断行の期待は、note を持つファイルの間で同じ集合になる")
def test_note_cases_match_across_files_that_have_them(root: Path) -> None:
    """診断行の期待のうち、`note` のテストです。`note` の要素を持つファイルが 1 つ以上あり、持つファイルどうしで集合が一致していることを確認します。"""
    with allure.step("note の期待を持つファイルを集める"):
        with_notes = {p: c for p, c in _cases(root, "note").items() if c}
    with allure.step("どのファイルも同じ集合であることを確かめる"):
        assert with_notes, "note の要素を持つファイルがありません"
        first_plugin, first = next(iter(with_notes.items()))
        for plugin, cases in with_notes.items():
            assert cases == first, f"{plugin} の note が {first_plugin} と異なります"
