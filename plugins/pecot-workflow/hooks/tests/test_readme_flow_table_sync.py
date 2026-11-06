"""README「フック実行フロー」表 / hooks.json / エントリスクリプト実体の三者突合テスト。

README の当該表は、「どのトリガーがどのスクリプトを起動し、そのスクリプトがどの lib を呼ぶか」を一覧する唯一の資料。
フックを増減・改名しても表を直さなければ、読者は存在しない手段を追うことになる。
ここでは、表・`hooks.json`・スクリプト実体から、独立に対応関係を抽出する。
スクリプト実体は、`hooks/` 直下のエントリスクリプトと、そこから 1 段だけ辿った中継先ディスパッチャ。
抽出した 3 者が双方向に一致することを検証する。

`test_hooks_config_sample_sync.py` とは責務が分かれている（同ファイル = 設定キー一覧表、本ファイル = フック実行フロー表）。
README 内の突合対象節も互いに重ならない。

突合相手は Claude 側 `hooks.json` を基本とする。
表が Claude 側の構成を記述しているため。
`hooks-copilot.json` は次の点で意図的に非対称なため、Copilot 専用のエントリ（`_COPILOT_ONLY_SCRIPTS`）だけを補う。
補う元は `hooks-copilot.json`。

- Notification イベントを持たない。Copilot CLI 非対応のため除外している
  対象は `hooks-copilot.json` で、description に次の文言を明記している。
  "Notification event excluded for Copilot CLI compatibility"。
- WebSearch の登録（`pre-tool-use-websearch.sh`）を持たない。
  `websearch-allow.sh` が返す `permissionDecision: allow` は Claude Code 形式。
  Copilot CLI での allow 応答は実機未検証のため、Claude 側のみに登録している。
  #789 で追跡中で、in-tree の参照は `lib/mcp-handlers/context7-allow.sh`。
- Stop は `stop-copilot.sh`（PTY ベル）を指す。Claude 側は `stop.sh`（`terminalSequence`）を指す。
- Skill / MCP の matcher が Copilot のツール名（`skill` / `github-mcp-server-create_pull_request`）を足している。
  matcher の個別の値は `lib/tests/test_hooks_definitions.py` が固定する。

検知できないこと（表の記述粒度に由来する限界）は次のとおり。

- lib は basename でのみ一致を見る。
  `lib/post-tool-use/auto-push.sh` と `lib/stop/auto-push.sh` のようなディレクトリ取り違えは検知できない。
  解決したフルパスに対する `path.exists()` が代替の防御になる。
- 「コアガード群」（lib/core 配下）は、表が内訳を列挙していないため、中身の増減は検知対象外。
  `session-start-common` 配下は実名 6 本に展開済みで、突合対象になっている。
- 中継の追跡は 1 段まで（エントリ → `_RELAY_DISPATCHERS` の lib → その配下）。
  中継先がさらに別の lib を呼ぶ場合、その先は検知しない。
- 中継先は集合比較のため、呼び出し順を検証しない。
  `lib/session-start-common.sh:32-34` は、`gitignore-untrack-notice` を gitignore 再生成の後に置くことを安定性要件としている。
  順序の逆転は、本テストでは落ちない。
- 括弧内注記（`(Claude Code)` / `（deny 系 → tech-advisor-clone-allow）` 等）は、1 段深い呼び出しの参考記載。
  エントリスクリプトの直接呼び出しとはみなさない。
- `session-start-*.sh` 行は、matcher とスクリプトの 1:1 対応を表が書いていない。
  そのため、この行だけは matcher 集合の一致までしか担保しない。
"""

from __future__ import annotations

import fnmatch
import json
import re
from pathlib import Path
from typing import NamedTuple

import pytest

# 表の「lib ディスパッチ」列に現れる総称表記。実体スクリプト名ではないため lib 名の
# 突合対象から外す。ここに無い非 lib 名トークンは fail させる（静かな脱落の禁止）。
_GENERIC_LIB_LABELS: frozenset[str] = frozenset(
    {
        "コアガード群",  # lib/core 配下のガード群。表は内訳を列挙していない
    }
)

# 実体側で呼ばれるが表の「lib ディスパッチ」に載せない lib。
# ディレクトリ単位の一括除外はしない（除外理由を 1 件ずつ明示するため）。
_EXCLUDED_LIBS: frozenset[str] = frozenset(
    {
        "merge-hook-outputs",  # 複数 hook 出力を単一 JSON に合成するユーティリティ
        "pecot-dir-init",  # .pecot ディレクトリ初期化ユーティリティ
        # .pecot 既存リポの .gitignore を単一出所から再生成するユーティリティ。
        # pecot_hook_enabled の設定キーを持たず、表の「lib ディスパッチ」対象外。
        "pecot-gitignore-ensure",
    }
)

# 列 3 の「→」を、「別ディスパッチャへの中継」と解釈する lib。
# 対象の lib は、列 3 の先頭セグメントで 1 つだけ現れる行のとき、以降のセグメントを中継先として分離する。
# 先頭セグメントには、エントリが直接呼ぶ他の lib が並んでもよい（`session-title, session-start-common → …` のような形）。
# 名前で限定しているのは、新しい中継ディスパッチャの明示登録を強制する装置としてのため。
# 未登録のまま表へ中継行を足すと「エントリからの順次実行」と解釈され、中継先 lib が
# エントリの直接呼び出しに含まれないため lib 突合で落ちる（気づかれないまますり抜けしない）。
_RELAY_DISPATCHERS: frozenset[str] = frozenset(
    {
        "session-start-common",  # SessionStart の共通ディスパッチャ。配下 lib を順次呼ぶ
        "mcp-dispatcher",  # PreToolUse(mcp__.*) の deny/allow 分岐（#856）
    }
)

# `hooks-copilot.json` にだけ配線され、表に Copilot 用の行として載るエントリ。
_COPILOT_ONLY_SCRIPTS: frozenset[str] = frozenset({"stop-copilot.sh"})

# 表の第 1 列で「matcher 指定なし（全ツール対象）」を表すラベル。
_NO_MATCHER_LABEL = "全ツール"

_README_SECTION_HEADING = "## フック実行フロー"

# 見出しは行単位の完全一致で探す。
# 部分一致の検索にすると、接頭辞を保った改名を取り逃がす。
# 例は `## フック実行フロー（旧）` で、節が特定できたまま、すり抜けてしまう。
_README_SECTION_RE = re.compile(rf"^{re.escape(_README_SECTION_HEADING)}$", re.MULTILINE)

# 第 1 列 `Event` / `Event (matcher)`。matcher に `/` を含む行（SessionStart）は分割する。
_TRIGGER_RE = re.compile(r"^(?P<event>[A-Za-z]+)(?:\s*\((?P<matcher>[^)]*)\))?$")

# 第 3 列の括弧注記。半角 `(Claude Code)` と全角 `（deny 系 → …）` の両系統を落とす。
_PAREN_NOTE_RE = re.compile(r"[(（][^)）]*[)）]")

# lib 名として妥当なトークン。これに合致せず総称表記でもない残余は fail させる。
_LIB_NAME_RE = re.compile(r"[a-z0-9-]+")

# 実体側: 冒頭の変数代入（`LIB_DIR=…` / `LIB_DIR_PRE=…` 等）。変数名はハードコード
# 列挙せず汎用パターンで拾う。新しい基点変数を足しても抽出が追随する。
_VAR_ASSIGN_RE = re.compile(r"""^\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)=(?P<value>"[^"]*"|\S+)\s*$""")

# 実体側: `"$LIB_DIR/x.sh"` 形式の呼び出し。merge-hook-outputs.sh 経由では 1 行に
# 複数並ぶため finditer で全件拾う。
_QUOTED_SH_RE = re.compile(r'"([^"]*\.sh)"')

# 変数参照 `$VAR` / `${VAR}`。`$0` や `$(...)` には意図的にマッチしない
# （SCRIPT_DIR の `$(cd … && pwd)` を解決不能として弾き、事前シード値を守るため）。
_VAR_REF_RE = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?")

# `source` / `.` による読み込み行。
# 現シェルへ関数を読み込むだけで、サブプロセスとしての lib ディスパッチではないため、抽出対象から外す。
# 該当するのは、session-start-common.sh の config-dispatcher.sh。
# `_EXCLUDED_LIBS`（ディスパッチされるが表に載せない lib の allowlist）とは意味が異なる。
# そのため、名前ではなく行の種類で判定する。
_SOURCE_LINE_RE = re.compile(r"^\s*(?:source|\.)\s")


class _FlowRow(NamedTuple):
    """表の 1 行（継続行を結合済み）。"""

    event: str
    matchers: tuple[str | None, ...]
    script_pattern: str
    libs: frozenset[str]
    relay_via: str | None
    relay_libs: frozenset[str]
    raw: str


@pytest.fixture(scope="session")
def hooks_dir(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks"


def _strip_comment(line: str) -> str:
    """行末コメントを落とす。

    エントリスクリプトのクオート内に `#` を含む例は現状存在しないため単純除去でよい。
    コメント内に `merge-hook-outputs.sh` 等が裸で登場するため、`.sh` 抽出の前段に必須。
    """
    return line.split("#", 1)[0]


# README 表側のパース。


def _flow_table_lines(hooks_dir: Path) -> list[str]:
    """「フック実行フロー」節のコードフェンス内の行を返す。"""
    text = (hooks_dir / "README.md").read_text(encoding="utf-8")
    heading = _README_SECTION_RE.search(text)
    assert heading is not None, (
        f"README に見出し `{_README_SECTION_HEADING}` がありません。"
        "見出しを改名した場合は本テストの _README_SECTION_HEADING も更新すること"
    )
    end = text.find("\n## ", heading.end())
    section = text[heading.start() :] if end == -1 else text[heading.start() : end]

    fence_indices = [
        index for index, line in enumerate(section.splitlines()) if line.startswith("```")
    ]
    assert len(fence_indices) == 2, (
        f"`{_README_SECTION_HEADING}` 節のコードフェンスがちょうど 1 組ではありません"
        f"（``` 行を {len(fence_indices)} 個検出）。フロー表を複数フェンスに分割した場合は"
        "本テストのパーサも更新すること"
    )
    return section.splitlines()[fence_indices[0] + 1 : fence_indices[1]]


def _flow_table_body(hooks_dir: Path) -> list[str]:
    """ヘッダー行と罫線行を形状 assert しつつ消費し、データ行だけを返す。"""
    lines = _flow_table_lines(hooks_dir)
    assert len(lines) >= 2, "フロー表にヘッダー行・罫線行がありません"

    header, rule, *body = lines
    assert header.startswith("settings.json") and header.count("→") == 2, (
        f"フロー表のヘッダー行が想定形（`settings.json …→…→…`）ではありません: {repr(header)}"
    )
    assert rule.strip() and set(rule.strip()) == {"─"}, (
        f"フロー表の罫線行が `─` のみで構成されていません: {repr(rule)}"
    )
    return body


def _join_continuations(body: list[str]) -> list[str]:
    """非空白開始行を新エントリ、空白開始行を直前エントリの継続として結合する。"""
    entries: list[str] = []
    for line in body:
        if not line.strip():
            continue
        if line[0].isspace():
            assert entries, f"継続行が先頭に現れました（対応する行がありません）: {repr(line)}"
            entries[-1] = f"{entries[-1]} {line.strip()}"
        else:
            entries.append(line.rstrip())
    return entries


def _parse_trigger(cell: str, raw: str) -> tuple[str, tuple[str | None, ...]]:
    """第 1 列を (event, matcher 群) に分解する。matcher 無指定は None で表す。"""
    match = _TRIGGER_RE.match(cell)
    assert match, f"フロー表の第 1 列が `Event` / `Event (matcher)` 形式ではありません: {repr(raw)}"
    event = match.group("event")
    matcher = match.group("matcher")
    if matcher is None or matcher.strip() == _NO_MATCHER_LABEL:
        return event, (None,)
    return event, tuple(part.strip() for part in matcher.split("/"))


def _lib_tokens(segment: str, raw: str) -> list[str]:
    """第 3 列の 1 セグメントを lib 名トークンへ分割する。総称表記は結果から除く。"""
    tokens = [token.strip() for token in re.split(r"[,/]", segment)]
    for token in tokens:
        if token and not _LIB_NAME_RE.fullmatch(token) and token not in _GENERIC_LIB_LABELS:
            pytest.fail(
                f"フロー表の lib ディスパッチ列に、lib 名とも総称表記とも読めない"
                f"トークン `{token}` があります（行: {repr(raw)}）。総称表記を追加した場合は"
                "本テストの _GENERIC_LIB_LABELS にも理由付きで追記すること"
            )
    return [token for token in tokens if token and _LIB_NAME_RE.fullmatch(token)]


def _parse_libs(cell: str, raw: str) -> tuple[frozenset[str], str | None, frozenset[str]]:
    """第 3 列を (エントリが呼ぶ lib, 中継元 lib, 中継先 lib) に分解する。

    括弧注記の除去は「→」分割より先に行う。逆順にすると
    `（deny 系 → tech-advisor-clone-allow）` の内側の「→」でセグメントが割れ、
    さらに `deny 系` が lib 名候補として誤検知される。

    第 1 セグメントに中継ディスパッチャ（`_RELAY_DISPATCHERS`）が 1 つ含まれるときに限り、「中継」と解釈する。
    この場合は、以降を中継先として分離する。
    第 1 セグメントの他のトークンは、エントリが直接呼ぶ lib（`session-start.sh` の `session-title`）。
    それ以外は、全セグメントのトークンをエントリからの順次実行として扱う。
    未登録の中継を順次実行と解釈させ、lib 突合で落とすための手段として残す。
    """
    segments = _PAREN_NOTE_RE.sub(" ", cell).split("→")
    tokens_per_segment = [_lib_tokens(segment, raw) for segment in segments]
    head = tokens_per_segment[0]
    relays = [token for token in head if token in _RELAY_DISPATCHERS]
    if len(tokens_per_segment) > 1 and len(relays) == 1:
        relay = [token for segment in tokens_per_segment[1:] for token in segment]
        return frozenset(head), relays[0], frozenset(relay)
    return (
        frozenset(token for segment in tokens_per_segment for token in segment),
        None,
        frozenset(),
    )


def _flow_rows(hooks_dir: Path) -> list[_FlowRow]:
    """フロー表の全データ行を構造化して返す。"""
    rows: list[_FlowRow] = []
    for raw in _join_continuations(_flow_table_body(hooks_dir)):
        # 列 3 の内部にも `→` が現れるため、先頭 2 個だけで 3 分割する。
        parts = raw.split("→", 2)
        assert len(parts) == 3, (
            f"フロー表のデータ行を `→` で 3 列に分割できません（`→` が不足）: {repr(raw)}"
        )
        trigger_cell, script_cell, lib_cell = (part.strip() for part in parts)
        assert script_cell.endswith(".sh"), (
            f"フロー表の第 2 列が `.sh` で終わっていません: {repr(script_cell)}（行: {repr(raw)}）"
        )
        event, matchers = _parse_trigger(trigger_cell, raw)
        libs, relay_via, relay_libs = _parse_libs(lib_cell, raw)
        rows.append(_FlowRow(event, matchers, script_cell, libs, relay_via, relay_libs, raw))
    return rows


def _expand_pattern(hooks_dir: Path, pattern: str) -> list[str]:
    """第 2 列のスクリプト名（`session-start-*.sh` 等の glob 可）を実体名へ展開する。"""
    if "*" not in pattern:
        return [pattern]
    matched = sorted(
        path.name for path in hooks_dir.glob("*.sh") if fnmatch.fnmatch(path.name, pattern)
    )
    assert matched, f"フロー表の `{pattern}` に一致するスクリプトが hooks/ 直下にありません"
    return matched


# hooks.json 側の抽出。


def _hooks_json_entries(hooks_dir: Path) -> set[tuple[str, str | None, str]]:
    """hooks.json（と hooks-copilot.json の Copilot 専用エントリ）から (event, matcher, スクリプト basename) の 3 要素の組の集合を作る。"""
    entries: set[tuple[str, str | None, str]] = set()
    for filename, only in (("hooks.json", None), ("hooks-copilot.json", _COPILOT_ONLY_SCRIPTS)):
        config = json.loads((hooks_dir / filename).read_text(encoding="utf-8"))
        for event, blocks in config["hooks"].items():
            for block in blocks:
                matcher = block.get("matcher")
                for hook in block["hooks"]:
                    name = Path(hook["command"]).name
                    if only is None or name in only:
                        entries.add((event, matcher, name))
    return entries


def _normalize_to_patterns(
    entries: set[tuple[str, str | None, str]], patterns: list[str]
) -> set[tuple[str, str | None, str]]:
    """basename が表の glob に一致するものをそのパターン表記へ寄せる。

    `session-start-*.sh` 行は、matcher とスクリプトの 1:1 対応を表が書いていない。
    そのため、3 要素の組の比較対象をパターン単位に落とす（この行のみ matcher 集合の一致までを担保）。
    """
    globs = [pattern for pattern in patterns if "*" in pattern]
    normalized: set[tuple[str, str | None, str]] = set()
    for event, matcher, name in entries:
        replaced = next((glob for glob in globs if fnmatch.fnmatch(name, glob)), name)
        normalized.add((event, matcher, replaced))
    return normalized


# エントリスクリプト実体側の抽出。


def _entry_scripts(hooks_dir: Path) -> list[Path]:
    """`hooks/` 直下のエントリスクリプト。lib 配下は含めない。"""
    return sorted(hooks_dir.glob("*.sh"))


def _resolve_vars(hooks_dir: Path, script_dir: Path, lines: list[str]) -> dict[str, str]:
    """スクリプト冒頭の変数代入を収集し、既知の基点変数で再帰展開する。"""
    variables = {
        # 各スクリプトの `$(cd "$(dirname "$0")" && pwd)` 相当。エントリスクリプトでは
        # hooks/ と同値だが、中継先の lib/session-start-common.sh では lib/ になる。
        "SCRIPT_DIR": str(script_dir),
        # `${CLAUDE_PLUGIN_ROOT}/hooks/...` 形式の呼び出し用。hooks/ の親がプラグイン
        # ルート。スクリプトの位置に依存しないため script_dir 由来にはしない。
        "CLAUDE_PLUGIN_ROOT": str(hooks_dir.parent),
    }
    for line in lines:
        match = _VAR_ASSIGN_RE.match(line)
        if not match:
            continue
        expanded = _expand_vars(match.group("value").strip('"'), variables)
        # `$(cd … && pwd)` のような未解決参照が残る代入は採らない（シード値を守る）。
        if expanded is not None:
            variables[match.group("name")] = expanded
    return variables


def _expand_vars(value: str, variables: dict[str, str]) -> str | None:
    """`$VAR` / `${VAR}` を展開する。未知参照や `$` の残留があれば None。"""
    expanded = _VAR_REF_RE.sub(lambda m: variables.get(m.group(1), m.group(0)), value)
    return None if "$" in expanded else expanded


def _dispatched_paths(hooks_dir: Path, script: Path) -> dict[str, Path]:
    """スクリプトが呼ぶ lib の {名前: 解決済みパス}。除外 lib と source 行は落とす。"""
    lines = [_strip_comment(line) for line in script.read_text(encoding="utf-8").splitlines()]
    variables = _resolve_vars(hooks_dir, script.parent, lines)

    dispatched: dict[str, Path] = {}
    for lineno, line in enumerate(lines, 1):
        location = f"{script.name}:{lineno}"
        if _SOURCE_LINE_RE.match(line):
            continue
        for raw_path in _QUOTED_SH_RE.findall(line):
            resolved = _expand_vars(raw_path, variables)
            assert resolved is not None, (
                f"{location}: `.sh` 呼び出しのパス `{raw_path}` に未解決の変数参照が"
                "残ります。新しい基点変数を導入した場合は本テストの _resolve_vars も"
                "更新すること"
            )
            path = Path(resolved)
            assert path.exists(), f"{location}: 呼び出し先 `{resolved}` が存在しません"
            dispatched[path.stem] = path
        # クオートされていない `.sh` を静かに取りこぼさないためのガード。
        assert ".sh" not in _QUOTED_SH_RE.sub(" ", line), (
            f"{location}: クオートで囲まれていない `.sh` 参照があります: {repr(line.strip())}。"
            "抽出抜けになるため本テストの _QUOTED_SH_RE を拡張すること"
        )
    return {name: path for name, path in dispatched.items() if name not in _EXCLUDED_LIBS}


def _dispatched_libs(hooks_dir: Path, script: Path) -> frozenset[str]:
    """スクリプトが呼ぶ lib 名（basename から `.sh` を除いたもの）を返す。"""
    return frozenset(_dispatched_paths(hooks_dir, script))


# 検証。


def test_flow_table_scripts_match_hooks_json(hooks_dir: Path):
    """表の第 2 列と hooks.json の command basename が集合として一致すること。"""
    rows = _flow_rows(hooks_dir)
    table = {name for row in rows for name in _expand_pattern(hooks_dir, row.script_pattern)}
    configured = {name for _, _, name in _hooks_json_entries(hooks_dir)}
    assert table - configured == set(), (
        "README フロー表にあるが hooks.json に登録されていないスクリプト"
        f"（表の削除抜け、または hooks.json への追記抜け）: {sorted(table - configured)}"
    )
    assert configured - table == set(), (
        "hooks.json に登録されているが README フロー表に無いスクリプト"
        f"（表への追記抜け）: {sorted(configured - table)}"
    )


def test_flow_table_triggers_match_hooks_json(hooks_dir: Path):
    """表の (トリガー, スクリプト) 対応が hooks.json と一致すること。

    集合比較ではなく、3 要素の組の比較にする。
    event / matcher / スクリプトを個別に集合比較すると、行同士でスクリプトを取り違えた表がすり抜ける。
    すり抜ける例は、`PreToolUse (Bash)` と `PreToolUse (Skill)` の入れ替え等。
    """
    rows = _flow_rows(hooks_dir)
    patterns = [row.script_pattern for row in rows]
    table = {(row.event, matcher, row.script_pattern) for row in rows for matcher in row.matchers}
    configured = _normalize_to_patterns(_hooks_json_entries(hooks_dir), patterns)
    assert table - configured == set(), (
        "README フロー表にあるが hooks.json に無い (イベント, matcher, スクリプト) の"
        f"対応: {sorted(map(str, table - configured))}"
    )
    assert configured - table == set(), (
        "hooks.json にあるが README フロー表に無い (イベント, matcher, スクリプト) の"
        f"対応: {sorted(map(str, configured - table))}"
    )


def test_flow_table_libs_match_entry_scripts(hooks_dir: Path):
    """表の lib ディスパッチ列がエントリスクリプトの実呼び出しと行単位で一致すること。

    表全体をまとめた集合比較にはしない（lib 名が行間を移動しても検知できないため）。
    走査キーはフロー表の第 2 列と `hooks/` 直下の実体の和集合とする。
    hooks.json と表のどちらにも現れない、未登録スクリプトの増加も落とす。
    """
    rows = _flow_rows(hooks_dir)
    expected: dict[str, frozenset[str]] = {
        name: row.libs for row in rows for name in _expand_pattern(hooks_dir, row.script_pattern)
    }
    actual = {
        script.name: _dispatched_libs(hooks_dir, script) for script in _entry_scripts(hooks_dir)
    }

    assert set(expected) - set(actual) == set(), (
        "README フロー表に載っているが hooks/ 直下に実体が無いスクリプト: "
        f"{sorted(set(expected) - set(actual))}"
    )
    assert set(actual) - set(expected) == set(), (
        "hooks/ 直下に実体があるが README フロー表に載っていないスクリプト: "
        f"{sorted(set(actual) - set(expected))}"
    )

    mismatches = {
        name: (sorted(expected[name] - actual[name]), sorted(actual[name] - expected[name]))
        for name in sorted(expected)
        if expected[name] != actual[name]
    }
    assert mismatches == {}, (
        "README フロー表の lib ディスパッチとスクリプト実体の不一致 "
        f"{{スクリプト: (表側の差分, 実体側の差分)}}: {mismatches}"
    )


def test_flow_table_relay_dispatch_matches_dispatcher_script(hooks_dir: Path):
    """表の中継先 lib が中継元ディスパッチャの実呼び出しと一致すること。

    突合対象のディスパッチャは、エントリスクリプトの解決済み呼び出しから求める（パスをハードコードしない）。
    表が中継元として書いた lib が、実際にそのエントリスクリプトから呼ばれていることも、併せて assert する。
    これが無いと、表の中継記述が実体と無関係でも、中継先の一致だけで pass してしまう。
    """
    rows = [row for row in _flow_rows(hooks_dir) if row.relay_via is not None]
    assert rows, (
        "フロー表に中継記述（`<ディスパッチャ> → <中継先>`）が 1 行もありません。"
        "中継を廃止した場合は本テストの _RELAY_DISPATCHERS も更新すること"
    )
    for row in rows:
        for name in _expand_pattern(hooks_dir, row.script_pattern):
            entry_dispatch = _dispatched_paths(hooks_dir, hooks_dir / name)
            assert row.relay_via in entry_dispatch, (
                f"{name} は表が中継元とする `{row.relay_via}` を呼んでいません"
                f"（実呼び出し: {sorted(entry_dispatch)}、行: {repr(row.raw)}）"
            )
            actual = frozenset(_dispatched_paths(hooks_dir, entry_dispatch[row.relay_via]))
            assert row.relay_libs - actual == set(), (
                f"README フロー表にあるが `{row.relay_via}` から呼ばれていない中継先"
                f"（表の削除抜け）: {sorted(row.relay_libs - actual)}"
            )
            assert actual - row.relay_libs == set(), (
                f"`{row.relay_via}` から呼ばれているが README フロー表に無い中継先"
                f"（表への追記抜け）: {sorted(actual - row.relay_libs)}"
            )


def test_copilot_only_scripts_are_wired_only_in_copilot_definition(hooks_dir: Path):
    """Copilot 専用エントリは hooks-copilot.json にだけ配線され、hooks.json には無いこと。"""
    claude = json.loads((hooks_dir / "hooks.json").read_text(encoding="utf-8"))
    copilot = json.loads((hooks_dir / "hooks-copilot.json").read_text(encoding="utf-8"))

    def names(config: dict) -> set[str]:
        return {
            Path(hook["command"]).name
            for blocks in config["hooks"].values()
            for block in blocks
            for hook in block["hooks"]
        }

    assert _COPILOT_ONLY_SCRIPTS <= names(copilot)
    assert names(claude) & _COPILOT_ONLY_SCRIPTS == set()
