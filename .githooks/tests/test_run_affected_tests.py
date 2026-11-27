"""run-affected-tests.sh のユニットテスト（test_run_affected_tests.bats 移植）。

hook は base/head を共有 lib（lib/push-range.sh）で解決し、tip ごとに repo root で affected を実行する。
実行するコマンドは、このドキュメント末尾に示す。
レーン名（`test-*` の target 名）は `nx graph --file` の JSON から集める（lib/nx-lanes.sh、#1232）。
判定不能時は `nx run-many -t test --parallel=4 --nxBail` へフォールバックする。
push range にパッケージマネージャガードの対象ファイルが含まれるかで、PECOTV_PM_GUARD_BEHAVIOR を 1 / 0 に決める。
その値を nx へ export する（#1080）。
nx の出力は端末でなく `<repo_root>/.pecot/tmp/nx-affected-tests/nx-affected-tests.log` へ書く。
失敗時だけ、要約の `Failed tasks:` に載った project の行を stderr へ出す（#1079）。
nx は `NX_PROFILE=.pecot/tmp/nx-affected-tests/nx-profile.json`（repo root 相対）付きで起動する。
profile の task 所要は、`<repo_root>/.pecot/tmp/githooks-timing.tsv` へ task 行・nx 行として追記する。
成功時には、合計秒・最長 test task・並列度・レーン数の 1 行を stdout へ出す（#1083）。

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
import sys
from collections.abc import Callable
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

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
#   STUB_NX_RECOMMEND      : `Failed tasks:` の後に、実 nx と同じ並びの性能レポートを出す。
#                            multi は推奨が複数行、single は `  Recommendation: ` の 1 行。
#                            hidden は `Output of … not shown` を挟んで multi を続ける。
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
#   STUB_NX_STATIC         : `--output-style=static` 形式の疑似出力にする（task ごとの塊）。
#                            塊は p:test-unit（成功）/ p:test-cli-x（成功）/ q:test-hooks（成功）と、
#                            失敗の p:test-cli は、見出しを次の形にする。
#                              ::group::❌ > nx run p:test-cli  [local cache]
#                            `Failed tasks:` は `- p:test-cli` の 1 件。
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

emit_recommend() {
    case "${STUB_NX_RECOMMEND:-}" in
        "") return 0 ;;
        hidden)
            echo "Output of lane-three:test-unit not shown. Re-run with --verbose to see it."
            echo
            ;;
    esac
    echo "  Run duration:      9m 59s"
    echo "  Cache:             Skipped (--skip-nx-cache)"
    echo "  Critical path:     7m 17s (4 tasks)"
    echo "  Recoverable time:  2m 42s (27% of the run)"
    echo
    if [ "$STUB_NX_RECOMMEND" = single ]; then
        echo "  Recommendation: Cache: drop --skip-nx-cache to restore unchanged tasks instantly."
    else
        echo "  Recommendations:"
        echo "    - Cache: drop --skip-nx-cache to restore unchanged tasks instantly."
        echo "    - Distribute across machines with Nx Agents → https://example.invalid/agents"
    fi
}

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

if [ -n "${STUB_NX_STATIC:-}" ]; then
    cat <<'STATIC'

 NX   Running target test for 3 projects


> nx run p:test-unit

STATIC_PASS_UNIT_BODY 3 passed, 2 skipped

> nx run p:test-cli-x

STATIC_PASS_CLIX_BODY 1 passed

::group::❌ > nx run p:test-cli  [local cache]

STATIC_FAIL_BODY AssertionError: expected 1 to be 2
::endgroup::

> nx run q:test-hooks

STATIC_PASS_HOOKS_BODY 5 passed, 1 skipped



 NX   Running target test for 3 projects failed

Failed tasks:

- p:test-cli
STATIC
    if [ -n "${STUB_NX_FAILED_TWO:-}" ]; then
        echo "- q:test-hooks"
    fi
    echo
    emit_recommend
    echo
    echo "Performance Profile: placeholder"
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
emit_recommend
echo
echo "Performance Profile: $PWD/${NX_PROFILE-none}"
exit "$rc"
"""

# hook が nx 出力を書く固定パス（repo root 相対）。
_NX_LOG_RELPATH = Path(".pecot/tmp/nx-affected-tests/nx-affected-tests.log")


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
        self.from_sha = run_attached(
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
    from_sha = run_attached(
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
        script_dir.parent / "ci" / "run-affected-tests.sh",
        cwd=h.repo,
        env=env,
        **kwargs,
    )


@allure.title(
    "環境変数で push 先を渡すと、merge-base に一致する `--base` と `--head` で affected を実行する"
)
def test_env_path_affected_with_merge_base(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """環境変数 `PRE_COMMIT_TO_REF` で push 先を渡した場合のテストです。`nx affected` が、merge-base に一致する `--base` と、push 先に一致する `--head` で起動され、終了コードが 0 になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("終了コードと affected の呼び出しの base・head・並列・出力の形を確かめる"):
        assert result.returncode == 0

        log = read_output(at_repo.nx_log)
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


@allure.title("標準入力で push 情報を渡すと、local_sha を `--head` にして affected を実行する")
def test_stdin_path_affected(script_dir: Path, at_repo: _AffectedTestsRepo, run_script) -> None:
    """pre-push の標準入力で push 情報を渡した場合のテストです。標準入力の local_sha が `--head` に渡された状態で `nx affected` が起動され、終了コードが 0 になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        stdin=f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n",
    )
    with allure.step("終了コードと affected の呼び出しの base と head を確かめる"):
        assert result.returncode == 0

        log = read_output(at_repo.nx_log)
        assert "affected -t test" in log
        assert f"--base={at_repo.from_sha}" in log
        assert f"--head={at_repo.feature_sha}" in log


@allure.title("`PECOT_VERSION_PLAN_BASE` を指定すると、指定した base の merge-base を使う")
def test_version_plan_base_override(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`PECOT_VERSION_PLAN_BASE` で比較元のブランチを指定した場合のテストです。既定のブランチではなく、指定したブランチとの merge-base が `--base` に渡されることを確認します。"""
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
    with allure.step("終了コードと指定した base の merge-base が使われることを確かめる"):
        assert result.returncode == 0

        log = read_output(at_repo.nx_log)
        assert f"--base={at_repo.from_sha}" in log
        assert f"--head={at_repo.feature_sha}" in log


@allure.title("ブランチを削除する push では、nx を起動せずに終了コード 0 で終了する")
def test_branch_delete_push_skips(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """push 先が 0 だけの SHA になる、ブランチ削除の push のテストです。`nx` が起動されず、終了コードが 0 になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": _ZERO_SHA})
    with allure.step("終了コードと nx が起動されないことを確かめる"):
        assert result.returncode == 0
        assert read_output(at_repo.nx_log) == ""


@allure.title("push 元と push 先が同じ場合は、nx を起動せずに終了コード 0 で終了する")
def test_from_equals_to_skips(script_dir: Path, at_repo: _AffectedTestsRepo, run_script) -> None:
    """push 元と push 先の SHA が一致する、変更のない push のテストです。`nx` が起動されず、終了コードが 0 になることを確認します。"""
    at_repo.install_nx_stub()
    # feature を作らず main の tip をそのまま渡すと merge-base == tip。
    at_repo.fake_remote_ref("main", at_repo.main_sha)
    at_repo.fake_origin_head("main")

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.main_sha})
    with allure.step("終了コードと nx が起動されないことを確かめる"):
        assert result.returncode == 0
        assert read_output(at_repo.nx_log) == ""


@allure.title("affected のテストが失敗すると、終了コード 1 で終了して push を止める")
def test_affected_test_failure_propagates(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx affected` がテストの失敗で終了した場合のテストです。スクリプトの終了コードが 1 になり、push が止まることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コード 1 と affected の呼び出しを確かめる"):
        assert result.returncode == 1
        assert "affected -t test" in read_output(at_repo.nx_log)


@allure.title("nx を解決できない場合は、復旧手順を添えたエラーを出して終了コード 1 で終了する")
def test_nx_unresolved_fail_closed(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx` の実行ファイルを解決できない環境のテストです。終了コードが 1 になり、標準エラー出力に復旧手順を含むエラーが表示されることを確認します。"""
    # install_nx_stub を呼ばない: node_modules と PATH のどちらにも nx は無い。
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("終了コード 1 と復旧手順入りの ERROR を確かめる"):
        assert result.returncode == 1
        out = result.stdout + result.stderr
        assert "ERROR" in out
        assert "nx" in out


@allure.title(
    "base を解決できない場合は、警告を出して全 project の run-many に切り替え、完走すれば終了コード 0 で終了する"
)
def test_base_unresolved_run_many_fallback(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """merge-base を解決できないブランチを push した場合のテストです。警告が表示され、`nx affected` ではなく `nx run-many` が実行されて、終了コードが 0 になることを確認します。"""
    at_repo.install_nx_stub()
    # origin/HEAD を設定しない & PECOT_VERSION_PLAN_BASE なし → base 解決失敗。
    at_repo.build_feature_no_remote()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("終了コードと警告と run-many への切り替えを確かめる"):
        assert result.returncode == 0
        assert "WARN" in (result.stdout + result.stderr)

        log = read_output(at_repo.nx_log)
        assert "run-many -t test" in log
        assert "--parallel=4" in log
        assert "--nxBail" in log
        assert "--output-style=stream" in log
        assert "affected -t test" not in log
        # フォールバックは push range を判定できないため pm-guard は未設定（両方実行）で起動する。
        assert "ENV PECOTV_PM_GUARD_BEHAVIOR=unset" in log


@allure.title("レーン名は固定せず、実行のたびに `nx graph` から集め、起点の `test` は含めない")
def test_lane_names_come_from_the_graph_each_run(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx affected` に渡す target の一覧のテストです。実行のたびに `nx graph --file` の結果から `test-*` のレーン名を集め、束ねる起点の `test` が含まれないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("nx graph の呼び出しと test のレーン名を確かめる"):
        assert result.returncode == 0

        graph_calls = read_output(Path(f"{at_repo.nx_log}.graph")).splitlines()
        assert len(graph_calls) == 1
        assert graph_calls[0].startswith("graph --file=")
        affected = [
            ln for ln in read_output(at_repo.nx_log).splitlines() if ln.startswith("affected ")
        ]
        assert len(affected) == 1
        assert affected[0].split()[2] == "test-cli,test-hooks,test-unit"


@allure.title("graph を取得できない場合は、nx を起動せずにエラーで止まる")
def test_affected_fails_closed_when_graph_cannot_be_computed(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx graph` が失敗してレーン名を決められない場合のテストです。空の `-t` で `nx` を起動せず、標準エラー出力にエラーが表示されて終了コード 1 になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PRE_COMMIT_TO_REF": at_repo.feature_sha, "STUB_NX_GRAPH_FAIL": "1"},
    )
    with allure.step("終了コード 1・ERROR と、affected が呼ばれないことを確かめる"):
        assert result.returncode == 1
        out = result.stdout + result.stderr
        assert "ERROR" in out
        assert "nx graph" in out
        assert "affected" not in read_output(at_repo.nx_log)


@allure.title("graph に `test-*` のレーンが 1 つもない場合は、エラーで止まる")
def test_affected_fails_closed_when_graph_has_no_test_lane(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """取得した graph に `test-*` のレーンが存在しない場合のテストです。テストを通さずに push を許可しないよう、エラーが表示されて終了コード 1 になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PRE_COMMIT_TO_REF": at_repo.feature_sha, "STUB_NX_GRAPH_NO_LANES": "1"},
    )
    with allure.step("終了コード 1・ERROR と、affected が呼ばれないことを確かめる"):
        assert result.returncode == 1
        assert "ERROR" in (result.stdout + result.stderr)
        assert "affected" not in read_output(at_repo.nx_log)


@allure.title("全 project の run-many は、graph を読まずに起点の `test` を指定して実行する")
def test_run_many_fallback_does_not_need_the_graph(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """base を解決できず、全 project にフォールバックした場合のテストです。`nx graph` が呼ばれず、`nx run-many` に起点の `test` が渡されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PRE_COMMIT_TO_REF": at_repo.feature_sha, "STUB_NX_GRAPH_FAIL": "1"},
    )
    with allure.step("終了コードと run-many の呼び出しと graph が呼ばれないことを確かめる"):
        assert result.returncode == 0
        assert "run-many -t test " in read_output(at_repo.nx_log)
        assert not Path(f"{at_repo.nx_log}.graph").exists()


@allure.title("base を解決できない場合の run-many が失敗すると、終了コード 1 で終了する")
def test_base_unresolved_run_many_failure_propagates(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """フォールバックの `nx run-many` がテストの失敗で終了した場合のテストです。スクリプトの終了コードが 0 以外になり、失敗が伝わることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コード 1 と run-many の呼び出しを確かめる"):
        assert result.returncode == 1
        assert "run-many -t test" in read_output(at_repo.nx_log)


@allure.title(
    "push 情報が環境変数と標準入力のどちらにもない場合は、全 project の run-many に切り替える"
)
def test_no_push_info_run_many_fallback(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """環境変数と標準入力のどちらにも push 情報がない場合のテストです。`nx affected` ではなく `nx run-many` が実行されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    # PRE_COMMIT_TO_REF 未設定 & stdin を空（tty でない空入力）にする。
    result = _run(script_dir, at_repo, run_script, stdin="")
    with allure.step("終了コードと警告と run-many の呼び出しを確かめる"):
        assert result.returncode == 0
        assert "WARN" in (result.stdout + result.stderr)
        assert "run-many -t test" in read_output(at_repo.nx_log)


@allure.title("標準入力が 2 行（2 ブランチ）の場合は、それぞれの head で affected を 2 回実行する")
def test_stdin_two_lines_two_affected(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """2 つのブランチを同時に push した場合のテストです。標準入力の 2 行それぞれの head で `nx affected` が 1 回ずつ、合わせて 2 回実行されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()  # feature (feature_sha / from_sha) + origin/main, origin/HEAD

    # 2 本目の feature ブランチを main から分岐して作る。
    feature2_sha, from2_sha = _add_second_feature(at_repo, git, git_rev_parse)

    stdin = (
        f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/feature2 {feature2_sha} refs/heads/feature2 {at_repo.main_sha}\n"
    )
    result = _run(script_dir, at_repo, run_script, stdin=stdin)
    with allure.step("終了コードと affected が 2 回呼ばれることと各 head を確かめる"):
        assert result.returncode == 0

        log = read_output(at_repo.nx_log)
        # affected が tip ごとに 2 回実行され、run-many は呼ばれない。
        assert log.count("affected -t test") == 2
        assert f"--base={at_repo.from_sha}" in log
        assert f"--head={at_repo.feature_sha}" in log
        assert f"--base={from2_sha}" in log
        assert f"--head={feature2_sha}" in log
        assert "run-many" not in log


@allure.title("annotated tag を push すると、参照先の commit の SHA を `--head` に渡す")
def test_annotated_tag_peeled(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """annotated tag を push した場合のテストです。tag オブジェクトの SHA ではなく、参照先の commit の SHA が `--head` に渡されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    # annotated tag を feature の tip に作る。tag object SHA は commit SHA と異なる。
    git(at_repo.repo, "tag", "-a", "-m", "release tag", "v-probe", at_repo.feature_sha)
    tag_obj = git_rev_parse(at_repo.repo, "v-probe")
    with allure.step(
        "annotated tag の SHA が別であることと、剥がした commit の SHA が head に渡ることを確かめる"
    ):
        assert tag_obj != at_repo.feature_sha  # annotated tag は別オブジェクト

        # pre-push stdin に tag object SHA を local_sha として流す。
        result = _run(
            script_dir,
            at_repo,
            run_script,
            stdin=f"refs/tags/v-probe {tag_obj} refs/tags/v-probe {at_repo.main_sha}\n",
        )
        assert result.returncode == 0

        log = read_output(at_repo.nx_log)
        assert "affected -t test" in log
        # peel 後の commit SHA が --head に渡る（tag object SHA ではない）。
        assert f"--head={at_repo.feature_sha}" in log
        assert f"--base={at_repo.from_sha}" in log
        assert f"--head={tag_obj}" not in log


@allure.title("複数の tip がすべてフォールバックになる場合は、run-many を 1 回だけ実行する")
def test_multiple_tip_all_fallback_run_many_once(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git
) -> None:
    """複数のブランチを push し、どの tip も base を解決できない場合のテストです。`nx run-many` が重複せずに 1 回だけ実行されることを確認します。"""
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
    with allure.step("終了コードと警告が 1 回で run-many も 1 回であることを確かめる"):
        assert result.returncode == 0

        # WARN は初回のみ（2 tip 全フォールバックでも 1 行）。
        out = result.stdout + result.stderr
        assert out.count("WARN") == 1

        # run-many が 1 回だけ実行される（フォールバックは集約され 1 回）。
        assert read_output(at_repo.nx_log).count("run-many -t test") == 1


@allure.title("node を解決できない場合は、復旧手順を添えたエラーを出して終了コード 1 で終了する")
def test_node_unresolved_fail_closed(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`node` の実行ファイルを解決できない環境のテストです。終了コードが 1 になり、標準エラー出力に復旧手順を含むエラーが表示されることを確認します。"""
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
    with allure.step("終了コード 1 と復旧手順入りの ERROR を確かめる"):
        assert result.returncode == 1
        out = result.stdout + result.stderr
        assert "ERROR" in out
        assert "node" in out


@allure.title(
    "push 範囲に pm-guard の対象の変更がない場合は、`PECOTV_PM_GUARD_BEHAVIOR` を 0 にして nx を実行する"
)
def test_pm_guard_behavior_off_without_manifest_change(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """パッケージマネージャーの設定を変更しない push のテストです。`nx` の起動時に `PECOTV_PM_GUARD_BEHAVIOR=0` が環境変数として渡されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()  # plugins/pecot-workflow/cli/probe.py のみ

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("pm-guard の環境変数が 0 であることを確かめる"):
        assert result.returncode == 0
        assert "ENV PECOTV_PM_GUARD_BEHAVIOR=0" in read_output(at_repo.nx_log)


@allure.title(
    "push 範囲で {changed_path} を変更すると、`PECOTV_PM_GUARD_BEHAVIOR` を 1 にして nx を実行する"
)
@pytest.mark.parametrize(
    "changed_path",
    [
        "plugins/pecot-visual/cli/package.json",
        ".npmrc",
        "plugins/pecot-visual/pnpm-workspace.yaml",
        "plugins/pecot-visual/scripts/ci/check-pm-guard.sh",
    ],
)
def test_pm_guard_behavior_on_with_manifest_change(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, changed_path: str
) -> None:
    """パッケージマネージャーの設定に関わるファイルを変更した push のテストです。`package.json` や `.npmrc` などの変更がある場合に、`nx` の起動時に `PECOTV_PM_GUARD_BEHAVIOR=1` が環境変数として渡されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature(changed_path=changed_path)

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("pm-guard の環境変数が 1 であることを確かめる"):
        assert result.returncode == 0
        assert "ENV PECOTV_PM_GUARD_BEHAVIOR=1" in read_output(at_repo.nx_log)


# ====
# 失敗時の出力方針（#1079）: --nxBail で打ち切り、ログへ退避し、失敗レーンだけ端末へ
# ====


@allure.title(
    "nx が bail 由来の終了コード 130 で失敗すると、終了コードを 1 にそろえ、失敗したレーンだけを表示する"
)
def test_failure_reports_failed_lane_only_and_normalizes_exit(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx` が `--nxBail` による中断で失敗した場合のテストです。終了コードが 1 に正規化され、標準エラー出力には失敗したレーンの出力だけが表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "130", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コードの正規化と失敗レーンだけの報告とログの全出力を確かめる"):
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
        log_text = read_output(log)
        assert "LANE_ONE_BODY" in log_text
        assert "LANE_TWO_BODY" in log_text


@allure.title("要約が出る前に nx が終了した場合は、ログの末尾を表示する")
def test_failure_without_summary_falls_back_to_log_tail(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """タスクの開始前に `nx` が終了し、要約が存在しない場合のテストです。失敗したレーンを特定できないため、標準エラー出力にログの末尾が表示されることを確認します。"""
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
    with allure.step("終了コードとログ末尾への切り替えを確かめる"):
        assert result.returncode == 1
        assert "ログ末尾" in result.stderr
        assert "NO_SUMMARY_BODY" in result.stderr
        assert f"全出力: {_hook_log_path(at_repo)}" in result.stderr


@allure.title("成功した場合は、ログを保存し、nx の出力を端末に流さない")
def test_success_writes_log_and_keeps_terminal_quiet(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """テストが成功した場合のテストです。ログファイルが作成され、`nx` の本文が端末に表示されないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("終了コードとログが残ることと端末に本文が流れないことを確かめる"):
        assert result.returncode == 0

        log_text = read_output(_hook_log_path(at_repo))
        assert "LANE_ONE_BODY" in log_text
        assert "Successfully ran target test" in log_text

        out = result.stdout + result.stderr
        assert "LANE_ONE_BODY" not in out
        assert "LANE_TWO_BODY" not in out
        assert "全出力:" not in out


@allure.title("run-many に切り替えた場合も、ログへの保存と失敗したレーンの表示が有効になる")
def test_fallback_run_many_failure_reports_failed_lane(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """base を解決できず、`nx run-many` で失敗した場合のテストです。`affected` と同様に、ログが保存され、失敗したレーンの見出しが表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "130", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コードと run-many の呼び出しと失敗レーンの表示を確かめる"):
        assert result.returncode == 1

        args_log = read_output(at_repo.nx_log)
        assert "run-many -t test" in args_log
        assert "--nxBail" in args_log

        assert "LANE_TWO_BODY" in result.stderr
        assert "LANE_ONE_BODY" not in result.stderr
        assert f"全出力: {_hook_log_path(at_repo)}" in result.stderr


@allure.title("失敗したレーンの出力が 400 行を超える場合は、先頭を省略して末尾の 400 行を表示する")
def test_failure_body_truncated_to_line_limit(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """1 つのレーンが 1000 行を超える出力をして失敗した場合のテストです。表示が 400 行に収まり、省略した行数が案内され、原因が読める末尾は残る一方で、ログには全体が残ることを確認します。"""
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
    with allure.step("失敗レーンの本文が末尾 400 行に切り詰められることを確かめる"):
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
        assert "lane-two: DOT1 ." in read_output(_hook_log_path(at_repo))


@allure.title(
    "複数の tip で失敗した場合は、失敗した nx の実行分だけを表示し、先に成功した実行の同名レーンを混ぜない"
)
def test_failure_reports_only_current_nx_run(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """2 つのブランチを push し、2 回目の `nx` だけが失敗する場合のテストです。標準エラー出力には失敗した 2 回目の出力だけが表示され、ログには両方の実行分が残ることを確認します。"""
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
    with allure.step("報告が失敗した nx 実行分だけであることを確かめる"):
        assert result.returncode == 1
        assert "nx exit code: 1" in result.stderr

        # 失敗した 2 回目の本文だけが出る（1 回目の同名レーン行・成功要約は出ない）。
        assert "CALL2_BODY" in result.stderr
        assert "CALL1_BODY" not in result.stderr
        assert "Successfully ran target test" not in result.stderr

        # ログには両方の実行分が残る。
        log_text = read_output(_hook_log_path(at_repo))
        assert "CALL1_BODY" in log_text
        assert "CALL2_BODY" in log_text


@allure.title("失敗した project を特定できない場合も、要約のブロックを含めてログの末尾を表示する")
def test_failure_fallback_keeps_summary_block(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """要約に失敗したタスクが含まれない場合のテストです。要約の後ろに別のレーンの出力が続いても、要約のブロックと末尾の行がどちらも表示され、profile の場所の行は表示されないことを確認します。"""
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
    with allure.step("フォールバックでも要約のブロック以降が含まれることを確かめる"):
        assert result.returncode == 1
        assert "ログ末尾" in result.stderr
        # 要約は末尾から 100 行以上離れているが落ちない。
        assert "NX   Running target test for 2 projects failed" in result.stderr
        assert "SUMMARY_MARKER_LINE" in result.stderr
        # ログ末尾側も出る。
        assert "lane-one: TRAILING100" in result.stderr
        # nx が書く profile の場所の行は失敗の原因と無関係なので出さない。
        assert "Performance Profile" not in result.stderr


@allure.title("失敗したレーンが 2 件ある場合は、両方を要約の順に表示し、出力を混ぜない")
def test_failure_reports_multiple_lanes_in_summary_order(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """2 つのレーンが同時に失敗した場合のテストです。見出しが要約と同じ順で並び、それぞれの本文が自分のレーンの節だけに表示されることを確認します。"""
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
    with allure.step("複数の失敗レーンが要約の順に分かれて出ることを確かめる"):
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


@allure.title(
    "失敗の出力がバイト数の上限を超える場合は、行の境界で切り、マルチバイト文字を分断しない"
)
def test_failure_body_truncated_at_line_boundary_by_byte_limit(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """1 行が約 48 KiB のマルチバイト文字の行を 3 行出力して失敗した場合のテストです。上限に収まる末尾の 1 行だけが表示され、文字化けを示す置換文字が含まれないことを確認します。"""
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
    with allure.step("byte の上限が行の境界で切られることを確かめる"):
        assert result.returncode == 1

        assert "先頭 4 行を省略" in result.stderr
        assert "lane-two: WIDE3 " in result.stderr
        assert "WIDE2" not in result.stderr
        assert "WIDE1" not in result.stderr
        # 行の途中で切られていない（分断されると復号で置換文字が出る）。
        assert "\ufffd" not in result.stderr
        wide_line = next(
            ln for ln in result.stderr.splitlines() if ln.startswith("lane-two: WIDE3 ")
        )
        assert wide_line.count("あ") == 16384


# ====
# 所要の記録と成功時の合計行（#1083）
# ====

_TIMING_RELPATH = Path(".pecot/tmp/githooks-timing.tsv")
_PROFILE_RELPATH = Path(".pecot/tmp/nx-affected-tests/nx-profile.json")


def _timing_rows(h: _AffectedTestsRepo) -> list[list[str]]:
    """記録ファイルの各行を 5 列に分けて返す（ファイルが無ければ空）。"""
    path = h.repo / _TIMING_RELPATH
    if not path.exists():
        return []
    rows = [line.split("\t") for line in read_output(path).splitlines()]
    for row in rows:
        assert len(row) == 5, row
    return rows


def _rows_of(h: _AffectedTestsRepo, kind: str) -> list[list[str]]:
    return [row for row in _timing_rows(h) if row[1] == kind]


@allure.title("成功した場合は、標準出力に合計の 1 行だけを表示する")
def test_success_prints_one_summary_line(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """テストが成功した場合の標準出力のテストです。合計の所要時間、最長のレーン、並列数、レーン数を含む 1 行だけが表示され、profile が決まったパスに保存されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("終了コードと合計行が 1 行だけ出ることを確かめる"):
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


@allure.title("成功した場合は、task の行 3 本と nx の行 1 本を記録する")
def test_success_records_task_and_nx_rows(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """成功した場合の所要時間の記録のテストです。install を含む 3 つの task の行と、`affected` の nx の行が 1 本だけ記録され、hook の行は記録されないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("終了コードと task 行と nx 行の記録を確かめる"):
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


@allure.title("複数の tip で nx を 2 回実行しても、合計の行は 1 行で、レーンは重複して数えない")
def test_multiple_tips_aggregate_lanes_without_duplicates(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """2 つのブランチを push して `nx` が 2 回実行される場合のテストです。nx の行が 2 本、task の行が 6 本記録され、標準出力の合計の行は 1 行でレーン数が重複しないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()
    feature2_sha, _ = _add_second_feature(at_repo, git, git_rev_parse)

    stdin = (
        f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/feature2 {feature2_sha} refs/heads/feature2 {at_repo.main_sha}\n"
    )
    result = _run(script_dir, at_repo, run_script, stdin=stdin)
    with allure.step("終了コードと記録の行数と重複なしの合計行を確かめる"):
        assert result.returncode == 0

        assert len(_rows_of(at_repo, "nx")) == 2
        assert len(_rows_of(at_repo, "task")) == 6
        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert "最長 lane-two:test-unit 2.5s" in lines[0]
        assert "レーン 2" in lines[0]


@allure.title("run-many に切り替えた場合は、nx の行の名前を run-many にして合計の行も表示する")
def test_fallback_records_run_many(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """base を解決できず、`nx run-many` で成功した場合のテストです。nx の行の名前が `run-many` になり、標準出力に合計の行が 1 行表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": at_repo.feature_sha})
    with allure.step("終了コード・nx 行の名前と、run-many の合計行を確かめる"):
        assert result.returncode == 0

        nx_rows = _rows_of(at_repo, "nx")
        assert [r[2] for r in nx_rows] == ["run-many"]
        assert len(result.stdout.splitlines()) == 1
        assert result.stdout.startswith("nx run-many tests: 合計 ")
        assert "レーン 2" in result.stdout


@allure.title("push 情報がなくて run-many に切り替えた場合も、合計の行を 1 行表示する")
def test_no_push_info_fallback_prints_summary(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """push 情報がなく、`nx run-many` にフォールバックした場合のテストです。標準出力に合計の行が 1 行だけ表示され、nx の行の名前が `run-many` になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, stdin="")
    with allure.step("終了コードと合計行が 1 行で nx 行が run-many であることを確かめる"):
        assert result.returncode == 0
        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert lines[0].startswith("nx run-many tests: 合計 ")
        assert [r[2] for r in _rows_of(at_repo, "nx")] == ["run-many"]


@allure.title("affected の対象が 0 件で profile が空の場合は、レーン 0 と表示し、警告を出さない")
def test_empty_profile_reports_zero_lanes_without_warn(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """profile が空の配列になる、affected の対象がない場合のテストです。合計の行に最長なしとレーン 0 が表示され、警告が出力されないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EMPTY_PROFILE": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コードと警告が無いこととレーン 0 の合計行を確かめる"):
        assert result.returncode == 0
        assert "WARN" not in result.stderr

        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert "最長 - / 並列 4 / レーン 0" in lines[0]
        assert _rows_of(at_repo, "task") == []
        nx_rows = _rows_of(at_repo, "nx")
        assert len(nx_rows) == 1
        assert nx_rows[0][4].startswith("parallel=4 lanes=0 longest=- rec=")


@allure.title(
    "profile が存在しない場合は、警告を出すが終了コード 0 のままにして、レーン 0 と表示する"
)
def test_missing_profile_warns_and_keeps_exit_code(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx` が profile を出力しなかった場合のテストです。標準エラー出力に警告が表示されるものの、終了コードは 0 のままで、合計の行にレーン 0 が表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_NO_PROFILE": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コードと profile の警告と合計行を確かめる"):
        assert result.returncode == 0
        assert "WARN" in result.stderr
        assert "profile" in result.stderr

        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert "最長 - / 並列 4 / レーン 0" in lines[0]
        nx_rows = _rows_of(at_repo, "nx")
        assert len(nx_rows) == 1
        assert nx_rows[0][4].startswith("parallel=4 lanes=0 longest=- rec=")


@allure.title("ブランチ削除の push では、標準出力に何も表示せず、記録のファイルも作らない")
def test_skip_push_prints_nothing_and_records_nothing(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx` を起動しないブランチ削除の push のテストです。標準出力が空になり、所要時間の記録ファイルが作成されないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(script_dir, at_repo, run_script, env={"PRE_COMMIT_TO_REF": _ZERO_SHA})
    with allure.step("終了コードと出力が空で記録のファイルが無いことを確かめる"):
        assert result.returncode == 0
        assert result.stdout == ""
        assert not (at_repo.repo / _TIMING_RELPATH).exists()


@allure.title("テストが失敗した場合は、終了コード 1 のまま task の行を記録し、合計の行は表示しない")
def test_failure_records_tasks_without_summary_line(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """テストが失敗した push のテストです。合計の行が表示されず、失敗したレーンの見出しと要約が表示される一方で、task の行には成功と失敗の状態が記録されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_EXIT": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コード 1 と task 行の記録と合計行が出ないことを確かめる"):
        assert result.returncode == 1
        assert "tests: 合計" not in result.stdout + result.stderr
        assert "=== 失敗レーン: lane-two ===" in result.stderr
        assert "Failed tasks:" in result.stderr
        assert "Performance Profile" not in result.stderr

        tasks = {r[2]: r[4] for r in _rows_of(at_repo, "task")}
        assert tasks["lane-two:test-unit"] == "status=failure"
        assert tasks["lane-one:test-unit"] == "status=success"
        assert len(_rows_of(at_repo, "nx")) == 1


@allure.title("nx が profile を出力する前に失敗した場合は、二次的な警告を出さない")
def test_failure_before_profile_does_not_warn(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx` が非 0 で終了し、profile も存在しない場合のテストです。profile が存在しないことへの警告は表示されず、エラーの終了コードだけが案内されることを確認します。"""
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
    with allure.step("終了コード 1 と二次の警告が出ないことを確かめる"):
        assert result.returncode == 1
        assert "WARN" not in result.stderr
        assert "nx exit code: 1" in result.stderr
        nx_rows = _rows_of(at_repo, "nx")
        assert len(nx_rows) == 1
        assert nx_rows[0][4].startswith("parallel=4 lanes=0 longest=- rec=")


@allure.title(
    "profile が途中で途切れた JSON の場合は、警告を出すが終了コード 0 のままにして、レーン 0 と表示する"
)
def test_broken_profile_warns_and_keeps_exit_code(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx` の中断で、profile の JSON が途中までしか書かれていない場合のテストです。警告が表示されるものの終了コードは 0 のままで、合計の行にレーン 0 が表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_BROKEN_PROFILE": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コードと警告と合計行を確かめる"):
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


@allure.title("所要時間が負の値になる場合は、0.0 秒に丸めて合計の行を 1 行表示する")
def test_negative_duration_is_clamped_to_zero(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """壁時計の差で task の所要時間が負になる場合のテストです。負の値が 0.0 に丸められ、終了コード 0 のまま合計の行が 1 行表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_NEGATIVE_DUR": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("負の所要時間が 0.0 に丸められることを確かめる"):
        assert result.returncode == 0
        assert result.stderr == ""

        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert "最長 lane-two:test-unit 2.5s" in lines[0]
        assert "レーン 2" in lines[0]
        tasks = {r[2]: r[3] for r in _rows_of(at_repo, "task")}
        assert tasks["lane-one:test-unit"] == "0.0"


@allure.title("configuration 付きの test の task も、レーンとして数える")
def test_configured_test_task_counts_as_lane(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """task の id が `lane-two:test-unit:ci` のように configuration を含む場合のテストです。レーン名が `<project>:<target>` として数えられ、最長の名前は task の id のまま表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_CONFIGURED": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("configuration 付きの task がレーンに数えられることを確かめる"):
        assert result.returncode == 0

        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert "最長 lane-two:test-unit:ci 2.5s" in lines[0]
        assert "レーン 2" in lines[0]
        nx_rows = _rows_of(at_repo, "nx")
        assert nx_rows[0][4].startswith("parallel=4 lanes=2 longest=lane-two:test-unit:ci rec=")


@allure.title("同じ project の 2 つのレーンは、2 レーンとして数える")
def test_two_lanes_of_the_same_project_count_as_two(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`lane-one:test-unit` と `lane-one:test-hooks` のように、同じ project に 2 つのレーンがある場合のテストです。重複を除く単位が `<project>:<target>` となり、レーン数が 2 になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_SAME_PROJECT": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("同じ project の 2 レーンが 2 つに数えられることを確かめる"):
        assert result.returncode == 0

        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert "レーン 2" in lines[0]
        nx_rows = _rows_of(at_repo, "nx")
        assert " lanes=2 " in nx_rows[0][4]


@allure.title("レーンを束ねる起点の `test` は、レーン数にも最長の判定にも含めない")
def test_aggregator_test_target_is_not_a_lane(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`nx:noop` の起点の task が profile に含まれる場合のテストです。レーン数と最長のレーンの判定から外れ、task の行には記録されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"STUB_NX_AGGREGATOR": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("起点の test がレーンの数と最長に数えられないことを確かめる"):
        assert result.returncode == 0

        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert "最長 lane-two:test-unit 2.5s" in lines[0]
        assert "レーン 2" in lines[0]
        tasks = {r[2] for r in _rows_of(at_repo, "task")}
        assert "lane-one:test" in tasks


@allure.title("2 回目の nx だけ別の task が最長になる場合は、実行をまたいで最長のレーンを選ぶ")
def test_multiple_tips_pick_longest_across_runs(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """2 つのブランチを push し、2 回目の `nx` の task のほうが長い場合のテストです。push 全体の最長として、2 回目の task が合計の行に表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()
    feature2_sha, _ = _add_second_feature(at_repo, git, git_rev_parse)

    stdin = (
        f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/feature2 {feature2_sha} refs/heads/feature2 {at_repo.main_sha}\n"
    )
    result = _run(script_dir, at_repo, run_script, stdin=stdin, env={"STUB_NX_CALL2_LONGER": "1"})
    with allure.step("最長の task が起動をまたいで選ばれることを確かめる"):
        assert result.returncode == 0

        nx_rows = _rows_of(at_repo, "nx")
        assert len(nx_rows) == 2
        assert "longest=lane-two:test-unit " in nx_rows[0][4]
        assert "longest=lane-one:test-unit " in nx_rows[1][4]
        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert "最長 lane-one:test-unit 4.0s" in lines[0]
        assert "レーン 2" in lines[0]


# ====
# CI モード（PECOT_NX_CI=1）: static 出力・bail なし・task の塊で失敗を切り出す
# ====


@allure.title(
    "`PECOT_NX_CI=1` の場合は、affected を `--output-style=static` で実行し、`--nxBail` を付けない"
)
def test_ci_mode_affected_uses_static_without_bail(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """CI のモードで `nx affected` を実行した場合のテストです。起動の引数に `--output-style=static` と `--parallel=4` が含まれ、`--nxBail` が含まれないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PECOT_NX_CI": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("CI モードの affected が static で bail を付けないことを確かめる"):
        assert result.returncode == 0

        affected = [
            ln for ln in read_output(at_repo.nx_log).splitlines() if ln.startswith("affected ")
        ]
        assert len(affected) == 1
        assert "--output-style=static" in affected[0]
        assert "--output-style=stream" not in affected[0]
        assert "--nxBail" not in affected[0]
        assert "--parallel=4" in affected[0]


@allure.title("`PECOT_NX_CI=1` の場合は、run-many も static の出力で実行し、`--nxBail` を付けない")
def test_ci_mode_run_many_uses_static_without_bail(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """CI のモードで `nx run-many` にフォールバックした場合のテストです。起動の引数に `--output-style=static` が含まれ、`--nxBail` が含まれないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PECOT_NX_CI": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("CI モードの run-many が static で bail を付けないことを確かめる"):
        assert result.returncode == 0

        run_many = [
            ln for ln in read_output(at_repo.nx_log).splitlines() if ln.startswith("run-many ")
        ]
        assert len(run_many) == 1
        assert "--output-style=static" in run_many[0]
        assert "--nxBail" not in run_many[0]


@allure.title("`PECOT_NX_CI` が {value} の場合は、stream の出力と `--nxBail` のままにする")
@pytest.mark.parametrize("value", [None, "", "0", "true"])
def test_ci_mode_unset_or_other_value_keeps_stream_and_bail(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, value: str | None
) -> None:
    """`PECOT_NX_CI` を未設定にした場合や、1 以外の値にした場合のテストです。`affected` と `run-many` のどちらも、`--output-style=stream` と `--nxBail` で起動され、static にならないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()
    env = {"PRE_COMMIT_TO_REF": at_repo.feature_sha}
    if value is not None:
        env["PECOT_NX_CI"] = value

    result = _run(script_dir, at_repo, run_script, env=env)
    with allure.step("CI モードが未設定か 1 以外のとき stream と bail のままであることを確かめる"):
        assert result.returncode == 0
        lines = [
            ln for ln in read_output(at_repo.nx_log).splitlines() if ln.startswith("affected ")
        ]
        assert len(lines) == 1
        assert "--nxBail" in lines[0]
        assert "--output-style=stream" in lines[0]
        assert "static" not in lines[0]

        # run-many（push 情報なし）も同じ。
        at_repo.nx_log.write_text("")
        result = _run(
            script_dir, at_repo, run_script, env=dict(env, PRE_COMMIT_TO_REF=""), stdin=""
        )
        assert result.returncode == 0
        many = [ln for ln in read_output(at_repo.nx_log).splitlines() if ln.startswith("run-many ")]
        assert len(many) == 1
        assert "--nxBail" in many[0]
        assert "--output-style=stream" in many[0]


@allure.title("CI のモードで失敗した場合は、失敗した task の塊だけを標準エラー出力に表示する")
def test_ci_mode_failure_reports_only_the_failed_task_chunk(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """static の出力で `p:test-cli` が失敗した場合のテストです。失敗したレーンの本文と要約が表示され、前方一致する `p:test-cli-x` を含む他のレーンの塊は表示されず、ログには全レーン分が残ることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "PECOT_NX_CI": "1",
            "STUB_NX_STATIC": "1",
            "STUB_NX_EXIT": "1",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    with allure.step("失敗したレーンの塊だけが stderr に出ることを確かめる"):
        assert result.returncode == 1
        assert "nx exit code: 1" in result.stderr

        # 失敗の単位は `<project>:<target>`。
        assert "=== 失敗レーン: p:test-cli ===" in result.stderr
        assert "=== 失敗レーン: p:" not in result.stderr.replace(
            "=== 失敗レーン: p:test-cli ===", ""
        )
        assert "> nx run p:test-cli  [local cache]" in result.stderr
        assert "STATIC_FAIL_BODY AssertionError: expected 1 to be 2" in result.stderr
        # 他のレーンの塊は出さない（前方一致の p:test-cli-x も含む）。
        assert "STATIC_PASS_UNIT_BODY" not in result.stderr
        assert "STATIC_PASS_CLIX_BODY" not in result.stderr
        assert "STATIC_PASS_HOOKS_BODY" not in result.stderr
        # 要約は出る。
        assert "Failed tasks:" in result.stderr
        assert "Performance Profile" not in result.stderr
        assert f"全出力: {_hook_log_path(at_repo)}" in result.stderr

        # ログには全レーン分が残る。
        log_text = read_output(_hook_log_path(at_repo))
        assert "STATIC_PASS_UNIT_BODY" in log_text
        assert "STATIC_PASS_HOOKS_BODY" in log_text


@allure.title("CI のモードで終了コード 130 で失敗しても、終了コードを 1 にそろえる")
def test_ci_mode_failure_normalizes_exit_130(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """static の出力で `nx` が終了コード 130 で失敗した場合のテストです。スクリプトの終了コードが 1 に正規化され、元の終了コードが標準エラー出力に案内されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "PECOT_NX_CI": "1",
            "STUB_NX_STATIC": "1",
            "STUB_NX_EXIT": "130",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    with allure.step("終了コード 1 と nx の終了コード 130 の表示を確かめる"):
        assert result.returncode == 1
        assert "nx exit code: 130" in result.stderr


_RECOMMEND_SHAPES = ("multi", "single", "hidden")


def _lane_headings(stderr: str) -> list[str]:
    return [ln for ln in stderr.splitlines() if ln.startswith("=== 失敗レーン:")]


@allure.title(
    "stream の出力で性能レポートの推奨（{shape}）が続いても、失敗したレーンとして拾わない"
)
@pytest.mark.parametrize("shape", _RECOMMEND_SHAPES)
def test_failure_ignores_performance_report_recommendations_in_stream(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, shape: str
) -> None:
    """`nx` の性能レポートに推奨の行（`    - Cache: …` の形）が続く場合のテストです。stream の出力で、失敗したレーンの見出しが `lane-two` の 1 つだけになり、推奨の行は要約として表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "STUB_NX_EXIT": "1",
            "STUB_NX_RECOMMEND": shape,
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    with allure.step("stream で性能レポートの推奨が失敗レーンに拾われないことを確かめる"):
        assert result.returncode == 1
        assert _lane_headings(result.stderr) == ["=== 失敗レーン: lane-two ==="]
        assert "Cache: drop" in result.stderr  # 要約としては出る


@allure.title(
    "static の出力で性能レポートの推奨（{shape}）が続いても、失敗したレーンとして拾わない"
)
@pytest.mark.parametrize("shape", _RECOMMEND_SHAPES)
def test_failure_ignores_performance_report_recommendations_in_static(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, shape: str
) -> None:
    """`nx` の性能レポートに推奨の行が続く場合のテストです。static の出力で、失敗したレーンの見出しが `p:test-cli` の 1 つだけになることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "PECOT_NX_CI": "1",
            "STUB_NX_STATIC": "1",
            "STUB_NX_EXIT": "1",
            "STUB_NX_RECOMMEND": shape,
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    with allure.step("static で性能レポートの推奨が失敗レーンに拾われないことを確かめる"):
        assert result.returncode == 1
        assert _lane_headings(result.stderr) == ["=== 失敗レーン: p:test-cli ==="]


@allure.title(
    "失敗が 2 件で推奨が続く場合も、2 件とも拾い、推奨は拾わない（static が {static} の場合）"
)
@pytest.mark.parametrize("static", [False, True])
def test_failure_with_two_lanes_and_recommendations_reports_both(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, static: bool
) -> None:
    """2 つのレーンが失敗し、その後に性能レポートの推奨が続く場合のテストです。stream と static のどちらでも、失敗したレーンの見出しが 2 つだけ表示され、推奨の行は含まれないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    env = {
        "STUB_NX_EXIT": "1",
        "STUB_NX_FAILED_TWO": "1",
        "STUB_NX_RECOMMEND": "multi",
        "PRE_COMMIT_TO_REF": at_repo.feature_sha,
    }
    if static:
        env.update({"PECOT_NX_CI": "1", "STUB_NX_STATIC": "1"})
    result = _run(script_dir, at_repo, run_script, env=env)
    with allure.step("失敗が 2 件で推奨が続いても 2 件とも拾うことを確かめる"):
        assert result.returncode == 1
        expected = (
            ["=== 失敗レーン: p:test-cli ===", "=== 失敗レーン: q:test-hooks ==="]
            if static
            else ["=== 失敗レーン: lane-two ===", "=== 失敗レーン: lane-one ==="]
        )
        assert _lane_headings(result.stderr) == expected


@allure.title(
    "`PECOT_NX_PARALLEL=2` を指定すると、nx に `--parallel=2` を渡し、表示と記録も並列 2 にする"
)
def test_nx_parallel_env_overrides_default(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`PECOT_NX_PARALLEL` で並列数を指定した場合のテストです。`nx` に渡す引数、標準出力の合計の行、所要時間の記録のすべてで、既定の 4 ではなく指定した 2 が使われることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PECOT_NX_PARALLEL": "2", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("並列の指定が nx と要約と記録に反映されることを確かめる"):
        assert result.returncode == 0
        log = read_output(at_repo.nx_log)
        assert "--parallel=2" in log
        assert "--parallel=4" not in log
        assert "並列 2" in result.stdout
        nx_rows = _rows_of(at_repo, "nx")
        assert nx_rows[0][4].startswith("parallel=2 ")


@allure.title("`PECOT_NX_PARALLEL` が空文字列の場合は、既定の 4 を使う")
def test_nx_parallel_empty_uses_default(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`PECOT_NX_PARALLEL` に空文字列を指定した場合のテストです。`nx` に `--parallel=4` が渡され、標準出力の合計の行にも並列 4 が表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PECOT_NX_PARALLEL": "", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("並列の指定が空のとき既定の 4 になることを確かめる"):
        assert result.returncode == 0
        assert "--parallel=4" in read_output(at_repo.nx_log)
        assert "並列 4" in result.stdout


@allure.title(
    "`PECOT_NX_PARALLEL` が {value} のように正の整数でない場合は、nx を起動せずにエラーで終了する"
)
@pytest.mark.parametrize("value", ["0", "abc", "-1", "2.5", "04", "2 3"])
def test_nx_parallel_invalid_fails_before_nx(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, value: str
) -> None:
    """`PECOT_NX_PARALLEL` に、0・負の値・小数・先頭が 0 の数・空白を含む値などを指定した場合のテストです。終了コードが 1 になり、値を示すエラーが表示され、`nx` が起動されないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PECOT_NX_PARALLEL": value, "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コード 1・ERROR と、nx が起動されないことを確かめる"):
        assert result.returncode == 1
        assert f"ERROR: PECOT_NX_PARALLEL は正の整数です: {value}" in result.stderr
        assert read_output(at_repo.nx_log) == ""


# ====
# lane モード（PECOT_NX_LANE + PECOT_NX_CI=1）: レーン 1 本を run-many で 1 回だけ動かす
# ====

_LANE = "lane-one:test-unit"
_LANE_ENV = {"PECOT_NX_CI": "1", "PECOT_NX_LANE": _LANE}


def _nx_calls(h: _AffectedTestsRepo, sub: str) -> list[str]:
    return [ln for ln in read_output(h.nx_log).splitlines() if ln.startswith(f"{sub} ")]


def _guard_values(h: _AffectedTestsRepo) -> list[str]:
    prefix = "ENV PECOTV_PM_GUARD_BEHAVIOR="
    return [ln[len(prefix) :] for ln in read_output(h.nx_log).splitlines() if ln.startswith(prefix)]


@allure.title("lane モードでは、affected を呼ばず、指定したレーンの run-many を 1 回だけ実行する")
def test_lane_mode_runs_one_lane_with_run_many(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`PECOT_NX_LANE` にレーンを指定して CI のモードで実行した場合のテストです。`nx affected` が呼ばれず、`nx run-many` が指定したレーンだけで 1 回実行され、pm-guard の環境変数が 0 になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={**_LANE_ENV, "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step(
        "lane モードが run-many で 1 レーンを動かし affected を呼ばないことを確かめる"
    ):
        assert result.returncode == 0, result.stderr

        assert _nx_calls(at_repo, "affected") == []
        calls = _nx_calls(at_repo, "run-many")
        assert len(calls) == 1
        assert calls[0].startswith("run-many -t test-unit -p lane-one ")
        assert "--parallel=4" in calls[0]
        assert "--output-style=static" in calls[0]
        assert "--nxBail" not in calls[0]
        assert _guard_values(at_repo) == ["0"]


@allure.title(
    "lane モードでは、ブランチ削除の push でもレーンを 1 回実行し、pm-guard の環境変数は設定しない"
)
def test_lane_mode_skip_tip_still_runs_lane_without_guard(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """lane モードでブランチ削除の push を受けた場合のテストです。`nx run-many` が 1 回だけ実行され、`nx affected` は呼ばれず、`PECOTV_PM_GUARD_BEHAVIOR` が未設定になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir, at_repo, run_script, env={**_LANE_ENV, "PRE_COMMIT_TO_REF": _ZERO_SHA}
    )
    with allure.step("skip の tip でもレーンが 1 回動き、pm-guard が unset であることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert len(_nx_calls(at_repo, "run-many")) == 1
        assert _nx_calls(at_repo, "affected") == []
        assert _guard_values(at_repo) == ["unset"]


@allure.title(
    "lane モードでは、base を解決できない場合もレーンを 1 回だけ実行し、pm-guard の環境変数は設定しない"
)
def test_lane_mode_fallback_runs_lane_once_without_guard(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """lane モードで base を解決できないフォールバックになった場合のテストです。指定したレーンの `nx run-many` が 1 回だけ実行され、`PECOTV_PM_GUARD_BEHAVIOR` が未設定になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature_no_remote("feature", "plugins/pecot-visual/cli/package.json")

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={**_LANE_ENV, "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step(
        "フォールバックでもレーンが 1 回だけ動き、pm-guard が unset であることを確かめる"
    ):
        assert result.returncode == 0, result.stderr
        calls = _nx_calls(at_repo, "run-many")
        assert len(calls) == 1
        assert calls[0].startswith("run-many -t test-unit -p lane-one ")
        assert _guard_values(at_repo) == ["unset"]


@allure.title(
    "lane モードでは、push 情報がなくてもレーンを 1 回実行し、pm-guard の環境変数は設定しない"
)
def test_lane_mode_without_push_info_runs_lane_once(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """lane モードで push 情報が存在しない場合のテストです。`nx run-many` が 1 回だけ実行され、`PECOTV_PM_GUARD_BEHAVIOR` が未設定になることを確認します。"""
    at_repo.install_nx_stub()

    result = _run(script_dir, at_repo, run_script, env=_LANE_ENV)
    with allure.step(
        "push 情報が無くてもレーンが 1 回動き、pm-guard が unset であることを確かめる"
    ):
        assert result.returncode == 0, result.stderr
        assert len(_nx_calls(at_repo, "run-many")) == 1
        assert _guard_values(at_repo) == ["unset"]


@allure.title(
    "lane モードでは、複数の tip でもレーンを 1 回だけ実行し、1 つでも pm-guard の対象があれば 1 にする"
)
def test_lane_mode_multiple_tips_run_lane_once_and_guard_is_one_if_any(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """lane モードで 2 つのブランチを push し、一方に pm-guard の対象の変更がある場合のテストです。`nx run-many` が 1 回だけ実行され、`PECOTV_PM_GUARD_BEHAVIOR` が 1 になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature(changed_path="plugins/pecot-visual/cli/package.json")
    feat1_sha = at_repo.feature_sha
    feat2_sha, _ = _add_second_feature(at_repo, git, git_rev_parse)

    stdin = (
        f"refs/heads/feature {feat1_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/feature2 {feat2_sha} refs/heads/feature2 {at_repo.main_sha}\n"
    )
    result = _run(script_dir, at_repo, run_script, env=_LANE_ENV, stdin=stdin)
    with allure.step("複数の tip でもレーンが 1 回で、pm-guard が 1 であることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert len(_nx_calls(at_repo, "run-many")) == 1
        assert _nx_calls(at_repo, "affected") == []
        assert _guard_values(at_repo) == ["1"]


@allure.title(
    "lane モードでは、pm-guard の対象の tip とフォールバックの tip が並んでも、レーンを 1 回だけ実行し、pm-guard は設定しない"
)
def test_lane_mode_mixed_guard_and_fallback_tips_run_lane_once_without_guard(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, git, git_rev_parse
) -> None:
    """lane モードで、pm-guard の対象になる tip と、base を解決できない tip を同時に push した場合のテストです。全 project の実行を案内する警告が表示され、`nx run-many` が 1 回だけ実行されて、`PECOTV_PM_GUARD_BEHAVIOR` が未設定になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature(changed_path="plugins/pecot-visual/cli/package.json")
    # main と履歴がつながらない commit。merge-base を取れず、フォールバックになる。
    git(at_repo.repo, "checkout", "-q", "--orphan", "orphan")
    git(at_repo.repo, "commit", "-q", "--allow-empty", "-m", "chore: orphan")
    unresolvable = git_rev_parse(at_repo.repo, "HEAD")

    stdin = (
        f"refs/heads/feature {at_repo.feature_sha} refs/heads/feature {at_repo.main_sha}\n"
        f"refs/heads/orphan {unresolvable} refs/heads/orphan {at_repo.main_sha}\n"
    )
    result = _run(script_dir, at_repo, run_script, env=_LANE_ENV, stdin=stdin)
    with allure.step(
        "guard の tip とフォールバックの tip が両方あってもレーンが 1 回で、pm-guard が unset であることを確かめる"
    ):
        assert result.returncode == 0, result.stderr
        assert "全 project の test を実行します" in result.stderr
        assert len(_nx_calls(at_repo, "run-many")) == 1
        assert _nx_calls(at_repo, "affected") == []
        assert _guard_values(at_repo) == ["unset"]


@allure.title("lane に {bad_lane} を指定すると、run-many を呼ばずにエラーで終了する")
@pytest.mark.parametrize(
    "bad_lane",
    [
        "lane-one:test-nothing",  # 集合に無い target
        "lane-one:test",  # まとめ役（nx:noop）
        "lane-one:test-postinstall",  # nx:run-script 由来
        "lane-one:lint",  # test のレーンではない
        "lane-one",  # 不正な形
        "lane-one:test-unit:ci",
        ":test-unit",
        "lane-one:",
    ],
)
def test_lane_mode_rejects_invalid_lane_before_nx_run(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, bad_lane: str
) -> None:
    """`PECOT_NX_LANE` に、存在しない target・束ねる起点・test 以外のレーン・不正な形の値を指定した場合のテストです。終了コードが 1 になり、エラーが表示されて、`nx run-many` と `nx affected` のどちらも呼ばれないことを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "PECOT_NX_CI": "1",
            "PECOT_NX_LANE": bad_lane,
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    with allure.step("終了コード 1・ERROR と、run-many・affected が呼ばれないことを確かめる"):
        assert result.returncode == 1
        assert "ERROR" in result.stderr
        assert _nx_calls(at_repo, "run-many") == []
        assert _nx_calls(at_repo, "affected") == []


@allure.title(
    "指定したレーンの task が profile に存在しない場合は、成功とせずに終了コード 1 で終了する"
)
def test_lane_mode_fails_when_profile_has_no_task_of_the_lane(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """集合に含まれる target であっても、profile にそのレーンの task が存在しない場合のテストです。0 件のまま成功と見なさず、終了コードが 1 になり、task を見つけられないというエラーが表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={
            "PECOT_NX_CI": "1",
            "PECOT_NX_LANE": "lane-two:test-cli",
            "PRE_COMMIT_TO_REF": at_repo.feature_sha,
        },
    )
    with allure.step("終了コード 1 と profile に task が無いエラーを確かめる"):
        assert result.returncode == 1
        assert "lane-two:test-cli の task を nx の profile で見つけられません" in result.stderr


@allure.title(
    "profile が {stub_env} の状態の場合は、レーンの task を確認できないため、終了コード 1 で終了する"
)
@pytest.mark.parametrize("stub_env", ["STUB_NX_EMPTY_PROFILE", "STUB_NX_NO_PROFILE"])
def test_lane_mode_fails_when_profile_is_empty_or_missing(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script, stub_env: str
) -> None:
    """profile が空の配列である場合と、profile が存在しない場合のテストです。レーンの task を確認できないため、終了コードが 1 になり、task を見つけられないというエラーが表示されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={**_LANE_ENV, stub_env: "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("終了コード 1 と profile に task が無いエラーを確かめる"):
        assert result.returncode == 1
        assert "task を nx の profile で見つけられません" in result.stderr


@allure.title("レーンの run-many が失敗すると、終了コード 1 で終了する")
def test_lane_mode_propagates_nx_failure(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """lane モードで `nx run-many` が失敗した場合のテストです。スクリプトの終了コードが 1 になることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={**_LANE_ENV, "STUB_NX_EXIT": "1", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("レーンの run-many が失敗して終了コード 1 になることを確かめる"):
        assert result.returncode == 1


@allure.title(
    "`PECOT_NX_CI=1` がないと、`PECOT_NX_LANE` を警告つきで無視し、従来どおり affected を実行する"
)
def test_lane_is_ignored_with_warn_without_ci_mode(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`PECOT_NX_CI=1` を指定せず、`PECOT_NX_LANE` だけを指定した場合のテストです。警告が表示され、`nx affected` が `--nxBail` つきで 1 回実行されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PECOT_NX_LANE": _LANE, "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("CI モードが無いとレーンの指定が警告つきで無視されることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert "WARN: PECOT_NX_LANE は PECOT_NX_CI=1 のときだけ読みます" in result.stderr
        assert len(_nx_calls(at_repo, "affected")) == 1
        assert _nx_calls(at_repo, "run-many") == []
        assert "--nxBail" in _nx_calls(at_repo, "affected")[0]


@allure.title("`PECOT_NX_LANE` が空の場合は、lane モードにせず、警告も出さない")
def test_empty_lane_env_is_not_lane_mode(
    script_dir: Path, at_repo: _AffectedTestsRepo, run_script
) -> None:
    """`PECOT_NX_CI=1` で `PECOT_NX_LANE` が空文字列の場合のテストです。`PECOT_NX_LANE` に触れる出力が表示されず、`nx affected` が 1 回実行されることを確認します。"""
    at_repo.install_nx_stub()
    at_repo.build_feature()

    result = _run(
        script_dir,
        at_repo,
        run_script,
        env={"PECOT_NX_CI": "1", "PECOT_NX_LANE": "", "PRE_COMMIT_TO_REF": at_repo.feature_sha},
    )
    with allure.step("レーンの指定が空のとき lane モードにならず警告も出ないことを確かめる"):
        assert result.returncode == 0, result.stderr
        assert "PECOT_NX_LANE" not in result.stderr
        assert len(_nx_calls(at_repo, "affected")) == 1
