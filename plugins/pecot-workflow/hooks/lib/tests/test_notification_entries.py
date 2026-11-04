"""通知音のエントリ（stop.sh / notification.sh / stop-copilot.sh）のテスト（#1229 T059）。

Claude Code の Stop / Notification は hook 出力のトップレベル `terminalSequence` で BEL を出す。
Copilot CLI の hook 出力には terminalSequence が無いため、stop-copilot.sh が PTY へ直接書く。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

BEL = "\u0007"


@pytest.fixture
def project(claude_project_dir: Path, hooks_config) -> Path:
    hooks_config.write({})
    return claude_project_dir


def _run(hooks_dir: Path, entry: str, payload: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(hooks_dir / entry)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=25,
    )


def test_notification_emits_terminal_sequence(hooks_dir, project) -> None:
    result = _run(
        hooks_dir,
        "notification.sh",
        {"hook_event_name": "Notification", "notification_type": "permission_prompt"},
    )
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"terminalSequence": BEL}


def test_stop_emits_terminal_sequence(hooks_dir, project) -> None:
    result = _run(hooks_dir, "stop.sh", {"hook_event_name": "Stop"})
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"terminalSequence": BEL}


def test_stop_merges_bell_with_auto_push_system_message(hooks_dir, project) -> None:
    flag = project / ".pecot" / "state" / ".auto-push-urls"
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text("自動push完了: wip/x\n比較: https://example.test/compare\n\n")
    result = _run(hooks_dir, "stop.sh", {"hook_event_name": "Stop"})
    data = json.loads(result.stdout)
    assert data["terminalSequence"] == BEL
    assert "wip/x" in data["systemMessage"]


def test_terminal_bell_disabled_by_config(hooks_dir, project, hooks_config) -> None:
    hooks_config.write({"terminal-bell": False})
    result = _run(hooks_dir, "stop.sh", {"hook_event_name": "Stop"})
    assert result.returncode == 0
    assert result.stdout == ""


def test_terminal_bell_disabled_by_legacy_pty_bell_sender_key(
    hooks_dir, project, hooks_config
) -> None:
    """pty-bell-sender: false で通知音を止めている利用者には、更新後も terminalSequence を出さない。"""
    hooks_config.write({"pty-bell-sender": False})
    result = _run(hooks_dir, "stop.sh", {"hook_event_name": "Stop"})
    assert result.returncode == 0
    assert result.stdout == ""


def test_stop_copilot_does_not_emit_terminal_sequence(hooks_dir, project) -> None:
    """Copilot の Stop は PTY ベル（pty-bell-sender）。hook 出力に terminalSequence は出さない。"""
    result = _run(hooks_dir, "stop-copilot.sh", {"hook_event_name": "Stop"})
    assert result.returncode == 0
    assert "terminalSequence" not in result.stdout


def test_stop_copilot_still_shows_auto_push_urls(hooks_dir, project) -> None:
    flag = project / ".pecot" / "state" / ".auto-push-urls"
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text("自動push完了: wip/x\n比較: https://example.test/compare\n\n")
    result = _run(hooks_dir, "stop-copilot.sh", {"hook_event_name": "Stop"})
    data = json.loads(result.stdout)
    assert "wip/x" in data["systemMessage"]
    assert "terminalSequence" not in data
