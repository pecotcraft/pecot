"""lock と pyproject.toml が食い違うとき run-tests.sh / run-lint.sh が落ちることを確認する。

plugin の cli/ と scripts/ci/ を一時ディレクトリへコピーして依存を 1 件削除し（lock が古くなる）、
コピー先のスクリプトを実行する。
- uv は食い違いを再解決で判定するため index への接続が要る。
  run-tests.sh の pass1 / pass2 の両方で実行され、pass2 は空の uv cache なので毎回 index に問い合わせる。
  オフラインや proxy 必須の環境では、食い違いと別の理由で落ちる。
  その場合は接続の問題と分かるメッセージを出す。
- uv の英語のエラーメッセージに依存する（uv のバージョンを上げて文言が変わったらここを直す）。
- コピーに tests/ を含めないので、コピー先の run-tests.sh が自分を含むテストを実行することはない。
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
from pathlib import Path

import pytest
import tomllib

CLI_ROOT = Path(__file__).resolve().parents[2]
CI_SCRIPTS = CLI_ROOT.parent / "scripts" / "ci"

LOCKED_MISMATCH_MESSAGE = "needs to be updated, but `--locked` was provided"
CONNECTION_FAILURE_MARKERS = (
    "No solution found",
    "error sending request",
    "Failed to fetch",
    "Connection refused",
    "dns error",
)
TIMEOUT_SECONDS = 300


def _copy_plugin(dest: Path) -> Path:
    plugin = dest / "plugins" / "pecot-workflow"
    shutil.copytree(
        CLI_ROOT,
        plugin / "cli",
        ignore=shutil.ignore_patterns(".venv", "__pycache__", "*.egg-info", "tests"),
    )
    shutil.copytree(CI_SCRIPTS, plugin / "scripts" / "ci")
    return plugin


def _drop_first_dependency(pyproject: Path) -> str:
    """project.dependencies の先頭 1 件を、その行ごと pyproject.toml から取り除く。"""
    text = pyproject.read_text()
    dependencies = tomllib.loads(text)["project"]["dependencies"]
    assert dependencies, (
        "cli/pyproject.toml の project.dependencies が空で、削除する依存がありません"
    )
    target = dependencies[0]
    lines = text.splitlines(keepends=True)
    matching = [i for i, line in enumerate(lines) if line.strip().rstrip(",") == f'"{target}"']
    assert len(matching) == 1, (
        f"依存 {repr(target)} を 1 行で記述した行が見つかりません"
        f"（複数行・複数依存の同一行記述に変わった場合はこのテストの削除処理を直してください）"
    )
    del lines[matching[0]]
    pyproject.write_text("".join(lines))
    return target


def _run_in_new_session(command: list[str], env: dict[str, str]) -> tuple[int, str]:
    # timeout 時に孫の uv sync まで残さないよう、プロセスグループごと kill する
    with subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        start_new_session=True,
    ) as proc:
        try:
            output, _ = proc.communicate(timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            pytest.fail(f"{TIMEOUT_SECONDS} 秒で終わりませんでした: {command}")
        return proc.returncode, output


@pytest.mark.timeout(TIMEOUT_SECONDS + 30)
@pytest.mark.parametrize("script", ["run-tests.sh", "run-lint.sh"])
def test_script_fails_when_lock_is_stale(tmp_path: Path, script: str) -> None:
    plugin = _copy_plugin(tmp_path)
    _drop_first_dependency(plugin / "cli" / "pyproject.toml")

    env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
    returncode, raw_output = _run_in_new_session(
        ["bash", str(plugin / "scripts" / "ci" / script), "--scope=py"], env
    )

    assert returncode != 0
    # uv はエラーを端末幅で折り返す（nx 経由の実行では行の途中に改行と字下げが入る）ため、
    # 空白を 1 つにそろえてから比較する
    output = " ".join(raw_output.split())
    if LOCKED_MISMATCH_MESSAGE not in output and any(
        m in output for m in CONNECTION_FAILURE_MARKERS
    ):
        pytest.fail(
            f"uv が index に接続できず、lock の食い違いを判定できませんでした:\n{raw_output}"
        )
    assert LOCKED_MISMATCH_MESSAGE in output, raw_output
