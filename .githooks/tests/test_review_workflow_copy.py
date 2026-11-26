"""このリポの自動レビューのワークフローが、配布する雛形の写しであることを確かめる。"""

from __future__ import annotations

import re
from pathlib import Path

import allure
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATE = "actions/templates/pecot-review.yml"
_COPY = ".github/workflows/pecot-review.yml"

# Dependabot は写しの action の版だけを上げ、雛形を上げない。版は比べない。
_ACTION_REF = re.compile(r"^(\s*(?:- )?uses: [^@\s]+)@.*$", re.MULTILINE)
# 写しは、既定のブランチを .pecot-actions に置き、そこの action を呼ぶ。雛形の `pecotcraft/pecot/actions/<処理>@<ref>` に読み替えて比べる
_LOCAL_ACTION = re.compile(
    r"^(\s*(?:- )?uses: )\./\.pecot-actions/actions/([a-z-]+)$", re.MULTILINE
)
# このリポだけの step。前のコメントの行から空行の前までを比べない
_LOCAL_STEP = re.compile(
    r"^      # [^\n]*\n      - name: Check out the pecot actions\n(?:        [^\n]*\n)+\n",
    re.MULTILINE,
)
_USES_LINE = re.compile(r"^\s*(?:- )?uses: (\S+)(.*)$", re.MULTILINE)
_PINNED_USES = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
_TEMPLATE_PECOT_ACTION = re.compile(
    r"^pecotcraft/pecot/actions/[a-z-]+@pecot-actions/v\d+\.\d+\.\d+$"
)


def _masked(path: str) -> str:
    text = (_REPO_ROOT / path).read_text(encoding="utf-8")
    return _LOCAL_ACTION.sub(
        r"\1pecotcraft/pecot/actions/\2@<ref>",
        _ACTION_REF.sub(r"\1@<ref>", _LOCAL_STEP.sub("", text)),
    )


@allure.title("自動レビューのワークフローは、版とこのリポだけの step を除いて雛形と一致する")
def test_workflow_is_a_copy_of_the_template() -> None:
    """`.github/workflows/pecot-review.yml` と配布する雛形を比較するテストです。action の版と、このリポだけの checkout の step を除いた内容が、雛形と一致することを確認します。"""
    with allure.step("写しと雛形を、版とこのリポだけの step を伏せて読む"):
        copy = _masked(_COPY)
        template = _masked(_TEMPLATE)
    with allure.step("写しが雛形と同じことを確かめる"):
        assert copy == template, (
            f"{_COPY} が雛形と違う。`cp {_TEMPLATE} {_COPY}` で写し直し、"
            "pecot の action を `./.pecot-actions/actions/<処理>` に替え、Finish の前に Check out the pecot actions の step を足す"
        )


@allure.title("写しは、既定のブランチを別のパスに checkout して pecot の action を呼ぶ")
def test_copy_checks_out_the_default_branch_for_the_pecot_actions() -> None:
    """このリポの自動レビューのワークフローで、後始末の action の呼び方のテストです。既定のブランチを `.pecot-actions` に checkout し、そこの `review-finish` を呼ぶことを確認します。"""
    with allure.step("写しから Check out the pecot actions の step を探す"):
        text = (_REPO_ROOT / _COPY).read_text(encoding="utf-8")
        step = _LOCAL_STEP.search(text)
    with allure.step("既定のブランチを .pecot-actions に置き、そこの action を呼ぶことを確かめる"):
        assert step is not None, f"{_COPY} に Check out the pecot actions の step が無い"
        assert "ref: ${{ github.event.repository.default_branch }}" in step[0]
        assert "path: .pecot-actions" in step[0]
        assert "uses: ./.pecot-actions/actions/review-finish" in text


@allure.title("{path} は、npm のパッケージを呼ぶ step を持たない")
@pytest.mark.parametrize("path", [_COPY, _TEMPLATE])
def test_no_step_runs_the_npm_package(path: str) -> None:
    """自動レビューのワークフローとその雛形で、pecot の処理の呼び方のテストです。`@pecot/workflow-mcp` を npx で呼ぶ行が存在しないことを確認します。"""
    with allure.step("ワークフローを読む"):
        text = (_REPO_ROOT / path).read_text(encoding="utf-8")
    with allure.step("npm の package を呼ぶ行が無いことを確かめる"):
        assert "@pecot/workflow-mcp" not in text


@allure.title("{path} は pecot の action を呼び、ほかの action を 40 桁の SHA で固定する")
@pytest.mark.parametrize(
    ("path", "pecot_action"),
    [
        (_COPY, re.compile(r"^\./\.pecot-actions/actions/[a-z-]+$")),
        (_TEMPLATE, _TEMPLATE_PECOT_ACTION),
    ],
)
def test_every_action_is_pinned(path: str, pecot_action: re.Pattern[str]) -> None:
    """自動レビューのワークフローとその雛形の、`uses:` の行のテストです。pecot の action を呼ぶ行があり、ほかの action がすべて 40 桁の SHA で固定されていることを確認します。"""
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
