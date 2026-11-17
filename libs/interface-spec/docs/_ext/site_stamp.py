"""公開の版（SiteStamp）。すべてのページの上の帯に出す値を、環境変数とリポジトリから決める。"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

GITHUB = "https://github.com/pecotcraft/pecot"
SIDE_LABELS = {"release": "リリース版", "dev": "開発版", "local": "手元"}
# 側の行き来のリンク。公開サイトの絶対パスなので、手元で開くと行き先は無い。
SIDE_LINKS = (("release", "リリース版", "/pecot/"), ("dev", "開発版", "/pecot/dev/"))
SIDES = ("release", "dev", "pr", "local")


class SiteStampError(ValueError):
    """帯の値が決まらない。conf.py の読み込みで投げ、サイトを作らずに止める。"""


@dataclass(frozen=True)
class SiteStamp:
    side: str
    pr: int | None
    sha: str
    built_at: datetime
    run_url: str | None
    plugins: tuple[tuple[str, str], ...]

    @property
    def label(self) -> str:
        return f"PR #{self.pr}" if self.side == "pr" else SIDE_LABELS[self.side]

    def context(self) -> dict[str, Any]:
        """テンプレートに渡す値。Sphinx が設定を pickle するので、文字列と None と list だけで組む。"""
        return {
            "side": self.side,
            "label": self.label,
            "sha": self.sha[:7],
            "commit_url": None if self.side == "local" else f"{GITHUB}/commit/{self.sha}",
            "plugins": " \N{KATAKANA MIDDLE DOT} ".join(f"{n} {v}" for n, v in self.plugins),
            "built_at": self.built_at.strftime("%Y-%m-%d %H:%M UTC"),
            "built_at_iso": self.built_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "run_url": self.run_url,
            "pr_label": f"PR #{self.pr} を開く" if self.side == "pr" else None,
            "pr_url": f"{GITHUB}/pull/{self.pr}" if self.side == "pr" else None,
            "sides": [
                {"label": label, "href": None if side == self.side else href}
                for side, label, href in SIDE_LINKS
            ],
        }


def site_stamp(env: Mapping[str, str], root: Path, now: datetime, head: str | None) -> SiteStamp:
    """env は PECOT_SITE_* を読む。head は `git rev-parse HEAD` の値（取れなければ None）。"""

    def get(key: str) -> str | None:
        return env.get(key) or None

    side = get("PECOT_SITE_SIDE") or "local"
    if side not in SIDES:
        raise SiteStampError(f"PECOT_SITE_SIDE は {' / '.join(SIDES)} のどれかです: {side}")
    pr = None
    if side == "pr":
        number = get("PECOT_SITE_PR")
        if number is None or not number.isdecimal():
            raise SiteStampError(
                f"PECOT_SITE_SIDE=pr には PECOT_SITE_PR に PR の番号が要ります: {number}"
            )
        pr = int(number)
    sha = get("PECOT_SITE_SHA") or head
    if sha is None:
        raise SiteStampError(
            "コミットが決まりません。PECOT_SITE_SHA を付けるか、git のリポジトリで作ってください"
        )
    return SiteStamp(
        side=side,
        pr=pr,
        sha=sha,
        built_at=_built_at(get("PECOT_SITE_BUILT_AT"), now),
        run_url=get("PECOT_SITE_RUN_URL"),
        plugins=_plugin_versions(root),
    )


def _built_at(value: str | None, now: datetime) -> datetime:
    if value is None:
        return now.astimezone(timezone.utc)
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        parsed = None
    # 時差の無い値は UTC に直せないので、読めない値と同じに扱う。
    if parsed is None or parsed.tzinfo is None:
        raise SiteStampError(f"PECOT_SITE_BUILT_AT は時差付きの ISO 8601 の時刻です: {value}")
    return parsed.astimezone(timezone.utc)


def _plugin_versions(root: Path) -> tuple[tuple[str, str], ...]:
    # package.json の version は workspace 用の 0.0.0。nx release が上げるのは plugin.json の方。
    versions: list[tuple[str, str]] = []
    for manifest in (root / "plugins").glob("*/.claude-plugin/plugin.json"):
        name = manifest.parent.parent.name
        try:
            data: Any = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise SiteStampError(f"{name} の plugin.json を読めません: {e}") from e
        version = cast("dict[str, Any]", data).get("version") if isinstance(data, dict) else None
        if not isinstance(version, str) or not version:
            raise SiteStampError(f"{name} の plugin.json に version がありません: {manifest}")
        versions.append((name, version))
    return tuple(sorted(versions))
