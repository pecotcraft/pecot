"""core/issue_board.py - Issue の作成・ボードへの追加・フィールドの設定

失敗は ``GitHubAPIError`` で呼び出し側に返す。表示と終了コードは呼び出し側が決める
（``pecot issue`` は警告で流し、``pecot security sync`` は件ごとの失敗として数える）。
"""

from __future__ import annotations

from typing import Any

from cli.core.config import ProjectConfig
from cli.core.github import GitHubClient

# 作ったボード項目の Status（Tracker はここから始める）
_BOARD_STATUS = "backlog"


def create_issue(
    client: GitHubClient,
    owner: str,
    repo: str,
    title: str,
    body: str,
    labels: list[str] | None,
) -> dict[str, Any]:
    """Issue を作成して API の応答を返す

    Raises:
        GitHubAPIError: 作成に失敗した場合
    """
    return client.create_issue(owner=owner, repo=repo, title=title, body=body, labels=labels)


def add_issue_to_board(
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
    issue_node_id: str | None,
) -> tuple[str, str]:
    """Issue をボードへ追加し、(item_id, issue_node_id) を返す

    追加済みの Issue に対しては既存の item_id が返る（何度呼んでも同じ結果になる）。

    Raises:
        GitHubAPIError: node id の取得かボードへの追加に失敗した場合
    """
    if not issue_node_id:
        issue_node_id = client.get_issue_node_id(owner, repo, issue_number)
    item_id = client.add_to_project(config.project.id, issue_node_id)
    return item_id, issue_node_id


def set_issue_field(
    client: GitHubClient,
    config: ProjectConfig,
    item_id: str,
    field_name: str,
    option_name: str,
) -> bool:
    """カスタムフィールドを 1 つ設定する。設定したら True

    設定に無いフィールド・オプションは False を返す（何もしない）。

    Raises:
        GitHubAPIError: 更新に失敗した場合
    """
    field_id = config.get_field_id(field_name)
    option_id = config.get_option_id(field_name, option_name)
    if not (field_id and option_id):
        return False
    client.update_project_item_field(config.project.id, item_id, field_id, option_id)
    return True


def item_has_field_value(
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
    item_id: str,
    field_name: str,
) -> bool:
    """ボード項目にそのフィールドの値が入っているか

    設定にないフィールドは入っているとみなす（設定できないので、空として扱わない）。

    Raises:
        GitHubAPIError: 取得に失敗した場合
    """
    field_id = config.get_field_id(field_name)
    if not field_id:
        return True
    return field_id in client.get_item_set_field_ids(
        config.project.id, owner, repo, issue_number, item_id
    )


def put_on_board(
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
    priority: str | None,
    *,
    only_if_empty: bool,
) -> None:
    """ボードへの追加と、Status（Backlog）・Priority の設定（何度やっても同じ結果になる）

    ``only_if_empty`` なら、ボード項目のそのフィールドが空のときだけ入れる。
    人が動かした Status や Priority を、次の実行が戻さない。
    途中で失敗して空のままの項目は直る。

    Raises:
        GitHubAPIError: ボードへの追加か、フィールドの取得・設定に失敗した場合
    """
    item_id, _ = add_issue_to_board(client, config, owner, repo, issue_number, None)
    fields = [("workflow", _BOARD_STATUS)]
    if priority is not None:
        fields.append(("priority", priority))
    for field_name, option in fields:
        if only_if_empty and item_has_field_value(
            client, config, owner, repo, issue_number, item_id, field_name
        ):
            continue
        set_issue_field(client, config, item_id, field_name, option)
