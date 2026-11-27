"""ci.yml が開発版のテストレポートの材料（`allure-results-<slug>`・`lane-sources`）を上げる形の確かめ。

マージキューの run は main に入るまで動かないため、形と run: のシェルをここで固定する。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import allure
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CI = _REPO_ROOT / ".github/workflows/ci.yml"
_PR_RUN_LIB = _REPO_ROOT / ".githooks/lib/pr-run.sh"

_DEV_URL = "https://pecotcraft.github.io/pecot/dev/"
_SAME_REPO_OR_QUEUE = (
    "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name"
    " == github.repository) || github.event_name == 'merge_group'"
)
_MERGE_GROUP = "github.event_name == 'merge_group'"
_SHA = "a" * 40
_PR_HEAD = "b" * 40


def _load() -> dict[Any, Any]:
    return yaml.safe_load(_CI.read_text(encoding="utf-8"))


def _job(name: str) -> dict[str, Any]:
    return _load()["jobs"][name]


def _names(job: str) -> list[str]:
    return [s.get("name", "") for s in _job(job)["steps"]]


def _step(job: str, name: str) -> dict[str, Any]:
    step = next((s for s in _job(job)["steps"] if s.get("name") == name), None)
    assert step is not None, f"{job} に step が無い: {name}"
    return step


def _run_step(step: dict[str, Any], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    script = cwd.parent / "step.sh"
    script.write_text(step["run"], encoding="utf-8")
    return run_attached(
        ["bash", "-e", str(script)],
        cwd=cwd,
        env={**os.environ, **env},
        text=True,
        capture_output=True,
        check=False,
    )


# ---------------------------------------------------------------- env


@allure.title("workflow の環境変数で、tms のリンクを開発版のサイトに向ける")
def test_workflow_env_points_tms_links_to_dev_site() -> None:
    """`ci.yml` の workflow の環境変数のテストです。`PECOT_REPORT_SITE_URL` に開発版のサイトの URL が設定されていることを確認します。"""
    with allure.step("ci.yml の env を読む"):
        env = _load()["env"]
    with allure.step("PECOT_REPORT_SITE_URL が開発版の URL であることを確かめる"):
        assert env["PECOT_REPORT_SITE_URL"] == _DEV_URL


@allure.title("tests の job は、サイトの URL を開発用のコンテナに渡す")
def test_tests_pass_site_url_into_container() -> None:
    """`tests` の job の `DEVCONTAINER_ENV` のテストです。job 固有の 4 つの変数に続けて、`PECOT_REPORT_SITE_URL` が並ぶことを確認します。"""
    with allure.step("tests の job の env を読む"):
        env = _job("tests")["env"]
    with allure.step("DEVCONTAINER_ENV に PECOT_REPORT_SITE_URL が並ぶことを確かめる"):
        assert "PECOT_REPORT_SITE_URL" not in env
        assert env["DEVCONTAINER_ENV"].split() == [
            "CHECKS_LANE",
            "CHECKS_SLUG",
            "PECOT_CI_NX_CACHE",
            "PECOT_CI_BROWSER",
            "PECOT_REPORT_SITE_URL",
        ]


# ---------------------------------------------------------------- tests の結果


@allure.title("レーンの結果は、同じリポの PR とマージキューで、job が成功したときだけ上げる")
def test_results_are_uploaded_only_on_success_of_same_repo_pr_or_queue() -> None:
    """`tests` の job の `Stage results` と `Upload results` の条件のテストです。どちらも同じリポの PR かマージキューに限り、`always()` を含まず、`Write job summary` の後に並ぶことを確認します。"""
    with allure.step("tests の job の step を読む"):
        names = _names("tests")
        stage, upload = _step("tests", "Stage results"), _step("tests", "Upload results")
    with allure.step("条件と並びを確かめる"):
        assert stage["if"] == _SAME_REPO_OR_QUEUE
        assert upload["if"] == _SAME_REPO_OR_QUEUE
        assert "always()" not in stage["if"] and "always()" not in upload["if"]
        assert names.index("Write job summary") < names.index("Stage results")
        assert names.index("Stage results") + 1 == names.index("Upload results")
        assert stage["continue-on-error"] is True


@allure.title("レーンの結果は、レーンの slug の名前で、隠しファイルも含めて 30 日間保存する")
def test_upload_results_keeps_hidden_files_for_thirty_days() -> None:
    """`Upload results` の step のテストです。artifact の名前・パス・保存期間 30 日・上書きの許可・`include-hidden-files`・ファイルが存在しないときに無視する設定が、期待どおりであることを確認します。"""
    with allure.step("結果の upload の step を読む"):
        upload = _step("tests", "Upload results")
    with allure.step("upload の設定を確かめる"):
        assert upload["uses"].startswith("actions/upload-artifact@")
        assert upload["continue-on-error"] is True
        assert upload["with"] == {
            "name": "allure-results-${{ matrix.slug }}",
            "path": "${{ runner.temp }}/ci-results/",
            "retention-days": 30,
            "overwrite": True,
            # 無いと .githooks/ の下のレーンの結果が外れる。
            "include-hidden-files": True,
            "if-no-files-found": "ignore",
        }


_LANES_PY = """import json
print(json.dumps([
    {"lane": "githooks:test-ci", "slug": "githooks-test-ci", "results": ".githooks/test-results/test-ci/allure-results"},
    {"lane": "p:test-cli", "slug": "p-test-cli", "results": "plugins/p/test-results/test-cli/allure-results"},
]))
"""


@pytest.fixture
def stage_repo(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "repo"
    lanes = repo / ".githooks/scripts/test_report/lanes.py"
    lanes.parent.mkdir(parents=True)
    lanes.write_text(_LANES_PY, encoding="utf-8")
    temp = tmp_path / "runner-temp"
    temp.mkdir()
    return repo, temp


@allure.title("レーンが {lane} のとき、結果のディレクトリをリポのルートからのパスのまま集める")
@pytest.mark.parametrize(
    "lane",
    ["githooks:test-ci", "p:test-cli"],
)
def test_stage_results_keeps_the_repo_relative_path(
    stage_repo: tuple[Path, Path], lane: str
) -> None:
    """`Stage results` の step を、偽の `lanes.py` を置いたディレクトリで実行した場合のテストです。そのレーンの結果だけが、リポのルートからのパスのまま集められ、`source.json` を作らないことを確認します。"""
    with allure.step("2 つのレーンの結果を置き、結果を集める step を動かす"):
        repo, temp = stage_repo
        paths = {
            "githooks:test-ci": ".githooks/test-results/test-ci/allure-results",
            "p:test-cli": "plugins/p/test-results/test-cli/allure-results",
        }
        for path in paths.values():
            (repo / path).mkdir(parents=True)
            (repo / path / "1-result.json").write_text("{}", encoding="utf-8")
        env = {"RUNNER_TEMP": str(temp), "CHECKS_LANE": lane}
        result = _run_step(_step("tests", "Stage results"), repo, env)
    with allure.step("そのレーンの結果だけを、同じパスで集めたことを確かめる"):
        assert result.returncode == 0, result.stderr
        stage = temp / "ci-results"
        files = sorted(str(p.relative_to(stage)) for p in stage.rglob("*") if p.is_file())
        assert files == [f"{paths[lane]}/1-result.json"]


@allure.title("{case}のとき、結果を集めず、何も上げない")
@pytest.mark.parametrize("case", ["レポートのレーンでない", "結果のディレクトリが存在しない"])
def test_stage_results_stages_nothing(stage_repo: tuple[Path, Path], case: str) -> None:
    """`Stage results` の step で、集める結果が無い場合のテストです。step は成功で終わり、集める場所にファイルを作らないことを確認します。"""
    with allure.step("集める結果の無い状態で、結果を集める step を動かす"):
        repo, temp = stage_repo
        lane = "q:test-other" if case == "レポートのレーンでない" else "p:test-cli"
        result = _run_step(
            _step("tests", "Stage results"), repo, {"RUNNER_TEMP": str(temp), "CHECKS_LANE": lane}
        )
    with allure.step("成功で終わり、ファイルが無いことを確かめる"):
        assert result.returncode == 0, result.stderr
        stage = temp / "ci-results"
        assert not stage.exists() or not any(p.is_file() for p in stage.rglob("*"))


@allure.title("結果を写す途中で失敗すると、step は失敗し、上げる場所に欠けた結果を置かない")
@pytest.mark.skipif(os.geteuid() == 0, reason="root は読み取り権限を無視する")
def test_stage_results_leaves_nothing_when_copy_fails(stage_repo: tuple[Path, Path]) -> None:
    """`Stage results` の step で、結果のファイルを写せない場合のテストです。step が失敗で終わり、前の run の残りも含めて、上げる場所に何も存在しないことを確認します。"""
    with allure.step("読めないファイルを含む結果と、前の残りを置いて、結果を集める step を動かす"):
        repo, temp = stage_repo
        path = repo / "plugins/p/test-results/test-cli/allure-results"
        path.mkdir(parents=True)
        (path / "1-result.json").write_text("{}", encoding="utf-8")
        unreadable = path / "2-result.json"
        unreadable.write_text("{}", encoding="utf-8")
        unreadable.chmod(0)
        (temp / "ci-results").mkdir()
        (temp / "ci-results" / "old.json").write_text("{}", encoding="utf-8")
        try:
            result = _run_step(
                _step("tests", "Stage results"),
                repo,
                {"RUNNER_TEMP": str(temp), "CHECKS_LANE": "p:test-cli"},
            )
        finally:
            unreadable.chmod(0o644)
    with allure.step("失敗で終わり、上げる場所が存在しないことを確かめる"):
        assert result.returncode != 0
        assert not (temp / "ci-results").exists()


# ---------------------------------------------------------------- lane-sources


@allure.title("lane-sources は、マージキューの run だけで、レーンの一覧の後に書いて上げる")
def test_lane_sources_run_only_in_merge_group() -> None:
    """`lanes` の job の `Write lane sources` と `Upload lane sources` のテストです。どちらも `merge_group` のときだけ動き、`List test lanes` の後に並ぶことを確認します。"""
    with allure.step("lanes の job の step を読む"):
        names = _names("lanes")
        write, upload = _step("lanes", "Write lane sources"), _step("lanes", "Upload lane sources")
    with allure.step("条件と並びを確かめる"):
        assert write["if"] == _MERGE_GROUP
        assert upload["if"] == _MERGE_GROUP
        assert names.index("List test lanes") < names.index("Write lane sources")
        assert names.index("Write lane sources") + 1 == names.index("Upload lane sources")


@allure.title("lane-sources は、PR の CI の run とレーンの一覧の出力から書く")
def test_write_lane_sources_reads_pr_base_and_lane_outputs() -> None:
    """`Write lane sources` の step の環境変数のテストです。マージキューのコミットと ref、`Find PR CI base` の `pr_run`・`pr_head`、`List test lanes` の `lanes`・`skipped` を渡すことを確認します。"""
    with allure.step("lane-sources を書く step の env を読む"):
        env = _step("lanes", "Write lane sources")["env"]
    with allure.step("env の出どころを確かめる"):
        assert env == {
            "COMMIT": "${{ github.event.merge_group.head_sha }}",
            "HEAD_REF": "${{ github.event.merge_group.head_ref }}",
            "PR_RUN": "${{ steps.prbase.outputs.pr_run }}",
            "PR_HEAD": "${{ steps.prbase.outputs.pr_head }}",
            "LANES": "${{ steps.list.outputs.lanes }}",
            "SKIPPED": "${{ steps.list.outputs.skipped }}",
        }
        assert _step("lanes", "Find PR CI base")["id"] == "prbase"
        assert _step("lanes", "List test lanes")["id"] == "list"


@allure.title("lane-sources は、30 日間保存し、ファイルが存在しないと失敗する")
def test_upload_lane_sources_keeps_for_thirty_days() -> None:
    """`Upload lane sources` の step のテストです。artifact の名前・パス・保存期間 30 日・上書きの許可・ファイルが存在しないときのエラーが、期待どおりであることを確認します。"""
    with allure.step("lane-sources の upload の step を読む"):
        upload = _step("lanes", "Upload lane sources")
    with allure.step("upload の設定を確かめる"):
        assert upload["uses"].startswith("actions/upload-artifact@")
        assert upload["with"] == {
            "name": "lane-sources",
            "path": ".pecot/tmp/ci/lane-sources/lane-sources.json",
            "retention-days": 30,
            "overwrite": True,
            "if-no-files-found": "error",
        }


def _write_lane_sources(tmp_path: Path, pr_run: str, pr_head: str, head_ref: str) -> dict:
    repo = tmp_path / "repo"
    (repo / ".githooks/lib").mkdir(parents=True)
    shutil.copy(_PR_RUN_LIB, repo / ".githooks/lib/pr-run.sh")
    env = {
        "COMMIT": _SHA,
        "HEAD_REF": head_ref,
        "PR_RUN": pr_run,
        "PR_HEAD": pr_head,
        "LANES": json.dumps(
            [
                {"lane": "githooks:test-ci", "slug": "githooks-test-ci"},
                {"lane": "p:test-cli", "slug": "p-test-cli"},
            ]
        ),
        "SKIPPED": json.dumps(["p:test-unit", "q:test-hooks"]),
    }
    result = _run_step(_step("lanes", "Write lane sources"), repo, env)
    assert result.returncode == 0, result.stderr
    return json.loads(read_output(repo / ".pecot/tmp/ci/lane-sources/lane-sources.json"))


@allure.title("PR の CI の run が見つかると、PR の番号・head・run と、省いたレーンを書く")
def test_write_lane_sources_with_pr_run(tmp_path: Path) -> None:
    """`Write lane sources` の step を、`pr_run` と `pr_head` がある状態で実行した場合のテストです。PR の番号を ref から読み、`merge_group` にこの run のレーン、`pull_request` に省いたレーンを書くことを確認します。"""
    with allure.step("PR の CI の run がある状態で、lane-sources を書く step を動かす"):
        ref = f"refs/heads/gh-readonly-queue/main/pr-123-{_SHA}"
        sources = _write_lane_sources(tmp_path, "456", _PR_HEAD, ref)
    with allure.step("lane-sources の中身を確かめる"):
        assert sources == {
            "commit": _SHA,
            "pr": 123,
            "pr_head": _PR_HEAD,
            "pr_run": 456,
            "merge_group": ["githooks:test-ci", "p:test-cli"],
            "pull_request": ["p:test-unit", "q:test-hooks"],
        }


@allure.title("{case}のとき、PR の欄を null にし、pull_request を空にする")
@pytest.mark.parametrize(
    ("case", "pr_run", "pr_head", "head_ref"),
    [
        ("PR の CI の run が見つからない", "", "", "gh-readonly-queue/main/pr-123-" + _SHA),
        ("ref から PR の番号を読めない", "456", _PR_HEAD, "refs/heads/other"),
        ("pr_run が数でない", "abc", _PR_HEAD, "gh-readonly-queue/main/pr-123-" + _SHA),
        ("pr_head が 40 桁の SHA でない", "456", "main", "gh-readonly-queue/main/pr-123-" + _SHA),
    ],
)
def test_write_lane_sources_without_pr_run(
    tmp_path: Path, case: str, pr_run: str, pr_head: str, head_ref: str
) -> None:
    """`Write lane sources` の step を、PR の CI の run を使えない状態で実行した場合のテストです。`pr`・`pr_head`・`pr_run` が `null`、`pull_request` が空の配列になり、`merge_group` にはこの run のレーンを書くことを確認します。"""
    with allure.step("PR の CI の run を使えない状態で、lane-sources を書く step を動かす"):
        sources = _write_lane_sources(tmp_path, pr_run, pr_head, head_ref)
    with allure.step("PR の欄が null で、pull_request が空であることを確かめる"):
        assert sources == {
            "commit": _SHA,
            "pr": None,
            "pr_head": None,
            "pr_run": None,
            "merge_group": ["githooks:test-ci", "p:test-cli"],
            "pull_request": [],
        }
