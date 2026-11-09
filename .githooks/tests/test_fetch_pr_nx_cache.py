"""fetch-pr-nx-cache.sh のユニットテスト。偽の gh は URL ごとのフィクスチャ（無ければ API 失敗）を返す。"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

REPO = "o/r"
OWN_RUN = "900"
BASE_SHA = "b" * 40
HEAD = "a1" * 20
OLD = "c2" * 20

_FAKE_GH = """#!/usr/bin/env bash
url=""
for a in "$@"; do
    case "$a" in -*|api) ;; *) url="$a" ;; esac
done
echo "$url" >> "$FAKE_GH_DIR/calls.log"
f="$FAKE_GH_DIR/${url//[^A-Za-z0-9]/_}"
[ -f "$f" ] || exit 1
cat "$f"
"""


ART = "nx-cache-tests-x"
REPO_ID = 42
ARTIFACTS_URL = f"repos/{REPO}/actions/artifacts?name={ART}&per_page=100"


def _art(
    run_id: int,
    sha: str,
    created: str,
    repo_id: int = REPO_ID,
    expired: bool = False,
) -> dict:
    return {
        "id": run_id * 10,
        "name": ART,
        "expired": expired,
        "created_at": created,
        "workflow_run": {"id": run_id, "head_sha": sha, "head_repository_id": repo_id},
    }


class Env:
    def __init__(self, tmp_path: Path, script: Path) -> None:
        self.fake = tmp_path / "fake"
        self.fake.mkdir()
        gh = tmp_path / "bin" / "gh"
        gh.parent.mkdir()
        gh.write_text(_FAKE_GH)
        gh.chmod(0o755)
        self.bin = gh.parent
        self.script = script
        self.source = tmp_path / "out" / "nx-source.txt"
        self.output = tmp_path / "github_output"

    def api(self, url: str, body: object) -> None:
        (self.fake / re.sub(r"[^A-Za-z0-9]", "_", url)).write_text(json.dumps(body))

    def pr(
        self, n: int, head: str, head_repo: str | None = REPO, commits: list[str] | None = None
    ) -> None:
        repo_obj = {"full_name": head_repo} if head_repo else None
        self.api(f"repos/{REPO}/pulls/{n}", {"head": {"sha": head, "repo": repo_obj}})
        self.api(f"repos/{REPO}", {"id": REPO_ID})
        self.api(
            f"repos/{REPO}/pulls/{n}/commits?per_page=100",
            [{"sha": s} for s in (commits or [OLD, head])],
        )

    def artifacts(self, *arts: dict) -> None:
        self.api(ARTIFACTS_URL, {"artifacts": list(arts)})

    def run_info(self, run_id: int, prs: list[int], event: str = "pull_request") -> None:
        self.api(
            f"repos/{REPO}/actions/runs/{run_id}",
            {"id": run_id, "event": event, "pull_requests": [{"number": n} for n in prs]},
        )

    def go(self, event: str, **extra: str) -> dict[str, str]:
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FAKE_GH_DIR": str(self.fake),
            "EVENT_NAME": event,
            "REPO": REPO,
            "ARTIFACT_NAME": ART,
            "GITHUB_RUN_ID": OWN_RUN,
            "GITHUB_OUTPUT": str(self.output),
            "NX_SOURCE_FILE": str(self.source),
            **extra,
        }
        r = subprocess.run([str(self.script)], env=env, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        return dict(line.split("=", 1) for line in self.source.read_text().splitlines())

    def run_id_output(self) -> str | None:
        if not self.output.exists():
            return None
        m = re.search(r"^run_id=(.*)$", self.output.read_text(), re.M)
        return m.group(1) if m else None

    def calls(self) -> list[str]:
        return (self.fake / "calls.log").read_text().splitlines()


@pytest.fixture
def env(tmp_path: Path, githooks_dir: Path) -> Env:
    return Env(tmp_path, githooks_dir / "ci" / "fetch-pr-nx-cache.sh")


def _queue_ref(n: int, prefix: str = "refs/heads/") -> str:
    return f"{prefix}gh-readonly-queue/main/pr-{n}-{BASE_SHA}"


def test_pull_request_picks_latest_artifact(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(
        _art(100, OLD, "2026-11-01T00:00:00Z"),
        _art(120, HEAD, "2026-11-03T00:00:00Z"),
        _art(110, HEAD, "2026-11-02T00:00:00Z"),
    )
    env.run_info(120, [7])
    got = env.go("pull_request", PR_NUMBER="7")
    assert got == {
        "status": "imported",
        "run_id": "120",
        "pr": "7",
        "head_sha": HEAD,
    }
    assert env.run_id_output() == "120"


def test_no_artifact_means_no_run(env: Env) -> None:
    # 失敗したレーンは artifact を上げないので、候補に出ない
    env.pr(7, HEAD)
    env.artifacts()
    got = env.go("pull_request", PR_NUMBER="7")
    assert got == {"status": "none", "reason": "run なし"}
    assert env.run_id_output() is None


def test_falls_back_to_older_commit_artifact(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(_art(100, OLD, "2026-11-01T00:00:00Z"))
    env.run_info(100, [7])
    got = env.go("pull_request", PR_NUMBER="7")
    assert got["run_id"] == "100"
    assert got["head_sha"] == OLD


def test_excludes_own_run(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(_art(int(OWN_RUN), HEAD, "2026-11-05T00:00:00Z"))
    got = env.go("pull_request", PR_NUMBER="7")
    assert got == {"status": "none", "reason": "run なし"}


def test_does_not_pick_expired_artifact(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(
        _art(130, HEAD, "2026-11-09T00:00:00Z", expired=True),
        _art(100, OLD, "2026-11-01T00:00:00Z"),
    )
    env.run_info(100, [7])
    got = env.go("pull_request", PR_NUMBER="7")
    assert got["run_id"] == "100"


def test_does_not_pick_other_repo_head(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(_art(400, HEAD, "2026-11-09T00:00:00Z", repo_id=999))
    got = env.go("pull_request", PR_NUMBER="7")
    assert got == {"status": "none", "reason": "run なし"}
    assert env.run_id_output() is None


def test_does_not_pick_sha_outside_pr_commits(env: Env) -> None:
    env.pr(7, HEAD)
    other = "d3" * 20
    env.artifacts(_art(300, other, "2026-11-09T00:00:00Z"))
    got = env.go("pull_request", PR_NUMBER="7")
    assert got["reason"] == "run なし"


def test_does_not_pick_other_pr_run_with_same_sha(env: Env) -> None:
    # 同じ sha を持つ別の PR（#8）の run は pull_requests で弾き、次の候補に進む
    env.pr(7, HEAD)
    env.artifacts(_art(300, HEAD, "2026-11-09T00:00:00Z"), _art(100, OLD, "2026-11-01T00:00:00Z"))
    env.run_info(300, [8])
    env.run_info(100, [7])
    got = env.go("pull_request", PR_NUMBER="7")
    assert got["run_id"] == "100"


def test_other_pr_run_only_gives_no_run(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(_art(300, HEAD, "2026-11-09T00:00:00Z"))
    env.run_info(300, [8])
    got = env.go("pull_request", PR_NUMBER="7")
    assert got == {"status": "none", "reason": "run なし"}
    assert env.run_id_output() is None


def test_non_pull_request_run_is_rejected(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(_art(300, HEAD, "2026-11-09T00:00:00Z"))
    env.run_info(300, [7], event="push")
    got = env.go("pull_request", PR_NUMBER="7")
    assert got["reason"] == "run なし"


def test_commits_are_joined_across_pages(env: Env) -> None:
    env.pr(7, HEAD)
    page1 = [{"sha": OLD}]
    page2 = [{"sha": HEAD}]
    (
        env.fake / re.sub(r"[^A-Za-z0-9]", "_", f"repos/{REPO}/pulls/7/commits?per_page=100")
    ).write_text(json.dumps(page1) + "\n" + json.dumps(page2))
    env.artifacts(_art(100, OLD, "2026-11-01T00:00:00Z"))
    env.run_info(100, [7])
    assert env.go("pull_request", PR_NUMBER="7")["run_id"] == "100"
    env.artifacts(_art(110, HEAD, "2026-11-02T00:00:00Z"))
    env.run_info(110, [7])
    assert env.go("pull_request", PR_NUMBER="7")["run_id"] == "110"


def test_fork_pr_is_not_imported(env: Env) -> None:
    env.pr(7, HEAD, head_repo="evil/r")
    got = env.go("pull_request", PR_NUMBER="7")
    assert got == {"status": "none", "reason": "fork の PR"}
    assert env.run_id_output() is None


def test_deleted_fork_repo_is_treated_as_fork(env: Env) -> None:
    env.pr(7, HEAD, head_repo=None)
    got = env.go("pull_request", PR_NUMBER="7")
    assert got["reason"] == "fork の PR"


@pytest.mark.parametrize("prefix", ["refs/heads/", ""])
def test_merge_group_head_ref_forms(env: Env, prefix: str) -> None:
    env.pr(7, HEAD)
    env.artifacts(_art(110, HEAD, "2026-11-02T00:00:00Z"))
    env.run_info(110, [7])
    got = env.go("merge_group", HEAD_REF=_queue_ref(7, prefix))
    assert got["status"] == "imported"
    assert got["run_id"] == "110"
    assert got["pr"] == "7"


def test_merge_group_base_with_slash(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(_art(110, HEAD, "2026-11-02T00:00:00Z"))
    env.run_info(110, [7])
    got = env.go("merge_group", HEAD_REF=f"gh-readonly-queue/release/x/pr-7-{BASE_SHA}")
    assert got["pr"] == "7"
    assert got["run_id"] == "110"


def test_merge_group_does_not_use_trailing_base_sha(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(
        _art(110, HEAD, "2026-11-02T00:00:00Z"), _art(500, BASE_SHA, "2026-11-09T00:00:00Z")
    )
    env.run_info(110, [7])
    got = env.go("merge_group", HEAD_REF=_queue_ref(7))
    assert got["run_id"] == "110"


def test_merge_group_rejects_head_mismatch(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts(_art(100, OLD, "2026-11-01T00:00:00Z"))
    got = env.go("merge_group", HEAD_REF=_queue_ref(7))
    assert got == {"status": "none", "reason": "head 不一致"}
    assert env.run_id_output() is None


def test_merge_group_no_runs(env: Env) -> None:
    env.pr(7, HEAD)
    env.artifacts()
    got = env.go("merge_group", HEAD_REF=_queue_ref(7))
    assert got == {"status": "none", "reason": "run なし"}


def test_merge_group_fork_pr(env: Env) -> None:
    env.pr(7, HEAD, head_repo="evil/r")
    got = env.go("merge_group", HEAD_REF=_queue_ref(7))
    assert got["reason"] == "fork の PR"


def test_other_event(env: Env) -> None:
    got = env.go("push")
    assert got == {"status": "none", "reason": "対象外の event"}


def test_api_failure_exits_zero_with_reason(env: Env) -> None:
    got = env.go("pull_request", PR_NUMBER="7")
    assert got == {"status": "none", "reason": "取得の失敗"}
    assert env.run_id_output() is None


def test_artifacts_api_failure(env: Env) -> None:
    env.pr(7, HEAD)
    got = env.go("pull_request", PR_NUMBER="7")
    assert got == {"status": "none", "reason": "取得の失敗"}


def test_empty_repo(env: Env) -> None:
    got = env.go("pull_request", PR_NUMBER="7", REPO="")
    assert got == {"status": "none", "reason": "取得の失敗"}


def test_unparsable_head_ref(env: Env) -> None:
    got = env.go("merge_group", HEAD_REF="refs/heads/other")
    assert got == {"status": "none", "reason": "PR 番号不明"}


def test_missing_pr_number(env: Env) -> None:
    got = env.go("pull_request", PR_NUMBER="")
    assert got == {"status": "none", "reason": "PR 番号不明"}


def _download_failed(env: Env, tmp_path: Path) -> tuple[dict[str, str], Path]:
    remote = tmp_path / "nx-remote"
    remote.mkdir()
    (remote / "123.tar.gz").write_text("partial")
    run_env = {
        **os.environ,
        "PATH": f"{env.bin}:{os.environ['PATH']}",
        "FAKE_GH_DIR": str(env.fake),
        "REPO": REPO,
        "SRC_RUN_ID": "120",
        "ARTIFACT_NAME": "nx-cache-tests-x",
        "NX_SOURCE_FILE": str(env.source),
        "NX_REMOTE_DIR": str(remote),
    }
    r = subprocess.run(
        [str(env.script), "--download-failed"], env=run_env, capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr
    return dict(line.split("=", 1) for line in env.source.read_text().splitlines()), remote


def test_download_failed_without_artifact(env: Env, tmp_path: Path) -> None:
    env.api(f"repos/{REPO}/actions/runs/120/artifacts?name=nx-cache-tests-x", {"total_count": 0})
    got, remote = _download_failed(env, tmp_path)
    assert got == {"status": "none", "reason": "artifact なし"}
    assert not remote.exists()


def test_download_failed_with_artifact(env: Env, tmp_path: Path) -> None:
    env.api(f"repos/{REPO}/actions/runs/120/artifacts?name=nx-cache-tests-x", {"total_count": 1})
    got, remote = _download_failed(env, tmp_path)
    assert got == {"status": "none", "reason": "download の失敗"}
    assert not remote.exists()


def test_download_failed_api_error(env: Env, tmp_path: Path) -> None:
    got, _ = _download_failed(env, tmp_path)
    assert got == {"status": "none", "reason": "取得の失敗"}
