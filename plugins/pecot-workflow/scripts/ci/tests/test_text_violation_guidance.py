from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SKILLS_ROOT = PLUGIN_ROOT / "skills"

SKILLS = ["w-pr", "w-ready", "w-quick", "w-backlog", "w-revise", "w-merge"]
VIOLATION_MARKER = "[text-lint] Writing-rule violations in"
NOT_CHECKED_MARKER = "[text-lint] Not checked"
RULES_UNCHANGED_MARKER = "規則・除外は変えない"


def _read_skill(name: str) -> str:
    return (SKILLS_ROOT / name / "SKILL.md").read_text(encoding="utf-8")


def _guidance_paragraph(text: str) -> str:
    """VIOLATION_MARKER を含む行を中心に、前後の空行までの連続行を切り出す。"""
    lines = text.splitlines()
    hits = [index for index, line in enumerate(lines) if VIOLATION_MARKER in line]
    assert hits, f"目印 {VIOLATION_MARKER} を含む行が存在しない"
    start = hits[0]
    while start > 0 and lines[start - 1].strip():
        start -= 1
    end = hits[0]
    while end + 1 < len(lines) and lines[end + 1].strip():
        end += 1
    return "\n".join(lines[start : end + 1])


@pytest.mark.parametrize("skill_name", SKILLS)
def test_paragraph_has_all_markers(skill_name: str) -> None:
    paragraph = _guidance_paragraph(_read_skill(skill_name))

    assert VIOLATION_MARKER in paragraph
    assert NOT_CHECKED_MARKER in paragraph
    assert RULES_UNCHANGED_MARKER in paragraph


def test_paragraph_is_identical_across_skills() -> None:
    paragraphs = {name: _guidance_paragraph(_read_skill(name)) for name in SKILLS}
    reference = paragraphs[SKILLS[0]]

    for name, paragraph in paragraphs.items():
        assert paragraph == reference, f"{name} の段落が {SKILLS[0]} と異なる"
