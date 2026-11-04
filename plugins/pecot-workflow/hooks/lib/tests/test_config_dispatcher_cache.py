"""config-dispatcher.sh の hooks-config.json キャッシュのテスト（#1229 T054）。

最初の pecot_hook_enabled 呼び出しで hooks-config.json を 1 回の jq で読み、同一プロセス内の
以降の判定では jq を起動しない。判定結果（キーなし・空値・false・パース失敗）は従来どおり。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

_SCRIPT = """
SCRIPT_DIR="$(dirname "$1")"
source "$1"
shift
for key in "$@"; do
    if pecot_hook_enabled "$key" true; then printf '%s=1 ' "$key"; else printf '%s=0 ' "$key"; fi
done
"""


@pytest.fixture
def dispatcher(core_dir: Path) -> Path:
    return core_dir / "config-dispatcher.sh"


@pytest.fixture
def jq_calls(tmp_path: Path, mock_bin) -> Path:
    log = tmp_path / "jq-calls.log"
    real_jq = subprocess.run(
        ["which", "jq"], capture_output=True, text=True, check=True
    ).stdout.strip()
    mock_bin.install("jq", f'echo x >> "{log}"\nexec "{real_jq}" "$@"\n')
    return log


def _run(dispatcher: Path, *keys: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", _SCRIPT, "_", str(dispatcher), *keys],
        capture_output=True,
        text=True,
        timeout=25,
    )


def _calls(log: Path) -> int:
    return len(log.read_text().splitlines()) if log.exists() else 0


def test_single_jq_call_for_many_lookups(
    dispatcher, hooks_config, jq_calls, claude_project_dir
) -> None:
    hooks_config.write({"a": True, "b": False, "c": "true"})
    result = _run(dispatcher, "a", "b", "c", "missing", "a")
    assert result.stdout.strip() == "a=1 b=0 c=1 missing=1 a=1"
    assert _calls(jq_calls) == 1


def test_no_jq_call_when_config_absent(
    dispatcher, hooks_config, jq_calls, claude_project_dir
) -> None:
    result = _run(dispatcher, "a", "b")
    assert result.stdout.strip() == "a=1 b=1"
    assert _calls(jq_calls) == 0


def test_false_and_non_boolean_values(dispatcher, hooks_config, claude_project_dir) -> None:
    hooks_config.write({"off": False, "list": ["x"], "null": None, "empty": ""})
    result = _run(dispatcher, "off", "list", "null", "empty")
    # false と bool 以外は無効。空文字はキーなし扱いでデフォルト（true）
    assert result.stdout.strip() == "off=0 list=0 null=0 empty=1"


def test_parse_failure_warns_and_uses_default(dispatcher, hooks_config, claude_project_dir) -> None:
    hooks_config.path.write_text("{ not json")
    result = _run(dispatcher, "a")
    assert result.stdout.strip() == "a=1"
    assert "パースに失敗" in result.stderr


def test_non_object_json_is_a_parse_failure(dispatcher, hooks_config, claude_project_dir) -> None:
    hooks_config.path.write_text(json.dumps(["a"]))
    result = _run(dispatcher, "a")
    assert result.stdout.strip() == "a=1"
    assert "パースに失敗" in result.stderr


def test_no_associative_arrays_for_bash_3_2(dispatcher) -> None:
    """macOS 標準の bash 3.2 は declare -A / local -A を持たない。使うとキャッシュが空になり誤判定する。"""
    source = dispatcher.read_text()
    assert "declare -A" not in source
    assert "local -A" not in source
    assert "typeset -A" not in source
