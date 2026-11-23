"""docs のテストの共通の hook。nx のレーンから -o で渡したラベルを、Allure の結果に付ける。"""

from __future__ import annotations

from collections.abc import Callable
from typing import cast

import pytest

_REPORT_LABELS = {"pecot_report_project": "project", "pecot_report_lane": "lane"}


def pytest_addoption(parser: pytest.Parser) -> None:
    for name, label in _REPORT_LABELS.items():
        parser.addini(name, f"Allure の結果に付ける {label} のラベル", default="")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    labels = {label: config.getini(name) for name, label in _REPORT_LABELS.items()}
    if not any(labels.values()):
        return
    import allure

    # allure.label は型を持たない。allure-pytest では pytest の印を返す。
    mark = cast("Callable[[str, str], pytest.MarkDecorator]", allure.label)  # pyright: ignore[reportUnknownMemberType]
    for item in items:
        for label, value in labels.items():
            if value:
                item.add_marker(mark(label, value))
