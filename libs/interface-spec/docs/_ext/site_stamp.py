"""公開の側（SiteStamp）。リリース版でない側で、ページの上に出す 1 行の知らせを決める。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

GITHUB = "https://github.com/pecotcraft/pecot"
SIDES = ("release", "dev", "pr", "local")
NOTICES = {
    "dev": "これは開発中のバージョンのドキュメントです。",
    "local": "これはローカルでビルドしたドキュメントです。",
}


class SiteStampError(ValueError):
    """側が決まらない。conf.py の読み込みで投げ、サイトを作らずに止める。"""


@dataclass(frozen=True)
class SiteStamp:
    side: str
    pr: int | None

    def context(self) -> dict[str, Any]:
        """テンプレートに渡す値。Sphinx が設定を pickle するので、文字列と None だけで組む。"""
        if self.side == "pr":
            notice = f"これはプルリクエスト #{self.pr} のプレビューです。"
        else:
            notice = NOTICES.get(self.side)
        return {
            "side": self.side,
            "notice": notice,
            "pr_url": f"{GITHUB}/pull/{self.pr}" if self.side == "pr" else None,
            # 公開サイトの絶対パスなので、手元で開くと行き先は無い。手元では出さない。
            "release_url": "/pecot/" if self.side in ("dev", "pr") else None,
        }


def site_stamp(env: Mapping[str, str]) -> SiteStamp:
    """env は PECOT_SITE_SIDE と PECOT_SITE_PR を読む。"""
    side = env.get("PECOT_SITE_SIDE") or "local"
    if side not in SIDES:
        raise SiteStampError(f"PECOT_SITE_SIDE は {' / '.join(SIDES)} のどれかです: {side}")
    if side != "pr":
        return SiteStamp(side=side, pr=None)
    number = env.get("PECOT_SITE_PR") or ""
    if not number.isdecimal():
        raise SiteStampError(
            f"PECOT_SITE_SIDE=pr には PECOT_SITE_PR に PR の番号が要ります: {number}"
        )
    return SiteStamp(side=side, pr=int(number))
