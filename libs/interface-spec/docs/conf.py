"""インタフェース定義書の HTML 表示の Sphinx 設定。"""

import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent
ROOT = DOCS.parents[2]
sys.path.insert(0, str(DOCS / "_ext"))

project = "インタフェース定義書"
language = "ja"
extensions = ["sphinx_needs", "sphinx_test_reports", "iface_defs"]
exclude_patterns = ["_build", "_generated/junit", ".venv", "tests", "_ext"]
html_theme = "alabaster"

# 既定の正規表現は PW-… の ID に合わない。
needs_id_regex = r"^[A-Z0-9_\-]{4,}"
needs_types = [
    {
        "directive": "cmd",
        "title": "コマンド・ツール",
        "prefix": "C_",
        "color": "#BFD8D2",
        "style": "node",
    },
    {
        "directive": "behavior",
        "title": "振る舞い",
        "prefix": "B_",
        "color": "#FEDCD2",
        "style": "node",
    },
]
needs_links = {
    "belongs": {"incoming": "behaviors", "outgoing": "belongs to"},
    "verifies": {"incoming": "verified by", "outgoing": "verifies"},
}
needs_fields = {
    "outcome": {"description": "テストの合否（合格・失敗・未実行）", "schema": {"type": "string"}}
}
needs_build_json = True

# 項目につながるテストの JUnit の property（verifies）を、need のリンクにする。
tr_property_link_types = {"verifies": "verifies"}
tr_suite_id_length = 8
tr_case_id_length = 8

# iface_defs 拡張の設定。テストはこれらを差し替える。
iface_root = str(ROOT)
iface_junit = {
    "pecot-workflow": [
        str(ROOT / "plugins/pecot-workflow/cli/test-results/junit.xml"),
        str(ROOT / "plugins/pecot-workflow/cli-node/test-results/junit.xml"),
        str(ROOT / "plugins/pecot-workflow/cli-node/test-results/junit-hooks.xml"),
    ],
    "pecot-tools": [str(ROOT / "plugins/pecot-tools/cli/test-results/junit.xml")],
    "pecot-visual": [str(ROOT / "plugins/pecot-visual/cli/test-results/junit.xml")],
}
iface_field_map = str(DOCS / "_generated/field-map.json")
