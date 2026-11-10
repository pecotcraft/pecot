"""sync-playwright-deps.mjs のテスト (#274)。"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

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
    return subprocess.run(["node", _SCRIPT], cwd=repo, capture_output=True, text=True, check=False)


def test_rewrites_only_the_version_and_keeps_comments(repo: Path) -> None:
    path = _setup(repo, _lock("1.65.0"), _CONFIG % "1.64.1")
    result = _run(repo)
    assert result.returncode == 0, result.stderr
    assert path.read_text(encoding="utf-8") == _CONFIG % "1.65.0"


def test_same_version_is_not_written(repo: Path) -> None:
    path = _setup(repo, _lock("1.65.0"), _CONFIG % "1.65.0")
    before = path.stat().st_mtime_ns
    result = _run(repo)
    assert result.returncode == 0, result.stderr
    assert path.read_text(encoding="utf-8") == _CONFIG % "1.65.0"
    assert path.stat().st_mtime_ns == before


@pytest.mark.parametrize("versions", [[], ["1.64.1", "1.65.0"]])
def test_lock_without_exactly_one_version_stops(repo: Path, versions: list[str]) -> None:
    path = _setup(repo, _lock(*versions), _CONFIG % "1.64.1")
    result = _run(repo)
    assert result.returncode == 1
    assert "1 版でない" in result.stderr
    assert path.read_text(encoding="utf-8") == _CONFIG % "1.64.1"


def test_config_without_the_feature_stops(repo: Path) -> None:
    _setup(repo, _lock("1.65.0"), '{ "features": {} }\n')
    result = _run(repo)
    assert result.returncode == 1
    assert "playwright-deps" in result.stderr


def test_lock_ignores_other_playwright_packages(repo: Path) -> None:
    # playwright-core と @playwright/test の行は版に数えない。
    lock = _lock("1.65.0") + "  playwright-core@1.70.0:\n  '@playwright/test@1.71.0':\n"
    path = _setup(repo, lock, _CONFIG % "1.64.1")
    result = _run(repo)
    assert result.returncode == 0, result.stderr
    assert path.read_text(encoding="utf-8") == _CONFIG % "1.65.0"


def test_missing_lock_stops_with_one_line_message(repo: Path) -> None:
    (repo / ".devcontainer/devcontainer.json").write_text(_CONFIG % "1.64.1", encoding="utf-8")
    result = _run(repo)
    assert result.returncode == 1
    assert result.stderr.strip().count("\n") == 0
    assert "pnpm-lock.yaml を読めない" in result.stderr
