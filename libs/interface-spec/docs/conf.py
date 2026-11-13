"""インタフェース定義書の HTML 表示の Sphinx 設定。"""

import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent
ROOT = DOCS.parents[2]
sys.path.insert(0, str(DOCS / "_ext"))

project = "pecot"
# 既定の題は「pecot  ドキュメント」になるので、プロジェクト名だけにする。
html_title = "pecot"
language = "ja"
html_search_language = "ja"
extensions = [
    "sphinx_needs",
    "sphinx_test_reports",
    "sphinx_design",
    "sphinxawesome_theme",
    "iface_defs",
]
exclude_patterns = ["_build", "_generated/junit", ".venv", "tests", "_ext"]
html_theme = "sphinxawesome_theme"
# ヘッダーに置くものは、テーマが用意している設定項目だけで決める。
_GITHUB_ICON = (
    '<svg height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'
    '<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 '
    "0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 "
    "0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 "
    "1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66"
    "-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 "
    '0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>'
)
templates_path = ["_templates"]
# ロゴは README などでも使うので、リポジトリの .github/assets に置いてある。
html_static_path = ["_static", "../../../.github/assets"]
html_css_files = ["pecot.css"]
html_favicon = "../../../.github/assets/pecot-icon-light.svg"
html_theme_options = {
    "logo_light": "../../../.github/assets/pecot-icon-light.svg",
    "logo_dark": "../../../.github/assets/pecot-icon-dark.svg",
    "main_nav_links": {
        "はじめに": "introduction",
        "ガイド": "guides/index",
        "リファレンス": "reference/index",
        "開発者向け": "development/index",
    },
    "extra_header_link_icons": {
        "GitHub": {"link": "https://github.com/pecotcraft/pecot", "icon": _GITHUB_ICON},
    },
}

# 既定の正規表現は PW-… の ID に合わない。
needs_id_regex = r"^[A-Z0-9_\-]{4,}"
needs_types = [
    {
        "directive": "cmd",
        "title": "ツール",
        "prefix": "C_",
        "color": "#BFD8D2",
        "style": "node",
    },
    {
        "directive": "behavior",
        "title": "機能要件",
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
    "outcome": {
        "description": "Test outcome (passed, failed, not run)",
        "schema": {"type": "string"},
    }
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
        str(ROOT / "plugins/pecot-workflow/cli/test-results/junit.xml"),
        str(ROOT / "plugins/pecot-workflow/cli/test-results/junit-hooks.xml"),
    ],
    "pecot-tools": [str(ROOT / "plugins/pecot-tools/cli/test-results/junit.xml")],
    "pecot-visual": [str(ROOT / "plugins/pecot-visual/cli/test-results/junit.xml")],
}

# コマンド・ツールごとのページを _generated/<plugin>/ に書く。テストは 1 ページで組むので切る。
iface_pages = True
# 本文の用語を、その説明のページへのリンクにする。
iface_terms = {"EvidenceSpec": "/reference/file-formats/evidence-spec"}
