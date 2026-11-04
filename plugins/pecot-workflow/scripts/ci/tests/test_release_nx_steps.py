from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SKILLS_ROOT = PLUGIN_ROOT / "skills"
RELEASE_NX = SKILLS_ROOT / "w-release" / "references" / "release-nx.md"

_SINGLE_BRANCH_HEADING = "## 単一ブランチモード（develop == release）"
_STEP1_HEADING = "### 1."


def _section(text: str, heading: str, next_prefix: str) -> str:
    """heading で始まる行から、次の next_prefix 行の手前までを返す"""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(heading))
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith(next_prefix)),
        len(lines),
    )
    return "\n".join(lines[start:end])


def _code_block_lines(section: str) -> list[str]:
    lines: list[str] = []
    in_block = False
    for line in section.splitlines():
        if line.startswith("```"):
            in_block = not in_block
        elif in_block:
            lines.append(line)
    return lines


def test_single_branch_step1_runs_npm_ci_after_pull() -> None:
    """単一ブランチモードの手順 1 は、pull の後に npm ci を実行する（#1291）"""
    text = RELEASE_NX.read_text(encoding="utf-8")
    single = _section(text, _SINGLE_BRANCH_HEADING, "## ")
    step1 = _section(single, _STEP1_HEADING, "### ")
    code = _code_block_lines(step1)

    pull = next((i for i, line in enumerate(code) if "git pull --ff-only" in line), None)
    assert pull is not None, "手順 1 のコードブロックに git pull --ff-only がない"
    assert any("npm ci" in line for line in code[pull + 1 :]), (
        "手順 1 のコードブロックで git pull --ff-only より後に npm ci がない"
    )
