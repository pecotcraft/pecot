"""issue-surface-drift.yml の形と、比べの step の run: のシェルの確かめ。

workflow_dispatch は main に定義が入るまで動かせないため、形と run: のシェルをここで固定する。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

import pytest
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


def test_triggers_only_on_workflow_dispatch_with_dry_run_default_false() -> None:
    # PyYAML は on を True に読む
    on = _load()[True]
    assert set(on) == {"workflow_dispatch"}
    dry_run = on["workflow_dispatch"]["inputs"]["dry-run"]
    assert dry_run["type"] == "boolean"
    assert dry_run["default"] is False


def test_permissions_are_contents_read_only_at_top() -> None:
    assert _load()["permissions"] == {"contents": "read"}
    assert "permissions" not in _job()


def test_app_token_permissions_are_issues_and_projects_write_only() -> None:
    with_ = _step("Generate GitHub App token")["with"]
    perms = {k: v for k, v in with_.items() if k.startswith("permission-")}
    assert perms == {"permission-issues": "write", "permission-organization-projects": "write"}


def test_concurrency_does_not_cancel_in_progress() -> None:
    concurrency = _load()["concurrency"]
    assert concurrency["group"] == "issue-surface-drift"
    assert concurrency["cancel-in-progress"] is False


def test_job_has_timeout() -> None:
    assert isinstance(_job()["timeout-minutes"], int)


def test_checkout_does_not_persist_credentials() -> None:
    assert _step("Checkout")["with"]["persist-credentials"] is False


@pytest.mark.parametrize(("dry_run", "expect_flag"), [("true", True), ("false", False)])
def test_compare_step_passes_repo_and_dry_run_only_when_true(
    tmp_path: Path, dry_run: str, expect_flag: bool
) -> None:
    step = _step(_COMPARE)
    assert "${{" not in step["run"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "pnpm"
    fake.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$OUT"\n', encoding="utf-8")
    fake.chmod(0o755)
    out = tmp_path / "args.txt"
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "OUT": str(out),
        "GITHUB_REPOSITORY": "owner/repo",
        "DRY_RUN": dry_run,
    }
    result = subprocess.run(
        ["bash", "-e", "-c", step["run"]],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    args = out.read_text(encoding="utf-8").splitlines()
    assert args == [
        "--dir",
        "plugins/pecot-workflow/cli",
        "exec",
        "tsx",
        "scripts/github-surface/drift.ts",
        "--repo",
        "owner/repo",
        *(["--dry-run"] if expect_flag else []),
    ]
