"""フラグライフサイクル不変条件の通しテスト（008-plan-mode-minimization / data-model.md Entity 2）。

data-model.md Entity 2 の不変条件のうち、本フローの再配置で崩れやすい 2 点を
end-to-end で固定する。

- 不変条件 1: フェーズ 2〜4（通常モード区間・非 plan ツール）では、plan 系フラグが生成されない。
  対象のフラグは `.plan-post-pending` / `.exit-plan-confirmed`。
- 不変条件 5: 手動 plan mode 突入時（FR-008）は、plan-mode-coordinator が `.plan-post-pending` を立てる。
  plan-issue-poster の投稿成功ルートで、同じ内容のフラグが消費される。

hook 本体は無変更のまま green にする。
poster / fallback は `"${CLAUDE_PLUGIN_ROOT}/bin/pecot"` をフルパス実行するため、PATH 挿入型の mock_bin fixture は働かない。
成功パスは、CLAUDE_PLUGIN_ROOT 配下に実体モックスクリプトを置く。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def hooks(project_root: Path) -> dict:
    lib = project_root / "plugins" / "pecot-workflow" / "hooks" / "lib"
    return {
        "flag_setter": lib / "pre-tool-use" / "plan-flag-setter.sh",
        "fallback": lib / "stop" / "plan-post-fallback.sh",
        "poster": lib / "post-tool-use" / "plan-issue-poster.sh",
        "coordinator": lib / "user-prompt-submit" / "plan-mode-coordinator.sh",
    }


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pecot_bin_mock) -> dict:
    """CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT / HOME / transcript を用意する。"""
    project = tmp_path / "project"
    plugin = tmp_path / "plugin"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    (project / ".pecot" / "tmp" / "debug").mkdir(parents=True)
    plugin.mkdir(parents=True)

    home = tmp_path / "home"
    plan_dir = home / ".claude" / "plans"
    plan_dir.mkdir(parents=True)

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))
    monkeypatch.setenv("HOME", str(home))

    transcript = tmp_path / "transcripts" / "session.jsonl"
    transcript.parent.mkdir()

    return {
        "project": project,
        "plugin": plugin,
        "state_dir": state_dir,
        "pecot_active": state_dir / ".pecot-active",
        "pending": state_dir / ".plan-post-pending",
        "exit_confirmed": state_dir / ".exit-plan-confirmed",
        "plan_dir": plan_dir,
        "transcript": transcript,
        "marker": pecot_bin_mock.marker,
        "debug_log": project / ".pecot" / "tmp" / "debug" / "plan-post-flow.log",
    }


def _run(script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(script)],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=25,
    )


# Stop の fallback は stdin の JSON を読まず PECOT_HOOK_*（hook-input.sh が export）を読む。
_SOURCE_HOOK_INPUT = (
    'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"'
)


def _run_loaded(script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", _SOURCE_HOOK_INPUT, "_", str(script), stdin],
        capture_output=True,
        text=True,
        timeout=25,
    )


# 不変条件 1: 通常モード区間（非 plan ツール）で plan 系フラグ非生成。


@pytest.mark.parametrize("tool_name", ["Bash", "Read", "Agent", "Edit", "Grep"])
def test_normal_mode_non_plan_tool_generates_no_plan_flags(env, hooks, tool_name):
    """permission_mode=default / 非 plan ツールの hook 入力を順に流しても、plan 系フラグが一切生成されない。

    流す先は、flag-setter → coordinator → fallback の順。
    """
    env["pecot_active"].write_text("org/repo/123\n")

    # plan-flag-setter: EnterPlanMode 以外の TOOL_NAME では即 exit（フラグ非生成）。
    setter_input = json.dumps(
        {"tool_name": tool_name, "session_id": "sess-1", "permission_mode": "default"}
    )
    r1 = _run(hooks["flag_setter"], setter_input)
    assert r1.returncode == 0

    # plan-mode-coordinator: permission_mode=default ではフラグ非生成。
    coord_input = json.dumps(
        {"permission_mode": "default", "session_id": "sess-1", "tool_name": tool_name}
    )
    r2 = _run(hooks["coordinator"], coord_input)
    assert r2.returncode == 0

    # plan-post-fallback: .plan-post-pending 不在なら no-op。
    fb_input = json.dumps({"session_id": "sess-1", "transcript_path": str(env["transcript"])})
    r3 = _run_loaded(hooks["fallback"], fb_input)
    assert r3.returncode == 0

    # plan 系フラグは一切生成されていない。
    assert not env["pending"].is_file()
    assert not env["exit_confirmed"].is_file()
    # 排他ロックも生成されない。
    assert not (env["state_dir"] / ".plan-post-pending.processing").is_file()


# flag-setter 主手段: EnterPlanMode + .pecot-active → pending 生成・confirmed リセット。


def test_enter_plan_mode_sets_pending_and_resets_confirmed(env, hooks):
    """本番主手段（FR-008 の PreToolUse 手段）。

    EnterPlanMode + .pecot-active ありのとき、plan-flag-setter が `.plan-post-pending` に書き込む。
    書き込む内容は `<session_id>:<issue_ref>`。
    あわせて、直前の `.exit-plan-confirmed` をリセットする。
    """
    env["pecot_active"].write_text("org/repo/789\n")
    # 前セッションの確認済みフラグが残っている状態を再現（リセット対象）。
    env["exit_confirmed"].write_text("2026-07-24 10:00:00\n")

    setter_input = json.dumps({"tool_name": "EnterPlanMode", "session_id": "sess-enter"})
    r = _run(hooks["flag_setter"], setter_input)
    assert r.returncode == 0

    # pending が session:issue_ref 内容で生成される。
    assert env["pending"].is_file()
    assert env["pending"].read_text().strip() == "sess-enter:org/repo/789"
    # EnterPlanMode 突入で確認済みフラグがリセット（削除）される。
    assert not env["exit_confirmed"].is_file()


# 不変条件 5: 手動 plan mode 突入 → coordinator 生成 → poster 成功で消費。


def test_manual_plan_mode_flag_generated_then_consumed_by_poster(env, hooks, pecot_bin_mock):
    """coordinator（permission_mode=plan）の立てた `session:issue_ref` フラグを、poster の投稿成功ルートが消費（削除）する。

    フラグは同一内容のまま消費される end-to-end のテスト。
    """
    env["pecot_active"].write_text("org/repo/456\n")
    pecot_bin_mock.install(env["plugin"])

    # --- coordinator: 手動 plan mode 検出でフラグ生成 ---
    coord_input = json.dumps({"permission_mode": "plan", "session_id": "sess-manual"})
    r_coord = _run(hooks["coordinator"], coord_input)
    assert r_coord.returncode == 0
    assert env["pending"].is_file()
    assert env["pending"].read_text().strip() == "sess-manual:org/repo/456"

    # --- poster: transcript の slug / plan file / .pecot-active で投稿成功 ---
    env["transcript"].write_text('{"slug":"manual-slug","type":"progress"}\n')
    (env["plan_dir"] / "manual-slug.md").write_text("# Manual Plan\n")
    poster_input = json.dumps(
        {"tool_name": "ExitPlanMode", "transcript_path": str(env["transcript"])}
    )
    r_poster = _run(hooks["poster"], poster_input)
    assert r_poster.returncode == 0

    # 投稿が実行された（bin/pecot モックが呼ばれた）。
    assert env["marker"].is_file()
    assert "issue comment" in env["marker"].read_text()
    # 投稿成功でフラグが消費（削除）されている。
    assert not env["pending"].is_file()
    # 成功メッセージが additionalContext に出る。
    assert "計画をIssue #456 に投稿しました" in r_poster.stdout
