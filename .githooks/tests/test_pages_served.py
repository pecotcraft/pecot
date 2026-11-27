"""pages_site/served.py のテスト。公開した目印を、CDN の写しを避けて読み戻し、出そろうまで待つこと。"""

from __future__ import annotations

import random
import sys
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
    with allure.step("170 秒から期待した目印が返る"):
        result, _urls = _wait(replies)
    with allure.step("180 秒で偽を返す"):
        assert result is False


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
