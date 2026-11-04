"""merge-hook-outputs.sh のテスト（test_merge_hook_outputs.bats 移植）。

SDK 全出力フィールドの安全マージを検証する。
対象のフィールドは、次のとおり。
additionalContext / permissionDecision / continue / systemMessage。
suppressOutput / updatedInput / hookEventName。
サブスクリプトを生成して merge スクリプトに渡し、出力 JSON を Python 側でパースして比較する。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def merge_script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "core"
        / "merge-hook-outputs.sh"
    )


@pytest.fixture
def scripts_dir(tmp_path: Path) -> Path:
    d = tmp_path / "scripts"
    d.mkdir(parents=True)
    return d


def _make_script(scripts_dir: Path, name: str, echo_line: str) -> Path:
    """`cat > /dev/null` で stdin を捨て echo_line を出力するサブスクリプトを生成する。"""
    path = scripts_dir / name
    path.write_text(f"#!/bin/bash\ncat > /dev/null\n{echo_line}\n")
    path.chmod(0o755)
    return path


# hookEventName の既定値は PECOT_HOOK_EVENT（エントリの project-root.sh が hook-input.sh で export）。
# 本番と同じく hook-input.sh を source してから merge を起動する（stdin はサブスクリプトへ転送される）。
_LOAD_THEN_MERGE = 'source "$1" && pecot_hook_input_load "$2" && shift 2 && exec "$@"'


def _run_merge(
    merge_script: Path, *scripts: Path, stdin: str = "{}"
) -> subprocess.CompletedProcess:
    hook_input = merge_script.parent / "hook-input.sh"
    return subprocess.run(
        [
            "bash",
            "-c",
            _LOAD_THEN_MERGE,
            "_",
            str(hook_input),
            stdin,
            str(merge_script),
            *[str(s) for s in scripts],
        ],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_single_script_additional_context(merge_script, scripts_dir) -> None:
    s = _make_script(
        scripts_dir,
        "script.sh",
        'echo \'{"hookSpecificOutput":{"additionalContext":"test message"}}\'',
    )
    result = _run_merge(merge_script, s)
    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"]["additionalContext"] == "test message"


def test_multiple_scripts_additional_context_joined(merge_script, scripts_dir) -> None:
    s1 = _make_script(
        scripts_dir,
        "script1.sh",
        'echo \'{"hookSpecificOutput":{"additionalContext":"msg1"}}\'',
    )
    s2 = _make_script(
        scripts_dir,
        "script2.sh",
        'echo \'{"hookSpecificOutput":{"additionalContext":"msg2"}}\'',
    )
    result = _run_merge(merge_script, s1, s2)
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"]["additionalContext"] == "msg1\nmsg2"


def test_decision_deny_wins(merge_script, scripts_dir) -> None:
    allow = _make_script(
        scripts_dir,
        "allow.sh",
        'echo \'{"hookSpecificOutput":{"permissionDecision":"allow","permissionDecisionReason":"allow reason"}}\'',
    )
    deny = _make_script(
        scripts_dir,
        "deny.sh",
        'echo \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"deny reason"}}\'',
    )
    ask = _make_script(
        scripts_dir,
        "ask.sh",
        'echo \'{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"ask reason"}}\'',
    )
    result = _run_merge(merge_script, allow, ask, deny)
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert data["hookSpecificOutput"]["permissionDecisionReason"] == "deny reason"
    assert "reason" not in data["hookSpecificOutput"]


def test_plain_text_added_to_additional_context(merge_script, scripts_dir) -> None:
    plain = _make_script(scripts_dir, "plain.sh", 'echo "plain text output"')
    result = _run_merge(merge_script, plain)
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"]["additionalContext"] == "plain text output"


def test_empty_output_skipped(merge_script, scripts_dir) -> None:
    empty = scripts_dir / "empty.sh"
    empty.write_text("#!/bin/bash\ncat > /dev/null\n")
    empty.chmod(0o755)
    valid = _make_script(
        scripts_dir,
        "valid.sh",
        'echo \'{"hookSpecificOutput":{"additionalContext":"valid"}}\'',
    )
    result = _run_merge(merge_script, empty, valid)
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"]["additionalContext"] == "valid"


def test_stderr_not_hidden(merge_script, scripts_dir) -> None:
    stderr_script = scripts_dir / "stderr.sh"
    stderr_script.write_text(
        '#!/bin/bash\ncat > /dev/null\necho "stdout msg"\necho "stderr msg" >&2\n'
    )
    stderr_script.chmod(0o755)
    result = _run_merge(merge_script, stderr_script)
    assert result.stderr.strip() == "stderr msg"


def test_continue_false_wins(merge_script, scripts_dir) -> None:
    ct = _make_script(
        scripts_dir,
        "continue-true.sh",
        'echo \'{"continue":true,"hookSpecificOutput":{"additionalContext":"a"}}\'',
    )
    cf = _make_script(scripts_dir, "continue-false.sh", "echo '{\"continue\":false}'")
    result = _run_merge(merge_script, ct, cf)
    data = json.loads(result.stdout)
    assert data["continue"] is False


def test_system_message_joined(merge_script, scripts_dir) -> None:
    s1 = _make_script(scripts_dir, "sys1.sh", 'echo \'{"systemMessage":"system msg 1"}\'')
    s2 = _make_script(scripts_dir, "sys2.sh", 'echo \'{"systemMessage":"system msg 2"}\'')
    result = _run_merge(merge_script, s1, s2)
    data = json.loads(result.stdout)
    assert data["systemMessage"] == "system msg 1\nsystem msg 2"


def test_suppress_output_true_wins(merge_script, scripts_dir) -> None:
    sf = _make_script(
        scripts_dir,
        "suppress-false.sh",
        'echo \'{"suppressOutput":false,"hookSpecificOutput":{"additionalContext":"a"}}\'',
    )
    st = _make_script(scripts_dir, "suppress-true.sh", "echo '{\"suppressOutput\":true}'")
    result = _run_merge(merge_script, sf, st)
    data = json.loads(result.stdout)
    assert data["suppressOutput"] is True


def test_updated_input_last_wins(merge_script, scripts_dir) -> None:
    u1 = _make_script(
        scripts_dir,
        "ui1.sh",
        'echo \'{"hookSpecificOutput":{"updatedInput":"first input"}}\'',
    )
    u2 = _make_script(
        scripts_dir,
        "ui2.sh",
        'echo \'{"hookSpecificOutput":{"updatedInput":"last input"}}\'',
    )
    result = _run_merge(merge_script, u1, u2)
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"]["updatedInput"] == "last input"


def test_hook_event_name_preserved(merge_script, scripts_dir) -> None:
    s1 = _make_script(
        scripts_dir,
        "script1.sh",
        'echo \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"context1"}}\'',
    )
    s2 = _make_script(
        scripts_dir,
        "script2.sh",
        'echo \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"context2"}}\'',
    )
    result = _run_merge(merge_script, s1, s2)
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"]["hookEventName"] == "PostToolUse"


def test_system_message_only_omits_hook_specific_output(merge_script, scripts_dir) -> None:
    """systemMessage のみ（HSO 実フィールドなし）→ hookSpecificOutput を出さない。

    入力 JSON に hook_event_name があると、MERGED_HOOK_EVENT_NAME が埋まる。
    ただし、hookEventName 以外の HSO フィールドが無いケースでは、空 HSO を作らないことを検証する（F-06）。
    空 HSO は、旧 stop.sh の直接出力からの形状差分にあたる。
    """
    s = _make_script(scripts_dir, "sys.sh", 'echo \'{"systemMessage":"sys only"}\'')
    result = _run_merge(merge_script, s, stdin='{"hook_event_name":"Stop"}')
    data = json.loads(result.stdout)
    assert data["systemMessage"] == "sys only"
    assert "hookSpecificOutput" not in data


def test_additional_context_carries_input_hook_event_name(merge_script, scripts_dir) -> None:
    """additionalContext がある場合は入力由来 hookEventName を随伴させる（F-06 回帰）。

    pre-tool-use.sh / post-tool-use-bash.sh 等は、HSO 実フィールドを出す。
    そのため、入力 JSON の hook_event_name が hookEventName として付与され続けること。
    """
    s = _make_script(
        scripts_dir,
        "ac.sh",
        'echo \'{"hookSpecificOutput":{"additionalContext":"ctx"}}\'',
    )
    result = _run_merge(merge_script, s, stdin='{"hook_event_name":"PreToolUse"}')
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"]["additionalContext"] == "ctx"
    assert data["hookSpecificOutput"]["hookEventName"] == "PreToolUse"


def test_no_output_when_nothing_to_merge(merge_script, scripts_dir) -> None:
    """全サブスクリプトの出力が空なら、入力 hook_event_name があっても何も出さない。"""
    empty = scripts_dir / "empty.sh"
    empty.write_text("#!/bin/bash\ncat > /dev/null\n")
    empty.chmod(0o755)
    result = _run_merge(merge_script, empty, stdin='{"hook_event_name":"Stop"}')
    assert result.returncode == 0
    assert result.stdout == ""


def test_terminal_sequence_is_carried_to_top_level(merge_script, scripts_dir) -> None:
    """Claude Code の Stop / Notification の terminalSequence（トップレベル）を引き継ぐ。"""
    s = _make_script(scripts_dir, "bell.sh", 'echo \'{"terminalSequence":"\\u0007"}\'')
    result = _run_merge(merge_script, s, stdin='{"hook_event_name":"Stop"}')
    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert data == {"terminalSequence": "\u0007"}


def test_terminal_sequence_merges_with_system_message(merge_script, scripts_dir) -> None:
    bell = _make_script(scripts_dir, "bell.sh", 'echo \'{"terminalSequence":"\\u0007"}\'')
    msg = _make_script(scripts_dir, "msg.sh", 'echo \'{"systemMessage":"pushed"}\'')
    result = _run_merge(merge_script, bell, msg, stdin='{"hook_event_name":"Stop"}')
    data = json.loads(result.stdout)
    assert data["terminalSequence"] == "\u0007"
    assert data["systemMessage"] == "pushed"


# トップレベルの additionalContext（Copilot CLI 1.0.103 は SessionStart / PostToolUse でこれだけを読む）。


def _ctx_script(scripts_dir: Path, text: str = "hello") -> Path:
    return _make_script(
        scripts_dir,
        "ctx.sh",
        f'echo \'{{"hookSpecificOutput":{{"additionalContext":"{text}"}}}}\'',
    )


@pytest.mark.parametrize("event", ["SessionStart", "PostToolUse"])
def test_top_level_additional_context_for_session_start_and_post_tool_use(
    merge_script, scripts_dir, event
) -> None:
    s = _ctx_script(scripts_dir)
    result = _run_merge(merge_script, s, stdin=json.dumps({"hook_event_name": event}))
    data = json.loads(result.stdout)
    assert data["additionalContext"] == "hello"
    assert data["hookSpecificOutput"]["additionalContext"] == "hello"
    assert data["hookSpecificOutput"]["hookEventName"] == event


@pytest.mark.parametrize("event", ["PreToolUse", "UserPromptSubmit", "Stop"])
def test_no_top_level_additional_context_for_other_events(merge_script, scripts_dir, event) -> None:
    s = _ctx_script(scripts_dir)
    result = _run_merge(merge_script, s, stdin=json.dumps({"hook_event_name": event}))
    data = json.loads(result.stdout)
    assert "additionalContext" not in data
    assert data["hookSpecificOutput"]["additionalContext"] == "hello"


def test_top_level_additional_context_joins_plain_text_and_json(merge_script, scripts_dir) -> None:
    """素のテキスト出力も JSON に畳まれ、トップレベルにも同じ連結結果が出る。"""
    text = _make_script(scripts_dir, "text.sh", "echo '# Git Sync'")
    js = _ctx_script(scripts_dir, "second")
    result = _run_merge(merge_script, text, js, stdin='{"hook_event_name":"SessionStart"}')
    data = json.loads(result.stdout)
    assert data["additionalContext"] == "# Git Sync\nsecond"
    assert data["hookSpecificOutput"]["additionalContext"] == data["additionalContext"]


def test_no_top_level_additional_context_when_empty(merge_script, scripts_dir) -> None:
    msg = _make_script(scripts_dir, "msg.sh", 'echo \'{"systemMessage":"m"}\'')
    result = _run_merge(merge_script, msg, stdin='{"hook_event_name":"PostToolUse"}')
    assert "additionalContext" not in json.loads(result.stdout)


# sessionTitle（SessionStart / UserPromptSubmit のセッション名）。


def test_session_title_passes_through_alone(merge_script, scripts_dir) -> None:
    """sessionTitle だけの出力は、空扱いにせず hookSpecificOutput へ載せる"""
    t = _make_script(
        scripts_dir,
        "title.sh",
        'echo \'{"hookSpecificOutput":{"sessionTitle":"#12 題名"}}\'',
    )
    result = _run_merge(merge_script, t, stdin='{"hook_event_name":"UserPromptSubmit"}')
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"] == {
        "hookEventName": "UserPromptSubmit",
        "sessionTitle": "#12 題名",
    }


def test_session_title_last_wins_and_keeps_additional_context(merge_script, scripts_dir) -> None:
    t1 = _make_script(
        scripts_dir,
        "t1.sh",
        'echo \'{"hookSpecificOutput":{"sessionTitle":"first"}}\'',
    )
    ac = _make_script(scripts_dir, "ac.sh", "echo plain context")
    t2 = _make_script(
        scripts_dir,
        "t2.sh",
        'echo \'{"hookSpecificOutput":{"sessionTitle":"last"}}\'',
    )
    result = _run_merge(merge_script, t1, ac, t2, stdin='{"hook_event_name":"SessionStart"}')
    data = json.loads(result.stdout)
    assert data["hookSpecificOutput"]["sessionTitle"] == "last"
    assert data["hookSpecificOutput"]["additionalContext"] == "plain context"
