"""配布の都合でプロジェクトごとに持つ scripts/tsc.mjs が、pecot-visual/cli のものと逐語で一致することを確かめる。"""

from __future__ import annotations

from pathlib import Path

import allure
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_REFERENCE = "plugins/pecot-visual/cli/scripts/tsc.mjs"
# .nx/nx-release/scripts/tsc.mjs は別の中身なので、この一覧に入れない。
_COPIES = (
    "plugins/pecot-visual/assets/slidev/scripts/tsc.mjs",
    "plugins/pecot-tools/cli/scripts/tsc.mjs",
    "plugins/pecot-workflow/cli/scripts/tsc.mjs",
    "libs/text-rules/scripts/tsc.mjs",
    "libs/workflow-core/scripts/tsc.mjs",
    "libs/interface-spec/scripts/tsc.mjs",
)


@pytest.mark.parametrize("relative", _COPIES)
def test_tsc_mjs_は_pecot_visual_cli_と逐語一致する(relative: str) -> None:
    with allure.step("写しと pecot-visual/cli の tsc.mjs を読む"):
        copy = (_REPO_ROOT / relative).read_bytes()
        reference = (_REPO_ROOT / _REFERENCE).read_bytes()
    with allure.step("2 つの中身が逐語で一致することを確かめる"):
        assert copy == reference
