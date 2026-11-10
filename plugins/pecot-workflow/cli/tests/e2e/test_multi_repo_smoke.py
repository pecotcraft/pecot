"""tests/e2e/test_multi_repo_smoke.py - Phase 8 US6 マルチリポ E2E smoke.

US2 / US4 / US5 の串刺し検証を ``respx`` + ``pytest`` の CUJ 1-4 + spike として実装する。

各ケースは実 ``pecot`` CLI を ``CliRunner.invoke()`` 経由で起動し、stdout / stderr
/ exit_code を assert する。HTTP 層は ``respx_mock``（``pytest-respx`` が自動登録する
fixture）で GitHub API への POST を捕捉する。respx 到達証明として各ケースで
``route.call_count`` を検証する。

**Host**: GHES (``ghes.example.com``) を採用している。理由は次の 2 点。

1. 既存 48 ケース (test_multi_repo_epic_routing.py 等) が ``ghes.example.com`` 前提で書かれており、整合性を取るため。
2. ``GitHubClient._setup_urls`` (github.py:1100-1108) は host 別に URL を切り替える。
   - ``github.com`` → ``https://api.github.com/graphql`` / ``https://api.github.com``
   - GHES → ``https://{host}/api/graphql`` / ``https://{host}/api/v3``。
   smoke の 2 本柱である GraphQL + REST 両方の URL ルーティングを通す。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import respx
from gql import gql

from cli.commands.main import app
from cli.core.config import (
    FieldOptions,
    Project,
    ProjectConfig,
    ProjectFields,
    Repository,
)
from cli.core.github import GitHubClient
from cli.core.repo_resolver import RepoRef

# Host / URL 定数

HOST = "ghes.example.com"
GRAPHQL_URL = f"https://{HOST}/api/graphql"
REST_BASE = f"https://{HOST}/api/v3"


# 共通 ProjectConfig factory


def _make_config(
    *,
    aggregation_repo: str | None,
    repositories: list[tuple[str, str]],
) -> ProjectConfig:
    """``host=ghes.example.com`` 固定のテスト用 ProjectConfig を返す。"""
    return ProjectConfig(
        host=HOST,
        owner="ownerA",
        workflow_suffix="smoke",
        project=Project(
            number=1,
            id="PVT_smoke",
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
            for o, n in repositories
        ],
        aggregation_repo=aggregation_repo,
    )


# Spike: respx が gql[httpx] の POST を捕捉できるか確認


def test_spike_respx_intercepts_gql(respx_mock: respx.MockRouter) -> None:
    """Spike: respx が ``gql.transport.httpx.HTTPXTransport`` をフック可能か検証。

    CUJ 1-4 の前提である「respx が gql[httpx] の POST をインターセプトする」
    仮定を最小構成で証明する。失敗した場合は CUJ 1-4 も通らない。
    そのため、最初に失敗すべき早期警告テストとして先頭に置く。
    """
    route = respx_mock.post(GRAPHQL_URL).mock(
        return_value=httpx.Response(200, json={"data": {"viewer": {"login": "test"}}})
    )

    with (
        patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        patch.object(GitHubClient, "_get_token", return_value="test_token"),
    ):
        client = GitHubClient(host=HOST, token="test_token")
        result = client._graphql.execute(gql("query { viewer { login } }"))

    assert route.call_count == 1
    assert result["viewer"]["login"] == "test"


# CUJ 1: US2 × respx — cross-repo issue read


def test_cross_repo_issue_read(respx_mock: respx.MockRouter) -> None:
    """`pecot issue read ownerB/repoB/42` がクロスリポ read で Markdown を出す。"""
    config = _make_config(
        aggregation_repo=None,
        repositories=[("ownerA", "repoA"), ("ownerB", "repoB")],
    )

    graphql_payload = {
        "data": {
            "repository": {
                "issue": {
                    "number": 42,
                    "state": "OPEN",
                    "title": "Cross-repo Issue",
                    "body": "Body text",
                    "comments": {"totalCount": 0, "nodes": []},
                    "parent": None,
                    "subIssues": {"nodes": []},
                    "linkedBranches": {"nodes": []},
                    "timelineItems": {"nodes": []},
                },
            },
        }
    }
    graphql_route = respx_mock.post(GRAPHQL_URL).mock(
        return_value=httpx.Response(200, json=graphql_payload)
    )

    with (
        patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        patch("cli.commands.issue.load_active_config", return_value=config),
        patch.object(GitHubClient, "_get_token", return_value="test_token"),
    ):
        from typer.testing import CliRunner

        runner = CliRunner()
        result = runner.invoke(app, ["issue", "read", "ownerB/repoB/42"], catch_exceptions=False)

    assert result.exit_code == 0, result.stdout + result.stderr
    assert "## #42 Cross-repo Issue" in result.stdout
    assert "**State:** OPEN" in result.stdout
    assert "Body text" in result.stdout
    assert graphql_route.call_count == 1


# CUJ 2: US4 × respx — aggregation_repo ルーティング


def test_epic_aggregation_routing(respx_mock: respx.MockRouter) -> None:
    """`pecot issue create --type epic` が `--repo` 省略で aggregation_repo に作成される。

    実装では ``create_issue`` が REST (``POST /repos/{owner}/{repo}/issues``) を叩く。
    その後 GraphQL で ``add_to_project`` を呼ぶ (github.py:1330 / :1535)。
    GHES では REST URL が ``https://{host}/api/v3/repos/...`` になる。
    GraphQL URL は ``https://{host}/api/graphql`` になる。
    そのため両 route を登録する。
    """
    config = _make_config(
        aggregation_repo="ownerA/hub-repo",
        repositories=[("ownerA", "hub-repo"), ("ownerA", "impl-repo")],
    )

    # REST: POST /api/v3/repos/ownerA/hub-repo/issues → Issue 作成
    rest_route = respx_mock.post(f"{REST_BASE}/repos/ownerA/hub-repo/issues").mock(
        return_value=httpx.Response(
            201,
            json={
                "number": 100,
                "html_url": f"https://{HOST}/ownerA/hub-repo/issues/100",
                "node_id": "I_100",
            },
        )
    )

    # GraphQL: add_to_project (MUTATION_ADD_TO_PROJECT)。
    # workflow フィールド設定は MUTATION_UPDATE_PROJECT_ITEM_FIELD。
    # 両 mutation が同一 URL に POST される。
    # そのため、両方のキーを含むレスポンスを返し、mutation の種別を問わず満たす。
    graphql_route = respx_mock.post(GRAPHQL_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "data": {
                    "addProjectV2ItemById": {"item": {"id": "PVTI_100"}},
                    "updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_100"}},
                }
            },
        )
    )

    epic_body = (
        "## AS-IS — 現状\n\n現状の事実\n\n"
        "## TO-BE — 完了時の状態\n\n完了時にどうなっているか\n\n"
        "## GAP — 埋めるべき差分\n\nAS-IS と TO-BE の差\n"
    )

    with (
        patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        patch("cli.commands.issue.load_active_config", return_value=config),
        patch.object(ProjectConfig, "is_repo_in_project", return_value=True),
        patch.object(GitHubClient, "_get_token", return_value="test_token"),
    ):
        from typer.testing import CliRunner

        runner = CliRunner()
        result = runner.invoke(
            app,
            [
                "issue",
                "create",
                "--type",
                "epic",
                "-t",
                "Parent Epic",
                "-m",
                epic_body,
            ],
        )

    assert result.exit_code == 0, result.stdout + result.stderr
    assert "created: Issue ownerA/hub-repo/100" in result.stderr
    assert f"https://{HOST}/ownerA/hub-repo/issues/100" in result.stdout
    assert "warning: --repo" not in result.stderr
    # status 既定値 backlog がボードに設定される (#669)
    assert "status backlog" in result.stderr
    # aggregation_repo へルーティングされたこと (REST URL パスに hub-repo が含まれる)
    assert rest_route.call_count == 1
    # GraphQL は add_to_project と workflow フィールド設定 (status=backlog) の 2 回到達する。
    # status 未指定の epic は型既定値 backlog が充填され、update を呼ぶため (#669)。
    assert graphql_route.call_count == 2


# CUJ 3: US4 × semantic — worktree reject (respx 不要)


def test_worktree_repo_mismatch_reject(tmp_path) -> None:
    """`pecot --repo ownerB/repoB worktree add ...` がカレント Git 不一致で exit 1。"""
    with patch(
        "cli.core.repo_resolver._detect_current_git_repo",
        return_value=(RepoRef(owner="ownerA", repo="repoA"), "origin"),
    ):
        from typer.testing import CliRunner

        runner = CliRunner()
        result = runner.invoke(
            app,
            [
                "--repo",
                "ownerB/repoB",
                "worktree",
                "add",
                "-D",
                str(tmp_path),
            ],
        )

    assert result.exit_code == 1
    assert (
        "error: --repo ownerB/repoB とカレント Git remote (ownerA/repoA) が不一致です。"
        in result.stderr
    )
    assert "worktree / branch はローカル Git 破壊防止のため拒否します。" in result.stderr
    assert result.stdout == ""


# CUJ 4: US5 × respx — project info --repo filter


def test_project_info_repo_filter(respx_mock: respx.MockRouter) -> None:
    """`pecot project info --repo ownerA/repoA` が ownerA/repoA のみを Ref 表示する。"""
    workflow_field = "pecot-workflow-smoke"

    def _item(item_id: str, number: int, title: str, workflow: str, owner: str, repo: str) -> dict:
        return {
            "id": item_id,
            "updatedAt": "2026-04-01T10:00:00Z",
            "fieldValues": {"nodes": [{"field": {"name": workflow_field}, "name": workflow}]},
            "content": {
                "number": number,
                "title": title,
                "state": "OPEN",
                "url": f"https://{HOST}/{owner}/{repo}/issues/{number}",
                "labels": {"nodes": []},
                "repository": {"owner": {"login": owner}, "name": repo},
            },
        }

    graphql_payload = {
        "data": {
            "node": {
                "items": {
                    "nodes": [
                        _item("i1", 1, "A-1 Ready", "Ready", "ownerA", "repoA"),
                        _item("i2", 2, "A-2 Active", "Active", "ownerA", "repoA"),
                        _item("i3", 10, "B-10 Ready", "Ready", "ownerB", "repoB"),
                        _item("i4", 11, "B-11 Active", "Active", "ownerB", "repoB"),
                    ],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                },
            }
        }
    }
    graphql_route = respx_mock.post(GRAPHQL_URL).mock(
        return_value=httpx.Response(200, json=graphql_payload)
    )
    # project info は登録リポごとに Dependabot alert の一覧も取りに行く（全リポ open 0 件）
    respx_mock.get(url__regex=rf"^{REST_BASE}/repos/[^/]+/[^/]+/dependabot/alerts").mock(
        return_value=httpx.Response(200, json=[])
    )

    config = _make_config(
        aggregation_repo=None,
        repositories=[("ownerA", "repoA"), ("ownerB", "repoB")],
    )
    config_path = MagicMock()
    config_path.stem = "smoke-project"

    with (
        patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        patch.object(GitHubClient, "_get_token", return_value="test_token"),
        patch("cli.commands.project.load_active_config", return_value=config),
        patch(
            "cli.commands.project.get_active_config_path",
            return_value=config_path,
        ),
    ):
        from typer.testing import CliRunner

        runner = CliRunner()
        result = runner.invoke(app, ["project", "info", "--repo", "ownerA/repoA"])

    assert result.exit_code == 0, result.stdout + result.stderr
    assert "| Ref | タイトル |" in result.stdout
    assert "## ボード状況 (フィルタ: ownerA/repoA)" in result.stdout
    # ownerA/repoA# で始まる Ref が 2 件現れる
    assert result.stdout.count("ownerA/repoA#") == 2
    assert "ownerB/repoB#" not in result.stdout
    assert graphql_route.call_count == 1
