"""Claude Code 用と Copilot CLI 用の marketplace.json が一致することの確認。

Copilot の更新案内（plugin-update-notice.sh）は、Copilot キャッシュの marketplace.json の name を見る。
導入先の名前と違うと、案内は何も出さずに止まる。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

_CLAUDE = ".claude-plugin/marketplace.json"
_COPILOT = ".github/plugin/marketplace.json"


@pytest.fixture
def manifests(script_dir: Path) -> tuple[dict, dict]:
    root = script_dir.parents[1]
    return (
        json.loads((root / _CLAUDE).read_text()),
        json.loads((root / _COPILOT).read_text()),
    )


def test_name_matches(manifests) -> None:
    claude, copilot = manifests
    assert claude["name"] == copilot["name"] == "pecot"


def test_owner_matches(manifests) -> None:
    claude, copilot = manifests
    assert claude["owner"] == copilot["owner"]
    assert claude["owner"]["name"] == "pecot"


def test_plugins_match(manifests) -> None:
    claude, copilot = manifests
    assert claude["plugins"] == copilot["plugins"]
    assert [p["name"] for p in claude["plugins"]] == ["pecot-w", "pecot-v", "pecot-t"]
