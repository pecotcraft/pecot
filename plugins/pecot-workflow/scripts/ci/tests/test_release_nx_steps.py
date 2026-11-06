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


def test_single_branch_step1_installs_after_pull() -> None:
    """単一ブランチモードの手順 1 は、pull の後に frozen の install を実行する（#1291, #113）"""
    text = RELEASE_NX.read_text(encoding="utf-8")
    single = _section(text, _SINGLE_BRANCH_HEADING, "## ")
    step1 = _section(single, _STEP1_HEADING, "### ")
    code = _code_block_lines(step1)

    pull = next((i for i, line in enumerate(code) if "git pull --ff-only" in line), None)
    assert pull is not None, "手順 1 のコードブロックに git pull --ff-only がない"
    install = [line for line in code[pull + 1 :] if "pnpm install --frozen-lockfile" in line]
    assert install, (
        "手順 1 のコードブロックで git pull --ff-only より後に pnpm install --frozen-lockfile がない"
    )
    assert all("pnpm-lock.yaml" in line and "npm ci" in line for line in install)


_NX_SWITCH = 'if [ -f pnpm-lock.yaml ]; then NX="pnpm exec nx"; else NX="npx nx"; fi'


def test_nx_launcher_switches_on_pnpm_lock() -> None:
    """nx の起動は pnpm-lock.yaml の有無で切り替える。npm のリポは今まで通り npx nx (#113)"""
    text = RELEASE_NX.read_text(encoding="utf-8")
    assert _NX_SWITCH in text
    # 切り替えの定義以外では npx nx を直接書かない。コマンド例は $NX を使う。
    rest = text.replace(_NX_SWITCH, "")
    direct = [line for line in rest.splitlines() if "npx nx" in line and "pnpm exec nx" not in line]
    assert direct == []
    assert "$NX release" in text


def test_nx_blocks_decide_launcher_after_cd_before_use() -> None:
    """NX を使う行は、cd の後・NX の前で起動コマンドを決める (#113)"""
    text = RELEASE_NX.read_text(encoding="utf-8")
    in_block = False
    checked = 0
    for line in text.splitlines():
        if line.startswith("```"):
            in_block = not in_block
        elif in_block and "$NX " in line and _NX_SWITCH not in line.split("&&")[0]:
            cd = line.index("cd <project-root>/base/<repo>")
            assert (
                cd
                < line.index(_NX_SWITCH)
                < line.index("$NX ", line.index(_NX_SWITCH) + len(_NX_SWITCH))
            ), line
            checked += 1
    assert checked >= 5


def test_merge_strategy_uses_the_launcher() -> None:
    text = (SKILLS_ROOT / "w-help" / "references" / "merge-strategy.md").read_text(encoding="utf-8")
    assert "`$NX release`" in text
