# issue-flow-rules.md への参照の実在性を検証する。
# 対象は CLI フッター / issue テンプレ / 各 SKILL.md / commands.md / hooks 注入テンプレ / agent 定義のパス・節 anchor・§ 番号。
#
# anchor slug 生成は github-slugger の slug アルゴリズムの部分移植。
# re.ASCII を付けないことが CJK 見出しを保持する前提。
# 付けると \w が ASCII に縮退し、全 CJK 見出しが死リンクとして誤検知される。
# slug 移植は github-slugger 本体と、記号・Unicode 結合文字の扱いで完全一致しない近似。
# 現コーパスでは本体と全一致を確認済み。
import re
from collections.abc import Iterator
from pathlib import Path

from cli.commands.issue import _QUICK_BODY_FOOTER

CLI_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SKILLS_ROOT = PLUGIN_ROOT / "skills"
TEMPLATES_ROOT = CLI_ROOT / "templates" / "issue"
HOOKS_TEMPLATES_ROOT = PLUGIN_ROOT / "hooks" / "templates"
AGENTS_ROOT = PLUGIN_ROOT / "agents"
RULES_DOC = SKILLS_ROOT / "w-help" / "references" / "issue-flow-rules.md"

_MD_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
_INLINE_CODE_RE = re.compile(r"`[^`]*`")
# §N は「issue-flow-rules パス文字列に近接する §N」のみを拾う。
# 行内の任意の §N を拾うと、別資料の §N が同一行に並んだとき誤検知する。
# そのため、パス直後（最大 20 文字、§ を跨がない範囲）だけに限る。
# 別資料の §N をこの近接窓内に並記しない限り誤検知しない設計。
# 並記する場合は、パスと §N を 20 文字以上離すか改行で分ける。
_SECTION_SIGN_NEAR_PATH_RE = re.compile(r"issue-flow-rules(?:\.md)?[^§\n]{0,20}§(\d+)")
# issue-flow-rules.md 本体への repo 内パス参照は `skills/...` 絶対形で書く規約。
# 別形式（相対パスのみ等）は本テストの対象外。
_RULES_PATH_RE = re.compile(r"skills/\S+?\.md(?:#[^\s)>]+)?")
# §N と節が同一かを検証するための anchor 抽出。
# anchor は実際の参照サイトでは相対形で書かれる。
# 例は `issue-flow-rules.md#...` / `../w-help/references/issue-flow-rules.md#...`。
# そのため `_RULES_PATH_RE` の `skills/...` 絶対形とは別に、パス接頭辞を問わず拾う。
_RULES_ANCHOR_RE = re.compile(r"issue-flow-rules(?:\.md)?#([^\s)>]+)")


def _non_fenced_lines(text: str) -> Iterator[tuple[int, str]]:
    """fence 外の行を 1-origin 行番号付きで返す。

    制約: ``` フェンスのみ対応（``~~~`` フェンスは非対応）。fence 内に現れる
    ``` 開始行でも in_fence をトグル反転する（ネスト非対応）。``_github_slugs`` /
    ``_heading_numbers`` が依拠する見出し抽出と同じ前提で、現コーパスでは問題無い。
    """
    in_fence = False
    for line_number, line in enumerate(text.splitlines(), start=1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            yield line_number, line


def _github_slug(heading: str, seen: dict[str, int]) -> str:
    """GitHub 方式で見出しテキストを anchor slug に変換する。

    lowercase / バッククォート除去 / ``[^\\w\\- ]`` 除去 / 空白→``-`` /
    同一 slug の重複はファイル全体通し番号で ``-1``, ``-2`` と連番。
    re.ASCII は付けない（CJK を ``\\w`` に残す）。
    """
    text = heading.lower().replace("`", "")
    text = re.sub(r"[^\w\- ]", "", text)
    slug = text.replace(" ", "-")
    count = seen.get(slug, 0)
    seen[slug] = count + 1
    if count:
        return f"{slug}-{count}"
    return slug


def _github_slugs(md_path: Path) -> set[str]:
    """md ファイル内の fence 外見出しを GitHub 方式で slug 化した集合を返す。"""
    seen: dict[str, int] = {}
    slugs: set[str] = set()
    for _, line in _non_fenced_lines(md_path.read_text()):
        match = re.match(r"#{1,6}\s+(.*)$", line.strip())
        if match:
            slugs.add(_github_slug(match.group(1).strip(), seen))
    return slugs


def _heading_numbers(md_path: Path) -> set[str]:
    """``## N. ...`` 形式の見出し番号 N の集合を返す。"""
    numbers: set[str] = set()
    for _, line in _non_fenced_lines(md_path.read_text()):
        match = re.match(r"#{1,6}\s+(\d+)\.\s", line.strip())
        if match:
            numbers.add(match.group(1))
    return numbers


def _slug_to_section(md_path: Path) -> dict[str, str]:
    """見出し slug → それを含む直近の ``## N.`` セクション番号の対応を返す。

    ``## N.`` 見出しに出会うとカレント番号を更新し、以降の各見出し slug を
    その番号に紐づける。anchor と §N の節同一性検証に用いる。
    """
    seen: dict[str, int] = {}
    mapping: dict[str, str] = {}
    current: str | None = None
    for _, line in _non_fenced_lines(md_path.read_text()):
        match = re.match(r"#{1,6}\s+(.*)$", line.strip())
        if not match:
            continue
        heading = match.group(1).strip()
        section = re.match(r"(\d+)\.\s", heading)
        if section:
            current = section.group(1)
        mapping[_github_slug(heading, seen)] = current or ""
    return mapping


def test_skills_markdown_relative_links_resolve() -> None:
    """skills/**/*.md の相対 markdown リンク（+anchor）が実在することを検証する。"""
    offenders = []

    for md_path in sorted(SKILLS_ROOT.rglob("*.md")):
        relative_path = md_path.relative_to(SKILLS_ROOT).as_posix()
        for line_number, line in _non_fenced_lines(md_path.read_text()):
            # § テストと統一して inline code span を除去してからリンクを抽出する。
            # ``[`...md`](path)`` のようにリンクテキスト内にバッククォートを含む
            # 実例があるが、scrub 後も ``[](path)`` 構造が残りリンク URL は保持される。
            scrubbed = _INLINE_CODE_RE.sub("", line)
            for raw_target in _MD_LINK_RE.findall(scrubbed):
                target = raw_target.strip()
                if target.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                if ".md" not in target:
                    continue
                path_part, _, anchor = target.partition("#")
                resolved = (md_path.parent / path_part).resolve()
                if not resolved.is_file():
                    offenders.append(f"{relative_path}:{line_number}: missing file -> {target}")
                    continue
                if anchor and anchor not in _github_slugs(resolved):
                    offenders.append(f"{relative_path}:{line_number}: missing anchor -> {target}")

    assert offenders == []


def test_quick_body_footer_references_existing_rules_anchor() -> None:
    """_QUICK_BODY_FOOTER のパス + anchor が plugins/pecot-workflow/ 基準で実在することを検証する。"""
    offenders = []

    for raw_target in _RULES_PATH_RE.findall(_QUICK_BODY_FOOTER):
        path_part, _, anchor = raw_target.partition("#")
        # トレーリングの ` -->` 等が混入しないよう anchor は空白・`>` で切る。
        anchor = re.match(r"([^\s>]*)", anchor).group(1)
        resolved = (PLUGIN_ROOT / path_part).resolve()
        if not resolved.is_file():
            offenders.append(f"_QUICK_BODY_FOOTER:0: missing file -> {raw_target}")
            continue
        if anchor and anchor not in _github_slugs(resolved):
            offenders.append(f"_QUICK_BODY_FOOTER:0: missing anchor -> {raw_target}")

    assert offenders == []


def test_issue_templates_rule_source_paths_exist() -> None:
    """issue テンプレ内の skills/...md パス（+anchor）が plugins/pecot-workflow/ 基準で実在することを検証する。"""
    offenders = []

    for md_path in sorted(TEMPLATES_ROOT.glob("*.md")):
        relative_path = md_path.relative_to(CLI_ROOT).as_posix()
        for line_number, line in _non_fenced_lines(md_path.read_text()):
            for raw_target in _RULES_PATH_RE.findall(line):
                path_part, _, anchor = raw_target.partition("#")
                resolved = (PLUGIN_ROOT / path_part).resolve()
                if not resolved.is_file():
                    offenders.append(f"{relative_path}:{line_number}: missing file -> {path_part}")
                    continue
                if anchor and anchor not in _github_slugs(resolved):
                    offenders.append(
                        f"{relative_path}:{line_number}: missing anchor -> {raw_target}"
                    )

    assert offenders == []


def test_issue_templates_have_reader_and_example_labels() -> None:
    """issue テンプレ 4 本すべての冒頭コメントに `読者:` と `例:` のラベルが存在することを検証する。

    ラベルの存在だけを確認し、文面には結合しない（本文を差し替えても落ちない）。
    """
    offenders = []

    for md_path in sorted(TEMPLATES_ROOT.glob("*.md")):
        relative_path = md_path.relative_to(CLI_ROOT).as_posix()
        text = md_path.read_text()
        if "読者:" not in text:
            offenders.append(f"{relative_path}: missing `読者:` label")
        if "例:" not in text:
            offenders.append(f"{relative_path}: missing `例:` label")

    assert offenders == []


def test_section_sign_references_match_headings() -> None:
    """issue-flow-rules パスの近くにある §N が `## N.` 見出しと対応することを検証する。

    さらに、rules への anchor 付き参照と §N が同一行に併記された場合を扱う。
    anchor の見出しが `## N.` セクション配下にあること（節の同一性）も検証する。
    """
    numbers = _heading_numbers(RULES_DOC)
    slug_to_section = _slug_to_section(RULES_DOC)
    offenders = []

    sources = [CLI_ROOT / "commands" / "issue.py"]
    sources += sorted(SKILLS_ROOT.rglob("*.md"))
    sources += sorted(TEMPLATES_ROOT.glob("*.md"))
    # hooks の注入テンプレ・agent 定義も §N で本体を参照するため、対象に含める。
    # これらの参照はパスをバッククォート外に置く規約。
    # inline code は § 探索前に scrub されるため、バッククォート内に入れると検知対象から外れる。
    sources += sorted(HOOKS_TEMPLATES_ROOT.glob("*.md"))
    sources += sorted(AGENTS_ROOT.glob("*.md"))

    for source in sources:
        # issue-flow-rules.md 自身は自己言及（`（§5）` 等）を含むため対象外。
        if source == RULES_DOC:
            continue
        relative_path = source.relative_to(PLUGIN_ROOT).as_posix()
        text = source.read_text()
        if source.suffix == ".md":
            iter_lines = _non_fenced_lines(text)
        else:
            iter_lines = enumerate(text.splitlines(), start=1)
        for line_number, line in iter_lines:
            if "issue-flow-rules" not in line:
                continue
            # § 探索の前処理として inline code span を除去する。
            scrubbed = _INLINE_CODE_RE.sub("", line)
            section_numbers = _SECTION_SIGN_NEAR_PATH_RE.findall(scrubbed)
            for number in section_numbers:
                if number not in numbers:
                    offenders.append(
                        f"{relative_path}:{line_number}: §{number} has no `## {number}.`"
                    )
            # 同一行に rules への anchor 付き参照があれば、その anchor の見出しが
            # §N と同じ `## N.` セクション配下にあることを検証する。
            for anchor in _RULES_ANCHOR_RE.findall(line):
                anchor_section = slug_to_section.get(anchor)
                if anchor_section is None:
                    continue
                for number in section_numbers:
                    if anchor_section != number:
                        offenders.append(
                            f"{relative_path}:{line_number}: anchor #{anchor} "
                            f"(§{anchor_section}) mismatches §{number}"
                        )

    assert offenders == []
