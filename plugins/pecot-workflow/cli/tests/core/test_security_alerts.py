"""tests/core/test_security_alerts.py - security alert の形そろえ・突き合わせ・本文のテスト

GitHubClient は I/O 境界として差し替える。
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from cli.core.dependabot import DependabotException
from cli.core.github import GitHubAPIError, GitHubNotFoundError, GitHubRateLimitError
from cli.core.security_alerts import (
    Alert,
    SecurityAlertError,
    build_issue_body,
    build_issue_title,
    build_review_body,
    close_reason,
    fetch_code_scanning_status,
    fetch_secret_scanning_status,
    list_open_alerts,
    normalize_code_scanning,
    normalize_dependabot,
    normalize_secret_scanning,
    parse_alert_marker,
    plan_sync,
)

H, OWNER, R = "github.com", "o", "r"


def _dep(number: int = 7, severity: str | None = "high") -> dict[str, Any]:
    return {
        "number": number,
        "html_url": f"https://github.com/o/r/security/dependabot/{number}",
        "security_vulnerability": {"severity": severity},
        "security_advisory": {"ghsa_id": "GHSA-aaaa-bbbb-cccc", "severity": "low"},
        "dependency": {"package": {"name": "left-pad"}},
    }


class TestNormalize:
    @pytest.mark.parametrize(
        ("severity", "expected"),
        [("critical", "high"), ("high", "high"), ("medium", "medium"), ("low", "low")],
    )
    def test_dependabot_priority(self, severity: str, expected: str) -> None:
        alert = normalize_dependabot(_dep(severity=severity), H, OWNER, R)
        assert alert is not None
        assert alert.priority == expected

    def test_dependabot_fields(self) -> None:
        alert = normalize_dependabot(_dep(), H, OWNER, R)
        assert alert == Alert(
            kind="dependabot",
            number=7,
            priority="high",
            url="https://github.com/o/r/security/dependabot/7",
            package="left-pad",
            ghsa="GHSA-aaaa-bbbb-cccc",
        )

    def test_dependabot_without_number_is_dropped(self) -> None:
        assert normalize_dependabot({"html_url": "x"}, H, OWNER, R) is None

    @pytest.mark.parametrize(
        ("rule", "expected"),
        [
            ({"security_severity_level": "critical", "severity": "note"}, "high"),
            ({"security_severity_level": "medium", "severity": "error"}, "medium"),
            ({"security_severity_level": None, "severity": "error"}, "high"),
            ({"severity": "warning"}, "medium"),
            ({"severity": "note"}, "low"),
            ({}, "medium"),
        ],
    )
    def test_code_scanning_priority(self, rule: dict[str, Any], expected: str) -> None:
        alert = normalize_code_scanning({"number": 10, "rule": rule}, H, OWNER, R)
        assert alert is not None
        assert alert.priority == expected
        assert alert.url == "https://github.com/o/r/security/code-scanning/10"

    def test_secret_scanning_is_high(self) -> None:
        alert = normalize_secret_scanning(
            {"number": 2, "secret_type": "x", "secret": "v"}, H, OWNER, R
        )
        assert alert is not None
        assert alert.priority == "high"
        assert alert.package is None


def _a(kind: str, number: int) -> Alert:
    return Alert(kind=kind, number=number, priority="medium", url="u")  # type: ignore[arg-type]


def _issue(number: int, state: str, kind: str, alert: int) -> dict[str, Any]:
    return {
        "number": number,
        "state": state,
        "body": f"<!-- pecot-alert: {kind}/{alert} -->\n本文",
    }


class TestPlanSync:
    def test_create_reopen_ensure_close(self) -> None:
        alerts = {
            "dependabot": [_a("dependabot", 1), _a("dependabot", 2), _a("dependabot", 3)],
            "code-scanning": [],
            "secret-scanning": [],
        }
        issues = [
            _issue(10, "open", "dependabot", 1),
            _issue(11, "closed", "dependabot", 2),
            _issue(12, "open", "code-scanning", 5),
            {"number": 13, "state": "open", "body": "印なし"},
        ]
        plan = plan_sync(alerts, issues)  # type: ignore[arg-type]

        assert [a.number for a in plan.create] == [3]
        assert [(a.number, n) for a, n in plan.reopen] == [(2, 11)]
        assert [(a.number, n) for a, n in plan.ensure] == [(1, 10)]
        assert plan.close == [("code-scanning", 5, 12)]

    def test_second_run_is_noop(self) -> None:
        alerts = {"dependabot": [_a("dependabot", 1)]}
        plan = plan_sync(alerts, [_issue(10, "open", "dependabot", 1)])  # type: ignore[arg-type]
        assert plan.create == []
        assert plan.reopen == []
        assert plan.close == []

    def test_skipped_kind_neither_creates_nor_closes(self) -> None:
        alerts = {"dependabot": [], "code-scanning": [_a("code-scanning", 9)]}
        issues = [_issue(10, "open", "secret-scanning", 1), _issue(11, "open", "dependabot", 4)]
        plan = plan_sync(alerts, issues, {"secret-scanning", "code-scanning"})  # type: ignore[arg-type]

        assert plan.create == []
        assert plan.close == [("dependabot", 4, 11)]

    def test_duplicates_prefer_open_then_latest_closed(self) -> None:
        alerts = {"dependabot": [_a("dependabot", 1), _a("dependabot", 2)]}
        issues = [
            _issue(10, "closed", "dependabot", 1),
            _issue(20, "closed", "dependabot", 1),
            _issue(30, "open", "dependabot", 2),
            _issue(31, "closed", "dependabot", 2),
        ]
        plan = plan_sync(alerts, issues)  # type: ignore[arg-type]

        assert [(a.number, n) for a, n in plan.reopen] == [(1, 20)]
        assert [(a.number, n) for a, n in plan.ensure] == [(2, 30)]

    def test_extra_open_issues_are_duplicates_keeping_the_oldest(self) -> None:
        alerts = {"dependabot": [_a("dependabot", 1)]}
        issues = [
            _issue(30, "open", "dependabot", 1),
            _issue(10, "open", "dependabot", 1),
            _issue(20, "open", "dependabot", 1),
        ]
        plan = plan_sync(alerts, issues)  # type: ignore[arg-type]

        assert [(a.number, n) for a, n in plan.ensure] == [(1, 10)]
        assert plan.duplicates == [("dependabot", 1, 20, 10), ("dependabot", 1, 30, 10)]

    def test_review_issue_marker_is_not_an_alert(self) -> None:
        review = {"number": 5, "state": "open", "body": "<!-- pecot-alert: exceptions-review -->"}
        plan = plan_sync({}, [review])
        assert plan.close == []
        assert parse_alert_marker(review["body"]) is None


class TestCloseReason:
    def test_missing_alert(self) -> None:
        assert close_reason("dependabot", None) == "alert が無いため閉じます。"

    def test_fixed(self) -> None:
        assert (
            close_reason("code-scanning", {"state": "fixed"})
            == "alert が fixed になったため閉じます。"
        )

    def test_dismissed_with_reason_only_enum(self) -> None:
        reason = close_reason(
            "dependabot",
            {
                "state": "dismissed",
                "dismissed_reason": "tolerable_risk",
                "dismissed_comment": "秘密",
            },
        )
        assert reason == "alert が dismissed になったため閉じます（理由: tolerable_risk）。"

    def test_resolved_with_resolution(self) -> None:
        reason = close_reason("secret-scanning", {"state": "resolved", "resolution": "revoked"})
        assert reason == "alert が resolved になったため閉じます（理由: revoked）。"

    def test_still_open_is_not_closed(self) -> None:
        assert close_reason("dependabot", {"state": "open"}) is None


class TestText:
    def test_title_formats(self) -> None:
        assert (
            build_issue_title(_a("code-scanning", 10)) == "[Bug] Security alert: code-scanning #10"
        )
        dep = normalize_dependabot(_dep(), H, OWNER, R)
        assert dep is not None
        assert build_issue_title(dep) == "[Bug] Security alert: dependabot #7 (left-pad)"

    def test_dependabot_body(self) -> None:
        dep = normalize_dependabot(_dep(), H, OWNER, R)
        assert dep is not None
        body = build_issue_body(dep, H, OWNER, R)
        assert body.startswith("<!-- pecot-alert: dependabot/7 -->")
        assert "GHSA-aaaa-bbbb-cccc" in body
        assert "left-pad" in body
        assert "Priority: high" in body
        assert "https://github.com/o/r/blob/main/SECURITY.md#alert-dependabot" in body
        assert parse_alert_marker(body) == ("dependabot", 7)

    def test_code_scanning_body_has_no_rule_path_or_line(self) -> None:
        raw = {
            "number": 10,
            "rule": {"id": "js/sql-injection", "severity": "error", "description": "SQL注入"},
            "most_recent_instance": {
                "location": {"path": "src/secret/file.py", "start_line": 42},
                "message": {"text": "tainted"},
            },
        }
        alert = normalize_code_scanning(raw, H, OWNER, R)
        assert alert is not None
        text = build_issue_title(alert) + build_issue_body(alert, H, OWNER, R)
        for leaked in ("js/sql-injection", "SQL注入", "src/secret", "42", "tainted"):
            assert leaked not in text.replace("#10", "").replace("code-scanning/10", "")
        assert "alert-code-scanning" in text

    def test_secret_body_has_no_type_location_or_value(self) -> None:
        raw = {
            "number": 2,
            "secret_type": "github_personal_access_token",
            "secret": "ghp_dummyvalue",
            "locations_url": "https://api/loc",
        }
        alert = normalize_secret_scanning(raw, H, OWNER, R)
        assert alert is not None
        text = build_issue_title(alert) + build_issue_body(alert, H, OWNER, R)
        for leaked in ("github_personal_access_token", "ghp_dummyvalue", "loc"):
            assert leaked not in text
        assert "alert-secret-scanning" in text

    def test_review_body(self) -> None:
        exceptions = [
            DependabotException(
                alert=3, package="pkg", reason="秘匿の理由", reevaluate="v2 が出たら"
            )
        ]
        body = build_review_body(exceptions, H, OWNER, R)
        assert body.startswith("<!-- pecot-alert: exceptions-review -->")
        assert "alert #3（pkg）: 見直し条件: v2 が出たら" in body
        assert "秘匿の理由" not in body
        assert "SECURITY.md#alert-exceptions-review" in body


def _err(status: int, message: str, cls: type[GitHubAPIError] = GitHubAPIError) -> GitHubAPIError:
    return cls("e", status_code=status, response_body=f'{{"message":"{message}"}}')


class TestListOpenAlerts:
    def _dep(self, error: Exception | None, enabled: bool | Exception = True) -> MagicMock:
        client = MagicMock()
        if error is not None:
            client.list_open_dependabot_alerts.side_effect = error
        else:
            client.list_open_dependabot_alerts.return_value = [{"number": 1}]
        if isinstance(enabled, Exception):
            client.is_dependabot_alerts_enabled.side_effect = enabled
        else:
            client.is_dependabot_alerts_enabled.return_value = enabled
        return client

    def test_dependabot_ok(self) -> None:
        assert list_open_alerts(self._dep(None), "dependabot", OWNER, R) == [{"number": 1}]

    def test_dependabot_disabled_is_none(self) -> None:
        client = self._dep(_err(403, "Dependabot alerts are disabled"), enabled=False)
        assert list_open_alerts(client, "dependabot", OWNER, R) is None

    def test_dependabot_forbidden_but_enabled_is_error(self) -> None:
        client = self._dep(_err(403, "Resource not accessible"), enabled=True)
        with pytest.raises(SecurityAlertError, match="権限不足"):
            list_open_alerts(client, "dependabot", OWNER, R)

    def test_dependabot_rate_limit_is_error_without_lookup(self) -> None:
        client = self._dep(_err(403, "rate limit", GitHubRateLimitError))
        with pytest.raises(SecurityAlertError):
            list_open_alerts(client, "dependabot", OWNER, R)
        client.is_dependabot_alerts_enabled.assert_not_called()

    def test_network_error_is_security_alert_error(self) -> None:
        client = self._dep(httpx.ConnectError("down"))
        with pytest.raises(SecurityAlertError, match="通信"):
            list_open_alerts(client, "dependabot", OWNER, R)


class TestScanStatus:
    def _cs(self, result: Any) -> MagicMock:
        client = MagicMock()
        if isinstance(result, Exception):
            client.list_open_code_scanning_alerts.side_effect = result
        else:
            client.list_open_code_scanning_alerts.return_value = result
        return client

    def test_code_scanning_counts_with_numbers(self) -> None:
        status = fetch_code_scanning_status(self._cs([{"number": 12}, {"number": 10}]), H, OWNER, R)
        assert (status.enabled, status.open_count, status.open_numbers) == (True, 2, [10, 12])

    def test_code_scanning_does_not_pass_ref(self) -> None:
        """ref を付けない（既定ブランチが main でないリポでも alert を取りこぼさない）"""
        client = self._cs([])
        fetch_code_scanning_status(client, H, OWNER, R)
        client.list_open_code_scanning_alerts.assert_called_once_with(OWNER, R)

    def test_code_scanning_ghas_missing_is_disabled(self) -> None:
        err = _err(
            403, "Advanced Security must be enabled for this repository to use code scanning."
        )
        status = fetch_code_scanning_status(self._cs(err), H, OWNER, R)
        assert status.enabled is False

    def test_code_scanning_permission_is_error(self) -> None:
        with pytest.raises(SecurityAlertError):
            fetch_code_scanning_status(
                self._cs(_err(403, "Resource not accessible by integration")), H, OWNER, R
            )

    def test_code_scanning_rate_limit_is_error(self) -> None:
        err = _err(403, "API rate limit exceeded; Advanced Security", GitHubRateLimitError)
        with pytest.raises(SecurityAlertError):
            fetch_code_scanning_status(self._cs(err), H, OWNER, R)

    def test_code_scanning_no_analysis_is_zero(self) -> None:
        status = fetch_code_scanning_status(
            self._cs(_err(404, "no analysis found", GitHubNotFoundError)), H, OWNER, R
        )
        assert (status.enabled, status.open_count) == (True, 0)

    def _ss404(self, repo_status: str | None) -> MagicMock:
        client = MagicMock()
        client.list_open_secret_scanning_alerts.side_effect = _err(
            404, "Secret scanning is disabled on this repository.", GitHubNotFoundError
        )
        client.get_secret_scanning_status.return_value = repo_status
        return client

    def test_secret_scanning_404_with_disabled_status_is_disabled(self) -> None:
        assert fetch_secret_scanning_status(self._ss404("disabled"), H, OWNER, R).enabled is False

    @pytest.mark.parametrize("repo_status", [None, "enabled"])
    def test_secret_scanning_404_without_disabled_is_error(self, repo_status: str | None) -> None:
        """権限不足（状態が読めない）・有効なのに 404 は、無効としない"""
        with pytest.raises(SecurityAlertError, match="secret scanning"):
            fetch_secret_scanning_status(self._ss404(repo_status), H, OWNER, R)

    def test_secret_scanning_status_lookup_failure_is_error(self) -> None:
        client = self._ss404(None)
        client.get_secret_scanning_status.side_effect = _err(500, "boom")
        with pytest.raises(SecurityAlertError):
            fetch_secret_scanning_status(client, H, OWNER, R)

    def test_secret_scanning_403_is_error(self) -> None:
        client = MagicMock()
        client.list_open_secret_scanning_alerts.side_effect = _err(403, "forbidden")
        with pytest.raises(SecurityAlertError, match="secret scanning"):
            fetch_secret_scanning_status(client, H, OWNER, R)

    def test_secret_scanning_count(self) -> None:
        client = MagicMock()
        client.list_open_secret_scanning_alerts.return_value = [{"number": 1}]
        assert fetch_secret_scanning_status(client, H, OWNER, R).open_count == 1
