"""tests/core/test_frontmatter.py - フロントマターパーサーのテスト

TDDで開発するため、まずテストを定義する。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from pathlib import Path


class TestIssueFrontmatterModel:
    """IssueFrontmatterモデルのテスト"""

    def test_minimal_frontmatter(self) -> None:
        """最小限のフィールドでインスタンス化できる"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="テスト機能の実装",
            type="task",
            repository="owner/repo",
            status="ready",
        )
        assert fm.title == "テスト機能の実装"
        assert fm.type == "task"
        assert fm.repository == "owner/repo"
        assert fm.status == "ready"
        assert fm.labels == []
        assert fm.parent_epic is None

    def test_full_frontmatter(self) -> None:
        """すべてのフィールドを持つインスタンス"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="バグ修正",
            type="bug",
            repository="owner/repo",
            status="active",
            priority="high",
            size="m",
            labels=["bug", "urgent"],
            parent_epic=123,
            order=1,
        )
        assert fm.title == "バグ修正"
        assert fm.type == "bug"
        assert fm.status == "active"
        assert fm.priority == "high"
        assert fm.size == "m"
        assert fm.labels == ["bug", "urgent"]
        assert fm.parent_epic == 123
        assert fm.order == 1

    def test_invalid_type_raises_error(self) -> None:
        """無効なtypeはエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import IssueFrontmatter

        with pytest.raises(ValidationError):
            IssueFrontmatter(
                title="テスト",
                type="invalid",  # type: ignore[arg-type]
                repository="owner/repo",
                status="ready",
            )

    def test_invalid_status_raises_error(self) -> None:
        """無効なstatusはエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import IssueFrontmatter

        with pytest.raises(ValidationError):
            IssueFrontmatter(
                title="テスト",
                type="task",
                repository="owner/repo",
                status="invalid",  # type: ignore[arg-type]
            )

    def test_empty_string_fields_converted_to_none(self) -> None:
        """空文字列フィールドはNoneに変換される"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="テスト",
            type="task",
            repository="owner/repo",
            status="ready",
            priority="",
            size="",
            parent_epic="",
            order="",
        )
        assert fm.priority is None
        assert fm.size is None
        assert fm.parent_epic is None
        assert fm.order is None

    def test_parent_epic_with_order(self) -> None:
        """parent_epicとorderの両方が指定されている場合は正常"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="タスク",
            type="task",
            repository="owner/repo",
            status="ready",
            parent_epic=353,
            order=1,
        )
        assert fm.parent_epic == 353
        assert fm.order == 1

    def test_parallel_valid_letter(self) -> None:
        """parallel は a〜z の 1 文字を受け付ける"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="タスク",
            type="task",
            repository="owner/repo",
            status="ready",
            parent_epic=353,
            order=4,
            parallel="b",
        )
        assert fm.parallel == "b"

    def test_parallel_empty_string_is_none(self) -> None:
        """parallel の空文字は None"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="タスク",
            type="task",
            repository="owner/repo",
            status="ready",
            parent_epic=353,
            order=4,
            parallel="",
        )
        assert fm.parallel is None

    @pytest.mark.parametrize("value", ["A", "ab", "1", "-", " "])
    def test_parallel_invalid_value_raises_error(self, value: str) -> None:
        """大文字・2 文字・数字などは拒否する"""
        from pydantic import ValidationError

        from cli.core.frontmatter import IssueFrontmatter

        with pytest.raises(ValidationError, match="parallel"):
            IssueFrontmatter(
                title="タスク",
                type="task",
                repository="owner/repo",
                status="ready",
                parent_epic=353,
                order=4,
                parallel=value,
            )

    def test_parallel_without_order_raises_error(self) -> None:
        """order なしの parallel は拒否する"""
        from pydantic import ValidationError

        from cli.core.frontmatter import IssueFrontmatter

        with pytest.raises(ValidationError, match="parallelを指定する場合"):
            IssueFrontmatter(
                title="タスク",
                type="task",
                repository="owner/repo",
                status="ready",
                parallel="a",
            )

    def test_parent_epic_without_order_raises_error(self) -> None:
        """parent_epic指定時にorderがないとエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import IssueFrontmatter

        with pytest.raises(ValidationError, match="orderは必須です"):
            IssueFrontmatter(
                title="タスク",
                type="task",
                repository="owner/repo",
                status="ready",
                parent_epic=353,
            )

    def test_order_without_parent_epic_raises_error(self) -> None:
        """order指定時にparent_epicがないとエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import IssueFrontmatter

        with pytest.raises(ValidationError, match="parent_epicも指定してください"):
            IssueFrontmatter(
                title="タスク",
                type="task",
                repository="owner/repo",
                status="ready",
                order=1,
            )

    def test_order_zero_raises_error(self) -> None:
        """orderが0の場合はエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import IssueFrontmatter

        with pytest.raises(ValidationError, match="1以上の整数"):
            IssueFrontmatter(
                title="タスク",
                type="task",
                repository="owner/repo",
                status="ready",
                parent_epic=353,
                order=0,
            )

    def test_order_negative_raises_error(self) -> None:
        """orderが負の場合はエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import IssueFrontmatter

        with pytest.raises(ValidationError, match="1以上の整数"):
            IssueFrontmatter(
                title="タスク",
                type="task",
                repository="owner/repo",
                status="ready",
                parent_epic=353,
                order=-1,
            )

    def test_parent_epic_cross_repo_string(self) -> None:
        """parent_epic に owner/repo/N 主軸形式を指定できる（str のまま保持）"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="サブタスク",
            type="task",
            repository="acme-labs/pecot-cli",
            status="ready",
            parent_epic="acme-labs/aist-roadmap/21",
            order=1,
        )
        assert fm.parent_epic == "acme-labs/aist-roadmap/21"
        assert fm.order == 1

    def test_parent_epic_numeric_string_normalized_to_int(self) -> None:
        """parent_epic の数字文字列は int に正規化される"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="タスク",
            type="task",
            repository="owner/repo",
            status="ready",
            parent_epic="21",
            order=1,
        )
        assert fm.parent_epic == 21
        assert isinstance(fm.parent_epic, int)

    def test_parent_epic_int_passthrough(self) -> None:
        """parent_epic の int はそのまま保持される"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="タスク",
            type="task",
            repository="owner/repo",
            status="ready",
            parent_epic=21,
            order=1,
        )
        assert fm.parent_epic == 21
        assert isinstance(fm.parent_epic, int)

    def test_template_default_none(self) -> None:
        """templateのデフォルトはNone"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="テスト",
            type="task",
            repository="owner/repo",
            status="ready",
        )
        assert fm.template is None

    def test_template_task_implement(self) -> None:
        """template=task-implementが有効"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="フェーズ1",
            type="task",
            template="task-implement",
            repository="owner/repo",
            status="ready",
        )
        assert fm.template == "task-implement"

    def test_template_same_as_type(self) -> None:
        """templateがtypeと同じ値でも有効"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="タスク",
            type="task",
            template="task",
            repository="owner/repo",
            status="ready",
        )
        assert fm.template == "task"

    def test_template_invalid_raises_error(self) -> None:
        """無効なtemplateはエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import IssueFrontmatter

        with pytest.raises(ValidationError):
            IssueFrontmatter(
                title="テスト",
                type="task",
                template="invalid-template",  # type: ignore[arg-type]
                repository="owner/repo",
                status="ready",
            )

    def test_template_empty_string_converted_to_none(self) -> None:
        """空文字列のtemplateはNoneに変換される"""
        from cli.core.frontmatter import IssueFrontmatter

        fm = IssueFrontmatter(
            title="テスト",
            type="task",
            template="",  # type: ignore[arg-type]
            repository="owner/repo",
            status="ready",
        )
        assert fm.template is None


class TestParseFrontmatter:
    """parse_frontmatter関数のテスト"""

    def test_parse_simple_frontmatter(self) -> None:
        """シンプルなフロントマターをパース"""
        from cli.core.frontmatter import parse_frontmatter

        content = """---
title: テスト機能の実装
type: task
repository: owner/repo
status: ready
---

## 概要

これは本文です。
"""
        result = parse_frontmatter(content)
        assert result.frontmatter.title == "テスト機能の実装"
        assert result.frontmatter.type == "task"
        assert result.frontmatter.repository == "owner/repo"
        assert result.frontmatter.status == "ready"
        assert "## 概要" in result.body
        assert "これは本文です。" in result.body

    def test_parse_full_frontmatter(self) -> None:
        """フル構成のフロントマターをパース"""
        from cli.core.frontmatter import parse_frontmatter

        content = """---
title: Epic実装
type: epic
repository: org/project
status: backlog
priority: high
size: l
labels:
  - enhancement
  - epic
parent_epic: 42
order: 1
---

本文
"""
        result = parse_frontmatter(content)
        assert result.frontmatter.title == "Epic実装"
        assert result.frontmatter.type == "epic"
        assert result.frontmatter.status == "backlog"
        assert result.frontmatter.priority == "high"
        assert result.frontmatter.size == "l"
        assert result.frontmatter.labels == ["enhancement", "epic"]
        assert result.frontmatter.parent_epic == 42
        assert result.frontmatter.order == 1

    def test_parse_without_frontmatter(self) -> None:
        """フロントマターがない場合はエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_frontmatter

        content = """# タイトル

本文のみ
"""
        with pytest.raises(FrontmatterError, match="フロントマターが見つかりません"):
            parse_frontmatter(content)

    def test_parse_unclosed_frontmatter(self) -> None:
        """閉じられていないフロントマターはエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_frontmatter

        content = """---
title: テスト
type: task
repository: owner/repo

本文（閉じタグなし）
"""
        with pytest.raises(FrontmatterError, match="フロントマターが閉じられていません"):
            parse_frontmatter(content)

    def test_parse_invalid_yaml(self) -> None:
        """無効なYAMLはエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_frontmatter

        content = """---
title: テスト
type: epic: invalid
---

本文
"""
        with pytest.raises(FrontmatterError, match="YAMLのパースに失敗"):
            parse_frontmatter(content)

    def test_parse_missing_required_fields(self) -> None:
        """必須フィールドがない場合はエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_frontmatter

        content = """---
title: テスト
---

本文
"""
        with pytest.raises(FrontmatterError, match="バリデーションエラー"):
            parse_frontmatter(content)

    def test_parse_empty_string_parent_epic(self) -> None:
        """空文字列のparent_epicをパース"""
        from cli.core.frontmatter import parse_frontmatter

        content = """---
title: Epic実装
type: epic
repository: org/project
status: backlog
priority: ""
size: ""
parent_epic: ""
order: ""
---

Epic本文
"""
        result = parse_frontmatter(content)
        assert result.frontmatter.parent_epic is None
        assert result.frontmatter.priority is None
        assert result.frontmatter.size is None
        assert result.frontmatter.order is None

    def test_parse_frontmatter_with_template(self) -> None:
        """templateフィールド付きのフロントマターをパース"""
        from cli.core.frontmatter import parse_frontmatter

        content = """---
title: フェーズ1実装
type: task
template: task-implement
repository: owner/repo
status: ready
---

## タスク概要

フェーズ1の実装タスク
"""
        result = parse_frontmatter(content)
        assert result.frontmatter.template == "task-implement"
        assert result.frontmatter.type == "task"

    def test_parse_frontmatter_without_template(self) -> None:
        """templateフィールドなしのフロントマターをパース（後方互換性）"""
        from cli.core.frontmatter import parse_frontmatter

        content = """---
title: 通常タスク
type: task
repository: owner/repo
status: ready
---

## タスク概要

通常のタスク
"""
        result = parse_frontmatter(content)
        assert result.frontmatter.template is None


class TestParseIssueFile:
    """parse_issue_file関数のテスト"""

    def test_parse_file(self, tmp_path: Path) -> None:
        """ファイルからパース"""
        from cli.core.frontmatter import parse_issue_file

        file_path = tmp_path / "issue.md"
        file_path.write_text(
            """---
title: ファイルからのテスト
type: task
repository: owner/repo
status: ready
---

## タスク概要

ファイルから読み込んだ本文。
""",
            encoding="utf-8",
        )

        result = parse_issue_file(file_path)
        assert result.frontmatter.title == "ファイルからのテスト"
        assert result.frontmatter.type == "task"
        assert result.frontmatter.status == "ready"
        assert "## タスク概要" in result.body

    def test_parse_nonexistent_file(self, tmp_path: Path) -> None:
        """存在しないファイルはエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_issue_file

        with pytest.raises(FrontmatterError, match="ファイルが見つかりません"):
            parse_issue_file(tmp_path / "nonexistent.md")


class TestParsedIssue:
    """ParsedIssueモデルのテスト"""

    def test_body_stripped(self) -> None:
        """本文の前後の空白は除去される"""
        from cli.core.frontmatter import parse_frontmatter

        content = """---
title: テスト
type: task
repository: owner/repo
status: ready
---


   本文


"""
        result = parse_frontmatter(content)
        assert result.body == "本文"

    def test_empty_body(self) -> None:
        """本文が空でも動作する"""
        from cli.core.frontmatter import parse_frontmatter

        content = """---
title: テスト
type: task
repository: owner/repo
status: ready
---
"""
        result = parse_frontmatter(content)
        assert result.body == ""


# CommentFrontmatter テスト


class TestCommentFrontmatterModel:
    """CommentFrontmatterモデルのテスト"""

    def test_minimal_frontmatter(self) -> None:
        """最小限のフィールドでインスタンス化できる"""
        from cli.core.frontmatter import CommentFrontmatter

        fm = CommentFrontmatter(issue_ref="owner/repo/123")
        assert fm.issue_ref == "owner/repo/123"
        assert fm.template is None

    def test_full_frontmatter(self) -> None:
        """すべてのフィールドを持つインスタンス"""
        from cli.core.frontmatter import CommentFrontmatter

        fm = CommentFrontmatter(
            issue_ref="owner/repo/456",
            template="merge-diff",
        )
        assert fm.issue_ref == "owner/repo/456"
        assert fm.template == "merge-diff"

    def test_missing_issue_ref_raises_error(self) -> None:
        """issue_refがない場合はエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import CommentFrontmatter

        with pytest.raises(ValidationError):
            CommentFrontmatter()  # type: ignore[call-arg]


class TestParseCommentContent:
    """parse_comment_content関数のテスト"""

    def test_parse_simple_comment(self) -> None:
        """シンプルなコメントフロントマターをパース"""
        from cli.core.frontmatter import parse_comment_content

        content = """---
issue_ref: "owner/repo/123"
---

## 進捗報告

これは本文です。
"""
        result = parse_comment_content(content)
        assert result.frontmatter.issue_ref == "owner/repo/123"
        assert "## 進捗報告" in result.body
        assert "これは本文です。" in result.body

    def test_parse_full_comment(self) -> None:
        """フル構成のコメントフロントマターをパース"""
        from cli.core.frontmatter import parse_comment_content

        content = """---
issue_ref: "org/project/42"
template: merge-diff
---

### Completed

- タスク1
"""
        result = parse_comment_content(content)
        assert result.frontmatter.issue_ref == "org/project/42"
        assert result.frontmatter.template == "merge-diff"
        assert "### Completed" in result.body

    def test_parse_without_frontmatter(self) -> None:
        """フロントマターがない場合はエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_comment_content

        content = """# タイトル

本文のみ
"""
        with pytest.raises(FrontmatterError, match="フロントマターが見つかりません"):
            parse_comment_content(content)

    def test_parse_missing_issue_ref(self) -> None:
        """issue_refがない場合はエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_comment_content

        content = """---
template: merge-diff
---

本文
"""
        with pytest.raises(FrontmatterError, match="バリデーションエラー"):
            parse_comment_content(content)


class TestParseCommentFile:
    """parse_comment_file関数のテスト"""

    def test_parse_file(self, tmp_path: Path) -> None:
        """ファイルからパース"""
        from cli.core.frontmatter import parse_comment_file

        file_path = tmp_path / "comment.md"
        file_path.write_text(
            """---
issue_ref: "owner/repo/123"
template: merge-diff
---

## 進捗報告

ファイルから読み込んだ本文。
""",
            encoding="utf-8",
        )

        result = parse_comment_file(file_path)
        assert result.frontmatter.issue_ref == "owner/repo/123"
        assert result.frontmatter.template == "merge-diff"
        assert "## 進捗報告" in result.body

    def test_parse_nonexistent_file(self, tmp_path: Path) -> None:
        """存在しないファイルはエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_comment_file

        with pytest.raises(FrontmatterError, match="ファイルが見つかりません"):
            parse_comment_file(tmp_path / "nonexistent.md")


# PRFrontmatter テスト


class TestPRFrontmatterModel:
    """PRFrontmatterモデルのテスト"""

    def test_minimal_frontmatter(self) -> None:
        """最小限のフィールドでインスタンス化できる"""
        from cli.core.frontmatter import PRFrontmatter

        fm = PRFrontmatter(
            title="機能追加",
            repository="owner/repo",
            base="develop-aist",
        )
        assert fm.title == "機能追加"
        assert fm.repository == "owner/repo"
        assert fm.base == "develop-aist"
        assert fm.head is None
        assert fm.draft is False

    def test_full_frontmatter(self) -> None:
        """すべてのフィールドを持つインスタンス"""
        from cli.core.frontmatter import PRFrontmatter

        fm = PRFrontmatter(
            title="バグ修正PR",
            repository="org/project",
            base="develop",
            head="feat/issue-123-fix-bug",
            draft=True,
        )
        assert fm.title == "バグ修正PR"
        assert fm.repository == "org/project"
        assert fm.base == "develop"
        assert fm.head == "feat/issue-123-fix-bug"
        assert fm.draft is True

    def test_missing_title_raises_error(self) -> None:
        """titleがない場合はエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import PRFrontmatter

        with pytest.raises(ValidationError):
            PRFrontmatter(
                repository="owner/repo",
                base="develop",
            )  # type: ignore[call-arg]

    def test_missing_repository_raises_error(self) -> None:
        """repositoryがない場合はエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import PRFrontmatter

        with pytest.raises(ValidationError):
            PRFrontmatter(
                title="テストPR",
                base="develop",
            )  # type: ignore[call-arg]

    def test_missing_base_raises_error(self) -> None:
        """baseがない場合はエラー"""
        from pydantic import ValidationError

        from cli.core.frontmatter import PRFrontmatter

        with pytest.raises(ValidationError):
            PRFrontmatter(
                title="テストPR",
                repository="owner/repo",
            )  # type: ignore[call-arg]


class TestParsePRContent:
    """parse_pr_content関数のテスト"""

    def test_parse_simple_pr(self) -> None:
        """シンプルなPRフロントマターをパース"""
        from cli.core.frontmatter import parse_pr_content

        content = """---
title: "機能追加PR"
repository: "owner/repo"
base: "develop-aist"
---

## Changed — テスト用本文

- 機能Aを追加

Refs #123
"""
        result = parse_pr_content(content)
        assert result.frontmatter.title == "機能追加PR"
        assert result.frontmatter.repository == "owner/repo"
        assert result.frontmatter.base == "develop-aist"
        assert result.frontmatter.head is None
        assert result.frontmatter.draft is False
        assert "## Changed — テスト用本文" in result.body
        assert "Refs #123" in result.body

    def test_parse_full_pr(self) -> None:
        """フル構成のPRフロントマターをパース"""
        from cli.core.frontmatter import parse_pr_content

        content = """---
title: "バグ修正"
repository: "org/project"
base: "develop"
head: "fix/issue-456"
draft: true
---

## Changed — テスト用本文

- バグ修正
"""
        result = parse_pr_content(content)
        assert result.frontmatter.title == "バグ修正"
        assert result.frontmatter.repository == "org/project"
        assert result.frontmatter.base == "develop"
        assert result.frontmatter.head == "fix/issue-456"
        assert result.frontmatter.draft is True

    def test_parse_without_frontmatter(self) -> None:
        """フロントマターがない場合はエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_pr_content

        content = """# PR

本文のみ
"""
        with pytest.raises(FrontmatterError, match="フロントマターが見つかりません"):
            parse_pr_content(content)

    def test_parse_missing_title(self) -> None:
        """titleがない場合はエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_pr_content

        content = """---
repository: "owner/repo"
base: "develop"
---

本文
"""
        with pytest.raises(FrontmatterError, match="バリデーションエラー"):
            parse_pr_content(content)


class TestParsePRFile:
    """parse_pr_file関数のテスト"""

    def test_parse_file(self, tmp_path: Path) -> None:
        """ファイルからパース"""
        from cli.core.frontmatter import parse_pr_file

        file_path = tmp_path / "pr.md"
        file_path.write_text(
            """---
title: "ファイルからのPR"
repository: "owner/repo"
base: "develop-aist"
head: "feat/test"
---

## Changed — テスト用本文

ファイルから読み込んだ本文。

Refs #42
""",
            encoding="utf-8",
        )

        result = parse_pr_file(file_path)
        assert result.frontmatter.title == "ファイルからのPR"
        assert result.frontmatter.repository == "owner/repo"
        assert result.frontmatter.base == "develop-aist"
        assert result.frontmatter.head == "feat/test"
        assert "## Changed — テスト用本文" in result.body
        assert "Refs #42" in result.body

    def test_parse_nonexistent_file(self, tmp_path: Path) -> None:
        """存在しないファイルはエラー"""
        from cli.core.frontmatter import FrontmatterError, parse_pr_file

        with pytest.raises(FrontmatterError, match="ファイルが見つかりません"):
            parse_pr_file(tmp_path / "nonexistent.md")


class TestStripLeadingHtmlComment:
    """冒頭ガイドコメント除去（#958 F-02）"""

    def test_leading_comment_and_surrounding_blank_lines_removed(self) -> None:
        from cli.core.frontmatter import strip_leading_html_comment

        body = "\n<!--\n読者: だれか\n書き方:\n- なにか\n-->\n\n## Goal — 目標\n\n本文\n"
        assert strip_leading_html_comment(body) == "## Goal — 目標\n\n本文\n"

    def test_only_first_block_removed(self) -> None:
        """先頭の 1 ブロックだけ落とす（本文途中の HTML には触れない）"""
        from cli.core.frontmatter import strip_leading_html_comment

        body = "<!-- guide -->\n\n## Goal — 目標\n\n<!-- 本文中のメモ -->\n"
        assert strip_leading_html_comment(body) == "## Goal — 目標\n\n<!-- 本文中のメモ -->\n"

    def test_body_without_leading_comment_is_unchanged(self) -> None:
        from cli.core.frontmatter import strip_leading_html_comment

        body = "## Goal — 目標\n\n<details><summary>log</summary>x</details>\n"
        assert strip_leading_html_comment(body) == body

    def test_parse_issue_drops_leading_comment(self) -> None:
        from cli.core.frontmatter import parse_frontmatter

        content = (
            "---\n"
            'title: "T"\n'
            "type: task\n"
            'repository: "owner/repo"\n'
            "status: ready\n"
            "---\n\n"
            "<!--\n読者: 実装者\n-->\n\n"
            "## Goal — 目標\n"
        )
        assert parse_frontmatter(content).body == "## Goal — 目標"

    def test_parse_comment_drops_leading_comment(self) -> None:
        from cli.core.frontmatter import parse_comment_content

        content = (
            "---\n"
            'issue_ref: "owner/repo/1"\n'
            "template: merge-diff\n"
            "---\n\n"
            "<!--\n書き方: なにか\n-->\n\n"
            "## Progress — 現在地\n"
        )
        assert parse_comment_content(content).body == "## Progress — 現在地"

    def test_parse_pr_drops_leading_comment(self) -> None:
        from cli.core.frontmatter import parse_pr_content

        content = (
            "---\n"
            'title: "T"\n'
            'repository: "owner/repo"\n'
            'base: "main"\n'
            "---\n\n"
            "<!--\nフィールド: なにか\n-->\n\n"
            "## Verified — 検証済み\n"
        )
        assert parse_pr_content(content).body == "## Verified — 検証済み"


class TestStripFrontmatter:
    """frontmatter 除去ヘルパ"""

    def test_frontmatter_removed(self) -> None:
        from cli.core.frontmatter import strip_frontmatter

        content = "---\ntitle: x\n---\n\n## Goal — 目標\n"
        assert strip_frontmatter(content) == "## Goal — 目標\n"

    def test_no_frontmatter_returns_original(self) -> None:
        from cli.core.frontmatter import strip_frontmatter

        content = "## Goal — 目標\n"
        assert strip_frontmatter(content) == content


class TestSetFrontmatterValue:
    """set_frontmatter_value: フロントマターの 1 キーを足す・置き換える"""

    def test_appends_new_key_and_keeps_body(self) -> None:
        from cli.core.frontmatter import set_frontmatter_value

        content = '---\nissue_ref: "o/r/1"\n---\n\n## Plan\n'
        assert set_frontmatter_value(content, "comment_url", "https://x/1") == (
            '---\nissue_ref: "o/r/1"\ncomment_url: "https://x/1"\n---\n\n## Plan\n'
        )

    def test_replaces_existing_key(self) -> None:
        from cli.core.frontmatter import set_frontmatter_value

        content = '---\ncomment_url: "old"\nissue_ref: "o/r/1"\n---\nbody\n'
        assert set_frontmatter_value(content, "comment_url", "new") == (
            '---\ncomment_url: "new"\nissue_ref: "o/r/1"\n---\nbody\n'
        )

    def test_no_frontmatter_raises(self) -> None:
        import pytest

        from cli.core.frontmatter import FrontmatterError, set_frontmatter_value

        with pytest.raises(FrontmatterError):
            set_frontmatter_value("## Plan\n", "comment_url", "x")
