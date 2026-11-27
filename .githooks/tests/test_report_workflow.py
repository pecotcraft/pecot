"""test-report.yml の形と、release.yml がそれを起こす step の確かめ。

契機・権限・concurrency・artifact の決まりは specs/030-allure-test-report/contracts/test-report.md にある。
workflow_dispatch は main に定義が入るまで動かせないため、形と run: のシェルをここで固定する。
"""

from __future__ import annotations

import json
import os
import re
import shlex
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
_REPORT = _REPO_ROOT / ".github/workflows/test-report.yml"
_CI = _REPO_ROOT / ".github/workflows/ci.yml"
_RELEASE = _REPO_ROOT / ".github/workflows/release.yml"

_DEV_URL = "https://pecotcraft.github.io/pecot/dev/"
_RELEASE_URL = "https://pecotcraft.github.io/pecot/"
_SHA = "a" * 40


def _load(path: Path) -> dict[Any, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _job(name: str, path: Path = _REPORT) -> dict[str, Any]:
    return _load(path)["jobs"][name]


def _steps(job: str, path: Path = _REPORT) -> list[dict[str, Any]]:
    return _job(job, path)["steps"]


def _step(job: str, name: str, path: Path = _REPORT) -> dict[str, Any]:
    step = next((s for s in _steps(job, path) if s.get("name") == name), None)
    assert step is not None, f"{job} に step が無い: {name}"
    return step


def _uses(job: str, action: str) -> list[dict[str, Any]]:
    return [s for s in _steps(job) if s.get("uses", "").startswith(f"{action}@")]


def _all_steps() -> list[tuple[str, dict[str, Any]]]:
    return [(name, step) for name, job in _load(_REPORT)["jobs"].items() for step in job["steps"]]


def _bash(
    script: str, cwd: Path, env: dict[str, str], bin_dir: Path | None = None
) -> subprocess.CompletedProcess[str]:
    path = os.environ["PATH"] if bin_dir is None else f"{bin_dir}:{os.environ['PATH']}"
    return run_attached(
        ["bash", "-e", "-c", script],
        cwd=cwd,
        env={**os.environ, **env, "PATH": path},
        text=True,
        capture_output=True,
        check=False,
    )


def _fake(bin_dir: Path, name: str, body: str) -> None:
    bin_dir.mkdir(exist_ok=True)
    path = bin_dir / name
    path.write_text(f"#!/usr/bin/env bash\n{body}\n", encoding="utf-8")
    path.chmod(0o755)


def _outputs(path: Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in read_output(path).splitlines())


# ---------------------------------------------------------------- 契機・権限・concurrency


@allure.title("test-report は、main への push と手動の起動だけで動く")
def test_triggers_are_push_to_main_and_dispatch_only() -> None:
    """`test-report.yml` の契機のテストです。`push` と `workflow_dispatch` の 2 つだけが存在し、`push` は main に限り、手動の起動では `release` と `dev` から側を選べることを確認します。"""
    with allure.step("test-report.yml の on を読む"):
        on = _load(_REPORT)[True]
    with allure.step("main への push と dispatch だけであることを確かめる"):
        assert set(on) == {"push", "workflow_dispatch"}
        assert on["push"] == {"branches": ["main"]}
        inputs = on["workflow_dispatch"]["inputs"]
        assert set(inputs) == {"side"}
        assert inputs["side"]["type"] == "choice"
        assert inputs["side"]["options"] == ["release", "dev"]


@allure.title("main 以外のブランチから手動で起動すると、最初の step で失敗する")
def test_dispatch_outside_main_fails_before_anything_else() -> None:
    """`side` の job の最初の step のテストです。`workflow_dispatch` かつ main 以外のブランチのときだけ動き、`exit 1` で終了することを確認します。"""
    with allure.step("side の job の最初の step を読む"):
        first = _steps("side")[0]
    with allure.step("main の外の dispatch を最初に失敗させることを確かめる"):
        assert first["if"] == (
            "${{ github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main' }}"
        )
        assert "exit 1" in first["run"]


@allure.title(
    "test-report の権限は、contents の読み取りと、side と report の actions の読み取りと、履歴の job の id-token に限る"
)
def test_permissions_are_limited_per_job() -> None:
    """`test-report.yml` の権限のテストです。workflow の既定は `contents: read` だけで、`side` と `report` は `actions: read` を加えます。`id-token: write` を持つのは、`history-get` と `history-put` だけであることを確認します。"""
    with allure.step("workflow と job の権限を読む"):
        workflow = _load(_REPORT)
    with allure.step("job ごとの権限が決めた形であることを確かめる"):
        assert workflow["permissions"] == {"contents": "read"}
        jobs = workflow["jobs"]
        for name in ("side", "report"):
            assert jobs[name]["permissions"] == {"contents": "read", "actions": "read"}, name
        assert "permissions" not in jobs["tests"]
        assert jobs["history-get"]["permissions"] == {"contents": "read", "id-token": "write"}
        assert jobs["history-put"]["permissions"] == {"id-token": "write"}


@allure.title(
    "environment の test-report-history は、デプロイを記録せず、履歴の 2 つの job だけが使う"
)
def test_only_history_jobs_use_the_history_environment() -> None:
    """`test-report.yml` の environment のテストです。`test-report-history` を使うのが `history-get` と `history-put` だけで、どちらも `deployment: false` であることを確認します。"""
    with allure.step("job ごとの environment を読む"):
        jobs = _load(_REPORT)["jobs"]
    with allure.step("履歴の 2 つの job だけが environment を持つことを確かめる"):
        environments = {name: job.get("environment") for name, job in jobs.items()}
        expected = {"name": "test-report-history", "deployment": False}
        assert environments == {
            "side": None,
            "tests": None,
            "history-get": expected,
            "report": None,
            "history-put": expected,
        }


@allure.title("同じ側の run は、取り消さず、順番に待つ")
def test_concurrency_waits_per_side_without_cancelling() -> None:
    """`test-report.yml` の `concurrency` のテストです。グループが側ごとに分かれ、`cancel-in-progress` が `false` であることを確認します。"""
    with allure.step("concurrency が side ごとに待ち、止めない設定であることを確かめる"):
        assert _load(_REPORT)["concurrency"] == {
            "group": "test-report-${{ inputs.side || 'dev' }}",
            "cancel-in-progress": False,
        }


@allure.title("環境変数は ci.yml と同じ値にし、側ごとの URL は 1 か所だけに書く")
def test_env_matches_ci_and_holds_side_urls_once() -> None:
    """`test-report.yml` の環境変数のテストです。`PECOT_NX_CI` と `PECOTV_E2E_CEILING_SCALE` が `ci.yml` の値と一致することを確認します。開発版とリリース版のサイトの URL は、1 つずつだけ書かれています。"""
    with allure.step("test-report.yml と ci.yml の env を読む"):
        env, ci_env = _load(_REPORT)["env"], _load(_CI)["env"]
    with allure.step("env が ci.yml と合い、side の URL を 1 回ずつ持つことを確かめる"):
        for key in ("PECOT_NX_CI", "PECOTV_E2E_CEILING_SCALE"):
            assert env[key] == ci_env[key], key
        assert env["DEV_SITE_URL"] == _DEV_URL
        assert env["RELEASE_SITE_URL"] == _RELEASE_URL
        assert _REPORT.read_text(encoding="utf-8").count("pecotcraft.github.io") == 2


# ---------------------------------------------------------------- side


@allure.title(
    "job は side・tests・history-get・report・history-put の順に、前の job を待って実行する"
)
def test_jobs_are_side_tests_history_get_report_history_put() -> None:
    """`test-report.yml` の job の構成のテストです。5 つの job が決まった順に存在し、`report` が `history-get` を待ち、`history-put` が `history-get` と `report` を待つことを確認します。"""
    with allure.step("test-report.yml の job を読む"):
        jobs = _load(_REPORT)["jobs"]
    with allure.step("job の順と needs のつながりを確かめる"):
        assert list(jobs) == ["side", "tests", "history-get", "report", "history-put"]
        assert jobs["tests"]["needs"] == "side"
        assert jobs["history-get"]["needs"] == "side"
        assert jobs["report"]["needs"] == ["side", "tests", "history-get"]
        assert jobs["history-put"]["needs"] == ["side", "history-get", "report"]


@allure.title(
    "side の job は、レポートの材料を求め、レポートを作るかとレーンを動かすかを分けて出力する"
)
def test_side_resolves_report_sources() -> None:
    """`Resolve report sources` の step のテストです。側とコミットとリポジトリと `GH_TOKEN` が環境変数で渡され、job の出力に `report` と `run_tests` が分かれて含まれることを確認します。"""
    with allure.step("report の元を決める step を読む"):
        step = _step("side", "Resolve report sources")
    with allure.step("env と output が決めた形であることを確かめる"):
        assert step["env"]["SIDE"] == "${{ steps.decide.outputs.side }}"
        assert step["env"]["SHA"] == "${{ github.sha }}"
        assert step["env"]["REPO"] == "${{ github.repository }}"
        assert step["env"]["GH_TOKEN"] == "${{ github.token }}"
        outputs = _job("side")["outputs"]
        assert outputs == {
            "side": "${{ steps.decide.outputs.side }}",
            "site_url": "${{ steps.decide.outputs.site_url }}",
            "report": "${{ steps.sources.outputs.report }}",
            "run_tests": "${{ steps.sources.outputs.run_tests }}",
            "matrix": "${{ steps.sources.outputs.matrix }}",
            "sources": "${{ steps.sources.outputs.sources }}",
        }


@allure.title("side の job は、開発版のときだけ、report の job と同じ手順で Node.js と依存を入れる")
def test_side_installs_node_only_for_dev() -> None:
    """`side` の job の step の並びのテストです。`Resolve report sources` の前に Node.js と依存を入れる 3 つの step があり、開発版のときだけ動き、設定が `report` の job と同じであることを確認します。"""
    with allure.step("side の step の名前を読む"):
        names = [s["name"] for s in _steps("side")]
        expected = ["Set up Node.js", "Enable Corepack", "Install dependencies"]
    with allure.step("Node.js の準備が開発版だけで動き、report の job と同じであることを確かめる"):
        assert names == [
            "Check ref",
            "Checkout",
            "Decide side",
            *expected,
            "Resolve report sources",
        ]
        for name in expected:
            mine, theirs = _step("side", name), _step("report", name)
            assert mine["if"] == "${{ steps.decide.outputs.side == 'dev' }}", name
            assert {k: v for k, v in mine.items() if k not in ("name", "if")} == {
                k: v for k, v in theirs.items() if k != "name"
            }, name


@allure.title(
    "{event} で側の入力が {input_side} のとき、側を {side} に、サイトの URL を {url} に決める"
)
@pytest.mark.parametrize(
    ("event", "input_side", "side", "url"),
    [
        ("push", "", "dev", _DEV_URL),
        ("workflow_dispatch", "dev", "dev", _DEV_URL),
        ("workflow_dispatch", "release", "release", _RELEASE_URL),
    ],
)
def test_side_decides_side_and_site_url(
    tmp_path: Path, event: str, input_side: str, side: str, url: str
) -> None:
    """`Decide side` の step を、イベントと入力を変えて実行した場合のテストです。push では `dev` に、手動の起動では入力どおりの側に決まり、側に応じたサイトの URL が出力されることを確認します。"""
    with allure.step("side を決める step の env を読み、イベントと入力を渡して run を動かす"):
        step = _step("side", "Decide side")
        assert step["env"] == {
            "EVENT_NAME": "${{ github.event_name }}",
            "INPUT_SIDE": "${{ inputs.side }}",
        }
        output = tmp_path / "output"
        env = {
            "EVENT_NAME": event,
            "INPUT_SIDE": input_side,
            "GITHUB_OUTPUT": str(output),
            "DEV_SITE_URL": _DEV_URL,
            "RELEASE_SITE_URL": _RELEASE_URL,
        }
        result = _bash(step["run"], tmp_path, env)
    with allure.step("side とサイトの URL が決まることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert _outputs(output) == {"side": side, "site_url": url}


def _resolve_sources(tmp_path: Path, side: str, stdout: dict[str, Any]) -> tuple[Path, Path, Path]:
    bin_dir, output, summary = tmp_path / "bin", tmp_path / "output", tmp_path / "summary"
    calls = tmp_path / "calls"
    _fake(bin_dir, "python3", f"echo \"$*\" >> {calls}\ncat <<'EOF'\n{json.dumps(stdout)}\nEOF")
    step = _step("side", "Resolve report sources")
    env = {
        **step["env"],
        "SIDE": side,
        "SHA": _SHA,
        "REPO": "o/r",
        "GITHUB_OUTPUT": str(output),
        "GITHUB_STEP_SUMMARY": str(summary),
    }
    result = _bash(step["run"], tmp_path, env, bin_dir)
    assert result.returncode == 0, result.stderr
    return calls, output, summary


_DEV_JOB = {"lane": "p:test-cli", "slug": "p-test-cli", "results": "r", "commit": _SHA}


@allure.title(
    "開発版で main で動かすレーンが {param_id} のとき、レポートは必ず作り、レーンがあるときだけ動かす"
)
@pytest.mark.parametrize(
    ("jobs", "run_tests"),
    [([_DEV_JOB], "true"), ([], "false")],
    ids=["ある", "無い"],
)
def test_side_resolves_dev_with_dev_sources(
    tmp_path: Path, jobs: list[dict[str, str]], run_tests: str
) -> None:
    """`Resolve report sources` の step を `dev` で実行した場合のテストです。`dev_sources.py resolve` にコミットとリポジトリが渡され、`report` が常に `true` で、`run_tests` が matrix の有無で決まることを確認します。"""
    with allure.step("dev の元を返す偽の script で、report の元を決める step を動かす"):
        runs = [{"commit": _SHA, "lanes": ["p:test-cli"]}] if jobs else []
        sources = {"side": "dev", "runs": runs, "missing": [], "latest": []}
        calls, output, summary = _resolve_sources(
            tmp_path, "dev", {"sources": sources, "matrix": jobs}
        )
    with allure.step("commit とリポを渡し、出力を分けて書くことを確かめる"):
        assert read_output(calls) == (
            f".githooks/scripts/test_report/dev_sources.py resolve --head {_SHA} --repo o/r\n"
        )
        out = _outputs(output)
        assert out["report"] == "true"
        assert out["run_tests"] == run_tests
        assert json.loads(out["matrix"]) == jobs
        assert json.loads(out["sources"]) == sources
        assert not summary.exists() or read_output(summary) == ""


@allure.title("リリース版でレポートの材料が不足すると、レポートを作らず、不足を一覧で表示する")
def test_side_skips_report_and_lists_missing_for_release(tmp_path: Path) -> None:
    """`Resolve report sources` の step を `release` で実行し、対象の run が存在しない場合のテストです。`report` が `false`、matrix が `[]` になり、サマリーに不足したプラグインの一覧が表示されることを確認します。"""
    with allure.step("不足のある release の元で、report の元を決める step を動かす"):
        sources = {"side": "release", "runs": [], "missing": ["pecot-tools", "pecot-visual"]}
        calls, output, summary = _resolve_sources(
            tmp_path, "release", {"sources": sources, "matrix": []}
        )
    with allure.step("report を飛ばし、不足を要約に載せることを確かめる"):
        assert read_output(calls) == (
            ".githooks/scripts/pages_site/release_sources.py --report release --main origin/main\n"
        )
        out = _outputs(output)
        assert out["report"] == "false"
        assert out["run_tests"] == "false"
        assert out["matrix"] == "[]"
        text = read_output(summary)
        env = _step("side", "Resolve report sources")["env"]
        assert env["MSG_MISSING"] in text
        assert env["MSG_NO_REPORT"] in text
        assert "- pecot-tools\n- pecot-visual\n" in text


# ---------------------------------------------------------------- tests


@allure.title("tests の job は、レーンがあるときだけ動き、1 つが失敗しても続ける")
def test_tests_run_only_with_lanes_and_keep_going() -> None:
    """`tests` の job のテストです。`run_tests` が `true` のときだけ実行され、名前にレーンが入り、タイムアウトが ci.yml と同じで、`fail-fast` が `false` の matrix を使うことを確認します。"""
    with allure.step("tests の job を読む"):
        job = _job("tests")
    with allure.step("レーンがあるときだけ動き、1 つの失敗で止まらないことを確かめる"):
        assert job["if"] == "${{ needs.side.outputs.run_tests == 'true' }}"
        assert job["name"] == "tests (${{ matrix.lane }})"
        assert job["timeout-minutes"] == _job("tests", _CI)["timeout-minutes"]
        assert job["strategy"] == {
            "fail-fast": False,
            "matrix": {"include": "${{ fromJSON(needs.side.outputs.matrix) }}"},
        }


@allure.title("tests の job は、開発用のコンテナを起動する前に、レポートのコミットへ切り替える")
def test_tests_switch_to_report_commit_before_the_dev_container() -> None:
    """`tests` の job の step の並びのテストです。`Check out report commit` がコンテナの起動の前にあり、`git checkout --force` に `COMMIT` を渡すことを確認します。"""
    with allure.step("tests の step の名前を読む"):
        names = [s["name"] for s in _steps("tests")]
    with allure.step("dev container の前に report の commit へ切り替えることを確かめる"):
        assert names == [
            "Checkout",
            "Check out report commit",
            "Start pulling dev container image",
            "Start dev container",
            "Run tests",
            "Restore workspace owner",
            "Stage results",
            "Upload results",
        ]
        switch = _step("tests", "Check out report commit")
        assert 'git checkout --force "$COMMIT"' in switch["run"]
        assert _job("tests")["env"]["COMMIT"] == "${{ matrix.commit }}"


@allure.title("tests の job は、1 つのレーンを実行し、テストが失敗しても job は失敗させない")
def test_tests_run_one_lane_without_failing_the_job() -> None:
    """`Run tests` の step のテストです。`continue-on-error` が `true` で、`nx run` に `CHECKS_LANE` を渡し、後始末の 3 つの step が `always()` で実行されることを確認します。"""
    with allure.step("テストを動かす step を読む"):
        step = _step("tests", "Run tests")
    with allure.step("1 レーンを動かし、失敗しても job を落とさないことを確かめる"):
        assert step["continue-on-error"] is True
        assert 'pnpm exec nx run "$CHECKS_LANE" --skip-nx-cache' in step["run"]
        assert step["run"].lstrip().startswith("# shellcheck disable=SC2016\n")
        assert _job("tests")["env"]["CHECKS_LANE"] == "${{ matrix.lane }}"
        for name in ("Restore workspace owner", "Stage results", "Upload results"):
            assert _step("tests", name)["if"] == "always()", name
        assert _step("tests", "Restore workspace owner")["run"] == (
            ".githooks/ci/dev-container.sh restore-owner"
        )


@allure.title("サイトの URL とブラウザの設定を、開発用のコンテナに渡す")
def test_tests_pass_site_url_and_browser_into_container() -> None:
    """`tests` の job の環境変数のテストです。`PECOT_REPORT_SITE_URL` と `PECOT_CI_BROWSER` が設定され、`DEVCONTAINER_ENV` に 3 つの変数が並ぶことを確認します。"""
    with allure.step("tests の job の env を読む"):
        env = _job("tests")["env"]
    with allure.step("サイトの URL とブラウザをコンテナへ渡すことを確かめる"):
        assert env["PECOT_REPORT_SITE_URL"] == "${{ needs.side.outputs.site_url }}"
        assert env["PECOT_CI_BROWSER"] == _job("tests", _CI)["env"]["PECOT_CI_BROWSER"]
        assert env["DEVCONTAINER_ENV"].split() == [
            "CHECKS_LANE",
            "PECOT_REPORT_SITE_URL",
            "PECOT_CI_BROWSER",
        ]


@allure.title("テスト結果は、隠しファイルを含めて artifact としてアップロードする")
def test_tests_upload_results_with_hidden_files() -> None:
    """`Upload results` の step のテストです。名前・パス・保存期間 1 日・上書きの許可・`include-hidden-files`・ファイルが存在しないときのエラーが、期待どおりであることを確認します。"""
    with allure.step("結果の upload の step を読む"):
        (upload,) = _uses("tests", "actions/upload-artifact")
    with allure.step("隠しファイルも含めて upload することを確かめる"):
        assert upload["name"] == "Upload results"
        assert upload["with"] == {
            "name": "allure-results-${{ matrix.slug }}",
            "path": "${{ runner.temp }}/test-report-results/",
            "retention-days": 1,
            "overwrite": True,
            # 無いと .githooks/ の下のレーンの結果が外れる。
            "include-hidden-files": True,
            "if-no-files-found": "error",
        }
        assert _job("tests")["env"]["RESULTS"] == "${{ matrix.results }}"


def _stage_repo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    git = ["git", "-C", str(repo)]
    subprocess.run([*git, "init", "-q"], check=True)
    (repo / "x.txt").write_text("x", encoding="utf-8")
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run(
        [*git, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]
        + ["commit", "-q", "-m", "x"],
        check=True,
    )
    head = run_attached(
        [*git, "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()
    return repo, head


@allure.title(
    "テスト結果の状態が {param_id} のとき、結果を集める場所に source.json を作成し、結果があればコピーする"
)
@pytest.mark.parametrize("with_results", [True, False], ids=["results", "no-results"])
def test_stage_results_copies_results_and_writes_source(tmp_path: Path, with_results: bool) -> None:
    """`Stage results` の step を一時的な git リポジトリで実行した場合のテストです。`source.json` にレーンと HEAD のコミットが書かれ、テスト結果は存在するときだけコピーされることを確認します。"""
    with allure.step("結果と ref の元になるリポを用意し、結果を集める step の run を動かす"):
        repo, head = _stage_repo(tmp_path)
        results = ".githooks/test-results/test-ci/allure-results"
        if with_results:
            (repo / results).mkdir(parents=True)
            (repo / results / "1-result.json").write_text("{}", encoding="utf-8")
        temp = tmp_path / "runner-temp"
        temp.mkdir()
        env = {"RUNNER_TEMP": str(temp), "RESULTS": results, "CHECKS_LANE": "githooks:test-ci"}

        result = _bash(_step("tests", "Stage results")["run"], repo, env)

    with allure.step("結果を写し、source.json にレーンと commit を書くことを確かめる"):
        assert result.returncode == 0, result.stderr
        stage = temp / "test-report-results"
        source = json.loads(read_output(stage / ".githooks/test-results/test-ci/source.json"))
        assert source == {"lane": "githooks:test-ci", "commit": head}
        assert (stage / results / "1-result.json").is_file() == with_results


# ---------------------------------------------------------------- report


@allure.title("report の job は、取り消されていなければ、レポートがあるときに動く")
def test_report_runs_unless_cancelled() -> None:
    """`report` の job の条件のテストです。取り消されておらず、`side` の `report` の出力が `true` であることを確認します。"""
    with allure.step("report の job が、取り消されないかぎり動く条件であることを確かめる"):
        assert _job("report")["if"] == "${{ !cancelled() && needs.side.outputs.report == 'true' }}"


@allure.title("report の job は、version-plan と同じ手順で Node.js をセットアップする")
def test_report_installs_node_on_the_runner_like_version_plan() -> None:
    """`report` の job の step のテストです。最初の 4 つの step の設定が、ci.yml の `version-plan` と同じであることを確認します。その後に、レポートを生成する step が続きます。"""
    with allure.step("report の step の名前を読む"):
        names = [s["name"] for s in _steps("report")]
        expected = ["Checkout", "Set up Node.js", "Enable Corepack", "Install dependencies"]
    with allure.step("Node.js の準備が version-plan の job と同じであることを確かめる"):
        assert names[:4] == expected
        for name in expected[1:]:
            mine, theirs = _step("report", name), _step("version-plan", name, _CI)
            assert {k: v for k, v in mine.items() if k != "name"} == {
                k: v for k, v in theirs.items() if k != "name"
            }, name
        assert names[4:] == [
            "Download results",
            "Write report sources",
            "Fetch latest results",
            "Download history",
            "Prepare history",
            "Generate report",
            "Pack report",
            "Upload report",
            "Upload history",
            "Pack lane results",
            "Upload lane results",
            "Upload lane index",
        ]


@allure.title("report の job は、すべてのテスト結果をリポジトリのルートにダウンロードする")
def test_report_downloads_all_results_into_the_repo_root() -> None:
    """`actions/download-artifact` の設定のテストです。パターンが `allure-results-*` で、`merge-multiple` が有効で、保存先が `github.workspace` であることを確認します。"""
    with allure.step("結果の download の step を読む"):
        download = _step("report", "Download results")
    with allure.step("すべての結果をリポのルートへ集めることを確かめる"):
        assert download["with"] == {
            "pattern": "allure-results-*",
            "merge-multiple": True,
            "path": "${{ github.workspace }}",
        }


@allure.title("側が {side} のとき、レポートは材料を指定し、履歴はリリース版だけ指定して生成する")
@pytest.mark.parametrize(
    ("side", "history"), [("dev", False), ("release", True)], ids=["dev", "release"]
)
def test_report_generates_with_history_only_for_release(
    tmp_path: Path, side: str, history: bool
) -> None:
    """偽の `python3` で `Generate report` の step を実行した場合のテストです。`generate.py` に `--sources` と `--output` が渡され、`--history` はリリース版のときだけ渡されることを確認します。"""
    with allure.step("偽の python3 で report を作る step を動かす"):
        bin_dir, calls = tmp_path / "bin", tmp_path / "calls"
        _fake(bin_dir, "python3", f'echo "$*" >> {calls}')
        env = {"RUNNER_TEMP": str(tmp_path), "SIDE": side}
        result = _bash(_step("report", "Generate report")["run"], tmp_path, env, bin_dir)
    with allure.step("側に応じて履歴を渡すことを確かめる"):
        assert result.returncode == 0, result.stderr
        work = tmp_path / "test-report"
        expected = (
            f".githooks/scripts/test_report/generate.py --sources {work}/report-sources.json"
            f" --output {work}/site"
        )
        if history:
            expected += f" --history {work}/history.jsonl"
        assert read_output(calls) == expected + "\n"
        assert _job("report")["env"]["SOURCES"] == "${{ needs.side.outputs.sources }}"


@allure.title("report の job は、材料を作業のディレクトリに書き出す")
def test_report_writes_sources_into_the_work_dir(tmp_path: Path) -> None:
    """`Write report sources` の step のテストです。`SOURCES` の内容が、`RUNNER_TEMP` の下の `test-report/report-sources.json` にそのまま書かれることを確認します。"""
    with allure.step("材料を書き出す step を動かす"):
        sources = '{"side":"dev","runs":[],"missing":[],"latest":[]}'
        env = {"RUNNER_TEMP": str(tmp_path), "SOURCES": sources}
        result = _bash(_step("report", "Write report sources")["run"], tmp_path, env)
    with allure.step("材料のファイルの中身を確かめる"):
        assert result.returncode == 0, result.stderr
        assert read_output(tmp_path / "test-report/report-sources.json") == sources


@allure.title("開発版では、拾ったレーンの結果を ci と前の開発版の run の artifact から取り出す")
def test_report_fetches_latest_results_for_dev(tmp_path: Path) -> None:
    """`Fetch latest results` の step のテストです。開発版のときだけ動き、`dev_sources.py fetch` に材料・リポジトリ・ルートを渡し、`gh` に `GH_TOKEN` を渡すことを確認します。"""
    with allure.step("取り出しの step を読み、偽の python3 で動かす"):
        step = _step("report", "Fetch latest results")
        bin_dir, calls = tmp_path / "bin", tmp_path / "calls"
        _fake(bin_dir, "python3", f'echo "$*" >> {calls}')
        env = {"RUNNER_TEMP": str(tmp_path), "REPO": "o/r"}
        result = _bash(step["run"], tmp_path, env, bin_dir)
    with allure.step("開発版だけで動き、引数とトークンを渡すことを確かめる"):
        assert step["if"] == "${{ needs.side.outputs.side == 'dev' }}"
        assert step["env"] == {
            "REPO": "${{ github.repository }}",
            "GH_TOKEN": "${{ github.token }}",
        }
        assert result.returncode == 0, result.stderr
        assert read_output(calls) == (
            ".githooks/scripts/test_report/dev_sources.py fetch"
            f" --sources {tmp_path}/test-report/report-sources.json --repo o/r --root .\n"
        )


@allure.title("開発版では、レポートの後に、全レーンの結果と index を 90 日で保存する")
def test_report_packs_and_uploads_lane_latest_for_dev(tmp_path: Path) -> None:
    """`Pack lane results` と 2 つの upload の step のテストです。開発版のときだけ動き、`dev_sources.py pack` にコミットと run の ID を渡すことを確認します。`lane-latest` と `lane-latest-index` は 90 日で保存します。"""
    with allure.step("lane-latest を作る step を読み、偽の python3 で動かす"):
        step = _step("report", "Pack lane results")
        bin_dir, calls = tmp_path / "bin", tmp_path / "calls"
        _fake(bin_dir, "python3", f'echo "$*" >> {calls}')
        env = {"RUNNER_TEMP": str(tmp_path), "SHA": _SHA, "RUN_ID": "42"}
        result = _bash(step["run"], tmp_path, env, bin_dir)
    with allure.step("pack の引数と、upload の値を確かめる"):
        dev = "${{ needs.side.outputs.side == 'dev' }}"
        assert step["if"] == dev
        assert step["env"] == {"SHA": "${{ github.sha }}", "RUN_ID": "${{ github.run_id }}"}
        assert result.returncode == 0, result.stderr
        assert read_output(calls) == (
            ".githooks/scripts/test_report/dev_sources.py pack"
            f" --sources {tmp_path}/test-report/report-sources.json --root ."
            f" --out {tmp_path}/lane-latest --commit {_SHA} --run-id 42\n"
        )
        lanes, index = _step("report", "Upload lane results"), _step("report", "Upload lane index")
        assert lanes["if"] == dev and index["if"] == dev
        assert lanes["with"] == {
            "name": "lane-latest",
            "path": "${{ runner.temp }}/lane-latest/lane-latest/",
            "retention-days": 90,
            "overwrite": True,
            # 無いと .githooks/ の下のレーンの結果が外れる。
            "include-hidden-files": True,
            "if-no-files-found": "error",
        }
        assert index["with"] == {
            "name": "lane-latest-index",
            "path": "${{ runner.temp }}/lane-latest/lane-latest-index/lane-latest-index.json",
            "retention-days": 90,
            "overwrite": True,
            "if-no-files-found": "error",
        }


@allure.title("レポートは、側ごとの名前で 7 日間保存する")
def test_report_uploads_report_for_seven_days() -> None:
    """`Upload report` の step のテストです。名前に側が入り、パス・保存期間 7 日・上書きの許可・ファイルが存在しないときのエラーが、期待どおりであることを確認します。"""
    with allure.step("report の upload の step を読む"):
        upload = _step("report", "Upload report")
    with allure.step("7 日間 upload することを確かめる"):
        assert "if" not in upload
        assert upload["name"] == "Upload report"
        assert upload["with"] == {
            "name": "test-report-${{ needs.side.outputs.side }}",
            "path": "${{ runner.temp }}/test-report-artifact/",
            "retention-days": 7,
            "overwrite": True,
            "if-no-files-found": "error",
        }


@allure.title("リリース版で履歴が見つかったときだけ、history-get が上げた artifact を受け取る")
def test_report_downloads_history_only_for_release() -> None:
    """`report` の job の `Download history` の step のテストです。リリース版で `history-get` の `state` が `found` のときだけ動くことを確認します。`test-report-history-in` は、`RUNNER_TEMP` の下の `test-report` に受け取ります。artifact が無くても job を止めません。"""
    with allure.step("履歴を受け取る step を読む"):
        step = _step("report", "Download history")
    with allure.step("リリース版の found だけで動き、無くても止まらない設定であることを確かめる"):
        assert step["if"] == (
            "${{ needs.side.outputs.side == 'release'"
            " && needs.history-get.outputs.state == 'found' }}"
        )
        assert step["continue-on-error"] is True
        assert step["uses"].startswith("actions/download-artifact@")
        assert step["with"] == {
            "name": "test-report-history-in",
            "path": "${{ runner.temp }}/test-report",
        }


@allure.title(
    "{param_id} のとき、リリース版の履歴を用意し、無ければ空にして、受け取れなかったときだけ警告する"
)
@pytest.mark.parametrize(
    ("state", "downloaded", "kept", "received", "warned"),
    [
        ("found", '{"r":1}\n', '{"r":1}\n', "received", False),
        ("found", None, "", "empty", True),
        ("absent", None, "", "empty", False),
        ("unreadable", None, "", "empty", False),
        ("", None, "", "empty", True),
    ],
    ids=["受け取った", "found で受け取れない", "absent", "unreadable", "history-get が落ちた"],
)
def test_prepare_history_keeps_the_download_or_starts_empty(
    tmp_path: Path, state: str, downloaded: str | None, kept: str, received: str, warned: bool
) -> None:
    """`Prepare history` の step を、`history-get` の `state` と受け取った `history.jsonl` の有無を変えて実行した場合のテストです。受け取った履歴はそのまま残り、無いときは空の履歴になり、出力 `history` に受け取れたかが出ることを確認します。サマリーの警告は、`found` なのに受け取れなかったときと、`history-get` が落ちて `state` が無いときだけ書かれます（FR-021）。"""
    with allure.step("受け取った履歴を置き、履歴を用意する step の run を動かす"):
        step = _step("report", "Prepare history")
        temp, summary = tmp_path / "runner-temp", tmp_path / "summary"
        output = tmp_path / "output"
        (temp / "test-report").mkdir(parents=True)
        if downloaded is not None:
            (temp / "test-report/history.jsonl").write_text(downloaded, encoding="utf-8")
        env = {
            **step["env"],
            "STATE": state,
            "RUNNER_TEMP": str(temp),
            "GITHUB_STEP_SUMMARY": str(summary),
            "GITHUB_OUTPUT": str(output),
        }
        result = _bash(step["run"], tmp_path, env)
    with allure.step("履歴の中身と出力と、無いときだけの警告を確かめる"):
        assert step["if"] == "${{ needs.side.outputs.side == 'release' }}"
        assert step["id"] == "prepare"
        assert _job("report")["outputs"] == {"history": "${{ steps.prepare.outputs.history }}"}
        assert result.returncode == 0, result.stderr
        assert read_output(temp / "test-report/history.jsonl") == kept
        assert read_output(output) == f"history={received}\n"
        text = read_output(summary) if summary.exists() else ""
        assert (step["env"]["MSG_NO_HISTORY"] in text) == warned


@allure.title("リリース版では、レポートを作った後の履歴を、1 日だけ別の artifact に上げる")
def test_report_uploads_history_only_for_release() -> None:
    """`Upload history` の step のテストです。リリース版のときだけ動き、`history.jsonl` を `test-report-history-out` として 1 日保存し、ファイルが無ければ失敗することを確認します。"""
    with allure.step("履歴を上げる step を読む"):
        step = _step("report", "Upload history")
    with allure.step("リリース版だけで、レポートとは別の artifact に上げることを確かめる"):
        assert step["if"] == "${{ needs.side.outputs.side == 'release' }}"
        assert step["uses"].startswith("actions/upload-artifact@")
        assert step["with"] == {
            "name": "test-report-history-out",
            "path": "${{ runner.temp }}/test-report/history.jsonl",
            "retention-days": 1,
            "overwrite": True,
            "if-no-files-found": "error",
        }


# generate.py の代わり: --output に index.html を書き、--history があれば 1 行足し、--sources を写す。
_FAKE_GENERATE = (
    'hist=""\n'
    "while [ $# -gt 0 ]; do case $1 in --output) out=$2;; --history) hist=$2;; --sources) src=$2;; esac; shift; done\n"
    'mkdir -p "$out" && echo "<html></html>" > "$out/index.html"\n'
    '[ -z "$hist" ] || echo \'{"new":1}\' >> "$hist"\n'
    'cp "$src" "$SEEN"'
)


@allure.title("側が {side} のとき、レポートの step は材料・履歴・サイトのファイルを順に引き継ぐ")
@pytest.mark.parametrize(
    ("side", "history"),
    [("release", '{"r":1}\n{"new":1}\n'), ("dev", None)],
    ids=["release", "dev"],
)
def test_report_steps_hand_sources_history_and_tree_to_each_other(
    tmp_path: Path, side: str, history: str | None
) -> None:
    """`Write report sources` から `Pack report` までを、側の条件に従って続けて実行した場合のテストです。材料が `report-sources.json` に保存され、`report.tar` には `index.html` だけが入ることを確認します。追記した履歴は、リリース版だけが `Upload history` の上げる場所に残ります。"""
    with allure.step("受け取った履歴と偽の python3 を用意する"):
        temp, bin_dir, seen = tmp_path / "runner-temp", tmp_path / "bin", tmp_path / "seen-sources"
        (temp / "test-report").mkdir(parents=True)
        _fake(bin_dir, "python3", _FAKE_GENERATE)
        sources = json.dumps({"side": side, "runs": [], "missing": []})
        env = {
            "RUNNER_TEMP": str(temp),
            "SIDE": side,
            "SOURCES": sources,
            "SEEN": str(seen),
            "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
            "GITHUB_OUTPUT": str(tmp_path / "output"),
        }
        names = ["Write report sources", "Generate report", "Pack report"]
        if side == "release":
            (temp / "test-report/history.jsonl").write_text('{"r":1}\n', encoding="utf-8")
            names.insert(1, "Prepare history")

    with allure.step("step を順に動かし、元・履歴・木が渡ることを確かめる"):
        for name in names:
            step = _step("report", name)
            result = _bash(step["run"], tmp_path, {**step.get("env", {}), **env}, bin_dir)
            assert result.returncode == 0, f"{name}: {result.stderr}"

        out = temp / "test-report-artifact"
        assert read_output(out / "report-sources.json") == sources
        assert read_output(seen) == sources
        names = run_attached(
            ["tar", "-tf", str(out / "report.tar")], capture_output=True, text=True, check=True
        ).stdout.split()
        assert sorted(names) == ["./", "./index.html"]
        uploaded = _step("report", "Upload history")["with"]["path"]
        assert uploaded == "${{ runner.temp }}/test-report/history.jsonl"
        if history is None:
            assert not (temp / "test-report/history.jsonl").exists()
        else:
            assert read_output(temp / "test-report/history.jsonl") == history


@allure.title("側が {side} のとき、レポートを梱包し、履歴は tar に含めない")
@pytest.mark.parametrize("side", ["release", "dev"])
def test_pack_report_leaves_history_out_of_the_tree(tmp_path: Path, side: str) -> None:
    """作業のディレクトリに `history.jsonl` がある状態で、`Pack report` の step を実行した場合のテストです。出力先に `report.tar` と `report-sources.json` が作られ、`report.tar` に `history.jsonl` が入らないことを確認します（FR-019）。"""
    with allure.step("report の木と履歴を置き、report を固める step の run を動かす"):
        temp = tmp_path / "runner-temp"
        work = temp / "test-report"
        (work / "site").mkdir(parents=True)
        (work / "site/index.html").write_text("<html></html>", encoding="utf-8")
        (work / "history.jsonl").write_text('{"a":1}\n', encoding="utf-8")
        (work / "report-sources.json").write_text(f'{{"side":"{side}"}}', encoding="utf-8")

        env = {"RUNNER_TEMP": str(temp), "SIDE": side}
        result = _bash(_step("report", "Pack report")["run"], tmp_path, env)

    with allure.step("履歴の入らない tar ができることを確かめる"):
        assert result.returncode == 0, result.stderr
        out = temp / "test-report-artifact"
        assert sorted(p.name for p in out.iterdir()) == ["report-sources.json", "report.tar"]
        names = run_attached(
            ["tar", "-tf", str(out / "report.tar")], capture_output=True, text=True, check=True
        ).stdout.split()
        assert sorted(names) == ["./", "./index.html"]


# ---------------------------------------------------------------- history-get


@allure.title("history-get の job は、リリース版のレポートを作るときだけ動く")
def test_history_get_runs_only_for_release_reports() -> None:
    """`history-get` の job のテストです。`side` の `report` が `true` で、側がリリース版のときだけ実行され、`state` と `etag` を出力することを確認します。"""
    with allure.step("history-get の job を読む"):
        job = _job("history-get")
    with allure.step("条件と出力を確かめる"):
        assert job["if"] == (
            "${{ needs.side.outputs.report == 'true' && needs.side.outputs.side == 'release' }}"
        )
        assert job["outputs"] == {
            "state": "${{ steps.get.outputs.state }}",
            "etag": "${{ steps.get.outputs.etag }}",
        }


@allure.title(
    "history-get の job は、行の確かめのスクリプトだけを取得し、資格情報が取れなくても続ける"
)
def test_history_get_steps() -> None:
    """`history-get` の job の step のテストです。checkout が `.githooks/scripts/test_report` だけを取得することを確認します。AWS の資格情報の step は失敗しても続き、その結果を `Get history` に渡します。履歴の artifact は、`found` のときだけ上げます。"""
    with allure.step("history-get の step を読む"):
        names = [s["name"] for s in _steps("history-get")]
        checkout = _step("history-get", "Checkout")
        aws = _step("history-get", "Configure AWS credentials")
        get = _step("history-get", "Get history")
        upload = _step("history-get", "Upload history")
    with allure.step("step の並びと設定を確かめる"):
        assert names == ["Checkout", "Configure AWS credentials", "Get history", "Upload history"]
        assert checkout["with"] == {
            "ref": "${{ github.sha }}",
            "sparse-checkout": ".githooks/scripts/test_report",
            "persist-credentials": False,
        }
        assert aws["uses"].startswith("aws-actions/configure-aws-credentials@")
        assert aws["id"] == "aws"
        assert aws["continue-on-error"] is True
        assert aws["with"] == {
            "role-to-assume": "${{ vars.TEST_REPORT_HISTORY_ROLE_ARN }}",
            "aws-region": "ap-southeast-2",
        }
        assert get["id"] == "get"
        assert get["env"]["CREDENTIALS"] == "${{ steps.aws.outcome }}"
        assert get["env"]["BUCKET"] == "${{ vars.TEST_REPORT_HISTORY_BUCKET }}"
        assert upload["if"] == "${{ steps.get.outputs.state == 'found' }}"
        assert upload["with"] == {
            "name": "test-report-history-in",
            "path": "${{ runner.temp }}/test-report-history/history.jsonl",
            "retention-days": 1,
            "overwrite": True,
            "if-no-files-found": "error",
        }


_NO_SUCH_KEY = "An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist."
_ACCESS_DENIED = (
    "An error occurred (AccessDenied) when calling the GetObject operation: Access Denied"
)


def _fake_aws(bin_dir: Path, calls: Path, *, body: Path | None = None, error: str = "") -> None:
    """aws の代わり。引数を calls に残し、error があれば stderr に出して 254 で終わる。

    error が無ければ、最後の引数のファイルに body を写し、ETag を出す。
    """
    if error:
        action = f"echo {shlex.quote(error)} >&2\nexit 254"
    elif body is not None:
        action = f'for out; do :; done\ncp {shlex.quote(str(body))} "$out"\necho \'"etag-1"\''
    else:
        action = ":"
    _fake(bin_dir, "aws", f'echo "$*" >> {shlex.quote(str(calls))}\n{action}')


def _get_history(
    tmp_path: Path, cwd: Path, *, credentials: str = "success", body: str | None, error: str = ""
) -> tuple[subprocess.CompletedProcess[str], Path, Path, Path, Path]:
    """偽の aws で `Get history` を動かし、結果と GITHUB_OUTPUT・要約・履歴・aws の呼び出しを返す。"""
    bin_dir, calls, stored = tmp_path / "bin", tmp_path / "aws-calls", tmp_path / "stored.jsonl"
    if body is not None:
        stored.write_text(body, encoding="utf-8")
    _fake_aws(bin_dir, calls, body=stored if body is not None else None, error=error)
    temp, output, summary = tmp_path / "runner-temp", tmp_path / "output", tmp_path / "summary"
    temp.mkdir()
    step = _step("history-get", "Get history")
    env = {
        **step["env"],
        "CREDENTIALS": credentials,
        "BUCKET": "b",
        "RUNNER_TEMP": str(temp),
        "GITHUB_OUTPUT": str(output),
        "GITHUB_STEP_SUMMARY": str(summary),
    }
    result = _bash(step["run"], cwd, env, bin_dir)
    return result, output, summary, temp / "test-report-history/history.jsonl", calls


@allure.title("S3 の履歴が {param_id} のとき、状態を出力し、読めないときだけ空の履歴にして警告する")
@pytest.mark.parametrize(
    ("credentials", "body", "error", "state", "kept", "message"),
    [
        ("success", '{"a":1}\n{"b":2}\n', "", "found", '{"a":1}\n{"b":2}\n', None),
        ("success", None, _NO_SUCH_KEY, "absent", "", None),
        ("failure", None, "", "unreadable", "", "MSG_NO_CREDENTIALS"),
        ("success", None, _ACCESS_DENIED, "unreadable", "", "MSG_GET_FAILED"),
        ("success", '{"a":1}\nNaN\n', "", "unreadable", "", "MSG_BAD_LINES"),
    ],
    ids=["ある", "無い", "資格情報の失敗", "S3 の失敗", "読めない行"],
)
def test_get_history_reports_the_state(
    tmp_path: Path,
    credentials: str,
    body: str | None,
    error: str,
    state: str,
    kept: str,
    message: str | None,
) -> None:
    """偽の `aws` で `Get history` の step を、S3 の応答を変えて実行した場合のテストです。`state` が `found`・`absent`・`unreadable` に分かれ、`etag` は `found` のときだけ出ることを確認します。`unreadable` のときは履歴が空になり、理由をサマリーに書きます（FR-021）。"""
    with allure.step("偽の aws を置き、履歴を取る step の run を動かす"):
        result, output, summary, history, calls = _get_history(
            tmp_path, _REPO_ROOT, credentials=credentials, body=body, error=error
        )
    with allure.step("出力・履歴・サマリー・aws の呼び出しを確かめる"):
        assert result.returncode == 0, result.stderr
        expected = {"state": state, **({"etag": '"etag-1"'} if state == "found" else {})}
        assert _outputs(output) == expected
        assert read_output(history) == kept
        env = _step("history-get", "Get history")["env"]
        if message is None:
            assert not summary.exists() or read_output(summary) == ""
        else:
            assert f"{env[message]}{env['MSG_EMPTY']}" in read_output(summary)
        if credentials == "failure":
            assert not calls.exists()
        else:
            assert read_output(calls) == (
                "s3api get-object --bucket b --key release/history.jsonl"
                f" --query ETag --output text {history}\n"
            )


@allure.title("行の確かめのスクリプトが動かないときは、Get history の step を失敗させる")
def test_get_history_fails_when_the_check_cannot_run(tmp_path: Path) -> None:
    """`generate.py` の無い作業ディレクトリで、S3 から履歴を取れた状態の `Get history` の step を実行した場合のテストです。読めない行とは別の失敗として、step が 0 以外の終了コードで終わることを確認します。"""
    with allure.step("generate.py の無いディレクトリで、履歴を取る step の run を動かす"):
        result, output, _, _, _ = _get_history(tmp_path, tmp_path, body='{"a":1}\n')
    with allure.step("step が失敗し、state を出さないことを確かめる"):
        assert result.returncode != 0
        assert not output.exists()


# ---------------------------------------------------------------- history-put


@allure.title(
    "history-put の job は、リリース版で、レポートができ、履歴が無いか受け取れたときだけ動く"
)
def test_history_put_runs_only_after_a_readable_history() -> None:
    """`history-put` の job の条件のテストです。取り消されておらず、リリース版で、`report` と `history-get` が成功したときに実行されることを確認します。さらに、S3 に履歴が無かったか、`report` が履歴を受け取れたことを求めます。`found` なのに受け取れなかった回と `unreadable` の回は、書き戻しません。"""
    with allure.step("history-put の job の条件を確かめる"):
        assert _job("history-put")["if"] == (
            "${{ !cancelled() && needs.side.outputs.side == 'release'"
            " && needs.report.result == 'success'"
            " && needs.history-get.result == 'success'"
            " && (needs.history-get.outputs.state == 'absent'"
            " || needs.report.outputs.history == 'received') }}"
        )


@allure.title("history-put の job は、checkout をせず、レポートの後の履歴を受け取って S3 に入る")
def test_history_put_steps() -> None:
    """`history-put` の job の step のテストです。checkout をせずに `test-report-history-out` を受け取り、資格情報の失敗で止まることを確認します。`Put history` には、history-get の状態と ETag を渡します。"""
    with allure.step("history-put の step を読む"):
        names = [s["name"] for s in _steps("history-put")]
        download = _step("history-put", "Download history")
        aws = _step("history-put", "Configure AWS credentials")
        put = _step("history-put", "Put history")
    with allure.step("step の並びと設定を確かめる"):
        assert names == ["Download history", "Configure AWS credentials", "Put history"]
        assert download["with"] == {
            "name": "test-report-history-out",
            "path": "${{ runner.temp }}/test-report-history",
        }
        assert "continue-on-error" not in aws
        assert aws["with"] == _step("history-get", "Configure AWS credentials")["with"]
        assert put["env"]["BUCKET"] == "${{ vars.TEST_REPORT_HISTORY_BUCKET }}"
        assert put["env"]["STATE"] == "${{ needs.history-get.outputs.state }}"
        assert put["env"]["ETAG"] == "${{ needs.history-get.outputs.etag }}"


def _put_history(
    tmp_path: Path, state: str, error: str = ""
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    """偽の aws で `Put history` を動かし、結果と要約と aws の呼び出しを返す。"""
    bin_dir, calls, summary = tmp_path / "bin", tmp_path / "aws-calls", tmp_path / "summary"
    _fake_aws(bin_dir, calls, error=error)
    step = _step("history-put", "Put history")
    env = {
        **step["env"],
        "BUCKET": "b",
        "STATE": state,
        "ETAG": '"etag-1"',
        "RUNNER_TEMP": str(tmp_path),
        "GITHUB_STEP_SUMMARY": str(summary),
    }
    return _bash(step["run"], tmp_path, env, bin_dir), summary, calls


@allure.title("history-get の状態が {state} のとき、条件付きの書き込みで S3 に履歴を戻す")
@pytest.mark.parametrize(
    ("state", "condition"),
    [("found", '--if-match "etag-1"'), ("absent", "--if-none-match *")],
)
def test_put_history_writes_with_a_condition(tmp_path: Path, state: str, condition: str) -> None:
    """偽の `aws` で `Put history` の step を実行した場合のテストです。`found` では読んだときの ETag を `--if-match` に渡し、`absent` では `--if-none-match '*'` を渡して `put-object` を呼ぶことを確認します。"""
    with allure.step("偽の aws で、履歴を戻す step の run を動かす"):
        result, summary, calls = _put_history(tmp_path, state)
    with allure.step("条件を付けて put-object を呼ぶことを確かめる"):
        assert result.returncode == 0, result.stderr
        assert read_output(calls) == (
            "s3api put-object --bucket b --key release/history.jsonl"
            f" --body {tmp_path}/test-report-history/history.jsonl {condition}\n"
        )
        assert not summary.exists()


@allure.title(
    "S3 が {param_id} で書き込みを断ると、step を失敗させ、条件の不一致だけをサマリーに書く"
)
@pytest.mark.parametrize(
    ("error", "noted"),
    [
        (
            "An error occurred (PreconditionFailed) when calling the PutObject operation:"
            " At least one of the pre-conditions you specified did not hold",
            True,
        ),
        (
            "An error occurred (AccessDenied) when calling the PutObject operation: Access Denied",
            False,
        ),
    ],
    ids=["条件の不一致", "ほかの失敗"],
)
def test_put_history_fails_when_s3_refuses(tmp_path: Path, error: str, noted: bool) -> None:
    """偽の `aws` が `put-object` を断る場合の `Put history` の step のテストです。どちらも step が失敗し、412 の `PreconditionFailed` のときだけ、この run が読んだ後に履歴が変わった旨をサマリーに書くことを確認します。"""
    with allure.step("断る偽の aws で、履歴を戻す step の run を動かす"):
        result, summary, _ = _put_history(tmp_path, "found", error)
    with allure.step("step の失敗と、サマリーの中身を確かめる"):
        assert result.returncode != 0
        assert error in result.stderr
        message = _step("history-put", "Put history")["env"]["MSG_CHANGED"]
        text = read_output(summary) if summary.exists() else ""
        assert (message in text) == noted


@allure.title("history-get の状態が found と absent のどちらでもないと、書き込まずに失敗する")
def test_put_history_refuses_an_unknown_state(tmp_path: Path) -> None:
    """`STATE` が `unreadable` のまま `Put history` の step を実行した場合のテストです。`aws` を呼ばずに、0 以外の終了コードで終わることを確認します。"""
    with allure.step("unreadable の状態で、履歴を戻す step の run を動かす"):
        result, _, calls = _put_history(tmp_path, "unreadable")
    with allure.step("aws を呼ばずに失敗することを確かめる"):
        assert result.returncode != 0
        assert not calls.exists()


# ---------------------------------------------------------------- 共通


@allure.title("checkout は github の参照を使い、history-get のほかは全履歴を取得する")
def test_checkouts_use_github_ref_with_full_history() -> None:
    """`test-report.yml` の `actions/checkout` のテストです。どの checkout も `ref` が `github.sha` で、認証情報を残さないことを確認します。`side`・`tests`・`report` は全履歴を `blob:none` で取り、`history-get` は 1 つのディレクトリだけを取ります。"""
    with allure.step("checkout の step を job ごとに集める"):
        # step の出力の SHA を checkout すると、CodeQL の actions/cache-poisoning が止める。
        checkouts = {
            job: s["with"]
            for job, s in _all_steps()
            if s.get("uses", "").startswith("actions/checkout@")
        }
    with allure.step("github の ref と、job ごとの取得の範囲を確かめる"):
        full = {
            "ref": "${{ github.sha }}",
            "fetch-depth": 0,
            "filter": "blob:none",
            "persist-credentials": False,
        }
        assert checkouts == {
            "side": full,
            "tests": full,
            "history-get": {
                "ref": "${{ github.sha }}",
                "sparse-checkout": ".githooks/scripts/test_report",
                "persist-credentials": False,
            },
            "report": full,
        }


@allure.title("すべての action は、40 桁の SHA で固定する")
def test_every_action_is_pinned_to_a_full_sha() -> None:
    """`test-report.yml` のすべての `uses` のテストです。参照が `owner/repo@<40 桁の 16 進数>` の形であることを確認します。"""
    with allure.step("すべての action が 40 桁の sha で固定されていることを確かめる"):
        for job, step in _all_steps():
            if "uses" in step:
                assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", step["uses"]), (job, step["uses"])


@allure.title("シェルのスクリプトに、式と日本語を書かない")
def test_shell_has_no_expressions_or_japanese() -> None:
    """`test-report.yml` の `run` のテストです。すべての step で `${{` が含まれず、ASCII 以外の文字も含まれないことを確認します。"""
    with allure.step("すべての run に式と日本語が無いことを確かめる"):
        for job, step in _all_steps():
            run = step.get("run", "")
            assert "${{" not in run, (job, step["name"])
            assert not re.search(r"[^\x00-\x7f]", run), (job, step["name"])


# ---------------------------------------------------------------- release.yml


@allure.title("リリースの workflow は、サイトのビルドの直後に、同じ条件でレポートの run を起動する")
def test_release_triggers_test_report_like_pages_build() -> None:
    """`release.yml` の `Trigger test report release run` の step のテストです。サイトのビルドを起動する step の直後にあり、条件と環境変数が同じで、`land.log` を確認して `test-report.yml` を `side=release` で起動することを確認します。"""
    with allure.step("release.yml の step を読む"):
        names = [s.get("name") for s in _steps("release", _RELEASE)]
        pages = _step("release", "Trigger pages release build", _RELEASE)
        step = _step("release", "Trigger test report release run", _RELEASE)
    with allure.step("Pages のビルドの直後に、同じ条件で report を起こすことを確かめる"):
        assert names.index("Trigger pages release build") + 1 == names.index(
            "Trigger test report release run"
        )
        assert step["if"] == pages["if"]
        assert step["env"] == pages["env"]
        assert "grep -q '^landed:' .pecot/tmp/release/land.log" in step["run"]
        assert (
            'gh workflow run test-report.yml --repo "$REPO" --ref main -f side=release'
            in step["run"]
        )


@allure.title("land.log が {param_id} のとき、レポートの run を起動するかを決める")
@pytest.mark.parametrize(
    ("land_log", "called"),
    [
        ("landed: abc1234 (fast-forward)\n", True),
        ("skipped: no release commit\n", False),
        (None, False),
    ],
    ids=["landed", "skipped", "no-log"],
)
def test_release_test_report_trigger_reads_land_log(
    tmp_path: Path, land_log: str | None, called: bool
) -> None:
    """偽の `gh` を使って `Trigger test report release run` の step を実行した場合のテストです。`land.log` が `landed:` で始まる場合だけ `gh workflow run` が呼ばれることを確認します。"""
    with allure.step("land.log と偽の gh を置き、report を起こす step の run を動かす"):
        if land_log is not None:
            (tmp_path / ".pecot/tmp/release").mkdir(parents=True)
            (tmp_path / ".pecot/tmp/release/land.log").write_text(land_log, encoding="utf-8")
        bin_dir, calls = tmp_path / "bin", tmp_path / "gh-calls"
        _fake(bin_dir, "gh", f'echo "$*" >> {calls}')
        step = _step("release", "Trigger test report release run", _RELEASE)

        result = _bash(step["run"], tmp_path, {"REPO": "o/r"}, bin_dir)

    with allure.step("land.log の内容に応じて gh を呼ぶか確かめる"):
        assert result.returncode == 0, result.stderr
        if called:
            assert read_output(calls) == (
                "workflow run test-report.yml --repo o/r --ref main -f side=release\n"
            )
        else:
            assert not calls.exists()
