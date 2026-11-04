"""open_browser.sh のユニットテスト（test_open_browser.bats 移植）。

OS 判定（WSL / macOS / Linux）と、ブラウザコマンド不在時のエラー挙動を検証する。
mock コマンド配置は conftest の mock_bin fixture を消費する。
"""

from __future__ import annotations

import os
import platform
import subprocess
from pathlib import Path

import pytest

_MOCK = '#!/bin/bash\necho "mock: {name} $*"\n'


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


def _run(scripts_dir: Path, *args: str, env: dict | None = None):
    kwargs: dict = {}
    if env is not None:
        kwargs["env"] = env
    return subprocess.run(
        ["bash", str(scripts_dir / "open_browser.sh"), *args],
        capture_output=True,
        text=True,
        timeout=25,
        **kwargs,
    )


# 引数バリデーション


def test_no_arg_errors(scripts_dir: Path) -> None:
    """引数なしでエラー終了。"""
    result = _run(scripts_dir)
    assert result.returncode != 0


# WSL 環境


def test_wsl_calls_powershell(scripts_dir: Path, mock_bin) -> None:
    """WSL: powershell.exe を呼ぶ。"""
    # /proc/version を偽装できないため、grep -qi microsoft が真の環境でのみ実行。
    if not _is_wsl():
        pytest.skip("WSL環境でのみ実行")

    mock_bin.install("powershell.exe", _MOCK.format(name="powershell.exe"))

    result = _run(scripts_dir, "https://example.com")
    assert result.returncode == 0
    assert "mock: powershell.exe" in result.stdout
    assert "https://example.com" in result.stdout


# macOS 環境


def test_macos_calls_open(scripts_dir: Path, mock_bin) -> None:
    """macOS: open を呼ぶ。"""
    if _is_wsl():
        pytest.skip("WSL環境ではWSL分岐が優先される")
    if platform.system() != "Darwin":
        pytest.skip("macOS環境でのみ実行")

    mock_bin.install("open", _MOCK.format(name="open"))

    result = _run(scripts_dir, "https://example.com")
    assert result.returncode == 0
    assert "mock: open" in result.stdout
    assert "https://example.com" in result.stdout


# Linux 環境 (xdg-open あり)


def test_linux_calls_xdg_open(scripts_dir: Path, mock_bin) -> None:
    """Linux: xdg-open を呼ぶ。"""
    if _is_wsl():
        pytest.skip("WSL環境ではWSL分岐が優先される")
    if platform.system() == "Darwin":
        pytest.skip("macOS環境ではmacOS分岐が優先される")

    mock_bin.install("xdg-open", _MOCK.format(name="xdg-open"))

    result = _run(scripts_dir, "https://example.com")
    assert result.returncode == 0
    assert "mock: xdg-open" in result.stdout
    assert "https://example.com" in result.stdout


# ブラウザコマンドなし


def test_no_browser_command_errors(scripts_dir: Path, mock_bin) -> None:
    """ブラウザコマンドなし: エラー終了し URL を表示。"""
    if _is_wsl():
        pytest.skip("WSL環境ではWSL分岐が優先される")
    if platform.system() == "Darwin":
        pytest.skip("macOS環境ではmacOS分岐が優先される")

    # xdg-open を PATH から除外（基本コマンドはシンボリックリンクで確保）。
    bin_dir = mock_bin.bin_dir
    for cmd in (
        "bash",
        "grep",
        "uname",
        "cat",
        "echo",
        "printf",
        "sed",
        "awk",
        "rm",
        "mkdir",
        "chmod",
        "ln",
        "ls",
    ):
        import shutil

        real = shutil.which(cmd)
        if real:
            link = bin_dir / cmd
            if not link.exists():
                link.symlink_to(real)

    env = {**os.environ, "PATH": str(bin_dir)}
    result = _run(scripts_dir, "https://example.com", env=env)
    assert result.returncode == 1
    assert "https://example.com" in (result.stdout + result.stderr)
