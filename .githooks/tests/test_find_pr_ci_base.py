"""find-pr-ci-base.sh のユニットテスト。偽の gh は URL ごとのフィクスチャ（無ければ API 失敗）を返す。"""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

REPO = "o/r"

_FAKE_GH = """#!/usr/bin/env bash
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
    id="$3"; dir=""
    while [ "$#" -gt 0 ]; do [ "$1" = "-D" ] && dir="$2"; shift; done
    [ -f "$FAKE_GH_DIR/artifact_$id" ] || exit 1
    cp "$FAKE_GH_DIR/artifact_$id" "$dir/ci-base.txt"
    exit 0
fi
url=""
for a in "$@"; do
    case "$a" in -*|api) ;; *) url="$a" ;; esac
done
f="$FAKE_GH_DIR/${url//[^A-Za-z0-9]/_}"
[ -f "$f" ] || exit 1
cat "$f"
"""


class Env:
    def __init__(self, tmp_path: Path, repo: Path, script: Path) -> None:
        self.fake = tmp_path / "fake"
        self.fake.mkdir()
        gh = tmp_path / "bin" / "gh"
        gh.parent.mkdir()
        gh.write_text(_FAKE_GH)
        gh.chmod(0o755)
        self.bin = gh.parent
        self.repo = repo
        self.script = script

    def git(self, *args: str) -> str:
        r = subprocess.run(
            ["git", *args], cwd=self.repo, check=True, capture_output=True, text=True
        )
        return r.stdout.strip()

    def commit(self, name: str, content: str, parent: str | None = None) -> str:
        if parent:
            self.git("checkout", "-q", "--detach", parent)
        (self.repo / name).write_text(content)
        self.git("add", name)
        self.git("commit", "-q", "-m", f"{name} {content}")
        return self.git("rev-parse", "HEAD")

    def api(self, url: str, body: object) -> None:
        (self.fake / re.sub(r"[^A-Za-z0-9]", "_", url)).write_text(json.dumps(body))

    def pull(self, n: int, head: str, head_repo: str | None = REPO) -> None:
        repo_obj = {"full_name": head_repo} if head_repo else None
        self.api(f"repos/{REPO}/pulls/{n}", {"head": {"sha": head, "repo": repo_obj}})

    def runs(self, head: str, *runs: tuple[int, str]) -> None:
        url = f"repos/{REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={head}&status=success&per_page=100"
        self.api(url, {"workflow_runs": [{"id": i, "created_at": c} for i, c in runs]})

    def run_info(self, run_id: int, prs: list[int], event: str = "pull_request") -> None:
        self.api(
            f"repos/{REPO}/actions/runs/{run_id}",
            {"id": run_id, "event": event, "pull_requests": [{"number": n} for n in prs]},
        )

    def artifact(self, run_id: int, main_sha: str, pr_head: str) -> None:
        (self.fake / f"artifact_{run_id}").write_text(f"main_sha={main_sha}\npr_head={pr_head}\n")

    def go(self, head_ref: str, base: str, head: str) -> tuple[str, str]:
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FAKE_GH_DIR": str(self.fake),
            "HEAD_REF": head_ref,
            "REPO": REPO,
            "QUEUE_BASE": base,
            "QUEUE_HEAD": head,
        }
        r = subprocess.run(
            [str(self.script)], env=env, cwd=self.repo, capture_output=True, text=True
        )
        assert r.returncode == 0, r.stderr
        return r.stdout.strip(), r.stderr.strip()


class Scene:
    """M0 -> Q_base（main が 1 つ進む）。PR は M0 から分岐し、Q_head は Q_base の上の squash。"""

    def __init__(self, env: Env) -> None:
        self.env = env
        env.git("checkout", "-q", "-b", "main")
        self.m0 = env.commit("a.txt", "a")
        self.base = env.commit("b.txt", "b")
        self.pr_head = env.commit("pr.txt", "pr", parent=self.m0)
        self.q_head = env.commit("pr.txt", "pr", parent=self.base)
        self.ref = f"refs/heads/gh-readonly-queue/main/pr-7-{self.base}"
        env.pull(7, self.pr_head)

    def good_run(self, run_id: int = 100, created: str = "2026-11-01T00:00:00Z") -> None:
        self.env.runs(self.pr_head, (run_id, created))
        self.env.run_info(run_id, [7])
        self.env.artifact(run_id, self.m0, self.pr_head)

    def go(self) -> tuple[str, str]:
        return self.env.go(self.ref, self.base, self.q_head)


@pytest.fixture
def env(tmp_path: Path, githooks_dir: Path, git_repo: Callable[..., Path]) -> Env:
    return Env(tmp_path, git_repo(), githooks_dir / "ci" / "find-pr-ci-base.sh")


@pytest.fixture
def scene(env: Env) -> Scene:
    return Scene(env)


def test_outputs_pr_main_on_success(scene: Scene) -> None:
    scene.good_run()
    assert scene.go() == (f"pr_main={scene.m0}", "")


@pytest.mark.parametrize("prefix", ["refs/heads/", ""])
def test_head_ref_forms(scene: Scene, prefix: str) -> None:
    scene.good_run()
    ref = f"{prefix}gh-readonly-queue/main/pr-7-{scene.base}"
    assert scene.env.go(ref, scene.base, scene.q_head)[0] == f"pr_main={scene.m0}"


def test_picks_newer_run_that_passes(scene: Scene) -> None:
    scene.env.runs(scene.pr_head, (100, "2026-11-01T00:00:00Z"), (110, "2026-11-02T00:00:00Z"))
    scene.env.run_info(100, [7])
    scene.env.run_info(110, [7])
    scene.env.artifact(100, scene.m0, scene.pr_head)
    scene.env.artifact(110, scene.base, scene.pr_head)
    assert scene.go()[0] == f"pr_main={scene.base}"


def test_falls_back_to_older_run_when_newer_fails_check(scene: Scene) -> None:
    scene.env.runs(scene.pr_head, (100, "2026-11-01T00:00:00Z"), (110, "2026-11-02T00:00:00Z"))
    scene.env.run_info(100, [7])
    scene.env.run_info(110, [7])
    scene.env.artifact(100, scene.m0, scene.pr_head)
    scene.env.artifact(110, scene.m0, "f" * 40)
    assert scene.go()[0] == f"pr_main={scene.m0}"


def test_skips_run_of_other_pr(scene: Scene) -> None:
    scene.env.runs(scene.pr_head, (100, "2026-11-01T00:00:00Z"), (110, "2026-11-02T00:00:00Z"))
    scene.env.run_info(100, [7])
    scene.env.run_info(110, [8])
    scene.env.artifact(100, scene.m0, scene.pr_head)
    scene.env.artifact(110, scene.base, scene.pr_head)
    assert scene.go()[0] == f"pr_main={scene.m0}"


def test_no_successful_run(scene: Scene) -> None:
    scene.env.runs(scene.pr_head)
    assert scene.go() == ("", "reason=成功した run なし")


def test_runs_for_other_head_are_not_returned(scene: Scene) -> None:
    # PR の head と違う head_sha の run は API が返さない（フィクスチャ無し = 取得の失敗）
    scene.env.runs("e" * 40, (100, "2026-11-01T00:00:00Z"))
    assert scene.go() == ("", "reason=取得の失敗")


def test_artifact_missing(scene: Scene) -> None:
    scene.good_run()
    (scene.env.fake / "artifact_100").unlink()
    assert scene.go() == ("", "reason=ci-base なし")


def test_artifact_pr_head_differs(scene: Scene) -> None:
    scene.good_run()
    scene.env.artifact(100, scene.m0, "f" * 40)
    assert scene.go() == ("", "reason=pr_head 不一致")


def test_main_sha_not_ancestor(scene: Scene) -> None:
    scene.good_run()
    scene.env.artifact(100, scene.pr_head, scene.pr_head)
    assert scene.go() == ("", "reason=main_sha が base の祖先でない")


def test_main_sha_malformed(scene: Scene) -> None:
    scene.good_run()
    scene.env.artifact(100, "main", scene.pr_head)
    assert scene.go()[1] == "reason=main_sha が base の祖先でない"


def test_queue_head_parent_is_not_queue_base(scene: Scene) -> None:
    scene.good_run()
    out = scene.env.go(scene.ref, scene.m0, scene.q_head)
    assert out == ("", "reason=queue の commit の親が base でない")


def test_merge_tree_conflict(env: Env) -> None:
    env.git("checkout", "-q", "-b", "main")
    m0 = env.commit("f.txt", "m0")
    base = env.commit("f.txt", "main side")
    pr_head = env.commit("f.txt", "pr side", parent=m0)
    q_head = env.commit("g.txt", "x", parent=base)
    env.pull(7, pr_head)
    env.runs(pr_head, (100, "2026-11-01T00:00:00Z"))
    env.run_info(100, [7])
    env.artifact(100, m0, pr_head)
    ref = f"gh-readonly-queue/main/pr-7-{base}"
    assert env.go(ref, base, q_head) == ("", "reason=merge-tree が失敗（衝突または commit なし）")


def test_tree_differs_from_queue_head(env: Env) -> None:
    env.git("checkout", "-q", "-b", "main")
    m0 = env.commit("a.txt", "a")
    base = env.commit("b.txt", "b")
    pr_head = env.commit("pr.txt", "pr", parent=m0)
    q_head = env.commit("pr.txt", "different", parent=base)
    env.pull(7, pr_head)
    env.runs(pr_head, (100, "2026-11-01T00:00:00Z"))
    env.run_info(100, [7])
    env.artifact(100, m0, pr_head)
    ref = f"gh-readonly-queue/main/pr-7-{base}"
    assert env.go(ref, base, q_head) == ("", "reason=tree 不一致")


def test_pr_head_commit_missing_locally(scene: Scene) -> None:
    scene.env.pull(7, "9" * 40)
    out = scene.go()
    assert out == ("", "reason=merge-tree が失敗（衝突または commit なし）")


def test_fork_pr(scene: Scene) -> None:
    scene.env.pull(7, scene.pr_head, head_repo="evil/r")
    assert scene.go() == ("", "reason=fork の PR")


def test_unparsable_head_ref(scene: Scene) -> None:
    out = scene.env.go("refs/heads/other", scene.base, scene.q_head)
    assert out == ("", "reason=PR 番号不明")


def test_pull_api_failure(scene: Scene) -> None:
    (scene.env.fake / "repos_o_r_pulls_7").unlink()
    assert scene.go() == ("", "reason=取得の失敗")
