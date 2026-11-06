"""tests/unit/test_template_rules.py - テンプレの形と、冒頭のコメントの例を確かめる。

`--prepare` が配る 12 テンプレ（issue 5 種 / comment 5 種 / pr 2 種）は、冒頭のコメントに
「読者:」と、本文の手本の「例:」を持つ。CLI が投稿時に弾く記法は、テンプレに規則として書かない。

次を固定する。

1. 見出しの横にサマリを書く形は issue と comment のテンプレ（plan・task-implement を除く）で、PR・plan・task-implement は見出しの名前だけ。
2. 各テンプレの「例:」は、そのテンプレで投稿したときの CLI の検証を通る。
3. plan テンプレの見出し・折りたたみの区分・Files の書き方・CUJ の規則が雛形にある。
4. PR テンプレの Changes には、振る舞いの変化を書く。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from cli.core.sections import (
    PLAN_FOLD_SUMMARY,
    extract_sections_from_template,
    validate_body_style,
    validate_closed_headings,
    validate_fold_balance,
    validate_fold_summaries,
    validate_heading_summaries,
    validate_sections,
)

CLI_ROOT = Path(__file__).resolve().parents[2]
TEMPLATES_ROOT = CLI_ROOT / "templates"

TEMPLATE_PATHS = sorted(
    path for kind in ("issue", "comment", "pr") for path in (TEMPLATES_ROOT / kind).glob("*.md")
)

PLAN_TEMPLATE = TEMPLATES_ROOT / "comment" / "plan.md"
PR_CREATE_TEMPLATE = TEMPLATES_ROOT / "pr" / "create.md"

# 見出しの名前だけを使うテンプレ（全文を読む PR、本文に要約を書いて折りたたむ plan、tasks.md を写す task-implement）
NAME_ONLY_TEMPLATES = (
    PR_CREATE_TEMPLATE,
    TEMPLATES_ROOT / "pr" / "release.md",
    PLAN_TEMPLATE,
    TEMPLATES_ROOT / "issue" / "task-implement.md",
)


def _template_id(path: Path) -> str:
    return f"{path.parent.name}/{path.name}"


def _comment(template: Path) -> str:
    match = re.search(r"<!--\n(.*?)\n-->", template.read_text(encoding="utf-8"), re.DOTALL)
    assert match, f"{template.name}: 冒頭コメントがありません"
    return match.group(1)


def _example(template: Path) -> str:
    """冒頭のコメントの「例:」より後ろの本文"""
    parts = _comment(template).split("\n例:\n", 1)
    assert len(parts) == 2, f"{template.name}: 「例:」がありません"
    return parts[1]


def _writing_rules(template: Path) -> str:
    """冒頭のコメントの「書き方:」の本文。無ければ空"""
    pattern = r"^書き方:\n" r"(.*?)(?=^" r"フィールド:|^" r"例:|\Z)"
    block = re.search(pattern, _comment(template), re.DOTALL | re.MULTILINE)
    return block.group(1) if block else ""


def _body(template: Path) -> str:
    return template.read_text(encoding="utf-8").split("\n-->\n", 1)[1]


def test_twelve_templates_are_covered() -> None:
    """issue 5 種 / comment 5 種 / pr 2 種がそろっている"""
    assert len(TEMPLATE_PATHS) == 12


@pytest.mark.parametrize("template", TEMPLATE_PATHS, ids=_template_id)
def test_comment_has_reader_and_example(template: Path) -> None:
    """冒頭のコメントに「読者:」と「例:」があり、例に見出しがある"""
    assert _comment(template).startswith("読者: ")
    assert re.search(r"^#{2,3} ", _example(template), re.MULTILINE)


@pytest.mark.parametrize("template", TEMPLATE_PATHS, ids=_template_id)
def test_heading_summary_is_used_only_outside_pr_and_plan(template: Path) -> None:
    """見出しの横のサマリ（`名前 — サマリ`）は、PR・plan・task-implement のテンプレでは使わない"""
    has_summary = re.search(r"^#{2,3} .+ — ", _body(template), re.MULTILINE) is not None

    assert has_summary is (template not in NAME_ONLY_TEMPLATES)


@pytest.mark.parametrize("template", TEMPLATE_PATHS, ids=_template_id)
def test_example_passes_the_validator(template: Path) -> None:
    """「例:」の本文は、そのテンプレで投稿したときの検証を通る"""
    example = _example(template)
    sections = extract_sections_from_template(template)

    assert validate_sections(example, sections) == []
    assert validate_heading_summaries(example, sections) == []
    assert validate_body_style(example) == []
    if template == PLAN_TEMPLATE:
        assert validate_closed_headings(example, sections) == []
        assert validate_fold_balance(example) == []
        assert validate_fold_summaries(example, PLAN_FOLD_SUMMARY) == []


PLAN_HEADINGS = (
    "## Plan",
    "### Context",
    "### Approach",
    "### Files",
    "### Notes",
    "## PECOT-Workflow",
    "### E2E",
)


def _plan_section(heading: str) -> list[str]:
    """plan テンプレの本文の見出しから、次の ## / ### 見出しの手前までの、空行を除いた行を返す"""
    body = _body(PLAN_TEMPLATE)
    start = body.index(f"\n{heading}\n") + 1
    rest = body[start:].split("\n", 1)[1]
    return [line for line in re.split(r"\n(?=#{2,3} )", rest)[0].split("\n") if line.strip()]


def test_plan_template_has_the_seven_headings_in_order() -> None:
    """plan テンプレの ## / ### 見出しは名前だけの 7 つで、順序は Plan 配下 4 つ、PECOT-Workflow 配下 1 つ"""
    headings = re.findall(r"^#{2,3} .*$", _body(PLAN_TEMPLATE), re.MULTILINE)

    assert tuple(headings) == PLAN_HEADINGS


def test_plan_fold_summaries_use_the_fixed_form() -> None:
    """plan テンプレの `<summary>` は全て PLAN_FOLD_SUMMARY の形"""
    lines = re.findall(r"^<summary.*$", _body(PLAN_TEMPLATE), re.MULTILINE)

    assert lines
    assert all(line == PLAN_FOLD_SUMMARY for line in lines), lines


@pytest.mark.parametrize("heading", ["### Approach", "### Files", "### Notes", "### E2E"])
def test_plan_sections_put_summary_outside_and_details_inside(heading: str) -> None:
    """要約を外に置き、末尾に `<details>` を 1 つ置く"""
    lines = _plan_section(heading)

    assert lines[0] != "<details>"
    assert lines.count("<details>") == 1
    assert lines[-1] == "</details>"


@pytest.mark.parametrize("heading", ["## Plan", "### Context", "## PECOT-Workflow"])
def test_plan_summary_only_sections_are_not_folded(heading: str) -> None:
    """Plan・Context・PECOT-Workflow は要約だけを置き、`<details>` を持たない"""
    lines = _plan_section(heading)

    assert lines
    assert "<details>" not in lines


def test_plan_template_states_how_to_write_files() -> None:
    """Files は外に触る代表ファイル、`<details>` の中にファイルごとのどう触るかを書く"""
    rules = _writing_rules(PLAN_TEMPLATE)

    assert "Files は、外に触る代表ファイルを並べ" in rules
    assert "ファイルごとのどう触るかを詳しく書く" in rules


def test_plan_template_states_the_standard_item_mapping() -> None:
    """Claude Code の plan mode の標準 5 項目の置き場を書く"""
    assert "標準 5 項目" in _writing_rules(PLAN_TEMPLATE)


def test_plan_template_states_cuj_definition() -> None:
    """CUJ の定義（3 要素と、CUJ にしないもの）が雛形にある"""
    rules = _writing_rules(PLAN_TEMPLATE)

    assert "CUJ = 利用者" in rules
    assert "「誰が・起点・観測結果」の 3 要素を必須とし" in rules
    assert "健全性確認のための dry-run は CUJ にしない" in rules


def test_plan_cuj_details_use_plain_dash_items() -> None:
    """E2E の詳細は「CUJ 1」の行の下に 誰が・起点・テスト手順・合格基準 を並べる"""
    lines = _plan_section("### E2E")

    start = lines.index("CUJ 1")
    for label in ("- 誰が — ", "- 起点 — ", "- テスト手順", "- 合格基準 — "):
        assert any(line.startswith(label) for line in lines[start:]), label


def test_pr_create_states_changes_and_closes_rules() -> None:
    """pr/create.md は、Changes に振る舞いの変化を書くことと、`Closes #` の番号を書く"""
    rules = _writing_rules(PR_CREATE_TEMPLATE)

    assert "Changes には振る舞いの変化を書く" in rules
    assert "どのファイル・関数をどう直したかは書かない" in rules
    assert "`Closes #` には sub-issue の番号だけを入れる" in rules
