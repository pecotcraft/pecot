"""通過済みレーンを nx の task cache で省く設定の回帰テスト（#1225）。

test_nx_affected_mapping.py と同じく、リポ実体の nx（node_modules/.bin/nx）を NX_DAEMON=false で起動する。
スタブでは、キャッシュの不変条件を捕捉できないため。
捕捉できないのは、「同じ入力なら再実行されない」と「入力が変われば再実行される」の 2 つ。
テストは次の 2 群から成る。

  1. 振る舞い。一時 git リポにリポの nx.json を写し、制御用のフィクスチャ project を置く。
     そのうえで run-affected-tests.sh（pre-push の test）と run-affected-lint.sh（pre-commit の lint）を、
     実際に再実行する。
     test の結果は、hook が書く `.pecot/tmp/githooks-timing.tsv` の task 行の status で判定する。
     lint の結果は、target の command が追記する実行回数で判定する（run-affected-lint.sh は所要を記録しない）。
  2. 設定。リポ実体の各 test / lint target が runtime / env の入力を持つことを、nx の解決結果で見る。
     あわせて、キャッシュしない target が cache: false を明示していることも見る。

実 nx に依存するため、node_modules/.bin/nx が無ければ skip する（npm ci 前は正当な未整備）。
フィクスチャを書き換えるたびに、mtime の秒を変える。
nx が mtime の秒単位でファイルハッシュを使い回すため。
同じ秒内の書き換えは、入力の変化として見えない。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import attach_json, attach_output, read_output, run_attached  # noqa: E402

# parents[0]=tests, [1]=.githooks, [2]=リポルート。
_REPO_ROOT = Path(__file__).resolve().parents[2]
_NX_JSON = _REPO_ROOT / "nx.json"

# nx がキャッシュを再利用したときの status。outputs の無い task のヒットは
# local-cache-kept-existing になる（nx 22 以降の task-orchestrator）。
_REUSED = {"local-cache", "local-cache-kept-existing"}

# env の入力が変わったときの再実行を見るための変数と、再実行されるべきレーン。nx.json に宣言済みで、
# 値を変えても nx 自身や他ツールの動作を変えないものを選ぶ。env は全レーン共通、
# プラグイン別の env はそのプラグインの Globals を使うレーンだけを再実行する。
_COMMON_ENV_PROBE = "HOME"
_PLUGIN_ENV_PROBES: dict[str, tuple[str, ...]] = {
    "PECOT_HOOKS_CONFIG_PATH": ("lane-pecot",),
    "PECOTV_SINGLE_PASS": ("lane-pecotv",),
}

_ANY_VERSION = re.compile(r"\d+\.\d+")


@pytest.fixture(scope="session")
def nx_bin() -> Path:
    """リポジトリ実体の nx 実行ファイル。未導入なら skip。"""
    candidate = _REPO_ROOT / "node_modules" / ".bin" / "nx"
    if not candidate.exists():
        pytest.skip("node_modules/.bin/nx が無い（npm ci 前）ため実 nx テストを skip する")
    return candidate


def _nx_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {**os.environ, "NX_DAEMON": "false"}
    # 呼び出し元の nx 設定がキャッシュの有無を変えないようにする。
    # NX_WORKSPACE_DATA_DIRECTORY は索引 db の場所。outputs の無い test は索引だけで再利用されるため、
    # 設定されていると xdist で並ぶテスト同士が同じ索引を共有して「初回は success」が揺れる。
    # 振る舞いのテスト（_Workspace）は、テストごとの一時ディレクトリを extra で渡して隔離する。
    for key in (
        "NX_SKIP_NX_CACHE",
        "NX_CACHE_DIRECTORY",
        "NX_WORKSPACE_DATA_DIRECTORY",
        "NX_PROFILE",
        "NX_BASE",
        "NX_HEAD",
    ):
        env.pop(key, None)
    env.update(extra or {})
    return env


# 実リポの cwd で起動する nx の置き場。conftest.py が立てた env を、_nx_env が剥がす前に控える。
_REAL_REPO_NX_STATE = {
    key: os.environ[key] for key in ("NX_CACHE_DIRECTORY", "NX_WORKSPACE_DATA_DIRECTORY")
}


def _nx_output(nx_bin: Path, *args: str, attach: bool = True) -> str:
    # stdout はパイプでなくファイルで受ける。nx は stdout がパイプのとき大きな JSON を書き切る前に
    # 終了することがあり、64 KiB 前後で切れた出力を受け取って JSONDecodeError になる (#1217)。
    # attach が偽なら、一部だけを判定に使う大きな出力なので、落ちたときだけ添付する。
    with tempfile.TemporaryFile("w+", encoding="utf-8") as out:
        result = subprocess.run(
            [str(nx_bin), *args],
            cwd=_REPO_ROOT,
            stdout=out,
            stderr=subprocess.PIPE,
            text=True,
            timeout=180,
            env=_nx_env(_REAL_REPO_NX_STATE),
        )
        out.seek(0)
        text = out.read()
        if attach or result.returncode != 0:
            attach_output(f"nx {' '.join(args)}", text, result.stderr, result.returncode)
        assert result.returncode == 0, f"nx 失敗: {result.stderr}"
        return text


# ====
# 振る舞い: フィクスチャ workspace で run-affected-tests.sh を再実行する
# ====


_mtime_counter = 0


def _write(path: Path, text: str) -> None:
    """ファイルを書き、mtime の秒を毎回変える。"""
    global _mtime_counter
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    _mtime_counter += 2
    stamp = int(path.stat().st_mtime) + _mtime_counter
    os.utime(path, (stamp, stamp))


@dataclass
class _Workspace:
    repo: Path
    script: Path
    base_sha: str
    git: Callable[..., subprocess.CompletedProcess]
    git_rev_parse: Callable[..., str]
    flag: Path
    lint_script: Path
    lint_flag: Path
    lint_counter: Path
    nx_state: Path
    tsv_cursor: int = 0
    extra_env: dict[str, str] = field(default_factory=dict)

    @property
    def nx_dirs_env(self) -> dict[str, str]:
        """このテストだけの nx のキャッシュと索引 db の置き場。

        nx 24 はキャッシュを `~/.nx/<remote から決めた id>/` へ置き、一時リポを作るたびにそこが増える。
        remote の無い一時リポは全テストで同じ id になり、索引が混在する。
        そのため `.nx/` の削除では「キャッシュを消した状態」にならない。
        """
        return {
            "NX_CACHE_DIRECTORY": str(self.nx_state / "cache"),
            "NX_WORKSPACE_DATA_DIRECTORY": str(self.nx_state / "workspace-data"),
        }

    def commit_empty(self) -> None:
        self.git(self.repo, "commit", "-q", "--allow-empty", "-m", "chore: empty")

    def run_gate(
        self, extra_env: dict[str, str] | None = None
    ) -> tuple[subprocess.CompletedProcess, dict[str, str]]:
        """pre-push と同じ流れで run-affected-tests.sh を実行し、今回の test task の status を返す。"""
        env = _nx_env(
            {
                "PRE_COMMIT_TO_REF": self.git_rev_parse(self.repo, "HEAD"),
                "PECOT_VERSION_PLAN_BASE": self.base_sha,
                **self.nx_dirs_env,
                **self.extra_env,
                **(extra_env or {}),
            }
        )
        result = run_attached(
            ["bash", str(self.script)],
            cwd=self.repo,
            capture_output=True,
            text=True,
            timeout=180,
            env=env,
        )
        return result, self._new_test_statuses()

    def run_lint(self) -> subprocess.CompletedProcess:
        """pre-commit と同じ流れで run-affected-lint.sh を実行する（lane-lint の変更ファイルを渡す）。"""
        return run_attached(
            ["bash", str(self.lint_script), "lane-lint/src.txt"],
            cwd=self.repo,
            capture_output=True,
            text=True,
            timeout=180,
            env=_nx_env({**self.nx_dirs_env, **self.extra_env}),
        )

    @property
    def lint_runs(self) -> int:
        """lint target の command が実際に実行された回数（再利用されたときは増えない）。"""
        if not self.lint_counter.exists():
            return 0
        return len(read_output(self.lint_counter).splitlines())

    def _new_test_statuses(self) -> dict[str, str]:
        tsv = self.repo / ".pecot" / "tmp" / "githooks-timing.tsv"
        rows = read_output(tsv).splitlines() if tsv.exists() else []
        fresh, self.tsv_cursor = rows[self.tsv_cursor :], len(rows)
        statuses: dict[str, str] = {}
        for row in fresh:
            cols = row.split("\t")
            if len(cols) != 5 or cols[1] != "task":
                continue
            target = cols[2].split(":")[1]
            if target.startswith("test-"):
                statuses[target.removeprefix("test-")] = cols[4].removeprefix("status=")
        return statuses

    def reset_nx(self) -> None:
        """`nx reset` 相当。キャッシュ本体と、索引 db（sqlite）の両方を消す。

        キャッシュだけを消しても索引は残る（outputs の無い task は索引だけで再利用される）。
        """
        shutil.rmtree(self.nx_state, ignore_errors=True)
        shutil.rmtree(self.repo / ".nx", ignore_errors=True)


# lane 名 → test-<lane> target の inputs。実リポと同じく 1 project（fx）の target として並べ、
# `test`（nx:noop）が dependsOn で束ねる。None は targetDefaults（test-*）の inputs を使う
# レーンで、projectRoot 全体が入力になるため別 project（lane-defaults）に置く。
# 実リポの 3 つの Globals を通る流れ（namedInput の入れ子）と、targetDefaults 経由の流れがある。
# 両方で runtime / env が有効になることを見る。
_LANES: dict[str, list[str] | None] = {
    "lane-defaults": None,
    "lane-pecotv": ["{projectRoot}/lane-pecotv/**/*", "sharedGlobals", "pecotvPluginTestGlobals"],
    "lane-pecot": ["{projectRoot}/lane-pecot/**/*", "sharedGlobals", "pecotPluginTestGlobals"],
    "lane-tools": ["{projectRoot}/lane-tools/**/*", "sharedGlobals", "pecotToolsPluginTestGlobals"],
    "lane-flaky": ["{projectRoot}/lane-flaky/**/*", "sharedGlobals", "runtime", "env"],
}


def _lane_target(inputs: list[str] | None, command: str) -> dict:
    target: dict = {
        "executor": "nx:run-commands",
        "dependsOn": [{"projects": ["fx-shared"], "target": "install"}, "build"],
        "options": {"command": command},
    }
    if inputs is not None:
        target["inputs"] = inputs
    return target


def _lanes_project(name: str, lanes: dict[str, dict]) -> str:
    """lanes（lane 名 → target）を test-<lane> として持ち、test が束ねる project。"""
    targets: dict = {
        "build": {"executor": "nx:run-commands", "options": {"command": "echo build"}},
        "test": {"executor": "nx:noop", "dependsOn": [f"test-{lane}" for lane in lanes]},
    }
    targets.update({f"test-{lane}": target for lane, target in lanes.items()})
    return json.dumps({"name": name, "targets": targets})


def _lane_src(repo: Path, name: str) -> Path:
    """lane の入力ファイル。fx のレーンは fx/<lane>/ にあり、lane-defaults は自分の project 直下にある。"""
    return repo / (name if _LANES[name] is None else f"fx/{name}") / "src.txt"


@pytest.fixture
def ws(
    git_repo: Callable[..., Path], git, git_rev_parse, tmp_path: Path, nx_bin: Path
) -> _Workspace:
    repo = git_repo("ws", initial_branch="main")
    shutil.copyfile(_NX_JSON, repo / "nx.json")
    shutil.copyfile(_REPO_ROOT / ".nxignore", repo / ".nxignore")
    (repo / "package.json").write_text('{"name": "cache-fixture", "private": true}\n')
    (repo / ".gitignore").write_text("node_modules/\n.nx/\n.pecot/\n")
    (repo / "node_modules").symlink_to(_REPO_ROOT / "node_modules")
    flag = tmp_path / "flaky.flag"
    lint_flag = tmp_path / "lint-fail.flag"
    lint_counter = tmp_path / "lint-runs.log"

    # install は実リポと同じく cache: false。毎回実行されても test が再利用されることを見る。
    (repo / "shared").mkdir()
    (repo / "shared" / "project.json").write_text(
        json.dumps(
            {
                "name": "fx-shared",
                "targets": {
                    "install": {
                        "executor": "nx:run-commands",
                        "cache": False,
                        "options": {"command": "echo install"},
                    }
                },
            }
        )
    )
    # commit 時の lint 用。実リポと同じく lint（nx:noop）が lint-* を束ねる。command は実行の
    # たびに 1 行追記するので、再利用（追記なし）と再実行（追記あり）を数えて見分けられる。
    # flag があると失敗する。
    (repo / "lane-lint").mkdir()
    (repo / "lane-lint" / "project.json").write_text(
        json.dumps(
            {
                "name": "lane-lint",
                "targets": {
                    "lint": {"executor": "nx:noop", "dependsOn": ["lint-src"]},
                    "lint-src": {
                        "executor": "nx:run-commands",
                        "options": {
                            "command": f"echo ran >> {lint_counter} && test ! -e {lint_flag}"
                        },
                    },
                },
            }
        )
    )
    (repo / "lane-lint" / "src.txt").write_text("v0\n")
    fx_lanes: dict[str, dict] = {}
    for name, inputs in _LANES.items():
        command = f"test ! -e {flag}" if name == "lane-flaky" else f"echo ran {name}"
        target = _lane_target(inputs, command)
        if inputs is None:
            (repo / name).mkdir()
            (repo / name / "project.json").write_text(_lanes_project(name, {name: target}))
            (repo / name / "src.txt").write_text("v0\n")
        else:
            fx_lanes[name] = target
            (repo / "fx" / name).mkdir(parents=True)
            (repo / "fx" / name / "src.txt").write_text("v0\n")
    (repo / "fx" / "project.json").write_text(_lanes_project("fx", fx_lanes))
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "chore: init")
    base_sha = git_rev_parse(repo, "HEAD")

    # 全 lane の src を変える feature commit を 1 つ置く（全 lane が affected になる）。
    git(repo, "checkout", "-q", "-b", "feature")
    for name in _LANES:
        _write(_lane_src(repo, name), "v1\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "feat: touch every lane")

    script = _REPO_ROOT / ".githooks" / "ci" / "run-affected-tests.sh"
    lint_script = _REPO_ROOT / ".githooks" / "pre-commit" / "run-affected-lint.sh"
    return _Workspace(
        repo,
        script,
        base_sha,
        git,
        git_rev_parse,
        flag,
        lint_script,
        lint_flag,
        lint_counter,
        tmp_path / "nx-state",
    )


def _lane_status(statuses: dict[str, str]) -> dict[str, str]:
    return {name: statuses.get(name, "missing") for name in _LANES}


def _wrapper_bin(tmp_path: Path, tool: str, version_output: str | None = None) -> Path:
    """`<tool> --version` にだけ別の出力を返し、他の引数は実体へ素通しするラッパーの置き場。"""
    real = shutil.which(tool)
    if real is None:
        pytest.skip(f"{tool} が PATH に無い")
    output = version_output if version_output is not None else f"{tool} 0.0.0-wrapper"
    bin_dir = tmp_path / f"wrapper-{tool}-{abs(hash(output))}"
    bin_dir.mkdir()
    script = bin_dir / tool
    script.write_text(
        f'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "{output}"; exit 0; fi\n'
        f'exec "{real}" "$@"\n'
    )
    script.chmod(0o755)
    return bin_dir


@allure.title("空のコミットを push し直すと、すべてのレーンがキャッシュを再利用する")
def test_empty_commit_repush_reuses_every_lane(ws: _Workspace) -> None:
    """実際の nx を使った、pre-push のテストの task cache のテストです。1 回目のレーンがすべて `success` になり、空のコミットを挟んだ 2 回目は、すべてのレーンが再利用されることを確認します。"""
    with allure.step("push 前のチェックを 1 回目に動かす"):
        first, first_statuses = ws.run_gate()
    with allure.step("全レーンが成功することを確かめる"):
        assert first.returncode == 0, first.stderr
        assert _lane_status(first_statuses) == dict.fromkeys(_LANES, "success")

    with allure.step("空の commit を足して、2 回目を動かす"):
        ws.commit_empty()
        second, second_statuses = ws.run_gate()
    with allure.step("全レーンが再利用されることを確かめる"):
        assert second.returncode == 0, second.stderr
        reused = _lane_status(second_statuses)
        assert all(status in _REUSED for status in reused.values()), reused


@allure.title("あるレーンの入力を変更すると、そのレーンだけが再実行される")
def test_changed_input_reruns_only_its_lane(ws: _Workspace) -> None:
    """`lane-tools` のソースを変更してコミットした場合のテストです。`lane-tools` だけが `success` で再実行され、ほかのレーンはキャッシュを再利用することを確認します。"""
    with allure.step("push 前のチェックを 1 回目に動かす"):
        assert ws.run_gate()[0].returncode == 0
    with allure.step("lane-tools の入力を変えて commit する"):
        _write(_lane_src(ws.repo, "lane-tools"), "v2\n")
        ws.git(ws.repo, "add", "-A")
        ws.git(ws.repo, "commit", "-q", "-m", "fix: lane-tools")

    with allure.step("push 前のチェックを動かす"):
        result, statuses = ws.run_gate()
    with allure.step("lane-tools だけが再実行されることを確かめる"):
        assert result.returncode == 0, result.stderr
        lanes = _lane_status(statuses)
        assert lanes.pop("lane-tools") == "success"
        assert all(status in _REUSED for status in lanes.values()), lanes


@allure.title("失敗したレーンは、入力が同じでも再利用せずに再実行する")
def test_failed_lane_is_rerun_not_reused(ws: _Workspace) -> None:
    """`lane-flaky` を失敗させて、空のコミットで push し直す場合のテストです。2 回目も失敗が再利用されずに終了コードが 0 以外になり、原因を取り除いた 3 回目は成功することを確認します。"""
    with allure.step("レーンが失敗するようにして、1 回目を動かす"):
        ws.flag.write_text("fail\n")
        first, first_statuses = ws.run_gate()
    with allure.step("失敗することを確かめる"):
        assert first.returncode != 0
        assert first_statuses["lane-flaky"] == "failure"

    with allure.step("空の commit を足して、2 回目を動かす"):
        ws.commit_empty()
        second, second_statuses = ws.run_gate()
    with allure.step("失敗が再利用されず、また失敗することを確かめる"):
        assert second.returncode != 0, "失敗が再利用されて push が通ってしまった"
        assert second_statuses["lane-flaky"] == "failure"

    with allure.step("失敗の原因を外し、空の commit を足して、3 回目を動かす"):
        # 入力は変えずに失敗の原因だけ取り除くと、再実行されて成功する。
        ws.flag.unlink()
        ws.commit_empty()
        third, third_statuses = ws.run_gate()
    with allure.step("成功することを確かめる"):
        assert third.returncode == 0, third.stderr
        assert third_statuses["lane-flaky"] == "success"


@allure.title("入力が同じなら、commit 時の lint は前回の成功を再利用する")
def test_lint_with_unchanged_input_is_reused(ws: _Workspace) -> None:
    """pre-commit の lint を、入力を変えずに 2 回実行する場合のテストです。2 回目は lint が再実行されず、実行回数が 1 回のままであることを確認します。"""
    with allure.step("lint を 1 回目に動かす"):
        first = ws.run_lint()
    with allure.step("成功し、実行が 1 回であることを確かめる"):
        assert first.returncode == 0, first.stderr
        assert ws.lint_runs == 1

    with allure.step("lint を 2 回目に動かす"):
        second = ws.run_lint()
    with allure.step("再利用され、実行が 1 回のままであることを確かめる"):
        assert second.returncode == 0, second.stderr
        assert ws.lint_runs == 1, "同じ入力なのに lint が再実行された"


@allure.title("入力を変更すると、commit 時の lint を再実行する")
def test_lint_input_change_reruns(ws: _Workspace) -> None:
    """pre-commit の lint を実行したあとに、`lane-lint` の入力を変更して再び実行する場合のテストです。lint の実行回数が 2 回になることを確認します。"""
    with allure.step("lint を動かし、入力を変えて、もう一度動かす"):
        assert ws.run_lint().returncode == 0
        _write(ws.repo / "lane-lint" / "src.txt", "v1\n")
        assert ws.run_lint().returncode == 0
    with allure.step("実行が 2 回であることを確かめる"):
        assert ws.lint_runs == 2


@allure.title("失敗した lint は、直るまで再利用せずに再実行する")
def test_failed_lint_is_rerun_until_fixed(ws: _Workspace) -> None:
    """lint を失敗させたあと、入力を変えずに再び実行する場合のテストです。2 回目も失敗が再利用されずに再実行され、原因を取り除いた 3 回目に成功することを確認します。"""
    with allure.step("lint が失敗するようにして、1 回目を動かす"):
        ws.lint_flag.write_text("fail\n")
        first = ws.run_lint()
    with allure.step("失敗し、実行が 1 回であることを確かめる"):
        assert first.returncode != 0
        assert ws.lint_runs == 1

    with allure.step("2 回目を動かす"):
        second = ws.run_lint()
    with allure.step("失敗が再利用されず、実行が 2 回であることを確かめる"):
        assert second.returncode != 0, "失敗した lint が再利用されて commit が通ってしまった"
        assert ws.lint_runs == 2

    with allure.step("失敗の原因を外して、3 回目を動かす"):
        ws.lint_flag.unlink()
        third = ws.run_lint()
    with allure.step("成功し、実行が 3 回であることを確かめる"):
        assert third.returncode == 0, third.stderr
        assert ws.lint_runs == 3


@allure.title("共通の環境変数を変更すると、すべてのレーンが再実行される")
def test_common_env_change_reruns_every_lane(ws: _Workspace, tmp_path: Path) -> None:
    """`nx.json` の `env` に宣言した、共通の環境変数 `HOME` を変更する場合のテストです。同じ値ならすべてのレーンが再利用され、値を変えるとすべてのレーンが再実行されることを確認します。"""
    with allure.step("nx.json の env を読み、共通の変数が宣言されていることを確かめる"):
        declared = _declared_env(json.loads(_NX_JSON.read_text(encoding="utf-8")))
        assert _COMMON_ENV_PROBE in declared, (
            f"{_COMMON_ENV_PROBE} が nx.json の env に宣言されていない"
        )

    with allure.step("env の置き場を 2 つ用意し、1 回目を動かす"):
        home_a, home_b = tmp_path / "home-a", tmp_path / "home-b"
        home_a.mkdir()
        home_b.mkdir()
        assert ws.run_gate({_COMMON_ENV_PROBE: str(home_a)})[0].returncode == 0
    with allure.step("空の commit を足し、同じ env で動かす"):
        ws.commit_empty()
        same, same_statuses = ws.run_gate({_COMMON_ENV_PROBE: str(home_a)})
    with allure.step("同じ env のとき、全レーンが再利用されることを確かめる"):
        assert same.returncode == 0, same.stderr
        assert all(s in _REUSED for s in _lane_status(same_statuses).values()), same_statuses

    with allure.step("空の commit を足し、別の env で動かす"):
        ws.commit_empty()
        changed, changed_statuses = ws.run_gate({_COMMON_ENV_PROBE: str(home_b)})
    with allure.step("別の env のとき、全レーンが再実行されることを確かめる"):
        assert changed.returncode == 0, changed.stderr
        assert _lane_status(changed_statuses) == dict.fromkeys(_LANES, "success")


@allure.title(
    "プラグイン別の環境変数 {variable} を変更すると、そのプラグインのレーンだけが再実行される"
)
@pytest.mark.parametrize(("variable", "rerun_lanes"), sorted(_PLUGIN_ENV_PROBES.items()))
def test_plugin_env_change_reruns_only_that_plugins_lanes(
    ws: _Workspace, variable: str, rerun_lanes: tuple[str, ...]
) -> None:
    """プラグインごとに宣言した環境変数を変更する場合のテストです。その環境変数を使うレーンだけが再実行され、無関係なレーンはキャッシュを再利用することを確認します。"""
    with allure.step("env を a にして動かし、空の commit を足して、b にして動かす"):
        assert ws.run_gate({variable: "a"})[0].returncode == 0
        ws.commit_empty()
        result, statuses = ws.run_gate({variable: "b"})
    with allure.step("そのプラグインのレーンだけが再実行されることを確かめる"):
        assert result.returncode == 0, result.stderr
        for name, status in _lane_status(statuses).items():
            if name in rerun_lanes:
                assert status == "success", (
                    f"{name}: {variable} が変わったのに再実行されない ({status})"
                )
            else:
                assert status in _REUSED, (
                    f"{name}: {variable} と無関係なのに再実行された ({status})"
                )


@allure.title("{tool} の版が変わると、その版を入力に持つレーンだけが再実行される")
@pytest.mark.parametrize(
    ("tool", "rerun_lanes"),
    [
        # 全レーン共通の runtime。
        ("node", tuple(_LANES)),
        # レーン固有の runtime は、その Globals を使うレーンだけを再実行する。
        ("aws", ("lane-tools",)),
    ],
)
def test_runtime_change_reruns_only_lanes_that_use_the_tool(
    ws: _Workspace, tmp_path: Path, tool: str, rerun_lanes: tuple[str, ...]
) -> None:
    """`--version` の出力を差し替えたラッパーを、`PATH` の先頭に置いて実行する場合のテストです。`node` では全レーン、`aws` では `lane-tools` だけが再実行され、ほかのレーンは再利用されることを確認します。"""
    with allure.step("push 前のチェックを動かし、ツールの版を変えて、もう一度動かす"):
        assert ws.run_gate()[0].returncode == 0
        ws.commit_empty()

        bin_dir = _wrapper_bin(tmp_path, tool)
        path = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"
        result, statuses = ws.run_gate({"PATH": path})
    with allure.step("ツールを使うレーンだけが再実行されることを確かめる"):
        assert result.returncode == 0, result.stderr
        lanes = _lane_status(statuses)
        for name, status in lanes.items():
            if name in rerun_lanes:
                assert status == "success", (
                    f"{name}: {tool} の版が変わったのに再実行されない ({status})"
                )
            else:
                assert status in _REUSED, (
                    f"{name}: {tool} の版と無関係なのに再実行された ({status})"
                )


@allure.title("aws の版の出力に含まれるカーネルの版が変わっても、キャッシュを再利用する")
def test_aws_runtime_ignores_the_kernel_version_in_its_output(
    ws: _Workspace, tmp_path: Path
) -> None:
    """`aws --version` の出力に、ホストのカーネルの版が含まれる場合のテストです。カーネルの版だけを変えて実行しても、`lane-tools` が再利用されることを確認します。"""
    with allure.step("カーネルの版を差し替えられる aws の出力を用意する"):
        version = "aws-cli/2.0.0 Python/3.13.0 Linux/{kernel} exe/x86_64.debian.12"

        def gate_with_kernel(kernel: str) -> dict[str, str]:
            bin_dir = _wrapper_bin(tmp_path, "aws", version.format(kernel=kernel))
            path = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"
            result, statuses = ws.run_gate({"PATH": path})
            assert result.returncode == 0, result.stderr
            return _lane_status(statuses)

    with allure.step("1 回目の push 前のチェックが成功することを確かめる"):
        assert gate_with_kernel("7.0.0-38-generic")["lane-tools"] == "success"
    with allure.step("空の commit を足し、カーネルの版を変えて動かす"):
        ws.commit_empty()
    with allure.step("lane-tools が再利用されることを確かめる"):
        assert gate_with_kernel("7.0.0-41-generic")["lane-tools"] in _REUSED


@allure.title("nx のキャッシュをリセットすると、すべてのレーンを実行し直す")
def test_nx_reset_falls_back_to_execution(ws: _Workspace) -> None:
    """`nx reset` でキャッシュを消した場合のテストです。再利用できる結果が残っていなくても、すべてのレーンが実行されて `success` になることを確認します。"""
    with allure.step("push 前のチェックを動かし、nx を初期化して、もう一度動かす"):
        assert ws.run_gate()[0].returncode == 0
        ws.commit_empty()
        ws.reset_nx()
        result, statuses = ws.run_gate()
    with allure.step("全レーンが実行に戻ることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert _lane_status(statuses) == dict.fromkeys(_LANES, "success")


# ====
# 設定: リポ実体の target が runtime / env を持ち、cache の有無を明示している
# ====


def _declared_env(nx_json: dict, input_name: str = "env") -> list[str]:
    entries = nx_json["namedInputs"].get(input_name, [])
    return [e["env"] for e in entries if isinstance(e, dict) and "env" in e]


def _project_jsons() -> list[Path]:
    roots = [
        _REPO_ROOT / "plugins",
        _REPO_ROOT / "libs",
        _REPO_ROOT / ".nx",
        _REPO_ROOT / ".githooks",
    ]
    found: list[Path] = []
    for root in roots:
        for path in sorted(root.rglob("project.json")):
            if "node_modules" not in path.parts:
                found.append(path)
    return found


def _is_test_or_lint(target: str) -> bool:
    """push / commit のチェックが実行する target（起点の test / lint と、レーンの test-* / lint-*）。"""
    return target in {"test", "lint"} or target.startswith(("test-", "lint-"))


def _declared_targets() -> list[tuple[str, str, dict]]:
    """project.json に書かれた test / lint のレーン (project, target, 設定)。

    レーンを束ねる起点（nx:noop）は何も実行しないので含めない。
    """
    out: list[tuple[str, str, dict]] = []
    for path in _project_jsons():
        data = json.loads(path.read_text(encoding="utf-8"))
        for target, config in data.get("targets", {}).items():
            if _is_test_or_lint(target) and config.get("executor") != "nx:noop":
                out.append((data["name"], target, config))
    return out


# プラグインのディレクトリ名 → そのプラグインのレーンが使う env の namedInput。
_PLUGIN_ENV_INPUT = {
    "pecot-workflow": "pecotPluginEnv",
    "pecot-visual": "pecotvPluginEnv",
}


# プラグインに同梱し、そのプラグインの env を入力に持つライブラリの project。
_BUNDLED_LIB_PLUGIN = {"workflow-core": "pecot-workflow"}


def _project_plugins() -> dict[str, str]:
    """project 名 → それが属するプラグインのディレクトリ名（plugins/ 配下と、同梱するライブラリ）。"""
    out: dict[str, str] = dict(_BUNDLED_LIB_PLUGIN)
    for path in _project_jsons():
        rel = path.relative_to(_REPO_ROOT).parts
        if rel[0] == "plugins":
            out[json.loads(path.read_text(encoding="utf-8"))["name"]] = rel[1]
    return out


_PROJECT_PLUGIN = _project_plugins()
_TEST_LINT = _declared_targets()
_TEST_LINT_IDS = [f"{project}:{target}" for project, target, _ in _TEST_LINT]


@pytest.fixture(scope="session")
def resolved_targets(nx_bin: Path, tmp_path_factory: pytest.TempPathFactory) -> dict[str, dict]:
    """nx が targetDefaults を畳んだ後の全 target 設定（`project:target` → 設定）。"""
    out = tmp_path_factory.mktemp("graph") / "graph.json"
    _nx_output(nx_bin, "graph", f"--file={out}")
    nodes = json.loads(out.read_text(encoding="utf-8"))["graph"]["nodes"]
    resolved = {
        f"{project}:{target}": config
        for project, node in nodes.items()
        for target, config in node["data"]["targets"].items()
    }
    attach_json(
        "graph.json の target の executor・cache・dependsOn",
        {
            key: {name: config.get(name) for name in ("executor", "cache", "dependsOn")}
            for key, config in resolved.items()
        },
    )
    return resolved


def _target_inputs(nx_bin: Path, project_target: str) -> dict:
    """files は大きいので、files を判定するテストが自分で読んだ分だけを添付する。"""
    inputs = json.loads(
        _nx_output(nx_bin, "show", "target", "inputs", project_target, "--json", attach=False)
    )
    attach_json(
        f"{project_target} の inputs（files を除く）",
        {key: value for key, value in inputs.items() if key != "files"},
    )
    return inputs


@allure.title("project.json に宣言していない test と lint の target は、graph に存在しない")
def test_graph_has_no_test_or_lint_target_outside_project_json(
    resolved_targets: dict[str, dict],
) -> None:
    """graph に現れる test と lint の target のテストです。`package.json` などから推論された target が含まれず、`project.json` に宣言した target と一致することを確認します。"""
    with allure.step("解決した target から test と lint のものを集める"):
        resolved = {
            k
            for k, config in resolved_targets.items()
            if _is_test_or_lint(k.split(":", 1)[1]) and config.get("executor") != "nx:noop"
        }
    with allure.step("project.json の外から推論された target が無いことを確かめる"):
        assert resolved == set(_TEST_LINT_IDS)


@allure.title("起点の test と lint は、同じ project のレーンだけを束ねる")
def test_entry_targets_only_bundle_lanes(resolved_targets: dict[str, dict]) -> None:
    """`nx:noop` の起点の target のテストです。`dependsOn` が、同じ project の `test-*` または `lint-*` のレーンと過不足なく一致することを確認します。"""
    with allure.step("起点の target が、同じ project のレーンだけを束ねることを確かめる"):
        for key, config in resolved_targets.items():
            project, target = key.split(":", 1)
            if target not in {"test", "lint"} or config.get("executor") != "nx:noop":
                continue
            lanes = {
                t
                for k, t in (s.split(":", 1) for s in resolved_targets)
                if k == project and t.startswith(f"{target}-")
            }
            assert set(config.get("dependsOn", [])) == lanes, key


@allure.title("{project_target} は、キャッシュを有効にし、runtime と環境変数を入力に宣言する")
@pytest.mark.parametrize("project_target", _TEST_LINT_IDS)
def test_cacheable_target_declares_runtime_and_env(
    nx_bin: Path, resolved_targets: dict[str, dict], project_target: str
) -> None:
    """test と lint の各 target のテストです。`cache` が `true` で、入力に `node --version` と、共通と自分のプラグインの環境変数が含まれ、ほかのプラグインの変数は含まれないことを確認します。"""
    with allure.step("target の設定を読み、cache が true であることを確かめる"):
        config = resolved_targets[project_target]
        assert config.get("cache") is True, f"{project_target} が cache: true でない"

    with allure.step("nx.json の env と target の入力を読む"):
        nx_json = json.loads(_NX_JSON.read_text(encoding="utf-8"))
        declared_env = _declared_env(nx_json)
        assert declared_env, "nx.json の env が空"
        inputs = _target_inputs(nx_bin, project_target)
    with allure.step("runtime に node の版が入ることを確かめる"):
        assert "node --version" in inputs.get("runtime", []), inputs
    with allure.step("env の入力に宣言した変数があり、他のプラグインの変数が無いことを確かめる"):
        # 共通の env は全レーンに、プラグイン別の env はそのプラグインのレーンだけに入る。
        expected = set(declared_env)
        unexpected: set[str] = set()
        for plugin, env_input in _PLUGIN_ENV_INPUT.items():
            names = set(_declared_env(nx_json, env_input))
            assert names, f"nx.json の {env_input} が空"
            if _PROJECT_PLUGIN.get(project_target.split(":", 1)[0]) == plugin:
                expected |= names
            else:
                unexpected |= names
        missing = sorted(expected - set(inputs.get("environment", [])))
        assert not missing, f"{project_target} の env 入力に無い変数: {missing}"
        leaked = sorted((unexpected - expected) & set(inputs.get("environment", [])))
        assert not leaked, f"{project_target} の env 入力に他プラグインの変数がある: {leaked}"


@allure.title("{project_target} は、そのレーン固有の runtime を入力に宣言する")
@pytest.mark.parametrize(
    ("project_target", "commands"),
    [("pecot-tools:test-cli", ["aws --version | cut -d' ' -f1"])],
)
def test_lane_specific_runtime_is_declared(
    nx_bin: Path, project_target: str, commands: list[str]
) -> None:
    """`pecot-tools:test-cli` の runtime のテストです。`aws --version` から版の先頭の 1 語だけを取り出すコマンドが、入力の runtime に含まれることを確認します。"""
    with allure.step("target の runtime の入力を読む"):
        runtime = _target_inputs(nx_bin, project_target).get("runtime", [])
    with allure.step("レーンに固有の runtime が宣言されていることを確かめる"):
        assert set(commands) <= set(runtime), runtime


@allure.title("pecot-workflow:{lane} は、uv の版を runtime の入力に宣言しない")
@pytest.mark.parametrize("lane", ["test-hooks", "test-skills"])
def test_pecot_workflow_lanes_do_not_declare_the_uv_runtime(nx_bin: Path, lane: str) -> None:
    """vitest だけで動く、`pecot-workflow` のレーンの runtime のテストです。入力の runtime に、`uv --version` が含まれないことを確認します。"""
    with allure.step("レーンの runtime の入力を読む"):
        runtime = _target_inputs(nx_bin, f"pecot-workflow:{lane}").get("runtime", [])
    with allure.step("uv の版が入っていないことを確かめる"):
        assert "uv --version" not in runtime, runtime


@allure.title("nx を起動する環境から、キャッシュの置き場を変える環境変数を除く")
def test_nx_env_drops_the_variables_that_move_the_cache_location(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`NX_CACHE_DIRECTORY` など 3 つの環境変数を設定した状態で、`_nx_env` を呼ぶテストです。3 つの変数が環境に含まれず、`NX_DAEMON` が `false` であることを確認します。"""
    with allure.step("キャッシュの場所を動かす変数を設定し、nx の env を作る"):
        for key in ("NX_CACHE_DIRECTORY", "NX_WORKSPACE_DATA_DIRECTORY", "NX_SKIP_NX_CACHE"):
            monkeypatch.setenv(key, "/somewhere/else")
        env = _nx_env()
    with allure.step("それらの変数が env から消え、NX_DAEMON が false であることを確かめる"):
        assert not {"NX_CACHE_DIRECTORY", "NX_WORKSPACE_DATA_DIRECTORY", "NX_SKIP_NX_CACHE"} & set(
            env
        )
        assert env["NX_DAEMON"] == "false"


_SLIDEV_BUILD = "build-slidev"
_SLIDEV = "plugins/pecot-visual/assets/slidev/"


@allure.title("{project_target} は、eslint plugin の dist を作る build-slidev を先に実行する")
@pytest.mark.parametrize("project_target", ["pecot-visual:test-cli"])
def test_lane_that_runs_template_eslint_plugins_builds_them_first(
    resolved_targets: dict[str, dict], project_target: str
) -> None:
    """`assets/slidev` の eslint plugin を起動するレーンのテストです。`dependsOn` に `build-slidev` が含まれることを確認します。"""
    with allure.step("レーンの dependsOn に slidev の build が入っていることを確かめる"):
        assert _SLIDEV_BUILD in resolved_targets[project_target]["dependsOn"]


@allure.title("pecot-visual:test-cli の inputs は、deck の lint の設定と plugin のソースだけを含む")
def test_cli_test_inputs_take_the_deck_lint_files_but_not_the_layouts(nx_bin: Path) -> None:
    """`assets/slidev` のうち、`pecot-visual:test-cli` の inputs に含まれるファイルのテストです。`deck-lint` の設定と eslint plugin のソースは含まれ、`templates/` のレイアウトや plugin のテストは含まれないことを確認します。"""
    with allure.step("cli の test の inputs から slidev のファイルを集める"):
        files = [
            f
            for f in _target_inputs(nx_bin, "pecot-visual:test-cli")["files"]
            if f.startswith(_SLIDEV)
        ]
        attach_json(f"pecot-visual:test-cli の inputs の {_SLIDEV} の files", files)
    with allure.step(
        "eslint の設定と plugin のソースだけが入り、レイアウトとテストは入らないことを確かめる"
    ):
        assert _SLIDEV + "deck-lint.config.js" in files
        assert _SLIDEV + "deck-lint.env.config.js" in files
        assert _SLIDEV + "scripts/eslint/slidev-pages-lint/index.ts" in files
        assert not [f for f in files if f.startswith(_SLIDEV + "templates/")]
        # pecotvPluginTestGlobals の package.json / .npmrc を除くと、残るのは eslint 設定・plugin ソースだけ。
        others = [
            f
            for f in files
            if f.rsplit("/", 1)[-1] not in {"package.json", ".npmrc"}
            and f
            not in {
                _SLIDEV + "deck-lint.config.js",
                _SLIDEV + "deck-lint.env.config.js",
            }
            and not f.startswith(_SLIDEV + "scripts/eslint/")
        ]
        assert not others, (
            f"cli の test の inputs に eslint 設定・plugin ソース以外が入っている: {others[:5]}"
        )
        in_tests = [f for f in files if "/tests/" in f]
        assert not in_tests, f"eslint plugin のテストが inputs に入っている: {in_tests[:3]}"


@allure.title(
    "pecot-visual:test-hooks の inputs は、slidev の資産と fixture を含まず、node-runtime.ts を含む"
)
def test_hooks_test_inputs_do_not_take_slidev_assets(nx_bin: Path) -> None:
    """`pecot-visual:test-hooks` の inputs のテストです。slidev の資産と `cli/tests/fixtures/` のファイルは `package.json` を除いて含まれず、`node-runtime.ts` が含まれることを確認します。"""
    with allure.step("hooks の test の inputs のファイルを集める"):
        files = _target_inputs(nx_bin, "pecot-visual:test-hooks")["files"]
        attach_json(
            "pecot-visual:test-hooks の inputs の、判定に使う files",
            [f for f in files if f.startswith(_SLIDEV) or "/cli/tests/fixtures/" in f],
        )

    with allure.step("slidev の資産と fixture が入らず、node-runtime.ts が入ることを確かめる"):
        assert not [f for f in files if f.startswith(_SLIDEV) and not f.endswith("/package.json")]
        assert not [
            f for f in files if "/cli/tests/fixtures/" in f and not f.endswith("/package.json")
        ]
        assert "plugins/pecot-visual/cli/src/node-runtime.ts" in files


# 版の文字列を出さない runtime コマンドの出力の形。lock のハッシュと、dpkg の「名前=版」の一覧。
_HASH = re.compile(r"^[0-9a-f]{40}\n$")
_RUNTIME_OUTPUT_PATTERNS = {
    "git hash-object pnpm-lock.yaml": _HASH,
    "dpkg-query -W -f='${Package}=${Version}\\n'": re.compile(r"^\S+=\S+$", re.M),
}


@allure.title("runtime の各コマンドは、終了コード 0 で終わり、版を含む出力を返す")
def test_runtime_commands_exit_zero_and_print_a_version(nx_bin: Path) -> None:
    """すべての test と lint の target が、入力に宣言した runtime のコマンドのテストです。ワークスペースのルートで実行して終了コード 0 で終わり、出力が版やハッシュなど、期待する形であることを確認します。"""
    with allure.step("test と lint の target の runtime を集める"):
        commands: set[str] = set()
        for project, target, _ in _TEST_LINT:
            commands.update(_target_inputs(nx_bin, f"{project}:{target}").get("runtime", []))
    with allure.step("各 runtime のコマンドを動かし、終了コード 0 で版が出ることを確かめる"):
        assert commands, "runtime の入力が 1 つも宣言されていない"
        for command in sorted(commands):
            result = run_attached(
                command,
                shell=True,
                cwd=_REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=60,
                env=_nx_env(),
            )
            assert result.returncode == 0, (
                f"`{command}` が exit {result.returncode}: {result.stderr}"
            )
            # `git ls-files ... | git hash-object --stdin` の形の入力（ファイルの実在）も、hash を出す。
            pattern = (
                _HASH
                if command.endswith("| git hash-object --stdin")
                else _RUNTIME_OUTPUT_PATTERNS.get(command, _ANY_VERSION)
            )
            assert pattern.search(result.stdout), (
                f"`{command}` の出力が期待の形でない: {repr(result.stdout[:200])}"
            )


@allure.title("{project_target} は、cache を false と明示している")
@pytest.mark.parametrize(
    "project_target",
    [
        "pecot-visual:install",
        "pecot-visual:check-pm-guard",
        "pecot-tools:install",
        "pecot-workflow:install",
        "pecot-visual:chromium-preflight",
        "pecot-visual:build-cli",
        "pecot-visual:build-slidev",
        "pecot-tools:build-cli",
        "pecot-workflow:build-cli",
        "pecot-workflow:test",
        "pecot-workflow:lint",
        "pecot-visual:test",
        "pecot-visual:lint",
        "pecot-tools:test",
        "nx-release:test",
        "text-rules:install",
        "text-rules:build",
        "text-rules:test",
    ],
)
def test_non_cacheable_target_says_cache_false(
    resolved_targets: dict[str, dict], project_target: str
) -> None:
    """キャッシュしない target のテストです。graph に解決した設定の `cache` が、`false` であることを確認します。"""
    with allure.step("target が cache: false であることを確かめる"):
        assert resolved_targets[project_target].get("cache") is False


@allure.title("nx:noop の起点の target は、inputs を持たない")
def test_noop_entry_targets_have_no_inputs(resolved_targets: dict[str, dict]) -> None:
    """起点の `test` と `lint` のテストです。`nx.json` の `nx:noop` の `inputs` が空で、解決後の起点の target も `inputs` が空であることを確認します。"""
    with allure.step("nx.json と起点の target を読む"):
        nx_json = json.loads(_NX_JSON.read_text(encoding="utf-8"))
    with allure.step("起点の target が inputs を持たないことを確かめる"):
        assert nx_json["targetDefaults"]["nx:noop"]["inputs"] == []
        entries = {
            key: config
            for key, config in resolved_targets.items()
            if config.get("executor") == "nx:noop" and key.split(":", 1)[1] in {"test", "lint"}
        }
        assert {
            "pecot-visual:lint",
            "pecot-visual:test",
            "pecot-workflow:test",
            "pecot-workflow:lint",
            "pecot-tools:test",
            "text-rules:test",
        } <= set(entries)
        for key, config in entries.items():
            assert config.get("inputs") == [], f"{key} の inputs が空でない: {config.get('inputs')}"


@allure.title("リリースの設定は、0.x の版の上げ方を nx 22 と同じにする")
def test_release_keeps_zero_major_versions_as_before_nx_24() -> None:
    """`nx.json` の `release` の設定のテストです。`adjustSemverBumpsForZeroMajorVersion` が `false` であることを確認します。"""
    with allure.step("nx.json の release を読む"):
        release = json.loads(_NX_JSON.read_text(encoding="utf-8"))["release"]
    with allure.step("0.x の bump を下げない設定であることを確かめる"):
        assert release["version"]["adjustSemverBumpsForZeroMajorVersion"] is False


@allure.title("affected の設定は、legacy を置かず、タスク単位の選択を使う")
def test_affected_uses_task_level_selection() -> None:
    """`nx.json` の `affected` の設定のテストです。project 単位の選択に戻す `legacy` が含まれないことを確認します。"""
    with allure.step("nx.json を読む"):
        nx_json = json.loads(_NX_JSON.read_text(encoding="utf-8"))
    with allure.step("affected に legacy が無いことを確かめる"):
        assert "legacy" not in nx_json.get("affected", {})


@allure.title("nx-release のテストは、入っている nx の版を入力として読む")
def test_nx_release_test_reads_the_installed_nx_version() -> None:
    """`.nx/nx-release/project.json` の `test-unit` の inputs のテストです。`package-lock.json` を含まず、`nx/package.json` を読む runtime と、`runtime` および `env` が含まれることを確認します。"""
    with allure.step("nx-release の project.json の inputs を読む"):
        data = json.loads((_REPO_ROOT / ".nx" / "nx-release" / "project.json").read_text("utf-8"))
        inputs = data["targets"]["test-unit"]["inputs"]
    with allure.step("入っている nx の版を入力に見ていることを確かめる"):
        assert "{workspaceRoot}/package-lock.json" not in inputs
        runtimes = [i["runtime"] for i in inputs if isinstance(i, dict) and "runtime" in i]
        assert any("nx/package.json" in command for command in runtimes), inputs
        assert "runtime" in inputs
        assert "env" in inputs
