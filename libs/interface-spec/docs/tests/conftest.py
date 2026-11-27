"""docs のテストの共通の hook。nx のレーンから -o で渡したラベルを、Allure の結果に付ける。"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest

_REPORT_LABELS = {"pecot_report_project": "project", "pecot_report_lane": "lane"}


def pytest_addoption(parser: pytest.Parser) -> None:
    for name, label in _REPORT_LABELS.items():
        parser.addini(name, f"Allure の結果に付ける {label} のラベル", default="")


def _repo_root(path: Path, fallback: Path, found: dict[Path, Path]) -> Path:
    # conftest を一時ディレクトリへ写して動かすテストでは nx.json が無く、pytest の rootpath にする。
    directory = path.parent
    if directory not in found:
        found[directory] = next(
            (
                parent
                for parent in [directory, *directory.parents]
                if (parent / "nx.json").is_file()
            ),
            fallback,
        )
    return found[directory]


def _hierarchy_labels(
    config: pytest.Config, item: pytest.Item, found: dict[Path, Path]
) -> dict[str, str]:
    story = item.path.relative_to(_repo_root(item.path, config.rootpath, found)).as_posix()
    return {
        "epic": config.getini("pecot_report_project"),
        "feature": Path(story).parent.as_posix(),
        "story": story,
    }


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    labels = {label: config.getini(name) for name, label in _REPORT_LABELS.items()}
    if not any(labels.values()):
        return
    import allure

    # allure.label は型を持たない。allure-pytest では pytest の印を返す。
    mark = cast("Callable[[str, str], pytest.MarkDecorator]", allure.label)  # pyright: ignore[reportUnknownMemberType]
    found: dict[Path, Path] = {}
    for item in items:
        for label, value in {**labels, **_hierarchy_labels(config, item, found)}.items():
            if value:
                item.add_marker(mark(label, value))
