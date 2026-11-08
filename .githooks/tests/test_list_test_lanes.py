"""list-test-lanes.sh のユニットテスト。

偽の nx を repo の node_modules/.bin に置く。偽の nx の動きは次のとおり。
  - `graph --file=<path>`: レーン名の収集用に固定の project graph を書く。
  - `affected` / `run-many` の `--graph=<path>`: 固定の task graph を書く。
  - 全引数を 1 呼び出し 1 行で $STUB_NX_LOG へ追記する。
  - STUB_GRAPH_FAIL / STUB_TASKS_FAIL / STUB_TASKS_BROKEN で失敗や不正な JSON を起こす。
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

_NX_STUB = """#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_NX_LOG"
printf 'ENV NO_COLOR=%s LEGACY=%s\\n' "${NO_COLOR-unset}" "${NX_LEGACY_AFFECTED-unset}" >> "$STUB_NX_LOG"
case "$1" in
    graph)
        [ -n "${STUB_GRAPH_FAIL:-}" ] && { echo "graph boom"; exit 1; }
        cp "$STUB_PROJECT_GRAPH" "${2#--file=}"
        ;;
    affected | run-many)
        [ -n "${STUB_TASKS_FAIL:-}" ] && { echo "tasks boom"; exit 1; }
        out=
        for a in "$@"; do case "$a" in --graph=*) out="${a#--graph=}" ;; esac; done
        if [ -n "${STUB_TASKS_BROKEN:-}" ]; then echo '{"tasks":' > "$out"; else cp "$STUB_TASKS_GRAPH" "$out"; fi
        ;;
esac
"""

_NOOP = {"executor": "nx:noop"}
_PROJECT_GRAPH = {
    "graph": {
        "nodes": {
            "p": {
                "data": {
                    "targets": {
                        "test": _NOOP,
                        "test-unit": {},
                        "test-cli": {},
                        "install": {},
                        "build-cli": {},
                    }
                }
            },
            "q": {"data": {"targets": {"test": _NOOP, "test-hooks": {}, "build": {}}}},
        }
    }
}


def _task(project: str, target: str) -> dict:
    return {"id": f"{project}:{target}", "target": {"project": project, "target": target}}


def _tasks_graph(*ids: str) -> dict:
    return {"tasks": {"tasks": {i: _task(*i.split(":")) for i in ids}}}


class _Env:
    def __init__(self, repo: Path, tmp: Path, script: Path, git, rev) -> None:
        self.repo, self.tmp, self.script = repo, tmp, script
        self.log = tmp / "nx.log"
        self.log.write_text("")
        self.project_graph = tmp / "project-graph.json"
        self.project_graph.write_text(json.dumps(_PROJECT_GRAPH))
        self.tasks_graph = tmp / "tasks-graph.json"
        self.head = rev(repo, "HEAD")

    def set_tasks(self, *ids: str) -> None:
        self.tasks_graph.write_text(json.dumps(_tasks_graph(*ids)))

    def run(self, base: str | None = None, **env: str) -> subprocess.CompletedProcess:
        full = {
            **os.environ,
            "STUB_NX_LOG": str(self.log),
            "STUB_PROJECT_GRAPH": str(self.project_graph),
            "STUB_TASKS_GRAPH": str(self.tasks_graph),
            **env,
        }
        return subprocess.run(
            [str(self.script), base or self.head, self.head],
            cwd=self.repo,
            env=full,
            capture_output=True,
            text=True,
        )

    def calls(self) -> list[str]:
        return [x for x in self.log.read_text().splitlines() if not x.startswith("ENV ")]


@pytest.fixture
def env(
    git_repo: Callable[..., Path], git, git_rev_parse, tmp_path: Path, githooks_dir: Path
) -> _Env:
    repo = git_repo("repo", initial_branch="main")
    (repo / "node_modules" / ".bin").mkdir(parents=True)
    stub = repo / "node_modules" / ".bin" / "nx"
    stub.write_text(_NX_STUB)
    stub.chmod(0o755)
    (repo / "README.md").write_text("x\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-q", "-m", "chore: init")
    return _Env(repo, tmp_path, githooks_dir / "ci" / "list-test-lanes.sh", git, git_rev_parse)


def _parse(stdout: str) -> tuple[list[dict], str]:
    lines = stdout.splitlines()
    assert len(lines) == 2
    assert lines[0].startswith("lanes=") and lines[1].startswith("count=")
    return json.loads(lines[0][len("lanes=") :]), lines[1][len("count=") :]


def test_affected_mode_keeps_only_lane_tasks(env: _Env) -> None:
    env.set_tasks("q:test-hooks", "p:install", "p:test-cli", "p:build-cli", "q:build")
    r = env.run()
    assert r.returncode == 0, r.stderr
    lanes, count = _parse(r.stdout)
    assert lanes == [
        {"lane": "p:test-cli", "slug": "p-test-cli"},
        {"lane": "q:test-hooks", "slug": "q-test-hooks"},
    ]
    assert count == "2"


def test_affected_mode_passes_base_head_and_lane_names(env: _Env) -> None:
    env.set_tasks("p:test-unit")
    assert env.run().returncode == 0
    affected = [c for c in env.calls() if c.startswith("affected ")]
    assert len(affected) == 1
    assert (
        f"-t test-cli,test-hooks,test-unit --base={env.head} --head={env.head} --graph="
        in affected[0]
    )
    assert not any(c.startswith("run-many") for c in env.calls())
    # 起点の test と依存の target は -t に入らない。
    assert "install" not in affected[0] and "build" not in affected[0]
    log = env.log.read_text()
    assert "NO_COLOR=1 LEGACY=unset" in log


def test_no_prev_uses_run_many(env: _Env) -> None:
    env.set_tasks("p:test-unit", "q:test-hooks")
    r = env.run(NO_PREV="true")
    assert r.returncode == 0, r.stderr
    assert any(
        c.startswith("run-many -t test-cli,test-hooks,test-unit --graph=") for c in env.calls()
    )
    assert not any(c.startswith("affected") for c in env.calls())
    assert _parse(r.stdout)[1] == "2"


def test_missing_base_uses_run_many(env: _Env) -> None:
    env.set_tasks("p:test-unit")
    r = env.run(base="0" * 40)
    assert r.returncode == 0, r.stderr
    assert any(c.startswith("run-many ") for c in env.calls())
    assert not any(c.startswith("affected") for c in env.calls())


def test_slug_collision_fails_closed(env: _Env) -> None:
    """a:test-b-test-c と a-test-b:test-c は slug が同じになるため、ERROR で非 0 にする。"""
    graph = {
        "graph": {
            "nodes": {
                "a": {"data": {"targets": {"test-b-test-c": {}}}},
                "a-test-b": {"data": {"targets": {"test-c": {}}}},
            }
        }
    }
    env.project_graph.write_text(json.dumps(graph))
    env.set_tasks("a:test-b-test-c", "a-test-b:test-c")
    r = env.run()
    assert r.returncode != 0
    assert "ERROR" in r.stderr
    assert "a-test-b-test-c" in r.stderr
    assert r.stdout == ""


def test_zero_lanes(env: _Env) -> None:
    env.set_tasks("p:install", "p:build-cli")
    r = env.run()
    assert r.returncode == 0, r.stderr
    assert r.stdout == "lanes=[]\ncount=0\n"


def test_graph_failure_fails_closed(env: _Env) -> None:
    r = env.run(STUB_GRAPH_FAIL="1")
    assert r.returncode != 0
    assert "ERROR" in r.stderr
    assert r.stdout == ""


def test_task_graph_failure_fails_closed(env: _Env) -> None:
    r = env.run(STUB_TASKS_FAIL="1")
    assert r.returncode != 0
    assert "ERROR" in r.stderr
    assert r.stdout == ""


def test_broken_task_graph_fails_closed(env: _Env) -> None:
    r = env.run(STUB_TASKS_BROKEN="1")
    assert r.returncode != 0
    assert "ERROR" in r.stderr
    assert r.stdout == ""


def test_temp_dir_is_removed(env: _Env) -> None:
    env.set_tasks("p:test-unit")
    assert env.run().returncode == 0
    tmp = env.repo / ".pecot" / "tmp"
    assert not list(tmp.glob("list-test-lanes.*"))
