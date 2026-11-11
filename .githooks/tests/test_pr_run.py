"""lib/pr-run.sh のユニットテスト。関数を bash で source して呼び、return と stdout を見る。偽の gh は URL ごとのフィクスチャを返す。"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

REPO = "o/r"

_FAKE_GH = """#!/usr/bin/env bash
url=""
for a in "$@"; do
    case "$a" in -*|api) ;; *) url="$a" ;; esac
done
f="$FAKE_GH_DIR/${url//[^A-Za-z0-9]/_}"
[ -f "$f" ] || exit 1
cat "$f"
"""


@pytest.fixture
def call(tmp_path: Path, githooks_dir: Path):
    fake = tmp_path / "fake"
    fake.mkdir()
    gh = tmp_path / "bin" / "gh"
    gh.parent.mkdir()
    gh.write_text(_FAKE_GH)
    gh.chmod(0o755)

    def run(body: str, stdin: str = "", api: dict[str, object] | None = None):
        for url, payload in (api or {}).items():
            (fake / re.sub(r"[^A-Za-z0-9]", "_", url)).write_text(json.dumps(payload))
        script = f'source "{githooks_dir}/lib/pr-run.sh"\n{body}'
        env = {
            **os.environ,
            "PATH": f"{gh.parent}:{os.environ['PATH']}",
            "FAKE_GH_DIR": str(fake),
        }
        return subprocess.run(
            ["bash", "-c", script], env=env, input=stdin, capture_output=True, text=True
        )

    return run


@pytest.mark.parametrize(
    "head_ref",
    [
        "refs/heads/gh-readonly-queue/main/pr-7-" + "a" * 40,
        "gh-readonly-queue/main/pr-7-" + "a" * 40,
        "gh-readonly-queue/feat/x/pr-7-" + "a" * 40,
    ],
)
def test_pr_number_from_head_ref(call, head_ref: str) -> None:
    r = call(f'pr_number_from_head_ref "{head_ref}"')
    assert (r.returncode, r.stdout) == (0, "7\n")


@pytest.mark.parametrize("head_ref", ["", "refs/heads/other", "gh-readonly-queue/main/pr-x-abc"])
def test_pr_number_from_head_ref_unreadable(call, head_ref: str) -> None:
    r = call(f'pr_number_from_head_ref "{head_ref}"')
    assert (r.returncode, r.stdout) == (1, "")


def _pull(sha: str, head_repo: str | None) -> dict:
    return {"head": {"sha": sha, "repo": {"full_name": head_repo} if head_repo else None}}


def test_pr_load_head_same_repo(call) -> None:
    r = call(
        f'pr_load_head {REPO} 7; echo "$? $PR_HEAD_SHA $PR_HEAD_REPO"',
        api={f"repos/{REPO}/pulls/7": _pull("abc", REPO)},
    )
    assert r.stdout == f"0 abc {REPO}\n"


@pytest.mark.parametrize("head_repo", ["evil/r", None])
def test_pr_load_head_fork_or_deleted_repo(call, head_repo: str | None) -> None:
    r = call(
        'pr_load_head o/r 7; echo "$?"',
        api={f"repos/{REPO}/pulls/7": _pull("abc", head_repo)},
    )
    assert r.stdout == "2\n"


def test_pr_load_head_api_failure(call) -> None:
    r = call('pr_load_head o/r 7; echo "$?"')
    assert r.stdout == "1\n"


@pytest.mark.parametrize(
    ("run", "expected"),
    [
        ({"event": "pull_request", "pull_requests": [{"number": 7}]}, 0),
        ({"event": "pull_request", "pull_requests": [{"number": 8}, {"number": 7}]}, 0),
        ({"event": "pull_request", "pull_requests": [{"number": 8}]}, 1),
        ({"event": "pull_request", "pull_requests": []}, 1),
        ({"event": "pull_request"}, 1),
        ({"event": "push", "pull_requests": [{"number": 7}]}, 1),
    ],
)
def test_pr_run_is_for_pr(call, run: dict, expected: int) -> None:
    r = call("pr_run_is_for_pr 7; echo $?", stdin=json.dumps(run))
    assert r.stdout == f"{expected}\n"
