"""hooks-config.json.sample / README 設定キー一覧 / スクリプト実体の三者突合テスト。

フックを新設しても sample と README への追記が漏れると、利用者は設定キーの存在を
知る手段がないまま既定値で動く。ここでは 3 つの出所から独立にキー集合を抽出し、
双方向に一致することを検証する（sample == スクリプト == README）。

値の一致も同時に見る: sample の各値は、対応スクリプトの `pecot_hook_enabled` 呼び出し
第 2 引数（デフォルト値）と揃っていなければならない。揃わない場合、利用者が sample を
そのままコピーすると、同時に既定の挙動が変わる。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import NamedTuple

import pytest

# 意図的に sample の値をスクリプトのデフォルトから乖離させるキー。
# 追加するときは乖離させる理由をコメントで残すこと。
_ALLOWED_VALUE_DIVERGENCE: frozenset[str] = frozenset()

# `pecot_hook_enabled "<key>" <default>` の実呼び出し。
# キーの文字種は制限しない。
# `[a-z0-9-]` 等に狭めると、規約外の文字を含むキーが抽出から気づかれないまま脱落し、三者突合がすり抜ける。
# デフォルト値はオプショナルで拾う。
# 省略呼び出しは、test_hook_enabled_calls_declare_default が別途落とす。
# 必須マッチにすると、呼び出しごとキーが脱落して、同じくすり抜けてしまう。
_HOOK_ENABLED_RE = re.compile(
    r"""pecot_hook_enabled\s+(?P<q>["'])(?P<key>[^"']+)(?P=q)(?:\s+(?P<default>true|false)\b)?"""
)

# `_external_post_check "<key>" ...` は、第 1 引数のキーを受け取る。
# 関数内部では、`pecot_hook_enabled "$config_key" <default>` を呼ぶ。
# 呼び出し側にデフォルト値は現れない。
# そのため、ヘルパー定義側の実値を読み取って補完する。
# ハードコードすると、定義側の値が改変されても検知できない。
_EXTERNAL_POST_CHECK_RE = re.compile(r"""_external_post_check\s+(?P<q>["'])(?P<key>[^"']+)(?P=q)""")
_EXTERNAL_POST_CHECK_DEF_RE = re.compile(r"""_external_post_check\s*\(\s*\)""")
_HOOK_ENABLED_VAR_RE = re.compile(
    r"""pecot_hook_enabled\s+["']\$\{?\w+\}?["']\s+(?P<default>true|false)\b"""
)

# README の設定キー一覧節の範囲。hosts.json の表（`env_var` 等）を拾わないよう
# 節の開始・終了見出しでスコープを限定する。
_README_SECTION_START = "## 設定キー一覧"
_README_SECTION_END = "## フック実行フロー"

# 見出しは行単位の完全一致で探す。
# 部分一致の検索にすると、接頭辞を保った改名を取り逃がす。
# 例は `## 設定キー一覧（旧）` で、節が特定できたまま、すり抜けてしまう。
_README_SECTION_START_RE = re.compile(rf"^{re.escape(_README_SECTION_START)}$", re.MULTILINE)
_README_SECTION_END_RE = re.compile(rf"^{re.escape(_README_SECTION_END)}$", re.MULTILINE)

# 表セル先頭の `key`。注記付きセル（`key`（非推奨）等）でも先頭のキーを拾う。
_README_KEY_CELL_RE = re.compile(r"^`([^`]+)`")


class _GateCall(NamedTuple):
    key: str
    default: str | None
    location: str


@pytest.fixture(scope="session")
def hooks_dir(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks"


def _gate_script_paths(hooks_dir: Path) -> list[Path]:
    """走査対象のシェルスクリプト。lib 配下だけでなく hooks/ 直下の entry script も含む。"""
    return [
        path
        for path in sorted(hooks_dir.glob("**/*.sh"))
        if "tests" not in path.relative_to(hooks_dir).parts
    ]


def _strip_comment(line: str) -> str:
    """行末コメントを落とす。

    pecot_hook_enabled の呼び出し行のクオート内に `#` を含む例は、現状存在しないため、単純除去でよい。
    これにより行頭コメント（config-dispatcher.sh の使用例）も同時に空行化される。
    """
    return line.split("#", 1)[0]


def _hook_enabled_calls(hooks_dir: Path) -> list[_GateCall]:
    """`pecot_hook_enabled` の実呼び出しを全件返す（変数キー形式も含む）。"""
    calls: list[_GateCall] = []
    for path in _gate_script_paths(hooks_dir):
        rel = str(path.relative_to(hooks_dir))
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in _HOOK_ENABLED_RE.finditer(_strip_comment(line)):
                calls.append(
                    _GateCall(match.group("key"), match.group("default"), f"{rel}:{lineno}")
                )
    return calls


def _external_post_check_calls(hooks_dir: Path) -> list[tuple[str, str]]:
    """`_external_post_check` の実呼び出しから (キー, 位置) を返す。"""
    calls: list[tuple[str, str]] = []
    for path in _gate_script_paths(hooks_dir):
        rel = str(path.relative_to(hooks_dir))
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in _EXTERNAL_POST_CHECK_RE.finditer(_strip_comment(line)):
                calls.append((match.group("key"), f"{rel}:{lineno}"))
    return calls


def _external_post_check_default(hooks_dir: Path) -> str:
    """`_external_post_check` 定義側の `pecot_hook_enabled "$config_key" <default>` の実値を読む。"""
    found: list[tuple[str, str]] = []
    for path in _gate_script_paths(hooks_dir):
        rel = str(path.relative_to(hooks_dir))
        lines = path.read_text(encoding="utf-8").splitlines()
        stripped = [_strip_comment(line) for line in lines]
        if not any(_EXTERNAL_POST_CHECK_DEF_RE.search(line) for line in stripped):
            continue
        for lineno, line in enumerate(stripped, 1):
            match = _HOOK_ENABLED_VAR_RE.search(line)
            if match:
                found.append((match.group("default"), f"{rel}:{lineno}"))
    assert len(found) == 1, (
        "`_external_post_check` 定義側の変数キー `pecot_hook_enabled` 呼び出しが "
        f"1 箇所に特定できません: {found}"
    )
    return found[0][0]


def _script_keys(hooks_dir: Path) -> set[str]:
    """スクリプト実体が gate しているキー集合。変数キー形式はヘルパー経由で解決する。"""
    keys = {call.key for call in _hook_enabled_calls(hooks_dir) if not call.key.startswith("$")}
    keys |= {key for key, _ in _external_post_check_calls(hooks_dir)}
    return keys


def _script_defaults(hooks_dir: Path) -> dict[str, str]:
    """{キー: デフォルト値}。同一キーが異なるデフォルト値で呼ばれていたら落とす。"""
    found: dict[str, set[tuple[str, str]]] = {}
    for call in _hook_enabled_calls(hooks_dir):
        if call.key.startswith("$") or call.default is None:
            continue
        found.setdefault(call.key, set()).add((call.default, call.location))
    ask_default = _external_post_check_default(hooks_dir)
    for key, location in _external_post_check_calls(hooks_dir):
        found.setdefault(key, set()).add((ask_default, location))

    defaults: dict[str, str] = {}
    for key, occurrences in found.items():
        values = {value for value, _ in occurrences}
        assert len(values) == 1, (
            f"キー `{key}` が複数の異なるデフォルト値で呼ばれています: {sorted(occurrences)}"
        )
        defaults[key] = values.pop()
    return defaults


def _readme_keys(hooks_dir: Path) -> set[str]:
    """README の設定キー一覧節にある表の第 1 列からキーを抽出する。"""
    text = (hooks_dir / "README.md").read_text(encoding="utf-8")
    start_match = _README_SECTION_START_RE.search(text)
    assert start_match is not None, (
        f"README に見出し `{_README_SECTION_START}` がありません。"
        "見出しを改名した場合は本テストの _README_SECTION_START も更新すること"
    )
    end_match = _README_SECTION_END_RE.search(text, start_match.end())
    assert end_match is not None, (
        f"README の `{_README_SECTION_START}` 以降に見出し `{_README_SECTION_END}` が"
        "ありません。見出しを改名した場合は本テストの _README_SECTION_END も更新すること"
    )
    keys: set[str] = set()
    for line in text[start_match.start() : end_match.start()].splitlines():
        if not line.startswith("|"):
            continue
        first_cell = line.strip().strip("|").split("|")[0].strip()
        match = _README_KEY_CELL_RE.match(first_cell)
        if match:
            keys.add(match.group(1))
    return keys


def _sample_config(hooks_dir: Path) -> dict[str, object]:
    """sample を読む。重複キーは last-wins で沈黙するため明示的に弾く。"""
    raw = (hooks_dir / "hooks-config.json.sample").read_text(encoding="utf-8")

    def _reject_duplicates(pairs: list[tuple[str, object]]) -> dict:
        seen: set[str] = set()
        for key, _ in pairs:
            assert key not in seen, f"sample にキー `{key}` が重複しています"
            seen.add(key)
        return dict(pairs)

    return json.loads(raw, object_pairs_hook=_reject_duplicates)


def test_hook_enabled_calls_declare_default(hooks_dir: Path):
    """全 pecot_hook_enabled 呼び出しが、明示デフォルト値を持つこと。

    省略呼び出し（`pecot_hook_enabled "key"`）を許すと、値の突合対象から外れたキーが、デフォルト値不明のまま sample に載る。
    """
    missing = [call for call in _hook_enabled_calls(hooks_dir) if call.default is None]
    assert missing == [], (
        "デフォルト値（true / false）を明示していない pecot_hook_enabled 呼び出し: "
        + ", ".join(f"{call.location} キー `{call.key}`" for call in missing)
    )


def test_sample_keys_match_scripts(hooks_dir: Path):
    sample = set(_sample_config(hooks_dir))
    scripts = _script_keys(hooks_dir)
    assert scripts - sample == set(), (
        "スクリプトに存在するが sample に無いキー（sample への追記抜け）"
    )
    assert sample - scripts == set(), (
        "sample に存在するがスクリプトから呼ばれていないキー（削除抜け）"
    )


def test_readme_keys_match_scripts(hooks_dir: Path):
    readme = _readme_keys(hooks_dir)
    scripts = _script_keys(hooks_dir)
    assert scripts - readme == set(), (
        "スクリプトに存在するが README 設定キー一覧に無いキー（README への追記抜け）"
    )
    assert readme - scripts == set(), (
        "README 設定キー一覧に存在するがスクリプトから呼ばれていないキー（削除抜け）"
    )


def test_sample_values_match_script_defaults(hooks_dir: Path):
    sample = _sample_config(hooks_dir)
    defaults = _script_defaults(hooks_dir)
    mismatches = {
        key: (value, defaults[key])
        for key, value in sample.items()
        if key in defaults
        and key not in _ALLOWED_VALUE_DIVERGENCE
        and json.dumps(value) != defaults[key]
    }
    assert mismatches == {}, (
        f"sample の値がスクリプトのデフォルトと不一致（sample, スクリプト）: {mismatches}"
    )
