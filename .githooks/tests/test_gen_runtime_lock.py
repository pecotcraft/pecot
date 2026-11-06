"""scripts/gen-runtime-lock.mjs の --check が、ずれを見つけて止まることを確かめる (#113)。"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TARGET_DIRS = (
    "plugins/pecot-visual",
    "plugins/pecot-tools",
    "plugins/pecot-workflow",
    "libs/text-rules",
)


def _members() -> list[str]:
    text = (_REPO_ROOT / "pnpm-workspace.yaml").read_text(encoding="utf-8")
    return re.findall(r"^  - (\S+)$", text, flags=re.M)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """gen-runtime-lock.mjs が読むファイルだけを、作業ツリーから複製した repo。"""
    files = [
        "scripts/gen-runtime-lock.mjs",
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
    ]
    files += [f"{member}/package.json" for member in _members()]
    files += [f"{d}/runtime-{name}.yaml" for d in _TARGET_DIRS for name in ("lock", "workspace")]
    for file in files:
        destination = tmp_path / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(_REPO_ROOT / file, destination)
    (tmp_path / "node_modules").symlink_to(_REPO_ROOT / "node_modules")
    return tmp_path


def _check(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", "scripts/gen-runtime-lock.mjs", "--check"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )


def _edit(path: Path, old: str, new: str, count: int = 1) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text, f"{path} に {old} が無い"
    path.write_text(text.replace(old, new, count), encoding="utf-8")


def test_clean_tree_passes(repo: Path) -> None:
    result = _check(repo)
    assert (result.returncode, result.stderr) == (0, "")


def test_member_dependency_change_stops_with_hint(repo: Path) -> None:
    _edit(
        repo / "plugins/pecot-tools/cli/package.json",
        '"commander": "^15.0.0"',
        '"commander": "^15.0.1"',
    )
    result = _check(repo)
    assert result.returncode == 1
    assert (
        "plugins/pecot-tools/runtime-lock.yaml: cli の dependencies が package.json と一致しません"
        in result.stderr
    )
    assert "gen-runtime-lock.mjs --write" in result.stderr


def test_importer_missing_in_lock_stops(repo: Path) -> None:
    lock = repo / "plugins/pecot-workflow/runtime-lock.yaml"
    _edit(lock, "  cli-node:\n", "  cli-gone:\n")
    result = _check(repo)
    assert result.returncode == 1
    assert "plugins/pecot-workflow/runtime-lock.yaml: importers" in result.stderr


def test_workspace_setting_drift_stops(repo: Path) -> None:
    _edit(
        repo / "plugins/pecot-tools/runtime-workspace.yaml",
        "nodeLinker: hoisted",
        "nodeLinker: isolated",
    )
    result = _check(repo)
    assert result.returncode == 1
    assert "plugins/pecot-tools/runtime-workspace.yaml" in result.stderr


def test_package_integrity_drift_stops(repo: Path) -> None:
    lock = repo / "plugins/pecot-tools/runtime-lock.yaml"
    text = lock.read_text(encoding="utf-8")
    entry = re.search(
        r"^  commander@15\.0\.0:\n    resolution: {integrity: sha512-", text, flags=re.M
    )
    assert entry, "runtime-lock に commander が無い"
    lock.write_text(text[: entry.end()] + "AAAA" + text[entry.end() :], encoding="utf-8")
    result = _check(repo)
    assert result.returncode == 1
    assert "commander@15.0.0 の integrity が root の pnpm-lock.yaml と一致しません" in result.stderr


def test_package_missing_in_root_lock_stops(repo: Path) -> None:
    root_lock = repo / "pnpm-lock.yaml"
    text = root_lock.read_text(encoding="utf-8")
    assert "\n  commander@15.0.0:\n" in text
    root_lock.write_text(
        text.replace("\n  commander@15.0.0:\n", "\n  commander@15.0.9:\n", 1), encoding="utf-8"
    )
    result = _check(repo)
    assert result.returncode == 1
    assert "commander@15.0.0 が root の pnpm-lock.yaml にありません" in result.stderr


def test_write_runs_every_target_with_the_root_pnpm_version(repo: Path, tmp_path: Path) -> None:
    """生成で使う pnpm の版は、PATH 上の pnpm によらず、root の packageManager に揃う。"""
    log = tmp_path / "pnpm-versions.log"
    fake = tmp_path / "bin" / "pnpm"
    fake.parent.mkdir()
    fake.write_text(
        f"#!/bin/sh\nnode -p \"const m = require('./package.json'); m.packageManager + ' ' + m.devEngines.packageManager.version\" >> {log}\n",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    env = {**os.environ, "PATH": f"{fake.parent}:{os.environ['PATH']}"}
    result = subprocess.run(
        ["node", "scripts/gen-runtime-lock.mjs", "--write"],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    root = json.loads((repo / "package.json").read_text(encoding="utf-8"))
    want = [root["packageManager"], root["devEngines"]["packageManager"]["version"]]
    assert log.read_text(encoding="utf-8").split() == want * len(_TARGET_DIRS)
