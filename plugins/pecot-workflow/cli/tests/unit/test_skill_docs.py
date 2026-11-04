import re
from collections.abc import Iterator
from pathlib import Path

SKILLS_ROOT = Path(__file__).resolve().parents[3] / "skills"
HOOKS_ROOT = Path(__file__).resolve().parents[3] / "hooks"
CLAUDE_LAUNCHER = "PECOT=pecot"
COPILOT_LAUNCHER = 'PECOT="$HOME/.copilot/installed-plugins/pecot/pecot-w/bin/pecot"'
AGENT_SKILL_EXCEPTIONS: set[str] = set()
COPILOT_LAUNCHER_PATTERN = re.compile(r'PECOT="\$HOME/\.copilot/installed-plugins/[^"]*"')


def _fenced_blocks(text: str) -> Iterator[tuple[str, list[str]]]:
    lines = text.splitlines()
    in_fence = False
    fence_info = ""
    body: list[str] = []

    for line in lines:
        stripped_line = line.lstrip()
        if stripped_line.startswith("```"):
            if in_fence:
                yield fence_info, body
                in_fence = False
                fence_info = ""
                body = []
            else:
                in_fence = True
                fence_info = stripped_line.removeprefix("```").strip()
                body = []
            continue

        if in_fence:
            body.append(line)


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


def test_agent_skill_entrypoints_define_pecot_launcher_inline() -> None:
    offenders = []

    for path in sorted(SKILLS_ROOT.glob("*/SKILL.md")):
        relative_path = path.relative_to(SKILLS_ROOT).as_posix()
        if relative_path in AGENT_SKILL_EXCEPTIONS:
            continue

        text = path.read_text()
        has_launcher = (
            "Claude Code:" in text
            and CLAUDE_LAUNCHER in text
            and "GitHub Copilot CLI" in text
            and COPILOT_LAUNCHER in text
            and "$PECOT ..." in text
        )
        if not has_launcher:
            offenders.append(relative_path)

    assert offenders == []


def test_agent_skill_command_blocks_use_pecot_launcher_variable() -> None:
    offenders = []

    for path in sorted(SKILLS_ROOT.glob("*/SKILL.md")):
        relative_path = path.relative_to(SKILLS_ROOT).as_posix()
        if relative_path in AGENT_SKILL_EXCEPTIONS:
            continue

        for _, block_lines in _fenced_blocks(path.read_text()):
            for line_number, line in enumerate(block_lines, start=1):
                if line.lstrip().startswith("pecot "):
                    offenders.append(f"{relative_path}: fenced command line {line_number}: {line}")

    assert offenders == []


def test_hooks_copilot_launchers_match_skill_launcher() -> None:
    found: list[tuple[str, str]] = []
    for path in sorted(HOOKS_ROOT.rglob("*.sh")):
        if "tests" in path.relative_to(HOOKS_ROOT).parts:
            continue
        for launcher in COPILOT_LAUNCHER_PATTERN.findall(path.read_text()):
            found.append((path.relative_to(HOOKS_ROOT).as_posix(), launcher))

    # 走査対象が 0 件だと検知なしで通るため、起動パスの形が見つかることを固定する
    assert found, HOOKS_ROOT
    offenders = [f"{rel}: {launcher}" for rel, launcher in found if launcher != COPILOT_LAUNCHER]
    assert offenders == []
