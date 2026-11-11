"""Tests for scripts/interface/export.py, which writes and checks interface/generated.json."""

from __future__ import annotations

import importlib.util
import json
import sys
from collections.abc import Callable, Iterator
from enum import Enum
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Annotated

import pytest
import typer
import typer.main
from typer.core import TyperGroup

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = PLUGIN_ROOT / "scripts" / "interface" / "export.py"
SAMPLE_FIXTURE = PLUGIN_ROOT / "cli-node" / "tests" / "interface-export" / "typer-sample.json"
GENERATED = PLUGIN_ROOT / "interface" / "generated.json"
RUN_LINE = "  run: plugins/pecot-workflow/scripts/interface/export.py --write\n"


def _load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("interface_export", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["interface_export"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def export() -> Iterator[ModuleType]:
    module = _load_script()
    yield module
    sys.modules.pop("interface_export", None)


class Mode(str, Enum):
    FAST = "fast"
    SLOW = "slow"


def sample_app() -> typer.Typer:
    """Sample app. alpha and beta are compared with Node; the sub commands are hidden or deprecated."""
    app = typer.Typer()
    sub = typer.Typer()

    @app.callback()
    def root(  # pyright: ignore[reportUnusedFunction]
        repo: Annotated[str | None, typer.Option("--repo", help="Global repository.")] = None,
    ) -> None:
        """Sample CLI."""

    @app.command()
    def alpha(
        name: Annotated[str, typer.Argument(help="Name to greet.")],
        count: Annotated[int, typer.Option("--count", "-c", help="How many times.")] = 3,
        mode: Annotated[Mode, typer.Option("--mode", help="Mode.")] = Mode.FAST,
        json_output: Annotated[bool, typer.Option("--json", "-j", help="Print JSON.")] = False,
        verbose: Annotated[bool, typer.Option("--verbose/--no-verbose", help="Be loud.")] = True,
    ) -> None:
        """Greet someone

        Longer text that is not part of the description.
        """

    @app.command()
    def beta(
        source: Annotated[Path | None, typer.Argument(help="Optional source.")] = None,
        files: Annotated[list[Path] | None, typer.Argument(help="Files to read.")] = None,
        labels: Annotated[list[str] | None, typer.Option("--label", "-l", help="Labels.")] = None,
        limit: Annotated[int, typer.Option("--limit", min=1, max=10, help="Upper limit.")] = 5,
    ) -> None:
        """Read files."""

    @sub.command("hidden-cmd", hidden=True)
    def hidden_cmd(
        when: Annotated[str, typer.Option("--when", default_factory=lambda: "now", help="When.")],
    ) -> None:
        """Hidden command."""

    @sub.command("old-cmd", deprecated=True)
    def old_cmd() -> None:
        """Deprecated command."""

    app.add_typer(sub, name="sub")
    _ = (alpha, beta, hidden_cmd, old_cmd, root)
    return app


def _entry(data: dict[str, object], entry_id: str) -> dict[str, object]:
    entries = data["entries"]
    assert isinstance(entries, list)
    for item in entries:
        if item["id"] == entry_id:
            return item
    raise AssertionError(entry_id)


# --- 書き出し -----------------------------------------------------------------


def test_sample_export_matches_shared_fixture_byte_for_byte(export: ModuleType) -> None:
    rendered = export.render(export.build_file(sample_app()))
    # Regenerate: run this file with cli/.venv/bin/python from plugins/pecot-workflow/cli.
    assert rendered == SAMPLE_FIXTURE.read_text(encoding="utf-8")


def test_header_and_entries_are_sorted_by_id(export: ModuleType) -> None:
    data = export.build_file(sample_app())
    assert list(data) == ["format", "plugin", "prefix", "entries"]
    assert data["format"] == 1
    assert data["plugin"] == "pecot-workflow"
    assert data["prefix"] == "PW"
    ids = [e["id"] for e in data["entries"]]
    assert ids == ["PW-ALPHA", "PW-BETA", "PW-SUB-HIDDEN-CMD", "PW-SUB-OLD-CMD"]


def test_entry_fields_and_key_order(export: ModuleType) -> None:
    data = export.build_file(sample_app())
    alpha = _entry(data, "PW-ALPHA")
    assert list(alpha) == [
        "id", "name", "description", "surfaces", "hidden", "deprecated", "input", "cli",
    ]  # fmt: skip
    assert alpha["name"] == "alpha"
    assert alpha["description"] == "Greet someone"
    assert alpha["surfaces"] == {"cli": {"path": ["alpha"]}}
    assert alpha["hidden"] is False
    assert alpha["deprecated"] is False


def test_input_types_defaults_and_required(export: ModuleType) -> None:
    data = export.build_file(sample_app())
    alpha = _entry(data, "PW-ALPHA")
    assert alpha["input"] == {
        "type": "object",
        "properties": {
            "count": {"type": "integer", "default": 3, "description": "How many times."},
            "json": {"type": "boolean", "default": False, "description": "Print JSON."},
            "mode": {
                "type": "string",
                "enum": ["fast", "slow"],
                "default": "fast",
                "description": "Mode.",
            },
            "name": {"type": "string", "description": "Name to greet."},
            "verbose": {"type": "boolean", "default": True, "description": "Be loud."},
        },
        "required": ["name"],
        "additionalProperties": False,
    }
    assert list(alpha["input"]["properties"]["count"]) == ["type", "default", "description"]


def test_positional_order_flags_and_arrays(export: ModuleType) -> None:
    data = export.build_file(sample_app())
    alpha = _entry(data, "PW-ALPHA")
    assert alpha["cli"] == {
        "positional": ["name"],
        "flags": {
            "count": ["--count", "-c"],
            "json": ["--json", "-j"],
            "mode": ["--mode"],
            "verbose": ["--verbose", "--no-verbose"],
        },
    }
    beta = _entry(data, "PW-BETA")
    assert beta["cli"]["positional"] == ["source", "files"]
    props = beta["input"]["properties"]
    assert props["files"] == {
        "type": "array",
        "items": {"type": "string"},
        "description": "Files to read.",
    }
    assert props["label"]["type"] == "array"
    assert props["limit"] == {
        "type": "integer",
        "minimum": 1,
        "maximum": 10,
        "default": 5,
        "description": "Upper limit.",
    }
    assert beta["input"]["required"] == []


def test_hidden_deprecated_and_callable_default(export: ModuleType) -> None:
    data = export.build_file(sample_app())
    hidden = _entry(data, "PW-SUB-HIDDEN-CMD")
    assert hidden["hidden"] is True
    assert hidden["surfaces"] == {"cli": {"path": ["sub", "hidden-cmd"]}}
    assert "default" not in hidden["input"]["properties"]["when"]
    assert _entry(data, "PW-SUB-OLD-CMD")["deprecated"] is True


def test_root_callback_options_are_not_entries(export: ModuleType) -> None:
    rendered = export.render(export.build_file(sample_app()))
    assert "Global repository." not in rendered


def test_render_format(export: ModuleType) -> None:
    text = export.render({"b": "é", "a": [1]})
    assert text == json.dumps({"b": "é", "a": [1]}, indent=2, ensure_ascii=False) + "\n"
    assert text.endswith("}\n")
    assert not text.endswith("\n\n")


def _app_of(command: Callable[..., None]) -> typer.Typer:
    app = typer.Typer()
    app.command("one")(command)

    @app.command("two")
    def two() -> None:
        """Two."""

    _ = two
    return app


def _float_option(ratio: Annotated[float, typer.Option("--ratio")] = 1.0) -> None:
    """One."""


def _clamped(value: Annotated[int, typer.Option("--value", min=1, clamp=True)] = 2) -> None:
    """One."""


def _with_envvar(value: Annotated[str, typer.Option("--value", envvar="SOME_VAR")] = "x") -> None:
    """One."""


def _without_help() -> None:
    pass


def _colliding(
    x: Annotated[str, typer.Argument()],
    other: Annotated[str, typer.Option("--x")] = "",
) -> None:
    """One."""


def _param(**overrides: object) -> SimpleNamespace:
    base: dict[str, object] = {
        "name": "v",
        "opts": ["--v"],
        "secondary_opts": [],
        "type": SimpleNamespace(name="str"),
        "required": False,
        "nargs": 1,
        "multiple": False,
        "default": None,
        "help": None,
        "hidden": False,
        "envvar": None,
        "count": False,
        "is_flag": False,
        "is_bool_flag": False,
    }
    return SimpleNamespace(**{**base, **overrides})


def _int_range(**overrides: object) -> SimpleNamespace:
    base = {"name": "int range", "min": 1, "max": 2, "min_open": False, "max_open": False}
    return SimpleNamespace(**{**base, "clamp": False, **overrides})


def _schema(**overrides: object) -> Callable[[ModuleType, pytest.MonkeyPatch], object]:
    return lambda export, _mp: export._property_schema(_param(**overrides), "one: v")


def _two_commands_one_id(export: ModuleType, _mp: pytest.MonkeyPatch) -> object:
    app = typer.Typer()
    sub = typer.Typer()

    @app.command("a-b")
    def a_b() -> None:
        """One."""

    @sub.command("b")
    def b() -> None:
        """Two."""

    app.add_typer(sub, name="a")
    _ = (a_b, b)
    return export.build_file(app)


def _root_is_not_a_group(export: ModuleType, _mp: pytest.MonkeyPatch) -> object:
    app = typer.Typer()

    @app.command("only")
    def only() -> None:
        """Only."""

    _ = only
    return export.build_file(app)


def _unknown_command_class(export: ModuleType, monkeypatch: pytest.MonkeyPatch) -> object:
    group = TyperGroup(name="root", commands={"x": SimpleNamespace()})  # pyright: ignore[reportArgumentType]
    monkeypatch.setattr(typer.main, "get_command", lambda _app: group)
    return export.build_file(typer.Typer())


def _no_long_name(export: ModuleType, _mp: pytest.MonkeyPatch) -> object:
    return export._input_name(_param(opts=["-v"]), True, "one")


UNSUPPORTED_SHAPES = {
    "hidden parameter": (_schema(hidden=True), "one: v: hidden parameter"),
    "envvar": (_schema(envvar="X"), "one: v: envvar is not supported"),
    "count": (_schema(count=True), "one: v: count option"),
    "non-boolean flag": (_schema(is_flag=True), "one: v: non-boolean flag"),
    "nargs 2": (_schema(nargs=2), r"one: v: nargs=2"),
    "unknown type": (
        _schema(type=SimpleNamespace(name="float")),
        "one: v: unsupported parameter type 'float'",
    ),
    "clamped range": (_schema(type=_int_range(clamp=True)), "one: v: open or clamped"),
    "open range": (_schema(type=_int_range(min_open=True)), "one: v: open or clamped"),
    "float default": (_schema(default=1.0), "one: v: unsupported default value 1.0"),
    "object default": (_schema(default=object()), "one: v: unsupported default value"),
    "no long name": (_no_long_name, "one: option 'v' has no long name"),
    "duplicate id": (_two_commands_one_id, "two commands produce the same id 'PW-A-B'"),
    "root is not a group": (_root_is_not_a_group, "the command tree root is not a group"),
    "unknown command class": (_unknown_command_class, "x: unexpected command class"),
    "real float option": (
        lambda export, _mp: export.build_file(_app_of(_float_option)),
        "one: ratio: unsupported parameter type 'float'",
    ),
    "real clamp": (
        lambda export, _mp: export.build_file(_app_of(_clamped)),
        "one: value: open or clamped",
    ),
    "real envvar": (
        lambda export, _mp: export.build_file(_app_of(_with_envvar)),
        "one: value: envvar is not supported",
    ),
    "real missing help": (
        lambda export, _mp: export.build_file(_app_of(_without_help)),
        "one: help is missing",
    ),
    "real name collision": (
        lambda export, _mp: export.build_file(_app_of(_colliding)),
        "one: input name 'x' collides with another parameter",
    ),
}


@pytest.mark.parametrize("case", UNSUPPORTED_SHAPES)
def test_unsupported_shape_raises_export_error(
    export: ModuleType, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    build, message = UNSUPPORTED_SHAPES[case]
    with pytest.raises(export.ExportError, match=message):
        build(export, monkeypatch)


def test_enum_choice_values_and_default_are_strings(export: ModuleType) -> None:
    class Level(int, Enum):
        ONE = 1
        TWO = 2

    choice = SimpleNamespace(name="choice", choices=[Level.ONE, Level.TWO])
    assert export._scalar_schema(choice, "one: v") == {"type": "string", "enum": ["1", "2"]}
    assert export._default_value(Level.ONE, "one: v") == "1"


# --- 差の行 -------------------------------------------------------------------


def _file(entries: list[dict[str, object]], **header: object) -> dict[str, object]:
    return {"format": 1, "plugin": "pecot-workflow", "prefix": "PW", "entries": entries, **header}


def _e(entry_id: str, props: dict[str, object], **extra: object) -> dict[str, object]:
    return {
        "id": entry_id,
        "surfaces": {"cli": {"path": ["x"]}},
        "input": {"type": "object", "properties": props, "required": []},
        **extra,
    }


def test_diff_identical_is_empty(export: ModuleType) -> None:
    same = _file([_e("PW-A", {"a": {"type": "string"}})])
    assert export.diff_generated(same, same) == []


def test_diff_names_added_changed_and_removed_properties(export: ModuleType) -> None:
    before = _file(
        [_e("PW-ISSUE-CREATE", {"draft": {"type": "boolean", "default": False}, "gone": {}})]
    )
    after = _file(
        [_e("PW-ISSUE-CREATE", {"draft": {"type": "boolean", "default": True}, "label": {}})]
    )
    assert export.diff_generated(before, after) == [
        "PW-ISSUE-CREATE: input.properties.draft.default: false -> true",
        "PW-ISSUE-CREATE: input.properties.gone: removed",
        "PW-ISSUE-CREATE: input.properties.label: added",
    ]


def test_diff_names_added_and_removed_entries_in_id_order(export: ModuleType) -> None:
    before = _file([_e("PW-B", {}), _e("PW-C", {})])
    after = _file([_e("PW-A", {}), _e("PW-B", {})])
    assert export.diff_generated(before, after) == [
        "PW-A: entry: added",
        "PW-C: entry: removed",
    ]


def test_diff_compares_array_items_by_index(export: ModuleType) -> None:
    def with_path(path: list[str]) -> dict[str, object]:
        return _file([_e("PW-A", {}, surfaces={"cli": {"path": path}})])

    before = with_path(["a", "b"])
    after = with_path(["a", "c", "d"])
    assert export.diff_generated(before, after) == [
        'PW-A: surfaces.cli.path[1]: "b" -> "c"',
        "PW-A: surfaces.cli.path[2]: added",
    ]
    assert export.diff_generated(after, before) == [
        'PW-A: surfaces.cli.path[1]: "c" -> "b"',
        "PW-A: surfaces.cli.path[2]: removed",
    ]


def test_diff_distinguishes_true_from_one_and_shows_type_change(export: ModuleType) -> None:
    before = _file([_e("PW-A", {"a": {"type": "string", "default": 1}})])
    after = _file([_e("PW-A", {"a": {"type": "string", "default": [1]}})])
    assert export.diff_generated(before, after) == ["PW-A: input.properties.a.default: 1 -> [1]"]
    true_file = _file([_e("PW-A", {"a": {"default": True}})])
    one_file = _file([_e("PW-A", {"a": {"default": 1}})])
    assert export.diff_generated(true_file, one_file) == [
        "PW-A: input.properties.a.default: true -> 1"
    ]


def test_diff_reports_header_change(export: ModuleType) -> None:
    assert export.diff_generated(_file([]), _file([], prefix="PV")) == [
        'file: prefix: "PW" -> "PV"'
    ]


# --- --check / --write --------------------------------------------------------


def _write_generated(export: ModuleType, tmp_path: Path, app: typer.Typer) -> Path:
    path = tmp_path / "generated.json"
    path.write_text(export.render(export.build_file(app)), encoding="utf-8")
    return path


def test_check_passes_silently_when_equal(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = _write_generated(export, tmp_path, sample_app())
    assert export.main(["--check"], app=sample_app(), generated_path=path) == 0
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


def _app_with_extra_option() -> typer.Typer:
    app = typer.Typer()

    @app.command("one")
    def one(
        label: Annotated[str | None, typer.Option("--label", help="Label.")] = None,
    ) -> None:
        """One."""

    @app.command("two")
    def two() -> None:
        """Two."""

    _ = (one, two)
    return app


def _app_without_extra_option() -> typer.Typer:
    app = typer.Typer()

    @app.command("one")
    def one() -> None:
        """One."""

    @app.command("two")
    def two() -> None:
        """Two."""

    _ = (one, two)
    return app


def test_check_reports_added_option_and_exits_1(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = _write_generated(export, tmp_path, _app_without_extra_option())
    code = export.main(["--check"], app=_app_with_extra_option(), generated_path=path)
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    lines = captured.err.splitlines(keepends=True)
    assert lines[0] == f"error: {path} is stale\n"
    assert "  PW-ONE: input.properties.label: added\n" in lines
    assert lines[-1] == RUN_LINE


def test_check_reports_missing_file(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "generated.json"
    code = export.main(["--check"], app=sample_app(), generated_path=path)
    assert code == 1
    assert capsys.readouterr().err == f"error: {path}: file is missing\n{RUN_LINE}"


def test_check_reports_formatting_only_difference(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = _write_generated(export, tmp_path, sample_app())
    data = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps(data, indent=4, ensure_ascii=False) + "\n", encoding="utf-8")
    code = export.main(["--check"], app=sample_app(), generated_path=path)
    assert code == 1
    assert capsys.readouterr().err == (
        f"error: {path} is stale\n  generated.json: formatting differs\n{RUN_LINE}"
    )


def test_display_path_is_relative_to_repo_root(export: ModuleType) -> None:
    assert export.display_path(GENERATED) == "plugins/pecot-workflow/interface/generated.json"


def test_write_twice_reports_updated_then_unchanged(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "generated.json"
    assert export.main(["--write"], app=sample_app(), generated_path=path) == 0
    assert capsys.readouterr().err == f"updated: {path}\n"
    assert path.read_text(encoding="utf-8") == export.render(export.build_file(sample_app()))
    assert export.main(["--write"], app=sample_app(), generated_path=path) == 0
    assert capsys.readouterr().err == f"unchanged: {path}\n"


def test_exactly_one_mode_is_required(
    export: ModuleType, capsys: pytest.CaptureFixture[str]
) -> None:
    for argv in ([], ["--check", "--write"]):
        with pytest.raises(SystemExit) as raised:
            export.main(argv, app=sample_app())
        assert raised.value.code == 2
    capsys.readouterr()


def test_export_error_exits_2(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = export.main(["--check"], app=_app_of(_without_help), generated_path=tmp_path / "g.json")
    assert code == 2
    assert capsys.readouterr().err == "error: one: help is missing\n"


def test_cli_import_failure_exits_2(
    export: ModuleType,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setitem(sys.modules, "cli.commands.main", None)
    assert export.main(["--check"], generated_path=tmp_path / "g.json") == 2
    assert capsys.readouterr().err.startswith("error: cannot load the pecot-workflow CLI (")


def test_check_reports_invalid_json_and_bad_utf8(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "generated.json"
    for content in (b"{", b"\xff\xfe"):
        path.write_bytes(content)
        assert export.main(["--check"], app=sample_app(), generated_path=path) == 1
        lines = capsys.readouterr().err.splitlines(keepends=True)
        assert len(lines) == 2
        assert lines[0].startswith(f"error: {path}: not valid JSON (")
        assert lines[1] == RUN_LINE


def test_check_reports_unexpected_structure(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "generated.json"
    path.write_text(json.dumps({"entries": [{"name": "x"}]}), encoding="utf-8")
    assert export.main(["--check"], app=sample_app(), generated_path=path) == 1
    assert capsys.readouterr().err == (
        f"error: {path} is stale\n  generated.json: unexpected structure\n{RUN_LINE}"
    )


def test_crlf_file_is_a_formatting_difference_and_write_restores_lf(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "generated.json"
    text = export.render(export.build_file(sample_app()))
    path.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
    assert export.main(["--check"], app=sample_app(), generated_path=path) == 1
    assert capsys.readouterr().err == (
        f"error: {path} is stale\n  generated.json: formatting differs\n{RUN_LINE}"
    )
    assert export.main(["--write"], app=sample_app(), generated_path=path) == 0
    assert path.read_bytes() == text.encode("utf-8")
    capsys.readouterr()


# --- venv の起動し直し ---------------------------------------------------------


class _Exec:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []

    def __call__(self, path: str, args: list[str]) -> None:
        self.calls.append((path, args))


def _venv(tmp_path: Path) -> Path:
    venv = tmp_path / ".venv"
    (venv / "bin").mkdir(parents=True)
    (venv / "bin" / "python").write_text("", encoding="utf-8")
    return venv


def test_reexec_when_outside_venv(export: ModuleType, tmp_path: Path) -> None:
    venv = _venv(tmp_path)
    run = _Exec()
    environ: dict[str, str] = {}
    result = export.ensure_venv(
        ["--check"], prefix=str(tmp_path / "other"), venv_dir=venv, environ=environ, execv=run
    )
    assert result is None
    python = str(venv / "bin" / "python")
    assert run.calls == [(python, [python, str(SCRIPT), "--check"])]
    assert environ == {export.REEXEC_MARKER: "1"}


def test_no_reexec_inside_venv(export: ModuleType, tmp_path: Path) -> None:
    venv = _venv(tmp_path)
    run = _Exec()
    result = export.ensure_venv(
        ["--check"], prefix=str(venv), venv_dir=venv, environ={export.REEXEC_MARKER: "1"}, execv=run
    )
    assert result is None
    assert run.calls == []


def test_marker_outside_venv_exits_2_without_reexec(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    venv = _venv(tmp_path)
    run = _Exec()
    code = export.ensure_venv(
        ["--check"],
        prefix=str(tmp_path / "other"),
        venv_dir=venv,
        environ={export.REEXEC_MARKER: "1"},
        execv=run,
    )
    assert code == 2
    assert run.calls == []
    assert capsys.readouterr().err == (
        f"error: {venv} is not active\n  run: cd plugins/pecot-workflow/cli && uv sync\n"
    )


def test_missing_venv_exits_2_with_uv_sync_hint(
    export: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    run = _Exec()
    code = export.ensure_venv(
        ["--check"],
        prefix=str(tmp_path / "other"),
        venv_dir=tmp_path / ".venv",
        environ={},
        execv=run,
    )
    assert code == 2
    assert run.calls == []
    assert capsys.readouterr().err == (
        f"error: {tmp_path / '.venv'} is missing\n  run: cd plugins/pecot-workflow/cli && uv sync\n"
    )


# --- 実物の app ---------------------------------------------------------------


def test_real_app_matches_committed_generated_json(
    export: ModuleType, capsys: pytest.CaptureFixture[str]
) -> None:
    assert export.main(["--check"]) == 0
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


if __name__ == "__main__":
    module = _load_script()
    SAMPLE_FIXTURE.write_text(module.render(module.build_file(sample_app())), encoding="utf-8")
