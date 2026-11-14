"""このリポの board sync のワークフローが、配布する雛形の写しであることを確かめる。"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATE = "plugins/pecot-workflow/cli/templates/workflow/pecot-board-sync.yml"
_COPY = ".github/workflows/pecot-board-sync.yml"

# Dependabot は写しの action の版だけを上げ、雛形を上げない。版は比べない。
_ACTION_REF = re.compile(r"^(\s*uses: [^@\s]+)@.*$", re.MULTILINE)


def _without_action_refs(path: str) -> str:
    return _ACTION_REF.sub(r"\1@<ref>", (_REPO_ROOT / path).read_text(encoding="utf-8"))


def test_ignores_only_the_ref_of_an_action() -> None:
    line = "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
    assert _ACTION_REF.sub(r"\1@<ref>", line) == "        uses: actions/checkout@<ref>\n"
    run = "        run: npx -y --prefix=/ @pecot/workflow-mcp@5 board sync\n"
    assert _ACTION_REF.sub(r"\1@<ref>", run) == run


def test_workflow_is_a_copy_of_the_template() -> None:
    assert _without_action_refs(_COPY) == _without_action_refs(_TEMPLATE), (
        f"{_COPY} が雛形と違う。`cp {_TEMPLATE} {_COPY}` で写し直す"
    )
