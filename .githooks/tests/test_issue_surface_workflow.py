"""issue-surface-drift.yml の形と、比べの step が呼ぶ action と入力の確かめ。

workflow_dispatch は main に定義が入るまで動かせないため、形をここで固定する。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import allure
import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = _REPO_ROOT / ".github/workflows/issue-surface-drift.yml"
_COMPARE = "Compare the issue surface"


def _load() -> dict[Any, Any]:
    return yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))


def _job() -> dict[str, Any]:
    return _load()["jobs"]["run"]


def _step(name: str) -> dict[str, Any]:
    step = next((s for s in _job()["steps"] if s.get("name") == name), None)
    assert step is not None, f"step が無い: {name}"
    return step


@allure.title(
    "issue-surface-drift.yml は、workflow_dispatch だけで動き、dry-run の既定値は false にする"
)
def test_triggers_only_on_workflow_dispatch_with_dry_run_default_false() -> None:
    """`.github/workflows/issue-surface-drift.yml` のトリガーのテストです。`workflow_dispatch` だけを持ち、入力の `dry-run` が boolean で、既定値が `false` であることを確認します。"""
    with allure.step("workflow の on を読む"):
        # PyYAML は on を True に読む
        on = _load()[True]
    with allure.step("workflow_dispatch だけで、dry-run の既定が false であることを確かめる"):
        assert set(on) == {"workflow_dispatch"}
        dry_run = on["workflow_dispatch"]["inputs"]["dry-run"]
        assert dry_run["type"] == "boolean"
        assert dry_run["default"] is False


@allure.title("issue-surface-drift.yml の権限は、トップレベルの contents: read だけにする")
def test_permissions_are_contents_read_only_at_top() -> None:
    """ワークフローの権限のテストです。トップレベルが `contents: read` だけで、ジョブの側に `permissions` を持たないことを確認します。"""
    with allure.step("トップの権限が contents の read だけで、job に権限が無いことを確かめる"):
        assert _load()["permissions"] == {"contents": "read"}
        assert "permissions" not in _job()


@allure.title(
    "GitHub App のトークンの権限は、issues と organization の projects の write だけにする"
)
def test_app_token_permissions_are_issues_and_projects_write_only() -> None:
    """`Generate GitHub App token` の step のテストです。`permission-` で始まる入力が、`permission-issues` と `permission-organization-projects` の `write` だけであることを確認します。"""
    with allure.step("App token の step の権限を読む"):
        with_ = _step("Generate GitHub App token")["with"]
        perms = {k: v for k, v in with_.items() if k.startswith("permission-")}
    with allure.step("issues と projects の write だけであることを確かめる"):
        assert perms == {"permission-issues": "write", "permission-organization-projects": "write"}


@allure.title("issue-surface-drift.yml は、実行中のジョブを取り消さない")
def test_concurrency_does_not_cancel_in_progress() -> None:
    """ワークフローの `concurrency` のテストです。group が `issue-surface-drift` で、`cancel-in-progress` が `false` であることを確認します。"""
    with allure.step("concurrency の設定を読む"):
        concurrency = _load()["concurrency"]
    with allure.step("実行中のものを止めない設定であることを確かめる"):
        assert concurrency["group"] == "issue-surface-drift"
        assert concurrency["cancel-in-progress"] is False


@allure.title("issue-surface-drift.yml のジョブには、timeout を設定する")
def test_job_has_timeout() -> None:
    """`run` ジョブの `timeout-minutes` のテストです。整数の値が設定されていることを確認します。"""
    with allure.step("job に timeout-minutes があることを確かめる"):
        assert isinstance(_job()["timeout-minutes"], int)


@allure.title("チェックアウトの step は、認証情報を残さない")
def test_checkout_does_not_persist_credentials() -> None:
    """`Checkout` の step のテストです。`persist-credentials` が `false` であることを確認します。"""
    with allure.step("checkout が認証情報を残さないことを確かめる"):
        assert _step("Checkout")["with"]["persist-credentials"] is False


@allure.title(
    "比べの step は、このリポの tracker-sync を issue-surface で呼び、写しのパスと dry-run と App のトークンを渡す"
)
def test_compare_step_uses_tracker_sync_with_issue_surface() -> None:
    """比べの step のテストです。`./actions/tracker-sync` を `source: issue-surface` で呼び出し、写しのパス・`dry-run` の入力・App のトークンを渡すことを確認します。"""
    with allure.step("比べの step を読む"):
        step = _step(_COMPARE)
    with allure.step("uses と with の値を確かめる"):
        assert step["uses"] == "./actions/tracker-sync"
        assert "run" not in step
        assert step["with"] == {
            "token": "${{ steps.app-token.outputs.token }}",
            "source": "issue-surface",
            "surface-file": "plugins/pecot-workflow/interface/github-issue-surface.json",
            "dry-run": "${{ inputs.dry-run }}",
        }


@allure.title("比べの step に渡す写しのパスに、写しのファイルが存在する")
def test_surface_file_exists() -> None:
    """比べの step の `surface-file` のテストです。渡すパスが、リポのルートから見て存在するファイルを指すことを確認します。"""
    with allure.step("surface-file のパスにファイルがあることを確かめる"):
        assert (_REPO_ROOT / _step(_COMPARE)["with"]["surface-file"]).is_file()


@allure.title("issue-surface-drift.yml は、Node.js の用意と依存の install の step を持たない")
def test_has_no_node_setup_steps() -> None:
    """ワークフローの step の並びのテストです。action が build 済みの dist を読むので、`Checkout`・App のトークン・比べの 3 つの step だけを持つことを確認します。"""
    with allure.step("step の名前の並びを確かめる"):
        assert [s.get("name") for s in _job()["steps"]] == [
            "Checkout",
            "Generate GitHub App token",
            _COMPARE,
        ]
