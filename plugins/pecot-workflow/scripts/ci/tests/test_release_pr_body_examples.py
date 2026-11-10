import re
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SKILLS_ROOT = PLUGIN_ROOT / "skills"
PECOT_ROOT = PLUGIN_ROOT
TEMPLATES_DIR = PECOT_ROOT / "cli" / "templates" / "pr"

sys.path.insert(0, str(PECOT_ROOT))

from cli.core.sections import (  # noqa: E402
    extract_sections_from_template,
    validate_body_style,
    validate_sections,
)

# docs PR 作成コマンド例の `-m "..."` 本文を取り出す
_PR_CREATE_BODY_RE = re.compile(r'pecot pr create \\.*?-m "(.*?)"\s*\\\n\s*-b', re.DOTALL)

# reference 側は `<ver>` `<package>` をドキュメント全体の記法変数として使っているため、
# CLI が未編集プレースホルダとして弾いてしまう。実行時は実際の値に置き換わるので、
# 検証前に具体値へ差し替えて「置き換え後の本文がテンプレ通り」かだけを見る
_DOC_PLACEHOLDERS = {"<ver>": "1.2.3", "<package>": "demo-pkg"}


def _extract_pr_create_body(reference_name: str) -> str:
    text = (SKILLS_ROOT / "w-release" / "references" / reference_name).read_text(encoding="utf-8")
    match = _PR_CREATE_BODY_RE.search(text)
    assert match, f"{reference_name} に pecot pr create の -m 本文が見つからない"
    body = match.group(1)
    for placeholder, value in _DOC_PLACEHOLDERS.items():
        body = body.replace(placeholder, value)
    return body


@pytest.mark.parametrize("reference_name", ["release-single.md", "release-multi.md"])
def test_docs_pr_body_example_matches_create_template(reference_name: str) -> None:
    """release-*.md の docs PR 作成例が create.md の必須節・記法規約を満たす（#1008 F-02）

    テンプレの節が将来増減したとき、スキル側の例が置き去りになるのを捕捉する。
    """
    body = _extract_pr_create_body(reference_name)
    sections = extract_sections_from_template(TEMPLATES_DIR / "create.md")

    assert validate_sections(body, sections) == []
    assert validate_body_style(body) == []


@pytest.mark.parametrize("reference_name", ["release-single.md", "release-multi.md"])
def test_docs_pr_example_has_screenshot_reason_before_message(reference_name: str) -> None:
    """`-m` の CHANGELOG PR の例は画像を入れない理由を `--screenshot` で渡す（#183）"""
    text = (SKILLS_ROOT / "w-release" / "references" / reference_name).read_text(encoding="utf-8")
    match = re.search(r'pecot pr create \\.*?-m "', text, re.DOTALL)
    assert match, f"{reference_name} に pecot pr create の -m の例が見つからない"
    assert '--screenshot "' in match.group(0)
    assert _PR_CREATE_BODY_RE.search(text) is not None
