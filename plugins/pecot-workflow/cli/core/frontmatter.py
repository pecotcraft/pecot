"""core/frontmatter.py - YAMLフロントマターパーサー

YAMLフロントマター付きMarkdownファイルをパースし、
Pydanticモデルに変換する機能を提供する。

Usage:
    from cli.core.frontmatter import parse_issue_file

    result = parse_issue_file("path/to/issue.md")
    print(result.frontmatter.title)
    print(result.body)
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated, Literal

import yaml
from pydantic import BaseModel, BeforeValidator, StringConstraints, ValidationError, model_validator

from cli.core.config import Priority, Size, WorkflowStatus
from cli.core.errors import PecotError

# 例外クラス


class FrontmatterError(PecotError):
    """フロントマター操作エラーの基底クラス"""

    pass


# 型定義

IssueType = Literal["task", "bug", "epic"]
IssueTemplateType = Literal["task", "bug", "epic", "task-implement"]
CommentTemplate = Literal[
    "plan", "merge-diff", "review-findings", "review-resolution", "precede-notify"
]


def empty_str_to_none(v: object) -> object:
    """空文字列をNoneに変換

    YAMLパーサーが空文字列として解析したオプショナルフィールドを
    Noneに正規化する。
    """
    if v == "":
        return None
    return v


def _normalize_parent_epic(v: object) -> object:
    """parent_epic の入力を正規化する。
    None / 空文字 → None、int → そのまま、数字文字列 "21" → int(21)。
    その他の文字列 "owner/repo/21" → str のまま（CLI 層で parse_issue_ref 対象）。
    """
    if v is None or v == "":
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        s = v.strip()
        if s.isdigit():
            return int(s)
        return s
    return v


# 型エイリアス定義
OptionalInt = Annotated[int | None, BeforeValidator(empty_str_to_none)]
OptionalPriority = Annotated[Priority | None, BeforeValidator(empty_str_to_none)]
OptionalSize = Annotated[Size | None, BeforeValidator(empty_str_to_none)]
OptionalIssueTemplateType = Annotated[IssueTemplateType | None, BeforeValidator(empty_str_to_none)]
OptionalParallel = Annotated[
    Annotated[str, StringConstraints(pattern=r"^[a-z]$")] | None,
    BeforeValidator(empty_str_to_none),
]
OptionalParentEpic = Annotated[int | str | None, BeforeValidator(_normalize_parent_epic)]


# Pydanticモデル


class IssueFrontmatter(BaseModel):
    """Issueフロントマターモデル

    Markdownファイルのフロントマターから抽出されるメタデータ。

    Attributes:
        title: Issueタイトル。
        type: Issueタイプ（task / bug / epic）。
        repository: リポジトリ（owner/name形式）。
        status: ワークフローステータス（オプション）。
        priority: 優先度（オプション）。
        size: サイズ（オプション）。
        labels: ラベルリスト。
        parent_epic: 親EpicのIssue番号（オプション）。
        order: サブタスクの段（オプション）。
        parallel: 同じ段で並列に進める枝の文字 a〜z（オプション）。
    """

    title: str
    type: IssueType
    template: OptionalIssueTemplateType = None
    repository: str
    status: WorkflowStatus
    priority: OptionalPriority = None
    size: OptionalSize = None
    labels: list[str] = []
    parent_epic: OptionalParentEpic = None
    order: OptionalInt = None
    parallel: OptionalParallel = None

    @model_validator(mode="after")
    def validate_order_with_parent_epic(self) -> IssueFrontmatter:
        """parent_epicとorderの相互依存バリデーション"""
        if self.parent_epic is not None and self.order is None:
            raise ValueError("parent_epicが指定されている場合、orderは必須です")
        if self.parent_epic is None and self.order is not None:
            raise ValueError("orderを指定する場合、parent_epicも指定してください")
        if self.order is not None and self.order <= 0:
            raise ValueError(f"orderは1以上の整数である必要があります（現在: {self.order}）")
        if self.parallel is not None and self.order is None:
            raise ValueError("parallelを指定する場合、orderも指定してください")
        return self


class ParsedIssue(BaseModel):
    """パース結果モデル

    フロントマターと本文を分離した結果。

    Attributes:
        frontmatter: パースされたフロントマター
        body: 本文（フロントマター以降の内容）
    """

    frontmatter: IssueFrontmatter
    body: str


class CommentFrontmatter(BaseModel):
    """コメントフロントマターモデル

    Issueコメント用Markdownファイルのフロントマターから抽出されるメタデータ。

    Attributes:
        issue_ref: Issue参照（owner/repo/123形式）
        template: テンプレート識別子（オプション）
    """

    issue_ref: str
    template: CommentTemplate | None = None


class ParsedComment(BaseModel):
    """コメントパース結果モデル

    フロントマターと本文を分離した結果。

    Attributes:
        frontmatter: パースされたコメントフロントマター
        body: 本文（フロントマター以降の内容）
    """

    frontmatter: CommentFrontmatter
    body: str


class PRFrontmatter(BaseModel):
    """PRフロントマターモデル

    PR作成用Markdownファイルのフロントマターから抽出されるメタデータ。

    Attributes:
        title: PRタイトル。
        repository: リポジトリ（owner/name形式）。
        base: ベースブランチ。
        head: ヘッドブランチ（オプション、省略時は現在のブランチを使用）。
        draft: ドラフトPRフラグ（オプション、デフォルトFalse）。
    """

    title: str
    repository: str
    base: str
    head: str | None = None
    draft: bool = False


class ParsedPR(BaseModel):
    """PRパース結果モデル

    フロントマターと本文を分離した結果。

    Attributes:
        frontmatter: パースされたPRフロントマター
        body: 本文（フロントマター以降の内容）
    """

    frontmatter: PRFrontmatter
    body: str


# パーサー関数

# フロントマター正規表現
# ^---\n で始まり、\n---\n で終わる
FRONTMATTER_PATTERN = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)

# 本文先頭のガイドコメント（`--prepare` 雛形の「読者:／書き方:／フィールド:」ブロック）。
# 前後の空白・空行ごと 1 ブロックだけ食う。本文途中のコメントは対象外。
LEADING_HTML_COMMENT_PATTERN = re.compile(r"\A\s*<!--.*?-->[ \t]*\r?\n?\s*", re.DOTALL)


def strip_leading_html_comment(body: str) -> str:
    """本文先頭の HTML コメントブロックを 1 つだけ除去する。

    `--prepare` が配る雛形は冒頭に書き方ガイドの ``<!-- ... -->`` を持つ。
    利用者が消し忘れたまま投稿しても GitHub 本文に残らないよう、
    パース時に取り除く（#958 F-02）。本文途中の ``<details>`` 等の HTML には触れない。

    Args:
        body: フロントマターを除いた本文

    Returns:
        先頭コメントブロックとその前後の空白を落とした本文
    """
    return LEADING_HTML_COMMENT_PATTERN.sub("", body, count=1)


def strip_frontmatter(content: str) -> str:
    """フロントマターを落とした本文を返す（不正・不在なら原文をそのまま返す）。

    パース前の素朴な走査（プレースホルダ検証など）で本文だけを対象にするための
    寛容なヘルパ。バリデーションはしない。
    """
    match = FRONTMATTER_PATTERN.match(content)
    if not match:
        return content
    return content[match.end() :]


def parse_frontmatter(content: str) -> ParsedIssue:
    """文字列からフロントマターをパース

    Args:
        content: フロントマター付きMarkdown文字列

    Returns:
        ParsedIssueオブジェクト

    Raises:
        FrontmatterError: パースエラー時
    """
    # フロントマターの存在確認
    if not content.startswith("---"):
        raise FrontmatterError("フロントマターが見つかりません（---で始まっていない）")

    # フロントマターの終端確認
    match = FRONTMATTER_PATTERN.match(content)
    if not match:
        raise FrontmatterError("フロントマターが閉じられていません（終端の---がない）")

    yaml_content = match.group(1)
    body = strip_leading_html_comment(content[match.end() :].strip()).strip()

    # YAMLパース
    try:
        data = yaml.safe_load(yaml_content)
    except yaml.YAMLError as e:
        raise FrontmatterError(f"YAMLのパースに失敗しました: {e}") from e

    if not isinstance(data, dict):
        raise FrontmatterError("フロントマターはマッピング（key: value）形式である必要があります")

    # Pydanticモデルへの変換
    try:
        frontmatter = IssueFrontmatter.model_validate(data)
    except ValidationError as e:
        # バリデーションエラーをわかりやすくフォーマット
        errors: list[str] = []
        for error in e.errors():
            field = ".".join(str(loc) for loc in error["loc"])
            msg = error["msg"]
            errors.append(f"  - {field}: {msg}")
        error_detail = "\n".join(errors)
        raise FrontmatterError(f"バリデーションエラー:\n{error_detail}") from e

    return ParsedIssue(frontmatter=frontmatter, body=body)


def parse_issue_file(path: Path | str) -> ParsedIssue:
    """ファイルからフロントマターをパース

    Args:
        path: Markdownファイルのパス

    Returns:
        ParsedIssueオブジェクト

    Raises:
        FrontmatterError: ファイルが見つからない場合、またはパースエラー時
    """
    path = Path(path)

    if not path.exists():
        raise FrontmatterError(f"ファイルが見つかりません: {path}")

    content = path.read_text(encoding="utf-8")
    return parse_frontmatter(content)


def parse_comment_content(content: str) -> ParsedComment:
    """文字列からコメントフロントマターをパース

    Args:
        content: フロントマター付きMarkdown文字列

    Returns:
        ParsedCommentオブジェクト

    Raises:
        FrontmatterError: パースエラー時
    """
    # フロントマターの存在確認
    if not content.startswith("---"):
        raise FrontmatterError("フロントマターが見つかりません（---で始まっていない）")

    # フロントマターの終端確認
    match = FRONTMATTER_PATTERN.match(content)
    if not match:
        raise FrontmatterError("フロントマターが閉じられていません（終端の---がない）")

    yaml_content = match.group(1)
    body = strip_leading_html_comment(content[match.end() :].strip()).strip()

    # YAMLパース
    try:
        data = yaml.safe_load(yaml_content)
    except yaml.YAMLError as e:
        raise FrontmatterError(f"YAMLのパースに失敗しました: {e}") from e

    if not isinstance(data, dict):
        raise FrontmatterError("フロントマターはマッピング（key: value）形式である必要があります")

    # Pydanticモデルへの変換
    try:
        frontmatter = CommentFrontmatter.model_validate(data)
    except ValidationError as e:
        # バリデーションエラーをわかりやすくフォーマット
        errors: list[str] = []
        for error in e.errors():
            field = ".".join(str(loc) for loc in error["loc"])
            msg = error["msg"]
            errors.append(f"  - {field}: {msg}")
        error_detail = "\n".join(errors)
        raise FrontmatterError(f"バリデーションエラー:\n{error_detail}") from e

    return ParsedComment(frontmatter=frontmatter, body=body)


def parse_comment_file(path: Path | str) -> ParsedComment:
    """コメントファイルからフロントマターをパース

    Args:
        path: Markdownファイルのパス

    Returns:
        ParsedCommentオブジェクト

    Raises:
        FrontmatterError: ファイルが見つからない場合、またはパースエラー時
    """
    path = Path(path)

    if not path.exists():
        raise FrontmatterError(f"ファイルが見つかりません: {path}")

    content = path.read_text(encoding="utf-8")
    return parse_comment_content(content)


def parse_pr_content(content: str) -> ParsedPR:
    """文字列からPRフロントマターをパース

    Args:
        content: フロントマター付きMarkdown文字列

    Returns:
        ParsedPRオブジェクト

    Raises:
        FrontmatterError: パースエラー時
    """
    # フロントマターの存在確認
    if not content.startswith("---"):
        raise FrontmatterError("フロントマターが見つかりません（---で始まっていない）")

    # フロントマターの終端確認
    match = FRONTMATTER_PATTERN.match(content)
    if not match:
        raise FrontmatterError("フロントマターが閉じられていません（終端の---がない）")

    yaml_content = match.group(1)
    body = strip_leading_html_comment(content[match.end() :].strip()).strip()

    # YAMLパース
    try:
        data = yaml.safe_load(yaml_content)
    except yaml.YAMLError as e:
        raise FrontmatterError(f"YAMLのパースに失敗しました: {e}") from e

    if not isinstance(data, dict):
        raise FrontmatterError("フロントマターはマッピング（key: value）形式である必要があります")

    # Pydanticモデルへの変換
    try:
        frontmatter = PRFrontmatter.model_validate(data)
    except ValidationError as e:
        # バリデーションエラーをわかりやすくフォーマット
        errors: list[str] = []
        for error in e.errors():
            field = ".".join(str(loc) for loc in error["loc"])
            msg = error["msg"]
            errors.append(f"  - {field}: {msg}")
        error_detail = "\n".join(errors)
        raise FrontmatterError(f"バリデーションエラー:\n{error_detail}") from e

    return ParsedPR(frontmatter=frontmatter, body=body)


def parse_pr_file(path: Path | str) -> ParsedPR:
    """PRファイルからフロントマターをパース

    Args:
        path: Markdownファイルのパス

    Returns:
        ParsedPRオブジェクト

    Raises:
        FrontmatterError: ファイルが見つからない場合、またはパースエラー時
    """
    path = Path(path)

    if not path.exists():
        raise FrontmatterError(f"ファイルが見つかりません: {path}")

    content = path.read_text(encoding="utf-8")
    return parse_pr_content(content)


# モジュールエクスポート

__all__ = [
    # Types
    "IssueType",
    "IssueTemplateType",
    "CommentTemplate",
    # Models
    "IssueFrontmatter",
    "ParsedIssue",
    "CommentFrontmatter",
    "ParsedComment",
    "PRFrontmatter",
    "ParsedPR",
    # Exceptions
    "FrontmatterError",
    # Functions
    "parse_frontmatter",
    "parse_issue_file",
    "parse_comment_content",
    "parse_comment_file",
    "parse_pr_content",
    "parse_pr_file",
    "strip_frontmatter",
    "strip_leading_html_comment",
]
