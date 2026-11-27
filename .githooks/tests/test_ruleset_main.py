"""`.github/rulesets/main.json` が ci.yml・codeql.yml の job 名と食い違わないことと、必須の項目がそろっていることを確かめる。"""

from __future__ import annotations

import json
import re
from pathlib import Path

import allure
import pytest
import yaml

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


def _codeql_contexts(repo_root: Path) -> set[str]:
    """codeql.yml の analyze の job の `name` に、matrix の言語を埋めてチェックの名前を作る。"""
    workflow = yaml.safe_load((repo_root / ".github/workflows/codeql.yml").read_text())
    job = workflow["jobs"]["analyze"]
    template = job["name"]
    assert "${{ matrix.language }}" in template, f"name が言語で分かれていない: {template}"
    languages = job["strategy"]["matrix"]["language"]
    return {template.replace("${{ matrix.language }}", lang) for lang in languages}


@allure.title(
    "必須のステータスチェックは、ci.yml の 2 つの job と、codeql.yml の言語ごとの解析だけにする"
)
def test_required_contexts_are_ci_and_codeql_jobs(repo_root: Path, rules: dict[str, dict]) -> None:
    """`.github/rulesets/main.json` の必須のステータスチェックのテストです。`ci.yml` の `ci-result` と `version-plan` に加え、`codeql.yml` の言語ごとの `analyze (<言語>)` がすべて指定されていることを確認します。"""
    with allure.step("ruleset の必須の check と、ci.yml の job 名・codeql.yml の言語を読む"):
        contexts = {c["context"] for c in rules["required_status_checks"]["required_status_checks"]}
        jobs = _job_names((repo_root / ".github/workflows/ci.yml").read_text())
        codeql = _codeql_contexts(repo_root)
    with allure.step(
        "必須の check が ci.yml の 2 つの job と codeql.yml の解析に一致することを確かめる"
    ):
        assert {"ci-result", "version-plan"} <= jobs
        assert contexts == {"ci-result", "version-plan"} | codeql


@allure.title("codeql.yml の pull_request は、base のブランチで絞らずにすべての PR で動く")
def test_codeql_runs_on_pull_requests_to_any_base(repo_root: Path) -> None:
    """`codeql.yml` の `pull_request` の trigger のテストです。必須のチェックを出せるように、base が main でないスタックの子の PR でも動くことを確認します。"""
    with allure.step("codeql.yml の trigger を読む"):
        workflow = yaml.safe_load((repo_root / ".github/workflows/codeql.yml").read_text())
        # PyYAML は YAML 1.1 なので、キーの `on` を True と読む。
        triggers = workflow[True]
    with allure.step("pull_request に branches の絞りが無いことを確かめる"):
        assert "pull_request" in triggers
        assert "branches" not in (triggers["pull_request"] or {})


@allure.title("pull_request の規則は、必須の項目を持ち、承認数 0 と squash だけを指定する")
def test_pull_request_has_required_keys(rules: dict[str, dict]) -> None:
    """ruleset の `pull_request` の規則のテストです。レビューに関する 5 つの項目が存在し、必要な承認数が 0、許可するマージ方法が `squash` だけであることを確認します。"""
    with allure.step("pull_request のルールの項目を読む"):
        params = rules["pull_request"]
    with allure.step("必須の項目がそろい、承認数とマージ方法が決めた値であることを確かめる"):
        assert _PR_KEYS <= params.keys()
        assert params["required_approving_review_count"] == 0
        assert params["allowed_merge_methods"] == ["squash"]


@allure.title("merge_queue の規則は、7 つの項目をすべて持ち、SQUASH と ALLGREEN を指定する")
def test_merge_queue_has_all_seven_keys(rules: dict[str, dict]) -> None:
    """ruleset の `merge_queue` の規則のテストです。パラメータが 7 つの項目だけで構成され、マージ方法が `SQUASH`、グループ化の方法が `ALLGREEN` であることを確認します。"""
    with allure.step("merge_queue のルールの項目を読む"):
        params = rules["merge_queue"]
    with allure.step("7 項目がそろい、マージ方法と grouping が決めた値であることを確かめる"):
        assert set(params) == _QUEUE_KEYS
        assert params["merge_method"] == "SQUASH"
        assert params["grouping_strategy"] == "ALLGREEN"


@allure.title("ルールを迂回できるのは、リリース用の GitHub App だけに限る")
def test_bypass_is_release_app_only(repo_root: Path) -> None:
    """ruleset の `bypass_actors` のテストです。迂回できる対象が Integration 1 件だけで、`bypass_mode` が `always` であることを確認します。"""
    with allure.step("ruleset の JSON を読む"):
        data = json.loads((repo_root / ".github/rulesets/main.json").read_text())
    with allure.step("bypass できるのがリリース用の App だけであることを確かめる"):
        assert data["bypass_actors"] == [
            {"actor_id": 5676665, "actor_type": "Integration", "bypass_mode": "always"}
        ]
