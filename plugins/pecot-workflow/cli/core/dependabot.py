"""core/dependabot.py - Dependabot alert の状態判定

``release preflight`` と ``project info`` が同じ判定を共有する。
有効 / 無効・open 件数・最高 severity・一覧 URL を ``DependabotAlertStatus`` にまとめて返す。
``release preflight`` が通す例外は、リポの ``.github/dependabot-exceptions.json`` から読む。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any, cast

import httpx
from pydantic import BaseModel, Field, StringConstraints, ValidationError

from cli.core.errors import PecotError
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.github.errors import GitHubRateLimitError

# severity の強さ順（大きいほど重い）。未知の値は順位 -1 として扱い落とさない
SEVERITY_ORDER: dict[str, int] = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# 修正版に上げられない alert を、理由と見直し条件つきで載せる例外ファイル（リポのルートから）
EXCEPTIONS_PATH = Path(".github/dependabot-exceptions.json")

NonBlankStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class DependabotAlertError(PecotError):
    """Dependabot alert の状態を判定できない場合のエラー

    alerts が無効なのか権限不足なのかを区別できないときも含む。
    """


class OpenAlert(BaseModel):
    """open の alert 1 件の要点

    Attributes:
        number: alert 番号。
        package: 依存パッケージ名（応答に無ければ None）。
        severity: severity（応答に無ければ None）。
    """

    number: int
    package: str | None
    severity: str | None


class DependabotAlertStatus(BaseModel):
    """リポジトリの Dependabot alert の状態

    Attributes:
        enabled: alerts が有効か。
        open_count: open の alert 件数（無効なら 0）。
        max_severity: open の alert の最高 severity（0 件・無効なら None）。
        alerts_url: alert 一覧の Web URL。
        open_alerts: open の alert の要点（``project info`` の JSON には出さない）。
    """

    enabled: bool
    open_count: int
    max_severity: str | None
    alerts_url: str
    open_alerts: list[OpenAlert] = Field(default_factory=list[OpenAlert], exclude=True)


class DependabotException(BaseModel):
    """例外ファイルの 1 項目。直せない alert を open のまま release preflight に通す

    Attributes:
        alert: alert 番号。
        package: 依存パッケージ名。
        reason: 修正版に上げられない理由。
        reevaluate: 例外を外す条件（見直しの観点）。
    """

    alert: int
    package: NonBlankStr
    reason: NonBlankStr
    reevaluate: NonBlankStr


class _ExceptionsFile(BaseModel):
    exceptions: list[DependabotException]


def _severity_rank(severity: str | None) -> int:
    return SEVERITY_ORDER.get(severity or "", -1)


def max_severity_of(alerts: list[OpenAlert]) -> str | None:
    """alert の要点の並びから最高 severity を返す"""
    values = [a.severity for a in alerts if a.severity is not None]
    return max(values, key=_severity_rank, default=None)


def _open_alert(alert: dict[str, Any]) -> OpenAlert | None:
    """API の alert から要点を取り出す。番号が無ければ None"""
    number = alert.get("number")
    if not isinstance(number, int):
        return None
    vulnerability = alert.get("security_vulnerability")
    severity = (
        cast("dict[str, Any]", vulnerability).get("severity")
        if isinstance(vulnerability, dict)
        else None
    )
    dependency = alert.get("dependency")
    package_info = (
        cast("dict[str, Any]", dependency).get("package") if isinstance(dependency, dict) else None
    )
    package = (
        cast("dict[str, Any]", package_info).get("name") if isinstance(package_info, dict) else None
    )
    return OpenAlert(
        number=number,
        package=package if isinstance(package, str) else None,
        severity=severity if isinstance(severity, str) else None,
    )


def load_dependabot_exceptions(git_root: Path) -> list[DependabotException] | None:
    """リポの例外ファイルを読む。ファイルが無ければ None

    Raises:
        DependabotAlertError: JSON として読めない、または項目が欠けている場合
    """
    path = git_root / EXCEPTIONS_PATH
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return _ExceptionsFile.model_validate(data).exceptions
    except (ValueError, ValidationError) as e:
        raise DependabotAlertError(f"{EXCEPTIONS_PATH} を読めません: {e}") from e


def _max_severity(alerts: list[dict[str, Any]]) -> str | None:
    """各 alert の security_vulnerability.severity の最大値を返す"""
    values: list[str] = []
    for alert in alerts:
        vulnerability = alert.get("security_vulnerability")
        if not isinstance(vulnerability, dict):
            continue
        severity = cast("dict[str, Any]", vulnerability).get("severity")
        if isinstance(severity, str):
            values.append(severity)
    return max(values, key=_severity_rank, default=None)


def _describe(error: GitHubAPIError) -> str:
    """GitHubAPIError の message に、応答本文 JSON の message だけを添える

    本文が JSON でない（HTML 等）・message が無いときは添えない。
    """
    try:
        body = json.loads(error.response_body or "")
    except ValueError:
        return error.message
    if not isinstance(body, dict):
        return error.message
    detail = cast("dict[str, Any]", body).get("message")
    if isinstance(detail, str) and detail.strip():
        return f"{error.message} {detail.strip()}"
    return error.message


def _classify_forbidden(
    client: GitHubClient, owner: str, repo: str, alerts_url: str
) -> DependabotAlertStatus:
    """一覧が 403 のとき、vulnerability-alerts で「無効」かどうかを分類する

    404 のみを無効とみなす。204 は有効なのに一覧が取れない状態でエラーにする。
    """
    if client.is_dependabot_alerts_enabled(owner, repo):
        raise DependabotAlertError(
            f"{owner}/{repo}: Dependabot alerts は有効ですが一覧を取得できません（権限不足の可能性）"
        )
    return DependabotAlertStatus(
        enabled=False, open_count=0, max_severity=None, alerts_url=alerts_url
    )


def _fetch_alerts_or_status(
    client: GitHubClient, owner: str, repo: str, alerts_url: str
) -> list[dict[str, Any]] | DependabotAlertStatus:
    """open alert の一覧を返す。一覧が 403 のときだけ分類した状態を返す

    レート制限（403）は分類せず再送出する。
    """
    try:
        return client.list_open_dependabot_alerts(owner, repo)
    except GitHubAPIError as e:
        if e.status_code != 403 or isinstance(e, GitHubRateLimitError):
            raise
        return _classify_forbidden(client, owner, repo, alerts_url)


def fetch_dependabot_alert_status(
    client: GitHubClient, host: str, owner: str, repo: str
) -> DependabotAlertStatus:
    """リポジトリの Dependabot alert の状態を取得する

    一覧取得が 200 なら有効確定で集計する。403 のときだけ有効 / 無効の判定で
    分類する（権限不足を「無効」と取り違えないため）。

    Raises:
        DependabotAlertError: 状態を判定できない場合（API エラー・通信エラー・
            有効なのに一覧が取れない場合）
    """
    alerts_url = f"https://{host}/{owner}/{repo}/security/dependabot"
    try:
        alerts = _fetch_alerts_or_status(client, owner, repo, alerts_url)
    except GitHubAPIError as e:
        raise DependabotAlertError(f"{owner}/{repo}: {_describe(e)}") from e
    except httpx.HTTPError as e:
        raise DependabotAlertError(f"{owner}/{repo}: 通信に失敗しました: {e}") from e

    if isinstance(alerts, DependabotAlertStatus):
        return alerts
    return DependabotAlertStatus(
        enabled=True,
        open_count=len(alerts),
        max_severity=_max_severity(alerts),
        alerts_url=alerts_url,
        open_alerts=[a for a in map(_open_alert, alerts) if a is not None],
    )
