"""publish-npm.yml の静的な確認と、dev-version.mjs の出力。

npm への publish は main でしか試せないため、job の分け方と権限を merge 前にここで固定する。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = _REPO_ROOT / ".github/workflows/publish-npm.yml"
_DEV_VERSION = _REPO_ROOT / ".githooks/scripts/dev-version.mjs"
_NODE = shutil.which("node") or "node"


def _workflow() -> dict:
    return yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))


def _job(name: str) -> dict:
    return _workflow()["jobs"][name]


def _step(job: str, name: str) -> dict:
    step = next((s for s in _job(job)["steps"] if s.get("name") == name), None)
    assert step is not None, f"{job} に step が無い: {name}"
    return step


def test_release_and_dev_jobs_are_split_by_trigger() -> None:
    jobs = _workflow()["jobs"]
    assert list(jobs) == ["publish", "build-dev", "publish-dev"]
    assert (
        jobs["publish"]["if"]
        == "${{ github.event_name == 'workflow_dispatch' && inputs.tag != '' }}"
    )
    assert jobs["build-dev"]["if"] == "${{ github.event_name == 'push' || inputs.tag == '' }}"
    assert jobs["publish-dev"]["needs"] == "build-dev"


def test_push_runs_only_on_main_for_files_that_change_the_package() -> None:
    push = _workflow()[True]["push"]
    assert push["branches"] == ["main"]
    for path in (
        "plugins/pecot-workflow/**",
        "pnpm-lock.yaml",
        ".githooks/lib/mcp-publish-common.sh",
        ".githooks/scripts/dev-version.mjs",
        ".github/workflows/publish-npm.yml",
    ):
        assert path in push["paths"], path


def test_dispatch_tag_is_optional_and_dry_run_defaults_to_false() -> None:
    inputs = _workflow()[True]["workflow_dispatch"]["inputs"]
    assert inputs["tag"]["required"] is False
    assert inputs["dry-run"]["type"] == "boolean"
    assert inputs["dry-run"]["default"] is False


def test_permissions_are_granted_per_job() -> None:
    assert _workflow()["permissions"] == {}
    assert _job("publish")["permissions"] == {"contents": "read", "id-token": "write"}
    assert _job("build-dev")["permissions"] == {"contents": "read", "packages": "read"}
    assert _job("publish-dev")["permissions"] == {"id-token": "write"}


def test_release_and_dev_runs_queue_in_separate_groups() -> None:
    concurrency = _workflow()["concurrency"]
    assert concurrency["group"] == "publish-npm-${{ inputs.tag || 'dev' }}"
    assert concurrency["cancel-in-progress"] is False


def test_release_job_rejects_dry_run_first() -> None:
    first = _job("publish")["steps"][0]
    assert first["name"] == "Reject dry-run for a release tag"
    assert first["env"]["DRY_RUN"] == "${{ inputs.dry-run }}"
    assert "exit 1" in first["run"]


def test_dev_build_rejects_a_real_publish_outside_main_first() -> None:
    first = _job("build-dev")["steps"][0]
    assert first["name"] == "Reject a real publish outside main"
    assert '"$REF" != "refs/heads/main"' in first["run"]
    assert '"$DRY_RUN" != "true"' in first["run"]


def test_dev_publish_uses_next_tag_and_honors_dry_run() -> None:
    run = _step("publish-dev", "Publish to npm")["run"]
    assert "--tag next" in run
    assert "--provenance" in run
    assert "args+=(--dry-run)" in run
    assert _job("publish-dev")["env"]["DRY_RUN"] == "${{ inputs.dry-run }}"


def test_dev_publish_skips_runs_older_than_next() -> None:
    step = _step("publish-dev", "Check if already superseded")
    assert "dist-tags.next" in step["run"]
    assert step["env"]["RUN_NUMBER"] == "${{ github.run_number }}"
    assert _step("publish-dev", "Publish to npm")["if"] == "steps.published.outputs.done == 'false'"


def test_dev_publish_fails_on_a_private_repository_before_publishing() -> None:
    names = [s["name"] for s in _job("publish-dev")["steps"]]
    assert names.index("Fail if repository is private") < names.index("Publish to npm")


def test_dev_build_packs_into_the_shared_directory() -> None:
    run_cmd = _step("build-dev", "Build dev package")["with"]["runCmd"]
    assert '--out-dir="$out"' in run_cmd
    assert "--dry-run" in run_cmd
    assert "--pack-destination /workspaces/base/pecot/.pecot/tmp/dev-publish" in run_cmd
    upload = _step("build-dev", "Upload package")["with"]
    assert upload["path"] == ".pecot/tmp/dev-publish/*.tgz"
    assert upload["if-no-files-found"] == "error"


def test_every_action_is_pinned_to_a_full_sha() -> None:
    for name, job in _workflow()["jobs"].items():
        for step in job["steps"]:
            if "uses" in step:
                assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", step["uses"]), (name, step["uses"])


def test_no_japanese_in_shell() -> None:
    for name, job in _workflow()["jobs"].items():
        for step in job["steps"]:
            for text in (step.get("run", ""), step.get("with", {}).get("runCmd", "")):
                assert not re.search(r"[^\x00-\x7f]", text), (name, step["name"])


def _dev_version(
    tmp_path: Path, version: object, run_number: str
) -> subprocess.CompletedProcess[str]:
    manifest = tmp_path / "plugin.json"
    manifest.write_text(json.dumps({"name": "pecot-w", "version": version}), encoding="utf-8")
    return subprocess.run(
        [_NODE, str(_DEV_VERSION), str(manifest), run_number],
        capture_output=True,
        text=True,
        check=False,
    )


def test_dev_version_bumps_patch_and_appends_run_number(tmp_path: Path) -> None:
    result = _dev_version(tmp_path, "7.0.0", "123")
    assert result.returncode == 0, result.stderr
    assert result.stdout == "7.0.1-dev.123\n"


@pytest.mark.parametrize(
    ("version", "run_number"),
    [("7.0.0-dev.1", "1"), ("7.0", "1"), (7, "1"), ("7.0.0", "0"), ("7.0.0", "12a")],
)
def test_dev_version_rejects_malformed_input(
    tmp_path: Path, version: object, run_number: str
) -> None:
    result = _dev_version(tmp_path, version, run_number)
    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr.startswith("ERROR: ")
