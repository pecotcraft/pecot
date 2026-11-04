"""エージェント定義ファイル（plugins/pecot-workflow/agents/*.md）の frontmatter 検証
（test_agent_definitions.bats 移植）。

model フィールドが正しく設定されていることを確認する。frontmatter の model 値抽出は
bats の get_model（awk）と同じロジックを Python で再現する。
あわせて、pecot-workflow / pecot-visual のスキル・エージェント定義の型と内容を固定する（#1231）。
固定する項目は、disallowedTools・argument-hint・when_to_use・disable-model-invocation。
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml


@pytest.fixture
def agents_dir(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "agents"


def _get_model(file: Path) -> str | None:
    """frontmatter（先頭の ---〜--- ブロック）から model: の値を取得する。

    bats の get_model（awk '/^---$/{c++} c==1 && /^model:/...'）相当。
    frontmatter 内に model 行が無ければ None を返す。
    """
    in_frontmatter = 0
    for raw in file.read_text().splitlines():
        if raw == "---":
            in_frontmatter += 1
            continue
        if in_frontmatter == 1 and raw.startswith("model:"):
            return raw[len("model:") :].strip()
    return None


# エージェントファイル存在確認。


def test_a_implementer_exists(agents_dir: Path) -> None:
    assert (agents_dir / "w-implementer.md").is_file()


def test_a_tech_advisor_exists(agents_dir: Path) -> None:
    assert (agents_dir / "w-tech-advisor.md").is_file()


def test_a_worker_removed(agents_dir: Path) -> None:
    """w-worker.md は削除済み（main が pecot CLI を直接実行する構成に集約）。"""
    assert not (agents_dir / "w-worker.md").exists()


def test_a_e2e_planner_exists(agents_dir: Path) -> None:
    assert (agents_dir / "w-e2e-planner.md").is_file()


def test_a_e2e_tester_removed(agents_dir: Path) -> None:
    """w-e2e-tester.md は削除済み（w-e2e-planner に統合）。"""
    assert not (agents_dir / "w-e2e-tester.md").exists()


# model フィールドの存在確認。


@pytest.mark.parametrize(
    "agent",
    ["w-implementer", "w-tech-advisor", "w-e2e-planner"],
)
def test_agent_has_model_field(agents_dir: Path, agent: str) -> None:
    model = _get_model(agents_dir / f"{agent}.md")
    assert model is not None
    assert model != ""


# model 値の確認。


@pytest.mark.parametrize(
    ("agent", "expected_model"),
    [
        ("w-implementer", "sonnet"),
        ("w-tech-advisor", "inherit"),
        ("w-e2e-planner", "inherit"),
    ],
)
def test_agent_model_value(agents_dir: Path, agent: str, expected_model: str) -> None:
    assert _get_model(agents_dir / f"{agent}.md") == expected_model


# 本文の規則固定。


def test_a_implementer_forbids_cross_repo_edit(agents_dir: Path) -> None:
    """越境ガード（#951）: 判定手段・パッチ退避・定義元参照が本文に残ることを固定する。"""
    body = (agents_dir / "w-implementer.md").read_text()
    assert ".pecot/state/.pecot-active" in body
    assert "越境" in body
    assert ".pecot/work/<Issue番号>/<slug>.patch" in body
    assert "issue-flow-rules.md §6" in body


# スキル・エージェント定義の型と内容（#1231）。
# `claude plugin validate --strict` は、未知キー・disallowedTools の不正なツール名・argument-hint の型誤りを検出しない。
# Copilot CLI は `argument-hint: [x]`（YAML ではリスト）でスキルの読み込みに失敗する。
# そのため、frontmatter を yaml.safe_load で読んで、型と値を固定する。

# description と when_to_use を合わせた上限（Claude Code のスキル一覧に載る文字数）。
# 結合時に区切りが 3 文字入る。
_LISTING_LIMIT = 1536
_WHEN_TO_USE_LIMIT = 80

# サブエージェントから Claude Code が常に外すツール（AskUserQuestion / EnterPlanMode /
# ExitPlanMode）の除外は Claude では効果が無い。上流の挙動が変わったときの備えとして書き残す。
_EXPECTED_DISALLOWED_TOOLS = {
    ("pecot-workflow", "w-implementer"): [
        "Agent",
        "EnterPlanMode",
        "ExitPlanMode",
        "AskUserQuestion",
        "Monitor",
    ],
    ("pecot-workflow", "w-tech-advisor"): [
        "Edit",
        "Write",
        "NotebookEdit",
        "Agent",
        "EnterPlanMode",
        "ExitPlanMode",
        "AskUserQuestion",
        "Monitor",
    ],
    ("pecot-workflow", "w-e2e-planner"): ["AskUserQuestion", "Monitor"],
    ("pecot-visual", "v-diagram-creator"): [
        "Agent",
        "WebSearch",
        "WebFetch",
        "EnterPlanMode",
        "ExitPlanMode",
        "AskUserQuestion",
    ],
    ("pecot-visual", "v-slide-creator"): [
        "Agent",
        "WebSearch",
        "WebFetch",
        "Bash",
        "PowerShell",
        "EnterPlanMode",
        "ExitPlanMode",
        "AskUserQuestion",
    ],
}

_EXPECTED_SKILLS = {
    ("pecot-workflow", name)
    for name in (
        "w-active w-backlog w-breakdown w-help w-issueize w-merge w-onboarding w-pr w-quick "
        "w-ready w-release w-repo-add w-revise w-worktree-add w-worktree-remove"
    ).split()
} | {("pecot-visual", name) for name in ("v-drawio", "v-evidence", "v-slidev")}

# 利用者が渡さないと始まらないスキルだけに付ける。対象をボード・会話・現在のブランチから
# 自分で見つけるスキル（w-active・w-merge・w-breakdown・w-issueize など）は引数不要なので付けない。
_EXPECTED_ARGUMENT_HINTS = {
    "w-backlog": "[Epic の内容]",
    "w-quick": "[タスクの内容]",
    "w-worktree-remove": "[WT 名]",
    "v-drawio": "[図の内容]",
    "v-evidence": "[画像のパス]",
    "v-slidev": "[スライドの内容 または 既存デッキのパス]",
}

_PLUGINS = ("pecot-workflow", "pecot-visual")


def _frontmatter(file: Path) -> dict:
    """先頭の ---〜--- ブロックを yaml.safe_load で読む。"""
    text = file.read_text()
    lines = text.splitlines()
    assert lines and lines[0] == "---", f"{file}: frontmatter が無い"
    assert "---" in lines[1:], f"{file}: frontmatter の閉じの --- が無い"
    end = lines.index("---", 1)
    try:
        data = yaml.safe_load("\n".join(lines[1:end]))
    except yaml.YAMLError as e:
        pytest.fail(f"{file}: frontmatter が YAML として読めない: {e}")
    assert isinstance(data, dict), f"{file}: frontmatter がマッピングではない"
    return data


def _skill_files(project_root: Path) -> dict[tuple[str, str], Path]:
    return {
        (plugin, f.parent.name): f
        for plugin in _PLUGINS
        for f in sorted((project_root / "plugins" / plugin / "skills").glob("*/SKILL.md"))
    }


def _agent_files(project_root: Path) -> dict[tuple[str, str], Path]:
    return {
        (plugin, f.stem): f
        for plugin in _PLUGINS
        for f in sorted((project_root / "plugins" / plugin / "agents").glob("*.md"))
    }


def test_agent_set_is_expected(project_root: Path) -> None:
    assert set(_agent_files(project_root)) == set(_EXPECTED_DISALLOWED_TOOLS)


@pytest.mark.parametrize(("plugin", "agent"), sorted(_EXPECTED_DISALLOWED_TOOLS))
def test_agent_disallowed_tools(project_root: Path, plugin: str, agent: str) -> None:
    """除外型の disallowedTools が YAML リストで、期待どおりに完全一致する。"""
    fm = _frontmatter(_agent_files(project_root)[(plugin, agent)])
    assert fm.get("disallowedTools") == _EXPECTED_DISALLOWED_TOOLS[(plugin, agent)]


# サブエージェントが自分の文脈を compact するトークン数。main から継ぐ窓（既定 1M）を下げる。
# Claude Code は 100000〜1000000 の整数だけを受け付け、範囲外は警告して無視する（#1362）。
# 技術調査と CUJ の実行は大きい入力を読むので、w-tech-advisor と w-e2e-planner は広く取る。
_EXPECTED_AUTO_COMPACT_WINDOW = {
    ("pecot-workflow", "w-implementer"): 300000,
    ("pecot-workflow", "w-tech-advisor"): 400000,
    ("pecot-workflow", "w-e2e-planner"): 400000,
    ("pecot-visual", "v-diagram-creator"): 200000,
    ("pecot-visual", "v-slide-creator"): 200000,
}


@pytest.mark.parametrize(("plugin", "agent"), sorted(_EXPECTED_DISALLOWED_TOOLS))
def test_agent_auto_compact_window(project_root: Path, plugin: str, agent: str) -> None:
    """全 agent が int の autoCompactWindow を持ち、値が期待どおりに一致する。"""
    fm = _frontmatter(_agent_files(project_root)[(plugin, agent)])
    value = fm.get("autoCompactWindow")
    assert type(value) is int, f"{agent}: autoCompactWindow が int ではない"
    assert value == _EXPECTED_AUTO_COMPACT_WINDOW[(plugin, agent)]


def test_skill_set_is_expected(project_root: Path) -> None:
    assert set(_skill_files(project_root)) == _EXPECTED_SKILLS


def test_no_skill_disables_model_invocation(project_root: Path) -> None:
    """どのスキルにも disable-model-invocation を付けない（自然文の依頼で起動できなくなる）。"""
    offenders = [
        name
        for name, f in _skill_files(project_root).items()
        if "disable-model-invocation" in _frontmatter(f)
    ]
    assert offenders == []


def test_skill_when_to_use_is_short_string_within_listing_limit(project_root: Path) -> None:
    for name, f in _skill_files(project_root).items():
        fm = _frontmatter(f)
        when_to_use = fm.get("when_to_use")
        assert isinstance(when_to_use, str), f"{name}: when_to_use が str ではない"
        assert 0 < len(when_to_use) <= _WHEN_TO_USE_LIMIT, f"{name}: when_to_use が長さ制限外"
        description = fm.get("description")
        assert isinstance(description, str), f"{name}: description が str ではない"
        total = len(description) + 3 + len(when_to_use)
        assert total <= _LISTING_LIMIT, f"{name}: description + when_to_use が {total} 文字"


def test_skill_argument_hint_set_and_type(project_root: Path) -> None:
    """argument-hint を持つスキルの集合と値を固定する。値は str（YAML でリストにならない）。"""
    hints = {
        name: fm["argument-hint"]
        for (_, name), f in _skill_files(project_root).items()
        if "argument-hint" in (fm := _frontmatter(f))
    }
    assert hints == _EXPECTED_ARGUMENT_HINTS
    assert all(isinstance(v, str) for v in hints.values())
