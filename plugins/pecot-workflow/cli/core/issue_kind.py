"""Issue 種別判定ユーティリティ（GitHubClient.get_issue_kind 戻り値に対する純関数）。"""

from typing import Any

EPIC_TYPE_NAME = "Epic"


def is_epic_issue(issue_kind: dict[str, Any]) -> bool:
    """Issue Type=Epic、または subIssues.totalCount > 0 を Epic とみなす。

    1. issue_type が "Epic"（大小無視で一致）→ True (Phase2)
    2. issue_type が空/None かつ sub_issues_total > 0 → True (Phase1 フォールバック)
    3. それ以外 → False
    """
    issue_type = (issue_kind.get("issue_type") or "").strip()
    if issue_type and issue_type.lower() == EPIC_TYPE_NAME.lower():
        return True
    if not issue_type and issue_kind.get("sub_issues_total", 0) > 0:
        return True
    return False
