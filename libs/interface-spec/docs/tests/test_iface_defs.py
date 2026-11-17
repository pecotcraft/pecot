"""iface_defs 拡張のテスト。小さいリポジトリの形の fixture を Sphinx で実際にビルドし、needs.json・HTML・警告を読む。"""

import fnmatch
import html
import json
import re
import sys
from pathlib import Path
from typing import Any, cast

import pytest
from sphinx.cmd.build import build_main

DOCS = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(DOCS / "_ext"))

from iface_defs import (  # noqa: E402
    MCP_FIELDS_EMPTY,
    MCP_FIELDS_OPEN,
    Case,
    load_junit_lanes,
    outcome_of,
    render_sections,
)

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
JUNIT_NOTES = FIXTURES / "junit" / "vitest-notes.xml"
JUNIT_OVERLAP = FIXTURES / "junit" / "vitest-overlap.xml"
# 合否のレーン（target）→ JUnit。conf.py の iface_junit のプラグインごとの値と同じ形。
LANES = {"sample:test-vitest": JUNIT_VITEST, "sample:test-pytest": JUNIT_PYTEST}


class Built:
    def __init__(self, out: Path, code: int, warnings: str, stdout: str, stderr: str) -> None:
        self.out = out
        self.code = code
        self.warnings = warnings
        self.stdout = stdout
        self.stderr = stderr
        self.needs: dict[str, dict[str, Any]] = {}
        if (out / "needs.json").is_file():
            data: dict[str, Any] = json.loads((out / "needs.json").read_text(encoding="utf-8"))
            versions: dict[str, Any] = data["versions"]
            self.needs = next(iter(versions.values()))["needs"]

    def html(self, page: str = "index.html") -> str:
        return (self.out / page).read_text(encoding="utf-8")


def build(
    tmp_path: Path,
    junit: dict[str, Path],
    capfd: pytest.CaptureFixture[str],
    files: dict[str, str] | None = None,
    pages: bool = False,
    strict: bool = False,
) -> Built:
    src = tmp_path / "src"
    src.mkdir(exist_ok=True)
    (src / "index.rst").write_text(INDEX, encoding="utf-8")
    for name, text in (files or {}).items():
        (src / name).parent.mkdir(parents=True, exist_ok=True)
        (src / name).write_text(text, encoding="utf-8")
    junit_map = {"sample": {lane: str(p) for lane, p in junit.items()}}
    (src / "conf.py").write_text(
        "import runpy\n"
        f"_ns = runpy.run_path({str(DOCS / 'conf.py')!r})\n"
        "globals().update({k: v for k, v in _ns.items() if not k.startswith('__')})\n"
        f"iface_root = {str(FIXTURES / 'repo')!r}\n"
        f"iface_junit = {junit_map!r}\n"
        f"iface_pages = {pages!r}\n"
        f"iface_strict = {strict!r}\n",
        encoding="utf-8",
    )
    out = tmp_path / "out"
    warnings = tmp_path / "warnings.txt"
    code = build_main(
        ["-b", "html", "-w", str(warnings), "-d", str(tmp_path / "doctrees"), str(src), str(out)]
    )
    captured = capfd.readouterr()
    text = warnings.read_text(encoding="utf-8") if warnings.exists() else ""
    return Built(out, code, text, captured.out, captured.err)


@pytest.fixture
def full(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> Built:
    return build(tmp_path, LANES, capfd)


def outcomes_of(built: Built) -> dict[str, str]:
    return {
        i: n["outcome"]
        for i, n in built.needs.items()
        if i.startswith("SM-") and n["type"] == "behavior"
    }


def broken_junit(tmp_path: Path) -> Path:
    path = tmp_path / "broken.xml"
    path.write_text("<testsuites><testsuite", encoding="utf-8")
    return path


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


SECTION_TITLES = ["使用例", "前提条件", "引数", "出力", "エラー", "環境変数"]


def _heading(title: str) -> str:
    return f"**{title}**"


def test_every_section_heading_appears_in_order_even_when_empty(full: Built) -> None:
    for need_id in ("SM-ONE", "SM-TWO"):
        content: str = full.needs[need_id]["content"]
        positions = [content.index(_heading(title)) for title in SECTION_TITLES]
        assert positions == sorted(positions)
    body: str = full.needs["SM-TWO"]["content"]
    assert f"{_heading('使用例')}\n\nありません。" in body.replace("\r", "")


def test_page_headings_run_through_requirements_in_one_order(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(tmp_path, LANES, capfd, files={"index.rst": PAGES_INDEX}, pages=True)
    assert built.code == 0
    # 定義書の behaviors は 1 件以上（schema.ts の min(1)）なので、実物の全ページで「機能要件」が付き、並びは 1 通りになる。
    for page in ("one-run", "sample_two"):
        html = built.html(f"_generated/sample/{page}.html")
        headings = re.findall(r"<h2>(.*?)<a ", html, flags=re.S)
        assert headings == [*SECTION_TITLES, "機能要件"], page


def test_failures_table_always_has_three_columns(full: Built) -> None:
    filled: str = full.needs["SM-ONE"]["content"]
    assert "エラー名" in filled and "終了コード" in filled
    assert "target-missing" in filled
    empty: str = full.needs["SM-TWO"]["content"]
    assert "エラー名" not in empty
    assert f"{_heading('エラー')}\n\nありません。" in empty.replace("\r", "")


def test_outcomes(full: Built) -> None:
    # レーンがそろっているので、つながるケースが 0 件の項目は no-test、すべて skipped の項目は skipped。
    assert outcomes_of(full) == {
        "SM-ONE-01": "passed",
        "SM-ONE-02": "passed",
        "SM-ONE-03": "no-test",
        "SM-TWO-01": "passed",
        "SM-TWO-02": "failed",
        "SM-TWO-03": "no-test",
        "SM-COMMON-01": "skipped",
    }


def test_outcome_is_shown_with_symbol_and_text(full: Built) -> None:
    html = full.html()
    for label in ("✓ 通った", "✗ 落ちた", "− 飛ばした", "– テストが無い"):
        assert label in html
    assert re.search(r'class="[^"]*iface-no-test[^"]*">– テストが無い<', html)


def test_missing_lane_makes_every_item_not_run(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    lanes = {**LANES, "sample:test-gone": tmp_path / "missing.xml"}
    built = build(tmp_path, lanes, capfd)
    assert built.code == 0
    assert set(outcomes_of(built).values()) == {"not-run"}
    html = built.html()
    assert (
        "次のレーンの JUnit が無いか読めません。このプラグインの項目は未実行です: sample:test-gone"
        in html
    )
    assert "\N{QUESTION MARK} 未実行" in html
    # そろったレーンのテストの表は出す。
    assert any(n["type"] == "testcase" for n in built.needs.values())


def test_unreadable_lane_is_missing_too(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    lanes = {**LANES, "sample:test-broken": broken_junit(tmp_path)}
    built = build(tmp_path, lanes, capfd)
    assert built.code == 0
    assert set(outcomes_of(built).values()) == {"not-run"}
    assert "このプラグインの項目は未実行です: sample:test-broken" in built.html()


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
    built = build(tmp_path, {"sample:test-cli": tmp_path / "missing.xml"}, capfd)
    assert built.code == 0
    assert set(outcomes_of(built).values()) == {"not-run"}
    assert "このプラグインの項目は未実行です: sample:test-cli" in built.html()
    assert not [n for n in built.needs.values() if n["type"] == "testcase"]


def test_junit_without_connected_cases(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    plain = tmp_path / "plain.xml"
    plain.write_text(
        '<testsuites><testsuite name="s" tests="1" failures="0" errors="0" skipped="0">'
        '<testcase classname="c" name="n" time="0.1"/></testsuite></testsuites>',
        encoding="utf-8",
    )
    built = build(tmp_path, {"sample:test-cli": plain}, capfd)
    assert built.code == 0
    assert set(outcomes_of(built).values()) == {"no-test"}
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
    built = build(tmp_path, LANES, capfd, files={"index.rst": PAGES_INDEX}, pages=True)
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
    # 並びは data-model.md の Outcome の表の順。0 件の状態は出さない。
    assert rows == {
        "one run": ("_generated/sample/one-run.html", "– テストが無い 1・✓ 通った 2"),
        "sample_two": (
            "_generated/sample/sample_two.html",
            "– テストが無い 1・✗ 落ちた 1・✓ 通った 1",
        ),
        "half entry": ("_generated/sample/half-entry.html", "—"),
    }


OVERVIEW_INDEX = """\
Top
===

.. iface-overview::

.. toctree::
   :hidden:

   reference/tools/sample
"""


def test_overview_counts_states_per_plugin(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(
        tmp_path,
        LANES,
        capfd,
        files={"index.rst": OVERVIEW_INDEX, "reference/tools/sample.rst": INDEX},
    )
    assert built.code == 0
    rows = re.findall(
        r'<td><p><a class="reference internal" href="([^"]+)"><span[^>]*>([^<]+)</span></a></p></td>'
        r"\s*<td><p>([^<]*)</p></td>",
        built.html(),
        flags=re.S,
    )
    assert rows == [
        (
            "reference/tools/sample.html",
            "sample",
            "– テストが無い 2・✗ 落ちた 1・✓ 通った 3・− 飛ばした 1",
        )
    ]


DEFS_ONLY = "Sample\n======\n\n.. iface-defs:: sample\n"


def test_same_case_in_two_junits_counts_once_and_heavier_wins(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    lanes = {
        **LANES,
        "sample:test-overlap": JUNIT_OVERLAP,
        "sample:test-overlap-again": JUNIT_OVERLAP,
    }
    built = build(tmp_path, lanes, capfd, files={"index.rst": DEFS_ONLY})
    assert built.code == 0
    got = outcomes_of(built)
    # vitest.xml では passed・skipped のケースが、重なりの JUnit では failed・passed。重い方を残す。
    assert got["SM-TWO-01"] == "failed"
    assert got["SM-COMMON-01"] == "passed"
    html = built.html()
    assert _list_items(html, "落ちたケース") == [
        "SM-TWO-01 sample_two > 呼ぶと、2 つを返す（tests/sample.test.ts）: dup-fail",
        "SM-TWO-02 test_broken（tests.test_one.TestTwo）: boom",
    ]
    assert "飛ばしたケース" not in html


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
    built = build(tmp_path, LANES, capfd, files={"index.rst": PAGES_INDEX}, pages=True)
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


def page_build(
    tmp_path: Path,
    capfd: pytest.CaptureFixture[str],
    arg: str,
    lanes: dict[str, Path] | None = None,
) -> Built:
    index = "Sample\n======\n\n.. toctree::\n\n   page\n\n.. iface-tests:: sample\n"
    return build(
        tmp_path,
        lanes or LANES,
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


def _details(html: str) -> str:
    return "\n".join(re.findall(r"<details[^>]*>.*?</details>", html, flags=re.S))


def _list_items(page: str, rubric: str) -> list[str]:
    """rubric の見出しの直後の箇条書きの項目の文字（タグを除く）。"""
    after = page.split(f">{rubric}</p>", 1)[1]
    listing = re.search(r"<ul[^>]*>(.*?)</ul>\s*(?:<p class=\"rubric|</section|$)", after, re.S)
    assert listing is not None
    items = re.findall(r"<li>(.*?)</li>", listing.group(1), flags=re.S)
    texts = [re.sub(r"<details.*?</details>|<[^>]+>", "", i, flags=re.S) for i in items]
    return [" ".join(html.unescape(t).split()) for t in texts]


def test_failed_cases_show_summary_and_fold_the_body(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = page_build(tmp_path, capfd, "SM-TWO", {**LANES, "sample:test-notes": JUNIT_NOTES})
    assert built.code == 0
    # 本文のバッククォートと行頭の .. が rst として読まれると、警告が出る。
    page_warnings = [
        w
        for w in built.warnings.splitlines()
        if "page.rst" in w and "SM-BAD" not in w and "SM-HALF" not in w
    ]
    assert page_warnings == []
    html = built.html("page.html")
    items = _list_items(html, "落ちたケース")
    assert items == [
        "SM-TWO-02 test_broken（tests.test_one.TestTwo）: boom",
        "SM-TWO-02 sample_two > 読めないと、失敗を返す（tests/notes.test.ts）: expected ok to be ng",
        "SM-TWO-02 sample_two > 要旨の無い失敗（tests/notes.test.ts）: Error: no message here",
        "SM-TWO-02 sample_two > 要旨の無いエラー（tests/notes.test.ts）: TypeError: x is undefined",
    ]
    folded = _details(html)
    assert ".. note:: not a directive" in folded
    assert "❯ tests/notes.test.ts:12:5" in folded
    assert "at write (src/two.ts:3:1)" in folded
    assert "at read (src/two.ts:9:1)" in folded
    assert "❯ tests/notes.test.ts:12:5" not in re.sub(
        r"<details.*?</details>", "", html, flags=re.S
    )


def test_passed_item_lists_its_skipped_cases(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = page_build(tmp_path, capfd, "SM-TWO", {**LANES, "sample:test-notes": JUNIT_NOTES})
    assert outcomes_of(built)["SM-TWO-01"] == "passed"
    assert _list_items(built.html("page.html"), "飛ばしたケース") == [
        "SM-TWO-01 sample_two > 後で確かめる（tests/notes.test.ts）"
    ]


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
    ("complete", "results", "expected"),
    [
        (False, [], "not-run"),
        (False, ["passed"], "not-run"),
        (False, ["failed"], "not-run"),
        (True, [], "no-test"),
        (True, ["passed", "failed"], "failed"),
        (True, ["error"], "failed"),
        (True, ["skipped", "failed"], "failed"),
        (True, ["passed"], "passed"),
        (True, ["passed", "skipped"], "passed"),
        (True, ["disabled", "passed"], "passed"),
        (True, ["skipped"], "skipped"),
        (True, ["skipped", "disabled"], "skipped"),
    ],
)
def test_outcome_of(complete: bool, results: list[str], expected: str) -> None:
    assert outcome_of([case(r) for r in results], complete) == expected


# ---------------------------------------------------------------- iface_strict


def test_strict_fails_naming_missing_and_unreadable_lanes(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    lanes = {
        **LANES,
        "sample:test-gone": tmp_path / "missing.xml",
        "sample:test-broken": broken_junit(tmp_path),
    }
    built = build(tmp_path, lanes, capfd, strict=True)
    assert built.code != 0
    assert "sample:test-gone" in built.stderr
    assert "sample:test-broken" in built.stderr
    assert "sample:test-vitest" not in built.stderr


def test_without_strict_missing_lanes_do_not_fail(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    lanes = {**LANES, "sample:test-gone": tmp_path / "missing.xml"}
    assert build(tmp_path, lanes, capfd).code == 0


def test_strict_passes_when_every_lane_is_read(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    assert build(tmp_path, LANES, capfd, strict=True).code == 0


_COMMON = {
    "kind": {"type": "string"},
    "detail": {"type": "string"},
    "log": {"type": "string"},
    "warnings": {"type": "array"},
}


def _mcp_entry(
    fields: dict[str, Any], mcp_output: dict[str, Any] | None = None, *, closed: bool = True
) -> dict[str, Any]:
    output: dict[str, Any] = {"type": "object", "properties": {**fields, **_COMMON}}
    if closed:
        output["additionalProperties"] = False
    entry: dict[str, Any] = {
        "surfaces": {"mcp": {"tool": "sample_tool"}},
        "output": {"format": "none"},
        "mcp": {"output": output},
    }
    if mcp_output is not None:
        entry["mcp_output"] = mcp_output
    return entry


def _output_section(entry: dict[str, Any]) -> str:
    return "\n".join(dict(render_sections(entry))["出力"])


def test_mcp_fields_table_uses_authored_text_and_skips_common_fields() -> None:
    fields = {
        "branch": {"type": "string", "description": "Branch created"},
        "stackedOn": {
            "anyOf": [{"type": "integer"}, {"type": "null"}],
            "description": "Stacked",
        },
        "dryRun": {"type": "boolean", "const": True},
    }
    text = _output_section(_mcp_entry(fields, {"fields": {"branch": "作ったブランチ"}}))
    assert "作ったブランチ" in text
    assert "Branch created" not in text
    assert "integer \\| null" in text
    assert "     - true" in text
    for name in ("kind", "detail", "log", "warnings", "artifacts"):
        assert f"``{name}``" not in text
    assert MCP_FIELDS_OPEN.split("（")[0] not in text


def test_mcp_without_tool_fields_says_there_is_nothing() -> None:
    text = _output_section(_mcp_entry({}))
    assert MCP_FIELDS_EMPTY == "ツールごとに返す項目はありません。"
    assert MCP_FIELDS_EMPTY in text
    assert "項目名" not in text


def test_mcp_open_output_says_other_fields_are_returned() -> None:
    text = _output_section(_mcp_entry({}, closed=False))
    assert MCP_FIELDS_OPEN == "このほかの項目も返します（型を閉じていません）。"
    assert MCP_FIELDS_OPEN in text
    assert MCP_FIELDS_EMPTY not in text


# ---------------------------------------------------------------- junit-lanes.json

REPO = DOCS.parents[2]


def test_real_junit_lanes_group_by_plugin() -> None:
    table = load_junit_lanes(DOCS / "junit-lanes.json", REPO)
    assert table == {
        "pecot-workflow": {
            "pecot-workflow:test-cli": str(
                REPO / "plugins/pecot-workflow/cli/test-results/junit.xml"
            ),
            "pecot-workflow:test-hooks": str(
                REPO / "plugins/pecot-workflow/cli/test-results/junit-hooks.xml"
            ),
        },
        "pecot-tools": {
            "pecot-tools:test-cli": str(REPO / "plugins/pecot-tools/cli/test-results/junit.xml")
        },
        "pecot-visual": {
            "pecot-visual:test-cli": str(REPO / "plugins/pecot-visual/cli/test-results/junit.xml")
        },
    }


def _lane(target: str, junit: str, plugin: str | None = None) -> dict[str, str]:
    return {"plugin": plugin or target.split(":")[0], "target": target, "junit": junit}


def _lanes_repo(tmp_path: Path, lanes: list[Any], outputs: list[str] | None = None) -> Path:
    project = tmp_path / "plugins" / "p"
    project.mkdir(parents=True)
    targets = {
        "test-a": {"outputs": outputs or ["{projectRoot}/a.xml"]},
        "test-b": {"outputs": ["{projectRoot}/b.xml"]},
    }
    (project / "project.json").write_text(json.dumps({"targets": targets}), encoding="utf-8")
    path = tmp_path / "junit-lanes.json"
    path.write_text(json.dumps(lanes), encoding="utf-8")
    return path


def test_junit_lanes_resolve_paths_from_outputs(tmp_path: Path) -> None:
    path = _lanes_repo(
        tmp_path, [_lane("p:test-a", "plugins/p/a.xml"), _lane("p:test-b", "plugins/p/b.xml")]
    )
    assert load_junit_lanes(path, tmp_path) == {
        "p": {
            "p:test-a": str(tmp_path / "plugins/p/a.xml"),
            "p:test-b": str(tmp_path / "plugins/p/b.xml"),
        }
    }


@pytest.mark.parametrize(
    ("lanes", "outputs", "message"),
    [
        ([{"plugin": "p", "target": "p:test-a"}], None, "#1"),
        ([_lane("p-test-a", "plugins/p/a.xml", "p")], None, "p-test-a"),
        ([_lane("p:test-a", "plugins/p/a.xml", "q")], None, "p:test-a"),
        (
            [_lane("p:test-a", "plugins/p/a.xml"), _lane("p:test-a", "plugins/p/b.xml")],
            None,
            "#2 p:test-a",
        ),
        (
            [_lane("p:test-a", "plugins/p/a.xml"), _lane("p:test-b", "plugins/p/a.xml")],
            ["{projectRoot}/a.xml"],
            "#2 p:test-b",
        ),
        ([_lane("q:test-a", "plugins/q/a.xml")], None, "q:test-a"),
        ([_lane("p:test-z", "plugins/p/a.xml")], None, "p:test-z"),
        ([_lane("p:test-a", "plugins/p/a.xml")], ["{options.out}/a.xml"], "{options.out}"),
        ([_lane("p:test-a", "plugins/p/x.xml")], None, "plugins/p/x.xml"),
    ],
    ids=[
        "missing-key",
        "target-form",
        "plugin-mismatch",
        "duplicate-target",
        "duplicate-junit",
        "no-project",
        "no-target",
        "unknown-token",
        "not-in-outputs",
    ],
)
def test_junit_lanes_reject_broken_lanes(
    tmp_path: Path, lanes: list[Any], outputs: list[str] | None, message: str
) -> None:
    path = _lanes_repo(tmp_path, lanes, outputs)
    with pytest.raises(ValueError, match=re.escape(message)):
        load_junit_lanes(path, tmp_path)


def test_junit_lanes_reject_non_array_file(tmp_path: Path) -> None:
    path = _lanes_repo(tmp_path, [])
    path.write_text(json.dumps({"lanes": []}), encoding="utf-8")
    with pytest.raises(ValueError, match="レーンの配列ではありません"):
        load_junit_lanes(path, tmp_path)


def test_junit_lanes_reject_non_array_outputs(tmp_path: Path) -> None:
    path = _lanes_repo(tmp_path, [_lane("p:test-a", "plugins/p/a.xml")])
    project_json = tmp_path / "plugins/p/project.json"
    project_json.write_text(
        json.dumps({"targets": {"test-a": {"outputs": "{projectRoot}/a.xml"}}}), encoding="utf-8"
    )
    with pytest.raises(
        ValueError, match=re.escape("p:test-a (plugins/p/a.xml)") + ".*配列ではありません"
    ):
        load_junit_lanes(path, tmp_path)


def test_lane_targets_have_no_default_outputs() -> None:
    """load_junit_lanes は project.json の outputs だけを読むので、nx.json の targetDefaults が outputs を足さないことを確かめる。"""
    defaults = cast(
        "dict[str, dict[str, Any]]",
        json.loads((REPO / "nx.json").read_text(encoding="utf-8"))["targetDefaults"],
    )
    for lane in json.loads((DOCS / "junit-lanes.json").read_text(encoding="utf-8")):
        project, _, name = lane["target"].partition(":")
        project_json = json.loads(
            (REPO / "plugins" / project / "project.json").read_text(encoding="utf-8")
        )
        executor = project_json["targets"][name].get("executor")
        for key, value in defaults.items():
            if key == executor or fnmatch.fnmatchcase(name, key):
                assert "outputs" not in value, (
                    f"nx.json の targetDefaults['{key}'] が {lane['target']} に outputs を足す"
                )
