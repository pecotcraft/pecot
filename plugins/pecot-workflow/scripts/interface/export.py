#!/usr/bin/env python3
"""Write or check plugins/pecot-workflow/interface/generated.json from the typer command tree.

    export.py --check   exit 1 with the differing lines when generated.json is stale
    export.py --write   rewrite generated.json

The format is specs/022-interface-definitions/contracts/definition-format.md.
"""

from __future__ import annotations

import argparse
import enum
import json
import os
import sys
from collections.abc import Callable, Mapping, MutableMapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    import typer

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PLUGIN_ROOT.parents[1]
GENERATED_PATH = PLUGIN_ROOT / "interface" / "generated.json"
VENV_DIR = PLUGIN_ROOT / "cli" / ".venv"
REEXEC_MARKER = "PECOT_INTERFACE_EXPORT_REEXEC"
FORMAT = 1
PLUGIN = "pecot-workflow"
PREFIX = "PW"
RUN_WRITE = "plugins/pecot-workflow/scripts/interface/export.py --write"
STRING_TYPES = frozenset({"str", "path", "directory", "file"})

Json = dict[str, Any]


class ExportError(Exception):
    """The command tree has a shape that generated.json cannot express."""


def _scalar_schema(type_: Any, where: str) -> Json:
    name = str(type_.name)
    if name in STRING_TYPES:
        return {"type": "string"}
    if name == "int":
        return {"type": "integer"}
    if name == "boolean":
        return {"type": "boolean"}
    if name == "choice":
        choices = [c.value if isinstance(c, enum.Enum) else str(c) for c in type_.choices]
        return {"type": "string", "enum": choices}
    if name == "int range":
        if any(getattr(type_, a, False) for a in ("min_open", "max_open", "clamp")):
            raise ExportError(f"{where}: open or clamped int range is not supported")
        schema: Json = {"type": "integer"}
        if getattr(type_, "min", None) is not None:
            schema["minimum"] = type_.min
        if getattr(type_, "max", None) is not None:
            schema["maximum"] = type_.max
        return schema
    raise ExportError(f"{where}: unsupported parameter type {name!r}")


def _default_value(default: Any, where: str) -> Any:
    if isinstance(default, enum.Enum):
        return default.value
    if isinstance(default, (list, tuple)):
        return [_default_value(item, where) for item in cast("Sequence[Any]", default)]
    if isinstance(default, (str, int, float, bool)):
        return default
    raise ExportError(f"{where}: unsupported default value {default!r}")


def _property_schema(param: Any, where: str) -> Json:
    if param.hidden:
        raise ExportError(f"{where}: hidden parameter is not supported")
    if param.envvar:
        raise ExportError(f"{where}: envvar is not supported")
    if getattr(param, "count", False):
        raise ExportError(f"{where}: count option is not supported")
    if getattr(param, "is_flag", False) and not getattr(param, "is_bool_flag", False):
        raise ExportError(f"{where}: non-boolean flag is not supported")
    element = _scalar_schema(param.type, where)
    if param.nargs not in (1, -1):
        raise ExportError(f"{where}: nargs={param.nargs} is not supported")
    schema: Json = (
        {"type": "array", "items": element} if param.multiple or param.nargs == -1 else element
    )
    default = param.default
    if default is not None and not callable(default):
        schema["default"] = _default_value(default, where)
    if param.help:
        schema["description"] = param.help
    return schema


def _flags_of(param: Any) -> list[str]:
    opts = [str(o) for o in param.opts]
    longs = [o for o in opts if o.startswith("--")]
    shorts = [o for o in opts if not o.startswith("--")]
    return [*longs, *shorts, *(str(o) for o in param.secondary_opts)]


def _input_name(param: Any, is_option: bool, where: str) -> str:
    if not is_option:
        return str(param.name)
    longs = [str(o) for o in param.opts if str(o).startswith("--")]
    if not longs:
        raise ExportError(f"{where}: option {param.name!r} has no long name")
    return longs[0][2:].replace("-", "_")


def _entry(path: list[str], command: Any, argument_cls: type, option_cls: type) -> Json:
    name = " ".join(path)
    where = name
    if not command.help:
        raise ExportError(f"{where}: help is missing")
    properties: Json = {}
    required: list[str] = []
    positional: list[str] = []
    flags: dict[str, list[str]] = {}
    for param in command.params:
        is_option = isinstance(param, option_cls)
        if not is_option and not isinstance(param, argument_cls):
            raise ExportError(f"{where}: unexpected parameter class {type(param).__name__}")
        input_name = _input_name(param, is_option, where)
        if input_name in properties:
            raise ExportError(f"{where}: input name {input_name!r} collides with another parameter")
        properties[input_name] = _property_schema(param, f"{where}: {input_name}")
        if param.required:
            required.append(input_name)
        if is_option:
            flags[input_name] = _flags_of(param)
        else:
            positional.append(input_name)
    return {
        "id": "PW-" + name.upper().replace(" ", "-").replace("_", "-"),
        "name": name,
        "description": str(command.help).strip().splitlines()[0].strip(),
        "surfaces": {"cli": {"path": path}},
        "hidden": bool(command.hidden),
        "deprecated": bool(command.deprecated),
        "input": {
            "type": "object",
            "properties": dict(sorted(properties.items())),
            "required": sorted(required),
            "additionalProperties": False,
        },
        "cli": {"positional": positional, "flags": dict(sorted(flags.items()))},
    }


def build_file(app: typer.Typer) -> Json:
    """Build the generated.json content from a typer app."""
    import typer.main
    from typer.core import TyperArgument, TyperCommand, TyperGroup, TyperOption

    root = typer.main.get_command(app)
    if not isinstance(root, TyperGroup):
        raise ExportError("the command tree root is not a group")
    entries: list[Json] = []

    def walk(group: Any, path: list[str]) -> None:
        for name, sub in cast("Mapping[str, Any]", group.commands).items():
            if isinstance(sub, TyperGroup):
                walk(sub, [*path, name])
            elif isinstance(sub, TyperCommand):
                entries.append(_entry([*path, name], sub, TyperArgument, TyperOption))
            else:
                raise ExportError(f"{' '.join([*path, name])}: unexpected command class")

    walk(root, [])
    ids = [e["id"] for e in entries]
    if len(set(ids)) != len(ids):
        raise ExportError("two commands produce the same id")
    entries.sort(key=lambda e: e["id"])
    return {"format": FORMAT, "plugin": PLUGIN, "prefix": PREFIX, "entries": entries}


def render(data: object) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _show(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _compare(before: Any, after: Any, path: str, emit: Callable[[str, str], None]) -> None:
    left: object = before
    right: object = after
    if isinstance(before, dict) and isinstance(after, dict):
        b, a = cast("dict[str, Any]", before), cast("dict[str, Any]", after)
        for key in sorted({*b, *a}):
            child = key if path == "" else f"{path}.{key}"
            if key in b and key in a:
                _compare(b[key], a[key], child, emit)
            else:
                emit(child, "added" if key in a else "removed")
    elif isinstance(before, list) and isinstance(after, list):
        bl, al = cast("list[Any]", before), cast("list[Any]", after)
        for index in range(max(len(bl), len(al))):
            child = f"{path}[{index}]"
            if index >= len(bl):
                emit(child, "added")
            elif index >= len(al):
                emit(child, "removed")
            else:
                _compare(bl[index], al[index], child, emit)
    elif _show(left) != _show(right):
        emit(path, f"{_show(left)} -> {_show(right)}")


def diff_generated(before: Mapping[str, Any], after: Mapping[str, Any]) -> list[str]:
    """Port of libs/interface-spec/src/domain/diff.ts diffGenerated."""
    lines: list[str] = []
    for key in ("format", "plugin", "prefix"):
        _compare(
            before.get(key),
            after.get(key),
            key,
            lambda p, c: lines.append(f"file: {p}: {c}"),
        )
    by_id_before = {e["id"]: e for e in cast("list[Json]", before.get("entries", []))}
    by_id_after = {e["id"]: e for e in cast("list[Json]", after.get("entries", []))}
    for entry_id in sorted({*by_id_before, *by_id_after}):
        old = by_id_before.get(entry_id)
        new = by_id_after.get(entry_id)
        if old is None or new is None:
            lines.append(f"{entry_id}: entry: {'added' if old is None else 'removed'}")
            continue
        _compare(old, new, "", lambda p, c, i=entry_id: lines.append(f"{i}: {p}: {c}"))
    return lines


def display_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def ensure_venv(
    argv: Sequence[str],
    *,
    prefix: str | None = None,
    venv_dir: Path = VENV_DIR,
    environ: MutableMapping[str, str] | None = None,
    execv: Callable[[str, list[str]], object] = os.execv,
) -> int | None:
    """Re-run under cli/.venv when started by another Python. Returns an exit code to stop, else None."""
    env = os.environ if environ is None else environ
    current = Path(sys.prefix if prefix is None else prefix).resolve()
    if current == venv_dir.resolve() or REEXEC_MARKER in env:
        return None
    python = venv_dir / "bin" / "python"
    if not python.exists():
        sys.stderr.write(
            f"error: {display_path(venv_dir)} is missing\n"
            "  run: cd plugins/pecot-workflow/cli && uv sync\n"
        )
        return 2
    env[REEXEC_MARKER] = "1"
    execv(str(python), [str(python), str(Path(__file__).resolve()), *argv])
    return None


def _parse(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Write or check interface/generated.json.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="exit 1 if generated.json is stale")
    mode.add_argument("--write", action="store_true", help="rewrite generated.json")
    return parser.parse_args(list(argv))


def main(
    argv: Sequence[str],
    *,
    app: typer.Typer | None = None,
    generated_path: Path = GENERATED_PATH,
) -> int:
    args = _parse(argv)
    if str(PLUGIN_ROOT) not in sys.path:
        sys.path.insert(0, str(PLUGIN_ROOT))
    from cli.commands._output import Operation, Output, Verb

    out = Output(dry_run=False)
    shown = display_path(generated_path)
    try:
        if app is None:
            from cli.commands.main import app as real_app

            app = real_app
        expected = render(build_file(app))
    except ExportError as error:
        out.error(str(error))
        return 2
    current = generated_path.read_text(encoding="utf-8") if generated_path.exists() else None
    if args.write:
        if current != expected:
            generated_path.parent.mkdir(parents=True, exist_ok=True)
            generated_path.write_text(expected, encoding="utf-8")
        verb = Verb.UNCHANGED if current == expected else Verb.UPDATE
        out.done(Operation(verb, shown))
        return 0
    if current == expected:
        return 0
    if current is None:
        out.error(f"{shown}: file is missing\nrun: {RUN_WRITE}")
        return 1
    try:
        lines = diff_generated(json.loads(current), json.loads(expected))
    except (ValueError, AttributeError, TypeError, KeyError):
        lines = []
    body = "\n".join(lines or ["generated.json: formatting differs"])
    out.error(f"{shown} is stale\n{body}\nrun: {RUN_WRITE}")
    return 1


if __name__ == "__main__":
    stop = ensure_venv(sys.argv[1:])
    sys.exit(stop if stop is not None else main(sys.argv[1:]))
