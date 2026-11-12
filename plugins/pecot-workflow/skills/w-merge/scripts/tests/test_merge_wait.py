"""w-merge の merge-wait.sh を守る。

判定の表は、スクリプトを source して merge_wait_decide へ語を与えて確かめる。
ループは、偽の gh を PATH の先頭に置いて動かす。偽の gh は graphql・rules・code-scanning の
3 種の呼び出しを見分けて fixture を返し、--jq の式を本物の jq に当てる。
"""

from __future__ import annotations

import copy
import json
import os
import re
import stat
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "merge-wait.sh"
SKILL = Path(__file__).resolve().parents[2] / "SKILL.md"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

# 偽の gh。キューの先頭から応答を 1 つずつ返す。キューが尽きたら 98 で落ちる（= gh の失敗として数えられる）。
# {"__error__": "<stderr>"} の応答は、その文面を stderr に出して 1 で落ちる。
FAKE_GH = r"""#!/usr/bin/env python3
import json, os, subprocess, sys
argv = sys.argv[1:]
base = "__BASE__"
assert argv[0] == "api", argv
jq_expr = argv[argv.index("--jq") + 1] if "--jq" in argv else "."

def emit(path):
    data = json.load(open(path))
    if isinstance(data, dict) and "__error__" in data:
        sys.stderr.write(data["__error__"] + "\n")
        sys.exit(1)
    sys.exit(subprocess.run(["jq", "-r", jq_expr, path]).returncode)

def log(kind):
    with open(os.path.join(base, "calls"), "a") as f:
        f.write(kind + "\n")

if argv[1] == "graphql":
    n = [a for a in argv if a.startswith("n=")][0][2:]
    if not n.isdigit():
        sys.exit(99)
    log("graphql")
    counter = os.path.join(base, "count")
    done = int(open(counter).read()) if os.path.exists(counter) else 0
    src = os.path.join(base, "queue", f"{done + 1}.json")
    if not os.path.exists(src):
        sys.stderr.write("gh: queue exhausted (HTTP 502)\n")
        sys.exit(98)
    open(counter, "w").write(str(done + 1))
    emit(src)
elif "/rules/branches/" in argv[1]:
    log("rules")
    emit(os.path.join(base, "rules.json"))
elif "/code-scanning/alerts" in argv[1]:
    assert "state=open" in argv[1] and "pr=" in argv[1], argv[1]
    log("code-scanning")
    emit(os.path.join(base, "alerts.json"))
else:
    sys.exit(97)
"""


def _load(name: str) -> dict:
    return json.loads((FIXTURES / f"pr_{name}.json").read_text(encoding="utf-8"))


def _rules() -> list[dict]:
    return json.loads((FIXTURES / "rules_main.json").read_text(encoding="utf-8"))


def _alerts() -> list[dict]:
    return json.loads((FIXTURES / "code_scanning_alerts.json").read_text(encoding="utf-8"))


def _variant(
    base: str,
    *,
    state=None,
    queue=None,
    auto=None,
    mergeable=None,
    mss=None,
    contexts="keep",
) -> dict:
    """fixture を元にして、判定が読む欄だけ差し替える。contexts を替えたら件数の欄も揃える。"""
    data = copy.deepcopy(_load(base))
    pr = data["data"]["repository"]["pullRequest"]
    if state is not None:
        pr["state"] = state
    if queue is not None:
        pr["isInMergeQueue"] = queue
    if auto is not None:
        pr["autoMergeRequest"] = {"enabledAt": "2026-11-10T00:00:00Z"} if auto else None
    if mergeable is not None:
        pr["mergeable"] = mergeable
    if mss is not None:
        pr["mergeStateStatus"] = mss
    if contexts != "keep":
        ctx = pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]
        ctx["nodes"] = contexts
        runs = [c for c in contexts if "context" not in c]
        stats = [c for c in contexts if "context" in c]
        ctx["checkRunCount"] = len(runs)
        ctx["statusContextCount"] = len(stats)
        for entry in ctx["checkRunCountsByState"]:
            entry["count"] = sum(
                1 for c in runs if (c.get("conclusion") or c.get("status")) == entry["state"]
            )
        for entry in ctx["statusContextCountsByState"]:
            entry["count"] = sum(1 for c in stats if c["state"] == entry["state"])
    return data


def _run_check(name, conclusion="SUCCESS", required=True, status="COMPLETED") -> dict:
    return {"name": name, "conclusion": conclusion, "status": status, "isRequired": required}


def _run_pending(name, required=True, status="IN_PROGRESS") -> dict:
    return {"name": name, "conclusion": None, "status": status, "isRequired": required}


def _ctx_status(name, state, required=True) -> dict:
    return {"context": name, "state": state, "isRequired": required}


def _make_runner(tmp_path: Path):
    """偽の gh と作業ディレクトリを用意し、run(responses, ...) を返す。"""
    base = tmp_path / "fake"
    bindir = tmp_path / "bin"
    (base / "queue").mkdir(parents=True)
    bindir.mkdir()
    gh = bindir / "gh"
    gh.write_text(FAKE_GH.replace("__BASE__", str(base)), encoding="utf-8")
    gh.chmod(gh.stat().st_mode | stat.S_IXUSR)

    def run(
        responses: list[dict],
        *args: str,
        rules=None,
        alerts=None,
        default_args=("--interval", "0", "--settle-seconds", "0"),
    ) -> subprocess.CompletedProcess:
        for i, resp in enumerate(responses, start=1):
            (base / "queue" / f"{i}.json").write_text(json.dumps(resp), encoding="utf-8")
        (base / "rules.json").write_text(
            json.dumps(_rules() if rules is None else rules), encoding="utf-8"
        )
        (base / "alerts.json").write_text(
            json.dumps(_alerts() if alerts is None else alerts), encoding="utf-8"
        )
        env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}"}
        return subprocess.run(
            ["bash", str(SCRIPT), "pecotcraft/pecot/361", *default_args, *args],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def calls() -> list[str]:
        f = base / "calls"
        return f.read_text().split() if f.exists() else []

    run.calls = calls  # type: ignore[attr-defined]
    return run


@pytest.fixture
def runner(tmp_path):
    assert subprocess.run(["jq", "--version"], capture_output=True).returncode == 0
    return _make_runner(tmp_path)


def _decide(*words: str) -> str:
    proc = subprocess.run(
        ["bash", "-c", f'source "{SCRIPT}"; merge_wait_decide "$@"', "_", *words],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.strip()


# --- 判定の表 -------------------------------------------------------------------

# 引数: state in_queue auto_merge mergeable required_failed checks_running mergeStateStatus
DECIDE_CASES = [
    pytest.param(
        ("MERGED", "false", "false", "UNKNOWN", "false", "false", "UNKNOWN"),
        "exit:merged",
        id="1-merged",
    ),
    pytest.param(
        ("CLOSED", "false", "false", "UNKNOWN", "false", "false", "UNKNOWN"),
        "exit:closed",
        id="2-closed",
    ),
    pytest.param(
        ("OPEN", "false", "true", "CONFLICTING", "false", "true", "DIRTY"),
        "exit:conflicting",
        id="3-conflicting",
    ),
    pytest.param(
        ("OPEN", "false", "true", "MERGEABLE", "true", "true", "BLOCKED"),
        "exit:required-failed",
        id="4-required-failed",
    ),
    pytest.param(
        ("OPEN", "true", "false", "MERGEABLE", "false", "false", "BLOCKED"),
        "wait:in-queue",
        id="5-in-queue",
    ),
    pytest.param(
        ("OPEN", "false", "true", "MERGEABLE", "false", "true", "BLOCKED"),
        "wait:checks-running",
        id="6-checks-running",
    ),
    pytest.param(
        ("OPEN", "false", "false", "MERGEABLE", "false", "false", "CLEAN"),
        "exit:not-queued",
        id="7-not-queued",
    ),
    pytest.param(
        ("OPEN", "false", "true", "MERGEABLE", "false", "false", "CLEAN"),
        "exit:blocked",
        id="8-blocked",
    ),
    # Issue の Repro（PR #361）: 必須チェックは通り、queue に入らず、mergeStateStatus が BLOCKED
    pytest.param(
        ("OPEN", "false", "true", "MERGEABLE", "false", "false", "BLOCKED"),
        "exit:blocked",
        id="repro-361-blocked",
    ),
    # 未知の mergeStateStatus は、列挙に無いので抜ける
    pytest.param(
        ("OPEN", "false", "true", "MERGEABLE", "false", "false", "SOME_FUTURE_VALUE"),
        "exit:blocked",
        id="unknown-mss",
    ),
    pytest.param(
        ("OPEN", "false", "true", "SOME_FUTURE_VALUE", "false", "false", "BLOCKED"),
        "exit:blocked",
        id="unknown-mergeable",
    ),
    pytest.param(
        ("OPEN", "false", "true", "UNKNOWN", "false", "false", "UNKNOWN"),
        "exit:blocked",
        id="mss-unknown-computing",
    ),
    # 必須の名前が未報告（running=true）の間は待つ。チェックが 1 件も無く必須の名前も取れないなら待たない
    pytest.param(
        ("OPEN", "false", "true", "MERGEABLE", "false", "true", "BLOCKED"),
        "wait:checks-running",
        id="required-unreported",
    ),
    pytest.param(
        ("OPEN", "false", "true", "MERGEABLE", "false", "false", "BLOCKED"),
        "exit:blocked",
        id="no-checks-at-all",
    ),
]


@pytest.mark.parametrize(("words", "expected"), DECIDE_CASES)
def test_decide_table(words, expected):
    assert _decide(*words) == expected


def test_sourcing_does_not_change_shell_options():
    proc = subprocess.run(
        ["bash", "-c", f'source "{SCRIPT}"; echo "$-"'], capture_output=True, text=True, timeout=10
    )
    assert proc.returncode == 0
    assert "e" not in proc.stdout.strip() and "u" not in proc.stdout.strip()


# --- ループ: すぐ抜ける状態 -------------------------------------------------------

MERGED = _load("265")

EXIT_CASES = [
    pytest.param(
        _load("265"),
        "merged",
        0,
        "MERGED queue=false auto-merge=false mergeable=UNKNOWN mergeStateStatus=UNKNOWN required=passed checks-pending=0",
        id="merged",
    ),
    pytest.param(
        _variant("262", auto=True, mergeable="CONFLICTING"),
        "conflicting",
        1,
        "OPEN queue=false auto-merge=true mergeable=CONFLICTING mergeStateStatus=CLEAN required=passed checks-pending=0",
        id="conflicting-with-auto-merge",
    ),
    pytest.param(
        _variant("263", auto=True),
        "required-failed",
        1,
        "OPEN queue=false auto-merge=true mergeable=MERGEABLE mergeStateStatus=BLOCKED required=failed checks-pending=0",
        id="required-checkrun-failed-with-auto-merge",
    ),
    pytest.param(
        _variant("262", auto=True, contexts=[_ctx_status("ci-result", "FAILURE")]),
        "required-failed",
        1,
        None,
        id="required-statuscontext-failure",
    ),
    pytest.param(
        _variant("262", auto=True, contexts=[_ctx_status("ci-result", "ERROR")]),
        "required-failed",
        1,
        None,
        id="required-statuscontext-error",
    ),
    pytest.param(_load("263"), "required-failed", 1, None, id="no-auto-merge-required-failed"),
    pytest.param(
        _load("262"),
        "not-queued",
        1,
        "OPEN queue=false auto-merge=false mergeable=MERGEABLE mergeStateStatus=CLEAN required=passed checks-pending=0",
        id="left-queue",
    ),
    pytest.param(
        _variant("262", state="CLOSED", mergeable="UNKNOWN"),
        "closed",
        1,
        None,
        id="closed",
    ),
]


@pytest.mark.parametrize(("response", "reason", "code", "state_line"), EXIT_CASES)
def test_loop_exits_with_reason(runner, response, reason, code, state_line):
    proc = runner([response])
    assert proc.returncode == code, proc.stderr
    lines = proc.stdout.splitlines()
    assert lines[0] == f"merge-wait: {reason}"
    if state_line is not None:
        assert lines[1] == f"state: {state_line}"
    # 3 行目以降は blocked と stalled のときだけ
    assert len(lines) == 2


# --- ループ: 待つ状態 -------------------------------------------------------------

WAIT_CASES = [
    pytest.param(
        _variant(
            "262",
            auto=True,
            contexts=[
                _run_check("tests (x)", "FAILURE", required=False),
                _run_pending("ci-result"),
                _run_check("version-plan"),
            ],
        ),
        id="required-running-and-only-non-required-failed",
    ),
    pytest.param(
        _variant(
            "262",
            auto=True,
            contexts=[
                _run_check("ci-result"),
                _run_check("version-plan"),
                _run_pending("tests (slow)", required=False),
            ],
        ),
        id="non-required-still-running",
    ),
    pytest.param(
        _variant(
            "262",
            auto=True,
            contexts=[_run_pending("ci-result", status="QUEUED"), _run_check("version-plan")],
        ),
        id="required-queued",
    ),
    pytest.param(
        _variant(
            "262",
            auto=True,
            contexts=[_ctx_status("ci-result", "PENDING"), _run_check("version-plan")],
        ),
        id="statuscontext-pending",
    ),
    pytest.param(
        _variant("262", auto=True, contexts=[_run_check("version-plan")]),
        id="ruleset-required-not-yet-reported",
    ),
    pytest.param(
        _variant("262", queue=True, auto=False),
        id="in-merge-queue",
    ),
]


@pytest.mark.parametrize("response", WAIT_CASES)
def test_loop_keeps_waiting_until_next_response(runner, response):
    proc = runner([response, MERGED])
    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.splitlines()
    assert lines[0] == "merge-wait: merged"
    assert runner.calls().count("graphql") == 2


def test_rules_are_read_once_at_start(runner):
    runner(
        [_variant("262", auto=True, contexts=[_run_pending("ci-result")]) for _ in range(3)]
        + [MERGED],
    )
    assert runner.calls().count("rules") == 1
    assert runner.calls().count("graphql") == 4


def test_rules_read_failure_does_not_stop_waiting(runner, tmp_path):
    # rules が読めなくても、queue の中は待ち、MERGED で抜ける
    proc = runner(
        [_variant("262", queue=True, auto=False), MERGED],
        rules={"__error__": "gh: Forbidden (HTTP 403)"},
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines()[0] == "merge-wait: merged"


# --- blocked の出力 ---------------------------------------------------------------


def test_blocked_by_code_scanning_prints_state_rules_and_alerts(runner):
    # PR #361: 必須チェックは通り、auto-merge の予約があり、ruleset の code_scanning が止めている
    resp = _variant(
        "262",
        auto=True,
        mss="BLOCKED",
        contexts=[_run_check("ci-result"), _run_check("version-plan")],
    )
    proc = runner([resp])
    assert proc.returncode == 1, proc.stderr
    assert proc.stdout.splitlines() == [
        "merge-wait: blocked",
        "state: OPEN queue=false auto-merge=true mergeable=MERGEABLE mergeStateStatus=BLOCKED required=passed checks-pending=0",
        "rules(main): deletion, non_fast_forward, pull_request, required_status_checks, merge_queue, code_scanning",
        "code-scanning open alerts: #28 #29",
    ]


def test_blocked_without_code_scanning_rule_skips_alert_query(runner):
    rules = [r for r in _rules() if r["type"] != "code_scanning"]
    resp = _variant(
        "262",
        auto=True,
        mss="BLOCKED",
        contexts=[_run_check("ci-result"), _run_check("version-plan")],
    )
    proc = runner([resp], rules=rules)
    assert proc.returncode == 1
    assert "code-scanning" not in proc.stdout
    assert "code-scanning" not in runner.calls()


def test_blocked_with_no_open_alerts(runner):
    resp = _variant(
        "262",
        auto=True,
        mss="BLOCKED",
        contexts=[_run_check("ci-result"), _run_check("version-plan")],
    )
    proc = runner([resp], alerts=[])
    assert proc.stdout.splitlines()[-1] == "code-scanning open alerts: なし"


def test_blocked_with_unknown_merge_state_status(runner):
    resp = _variant(
        "262",
        auto=True,
        mss="SOME_FUTURE_VALUE",
        contexts=[_run_check("ci-result"), _run_check("version-plan")],
    )
    proc = runner([resp])
    assert proc.returncode == 1
    assert proc.stdout.splitlines()[0] == "merge-wait: blocked"
    assert "mergeStateStatus=SOME_FUTURE_VALUE" in proc.stdout.splitlines()[1]


def test_extra_query_failures_keep_first_two_lines(runner):
    resp = _variant(
        "262",
        auto=True,
        mss="BLOCKED",
        contexts=[_run_check("ci-result"), _run_check("version-plan")],
    )
    proc = runner(
        [resp],
        rules={"__error__": "gh: Resource not accessible (HTTP 403)"},
    )
    lines = proc.stdout.splitlines()
    assert proc.returncode == 1
    assert lines[0] == "merge-wait: blocked"
    assert lines[1].startswith("state: OPEN ")
    assert lines[2] == "rules(main): 取得できない (HTTP 403)"


def test_alert_query_failure_prints_unavailable_with_http_status(runner):
    resp = _variant(
        "262",
        auto=True,
        mss="BLOCKED",
        contexts=[_run_check("ci-result"), _run_check("version-plan")],
    )
    proc = runner(
        [resp],
        alerts={"__error__": "gh: Resource not accessible by personal access token (HTTP 403)"},
    )
    lines = proc.stdout.splitlines()
    assert lines[0] == "merge-wait: blocked"
    assert lines[2].startswith("rules(main): ")
    assert lines[3] == "code-scanning open alerts: 取得できない (HTTP 403)"


# --- settle ---------------------------------------------------------------------


def test_blocked_then_merged_does_not_exit_during_settle(runner):
    blocked = _variant(
        "262",
        auto=True,
        mss="BLOCKED",
        contexts=[_run_check("ci-result"), _run_check("version-plan")],
    )
    proc = runner([blocked, MERGED], default_args=("--interval", "0"))  # settle は既定の 120 秒
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines()[0] == "merge-wait: merged"
    assert runner.calls().count("graphql") == 2


def test_not_queued_then_queue_does_not_exit_during_settle(runner):
    left = _load("262")
    queued = _variant("262", queue=True, auto=False)
    proc = runner([left, queued, MERGED], default_args=("--interval", "0"))
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines()[0] == "merge-wait: merged"


def test_blocked_exits_once_settle_elapsed(runner):
    blocked = _variant(
        "262",
        auto=True,
        mss="BLOCKED",
        contexts=[_run_check("ci-result"), _run_check("version-plan")],
    )
    proc = runner([blocked, blocked], "--settle-seconds", "0")
    assert proc.returncode == 1
    assert runner.calls().count("graphql") == 1


# --- stalled ----------------------------------------------------------------------


def test_same_wait_state_exits_stalled(runner):
    running = _variant(
        "262", auto=True, contexts=[_run_pending("ci-result"), _run_check("version-plan")]
    )
    proc = runner([running, running, running, MERGED], "--stall-minutes", "0")
    assert proc.returncode == 1, proc.stderr
    lines = proc.stdout.splitlines()
    assert lines[0] == "merge-wait: stalled"
    assert lines[1].startswith("state: OPEN queue=false auto-merge=true")
    assert "checks-pending=1" in lines[1]
    assert lines[2].startswith("rules(main): ")
    assert runner.calls().count("graphql") == 2


def test_changing_state_does_not_stall(runner):
    a = _variant("262", auto=True, contexts=[_run_pending("ci-result"), _run_check("version-plan")])
    b = _variant(
        "262", auto=True, contexts=[_run_pending("ci-result"), _run_pending("version-plan")]
    )
    proc = runner([a, b, a, MERGED], "--stall-minutes", "0")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines()[0] == "merge-wait: merged"


# --- query-failed -----------------------------------------------------------------


def test_three_consecutive_gh_failures_exit_query_failed(runner):
    err = {"__error__": "gh: Bad Gateway (HTTP 502)"}
    proc = runner([err, err, err, MERGED])
    assert proc.returncode == 1
    lines = proc.stdout.splitlines()
    assert lines[0] == "merge-wait: query-failed"
    assert lines[1] == "state: 取得できない"
    assert "gh: Bad Gateway (HTTP 502)" in proc.stdout
    assert runner.calls().count("graphql") == 3


def test_failures_are_counted_only_when_consecutive(runner):
    err = {"__error__": "gh: Bad Gateway (HTTP 502)"}
    proc = runner([err, err, _variant("262", queue=True, auto=False), err, err, MERGED])
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines()[0] == "merge-wait: merged"


# --- 引数 -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "args",
    [
        pytest.param([], id="no-target"),
        pytest.param(["not-a-target"], id="bad-target"),
        pytest.param(["--interval", "x"], id="bad-interval"),
        pytest.param(["--unknown"], id="unknown-option"),
    ],
)
def test_bad_arguments_exit_2(args):
    proc = subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, timeout=10)
    assert proc.returncode == 2
    assert proc.stdout == ""
    assert "usage:" in proc.stderr


def test_script_is_executable():
    assert os.access(SCRIPT, os.X_OK)


# --- SKILL.md ---------------------------------------------------------------------


def _step_2_2() -> str:
    text = SKILL.read_text(encoding="utf-8")
    start = text.index("#### 2.2")
    end = text.index("#### 2.3")
    return text[start:end]


def test_skill_calls_script_without_until_loop():
    section = _step_2_2()
    match = re.search(r"```bash\n(.*?)\n```", section, re.DOTALL)
    assert match is not None, "2.2 の下に bash ブロックが無い"
    block = match.group(1)
    assert block == 'bash "${CLAUDE_SKILL_DIR}/scripts/merge-wait.sh" <owner>/<repo>/<PR番号>'
    assert "until" not in block
    assert SCRIPT.exists()
