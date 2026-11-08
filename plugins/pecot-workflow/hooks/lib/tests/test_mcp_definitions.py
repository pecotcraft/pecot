"""pecot-workflow の .mcp.json にある playwright の MCP サーバの起動定義を確かめる（#139）。"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

SERVER = "pecot-workflow-playwright"
PREFIX = "--prefix=${CLAUDE_PLUGIN_ROOT}/bin"


@pytest.fixture
def plugin_root(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow"


@pytest.fixture
def server(plugin_root: Path) -> dict:
    return json.loads((plugin_root / ".mcp.json").read_text())["mcpServers"][SERVER]


def test_playwright_runs_via_npx(server: dict) -> None:
    assert server["command"] == "npx"
    assert "env" not in server


def test_prefix_points_to_bin_without_package_json(server: dict, plugin_root: Path) -> None:
    # npm は cwd から上へたどった package.json の devEngines が npm 以外だと npx を止める。package.json の無い bin/ を prefix にして避ける。
    assert server["args"][0] == PREFIX
    assert (plugin_root / "bin").is_dir()
    assert not (plugin_root / "bin" / "package.json").exists()


def test_package_version_is_pinned(server: dict) -> None:
    spec = next(arg for arg in server["args"] if not arg.startswith("-"))
    assert re.fullmatch(r"(@[^/@]+/)?[^/@]+@\d+\.\d+\.\d+", spec), spec


def test_args_match_pecot_visual(server: dict, project_root: Path) -> None:
    visual = json.loads((project_root / "plugins" / "pecot-visual" / ".mcp.json").read_text())
    assert server["args"] == visual["mcpServers"]["pecot-visual-playwright"]["args"]
