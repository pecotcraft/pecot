"""tests/e2e/test_multi_repo_epic_routing.py - Phase 6 US4 SC-007。

``pecot issue create --type epic`` が ``aggregation_repo`` 設定を使って作成先リポジトリを決める。
その挙動を、GitHub API (REST + GraphQL) を ``respx`` で捕捉して 5 シナリオ分検証する。

挙動マトリクス (cli-commands.md §107-115) の 5 分岐を直接ドライブする。

- (A) aggregation_repo あり + ``--repo`` 省略 → aggregation_repo に作成、警告なし。
- (B) aggregation_repo あり + ``--repo`` = aggregation_repo → 明示値に作成、警告なし。
- (C) aggregation_repo あり + ``--repo`` ≠ aggregation_repo → 明示値に作成 + 警告。
- (D) aggregation_repo なし + ``--repo`` 省略 → exit 2、API は呼ばれない。
- (E) ファイルモード (frontmatter ``repository`` 明示) → そのまま尊重される。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from unittest.mock import patch

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
)
from cli.core.github import GitHubClient

runner = CliRunner()


HOST = "ghes.example.com"
GRAPHQL_URL = f"https://{HOST}/api/graphql"
REST_BASE = f"https://{HOST}/api/v3"


EPIC_BODY = """## AS-IS — 現状

テスト用の Epic 本文（現状の事実）。

## TO-BE — 完了時の状態

すべての Epic が意図したリポに作成されていること。

## GAP — 埋めるべき差分

作成先リポジトリの決め方がまだ検証されていない。
"""


def _make_config(aggregation_repo: str | None) -> ProjectConfig:
    """``aggregation_repo`` のみ変えたテスト用 ProjectConfig を返す。"""
    return ProjectConfig(
        host=HOST,
        owner="acme-labs",
        workflow_suffix="pecot",
        project=Project(
            number=1,
            id="PVT_xxx",
            fields=ProjectFields(
                workflow=FieldOptions(
                    id="F_workflow",
                    options={"backlog": "o1", "active": "o2"},
                )
            ),
        ),
        repositories=[],
        aggregation_repo=aggregation_repo,
    )


def _register_create_issue_route(
    respx_mock: respx.MockRouter,
    owner: str,
    repo: str,
    *,
    number: int = 42,
) -> respx.Route:
    """REST ``POST /repos/{owner}/{repo}/issues`` に 201 を返す route を登録する。"""
    return respx_mock.post(f"{REST_BASE}/repos/{owner}/{repo}/issues").mock(
        return_value=httpx.Response(
            201,
            json={
                "number": number,
                "html_url": f"https://{HOST}/{owner}/{repo}/issues/{number}",
                "node_id": "I_new",
            },
        )
    )


def _register_add_comment_route(
    respx_mock: respx.MockRouter,
    owner: str,
    repo: str,
    number: int,
) -> respx.Route:
    """REST ``POST /repos/{owner}/{repo}/issues/{number}/comments`` に 201 を返す route。"""
    return respx_mock.post(f"{REST_BASE}/repos/{owner}/{repo}/issues/{number}/comments").mock(
        return_value=httpx.Response(
            201,
            json={
                "id": 777,
                "html_url": f"https://{HOST}/{owner}/{repo}/issues/{number}#issuecomment-777",
            },
        )
    )


def _register_graphql_route(respx_mock: respx.MockRouter) -> respx.Route:
    """GraphQL ``POST /api/graphql`` に add_to_project 成功レスポンスを返す route。

    Epic 作成フローでは ``add_to_project`` の 1 本を呼ぶ。
    status 未指定の epic は型既定値 backlog が充填され、``update_project_item_field`` も呼ぶ (#669)。
    両 mutation が同一 URL に POST されるため、両キーを含むレスポンスを返して種別を問わず満たす。
    複数回到達しても同じレスポンスで許容する。
    """
    return respx_mock.post(GRAPHQL_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "data": {
                    "addProjectV2ItemById": {"item": {"id": "PVTI_xxx"}},
                    "updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_xxx"}},
                }
            },
        )
    )


@pytest.fixture(autouse=True)
def _stub_token_and_fallback():
    """全テストで GitHubClient が環境非依存に動くよう token / 401 retry を封じる。"""
    with (
        patch.object(GitHubClient, "_get_token", return_value="test_token"),
        patch.object(GitHubClient, "_retry_with_fallback_token", return_value=False),
    ):
        yield


def _invoke_direct(
    args: list[str],
    *,
    config: ProjectConfig,
):
    """``pecot issue create --type epic -m ...`` を実行するヘルパ。"""
    with (
        patch("cli.commands.issue.load_active_config", return_value=config),
        patch.object(ProjectConfig, "is_repo_in_project", return_value=True),
    ):
        return runner.invoke(app, args)


class TestEpicRoutingDirect:
    """``-m`` 直接投稿モードのルーティング検証 (シナリオ A-D)"""

    @add_test_properties(verifies=["PW-ISSUE-CREATE-14"])
    def test_A_aggregation_set_repo_omitted(self, respx_mock: respx.MockRouter) -> None:
        """(A) aggregation_repo あり + --repo 省略 → aggregation_repo に作成。"""
        config = _make_config("acme-labs/aist-roadmap")
        rest_route = _register_create_issue_route(respx_mock, "acme-labs", "aist-roadmap")
        _register_graphql_route(respx_mock)

        result = _invoke_direct(
            [
                "issue",
                "create",
                "--type",
                "epic",
                "-t",
                "Sample Epic",
                "-m",
                EPIC_BODY,
            ],
            config=config,
        )

        assert result.exit_code == 0, result.output
        # aggregation_repo の owner/repo で create_issue REST が呼ばれる
        assert rest_route.call_count == 1
        # 警告は出ていない
        assert "警告: --repo" not in result.stderr
        assert "warning:" not in result.stderr

    def test_B_aggregation_set_repo_matches(self, respx_mock: respx.MockRouter) -> None:
        """(B) --repo が aggregation_repo と一致 → 警告なく作成。"""
        config = _make_config("acme-labs/aist-roadmap")
        rest_route = _register_create_issue_route(respx_mock, "acme-labs", "aist-roadmap")
        _register_graphql_route(respx_mock)

        result = _invoke_direct(
            [
                "issue",
                "create",
                "--type",
                "epic",
                "-t",
                "Sample Epic",
                "-r",
                "acme-labs/aist-roadmap",
                "-m",
                EPIC_BODY,
            ],
            config=config,
        )

        assert result.exit_code == 0, result.output
        assert rest_route.call_count == 1
        assert "warning:" not in result.stderr

    @add_test_properties(verifies=["PW-ISSUE-CREATE-15"])
    def test_C_aggregation_set_repo_mismatch_warns(self, respx_mock: respx.MockRouter) -> None:
        """(C) --repo と aggregation_repo が不一致 → 警告ありで明示値に作成。"""
        config = _make_config("acme-labs/aist-roadmap")
        # 明示された --repo (pecot-cli) 側に REST route を登録
        rest_route = _register_create_issue_route(respx_mock, "acme-labs", "pecot-cli")
        _register_graphql_route(respx_mock)

        result = _invoke_direct(
            [
                "issue",
                "create",
                "--type",
                "epic",
                "-t",
                "Exception Epic",
                "-r",
                "acme-labs/pecot-cli",
                "-m",
                EPIC_BODY,
            ],
            config=config,
        )

        assert result.exit_code == 0, result.output
        # 明示された --repo が採用される
        assert rest_route.call_count == 1
        # REST request body の title が指定値で送られている。
        # semantic 時代の ``mock.assert_called_once_with(..., title="[Epic] Exception Epic", ...)`` 相当。
        # epic タイプは ``[Epic] `` プレフィックスが自動付与される。
        request_body = json.loads(rest_route.calls[0].request.content)
        assert request_body["title"] == "[Epic] Exception Epic"
        # cli-commands.md §124-128 の警告文言
        assert "acme-labs/pecot-cli" in result.stderr
        assert "aggregation_repo" in result.stderr
        assert "acme-labs/aist-roadmap" in result.stderr
        assert "continuing as an exception for an Epic in an implementation repo" in result.stderr

    @add_test_properties(verifies=["PW-ISSUE-CREATE-42"])
    def test_D_aggregation_unset_repo_omitted_exits_2(self, respx_mock: respx.MockRouter) -> None:
        """(D) aggregation_repo なし + --repo 省略 → exit 2、API 到達なし。"""
        config = _make_config(None)
        # HTTP へ届いたら失敗扱いにするため catch-all route を張る
        rest_route = _register_create_issue_route(respx_mock, "acme-labs", "aist-roadmap")
        graphql_route = _register_graphql_route(respx_mock)

        result = _invoke_direct(
            [
                "issue",
                "create",
                "--type",
                "epic",
                "-t",
                "Orphan Epic",
                "-m",
                EPIC_BODY,
            ],
            config=config,
        )

        assert result.exit_code == 2, result.output
        # cli-commands.md §117-122 の固定文言
        assert "cannot decide where to create the Epic" in result.stderr
        assert "aggregation_repo" in result.stderr
        assert "--repo" in result.stderr
        # API には到達していない
        assert rest_route.call_count == 0
        assert graphql_route.call_count == 0


class TestEpicRoutingFromFile:
    """ファイルモード (シナリオ E) のルーティング検証"""

    def test_E_frontmatter_repo_respected(
        self,
        tmp_path: Path,
        respx_mock: respx.MockRouter,
    ) -> None:
        """(E) frontmatter で明示された repository はそのまま尊重される。"""
        config = _make_config("acme-labs/aist-roadmap")
        # frontmatter に異なるリポを明示 → warn フラグが立ちつつそちらに作成
        file = tmp_path / "epic.md"
        file.write_text(
            "---\n"
            'title: "File Epic"\n'
            "type: epic\n"
            'repository: "acme-labs/pecot-cli"\n'
            "status: backlog\n"
            "labels: []\n"
            "---\n\n" + EPIC_BODY,
            encoding="utf-8",
        )
        rest_route = _register_create_issue_route(respx_mock, "acme-labs", "pecot-cli")
        _register_graphql_route(respx_mock)

        with (
            patch("cli.commands.issue.load_active_config", return_value=config),
            patch.object(ProjectConfig, "is_repo_in_project", return_value=True),
        ):
            result = runner.invoke(app, ["issue", "create", str(file)])

        assert result.exit_code == 0, result.output
        assert rest_route.call_count == 1
        # 到達した REST URL が frontmatter で指定された repo であることを確認
        called_url = str(rest_route.calls[0].request.url)
        assert "/repos/acme-labs/pecot-cli/issues" in called_url
        # aggregation_repo と不一致なので警告が出ている
        assert "aggregation_repo" in result.stderr

    def test_E2_frontmatter_without_repo_routes_to_aggregation(
        self,
        tmp_path: Path,
        respx_mock: respx.MockRouter,
    ) -> None:
        """(E2) frontmatter ``repository`` 未指定 + aggregation_repo あり
        → aggregation_repo にルーティング、警告なし。

        ``_issue_create_from_file`` の fallback (空文字 → None) を検証する。
        """
        config = _make_config("acme-labs/aist-roadmap")
        file = tmp_path / "epic.md"
        # repository を空文字で明示（未指定扱い）
        file.write_text(
            "---\n"
            'title: "Fallback Epic"\n'
            "type: epic\n"
            'repository: ""\n'
            "status: backlog\n"
            "labels: []\n"
            "---\n\n" + EPIC_BODY,
            encoding="utf-8",
        )
        rest_route = _register_create_issue_route(respx_mock, "acme-labs", "aist-roadmap")
        _register_graphql_route(respx_mock)

        with (
            patch("cli.commands.issue.load_active_config", return_value=config),
            patch.object(ProjectConfig, "is_repo_in_project", return_value=True),
        ):
            result = runner.invoke(app, ["issue", "create", str(file)])

        assert result.exit_code == 0, result.output
        # aggregation_repo の owner/repo にルーティングされる
        assert rest_route.call_count == 1
        called_url = str(rest_route.calls[0].request.url)
        assert "/repos/acme-labs/aist-roadmap/issues" in called_url
        # title を REST body から追加検証（フロー再現）
        body = json.loads(rest_route.calls[0].request.content.decode("utf-8"))
        assert body["title"].endswith("Fallback Epic") or "Fallback Epic" in body["title"]
        # 例外ルーティングの警告は出ない
        assert "differs from aggregation_repo" not in result.stderr
        assert "continuing as an exception" not in result.stderr


# --prepare 雛形の見出しは全て `## 名前 — <サマリ>` 形式。利用者が最初にやる編集を模す。
_HEADING_SUMMARY_RE = re.compile(r"^(#{2,6} .+?) — <[^>]*>$", re.MULTILINE)
# 投稿本文の見出し行に残ってはならない未編集プレースホルダ
_HEADING_PLACEHOLDER_RE = re.compile(r"^#{2,6} .*<[^>]+>.*$", re.MULTILINE)
# 本文側の未編集プレースホルダ（改行を跨がせない）
_BODY_PLACEHOLDER_RE = re.compile(r"<(?!/?(?:details|summary)[\s>])[^<>\n]+>")


def _fill_placeholders(content: str) -> str:
    """雛形の `<...>` を実コンテンツに置換する（利用者がやる編集）。

    #962 で投稿本文のプレースホルダ残存も reject 対象になったため、
    見出しサマリだけでなく本文の箇条書きプレースホルダも埋める。
    入れ子（`<... `<Issue番号>` ...>`）があるため、変化しなくなるまで繰り返す。
    """
    content = _HEADING_SUMMARY_RE.sub(r"\1 — 見本サマリ", content)
    while True:
        filled = _BODY_PLACEHOLDER_RE.sub("見本", content)
        if filled == content:
            return content
        content = filled


def _assert_clean_posted_body(body: str) -> None:
    """投稿本文にガイドコメントと未編集見出しプレースホルダが残っていない"""
    assert "<!--" not in body, f"冒頭ガイドコメントが投稿本文に残っている:\n{body}"
    leftover = _HEADING_PLACEHOLDER_RE.search(body)
    assert leftover is None, f"見出しに未編集プレースホルダが残っている: {leftover}"


class TestPreparedTemplateRoundtrip:
    """``--prepare`` が出す雛形をそのまま投稿処理に流すラウンドトリップ検証"""

    @pytest.mark.parametrize(
        ("template", "prepare_args"),
        [
            ("epic", ["--template", "epic"]),
            ("task", ["--template", "task", "--repo", "acme-labs/aist-roadmap"]),
            ("bug", ["--template", "bug", "--repo", "acme-labs/aist-roadmap"]),
            (
                "task-implement",
                ["--template", "task-implement", "--repo", "acme-labs/aist-roadmap"],
            ),
        ],
    )
    def test_F_prepared_template_roundtrip(
        self,
        template: str,
        prepare_args: list[str],
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        respx_mock: respx.MockRouter,
    ) -> None:
        """(F) ``--prepare`` の生成物は、見出しサマリと title を埋めるだけで
        ``issue create`` の投稿時検証を通過する。
        投稿本文にガイドコメントと未編集プレースホルダは残らない。

        テンプレート実体と検証器の食い違いを検出する唯一の手段（#958 F-02 / F-06）。
        検証器は ``extract_sections_from_template`` と ``validate_sections``。
        epic は ``repository`` を aggregation_repo から補完し、他 3 種は
        ``--repo`` で書き込む。
        """
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "output"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        prepare_result = runner.invoke(app, ["issue", "create", "--prepare", *prepare_args])
        assert prepare_result.exit_code == 0, prepare_result.output

        prepared = list(output_dir.glob(f"issue-{template}-*.md"))
        assert len(prepared) == 1
        file = prepared[0]

        # 利用者がやる編集: 見出しサマリ・本文プレースホルダ・frontmatter の title。
        content = _fill_placeholders(file.read_text(encoding="utf-8"))
        content = content.replace('title: ""', 'title: "Prepared Issue"', 1)
        file.write_text(content, encoding="utf-8")

        config = _make_config("acme-labs/aist-roadmap")
        rest_route = _register_create_issue_route(respx_mock, "acme-labs", "aist-roadmap")
        _register_graphql_route(respx_mock)

        with (
            patch("cli.commands.issue.load_active_config", return_value=config),
            patch.object(ProjectConfig, "is_repo_in_project", return_value=True),
        ):
            result = runner.invoke(app, ["issue", "create", str(file)])

        assert result.exit_code == 0, result.output + result.stderr
        assert rest_route.call_count == 1
        called_url = str(rest_route.calls[0].request.url)
        assert "/repos/acme-labs/aist-roadmap/issues" in called_url
        body = json.loads(rest_route.calls[0].request.content.decode("utf-8"))
        assert "Prepared Issue" in body["title"]
        _assert_clean_posted_body(body["body"])


class TestPreparedCommentTemplateRoundtrip:
    """``issue comment --prepare`` が出す雛形をそのまま投稿処理に流すラウンドトリップ検証"""

    @pytest.mark.parametrize(
        "template",
        [
            "plan",
            "merge-diff",
            "precede-notify",
            "review-findings",
            "review-resolution",
        ],
    )
    def test_prepared_comment_template_roundtrip(
        self,
        template: str,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        respx_mock: respx.MockRouter,
    ) -> None:
        """``--prepare`` の生成物は、プレースホルダを埋めるだけで ``issue comment`` の
        投稿時検証を通過する。投稿本文にガイドコメントと未編集プレースホルダは残らない。

        コメント側テンプレート実体と検証器
        (``extract_sections_from_template`` / ``validate_sections``) の食い違いを
        検出する手段。見出しを改名したときに片側だけ直す失敗を止める（#1016）。
        """
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "output"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        prepare_result = runner.invoke(
            app,
            [
                "issue",
                "comment",
                "--prepare",
                "--template",
                template,
                "--issue",
                "acme-labs/aist-roadmap/123",
            ],
        )
        assert prepare_result.exit_code == 0, prepare_result.output

        prepared = list(output_dir.glob(f"comment-{template}-*.md"))
        assert len(prepared) == 1
        file = prepared[0]

        # 利用者がやる編集: 見出しサマリと本文のプレースホルダを実コンテンツに置換。
        file.write_text(_fill_placeholders(file.read_text(encoding="utf-8")), encoding="utf-8")

        config = _make_config("acme-labs/aist-roadmap")
        rest_route = _register_add_comment_route(respx_mock, "acme-labs", "aist-roadmap", 123)

        with (
            patch("cli.commands.issue.load_active_config", return_value=config),
            patch.object(ProjectConfig, "is_repo_in_project", return_value=True),
        ):
            result = runner.invoke(app, ["issue", "comment", str(file)])

        assert result.exit_code == 0, result.output + result.stderr
        assert rest_route.call_count == 1
        body = json.loads(rest_route.calls[0].request.content.decode("utf-8"))
        _assert_clean_posted_body(body["body"])


class TestIssueizeBulkCreate:
    """w-issueize の 2 フェーズ一括投稿（``{{issue:<suffix>}}`` 展開）"""

    def test_two_phase_bulk_create_expands_placeholder(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        respx_mock: respx.MockRouter,
    ) -> None:
        """``--prepare --suffix`` で作った 2 ファイルを一括投稿する。
        phase2 の ``{{issue:phase1}}`` が phase1 の番号に展開される（#958 F-01）。

        雛形の冒頭ガイドコメントに書かれた ``{{issue:<suffix>}}`` を
        ``_validate_issue_placeholders`` が拾って exit 1 になっていた。その回帰を固定する。
        """
        import cli.commands.issue as issue_module

        output_dir = tmp_path / "output"
        monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)

        files: list[Path] = []
        for suffix in ("phase1", "phase2"):
            prepare_result = runner.invoke(
                app,
                [
                    "issue",
                    "create",
                    "--prepare",
                    "--template",
                    "task-implement",
                    "--repo",
                    "acme-labs/aist-roadmap",
                    "--suffix",
                    suffix,
                ],
            )
            assert prepare_result.exit_code == 0, prepare_result.output
            path = Path(prepare_result.stdout.strip().splitlines()[-1])
            assert path.name.endswith(f"-{suffix}.md")
            files.append(path)

        phase1, phase2 = files
        for path, title in ((phase1, "Phase 1"), (phase2, "Phase 2")):
            content = _fill_placeholders(path.read_text(encoding="utf-8"))
            content = content.replace('title: ""', f'title: "{title}"', 1)
            if path is phase2:
                # 本文の Goal の後ろに、phase1 の Issue を指す文を足す（冒頭のコメントの例には触れない）
                head, tail = content.rsplit("\n## Tasks\n", 1)
                content = f"{head}\n{{{{issue:phase1}}}} の成果物を使う。\n\n## Tasks\n{tail}"
            path.write_text(content, encoding="utf-8")

        assert "{{issue:phase1}}" in phase2.read_text(encoding="utf-8")

        config = _make_config("acme-labs/aist-roadmap")
        rest_route = respx_mock.post(f"{REST_BASE}/repos/acme-labs/aist-roadmap/issues").mock(
            side_effect=[
                httpx.Response(
                    201,
                    json={
                        "number": 101,
                        "html_url": f"https://{HOST}/acme-labs/aist-roadmap/issues/101",
                        "node_id": "I_101",
                    },
                ),
                httpx.Response(
                    201,
                    json={
                        "number": 102,
                        "html_url": f"https://{HOST}/acme-labs/aist-roadmap/issues/102",
                        "node_id": "I_102",
                    },
                ),
            ]
        )
        _register_graphql_route(respx_mock)

        with (
            patch("cli.commands.issue.load_active_config", return_value=config),
            patch.object(ProjectConfig, "is_repo_in_project", return_value=True),
        ):
            result = runner.invoke(app, ["issue", "create", str(phase1), str(phase2)])

        assert result.exit_code == 0, result.output + result.stderr
        assert rest_route.call_count == 2

        phase1_body = json.loads(rest_route.calls[0].request.content.decode("utf-8"))
        phase2_body = json.loads(rest_route.calls[1].request.content.decode("utf-8"))
        assert "{{issue:" not in phase2_body["body"]
        assert "#101" in phase2_body["body"]
        _assert_clean_posted_body(phase1_body["body"])
        _assert_clean_posted_body(phase2_body["body"])
