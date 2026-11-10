"""hooks がエージェントへ返す文言に日本語が無いことを守る（spec 021 FR-014・SC-007）。

範囲は hooks/**/*.sh・hooks/hooks*.json・hooks/templates/*.md。
テスト（hooks/tests/・hooks/lib/tests/）と hooks/conftest.py は外す。

コメントの判定:
- .sh は、先頭の空白を除いて `#` で始まる行をコメントとして外す。
  ただし heredoc の中の行と、複数行にまたがる引用符の文字列の中の行はコメントとみなさない。
- .md は `<!-- ... -->` だけを外す（`#` の見出しは本文）。
- .json は全行を調べる。
"""

from __future__ import annotations

import re
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parent.parent

# U+3000–U+30FF・U+3400–U+9FFF・U+F900–U+FAFF・U+FF00–U+FFEF
JAPANESE = re.compile("[　-ヿ㐀-鿿豈-﫿＀-￯]")

HEREDOC_START = re.compile(r"(?:^|\s)<<(-?)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")

# 例外: .gitignore を書き出す heredoc の日本語のコメント行。
# エージェントへのメッセージではなく、書き換えると利用者の .gitignore との差が出るため、
# ファイルと行の内容で名指しして外す。
EXEMPT = {
    (
        "lib/core/pecot-gitignore-ensure.sh",
        "# pecot の設定だけを追跡し、生成物は管理外にする許可の一覧。",
    ),
}


def _scan_quotes(line: str, state: str | None) -> str | None:
    """1 行を走査して、行末で開いている引用符の種類を返す。閉じていれば None。"""
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if state is None:
            if c == "\\":
                i += 2
                continue
            if c in ("'", '"'):
                state = c
            elif c == "#" and (i == 0 or line[i - 1] in " \t"):
                break
        elif state == "'":
            if c == "'":
                state = None
        else:
            if c == "\\":
                i += 2
                continue
            if c == '"':
                state = None
        i += 1
    return state


def _sh_lines(text: str):
    """(行番号, 行) を、コメントでない行についてだけ返す。"""
    quote: str | None = None
    heredoc_end: str | None = None
    heredoc_dash = False
    for no, line in enumerate(text.splitlines(), 1):
        if heredoc_end is not None:
            yield no, line
            check = line.lstrip("\t") if heredoc_dash else line
            if check == heredoc_end:
                heredoc_end = None
            continue
        if quote is not None:
            yield no, line
            quote = _scan_quotes(line, quote)
            continue
        if line.lstrip().startswith("#"):
            continue
        yield no, line
        m = HEREDOC_START.search(line)
        if m:
            heredoc_dash = m.group(1) == "-"
            heredoc_end = m.group(3)
            continue
        quote = _scan_quotes(line, None)


def _md_lines(text: str):
    in_comment = False
    for no, line in enumerate(text.splitlines(), 1):
        rest = line
        kept = ""
        while rest:
            if in_comment:
                end = rest.find("-->")
                if end < 0:
                    rest = ""
                else:
                    in_comment = False
                    rest = rest[end + 3 :]
            else:
                start = rest.find("<!--")
                if start < 0:
                    kept += rest
                    rest = ""
                else:
                    kept += rest[:start]
                    in_comment = True
                    rest = rest[start + 4 :]
        if kept.strip():
            yield no, kept


def _targets() -> list[Path]:
    files: list[Path] = []
    for p in sorted(HOOKS_DIR.rglob("*.sh")):
        rel = p.relative_to(HOOKS_DIR).parts
        if rel[0] == "tests" or rel[:2] == ("lib", "tests"):
            continue
        files.append(p)
    files += sorted(HOOKS_DIR.glob("hooks*.json"))
    files += sorted((HOOKS_DIR / "templates").glob("*.md"))
    return files


def _violations() -> list[str]:
    found: list[str] = []
    for path in _targets():
        rel = path.relative_to(HOOKS_DIR).as_posix()
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".sh":
            lines = _sh_lines(text)
        elif path.suffix == ".md":
            lines = _md_lines(text)
        else:
            lines = enumerate(text.splitlines(), 1)
        for no, line in lines:
            if JAPANESE.search(line) and (rel, line.strip()) not in EXEMPT:
                found.append(f"{rel}:{no}: {line.strip()}")
    return found


def test_targets_are_found():
    names = {p.name for p in _targets()}
    assert "gh-command-check.sh" in names
    assert "hooks.json" in names
    assert "exit-plan-comment-update.md" in names


def test_comment_detection():
    sh = '# 日本語\necho a # 日本語\ncat <<EOF\n# 日本語\nEOF\nx="a\n# 日本語"\n'
    got = [no for no, _ in _sh_lines(sh)]
    assert got == [2, 3, 4, 5, 6, 7]
    assert list(_md_lines("<!-- 日本語 -->\n# 見出し\n")) == [(2, "# 見出し")]


def test_hooks_messages_are_english_only():
    found = _violations()
    assert not found, f"{len(found)} lines contain Japanese:\n" + "\n".join(found)
