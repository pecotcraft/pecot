"""このリポの github-ops のワークフローが、配布する雛形の写しであることを確かめる。"""

from __future__ import annotations

import re
from pathlib import Path

import allure
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATE = "actions/templates/pecot-github-ops.yml"
_COPY = ".github/workflows/pecot-github-ops.yml"

# Dependabot は写しの action の版だけを上げ、雛形を上げない。版は比べない。
_ACTION_REF = re.compile(r"^(\s*(?:- )?uses: [^@\s]+)@.*$", re.MULTILINE)
# 写しは同じリポの pecot の action を `./actions/<処理>` で呼ぶ。雛形の `pecotcraft/pecot/actions/<処理>@<ref>` に読み替えて比べる
_LOCAL_ACTION = re.compile(r"^(\s*(?:- )?uses: )\./actions/([a-z-]+)$", re.MULTILINE)
_USES_LINE = re.compile(r"^\s*(?:- )?uses: (\S+)(.*)$", re.MULTILINE)
_PINNED_USES = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
_TEMPLATE_PECOT_ACTION = re.compile(
    r"^pecotcraft/pecot/actions/[a-z-]+@pecot-actions/v\d+\.\d+\.\d+$"
)


def _mask_refs(text: str) -> str:
    return _ACTION_REF.sub(r"\1@<ref>", text)


def _to_template_uses(text: str) -> str:
    return _LOCAL_ACTION.sub(r"\1pecotcraft/pecot/actions/\2@<ref>", text)


def _masked(path: str) -> str:
    return _to_template_uses(_mask_refs((_REPO_ROOT / path).read_text(encoding="utf-8")))


@allure.title("action の行は、@ の後ろの版だけを伏せ字にする")
def test_ignores_only_the_ref_of_an_action() -> None:
    """雛形との比較で使う、action の版を伏せる関数（`_mask_refs`）のテストです。`uses:` の行の `@` 以降だけが `<ref>` に置き換わり、`run:` の行は変わらないことを確認します。"""
    with allure.step("action の行の版の部分を伏せる"):
        line = "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
        dashed = "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"
        run = "        run: echo uses: x@y\n"
        masked_line = _mask_refs(line)
        masked_dashed = _mask_refs(dashed)
        masked_run = _mask_refs(run)
    with allure.step("版だけが伏せられ、run の行は変わらないことを確かめる"):
        assert masked_line == "        uses: actions/checkout@<ref>\n"
        assert masked_dashed == "      - uses: actions/checkout@<ref>\n"
        assert masked_run == run


@allure.title("同じリポの pecot の action の行は、雛形の pecot の action の行に読み替える")
def test_reads_a_local_pecot_action_as_the_one_of_the_template() -> None:
    """雛形との比較で使う、pecot の action の参照を読み替える関数（`_to_template_uses`）のテストです。`./actions/github-ops` の行が、雛形の形の `pecotcraft/pecot/actions/github-ops@<ref>` になることを確認します。"""
    with allure.step("同じリポの pecot の action の行を、雛形の形に読み替える"):
        read = _to_template_uses("        uses: ./actions/github-ops\n")
    with allure.step("雛形の pecot の action の行になることを確かめる"):
        assert read == "        uses: pecotcraft/pecot/actions/github-ops@<ref>\n"


@allure.title("github-ops のワークフローは、action の版を除いて雛形と一致する")
def test_workflow_is_a_copy_of_the_template() -> None:
    """`.github/workflows/pecot-github-ops.yml` が、配布する雛形の写しであることのテストです。action の版を伏せ、pecot の action の参照を雛形の形に読み替えた内容が、雛形と一致することを確認します。"""
    with allure.step("写しと雛形を、版を伏せて読む"):
        copy = _masked(_COPY)
        template = _masked(_TEMPLATE)
    with allure.step("写しが雛形と同じことを確かめる"):
        assert copy == template, (
            f"{_COPY} が雛形と違う。`cp {_TEMPLATE} {_COPY}` で写し直し、pecot の action を `./actions/<処理>` に替える"
        )


@allure.title("{path} は、npm のパッケージを呼ぶ step を持たない")
@pytest.mark.parametrize("path", [_COPY, _TEMPLATE])
def test_no_step_runs_the_npm_package(path: str) -> None:
    """ワークフローの写しと雛形で、pecot の処理の呼び方のテストです。`@pecot/workflow-mcp` を npx で呼ぶ行が存在しないことを確認します。"""
    with allure.step("ワークフローを読む"):
        text = (_REPO_ROOT / path).read_text(encoding="utf-8")
    with allure.step("npm の package を呼ぶ行が無いことを確かめる"):
        assert "@pecot/workflow-mcp" not in text


@allure.title("{path} は pecot の action を呼び、ほかの action を 40 桁の SHA で固定する")
@pytest.mark.parametrize(
    ("path", "pecot_action"),
    [(_COPY, re.compile(r"^\./actions/[a-z-]+$")), (_TEMPLATE, _TEMPLATE_PECOT_ACTION)],
)
def test_every_action_is_pinned(path: str, pecot_action: re.Pattern[str]) -> None:
    """ワークフローの写しと雛形の、`uses:` の行のテストです。pecot の action を呼ぶ行があり、ほかの action がすべて 40 桁の SHA で固定されていることを確認します。"""
    with allure.step("ワークフローの uses の行を集める"):
        text = (_REPO_ROOT / path).read_text(encoding="utf-8")
        uses = [match[0] for match in _USES_LINE.findall(text)]
    with allure.step(
        "pecot の action を呼び、ほかの action が 40 桁の SHA で固定されていることを確かめる"
    ):
        assert uses, (
            f"{path} に `uses:` の行が無い。正規表現 _USES_LINE が当たらなくなっていないか確かめる"
        )
        assert any(pecot_action.match(u) for u in uses), f"{path} が pecot の action を呼んでいない"
        unpinned = [u for u in uses if not (_PINNED_USES.match(u) or pecot_action.match(u))]
        assert not unpinned, (
            f"{path} の action が 40 桁の SHA で固定されていない: {unpinned}。`owner/repo@<40 桁の hex>` にそろえる"
        )
