""".githooks/scripts/gen-runtime-lock.mjs の --check が、ずれを見つけて止まることを確かめる (#113)。"""

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


def _first_package(lock_text: str) -> str:
    """runtime-lock の本体の文書で、integrity を持つ scope の無い先頭のキー（例: commander@15.0.0）。"""
    entry = re.search(
        r"^  ([a-z][\w.-]*@\d[\w.-]*):\n    resolution:\n      integrity: ",
        lock_text.split("\n---\n")[-1],
        flags=re.M,
    )
    assert entry, "runtime-lock に integrity を持つ package が無い"
    return entry.group(1)


def _drift_candidate(root_text: str, block: str) -> tuple[str, str, str]:
    """importer の依存のうち、root の lock に別の版も実在するもの（名前・今の版・別の版）。"""
    for name, version in re.findall(
        r"^      '?([^'\s:]+)'?:\n        specifier: .+\n        version: (\d[\w.-]*)$",
        block,
        flags=re.M,
    ):
        others = {
            v
            for v in re.findall(rf"^  '?{re.escape(name)}@(\d[\w.-]*)'?:$", root_text, flags=re.M)
            if v != version
        }
        if others:
            return name, version, sorted(others)[0]
    raise AssertionError("root の lock に別の版を持つ依存が無い")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """gen-runtime-lock.mjs が読むファイルだけを、作業ツリーから複製した repo。"""
    files = [
        ".githooks/scripts/gen-runtime-lock.mjs",
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
        ["node", ".githooks/scripts/gen-runtime-lock.mjs", "--check"],
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
    pkg = repo / "plugins/pecot-tools/cli/package.json"
    data = json.loads(pkg.read_text(encoding="utf-8"))
    data["dependencies"]["commander"] = "^0.0.1"
    pkg.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
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
    key = _first_package(text)
    entry = re.search(
        rf"^  {re.escape(key)}:\n    resolution:\n      integrity: sha512-", text, flags=re.M
    )
    assert entry
    lock.write_text(text[: entry.end()] + "AAAA" + text[entry.end() :], encoding="utf-8")
    result = _check(repo)
    assert result.returncode == 1
    assert f"{key} の integrity が root の pnpm-lock.yaml と一致しません" in result.stderr


def test_package_missing_in_root_lock_stops(repo: Path) -> None:
    key = _first_package(
        (repo / "plugins/pecot-tools/runtime-lock.yaml").read_text(encoding="utf-8")
    )
    root_lock = repo / "pnpm-lock.yaml"
    text = root_lock.read_text(encoding="utf-8")
    assert f"\n  {key}:\n" in text
    root_lock.write_text(text.replace(f"\n  {key}:\n", f"\n  {key}-gone:\n", 1), encoding="utf-8")
    result = _check(repo)
    assert result.returncode == 1
    assert f"{key} が root の pnpm-lock.yaml にありません" in result.stderr


def test_importer_version_drift_from_root_lock_stops(repo: Path) -> None:
    """root の lock で importer の版を別の実在する版に変えると、runtime-lock との差で止まる。"""
    root_lock = repo / "pnpm-lock.yaml"
    text = root_lock.read_text(encoding="utf-8")
    start = text.index("\n  plugins/pecot-tools/cli:\n")
    end = text.index("\n  plugins/", start + 1)
    block = text[start:end]
    name, version, other = _drift_candidate(text, block)
    pattern = re.compile(
        rf"(^      '?{re.escape(name)}'?:\n        specifier: .+\n        version: ){re.escape(version)}$",
        re.M,
    )
    assert pattern.search(block)
    new_block = pattern.sub(rf"\g<1>{other}", block, count=1)
    root_lock.write_text(text[:start] + new_block + text[end:], encoding="utf-8")
    result = _check(repo)
    assert result.returncode == 1
    assert (
        "plugins/pecot-tools/runtime-lock.yaml: cli の importer の版が root の pnpm-lock.yaml と一致しません"
        in result.stderr
    )


def _write(repo: Path) -> None:
    result = subprocess.run(
        ["node", ".githooks/scripts/gen-runtime-lock.mjs", "--write"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_write_copies_referenced_catalog_only(repo: Path) -> None:
    # どの importer も参照しない項目を root の catalogs.default に足す。--write はこれを落とす。
    _edit(
        repo / "pnpm-lock.yaml",
        "catalogs:\n  default:\n",
        "catalogs:\n  default:\n    unreferenced-sample:\n      specifier: ^1.0.0\n      version: 1.0.0\n",
    )
    _write(repo)
    expected = "catalogs:\n  default:\n    vite:\n      specifier: ^"
    for d in ("plugins/pecot-visual", "plugins/pecot-tools", "plugins/pecot-workflow"):
        text = (repo / d / "runtime-lock.yaml").read_text(encoding="utf-8")
        assert expected in text, d
        assert "unreferenced-sample" not in text, d


def test_write_omits_catalogs_for_target_without_reference(repo: Path) -> None:
    _write(repo)
    assert "catalogs:" not in (repo / "libs/text-rules/runtime-lock.yaml").read_text(
        encoding="utf-8"
    )


def test_catalogs_missing_in_runtime_lock_stops(repo: Path) -> None:
    lock = repo / "plugins/pecot-tools/runtime-lock.yaml"
    text = lock.read_text(encoding="utf-8")
    start = text.index("catalogs:\n")
    end = text.index("overrides:\n", start)
    lock.write_text(text[:start] + text[end:], encoding="utf-8")
    result = _check(repo)
    assert result.returncode == 1
    assert (
        "plugins/pecot-tools/runtime-lock.yaml: catalogs が root の pnpm-lock.yaml と一致しません"
        in result.stderr
    )


def test_runtime_lock_workflow_runs_an_existing_script() -> None:
    """runtime-lock.yml は Dependabot の PR でしか動かない。run が指す script の実在をここで確かめる。"""
    workflow = (_REPO_ROOT / ".github/workflows/runtime-lock.yml").read_text(encoding="utf-8")
    paths = re.findall(r"run:\s*node\s+(\S+gen-runtime-lock\.mjs)", workflow)
    assert paths == [".githooks/scripts/gen-runtime-lock.mjs"]
    assert (_REPO_ROOT / paths[0]).is_file()


def test_runtime_lock_workflow_marks_commit_for_dependabot_rebase() -> None:
    """印が無いと、dependabot は他者の commit がある PR を rebase しない。"""
    workflow = (_REPO_ROOT / ".github/workflows/runtime-lock.yml").read_text(encoding="utf-8")
    commits = re.findall(r"^\s*(git commit\b.*)$", workflow, re.M)
    assert commits == ['git commit -m "$COMMIT_MSG" -m "[dependabot skip]"'], (
        f"git commit の行: {commits}"
    )


def test_write_reproduces_committed_files_without_pnpm(repo: Path) -> None:
    """--write は pnpm を呼ばず、commit 済みの生成物と同じものを作る。"""
    empty_bin = repo / "empty-bin"
    empty_bin.mkdir()
    env = {**os.environ, "PATH": f"{empty_bin}:{Path(shutil.which('node') or '').parent}"}
    result = subprocess.run(
        ["node", ".githooks/scripts/gen-runtime-lock.mjs", "--write"],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    for d in _TARGET_DIRS:
        for name in ("lock", "workspace"):
            file = f"{d}/runtime-{name}.yaml"
            assert (repo / file).read_text(encoding="utf-8") == (_REPO_ROOT / file).read_text(
                encoding="utf-8"
            ), file
    assert _check(repo).returncode == 0
