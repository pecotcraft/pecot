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

import os
import shutil
import socket
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
printf 'stage=%s|args=%s|SKIP=%s|PVB=%s|TO=%s|NXC=%s|NXCI=%s|LANE=%s|SRV=%s|NXCF=%s\n' \
    "$stage" "$*" "${SKIP-unset}" "${PECOT_VERSION_PLAN_BASE-unset}" \
    "${PRE_COMMIT_TO_REF-unset}" "${NX_SKIP_NX_CACHE-unset}" "${PECOT_NX_CI-unset}" \
    "${PECOT_NX_LANE-unset}" "${NX_SELF_HOSTED_REMOTE_CACHE_SERVER-unset}" \
    "${NX_CACHE_FAILURES-unset}" >> "$STUB_PC_LOG"
root=$(git rev-parse --show-toplevel)
if [ "$stage" = "manual" ]; then
    if [ -n "${STUB_TSV_APPEND:-}" ]; then
        mkdir -p "$root/.pecot/tmp"
        cat "$STUB_TSV_APPEND" >> "$root/.pecot/tmp/githooks-timing.tsv"
    fi
    if [ -n "${STUB_NX_LOG_SRC:-}" ]; then
        mkdir -p "$root/.pecot/tmp/nx-affected-tests"
        cp "$STUB_NX_LOG_SRC" "$root/.pecot/tmp/nx-affected-tests/nx-affected-tests.log"
    fi
fi
if [ "${STUB_KILL_PARENT_STAGE:-}" = "$stage" ]; then
    kill -TERM "$PPID"
    sleep 1
fi
if [ "${STUB_FAIL_STAGE:-}" = "$stage" ]; then
    exit 1
fi
exit 0
"""

# 偽の node。port を書いて待ち続け、SIGTERM で env FAKE_USED の hash を used-file に書いて終わる。
# 自分の pid を FAKE_NODE_PID のファイルへ書く。FAKE_NODE_MODE=exit は port を書いた直後に終わる。
# FAKE_NODE_MODE=silent は port を書かずに待ち続ける。
_FAKE_NODE = r"""#!/bin/bash
[ "${1:-}" != "--version" ] || { echo v0.0.0; exit 0; }
for a in "$@"; do
    case "$a" in
        --port-file=*) port_file="${a#--port-file=}" ;;
        --used-file=*) used_file="${a#--used-file=}" ;;
    esac
done
[ -z "${FAKE_NODE_PID:-}" ] || echo $$ > "$FAKE_NODE_PID"
[ -z "${FAKE_NODE_ARGS:-}" ] || echo "$*" > "$FAKE_NODE_ARGS"
case "${FAKE_NODE_MODE:-}" in
    exit) echo 4242 > "$port_file"; exit 0 ;;
    silent) ;;
    *) echo 4242 > "$port_file" ;;
esac
trap 'printf "%s" "${FAKE_USED:-}" > "$used_file"; exit 0' TERM
while :; do sleep 0.1; done
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
        "PECOT_CI_NX_CACHE",
        "NX_SELF_HOSTED_REMOTE_CACHE_SERVER",
        "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN",
        "NX_CACHE_FAILURES",
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
    """SKIP は全 stage に version plan の判定だけを入れる。"""
    result = pr_repo.run(run_script)
    assert result.returncode == 0, result.stderr

    by_stage = {c["stage"]: c for c in pr_repo.calls()}
    assert by_stage["pre-commit"]["SKIP"] == "check-version-plan-required"
    assert by_stage["pre-push"]["SKIP"] == "check-version-plan-required"
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
            ["check-version-plan-required"] * 2,
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
    ],
)
def test_lane_without_tests_part_exit_2(pr_repo: _PrChecksRepo, run_script, args: tuple) -> None:
    """--lane は --part=tests と組み合わせたときだけ。違えば使い方を出して exit 2。"""
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


def test_lane_summary_artifact_name_prefers_checks_slug(pr_repo: _PrChecksRepo, run_script) -> None:
    """env CHECKS_SLUG があれば、それを artifact 名に使う。無ければ英数字と ._- 以外を - にする。"""
    nx_log = {"STUB_NX_LOG_SRC": str(pr_repo.write("nx-failed.log", _NX_LOG_FAILED))}
    args = ("--part=tests", "--lane=@scope/pkg:test-cli", pr_repo.base, pr_repo.head)
    result = pr_repo.run(run_script, *args, env=nx_log)
    assert "artifact `ci-logs-tests--scope-pkg-test-cli`" in result.stdout
    result = pr_repo.run(run_script, *args, env={**nx_log, "CHECKS_SLUG": "custom-slug"})
    assert "artifact `ci-logs-tests-custom-slug`" in result.stdout


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


def test_lane_table_marks_cache_hits(pr_repo: _PrChecksRepo, run_script) -> None:
    """キャッシュから返ったレーンは「成功（キャッシュ）」、実行したレーンは「成功」。"""
    tsv = (
        "2026-11-06T01:00:01+0000\ttask\tproj-a:test-cli\t1.0\tstatus=local-cache\n"
        "2026-11-06T01:00:02+0000\ttask\tproj-a:test-hooks\t1.0\tstatus=remote-cache\n"
        "2026-11-06T01:00:03+0000\ttask\tproj-a:test-py\t1.0\tstatus=local-cache-kept-existing\n"
        "2026-11-06T01:00:04+0000\ttask\tproj-a:test-skills\t1.0\tstatus=success\n"
    )
    result = pr_repo.run(run_script, env={"STUB_TSV_APPEND": str(pr_repo.write("tsv", tsv))})
    out = result.stdout
    assert "| proj-a:test-cli | 成功（キャッシュ） | 1.0s |" in out
    assert "| proj-a:test-hooks | 成功（キャッシュ） | 1.0s |" in out
    assert "| proj-a:test-py | 成功（キャッシュ） | 1.0s |" in out
    assert "| proj-a:test-skills | 成功 | 1.0s |" in out


# ====
# nx のリモートキャッシュ（PECOT_CI_NX_CACHE）
# ====


def _manual_call(pr_repo: _PrChecksRepo) -> dict[str, str]:
    return next(c for c in pr_repo.calls() if c["stage"] == "manual")


def test_tests_part_with_nx_cache_uses_remote_cache(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path
) -> None:
    """tests の part で保存先があると、サーバを立ててキャッシュを使い、失敗の再生もしない。"""
    cache = tmp_path / "nx-remote"
    cache.mkdir()
    (cache / "abc123.tar.gz").write_bytes(b"x")
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(cache)},
    )
    assert result.returncode == 0, result.stderr
    call = _manual_call(pr_repo)
    assert call["NXC"] == "unset"
    assert call["NXCF"] == "unset"
    assert call["SRV"].startswith("http://127.0.0.1:")
    assert "取り込み済み 1 件" in result.stderr
    assert "nx-cache-server: GET hit=0 miss=0 PUT=0" in result.stderr


@pytest.mark.parametrize("part", ["lint", "githooks"])
def test_other_parts_with_nx_cache_skip_the_cache(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path, part: str
) -> None:
    result = pr_repo.run(
        run_script,
        f"--part={part}",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    assert result.returncode == 0, result.stderr
    for call in pr_repo.calls():
        assert call["NXC"] == "true"
        assert call["SRV"] == "unset"
        assert call["NXCF"] == "unset"
    assert "キャッシュ:" not in result.stdout


def test_tests_part_without_nx_cache_skips_the_cache(pr_repo: _PrChecksRepo, run_script) -> None:
    result = pr_repo.run(run_script, "--part=tests", pr_repo.base, pr_repo.head)
    call = _manual_call(pr_repo)
    assert (call["NXC"], call["SRV"], call["NXCF"]) == ("true", "unset", "unset")
    assert "キャッシュ:" not in result.stdout


def test_server_start_failure_falls_back_to_skip(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path
) -> None:
    """保存先を作れずサーバが起動しないときは、警告を出して今までどおりキャッシュを使わない。"""
    blocker = tmp_path / "blocker"
    blocker.write_text("file\n")
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(blocker / "nx-remote")},
    )
    assert result.returncode == 0, result.stderr
    call = _manual_call(pr_repo)
    assert (call["NXC"], call["SRV"]) == ("true", "unset")
    assert "WARN:" in result.stderr


def _write_source(pr_repo: _PrChecksRepo, text: str) -> None:
    path = pr_repo.repo / ".pecot" / "tmp" / "ci" / "nx-source.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


_SOURCE_CASES = [
    (
        "status=imported\nrun_id=123\npr=45\nhead_sha=abcdef0\n",
        "キャッシュ: run 123（PR #45、head abcdef0）から取り込み",
    ),
    ("status=none\nreason=artifact なし\n", "キャッシュ: 取り込みなし（artifact なし）"),
    (None, "キャッシュ: 取り込みなし（記録なし）"),
]


@pytest.mark.parametrize(("source", "expected"), _SOURCE_CASES)
def test_summary_reports_nx_cache_source(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path, source: str | None, expected: str
) -> None:
    if source is not None:
        _write_source(pr_repo, source)
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    assert expected in result.stdout.splitlines()


def _install_fake_node(mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mode: str = ""):
    mock_bin.install("node", _FAKE_NODE)
    pid_file = tmp_path / "node.pid"
    monkeypatch.setenv("FAKE_NODE_PID", str(pid_file))
    monkeypatch.setenv("FAKE_NODE_MODE", mode)
    return pid_file


def _pid_alive(pid_file: Path) -> bool:
    try:
        os.kill(int(pid_file.read_text()), 0)
    except ProcessLookupError:
        return False
    return True


def test_missing_node_falls_back_to_skip(
    pr_repo: _PrChecksRepo, run_script, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """node が無いときは警告を出し、キャッシュを使わずに動く。"""
    only = tmp_path / "no-node-bin"
    only.mkdir()
    for name in (
        "git",
        "bash",
        "env",
        "head",
        "od",
        "tr",
        "find",
        "wc",
        "sleep",
        "dirname",
        "mkdir",
        "rm",
        "cat",
        "cut",
        "tail",
        "kill",
        "sed",
        "sort",
        "sha256sum",
        "cp",
        "uname",
        "pre-commit",
    ):
        found = shutil.which(name)
        if found:
            (only / name).symlink_to(found)
    monkeypatch.setenv("PATH", str(only))
    assert shutil.which("node") is None
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    assert result.returncode == 0, result.stderr
    assert "WARN: node が無いため" in result.stderr
    call = _manual_call(pr_repo)
    assert (call["NXC"], call["SRV"]) == ("true", "unset")


@pytest.mark.parametrize("mode", ["silent", "exit-before-port"])
def test_server_without_port_falls_back_to_skip(
    pr_repo: _PrChecksRepo,
    run_script,
    mock_bin,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    mode: str,
) -> None:
    """port を書かないサーバは待ち切って止め、キャッシュを使わずに動く。"""
    if mode == "silent":
        pid_file = _install_fake_node(mock_bin, monkeypatch, tmp_path, "silent")
    else:
        mock_bin.install("node", "exit 1\n")
        pid_file = tmp_path / "node.pid"
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote"), "PECOT_CI_NX_CACHE_WAIT_TICKS": "5"},
    )
    assert result.returncode == 0, result.stderr
    assert "WARN: nx のキャッシュサーバが起動しませんでした" in result.stderr
    call = _manual_call(pr_repo)
    assert (call["NXC"], call["SRV"]) == ("true", "unset")
    if pid_file.exists():
        assert not _pid_alive(pid_file)


def test_server_dead_before_manual_stage_falls_back_to_skip(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """起動後に止まったサーバへは nx が接続できず task が失敗する（F-19）。manual の前に確かめ、キャッシュなしにする。"""
    _install_fake_node(mock_bin, monkeypatch, tmp_path, "exit")
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    assert result.returncode == 0, result.stderr
    call = _manual_call(pr_repo)
    assert (call["NXC"], call["SRV"]) == ("true", "unset")
    assert "キャッシュサーバが落ちている" in result.stderr


def test_server_is_stopped_by_trap_when_script_is_terminated(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """stage の途中でスクリプトが SIGTERM を受けても、trap でサーバを止める。"""
    pid_file = _install_fake_node(mock_bin, monkeypatch, tmp_path)
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote"), "STUB_KILL_PARENT_STAGE": "manual"},
    )
    assert result.returncode != 0
    assert pid_file.exists()
    assert not _pid_alive(pid_file)
    assert pr_repo.done().exists()


def test_failed_stage_stops_the_server(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """stage が失敗しても、サーバは止める。"""
    pid_file = _install_fake_node(mock_bin, monkeypatch, tmp_path)
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote"), "STUB_FAIL_STAGE": "manual"},
    )
    assert result.returncode == 1
    assert not _pid_alive(pid_file)


def test_upload_dir_holds_only_used_artifacts(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """upload 用の場所には、nx-used.txt の hash の成果物だけが写る。hash は英数字だけを受ける。"""
    _install_fake_node(mock_bin, monkeypatch, tmp_path)
    monkeypatch.setenv("FAKE_USED", "abc1\n../evil\ndef2\nmissing\n")
    cache = tmp_path / "nx-remote"
    cache.mkdir()
    for name in ("abc1", "def2", "old3"):
        (cache / f"{name}.tar.gz").write_bytes(name.encode())
    (tmp_path / "evil.tar.gz").write_bytes(b"x")
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(cache)},
    )
    assert result.returncode == 0, result.stderr
    upload = pr_repo.repo / ".pecot" / "tmp" / "ci" / "nx-upload"
    assert sorted(p.name for p in upload.iterdir()) == [
        "abc1.tar.gz",
        "def2.tar.gz",
        "tested-tree.txt",
    ]
    assert (upload / "abc1.tar.gz").read_bytes() == b"abc1"
    own_tree = subprocess.run(
        ["git", "rev-parse", "HEAD^{tree}"], cwd=pr_repo.repo, capture_output=True, text=True
    ).stdout.strip()
    assert (upload / "tested-tree.txt").read_text().strip() == own_tree


def test_server_receives_used_file_path(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """サーバへ --used-file=<ci_dir>/nx-used.txt を渡す。"""
    _install_fake_node(mock_bin, monkeypatch, tmp_path)
    args_file = tmp_path / "node.args"
    monkeypatch.setenv("FAKE_NODE_ARGS", str(args_file))
    pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    used = pr_repo.repo / ".pecot" / "tmp" / "ci" / "nx-used.txt"
    assert f"--used-file={used}" in args_file.read_text()


def test_upload_dir_is_empty_without_used_file(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """サーバが一覧を書かなかったときは、取り込み済みの成果物も上げない。"""
    _install_fake_node(mock_bin, monkeypatch, tmp_path, "exit")
    cache = tmp_path / "nx-remote"
    cache.mkdir()
    (cache / "abc1.tar.gz").write_bytes(b"x")
    pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(cache)},
    )
    upload = pr_repo.repo / ".pecot" / "tmp" / "ci" / "nx-upload"
    assert list(upload.iterdir()) == []


def test_cache_inputs_are_logged_and_summarized(
    pr_repo: _PrChecksRepo, run_script, git_rev_parse, tmp_path: Path
) -> None:
    """取り込み元の tree と自分の tree、lock の hash、apt の一覧の hash を、ログと Summary に 1 行ずつ出す。"""
    (pr_repo.repo / "pnpm-lock.yaml").write_text("lock\n")
    own_tree = git_rev_parse(pr_repo.repo, "HEAD^{tree}")
    lock_hash = subprocess.run(
        ["git", "hash-object", "pnpm-lock.yaml"], cwd=pr_repo.repo, capture_output=True, text=True
    ).stdout.strip()
    _write_source(pr_repo, "status=imported\nrun_id=1\npr=2\nhead_sha=abc\n")
    nx_remote = tmp_path / "nx-remote"
    nx_remote.mkdir()
    (nx_remote / "tested-tree.txt").write_text("srctree99\n")
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    expected = [
        f"キャッシュの入力: 取り込み元の tree srctree99、自分の tree {own_tree}",
        f"キャッシュの入力: pnpm-lock.yaml の hash {lock_hash}",
    ]
    for line in expected:
        assert line in result.stderr.splitlines()
        assert f"- {line}" in result.stdout.splitlines()
    deb = [ln for ln in result.stdout.splitlines() if "apt のパッケージ一覧の hash" in ln]
    assert len(deb) == 1
    assert (
        len([ln for ln in result.stderr.splitlines() if "apt のパッケージ一覧の hash" in ln]) == 1
    )


def test_cache_inputs_use_dash_without_sources(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path
) -> None:
    """取り込んだ tested-tree.txt が無く lock も無いときは「-」を出す。"""
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    assert "- キャッシュの入力: pnpm-lock.yaml の hash -" in result.stdout.splitlines()
    assert any(
        ln.startswith("- キャッシュの入力: 取り込み元の tree -、自分の tree ")
        for ln in result.stdout.splitlines()
    )


def test_cache_inputs_absent_without_nx_cache(pr_repo: _PrChecksRepo, run_script) -> None:
    """PECOT_CI_NX_CACHE が無ければ、入力の行は出さない。"""
    result = pr_repo.run(run_script, "--part=tests", pr_repo.base, pr_repo.head)
    assert "キャッシュの入力" not in result.stdout + result.stderr


def test_nx_fails_the_task_when_remote_cache_is_unreachable(tmp_path: Path) -> None:
    """F-19 の事実。誰も待ち受けない port を向けると、実 nx は task を実行せずに失敗する。

    そのため run-pr-checks.sh は、manual の stage の前にサーバが生きているかを確かめる。
    """
    nx_bin = Path(__file__).resolve().parents[2] / "node_modules" / ".bin" / "nx"
    if not nx_bin.exists():
        pytest.skip("node_modules/.bin/nx が無い（npm ci 前）ため実 nx テストを skip する")
    ws = tmp_path / "ws"
    (ws / "p").mkdir(parents=True)
    (ws / "nx.json").write_text('{"targetDefaults": {"tgt": {"cache": true}}}')
    (ws / "package.json").write_text('{"name": "x", "version": "1.0.0"}')
    (ws / "p" / "project.json").write_text(
        '{"name": "p", "targets": {"tgt": {"command": "touch ran-the-task", "cache": true}}}'
    )
    (ws / "node_modules").symlink_to(nx_bin.parents[1])
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {
        **os.environ,
        "NX_DAEMON": "false",
        "NX_CACHE_DIRECTORY": str(tmp_path / "cache"),
        "NX_WORKSPACE_DATA_DIRECTORY": str(tmp_path / "data"),
        "NX_SELF_HOSTED_REMOTE_CACHE_SERVER": f"http://127.0.0.1:{port}",
        "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN": "x",
    }
    env.pop("NX_SKIP_NX_CACHE", None)
    result = subprocess.run(
        [str(nx_bin), "run", "p:tgt"], cwd=ws, env=env, capture_output=True, text=True, timeout=20
    )
    assert result.returncode != 0
    assert "Failed to send request" in result.stdout + result.stderr
    assert not (ws / "ran-the-task").exists()

    env["NX_SKIP_NX_CACHE"] = "true"
    for key in ("NX_SELF_HOSTED_REMOTE_CACHE_SERVER", "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN"):
        env.pop(key)
    skipped = subprocess.run(
        [str(nx_bin), "run", "p:tgt"], cwd=ws, env=env, capture_output=True, text=True, timeout=20
    )
    assert skipped.returncode == 0, skipped.stderr
    assert (ws / "ran-the-task").exists()


def test_lane_option_emits_summary_with_environment(pr_repo: _PrChecksRepo, run_script) -> None:
    """--lane 付きでも、Summary に範囲・レーン・環境の欄が出る。"""
    result = pr_repo.run(run_script, "--part=tests", "--lane=a:test-b", pr_repo.base, pr_repo.head)
    assert result.returncode == 0, result.stderr
    for heading in ("### 範囲", "### レーン", "### 失敗", "### skip", "### 環境"):
        assert heading in result.stdout


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


def test_finish_reports_image_on_infra_failure(githooks_dir: Path, tmp_path: Path) -> None:
    _write_ci_files(tmp_path, summary=None, done=None)
    result = subprocess.run(
        [str(githooks_dir / "ci" / "finish-ci-summary.sh")],
        cwd=tmp_path,
        env={
            "PATH": "/usr/bin:/bin",
            "UP_OUTCOME": "failure",
            "PECOT_CI_IMAGE": "img:def-abc@sha256:123",
            "GITHUB_STEP_SUMMARY": str(tmp_path / "summary.md"),
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "- イメージ: img:def-abc@sha256:123" in (tmp_path / "summary.md").read_text()
