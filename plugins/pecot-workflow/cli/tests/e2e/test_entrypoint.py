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

    def test_bin_pecot_wrapper_skip_launches_local_cli(self, tmp_path: Path) -> None:
        """bin/pecot wrapper が PECOT_BOOTSTRAP_SKIP=1 で本体ツリーの cli/.venv を直接起動できる。

        tmp_path に隔離した wrapper ツリーを組む（bin/pecot・bin/_lib.sh・plugin.json はコピー、
        cli/ は実体への symlink）。
        SKIP=1 の wrapper は ``<PLUGIN_ROOT>/cli/.venv/bin/pecot`` を実行する。
        このとき CLAUDE_PLUGIN_ROOT を export する（cli のバージョン解決が手順 1 に乗る）。
        データ置き場は使わない。
        前提: 実リポの cli/.venv が同期済み（``uv run pytest`` で作られる）。
        データ置き場の venv を作る処理は hooks/lib/tests/test_bin_pecot_wrapper.py（stub uv）が検証する。
        """
        # plugins/pecot-workflow/ が PLUGIN_ROOT。PROJECT_ROOT は plugins/pecot-workflow/cli/ なので親。
        real_plugin_root = PROJECT_ROOT.parent
        plugin_root = tmp_path / "plugin-root"
        (plugin_root / "bin").mkdir(parents=True)
        for name in ("pecot", "_lib.sh"):
            shutil.copy2(real_plugin_root / "bin" / name, plugin_root / "bin" / name)
        (plugin_root / ".claude-plugin").mkdir()
        (plugin_root / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": "pecot-w", "version": "9.8.7"})
        )
        (plugin_root / "cli").symlink_to(PROJECT_ROOT, target_is_directory=True)

        result = subprocess.run(
            [str(plugin_root / "bin" / "pecot"), "--version"],
            capture_output=True,
            text=True,
            env={
                **{k: v for k, v in os.environ.items() if k != "CLAUDE_PLUGIN_ROOT"},
                "PECOT_BOOTSTRAP_SKIP": "1",
            },
            timeout=60,
        )

        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert result.stdout.strip() == "pecot version 9.8.7"

    @pytest.mark.timeout(240)
    def test_bin_pecot_installs_non_editable_venv_into_data_dir(self, tmp_path: Path) -> None:
        """実 uv で、データ置き場の非 editable な venv から pecot CLI が起動する（#1230）。

        - ``--version`` が plugin.json のバージョンを返す。
        - plugin.json だけを上げた更新は、building / installing の行が 0 のまま新バージョンを返す。
        - templates を読むコマンドが、site-packages 内のパッケージから動く
        - プラグインルートには何も書かない

        uv のキャッシュとネットワークの両方が無い環境（venv を作れない）では skip する。
        """
        if not shutil.which("uv"):
            pytest.skip("uv command not found in PATH")
        real_plugin_root = PROJECT_ROOT.parent
        plugin_root = tmp_path / "plugin-root"
        (plugin_root / "bin").mkdir(parents=True)
        for name in ("pecot", "_lib.sh"):
            shutil.copy2(real_plugin_root / "bin" / name, plugin_root / "bin" / name)
        shutil.copytree(
            PROJECT_ROOT,
            plugin_root / "cli",
            ignore=shutil.ignore_patterns(".venv", "__pycache__", "*.egg-info", "build"),
        )
        manifest = plugin_root / ".claude-plugin" / "plugin.json"
        manifest.parent.mkdir()
        manifest.write_text(json.dumps({"name": "pecot-w", "version": "1.0.0"}))
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        env = {
            **{k: v for k, v in os.environ.items() if k != "CLAUDE_PLUGIN_ROOT"},
            "CLAUDE_PLUGIN_DATA": str(data_dir),
            "CLAUDE_PROJECT_DIR": str(project_dir),
        }
        wrapper = str(plugin_root / "bin" / "pecot")

        def run(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [wrapper, *args], capture_output=True, text=True, env=env, timeout=200, check=False
            )

        before = sorted(p.relative_to(plugin_root) for p in plugin_root.rglob("*"))
        first = run("--version")
        if first.returncode != 0 and "venv の作成に失敗" in first.stderr:
            pytest.skip(
                f"uv で venv を作れない環境（キャッシュ・ネットワークなし）: {first.stderr}"
            )
        assert first.returncode == 0, first.stderr
        assert first.stdout.strip() == "pecot version 1.0.0"
        assert "pecot: building" in first.stderr

        manifest.write_text(json.dumps({"name": "pecot-w", "version": "2.0.0"}))
        second = run("--version")
        assert second.returncode == 0, second.stderr
        assert second.stdout.strip() == "pecot version 2.0.0"
        assert "pecot: building" not in second.stderr
        assert "pecot: installing dependencies" not in second.stderr

        template = run("issue", "create", "--prepare", "--template", "epic")
        assert template.returncode == 0, template.stderr
        assert Path(template.stdout.strip()).is_file()
        assert (
            str(data_dir)
            in subprocess.run(
                ["readlink", "-f", str(data_dir / "venv" / "current")],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )
        assert sorted(p.relative_to(plugin_root) for p in plugin_root.rglob("*")) == before

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
