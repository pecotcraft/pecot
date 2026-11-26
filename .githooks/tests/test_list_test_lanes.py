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
import sys
from collections.abc import Callable
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

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
        self,
        base: str | None = None,
        opts: list[str] | None = None,
        head: str | None = None,
        **env: str,
    ) -> subprocess.CompletedProcess:
        full = {
            **os.environ,
            **self.base_graphs,
            "STUB_NX_LOG": str(self.log),
            "STUB_PROJECT_GRAPH": str(self.project_graph),
            "STUB_TASKS_GRAPH": str(self.tasks_graph),
            **env,
        }
        return run_attached(
            [str(self.script), *(opts or []), base or self.head, head or self.head],
            cwd=self.repo,
            env=full,
            capture_output=True,
            text=True,
        )

    def calls(self) -> list[str]:
        return [x for x in read_output(self.log).splitlines() if not x.startswith("ENV ")]


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


@allure.title("affected のモードでは、タスクのうちレーンのものだけを残して出力する")
def test_affected_mode_keeps_only_lane_tasks(env: _Env) -> None:
    """`list-test-lanes.sh` を偽の `nx` で動かし、タスクの一覧から `test-` のレーンだけを残すことのテストです。`install` や `build` のタスクを除外し、`p:test-cli` と `q:test-hooks` の 2 件を `lanes` と `count` に出力することを確認します。"""
    with allure.step("nx のタスクを用意してレーン一覧を作る"):
        env.set_tasks("q:test-hooks", "p:install", "p:test-cli", "p:build-cli", "q:build")
        r = env.run()
    with allure.step("終了コードとレーンの一覧と件数を確かめる"):
        assert r.returncode == 0, r.stderr
        lanes, count = _parse(r.stdout)
        assert lanes == [
            {"lane": "p:test-cli", "slug": "p-test-cli"},
            {"lane": "q:test-hooks", "slug": "q-test-hooks"},
        ]
        assert count == "2"


@allure.title("affected のモードでは、base と head とレーン名を nx affected に渡す")
def test_affected_mode_passes_base_head_and_lane_names(env: _Env) -> None:
    """偽の `nx` の呼び出しの記録のテストです。`affected` を 1 回だけ呼び、`-t` にレーン名（`test` や `install` などは除く）、`--base` と `--head` に sha を渡し、`run-many` を呼ばないことを確認します。"""
    with allure.step("レーン一覧を作る"):
        env.set_tasks("p:test-unit")
    with allure.step("affected の呼び出しの base・head・レーン名と環境変数を確かめる"):
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
        log = read_output(env.log)
        assert "NO_COLOR=1 LEGACY=unset" in log


@allure.title("NO_PREV が true だと、affected ではなく run-many を使う")
def test_no_prev_uses_run_many(env: _Env) -> None:
    """`NO_PREV=true` を指定して実行するテストです。`affected` を呼ばず、`run-many -t` にレーン名を渡して、`count` が 2 になることを確認します。"""
    with allure.step("前の結果なしの指定でレーン一覧を作る"):
        env.set_tasks("p:test-unit", "q:test-hooks")
        r = env.run(NO_PREV="true")
    with allure.step("run-many を使い affected を使わないことを確かめる"):
        assert r.returncode == 0, r.stderr
        assert any(
            c.startswith("run-many -t test-cli,test-hooks,test-unit --graph=") for c in env.calls()
        )
        assert not any(c.startswith("affected") for c in env.calls())
        assert _parse(r.stdout)[1] == "2"


@allure.title("base のコミットが存在しないと、affected ではなく run-many を使う")
def test_missing_base_uses_run_many(env: _Env) -> None:
    """base に、リポジトリに存在しない sha（`0` を 40 個並べたもの）を渡す場合のテストです。`affected` を呼ばず、`run-many` を呼ぶことを確認します。"""
    with allure.step("存在しない base でレーン一覧を作る"):
        env.set_tasks("p:test-unit")
        r = env.run(base="0" * 40)
    with allure.step("run-many を使い affected を使わないことを確かめる"):
        assert r.returncode == 0, r.stderr
        assert any(c.startswith("run-many ") for c in env.calls())
        assert not any(c.startswith("affected") for c in env.calls())


@allure.title("異なるレーンの slug が衝突すると、ERROR を出力して失敗で終わる")
def test_slug_collision_fails_closed(env: _Env) -> None:
    """`a:test-b-test-c` と `a-test-b:test-c` のように、slug が同じになるレーンがある場合のテストです。終了コードが 0 以外で、`ERROR` と衝突した slug を標準エラーに出力し、標準出力には何も出力しないことを確認します。"""
    with allure.step("slug が同じになるレーンの graph を用意して動かす"):
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
    with allure.step("非 0 の終了と ERROR の出力を確かめる"):
        assert r.returncode != 0
        assert "ERROR" in r.stderr
        assert "a-test-b-test-c" in r.stderr
        assert r.stdout == ""


@allure.title("レーンのタスクが存在しないと、空の lanes と count の 0 を出力する")
def test_zero_lanes(env: _Env) -> None:
    """タスクが、レーン以外（`install` と `build-cli`）だけの場合のテストです。標準出力が `lanes=[]`、`count=0`、`lint=run` の 3 行になることを確認します。"""
    with allure.step("レーンの無いタスクだけで動かす"):
        env.set_tasks("p:install", "p:build-cli")
        r = env.run()
    with allure.step("終了コードとレーンが空の出力を確かめる"):
        assert r.returncode == 0, r.stderr
        assert r.stdout == "lanes=[]\ncount=0\nlint=run\n"


@allure.title("project graph の取得に失敗すると、ERROR を出力して失敗で終わる")
def test_graph_failure_fails_closed(env: _Env) -> None:
    """偽の `nx graph` が失敗する場合のテストです。終了コードが 0 以外で、標準エラーに `ERROR` を出力し、標準出力には何も出力しないことを確認します。"""
    with allure.step("nx graph が失敗する状態で動かす"):
        r = env.run(STUB_GRAPH_FAIL="1")
    with allure.step("非 0 の終了と ERROR の出力を確かめる"):
        assert r.returncode != 0
        assert "ERROR" in r.stderr
        assert r.stdout == ""


@allure.title("task graph の取得に失敗すると、ERROR を出力して失敗で終わる")
def test_task_graph_failure_fails_closed(env: _Env) -> None:
    """偽の `nx affected` が失敗する場合のテストです。終了コードが 0 以外で、標準エラーに `ERROR` を出力し、標準出力には何も出力しないことを確認します。"""
    with allure.step("タスクグラフの取得が失敗する状態で動かす"):
        r = env.run(STUB_TASKS_FAIL="1")
    with allure.step("非 0 の終了と ERROR の出力を確かめる"):
        assert r.returncode != 0
        assert "ERROR" in r.stderr
        assert r.stdout == ""


@allure.title("task graph が不正な JSON だと、ERROR を出力して失敗で終わる")
def test_broken_task_graph_fails_closed(env: _Env) -> None:
    """偽の `nx` が、JSON として不正な task graph を書き出す場合のテストです。終了コードが 0 以外で、標準エラーに `ERROR` を出力し、標準出力には何も出力しないことを確認します。"""
    with allure.step("読めないタスクグラフを返す状態で動かす"):
        r = env.run(STUB_TASKS_BROKEN="1")
    with allure.step("非 0 の終了と ERROR の出力を確かめる"):
        assert r.returncode != 0
        assert "ERROR" in r.stderr
        assert r.stdout == ""


@allure.title("一時ディレクトリは、実行後に削除する")
def test_temp_dir_is_removed(env: _Env) -> None:
    """`list-test-lanes.sh` を正常に実行したあとのテストです。`.pecot/tmp` に、`list-test-lanes.` で始まるディレクトリが残っていないことを確認します。"""
    with allure.step("レーン一覧を作る"):
        env.set_tasks("p:test-unit")
    with allure.step("一時ディレクトリが残っていないことを確かめる"):
        assert env.run().returncode == 0
        tmp = env.repo / ".pecot" / "tmp"
        assert not list(tmp.glob("list-test-lanes.*"))


def _stack_opts(pr_main: str, queue_base: str) -> list[str]:
    return [f"--pr-main={pr_main}", f"--queue-base={queue_base}"]


def _affected(env: _Env) -> list[str]:
    return [c for c in env.calls() if c.startswith("affected ")]


@allure.title(
    "積モードで PR の main と queue の base が同じだと、nx を 1 回だけ呼び、レーンは 0 件で lint を飛ばす"
)
def test_stack_same_main_calls_nx_once_and_skips_lint(env: _Env) -> None:
    """`--pr-main` と `--queue-base` が同じ sha の場合の、積モードのテストです。`affected` を 1 回だけ呼び、`lint=skip` と `count=0` を出力し、PR の変更のレーンと「積: なし」を標準エラーに出力することを確認します。"""
    with allure.step("積の base が PR と同じ main の状態で動かす"):
        m0 = env.head
        head = env.new_commit("a")
        env.set_tasks("p:test-cli", "q:test-hooks")
        r = env.run(base=m0, opts=_stack_opts(m0, m0), head=head)
    with allure.step("レーンが空で nx を 1 回だけ呼び、lint を飛ばすことを確かめる"):
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


def _stack_run(env: _Env, m0: str, qbase: str, head: str, **extra: str):
    return env.run(base=qbase, opts=_stack_opts(m0, qbase), head=head, **extra)


@allure.title(
    "積モードで PR の変更と main の変更に共通するレーンがあると、そのレーンだけを出力する"
)
def test_stack_overlap_remains(env: _Env) -> None:
    """PR の main と queue の base が異なり、PR の変更のレーンと main の変更のレーンに共通するものがある場合の、積モードのテストです。共通する `q:test-hooks` だけを `lanes` に出力し、`lint=run` になり、`affected` を 2 回呼ぶことを確認します。"""
    with allure.step("main に重なるレーンのある積の状態で動かす"):
        m0 = env.head
        qbase = env.new_commit("m")
        head = env.new_commit("a")
        env.set_tasks_for_base(qbase, "p:test-cli", "q:test-hooks")
        env.set_tasks_for_base(m0, "q:test-hooks", "p:test-unit")
        r = _stack_run(env, m0, qbase, head)
    with allure.step("重なるレーンだけが残り、nx を 2 回呼ぶことを確かめる"):
        assert r.returncode == 0, r.stderr
        lanes, count = _parse(r.stdout, lint="run")
        assert lanes == [{"lane": "q:test-hooks", "slug": "q-test-hooks"}]
        assert count == "1"
        calls = _affected(env)
        assert len(calls) == 2
        assert f"--base={qbase} --head={head}" in calls[0]
        assert f"--base={m0} --head={qbase}" in calls[1]
        assert "積: q:test-hooks" in r.stderr


@allure.title("積モードで共通するレーンが存在しないと、lanes を空にして lint は実行する")
def test_stack_no_overlap(env: _Env) -> None:
    """PR の変更と main の変更に、共通するレーンが存在しない場合の、積モードのテストです。`lanes` が空で `count` が 0、`lint=run` になり、標準エラーに「積: なし」を出力することを確認します。"""
    with allure.step("main に重なるレーンの無い積の状態で動かす"):
        m0 = env.head
        qbase = env.new_commit("m")
        head = env.new_commit("a")
        env.set_tasks_for_base(qbase, "p:test-cli")
        env.set_tasks_for_base(m0, "q:test-hooks")
        r = _stack_run(env, m0, qbase, head)
    with allure.step("レーンが空で、積が無いと出力することを確かめる"):
        assert r.returncode == 0, r.stderr
        assert _parse(r.stdout, lint="run") == ([], "0")
        assert "積: なし" in r.stderr


@allure.title("積モードでは、NO_PREV が true でも run-many を使わない")
def test_stack_ignores_no_prev(env: _Env) -> None:
    """積モードで `NO_PREV=true` を指定して実行するテストです。`run-many` を呼ばず、共通する `q:test-hooks` を 1 件出力することを確認します。"""
    with allure.step("積の状態で前の結果なしの指定を付けて動かす"):
        m0 = env.head
        qbase = env.new_commit("m")
        head = env.new_commit("a")
        env.set_tasks_for_base(qbase, "q:test-hooks")
        env.set_tasks_for_base(m0, "q:test-hooks")
        r = _stack_run(env, m0, qbase, head, NO_PREV="true")
    with allure.step("件数と run-many を使わないことを確かめる"):
        assert r.returncode == 0, r.stderr
        assert _parse(r.stdout, lint="run")[1] == "1"
        assert not any(c.startswith("run-many") for c in env.calls())


@allure.title("{opt} だけを渡すと、使い方を出力して終了コード 2 で終わる")
@pytest.mark.parametrize("opt", ["--pr-main", "--queue-base"])
def test_stack_single_option_is_usage_error(env: _Env, opt: str) -> None:
    """`--pr-main` と `--queue-base` のどちらか一方だけを渡す場合のテストです。終了コード 2 で終わり、標準エラーに使い方を出力し、`nx` を呼び出さないことを確認します。"""
    with allure.step("積の指定を片方だけ付けて動かす"):
        r = env.run(opts=[f"{opt}={env.head}"])
    with allure.step("使い方のエラーを確かめる"):
        assert r.returncode == 2
        assert "使い方" in r.stderr
        assert r.stdout == ""
        assert env.calls() == []


@allure.title("{bad} の sha を読めないと、警告を出力して通常のモードで実行する")
@pytest.mark.parametrize("bad", ["pr_main", "queue_base"])
def test_stack_unreadable_sha_falls_back_to_normal(env: _Env, bad: str) -> None:
    """`--pr-main` か `--queue-base` の sha が、リポジトリに存在しない場合のテストです。終了コード 0 で終わり、標準エラーに `WARN` を出力し、通常のモードとして `affected` を 1 回呼んで `count` が 1 になることを確認します。"""
    with allure.step("読めない SHA を積の指定に渡して動かす"):
        env.set_tasks("p:test-unit")
        good = env.head
        pr_main = "0" * 40 if bad == "pr_main" else good
        queue_base = "0" * 40 if bad == "queue_base" else good
        r = env.run(opts=_stack_opts(pr_main, queue_base))
    with allure.step("警告を出して通常の動きに戻ることを確かめる"):
        assert r.returncode == 0, r.stderr
        assert "WARN" in r.stderr
        assert _parse(r.stdout, lint="run")[1] == "1"
        assert len(_affected(env)) == 1
        assert f"--base={good} --head={good}" in _affected(env)[0]
