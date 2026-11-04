"""tests/cli/test_template_hygiene.py - 配布テンプレ雛形の記法ガード

`--prepare` が生成する雛形（issue 4 種 / comment 6 種 / pr 2 種）の本文部を確認する。
本文部とは、冒頭 `読者:/書き方:/フィールド:` コメントの終端 `-->` より後ろの部分を指す。
投稿時の検証器から弾かれる記法が残っていないことを固定する。
冒頭コメントは禁止記法を名指しで説明するため対象外にする。

- 未編集プレースホルダ以外の記法違反（チェックボックス・水平線・絵文字。#958 / #1185）
- 本文内の HTML 指示コメント `<!--`
"""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from cli.commands.main import app
from cli.core.sections import validate_body_style

runner = CliRunner()

# (テストID, prepare する CLI 引数, 生成物の glob, monkeypatch 対象モジュール名)
PREPARE_CASES: list[tuple[str, list[str], str, str]] = [
    (
        "issue-task",
        ["issue", "create", "--prepare", "--template", "task", "--repo", "owner/repo"],
        "issue-task-*.md",
        "cli.commands.issue",
    ),
    (
        "issue-bug",
        ["issue", "create", "--prepare", "--template", "bug", "--repo", "owner/repo"],
        "issue-bug-*.md",
        "cli.commands.issue",
    ),
    (
        "issue-epic",
        ["issue", "create", "--prepare", "--template", "epic"],
        "issue-epic-*.md",
        "cli.commands.issue",
    ),
    (
        "issue-task-implement",
        [
            "issue",
            "create",
            "--prepare",
            "--template",
            "task-implement",
            "--repo",
            "owner/repo",
        ],
        "issue-task-implement-*.md",
        "cli.commands.issue",
    ),
    (
        "comment-plan",
        ["issue", "comment", "--prepare", "-t", "plan", "--issue", "owner/repo/1"],
        "comment-plan-*.md",
        "cli.commands.issue",
    ),
    (
        "comment-merge-diff",
        ["issue", "comment", "--prepare", "-t", "merge-diff", "--issue", "owner/repo/1"],
        "comment-merge-diff-*.md",
        "cli.commands.issue",
    ),
    (
        "comment-precede-notify",
        ["issue", "comment", "--prepare", "-t", "precede-notify", "--issue", "owner/repo/1"],
        "comment-precede-notify-*.md",
        "cli.commands.issue",
    ),
    (
        "comment-review-findings",
        ["issue", "comment", "--prepare", "-t", "review-findings", "--issue", "owner/repo/1"],
        "comment-review-findings-*.md",
        "cli.commands.issue",
    ),
    (
        "comment-review-resolution",
        ["issue", "comment", "--prepare", "-t", "review-resolution", "--issue", "owner/repo/1"],
        "comment-review-resolution-*.md",
        "cli.commands.issue",
    ),
    (
        "pr-create",
        ["pr", "create", "--prepare"],
        "pr-create-*.md",
        "cli.commands.pr",
    ),
    (
        "pr-release",
        ["pr", "create", "--prepare", "--template", "release"],
        "pr-release-*.md",
        "cli.commands.pr",
    ),
]


def _no_network_client(*args: object, **kwargs: object) -> object:
    """`--prepare` の処理中に GitHub API へ出ようとしたら失敗させるスタブ"""
    raise AssertionError("--prepare は GitHub API に到達してはならない")


def _body_after_leading_comment(content: str) -> str:
    """冒頭の指示コメント（最初の `-->` まで）を落とした残りを返す"""
    marker = "-->"
    index = content.find(marker)
    if index == -1:
        return content
    return content[index + len(marker) :]


@pytest.mark.parametrize(
    ("case_id", "argv", "glob", "module_name"),
    PREPARE_CASES,
    ids=[case[0] for case in PREPARE_CASES],
)
def test_prepared_template_body_has_no_forbidden_notation_or_inline_comment(
    case_id: str,
    argv: list[str],
    glob: str,
    module_name: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`--prepare` 生成物の本文部に記法違反と HTML コメントが無い

    雛形の `<...>` プレースホルダは利用者が埋める前提なので、検証器のエラーから
    プレースホルダ分だけを除いて判定する。
    """
    import importlib

    module = importlib.import_module(module_name)
    output_dir = tmp_path / "pecot"
    monkeypatch.setattr(module, "get_output_dir", lambda: output_dir)
    if module_name == "cli.commands.pr":
        monkeypatch.setattr(module, "load_active_config", lambda: None)
        # Closes 自動埋め込みは雛形の記法確認に無関係。
        # 素通しに差し替え、host 未指定の GitHubClient が api.github.com を叩くのを止める（#958 F-04）。
        monkeypatch.setattr(
            module,
            "_fill_closes_in_template",
            lambda content, *args, **kwargs: content,
        )
    # 生成物は配布テンプレのコピーのみ。ネットワークに出たら即失敗させる。
    monkeypatch.setattr(
        module,
        "GitHubClient",
        _no_network_client,
    )

    result = runner.invoke(app, argv)

    assert result.exit_code == 0, f"{case_id}: prepare 失敗\n{result.output}"
    files = list(output_dir.glob(glob))
    assert len(files) == 1, f"{case_id}: 生成物が 1 件でない ({files})"

    content = files[0].read_text(encoding="utf-8")
    body = _body_after_leading_comment(content)
    style_errors = [m for m in validate_body_style(body) if "未編集プレースホルダ" not in m]
    assert style_errors == [], f"{case_id}: 本文部に記法違反が残っている"
    assert "<!--" not in body, f"{case_id}: 本文内に HTML 指示コメントが残っている"


def _prepare_comment_template(
    template: str,
    glob: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> str:
    """comment テンプレを `--prepare` で生成し、生成物の全文を返す"""
    import cli.commands.issue as issue_module

    output_dir = tmp_path / "pecot"
    monkeypatch.setattr(issue_module, "get_output_dir", lambda: output_dir)
    monkeypatch.setattr(issue_module, "GitHubClient", _no_network_client)

    result = runner.invoke(
        app,
        ["issue", "comment", "--prepare", "-t", template, "--issue", "owner/repo/1"],
    )

    assert result.exit_code == 0, f"{template}: prepare 失敗\n{result.output}"
    files = list(output_dir.glob(glob))
    assert len(files) == 1, f"{template}: 生成物が 1 件でない ({files})"
    return files[0].read_text(encoding="utf-8")


def test_prepared_review_findings_has_no_retired_section_name(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#993 で廃止・改名した節名が復活していない

    外部レビュー指摘は Team Findings 改め General と Disposition の
    F-NN 連番へ統合した。
    `### External Reviews` が戻ると、review-resolution との対応づけから外部指摘が構造的に漏れる。
    `### Team Findings` が戻ると、行に紐づく指摘をインライン化するという前提が崩れる。
    """
    content = _prepare_comment_template(
        "review-findings", "comment-review-findings-*.md", tmp_path, monkeypatch
    )

    assert "### External Reviews" not in content
    assert "### Team Findings" not in content


# 採否を対応 / 対応不要の二値に閉じる規約（#993）で本文から追放した先送り語彙
DEFERRAL_TERMS = ("保留", "見送り", "別 Issue")


@pytest.mark.parametrize(
    ("template", "glob"),
    [
        ("review-findings", "comment-review-findings-*.md"),
        ("review-resolution", "comment-review-resolution-*.md"),
    ],
)
def test_prepared_review_template_body_has_no_deferral_vocabulary(
    template: str,
    glob: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """レビュー系テンプレの本文に先送り語彙が復活していない

    ガイドコメントには禁止の根拠としてこれらの語が意図的に残るため、
    ガイド終端より後ろの本文部だけを対象にする。
    """
    body = _body_after_leading_comment(
        _prepare_comment_template(template, glob, tmp_path, monkeypatch)
    )

    for term in DEFERRAL_TERMS:
        assert term not in body, f"{template}: 本文に先送り語彙 `{term}` が現れている"
