"""check-ci-result.sh のユニットテスト。ジョブ一覧は CI_RESULT_JOBS_FILE のファイルで差し替える。"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

_LANES = [
    {"lane": "p:test-cli", "slug": "p-test-cli"},
    {"lane": "q:test-hooks", "slug": "q-test-hooks"},
]


def _jobs(**overrides: str | None) -> list[dict]:
    """既定は全部 success。overrides の値が None なら job を省く。"""
    names = ["checks (lint)", "tests (p:test-cli)", "tests (q:test-hooks)"]
    out = []
    for n in names:
        c = overrides.pop(n, "success")
        if c is not None:
            out.append({"name": n, "conclusion": c})
    for n, c in overrides.items():
        out.append({"name": n, "conclusion": c})
    return out


@pytest.fixture
def run(githooks_dir: Path, tmp_path: Path):
    script = githooks_dir / "ci" / "check-ci-result.sh"

    def _run(jobs: list[dict], lanes=_LANES, **env: str) -> subprocess.CompletedProcess:
        f = tmp_path / "jobs.json"
        f.write_text(json.dumps({"jobs": jobs}))
        full = {
            **os.environ,
            "CHECKS_RESULT": "success",
            "LANES_RESULT": "success",
            "TESTS_RESULT": "success",
            "LANES_COUNT": str(len(lanes)),
            "LANES_JSON": json.dumps(lanes),
            "CI_RESULT_JOBS_FILE": str(f),
            **env,
        }
        return subprocess.run([str(script)], env=full, capture_output=True, text=True)

    return _run


def test_all_success(run) -> None:
    r = run(_jobs())
    assert r.returncode == 0, r.stdout + r.stderr
    assert "tests (p:test-cli): success" in r.stdout
    assert "tests (q:test-hooks): success" in r.stdout


def test_one_lane_failure(run) -> None:
    r = run(_jobs(**{"tests (q:test-hooks)": "failure"}))
    assert r.returncode != 0
    assert "tests (q:test-hooks): failure" in r.stdout
    assert "tests (p:test-cli): success" in r.stdout


def test_lane_job_missing(run) -> None:
    r = run(_jobs(**{"tests (p:test-cli)": None}))
    assert r.returncode != 0
    assert "tests (p:test-cli): missing" in r.stdout


def test_zero_lanes_with_tests_skipped(run) -> None:
    r = run(
        _jobs(**{"tests (p:test-cli)": None, "tests (q:test-hooks)": None}),
        lanes=[],
        TESTS_RESULT="skipped",
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert "tests: 0 レーン" in r.stdout


def test_zero_lanes_with_tests_not_skipped(run) -> None:
    r = run(
        _jobs(**{"tests (p:test-cli)": None, "tests (q:test-hooks)": None}),
        lanes=[],
        TESTS_RESULT="success",
    )
    assert r.returncode != 0


def test_lanes_failure(run) -> None:
    assert run(_jobs(), LANES_RESULT="failure").returncode != 0


def test_checks_result_failure(run) -> None:
    assert run(_jobs(), CHECKS_RESULT="failure").returncode != 0


def test_unlisted_tests_job_failure(run) -> None:
    r = run(_jobs(**{"tests (z:test-extra)": "failure"}))
    assert r.returncode != 0
    assert "tests (z:test-extra): failure" in r.stdout


def test_unlisted_tests_job_success_is_ignored(run) -> None:
    assert run(_jobs(**{"tests (z:test-extra)": "success"})).returncode == 0


def test_checks_lint_failure(run) -> None:
    r = run(_jobs(**{"checks (lint)": "failure"}))
    assert r.returncode != 0
    assert "checks (lint): failure" in r.stdout


def test_non_success_result_prints_reason(run) -> None:
    r = run(_jobs(), CHECKS_RESULT="failure")
    assert r.returncode != 0
    assert "checks が success ではありません: failure" in r.stdout
    r = run(_jobs(), LANES_RESULT="cancelled")
    assert r.returncode != 0
    assert "lanes が success ではありません: cancelled" in r.stdout


@pytest.mark.parametrize(
    "env",
    [
        {"LANES_COUNT": ""},
        {"LANES_COUNT": "abc"},
        {"LANES_COUNT": "1"},
        {"LANES_COUNT": "3"},
        {"LANES_JSON": ""},
        {"LANES_JSON": "not json"},
        {"LANES_JSON": '{"lane": "p:test-cli"}'},
    ],
)
def test_malformed_lanes_output_fails_with_reason(run, env: dict[str, str]) -> None:
    r = run(_jobs(), **env)
    assert r.returncode != 0
    assert "LANES_COUNT" in r.stdout or "LANES_JSON" in r.stdout


def test_duplicate_lane_job_is_missing(run) -> None:
    jobs = _jobs() + [{"name": "tests (p:test-cli)", "conclusion": "success"}]
    r = run(jobs)
    assert r.returncode != 0
    assert "tests (p:test-cli): missing" in r.stdout


@pytest.mark.parametrize("conclusion", ["cancelled", None])
def test_lane_conclusion_not_success(run, conclusion: str | None) -> None:
    jobs = [j for j in _jobs() if j["name"] != "tests (q:test-hooks)"]
    jobs.append({"name": "tests (q:test-hooks)", "conclusion": conclusion})
    r = run(jobs)
    assert r.returncode != 0
    assert f"tests (q:test-hooks): {conclusion or 'null'}" in r.stdout
