"""表を region の div で包み、狭い画面では包みの中だけで横に送る（Roselli の Responsive Tables の形）。

表に display: block を当てると、スクリーンリーダーが表として扱わなくなることがあるため、表は変えない。
"""

from __future__ import annotations

from typing import Any

from docutils import nodes
from sphinx.application import Sphinx
from sphinx.writers.html5 import HTML5Translator

WRAPPER_CLASS = "pecot-table-scroll"
# caption の無い表の region の名前。名前の無い region は、区画として読み上げられない。
DEFAULT_LABEL = "表"


def table_label(node: nodes.table) -> str:
    """包みの aria-label。表の caption（title）があればその文字、無ければ「表」。"""
    for child in node.children:
        if isinstance(child, nodes.title):
            text = child.astext().strip()
            if text:
                return text
    return DEFAULT_LABEL


class TableScrollTranslator(HTML5Translator):
    """表を、キーボードでも横に送れる region の div で包む。"""

    def visit_table(self, node: nodes.table) -> None:
        label = self.attval(table_label(node))
        self.body.append(
            f'<div class="{WRAPPER_CLASS}" role="region" tabindex="0" aria-label="{label}">\n'
        )
        super().visit_table(node)

    def depart_table(self, node: nodes.table) -> None:
        super().depart_table(node)
        self.body.append("</div>\n")


def setup(app: Sphinx) -> dict[str, Any]:
    app.set_translator("html", TableScrollTranslator, override=True)
    return {"parallel_read_safe": True, "parallel_write_safe": True}
