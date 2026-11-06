"""core/security_alerts.py - security alert を Issue に載せるための純粋な処理

``pecot security sync`` と ``release preflight`` が共有する。
ここに置く処理: alert の形をそろえる、Priority を決める。
Tracker の本文（alert の一覧の表）を読み書きする処理と、行の状態を決める純粋関数も置く。
code scanning と secret scanning の有効 / 無効の判定もここに置く。

リポとボードは公開なので、題と本文に code scanning の rule・パス・行や、
secret の種類・場所・値を出さない。出すのは種類・番号・Priority・URL・手順へのリンクに限る。
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
# GitHub の本文の上限は 65,536 文字。近づいたら古い結果の行を 1 行にまとめる
BODY_LIMIT = 65_536
BODY_SOFT_LIMIT = 60_000
# 手順の節（SECURITY.md の見出しのアンカー）
SECURITY_ANCHORS: dict[str, str] = {
    "dependabot": "alert-dependabot",
    "code-scanning": "alert-code-scanning",
    "secret-scanning": "alert-secret-scanning",
    "exceptions-review": "alert-exceptions-review",
}

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
    """

    kind: AlertKind
    number: int
    priority: str
    url: str
    package: str | None = None
    ghsa: str | None = None


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
    return Alert(
        kind="dependabot",
        number=number,
        priority=_SEVERITY_PRIORITY.get(severity or "", "medium"),
        url=_url(raw, host, owner, repo, "dependabot"),
        package=_str(_dict(_dict(raw.get("dependency")).get("package")).get("name")),
        ghsa=_str(advisory.get("ghsa_id")),
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


def guide_url(host: str, owner: str, repo: str, section: str) -> str:
    """SECURITY.md の手順の節へのリンク"""
    return f"https://{host}/{owner}/{repo}/blob/main/SECURITY.md#{SECURITY_ANCHORS[section]}"


# --- Tracker の一覧 ---------------------------------------------------------------

EntryState = Literal["open", "exception", "fixed", "dismissed", "resolved", "gone"]
_RESULT_STATES: frozenset[str] = frozenset({"fixed", "dismissed", "resolved", "gone"})
_ENTRY_STATES: frozenset[str] = frozenset({"open", "exception", *_RESULT_STATES})
_PRIORITY_RANK = {"low": 0, "medium": 1, "high": 2}
_STATE_LABELS: dict[str, str] = {
    "open": "要判断",
    "exception": "例外",
    "fixed": "結果: fixed",
    "dismissed": "結果: dismissed",
    "resolved": "結果: resolved",
    "gone": "結果: alert なし",
}
_GHSA_RE = re.compile(r"^GHSA(-[a-z0-9]{4}){3}$")
_ROW_RE = re.compile(
    r"^\|\s*<!--\s*pecot-alert:\s*(dependabot|code-scanning|secret-scanning)/(\d+)"
    r"((?:\s+[a-z]+=\S+)*)\s*-->"
)
_FOLDED_RE = re.compile(r"^\|\s*<!--\s*pecot-alert:\s*folded\s+count=(\d+)\s*-->")
_LIST_BEGIN_RE = re.compile(r"<!--\s*pecot-alert:\s*list-begin\s*-->")
_LIST_END_RE = re.compile(r"<!--\s*pecot-alert:\s*list-end\s*-->")
_TRACKER_RE = re.compile(r"<!--\s*pecot-alert:\s*tracker\s*-->")


@dataclass(frozen=True)
class TrackerEntry:
    """Tracker の表の 1 行

    状態は行頭のセルの印に列挙値だけで持つ。見える文字は印から作る一方向で、読み戻さない。

    Attributes:
        kind: alert の種類。
        number: alert 番号。
        state: ``open``（要判断）・``exception``（例外）・結果（fixed・dismissed・resolved・gone）。
        priority: ``high`` / ``medium`` / ``low``。
        reason: dismissed・resolved の理由（列挙値）。
        package: Dependabot のパッケージ名。
        ghsa: Dependabot の GHSA ID。
        reevaluate: 例外の見直し条件。印には入れず、sync が例外ファイルから毎回入れる。
    """

    kind: AlertKind
    number: int
    state: EntryState
    priority: str = "medium"
    reason: str | None = None
    package: str | None = None
    ghsa: str | None = None
    reevaluate: str | None = None

    @property
    def key(self) -> tuple[AlertKind, int]:
        return (self.kind, self.number)

    @property
    def is_result(self) -> bool:
        return self.state in _RESULT_STATES


def _normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _enum_value(value: str) -> str:
    """列挙値の形にそろえる（小文字の英数字と ``_`` だけ。印に入れる値用）"""
    return re.sub(r"[^a-z0-9_]+", "_", value.lower()).strip("_")


def _entry_marker(e: TrackerEntry) -> str:
    parts = [f"{e.kind}/{e.number}", f"state={e.state}", f"priority={e.priority}"]
    if e.reason:
        parts.append(f"reason={e.reason}")
    if e.package:
        # ``--`` を含めないため、``-`` も符号化する
        parts.append("pkg=" + quote(e.package, safe="").replace("-", "%2D"))
    if e.ghsa and _GHSA_RE.match(e.ghsa):
        parts.append(f"ghsa={e.ghsa}")
    return f"<!-- pecot-alert: {' '.join(parts)} -->"


def _cell(text: str) -> str:
    """表のセルに入る文。``|`` と改行と ``<`` を無害にする"""
    one_line = re.sub(r"\s*[\r\n]+\s*", " ", text).strip()
    return one_line.replace("<", "&lt;").replace("|", "\\|")


def state_label(e: TrackerEntry) -> str:
    """行の状態の短い表示（dry-run の出力用）"""
    label = _STATE_LABELS[e.state]
    return f"{label}（理由: {e.reason}）" if e.reason else label


def _state_cell(e: TrackerEntry) -> str:
    label = state_label(e)
    if e.state == "exception" and e.reevaluate:
        label += f"（見直し: {e.reevaluate}）"
    return _cell(label)


def _entry_row(e: TrackerEntry, host: str, owner: str, repo: str) -> str:
    url = f"https://{host}/{owner}/{repo}/security/{e.kind}/{e.number}"
    package = ""
    if e.package:
        package = e.package + (f"（{e.ghsa}）" if e.ghsa else "")
    cells = [
        f"{_entry_marker(e)} {KIND_LABELS[e.kind]}",
        f"[#{e.number}]({url})",
        e.priority,
        _cell(package),
        _state_cell(e),
    ]
    return "| " + " | ".join(cells) + " |"


def _list_region(body: str) -> tuple[int, int]:
    """本文の一覧の範囲（begin の印の直後, end の印の先頭）。印の組が 1 組でなければエラー

    Raises:
        SecurityAlertError: 印の欠け・重なり・順序の逆転があるとき
    """
    begins = list(_LIST_BEGIN_RE.finditer(body))
    ends = list(_LIST_END_RE.finditer(body))
    if len(begins) != 1 or len(ends) != 1 or begins[0].end() > ends[0].start():
        raise SecurityAlertError(
            "Tracker の本文の list-begin / list-end の印が 1 組ではないため、一覧を書き直せません"
        )
    return begins[0].end(), ends[0].start()


def parse_tracker_entries(body: str | None) -> tuple[list[TrackerEntry], int]:
    """Tracker の本文から、一覧の行と、まとめ済みの結果の件数を読む

    印の無い行・読めない行は読み捨てる（人が足した行は次の実行で消える）。

    Raises:
        SecurityAlertError: list-begin / list-end の印が 1 組ではない場合
    """
    text = _normalize_newlines(body or "")
    begin, end = _list_region(text)
    entries: dict[tuple[AlertKind, int], TrackerEntry] = {}
    folded = 0
    for line in text[begin:end].split("\n"):
        line = line.strip()
        fm = _FOLDED_RE.match(line)
        if fm:
            folded += int(fm.group(1))
            continue
        m = _ROW_RE.match(line)
        if m is None:
            continue
        attrs = dict(re.findall(r"([a-z]+)=(\S+)", m.group(3)))
        state = attrs.get("state", "")
        if state not in _ENTRY_STATES:
            continue
        priority = attrs.get("priority", "medium")
        ghsa = attrs.get("ghsa")
        entry = TrackerEntry(
            kind=cast("AlertKind", m.group(1)),
            number=int(m.group(2)),
            state=cast("EntryState", state),
            priority=priority if priority in _PRIORITY_RANK else "medium",
            reason=attrs.get("reason") or None,
            package=unquote(attrs["pkg"]) if "pkg" in attrs else None,
            ghsa=ghsa if ghsa and _GHSA_RE.match(ghsa) else None,
        )
        entries.setdefault(entry.key, entry)
    return sorted_entries(list(entries.values())), folded


def sorted_entries(entries: list[TrackerEntry]) -> list[TrackerEntry]:
    """行の並びを、種類の順・番号の順に固定する"""
    return sorted(entries, key=lambda e: (ALERT_KINDS.index(e.kind), e.number))


def _table(entries: list[TrackerEntry], folded: int, host: str, owner: str, repo: str) -> str:
    lines = [
        "| 種類 | alert | Priority | パッケージ | 状態 |",
        "|---|---|---|---|---|",
        *(_entry_row(e, host, owner, repo) for e in entries),
    ]
    if folded:
        lines.append(
            f"| <!-- pecot-alert: folded count={folded} --> ほか {folded} 件は結果あり | | | | |"
        )
    return "\n".join(lines)


def _fit(
    entries: list[TrackerEntry],
    folded: int,
    host: str,
    owner: str,
    repo: str,
    size_of: Callable[[str], int],
) -> str:
    """上限に近づいたら、古い結果の行を「ほか N 件は結果あり」の 1 行にまとめた表を返す"""
    rows = list(entries)
    while True:
        table = _table(rows, folded, host, owner, repo)
        if size_of(table) <= BODY_SOFT_LIMIT:
            return table
        oldest = next((i for i, e in enumerate(rows) if e.is_result), None)
        if oldest is None:
            return table
        del rows[oldest]
        folded += 1


def _intro(host: str, owner: str, repo: str) -> str:
    guides = "・".join(
        f"[{KIND_LABELS[k]}]({guide_url(host, owner, repo, k)})" for k in ALERT_KINDS
    )
    return "\n".join(
        [
            TRACKER_MARKER,
            "",
            "Dependabot・code scanning・secret scanning の open の alert を束ねる Tracker。",
            "`pecot security sync` が毎時、下の表を書き直す。表の外の文は残る。",
            "alert の中身は公開の Issue に書かず、Security タブで確かめる。",
            "",
            f"手順: {guides}",
            f"例外の見直し: [手順]({guide_url(host, owner, repo, 'exceptions-review')})",
            "",
        ]
    )


def render_tracker_body(
    entries: list[TrackerEntry],
    folded: int,
    host: str,
    owner: str,
    repo: str,
    existing_body: str | None = None,
) -> str:
    """Tracker の本文を作る

    ``existing_body`` があれば、list-begin から list-end の間だけを書き直し、外の文は残す。
    無ければ新しい Tracker の本文を作る。本文が上限に近づくときは、古い結果の行をまとめる。

    Raises:
        SecurityAlertError: ``existing_body`` の印が 1 組ではない場合
    """
    if existing_body is None:
        head = _intro(host, owner, repo) + LIST_BEGIN + "\n"
        tail = "\n" + LIST_END + "\n"
    else:
        text = _normalize_newlines(existing_body)
        begin, end = _list_region(text)
        head = text[:begin] + "\n"
        tail = "\n" + text[end:]
    fixed = len(head) + len(tail)
    table = _fit(entries, folded, host, owner, repo, lambda t: fixed + len(t))
    return head + table + tail


def build_tracker_title(today: date) -> str:
    """Tracker の題。日付は立てた日（UTC）"""
    return f"[Tracker] security alert — {today.isoformat()} から"


def find_tracker(issues: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, list[int]]:
    """ラベルで引いた Issue から、open の Tracker を探す

    本文に Tracker の印があり、open のものを対象にする。複数あれば番号が最小のものを使い、
    ほかの番号を返す（警告用。sync は閉じない）。
    """
    found = sorted(
        (
            i
            for i in issues
            if i.get("state") == "open" and _TRACKER_RE.search(_str(i.get("body")) or "")
        ),
        key=lambda i: cast("int", i["number"]),
    )
    if not found:
        return None, []
    return found[0], [cast("int", i["number"]) for i in found[1:]]


def alert_result(
    kind: AlertKind, raw: dict[str, Any] | None
) -> tuple[EntryState, str | None] | None:
    """単体で取った alert から、結果の状態と理由を返す。結果にしてはいけないときは None

    ``raw`` が None のときは alert が無い（404）。state が open や未知の値なら結果にしない。
    理由は列挙値（dismissed_reason・resolution）だけを使い、自由記述のコメントは書かない。
    """
    if raw is None:
        return "gone", None
    state = _str(raw.get("state"))
    if state == "fixed":
        return "fixed", None
    if state in ("dismissed", "auto_dismissed"):
        reason = _str(raw.get("dismissed_reason"))
        return "dismissed", _enum_value(reason) if reason else None
    if state == "resolved":
        resolution = _str(raw.get("resolution"))
        return "resolved", _enum_value(resolution) if resolution else None
    return None


def max_priority(entries: list[TrackerEntry]) -> str | None:
    """要判断の行の Priority の最大。要判断の行が無ければ None"""
    values = [e.priority for e in entries if e.state == "open"]
    return max(values, key=lambda p: _PRIORITY_RANK.get(p, 1), default=None)


@dataclass
class TrackerPlan:
    """alert と Tracker の一覧の突き合わせの結果

    Attributes:
        create: 新しい Tracker を立てるか（open の Tracker が無く、要判断の行があるとき）。
        entries: 書き直した後の行（並びは固定）。
        added: 一覧に足した行。
        changed: 状態が変わった行 (前, 後)。
        refetch: 一覧から消えたため、単体で取り直す alert。
    """

    create: bool = False
    entries: list[TrackerEntry] = field(default_factory=list[TrackerEntry])
    added: list[TrackerEntry] = field(default_factory=list[TrackerEntry])
    changed: list[tuple[TrackerEntry, TrackerEntry]] = field(
        default_factory=list[tuple[TrackerEntry, TrackerEntry]]
    )
    refetch: list[tuple[AlertKind, int]] = field(default_factory=list[tuple[AlertKind, int]])


def _from_alert(
    alert: Alert, state: EntryState, reevaluate: str | None, old: TrackerEntry | None
) -> TrackerEntry:
    return TrackerEntry(
        kind=alert.kind,
        number=alert.number,
        state=state,
        priority=alert.priority,
        package=alert.package or (old.package if old else None),
        ghsa=alert.ghsa or (old.ghsa if old else None),
        reevaluate=reevaluate,
    )


def plan_tracker(
    open_alerts: Mapping[AlertKind, list[Alert]],
    exceptions: list[DependabotException] | None,
    entries: list[TrackerEntry] | None,
    failed_kinds: set[AlertKind] | frozenset[AlertKind] = frozenset(),
    disabled_kinds: set[AlertKind] | frozenset[AlertKind] = frozenset(),
    results: Mapping[tuple[AlertKind, int], tuple[EntryState, str | None]] | None = None,
) -> TrackerPlan:
    """open の alert と Tracker の今の行から、書き直した行を出す（純粋関数）

    ``entries`` が None のときは open の Tracker が無い。要判断の alert があるときだけ立てる。
    一覧を取れなかった種類（``failed_kinds``）と無効の種類（``disabled_kinds``）は、
    その種類の行に触れず、足さない。

    open の一覧にある alert は、例外に載っていれば例外、載っていなければ要判断にする
    （結果の行が open に戻った場合も同じ）。一覧から消えた要判断・例外の行は ``refetch`` に入れ、
    ``results``（単体で取り直した結果）があれば結果の行に変える。
    ``results`` に無い行（取り直しの失敗・open・未知の state）は変えない。
    結果の行は、open の一覧に戻らない限り取り直さない。
    例外ファイルに載っていても、一覧から消えたら結果を優先する。
    """
    skipped = set(failed_kinds) | set(disabled_kinds)
    exception_map = {e.alert: e for e in exceptions or []}
    results = results or {}
    plan = TrackerPlan()
    old_by_key = {e.key: e for e in entries or []}
    rows: dict[tuple[AlertKind, int], TrackerEntry] = {}

    for old in entries or []:
        if old.kind in skipped:
            rows[old.key] = old
            continue
        alert = next((a for a in open_alerts.get(old.kind, []) if a.number == old.number), None)
        if alert is not None:
            exc = exception_map.get(alert.number) if alert.kind == "dependabot" else None
            new = _from_alert(
                alert, "exception" if exc else "open", exc.reevaluate if exc else None, old
            )
        elif old.state in ("open", "exception"):
            plan.refetch.append(old.key)
            outcome = results.get(old.key)
            new = (
                replace(old, state=outcome[0], reason=outcome[1], reevaluate=None)
                if outcome
                else old
            )
        else:
            new = old
        rows[old.key] = new

    for kind in ALERT_KINDS:
        if kind in skipped:
            continue
        for alert in open_alerts.get(kind, []):
            key = (kind, alert.number)
            if key in rows:
                continue
            if kind == "dependabot" and alert.number in exception_map:
                continue
            rows[key] = _from_alert(alert, "open", None, None)
            plan.added.append(rows[key])

    plan.entries = sorted_entries(list(rows.values()))
    plan.added = sorted_entries(plan.added)
    for key, new in rows.items():
        old = old_by_key.get(key)
        if old is not None and (old.state, old.reason) != (new.state, new.reason):
            plan.changed.append((old, new))
    plan.changed.sort(key=lambda t: (ALERT_KINDS.index(t[0].kind), t[0].number))
    plan.create = entries is None and any(e.state == "open" for e in plan.entries)
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
