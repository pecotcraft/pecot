"""run-affected-lint.sh のユニットテスト（test_run_affected_lint.bats 移植）。

hook は pre-commit framework が pass_filenames で渡す staged 変更ファイル一覧を使う。
レーン名（`lint` と `lint-*` の target 名）は `nx graph --file` の JSON から集める（lib/nx-lanes.sh、#1232）。
push range の解決はしない。
一覧は末尾のコマンドに変換され、repo root で実行される。

test_run_affected_tests と同じ記録型 nx スタブ方式を使う。GIT_* 隔離は conftest の
_isolate_git_env autouse に委譲する。

変換後のコマンド:
  nx affected -t <lint レーン名の列挙> --files=<csv> --parallel=1 --output-style=stream
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

# 記録型 nx スタブ（全引数を 1 行で $STUB_NX_LOG へ追記し STUB_NX_EXIT で終了）。
#
# `graph --file=<path>` の分岐は conftest の nx_stub_graph_branch が組む（レーン名の収集用）。
# 名前が合っても起点（nx:noop）と package.json の scripts 由来（nx:run-script）は集めない。
_NX_STUB_BODY = """#!/bin/bash
@@GRAPH_BRANCH@@printf '%s\\n' "$*" >> "$STUB_NX_LOG"
exit "${STUB_NX_EXIT:-0}"
"""

_NOOP = {"executor": "nx:noop"}
_RUN_SCRIPT = {"executor": "nx:run-script"}
_GRAPH = {
    "graph": {
        "nodes": {
            "lane-one": {
                "data": {
                    "targets": {
                        "lint": {"executor": "nx:run-commands"},
                        "lint-src": {},
                        "lint-entry": _NOOP,
                        "test": _NOOP,
                        "test-unit": {},
                    }
                }
            },
            "lane-two": {
                "data": {
                    "targets": {
                        "lint": _NOOP,
                        "lint-docs": {},
                        "lint-postinstall": _RUN_SCRIPT,
                        "linter": {},
                        "build": {},
                    }
                }
            },
        }
    }
}
_GRAPH_NO_LANES = {
    "graph": {
        "nodes": {
            "lane-one": {
                "data": {
                    "targets": {"build": {}, "lint": _NOOP, "lint-x": _RUN_SCRIPT, "test-unit": {}}
                }
            }
        }
    }
}


@pytest.fixture
def lint_repo(git_repo: Callable[..., Path], git, tmp_path: Path) -> tuple[Path, Path]:
    """init/初期コミット済みの temp repo と nx ログパスを返す（.bats setup 相当）。"""
    repo = git_repo("repo", initial_branch="main")
    (repo / "plugins" / "pecot-workflow" / "cli").mkdir(parents=True)
    (repo / "node_modules" / ".bin").mkdir(parents=True)
    (repo / "README.md").write_text("main\n")
    git(repo, "add", "README.md")
    git(repo, "commit", "-q", "-m", "chore: init")
    nx_log = tmp_path / "nx.log"
    nx_log.write_text("")
    return repo, nx_log


@pytest.fixture
def install_nx_stub(nx_stub_graph_branch: Callable[[dict, dict], str]) -> Callable[[Path], None]:
    """記録型 nx スタブを repo の node_modules/.bin に設置する callable（resolve_nx の第 1 候補）。"""

    def _install(repo: Path) -> None:
        stub = repo / "node_modules" / ".bin" / "nx"
        stub.write_text(
            _NX_STUB_BODY.replace("@@GRAPH_BRANCH@@", nx_stub_graph_branch(_GRAPH, _GRAPH_NO_LANES))
        )
        stub.chmod(0o755)

    return _install


def test_changed_files_run_affected_lint(
    script_dir: Path, lint_repo: tuple[Path, Path], run_script, install_nx_stub
) -> None:
    """1. 変更ファイル引数 → affected -t lint --files=<csv> で実行。"""
    repo, nx_log = lint_repo
    install_nx_stub(repo)

    result = run_script(
        script_dir / "run-affected-lint.sh",
        "plugins/pecot-workflow/cli/a.py",
        "plugins/pecot-visual/cli/src/b.ts",
        cwd=repo,
        env={"STUB_NX_LOG": str(nx_log)},
    )
    assert result.returncode == 0

    log = nx_log.read_text()
    # 起点の `lint`（nx:noop）だけでなく、実体の `lint` と `lint-*` のレーンを名前で列挙する（#1232）。
    # `linter` のように `lint-` で始まらない名前は含めない。
    assert "affected -t lint,lint-docs,lint-src --files=" in log
    assert "--files=plugins/pecot-workflow/cli/a.py,plugins/pecot-visual/cli/src/b.ts" in log
    assert "--parallel=1" in log
    assert "--output-style=stream" in log


def test_no_changed_files_skips_nx(
    script_dir: Path, lint_repo: tuple[Path, Path], run_script, install_nx_stub
) -> None:
    """2. 変更ファイルなし（引数 0 個）→ nx 未起動 / exit 0。"""
    repo, nx_log = lint_repo
    install_nx_stub(repo)

    result = run_script(
        script_dir / "run-affected-lint.sh",
        cwd=repo,
        env={"STUB_NX_LOG": str(nx_log)},
    )
    assert result.returncode == 0
    assert nx_log.read_text() == ""


def test_lint_failure_propagates(
    script_dir: Path, lint_repo: tuple[Path, Path], run_script, install_nx_stub
) -> None:
    """3. lint 失敗（nx exit 1）→ exit 1 で伝播 / commit ブロック。"""
    repo, nx_log = lint_repo
    install_nx_stub(repo)

    result = run_script(
        script_dir / "run-affected-lint.sh",
        "plugins/pecot-workflow/cli/a.py",
        cwd=repo,
        env={"STUB_NX_LOG": str(nx_log), "STUB_NX_EXIT": "1"},
    )
    assert result.returncode == 1
    assert "affected -t lint" in nx_log.read_text()


def test_nx_unresolved_fail_closed(
    script_dir: Path, lint_repo: tuple[Path, Path], run_script
) -> None:
    """4. nx 未解決 → fail-closed（exit 1 / 復旧手順入り ERROR）。"""
    repo, nx_log = lint_repo
    # install_nx_stub を呼ばない: node_modules と PATH のどちらにも nx は無い。

    result = run_script(
        script_dir / "run-affected-lint.sh",
        "plugins/pecot-workflow/cli/a.py",
        cwd=repo,
        env={"STUB_NX_LOG": str(nx_log)},
    )
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "ERROR" in out
    assert "nx" in out


def test_lane_names_come_from_the_graph_each_run(
    script_dir: Path, lint_repo: tuple[Path, Path], run_script, install_nx_stub
) -> None:
    """レーン名は固定せず、実行ごとに `nx graph --file` で 1 回集める。"""
    repo, nx_log = lint_repo
    install_nx_stub(repo)

    result = run_script(
        script_dir / "run-affected-lint.sh",
        "plugins/pecot-workflow/cli/a.py",
        cwd=repo,
        env={"STUB_NX_LOG": str(nx_log)},
    )
    assert result.returncode == 0

    graph_calls = Path(f"{nx_log}.graph").read_text().splitlines()
    assert len(graph_calls) == 1
    assert graph_calls[0].startswith("graph --file=")
    affected = [ln for ln in nx_log.read_text().splitlines() if ln.startswith("affected ")]
    assert len(affected) == 1
    assert affected[0].split()[2] == "lint,lint-docs,lint-src"


def test_no_changed_files_does_not_compute_the_graph(
    script_dir: Path, lint_repo: tuple[Path, Path], run_script, install_nx_stub
) -> None:
    """変更ファイルが無ければ lint 対象なし。graph も計算しない。"""
    repo, nx_log = lint_repo
    install_nx_stub(repo)

    result = run_script(
        script_dir / "run-affected-lint.sh", cwd=repo, env={"STUB_NX_LOG": str(nx_log)}
    )
    assert result.returncode == 0
    assert not Path(f"{nx_log}.graph").exists()


@pytest.mark.parametrize("stub_env", ["STUB_NX_GRAPH_FAIL", "STUB_NX_GRAPH_NO_LANES"])
def test_graph_unavailable_fail_closed(
    script_dir: Path, lint_repo: tuple[Path, Path], run_script, install_nx_stub, stub_env: str
) -> None:
    """graph が取れない・lint のレーンが無いと、空の -t で nx を起動せず ERROR で commit を止める。"""
    repo, nx_log = lint_repo
    install_nx_stub(repo)

    result = run_script(
        script_dir / "run-affected-lint.sh",
        "plugins/pecot-workflow/cli/a.py",
        cwd=repo,
        env={"STUB_NX_LOG": str(nx_log), stub_env: "1"},
    )
    assert result.returncode == 1
    assert "ERROR" in (result.stdout + result.stderr)
    assert "affected" not in nx_log.read_text()
