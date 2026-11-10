"""stop/misplaced-pecot-notice.sh のユニットテスト。

検証する項目は次のとおり。
リポジトリルート以外に生成された .pecot/ ディレクトリの find 走査検知と、systemMessage での案内。
prune 除外（ルート正規 .pecot 配下 / node_modules / .pnpm-store）と、config 無効化。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "stop"
        / "misplaced-pecot-notice.sh"
    )


@pytest.fixture
def project(tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch) -> Path:
    """CLAUDE_PROJECT_DIR を指す tmp project/.pecot を用意し config を有効にする。"""
    project_dir = tmp_path / "project"
    (project_dir / ".pecot").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project_dir))
    hooks_config.write({"misplaced-pecot-notice": True})
    return project_dir


def _run(script: Path, stdin: str = "{}") -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(script)],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_nested_misplaced_pecot_detected(project: Path, script: Path):
    misplaced = project / "plugins" / "pecot-workflow" / ".pecot" / "work" / "999"
    misplaced.mkdir(parents=True)

    result = _run(script)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    sys_msg = payload["systemMessage"]
    assert "misplaced .pecot/" in sys_msg
    assert str(project / "plugins" / "pecot-workflow" / ".pecot") in sys_msg
    assert ".pecot/work/<Issue number>/" in sys_msg


def test_root_pecot_only_no_output(project: Path, script: Path):
    # project/.pecot は fixture で作成済み。ネスト .pecot は無し。
    result = _run(script)
    assert result.returncode == 0
    assert result.stdout == ""


def test_node_modules_pecot_not_detected(project: Path, script: Path):
    (project / "node_modules" / "pkg" / ".pecot").mkdir(parents=True)
    result = _run(script)
    assert result.returncode == 0
    assert result.stdout == ""


def test_pnpm_store_pecot_not_detected(project: Path, script: Path):
    (project / ".pnpm-store" / "v3" / ".pecot").mkdir(parents=True)
    result = _run(script)
    assert result.returncode == 0
    assert result.stdout == ""


def test_nested_pecot_under_root_pecot_not_detected(project: Path, script: Path):
    # ルート正規 .pecot/ 配下の work 内 fixture 残骸想定。prune で走査対象外。
    (project / ".pecot" / "work" / "730" / "fixture" / ".pecot").mkdir(parents=True)
    result = _run(script)
    assert result.returncode == 0
    assert result.stdout == ""


def test_disabled_via_config_no_output(project: Path, script: Path, hooks_config):
    hooks_config.write({"misplaced-pecot-notice": False})
    (project / "plugins" / "pecot-workflow" / ".pecot" / "work" / "999").mkdir(parents=True)
    result = _run(script)
    assert result.returncode == 0
    assert result.stdout == ""


def test_multiple_misplaced_all_listed(project: Path, script: Path):
    """複数箇所の誤配置 .pecot が全件 systemMessage に列挙される（F-07）。"""
    first = project / "plugins" / "pecot-workflow" / ".pecot"
    second = project / "tools" / "cli" / ".pecot"
    first.mkdir(parents=True)
    second.mkdir(parents=True)

    result = _run(script)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    sys_msg = payload["systemMessage"]
    assert str(first) in sys_msg
    assert str(second) in sys_msg


def test_nested_misplaced_reports_top_only(project: Path, script: Path):
    """誤配置 .pecot 配下にさらに .pecot がある場合トップ 1 件のみ報告（F-03 回帰）。"""
    top = project / "plugins" / "pecot-workflow" / ".pecot"
    nested = top / "work" / "999" / ".pecot"
    nested.mkdir(parents=True)

    result = _run(script)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    sys_msg = payload["systemMessage"]
    assert str(top) in sys_msg
    # 入れ子の .pecot は prune されトップに集約される（行として現れない）。
    assert str(nested) not in sys_msg


def test_project_dir_resolved_via_git_root(
    project_root: Path, git_repo, hooks_config, monkeypatch: pytest.MonkeyPatch
):
    """stop.sh エントリ経由で hook 入力の cwd の git ルートを基準に検知する（F-04 回帰）。

    cwd を git リポのサブディレクトリにしてもルート基準で prune・検知される。
    基準の解決はエントリポイントの project-root.sh が担う。
    """
    stop_sh = project_root / "plugins" / "pecot-workflow" / "hooks" / "stop.sh"
    repo = git_repo()
    (repo / ".pecot").mkdir()
    misplaced = repo / "plugins" / "pecot-workflow" / ".pecot"
    misplaced.mkdir(parents=True)
    subdir = repo / "plugins" / "pecot-workflow"

    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    hooks_config.write({"misplaced-pecot-notice": True})
    result = subprocess.run(
        ["bash", str(stop_sh)],
        input=json.dumps({"cwd": str(subdir)}),
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert str(misplaced.resolve()) in payload["systemMessage"]


def test_outside_git_repo_no_output(
    script: Path, tmp_path: Path, hooks_config, monkeypatch: pytest.MonkeyPatch
):
    """git リポ外（CLAUDE_PROJECT_DIR 未設定）では安全側に検知せず終了（F-04）。"""
    non_repo = tmp_path / "loose"
    (non_repo / "sub" / ".pecot").mkdir(parents=True)

    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    hooks_config.write({"misplaced-pecot-notice": True})
    result = subprocess.run(
        ["bash", str(script)],
        input="{}",
        capture_output=True,
        text=True,
        timeout=25,
        cwd=str(non_repo),
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_stop_entry_merges_auto_push_and_misplaced(
    project_root: Path,
    project: Path,
    hooks_config,
):
    """stop.sh エントリ経由で auto-push とmisplaced .pecot/の両 systemMessage が連結される。"""
    stop_sh = project_root / "plugins" / "pecot-workflow" / "hooks" / "stop.sh"

    # auto-push フラグを用意（auto-push.sh が読み取り systemMessage 化する）。
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    (state_dir / ".auto-push-urls").write_text("pushed: https://example/pr/1")

    # 誤配置 .pecot を用意（misplaced-pecot-notice.sh が検知する）。
    (project / "plugins" / "pecot-workflow" / ".pecot").mkdir(parents=True)

    result = subprocess.run(
        ["bash", str(stop_sh)],
        input="{}",
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    sys_msg = payload["systemMessage"]
    assert "pushed: https://example/pr/1" in sys_msg
    assert "misplaced .pecot/" in sys_msg
    # systemMessage のみのため hookSpecificOutput は出ない（F-06）。
    assert "hookSpecificOutput" not in payload
