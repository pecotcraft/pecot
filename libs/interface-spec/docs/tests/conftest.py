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


def _layer(
    item: pytest.Item,
    projects: dict[Path, Path | None],
    tables: dict[Path, list[tuple[str, str]]],
) -> str:
    # 層は project の root の test-layers.txt で決める（test-conventions.md の「テストの層」）。
    if any(m.kwargs.get("label_type") == "layer" for m in item.iter_markers("allure_label")):
        return ""
    directory = item.path.parent
    if directory not in projects:
        projects[directory] = next(
            (p for p in [directory, *directory.parents] if (p / "project.json").is_file()), None
        )
    project = projects[directory]
    if project is None:
        return ""
    if project not in tables:
        table = project / "test-layers.txt"
        lines = table.read_text(encoding="utf-8").splitlines() if table.is_file() else []
        fields = [
            line.split() for line in lines if line.strip() and not line.strip().startswith("#")
        ]
        tables[project] = [(field[0], field[1]) for field in fields if len(field) == 2]
    relative = item.path.relative_to(project).as_posix()
    hits = [
        (len(path), layer)
        for layer, path in tables[project]
        if relative == path or (path.endswith("/") and relative.startswith(path))
    ]
    return max(hits)[1] if hits else ""


def _has_severity(item: pytest.Item) -> bool:
    # allure-pytest の allure_labels() と同じく、関数・クラス・モジュールの印を見る。
    return any(
        mark.kwargs.get("label_type") == "severity"
        for mark in item.iter_markers(name="allure_label")
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    labels = {label: config.getini(name) for name, label in _REPORT_LABELS.items()}
    if not any(labels.values()):
        return
    import allure

    # allure.label は型を持たない。allure-pytest では pytest の印を返す。
    mark = cast("Callable[[str, str], pytest.MarkDecorator]", allure.label)  # pyright: ignore[reportUnknownMemberType]
    found: dict[Path, Path] = {}
    projects: dict[Path, Path | None] = {}
    tables: dict[Path, list[tuple[str, str]]] = {}
    for item in items:
        layer = {"layer": _layer(item, projects, tables)}
        for label, value in {**labels, **_hierarchy_labels(config, item, found), **layer}.items():
            if value:
                item.add_marker(mark(label, value))
        # この conftest が動く interface-spec のレーンは、重大度の表で minor の project。
        if labels["project"] and not _has_severity(item):
            item.add_marker(mark("severity", "minor"))
