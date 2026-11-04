"""hook-input.sh（hook 入力 JSON を PECOT_HOOK_* に export する）のテスト（#1229 T054）。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

_VARS = [
    "PECOT_HOOK_EVENT",
    "PECOT_HOOK_TOOL_NAME",
    "PECOT_HOOK_COMMAND",
    "PECOT_HOOK_CWD",
    "PECOT_HOOK_SESSION_ID",
    "PECOT_HOOK_TRANSCRIPT_PATH",
    "PECOT_HOOK_FILE_PATH",
    "PECOT_HOOK_PLAN_PATH",
    "PECOT_HOOK_SKILL_NAME",
    "PECOT_HOOK_SOURCE",
    "PECOT_HOOK_SESSION_TITLE",
    "PECOT_HOOK_COMMAND_OVERSIZE",
]

# 値を NUL 区切りで出す（改行を含む値を壊さない）。子プロセスから見えること（export）も確かめる。
_PRINT = "for v in " + " ".join(_VARS) + '; do printf "%s\\0" "${!v}"; done'
_DUMP = 'source "$1" && pecot_hook_input_load "$2" && bash -c \'' + _PRINT + "'"
_DUMP_TWICE = (
    'source "$1" && pecot_hook_input_load "$2" && pecot_hook_input_load "$3" && bash -c \''
    + _PRINT
    + "'"
)


@pytest.fixture
def hook_input(core_dir: Path) -> Path:
    return core_dir / "hook-input.sh"


def _load(hook_input: Path, *payloads: str) -> dict[str, str]:
    script = _DUMP if len(payloads) == 1 else _DUMP_TWICE
    out = subprocess.run(
        ["bash", "-c", script, "_", str(hook_input), *payloads],
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert out.returncode == 0, out.stderr
    values = out.stdout.split("\0")[:-1]
    return dict(zip(_VARS, values, strict=True))


def test_claude_bash_input(hook_input) -> None:
    payload = json.dumps(
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "git status"},
            "cwd": "/work/repo",
            "session_id": "s-1",
            "transcript_path": "/t/s-1.jsonl",
        }
    )
    got = _load(hook_input, payload)
    assert got["PECOT_HOOK_EVENT"] == "PreToolUse"
    assert got["PECOT_HOOK_TOOL_NAME"] == "Bash"
    assert got["PECOT_HOOK_COMMAND"] == "git status"
    assert got["PECOT_HOOK_CWD"] == "/work/repo"
    assert got["PECOT_HOOK_SESSION_ID"] == "s-1"
    assert got["PECOT_HOOK_TRANSCRIPT_PATH"] == "/t/s-1.jsonl"
    assert got["PECOT_HOOK_FILE_PATH"] == ""


@pytest.mark.parametrize(
    ("tool_input", "expected"),
    [
        ({"file_path": "/a/b.py"}, "/a/b.py"),  # Claude の Read / Write / Edit
        ({"notebook_path": "/a/n.ipynb"}, "/a/n.ipynb"),  # NotebookEdit
        ({"path": "/a/c.py", "old_str": "x", "new_str": "y"}, "/a/c.py"),  # Copilot の Read / Edit
    ],
)
def test_file_path_variants(hook_input, tool_input, expected) -> None:
    got = _load(hook_input, json.dumps({"tool_name": "Edit", "tool_input": tool_input}))
    assert got["PECOT_HOOK_FILE_PATH"] == expected


def test_copilot_apply_patch_string_tool_input_is_tolerated(hook_input) -> None:
    """Copilot の apply_patch は tool_input がパッチ文字列（オブジェクトではない）。"""
    got = _load(
        hook_input,
        json.dumps(
            {"tool_name": "Edit", "tool_input": "*** Begin Patch\n*** End Patch", "cwd": "/w"}
        ),
    )
    assert got["PECOT_HOOK_TOOL_NAME"] == "Edit"
    assert got["PECOT_HOOK_COMMAND"] == ""
    assert got["PECOT_HOOK_FILE_PATH"] == ""
    assert got["PECOT_HOOK_CWD"] == "/w"


def test_skill_and_plan_path(hook_input) -> None:
    skill = _load(hook_input, json.dumps({"tool_name": "skill", "tool_input": {"skill": "w-help"}}))
    assert skill["PECOT_HOOK_SKILL_NAME"] == "w-help"
    plan = _load(
        hook_input,
        json.dumps(
            {"tool_name": "ExitPlanMode", "tool_input": {"plan": "p", "planFilePath": "/p/x.md"}}
        ),
    )
    assert plan["PECOT_HOOK_PLAN_PATH"] == "/p/x.md"


def test_command_with_quotes_and_newlines_is_preserved_and_not_executed(
    hook_input, tmp_path
) -> None:
    marker = tmp_path / "injected"
    command = f"echo 'a'; touch {marker}\n\"$(touch {marker})\" `touch {marker}`\n'"
    got = _load(hook_input, json.dumps({"tool_input": {"command": command}}))
    assert got["PECOT_HOOK_COMMAND"] == command
    assert not marker.exists()


@pytest.mark.parametrize(
    ("extra", "title"),
    [
        ({"session_title": "#1 a"}, "#1 a"),
        ({"session_title": None}, ""),
        ({}, ""),
    ],
    ids=["named", "null", "key-absent"],
)
def test_source_and_session_title(hook_input, extra, title) -> None:
    payload = json.dumps({"hook_event_name": "SessionStart", "source": "resume", **extra})
    got = _load(hook_input, payload)
    assert got["PECOT_HOOK_SOURCE"] == "resume"
    assert got["PECOT_HOOK_SESSION_TITLE"] == title


def test_second_load_does_not_keep_previous_values(hook_input) -> None:
    first = json.dumps(
        {
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "cwd": "/a",
            "session_id": "old",
            "source": "startup",
            "session_title": "old title",
        }
    )
    second = json.dumps({"tool_name": "Read", "tool_input": {"path": "/x"}})
    got = _load(hook_input, first, second)
    assert got["PECOT_HOOK_TOOL_NAME"] == "Read"
    assert got["PECOT_HOOK_COMMAND"] == ""
    assert got["PECOT_HOOK_CWD"] == ""
    assert got["PECOT_HOOK_SESSION_ID"] == ""
    assert got["PECOT_HOOK_FILE_PATH"] == "/x"
    assert got["PECOT_HOOK_SOURCE"] == ""
    assert got["PECOT_HOOK_SESSION_TITLE"] == ""


@pytest.mark.parametrize("payload", ["", "not json", "[]", "null", '{"tool_input":null}'])
def test_invalid_or_empty_input_yields_empty_values(hook_input, payload) -> None:
    got = _load(hook_input, payload)
    assert all(v == "" for v in got.values())


# 環境変数 1 個が 128KiB を超えると、その後の execve がすべて失敗する。
# 上限を超えるコマンドは export せず（同じシェルの変数としては残す）、OVERSIZE=1 を渡す。
_SIZE_IN_SHELL = (
    'source "$1" && pecot_hook_input_load "$2" && '
    'printf "%s|%s|%s" "${#PECOT_HOOK_COMMAND}" "${PECOT_HOOK_COMMAND_OVERSIZE}" '
    '"$(bash -c \'printf "%s" "${PECOT_HOOK_COMMAND-unset}"\' | wc -c)"'
)


@pytest.mark.parametrize(
    ("command", "chars", "oversize", "child_len"),
    [
        pytest.param("a" * 60000, 60000, "", 60000, id="at-limit"),
        pytest.param("a" * 60001, 60001, "1", len("unset"), id="over-limit"),
        # 日本語は 1 文字 3 バイト。文字数では 25000 でも 75000 バイトなので超過扱いにする
        pytest.param("あ" * 25000, 25000, "1", len("unset"), id="multibyte-over-limit"),
    ],
)
def test_oversize_command_is_not_exported(hook_input, command, chars, oversize, child_len) -> None:
    out = subprocess.run(
        [
            "bash",
            "-c",
            _SIZE_IN_SHELL,
            "_",
            str(hook_input),
            json.dumps({"tool_input": {"command": command}}, ensure_ascii=False),
        ],
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout == f"{chars}|{oversize}|{child_len}"


def test_oversize_flag_is_reset_by_next_load(hook_input) -> None:
    big = json.dumps({"tool_input": {"command": "a" * 70000}})
    small = json.dumps({"tool_input": {"command": "ls"}})
    got = _load(hook_input, big, small)
    assert got["PECOT_HOOK_COMMAND"] == "ls"
    assert got["PECOT_HOOK_COMMAND_OVERSIZE"] == ""
