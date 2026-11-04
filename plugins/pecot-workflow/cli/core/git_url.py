"""core/git_url.py - Git リモート URL パースユーティリティ

HTTPS / SSH 形式の Git リモート URL から ``(host, owner, repo)`` を抽出する。

複数モジュールから再利用するため例外は ``ValueError`` とし、
ドメイン特化の例外が要る場合は、呼び出し側でこの例外をラップする設計とする。
"""

from __future__ import annotations

import re

_HTTPS_URL_PATTERN = re.compile(r"^https?://([^/]+)/([^/]+)/([^/]+?)(?:\.git)?$")
_SSH_URL_PATTERN = re.compile(r"^git@([^:]+):([^/]+)/([^/]+?)(?:\.git)?$")
_SSH_SCHEME_URL_PATTERN = re.compile(
    r"^ssh://(?:[^@/]+@)?([^/:@]+)(?::\d+)?/([^/]+)/([^/]+?)(?:\.git)?/?$"
)


def parse_remote_url(url: str) -> tuple[str, str, str]:
    """リモート URL をパースして ``(host, owner, repo)`` を返す。

    対応する形式は次のとおり。
    HTTPS (`https://host/owner/repo[.git]`)。
    SSH (`git@host:owner/repo[.git]`)。
    ssh スキーム (`ssh://[user@]host[:port]/owner/repo[.git][/]`)。
    前後の空白は除去される。

    Raises:
        ValueError: URL が想定形式に一致しない場合
    """
    url = url.strip()
    m = _HTTPS_URL_PATTERN.match(url)
    if m:
        return m.group(1), m.group(2), m.group(3)
    m = _SSH_URL_PATTERN.match(url)
    if m:
        return m.group(1), m.group(2), m.group(3)
    m = _SSH_SCHEME_URL_PATTERN.match(url)
    if m:
        return m.group(1), m.group(2), m.group(3)
    raise ValueError(f"unexpected remote URL format: {url}")
