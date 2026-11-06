"""tests/core/test_security_alerts.py - security alert の形そろえ・突き合わせ・本文のテスト

GitHubClient は I/O 境界として差し替える。
"""

from __future__ import annotations

import re
from dataclasses import replace
from datetime import date
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from cli.core.dependabot import DependabotException
from cli.core.github import GitHubAPIError, GitHubNotFoundError, GitHubRateLimitError
from cli.core.security_alerts import (
    BODY_LIMIT,
    Alert,
    SecurityAlertError,
    TrackerEntry,
    alert_result,
    build_tracker_title,
    fetch_code_scanning_status,
    fetch_secret_scanning_status,
    find_tracker,
    list_open_alerts,
    max_priority,
    normalize_code_scanning,
    normalize_dependabot,
    normalize_secret_scanning,
    parse_tracker_entries,
    plan_tracker,
    render_tracker_body,
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


def _a(kind: str, number: int, priority: str = "medium", package: str | None = None) -> Alert:
    return Alert(
        kind=kind,  # type: ignore[arg-type]
        number=number,
        priority=priority,
        url="u",
        package=package,
    )


def _e(kind: str, number: int, state: str = "open", **kw: Any) -> TrackerEntry:
    return TrackerEntry(kind=kind, number=number, state=state, **kw)  # type: ignore[arg-type]


def _exc(alert: int, reevaluate: str = "v2 が出たら") -> DependabotException:
    return DependabotException(
        alert=alert, package="pkg", reason="秘匿の理由", reevaluate=reevaluate
    )


def _states(plan: Any) -> dict[tuple[str, int], str]:
    return {e.key: e.state for e in plan.entries}


class TestPlanTracker:
    def test_no_tracker_creates_with_open_alerts_only(self) -> None:
        alerts = {"dependabot": [_a("dependabot", 1), _a("dependabot", 2)]}
        plan = plan_tracker(alerts, [_exc(2)], None)

        assert plan.create is True
        assert _states(plan) == {("dependabot", 1): "open"}

    def test_no_tracker_and_only_exceptions_does_not_create(self) -> None:
        plan = plan_tracker({"dependabot": [_a("dependabot", 2)]}, [_exc(2)], None)

        assert plan.create is False
        assert plan.entries == []

    def test_existing_tracker_never_creates(self) -> None:
        plan = plan_tracker({"dependabot": [_a("dependabot", 1)]}, [], [])

        assert plan.create is False
        assert [e.number for e in plan.added] == [1]

    def test_open_alert_with_exception_becomes_exception_row(self) -> None:
        old = [_e("dependabot", 1, "open")]
        plan = plan_tracker({"dependabot": [_a("dependabot", 1)]}, [_exc(1)], old)

        assert _states(plan) == {("dependabot", 1): "exception"}
        assert plan.entries[0].reevaluate == "v2 が出たら"
        assert [(o.state, n.state) for o, n in plan.changed] == [("open", "exception")]

    def test_exception_alert_not_in_tracker_is_not_added(self) -> None:
        plan = plan_tracker({"dependabot": [_a("dependabot", 1)]}, [_exc(1)], [])

        assert plan.entries == []

    def test_exception_removed_from_file_returns_to_open(self) -> None:
        old = [_e("dependabot", 1, "exception")]
        plan = plan_tracker({"dependabot": [_a("dependabot", 1)]}, [], old)

        assert _states(plan) == {("dependabot", 1): "open"}

    def test_code_scanning_number_is_not_matched_to_dependabot_exception(self) -> None:
        plan = plan_tracker({"code-scanning": [_a("code-scanning", 1)]}, [_exc(1)], [])

        assert _states(plan) == {("code-scanning", 1): "open"}

    def test_row_leaving_the_list_is_refetched_then_becomes_result(self) -> None:
        old = [_e("dependabot", 1, "open"), _e("dependabot", 2, "exception")]
        first = plan_tracker({"dependabot": []}, [_exc(2)], old)

        assert first.refetch == [("dependabot", 1), ("dependabot", 2)]
        assert _states(first) == {("dependabot", 1): "open", ("dependabot", 2): "exception"}

        results = {
            ("dependabot", 1): ("fixed", None),
            ("dependabot", 2): ("dismissed", "tolerable_risk"),
        }
        second = plan_tracker({"dependabot": []}, [_exc(2)], old, results=results)  # type: ignore[arg-type]

        # 例外ファイルに残っていても、結果を優先する
        assert _states(second) == {("dependabot", 1): "fixed", ("dependabot", 2): "dismissed"}
        assert second.entries[1].reason == "tolerable_risk"
        assert second.entries[1].reevaluate is None

    def test_failed_refetch_keeps_row(self) -> None:
        old = [_e("code-scanning", 9, "open")]
        plan = plan_tracker({"code-scanning": []}, [], old, results={})

        assert _states(plan) == {("code-scanning", 9): "open"}
        assert plan.changed == []

    def test_result_row_is_not_refetched(self) -> None:
        old = [_e("dependabot", 1, "fixed")]
        plan = plan_tracker({"dependabot": []}, [], old)

        assert plan.refetch == []
        assert _states(plan) == {("dependabot", 1): "fixed"}

    def test_result_row_returning_to_open_list_becomes_open_or_exception(self) -> None:
        old = [_e("dependabot", 1, "fixed"), _e("dependabot", 2, "gone")]
        alerts = {"dependabot": [_a("dependabot", 1), _a("dependabot", 2)]}
        plan = plan_tracker(alerts, [_exc(2)], old)

        assert _states(plan) == {("dependabot", 1): "open", ("dependabot", 2): "exception"}

    def test_failed_kind_is_untouched_and_not_added(self) -> None:
        old = [_e("secret-scanning", 1, "open")]
        alerts = {"dependabot": [_a("dependabot", 5)]}
        plan = plan_tracker(alerts, [], old, failed_kinds={"secret-scanning", "code-scanning"})

        assert plan.refetch == []
        assert _states(plan) == {("secret-scanning", 1): "open", ("dependabot", 5): "open"}

    def test_failed_kind_does_not_decide_creation(self) -> None:
        plan = plan_tracker({}, [], None, failed_kinds={"dependabot"})

        assert plan.create is False

    def test_disabled_kind_is_untouched(self) -> None:
        old = [_e("code-scanning", 1, "open")]
        plan = plan_tracker({}, [], old, disabled_kinds={"code-scanning"})

        assert plan.refetch == []
        assert _states(plan) == {("code-scanning", 1): "open"}

    def test_second_run_is_a_noop(self) -> None:
        alerts = {"dependabot": [_a("dependabot", 1)], "code-scanning": [_a("code-scanning", 3)]}
        first = plan_tracker(alerts, [], [])
        second = plan_tracker(alerts, [], first.entries)

        assert second.added == [] and second.changed == [] and second.refetch == []
        assert second.entries == first.entries

    def test_entries_are_ordered_by_kind_then_number(self) -> None:
        alerts = {
            "secret-scanning": [_a("secret-scanning", 1)],
            "dependabot": [_a("dependabot", 10), _a("dependabot", 2)],
            "code-scanning": [_a("code-scanning", 5)],
        }
        plan = plan_tracker(alerts, [], [])

        assert [e.key for e in plan.entries] == [
            ("dependabot", 2),
            ("dependabot", 10),
            ("code-scanning", 5),
            ("secret-scanning", 1),
        ]

    def test_max_priority_uses_open_rows_only(self) -> None:
        entries = [
            _e("dependabot", 1, "open", priority="low"),
            _e("dependabot", 2, "open", priority="medium"),
            _e("dependabot", 3, "exception", priority="high"),
        ]
        assert max_priority(entries) == "medium"
        assert max_priority([]) is None


class TestAlertResult:
    def test_missing_alert(self) -> None:
        assert alert_result("dependabot", None) == ("gone", None)

    def test_fixed(self) -> None:
        assert alert_result("dependabot", {"state": "fixed"}) == ("fixed", None)

    def test_dismissed_reason_is_enum_only(self) -> None:
        raw = {
            "state": "dismissed",
            "dismissed_reason": "tolerable_risk",
            "dismissed_comment": "秘密",
        }
        assert alert_result("dependabot", raw) == ("dismissed", "tolerable_risk")

    def test_reason_with_spaces_is_made_an_enum_value(self) -> None:
        raw = {"state": "dismissed", "dismissed_reason": "won't fix"}
        assert alert_result("code-scanning", raw) == ("dismissed", "won_t_fix")

    def test_auto_dismissed(self) -> None:
        assert alert_result("dependabot", {"state": "auto_dismissed"}) == ("dismissed", None)

    def test_resolved_with_resolution(self) -> None:
        raw = {"state": "resolved", "resolution": "false_positive"}
        assert alert_result("secret-scanning", raw) == ("resolved", "false_positive")

    @pytest.mark.parametrize("state", ["open", "weird", None])
    def test_open_or_unknown_is_not_a_result(self, state: str | None) -> None:
        assert alert_result("dependabot", {"state": state}) is None


class TestTrackerBody:
    def _entries(self) -> list[TrackerEntry]:
        return [
            _e(
                "dependabot",
                1,
                "open",
                priority="high",
                package="@scope/left-pad",
                ghsa="GHSA-aaaa-bbbb-cccc",
            ),
            _e("dependabot", 2, "exception", package="pkg", reevaluate="a | b\nc"),
            _e("dependabot", 3, "dismissed", reason="tolerable_risk", package="a--b"),
            _e("code-scanning", 4, "fixed", priority="low"),
            _e("secret-scanning", 5, "gone"),
        ]

    def _render(self, entries: list[TrackerEntry], folded: int = 0, body: str | None = None) -> str:
        return render_tracker_body(entries, folded, H, OWNER, R, body)

    def test_roundtrip_keeps_state_priority_package_and_reason(self) -> None:
        entries = self._entries()
        parsed, folded = parse_tracker_entries(self._render(entries))

        assert folded == 0
        # reevaluate は印に入れず、読み戻さない
        assert parsed == [replace(e, reevaluate=None) for e in entries]

    def test_marker_has_no_double_hyphen_inside(self) -> None:
        body = self._render(self._entries())
        for m in re.finditer(r"<!-- pecot-alert: (.*?) -->", body):
            assert "--" not in m.group(1)

    def test_new_body_has_tracker_marker_table_and_guides_without_alert_details(self) -> None:
        body = self._render(self._entries())

        assert body.startswith("<!-- pecot-alert: tracker -->")
        assert body.count("<!-- pecot-alert: list-begin -->") == 1
        assert body.count("<!-- pecot-alert: list-end -->") == 1
        assert "[#1](https://github.com/o/r/security/dependabot/1)" in body
        assert "@scope/left-pad（GHSA-aaaa-bbbb-cccc）" in body
        assert "SECURITY.md#alert-dependabot" in body
        assert "SECURITY.md#alert-exceptions-review" in body

    def test_cell_escapes_pipe_and_newline(self) -> None:
        body = self._render(self._entries())

        assert "例外（見直し: a \\| b c）" in body

    def test_reevaluate_cannot_forge_markers(self) -> None:
        entry = _e("dependabot", 2, "exception", reevaluate="<!-- pecot-alert: list-end -->")
        body = self._render([entry])
        parsed, _ = parse_tracker_entries(body)

        assert [e.key for e in parsed] == [("dependabot", 2)]
        assert body.count("<!-- pecot-alert: list-end -->") == 1

    def test_text_outside_the_table_is_kept(self) -> None:
        existing = self._render([_e("dependabot", 1)])
        edited = existing.replace("手順:", "人が足した文\n\n手順:")
        out = self._render([_e("dependabot", 1), _e("dependabot", 2)], body=edited)

        assert "人が足した文" in out
        assert out.count("pecot-alert: dependabot/") == 2

    def test_rows_added_by_hand_are_dropped(self) -> None:
        existing = self._render([_e("dependabot", 1)])
        edited = existing.replace(
            "<!-- pecot-alert: list-end -->", "| 手で足した行 | x |\n<!-- pecot-alert: list-end -->"
        )
        out = self._render([_e("dependabot", 1)], body=edited)

        assert "手で足した行" not in out

    def test_crlf_body_is_normalized(self) -> None:
        existing = self._render([_e("dependabot", 1)])
        crlf = existing.replace("\n", "\r\n")
        entries, _ = parse_tracker_entries(crlf)

        assert [e.key for e in entries] == [("dependabot", 1)]
        assert "\r" not in self._render(entries, body=crlf)
        assert self._render(entries, body=crlf) == existing

    @pytest.mark.parametrize(
        "mutate",
        [
            lambda b: b.replace("<!-- pecot-alert: list-begin -->", ""),
            lambda b: b.replace("<!-- pecot-alert: list-end -->", ""),
            lambda b: b + "\n<!-- pecot-alert: list-end -->",
            lambda b: b + "\n<!-- pecot-alert: list-begin -->",
            lambda b: (
                b.replace("list-begin", "TMP")
                .replace("list-end", "list-begin")
                .replace("TMP", "list-end")
            ),
        ],
        ids=["no-begin", "no-end", "two-ends", "two-begins", "reversed"],
    )
    def test_broken_marker_pairs_are_errors(self, mutate: Any) -> None:
        broken = mutate(self._render([_e("dependabot", 1)]))

        with pytest.raises(SecurityAlertError):
            parse_tracker_entries(broken)
        with pytest.raises(SecurityAlertError):
            self._render([], body=broken)

    def test_oversized_body_folds_oldest_results(self) -> None:
        entries = [_e("dependabot", n, "fixed", package="p" * 200) for n in range(1, 400)]
        entries.append(_e("code-scanning", 1, "open"))
        body = self._render(entries)

        assert len(body) < BODY_LIMIT
        parsed, folded = parse_tracker_entries(body)
        assert folded > 0
        assert len(parsed) + folded == 400
        # 要判断の行は畳まない。古い結果から畳む
        assert ("code-scanning", 1) in {e.key for e in parsed}
        assert ("dependabot", 1) not in {e.key for e in parsed}
        assert "ほか" in body

    def test_fold_count_accumulates_over_runs(self) -> None:
        body = self._render([_e("dependabot", 1)], folded=3)
        parsed, folded = parse_tracker_entries(body)

        assert folded == 3
        assert self._render(parsed, folded, body) == body

    def test_title_uses_utc_date(self) -> None:
        assert (
            build_tracker_title(date(2026, 11, 6)) == "[Tracker] security alert — 2026-11-06 から"
        )


class TestFindTracker:
    def _issue(
        self, number: int, state: str = "open", body: str = "<!-- pecot-alert: tracker -->"
    ) -> dict[str, Any]:
        return {"number": number, "state": state, "body": body}

    def test_none(self) -> None:
        assert find_tracker([]) == (None, [])
        assert find_tracker([self._issue(1, body="関係ない")]) == (None, [])

    def test_closed_tracker_is_ignored(self) -> None:
        assert find_tracker([self._issue(1, "closed")]) == (None, [])

    def test_picks_smallest_open_number_and_reports_others(self) -> None:
        found, others = find_tracker([self._issue(9), self._issue(4), self._issue(6, "closed")])

        assert found is not None and found["number"] == 4
        assert others == [9]


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
