"""定義書から sphinx-needs の need とページを作る拡張。

- ``iface-defs <plugin> [<項目の ID> | common]``: コマンド・ツールを cmd、振る舞いを behavior の need にする。
  2 つ目を渡すと、その項目とその振る舞いだけ（``common`` は共通の振る舞いだけ）を出す
- ``iface-index <plugin>``: コマンド・ツールの一覧を、各ページへのリンクの表にする
- ``iface-common-output <plugin>``: すべての MCP ツールの実行結果に共通する項目の表を出す
- ``iface-resources <plugin>``: MCP サーバが出す resource の表を出す

定義書の形式は lint-defs が守る。ここでは欠けた欄を警告にして、その項目を飛ばす。
"""

from __future__ import annotations

import json
import re
import shutil
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import yaml
from docutils import nodes
from sphinx.util import logging
from sphinx.util.docutils import SphinxDirective
from sphinx_needs.api import InvalidNeedException, NeedItemSource, create_need
from sphinx_needs.utils import add_doc

if TYPE_CHECKING:
    from sphinx.application import Sphinx
    from sphinx.config import Config
    from sphinx.util.typing import ExtensionMetadata

logger = logging.getLogger(__name__)

# encodeURIComponent が変えない文字。この形の ID は、そのまま URL の query に書ける。
_URI_SAFE_ID = re.compile(r"[A-Za-z0-9\-_.!~*'()]+")


# ---------------------------------------------------------------- 定義書


# 用語と、その説明のページ。conf.py の iface_terms から入る。本文に出た用語をページへのリンクにする。
_TERMS: dict[str, str] = {}


def _load_terms(_app: Sphinx, config: Config) -> None:
    _TERMS.clear()
    _TERMS.update(cast("dict[str, str]", config.iface_terms))


def _plain(part: str, link: bool = False) -> str:
    """等幅にしない部分。rst の記号を無効にする。link のときは、用語の最初の 1 つをリンクにする。"""
    escaped = "".join("\\" + ch if ch in "*`|_\\" else ch for ch in part)
    if link:
        for term, target in _TERMS.items():
            # 前後に「\ 」を置くと、日本語の文字に続けて書いた用語も role として読まれる。
            escaped = escaped.replace(term, f"\\ :doc:`{term} <{target}>`\\ ", 1)
    return escaped


def _esc(value: object, link: bool = False) -> str:
    """list-table のセルや段落に入れる文字列。rst の記号を無効にし、改行を空白にする。

    link を付けるのは、ページの冒頭の文と引数の説明だけ。用語が出るたびにリンクにはしない。
    """
    text = " ".join(str(value).split())
    parts = re.split(r"`([^`]+)`", text)
    return "".join(_lit(part) if i % 2 else _plain(part, link) for i, part in enumerate(parts))


def _lit(value: object) -> str:
    """識別子を等幅で出す。前後の文字とつながっても role が切れるよう、空白を \\ で挟む。"""
    text = " ".join(str(value).split())
    return f"\\ ``{text}``\\ " if text and "`" not in text else _esc(text)


def _table(
    title: str, header: list[str], rows: Sequence[Sequence[object]], code: int = 1
) -> list[str]:
    """表。先頭の code 列は識別子なので等幅にする。"""
    if not rows:
        return []
    out = [f".. list-table:: {_esc(title)}".rstrip(), "   :header-rows: 1", "   :widths: auto", ""]
    out += [("   * - " if i == 0 else "     - ") + _esc(cell) for i, cell in enumerate(header)]
    for row in rows:
        out += [
            ("   * - " if i == 0 else "     - ") + (_lit(cell) if i < code else _esc(cell))
            for i, cell in enumerate(row)
        ]
    return [*out, ""]


def _para(text: object) -> list[str]:
    return [_esc(text), ""]


def _fields(pairs: list[tuple[str, object]]) -> list[str]:
    return [*(f"- **{_esc(label)}**: {_esc(value)}" for label, value in pairs), ""]


_MISSING = object()


def _get(data: dict[str, Any], dotted: str) -> object:
    current: Any = data
    for key in dotted.split("."):
        if not isinstance(current, dict) or key not in current:
            return _MISSING
        current = cast("dict[str, Any]", current)[key]
    return cast("object", current)


COMMON = "common"
PAGES_DIR = Path("_generated")


# 書くことが無いときの決まった値。この値の欄はページに出さない。
_NOTHING = {"stdin": "none", "diagnostics": "default", "on_error": "default"}


def _type(spec: dict[str, Any]) -> str:
    if "enum" in spec:
        return " | ".join(
            json.dumps(v, ensure_ascii=False) for v in cast("list[Any]", spec["enum"])
        )
    if "const" in spec:
        return json.dumps(spec["const"], ensure_ascii=False)
    if "anyOf" in spec:
        branches = cast("list[Any]", spec["anyOf"])
        return " | ".join(_type(cast("dict[str, Any]", b)) for b in branches if isinstance(b, dict))
    kind = spec.get("type", "")
    return " | ".join(cast("list[str]", kind)) if isinstance(kind, list) else str(kind)


def _schema(value: object) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """JSON Schema の object から、項目とその必須の名前を取り出す。"""
    body = cast("dict[str, Any]", value) if isinstance(value, dict) else {}
    properties = {
        str(name): cast("dict[str, Any]", spec) if isinstance(spec, dict) else {}
        for name, spec in cast("dict[str, Any]", body.get("properties", {})).items()
    }
    return properties, cast("list[str]", body.get("required", []))


# MCP のツールの引数と、action の入力（with:）を書く object type。setup で登録する。
MCP_ARG = "mcparg"
ACTION_INPUT = "actioninput"
# 呼ぶリポ。action の使用例の uses: に書く。
ACTION_REPOSITORY = "pecotcraft/pecot"


def _surfaces(entry: dict[str, Any]) -> dict[str, Any]:
    return cast("dict[str, Any]", entry.get("surfaces", {}))


def _action_path(entry: dict[str, Any]) -> str | None:
    path = _get(entry, "surfaces.action.path")
    return str(path) if isinstance(path, str) else None


def _tool(entry: dict[str, Any]) -> str | None:
    """呼ぶときの名前。MCP のツール名か、action の uses: の名前。"""
    tool = _get(entry, "surfaces.mcp.tool")
    if isinstance(tool, str):
        return tool
    path = _action_path(entry)
    return f"{ACTION_REPOSITORY}/{path}" if path is not None else None


def _is_action(entry: dict[str, Any]) -> bool:
    """action の面だけを持つ項目か。"""
    return "mcp" not in _surfaces(entry) and _action_path(entry) is not None


def _parameter(entry: dict[str, Any], name: str, spec: dict[str, Any], required: bool) -> list[str]:
    """引数 1 つ。名前・説明・項目（field list）の順に書く。

    MCP の引数は拡張の mcparg で、action の入力は actioninput で書く。
    """
    written = cast("dict[str, str]", entry.get("arguments", {}))
    notes = cast("dict[str, str]", entry.get("default_notes", {}))
    text = " ".join(
        t for t in (written.get(name, spec.get("description", "")), notes.get(name)) if t
    )
    rows: list[tuple[str, object]] = [
        ("指定", "必須" if required else "省略可"),
        ("型", _type(spec) if "enum" not in spec else spec.get("type", "")),
    ]
    if "default" in spec:
        rows.append(("既定値", json.dumps(spec["default"], ensure_ascii=False)))
    if "enum" in spec:
        rows.append(("指定可能な値", ", ".join(str(v) for v in cast("list[Any]", spec["enum"]))))
    body = [_esc(text, link=True), "", *(f":{key}: {_esc(value)}" for key, value in rows), ""]
    # 同じ名前の引数は別のツールにもあるので、索引に載せない
    surfaces = _surfaces(entry)
    directive = MCP_ARG if "mcp" in surfaces else ACTION_INPUT
    head = [f".. {directive}:: {name}", "   :no-index:"]
    return [*head, "", *(f"   {line}" if line else "" for line in body)]


def _parameters(entry: dict[str, Any]) -> list[str]:
    """引数の一覧。必須のものを先に、省略できるものを後に並べる。"""
    properties, required = _schema(entry.get("input"))
    return [
        line
        for wanted in (True, False)
        for name, spec in properties.items()
        if (name in required) == wanted
        for line in _parameter(entry, name, spec, wanted)
    ]


def _call_block(tool: str, arguments: object) -> list[str]:
    """tools/call の params の name と arguments（MCP の仕様の Calling Tools の形）。"""
    text = json.dumps({"name": tool, "arguments": arguments}, ensure_ascii=False, indent=2)
    return [".. code-block:: json", "", *(f"   {line}" for line in text.splitlines()), ""]


def _uses_block(uses: str, inputs: object) -> list[str]:
    """ワークフローの step。uses: の版は、利用者のリポで固定する SHA の代わりに <ref> と書く。"""
    step: dict[str, object] = {"uses": f"{uses}@<ref>"}
    if isinstance(inputs, dict) and inputs:
        step["with"] = inputs
    text = yaml.safe_dump([step], allow_unicode=True, sort_keys=False, default_flow_style=False)
    return [".. code-block:: yaml", "", *(f"   {line}" for line in text.splitlines()), ""]


def _examples(entry: dict[str, Any]) -> list[str]:
    tool = _tool(entry) or str(entry.get("name", ""))
    is_action = _is_action(entry)
    lines: list[str] = []
    for example in cast("list[dict[str, Any]]", entry.get("examples", [])):
        block = _uses_block if is_action else _call_block
        lines += [*_para(example["note"]), *block(tool, example["arguments"])]
    return lines


def _constraint(item: object) -> str:
    body = cast("dict[str, Any]", item) if isinstance(item, dict) else {}
    if "conflicts" in body:
        names = "・".join(f"`{n}`" for n in cast("list[str]", body["conflicts"]))
        return f"{names} は、同時に指定できません。"
    if "requires" in body:
        return " ".join(
            f"`{name}` を指定するときは、{'・'.join(f'`{n}`' for n in needs)} も指定します。"
            for name, needs in cast("dict[str, list[str]]", body["requires"]).items()
        )
    return json.dumps(item, ensure_ascii=False)


MCP_FIELDS_EMPTY = "ツールごとに返す項目はありません。"
COMMON_OUTPUT_TITLE = "出力"
# structuredContent の最上位に、ツールの項目と並べて置く全ツールに共通の項目。ツールごとの表には出さない。
_MCP_COMMON = ("kind", "detail", "log", "warnings")


def _mcp_output(entry: dict[str, Any]) -> list[str]:
    """MCP の structuredContent のツールごとの項目の表。説明は mcp_output を先に、無ければ schema の description を使う。"""
    output = _get(entry, "mcp.output")
    if not isinstance(output, dict):
        return []
    body = cast("dict[str, Any]", output)
    authored = cast("dict[str, Any]", entry.get("mcp_output", {}))
    written = cast("dict[str, str]", authored.get("fields", {}))
    properties, _ = _schema(body)
    rows = [
        [name, _type(spec), written.get(name, spec.get("description", ""))]
        for name, spec in properties.items()
        if name not in _MCP_COMMON
    ]
    lines = _table("MCP の結果の項目", ["項目名", "型", "説明"], rows) or _para(MCP_FIELDS_EMPTY)
    plugin = entry.get(PLUGIN_KEY)
    if plugin is None:
        return lines
    target = f":ref:`{COMMON_OUTPUT_TITLE} <{common_output_label(str(plugin))}>`"
    return [
        *lines,
        f"エラーと警告の項目については、共通仕様の\\ {target}\\ を参照してください。",
        "",
    ]


# render_sections へ渡す項目の、プラグインの名前を載せるキー。定義書の欄ではない。
PLUGIN_KEY = "_plugin"


def common_output_label(plugin: str) -> str:
    """共通仕様のページの、出力の節のラベル。ページの rst が、節の前に同じ名前で置く。"""
    return f"iface-common-output-{plugin}"


def common_output_rows(generated: dict[str, Any], authored: dict[str, Any]) -> list[list[str]]:
    """共通の項目の表の行。説明は common_mcp_output、型は最初の MCP ツールの mcp.output から取る。"""
    common = _get(authored, "common_mcp_output.fields")
    written = cast("dict[str, str]", common) if isinstance(common, dict) else {}
    entries = cast("list[dict[str, Any]]", generated.get("entries", []))
    outputs = [o for o in (_get(g, "mcp.output") for g in entries) if o is not _MISSING]
    properties, _ = _schema(outputs[0] if outputs else None)
    return [
        [name, _type(properties.get(name, {})), written[name]]
        for name in _MCP_COMMON
        if name in written
    ]


def resource_rows(generated: dict[str, Any], authored: dict[str, Any]) -> list[list[str]]:
    """resource の表の行。説明は authored の summary、無ければ generated の description。"""
    written = authored.get("resources")
    summaries = cast("dict[str, Any]", written) if isinstance(written, dict) else {}
    rows: list[list[str]] = []
    for r in cast("list[dict[str, Any]]", generated.get("resources", [])):
        uri = str(r.get("uri", "?"))
        item = summaries.get(uri)
        summary = cast("dict[str, Any]", item).get("summary") if isinstance(item, dict) else None
        description = str(summary or r.get("description", ""))
        rows.append([uri, str(r.get("name", "")), description, str(r.get("mimeType", ""))])
    return rows


def _stdout(entry: dict[str, Any]) -> list[str]:
    """action の step のログ・標準入力・標準エラー。"""
    output = cast("dict[str, Any]", entry.get("output", {}))
    lines: list[str] = []
    if output.get("format") != "none" and output.get("description"):
        lines += _para(output["description"])
    properties, _ = _schema(output.get("schema"))
    written = cast("dict[str, str]", output.get("fields", {}))
    rows = [
        [
            name,
            _type(spec),
            written.get(name, spec.get("description", "")),
        ]
        for name, spec in properties.items()
    ]
    lines += _table("", ["項目名", "型", "説明"], rows)
    extra = [
        (label, entry[key])
        for key, label in (("stdin", "標準入力"), ("diagnostics", "標準エラー"))
        if key in entry and entry[key] != _NOTHING[key]
    ]
    return lines + (_fields(extra) if extra else [])


def _action_outputs(entry: dict[str, Any]) -> list[str]:
    """action の outputs の表。後の step が ``steps.<id>.outputs.<名前>`` で読む。"""
    outputs = _get(entry, "action.outputs")
    if not isinstance(outputs, dict):
        return []
    rows = [[name, text] for name, text in cast("dict[str, str]", outputs).items()]
    return _table("action の outputs", ["名前", "説明"], rows)


def _output(entry: dict[str, Any]) -> list[str]:
    """出力の節。MCP の項目は結果の項目だけ。action の項目は、step のログの行と outputs を出す。"""
    is_mcp = "mcp" in _surfaces(entry)
    return [*([] if is_mcp else _stdout(entry)), *_mcp_output(entry), *_action_outputs(entry)]


def _failures(entry: dict[str, Any]) -> tuple[str, list[str]]:
    """エラーの表。エラーの後に残る状態を、その下に書く。"""
    items = cast("list[dict[str, Any]]", entry.get("exit_status", []))
    lines = _table("", ["エラー名", "説明"], [[e.get("kind", ""), e["when"]] for e in items])
    if lines:
        lines.insert(1, "   :class: iface-errors")
    if "on_error" in entry and entry["on_error"] != _NOTHING["on_error"]:
        lines += _para(entry["on_error"])
    return "エラー", lines


def render_sections(entry: dict[str, Any]) -> list[tuple[str, list[str]]]:
    """項目のページの節。見出しは、いつも同じ順で返す。中身の無い節は出さない（Azure CLI・AWS CLI のリファレンスと同じ）。

    前提条件は、冒頭の説明の後ろに文として足す。コマンドのリファレンスは、前提条件の節を持たないため。
    定義書の environment は、使う人が設定するものではないので出さない。

    構文と引数の書き方は、Azure CLI のリファレンスに合わせる。
    見出しが空の節は、冒頭の説明と構文で、見出しを付けずに出す。
    """
    texts = [
        *(_esc(text, link=True) for text in cast("list[str]", entry.get("details", []))),
        *(_esc(text) for text in cast("list[str]", entry.get("prerequisites", []))),
    ]
    details = [line for text in texts for line in (text, "")]
    constraints = cast("list[object]", entry.get("constraints", []))
    arguments = _parameters(entry)
    if arguments and constraints:
        arguments = [*(f"- {_esc(_constraint(c))}" for c in constraints), "", *arguments]
    failure_title, failures = _failures(entry)
    sections = [
        ("", details),
        ("使用例", _examples(entry)),
        ("入力" if _is_action(entry) else "引数", arguments),
        ("出力", _output(entry)),
        (failure_title, failures),
    ]
    return [(title, lines) for title, lines in sections if lines]


def render_body(sections: list[tuple[str, list[str]]]) -> list[str]:
    """need の本文（needs.json に入る）。節の名前を太字で挟んで 1 つにつなぐ。"""
    return [
        line
        for title, lines in sections
        for line in (*([f"**{_esc(title)}**", ""] if title else []), *lines)
    ]


@dataclass(frozen=True)
class Behavior:
    id: str
    pattern: str
    statement: str
    belongs: str | None


@dataclass(frozen=True)
class Command:
    id: str
    name: str
    tags: list[str]
    body: list[str]
    description: str = ""
    deprecated: bool = False
    sections: list[tuple[str, list[str]]] = field(default_factory=lambda: [])
    # 表示名（MCP の Tool の title）と MCP のツール名。MCP の面の無い項目は name を使う。
    title: str = ""
    tool: str = ""

    @property
    def heading(self) -> str:
        return self.title or self.name

    @property
    def slug(self) -> str:
        """コマンドのページのファイル名。"""
        return re.sub(r"[^a-z0-9_.]+", "-", self.name.lower()).strip("-")


@dataclass
class Plan:
    commands: list[Command] = field(default_factory=lambda: [])
    behaviors: list[Behavior] = field(default_factory=lambda: [])
    warnings: list[str] = field(default_factory=lambda: [])
    common_output: list[list[str]] = field(default_factory=lambda: [])
    resources: list[list[str]] = field(default_factory=lambda: [])


def _behavior(raw: object, belongs: str | None) -> Behavior:
    item = cast("dict[str, Any]", raw)
    return Behavior(
        id=str(item["id"]),
        pattern=str(item["pattern"]),
        statement=str(item["statement"]),
        belongs=belongs,
    )


def _label(raw: object, default: str) -> str:
    if isinstance(raw, dict):
        return str(cast("dict[str, Any]", raw).get("id", default))
    return default


def build_plan(generated: dict[str, Any], authored: dict[str, Any]) -> Plan:
    plan = Plan(
        common_output=common_output_rows(generated, authored),
        resources=resource_rows(generated, authored),
    )
    plugin = {PLUGIN_KEY: generated["plugin"]} if "plugin" in generated else {}
    entries = cast("dict[str, dict[str, Any]]", authored.get("entries", {}))
    for g in cast("list[dict[str, Any]]", generated.get("entries", [])):
        gid = str(g.get("id", "?"))
        a = entries.get(gid)
        if a is None:
            plan.warnings.append(f"{gid}: authored.yaml に項目が無いため、飛ばしました")
            continue
        try:
            merged = {**g, **a, **plugin}
            sections = render_sections(merged)
            surfaces = cast("dict[str, Any]", g["surfaces"])
            tags = sorted(surfaces)
            title = _get(g, "mcp.title")
            command = Command(
                id=gid,
                name=str(g["name"]),
                tags=tags,
                body=render_body(sections),
                description=str(a.get("summary") or g.get("description", "")),
                deprecated=bool(g.get("deprecated", False)),
                sections=sections,
                title=title if isinstance(title, str) else "",
                tool=_tool(g) or str(g["name"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            plan.warnings.append(f"{gid}: 欄 {error} が欠けているか形が違うため、飛ばしました")
            continue
        plan.commands.append(command)
        for raw in cast("list[Any]", a.get("behaviors", [])):
            try:
                plan.behaviors.append(_behavior(raw, gid))
            except (KeyError, TypeError) as error:
                label = _label(raw, gid)
                plan.warnings.append(f"{label}: 欄 {error} が欠けているため、飛ばしました")
    for raw in cast("list[Any]", authored.get("common_behaviors", [])):
        try:
            plan.behaviors.append(_behavior(raw, None))
        except (KeyError, TypeError) as error:
            label = _label(raw, "common_behaviors")
            plan.warnings.append(f"{label}: 欄 {error} が欠けているため、飛ばしました")
    return plan


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


TARGETS = Path("libs/interface-spec/targets.json")


def _roots(root: Path) -> dict[str, str]:
    """targets.json で ``root`` を持つ定義書の名前と、その root（リポのルートから）。"""
    path = root / TARGETS
    if not path.is_file():
        return {}
    plugins = cast("dict[str, Any]", _load_json(path).get("plugins", {}))
    return {
        str(name): str(cast("dict[str, Any]", spec)["root"])
        for name, spec in plugins.items()
        if isinstance(spec, dict) and "root" in spec
    }


def interface_dir(root: Path, plugin: str) -> Path:
    """定義書のディレクトリ。targets.json の root を持つものはその下、ほかは ``plugins/<名前>`` の下。"""
    return root / _roots(root).get(plugin, f"plugins/{plugin}") / "interface"


def interface_plugins(root: Path) -> list[str]:
    """``generated.json`` を持つ定義書の名前を、名前の順に返す。

    ``plugins/<名前>/interface/`` と、targets.json で root を持つものの ``<root>/interface/`` を見る。
    """
    names = {p.parent.parent.name for p in (root / "plugins").glob("*/interface/generated.json")}
    names |= {
        name for name in _roots(root) if (interface_dir(root, name) / "generated.json").is_file()
    }
    return sorted(names)


# ---------------------------------------------------------------- ディレクティブ


def report_href(docname: str, url: str, behavior_id: str) -> str | None:
    """ページから、側のルートのテストレポートの、その ID の tag の一覧への相対のパス。ID が URL に書けなければ None。"""
    if not _URI_SAFE_ID.fullmatch(behavior_id):
        return None
    return "../" * docname.count("/") + f"{url}?tags={behavior_id}"


def report_cell(href: str) -> str:
    # 匿名のリンクにして、同じ名前のリンクの重複を警告させない。末尾の _ は参照の名前と読まれるので、\ で打ち消す。
    target = href[:-1] + "\\_" if href.endswith("_") else href
    return f"`テスト <{target}>`__"


class _Base(SphinxDirective):
    def _plan(self, plugin: str) -> Plan:
        interface = interface_dir(Path(self.config.iface_root), plugin)
        generated, authored = interface / "generated.json", interface / "authored.yaml"
        self.env.note_dependency(str(generated))
        self.env.note_dependency(str(authored))
        return build_plan(_load_json(generated), _load_yaml(authored))


class IfaceDefs(_Base):
    """``iface-defs <plugin> [<項目の ID> | common]``。2 つ目を省くと、プラグインの全項目を出す。"""

    required_arguments = 1
    optional_arguments = 1

    def run(self) -> list[nodes.Node]:
        plugin = self.arguments[0]
        only = self.arguments[1] if len(self.arguments) > 1 else None
        plan = self._plan(plugin)
        for message in plan.warnings:
            logger.warning(message, location=(self.env.docname, self.lineno))
        if only not in (None, COMMON) and only not in {c.id for c in plan.commands}:
            logger.warning(
                "iface-defs %s: 項目 %s が定義書にありません",
                plugin,
                only,
                location=(self.env.docname, self.lineno),
            )
        # need の directive と同じく文書を登録する。登録が無いと、リンクのノードが解決されない。
        add_doc(self.env, self.env.docname)
        source = NeedItemSource.from_directive(self)
        single = only is not None
        out: list[nodes.Node] = []
        for command in plan.commands:
            if only not in (None, command.id):
                continue
            out += self._need(
                "cmd", command.name, command.id, {"tags": command.tags}, None, command.body, source
            )
            behaviors = [b for b in plan.behaviors if b.belongs == command.id]
            for b in behaviors:
                out += self._behavior(b, source)
            out += self._page(plugin, command, behaviors, single)
        if only in (None, COMMON):
            behaviors = [b for b in plan.behaviors if b.belongs is None]
            for b in behaviors:
                out += self._behavior(b, source)
            parsed = self.parse_text_to_nodes("\n".join(self._behavior_table(behaviors, plugin)))
            out += self._anchored_nodes(parsed, behaviors)
        return out

    def _page(
        self, plugin: str, command: Command, behaviors: list[Behavior], single: bool
    ) -> list[nodes.Node]:
        """1 項目の表示。need は隠してあるので、ここで ID のアンカーを置き、節を見出しとして描く。

        1 項目だけのページでは、ページの題が項目の名前なので、節を題のすぐ下の見出しにする。
        全項目を 1 ページに出すときは、項目の名前を見出しにして、節をその下に置く。
        """
        top, sub = ("-", "-") if single else ("-", "~")
        lines: list[str] = []
        if not single:
            lines += [_esc(command.heading), top * (len(command.heading) * 2 + 4), ""]
        if command.title:
            # 題は表示名なので、呼ぶときの名前を題の下に添える
            lines += [".. rst-class:: iface-tool-name", "", _lit(command.tool), ""]
        lines += [
            ".. rst-class:: iface-lead",
            "",
            _esc(command.description, link=True),
            "",
        ]
        if command.deprecated:
            lines += [".. warning::", "", "   このツールは非推奨です。", ""]
        for title, body in command.sections:
            lines += [title, sub * (len(title) * 2 + 4), "", *body] if title else body
        if behaviors:
            lines += [
                "機能要件",
                sub * 16,
                "",
                self._behavior_lead(behaviors),
                "",
                *self._behavior_table(behaviors, plugin),
            ]
        parsed = self.parse_text_to_nodes("\n".join(lines), allow_section_headings=True)
        anchor = nodes.raw("", f'<span id="{command.id}"></span>', format="html")
        return [anchor, *self._anchored_nodes(parsed, behaviors)]

    def _behavior_lead(self, behaviors: list[Behavior]) -> str:
        """表の前の 1 文。使う人に、動作を機能要件として決め、テストで確かめていることを伝える。"""
        return f"次の {len(behaviors)} 件の要件を、自動テストで確かめています。"

    def _report_url(self, plugin: str) -> str | None:
        """そのプラグインの項目から、テストレポートへリンクするときの側のルートからの相対。しないときは None。"""
        report = cast("dict[str, Any]", self.config.iface_report)
        url = report.get("url")
        plugins = cast("list[str]", report.get("plugins") or [])
        return url if isinstance(url, str) and url and plugin in plugins else None

    def _report_column(self, b: Behavior, url: str) -> str:
        href = report_href(self.env.docname, url, b.id)
        if href is None:
            logger.warning(
                "%s: ID に URL の query にそのまま書けない文字があるため、テストレポートへリンクしません",
                b.id,
                location=(self.env.docname, self.lineno),
            )
            return "     -"
        return f"     - {report_cell(href)}"

    def _behavior_table(self, behaviors: list[Behavior], plugin: str) -> list[str]:
        report = self._report_url(plugin)
        lines = [
            ".. list-table::",
            "   :header-rows: 1",
            "   :widths: auto",
            "   :class: iface-behaviors",
            "",
            "   * - ID",
            "     - 要件",
            *(["     - テスト"] if report else []),
        ]
        for b in behaviors:
            lines += [f"   * - {_lit(b.id)}", f"     - {_esc(b.statement)}"]
            if report:
                lines += [self._report_column(b, report)]
        return [*lines, ""]

    def _anchored_nodes(
        self, parsed: list[nodes.Node], behaviors: list[Behavior]
    ) -> list[nodes.Node]:
        """表の行に、振る舞いの ID をそのまま id として付ける。テストからのリンクの先になる。"""
        tables = [
            t
            for node in parsed
            for t in node.findall(nodes.table)
            if "iface-behaviors" in t["classes"]
        ]
        rows = [
            r for t in tables for body in t.findall(nodes.tbody) for r in body.findall(nodes.row)
        ]
        for b, row in zip(behaviors, rows, strict=False):
            row["ids"].append(b.id)
        return parsed

    def _behavior(self, b: Behavior, source: NeedItemSource) -> list[nodes.Node]:
        return self._need(
            "behavior", b.statement, b.id, {"tags": [b.pattern]}, b.belongs, [], source
        )

    def _need(
        self,
        kind: str,
        title: str,
        need_id: str,
        fields: dict[str, Any],
        belongs: str | None,
        body: list[str],
        source: NeedItemSource,
    ) -> list[nodes.Node]:
        """need を作る。リンクと needs.json のためのもので、表示は _page が描くので隠す。"""
        try:
            _, created = create_need(
                self.env.app,
                self.state,
                source,
                kind,
                title,
                id=need_id,
                fields={**fields, "hide": True},
                links={"belongs": [belongs]} if belongs is not None else {},
                content="\n".join(body),
            )
        except (InvalidNeedException, KeyError) as error:
            logger.warning(
                "%s: need を作れませんでした: %s",
                need_id,
                error,
                location=(self.env.docname, self.lineno),
            )
            return []
        return created


# 型の欄に出す名前と並び。MCP を先に、action の順にする。
KINDS = {"mcp": "MCP", "action": "Action"}


def _kind_order(tag: str) -> int:
    return list(KINDS).index(tag) if tag in KINDS else len(KINDS)


class IfaceIndex(_Base):
    """``iface-index <plugin>``。コマンド・ツールの一覧を、各ページへのリンクの表にする。"""

    required_arguments = 1

    def run(self) -> list[nodes.Node]:
        plugin = self.arguments[0]
        plan = self._plan(plugin)
        base = f"/{PAGES_DIR.as_posix()}/{plugin}"
        rows: list[list[str]] = [
            [
                f":doc:`{_esc(c.heading)} <{base}/{c.slug}>`",
                _lit(c.tool),
                _esc(c.description),
                _esc("・".join(KINDS.get(t, t) for t in sorted(c.tags, key=_kind_order))),
            ]
            for c in plan.commands
        ]
        name = (
            "action"
            if plan.commands and all("action" in c.tags for c in plan.commands)
            else "ツール名"
        )
        head = ["表示名", name, "説明", "型"]
        lines = [".. list-table::", "   :header-rows: 1", "   :widths: 20 22 48 10", ""]
        for row in [head, *rows]:
            lines += [("   * - " if i == 0 else "     - ") + cell for i, cell in enumerate(row)]
        return self.parse_text_to_nodes("\n".join(lines))


class IfaceCommonOutput(_Base):
    """``iface-common-output <plugin>``。すべての MCP ツールの実行結果に共通する項目の表を出す。"""

    required_arguments = 1

    def run(self) -> list[nodes.Node]:
        plan = self._plan(self.arguments[0])
        lines = _table("", ["項目名", "型", "説明"], plan.common_output)
        return self.parse_text_to_nodes("\n".join(lines))


class IfaceResources(_Base):
    """``iface-resources <plugin>``。MCP サーバが出す resource の表を出す。"""

    required_arguments = 1

    def run(self) -> list[nodes.Node]:
        plan = self._plan(self.arguments[0])
        lines = _table("", ["URI", "名前", "説明", "MIME タイプ"], plan.resources, code=2)
        return self.parse_text_to_nodes("\n".join(lines))


def write_pages(app: Sphinx) -> None:
    """コマンド・ツールごとの rst を ``_generated/<plugin>/`` に書く。定義書から消えた項目のページは消す。"""
    config = app.config
    if not config.iface_pages:
        return
    plugins = interface_plugins(Path(config.iface_root))
    root = Path(app.srcdir) / PAGES_DIR
    if root.is_dir():
        for stale_dir in root.iterdir():
            if stale_dir.is_dir() and stale_dir.name not in plugins:
                shutil.rmtree(stale_dir)
    for plugin in plugins:
        interface = interface_dir(Path(config.iface_root), plugin)
        plan = build_plan(
            _load_json(interface / "generated.json"), _load_yaml(interface / "authored.yaml")
        )
        pages: dict[str, list[str]] = {}
        for c in plan.commands:
            if c.slug in pages:
                logger.warning("%s: ページ名 %s が別の項目と重なるため、飛ばしました", c.id, c.slug)
                continue
            pages[c.slug] = [
                # 文書の先頭の field list は、Sphinx がページの付帯情報として読む。右の欄に出す。
                f":iface-id: {c.id}",
                f":iface-plugin: {plugin}",
                f":iface-kind: {'・'.join(KINDS.get(t, t) for t in sorted(c.tags, key=_kind_order))}",
                "",
                c.heading,
                "=" * (len(c.heading) * 2),
                "",
                f".. iface-defs:: {plugin} {c.id}",
                "",
            ]
        directory = Path(app.srcdir) / PAGES_DIR / plugin
        directory.mkdir(parents=True, exist_ok=True)
        for stale in directory.glob("*.rst"):
            if stale.stem not in pages:
                stale.unlink()
        for slug, lines in pages.items():
            target, text = directory / f"{slug}.rst", "\n".join(lines)
            if not target.exists() or target.read_text(encoding="utf-8") != text:
                target.write_text(text, encoding="utf-8")


def setup(app: Sphinx) -> ExtensionMetadata:
    app.add_config_value("iface_root", "", "env", types=[str])
    app.add_config_value("iface_pages", False, "env", types=[bool])
    app.add_config_value("iface_terms", {}, "env", types=[dict])
    app.add_config_value("iface_report", {}, "env", types=[dict])
    app.connect("config-inited", _load_terms)
    app.connect("builder-inited", write_pages)
    app.add_object_type(MCP_ARG, MCP_ARG, objname="MCP のツールの引数")
    app.add_object_type(ACTION_INPUT, ACTION_INPUT, objname="action の入力")
    app.add_directive("iface-defs", IfaceDefs)
    app.add_directive("iface-index", IfaceIndex)
    app.add_directive("iface-common-output", IfaceCommonOutput)
    app.add_directive("iface-resources", IfaceResources)
    return {"parallel_read_safe": True, "parallel_write_safe": True}
