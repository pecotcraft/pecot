"""list-test-lanes.sh のユニットテスト。

偽の nx を repo の node_modules/.bin に置く。偽の nx の動きは次のとおり。
  - `graph --file=<path>`: レーン名の収集用に固定の project graph を書く。
  - `affected` / `run-many` の `--graph=<path>`: 固定の task graph を書く。
    `--base=<sha>` に env STUB_TASKS_BASE_<sha> があれば、そのファイルを書く（積モードで base ごとに変える）。
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
        src="$STUB_TASKS_GRAPH"
        for a in "$@"; do case "$a" in --base=*) v="STUB_TASKS_BASE_${a#--base=}"; [ -n "${!v:-}" ] && src="${!v}" ;; esac; done
        if [ -n "${STUB_TASKS_BROKEN:-}" ]; then echo '{"tasks":' > "$out"; else cp "$src" "$out"; fi
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
        self.base_graphs: dict[str, str] = {}
        self.git, self.rev = git, rev

    def new_commit(self, name: str) -> str:
        (self.repo / name).write_text(name)
        self.git(self.repo, "add", name)
        self.git(self.repo, "commit", "-q", "-m", f"chore: {name}")
        return self.rev(self.repo, "HEAD")

    def set_tasks(self, *ids: str) -> None:
        self.tasks_graph.write_text(json.dumps(_tasks_graph(*ids)))

    def set_tasks_for_base(self, base: str, *ids: str) -> None:
        f = self.tmp / f"tasks-{base}.json"
        f.write_text(json.dumps(_tasks_graph(*ids)))
        self.base_graphs[f"STUB_TASKS_BASE_{base}"] = str(f)

    def run(
        self, base: str | None = None, opts: list[str] | None = None, **env: str
    ) -> subprocess.CompletedProcess:
        full = {
            **os.environ,
            **self.base_graphs,
            "STUB_NX_LOG": str(self.log),
            "STUB_PROJECT_GRAPH": str(self.project_graph),
            "STUB_TASKS_GRAPH": str(self.tasks_graph),
            **env,
        }
        return subprocess.run(
            [str(self.script), *(opts or []), base or self.head, self.head],
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


def _parse(stdout: str, lint: str = "run") -> tuple[list[dict], str]:
    lines = stdout.splitlines()
    assert len(lines) == 3
    assert lines[0].startswith("lanes=") and lines[1].startswith("count=")
    assert lines[2] == f"lint={lint}"
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
    assert r.stdout == "lanes=[]\ncount=0\nlint=run\n"


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


def _stack_opts(pr_main: str, queue_base: str) -> list[str]:
    return [f"--pr-main={pr_main}", f"--queue-base={queue_base}"]


def _affected(env: _Env) -> list[str]:
    return [c for c in env.calls() if c.startswith("affected ")]


def test_stack_same_main_calls_nx_once_and_skips_lint(env: _Env) -> None:
    m0 = env.head
    head = env.new_commit("a")
    env.set_tasks("p:test-cli", "q:test-hooks")
    r = subprocess.run(
        [str(env.script), *_stack_opts(m0, m0), m0, head],
        cwd=env.repo,
        env={**os.environ, **_stub_env(env)},
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stderr
    lanes, count = _parse(r.stdout, lint="skip")
    assert [x["lane"] for x in lanes] == []
    assert count == "0"
    calls = _affected(env)
    assert len(calls) == 1
    assert f"--base={m0} --head={head}" in calls[0]
    assert "PR の変更のレーン: p:test-cli,q:test-hooks" in r.stderr
    assert "main の変更のレーン: なし" in r.stderr
    assert "積: なし" in r.stderr


def _stub_env(env: _Env) -> dict[str, str]:
    return {
        "STUB_NX_LOG": str(env.log),
        "STUB_PROJECT_GRAPH": str(env.project_graph),
        "STUB_TASKS_GRAPH": str(env.tasks_graph),
        **env.base_graphs,
    }


def _stack_run(env: _Env, m0: str, qbase: str, head: str, **extra: str):
    return subprocess.run(
        [str(env.script), head and f"--pr-main={m0}", f"--queue-base={qbase}", qbase, head],
        cwd=env.repo,
        env={**os.environ, **_stub_env(env), **extra},
        capture_output=True,
        text=True,
    )


def test_stack_overlap_remains(env: _Env) -> None:
    m0 = env.head
    qbase = env.new_commit("m")
    head = env.new_commit("a")
    env.set_tasks_for_base(qbase, "p:test-cli", "q:test-hooks")
    env.set_tasks_for_base(m0, "q:test-hooks", "p:test-unit")
    r = _stack_run(env, m0, qbase, head)
    assert r.returncode == 0, r.stderr
    lanes, count = _parse(r.stdout, lint="run")
    assert lanes == [{"lane": "q:test-hooks", "slug": "q-test-hooks"}]
    assert count == "1"
    calls = _affected(env)
    assert len(calls) == 2
    assert f"--base={qbase} --head={head}" in calls[0]
    assert f"--base={m0} --head={qbase}" in calls[1]
    assert "積: q:test-hooks" in r.stderr


def test_stack_no_overlap(env: _Env) -> None:
    m0 = env.head
    qbase = env.new_commit("m")
    head = env.new_commit("a")
    env.set_tasks_for_base(qbase, "p:test-cli")
    env.set_tasks_for_base(m0, "q:test-hooks")
    r = _stack_run(env, m0, qbase, head)
    assert r.returncode == 0, r.stderr
    assert _parse(r.stdout, lint="run") == ([], "0")
    assert "積: なし" in r.stderr


def test_stack_ignores_no_prev(env: _Env) -> None:
    m0 = env.head
    qbase = env.new_commit("m")
    head = env.new_commit("a")
    env.set_tasks_for_base(qbase, "q:test-hooks")
    env.set_tasks_for_base(m0, "q:test-hooks")
    r = _stack_run(env, m0, qbase, head, NO_PREV="true")
    assert r.returncode == 0, r.stderr
    assert _parse(r.stdout, lint="run")[1] == "1"
    assert not any(c.startswith("run-many") for c in env.calls())


@pytest.mark.parametrize("opt", ["--pr-main", "--queue-base"])
def test_stack_single_option_is_usage_error(env: _Env, opt: str) -> None:
    r = env.run(opts=[f"{opt}={env.head}"])
    assert r.returncode == 2
    assert "使い方" in r.stderr
    assert r.stdout == ""
    assert env.calls() == []


@pytest.mark.parametrize("bad", ["pr_main", "queue_base"])
def test_stack_unreadable_sha_falls_back_to_normal(env: _Env, bad: str) -> None:
    env.set_tasks("p:test-unit")
    good = env.head
    pr_main = "0" * 40 if bad == "pr_main" else good
    queue_base = "0" * 40 if bad == "queue_base" else good
    r = env.run(opts=_stack_opts(pr_main, queue_base))
    assert r.returncode == 0, r.stderr
    assert "WARN" in r.stderr
    assert _parse(r.stdout, lint="run")[1] == "1"
    assert len(_affected(env)) == 1
    assert f"--base={good} --head={good}" in _affected(env)[0]
