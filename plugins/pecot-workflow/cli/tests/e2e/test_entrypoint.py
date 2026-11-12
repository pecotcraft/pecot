"""tests/e2e/test_entrypoint.py - CLIエントリポイントの統合テスト

pyproject.toml の [project.scripts] で定義された
エントリポイント `pecot` が正しく動作することを確認。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

# プロジェクトルート（pyproject.tomlがある場所）= plugins/pecot-workflow/cli/。
# 階層: plugins/pecot-workflow/cli/tests/e2e/test_entrypoint.py。
#       parents[0]=e2e / [1]=tests / [2]=cli / [3]=plugins/pecot-workflow。
PROJECT_ROOT = Path(__file__).parents[2]


@pytest.fixture
def uv_command() -> str:
    """uvコマンドのパスを取得"""
    uv_path = shutil.which("uv")
    if not uv_path:
        pytest.skip("uv command not found")
    return uv_path


class TestCLIEntrypoint:
    """CLIエントリポイントの統合テスト

    実際に `uv run pecot` コマンドを実行して動作確認する。
    """

    def test_entrypoint_version(self, uv_command: str, tmp_path: Path) -> None:
        """uv run pecot --version が動作する。

        CLAUDE_PLUGIN_ROOT を存在しない tmpdir へ向けると、手順 1（env）が miss する。
        手順 2（__file__ 相対）が実際の plugin.json を返すか、両方 miss で 0.0.0+dev になる。
        どちらの場合も "pecot version" が stdout に含まれることを確認する。
        """
        # 空ディレクトリを CLAUDE_PLUGIN_ROOT に設定 → 手順 1（env）は miss
        env = {
            **{k: v for k, v in os.environ.items() if k != "CLAUDE_PLUGIN_ROOT"},
            "CLAUDE_PLUGIN_ROOT": str(tmp_path),
        }
        result = subprocess.run(
            [uv_command, "run", "pecot", "--version"],
            capture_output=True,
            text=True,
            cwd=PROJECT_ROOT,
            env=env,
            timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert "pecot version" in result.stdout

    def test_version_from_claude_plugin_root(self, uv_command: str, tmp_path: Path) -> None:
        """CLAUDE_PLUGIN_ROOT の plugin.json の version が --version に出る"""
        plugin_dir = tmp_path / ".claude-plugin"
        plugin_dir.mkdir()
        (plugin_dir / "plugin.json").write_text(json.dumps({"name": "pecot-w", "version": "9.9.9"}))
        env = {**os.environ, "CLAUDE_PLUGIN_ROOT": str(tmp_path)}
        result = subprocess.run(
            [uv_command, "run", "pecot", "--version"],
            capture_output=True,
            text=True,
            cwd=PROJECT_ROOT,
            env=env,
            timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert "9.9.9" in result.stdout

    def test_entrypoint_help(self, uv_command: str) -> None:
        """uv run pecot --help が動作する"""
        result = subprocess.run(
            [uv_command, "run", "pecot", "--help"],
            capture_output=True,
            text=True,
            cwd=PROJECT_ROOT,
            timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert "pecot-workflow CLI" in result.stdout

    def test_entrypoint_no_args_shows_help(self, uv_command: str) -> None:
        """uv run pecot（引数なし）でヘルプが表示される"""
        result = subprocess.run(
            [uv_command, "run", "pecot"],
            capture_output=True,
            text=True,
            cwd=PROJECT_ROOT,
            timeout=30,
        )
        # no_args_is_help=True の場合、Typer は exit_code=2 でヘルプを表示
        assert result.returncode == 2
        assert "Usage:" in result.stdout

    def test_venv_entrypoint_reads_version_from_plugin_root(self, tmp_path: Path) -> None:
        """cli/.venv/bin/pecot を直接起動し、CLAUDE_PLUGIN_ROOT の plugin.json の version が出る。

        前提: 実リポの cli/.venv が同期済み（``uv run pytest`` で作られる）。
        """
        pecot = PROJECT_ROOT / ".venv" / "bin" / "pecot"
        assert pecot.is_file(), (
            "cli/.venv/bin/pecot が無い。cli で `uv sync` を実行して venv を作ること"
        )
        (tmp_path / ".claude-plugin").mkdir()
        (tmp_path / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "pecot-w", "version": "9.8.7"})
        )

        result = subprocess.run(
            [str(pecot), "--version"],
            capture_output=True,
            text=True,
            env={**os.environ, "CLAUDE_PLUGIN_ROOT": str(tmp_path)},
            timeout=60,
        )

        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert result.stdout.strip() == "pecot version 9.8.7"

    def test_venv_entrypoint_prepares_template(self, tmp_path: Path) -> None:
        """cli/.venv/bin/pecot を直接起動し、テンプレートを読むコマンドが動く。"""
        pecot = PROJECT_ROOT / ".venv" / "bin" / "pecot"
        assert pecot.is_file(), (
            "cli/.venv/bin/pecot が無い。cli で `uv sync` を実行して venv を作ること"
        )
        project_dir = tmp_path / "project"
        project_dir.mkdir()

        result = subprocess.run(
            [str(pecot), "issue", "create", "--prepare", "--template", "epic"],
            capture_output=True,
            text=True,
            env={**os.environ, "CLAUDE_PROJECT_DIR": str(project_dir)},
            timeout=60,
        )

        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert Path(result.stdout.strip()).is_file()

    def test_entrypoint_propagates_claude_project_dir(self, uv_command: str) -> None:
        """conftest autouse の CLAUDE_PROJECT_DIR が子プロセスに伝搬している"""
        fake_root = os.environ["CLAUDE_PROJECT_DIR"]
        result = subprocess.run(
            [
                uv_command,
                "run",
                "python",
                "-c",
                "from cli.core.paths import get_project_root; print(get_project_root())",
            ],
            capture_output=True,
            text=True,
            cwd=PROJECT_ROOT,
            timeout=30,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert Path(result.stdout.strip()) == Path(fake_root), (
            f"子プロセスが CLAUDE_PROJECT_DIR を受け取っていない: "
            f"expected={repr(fake_root)}, stdout={repr(result.stdout)}"
        )
