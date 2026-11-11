"""マルチリポ対応のリポジトリ解決決定木（FR-001 / FR-002）。

## 公開API

### ``resolve_repo(explicit, cwd=None) -> ResolvedRepo``

- 引数:
    - ``explicit: str | None`` — CLI ``--repo`` 値。形式は ``owner/repo``。
    - ``cwd: Path | None`` — Git 検索起点。``None`` なら ``Path.cwd()``。
- 戻り値: ``ResolvedRepo``（``repo`` / ``source`` / ``remote_name``）

### 決定木（FR-001）

1. ``explicit`` が与えられていれば ``RepoRef.parse(explicit)`` → ``source=EXPLICIT``
2. ``cwd`` が Git ワークツリー内の場合。
     - ``git remote`` に ``origin`` があれば ``origin`` を採用する。
     - 無ければ最初の remote を採用する。
     - remote URL から ``(owner, repo)`` を抽出する → ``source=CURRENT_GIT``。
3. いずれも不成立 → ``AmbiguousRepoError``

### 例外

- ``ValueError``: ``explicit`` が ``owner/repo`` 形式に不適合、または remote URL パース失敗
- ``AmbiguousRepoError``: 決定木で確定不能

"""

from __future__ import annotations

import re
from enum import Enum
from pathlib import Path

from pydantic import BaseModel, field_validator, model_validator

from cli.core.errors import PecotError
from cli.core.git import pick_primary_remote, run_git
from cli.core.git_url import parse_remote_url

_SEGMENT_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")


class RepoRef(BaseModel):
    """リポジトリ参照（owner/repo）。data-model.md §RepoRef 準拠。"""

    owner: str
    repo: str

    @field_validator("owner", "repo")
    @classmethod
    def _validate_segment(cls, v: str) -> str:
        if not _SEGMENT_PATTERN.fullmatch(v):
            raise ValueError(f"invalid owner/repo segment: {repr(v)} (allowed: [A-Za-z0-9_.-]+)")
        return v

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"

    @classmethod
    def parse(cls, s: str) -> RepoRef:
        """``owner/repo`` 形式の文字列を RepoRef に変換する。

        不正な形式は ``ValueError`` を発生する。
        """
        parts = s.split("/")
        if len(parts) != 2:
            raise ValueError(f"invalid owner/repo form: {repr(s)} (expected: 'owner/repo')")
        owner, repo = parts
        return cls(owner=owner, repo=repo)


class ResolveSource(str, Enum):
    """``ResolvedRepo.source`` 列挙。"""

    EXPLICIT = "explicit"
    CURRENT_GIT = "current-git"


class ResolvedRepo(BaseModel):
    """``resolve_repo()`` の戻り値。data-model.md §ResolvedRepo 準拠。"""

    repo: RepoRef
    source: ResolveSource
    remote_name: str | None = None

    @model_validator(mode="after")
    def _check_remote_name_consistency(self) -> ResolvedRepo:
        if self.source is ResolveSource.CURRENT_GIT and not self.remote_name:
            raise ValueError("remote_name is required when source=CURRENT_GIT")
        if self.source is ResolveSource.EXPLICIT and self.remote_name is not None:
            raise ValueError("remote_name must be None when source=EXPLICIT")
        return self


class AmbiguousRepoError(PecotError):
    """リポジトリ解決決定木が確定不能のときに発生する。"""


def _detect_current_git_repo(cwd: Path) -> tuple[RepoRef, str] | None:
    """カレント Git remote からリポジトリを抽出する。

    Returns:
        ``(RepoRef, remote_name)`` または Git 外 / remote 無しなら ``None``

    Raises:
        ValueError: remote URL が想定形式に一致しない場合（バグ扱いなので伝播）
    """
    rev = run_git(["rev-parse", "--is-inside-work-tree"], cwd, check=False)
    if rev.returncode != 0 or rev.stdout.strip() != "true":
        return None

    remotes_cp = run_git(["remote"], cwd, check=False)
    if remotes_cp.returncode != 0:
        return None
    remotes = [line.strip() for line in remotes_cp.stdout.splitlines() if line.strip()]
    if not remotes:
        return None

    remote_name = pick_primary_remote(remotes)
    if remote_name is None:
        return None
    url_cp = run_git(["remote", "get-url", remote_name], cwd, check=False)
    if url_cp.returncode != 0:
        return None
    _host, owner, repo = parse_remote_url(url_cp.stdout.strip())
    return RepoRef(owner=owner, repo=repo), remote_name


def resolve_repo(
    explicit: str | None,
    cwd: Path | None = None,
) -> ResolvedRepo:
    """マルチリポ対応のリポジトリ解決決定木 (FR-001)。"""
    if explicit is not None:
        return ResolvedRepo(
            repo=RepoRef.parse(explicit),
            source=ResolveSource.EXPLICIT,
            remote_name=None,
        )

    base = cwd if cwd is not None else Path.cwd()
    detected = _detect_current_git_repo(base)
    if detected is not None:
        ref, remote_name = detected
        return ResolvedRepo(
            repo=ref,
            source=ResolveSource.CURRENT_GIT,
            remote_name=remote_name,
        )

    raise AmbiguousRepoError("repository is ambiguous: pass --repo <owner/repo>")
