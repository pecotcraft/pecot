"""このリポの引き継ぎのワークフローが、配布する雛形の写しであることを確かめる。"""

from __future__ import annotations

import re
from pathlib import Path

import allure
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATE = "actions/templates/pecot-handoff.yml"
_COPY = ".github/workflows/pecot-handoff.yml"

# Dependabot は写しの action の版だけを上げ、雛形を上げない。版は比べない。
_ACTION_REF = re.compile(r"^(\s*(?:- )?uses: [^@\s]+)@.*$", re.MULTILINE)
_USES_LINE = re.compile(r"^\s*(?:- )?uses: (\S+)", re.MULTILINE)
_PINNED_USES = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")


def _masked(path: str) -> str:
    return _ACTION_REF.sub(r"\1@<ref>", (_REPO_ROOT / path).read_text(encoding="utf-8"))


@allure.title("引き継ぎのワークフローは、action の版を除いて雛形と一致する")
def test_workflow_is_a_copy_of_the_template() -> None:
    """`.github/workflows/pecot-handoff.yml` が、配布する雛形の写しであることのテストです。action の版を伏せた内容が、雛形と一致することを確認します。"""
    with allure.step("写しと雛形を、版を伏せて読む"):
        copy = _masked(_COPY)
        template = _masked(_TEMPLATE)
    with allure.step("写しが雛形と同じことを確かめる"):
        assert copy == template, (
            f"{_COPY} が雛形と違う。`cp {_TEMPLATE} {_COPY}` で写し直し、action の版だけを写しの版に戻す"
        )


@allure.title("{path} の action は、すべて 40 桁の SHA で固定する")
@pytest.mark.parametrize("path", [_COPY, _TEMPLATE])
def test_every_action_is_pinned_to_a_full_sha(path: str) -> None:
    """ワークフローの写しと雛形の、`uses:` の行のテストです。`uses:` の行が 1 件以上あり、すべての action が 40 桁の SHA で固定されていることを確認します。"""
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
