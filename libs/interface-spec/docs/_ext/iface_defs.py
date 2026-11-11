"""定義書と JUnit から sphinx-needs の need とテストの表を作る拡張。

- ``iface-defs <plugin>``: コマンド・ツールを cmd、振る舞いを behavior の need にし、outcome を決める
- ``iface-tests <plugin>``: 項目につながるケースだけの JUnit を書き、test-file で描く
- ``iface-field-map``: 欄と POSIX の節の対応の表を描く

定義書の形式は lint-defs が守る。ここでは欠けた欄を警告にして、その項目を飛ばす。
"""

from __future__ import annotations

import json
import re
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
from ub_test_reports.errors import ReportReadError
from ub_test_reports.junitparser import JUnitParser

if TYPE_CHECKING:
    from sphinx.application import Sphinx
    from sphinx.config import Config
    from sphinx.util.typing import ExtensionMetadata

logger = logging.getLogger(__name__)

PASSED = "合格"
FAILED = "失敗"
NOT_RUN = "未実行"

JUNIT_DIR = Path("_generated") / "junit"


# ---------------------------------------------------------------- JUnit


@dataclass(frozen=True)
class Case:
    classname: str
    name: str
    file: str
    line: int
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
                file=str(c["file"]),
                line=int(c["line"]),
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
    """絞ったケースを JUnit に書く。ケースごとに verifies を 1 つにまとめ、値を ID のカンマ区切りにする。"""
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
        props = ET.SubElement(element, "properties")
        ET.SubElement(props, "property", {"name": "ub_test_reports:line_base", "value": "1"})
        for c in suite.cases:
            attrs = {
                "classname": c.classname,
                "name": c.name,
                "file": c.file,
                "line": str(c.line),
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
    return "".join("\\" + ch if ch in "*`|_\\" else ch for ch in text)


def _table(title: str, header: list[str], rows: Sequence[Sequence[object]]) -> list[str]:
    if not rows:
        return []
    out = [f".. list-table:: {_esc(title)}", "   :header-rows: 1", ""]
    for row in [header, *rows]:
        out += [("   * - " if i == 0 else "     - ") + _esc(cell) for i, cell in enumerate(row)]
    return [*out, ""]


def _para(text: object) -> list[str]:
    return [_esc(text), ""]


def _fields(pairs: list[tuple[str, object]]) -> list[str]:
    return [*(f":{label}: {_esc(value)}" for label, value in pairs), ""]


_MISSING = object()


def _get(data: dict[str, Any], dotted: str) -> object:
    current: Any = data
    for key in dotted.split("."):
        if not isinstance(current, dict) or key not in current:
            return _MISSING
        current = cast("dict[str, Any]", current)[key]
    return cast("object", current)


def _properties(schema: object, required_key: bool) -> list[list[object]]:
    if not isinstance(schema, dict):
        return []
    body = cast("dict[str, Any]", schema)
    properties = cast("dict[str, Any]", body.get("properties", {}))
    required = cast("list[str]", body.get("required", []))
    rows: list[list[object]] = []
    for name, spec in properties.items():
        item = cast("dict[str, Any]", spec) if isinstance(spec, dict) else {}
        row: list[object] = [name, item.get("type", ""), item.get("description", "")]
        if required_key:
            row.insert(2, "yes" if name in required else "no")
        rows.append(row)
    return rows


def _constraint_text(item: object) -> str:
    return json.dumps(item, ensure_ascii=False)


def render_field(path: str, value: object) -> list[str]:
    """定義書の欄を、本文の rst の行にする。欄のパスは schema.ts の項目の欄のパスと同じ。"""
    if path in {
        "id",
        "name",
        "description",
        "stdin",
        "diagnostics",
        "on_error",
        "surfaces.mcp.tool",
    }:
        return _fields([(path, value)])
    if path == "deprecated":
        return _fields([(path, "yes" if value else "no")])
    if path == "surfaces.cli.path":
        return _fields([(path, " ".join(cast("list[str]", value)))])
    if path == "cli.positional":
        return _fields([(path, ", ".join(cast("list[str]", value)))]) if value else []
    if path == "cli.flags":
        flags = cast("dict[str, list[str]]", value)
        return _table("フラグ", ["引数", "フラグ"], [[k, ", ".join(v)] for k, v in flags.items()])
    if path == "constraints":
        return (
            [f"- {_esc(_constraint_text(c))}" for c in cast("list[object]", value)] + [""]
            if value
            else []
        )
    if path == "details":
        return [line for text in cast("list[str]", value) for line in _para(text)]
    if path == "input":
        return _table("引数", ["名前", "型", "必須", "説明"], _properties(value, True))
    if path == "default_notes":
        notes = cast("dict[str, str]", value)
        return _table("既定の値", ["名前", "説明"], [[k, v] for k, v in notes.items()])
    if path == "effects":
        effects = cast("list[dict[str, str]]", value)
        return _table(
            "副作用",
            ["対象", "種別", "内容"],
            [[e["target"], e["kind"], e["what"]] for e in effects],
        )
    if path == "environment":
        env = cast("list[dict[str, str]]", value)
        return _table("環境変数", ["名前", "内容"], [[e["name"], e["effect"]] for e in env])
    if path == "output":
        output = cast("dict[str, Any]", value)
        return _fields(
            [("output", f"{output['format']}: {output.get('description', '')}".rstrip(": "))]
        )
    if path == "mcp.output":
        return _table("MCP の出力", ["名前", "型", "説明"], _properties(value, False))
    if path == "exit_status":
        rows = [
            [e.get("code", e.get("kind", "")), e["when"]]
            for e in cast("list[dict[str, Any]]", value)
        ]
        return _table("終了コード", ["コード", "条件"], rows)
    if path == "examples":
        examples = cast("list[dict[str, str]]", value)
        return _table("例", ["実行", "説明"], [[e["run"], e["note"]] for e in examples])
    return [f"- {_esc(path)}: {_esc(json.dumps(value, ensure_ascii=False))}", ""]


def render_body(entry: dict[str, Any], posix: list[dict[str, Any]]) -> list[str]:
    """本文を POSIX の節の順に並べる。中身のある節だけを出す。"""
    out: list[str] = []
    for row in posix:
        lines: list[str] = []
        for path in cast("list[str]", row["fields"]):
            value = _get(entry, path)
            if value is not _MISSING:
                lines += render_field(path, value)
        if lines:
            out += [f"**{_esc(row['section'])}**", "", *lines]
    return out


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


def build_plan(
    generated: dict[str, Any], authored: dict[str, Any], posix: list[dict[str, Any]]
) -> Plan:
    plan = Plan()
    entries = cast("dict[str, dict[str, Any]]", authored.get("entries", {}))
    for g in cast("list[dict[str, Any]]", generated.get("entries", [])):
        gid = str(g.get("id", "?"))
        a = entries.get(gid)
        if a is None:
            plan.warnings.append(f"{gid}: authored.yaml に項目が無いため、飛ばしました")
            continue
        try:
            command = Command(
                id=gid,
                name=str(g["name"]),
                tags=sorted(cast("dict[str, Any]", g["surfaces"])),
                body=render_body({**g, **a}, posix),
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
    def _posix(self) -> list[dict[str, Any]]:
        path = Path(self.config.iface_field_map)
        self.env.note_dependency(str(path))
        if not path.is_file():
            return []
        return cast("list[dict[str, Any]]", _load_json(path)["posix"])

    def _plan(self, plugin: str) -> Plan:
        interface = Path(self.config.iface_root) / "plugins" / plugin / "interface"
        generated, authored = interface / "generated.json", interface / "authored.yaml"
        self.env.note_dependency(str(generated))
        self.env.note_dependency(str(authored))
        return build_plan(_load_json(generated), _load_yaml(authored), self._posix())

    def _collect(self, plugin: str, known: frozenset[str]) -> Collected:
        paths = _config_junit(self.config, plugin)
        for path in paths:
            self.env.note_dependency(str(path))
        return collect(paths, known)


class IfaceDefs(_Base):
    required_arguments = 1

    def run(self) -> list[nodes.Node]:
        plugin = self.arguments[0]
        plan = self._plan(plugin)
        collected = self._collect(plugin, plan.ids)
        for message in plan.warnings:
            logger.warning(message, location=(self.env.docname, self.lineno))
        for message in collected.unreadable:
            logger.warning(
                "JUnit を読めませんでした: %s", message, location=(self.env.docname, self.lineno)
            )
        source = NeedItemSource.from_directive(self)
        out: list[nodes.Node] = []
        for command in plan.commands:
            out += self._need(
                "cmd", command.name, command.id, {"tags": command.tags}, None, command.body, source
            )
            for b in (b for b in plan.behaviors if b.belongs == command.id):
                out += self._behavior(b, collected, source)
        for b in (b for b in plan.behaviors if b.belongs is None):
            out += self._behavior(b, collected, source)
        return out

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
        try:
            _, created = create_need(
                self.env.app,
                self.state,
                source,
                kind,
                title,
                id=need_id,
                fields=fields,
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
            return self._message("JUnit が無いため、合否は未実行です。")
        if not collected.files:
            return self._message("項目につながるテストが無いため、表を出しません。")
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
            [r["section"], ", ".join(r["fields"]) or "（欄にしない）", r["writer"], r["mcp"]]
            for r in data["posix"]
        ]
        borrowed = [[", ".join(r["fields"]), r["source"]] for r in data["borrowed"]]
        lines = [
            *_table("POSIX の節と欄の対応", ["節", "欄", "書き手", "MCP"], posix),
            *_table("借りた枠組みの欄", ["欄", "借りた元"], borrowed),
        ]
        return self.parse_text_to_nodes("\n".join(lines))


def setup(app: Sphinx) -> ExtensionMetadata:
    app.add_config_value("iface_root", "", "env", types=[str])
    app.add_config_value("iface_junit", {}, "env", types=[dict])
    app.add_config_value("iface_field_map", "", "env", types=[str])
    app.add_directive("iface-defs", IfaceDefs)
    app.add_directive("iface-tests", IfaceTests)
    app.add_directive("iface-field-map", IfaceFieldMap)
    return {"parallel_read_safe": True, "parallel_write_safe": True}
