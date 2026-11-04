"""tests/cli/test_project_aggregation.py - Phase 6 US4 T057相当。

``pecot project`` の 3 コマンドを CliRunner で検証する。
対象は set-aggregation-repo / unset-aggregation-repo / show-aggregation-repo。

検証観点は次のとおり。
  - 未設定 → set で書き込み
  - 既存値 → 上書き警告 (stderr) + 書き込み / ``--yes`` で警告のみ
  - unset: クリアされる
  - show: 未設定なら "未設定"、設定済みなら値そのもの。
  - 不正形式 "a" は非ゼロ終了 + stderr にエラー

``tmp_path`` 内の一時 JSON ファイルを指すよう、次の関数を patch する。
``save_config`` / ``load_active_config`` / ``get_active_config_path``。
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from cli.commands.main import app
from cli.core.config import ProjectConfig, load_config, save_config

runner = CliRunner()


def _base_config_dict() -> dict:
    return {
        "host": "github.com",
        "owner": "acme-labs",
        "workflow_suffix": "pecot",
        "project": {
            "number": 1,
            "id": "PVT_xxx",
            "fields": {
                "workflow": {
                    "id": "F_workflow",
                    "options": {
                        "backlog": "o1",
                        "active": "o2",
                    },
                }
            },
        },
        "repositories": [],
    }


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    """テスト用設定ファイルを tmp_path に生成して返す。"""
    path = tmp_path / "test_config.json"
    path.write_text(json.dumps(_base_config_dict()), encoding="utf-8")
    return path


@pytest.fixture
def patched_config(config_path: Path):
    """``load_active_config`` / ``get_active_config_path`` が tmp_path を向くように差し替える。"""

    def _load() -> ProjectConfig:
        return load_config(config_path)

    with (
        patch("cli.commands.project.load_active_config", side_effect=_load),
        patch("cli.commands.project.get_active_config_path", return_value=config_path),
    ):
        yield config_path


class TestSetAggregationRepo:
    def test_set_when_unset(self, patched_config: Path) -> None:
        """未設定状態から初回 set で書き込みできる。"""
        result = runner.invoke(app, ["project", "set-aggregation-repo", "acme-labs/aist-roadmap"])
        assert result.exit_code == 0, result.stderr
        assert "acme-labs/aist-roadmap" in result.stdout
        # 永続化確認
        saved = load_config(patched_config)
        assert saved.aggregation_repo == "acme-labs/aist-roadmap"

    def test_overwrite_existing_warns_without_yes(self, patched_config: Path) -> None:
        """既存値がある場合 stderr に警告を出しつつ書き換える。"""
        # 事前に値を仕込む
        cfg = load_config(patched_config)
        cfg.aggregation_repo = "acme-labs/old-repo"
        save_config(cfg, patched_config)

        result = runner.invoke(app, ["project", "set-aggregation-repo", "acme-labs/new-repo"])
        assert result.exit_code == 0
        assert "上書きします" in result.stderr
        assert "acme-labs/old-repo" in result.stderr
        assert "acme-labs/new-repo" in result.stderr
        saved = load_config(patched_config)
        assert saved.aggregation_repo == "acme-labs/new-repo"

    def test_overwrite_with_yes_suppresses_confirm_hint(self, patched_config: Path) -> None:
        """``--yes`` でも警告自体は出す (確認ヒントを出さないだけ)。"""
        cfg = load_config(patched_config)
        cfg.aggregation_repo = "acme-labs/old-repo"
        save_config(cfg, patched_config)

        result = runner.invoke(
            app,
            ["project", "set-aggregation-repo", "acme-labs/new-repo", "--yes"],
        )
        assert result.exit_code == 0
        assert "上書きします" in result.stderr
        assert "--yes を付けてください" not in result.stderr
        saved = load_config(patched_config)
        assert saved.aggregation_repo == "acme-labs/new-repo"

    def test_invalid_format_rejected(self, patched_config: Path) -> None:
        """ "a" のような不正値は非ゼロ終了 + エラー表示。"""
        result = runner.invoke(app, ["project", "set-aggregation-repo", "a"])
        assert result.exit_code != 0
        assert "owner/repo" in result.stderr
        saved = load_config(patched_config)
        assert saved.aggregation_repo is None  # 書き込まれていない

    def test_invalid_extra_segment_rejected(self, patched_config: Path) -> None:
        """3 セグメント形式 "a/b/c" も拒否。"""
        result = runner.invoke(app, ["project", "set-aggregation-repo", "a/b/c"])
        assert result.exit_code != 0
        assert "owner/repo" in result.stderr


class TestUnsetAggregationRepo:
    def test_unset_clears_value(self, patched_config: Path) -> None:
        """設定済みの値を None に戻す。"""
        cfg = load_config(patched_config)
        cfg.aggregation_repo = "acme-labs/aist-roadmap"
        save_config(cfg, patched_config)

        result = runner.invoke(app, ["project", "unset-aggregation-repo"])
        assert result.exit_code == 0
        assert "クリア" in result.stdout
        assert "acme-labs/aist-roadmap" in result.stdout
        saved = load_config(patched_config)
        assert saved.aggregation_repo is None

    def test_unset_when_already_unset(self, patched_config: Path) -> None:
        """未設定なら no-op メッセージのみ。"""
        result = runner.invoke(app, ["project", "unset-aggregation-repo"])
        assert result.exit_code == 0
        assert "未設定" in result.stdout


class TestShowAggregationRepo:
    def test_show_unset(self, patched_config: Path) -> None:
        """未設定時は "未設定" を stdout に出す。"""
        result = runner.invoke(app, ["project", "show-aggregation-repo"])
        assert result.exit_code == 0
        assert result.stdout.strip() == "未設定"

    def test_show_with_value(self, patched_config: Path) -> None:
        """設定済みはそのまま stdout に値を出す。"""
        cfg = load_config(patched_config)
        cfg.aggregation_repo = "acme-labs/aist-roadmap"
        save_config(cfg, patched_config)

        result = runner.invoke(app, ["project", "show-aggregation-repo"])
        assert result.exit_code == 0
        assert result.stdout.strip() == "acme-labs/aist-roadmap"


class TestNoActiveProject:
    def test_set_without_active(self) -> None:
        """アクティブ設定が無ければ set は exit 1。"""
        with patch("cli.commands.project.load_active_config", return_value=None):
            result = runner.invoke(
                app, ["project", "set-aggregation-repo", "acme-labs/aist-roadmap"]
            )
        assert result.exit_code == 1
        assert "アクティブなプロジェクトがありません" in result.stderr

    def test_show_without_active(self) -> None:
        """アクティブ設定が無ければ show も exit 1。"""
        with patch("cli.commands.project.load_active_config", return_value=None):
            result = runner.invoke(app, ["project", "show-aggregation-repo"])
        assert result.exit_code == 1
        assert "アクティブなプロジェクトがありません" in result.stderr
