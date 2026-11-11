"""tests/cli/test_security.py - pecot security sync（Tracker の一覧の書き直し）のテスト

GitHubClient（I/O 境界）を差し替え、ボード設定は MagicMock にする。
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import typer.testing
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands.main import app
from cli.core.github import GitHubAPIError, GitHubAuthError, GitHubNotFoundError
from cli.core.security_alerts import TrackerEntry, render_tracker_body

runner = typer.testing.CliRunner()


def _config() -> MagicMock:
    config = MagicMock()
    config.host = "github.com"
    config.project.id = "PVT_1"
    return config


def _client(
    *,
    dependabot: list[dict[str, Any]] | Exception | None = None,
    code_scanning: list[dict[str, Any]] | Exception | None = None,
    secret_scanning: list[dict[str, Any]] | Exception | None = None,
    issues: list[dict[str, Any]] | None = None,
) -> MagicMock:
    client = MagicMock()
    for attr, value in (
        ("list_open_dependabot_alerts", dependabot),
        ("list_open_code_scanning_alerts", code_scanning),
        ("list_open_secret_scanning_alerts", secret_scanning),
    ):
        fn = getattr(client, attr)
        if isinstance(value, Exception):
            fn.side_effect = value
        else:
            fn.return_value = value or []
    client.list_issues_by_label.return_value = issues or []
    client.create_issue.return_value = {"number": 100, "html_url": "https://x/100"}
    client.get_item_set_field_ids.return_value = set()
    client.get_secret_scanning_status.return_value = None
    client.is_dependabot_alerts_enabled.return_value = True
    client.get_issue_node_id.return_value = "I_node"
    client.add_to_project.return_value = "ITEM"
    return client


def _invoke(
    client: MagicMock,
    args: list[str],
    config: MagicMock | None = None,
) -> Any:
    with (
        patch("cli.commands._tracker_sync.GitHubClient", return_value=client),
        patch("cli.commands._tracker_sync.load_active_config", return_value=config or _config()),
        patch("cli.commands.release.primary_remote_repo", return_value=("github.com", "o", "r")),
    ):
        return runner.invoke(app, ["security", *args])


def _dep(number: int, severity: str = "medium") -> dict[str, Any]:
    return {
        "number": number,
        "html_url": f"https://github.com/o/r/security/dependabot/{number}",
        "security_vulnerability": {"severity": severity},
        "security_advisory": {"ghsa_id": "GHSA-aaaa-bbbb-cccc"},
        "dependency": {"package": {"name": "pkg"}},
    }


def _cs(number: int) -> dict[str, Any]:
    return {"number": number, "rule": {"id": "js/xss", "severity": "error"}}


def _body(*entries: TrackerEntry) -> str:
    return render_tracker_body(list(entries), "github.com", "o", "r")


def _row(kind: str, number: int, **kw: Any) -> TrackerEntry:
    return TrackerEntry(kind=kind, number=number, **kw)  # type: ignore[arg-type]


def _tracker(number: int, body: str, state: str = "open") -> dict[str, Any]:
    return {"number": number, "state": state, "body": body}


class TestSync:
    @add_test_properties(
        verifies=[
            "PW-SECURITY-SYNC-01",
            "PW-SECURITY-SYNC-02",
            "PW-SECURITY-SYNC-03",
            "PW-SECURITY-SYNC-04",
        ]
    )
    def test_creates_one_tracker_and_puts_it_on_backlog(self) -> None:
        config = _config()
        config.get_field_id.side_effect = lambda name: f"F_{name}"
        config.get_option_id.side_effect = lambda field, option: f"O_{field}_{option}"
        client = _client(dependabot=[_dep(1, "low"), _dep(2, "high")], code_scanning=[_cs(10)])
        result = _invoke(client, ["sync"], config)

        assert result.exit_code == 0, result.output
        client.create_issue.assert_called_once()
        args = client.create_issue.call_args.kwargs
        assert re.fullmatch(r"\[Tracker\] security alert — \d{4}-\d\d-\d\d", args["title"])
        assert args["labels"] == ["security-alert"]
        assert args["body"].startswith("<!-- pecot-alert: tracker -->")
        assert args["body"].count("pecot-alert: dependabot/") == 2
        assert "js/xss" not in args["body"]
        client.update_issue_body.assert_not_called()
        updates = [c.args for c in client.update_project_item_field.call_args_list]
        assert ("PVT_1", "ITEM", "F_workflow", "O_workflow_backlog") in updates
        assert ("PVT_1", "ITEM", "F_priority", "O_priority_high") in updates
        lines = result.stderr.splitlines()
        assert lines[0].startswith('created: Tracker "[Tracker] security alert')
        assert lines[0].endswith('" with priority high')
        assert lines[1:] == [
            "added: dependabot #1 to new Tracker",
            "added: dependabot #2 to new Tracker",
            "added: code-scanning #10 to new Tracker",
        ]

    def test_dependabot_exceptions_file_does_not_hide_alerts(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 廃止した例外ファイルが残っていても、open の alert は Tracker に載る
        subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
        exceptions = tmp_path / ".github" / "dependabot-exceptions.json"
        exceptions.parent.mkdir()
        exceptions.write_text(json.dumps({"exceptions": [{"number": 1}]}), encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        client = _client(dependabot=[_dep(1), _dep(2)])

        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        body = client.create_issue.call_args.kwargs["body"]
        assert "pecot-alert: dependabot/1 " in body
        assert "pecot-alert: dependabot/2 " in body
        assert "例外" not in body

    @add_test_properties(verifies=["PW-SECURITY-SYNC-05"])
    def test_no_open_alerts_creates_nothing(self) -> None:
        client = _client()
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        assert result.stdout == ""
        assert result.stderr == "dry-run: would skip Tracker creation\n"
        client.create_issue.assert_not_called()

    def test_new_tracker_body_is_marker_and_table_only(self) -> None:
        client = _client(dependabot=[_dep(1)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        body = client.create_issue.call_args.kwargs["body"]
        assert body.startswith(
            "<!-- pecot-alert: tracker -->\n\n<!-- pecot-alert: list-begin -->\n"
        )
        assert "## Dependabot\n\n| title | alert | Priority |" in body
        assert "## code scanning\n\nnone" in body
        assert "state=" not in body
        assert "SECURITY.md" not in body

    @add_test_properties(verifies=["PW-SECURITY-SYNC-05", "PW-SECURITY-SYNC-06"])
    def test_no_alerts_no_tracker(self) -> None:
        client = _client()
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        assert result.stdout == ""
        assert result.stderr == "skipped: Tracker creation\n"
        client.create_issue.assert_not_called()

    @add_test_properties(verifies=["PW-SECURITY-SYNC-07", "PW-SECURITY-SYNC-08"])
    def test_existing_tracker_is_patched_without_new_issue(self) -> None:
        client = _client(
            dependabot=[_dep(1), _dep(2)],
            issues=[_tracker(5, _body(_row("dependabot", 1, priority="medium", package="pkg")))],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.create_issue.assert_not_called()
        client.update_issue_body.assert_called_once()
        args = client.update_issue_body.call_args.args
        assert args[:3] == ("o", "r", 5)
        assert "pecot-alert: dependabot/2" in args[3]
        assert result.stdout == ""
        assert result.stderr == "added: dependabot #2 to Tracker #5\n"

    @add_test_properties(verifies=["PW-SECURITY-SYNC-12", "PW-SECURITY-SYNC-13"])
    def test_same_body_is_not_patched(self) -> None:
        entry = _row("dependabot", 1, priority="medium", package="pkg", ghsa="GHSA-aaaa-bbbb-cccc")
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, _body(entry))])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()
        assert result.stdout == ""
        assert result.stderr == "unchanged: Tracker #5\n"

    @add_test_properties(verifies=["PW-SECURITY-SYNC-12"])
    def test_crlf_body_counts_as_the_same(self) -> None:
        entry = _row("dependabot", 1, priority="medium", package="pkg", ghsa="GHSA-aaaa-bbbb-cccc")
        body = _body(entry).replace("\n", "\r\n")
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, body)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()

    @add_test_properties(verifies=["PW-SECURITY-SYNC-09"])
    def test_row_leaving_the_list_is_removed(self) -> None:
        client = _client(
            dependabot=[_dep(1)],
            issues=[_tracker(5, _body(_row("dependabot", 1), _row("code-scanning", 9)))],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        body = client.update_issue_body.call_args.args[3]
        assert "pecot-alert: code-scanning/9" not in body
        assert "pecot-alert: dependabot/1" in body
        assert result.stderr == "removed: code-scanning #9 from Tracker #5\n"
        client.close_issue.assert_not_called()

    def test_old_format_body_is_rewritten_in_place(self) -> None:
        old_row = (
            "| <!-- pecot-alert: dependabot/1 state=open priority=medium pkg=pkg"
            " ghsa=GHSA-aaaa-bbbb-cccc --> Dependabot | [#1](u) | medium | pkg | 要判断 |"
        )
        old_exception = (
            "| <!-- pecot-alert: dependabot/2 state=exception priority=low --> x | | | | 例外 |"
        )
        body = _body().replace(
            "<!-- pecot-alert: list-end -->",
            f"{old_row}\n{old_exception}\n<!-- pecot-alert: list-end -->",
        )
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, body)])
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        assert result.stderr == "dry-run: would update Tracker #5 body\n"

    @add_test_properties(verifies=["PW-SECURITY-SYNC-10", "PW-SECURITY-SYNC-11"])
    def test_body_only_change_prints_one_result_line(self) -> None:
        old_row = (
            "| <!-- pecot-alert: dependabot/1 state=open priority=medium pkg=pkg"
            " ghsa=GHSA-aaaa-bbbb-cccc --> Dependabot | [#1](u) | medium | pkg | 要判断 |"
        )
        body = _body().replace(
            "<!-- pecot-alert: list-end -->", f"{old_row}\n<!-- pecot-alert: list-end -->"
        )
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, body)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        assert result.stdout == ""
        assert result.stderr == "updated: Tracker #5 body\n"

    @add_test_properties(verifies=["PW-SECURITY-SYNC-41", "PW-SECURITY-SYNC-42"])
    def test_patch_422_is_a_failure(self) -> None:
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, _body())])
        client.update_issue_body.side_effect = GitHubAPIError("too long", status_code=422)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert result.stderr.startswith("error: could not update Tracker #5 body:")
        assert "updated:" not in result.stderr

    @add_test_properties(verifies=["PW-SECURITY-SYNC-39", "PW-SECURITY-SYNC-40"])
    def test_broken_markers_exit_1_without_writing(self) -> None:
        broken = _body().replace("<!-- pecot-alert: list-end -->", "")
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, broken)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.update_issue_body.assert_not_called()
        client.create_issue.assert_not_called()

    @add_test_properties(
        verifies=["PW-SECURITY-SYNC-21", "PW-SECURITY-SYNC-22", "PW-SECURITY-SYNC-23"]
    )
    def test_multiple_trackers_use_the_smallest_and_warn(self) -> None:
        client = _client(dependabot=[_dep(1)], issues=[_tracker(9, _body()), _tracker(5, _body())])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        assert client.update_issue_body.call_args.args[2] == 5
        assert (
            "warning: multiple open Trackers; using #5 (lowest number) and leaving #9 open\n"
            in result.stderr
        )
        client.close_issue.assert_not_called()

    def test_closed_tracker_is_not_reused(self) -> None:
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, _body(), "closed")])
        _invoke(client, ["sync"])

        client.create_issue.assert_called_once()
        client.update_issue_body.assert_not_called()

    def _existing_board(self, set_field_ids: set[str]) -> MagicMock:
        config = _config()
        config.get_field_id.side_effect = lambda name: f"F_{name}"
        config.get_option_id.side_effect = lambda field, option: f"O_{field}_{option}"
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, _body())])
        client.get_item_set_field_ids.return_value = set_field_ids
        _invoke(client, ["sync"], config)
        return client

    @add_test_properties(verifies=["PW-SECURITY-SYNC-20"])
    def test_existing_tracker_with_status_and_priority_is_not_reset(self) -> None:
        client = self._existing_board({"F_workflow", "F_priority"})

        client.update_project_item_field.assert_not_called()

    @add_test_properties(verifies=["PW-SECURITY-SYNC-20"])
    def test_existing_tracker_with_empty_fields_gets_backlog_and_priority(self) -> None:
        client = self._existing_board(set())

        updates = [c.args for c in client.update_project_item_field.call_args_list]
        assert ("PVT_1", "ITEM", "F_workflow", "O_workflow_backlog") in updates
        assert ("PVT_1", "ITEM", "F_priority", "O_priority_medium") in updates

    @add_test_properties(
        verifies=[
            "PW-SECURITY-SYNC-30",
            "PW-SECURITY-SYNC-32",
            "PW-SECURITY-SYNC-33",
            "PW-SECURITY-SYNC-34",
        ]
    )
    def test_failed_kind_is_untouched_and_exits_1(self) -> None:
        entry = _row("secret-scanning", 1)
        client = _client(
            secret_scanning=GitHubAPIError("boom", status_code=500),
            dependabot=[_dep(1)],
            issues=[_tracker(5, _body(entry))],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert "error: could not list secret scanning alerts" in result.stderr
        body = client.update_issue_body.call_args.args[3]
        assert "pecot-alert: secret-scanning/1 priority=" in body
        assert "pecot-alert: dependabot/1" in body

    @add_test_properties(verifies=["PW-SECURITY-SYNC-31"])
    def test_failed_kind_without_previous_rows_is_unavailable(self) -> None:
        client = _client(
            code_scanning=GitHubAPIError("boom", status_code=500),
            dependabot=[_dep(1)],
            issues=[_tracker(5, _body())],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        body = client.update_issue_body.call_args.args[3]
        assert "## code scanning\n\nunavailable" in body

    @add_test_properties(verifies=["PW-SECURITY-SYNC-34"])
    def test_failed_kind_does_not_create_a_tracker(self) -> None:
        client = _client(dependabot=GitHubAPIError("boom", status_code=500))
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.create_issue.assert_not_called()

    @add_test_properties(verifies=["PW-SECURITY-SYNC-17", "PW-SECURITY-SYNC-18"])
    def test_disabled_kind_is_a_heading_only_with_exit_0(self) -> None:
        client = _client(
            secret_scanning=GitHubNotFoundError("nf", status_code=404, response_body="{}"),
            dependabot=[_dep(1)],
            issues=[_tracker(5, _body(_row("secret-scanning", 1)))],
        )
        client.get_secret_scanning_status.return_value = "disabled"
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        assert "skipped: secret scanning alerts (feature disabled)\n" in result.stderr
        body = client.update_issue_body.call_args.args[3]
        assert "## secret scanning\n\ndisabled" in body
        assert "pecot-alert: secret-scanning/" not in body

    @add_test_properties(verifies=["PW-SECURITY-SYNC-30"])
    def test_failed_kind_keeps_its_previous_rows(self) -> None:
        entry = _row("secret-scanning", 1)
        client = _client(
            secret_scanning=GitHubAPIError("boom", status_code=500),
            dependabot=[_dep(1)],
            issues=[_tracker(5, _body(entry))],
        )
        _invoke(client, ["sync"])

        body = client.update_issue_body.call_args.args[3]
        assert "## secret scanning\n\n| title" in body
        assert "pecot-alert: secret-scanning/1 priority=" in body

    @add_test_properties(verifies=["PW-SECURITY-SYNC-36"])
    def test_secret_scanning_404_without_disabled_status_fails(self) -> None:
        """権限不足の 404 を無効とみなさない。触れずに exit 1"""
        client = _client(
            secret_scanning=GitHubNotFoundError("nf", status_code=404, response_body="{}"),
            issues=[_tracker(5, _body(_row("secret-scanning", 1)))],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1

    @add_test_properties(verifies=["PW-SECURITY-SYNC-19"])
    def test_code_scanning_no_analysis_404_is_zero_alerts(self) -> None:
        client = _client(
            code_scanning=GitHubNotFoundError(
                "nf", status_code=404, response_body='{"message": "no analysis found"}'
            ),
            issues=[_tracker(5, _body(_row("code-scanning", 9)))],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        assert "pecot-alert: code-scanning/9" not in client.update_issue_body.call_args.args[3]

    @add_test_properties(verifies=["PW-SECURITY-SYNC-18"])
    def test_code_scanning_without_ghas_403_is_disabled(self) -> None:
        client = _client(
            code_scanning=GitHubAPIError(
                "denied",
                status_code=403,
                response_body='{"message": "Advanced Security must be enabled for this repository"}',
            ),
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        assert "skipped: code scanning alerts (feature disabled)\n" in result.stderr

    @add_test_properties(verifies=["PW-SECURITY-SYNC-35"])
    def test_dependabot_forbidden_while_enabled_fails(self) -> None:
        client = _client(dependabot=GitHubAPIError("denied", status_code=403, response_body="{}"))
        assert _invoke(client, ["sync"]).exit_code == 1

    @add_test_properties(verifies=["PW-SECURITY-SYNC-37", "PW-SECURITY-SYNC-38"])
    def test_issue_list_failure_exits_1(self) -> None:
        client = _client()
        client.list_issues_by_label.side_effect = GitHubAPIError("x", status_code=500)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.create_issue.assert_not_called()

    @add_test_properties(verifies=["PW-SECURITY-SYNC-15"])
    def test_all_alerts_gone_rewrites_to_none_and_does_not_close(self) -> None:
        old = _body(_row("dependabot", 1, priority="medium", package="pkg"))
        client = _client(issues=[_tracker(5, old)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        body = client.update_issue_body.call_args.args[3]
        assert "## Dependabot\n\nnone" in body
        assert "## code scanning\n\nnone" in body
        assert "pecot-alert: dependabot/1" not in body
        client.close_issue.assert_not_called()

    @add_test_properties(verifies=["PW-SECURITY-SYNC-26"])
    def test_no_active_project_exits_1(self) -> None:
        client = _client(dependabot=[_dep(1)])
        with (
            patch("cli.commands._tracker_sync.GitHubClient", return_value=client),
            patch("cli.commands._tracker_sync.load_active_config", return_value=None),
            patch(
                "cli.commands.release.primary_remote_repo", return_value=("github.com", "o", "r")
            ),
        ):
            result = runner.invoke(app, ["security", "sync"])

        assert result.exit_code == 1
        assert "error: no active project\n" in result.stderr
        client.create_issue.assert_not_called()

    @add_test_properties(verifies=["PW-SECURITY-SYNC-27"])
    def test_unreadable_git_remote_exits_1(self) -> None:
        client = _client(dependabot=[_dep(1)])
        with (
            patch("cli.commands._tracker_sync.GitHubClient", return_value=client),
            patch("cli.commands._tracker_sync.load_active_config", return_value=_config()),
            patch("cli.commands.release.primary_remote_repo", return_value=None),
        ):
            result = runner.invoke(app, ["security", "sync"])

        assert result.exit_code == 1
        assert "error: could not read the repository from the git remote\n" in result.stderr
        client.create_issue.assert_not_called()

    @add_test_properties(verifies=["PW-SECURITY-SYNC-43", "PW-SECURITY-SYNC-44"])
    def test_tracker_creation_failure_prints_a_tracker_error_and_exits_1(self) -> None:
        client = _client(dependabot=[_dep(1)])
        client.create_issue.side_effect = GitHubAPIError("boom", status_code=502)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert "error: Tracker: boom\n" in result.stderr

    @add_test_properties(verifies=["PW-SECURITY-SYNC-43", "PW-SECURITY-SYNC-44"])
    def test_board_registration_failure_prints_a_tracker_error_and_exits_1(self) -> None:
        client = _client(dependabot=[_dep(1)])
        client.add_to_project.side_effect = GitHubAPIError("boom", status_code=502)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert "error: Tracker: boom\n" in result.stderr


class TestDryRun:
    @add_test_properties(verifies=["PW-SECURITY-SYNC-24", "PW-SECURITY-SYNC-25"])
    def test_new_tracker_line_and_no_writes(self) -> None:
        client = _client(dependabot=[_dep(1, "high")], code_scanning=[_cs(10)])
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        assert result.stdout == ""
        assert re.search(
            r'dry-run: would create Tracker "\[Tracker\] security alert — \d{4}-\d\d-\d\d"'
            r" with priority high\n",
            result.stderr,
        )
        assert "dry-run: would add dependabot #1 to new Tracker\n" in result.stderr
        client.create_issue.assert_not_called()
        client.update_issue_body.assert_not_called()
        client.add_to_project.assert_not_called()
        client.update_project_item_field.assert_not_called()

    @add_test_properties(verifies=["PW-SECURITY-SYNC-25"])
    def test_existing_tracker_lines(self) -> None:
        client = _client(
            dependabot=[_dep(2), _dep(3)],
            issues=[_tracker(5, _body(_row("dependabot", 2), _row("code-scanning", 9)))],
        )
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        assert result.stderr == (
            "dry-run: would add dependabot #3 to Tracker #5\n"
            "dry-run: would remove code-scanning #9 from Tracker #5\n"
        )
        client.update_issue_body.assert_not_called()

    def test_unchanged_line(self) -> None:
        entry = _row("dependabot", 1, priority="medium", package="pkg", ghsa="GHSA-aaaa-bbbb-cccc")
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, _body(entry))])
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.stderr == "dry-run: would leave Tracker #5 unchanged\n"


class TestCommands:
    def test_review_exceptions_is_gone(self) -> None:
        result = runner.invoke(app, ["security", "review-exceptions"])

        assert result.exit_code != 0

    def test_help_lists_only_sync(self) -> None:
        result = runner.invoke(app, ["security", "--help"])

        assert "sync" in result.output
        assert "review-exceptions" not in result.output


def _invoke_real_client(args: list[str]) -> Any:
    with (
        patch("cli.commands._tracker_sync.load_active_config", return_value=_config()),
        patch("cli.commands.release.primary_remote_repo", return_value=("github.com", "o", "r")),
    ):
        return runner.invoke(app, ["security", *args])


@add_test_properties(verifies=["PW-SECURITY-SYNC-28", "PW-SECURITY-SYNC-29"])
def test_sync_without_token_is_an_error_line() -> None:
    with patch(
        "cli.core.github.client.GitHubClientBase._get_token",
        side_effect=GitHubAuthError("could not get a GitHub API token"),
    ):
        result = _invoke_real_client(["sync", "--dry-run"])

    assert result.exit_code == 1
    assert "Traceback" not in result.output
    assert "error: could not get a GitHub API token\n" in result.stderr
