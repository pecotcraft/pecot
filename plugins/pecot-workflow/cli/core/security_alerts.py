"""core/security_alerts.py - security alert を Issue に載せるための純粋な処理

``pecot security sync`` と ``release preflight`` が共有する。
ここに置く処理: alert の形をそろえる、Priority を決める。
Tracker の本文（alert の一覧の表）を読み書きする処理と、行の足し外しを決める純粋関数も置く。
code scanning と secret scanning の有効 / 無効の判定もここに置く。

リポとボードは公開なので、題と本文に code scanning の rule・パス・行や、
secret の種類・場所・値を出さない。出すのは種類・番号・Priority・URL に限る。
Dependabot は公開の advisory なので、パッケージ名と GHSA の ID も出す。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any, Literal, cast
from urllib.parse import quote, unquote

import httpx
from pydantic import BaseModel

from cli.core.dependabot import DependabotException
from cli.core.errors import PecotError
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.github.errors import GitHubRateLimitError, describe_api_error
from cli.core.tracker_body import find_tracker as _find_tracker
from cli.core.tracker_body import list_region

AlertKind = Literal["dependabot", "code-scanning", "secret-scanning"]
ALERT_KINDS: tuple[AlertKind, ...] = ("dependabot", "code-scanning", "secret-scanning")
KIND_LABELS: dict[AlertKind, str] = {
    "dependabot": "Dependabot",
    "code-scanning": "code scanning",
    "secret-scanning": "secret scanning",
}

ALERT_LABEL = "security-alert"
TRACKER_MARKER = "<!-- pecot-alert: tracker -->"
LIST_BEGIN = "<!-- pecot-alert: list-begin -->"
LIST_END = "<!-- pecot-alert: list-end -->"
_SEVERITY_PRIORITY = {"critical": "high", "high": "high", "medium": "medium", "low": "low"}
_RULE_SEVERITY_PRIORITY = {"error": "high", "warning": "medium", "note": "low"}


class SecurityAlertError(PecotError):
    """security alert の状態を判定できない場合のエラー"""


@dataclass(frozen=True)
class Alert:
    """open の alert 1 件の要点（Issue に出してよい情報だけ）

    Attributes:
        kind: alert の種類。
        number: alert 番号。
        priority: ``high`` / ``medium`` / ``low``。
        url: Security タブの alert の URL。
        package: Dependabot のパッケージ名（ほかの種類は None）。
        ghsa: Dependabot の GHSA ID（ほかの種類は None）。
        summary: Dependabot の advisory の題（公開の情報。ほかの種類は None）。
    """

    kind: AlertKind
    number: int
    priority: str
    url: str
    package: str | None = None
    ghsa: str | None = None
    summary: str | None = None


def _dict(value: Any) -> dict[str, Any]:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else {}


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _url(raw: dict[str, Any], host: str, owner: str, repo: str, kind: AlertKind) -> str:
    url = _str(raw.get("html_url"))
    return url or f"https://{host}/{owner}/{repo}/security/{kind}/{raw.get('number')}"


def normalize_dependabot(raw: dict[str, Any], host: str, owner: str, repo: str) -> Alert | None:
    """Dependabot の alert を共通の形にする。番号が無ければ None

    Priority は ``security_vulnerability.severity`` で決める（critical・high は high）。
    無ければ ``security_advisory.severity`` を使う。どちらも無ければ medium。
    """
    number = raw.get("number")
    if not isinstance(number, int):
        return None
    advisory = _dict(raw.get("security_advisory"))
    severity = _str(_dict(raw.get("security_vulnerability")).get("severity")) or _str(
        advisory.get("severity")
    )
    ghsa = _str(advisory.get("ghsa_id"))
    return Alert(
        kind="dependabot",
        number=number,
        priority=_SEVERITY_PRIORITY.get(severity or "", "medium"),
        url=_url(raw, host, owner, repo, "dependabot"),
        package=_str(_dict(_dict(raw.get("dependency")).get("package")).get("name")),
        ghsa=ghsa if ghsa and _GHSA_RE.match(ghsa) else None,
        summary=_str(advisory.get("summary")),
    )


def normalize_code_scanning(raw: dict[str, Any], host: str, owner: str, repo: str) -> Alert | None:
    """code scanning の alert を共通の形にする。番号が無ければ None

    Priority は ``rule.security_severity_level`` を先に使う。
    無ければ ``rule.severity`` で決める（error は high、warning は medium、note は low）。
    どちらも無ければ medium。
    """
    number = raw.get("number")
    if not isinstance(number, int):
        return None
    rule = _dict(raw.get("rule"))
    level = _str(rule.get("security_severity_level"))
    priority = _SEVERITY_PRIORITY.get(level or "") or _RULE_SEVERITY_PRIORITY.get(
        _str(rule.get("severity")) or "", "medium"
    )
    return Alert(
        kind="code-scanning",
        number=number,
        priority=priority,
        url=_url(raw, host, owner, repo, "code-scanning"),
    )


def normalize_secret_scanning(
    raw: dict[str, Any], host: str, owner: str, repo: str
) -> Alert | None:
    """secret scanning の alert を共通の形にする。番号が無ければ None（Priority は high）"""
    number = raw.get("number")
    if not isinstance(number, int):
        return None
    return Alert(
        kind="secret-scanning",
        number=number,
        priority="high",
        url=_url(raw, host, owner, repo, "secret-scanning"),
    )


# --- Tracker の一覧 ---------------------------------------------------------------

_PRIORITY_RANK = {"low": 0, "medium": 1, "high": 2}
_GHSA_RE = re.compile(r"^GHSA(-[a-z0-9]{4}){3}$")
_MARKER_RE = re.compile(
    r"<!--\s*pecot-alert:\s*(dependabot|code-scanning|secret-scanning)/(\d+)"
    r"((?:\s+[a-z]+=\S+)*)\s*-->"
)
# 行の 1 列目の先頭に並ぶ印（1 行に複数あってよい）
_ROW_MARKERS_RE = re.compile(r"^\|\s*((?:<!--[^>]*?-->\s*)+)")
_LIST_BEGIN_RE = re.compile(r"<!--\s*pecot-alert:\s*list-begin\s*-->")
_LIST_END_RE = re.compile(r"<!--\s*pecot-alert:\s*list-end\s*-->")
_TRACKER_RE = re.compile(r"<!--\s*pecot-alert:\s*tracker\s*-->")


@dataclass(frozen=True)
class TrackerEntry:
    """Tracker の表の 1 行（判断の要る alert。open で例外に無い alert）

    Attributes:
        kind: alert の種類。
        number: alert 番号。
        priority: ``high`` / ``medium`` / ``low``。
        package: Dependabot のパッケージ名。
        ghsa: Dependabot の GHSA ID。
        summary: Dependabot の advisory の題。
    """

    kind: AlertKind
    number: int
    priority: str = "medium"
    package: str | None = None
    ghsa: str | None = None
    summary: str | None = None

    @property
    def key(self) -> tuple[AlertKind, int]:
        return (self.kind, self.number)


def _normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _entry_marker(e: TrackerEntry) -> str:
    parts = [f"{e.kind}/{e.number}", f"priority={e.priority}"]
    if e.package:
        # ``--`` を含めないため、``-`` も符号化する
        parts.append("pkg=" + quote(e.package, safe="").replace("-", "%2D"))
    if e.ghsa and _GHSA_RE.match(e.ghsa):
        parts.append(f"ghsa={e.ghsa}")
    if e.summary:
        parts.append("sum=" + quote(e.summary, safe="").replace("-", "%2D"))
    return f"<!-- pecot-alert: {' '.join(parts)} -->"


def _cell(text: str) -> str:
    """表のセルに入る文。``|`` と改行と ``<`` を無害にする"""
    one_line = re.sub(r"\s*[\r\n]+\s*", " ", text).strip()
    return one_line.replace("<", "&lt;").replace("|", "\\|")


def _title_text(text: str) -> str:
    """title の文。リンクの題に入れても表を壊さないよう ``\\`` ``[`` ``]`` ``|`` ``<`` を無害にする"""
    raw = text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")
    return _cell(raw)


def _alert_link(e: TrackerEntry, host: str, owner: str, repo: str) -> str:
    return f"[#{e.number}](https://{host}/{owner}/{repo}/security/{e.kind}/{e.number})"


def _entry_row(e: TrackerEntry, host: str, owner: str, repo: str) -> str:
    """code scanning・secret scanning の行（title・alert・Priority）。title は固定の ``masked``"""
    return f"| {_entry_marker(e)} masked | {_alert_link(e, host, owner, repo)} | {e.priority} |"


def _advisory_groups(entries: list[TrackerEntry]) -> list[list[TrackerEntry]]:
    """Dependabot の行を GHSA ごとに束ねる。GHSA の無い alert は束ねず 1 件ずつにする

    並びは Priority の高い順、同じなら先頭の alert 番号の小さい順。
    """
    by_ghsa: dict[str, list[TrackerEntry]] = {}
    groups: list[list[TrackerEntry]] = []
    for e in sorted(entries, key=lambda x: x.number):
        if e.ghsa:
            if e.ghsa not in by_ghsa:
                by_ghsa[e.ghsa] = []
                groups.append(by_ghsa[e.ghsa])
            by_ghsa[e.ghsa].append(e)
        else:
            groups.append([e])
    return sorted(
        groups,
        key=lambda g: (-max(_PRIORITY_RANK.get(e.priority, 1) for e in g), g[0].number),
    )


def _advisory_row(group: list[TrackerEntry], host: str, owner: str, repo: str) -> str:
    """Dependabot の advisory 1 件の行（内容・alert・Priority）"""
    first = group[0]
    text = next((e.summary for e in group if e.summary), None) or first.ghsa
    text = text or next((e.package for e in group if e.package), None) or "不明"
    label = _title_text(text)
    content = f"[{label}](https://{host}/advisories/{first.ghsa})" if first.ghsa else label
    # summary は束の先頭の alert の印にだけ付ける。読み戻しで束の残りに引き継ぐ
    summary = next((e.summary for e in group if e.summary), None)
    markers = " ".join(
        _entry_marker(replace(e, summary=summary if i == 0 else None)) for i, e in enumerate(group)
    )
    links = " ".join(_alert_link(e, host, owner, repo) for e in group)
    priority = max_priority(group) or "medium"
    return f"| {markers} {content} | {links} | {priority} |"


def _list_region(body: str) -> tuple[int, int]:
    """本文の一覧の範囲（begin の印の直後, end の印の先頭）。印の組が 1 組でなければエラー

    Raises:
        SecurityAlertError: 印の欠け・重なり・順序の逆転があるとき
    """
    return list_region(body, _LIST_BEGIN_RE, _LIST_END_RE, SecurityAlertError)


def parse_tracker_entries(body: str | None) -> list[TrackerEntry]:
    """Tracker の本文から、一覧の行を読む

    1 行に印が複数あってよい（Dependabot は advisory ごとに alert の印を並べる）。
    ``sum=`` は束の先頭の alert の印にだけあるので、同じ GHSA の残りの alert に引き継ぐ。
    旧い書式の本文を書き直せるように、互換として ``state=`` も読む。
    ``state=`` の無い行と ``state=open`` の行だけを読み、それ以外の state の行、
    旧い ``folded count=`` の行、印の無い行、読めない行は読み捨てる。

    Raises:
        SecurityAlertError: list-begin / list-end の印が 1 組ではない場合
    """
    text = _normalize_newlines(body or "")
    begin, end = _list_region(text)
    entries: dict[tuple[AlertKind, int], TrackerEntry] = {}
    for line in text[begin:end].split("\n"):
        row = _ROW_MARKERS_RE.match(line.strip())
        if row is None:
            continue
        for m in _MARKER_RE.finditer(row.group(1)):
            attrs = dict(re.findall(r"([a-z]+)=(\S+)", m.group(3)))
            if attrs.get("state", "open") != "open":
                continue
            priority = attrs.get("priority", "medium")
            ghsa = attrs.get("ghsa")
            entry = TrackerEntry(
                kind=cast("AlertKind", m.group(1)),
                number=int(m.group(2)),
                priority=priority if priority in _PRIORITY_RANK else "medium",
                package=unquote(attrs["pkg"]) if "pkg" in attrs else None,
                ghsa=ghsa if ghsa and _GHSA_RE.match(ghsa) else None,
                summary=unquote(attrs["sum"]) if "sum" in attrs else None,
            )
            entries.setdefault(entry.key, entry)
    summaries = {e.ghsa: e.summary for e in entries.values() if e.ghsa and e.summary}
    for key, e in entries.items():
        if e.ghsa and not e.summary and e.ghsa in summaries:
            entries[key] = replace(e, summary=summaries[e.ghsa])
    return sorted_entries(list(entries.values()))


def sorted_entries(entries: list[TrackerEntry]) -> list[TrackerEntry]:
    """行の並びを、種類の順・番号の順に固定する"""
    return sorted(entries, key=lambda e: (ALERT_KINDS.index(e.kind), e.number))


def _by_priority(entries: list[TrackerEntry]) -> list[TrackerEntry]:
    """Priority の高い順、同じなら番号順"""
    return sorted(entries, key=lambda e: (-_PRIORITY_RANK.get(e.priority, 1), e.number))


def _section(
    kind: AlertKind,
    entries: list[TrackerEntry],
    status: Literal["ok", "disabled", "failed"],
    host: str,
    owner: str,
    repo: str,
) -> str:
    """種類ごとの見出しと表

    行が無いとき、本文には次の語を置く。無効の種類は ``disabled``、
    一覧を取れず前の行も無い種類は ``unavailable``、0 件の種類は ``none``。
    """
    head = f"## {KIND_LABELS[kind]}\n\n"
    if status == "disabled":
        return head + "disabled"
    rows = [e for e in entries if e.kind == kind]
    if not rows:
        return head + ("unavailable" if status == "failed" else "none")
    if kind == "dependabot":
        body_rows = [_advisory_row(g, host, owner, repo) for g in _advisory_groups(rows)]
    else:
        body_rows = [_entry_row(e, host, owner, repo) for e in _by_priority(rows)]
    lines = ["| title | alert | Priority |", "|---|---|---|", *body_rows]
    return head + "\n".join(lines)


def _sections(
    entries: list[TrackerEntry],
    disabled_kinds: set[AlertKind] | frozenset[AlertKind],
    failed_kinds: set[AlertKind] | frozenset[AlertKind],
    host: str,
    owner: str,
    repo: str,
) -> str:
    def status(kind: AlertKind) -> Literal["ok", "disabled", "failed"]:
        if kind in disabled_kinds:
            return "disabled"
        return "failed" if kind in failed_kinds else "ok"

    return "\n\n".join(
        _section(kind, entries, status(kind), host, owner, repo) for kind in ALERT_KINDS
    )


def render_tracker_body(
    entries: list[TrackerEntry],
    host: str,
    owner: str,
    repo: str,
    existing_body: str | None = None,
    disabled_kinds: set[AlertKind] | frozenset[AlertKind] = frozenset(),
    failed_kinds: set[AlertKind] | frozenset[AlertKind] = frozenset(),
) -> str:
    """Tracker の本文を作る

    一覧は種類ごとの見出しと表にする。無効の種類（``disabled_kinds``）は見出しの下に ``disabled`` だけを置く。
    一覧を取れなかった種類（``failed_kinds``）に行が無ければ、見出しの下に ``unavailable`` を置く。

    ``existing_body`` があれば、list-begin から list-end の間だけを書き直し、外の文は残す。
    無ければ、Tracker の印と一覧だけの本文を作る。

    Raises:
        SecurityAlertError: ``existing_body`` の印が 1 組ではない場合
    """
    if existing_body is None:
        head = TRACKER_MARKER + "\n\n" + LIST_BEGIN + "\n"
        tail = "\n" + LIST_END + "\n"
    else:
        text = _normalize_newlines(existing_body)
        begin, end = _list_region(text)
        head = text[:begin] + "\n"
        tail = "\n" + text[end:]
    return head + _sections(entries, disabled_kinds, failed_kinds, host, owner, repo) + tail


def build_tracker_title(today: date) -> str:
    """Tracker の題。日付は立てた日（UTC）"""
    return f"[Tracker] security alert — {today.isoformat()}"


def find_tracker(issues: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, list[int]]:
    """ラベルで引いた Issue から、open の Tracker を探す（``tracker_body.find_tracker`` に委ねる）"""
    return _find_tracker(issues, _TRACKER_RE)


def max_priority(entries: list[TrackerEntry]) -> str | None:
    """全行の Priority の最大。行が無ければ None"""
    values = [e.priority for e in entries]
    return max(values, key=lambda p: _PRIORITY_RANK.get(p, 1), default=None)


@dataclass
class TrackerPlan:
    """alert と Tracker の一覧の突き合わせの結果

    Attributes:
        create: 新しい Tracker を立てるか（open の Tracker が無く、表に載せる行があるとき）。
        entries: 書き直した後の行（並びは固定）。
        added: 一覧に足した行。
        removed: 一覧から外した行。
    """

    create: bool = False
    entries: list[TrackerEntry] = field(default_factory=list[TrackerEntry])
    added: list[TrackerEntry] = field(default_factory=list[TrackerEntry])
    removed: list[TrackerEntry] = field(default_factory=list[TrackerEntry])


def plan_tracker(
    open_alerts: Mapping[AlertKind, list[Alert]],
    exceptions: list[DependabotException] | None,
    entries: list[TrackerEntry] | None,
    failed_kinds: set[AlertKind] | frozenset[AlertKind] = frozenset(),
    disabled_kinds: set[AlertKind] | frozenset[AlertKind] = frozenset(),
) -> TrackerPlan:
    """open の alert と Tracker の今の行から、書き直した行を出す（純粋関数）

    ``entries`` が None のときは open の Tracker が無い。表に載せる行があるときだけ立てる。
    取れた種類の行は、open の alert から例外（Dependabot）を引いたものにする。
    一覧を取れなかった種類（``failed_kinds``）は、その種類の前の行をそのまま使い、足さない。
    無効の種類（``disabled_kinds``）は行を持たない（本文には ``disabled`` だけが出る）。
    """
    skipped = set(failed_kinds) | set(disabled_kinds)
    excepted = {e.alert for e in exceptions or []}
    old_by_key = {e.key: e for e in entries or []}
    rows: dict[tuple[AlertKind, int], TrackerEntry] = {
        old.key: old for old in entries or [] if old.kind in failed_kinds
    }
    for kind in ALERT_KINDS:
        if kind in skipped:
            continue
        for alert in open_alerts.get(kind, []):
            if kind == "dependabot" and alert.number in excepted:
                continue
            old = old_by_key.get((kind, alert.number))
            rows[(kind, alert.number)] = TrackerEntry(
                kind=kind,
                number=alert.number,
                priority=alert.priority,
                package=alert.package or (old.package if old else None),
                ghsa=alert.ghsa or (old.ghsa if old else None),
                summary=alert.summary or (old.summary if old else None),
            )
    plan = TrackerPlan(entries=sorted_entries(list(rows.values())))
    plan.added = sorted_entries([e for k, e in rows.items() if k not in old_by_key])
    plan.removed = sorted_entries([e for k, e in old_by_key.items() if k not in rows])
    plan.create = entries is None and bool(plan.entries)
    return plan


def _error_message(response_body: str | None) -> str:
    try:
        body = json.loads(response_body or "")
    except ValueError:
        return ""
    message = _dict(body).get("message")
    return message.lower() if isinstance(message, str) else ""


def is_code_scanning_disabled(e: GitHubAPIError) -> bool:
    """code scanning の一覧の失敗が「GHAS 無し・未有効」か。権限不足は含めない

    403 の本文が Advanced Security / code scanning の未有効を示すときだけ無効とみなす。
    """
    if e.status_code != 403 or isinstance(e, GitHubRateLimitError):
        return False
    message = _error_message(e.response_body)
    return "advanced security" in message or "not enabled" in message


def is_no_analysis(e: GitHubAPIError) -> bool:
    """解析がまだ無いリポの 404（有効だが alert は 0 件）か"""
    return e.status_code == 404 and "no analysis found" in _error_message(e.response_body)


def _list_dependabot(client: GitHubClient, owner: str, repo: str) -> list[dict[str, Any]] | None:
    try:
        return client.list_open_dependabot_alerts(owner, repo)
    except GitHubAPIError as e:
        if e.status_code != 403 or isinstance(e, GitHubRateLimitError):
            raise
        # 403 は無効と権限不足の両方で起きる。有効なら権限不足としてエラーにする
        if client.is_dependabot_alerts_enabled(owner, repo):
            raise SecurityAlertError(
                f"{owner}/{repo}: Dependabot alerts は有効ですが一覧を取得できません（権限不足の可能性）"
            ) from e
        return None


def _list_code_scanning(client: GitHubClient, owner: str, repo: str) -> list[dict[str, Any]] | None:
    try:
        return client.list_open_code_scanning_alerts(owner, repo)
    except GitHubAPIError as e:
        if is_code_scanning_disabled(e):
            return None
        if is_no_analysis(e):
            return []
        raise


def _list_secret_scanning(
    client: GitHubClient, owner: str, repo: str
) -> list[dict[str, Any]] | None:
    try:
        return client.list_open_secret_scanning_alerts(owner, repo)
    except GitHubAPIError as e:
        if e.status_code != 404:
            raise
        # 404 は「無効」だけでなく、権限不足（admin でない）でも起きる。
        # 無効と確認できたときだけ無効とし、状態が読めない・有効なのに 404 はエラーにする
        if client.get_secret_scanning_status(owner, repo) == "disabled":
            return None
        raise SecurityAlertError(
            f"{owner}/{repo}: secret scanning の一覧を取得できません"
            "（権限不足の可能性。無効とは確認できません）"
        ) from e


_LISTERS: dict[AlertKind, Callable[[GitHubClient, str, str], list[dict[str, Any]] | None]] = {
    "dependabot": _list_dependabot,
    "code-scanning": _list_code_scanning,
    "secret-scanning": _list_secret_scanning,
}

_NORMALIZERS: dict[AlertKind, Callable[[dict[str, Any], str, str, str], Alert | None]] = {
    "dependabot": normalize_dependabot,
    "code-scanning": normalize_code_scanning,
    "secret-scanning": normalize_secret_scanning,
}


def list_open_alerts(
    client: GitHubClient, kind: AlertKind, owner: str, repo: str
) -> list[dict[str, Any]] | None:
    """種類ごとの open の alert を取る。機能が無効のリポは None

    - Dependabot: 403 のとき、alerts が無効なら None、有効なら権限不足としてエラー
    - code scanning: GHAS 無しの 403 は None、解析が無い 404 は空
    - secret scanning: 404 のとき、リポの状態が ``disabled`` と読めたときだけ None。
      読めない・``enabled`` なのは権限不足などとしてエラー

    Raises:
        SecurityAlertError: 一覧を取得できず、無効とも言えない場合（API エラー・通信エラー）
    """
    try:
        return _LISTERS[kind](client, owner, repo)
    except SecurityAlertError:
        raise
    except GitHubAPIError as e:
        raise SecurityAlertError(
            f"{owner}/{repo}: {KIND_LABELS[kind]}: {describe_api_error(e)}"
        ) from e
    except httpx.HTTPError as e:
        raise SecurityAlertError(f"{owner}/{repo}: 通信に失敗しました: {e}") from e


def normalize_alerts(
    kind: AlertKind, raws: list[dict[str, Any]], host: str, owner: str, repo: str
) -> list[Alert]:
    """API の alert の並びを共通の形にする（番号の無いものは除く）"""
    normalize = _NORMALIZERS[kind]
    return [a for a in (normalize(raw, host, owner, repo) for raw in raws) if a is not None]


# --- preflight 用の有効 / 無効の判定 ---------------------------------------------


class ScanAlertStatus(BaseModel):
    """code scanning / secret scanning の状態

    Attributes:
        enabled: 機能が有効か。
        open_count: open の alert 件数（無効なら 0）。
        alerts_url: alert 一覧の Web URL。
        open_numbers: open の alert 番号（件数だけを返す箇所では空）。
    """

    enabled: bool
    open_count: int
    alerts_url: str
    open_numbers: list[int] = []


def _scan_status(
    client: GitHubClient, kind: AlertKind, host: str, owner: str, repo: str
) -> ScanAlertStatus:
    url = f"https://{host}/{owner}/{repo}/security/{kind}"
    raws = list_open_alerts(client, kind, owner, repo)
    if raws is None:
        return ScanAlertStatus(enabled=False, open_count=0, alerts_url=url)
    numbers = sorted(n for n in (a.get("number") for a in raws) if isinstance(n, int))
    return ScanAlertStatus(enabled=True, open_count=len(raws), alerts_url=url, open_numbers=numbers)


def fetch_code_scanning_status(
    client: GitHubClient, host: str, owner: str, repo: str
) -> ScanAlertStatus:
    """code scanning の open の alert 数を取る（既定ブランチが対象）

    Raises:
        SecurityAlertError: 状態を判定できない場合
    """
    return _scan_status(client, "code-scanning", host, owner, repo)


def fetch_secret_scanning_status(
    client: GitHubClient, host: str, owner: str, repo: str
) -> ScanAlertStatus:
    """secret scanning の open の alert 数を取る（値は取得しない）

    Raises:
        SecurityAlertError: 状態を判定できない場合（権限不足などで無効と確認できない場合を含む）
    """
    return _scan_status(client, "secret-scanning", host, owner, repo)
