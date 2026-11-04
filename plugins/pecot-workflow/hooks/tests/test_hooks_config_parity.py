"""hooks.json / hooks-copilot.json の plan 系エントリ構成パリティ回帰テスト。

contracts/hook-flow.md 不変条件 3 は次のとおり。
Copilot CLI 手段（hooks-copilot.json）の plan 系 hook 挙動は、Claude Code 手段（hooks.json）と同一。
両ファイルの plan 系 4 エントリを、{(event, matcher): command} の写像に正規化する。
4 エントリは、PreToolUse/PostToolUse × EnterPlanMode/ExitPlanMode。
配列順に依存せず、一致を検証する。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

_PLAN_MATCHERS = {"EnterPlanMode", "ExitPlanMode"}
_PLAN_EVENTS = ("PreToolUse", "PostToolUse")


@pytest.fixture
def hooks_dir(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks"


def _plan_entry_map(config_path: Path) -> dict[tuple[str, str], str]:
    """plan 系 4 エントリを {(event, matcher): command} に正規化する（順序非依存）。"""
    data = json.loads(config_path.read_text())
    result: dict[tuple[str, str], str] = {}
    for event in _PLAN_EVENTS:
        for entry in data["hooks"].get(event, []):
            matcher = entry.get("matcher")
            if matcher not in _PLAN_MATCHERS:
                continue
            commands = [h["command"] for h in entry["hooks"]]
            assert len(commands) == 1, f"{event}/{matcher} に複数コマンド: {commands}"
            # 同一 (event, matcher) の重複エントリが last-wins で masked されるのを防ぐ。
            assert (event, matcher) not in result, f"重複エントリ: {(event, matcher)}"
            result[(event, matcher)] = commands[0]
    return result


def test_plan_entries_present_in_both(hooks_dir: Path):
    claude = _plan_entry_map(hooks_dir / "hooks.json")
    copilot = _plan_entry_map(hooks_dir / "hooks-copilot.json")
    expected_keys = {(e, m) for e in _PLAN_EVENTS for m in _PLAN_MATCHERS}
    assert set(claude.keys()) == expected_keys
    assert set(copilot.keys()) == expected_keys


def test_plan_entries_parity_between_claude_and_copilot(hooks_dir: Path):
    claude = _plan_entry_map(hooks_dir / "hooks.json")
    copilot = _plan_entry_map(hooks_dir / "hooks-copilot.json")
    # 配列順が異なっても写像として一致すること
    assert claude == copilot
