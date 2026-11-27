"""docs のテストの共通の hook。nx のレーンから -o で渡したラベルと、動かした環境を、Allure の結果に付ける。"""

from __future__ import annotations

import platform
import re
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


# 実行全体で同じ値を、Allure のレポートのメタデータに出すファイル。
_ENVIRONMENT_FILE = "environment.properties"
_CONTROL_ESCAPES = {"\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r"}
# os-release(5) の読む順と、行の形・エスケープの外し方。行の形は platform.freedesktop_os_release と同じ。
_OS_RELEASE_PATHS = ("/etc/os-release", "/usr/lib/os-release")
_OS_RELEASE_LINE = re.compile(r"^(?P<name>[a-zA-Z0-9_]+)=(?P<quote>[\"']?)(?P<value>.*)(?P=quote)$")
_OS_RELEASE_UNESCAPE = re.compile(r"\\([\\\$\"\'`])")


def _alluredir(config: pytest.Config) -> Path | None:
    value = cast("str | None", config.getoption("allure_report_dir", None))
    return config.invocation_params.dir / value if value else None


def _os_name() -> str:
    # freedesktop_os_release は PRETTY_NAME の無いファイルに "Linux" を補うので使わない。
    for path in _OS_RELEASE_PATHS:
        try:
            text = Path(path).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = (_OS_RELEASE_LINE.match(line) for line in text.split("\n"))
        names = [m["value"] for m in lines if m and m["name"] == "PRETTY_NAME"]
        if names:
            return _OS_RELEASE_UNESCAPE.sub(r"\1", names[-1])
        break
    return f"{platform.system()} {platform.release()}"


def _escape_property(text: str, *, key: bool) -> str:
    # allure-js-commons の stringifyEnvInfo と同じエスケープ。JS と同じく UTF-16 の単位で見る。
    raw = text.encode("utf-16-le", "surrogatepass")
    escaped: list[str] = []
    leading = True
    for code in (int.from_bytes(raw[i : i + 2], "little") for i in range(0, len(raw), 2)):
        char = chr(code)
        leading = leading and char in " \t\f"
        if key and char in "=:":
            escaped.append(f"\\{char}")
        elif 31 < code < 127:
            space = char == " " and (key or leading)
            escaped.append("\\ " if space else "\\\\" if char == "\\" else char)
        elif char in _CONTROL_ESCAPES:
            escaped.append(_CONTROL_ESCAPES[char])
        elif code < 160 or code >= 256:
            escaped.append(f"\\u{code:04x}")
        else:
            escaped.append(char)
    return "".join(escaped)


@pytest.fixture(autouse=True)
def allure_python_parameter(request: pytest.FixtureRequest) -> None:
    # Python の版はレーンで違うので、テストのパラメータにする。excluded なので historyId は変わらない。
    if _alluredir(request.config) is None:
        return
    import allure

    # pyright は別名で import された allure.dynamic を読めない。
    allure.dynamic.parameter("Python", platform.python_version(), excluded=True)  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType]


def pytest_sessionfinish(session: pytest.Session) -> None:
    # xdist の worker は書かない。既にあるファイルは、同じディレクトリの別の書き手のものなので残す。
    results = _alluredir(session.config)
    if hasattr(session.config, "workerinput") or results is None:
        return
    environment = results / _ENVIRONMENT_FILE
    if environment.exists():
        return
    results.mkdir(parents=True, exist_ok=True)
    line = f"{_escape_property('OS', key=True)}={_escape_property(_os_name(), key=False)}"
    environment.write_text(line, encoding="utf-8")
