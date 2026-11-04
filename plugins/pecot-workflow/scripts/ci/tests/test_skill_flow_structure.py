import re
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SKILLS_ROOT = PLUGIN_ROOT / "skills"

FINALIZE_MARKER = "計画最終化と承認の窓"
PARALLEL_SPAWN_NOTE = "1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。"
SERIAL_REASON_MARKER = "(直列の理由: ...)"
STEP_HEADING = re.compile(r"^###\s+Step\s+(\d+)\s*[:：]\s*(.+)$")


def _read_skill(name: str) -> str:
    return (SKILLS_ROOT / name / "SKILL.md").read_text(encoding="utf-8")


def _step_headings(text: str) -> list[tuple[int, str, int]]:
    """(step 番号, タイトル, 行インデックス) を出現順に返す。"""
    headings: list[tuple[int, str, int]] = []
    for line_index, line in enumerate(text.splitlines()):
        match = STEP_HEADING.match(line.strip())
        if match:
            headings.append((int(match.group(1)), match.group(2).strip(), line_index))
    return headings


def _title_index(headings: list[tuple[int, str, int]], keyword: str) -> int:
    """タイトルに keyword を含む Step の、出現順リスト上の位置を返す。"""
    for position, (_, title, _) in enumerate(headings):
        if keyword in title:
            return position
    raise AssertionError(f"タイトルに {repr(keyword)} を含む Step が存在しない: {headings}")


def _step_number_index(headings: list[tuple[int, str, int]], step_number: int) -> int:
    """Step 番号一致（部分一致でなく整数一致）で出現順リスト上の位置を返す。"""
    for position, (number, _, _) in enumerate(headings):
        if number == step_number:
            return position
    raise AssertionError(f"Step {step_number} が存在しない: {headings}")


def _section_body(text: str, heading_position: int) -> str:
    """出現順リスト上の heading_position の Step 本文を、行スライスで切り出す。

    終端は「次の Step 見出し」と「次の H2 見出し（``## ``）」のうち早い方。
    最後の Step の本文に後続の ``## 注意`` 等が混入するのを防ぐ。
    """
    lines = text.splitlines()
    heading_lines = [line_index for _, _, line_index in _step_headings(text)]
    start = heading_lines[heading_position]
    if heading_position + 1 < len(heading_lines):
        end = heading_lines[heading_position + 1]
    else:
        end = len(lines)
    for line_index in range(start + 1, end):
        if lines[line_index].startswith("## "):
            end = line_index
            break
    return "\n".join(lines[start:end])


@pytest.mark.parametrize("skill_name", ["w-active", "w-quick"])
def test_step_order_survey_then_draft_then_planmode(skill_name: str) -> None:
    headings = _step_headings(_read_skill(skill_name))
    survey = _title_index(headings, "調査")
    draft = _title_index(headings, "計画ドラフト")
    planmode = _title_index(headings, "プランモード")

    assert survey < draft < planmode


@pytest.mark.parametrize("skill_name", ["w-active", "w-quick"])
def test_survey_comes_after_branch_switch(skill_name: str) -> None:
    headings = _step_headings(_read_skill(skill_name))
    branch_switch = _title_index(headings, "ブランチ切り替え")
    survey = _title_index(headings, "調査")

    assert branch_switch < survey


@pytest.mark.parametrize("skill_name", ["w-active", "w-quick"])
def test_survey_step_keeps_normal_mode_guard(skill_name: str) -> None:
    text = _read_skill(skill_name)
    headings = _step_headings(text)
    body = _section_body(text, _title_index(headings, "調査"))

    assert "通常モードのまま" in body
    assert "EnterPlanMode を呼ばない" in body


@pytest.mark.parametrize("skill_name", ["w-active", "w-quick"])
def test_planmode_step_declares_finalize_window(skill_name: str) -> None:
    text = _read_skill(skill_name)
    headings = _step_headings(text)
    body = _section_body(text, _title_index(headings, "プランモード"))

    assert FINALIZE_MARKER in body


def test_a_active_review_between_draft_and_planmode() -> None:
    headings = _step_headings(_read_skill("w-active"))
    draft = _title_index(headings, "計画ドラフト")
    review = _title_index(headings, "レビュー")
    planmode = _title_index(headings, "プランモード")

    assert draft < review < planmode


def test_a_active_review_step_body_declares_single_round() -> None:
    text = _read_skill("w-active")
    headings = _step_headings(text)
    body = _section_body(text, _title_index(headings, "レビュー"))

    assert "w-tech-advisor" in body
    assert "w-e2e-planner" in body
    assert "一巡 1 回" in body
    assert "再レビューは不要" in body
    assert "EnterPlanMode を呼ばない" in body


def test_a_quick_has_no_review_step() -> None:
    headings = _step_headings(_read_skill("w-quick"))

    assert all("レビュー" not in title for _, title, _ in headings)


def test_a_quick_step1_guard_block_survives() -> None:
    text = _read_skill("w-quick")
    headings = _step_headings(text)
    body = _section_body(text, _step_number_index(headings, 1))
    guard_lines = [line for line in body.splitlines() if line.lstrip().startswith(">")]
    guard_text = "\n".join(guard_lines)

    assert guard_lines, "Step 1 に引用ブロックのガードが存在しない"
    assert "Issue 番号" in guard_text
    assert "EnterPlanMode" in guard_text


def test_a_revise_step5_parallel_default_with_serial_reason() -> None:
    text = _read_skill("w-revise")
    headings = _step_headings(text)
    body = _section_body(text, _step_number_index(headings, 5))

    assert "複数 w-implementer の並列起動を既定とする" in body
    assert SERIAL_REASON_MARKER in body
    assert PARALLEL_SPAWN_NOTE in body


def test_a_revise_step2_reviewers_spawn_in_parallel() -> None:
    text = _read_skill("w-revise")
    headings = _step_headings(text)
    body = _section_body(text, _step_number_index(headings, 2))

    assert "3 体の並列 spawn を既定とする" in body
    assert SERIAL_REASON_MARKER in body
    assert PARALLEL_SPAWN_NOTE in body
    for reviewer in ("w-tech-advisor", "w-e2e-planner", "w-implementer"):
        assert reviewer in body


def test_a_active_review_step_spawns_reviewers_in_parallel() -> None:
    text = _read_skill("w-active")
    headings = _step_headings(text)
    body = _section_body(text, _title_index(headings, "レビュー"))

    assert "2 者の並列 spawn を既定とする" in body
    assert SERIAL_REASON_MARKER in body
    assert PARALLEL_SPAWN_NOTE in body
    assert "spawn してよい" not in body


def test_a_revise_step6_bulk_resolve_uses_aliases() -> None:
    text = _read_skill("w-revise")
    headings = _step_headings(text)
    body = _section_body(text, _step_number_index(headings, 6))

    assert len(re.findall(r"\bt\d+:\s*resolveReviewThread", body)) >= 2
    assert "$threadId" not in body
