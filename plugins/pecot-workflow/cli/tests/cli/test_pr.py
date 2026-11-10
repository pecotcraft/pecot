"""tests/cli/test_pr.py - pr.pyのCLIテスト

pr create, pr read コマンドのテスト。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import typer
from typer.testing import CliRunner

from cli.commands._output import Output
from cli.commands.main import app
from cli.commands.pr import (
    SCREENSHOT_MISSING_ERROR,
    _append_issue_close_if_needed,
    _exit_on_unset_branch,
    _is_missing_ref_error,
    _update_issue_status_to_in_review,
    _validate_issue_reference,
    _validate_pr_content,
    extract_issue_number_from_branch,
)
from cli.core.config import (
    FieldOptions,
    Project,
    ProjectConfig,
    ProjectFields,
    Repository,
)
from cli.core.nx_scope import NxProject

runner = CliRunner()

# Summary に置く画像の行（日本語を含まない）
_IMG_LINE = '<img src="./x.png">'


# parse_pr_ref テストは tests/core/test_ref_parser.py に移動


# バリデーション関数テスト


class TestValidateIssueReference:
    """_validate_issue_reference 関数のテスト"""

    def test_refs_format(self) -> None:
        """Refs #XXX 形式を検出"""
        assert _validate_issue_reference("本文 Refs #123 を参照") is True

    def test_hash_only(self) -> None:
        """#XXX 形式を検出"""
        assert _validate_issue_reference("本文 #456 を参照") is True

    def test_owner_repo_hash(self) -> None:
        """owner/repo#XXX 形式を検出"""
        assert _validate_issue_reference("本文 owner/repo#789 を参照") is True

    def test_no_reference(self) -> None:
        """Issue参照なしはFalse"""
        assert _validate_issue_reference("本文のみ") is False

    def test_url_fragment_not_matched(self) -> None:
        """URL内の#fragmentは検出しない"""
        # URL内の#はIssue参照ではないが、別の#123があれば検出する
        assert _validate_issue_reference("https://example.com/page#section #123") is True
        # URL内の#のみの場合
        body = "https://example.com/page#section"
        # これはURL内のフラグメントなのでマッチしないはず
        # しかし現在のパターンではマッチしてしまう可能性があるのでテスト
        # 実際のパターンは (^|[^/])#[0-9]+ のため、/# にはマッチしない
        assert _validate_issue_reference(body) is False


class TestValidatePRContent:
    """_validate_pr_content 関数のテスト"""

    def test_valid_content(self) -> None:
        """有効なPR内容"""
        body = f"""
## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文

- テスト
- テスト
- テスト
- テスト
- テスト

## Risks — なし

- なし

Refs #123
"""
        errors = _validate_pr_content(body, "タイトル", "develop-aist", "develop-aist")
        assert errors == []

    def test_missing_heading_is_reported_by_its_name(self) -> None:
        """PR テンプレの見出しは名前だけなので、不足は名前で返り、見出しの後ろの文は問わない"""
        body = f"## Summary\n\n{_IMG_LINE}\n\n## Changes\n\nなし\n\n## Verified\n\n- pytest\n\nRefs #123\n"
        errors = _validate_pr_content(body, "タイトル", "develop-aist", "develop-aist")
        assert errors == ["missing sections: ## Risks"]

    def test_missing_issue_reference_names_the_exemption(self) -> None:
        """Issue 参照なしのエラー文は免除手段（--no-issue-ref）を示す"""
        body = (
            f"## Summary — 検証を追加\n\n{_IMG_LINE}\n\n"
            "## Changes\n\nなし\n\n"
            "## Verified — テスト通過\n\n- pytest\n\n"
            "## Risks — なし\n\n- なし\n"
        )
        errors = _validate_pr_content(body, "タイトル", "develop-aist", "develop-aist")
        assert errors == [
            "PR body has no Issue reference `#N` (use `--no-issue-ref` for a PR not tied to an Issue)"
        ]

    def test_missing_issue_reference(self) -> None:
        """Issue参照なしでエラー"""
        body = """
## Verified — テスト用本文

- テスト
- テスト
- テスト
- テスト
- テスト

## Risks — なし

- なし
"""
        errors = _validate_pr_content(body, "タイトル", "develop-aist", "develop-aist")
        assert any("no Issue reference `#N`" in e for e in errors)

    def test_base_branch_restriction(self) -> None:
        """mainブランチへの直接PRはエラー"""
        body = """
## Verified — テスト用本文

- テスト
- テスト
- テスト
- テスト
- テスト

## Risks — なし

- なし

Refs #123
"""
        errors = _validate_pr_content(body, "タイトル", "main", "develop-aist")
        assert any("base branch must be" in e for e in errors)

    def test_base_branch_error_when_no_develop(self, capsys: pytest.CaptureFixture[str]) -> None:
        """開発ブランチ未設定時は検証の前に exit 1 で止め、設定を誘導する"""
        with pytest.raises(typer.Exit) as exc:
            _exit_on_unset_branch("default", "main", None, None, None, Output(False))
        assert exc.value.exit_code == 1
        err = capsys.readouterr().err
        assert "develop_branch is not set" in err
        assert "project set-repo" in err

    def test_set_branches_do_not_exit(self) -> None:
        """ブランチが設定されていれば止めない"""
        _exit_on_unset_branch("default", "main", None, "develop", None, Output(False))
        _exit_on_unset_branch("release", "main", None, None, "main", Output(False))


# pr create --prepare コマンドテスト


class TestPRCreatePrepareCommand:
    """pr create --prepare コマンドのテスト"""

    def test_prepare_success(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """テンプレートを準備"""
        import cli.commands.pr as pr_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(pr_module, "get_output_dir", lambda: output_dir)
        monkeypatch.setattr(pr_module, "load_active_config", lambda: None)

        result = runner.invoke(app, ["pr", "create", "--prepare"])

        assert result.exit_code == 0
        assert "pr-create-" in result.output
        files = list(output_dir.glob("pr-create-*.md"))
        assert len(files) == 1
        content = files[0].read_text()
        assert "title:" in content
        assert "repository:" in content
        assert "base:" in content

    def test_prepare_short_option(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """短縮オプション -p が動作する"""
        import cli.commands.pr as pr_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(pr_module, "get_output_dir", lambda: output_dir)
        monkeypatch.setattr(pr_module, "load_active_config", lambda: None)

        result = runner.invoke(app, ["pr", "create", "-p"])

        assert result.exit_code == 0
        assert "pr-create-" in result.output

    @pytest.mark.parametrize(
        ("template_args", "prefix"),
        [
            pytest.param([], "pr-create", id="default"),
            pytest.param(["--template", "release"], "pr-release", id="release"),
        ],
    )
    def test_prepare_same_second_creates_distinct_files(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        template_args: list[str],
        prefix: str,
    ) -> None:
        """同一秒に 2 回実行しても上書きせず別ファイルになる（default / release の両方）"""
        from datetime import datetime as real_datetime

        import cli.commands.pr as pr_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(pr_module, "get_output_dir", lambda: output_dir)
        monkeypatch.setattr(pr_module, "load_active_config", lambda: None)
        fake_dt = MagicMock()
        fake_dt.now.return_value = real_datetime(2026, 5, 13, 10, 0, 0)

        argv = ["pr", "create", "--prepare", *template_args]
        with patch("cli.core.paths.datetime", fake_dt):
            result1 = runner.invoke(app, argv)
            result2 = runner.invoke(app, argv)

        assert result1.exit_code == 0, result1.output
        assert result2.exit_code == 0, result2.output
        first = Path(result1.stdout.strip().splitlines()[-1])
        second = Path(result2.stdout.strip().splitlines()[-1])
        assert first.name == f"{prefix}-20260513-100000.md"
        assert second.name == f"{prefix}-20260513-100001.md"

        files = sorted(output_dir.glob(f"{prefix}-*.md"))
        assert len(files) == 2
        for file in files:
            assert "title:" in file.read_text(encoding="utf-8")

    def test_prepare_reservation_error_exits_one(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """出力パス予約に失敗すると exit 1 で例外メッセージを表示する"""
        import cli.commands.pr as pr_module
        from cli.core.paths import OutputPathReservationError

        message = "出力パスを予約できませんでした（候補を使い切りました）"
        monkeypatch.setattr(pr_module, "get_output_dir", lambda: tmp_path / "pecot")
        monkeypatch.setattr(pr_module, "load_active_config", lambda: None)

        def _raise(*_args: object, **_kwargs: object) -> object:
            raise OutputPathReservationError(message)

        monkeypatch.setattr(pr_module, "reserved_output_path", _raise)

        result = runner.invoke(app, ["pr", "create", "--prepare"])

        assert result.exit_code == 1
        assert f"error: {message}" in result.output
        assert not (tmp_path / "pecot").exists()

    def test_no_args_shows_error(self) -> None:
        """引数なしでエラーメッセージを表示"""
        result = runner.invoke(app, ["pr", "create"])

        assert result.exit_code == 1
        assert "error: missing arguments" in result.output


# pr create ファイルからの作成テスト


class TestPRCreateFromFileCommand:
    """pr create (ファイルから) コマンドのテスト"""

    def test_create_success(self, tmp_path: Path) -> None:
        """正常系: ファイルからPR作成（ブランチ名からIssue参照を自動追加）"""
        pr_file = tmp_path / "pr.md"
        pr_file.write_text(
            f"""---
title: "feat: テスト機能追加"
repository: "owner/repo"
base: "develop-aist"
head: "feat/test/123"
draft: false
---

## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文

- テスト追加
- テストのため
- 特になし
- なし
- テスト実行

## Risks — なし

- なし
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.develop_branch = "develop-aist"
        mock_config.repositories = []
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = None

        mock_client = MagicMock()
        mock_client.create_pull_request.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/pull/456",
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr._run_preflight_checks_or_exit"),
        ):
            result = runner.invoke(app, ["pr", "create", str(pr_file)])
            assert result.exit_code == 0
            assert result.stdout == "https://ghes.example.com/owner/repo/pull/456\n"
            assert "https://ghes.example.com/owner/repo/pull/456" in result.output

            # API呼び出し確認
            mock_client.create_pull_request.assert_called_once()
            call_kwargs = mock_client.create_pull_request.call_args[1]
            assert call_kwargs["owner"] == "owner"
            assert call_kwargs["repo"] == "repo"
            assert call_kwargs["title"] == "feat: テスト機能追加"
            assert call_kwargs["head"] == "feat/test/123"
            assert call_kwargs["base"] == "develop-aist"
            assert call_kwargs["draft"] is False
            assert "## Verified — テスト用本文" in call_kwargs["body"]
            # Issue参照が自動追加される（Closes形式）
            assert "Closes #123" in call_kwargs["body"]

    def test_create_dry_run(self, tmp_path: Path) -> None:
        """dry-run モード"""
        pr_file = tmp_path / "pr.md"
        pr_file.write_text(
            f"""---
title: "feat: テスト機能追加"
repository: "owner/repo"
base: "develop-aist"
head: "feat/test/123"
draft: false
---

## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文

- テスト追加
- テストのため
- 特になし
- なし
- テスト実行

## Risks — なし

- なし
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.develop_branch = "develop-aist"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = None

        with patch("cli.commands.pr.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["pr", "create", str(pr_file), "--dry-run"])
            assert result.exit_code == 0
            assert "dry-run: would create PR" in result.stderr
            assert "dry-run" in result.output

    def test_create_from_file_requires_issue_ref_when_branch_has_no_number(
        self, tmp_path: Path
    ) -> None:
        """ブランチ名から番号を補えなくても本文の Issue 参照を要求する（免除は --no-issue-ref のみ）"""
        pr_file = tmp_path / "pr.md"
        pr_file.write_text(
            f"""---
title: "feat: テスト機能追加"
repository: "owner/repo"
base: "develop-aist"
head: "feat/no-number"
draft: false
---

## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文

- テスト実行

## Risks — なし

- なし
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.develop_branch = "develop-aist"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = None

        with patch("cli.commands.pr.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["pr", "create", str(pr_file), "--dry-run"])
            assert result.exit_code == 3
            assert "no Issue reference `#N`" in result.output
            assert "`--no-issue-ref`" in result.output

            result = runner.invoke(
                app, ["pr", "create", str(pr_file), "--dry-run", "--no-issue-ref"]
            )
            assert result.exit_code == 0
            assert "dry-run: would create PR" in result.stderr

    def test_create_validation_error(self, tmp_path: Path) -> None:
        """バリデーションエラー"""
        pr_file = tmp_path / "pr.md"
        pr_file.write_text(
            """---
title: "feat: テスト機能追加"
repository: "owner/repo"
base: "develop-aist"
head: "feat/test"
---

## Verified — テスト用本文

- テスト（Issue参照なし、必須セクション不足）
""",
            encoding="utf-8",
        )

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.develop_branch = "develop-aist"

        with patch("cli.commands.pr.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["pr", "create", str(pr_file)])
            assert result.exit_code == 3
            assert "error: " in result.stderr

    def test_create_no_active_config(self, tmp_path: Path) -> None:
        """アクティブ設定がない場合はエラー"""
        pr_file = tmp_path / "pr.md"
        pr_file.write_text(
            """---
title: "test"
repository: "owner/repo"
base: "develop-aist"
---

body
""",
            encoding="utf-8",
        )

        with patch("cli.commands.pr.load_active_config", return_value=None):
            result = runner.invoke(app, ["pr", "create", str(pr_file)])
            assert result.exit_code == 1
            assert "error: no active project" in result.stderr


# pr create -m オプションテスト


class TestPRCreateDirectCommand:
    """pr create -m オプションのテスト"""

    def test_create_direct_success(self) -> None:
        """正常系: -m オプションでPR作成（ブランチ名からIssue参照を自動追加）"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.develop_branch = "develop-aist"
        mock_config.repositories = [MagicMock(owner="owner", name="repo")]
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = None

        mock_client = MagicMock()
        mock_client.create_pull_request.return_value = {
            "number": 789,
            "html_url": "https://ghes.example.com/owner/repo/pull/789",
        }

        body = f"""## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文
- テスト
- テスト
- なし
- なし
- テスト

## Risks — なし

- なし"""

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
            patch("cli.commands.pr._run_preflight_checks_or_exit"),
        ):
            result = runner.invoke(
                app,
                ["pr", "create", "-m", body, "-t", "feat: テスト", "-b", "develop-aist"],
            )
            assert result.exit_code == 0
            assert result.stdout == "https://ghes.example.com/owner/repo/pull/789\n"

            # Issue参照が自動追加される（Closes形式）
            call_kwargs = mock_client.create_pull_request.call_args[1]
            assert "Closes #123" in call_kwargs["body"]

    def test_create_direct_missing_title(self) -> None:
        """-m 使用時に -t がないとエラー"""
        result = runner.invoke(
            app,
            ["pr", "create", "-m", "本文", "-b", "develop-aist"],
        )
        assert result.exit_code == 1
        assert "-t (title)" in result.stderr

    def test_create_direct_missing_base(self) -> None:
        """-m 使用時に -b がないとエラー"""
        result = runner.invoke(
            app,
            ["pr", "create", "-m", "本文", "-t", "タイトル"],
        )
        assert result.exit_code == 1
        assert "-b (base branch)" in result.stderr

    def test_create_direct_dry_run(self) -> None:
        """dry-run モード"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.develop_branch = "develop-aist"
        mock_config.repositories = [MagicMock(owner="owner", name="repo")]
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = None

        body = f"""## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文

- テスト
- テスト
- なし
- なし
- テスト

## Risks — なし

- なし"""

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
        ):
            result = runner.invoke(
                app,
                [
                    "pr",
                    "create",
                    "-m",
                    body,
                    "-t",
                    "feat: テスト",
                    "-b",
                    "develop-aist",
                    "--dry-run",
                ],
            )
            assert result.exit_code == 0
            assert "dry-run: would create PR" in result.stderr


# pr read コマンドテスト


class TestPRReadCommand:
    """pr read コマンドのテスト"""

    def test_read_basic(self) -> None:
        """正常系: 基本的なPR読み取り"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 456,
            "state": "OPEN",
            "title": "feat: テスト機能追加",
            "body": "## Verified — テスト用本文\n\nテスト",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 2,
            "closing_issues": [],
            "reviews": [],
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "read", "owner/repo/456"])
            assert result.exit_code == 0
            assert "#456" in result.output
            assert "feat: テスト機能追加" in result.output
            assert "OPEN" in result.output

    def test_read_with_closing_issues(self) -> None:
        """正常系: 関連Issue付きのPR"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 456,
            "state": "OPEN",
            "title": "feat: テスト",
            "body": "本文",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [
                {"number": 123, "title": "[Task] タスク1"},
                {"number": 124, "title": "[Task] タスク2"},
            ],
            "reviews": [],
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "read", "owner/repo/456"])
            assert result.exit_code == 0
            assert "#123" in result.output
            assert "#124" in result.output

    def test_read_with_referenced_issues(self) -> None:
        """正常系: Referenced Issues（Refs #XXX）付きのPR"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 456,
            "state": "OPEN",
            "title": "feat: テスト",
            "body": "本文\n\nRefs #935",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "referenced_issues": [{"number": 935, "title": ""}],
            "reviews": [],
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "read", "owner/repo/456"])
            assert result.exit_code == 0
            assert "Referenced Issues:" in result.output
            assert "#935" in result.output

    def test_read_with_reviews(self) -> None:
        """正常系: レビュー付きのPR"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 456,
            "state": "OPEN",
            "title": "feat: テスト",
            "body": "本文",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [
                {"author": "reviewer1", "state": "APPROVED"},
                {"author": "reviewer2", "state": "CHANGES_REQUESTED"},
            ],
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "read", "owner/repo/456"])
            assert result.exit_code == 0
            assert "reviewer1" in result.output
            assert "APPROVED" in result.output

    def test_read_json_output(self) -> None:
        """正常系: JSON形式出力"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 456,
            "state": "OPEN",
            "title": "feat: テスト",
            "body": "本文",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "read", "owner/repo/456", "--json"])
            assert result.exit_code == 0
            import json

            data = json.loads(result.output)
            assert data["number"] == 456
            assert data["state"] == "OPEN"

    def test_read_no_active_config(self) -> None:
        """異常系: アクティブ設定がない場合はエラー"""
        with patch("cli.commands.pr.load_active_config", return_value=None):
            result = runner.invoke(app, ["pr", "read", "owner/repo/456"])
            assert result.exit_code == 1
            assert "error: no active project" in result.stderr

    def test_read_invalid_pr_ref(self) -> None:
        """異常系: 不正なpr_ref形式はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.pr.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["pr", "read", "invalid-format"])
            assert result.exit_code == 2
            assert "invalid reference" in result.output

    def test_read_pr_not_found(self) -> None:
        """異常系: PRが見つからない場合"""
        from cli.core.github import GitHubNotFoundError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.side_effect = GitHubNotFoundError(
            "PRが見つかりません: owner/repo/999"
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "read", "owner/repo/999"])
            assert result.exit_code == 1
            assert "見つかりません" in result.output

    def test_read_with_reviews_option(self) -> None:
        """正常系: --reviews オプションでレビュー詳細を取得"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_with_reviews.return_value = {
            "number": 456,
            "state": "OPEN",
            "title": "feat: テスト機能追加",
            "body": "## Verified — テスト用本文\n\nテスト",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 2,
            "closing_issues": [
                {"number": 123, "title": "[Task] タスク1"},
            ],
            "reviews": [
                {
                    "state": "APPROVED",
                    "author": "reviewer1",
                    "body": "LGTM 良い変更です。",
                    "submitted_at": "2026-02-01T10:00:00Z",
                },
                {
                    "state": "COMMENTED",
                    "author": "bot",
                    "body": "自動チェック完了",
                    "submitted_at": "2026-02-01T09:00:00Z",
                },
            ],
            "review_threads": [
                {
                    "is_resolved": False,
                    "path": "src/main.py",
                    "line": 42,
                    "comments": [
                        {
                            "author": "reviewer1",
                            "body": "この行の処理を確認してください",
                            "created_at": "2026-02-01T10:30:00Z",
                        },
                    ],
                },
            ],
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "read", "owner/repo/456", "--reviews"])
            assert result.exit_code == 0
            # get_pull_request_with_reviews が呼ばれたことを確認
            mock_client.get_pull_request_with_reviews.assert_called_once_with("owner", "repo", 456)
            # レビュー情報が出力されていることを確認
            assert "## Reviews" in result.output
            assert "@reviewer1" in result.output
            assert "APPROVED" in result.output
            assert "LGTM" in result.output
            # 行コメントが出力されていることを確認
            assert "## Line Comments" in result.output
            assert "src/main.py:42" in result.output
            assert "この行の処理を確認してください" in result.output
            # 関連Issue確認コマンドが出力されていることを確認
            assert "pecot issue read" in result.output

    def test_read_with_reviews_json_output(self) -> None:
        """正常系: --reviews --json でJSON形式出力"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_with_reviews.return_value = {
            "number": 456,
            "state": "OPEN",
            "title": "feat: テスト",
            "body": "本文",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [
                {
                    "state": "APPROVED",
                    "author": "reviewer1",
                    "body": "LGTM",
                    "submitted_at": "2026-02-01T10:00:00Z",
                },
            ],
            "review_threads": [],
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "read", "owner/repo/456", "--reviews", "--json"])
            assert result.exit_code == 0
            import json

            data = json.loads(result.output)
            assert data["number"] == 456
            assert "reviews" in data
            assert data["reviews"][0]["body"] == "LGTM"
            assert "review_threads" in data

    def test_read_with_reviews_empty_reviews(self) -> None:
        """正常系: --reviews でレビューがない場合"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_with_reviews.return_value = {
            "number": 456,
            "state": "OPEN",
            "title": "feat: テスト",
            "body": "本文",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
            "review_threads": [],
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "read", "owner/repo/456", "--reviews"])
            assert result.exit_code == 0
            # レビューセクションは表示されない
            assert "## Reviews" not in result.output
            assert "## Line Comments" not in result.output


# ヘルプ表示テスト


class TestPRCommandsHelp:
    """PR系コマンドのヘルプ表示テスト"""

    def test_pr_help(self) -> None:
        """pr --help"""
        result = runner.invoke(app, ["pr", "--help"])
        assert result.exit_code == 0
        assert "create" in result.output
        assert "read" in result.output

    def test_pr_create_help(self) -> None:
        """pr create --help"""
        result = runner.invoke(app, ["pr", "create", "--help"])
        assert result.exit_code == 0
        assert "--prepare" in result.output or "prepare" in result.output.lower()
        assert "--message" in result.output or "-m" in result.output

    def test_pr_read_help(self) -> None:
        """pr read --help"""
        result = runner.invoke(app, ["pr", "read", "--help"])
        assert result.exit_code == 0
        assert "--json" in result.output or "json" in result.output.lower()


# _extract_closing_issue_numbers 関数テスト


class TestExtractClosingIssueNumbers:
    """_extract_closing_issue_numbers 関数のテスト"""

    def test_extract_closes(self) -> None:
        """Closes #XXX パターンを検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("This PR Closes #123")
        assert result == [123]

    def test_extract_close(self) -> None:
        """Close #XXX パターンを検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Close #456")
        assert result == [456]

    def test_extract_closed(self) -> None:
        """Closed #XXX パターンを検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Closed #789")
        assert result == [789]

    def test_extract_fixes(self) -> None:
        """Fixes #XXX パターンを検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Fixes #100")
        assert result == [100]

    def test_extract_fix(self) -> None:
        """Fix #XXX パターンを検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Fix #200")
        assert result == [200]

    def test_extract_fixed(self) -> None:
        """Fixed #XXX パターンを検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Fixed #300")
        assert result == [300]

    def test_extract_resolves(self) -> None:
        """Resolves #XXX パターンを検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Resolves #400")
        assert result == [400]

    def test_extract_resolve(self) -> None:
        """Resolve #XXX パターンを検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Resolve #500")
        assert result == [500]

    def test_extract_resolved(self) -> None:
        """Resolved #XXX パターンを検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Resolved #600")
        assert result == [600]

    def test_extract_multiple(self) -> None:
        """複数のIssue参照を検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        body = """
## 関連Issue

Closes #123, Fixes #456
Resolves #789
"""
        result = _extract_closing_issue_numbers(body)
        assert set(result) == {123, 456, 789}

    def test_extract_case_insensitive(self) -> None:
        """大文字小文字を区別しない"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("CLOSES #123, closes #456, ClOsEs #789")
        assert set(result) == {123, 456, 789}

    def test_extract_no_match(self) -> None:
        """マッチしない場合は空リスト"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Refs #123, See #456")
        assert result == []

    def test_extract_with_owner_repo_format(self) -> None:
        """owner/repo#XXX 形式を検出"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Closes owner/repo#123")
        assert result == [123]

    def test_extract_no_duplicates(self) -> None:
        """重複を除去"""
        from cli.commands.pr import _extract_closing_issue_numbers

        result = _extract_closing_issue_numbers("Closes #123, Fixes #123")
        assert result == [123]


# pr cleanup コマンドテスト


class TestPRCleanupCommand:
    """pr cleanup コマンドのテスト"""

    def test_cleanup_success(self) -> None:
        """正常系: マージ済みPRの片付け成功"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト機能追加",
            "body": "## Verified — テスト用本文\n\n- テスト追加\n\nCloses #123",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [{"number": 123, "title": "テストタスク"}],
            "reviews": [],
        }
        mock_client.close_issue.return_value = {
            "number": 123,
            "state": "closed",
        }
        mock_client.get_issue_kind.return_value = _kind_task(123)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            assert "count: Issues to close:" in result.stderr
            mock_client.close_issue.assert_called_once_with("owner", "repo", 123)

    def test_cleanup_success_shows_no_report_message(self) -> None:
        """正常系: マージ成功時に報告不要メッセージが表示される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト機能追加",
            "body": "## Verified — テスト用本文\n\n- テスト追加",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            assert result.stdout == ""

    def test_cleanup_with_closing_issues_from_body(self) -> None:
        """PR本文からClosing Issuesを抽出してクローズ"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "Closes #123, Fixes #456",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],  # closingIssuesReferences は空
            "reviews": [],
        }
        mock_client.close_issue.return_value = {"state": "closed"}
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            # 両方のIssueがクローズされる
            assert mock_client.close_issue.call_count == 2

    def test_cleanup_dry_run(self) -> None:
        """dry-runモード: 実際にはマージしない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "Closes #123",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.return_value = _kind_task(123)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--dry-run"])

            assert result.exit_code == 0
            assert "dry-run" in result.output or "ドライラン" in result.output
            # 実際のクローズは呼ばれない
            mock_client.close_issue.assert_not_called()

    def test_cleanup_pr_not_found(self) -> None:
        """PRが見つからない場合"""
        from cli.core.github import GitHubNotFoundError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.side_effect = GitHubNotFoundError("PRが見つかりません")

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/999"])

            assert result.exit_code == 1
            assert "error: PR not found" in result.stderr

    @pytest.mark.parametrize("state", ["OPEN", "CLOSED"])
    def test_cleanup_not_merged_exits_without_side_effects(self, state: str) -> None:
        """MERGED 以外は exit 1 で、Issue クローズ・ブランチ削除・ローカル片付けをしない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": state,
            "title": "feat: テスト",
            "body": "Closes #123",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "closing_issues": [{"number": 123}],
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr._local_cleanup_after_merge") as mock_local,
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--delete-branch"])

        assert result.exit_code == 1
        assert (
            f"error: PR #42 is not merged yet (state: {state}); merge it with gh pr merge first"
            in result.stderr
        )
        mock_client.close_issue.assert_not_called()
        mock_client.delete_branch.assert_not_called()
        mock_local.assert_not_called()

    def test_pr_merge_command_is_removed(self) -> None:
        """pecot pr merge は存在しない"""
        result = runner.invoke(app, ["pr", "merge", "owner/repo/42"])

        assert result.exit_code == 2
        assert "No such command" in result.output

    def test_cleanup_invalid_pr_ref(self) -> None:
        """不正なPR参照形式"""
        mock_config = MagicMock()
        with patch("cli.commands.pr.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["pr", "cleanup", "invalid-format"])

            assert result.exit_code == 2
            assert "invalid reference" in result.output


# pr cleanup フラグ削除テスト


class TestPRCleanupFlagCleanup:
    """pr cleanup 完了時のフラグファイル削除テスト"""

    def _make_mock_client(self) -> MagicMock:
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "",
            "head_ref": "feat/test",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)
        return mock_client

    def test_cleanup_removes_pecot_active_flag(self) -> None:
        """マージ成功時に .pecot-active フラグが削除される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = self._make_mock_client()

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.core.state.remove_flag") as mock_remove,
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            from cli.core.state import FLAG_PECOT_ACTIVE

            mock_remove.assert_any_call(FLAG_PECOT_ACTIVE)

    def test_cleanup_consumes_merge_slash_flag(self) -> None:
        """片付けの成功時に、w-merge 起点の merge-slash-pending を消費する"""
        mock_client = self._make_mock_client()

        with (
            patch("cli.commands.pr.load_active_config", return_value=MagicMock(host="h")),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr._local_cleanup_after_merge"),
            patch("cli.commands.pr._remove_active_flags"),
            patch("cli.commands.pr.consume_flag") as mock_consume,
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            from cli.core.state import FLAG_MERGE_SLASH_PENDING

            mock_consume.assert_called_once_with(FLAG_MERGE_SLASH_PENDING)

    def test_unmerged_does_not_consume_merge_slash_flag(self) -> None:
        """未マージで止まるときは merge-slash-pending を残す"""
        mock_client = self._make_mock_client()
        mock_client.get_pull_request_slim.return_value["state"] = "OPEN"

        with (
            patch("cli.commands.pr.load_active_config", return_value=MagicMock(host="h")),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr.consume_flag") as mock_consume,
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 1
            mock_consume.assert_not_called()

    def test_cleanup_removes_pecot_quick_mode_flag(self) -> None:
        """マージ成功時に .pecot-quick-mode フラグが削除される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = self._make_mock_client()

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.core.state.remove_flag") as mock_remove,
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            from cli.core.state import FLAG_PECOT_QUICK_MODE

            mock_remove.assert_any_call(FLAG_PECOT_QUICK_MODE)

    def test_cleanup_removes_pecot_session_title_flag(self) -> None:
        """マージ成功時に .pecot-session-title フラグが削除される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = self._make_mock_client()

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.core.state.remove_flag") as mock_remove,
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            from cli.core.state import FLAG_PECOT_SESSION_TITLE

            mock_remove.assert_any_call(FLAG_PECOT_SESSION_TITLE)

    def test_cleanup_removes_wip_branch_linked_flag(self) -> None:
        """マージ成功時に .wip-branch-linked フラグが削除される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = self._make_mock_client()

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.core.state.remove_flag") as mock_remove,
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            from cli.core.state import FLAG_WIP_BRANCH_LINKED

            assert FLAG_WIP_BRANCH_LINKED == ".wip-branch-linked"
            mock_remove.assert_any_call(FLAG_WIP_BRANCH_LINKED)

    def test_cleanup_skip_local_cleanup_does_not_remove_flags(self) -> None:
        """--skip-local-cleanup 時はフラグ削除されない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = self._make_mock_client()

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.core.state.remove_flag") as mock_remove,
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--skip-local-cleanup"])

            assert result.exit_code == 0
            mock_remove.assert_not_called()

    def test_cleanup_flag_removal_idempotent(self) -> None:
        """フラグが存在しなくてもエラーにならない（冪等）"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_client = self._make_mock_client()

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.core.state.remove_flag") as mock_remove,
        ):
            # remove_flag は missing_ok=True なので例外を投げない
            mock_remove.return_value = None
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            assert mock_remove.call_count == 5


# pr cleanup ヘルプテスト


class TestPRCleanupDeleteBranch:
    """pr cleanup --delete-branch オプションのテスト"""

    def test_delete_branch_after_merge(self) -> None:
        """マージ後にブランチを削除"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "Closes #123",
            "head_ref": "feat/test-branch",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.close_issue.return_value = {"state": "closed"}
        mock_client.get_issue_kind.return_value = _kind_task(123)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--delete-branch"])

            assert result.exit_code == 0
            # featureブランチとWIPブランチの両方が削除される
            assert mock_client.delete_branch.call_count == 2
            mock_client.delete_branch.assert_any_call("owner", "repo", "feat/test-branch")
            mock_client.delete_branch.assert_any_call("owner", "repo", "wip/feat/test-branch")

    def test_delete_branch_also_deletes_wip_branch(self) -> None:
        """マージ後にfeatureブランチとWIPブランチの両方が削除される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "Closes #123",
            "head_ref": "feat/test-branch",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.return_value = _kind_task(123)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--delete-branch"])

            assert result.exit_code == 0
            assert "deleted: remote branch wip/feat/test-branch" in result.stderr
            assert mock_client.delete_branch.call_count == 2

    def test_delete_branch_wip_not_found_silently_skipped(self) -> None:
        """WIPブランチが存在しない場合はエラーにならない"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "",
            "head_ref": "feat/test-branch",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)
        # featureブランチ削除は成功、WIPブランチ削除は422
        mock_client.delete_branch.side_effect = [
            None,  # feat/test-branch 成功
            GitHubAPIError("Reference does not exist", status_code=422),
        ]

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--delete-branch"])

            assert result.exit_code == 0
            assert "count: Issues to close:" in result.stderr
            # WIPブランチ削除のメッセージは出ない
            assert "wip/" not in result.output

    def test_delete_branch_not_called_without_flag(self) -> None:
        """--delete-branchなしではブランチ削除しない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "",
            "head_ref": "feat/test-branch",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            mock_client.delete_branch.assert_not_called()

    def test_delete_branch_failure_warning(self) -> None:
        """ブランチ削除失敗時は警告を出すが処理は成功"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "",
            "head_ref": "feat/protected",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)
        mock_client.delete_branch.side_effect = GitHubAPIError("削除失敗")

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--delete-branch"])

            # マージ自体は成功
            assert result.exit_code == 0
            assert "count: Issues to close:" in result.stderr
            # 警告メッセージは stderr に出る
            assert (
                "warning: deleting remote branch feat/protected failed: 削除失敗" in result.stderr
            )
            _assert_no_symbols(result)
            # head 削除失敗では WIP 削除に進まず、削除したブランチとして報告しない
            assert mock_client.delete_branch.call_count == 1
            assert "deleted: remote branch wip/" not in result.stderr

    def test_delete_branch_head_already_deleted_treated_as_deleted(self) -> None:
        """head が既に消えている(422 Reference does not exist)場合は削除済みとして WIP も削除する"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "",
            "head_ref": "feat/test-branch",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)
        mock_client.delete_branch.side_effect = [
            GitHubAPIError(
                "GitHub APIエラー: 422",
                status_code=422,
                response_body='{"message":"Reference does not exist"}',
            ),
            None,  # wip/feat/test-branch 成功
        ]

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--delete-branch"])

            assert result.exit_code == 0
            assert "failed" not in result.output
            assert "unchanged: remote branch feat/test-branch (already deleted)" in result.stderr
            mock_client.delete_branch.assert_any_call("owner", "repo", "wip/feat/test-branch")
            assert mock_client.delete_branch.call_count == 2
            assert "deleted: remote branch wip/feat/test-branch" in result.stderr


@pytest.mark.parametrize(
    ("status_code", "response_body", "expected"),
    [
        (422, '{"message":"Reference does not exist"}', True),
        (404, '{"message":"Reference does not exist"}', True),
        (404, '{"message":"Not Found"}', False),
        (422, '{"message":"Validation Failed"}', False),
        (403, '{"message":"Reference does not exist"}', False),
        (422, None, False),
    ],
)
def test_is_missing_ref_error(status_code: int, response_body: str | None, expected: bool) -> None:
    from cli.core.github import GitHubAPIError

    e = GitHubAPIError("err", status_code=status_code, response_body=response_body)
    assert _is_missing_ref_error(e) is expected


class TestExtractIssueNumberFromBranch:
    """extract_issue_number_from_branch 関数のテスト"""

    def test_extract_from_feat_branch(self) -> None:
        """feat/description/470 形式"""
        result = extract_issue_number_from_branch("feat/description/470")
        assert result == 470

    def test_extract_from_fix_branch(self) -> None:
        """fix/bug-fix/123 形式"""
        result = extract_issue_number_from_branch("fix/bug-fix/123")
        assert result == 123

    def test_extract_from_nested_path(self) -> None:
        """多階層のパス"""
        result = extract_issue_number_from_branch("feat/module/sub-feature/999")
        assert result == 999

    def test_no_issue_number_main(self) -> None:
        """main ブランチは None"""
        result = extract_issue_number_from_branch("main")
        assert result is None

    def test_no_issue_number_develop(self) -> None:
        """develop ブランチは None"""
        result = extract_issue_number_from_branch("develop-aist")
        assert result is None

    def test_no_issue_number_feature(self) -> None:
        """末尾が数字でないfeatureブランチは None"""
        result = extract_issue_number_from_branch("feat/no-issue-number")
        assert result is None

    def test_empty_string(self) -> None:
        """空文字列は None"""
        result = extract_issue_number_from_branch("")
        assert result is None

    def test_numeric_only(self) -> None:
        """数字のみのブランチ名"""
        result = extract_issue_number_from_branch("123")
        assert result == 123


# _append_issue_close_if_needed 関数テスト


class TestAppendIssueCloseIfNeeded:
    """_append_issue_close_if_needed 関数のテスト"""

    def test_append_when_no_reference(self) -> None:
        """Issue参照がない場合は末尾にCloses参照を追加"""
        body = "## Verified — テスト用本文\n\nテスト内容"
        result = _append_issue_close_if_needed(body, 123)
        assert result == "## Verified — テスト用本文\n\nテスト内容\n\nCloses #123"

    def test_no_append_when_already_exists(self) -> None:
        """既にIssue参照がある場合は追加しない"""
        body = "## Verified — テスト用本文\n\nテスト内容\n\nCloses #123"
        result = _append_issue_close_if_needed(body, 123)
        assert result == body

    def test_no_append_when_different_format_exists(self) -> None:
        """#XXX形式で既に参照がある場合は追加しない"""
        body = "## Verified — テスト用本文\n\nテスト #123 を参照"
        result = _append_issue_close_if_needed(body, 123)
        assert result == body

    def test_append_when_different_issue_number(self) -> None:
        """異なるIssue番号の場合は追加"""
        body = "## Verified — テスト用本文\n\nCloses #456"
        result = _append_issue_close_if_needed(body, 123)
        assert result.endswith("\n\nCloses #123")

    def test_no_append_for_url_path_fragment(self) -> None:
        """URL内フラグメント（/#123形式）は参照とみなさない"""
        body = "詳細は https://example.com/#123 を参照"
        result = _append_issue_close_if_needed(body, 123)
        # /#123形式はURL内フラグメントとして認識され、追加される
        assert result.endswith("\n\nCloses #123")

    def test_treats_page_fragment_as_reference(self) -> None:
        """page#123形式はIssue参照として認識（追加しない）"""
        body = "詳細は https://example.com/page#123 を参照"
        result = _append_issue_close_if_needed(body, 123)
        # page#123は/#123ではないのでIssue参照として認識
        assert result == body

    def test_no_append_when_partial_match(self) -> None:
        """#1234のような部分一致では追加しない（#123が含まれる）"""
        body = "Refs #1234"
        result = _append_issue_close_if_needed(body, 123)
        # #123は#1234に含まれていないので追加される
        assert result.endswith("\n\nCloses #123")

    def test_no_append_when_closing_keyword_exists(self) -> None:
        """Closes #XXX形式で既に参照がある場合は追加しない"""
        body = "## Verified — テスト用本文\n\nCloses #123"
        result = _append_issue_close_if_needed(body, 123)
        assert result == body

    def test_strips_trailing_whitespace(self) -> None:
        """末尾の空白を削除して追加"""
        body = "## Verified — テスト用本文  \n\n  "
        result = _append_issue_close_if_needed(body, 123)
        assert result == "## Verified — テスト用本文\n\nCloses #123"


# pr cleanup Refs パターンクローズテスト


class TestPRCleanupRefsPatternNotClosed:
    """pr cleanup で Refs パターンがクローズ対象にならないことを検証するテスト"""

    def test_cleanup_does_not_close_refs_issues(self) -> None:
        """Refs #XXX パターンのIssueはクローズされない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "## 関連Issue\n\nRefs #123",
            "head_ref": "feat/test/42",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            # Refs #123 はクローズされない（ブランチ名由来の#42のみ）
            # close_issueの呼び出しにRefs由来の123が含まれないことを確認
            for call in mock_client.close_issue.call_args_list:
                assert call != (("owner", "repo", 123),)

    def test_cleanup_does_not_close_refs_colon_issues(self) -> None:
        """Refs: #XXX パターンのIssueはクローズされない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "## 関連Issue\n\nRefs: #456",
            "head_ref": "feat/test/42",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            # Refs: #456 はクローズされない
            for call in mock_client.close_issue.call_args_list:
                assert call != (("owner", "repo", 456),)

    def test_cleanup_closes_only_closing_keywords_not_refs(self) -> None:
        """Closes #100 のみクローズされ、Refs #200 はクローズされない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "Closes #100\n\n## 関連Issue\n\nRefs #200",
            "head_ref": "feat/test/100",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.close_issue.return_value = {"state": "closed"}
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            # Closes #100 とブランチ名由来の #100 のみ（重複排除で1回）
            # Refs #200 はクローズされない
            close_calls = mock_client.close_issue.call_args_list
            closed_issues = {call[0][2] for call in close_calls}
            assert 100 in closed_issues
            assert 200 not in closed_issues

    def test_cleanup_dry_run_does_not_show_refs_issues(self) -> None:
        """dry-run で Refs パターンのIssueはクローズ対象に含まれない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "Refs #789",
            "head_ref": "feat/test/42",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--dry-run"])

            assert result.exit_code == 0
            # Refs #789 はクローズ対象に含まれない
            # dry-run出力でクローズ対象Issueリストに789が含まれないことを確認
            mock_client.close_issue.assert_not_called()


class TestPRCleanupBranchNameExtraction:
    """pr cleanup でブランチ名からIssue番号を抽出してクローズするテスト"""

    def test_cleanup_closes_issue_from_branch_name(self) -> None:
        """ブランチ名末尾のIssue番号がクローズされる"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "テスト本文",
            "head_ref": "feat/20260121-043000/687",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.close_issue.return_value = {"state": "closed"}
        mock_client.get_issue_kind.return_value = _kind_task(687)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            # ブランチ名から抽出された #687 がクローズされる
            mock_client.close_issue.assert_called_once_with("owner", "repo", 687)

    def test_cleanup_closes_branch_and_body_issues(self) -> None:
        """ブランチ名とPR本文の両方からIssue番号を抽出してクローズ"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "Closes #100",
            "head_ref": "feat/description/200",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.close_issue.return_value = {"state": "closed"}
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            # #100 と #200 の両方がクローズされる
            assert mock_client.close_issue.call_count == 2

    def test_cleanup_dry_run_shows_branch_issue(self) -> None:
        """dry-run でブランチ名から抽出されたIssue番号が表示される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "テスト本文",
            "head_ref": "feat/bug-fix/999",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.return_value = _kind_task(999)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--dry-run"])

            assert result.exit_code == 0
            assert "#999" in result.output
            # 実際のクローズは呼ばれない
            mock_client.close_issue.assert_not_called()

    def test_cleanup_no_issue_in_branch_name(self) -> None:
        """ブランチ名にIssue番号がない場合は抽出されない"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = {
            "number": 42,
            "state": "MERGED",
            "title": "feat: テスト",
            "body": "テスト本文",
            "head_ref": "feat/no-issue-number",
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": [],
            "reviews": [],
        }
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

            assert result.exit_code == 0
            # Issueクローズは呼ばれない
            mock_client.close_issue.assert_not_called()


class TestDeterminBaseBranch:
    """_determine_base_branch のテスト"""

    def test_uses_project_config_develop_branch(self) -> None:
        """プロジェクト設定のdevelop_branchを優先"""
        from cli.commands.pr import _determine_base_branch

        mock_config = MagicMock()
        mock_config.get_develop_branch.return_value = "develop-aist"

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr._branch_exists", return_value=True),
        ):
            result = _determine_base_branch(
                "github.com", "owner", "repo", Path.cwd(), Output(False)
            )
            assert result == "origin/develop-aist"

    def test_no_config_raises_error(self) -> None:
        """プロジェクト設定がない場合はエラーを発生"""
        from cli.commands.pr import _determine_base_branch

        with (
            patch("cli.commands.pr.load_active_config", return_value=None),
        ):
            with pytest.raises(typer.Exit):
                _determine_base_branch("github.com", "owner", "repo", Path.cwd(), Output(False))

    def test_develop_branch_not_set_raises_error(self) -> None:
        """develop_branchが設定されていない場合はエラーを発生"""
        from cli.commands.pr import _determine_base_branch

        mock_config = MagicMock()
        mock_config.get_develop_branch.return_value = None

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
        ):
            with pytest.raises(typer.Exit):
                _determine_base_branch("github.com", "owner", "repo", Path.cwd(), Output(False))


class TestPRPreflightCommand:
    """pr preflight コマンドのテスト"""

    def test_preflight_success(self, tmp_path: Path) -> None:
        """基本的な動作確認"""
        # モックの準備
        mock_config = MagicMock()
        mock_config.get_develop_branch.return_value = "develop-aist"

        with (
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch(
                "cli.commands.pr.git_remote_url", return_value="https://github.com/owner/repo.git"
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr._branch_exists", return_value=True),
            patch(
                "cli.commands.pr._get_push_status",
                return_value=(True, "in sync with origin/feat/test/123"),
            ),
            patch(
                "cli.commands.pr._get_git_status",
                return_value="On branch feat/test/123\nnothing to commit, working tree clean\n",
            ),
            patch("cli.commands.pr._read_gitignore", return_value="*.pyc"),
            patch("cli.commands.pr._read_git_exclude", return_value="# exclude"),
            patch("cli.commands.pr._get_commits_vs_base", return_value="abc123 test commit"),
            patch("cli.commands.pr._get_diff_summary", return_value="1 file changed"),
            patch("cli.commands.pr._get_worktree_info", return_value="worktree info"),
            patch("cli.commands.pr._get_stash_list", return_value="(no stash)"),
        ):
            result = runner.invoke(app, ["pr", "preflight", "-D", str(tmp_path)])

            assert result.exit_code == 0
            assert "Git Remote" in result.output
            assert "https://github.com/owner/repo.git" in result.output
            assert "Current Branch" in result.output
            assert "feat/test/123" in result.output
            assert "Push Status" in result.output
            assert "in sync with origin/feat/test/123" in result.output
            assert "Base Branch" in result.output
            assert "origin/develop-aist" in result.output
            assert "=== Summary ===" not in result.stdout
            assert result.stderr == "count: preflight warnings: 0\n"
            _assert_no_symbols(result)

    def test_preflight_unpushed_commits_warning(self, tmp_path: Path) -> None:
        """未プッシュコミットがある場合の警告表示"""
        mock_config = MagicMock()
        mock_config.get_develop_branch.return_value = "develop-aist"

        with (
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch(
                "cli.commands.pr.git_remote_url", return_value="https://github.com/owner/repo.git"
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr._branch_exists", return_value=True),
            patch(
                "cli.commands.pr._get_push_status",
                return_value=(False, "3 unpushed commits"),
            ),
            patch(
                "cli.commands.pr._get_git_status",
                return_value="On branch feat/test/123\nnothing to commit, working tree clean\n",
            ),
            patch("cli.commands.pr._read_gitignore", return_value="*.pyc"),
            patch("cli.commands.pr._read_git_exclude", return_value="# exclude"),
            patch("cli.commands.pr._get_commits_vs_base", return_value="abc123 test commit"),
            patch("cli.commands.pr._get_diff_summary", return_value="1 file changed"),
            patch("cli.commands.pr._get_worktree_info", return_value="worktree info"),
            patch("cli.commands.pr._get_stash_list", return_value="(no stash)"),
        ):
            result = runner.invoke(app, ["pr", "preflight", "-D", str(tmp_path)])

            # 未プッシュコミットは修復可能な警告として exit 2
            assert result.exit_code == 2
            # 節見出しと事実は stdout、警告は stderr
            assert "=== Push Status ===" in result.stdout
            assert "warning: Push Status: 3 unpushed commits (fix: git push)" in result.stderr
            assert "=== Summary ===" not in result.stdout
            assert "=== Summary ===" not in result.stderr
            assert "count: preflight warnings: 1" in result.stderr
            _assert_no_symbols(result)

    def test_preflight_not_in_git_repo(self, tmp_path: Path) -> None:
        """gitリポジトリ外での実行はエラー"""
        with patch("cli.commands.pr.git_toplevel", return_value=None):
            result = runner.invoke(app, ["pr", "preflight", "-D", str(tmp_path)])

            assert result.exit_code == 1
            assert "error: not a git repository" in result.stderr

    def test_preflight_no_remote(self, tmp_path: Path) -> None:
        """originリモートがない場合はエラー"""
        with (
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch("cli.commands.pr.git_remote_url", return_value=None),
        ):
            result = runner.invoke(app, ["pr", "preflight", "-D", str(tmp_path)])

            assert result.exit_code == 1
            assert "error: origin remote not found" in result.stderr

    def test_preflight_no_current_branch(self, tmp_path: Path) -> None:
        """現在のブランチを取得できない場合はエラー"""
        with (
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch(
                "cli.commands.pr.git_remote_url", return_value="https://github.com/owner/repo.git"
            ),
            patch("cli.commands.pr.git_current_branch", return_value=None),
        ):
            result = runner.invoke(app, ["pr", "preflight", "-D", str(tmp_path)])

            assert result.exit_code == 1
            assert "error: cannot determine the current branch" in result.stderr

    def test_preflight_success_with_summary(self, tmp_path: Path) -> None:
        """警告ゼロ時、末尾に Summary が出力され exit 0"""
        mock_config = MagicMock()
        mock_config.get_develop_branch.return_value = "develop-aist"

        with (
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch(
                "cli.commands.pr.git_remote_url", return_value="https://github.com/owner/repo.git"
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr._branch_exists", return_value=True),
            patch(
                "cli.commands.pr._get_push_status",
                return_value=(True, "in sync with origin/feat/test/123"),
            ),
            patch(
                "cli.commands.pr._get_git_status",
                return_value="On branch feat/test/123\nnothing to commit, working tree clean\n",
            ),
            patch("cli.commands.pr._read_gitignore", return_value=""),
            patch("cli.commands.pr._read_git_exclude", return_value=""),
            patch("cli.commands.pr._get_commits_vs_base", return_value=""),
            patch("cli.commands.pr._get_diff_summary", return_value=""),
            patch("cli.commands.pr._get_worktree_info", return_value=""),
            patch("cli.commands.pr._get_stash_list", return_value="(no stash)"),
        ):
            result = runner.invoke(app, ["pr", "preflight", "-D", str(tmp_path)])

            assert result.exit_code == 0
            assert result.stderr == "count: preflight warnings: 0\n"
            assert "=== Summary ===" not in result.stdout
            _assert_no_symbols(result)

    def test_preflight_push_warning_summary_and_exit2(self, tmp_path: Path) -> None:
        """push 未同期時、Summary に警告が再掲され exit 2"""
        mock_config = MagicMock()
        mock_config.get_develop_branch.return_value = "develop-aist"

        with (
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch(
                "cli.commands.pr.git_remote_url", return_value="https://github.com/owner/repo.git"
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr._branch_exists", return_value=True),
            patch(
                "cli.commands.pr._get_push_status",
                return_value=(
                    False,
                    "origin/feat/test/123 does not exist (not pushed)",
                ),
            ),
            patch(
                "cli.commands.pr._get_git_status",
                return_value="On branch feat/test/123\nnothing to commit, working tree clean\n",
            ),
            patch("cli.commands.pr._read_gitignore", return_value=""),
            patch("cli.commands.pr._read_git_exclude", return_value=""),
            patch("cli.commands.pr._get_commits_vs_base", return_value=""),
            patch("cli.commands.pr._get_diff_summary", return_value=""),
            patch("cli.commands.pr._get_worktree_info", return_value=""),
            patch("cli.commands.pr._get_stash_list", return_value="(no stash)"),
        ):
            result = runner.invoke(app, ["pr", "preflight", "-D", str(tmp_path)])

            assert result.exit_code == 2
            assert "=== Summary ===" not in result.stdout
            assert "warning: Push Status:" in result.stderr
            assert "(fix: git push)" in result.stderr
            _assert_no_symbols(result)

    def test_preflight_multiple_warnings_all_listed(self, tmp_path: Path) -> None:
        """push + stash の複数警告が Summary に全列挙される"""
        mock_config = MagicMock()
        mock_config.get_develop_branch.return_value = "develop-aist"

        with (
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch(
                "cli.commands.pr.git_remote_url", return_value="https://github.com/owner/repo.git"
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr._branch_exists", return_value=True),
            patch(
                "cli.commands.pr._get_push_status",
                return_value=(False, "2 unpushed commits"),
            ),
            patch(
                "cli.commands.pr._get_git_status",
                return_value="On branch feat/test/123\nnothing to commit, working tree clean\n",
            ),
            patch("cli.commands.pr._read_gitignore", return_value=""),
            patch("cli.commands.pr._read_git_exclude", return_value=""),
            patch("cli.commands.pr._get_commits_vs_base", return_value=""),
            patch("cli.commands.pr._get_diff_summary", return_value=""),
            patch("cli.commands.pr._get_worktree_info", return_value=""),
            patch(
                "cli.commands.pr._get_stash_list",
                return_value="stash@{0}: WIP on feat/test/123: abc wip",
            ),
        ):
            result = runner.invoke(app, ["pr", "preflight", "-D", str(tmp_path)])

            assert result.exit_code == 2
            assert "warning: Push Status:" in result.stderr
            assert "warning: Stash List:" in result.stderr
            # Stash List 節（見出しと一覧）は stdout、警告は stderr
            assert "=== Stash List ===" in result.stdout
            assert "stash@{0}: WIP on feat/test/123: abc wip" in result.stdout
            _assert_no_symbols(result)

    def test_pr_create_aborts_on_preflight_warnings(self, tmp_path: Path) -> None:
        """preflight 警告検出時、pr create は API コール前に exit 2"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.repositories = [MagicMock(owner="owner", name="repo")]
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = None

        mock_client = MagicMock()

        body = f"""## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文
- テスト

## Risks — なし
テスト
- なし
- なし
- テスト"""

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://github.com/owner/repo.git",
            ),
            patch(
                "cli.commands.pr._get_push_status",
                return_value=(
                    False,
                    "origin/feat/test/123 does not exist (not pushed)",
                ),
            ),
            patch(
                "cli.commands.pr._get_git_status",
                return_value="On branch feat/test/123\nnothing to commit, working tree clean\n",
            ),
            patch("cli.commands.pr._get_stash_list", return_value="(no stash)"),
        ):
            result = runner.invoke(
                app,
                ["pr", "create", "-m", body, "-t", "feat: テスト", "-b", "develop-aist"],
            )

            # preflight 警告で exit 2
            assert result.exit_code == 2
            # API は呼ばれていない
            mock_client.create_pull_request.assert_not_called()
            assert "preflight" in result.output

    def test_pr_create_dry_run_skips_preflight(self, tmp_path: Path) -> None:
        """--dry-run 時は push 未同期でも preflight 早期失敗をスキップし API 非コールで exit 0"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.repositories = [MagicMock(owner="owner", name="repo")]
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = None

        mock_client = MagicMock()

        body = f"""## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文

- テスト
- テスト
- なし
- なし
- テスト

## Risks — なし

- なし"""

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://github.com/owner/repo.git",
            ),
            patch(
                "cli.commands.pr._get_push_status",
                return_value=(
                    False,
                    "origin/feat/test/123 does not exist (not pushed)",
                ),
            ),
            patch(
                "cli.commands.pr._get_git_status",
                return_value="On branch feat/test/123\nnothing to commit, working tree clean\n",
            ),
            patch("cli.commands.pr._get_stash_list", return_value="(no stash)"),
        ):
            result = runner.invoke(
                app,
                [
                    "pr",
                    "create",
                    "-m",
                    body,
                    "-t",
                    "feat: テスト",
                    "-b",
                    "develop-aist",
                    "--dry-run",
                ],
            )

            assert result.exit_code == 0
            mock_client.create_pull_request.assert_not_called()
            assert "dry-run: would create PR" in result.stderr


class TestHelperFunctionsWithMocks:
    """ヘルパー関数の実装部分のテスト（subprocess実行部分）"""

    def test_branch_exists_true(self) -> None:
        """_branch_exists がブランチ存在時にTrueを返す"""
        from cli.commands.pr import _branch_exists

        mock_result = MagicMock()
        mock_result.stdout = "origin/main"

        with patch("subprocess.run", return_value=mock_result):
            result = _branch_exists("origin/main", Path.cwd())
            assert result is True

    def test_branch_exists_false(self) -> None:
        """_branch_exists がブランチ不在時にFalseを返す"""
        from cli.commands.pr import _branch_exists

        with patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, "git")):
            result = _branch_exists("origin/nonexistent", Path.cwd())
            assert result is False

    def test_get_git_status_success(self) -> None:
        """_get_git_status が正常にステータスを返す"""
        from cli.commands.pr import _get_git_status

        mock_result = MagicMock()
        mock_result.stdout = "On branch main\nnothing to commit"

        with patch("subprocess.run", return_value=mock_result):
            result = _get_git_status(Path.cwd())
            assert "On branch main" in result

    def test_get_git_status_failure(self) -> None:
        """_get_git_status がエラー時にフォールバックメッセージを返す"""
        from cli.commands.pr import _get_git_status

        with patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, "git")):
            result = _get_git_status(Path.cwd())
            assert result == "(git status failed)"

    def test_get_commits_vs_base_success(self) -> None:
        """_get_commits_vs_base が正常にコミット履歴を返す"""
        from cli.commands.pr import _get_commits_vs_base

        mock_result = MagicMock()
        mock_result.stdout = "abc123 test commit\n"

        with patch("subprocess.run", return_value=mock_result):
            result = _get_commits_vs_base("origin/main", Path.cwd())
            assert result == "abc123 test commit"

    def test_get_commits_vs_base_no_commits(self) -> None:
        """_get_commits_vs_base がコミットなし時に、コミットなしを示す文字列を返す"""
        from cli.commands.pr import _get_commits_vs_base

        mock_result = MagicMock()
        mock_result.stdout = ""

        with patch("subprocess.run", return_value=mock_result):
            result = _get_commits_vs_base("origin/main", Path.cwd())
            assert result == "(no commits)"

    def test_get_diff_summary_success(self) -> None:
        """_get_diff_summary が正常に差分統計を返す"""
        from cli.commands.pr import _get_diff_summary

        mock_result = MagicMock()
        mock_result.stdout = "1 file changed, 10 insertions(+)\n"

        with patch("subprocess.run", return_value=mock_result):
            result = _get_diff_summary("origin/main", Path.cwd())
            assert "1 file changed" in result

    def test_get_diff_summary_no_diff(self) -> None:
        """_get_diff_summary が差分なし時に、差分なしを示す文字列を返す"""
        from cli.commands.pr import _get_diff_summary

        mock_result = MagicMock()
        mock_result.stdout = ""

        with patch("subprocess.run", return_value=mock_result):
            result = _get_diff_summary("origin/main", Path.cwd())
            assert result == "(no diff)"

    def test_read_gitignore_success(self, tmp_path: Path) -> None:
        """_read_gitignore がファイルを正常に読み取る"""
        from cli.commands.pr import _read_gitignore

        gitignore = tmp_path / ".gitignore"
        gitignore.write_text("*.pyc\n__pycache__/")

        with patch("cli.commands.pr.git_toplevel", return_value=tmp_path):
            result = _read_gitignore(tmp_path)
            assert "*.pyc" in result
            assert "__pycache__/" in result

    def test_read_gitignore_not_found(self, tmp_path: Path) -> None:
        """_read_gitignore がファイル不在時に、不在を示す文字列を返す"""
        from cli.commands.pr import _read_gitignore

        with patch("cli.commands.pr.git_toplevel", return_value=tmp_path):
            result = _read_gitignore(tmp_path)
            assert result == "(no .gitignore)"

    def test_read_git_exclude_success(self) -> None:
        """_read_git_exclude がファイルを正常に読み取る"""
        from cli.commands.pr import _read_git_exclude

        mock_result = MagicMock()
        mock_result.stdout = "/path/to/.git"

        mock_exclude_content = "# exclude\n*.log"

        with (
            patch("subprocess.run", return_value=mock_result),
            patch("pathlib.Path.exists", return_value=True),
            patch("pathlib.Path.read_text", return_value=mock_exclude_content),
        ):
            result = _read_git_exclude(Path.cwd())
            assert "# exclude" in result
            assert "*.log" in result

    def test_read_git_exclude_not_found(self) -> None:
        """_read_git_exclude がファイル不在時に、不在を示す文字列を返す"""
        from cli.commands.pr import _read_git_exclude

        mock_result = MagicMock()
        mock_result.stdout = "/path/to/.git"

        with (
            patch("subprocess.run", return_value=mock_result),
            patch("pathlib.Path.exists", return_value=False),
        ):
            result = _read_git_exclude(Path.cwd())
            assert result == "(no exclude)"

    def test_get_worktree_info_sub_worktree(self) -> None:
        """_get_worktree_info がサブワークツリーを正しく判定（git-dir ≠ common-dir）"""
        from cli.commands.pr import _get_worktree_info

        mock_list_result = MagicMock()
        mock_list_result.stdout = "/path/to/repo main\n/path/to/wt1 feat/test"

        mock_git_dir_result = MagicMock()
        mock_git_dir_result.stdout = "/path/to/repo/.git/worktrees/wt1"

        mock_common_dir_result = MagicMock()
        mock_common_dir_result.stdout = "/path/to/repo/.git"

        test_dir = Path("/path/to/wt1")
        with patch(
            "subprocess.run",
            side_effect=[mock_list_result, mock_git_dir_result, mock_common_dir_result],
        ):
            result = _get_worktree_info(test_dir)
            assert "Is worktree environment: true" in result

    def test_get_worktree_info_main_worktree(self) -> None:
        """_get_worktree_info がメインワークツリーを正しく判定（git-dir = common-dir）"""
        from cli.commands.pr import _get_worktree_info

        mock_list_result = MagicMock()
        mock_list_result.stdout = "/path/to/repo main"

        mock_git_dir_result = MagicMock()
        mock_git_dir_result.stdout = "/path/to/repo/.git"

        mock_common_dir_result = MagicMock()
        mock_common_dir_result.stdout = "/path/to/repo/.git"

        test_dir = Path("/path/to/repo")
        with patch(
            "subprocess.run",
            side_effect=[mock_list_result, mock_git_dir_result, mock_common_dir_result],
        ):
            result = _get_worktree_info(test_dir)
            assert "Is worktree environment: false" in result

    def test_get_worktree_info_git_error(self) -> None:
        """_get_worktree_info がgitエラー時にunknownを返す"""
        from cli.commands.pr import _get_worktree_info

        mock_list_result = MagicMock()
        mock_list_result.stdout = "/path/to/repo main"

        test_dir = Path("/path/to/repo")
        with patch(
            "subprocess.run",
            side_effect=[
                mock_list_result,
                subprocess.CalledProcessError(1, "git"),
            ],
        ):
            result = _get_worktree_info(test_dir)
            assert "Is worktree environment: (unknown)" in result


# --no-issue-ref オプションテスト


class TestNoIssueRefOption:
    """--no-issue-ref オプションのテスト"""

    def test_validate_pr_content_skip_issue_ref_check(self) -> None:
        """skip_issue_ref_check=TrueでIssue参照チェックがスキップされることを確認"""
        # Issue参照なしの本文でもエラーにならない
        body = "これは本文です。Issue参照はありません。"
        title = "テストPR"
        base = "main"
        develop_branch = "develop-aist"

        # skip_issue_ref_check=False の場合はエラーになる
        errors = _validate_pr_content(body, title, base, develop_branch, skip_issue_ref_check=False)
        assert len(errors) > 0
        assert any("no Issue reference `#N`" in err for err in errors)

        # skip_issue_ref_check=True の場合はエラーにならない
        errors = _validate_pr_content(body, title, base, develop_branch, skip_issue_ref_check=True)
        # Issue参照チェックはスキップされるが、他のチェックは実行される
        # baseブランチチェックでエラーになる可能性がある
        assert not any("no Issue reference `#N`" in err for err in errors)

    def test_append_issue_close_not_called_with_no_issue_ref(self, tmp_path: Path) -> None:
        """--no-issue-ref 使用時に _append_issue_close_if_needed が呼ばれないことを確認"""
        from cli.commands.pr import _pr_create_from_file

        # 並走する他のテスト・worktree と衝突しないよう、テストごとの一時ディレクトリに置く
        test_file = tmp_path / "test_pr_create.md"
        test_file.write_text(
            """---
repository: owner/repo
title: Test PR
base: develop-aist
draft: false
---

## Verified — テスト内容

これは本文です。
"""
        )

        try:
            with (
                patch("cli.commands.pr.load_active_config") as mock_config,
                patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
                patch("cli.commands.pr.extract_issue_number_from_branch", return_value=123),
                patch("cli.commands.pr._append_issue_close_if_needed") as mock_append,
                patch("cli.commands.pr._validate_pr_content", return_value=[]),
            ):
                mock_proj = MagicMock()
                mock_proj.get_develop_branch.return_value = "develop-aist"
                mock_proj.host = "github.com"
                mock_config.return_value = mock_proj

                # no_issue_ref=True で呼び出し
                try:
                    _pr_create_from_file(
                        test_file, dry_run=True, no_issue_ref=True, directory=Path.cwd()
                    )
                except SystemExit:
                    pass

                # _append_issue_close_if_needed が呼ばれていないことを確認
                mock_append.assert_not_called()
        finally:
            if test_file.exists():
                test_file.unlink()

    def test_append_issue_close_called_without_no_issue_ref(self, tmp_path: Path) -> None:
        """--no-issue-ref なしの場合に _append_issue_close_if_needed が呼ばれることを確認"""
        from cli.commands.pr import _pr_create_from_file

        # 並走する他のテスト・worktree と衝突しないよう、テストごとの一時ディレクトリに置く
        test_file = tmp_path / "test_pr_create_default.md"
        test_file.write_text(
            """---
repository: owner/repo
title: Test PR
base: develop-aist
draft: false
---

## Verified — テスト内容

これは本文です。
"""
        )

        try:
            with (
                patch("cli.commands.pr.load_active_config") as mock_config,
                patch("cli.commands.pr.git_current_branch", return_value="feat/test/456"),
                patch("cli.commands.pr.extract_issue_number_from_branch", return_value=456),
                patch(
                    "cli.commands.pr._append_issue_close_if_needed",
                    return_value="本文\n\nCloses #456",
                ) as mock_append,
                patch("cli.commands.pr._validate_pr_content", return_value=[]),
            ):
                mock_proj = MagicMock()
                mock_proj.get_develop_branch.return_value = "develop-aist"
                mock_proj.host = "github.com"
                mock_config.return_value = mock_proj

                # no_issue_ref=False（デフォルト）で呼び出し
                try:
                    _pr_create_from_file(
                        test_file, dry_run=True, no_issue_ref=False, directory=Path.cwd()
                    )
                except SystemExit:
                    pass

                # _append_issue_close_if_needed が呼ばれていることを確認
                mock_append.assert_called_once()
        finally:
            if test_file.exists():
                test_file.unlink()


# _update_issue_status_to_in_review テスト


class TestUpdateIssueStatusToInReview:
    """_update_issue_status_to_in_review 関数のテスト"""

    def _make_config(
        self,
        *,
        project_id: str = "PVT_test",
        workflow_field_id: str = "PVTSSF_workflow",
        in_review_option_id: str | None = "option_in_review",
    ) -> MagicMock:
        """テスト用ProjectConfigモックを作成"""
        config = MagicMock()
        config.project.id = project_id
        config.get_field_id.return_value = workflow_field_id
        config.get_option_id.return_value = in_review_option_id
        return config

    def test_success(self, capsys: pytest.CaptureFixture[str]) -> None:
        """正常系: ステータスをIn Reviewに更新"""
        config = self._make_config()
        client = MagicMock()
        client.get_item_id_by_issue.return_value = "PVTI_item123"
        client.update_project_item_field.return_value = "PVTI_item123"

        _update_issue_status_to_in_review(
            config=config,
            client=client,
            owner="owner",
            repo="repo",
            head_branch="feat/add-feature/123",
            out=Output(False),
        )

        client.get_item_id_by_issue.assert_called_once_with(
            project_id="PVT_test",
            owner="owner",
            repo="repo",
            issue_number=123,
        )
        client.update_project_item_field.assert_called_once_with(
            project_id="PVT_test",
            item_id="PVTI_item123",
            field_id="PVTSSF_workflow",
            option_id="option_in_review",
        )
        assert capsys.readouterr().err == "set: Issue #123 status to In Review\n"

    def test_no_issue_number_in_branch(self, capsys: pytest.CaptureFixture[str]) -> None:
        """ブランチ名にIssue番号がない場合はスキップ"""
        config = self._make_config()
        client = MagicMock()

        _update_issue_status_to_in_review(
            config=config,
            client=client,
            owner="owner",
            repo="repo",
            head_branch="feat/no-issue-number",
            out=Output(False),
        )

        # APIは呼ばれない
        client.get_item_id_by_issue.assert_not_called()
        client.update_project_item_field.assert_not_called()

    def test_issue_not_on_board(self, capsys: pytest.CaptureFixture[str]) -> None:
        """ボードにIssueがない場合は警告出力のみ"""
        config = self._make_config()
        client = MagicMock()
        client.get_item_id_by_issue.return_value = None

        _update_issue_status_to_in_review(
            config=config,
            client=client,
            owner="owner",
            repo="repo",
            head_branch="feat/test/456",
            out=Output(False),
        )

        captured = capsys.readouterr()
        assert "warning: Issue #456 is not on the board; status not updated" in captured.err
        client.update_project_item_field.assert_not_called()

    def test_in_review_status_not_configured(self, capsys: pytest.CaptureFixture[str]) -> None:
        """in_reviewステータスが設定されていない場合は警告出力のみ"""
        config = self._make_config(in_review_option_id=None)
        client = MagicMock()
        client.get_item_id_by_issue.return_value = "PVTI_item123"

        _update_issue_status_to_in_review(
            config=config,
            client=client,
            owner="owner",
            repo="repo",
            head_branch="feat/test/456",
            out=Output(False),
        )

        captured = capsys.readouterr()
        assert "warning: workflow field has no in_review status" in captured.err
        client.update_project_item_field.assert_not_called()

    def test_workflow_field_not_found(self, capsys: pytest.CaptureFixture[str]) -> None:
        """workflowフィールドが見つからない場合は警告出力のみ"""
        config = self._make_config()
        config.get_field_id.return_value = None  # workflowフィールドなし
        client = MagicMock()
        client.get_item_id_by_issue.return_value = "PVTI_item123"

        _update_issue_status_to_in_review(
            config=config,
            client=client,
            owner="owner",
            repo="repo",
            head_branch="feat/test/456",
            out=Output(False),
        )

        captured = capsys.readouterr()
        assert "warning: workflow field not found" in captured.err
        client.update_project_item_field.assert_not_called()

    def test_api_error_on_get_item(self, capsys: pytest.CaptureFixture[str]) -> None:
        """ボードアイテム取得時のAPIエラーは警告出力のみ"""
        config = self._make_config()
        client = MagicMock()
        client.get_item_id_by_issue.side_effect = Exception("API error")

        _update_issue_status_to_in_review(
            config=config,
            client=client,
            owner="owner",
            repo="repo",
            head_branch="feat/test/789",
            out=Output(False),
        )

        captured = capsys.readouterr()
        assert "warning: board item lookup for Issue #789 failed: API error" in captured.err
        client.update_project_item_field.assert_not_called()

    def test_api_error_on_update(self, capsys: pytest.CaptureFixture[str]) -> None:
        """ステータス更新時のAPIエラーは警告出力のみ"""
        config = self._make_config()
        client = MagicMock()
        client.get_item_id_by_issue.return_value = "PVTI_item123"
        client.update_project_item_field.side_effect = Exception("Update failed")

        _update_issue_status_to_in_review(
            config=config,
            client=client,
            owner="owner",
            repo="repo",
            head_branch="feat/test/456",
            out=Output(False),
        )

        captured = capsys.readouterr()
        assert "warning: status update of Issue #456 failed: Update failed" in captured.err


class TestGetPushStatus:
    """_get_push_status 関数のテスト"""

    def test_remote_branch_not_exists(self) -> None:
        """リモートブランチが存在しない場合"""
        from cli.commands.pr import _get_push_status

        mock_result = MagicMock()
        mock_result.returncode = 1

        with patch("subprocess.run", return_value=mock_result):
            is_pushed, message = _get_push_status("feat/test", Path.cwd())
            assert is_pushed is False
            assert "not pushed" in message

    def test_synced_with_remote(self) -> None:
        """リモートと完全同期している場合"""
        from cli.commands.pr import _get_push_status

        def mock_run(cmd: list[str], **kwargs: dict) -> MagicMock:
            result = MagicMock()
            result.returncode = 0
            if "rev-parse" in cmd:
                result.stdout = "abc123"
            elif "rev-list" in cmd:
                result.stdout = "0"
            return result

        with patch("subprocess.run", side_effect=mock_run):
            is_pushed, message = _get_push_status("feat/test", Path.cwd())
            assert is_pushed is True
            assert "in sync" in message

    def test_unpushed_commits(self) -> None:
        """未プッシュのコミットがある場合"""
        from cli.commands.pr import _get_push_status

        call_count = 0

        def mock_run(cmd: list[str], **kwargs: dict) -> MagicMock:
            nonlocal call_count
            result = MagicMock()
            result.returncode = 0

            if "rev-parse" in cmd:
                result.stdout = "abc123"
            elif "rev-list" in cmd:
                call_count += 1
                if call_count == 1:
                    # ahead count (local has commits not in remote)
                    result.stdout = "3"
                else:
                    # behind count (remote has commits not in local)
                    result.stdout = "0"
            return result

        with patch("subprocess.run", side_effect=mock_run):
            is_pushed, message = _get_push_status("feat/test", Path.cwd())
            assert is_pushed is False
            assert message == "3 unpushed commits"

    def test_remote_ahead(self) -> None:
        """リモートが先行している場合（pullが必要）"""
        from cli.commands.pr import _get_push_status

        call_count = 0

        def mock_run(cmd: list[str], **kwargs: dict) -> MagicMock:
            nonlocal call_count
            result = MagicMock()
            result.returncode = 0

            if "rev-parse" in cmd:
                result.stdout = "abc123"
            elif "rev-list" in cmd:
                call_count += 1
                if call_count == 1:
                    # ahead count
                    result.stdout = "0"
                else:
                    # behind count
                    result.stdout = "2"
            return result

        with patch("subprocess.run", side_effect=mock_run):
            is_pushed, message = _get_push_status("feat/test", Path.cwd())
            assert is_pushed is True  # PRは作成可能
            assert "commits ahead" in message
            assert "pull recommended" in message

    def test_diverged_branches(self) -> None:
        """ブランチが分岐している場合"""
        from cli.commands.pr import _get_push_status

        call_count = 0

        def mock_run(cmd: list[str], **kwargs: dict) -> MagicMock:
            nonlocal call_count
            result = MagicMock()
            result.returncode = 0

            if "rev-parse" in cmd:
                result.stdout = "abc123"
            elif "rev-list" in cmd:
                call_count += 1
                if call_count == 1:
                    # ahead count
                    result.stdout = "2"
                else:
                    # behind count
                    result.stdout = "1"
            return result

        with patch("subprocess.run", side_effect=mock_run):
            is_pushed, message = _get_push_status("feat/test", Path.cwd())
            assert is_pushed is False
            assert "diverged" in message


# リリースPR関連テスト


class TestValidatePRContentRelease:
    """_validate_pr_content のリリースPR判定テスト"""

    def _make_release_body(self) -> str:
        """リリースPR用の本文を作成"""
        return """## Summary — v0.5.0 の公開

利用者に届く変更の要点

## Changes — CHANGELOG 転記

- 変更1
- 変更2

## Migration — なし

なし

## Changes

なし

## Verified — 全項目確認済み

- **CHANGELOG.md** — 該当バージョン節の更新を確認
- **テスト** — run-tests.sh --scope=all で通過を確認
- **ドキュメント** — 更新不要と判断
"""

    def test_release_pr_allows_main_base(self) -> None:
        """リリースPR（head==develop, base==release_branch）でmain許可"""
        body = self._make_release_body()
        errors = _validate_pr_content(
            body,
            "release: v0.5.0",
            "main",
            "develop-aist",
            release_branch="main",
            head="develop-aist",
        )
        # mainブロックエラーがないことを確認
        assert not any("base branch must be" in e for e in errors)

    def test_release_template_allows_main_base(self) -> None:
        """--template release でmain許可"""
        body = self._make_release_body()
        errors = _validate_pr_content(
            body,
            "release: v0.5.0",
            "main",
            "develop-aist",
            template="release",
        )
        assert not any("base branch must be" in e for e in errors)

    def test_release_pr_skips_issue_ref_check(self) -> None:
        """リリースPRではIssue参照チェックをスキップ"""
        body = self._make_release_body()
        errors = _validate_pr_content(
            body,
            "release: v0.5.0",
            "main",
            "develop-aist",
            release_branch="main",
            head="develop-aist",
        )
        assert not any("no Issue reference `#N`" in e for e in errors)

    def test_normal_pr_still_blocks_main(self) -> None:
        """通常PR（headとdevelopが別）でmainブロック（退行テスト）"""
        body = """## Verified — テスト用本文

- テスト
- テスト
- テスト
- テスト
- テスト

## Risks — なし

- なし

Refs #123
"""
        errors = _validate_pr_content(
            body,
            "feat: something",
            "main",
            "develop-aist",
            release_branch="main",
            head="feat/something/123",
        )
        assert any("base branch must be" in e for e in errors)

    def test_normal_pr_blocks_arbitrary_base(self) -> None:
        """通常PR: develop_branch以外の任意のbaseをブロック"""
        body = """## Verified — テスト用本文

- テスト
- テスト
- テスト
- テスト
- テスト

## Risks — なし

- なし

Refs #123
"""
        errors = _validate_pr_content(
            body,
            "feat: something",
            "staging",
            "develop-aist",
            head="feat/something/123",
        )
        assert any("base branch must be" in e for e in errors)

    def test_normal_pr_allows_develop_branch(self) -> None:
        """通常PR: develop_branchへのPRは許可"""
        body = """## Verified — テスト用本文

- テスト
- テスト
- テスト
- テスト
- テスト

## Risks — なし

- なし

Refs #123
"""
        errors = _validate_pr_content(
            body,
            "feat: something",
            "develop-aist",
            "develop-aist",
            head="feat/something/123",
        )
        assert not any("base branch must be" in e for e in errors)

    def test_release_template_uses_release_sections(self) -> None:
        """--template release でリリーステンプレートのセクションを検証"""
        # リリーステンプレートのセクションを欠いた本文
        body = "リリースです"
        errors = _validate_pr_content(
            body,
            "release: v0.5.0",
            "main",
            "develop-aist",
            template="release",
        )
        # リリーステンプレートの不足セクションエラーがあることを確認
        assert any("missing sections" in e for e in errors)

    def test_release_template_blocks_wrong_base(self) -> None:
        """--template release でrelease_branchと異なるbaseをブロック"""
        body = self._make_release_body()
        errors = _validate_pr_content(
            body,
            "release: v0.5.0",
            "staging",
            "develop-aist",
            template="release",
            release_branch="main",
        )
        assert any("release PR base branch must be" in e for e in errors)

    def test_release_auto_detect_blocks_wrong_base(self) -> None:
        """自動判定リリースPR（headがdevelopで、baseがrelease_branchでない）をブロック"""
        body = self._make_release_body()
        # headがdevelop_branchでも、baseがrelease_branchでない場合は、
        # is_releaseはFalseになり通常PRとして扱われる
        errors = _validate_pr_content(
            body,
            "release: v0.5.0",
            "staging",
            "develop-aist",
            release_branch="main",
            head="develop-aist",
        )
        # baseがrelease_branchとdevelop_branchのどちらとも違うので、
        # mainブロックは発動しない。リリースPRとしても認められない
        assert not any("release PR base branch must be" in e for e in errors)

    def test_release_template_allows_correct_release_branch(self) -> None:
        """--template release でrelease_branchと一致するbaseを許可"""
        body = self._make_release_body()
        errors = _validate_pr_content(
            body,
            "release: v0.5.0",
            "main",
            "develop-aist",
            template="release",
            release_branch="main",
        )
        assert not any("release PR base branch must be" in e for e in errors)
        assert not any("base branch must be" in e for e in errors)

    def test_release_template_no_release_branch_errors(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """--template release でrelease_branch未設定なら検証の前に exit 1 で設定を誘導"""
        with pytest.raises(typer.Exit) as exc:
            _exit_on_unset_branch("release", "main", None, "develop-aist", None, Output(False))
        assert exc.value.exit_code == 1
        err = capsys.readouterr().err
        assert "release_branch is not set" in err
        assert "project set-repo" in err

    def test_release_template_invalid_value(self) -> None:
        """--template に無効な値を指定した場合のバリデーション"""
        result = runner.invoke(
            app,
            ["pr", "create", "-m", "test", "-t", "test", "-b", "main", "--template", "invalid"],
        )
        assert result.exit_code == 1
        assert "default" in result.output
        assert "release" in result.output


class TestPRCreateDirectRelease:
    """pr create -m の --template release テスト（dry-run）"""

    def test_direct_release_dry_run(self) -> None:
        """--template release でdry-run成功"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = "main"

        body = """## Summary — v0.5.0 の公開

利用者に届く変更の要点

## Changes — CHANGELOG 転記

- 変更

## Migration — なし

なし

## Changes

なし

## Verified — 全項目確認済み

- **CHANGELOG.md** — 該当バージョン節の更新を確認
- **テスト** — run-tests.sh --scope=all で通過を確認
- **ドキュメント** — 更新不要と判断"""

        with (
            patch("cli.commands.pr.load_active_config", return_value=mock_config),
            patch("cli.commands.pr.git_current_branch", return_value="develop-aist"),
        ):
            result = runner.invoke(
                app,
                [
                    "pr",
                    "create",
                    "-m",
                    body,
                    "-t",
                    "release: v0.5.0",
                    "-b",
                    "main",
                    "--head",
                    "develop-aist",
                    "-r",
                    "owner/repo",
                    "--template",
                    "release",
                    "--dry-run",
                ],
            )
            assert result.exit_code == 0
            assert "dry-run: would create PR" in result.stderr
            assert "(release template)" in result.stderr


# _local_cleanup_after_merge テスト


class TestLocalCleanupAfterMerge:
    """_local_cleanup_after_merge 関数のテスト"""

    def _make_config(self, develop_branch: str | None = "develop-aist") -> MagicMock:
        """テスト用のProjectConfig mockを作成"""
        config = MagicMock()
        config.get_develop_branch.return_value = develop_branch
        return config

    def test_worktree_env_cleanup(self) -> None:
        """WT環境で正しくwtXブランチにcheckout → pull → branch -D"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")
        run_calls: list[list[str]] = []

        def mock_subprocess_run(cmd: list[str], **kwargs: object) -> MagicMock:
            run_calls.append(cmd)
            result = MagicMock()
            result.returncode = 0
            result.stdout = ""
            return result

        with (
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://ghes.example.com/owner/repo.git",
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test-branch"),
            patch("cli.core.worktree.is_worktree_env", return_value=True),
            patch("cli.core.worktree.get_current_worktree_name", return_value="wt3"),
            patch("subprocess.run", side_effect=mock_subprocess_run),
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )

        # checkout wt3, pull develop-aist, branch -D
        assert any(cmd == ["git", "checkout", "wt3"] for cmd in run_calls)
        assert any(cmd == ["git", "pull", "origin", "develop-aist"] for cmd in run_calls)
        assert any(cmd == ["git", "branch", "-D", "feat/test-branch"] for cmd in run_calls)

    def test_normal_env_cleanup(self) -> None:
        """通常環境でdevelop-aistにcheckout → pull → branch -D"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")
        run_calls: list[list[str]] = []

        def mock_subprocess_run(cmd: list[str], **kwargs: object) -> MagicMock:
            run_calls.append(cmd)
            result = MagicMock()
            result.returncode = 0
            result.stdout = ""
            return result

        with (
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://ghes.example.com/owner/repo.git",
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test-branch"),
            patch("cli.core.worktree.is_worktree_env", return_value=False),
            patch("subprocess.run", side_effect=mock_subprocess_run),
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )

        assert any(cmd == ["git", "checkout", "develop-aist"] for cmd in run_calls)
        assert any(cmd == ["git", "pull", "origin", "develop-aist"] for cmd in run_calls)
        assert any(cmd == ["git", "branch", "-D", "feat/test-branch"] for cmd in run_calls)

    def test_dry_run_preview(self, capsys: pytest.CaptureFixture[str]) -> None:
        """dry_run=Trueでプレビュー出力あり、subprocess呼ばれない"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")

        with (
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://ghes.example.com/owner/repo.git",
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test-branch"),
            patch("cli.core.worktree.is_worktree_env", return_value=False),
            patch("subprocess.run") as mock_run,
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(True),
            )
            mock_run.assert_not_called()

        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err.splitlines() == [
            "dry-run: would set current branch to develop-aist",
            "dry-run: would update develop-aist from origin/develop-aist",
            "dry-run: would delete local branch feat/test-branch",
        ]

    def test_already_on_target_skip_checkout(self) -> None:
        """既にターゲットブランチにいる場合checkoutスキップ"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")
        run_calls: list[list[str]] = []

        def mock_subprocess_run(cmd: list[str], **kwargs: object) -> MagicMock:
            run_calls.append(cmd)
            result = MagicMock()
            result.returncode = 0
            result.stdout = ""
            return result

        with (
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://ghes.example.com/owner/repo.git",
            ),
            patch("cli.commands.pr.git_current_branch", return_value="develop-aist"),
            patch("cli.core.worktree.is_worktree_env", return_value=False),
            patch("subprocess.run", side_effect=mock_subprocess_run),
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )

        # checkout should NOT be called
        assert not any(cmd[0:2] == ["git", "checkout"] for cmd in run_calls)
        # pull and branch -D should still be called
        assert any(cmd == ["git", "pull", "origin", "develop-aist"] for cmd in run_calls)
        assert any(cmd == ["git", "branch", "-D", "feat/test-branch"] for cmd in run_calls)

    def test_checkout_failure_warns(self, capsys: pytest.CaptureFixture[str]) -> None:
        """checkout失敗時に警告のみ"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")

        def mock_subprocess_run(cmd: list[str], **kwargs: object) -> MagicMock:
            if cmd[1] == "checkout":
                raise subprocess.CalledProcessError(1, cmd)
            result = MagicMock()
            result.returncode = 0
            result.stdout = ""
            return result

        with (
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://ghes.example.com/owner/repo.git",
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test-branch"),
            patch("cli.core.worktree.is_worktree_env", return_value=False),
            patch("subprocess.run", side_effect=mock_subprocess_run),
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )

        captured = capsys.readouterr()
        assert "warning: checking out develop-aist failed" in captured.err
        assert "origin/develop-aist" not in captured.err
        assert "local branch" not in captured.err
        assert captured.out == ""

    def test_no_develop_branch_config(self, capsys: pytest.CaptureFixture[str]) -> None:
        """configにdevelop_branchがない場合スキップ"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config(develop_branch=None)

        with (
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://ghes.example.com/owner/repo.git",
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test-branch"),
            patch("cli.core.worktree.is_worktree_env", return_value=False),
            patch("subprocess.run") as mock_run,
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )
            mock_run.assert_not_called()

        captured = capsys.readouterr()
        assert "warning: develop_branch is not set; skipped local cleanup" in captured.err
        assert captured.out == ""

    def test_cross_repo_skips_cleanup(self, capsys: pytest.CaptureFixture[str]) -> None:
        """現在リポとPRリポが異なる場合、ローカル操作を一切行わずスキップ"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")

        with (
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://ghes.example.com/other-owner/other-repo.git",
            ),
            patch("subprocess.run") as mock_run,
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )
            mock_run.assert_not_called()

        captured = capsys.readouterr()
        assert "other-owner/other-repo" in captured.err
        assert "owner/repo" in captured.err
        assert "skipped local cleanup" in captured.err
        assert captured.out == ""

    def test_remote_url_failure_skips(self, capsys: pytest.CaptureFixture[str]) -> None:
        """リモートURL取得失敗時もスキップ"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")

        with (
            patch("cli.commands.pr.git_remote_url", return_value=None),
            patch("subprocess.run") as mock_run,
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )
            mock_run.assert_not_called()

        captured = capsys.readouterr()
        assert "warning: cannot read the remote URL" in captured.err
        assert captured.out == ""

    def test_unparsable_remote_url_skips(self, capsys: pytest.CaptureFixture[str]) -> None:
        """リモートURLの形式が想定外ならスキップし、warning は stderr に出る"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")

        with (
            patch("cli.commands.pr.git_remote_url", return_value="/local/bare/repo"),
            patch("subprocess.run") as mock_run,
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )
            mock_run.assert_not_called()

        captured = capsys.readouterr()
        assert "warning: cannot read the repository from the remote URL" in captured.err
        assert captured.out == ""

    def test_repo_detection_exception_skips(self, capsys: pytest.CaptureFixture[str]) -> None:
        """リポジトリ判定中の想定外例外はスキップし、warning は stderr に出る"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")

        with patch("cli.commands.pr.git_remote_url", side_effect=OSError("boom")):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )

        captured = capsys.readouterr()
        assert "warning: cannot determine the repository" in captured.err
        assert captured.out == ""

    def test_worktree_detection_failure_skips(self, capsys: pytest.CaptureFixture[str]) -> None:
        """ワークツリー判定に失敗したらスキップし、warning は stderr に出る"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")

        with (
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://ghes.example.com/owner/repo.git",
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test-branch"),
            patch("cli.core.worktree.is_worktree_env", side_effect=RuntimeError("not git")),
            patch("subprocess.run") as mock_run,
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )
            mock_run.assert_not_called()

        captured = capsys.readouterr()
        assert "warning: cannot determine the worktree" in captured.err
        assert captured.out == ""

    def test_pull_and_branch_delete_failure_warn_on_stderr(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """pull / branch -D の失敗は warning の行になり、stdout は空のまま"""
        from cli.commands.pr import _local_cleanup_after_merge

        config = self._make_config("develop-aist")

        def mock_subprocess_run(cmd: list[str], **kwargs: object) -> MagicMock:
            if cmd[1] in ("pull", "branch"):
                raise subprocess.CalledProcessError(1, cmd)
            result = MagicMock()
            result.returncode = 0
            result.stdout = ""
            return result

        with (
            patch(
                "cli.commands.pr.git_remote_url",
                return_value="https://ghes.example.com/owner/repo.git",
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test-branch"),
            patch("cli.core.worktree.is_worktree_env", return_value=False),
            patch("subprocess.run", side_effect=mock_subprocess_run),
        ):
            _local_cleanup_after_merge(
                head_branch="feat/test-branch",
                config=config,
                owner="owner",
                repo="repo",
                out=Output(False),
            )

        captured = capsys.readouterr()
        assert "set: current branch to develop-aist" in captured.err
        assert "warning: pulling develop-aist failed" in captured.err
        assert "warning: deleting local branch feat/test-branch failed" in captured.err
        assert captured.out == ""


# pr create --prepare の Closes #N 自動埋め込みテスト (#358)


def _kind_task(number: int) -> dict[str, object]:
    return {
        "number": number,
        "state": "OPEN",
        "issue_type": "Task",
        "sub_issues_total": 0,
    }


def _kind_epic_typed(number: int) -> dict[str, object]:
    return {
        "number": number,
        "state": "OPEN",
        "issue_type": "Epic",
        "sub_issues_total": 0,
    }


def _kind_epic_subissues(number: int, total: int = 3) -> dict[str, object]:
    return {
        "number": number,
        "state": "OPEN",
        "issue_type": None,
        "sub_issues_total": total,
    }


class TestPrCreatePrepareCloses:
    """pr create --prepare の Closes #N 自動埋め込みテスト"""

    def test_prepare_fills_closes_with_active_issue(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """active タスク (.pecot-active) の番号がテンプレに埋め込まれる"""
        import cli.commands.pr as pr_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(pr_module, "get_output_dir", lambda: output_dir)
        monkeypatch.setattr(pr_module, "load_active_config", lambda: None)
        monkeypatch.setattr(pr_module, "read_flag", lambda _name: "owner/repo/123")

        mock_client = MagicMock()
        mock_client.get_issue_kind.return_value = _kind_task(123)

        with patch("cli.commands.pr.GitHubClient", return_value=mock_client):
            result = runner.invoke(app, ["pr", "create", "--prepare"])

        assert result.exit_code == 0
        files = list(output_dir.glob("pr-create-*.md"))
        assert len(files) == 1
        content = files[0].read_text(encoding="utf-8")
        assert "Closes #123" in content
        assert "Closes #\n" not in content

    def test_prepare_skips_closes_when_active_is_epic(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """active が Epic ならテンプレ未変更 + 警告"""
        import cli.commands.pr as pr_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(pr_module, "get_output_dir", lambda: output_dir)
        monkeypatch.setattr(pr_module, "load_active_config", lambda: None)
        monkeypatch.setattr(pr_module, "read_flag", lambda _name: "owner/repo/100")

        mock_client = MagicMock()
        mock_client.get_issue_kind.return_value = _kind_epic_typed(100)

        with patch("cli.commands.pr.GitHubClient", return_value=mock_client):
            result = runner.invoke(app, ["pr", "create", "--prepare"])

        assert result.exit_code == 0
        files = list(output_dir.glob("pr-create-*.md"))
        content = files[0].read_text(encoding="utf-8")
        assert "Closes #100" not in content
        # テンプレ末尾の空欄が維持されている
        assert content.rstrip().endswith("Closes #")
        assert "is an Epic; Closes left empty" in result.output

    def test_prepare_falls_back_to_branch_when_no_active(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """active なしならブランチ末尾番号で埋める"""
        import cli.commands.pr as pr_module

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(pr_module, "get_output_dir", lambda: output_dir)
        monkeypatch.setattr(pr_module, "load_active_config", lambda: None)
        monkeypatch.setattr(pr_module, "read_flag", lambda _name: None)
        monkeypatch.setattr(
            pr_module,
            "origin_repo",
            lambda _d: ("github.com", "owner", "repo"),
        )
        monkeypatch.setattr(pr_module, "git_current_branch", lambda _d: "feat/foo/456")

        mock_client = MagicMock()
        mock_client.get_issue_kind.return_value = _kind_task(456)

        with patch("cli.commands.pr.GitHubClient", return_value=mock_client):
            result = runner.invoke(app, ["pr", "create", "--prepare"])

        assert result.exit_code == 0
        content = next(output_dir.glob("pr-create-*.md")).read_text(encoding="utf-8")
        assert "Closes #456" in content

    def test_prepare_skips_when_kind_lookup_fails(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """get_issue_kind が API エラー → テンプレ未変更 + 警告（フェイルオープン）"""
        import cli.commands.pr as pr_module
        from cli.core.github import GitHubAPIError

        output_dir = tmp_path / "pecot"
        monkeypatch.setattr(pr_module, "get_output_dir", lambda: output_dir)
        monkeypatch.setattr(pr_module, "load_active_config", lambda: None)
        monkeypatch.setattr(pr_module, "read_flag", lambda _name: "owner/repo/789")

        mock_client = MagicMock()
        mock_client.get_issue_kind.side_effect = GitHubAPIError("API error")

        with patch("cli.commands.pr.GitHubClient", return_value=mock_client):
            result = runner.invoke(app, ["pr", "create", "--prepare"])

        assert result.exit_code == 0
        content = next(output_dir.glob("pr-create-*.md")).read_text(encoding="utf-8")
        assert "Closes #789" not in content
        assert content.rstrip().endswith("Closes #")
        assert "warning: kind check of Issue #789 failed" in result.output


# pr create 保険ロジックの Epic 除外テスト (#358)


class TestPrCreateAppendClosesEpicGuard:
    """_pr_create_from_file 保険ロジックの Epic 除外"""

    PR_FILE_BODY = f"""---
title: "feat: テスト機能追加"
repository: "owner/repo"
base: "develop-aist"
head: "feat/test/100"
draft: false
---

## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文

- テスト追加
- テストのため
- 特になし
- なし
- テスト実行

## Risks — なし

- なし
"""

    def _make_config(self) -> MagicMock:
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.develop_branch = "develop-aist"
        mock_config.repositories = []
        mock_config.get_develop_branch.return_value = "develop-aist"
        mock_config.get_release_branch.return_value = None
        return mock_config

    def test_create_skips_append_closes_when_branch_is_epic(self, tmp_path: Path) -> None:
        """ブランチ末尾の番号が Epic → Closes 自動付与スキップ"""
        # Issue 参照なしだとバリデーションが落ちるため Refs #100 を本文に追記
        pr_file = tmp_path / "pr.md"
        pr_file.write_text(
            self.PR_FILE_BODY.rstrip() + "\n\nRefs #100\n",
            encoding="utf-8",
        )

        mock_client = MagicMock()
        mock_client.get_issue_kind.return_value = _kind_epic_typed(100)
        mock_client.create_pull_request.return_value = {
            "number": 1,
            "html_url": "http://x/1",
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._make_config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr._run_preflight_checks_or_exit"),
        ):
            result = runner.invoke(app, ["pr", "create", str(pr_file)])

        assert result.exit_code == 0
        body_passed = mock_client.create_pull_request.call_args[1]["body"]
        assert "Closes #100" not in body_passed
        assert "is an Epic; Closes not added" in result.output

    def test_create_appends_closes_when_branch_is_task(self, tmp_path: Path) -> None:
        """ブランチ末尾の番号が Task → 従来通り Closes 自動付与"""
        pr_file = tmp_path / "pr.md"
        pr_file.write_text(self.PR_FILE_BODY, encoding="utf-8")

        mock_client = MagicMock()
        mock_client.get_issue_kind.return_value = _kind_task(100)
        mock_client.create_pull_request.return_value = {
            "number": 1,
            "html_url": "http://x/1",
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._make_config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr._run_preflight_checks_or_exit"),
        ):
            result = runner.invoke(app, ["pr", "create", str(pr_file)])

        assert result.exit_code == 0
        body_passed = mock_client.create_pull_request.call_args[1]["body"]
        assert "Closes #100" in body_passed


# pr cleanup Epic 保護テスト (#358)


class TestPrCleanupEpicProtect:
    """pr cleanup の Epic フィルタ"""

    @staticmethod
    def _make_pr(
        *, body: str = "", head_ref: str = "feat/test/101", closing_issues: list | None = None
    ) -> dict:
        return {
            "number": 42,
            "state": "MERGED",
            "title": "feat: test",
            "body": body,
            "head_ref": head_ref,
            "base_ref": "develop-aist",
            "is_draft": False,
            "mergeable": "MERGEABLE",
            "comments": 0,
            "closing_issues": closing_issues or [],
            "reviews": [],
        }

    def _config(self) -> MagicMock:
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        return mock_config

    def test_cleanup_skips_epic_from_closing_issues_references(self) -> None:
        """closingIssuesReferences に混入した Epic を除外"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            head_ref="feat/test/101",
            closing_issues=[{"number": 100}, {"number": 101}],
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: (
            _kind_epic_typed(100) if n == 100 else _kind_task(n)
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        # Epic は close されない
        closed = [c.args[2] for c in mock_client.close_issue.call_args_list]
        assert 100 not in closed
        assert 101 in closed
        assert "skipped: closing Issue #100 (Epic)" in result.stderr

    def test_cleanup_skips_epic_from_body_closes(self) -> None:
        """PR 本文の Closes に Epic 番号が混入したケース"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            body="Closes #200",
            head_ref="feat/test/201",
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: (
            _kind_epic_typed(200) if n == 200 else _kind_task(n)
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        closed = [c.args[2] for c in mock_client.close_issue.call_args_list]
        assert 200 not in closed
        assert "skipped: closing Issue #200 (Epic)" in result.stderr

    def test_cleanup_skips_epic_from_branch_name(self) -> None:
        """ブランチ末尾番号が Epic のケース"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            head_ref="feat/epic/300",
        )
        mock_client.get_issue_kind.return_value = _kind_epic_typed(300)

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        mock_client.close_issue.assert_not_called()
        assert "skipped: closing Issue #300 (Epic)" in result.stderr

    def test_cleanup_closes_non_epic_normally(self) -> None:
        """Task は通常通り close される"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            head_ref="feat/test/400",
        )
        mock_client.get_issue_kind.return_value = _kind_task(400)

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        mock_client.close_issue.assert_called_once_with("owner", "repo", 400)
        assert "(Epic)" not in result.stderr

    def test_cleanup_mixed_epic_and_task(self) -> None:
        """Epic + Task 混在: Task のみ close、Epic 保護メッセージあり"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            body="Closes #100",
            head_ref="feat/test/101",
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: (
            _kind_epic_typed(100) if n == 100 else _kind_task(n)
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        closed = [c.args[2] for c in mock_client.close_issue.call_args_list]
        assert closed == [101]
        assert "skipped: closing Issue #100 (Epic)" in result.stderr

    def test_cleanup_dry_run_shows_epic_protected(self) -> None:
        """dry-run 出力に Epic 保護表示が出る"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            body="Closes #500",
            head_ref="feat/test/501",
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: (
            _kind_epic_typed(500) if n == 500 else _kind_task(n)
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42", "--dry-run"])

        assert result.exit_code == 0
        assert "dry-run: would skip closing Issue #500 (Epic)" in result.stderr
        # dry-run の自動クローズ対象から #500 が除外されている
        # （501 のみ残る）
        assert "dry-run: would close Issue #501" in result.stderr
        # close_issue は呼ばれない
        mock_client.close_issue.assert_not_called()

    def test_cleanup_phase1_fallback_subissues_only(self) -> None:
        """Issue Type 未設定 + sub-issues>0 のみで Epic 判定（Phase1 フォールバック）"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            body="Closes #600",
            head_ref="feat/test/601",
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: (
            _kind_epic_subissues(600, total=4) if n == 600 else _kind_task(n)
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        closed = [c.args[2] for c in mock_client.close_issue.call_args_list]
        assert 600 not in closed
        assert "skipped: closing Issue #600 (Epic)" in result.stderr

    def test_cleanup_keeps_tracker_with_subissues_open(self) -> None:
        """sub-issue を持つ Tracker は、Closes で参照されても閉じない"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            body="Closes #650",
            head_ref="feat/test/651",
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: (
            _kind_epic_subissues(650, total=2) if n == 650 else _kind_task(n)
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        closed = [c.args[2] for c in mock_client.close_issue.call_args_list]
        assert 650 not in closed
        assert "skipped: closing Issue #650 (Epic)" in result.stderr

    def test_cleanup_empty_epic_not_detected(self) -> None:
        """既知制約の回帰: Issue Type 未設定 + sub-issue 0 件は判定不能で close される"""
        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            body="Closes #700",
            head_ref="feat/test/701",
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: {
            "number": n,
            "state": "MERGED",
            "issue_type": None,
            "sub_issues_total": 0,
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        closed = [c.args[2] for c in mock_client.close_issue.call_args_list]
        assert 700 in closed
        assert 701 in closed
        assert "(Epic)" not in result.stderr

    def test_cleanup_kind_lookup_api_error_continues_close(self) -> None:
        """get_issue_kind が API エラー → 警告 + 通常 close (フェイルオープン)"""
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            head_ref="feat/test/800",
        )
        mock_client.get_issue_kind.side_effect = GitHubAPIError("transient", status_code=500)

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        # フェイルオープンで close 実行される
        mock_client.close_issue.assert_called_once_with("owner", "repo", 800)
        assert "warning: kind check of Issue #800 failed" in result.stderr

    def test_cleanup_kind_lookup_not_found_continues_close(self) -> None:
        """get_issue_kind が GitHubNotFoundError → 保護せず close 候補に残る"""
        from cli.core.github import GitHubNotFoundError

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            head_ref="feat/test/900",
        )
        mock_client.get_issue_kind.side_effect = GitHubNotFoundError("not found")
        mock_client.close_issue.side_effect = GitHubNotFoundError("not found")

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        mock_client.close_issue.assert_called_once_with("owner", "repo", 900)
        assert "(Epic)" not in result.stderr
        assert "warning: Issue #900 not found; skipped" in result.stderr
        _assert_no_symbols(result)

    def test_cleanup_close_issue_api_error_warns_on_stderr(self) -> None:
        """close_issue が GitHubAPIError → warning を stderr に出してマージは成功"""
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            head_ref="feat/test/901",
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)
        mock_client.close_issue.side_effect = GitHubAPIError("権限不足")

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        assert "warning: closing Issue #901 failed: 権限不足" in result.stderr
        _assert_no_symbols(result)

    def test_cleanup_close_issue_api_error_shows_github_message(self) -> None:
        """close_issue の失敗の警告に、応答本文の GitHub の message を添える"""
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            head_ref="feat/test/902",
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)
        mock_client.close_issue.side_effect = GitHubAPIError(
            "GitHub APIエラー: 422",
            status_code=422,
            response_body='{"message":"Validation Failed"}',
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        assert (
            "warning: closing Issue #902 failed: GitHub APIエラー: 422 Validation Failed"
            in result.stderr
        )

    def test_cleanup_close_issue_closed_by_another_request_is_not_warned(self) -> None:
        """Closes の自動クローズと重なった 422 は、既にクローズ済みとして扱う

        本文は 2026-11-05 に pecotcraft/pecot で同時に PATCH を送って得た実物
        """
        from cli.core.github import GitHubAPIError

        mock_client = MagicMock()
        mock_client.get_pull_request_slim.return_value = self._make_pr(
            head_ref="feat/test/903",
        )
        mock_client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)
        mock_client.close_issue.side_effect = GitHubAPIError(
            "GitHub APIエラー: 422",
            status_code=422,
            response_body=(
                '{"message":"Validation Failed","errors":[{"resource":"Issue",'
                '"code":"custom","message":"This issue was closed by another request.'
                ' Reload it and try again."}]}'
            ),
        )

        with (
            patch("cli.commands.pr.load_active_config", return_value=self._config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/42"])

        assert result.exit_code == 0
        assert "unchanged: Issue #903 (already closed)" in result.stderr
        assert "failed" not in result.stderr


# pr 雛形ラウンドトリップテスト（#958 F-02 / F-03 / F-06）

# `--prepare` 雛形の見出しは全て `## 名前 — <サマリ>` 形式
_HEADING_SUMMARY_RE = re.compile(r"^(#{2,6} .+?) — <[^>]*>$", re.MULTILINE)
# 投稿本文の見出し行に残ってはならない未編集プレースホルダ
_HEADING_PLACEHOLDER_RE = re.compile(r"^#{2,6} .*<[^>]+>.*$", re.MULTILINE)
# 本文側の未編集プレースホルダ（改行を跨がせない）
_BODY_PLACEHOLDER_RE = re.compile(r"<[^<>\n]+>")


def _fill_placeholders(content: str) -> str:
    """雛形の `<...>` を実コンテンツに置換する（#962 で本文側も reject 対象）

    入れ子（`<... `<Issue番号>` ...>`）があるため、変化しなくなるまで繰り返す。
    """
    content = _HEADING_SUMMARY_RE.sub(r"\1 — 見本サマリ", content)
    while True:
        filled = _BODY_PLACEHOLDER_RE.sub("見本", content)
        if filled == content:
            return content
        content = filled


def _prepare_pr_template(template: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """`pr create --prepare` を実行し、生成された雛形のパスを返す。

    base 自動設定と Closes 自動埋め込みは remote / API に触れるため無効化する。
    """
    import cli.commands.pr as pr_module

    output_dir = tmp_path / "pecot"
    monkeypatch.setattr(pr_module, "get_output_dir", lambda: output_dir)
    monkeypatch.setattr(pr_module, "load_active_config", lambda: None)
    monkeypatch.setattr(pr_module, "_fill_closes_in_template", lambda content, *a, **k: content)

    argv = ["pr", "create", "--prepare"]
    glob = "pr-create-*.md"
    if template == "release":
        argv += ["--template", "release"]
        glob = "pr-release-*.md"

    result = runner.invoke(app, argv)
    assert result.exit_code == 0, result.output

    prepared = list(output_dir.glob(glob))
    assert len(prepared) == 1
    return prepared[0]


def _pr_config() -> MagicMock:
    mock_config = MagicMock()
    mock_config.host = "ghes.example.com"
    mock_config.repositories = []
    mock_config.get_develop_branch.return_value = "develop-aist"
    mock_config.get_release_branch.return_value = "main"
    return mock_config


class TestPreparedPRRoundtrip:
    """``pr create --prepare`` の雛形をそのまま ``pr create`` に流す検証"""

    @pytest.mark.parametrize(
        ("template", "base"),
        [("default", "develop-aist"), ("release", "main")],
    )
    def test_unedited_template_is_rejected(
        self,
        template: str,
        base: str,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """未編集の雛形は `--dry-run` で reject される（#958 F-03 / #962）

        issue / comment 側と同じ厳しさ（em-dash サマリ + 未編集プレースホルダ
        検出）が pr にも適用されていることを CLI 経由で固定する。
        """
        file = _prepare_pr_template(template, tmp_path, monkeypatch)
        content = file.read_text(encoding="utf-8")
        content = content.replace('title: ""', 'title: "feat: テスト"', 1)
        content = content.replace('repository: ""', 'repository: "owner/repo"', 1)
        content = re.sub(r'^base:\s*"[^"]*"', f'base: "{base}"', content, count=1, flags=re.M)
        file.write_text(content, encoding="utf-8")

        argv = ["pr", "create", str(file), "--dry-run", "--no-issue-ref"]
        if template == "release":
            argv += ["--template", "release"]

        with (
            patch("cli.commands.pr.load_active_config", return_value=_pr_config()),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
        ):
            result = runner.invoke(app, argv)

        assert result.exit_code == 3, result.output
        assert "error: disallowed syntax" in result.output
        assert "unedited placeholder" in result.output

    @pytest.mark.parametrize(
        ("template", "base"),
        [("default", "develop-aist"), ("release", "main")],
    )
    def test_filled_template_passes(
        self,
        template: str,
        base: str,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """見出しサマリを埋めれば `--dry-run` を通過する"""
        file = _prepare_pr_template(template, tmp_path, monkeypatch)
        content = _fill_placeholders(file.read_text(encoding="utf-8"))
        content = content.replace('title: ""', 'title: "feat: テスト"', 1)
        content = content.replace('repository: ""', 'repository: "owner/repo"', 1)
        content = re.sub(r'^base:\s*"[^"]*"', f'base: "{base}"', content, count=1, flags=re.M)
        content = content.replace('screenshot: ""', 'screenshot: "表示は変わらない"', 1)
        file.write_text(content, encoding="utf-8")

        argv = ["pr", "create", str(file), "--dry-run", "--no-issue-ref"]
        if template == "release":
            argv += ["--template", "release"]

        with (
            patch("cli.commands.pr.load_active_config", return_value=_pr_config()),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
        ):
            result = runner.invoke(app, argv)

        assert result.exit_code == 0, result.output
        assert "dry-run: would create PR" in result.stderr

    def test_posted_body_has_no_leading_guide_comment(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """投稿される PR 本文に冒頭ガイドコメントが残らない（#958 F-02）"""
        file = _prepare_pr_template("default", tmp_path, monkeypatch)
        content = _fill_placeholders(file.read_text(encoding="utf-8"))
        content = content.replace('title: ""', 'title: "feat: テスト"', 1)
        content = content.replace('repository: ""', 'repository: "owner/repo"', 1)
        content = re.sub(r'^base:\s*"[^"]*"', 'base: "develop-aist"', content, count=1, flags=re.M)
        content = content.replace('screenshot: ""', 'screenshot: "表示は変わらない"', 1)
        file.write_text(content, encoding="utf-8")

        mock_client = MagicMock()
        mock_client.create_pull_request.return_value = {
            "number": 456,
            "html_url": "https://ghes.example.com/owner/repo/pull/456",
        }

        with (
            patch("cli.commands.pr.load_active_config", return_value=_pr_config()),
            patch("cli.commands.pr.GitHubClient", return_value=mock_client),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/123"),
            patch("cli.commands.pr._run_preflight_checks_or_exit"),
        ):
            result = runner.invoke(app, ["pr", "create", str(file), "--no-issue-ref"])

        assert result.exit_code == 0, result.output
        posted_body = mock_client.create_pull_request.call_args[1]["body"]
        assert "<!--" not in posted_body, f"冒頭ガイドコメントが投稿された:\n{posted_body}"
        assert _HEADING_PLACEHOLDER_RE.search(posted_body) is None


# 投稿本文の記法チェック（#962）


_VALID_PR_BODY = f"""## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト通過

pytest を全件流した。

- **単体テスト** — `run-tests.sh --scope=py` が 0 exit

## Risks — なし

- **影響範囲** — なし

Closes #962
"""


def _write_pr_file(tmp_path: Path, body: str, base: str = "develop-aist") -> Path:
    file = tmp_path / "pr.md"
    file.write_text(
        "---\n"
        'title: "feat: 記法チェック"\n'
        'repository: "owner/repo"\n'
        f'base: "{base}"\n'
        'head: ""\n'
        "draft: false\n"
        "---\n\n" + body,
        encoding="utf-8",
    )
    return file


class TestPrBodyStyleRejection:
    """pr create で記法違反が reject される（#962）"""

    def _invoke_dry_run(self, file: Path):
        with (
            patch("cli.commands.pr.load_active_config", return_value=_pr_config()),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/962"),
        ):
            return runner.invoke(app, ["pr", "create", str(file), "--dry-run"])

    def test_checkbox_is_rejected(self, tmp_path: Path) -> None:
        file = _write_pr_file(tmp_path, _VALID_PR_BODY + "\n- [ ] 残タスク\n")
        result = self._invoke_dry_run(file)

        assert result.exit_code == 3, result.output
        assert "error: disallowed syntax" in result.output
        assert "checkbox syntax" in result.output

    def test_placeholder_is_rejected(self, tmp_path: Path) -> None:
        file = _write_pr_file(tmp_path, _VALID_PR_BODY.replace("なし", "<残る懸念>", 1))
        result = self._invoke_dry_run(file)

        assert result.exit_code == 3, result.output
        assert "<残る懸念>" in result.output

    def test_clean_body_passes(self, tmp_path: Path) -> None:
        file = _write_pr_file(tmp_path, _VALID_PR_BODY)
        result = self._invoke_dry_run(file)

        assert result.exit_code == 0, result.output
        assert "dry-run: would create PR" in result.stderr

    def test_changelog_transcription_passes(self, tmp_path: Path) -> None:
        """release PR の Changes 転記にある `"<0.0.0"` 等が誤検知されない"""
        body = _VALID_PR_BODY.replace(
            "- **影響範囲** — なし",
            '- **影響範囲** — pecotv 全 package の engines "<0.0.0" + engine-strict は据え置き',
            1,
        )
        file = _write_pr_file(tmp_path, body)
        result = self._invoke_dry_run(file)

        assert result.exit_code == 0, result.output

    def test_fenced_and_html_notation_passes(self, tmp_path: Path) -> None:
        """フェンス内の `- [ ]`・許可 HTML タグ・autolink は通る"""
        body = _VALID_PR_BODY.replace(
            "Closes #962",
            "<details><summary>ログ</summary>\n\n```markdown\n- [ ] 雛形の例\n<未編集>\n```\n\n"
            "</details>\n\n<https://ghes.example.com/acme-labs/aist-plugin/issues/962>\n\n"
            "Closes #962",
            1,
        )
        file = _write_pr_file(tmp_path, body)
        result = self._invoke_dry_run(file)

        assert result.exit_code == 0, result.output


# PR タイトルの scope と変更した nx プロジェクトの比較

_SCOPE_ROOTS = {
    "pecot-workflow": NxProject("plugins/pecot-workflow", "p-w"),
    "pecot-visual": NxProject("plugins/pecot-visual", "p-v"),
}

_SCOPE_BODY = f"""## Summary — テスト用サマリ

テストのための変更内容。

{_IMG_LINE}

## Changes

なし

## Verified — テスト用本文

- テスト追加
- テストのため
- 特になし
- なし
- テスト実行

## Risks — なし

- なし
"""


def _nx_config(release_type: str | None = "nx") -> ProjectConfig:
    """MagicMock ではなく実物の ProjectConfig（比較の条件判定を実コードで通す）"""
    return ProjectConfig(
        host="ghes.example.com",
        owner="owner",
        workflow_suffix="t",
        project=Project(
            number=1,
            id="PVT",
            fields=ProjectFields(workflow=FieldOptions(id="F", options={"ready": "o"})),
        ),
        repositories=[
            Repository(
                owner="owner",
                name="repo",
                develop_branch="develop-aist",
                release_branch="main",
                release_type=release_type,  # type: ignore[arg-type]
            )
        ],
    )


class TestTitleScopeCheck:
    """nx のリポの通常 PR は、タイトルの scope が変更した nx プロジェクトと一致しないと止まる"""

    @pytest.fixture
    def toplevel(self, tmp_path: Path) -> Path:
        top = tmp_path / "top"
        top.mkdir()
        (top / "nx.json").write_text("{}", encoding="utf-8")
        return top

    def _invoke(
        self,
        tmp_path: Path,
        toplevel: Path,
        title: str,
        *,
        config: ProjectConfig | None = None,
        files: list[str] | None = None,
        roots: dict[str, str] | None = None,
        origin: tuple[str, str, str] | None = ("ghes.example.com", "owner", "repo"),
        direct: bool = False,
        base: str = "develop-aist",
    ) -> tuple[Any, MagicMock, MagicMock]:
        changed = ["plugins/pecot-workflow/cli/a.py"] if files is None else files
        roots_mock = MagicMock(return_value=_SCOPE_ROOTS if roots is None else roots)
        files_mock = MagicMock(return_value=changed)
        with (
            patch("cli.commands.pr.load_active_config", return_value=config or _nx_config()),
            patch("cli.commands.pr.origin_repo", return_value=origin),
            patch("cli.commands.pr.git_toplevel", return_value=toplevel),
            patch("cli.commands.pr.nx_projects", roots_mock),
            patch("cli.commands.pr.changed_files", files_mock),
            patch("cli.commands.pr.git_current_branch", return_value="feat/x/123"),
        ):
            if direct:
                args = [
                    "pr", "create", "-m", _SCOPE_BODY, "-t", title,
                    "-b", base, "-r", "owner/repo", "--dry-run",
                ]  # fmt: skip
            else:
                pr_file = tmp_path / "pr.md"
                pr_file.write_text(
                    f'---\ntitle: "{title}"\nrepository: "owner/repo"\nbase: "{base}"\n'
                    f'head: "feat/x/123"\ndraft: false\n---\n\n{_SCOPE_BODY}',
                    encoding="utf-8",
                )
                args = ["pr", "create", str(pr_file), "--dry-run"]
            result = runner.invoke(app, args)
        return result, roots_mock, files_mock

    @pytest.mark.parametrize("direct", [False, True], ids=["file", "message"])
    def test_mismatched_scope_is_rejected(
        self, tmp_path: Path, toplevel: Path, direct: bool
    ) -> None:
        result, _, files_mock = self._invoke(
            tmp_path, toplevel, "feat(pecot): #123 テスト", direct=direct
        )

        assert result.exit_code == 3
        assert (
            "error: PR title scope must be p-w "
            "(given: pecot; computed from the tags of the changed nx projects)"
        ) in result.stderr
        assert "dry-run: would create PR" not in result.stderr
        files_mock.assert_called_once_with(toplevel, "origin/develop-aist", "feat/x/123")

    @pytest.mark.parametrize("direct", [False, True], ids=["file", "message"])
    def test_missing_scope_is_rejected(self, tmp_path: Path, toplevel: Path, direct: bool) -> None:
        result, _, _ = self._invoke(tmp_path, toplevel, "feat: #123 テスト", direct=direct)

        assert result.exit_code == 3
        assert "PR title scope must be p-w" in result.output
        assert "(given: none;" in result.output

    @pytest.mark.parametrize("direct", [False, True], ids=["file", "message"])
    def test_matching_scope_passes(self, tmp_path: Path, toplevel: Path, direct: bool) -> None:
        result, _, _ = self._invoke(tmp_path, toplevel, "feat(p-w): #123 テスト", direct=direct)

        assert result.exit_code == 0, result.output
        assert "dry-run: would create PR" in result.stderr
        assert "scope" not in result.output

    def test_full_project_name_is_rejected(self, tmp_path: Path, toplevel: Path) -> None:
        result, _, _ = self._invoke(tmp_path, toplevel, "feat(pecot-workflow): #123 テスト")

        assert result.exit_code == 3
        assert "PR title scope must be p-w" in result.output
        assert "(given: pecot-workflow;" in result.output

    def test_multiple_projects_match_in_any_order(self, tmp_path: Path, toplevel: Path) -> None:
        files = ["plugins/pecot-workflow/a.py", "plugins/pecot-visual/b.ts"]
        ok, _, _ = self._invoke(tmp_path, toplevel, "feat(p-w,p-v): #123 x", files=files)
        ng, _, _ = self._invoke(tmp_path, toplevel, "feat(p-w, p-v): #123 x", files=files)

        assert ok.exit_code == 0, ok.output
        assert ng.exit_code == 3
        assert "must be p-v,p-w" in ng.output

    def test_file_outside_projects_requires_repo(self, tmp_path: Path, toplevel: Path) -> None:
        files = ["plugins/pecot-workflow/a.py", "CLAUDE.md"]
        ng, _, _ = self._invoke(tmp_path, toplevel, "feat(p-w): #123 x", files=files)
        ok, _, _ = self._invoke(tmp_path, toplevel, "feat(p-w,repo): #123 x", files=files)

        assert ng.exit_code == 3
        assert "must be p-w,repo" in ng.output
        assert ok.exit_code == 0, ok.output

    @pytest.mark.parametrize(
        "files", [[], [".nx/version-plans/1-x.md"]], ids=["empty", "version-plan-only"]
    )
    def test_nothing_to_compare_passes(
        self, tmp_path: Path, toplevel: Path, files: list[str]
    ) -> None:
        result, _, _ = self._invoke(tmp_path, toplevel, "feat(pecot): #123 x", files=files)

        assert result.exit_code == 0, result.output

    @pytest.mark.parametrize("release_type", ["single", "multi", None])
    def test_non_nx_repo_is_not_checked(
        self, tmp_path: Path, toplevel: Path, release_type: str | None
    ) -> None:
        result, roots_mock, files_mock = self._invoke(
            tmp_path, toplevel, "feat(whatever): #123 x", config=_nx_config(release_type)
        )

        assert result.exit_code == 0, result.output
        roots_mock.assert_not_called()
        files_mock.assert_not_called()
        _assert_no_symbols(result)

    def test_unresolvable_nx_warns_and_passes(self, tmp_path: Path, toplevel: Path) -> None:
        result, roots_mock, _ = self._invoke(tmp_path, toplevel, "feat(pecot): #123 x")
        assert result.exit_code == 3  # 対照: 判定できるときは止まる

        with (
            patch("cli.commands.pr.load_active_config", return_value=_nx_config()),
            patch("cli.commands.pr.origin_repo", return_value=("h", "owner", "repo")),
            patch("cli.commands.pr.git_toplevel", return_value=toplevel),
            patch("cli.commands.pr.nx_projects", return_value=None),
            patch("cli.commands.pr.changed_files") as files_mock,
        ):
            pr_file = tmp_path / "pr2.md"
            pr_file.write_text(
                '---\ntitle: "feat(pecot): #123 x"\nrepository: "owner/repo"\n'
                'base: "develop-aist"\nhead: "feat/x/123"\ndraft: false\n---\n\n' + _SCOPE_BODY,
                encoding="utf-8",
            )
            skipped = runner.invoke(app, ["pr", "create", str(pr_file), "--dry-run"])

        assert skipped.exit_code == 0, skipped.output
        assert "warning: cannot read nx projects or the diff" in skipped.output
        files_mock.assert_not_called()
        assert roots_mock.call_count == 1

    def test_unresolvable_diff_warns_and_passes(self, tmp_path: Path, toplevel: Path) -> None:
        with (
            patch("cli.commands.pr.load_active_config", return_value=_nx_config()),
            patch("cli.commands.pr.origin_repo", return_value=("h", "owner", "repo")),
            patch("cli.commands.pr.git_toplevel", return_value=toplevel),
            patch("cli.commands.pr.nx_projects", return_value=_SCOPE_ROOTS),
            patch("cli.commands.pr.changed_files", return_value=None),
        ):
            pr_file = tmp_path / "pr3.md"
            pr_file.write_text(
                '---\ntitle: "feat(pecot): #123 x"\nrepository: "owner/repo"\n'
                'base: "develop-aist"\nhead: "feat/x/123"\ndraft: false\n---\n\n' + _SCOPE_BODY,
                encoding="utf-8",
            )
            result = runner.invoke(app, ["pr", "create", str(pr_file), "--dry-run"])

        assert result.exit_code == 0, result.output
        assert "warning: cannot read nx projects or the diff" in result.output

    def test_release_template_is_not_checked(self, toplevel: Path) -> None:
        from cli.commands.pr import _title_scope_errors

        with (
            patch("cli.commands.pr.origin_repo", return_value=("h", "owner", "repo")),
            patch("cli.commands.pr.git_toplevel", return_value=toplevel),
            patch("cli.commands.pr.nx_projects") as roots_mock,
        ):
            errors = _title_scope_errors(
                _nx_config(), "owner", "repo", "release: v1", "main", "develop-aist",
                toplevel, Output(False), template="release",
            )  # fmt: skip

        assert errors == []
        roots_mock.assert_not_called()

    def test_release_pr_by_branches_is_not_checked(self, toplevel: Path) -> None:
        from cli.commands.pr import _title_scope_errors

        with patch("cli.commands.pr.nx_projects") as roots_mock:
            errors = _title_scope_errors(
                _nx_config(),
                "owner",
                "repo",
                "release: v1",
                "main",
                "develop-aist",
                toplevel,
                Output(False),
            )

        assert errors == []
        roots_mock.assert_not_called()

    def test_base_other_than_develop_is_not_checked(self, tmp_path: Path, toplevel: Path) -> None:
        result, roots_mock, _ = self._invoke(
            tmp_path, toplevel, "feat(pecot): #123 x", base="some-other"
        )

        assert "PR title scope" not in result.output
        roots_mock.assert_not_called()

    def test_origin_mismatch_is_not_checked(self, tmp_path: Path, toplevel: Path) -> None:
        result, roots_mock, _ = self._invoke(
            tmp_path, toplevel, "feat(pecot): #123 x", origin=("h", "other", "repo")
        )

        assert result.exit_code == 0, result.output
        roots_mock.assert_not_called()

    def test_no_origin_is_not_checked(self, tmp_path: Path, toplevel: Path) -> None:
        result, roots_mock, _ = self._invoke(tmp_path, toplevel, "feat(pecot): #123 x", origin=None)

        assert result.exit_code == 0, result.output
        roots_mock.assert_not_called()

    def test_toplevel_without_nx_json_is_not_checked(self, tmp_path: Path) -> None:
        bare = tmp_path / "bare"
        bare.mkdir()
        result, roots_mock, _ = self._invoke(tmp_path, bare, "feat(pecot): #123 x")

        assert result.exit_code == 0, result.output
        roots_mock.assert_not_called()

    def test_magicmock_config_does_not_trigger_check(self, tmp_path: Path) -> None:
        """既存テストの MagicMock config は `== "nx"` が偽になり、git / nx を呼ばない"""
        from cli.commands.pr import _title_scope_errors

        config = MagicMock()
        config.get_develop_branch.return_value = "develop-aist"
        config.get_release_branch.return_value = None
        with (
            patch("cli.commands.pr.origin_repo") as origin_mock,
            patch("cli.commands.pr.nx_projects") as roots_mock,
        ):
            errors = _title_scope_errors(
                config,
                "owner",
                "repo",
                "feat: x",
                "develop-aist",
                "feat/x/1",
                tmp_path,
                Output(False),
            )

        assert errors == []
        origin_mock.assert_not_called()
        roots_mock.assert_not_called()


class TestPrepareScopeGuidance:
    """--prepare は比較の条件を満たすとき、算出した scope を title の行のコメントに書く"""

    def _prepare(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        config: ProjectConfig,
        *,
        roots: dict[str, str] | None = None,
        files: list[str] | None = None,
    ) -> Any:
        import cli.commands.pr as pr_module

        top = tmp_path / "top"
        top.mkdir(exist_ok=True)
        (top / "nx.json").write_text("{}", encoding="utf-8")
        monkeypatch.setattr(pr_module, "get_output_dir", lambda: tmp_path / "out")
        with (
            patch("cli.commands.pr.load_active_config", return_value=config),
            patch("cli.commands.pr.origin_repo", return_value=("h", "owner", "repo")),
            patch("cli.commands.pr.git_toplevel", return_value=top),
            patch("cli.commands.pr.git_current_branch", return_value="feat/x/123"),
            patch("cli.commands.pr.nx_projects", return_value=roots or _SCOPE_ROOTS),
            patch(
                "cli.commands.pr.changed_files",
                return_value=files or ["plugins/pecot-workflow/a.py", "plugins/pecot-visual/b.ts"],
            ),
        ):
            return runner.invoke(app, ["pr", "create", "--prepare"])

    def test_shows_computed_scope_for_nx_repo(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        result = self._prepare(tmp_path, monkeypatch, _nx_config())

        assert result.exit_code == 0, result.output
        assert "set: title scope hint to p-v,p-w" in result.output

    def test_no_scope_line_for_non_nx_repo(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        result = self._prepare(tmp_path, monkeypatch, _nx_config("single"))

        assert result.exit_code == 0, result.output
        assert "scope:" not in result.output


# Summary の画像か screenshot の理由を求める検証（#183）

_NO_IMAGE_BODY = _VALID_PR_BODY.replace(f"{_IMG_LINE}\n", "", 1)
assert _NO_IMAGE_BODY != _VALID_PR_BODY


class TestScreenshotDecision:
    """画像と、入れない理由のどちらも無い本文は exit 3 で止まる"""

    def _file(self, tmp_path: Path, body: str, screenshot: str | None = None) -> Path:
        shot = "" if screenshot is None else f"screenshot: {screenshot}\n"
        file = tmp_path / "pr.md"
        file.write_text(
            "---\n"
            'title: "feat: 画像"\n'
            'repository: "owner/repo"\n'
            'base: "develop-aist"\n'
            'head: ""\n'
            "draft: false\n"
            f"{shot}"
            "---\n\n" + body,
            encoding="utf-8",
        )
        return file

    def _run(self, args: list[str], config: MagicMock | None = None):
        with (
            patch("cli.commands.pr.load_active_config", return_value=config or _pr_config()),
            patch("cli.commands.pr.git_current_branch", return_value="feat/test/183"),
        ):
            return runner.invoke(app, ["pr", "create", *args, "--dry-run"])

    def test_no_image_no_reason_is_rejected(self, tmp_path: Path) -> None:
        result = self._run([str(self._file(tmp_path, _NO_IMAGE_BODY))])

        assert result.exit_code == 3, result.output
        assert "Summary has no image" in result.output
        assert "`![alt](./<file>.png)`" in result.output
        assert "`screenshot`" in result.output

    @pytest.mark.parametrize(
        "image",
        [
            "![x](./x.png)",
            "![x][ref]\n\n[ref]: ./x.png",
            '<IMG src="./x.png">',
            "![x](https://github.com/user-attachments/assets/abc)",
        ],
    )
    def test_summary_image_passes(self, tmp_path: Path, image: str) -> None:
        body = _NO_IMAGE_BODY.replace(
            "テストのための変更内容。", f"テストのための変更内容。\n\n{image}", 1
        )
        result = self._run([str(self._file(tmp_path, body))])

        assert result.exit_code == 0, result.output

    def test_reason_passes_without_image(self, tmp_path: Path) -> None:
        file = self._file(tmp_path, _NO_IMAGE_BODY, '"CLI の出力は変わらない"')
        result = self._run([str(file)])

        assert result.exit_code == 0, result.output

    @pytest.mark.parametrize("value", ['""', '"   "'])
    def test_blank_reason_is_rejected(self, tmp_path: Path, value: str) -> None:
        result = self._run([str(self._file(tmp_path, _NO_IMAGE_BODY, value))])

        assert result.exit_code == 3, result.output
        assert "Summary has no image" in result.output

    def _direct(self, body: str, *extra: str) -> list[str]:
        return ["-m", body, "-t", "feat: 画像", "-b", "develop-aist", "-r", "owner/repo", *extra]

    def test_direct_message_without_reason_is_rejected(self) -> None:
        result = self._run(self._direct(_NO_IMAGE_BODY))

        assert result.exit_code == 3, result.output
        assert "--screenshot" in result.output

    def test_direct_message_with_screenshot_option_passes(self) -> None:
        result = self._run(self._direct(_NO_IMAGE_BODY, "--screenshot", "表示は変わらない"))

        assert result.exit_code == 0, result.output

    def test_direct_message_with_blank_screenshot_option_is_rejected(self) -> None:
        result = self._run(self._direct(_NO_IMAGE_BODY, "--screenshot", "  "))

        assert result.exit_code == 3, result.output

    def test_release_template_is_exempt(self) -> None:
        body = TestValidatePRContentRelease()._make_release_body()
        errors = _validate_pr_content(
            body,
            "release: v0.5.0",
            "main",
            "develop-aist",
            template="release",
            release_branch="main",
        )
        assert SCREENSHOT_MISSING_ERROR not in errors

    def test_develop_to_release_default_template_is_exempt(self) -> None:
        body = TestValidatePRContentRelease()._make_release_body()
        errors = _validate_pr_content(
            body,
            "release: v0.5.0",
            "main",
            "develop-aist",
            release_branch="main",
            head="develop-aist",
        )
        assert SCREENSHOT_MISSING_ERROR not in errors

    def test_ordinary_pr_without_image_gets_the_error(self) -> None:
        errors = _validate_pr_content(
            _NO_IMAGE_BODY, "feat: x", "develop-aist", "develop-aist", release_branch="main"
        )
        assert errors == [SCREENSHOT_MISSING_ERROR]

    def test_release_accepts_screenshot_frontmatter(self, tmp_path: Path) -> None:
        body = TestValidatePRContentRelease()._make_release_body()
        file = tmp_path / "pr.md"
        file.write_text(
            '---\ntitle: "release: v0.5.0"\nrepository: "owner/repo"\nbase: "main"\n'
            'head: "develop-aist"\ndraft: false\nscreenshot: "不要"\n---\n\n' + body,
            encoding="utf-8",
        )
        result = self._run([str(file), "--template", "release"])

        assert result.exit_code == 0, result.output

    def test_release_accepts_screenshot_option(self) -> None:
        body = TestValidatePRContentRelease()._make_release_body()
        result = self._run(
            [
                "-m",
                body,
                "-t",
                "release: v0.5.0",
                "-b",
                "main",
                "-r",
                "owner/repo",
                "--template",
                "release",
                "--screenshot",
                "不要",
            ]
        )

        assert result.exit_code == 0, result.output

    def test_file_form_rejects_screenshot_option(self, tmp_path: Path) -> None:
        result = self._run([str(self._file(tmp_path, _NO_IMAGE_BODY)), "--screenshot", "不要"])

        assert result.exit_code == 1, result.output
        assert "--screenshot is for -m" in result.output
        assert "`screenshot`" in result.output

    def test_release_with_unset_release_branch_exits_1(self) -> None:
        config = _pr_config()
        config.get_release_branch.return_value = None
        body = TestValidatePRContentRelease()._make_release_body()
        result = self._run(
            [
                "-m",
                body,
                "-t",
                "release: v0.5.0",
                "-b",
                "main",
                "-r",
                "owner/repo",
                "--template",
                "release",
            ],
            config,
        )

        assert result.exit_code == 1, result.output
        assert "release_branch is not set" in result.output
        assert "Summary has no image" not in result.output

    def test_direct_with_unset_develop_branch_exits_1(self) -> None:
        config = _pr_config()
        config.get_develop_branch.return_value = None
        result = self._run(self._direct(_NO_IMAGE_BODY), config)

        assert result.exit_code == 1, result.output
        assert "develop_branch is not set" in result.output
        assert "Summary has no image" not in result.output

    def test_missing_section_and_missing_image_are_listed_together(self, tmp_path: Path) -> None:
        body = _NO_IMAGE_BODY.replace("## Risks", "## Other", 1)
        result = self._run([str(self._file(tmp_path, body))])

        assert result.exit_code == 3, result.output
        assert "missing sections" in result.output
        assert "Summary has no image" in result.output

    def test_unset_develop_branch_exits_1_before_validation(self, tmp_path: Path) -> None:
        config = _pr_config()
        config.get_develop_branch.return_value = None
        result = self._run([str(self._file(tmp_path, _NO_IMAGE_BODY))], config)

        assert result.exit_code == 1, result.output
        assert "develop_branch is not set" in result.output
        assert "Summary has no image" not in result.output


# 出力の行（#211）。stdout はデータだけ、それ以外は stderr の英語の行


_SYMBOLS = ("✔", "⚠", "★")


def _assert_no_symbols(result: Any) -> None:
    for symbol in _SYMBOLS:
        assert symbol not in result.stdout
        assert symbol not in result.stderr


def _line_config() -> MagicMock:
    config = _pr_config()
    config.get_release_branch.return_value = None
    return config


class TestPrCreateOutputLines:
    """pr create の行が、共通の関数を通った英語の 1 事柄 1 行になる"""

    def _file(self, tmp_path: Path) -> Path:
        return _write_pr_file(tmp_path, _VALID_PR_BODY + "\nCloses #12\n")

    def test_dry_run_prints_plan_lines_only_on_stderr(self, tmp_path: Path) -> None:
        with (
            patch("cli.commands.pr.load_active_config", return_value=_line_config()),
            patch("cli.commands.pr.git_current_branch", return_value="feat/demo/12"),
        ):
            result = runner.invoke(app, ["pr", "create", str(self._file(tmp_path)), "--dry-run"])

        assert result.exit_code == 0, result.stderr
        assert result.stdout == ""
        assert result.stderr.splitlines() == [
            "dry-run: would create PR owner/repo feat/demo/12 -> develop-aist: feat: 記法チェック",
            "dry-run: would set Issue #12 status to In Review",
        ]

    def test_dry_run_of_release_pr_does_not_plan_the_status_update(self, tmp_path: Path) -> None:
        config = _line_config()
        config.get_release_branch.return_value = "main"
        body = _VALID_PR_BODY.replace("## Risks", "## Migration", 1)
        file = _write_pr_file(tmp_path, body, base="main")
        with (
            patch("cli.commands.pr.load_active_config", return_value=config),
            patch("cli.commands.pr.git_current_branch", return_value="develop-aist"),
        ):
            result = runner.invoke(
                app, ["pr", "create", str(file), "--dry-run", "--template", "release"]
            )

        assert result.stdout == ""
        lines = result.stderr.splitlines()
        assert lines[-1].startswith("dry-run: would create PR owner/repo develop-aist -> main:")
        assert lines[-1].endswith("(release template)")
        assert not any("status" in line for line in lines)

    def test_validation_errors_are_one_error_line_each(self, tmp_path: Path) -> None:
        body = _VALID_PR_BODY.replace("## Risks", "## Other", 1) + "\nCloses #12\n"
        file = _write_pr_file(tmp_path, body, base="develop")
        with (
            patch("cli.commands.pr.load_active_config", return_value=_line_config()),
            patch("cli.commands.pr.git_current_branch", return_value="feat/demo/12"),
        ):
            result = runner.invoke(app, ["pr", "create", str(file), "--dry-run"])

        assert result.exit_code == 3
        assert result.stdout == ""
        assert "error: missing sections: ## Risks" in result.stderr.splitlines()
        assert "error: base branch must be develop-aist (given: develop)" in result.stderr
        _assert_no_symbols(result)

    def test_submit_prints_url_on_stdout_and_created_before_set(self, tmp_path: Path) -> None:
        client = MagicMock()
        client.create_pull_request.return_value = {
            "number": 21,
            "html_url": "https://github.com/owner/repo/pull/21",
        }
        client.get_item_id_by_issue.return_value = "ITEM"
        config = _line_config()
        config.get_option_id.return_value = "OPT"
        config.get_field_id.return_value = "FIELD"
        with (
            patch("cli.commands.pr.load_active_config", return_value=config),
            patch("cli.commands.pr.GitHubClient", return_value=client),
            patch("cli.commands.pr.git_current_branch", return_value="feat/demo/12"),
            patch("cli.commands.pr._run_preflight_checks_or_exit"),
            patch("cli.commands.pr.consume_flag"),
        ):
            result = runner.invoke(app, ["pr", "create", str(self._file(tmp_path))])

        assert result.exit_code == 0, result.stderr
        assert result.stdout == "https://github.com/owner/repo/pull/21\n"
        assert result.stderr.splitlines() == [
            "created: PR owner/repo feat/demo/12 -> develop-aist: feat: 記法チェック",
            "set: Issue #12 status to In Review",
        ]

    def test_missing_board_item_is_a_warning_and_exit_stays_0(self, tmp_path: Path) -> None:
        client = MagicMock()
        client.create_pull_request.return_value = {"number": 21, "html_url": "https://x/pull/21"}
        client.get_item_id_by_issue.return_value = None
        with (
            patch("cli.commands.pr.load_active_config", return_value=_line_config()),
            patch("cli.commands.pr.GitHubClient", return_value=client),
            patch("cli.commands.pr.git_current_branch", return_value="feat/demo/12"),
            patch("cli.commands.pr._run_preflight_checks_or_exit"),
            patch("cli.commands.pr.consume_flag"),
        ):
            result = runner.invoke(app, ["pr", "create", str(self._file(tmp_path))])

        assert result.exit_code == 0
        assert "warning: Issue #12 is not on the board; status not updated" in result.stderr
        assert result.stdout == "https://x/pull/21\n"


class TestPrPrepareOutputLines:
    def test_scope_hint_is_a_yaml_comment_on_the_title_line(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from cli.core.frontmatter import parse_pr_content

        monkeypatch.setenv("PECOT_WORK_DIR", str(tmp_path))
        config = _line_config()
        with (
            patch("cli.commands.pr.origin_repo", return_value=("github.com", "owner", "repo")),
            patch("cli.commands.pr.load_active_config", return_value=config),
            patch("cli.commands.pr._nx_scope_toplevel", return_value=tmp_path),
            patch("cli.commands.pr.git_current_branch", return_value="feat/demo/12"),
            patch("cli.commands.pr._expected_title_scope", return_value=["p-w", "repo"]),
            patch("cli.commands.pr._fill_closes_in_template", side_effect=lambda c, *_a: c),
            patch("cli.commands.pr.get_output_dir", return_value=tmp_path),
        ):
            result = runner.invoke(app, ["pr", "create", "--prepare"])

        assert result.exit_code == 0, result.stderr
        path = Path(result.stdout.strip())
        assert result.stdout == f"{path}\n"
        assert result.stderr.splitlines() == [
            "set: base to develop-aist",
            "set: title scope hint to p-w,repo",
        ]
        content = path.read_text(encoding="utf-8")
        assert re.search(r'^title: ""  # expected scope: p-w,repo$', content, re.MULTILINE)
        assert len(re.findall(r"^title:.*# expected scope:", content, re.MULTILINE)) == 1
        assert parse_pr_content(content).frontmatter.title == ""


def _merged_pr(head: str = "feat/demo/12") -> dict[str, Any]:
    return {
        "number": 21,
        "state": "MERGED",
        "title": "feat: demo",
        "body": "Closes #12",
        "head_ref": head,
        "base_ref": "develop-aist",
        "closing_issues": [],
    }


def _cleanup_client(head: str = "feat/demo/12") -> MagicMock:
    client = MagicMock()
    client.get_pull_request_slim.return_value = _merged_pr(head)
    client.get_issue_kind.side_effect = lambda _o, _r, n: _kind_task(n)
    return client


class TestPrCleanupOutputLines:
    def _run(self, args: list[str], client: MagicMock, **patches: Any) -> Any:
        config = _line_config()
        with (
            patch("cli.commands.pr.load_active_config", return_value=config),
            patch("cli.commands.pr.GitHubClient", return_value=client),
            patch("cli.commands.pr.git_current_branch", return_value="feat/demo/12"),
            patch(
                "cli.commands.pr.git_remote_url", return_value="https://github.com/owner/repo.git"
            ),
            patch("cli.core.worktree.is_worktree_env", return_value=True),
            patch("cli.core.worktree.get_current_worktree_name", return_value="wt7"),
            patch("cli.commands.pr.run_git") as run_git,
            patch("cli.commands.pr._remove_active_flags") as remove_flags,
            patch("cli.commands.pr.consume_flag") as consume,
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/21", *args])
        result.run_git = run_git
        result.remove_flags = remove_flags
        result.consume = consume
        return result

    def test_dry_run_lists_plans_and_touches_nothing(self) -> None:
        client = _cleanup_client()
        result = self._run(["--dry-run", "--delete-branch"], client)

        assert result.exit_code == 0, result.stderr
        assert result.stdout == ""
        assert result.stderr.splitlines() == [
            "count: Issues to close: 1",
            "dry-run: would close Issue #12",
            "dry-run: would delete remote branch feat/demo/12",
            "dry-run: would set current branch to wt7",
            "dry-run: would update wt7 from origin/develop-aist",
            "dry-run: would delete local branch feat/demo/12",
        ]
        client.close_issue.assert_not_called()
        client.delete_branch.assert_not_called()
        result.run_git.assert_not_called()
        result.remove_flags.assert_not_called()
        result.consume.assert_not_called()

    def test_real_run_prints_results_in_execution_order(self) -> None:
        client = _cleanup_client()
        result = self._run(["--delete-branch"], client)

        assert result.exit_code == 0, result.stderr
        assert result.stdout == ""
        assert result.stderr.splitlines() == [
            "count: Issues to close: 1",
            "closed: Issue #12",
            "deleted: remote branch feat/demo/12",
            "deleted: remote branch wip/feat/demo/12",
            "set: current branch to wt7",
            "updated: wt7 from origin/develop-aist",
            "deleted: local branch feat/demo/12",
        ]
        assert "dry-run:" not in result.stderr
        _assert_no_symbols(result)

    def test_checkout_failure_stops_pull_and_branch_delete_but_exit_stays_0(self) -> None:
        client = _cleanup_client()
        config = _line_config()
        with (
            patch("cli.commands.pr.load_active_config", return_value=config),
            patch("cli.commands.pr.GitHubClient", return_value=client),
            patch("cli.commands.pr.git_current_branch", return_value="feat/demo/12"),
            patch(
                "cli.commands.pr.git_remote_url", return_value="https://github.com/owner/repo.git"
            ),
            patch("cli.core.worktree.is_worktree_env", return_value=True),
            patch("cli.core.worktree.get_current_worktree_name", return_value="wt7"),
            patch(
                "cli.commands.pr.run_git",
                side_effect=subprocess.CalledProcessError(1, "git checkout"),
            ),
            patch("cli.commands.pr._remove_active_flags"),
            patch("cli.commands.pr.consume_flag"),
        ):
            result = runner.invoke(app, ["pr", "cleanup", "owner/repo/21"])

        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        assert any(line.startswith("warning: checking out wt7 failed:") for line in lines)
        assert not any("origin/" in line and line.startswith("updated:") for line in lines)
        assert not any("local branch" in line for line in lines)
        assert not any(line.startswith("set: current branch") for line in lines)

    def test_already_closed_issue_is_unchanged(self) -> None:
        from cli.core.github import GitHubAPIError

        client = _cleanup_client()
        client.close_issue.side_effect = GitHubAPIError(
            "x", status_code=422, response_body="closed by another request"
        )
        result = self._run(["--skip-local-cleanup"], client)

        assert "unchanged: Issue #12 (already closed)" in result.stderr.splitlines()

    def test_epic_is_skipped_and_judged_before_dry_run(self) -> None:
        client = _cleanup_client()
        client.get_issue_kind.side_effect = lambda _o, _r, n: {
            "number": n,
            "state": "OPEN",
            "issue_type": "Epic",
            "sub_issues_total": 0,
        }
        result = self._run(["--dry-run", "--skip-local-cleanup"], client)

        assert result.stderr.splitlines() == [
            "count: Issues to close: 0",
            "dry-run: would skip closing Issue #12 (Epic)",
        ]
        client.get_issue_kind.assert_called()

    def test_not_merged_is_one_error_line(self) -> None:
        client = _cleanup_client()
        client.get_pull_request_slim.return_value["state"] = "OPEN"
        result = self._run([], client)

        assert result.exit_code == 1
        assert result.stderr.splitlines() == [
            "error: PR #21 is not merged yet (state: OPEN); merge it with gh pr merge first"
        ]


class TestPrPreflightOutputLines:
    def _run(self, tmp_path: Path, *, pushed: bool, push_message: str, stash: str) -> Any:
        config = MagicMock()
        config.get_develop_branch.return_value = "develop-aist"
        with (
            patch("cli.commands.pr.git_toplevel", return_value=tmp_path),
            patch(
                "cli.commands.pr.git_remote_url", return_value="https://github.com/owner/repo.git"
            ),
            patch("cli.commands.pr.git_current_branch", return_value="feat/demo/12"),
            patch("cli.commands.pr.load_active_config", return_value=config),
            patch("cli.commands.pr._branch_exists", return_value=True),
            patch("cli.commands.pr._get_push_status", return_value=(pushed, push_message)),
            patch(
                "cli.commands.pr._get_git_status",
                return_value="On branch x\nmodified: a.py\n",
            ),
            patch("cli.commands.pr._read_gitignore", return_value="*.pyc"),
            patch("cli.commands.pr._read_git_exclude", return_value="# exclude"),
            patch("cli.commands.pr._get_commits_vs_base", return_value="abc test"),
            patch("cli.commands.pr._get_diff_summary", return_value="1 file changed"),
            patch("cli.commands.pr._get_worktree_info", return_value="worktree info"),
            patch("cli.commands.pr._get_stash_list", return_value=stash),
        ):
            return runner.invoke(app, ["pr", "preflight", "-D", str(tmp_path)])

    def test_warnings_go_to_stderr_and_sections_stay_on_stdout(self, tmp_path: Path) -> None:
        result = self._run(
            tmp_path, pushed=False, push_message="2 unpushed commits", stash="stash@{0}: WIP"
        )

        assert result.exit_code == 2
        assert result.stderr.splitlines() == [
            "count: preflight warnings: 3",
            "warning: Push Status: 2 unpushed commits (fix: git push)",
            "warning: Git Status: modified or untracked files (fix: commit)",
            "warning: Stash List: 1 stash entries (fix: check them)",
        ]
        assert "=== Push Status ===\n2 unpushed commits\n" in result.stdout
        assert "=== Stash List ===\nstash@{0}: WIP\n" in result.stdout
        assert "=== Summary ===" not in result.stdout
        _assert_no_symbols(result)
