"""tests/core/test_security_alerts.py - security alert の形そろえ・突き合わせ・本文のテスト

GitHubClient は I/O 境界として差し替える。
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from cli.core.github import GitHubAPIError, GitHubNotFoundError, GitHubRateLimitError
from cli.core.security_alerts import (
    TRACKER_RE,
    Alert,
    SecurityAlertError,
    TrackerEntry,
    build_tracker_title,
    fetch_code_scanning_status,
    fetch_secret_scanning_status,
    list_open_alerts,
    max_priority,
    normalize_code_scanning,
    normalize_dependabot,
    normalize_secret_scanning,
    parse_tracker_entries,
    plan_tracker,
    render_tracker_body,
)
from cli.core.tracker_body import find_tracker as _find_tracker

H, OWNER, R = "github.com", "o", "r"


def _dep(number: int = 7, severity: str | None = "high") -> dict[str, Any]:
    return {
        "number": number,
        "html_url": f"https://github.com/o/r/security/dependabot/{number}",
        "security_vulnerability": {"severity": severity},
        "security_advisory": {
            "ghsa_id": "GHSA-aaaa-bbbb-cccc",
            "severity": "low",
            "summary": "Prototype Pollution in left-pad",
        },
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
            summary="Prototype Pollution in left-pad",
        )

    @pytest.mark.parametrize("ghsa", ["not-a-ghsa", "GHSA-AAAA-bbbb-cccc", "GHSA-aaaa-bbbb"])
    def test_invalid_ghsa_is_dropped(self, ghsa: str) -> None:
        raw = _dep()
        raw["security_advisory"]["ghsa_id"] = ghsa
        alert = normalize_dependabot(raw, H, OWNER, R)

        assert alert is not None
        assert alert.ghsa is None

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


def _e(kind: str, number: int, **kw: Any) -> TrackerEntry:
    return TrackerEntry(kind=kind, number=number, **kw)  # type: ignore[arg-type]


def _keys(plan: Any) -> list[tuple[str, int]]:
    return [e.key for e in plan.entries]


class TestPlanTracker:
    def test_no_tracker_creates_with_open_alerts(self) -> None:
        alerts = {"dependabot": [_a("dependabot", 1), _a("dependabot", 2)]}
        plan = plan_tracker(alerts, None)

        assert plan.create is True
        assert _keys(plan) == [("dependabot", 1), ("dependabot", 2)]

    def test_no_tracker_and_no_open_alerts_does_not_create(self) -> None:
        plan = plan_tracker({}, None)

        assert plan.create is False
        assert plan.entries == []

    def test_existing_tracker_never_creates(self) -> None:
        plan = plan_tracker({"dependabot": [_a("dependabot", 1)]}, [])

        assert plan.create is False
        assert [e.number for e in plan.added] == [1]

    def test_alert_that_is_no_longer_open_is_removed(self) -> None:
        old = [_e("dependabot", 1), _e("dependabot", 2)]
        plan = plan_tracker({"dependabot": [_a("dependabot", 2)]}, old)

        assert _keys(plan) == [("dependabot", 2)]
        assert [e.key for e in plan.removed] == [("dependabot", 1)]
        assert plan.added == []

    def test_new_values_win_and_only_missing_ones_fall_back_to_the_old_row(self) -> None:
        old = [_e("dependabot", 1, priority="low", package="old", ghsa="GHSA-aaaa-bbbb-cccc")]
        alerts = {"dependabot": [_a("dependabot", 1, "high", "new")]}
        plan = plan_tracker(alerts, old)

        assert plan.entries[0].priority == "high"
        assert plan.entries[0].package == "new"
        assert plan.entries[0].ghsa == "GHSA-aaaa-bbbb-cccc"

    def test_failed_kind_is_untouched_and_not_added(self) -> None:
        old = [_e("secret-scanning", 1)]
        alerts = {"dependabot": [_a("dependabot", 5)]}
        plan = plan_tracker(alerts, old, failed_kinds={"secret-scanning", "code-scanning"})

        assert _keys(plan) == [("dependabot", 5), ("secret-scanning", 1)]
        assert plan.removed == []

    def test_failed_kind_does_not_decide_creation(self) -> None:
        plan = plan_tracker({}, None, failed_kinds={"dependabot"})

        assert plan.create is False

    def test_disabled_kind_has_no_rows_and_is_not_added(self) -> None:
        old = [_e("code-scanning", 1), _e("dependabot", 2)]
        plan = plan_tracker(
            {"dependabot": [_a("dependabot", 2)]}, old, disabled_kinds={"code-scanning"}
        )

        assert _keys(plan) == [("dependabot", 2)]
        assert [e.key for e in plan.removed] == [("code-scanning", 1)]

    def test_second_run_is_a_noop(self) -> None:
        alerts = {"dependabot": [_a("dependabot", 1)], "code-scanning": [_a("code-scanning", 3)]}
        first = plan_tracker(alerts, [])
        second = plan_tracker(alerts, first.entries)

        assert second.added == [] and second.removed == []
        assert second.entries == first.entries

    def test_entries_are_ordered_by_kind_then_number(self) -> None:
        alerts = {
            "secret-scanning": [_a("secret-scanning", 1)],
            "dependabot": [_a("dependabot", 10), _a("dependabot", 2)],
            "code-scanning": [_a("code-scanning", 5)],
        }
        plan = plan_tracker(alerts, [])

        assert _keys(plan) == [
            ("dependabot", 2),
            ("dependabot", 10),
            ("code-scanning", 5),
            ("secret-scanning", 1),
        ]

    def test_max_priority_is_the_maximum_of_all_rows(self) -> None:
        entries = [
            _e("dependabot", 1, priority="low"),
            _e("dependabot", 2, priority="high"),
            _e("dependabot", 3, priority="medium"),
        ]
        assert max_priority(entries) == "high"
        assert max_priority([]) is None


class TestTrackerBody:
    def _entries(self) -> list[TrackerEntry]:
        return [
            _e(
                "dependabot",
                1,
                priority="high",
                package="@scope/left-pad",
                ghsa="GHSA-aaaa-bbbb-cccc",
                summary="Pollution -- in | [x] <b>\nnext",
            ),
            _e("dependabot", 3, package="a--b"),
            _e("code-scanning", 4, priority="low"),
            _e("secret-scanning", 5, priority="high"),
        ]

    def _render(
        self,
        entries: list[TrackerEntry],
        body: str | None = None,
        failed_kinds: frozenset[Any] | set[Any] = frozenset(),
    ) -> str:
        return render_tracker_body(entries, H, OWNER, R, body, failed_kinds=failed_kinds)

    def test_roundtrip_keeps_priority_package_and_ghsa(self) -> None:
        entries = self._entries()

        assert parse_tracker_entries(self._render(entries)) == entries

    def test_marker_has_no_state_and_no_double_hyphen_inside(self) -> None:
        body = self._render(self._entries())
        markers = re.findall(r"<!-- pecot-alert: (.*?) -->", body)

        assert any(m.startswith("dependabot/1 priority=high") for m in markers)
        for m in markers:
            assert "--" not in m
            assert "state=" not in m

    def test_new_body_is_marker_and_sections_only(self) -> None:
        body = self._render(self._entries())

        assert body.startswith(
            "<!-- pecot-alert: tracker -->\n\n<!-- pecot-alert: list-begin -->\n## Dependabot\n\n"
        )
        assert body.endswith("<!-- pecot-alert: list-end -->\n")
        assert body.index("## Dependabot") < body.index("## code scanning")
        assert body.index("## code scanning") < body.index("## secret scanning")
        assert "| title | alert | Priority |\n|---|---|---|\n" in body
        assert body.count("| title | alert | Priority |") == 3
        assert "[#1](https://github.com/o/r/security/dependabot/1)" in body
        assert "(https://github.com/advisories/GHSA-aaaa-bbbb-cccc) | [#1](" in body
        assert "--> a--b |" in body
        assert "SECURITY.md" not in body
        assert "状態" not in body
        assert "## code scanning\n\n| title | alert | Priority |" in body
        assert "## secret scanning\n\n| title" in body
        # 印・見出し・表の行だけ。説明の文は無い
        for line in body.split("\n"):
            assert line == "" or line.startswith(("<!--", "## ", "|"))

    def test_code_scanning_row_has_masked_title_and_priority(self) -> None:
        body = self._render([_e("code-scanning", 4, priority="low")])

        assert "| <!-- pecot-alert: code-scanning/4 priority=low --> masked | [#4](" in body
        assert body.count("| low |") == 1
        assert parse_tracker_entries(body) == [_e("code-scanning", 4, priority="low")]

    def test_secret_scanning_title_is_masked(self) -> None:
        body = self._render([_e("secret-scanning", 5, priority="high")])

        assert "| <!-- pecot-alert: secret-scanning/5 priority=high --> masked | [#5](" in body

    def test_empty_kinds_show_none(self) -> None:
        body = self._render([])

        for label in ("Dependabot", "code scanning", "secret scanning"):
            assert f"## {label}\n\nnone" in body
        assert "|" not in body
        assert parse_tracker_entries(body) == []

    def test_disabled_kind_is_a_heading_only(self) -> None:
        body = render_tracker_body(
            [_e("dependabot", 1)], H, OWNER, R, disabled_kinds={"code-scanning"}
        )

        assert "## code scanning\n\ndisabled\n\n## secret scanning\n\nnone" in body
        assert "## Dependabot\n\n| title" in body

    def test_headings_and_none_lines_are_not_parsed_as_rows(self) -> None:
        entries = self._entries()
        body = self._render(entries)

        assert parse_tracker_entries(body) == entries

    def test_same_advisory_is_one_row_with_all_alerts(self) -> None:
        g = "GHSA-aaaa-bbbb-cccc"
        entries = [
            _e("dependabot", 13, priority="medium", ghsa=g, summary="minimatch DoS"),
            _e("dependabot", 9, priority="high", ghsa=g, summary="minimatch DoS"),
            _e("dependabot", 1, priority="low", ghsa="GHSA-dddd-eeee-ffff", summary="Glob"),
        ]
        body = self._render(entries)

        assert "## Dependabot\n\n| title" in body
        assert "件" not in body
        rows = [ln for ln in body.split("\n") if ln.startswith("| <!--")]
        assert len(rows) == 2
        # 並びは Priority の高い順。Priority は束ねた alert の最大
        assert rows[0].endswith(
            "[minimatch DoS](https://github.com/advisories/GHSA-aaaa-bbbb-cccc)"
            " | [#9](https://github.com/o/r/security/dependabot/9)"
            " [#13](https://github.com/o/r/security/dependabot/13) | high |"
        )
        assert rows[1].endswith("| low |")
        assert rows[0].count("<!-- pecot-alert: dependabot/") == 2
        assert parse_tracker_entries(body) == sorted(entries, key=lambda e: e.number)

    def test_rows_with_equal_priority_are_ordered_by_first_alert(self) -> None:
        entries = [
            _e("dependabot", 5, ghsa="GHSA-aaaa-bbbb-cccc"),
            _e("dependabot", 2, ghsa="GHSA-dddd-eeee-ffff"),
        ]
        body = self._render(entries)

        assert body.index("dependabot/2 ") < body.index("dependabot/5 ")

    def test_content_falls_back_to_ghsa_then_package(self) -> None:
        body = self._render(
            [
                _e("dependabot", 1, ghsa="GHSA-aaaa-bbbb-cccc"),
                _e("dependabot", 2, package="pkg"),
                _e("dependabot", 3, package="pkg"),
            ]
        )

        assert "[GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc)" in body
        # GHSA の無い alert は束ねない
        assert body.count("--> pkg |") == 2

    def test_advisory_link_uses_the_given_host(self) -> None:
        body = render_tracker_body(
            [_e("dependabot", 1, ghsa="GHSA-aaaa-bbbb-cccc", summary="s")],
            "ghes.example.com",
            OWNER,
            R,
        )

        assert "(https://ghes.example.com/advisories/GHSA-aaaa-bbbb-cccc)" in body

    def test_summary_roundtrips_and_cannot_forge_markers(self) -> None:
        entry = _e(
            "dependabot",
            1,
            ghsa="GHSA-aaaa-bbbb-cccc",
            summary="a -- b | c --> <!-- pecot-alert: list-end --> d",
        )
        body = self._render([entry])

        assert body.count("<!-- pecot-alert: list-end -->") == 1
        for m in re.finditer(r"<!-- pecot-alert: (.*?) -->", body):
            assert "--" not in m.group(1)
        assert parse_tracker_entries(body) == [entry]

    def test_failed_kind_rows_keep_summary_of_every_alert_in_a_bundle(self) -> None:
        g = "GHSA-aaaa-bbbb-cccc"
        first = self._render(
            [
                _e("dependabot", 1, ghsa=g, summary="Glob | x"),
                _e("dependabot", 5, ghsa=g, summary="Glob | x"),
            ]
        )
        # summary は束の先頭の alert の印にだけ付く
        assert first.count("sum=") == 1
        old = parse_tracker_entries(first)
        assert [e.summary for e in old] == ["Glob | x", "Glob | x"]

        plan = plan_tracker({}, old, failed_kinds={"dependabot"})
        again = self._render(plan.entries, failed_kinds={"dependabot"})

        assert plan.entries == old
        assert again == first
        assert "Glob \\| x" in again

    def test_failed_kind_without_old_rows_is_unavailable(self) -> None:
        plan = plan_tracker({}, [], failed_kinds={"code-scanning"})
        body = self._render(plan.entries, failed_kinds={"code-scanning"})

        assert "## code scanning\n\nunavailable" in body
        assert "## Dependabot\n\nnone" in body

    def test_failed_kind_that_was_disabled_is_unavailable(self) -> None:
        before = render_tracker_body([], H, OWNER, R, disabled_kinds={"secret-scanning"})
        old = parse_tracker_entries(before)
        plan = plan_tracker({}, old, failed_kinds={"secret-scanning"})
        after = self._render(plan.entries, before, failed_kinds={"secret-scanning"})

        assert "## secret scanning\n\ndisabled" in before
        assert "## secret scanning\n\nunavailable" in after

    def test_failed_kind_with_old_rows_keeps_the_table(self) -> None:
        body = self._render([_e("code-scanning", 3)], failed_kinds={"code-scanning"})

        assert "unavailable" not in body
        assert "pecot-alert: code-scanning/3" in body

    def test_non_dependabot_rows_are_ordered_by_priority_then_number(self) -> None:
        entries = [
            _e("code-scanning", 1, priority="low"),
            _e("code-scanning", 7, priority="high"),
            _e("code-scanning", 3, priority="high"),
            _e("secret-scanning", 2, priority="medium"),
            _e("secret-scanning", 1, priority="high"),
        ]
        body = self._render(entries)

        cs = [int(n) for n in re.findall(r"code-scanning/(\d+) ", body)]
        ss = [int(n) for n in re.findall(r"secret-scanning/(\d+) ", body)]
        assert cs == [3, 7, 1]
        assert ss == [1, 2]

    def test_title_with_brackets_backslash_and_pipe_stays_in_one_link(self) -> None:
        entry = _e("dependabot", 1, ghsa="GHSA-aaaa-bbbb-cccc", summary="a ] b [ c \\ d | e \\| f")
        body = self._render([entry])
        row = next(ln for ln in body.split("\n") if "dependabot/1 " in ln)

        assert (
            "[a \\] b \\[ c \\\\ d \\| e \\\\\\| f]"
            "(https://github.com/advisories/GHSA-aaaa-bbbb-cccc)"
        ) in row
        assert parse_tracker_entries(body) == [entry]

    def test_advisory_row_shrinks_when_one_alert_leaves_the_open_list(self) -> None:
        g = "GHSA-aaaa-bbbb-cccc"
        alerts = {
            "dependabot": [
                Alert("dependabot", 1, "medium", "u", "glob", g, "Glob"),
                Alert("dependabot", 5, "medium", "u", "glob", g, "Glob"),
                Alert("dependabot", 9, "medium", "u", "glob", g, "Glob"),
            ]
        }
        before = plan_tracker(alerts, [])
        remaining = {"dependabot": [a for a in alerts["dependabot"] if a.number != 1]}
        plan = plan_tracker(remaining, before.entries)
        body = self._render(plan.entries)

        assert [e.number for e in plan.removed] == [1]
        rows = [ln for ln in body.split("\n") if ln.startswith("| <!--")]
        assert len(rows) == 1
        assert "dependabot/1 " not in rows[0]
        assert "[#5](" in rows[0] and "[#9](" in rows[0]
        assert "[Glob](https://github.com/advisories/GHSA-aaaa-bbbb-cccc)" in rows[0]

    def test_text_outside_the_table_is_kept(self) -> None:
        existing = self._render([_e("dependabot", 1)])
        edited = existing.replace(
            "<!-- pecot-alert: list-begin -->", "人が足した文\n\n<!-- pecot-alert: list-begin -->"
        )
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
        entries = parse_tracker_entries(crlf)

        assert [e.key for e in entries] == [("dependabot", 1)]
        assert "\r" not in self._render(entries, body=crlf)
        assert self._render(entries, body=crlf) == existing

    def test_old_open_marker_is_read(self) -> None:
        body = self._render([])
        row = (
            "| <!-- pecot-alert: dependabot/7 state=open priority=high pkg=left%2Dpad"
            " ghsa=GHSA-aaaa-bbbb-cccc --> Dependabot | [#7](u) | high | left-pad | 要判断 |"
        )
        old = body.replace(
            "<!-- pecot-alert: list-end -->", row + "\n<!-- pecot-alert: list-end -->"
        )

        assert parse_tracker_entries(old) == [
            _e("dependabot", 7, priority="high", package="left-pad", ghsa="GHSA-aaaa-bbbb-cccc")
        ]

    @pytest.mark.parametrize(
        "marker",
        [
            "dependabot/7 state=exception priority=high",
            "dependabot/7 state=fixed priority=high",
            "dependabot/7 state=dismissed priority=high reason=tolerable_risk",
            "dependabot/7 state=gone priority=high",
            "folded count=3",
        ],
    )
    def test_old_non_open_and_folded_markers_are_discarded(self, marker: str) -> None:
        body = self._render([])
        row = f"| <!-- pecot-alert: {marker} --> x | | | | |"
        old = body.replace(
            "<!-- pecot-alert: list-end -->", row + "\n<!-- pecot-alert: list-end -->"
        )

        assert parse_tracker_entries(old) == []
        # 読み捨てた行は、書き直しで表から消える
        assert "pecot-alert: dependabot/7" not in self._render([], body=old)
        assert "folded" not in self._render([], body=old)

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

    def test_title_uses_utc_date(self) -> None:
        assert build_tracker_title(date(2026, 11, 6)) == "[Tracker] security alert — 2026-11-06"


def find_tracker(issues: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, list[int]]:
    return _find_tracker(issues, TRACKER_RE)


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
