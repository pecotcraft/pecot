"""root package.json が nx workspace として成り立っていることを pin する。

root の `prepare` が libs/text-rules を build する。
root フック（check-text.sh 等）は libs/text-rules/dist を起動する。
そのため `npm install` / `npm ci` の直後に dist が揃っている必要がある。
root は外部へ配布しないので、exports / bin / dependencies は持たない。
"""

from __future__ import annotations

import json
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
    assert root["overrides"]["undici"]


def test_root_does_not_distribute(root: dict) -> None:
    for key in ("exports", "bin", "files", "dependencies"):
        assert key not in root, key


def test_prepare_installs_and_builds_the_lib(root: dict) -> None:
    assert (
        root["scripts"]["prepare"]
        == "npm --prefix libs/text-rules ci && npm --prefix libs/text-rules run build"
    )


def test_package_manager_guard_is_kept(root: dict) -> None:
    """違うパッケージマネージャの install を止める宣言（devEngines）を弱めない。"""
    # engines の pnpm / yarn の "<0.0.0" は使わない。止める役は devEngines.packageManager が持つ。
    assert "engines" not in root
    assert root["devEngines"]["packageManager"] == {"name": "npm", "onFail": "error"}
    # 実体側も同じ宣言にそろえる。engines は node だけにする。
    lib = _load(_LIB_DIR / "package.json")
    assert lib["devEngines"]["packageManager"] == {"name": "npm", "onFail": "error"}
    assert set(lib["engines"]) == {"node"}
