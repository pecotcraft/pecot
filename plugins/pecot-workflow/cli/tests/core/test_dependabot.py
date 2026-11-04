"""tests/core/test_dependabot.py - fetch_dependabot_alert_status のテスト

GitHubClient は I/O 境界として差し替え、一覧取得と有効判定の応答の組み合わせで
分類（有効 / 無効 / エラー）と severity の集計を確認する。
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from cli.core.dependabot import (
    DependabotAlertError,
    DependabotAlertStatus,
    OpenAlert,
    fetch_dependabot_alert_status,
)
from cli.core.github import GitHubAPIError, GitHubNotFoundError, GitHubRateLimitError

URL = "https://ghes.example.com/owner/repo/security/dependabot"


def _alert(severity: Any) -> dict[str, Any]:
    return {
        "number": 1,
        "security_advisory": {"severity": "low"},
        "security_vulnerability": {"severity": severity},
    }


def _client(
    alerts: list[dict[str, Any]] | Exception, enabled: bool | Exception | None = None
) -> MagicMock:
    client = MagicMock()
    if isinstance(alerts, Exception):
        client.list_open_dependabot_alerts.side_effect = alerts
    else:
        client.list_open_dependabot_alerts.return_value = alerts
    if isinstance(enabled, Exception):
        client.is_dependabot_alerts_enabled.side_effect = enabled
    elif enabled is not None:
        client.is_dependabot_alerts_enabled.return_value = enabled
    return client


def _forbidden() -> GitHubAPIError:
    return GitHubAPIError(
        "アクセスが拒否されました。",
        status_code=403,
        response_body='{"message":"Dependabot alerts are disabled for this repository."}\nextra',
    )


class TestOpenAlerts:
    def test_max_severity_is_critical(self) -> None:
        client = _client([_alert("low"), _alert("critical"), _alert("high"), _alert("medium")])

        status = fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

        assert (
            status.model_dump()
            == DependabotAlertStatus(
                enabled=True, open_count=4, max_severity="critical", alerts_url=URL
            ).model_dump()
        )
        assert [a.severity for a in status.open_alerts] == ["low", "critical", "high", "medium"]
        client.is_dependabot_alerts_enabled.assert_not_called()

    def test_open_alerts_carry_number_and_package(self) -> None:
        alert = {
            "number": 17,
            "dependency": {"package": {"name": "minimatch"}},
            "security_vulnerability": {"severity": "medium"},
        }
        client = _client([alert, {"security_vulnerability": {"severity": "high"}}])

        status = fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

        assert status.open_count == 2
        assert status.open_alerts == [OpenAlert(number=17, package="minimatch", severity="medium")]
        assert "open_alerts" not in status.model_dump()

    def test_unknown_severity_does_not_fail(self) -> None:
        client = _client([_alert("moderate"), _alert("medium"), _alert("weird")])

        status = fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

        assert status.open_count == 3
        assert status.max_severity == "medium"

    def test_only_unknown_or_missing_severity(self) -> None:
        client = _client([_alert("moderate"), {"number": 2}, _alert(None)])

        status = fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

        assert status.open_count == 3
        assert status.max_severity == "moderate"

    def test_zero_alerts(self) -> None:
        status = fetch_dependabot_alert_status(_client([]), "ghes.example.com", "owner", "repo")

        assert status == DependabotAlertStatus(
            enabled=True, open_count=0, max_severity=None, alerts_url=URL
        )


class TestForbidden:
    def test_disabled_when_vulnerability_alerts_404(self) -> None:
        client = _client(_forbidden(), enabled=False)

        status = fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

        assert status == DependabotAlertStatus(
            enabled=False, open_count=0, max_severity=None, alerts_url=URL
        )
        client.is_dependabot_alerts_enabled.assert_called_once_with("owner", "repo")

    def test_enabled_but_list_forbidden_is_error(self) -> None:
        client = _client(_forbidden(), enabled=True)

        with pytest.raises(DependabotAlertError, match="有効ですが一覧を取得できません"):
            fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

    def test_check_failure_is_error(self) -> None:
        check_error = GitHubAPIError(
            "GitHub APIエラー: 500", status_code=500, response_body='{"message":"boom"}'
        )
        client = _client(_forbidden(), enabled=check_error)

        with pytest.raises(DependabotAlertError, match="owner/repo: GitHub APIエラー: 500 boom"):
            fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

    def test_rate_limit_is_error_without_disabled_check(self) -> None:
        client = _client(
            GitHubRateLimitError(
                "APIレート制限に達しました。", status_code=403, response_body="rate limit"
            )
        )

        with pytest.raises(DependabotAlertError, match="レート制限"):
            fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")
        client.is_dependabot_alerts_enabled.assert_not_called()


class TestErrors:
    def test_json_body_adds_only_message(self) -> None:
        client = _client(
            GitHubAPIError(
                "GitHub APIエラー: 500",
                status_code=500,
                response_body='{"message":"Server Error","documentation_url":"https://docs"}',
            )
        )

        with pytest.raises(DependabotAlertError) as exc_info:
            fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

        assert str(exc_info.value) == "owner/repo: GitHub APIエラー: 500 Server Error"
        client.is_dependabot_alerts_enabled.assert_not_called()

    def test_html_body_adds_nothing(self) -> None:
        client = _client(
            GitHubAPIError(
                "GitHub APIエラー: 502",
                status_code=502,
                response_body="<html><body>Bad Gateway</body></html>",
            )
        )

        with pytest.raises(DependabotAlertError) as exc_info:
            fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

        assert str(exc_info.value) == "owner/repo: GitHub APIエラー: 502"

    def test_error_without_body(self) -> None:
        client = _client(GitHubNotFoundError("リソースが見つかりません", status_code=404))

        with pytest.raises(DependabotAlertError) as exc_info:
            fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

        assert str(exc_info.value) == "owner/repo: リソースが見つかりません"

    def test_connect_error_is_wrapped(self) -> None:
        client = _client(httpx.ConnectError("connection refused"))

        with pytest.raises(DependabotAlertError, match="通信に失敗しました: connection refused"):
            fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")

    def test_connect_error_during_check_is_wrapped(self) -> None:
        client = _client(_forbidden(), enabled=httpx.ConnectError("down"))

        with pytest.raises(DependabotAlertError, match="通信に失敗しました: down"):
            fetch_dependabot_alert_status(client, "ghes.example.com", "owner", "repo")


def test_alerts_url_uses_host_owner_repo() -> None:
    status = fetch_dependabot_alert_status(_client([]), "ghe.example.com", "org", "proj")

    assert status.alerts_url == "https://ghe.example.com/org/proj/security/dependabot"
