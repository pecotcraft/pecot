"""run-pr-checks.sh のユニットテスト。

スクリプトは CI で、pre-commit の 3 つの stage を範囲指定で順に呼ぶ。
どれかが落ちても最後まで動かし、1 つでも落ちていれば非 0 で終える。
実際の pre-commit は動かさず、PATH の先頭に置く偽の `pre-commit` で置き換える。
偽物は呼ばれた stage・引数・関心のある env を 1 呼び出し 1 行で記録する。
`STUB_FAIL_STAGE=<stage>` の stage は非 0 で終える。
manual の stage では、`STUB_TSV_APPEND` のファイルを所要の記録（tsv）へ足し、
`STUB_NX_LOG_SRC` のファイルを nx のログの場所へ置く。nx が書いた結果の代わり。

スクリプトは cwd の git repo を repo root として動く。
そのためテストは temp repo を cwd にして、実リポのスクリプトを bash で呼ぶ。

FR-029 のテストは、偽の nx で run-affected-tests.sh を動かす。
解決できない base のとき、run-many が呼ばれることを確かめる。
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

_STAGES = ["pre-commit", "pre-push", "manual"]

# 偽の pre-commit。1 呼び出し 1 行で記録する。未設定の env は "unset" と書く。
_PRE_COMMIT_STUB = r"""#!/bin/bash
stage=""
prev=""
for a in "$@"; do
    if [ "$prev" = "--hook-stage" ]; then stage="$a"; fi
    prev="$a"
done
printf 'stage=%s|args=%s|SKIP=%s|PVB=%s|TO=%s|NXC=%s|NXCI=%s|LANE=%s\n' \
    "$stage" "$*" "${SKIP-unset}" "${PECOT_VERSION_PLAN_BASE-unset}" \
    "${PRE_COMMIT_TO_REF-unset}" "${NX_SKIP_NX_CACHE-unset}" "${PECOT_NX_CI-unset}" \
    "${PECOT_NX_LANE-unset}" \
    >> "$STUB_PC_LOG"
root=$(git rev-parse --show-toplevel)
if [ "$stage" = "manual" ]; then
    if [ -n "${STUB_TSV_APPEND:-}" ]; then
        mkdir -p "$root/.pecot/tmp"
        cat "$STUB_TSV_APPEND" >> "$root/.pecot/tmp/githooks-timing.tsv"
    fi
    if [ -n "${STUB_NX_LOG_SRC:-}" ]; then
        mkdir -p "$root/.pecot/tmp/pre-push"
        cp "$STUB_NX_LOG_SRC" "$root/.pecot/tmp/pre-push/nx-affected-tests.log"
    fi
fi
if [ "${STUB_FAIL_STAGE:-}" = "$stage" ]; then
    exit 1
fi
exit 0
"""


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """スクリプトの入出力を左右する env を除去して既定をクリーンにする。"""
    for key in (
        "SKIP",
        "NO_PREV",
        "PECOT_CI_SUMMARY",
        "PECOT_CI_IMAGE",
        "PECOT_PRE_COMMIT",
        "NX_SKIP_NX_CACHE",
        "PECOT_NX_CI",
        "PECOT_NX_LANE",
    ):
        monkeypatch.delenv(key, raising=False)


class _PrChecksRepo:
    """run-pr-checks.sh テスト用の temp repo ヘルパ。"""

    def __init__(self, repo: Path, pc_log: Path, base: str, head: str, script: Path) -> None:
        self.repo = repo
        self.pc_log = pc_log
        self.base = base
        self.head = head
        self.script = script
        self.tmp = pc_log.parent

    def calls(self) -> list[dict[str, str]]:
        """偽の pre-commit の呼び出しを、順に dict へ読み戻す。"""
        rows = []
        for line in self.pc_log.read_text().splitlines():
            rows.append(dict(item.split("=", 1) for item in line.split("|")))
        return rows

    def tsv(self) -> Path:
        return self.repo / ".pecot" / "tmp" / "githooks-timing.tsv"

    def done(self) -> Path:
        return self.repo / ".pecot" / "tmp" / "ci" / "done"

    def write(self, name: str, text: str) -> Path:
        path = self.tmp / name
        path.write_text(text)
        return path

    def run(self, run_script, *args: str, env: dict | None = None):
        merged = {"STUB_PC_LOG": str(self.pc_log)}
        merged.update(env or {})
        use_args = args if args else (self.base, self.head)
        return run_script(self.script, *use_args, cwd=self.repo, env=merged)


@pytest.fixture
def pr_repo(
    git_repo: Callable[..., Path],
    git,
    git_rev_parse,
    mock_bin,
    tmp_path: Path,
    script_dir: Path,
) -> _PrChecksRepo:
    """base と head の 2 commit を持つ temp repo と、偽の pre-commit を用意する。"""
    repo = git_repo("repo", initial_branch="main")
    (repo / "README.md").write_text("base\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-q", "-m", "chore: base")
    base = git_rev_parse(repo, "HEAD")
    (repo / "README.md").write_text("head\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-q", "-m", "chore: head")
    head = git_rev_parse(repo, "HEAD")
    mock_bin.install("pre-commit", _PRE_COMMIT_STUB)
    pc_log = tmp_path / "pc.log"
    pc_log.write_text("")
    script = script_dir.parent / "ci" / "run-pr-checks.sh"
    return _PrChecksRepo(repo, pc_log, base, head, script)


def test_stages_run_in_order_with_range(pr_repo: _PrChecksRepo, run_script) -> None:
    """3 stage を pre-commit → pre-push → manual の順に、base と head の範囲で呼ぶ。"""
    result = pr_repo.run(run_script)
    assert result.returncode == 0, result.stderr

    calls = pr_repo.calls()
    assert [c["stage"] for c in calls] == _STAGES
    for call in calls:
        assert f"--from-ref {pr_repo.base} --to-ref {pr_repo.head}" in call["args"]
        assert "--show-diff-on-failure" in call["args"]
        assert "--color=never" in call["args"]
        assert "--all-files" not in call["args"]
        assert call["NXC"] == "true"
        assert call["NXCI"] == "1"


def test_skip_and_plan_base_per_stage(pr_repo: _PrChecksRepo, run_script) -> None:
    """SKIP は全 stage に version plan の判定、pre-push だけにテストの 2 hook を足す。"""
    result = pr_repo.run(run_script)
    assert result.returncode == 0, result.stderr

    by_stage = {c["stage"]: c for c in pr_repo.calls()}
    assert by_stage["pre-commit"]["SKIP"] == "check-version-plan-required"
    assert (
        by_stage["pre-push"]["SKIP"]
        == "check-version-plan-required,nx-affected-tests,githooks-tests"
    )
    assert by_stage["manual"]["SKIP"] == "check-version-plan-required"
    assert by_stage["pre-commit"]["PVB"] == "unset"
    assert by_stage["pre-push"]["PVB"] == pr_repo.base
    assert by_stage["manual"]["PVB"] == pr_repo.base
    # PRE_COMMIT_TO_REF は pre-commit が --to-ref から立てる。通常は渡さない。
    assert {c["TO"] for c in by_stage.values()} == {"unset"}


@pytest.mark.parametrize(
    ("part", "stages", "skips"),
    [
        (
            "lint",
            ["pre-commit", "pre-push"],
            [
                "check-version-plan-required",
                "check-version-plan-required,nx-affected-tests,githooks-tests",
            ],
        ),
        ("githooks", ["manual"], ["check-version-plan-required,nx-affected-tests"]),
        ("tests", ["manual"], ["check-version-plan-required,githooks-tests"]),
    ],
)
def test_part_selects_stages_and_skip(
    pr_repo: _PrChecksRepo, run_script, part: str, stages: list[str], skips: list[str]
) -> None:
    """--part は流す stage と、manual の stage で飛ばす hook を決める。"""
    result = pr_repo.run(run_script, f"--part={part}", pr_repo.base, pr_repo.head)
    assert result.returncode == 0, result.stderr

    calls = pr_repo.calls()
    assert [c["stage"] for c in calls] == stages
    assert [c["SKIP"] for c in calls] == skips


def test_part_option_may_follow_positionals(pr_repo: _PrChecksRepo, run_script) -> None:
    """--part は位置引数の後ろに置いてもよい。"""
    result = pr_repo.run(run_script, pr_repo.base, pr_repo.head, "--part=lint")
    assert result.returncode == 0, result.stderr
    assert [c["stage"] for c in pr_repo.calls()] == ["pre-commit", "pre-push"]


def test_unknown_part_exit_2(pr_repo: _PrChecksRepo, run_script) -> None:
    """不明な --part は、使い方を stderr へ出して exit 2。pre-commit は呼ばない。"""
    result = pr_repo.run(run_script, "--part=bogus", pr_repo.base, pr_repo.head)
    assert result.returncode == 2
    assert "使い方" in result.stderr
    assert pr_repo.pc_log.read_text() == ""


@pytest.mark.parametrize("part", ["lint", "githooks"])
def test_summary_without_lane_sections_for_non_test_part(
    pr_repo: _PrChecksRepo, run_script, part: str
) -> None:
    """lint と githooks の Summary は、見出しに part を書き、レーン・失敗・skip の欄を出さない。"""
    result = pr_repo.run(run_script, f"--part={part}", pr_repo.base, pr_repo.head)
    out = result.stdout
    assert f"## 検証の結果（{part}）\n" in out
    assert "### 範囲" in out
    assert "### 環境" in out
    for heading in ("### レーン", "### 失敗", "### skip"):
        assert heading not in out


def test_summary_with_lane_sections_for_tests_part(pr_repo: _PrChecksRepo, run_script) -> None:
    """tests の Summary は見出しに part を書き、レーン・失敗・skip の欄を出す。"""
    result = pr_repo.run(run_script, "--part=tests", pr_repo.base, pr_repo.head)
    out = result.stdout
    assert "## 検証の結果（tests）\n" in out
    for heading in ("### レーン", "### 失敗", "### skip"):
        assert heading in out


def test_summary_without_part_has_plain_heading_and_lane_sections(
    pr_repo: _PrChecksRepo, run_script
) -> None:
    """--part を省くと、見出しは part なしで、全ての欄を出す。"""
    out = pr_repo.run(run_script).stdout
    assert "## 検証の結果\n" in out
    for heading in ("### レーン", "### 失敗", "### skip"):
        assert heading in out


def test_failure_guide_names_part_artifact(pr_repo: _PrChecksRepo, run_script) -> None:
    """--part=tests の失敗の案内は、artifact 名を ci-logs-tests にする。"""
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"STUB_NX_LOG_SRC": str(pr_repo.write("nx-failed.log", _NX_LOG_FAILED))},
    )
    assert "artifact `ci-logs-tests`" in result.stdout
    assert "artifact `ci-logs`" not in result.stdout


def test_lane_is_passed_to_pre_commit_env(pr_repo: _PrChecksRepo, run_script) -> None:
    """--lane は PECOT_NX_LANE として pre-commit へ渡る。--lane が無ければ渡らない。"""
    lane = "pecot-visual:test-cli"
    result = pr_repo.run(run_script, "--part=tests", f"--lane={lane}", pr_repo.base, pr_repo.head)
    assert result.returncode == 0, result.stderr
    assert [c["LANE"] for c in pr_repo.calls()] == [lane]

    pr_repo.pc_log.write_text("")
    pr_repo.run(run_script, "--part=tests", pr_repo.base, pr_repo.head)
    assert [c["LANE"] for c in pr_repo.calls()] == ["unset"]


def test_lane_option_may_follow_positionals(pr_repo: _PrChecksRepo, run_script) -> None:
    """--lane は位置引数の後ろに置いてもよい。"""
    result = pr_repo.run(run_script, pr_repo.base, pr_repo.head, "--part=tests", "--lane=a:test-b")
    assert result.returncode == 0, result.stderr
    assert [c["LANE"] for c in pr_repo.calls()] == ["a:test-b"]


@pytest.mark.parametrize(
    "args",
    [
        ("--lane=a:test-b",),
        ("--part=lint", "--lane=a:test-b"),
        ("--part=githooks", "--lane=a:test-b"),
        ("--part=tests", "--lane=a"),
        ("--part=tests", "--lane=a:b:c"),
    ],
)
def test_lane_without_tests_part_or_with_bad_shape_exit_2(
    pr_repo: _PrChecksRepo, run_script, args: tuple
) -> None:
    """--lane は --part=tests と <project>:<target> の形のときだけ。違えば使い方を出して exit 2。"""
    result = pr_repo.run(run_script, *args, pr_repo.base, pr_repo.head)
    assert result.returncode == 2
    assert "使い方" in result.stderr
    assert pr_repo.pc_log.read_text() == ""


def test_lane_summary_heading_and_artifact_name(pr_repo: _PrChecksRepo, run_script) -> None:
    """--lane 指定の Summary は見出しにレーンを書き、失敗の案内の artifact 名にレーンの slug を付ける。"""
    result = pr_repo.run(
        run_script,
        "--part=tests",
        "--lane=pecot-visual:test-cli",
        pr_repo.base,
        pr_repo.head,
        env={"STUB_NX_LOG_SRC": str(pr_repo.write("nx-failed.log", _NX_LOG_FAILED))},
    )
    assert "## 検証の結果（tests: pecot-visual:test-cli）\n" in result.stdout
    assert "artifact `ci-logs-tests-pecot-visual-test-cli`" in result.stdout


def test_existing_skip_is_kept(pr_repo: _PrChecksRepo, run_script) -> None:
    """env に SKIP があれば、連結して引き継ぐ。"""
    result = pr_repo.run(run_script, env={"SKIP": "other-hook"})
    assert result.returncode == 0, result.stderr
    for call in pr_repo.calls():
        assert call["SKIP"].startswith("other-hook,check-version-plan-required")


@pytest.mark.parametrize("failing", _STAGES)
def test_failed_stage_does_not_stop_later_stages(
    pr_repo: _PrChecksRepo, run_script, failing: str
) -> None:
    """stage が落ちても後ろの stage を動かし、最後に非 0 で終える。"""
    result = pr_repo.run(run_script, env={"STUB_FAIL_STAGE": failing})
    assert result.returncode == 1

    assert [c["stage"] for c in pr_repo.calls()] == _STAGES
    assert f"| {failing} | 失敗（exit 1） |" in result.stdout
    for other in _STAGES:
        if other != failing:
            assert f"| {other} | 成功 |" in result.stdout
    assert pr_repo.done().read_text().strip() == "1"


def _assert_all_lanes(pr_repo: _PrChecksRepo, result) -> None:
    assert result.returncode == 0, result.stderr
    calls = pr_repo.calls()
    assert [c["stage"] for c in calls] == _STAGES
    for call in calls:
        assert "--all-files" in call["args"]
        assert "--from-ref" not in call["args"]
        assert "--to-ref" not in call["args"]
    for call in calls[1:]:
        assert call["TO"] == pr_repo.head
        assert call["PVB"] == "refs/pecot/ci-no-base"
    assert "モード: 全レーン" in result.stdout


def test_no_prev_runs_all_lanes(pr_repo: _PrChecksRepo, run_script) -> None:
    """NO_PREV=true のときは、base が履歴にあっても全レーンのモードにする。"""
    result = pr_repo.run(run_script, env={"NO_PREV": "true"})
    _assert_all_lanes(pr_repo, result)


def test_unknown_base_runs_all_lanes(pr_repo: _PrChecksRepo, run_script) -> None:
    """base が履歴に無いときは、全レーンのモードにする。"""
    missing = "1" * 40
    result = pr_repo.run(run_script, missing, pr_repo.head)
    _assert_all_lanes(pr_repo, result)
    assert missing in result.stdout


def test_normal_mode_is_reported(pr_repo: _PrChecksRepo, run_script) -> None:
    """通常のモードでは範囲の欄に base と head の SHA とモードを書く。"""
    result = pr_repo.run(run_script)
    assert f"- base: `{pr_repo.base}`" in result.stdout
    assert f"- head: `{pr_repo.head}`（PR では head は merge commit）" in result.stdout
    assert "モード: 通常" in result.stdout


_TSV_OLD = "2026-11-06T00:00:00+0000\ttask\told-project:test-cli\t9.0\tstatus=success\n"
_TSV_NEW = (
    "2026-11-06T01:00:00+0000\thook\tnx-affected-tests\t30.0\trc=0\n"
    "2026-11-06T01:00:01+0000\ttask\tproj-a:test-cli\t12.3\tstatus=success\n"
    "2026-11-06T01:00:02+0000\ttask\tproj-b:test-unit:ci\t4.0\tstatus=failure\n"
    "2026-11-06T01:00:03+0000\ttask\tproj-a:install\t50.0\tstatus=success\n"
    "2026-11-06T01:00:04+0000\ttask\tproj-a:test\t9.0\tstatus=success\n"
    "2026-11-06T01:00:05+0000\tnx\trun-many\t30.0\tparallel=4 lanes=2\n"
)


def test_lane_table_reads_only_rows_after_start(pr_repo: _PrChecksRepo, run_script) -> None:
    """レーンの表は、開始時より後ろの task 行のうち target が test-* のものだけ。"""
    pr_repo.tsv().parent.mkdir(parents=True)
    pr_repo.tsv().write_text(_TSV_OLD)
    result = pr_repo.run(
        run_script, env={"STUB_TSV_APPEND": str(pr_repo.write("tsv-new", _TSV_NEW))}
    )
    assert result.returncode == 0, result.stderr

    out = result.stdout
    assert "| proj-a:test-cli | 成功 | 12.3s |" in out
    assert "| proj-b:test-unit:ci | 失敗 | 4.0s |" in out
    assert "old-project" not in out
    assert "proj-a:install" not in out
    assert "proj-a:test |" not in out
    assert "対象なし（成功）" not in out


def test_lane_table_without_lanes(pr_repo: _PrChecksRepo, run_script) -> None:
    """test-* の task 行が 0 件のときは「対象なし（成功）」と書く。"""
    pr_repo.tsv().parent.mkdir(parents=True)
    pr_repo.tsv().write_text(_TSV_OLD)
    result = pr_repo.run(run_script)
    assert "対象なし（成功）" in result.stdout


_NX_LOG_FAILED = """\
::group::proj-a:test-cli
> nx run proj-a:test-cli

proj-a: boom
::endgroup::

 NX   Ran target test-cli for 2 projects (3s)

   ✔  1/2 succeeded

   ✖  1/2 targets failed, including the following:

Failed tasks:

- proj-a:test-cli
- proj-b:test-unit
- proj-a:test-cli
"""


def test_failure_section_lists_failed_lanes(pr_repo: _PrChecksRepo, run_script) -> None:
    """失敗の欄は、nx のログの `Failed tasks:` 以降のレーンを重複なしで出す。"""
    result = pr_repo.run(
        run_script, env={"STUB_NX_LOG_SRC": str(pr_repo.write("nx-failed.log", _NX_LOG_FAILED))}
    )
    out = result.stdout
    assert "- proj-a:test-cli\n- proj-b:test-unit\n" in out
    assert out.count("- proj-a:test-cli") == 1
    assert "artifact `ci-logs`" in out
    assert "=== 失敗レーン: ... ===" in out


def test_failure_section_ignores_log_from_earlier_run(pr_repo: _PrChecksRepo, run_script) -> None:
    """この run で書かれていない古いログの失敗は、失敗の欄に出さない。"""
    log = pr_repo.repo / ".pecot" / "tmp" / "pre-push" / "nx-affected-tests.log"
    log.parent.mkdir(parents=True)
    log.write_text(_NX_LOG_FAILED)
    result = pr_repo.run(run_script)
    assert "proj-b:test-unit" not in result.stdout
    assert "### 失敗\n\nなし" in result.stdout


# static 出力の task の塊。見出しに ::group:: や [local cache] が付く形も混ぜる。
_NX_LOG_SKIPS = """\
> nx run proj-a:install

 Tests  9 skipped | 1 passed (10)

::group::proj-a:test-cli > nx run proj-a:test-cli  [local cache]

 Test Files  1 passed | 1 skipped (2)
      Tests  2 skipped | 8 passed (10)
      Tests  1 failed | 3 skipped | 6 passed (10)

> nx run proj-b:test-unit

============ 3 passed, 4 skipped in 0.19s ============
45 passed, 2 skipped in 0.19s

 NX   Successfully ran target test-unit

 Tests  7 skipped | 1 passed (8)
> nx run proj-a:test-cli
      Tests  1 skipped | 1 passed (2)
"""


def test_skip_counts_per_lane(pr_repo: _PrChecksRepo, run_script) -> None:
    """skip はレーンごとに、vitest の Tests 行と pytest の要約行を塊の中だけ足す。"""
    result = pr_repo.run(
        run_script, env={"STUB_NX_LOG_SRC": str(pr_repo.write("nx-skips.log", _NX_LOG_SKIPS))}
    )
    out = result.stdout
    # proj-a:test-cli は 2 つの塊の合計（2 + 3 + 1）。Test Files 行は数えない。
    assert "| proj-a:test-cli | 6 |" in out
    # proj-b:test-unit は pytest の 2 形式の合計（4 + 2）。NX 行の後ろは数えない。
    assert "| proj-b:test-unit | 6 |" in out
    # test-* でない target の塊は数えない。
    assert "proj-a:install" not in out.split("### skip")[1]


def test_skip_section_without_log(pr_repo: _PrChecksRepo, run_script) -> None:
    """nx のログが無ければ、skip の欄は「なし」。"""
    result = pr_repo.run(run_script)
    assert "### skip\n\nなし" in result.stdout


def test_done_marker_written_on_success_and_replaces_stale(
    pr_repo: _PrChecksRepo, run_script
) -> None:
    """完了の印は成功でも書く。開始時に古い印を消す。"""
    pr_repo.done().parent.mkdir(parents=True)
    pr_repo.done().write_text("9\n")
    result = pr_repo.run(run_script)
    assert result.returncode == 0, result.stderr
    assert pr_repo.done().read_text().strip() == "0"


def test_summary_goes_to_file_when_set(pr_repo: _PrChecksRepo, run_script) -> None:
    """PECOT_CI_SUMMARY があれば、親ディレクトリを作って上書きで書き、stdout には出さない。"""
    summary = pr_repo.tmp / "deep" / "dir" / "summary.md"
    result = pr_repo.run(run_script, env={"PECOT_CI_SUMMARY": str(summary)})
    assert result.returncode == 0, result.stderr
    text = summary.read_text()
    assert "### 範囲" in text
    assert "### レーン" in text
    assert "### 失敗" in text
    assert "### skip" in text
    assert "### 環境" in text
    assert "### 範囲" not in result.stdout

    summary.write_text("stale\n")
    pr_repo.run(run_script, env={"PECOT_CI_SUMMARY": str(summary)})
    assert "stale" not in summary.read_text()


def test_summary_goes_to_stdout_when_unset(pr_repo: _PrChecksRepo, run_script) -> None:
    """PECOT_CI_SUMMARY が無ければ、Summary を標準出力へ出す。"""
    result = pr_repo.run(run_script)
    assert "## 検証の結果" in result.stdout


def test_environment_section(pr_repo: _PrChecksRepo, run_script, mock_bin) -> None:
    """環境の欄は、イメージ名と各ツールの版の 1 行目。無いツールは「なし」。"""
    mock_bin.install("actionlint", "echo 'actionlint-1.2.3'\necho second-line\n")
    result = pr_repo.run(run_script, env={"PECOT_CI_IMAGE": "ghcr.io/example/image:tag"})
    out = result.stdout
    assert "- イメージ: ghcr.io/example/image:tag" in out
    assert "- actionlint: actionlint-1.2.3" in out
    assert "second-line" not in out
    assert "- node: " in out


def test_environment_section_defaults(pr_repo: _PrChecksRepo, run_script) -> None:
    """PECOT_CI_IMAGE が無ければイメージは「-」。"""
    result = pr_repo.run(run_script)
    assert "- イメージ: -\n" in result.stdout


@pytest.mark.parametrize("args", [(), ("only-base",), ("", "head")])
def test_missing_arguments_exit_2(pr_repo: _PrChecksRepo, run_script, args: tuple) -> None:
    """引数が足りなければ、使い方を stderr へ出して exit 2。pre-commit は呼ばない。"""
    result = run_script(
        pr_repo.script, *args, cwd=pr_repo.repo, env={"STUB_PC_LOG": str(pr_repo.pc_log)}
    )
    assert result.returncode == 2
    assert "使い方" in result.stderr
    assert pr_repo.pc_log.read_text() == ""


def test_explicit_pre_commit_env(pr_repo: _PrChecksRepo, run_script, mock_bin) -> None:
    """PECOT_PRE_COMMIT で実行ファイルを明示できる。"""
    other = mock_bin.install("other-pre-commit", _PRE_COMMIT_STUB)
    result = pr_repo.run(run_script, env={"PECOT_PRE_COMMIT": str(other)})
    assert result.returncode == 0, result.stderr
    assert [c["stage"] for c in pr_repo.calls()] == _STAGES


# FR-029: 解決できない base のとき、run-affected-tests.sh は全 project の run-many へ落ちる。
_GRAPH = {
    "graph": {
        "nodes": {
            "lane-one": {"data": {"targets": {"test": {"executor": "nx:noop"}, "test-unit": {}}}}
        }
    }
}
_NX_STUB = """#!/bin/bash
@@GRAPH_BRANCH@@printf '%s\\n' "$*" >> "$STUB_NX_LOG"
exit 0
"""


def test_unresolvable_base_falls_back_to_run_many(
    git_repo: Callable[..., Path],
    git,
    git_rev_parse,
    tmp_path: Path,
    script_dir: Path,
    run_script,
    nx_stub_graph_branch: Callable[[dict, dict], str],
) -> None:
    """run-pr-checks.sh が全レーンのモードで渡す env で、run-affected-tests.sh が run-many を呼ぶ。"""
    repo = git_repo("repo", initial_branch="main")
    (repo / "node_modules" / ".bin").mkdir(parents=True)
    (repo / "README.md").write_text("head\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-q", "-m", "chore: init")
    head = git_rev_parse(repo, "HEAD")
    stub = repo / "node_modules" / ".bin" / "nx"
    stub.write_text(_NX_STUB.replace("@@GRAPH_BRANCH@@", nx_stub_graph_branch(_GRAPH, _GRAPH)))
    stub.chmod(0o755)
    nx_log = tmp_path / "nx.log"
    nx_log.write_text("")

    result = run_script(
        script_dir.parent / "ci" / "run-affected-tests.sh",
        cwd=repo,
        env={
            "STUB_NX_LOG": str(nx_log),
            "PRE_COMMIT_TO_REF": head,
            "PECOT_VERSION_PLAN_BASE": "refs/pecot/ci-no-base",
        },
    )
    assert result.returncode == 0, result.stderr

    log = nx_log.read_text()
    assert "run-many -t test" in log
    assert "affected" not in log
    assert (
        subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", "refs/pecot/ci-no-base"],
            cwd=repo,
            capture_output=True,
        ).returncode
        != 0
    )


# --- finish-ci-summary.sh（ホストの runner で Summary を書き写す） ---


def _run_finish(githooks_dir: Path, work: Path, outcome: str) -> subprocess.CompletedProcess:
    summary = work / "summary.md"
    return subprocess.run(
        [str(githooks_dir / "ci" / "finish-ci-summary.sh")],
        cwd=work,
        env={"PATH": "/usr/bin:/bin", "UP_OUTCOME": outcome, "GITHUB_STEP_SUMMARY": str(summary)},
        capture_output=True,
        text=True,
        check=False,
    )


def _write_ci_files(work: Path, *, summary: str | None, done: str | None) -> None:
    ci = work / ".pecot" / "tmp" / "ci"
    ci.mkdir(parents=True)
    if summary is not None:
        (ci / "step-summary.md").write_text(summary)
    if done is not None:
        (ci / "done").write_text(done)


def test_finish_copies_summary_and_passes_on_done_0(githooks_dir: Path, tmp_path: Path) -> None:
    _write_ci_files(tmp_path, summary="## 検証の結果\n", done="0\n")
    result = _run_finish(githooks_dir, tmp_path, "success")
    assert result.returncode == 0
    assert (tmp_path / "summary.md").read_text() == "## 検証の結果\n"


def test_finish_fails_on_nonzero_done(githooks_dir: Path, tmp_path: Path) -> None:
    _write_ci_files(tmp_path, summary="x\n", done="1\n")
    assert _run_finish(githooks_dir, tmp_path, "success").returncode == 1


def test_finish_fails_without_done_marker(githooks_dir: Path, tmp_path: Path) -> None:
    _write_ci_files(tmp_path, summary=None, done=None)
    result = _run_finish(githooks_dir, tmp_path, "success")
    assert result.returncode == 1
    assert "検証が完了していない" in (tmp_path / "summary.md").read_text()


def test_finish_reports_infra_failure(githooks_dir: Path, tmp_path: Path) -> None:
    _write_ci_files(tmp_path, summary=None, done=None)
    result = _run_finish(githooks_dir, tmp_path, "failure")
    assert result.returncode == 1
    assert "基盤の失敗" in (tmp_path / "summary.md").read_text()
