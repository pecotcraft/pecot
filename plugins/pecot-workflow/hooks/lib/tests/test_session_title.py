"""session-title.sh（Claude Code のセッション名）のユニットテスト。

セッション名は、.pecot/state/.pecot-active と .pecot-session-title から組む。
session-title-sent に残した `<session_id>:<題名>` と違うときだけ、sessionTitle を出す。
env で渡すのは、hook-input.sh が export する PECOT_HOOK_* で、Claude Code だけが送る transcript_path も含む。
transcript_path の変数名は PECOT_HOOK_TRANSCRIPT_PATH。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def script(project_root: Path) -> Path:
    return (
        project_root / "plugins" / "pecot-workflow" / "hooks" / "lib" / "core" / "session-title.sh"
    )


@pytest.fixture
def state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """`.pecot/state` を持つプロジェクトを CLAUDE_PROJECT_DIR に向ける。"""
    project = tmp_path / "project"
    state = project / ".pecot" / "state"
    state.mkdir(parents=True)
    (project / ".pecot" / ".gitignore").write_text("*\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    return state


def _run(
    run_script,
    script: Path,
    *,
    event: str = "UserPromptSubmit",
    session_id: str = "s1",
    source: str = "",
    current_title: str = "",
) -> subprocess.CompletedProcess:
    env = {
        "PECOT_HOOK_EVENT": event,
        "PECOT_HOOK_SESSION_ID": session_id,
        "PECOT_HOOK_SOURCE": source,
        "PECOT_HOOK_SESSION_TITLE": current_title,
        "PECOT_HOOK_TRANSCRIPT_PATH": "/t/s.jsonl",
    }
    return run_script(script, stdin="{}", env=env)


def _title(result: subprocess.CompletedProcess) -> str:
    return json.loads(result.stdout)["hookSpecificOutput"]["sessionTitle"]


def test_no_output_without_active_flag(run_script, script, state_dir) -> None:
    result = _run(run_script, script)
    assert result.returncode == 0
    assert result.stdout == ""
    assert not (state_dir / "session-title-sent").exists()


def test_emits_session_title_from_state(run_script, script, state_dir) -> None:
    (state_dir / ".pecot-active").write_text("acme-labs/aist-plugin/1253\n")
    (state_dir / ".pecot-session-title").write_text("#1253 題名\n")
    result = _run(run_script, script, event="SessionStart", source="startup")
    data = json.loads(result.stdout)
    assert data == {
        "hookSpecificOutput": {"hookEventName": "SessionStart", "sessionTitle": "#1253 題名"}
    }
    assert (state_dir / "session-title-sent").read_text() == "s1:#1253 題名\n"


def test_number_only_when_title_file_missing(run_script, script, state_dir) -> None:
    """旧版の CLI が書いた .pecot-active だけがあるときは番号だけにする"""
    (state_dir / ".pecot-active").write_text("acme-labs/aist-plugin/1253\n")
    assert _title(_run(run_script, script)) == "#1253"


def test_same_title_is_not_resent_in_same_session(run_script, script, state_dir) -> None:
    (state_dir / ".pecot-active").write_text("owner/repo/1\n")
    (state_dir / ".pecot-session-title").write_text("#1 a\n")
    assert _title(_run(run_script, script)) == "#1 a"
    second = _run(run_script, script)
    assert second.returncode == 0
    assert second.stdout == ""


def test_resends_when_title_changes_or_session_differs(run_script, script, state_dir) -> None:
    (state_dir / ".pecot-active").write_text("owner/repo/1\n")
    (state_dir / ".pecot-session-title").write_text("#1 a\n")
    _run(run_script, script)
    # 別セッション（/clear 後や新規起動）には同じ題名でも出す。
    assert _title(_run(run_script, script, session_id="s2")) == "#1 a"
    # Issue が切り替わったら同じセッションでも出す。
    (state_dir / ".pecot-active").write_text("owner/repo/2\n")
    (state_dir / ".pecot-session-title").write_text("#2 b\n")
    assert _title(_run(run_script, script, session_id="s2")) == "#2 b"


def test_disabled_by_hooks_config(run_script, script, state_dir, hooks_config) -> None:
    hooks_config.write({"session-title": False})
    (state_dir / ".pecot-active").write_text("owner/repo/1\n")
    result = _run(run_script, script)
    assert result.returncode == 0
    assert result.stdout == ""


def test_no_write_in_repo_without_pecot_dir(run_script, script, tmp_path, monkeypatch) -> None:
    """pecot 未使用リポ（.pecot 不在）では何も書かず無出力"""
    project = tmp_path / "plain"
    project.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    result = _run(run_script, script)
    assert result.returncode == 0
    assert result.stdout == ""
    assert not (project / ".pecot").exists()


def _assert_silent_and_unrecorded(result: subprocess.CompletedProcess, state_dir: Path) -> None:
    assert result.returncode == 0
    assert result.stdout == ""
    assert not (state_dir / "session-title-sent").exists()


def _activate(state_dir: Path, active: str = "owner/repo/1", title: str = "#1 a") -> None:
    (state_dir / ".pecot-active").write_text(f"{active}\n")
    (state_dir / ".pecot-session-title").write_text(f"{title}\n")


@pytest.mark.parametrize("source", ["startup", "resume", "fork"])
def test_session_start_applies_for_startup_resume_fork(
    run_script, script, state_dir, source
) -> None:
    _activate(state_dir)
    result = _run(run_script, script, event="SessionStart", source=source)
    assert _title(result) == "#1 a"


@pytest.mark.parametrize("source", ["clear", "compact", "new", ""])
def test_session_start_ignored_for_other_sources(run_script, script, state_dir, source) -> None:
    """sessionTitle が適用されない source では出さず、sent にも残さない（次の機会に出せる）"""
    _activate(state_dir)
    result = _run(run_script, script, event="SessionStart", source=source)
    _assert_silent_and_unrecorded(result, state_dir)


def test_no_output_without_transcript_path(run_script, script, state_dir) -> None:
    """transcript_path が無い（Copilot CLI）ときは出さず、記録もしない"""
    _activate(state_dir)
    result = run_script(
        script,
        stdin="{}",
        env={"PECOT_HOOK_EVENT": "SessionStart", "PECOT_HOOK_SOURCE": "new"},
    )
    _assert_silent_and_unrecorded(result, state_dir)


def test_no_output_when_input_title_matches(run_script, script, state_dir) -> None:
    """既に同じ名前が付いているセッションには出さず、記録もしない"""
    _activate(state_dir)
    result = _run(run_script, script, current_title="#1 a")
    _assert_silent_and_unrecorded(result, state_dir)


def test_empty_session_id_is_recorded_and_not_resent(run_script, script, state_dir) -> None:
    _activate(state_dir)
    assert _title(_run(run_script, script, session_id="")) == "#1 a"
    assert (state_dir / "session-title-sent").read_text() == ":#1 a\n"
    assert _run(run_script, script, session_id="").stdout == ""


def test_does_not_override_rename_after_sent(run_script, script, state_dir) -> None:
    """送った後に利用者が /rename した名前（入力の session_title が違う）は上書きしない"""
    _activate(state_dir)
    _run(run_script, script)
    assert _run(run_script, script, current_title="my own name").stdout == ""


@pytest.mark.parametrize("active", ["owner/repo/abc", "owner/repo/", "owner/repo/12x", "12/../x"])
def test_non_numeric_active_number_is_ignored(run_script, script, state_dir, active) -> None:
    _activate(state_dir, active=active, title="#1 a")
    result = _run(run_script, script)
    _assert_silent_and_unrecorded(result, state_dir)


def test_title_of_another_issue_falls_back_to_number(run_script, script, state_dir) -> None:
    _activate(state_dir, active="owner/repo/5", title="#99 x")
    assert _title(_run(run_script, script)) == "#5"


def test_number_prefix_must_match_whole_number(run_script, script, state_dir) -> None:
    """#12 の題名は #1 の題名として採用しない"""
    _activate(state_dir, active="owner/repo/1", title="#12 x")
    assert _title(_run(run_script, script)) == "#1"


def test_title_equal_to_number_is_adopted(run_script, script, state_dir) -> None:
    _activate(state_dir, active="owner/repo/7", title="#7")
    assert _title(_run(run_script, script)) == "#7"


def test_empty_title_file_falls_back_to_number(run_script, script, state_dir) -> None:
    _activate(state_dir, active="owner/repo/5", title="")
    assert _title(_run(run_script, script)) == "#5"
