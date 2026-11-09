"""tests/cli/test_security.py - pecot security sync（Tracker の一覧の書き直し）のテスト

GitHubClient（I/O 境界）を差し替え、ボード設定は MagicMock にする。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import typer.testing

from cli.commands.main import app
from cli.core.dependabot import DependabotException
from cli.core.github import GitHubAPIError, GitHubNotFoundError
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
    exceptions: list[DependabotException] | None = None,
) -> Any:
    with (
        patch("cli.commands.security.GitHubClient", return_value=client),
        patch("cli.commands.release.load_active_config", return_value=config or _config()),
        patch("cli.commands.security.git_toplevel", return_value=Path("/repo")),
        patch("cli.commands.security.load_dependabot_exceptions", return_value=exceptions),
        patch("cli.commands.release.origin_repo", return_value=("github.com", "o", "r")),
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


def _exc(alert: int) -> DependabotException:
    return DependabotException(alert=alert, package="pkg", reason="理由", reevaluate="v2 が出たら")


def _body(*entries: TrackerEntry) -> str:
    return render_tracker_body(list(entries), "github.com", "o", "r")


def _row(kind: str, number: int, **kw: Any) -> TrackerEntry:
    return TrackerEntry(kind=kind, number=number, **kw)  # type: ignore[arg-type]


def _tracker(number: int, body: str, state: str = "open") -> dict[str, Any]:
    return {"number": number, "state": state, "body": body}


class TestSync:
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

    def test_exceptions_only_creates_nothing(self) -> None:
        client = _client(dependabot=[_dep(1)])
        result = _invoke(client, ["sync"], exceptions=[_exc(1)])

        assert result.exit_code == 0, result.output
        client.create_issue.assert_not_called()
        client.update_issue_body.assert_not_called()

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

    def test_exceptions_are_left_out_of_a_new_tracker(self) -> None:
        client = _client(code_scanning=[_cs(10)], dependabot=[_dep(1)])
        result = _invoke(client, ["sync"], exceptions=[_exc(1)])

        assert result.exit_code == 0, result.output
        body = client.create_issue.call_args.kwargs["body"]
        assert "pecot-alert: dependabot/" not in body
        assert "pecot-alert: code-scanning/10" in body

    def test_no_alerts_no_tracker(self) -> None:
        client = _client()
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        client.create_issue.assert_not_called()

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
        assert "Tracker #5 に足す: dependabot #2" in result.output

    def test_same_body_is_not_patched(self) -> None:
        entry = _row("dependabot", 1, priority="medium", package="pkg", ghsa="GHSA-aaaa-bbbb-cccc")
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, _body(entry))])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()
        assert "Tracker #5 は変わらない" in result.output

    def test_crlf_body_counts_as_the_same(self) -> None:
        entry = _row("dependabot", 1, priority="medium", package="pkg", ghsa="GHSA-aaaa-bbbb-cccc")
        body = _body(entry).replace("\n", "\r\n")
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, body)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()

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
        assert "Tracker #5 から外す: code-scanning #9" in result.output
        client.close_issue.assert_not_called()

    def test_exception_row_leaves_the_table(self) -> None:
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, _body(_row("dependabot", 1)))])
        result = _invoke(client, ["sync"], exceptions=[_exc(1)])

        assert result.exit_code == 0, result.output
        assert "pecot-alert: dependabot/1" not in client.update_issue_body.call_args.args[3]
        assert "Tracker #5 から外す: dependabot #1" in result.output

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
        assert "Tracker #5 の本文を書き直す" in result.output
        assert "から外す" not in result.output
        assert "に足す" not in result.output

    def test_patch_422_is_a_failure(self) -> None:
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, _body())])
        client.update_issue_body.side_effect = GitHubAPIError("too long", status_code=422)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert "本文を書き直せません" in result.stderr

    def test_broken_markers_exit_1_without_writing(self) -> None:
        broken = _body().replace("<!-- pecot-alert: list-end -->", "")
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, broken)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.update_issue_body.assert_not_called()
        client.create_issue.assert_not_called()

    def test_multiple_trackers_use_the_smallest_and_warn(self) -> None:
        client = _client(dependabot=[_dep(1)], issues=[_tracker(9, _body()), _tracker(5, _body())])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        assert client.update_issue_body.call_args.args[2] == 5
        assert "#9" in result.stderr
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

    def test_existing_tracker_with_status_and_priority_is_not_reset(self) -> None:
        client = self._existing_board({"F_workflow", "F_priority"})

        client.update_project_item_field.assert_not_called()

    def test_existing_tracker_with_empty_fields_gets_backlog_and_priority(self) -> None:
        client = self._existing_board(set())

        updates = [c.args for c in client.update_project_item_field.call_args_list]
        assert ("PVT_1", "ITEM", "F_workflow", "O_workflow_backlog") in updates
        assert ("PVT_1", "ITEM", "F_priority", "O_priority_medium") in updates

    def test_failed_kind_is_untouched_and_exits_1(self) -> None:
        entry = _row("secret-scanning", 1)
        client = _client(
            secret_scanning=GitHubAPIError("boom", status_code=500),
            dependabot=[_dep(1)],
            issues=[_tracker(5, _body(entry))],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert "secret scanning の一覧を取得できません" in result.stderr
        body = client.update_issue_body.call_args.args[3]
        assert "pecot-alert: secret-scanning/1 priority=" in body
        assert "pecot-alert: dependabot/1" in body

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

    def test_failed_kind_does_not_create_a_tracker(self) -> None:
        client = _client(dependabot=GitHubAPIError("boom", status_code=500))
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.create_issue.assert_not_called()

    def test_disabled_kind_is_a_heading_only_with_exit_0(self) -> None:
        client = _client(
            secret_scanning=GitHubNotFoundError("nf", status_code=404, response_body="{}"),
            dependabot=[_dep(1)],
            issues=[_tracker(5, _body(_row("secret-scanning", 1)))],
        )
        client.get_secret_scanning_status.return_value = "disabled"
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        assert "secret scanning: 無効のため飛ばします" in result.output
        body = client.update_issue_body.call_args.args[3]
        assert "## secret scanning\n\ndisabled" in body
        assert "pecot-alert: secret-scanning/" not in body

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

    def test_secret_scanning_404_without_disabled_status_fails(self) -> None:
        """権限不足の 404 を無効とみなさない。触れずに exit 1"""
        client = _client(
            secret_scanning=GitHubNotFoundError("nf", status_code=404, response_body="{}"),
            issues=[_tracker(5, _body(_row("secret-scanning", 1)))],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1

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
        assert "code scanning: 無効のため飛ばします" in result.output

    def test_dependabot_forbidden_while_enabled_fails(self) -> None:
        client = _client(dependabot=GitHubAPIError("denied", status_code=403, response_body="{}"))
        assert _invoke(client, ["sync"]).exit_code == 1

    def test_issue_list_failure_exits_1(self) -> None:
        client = _client()
        client.list_issues_by_label.side_effect = GitHubAPIError("x", status_code=500)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.create_issue.assert_not_called()


class TestDryRun:
    def test_new_tracker_line_and_no_writes(self) -> None:
        client = _client(dependabot=[_dep(1, "high")], code_scanning=[_cs(10)])
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        assert re.search(
            r"\[dry-run\] Tracker を立てる: \[Tracker\] security alert — \d{4}-\d\d-\d\d"
            r"（2 件・Priority: high）",
            result.output,
        )
        assert "[dry-run] Tracker に載せる: dependabot #1" in result.output
        client.create_issue.assert_not_called()
        client.update_issue_body.assert_not_called()
        client.add_to_project.assert_not_called()
        client.update_project_item_field.assert_not_called()

    def test_existing_tracker_lines(self) -> None:
        client = _client(
            dependabot=[_dep(2), _dep(3)],
            issues=[_tracker(5, _body(_row("dependabot", 2), _row("code-scanning", 9)))],
        )
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        assert "[dry-run] Tracker #5 に足す: dependabot #3" in result.output
        assert "[dry-run] Tracker #5 から外す: code-scanning #9" in result.output
        assert "行を変える" not in result.output
        client.update_issue_body.assert_not_called()

    def test_unchanged_line(self) -> None:
        entry = _row("dependabot", 1, priority="medium", package="pkg", ghsa="GHSA-aaaa-bbbb-cccc")
        client = _client(dependabot=[_dep(1)], issues=[_tracker(5, _body(entry))])
        result = _invoke(client, ["sync", "--dry-run"])

        assert "[dry-run] Tracker #5 は変わらない" in result.output


class TestCommands:
    def test_review_exceptions_is_gone(self) -> None:
        result = runner.invoke(app, ["security", "review-exceptions"])

        assert result.exit_code != 0

    def test_help_lists_only_sync(self) -> None:
        result = runner.invoke(app, ["security", "--help"])

        assert "sync" in result.output
        assert "review-exceptions" not in result.output
