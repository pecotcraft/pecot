"""conftest.py - .githooks/tests/ 共通フィクスチャ

root 共通フック（.githooks/ 配下の stage ごとのディレクトリの *.sh）の pytest テストが共有するフィクスチャを定義する。
bats 時代の test_helper.bash（`_unset_git_local_env_vars`）に相当する機能を提供する。
各 .bats の setup 相当のセットアップも提供する。
内容は GIT_* 隔離・temp git repo 生成・nx スタブ配置。

plugins/pecot-workflow/hooks/conftest.py からスタイルを踏襲する。
ただしツリー間 import はせず、独立した conftest として複製する。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

import pytest

# pre-push 配下の GIT_* が temp repo の git 操作へ漏れるのを防ぐため、autouse の fixture が GIT_ 始まりを一括で剥がす。
# hooks/conftest.py と違い、.githooks 側は GIT_CONFIG_GLOBAL を足す pass2 を持たないので、7 キー限定にしない。

# push の範囲を決める env（lib/push-range.sh が読む）。引き継ぐと temp repo の base 解決が実リポの値で上書きされる (#1225)。
_PUSH_RANGE_ENV = ("PECOT_VERSION_PLAN_BASE", "PRE_COMMIT_FROM_REF", "PRE_COMMIT_TO_REF")

# CI の run-pr-checks.sh が立てる env。引き継ぐと、手元の既定を確かめるテストが CI の動きで落ちる。
_CI_ENV = (
    "PECOT_NX_CI",
    "PECOT_NX_PARALLEL",
    "NX_SKIP_NX_CACHE",
    "NO_PREV",
    "PECOT_CI_SUMMARY",
    "PECOT_CI_IMAGE",
    "PECOT_CI_NX_CACHE",
    "NX_SELF_HOSTED_REMOTE_CACHE_SERVER",
    "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN",
    "SKIP",
    # tests の job が 1 レーンを動かすときに渡す。
    "PECOT_NX_LANE",
    "CHECKS_LANE",
    "CHECKS_SLUG",
    "CHECKS_PART",
    "PECOT_CI_BROWSER",
)


# 外の nx の task が渡す変数。引き継ぐと、テストの nx が外の task の中と見なされる。
_NX_TASK_ENV = (
    "NX_TASK_TARGET_PROJECT",
    "NX_TASK_TARGET_TARGET",
    "NX_TASK_TARGET_CONFIGURATION",
    "NX_TASK_HASH",
    "LERNA_PACKAGE_NAME",
    "NX_WORKSPACE_ROOT",
    "NX_TERMINAL_OUTPUT_PATH",
    "NX_TERMINAL_CAPTURE_STDERR",
    "NX_STREAM_OUTPUT",
    "NX_PREFIX_OUTPUT",
    "NX_FORKED_TASK_EXECUTOR",
    "NX_PROFILE",
    "NX_LOAD_DOT_ENV_FILES",
    "NX_BASE",
    "NX_HEAD",
)


_nx_state_roots: list[str] = []


def pytest_configure(config: pytest.Config) -> None:
    # 外の nx の索引 db と分けた置き場を、実行ごとに 1 つ作る。worker は controller の env を引き継いで共有する。
    if hasattr(config, "workerinput"):
        return
    root = tempfile.mkdtemp(prefix="nx-real-repo-")
    _nx_state_roots.append(root)
    os.environ["NX_CACHE_DIRECTORY"] = f"{root}/cache"
    os.environ["NX_WORKSPACE_DATA_DIRECTORY"] = f"{root}/workspace-data"
    for key in _NX_TASK_ENV:
        os.environ.pop(key, None)


def pytest_unconfigure(config: pytest.Config) -> None:
    for root in _nx_state_roots:
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(autouse=True)
def _isolate_git_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(os.environ):
        if (
            key.startswith("GIT_")
            or key in _PUSH_RANGE_ENV
            or key in _CI_ENV
            or key in _NX_TASK_ENV
        ):
            monkeypatch.delenv(key, raising=False)


# パス解決（フックスクリプトのディレクトリ）
#
# このファイルは .githooks/tests/conftest.py に置かれる。
# parents[0]=tests, [1]=.githooks, [2]=リポルート。
# script_dir は pre-commit stage の hook の置き場で、script_dir.parents[1] がリポルートになる。
# 他の stage の hook は githooks_dir から `githooks_dir / "commit-msg" / ...` のように引く。


@pytest.fixture(scope="session")
def githooks_dir() -> Path:
    """.githooks/（stage ごとのディレクトリ・lib・tests の親）。"""
    return Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def script_dir(githooks_dir: Path) -> Path:
    """.githooks/pre-commit/（pre-commit stage のフックスクリプトの親）。"""
    return githooks_dir / "pre-commit"


# テスト用 git リポジトリ生成


@pytest.fixture
def git_repo(tmp_path: Path) -> Callable[..., Path]:
    """初期化済み（init/config 済み・コミットは未実施）の git リポを作る factory。

    各 .bats の setup が行っていた `git init -q [-b main]` を実施する。
    加えて user.email/user.name/commit.gpgsign の設定までを実施する。
    初期コミットの有無やブランチ構成はテスト側で組み立てる。
    _isolate_git_env autouse により素の git 呼び出しで隔離される。
    """

    def _make(name: str = "repo", *, initial_branch: str | None = None) -> Path:
        repo_dir = tmp_path / name
        repo_dir.mkdir(parents=True, exist_ok=True)
        init_cmd = ["git", "init", "-q"]
        if initial_branch is not None:
            init_cmd += ["-b", initial_branch]
        subprocess.run(init_cmd, cwd=repo_dir, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=repo_dir,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "test"],
            cwd=repo_dir,
            check=True,
        )
        subprocess.run(
            ["git", "config", "commit.gpgsign", "false"],
            cwd=repo_dir,
            check=True,
        )
        return repo_dir

    return _make


# git ヘルパ
#
# importlib import-mode 下では conftest を直接 import できない。
# そのため fixture として公開し、各テストへ callable を注入する。


@pytest.fixture
def git() -> Callable[..., subprocess.CompletedProcess]:
    """`git <args...>` を repo_dir で実行して CompletedProcess を返す callable。"""

    def _git(repo_dir: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", "-c", "commit.gpgsign=false", *args],
            cwd=repo_dir,
            check=True,
            capture_output=True,
            text=True,
        )

    return _git


@pytest.fixture
def nx_stub_graph_branch() -> Callable[[dict, dict], str]:
    """記録型 nx スタブの `graph` 分岐（bash）を組む callable。

    lib/nx-lanes.sh（レーン名の収集）が呼ぶ `nx graph --file=<path>` を模す。
    呼び出しは $STUB_NX_LOG.graph に分け、affected / run-many の記録に混ぜない。
    STUB_NX_GRAPH_FAIL で失敗する。
    STUB_NX_GRAPH_NO_LANES で no_lanes_graph を書く。それ以外は lanes_graph を書く。
    各テストファイルは自分の graph JSON だけを渡し、スタブ本体の先頭に差し込む。
    """

    def _branch(lanes_graph: dict, no_lanes_graph: dict) -> str:
        lanes = json.dumps(lanes_graph, separators=(",", ":"))
        no_lanes = json.dumps(no_lanes_graph, separators=(",", ":"))
        return (
            r"""if [ "${1:-}" = "graph" ]; then
    printf '%s\n' "$*" >> "$STUB_NX_LOG.graph"
    if [ -n "${STUB_NX_GRAPH_FAIL:-}" ]; then
        echo "simulated nx graph failure" >&2
        exit 1
    fi
    for arg in "$@"; do
        case "$arg" in --file=*) graph_file="${arg#--file=}" ;; esac
    done
    if [ -n "${STUB_NX_GRAPH_NO_LANES:-}" ]; then
        cat > "$graph_file" <<'NO_LANES'
"""
            + no_lanes
            + r"""
NO_LANES
    else
        cat > "$graph_file" <<'GRAPH'
"""
            + lanes
            + r"""
GRAPH
    fi
    exit 0
fi
"""
        )

    return _branch


@pytest.fixture
def git_rev_parse() -> Callable[..., str]:
    """`git rev-parse <ref>` の結果（SHA）を返す callable。"""

    def _rev_parse(repo_dir: Path, ref: str = "HEAD") -> str:
        return subprocess.run(
            ["git", "rev-parse", ref],
            cwd=repo_dir,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    return _rev_parse


# モックコマンド配置（PATH 先頭の mock-bin）
#


class _MockBin:
    """PATH 先頭に挿入した mock-bin ディレクトリへ実行可能スクリプトを配置する。"""

    def __init__(self, bin_dir: Path) -> None:
        self.bin_dir = bin_dir

    def install(self, name: str, script_body: str) -> Path:
        target = self.bin_dir / name
        body = script_body if script_body.startswith("#!") else f"#!/bin/bash\n{script_body}"
        target.write_text(body)
        target.chmod(0o755)
        return target


@pytest.fixture
def mock_bin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> _MockBin:
    """tmp/mock-bin を PATH 先頭に挿入し install() でモックコマンドを置く。"""
    bin_dir = tmp_path / "mock-bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    return _MockBin(bin_dir)


# スクリプト実行ヘルパ


@pytest.fixture
def run_script() -> Callable[..., subprocess.CompletedProcess]:
    """`bash <script> [args...]` を実行する薄いラッパを返す。

    env 契約: env=None なら subprocess に env= を渡さない。
    _isolate_git_env と monkeypatch 済みの os.environ を、そのまま継承する。
    env が dict のときは {**os.environ, **env} でマージして渡す。
    GIT_* 再注入や PATH 喪失を防ぐ。
    """

    def _run(
        script: str | Path,
        *args: str,
        stdin: str | None = None,
        cwd: str | Path | None = None,
        env: dict | None = None,
    ) -> subprocess.CompletedProcess:
        kwargs: dict = {}
        if env is not None:
            kwargs["env"] = {**os.environ, **env}
        return subprocess.run(
            ["bash", str(script), *args],
            input=stdin,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=25,
            **kwargs,
        )

    return _run
