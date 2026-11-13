"""定義書と JUnit から sphinx-needs の need とテストの表を作る拡張。

- ``iface-defs <plugin> [<項目の ID> | common]``: コマンド・ツールを cmd、振る舞いを behavior の need にし、
  outcome を決める。2 つ目を渡すと、その項目とその振る舞いだけ（``common`` は共通の振る舞いだけ）を出す
- ``iface-index <plugin>``: コマンド・ツールの一覧を、各ページへのリンクと合否の数の表にする
- ``iface-tests <plugin>``: 項目につながるケースだけの JUnit を書き、test-file で描く
- ``iface-field-map``: 欄と POSIX の節の対応の表を描く

定義書の形式は lint-defs が守る。ここでは欠けた欄を警告にして、その項目を飛ばす。
"""

from __future__ import annotations

import json
import re
import shutil
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast
from xml.etree import ElementTree as ET

import yaml
from docutils import nodes
from sphinx.util import logging
from sphinx.util.docutils import SphinxDirective
from sphinx_needs.api import InvalidNeedException, NeedItemSource, create_need
from sphinx_needs.roles.need_incoming import NeedIncoming
from sphinx_needs.utils import add_doc
from ub_test_reports.errors import ReportReadError
from ub_test_reports.junitparser import JUnitParser

if TYPE_CHECKING:
    from sphinx.application import Sphinx
    from sphinx.config import Config
    from sphinx.util.typing import ExtensionMetadata

logger = logging.getLogger(__name__)

PASSED = "passed"
FAILED = "failed"
NOT_RUN = "not run"

JUNIT_DIR = Path("_generated") / "junit"


# ---------------------------------------------------------------- JUnit


@dataclass(frozen=True)
class Case:
    classname: str
    name: str
    time: float
    result: str
    message: str
    text: str
    type: str
    ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class Suite:
    name: str
    cases: tuple[Case, ...]


def outcome_of(cases: list[Case]) -> str:
    """つながるケースの結果から振る舞いの合否を決める。すべて passed なら合格、failed・error が 1 つでもあれば失敗。"""
    results = {c.result for c in cases}
    if not results:
        return NOT_RUN
    if results & {"failed", "error"}:
        return FAILED
    return PASSED if results == {"passed"} else NOT_RUN


def _split_ids(value: str) -> tuple[str, ...]:
    return tuple(part for part in (p.strip() for p in value.split(",")) if part)


def _flatten(suites: list[dict[str, Any]]) -> list[Suite]:
    out: list[Suite] = []
    for suite in suites:
        cases = tuple(
            Case(
                classname=str(c["classname"]),
                name=str(c["name"]),
                time=float(c["time"]),
                result=str(c["result"]),
                message=str(c["message"]),
                text=str(c["text"]),
                type=str(c["type"]),
                ids=_split_ids(str(c["properties"].get("verifies", ""))),
            )
            for c in suite["testcases"]
        )
        out.append(Suite(name=str(suite["name"]), cases=cases))
        out.extend(_flatten(suite["testsuite_nested"]))
    return out


def read_junit(path: Path) -> list[Suite]:
    """JUnit を sphinx-test-reports と同じ読み手で読む。"""
    return _flatten(JUnitParser(str(path)).parse())


def filter_suites(suites: list[Suite], known: frozenset[str]) -> tuple[list[Suite], set[str]]:
    """定義書の項目につながるケースだけを残す。残すケースの ID は定義書にあるものだけにする。落とした ID を返す。"""
    unknown: set[str] = set()
    kept: list[Suite] = []
    for suite in suites:
        cases: list[Case] = []
        for c in suite.cases:
            unknown.update(i for i in c.ids if i not in known)
            ids = tuple(i for i in c.ids if i in known)
            if ids:
                cases.append(replace(c, ids=ids))
        if cases:
            kept.append(Suite(name=suite.name, cases=tuple(cases)))
    return kept, unknown


_RESULT_ELEMENT = {"failed": "failure", "error": "error", "skipped": "skipped"}


def render_junit(suites: list[Suite]) -> str:
    """絞ったケースを JUnit に書く。ケースごとに verifies を 1 つにまとめ、値を ID のカンマ区切りにする。

    file・line は書かない。vitest の JUnit は持たず、pytest の表にだけ行が増えて列がそろわないため。
    """
    root = ET.Element("testsuites")
    for suite in suites:
        element = ET.SubElement(
            root,
            "testsuite",
            {
                "name": suite.name,
                "tests": str(len(suite.cases)),
                "failures": str(sum(c.result == "failed" for c in suite.cases)),
                "errors": str(sum(c.result == "error" for c in suite.cases)),
                "skipped": str(sum(c.result == "skipped" for c in suite.cases)),
            },
        )
        for c in suite.cases:
            attrs = {
                "classname": c.classname,
                "name": c.name,
                "time": str(c.time),
            }
            if c.result == "disabled":
                attrs["status"] = "notrun"
            case = ET.SubElement(element, "testcase", attrs)
            kind = _RESULT_ELEMENT.get(c.result)
            if kind is not None:
                child = ET.SubElement(case, kind, {"message": c.message, "type": c.type})
                child.text = c.text
            case_props = ET.SubElement(case, "properties")
            ET.SubElement(case_props, "property", {"name": "verifies", "value": ",".join(c.ids)})
    ET.indent(root)
    return '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(root, encoding="unicode") + "\n"


@dataclass
class Collected:
    """プラグインの JUnit を読んで絞った結果。"""

    files: list[tuple[Path, list[Suite]]] = field(default_factory=lambda: [])
    by_id: dict[str, list[Case]] = field(default_factory=lambda: {})
    unknown: set[str] = field(default_factory=lambda: set())
    unreadable: list[str] = field(default_factory=lambda: [])
    existing: int = 0

    @property
    def kept(self) -> int:
        return sum(len(s.cases) for _, suites in self.files for s in suites)


def collect(paths: list[Path], known: frozenset[str]) -> Collected:
    out = Collected()
    for path in paths:
        if not path.is_file():
            continue
        out.existing += 1
        try:
            kept, unknown = filter_suites(read_junit(path), known)
        except ReportReadError as error:
            out.unreadable.append(str(error))
            continue
        out.unknown |= unknown
        if not kept:
            continue
        out.files.append((path, kept))
        for suite in kept:
            for c in suite.cases:
                for i in c.ids:
                    out.by_id.setdefault(i, []).append(c)
    return out


# ---------------------------------------------------------------- 定義書


def _esc(value: object) -> str:
    """list-table のセルや段落に入れる文字列。rst の記号を無効にし、改行を空白にする。"""
    text = " ".join(str(value).split())
    parts = re.split(r"`([^`]+)`", text)
    return "".join(
        _lit(part) if i % 2 else "".join("\\" + ch if ch in "*`|_\\" else ch for ch in part)
        for i, part in enumerate(parts)
    )


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
    out = [f".. list-table:: {_esc(title)}".rstrip(), "   :header-rows: 1", ""]
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

OUTCOME_LABELS = {PASSED: "合格", FAILED: "不合格", NOT_RUN: "未実行"}

# 書くことが無いときの決まった値。この値の欄はページに出さない。
_NOTHING = {"stdin": "none", "diagnostics": "default", "on_error": "default"}


def _code_block(text: object) -> list[str]:
    return [".. code-block:: text", "", *(f"   {line}" for line in str(text).splitlines()), ""]


def _type(spec: dict[str, Any]) -> str:
    if "enum" in spec:
        return " | ".join(
            json.dumps(v, ensure_ascii=False) for v in cast("list[Any]", spec["enum"])
        )
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


def _choices(spec: dict[str, Any]) -> str:
    values = cast("list[Any]", spec.get("enum", []))
    return " {" + ", ".join(str(v) for v in values) + "}" if values else ""


def _syntax_block(head: str, parameters: list[str]) -> list[str]:
    """構文。Azure CLI のリファレンスと同じく、引数を 1 行に 1 つ、コマンドの名前の右にそろえて並べる。"""
    pad = " " * (len(head) + 1)
    rows = [f"{head} {parameters[0]}", *(pad + p for p in parameters[1:])] if parameters else [head]
    return _code_block("\n".join(rows))


def _syntax(entry: dict[str, Any]) -> list[str]:
    """構文。省ける引数は [ ] で囲み、選べる値は { } に並べる。"""
    properties, required = _schema(entry.get("input"))
    surfaces = cast("dict[str, dict[str, Any]]", entry["surfaces"])
    detail = cast("dict[str, Any]", entry.get("cli", {}))
    positional = cast("list[str]", detail.get("positional", []))
    flags = cast("dict[str, list[str]]", detail.get("flags", {}))

    def wrap(name: str, text: str) -> str:
        text += _choices(properties.get(name, {}))
        return text if name in required else f"[{text}]"

    blocks: list[list[str]] = []
    if "cli" in surfaces:
        examples = cast("list[dict[str, str]]", entry.get("examples", []))
        path = cast("list[str]", surfaces["cli"]["path"])
        binary = examples[0]["run"].split()[0] if examples and examples[0]["run"].split() else ""
        head = " ".join([binary, *path] if binary and binary != path[0] else path)
        names = [*positional, *(n for n in flags if n not in positional)]
        parameters = [wrap(n, f"<{n}>" if n in positional else flags[n][0]) for n in names]
        blocks.append(_syntax_block(head, parameters))
    if "mcp" in surfaces:
        parameters = [wrap(n, n) for n in properties]
        blocks.append(_syntax_block(str(surfaces["mcp"]["tool"]), parameters))
    return [line for block in blocks for line in block]


def _parameter(entry: dict[str, Any], name: str, spec: dict[str, Any]) -> list[str]:
    """引数 1 つ。Azure CLI のリファレンスと同じく、名前の行、説明、プロパティと値の表の順に書く。"""
    detail = cast("dict[str, Any]", entry.get("cli", {}))
    flags = cast("dict[str, list[str]]", detail.get("flags", {}))
    written = cast("dict[str, str]", entry.get("arguments", {}))
    notes = cast("dict[str, str]", entry.get("default_notes", {}))
    if name in flags:
        label = ", ".join(flags[name])
    elif name in cast("list[str]", detail.get("positional", [])):
        label = f"<{name}>"
    else:
        label = name
    text = " ".join(
        t for t in (written.get(name, spec.get("description", "")), notes.get(name)) if t
    )
    rows: list[list[object]] = [
        ["型:", _type(spec) if "enum" not in spec else spec.get("type", "")]
    ]
    if label != name and "mcp" in cast("dict[str, Any]", entry["surfaces"]):
        rows.append(["MCP での名前:", name])
    if "default" in spec:
        rows.append(["既定値:", json.dumps(spec["default"], ensure_ascii=False)])
    if "enum" in spec:
        rows.append(["指定可能な値:", ", ".join(str(v) for v in cast("list[Any]", spec["enum"]))])
    # Sphinx 標準の option で描く。名前が見出し語になり、プロパティは field list になる。
    body = [_esc(text), "", *(f":{str(k).rstrip(chr(58))}: {_esc(v)}" for k, v in rows), ""]
    return [f".. option:: {label}", "", *(f"   {line}" if line else "" for line in body)]


def _parameters(entry: dict[str, Any], required_ones: bool) -> list[str]:
    properties, required = _schema(entry.get("input"))
    return [
        line
        for name, spec in properties.items()
        if (name in required) == required_ones
        for line in _parameter(entry, name, spec)
    ]


def _examples(entry: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    for example in cast("list[dict[str, str]]", entry.get("examples", [])):
        lines += [*_para(example["note"]), *_code_block(example["run"])]
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


def _output(entry: dict[str, Any]) -> list[str]:
    output = cast("dict[str, Any]", entry.get("output", {}))
    lines: list[str] = []
    if output.get("format") == "none":
        lines += _para("標準出力には何も出しません。")
    elif output.get("description"):
        lines += _para(output["description"])
    schema = output.get("schema", _get(entry, "mcp.output"))
    properties, required = _schema(None if schema is _MISSING else schema)
    written = cast("dict[str, str]", output.get("fields", {}))
    rows = [
        [
            name,
            _type(spec),
            "○" if name in required else "",
            written.get(name, spec.get("description", "")),
        ]
        for name, spec in properties.items()
    ]
    lines += _table("", ["名前", "型", "必須", "説明"], rows)
    extra = [
        (label, entry[key])
        for key, label in (("stdin", "標準入力"), ("diagnostics", "標準エラー"))
        if key in entry and entry[key] != _NOTHING[key]
    ]
    return lines + (_fields(extra) if extra else [])


def _failures(entry: dict[str, Any]) -> tuple[str, list[str]]:
    """エラーの表。終了コードで返す項目は戻り値の表。エラーの後に残る状態を、その下に書く。"""
    items = cast("list[dict[str, Any]]", entry.get("exit_status", []))
    coded = any("code" in e for e in items)
    rows = [[e.get("code", e.get("kind", "")), e["when"]] for e in items]
    lines = _table("", ["戻り値", "意味"] if coded else ["エラー", "主な要因"], rows)
    if "on_error" in entry and entry["on_error"] != _NOTHING["on_error"]:
        lines += _para(entry["on_error"])
    return ("戻り値" if coded else "エラー"), lines


def _notices(entry: dict[str, Any]) -> list[str]:
    """書き換えるものと、呼び直したときの結果。読むだけのものは出さない。"""
    effects = cast("list[dict[str, str]]", entry.get("effects", []))
    items = [e["what"] for e in effects if e["kind"] != "read"]
    if "idempotent" in entry:
        again = "変わりません" if entry["idempotent"] else "変わることがあります"
        items.append(f"同じ引数でもう一度呼んでも、結果は{again}。")
    return [*(f"- {_esc(text)}" for text in items), ""] if items else []


def _prerequisites(entry: dict[str, Any]) -> list[str]:
    items = cast("list[str]", entry.get("prerequisites", []))
    return [*(f"- {_esc(text)}" for text in items), ""] if items else []


def _environment(entry: dict[str, Any]) -> list[str]:
    env = cast("list[dict[str, str]]", entry.get("environment", []))
    return _table("", ["名前", "効果"], [[e["name"], e["effect"]] for e in env])


def render_sections(entry: dict[str, Any]) -> list[tuple[str, list[str]]]:
    """項目のページの節。中身のある節だけを、見出しと rst の行の組で返す。

    構文からオプションのパラメータまでは、Azure CLI の日本語リファレンスの並びと見出しに合わせる。
    見出しが空の節は、冒頭の説明と構文で、見出しを付けずに出す。
    """
    details = [line for text in cast("list[str]", entry.get("details", [])) for line in _para(text)]
    constraints = cast("list[object]", entry.get("constraints", []))
    optional = _parameters(entry, False)
    if optional and constraints:
        optional = [*(f"- {_esc(_constraint(c))}" for c in constraints), "", *optional]
    failure_title, failures = _failures(entry)
    sections = [
        ("", [*details, *_syntax(entry)]),
        ("前提条件", _prerequisites(entry)),
        ("例", _examples(entry)),
        ("必須パラメータ", _parameters(entry, True)),
        ("オプションのパラメータ", optional),
        ("出力", _output(entry)),
        (failure_title, failures),
        ("注意事項", _notices(entry)),
        ("環境変数", _environment(entry)),
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

    @property
    def slug(self) -> str:
        """コマンドのページのファイル名。"""
        return re.sub(r"[^a-z0-9_.]+", "-", self.name.lower()).strip("-")


@dataclass
class Plan:
    commands: list[Command] = field(default_factory=lambda: [])
    behaviors: list[Behavior] = field(default_factory=lambda: [])
    warnings: list[str] = field(default_factory=lambda: [])

    @property
    def ids(self) -> frozenset[str]:
        return frozenset(b.id for b in self.behaviors)


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
    plan = Plan()
    entries = cast("dict[str, dict[str, Any]]", authored.get("entries", {}))
    for g in cast("list[dict[str, Any]]", generated.get("entries", [])):
        gid = str(g.get("id", "?"))
        a = entries.get(gid)
        if a is None:
            plan.warnings.append(f"{gid}: authored.yaml に項目が無いため、飛ばしました")
            continue
        try:
            sections = render_sections({**g, **a})
            command = Command(
                id=gid,
                name=str(g["name"]),
                tags=sorted(cast("dict[str, Any]", g["surfaces"])),
                body=render_body(sections),
                description=str(a.get("summary") or g.get("description", "")),
                deprecated=bool(g.get("deprecated", False)),
                sections=sections,
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


# ---------------------------------------------------------------- ディレクティブ


def _config_junit(config: Config, plugin: str) -> list[Path]:
    table = cast("dict[str, list[str]]", config.iface_junit)
    return [Path(p) for p in table.get(plugin, [])]


class _Base(SphinxDirective):
    def _plan(self, plugin: str) -> Plan:
        interface = Path(self.config.iface_root) / "plugins" / plugin / "interface"
        generated, authored = interface / "generated.json", interface / "authored.yaml"
        self.env.note_dependency(str(generated))
        self.env.note_dependency(str(authored))
        return build_plan(_load_json(generated), _load_yaml(authored))

    def _collect(self, plugin: str, known: frozenset[str]) -> Collected:
        paths = _config_junit(self.config, plugin)
        for path in paths:
            self.env.note_dependency(str(path))
        return collect(paths, known)


class IfaceDefs(_Base):
    """``iface-defs <plugin> [<項目の ID> | common]``。2 つ目を省くと、プラグインの全項目を出す。"""

    required_arguments = 1
    optional_arguments = 1

    def run(self) -> list[nodes.Node]:
        plugin = self.arguments[0]
        only = self.arguments[1] if len(self.arguments) > 1 else None
        plan = self._plan(plugin)
        collected = self._collect(plugin, plan.ids)
        for message in plan.warnings:
            logger.warning(message, location=(self.env.docname, self.lineno))
        if only not in (None, COMMON) and only not in {c.id for c in plan.commands}:
            logger.warning(
                "iface-defs %s: 項目 %s が定義書にありません",
                plugin,
                only,
                location=(self.env.docname, self.lineno),
            )
        for message in collected.unreadable:
            logger.warning(
                "JUnit を読めませんでした: %s", message, location=(self.env.docname, self.lineno)
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
                out += self._behavior(b, collected, source)
            out += self._page(command, behaviors, collected, single)
        if only in (None, COMMON):
            behaviors = [b for b in plan.behaviors if b.belongs is None]
            for b in behaviors:
                out += self._behavior(b, collected, source)
            out += self._anchored(self._behavior_table(behaviors, collected), behaviors)
        return out

    def _page(
        self, command: Command, behaviors: list[Behavior], collected: Collected, single: bool
    ) -> list[nodes.Node]:
        """1 項目の表示。need は隠してあるので、ここで ID のアンカーを置き、節を見出しとして描く。

        1 項目だけのページでは、ページの題が項目の名前なので、節を題のすぐ下の見出しにする。
        全項目を 1 ページに出すときは、項目の名前を見出しにして、節をその下に置く。
        """
        top, sub = ("-", "-") if single else ("-", "~")
        lines: list[str] = []
        if not single:
            lines += [_esc(command.name), top * (len(command.name) * 2 + 4), ""]
        lines += [
            ".. rst-class:: iface-lead",
            "",
            _esc(command.description),
            "",
            ".. rst-class:: iface-meta",
            "",
            f"{_lit(command.id)} {' '.join(f':iface-tag:`{_esc(t)}`' for t in command.tags)}",
            "",
        ]
        lines += [f".. program:: {command.name}", ""]
        if command.deprecated:
            lines += [".. warning::", "", "   このコマンドは非推奨です。", ""]
        for title, body in command.sections:
            lines += [title, sub * (len(title) * 2 + 4), "", *body] if title else body
        if behaviors:
            lines += ["要件", sub * 12, "", *self._behavior_table(behaviors, collected)]
        parsed = self.parse_text_to_nodes("\n".join(lines), allow_section_headings=True)
        anchor = nodes.raw("", f'<span id="{command.id}"></span>', format="html")
        return [anchor, *self._anchored_nodes(parsed, behaviors)]

    def _behavior_table(self, behaviors: list[Behavior], collected: Collected) -> list[str]:
        lines = [
            ".. list-table::",
            "   :header-rows: 1",
            "   :widths: 24 50 10 16",
            "   :class: iface-behaviors",
            "",
            "   * - ID",
            "     - 要件",
            "     - 合否",
            "     - テスト",
        ]
        for b in behaviors:
            cases = collected.by_id.get(b.id, [])
            outcome = outcome_of(cases)
            lines += [
                f"   * - {_lit(b.id)}",
                f"     - {_esc(b.statement)}",
                f"     - :iface-{outcome.replace(' ', '-')}:`{OUTCOME_LABELS[outcome]}`",
                f"     - :iface-tests:`{b.id}`" if cases else "     -",
            ]
        return [*lines, ""]

    def _anchored(self, lines: list[str], behaviors: list[Behavior]) -> list[nodes.Node]:
        return self._anchored_nodes(self.parse_text_to_nodes("\n".join(lines)), behaviors)

    def _anchored_nodes(
        self, parsed: list[nodes.Node], behaviors: list[Behavior]
    ) -> list[nodes.Node]:
        """表の ID のセルに、振る舞いの ID をそのまま id として付ける。テストからのリンクの先になる。"""
        pending = {b.id for b in behaviors}
        for node in parsed:
            for literal in node.findall(nodes.literal):
                text = literal.astext()
                if text in pending:
                    literal["ids"].append(text)
                    pending.discard(text)
        return parsed

    def _behavior(
        self, b: Behavior, collected: Collected, source: NeedItemSource
    ) -> list[nodes.Node]:
        outcome = outcome_of(collected.by_id.get(b.id, []))
        return self._need(
            "behavior",
            b.statement,
            b.id,
            {"outcome": outcome, "tags": [b.pattern]},
            b.belongs,
            [],
            source,
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


def _summary(outcomes: list[str]) -> str:
    """振る舞いの合否を「合格 12・不合格 1」の形に数える。"""
    parts = [
        f"{OUTCOME_LABELS[o]} {outcomes.count(o)}"
        for o in (PASSED, FAILED, NOT_RUN)
        if o in outcomes
    ]
    return "・".join(parts) or "—"


class IfaceIndex(_Base):
    """``iface-index <plugin>``。コマンド・ツールの一覧を、各ページへのリンクと合否の数の表にする。"""

    required_arguments = 1

    def run(self) -> list[nodes.Node]:
        plugin = self.arguments[0]
        plan = self._plan(plugin)
        collected = self._collect(plugin, plan.ids)

        def outcomes(belongs: str | None) -> list[str]:
            return [
                outcome_of(collected.by_id.get(b.id, []))
                for b in plan.behaviors
                if b.belongs == belongs
            ]

        base = f"/{PAGES_DIR.as_posix()}/{plugin}"
        rows: list[list[str]] = [
            [
                f":doc:`{_esc(c.name)} <{base}/{c.slug}>`",
                _esc(c.description),
                _esc(", ".join(c.tags)),
                _esc(_summary(outcomes(c.id))),
            ]
            for c in plan.commands
        ]
        lines = [".. list-table::", "   :header-rows: 1", "   :widths: 22 50 8 20", ""]
        for row in [["名前", "説明", "型", "状態"], *rows]:
            lines += [("   * - " if i == 0 else "     - ") + cell for i, cell in enumerate(row)]
        return self.parse_text_to_nodes("\n".join(lines))


def write_pages(app: Sphinx) -> None:
    """コマンド・ツールごとの rst を ``_generated/<plugin>/`` に書く。定義書から消えた項目のページは消す。"""
    config = app.config
    if not config.iface_pages:
        return
    plugins = cast("dict[str, list[str]]", config.iface_junit)
    root = Path(app.srcdir) / PAGES_DIR
    if root.is_dir():
        for stale_dir in root.iterdir():
            if stale_dir.is_dir() and stale_dir.name not in {*plugins, JUNIT_DIR.name}:
                shutil.rmtree(stale_dir)
    for plugin in plugins:
        interface = Path(config.iface_root) / "plugins" / plugin / "interface"
        plan = build_plan(
            _load_json(interface / "generated.json"), _load_yaml(interface / "authored.yaml")
        )
        pages: dict[str, list[str]] = {}
        for c in plan.commands:
            if c.slug in pages:
                logger.warning("%s: ページ名 %s が別の項目と重なるため、飛ばしました", c.id, c.slug)
                continue
            pages[c.slug] = [
                c.name,
                "=" * (len(c.name) * 2),
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


class IfaceTests(_Base):
    required_arguments = 1

    def run(self) -> list[nodes.Node]:
        plugin = self.arguments[0]
        collected = self._collect(plugin, self._plan(plugin).ids)
        if collected.unknown:
            logger.info(
                "iface-tests %s: 定義書に無い ID のケースを落としました: %s",
                plugin,
                ", ".join(sorted(collected.unknown)),
            )
        if collected.existing == 0:
            return self._message(
                "JUnit のファイルが見つからないため、すべての合否を未実行にしました。"
            )
        if not collected.files:
            return self._message("項目につながるテストが無いため、テストの表は出しません。")
        out: list[nodes.Node] = []
        slug = re.sub(r"[^A-Z0-9]+", "_", plugin.upper())
        for number, (_, suites) in enumerate(collected.files, start=1):
            relative = JUNIT_DIR / f"{plugin}-{number}.xml"
            target = Path(self.env.srcdir) / relative
            text = render_junit(suites)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.read_text(encoding="utf-8") != text:
                target.write_text(text, encoding="utf-8")
            lines = [
                f".. test-file:: {_esc(plugin)} {number}",
                f"   :id: TF_{slug}_{number}",
                f"   :file: {relative.as_posix()}",
                "   :auto_suites:",
                "   :auto_cases:",
                "",
            ]
            out += self.parse_text_to_nodes("\n".join(lines))
        return out

    def _message(self, text: str) -> list[nodes.Node]:
        return [nodes.paragraph(text=text)]


class IfaceFieldMap(_Base):
    def run(self) -> list[nodes.Node]:
        path = Path(self.config.iface_field_map)
        self.env.note_dependency(str(path))
        if not path.is_file():
            logger.warning(
                "欄の対応表 %s がありません", path, location=(self.env.docname, self.lineno)
            )
            return []
        data = cast("dict[str, list[dict[str, Any]]]", _load_json(path))
        posix = [
            [r["section"], ", ".join(r["fields"]) or "（なし）", r["writer"], r["mcp"]]
            for r in data["posix"]
        ]
        borrowed = [[", ".join(r["fields"]), r["source"]] for r in data["borrowed"]]
        lines = [
            *_table("POSIX の節と欄", ["節", "欄", "書き手", "MCP"], posix, 0),
            *_table("ほかの枠組みから借りた欄", ["欄", "出どころ"], borrowed, 0),
        ]
        return self.parse_text_to_nodes("\n".join(lines))


def _tests_role(
    _name: str,
    rawtext: str,
    text: str,
    _lineno: int,
    _inliner: Any,
    _options: Any = None,
    _content: Any = None,
) -> tuple[list[nodes.Node], list[nodes.system_message]]:
    """振る舞いの ID から、つながるテストの need へのリンクを並べる。sphinx-needs の layout と同じノードを置く。"""
    node = NeedIncoming(reftarget=text, link_type="verifies_back")
    node.append(nodes.inline(text, text))
    return [node], []


def _class_role(name: str) -> Any:
    """文字を、class を付けた inline にする role。合否と面のバッジに使う。"""

    def role(
        _name: str,
        rawtext: str,
        text: str,
        _lineno: int,
        _inliner: Any,
        _options: Any = None,
        _content: Any = None,
    ) -> tuple[list[nodes.Node], list[nodes.system_message]]:
        return [nodes.inline(rawtext, text, classes=["iface-badge", name])], []

    return role


def setup(app: Sphinx) -> ExtensionMetadata:
    app.add_config_value("iface_root", "", "env", types=[str])
    app.add_config_value("iface_junit", {}, "env", types=[dict])
    app.add_config_value("iface_field_map", "", "env", types=[str])
    app.add_config_value("iface_pages", False, "env", types=[bool])
    app.connect("builder-inited", write_pages)
    app.add_role("iface-tests", _tests_role)
    for name in ("iface-tag", "iface-passed", "iface-failed", "iface-not-run"):
        app.add_role(name, _class_role(name))
    app.add_directive("iface-defs", IfaceDefs)
    app.add_directive("iface-index", IfaceIndex)
    app.add_directive("iface-tests", IfaceTests)
    app.add_directive("iface-field-map", IfaceFieldMap)
    return {"parallel_read_safe": True, "parallel_write_safe": True}
