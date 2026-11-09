"""tests/core/test_issue_board.py - put_on_board の only_if_empty のテスト

GitHubClient（I/O 境界）だけを差し替える。ボード設定は field_id・option_id を返す MagicMock にする。
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from cli.core.issue_board import put_on_board


def _config() -> MagicMock:
    config = MagicMock()
    config.project.id = "PVT_1"
    config.get_field_id.side_effect = lambda name: f"F_{name}"
    config.get_option_id.side_effect = lambda field, option: f"O_{field}_{option}"
    return config


def _client(set_field_ids: set[str]) -> MagicMock:
    client = MagicMock()
    client.get_issue_node_id.return_value = "I_node"
    client.add_to_project.return_value = "ITEM"
    client.get_item_set_field_ids.return_value = set_field_ids
    return client


def _updates(client: MagicMock) -> list[tuple[str, ...]]:
    return [c.args for c in client.update_project_item_field.call_args_list]


class TestPutOnBoard:
    @pytest.mark.parametrize(
        ("set_field_ids", "expected"),
        [
            (
                set(),
                [
                    ("PVT_1", "ITEM", "F_workflow", "O_workflow_backlog"),
                    ("PVT_1", "ITEM", "F_priority", "O_priority_high"),
                ],
            ),
            ({"F_workflow"}, [("PVT_1", "ITEM", "F_priority", "O_priority_high")]),
            ({"F_priority"}, [("PVT_1", "ITEM", "F_workflow", "O_workflow_backlog")]),
            ({"F_workflow", "F_priority"}, []),
        ],
    )
    def test_only_if_empty_sets_just_the_empty_fields(
        self, set_field_ids: set[str], expected: list[tuple[str, ...]]
    ) -> None:
        client = _client(set_field_ids)

        put_on_board(client, _config(), "o", "r", 5, "high", only_if_empty=True)

        assert _updates(client) == expected

    def test_without_only_if_empty_overwrites_filled_fields(self) -> None:
        client = _client({"F_workflow", "F_priority"})

        put_on_board(client, _config(), "o", "r", 5, "high", only_if_empty=False)

        assert _updates(client) == [
            ("PVT_1", "ITEM", "F_workflow", "O_workflow_backlog"),
            ("PVT_1", "ITEM", "F_priority", "O_priority_high"),
        ]
