"""tests/cli/test_output.py - cli/commands/_output.py のユニットテスト

Node 側と共有する期待の行 (``cli-node/tests/output/cases.json``) を 1 要素 1 ケースで確かめる。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest

from cli.commands._output import (
    Operation,
    Output,
    OutputLogHandler,
    Verb,
    install_log_handler,
)

CASES_PATH = Path(__file__).resolve().parents[3] / "cli-node/tests/output/cases.json"
CASES: list[dict[str, Any]] = json.loads(CASES_PATH.read_text(encoding="utf-8"))


def _case_id(case: dict[str, Any]) -> str:
    inp = case["input"]
    detail = "-".join(str(v) for v in inp.values()).replace("\n", "\\n")
    mode = "dry" if case["dryRun"] else "real"
    return f"{case['kind']}-{mode}-{detail}"


def _call(out: Output, case: dict[str, Any]) -> None:
    kind, inp = case["kind"], case["input"]
    if kind == "plan":
        out.planned(Operation(Verb(inp["verb"]), inp["target"]))
    elif kind == "result":
        out.done(Operation(Verb(inp["verb"]), inp["target"]))
    elif kind == "error":
        out.error(inp["message"])
    elif kind == "warning":
        out.warning(inp["message"])
    elif kind == "count":
        out.count(inp["label"], inp["value"])
    elif kind == "data":
        out.data(inp["text"])
    else:  # pragma: no cover
        raise AssertionError(f"未知の kind: {kind}")


def test_case_count_matches_cases_json() -> None:
    assert len(CASES) == 63


@pytest.mark.parametrize("case", CASES, ids=[_case_id(c) for c in CASES])
def test_output_line(case: dict[str, Any], capsys: pytest.CaptureFixture[str]) -> None:
    _call(Output(dry_run=case["dryRun"]), case)
    captured = capsys.readouterr()
    expected = {"stdout": "", "stderr": ""}
    if case["stream"] is not None:
        expected[case["stream"]] = case["line"]
    assert (captured.out, captured.err) == (expected["stdout"], expected["stderr"])


def test_verb_values_are_names() -> None:
    assert [v.value for v in Verb] == [
        "create", "update", "delete", "add", "remove", "close", "reopen",
        "merge", "move", "set", "skip", "unchanged",
    ]  # fmt: skip


@pytest.fixture
def handler_logger() -> logging.Logger:
    """Logger with the handler attached; handlers are restored afterwards."""
    logger = logging.getLogger("cli")
    saved = list(logger.handlers)
    logger.handlers = [h for h in saved if not isinstance(h, OutputLogHandler)]
    yield logger  # type: ignore[misc]
    logger.handlers = saved


def test_log_handler_prints_warning_and_error_lines(
    handler_logger: logging.Logger, capsys: pytest.CaptureFixture[str]
) -> None:
    install_log_handler()
    child = logging.getLogger("cli.core.sample")
    child.warning("first\nsecond")
    child.error("broken")
    child.info("hidden")
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "warning: first\n  second\nerror: broken\n"


def test_install_log_handler_twice_attaches_once(
    handler_logger: logging.Logger, capsys: pytest.CaptureFixture[str]
) -> None:
    install_log_handler()
    install_log_handler()
    assert sum(isinstance(h, OutputLogHandler) for h in handler_logger.handlers) == 1
    logging.getLogger("cli.core.sample").warning("once")
    assert capsys.readouterr().err == "warning: once\n"
