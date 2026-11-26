"""test-report.yml の形と、release.yml がそれを起こす step の確かめ。

契機・権限・concurrency・artifact の決まりは specs/030-allure-test-report/contracts/test-report.md にある。
workflow_dispatch は main に定義が入るまで動かせないため、形と run: のシェルをここで固定する。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

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


def test_triggers_are_push_to_main_and_dispatch_only() -> None:
    on = _load(_REPORT)[True]
    assert set(on) == {"push", "workflow_dispatch"}
    assert on["push"] == {"branches": ["main"]}
    inputs = on["workflow_dispatch"]["inputs"]
    assert set(inputs) == {"side"}
    assert inputs["side"]["type"] == "choice"
    assert inputs["side"]["options"] == ["release", "dev"]


def test_dispatch_outside_main_fails_before_anything_else() -> None:
    first = _steps("side")[0]
    assert first["if"] == (
        "${{ github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main' }}"
    )
    assert "exit 1" in first["run"]


def test_permissions_are_contents_read_only() -> None:
    assert _load(_REPORT)["permissions"] == {"contents": "read"}
    for name, job in _load(_REPORT)["jobs"].items():
        assert "permissions" not in job, name


def test_concurrency_waits_per_side_without_cancelling() -> None:
    assert _load(_REPORT)["concurrency"] == {
        "group": "test-report-${{ inputs.side || 'dev' }}",
        "cancel-in-progress": False,
    }


def test_env_matches_ci_and_holds_side_urls_once() -> None:
    env, ci_env = _load(_REPORT)["env"], _load(_CI)["env"]
    for key in ("PECOT_NX_CI", "PECOTV_E2E_CEILING_SCALE"):
        assert env[key] == ci_env[key], key
    assert env["DEV_SITE_URL"] == _DEV_URL
    assert env["RELEASE_SITE_URL"] == _RELEASE_URL
    assert _REPORT.read_text(encoding="utf-8").count("pecotcraft.github.io") == 2


# ---------------------------------------------------------------- side


def test_jobs_are_side_tests_report() -> None:
    jobs = _load(_REPORT)["jobs"]
    assert list(jobs) == ["side", "tests", "report"]
    assert jobs["tests"]["needs"] == "side"
    assert jobs["report"]["needs"] == ["side", "tests"]


def test_side_resolves_report_sources() -> None:
    step = _step("side", "Resolve report sources")
    assert "release_sources.py --report" in step["run"]
    assert step["env"]["SIDE"] == "${{ steps.decide.outputs.side }}"
    assert step["env"]["SHA"] == "${{ github.sha }}"
    outputs = _job("side")["outputs"]
    assert outputs == {
        "side": "${{ steps.decide.outputs.side }}",
        "site_url": "${{ steps.decide.outputs.site_url }}",
        "report": "${{ steps.sources.outputs.report }}",
        "matrix": "${{ steps.sources.outputs.matrix }}",
        "sources": "${{ steps.sources.outputs.sources }}",
    }


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
        "GITHUB_OUTPUT": str(output),
        "GITHUB_STEP_SUMMARY": str(summary),
    }
    result = _bash(step["run"], tmp_path, env, bin_dir)
    assert result.returncode == 0, result.stderr
    return calls, output, summary


def test_side_passes_dev_commit_and_writes_matrix(tmp_path: Path) -> None:
    sources = {"side": "dev", "runs": [{"commit": _SHA, "lanes": ["p:test-cli"]}], "missing": []}
    jobs = [{"lane": "p:test-cli", "slug": "p-test-cli", "results": "r", "commit": _SHA}]
    calls, output, summary = _resolve_sources(tmp_path, "dev", {"sources": sources, "matrix": jobs})
    assert read_output(calls) == (
        f".githooks/scripts/pages_site/release_sources.py --report dev --commit {_SHA}\n"
    )
    out = _outputs(output)
    assert out["report"] == "true"
    assert json.loads(out["matrix"]) == jobs
    assert json.loads(out["sources"]) == sources
    assert not summary.exists() or read_output(summary) == ""


def test_side_skips_report_and_lists_missing_for_release(tmp_path: Path) -> None:
    sources = {"side": "release", "runs": [], "missing": ["pecot-tools", "pecot-visual"]}
    calls, output, summary = _resolve_sources(
        tmp_path, "release", {"sources": sources, "matrix": []}
    )
    assert read_output(calls) == (
        ".githooks/scripts/pages_site/release_sources.py --report release --main origin/main\n"
    )
    out = _outputs(output)
    assert out["report"] == "false"
    assert out["matrix"] == "[]"
    text = read_output(summary)
    env = _step("side", "Resolve report sources")["env"]
    assert env["MSG_MISSING"] in text
    assert env["MSG_NO_REPORT"] in text
    assert "- pecot-tools\n- pecot-visual\n" in text


# ---------------------------------------------------------------- tests


def test_tests_run_only_with_lanes_and_keep_going() -> None:
    job = _job("tests")
    assert job["if"] == "${{ needs.side.outputs.report == 'true' }}"
    assert job["name"] == "tests (${{ matrix.lane }})"
    assert job["timeout-minutes"] == _job("tests", _CI)["timeout-minutes"]
    assert job["strategy"] == {
        "fail-fast": False,
        "matrix": {"include": "${{ fromJSON(needs.side.outputs.matrix) }}"},
    }


def test_tests_switch_to_report_commit_before_the_dev_container() -> None:
    names = [s["name"] for s in _steps("tests")]
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


def test_tests_run_one_lane_without_failing_the_job() -> None:
    step = _step("tests", "Run tests")
    assert step["continue-on-error"] is True
    assert 'pnpm exec nx run "$CHECKS_LANE" --skip-nx-cache' in step["run"]
    assert step["run"].lstrip().startswith("# shellcheck disable=SC2016\n")
    assert _job("tests")["env"]["CHECKS_LANE"] == "${{ matrix.lane }}"
    for name in ("Restore workspace owner", "Stage results", "Upload results"):
        assert _step("tests", name)["if"] == "always()", name
    assert _step("tests", "Restore workspace owner")["run"] == (
        ".githooks/ci/dev-container.sh restore-owner"
    )


def test_tests_pass_site_url_and_browser_into_container() -> None:
    env = _job("tests")["env"]
    assert env["PECOT_REPORT_SITE_URL"] == "${{ needs.side.outputs.site_url }}"
    assert env["PECOT_CI_BROWSER"] == _job("tests", _CI)["env"]["PECOT_CI_BROWSER"]
    assert env["DEVCONTAINER_ENV"].split() == [
        "CHECKS_LANE",
        "PECOT_REPORT_SITE_URL",
        "PECOT_CI_BROWSER",
    ]


def test_tests_upload_results_with_hidden_files() -> None:
    (upload,) = _uses("tests", "actions/upload-artifact")
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


@pytest.mark.parametrize("with_results", [True, False], ids=["results", "no-results"])
def test_stage_results_copies_results_and_writes_source(tmp_path: Path, with_results: bool) -> None:
    repo, head = _stage_repo(tmp_path)
    results = ".githooks/test-results/test-ci/allure-results"
    if with_results:
        (repo / results).mkdir(parents=True)
        (repo / results / "1-result.json").write_text("{}", encoding="utf-8")
    temp = tmp_path / "runner-temp"
    temp.mkdir()
    env = {"RUNNER_TEMP": str(temp), "RESULTS": results, "CHECKS_LANE": "githooks:test-ci"}

    result = _bash(_step("tests", "Stage results")["run"], repo, env)

    assert result.returncode == 0, result.stderr
    stage = temp / "test-report-results"
    source = json.loads(read_output(stage / ".githooks/test-results/test-ci/source.json"))
    assert source == {"lane": "githooks:test-ci", "commit": head}
    assert (stage / results / "1-result.json").is_file() == with_results


# ---------------------------------------------------------------- report


def test_report_runs_unless_cancelled() -> None:
    assert _job("report")["if"] == "${{ !cancelled() && needs.side.outputs.report == 'true' }}"


def test_report_installs_node_on_the_runner_like_version_plan() -> None:
    names = [s["name"] for s in _steps("report")]
    expected = ["Checkout", "Set up Node.js", "Enable Corepack", "Install dependencies"]
    assert names[:4] == expected
    for name in expected[1:]:
        mine, theirs = _step("report", name), _step("version-plan", name, _CI)
        assert {k: v for k, v in mine.items() if k != "name"} == {
            k: v for k, v in theirs.items() if k != "name"
        }, name
    assert names[4:] == [
        "Download results",
        "Read stored history",
        "Generate report",
        "Pack report",
        "Upload report",
    ]


def test_report_downloads_all_results_into_the_repo_root() -> None:
    (download,) = _uses("report", "actions/download-artifact")
    assert download["with"] == {
        "pattern": "allure-results-*",
        "merge-multiple": True,
        "path": "${{ github.workspace }}",
    }


def test_report_generates_with_sources_and_history() -> None:
    step = _step("report", "Generate report")
    run = step["run"]
    assert "generate.py" in run
    for flag in ("--sources", "--output", "--history"):
        assert flag in run, flag
    assert _job("report")["env"]["SOURCES"] == "${{ needs.side.outputs.sources }}"


def test_report_uploads_report_for_seven_days() -> None:
    (upload,) = _uses("report", "actions/upload-artifact")
    assert upload["name"] == "Upload report"
    assert upload["with"] == {
        "name": "test-report-${{ needs.side.outputs.side }}",
        "path": "${{ runner.temp }}/test-report-artifact/",
        "retention-days": 7,
        "overwrite": True,
        "if-no-files-found": "error",
    }


def _store_repo(tmp_path: Path, files: dict[str, str] | None) -> Path:
    """files を持つコミットを origin/pages-store に置いたリポ。None なら pages-store を置かない。"""
    repo, _ = _stage_repo(tmp_path)
    if files is None:
        return repo
    git = ["git", "-C", str(repo)]
    branch = run_attached(
        [*git, "symbolic-ref", "--short", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()
    subprocess.run([*git, "checkout", "-q", "--orphan", "store"], check=True)
    subprocess.run([*git, "rm", "-rqf", "."], check=True)
    for name, text in files.items():
        (repo / name).parent.mkdir(parents=True, exist_ok=True)
        (repo / name).write_text(text, encoding="utf-8")
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run(
        [*git, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]
        + ["commit", "-q", "--allow-empty", "-m", "store"],
        check=True,
    )
    subprocess.run([*git, "update-ref", "refs/remotes/origin/pages-store", "HEAD"], check=True)
    subprocess.run([*git, "checkout", "-q", "-f", branch], check=True)
    return repo


_STORED = {"test-report/history.jsonl": '{"r":1}\n', "dev/test-report/history.jsonl": '{"d":1}\n'}


@pytest.mark.parametrize(
    ("side", "files", "kept", "warned"),
    [
        ("dev", _STORED, '{"d":1}\n', False),
        ("release", _STORED, '{"r":1}\n', False),
        ("dev", {"index.html": "x"}, "", False),
        ("dev", None, "", True),
    ],
    ids=["dev", "release", "first-time", "no-store"],
)
def test_read_history_from_pages_store_of_the_side(
    tmp_path: Path, side: str, files: dict[str, str] | None, kept: str, warned: bool
) -> None:
    repo = _store_repo(tmp_path, files)
    summary, temp = tmp_path / "summary", tmp_path / "runner-temp"
    temp.mkdir()
    step = _step("report", "Read stored history")
    env = {
        **step["env"],
        "RUNNER_TEMP": str(temp),
        "SIDE": side,
        "GITHUB_STEP_SUMMARY": str(summary),
    }

    result = _bash(step["run"], repo, env)

    assert result.returncode == 0, result.stderr
    assert read_output(temp / "test-report/history.jsonl") == kept
    text = read_output(summary) if summary.exists() else ""
    assert (step["env"]["MSG_NO_STORE"] in text) == warned


def test_read_history_looks_up_the_path_without_reading_the_blob() -> None:
    # checkout は blob:none なので、cat-file -e は blob を取りに行き、取れないと「無い」と読む。
    run = _step("report", "Read stored history")["run"]
    assert "cat-file" not in run
    assert 'elif git rev-parse --verify --quiet "$stored" > /dev/null; then' in run


def test_read_history_warns_and_starts_empty_when_the_blob_cannot_be_fetched(
    tmp_path: Path,
) -> None:
    # FR-021: 履歴を取れないときも、空の履歴でレポートを作り、job summary で知らせる。
    src = _store_repo(tmp_path, _STORED)
    bare, clone = tmp_path / "bare.git", tmp_path / "clone"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    subprocess.run(["git", "-C", str(bare), "config", "uploadpack.allowFilter", "true"], check=True)
    store = "refs/remotes/origin/pages-store:refs/heads/pages-store"
    subprocess.run(["git", "-C", str(src), "push", "-q", str(bare), store], check=True)
    subprocess.run(
        ["git", "clone", "-q", "--no-checkout", "--filter=blob:none", f"file://{bare}", str(clone)],
        check=True,
    )
    shutil.rmtree(bare)
    temp = tmp_path / "runner-temp"
    temp.mkdir()
    step = _step("report", "Read stored history")
    env = {
        **step["env"],
        "RUNNER_TEMP": str(temp),
        "SIDE": "dev",
        "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
    }

    result = _bash(step["run"], clone, env)

    assert result.returncode == 0, result.stderr
    assert "promisor remote" in result.stderr
    assert read_output(temp / "test-report/history.jsonl") == ""
    assert step["env"]["MSG_NO_STORE"] in read_output(tmp_path / "summary")


def test_report_steps_hand_history_sources_and_tree_to_each_other(tmp_path: Path) -> None:
    repo = _store_repo(tmp_path, _STORED)
    temp, bin_dir, seen = tmp_path / "runner-temp", tmp_path / "bin", tmp_path / "seen-sources"
    temp.mkdir()
    # generate.py の代わり: --output に index.html を書き、--history に 1 行足し、--sources を写す。
    _fake(
        bin_dir,
        "python3",
        "while [ $# -gt 0 ]; do case $1 in --output) out=$2;; --history) hist=$2;; --sources) src=$2;; esac; shift; done\n"
        'mkdir -p "$out" && echo "<html></html>" > "$out/index.html"\n'
        'echo \'{"new":1}\' >> "$hist"\n'
        f'cp "$src" {seen}',
    )
    sources = '{"side":"dev","runs":[],"missing":[]}'
    env = {
        "RUNNER_TEMP": str(temp),
        "SIDE": "dev",
        "SOURCES": sources,
        "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
    }

    for name in ("Read stored history", "Generate report", "Pack report"):
        step = _step("report", name)
        result = _bash(step["run"], repo, {**step.get("env", {}), **env}, bin_dir)
        assert result.returncode == 0, f"{name}: {result.stderr}"

    out = temp / "test-report-artifact"
    assert read_output(out / "report-sources.json") == sources
    assert read_output(seen) == sources
    extract = tmp_path / "extract"
    extract.mkdir()
    subprocess.run(["tar", "-xf", str(out / "report.tar"), "-C", str(extract)], check=True)
    assert (extract / "index.html").is_file()
    assert read_output(extract / "history.jsonl") == '{"d":1}\n{"new":1}\n'


def test_pack_report_puts_history_into_the_tree(tmp_path: Path) -> None:
    temp = tmp_path / "runner-temp"
    work = temp / "test-report"
    (work / "site").mkdir(parents=True)
    (work / "site/index.html").write_text("<html></html>", encoding="utf-8")
    (work / "history.jsonl").write_text('{"a":1}\n', encoding="utf-8")
    (work / "report-sources.json").write_text('{"side":"dev"}', encoding="utf-8")

    result = _bash(_step("report", "Pack report")["run"], tmp_path, {"RUNNER_TEMP": str(temp)})

    assert result.returncode == 0, result.stderr
    out = temp / "test-report-artifact"
    assert sorted(p.name for p in out.iterdir()) == ["report-sources.json", "report.tar"]
    listed = run_attached(
        ["tar", "-tf", str(out / "report.tar")], capture_output=True, text=True, check=True
    ).stdout.split()
    assert sorted(listed) == ["./", "./history.jsonl", "./index.html"]


# ---------------------------------------------------------------- 共通


def test_checkouts_use_github_ref_with_full_history() -> None:
    # step の出力の SHA を checkout すると、CodeQL の actions/cache-poisoning が止める。
    checkouts = [s for _, s in _all_steps() if s.get("uses", "").startswith("actions/checkout@")]
    assert len(checkouts) == 3
    for step in checkouts:
        assert step["with"] == {
            "ref": "${{ github.sha }}",
            "fetch-depth": 0,
            "filter": "blob:none",
            "persist-credentials": False,
        }


def test_every_action_is_pinned_to_a_full_sha() -> None:
    for job, step in _all_steps():
        if "uses" in step:
            assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", step["uses"]), (job, step["uses"])


def test_shell_has_no_expressions_or_japanese() -> None:
    for job, step in _all_steps():
        run = step.get("run", "")
        assert "${{" not in run, (job, step["name"])
        assert not re.search(r"[^\x00-\x7f]", run), (job, step["name"])


# ---------------------------------------------------------------- release.yml


def test_release_triggers_test_report_like_pages_build() -> None:
    names = [s.get("name") for s in _steps("release", _RELEASE)]
    pages = _step("release", "Trigger pages release build", _RELEASE)
    step = _step("release", "Trigger test report release run", _RELEASE)
    assert names.index("Trigger pages release build") + 1 == names.index(
        "Trigger test report release run"
    )
    assert step["if"] == pages["if"]
    assert step["env"] == pages["env"]
    assert "grep -q '^landed:' .pecot/tmp/release/land.log" in step["run"]
    assert (
        'gh workflow run test-report.yml --repo "$REPO" --ref main -f side=release' in step["run"]
    )


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
    if land_log is not None:
        (tmp_path / ".pecot/tmp/release").mkdir(parents=True)
        (tmp_path / ".pecot/tmp/release/land.log").write_text(land_log, encoding="utf-8")
    bin_dir, calls = tmp_path / "bin", tmp_path / "gh-calls"
    _fake(bin_dir, "gh", f'echo "$*" >> {calls}')
    step = _step("release", "Trigger test report release run", _RELEASE)

    result = _bash(step["run"], tmp_path, {"REPO": "o/r"}, bin_dir)

    assert result.returncode == 0, result.stderr
    if called:
        assert read_output(calls) == (
            "workflow run test-report.yml --repo o/r --ref main -f side=release\n"
        )
    else:
        assert not calls.exists()
