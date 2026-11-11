"""tests/e2e/test_board_multi_repo.py - Phase 7 US5 マルチリポ一貫表示 E2E。

``pecot project info`` が ``| Ref | Title |`` 2 カラムのボードを描画することを検証する。
``owner/repo#N`` 形式で Ref を表示すること。
``--repo`` オプション (local / global) でリポジトリ絞り込みが発火すること。
後方互換として ``--repo`` 未指定で全 items が表示されること。
検証には CliRunner を使う。

モック戦略 (Phase 8 US6: respx 移行後):
- HTTP 層は ``respx_mock`` (``pytest-respx`` が自動登録) で捕捉する。
  対象は ``https://ghes.example.com/api/graphql`` への GraphQL POST。
  ``GitHubClient`` は実装を維持する。
  patch するのは ``_get_token`` / ``_retry_with_fallback_token`` だけで、トークン取得と再試行を無効化する。
- ``load_active_config`` / ``get_active_config_path`` を patch する。
  実 ``ProjectConfig`` オブジェクトと固定 stem の config path を返す。
- 実 GitHub API には一切アクセスしない (respx が全 POST を横取り)。
"""

from __future__ import annotations

import json
from collections.abc import Callable
from contextlib import ExitStack
from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest
import respx
from typer.testing import CliRunner
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands.main import app
from cli.core.config import (
    FieldOptions,
    Project,
    ProjectConfig,
    ProjectFields,
    Repository,
)
from cli.core.format import _format_table_row
from cli.core.github import GitHubClient

runner = CliRunner()

HOST = "ghes.example.com"
GRAPHQL_URL = f"https://{HOST}/api/graphql"
WORKFLOW_SUFFIX = "test"
WORKFLOW_FIELD = f"pecot-workflow-{WORKFLOW_SUFFIX}"


def _make_raw_item(
    item_id: str,
    number: int,
    title: str,
    workflow: str,
    owner: str,
    repo: str,
    updated_at: str = "2026-04-01T10:00:00Z",
) -> dict[str, Any]:
    """``list_project_items`` GraphQL レスポンスの ``nodes`` 要素を 1 件作る。"""
    return {
        "id": item_id,
        "updatedAt": updated_at,
        "fieldValues": {
            "nodes": [
                {"field": {"name": WORKFLOW_FIELD}, "name": workflow},
            ]
        },
        "content": {
            "number": number,
            "title": title,
            "state": "OPEN",
            "url": f"https://{HOST}/{owner}/{repo}/issues/{number}",
            "labels": {"nodes": []},
            "repository": {"owner": {"login": owner}, "name": repo},
        },
    }


SAMPLE_RAW_ITEMS = [
    _make_raw_item("i1", 1, "A-1 Ready", "Ready", "ownerA", "repoA"),
    _make_raw_item("i2", 2, "A-2 Active", "Active", "ownerA", "repoA"),
    _make_raw_item("i3", 10, "B-10 Ready", "Ready", "ownerB", "repoB"),
    _make_raw_item("i4", 11, "B-11 Active", "Active", "ownerB", "repoB"),
    _make_raw_item("i5", 20, "C-20 Ready", "Ready", "ownerC", "repoC"),
]


def _make_graphql_payload(items: list[dict[str, Any]]) -> dict[str, Any]:
    """``QUERY_LIST_PROJECT_ITEMS`` が期待する GraphQL レスポンス構造に整形。"""
    return {
        "data": {
            "node": {
                "items": {
                    "nodes": items,
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            }
        }
    }


@pytest.fixture
def mock_config() -> ProjectConfig:
    """``load_active_config`` が返す ProjectConfig。host=ghes.example.com 固定。"""
    return ProjectConfig(
        host=HOST,
        owner="ownerA",
        workflow_suffix=WORKFLOW_SUFFIX,
        project=Project(
            number=1,
            id="proj-id",
            fields=ProjectFields(
                workflow=FieldOptions(
                    id="F_workflow",
                    options={
                        "backlog": "o_backlog",
                        "ready": "o_ready",
                        "active": "o_active",
                        "in_review": "o_in_review",
                        "archived": "o_archived",
                    },
                )
            ),
        ),
        repositories=[
            Repository(owner=o, name=n, develop_branch="develop", release_branch="main")
            for o, n in [
                ("ownerA", "repoA"),
                ("ownerB", "repoB"),
                ("ownerC", "repoC"),
            ]
        ],
    )


@pytest.fixture
def mock_graphql_route(
    respx_mock: respx.MockRouter,
) -> Callable[[list[dict[str, Any]]], respx.Route]:
    """``list_project_items`` 用 GraphQL POST を respx に登録するファクトリ。

    呼び出しごとに ``items`` を差し替えるため、固定レスポンスではなくファクトリを
    返す。戻り値は登録済み ``respx.Route`` で ``call_count`` を後から検証できる。
    """

    def _register(items: list[dict[str, Any]]) -> respx.Route:
        return respx_mock.post(GRAPHQL_URL).mock(
            return_value=httpx.Response(200, json=_make_graphql_payload(items))
        )

    return _register


@pytest.fixture
def mock_dependabot_alerts_route(respx_mock: respx.MockRouter) -> respx.Route:
    """全登録リポの Dependabot alert 一覧 GET を respx に登録する（全リポ open 0 件）。

    ``project info`` は登録リポごとに alert の一覧を取りに行くため、起動するテストが使う。
    """
    return respx_mock.get(
        url__regex=rf"^https://{HOST}/api/v3/repos/[^/]+/[^/]+/dependabot/alerts"
    ).mock(return_value=httpx.Response(200, json=[]))


def _patch_project_info(config: ProjectConfig, config_path_stem: str = "test-project"):
    """``pecot project info`` が使う依存を一括 patch するヘルパ。

    ``GitHubClient`` 自体は本物を使い (respx が HTTP を横取り)、以下のみ patch する:

    - ``load_active_config`` / ``get_active_config_path``:
      ファイルシステムに依存する config 読み込みを固定値に差し替える。
    - ``GitHubClient._get_token`` / ``_retry_with_fallback_token``:
      トークン取得と fallback token の再試行を無効化する。
    """
    config_path = MagicMock()
    config_path.stem = config_path_stem
    return [
        patch("cli.commands.project.load_active_config", return_value=config),
        patch(
            "cli.commands.project.get_active_config_path",
            return_value=config_path,
        ),
        patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        patch.object(GitHubClient, "_get_token", return_value="test_token"),
    ]


def _run_with_patches(patches, invocation):
    """複数 patch を積み上げて CliRunner で実行する。"""
    with ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        return runner.invoke(app, invocation)


# ケース 1: ヘッダが Ref カラムを含む / 旧カラム (リポジトリ, `| # |`) が無い


class TestHeaderRefColumn:
    def test_header_has_ref_column_no_repository_column(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        """`pecot project info` が ``| Ref | Title |`` ヘッダを出し、旧カラムを出さない。"""
        route = mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info"],
        )

        assert result.exit_code == 0, result.output
        assert "| Ref | Title |" in result.stdout
        # 旧「リポジトリ」カラムが消えていること (ボード状況セクション内)
        assert "Repository" not in result.stdout.split("## Board status")[-1]
        # 旧 `| # |` 先頭カラムが無いこと
        assert "| # |" not in result.stdout
        assert route.call_count >= 1


# ケース 2: _format_table_row 単体で owner/repo#N の Ref を合成


class TestFormatTableRowComposesRef:
    def test_format_table_row_composes_ref(self) -> None:
        item = {
            "title": "Test",
            "content": {
                "number": 42,
                "labels": [],
                "repository": "ownerA/repoA",
            },
        }
        row = _format_table_row(item)
        assert row == "| ownerA/repoA#42 | Test |"


# ケース 3: local --repo で Markdown の行がフィルタされ、フィルタ表示ヘッダが出る


class TestLocalRepoFilterMarkdown:
    @add_test_properties(verifies=["PW-PROJECT-INFO-03"])
    def test_local_repo_filters_markdown(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info", "--repo", "ownerA/repoA"],
        )

        assert result.exit_code == 0, result.output
        # フィルタ表示ヘッダ (見出しに統合)
        assert "## Board status (filter: ownerA/repoA)" in result.stdout
        # ownerA/repoA の Ref は残る
        assert "ownerA/repoA#1" in result.stdout
        assert "ownerA/repoA#2" in result.stdout
        # ownerB / ownerC の Ref は消える
        assert "ownerB/repoB#" not in result.stdout
        assert "ownerC/repoC#" not in result.stdout


# ケース 4: local --repo で JSON も board.items がフィルタされる


class TestLocalRepoFilterJson:
    @add_test_properties(verifies=["PW-PROJECT-INFO-03"])
    def test_local_repo_filters_json(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info", "--json", "--repo", "ownerA/repoA"],
        )

        assert result.exit_code == 0, result.output
        payload = json.loads(result.stdout)
        repos = {i["content"]["repository"] for i in payload["board"]["items"]}
        assert repos == {"ownerA/repoA"}


# ケース 6: global --repo (ctx.obj) 由来のフィルタが効果値として採用される


class TestGlobalRepoFilter:
    def test_global_repo_filters_when_no_local(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["--repo", "ownerA/repoA", "project", "info"],
        )

        assert result.exit_code == 0, result.output
        assert "## Board status (filter: ownerA/repoA)" in result.stdout
        assert "ownerA/repoA#1" in result.stdout
        assert "ownerB/repoB#" not in result.stdout


# ケース 7: local --repo が global --repo を上書き


class TestLocalOverridesGlobal:
    def test_local_overrides_global(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["--repo", "ownerA/repoA", "project", "info", "--repo", "ownerB/repoB"],
        )

        assert result.exit_code == 0, result.output
        assert "## Board status (filter: ownerB/repoB)" in result.stdout
        assert "ownerB/repoB#10" in result.stdout
        assert "ownerB/repoB#11" in result.stdout
        # global 値の ownerA は Ref として残らない
        assert "ownerA/repoA#" not in result.stdout


# ケース 8: --repo 未指定で全 items が表示される (FR-013 後方互換)


class TestRepoNoneBackwardCompat:
    def test_repo_none_shows_all_items(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info"],
        )

        assert result.exit_code == 0, result.output
        # 3 リポ分の Ref が全て出ている
        assert "ownerA/repoA#1" in result.stdout
        assert "ownerB/repoB#10" in result.stdout
        assert "ownerC/repoC#20" in result.stdout
        # フィルタヘッダは出ない
        assert "フィルタ:" not in result.stdout


# ケース 9: 登録されていないリポ指定で exit 0、各セクションは (なし)


class TestUnknownRepoEmptyResult:
    def test_unknown_repo_empty_result(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info", "--repo", "unknown/nonexistent"],
        )

        assert result.exit_code == 0, result.output
        # フィルタヘッダは出る
        assert "## Board status (filter: unknown/nonexistent)" in result.stdout
        # 該当アイテムなしのプレースホルダが出る
        assert "_No items_" in result.stdout
        # 0 件セクションは出ない
        assert "### Archived" not in result.stdout
        # エラーメッセージが stderr に出ていない
        assert "エラー:" not in result.stderr
        assert "予期しないエラー" not in result.stderr


# ケース 9b: info 全体の見出しが規定順で並ぶ


class TestInfoSectionOrder:
    @add_test_properties(verifies=["PW-PROJECT-INFO-01"])
    def test_info_section_order(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        """`pecot project info` の主要見出しが規定順に並ぶことを保証する。"""
        mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info"],
        )

        assert result.exit_code == 0, result.output
        out = result.stdout
        idx_top = out.find("# Project info")
        idx_basic = out.find("## Overview")
        idx_repos = out.find("## Registered repositories")
        idx_board = out.find("## Board status")

        assert idx_top != -1
        assert idx_basic != -1
        assert idx_repos != -1
        assert idx_board != -1
        assert idx_top < idx_basic < idx_repos < idx_board


# ケース 9c: items が 0 件のとき info はプレースホルダのみで 0 件セクションを抑制


class TestInfoEmptyItemsPlaceholder:
    def test_info_with_zero_items_shows_placeholder_only(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        """items が 0 件なら 0件セクションと旧形式 `=== ` のどちらも出ない。"""
        mock_graphql_route([])

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info"],
        )

        assert result.exit_code == 0, result.output
        out = result.stdout
        idx_board = out.find("## Board status")
        idx_placeholder = out.find("_No items_")
        assert idx_board != -1
        assert idx_placeholder != -1
        # ボード状況見出しの直後に該当アイテムなし
        assert idx_board < idx_placeholder

        # 0 件セクションの見出しは出ない
        assert "### Active" not in out
        assert "### In Review" not in out
        assert "### Ready" not in out
        assert "### Pending" not in out
        assert "### Backlog" not in out
        assert "### Archived" not in out

        # `=== ` 風の見出しは出ない
        assert "=== " not in out


# ケース 10: content.repository が空文字 → Ref カラムで "-"


class TestEmptyRepositoryFallsBackToDash:
    def test_empty_repository_field_falls_back_to_dash(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        raw = [
            {
                "id": "x1",
                "updatedAt": "2026-04-01T10:00:00Z",
                "fieldValues": {
                    "nodes": [
                        {"field": {"name": WORKFLOW_FIELD}, "name": "Ready"},
                    ]
                },
                "content": {
                    "number": 7,
                    "title": "No Repo Item",
                    "state": "OPEN",
                    "url": "https://example.com/7",
                    "labels": {"nodes": []},
                    "repository": {},
                },
            },
        ]
        mock_graphql_route(raw)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info"],
        )

        assert result.exit_code == 0, result.output
        assert "| #7 | No Repo Item |" in result.stdout


# ケース 11: --json 単独 (--repo なし) で全件表示 (SC-004 退行検知)


class TestJsonNoRepoShowsAllItems:
    def test_json_no_repo_shows_all_items(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info", "--json"],
        )

        assert result.exit_code == 0, result.output
        payload = json.loads(result.stdout)
        repos = {i["content"]["repository"] for i in payload["board"]["items"]}
        assert "ownerA/repoA" in repos
        assert "ownerB/repoB" in repos
        assert "ownerC/repoC" in repos


# ケース 12: project info --repo invalid で BadParameter CLI 統合検証


class TestInvalidRepoProjectInfoCliBadParameter:
    def test_invalid_repo_via_project_info_cli_bad_parameter(
        self, mock_config, mock_graphql_route, mock_dependabot_alerts_route
    ) -> None:
        # BadParameter で早期終了するため GraphQL 呼び出しは発生しない想定。
        # route を登録しておき call_count == 0 で未到達を検証する。
        route = mock_graphql_route(SAMPLE_RAW_ITEMS)

        result = _run_with_patches(
            _patch_project_info(mock_config),
            ["project", "info", "--repo", "invalid"],
        )

        assert result.exit_code != 0
        assert "must be in 'owner/repo' form" in result.output
        # list_project_items (GraphQL POST) は呼ばれない
        assert route.call_count == 0
