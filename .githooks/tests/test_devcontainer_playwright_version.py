"""devcontainer の playwright-deps の版が、pnpm-lock.yaml の playwright と一致することを pin する。

イメージに入れる Chromium の依存パッケージは、playwright-core の install-deps で決まる。
版がずれると、実行時に使う Chromium の依存と、イメージに入れたものが食い違う。
"""

from __future__ import annotations

import re
from pathlib import Path

# parents[0]=tests, [1]=.githooks, [2]=リポルート。
_REPO_ROOT = Path(__file__).resolve().parents[2]


def _lock_playwright_versions() -> list[str]:
    text = (_REPO_ROOT / "pnpm-lock.yaml").read_text(encoding="utf-8")
    return sorted(set(re.findall(r"^  playwright@(\d[^\s:]*):$", text, re.M)))


def _devcontainer_version() -> str:
    text = (_REPO_ROOT / ".devcontainer" / "devcontainer.json").read_text(encoding="utf-8")
    # JSONC なので json では読まず、該当の 1 行だけを取り出す。
    m = re.search(r'"\./features/playwright-deps"\s*:\s*\{\s*"version"\s*:\s*"([^"]*)"', text)
    assert m, "devcontainer.json に ./features/playwright-deps の version がない"
    return m.group(1)


def test_playwright_deps_version_matches_lock() -> None:
    locked = _lock_playwright_versions()
    assert locked, "pnpm-lock.yaml に playwright@X.Y.Z がない"
    actual = _devcontainer_version()
    assert actual in locked, (
        "devcontainer.json の playwright-deps の version を pnpm-lock.yaml の playwright にそろえる。"
        f" devcontainer.json: {actual}、pnpm-lock.yaml の playwright: {locked}"
        "（複数あるときは、Chromium を起動する playwright の版にそろえる）"
    )
    assert len(locked) == 1, (
        f"pnpm-lock.yaml に playwright が複数版ある: {locked}。"
        " どの版にそろえるかをこのテストで決め直す"
    )
