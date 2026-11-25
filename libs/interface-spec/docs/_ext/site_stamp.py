"""公開の側（SiteStamp）。リリース版でない側の 1 行の知らせと、テストレポートへのリンクを決める。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

GITHUB = "https://github.com/pecotcraft/pecot"
SIDES = ("release", "dev", "pr", "local")
NOTICES = {
    "dev": "これは開発中のバージョンのドキュメントです。",
    "local": "これはローカルでビルドしたドキュメントです。",
}
# 側のルートからの相対。pages-deploy がレポートを <側>/test-report/ に置く。
REPORT_URL = "test-report/index.html"


class SiteStampError(ValueError):
    """側が決まらない。conf.py の読み込みで投げ、サイトを作らずに止める。"""


@dataclass(frozen=True)
class SiteStamp:
    side: str
    pr: int | None
    plugins: tuple[str, ...] = ()
    # リリース版で、レポートに入っているプラグイン（PECOT_SITE_REPORT_PLUGINS）。
    released: tuple[str, ...] = ()

    @property
    def report_plugins(self) -> list[str]:
        if self.side == "dev":
            return list(self.plugins)
        return list(self.released) if self.side == "release" else []

    @property
    def report_url(self) -> str | None:
        if self.side == "dev" or (self.side == "release" and self.released):
            return REPORT_URL
        return None

    def context(self) -> dict[str, Any]:
        """テンプレートに渡す値。Sphinx が設定を pickle するので、文字列・None・list だけで組む。"""
        if self.side == "pr":
            notice = f"これはプルリクエスト #{self.pr} のプレビューです。"
        else:
            notice = NOTICES.get(self.side)
        reported = self.report_plugins
        return {
            "side": self.side,
            "notice": notice,
            "pr_url": f"{GITHUB}/pull/{self.pr}" if self.side == "pr" else None,
            # 公開サイトの絶対パスなので、手元で開くと行き先は無い。手元では出さない。
            "release_url": "/pecot/" if self.side in ("dev", "pr") else None,
            "report_url": self.report_url,
            "report_plugins": reported,
            "report_missing": (
                [p for p in self.plugins if p not in reported] if self.side == "release" else []
            ),
        }


def site_stamp(env: Mapping[str, str], plugins: Sequence[str] = ()) -> SiteStamp:
    """env は PECOT_SITE_SIDE・PECOT_SITE_PR・PECOT_SITE_REPORT_PLUGINS を読む。plugins はサイトに載せるプラグイン。"""
    side = env.get("PECOT_SITE_SIDE") or "local"
    if side not in SIDES:
        raise SiteStampError(f"PECOT_SITE_SIDE は {' / '.join(SIDES)} のどれかです: {side}")
    if side == "release":
        names = (n.strip() for n in env.get("PECOT_SITE_REPORT_PLUGINS", "").split(","))
        released = tuple(dict.fromkeys(n for n in names if n))
        return SiteStamp(side=side, pr=None, plugins=tuple(plugins), released=released)
    if side != "pr":
        return SiteStamp(side=side, pr=None, plugins=tuple(plugins))
    number = env.get("PECOT_SITE_PR") or ""
    if not number.isdecimal():
        raise SiteStampError(
            f"PECOT_SITE_SIDE=pr には PECOT_SITE_PR に PR の番号が要ります: {number}"
        )
    return SiteStamp(side=side, pr=int(number), plugins=tuple(plugins))
