"""core/dependabot_prs.py - 人の判断を待つ dependabot の PR を Tracker に載せるための純粋な処理

``core/dependabot.py`` は dependabot の *alert*（security の脆弱性）の例外ファイルを扱う。
ここは dependabot の *PR*（版上げ）を扱い、PR ごとに「待っている理由」を決める。
Tracker の本文（PR の一覧の表）を読み書きする処理と、行の足し外しを決める関数も置く。

自動マージの対象かは ``dependabot/fetch-metadata`` v3.1.0 と同じ情報源・規則で決める。
最初の commit の message の YAML を読み、各依存の ``update-type`` の最大を使う。
対象は minor・patch で playwright を含まない PR とする。
対象の PR は、検証・競合・queue の状態から理由を足す。理由が無い PR は載せない。

PR の題は dependabot が付ける公開の情報なので、表に出してよい。
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, cast

import yaml

from cli.core.errors import PecotError
from cli.core.tracker_body import list_region

PR_LABEL = "dependabot-pr"
TRACKER_MARKER = "<!-- pecot-dependabot-pr: tracker -->"
LIST_BEGIN = "<!-- pecot-dependabot-pr: list-begin -->"
LIST_END = "<!-- pecot-dependabot-pr: list-end -->"
PRIORITY = "medium"

REASON_UNKNOWN = "update-type 不明"
REASON_MAJOR = "major"
REASON_PLAYWRIGHT = "playwright"
REASON_FAILED = "検証が落ちた"
REASON_STUCK = "検証が終わらない"
REASON_CONFLICT = "競合"
REASON_DEQUEUED = "queue から外れた"
REASON_NO_AUTO_MERGE = "auto-merge が入っていない"

# dependabot-auto-merge.yml が auto-merge を入れるまでの猶予と、検証の待ち時間の上限
GRACE = timedelta(minutes=30)
CHECKS_TIMEOUT = timedelta(hours=24)

_ROW_MARKER_RE = re.compile(r"<!--\s*pecot-dependabot-pr:\s*pr/(\d+)\s*-->")
_LIST_BEGIN_RE = re.compile(r"<!--\s*pecot-dependabot-pr:\s*list-begin\s*-->")
_LIST_END_RE = re.compile(r"<!--\s*pecot-dependabot-pr:\s*list-end\s*-->")
TRACKER_RE = re.compile(r"<!--\s*pecot-dependabot-pr:\s*tracker\s*-->")

# fetch-metadata と同じ。commit の message から ``updated-dependencies:`` の YAML を抜く
_YAML_RE = re.compile(r"^-{3}\n([\s\S]*?)\n^\.{3}\n", re.MULTILINE)
_UPDATES_RE = re.compile(r"(?:Bumps|Updates) `?([^`\s]+)`? from (\S+) to (\S+)")
_UPDATE_TYPES = ("patch", "minor", "major")
_BOT_LOGIN = "dependabot[bot]"


class DependabotPrError(PecotError):
    """Tracker の本文を読み書きできない場合のエラー"""


def _version_type(old: str, new: str) -> str | None:
    """版の変化の種類（major / minor / patch）。数字で読めなければ None"""

    def parts(v: str) -> list[int] | None:
        m = re.match(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", v)
        if m is None:
            return None
        return [int(g or 0) for g in m.groups()]

    a, b = parts(old), parts(new)
    if a is None or b is None:
        return None
    if a[0] != b[0]:
        return "major"
    if a[1] != b[1]:
        return "minor"
    return "patch"


def parse_update_metadata(message: str, body: str = "") -> list[tuple[str, str | None]] | None:
    """commit の message から、依存ごとの (dependency-name, update-type) を読む

    ``update-type`` は ``major`` / ``minor`` / ``patch`` のどれか。
    YAML に無いときは、``body``（PR 本文）の ``Updates `x` from a to b`` の版から計算する。
    版も無いときは None にする。

    Returns:
        依存の並び。YAML の欠け・読めない YAML・依存の無い YAML では None。
    """
    m = _YAML_RE.search(message.replace("\r\n", "\n"))
    if m is None:
        return None
    try:
        data = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    deps = _list(_dict(data).get("updated-dependencies"))
    computed = {name: _version_type(a, b) for name, a, b in _UPDATES_RE.findall(body)}
    result: list[tuple[str, str | None]] = []
    for item in deps:
        dep = _dict(item)
        name = dep.get("dependency-name")
        if not isinstance(name, str):
            continue
        raw = dep.get("update-type")
        update_type: str | None = None
        if isinstance(raw, str) and raw.rpartition("semver-")[2] in _UPDATE_TYPES:
            update_type = raw.rpartition("semver-")[2]
        if update_type is None:
            update_type = computed.get(name)
        result.append((name, update_type))
    return result or None


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _dict(value: Any) -> dict[str, Any]:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return cast("list[Any]", value) if isinstance(value, list) else []


def first_node(value: Any) -> dict[str, Any]:
    nodes = _list(_dict(value).get("nodes"))
    return _dict(nodes[0]) if nodes else {}


def _metadata_reasons(pr: Mapping[str, Any]) -> tuple[list[str], bool]:
    """(update-type と依存名から決まる理由, 自動マージの対象か)"""
    commit = _dict(first_node(pr.get("firstCommits")).get("commit"))
    author_login = _dict(_dict(commit.get("author")).get("user")).get("login")
    metadata = None
    if author_login == _BOT_LOGIN:
        metadata = parse_update_metadata(
            str(commit.get("message") or ""), str(pr.get("body") or "")
        )
    if metadata is None:
        return [REASON_UNKNOWN], False
    reasons: list[str] = []
    types = [t for _, t in metadata if t is not None]
    if not types:
        reasons.append(REASON_UNKNOWN)
    elif max(types, key=_UPDATE_TYPES.index) == "major":
        reasons.append(REASON_MAJOR)
    if any("playwright" in name.lower() for name, _ in metadata):
        reasons.append(REASON_PLAYWRIGHT)
    return reasons, not reasons


def waiting_reasons(pr: Mapping[str, Any], now: datetime) -> list[str]:
    """PR が人の判断を待っている理由の並び。空なら載せない

    Args:
        pr: ``list_open_dependabot_pull_requests`` が返す PR のノード。
        now: 判定の時刻（タイムゾーン付き）。
    """
    reasons, auto_merge_target = _metadata_reasons(pr)
    if not auto_merge_target:
        return reasons

    created = _parse_time(pr.get("createdAt"))
    events = [_dict(n) for n in _list(_dict(pr.get("timelineItems")).get("nodes"))]

    def event_times(kind: str) -> list[datetime]:
        times = (_parse_time(e.get("createdAt")) for e in events if e.get("__typename") == kind)
        return [t for t in times if t is not None]

    pushes = event_times("HeadRefForcePushedEvent")
    last_push = max([t for t in [created, *pushes] if t is not None], default=None)
    if last_push is None:
        return reasons
    rollup = _dict(first_node(pr.get("headCommits")).get("commit")).get("statusCheckRollup")
    state = _dict(rollup).get("state")
    has_auto_merge = pr.get("autoMergeRequest") is not None
    in_queue = bool(pr.get("isInMergeQueue"))

    if state in ("FAILURE", "ERROR"):
        reasons.append(REASON_FAILED)
    elif has_auto_merge and state != "SUCCESS" and now - last_push > CHECKS_TIMEOUT:
        reasons.append(REASON_STUCK)
    if pr.get("mergeable") == "CONFLICTING":
        base = _parse_time(
            _dict(_dict(_dict(pr.get("baseRef")).get("target"))).get("committedDate")
        )
        since = max([t for t in (last_push, base) if t is not None])
        if now - since > GRACE:
            reasons.append(REASON_CONFLICT)
    if not has_auto_merge and not in_queue:
        if any(t > last_push for t in event_times("RemovedFromMergeQueueEvent")):
            reasons.append(REASON_DEQUEUED)
        elif now - last_push > GRACE:
            reasons.append(REASON_NO_AUTO_MERGE)
    return reasons


# --- Tracker の一覧 ---------------------------------------------------------------


@dataclass(frozen=True)
class TrackerEntry:
    """Tracker の表の 1 行（人の判断を待つ PR）

    Attributes:
        number: PR 番号。
        title: PR の題。
        url: PR の URL。
        reasons: 待っている理由。
    """

    number: int
    title: str
    url: str
    reasons: tuple[str, ...]


@dataclass
class TrackerPlan:
    """PR と Tracker の一覧の突き合わせの結果

    Attributes:
        create: 新しい Tracker を立てるか（open の Tracker が無く、載せる行があるとき）。
        close: Tracker を閉じるか（open の Tracker があり、載せる行が無いとき）。
        entries: 書き直した後の行（番号順）。
        added: 一覧に足した行。
        removed: 一覧から外した PR 番号。
    """

    create: bool = False
    close: bool = False
    entries: list[TrackerEntry] = field(default_factory=list[TrackerEntry])
    added: list[TrackerEntry] = field(default_factory=list[TrackerEntry])
    removed: list[int] = field(default_factory=list[int])


def _normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _cell(text: str) -> str:
    """表のセルに入る文。``|`` と改行と ``<`` を無害にする"""
    one_line = re.sub(r"\s*[\r\n]+\s*", " ", text).strip()
    return one_line.replace("<", "&lt;").replace("|", "\\|")


def _row(e: TrackerEntry) -> str:
    marker = f"<!-- pecot-dependabot-pr: pr/{e.number} -->"
    return f"| {marker} [#{e.number}]({e.url}) {_cell(e.title)} | {_cell('・'.join(e.reasons))} |"


def _list_region(body: str) -> tuple[int, int]:
    return list_region(body, _LIST_BEGIN_RE, _LIST_END_RE, DependabotPrError)


def parse_tracker_entries(body: str | None) -> list[int]:
    """Tracker の本文から、一覧に載っている PR 番号を読む（番号順）

    Raises:
        DependabotPrError: list-begin / list-end の印が 1 組ではない場合
    """
    text = _normalize_newlines(body or "")
    begin, end = _list_region(text)
    numbers = {
        int(m.group(1))
        for line in text[begin:end].split("\n")
        if line.lstrip().startswith("|")
        for m in [_ROW_MARKER_RE.search(line)]
        if m is not None
    }
    return sorted(numbers)


def render_tracker_body(entries: Sequence[TrackerEntry], existing_body: str | None = None) -> str:
    """Tracker の本文を作る

    ``existing_body`` があれば、list-begin から list-end の間だけを書き直し、外の文は残す。
    無ければ、Tracker の印と一覧だけの本文を作る。

    Raises:
        DependabotPrError: ``existing_body`` の印が 1 組ではない場合
    """
    table = "\n".join(["| PR | 待っている理由 |", "|---|---|", *(_row(e) for e in entries)])
    if existing_body is None:
        head = TRACKER_MARKER + "\n\n" + LIST_BEGIN + "\n"
        tail = "\n" + LIST_END + "\n"
    else:
        text = _normalize_newlines(existing_body)
        begin, end = _list_region(text)
        head = text[:begin] + "\n"
        tail = "\n" + text[end:]
    return head + table + tail


def build_tracker_title(today: date) -> str:
    """Tracker の題。日付は立てた日（UTC）"""
    return f"[Tracker] dependabot PR — {today.isoformat()}"


def plan_tracker(entries: Sequence[TrackerEntry], old_numbers: list[int] | None) -> TrackerPlan:
    """待つ PR と Tracker の今の行から、書き直した行を出す（純粋関数）

    ``old_numbers`` が None のときは open の Tracker が無い。載せる行があるときだけ立てる。
    open の Tracker があり、載せる行が無いときは閉じる。
    """
    rows = sorted(entries, key=lambda e: e.number)
    old = set(old_numbers or [])
    new = {e.number for e in rows}
    return TrackerPlan(
        create=old_numbers is None and bool(rows),
        close=old_numbers is not None and not rows,
        entries=rows,
        added=[e for e in rows if e.number not in old],
        removed=sorted(old - new),
    )
