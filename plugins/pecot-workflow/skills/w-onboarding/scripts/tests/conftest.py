"""conftest.py - w-onboarding/scripts/tests/ 共通フィクスチャ

open_browser.sh 等のスクリプトテストが共有するフィクスチャを定義する。
bats 時代の test_helper/common_setup.bash 相当（SCRIPTS_DIR 解決・mock コマンド
配置）を提供する。GIT_* 一括 delenv は不要（このテストは git 操作をしない）。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

# このファイルは plugins/pecot-workflow/skills/w-onboarding/scripts/tests/conftest.py に置かれる。
# parents[0]=tests, [1]=scripts。


@pytest.fixture(scope="session")
def scripts_dir() -> Path:
    """w-onboarding/scripts/（テスト対象スクリプトの親）。"""
    return Path(__file__).resolve().parents[1]


class _MockBin:
    """PATH 先頭に挿入した mock-bin ディレクトリへ実行可能スクリプトを配置する。"""

    def __init__(self, bin_dir: Path) -> None:
        self.bin_dir = bin_dir

    def install(self, name: str, script_body: str) -> Path:
        target = self.bin_dir / name
        body = script_body if script_body.startswith("#!") else f"#!/bin/bash\n{script_body}"
        target.write_text(body)
        target.chmod(0o755)
        return target


@pytest.fixture
def mock_bin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> _MockBin:
    """tmp/mock-bin を PATH 先頭に挿入し install() でモックコマンドを置く。"""
    bin_dir = tmp_path / "mock-bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    return _MockBin(bin_dir)
