"""w-merge Step 2.2 のマージ待ちループを、SKILL.md のコードブロックのまま動かして守る。

偽の gh は応答の JSON を 1 つずつ返し、--jq の式を本物の jq に当てる。
偽の sleep は呼ばれた回数を数え、上限を超えたらループを動かすシェルを止める。
"""

import copy
import json
import os
import re
import stat
import subprocess
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SKILL = PLUGIN_ROOT / "skills" / "w-merge" / "SKILL.md"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "merge_wait"

SLEEP_LIMIT = 10

FAKE_GH = r"""#!/usr/bin/env python3
import json, os, subprocess, sys
argv = sys.argv[1:]
queue = os.environ["FAKE_QUEUE_DIR"]
jq_expr = argv[argv.index("--jq") + 1]
n = [a for a in argv if a.startswith("n=")][0][2:]
if not n.isdigit():
    sys.exit(99)
counter = os.path.join(queue, "count")
done = int(open(counter).read()) if os.path.exists(counter) else 0
src = os.path.join(queue, f"{done + 1}.json")
if not os.path.exists(src):
    sys.exit(98)
open(counter, "w").write(str(done + 1))
sys.exit(subprocess.run(["jq", "-r", jq_expr, src]).returncode)
"""

FAKE_SLEEP = r"""#!/usr/bin/env bash
f="$FAKE_QUEUE_DIR/sleeps"
n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$f"
if [ "$n" -gt "$FAKE_SLEEP_LIMIT" ]; then kill -TERM "$PPID"; fi
"""


def _load(name: str) -> dict:
    return json.loads((FIXTURES / f"pr_{name}.json").read_text(encoding="utf-8"))


def _variant(
    base: str, *, state=None, queue=None, auto=None, mergeable=None, contexts="keep", rollup="keep"
) -> dict:
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
    commit = pr["commits"]["nodes"][0]["commit"]
    if rollup is None:
        commit["statusCheckRollup"] = None
    if contexts != "keep":
        commit["statusCheckRollup"]["contexts"]["nodes"] = contexts
    return data


def _loop_block() -> str:
    text = SKILL.read_text(encoding="utf-8")
    after = text[text.index("#### 2.2") :]
    match = re.search(r"```bash\n(.*?)\n```", after, re.DOTALL)
    assert match is not None, "2.2 の下に bash ブロックが無い"
    block = match.group(1)
    block = (
        block.replace("<owner>", "pecotcraft").replace("<repo>", "pecot").replace("<PR番号>", "265")
    )
    assert "<" not in block and ">" not in block, f"プレースホルダが残っている: {block}"
    return block


def _run(tmp_path: Path, responses: list[dict]) -> tuple[subprocess.CompletedProcess, int]:
    assert subprocess.run(["jq", "--version"], capture_output=True).returncode == 0
    queue = tmp_path / "queue"
    bindir = tmp_path / "bin"
    queue.mkdir()
    bindir.mkdir()
    for i, resp in enumerate(responses, start=1):
        (queue / f"{i}.json").write_text(json.dumps(resp), encoding="utf-8")
    for name, body in (("gh", FAKE_GH), ("sleep", FAKE_SLEEP)):
        path = bindir / name
        path.write_text(body, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
    env = {
        **os.environ,
        "PATH": f"{bindir}:{os.environ['PATH']}",
        "FAKE_QUEUE_DIR": str(queue),
        "FAKE_SLEEP_LIMIT": str(SLEEP_LIMIT),
    }
    proc = subprocess.run(
        ["bash", "-c", _loop_block()], env=env, capture_output=True, text=True, timeout=30
    )
    sleeps_file = queue / "sleeps"
    sleeps = int(sleeps_file.read_text()) if sleeps_file.exists() else 0
    return proc, sleeps


def _required_ctx(**kw) -> dict:
    return {**kw, "isRequired": True}


EXIT_CASES = [
    pytest.param(_load("265"), "MERGED false false UNKNOWN -", id="merged"),
    pytest.param(
        _variant("262", auto=True, mergeable="CONFLICTING"),
        "OPEN false true CONFLICTING -",
        id="conflicting-with-auto-merge",
    ),
    pytest.param(
        _variant("263", auto=True),
        "OPEN false true MERGEABLE required-failed",
        id="required-checkrun-failed-with-auto-merge",
    ),
    pytest.param(
        _variant("262", auto=True, contexts=[_required_ctx(state="FAILURE")]),
        "OPEN false true MERGEABLE required-failed",
        id="required-statuscontext-failure",
    ),
    pytest.param(
        _variant("262", auto=True, contexts=[_required_ctx(state="ERROR")]),
        "OPEN false true MERGEABLE required-failed",
        id="required-statuscontext-error",
    ),
    pytest.param(
        _load("263"),
        "OPEN false false MERGEABLE required-failed",
        id="no-auto-merge-required-failed",
    ),
    pytest.param(_load("262"), "OPEN false false MERGEABLE -", id="left-queue"),
    pytest.param(
        _variant("262", state="CLOSED", mergeable="UNKNOWN"),
        "CLOSED false false UNKNOWN -",
        id="closed",
    ),
]

MERGED = _load("265")

WAIT_CASES = [
    pytest.param(
        _variant(
            "262",
            auto=True,
            contexts=[
                {"conclusion": "FAILURE", "isRequired": False},
                _required_ctx(conclusion="SUCCESS"),
            ],
        ),
        "OPEN false true MERGEABLE -",
        id="only-non-required-failed",
    ),
    pytest.param(
        _variant(
            "262",
            auto=True,
            contexts=[
                _required_ctx(conclusion="SKIPPED"),
                _required_ctx(conclusion="NEUTRAL"),
                _required_ctx(conclusion="SUCCESS"),
                _required_ctx(state="SUCCESS"),
            ],
        ),
        "OPEN false true MERGEABLE -",
        id="required-passed",
    ),
    pytest.param(
        _variant("262", auto=True, contexts=[_required_ctx(conclusion=None)]),
        "OPEN false true MERGEABLE -",
        id="required-running",
    ),
    pytest.param(
        _variant("262", auto=True, mergeable="UNKNOWN"),
        "OPEN false true UNKNOWN -",
        id="mergeable-unknown",
    ),
    pytest.param(
        _variant("262", queue=True, auto=False),
        "OPEN true false MERGEABLE -",
        id="in-merge-queue",
    ),
    pytest.param(
        _variant("262", auto=True, rollup=None),
        "OPEN false true MERGEABLE -",
        id="rollup-null",
    ),
]


def test_block_is_runnable_without_placeholders():
    assert _loop_block().startswith("until ")


@pytest.mark.parametrize(("response", "expected"), EXIT_CASES)
def test_loop_exits_with_five_words(tmp_path, response, expected):
    proc, sleeps = _run(tmp_path, [response])
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().splitlines()[-1] == expected
    assert sleeps == 0


@pytest.mark.parametrize(("response", "state_line"), WAIT_CASES)
def test_loop_keeps_waiting_until_next_response(tmp_path, response, state_line):
    proc, sleeps = _run(tmp_path, [response, MERGED])
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().splitlines()[-1] == "MERGED false false UNKNOWN -"
    assert sleeps == 1, f"待ち続けず抜けたか、余計に待った: {state_line}"
