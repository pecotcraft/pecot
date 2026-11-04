"""pecot-workflow / pecot-visual の plugin-update-notice.sh が同一ロジックであることの確認。

2 つの hook は hook 有効判定の関数名（pecot_hook_enabled / pecotv_hook_enabled）だけが
異なる複製。片方だけの修正（ずれ）を検出する。
"""

from __future__ import annotations

from pathlib import Path

import pytest

_HOOK_ENABLED_PREFIXES = ("pecot_hook_enabled ", "pecotv_hook_enabled ")


def _lines(path: Path) -> list[str]:
    return [
        "<hook-enabled>" if line.startswith(_HOOK_ENABLED_PREFIXES) else line
        for line in path.read_text().splitlines()
    ]


@pytest.fixture
def notice_scripts(script_dir: Path) -> tuple[Path, Path]:
    project_root = script_dir.parents[1]
    workflow = (
        project_root / "plugins/pecot-workflow/hooks/lib/session-start/plugin-update-notice.sh"
    )
    visual = project_root / "plugins/pecot-visual/hooks/lib/session-start/plugin-update-notice.sh"
    return workflow, visual


def test_notice_scripts_match_except_hook_enabled_line(notice_scripts) -> None:
    workflow, visual = notice_scripts
    assert _lines(workflow) == _lines(visual)


def test_each_script_has_exactly_one_hook_enabled_line(notice_scripts) -> None:
    workflow, visual = notice_scripts
    assert _lines(workflow).count("<hook-enabled>") == 1
    assert _lines(visual).count("<hook-enabled>") == 1
    assert 'pecot_hook_enabled "plugin-update-notice" true || exit 0' in workflow.read_text()
    assert 'pecotv_hook_enabled "plugin-update-notice" true || exit 0' in visual.read_text()
