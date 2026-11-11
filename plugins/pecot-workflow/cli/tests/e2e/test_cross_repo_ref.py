"""tests/e2e/test_cross_repo_ref.py - クロスリポ参照 E2E (Phase 4 US2 / T037)。

``pecot issue read`` / ``pecot pr read`` の動作を CliRunner で検証する。
主軸形式 ``owner/repo/N`` と短縮形 ``N`` + ``--repo`` の両パスが解決されること。
``#5`` 形式が非 0 終了でエラーメッセージを返すこと。

Phase 8 US6 拡張: GitHubClient の全差し替えを止め、respx で GraphQL 層を
モックする方式に移行済み。request JSON の ``variables`` を検証して
owner/repo/number ルーティングを保証する。
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest
import respx
from typer.testing import CliRunner
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands.main import app
from cli.core.github import GitHubClient

runner = CliRunner()

HOST = "ghes.example.com"
GRAPHQL_URL = f"https://{HOST}/api/graphql"


ISSUE_GRAPHQL_PAYLOAD = {
    "data": {
        "repository": {
            "issue": {
                "number": 5,
                "state": "OPEN",
                "title": "[Task] テストタスク",
                "body": "## 目的\n\nテスト用本文。",
                "comments": {"totalCount": 0, "nodes": []},
                "parent": None,
                "subIssues": {"nodes": []},
                "linkedBranches": {"nodes": []},
                "timelineItems": {"nodes": []},
            },
        },
    }
}

PR_GRAPHQL_PAYLOAD = {
    "data": {
        "repository": {
            "pullRequest": {
                "number": 5,
                "state": "OPEN",
                "title": "テスト PR",
                "body": "PR 本文",
                "headRefName": "feat/test",
                "baseRefName": "main",
                "isDraft": False,
                "mergeable": "MERGEABLE",
                "comments": {"totalCount": 0},
                "closingIssuesReferences": {"nodes": []},
                "reviews": {"nodes": []},
            },
        },
    }
}


@pytest.fixture
def mock_config():
    """``load_active_config`` が返すダミー設定（host のみ参照される）。"""
    cfg = MagicMock()
    cfg.host = HOST
    return cfg


def _assert_variables(route: respx.Route, owner: str, repo: str, number: int) -> None:
    """respx route の最後の request body から GraphQL variables を検証する。"""
    assert route.call_count == 1
    request = route.calls[-1].request
    payload = json.loads(request.content)
    variables = payload.get("variables", {})
    assert variables.get("owner") == owner
    assert variables.get("repo") == repo
    assert variables.get("number") == number


class TestIssueReadCrossRepo:
    """pecot issue read のクロスリポ参照 E2E"""

    def test_full_form(self, respx_mock: respx.MockRouter, mock_config) -> None:
        """CUJ1: 主軸形式 ``owner/repo/N`` で他リポの Issue を読める。"""
        route = respx_mock.post(GRAPHQL_URL).mock(
            return_value=httpx.Response(200, json=ISSUE_GRAPHQL_PAYLOAD)
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch.object(GitHubClient, "_get_token", return_value="test_token"),
            patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        ):
            result = runner.invoke(app, ["issue", "read", "ownerX/repoX/5"])

        assert result.exit_code == 0
        _assert_variables(route, "ownerX", "repoX", 5)

    @add_test_properties(verifies=["PW-ISSUE-READ-09"])
    def test_shorthand_with_repo_option(self, respx_mock: respx.MockRouter, mock_config) -> None:
        """CUJ2: 短縮形 ``N`` + ``--repo`` で同じ fetch が発火する。"""
        route = respx_mock.post(GRAPHQL_URL).mock(
            return_value=httpx.Response(200, json=ISSUE_GRAPHQL_PAYLOAD)
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch.object(GitHubClient, "_get_token", return_value="test_token"),
            patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        ):
            result = runner.invoke(app, ["--repo", "ownerX/repoX", "issue", "read", "5"])

        assert result.exit_code == 0
        _assert_variables(route, "ownerX", "repoX", 5)

    @add_test_properties(verifies=["PW-ISSUE-READ-10"])
    def test_hash_only_rejected(self, respx_mock: respx.MockRouter, mock_config) -> None:
        """CUJ5: ``#5`` だけはパース失敗で exit=2、GitHub API は呼ばれない。"""
        route = respx_mock.post(GRAPHQL_URL).mock(
            return_value=httpx.Response(200, json=ISSUE_GRAPHQL_PAYLOAD)
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch.object(GitHubClient, "_get_token", return_value="test_token"),
            patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        ):
            result = runner.invoke(app, ["issue", "read", "#5"])

        assert result.exit_code == 2
        # GitHub API は呼ばれない
        assert route.call_count == 0

    def test_shorthand_without_repo_outside_git_errors(
        self, respx_mock: respx.MockRouter, mock_config
    ) -> None:
        """CUJ8 相当: 短縮形 + git 外 + ``--repo`` なしは RefParseError で exit=2。"""
        route = respx_mock.post(GRAPHQL_URL).mock(
            return_value=httpx.Response(200, json=ISSUE_GRAPHQL_PAYLOAD)
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch.object(GitHubClient, "_get_token", return_value="test_token"),
            patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
            patch(
                "cli.core.repo_resolver._detect_current_git_repo",
                return_value=None,
            ),
        ):
            result = runner.invoke(app, ["issue", "read", "5"])

        assert result.exit_code == 2
        assert route.call_count == 0

    def test_invalid_ref_exit2_with_accepted_forms_in_stderr(
        self, respx_mock: respx.MockRouter, mock_config
    ) -> None:
        """CUJ4 相当: 不正形式 ``owner//5`` で exit=2、stderr にaccepted forms2種が含まれること。"""
        route = respx_mock.post(GRAPHQL_URL).mock(
            return_value=httpx.Response(200, json=ISSUE_GRAPHQL_PAYLOAD)
        )

        with (
            patch("cli.commands.issue.load_active_config", return_value=mock_config),
            patch.object(GitHubClient, "_get_token", return_value="test_token"),
            patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        ):
            result = runner.invoke(app, ["issue", "read", "owner//5"])

        assert result.exit_code == 2
        assert route.call_count == 0
        # stderr にaccepted forms2種類が列挙されること
        assert "accepted forms" in result.output or "accepted forms" in (
            result.stderr if hasattr(result, "stderr") else ""
        )
        # typer の CliRunner は stderr を output に混ぜるため output でも確認
        combined = result.output + (result.stderr if hasattr(result, "stderr") else "")
        assert "owner/repo/N" in combined
        assert "owner/repo#N" not in combined


class TestPRReadCrossRepo:
    """pecot pr read のクロスリポ参照 E2E"""

    def test_full_form(self, respx_mock: respx.MockRouter, mock_config) -> None:
        """CUJ6: 主軸形式 ``owner/repo/N`` で他リポの PR を読める。"""
        route = respx_mock.post(GRAPHQL_URL).mock(
            return_value=httpx.Response(200, json=PR_GRAPHQL_PAYLOAD)
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch.object(GitHubClient, "_get_token", return_value="test_token"),
            patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        ):
            result = runner.invoke(app, ["pr", "read", "ownerX/repoX/5"])

        assert result.exit_code == 0
        _assert_variables(route, "ownerX", "repoX", 5)

    def test_shorthand_with_repo_option(self, respx_mock: respx.MockRouter, mock_config) -> None:
        """CUJ6: 短縮形 ``N`` + ``--repo`` で同じ fetch が発火する。"""
        route = respx_mock.post(GRAPHQL_URL).mock(
            return_value=httpx.Response(200, json=PR_GRAPHQL_PAYLOAD)
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch.object(GitHubClient, "_get_token", return_value="test_token"),
            patch.object(GitHubClient, "_retry_with_fallback_token", return_value=None),
        ):
            result = runner.invoke(app, ["--repo", "ownerX/repoX", "pr", "read", "5"])

        assert result.exit_code == 0
        _assert_variables(route, "ownerX", "repoX", 5)
