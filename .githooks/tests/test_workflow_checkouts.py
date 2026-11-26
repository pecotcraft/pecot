"""`.github/workflows/*.yml` の全履歴の checkout が、blob を読むものだけ取る形であることを固定する。

`fetch-depth: 0` は全部のブランチを取り、保管ブランチ pages-store（展開で数百 MB）も含む。
actions/checkout の入力 `filter: blob:none` で、blob は後から読むものだけ取る。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import allure
import yaml

_WORKFLOWS = Path(__file__).resolve().parents[2] / ".github/workflows"


def _checkouts_with_full_history() -> list[tuple[str, dict[str, Any]]]:
    found: list[tuple[str, dict[str, Any]]] = []
    for path in sorted(_WORKFLOWS.glob("*.yml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for job_id, job in (data.get("jobs") or {}).items():
            for step in job.get("steps") or []:
                if not str(step.get("uses", "")).startswith("actions/checkout@"):
                    continue
                with_ = step.get("with") or {}
                if with_.get("fetch-depth") == 0:
                    found.append((f"{path.name}:{job_id}:{step.get('name', '')}", with_))
    return found


def test_full_history_checkouts_exist() -> None:
    with allure.step("全履歴の checkout が 1 つ以上あることを確かめる"):
        assert _checkouts_with_full_history()


def test_full_history_checkouts_filter_blobs() -> None:
    with allure.step("全履歴の checkout のうち、filter: blob:none の無いものを集める"):
        missing = [
            label
            for label, with_ in _checkouts_with_full_history()
            if with_.get("filter") != "blob:none"
        ]
    with allure.step("filter の無い checkout が無いことを確かめる"):
        assert missing == []
