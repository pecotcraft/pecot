"""`.github/rulesets/main.json` が ci.yml の job 名と食い違わないことと、必須の項目がそろっていることを確かめる。"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

_PR_KEYS = {
    "required_approving_review_count",
    "dismiss_stale_reviews_on_push",
    "require_code_owner_review",
    "require_last_push_approval",
    "required_review_thread_resolution",
}
_QUEUE_KEYS = {
    "check_response_timeout_minutes",
    "grouping_strategy",
    "max_entries_to_build",
    "max_entries_to_merge",
    "merge_method",
    "min_entries_to_merge",
    "min_entries_to_merge_wait_minutes",
}


@pytest.fixture(scope="module")
def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def rules(repo_root: Path) -> dict[str, dict]:
    data = json.loads((repo_root / ".github/rulesets/main.json").read_text())
    return {r["type"]: r.get("parameters", {}) for r in data["rules"]}


def _job_names(ci_yml: str) -> set[str]:
    """jobs 直下の key と、その job の name: を集める。"""
    names: set[str] = set()
    in_jobs = False
    for line in ci_yml.splitlines():
        if re.match(r"^jobs:\s*$", line):
            in_jobs = True
            continue
        if in_jobs and re.match(r"^\S", line):
            break
        if not in_jobs:
            continue
        if m := re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line):
            names.add(m.group(1))
        elif m := re.match(r"^    name:\s*(\S.*?)\s*$", line):
            names.add(m.group(1).strip("\"'"))
    return names


def test_required_contexts_are_ci_job_names(repo_root: Path, rules: dict[str, dict]) -> None:
    contexts = {c["context"] for c in rules["required_status_checks"]["required_status_checks"]}
    assert contexts == {"ci-result", "version-plan"}
    jobs = _job_names((repo_root / ".github/workflows/ci.yml").read_text())
    assert contexts <= jobs, f"ci.yml に無い job: {contexts - jobs}"


def test_pull_request_has_required_keys(rules: dict[str, dict]) -> None:
    params = rules["pull_request"]
    assert _PR_KEYS <= params.keys()
    assert params["required_approving_review_count"] == 0
    assert params["allowed_merge_methods"] == ["squash"]


def test_merge_queue_has_all_seven_keys(rules: dict[str, dict]) -> None:
    params = rules["merge_queue"]
    assert set(params) == _QUEUE_KEYS
    assert params["merge_method"] == "SQUASH"
    assert params["grouping_strategy"] == "ALLGREEN"


def test_bypass_is_release_app_only(repo_root: Path) -> None:
    data = json.loads((repo_root / ".github/rulesets/main.json").read_text())
    assert data["bypass_actors"] == [
        {"actor_id": 5676665, "actor_type": "Integration", "bypass_mode": "always"}
    ]
