"""post-tool-use-exit-plan-mode.sh のユニットテスト（test_post_exit_plan_mode.bats 移植）。

plan-issue-poster の slug 抽出 / Issue 参照解決 / 投稿 / 結果分岐 / 実装リマインダー連結を検証する。
投稿は、`pecot_bin_mock` で ${CLAUDE_PLUGIN_ROOT}/bin/pecot を差し替えて検証する。
検証するのは、exit code ごとの分岐と、一時ファイル経由の投稿内容（<marker>.body の写し）。
exit code は、PECOT_MOCK_EXIT で指定する（0=成功 / 3=検証失敗 / 1=通信失敗等）。
bin/pecot を置かないテストは、投稿失敗の手段を通る。
プランファイルは $HOME/.claude/plans へ置く。
そのため、HOME を tmp_path 由来の値に monkeypatch して、実ホームを汚染しない。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def hook_script(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "post-tool-use-exit-plan-mode.sh"


@pytest.fixture
def ctx(
    project_root: Path,
    tmp_path: Path,
    hooks_config,
    monkeypatch: pytest.MonkeyPatch,
    pecot_bin_mock,
):
    """CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT / HOME / transcript を構築する。"""
    project = tmp_path / "project"
    plugin = tmp_path / "plugin"
    state_dir = project / ".pecot" / "state"
    archive_dir = plugin / "hooks" / "templates"
    state_dir.mkdir(parents=True)
    archive_dir.mkdir(parents=True)
    (project / ".pecot" / "tmp" / "debug").mkdir(parents=True)

    # plan-issue-poster が末尾に連結するリマインダーテンプレを配置する。
    templates = project_root / "plugins" / "pecot-workflow" / "hooks" / "templates"
    shutil.copy(templates / "exit-plan-implementer-remind.md", archive_dir)

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(plugin))
    hooks_config.write({})

    # プランファイルは $HOME/.claude/plans に置く。実ホームを汚さないため HOME を tmp へ。
    home = tmp_path / "home"
    plan_dir = home / ".claude" / "plans"
    plan_dir.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))

    transcript_dir = tmp_path / "transcripts"
    transcript_dir.mkdir()
    transcript_file = transcript_dir / "test-session.jsonl"

    # 投稿呼び出しの marker（pecot_bin_mock が PECOT_MOCK_MARKER を設定済み）。デフォルトでは
    # bin/pecot を置かないため、既存の失敗パス前提（CLAUDE_PLUGIN_ROOT/bin/pecot 不在 →
    # 投稿失敗）は不変。install_pecot_mock() を明示的に呼んだテストだけ成功パスになる。
    return {
        "state_dir": state_dir,
        "pecot_active": state_dir / ".pecot-active",
        "config": hooks_config,
        "project": project,
        "plan_dir": plan_dir,
        "transcript_file": transcript_file,
        "debug_log": project / ".pecot" / "tmp" / "debug" / "plan-post-flow.log",
        "marker": pecot_bin_mock.marker,
        "body": pecot_bin_mock.body,
        "post_file": project / ".pecot" / "tmp" / "plan-post" / "test-slug.md",
        "install_pecot_mock": lambda: pecot_bin_mock.install(plugin),
    }


def _run(hook_script: Path, stdin: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(hook_script)],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=25,
    )


def _exit_plan_input(transcript_file: Path) -> str:
    return json.dumps({"tool_name": "ExitPlanMode", "transcript_path": str(transcript_file)})


# .pecot-active がない場合。


def test_no_pecot_active_no_output(ctx, hook_script):
    # setup は .pecot-active を作らない（rm -f 相当の不存在状態）。
    result = _run(hook_script, '{"tool_name":"ExitPlanMode"}')
    assert result.returncode == 0
    assert result.stdout == ""


# pecot 未使用リポ（.pecot 不在）: 何も書かず .pecot を作らない（#666）。


def test_pecot_absent_exits_clean(ctx, hook_script):
    # 既存 setup が作る .pecot を消し、pecot 未使用リポの状態を再現する。
    shutil.rmtree(ctx["project"] / ".pecot")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Test Plan\n")
    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    assert result.stdout == ""
    assert not (ctx["project"] / ".pecot").is_dir()
    assert not ctx["debug_log"].is_file()


# transcript_path がない場合。


def test_no_transcript_path_no_output(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    result = _run(hook_script, '{"tool_name":"ExitPlanMode"}')
    assert result.returncode == 0
    assert result.stdout == ""


def test_transcript_path_nonexistent_no_output(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    result = _run(
        hook_script,
        '{"tool_name":"ExitPlanMode","transcript_path":"/nonexistent/path/file.jsonl"}',
    )
    assert result.returncode == 0
    assert result.stdout == ""


# slug が見つからない場合。


def test_no_slug_field_no_output(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    ctx["transcript_file"].write_text('{"type":"progress","sessionId":"abc"}')
    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    assert result.stdout == ""


# プランファイルが存在しない場合。


def test_plan_file_absent_no_output(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    ctx["transcript_file"].write_text('{"slug":"nonexistent-slug","type":"progress"}')
    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    assert result.stdout == ""


# 正常系: slug抽出とプランファイル読み取り。


def test_slug_extracted_even_when_not_first_line(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/789\n")
    # 実際の transcript と同様: 最初の数行に slug がなく、後の行に slug が出現。
    ctx["transcript_file"].write_text(
        "\n".join(
            [
                '{"type":"file-history-snapshot","files":[]}',
                '{"type":"progress","message":"loading"}',
                '{"type":"user","content":"hello"}',
                '{"type":"progress","message":"processing"}',
                '{"slug":"late-slug","type":"assistant","content":"response"}',
            ]
        )
        + "\n"
    )
    (ctx["plan_dir"] / "late-slug.md").write_text("# Late Slug Plan\n")

    _run(hook_script, _exit_plan_input(ctx["transcript_file"]))

    assert ctx["debug_log"].is_file()
    log = ctx["debug_log"].read_text()
    assert "SLUG: late-slug" in log
    assert "ISSUE_REF: org/repo/789" in log


def test_debug_log_records_slug_and_plan_info(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress","sessionId":"abc123"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Test Plan Content\n")

    _run(hook_script, _exit_plan_input(ctx["transcript_file"]))

    assert ctx["debug_log"].is_file()
    log = ctx["debug_log"].read_text()
    assert "SLUG: test-slug" in log
    assert "PLAN_CONTENT_LENGTH:" in log
    assert "ISSUE_REF: org/repo/123" in log


def test_issue_number_extracted(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/456\n")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Plan\n")

    _run(hook_script, _exit_plan_input(ctx["transcript_file"]))

    assert "#456" in ctx["debug_log"].read_text()


# plan-post-pending フラグの扱い。


def test_plan_post_pending_remains_on_post_failure(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    (ctx["state_dir"] / ".plan-post-pending").write_text("session123:org/repo/123\n")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Test Plan\n")

    # bin/pecot を置かない（CLAUDE_PLUGIN_ROOT/bin/pecot 不在）ため投稿失敗。
    _run(hook_script, _exit_plan_input(ctx["transcript_file"]))

    # plan-post-pending は残っているべき（投稿失敗のため）。
    assert (ctx["state_dir"] / ".plan-post-pending").is_file()


def test_plan_post_pending_removed_on_post_success(ctx, hook_script):
    """entry 経由で投稿成功時に .plan-post-pending が削除され、成功 additionalContext が出る。

    経由する流れは、post-tool-use-exit-plan-mode.sh → merge-hook-outputs → poster。
    失敗パス（上）と、成功/失敗の対を同一ファイルで固定する。
    """
    ctx["install_pecot_mock"]()
    ctx["pecot_active"].write_text("org/repo/123\n")
    (ctx["state_dir"] / ".plan-post-pending").write_text("session123:org/repo/123\n")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Test Plan\n")

    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    # 投稿が実行された（bin/pecot モック呼び出し）。
    assert ctx["marker"].is_file()
    assert "issue comment" in ctx["marker"].read_text()
    # 投稿成功: plan-post-pending が消費（削除）され、一時ファイルも消えている。
    assert not (ctx["state_dir"] / ".plan-post-pending").is_file()
    assert not ctx["post_file"].exists()
    # 成功メッセージが additionalContext に出る。
    assert "計画をIssue #123 に投稿しました" in result.stdout


def test_post_uses_plan_file_with_frontmatter(ctx, hook_script):
    """投稿は一時ファイル経由（`issue comment <path>`）。ファイル先頭の frontmatter に
    issue_ref と template: plan を置き、前置き見出しを付けない。投稿後は一時ファイルを消す。"""
    ctx["install_pecot_mock"]()
    ctx["pecot_active"].write_text("org/repo/123\n")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("## Plan — 計画を投稿する\n")

    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    assert ctx["marker"].read_text() == f"issue comment {ctx['post_file']}\n"
    assert ctx["body"].read_text() == (
        '---\nissue_ref: "org/repo/123"\ntemplate: plan\n---\n\n## Plan — 計画を投稿する\n'
    )
    assert not ctx["post_file"].exists()


def test_validation_failure_clears_flags_and_guides_manual_post(
    ctx, hook_script, monkeypatch: pytest.MonkeyPatch
):
    """exit 3（検証失敗）は再試行しても通らないため、.plan-post-pending と
    .pecot-quick-mode を消し手動投稿（--prepare -t plan）だけを案内する。"""
    ctx["install_pecot_mock"]()
    monkeypatch.setenv("PECOT_MOCK_EXIT", "3")
    monkeypatch.setenv("PECOT_MOCK_STDERR", "検証エラーの本文")
    ctx["pecot_active"].write_text("org/repo/123\n")
    (ctx["state_dir"] / ".plan-post-pending").write_text("session123:org/repo/123\n")
    (ctx["state_dir"] / ".pecot-quick-mode").touch()
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Test Plan\n")

    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    assert not (ctx["state_dir"] / ".plan-post-pending").exists()
    assert not (ctx["state_dir"] / ".pecot-quick-mode").exists()
    assert not ctx["post_file"].exists()
    context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
    assert context.startswith(
        "【plan-issue-poster】計画が Issue コメントの規約を満たさないため、Issue #123 に投稿しませんでした:\n"
        "検証エラーの本文\n"
    )
    assert "issue comment --prepare -t plan -i org/repo/123" in context
    assert "ネットワーク問題" not in context


def test_communication_failure_keeps_plan_post_pending(
    ctx, hook_script, monkeypatch: pytest.MonkeyPatch
):
    """exit 3 以外の失敗（通信エラー等）は出力の文言によらず .plan-post-pending を残して
    再試行に回す。"""
    ctx["install_pecot_mock"]()
    monkeypatch.setenv("PECOT_MOCK_EXIT", "1")
    monkeypatch.setenv("PECOT_MOCK_STDERR", "エラー: 不足セクション: 502 Bad Gateway")
    ctx["pecot_active"].write_text("org/repo/123\n")
    (ctx["state_dir"] / ".plan-post-pending").write_text("session123:org/repo/123\n")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Test Plan\n")

    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    assert (ctx["state_dir"] / ".plan-post-pending").is_file()
    assert not ctx["post_file"].exists()
    context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
    assert "への投稿に失敗しました: エラー: 不足セクション: 502 Bad Gateway" in context
    assert "規約を満たさない" not in context


# プランファイルが空の場合。


def test_empty_plan_file_no_output(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("")
    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    assert result.stdout == ""


# 実装リマインダー連結（投稿失敗パスでも MESSAGE 末尾に連結される）。


def test_injects_implementer_remind_no_team_name(ctx, hook_script):
    ctx["pecot_active"].write_text("org/repo/123\n")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Test Plan\n")
    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    assert "実装の引き継ぎ" in result.stdout
    assert "コミットは main の責務" in result.stdout
    assert "team_name" not in result.stdout
    assert (
        "1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。"
        in result.stdout
    )


def test_quick_mode_no_implementer_remind(ctx, hook_script):
    (ctx["state_dir"] / ".pecot-quick-mode").touch()
    ctx["pecot_active"].write_text("org/repo/123\n")
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Test Plan\n")
    result = _run(hook_script, _exit_plan_input(ctx["transcript_file"]))
    assert result.returncode == 0
    assert "実装の引き継ぎ" not in result.stdout
    assert "コミットは main の責務" not in result.stdout


def test_post_from_work_link_uses_session_worktree_issue(
    ctx, hook_script, work_layout, monkeypatch: pytest.MonkeyPatch
):
    """cwd が base 実体の .pecot/work/N でも、worktree の .pecot-active の Issue へ投稿する。

    worktree 側の plan-post-flow.log に SUCCESS を残す。
    base の state は読まない。
    """
    wt = work_layout["wt"]
    base = work_layout["base"]
    (wt / ".pecot" / "state").mkdir(parents=True)
    (wt / ".pecot" / "tmp" / "debug").mkdir(parents=True)
    (wt / ".pecot" / "state" / ".pecot-active").write_text("org/repo/123\n")
    (base / ".pecot" / "state").mkdir(parents=True)
    (base / ".pecot" / "state" / ".pecot-active").write_text("org/repo/999\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(wt))
    ctx["install_pecot_mock"]()
    ctx["transcript_file"].write_text('{"slug":"test-slug","type":"progress"}')
    (ctx["plan_dir"] / "test-slug.md").write_text("# Plan\n")
    payload = json.dumps(
        {
            "tool_name": "ExitPlanMode",
            "transcript_path": str(ctx["transcript_file"]),
            "cwd": str(work_layout["work"] / "1244"),
        }
    )

    result = _run(hook_script, payload)

    assert result.returncode == 0
    assert "計画をIssue #123 に投稿しました" in result.stdout
    assert ctx["body"].read_text().startswith('---\nissue_ref: "org/repo/123"\n')
    log = wt / ".pecot" / "tmp" / "debug" / "plan-post-flow.log"
    assert "SUCCESS" in log.read_text()
    assert not (base / ".pecot" / "tmp" / "debug" / "plan-post-flow.log").exists()
