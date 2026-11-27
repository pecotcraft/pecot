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

import allure
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


@allure.title(
    "Sphinx が出力する形の側は、`./` 始まりのリンクや外部 URL を含んでいても、問題なしと判定する"
)
def test_side_check_passes_sphinx_like_tree(tmp_path: Path) -> None:
    """`side_check` に Sphinx の出力に似た tar を渡した場合のテストです。`./` で始まるリンク、クエリ、断片、ディレクトリへのリンク、外部の URL、`/pecot/` 内の行き来があっても、指摘が 1 件も返らないことを確認します。"""
    with allure.step("Sphinx のような tar の木が側の verify を通ることを確かめる"):
        # `./` 始まり・クエリ・断片・ディレクトリへのリンク・外の URL・/pecot/ の行き来はどれも問題にしない。
        # Sphinx は _sources を出す（html_copy_source の既定）。実物の _build でも切れたリンクは無かった。
        assert store.side_check(_tar(tmp_path, _sphinx_like)) == []


@allure.title("側の tar に {member} のような危険なメンバーがあると、理由を示して指摘する")
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
    """`side_check` に、絶対パス、`..` を含むパス、シンボリックリンク、ハードリンク、特殊ファイルを含む tar を渡した場合のテストです。それぞれのメンバーについて、期待する理由を示した指摘が 1 件だけ返ることを確認します。"""
    with allure.step("危険な名前を持つ tar を組み立てる"):

        def build(tar: tarfile.TarFile) -> None:
            _add_file(tar, "./index.html", _page())
            if kind == tarfile.REGTYPE:
                _add_file(tar, member, "x")
            else:
                _add(tar, member, kind, linkname)

    with allure.step("側の verify が期待の問題を返すことを確かめる"):
        assert store.side_check(_tar(tmp_path, build)) == [expected]


@allure.title("側の中のリンクの先が存在しない場合は、リンクごとに指摘する")
def test_side_check_rejects_broken_internal_links(tmp_path: Path) -> None:
    """存在しないファイルやディレクトリ、側の外、サイトの外の絶対パスを指すリンクを含む tar を `side_check` に渡した場合のテストです。ページとリンクの組ごとに、先がない旨か、側の外を指す旨の指摘が返ることを確認します。"""
    with allure.step("切れた内部リンクを持つ tar を組み立てる"):

        def build(tar: tarfile.TarFile) -> None:
            _add_file(
                tar,
                "./index.html",
                _page(
                    "missing.html", "nodir/", "../outside.html", "/other/x.html", "/pecot/nowhere/"
                ),
            )
            _add_file(tar, "./sub/page.html", '<img src="../img/none.png">')

    with allure.step("側の verify がリンク切れを返すことを確かめる"):
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


@allure.title(
    "テストレポートへのリンクは、`report_links` を指定した場合だけ許可し、指定しなければ指摘する"
)
def test_side_check_lets_report_links_through_only_when_asked(tmp_path: Path) -> None:
    """`test-report/` への相対リンクを含む tar を `side_check` に渡した場合のテストです。`report_links=True` では指摘がなく、指定しない場合は、すべてのリンクについて先がない旨の指摘が返ることを確認します。"""
    with allure.step("レポートへのリンクを持つ tar を組み立てる"):
        tar = _tar(tmp_path, _with_report_links)
    with allure.step("指定したときだけレポートへのリンクが通ることを確かめる"):
        assert store.side_check(tar, report_links=True) == []
        assert store.side_check(tar) == [
            "`_generated/p/tool.html`: `../../test-report/index.html?tags=PW-B-02` の先がありません",
            *(f"`index.html`: `{link}` の先がありません" for link in _REPORT_LINKS),
        ]


@allure.title("`report_links` を指定しても、テストレポート以外へのリンクは引き続き確認する")
def test_side_check_report_links_still_check_other_links(tmp_path: Path) -> None:
    """`report_links=True` で、`test-reports/` のようにレポートに似た別の名前のリンクを含む tar を渡した場合のテストです。そのリンクについて、先がない旨の指摘が返ることを確認します。"""
    with allure.step("レポートへのリンクだけの tar を組み立てる"):
        tar = _tar(tmp_path, lambda t: _add_file(t, "./index.html", _page("test-reports/x.html")))
    with allure.step("レポートへのリンクを許してもほかのリンクは verify されることを確かめる"):
        assert store.side_check(tar, report_links=True) == [
            "`index.html`: `test-reports/x.html` の先がありません"
        ]


@allure.title("`report_links` を指定した場合は、側の中に `test-report/` があると指摘する")
def test_side_check_with_report_links_refuses_a_test_report_dir(tmp_path: Path) -> None:
    """側の中に `test-report/` のディレクトリがある tar を渡した場合のテストです。保管がレポートを置く場所なので、`report_links=True` では指摘が返り、指定しない PR 版では指摘が返らないことを確認します。"""
    with allure.step("test-report ディレクトリを持つ tar を組み立てる"):

        def build(tar: tarfile.TarFile) -> None:
            _add_file(tar, "./index.html", _page("test-report/index.html"))
            _add(tar, "./test-report", tarfile.DIRTYPE)
            _add_file(tar, "./test-report/index.html", "own")
            _add_file(tar, "./test-report/history.jsonl", "")

        tar = _tar(tmp_path, build)
    with allure.step("レポートへのリンクを許しても test-report ディレクトリは断ることを確かめる"):
        assert store.side_check(tar, report_links=True) == [
            "`./test-report`: `test-report/` は保管でレポートを置く所です"
        ]
        # PR 版は保管でレポートを置かないので、側の中身として扱う。
        assert store.side_check(tar) == []


def _report_tree(
    tar: tarfile.TarFile, history: str | None = '{"uuid":"a"}\n{"uuid":"b"}\n'
) -> None:
    _add(tar, ".", tarfile.DIRTYPE)
    _add_file(tar, "./index.html", '<html><script src="app.js"></script></html>')
    _add_file(tar, "./app.js", "")
    _add(tar, "./data", tarfile.DIRTYPE)
    _add_file(tar, "./data/a.json", "{}")
    if history is not None:
        _add_file(tar, "./history.jsonl", history)


def _dev_report_tree(tar: tarfile.TarFile) -> None:
    _report_tree(tar, None)


@allure.title("正しいリリース版のレポートの tar は、問題なしと判定する")
def test_report_check_passes_a_report_tree(tmp_path: Path) -> None:
    """`index.html`、`history.jsonl`、データのファイルを含む、正しい形のリリース版のレポートの tar を `report_check` に渡した場合のテストです。指摘が 1 件も返らないことを確認します。"""
    with allure.step("レポートの tar の木が verify を通ることを確かめる"):
        assert store.report_check(_tar(tmp_path, _report_tree), "release") == []


@allure.title("履歴が空のリリース版のレポートの tar も、問題なしと判定する")
def test_report_check_passes_an_empty_history(tmp_path: Path) -> None:
    """`history.jsonl` が空のリリース版のレポートの tar を `report_check` に渡した場合のテストです。指摘が 1 件も返らないことを確認します。"""
    with allure.step("履歴が空のレポートの tar が verify を通ることを確かめる"):
        tar = _tar(tmp_path, lambda t: _report_tree(t, ""))
        assert store.report_check(tar, "release") == []


@allure.title("履歴を持たない開発版のレポートの tar は、問題なしと判定する")
def test_report_check_passes_a_dev_report_without_history(tmp_path: Path) -> None:
    """`history.jsonl` を含まない開発版のレポートの tar を `report_check` に渡した場合のテストです。指摘が 1 件も返らないことを確認します。"""
    with allure.step("履歴の無い開発版のレポートの tar が verify を通ることを確かめる"):
        assert store.report_check(_tar(tmp_path, _dev_report_tree), "dev") == []


@allure.title("開発版のレポートの tar が履歴（{param_id}）を持つと、持てない旨を指摘する")
@pytest.mark.parametrize(
    "history", ['{"uuid":"a"}\n', "", "NaN\n"], ids=["readable", "empty", "unreadable"]
)
def test_report_check_refuses_history_in_a_dev_report(tmp_path: Path, history: str) -> None:
    """読める・空・読めない `history.jsonl` を含む開発版のレポートの tar を `report_check` に渡した場合のテストです。中身によらず、開発版のレポートは履歴を持てない旨の指摘が 1 件だけ返ることを確認します。"""
    with allure.step("履歴を持つ開発版のレポートの tar を verify する"):
        problems = store.report_check(_tar(tmp_path, lambda t: _report_tree(t, history)), "dev")
    with allure.step("履歴を持てない旨の指摘だけが返ることを確かめる"):
        assert problems == ["開発版のレポートは `history.jsonl` を持てません"]


@allure.title("開発版のレポートの tar に `index.html` が存在しないと、存在しない旨を指摘する")
def test_report_check_needs_index_in_a_dev_report(tmp_path: Path) -> None:
    """`index.html` を含まない開発版のレポートの tar を `report_check` に渡した場合のテストです。`index.html` が存在しない旨の指摘が 1 件だけ返ることを確認します。"""
    with allure.step("index の無い開発版のレポートの tar を verify する"):
        problems = store.report_check(_tar(tmp_path, lambda t: _add_file(t, "./a.js")), "dev")
    with allure.step("index が無い旨の指摘だけが返ることを確かめる"):
        assert problems == ["`index.html` がありません"]


@allure.title("レポートの確認に PR 版の側を渡すと、例外が発生する")
def test_report_check_refuses_other_sides(tmp_path: Path) -> None:
    """`report_check` に、開発版とリリース版のどちらでもない `pr` の側を渡した場合のテストです。側が不正である旨の `ValueError` が発生することを確認します。"""
    with allure.step("PR 版の側でレポートの tar を verify して、例外になることを確かめる"):
        with pytest.raises(ValueError, match="レポートの側"):
            store.report_check(_tar(tmp_path, _dev_report_tree), "pr")


@allure.title("リリース版のレポートの tar に {missing} が存在しないと、存在しない旨を指摘する")
@pytest.mark.parametrize(
    ("missing", "expected"),
    [
        ("./index.html", "`index.html` がありません"),
        ("./history.jsonl", "`history.jsonl` がありません"),
    ],
)
def test_report_check_needs_index_and_history(tmp_path: Path, missing: str, expected: str) -> None:
    """`index.html` と `history.jsonl` のどちらか一方が欠けたリリース版のレポートの tar を渡した場合のテストです。欠けたファイルの名前を示した指摘が 1 件だけ返ることを確認します。"""
    with allure.step("index か履歴が欠けた tar を組み立てる"):

        def build(tar: tarfile.TarFile) -> None:
            for name, body in (("./index.html", "<html></html>"), ("./history.jsonl", "")):
                if name != missing:
                    _add_file(tar, name, body)

    with allure.step("レポートの verify が期待の問題を返すことを確かめる"):
        assert store.report_check(_tar(tmp_path, build), "release") == [expected]


@allure.title("履歴に Allure の読めない行（{param_id}）があると、その行の番号を示して指摘する")
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
    """`history.jsonl` に、`NaN`、`null`、文字列の途中で行が切れる `U+2028` を含むリリース版のレポートの tar を渡した場合のテストです。Allure が読めない行の番号を示した指摘が 1 件だけ返ることを確認します。"""
    with allure.step("読めない行のある履歴のレポートの tar が断られることを確かめる"):
        tar = _tar(tmp_path, lambda t: _report_tree(t, history))
        assert store.report_check(tar, "release") == [expected]


@allure.title("履歴が UTF-8 ではない場合は、その旨を指摘する")
def test_report_check_refuses_history_that_is_not_utf8(tmp_path: Path) -> None:
    """`history.jsonl` に UTF-8 として読めないバイト列を含むリリース版のレポートの tar を渡した場合のテストです。`history.jsonl` が UTF-8 ではない旨の指摘が返ることを確認します。"""
    with allure.step("UTF-8 でない履歴を持つ tar を組み立てる"):

        def build(tar: tarfile.TarFile) -> None:
            _add_file(tar, "./index.html", "<html></html>")
            info = tarfile.TarInfo("./history.jsonl")
            info.size = 2
            tar.addfile(info, io.BytesIO(b"\xff\n"))

    with allure.step("レポートの verify が UTF-8 でないと断ることを確かめる"):
        assert store.report_check(_tar(tmp_path, build), "release") == [
            "`history.jsonl` が UTF-8 ではありません"
        ]


@allure.title("レポートの確認でも、側の確認と同じ危険なメンバーを指摘する")
def test_report_check_also_runs_side_check(tmp_path: Path) -> None:
    """シンボリックリンクを含むレポートの tar を `report_check` に渡した場合のテストです。側の確認と同じ、シンボリックリンクである旨の指摘が返ることを確認します。"""
    with allure.step("シンボリックリンクを含むレポートの tar を組み立てる"):

        def build(tar: tarfile.TarFile) -> None:
            _report_tree(tar)
            _add(tar, "./link", tarfile.SYMTYPE, "/etc/passwd")

    with allure.step("レポートの verify が側の verify も動かすことを確かめる"):
        assert store.report_check(_tar(tmp_path, build), "release") == [
            "`./link`: シンボリックリンクです"
        ]


@allure.title(
    "`check` コマンドは、指摘を Markdown の箇条書きで標準出力に表示し、終了コード 1 で終了する"
)
def test_check_cli_prints_markdown_and_fails(tmp_path: Path) -> None:
    """リンク切れのある tar に対して `store.py check` を実行した場合のテストです。終了コードが 1 になり、標準出力に指摘が箇条書きの 1 行で表示されることを確認します。"""
    with allure.step("リンク切れの tar で verify の CLI を動かす"):
        tar = _tar(tmp_path, lambda t: _add_file(t, "./index.html", _page("gone.html")))
        result = run_attached(
            [sys.executable, str(_STORE), "check", str(tar)], capture_output=True, text=True
        )
    with allure.step("終了コードと Markdown の出力を確かめる"):
        assert (result.returncode, result.stdout) == (
            1,
            "- `index.html`: `gone.html` の先がありません\n",
        )


@allure.title(
    "`check` コマンドに {args} を指定すると、種類と側に応じて確認し、終了コード {code} で終了する"
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
    """テストレポートへのリンクを含む tar に対して、`--kind` と `--side` の組み合わせを変えて `store.py check` を実行した場合のテストです。指定なしと PR 版では終了コード 1、開発版とリリース版では 0 になることを確認します。"""
    with allure.step("レポートへのリンクを持つ tar で、種類と側を変えて verify の CLI を動かす"):
        tar = _tar(tmp_path, _with_report_links)
        result = run_attached(
            [sys.executable, str(_STORE), "check", *args, str(tar)], capture_output=True, text=True
        )
    with allure.step("種類と側に応じた終了コードを確かめる"):
        assert result.returncode == code, result.stdout + result.stderr


@allure.title(
    "`check --kind report --side {side}` は、その側のレポートの確認を使い、終了コード {code} で終了する"
)
@pytest.mark.parametrize(
    ("side", "code", "stdout"),
    [("dev", 0, ""), ("release", 1, "- `history.jsonl` がありません\n")],
)
def test_check_cli_report_uses_report_check(
    tmp_path: Path, side: str, code: int, stdout: str
) -> None:
    """`index.html` だけの tar に対して、`--kind report` と側を指定して `store.py check` を実行した場合のテストです。開発版では通り、リリース版では `history.jsonl` が存在しない旨を表示して終了コード 1 になることを確認します。"""
    with allure.step("index だけのレポートの tar で verify の CLI を動かす"):
        tar = _tar(tmp_path, lambda t: _add_file(t, "./index.html", "<html></html>"))
        result = run_attached(
            [sys.executable, str(_STORE), "check", "--kind", "report", "--side", side, str(tar)],
            capture_output=True,
            text=True,
        )
    with allure.step("側に応じた出力と終了コードを確かめる"):
        assert (result.returncode, result.stdout) == (code, stdout)


@allure.title("`check --kind report` に {param_id} の側を渡すと、終了コード 2 で終了する")
@pytest.mark.parametrize("args", [(), ("--side", "pr")], ids=["no-side", "pr"])
def test_check_cli_report_needs_a_report_side(tmp_path: Path, args: tuple[str, ...]) -> None:
    """`--kind report` に、側を指定しない場合と PR 版を指定した場合の `store.py check` のテストです。引数の誤りとして終了コード 2 で終了し、標準エラー出力に `--side` の指定を求める旨が表示されることを確認します。"""
    with allure.step("側を決めずにレポートの verify の CLI を動かす"):
        tar = _tar(tmp_path, _dev_report_tree)
        result = run_attached(
            [sys.executable, str(_STORE), "check", "--kind", "report", *args, str(tar)],
            capture_output=True,
            text=True,
        )
    with allure.step("終了コード 2 と側を求める出力を確かめる"):
        assert result.returncode == 2
        assert "--side dev か release" in result.stderr


@allure.title("`checker` は、種類と側に応じた確認の関数を返す")
def test_checker_follows_kind_and_side(tmp_path: Path) -> None:
    """`store.checker` に、種類と側の組み合わせを渡した場合のテストです。サイトではリンクの扱いが側で変わり、レポートでは開発版とリリース版で履歴の扱いが変わり、PR 版では例外が発生することを確認します。"""
    with allure.step("レポートへのリンクを持つ tar と、履歴を持つレポートの tar を組み立てる"):
        links = _tar(tmp_path, _with_report_links)
        report = tmp_path / "report"
        report.mkdir()
        with_history = _tar(report, _report_tree)
    with allure.step("種類と側に応じた verify が選ばれることを確かめる"):
        assert store.checker("site", "dev")(links) == []
        assert store.checker("site", "release")(links) == []
        assert store.checker("site", "pr")(links) != []
        assert store.checker("report", "release")(with_history) == []
        assert store.checker("report", "dev")(with_history) == [
            "開発版のレポートは `history.jsonl` を持てません"
        ]
        with pytest.raises(ValueError, match="レポートの側"):
            store.checker("report", "pr")


@allure.title("`extract` は、渡された確認の関数を使い、指摘があれば展開しない")
def test_extract_uses_the_given_check(tmp_path: Path) -> None:
    """テストレポートへのリンクを含む tar を `extract` に渡した場合のテストです。PR 版の確認では例外が発生して展開先が作られず、開発版の確認では展開が成功することを確認します。"""
    with allure.step("レポートへのリンクを持つ tar を組み立てる"):
        tar = _tar(tmp_path, _with_report_links)
    with allure.step("渡した verify に従って取り出しが断られたり通ったりすることを確かめる"):
        with pytest.raises(ValueError, match="test-report/index.html"):
            store.extract(tar, tmp_path / "pr", check=store.side_check)
        assert not (tmp_path / "pr").exists()
        store.extract(tar, tmp_path / "dev", check=store.checker("site", "dev"))
        assert (tmp_path / "dev" / "_generated/p/tool.html").is_file()


@allure.title("確認に通った tar は、中のファイルをすべて展開先に書き出す")
def test_extract_writes_checked_tree(tmp_path: Path) -> None:
    """Sphinx の出力に似た tar を `extract` に渡した場合のテストです。展開先にファイルがすべて書き出され、`index.html` などの内容が読めることを確認します。"""
    with allure.step("tar を verify 付きで取り出す"):
        dest = tmp_path / "out"
        store.extract(_tar(tmp_path, _sphinx_like), dest, check=store.side_check)
    with allure.step("取り出した木のファイルを確かめる"):
        assert (dest / "guides/a.html").read_text(encoding="utf-8").startswith("<html>")
        assert sorted(p.relative_to(dest).as_posix() for p in dest.rglob("*") if p.is_file()) == [
            "_sources/index.rst.txt",
            "_static/doc.js",
            "_static/pygments.css",
            "guides/a.html",
            "guides/index.html",
            "index.html",
        ]


@allure.title("危険なメンバーを含む tar は、例外を発生させて展開先を作らない")
def test_extract_refuses_unsafe_tar(tmp_path: Path) -> None:
    """シンボリックリンクを含む tar を `extract` に渡した場合のテストです。シンボリックリンクに関する例外が発生し、展開先のディレクトリが作られないことを確認します。"""
    with allure.step("シンボリックリンクを含む tar を組み立てる"):
        tar = _tar(tmp_path, lambda t: _add(t, "./link", tarfile.SYMTYPE, "/etc/passwd"))
    with allure.step("取り出しが断られて何も書かれないことを確かめる"):
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


@allure.title("空の保管には、リンクを含まない案内のページを作る")
def test_empty_store_gets_guide_pages_without_links(tmp_path: Path) -> None:
    """何も保管していない状態で `apply` を実行した場合のテストです。トップ・開発版・テストレポートの案内のページが作られ、まだ公開していない旨が書かれ、リンクを含まず、記録が空になることを確認します。"""
    with allure.step("空の保管先に案内のページを作る"):
        root = tmp_path / "store"
        root.mkdir()
        store.apply(root, side="none", pr=None, tree=None, record=None, open_prs=[])
        files = _files(root)
    with allure.step("ファイルの一覧と案内の内容とリンクを確かめる"):
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


@allure.title("開発版だけがある場合は、リリース版の案内のページから開発版へ誘導する")
def test_dev_only_guides_release_to_dev(tmp_path: Path) -> None:
    """開発版だけを保管した場合のテストです。トップとテストレポートの案内のページに、リリース版がない旨と開発版へのリンクが表示され、記録の `dev` に保管した内容が入ることを確認します。"""
    with allure.step("dev だけの保管先を作る"):
        root = tmp_path / "store"
        root.mkdir()
        tree = _tree(tmp_path, "dev-tree", _BAND)
        store.apply(root, side="dev", pr=None, tree=tree, record=_rec("d1"), open_prs=[])
        files = _files(root)
    with allure.step("ファイルの一覧・案内・リンク・記録を確かめる"):
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


@allure.title("リリース版だけがある場合は、開発版の案内のページからリリース版へ誘導する")
def test_release_only_guides_dev_to_release(tmp_path: Path) -> None:
    """リリース版だけを保管した場合のテストです。開発版の案内のページに、開発版がない旨とリリース版へのリンクが表示され、記録の `release` に保管した内容が入ることを確認します。"""
    with allure.step("release だけの保管先を作る"):
        root = tmp_path / "store"
        root.mkdir()
        tree = _tree(tmp_path, "rel-tree", _BAND)
        record = {**_rec("r1"), "sources": {"skeleton": "s"}}
        store.apply(root, side="release", pr=None, tree=tree, record=record, open_prs=[])
        files = _files(root)
    with allure.step("案内とファイルと記録とリンクを確かめる"):
        assert "<h1>開発版はまだありません</h1>" in files["dev/index.html"]
        assert '<a href="/pecot/">リリース版</a>' in files["dev/index.html"]
        assert files["sub/page.html"] == "rel-tree"
        assert _meta(root)["release"] == record
        assert store.check_cross_links(root) == []


@allure.title("リリース版を書き換えても、開発版と PR 版は残し、古いファイルは消す")
def test_release_rewrite_keeps_dev_and_pr(tmp_path: Path) -> None:
    """開発版・PR 版・リリース版を保管した後で、リリース版を書き換えた場合のテストです。リリース版の古いファイルだけが消え、開発版と PR 版の内容と記録が変わらないことを確認します。"""
    with allure.step("dev と PR のある保管先で release を書き換える"):
        root = tmp_path / "store"
        root.mkdir()
        store.apply(
            root,
            side="dev",
            pr=None,
            tree=_tree(tmp_path, "dev1"),
            record=_rec("d1"),
            open_prs=None,
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
    with allure.step("ファイルの一覧と dev と PR が残ることと記録を確かめる"):
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
        assert (
            files["sub/page.html"],
            files["dev/sub/page.html"],
            files["pr/7/sub/page.html"],
        ) == (
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


@allure.title("開発版を書き換えても、`dev/` と記録だけを変える")
def test_dev_rewrite_touches_only_dev_and_record(tmp_path: Path) -> None:
    """リリース版と開発版を保管した後で、開発版を書き換えた場合のテストです。`dev/` の古いファイルが消え、`dev/` の外のファイルは変わらず、記録の `dev` だけが更新されることを確認します。"""
    with allure.step("release のある保管先で dev を書き換える"):
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
            root,
            side="dev",
            pr=None,
            tree=_tree(tmp_path, "dev1"),
            record=_rec("d1"),
            open_prs=None,
        )
        (root / "dev" / "stale.html").write_text("old", encoding="utf-8")
        before = {k: v for k, v in _files(root).items() if not k.startswith("dev/") and k[0] != "."}
        store.apply(
            root,
            side="dev",
            pr=None,
            tree=_tree(tmp_path, "dev2"),
            record=_rec("d2"),
            open_prs=None,
        )
        after = _files(root)
    with allure.step("dev と記録だけが変わることを確かめる"):
        assert {
            k: v for k, v in after.items() if not k.startswith("dev/") and k[0] != "."
        } == before
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


@allure.title("{side} のレポートを保管すると、その側のテストレポートと記録だけが変わる")
@pytest.mark.parametrize(("side", "prefix"), [("dev", "dev/"), ("release", "")])
def test_report_changes_only_its_test_report_and_record(
    tmp_path: Path, side: str, prefix: str
) -> None:
    """リリース版・開発版・PR 版の定義書を保管した後で、開発版またはリリース版のレポートを保管した場合のテストです。その側の `test-report/` と記録の `reports` だけが変わり、PR 版にはレポートが作られないことを確認します。"""
    with allure.step("各側のある保管先でレポートを書き込む"):
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
    with allure.step("レポートと記録だけが変わることを確かめる"):
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


@allure.title("同じ側のレポートを保管し直すと、前のレポートを置き換える")
def test_report_replaces_the_previous_report(tmp_path: Path) -> None:
    """開発版のレポートを 2 回保管した場合のテストです。1 回目だけにあるファイルが消え、`index.html` が 2 回目の内容になり、記録も 2 回目のものになることを確認します。"""
    with allure.step("レポートを 2 回書き込む"):
        root = tmp_path / "store"
        root.mkdir()
        for name in ("rep1", "rep2"):
            tree = _report(tmp_path, name)
            if name == "rep1":
                (tree / "data" / "old.json").write_text("old", encoding="utf-8")
            store.apply(
                root,
                side="dev",
                pr=None,
                tree=tree,
                record=_rec(name),
                open_prs=None,
                kind="report",
            )
        files = _files(root)
    with allure.step("前のレポートが置き換わることを確かめる"):
        assert sorted(k for k in files if k.startswith("dev/test-report/")) == [
            "dev/test-report/data/a.json",
            "dev/test-report/history.jsonl",
            "dev/test-report/index.html",
        ]
        assert files["dev/test-report/index.html"] == "<html>rep2</html>"
        assert _meta(root)["reports"] == {"dev": _rec("rep2")}


@allure.title("履歴を持たない開発版のレポートを保管すると、保管済みの履歴を消す")
def test_dev_report_without_history_removes_the_stored_history(tmp_path: Path) -> None:
    """履歴を持つ開発版のレポートを保管した後で、履歴を持たないレポートを保管した場合のテストです。`dev/test-report/history.jsonl` が保管先から消えることを確認します。"""
    with allure.step("履歴を持つレポートの後に、履歴を持たないレポートを書き込む"):
        root = tmp_path / "store"
        root.mkdir()
        for name, keep in (("rep1", True), ("rep2", False)):
            tree = _report(tmp_path, name)
            if not keep:
                (tree / "history.jsonl").unlink()
            store.apply(
                root,
                side="dev",
                pr=None,
                tree=tree,
                record=_rec(name),
                open_prs=None,
                kind="report",
            )
        files = _files(root)
    with allure.step("保管済みの履歴が消えることを確かめる"):
        assert "dev/test-report/history.jsonl" not in files
        assert files["dev/test-report/index.html"] == "<html>rep2</html>"


@allure.title("{side} の定義書を書き換えても、保管済みのレポートと履歴は残す")
@pytest.mark.parametrize(("side", "prefix"), [("dev", "dev/"), ("release", "")])
def test_site_rewrite_keeps_the_report(tmp_path: Path, side: str, prefix: str) -> None:
    """レポートを保管した後で、同じ側の定義書を 2 回書き換えた場合のテストです。レポートの `index.html` と `history.jsonl` が変わらず、定義書のファイルだけが新しくなり、記録の `reports` も残ることを確認します。"""
    with allure.step("レポートのある保管先でサイトを書き換える"):
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
    with allure.step("レポートが残ることを確かめる"):
        assert files[f"{prefix}test-report/history.jsonl"] == '{"uuid":"a"}\n{"uuid":"b"}\n'
        assert files[f"{prefix}test-report/index.html"] == "<html>rep1</html>"
        assert files[f"{prefix}sub/page.html"] == "site2"
        assert _meta(root)["reports"] == {side: _rec("t1")}


@allure.title("開発版の定義書が案内のページである間も、開発版のレポートは残す")
def test_dev_report_survives_while_dev_site_is_a_guide(tmp_path: Path) -> None:
    """開発版のレポートだけを保管した後で、側を指定しない `apply` を実行した場合のテストです。`dev/` が案内のページで作り直されても、`dev/test-report/` のレポートは残ることを確認します。"""
    with allure.step("dev のレポートを置いて dev のサイトを案内に戻す"):
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
    with allure.step("dev のレポートが残ることを確かめる"):
        assert "<h1>開発版はまだありません</h1>" in files["dev/index.html"]
        assert files["dev/test-report/index.html"] == "<html>rep1</html>"
        assert "<h1>テストレポートはまだありません</h1>" in files["test-report/index.html"]


@allure.title("レポートを保管すると、その側のテストレポートの案内のページがレポートに置き換わる")
def test_report_guide_is_replaced_by_the_report(tmp_path: Path) -> None:
    """案内のページだけの状態で、リリース版のレポートを保管した場合のテストです。リリース版のテストレポートがレポートに置き換わり、開発版のテストレポートは案内のページのままであることを確認します。"""
    with allure.step("レポートの案内だけの保管先を作る"):
        root = tmp_path / "store"
        root.mkdir()
        store.apply(root, side="none", pr=None, tree=None, record=None, open_prs=[])
    with allure.step("案内がレポートに置き換わることを確かめる"):
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


@allure.title("レポートを {side} の側で保管しようとすると、例外が発生する")
@pytest.mark.parametrize("side", ["pr", "none"])
def test_report_refuses_pr_and_none(tmp_path: Path, side: str) -> None:
    """`kind=report` で、PR 版の側と、側を指定しない場合を `apply` に渡したテストです。どちらも `report` に関する例外が発生し、`pr/` のディレクトリが作られないことを確認します。"""
    with allure.step("空の保管先を用意する"):
        root = tmp_path / "store"
        root.mkdir()
    with allure.step(
        "レポートの書き込みに PR か none の側を渡して、断られて何も書かれないことを確かめる"
    ):
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


@allure.title(
    "記録の `reports` が {reports} のようにオブジェクトでない場合は、空のオブジェクトに直して読む"
)
@pytest.mark.parametrize("reports", [None, [], "x"])
def test_read_meta_fixes_reports_that_are_not_an_object(tmp_path: Path, reports: object) -> None:
    """`reports` がない場合、リスト、文字列の場合の記録を `read_meta` で読んだテストです。いずれの場合も、`reports` が空のオブジェクトとして返ることを確認します。"""
    with allure.step("オブジェクトでない reports の記録を書く"):
        root = tmp_path / "store"
        root.mkdir()
        meta: dict[str, object] = {"release": None, "dev": None, "pr": {}}
        if reports is not None:
            meta["reports"] = reports
        (root / ".pecot-store.json").write_text(json.dumps(meta), encoding="utf-8")
    with allure.step("記録を読むと reports が空のオブジェクトに直ることを確かめる"):
        assert store.read_meta(root)["reports"] == {}


@allure.title("保管の大きさには、レポートの大きさも含める")
def test_size_counts_the_reports(tmp_path: Path) -> None:
    """大きな履歴を持つレポートを、開発版とリリース版の両方に保管した場合のテストです。レポートの外のファイルは上限に届かず、`store_size` の合計は上限を超え、`size_warning` が警告を返すことを確認します。"""
    with allure.step("レポートのある保管先を作る"):
        root = tmp_path / "store"
        root.mkdir()
        tree = _report(tmp_path, "rep1", "x" * 3000)
        store.apply(
            root, side="dev", pr=None, tree=tree, record=_rec("t1"), open_prs=None, kind="report"
        )
        store.apply(
            root,
            side="release",
            pr=None,
            tree=tree,
            record=_rec("t1"),
            open_prs=None,
            kind="report",
        )
        # レポートの外（案内のページと .pecot-store.json）は 6000 バイトに届かない。
        outside = sum(
            p.stat().st_size
            for p in root.rglob("*")
            if p.is_file() and "test-report" not in p.parts
        )
    with allure.step("保管先の大きさにレポートが数えられることを確かめる"):
        assert outside < 6000
        assert store.store_size(root) > 6000
        assert store.size_warning(root, limit=6000) is not None


@allure.title("開いていない PR の側は、`apply` で削除し、記録からも消す")
def test_closed_prs_are_removed(tmp_path: Path) -> None:
    """3 つの PR の側を保管した後で、開いている PR を絞って `apply` を実行した場合のテストです。`closed_prs` が閉じた PR を返し、その `pr/N/` と記録が消え、開いている PR がなければ `pr/` ごと消えることを確認します。"""
    with allure.step("複数の PR のある保管先を作る"):
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
    with allure.step("閉じた PR が見つかり、消えることを確かめる"):
        assert store.closed_prs(root, [5]) == [3, 8]
        store.apply(root, side="none", pr=None, tree=None, record=None, open_prs=[5])
        assert sorted(p.name for p in (root / "pr").iterdir()) == ["5"]
        assert _meta(root)["pr"] == {"5": _rec("p5")}
        store.apply(root, side="none", pr=None, tree=None, record=None, open_prs=[])
        assert not (root / "pr").exists()
        assert _meta(root)["pr"] == {}


@allure.title("側の間のリンクの先が存在しない場合は、リンクごとにページの数と例を示して指摘する")
def test_check_cross_links_reports_missing_targets(tmp_path: Path) -> None:
    """`/pecot/pr/4/` のように、まだ保管していない側を指すリンクを含む保管に対して `check_cross_links` を実行した場合のテストです。先がない旨と、該当するページの数、例のページの名前を示した指摘が返ることを確認します。"""
    with allure.step("切れたリンクのある保管先を作る"):
        root = tmp_path / "store"
        root.mkdir()
        tree = _tree(tmp_path, "dev-tree", ("/pecot/", "/pecot/dev/sub/page.html", "/pecot/pr/4/"))
        store.apply(root, side="dev", pr=None, tree=tree, record=_rec("d1"), open_prs=[])
        (root / "dev" / "sub" / "x.html").write_text(_page("/pecot/pr/4/#a"), encoding="utf-8")
    with allure.step("側の間のリンク切れが報告されることを確かめる"):
        assert store.check_cross_links(root) == [
            "`/pecot/pr/4/` の先がありません（1 ページ。例: `dev/index.html`）",
            "`/pecot/pr/4/#a` の先がありません（1 ページ。例: `dev/sub/x.html`）",
        ]


@allure.title("側の間のリンクの確認では、`.git` の中のファイルは対象にしない")
def test_check_cross_links_ignores_git_dir(tmp_path: Path) -> None:
    """`.git` の中に、リンクを含む HTML があり、トップのページが `.git` の中を指す場合のテストです。`.git` の中のページは確認されず、トップのページのリンクだけが指摘されることを確認します。"""
    with allure.step(".git の下にリンクを置いた保管先を作る"):
        root = tmp_path / "store"
        (root / ".git").mkdir(parents=True)
        (root / ".git" / "x.html").write_text(_page("/pecot/none/"), encoding="utf-8")
        (root / "index.html").write_text(_page("/pecot/.git/x.html"), encoding="utf-8")
    with allure.step(".git の下が verify されないことを確かめる"):
        assert store.check_cross_links(root) == [
            "`/pecot/.git/x.html` の先がありません（1 ページ。例: `index.html`）"
        ]


@allure.title("保管の大きさが上限を超えると、警告を返す")
def test_size_warning(tmp_path: Path) -> None:
    """`.git` の中を除いたファイルの合計が、上限ちょうどの場合と、1 バイト超える場合のテストです。上限を超えるまでは `None` が返り、超えると大きさと上限を示した警告が返り、既定の上限では `None` が返ることを確認します。"""
    with allure.step(".git と通常のファイルで大きさを作る"):
        root = tmp_path / "store"
        (root / ".git").mkdir(parents=True)
        (root / ".git" / "pack").write_bytes(b"x" * 5000)
        (root / "a.html").write_bytes(b"x" * 1000)
    with allure.step("上限に応じて警告が出ることを確かめる"):
        assert store.size_warning(root, limit=1000) is None
        (root / "b.html").write_bytes(b"x")
        assert store.size_warning(root, limit=1000) == (
            "pages-store の大きさが 0.0 MB で、0.0 MB を超えました（GitHub Pages の上限は 1 GB）"
        )
        assert store.size_warning(root) is None


@allure.title("`dev_is_newer` は、保管済みの開発版が祖先でなければ新しいと判定しない")
def test_dev_is_newer() -> None:
    """保管済みの開発版が、存在しない・同じ・古い・新しいのそれぞれの場合の判定のテストです。新しいと判定されるのは前の 3 つの場合だけで、祖先の確認は必要な組に限って呼ばれることを確認します。"""
    with allure.step("祖先の判定を記録する関数を用意する"):
        calls: list[tuple[str, str]] = []

        def is_ancestor(older: str, newer: str) -> bool:
            calls.append((older, newer))
            return older == "old"

    with allure.step("保管済みの dev との新旧の判定を確かめる"):
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


@allure.title("初めての保管では、親のない commit を作って push し、結果の概要を返す")
def test_publish_first_time_creates_orphan_commit(scene: dict[str, Path | str]) -> None:
    """リモートにブランチがない状態で `publish` を実行した場合のテストです。ブランチに必要なファイルと記録が揃い、commit の作者が bot の 1 件だけで、概要に側・採否・push の回数が表示され、警告が含まれないことを確認します。"""
    with allure.step("最初の公開を動かす"):
        code, summary, changed = store.publish(_opts(scene))
    with allure.step("孤立した commit が作られ、ファイルと記録と要約を確かめる"):
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


@allure.title("保管を繰り返しても、ブランチの commit は 1 つのままで、中身を置き換える")
def test_publish_replaces_and_stays_single_commit(scene: dict[str, Path | str]) -> None:
    """PR 版と開発版を保管した後で、開いていない PR を除いて開発版を保管した場合のテストです。ブランチの commit が 1 つのままで、PR 版が消え、記録が新しい開発版になり、概要に消した PR が表示されることを確認します。"""
    with allure.step("公開を 2 回動かして commit が 1 つのままで置き換わることを確かめる"):
        assert (
            store.publish(_opts(scene, side="pr", pr=12, sha=scene["c1"], open_prs=[12, 13])).code
            == 0
        )
        assert store.publish(_opts(scene, side="dev", sha=scene["c1"], open_prs=[12, 13])).code == 0
        code, summary, changed = store.publish(
            _opts(scene, side="dev", sha=scene["c2"], open_prs=[13])
        )
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


@allure.title("push の前に別の保管が書き込まれた場合は、取り込み直して再び push する")
def test_publish_retries_when_lease_is_stale(scene: dict[str, Path | str]) -> None:
    """push の直前に、別のクローンが `pr/9/` を追加して push した場合のテストです。2 回目の push で成功し、概要に回数が表示され、追加された `pr/9/` と新しい開発版の両方が残り、commit は 1 つのままであることを確認します。"""
    with allure.step("push の競合を起こして公開を動かし、再試行で通ることを確かめる"):
        assert store.publish(_opts(scene, sha=scene["c0"])).code == 0
        intruder = Path(scene["tmp"]) / "intruder"
        _run_git(
            Path(scene["tmp"]),
            "clone",
            "-q",
            "-b",
            "pages-store",
            str(scene["remote"]),
            str(intruder),
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


@allure.title("保管済みより古い開発版は、保管せずに終了コード 0 で終了する")
def test_publish_skips_older_dev(scene: dict[str, Path | str]) -> None:
    """新しい開発版を保管した後で、古い SHA の開発版を `publish` に渡した場合のテストです。終了コードは 0 で、変更はなく、概要に保管しない理由と push しない旨が表示され、リモートの中身が変わらないことを確認します。"""
    with allure.step("新しい dev の後に古い dev を公開して、保管されないことを確かめる"):
        assert store.publish(_opts(scene, sha=scene["c2"])).code == 0
        before = _remote_files(scene)
        code, summary, changed = store.publish(_opts(scene, sha=scene["c1"]))
        assert (code, changed) == (0, False)
        assert "- 採否: 保管しない（新しい開発版が先に保管されています）" in summary
        assert "- pages-store: 書き換えが無いので push しません" in summary
        assert _remote_files(scene) == before


@allure.title("開発版の SHA が `main` の祖先でない場合は、終了コード 1 で終了し、push しない")
def test_publish_refuses_dev_outside_main(scene: dict[str, Path | str]) -> None:
    """`main` から分かれたブランチの commit を開発版として `publish` に渡した場合のテストです。終了コード 1 で終了し、概要へ祖先ではない旨を表示し、リモートにブランチを作成しないことを確認します。"""
    with allure.step("main の外の commit の dev を用意する"):
        history = Path(scene["history"])
        _run_git(history, "checkout", "-q", "-b", "topic")
        _run_git(history, "commit", "-q", "--allow-empty", "-m", "topic")
        topic = _run_git(history, "rev-parse", "HEAD")
        code, summary, changed = store.publish(_opts(scene, sha=topic))
    with allure.step("公開が断られて何も push されないことを確かめる"):
        assert (code, changed) == (1, False)
        assert "が `main` の祖先ではありません" in summary
        assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


@allure.title("側の間のリンクの先が存在しない場合は、終了コード 1 で終了し、push しない")
def test_publish_refuses_broken_cross_links(scene: dict[str, Path | str]) -> None:
    """まだ保管していない PR 版へのリンクを含む開発版を `publish` に渡した場合のテストです。終了コード 1 で終了し、概要へ切れたリンクの指摘を表示し、リモートにブランチを作成しないことを確認します。"""
    with allure.step("側の間のリンクが切れた木を用意する"):
        tree = _tree(Path(scene["tmp"]), "broken", ("/pecot/pr/77/",))
        code, summary, changed = store.publish(_opts(scene, tree=tree))
    with allure.step("公開が断られて何も push されないことを確かめる"):
        assert (code, changed) == (1, False)
        assert "- 側の間のリンクが切れているので push しません" in summary
        assert "`/pecot/pr/77/` の先がありません" in summary
        assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


@allure.title(
    "`publish` コマンドでリリース版を渡すと、`sources` を記録に書き、存在しない作業ディレクトリも作る"
)
def test_publish_cli_release_with_sources(scene: dict[str, Path | str]) -> None:
    """`--sources` を指定してリリース版を `store.py publish` で保管した場合のテストです。終了コードが 0 になり、記録の `release` に `sources` と `run_id` が入り、開発版の案内のページが作られることを確認します。"""
    with allure.step("release の元の記録を用意して公開の CLI を動かす"):
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
    with allure.step("終了コードと出力と保管先の記録を確かめる"):
        assert result.returncode == 0, result.stderr
        assert "- 側: リリース版" in result.stdout
        files = _remote_files(scene)
        meta = json.loads(files[".pecot-store.json"])
        assert meta["release"]["sources"] == {"skeleton": scene["c2"]}
        assert meta["release"]["run_id"] == "55"
        assert "<h1>開発版はまだありません</h1>" in files["dev/index.html"]


@allure.title(
    "側を受けない `publish` は、変更がなければ push せず、閉じた PR があれば消して push する"
)
def test_publish_none_without_changes_does_not_push(scene: dict[str, Path | str]) -> None:
    """PR 版を保管した後で、側を指定せずに `publish` を 2 回実行した場合のテストです。1 回目は変更がなく push されず、2 回目は PR が閉じたので `pr/4/` が消え、変更ありになることを確認します。"""
    with allure.step("変更の無い公開が push されず、PR を消すと push されることを確かめる"):
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


@allure.title("`publish` コマンドは、tar を受け取り、変更の有無を `GITHUB_OUTPUT` に書く")
def test_publish_cli_takes_tar_and_writes_changed(scene: dict[str, Path | str]) -> None:
    """`--tar` を指定して `store.py publish` を 2 回実行した場合のテストです。新しい開発版では `changed=true` が書かれてファイルと記録が保管され、古い開発版では `changed=false` が書かれ、保管しない理由が表示されることを確認します。"""
    with allure.step("tar を用意して公開の CLI を動かす"):
        tmp = Path(scene["tmp"])
        tar = tmp / "site.tar"
        with tarfile.open(tar, "w") as t:
            _add(t, ".", tarfile.DIRTYPE)
            _add_file(t, "./index.html", _page("sub/a.html", "/pecot/"))
            _add_file(t, "./sub/a.html", "a")
        args = ("--side", "dev", "--tar", str(tar), "--sha", str(scene["c1"]), "--run-id", "7")
        result, output = _cli(scene, *args)
    with allure.step("終了コードと changed の出力と保管先のファイルを確かめる"):
        assert result.returncode == 0, result.stderr
        assert output == "changed=true\n"
        files = _remote_files(scene)
        assert (
            files["dev/sub/a.html"],
            json.loads(files[".pecot-store.json"])["dev"]["run_id"],
        ) == (
            "a",
            "7",
        )
        result, output = _cli(scene, "--side", "dev", "--tar", str(tar), "--sha", str(scene["c0"]))
        assert result.returncode == 0, result.stderr
        assert output == "changed=false\n"
        assert "新しい開発版が先に保管されています" in result.stdout


@allure.title("`publish` コマンドは、危険なメンバーを含む tar を拒否し、push しない")
def test_publish_cli_refuses_unsafe_tar(scene: dict[str, Path | str]) -> None:
    """シンボリックリンクを含む tar を `--tar` に指定して `store.py publish` を実行した場合のテストです。終了コードが 1 になり、`changed=false` が書かれ、標準出力に指摘が表示されて、リモートにブランチが作られないことを確認します。"""
    with allure.step("危険な tar を用意して公開の CLI を動かす"):
        tar = Path(scene["tmp"]) / "bad.tar"
        with tarfile.open(tar, "w") as t:
            _add_file(t, "./index.html", _page())
            _add(t, "./link", tarfile.SYMTYPE, "/etc/passwd")
        result, output = _cli(scene, "--side", "dev", "--tar", str(tar), "--sha", str(scene["c1"]))
    with allure.step("終了コード 1・changed=false と、何も push されないことを確かめる"):
        assert result.returncode == 1
        assert output == "changed=false\n"
        assert "  - `./link`: シンボリックリンクです" in result.stdout
        assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


@allure.title(
    "PR 版の保管は、その PR のディレクトリと記録だけを変え、開いていない PR のディレクトリを消す"
)
def test_publish_pr_changes_only_its_dir_and_record_and_drops_closed_prs(
    scene: dict[str, Path | str],
) -> None:
    """開発版と PR #5 を保管した後で、PR #12 を保管し、開いている PR を 12 だけにした場合のテストです。`pr/` の外が変わらず、`pr/12/` だけが残り、記録の `pr` に 12 だけが入り、概要に消した PR が表示されることを確認します。"""
    with allure.step(
        "PR の公開が、その PR のディレクトリと記録だけを変え、閉じた PR を消すことを確かめる"
    ):
        # T037: PR 版の保管は pr/N/ と記録だけを変え、開いていない PR の pr/N/ を消す。
        assert store.publish(_opts(scene, side="dev", sha=scene["c1"], open_prs=[5, 12])).code == 0
        assert (
            store.publish(_opts(scene, side="pr", pr=5, sha=scene["c0"], open_prs=[5, 12])).code
            == 0
        )
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


def _report_tar(scene: dict[str, Path | str], name: str, history: str | None = None) -> Path:
    """レポートの tar。既定は履歴を持たない開発版の形。"""
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


@allure.title("レポートへのリンクを含む開発版の定義書を保管した後で、開発版のレポートを保管できる")
def test_publish_dev_site_with_report_links_then_dev_report(scene: dict[str, Path | str]) -> None:
    """レポートへのリンクを含む定義書の tar を保管してから、開発版のレポートを保管し、定義書を置き直した場合のテストです。履歴を持たないレポートが保管されて記録が付き、概要に種類が表示され、定義書を置き直してもレポートが残ることを確認します。"""
    with allure.step("dev のサイトの tar を用意する"):
        site = _site_tar(scene, "site1")
    with allure.step("dev のサイトとレポートを順に公開し、リンク・レポート・記録・要約を確かめる"):
        assert store.publish(_opts(scene, tree=None, tar=site, sha=scene["c1"])).code == 0
        files = _remote_files(scene)
        assert files["dev/_generated/p/tool.html"].count("test-report/index.html?tags=X-01") == 1
        assert "テストレポートはまだありません" in files["dev/test-report/index.html"]

        code, summary, changed = store.publish(_report_opts(scene, "rep1", sha=scene["c1"]))
        assert (code, changed) == (0, True), summary
        files = _remote_files(scene)
        assert files["dev/test-report/name.txt"] == "rep1"
        assert "dev/test-report/history.jsonl" not in files
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

        # 定義書を置き直しても、レポートは残る。
        assert (
            store.publish(
                _opts(scene, tree=None, tar=_site_tar(scene, "site2"), sha=scene["c2"])
            ).code
            == 0
        )
        files = _remote_files(scene)
        assert (files["dev/sub/page.html"], files["dev/test-report/name.txt"]) == ("site2", "rep1")
        assert json.loads(files[".pecot-store.json"])["reports"]["dev"]["sha"] == scene["c1"]


@allure.title("定義書を保管した場合は、概要に種類として「定義書」を表示する")
def test_publish_summary_names_the_site_kind(scene: dict[str, Path | str]) -> None:
    """`kind` を指定せずに `publish` を実行した場合のテストです。概要に、種類が定義書である旨の行が表示されることを確認します。"""
    with allure.step("公開の要約に「定義書」の種類が出ることを確かめる"):
        assert "- 種類: 定義書" in store.publish(_opts(scene)).summary


@allure.title("リリース版のレポートを保管すると、`sources` をレポートの記録に書く")
def test_publish_release_report_writes_sources(scene: dict[str, Path | str]) -> None:
    """`--sources` を指定して、リリース版のレポートを `publish` に渡した場合のテストです。リリース版の `test-report/` にレポートが入り、記録の `reports` に `sources` が書かれ、`release` は空のままであることを確認します。"""
    with allure.step("release のレポートの元の記録を用意する"):
        sources = Path(scene["tmp"]) / "report-sources.json"
        body = {"side": "release", "runs": [], "missing": ["pecot-tools"]}
        sources.write_text(json.dumps(body), encoding="utf-8")
        tar = _report_tar(scene, "rel-history", '{"u":1}\n')
        code, summary, _ = store.publish(
            _report_opts(scene, "rel", side="release", sha=scene["c2"], sources=sources, tar=tar)
        )
    with allure.step("公開した結果の終了コードとファイルと記録を確かめる"):
        assert code == 0, summary
        files = _remote_files(scene)
        assert files["test-report/name.txt"] == "rel-history"
        assert "テストレポートはまだありません" in files["dev/test-report/index.html"]
        assert "<h1>リリース版はまだありません</h1>" in files["index.html"]
        meta = json.loads(files[".pecot-store.json"])
        assert meta["reports"]["release"]["sources"] == body
        assert meta["release"] is None
        assert "- 側: リリース版" in summary and "- 種類: レポート" in summary


@allure.title("保管済みより古い開発版のレポートは、保管せずに終了コード 0 で終了する")
def test_publish_skips_older_dev_report(scene: dict[str, Path | str]) -> None:
    """新しい開発版のレポートを保管した後で、古い SHA のレポートを `publish` に渡した場合のテストです。終了コード 0 で終了し、概要へ保管しない理由を表示し、リモートの内容を変更しないことを確認します。"""
    with allure.step(
        "新しい dev のレポートの後に古いレポートを公開して、保管されないことを確かめる"
    ):
        assert store.publish(_report_opts(scene, "rep2", sha=scene["c2"])).code == 0
        before = _remote_files(scene)
        code, summary, changed = store.publish(_report_opts(scene, "rep1", sha=scene["c1"]))
        assert (code, changed) == (0, False)
        assert "- 採否: 保管しない（新しい開発版のレポートが先に保管されています）" in summary
        assert _remote_files(scene) == before


@allure.title(
    "開発版のレポートの新旧は、保管済みのレポートとだけ比べ、定義書の新旧とは関係なく扱う"
)
def test_publish_dev_report_is_compared_with_the_stored_report_only(
    scene: dict[str, Path | str],
) -> None:
    """定義書の開発版が新しい状態で、古い SHA のレポートを保管し、さらに古いレポートを保管した場合のテストです。最初のレポートは保管され、さらに古いレポートは保管されず、定義書とレポートの SHA がそれぞれ記録に残ることを確認します。"""
    with allure.step(
        "dev のサイトの後に dev のレポートを公開し、保管済みのレポートとだけ比べられることを確かめる"
    ):
        # 定義書の開発版が新しくても、レポートの開発版が無ければ受ける。逆も同じ。
        assert store.publish(_opts(scene, sha=scene["c2"])).code == 0
        code, summary, changed = store.publish(_report_opts(scene, "rep1", sha=scene["c1"]))
        assert (code, changed) == (0, True), summary
        code, summary, changed = store.publish(_report_opts(scene, "rep0", sha=scene["c0"]))
        assert changed is False
        meta = json.loads(_remote_files(scene)[".pecot-store.json"])
        assert (meta["dev"]["sha"], meta["reports"]["dev"]["sha"]) == (scene["c2"], scene["c1"])


@allure.title(
    "開発版のレポートの SHA が `main` の祖先でない場合は、終了コード 1 で終了し、push しない"
)
def test_publish_refuses_dev_report_outside_main(scene: dict[str, Path | str]) -> None:
    """`main` から分かれたブランチの commit を、開発版のレポートとして `publish` に渡した場合のテストです。終了コード 1 で終了し、概要へ祖先ではない旨を表示し、リモートにブランチを作成しないことを確認します。"""
    with allure.step("main の外の commit の dev のレポートを用意する"):
        history = Path(scene["history"])
        _run_git(history, "checkout", "-q", "-b", "topic")
        _run_git(history, "commit", "-q", "--allow-empty", "-m", "topic")
        topic = _run_git(history, "rev-parse", "HEAD")
        code, summary, changed = store.publish(_report_opts(scene, "rep", sha=topic))
    with allure.step("公開が断られて何も push されないことを確かめる"):
        assert (code, changed) == (1, False)
        assert "が `main` の祖先ではありません" in summary
        assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


@allure.title("{side} のレポートの確認に通らない tar は、終了コード 1 で終了し、push しない")
@pytest.mark.parametrize(
    ("side", "history", "expected"),
    [
        ("release", '{"u":1}\nnull\n', "  - `history.jsonl` の 2 行目を Allure が読めません"),
        ("dev", '{"u":1}\n', "  - 開発版のレポートは `history.jsonl` を持てません"),
    ],
)
def test_publish_refuses_a_report_that_fails_report_check(
    scene: dict[str, Path | str], side: str, history: str, expected: str
) -> None:
    """読めない行の履歴を含むリリース版と、履歴を含む開発版のレポートの tar を `publish` に渡した場合のテストです。終了コード 1 で終了し、概要へ指摘と種類を表示し、リモートにブランチを作成しないことを確認します。"""
    with allure.step("確認に通らないレポートの tar を用意して公開する"):
        sources = Path(scene["tmp"]) / "report-sources.json"
        sources.write_text(json.dumps({"side": side, "runs": []}), encoding="utf-8")
        tar = _report_tar(scene, "bad", history)
        code, summary, changed = store.publish(
            _report_opts(scene, "unused", tar=tar, side=side, sources=sources)
        )
    with allure.step("公開が断られて理由が要約に出ることを確かめる"):
        assert (code, changed) == (1, False)
        assert expected in summary
        assert "- 種類: レポート" in summary
        assert _run_git(Path(scene["remote"]), "branch", "--list") == ""


@allure.title("PR 版は、テストレポートへのリンクを含む tar を拒否する")
def test_publish_refuses_pr_side_with_report_links(scene: dict[str, Path | str]) -> None:
    """テストレポートへのリンクを含む定義書の tar を、PR 版として `publish` に渡した場合のテストです。終了コードが 1 になり、概要にそのリンクの先がない旨の指摘が表示されることを確認します。"""
    with allure.step("レポートへのリンクを持つ PR 側の tar を用意する"):
        tar = _site_tar(scene, "pr")
        code, summary, _ = store.publish(
            _opts(scene, side="pr", pr=4, tree=None, tar=tar, open_prs=[4])
        )
    with allure.step("公開が断られてリンク切れの理由が出ることを確かめる"):
        assert code == 1
        assert "`index.html`: `test-report/index.html` の先がありません" in summary


@allure.title("定義書の tar に `test-report/` が含まれる場合は、終了コード 1 で終了する")
def test_publish_refuses_a_site_tar_with_test_report(scene: dict[str, Path | str]) -> None:
    """`test-report/` のディレクトリを含む定義書の tar を `publish` に渡した場合のテストです。終了コードが 1 になり、概要に `test-report/` は保管がレポートを置く場所である旨が表示されることを確認します。"""
    with allure.step("test-report を持つサイトの tar を用意して公開する"):
        tar = Path(scene["tmp"]) / "own.tar"
        with tarfile.open(tar, "w") as t:
            _add_file(t, "./index.html", _page())
            _add_file(t, "./test-report/index.html", "own")
        code, summary, _ = store.publish(_opts(scene, tree=None, tar=tar))
    with allure.step("公開が断られて理由が出ることを確かめる"):
        assert code == 1
        assert "`./test-report/index.html`: `test-report/` は保管でレポートを置く所です" in summary


@allure.title(
    "レポートの `publish` に不正なオプション {over} を渡すと、{message} に関する例外が発生する"
)
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
    """レポートの `publish` に、PR 版・側なし・tar なし・tree と tar の併用・不明な kind・`sources` のないリリース版を渡した場合のテストです。いずれも、該当するオプションを示す `ValueError` が発生することを確認します。"""
    with allure.step("レポートの公開に誤った指定を渡すと、ValueError になることを確かめる"):
        with pytest.raises(ValueError, match=message):
            store.publish(_report_opts(scene, "rep", **over))


@allure.title("`publish` コマンドでレポートの tar を渡すと、レポートとして保管し、変更ありと書く")
def test_publish_cli_report(scene: dict[str, Path | str]) -> None:
    """`--kind report` を指定して、レポートの tar を `store.py publish` で保管した場合のテストです。終了コードが 0 になり、`changed=true` が書かれ、`dev/test-report/` にレポートが入り、記録に `run_id` が入ることを確認します。"""
    with allure.step("レポートの tar を用意して公開の CLI を動かす"):
        tar = _report_tar(scene, "cli")
        args = ("--kind", "report", "--side", "dev", "--tar", str(tar), "--sha", str(scene["c1"]))
        result, output = _cli(scene, *args, "--run-id", "9")
    with allure.step("終了コードと changed の出力と保管先のレポートを確かめる"):
        assert result.returncode == 0, result.stderr
        assert output == "changed=true\n"
        files = _remote_files(scene)
        assert files["dev/test-report/name.txt"] == "cli"
        assert json.loads(files[".pecot-store.json"])["reports"]["dev"]["run_id"] == "9"
