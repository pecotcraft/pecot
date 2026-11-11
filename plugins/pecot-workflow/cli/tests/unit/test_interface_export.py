"""tests/unit/test_interface_export.py - scripts/interface/export.py（generated.json の書き出し）のテスト

- 見本の typer の app の書き出しを、共有の fixture（typer-sample.json）とバイト列で比べる
- 型の写し・名前の決め・決定性・例外で止める形を確かめる
- --check の 4 通り、--write の 2 回、差の行の規則、venv の起動し直しを確かめる
- 実物の app で --check が通ること（T021）
"""

from __future__ import annotations

import importlib.util
import json
import sys
from collections.abc import Callable
from enum import Enum
from pathlib import Path
from types import ModuleType
from typing import Annotated

import pytest
import typer

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


export = _load_script()


class Mode(str, Enum):
    FAST = "fast"
    SLOW = "slow"


def sample_app() -> typer.Typer:
    """Node 側と比べる 2 コマンド（alpha・beta）と、hidden・deprecated の 2 コマンドを持つ見本。"""
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


def test_sample_export_matches_shared_fixture_byte_for_byte() -> None:
    rendered = export.render(export.build_file(sample_app()))
    assert rendered == SAMPLE_FIXTURE.read_text(encoding="utf-8")


def test_header_and_entries_are_sorted_by_id() -> None:
    data = export.build_file(sample_app())
    assert list(data) == ["format", "plugin", "prefix", "entries"]
    assert data["format"] == 1
    assert data["plugin"] == "pecot-workflow"
    assert data["prefix"] == "PW"
    ids = [e["id"] for e in data["entries"]]
    assert ids == ["PW-ALPHA", "PW-BETA", "PW-SUB-HIDDEN-CMD", "PW-SUB-OLD-CMD"]


def test_entry_fields_and_key_order() -> None:
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


def test_input_types_defaults_and_required() -> None:
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


def test_positional_order_flags_and_arrays() -> None:
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


def test_hidden_deprecated_and_callable_default() -> None:
    data = export.build_file(sample_app())
    hidden = _entry(data, "PW-SUB-HIDDEN-CMD")
    assert hidden["hidden"] is True
    assert hidden["surfaces"] == {"cli": {"path": ["sub", "hidden-cmd"]}}
    assert "default" not in hidden["input"]["properties"]["when"]
    assert _entry(data, "PW-SUB-OLD-CMD")["deprecated"] is True


def test_root_callback_options_are_not_entries() -> None:
    rendered = export.render(export.build_file(sample_app()))
    assert "Global repository." not in rendered


def test_render_format() -> None:
    text = export.render({"b": "é", "a": [1]})
    assert text == json.dumps({"b": "é", "a": [1]}, indent=2, ensure_ascii=False) + "\n"
    assert text.endswith("}\n")
    assert not text.endswith("\n\n")


def test_unsupported_type_is_an_error() -> None:
    app = typer.Typer()

    @app.command("one")
    def one(ratio: Annotated[float, typer.Option("--ratio")] = 1.0) -> None:
        """One."""

    @app.command("two")
    def two() -> None:
        """Two."""

    _ = (one, two)
    with pytest.raises(export.ExportError, match="one.*ratio"):
        export.build_file(app)


def _app_of(command: Callable[..., None]) -> typer.Typer:
    app = typer.Typer()
    app.command("one")(command)

    @app.command("two")
    def two() -> None:
        """Two."""

    _ = two
    return app


def _clamped(value: Annotated[int, typer.Option("--value", min=1, clamp=True)] = 2) -> None:
    """One."""


def _with_envvar(value: Annotated[str, typer.Option("--value", envvar="SOME_VAR")] = "x") -> None:
    """One."""


def test_clamped_range_is_an_error() -> None:
    for command in (_clamped,):
        with pytest.raises(export.ExportError, match="range"):
            export.build_file(_app_of(command))


def test_envvar_option_is_an_error() -> None:
    with pytest.raises(export.ExportError, match="envvar"):
        export.build_file(_app_of(_with_envvar))


def test_command_without_help_is_an_error() -> None:
    app = typer.Typer()

    @app.command("one")
    def one() -> None:
        pass

    @app.command("two")
    def two() -> None:
        """Two."""

    _ = (one, two)
    with pytest.raises(export.ExportError, match="help"):
        export.build_file(app)


def _colliding(
    x: Annotated[str, typer.Argument()],
    other: Annotated[str, typer.Option("--x")] = "",
) -> None:
    """One."""


def test_input_name_collision_is_an_error() -> None:
    with pytest.raises(export.ExportError, match="collides"):
        export.build_file(_app_of(_colliding))


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


def test_diff_identical_is_empty() -> None:
    same = _file([_e("PW-A", {"a": {"type": "string"}})])
    assert export.diff_generated(same, same) == []


def test_diff_names_added_changed_and_removed_properties() -> None:
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


def test_diff_names_added_and_removed_entries_in_id_order() -> None:
    before = _file([_e("PW-B", {}), _e("PW-C", {})])
    after = _file([_e("PW-A", {}), _e("PW-B", {})])
    assert export.diff_generated(before, after) == [
        "PW-A: entry: added",
        "PW-C: entry: removed",
    ]


def test_diff_compares_array_items_by_index() -> None:
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


def test_diff_distinguishes_true_from_one_and_shows_type_change() -> None:
    before = _file([_e("PW-A", {"a": {"type": "string", "default": 1}})])
    after = _file([_e("PW-A", {"a": {"type": "string", "default": [1]}})])
    assert export.diff_generated(before, after) == ["PW-A: input.properties.a.default: 1 -> [1]"]
    true_file = _file([_e("PW-A", {"a": {"default": True}})])
    one_file = _file([_e("PW-A", {"a": {"default": 1}})])
    assert export.diff_generated(true_file, one_file) == [
        "PW-A: input.properties.a.default: true -> 1"
    ]


def test_diff_reports_header_change() -> None:
    assert export.diff_generated(_file([]), _file([], prefix="PV")) == [
        'file: prefix: "PW" -> "PV"'
    ]


# --- --check / --write --------------------------------------------------------


def _write_generated(tmp_path: Path, app: typer.Typer) -> Path:
    path = tmp_path / "generated.json"
    path.write_text(export.render(export.build_file(app)), encoding="utf-8")
    return path


def test_check_passes_silently_when_equal(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = _write_generated(tmp_path, sample_app())
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
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = _write_generated(tmp_path, _app_without_extra_option())
    code = export.main(["--check"], app=_app_with_extra_option(), generated_path=path)
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    lines = captured.err.splitlines(keepends=True)
    assert lines[0] == f"error: {path} is stale\n"
    assert "  PW-ONE: input.properties.label: added\n" in lines
    assert lines[-1] == RUN_LINE


def test_check_reports_missing_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "generated.json"
    code = export.main(["--check"], app=sample_app(), generated_path=path)
    assert code == 1
    assert capsys.readouterr().err == f"error: {path}: file is missing\n{RUN_LINE}"


def test_check_reports_formatting_only_difference(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = _write_generated(tmp_path, sample_app())
    data = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps(data, indent=4, ensure_ascii=False) + "\n", encoding="utf-8")
    code = export.main(["--check"], app=sample_app(), generated_path=path)
    assert code == 1
    assert capsys.readouterr().err == (
        f"error: {path} is stale\n  generated.json: formatting differs\n{RUN_LINE}"
    )


def test_display_path_is_relative_to_repo_root() -> None:
    assert export.display_path(GENERATED) == "plugins/pecot-workflow/interface/generated.json"


def test_write_twice_reports_updated_then_unchanged(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "generated.json"
    assert export.main(["--write"], app=sample_app(), generated_path=path) == 0
    assert capsys.readouterr().err == f"updated: {path}\n"
    assert path.read_text(encoding="utf-8") == export.render(export.build_file(sample_app()))
    assert export.main(["--write"], app=sample_app(), generated_path=path) == 0
    assert capsys.readouterr().err == f"unchanged: {path}\n"


def test_exactly_one_mode_is_required(capsys: pytest.CaptureFixture[str]) -> None:
    for argv in ([], ["--check", "--write"]):
        with pytest.raises(SystemExit) as raised:
            export.main(argv, app=sample_app())
        assert raised.value.code == 2
    capsys.readouterr()


def test_unreadable_tree_exits_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    app = typer.Typer()

    @app.command("one")
    def one() -> None:
        pass

    @app.command("two")
    def two() -> None:
        """Two."""

    _ = (one, two)
    code = export.main(["--check"], app=app, generated_path=tmp_path / "g.json")
    assert code == 2
    assert capsys.readouterr().err.startswith("error: ")


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


def test_reexec_when_outside_venv(tmp_path: Path) -> None:
    venv = _venv(tmp_path)
    run = _Exec()
    environ: dict[str, str] = {}
    result = export.ensure_venv(
        ["--check"], prefix=str(tmp_path / "other"), venv_dir=venv, environ=environ, execv=run
    )
    assert result is None
    python = str(venv / "bin" / "python")
    assert run.calls == [(python, [python, str(SCRIPT), "--check"])]
    assert environ != {}


def test_no_reexec_inside_venv_or_on_second_launch(tmp_path: Path) -> None:
    venv = _venv(tmp_path)
    run = _Exec()
    assert (
        export.ensure_venv(["--check"], prefix=str(venv), venv_dir=venv, environ={}, execv=run)
        is None
    )
    first: dict[str, str] = {}
    export.ensure_venv(
        ["--check"], prefix=str(tmp_path / "other"), venv_dir=venv, environ=first, execv=run
    )
    run.calls.clear()
    assert (
        export.ensure_venv(
            ["--check"], prefix=str(tmp_path / "other"), venv_dir=venv, environ=first, execv=run
        )
        is None
    )
    assert run.calls == []


def test_missing_venv_exits_2_with_uv_sync_hint(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
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
    assert "uv sync" in capsys.readouterr().err


# --- 実物の app（T021） ---------------------------------------------------------


def test_real_app_matches_committed_generated_json(capsys: pytest.CaptureFixture[str]) -> None:
    assert export.main(["--check"]) == 0
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


def test_real_app_has_34_entries() -> None:
    data = json.loads(GENERATED.read_text(encoding="utf-8"))
    assert len(data["entries"]) == 34
