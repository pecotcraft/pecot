"""check-ci-result.sh のユニットテスト。ジョブ一覧は CI_RESULT_JOBS_FILE のファイルで差し替える。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import run_attached  # noqa: E402

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
        return run_attached([str(script)], env=full, capture_output=True, text=True)

    return _run


@allure.title("すべてのジョブが成功すると、終了コード 0 で終わる")
def test_all_success(run) -> None:
    """checks のジョブとレーンのジョブが、すべて `success` の場合の `check-ci-result.sh` のテストです。終了コード 0 で終わり、各レーンの結果を `success` として出力することを確認します。"""
    with allure.step("すべての job が成功した状態で動かす"):
        r = run(_jobs())
    with allure.step("終了コードと各 job の成功の出力を確かめる"):
        assert r.returncode == 0, r.stdout + r.stderr
        assert "tests (p:test-cli): success" in r.stdout
        assert "tests (q:test-hooks): success" in r.stdout


@allure.title("1 つのレーンのジョブが失敗すると、失敗したレーンを出力して失敗で終わる")
def test_one_lane_failure(run) -> None:
    """`tests (q:test-hooks)` のジョブが `failure` の場合のテストです。終了コードが 0 以外で、失敗したレーンを `failure`、成功したレーンを `success` として出力することを確認します。"""
    with allure.step("1 つのレーンが失敗した状態で動かす"):
        r = run(_jobs(**{"tests (q:test-hooks)": "failure"}))
    with allure.step("非 0 の終了と各 job の結果の出力を確かめる"):
        assert r.returncode != 0
        assert "tests (q:test-hooks): failure" in r.stdout
        assert "tests (p:test-cli): success" in r.stdout


@allure.title("レーンのジョブが存在しないと、missing と出力して失敗で終わる")
def test_lane_job_missing(run) -> None:
    """レーンの一覧にあるジョブが、ジョブの一覧に存在しない場合のテストです。終了コードが 0 以外で、そのレーンを `missing` として出力することを確認します。"""
    with allure.step("レーンの job が無い状態で動かす"):
        r = run(_jobs(**{"tests (p:test-cli)": None}))
    with allure.step("非 0 の終了と missing の出力を確かめる"):
        assert r.returncode != 0
        assert "tests (p:test-cli): missing" in r.stdout


@allure.title("レーンが 0 件で tests が skipped なら、成功で終わる")
def test_zero_lanes_with_tests_skipped(run) -> None:
    """レーンが 0 件で、`tests` の結果が `skipped` の場合のテストです。終了コード 0 で終わり、`tests: 0 レーン` を出力することを確認します。"""
    with allure.step("レーンが 0 で tests が skipped の状態で動かす"):
        r = run(
            _jobs(**{"tests (p:test-cli)": None, "tests (q:test-hooks)": None}),
            lanes=[],
            TESTS_RESULT="skipped",
        )
    with allure.step("終了コードと 0 レーンの出力を確かめる"):
        assert r.returncode == 0, r.stdout + r.stderr
        assert "tests: 0 レーン" in r.stdout


@allure.title("レーンが 0 件でも tests が skipped でなければ、失敗で終わる")
def test_zero_lanes_with_tests_not_skipped(run) -> None:
    """レーンが 0 件で、`tests` の結果が `success` の場合のテストです。`skipped` であるべき結果が異なるため、終了コードが 0 以外になることを確認します。"""
    with allure.step("レーンが 0 で tests が skipped でない状態で動かす"):
        r = run(
            _jobs(**{"tests (p:test-cli)": None, "tests (q:test-hooks)": None}),
            lanes=[],
            TESTS_RESULT="success",
        )
    with allure.step("非 0 の終了を確かめる"):
        assert r.returncode != 0


@allure.title("lanes の結果が failure だと、ジョブがすべて成功でも失敗で終わる")
def test_lanes_failure(run) -> None:
    """ジョブの一覧がすべて成功でも、`LANES_RESULT` が `failure` の場合のテストです。終了コードが 0 以外になることを確認します。"""
    with allure.step("lanes が失敗した状態の終了コードが非 0 であることを確かめる"):
        assert run(_jobs(), LANES_RESULT="failure").returncode != 0


@allure.title("checks の結果が failure だと、ジョブがすべて成功でも失敗で終わる")
def test_checks_result_failure(run) -> None:
    """ジョブの一覧がすべて成功でも、`CHECKS_RESULT` が `failure` の場合のテストです。終了コードが 0 以外になることを確認します。"""
    with allure.step("checks が失敗した状態の終了コードが非 0 であることを確かめる"):
        assert run(_jobs(), CHECKS_RESULT="failure").returncode != 0


@allure.title("レーンの一覧に存在しない tests のジョブが失敗すると、失敗で終わる")
def test_unlisted_tests_job_failure(run) -> None:
    """レーンの一覧に存在しない `tests (z:test-extra)` のジョブが `failure` の場合のテストです。終了コードが 0 以外で、そのジョブの結果を出力することを確認します。"""
    with allure.step("一覧に無い tests の job が失敗した状態で動かす"):
        r = run(_jobs(**{"tests (z:test-extra)": "failure"}))
    with allure.step("非 0 の終了と失敗の出力を確かめる"):
        assert r.returncode != 0
        assert "tests (z:test-extra): failure" in r.stdout


@allure.title("レーンの一覧に存在しない tests のジョブが成功した場合は、結果に影響しない")
def test_unlisted_tests_job_success_is_ignored(run) -> None:
    """レーンの一覧に存在しない `tests (z:test-extra)` のジョブが `success` の場合のテストです。終了コード 0 で終わることを確認します。"""
    with allure.step("一覧に無い tests の job が成功した状態の終了コードが 0 であることを確かめる"):
        assert run(_jobs(**{"tests (z:test-extra)": "success"})).returncode == 0


@allure.title("checks (lint) のジョブが失敗すると、失敗で終わる")
def test_checks_lint_failure(run) -> None:
    """`checks (lint)` のジョブが `failure` の場合のテストです。終了コードが 0 以外で、そのジョブの結果を出力することを確認します。"""
    with allure.step("checks (lint) が失敗した状態で動かす"):
        r = run(_jobs(**{"checks (lint)": "failure"}))
    with allure.step("非 0 の終了と失敗の出力を確かめる"):
        assert r.returncode != 0
        assert "checks (lint): failure" in r.stdout


@allure.title("checks や lanes の結果が success でないと、その値を理由として出力する")
def test_non_success_result_prints_reason(run) -> None:
    """`CHECKS_RESULT` が `failure`、`LANES_RESULT` が `cancelled` の場合のテストです。どちらも終了コードが 0 以外で、success ではない旨のメッセージに、結果の値を添えて出力することを確認します。"""
    with allure.step("checks が失敗した状態で動かす"):
        r = run(_jobs(), CHECKS_RESULT="failure")
    with allure.step("checks と lanes が success でない理由の出力を確かめる"):
        assert r.returncode != 0
        assert "checks が success ではありません: failure" in r.stdout
        r = run(_jobs(), LANES_RESULT="cancelled")
        assert r.returncode != 0
        assert "lanes が success ではありません: cancelled" in r.stdout


@allure.title("LANES_COUNT か LANES_JSON が {env} のように不正だと、理由を出力して失敗で終わる")
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
    """`LANES_COUNT` が空・数字でない・レーンの数と異なる場合や、`LANES_JSON` が空・JSON でない・配列でない場合のテストです。終了コードが 0 以外で、`LANES_COUNT` か `LANES_JSON` を理由として出力することを確認します。"""
    with allure.step("読めない lanes の出力で動かす"):
        r = run(_jobs(), **env)
    with allure.step("非 0 の終了と LANES の項目名の出力を確かめる"):
        assert r.returncode != 0
        assert "LANES_COUNT" in r.stdout or "LANES_JSON" in r.stdout


@allure.title("同じレーンのジョブが重複すると、missing として扱い、失敗で終わる")
def test_duplicate_lane_job_is_missing(run) -> None:
    """同じ名前のレーンのジョブが 2 件ある場合のテストです。終了コードが 0 以外で、そのレーンを `missing` として出力することを確認します。"""
    with allure.step("同じレーンの job を二重にして動かす"):
        jobs = _jobs() + [{"name": "tests (p:test-cli)", "conclusion": "success"}]
        r = run(jobs)
    with allure.step("非 0 の終了と missing の出力を確かめる"):
        assert r.returncode != 0
        assert "tests (p:test-cli): missing" in r.stdout


@allure.title("レーンのジョブの結論が {conclusion} だと、その値を出力して失敗で終わる")
@pytest.mark.parametrize("conclusion", ["cancelled", None])
def test_lane_conclusion_not_success(run, conclusion: str | None) -> None:
    """レーンのジョブの結論が `cancelled` か `null` の場合のテストです。終了コードが 0 以外で、結論の値を出力することを確認します。"""
    with allure.step("レーンの結論を success 以外にして動かす"):
        jobs = [j for j in _jobs() if j["name"] != "tests (q:test-hooks)"]
        jobs.append({"name": "tests (q:test-hooks)", "conclusion": conclusion})
        r = run(jobs)
    with allure.step("非 0 の終了と結論の出力を確かめる"):
        assert r.returncode != 0
        assert f"tests (q:test-hooks): {conclusion or 'null'}" in r.stdout


def _skip_jobs() -> list[dict]:
    return _jobs(**{"checks (lint)": None})


@allure.title("lint を飛ばす設定で、レーンが 0 件なら、成功で終わる")
def test_lint_skip_zero_lanes(run) -> None:
    """`LINT_MODE` が `skip` で、レーンが 0 件の場合のテストです。`checks` と `tests` がどちらも `skipped` のときに、終了コード 0 で終わることを確認します。"""
    with allure.step("lint を飛ばしレーンが 0 の状態で動かす"):
        r = run(
            _jobs(
                **{"checks (lint)": None, "tests (p:test-cli)": None, "tests (q:test-hooks)": None}
            ),
            lanes=[],
            TESTS_RESULT="skipped",
            LINT_MODE="skip",
            CHECKS_RESULT="skipped",
        )
    with allure.step("終了コードが 0 であることを確かめる"):
        assert r.returncode == 0, r.stdout + r.stderr


@allure.title("lint を飛ばす設定でも、レーンのジョブが成功していれば、成功で終わる")
def test_lint_skip_with_lanes(run) -> None:
    """`LINT_MODE` が `skip` で、`checks` が `skipped` の場合のテストです。終了コード 0 で終わり、レーンの結果を `success` として出力することを確認します。"""
    with allure.step("lint を飛ばしレーンのある状態で動かす"):
        r = run(_skip_jobs(), LINT_MODE="skip", CHECKS_RESULT="skipped")
    with allure.step("終了コードと成功の出力を確かめる"):
        assert r.returncode == 0, r.stdout + r.stderr
        assert "tests (p:test-cli): success" in r.stdout


_EXPANDED = "checks (${{ matrix.part }})"


@allure.title("lint を飛ばす設定で、{name} のジョブが skipped でも、レーンがあれば成功で終わる")
@pytest.mark.parametrize("name", [_EXPANDED, "checks (lint)", "checks (lint-py)"])
def test_lint_skip_with_skipped_matrix_job_with_lanes(run, name: str) -> None:
    """`LINT_MODE` が `skip` で、`if` で飛ばした matrix のジョブが `skipped` として一覧に出る場合のテストです。終了コード 0 で終わり、レーンの結果を `success` として出力することを確認します。"""
    with allure.step("skipped の matrix の job を足して動かす"):
        jobs = _skip_jobs() + [{"name": name, "conclusion": "skipped"}]
        r = run(jobs, LINT_MODE="skip", CHECKS_RESULT="skipped")
    with allure.step("終了コードと成功の出力を確かめる"):
        assert r.returncode == 0, r.stdout + r.stderr
        assert "tests (p:test-cli): success" in r.stdout


@allure.title("lint を飛ばす設定で、{name} のジョブが skipped でも、レーンが 0 件なら成功で終わる")
@pytest.mark.parametrize("name", [_EXPANDED, "checks (lint)", "checks (lint-py)"])
def test_lint_skip_with_skipped_matrix_job_zero_lanes(run, name: str) -> None:
    """`LINT_MODE` が `skip` で、レーンが 0 件のときに、飛ばした matrix のジョブが `skipped` として一覧に出る場合のテストです。終了コード 0 で終わることを確認します。"""
    with allure.step("レーン 0 で skipped の matrix の job を用意して動かす"):
        jobs = [{"name": name, "conclusion": "skipped"}]
        r = run(jobs, lanes=[], TESTS_RESULT="skipped", LINT_MODE="skip", CHECKS_RESULT="skipped")
    with allure.step("終了コードが 0 であることを確かめる"):
        assert r.returncode == 0, r.stdout + r.stderr


@allure.title("lint を飛ばす設定で、checks の結果が {result} だと、失敗で終わる")
@pytest.mark.parametrize("result", ["success", "failure"])
def test_lint_skip_requires_checks_skipped(run, result: str) -> None:
    """`LINT_MODE` が `skip` で、`CHECKS_RESULT` が `success` か `failure` の場合のテストです。`skipped` であるべき結果が異なるため、終了コードが 0 以外で、`skipped` を含む理由を出力することを確認します。"""
    with allure.step("lint を飛ばして checks が skipped でない状態で動かす"):
        r = run(_skip_jobs(), LINT_MODE="skip", CHECKS_RESULT=result)
    with allure.step("非 0 の終了と skipped の出力を確かめる"):
        assert r.returncode != 0
        assert "skipped" in r.stdout


@allure.title("lint を飛ばす設定でも、checks (lint) のジョブが失敗していれば、失敗で終わる")
def test_lint_skip_with_failed_checks_job(run) -> None:
    """`LINT_MODE` が `skip` で、`checks (lint)` のジョブが `failure` の場合のテストです。終了コードが 0 以外で、そのジョブの結果を出力することを確認します。"""
    with allure.step("lint を飛ばして checks の job が失敗した状態で動かす"):
        jobs = _skip_jobs() + [{"name": "checks (lint)", "conclusion": "failure"}]
        r = run(jobs, LINT_MODE="skip", CHECKS_RESULT="skipped")
    with allure.step("非 0 の終了と失敗の出力を確かめる"):
        assert r.returncode != 0
        assert "checks (lint): failure" in r.stdout


@allure.title("lint を飛ばす設定でも、lanes の結果が failure なら、失敗で終わる")
def test_lint_skip_still_checks_lanes(run) -> None:
    """`LINT_MODE` が `skip` で、`LANES_RESULT` が `failure` の場合のテストです。lint を飛ばしても、レーンの結果で成否を判定し、終了コードが 0 以外になることを確認します。"""
    with allure.step("lint を飛ばして lanes が失敗した状態で動かす"):
        r = run(_skip_jobs(), LINT_MODE="skip", CHECKS_RESULT="skipped", LANES_RESULT="failure")
    with allure.step("非 0 の終了を確かめる"):
        assert r.returncode != 0


@allure.title("lint を実行する設定では、checks (lint) のジョブが成功していないと失敗で終わる")
def test_lint_run_requires_checks_lint(run) -> None:
    """`LINT_MODE` が `run` の場合のテストです。`checks (lint)` が成功していれば終了コード 0 で終わり、ジョブが存在しない場合や `CHECKS_RESULT` が `skipped` の場合は 0 以外で終わることを確認します。"""
    with allure.step("lint を動かす指定で動かす"):
        r = run(_jobs(), LINT_MODE="run")
    with allure.step("checks (lint) が無い・skipped のとき非 0 になることを確かめる"):
        assert r.returncode == 0, r.stdout + r.stderr
        assert run(_skip_jobs(), LINT_MODE="run").returncode != 0
        assert run(_jobs(), LINT_MODE="run", CHECKS_RESULT="skipped").returncode != 0


@allure.title("LINT_MODE に未知の値を指定すると、LINT_MODE を理由として出力して失敗で終わる")
def test_lint_mode_unknown_value_fails(run) -> None:
    """`LINT_MODE` に `maybe` のような未知の値を指定した場合のテストです。終了コードが 0 以外で、`LINT_MODE` を含むメッセージを出力することを確認します。"""
    with allure.step("lint の指定に未知の値を渡して動かす"):
        r = run(_jobs(), LINT_MODE="maybe")
    with allure.step("非 0 の終了と LINT_MODE の出力を確かめる"):
        assert r.returncode != 0
        assert "LINT_MODE" in r.stdout
