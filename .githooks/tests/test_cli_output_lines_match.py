"""3 プラグインの診断行の期待（error・warning・note）が同じ集合であることの確認（#215）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

_FILES = {
    "pecot-workflow": "plugins/pecot-workflow/cli-node/tests/output/cases.json",
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


@pytest.mark.parametrize("kind", ["error", "warning"])
def test_error_and_warning_cases_match_across_plugins(root: Path, kind: str) -> None:
    by_plugin = _cases(root, kind)
    for plugin, cases in by_plugin.items():
        assert cases, f"{plugin} に kind={kind} の要素がありません"
    reference = by_plugin["pecot-workflow"]
    for plugin, cases in by_plugin.items():
        assert cases == reference, f"{plugin} の kind={kind} が pecot-workflow と異なります"


def test_note_cases_match_across_files_that_have_them(root: Path) -> None:
    with_notes = {p: c for p, c in _cases(root, "note").items() if c}
    assert with_notes, "note の要素を持つファイルがありません"
    first_plugin, first = next(iter(with_notes.items()))
    for plugin, cases in with_notes.items():
        assert cases == first, f"{plugin} の note が {first_plugin} と異なります"
