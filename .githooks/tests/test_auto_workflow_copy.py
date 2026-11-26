"""このリポの自動処理のワークフローが、配布する雛形の写しであることを確かめる。"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATE = "plugins/pecot-workflow/cli/templates/workflow/pecot-auto.yml"
_COPY = ".github/workflows/pecot-auto.yml"

# Dependabot は写しの action の版だけを上げ、雛形を上げない。版は比べない。
_ACTION_REF = re.compile(r"^(\s*(?:- )?uses: [^@\s]+)@.*$", re.MULTILINE)
# 写しは main の開発版（@next）を、雛形は最新の正式版（@latest）を取る。dist-tag だけは比べない。
_NPX_TAG = re.compile(r"(@pecot/workflow-mcp)@[^\s]+")
_NPX_COMMAND = re.compile(r"@pecot/workflow-mcp@(\S+) auto (\S+)")
_USES_LINE = re.compile(r"^\s*(?:- )?uses: (\S+)", re.MULTILINE)
_PINNED_USES = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")


def _mask_refs(text: str) -> str:
    return _ACTION_REF.sub(r"\1@<ref>", text)


def _mask_npx_tag(text: str) -> str:
    return _NPX_TAG.sub(r"\1@<tag>", text)


def _masked(path: str) -> str:
    return _mask_npx_tag(_mask_refs((_REPO_ROOT / path).read_text(encoding="utf-8")))


def test_ignores_only_the_ref_of_an_action() -> None:
    line = "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
    assert _mask_refs(line) == "        uses: actions/checkout@<ref>\n"
    run = '          npx -y --prefix=/ @pecot/workflow-mcp@next auto gate "$@"\n'
    assert _mask_refs(run) == run


def test_ignores_only_the_dist_tag_of_the_npx_package() -> None:
    run = '          npx -y --prefix=/ @pecot/workflow-mcp@next auto gate "$@"\n'
    assert (
        _mask_npx_tag(run)
        == '          npx -y --prefix=/ @pecot/workflow-mcp@<tag> auto gate "$@"\n'
    )
    uses = "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"
    assert _mask_npx_tag(uses) == uses


def test_workflow_is_a_copy_of_the_template() -> None:
    assert _masked(_COPY) == _masked(_TEMPLATE), (
        f"{_COPY} が雛形と違う。`pecot workflow install auto --force` で写し直し、実行の行の @latest を @next に替える"
    )


@pytest.mark.parametrize(
    ("path", "tag"),
    [(_COPY, "next"), (_TEMPLATE, "latest")],
)
def test_npx_takes_the_expected_dist_tag(path: str, tag: str) -> None:
    text = (_REPO_ROOT / path).read_text(encoding="utf-8")
    commands = _NPX_COMMAND.findall(text)
    assert len(_NPX_TAG.findall(text)) == len(commands), f"{path} に auto を打たない npx の行がある"
    assert commands == [(tag, "gate"), (tag, "finish"), (tag, "finish")], (
        f"{path} の npx の行は gate・run・setup の 3 つで、どれも @{tag} を取る"
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
