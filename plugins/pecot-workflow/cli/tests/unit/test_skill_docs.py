import re
from pathlib import Path

SKILLS_ROOT = Path(__file__).resolve().parents[3] / "skills"
HOOKS_ROOT = Path(__file__).resolve().parents[3] / "hooks"
# pecot CLI は `pecot` で直接打つ。ランチャー変数（PECOT=... / $PECOT）は置かない
LAUNCHER_PATTERN = re.compile(r"\$\{?PECOT\}?(?![A-Za-z0-9_])|^\s*PECOT=", re.MULTILINE)


def test_skills_root_has_skill_files() -> None:
    # 走査対象が空だと以降のテストが検知なしで通るため、パス解決を固定する
    assert any(SKILLS_ROOT.glob("*/SKILL.md")), SKILLS_ROOT


def test_skill_docs_do_not_use_claude_only_pecot_launcher() -> None:
    offenders = [
        path.relative_to(SKILLS_ROOT).as_posix()
        for path in sorted(SKILLS_ROOT.rglob("*.md"))
        if "${CLAUDE_PLUGIN_ROOT}/bin/pecot" in path.read_text()
    ]

    assert offenders == []


def test_skills_and_hooks_do_not_use_pecot_launcher_variable() -> None:
    paths = [*sorted(SKILLS_ROOT.rglob("*.md")), *sorted((HOOKS_ROOT / "templates").glob("*.md"))]
    offenders = [path.as_posix() for path in paths if LAUNCHER_PATTERN.search(path.read_text())]

    assert offenders == []
