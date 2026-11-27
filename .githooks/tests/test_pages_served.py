"""pages_site/served.py のテスト。公開した目印を、CDN の写しを避けて読み戻し、出そろうまで待つこと。"""

from __future__ import annotations

import email.message
import http.client
import random
import sys
import urllib.error
from pathlib import Path
from urllib.parse import unquote, urlsplit

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/pages_site"))

import served  # noqa: E402
from served import MARKER, Reply, marker_url, variant, wait_served  # noqa: E402

URL = "https://pecotcraft.github.io/pecot/pages-version.txt"
EXPECT = "abc123 45981908731-1"
OLD = "def456 45981784349-1"


class _Clock:
    """sleep で進む時計。"""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def _wait(
    replies: list[Reply], *, timeout: float = 180, settle: float = 30
) -> tuple[bool, list[str]]:
    clock = _Clock()
    urls: list[str] = []
    queue = list(replies)

    def fetch(url: str) -> Reply:
        urls.append(url)
        return queue.pop(0) if len(queue) > 1 else queue[0]

    result = wait_served(
        URL,
        EXPECT,
        timeout=timeout,
        interval=5,
        settle=settle,
        fetch=fetch,
        sleep=clock.sleep,
        clock=clock,
        rng=random.Random(872),
        log=lambda _line: None,
    )
    return result, urls


def _ok(value: str) -> Reply:
    return Reply(200, value + "\n", "MISS", "id")


@allure.title("目印の URL は、page_url の末尾の / の有無にかかわらず根の pages-version.txt になる")
@pytest.mark.parametrize(
    "page_url", ["https://pecotcraft.github.io/pecot/", "https://pecotcraft.github.io/pecot"]
)
def test_marker_url(page_url: str) -> None:
    """`marker_url` のテストです。deploy-pages の `page_url` から、サイトの根の目印の URL を作ることを確認します。"""
    with allure.step("目印の URL を作る"):
        assert marker_url(page_url) == URL
        assert URL.endswith(MARKER)


@allure.title("符号化した URL は、毎回違い、復号すると元のパスに戻る")
def test_variant_encodes_a_nonempty_subset() -> None:
    """`variant` のテストです。ファイル名の英数字から空でない組を百分率符号化し、問い合わせの文字列を落とし、復号すると元の URL に戻ることを確認します。"""
    rng = random.Random(1)
    with allure.step("100 回作る"):
        urls = [variant(URL + "?x=1", rng) for _ in range(100)]
    with allure.step("どれも符号化を含み、復号すると元のパスに戻る"):
        for url in urls:
            parts = urlsplit(url)
            assert "%" in parts.path
            assert parts.query == ""
            assert f"{parts.scheme}://{parts.netloc}{unquote(parts.path)}" == URL
            assert parts.path.startswith("/pecot/")
    with allure.step("ほとんどが違う URL になる"):
        assert len(set(urls)) > 90


@allure.title("ファイル名に英数字が無い URL は、符号化できずに止まる")
def test_variant_rejects_name_without_letters() -> None:
    """`variant` のテストです。ファイル名に英数字が無いと `ValueError` で止まることを確認します。"""
    with allure.step("ファイル名の無い URL を渡す"), pytest.raises(ValueError, match="英数字"):
        variant("https://pecotcraft.github.io/pecot/", random.Random(1))


@allure.title("目印が settle の秒数続けて合うと、出そろったとする")
def test_served_after_settle() -> None:
    """`wait_served` のテストです。期待した目印が 30 秒続けて返ると真を返し、読むたびに違う URL を使うことを確認します。"""
    with allure.step("初めから期待した目印が返る"):
        result, urls = _wait([_ok(EXPECT)])
    with allure.step("0 秒から 30 秒までの 7 回で出そろう"):
        assert result is True
        assert len(urls) == 7
        assert len(set(urls)) == len(urls)


@allure.title("前の目印・404・通信の失敗が返ると、数え直して待ち続ける")
def test_restarts_on_old_value_404_and_error() -> None:
    """`wait_served` のテストです。公開の元によって前の目印や 404 が返るあいだは数え直し、合う値が続いてから真を返すことを確認します。"""
    replies = [Reply(404), _ok(OLD), Reply(None), _ok(EXPECT), _ok(EXPECT), _ok(OLD), _ok(EXPECT)]
    with allure.step("前の目印・404・通信の失敗をはさむ"):
        result, urls = _wait(replies)
    with allure.step("最後の違う値の後から 30 秒続いて出そろう"):
        assert result is True
        assert len(urls) == 6 + 7


@allure.title("期限までに出そろわなければ偽を返す")
def test_times_out() -> None:
    """`wait_served` のテストです。前の目印が返り続けると、期限の 180 秒を過ぎたところで偽を返すことを確認します。"""
    with allure.step("前の目印が返り続ける"):
        result, urls = _wait([_ok(OLD)])
    with allure.step("0 秒から 180 秒までの 37 回で諦める"):
        assert result is False
        assert len(urls) == 37


@allure.title("期限の直前に合い始めても、settle の秒数が続かなければ偽を返す")
def test_times_out_while_settling() -> None:
    """`wait_served` のテストです。期限の近くで合い始めた目印は、出そろったと数えないことを確認します。"""
    replies = [_ok(OLD)] * 35 + [_ok(EXPECT)]
    with allure.step("175 秒から期待した目印が返る"):
        result, urls = _wait(replies)
    with allure.step("合い始めて 5 秒の 180 秒で偽を返す"):
        assert result is False
        assert len(urls) == 37


@allure.title("CLI は結果を GITHUB_OUTPUT に書き、--require のときだけ失敗で終わる")
@pytest.mark.parametrize(
    ("ok", "require", "code"),
    [(True, False, 0), (False, False, 0), (True, True, 0), (False, True, 1)],
)
def test_main_writes_output(
    ok: bool, require: bool, code: int, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`main` のテストです。`served=true|false` を `GITHUB_OUTPUT` に書き、`--require` で出そろわなければ終了コード 1 になることを確認します。"""
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    seen: dict[str, object] = {}

    def fake_wait(url: str, expect: str, **kwargs: object) -> bool:
        seen.update(url=url, expect=expect, **kwargs)
        return ok

    monkeypatch.setattr(served, "wait_served", fake_wait)
    argv = ["--page-url", "https://pecotcraft.github.io/pecot/", "--expect", EXPECT]
    with allure.step("CLI を動かす"):
        result = served.main(argv + (["--require"] if require else []))
    with allure.step("終了コードと出力を確かめる"):
        assert result == code
        assert output.read_text(encoding="utf-8") == f"served={'true' if ok else 'false'}\n"
        assert seen == {"url": URL, "expect": EXPECT, "timeout": 180, "interval": 5, "settle": 30}


@allure.title("CLI は --url で、目印でない任意のファイルを読む")
def test_main_reads_given_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """`main` のテストです。`--url` を渡した場合に、目印の URL でなく渡した URL を読むことを確認します。"""
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    seen: list[str] = []

    def fake_wait(url: str, expect: str, **_kwargs: object) -> bool:
        seen.append(url)
        return True

    monkeypatch.setattr(served, "wait_served", fake_wait)
    page = "https://pecotcraft.github.io/pecot/dev/test-report/index.html"
    with allure.step("--url を渡して CLI を動かす"):
        result = served.main(["--url", page, "--expect", "<!DOCTYPE html>"])
    with allure.step("渡した URL を読んだことを確かめる"):
        assert result == 0
        assert seen == [page]


@allure.title("CLI は、--page-url と --url の両方か、どちらも無いと止まる")
@pytest.mark.parametrize(
    "targets",
    [[], ["--page-url", "https://pecotcraft.github.io/pecot/", "--url", URL]],
    ids=["none", "both"],
)
def test_main_requires_one_target(targets: list[str]) -> None:
    """`main` のテストです。読む先を指定しない場合と 2 つ指定した場合に、引数の誤りで終了することを確認します。"""
    with allure.step("CLI を動かす"), pytest.raises(SystemExit) as stopped:
        served.main([*targets, "--expect", EXPECT])
    with allure.step("終了コードが 2 であることを確かめる"):
        assert stopped.value.code == 2


class _Response:
    """urlopen が返す応答の偽物。"""

    def __init__(
        self, body: bytes, headers: dict[str, str], error: Exception | None = None
    ) -> None:
        self.status = 200
        self.headers = headers
        self._body = body
        self._error = error

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, _limit: int) -> bytes:
        if self._error:
            raise self._error
        return self._body


@allure.title("fetch は、200 の応答の中身と、x-cache・x-github-request-id を返す")
def test_fetch_returns_body_and_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    """`fetch` のテストです。200 の応答の場合に、本文と CDN の写しかを示すヘッダを返すことを確認します。"""
    response = _Response(b"abc123 1-1\n", {"x-cache": "MISS", "x-github-request-id": "R1"})
    monkeypatch.setattr(served.urllib.request, "urlopen", lambda *_a, **_k: response)
    with allure.step("fetch を呼ぶ"):
        reply = served.fetch(URL)
    with allure.step("中身とヘッダを確かめる"):
        assert reply == Reply(200, "abc123 1-1\n", "MISS", "R1")


@allure.title("fetch は、404 の応答を status に入れて返す")
def test_fetch_returns_http_error_status(monkeypatch: pytest.MonkeyPatch) -> None:
    """`fetch` のテストです。HTTP の失敗の応答の場合に、例外を投げずに状態コードとヘッダを返すことを確認します。"""
    headers = email.message.Message()
    headers["x-cache"] = "HIT"
    headers["x-github-request-id"] = "R2"

    def not_found(*_args: object, **_kwargs: object) -> None:
        raise urllib.error.HTTPError(URL, 404, "Not Found", headers, None)

    monkeypatch.setattr(served.urllib.request, "urlopen", not_found)
    with allure.step("fetch を呼ぶ"):
        reply = served.fetch(URL)
    with allure.step("404 とヘッダを確かめる"):
        assert reply == Reply(404, "", "HIT", "R2")


@allure.title("fetch は、{name} の通信の失敗を status の無い結果にする")
@pytest.mark.parametrize(
    ("name", "error", "on_read"),
    [
        ("URLError", urllib.error.URLError("refused"), False),
        ("TimeoutError", TimeoutError("timed out"), False),
        ("BadStatusLine", http.client.BadStatusLine("x"), False),
        ("IncompleteRead", http.client.IncompleteRead(b""), True),
    ],
)
def test_fetch_turns_transport_errors_into_none(
    name: str, error: Exception, on_read: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`fetch` のテストです。接続・応答の行・本文の読み取りで失敗した場合に、例外を投げずに `status` が `None` の結果を返すことを確認します。"""

    def broken(*_args: object, **_kwargs: object) -> _Response:
        if on_read:
            return _Response(b"", {}, error)
        raise error

    monkeypatch.setattr(served.urllib.request, "urlopen", broken)
    with allure.step(f"{name} を起こして fetch を呼ぶ"):
        reply = served.fetch(URL)
    with allure.step("status の無い結果であることを確かめる"):
        assert reply == Reply(None)
