"""tests/cli/test_dependabot.py - pecot dependabot sync（Tracker の一覧の書き直し）のテスト

GitHubClient（I/O 境界）を差し替え、ボード設定は MagicMock にする。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import MagicMock, patch

import typer.testing
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands.main import app
from cli.core.dependabot_prs import LIST_BEGIN, LIST_END, PrEntry, render_tracker_body
from cli.core.github import GitHubAPIError, GitHubAuthError
from cli.tests._dependabot_tracker_body import OLD_FORM_BODY

runner = typer.testing.CliRunner()


def _config() -> MagicMock:
    config = MagicMock()
    config.host = "github.com"
    config.project.id = "PVT_1"
    config.get_field_id.side_effect = lambda name: f"F_{name}"
    config.get_option_id.side_effect = lambda field, option: f"O_{field}_{option}"
    return config


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) - delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def _pr(number: int, name: str, kind: str, **kw: Any) -> dict[str, Any]:
    message = (
        f'Bump {name}\n\n---\nupdated-dependencies:\n- dependency-name: "{name}"\n'
        f"  update-type: version-update:semver-{kind}\n...\n"
    )
    pr: dict[str, Any] = {
        "number": number,
        "title": f"Bump {name}",
        "url": f"https://github.com/o/r/pull/{number}",
        "createdAt": _iso(timedelta(hours=3)),
        "author": {"__typename": "Bot", "login": "dependabot"},
        "isInMergeQueue": False,
        "autoMergeRequest": {"enabledAt": _iso(timedelta(hours=3))},
        "mergeable": "MERGEABLE",
        "baseRef": {"target": {"committedDate": _iso(timedelta(days=2))}},
        "firstCommits": {
            "nodes": [
                {
                    "commit": {
                        "message": message,
                        "signature": {"isValid": True},
                        "author": {"user": {"login": "dependabot[bot]"}},
                    }
                }
            ]
        },
        "headCommits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]},
        "lastForcePush": {"nodes": []},
        "lastDequeue": {"nodes": []},
    }
    pr.update(kw)
    return pr


def _client(
    prs: list[dict[str, Any]] | Exception, issues: list[dict[str, Any]] | None = None
) -> MagicMock:
    client = MagicMock()
    if isinstance(prs, Exception):
        client.list_open_dependabot_pull_requests.side_effect = prs
    else:
        client.list_open_dependabot_pull_requests.return_value = prs
    client.list_issues_by_label.return_value = issues or []
    client.create_issue.return_value = {"number": 100, "html_url": "https://x/100"}
    client.get_item_set_field_ids.return_value = set()
    client.get_issue_node_id.return_value = "I_node"
    client.add_to_project.return_value = "ITEM"
    return client


def _invoke(client: MagicMock, args: list[str]) -> Any:
    with (
        patch("cli.commands._tracker_sync.GitHubClient", return_value=client),
        patch("cli.commands._tracker_sync.load_active_config", return_value=_config()),
        patch("cli.commands.release.primary_remote_repo", return_value=("github.com", "o", "r")),
    ):
        return runner.invoke(app, ["dependabot", *args])


def _entry(number: int) -> PrEntry:
    return PrEntry(number, f"Bump {number}", f"https://github.com/o/r/pull/{number}", ("major",))


def _tracker(number: int, body: str, state: str = "open") -> dict[str, Any]:
    return {"number": number, "state": state, "body": body}


class TestSync:
    @add_test_properties(
        verifies=[
            "PW-DEPENDABOT-SYNC-01",
            "PW-DEPENDABOT-SYNC-02",
            "PW-DEPENDABOT-SYNC-03",
            "PW-DEPENDABOT-SYNC-04",
            "PW-DEPENDABOT-SYNC-14",
            "PW-DEPENDABOT-SYNC-15",
            "PW-DEPENDABOT-SYNC-16",
        ]
    )
    def test_creates_tracker_for_waiting_prs_only(self) -> None:
        prs = [
            _pr(2, "left-pad", "major"),
            _pr(3, "lodash", "minor"),
            _pr(5, "@playwright/test", "minor"),
            _pr(6, "is-odd", "major"),
        ]
        client = _client(prs)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        args = client.create_issue.call_args.kwargs
        assert args["labels"] == ["dependabot-pr"]
        assert args["title"].startswith("[Tracker] dependabot PR — ")
        assert "pr/2 " in args["body"] and "pr/6 " in args["body"]
        assert "pr/3 " not in args["body"] and "pr/5 " not in args["body"]
        assert result.stdout == ""
        lines = result.stderr.splitlines()
        assert lines[:3] == [
            "count: open dependabot PRs: 4",
            "count: PRs awaiting a decision: 2",
            "count: PRs awaiting a decision without check results: 0",
        ]
        assert lines[3].startswith('created: Tracker "[Tracker] dependabot PR — ')
        assert lines[4:] == [
            "added: PR #2 to new Tracker (major)",
            "added: PR #6 to new Tracker (major)",
        ]
        updates = [c.args for c in client.update_project_item_field.call_args_list]
        assert ("PVT_1", "ITEM", "F_workflow", "O_workflow_backlog") in updates
        assert ("PVT_1", "ITEM", "F_priority", "O_priority_medium") in updates

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-05", "PW-DEPENDABOT-SYNC-06"])
    def test_no_waiting_prs_no_tracker(self) -> None:
        client = _client([_pr(3, "lodash", "minor")])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.create_issue.assert_not_called()
        assert result.stderr.splitlines()[-1] == "skipped: Tracker creation"

    @add_test_properties(
        verifies=["PW-DEPENDABOT-SYNC-07", "PW-DEPENDABOT-SYNC-16", "PW-DEPENDABOT-SYNC-17"]
    )
    def test_rewrites_existing_tracker(self) -> None:
        client = _client(
            [_pr(2, "a", "major"), _pr(6, "b", "major"), _pr(5, "@playwright/test", "minor")],
            [_tracker(9, render_tracker_body([_entry(1), _entry(2)]))],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.create_issue.assert_not_called()
        client.update_issue_body.assert_called_once()
        body = client.update_issue_body.call_args.args[3]
        assert "pr/2 " in body and "pr/6 " in body and "pr/5 " not in body and "pr/1 " not in body
        assert result.stdout == ""
        assert result.stderr.splitlines()[3:] == [
            "added: PR #6 to Tracker #9 (major)",
            "removed: PR #1 from Tracker #9",
        ]
        client.close_issue.assert_not_called()

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-20", "PW-DEPENDABOT-SYNC-21"])
    def test_same_list_is_not_patched(self) -> None:
        pr = _pr(2, "a", "major")
        body = render_tracker_body(
            [PrEntry(2, "Bump a", "https://github.com/o/r/pull/2", ("major",), "passed")]
        )
        client = _client([pr], [_tracker(9, body)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()
        client.close_issue.assert_not_called()
        assert result.stderr.splitlines()[-1] == "unchanged: Tracker #9"

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-07"])
    def test_old_form_tracker_is_rewritten_to_the_new_columns(self) -> None:
        prs = [
            _pr(120, "ajv", "major", title="build(repo): bump ajv from 6.15.0 to 8.20.0"),
            _pr(200, "left-pad", "major"),
        ]
        client = _client(prs, [_tracker(179, OLD_FORM_BODY)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.create_issue.assert_not_called()
        assert "added: PR #200 to Tracker #179 (major)\n" in result.stderr
        assert "removed: PR #166 from Tracker #179\n" in result.stderr
        assert "PR #120" not in result.stderr
        body = client.update_issue_body.call_args.args[3]
        assert "| title | PR | checks |" in body
        assert "待っている理由" not in body
        assert "| [#200](https://github.com/o/r/pull/200) | passed |" in body
        assert "major" not in body

    @add_test_properties(
        verifies=["PW-DEPENDABOT-SYNC-22", "PW-DEPENDABOT-SYNC-23", "PW-DEPENDABOT-SYNC-24"]
    )
    def test_empty_list_sets_none_and_closes(self) -> None:
        client = _client([], [_tracker(9, render_tracker_body([_entry(1)]))])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        body = client.update_issue_body.call_args.args[3]
        assert body.split(LIST_BEGIN)[1].split(LIST_END)[0] == "\n## dependabot PR\n\nnone\n"
        client.close_issue.assert_called_once_with("o", "r", 9, state_reason="completed")
        assert result.stderr.splitlines()[3:] == [
            "removed: PR #1 from Tracker #9",
            "closed: Tracker #9",
        ]
        assert "unchanged" not in result.stderr

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-31", "PW-DEPENDABOT-SYNC-32"])
    def test_dry_run_changes_nothing(self) -> None:
        client = _client([], [_tracker(9, render_tracker_body([_entry(1)]))])
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()
        client.close_issue.assert_not_called()
        client.create_issue.assert_not_called()
        assert result.stdout == ""
        assert result.stderr.splitlines()[3:] == [
            "dry-run: would remove PR #1 from Tracker #9",
            "dry-run: would close Tracker #9",
        ]

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-31", "PW-DEPENDABOT-SYNC-32"])
    def test_dry_run_create_changes_nothing(self) -> None:
        client = _client([_pr(2, "a", "major")])
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        client.create_issue.assert_not_called()
        client.add_to_project.assert_not_called()
        client.update_project_item_field.assert_not_called()
        assert result.stdout == ""
        lines = result.stderr.splitlines()
        assert re.fullmatch(
            r'dry-run: would create Tracker "\[Tracker\] dependabot PR — \d{4}-\d\d-\d\d"',
            lines[3],
        )
        assert lines[4:] == ["dry-run: would add PR #2 to new Tracker (major)"]

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-37", "PW-DEPENDABOT-SYNC-38"])
    def test_list_failure_exits_1_without_touching_body(self) -> None:
        client = _client(
            GitHubAPIError("boom", status_code=502), [_tracker(9, render_tracker_body([_entry(1)]))]
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.update_issue_body.assert_not_called()
        client.close_issue.assert_not_called()

    def test_null_rollup_is_counted_in_the_log(self) -> None:
        pr = _pr(2, "a", "major", headCommits={"nodes": [{"commit": {"statusCheckRollup": None}}]})
        result = _invoke(_client([pr]), ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        assert "count: PRs awaiting a decision without check results: 1\n" in result.stderr
        assert "null" not in result.stderr
        assert "None" not in result.stderr

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-15"])
    def test_null_rollup_count_is_limited_to_listed_prs(self) -> None:
        null = {"nodes": [{"commit": {"statusCheckRollup": None}}]}
        prs = [
            _pr(2, "a", "major", headCommits=null),
            _pr(3, "b", "minor", headCommits=null, autoMergeRequest={"enabledAt": "x"}),
        ]
        result = _invoke(_client(prs), ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        assert "count: PRs awaiting a decision: 1\n" in result.stderr
        assert "count: PRs awaiting a decision without check results: 1\n" in result.stderr

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-41", "PW-DEPENDABOT-SYNC-42"])
    def test_body_rewrite_failure_exits_1_and_does_not_close(self) -> None:
        client = _client([], [_tracker(9, render_tracker_body([_entry(1)]))])
        client.update_issue_body.side_effect = GitHubAPIError("422", status_code=422)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.close_issue.assert_not_called()
        assert result.stderr.splitlines()[-1].startswith("error: could not update Tracker #9 body:")
        assert "removed:" not in result.stderr

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-43", "PW-DEPENDABOT-SYNC-44"])
    def test_close_failure_after_rewrite_exits_1_with_retry_message(self) -> None:
        client = _client([], [_tracker(9, render_tracker_body([_entry(1)]))])
        client.close_issue.side_effect = GitHubAPIError("boom", status_code=502)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.update_issue_body.assert_called_once()
        lines = result.stderr.splitlines()
        assert lines[3] == "removed: PR #1 from Tracker #9"
        assert lines[4].startswith(
            "error: could not close Tracker #9 after setting its list to none;"
            " will retry on the next run:"
        )
        assert "closed:" not in result.stderr

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-25", "PW-DEPENDABOT-SYNC-26"])
    def test_retry_closes_without_rewriting_an_already_none_list(self) -> None:
        client = _client([], [_tracker(9, render_tracker_body([]))])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()
        client.close_issue.assert_called_once_with("o", "r", 9, state_reason="completed")
        assert result.stderr.splitlines()[3:] == ["closed: Tracker #9"]

    def test_retry_dry_run_reports_the_close(self) -> None:
        client = _client([], [_tracker(9, render_tracker_body([]))])
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()
        client.close_issue.assert_not_called()
        assert result.stderr.splitlines()[3:] == ["dry-run: would close Tracker #9"]

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-39", "PW-DEPENDABOT-SYNC-40"])
    def test_broken_markers_exit_1_without_touching_anything(self) -> None:
        client = _client(
            [_pr(2, "a", "major")], [_tracker(9, "<!-- pecot-dependabot-pr: tracker -->")]
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert result.stderr.startswith("error: Tracker #9:")
        client.update_issue_body.assert_not_called()
        client.close_issue.assert_not_called()
        client.create_issue.assert_not_called()

    @add_test_properties(verifies=["PW-DEPENDABOT-SYNC-28", "PW-DEPENDABOT-SYNC-30"])
    def test_multiple_open_trackers_warn_and_use_the_smallest(self) -> None:
        body = render_tracker_body([_entry(2)])
        client = _client([_pr(2, "a", "major")], [_tracker(12, body), _tracker(9, body)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        assert (
            "warning: multiple open Trackers; using #9 (lowest number) and leaving #12 open\n"
            in result.stderr
        )
        client.create_issue.assert_not_called()

    @add_test_properties(
        verifies=["PW-DEPENDABOT-SYNC-02", "PW-DEPENDABOT-SYNC-45", "PW-DEPENDABOT-SYNC-46"]
    )
    def test_board_repair_failure_on_existing_tracker_exits_1(self) -> None:
        body = render_tracker_body([_entry(2)])
        client = _client([_pr(2, "a", "major")], [_tracker(9, body)])
        client.add_to_project.side_effect = GitHubAPIError("boom", status_code=502)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert "error: Tracker:" in result.stderr


def _invoke_real_client(args: list[str]) -> Any:
    with (
        patch("cli.commands._tracker_sync.load_active_config", return_value=_config()),
        patch("cli.commands.release.primary_remote_repo", return_value=("github.com", "o", "r")),
    ):
        return runner.invoke(app, ["dependabot", *args])


@add_test_properties(verifies=["PW-DEPENDABOT-SYNC-35", "PW-DEPENDABOT-SYNC-36"])
def test_sync_without_token_is_an_error_line() -> None:
    with patch(
        "cli.core.github.client.GitHubClientBase._get_token",
        side_effect=GitHubAuthError("could not get a GitHub API token"),
    ):
        result = _invoke_real_client(["sync", "--dry-run"])

    assert result.exit_code == 1
    assert "Traceback" not in result.output
    assert "error: could not get a GitHub API token\n" in result.stderr
