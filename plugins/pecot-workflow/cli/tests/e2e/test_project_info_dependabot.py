"""tests/e2e/test_project_info_dependabot.py - project info の Dependabot alert 表示 E2E。

``pecot project info`` が登録リポごとに Dependabot alert の状態を出すことを、
本物の ``GitHubClient`` を respx に通して検証する。

- repoA: 一覧が Link ヘッダの ``rel="next"`` で 2 ページ → ``open 3``
- repoB: 一覧 403 + vulnerability-alerts 404 → ``無効``
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import respx
from typer.testing import CliRunner

from cli.commands.main import app
from cli.core.config import (
    FieldOptions,
    Project,
    ProjectConfig,
    ProjectFields,
    Repository,
)
from cli.core.github import GitHubClient

runner = CliRunner()

HOST = "ghes.example.com"
GRAPHQL_URL = f"https://{HOST}/api/graphql"
REST_BASE = f"https://{HOST}/api/v3"
NEXT_URL = f"{REST_BASE}/repos/ownerA/repoA/dependabot/alerts?after=cursor1"


def _config() -> ProjectConfig:
    return ProjectConfig(
        host=HOST,
        owner="ownerA",
        workflow_suffix="test",
        project=Project(
            number=1,
            id="proj-id",
            fields=ProjectFields(
                workflow=FieldOptions(id="F_workflow", options={"backlog": "o_backlog"})
            ),
        ),
        repositories=[
            Repository(owner="ownerA", name="repoA", release_type="nx"),
            Repository(owner="ownerB", name="repoB"),
        ],
    )


def _alert(number: int) -> dict[str, object]:
    return {"number": number, "security_vulnerability": {"severity": "high"}}


def _run(respx_mock: respx.MockRouter, *args: str):  # type: ignore[no-untyped-def]
    respx_mock.post(GRAPHQL_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "data": {
                    "node": {
                        "items": {
                            "nodes": [],
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                        }
                    }
                }
            },
        )
    )
    config_path = MagicMock()
    config_path.stem = "dependabot-project"
    with (
        patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        patch.object(GitHubClient, "_get_token", return_value="test_token"),
        patch("cli.commands.project.load_active_config", return_value=_config()),
        patch("cli.commands.project.get_active_config_path", return_value=config_path),
    ):
        return runner.invoke(app, ["project", "info", *args])


def _register_routes(
    respx_mock: respx.MockRouter,
) -> tuple[respx.Route, respx.Route, respx.Route, respx.Route]:
    """repoA は 2 ページ、repoB は alerts 無効の応答を登録する"""
    page2 = respx_mock.get(NEXT_URL).mock(return_value=httpx.Response(200, json=[_alert(3)]))
    page1 = respx_mock.get(
        f"{REST_BASE}/repos/ownerA/repoA/dependabot/alerts",
        params={"state": "open", "per_page": "100"},
    ).mock(
        return_value=httpx.Response(
            200,
            json=[_alert(1), _alert(2)],
            headers={"Link": f'<{NEXT_URL}>; rel="next"'},
        )
    )
    list_b = respx_mock.get(f"{REST_BASE}/repos/ownerB/repoB/dependabot/alerts").mock(
        return_value=httpx.Response(
            403, json={"message": "Dependabot alerts are disabled for this repository."}
        )
    )
    check_b = respx_mock.get(f"{REST_BASE}/repos/ownerB/repoB/vulnerability-alerts").mock(
        return_value=httpx.Response(404, json={"message": "Not Found"})
    )
    return page1, page2, list_b, check_b


def test_markdown_shows_open_count_and_disabled(respx_mock: respx.MockRouter) -> None:
    page1, page2, list_b, check_b = _register_routes(respx_mock)

    result = _run(respx_mock)

    assert result.exit_code == 0, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    a = lines.index("    release_type: nx")
    assert lines[a + 1] == "    dependabot_alerts: open 3"
    b = lines.index("    release_type: single")
    assert lines[b + 1] == "    dependabot_alerts: 無効"
    assert page1.call_count == 1
    assert page2.call_count == 1
    assert list_b.call_count == 1
    assert check_b.call_count == 1


def test_json_includes_dependabot_alerts(respx_mock: respx.MockRouter) -> None:
    _register_routes(respx_mock)

    result = _run(respx_mock, "--json")

    assert result.exit_code == 0, result.stdout + result.stderr
    repos = json.loads(result.stdout)["repositories"]
    assert repos[0]["dependabot_alerts"] == {
        "enabled": True,
        "open_count": 3,
        "max_severity": "high",
        "alerts_url": f"https://{HOST}/ownerA/repoA/security/dependabot",
    }
    assert repos[1]["dependabot_alerts"] == {
        "enabled": False,
        "open_count": 0,
        "max_severity": None,
        "alerts_url": f"https://{HOST}/ownerB/repoB/security/dependabot",
    }
