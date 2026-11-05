"""tests/cli/test_security.py - pecot security sync / review-exceptions のテスト

GitHubClient（I/O 境界）を差し替え、ボード設定は MagicMock にする。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import typer.testing

from cli.commands.main import app
from cli.core.github import GitHubAPIError, GitHubNotFoundError

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
    singles: dict[str, Any] | None = None,
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
    for attr in ("get_dependabot_alert", "get_code_scanning_alert", "get_secret_scanning_alert"):
        single = (singles or {}).get(attr)
        fn = getattr(client, attr)
        if isinstance(single, Exception):
            fn.side_effect = single
        else:
            fn.return_value = single
    return client


def _invoke(client: MagicMock, args: list[str], config: MagicMock | None = None) -> Any:
    with (
        patch("cli.commands.security.GitHubClient", return_value=client),
        patch("cli.commands.security.load_active_config", return_value=config or _config()),
        patch("cli.commands.release.origin_repo", return_value=("github.com", "o", "r")),
    ):
        return runner.invoke(app, ["security", *args])


def _dep(number: int, severity: str = "medium") -> dict[str, Any]:
    return {
        "number": number,
        "html_url": f"https://github.com/o/r/security/dependabot/{number}",
        "security_vulnerability": {"severity": severity},
        "security_advisory": {"ghsa_id": "GHSA-x"},
        "dependency": {"package": {"name": "pkg"}},
    }


def _cs(number: int) -> dict[str, Any]:
    return {"number": number, "rule": {"id": "js/xss", "severity": "error"}}


def _issue(number: int, state: str, kind: str, alert: int) -> dict[str, Any]:
    return {"number": number, "state": state, "body": f"<!-- pecot-alert: {kind}/{alert} -->"}


class TestSync:
    def test_creates_issue_and_puts_on_board(self) -> None:
        client = _client(dependabot=[_dep(7, "high")])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0, result.output
        args = client.create_issue.call_args.kwargs
        assert args["title"] == "[Bug] Security alert: dependabot #7 (pkg)"
        assert args["labels"] == ["security-alert"]
        assert "<!-- pecot-alert: dependabot/7 -->" in args["body"]
        client.add_to_project.assert_called_once_with("PVT_1", "I_node")
        assert client.update_project_item_field.call_count == 2  # Status と Priority

    def test_status_ready_and_priority_values(self) -> None:
        config = _config()
        config.get_field_id.side_effect = lambda name: f"F_{name}"
        config.get_option_id.side_effect = lambda field, option: f"O_{field}_{option}"
        client = _client(code_scanning=[_cs(10)])
        result = _invoke(client, ["sync"], config)

        assert result.exit_code == 0, result.output
        updates = [c.args for c in client.update_project_item_field.call_args_list]
        assert ("PVT_1", "ITEM", "F_workflow", "O_workflow_ready") in updates
        assert ("PVT_1", "ITEM", "F_priority", "O_priority_high") in updates
        body = client.create_issue.call_args.kwargs["body"]
        assert "js/xss" not in body

    def test_dry_run_changes_nothing(self) -> None:
        client = _client(
            dependabot=[_dep(1)],
            issues=[_issue(5, "open", "code-scanning", 9)],
        )
        result = _invoke(client, ["sync", "--dry-run"])

        assert result.exit_code == 0
        assert "[dry-run] 作る: dependabot #1" in result.output
        assert "[dry-run] 閉じる候補: code-scanning #9" in result.output
        client.create_issue.assert_not_called()
        client.close_issue.assert_not_called()
        client.add_to_project.assert_not_called()

    def test_list_failure_skips_kind_and_never_closes(self) -> None:
        client = _client(
            secret_scanning=GitHubAPIError("boom", status_code=500),
            issues=[_issue(5, "open", "secret-scanning", 1)],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert "secret scanning の一覧を取得できません" in result.stderr
        client.close_issue.assert_not_called()
        client.get_secret_scanning_alert.assert_not_called()

    def test_disabled_secret_scanning_is_skipped_without_failure(self) -> None:
        client = _client(
            secret_scanning=GitHubNotFoundError("nf", status_code=404, response_body="{}"),
            issues=[_issue(5, "open", "secret-scanning", 1)],
        )
        client.get_secret_scanning_status.return_value = "disabled"
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        assert "secret scanning: 無効のため飛ばします" in result.output
        client.close_issue.assert_not_called()

    def test_secret_scanning_404_without_disabled_status_fails(self) -> None:
        """権限不足の 404 を無効とみなさない。飛ばして exit 1"""
        client = _client(
            secret_scanning=GitHubNotFoundError("nf", status_code=404, response_body="{}"),
            issues=[_issue(5, "open", "secret-scanning", 1)],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.close_issue.assert_not_called()

    def test_code_scanning_no_analysis_404_is_zero_alerts(self) -> None:
        """解析が無い 404 は open 0 件。その種類の古い Issue は alert を確かめて閉じる"""
        client = _client(
            code_scanning=GitHubNotFoundError(
                "nf", status_code=404, response_body='{"message": "no analysis found"}'
            ),
            issues=[_issue(5, "open", "code-scanning", 9)],
            singles={"get_code_scanning_alert": {"state": "fixed"}},
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        client.close_issue.assert_called_once_with("o", "r", 5)

    def test_code_scanning_without_ghas_403_is_skipped(self) -> None:
        client = _client(
            code_scanning=GitHubAPIError(
                "denied",
                status_code=403,
                response_body='{"message": "Advanced Security must be enabled for this repository"}',
            ),
            issues=[_issue(5, "open", "code-scanning", 9)],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        assert "code scanning: 無効のため飛ばします" in result.output
        client.close_issue.assert_not_called()

    def test_code_scanning_permission_403_fails(self) -> None:
        client = _client(
            code_scanning=GitHubAPIError(
                "denied",
                status_code=403,
                response_body='{"message": "Resource not accessible by integration"}',
            )
        )
        assert _invoke(client, ["sync"]).exit_code == 1

    def test_dependabot_disabled_is_skipped_without_failure(self) -> None:
        client = _client(
            dependabot=GitHubAPIError("denied", status_code=403, response_body="{}"),
            issues=[_issue(5, "open", "dependabot", 1)],
        )
        client.is_dependabot_alerts_enabled.return_value = False
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        assert "Dependabot: 無効のため飛ばします" in result.output
        client.close_issue.assert_not_called()

    def test_dependabot_forbidden_while_enabled_fails(self) -> None:
        client = _client(dependabot=GitHubAPIError("denied", status_code=403, response_body="{}"))
        assert _invoke(client, ["sync"]).exit_code == 1

    def test_closes_issue_when_alert_fixed(self) -> None:
        client = _client(
            issues=[_issue(5, "open", "code-scanning", 9)],
            singles={"get_code_scanning_alert": {"state": "fixed"}},
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        client.add_issue_comment.assert_called_once_with(
            "o", "r", 5, "alert が fixed になったため閉じます。"
        )
        client.close_issue.assert_called_once_with("o", "r", 5)
        names = [c[0] for c in client.mock_calls if c[0] in ("close_issue", "add_issue_comment")]
        assert names == ["close_issue", "add_issue_comment"]  # 閉じてから理由を付ける

    def test_failed_close_leaves_no_comment(self) -> None:
        client = _client(
            issues=[_issue(5, "open", "code-scanning", 9)],
            singles={"get_code_scanning_alert": {"state": "fixed"}},
        )
        client.close_issue.side_effect = GitHubAPIError("x", status_code=500)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.add_issue_comment.assert_not_called()

    def test_does_not_close_when_single_alert_still_open(self) -> None:
        client = _client(
            issues=[_issue(5, "open", "dependabot", 9)],
            singles={"get_dependabot_alert": {"state": "open"}},
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        client.close_issue.assert_not_called()

    def test_closes_with_missing_alert_404(self) -> None:
        client = _client(
            issues=[_issue(5, "open", "dependabot", 9)],
            singles={"get_dependabot_alert": GitHubNotFoundError("nf", status_code=404)},
        )
        _invoke(client, ["sync"])

        client.add_issue_comment.assert_called_once_with("o", "r", 5, "alert が無いため閉じます。")
        client.close_issue.assert_called_once()

    def test_reopens_closed_issue(self) -> None:
        client = _client(dependabot=[_dep(2)], issues=[_issue(8, "closed", "dependabot", 2)])
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        client.reopen_issue.assert_called_once_with("o", "r", 8)
        client.create_issue.assert_not_called()

    def test_reopened_issue_is_set_back_to_ready(self) -> None:
        config = _config()
        config.get_field_id.side_effect = lambda name: f"F_{name}"
        config.get_option_id.side_effect = lambda field, option: f"O_{field}_{option}"
        # 閉じる前に Active だった項目でも、reopen では Ready に戻す
        client = _client(dependabot=[_dep(2)], issues=[_issue(8, "closed", "dependabot", 2)])
        client.get_item_set_field_ids.return_value = {"F_workflow"}
        result = _invoke(client, ["sync"], config)

        assert result.exit_code == 0
        updates = [c.args for c in client.update_project_item_field.call_args_list]
        assert ("PVT_1", "ITEM", "F_workflow", "O_workflow_ready") in updates
        assert ("PVT_1", "ITEM", "F_priority", "O_priority_medium") in updates

    def _existing(self, set_field_ids: set[str]) -> tuple[MagicMock, Any]:
        config = _config()
        config.get_field_id.side_effect = lambda name: f"F_{name}"
        config.get_option_id.side_effect = lambda field, option: f"O_{field}_{option}"
        client = _client(dependabot=[_dep(1)], issues=[_issue(5, "open", "dependabot", 1)])
        client.get_item_set_field_ids.return_value = set_field_ids
        return client, _invoke(client, ["sync"], config)

    def test_existing_issue_with_started_status_is_not_reset(self) -> None:
        """Status が入っている項目（着手済み）を Ready に戻さない。Priority は付け直す"""
        client, result = self._existing({"F_workflow", "F_priority"})

        assert result.exit_code == 0
        client.create_issue.assert_not_called()
        client.add_to_project.assert_called_once()
        fields = [c.args[2] for c in client.update_project_item_field.call_args_list]
        assert fields == ["F_priority"]

    def test_existing_issue_with_empty_status_gets_ready(self) -> None:
        """途中で失敗して Status が空のまま残った項目は、次の実行で Ready になる"""
        client, result = self._existing(set())

        assert result.exit_code == 0
        updates = [c.args for c in client.update_project_item_field.call_args_list]
        assert ("PVT_1", "ITEM", "F_workflow", "O_workflow_ready") in updates

    def test_duplicate_open_issues_are_closed_keeping_the_oldest(self) -> None:
        client = _client(
            dependabot=[_dep(1)],
            issues=[_issue(7, "open", "dependabot", 1), _issue(5, "open", "dependabot", 1)],
        )
        result = _invoke(client, ["sync"])

        assert result.exit_code == 0
        client.close_issue.assert_called_once_with("o", "r", 7, "not_planned")
        comment = client.add_issue_comment.call_args.args
        assert comment[:3] == ("o", "r", 7)
        assert "#5" in comment[3]
        assert "重複" in comment[3]

    def test_one_failure_does_not_stop_the_rest(self) -> None:
        client = _client(dependabot=[_dep(1), _dep(2)])
        client.create_issue.side_effect = [
            GitHubAPIError("x", status_code=500),
            {"number": 101, "html_url": "u"},
        ]
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        assert client.create_issue.call_count == 2

    def test_issue_list_failure_exits_1(self) -> None:
        client = _client()
        client.list_issues_by_label.side_effect = GitHubAPIError("x", status_code=500)
        result = _invoke(client, ["sync"])

        assert result.exit_code == 1
        client.create_issue.assert_not_called()


def _git_root_with_exceptions(tmp_path: Path, count: int) -> Path:
    gh = tmp_path / ".github"
    gh.mkdir()
    items = [
        {"alert": n, "package": "pkg", "reason": "理由", "reevaluate": f"条件{n}"}
        for n in range(1, count + 1)
    ]
    (gh / "dependabot-exceptions.json").write_text(json.dumps({"exceptions": items}))
    return tmp_path


def _invoke_review(client: MagicMock, git_root: Path, args: list[str] | None = None) -> Any:
    with (
        patch("cli.commands.security.GitHubClient", return_value=client),
        patch("cli.commands.security.load_active_config", return_value=_config()),
        patch("cli.commands.security.git_toplevel", return_value=git_root),
        patch("cli.commands.release.origin_repo", return_value=("github.com", "o", "r")),
    ):
        return runner.invoke(app, ["security", "review-exceptions", *(args or [])])


class TestReviewExceptions:
    def test_no_exceptions_creates_nothing(self, tmp_path: Path) -> None:
        client = _client()
        result = _invoke_review(client, tmp_path)

        assert result.exit_code == 0
        client.create_issue.assert_not_called()

    def test_creates_review_issue(self, tmp_path: Path) -> None:
        client = _client()
        result = _invoke_review(client, _git_root_with_exceptions(tmp_path, 2))

        assert result.exit_code == 0, result.output
        kwargs = client.create_issue.call_args.kwargs
        assert kwargs["title"] == "[Task] Dependabot の例外を見直す"
        assert "<!-- pecot-alert: exceptions-review -->" in kwargs["body"]
        assert "条件1" in kwargs["body"]
        assert "条件2" in kwargs["body"]
        client.add_to_project.assert_called_once()

    def test_open_review_issue_blocks_creation(self, tmp_path: Path) -> None:
        client = _client(
            issues=[
                {"number": 9, "state": "open", "body": "<!-- pecot-alert: exceptions-review -->"}
            ]
        )
        result = _invoke_review(client, _git_root_with_exceptions(tmp_path, 1))

        assert result.exit_code == 0
        client.create_issue.assert_not_called()

    def test_open_review_issue_is_put_on_board_again(self, tmp_path: Path) -> None:
        """作った後にボード登録が失敗した実行を、次の実行で直す（Status は空のときだけ）"""
        client = _client(
            issues=[
                {"number": 9, "state": "open", "body": "<!-- pecot-alert: exceptions-review -->"}
            ]
        )
        result = _invoke_review(client, _git_root_with_exceptions(tmp_path, 1))

        assert result.exit_code == 0
        client.add_to_project.assert_called_once()
        client.get_item_set_field_ids.assert_called_once()

    def test_closed_review_issue_does_not_block(self, tmp_path: Path) -> None:
        client = _client(
            issues=[
                {"number": 9, "state": "closed", "body": "<!-- pecot-alert: exceptions-review -->"}
            ]
        )
        _invoke_review(client, _git_root_with_exceptions(tmp_path, 1))

        client.create_issue.assert_called_once()

    def test_dry_run(self, tmp_path: Path) -> None:
        client = _client()
        result = _invoke_review(client, _git_root_with_exceptions(tmp_path, 1), ["--dry-run"])

        assert result.exit_code == 0
        assert "[dry-run] 作る" in result.output
        client.create_issue.assert_not_called()
