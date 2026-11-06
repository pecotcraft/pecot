"""root package.json が nx workspace として成り立っていることを pin する。

root は pnpm workspace の root で、依存と lock（pnpm-lock.yaml）を 1 つで管理する (#113)。
libs/text-rules/dist は、assets/slidev の `prepare`（build.mjs）が `pnpm install` の lifecycle で build する。
root フック（check-text.sh 等）は libs/text-rules/dist を起動する。
root は外部へ配布しないので、exports / bin / dependencies は持たない。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

# parents[0]=tests, [1]=.githooks, [2]=リポルート。
_REPO_ROOT = Path(__file__).resolve().parents[2]
_LIB_DIR = _REPO_ROOT / "libs" / "text-rules"


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def root() -> dict:
    return _load(_REPO_ROOT / "package.json")


def test_root_is_a_private_nx_workspace(root: dict) -> None:
    assert root["name"] == "pecot"
    assert root["private"] is True
    assert root["version"] == "0.0.0"
    assert "nx" in root["devDependencies"]
    assert "overrides" not in root
    assert re.search(
        r"^  undici: \S+", (_REPO_ROOT / "pnpm-workspace.yaml").read_text(encoding="utf-8"), re.M
    )


def test_root_does_not_distribute(root: dict) -> None:
    for key in ("exports", "bin", "files", "dependencies"):
        assert key not in root, key


def test_root_has_no_prepare(root: dict) -> None:
    """lib の build は assets/slidev の prepare が担う。root の prepare は npm ci を呼ぶため置かない。"""
    assert "prepare" not in root.get("scripts", {})


def test_root_install_target_is_a_frozen_pnpm_install(root: dict) -> None:
    install = root["nx"]["targets"]["install"]
    assert install["cache"] is False
    assert install["options"]["command"].endswith("pnpm install --frozen-lockfile")


def test_package_manager_guard_is_kept(root: dict) -> None:
    """違うパッケージマネージャの install を止める宣言（devEngines）を弱めない。"""
    # engines の npm / yarn の "<0.0.0" は使わない。止める役は devEngines.packageManager が持つ。
    assert "engines" not in root
    pm = root["devEngines"]["packageManager"]
    assert pm["name"] == "pnpm"
    assert pm["onFail"] == "download"
    assert root["packageManager"].startswith(f"pnpm@{pm['version']}+")
    lib = _load(_LIB_DIR / "package.json")
    assert lib["devEngines"]["packageManager"] == {"name": "pnpm", "onFail": "error"}
    assert "packageManager" not in lib
    assert set(lib["engines"]) == {"node"}
