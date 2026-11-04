"""tests/core/test_init.py - cli.__init__ の _read_version() ユニットテスト"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

import cli


def _make_plugin_json(tmp_path: Path, version: object) -> Path:
    """tmp_path 配下に .claude-plugin/plugin.json を作成して tmp_path を返す。"""
    plugin_dir = tmp_path / ".claude-plugin"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "plugin.json").write_text(json.dumps({"name": "pecot-w", "version": version}))
    return tmp_path


class TestReadVersion:
    """_read_version() の 3 段 fallback テスト。

    手順 2 (source 相対) は実際の worktree に plugin.json が存在する。
    手順 2 からの読み込みを防ぐためにパッチを当て、手順 1 / 手順 3 を分離テストする。
    """

    # 手順 1: CLAUDE_PLUGIN_ROOT env

    def test_env_with_valid_plugin_json(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """CLAUDE_PLUGIN_ROOT 設定 + plugin.json 在り → version を返す"""
        _make_plugin_json(tmp_path, "9.9.9")
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(tmp_path))
        result = cli._read_version()
        assert result == "9.9.9"

    def test_env_with_missing_plugin_json(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """CLAUDE_PLUGIN_ROOT 設定 + plugin.json 不在 → 手順 2 へ fallback（またはそれも失敗で dev）"""
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(tmp_path))
        # 手順 2 もモックして「不在」にすると最終的に 0.0.0+dev になる
        with patch.object(cli, "_load_version_from_plugin_json", return_value=None):
            result = cli._read_version()
        assert result == "0.0.0+dev"

    def test_env_with_invalid_json(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """CLAUDE_PLUGIN_ROOT 設定 + JSON 不正 → "0.0.0+dev" """
        plugin_dir = tmp_path / ".claude-plugin"
        plugin_dir.mkdir()
        (plugin_dir / "plugin.json").write_text("NOT JSON {{{")
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(tmp_path))
        with patch.object(cli, "_load_version_from_plugin_json", side_effect=[None, None]):
            result = cli._read_version()
        assert result == "0.0.0+dev"

    def test_env_with_numeric_version(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """plugin.json の version が数値 → "0.0.0+dev" """
        _make_plugin_json(tmp_path, 123)
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(tmp_path))
        # _load_version_from_plugin_json は数値 version を None で返す（実装検証）
        result = cli._load_version_from_plugin_json(tmp_path / ".claude-plugin" / "plugin.json")
        assert result is None

    # 手順 3: 全手順失敗 → "0.0.0+dev"

    def test_no_env_returns_dev(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """env 未設定 + 全 plugin.json 不在 → "0.0.0+dev" """
        monkeypatch.delenv("CLAUDE_PLUGIN_ROOT", raising=False)
        with patch.object(cli, "_load_version_from_plugin_json", return_value=None):
            result = cli._read_version()
        assert result == "0.0.0+dev"

    def test_env_empty_string_skips_env_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """CLAUDE_PLUGIN_ROOT が空文字列 → 手順 1 をスキップ → 手順 2 も None → dev"""
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", "")
        with patch.object(cli, "_load_version_from_plugin_json", return_value=None):
            result = cli._read_version()
        assert result == "0.0.0+dev"

    def test_env_whitespace_only_skips_env_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """CLAUDE_PLUGIN_ROOT が空白のみ → 手順 1 をスキップ（F-02 対称）"""
        monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", "   ")
        with patch.object(cli, "_load_version_from_plugin_json", return_value=None):
            result = cli._read_version()
        assert result == "0.0.0+dev"

    # _load_version_from_plugin_json 単体検証

    def test_load_version_from_valid_json(self, tmp_path: Path) -> None:
        """正常な plugin.json から version 文字列を返す"""
        _make_plugin_json(tmp_path, "2.3.4")
        result = cli._load_version_from_plugin_json(tmp_path / ".claude-plugin" / "plugin.json")
        assert result == "2.3.4"

    def test_load_version_from_invalid_json_returns_none(self, tmp_path: Path) -> None:
        """JSON 不正 → None"""
        p = tmp_path / "bad.json"
        p.write_text("NOT JSON {{{")
        assert cli._load_version_from_plugin_json(p) is None

    def test_load_version_missing_file_returns_none(self, tmp_path: Path) -> None:
        """存在しないファイル → None"""
        assert cli._load_version_from_plugin_json(tmp_path / "no.json") is None

    def test_load_version_non_dict_returns_none(self, tmp_path: Path) -> None:
        """JSON が dict でない → None"""
        p = tmp_path / "arr.json"
        p.write_text("[1, 2, 3]")
        assert cli._load_version_from_plugin_json(p) is None
