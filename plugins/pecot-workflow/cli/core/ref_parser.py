"""core/ref_parser.py - Issue/PR参照パーサー

owner/repo/N 形式のIssue/PR参照を pydantic 型（IssueRef / RepoRef）として
パースする共通関数を提供する。短縮形 ``N`` は ``base_repo`` で補う。

data-model.md §IssueRef / contracts/core-ref-parser.md 準拠。
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field

from cli.core.errors import PecotError

from .repo_resolver import RepoRef


class RefParseError(PecotError):
    """参照パースエラー。CLI 層で typer.BadParameter に変換する想定。"""

    def __init__(self, message: str, ref: str) -> None:
        self.message = message
        self.ref = ref
        super().__init__(message)


# IssueRef (pydantic) — data-model.md §IssueRef 準拠


class IssueRef(BaseModel):
    """Issue/PR 参照の型安全表現。

    data-model.md §IssueRef 準拠。
    """

    repo: RepoRef
    number: int = Field(gt=0)

    def __str__(self) -> str:
        return f"{self.repo.full_name}#{self.number}"

    def to_cli_ref(self) -> str:
        return f"{self.repo.full_name}/{self.number}"


# 内部 helper: tuple 抽出


def _parse_ref_tuple(ref: str) -> tuple[str, str, int]:
    """Issue/PR 参照を tuple に分解する internal helper。

    ``owner/repo/N`` 形式のみ受理する。
    """
    new_pattern = r"^([^/]+)/([^/]+)/(\d+)$"
    match = re.match(new_pattern, ref)
    if match:
        return match.group(1), match.group(2), int(match.group(3))

    raise RefParseError(
        f"invalid reference: {ref}\n"
        f"accepted forms:\n"
        f"  - full: 'owner/repo/N'\n"
        f"  - short: 'N' (with a base repository)",
        ref,
    )


# 公開 API（contract §Public API 準拠）


def parse_issue_ref(raw: str, base_repo: RepoRef | None = None) -> IssueRef:
    """Issue 参照を ``IssueRef`` にパースする。

    data-model.md §IssueRef / contracts/core-ref-parser.md 準拠。

    対応形式:
      - ``"owner/repo/N"``: 主軸形式（推奨）
      - ``"N"``: 短縮形（``base_repo`` 必須）

    Args:
        raw: 入力文字列
        base_repo: 短縮形 ``"N"`` のフォールバック先

    Raises:
        RefParseError: 不正な形式、または短縮形で ``base_repo`` が None の場合
    """
    if raw.isascii() and raw.isdigit():
        if base_repo is None:
            raise RefParseError(
                "the short form 'N' needs a base_repo: "
                "pass --repo <owner/repo> or use the full form 'owner/repo/N'",
                ref=raw,
            )
        return IssueRef(repo=base_repo, number=int(raw))

    owner, repo, number = _parse_ref_tuple(raw)
    try:
        return IssueRef(repo=RepoRef(owner=owner, repo=repo), number=number)
    except ValueError as e:
        raise RefParseError(str(e), ref=raw) from None


def parse_pr_ref(raw: str, base_repo: RepoRef | None = None) -> IssueRef:
    """PR 参照を ``IssueRef`` にパースする。

    PR と Issue は番号空間を共有するため実装は ``parse_issue_ref`` に委譲する。
    用途上のエイリアスとして独立名で提供する。

    Args:
        raw: 入力文字列
        base_repo: 短縮形 ``"N"`` のフォールバック先

    Raises:
        RefParseError: 不正な形式、または短縮形で ``base_repo`` が None の場合
    """
    return parse_issue_ref(raw, base_repo=base_repo)


def parse_repo_ref(raw: str) -> RepoRef:
    """``owner/repo`` 形式の文字列を ``RepoRef`` にパースする。

    Args:
        raw: 入力文字列

    Raises:
        RefParseError: 不正な形式の場合
    """
    try:
        return RepoRef.parse(raw)
    except ValueError as e:
        raise RefParseError(str(e), ref=raw) from None


# PR 本文の Refs 抽出

_REFS_PATTERN = re.compile(
    r"(?:^|\s)Refs?:?\s+"
    r"(?:#(?P<number>\d+)"
    r"|(?P<owner>[A-Za-z0-9_.-]+)/(?P<repo>[A-Za-z0-9_.-]+)[#/](?P<qualified_number>\d+))",
    re.IGNORECASE | re.MULTILINE,
)


def extract_refs_issue_numbers(body: str | None, repo: RepoRef) -> set[int]:
    """PR 本文から Refs で参照された Issue 番号を抽出する。

    受理形式は次のとおり（``Ref`` / ``Refs`` の後のコロンは任意、大文字小文字は区別しない）。
      - ``Refs #N``
      - ``Refs owner/repo#N``
      - ``Refs owner/repo/N``

    ``owner/repo`` 付きの参照は ``repo`` と一致（casefold）するときだけ採り、
    他リポの番号は無視する。

    Args:
        body: PR 本文
        repo: PR のリポジトリ

    Returns:
        Issue 番号の集合
    """
    if not body:
        return set()
    owner_key = repo.owner.casefold()
    repo_key = repo.repo.casefold()
    numbers: set[int] = set()
    for m in _REFS_PATTERN.finditer(body):
        number = m.group("number")
        if number is not None:
            numbers.add(int(number))
            continue
        if m.group("owner").casefold() == owner_key and m.group("repo").casefold() == repo_key:
            numbers.add(int(m.group("qualified_number")))
    return numbers
