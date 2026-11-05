"""core/security_alerts.py - security alert を Issue に載せるための純粋な処理

``pecot security sync`` と ``release preflight`` が共有する。
ここに置く処理: alert の形をそろえる、Priority を決める。
作る/reopen/閉じる候補を出す処理、Issue の題と本文を作る処理も置く。
code scanning と secret scanning の有効 / 無効の判定もここに置く。

リポとボードは公開なので、題と本文に code scanning の rule・パス・行や、
secret の種類・場所・値を出さない。出すのは種類・番号・Priority・URL・手順へのリンクに限る。
Dependabot は公開の advisory なので、パッケージ名と GHSA の ID も出す。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal, cast

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
REVIEW_MARKER = "<!-- pecot-alert: exceptions-review -->"
REVIEW_TITLE = "[Task] Dependabot の例外を見直す"
# 手順の節（SECURITY.md の見出しのアンカー）
SECURITY_ANCHORS: dict[str, str] = {
    "dependabot": "alert-dependabot",
    "code-scanning": "alert-code-scanning",
    "secret-scanning": "alert-secret-scanning",
    "exceptions-review": "alert-exceptions-review",
}

_MARKER_RE = re.compile(
    r"<!--\s*pecot-alert:\s*(dependabot|code-scanning|secret-scanning)/(\d+)\s*-->"
)
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
    if url:
        return url
    path = {
        "dependabot": "dependabot",
        "code-scanning": "code-scanning",
        "secret-scanning": "secret-scanning",
    }[kind]
    return f"https://{host}/{owner}/{repo}/security/{path}/{raw.get('number')}"


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


def alert_marker(kind: str, number: int) -> str:
    """Issue 本文に埋める、alert との対応の印"""
    return f"<!-- pecot-alert: {kind}/{number} -->"


def parse_alert_marker(body: str | None) -> tuple[AlertKind, int] | None:
    """Issue 本文から alert の印を読む。無ければ None"""
    m = _MARKER_RE.search(body or "")
    if m is None:
        return None
    return cast("AlertKind", m.group(1)), int(m.group(2))


def guide_url(host: str, owner: str, repo: str, section: str) -> str:
    """SECURITY.md の手順の節へのリンク"""
    return f"https://{host}/{owner}/{repo}/blob/main/SECURITY.md#{SECURITY_ANCHORS[section]}"


def build_issue_title(alert: Alert) -> str:
    """alert の Issue の題。中身を示す語は載せない（Dependabot はパッケージ名のみ）"""
    title = f"[Bug] Security alert: {alert.kind} #{alert.number}"
    return f"{title} ({alert.package})" if alert.package else title


def build_issue_body(alert: Alert, host: str, owner: str, repo: str) -> str:
    """alert の Issue の本文。種類・番号・Priority・URL・手順リンクだけを書く"""
    lines = [
        alert_marker(alert.kind, alert.number),
        "",
        f"- 種類: {KIND_LABELS[alert.kind]}",
        f"- alert: #{alert.number}",
        f"- Priority: {alert.priority}",
    ]
    if alert.package:
        lines.append(f"- パッケージ: {alert.package}")
    if alert.ghsa:
        lines.append(f"- GHSA: {alert.ghsa}")
    lines += [
        f"- alert の URL: {alert.url}",
        f"- 手順: {guide_url(host, owner, repo, alert.kind)}",
        "",
        "alert の中身は公開の Issue に書かず、Security タブで確かめる。",
    ]
    return "\n".join(lines) + "\n"


def build_review_body(
    exceptions: list[DependabotException], host: str, owner: str, repo: str
) -> str:
    """例外の見直しの Issue の本文。例外ごとに alert 番号・パッケージ・見直し条件を並べる"""
    lines = [REVIEW_MARKER, "", "Dependabot の例外を見直す時機です。", ""]
    for e in exceptions:
        lines.append(f"- alert #{e.alert}（{e.package}）: 見直し条件: {e.reevaluate}")
    lines += ["", f"手順: {guide_url(host, owner, repo, 'exceptions-review')}"]
    return "\n".join(lines) + "\n"


@dataclass
class SyncPlan:
    """alert と Issue の突き合わせの結果

    Attributes:
        create: Issue を作る alert。
        reopen: closed の Issue を reopen する (alert, Issue 番号)。
        ensure: 既にある open の Issue (alert, Issue 番号)。ボードへの追加を毎回やり直す。
        close: 対応する open の alert が無い open の Issue (kind, alert 番号, Issue 番号)。
            閉じる前に alert を単体で確かめる。
    """

    create: list[Alert] = field(default_factory=list[Alert])
    reopen: list[tuple[Alert, int]] = field(default_factory=list[tuple[Alert, int]])
    ensure: list[tuple[Alert, int]] = field(default_factory=list[tuple[Alert, int]])
    close: list[tuple[AlertKind, int, int]] = field(
        default_factory=list[tuple[AlertKind, int, int]]
    )


def plan_sync(
    open_alerts: dict[AlertKind, list[Alert]],
    issues: list[dict[str, Any]],
    skipped_kinds: set[AlertKind] | frozenset[AlertKind] = frozenset(),
) -> SyncPlan:
    """open の alert と、ラベルで引いた Issue（open・closed）から、作る・reopen・閉じる候補を出す

    一覧を取れなかった種類（``skipped_kinds``）は、作る・閉じるを飛ばす。
    空の一覧とみなして全件を閉じることを防ぐ。
    同じ alert の Issue が複数あるときは、open を優先し、なければ番号が最大のものを使う。
    """
    by_alert: dict[tuple[AlertKind, int], list[dict[str, Any]]] = {}
    for issue in issues:
        parsed = parse_alert_marker(_str(issue.get("body")))
        if parsed is not None:
            by_alert.setdefault(parsed, []).append(issue)

    plan = SyncPlan()
    open_keys: set[tuple[AlertKind, int]] = set()
    for kind in ALERT_KINDS:
        if kind in skipped_kinds:
            continue
        for alert in sorted(open_alerts.get(kind, []), key=lambda a: a.number):
            open_keys.add((kind, alert.number))
            candidates = by_alert.get((kind, alert.number), [])
            opened = [i for i in candidates if i.get("state") == "open"]
            if opened:
                plan.ensure.append((alert, max(i["number"] for i in opened)))
            elif candidates:
                plan.reopen.append((alert, max(i["number"] for i in candidates)))
            else:
                plan.create.append(alert)

    for (kind, number), found in sorted(by_alert.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        if kind in skipped_kinds or (kind, number) in open_keys:
            continue
        plan.close.extend(
            (kind, number, i["number"])
            for i in sorted(found, key=lambda i: i["number"])
            if i.get("state") == "open"
        )
    return plan


def close_reason(kind: AlertKind, raw: dict[str, Any] | None) -> str | None:
    """単体で取った alert から、Issue を閉じる理由の文を作る。閉じてはいけないときは None

    ``raw`` が None のときは alert が無い（404）。state が open なら一覧と食い違うので閉じない。
    理由は列挙値（dismissed_reason・resolution）だけを使い、自由記述のコメントは書かない。
    """
    if raw is None:
        return "alert が無いため閉じます。"
    state = _str(raw.get("state"))
    if state == "fixed":
        return "alert が fixed になったため閉じます。"
    if state in ("dismissed", "auto_dismissed"):
        reason = _str(raw.get("dismissed_reason"))
        detail = f"（理由: {reason}）" if reason else ""
        return f"alert が dismissed になったため閉じます{detail}。"
    if state == "resolved":
        resolution = _str(raw.get("resolution"))
        detail = f"（理由: {resolution}）" if resolution else ""
        return f"alert が resolved になったため閉じます{detail}。"
    return None


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


def _enabled(alerts: list[dict[str, Any]], url: str) -> ScanAlertStatus:
    numbers = sorted(n for n in (a.get("number") for a in alerts) if isinstance(n, int))
    return ScanAlertStatus(
        enabled=True, open_count=len(alerts), alerts_url=url, open_numbers=numbers
    )


def fetch_code_scanning_status(
    client: GitHubClient, host: str, owner: str, repo: str, ref: str = "refs/heads/main"
) -> ScanAlertStatus:
    """code scanning の open の alert 数を取る

    403（GHAS 無し）は無効、解析が無い 404 は 0 件とみなす。
    権限不足などの 403 は無効とみなさずエラーにする。

    Raises:
        SecurityAlertError: 状態を判定できない場合
    """
    url = f"https://{host}/{owner}/{repo}/security/code-scanning"
    try:
        alerts = client.list_open_code_scanning_alerts(owner, repo, ref)
    except GitHubAPIError as e:
        if is_code_scanning_disabled(e):
            return ScanAlertStatus(enabled=False, open_count=0, alerts_url=url)
        if is_no_analysis(e):
            return ScanAlertStatus(enabled=True, open_count=0, alerts_url=url)
        raise SecurityAlertError(f"{owner}/{repo}: code scanning: {describe_api_error(e)}") from e
    except httpx.HTTPError as e:
        raise SecurityAlertError(f"{owner}/{repo}: 通信に失敗しました: {e}") from e
    return _enabled(alerts, url)


def fetch_secret_scanning_status(
    client: GitHubClient, host: str, owner: str, repo: str
) -> ScanAlertStatus:
    """secret scanning の open の alert 数を取る。404 は無効とみなす（値は取得しない）

    Raises:
        SecurityAlertError: 状態を判定できない場合（403 は権限不足として扱う）
    """
    url = f"https://{host}/{owner}/{repo}/security/secret-scanning"
    try:
        alerts = client.list_open_secret_scanning_alerts(owner, repo)
    except GitHubAPIError as e:
        if e.status_code == 404:
            return ScanAlertStatus(enabled=False, open_count=0, alerts_url=url)
        raise SecurityAlertError(f"{owner}/{repo}: secret scanning: {describe_api_error(e)}") from e
    except httpx.HTTPError as e:
        raise SecurityAlertError(f"{owner}/{repo}: 通信に失敗しました: {e}") from e
    return _enabled(alerts, url)
