"""is_epic_issue 純関数のテスト。"""

from cli.core.issue_kind import is_epic_issue


def test_is_epic_by_issue_type_exact() -> None:
    assert is_epic_issue({"issue_type": "Epic", "sub_issues_total": 0}) is True


def test_is_epic_case_insensitive() -> None:
    assert is_epic_issue({"issue_type": "epic", "sub_issues_total": 0}) is True


def test_is_epic_by_sub_issues_fallback() -> None:
    assert is_epic_issue({"issue_type": None, "sub_issues_total": 3}) is True


def test_is_epic_empty_string_with_sub_issues() -> None:
    assert is_epic_issue({"issue_type": "", "sub_issues_total": 2}) is True


def test_not_epic_task() -> None:
    assert is_epic_issue({"issue_type": "Task", "sub_issues_total": 0}) is False


def test_not_epic_task_even_with_sub_issues() -> None:
    # Issue Type 明示時は Phase1 フォールバックを使わない
    assert is_epic_issue({"issue_type": "Task", "sub_issues_total": 5}) is False


def test_not_epic_unknown_type_no_sub_issues() -> None:
    # 既知制約: Issue Type 未設定かつ sub-issue 0 件は判定不能 → False
    assert is_epic_issue({"issue_type": None, "sub_issues_total": 0}) is False


def test_missing_keys() -> None:
    assert is_epic_issue({}) is False
