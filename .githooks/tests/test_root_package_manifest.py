"""root package.json が nx workspace として成り立っていることを pin する。

root は pnpm workspace の root で、依存と lock（pnpm-lock.yaml）を 1 つで管理する (#113)。
libs/text-rules/dist は、nx の text-rules:build と .githooks/lib/text-rules-ready.sh が build する。
root フック（check-text.sh 等）は libs/text-rules/dist を起動する。
root は外部へ配布しないので、exports / bin / dependencies は持たない。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import allure
import pytest

# parents[0]=tests, [1]=.githooks, [2]=リポルート。
_REPO_ROOT = Path(__file__).resolve().parents[2]
_LIB_DIR = _REPO_ROOT / "libs" / "text-rules"


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def root() -> dict:
    return _load(_REPO_ROOT / "package.json")


@allure.title("root の package.json は、配布しない nx workspace として定義されている")
def test_root_is_a_private_nx_workspace(root: dict) -> None:
    """root の `package.json` の定義のテストです。名前が `pecot`、`private` が `true` で、`nx` が `devDependencies` に存在することを確認します。`overrides` は `package.json` ではなく `pnpm-workspace.yaml` に置きます。"""
    with allure.step("root の package.json が private な nx workspace であることを確かめる"):
        assert root["name"] == "pecot"
        assert root["private"] is True
        assert root["version"] == "0.0.0"
        assert "nx" in root["devDependencies"]
        assert "overrides" not in root
        assert re.search(
            r"^overrides:$", (_REPO_ROOT / "pnpm-workspace.yaml").read_text(encoding="utf-8"), re.M
        )


@allure.title("root の package.json には、配布用の項目を定義しない")
def test_root_does_not_distribute(root: dict) -> None:
    """root の `package.json` に、`exports`・`bin`・`files`・`dependencies` のいずれも存在しないことを確認するテストです。"""
    with allure.step("root の package.json に配布用の項目が無いことを確かめる"):
        for key in ("exports", "bin", "files", "dependencies"):
            assert key not in root, key


@allure.title("root の package.json に、prepare スクリプトを定義しない")
def test_root_has_no_prepare(root: dict) -> None:
    """root の `package.json` の `scripts` に `prepare` が存在しないことを確認するテストです。ライブラリの build は nx の `text-rules:build` が担います。"""
    with allure.step("root の scripts に prepare が無いことを確かめる"):
        assert "prepare" not in root.get("scripts", {})


@allure.title("root の install target は、lockfile を固定した pnpm install を実行する")
def test_root_install_target_is_a_frozen_pnpm_install(root: dict) -> None:
    """root の `nx` の `install` target のテストです。キャッシュが無効で、コマンドが `run-pnpm.sh install --frozen-lockfile` で終わり、呼び出すスクリプトが実在することを確認します。"""
    with allure.step("install の target の設定を読む"):
        install = root["nx"]["targets"]["install"]
    with allure.step("lockfile を固定した pnpm install で、script が実在することを確かめる"):
        assert install["cache"] is False
        command = install["options"]["command"]
        assert command.endswith(".githooks/scripts/run-pnpm.sh install --frozen-lockfile")
        script = next(word for word in command.split() if word.endswith("run-pnpm.sh"))
        assert (_REPO_ROOT / script).is_file(), script


@allure.title("違うパッケージマネージャの install を止める宣言を、root とライブラリで維持する")
def test_package_manager_guard_is_kept(root: dict) -> None:
    """`devEngines` によるパッケージマネージャの制限のテストです。root は `onFail: download`、`libs/text-rules` は `onFail: error` で `pnpm` を指定していることを確認します。`libs/text-rules` の `engines` には、`node` だけが存在します。"""
    with allure.step("違うパッケージマネージャを止める宣言が残っていることを確かめる"):
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
