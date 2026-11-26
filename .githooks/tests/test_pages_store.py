"""pages_site/store.py のテスト。側の確かめ（SideCheck）と、保管ブランチの組み立て・push（StoreLayout）。"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tarfile
from collections.abc import Callable
from pathlib import Path
from types import ModuleType

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
_STORE = _REPO / ".githooks/scripts/pages_site/store.py"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("pages_store", _STORE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["pages_store"] = module
    spec.loader.exec_module(module)
    return module


store = _load()


# --- SideCheck -------------------------------------------------------------


def _add_file(tar: tarfile.TarFile, name: str, body: str = "") -> None:
    data = body.encode()
    info = tarfile.TarInfo(name)
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))


def _add(tar: tarfile.TarFile, name: str, kind: bytes, linkname: str = "") -> None:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = linkname
    tar.addfile(info)


def _tar(tmp_path: Path, build: Callable[[tarfile.TarFile], None]) -> Path:
    path = tmp_path / "side.tar"
    with tarfile.open(path, "w") as tar:
        build(tar)
    return path


def _page(*links: str) -> str:
    anchors = "".join(f'<a href="{link}">x</a>' for link in links)
    return f"<html><head></head><body>{anchors}</body></html>"


def _sphinx_like(tar: tarfile.TarFile) -> None:
    _add(tar, ".", tarfile.DIRTYPE)
    _add(tar, "./guides", tarfile.DIRTYPE)
    _add_file(
        tar,
        "./index.html",
        '<html><head><link rel="stylesheet" href="_static/pygments.css?v=e72c8e07">'
        '<script src="_static/doc.js"></script></head><body>'
        '<a href="#content">skip</a><a href="guides/">guides</a>'
        '<a href="guides/a.html#sec">a</a><a href="_sources/index.rst.txt">source</a>'
        '<a href="https://github.com/pecotcraft/pecot">gh</a><a href="//cdn.example/x.js">cdn</a>'
        '<a href="mailto:a@example.com">mail</a><a href="/pecot/dev/">dev</a>'
        '<a href="/pecot/pr/9/">pr</a><a href="?q=1">self</a><a href="">empty</a></body></html>',
    )
    _add_file(tar, "./_static/pygments.css", "")
    _add_file(tar, "./_static/doc.js", "")
    _add_file(tar, "./_sources/index.rst.txt", "")
    _add_file(tar, "./guides/index.html", _page("../index.html", "a.html", "../_static/doc.js"))
    _add_file(tar, "./guides/a.html", _page("./", "../", "index.html#top", "%61.html"))


def test_side_check_passes_sphinx_like_tree(tmp_path: Path) -> None:
    # `./` 始まり・クエリ・断片・ディレクトリへのリンク・外の URL・/pecot/ の行き来はどれも問題にしない。
    # Sphinx は _sources を出す（html_copy_source の既定）。実物の _build でも切れたリンクは無かった。
    assert store.side_check(_tar(tmp_path, _sphinx_like)) == []


@pytest.mark.parametrize(
    ("member", "kind", "linkname", "expected"),
    [
        ("/etc/passwd", tarfile.REGTYPE, "", "`/etc/passwd`: 絶対パスです"),
        ("./a/../../x", tarfile.REGTYPE, "", "`./a/../../x`: `..` を含みます"),
        ("./link", tarfile.SYMTYPE, "/etc/passwd", "`./link`: シンボリックリンクです"),
        ("./hard", tarfile.LNKTYPE, "index.html", "`./hard`: ハードリンクです"),
        (
            "./fifo",
            tarfile.FIFOTYPE,
            "",
            "`./fifo`: 通常のファイルとディレクトリのどちらでもありません",
        ),
        (
            "./dev0",
            tarfile.CHRTYPE,
            "",
            "`./dev0`: 通常のファイルとディレクトリのどちらでもありません",
        ),
        (
            "./blk",
            tarfile.BLKTYPE,
            "",
            "`./blk`: 通常のファイルとディレクトリのどちらでもありません",
        ),
    ],
)
def test_side_check_rejects_unsafe_members(
    tmp_path: Path, member: str, kind: bytes, linkname: str, expected: str
) -> None:
    def build(tar: tarfile.TarFile) -> None:
        _add_file(tar, "./index.html", _page())
        if kind == tarfile.REGTYPE:
            _add_file(tar, member, "x")
        else:
            _add(tar, member, kind, linkname)

    assert store.side_check(_tar(tmp_path, build)) == [expected]


def test_side_check_rejects_broken_internal_links(tmp_path: Path) -> None:
    def build(tar: tarfile.TarFile) -> None:
        _add_file(
            tar,
            "./index.html",
            _page("missing.html", "nodir/", "../outside.html", "/other/x.html", "/pecot/nowhere/"),
        )
        _add_file(tar, "./sub/page.html", '<img src="../img/none.png">')

    assert store.side_check(_tar(tmp_path, build)) == [
        "`index.html`: `missing.html` の先がありません",
        "`index.html`: `nodir/` の先がありません",
        "`index.html`: `../outside.html` は側の外を指します",
        "`index.html`: `/other/x.html` はサイトの外の絶対パスです",
        "`sub/page.html`: `../img/none.png` の先がありません",
    ]


_REPORT_LINKS = (
    "test-report/index.html",
    "test-report/index.html?tags=PW-A-01",
    "test-report/",
    "./test-report/index.html#x",
)


def _with_report_links(tar: tarfile.TarFile) -> None:
    _add_file(tar, "./index.html", _page(*_REPORT_LINKS))
    # _generated の下のページは、側のルートまで戻ってからレポートを指す。
    _add_file(tar, "./_generated/p/tool.html", _page("../../test-report/index.html?tags=PW-B-02"))


def test_side_check_lets_report_links_through_only_when_asked(tmp_path: Path) -> None:
    tar = _tar(tmp_path, _with_report_links)
    assert store.side_check(tar, report_links=True) == []
    assert store.side_check(tar) == [
        "`_generated/p/tool.html`: `../../test-report/index.html?tags=PW-B-02` の先がありません",
        *(f"`index.html`: `{link}` の先がありません" for link in _REPORT_LINKS),
    ]


def test_side_check_report_links_still_check_other_links(tmp_path: Path) -> None:
    tar = _tar(tmp_path, lambda t: _add_file(t, "./index.html", _page("test-reports/x.html")))
    assert store.side_check(tar, report_links=True) == [
        "`index.html`: `test-reports/x.html` の先がありません"
    ]


def test_side_check_with_report_links_refuses_a_test_report_dir(tmp_path: Path) -> None:
    def build(tar: tarfile.TarFile) -> None:
        _add_file(tar, "./index.html", _page("test-report/index.html"))
        _add(tar, "./test-report", tarfile.DIRTYPE)
        _add_file(tar, "./test-report/index.html", "own")
        _add_file(tar, "./test-report/history.jsonl", "")

    tar = _tar(tmp_path, build)
    assert store.side_check(tar, report_links=True) == [
        "`./test-report`: `test-report/` は保管でレポートを置く所です"
    ]
    # PR 版は保管でレポートを置かないので、側の中身として扱う。
    assert store.side_check(tar) == []


def _report_tree(tar: tarfile.TarFile, history: str = '{"uuid":"a"}\n{"uuid":"b"}\n') -> None:
    _add(tar, ".", tarfile.DIRTYPE)
    _add_file(tar, "./index.html", '<html><script src="app.js"></script></html>')
    _add_file(tar, "./app.js", "")
    _add(tar, "./data", tarfile.DIRTYPE)
    _add_file(tar, "./data/a.json", "{}")
    _add_file(tar, "./history.jsonl", history)


def test_report_check_passes_a_report_tree(tmp_path: Path) -> None:
    assert store.report_check(_tar(tmp_path, _report_tree)) == []


def test_report_check_passes_an_empty_history(tmp_path: Path) -> None:
    assert store.report_check(_tar(tmp_path, lambda t: _report_tree(t, ""))) == []


@pytest.mark.parametrize(
    ("missing", "expected"),
    [
        ("./index.html", "`index.html` がありません"),
        ("./history.jsonl", "`history.jsonl` がありません"),
    ],
)
def test_report_check_needs_index_and_history(tmp_path: Path, missing: str, expected: str) -> None:
    def build(tar: tarfile.TarFile) -> None:
        for name, body in (("./index.html", "<html></html>"), ("./history.jsonl", "")):
            if name != missing:
                _add_file(tar, name, body)

    assert store.report_check(_tar(tmp_path, build)) == [expected]


@pytest.mark.parametrize(
    ("history", "expected"),
    [
        ('{"a":1}\nNaN\n{"b":2}\n', "`history.jsonl` の 2 行目を Allure が読めません"),
        ('{"a":1}\nnull\n', "`history.jsonl` の 2 行目を Allure が読めません"),
        # Node の readline は U+2028 でも切るので、文字列の途中で行が切れる。
        ('{"a":"x\u2028y"}\n', "`history.jsonl` の 1, 2 行目を Allure が読めません"),
    ],
    ids=["nan", "null", "u2028"],
)
def test_report_check_refuses_unreadable_history_lines(
    tmp_path: Path, history: str, expected: str
) -> None:
    assert store.report_check(_tar(tmp_path, lambda t: _report_tree(t, history))) == [expected]


def test_report_check_refuses_history_that_is_not_utf8(tmp_path: Path) -> None:
    def build(tar: tarfile.TarFile) -> None:
        _add_file(tar, "./index.html", "<html></html>")
        info = tarfile.TarInfo("./history.jsonl")
        info.size = 2
        tar.addfile(info, io.BytesIO(b"\xff\n"))

    assert store.report_check(_tar(tmp_path, build)) == ["`history.jsonl` が UTF-8 ではありません"]


def test_report_check_also_runs_side_check(tmp_path: Path) -> None:
    def build(tar: tarfile.TarFile) -> None:
        _report_tree(tar)
        _add(tar, "./link", tarfile.SYMTYPE, "/etc/passwd")

    assert store.report_check(_tar(tmp_path, build)) == ["`./link`: シンボリックリンクです"]


def test_check_cli_prints_markdown_and_fails(tmp_path: Path) -> None:
    tar = _tar(tmp_path, lambda t: _add_file(t, "./index.html", _page("gone.html")))
    result = run_attached(
        [sys.executable, str(_STORE), "check", str(tar)], capture_output=True, text=True
    )
    assert (result.returncode, result.stdout) == (
        1,
        "- `index.html`: `gone.html` の先がありません\n",
    )


@pytest.mark.parametrize(
    ("args", "code"),
    [
        ((), 1),
        (("--side", "pr"), 1),
        (("--side", "dev"), 0),
        (("--kind", "site", "--side", "release"), 0),
    ],
)
def test_check_cli_chooses_the_check_by_kind_and_side(
    tmp_path: Path, args: tuple[str, ...], code: int
) -> None:
    tar = _tar(tmp_path, _with_report_links)
    result = run_attached(
        [sys.executable, str(_STORE), "check", *args, str(tar)], capture_output=True, text=True
    )
    assert result.returncode == code, result.stdout + result.stderr


def test_check_cli_report_uses_report_check(tmp_path: Path) -> None:
    tar = _tar(tmp_path, lambda t: _add_file(t, "./index.html", "<html></html>"))
    result = run_attached(
        [sys.executable, str(_STORE), "check", "--kind", "report", "--side", "dev", str(tar)],
        capture_output=True,
        text=True,
    )
    assert (result.returncode, result.stdout) == (1, "- `history.jsonl` がありません\n")


def test_checker_follows_kind_and_side(tmp_path: Path) -> None:
    links = _tar(tmp_path, _with_report_links)
    assert store.checker("site", "dev")(links) == []
    assert store.checker("site", "release")(links) == []
    assert store.checker("site", "pr")(links) != []
    assert store.checker("report", "dev") is store.report_check
    assert store.checker("report", "release") is store.report_check


def test_extract_uses_the_given_check(tmp_path: Path) -> None:
    tar = _tar(tmp_path, _with_report_links)
    with pytest.raises(ValueError, match="test-report/index.html"):
        store.extract(tar, tmp_path / "pr", check=store.side_check)
    assert not (tmp_path / "pr").exists()
    store.extract(tar, tmp_path / "dev", check=store.checker("site", "dev"))
    assert (tmp_path / "dev" / "_generated/p/tool.html").is_file()


def test_extract_writes_checked_tree(tmp_path: Path) -> None:
    dest = tmp_path / "out"
    store.extract(_tar(tmp_path, _sphinx_like), dest, check=store.side_check)
    assert (dest / "guides/a.html").read_text(encoding="utf-8").startswith("<html>")
    assert sorted(p.relative_to(dest).as_posix() for p in dest.rglob("*") if p.is_file()) == [
        "_sources/index.rst.txt",
        "_static/doc.js",
        "_static/pygments.css",
        "guides/a.html",
        "guides/index.html",
        "index.html",
    ]


def test_extract_refuses_unsafe_tar(tmp_path: Path) -> None:
    tar = _tar(tmp_path, lambda t: _add(t, "./link", tarfile.SYMTYPE, "/etc/passwd"))
    with pytest.raises(ValueError, match="シンボリックリンク"):
        store.extract(tar, tmp_path / "out", check=store.side_check)
    assert not (tmp_path / "out").exists()


# --- StoreLayout -----------------------------------------------------------


def _tree(base: Path, name: str, links: tuple[str, ...] = ()) -> Path:
    tree = base / name
    (tree / "sub").mkdir(parents=True)
    (tree / "index.html").write_text(_page(*links), encoding="utf-8")
    (tree / "sub" / "page.html").write_text(name, encoding="utf-8")
    return tree


def _rec(sha: str) -> dict[str, object]:
    return {"sha": sha, "run_id": "1", "stored_at": "2026-11-18T00:00:00Z"}


def _files(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): p.read_text(encoding="utf-8")
        for p in sorted(root.rglob("*"))
        if p.is_file() and ".git" not in p.relative_to(root).parts
    }


def _meta(root: Path) -> dict[str, object]:
    return json.loads((root / ".pecot-store.json").read_text(encoding="utf-8"))


_BAND = ("/pecot/", "/pecot/dev/")


def test_empty_store_gets_guide_pages_without_links(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    store.apply(root, side="none", pr=None, tree=None, record=None, open_prs=[])
    files = _files(root)
    assert sorted(files) == [
        ".pecot-store.json",
        "dev/index.html",
        "dev/test-report/index.html",
        "index.html",
        "test-report/index.html",
    ]
    assert _meta(root) == {"release": None, "dev": None, "pr": {}, "reports": {}}
    for page in ("index.html", "dev/index.html", "test-report/index.html"):
        assert '<html lang="ja">' in files[page]
        assert "公開している版はまだありません。" in files[page]
        assert "href" not in files[page] and "src=" not in files[page]
    assert files["dev/test-report/index.html"] == files["test-report/index.html"]
    assert "<h1>テストレポートはまだありません</h1>" in files["test-report/index.html"]
    assert store.check_cross_links(root) == []


def test_dev_only_guides_release_to_dev(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    tree = _tree(tmp_path, "dev-tree", _BAND)
    store.apply(root, side="dev", pr=None, tree=tree, record=_rec("d1"), open_prs=[])
    files = _files(root)
    assert sorted(files) == [
        ".pecot-store.json",
        "dev/index.html",
        "dev/sub/page.html",
        "dev/test-report/index.html",
        "index.html",
        "test-report/index.html",
    ]
    assert "<h1>リリース版はまだありません</h1>" in files["index.html"]
    assert '<a href="/pecot/dev/">開発版</a>' in files["index.html"]
    assert '<a href="/pecot/">' not in files["index.html"]
    for page in ("test-report/index.html", "dev/test-report/index.html"):
        assert '<a href="/pecot/dev/">開発版</a>' in files[page]
        assert '<a href="/pecot/">' not in files[page]
    assert _meta(root) == {"release": None, "dev": _rec("d1"), "pr": {}, "reports": {}}
    assert store.check_cross_links(root) == []


def test_release_only_guides_dev_to_release(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    tree = _tree(tmp_path, "rel-tree", _BAND)
    record = {**_rec("r1"), "sources": {"skeleton": "s"}}
    store.apply(root, side="release", pr=None, tree=tree, record=record, open_prs=[])
    files = _files(root)
    assert "<h1>開発版はまだありません</h1>" in files["dev/index.html"]
    assert '<a href="/pecot/">リリース版</a>' in files["dev/index.html"]
    assert files["sub/page.html"] == "rel-tree"
    assert _meta(root)["release"] == record
    assert store.check_cross_links(root) == []


def test_release_rewrite_keeps_dev_and_pr(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    store.apply(
        root, side="dev", pr=None, tree=_tree(tmp_path, "dev1"), record=_rec("d1"), open_prs=None
    )
    store.apply(
        root, side="pr", pr=7, tree=_tree(tmp_path, "pr7"), record=_rec("p7"), open_prs=None
    )
    store.apply(
        root,
        side="release",
        pr=None,
        tree=_tree(tmp_path, "rel1"),
        record=_rec("r1"),
        open_prs=None,
    )
    (root / "stale.html").write_text("old", encoding="utf-8")
    store.apply(
        root,
        side="release",
        pr=None,
        tree=_tree(tmp_path, "rel2"),
        record=_rec("r2"),
        open_prs=None,
    )
    files = _files(root)
    assert sorted(files) == [
        ".pecot-store.json",
        "dev/index.html",
        "dev/sub/page.html",
        "dev/test-report/index.html",
        "index.html",
        "pr/7/index.html",
        "pr/7/sub/page.html",
        "sub/page.html",
        "test-report/index.html",
    ]
    assert (files["sub/page.html"], files["dev/sub/page.html"], files["pr/7/sub/page.html"]) == (
        "rel2",
        "dev1",
        "pr7",
    )
    assert _meta(root) == {
        "release": _rec("r2"),
        "dev": _rec("d1"),
        "pr": {"7": _rec("p7")},
        "reports": {},
    }


def test_dev_rewrite_touches_only_dev_and_record(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    store.apply(
        root,
        side="release",
        pr=None,
        tree=_tree(tmp_path, "rel1"),
        record=_rec("r1"),
        open_prs=None,
    )
    store.apply(
        root, side="dev", pr=None, tree=_tree(tmp_path, "dev1"), record=_rec("d1"), open_prs=None
    )
    (root / "dev" / "stale.html").write_text("old", encoding="utf-8")
    before = {k: v for k, v in _files(root).items() if not k.startswith("dev/") and k[0] != "."}
    store.apply(
        root, side="dev", pr=None, tree=_tree(tmp_path, "dev2"), record=_rec("d2"), open_prs=None
    )
    after = _files(root)
    assert {k: v for k, v in after.items() if not k.startswith("dev/") and k[0] != "."} == before
    assert sorted(k for k in after if k.startswith("dev/")) == [
        "dev/index.html",
        "dev/sub/page.html",
        "dev/test-report/index.html",
    ]
    assert after["dev/sub/page.html"] == "dev2"
    assert _meta(root) == {"release": _rec("r1"), "dev": _rec("d2"), "pr": {}, "reports": {}}


# --- レポートの置き場所 -------------------------------------------------------


def _report(base: Path, name: str, history: str = '{"uuid":"a"}\n') -> Path:
    tree = base / name
    (tree / "data").mkdir(parents=True)
    (tree / "index.html").write_text(f"<html>{name}</html>", encoding="utf-8")
    (tree / "data" / "a.json").write_text(name, encoding="utf-8")
    (tree / "history.jsonl").write_text(history, encoding="utf-8")
    return tree


def _sites(root: Path, tmp_path: Path) -> None:
    for side, pr in (("release", None), ("dev", None), ("pr", 7)):
        store.apply(
            root,
            side=side,
            pr=pr,
            tree=_tree(tmp_path, f"{side}-site", _BAND),
            record=_rec(f"{side[0]}1"),
            open_prs=None,
        )


@pytest.mark.parametrize(("side", "prefix"), [("dev", "dev/"), ("release", "")])
def test_report_changes_only_its_test_report_and_record(
    tmp_path: Path, side: str, prefix: str
) -> None:
    root = tmp_path / "store"
    root.mkdir()
    _sites(root, tmp_path)
    before = _files(root)
    meta_before = _meta(root)
    record = _rec("t1")
    store.apply(
        root,
        side=side,
        pr=None,
        tree=_report(tmp_path, "rep1"),
        record=record,
        open_prs=None,
        kind="report",
    )
    after = _files(root)
    place = f"{prefix}test-report/"
    unchanged = {
        k: v for k, v in after.items() if not k.startswith(place) and k != ".pecot-store.json"
    }
    assert unchanged == {
        k: v for k, v in before.items() if not k.startswith(place) and k != ".pecot-store.json"
    }
    assert sorted(k for k in after if k.startswith(place)) == [
        f"{place}data/a.json",
        f"{place}history.jsonl",
        f"{place}index.html",
    ]
    meta = _meta(root)
    assert meta == {**meta_before, "reports": {side: record}}
    assert not any(k.startswith("pr/7/test-report") for k in after)
    assert store.check_cross_links(root) == []


def test_report_replaces_the_previous_report(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    for name in ("rep1", "rep2"):
        tree = _report(tmp_path, name)
        if name == "rep1":
            (tree / "data" / "old.json").write_text("old", encoding="utf-8")
        store.apply(
            root, side="dev", pr=None, tree=tree, record=_rec(name), open_prs=None, kind="report"
        )
    files = _files(root)
    assert sorted(k for k in files if k.startswith("dev/test-report/")) == [
        "dev/test-report/data/a.json",
        "dev/test-report/history.jsonl",
        "dev/test-report/index.html",
    ]
    assert files["dev/test-report/index.html"] == "<html>rep2</html>"
    assert _meta(root)["reports"] == {"dev": _rec("rep2")}


@pytest.mark.parametrize(("side", "prefix"), [("dev", "dev/"), ("release", "")])
def test_site_rewrite_keeps_the_report(tmp_path: Path, side: str, prefix: str) -> None:
    root = tmp_path / "store"
    root.mkdir()
    store.apply(
        root,
        side=side,
        pr=None,
        tree=_report(tmp_path, "rep1", '{"uuid":"a"}\n{"uuid":"b"}\n'),
        record=_rec("t1"),
        open_prs=None,
        kind="report",
    )
    for name in ("site1", "site2"):
        store.apply(
            root,
            side=side,
            pr=None,
            tree=_tree(tmp_path, name, _BAND),
            record=_rec(name),
            open_prs=None,
        )
    files = _files(root)
    assert files[f"{prefix}test-report/history.jsonl"] == '{"uuid":"a"}\n{"uuid":"b"}\n'
    assert files[f"{prefix}test-report/index.html"] == "<html>rep1</html>"
    assert files[f"{prefix}sub/page.html"] == "site2"
    assert _meta(root)["reports"] == {side: _rec("t1")}


def test_dev_report_survives_while_dev_site_is_a_guide(tmp_path: Path) -> None:
    # 定義書の開発版がまだ無い間は、毎回 dev/ を案内のページで作り直す。そのときもレポートは残す。
    root = tmp_path / "store"
    root.mkdir()
    store.apply(
        root,
        side="dev",
        pr=None,
        tree=_report(tmp_path, "rep1"),
        record=_rec("t1"),
        open_prs=None,
        kind="report",
    )
    store.apply(root, side="none", pr=None, tree=None, record=None, open_prs=[])
    files = _files(root)
    assert "<h1>開発版はまだありません</h1>" in files["dev/index.html"]
    assert files["dev/test-report/index.html"] == "<html>rep1</html>"
    assert "<h1>テストレポートはまだありません</h1>" in files["test-report/index.html"]


def test_report_guide_is_replaced_by_the_report(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    store.apply(root, side="none", pr=None, tree=None, record=None, open_prs=[])
    assert "テストレポートはまだありません" in _files(root)["test-report/index.html"]
    store.apply(
        root,
        side="release",
        pr=None,
        tree=_report(tmp_path, "rep1"),
        record=_rec("t1"),
        open_prs=None,
        kind="report",
    )
    files = _files(root)
    assert files["test-report/index.html"] == "<html>rep1</html>"
    assert "テストレポートはまだありません" in files["dev/test-report/index.html"]


@pytest.mark.parametrize("side", ["pr", "none"])
def test_report_refuses_pr_and_none(tmp_path: Path, side: str) -> None:
    root = tmp_path / "store"
    root.mkdir()
    with pytest.raises(ValueError, match="report"):
        store.apply(
            root,
            side=side,
            pr=7 if side == "pr" else None,
            tree=_report(tmp_path, "rep1") if side == "pr" else None,
            record=_rec("t1") if side == "pr" else None,
            open_prs=None,
            kind="report",
        )
    assert not (root / "pr").exists()


@pytest.mark.parametrize("reports", [None, [], "x"])
def test_read_meta_fixes_reports_that_are_not_an_object(tmp_path: Path, reports: object) -> None:
    root = tmp_path / "store"
    root.mkdir()
    meta: dict[str, object] = {"release": None, "dev": None, "pr": {}}
    if reports is not None:
        meta["reports"] = reports
    (root / ".pecot-store.json").write_text(json.dumps(meta), encoding="utf-8")
    assert store.read_meta(root)["reports"] == {}


def test_size_counts_the_reports(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    tree = _report(tmp_path, "rep1", "x" * 3000)
    store.apply(
        root, side="dev", pr=None, tree=tree, record=_rec("t1"), open_prs=None, kind="report"
    )
    store.apply(
        root, side="release", pr=None, tree=tree, record=_rec("t1"), open_prs=None, kind="report"
    )
    # レポートの外（案内のページと .pecot-store.json）は 6000 バイトに届かない。
    outside = sum(
        p.stat().st_size for p in root.rglob("*") if p.is_file() and "test-report" not in p.parts
    )
    assert outside < 6000
    assert store.store_size(root) > 6000
    assert store.size_warning(root, limit=6000) is not None


def test_closed_prs_are_removed(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    for n in (3, 5, 8):
        store.apply(
            root,
            side="pr",
            pr=n,
            tree=_tree(tmp_path, f"pr{n}"),
            record=_rec(f"p{n}"),
            open_prs=None,
        )
    assert store.closed_prs(root, [5]) == [3, 8]
    store.apply(root, side="none", pr=None, tree=None, record=None, open_prs=[5])
    assert sorted(p.name for p in (root / "pr").iterdir()) == ["5"]
    assert _meta(root)["pr"] == {"5": _rec("p5")}
    store.apply(root, side="none", pr=None, tree=None, record=None, open_prs=[])
    assert not (root / "pr").exists()
    assert _meta(root)["pr"] == {}


def test_check_cross_links_reports_missing_targets(tmp_path: Path) -> None:
    root = tmp_path / "store"
    root.mkdir()
    tree = _tree(tmp_path, "dev-tree", ("/pecot/", "/pecot/dev/sub/page.html", "/pecot/pr/4/"))
    store.apply(root, side="dev", pr=None, tree=tree, record=_rec("d1"), open_prs=[])
    (root / "dev" / "sub" / "x.html").write_text(_page("/pecot/pr/4/#a"), encoding="utf-8")
    assert store.check_cross_links(root) == [
        "`/pecot/pr/4/` の先がありません（1 ページ。例: `dev/index.html`）",
        "`/pecot/pr/4/#a` の先がありません（1 ページ。例: `dev/sub/x.html`）",
    ]


def test_check_cross_links_ignores_git_dir(tmp_path: Path) -> None:
    root = tmp_path / "store"
    (root / ".git").mkdir(parents=True)
    (root / ".git" / "x.html").write_text(_page("/pecot/none/"), encoding="utf-8")
    (root / "index.html").write_text(_page("/pecot/.git/x.html"), encoding="utf-8")
    assert store.check_cross_links(root) == [
        "`/pecot/.git/x.html` の先がありません（1 ページ。例: `index.html`）"
    ]


def test_size_warning(tmp_path: Path) -> None:
    root = tmp_path / "store"
    (root / ".git").mkdir(parents=True)
    (root / ".git" / "pack").write_bytes(b"x" * 5000)
    (root / "a.html").write_bytes(b"x" * 1000)
    assert store.size_warning(root, limit=1000) is None
    (root / "b.html").write_bytes(b"x")
    assert store.size_warning(root, limit=1000) == (
        "pages-store の大きさが 0.0 MB で、0.0 MB を超えました（GitHub Pages の上限は 1 GB）"
    )
    assert store.size_warning(root) is None


def test_dev_is_newer() -> None:
    calls: list[tuple[str, str]] = []

    def is_ancestor(older: str, newer: str) -> bool:
        calls.append((older, newer))
        return older == "old"

    assert store.dev_is_newer({"dev": None}, "head", is_ancestor)
    assert store.dev_is_newer({}, "head", is_ancestor)
    assert store.dev_is_newer({"dev": {"sha": "head"}}, "head", is_ancestor)
    assert store.dev_is_newer({"dev": {"sha": "old"}}, "head", is_ancestor)
    assert not store.dev_is_newer({"dev": {"sha": "newer"}}, "head", is_ancestor)
    assert calls == [("old", "head"), ("newer", "head")]


# --- publish ---------------------------------------------------------------

_BOT = "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>"


def _run_git(cwd: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="someone",
        GIT_AUTHOR_EMAIL="someone@example.com",
        GIT_COMMITTER_NAME="someone",
        GIT_COMMITTER_EMAIL="someone@example.com",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
    )
    return run_attached(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.fixture()
def scene(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path | str]:
    # 作者が env に左右されないことも確かめるため、別人の GIT_AUTHOR_* を置いておく。
    monkeypatch.setenv("GIT_AUTHOR_NAME", "someone")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "someone@example.com")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    remote = tmp_path / "remote.git"
    remote.mkdir()
    _run_git(remote, "init", "-q", "--bare")
    history = tmp_path / "history"
    history.mkdir()
    _run_git(history, "init", "-q", "-b", "main")
    shas: list[str] = []
    for i in range(3):
        _run_git(history, "commit", "-q", "--allow-empty", "-m", f"c{i}")
        shas.append(_run_git(history, "rev-parse", "HEAD"))
    return {
        "remote": remote,
        "history": history,
        "c0": shas[0],
        "c1": shas[1],
        "c2": shas[2],
        "tmp": tmp_path,
    }


def _opts(scene: dict[str, Path | str], **over: object) -> object:
    tmp = Path(scene["tmp"])
    work = tmp / f"work-{len(list(tmp.glob('work-*')))}"
    work.mkdir()
    values: dict[str, object] = {
        "remote_url": str(scene["remote"]),
        "side": "dev",
        "pr": None,
        "tree": _tree(work, "tree", _BAND),
        "sha": scene["c1"],
        "run_id": "100",
        "sources": None,
        "open_prs": [],
        "main_ref": "main",
        "history": Path(scene["history"]),
        "workdir": work,
    }
    values.update(over)
    return store.PublishOptions(**values)


def _remote_files(scene: dict[str, Path | str]) -> dict[str, str]:
    out = Path(scene["tmp"]) / f"check-{len(list(Path(scene['tmp']).glob('check-*')))}"
    _run_git(Path(scene["tmp"]), "clone", "-q", "-b", "pages-store", str(scene["remote"]), str(out))
    return _files(out)


def _remote_log(scene: dict[str, Path | str]) -> list[str]:
    log = _run_git(Path(scene["remote"]), "log", "--format=%an <%ae>|%cn <%ce>", "pages-store")
    return log.splitlines()


def test_publish_first_time_creates_orphan_commit(scene: dict[str, Path | str]) -> None:
    code, summary, changed = store.publish(_opts(scene))
    assert (code, changed) == (0, True)
    files = _remote_files(scene)
    assert sorted(files) == [
        ".pecot-store.json",
        "dev/index.html",
        "dev/sub/page.html",
        "dev/test-report/index.html",
        "index.html",
        "test-report/index.html",
    ]
    meta = json.loads(files[".pecot-store.json"])
    assert meta["dev"]["sha"] == scene["c1"] and meta["dev"]["run_id"] == "100"
    assert meta["release"] is None and meta["pr"] == {}
    assert _remote_log(scene) == [f"{_BOT}|{_BOT}"]
    assert "- 側: 開発版" in summary
    assert "- 採否: 保管した" in summary
    assert "- 消した PR の側: なし" in summary
    assert "（1 回目の push）" in summary
    assert "[!WARNING]" not in summary


def test_publish_replaces_and_stays_single_commit(scene: dict[str, Path | str]) -> None:
    assert (
        store.publish(_opts(scene, side="pr", pr=12, sha=scene["c1"], open_prs=[12, 13])).code == 0
    )
    assert store.publish(_opts(scene, side="dev", sha=scene["c1"], open_prs=[12, 13])).code == 0
    code, summary, changed = store.publish(_opts(scene, side="dev", sha=scene["c2"], open_prs=[13]))
    assert code == 0
    files = _remote_files(scene)
    assert sorted(files) == [
        ".pecot-store.json",
        "dev/index.html",
        "dev/sub/page.html",
        "dev/test-report/index.html",
        "index.html",
        "test-report/index.html",
    ]
    meta = json.loads(files[".pecot-store.json"])
    assert meta["dev"]["sha"] == scene["c2"] and meta["pr"] == {}
    assert len(_remote_log(scene)) == 1
    assert "- 消した PR の側: #12" in summary


def test_publish_retries_when_lease_is_stale(scene: dict[str, Path | str]) -> None:
    assert store.publish(_opts(scene, sha=scene["c0"])).code == 0
    intruder = Path(scene["tmp"]) / "intruder"
    _run_git(
        Path(scene["tmp"]), "clone", "-q", "-b", "pages-store", str(scene["remote"]), str(intruder)
    )
    pushes: list[int] = []

    def push_first() -> None:
        if pushes:
            return
        pushes.append(1)
        (intruder / "pr").mkdir()
        (intruder / "pr" / "9").mkdir()
        (intruder / "pr" / "9" / "index.html").write_text("pr9", encoding="utf-8")
        _run_git(intruder, "add", "-A")
        _run_git(intruder, "commit", "-q", "-m", "other store")
        _run_git(intruder, "push", "-q", "origin", "HEAD:pages-store")

    code, summary, changed = store.publish(
        _opts(scene, sha=scene["c1"], open_prs=[9]), before_push=push_first
    )
    assert code == 0
    assert "（2 回目の push）" in summary
    files = _remote_files(scene)
    assert files["pr/9/index.html"] == "pr9"
    assert json.loads(files[".pecot-store.json"])["dev"]["sha"] == scene["c1"]
    assert len(_remote_log(scene)) == 1


def test_publish_skips_older_dev(scene: dict[str, Path | str]) -> None:
    assert store.publish(_opts(scene, sha=scene["c2"])).code == 0
    before = _remote_files(scene)
    code, summary, changed = store.publish(_opts(scene, sha=scene["c1"]))
    assert (code, changed) == (0, False)
    assert "- 採否: 保管しない（新しい開発版が先に保管されています）" in summary
    assert "- pages-store: 書き換えが無いので push しません" in summary
    assert _remote_files(scene) == before


def test_publish_refuses_dev_outside_main(scene: dict[str, Path | str]) -> None:
    history = Path(scene["history"])
    _run_git(history, "checkout", "-q", "-b", "topic")
    _run_git(history, "commit", "-q", "--allow-empty", "-m", "topic")
    topic = _run_git(history, "rev-parse", "HEAD")
    code, summary, changed = store.publish(_opts(scene, sha=topic))
    assert (code, changed) == (1, False)
    assert "が `main` の祖先ではありません" in summary
    assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


def test_publish_refuses_broken_cross_links(scene: dict[str, Path | str]) -> None:
    tree = _tree(Path(scene["tmp"]), "broken", ("/pecot/pr/77/",))
    code, summary, changed = store.publish(_opts(scene, tree=tree))
    assert (code, changed) == (1, False)
    assert "- 側の間のリンクが切れているので push しません" in summary
    assert "`/pecot/pr/77/` の先がありません" in summary
    assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


def test_publish_cli_release_with_sources(scene: dict[str, Path | str]) -> None:
    tmp = Path(scene["tmp"])
    sources = tmp / "release-sources.json"
    sources.write_text(json.dumps({"skeleton": scene["c2"]}), encoding="utf-8")
    tree = _tree(tmp, "rel", _BAND)
    result = run_attached(
        [
            sys.executable,
            str(_STORE),
            "publish",
            "--remote-url",
            str(scene["remote"]),
            "--side",
            "release",
            "--tree",
            str(tree),
            "--sha",
            str(scene["c2"]),
            "--run-id",
            "55",
            "--sources",
            str(sources),
            "--open-prs",
            "[]",
            "--history",
            str(scene["history"]),
            "--workdir",
            # pages-deploy.yml は、まだ無いディレクトリを渡す。
            str(tmp / "not-yet" / "work"),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "- 側: リリース版" in result.stdout
    files = _remote_files(scene)
    meta = json.loads(files[".pecot-store.json"])
    assert meta["release"]["sources"] == {"skeleton": scene["c2"]}
    assert meta["release"]["run_id"] == "55"
    assert "<h1>開発版はまだありません</h1>" in files["dev/index.html"]


def test_publish_none_without_changes_does_not_push(scene: dict[str, Path | str]) -> None:
    assert store.publish(_opts(scene, side="pr", pr=4, open_prs=[4])).code == 0
    head = _run_git(Path(scene["remote"]), "rev-parse", "pages-store")
    code, summary, changed = store.publish(_opts(scene, side="none", tree=None, open_prs=[4]))
    assert (code, changed) == (0, False)
    assert "- 採否: 掃除だけ（側は受けていません）" in summary
    assert "- pages-store: 書き換えが無いので push しません" in summary
    assert _run_git(Path(scene["remote"]), "rev-parse", "pages-store") == head
    code, summary, changed = store.publish(_opts(scene, side="none", tree=None, open_prs=[]))
    assert (code, changed) == (0, True)
    assert "- 消した PR の側: #4" in summary
    assert "pr/4/index.html" not in _remote_files(scene)


def _cli(scene: dict[str, Path | str], *args: str) -> tuple[subprocess.CompletedProcess[str], str]:
    tmp = Path(scene["tmp"])
    output = tmp / f"output-{len(list(tmp.glob('output-*')))}"
    output.write_text("", encoding="utf-8")
    result = run_attached(
        [
            sys.executable,
            str(_STORE),
            "publish",
            "--remote-url",
            str(scene["remote"]),
            "--open-prs",
            "[]",
            "--main-ref",
            "main",
            "--history",
            str(scene["history"]),
            "--workdir",
            str(tmp),
            *args,
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "GITHUB_OUTPUT": str(output)},
    )
    return result, read_output(output)


def test_publish_cli_takes_tar_and_writes_changed(scene: dict[str, Path | str]) -> None:
    tmp = Path(scene["tmp"])
    tar = tmp / "site.tar"
    with tarfile.open(tar, "w") as t:
        _add(t, ".", tarfile.DIRTYPE)
        _add_file(t, "./index.html", _page("sub/a.html", "/pecot/"))
        _add_file(t, "./sub/a.html", "a")
    args = ("--side", "dev", "--tar", str(tar), "--sha", str(scene["c1"]), "--run-id", "7")
    result, output = _cli(scene, *args)
    assert result.returncode == 0, result.stderr
    assert output == "changed=true\n"
    files = _remote_files(scene)
    assert (files["dev/sub/a.html"], json.loads(files[".pecot-store.json"])["dev"]["run_id"]) == (
        "a",
        "7",
    )
    result, output = _cli(scene, "--side", "dev", "--tar", str(tar), "--sha", str(scene["c0"]))
    assert result.returncode == 0, result.stderr
    assert output == "changed=false\n"
    assert "新しい開発版が先に保管されています" in result.stdout


def test_publish_cli_refuses_unsafe_tar(scene: dict[str, Path | str]) -> None:
    tar = Path(scene["tmp"]) / "bad.tar"
    with tarfile.open(tar, "w") as t:
        _add_file(t, "./index.html", _page())
        _add(t, "./link", tarfile.SYMTYPE, "/etc/passwd")
    result, output = _cli(scene, "--side", "dev", "--tar", str(tar), "--sha", str(scene["c1"]))
    assert result.returncode == 1
    assert output == "changed=false\n"
    assert "  - `./link`: シンボリックリンクです" in result.stdout
    assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


def test_publish_pr_changes_only_its_dir_and_record_and_drops_closed_prs(
    scene: dict[str, Path | str],
) -> None:
    # T037: PR 版の保管は pr/N/ と記録だけを変え、開いていない PR の pr/N/ を消す。
    assert store.publish(_opts(scene, side="dev", sha=scene["c1"], open_prs=[5, 12])).code == 0
    assert store.publish(_opts(scene, side="pr", pr=5, sha=scene["c0"], open_prs=[5, 12])).code == 0
    before = _remote_files(scene)
    meta_before = json.loads(before[".pecot-store.json"])
    assert "pr/5/index.html" in before

    code, summary, changed = store.publish(
        _opts(scene, side="pr", pr=12, sha=scene["c2"], run_id="300", open_prs=[12])
    )

    assert (code, changed) == (0, True)
    after = _remote_files(scene)
    outside_pr = {
        k: v for k, v in after.items() if not k.startswith("pr/") and k != ".pecot-store.json"
    }
    assert outside_pr == {
        k: v for k, v in before.items() if not k.startswith("pr/") and k != ".pecot-store.json"
    }
    assert sorted(k for k in after if k.startswith("pr/")) == [
        "pr/12/index.html",
        "pr/12/sub/page.html",
    ]
    meta = json.loads(after[".pecot-store.json"])
    assert (meta["release"], meta["dev"]) == (meta_before["release"], meta_before["dev"])
    assert list(meta["pr"]) == ["12"]
    assert (meta["pr"]["12"]["sha"], meta["pr"]["12"]["run_id"]) == (scene["c2"], "300")
    assert "- 側: PR #12" in summary
    assert "- 消した PR の側: #5" in summary


# --- publish（レポート） ----------------------------------------------------


def _site_tar(scene: dict[str, Path | str], name: str) -> Path:
    tar = Path(scene["tmp"]) / f"{name}.tar"
    with tarfile.open(tar, "w") as t:
        _add(t, ".", tarfile.DIRTYPE)
        # フッターのリンク（side のルートからの相対）と、_generated の下のページの項目のリンク。
        _add_file(t, "./index.html", _page("test-report/index.html", "/pecot/"))
        _add_file(t, "./_generated/p/tool.html", _page("../../test-report/index.html?tags=X-01"))
        _add_file(t, "./sub/page.html", name)
    return tar


def _report_tar(scene: dict[str, Path | str], name: str, history: str = '{"u":1}\n') -> Path:
    tar = Path(scene["tmp"]) / f"{name}.tar"
    with tarfile.open(tar, "w") as t:
        _report_tree(t, history)
        _add_file(t, "./name.txt", name)
    return tar


def _report_opts(scene: dict[str, Path | str], name: str, **over: object) -> object:
    values: dict[str, object] = {
        "kind": "report",
        "tree": None,
        "tar": _report_tar(scene, name),
        "run_id": "45627254351",
    }
    values.update(over)
    return _opts(scene, **values)


def test_publish_dev_site_with_report_links_then_dev_report(scene: dict[str, Path | str]) -> None:
    site = _site_tar(scene, "site1")
    assert store.publish(_opts(scene, tree=None, tar=site, sha=scene["c1"])).code == 0
    files = _remote_files(scene)
    assert files["dev/_generated/p/tool.html"].count("test-report/index.html?tags=X-01") == 1
    assert "テストレポートはまだありません" in files["dev/test-report/index.html"]

    code, summary, changed = store.publish(_report_opts(scene, "rep1", sha=scene["c1"]))
    assert (code, changed) == (0, True), summary
    files = _remote_files(scene)
    assert files["dev/test-report/name.txt"] == "rep1"
    assert files["dev/test-report/history.jsonl"] == '{"u":1}\n'
    assert files["dev/sub/page.html"] == "site1"
    meta = json.loads(files[".pecot-store.json"])
    assert (meta["reports"]["dev"]["sha"], meta["reports"]["dev"]["run_id"]) == (
        scene["c1"],
        "45627254351",
    )
    assert "sources" not in meta["reports"]["dev"]
    assert meta["dev"]["run_id"] == "100"
    assert "- 側: 開発版" in summary
    assert "- 種類: レポート" in summary
    assert "- 採否: 保管した" in summary
    assert len(_remote_log(scene)) == 1

    # 定義書を置き直しても、レポートと履歴は残る。
    assert (
        store.publish(_opts(scene, tree=None, tar=_site_tar(scene, "site2"), sha=scene["c2"])).code
        == 0
    )
    files = _remote_files(scene)
    assert (files["dev/sub/page.html"], files["dev/test-report/name.txt"]) == ("site2", "rep1")
    assert files["dev/test-report/history.jsonl"] == '{"u":1}\n'
    assert json.loads(files[".pecot-store.json"])["reports"]["dev"]["sha"] == scene["c1"]


def test_publish_summary_names_the_site_kind(scene: dict[str, Path | str]) -> None:
    assert "- 種類: 定義書" in store.publish(_opts(scene)).summary


def test_publish_release_report_writes_sources(scene: dict[str, Path | str]) -> None:
    sources = Path(scene["tmp"]) / "report-sources.json"
    body = {"side": "release", "runs": [], "missing": ["pecot-tools"]}
    sources.write_text(json.dumps(body), encoding="utf-8")
    code, summary, _ = store.publish(
        _report_opts(scene, "rel", side="release", sha=scene["c2"], sources=sources)
    )
    assert code == 0, summary
    files = _remote_files(scene)
    assert files["test-report/name.txt"] == "rel"
    assert "テストレポートはまだありません" in files["dev/test-report/index.html"]
    assert "<h1>リリース版はまだありません</h1>" in files["index.html"]
    meta = json.loads(files[".pecot-store.json"])
    assert meta["reports"]["release"]["sources"] == body
    assert meta["release"] is None
    assert "- 側: リリース版" in summary and "- 種類: レポート" in summary


def test_publish_skips_older_dev_report(scene: dict[str, Path | str]) -> None:
    assert store.publish(_report_opts(scene, "rep2", sha=scene["c2"])).code == 0
    before = _remote_files(scene)
    code, summary, changed = store.publish(_report_opts(scene, "rep1", sha=scene["c1"]))
    assert (code, changed) == (0, False)
    assert "- 採否: 保管しない（新しい開発版のレポートが先に保管されています）" in summary
    assert _remote_files(scene) == before


def test_publish_dev_report_is_compared_with_the_stored_report_only(
    scene: dict[str, Path | str],
) -> None:
    # 定義書の開発版が新しくても、レポートの開発版が無ければ受ける。逆も同じ。
    assert store.publish(_opts(scene, sha=scene["c2"])).code == 0
    code, summary, changed = store.publish(_report_opts(scene, "rep1", sha=scene["c1"]))
    assert (code, changed) == (0, True), summary
    code, summary, changed = store.publish(_report_opts(scene, "rep0", sha=scene["c0"]))
    assert changed is False
    meta = json.loads(_remote_files(scene)[".pecot-store.json"])
    assert (meta["dev"]["sha"], meta["reports"]["dev"]["sha"]) == (scene["c2"], scene["c1"])


def test_publish_refuses_dev_report_outside_main(scene: dict[str, Path | str]) -> None:
    history = Path(scene["history"])
    _run_git(history, "checkout", "-q", "-b", "topic")
    _run_git(history, "commit", "-q", "--allow-empty", "-m", "topic")
    topic = _run_git(history, "rev-parse", "HEAD")
    code, summary, changed = store.publish(_report_opts(scene, "rep", sha=topic))
    assert (code, changed) == (1, False)
    assert "が `main` の祖先ではありません" in summary
    assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


def test_publish_refuses_a_report_that_fails_report_check(scene: dict[str, Path | str]) -> None:
    tar = _report_tar(scene, "bad", '{"u":1}\nnull\n')
    code, summary, changed = store.publish(_report_opts(scene, "unused", tar=tar))
    assert (code, changed) == (1, False)
    assert "  - `history.jsonl` の 2 行目を Allure が読めません" in summary
    assert "- 種類: レポート" in summary
    assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


def test_publish_refuses_pr_side_with_report_links(scene: dict[str, Path | str]) -> None:
    tar = _site_tar(scene, "pr")
    code, summary, _ = store.publish(
        _opts(scene, side="pr", pr=4, tree=None, tar=tar, open_prs=[4])
    )
    assert code == 1
    assert "`index.html`: `test-report/index.html` の先がありません" in summary


def test_publish_refuses_a_site_tar_with_test_report(scene: dict[str, Path | str]) -> None:
    tar = Path(scene["tmp"]) / "own.tar"
    with tarfile.open(tar, "w") as t:
        _add_file(t, "./index.html", _page())
        _add_file(t, "./test-report/index.html", "own")
    code, summary, _ = store.publish(_opts(scene, tree=None, tar=tar))
    assert code == 1
    assert "`./test-report/index.html`: `test-report/` は保管でレポートを置く所です" in summary


@pytest.mark.parametrize(
    ("over", "message"),
    [
        ({"side": "pr", "pr": 4}, "--kind report"),
        ({"side": "none"}, "--kind report"),
        ({"tar": None}, "--tar"),
        ({"tar": None, "tree": Path(".")}, "--tar"),
        ({"kind": "other"}, "kind"),
        ({"side": "release"}, "--sources"),
    ],
)
def test_publish_report_option_errors(
    scene: dict[str, Path | str], over: dict[str, object], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        store.publish(_report_opts(scene, "rep", **over))


def test_publish_cli_report(scene: dict[str, Path | str]) -> None:
    tar = _report_tar(scene, "cli")
    args = ("--kind", "report", "--side", "dev", "--tar", str(tar), "--sha", str(scene["c1"]))
    result, output = _cli(scene, *args, "--run-id", "9")
    assert result.returncode == 0, result.stderr
    assert output == "changed=true\n"
    files = _remote_files(scene)
    assert files["dev/test-report/name.txt"] == "cli"
    assert json.loads(files[".pecot-store.json"])["reports"]["dev"]["run_id"] == "9"
