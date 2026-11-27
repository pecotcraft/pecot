"""pages-deploy.yml の deploy の job。store の job が書いた目印を読み戻し、公開の元のすべてで出そろうまで待つ。

決まりは specs/028-pages-site/contracts/pages.md の「公開の確かめ」。
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

MARKER = "pages-version.txt"
_READ_LIMIT = 4096
_REQUEST_TIMEOUT = 10


@dataclass(frozen=True)
class Reply:
    """1 回の読み出しの結果。status が None なら通信に失敗した。"""

    status: int | None
    body: str = ""
    cache: str = ""
    request_id: str = ""


Fetch = Callable[[str], Reply]


def marker_url(page_url: str) -> str:
    """deploy-pages の page_url から目印の URL を作る。"""
    return (page_url if page_url.endswith("/") else page_url + "/") + MARKER


def variant(url: str, rng: random.Random) -> str:
    """ファイル名の英数字から空でない組を選び、百分率符号化した URL。問い合わせの文字列は落とす。

    RFC 3986 §6.2.2.2 では、非予約文字の符号化の有無は同じ資源を指す。CDN はこれを別の URL として扱う。
    """
    parts = urlsplit(url)
    head, _, name = parts.path.rpartition("/")
    letters = [i for i, c in enumerate(name) if c.isascii() and c.isalnum()]
    if not letters:
        raise ValueError(f"ファイル名に英数字がありません: {url}")
    picks: set[int] = set()
    while not picks:
        picks = {i for i in letters if rng.random() < 0.5}
    encoded = "".join(f"%{ord(c):02X}" if i in picks else c for i, c in enumerate(name))
    return urlunsplit((parts.scheme, parts.netloc, f"{head}/{encoded}", "", ""))


def fetch(url: str) -> Reply:
    """GET の結果。HTTP の失敗は status に、通信の失敗は status None にする。"""
    request = urllib.request.Request(url, headers={"User-Agent": "pecot-pages-deploy"})
    try:
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT) as response:
            body = response.read(_READ_LIMIT).decode("utf-8", "replace")
            return Reply(
                response.status,
                body,
                response.headers.get("x-cache", ""),
                response.headers.get("x-github-request-id", ""),
            )
    except urllib.error.HTTPError as error:
        return Reply(
            error.code,
            "",
            error.headers.get("x-cache", ""),
            error.headers.get("x-github-request-id", ""),
        )
    except (urllib.error.URLError, OSError):
        return Reply(None)


def _value(reply: Reply) -> str:
    if reply.status != 200 or not reply.body:
        return ""
    return reply.body.splitlines()[0].strip()


def wait_served(
    url: str,
    expect: str,
    *,
    timeout: float,
    interval: float,
    settle: float,
    fetch: Fetch = fetch,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    rng: random.Random | None = None,
    log: Callable[[str], None] = print,
) -> bool:
    """毎回違う URL で目印を読み、expect と合う読み出しが settle 秒続けば真。timeout 秒を過ぎれば偽。

    404・通信の失敗・違う値は、まだ出そろっていないとして数え直す。公開の元ごとに出る時刻がずれるため。
    """
    rng = rng or random.Random()
    used: set[str] = set()
    start = clock()
    since: float | None = None
    while True:
        now = clock() - start
        target = variant(url, rng)
        while target in used:
            target = variant(url, rng)
        used.add(target)
        reply = fetch(target)
        value = _value(reply)
        log(
            f"{now:6.1f}s status={reply.status if reply.status is not None else 'error'}"
            f" x-cache={reply.cache or '-'} request={reply.request_id or '-'}"
            f" value={value or '-'} url={target}"
        )
        if value == expect:
            since = now if since is None else since
            if now - since >= settle:
                return True
        else:
            since = None
        if now >= timeout:
            return False
        sleep(interval)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="公開した目印が、公開の元のすべてで出そろうまで待つ"
    )
    parser.add_argument("--page-url", required=True, help="deploy-pages の page_url")
    parser.add_argument(
        "--expect", required=True, help="目印の中身（pages-store の SHA と run の番号）"
    )
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--settle", type=float, default=30)
    parser.add_argument("--require", action="store_true", help="出そろわなければ終了コード 1")
    args = parser.parse_args(argv)

    url = marker_url(args.page_url)
    served = wait_served(
        url, args.expect, timeout=args.timeout, interval=args.interval, settle=args.settle
    )
    print(f"{url}: {'出そろった' if served else '出そろわなかった'}（期待した値 {args.expect}）")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"served={'true' if served else 'false'}\n")
    return 1 if args.require and not served else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
