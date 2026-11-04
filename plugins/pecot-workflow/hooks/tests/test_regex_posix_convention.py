"""hooks の `[[ =~ ]]` 用 ERE の記法の規約テスト（静的確認）。

`\\s`・`\\S` は glibc の拡張で、POSIX ERE の標準は `[[:space:]]`・`[^[:space:]]`。
hooks のコード行に `\\s`・`\\S` が出たら失敗にする。
例外は、そのエンジンの標準の記法である次の 2 つの行だけ。

- `grep` の `-P` / `-oP`（PCRE）
- jq の `test(`（Oniguruma）

走査はコメントを除いたコード行に対して行う。
パターンは変数の連結や関数の引数でも渡るため、変数名ではなく行で見る。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

import pytest

_HOOKS_DIR = Path(__file__).resolve().parents[1]
_SCRIPTS = sorted(
    path
    for path in [*_HOOKS_DIR.glob("*.sh"), *_HOOKS_DIR.glob("lib/**/*.sh")]
    if "tests" not in path.relative_to(_HOOKS_DIR).parts
)

_GNU_CLASS_RE = re.compile(r"\\[sS]")
_PCRE_GREP_RE = re.compile(r"\bgrep\b[^|]*\s-[A-Za-z]*P")
_JQ_TEST_RE = re.compile(r"\btest\(")


def _is_exempt(line: str) -> bool:
    return bool(_PCRE_GREP_RE.search(line) or _JQ_TEST_RE.search(line))


def _offending(lines: list[str]) -> list[str]:
    return [line.strip() for line in lines if _GNU_CLASS_RE.search(line) and not _is_exempt(line)]


def test_scripts_enumerated() -> None:
    # 列挙が空振りすると全 pass になるため下限を置く（test_project_root_convention と同じ下限）。
    assert len(_SCRIPTS) >= 57


@pytest.mark.parametrize("script", _SCRIPTS, ids=lambda p: str(p.relative_to(_HOOKS_DIR)))
def test_no_gnu_whitespace_class(script: Path, code_lines: Callable[[str], list[str]]) -> None:
    offending = _offending(code_lines(script.read_text(encoding="utf-8")))
    assert offending == [], (
        f"{script.relative_to(_HOOKS_DIR)}: glibc 拡張の `\\s`・`\\S` があります: {offending}。"
        "`[[ =~ ]]` の ERE には POSIX の `[[:space:]]`・`[^[:space:]]` を使ってください"
    )


def test_detection_known_forms() -> None:
    # 検出の正例・負例（検出が崩れて全 pass になるのを防ぐ）。
    assert _offending([r"P='git\s+commit'"]) == [r"P='git\s+commit'"]
    assert _offending([r"P='-C\s+\S+'"]) == [r"P='-C\s+\S+'"]
    assert _offending(["P='git[[:space:]]+commit'"]) == []
    assert _offending([r"""S=$(grep -m1 -oP '"slug":\s*"\K[^"]+' "$F")"""]) == []
    assert _offending([r"""| select(test("^\\s*Implement"))"""]) == []
