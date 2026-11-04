"""run-affected-tests.sh のユニットテスト（test_run_affected_tests.bats 移植）。

hook は base/head を共有 lib（lib/push-range.sh）で解決し、tip ごとに repo root で affected を実行する。
実行するコマンドは、このドキュメント末尾に示す。
レーン名（`test-*` の target 名）は `nx graph --file` の JSON から集める（lib/nx-lanes.sh、#1232）。
判定不能時は `nx run-many -t test --parallel=4 --nxBail` へフォールバックする。
push range にパッケージマネージャガードの対象ファイルが含まれるかで、PECOTV_PM_GUARD_BEHAVIOR を 1 / 0 に決める。
その値を nx へ export する（#1080）。
nx の出力は端末でなく `<repo_root>/.pecot/tmp/pre-push/nx-affected-tests.log` へ書く。
失敗時だけ、要約の `Failed tasks:` に載った project の行を stderr へ出す（#1079）。
nx は `NX_PROFILE=.pecot/tmp/pre-push/nx-profile.json`（repo root 相対）付きで起動する。
profile の task 所要は、`<repo_root>/.pecot/tmp/githooks-timing.tsv` へ task 行・nx 行として追記する。
成功 push では、合計秒・最長 test task・並列度・レーン数の 1 行を stdout へ出す（#1083）。

bats の temp repo は実 nx ワークスペースではない。
そのため、PATH 先頭ではなく repo の node_modules/.bin に記録型 nx スタブを置く。
スタブは全引数を記録ファイル（$STUB_NX_LOG）へ 1 呼び出し 1 行で追記する。
終了コードは環境変数 STUB_NX_EXIT の値で決める（既定 0）。
GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する。

bats 版 setup は PRE_COMMIT_FROM_REF / PRE_COMMIT_TO_REF / PECOT_VERSION_PLAN_BASE を unset していた。
collect_push_tips は env を stdin より優先する。
そのため、継承されたままだと env なし前提のケースが成立しない。
pytest 版は _clean_push_env autouse で同等にする。

実行するコマンドは次のとおり。
  nx affected -t <test レーン名の列挙> --base=<from> --head=<to>
    --parallel=4 --nxBail --output-style=stream
"""

from __future__ import annotations

import re
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

_ZERO_SHA = "0000000000000000000000000000000000000000"

# 記録型 nx スタブ。
# 全引数を 1 行で $STUB_NX_LOG へ追記する。
# 続けて、受け取った PECOTV_PM_GUARD_BEHAVIOR と NO_COLOR を 1 行ずつ記録する（未設定は "unset"）。
# stdout には、nx の `--output-style=stream` 形式の疑似出力を 2 レーン分流す。
# 形式は、`> nx run <project>:<target>` ヘッダ + `<project>: ` 接頭辞の本文 + 末尾要約。
# 並列実行どおり、2 レーンの本文は交互に混在させる。
# 終了コードは STUB_NX_EXIT で決める。要約の字下げは実 nx に合わせて列 0。
#
# 呼び出し回数は $STUB_NX_LOG.calls に持ち、本文へ `CALL<n>_BODY` を混ぜる。
# 複数 tip の push で「今回の nx 実行分」だけが報告されることを検証するため。
# 挙動を変える env は次のとおり。
#   STUB_NX_EXIT           : 終了コード（既定 0）。
#   STUB_NX_FAIL_ON_CALL   : この回だけ STUB_NX_EXIT で終わり、他の回は 0。
#   STUB_NX_NO_SUMMARY     : 要約を出さずに終わる（task 開始前に終了した nx）。
#   STUB_NX_SUMMARY_NO_TASKS : 要約に `Failed tasks:` を出さず、要約の後ろへレーン出力を続ける。
#   STUB_NX_FAILED_TWO     : `Failed tasks:` へ 2 レーン（lane-two → lane-one の順）を載せる。
#   STUB_NX_DOTS           : 失敗レーンの本文へ進捗ドット行を N 行入れる。
#   STUB_NX_WIDE           : 失敗レーンの本文へ 48 KiB 級のマルチバイト行を 3 行入れる。
#   STUB_NX_NO_PROFILE     : NX_PROFILE があっても profile を書かない。
#   STUB_NX_EMPTY_PROFILE  : profile に空配列を書く（affected 0 件の nx）。
#   STUB_NX_BROKEN_PROFILE : profile に途中までの JSON を書く（nx 中断時）。
#   STUB_NX_NEGATIVE_DUR   : lane-one:test-unit の dur を負にする（壁時計差が負になった nx）。
#   STUB_NX_CONFIGURED     : lane-two:test-unit を configuration 付き task にする。
#                            task id は `lane-two:test-unit:ci`、args.target.target は test-unit。
#   STUB_NX_SAME_PROJECT   : lane-two:test-unit を lane-one:test-hooks にする。
#                            lane-one:test-unit と同じ project の別レーン。
#   STUB_NX_AGGREGATOR     : レーンを束ねる起点 lane-one:test（nx:noop）を 9.0s で足す。
#   STUB_NX_CALL2_LONGER   : 2 回目の呼び出しだけ lane-one:test-unit の dur を 4.0s にする。
#
# NX_PROFILE があれば、実 nx と同じく cwd 基準（`path.join(cwd, 値)`）で解決したパスへ trace JSON を書く。
# 中身はメタ行 1 本と task 3 本で、dur はマイクロ秒。
# task は lane-two:install 3.0s / lane-one:test-unit 1.5s / lane-two:test-unit 2.5s の 3 本。
# install を test より長くして、install が最長判定に混入する退行を検出できるようにする。
# 末尾に nx が書く `Performance Profile: <path>` 行は、失敗時の出力にも載せる。
# status は、成功時は success。
# 失敗時（rc が非 0）は、lane-two:test-unit だけ failure。
_NX_STUB_BODY = """#!/bin/bash
@@GRAPH_BRANCH@@printf '%s\\n' "$*" >> "$STUB_NX_LOG"
printf 'ENV PECOTV_PM_GUARD_BEHAVIOR=%s\\n' "${PECOTV_PM_GUARD_BEHAVIOR-unset}" >> "$STUB_NX_LOG"
printf 'ENV NO_COLOR=%s\\n' "${NO_COLOR-unset}" >> "$STUB_NX_LOG"

calls_file="$STUB_NX_LOG.calls"
call_n=$(( $(cat "$calls_file" 2>/dev/null || echo 0) + 1 ))
echo "$call_n" > "$calls_file"

rc="${STUB_NX_EXIT:-0}"
if [ -n "${STUB_NX_FAIL_ON_CALL:-}" ] && [ "$call_n" != "$STUB_NX_FAIL_ON_CALL" ]; then
    rc=0
fi

if [ -n "${NX_PROFILE:-}" ] && [ -z "${STUB_NX_NO_PROFILE:-}" ]; then
    profile="$PWD/${NX_PROFILE#/}"
    mkdir -p "$(dirname "$profile")"
    if [ -n "${STUB_NX_EMPTY_PROFILE:-}" ]; then
        echo '[]' > "$profile"
    elif [ -n "${STUB_NX_BROKEN_PROFILE:-}" ]; then
        printf '[{"name":' > "$profile"
    else
        two_status=success
        [ "$rc" -ne 0 ] && two_status=failure
        one_dur=1500000
        [ -n "${STUB_NX_NEGATIVE_DUR:-}" ] && one_dur=-1500000
        [ -n "${STUB_NX_CALL2_LONGER:-}" ] && [ "$call_n" = 2 ] && one_dur=4000000
        two_id=lane-two:test-unit
        two_target=
        if [ -n "${STUB_NX_CONFIGURED:-}" ]; then
            two_id=lane-two:test-unit:ci
            two_target='"target":{"project":"lane-two","target":"test-unit","configuration":"ci"},'
        fi
        if [ -n "${STUB_NX_SAME_PROJECT:-}" ]; then
            two_id=lane-one:test-hooks
            two_target='"target":{"project":"lane-one","target":"test-hooks"},'
        fi
        cat > "$profile" <<PROFILE
[{"name":"thread_name","ph":"M","pid":1,"tid":0,"ts":0,"args":{"name":"Group #1"}},
{"name":"lane-two:install","ph":"X","ts":1000,"dur":3000000,"pid":1,"tid":0,"args":{"status":"success"}},
{"name":"lane-one:test-unit","ph":"X","ts":2000,"dur":$one_dur,"pid":1,"tid":0,"args":{"status":"success"}},
{"name":"$two_id","ph":"X","ts":3000,"dur":2500000,"pid":1,"tid":0,"args":{$two_target"status":"$two_status"}}]
PROFILE
        if [ -n "${STUB_NX_AGGREGATOR:-}" ]; then
            sed -i 's/}]$/},{"name":"lane-one:test","ph":"X","ts":4000,"dur":9000000,"pid":1,"tid":0,"args":{"status":"success"}}]/' "$profile"
        fi
    fi
fi

if [ -n "${STUB_NX_NO_SUMMARY:-}" ]; then
    echo "NO_SUMMARY_BODY: simulates nx exiting before task start"
    echo "Cannot find configuration for task"
    exit "$rc"
fi

cat <<'STREAM'

> nx run lane-one:test-unit


> nx run lane-two:test-unit

lane-one: LANE_ONE_BODY ok
lane-two: LANE_TWO_BODY running
lane-one: passed
STREAM
printf 'lane-two: CALL%s_BODY call count marker\\n' "$call_n"

i=1
while [ "$i" -le "${STUB_NX_DOTS:-0}" ]; do
    printf 'lane-two: DOT%s .\\n' "$i"
    i=$((i + 1))
done

if [ -n "${STUB_NX_WIDE:-}" ]; then
    wide="\u3042"
    i=0
    while [ "$i" -lt 14 ]; do
        wide="$wide$wide"
        i=$((i + 1))
    done
    for i in 1 2 3; do
        printf 'lane-two: WIDE%s %s\\n' "$i" "$wide"
    done
fi

if [ "$rc" -eq 0 ]; then
    cat <<'OK'
lane-two: passed



 NX   Successfully ran target test for 2 projects
OK
    exit 0
fi

cat <<'NG'
lane-two: AssertionError: expected 1 to be 2
lane-one: LANE_ONE_TAIL still running when bail fired



 NX   Running target test for 2 projects failed

Tasks not run because their dependencies failed or --nx-bail=true:

- lane-three:test-unit

NG

if [ -n "${STUB_NX_SUMMARY_NO_TASKS:-}" ]; then
    echo "SUMMARY_MARKER_LINE: summary without failed projects"
    i=1
    while [ "$i" -le 100 ]; do
        printf 'lane-one: TRAILING%s\\n' "$i"
        i=$((i + 1))
    done
    echo "Performance Profile: $PWD/${NX_PROFILE-none}"
    exit "$rc"
fi

echo "Failed tasks:"
echo
echo "- lane-two:test-unit"
if [ -n "${STUB_NX_FAILED_TWO:-}" ]; then
    echo "- lane-one:test-unit"
fi
echo
echo "Performance Profile: $PWD/${NX_PROFILE-none}"
exit "$rc"
"""

# hook が nx 出力を書く固定パス（repo root 相対）。
_NX_LOG_RELPATH = Path(".pecot/tmp/pre-push/nx-affected-tests.log")


def _hook_log_path(h: _AffectedTestsRepo) -> Path:
    """hook が nx 出力を書くログの絶対パス（temp repo 配下）。

    スタブが引数を記録する `h.nx_log` とは別物なので名前で区別する。
    """
    return h.repo / _NX_LOG_RELPATH


@pytest.fixture(autouse=True)
def _clean_push_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """push 情報 env を除去して既定をクリーンにする（.bats setup の unset 相当）。"""
    for key in ("PRE_COMMIT_FROM_REF", "PRE_COMMIT_TO_REF", "PECOT_VERSION_PLAN_BASE"):
        monkeypatch.delenv(key, raising=False)


_NOOP = {"executor": "nx:noop"}
_RUN_SCRIPT = {"executor": "nx:run-script"}
# レーン名の収集（lib/nx-lanes.sh）が読む graph。起点の `test`（nx:noop）と package.json の scripts 由来（nx:run-script）は、名前が合っても集めない。
# 実体の `test` target はチェックの対象なので集める。
_GRAPH = {
    "graph": {
        "nodes": {
            "lane-one": {
                "data": {
                    "targets": {
                        "test": _NOOP,
                        "test-unit": {},
                        "test-hooks": {},
                        "test-postinstall": _RUN_SCRIPT,
                        "install": {},
                        "lint": {},
                        "lint-src": {},
                    }
                }
            },
            "lane-two": {
                "data": {
                    "targets": {
                        "test": _NOOP,
                        "test-unit": {},
                        "test-cli": {},
                        "build": {},
                    }
                }
            },
        }
    }
}
# 実体のレーンが 1 つも無い graph（起点と scripts 由来だけ）。
_GRAPH_NO_LANES = {
    "graph": {
        "nodes": {
            "lane-one": {"data": {"targets": {"test": _NOOP, "test-x": _RUN_SCRIPT, "build": {}}}}
        }
    }
}


class _AffectedTestsRepo:
    """run-affected-tests.sh テスト用の temp repo 操作ヘルパ。"""

    def __init__(self, repo: Path, nx_log: Path, git, git_rev_parse, nx_stub: str) -> None:
        self.repo = repo
        self.nx_stub = nx_stub
        self.nx_log = nx_log
        self._git = git
        self._git_rev_parse = git_rev_parse
        self.main_sha = git_rev_parse(repo, "HEAD")
        self.feature_sha: str | None = None
        self.from_sha: str | None = None

    def install_nx_stub(self) -> None:
        stub = self.repo / "node_modules" / ".bin" / "nx"
        stub.write_text(self.nx_stub)
        stub.chmod(0o755)

    def fake_remote_ref(self, ref: str, sha: str) -> None:
        self._git(self.repo, "update-ref", f"refs/remotes/origin/{ref}", sha)

    def fake_origin_head(self, ref: str) -> None:
        self._git(
            self.repo,
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            f"refs/remotes/origin/{ref}",
        )

    def build_feature_no_remote(
        self, branch: str = "feature", changed_path: str = "plugins/pecot-workflow/cli/probe.py"
    ) -> None:
        """feature ブランチを 1 commit 作って feature_sha を用意（origin/* は作らない）。

        changed_path は commit に含めるファイル。PECOTV_PM_GUARD_BEHAVIOR の判定は
        push range の変更ファイル名で決まるため、ケースごとに差し替える。
        """
        self._git(self.repo, "checkout", "-q", "-b", branch)
        target = self.repo / changed_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("probe\n")
        self._git(self.repo, "add", changed_path)
        self._git(self.repo, "commit", "-q", "-m", f"feat: {changed_path}")
        self.feature_sha = self._git_rev_parse(self.repo, "HEAD")

    def build_feature(self, changed_path: str = "plugins/pecot-workflow/cli/probe.py") -> None:
        """feature を作り origin/main・origin/HEAD を擬似生成（base 解決成功系）。"""
        self.build_feature_no_remote("feature", changed_path)
        self.from_sha = subprocess.run(
            ["git", "merge-base", self.main_sha, self.feature_sha],
            cwd=self.repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.fake_remote_ref("main", self.main_sha)
        self.fake_origin_head("main")


@pytest.fixture
def at_repo(
    git_repo: Callable[..., Path],
    git,
    git_rev_parse,
    tmp_path: Path,
    nx_stub_graph_branch: Callable[[dict, dict], str],
) -> _AffectedTestsRepo:
    """init/初期コミット済みの temp repo を構築して helper を返す（.bats setup 相当）。"""
    repo = git_repo("repo", initial_branch="main")
    (repo / "plugins" / "pecot-workflow" / "cli").mkdir(parents=True)
    (repo / "node_modules" / ".bin").mkdir(parents=True)
    (repo / "README.md").write_text("main\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-q", "-m", "chore: init")
    nx_log = tmp_path / "nx.log"
    nx_log.write_text("")
    nx_stub = _NX_STUB_BODY.replace(
        "@@GRAPH_BRANCH@@", nx_stub_graph_branch(_GRAPH, _GRAPH_NO_LANES)
    )
    return _AffectedTestsRepo(repo, nx_log, git, git_rev_parse, nx_stub)


def _add_second_feature(
    h: _AffectedTestsRepo, git, git_rev_parse, branch: str = "feature2"
) -> tuple[str, str]:
    """main から 2 本目の feature を分岐して (tip_sha, merge_base_sha) を返す。"""
    git(h.repo, "checkout", "-q", "main")
    git(h.repo, "checkout", "-q", "-b", branch)
    probe = h.repo / "plugins" / "pecot-workflow" / "cli" / f"probe_{branch}.py"
    probe.parent.mkdir(parents=True, exist_ok=True)
    probe.write_text(f"print('{branch}')\n")
    git(h.repo, "add", str(probe.relative_to(h.repo)))
    git(h.repo, "commit", "-q", "-m", f"feat(pecot-workflow): {branch}")
    tip_sha = git_rev_parse(h.repo, "HEAD")
    from_sha = subprocess.run(
        ["git", "merge-base", h.main_sha, tip_sha],
        cwd=h.repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return tip_sha, from_sha


def _run(script_dir: Path, h: _AffectedTestsRepo, run_script, **kwargs):
    env = {"STUB_NX_LOG": str(h.nx_log)}
    env.update(kwargs.pop("env", {}))
    return run_script(
        script_dir / "run-affected-tests.sh",
        cwd=h.repo,
        env=env,
        **kwargs,
    )


def test_env_path_affected_with_merge_base(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """1. env 経由: affected -t test を merge-base 一致の --base / --head で実行。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 0

    log = at_repo.nx_log.read_text()
    # 起点の `test`（nx:noop）ではなく、graph の test-* レーンを名前で列挙して要求する（#1232）。
    assert "affected -t test-cli,test-hooks,test-unit --base=" in log
    assert f"--base={at_repo.from_sha}" in log
    assert f"--head={at_repo.feature_sha}" in log
    assert "--parallel=4" in log
    assert "--nxBail" in log
    assert "--output-style=stream" in log
    assert "run-many" not in log
    # 色付けを止めて起動する（ANSI がログと抽出を汚さないように）。
    assert "ENV NO_COLOR=1" in log


def test_stdin_path_affected(script_dir: Path, at_repo: _AffectedTestsRepo, run_script) -> None:
    """2. stdin 経由: pre-push stdin の local_sha で affected を実行。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        stdin=f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n",
    )
    assert result.returncode == 0

    log = at_repo.nx_log.read_text()
    assert "affected -t test" in log
    assert f"--base={at_repo.from_sha}" in log
    assert f"--head={at_repo.feature_sha}" in log


def test_version_plan_base_override(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """3. PECOT_VERSION_PLAN_BASE override → 指定 base の merge-base を使う。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()
    at_repo.fake_remote_ref("custom-base", at_repo.main_sha)

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "PECOT_VERSION_PLAN_BASE": "origin/custom-base",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    assert result.returncode == 0

    log = at_repo.nx_log.read_text()
    assert f"--base={at_repo.from_sha}" in log
    assert f"--head={at_repo.feature_sha}" in log


def test_branch_delete_push_skips(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """4. ブランチ削除 push（to=ZERO_SHA）→ skip / nx 未起動 / exit 0。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": _ZERO_SHA})
    assert result.returncode == 0
    assert at_repo.nx_log.read_text() == ""


def test_from_equals_to_skips(script_dir: Path, at_repo: _AffectedTestsRepo, run_script) -> None:
    """5. from==to（push が default の祖先 / no-op）→ skip / nx 未起動 / exit 0。"""
    at_repo.install_nx_stub()
    # feature を作らず main の tip をそのまま渡すと merge-base == tip。
    at_repo.fake_remote_ref("main", at_repo.main_sha)
    at_repo.fake_origin_head("main")

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.main_sha})
    assert result.returncode == 0
    assert at_repo.nx_log.read_text() == ""


def test_affected_test_failure_propagates(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """6. affected のテスト失敗（nx exit 1）→ exit 1 で伝播 / push ブロック。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 1
    assert "affected -t test" in at_repo.nx_log.read_text()


def test_nx_unresolved_fail_closed(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """7. nx 未解決 → fail-closed（exit 1 / 復旧手順入り ERROR）。"""
    # install_nx_stub を呼ばない: node_modules と PATH のどちらにも nx は無い。
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "ERROR" in out
    assert "nx" in out


def test_base_unresolved_run_many_fallback(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """8. base 未解決 → WARN + run-many フォールバック / 完走で exit 0。"""
    at_repo.install_nx_stub()
    # origin/HEAD を設定しない & PECOT_VERSION_PLAN_BASE なし → base 解決失敗。
    at_repo.build_feature_no_remote()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 0
    assert "WARN" in (result.stdout + result.stderr)

    log = at_repo.nx_log.read_text()
    assert "run-many -t test" in log
    assert "--parallel=4" in log
    assert "--nxBail" in log
    assert "--output-style=stream" in log
    assert "affected -t test" not in log
    # フォールバックは push range を判定できないため pm-guard は未設定（両方実行）で起動する。
    assert "ENV PECOTV_PM_GUARD_BEHAVIOR=unset" in log


def test_lane_names_come_from_the_graph_each_run(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """レーン名は固定せず、実行ごとに `nx graph --file` で集める。起点の `test` は含めない（#1232）。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 0

    graph_calls = Path(f"{at_repo.nx_log}.graph").read_text().splitlines()
    assert len(graph_calls) == 1
    assert graph_calls[0].startswith("graph --file=")
    affected = [ln for ln in at_repo.nx_log.read_text().splitlines() if ln.startswith("affected ")]
    assert len(affected) == 1
    assert affected[0].split()[2] == "test-cli,test-hooks,test-unit"


def test_affected_fails_closed_when_graph_cannot_be_computed(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """graph が取れないとレーン名を決められない。空の -t で nx を起動せず、ERROR で止まる（fail-closed）。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PRE_COMMIT_TO_REF": at_repo.feature_sha, "STUB_NX_GRAPH_FAIL": "1"},
    )
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "ERROR" in out
    assert "nx graph" in out
    assert "affected" not in at_repo.nx_log.read_text()


def test_affected_fails_closed_when_graph_has_no_test_lane(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """test-* のレーンが 1 つも無い graph は、テストを通さないため止める。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PRE_COMMIT_TO_REF": at_repo.feature_sha, "STUB_NX_GRAPH_NO_LANES": "1"},
    )
    assert result.returncode == 1
    assert "ERROR" in (result.stdout + result.stderr)
    assert "affected" not in at_repo.nx_log.read_text()


def test_run_many_fallback_does_not_need_the_graph(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """全 project のフォールバックは起点の `test` を要求する（noop の inputs に左右されない）。graph は読まない。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PRE_COMMIT_TO_REF": at_repo.feature_sha, "STUB_NX_GRAPH_FAIL": "1"},
    )
    assert result.returncode == 0
    assert "run-many -t test " in at_repo.nx_log.read_text()
    assert not Path(f"{at_repo.nx_log}.graph").exists()


def test_base_unresolved_run_many_failure_propagates(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """9. base 未解決 → run-many フォールバックのテスト失敗（非 0）も伝播。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 1
    assert "run-many -t test" in at_repo.nx_log.read_text()


def test_no_push_info_run_many_fallback(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """10. push 情報なし（env と stdin のどちらも無し）→ run-many フォールバック。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    # PRE_COMMIT_TO_REF 未設定 & stdin を空（tty でない空入力）にする。
    result = _run(script_dir, at_repo, run_script, stdin="")
    assert result.returncode == 0
    assert "WARN" in (result.stdout + result.stderr)
    assert "run-many -t test" in at_repo.nx_log.read_text()


def test_stdin_two_lines_two_affected(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """11. stdin 2 行（2 ブランチ）→ affected が各 head で 2 回実行。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()  # feature (feature_sha / from_sha) + origin/main, origin/HEAD

    # 2 本目の feature ブランチを main から分岐して作る。
    feature2_sha, from2_sha = _add_second_feature(at_repo, git, git_rev_parse)

    stdin = (
        f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/feature2 {feature2_sha} refs/heads/feature2 {at_repo.main_sha}\n"
    )
    result = _run(script_dir, at_repo, run_script, stdin=stdin)
    assert result.returncode == 0

    log = at_repo.nx_log.read_text()
    # affected が tip ごとに 2 回実行され、run-many は呼ばれない。
    assert log.count("affected -t test") == 2
    assert f"--base={at_repo.from_sha}" in log
    assert f"--head={at_repo.feature_sha}" in log
    assert f"--base={from2_sha}" in log
    assert f"--head={feature2_sha}" in log
    assert "run-many" not in log


def test_annotated_tag_peeled(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """12. annotated tag tip → peel された commit SHA が --head に渡る。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    # annotated tag を feature の tip に作る。tag object SHA は commit SHA と異なる。
    git(at_repo.repo, "tag", "-a", "-m", "release tag", "v-probe", at_repo.feature_sha)
    tag_obj = git_rev_parse(at_repo.repo, "v-probe")
    assert tag_obj != at_repo.feature_sha  # annotated tag は別オブジェクト

    # pre-push stdin に tag object SHA を local_sha として流す。
    result = _run(
        script_dir,
        at_repo,
        run_script,
        stdin=f"refs/tags/v-probe {tag_obj} refs/tags/v-probe {at_repo.main_sha}\n",
    )
    assert result.returncode == 0

    log = at_repo.nx_log.read_text()
    assert "affected -t test" in log
    # peel 後の commit SHA が --head に渡る（tag object SHA ではない）。
    assert f"--head={at_repo.feature_sha}" in log
    assert f"--base={at_repo.from_sha}" in log
    assert f"--head={tag_obj}" not in log


def test_multiple_tip_all_fallback_run_many_once(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git
) -> None:
    """13. 複数 tip 全フォールバック → run-many は 1 回だけ。"""
    at_repo.install_nx_stub()
    # origin/HEAD を作らない → 各 tip が base 解決失敗 (rc=11) でフォールバック。
    at_repo.build_feature_no_remote("feature")
    feat1_sha = at_repo.feature_sha
    git(at_repo.repo, "checkout", "-q", "main")
    at_repo.build_feature_no_remote("feature2")
    feat2_sha = at_repo.feature_sha

    stdin = (
        f"refs/heads/feature {feat1_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/feature2 {feat2_sha} refs/heads/feature2 {at_repo.main_sha}\n"
    )
    result = _run(script_dir, at_repo, run_script, stdin=stdin)
    assert result.returncode == 0

    # WARN は初回のみ（2 tip 全フォールバックでも 1 行）。
    out = result.stdout + result.stderr
    assert out.count("WARN") == 1

    # run-many が 1 回だけ実行される（フォールバックは集約され 1 回）。
    assert at_repo.nx_log.read_text().count("run-many -t test") == 1


def test_node_unresolved_fail_closed(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """14. node 未解決 → fail-closed（exit 1 / 復旧手順入り ERROR）。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    # node を含む PATH エントリだけ除外し、git / bash / coreutils は残す。
    # スクリプトは git rev-parse → node check → nx の順に実行される。
    # そのため、node のある dir だけ除けば node check で fail-closed する（git は別 dir に残る）。
    import os
    import shutil

    node_path = shutil.which("node")
    if node_path is None:
        pytest.skip("node が PATH に無い（環境依存）")
    node_dir = str(Path(node_path).parent)
    clean_path = os.pathsep.join(
        p for p in os.environ.get("PATH", "").split(os.pathsep) if p != node_dir
    )
    # 念のため node が PATH から消えたことを前提化（消えていなければテスト無効）。
    if shutil.which("node", path=clean_path) is not None:
        pytest.skip("node を PATH から除去できず（環境依存）")

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PATH": clean_path, "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "ERROR" in out
    assert "node" in out


def test_pm_guard_behavior_off_without_manifest_change(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """15. push range に pm-guard 対象の変更なし → PECOTV_PM_GUARD_BEHAVIOR=0 を export。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()  # plugins/pecot-workflow/cli/probe.py のみ

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 0
    assert "ENV PECOTV_PM_GUARD_BEHAVIOR=0" in at_repo.nx_log.read_text()


@pytest.mark.parametrize(
    "changed_path",
    [
        "plugins/pecot-visual/cli/package.json",
        "plugins/pecot-visual/.npmrc",
        "plugins/pecot-visual/pnpm-workspace.yaml",
        "plugins/pecot-visual/scripts/ci/check-pm-guard.sh",
    ],
)
def test_pm_guard_behavior_on_with_manifest_change(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, changed_path: str
) -> None:
    """16. push range に pm-guard 対象の変更あり → PECOTV_PM_GUARD_BEHAVIOR=1 を export。"""
    at_repo.install_nx_stub()
    at_repo.build_feature(changed_path=changed_path)

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 0
    assert "ENV PECOTV_PM_GUARD_BEHAVIOR=1" in at_repo.nx_log.read_text()


# ====
# 失敗時の出力方針（#1079）: --nxBail で打ち切り、ログへ退避し、失敗レーンだけ端末へ
# ====


def test_failure_reports_failed_lane_only_and_normalizes_exit(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """17. nx 失敗（bail 由来 exit 130）→ exit 1 に正規化し失敗レーンだけ stderr へ。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "130", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    # 130 は SIGINT と誤読されるため 1 へ正規化する。
    assert result.returncode == 1
    # 正規化で失われる元の exit code は端末へ出す。
    assert "nx exit code: 130" in result.stderr

    # 要約の `Failed tasks:` に載った project の行と要約だけが端末へ出る。
    # 並列で交互に混在した他レーンの行（LANE_ONE_*）は、失敗レーンより後の行でも出さない。
    assert "=== 失敗レーン: lane-two ===" in result.stderr
    assert "LANE_TWO_BODY" in result.stderr
    assert "AssertionError: expected 1 to be 2" in result.stderr
    assert "Failed tasks:" in result.stderr
    assert "Tasks not run because their dependencies failed" in result.stderr
    assert "LANE_ONE_BODY" not in result.stderr
    assert "LANE_ONE_TAIL" not in result.stderr
    assert "LANE_ONE_BODY" not in result.stdout
    # `Tasks not run` に列挙された project は失敗レーンとして扱わない。
    assert "=== 失敗レーン: lane-three ===" not in result.stderr

    # ログパスの案内が出る。
    log = _hook_log_path(at_repo)
    assert f"全出力: {log}" in result.stderr
    assert f"進行確認: tail -f {log}" in result.stderr

    # ログ側には全レーン分が残る。
    log_text = log.read_text()
    assert "LANE_ONE_BODY" in log_text
    assert "LANE_TWO_BODY" in log_text


def test_failure_without_summary_falls_back_to_log_tail(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """18. 要約無しの失敗（タスク開始前に終了する nx）→ ログ末尾へフォールバック。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "STUB_NX_EXIT": "1",
            "STUB_NX_NO_SUMMARY": "1",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    assert result.returncode == 1
    assert "ログ末尾" in result.stderr
    assert "NO_SUMMARY_BODY" in result.stderr
    assert f"全出力: {_hook_log_path(at_repo)}" in result.stderr


def test_success_writes_log_and_keeps_terminal_quiet(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """19. 成功時 → ログは生成されるが nx 本文は端末へ流れない。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 0

    log_text = _hook_log_path(at_repo).read_text()
    assert "LANE_ONE_BODY" in log_text
    assert "Successfully ran target test" in log_text

    out = result.stdout + result.stderr
    assert "LANE_ONE_BODY" not in out
    assert "LANE_TWO_BODY" not in out
    assert "全出力:" not in out


def test_fallback_run_many_failure_reports_failed_lane(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """20. run-many フォールバックでも bail・ログ化・失敗レーン表示が有効になる。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "130", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 1

    args_log = at_repo.nx_log.read_text()
    assert "run-many -t test" in args_log
    assert "--nxBail" in args_log

    assert "LANE_TWO_BODY" in result.stderr
    assert "LANE_ONE_BODY" not in result.stderr
    assert f"全出力: {_hook_log_path(at_repo)}" in result.stderr


def test_failure_body_truncated_to_line_limit(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """21. 失敗レーン本文は末尾 400 行までに切り詰める（進捗ドット列で端末を埋め尽くさない）。

    pytest レーンは nx の擬似端末で進捗ドットが `<project>: .` として 1 行ずつ出るため、
    byte 上限（64 KiB）だけでは未達のまま数千行が端末へ流れる。行数上限で頭を落とす。
    """
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "STUB_NX_EXIT": "1",
            "STUB_NX_DOTS": "1000",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    assert result.returncode == 1

    # 本文（`lane-two: ` 接頭辞）は 1,003 行あるが、端末へ出るのは末尾 400 行だけ。
    lane_lines = [ln for ln in result.stderr.splitlines() if ln.startswith("lane-two: ")]
    assert len(lane_lines) == 400
    assert "先頭 603 行を省略" in result.stderr
    # 末尾（原因が読める側）は残り、先頭のドットは落ちる。
    assert "lane-two: DOT1000 ." in result.stderr
    assert "AssertionError: expected 1 to be 2" in result.stderr
    assert "lane-two: DOT1 ." not in result.stderr
    # ログ側には全量が残る。
    assert "lane-two: DOT1 ." in _hook_log_path(at_repo).read_text()


def test_failure_reports_only_current_nx_run(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """22. 複数 tip: 報告は失敗した nx 実行分に限り、先行実行の同名レーンを混ぜない。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()
    feature2_sha, _ = _add_second_feature(at_repo, git, git_rev_parse)

    stdin = (
        f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/feature2 {feature2_sha} refs/heads/feature2 {at_repo.main_sha}\n"
    )
    # 1 回目は成功、2 回目だけ失敗させる。
    result = _run(
        script_dir,
        at_repo,
        run_script,
        stdin=stdin,
        env={"STUB_NX_EXIT": "1", "STUB_NX_FAIL_ON_CALL": "2"},
    )
    assert result.returncode == 1
    assert "nx exit code: 1" in result.stderr

    # 失敗した 2 回目の本文だけが出る（1 回目の同名レーン行・成功要約は出ない）。
    assert "CALL2_BODY" in result.stderr
    assert "CALL1_BODY" not in result.stderr
    assert "Successfully ran target test" not in result.stderr

    # ログには両方の実行分が残る。
    log_text = _hook_log_path(at_repo).read_text()
    assert "CALL1_BODY" in log_text
    assert "CALL2_BODY" in log_text


def test_failure_fallback_keeps_summary_block(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """23. 失敗 project 不明のフォールバックでも、要約ブロック以降を必ず含める。

    要約の後ろに無関係レーンの出力が続くと、ログ末尾 80 行だけでは要約が押し出される。
    """
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "STUB_NX_EXIT": "1",
            "STUB_NX_SUMMARY_NO_TASKS": "1",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    assert result.returncode == 1
    assert "ログ末尾" in result.stderr
    # 要約は末尾から 100 行以上離れているが落ちない。
    assert "NX   Running target test for 2 projects failed" in result.stderr
    assert "SUMMARY_MARKER_LINE" in result.stderr
    # ログ末尾側も出る。
    assert "lane-one: TRAILING100" in result.stderr
    # nx が書く profile の場所の行は失敗の原因と無関係なので出さない。
    assert "Performance Profile" not in result.stderr


def test_failure_reports_multiple_lanes_in_summary_order(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """24. 失敗レーンが 2 件 → 両方の見出しと本文が要約の順で出て、本文が混線しない。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "STUB_NX_EXIT": "1",
            "STUB_NX_FAILED_TWO": "1",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    assert result.returncode == 1

    head_two = result.stderr.index("=== 失敗レーン: lane-two ===")
    head_one = result.stderr.index("=== 失敗レーン: lane-one ===")
    # 並びは要約の順（lane-two → lane-one）。辞書順に並べ替えない。
    assert head_two < head_one

    section_two = result.stderr[head_two:head_one]
    section_one = result.stderr[head_one:]
    assert "LANE_TWO_BODY" in section_two
    assert "AssertionError: expected 1 to be 2" in section_two
    assert "LANE_ONE" not in section_two
    assert "LANE_ONE_BODY" in section_one
    assert "LANE_ONE_TAIL" in section_one
    assert "LANE_TWO_BODY" not in section_one


def test_failure_body_truncated_at_line_boundary_by_byte_limit(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """25. byte 上限も行境界で当てる（マルチバイト文字を分断しない）。

    1 行 48 KiB のマルチバイト行を 3 行出すと 64 KiB 上限には末尾 1 行しか入らない。
    `tail -c` だと途中で切れて端末が文字化けするため、行単位で落とすことを pin する。
    """
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "STUB_NX_EXIT": "1",
            "STUB_NX_WIDE": "1",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    assert result.returncode == 1

    assert "先頭 4 行を省略" in result.stderr
    assert "lane-two: WIDE3 " in result.stderr
    assert "WIDE2" not in result.stderr
    assert "WIDE1" not in result.stderr
    # 行の途中で切られていない（分断されると復号で置換文字が出る）。
    assert "\ufffd" not in result.stderr
    wide_line = next(ln for ln in result.stderr.splitlines() if ln.startswith("lane-two: WIDE3 "))
    assert wide_line.count("あ") == 16384


# ====
# 所要の記録と成功時の合計行（#1083）
# ====

_TIMING_RELPATH = Path(".pecot/tmp/githooks-timing.tsv")
_PROFILE_RELPATH = Path(".pecot/tmp/pre-push/nx-profile.json")


def _timing_rows(h: _AffectedTestsRepo) -> list[list[str]]:
    """記録ファイルの各行を 5 列に分けて返す（ファイルが無ければ空）。"""
    path = h.repo / _TIMING_RELPATH
    if not path.exists():
        return []
    rows = [line.split("\t") for line in path.read_text().splitlines()]
    for row in rows:
        assert len(row) == 5, row
    return rows


def _rows_of(h: _AffectedTestsRepo, kind: str) -> list[list[str]]:
    return [row for row in _timing_rows(h) if row[1] == kind]


def test_success_prints_one_summary_line(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """26. 成功 push → stdout は合計行 1 行だけ。profile は repo root 相対の固定パスに書かれる。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 0

    lines = result.stdout.splitlines()
    assert len(lines) == 1
    line = lines[0]
    assert re.match(r"^nx affected tests: 合計 \d+\.\ds / ", line)
    assert "最長 lane-two:test-unit 2.5s" in line
    assert "並列 4" in line
    assert "レーン 2" in line
    assert "WARN" not in result.stderr
    assert (at_repo.repo / _PROFILE_RELPATH).is_file()


def test_success_records_task_and_nx_rows(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """27. 成功 push → task 行 3 本（install を含む）と nx 行 1 本を記録する。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 0

    tasks = _rows_of(at_repo, "task")
    assert [(r[2], r[3], r[4]) for r in tasks] == [
        ("lane-two:install", "3.0", "status=success"),
        ("lane-one:test-unit", "1.5", "status=success"),
        ("lane-two:test-unit", "2.5", "status=success"),
    ]
    nx_rows = _rows_of(at_repo, "nx")
    assert len(nx_rows) == 1
    assert nx_rows[0][2] == "affected"
    float(nx_rows[0][3])
    assert nx_rows[0][4].startswith("parallel=4 lanes=2 longest=lane-two:test-unit rec=")
    float(nx_rows[0][4].rsplit("rec=", 1)[1])
    # hook 行はラッパーの責務で、本スクリプトは書かない。
    assert _rows_of(at_repo, "hook") == []


def test_multiple_tips_aggregate_lanes_without_duplicates(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """28. 複数 tip（nx 2 回）→ nx 行 2 本・task 行 6 本、合計行は 1 行でレーンは重複除外。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()
    feature2_sha, _ = _add_second_feature(at_repo, git, git_rev_parse)

    stdin = (
        f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/feature2 {feature2_sha} refs/heads/feature2 {at_repo.main_sha}\n"
    )
    result = _run(script_dir, at_repo, run_script, stdin=stdin)
    assert result.returncode == 0

    assert len(_rows_of(at_repo, "nx")) == 2
    assert len(_rows_of(at_repo, "task")) == 6
    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert "最長 lane-two:test-unit 2.5s" in lines[0]
    assert "レーン 2" in lines[0]


def test_fallback_records_run_many(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """29. run-many フォールバック → nx 行の名前は run-many。合計行も出る。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    assert result.returncode == 0

    nx_rows = _rows_of(at_repo, "nx")
    assert [r[2] for r in nx_rows] == ["run-many"]
    assert len(result.stdout.splitlines()) == 1
    assert result.stdout.startswith("nx run-many tests: 合計 ")
    assert "レーン 2" in result.stdout


def test_no_push_info_fallback_prints_summary(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """30. push 情報なしのフォールバックでも合計行を 1 行出す。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, stdin="")
    assert result.returncode == 0
    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert lines[0].startswith("nx run-many tests: 合計 ")
    assert [r[2] for r in _rows_of(at_repo, "nx")] == ["run-many"]


def test_empty_profile_reports_zero_lanes_without_warn(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """31. affected 0 件（profile が `[]`）→ 最長 - / レーン 0、WARN なし。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EMPTY_PROFILE": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 0
    assert "WARN" not in result.stderr

    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert "最長 - / 並列 4 / レーン 0" in lines[0]
    assert _rows_of(at_repo, "task") == []
    nx_rows = _rows_of(at_repo, "nx")
    assert len(nx_rows) == 1
    assert nx_rows[0][4].startswith("parallel=4 lanes=0 longest=- rec=")


def test_missing_profile_warns_and_keeps_exit_code(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """32. profile が無い → WARN を stderr に出すが exit 0、合計行はレーン 0。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_NO_PROFILE": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 0
    assert "WARN" in result.stderr
    assert "profile" in result.stderr

    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert "最長 - / 並列 4 / レーン 0" in lines[0]
    nx_rows = _rows_of(at_repo, "nx")
    assert len(nx_rows) == 1
    assert nx_rows[0][4].startswith("parallel=4 lanes=0 longest=- rec=")


def test_skip_push_prints_nothing_and_records_nothing(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """33. ブランチ削除 push（nx 未起動）→ stdout 空・記録ファイルも作らない。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": _ZERO_SHA})
    assert result.returncode == 0
    assert result.stdout == ""
    assert not (at_repo.repo / _TIMING_RELPATH).exists()


def test_failure_records_tasks_without_summary_line(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """34. テスト失敗 push → exit 1 のまま task 行は記録し、合計行は出さない。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 1
    assert "tests: 合計" not in result.stdout + result.stderr
    assert "=== 失敗レーン: lane-two ===" in result.stderr
    assert "Failed tasks:" in result.stderr
    assert "Performance Profile" not in result.stderr

    tasks = {r[2]: r[4] for r in _rows_of(at_repo, "task")}
    assert tasks["lane-two:test-unit"] == "status=failure"
    assert tasks["lane-one:test-unit"] == "status=success"
    assert len(_rows_of(at_repo, "nx")) == 1


def test_failure_before_profile_does_not_warn(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """35. nx が profile を書く前に終了した（rc が非 0 かつ profile 無し）→ 二次的な WARN を出さない。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "STUB_NX_EXIT": "1",
            "STUB_NX_NO_PROFILE": "1",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    assert result.returncode == 1
    assert "WARN" not in result.stderr
    assert "nx exit code: 1" in result.stderr
    nx_rows = _rows_of(at_repo, "nx")
    assert len(nx_rows) == 1
    assert nx_rows[0][4].startswith("parallel=4 lanes=0 longest=- rec=")


def test_broken_profile_warns_and_keeps_exit_code(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """36. 途中まで書かれた JSON（nx 中断時）→ WARN を stderr に出すが exit 0、レーン 0。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_BROKEN_PROFILE": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 0
    assert "WARN" in result.stderr
    assert "profile" in result.stderr

    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert "最長 - / 並列 4 / レーン 0" in lines[0]
    assert _rows_of(at_repo, "task") == []
    nx_rows = _rows_of(at_repo, "nx")
    assert len(nx_rows) == 1
    assert nx_rows[0][4].startswith("parallel=4 lanes=0 longest=- rec=")


def test_negative_duration_is_clamped_to_zero(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """37. 壁時計差で dur が負 → 0.0 に丸め、exit 0 のまま合計行 1 行を出す。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_NEGATIVE_DUR": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 0
    assert result.stderr == ""

    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert "最長 lane-two:test-unit 2.5s" in lines[0]
    assert "レーン 2" in lines[0]
    tasks = {r[2]: r[3] for r in _rows_of(at_repo, "task")}
    assert tasks["lane-one:test-unit"] == "0.0"


def test_configured_test_task_counts_as_lane(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """38. configuration 付き task（id が lane-two:test-unit:ci、args.target.target は test-unit）もレーンに数える。

    レーン名は `<project>:<target>`（lane-two:test-unit）で、同名の別 task とは重複除外される。
    最長の名前は task id のまま。
    """
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_CONFIGURED": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 0

    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert "最長 lane-two:test-unit:ci 2.5s" in lines[0]
    assert "レーン 2" in lines[0]
    nx_rows = _rows_of(at_repo, "nx")
    assert nx_rows[0][4].startswith("parallel=4 lanes=2 longest=lane-two:test-unit:ci rec=")


def test_two_lanes_of_the_same_project_count_as_two(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """38a. 同じ project の 2 レーン（lane-one:test-unit と lane-one:test-hooks）は 2 レーンに数える。

    重複除外のキーは `<project>:<target>`。project だけをキーにすると 1 レーンに潰れる。
    """
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_SAME_PROJECT": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 0

    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert "レーン 2" in lines[0]
    nx_rows = _rows_of(at_repo, "nx")
    assert " lanes=2 " in nx_rows[0][4]


def test_aggregator_test_target_is_not_a_lane(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """38b. レーンを束ねる起点 `test`（nx:noop）はレーンの数にも最長の判定にも数えない。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_AGGREGATOR": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    assert result.returncode == 0

    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert "最長 lane-two:test-unit 2.5s" in lines[0]
    assert "レーン 2" in lines[0]
    tasks = {r[2] for r in _rows_of(at_repo, "task")}
    assert "lane-one:test" in tasks


def test_multiple_tips_pick_longest_across_runs(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """39. 2 回目の nx だけ別の task が最長 → push 全体の最長は起動をまたいで選ばれる。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()
    feature2_sha, _ = _add_second_feature(at_repo, git, git_rev_parse)

    stdin = (
        f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/feature2 {feature2_sha} refs/heads/feature2 {at_repo.main_sha}\n"
    )
    result = _run(script_dir, at_repo, run_script, stdin=stdin, env={"STUB_NX_CALL2_LONGER": "1"})
    assert result.returncode == 0

    nx_rows = _rows_of(at_repo, "nx")
    assert len(nx_rows) == 2
    assert "longest=lane-two:test-unit " in nx_rows[0][4]
    assert "longest=lane-one:test-unit " in nx_rows[1][4]
    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert "最長 lane-one:test-unit 4.0s" in lines[0]
    assert "レーン 2" in lines[0]
