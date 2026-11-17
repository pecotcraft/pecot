"""公開サイトの workflow（pages-build.yml）の静的な確かめ。

契機・権限・concurrency・artifact の決まりは specs/028-pages-site/contracts/pages.md にある。
push と workflow_dispatch はマージの後でないと動かないため、形をここで固定する。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BUILD = _REPO_ROOT / ".github/workflows/pages-build.yml"
_CI = _REPO_ROOT / ".github/workflows/ci.yml"

_SITE_ENV = (
    "PECOT_SITE_STRICT",
    "PECOT_SITE_SIDE",
    "PECOT_SITE_PR",
    "PECOT_SITE_SHA",
    "PECOT_SITE_RUN_URL",
    "PECOT_SITE_BUILT_AT",
)


def _load(path: Path) -> dict[Any, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _build() -> dict[Any, Any]:
    return _load(_BUILD)


def _job(name: str) -> dict[str, Any]:
    return _build()["jobs"][name]


def _steps(job: str) -> list[dict[str, Any]]:
    return _job(job)["steps"]


def _uses(job: str, action: str) -> list[dict[str, Any]]:
    return [s for s in _steps(job) if s.get("uses", "").startswith(f"{action}@")]


def _all_steps() -> list[dict[str, Any]]:
    return [step for job in _build()["jobs"].values() for step in job["steps"]]


def _devcontainer_env(job: str) -> set[str]:
    return set(_job(job)["env"]["DEVCONTAINER_ENV"].split())


def test_triggers() -> None:
    on = _build()[True]
    assert on["push"] == {"branches": ["main"]}
    assert on["pull_request"] == {"types": ["opened", "synchronize", "reopened", "closed"]}
    inputs = on["workflow_dispatch"]["inputs"]
    assert inputs["side"]["type"] == "choice"
    assert inputs["side"]["options"] == ["release", "dev"]
    assert inputs["side"]["required"] is True
    assert inputs["sha"]["type"] == "string"
    assert inputs["sha"]["required"] is True


def test_jobs_and_order() -> None:
    jobs = _build()["jobs"]
    assert list(jobs) == ["side", "lanes", "site"]
    assert jobs["lanes"]["needs"] == "side"
    assert jobs["site"]["needs"] == ["side", "lanes"]


def test_side_builds_only_open_prs_from_this_repo() -> None:
    env = next(s for s in _steps("side") if s.get("id") == "decide")["env"]
    assert env["PR_ACTION"] == "${{ github.event.action }}"
    assert env["PR_HEAD_REPO"] == "${{ github.event.pull_request.head.repo.full_name }}"
    assert env["REPO"] == "${{ github.repository }}"
    assert env["PR_HEAD_SHA"] == "${{ github.event.pull_request.head.sha }}"
    run = next(s for s in _steps("side") if s.get("id") == "decide")["run"]
    assert '"$PR_ACTION" = "closed"' in run
    assert '"$PR_HEAD_REPO" != "$REPO"' in run
    assert '[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]' in run


def test_lanes_and_site_run_only_when_side_says_build() -> None:
    assert _job("lanes")["if"] == "${{ needs.side.outputs.build == 'true' }}"
    assert _job("site")["if"] == "${{ !cancelled() && needs.side.outputs.build == 'true' }}"


def test_lanes_matrix_comes_from_junit_lanes() -> None:
    assert _job("lanes")["strategy"] == {
        "fail-fast": False,
        "matrix": {"include": "${{ fromJSON(needs.side.outputs.lanes) }}"},
    }
    run = "\n".join(s.get("run", "") for s in _steps("side"))
    assert "python3 .githooks/scripts/pages_site/lanes.py" in run


def test_browser_flag_matches_ci() -> None:
    expected = _load(_CI)["jobs"]["tests"]["env"]["PECOT_CI_BROWSER"]
    assert _job("lanes")["env"]["PECOT_CI_BROWSER"] == expected
    assert "PECOT_CI_BROWSER" in _devcontainer_env("lanes")


def test_site_passes_site_env_into_container() -> None:
    env = _job("site")["env"]
    assert env["PECOT_SITE_STRICT"] == "1"
    for name in _SITE_ENV:
        assert name in env, name
    assert set(_SITE_ENV) <= _devcontainer_env("site")


def test_permissions_are_contents_read_only() -> None:
    assert _build()["permissions"] == {"contents": "read"}
    for name, job in _build()["jobs"].items():
        assert "permissions" not in job, name


def test_concurrency_keeps_only_the_latest_per_side() -> None:
    concurrency = _build()["concurrency"]
    assert concurrency["group"] == (
        "pages-build-${{ github.event_name == 'pull_request' && 'pr' || inputs.side || 'dev' }}"
        "-${{ github.event.pull_request.number || github.ref }}"
    )
    assert concurrency["cancel-in-progress"] is True


def test_artifacts() -> None:
    uploads = [s for s in _all_steps() if s.get("uses", "").startswith("actions/upload-artifact@")]
    assert uploads
    for step in uploads:
        assert step["with"]["retention-days"] == 90, step["name"]
    (junit,) = _uses("lanes", "actions/upload-artifact")
    assert junit["with"]["name"] == "pages-junit-${{ matrix.slug }}"
    assert junit["with"]["path"] == "${{ matrix.junit }}"
    assert junit["with"]["if-no-files-found"] == "error"
    (side,) = _uses("site", "actions/upload-artifact")
    assert side["with"]["name"] == "${{ needs.side.outputs.artifact }}"
    (download,) = _uses("site", "actions/download-artifact")
    assert download["with"]["pattern"] == "pages-junit-*"


def test_checkout_uses_side_sha_without_credentials() -> None:
    for job in ("lanes", "site"):
        (checkout,) = _uses(job, "actions/checkout")
        assert checkout["with"]["ref"] == "${{ needs.side.outputs.sha }}"
    for step in _all_steps():
        if step.get("uses", "").startswith("actions/checkout@"):
            assert step["with"]["persist-credentials"] is False


def test_dev_container_jobs_restore_owner() -> None:
    for job in ("lanes", "site"):
        steps = [s for s in _steps(job) if "dev-container.sh restore-owner" in s.get("run", "")]
        assert len(steps) == 1, job
        assert steps[0]["if"] == "always()"


def test_actions_are_pinned_by_sha() -> None:
    for step in _all_steps():
        if "uses" in step:
            assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", step["uses"]), step["uses"]


def test_run_has_no_expressions_and_no_japanese() -> None:
    for step in _all_steps():
        run = step.get("run", "")
        assert "${{" not in run, step["name"]
        assert not re.search(r"[^\x00-\x7f]", run), step["name"]
