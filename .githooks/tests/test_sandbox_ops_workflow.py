"""sandbox-ops.yml の形と、片付けの step の run: のシェルの確かめ。

workflow_dispatch は main に定義が入るまで動かせないため、形と run: のシェルをここで固定する。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import allure
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = _REPO_ROOT / ".github/workflows/sandbox-ops.yml"
_TOKEN = "Generate GitHub App token"
_SWEEP = "Clean up the sandbox"


def _load() -> dict[Any, Any]:
    return yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))


def _job(name: str) -> dict[str, Any]:
    return _load()["jobs"][name]


def _step(job: str, name: str) -> dict[str, Any]:
    step = next((s for s in _job(job)["steps"] if s.get("name") == name), None)
    assert step is not None, f"step が無い: {job} / {name}"
    return step


@allure.title(
    "sandbox-ops.yml は workflow_dispatch だけで動き、run-name に operation と request_id を入れる"
)
def test_dispatch_inputs_and_run_name() -> None:
    """`sandbox-ops.yml` のトリガーのテストです。トリガーが `workflow_dispatch` だけであることを確認します。`operation` は `diff`・`sweep` の選択で、`dry-run` の既定は `true` です。`run-name` は `sandbox-ops <operation> <request_id>` の形です。"""
    with allure.step("workflow の on と run-name を読む"):
        workflow = _load()
        # PyYAML は on を True に読む
        inputs = workflow[True]["workflow_dispatch"]["inputs"]
    with allure.step("入力と run-name の形を確かめる"):
        assert set(workflow[True]) == {"workflow_dispatch"}
        assert set(inputs) == {"operation", "issue", "dry-run", "request_id"}
        assert inputs["operation"]["options"] == ["diff", "sweep"]
        assert inputs["dry-run"]["type"] == "boolean"
        assert inputs["dry-run"]["default"] is True
        assert (
            workflow["run-name"] == "sandbox-ops ${{ inputs.operation }} ${{ inputs.request_id }}"
        )


@allure.title("{job} の job は、operation が {job} で App の変数があるときだけ動く")
@pytest.mark.parametrize("job", ["diff", "sweep"])
def test_job_runs_only_for_its_operation(job: str) -> None:
    """job の `if` のテストです。`operation` がその job の名前で、変数 `PECOT_SANDBOX_APP_CLIENT_ID` が空でないときだけ動くことを確認します。"""
    with allure.step("job の if を確かめる"):
        assert _job(job)["if"] == (
            f"${{{{ inputs.operation == '{job}' && vars.PECOT_SANDBOX_APP_CLIENT_ID != '' }}}}"
        )
        assert isinstance(_job(job)["timeout-minutes"], int)


@allure.title("トップの権限は contents: read で、diff の job だけが contents: write を持つ")
def test_permissions() -> None:
    """ワークフローの権限のテストです。トップが `contents: read` であることを確認します。このリポのマージの設定を読む diff の job だけが `contents: write` を持ち、sweep の job は権限を持ちません。"""
    with allure.step("トップと job の権限を確かめる"):
        assert _load()["permissions"] == {"contents": "read"}
        assert _job("diff")["permissions"] == {"contents": "write"}
        assert "permissions" not in _job("sweep")


@allure.title("{job} の App の token は、検証用のリポだけに絞り、権限を {expected} にする")
@pytest.mark.parametrize(
    ("job", "expected"),
    [
        ("diff", {"permission-contents": "write", "permission-organization-projects": "read"}),
        (
            "sweep",
            {
                "permission-contents": "write",
                "permission-issues": "write",
                "permission-pull-requests": "write",
                "permission-organization-projects": "write",
            },
        ),
    ],
)
def test_app_token_scope(job: str, expected: dict[str, str]) -> None:
    """`Generate GitHub App token` の step のテストです。`owner` と `repositories: pecot-sandbox` で検証用だけの token にし、`permission-` の入力が job ごとに要るものだけであることを確認します。"""
    with allure.step("App token の step の入力を読む"):
        with_ = _step(job, _TOKEN)["with"]
    with allure.step("範囲と権限を確かめる"):
        assert with_["client-id"] == "${{ vars.PECOT_SANDBOX_APP_CLIENT_ID }}"
        assert with_["private-key"] == "${{ secrets.PECOT_SANDBOX_APP_PRIVATE_KEY }}"
        assert with_["owner"] == "${{ github.repository_owner }}"
        assert with_["repositories"] == "pecot-sandbox"
        assert {k: v for k, v in with_.items() if k.startswith("permission-")} == expected


@allure.title("{job} の checkout は、認証情報を残さない")
@pytest.mark.parametrize("job", ["diff", "sweep"])
def test_checkout_does_not_persist_credentials(job: str) -> None:
    """`Checkout` の step のテストです。`persist-credentials` が `false` であることを確認します。"""
    with allure.step("checkout が認証情報を残さないことを確かめる"):
        assert _step(job, "Checkout")["with"]["persist-credentials"] is False


@allure.title("diff は、このリポの token と検証用の token を分けて sandbox-diff.sh に渡す")
def test_diff_passes_two_tokens() -> None:
    """比べの step のテストです。`sandbox-diff.sh` を打つことを確認します。`SANDBOX_DIFF_THIS_REPO_TOKEN` には `GITHUB_TOKEN` を渡します。`SANDBOX_DIFF_SANDBOX_TOKEN` には App の token を渡します。"""
    with allure.step("比べの step を読む"):
        step = _step("diff", "Compare the sandbox")
    with allure.step("2 つの token とスクリプトを確かめる"):
        assert step["env"] == {
            "SANDBOX_DIFF_THIS_REPO_TOKEN": "${{ github.token }}",
            "SANDBOX_DIFF_SANDBOX_TOKEN": "${{ steps.app-token.outputs.token }}",
        }
        assert step["run"] == "plugins/pecot-workflow/scripts/sandbox/sandbox-diff.sh"


@allure.title("sweep は、実行中の片付けを取り消さない")
def test_sweep_concurrency() -> None:
    """sweep の job の `concurrency` のテストです。group が `sandbox-ops-sweep` で、`cancel-in-progress` が `false` であることを確認します。"""
    with allure.step("concurrency を確かめる"):
        assert _job("sweep")["concurrency"] == {
            "group": "sandbox-ops-sweep",
            "cancel-in-progress": False,
        }


@allure.title(
    "ISSUE が「{issue}」・DRY_RUN が {dry_run} のとき、sandbox-sweep.sh に {expected} を渡す"
)
@pytest.mark.parametrize(
    ("issue", "dry_run", "expected"),
    [
        ("799", "true", ["--issue", "799", "--dry-run"]),
        ("799", "false", ["--issue", "799"]),
        ("", "true", ["--dry-run"]),
        ("", "false", []),
    ],
)
def test_sweep_step_arguments(
    tmp_path: Path, issue: str, dry_run: str, expected: list[str]
) -> None:
    """片付けの step の `run` のシェルを、偽の `sandbox-sweep.sh` を置いて実行するテストです。`ISSUE` が空でなければ `--issue` を、`DRY_RUN` が `true` なら `--dry-run` を渡すことを確認します。"""
    with allure.step("偽のスクリプトを置き、片付けの step の run を動かす"):
        step = _step("sweep", _SWEEP)
        assert "${{" not in step["run"]
        assert step["env"]["GH_TOKEN"] == "${{ steps.app-token.outputs.token }}"
        fake = tmp_path / "plugins/pecot-workflow/scripts/sandbox/sandbox-sweep.sh"
        fake.parent.mkdir(parents=True)
        fake.write_text(
            '#!/usr/bin/env bash\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$OUT"\n',
            encoding="utf-8",
        )
        fake.chmod(0o755)
        out = tmp_path / "args.txt"
        env = {**os.environ, "OUT": str(out), "ISSUE": issue, "DRY_RUN": dry_run}
        result = run_attached(
            ["bash", "-e", "-c", step["run"]],
            cwd=tmp_path,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
    with allure.step("渡した引数を確かめる"):
        assert result.returncode == 0, result.stderr
        assert read_output(out).splitlines() == expected
