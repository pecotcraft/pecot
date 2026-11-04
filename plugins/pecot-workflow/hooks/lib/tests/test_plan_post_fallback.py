"""plan-post-fallback.sh（Stop）のユニットテスト（#1229 T055）。

コンテキストクリア後のフォールバック投稿ロジックを直接叩く。
ExitPlanMode でクリアを選ぶと PostToolUse が動かない。
そのため、新セッションの最初の Stop で投稿する。
投稿する計画は、旧セッションの PreToolUse(ExitPlanMode) が `.plan-post-pending` の 2 行目に残したパスから読む。
クリアが計画の承認から来たかは、新セッションの transcript の先頭付近にあるユーザーメッセージで判定する。
メッセージは「Implement the following plan:」で、content は文字列と配列のどちらでもよい。
先頭に無ければ（単なる /clear・却下後の /clear・無関係なセッション）、投稿せずフラグを消す。

poster は `"${CLAUDE_PLUGIN_ROOT}/bin/pecot"` をフルパス実行する。
そのため、PATH 挿入型 mock_bin は働かない。
成功/失敗パスは、CLAUDE_PLUGIN_ROOT 配下に実体モックスクリプトを置き、呼び出しの有無を marker ファイルで判定する。

フラグの形式は、1 行目 `<session_id>:<owner/repo/number>`、2 行目 計画ファイルの絶対パス。

`.pecot-quick-mode` の削除/残存は分岐ごとに非対称なので、下の一覧に整理してからアサートする。
各分岐で、.plan-post-pending の結果、.processing ロック、.pecot-quick-mode の順に書く。

- 分岐 1: フラグ不在（no-op）。不在のまま、生成されない、触らない（残存）。
- 分岐 2: 回収正常系（投稿成功）。削除（消費）、削除、削除。
- 分岐 3: 同一 session_id。mv で復帰、復帰で消滅、残存。
- 分岐 4: フラグ内容不正（ISSUE_REF 欠落）。削除、削除、削除。
- 分岐 5: 承認のクリアではない（先頭に無い・transcript 無し）。削除、削除、削除。
- 分岐 5b: 計画ファイルが無い・空・パスを解決できない。削除、削除、削除。
- 分岐 6: 投稿失敗（exit 3 以外の非 0）。mv で復帰、復帰で消滅、削除。
- 分岐 8: 検証失敗（exit 3）。削除、削除、削除。

いずれの分岐でも、投稿（bin/pecot 実行）は marker の有無で判定する。
投稿は一時ファイル（.pecot/tmp/plan-post/<slug>.md）経由で、内容は <marker>.body の写しで検証する。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

# フォールバックは stdin の JSON を読まず PECOT_HOOK_*（hook-input.sh が export）を読む。
_SOURCE_HOOK_INPUT = (
    'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"'
)

_IMPLEMENT = "Implement the following plan:\n\n# Fallback Plan\n"


@pytest.fixture
def hook_script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "stop"
        / "plan-post-fallback.sh"
    )


@pytest.fixture
def ctx(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pecot_bin_mock) -> dict:
    project = tmp_path / "project"
    plugin = tmp_path / "plugin"
    state_dir = project / ".pecot" / "state"
    state_dir.mkdir(parents=True)
    (project / ".pecot" / "tmp" / "debug").mkdir(parents=True)

    home = tmp_path / "home"
    plan_dir = home / ".claude" / "plans"
    plan_dir.mkdir(parents=True)

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))
    monkeypatch.setenv("HOME", str(home))

    # bin/pecot 実体モックを配置（フルパス実行される）。
    pecot_bin_mock.install(plugin)

    transcript = tmp_path / "transcripts" / "session.jsonl"
    transcript.parent.mkdir()

    return {
        "project": project,
        "state_dir": state_dir,
        "pending": state_dir / ".plan-post-pending",
        "processing": state_dir / ".plan-post-pending.processing",
        "quick_mode": state_dir / ".pecot-quick-mode",
        "plan_dir": plan_dir,
        "plan_file": plan_dir / "fb-slug.md",
        "transcript": transcript,
        "marker": pecot_bin_mock.marker,
        "body": pecot_bin_mock.body,
        "post_file": project / ".pecot" / "tmp" / "plan-post" / "fb-slug.md",
        "monkeypatch": monkeypatch,
    }


def _run(hook_script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", _SOURCE_HOOK_INPUT, "_", str(hook_script), stdin],
        capture_output=True,
        text=True,
        timeout=25,
    )


def _stop_input(ctx, session_id: str = "new-session") -> str:
    """新セッションの Stop の入力。"""
    return json.dumps(
        {
            "hook_event_name": "Stop",
            "session_id": session_id,
            "transcript_path": str(ctx["transcript"]),
        }
    )


def _write_transcript(ctx, first_user: object | None = _IMPLEMENT, slug: str | None = None) -> None:
    """新セッションの transcript。先頭付近のユーザーメッセージ（文字列 or 配列）を書く。"""
    lines = [{"type": "file-history-snapshot", "snapshot": {}}]
    if first_user is not None:
        record = {"type": "user", "message": {"role": "user", "content": first_user}}
        if slug:
            record["slug"] = slug
        lines.append(record)
    lines.append({"type": "assistant", "message": {"role": "assistant", "content": "ok"}})
    ctx["transcript"].write_text("".join(json.dumps(line) + "\n" for line in lines))


def _write_flag(ctx, issue: str = "old-session:org/repo/200", plan: Path | None = None) -> None:
    lines = [issue]
    if plan is not None:
        lines.append(str(plan))
    ctx["pending"].write_text("\n".join(lines) + "\n")


def _posted(ctx) -> bool:
    return ctx["marker"].is_file()


def _assert_flag_dropped(ctx) -> None:
    assert not _posted(ctx)
    assert not ctx["pending"].exists()
    assert not ctx["processing"].exists()
    assert not ctx["quick_mode"].exists()


# 分岐 1: フラグ不在 → no-op。


def test_no_flag_is_noop(ctx, hook_script):
    ctx["quick_mode"].touch()  # 残存確認のため事前生成
    result = _run(hook_script, _stop_input(ctx, "s"))
    assert result.returncode == 0
    assert result.stdout == ""
    assert not _posted(ctx)
    assert not ctx["processing"].is_file()
    # フラグ不在分岐は quick-mode を触らない（残存）。
    assert ctx["quick_mode"].is_file()


# 分岐 2: 回収正常系（異セッション + 先頭に Implement the following plan: + 投稿成功）。


def test_recovery_success_posts_from_flag_plan_path_and_clears(ctx, hook_script):
    _write_flag(ctx, plan=ctx["plan_file"])
    _write_transcript(ctx)
    ctx["quick_mode"].touch()
    ctx["plan_file"].write_text("# Fallback Plan\n")

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    assert _posted(ctx)
    # 一時ファイル経由で投稿し、frontmatter の template: plan で検証を通す。前置き見出しは付けない。
    assert ctx["marker"].read_text() == f"issue comment {ctx['post_file']}\n"
    assert ctx["body"].read_text() == (
        '---\nissue_ref: "org/repo/200"\ntemplate: plan\n---\n\n# Fallback Plan\n'
    )
    assert not ctx["post_file"].exists()
    # 投稿成功: フラグ消費・ロック削除・quick-mode 削除。
    assert not ctx["pending"].is_file()
    assert not ctx["processing"].is_file()
    assert not ctx["quick_mode"].is_file()


def test_continuation_is_detected_when_content_is_array(ctx, hook_script):
    _write_flag(ctx, plan=ctx["plan_file"])
    _write_transcript(ctx, [{"type": "text", "text": _IMPLEMENT}])
    ctx["plan_file"].write_text("# Fallback Plan\n")

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    assert _posted(ctx)
    assert not ctx["pending"].exists()


def test_plan_path_is_resolved_from_transcript_slug_when_flag_has_none(ctx, hook_script):
    _write_flag(ctx)  # 2 行目（計画ファイルのパス）が無い
    _write_transcript(ctx, slug="fb-slug")
    ctx["plan_file"].write_text("# Fallback Plan\n")

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    assert _posted(ctx)
    assert not ctx["pending"].exists()


# 分岐 3: 同一 session_id → mv で復帰・quick-mode 残存。


def test_same_session_restores_flag_and_keeps_quick_mode(ctx, hook_script):
    _write_flag(ctx, issue="same-session:org/repo/300", plan=ctx["plan_file"])
    _write_transcript(ctx)
    ctx["plan_file"].write_text("# Plan\n")
    ctx["quick_mode"].touch()

    result = _run(hook_script, _stop_input(ctx, "same-session"))
    assert result.returncode == 0
    assert not _posted(ctx)
    # フラグは復帰（計画パスの行も保たれる）、ロックは消滅。
    assert ctx["pending"].read_text() == f"same-session:org/repo/300\n{ctx['plan_file']}\n"
    assert not ctx["processing"].is_file()
    # 同一セッション分岐のみ quick-mode 残存。
    assert ctx["quick_mode"].is_file()


# 分岐 4: フラグ内容不正（ISSUE_REF 欠落）→ ロック削除 + quick-mode 削除・投稿なし


def test_invalid_flag_missing_issue_ref_clears(ctx, hook_script):
    # "session:" は cut -d: -f2- が空になり ISSUE_REF 欠落。
    ctx["pending"].write_text("some-session:\n")
    ctx["quick_mode"].touch()

    result = _run(hook_script, _stop_input(ctx, "other-session"))
    assert result.returncode == 0
    _assert_flag_dropped(ctx)


# 分岐 5: 承認のクリアではない → 投稿せずフラグを消す。


def test_plain_clear_without_continuation_message_drops_flag(ctx, hook_script):
    """却下してから /clear した新セッション（先頭に Implement the following plan: が無い）。"""
    _write_flag(ctx, plan=ctx["plan_file"])
    ctx["plan_file"].write_text("# Rejected Plan\n")
    _write_transcript(ctx, "ok とだけ返して")
    ctx["quick_mode"].touch()

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    assert result.stdout == ""
    _assert_flag_dropped(ctx)


def test_continuation_message_after_first_lines_is_not_counted(ctx, hook_script):
    _write_flag(ctx, plan=ctx["plan_file"])
    ctx["plan_file"].write_text("# Plan\n")
    lines = [{"type": "user", "message": {"role": "user", "content": "hello"}}] * 12
    lines.append({"type": "user", "message": {"role": "user", "content": _IMPLEMENT}})
    ctx["transcript"].write_text("".join(json.dumps(line) + "\n" for line in lines))

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    _assert_flag_dropped(ctx)


def test_missing_transcript_drops_flag(ctx, hook_script):
    _write_flag(ctx, plan=ctx["plan_file"])
    ctx["plan_file"].write_text("# Plan\n")
    ctx["quick_mode"].touch()
    assert not ctx["transcript"].exists()

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    _assert_flag_dropped(ctx)


# 分岐 5b: 承認のクリアだが計画を解決できない → 再試行しても通らないのでフラグを消す。


def test_plan_path_unresolvable_drops_flag(ctx, hook_script):
    _write_flag(ctx)  # 2 行目が無く、transcript にも slug が無い
    _write_transcript(ctx)
    ctx["quick_mode"].touch()

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    assert result.stdout == ""
    _assert_flag_dropped(ctx)


def test_plan_file_absent_drops_flag(ctx, hook_script):
    _write_flag(ctx, plan=ctx["plan_dir"] / "gone.md")  # パスはあるがファイルが無い
    _write_transcript(ctx)
    ctx["quick_mode"].touch()

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    _assert_flag_dropped(ctx)


def test_plan_file_empty_drops_flag(ctx, hook_script):
    _write_flag(ctx, plan=ctx["plan_file"])
    ctx["plan_file"].write_text("")
    _write_transcript(ctx)
    ctx["quick_mode"].touch()

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    _assert_flag_dropped(ctx)


# 分岐 6: 投稿失敗（pecot exit 1）→ 出力の文言によらずフラグ復帰・quick-mode 削除。


def test_post_failure_restores_flag_and_removes_quick_mode(ctx, hook_script):
    ctx["monkeypatch"].setenv("PECOT_MOCK_EXIT", "1")
    ctx["monkeypatch"].setenv("PECOT_MOCK_STDERR", "エラー: 不足セクション: 502 Bad Gateway")
    _write_flag(ctx, plan=ctx["plan_file"])
    _write_transcript(ctx)
    ctx["quick_mode"].touch()
    ctx["plan_file"].write_text("# Fallback Plan\n")

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    # 投稿は試みられた（失敗）。
    assert _posted(ctx)
    # 投稿失敗の期待値は次のとおり。
    # フラグ復帰（計画パスも保たれる）・ロック消滅・quick-mode 削除・案内なし。
    assert result.stdout == ""
    assert not ctx["post_file"].exists()
    assert ctx["pending"].read_text() == f"old-session:org/repo/200\n{ctx['plan_file']}\n"
    assert not ctx["processing"].is_file()
    assert not ctx["quick_mode"].is_file()


# 分岐 8: 検証失敗 → フラグを戻さず手動投稿を案内・quick-mode 削除。


def test_validation_failure_clears_flag_and_guides_manual_post(ctx, hook_script):
    ctx["monkeypatch"].setenv("PECOT_MOCK_EXIT", "3")
    ctx["monkeypatch"].setenv("PECOT_MOCK_STDERR", "検証エラーの本文")
    _write_flag(ctx, plan=ctx["plan_file"])
    _write_transcript(ctx)
    ctx["quick_mode"].touch()
    ctx["plan_file"].write_text("# Fallback Plan\n")

    result = _run(hook_script, _stop_input(ctx))
    assert result.returncode == 0
    assert _posted(ctx)
    # 再試行しても通らないためフラグは戻さない。
    assert not ctx["pending"].exists()
    assert not ctx["processing"].exists()
    assert not ctx["quick_mode"].exists()
    assert not ctx["post_file"].exists()
    # Stop は hookSpecificOutput.additionalContext を持たないので systemMessage で案内する。
    output = json.loads(result.stdout)
    assert "hookSpecificOutput" not in output
    message = output["systemMessage"]
    assert message.startswith(
        "【plan-post-fallback】計画が Issue コメントの規約を満たさないため、Issue #200 に投稿しませんでした:\n"
        "検証エラーの本文\n"
    )
    assert "issue comment --prepare -t plan -i org/repo/200" in message


# エントリ stop-plan-post.sh（Stop）を通した投稿。


def _run_entry(project_root: Path, stdin: str) -> subprocess.CompletedProcess:
    entry = project_root / "plugins" / "pecot-workflow" / "hooks" / "stop-plan-post.sh"
    return subprocess.run(
        ["bash", str(entry)], input=stdin, capture_output=True, text=True, timeout=25
    )


def test_entry_stop_plan_post_posts_on_continuation_session(ctx, project_root):
    _write_flag(ctx, plan=ctx["plan_file"])
    _write_transcript(ctx)
    ctx["plan_file"].write_text("# Fallback Plan\n")

    result = _run_entry(project_root, _stop_input(ctx))
    assert result.returncode == 0
    assert _posted(ctx)
    assert not ctx["pending"].is_file()
    assert not ctx["processing"].is_file()


def test_entry_stop_plan_post_drops_flag_on_plain_session(ctx, project_root):
    _write_flag(ctx, plan=ctx["plan_file"])
    _write_transcript(ctx, "ただの新しいセッション")
    ctx["plan_file"].write_text("# Fallback Plan\n")

    result = _run_entry(project_root, _stop_input(ctx))
    assert result.returncode == 0
    assert not _posted(ctx)
    assert not ctx["pending"].exists()


def test_entry_stop_plan_post_validation_failure_is_system_message(ctx, project_root):
    ctx["monkeypatch"].setenv("PECOT_MOCK_EXIT", "3")
    ctx["monkeypatch"].setenv("PECOT_MOCK_STDERR", "検証エラーの本文")
    _write_flag(ctx, plan=ctx["plan_file"])
    _write_transcript(ctx)
    ctx["plan_file"].write_text("# Fallback Plan\n")

    result = _run_entry(project_root, _stop_input(ctx))
    assert result.returncode == 0
    output = json.loads(result.stdout)
    # merge を通しても Stop の出力に additionalContext は載らない。
    assert "additionalContext" not in json.dumps(output)
    assert "検証エラーの本文" in output["systemMessage"]


# PreToolUse(ExitPlanMode) で計画ファイルのパスをフラグに記録する（plan-path-recorder.sh）。


@pytest.fixture
def recorder(project_root: Path, ctx) -> Path:
    # recorder 単体のテストは first-block を通る状態（.exit-plan-confirmed あり）から始める。
    (ctx["state_dir"] / ".exit-plan-confirmed").touch()
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "pre-tool-use"
        / "plan-path-recorder.sh"
    )


def _exit_plan_input(**tool_input) -> str:
    return json.dumps(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "ExitPlanMode",
            "session_id": "old-session",
            "tool_input": tool_input,
        }
    )


def test_recorder_appends_plan_file_path_from_tool_input(ctx, recorder):
    ctx["pending"].write_text("old-session:org/repo/200\n")
    result = _run(recorder, _exit_plan_input(plan="# p", planFilePath=str(ctx["plan_file"])))
    assert result.returncode == 0
    assert ctx["pending"].read_text() == f"old-session:org/repo/200\n{ctx['plan_file']}\n"


def test_recorder_overwrites_previous_plan_path(ctx, recorder):
    ctx["pending"].write_text("old-session:org/repo/200\n/old/plan.md\n")
    _run(recorder, _exit_plan_input(planFilePath=str(ctx["plan_file"])))
    assert ctx["pending"].read_text() == f"old-session:org/repo/200\n{ctx['plan_file']}\n"


def test_recorder_falls_back_to_transcript_slug(ctx, recorder):
    ctx["pending"].write_text("old-session:org/repo/200\n")
    ctx["transcript"].write_text('{"slug":"fb-slug","type":"progress"}\n')
    payload = json.dumps(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "ExitPlanMode",
            "transcript_path": str(ctx["transcript"]),
            "tool_input": {"plan": "# p"},
        }
    )
    result = _run(recorder, payload)
    assert result.returncode == 0
    assert ctx["pending"].read_text() == f"old-session:org/repo/200\n{ctx['plan_file']}\n"


def test_recorder_without_flag_is_noop(ctx, recorder):
    result = _run(recorder, _exit_plan_input(planFilePath=str(ctx["plan_file"])))
    assert result.returncode == 0
    assert not ctx["pending"].exists()


def test_recorder_without_any_path_keeps_flag_unchanged(ctx, recorder):
    ctx["pending"].write_text("old-session:org/repo/200\n")
    result = _run(recorder, _exit_plan_input(plan="# p"))
    assert result.returncode == 0
    assert ctx["pending"].read_text() == "old-session:org/repo/200\n"


def test_exit_plan_mode_entry_does_not_record_path_when_first_call_is_blocked(ctx, project_root):
    """初回の ExitPlanMode は first-block が deny する。承認ダイアログに届かない計画なので記録しない。"""
    entry = project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use-exit-plan-mode.sh"
    # リマインドのテンプレートは実プラグインのものを読ませる。
    ctx["monkeypatch"].setenv(
        "CLAUDE_PLUGIN_ROOT", str(project_root / "plugins" / "pecot-workflow")
    )
    ctx["pending"].write_text("old-session:org/repo/200\n")
    result = subprocess.run(
        ["bash", str(entry)],
        input=_exit_plan_input(plan="# p", planFilePath=str(ctx["plan_file"])),
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert result.returncode == 0
    hso = json.loads(result.stdout)["hookSpecificOutput"]
    assert hso["permissionDecision"] == "deny"
    assert "計画確認リマインド" in hso["permissionDecisionReason"]
    assert ctx["pending"].read_text() == "old-session:org/repo/200\n"


def test_exit_plan_mode_entry_records_path_when_second_call_passes(ctx, project_root):
    """first-block を通った 2 回目（.exit-plan-confirmed あり）の呼び出しでは記録する。"""
    entry = project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use-exit-plan-mode.sh"
    ctx["monkeypatch"].setenv(
        "CLAUDE_PLUGIN_ROOT", str(project_root / "plugins" / "pecot-workflow")
    )
    ctx["pending"].write_text("old-session:org/repo/200\n")
    (ctx["state_dir"] / ".exit-plan-confirmed").touch()
    result = subprocess.run(
        ["bash", str(entry)],
        input=_exit_plan_input(plan="# p", planFilePath=str(ctx["plan_file"])),
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert result.returncode == 0
    assert "permissionDecision" not in result.stdout
    assert ctx["pending"].read_text() == f"old-session:org/repo/200\n{ctx['plan_file']}\n"


def test_exit_plan_mode_entry_records_path_in_quick_mode(ctx, project_root):
    entry = project_root / "plugins" / "pecot-workflow" / "hooks" / "pre-tool-use-exit-plan-mode.sh"
    ctx["monkeypatch"].setenv(
        "CLAUDE_PLUGIN_ROOT", str(project_root / "plugins" / "pecot-workflow")
    )
    ctx["pending"].write_text("old-session:org/repo/200\n")
    ctx["quick_mode"].touch()
    result = subprocess.run(
        ["bash", str(entry)],
        input=_exit_plan_input(plan="# p", planFilePath=str(ctx["plan_file"])),
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert result.returncode == 0
    assert ctx["pending"].read_text() == f"old-session:org/repo/200\n{ctx['plan_file']}\n"
