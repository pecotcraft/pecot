"""tests/cli/test_work_target.py - record_work_target (shared by issue, create-branch, and session restore)"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands._output import Output
from cli.commands._work_target import record_work_target

_OUT = Output(dry_run=False)


@add_test_properties(verifies=["PW-CREATE-BRANCH-11", "PW-SESSION-RESTORE-08"])
def test_success_prints_set_line_with_work_directory(capsys: pytest.CaptureFixture[str]) -> None:
    with (
        patch("cli.commands._work_target.write_work_target") as mock_write,
        patch("cli.commands._work_target.ensure_work_dir", return_value=Path("/x")),
    ):
        record_work_target(_OUT, "acme", "demo", 7, "title")

    captured = capsys.readouterr()
    mock_write.assert_called_once_with("acme/demo/7", "title")
    assert captured.out == ""
    assert captured.err == "set: work target acme/demo/7 (work directory .pecot/work/7/)\n"


@add_test_properties(verifies=["PW-CREATE-BRANCH-17"])
def test_failure_is_a_warning_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    with patch("cli.commands._work_target.write_work_target", side_effect=OSError("denied")):
        record_work_target(_OUT, "acme", "demo", 7, "title")

    assert capsys.readouterr().err == "warning: could not record the work target: denied\n"


@add_test_properties(verifies=["PW-SESSION-RESTORE-18", "PW-SESSION-RESTORE-19"])
def test_failure_exits_with_error_when_requested(capsys: pytest.CaptureFixture[str]) -> None:
    import typer

    with (
        patch("cli.commands._work_target.write_work_target", side_effect=OSError("denied")),
        pytest.raises(typer.Exit) as exc_info,
    ):
        record_work_target(_OUT, "acme", "demo", 7, "title", fail_with_exit=True)

    assert exc_info.value.exit_code == 1
    assert capsys.readouterr().err == "error: could not record the work target: denied\n"
