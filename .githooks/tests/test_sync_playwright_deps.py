"""sync-playwright-deps.mjs と、それを使う dependabot の workflow の静的テスト (#274)。"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

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


def _workflow(name: str) -> dict:
    return yaml.safe_load((_REPO_ROOT / ".github/workflows" / name).read_text(encoding="utf-8"))


def _step_index(steps: list[dict], name: str) -> int:
    return next(i for i, s in enumerate(steps) if s.get("name") == name)


def test_commit_workflow_runs_an_existing_script_and_adds_devcontainer_json() -> None:
    steps = _workflow("dependabot-commit.yml")["jobs"]["regenerate"]["steps"]
    sync = next(s for s in steps if s.get("run") == f"node {_SCRIPT}")
    assert sync
    assert (_REPO_ROOT / _SCRIPT).is_file()
    commit = steps[_step_index(steps, "Commit generated files")]
    assert ".devcontainer/devcontainer.json" in commit["run"]


def test_commit_workflow_publishes_image_before_push_without_blocking_it() -> None:
    job = _workflow("dependabot-commit.yml")["jobs"]["regenerate"]
    steps = job["steps"]
    publish = steps[_step_index(steps, "Publish devcontainer image")]
    assert publish["continue-on-error"] is True
    assert "dev-container.sh publish --push" in publish["run"]
    assert _step_index(steps, "Publish devcontainer image") < _step_index(
        steps, "Push generated files"
    )
    assert job["permissions"] == {"contents": "read", "packages": "write"}
    assert job["timeout-minutes"] == 60


def test_auto_merge_keeps_the_update_type_allowlist_without_dependency_names() -> None:
    steps = _workflow("dependabot-auto-merge.yml")["jobs"]["auto-merge"]["steps"]
    cond = steps[_step_index(steps, "Check merge queue")]["if"]
    assert "version-update:semver-minor" in cond
    assert "version-update:semver-patch" in cond
    assert "dependency-names" not in cond
