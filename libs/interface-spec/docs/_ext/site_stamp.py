"""公開の版（SiteStamp）。すべてのページの上の帯に出す値を、環境変数とリポジトリから決める。"""

from __future__ import annotations

import json
import re
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
    # リリース版だけ持つ。plugins と同じ順の (名前, タグのコミット)。
    plugin_commits: tuple[tuple[str, str], ...] = ()
    # PR 版だけ持つ。ci が動かさず、開発版の合否で埋めたレーンと、その開発版のコミット。
    filled: tuple[str, ...] = ()
    dev_sha: str | None = None

    @property
    def label(self) -> str:
        return f"PR #{self.pr}" if self.side == "pr" else SIDE_LABELS[self.side]

    def context(self) -> dict[str, Any]:
        """テンプレートに渡す値。Sphinx が設定を pickle するので、文字列と None と list だけで組む。"""
        commits = dict(self.plugin_commits)
        return {
            "side": self.side,
            "label": self.label,
            "sha": self.sha[:7],
            "commit_url": None if self.side == "local" else f"{GITHUB}/commit/{self.sha}",
            "plugins": " \N{KATAKANA MIDDLE DOT} ".join(
                f"{n} {v} ({commits[n][:7]})" if n in commits else f"{n} {v}"
                for n, v in self.plugins
            ),
            "built_at": self.built_at.strftime("%Y-%m-%d %H:%M UTC"),
            "built_at_iso": self.built_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "run_url": self.run_url,
            "pr_label": f"PR #{self.pr} を開く" if self.side == "pr" else None,
            "pr_url": f"{GITHUB}/pull/{self.pr}" if self.side == "pr" else None,
            "filled": ", ".join(self.filled) if self.filled else None,
            "dev_sha": self.dev_sha[:7] if self.filled and self.dev_sha else None,
            "dev_commit_url": (
                f"{GITHUB}/commit/{self.dev_sha}" if self.filled and self.dev_sha else None
            ),
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
    plugins = _plugin_versions(root)
    commits = _plugin_commits(get("PECOT_SITE_PLUGIN_COMMITS"), side, plugins)
    filled, dev_sha = _filled(get("PECOT_SITE_FILLED"), get("PECOT_SITE_DEV_SHA"), side)
    return SiteStamp(
        side=side,
        pr=pr,
        sha=sha,
        built_at=_built_at(get("PECOT_SITE_BUILT_AT"), now),
        run_url=get("PECOT_SITE_RUN_URL"),
        plugins=plugins,
        plugin_commits=commits,
        filled=filled,
        dev_sha=dev_sha,
    )


def _filled(
    value: str | None, dev_sha: str | None, side: str
) -> tuple[tuple[str, ...], str | None]:
    if side != "pr" or value is None:
        return (), None
    try:
        data: Any = json.loads(value)
    except ValueError:
        data = None
    if not isinstance(data, list) or not all(
        isinstance(n, str) and n for n in cast("list[Any]", data)
    ):
        raise SiteStampError(f"PECOT_SITE_FILLED はレーンの名前の JSON の配列です: {value}")
    names = tuple(cast("list[str]", data))
    if not names:
        return (), None
    if dev_sha is None or not re.fullmatch(r"[0-9a-f]{40}", dev_sha):
        raise SiteStampError(
            f"PECOT_SITE_FILLED があるときは PECOT_SITE_DEV_SHA に 40 桁の SHA が要ります: {dev_sha}"
        )
    return names, dev_sha


def _plugin_commits(
    value: str | None, side: str, plugins: tuple[tuple[str, str], ...]
) -> tuple[tuple[str, str], ...]:
    if side != "release":
        return ()
    if value is None:
        raise SiteStampError("PECOT_SITE_SIDE=release には PECOT_SITE_PLUGIN_COMMITS が要ります")
    commits: dict[str, str] = {}
    for item in value.split(","):
        name, sep, sha = item.strip().partition("=")
        if not sep or not name or not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise SiteStampError(
                f"PECOT_SITE_PLUGIN_COMMITS は <plugin>=<40 桁の SHA> をカンマでつなぎます: {item}"
            )
        commits[name] = sha
    names = [n for n, _ in plugins]
    if sorted(commits) != sorted(names):
        raise SiteStampError(
            f"PECOT_SITE_PLUGIN_COMMITS のプラグインが {', '.join(names)} とそろいません: {value}"
        )
    return tuple((n, commits[n]) for n in names)


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
