"""tests/core/test_format.py - core/format.py のテスト

ボード表示整形関数のユニットテスト。
"""

from cli.core.format import (
    _format_table_row,
    extract_workflow_status,
    format_board_output,
    format_items_json,
    transform_items,
)

# テストデータ

SAMPLE_RAW_ITEMS = [
    {
        "id": "item1",
        "updatedAt": "2026-01-14T10:00:00Z",
        "fieldValues": {
            "nodes": [
                {"field": {"name": "pecot-workflow-test"}, "name": "Active"},
            ]
        },
        "content": {
            "number": 100,
            "title": "Active Issue",
            "state": "OPEN",
            "url": "https://github.com/test/repo/issues/100",
            "labels": {"nodes": [{"name": "bug"}, {"name": "urgent"}]},
            "repository": {"owner": {"login": "test"}, "name": "repo"},
        },
    },
    {
        "id": "item2",
        "updatedAt": "2026-01-13T10:00:00Z",
        "fieldValues": {
            "nodes": [
                {"field": {"name": "pecot-workflow-test"}, "name": "Ready"},
            ]
        },
        "content": {
            "number": 101,
            "title": "Ready Issue",
            "state": "OPEN",
            "url": "https://github.com/test/repo/issues/101",
            "labels": {"nodes": []},
            "repository": {"owner": {"login": "test"}, "name": "repo"},
        },
    },
    {
        "id": "item3",
        "updatedAt": "2026-01-12T10:00:00Z",
        "fieldValues": {
            "nodes": [
                {"field": {"name": "pecot-workflow-test"}, "name": "Backlog"},
            ]
        },
        "content": {
            "number": 102,
            "title": "Backlog Issue",
            "state": "OPEN",
            "url": "https://github.com/test/repo/issues/102",
            "labels": {"nodes": [{"name": "enhancement"}]},
            "repository": {"owner": {"login": "test"}, "name": "repo"},
        },
    },
    {
        "id": "item4",
        "updatedAt": "2026-01-11T10:00:00Z",
        "fieldValues": {
            "nodes": [
                {"field": {"name": "pecot-workflow-test"}, "name": "Archived"},
            ]
        },
        "content": {
            "number": 103,
            "title": "Done Issue",
            "state": "CLOSED",
            "url": "https://github.com/test/repo/issues/103",
            "labels": {"nodes": [{"name": "bug"}]},
            "repository": {"owner": {"login": "test"}, "name": "repo"},
        },
    },
]


# extract_workflow_status テスト


class TestExtractWorkflowStatus:
    """extract_workflow_status関数のテスト"""

    def test_extract_workflow_status_found(self) -> None:
        """pecot-workflowフィールドがある場合"""
        item = {
            "fieldValues": {
                "nodes": [
                    {"field": {"name": "pecot-workflow-test"}, "name": "Active"},
                ]
            }
        }
        assert extract_workflow_status(item, "pecot-workflow-test") == "Active"

    def test_extract_workflow_status_not_found(self) -> None:
        """pecot-workflowフィールドがない場合"""
        item = {
            "fieldValues": {
                "nodes": [
                    {"field": {"name": "Priority"}, "name": "High"},
                ]
            }
        }
        assert extract_workflow_status(item, "pecot-workflow-test") is None

    def test_extract_workflow_status_empty(self) -> None:
        """fieldValuesが空の場合"""
        item = {"fieldValues": {"nodes": []}}
        assert extract_workflow_status(item, "pecot-workflow-test") is None

    def test_extract_workflow_status_case_insensitive(self) -> None:
        """大文字小文字を区別しない"""
        item = {
            "fieldValues": {
                "nodes": [
                    {"field": {"name": "PECOT-WORKFLOW-TEST"}, "name": "Ready"},
                ]
            }
        }
        assert extract_workflow_status(item, "pecot-workflow-test") == "Ready"

    def test_extract_workflow_status_with_empty_nodes(self) -> None:
        """空ノードが混在してもWorkflowを抽出できる"""
        item = {
            "fieldValues": {
                "nodes": [
                    {},
                    {},
                    {"field": {"name": "pecot-workflow-test"}, "name": "Active"},
                    {},
                ]
            }
        }
        assert extract_workflow_status(item, "pecot-workflow-test") == "Active"

    def test_extract_workflow_status_missing_field(self) -> None:
        """fieldフィールドがないノードをスキップ"""
        item = {
            "fieldValues": {
                "nodes": [
                    {"name": "SomeValue"},  # fieldフィールドなし
                    {"field": {"name": "pecot-workflow-test"}, "name": "Backlog"},
                ]
            }
        }
        assert extract_workflow_status(item, "pecot-workflow-test") == "Backlog"

    def test_extract_workflow_status_none_node(self) -> None:
        """Noneノードが含まれていてもエラーにならない"""
        item = {
            "fieldValues": {
                "nodes": [
                    None,
                    {"field": {"name": "pecot-workflow-test"}, "name": "Done"},
                ]
            }
        }
        assert extract_workflow_status(item, "pecot-workflow-test") == "Done"


# transform_items テスト


class TestTransformItems:
    """transform_items関数のテスト"""

    def test_transform_items_basic(self) -> None:
        """基本的な変換"""
        items = transform_items(SAMPLE_RAW_ITEMS, "pecot-workflow-test")

        assert len(items) == 4
        assert items[0]["workflow"] == "Active"
        assert items[0]["title"] == "Active Issue"
        assert items[0]["content"]["number"] == 100
        assert items[0]["content"]["labels"] == ["bug", "urgent"]

    def test_transform_items_empty_labels(self) -> None:
        """ラベルが空の場合"""
        items = transform_items(SAMPLE_RAW_ITEMS, "pecot-workflow-test")
        ready_item = next(i for i in items if i["workflow"] == "Ready")
        assert ready_item["content"]["labels"] == []

    def test_transform_items_skip_no_content(self) -> None:
        """contentがないアイテムはスキップ"""
        raw = [
            {"id": "draft", "fieldValues": {"nodes": []}, "content": None},
        ]
        items = transform_items(raw, "pecot-workflow-test")
        assert len(items) == 0

    def test_transform_items_malformed_labels(self) -> None:
        """不正なラベルノードはスキップ"""
        raw = [
            {
                "id": "item1",
                "updatedAt": "2026-01-14T10:00:00Z",
                "fieldValues": {"nodes": []},
                "content": {
                    "number": 100,
                    "title": "Test",
                    "state": "OPEN",
                    "url": "https://example.com",
                    "labels": {
                        "nodes": [
                            {"name": "valid"},
                            {},  # 空のノード
                            {"name": ""},  # 空の名前
                            {"other": "field"},  # nameフィールドなし
                            {"name": "also-valid"},
                        ]
                    },
                },
            }
        ]
        items = transform_items(raw, "pecot-workflow-test")
        assert items[0]["content"]["labels"] == ["valid", "also-valid"]

    def test_transform_items_empty_fieldvalue_nodes(self) -> None:
        """空のfieldValueノードがあってもエラーにならない"""
        raw = [
            {
                "id": "item1",
                "updatedAt": "2026-01-14T10:00:00Z",
                "fieldValues": {
                    "nodes": [
                        {},  # 空のノード
                        {},
                        {"field": {"name": "pecot-workflow-test"}, "name": "Active"},
                        {},
                    ]
                },
                "content": {
                    "number": 100,
                    "title": "Test",
                    "state": "OPEN",
                    "url": "https://example.com",
                    "labels": {"nodes": []},
                },
            }
        ]
        items = transform_items(raw, "pecot-workflow-test")
        assert items[0]["workflow"] == "Active"

    def test_transform_items_missing_labels_field(self) -> None:
        """labelsフィールドがなくてもエラーにならない"""
        raw = [
            {
                "id": "item1",
                "updatedAt": "2026-01-14T10:00:00Z",
                "fieldValues": {"nodes": []},
                "content": {
                    "number": 100,
                    "title": "Test",
                    "state": "OPEN",
                    "url": "https://example.com",
                    # labels フィールドなし
                },
            }
        ]
        items = transform_items(raw, "pecot-workflow-test")
        assert items[0]["content"]["labels"] == []


# format_board_output テスト


class TestFormatBoardOutput:
    """format_board_output関数のテスト"""

    def test_format_board_output_basic(self) -> None:
        """基本的な出力フォーマット"""
        items = transform_items(SAMPLE_RAW_ITEMS, "pecot-workflow-test")
        output = format_board_output(items)

        # プロジェクト名見出しは出力されない
        assert "## プロジェクト:" not in output

        # サンプルが持つステータスのみが見出しに出る
        assert "### Active" in output
        assert "### Ready" in output
        assert "### Backlog" in output
        assert "### Archived" in output
        # サンプルに無いステータスは出ない (0 件セクション抑制)
        assert "### In Review" not in output
        assert "### Pending" not in output

        # Ref が owner/repo#N 形式で含まれる
        assert "| test/repo#100 |" in output
        assert "| test/repo#101 |" in output
        assert "| test/repo#102 |" in output
        assert "| test/repo#103 |" in output

        # 2 カラムヘッダ
        assert "| Ref | タイトル |" in output
        # 旧 3 カラムヘッダ/旧カラムは残っていない
        assert "| # | タイトル | リポジトリ |" not in output

    def test_format_board_output_status_mapping(self) -> None:
        """ステータスごとにグループ化される"""
        items = transform_items(SAMPLE_RAW_ITEMS, "pecot-workflow-test")
        output = format_board_output(items)

        # Readyセクションに表示
        assert "### Ready (1件)" in output

        # Archivedセクションに表示
        assert "### Archived (1件)" in output

    def test_format_board_output_empty_status(self) -> None:
        """空のステータスがある場合はスキップされる"""
        items = [
            {
                "id": "item1",
                "workflow": "Active",
                "title": "Test",
                "updatedAt": "2026-01-14T10:00:00Z",
                "content": {"number": 1, "labels": []},
            }
        ]
        output = format_board_output(items)

        # 件数のあるステータスのみが見出しに出る
        assert "### Active (1件)" in output
        assert "### Backlog" not in output
        assert "### Archived" not in output
        # 「(なし)」は廃止
        assert "(なし)" not in output

    def test_format_board_output_done_limit(self) -> None:
        """Archivedは直近5件のみ表示"""
        # 10件のArchivedアイテムを作成
        items = []
        for i in range(10):
            items.append(
                {
                    "id": f"item{i}",
                    "workflow": "Archived",
                    "title": f"Archived Issue {i}",
                    "updatedAt": f"2026-01-{10 + i:02d}T10:00:00Z",
                    "content": {"number": i, "labels": []},
                }
            )

        output = format_board_output(items)

        # 10件中直近5件と表示
        assert "### Archived (10件中 直近5件)" in output

        # 最新の5件（番号 9 / 8 / 7 / 6 / 5）が含まれる (repository 未設定 → #N)
        assert "| #9 |" in output
        assert "| #8 |" in output
        assert "| #7 |" in output
        assert "| #6 |" in output
        assert "| #5 |" in output

        # 古い5件（番号 4 / 3 / 2 / 1 / 0）は含まれない
        assert "| #4 |" not in output
        assert "| #0 |" not in output

    def test_format_board_output_unknown_workflow(self) -> None:
        """未知のworkflowステータスはどのセクションにも表示されない"""
        items = [
            {
                "id": "item1",
                "workflow": "Active",
                "title": "Active Item",
                "updatedAt": "2026-01-14T10:00:00Z",
                "content": {"number": 1, "labels": []},
            },
            {
                "id": "item2",
                "workflow": "InProgress",  # 未知のステータス
                "title": "Unknown Status Item",
                "updatedAt": "2026-01-14T10:00:00Z",
                "content": {"number": 2, "labels": []},
            },
        ]
        output = format_board_output(items)

        # Activeのアイテムは表示される (repository 未設定 → #N)
        assert "| #1 |" in output
        assert "Active Item" in output

        # 未知のステータスは表示されない
        assert "| #2 |" not in output
        assert "Unknown Status Item" not in output

    def test_format_board_output_none_workflow(self) -> None:
        """workflowがNoneで全ステータスが空ならプレースホルダのみ"""
        items = [
            {
                "id": "item1",
                "workflow": None,
                "title": "No Workflow Item",
                "updatedAt": "2026-01-14T10:00:00Z",
                "content": {"number": 99, "labels": []},
            },
        ]
        output = format_board_output(items)

        # 全ステータス 0 件なら 1 行のプレースホルダのみ
        assert output == "_該当アイテムなし_"


# format_items_json テスト


class TestFormatItemsJson:
    """format_items_json関数のテスト"""

    def test_format_items_json(self) -> None:
        """JSON出力形式"""
        items = transform_items(SAMPLE_RAW_ITEMS, "pecot-workflow-test")
        output = format_items_json(items)

        assert "items" in output
        assert len(output["items"]) == 4
        assert output["items"][0]["workflow"] == "Active"


# _format_table_row テスト


class TestFormatTableRow:
    """_format_table_row関数のテスト"""

    def test_format_table_row_basic(self) -> None:
        """基本的なテーブル行フォーマット"""
        item = {
            "id": "item1",
            "workflow": "Active",
            "title": "Test Issue",
            "updatedAt": "2026-01-14T10:00:00Z",
            "content": {
                "number": 123,
                "labels": ["bug", "urgent"],
                "repository": "owner/repo",
            },
        }
        row = _format_table_row(item)
        assert row == "| owner/repo#123 | Test Issue |"

    def test_format_table_row_none_number(self) -> None:
        """repository と number のどちらも無い場合は Ref が '-' になる"""
        item = {
            "title": "Test",
            "content": {"number": None, "labels": [], "repository": ""},
        }
        row = _format_table_row(item)
        assert row == "| - | Test |"

    def test_format_table_row_empty_title(self) -> None:
        """titleが空の場合は'-'を表示"""
        item = {
            "title": "",
            "content": {"number": 1, "labels": [], "repository": "owner/repo"},
        }
        row = _format_table_row(item)
        assert row == "| owner/repo#1 | - |"

    def test_format_table_row_missing_fields(self) -> None:
        """フィールドが欠落している場合のフォールバック"""
        item = {
            "content": {},  # number, repository なし
            # titleもなし
        }
        row = _format_table_row(item)
        assert row == "| - | - |"
