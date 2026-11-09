"""tests/core/test_dependabot_prs.py - dependabot の PR の待ち状態の判定と Tracker の本文のテスト

純粋関数なので、モックは使わない。
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest

from cli.core.dependabot_prs import (
    LIST_BEGIN,
    LIST_END,
    DependabotPrError,
    PrEntry,
    build_tracker_title,
    parse_tracker_pr_numbers,
    parse_update_metadata,
    plan_tracker,
    render_tracker_body,
    waiting_reasons,
)
from cli.tests._dependabot_tracker_body import OLD_FORM_BODY

NOW = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)


def _iso(delta: timedelta) -> str:
    return (NOW - delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def _message(*deps: tuple[str, str | None]) -> str:
    lines = ["Bump x", "", "---", "updated-dependencies:"]
    for name, kind in deps:
        lines.append(f'- dependency-name: "{name}"')
        lines.append("  dependency-type: direct:development")
        if kind:
            lines.append(f"  update-type: version-update:semver-{kind}")
    return "\n".join([*lines, "...", "", "Signed-off-by: dependabot[bot] <support@github.com>"])


def _last(kind: str, events: list[tuple[str, timedelta]] | None) -> dict[str, Any]:
    times = [d for k, d in events or [] if k == kind]
    return {"nodes": [{"createdAt": _iso(min(times))}] if times else []}


def _pr(
    *,
    deps: tuple[tuple[str, str | None], ...] = (("left-pad", "minor"),),
    message: str | None = None,
    signature: dict[str, bool] | None = {"isValid": True},  # noqa: B006
    commit_author: str | None = "dependabot[bot]",
    age: timedelta = timedelta(hours=2),
    auto_merge: bool = True,
    queue: bool = False,
    rollup: str | None = "SUCCESS",
    mergeable: str = "MERGEABLE",
    base_age: timedelta = timedelta(days=3),
    events: list[tuple[str, timedelta]] | None = None,
    number: int = 7,
) -> dict[str, Any]:
    return {
        "number": number,
        "title": "Bump left-pad",
        "url": f"https://github.com/o/r/pull/{number}",
        "createdAt": _iso(age),
        "author": {"__typename": "Bot", "login": "dependabot"},
        "isInMergeQueue": queue,
        "autoMergeRequest": {"enabledAt": _iso(age)} if auto_merge else None,
        "mergeable": mergeable,
        "baseRef": {"target": {"committedDate": _iso(base_age)}},
        "firstCommits": {
            "nodes": [
                {
                    "commit": {
                        "message": message if message is not None else _message(*deps),
                        "signature": signature,
                        "author": {"user": {"login": commit_author} if commit_author else None},
                    }
                }
            ]
        },
        "headCommits": {
            "nodes": [{"commit": {"statusCheckRollup": {"state": rollup} if rollup else None}}]
        },
        # 種類ごとに別名で最後の 1 件を取る（queries.py の lastForcePush・lastDequeue）
        "lastForcePush": _last("HeadRefForcePushedEvent", events),
        "lastDequeue": _last("RemovedFromMergeQueueEvent", events),
    }


class TestParseUpdateMetadata:
    def test_single_dependency(self) -> None:
        assert parse_update_metadata(_message(("a", "minor"))) == [("a", "minor")]

    def test_group_keeps_each_dependency(self) -> None:
        got = parse_update_metadata(_message(("a", "patch"), ("b", "major")))
        assert got == [("a", "patch"), ("b", "major")]

    def test_missing_update_type_is_computed_from_group_message(self) -> None:
        message = _message(("a", None), ("b", None)).replace(
            "Signed-off-by",
            "Updates `a` from 1.2.3 to 2.0.0\nUpdates `b` from v1.2.3 to v1.3.0\nSigned-off-by",
        )
        assert parse_update_metadata(message) == [("a", "major"), ("b", "minor")]

    def test_missing_update_type_is_computed_from_bumps_line(self) -> None:
        message = "Bumps [a](https://x) from 1.2.3 to 1.2.4.\n\n" + _message(("a", None))
        assert parse_update_metadata(message) == [("a", "patch")]

    def test_bumps_line_applies_to_the_first_dependency_only(self) -> None:
        message = "Bumps [a](https://x) from 1.2.3 to 2.0.0.\n\n" + _message(
            ("a", None), ("b", None)
        )
        assert parse_update_metadata(message) == [("a", "major"), ("b", None)]

    def test_dependency_version_in_yaml_is_the_new_version(self) -> None:
        message = "Bumps [a](https://x) from 1.2.3 to 1.2.4.\n\n" + _message(("a", None)).replace(
            "  dependency-type", "  dependency-version: 1.3.0\n  dependency-type"
        )
        assert parse_update_metadata(message) == [("a", "minor")]

    def test_updates_line_must_fill_the_line(self) -> None:
        message = _message(("a", None)).replace(
            "Signed-off-by", "see Updates `a` from 1.0.0 to 2.0.0 here\nSigned-off-by"
        )
        assert parse_update_metadata(message) == [("a", None)]

    @pytest.mark.parametrize(
        ("old", "new", "expected"),
        [
            ("1.2.3", "1.2.3", None),
            ("1.2.3", "1.2.4", "patch"),
            ("1.2.3", "1.3.0", "minor"),
            ("1.2.3", "2.0.0", "major"),
            ("1", "1.0", "minor"),
            ("1.0.0-beta.1", "1.0.0", "patch"),
        ],
    )
    def test_version_type_matches_fetch_metadata(
        self, old: str, new: str, expected: str | None
    ) -> None:
        message = f"Bumps [a](https://x) from {old} to {new}.\n\n" + _message(("a", None))
        assert parse_update_metadata(message) == [("a", expected)]

    def test_missing_update_type_and_no_versions_is_none_type(self) -> None:
        assert parse_update_metadata(_message(("a", None))) == [("a", None)]

    def test_no_yaml_is_none(self) -> None:
        assert parse_update_metadata("Bump a from 1 to 2\n\nplain message") is None

    def test_broken_yaml_is_none(self) -> None:
        assert parse_update_metadata("x\n\n---\nupdated-dependencies: [\n...\n") is None


class TestWaitingReasonsMetadata:
    def test_minor_in_good_state_is_not_listed(self) -> None:
        assert waiting_reasons(_pr(), NOW) == []

    def test_major(self) -> None:
        assert waiting_reasons(_pr(deps=(("a", "major"),)), NOW) == ["major"]

    def test_group_with_major_is_major(self) -> None:
        assert waiting_reasons(_pr(deps=(("a", "patch"), ("b", "major"))), NOW) == ["major"]

    def test_playwright_minor(self) -> None:
        pr = _pr(deps=(("@Playwright/test", "minor"),))
        assert waiting_reasons(pr, NOW) == ["playwright"]

    def test_playwright_major_lists_both(self) -> None:
        pr = _pr(deps=(("playwright", "major"),))
        assert waiting_reasons(pr, NOW) == ["major", "playwright"]

    def test_first_commit_not_by_dependabot_is_unknown(self) -> None:
        assert waiting_reasons(_pr(commit_author="someone"), NOW) == ["update-type 不明"]
        assert waiting_reasons(_pr(commit_author=None), NOW) == ["update-type 不明"]

    def test_no_type_at_all_is_unknown(self) -> None:
        assert waiting_reasons(_pr(deps=(("a", None),)), NOW) == ["update-type 不明"]

    @pytest.mark.parametrize("signature", [{"isValid": False}, {}, None])
    def test_first_commit_without_valid_signature_is_unknown(
        self, signature: dict[str, bool] | None
    ) -> None:
        assert waiting_reasons(_pr(signature=signature), NOW) == ["update-type 不明"]

    def test_unquoted_scoped_name_in_yaml_is_unknown(self) -> None:
        message = (
            "Bump x\n\n---\nupdated-dependencies:\n- dependency-name: @scope/x\n"
            "  update-type: version-update:semver-minor\n...\n"
        )
        assert waiting_reasons(_pr(message=message), NOW) == ["update-type 不明"]

    def test_non_target_pr_ignores_state_reasons(self) -> None:
        pr = _pr(deps=(("a", "major"),), rollup="FAILURE", mergeable="CONFLICTING")
        assert waiting_reasons(pr, NOW) == ["major"]


class TestWaitingReasonsState:
    def test_failed_checks(self) -> None:
        assert waiting_reasons(_pr(rollup="FAILURE"), NOW) == ["検証が落ちた"]
        assert waiting_reasons(_pr(rollup="ERROR"), NOW) == ["検証が落ちた"]

    def test_pending_within_24h_is_not_listed(self) -> None:
        pr = _pr(rollup="PENDING", age=timedelta(hours=23))
        assert waiting_reasons(pr, NOW) == []

    @pytest.mark.parametrize("rollup", ["PENDING", "EXPECTED", None])
    def test_not_finishing_after_24h(self, rollup: str | None) -> None:
        pr = _pr(rollup=rollup, age=timedelta(hours=25))
        assert waiting_reasons(pr, NOW) == ["検証が終わらない"]

    @pytest.mark.parametrize(
        ("age", "expected"),
        [
            (timedelta(hours=24), []),
            (timedelta(hours=24, seconds=1), ["検証が終わらない"]),
        ],
    )
    def test_checks_timeout_boundary(self, age: timedelta, expected: list[str]) -> None:
        assert waiting_reasons(_pr(rollup="PENDING", age=age), NOW) == expected

    def test_not_finishing_applies_only_with_auto_merge(self) -> None:
        pr = _pr(auto_merge=False, rollup="PENDING", age=timedelta(hours=25))
        assert waiting_reasons(pr, NOW) == ["auto-merge が入っていない"]

    @pytest.mark.parametrize(
        ("age", "expected"),
        [
            (timedelta(minutes=30), []),
            (timedelta(minutes=30, seconds=1), ["auto-merge が入っていない"]),
        ],
    )
    def test_no_auto_merge_grace_boundary(self, age: timedelta, expected: list[str]) -> None:
        assert waiting_reasons(_pr(auto_merge=False, age=age), NOW) == expected

    @pytest.mark.parametrize(
        ("base_age", "expected"),
        [
            (timedelta(minutes=30), []),
            (timedelta(minutes=30, seconds=1), ["競合"]),
        ],
    )
    def test_conflict_grace_boundary_after_base_moved(
        self, base_age: timedelta, expected: list[str]
    ) -> None:
        pr = _pr(mergeable="CONFLICTING", age=timedelta(hours=2), base_age=base_age)
        assert waiting_reasons(pr, NOW) == expected

    @pytest.mark.parametrize(
        ("age", "expected"),
        [(timedelta(minutes=30), []), (timedelta(minutes=30, seconds=1), ["競合"])],
    )
    def test_conflict_grace_boundary_after_push(self, age: timedelta, expected: list[str]) -> None:
        assert waiting_reasons(_pr(mergeable="CONFLICTING", age=age), NOW) == expected

    def test_dequeue_before_rebase_inside_grace_is_not_listed(self) -> None:
        pr = _pr(
            auto_merge=False,
            age=timedelta(hours=5),
            events=[
                ("RemovedFromMergeQueueEvent", timedelta(hours=4)),
                ("HeadRefForcePushedEvent", timedelta(minutes=10)),
            ],
        )
        assert waiting_reasons(pr, NOW) == []

    def test_old_dequeue_with_auto_merge_back_is_not_listed(self) -> None:
        pr = _pr(
            auto_merge=True,
            age=timedelta(hours=5),
            events=[
                ("RemovedFromMergeQueueEvent", timedelta(hours=4)),
                ("HeadRefForcePushedEvent", timedelta(hours=1)),
            ],
        )
        assert waiting_reasons(pr, NOW) == []

    def test_force_push_resets_the_24h_clock(self) -> None:
        pr = _pr(
            rollup="PENDING",
            age=timedelta(days=3),
            events=[("HeadRefForcePushedEvent", timedelta(hours=1))],
        )
        assert waiting_reasons(pr, NOW) == []

    def test_conflict_inside_grace_is_not_listed(self) -> None:
        pr = _pr(mergeable="CONFLICTING", age=timedelta(minutes=10))
        assert waiting_reasons(pr, NOW) == []

    def test_conflict_after_grace(self) -> None:
        pr = _pr(mergeable="CONFLICTING", age=timedelta(hours=2))
        assert waiting_reasons(pr, NOW) == ["競合"]

    def test_conflict_right_after_base_moved_is_not_listed(self) -> None:
        pr = _pr(mergeable="CONFLICTING", age=timedelta(hours=2), base_age=timedelta(minutes=5))
        assert waiting_reasons(pr, NOW) == []

    def test_unknown_mergeable_is_not_a_reason(self) -> None:
        assert waiting_reasons(_pr(mergeable="UNKNOWN", age=timedelta(hours=2)), NOW) == []

    def test_dequeued_after_last_push(self) -> None:
        pr = _pr(
            auto_merge=False,
            events=[("RemovedFromMergeQueueEvent", timedelta(minutes=5))],
            age=timedelta(hours=2),
        )
        assert waiting_reasons(pr, NOW) == ["queue から外れた"]

    def test_old_dequeue_before_rebase_falls_through_to_no_auto_merge(self) -> None:
        pr = _pr(
            auto_merge=False,
            age=timedelta(hours=5),
            events=[
                ("RemovedFromMergeQueueEvent", timedelta(hours=4)),
                ("HeadRefForcePushedEvent", timedelta(hours=1)),
            ],
        )
        assert waiting_reasons(pr, NOW) == ["auto-merge が入っていない"]

    def test_no_auto_merge_inside_grace_is_not_listed(self) -> None:
        pr = _pr(auto_merge=False, age=timedelta(minutes=10), rollup=None)
        assert waiting_reasons(pr, NOW) == []

    def test_no_auto_merge_after_grace(self) -> None:
        pr = _pr(auto_merge=False, age=timedelta(hours=1))
        assert waiting_reasons(pr, NOW) == ["auto-merge が入っていない"]

    def test_in_merge_queue_is_not_listed(self) -> None:
        pr = _pr(auto_merge=False, queue=True, age=timedelta(hours=1))
        assert waiting_reasons(pr, NOW) == []

    def test_failed_and_conflict_are_both_listed(self) -> None:
        pr = _pr(rollup="FAILURE", mergeable="CONFLICTING", age=timedelta(hours=2))
        assert waiting_reasons(pr, NOW) == ["検証が落ちた", "競合"]


def _entry(number: int, title: str = "Bump a", *reasons: str) -> PrEntry:
    return PrEntry(
        number=number,
        title=title,
        url=f"https://github.com/o/r/pull/{number}",
        reasons=reasons or ("major",),
    )


class TestTrackerBody:
    def test_new_body_has_markers_and_table(self) -> None:
        body = render_tracker_body([_entry(2, "Bump a", "major", "playwright")])
        assert body == (
            "<!-- pecot-dependabot-pr: tracker -->\n\n"
            "<!-- pecot-dependabot-pr: list-begin -->\n"
            "| title | PR | reason |\n|---|---|---|\n"
            "| <!-- pecot-dependabot-pr: pr/2 --> `Bump a` | [#2](https://github.com/o/r/pull/2)"
            " | major・playwright |\n"
            "<!-- pecot-dependabot-pr: list-end -->\n"
        )

    def test_scoped_package_title_is_a_code_span_not_a_mention(self) -> None:
        body = render_tracker_body([_entry(4, "Bump @vueuse/core from 1.0.0 to 1.1.0")])
        assert "`Bump @vueuse/core from 1.0.0 to 1.1.0`" in body
        assert parse_tracker_pr_numbers(body) == [4]

    def test_title_with_backticks_uses_a_longer_fence(self) -> None:
        body = render_tracker_body([_entry(4, "Bump `@scope/pkg` | x")])
        assert "``Bump `@scope/pkg` \\| x``" in body
        body = render_tracker_body([_entry(5, "`@scope/pkg`")])
        assert "`` `@scope/pkg` ``" in body

    def test_round_trip_reads_numbers(self) -> None:
        body = render_tracker_body([_entry(5), _entry(2)])
        assert parse_tracker_pr_numbers(body) == [2, 5]

    def test_only_the_list_is_rewritten(self) -> None:
        existing = render_tracker_body([_entry(1)]).replace(
            "<!-- pecot-dependabot-pr: list-end -->",
            "<!-- pecot-dependabot-pr: list-end -->\n\n人の注記",
        )
        body = render_tracker_body([_entry(2)], existing)
        assert body.endswith("list-end -->\n\n人の注記\n")
        assert "pr/1 " not in body
        assert "pr/2 " in body

    def test_title_cannot_break_the_table(self) -> None:
        body = render_tracker_body([_entry(3, "a | b <!-- pecot-dependabot-pr: pr/99 -->")])
        assert parse_tracker_pr_numbers(body) == [3]

    def test_title_with_pipe_and_backtick_keeps_four_cell_separators(self) -> None:
        body = render_tracker_body([_entry(3, "a | `b` | c")])
        row = next(line for line in body.split("\n") if "pr/3 " in line)
        assert len(re.findall(r"(?<!\\)\|", row)) == 4

    def test_empty_list_is_none_only(self) -> None:
        body = render_tracker_body([])
        begin = body.index(LIST_BEGIN) + len(LIST_BEGIN)
        assert body[begin : body.index(LIST_END)] == "\nnone\n"
        assert parse_tracker_pr_numbers(body) == []

    def test_old_form_body_is_read(self) -> None:
        assert parse_tracker_pr_numbers(OLD_FORM_BODY) == [120, 166]

    def test_old_form_body_is_rewritten_keeping_text_outside_the_list(self) -> None:
        existing = OLD_FORM_BODY + "\n\n人の注記\n"
        body = render_tracker_body([_entry(120)], existing)
        assert "| title | PR | reason |" in body
        assert "待っている理由" not in body
        assert "pr/166 " not in body
        assert body.endswith("list-end -->\n\n人の注記\n")

    def test_missing_markers_raise(self) -> None:
        with pytest.raises(DependabotPrError):
            parse_tracker_pr_numbers("no markers")
        with pytest.raises(DependabotPrError):
            render_tracker_body([], "no markers")

    def test_title(self) -> None:
        assert build_tracker_title(date(2026, 11, 9)) == "[Tracker] dependabot PR — 2026-11-09"


class TestPlanTracker:
    def test_creates_when_no_tracker_and_rows(self) -> None:
        plan = plan_tracker([_entry(1)], None)
        assert plan.create and not plan.close
        assert [e.number for e in plan.added] == [1]

    def test_no_tracker_and_no_rows_does_nothing(self) -> None:
        plan = plan_tracker([], None)
        assert not plan.create and not plan.close

    def test_adds_and_removes(self) -> None:
        plan = plan_tracker([_entry(2), _entry(3)], [1, 2])
        assert [e.number for e in plan.added] == [3]
        assert plan.removed == [1]
        assert not plan.create and not plan.close

    def test_closes_when_empty(self) -> None:
        plan = plan_tracker([], [1])
        assert plan.close
        assert plan.removed == [1]
