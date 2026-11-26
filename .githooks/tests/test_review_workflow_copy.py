"""このリポの 自動レビューのワークフローが、配布する雛形の写しであることを確かめる。"""

from __future__ import annotations

import re
from pathlib import Path

import allure
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATE = "plugins/pecot-workflow/cli/templates/workflow/pecot-review.yml"
_COPY = ".github/workflows/pecot-review.yml"

# Dependabot は写しの action の版だけを上げ、雛形を上げない。版は比べない。
_ACTION_REF = re.compile(r"^(\s*(?:- )?uses: [^@\s]+)@.*$", re.MULTILINE)
# 写しは main の開発版（@next）を、雛形は最新の正式版（@latest）を取る。dist-tag だけは比べない。
_NPX_TAG = re.compile(r"(@pecot/workflow-mcp)@[^\s]+")
_USES_LINE = re.compile(r"^\s*(?:- )?uses: (\S+)", re.MULTILINE)
_PINNED_USES = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")


def _mask_refs(text: str) -> str:
    return _ACTION_REF.sub(r"\1@<ref>", text)


def _mask_npx_tag(text: str) -> str:
    return _NPX_TAG.sub(r"\1@<tag>", text)


def _masked(path: str) -> str:
    return _mask_npx_tag(_mask_refs((_REPO_ROOT / path).read_text(encoding="utf-8")))


def test_ignores_only_the_ref_of_an_action() -> None:
    with allure.step("action の行の版の部分を伏せる"):
        line = "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
        dashed = "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"
        run = "        run: npx -y --prefix=/ @pecot/workflow-mcp@next review finish\n"
        masked_line = _mask_refs(line)
        masked_dashed = _mask_refs(dashed)
        masked_run = _mask_refs(run)
    with allure.step("版だけが伏せられ、run の行は変わらないことを確かめる"):
        assert masked_line == "        uses: actions/checkout@<ref>\n"
        assert masked_dashed == "      - uses: actions/checkout@<ref>\n"
        assert masked_run == run


def test_ignores_only_the_dist_tag_of_the_npx_package() -> None:
    with allure.step("npx の行の dist-tag の部分を伏せる"):
        run = "        run: npx -y --prefix=/ @pecot/workflow-mcp@next review finish\n"
        uses = "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"
        masked_run = _mask_npx_tag(run)
        masked_uses = _mask_npx_tag(uses)
    with allure.step("dist-tag だけが伏せられ、uses の行は変わらないことを確かめる"):
        assert (
            masked_run == "        run: npx -y --prefix=/ @pecot/workflow-mcp@<tag> review finish\n"
        )
        assert masked_uses == uses


def test_workflow_is_a_copy_of_the_template() -> None:
    with allure.step("写しと雛形を、版と dist-tag を伏せて読む"):
        copy = _masked(_COPY)
        template = _masked(_TEMPLATE)
    with allure.step("写しが雛形と同じことを確かめる"):
        assert copy == template, (
            f"{_COPY} が雛形と違う。`cp {_TEMPLATE} {_COPY}` で写し直し、実行の行の @latest を @next に替える"
        )


@pytest.mark.parametrize(
    ("path", "tag"),
    [(_COPY, "next"), (_TEMPLATE, "latest")],
)
def test_npx_takes_the_expected_dist_tag(path: str, tag: str) -> None:
    with allure.step("ワークフローを読む"):
        text = (_REPO_ROOT / path).read_text(encoding="utf-8")
    with allure.step("npx の行が 1 つで、dist-tag が期待どおりか確かめる"):
        assert _NPX_TAG.findall(text) == ["@pecot/workflow-mcp"], f"{path} の npx の行が 1 つでない"
        assert f"@pecot/workflow-mcp@{tag} review finish" in text, f"{path} は @{tag} を取る"


@pytest.mark.parametrize("path", [_COPY, _TEMPLATE])
def test_every_action_is_pinned_to_a_full_sha(path: str) -> None:
    with allure.step("ワークフローの uses の行を集める"):
        text = (_REPO_ROOT / path).read_text(encoding="utf-8")
        uses = _USES_LINE.findall(text)
    with allure.step("すべての action が 40 桁の SHA で固定されていることを確かめる"):
        assert uses, (
            f"{path} に `uses:` の行が無い。正規表現 _USES_LINE が当たらなくなっていないか確かめる"
        )
        unpinned = [u for u in uses if not _PINNED_USES.match(u)]
        assert not unpinned, (
            f"{path} の action が 40 桁の SHA で固定されていない: {unpinned}。`owner/repo@<40 桁の hex>` にそろえる"
        )
