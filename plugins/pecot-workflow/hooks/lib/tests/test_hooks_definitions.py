"""hooks 定義 4 本の検証（#1229 T052）。

対象は pecot-workflow / pecot-visual の hooks.json と com.github.copilot/hooks/hooks.json。

全エントリの timeout、matcher、SessionStart / Stop / Notification の構成を固定する。
`${CLAUDE_PLUGIN_ROOT}` のクォートと、command が指すファイルの実在と実行権も固定する。
値の根拠は contracts/hooks.md と、計画の Step 7 の表。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

WORKFLOW = "pecot-workflow"
VISUAL = "pecot-visual"

# Copilot 定義は Agent Plugins 1.0 形式の位置（プラグインルート相対）にある。
COPILOT_VISUAL = "com.github.copilot/hooks/hooks.json"
COPILOT_WORKFLOW = "com.github.copilot/hooks/hooks.json"

DEFINITIONS = [
    (WORKFLOW, "hooks.json"),
    (WORKFLOW, COPILOT_WORKFLOW),
    (VISUAL, "hooks.json"),
    (VISUAL, COPILOT_VISUAL),
]
CLAUDE_DEFINITIONS = [(WORKFLOW, "hooks.json"), (VISUAL, "hooks.json")]
COPILOT_DEFINITIONS = [(WORKFLOW, COPILOT_WORKFLOW), (VISUAL, COPILOT_VISUAL)]

EDIT_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|EnterPlanMode"
NOTIFICATION_MATCHER = "permission_prompt|idle_prompt|elicitation_dialog"
QUOTED_COMMAND_RE = re.compile(r'^"\$\{CLAUDE_PLUGIN_ROOT\}"/hooks/(?P<file>[A-Za-z0-9._-]+\.sh)$')
# ファイル名の抽出用（クォートの有無は問わない。クォートは test_command_quotes_plugin_root が固定する）。
FILE_RE = re.compile(r"/hooks/(?P<file>[A-Za-z0-9._-]+\.sh)$")
PASCAL_CASE_EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "Notification",
}


def _ids(defs: list[tuple[str, str]]) -> list[str]:
    return [f"{plugin}/{name}" for plugin, name in defs]


@pytest.fixture(scope="module")
def plugins_dir(project_root: Path) -> Path:
    return project_root / "plugins"


@pytest.fixture
def load(plugins_dir: Path):
    def _load(plugin: str, name: str) -> dict:
        path = plugins_dir / plugin / name if "/" in name else plugins_dir / plugin / "hooks" / name
        return json.loads(path.read_text())["hooks"]

    return _load


def _entries(hooks: dict, event: str) -> list[dict]:
    return hooks.get(event, [])


def _all_hooks(hooks: dict):
    """(event, matcher, hook dict) を全件返す。"""
    for event, entries in hooks.items():
        for entry in entries:
            for hook in entry["hooks"]:
                yield event, entry.get("matcher"), hook


def _file(hook: dict) -> str:
    m = FILE_RE.search(hook["command"])
    assert m, f"command が hooks/<file>.sh を指していない: {hook['command']}"
    return m.group("file")


def _expected_timeout(plugin: str, event: str, matcher: str | None, command_file: str) -> int:
    if plugin == WORKFLOW:
        if event == "SessionStart":
            return 120
        if event == "PreToolUse":
            return 10
        if event == "PostToolUse":
            return {
                "Bash": 30,
                "Skill": 10,
                "Skill|skill": 10,
                "EnterPlanMode": 10,
                "ExitPlanMode": 90,
            }[matcher or ""]
        if event == "Stop":
            return 10
        if event in ("UserPromptSubmit", "Notification"):
            return 10
    else:
        if event == "SessionStart":
            return 120
        if event in ("UserPromptSubmit", "PreToolUse"):
            return 10
        if event == "PostToolUse":
            return {"Write": 80, "Edit": 80}[matcher or ""]
    raise AssertionError(f"期待値の表に無い組: {plugin} {event} {matcher}")


# 全定義共通。


@pytest.mark.parametrize(("plugin", "name"), DEFINITIONS, ids=_ids(DEFINITIONS))
def test_every_hook_has_expected_timeout(load, plugin, name) -> None:
    hooks = load(plugin, name)
    seen = 0
    for event, matcher, hook in _all_hooks(hooks):
        seen += 1
        assert "timeout" in hook, f"timeout が無い: {event} {matcher} {hook['command']}"
        expected = _expected_timeout(plugin, event, matcher, _file(hook))
        assert hook["timeout"] == expected, f"{event} {matcher} {hook['command']}"
    assert seen > 0


@pytest.mark.parametrize(("plugin", "name"), DEFINITIONS, ids=_ids(DEFINITIONS))
def test_command_quotes_plugin_root(load, plugin, name) -> None:
    for event, matcher, hook in _all_hooks(load(plugin, name)):
        assert hook["type"] == "command"
        assert QUOTED_COMMAND_RE.match(hook["command"]), (
            f'{event} {matcher}: "${{CLAUDE_PLUGIN_ROOT}}"/hooks/<file> の形にする: {hook["command"]}'
        )


@pytest.mark.parametrize(("plugin", "name"), DEFINITIONS, ids=_ids(DEFINITIONS))
def test_command_targets_exist_and_are_executable(plugins_dir, load, plugin, name) -> None:
    for event, matcher, hook in _all_hooks(load(plugin, name)):
        path = plugins_dir / plugin / "hooks" / _file(hook)
        assert path.is_file(), f"{event} {matcher}: {path} が無い"
        assert os.access(path, os.X_OK), f"{path} に実行権が無い"


@pytest.mark.parametrize(("plugin", "name"), DEFINITIONS, ids=_ids(DEFINITIONS))
def test_pre_tool_use_entries_all_have_matcher(load, plugin, name) -> None:
    for entry in _entries(load(plugin, name), "PreToolUse"):
        assert entry.get("matcher"), f"matcher 無しの PreToolUse: {entry}"


@pytest.mark.parametrize(("plugin", "name"), COPILOT_DEFINITIONS, ids=_ids(COPILOT_DEFINITIONS))
def test_copilot_event_names_are_pascal_case(load, plugin, name) -> None:
    """Copilot CLI は PascalCase のイベント名の定義には snake_case の tool_name / tool_input を送る。

    hooks は camelCase（toolName / toolArgs）の入力を読まない。
    そのため、定義側のイベント名が camelCase（preToolUse 等）になっていないことを固定する。
    camelCase のイベント名は、camelCase の入力を送る形式にあたる。
    """
    assert set(load(plugin, name)) <= PASCAL_CASE_EVENTS


# PreToolUse の matcher（pecot-workflow）。


@pytest.mark.parametrize(
    ("plugin", "name"),
    [(WORKFLOW, "hooks.json"), (WORKFLOW, COPILOT_WORKFLOW)],
    ids=["claude", "copilot"],
)
def test_edit_entry_matcher_is_narrowed(load, plugin, name) -> None:
    entries = [
        e
        for e in _entries(load(plugin, name), "PreToolUse")
        if any(_file(h) == "pre-tool-use.sh" for h in e["hooks"])
    ]
    assert len(entries) == 1
    assert entries[0]["matcher"] == EDIT_MATCHER


# SessionStart


@pytest.mark.parametrize(("plugin", "name"), CLAUDE_DEFINITIONS, ids=_ids(CLAUDE_DEFINITIONS))
def test_claude_session_start_single_pull_entry(load, plugin, name) -> None:
    entries = _entries(load(plugin, name), "SessionStart")
    assert len(entries) == 1, (
        "pull の SessionStart は 1 エントリにまとめる（クリア後の計画投稿は Stop）"
    )
    expected = "startup|clear|resume|fork" if plugin == WORKFLOW else "startup|clear|resume"
    assert entries[0]["matcher"] == expected
    assert len(entries[0]["hooks"]) == 1


@pytest.mark.parametrize(("plugin", "name"), DEFINITIONS, ids=_ids(DEFINITIONS))
def test_no_data_dir_handoff_hook(plugins_dir: Path, plugin, name) -> None:
    """データ置き場は、wrapper が CLAUDE_PLUGIN_DATA → PLUGIN_DATA → 既定の場所の順で決める。
    SessionStart で CLAUDE_ENV_FILE に変数を書いて Bash に渡す hook は無い（#1258）。
    """
    path = plugins_dir / plugin / name if "/" in name else plugins_dir / plugin / "hooks" / name
    text = path.read_text()
    assert "session-start-data-dir" not in text
    assert "CLAUDE_ENV_FILE" not in text


def test_pecot_tools_has_no_hooks_directory(plugins_dir: Path) -> None:
    """pecot-tools の hook は受け渡しだけだったので、ディレクトリごと無い。"""
    assert not (plugins_dir / "pecot-tools" / "hooks").exists()


def test_claude_workflow_session_title_entry_only_in_claude_definition(load) -> None:
    """セッション名（sessionTitle）は Claude Code 専用の UserPromptSubmit エントリで出す。
    sessionTitle は、公式ドキュメント（hooks の UserPromptSubmit / SessionStart decision control）に記載がある出力項目。
    Copilot CLI の hook 出力には無いので、Copilot の hooks.json には載せない。
    user-prompt-submit.sh は素テキストを echo する構成で JSON を混ぜられないため、別エントリにする。
    """
    claude = [
        _file(h)
        for e in _entries(load(WORKFLOW, "hooks.json"), "UserPromptSubmit")
        for h in e["hooks"]
    ]
    assert claude == ["user-prompt-submit.sh", "user-prompt-submit-title.sh"]
    copilot = [
        _file(h)
        for e in _entries(load(WORKFLOW, COPILOT_WORKFLOW), "UserPromptSubmit")
        for h in e["hooks"]
    ]
    assert "user-prompt-submit-title.sh" not in copilot


@pytest.mark.parametrize(("plugin", "name"), COPILOT_DEFINITIONS, ids=_ids(COPILOT_DEFINITIONS))
def test_copilot_session_start_single_entry_without_matcher(load, plugin, name) -> None:
    entries = _entries(load(plugin, name), "SessionStart")
    assert len(entries) == 1
    assert "matcher" not in entries[0], "Copilot CLI は SessionStart の matcher を解釈しない"
    assert len(entries[0]["hooks"]) == 1


# Stop / Notification（pecot-workflow）


def test_claude_notification_matcher_and_stop_entry(load) -> None:
    hooks = load(WORKFLOW, "hooks.json")
    notification = _entries(hooks, "Notification")
    assert len(notification) == 1
    assert notification[0]["matcher"] == NOTIFICATION_MATCHER
    stop_files = [_file(h) for e in _entries(hooks, "Stop") for h in e["hooks"]]
    assert stop_files == ["stop.sh"]


def test_copilot_stop_points_at_copilot_entry(load) -> None:
    stop_files = [
        _file(h) for e in _entries(load(WORKFLOW, COPILOT_WORKFLOW), "Stop") for h in e["hooks"]
    ]
    assert stop_files == ["stop-copilot.sh"]


# Copilot CLI の matcher（#1229 T050 追加確認: 全体一致 `^(?:PATTERN)$`）。
# skill と MCP には、Claude の名前が無い。


def _matchers(hooks: dict, event: str, entry_file: str) -> list[str | None]:
    return [
        e.get("matcher")
        for e in _entries(hooks, event)
        if any(_file(h) == entry_file for h in e["hooks"])
    ]


@pytest.mark.parametrize("event", ["PreToolUse", "PostToolUse"])
def test_copilot_workflow_skill_matcher_includes_raw_tool_name(load, event) -> None:
    entry = "pre-tool-use-skill.sh" if event == "PreToolUse" else "post-tool-use-skill.sh"
    assert _matchers(load(WORKFLOW, COPILOT_WORKFLOW), event, entry) == ["Skill|skill"]


def test_copilot_workflow_mcp_matcher_includes_github_mcp_pr_create(load) -> None:
    matchers = _matchers(load(WORKFLOW, COPILOT_WORKFLOW), "PreToolUse", "pre-tool-use-mcp.sh")
    assert matchers == ["mcp__.*|github-mcp-server-create_pull_request|pecot-workflow-.*"]


def test_copilot_visual_skill_matcher_includes_raw_tool_name(load) -> None:
    matchers = _matchers(load(VISUAL, COPILOT_VISUAL), "PreToolUse", "pre-tool-use-skill.sh")
    assert matchers == ["Skill|skill"]


def test_claude_skill_and_mcp_matchers_are_unchanged(load) -> None:
    workflow = load(WORKFLOW, "hooks.json")
    assert _matchers(workflow, "PreToolUse", "pre-tool-use-skill.sh") == ["Skill"]
    assert _matchers(workflow, "PreToolUse", "pre-tool-use-mcp.sh") == ["mcp__.*"]
    assert _matchers(load(VISUAL, "hooks.json"), "PreToolUse", "pre-tool-use-skill.sh") == ["Skill"]
