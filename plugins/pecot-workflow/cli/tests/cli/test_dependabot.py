"""tests/cli/test_dependabot.py - pecot dependabot sync（Tracker の一覧の書き直し）のテスト

GitHubClient（I/O 境界）を差し替え、ボード設定は MagicMock にする。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import MagicMock, patch

import typer.testing

from cli.commands.main import app
from cli.core.dependabot_prs import TrackerEntry, render_tracker_body
from cli.core.github import GitHubAPIError

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
        "body": "",
        "createdAt": _iso(timedelta(hours=3)),
        "author": {"__typename": "Bot", "login": "dependabot"},
        "isInMergeQueue": False,
        "autoMergeRequest": {"enabledAt": _iso(timedelta(hours=3))},
        "mergeable": "MERGEABLE",
        "baseRef": {"target": {"committedDate": _iso(timedelta(days=2))}},
        "firstCommits": {
            "nodes": [
                {"commit": {"message": message, "author": {"user": {"login": "dependabot[bot]"}}}}
            ]
        },
        "headCommits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]},
        "timelineItems": {"nodes": []},
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
        patch("cli.commands.dependabot.GitHubClient", return_value=client),
        patch("cli.commands.release.load_active_config", return_value=_config()),
        patch("cli.commands.release.origin_repo", return_value=("github.com", "o", "r")),
    ):
        return runner.invoke(app, ["dependabot", *args])


def _entry(number: int) -> TrackerEntry:
    return TrackerEntry(
        number, f"Bump {number}", f"https://github.com/o/r/pull/{number}", ("major",)
    )


def _tracker(number: int, body: str, state: str = "open") -> dict[str, Any]:
    return {"number": number, "state": state, "body": body}


class TestSync:
    def test_creates_tracker_for_waiting_prs_only(self) -> None:
        prs = [
            _pr(2, "left-pad", "major"),
            _pr(3, "lodash", "minor"),
            _pr(5, "@playwright/test", "minor"),
        ]
        client = _client(prs)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        args = client.create_issue.call_args.kwargs
        assert args["labels"] == ["dependabot-pr"]
        assert args["title"].startswith("[Tracker] dependabot PR — ")
        assert "pr/2 " in args["body"] and "pr/5 " in args["body"]
        assert "pr/3 " not in args["body"]
        assert "Tracker に載せる: PR #2（major）" in result.output
        assert "Tracker に載せる: PR #5（playwright）" in result.output
        assert "検証の結果が null: 0 件" in result.output
        updates = [c.args for c in client.update_project_item_field.call_args_list]
        assert ("PVT_1", "ITEM", "F_workflow", "O_workflow_backlog") in updates
        assert ("PVT_1", "ITEM", "F_priority", "O_priority_medium") in updates

    def test_no_waiting_prs_no_tracker(self) -> None:
        client = _client([_pr(3, "lodash", "minor")])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        client.create_issue.assert_not_called()
        assert "Tracker を立てません（人の判断を待つ PR がありません）" in result.output

    def test_rewrites_existing_tracker(self) -> None:
        client = _client(
            [_pr(2, "a", "major"), _pr(5, "@playwright/test", "minor")],
            [_tracker(9, render_tracker_body([_entry(1), _entry(2)]))],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.create_issue.assert_not_called()
        client.update_issue_body.assert_called_once()
        body = client.update_issue_body.call_args.args[3]
        assert "pr/2 " in body and "pr/5 " in body and "pr/1 " not in body
        assert "Tracker #9 から外す: PR #1" in result.output
        assert "Tracker #9 に足す: PR #5（playwright）" in result.output
        client.close_issue.assert_not_called()

    def test_same_list_is_not_patched(self) -> None:
        pr = _pr(2, "a", "major")
        body = render_tracker_body(
            [TrackerEntry(2, "Bump a", "https://github.com/o/r/pull/2", ("major",))]
        )
        client = _client([pr], [_tracker(9, body)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()
        client.close_issue.assert_not_called()
        assert "Tracker #9 は変わらない" in result.output

    def test_empty_list_empties_the_table_and_closes(self) -> None:
        client = _client([], [_tracker(9, render_tracker_body([_entry(1)]))])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        body = client.update_issue_body.call_args.args[3]
        assert "pr/" not in body.replace("pecot-dependabot-pr: tracker", "")
        client.close_issue.assert_called_once_with("o", "r", 9, state_reason="completed")
        assert "閉じた: Tracker #9" in result.output

    def test_dry_run_changes_nothing(self) -> None:
        client = _client([], [_tracker(9, render_tracker_body([_entry(1)]))])
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        client.update_issue_body.assert_not_called()
        client.close_issue.assert_not_called()
        client.create_issue.assert_not_called()
        assert "[dry-run] Tracker #9 から外す: PR #1" in result.output
        assert "[dry-run] Tracker #9 を閉じる" in result.output

    def test_dry_run_create_changes_nothing(self) -> None:
        client = _client([_pr(2, "a", "major")])
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0, result.output
        client.create_issue.assert_not_called()
        assert "[dry-run] Tracker に載せる: PR #2（major）" in result.output

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

        assert "検証の結果が null: 1 件" in result.output
