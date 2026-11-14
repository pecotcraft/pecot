"""iface_defs 拡張のテスト。小さいリポジトリの形の fixture を Sphinx で実際にビルドし、needs.json・HTML・警告を読む。"""

import json
import re
import sys
from pathlib import Path
from typing import Any

import pytest
from sphinx.cmd.build import build_main

DOCS = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(DOCS / "_ext"))

from iface_defs import Case, outcome_of  # noqa: E402

INDEX = """\
Sample
======

.. iface-defs:: sample

.. needtable::
   :columns: id;title;outcome;verifies_back

.. iface-tests:: sample
"""

JUNIT_VITEST = FIXTURES / "junit" / "vitest.xml"
JUNIT_PYTEST = FIXTURES / "junit" / "pytest.xml"


class Built:
    def __init__(self, out: Path, code: int, warnings: str, stdout: str) -> None:
        self.out = out
        self.code = code
        self.warnings = warnings
        self.stdout = stdout
        data: dict[str, Any] = json.loads((out / "needs.json").read_text(encoding="utf-8"))
        versions: dict[str, Any] = data["versions"]
        self.needs: dict[str, dict[str, Any]] = next(iter(versions.values()))["needs"]

    def html(self, page: str = "index.html") -> str:
        return (self.out / page).read_text(encoding="utf-8")


def build(
    tmp_path: Path,
    junit: list[Path],
    capfd: pytest.CaptureFixture[str],
    extra_junit: dict[str, list[Path]] | None = None,
    files: dict[str, str] | None = None,
    pages: bool = False,
) -> Built:
    src = tmp_path / "src"
    src.mkdir(exist_ok=True)
    (src / "index.rst").write_text(INDEX, encoding="utf-8")
    for name, text in (files or {}).items():
        (src / name).parent.mkdir(parents=True, exist_ok=True)
        (src / name).write_text(text, encoding="utf-8")
    junit_map = {"sample": [str(p) for p in junit]}
    if extra_junit is not None:
        junit_map.update({k: [str(p) for p in v] for k, v in extra_junit.items()})
    (src / "conf.py").write_text(
        "import runpy\n"
        f"_ns = runpy.run_path({str(DOCS / 'conf.py')!r})\n"
        "globals().update({k: v for k, v in _ns.items() if not k.startswith('__')})\n"
        f"iface_root = {str(FIXTURES / 'repo')!r}\n"
        f"iface_junit = {junit_map!r}\n"
        f"iface_pages = {pages!r}\n",
        encoding="utf-8",
    )
    out = tmp_path / "out"
    warnings = tmp_path / "warnings.txt"
    code = build_main(
        ["-b", "html", "-w", str(warnings), "-d", str(tmp_path / "doctrees"), str(src), str(out)]
    )
    captured = capfd.readouterr()
    text = warnings.read_text(encoding="utf-8") if warnings.exists() else ""
    return Built(out, code, text, captured.out)


@pytest.fixture
def full(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> Built:
    return build(tmp_path, [JUNIT_VITEST, JUNIT_PYTEST], capfd)


def test_need_ids_from_definitions(full: Built) -> None:
    ids = {i for i in full.needs if i.startswith("SM-")}
    assert ids == {
        "SM-ONE",
        "SM-ONE-01",
        "SM-ONE-02",
        "SM-ONE-03",
        "SM-TWO",
        "SM-TWO-01",
        "SM-TWO-02",
        "SM-TWO-03",
        "SM-COMMON-01",
        "SM-HALF",
    }


def test_behavior_belongs_to_its_command(full: Built) -> None:
    assert full.needs["SM-ONE-02"]["belongs"] == ["SM-ONE"]
    assert full.needs["SM-TWO-03"]["belongs"] == ["SM-TWO"]
    assert full.needs["SM-COMMON-01"]["belongs"] == []


def test_types(full: Built) -> None:
    assert full.needs["SM-ONE"]["type"] == "cmd"
    assert full.needs["SM-ONE-01"]["type"] == "behavior"
    assert full.needs["SM-COMMON-01"]["type"] == "behavior"
    assert full.needs["SM-ONE-01"]["title"] == "target を渡して打つと、対象を 1 回動かす"


def test_body_follows_page_section_order(full: Built) -> None:
    content: str = full.needs["SM-ONE"]["content"]
    description = content.index("Stops at the first failure.")
    exit_status = content.index("The target is missing.")
    assert description < content.index("Skip the check") < exit_status


def test_outcomes(full: Built) -> None:
    got = {
        i: full.needs[i]["outcome"]
        for i in full.needs
        if i.startswith("SM-") and full.needs[i]["type"] == "behavior"
    }
    assert got == {
        "SM-ONE-01": "passed",
        "SM-ONE-02": "passed",
        "SM-ONE-03": "not run",
        "SM-TWO-01": "passed",
        "SM-TWO-02": "failed",
        "SM-TWO-03": "not run",
        "SM-COMMON-01": "not run",
    }


def test_verifies_links_cases(full: Built) -> None:
    def names(item: str) -> list[str]:
        return sorted(full.needs[c]["title"] for c in full.needs[item]["verifies_back"])

    assert names("SM-ONE-01") == ["test_normal"]
    assert names("SM-ONE-02") == ["test_normal"]
    assert names("SM-TWO-01") == ["sample_two > 呼ぶと、2 つを返す"]
    assert names("SM-TWO-02") == ["test_broken"]
    assert names("SM-ONE-03") == []


def test_pytest_and_vitest_cases_have_same_fields(full: Built) -> None:
    cases = [n for n in full.needs.values() if n["type"] == "testcase"]
    assert {n["title"] for n in cases} >= {"test_normal", "sample_two > 呼ぶと、2 つを返す"}
    assert all(not n.get("case_file") and not n.get("case_line") for n in cases)


def test_cases_without_verifies_are_dropped(full: Built) -> None:
    titles = {n["title"] for n in full.needs.values()}
    assert "test_other" not in titles
    assert "つながらないケース" not in titles


def test_unknown_id_is_dropped_and_reported(full: Built) -> None:
    titles = {n["title"] for n in full.needs.values()}
    assert "消えた項目のケース" not in titles
    assert "SM-GONE-01" in full.stdout
    assert "SM-GONE-01" not in full.warnings


def test_broken_entries_become_warnings_and_are_skipped(full: Built) -> None:
    assert "SM-BAD" in full.warnings
    assert "SM-HALF-01" in full.warnings
    assert "SM-BAD" not in full.needs
    assert "SM-HALF-01" not in full.needs
    assert full.code == 0


def test_without_junit_everything_is_not_run(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(tmp_path, [tmp_path / "missing.xml"], capfd)
    assert built.code == 0
    assert {
        built.needs[i]["outcome"] for i in built.needs if built.needs[i]["type"] == "behavior"
    } == {"not run"}
    assert "JUnit のファイルが見つからない" in built.html()
    assert not [n for n in built.needs.values() if n["type"] == "testcase"]


def test_junit_without_connected_cases(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    plain = tmp_path / "plain.xml"
    plain.write_text(
        '<testsuites><testsuite name="s" tests="1" failures="0" errors="0" skipped="0">'
        '<testcase classname="c" name="n" time="0.1"/></testsuite></testsuites>',
        encoding="utf-8",
    )
    built = build(tmp_path, [plain], capfd)
    assert built.code == 0
    assert {
        built.needs[i]["outcome"] for i in built.needs if built.needs[i]["type"] == "behavior"
    } == {"not run"}
    assert "項目につながるテストが無い" in built.html()


PAGES_INDEX = """\
Sample
======

.. iface-index:: sample

.. toctree::
   :hidden:
   :glob:

   _generated/sample/*

.. iface-tests:: sample
"""


def test_index_table_links_and_counts(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    built = build(
        tmp_path,
        [JUNIT_VITEST, JUNIT_PYTEST],
        capfd,
        files={"index.rst": PAGES_INDEX},
        pages=True,
    )
    assert built.code == 0
    html = built.html()
    rows = {
        name: (href, counts)
        for href, name, counts in re.findall(
            r'<td><p><a class="reference internal" href="([^"]+)"><span[^>]*>([^<]+)</span></a></p></td>'
            r"(?:\s*<td>.*?</td>){2}\s*<td><p>([^<]*)</p></td>",
            html,
            flags=re.S,
        )
    }
    assert rows == {
        "one run": ("_generated/sample/one-run.html", "合格 2・未実行 1"),
        "sample_two": ("_generated/sample/sample_two.html", "合格 1・不合格 1・未実行 1"),
        "half entry": ("_generated/sample/half-entry.html", "—"),
    }


def test_pages_are_written_and_stale_ones_removed(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    generated = tmp_path / "src" / "_generated"
    (generated / "sample").mkdir(parents=True)
    (generated / "sample" / "old-name.rst").write_text("Old\n===\n", encoding="utf-8")
    (generated / "gone").mkdir()
    (generated / "gone" / "x.rst").write_text("X\n=\n", encoding="utf-8")
    (generated / "junit").mkdir()
    (generated / "junit" / "keep.xml").write_text("<testsuites/>", encoding="utf-8")
    built = build(
        tmp_path,
        [JUNIT_VITEST, JUNIT_PYTEST],
        capfd,
        files={"index.rst": PAGES_INDEX},
        pages=True,
    )
    assert built.code == 0
    assert {p.name for p in (generated / "sample").glob("*.rst")} == {
        "one-run.rst",
        "sample_two.rst",
        "half-entry.rst",
    }
    assert not (generated / "gone").exists()
    assert (generated / "junit" / "keep.xml").is_file()
    assert ".. iface-defs:: sample SM-ONE" in (generated / "sample" / "one-run.rst").read_text(
        encoding="utf-8"
    )


PAGE_ONLY = """\
Page
====

.. iface-defs:: sample {arg}
"""


def page_build(tmp_path: Path, capfd: pytest.CaptureFixture[str], arg: str) -> Built:
    index = "Sample\n======\n\n.. toctree::\n\n   page\n\n.. iface-tests:: sample\n"
    return build(
        tmp_path,
        [JUNIT_VITEST, JUNIT_PYTEST],
        capfd,
        files={"index.rst": index, "page.rst": PAGE_ONLY.format(arg=arg)},
    )


def behaviors_of(built: Built) -> set[str]:
    return {i for i, n in built.needs.items() if n["type"] == "behavior" and i.startswith("SM-")}


def test_defs_with_item_builds_only_that_item(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = page_build(tmp_path, capfd, "SM-ONE")
    assert built.code == 0
    assert {i for i in built.needs if i.startswith("SM-")} == {
        "SM-ONE",
        "SM-ONE-01",
        "SM-ONE-02",
        "SM-ONE-03",
    }


def test_defs_common_builds_only_common_behaviors(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = page_build(tmp_path, capfd, "common")
    assert built.code == 0
    assert {i for i in built.needs if i.startswith("SM-")} == {"SM-COMMON-01"}


def test_defs_with_unknown_id_warns(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    built = page_build(tmp_path, capfd, "SM-NOPE")
    assert "SM-NOPE" in built.warnings
    assert not {i for i in built.needs if i.startswith("SM-")}


def test_page_with_only_defs_shows_verifies_links_and_failed(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = page_build(tmp_path, capfd, "SM-TWO")
    assert built.code == 0
    html = built.html("page.html")
    assert "failed" in html
    case_id = next(
        i
        for i in built.needs["SM-TWO-02"]["verifies_back"]
        if built.needs[i]["title"] == "test_broken"
    )
    assert re.search(rf'<a [^>]*href="index\.html#{case_id}"', html, flags=re.S)


def case(result: str) -> Case:
    return Case(
        classname="c",
        name="n",
        time=0.0,
        result=result,
        message="",
        text="",
        type="",
    )


@pytest.mark.parametrize(
    ("results", "expected"),
    [
        ([], "not run"),
        (["passed"], "passed"),
        (["passed", "passed"], "passed"),
        (["passed", "failed"], "failed"),
        (["error"], "failed"),
        (["passed", "skipped"], "not run"),
        (["disabled"], "not run"),
    ],
)
def test_outcome_of(results: list[str], expected: str) -> None:
    assert outcome_of([case(r) for r in results]) == expected
