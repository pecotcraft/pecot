"""utils/format.py - 出力フォーマット関数

ボード表示やIssue一覧のフォーマットを担当。
Bash版 scripts/lib/format.sh の機能をPythonで再実装。
"""

from __future__ import annotations

from typing import Any

# ステータスマッピング（表示ラベル → マッチパターン）
STATUS_PATTERNS: dict[str, list[str]] = {
    "Active": ["Active"],
    "In Review": ["In Review"],
    "Ready": ["Ready"],
    "Pending": ["Pending"],
    "Backlog": ["Backlog"],
    "Archived": ["Archived"],
}

# 表示順序
STATUS_ORDER: list[str] = ["Active", "In Review", "Ready", "Pending", "Backlog", "Archived"]


def extract_workflow_status(
    item: dict[str, Any],
    workflow_field_name: str,
) -> str | None:
    """GraphQL戻り値からWorkflowステータスを抽出

    Args:
        item: list_project_items()の戻り値の1要素
        workflow_field_name: ワークフローフィールド名（例: "pecot-workflow-abc"）

    Returns:
        Workflowフィールドの値（例: "Active", "Ready"）
        見つからない場合はNone
    """
    field_values = item.get("fieldValues", {})
    nodes = field_values.get("nodes", [])

    for node in nodes:
        if not node:
            continue
        field = node.get("field", {})
        field_name = field.get("name", "")
        # workflowフィールドを探す（大文字小文字を区別しない）
        if field_name.lower() == workflow_field_name.lower():
            return node.get("name")

    return None


def transform_items(
    raw_items: list[dict[str, Any]],
    workflow_field_name: str,
) -> list[dict[str, Any]]:
    """GraphQL戻り値をフォーマット用の形式に変換

    Args:
        raw_items: list_project_items()の戻り値
        workflow_field_name: ワークフローフィールド名（例: "pecot-workflow-abc"）

    Returns:
        フォーマット用に変換されたアイテムリスト
    """
    transformed: list[dict[str, Any]] = []

    for item in raw_items:
        content = item.get("content")
        if not content:
            # DraftIssue等、contentがない場合はスキップ
            continue

        workflow = extract_workflow_status(item, workflow_field_name)

        # ラベルを抽出（nameフィールドが存在し空でないもののみ）
        labels_data = content.get("labels", {})
        labels_nodes = labels_data.get("nodes", [])
        labels = [name for node in labels_nodes if node and (name := node.get("name")) and name]

        # リポジトリ情報を抽出
        repository_data = content.get("repository", {})
        owner_data = repository_data.get("owner", {})
        repo_owner = owner_data.get("login", "")
        repo_name = repository_data.get("name", "")
        repository = f"{repo_owner}/{repo_name}" if repo_owner and repo_name else ""

        transformed.append(
            {
                "id": item.get("id", ""),
                "workflow": workflow,
                "title": content.get("title", ""),
                "updatedAt": item.get("updatedAt", ""),
                "content": {
                    "number": content.get("number"),
                    "state": content.get("state"),
                    "url": content.get("url"),
                    "labels": labels,
                    "repository": repository,
                },
            }
        )

    return transformed


def _match_status(workflow: str | None, patterns: list[str]) -> bool:
    """ワークフローステータスがパターンにマッチするか判定

    Args:
        workflow: アイテムのWorkflowステータス
        patterns: マッチさせるパターンリスト

    Returns:
        マッチする場合True
    """
    if workflow is None:
        return False
    return workflow in patterns


def _format_table_row(item: dict[str, Any]) -> str:
    """1アイテムをMarkdown表の行 ``| Ref | Title |`` に変換

    Ref カラムは GitHub 慣習に倣い ``owner/repo#N`` 形式で合成する。
    リポジトリ情報または番号が欠落している場合は可能な範囲で埋め、
    両方欠落しているときは ``-`` を表示する。

    Args:
        item: transform_items()で変換されたアイテム

    Returns:
        Markdown表の1行
    """
    number = item["content"].get("number")
    repository = item["content"].get("repository", "")
    if repository and number is not None:
        ref = f"{repository}#{number}"
    elif repository:
        ref = repository
    elif number is not None:
        ref = f"#{number}"
    else:
        ref = "-"
    title = item.get("title", "") or "-"
    return f"| {ref} | {title} |"


def format_board_output(items: list[dict[str, Any]]) -> str:
    """プロジェクトボードをMarkdown形式で出力

    Args:
        items: transform_items()で変換されたアイテムリスト

    Returns:
        Markdown形式の文字列
    """
    sections: list[list[str]] = []

    for status in STATUS_ORDER:
        patterns = STATUS_PATTERNS[status]

        status_items = [item for item in items if _match_status(item.get("workflow"), patterns)]
        total_count = len(status_items)

        if total_count == 0:
            continue

        display_items = status_items
        if status == "Archived" and total_count > 5:
            sorted_items = sorted(
                status_items,
                key=lambda x: x.get("updatedAt", ""),
                reverse=True,
            )
            display_items = sorted_items[:5]
            heading = f"### {status} (latest 5 of {total_count})"
        else:
            heading = f"### {status} ({total_count})"

        section: list[str] = [heading, "| Ref | Title |", "|-----|----------|"]
        for item in display_items:
            section.append(_format_table_row(item))
        sections.append(section)

    if not sections:
        return "_No items_"

    lines: list[str] = []
    for i, section in enumerate(sections):
        if i > 0:
            lines.append("")
        lines.extend(section)

    return "\n".join(lines)


def format_items_json(items: list[dict[str, Any]]) -> dict[str, Any]:
    """アイテムリストをJSON出力用の辞書に変換

    Args:
        items: transform_items()で変換されたアイテムリスト

    Returns:
        JSON出力用の辞書
    """
    return {"items": items}
