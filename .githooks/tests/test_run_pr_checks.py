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
import sys
from collections.abc import Callable
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

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
        for line in read_output(self.pc_log).splitlines():
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


@allure.title(
    "3 つの stage を pre-commit・pre-push・manual の順に、base と head の範囲を指定して呼ぶ"
)
def test_stages_run_in_order_with_range(pr_repo: _PrChecksRepo, run_script) -> None:
    """`run-pr-checks.sh` を既定の引数で実行した場合のテストです。偽の `pre-commit` が 3 つの stage の順に呼ばれ、どの呼び出しにも `--from-ref` と `--to-ref` が渡され、`--all-files` は含まれないことを確認します。"""
    result = pr_repo.run(run_script)
    with allure.step("3 つの stage が順に、base と head の範囲で呼ばれることを確かめる"):
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


@allure.title(
    "`SKIP` には全 stage で version plan の判定だけを指定し、`PECOT_VERSION_PLAN_BASE` は pre-push と manual にだけ渡す"
)
def test_skip_and_plan_base_per_stage(pr_repo: _PrChecksRepo, run_script) -> None:
    """`pre-commit` に渡す環境変数のテストです。`SKIP` に `check-version-plan-required` が指定されます。`PECOT_VERSION_PLAN_BASE` は、pre-commit では未設定で、pre-push と manual では base になることを確認します。"""
    result = pr_repo.run(run_script)
    with allure.step("stage ごとの SKIP と version plan の base を確かめる"):
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


@allure.title("`--part={part}` を指定すると、流す stage と飛ばす hook が変わる")
@pytest.mark.parametrize(
    ("part", "stages", "skips"),
    [
        (
            "lint",
            ["pre-commit", "pre-push"],
            ["check-version-plan-required"] * 2,
        ),
        ("tests", ["manual"], ["check-version-plan-required"]),
    ],
)
def test_part_selects_stages_and_skip(
    pr_repo: _PrChecksRepo, run_script, part: str, stages: list[str], skips: list[str]
) -> None:
    """`--part` に lint と tests を指定した場合のテストです。lint では pre-commit と pre-push、tests では manual の stage だけが呼ばれ、`SKIP` の値が期待どおりになることを確認します。"""
    result = pr_repo.run(run_script, f"--part={part}", pr_repo.base, pr_repo.head)
    with allure.step("part に応じた stage と SKIP を確かめる"):
        assert result.returncode == 0, result.stderr

        calls = pr_repo.calls()
        assert [c["stage"] for c in calls] == stages
        assert [c["SKIP"] for c in calls] == skips


@allure.title("`--part` は、位置引数の後ろに置いても指定できる")
def test_part_option_may_follow_positionals(pr_repo: _PrChecksRepo, run_script) -> None:
    """`--part=lint` を base と head の後ろに置いた場合のテストです。オプションが認識され、pre-commit と pre-push の 2 つの stage だけが呼ばれることを確認します。"""
    result = pr_repo.run(run_script, pr_repo.base, pr_repo.head, "--part=lint")
    with allure.step("位置引数の後ろの --part でも stage が選ばれることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert [c["stage"] for c in pr_repo.calls()] == ["pre-commit", "pre-push"]


@allure.title("不明な `--part` を指定すると、使い方を表示して終了コード 2 で終了する")
def test_unknown_part_exit_2(pr_repo: _PrChecksRepo, run_script) -> None:
    """`--part=bogus` のように存在しない part を指定した場合のテストです。終了コードが 2 になり、標準エラー出力に使い方が表示され、`pre-commit` が呼ばれないことを確認します。"""
    result = pr_repo.run(run_script, "--part=bogus", pr_repo.base, pr_repo.head)
    with allure.step("終了コード 2 と使い方の出力と pre-commit が呼ばれないことを確かめる"):
        assert result.returncode == 2
        assert "使い方" in result.stderr
        assert read_output(pr_repo.pc_log) == ""


@allure.title("lint の Summary は、見出しに part を書き、レーン・失敗・skip の欄を表示しない")
def test_summary_without_lane_sections_for_non_test_part(
    pr_repo: _PrChecksRepo, run_script
) -> None:
    """`--part=lint` で実行した場合の Summary のテストです。見出しに part が含まれ、範囲と環境の欄は表示される一方で、レーン・失敗・skip の欄が存在しないことを確認します。"""
    result = pr_repo.run(run_script, "--part=lint", pr_repo.base, pr_repo.head)
    out = result.stdout
    with allure.step("lint の Summary の見出しと欄を確かめる"):
        assert "## 検証の結果（lint）\n" in out
        assert "### 範囲" in out
        assert "### 環境" in out
        for heading in ("### レーン", "### 失敗", "### skip"):
            assert heading not in out


@allure.title("tests の Summary は、見出しに part を書き、レーン・失敗・skip の欄を表示する")
def test_summary_with_lane_sections_for_tests_part(pr_repo: _PrChecksRepo, run_script) -> None:
    """`--part=tests` で実行した場合の Summary のテストです。見出しに part が含まれ、レーン・失敗・skip の欄がすべて表示されることを確認します。"""
    result = pr_repo.run(run_script, "--part=tests", pr_repo.base, pr_repo.head)
    out = result.stdout
    with allure.step("tests の Summary の見出しと欄を確かめる"):
        assert "## 検証の結果（tests）\n" in out
        for heading in ("### レーン", "### 失敗", "### skip"):
            assert heading in out


@allure.title("`--part` を省略すると、見出しに part を含めず、すべての欄を表示する")
def test_summary_without_part_has_plain_heading_and_lane_sections(
    pr_repo: _PrChecksRepo, run_script
) -> None:
    """`--part` を指定せずに実行した場合の Summary のテストです。見出しが part なしの形になり、レーン・失敗・skip の欄がすべて表示されることを確認します。"""
    out = pr_repo.run(run_script).stdout
    with allure.step("part なしの Summary の見出しと欄を確かめる"):
        assert "## 検証の結果\n" in out
        for heading in ("### レーン", "### 失敗", "### skip"):
            assert heading in out


@allure.title("`--part=tests` の失敗の案内は、artifact の名前を `ci-logs-tests` にする")
def test_failure_guide_names_part_artifact(pr_repo: _PrChecksRepo, run_script) -> None:
    """`--part=tests` で nx のログに失敗が含まれる場合のテストです。失敗の案内に、`ci-logs-tests` の artifact が表示され、part なしの `ci-logs` が表示されないことを確認します。"""
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"STUB_NX_LOG_SRC": str(pr_repo.write("nx-failed.log", _NX_LOG_FAILED))},
    )
    with allure.step("失敗の案内の artifact 名を確かめる"):
        assert "artifact `ci-logs-tests`" in result.stdout
        assert "artifact `ci-logs`" not in result.stdout


@allure.title(
    "`--lane` を指定すると `PECOT_NX_LANE` として `pre-commit` に渡し、指定しなければ渡さない"
)
def test_lane_is_passed_to_pre_commit_env(pr_repo: _PrChecksRepo, run_script) -> None:
    """`--lane` の指定の有無で、`pre-commit` に渡る環境変数が変わるかのテストです。`--lane` を指定した場合は `PECOT_NX_LANE` にそのレーンが入り、指定しない場合は未設定になることを確認します。"""
    lane = "pecot-visual:test-cli"
    result = pr_repo.run(run_script, "--part=tests", f"--lane={lane}", pr_repo.base, pr_repo.head)
    with allure.step("--lane が pre-commit の環境変数に渡り、無いと渡らないことを確かめる"):
        assert result.returncode == 0, result.stderr
        assert [c["LANE"] for c in pr_repo.calls()] == [lane]

        pr_repo.pc_log.write_text("")
        pr_repo.run(run_script, "--part=tests", pr_repo.base, pr_repo.head)
        assert [c["LANE"] for c in pr_repo.calls()] == ["unset"]


@allure.title("`--lane` は、位置引数の後ろに置いても指定できる")
def test_lane_option_may_follow_positionals(pr_repo: _PrChecksRepo, run_script) -> None:
    """`--part=tests` と `--lane` を base と head の後ろに置いた場合のテストです。オプションが認識され、`PECOT_NX_LANE` に指定したレーンが渡されることを確認します。"""
    result = pr_repo.run(run_script, pr_repo.base, pr_repo.head, "--part=tests", "--lane=a:test-b")
    with allure.step("位置引数の後ろの --lane でも渡ることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert [c["LANE"] for c in pr_repo.calls()] == ["a:test-b"]


@allure.title(
    "`--lane` を {args} のように `--part=tests` なしで指定すると、使い方を表示して終了コード 2 で終了する"
)
@pytest.mark.parametrize(
    "args",
    [
        ("--lane=a:test-b",),
        ("--part=lint", "--lane=a:test-b"),
    ],
)
def test_lane_without_tests_part_exit_2(pr_repo: _PrChecksRepo, run_script, args: tuple) -> None:
    """`--lane` を、`--part` なしで指定した場合と、`--part=lint` と組み合わせた場合のテストです。終了コードが 2 になり、標準エラー出力に使い方が表示され、`pre-commit` が呼ばれないことを確認します。"""
    result = pr_repo.run(run_script, *args, pr_repo.base, pr_repo.head)
    with allure.step("終了コード 2 と使い方の出力と pre-commit が呼ばれないことを確かめる"):
        assert result.returncode == 2
        assert "使い方" in result.stderr
        assert read_output(pr_repo.pc_log) == ""


@allure.title(
    "`--lane` を指定すると、Summary の見出しにレーンを書き、失敗の案内の artifact の名前にレーンの slug を付ける"
)
def test_lane_summary_heading_and_artifact_name(pr_repo: _PrChecksRepo, run_script) -> None:
    """`--part=tests` と `--lane=pecot-visual:test-cli` を指定した場合のテストです。見出しにレーンが含まれ、artifact の名前が `ci-logs-tests-pecot-visual-test-cli` になることを確認します。"""
    result = pr_repo.run(
        run_script,
        "--part=tests",
        "--lane=pecot-visual:test-cli",
        pr_repo.base,
        pr_repo.head,
        env={"STUB_NX_LOG_SRC": str(pr_repo.write("nx-failed.log", _NX_LOG_FAILED))},
    )
    with allure.step("Summary の見出しと失敗の案内の artifact 名にレーンが入ることを確かめる"):
        assert "## 検証の結果（tests: pecot-visual:test-cli）\n" in result.stdout
        assert "artifact `ci-logs-tests-pecot-visual-test-cli`" in result.stdout


@allure.title(
    "環境変数 `CHECKS_SLUG` があれば artifact の名前に使い、なければ記号を `-` に置き換える"
)
def test_lane_summary_artifact_name_prefers_checks_slug(pr_repo: _PrChecksRepo, run_script) -> None:
    """`@scope/pkg:test-cli` のように記号を含むレーンを指定した場合のテストです。`CHECKS_SLUG` がないときは英数字と `.`・`_`・`-` 以外が `-` に置き換わり、`CHECKS_SLUG` があるときはその値が artifact の名前に使われることを確認します。"""
    nx_log = {"STUB_NX_LOG_SRC": str(pr_repo.write("nx-failed.log", _NX_LOG_FAILED))}
    args = ("--part=tests", "--lane=@scope/pkg:test-cli", pr_repo.base, pr_repo.head)
    result = pr_repo.run(run_script, *args, env=nx_log)
    with allure.step("CHECKS_SLUG があるときとないときの artifact 名を確かめる"):
        assert "artifact `ci-logs-tests--scope-pkg-test-cli`" in result.stdout
        result = pr_repo.run(run_script, *args, env={**nx_log, "CHECKS_SLUG": "custom-slug"})
        assert "artifact `ci-logs-tests-custom-slug`" in result.stdout


@allure.title("環境変数 `SKIP` がすでに設定されている場合は、連結して引き継ぐ")
def test_existing_skip_is_kept(pr_repo: _PrChecksRepo, run_script) -> None:
    """`SKIP=other-hook` を指定して実行した場合のテストです。どの呼び出しでも、`SKIP` が `other-hook` で始まり、`check-version-plan-required` が連結されることを確認します。"""
    result = pr_repo.run(run_script, env={"SKIP": "other-hook"})
    with allure.step("元の SKIP が連結されて引き継がれることを確かめる"):
        assert result.returncode == 0, result.stderr
        for call in pr_repo.calls():
            assert call["SKIP"].startswith("other-hook,check-version-plan-required")


@allure.title(
    "{failing} の stage が失敗しても、後ろの stage を実行し、最後に終了コード 1 で終了する"
)
@pytest.mark.parametrize("failing", _STAGES)
def test_failed_stage_does_not_stop_later_stages(
    pr_repo: _PrChecksRepo, run_script, failing: str
) -> None:
    """3 つの stage のいずれかが失敗する場合のテストです。失敗した stage の後ろも実行され、Summary に失敗と成功が stage ごとに表示されて、完了の印に 1 が書かれることを確認します。"""
    result = pr_repo.run(run_script, env={"STUB_FAIL_STAGE": failing})
    with allure.step("終了コードと後ろの stage が動くことと失敗の表示を確かめる"):
        assert result.returncode == 1

        assert [c["stage"] for c in pr_repo.calls()] == _STAGES
        assert f"| {failing} | 失敗（exit 1） |" in result.stdout
        for other in _STAGES:
            if other != failing:
                assert f"| {other} | 成功 |" in result.stdout
        assert read_output(pr_repo.done()).strip() == "1"


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


@allure.title("`NO_PREV=true` の場合は、base が履歴にあっても全レーンのモードにする")
def test_no_prev_runs_all_lanes(pr_repo: _PrChecksRepo, run_script) -> None:
    """環境変数 `NO_PREV` を `true` にして実行した場合のテストです。範囲ではなく `--all-files` で全 stage が呼ばれ、Summary に全レーンのモードと表示されることを確認します。"""
    with allure.step("NO_PREV=true で動かして全レーンのモードになることを確かめる"):
        result = pr_repo.run(run_script, env={"NO_PREV": "true"})
        _assert_all_lanes(pr_repo, result)


@allure.title("base が履歴に存在しない場合は、全レーンのモードにする")
def test_unknown_base_runs_all_lanes(pr_repo: _PrChecksRepo, run_script) -> None:
    """履歴に存在しない SHA を base に指定した場合のテストです。全 stage が `--all-files` で呼ばれ、Summary に全レーンのモードと、指定した base の SHA が表示されることを確認します。"""
    missing = "1" * 40
    result = pr_repo.run(run_script, missing, pr_repo.head)
    _assert_all_lanes(pr_repo, result)
    with allure.step("履歴に無い base で動かして全レーンのモードになることを確かめる"):
        assert missing in result.stdout


@allure.title("通常のモードでは、範囲の欄に base と head の SHA とモードを書く")
def test_normal_mode_is_reported(pr_repo: _PrChecksRepo, run_script) -> None:
    """base が履歴にある通常の実行のテストです。Summary の範囲の欄に、base と head の SHA に加えて、通常のモードであることが表示されることを確認します。"""
    result = pr_repo.run(run_script)
    with allure.step("範囲の欄の base・head と、通常のモードを確かめる"):
        assert f"- base: `{pr_repo.base}`" in result.stdout
        assert f"- head: `{pr_repo.head}`（PR では head は merge commit）" in result.stdout
        assert "モード: 通常" in result.stdout


@allure.title(
    "キャッシュから返ったレーンは「成功（キャッシュ）」、実行したレーンは「成功」と表示する"
)
def test_lane_table_marks_cache_hits(pr_repo: _PrChecksRepo, run_script) -> None:
    """所要時間の記録に、ローカルとリモートのキャッシュ由来の状態と、実行した状態が並んでいる場合のテストです。レーンの表で、キャッシュ由来のレーンだけが「成功（キャッシュ）」と表示されることを確認します。"""
    tsv = (
        "2026-11-06T01:00:01+0000\ttask\tproj-a:test-cli\t1.0\tstatus=local-cache\n"
        "2026-11-06T01:00:02+0000\ttask\tproj-a:test-hooks\t1.0\tstatus=remote-cache\n"
        "2026-11-06T01:00:03+0000\ttask\tproj-a:test-py\t1.0\tstatus=local-cache-kept-existing\n"
        "2026-11-06T01:00:04+0000\ttask\tproj-a:test-skills\t1.0\tstatus=success\n"
    )
    result = pr_repo.run(run_script, env={"STUB_TSV_APPEND": str(pr_repo.write("tsv", tsv))})
    out = result.stdout
    with allure.step("レーンの表がキャッシュの成功と実行の成功を区別することを確かめる"):
        assert "| proj-a:test-cli | 成功（キャッシュ） | 1.0s |" in out
        assert "| proj-a:test-hooks | 成功（キャッシュ） | 1.0s |" in out
        assert "| proj-a:test-py | 成功（キャッシュ） | 1.0s |" in out
        assert "| proj-a:test-skills | 成功 | 1.0s |" in out


# ====
# nx のリモートキャッシュ（PECOT_CI_NX_CACHE）
# ====


def _manual_call(pr_repo: _PrChecksRepo) -> dict[str, str]:
    return next(c for c in pr_repo.calls() if c["stage"] == "manual")


@allure.title(
    "tests の part で保存先を指定すると、サーバを起動してキャッシュを使い、失敗の再生はしない"
)
def test_tests_part_with_nx_cache_uses_remote_cache(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path
) -> None:
    """`--part=tests` で `PECOT_CI_NX_CACHE` に保存先を指定した場合のテストです。manual の stage に `http://127.0.0.1:` で始まるサーバの URL が渡され、`NX_SKIP_NX_CACHE` は未設定になり、取り込み件数が表示されることを確認します。"""
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
    with allure.step("終了コードとキャッシュサーバの環境と取り込みの表示を確かめる"):
        assert result.returncode == 0, result.stderr
        call = _manual_call(pr_repo)
        assert call["NXC"] == "unset"
        assert call["NXCF"] == "unset"
        assert call["SRV"].startswith("http://127.0.0.1:")
        assert "取り込み済み 1 件" in result.stderr
        assert "nx-cache-server: GET hit=0 miss=0 PUT=0" in result.stderr


@allure.title("tests 以外の part では、保存先を指定してもキャッシュを使わない")
def test_other_parts_with_nx_cache_skip_the_cache(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path
) -> None:
    """`--part=lint` で `PECOT_CI_NX_CACHE` に保存先を指定した場合のテストです。どの stage でも `NX_SKIP_NX_CACHE` が `true` のままで、サーバの URL が渡されず、Summary にキャッシュの行が表示されないことを確認します。"""
    result = pr_repo.run(
        run_script,
        "--part=lint",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    with allure.step("tests 以外の part でキャッシュを使わないことを確かめる"):
        assert result.returncode == 0, result.stderr
        for call in pr_repo.calls():
            assert call["NXC"] == "true"
            assert call["SRV"] == "unset"
            assert call["NXCF"] == "unset"
        assert "キャッシュ:" not in result.stdout


@allure.title("tests の part でも、保存先を指定しなければキャッシュを使わない")
def test_tests_part_without_nx_cache_skips_the_cache(pr_repo: _PrChecksRepo, run_script) -> None:
    """`PECOT_CI_NX_CACHE` を指定せずに `--part=tests` で実行した場合のテストです。manual の stage で `NX_SKIP_NX_CACHE` が `true` になり、サーバの URL が渡されず、Summary にキャッシュの行が表示されないことを確認します。"""
    result = pr_repo.run(run_script, "--part=tests", pr_repo.base, pr_repo.head)
    call = _manual_call(pr_repo)
    with allure.step("保存先が無いとキャッシュを使わないことを確かめる"):
        assert (call["NXC"], call["SRV"], call["NXCF"]) == ("true", "unset", "unset")
        assert "キャッシュ:" not in result.stdout


@allure.title(
    "保存先を作れずにサーバを起動できない場合は、警告を表示して、従来どおりキャッシュを使わない"
)
def test_server_start_failure_falls_back_to_skip(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path
) -> None:
    """保存先のパスの途中がファイルになっていて、ディレクトリを作成できない場合のテストです。警告が表示されるものの終了コードは 0 のままで、manual の stage ではキャッシュを使わない設定になることを確認します。"""
    blocker = tmp_path / "blocker"
    blocker.write_text("file\n")
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(blocker / "nx-remote")},
    )
    with allure.step("終了コードと警告とキャッシュを使わないことを確かめる"):
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


@allure.title(
    "キャッシュの取り込み元の記録が変わると、Summary のキャッシュの行は「{expected}」になる"
)
@pytest.mark.parametrize(("source", "expected"), _SOURCE_CASES)
def test_summary_reports_nx_cache_source(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path, source: str | None, expected: str
) -> None:
    """取り込み元の記録が、取り込みあり・取り込みなし・記録なしのそれぞれの場合のテストです。Summary のキャッシュの行に、run の番号や理由を含む期待どおりの文が表示されることを確認します。"""
    if source is not None:
        _write_source(pr_repo, source)
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    with allure.step("Summary に nx のキャッシュの出どころが出ることを確かめる"):
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


@allure.title("node が存在しない場合は、警告を表示して、キャッシュを使わずに実行する")
def test_missing_node_falls_back_to_skip(
    pr_repo: _PrChecksRepo, run_script, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`PATH` から `node` を取り除いて実行した場合のテストです。標準エラー出力に警告が表示され、終了コードは 0 のままで、manual の stage ではキャッシュを使わない設定になることを確認します。"""
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
    with allure.step("終了コードと警告とキャッシュを使わないことを確かめる"):
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


@allure.title(
    "サーバが port を書かない場合（{mode}）は、待ち切って止め、キャッシュを使わずに実行する"
)
@pytest.mark.parametrize("mode", ["silent", "exit-before-port"])
def test_server_without_port_falls_back_to_skip(
    pr_repo: _PrChecksRepo,
    run_script,
    mock_bin,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    mode: str,
) -> None:
    """サーバが port を書かずに待ち続ける場合と、port を書く前に終了する場合のテストです。待機の上限に達すると警告が表示され、サーバのプロセスが残らず、manual の stage ではキャッシュを使わない設定になることを確認します。"""
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
    with allure.step("終了コードと警告とキャッシュを使わないことを確かめる"):
        assert result.returncode == 0, result.stderr
        assert "WARN: nx のキャッシュサーバが起動しませんでした" in result.stderr
        call = _manual_call(pr_repo)
        assert (call["NXC"], call["SRV"]) == ("true", "unset")
        if pid_file.exists():
            assert not _pid_alive(pid_file)


@allure.title("manual の stage の前にサーバが終了していた場合は、キャッシュを使わずに実行する")
def test_server_dead_before_manual_stage_falls_back_to_skip(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """起動の直後にサーバが終了する場合のテストです。nx がつながらずに task が失敗するのを避けるため、manual の前に生存を確認して、キャッシュを使わない設定になり、標準エラー出力にサーバが落ちている旨が表示されることを確認します。"""
    _install_fake_node(mock_bin, monkeypatch, tmp_path, "exit")
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    with allure.step("終了コードと警告とキャッシュを使わないことを確かめる"):
        assert result.returncode == 0, result.stderr
        call = _manual_call(pr_repo)
        assert (call["NXC"], call["SRV"]) == ("true", "unset")
        assert "キャッシュサーバが落ちている" in result.stderr


@allure.title("stage の実行中にスクリプトが SIGTERM を受けた場合も、trap でサーバを停止する")
def test_server_is_stopped_by_trap_when_script_is_terminated(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """manual の stage で、スクリプトの親プロセスに SIGTERM が送られる場合のテストです。終了コードが 0 以外になり、サーバのプロセスが残らず、完了の印が書かれることを確認します。"""
    pid_file = _install_fake_node(mock_bin, monkeypatch, tmp_path)
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote"), "STUB_KILL_PARENT_STAGE": "manual"},
    )
    with allure.step("終了コードとサーバが止まったことと完了の印を確かめる"):
        assert result.returncode != 0
        assert pid_file.exists()
        assert not _pid_alive(pid_file)
        assert pr_repo.done().exists()


@allure.title("stage が失敗した場合も、サーバを停止する")
def test_failed_stage_stops_the_server(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """manual の stage が失敗した場合のテストです。終了コードが 1 になり、起動したサーバのプロセスが残らないことを確認します。"""
    pid_file = _install_fake_node(mock_bin, monkeypatch, tmp_path)
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote"), "STUB_FAIL_STAGE": "manual"},
    )
    with allure.step("終了コードとサーバが止まったことを確かめる"):
        assert result.returncode == 1
        assert not _pid_alive(pid_file)


@allure.title(
    "upload 用の場所には、`nx-used.txt` に書かれた hash の成果物だけをコピーし、hash は英数字だけを受け付ける"
)
def test_upload_dir_holds_only_used_artifacts(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`nx-used.txt` に、実在する hash、存在しない hash、`../evil` のような不正な hash が並んでいる場合のテストです。upload 用の場所に、使われた 2 つの成果物と `tested-tree.txt` だけが入り、自分の tree の値が書かれることを確認します。"""
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
    with allure.step("終了コードと上げる場所に使った成果物だけが写ることを確かめる"):
        assert result.returncode == 0, result.stderr
        upload = pr_repo.repo / ".pecot" / "tmp" / "ci" / "nx-upload"
        assert sorted(p.name for p in upload.iterdir()) == [
            "abc1.tar.gz",
            "def2.tar.gz",
            "tested-tree.txt",
        ]
        assert (upload / "abc1.tar.gz").read_bytes() == b"abc1"
        own_tree = run_attached(
            ["git", "rev-parse", "HEAD^{tree}"], cwd=pr_repo.repo, capture_output=True, text=True
        ).stdout.strip()
        assert read_output(upload / "tested-tree.txt").strip() == own_tree


@allure.title("サーバには、`--used-file` として CI の作業用ディレクトリの `nx-used.txt` を渡す")
def test_server_receives_used_file_path(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`--part=tests` でキャッシュを使う場合のテストです。サーバの起動の引数に、`.pecot/tmp/ci/nx-used.txt` を指す `--used-file` が含まれることを確認します。"""
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
    with allure.step("サーバに使ったキーのファイルの path が渡ることを確かめる"):
        assert f"--used-file={used}" in read_output(args_file)


@allure.title("サーバが一覧を書かなかった場合は、取り込み済みの成果物も upload しない")
def test_upload_dir_is_empty_without_used_file(
    pr_repo: _PrChecksRepo, run_script, mock_bin, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """サーバが `nx-used.txt` を書かずに終了する場合のテストです。保存先に成果物があっても、upload 用の場所が空のままになることを確認します。"""
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
    with allure.step("上げる場所が空であることを確かめる"):
        assert list(upload.iterdir()) == []


@allure.title(
    "キャッシュの入力（取り込み元と自分の tree、lock の hash、apt の一覧の hash）を、ログと Summary に 1 行ずつ表示する"
)
def test_cache_inputs_are_logged_and_summarized(
    pr_repo: _PrChecksRepo, run_script, git_rev_parse, tmp_path: Path
) -> None:
    """キャッシュの入力を記録するテストです。取り込み元と自分の tree、lock の hash が標準エラー出力と Summary に表示され、apt の一覧の hash の行は 1 行だけであることを確認します。"""
    (pr_repo.repo / "pnpm-lock.yaml").write_text("lock\n")
    own_tree = git_rev_parse(pr_repo.repo, "HEAD^{tree}")
    lock_hash = run_attached(
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
    with allure.step(
        "取り込み元の tree と lock の hash と apt の一覧の hash がログと Summary に出ることを確かめる"
    ):
        for line in expected:
            assert line in result.stderr.splitlines()
            assert f"- {line}" in result.stdout.splitlines()
        deb = [ln for ln in result.stdout.splitlines() if "apt のパッケージ一覧の hash" in ln]
        assert len(deb) == 1
        assert (
            len([ln for ln in result.stderr.splitlines() if "apt のパッケージ一覧の hash" in ln])
            == 1
        )


@allure.title(
    "取り込んだ `tested-tree.txt` と lock が存在しない場合は、キャッシュの入力に `-` を表示する"
)
def test_cache_inputs_use_dash_without_sources(
    pr_repo: _PrChecksRepo, run_script, tmp_path: Path
) -> None:
    """取り込み元の `tested-tree.txt` と `pnpm-lock.yaml` が存在しない場合のテストです。Summary のキャッシュの入力の行で、該当する値が `-` と表示されることを確認します。"""
    result = pr_repo.run(
        run_script,
        "--part=tests",
        pr_repo.base,
        pr_repo.head,
        env={"PECOT_CI_NX_CACHE": str(tmp_path / "nx-remote")},
    )
    with allure.step("キャッシュの入力が「-」で出ることを確かめる"):
        assert "- キャッシュの入力: pnpm-lock.yaml の hash -" in result.stdout.splitlines()
        assert any(
            ln.startswith("- キャッシュの入力: 取り込み元の tree -、自分の tree ")
            for ln in result.stdout.splitlines()
        )


@allure.title("`PECOT_CI_NX_CACHE` を指定しない場合は、キャッシュの入力の行を表示しない")
def test_cache_inputs_absent_without_nx_cache(pr_repo: _PrChecksRepo, run_script) -> None:
    """`PECOT_CI_NX_CACHE` を指定せずに `--part=tests` で実行した場合のテストです。標準出力と標準エラー出力のどちらにも、キャッシュの入力の行が表示されないことを確認します。"""
    result = pr_repo.run(run_script, "--part=tests", pr_repo.base, pr_repo.head)
    with allure.step("キャッシュの入力の行が出ないことを確かめる"):
        assert "キャッシュの入力" not in result.stdout + result.stderr


@allure.title("リモートキャッシュにつながらない場合は、実 nx が task を実行せずに失敗する")
def test_nx_fails_the_task_when_remote_cache_is_unreachable(tmp_path: Path) -> None:
    """誰も待ち受けない port をリモートキャッシュとして指定し、実際の `nx` を起動する場合のテストです。task が実行されずに失敗する一方で、`NX_SKIP_NX_CACHE` を指定した場合は task が実行されて成功することを確認します。`node_modules/.bin/nx` が存在しない場合は skip します。"""
    with allure.step(
        "実 nx の一時のワークスペースを用意して、待ち受けの無い remote cache へ向けて動かす"
    ):
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
        result = run_attached(
            [str(nx_bin), "run", "p:tgt"],
            cwd=ws,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
    with allure.step("task が失敗し、skip を付けると通ることを確かめる"):
        assert result.returncode != 0
        assert "Failed to send request" in result.stdout + result.stderr
        assert not (ws / "ran-the-task").exists()

        env["NX_SKIP_NX_CACHE"] = "true"
        for key in (
            "NX_SELF_HOSTED_REMOTE_CACHE_SERVER",
            "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN",
        ):
            env.pop(key)
        skipped = run_attached(
            [str(nx_bin), "run", "p:tgt"],
            cwd=ws,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert skipped.returncode == 0, skipped.stderr
        assert (ws / "ran-the-task").exists()


@allure.title("`--lane` を指定した場合も、Summary に範囲・レーン・失敗・skip・環境の欄を表示する")
def test_lane_option_emits_summary_with_environment(pr_repo: _PrChecksRepo, run_script) -> None:
    """`--part=tests` と `--lane` を指定して実行した場合のテストです。Summary に 5 つの欄の見出しがすべて表示されることを確認します。"""
    result = pr_repo.run(run_script, "--part=tests", "--lane=a:test-b", pr_repo.base, pr_repo.head)
    with allure.step("終了コードと Summary の欄を確かめる"):
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


@allure.title(
    "レーンの表には、開始より後ろの task の行のうち、target が `test-*` のものだけを表示する"
)
def test_lane_table_reads_only_rows_after_start(pr_repo: _PrChecksRepo, run_script) -> None:
    """所要時間の記録に、開始前の行と、install や起点の `test` の行が並んでいる場合のテストです。開始後の `test-*` の task だけが成功と失敗の状態つきで表示され、それ以外の行は含まれないことを確認します。"""
    pr_repo.tsv().parent.mkdir(parents=True)
    pr_repo.tsv().write_text(_TSV_OLD)
    result = pr_repo.run(
        run_script, env={"STUB_TSV_APPEND": str(pr_repo.write("tsv-new", _TSV_NEW))}
    )
    with allure.step("終了コードとレーンの表が開始後の test の行だけであることを確かめる"):
        assert result.returncode == 0, result.stderr

        out = result.stdout
        assert "| proj-a:test-cli | 成功 | 12.3s |" in out
        assert "| proj-b:test-unit:ci | 失敗 | 4.0s |" in out
        assert "old-project" not in out
        assert "proj-a:install" not in out
        assert "proj-a:test |" not in out
        assert "対象なし（成功）" not in out


@allure.title("`test-*` の task の行が 0 件の場合は、「対象なし（成功）」と表示する")
def test_lane_table_without_lanes(pr_repo: _PrChecksRepo, run_script) -> None:
    """開始後の task の行が存在しない場合のテストです。レーンの欄に、「対象なし（成功）」と表示されることを確認します。"""
    pr_repo.tsv().parent.mkdir(parents=True)
    pr_repo.tsv().write_text(_TSV_OLD)
    result = pr_repo.run(run_script)
    with allure.step("レーンの表が「対象なし」になることを確かめる"):
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


@allure.title("失敗の欄には、nx のログの `Failed tasks:` 以降のレーンを、重複を除いて表示する")
def test_failure_section_lists_failed_lanes(pr_repo: _PrChecksRepo, run_script) -> None:
    """同じレーンが 2 回現れる失敗のログを渡した場合のテストです。失敗の欄に、失敗した 2 つのレーンが 1 回ずつ表示され、`ci-logs` の artifact の案内が含まれることを確認します。"""
    result = pr_repo.run(
        run_script, env={"STUB_NX_LOG_SRC": str(pr_repo.write("nx-failed.log", _NX_LOG_FAILED))}
    )
    out = result.stdout
    with allure.step("失敗の欄が失敗したレーンを重複なしで出すことを確かめる"):
        assert "- proj-a:test-cli\n- proj-b:test-unit\n" in out
        assert out.count("- proj-a:test-cli") == 1
        assert "artifact `ci-logs`" in out
        assert "=== 失敗レーン: ... ===" in out


@allure.title("この run で書かれていない古いログの失敗は、失敗の欄に表示しない")
def test_failure_section_ignores_log_from_earlier_run(pr_repo: _PrChecksRepo, run_script) -> None:
    """以前の実行で残った、失敗を含む nx のログがある場合のテストです。失敗の欄が「なし」になり、古いログのレーンが表示されないことを確認します。"""
    log = pr_repo.repo / ".pecot" / "tmp" / "pre-push" / "nx-affected-tests.log"
    log.parent.mkdir(parents=True)
    log.write_text(_NX_LOG_FAILED)
    result = pr_repo.run(run_script)
    with allure.step("古いログの失敗が失敗の欄に出ないことを確かめる"):
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


@allure.title(
    "skip の件数は、レーンごとに、vitest と pytest の要約の行を、task の塊の中だけで合計する"
)
def test_skip_counts_per_lane(pr_repo: _PrChecksRepo, run_script) -> None:
    """vitest の `Tests` の行と pytest の要約の行が、複数の task の塊に含まれる場合のテストです。同じレーンの塊は合計され、`Test Files` の行や `test-*` ではない target の塊は数えられないことを確認します。"""
    result = pr_repo.run(
        run_script, env={"STUB_NX_LOG_SRC": str(pr_repo.write("nx-skips.log", _NX_LOG_SKIPS))}
    )
    out = result.stdout
    with allure.step("レーンごとの skip の件数を確かめる"):
        # proj-a:test-cli は 2 つの塊の合計（2 + 3 + 1）。Test Files 行は数えない。
        assert "| proj-a:test-cli | 6 |" in out
        # proj-b:test-unit は pytest の 2 形式の合計（4 + 2）。NX 行の後ろは数えない。
        assert "| proj-b:test-unit | 6 |" in out
        # test-* でない target の塊は数えない。
        assert "proj-a:install" not in out.split("### skip")[1]


@allure.title("nx のログがない場合は、skip の欄を「なし」と表示する")
def test_skip_section_without_log(pr_repo: _PrChecksRepo, run_script) -> None:
    """nx のログが存在しない場合のテストです。Summary の skip の欄が、「なし」と表示されることを確認します。"""
    result = pr_repo.run(run_script)
    with allure.step("ログが無いと skip の欄が「なし」になることを確かめる"):
        assert "### skip\n\nなし" in result.stdout


@allure.title("成功した場合も完了の印を書き、開始時に古い印を消す")
def test_done_marker_written_on_success_and_replaces_stale(
    pr_repo: _PrChecksRepo, run_script
) -> None:
    """完了の印に古い値が残っている状態で、成功する実行をした場合のテストです。終了コードが 0 になり、完了の印が古い値ではなく 0 に書き換わることを確認します。"""
    pr_repo.done().parent.mkdir(parents=True)
    pr_repo.done().write_text("9\n")
    result = pr_repo.run(run_script)
    with allure.step("終了コードと完了の印が新しくなることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert read_output(pr_repo.done()).strip() == "0"


@allure.title(
    "`PECOT_CI_SUMMARY` を指定すると、親ディレクトリを作ってファイルに上書きし、標準出力には表示しない"
)
def test_summary_goes_to_file_when_set(pr_repo: _PrChecksRepo, run_script) -> None:
    """`PECOT_CI_SUMMARY` に、まだ存在しないディレクトリの中のパスを指定した場合のテストです。Summary がそのファイルに書かれ、標準出力には表示されず、既存の内容が上書きされることを確認します。"""
    summary = pr_repo.tmp / "deep" / "dir" / "summary.md"
    result = pr_repo.run(run_script, env={"PECOT_CI_SUMMARY": str(summary)})
    with allure.step("終了コードと Summary のファイルの内容と上書きを確かめる"):
        assert result.returncode == 0, result.stderr
        text = read_output(summary)
        assert "### 範囲" in text
        assert "### レーン" in text
        assert "### 失敗" in text
        assert "### skip" in text
        assert "### 環境" in text
        assert "### 範囲" not in result.stdout

        summary.write_text("stale\n")
        pr_repo.run(run_script, env={"PECOT_CI_SUMMARY": str(summary)})
        assert "stale" not in read_output(summary)


@allure.title("`PECOT_CI_SUMMARY` を指定しない場合は、Summary を標準出力に表示する")
def test_summary_goes_to_stdout_when_unset(pr_repo: _PrChecksRepo, run_script) -> None:
    """`PECOT_CI_SUMMARY` を指定せずに実行した場合のテストです。標準出力に Summary の見出しが表示されることを確認します。"""
    result = pr_repo.run(run_script)
    with allure.step("Summary が標準出力に出ることを確かめる"):
        assert "## 検証の結果" in result.stdout


@allure.title("環境の欄には、イメージ名と各ツールの版の 1 行目を表示する")
def test_environment_section(pr_repo: _PrChecksRepo, run_script, mock_bin) -> None:
    """`PECOT_CI_IMAGE` を指定し、複数行を出力する偽の `actionlint` を用意した場合のテストです。イメージ名と、ツールの版が 1 行目だけ表示され、2 行目以降は含まれないことを確認します。"""
    mock_bin.install("actionlint", "echo 'actionlint-1.2.3'\necho second-line\n")
    result = pr_repo.run(run_script, env={"PECOT_CI_IMAGE": "ghcr.io/example/image:tag"})
    out = result.stdout
    with allure.step("環境の欄のイメージ名とツールの版を確かめる"):
        assert "- イメージ: ghcr.io/example/image:tag" in out
        assert "- actionlint: actionlint-1.2.3" in out
        assert "second-line" not in out
        assert "- node: " in out


@allure.title("`PECOT_CI_IMAGE` を指定しない場合は、イメージを `-` と表示する")
def test_environment_section_defaults(pr_repo: _PrChecksRepo, run_script) -> None:
    """`PECOT_CI_IMAGE` を指定せずに実行した場合のテストです。環境の欄のイメージの行が、`-` と表示されることを確認します。"""
    result = pr_repo.run(run_script)
    with allure.step("イメージが「-」になることを確かめる"):
        assert "- イメージ: -\n" in result.stdout


@allure.title("引数が {args} のように不足している場合は、使い方を表示して終了コード 2 で終了する")
@pytest.mark.parametrize("args", [(), ("only-base",), ("", "head")])
def test_missing_arguments_exit_2(pr_repo: _PrChecksRepo, run_script, args: tuple) -> None:
    """引数がない場合と、base だけの場合と、base が空文字列の場合のテストです。終了コードが 2 になり、標準エラー出力に使い方が表示され、`pre-commit` が呼ばれないことを確認します。"""
    result = run_script(
        pr_repo.script, *args, cwd=pr_repo.repo, env={"STUB_PC_LOG": str(pr_repo.pc_log)}
    )
    with allure.step("終了コード 2 と使い方の出力と pre-commit が呼ばれないことを確かめる"):
        assert result.returncode == 2
        assert "使い方" in result.stderr
        assert read_output(pr_repo.pc_log) == ""


@allure.title("`PECOT_PRE_COMMIT` を指定すると、その実行ファイルを `pre-commit` として使う")
def test_explicit_pre_commit_env(pr_repo: _PrChecksRepo, run_script, mock_bin) -> None:
    """`PECOT_PRE_COMMIT` に別名の実行ファイルを指定した場合のテストです。指定した実行ファイルが 3 つの stage の順に呼ばれ、終了コードが 0 になることを確認します。"""
    other = mock_bin.install("other-pre-commit", _PRE_COMMIT_STUB)
    result = pr_repo.run(run_script, env={"PECOT_PRE_COMMIT": str(other)})
    with allure.step("終了コードと明示した pre-commit で stage が呼ばれることを確かめる"):
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


@allure.title("base を解決できない場合は、`run-affected-tests.sh` が全 project の run-many を呼ぶ")
def test_unresolvable_base_falls_back_to_run_many(
    git_repo: Callable[..., Path],
    git,
    git_rev_parse,
    tmp_path: Path,
    script_dir: Path,
    run_script,
    nx_stub_graph_branch: Callable[[dict, dict], str],
) -> None:
    """`run-pr-checks.sh` が全レーンのモードで渡す環境変数を、`run-affected-tests.sh` に指定した場合のテストです。`nx run-many -t test` が呼ばれて `affected` は呼ばれず、`refs/pecot/ci-no-base` の参照が残らないことを確認します。"""
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
    with allure.step("終了コードと run-many で動き affected を使わないことを確かめる"):
        assert result.returncode == 0, result.stderr

        log = read_output(nx_log)
        assert "run-many -t test" in log
        assert "affected" not in log
        assert (
            run_attached(
                ["git", "rev-parse", "--verify", "--quiet", "refs/pecot/ci-no-base"],
                cwd=repo,
                capture_output=True,
            ).returncode
            != 0
        )


# --- finish-ci-summary.sh（ホストの runner で Summary を書き写す） ---


def _run_finish(githooks_dir: Path, work: Path, outcome: str) -> subprocess.CompletedProcess:
    summary = work / "summary.md"
    return run_attached(
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


@allure.title("完了の印が 0 の場合は、Summary を書き写して終了コード 0 で終了する")
def test_finish_copies_summary_and_passes_on_done_0(githooks_dir: Path, tmp_path: Path) -> None:
    """`finish-ci-summary.sh` を、完了の印が 0 で outcome が成功の状態で実行した場合のテストです。終了コードが 0 になり、CI の Summary のファイルに元の内容が書き写されることを確認します。"""
    with allure.step("完了の印が 0 の状態で完了処理を動かす"):
        _write_ci_files(tmp_path, summary="## 検証の結果\n", done="0\n")
        result = _run_finish(githooks_dir, tmp_path, "success")
    with allure.step("終了コードと Summary がコピーされることを確かめる"):
        assert result.returncode == 0
        assert read_output(tmp_path / "summary.md") == "## 検証の結果\n"


@allure.title("完了の印が 0 以外の場合は、終了コード 1 で終了する")
def test_finish_fails_on_nonzero_done(githooks_dir: Path, tmp_path: Path) -> None:
    """`finish-ci-summary.sh` を、完了の印が 1 の状態で実行した場合のテストです。outcome が成功でも、終了コードが 1 になることを確認します。"""
    with allure.step("完了の印が 0 でない状態を用意する"):
        _write_ci_files(tmp_path, summary="x\n", done="1\n")
    with allure.step("完了処理の終了コードが 1 になることを確かめる"):
        assert _run_finish(githooks_dir, tmp_path, "success").returncode == 1


@allure.title(
    "完了の印がない場合は、検証が完了していないと Summary に書き、終了コード 1 で終了する"
)
def test_finish_fails_without_done_marker(githooks_dir: Path, tmp_path: Path) -> None:
    """`finish-ci-summary.sh` を、完了の印と Summary がどちらも存在しない状態で実行した場合のテストです。終了コードが 1 になり、Summary に検証が完了していない旨が書かれることを確認します。"""
    with allure.step("完了の印が無い状態で完了処理を動かす"):
        _write_ci_files(tmp_path, summary=None, done=None)
        result = _run_finish(githooks_dir, tmp_path, "success")
    with allure.step("終了コード 1 と「検証が完了していない」の Summary を確かめる"):
        assert result.returncode == 1
        assert "検証が完了していない" in read_output(tmp_path / "summary.md")


@allure.title("outcome が失敗の場合は、基盤の失敗と Summary に書き、終了コード 1 で終了する")
def test_finish_reports_infra_failure(githooks_dir: Path, tmp_path: Path) -> None:
    """`finish-ci-summary.sh` を、outcome が失敗で完了の印がない状態で実行した場合のテストです。終了コードが 1 になり、Summary に基盤の失敗である旨が書かれることを確認します。"""
    with allure.step("基盤が失敗した状態で完了処理を動かす"):
        _write_ci_files(tmp_path, summary=None, done=None)
        result = _run_finish(githooks_dir, tmp_path, "failure")
    with allure.step("終了コード 1 と「基盤の失敗」の Summary を確かめる"):
        assert result.returncode == 1
        assert "基盤の失敗" in read_output(tmp_path / "summary.md")


@allure.title("基盤の失敗の場合は、Summary にイメージ名も書く")
def test_finish_reports_image_on_infra_failure(githooks_dir: Path, tmp_path: Path) -> None:
    """`finish-ci-summary.sh` を、outcome が失敗で、`PECOT_CI_IMAGE` を指定した状態で実行した場合のテストです。終了コードが 1 になり、Summary にイメージ名の行が含まれることを確認します。"""
    with allure.step("基盤が失敗した状態で、イメージ付きで完了処理を動かす"):
        _write_ci_files(tmp_path, summary=None, done=None)
        result = run_attached(
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
    with allure.step("終了コード 1 と Summary のイメージを確かめる"):
        assert result.returncode == 1
        assert "- イメージ: img:def-abc@sha256:123" in read_output(tmp_path / "summary.md")
