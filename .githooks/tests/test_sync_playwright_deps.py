"""sync-playwright-deps.mjs のテスト (#274)。"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

# parents[0]=tests, [1]=.githooks, [2]=リポルート。
_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = ".githooks/scripts/sync-playwright-deps.mjs"

_CONFIG = """{
  "features": {
    // 残す。
    "./features/playwright-deps": { "version": "%s" }
  }
}
"""


def _lock(*versions: str) -> str:
    # 同じ版は packages と snapshots に 2 回出る。
    parts = []
    for section in ("packages", "snapshots"):
        parts.append(f"{section}:\n")
        parts += [f"  playwright@{v}:\n    resolution: x\n" for v in versions]
    return "\n".join(parts)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    (tmp_path / ".githooks/scripts").mkdir(parents=True)
    shutil.copy(_REPO_ROOT / _SCRIPT, tmp_path / _SCRIPT)
    (tmp_path / ".devcontainer").mkdir()
    return tmp_path


def _setup(repo: Path, lock: str, config: str) -> Path:
    (repo / "pnpm-lock.yaml").write_text(lock, encoding="utf-8")
    path = repo / ".devcontainer/devcontainer.json"
    path.write_text(config, encoding="utf-8")
    return path


def _run(repo: Path) -> subprocess.CompletedProcess[str]:
    return run_attached(["node", _SCRIPT], cwd=repo, capture_output=True, text=True, check=False)


@allure.title("lock の版が設定と違うと、版だけを書き換えてコメントを残す")
def test_rewrites_only_the_version_and_keeps_comments(repo: Path) -> None:
    """`pnpm-lock.yaml` の playwright の版が `devcontainer.json` と異なる場合のテストです。スクリプトが終了コード 0 で終了し、版だけが新しい値になり、コメントを含むほかの部分が変わらないことを確認します。"""
    with allure.step("lock と設定を置き、sync-playwright-deps.mjs を動かす"):
        path = _setup(repo, _lock("1.65.0"), _CONFIG % "1.64.1")
        result = _run(repo)
    with allure.step("版だけが書き換わり、コメントが残ることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert read_output(path) == _CONFIG % "1.65.0"


@allure.title("lock の版が設定と同じなら、ファイルを書き込まない")
def test_same_version_is_not_written(repo: Path) -> None:
    """`pnpm-lock.yaml` と `devcontainer.json` の playwright の版が同じ場合のテストです。ファイルの内容と更新時刻が変わらないことを確認します。"""
    with allure.step("同じ版の lock と設定を置き、sync-playwright-deps.mjs を動かす"):
        path = _setup(repo, _lock("1.65.0"), _CONFIG % "1.65.0")
        before = path.stat().st_mtime_ns
        result = _run(repo)
    with allure.step("ファイルを書き換えていないことを確かめる"):
        assert result.returncode == 0, result.stderr
        assert read_output(path) == _CONFIG % "1.65.0"
        assert path.stat().st_mtime_ns == before


@allure.title("lock の playwright の版が {versions} のとき、エラーで止まり設定を変更しない")
@pytest.mark.parametrize("versions", [[], ["1.64.1", "1.65.0"]])
def test_lock_without_exactly_one_version_stops(repo: Path, versions: list[str]) -> None:
    """`pnpm-lock.yaml` の playwright の版が 0 個または 2 個以上の場合のテストです。終了コードが 1 になり、標準エラー出力に「1 版でない」と表示され、`devcontainer.json` が変更されないことを確認します。"""
    with allure.step("版が 1 つでない lock を置き、sync-playwright-deps.mjs を動かす"):
        path = _setup(repo, _lock(*versions), _CONFIG % "1.64.1")
        result = _run(repo)
    with allure.step("終了コード 1 で止まり、設定が変わらないことを確かめる"):
        assert result.returncode == 1
        assert "1 版でない" in result.stderr
        assert read_output(path) == _CONFIG % "1.64.1"


@allure.title("設定に playwright-deps の feature が存在しないと、エラーで止まる")
def test_config_without_the_feature_stops(repo: Path) -> None:
    """`devcontainer.json` に `playwright-deps` の feature が存在しない場合のテストです。終了コードが 1 になり、標準エラー出力に `playwright-deps` が表示されることを確認します。"""
    with allure.step("feature の無い設定を置き、sync-playwright-deps.mjs を動かす"):
        _setup(repo, _lock("1.65.0"), '{ "features": {} }\n')
        result = _run(repo)
    with allure.step("終了コード 1 で止まり、playwright-deps が stderr に出ることを確かめる"):
        assert result.returncode == 1
        assert "playwright-deps" in result.stderr


@allure.title("lock に playwright-core などの行が存在しても、版として数えない")
def test_lock_ignores_other_playwright_packages(repo: Path) -> None:
    """`pnpm-lock.yaml` に `playwright-core` と `@playwright/test` の行が含まれる場合のテストです。それらを版として数えず、`playwright` の版だけで `devcontainer.json` が更新されることを確認します。"""
    with allure.step(
        "別の playwright 系の行を足した lock を置き、sync-playwright-deps.mjs を動かす"
    ):
        # playwright-core と @playwright/test の行は版に数えない。
        lock = _lock("1.65.0") + "  playwright-core@1.70.0:\n  '@playwright/test@1.71.0':\n"
        path = _setup(repo, lock, _CONFIG % "1.64.1")
        result = _run(repo)
    with allure.step("playwright の行だけから版が決まることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert read_output(path) == _CONFIG % "1.65.0"


@allure.title("pnpm-lock.yaml が存在しないと、1 行のメッセージで止まる")
def test_missing_lock_stops_with_one_line_message(repo: Path) -> None:
    """`pnpm-lock.yaml` が存在しない場合のテストです。終了コードが 1 になり、標準エラー出力が 1 行で、「pnpm-lock.yaml を読めない」と表示されることを確認します。"""
    with allure.step("lock の無いリポで sync-playwright-deps.mjs を動かす"):
        (repo / ".devcontainer/devcontainer.json").write_text(_CONFIG % "1.64.1", encoding="utf-8")
        result = _run(repo)
    with allure.step("終了コード 1 で止まり、1 行のメッセージが出ることを確かめる"):
        assert result.returncode == 1
        assert result.stderr.strip().count("\n") == 0
        assert "pnpm-lock.yaml を読めない" in result.stderr
