"""iface_defs 拡張のテスト。小さいリポジトリの形の fixture を Sphinx で実際にビルドし、needs.json・HTML・警告を読む。"""

import html
import json
import os
import re
import runpy
import shutil
import sys
from pathlib import Path
from typing import Any

import pytest
from docutils import core as docutils_core
from docutils import nodes as docutils_nodes
from sphinx.cmd.build import build_main

DOCS = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(DOCS / "_ext"))

from iface_defs import (  # noqa: E402
    COMMAND_TITLE,
    COMMON_OUTPUT_TITLE,
    MCP_FIELDS_EMPTY,
    PLUGIN_KEY,
    common_output_label,
    interface_plugins,
    render_sections,
    report_cell,
    report_href,
)
from site_stamp import SiteStamp, SiteStampError, site_stamp  # noqa: E402


@pytest.fixture(autouse=True)
def no_site_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # conf.py は外の PECOT_SITE_* を読むので、テストの結果が端末の環境で変わらないようにする。
    for key in list(os.environ):
        if key.startswith("PECOT_SITE_"):
            monkeypatch.delenv(key)


INDEX = """\
Sample
======

.. iface-defs:: sample

.. needtable::
   :columns: id;title
"""


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
    capfd: pytest.CaptureFixture[str],
    files: dict[str, str] | None = None,
    pages: bool = False,
    site: dict[str, str] | None = None,
    plugins: tuple[str, ...] = ("sample",),
    root: Path = FIXTURES / "repo",
) -> Built:
    src = tmp_path / "src"
    src.mkdir(exist_ok=True)
    (src / "index.rst").write_text(INDEX, encoding="utf-8")
    for name, text in (files or {}).items():
        (src / name).parent.mkdir(parents=True, exist_ok=True)
        (src / name).write_text(text, encoding="utf-8")
    stamp = site_stamp(site or {}, plugins).context()
    context = {"site": stamp}
    report = {"url": stamp["report_url"], "plugins": stamp["report_plugins"]}
    (src / "conf.py").write_text(
        "import runpy\n"
        f"_ns = runpy.run_path({str(DOCS / 'conf.py')!r})\n"
        "globals().update({k: v for k, v in _ns.items() if not k.startswith('__')})\n"
        f"iface_root = {str(root)!r}\n"
        f"iface_pages = {pages!r}\n"
        f"html_context = {context!r}\n"
        f"iface_report = {report!r}\n"
        f"templates_path = [{str(DOCS / '_templates')!r}]\n",
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
    return build(tmp_path, capfd)


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


SECTION_TITLES = ["使用例", "引数", "出力", "エラー"]


def _heading(title: str) -> str:
    return f"**{title}**"


def test_sections_appear_in_order_and_empty_ones_are_left_out(full: Built) -> None:
    content: str = full.needs["SM-ONE"]["content"]
    positions = [content.index(_heading(title)) for title in SECTION_TITLES]
    assert positions == sorted(positions)
    body: str = full.needs["SM-TWO"]["content"]
    assert "ありません。" not in body
    for title in ("前提条件", "環境変数", "使用例"):
        assert _heading(title) not in body, title


def test_prerequisites_join_the_description_and_environment_is_not_shown(full: Built) -> None:
    content: str = full.needs["SM-ONE"]["content"]
    assert content.index("Stops at the first failure.") < content.index("Needs the sample runtime.")
    assert content.index("Needs the sample runtime.") < content.index(_heading("使用例"))
    assert "SAMPLE_HOME" not in content
    assert _heading("前提条件") not in content and _heading("環境変数") not in content


def test_page_headings_run_through_requirements_in_one_order(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(tmp_path, capfd, files={"index.rst": PAGES_INDEX}, pages=True)
    assert built.code == 0
    # 定義書の behaviors は 1 件以上（schema.ts の min(1)）なので、どのページも「機能要件」で終わる。
    for page in ("one-run", "sample_two"):
        html = built.html(f"_generated/sample/{page}.html")
        headings = re.findall(r"<h2>(.*?)<a ", html, flags=re.S)
        present = [t for t in SECTION_TITLES if t in headings]
        assert headings == [*present, "機能要件"], page
    assert "使用例" in re.findall(
        r"<h2>(.*?)<a ", built.html("_generated/sample/one-run.html"), flags=re.S
    )


def test_failures_table_always_has_three_columns(full: Built) -> None:
    filled: str = full.needs["SM-ONE"]["content"]
    assert "エラー名" in filled and "終了コード" in filled
    assert "target-missing" in filled
    empty: str = full.needs["SM-TWO"]["content"]
    assert "エラー名" not in empty
    assert _heading("エラー") not in empty


def test_every_table_is_wrapped_in_a_scroll_region(full: Built) -> None:
    html = full.html()
    tables = html.count("<table")
    assert tables > 0
    # テーマの後処理（BeautifulSoup）が属性の順を並べ替えるので、順を問わずに見る。
    # 表の id の目印（空の span）が、包みと表の間に入ることがある。
    wrappers = re.findall(r"<div([^>]*)>\s*(?:<span[^>]*></span>\s*)*<table", html)
    expected = ['class="pecot-table-scroll"', 'role="region"', 'tabindex="0"', 'aria-label="']
    assert len([w for w in wrappers if all(a in w for a in expected)]) == tables


def test_broken_entries_become_warnings_and_are_skipped(full: Built) -> None:
    assert "SM-BAD" in full.warnings
    assert "SM-HALF-01" in full.warnings
    assert "SM-BAD" not in full.needs
    assert "SM-HALF-01" not in full.needs
    assert full.code == 0


PAGES_INDEX = """\
Sample
======

.. iface-index:: sample

.. toctree::
   :hidden:
   :glob:

   _generated/sample/*
"""


def test_index_table_links_each_page(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    built = build(tmp_path, capfd, files={"index.rst": PAGES_INDEX}, pages=True)
    assert built.code == 0
    page = built.html()
    (head,) = re.findall(r"<thead>(.*?)</thead>", page, flags=re.S)
    assert re.findall(r"<th[^>]*><p>([^<]*)</p></th>", head) == ["表示名", "ツール名", "説明", "型"]
    rows = {
        name: href
        for href, name in re.findall(
            r'<td><p><a class="reference internal" href="([^"]+)"><span[^>]*>([^<]+)</span></a></p></td>',
            page,
        )
    }
    assert rows == {
        "one run": "_generated/sample/one-run.html",
        "Sample two": "_generated/sample/sample_two.html",
        "half entry": "_generated/sample/half-entry.html",
    }


DEFS_ONLY = "Sample\n======\n\n.. iface-defs:: sample\n"


def test_requirement_tables_have_id_and_requirement_columns(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(tmp_path, capfd, files={"index.rst": DEFS_ONLY})
    assert built.code == 0
    page = built.html()
    heads = re.findall(r"<thead>(.*?)</thead>", page, flags=re.S)
    behaviors = [h for h in heads if "要件" in h]
    assert behaviors
    for head in behaviors:
        assert re.findall(r"<th[^>]*><p>([^<]*)</p></th>", head) == ["ID", "要件"]
    for word in ("テスト結果", "未実行", "成功", "失敗したテスト", "スキップしたテスト"):
        assert word not in page, word
    assert 'id="SM-ONE-01"' in page


def test_pages_are_written_and_stale_ones_removed(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    generated = tmp_path / "src" / "_generated"
    (generated / "sample").mkdir(parents=True)
    (generated / "sample" / "old-name.rst").write_text("Old\n===\n", encoding="utf-8")
    (generated / "gone").mkdir()
    (generated / "gone" / "x.rst").write_text("X\n=\n", encoding="utf-8")
    built = build(tmp_path, capfd, files={"index.rst": PAGES_INDEX}, pages=True)
    assert built.code == 0
    assert {p.name for p in (generated / "sample").glob("*.rst")} == {
        "one-run.rst",
        "sample_two.rst",
        "half-entry.rst",
    }
    assert not (generated / "gone").exists()
    assert ".. iface-defs:: sample SM-ONE" in (generated / "sample" / "one-run.rst").read_text(
        encoding="utf-8"
    )


def test_pages_are_written_only_for_plugins_with_generated_json(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    root = tmp_path / "repo"
    shutil.copytree(FIXTURES / "repo", root)
    (root / "plugins" / "bare" / ".claude-plugin").mkdir(parents=True)
    (root / "plugins" / "bare" / ".claude-plugin" / "plugin.json").write_text(
        "{}", encoding="utf-8"
    )
    (root / "plugins" / "half" / "interface").mkdir(parents=True)
    (root / "plugins" / "half" / "interface" / "authored.yaml").write_text("{}", encoding="utf-8")
    built = build(tmp_path, capfd, files={"index.rst": PAGES_INDEX}, pages=True, root=root)
    assert built.code == 0
    assert interface_plugins(root) == ["sample"]
    assert sorted(p.name for p in (tmp_path / "src" / "_generated").iterdir()) == ["sample"]


def test_permalink_reaches_each_item_on_its_page(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(tmp_path, capfd, files={"index.rst": PAGES_INDEX}, pages=True)
    assert built.code == 0
    # permalink.html は needs.json を読み、項目の docname の HTML へ移る。
    assert "loadJSON('needs.json'" in built.html("permalink.html")
    item = "SM-ONE-02"
    docname = built.needs[item]["docname"]
    assert docname != "index"
    assert f'id="{item}"' in built.html(f"{docname}.html")


PAGE_ONLY = """\
Page
====

.. iface-defs:: sample {arg}
"""


def page_build(tmp_path: Path, capfd: pytest.CaptureFixture[str], arg: str) -> Built:
    index = "Sample\n======\n\n.. toctree::\n\n   page\n"
    return build(tmp_path, capfd, files={"index.rst": index, "page.rst": PAGE_ONLY.format(arg=arg)})


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


def test_requirement_rows_carry_the_id(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    built = page_build(tmp_path, capfd, "SM-TWO")
    assert built.code == 0
    page = built.html("page.html")
    assert re.search(r'<tr[^>]*id="SM-TWO-02"', page)
    assert behavior_heads(page) == [["ID", "要件"]]


# ---------------------------------------------------------------- site_stamp

PR_ENV = {"PECOT_SITE_SIDE": "pr", "PECOT_SITE_PR": "612"}
REPORT = "test-report/index.html"
PLUGINS = ("pecot-tools", "pecot-visual", "pecot-workflow")
NO_REPORT: dict[str, object] = {"report_url": None, "report_plugins": [], "report_missing": []}


def test_site_stamp_defaults_to_local() -> None:
    assert site_stamp({}) == SiteStamp(side="local", pr=None)


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        (
            {},
            {
                "side": "local",
                "notice": "これはローカルでビルドしたドキュメントです。",
                "pr_url": None,
                "release_url": None,
                **NO_REPORT,
            },
        ),
        (
            {"PECOT_SITE_SIDE": "dev"},
            {
                "side": "dev",
                "notice": "これは開発中のバージョンのドキュメントです。",
                "pr_url": None,
                "release_url": "/pecot/",
                "report_url": REPORT,
                "report_plugins": list(PLUGINS),
                "report_missing": [],
            },
        ),
        (
            PR_ENV,
            {
                "side": "pr",
                "notice": "これはプルリクエスト #612 のプレビューです。",
                "pr_url": "https://github.com/pecotcraft/pecot/pull/612",
                "release_url": "/pecot/",
                **NO_REPORT,
            },
        ),
        (
            {"PECOT_SITE_SIDE": "release"},
            {
                "side": "release",
                "notice": None,
                "pr_url": None,
                "release_url": None,
                "report_url": None,
                "report_plugins": [],
                "report_missing": list(PLUGINS),
            },
        ),
    ],
)
def test_site_context_per_side(env: dict[str, str], expected: dict[str, object]) -> None:
    assert site_stamp(env, PLUGINS).context() == expected


@pytest.mark.parametrize(
    ("value", "url", "plugins", "missing"),
    [
        (
            " pecot-workflow , pecot-visual ",
            REPORT,
            ["pecot-workflow", "pecot-visual"],
            ["pecot-tools"],
        ),
        ("pecot-tools,pecot-visual,pecot-workflow", REPORT, list(PLUGINS), []),
        ("", None, [], list(PLUGINS)),
        (" , ", None, [], list(PLUGINS)),
    ],
)
def test_site_context_reads_report_plugins_on_release(
    value: str, url: str | None, plugins: list[str], missing: list[str]
) -> None:
    env = {"PECOT_SITE_SIDE": "release", "PECOT_SITE_REPORT_PLUGINS": value}
    context = site_stamp(env, PLUGINS).context()
    assert (context["report_url"], context["report_plugins"], context["report_missing"]) == (
        url,
        plugins,
        missing,
    )


@pytest.mark.parametrize("env", [{}, {"PECOT_SITE_SIDE": "dev"}, PR_ENV])
def test_site_context_ignores_report_plugins_off_release(env: dict[str, str]) -> None:
    plain = site_stamp(env, PLUGINS).context()
    given = site_stamp({**env, "PECOT_SITE_REPORT_PLUGINS": "pecot-tools"}, PLUGINS).context()
    assert given == plain


@pytest.mark.parametrize(
    ("env", "names"),
    [
        ({"PECOT_SITE_SIDE": "pr"}, "PECOT_SITE_PR"),
        ({"PECOT_SITE_SIDE": "pr", "PECOT_SITE_PR": "#612"}, "PECOT_SITE_PR"),
        ({"PECOT_SITE_SIDE": "staging"}, "PECOT_SITE_SIDE"),
    ],
)
def test_site_stamp_fails_on_bad_values(env: dict[str, str], names: str) -> None:
    with pytest.raises(SiteStampError, match=names):
        site_stamp(env)


def notice_of(built: Built, page: str = "index.html") -> str | None:
    found = re.search(r'<div class="pecot-site"[\s\S]*?</div>\s*</div>', built.html(page))
    return found.group(0) if found else None


def links_of(notice: str) -> dict[str, str]:
    return {
        html.unescape(re.sub(r"<[^>]+>", "", text)).strip(): html.unescape(href)
        for href, text in re.findall(r'<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>', notice)
    }


def text_of(notice: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", notice))).strip()


def test_local_page_has_notice_without_links(full: Built) -> None:
    assert full.code == 0, full.warnings
    notice = notice_of(full)
    assert notice is not None
    assert text_of(notice) == "これはローカルでビルドしたドキュメントです。"
    assert links_of(notice) == {}


def test_pr_notice_links_pr_and_release(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    built = build(tmp_path, capfd, site=PR_ENV)
    assert built.code == 0, built.warnings
    notice = notice_of(built)
    assert notice is not None
    assert text_of(notice) == (
        "これはプルリクエスト #612 のプレビューです。 プルリクエストを開く 最新のリリース版を見る"
    )
    assert links_of(notice) == {
        "プルリクエストを開く": "https://github.com/pecotcraft/pecot/pull/612",
        "最新のリリース版を見る": "/pecot/",
    }


def test_dev_notice_links_release(tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    built = build(tmp_path, capfd, site={"PECOT_SITE_SIDE": "dev"})
    assert built.code == 0, built.warnings
    notice = notice_of(built)
    assert notice is not None
    assert text_of(notice) == "これは開発中のバージョンのドキュメントです。 最新のリリース版を見る"


def test_release_has_no_notice_and_no_footer_values(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(tmp_path, capfd, site={"PECOT_SITE_SIDE": "release"})
    assert built.code == 0, built.warnings
    assert notice_of(built) is None
    assert "pecot-build" not in built.html("index.html")


def test_footer_has_logo_links_and_copyright(full: Built) -> None:
    assert full.code == 0, full.warnings
    found = re.search(r"<footer[\s\S]*?</footer>", full.html("index.html"))
    assert found
    footer = found.group(0)
    assert "pecot-icon-light.svg" in footer
    assert links_of(footer) == {
        "": "#",  # ロゴは画像だけのリンクで、トップでは自分を指す
        "GitHub": "https://github.com/pecotcraft/pecot",
        "ライセンス": "https://github.com/pecotcraft/pecot/blob/main/LICENSE",
    }
    assert "© 2026 pecotcraft" in text_of(footer)


# ---------------------------------------------------------------- テストレポートへのリンク


def footer_of(built: Built, page: str = "index.html") -> str:
    found = re.search(r"<footer[\s\S]*?</footer>", built.html(page))
    assert found
    return found.group(0)


def plain_of(part: str) -> str:
    """タグを除いた文字。タグの所に空白を入れないので、リンクとそのそばの文字がつながる。"""
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", part)).split())


def report_links(page: str) -> dict[str, str]:
    """機能要件の表の行の ID → その行の「テスト」のリンクの先。"""
    rows = re.findall(r'<tr[^>]*id="([^"]+)"[^>]*>(.*?)</tr>', page, flags=re.S)
    return {
        row_id: href for row_id, body in rows if (href := links_of(body).get("テスト")) is not None
    }


def behavior_heads(page: str) -> list[list[str]]:
    heads = re.findall(r"<thead>(.*?)</thead>", page, flags=re.S)
    return [re.findall(r"<th[^>]*><p>([^<]*)</p></th>", h) for h in heads if "要件" in h]


DEV = {"PECOT_SITE_SIDE": "dev"}


def test_dev_links_footer_and_each_requirement_to_the_report(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "dev").mkdir()
    (tmp_path / "local").mkdir()
    built = build(tmp_path / "dev", capfd, files={"index.rst": DEFS_ONLY}, site=DEV)
    assert built.code == 0, built.warnings
    # fixture がもともと出す警告のほかに、リンクの重複などの警告を出さない。
    local = build(tmp_path / "local", capfd, files={"index.rst": DEFS_ONLY})
    assert built.warnings.replace("/dev/", "/") == local.warnings.replace("/local/", "/")
    assert links_of(footer_of(built))["テストレポート"] == REPORT
    assert "含みません" not in footer_of(built)
    page = built.html()
    assert behavior_heads(page) and all(
        head == ["ID", "要件", "テスト"] for head in behavior_heads(page)
    )
    ids = behaviors_of(built)
    assert ids
    assert report_links(page) == {i: f"{REPORT}?tags={i}" for i in ids}


def test_report_column_sits_beside_the_requirement(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(tmp_path, capfd, files={"index.rst": DEFS_ONLY}, site=DEV)
    assert built.code == 0, built.warnings
    page = built.html()
    assert behavior_heads(page)
    assert all(head == ["ID", "要件", "テスト"] for head in behavior_heads(page))
    assert report_links(page)["SM-TWO-02"] == f"{REPORT}?tags=SM-TWO-02"


def test_report_links_on_generated_pages_point_to_the_side_root(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(tmp_path, capfd, files={"index.rst": PAGES_INDEX}, pages=True, site=DEV)
    assert built.code == 0, built.warnings
    page = "_generated/sample/one-run.html"
    assert links_of(footer_of(built, page))["テストレポート"] == f"../../{REPORT}"
    assert report_links(built.html(page)) == {
        i: f"../../{REPORT}?tags={i}" for i in ("SM-ONE-01", "SM-ONE-02", "SM-ONE-03")
    }


def test_release_links_only_plugins_in_the_report_and_names_the_rest(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    site = {"PECOT_SITE_SIDE": "release", "PECOT_SITE_REPORT_PLUGINS": "sample"}
    built = build(
        tmp_path,
        capfd,
        files={"index.rst": DEFS_ONLY},
        site=site,
        plugins=("other", "pecot-x", "sample"),
    )
    assert built.code == 0, built.warnings
    footer = footer_of(built)
    assert links_of(footer)["テストレポート"] == REPORT
    assert "テストレポート（other、pecot-x は含みません）" in plain_of(footer)
    assert report_links(built.html()) == {i: f"{REPORT}?tags={i}" for i in behaviors_of(built)}


def test_release_does_not_link_items_of_a_plugin_left_out_of_the_report(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    site = {"PECOT_SITE_SIDE": "release", "PECOT_SITE_REPORT_PLUGINS": "other"}
    built = build(
        tmp_path,
        capfd,
        files={"index.rst": DEFS_ONLY},
        site=site,
        plugins=("other", "sample"),
    )
    assert built.code == 0, built.warnings
    footer = footer_of(built)
    assert links_of(footer)["テストレポート"] == REPORT
    assert "テストレポート（sample は含みません）" in plain_of(footer)
    page = built.html()
    assert report_links(page) == {}
    assert all(head == ["ID", "要件"] for head in behavior_heads(page))


@pytest.mark.parametrize(
    "site",
    [
        {"PECOT_SITE_SIDE": "release", "PECOT_SITE_REPORT_PLUGINS": ""},
        {"PECOT_SITE_SIDE": "release"},
        PR_ENV,
        {},
    ],
    ids=["release-empty", "release-unset", "pr", "local"],
)
def test_sides_without_report_show_neither_link(
    tmp_path: Path, capfd: pytest.CaptureFixture[str], site: dict[str, str]
) -> None:
    built = build(tmp_path, capfd, files={"index.rst": DEFS_ONLY}, site=site)
    assert built.code == 0, built.warnings
    footer = footer_of(built)
    assert "テストレポート" not in footer
    assert "含みません" not in footer
    page = built.html()
    assert report_links(page) == {}
    assert "test-report" not in page
    assert all(head == ["ID", "要件"] for head in behavior_heads(page))


@pytest.mark.parametrize(
    ("docname", "behavior_id", "expected"),
    [
        ("index", "SM-ONE-01", f"{REPORT}?tags=SM-ONE-01"),
        ("reference/tools/sample", "PW_X.1", f"../../{REPORT}?tags=PW_X.1"),
        ("_generated/sample/one-run", "SM-ONE-01", f"../../{REPORT}?tags=SM-ONE-01"),
        ("index", "SM ONE", None),
        ("index", "SM&ONE", None),
        ("index", "SM-ÖNE", None),
    ],
)
def test_report_href_is_relative_to_the_page_and_takes_only_safe_ids(
    docname: str, behavior_id: str, expected: str | None
) -> None:
    assert report_href(docname, REPORT, behavior_id) == expected


def test_report_cell_keeps_a_trailing_underscore_in_the_url() -> None:
    # 末尾の _ を打ち消さないと、docutils が URL を参照の名前と読み、未定義のリンクのエラーになる。
    nodes = docutils_core.publish_doctree(report_cell(f"{REPORT}?tags=SM_ONE_"))
    (reference,) = list(nodes.findall(docutils_nodes.reference))
    assert reference["refuri"] == f"{REPORT}?tags=SM_ONE_"
    assert reference.astext() == "テスト"


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
    assert COMMON_OUTPUT_TITLE not in text


def test_mcp_without_tool_fields_says_there_is_nothing() -> None:
    text = _output_section(_mcp_entry({}))
    assert MCP_FIELDS_EMPTY == "ツールごとに返す項目はありません。"
    assert MCP_FIELDS_EMPTY in text
    assert "項目名" not in text


_BOTH = {"cli": {"path": ["sample", "run"]}, "mcp": {"tool": "sample_tool"}}
_CLI_REFERENCE = {"examples": [{"run": "pecot sample run x --force", "note": "x を動かします。"}]}


def _both_entry(**extra: Any) -> dict[str, Any]:
    """CLI と MCP の両方の面を持つ項目。extra に cli_reference などを足す。"""
    return {
        **_mcp_entry({"branch": {"type": "string"}}),
        "surfaces": _BOTH,
        "input": {
            "type": "object",
            "properties": {"target": {"type": "string"}, "force": {"type": "boolean"}},
            "required": ["target"],
        },
        "cli": {"positional": ["target"], "flags": {"force": ["--force", "-f"]}},
        "exit_status": [{"kind": "target-missing", "code": 2, "when": "対象がありません。"}],
        "examples": [{"arguments": {"target": "x", "force": True}, "note": "x を動かします。"}],
        **extra,
    }


def test_stdout_sentence_is_not_in_the_output_of_mcp_entries() -> None:
    entry = _mcp_entry({"branch": {"type": "string"}})
    assert "標準出力" not in _output_section(entry)
    assert "標準出力" not in _output_section(_both_entry())
    assert "標準出力" not in _output_section(_both_entry(cli_reference=_CLI_REFERENCE))


def test_mcp_arguments_use_mcparg_and_examples_are_tools_call_params() -> None:
    sections = dict(render_sections(_both_entry()))
    arguments = "\n".join(sections["引数"])
    assert ".. mcparg:: target" in arguments and ".. mcparg:: force" in arguments
    assert ".. option::" not in arguments
    assert "--force" not in arguments
    examples = "\n".join(sections["使用例"])
    assert ".. code-block:: json" in examples
    body = examples.split(".. code-block:: json", 1)[1]
    assert json.loads(body) == {"name": "sample_tool", "arguments": {"target": "x", "force": True}}


def test_exit_code_column_and_command_section_are_only_for_cli_reference() -> None:
    plain = dict(render_sections(_both_entry()))
    assert "終了コード" not in "\n".join(plain["エラー"])
    assert COMMAND_TITLE not in plain
    referenced = dict(render_sections(_both_entry(cli_reference=_CLI_REFERENCE)))
    assert "終了コード" in "\n".join(referenced["エラー"])
    command = "\n".join(referenced[COMMAND_TITLE])
    assert "pecot sample run <target> [options]" in command
    assert ".. program:: pecot sample run" in command
    assert ".. option:: --force, -f" in command and ".. option:: <target>" in command
    assert "pecot sample run x --force" in command
    assert "標準出力には何も出しません。" in command
    titles = [title for title, _ in render_sections(_both_entry(cli_reference=_CLI_REFERENCE))]
    assert titles[-1] == COMMAND_TITLE


def test_cli_only_options_show_their_description_and_are_not_mcp_arguments() -> None:
    entry = _both_entry(
        cli={
            "positional": ["target"],
            "flags": {"force": ["--force", "-f"], "dry_run": ["--dry-run", "-n"]},
            "only": {"dry_run": {"type": "boolean"}},
        },
        cli_reference={**_CLI_REFERENCE, "options": {"dry_run": "何も書かずに、予定を出します。"}},
    )
    sections = dict(render_sections(entry))
    assert "dry_run" not in "\n".join(sections["引数"])
    command = sections[COMMAND_TITLE]
    at = command.index(".. option:: --dry-run, -n")
    assert command[at : at + 4] == [
        ".. option:: --dry-run, -n",
        "",
        "   何も書かずに、予定を出します。",
        "",
    ]
    assert "引数 \\ ``dry_run``\\  に当たります。" not in "\n".join(command)
    assert "   引数 \\ ``force``\\  に当たります。" in command


def test_mcp_output_links_to_common_fields_of_the_plugin() -> None:
    entry = {**_mcp_entry({"branch": {"type": "string"}}), PLUGIN_KEY: "sample"}
    text = _output_section(entry)
    assert f":ref:`{COMMON_OUTPUT_TITLE} <{common_output_label('sample')}>`" in text
    assert "型を閉じていません" not in text


COMMON_PAGE = """\
.. _iface-common-output-sample:

出力
====

.. iface-common-output:: sample
"""


def test_common_output_page_has_fields_and_is_linked_from_tool_page(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    files = {"index.rst": PAGES_INDEX + "\n.. toctree::\n\n   common\n", "common.rst": COMMON_PAGE}
    built = build(tmp_path, capfd, files=files, pages=True)
    assert built.code == 0, built.warnings
    section = text_of(built.html("common.html"))
    for name, text in {
        "kind": "失敗の種別です。",
        "detail": "失敗の文です。",
        "log": "子プロセスの出力です。",
        "warnings": "警告の文です。",
    }.items():
        assert name in section
        assert text in section
    page = built.html("_generated/sample/sample_two.html")
    assert f'href="../../common.html#{common_output_label("sample")}"' in page
    assert (
        '<code class="docutils literal notranslate"><span class="pre">kind</span></code>'
        not in page
    )


def test_resources_table_uses_summary_or_description(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    files = {
        "index.rst": PAGES_INDEX + "\n.. toctree::\n\n   resources\n",
        "resources.rst": "Resources\n=========\n\n.. iface-resources:: sample\n",
    }
    built = build(tmp_path, capfd, files=files, pages=True)
    assert built.code == 0, built.warnings
    page = built.html("resources.html")
    headers = re.findall(r'<th class="head"><p>(.*?)</p></th>', page)
    assert headers == ["URI", "名前", "説明", "MIME タイプ"]
    rows = [
        [text_of(cell) for cell in re.findall(r"<td><p>(.*?)</p></td>", row, re.S)]
        for row in re.findall(r"<tr class=\"row-(?:odd|even)\">(.*?)</tr>", page, re.S)
        if "<td>" in row
    ]
    assert rows == [
        ["sample://note/one", "note-one", "1 つ目のメモです。", "text/markdown"],
        ["sample://note/two", "note-two", "The second note.", "text/markdown"],
    ]


# ---------------------------------------------------------------- サイトに載せるプラグイン

REPO = DOCS.parents[2]


def test_interface_plugins_are_the_plugins_in_targets_json() -> None:
    targets = json.loads((DOCS.parent / "targets.json").read_text(encoding="utf-8"))
    assert interface_plugins(REPO) == sorted(targets["plugins"])


def test_conf_lists_the_interface_plugins_on_the_site(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PECOT_SITE_SIDE", "dev")
    conf = runpy.run_path(str(DOCS / "conf.py"))
    assert conf["_site"]["report_plugins"] == interface_plugins(REPO)


def test_tool_page_title_is_the_display_name_with_the_tool_name_below(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    built = build(tmp_path, capfd, files={"index.rst": PAGES_INDEX}, pages=True)
    assert built.code == 0
    page = built.html("_generated/sample/sample_two.html")
    assert re.search(r"<h1>Sample two<a ", page)
    assert re.search(r'<p class="iface-tool-name">.*sample_two', page)
    # 表示名の無い CLI だけの項目は、name を題にして、添え書きを出さない
    one = built.html("_generated/sample/one-run.html")
    assert re.search(r"<h1>one run<a ", one)
    assert "iface-tool-name" not in one
