"""hooks の基準ディレクトリ解決の規約テスト（静的確認）。

hooks と、Bash ツールから呼ぶ pecot CLI が、同じ `.pecot/state` を指すようにする。
そのため、基準ディレクトリ（CLAUDE_PROJECT_DIR）は、全エントリポイントが lib/core/project-root.sh で揃える。
揃える先は、hook 入力の cwd の git toplevel。
lib スクリプトは、CLAUDE_PROJECT_DIR だけを参照する。
固定する不変条件は次の 3 点。

- hooks/ 直下の全エントリポイントが、`INPUT=$(cat)` の直後に、入力 JSON を引数にして project-root.sh を source する。
  入力を読む前や、lib 呼び出しの後では、cwd を反映できない。
- lib 配下（tests 除く）に、`${CLAUDE_PROJECT_DIR:-<既定値>}` の独自 fallback が無い。
  `${CLAUDE_PROJECT_DIR:-}` の nounset 対策は、既定値が空なので対象外。
- lib 配下（tests 除く）で、`git rev-parse --show-toplevel` をプロセス cwd 基準で呼ばない。
  `git -C <dir> rev-parse --show-toplevel` は、対象ディレクトリを明示しているので可。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

import pytest

_HOOKS_DIR = Path(__file__).resolve().parents[1]
_ENTRY_POINTS = sorted(_HOOKS_DIR.glob("*.sh"))
_LIB_SCRIPTS = sorted(
    path
    for path in _HOOKS_DIR.glob("lib/**/*.sh")
    if "tests" not in path.relative_to(_HOOKS_DIR).parts
)

_INPUT_LINE = "INPUT=$(cat)"
# lib/core を指す変数。
# CORE_DIR を定義するエントリポイントは、$CORE_DIR 経由に限る（lib/tests/test_pecot_dir_init_detection.py の生パス禁止規約）。
_SOURCE_RE = re.compile(r'^source "\$([A-Z_]+)(/lib/core)?/project-root\.sh" "\$INPUT"$')
_FALLBACK_RE = re.compile(r"\$\{CLAUDE_PROJECT_DIR:?-[^}]")
# `git` の直後（大域オプションを挟んでも）に `-C` が無いまま rev-parse --show-toplevel を呼ぶ形。
_CWD_TOPLEVEL_RE = re.compile(r"\bgit\b(?:(?!\s-C\b)[^|;&])*?\brev-parse\s+--show-toplevel\b")


def test_entry_points_enumerated() -> None:
    # 列挙が空振りすると全 pass になるため下限を置く（実数は hooks/ 直下の 14 本）。
    assert len(_ENTRY_POINTS) >= 14
    assert len(_LIB_SCRIPTS) >= 40


@pytest.mark.parametrize("entry", _ENTRY_POINTS, ids=lambda p: p.name)
def test_entry_point_sources_project_root_right_after_input(
    entry: Path, resolve_dir_vars: Callable[[str, Path, Path], dict[str, Path]]
) -> None:
    text = entry.read_text(encoding="utf-8")
    lines = [line.strip() for line in text.splitlines()]
    assert lines.count(_INPUT_LINE) == 1, f"{entry.name}: `{_INPUT_LINE}` が 1 行ではありません"
    sources = [(i, m) for i, line in enumerate(lines) if (m := _SOURCE_RE.match(line))]
    assert len(sources) == 1, (
        f'{entry.name}: `source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"` が 1 行ではありません'
    )
    index, match = sources[0]
    assert index == lines.index(_INPUT_LINE) + 1, (
        f"{entry.name}: project-root.sh の source は `{_INPUT_LINE}` の直後に置いてください"
    )
    dir_vars = resolve_dir_vars(text, _HOOKS_DIR, _HOOKS_DIR.parent)
    base = dir_vars[match.group(1)] / (match.group(2) or "").lstrip("/")
    assert (base / "project-root.sh") == _HOOKS_DIR / "lib" / "core" / "project-root.sh"


@pytest.mark.parametrize("script", _LIB_SCRIPTS, ids=lambda p: str(p.relative_to(_HOOKS_DIR)))
def test_lib_has_no_project_dir_fallback(script: Path) -> None:
    offending = [
        line.strip()
        for line in script.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#") and _FALLBACK_RE.search(line)
    ]
    assert offending == [], (
        f"{script.relative_to(_HOOKS_DIR)}: CLAUDE_PROJECT_DIR の独自 fallback があります: {offending}。"
        "基準ディレクトリはエントリポイントの project-root.sh が決めます"
    )


def test_fallback_pattern_detects_known_forms() -> None:
    # 検出 regex 自体の負例・正例（regex が崩れて全 pass になるのを防ぐ）。
    assert _FALLBACK_RE.search('PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"')
    assert _FALLBACK_RE.search('X="${CLAUDE_PROJECT_DIR-/tmp}"')
    assert not _FALLBACK_RE.search('[[ -z "${CLAUDE_PROJECT_DIR:-}" ]] && exit 0')
    assert not _FALLBACK_RE.search('STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"')


@pytest.mark.parametrize("script", _LIB_SCRIPTS, ids=lambda p: str(p.relative_to(_HOOKS_DIR)))
def test_lib_has_no_cwd_based_toplevel(script: Path) -> None:
    offending = [
        line.strip()
        for line in script.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#") and _CWD_TOPLEVEL_RE.search(line)
    ]
    assert offending == [], (
        f"{script.relative_to(_HOOKS_DIR)}: プロセス cwd 基準の `git rev-parse --show-toplevel` があります:"
        f" {offending}。基準ディレクトリは CLAUDE_PROJECT_DIR（エントリポイントの project-root.sh）を"
        "使い、別ディレクトリを調べるときは `git -C <dir>` で対象を明示してください"
    )


def test_cwd_toplevel_pattern_detects_known_forms() -> None:
    # 検出 regex 自体の負例・正例（regex が崩れて全 pass になるのを防ぐ）。
    assert _CWD_TOPLEVEL_RE.search("REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)")
    assert _CWD_TOPLEVEL_RE.search("if ! t=$(git rev-parse --show-toplevel 2>/dev/null); then")
    assert _CWD_TOPLEVEL_RE.search("P=$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
    assert _CWD_TOPLEVEL_RE.search("X=$(git --no-pager rev-parse --show-toplevel)")
    assert not _CWD_TOPLEVEL_RE.search('git -C "$dir" rev-parse --show-toplevel 2>/dev/null')
    assert not _CWD_TOPLEVEL_RE.search('cd "$d" && git -C . rev-parse --show-toplevel')
    assert not _CWD_TOPLEVEL_RE.search("git rev-parse --git-dir")


_LAZY_VAR = "PECOT_PROJECT_ROOT_LAZY"
# toplevel の解決を遅らせてよいエントリは PostToolUse(Bash) の 1 本だけ。条件に一致しない大半の
# Bash で git を呼ばないための例外で、解決は lib/post-tool-use/bash-post-match.sh が一致後に行う（#1229）。
_LAZY_ENTRIES = {"post-tool-use-bash.sh"}


@pytest.mark.parametrize("entry", _ENTRY_POINTS, ids=lambda p: p.name)
def test_only_post_bash_entry_defers_project_root_resolution(entry: Path) -> None:
    uses_lazy = any(
        line.strip().startswith(f"{_LAZY_VAR}=")
        for line in entry.read_text(encoding="utf-8").splitlines()
    )
    assert uses_lazy == (entry.name in _LAZY_ENTRIES), (
        f"{entry.name}: {_LAZY_VAR} で project-root の解決を遅らせてよいのは {sorted(_LAZY_ENTRIES)} だけです"
    )


def test_post_bash_entry_resolves_after_match() -> None:
    text = (_HOOKS_DIR / "post-tool-use-bash.sh").read_text(encoding="utf-8")
    lines = [line.strip() for line in text.splitlines()]
    match = next(
        i for i, line in enumerate(lines) if "bash-post-match.sh" in line and "source" in line
    )
    guard = lines.index('[ -z "$PECOT_POST_MATCHED" ] && exit 0')
    assert match < guard, "一致判定の後で、一致しなければ exit する形にしてください"
