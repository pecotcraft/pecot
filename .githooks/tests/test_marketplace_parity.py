"""Claude Code 用と Copilot CLI 用の marketplace.json が一致することの確認。

Copilot の更新案内（plugin-update-notice.sh）は、Copilot キャッシュの marketplace.json の name を見る。
導入先の名前と違うと、案内は何も出さずに止まる。
"""

from __future__ import annotations

import json
from pathlib import Path

import allure
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


@allure.title("Claude Code 用と Copilot CLI 用の marketplace.json は、name が pecot で一致する")
def test_name_matches(manifests) -> None:
    """`.claude-plugin/marketplace.json` と `.github/plugin/marketplace.json` の `name` のテストです。どちらも `pecot` で、2 つが一致していることを確認します。"""
    with allure.step("Claude 用と Copilot 用の marketplace.json を取り出す"):
        claude, copilot = manifests

    with allure.step("name が一致し、pecot であることを確かめる"):
        assert claude["name"] == copilot["name"] == "pecot"


@allure.title("Claude Code 用と Copilot CLI 用の marketplace.json は、owner が一致する")
def test_owner_matches(manifests) -> None:
    """`.claude-plugin/marketplace.json` と `.github/plugin/marketplace.json` の `owner` のテストです。2 つが一致し、`owner.name` が `pecot` であることを確認します。"""
    with allure.step("Claude 用と Copilot 用の marketplace.json を取り出す"):
        claude, copilot = manifests

    with allure.step("owner が一致し、pecot であることを確かめる"):
        assert claude["owner"] == copilot["owner"]
        assert claude["owner"]["name"] == "pecot"


@allure.title("Claude Code 用と Copilot CLI 用の marketplace.json は、plugins が一致する")
def test_plugins_match(manifests) -> None:
    """`.claude-plugin/marketplace.json` と `.github/plugin/marketplace.json` の `plugins` のテストです。2 つが一致し、プラグイン名が `pecot-w`・`pecot-v`・`pecot-t` の順であることを確認します。"""
    with allure.step("Claude 用と Copilot 用の marketplace.json を取り出す"):
        claude, copilot = manifests

    with allure.step("plugins が一致し、3 つのプラグインが並ぶことを確かめる"):
        assert claude["plugins"] == copilot["plugins"]
        assert [p["name"] for p in claude["plugins"]] == ["pecot-w", "pecot-v", "pecot-t"]
