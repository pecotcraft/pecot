"""このリポの board sync のワークフローが、配布する雛形の写しであることを確かめる。"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATE = "plugins/pecot-workflow/cli/templates/workflow/pecot-board-sync.yml"
_COPY = ".github/workflows/pecot-board-sync.yml"

# Dependabot は写しの action の版だけを上げ、雛形を上げない。版は比べない。
_ACTION_REF = re.compile(r"^(\s*(?:- )?uses: [^@\s]+)@.*$", re.MULTILINE)
_USES_LINE = re.compile(r"^\s*(?:- )?uses: (\S+)", re.MULTILINE)
_PINNED_USES = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")


def _mask_refs(text: str) -> str:
    return _ACTION_REF.sub(r"\1@<ref>", text)


def _without_action_refs(path: str) -> str:
    return _mask_refs((_REPO_ROOT / path).read_text(encoding="utf-8"))


def test_ignores_only_the_ref_of_an_action() -> None:
    line = "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
    assert _mask_refs(line) == "        uses: actions/checkout@<ref>\n"
    dashed = "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"
    assert _mask_refs(dashed) == "      - uses: actions/checkout@<ref>\n"
    run = "        run: npx -y --prefix=/ @pecot/workflow-mcp@5 board sync\n"
    assert _mask_refs(run) == run


def test_workflow_is_a_copy_of_the_template() -> None:
    assert _without_action_refs(_COPY) == _without_action_refs(_TEMPLATE), (
        f"{_COPY} が雛形と違う。`cp {_TEMPLATE} {_COPY}` で写し直す"
    )


@pytest.mark.parametrize("path", [_COPY, _TEMPLATE])
def test_every_action_is_pinned_to_a_full_sha(path: str) -> None:
    text = (_REPO_ROOT / path).read_text(encoding="utf-8")
    uses = _USES_LINE.findall(text)
    assert uses, (
        f"{path} に `uses:` の行が無い。正規表現 _USES_LINE が当たらなくなっていないか確かめる"
    )
    unpinned = [u for u in uses if not _PINNED_USES.match(u)]
    assert not unpinned, (
        f"{path} の action が 40 桁の SHA で固定されていない: {unpinned}。`owner/repo@<40 桁の hex>` にそろえる"
    )
