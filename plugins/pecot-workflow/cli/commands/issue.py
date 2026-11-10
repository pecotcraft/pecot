"""cli/issue.py - Issue command implementation

Provides the add-to-project and update-issue-status commands.
Also provides the issue subcommand group (create / quick / read / comment / reopen).
"""

from __future__ import annotations

import re
import string
import time
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, NoReturn, get_args

import typer

from cli.core.config import ProjectConfig, load_active_config
from cli.core.frontmatter import (
    CommentTemplate,
    FrontmatterError,
    IssueFrontmatter,
    IssueTemplateType,
    IssueType,
    parse_comment_file,
    parse_issue_file,
    set_frontmatter_value,
    strip_frontmatter,
    strip_leading_html_comment,
)
from cli.core.github import GitHubAPIError, GitHubClient
from cli.core.issue_board import add_issue_to_board, create_issue, set_issue_field
from cli.core.paths import (
    WORK_DIR,
    OutputPathReservationError,
    get_output_dir,
    reserved_output_path,
)
from cli.core.ref_parser import IssueRef, RefParseError, parse_issue_ref
from cli.core.repo_resolver import AmbiguousRepoError, RepoRef, resolve_repo
from cli.core.sections import (
    CLOSED_HEADINGS_BY_TEMPLATE,
    FOLD_SUMMARY_BY_TEMPLATE,
    extract_sections_from_template,
    validate_body_style,
    validate_closed_headings,
    validate_fold_balance,
    validate_fold_summaries,
    validate_heading_summaries,
    validate_sections,
)
from cli.core.state import FLAG_ISSUE_CREATE_SLASH_PENDING, FLAG_ISSUE_PENDING, consume_flag

# --- 定数 ---

# テンプレートディレクトリ
TEMPLATES_DIR = Path(__file__).parent.parent / "templates" / "issue"
COMMENT_TEMPLATES_DIR = Path(__file__).parent.parent / "templates" / "comment"

# issue comment のテンプレ検証失敗（不足セクション・見出しサマリの規則違反・使用できない記法・
# 折りたたみの規則違反・テンプレに無い見出し）の終了コード。通信失敗・設定なし・引数不足の 1 と区別し、hooks がこの値で分岐する
COMMENT_VALIDATION_EXIT_CODE = 3

# issue quick で起票した Issue 本文末尾に付加するフッター。
# テンプレ検証をスキップする quick でも、起票規約（status の既定値等）への
# 参照を残す。ラベルは create で使うテンプレの「起票ルール:」と揃える。
_HTML_COMMENT_OPEN = "<!--"
_QUICK_BODY_FOOTER = (
    f"{_HTML_COMMENT_OPEN} pecot issue quick で起票（テンプレ検証スキップ）。"
    "起票ルール: skills/w-help/references/issue-flow-rules.md"
    "#起票時の既定-status -->"
)

# Issueタイプ → タイトルプレフィックスのマッピング
TYPE_PREFIX_MAP: dict[str, str] = {
    "task": "[Task]",
    "bug": "[Bug]",
    "epic": "[Epic]",
    "tracker": "[Tracker]",
}


def _resolve_epic_target_repo(
    repo: str | None,
    config: ProjectConfig,
) -> tuple[str, bool]:
    """Decide the repository to create an Epic in, following the ``aggregation_repo`` policy (FR-017-019).

    Implements the behavior matrix in cli-commands.md (L107-115).

    - ``repo`` omitted + ``aggregation_repo`` set -> (aggregation_repo, False).
    - ``repo`` omitted + ``aggregation_repo`` unset -> exit 2 (cannot decide).
    - ``repo`` = aggregation_repo -> (repo, False).
    - ``repo`` != aggregation_repo -> (repo, True). A warning is needed.
    - ``repo`` given + aggregation_repo unset -> (repo, False).

    Args:
        repo: Explicit owner/repo from a function argument or the frontmatter.
              ``None`` or an empty string counts as omitted.
        config: Project config (used to look up aggregation_repo)

    Returns:
        The decided ``owner/repo`` and a flag for whether a warning is needed.

    Raises:
        typer.Exit: When ``repo`` is omitted and ``aggregation_repo`` is unset (exit code 2)
    """
    explicit = repo.strip() if isinstance(repo, str) and repo.strip() else None
    aggregation = config.aggregation_repo

    if explicit is None:
        if aggregation is None:
            typer.echo(
                "error: Epic の作成先が決定できません。\n"
                "       プロジェクト設定に aggregation_repo を宣言するか、"
                "--repo を明示してください。",
                err=True,
            )
            raise typer.Exit(2)
        return aggregation, False

    if aggregation is None:
        return explicit, False

    if explicit == aggregation:
        return explicit, False

    return explicit, True


def _resolve_base_repo(ctx: typer.Context | None) -> RepoRef | None:
    """Resolve base_repo from ``--repo`` or the current git repository in the CLI context.

    - The context assumes users of the primary form (``owner/repo/N``).
      So ``AmbiguousRepoError`` is swallowed and ``None`` is returned (FR-001/FR-003).
    - ``ValueError`` (malformed ``--repo``) propagates unchanged so the caller
      can convert it to BadParameter
    """
    if ctx is None or ctx.obj is None:
        return None
    try:
        return resolve_repo(ctx.obj.get("repo"), cwd=Path.cwd()).repo
    except AmbiguousRepoError:
        return None


def _parse_issue_ref_from_ctx(ctx: typer.Context | None, raw: str) -> tuple[str, str, int]:
    """Resolve base_repo through ``ctx`` and split an Issue reference into ``(owner, repo, number)``.

    Raises:
        typer.BadParameter: Malformed reference, or a short form with unresolvable base_repo
    """
    base = _resolve_base_repo(ctx)
    try:
        ref = parse_issue_ref(raw, base_repo=base)
    except RefParseError as e:
        raise typer.BadParameter(e.message) from None
    return ref.repo.owner, ref.repo.repo, ref.number


def _normalize_parent_epic_cli(raw: str | None) -> int | str | None:
    """Normalize a parent_epic value that came in through a CLI option.

    Empty or whitespace-only -> None, digit string -> int, any other string -> returned as str.
    """
    if raw is None:
        return None
    stripped = raw.strip()
    if not stripped:
        return None
    if stripped.isdigit():
        return int(stripped)
    return stripped


def _resolve_parent_epic_ref(
    raw: int | str,
    config: ProjectConfig,
    task_owner: str,
    task_repo: str,
) -> IssueRef:
    """Resolve a parent_epic value to an IssueRef.

    - Integer -> an Issue in aggregation_repo. Falls back to the task repo when aggregation_repo is unset.
    - "owner/repo/N" -> used as is (base_repo is ignored).
    - Raises typer.BadParameter on a parse failure.
    - Writes a note to stderr for an integer when aggregation_repo differs from the task repo.
    """
    base = config.aggregation_repo_ref or RepoRef(owner=task_owner, repo=task_repo)
    try:
        ref = parse_issue_ref(str(raw), base_repo=base)
    except RefParseError as e:
        raise typer.BadParameter(
            f"parent_epic 解決失敗: {e.message}\n"
            "  受理形式: 整数 (aggregation_repo の Issue 番号) / 'owner/repo/N' 主軸形式"
        ) from None

    if (
        isinstance(raw, int)
        and config.aggregation_repo_ref is not None
        and (ref.repo.owner, ref.repo.repo) != (task_owner, task_repo)
    ):
        typer.echo(
            f"note: parent_epic={raw} を aggregation_repo ({ref.repo.full_name}) の "
            f"#{ref.number} として解決しました。",
            err=True,
        )
    return ref


def _build_issue_title(
    issue_type: str,
    title: str,
    parent_epic: int | None = None,
    order: int | None = None,
    parallel: str | None = None,
) -> str:
    """Add the prefix and the Epic number + order (+ branch letter) to a title.

    Args:
        issue_type: Issue type (task, bug, epic, tracker).
        title: Original title.
        parent_epic: Issue number of the parent Epic.
        order: Order number of the subtask (stage).
        parallel: Branch letter within the same stage (a-z).

    Returns:
        The title with the prefix.
    """
    prefix = TYPE_PREFIX_MAP.get(issue_type, "")

    # 既存プレフィックスを除去
    base_title = title
    if prefix and title.startswith(prefix):
        base_title = title[len(prefix) :].strip()

    # Epic番号+order付きタイトル生成
    if parent_epic is not None and order is not None:
        number = f"#{parent_epic}-{order:02d}{parallel or ''}"
        if prefix:
            return f"{prefix} {number}: {base_title}"
        return f"{number}: {base_title}"

    # 従来通り
    if prefix and not title.startswith(prefix):
        return f"{prefix} {title}"
    return title


# orderの重複チェック用パターン: #123-01: / #123-01a: 形式から段と枝を抽出
_ORDER_PATTERN = re.compile(r"#(\d+)-(\d+)([a-z])?:")


def _order_label(order: int, parallel: str | None) -> str:
    """Number shown in error messages. Always ``NN`` followed by the branch letter."""
    return f"{order:02d}{parallel or ''}"


def _check_duplicate_order(
    client: GitHubClient,
    owner: str,
    repo: str,
    parent_epic: int,
    order: int,
    parallel: str | None = None,
) -> None:
    """Check that no Issue in the same Epic has the same (stage, branch letter).

    A number cannot be reused once used, whether the Issue is OPEN or CLOSED.
    Within the same stage, with and without a branch letter count as duplicates (whichever exists).
    Different branch letters in the same stage are not duplicates.

    Args:
        client: GitHub client.
        owner: Repository owner.
        repo: Repository name.
        parent_epic: Issue number of the parent Epic.
        order: Order number (stage) to check.
        parallel: Branch letter to check.

    Raises:
        typer.Exit: When an Issue with a duplicate number exists
    """
    try:
        epic = client.get_issue_slim(owner, repo, parent_epic, comment_limit=0)
    except GitHubAPIError as e:
        typer.echo(f"警告: 親Epic #{parent_epic} の取得に失敗しました: {e.message}", err=True)
        return

    # 使用済みorder番号を収集（次の空き番号の提案用）
    used_orders: set[int] = set()
    duplicate_sub: dict[str, Any] | None = None
    duplicate_parallel: str | None = None
    same_order_parallels: set[str | None] = set()
    for sub in epic.get("sub_issues", []):
        match = _ORDER_PATTERN.search(sub.get("title", ""))
        if match and int(match.group(1)) == parent_epic:
            sub_order = int(match.group(2))
            sub_parallel = match.group(3)
            used_orders.add(sub_order)
            if sub_order == order:
                same_order_parallels.add(sub_parallel)
            if (
                duplicate_sub is None
                and sub_order == order
                and (sub_parallel is None or parallel is None or sub_parallel == parallel)
            ):
                duplicate_sub = sub
                duplicate_parallel = sub_parallel

    if duplicate_sub is not None:
        state_label = "OPEN" if duplicate_sub.get("state") == "OPEN" else "CLOSED"
        next_order = 1
        while next_order in used_orders:
            next_order += 1
        if parallel is None and duplicate_parallel is None:
            conflict = f"order={order} のIssueが既に存在します"
            suggestion = f"次に使用可能なorder: {next_order}"
        else:
            letter = next(
                (c for c in string.ascii_lowercase if c not in same_order_parallels), None
            )
            if None in same_order_parallels or letter is None:
                suggestion = f"次に使用可能なorder: {max(used_orders) + 1}"
            else:
                suggestion = f"次に使用可能な番号: {_order_label(order, letter)}"
            conflict = (
                f"order={_order_label(order, parallel)} "
                f"と重複するIssue（{_order_label(order, duplicate_parallel)}）が既に存在します"
            )
        typer.echo(
            f"エラー: Epic #{parent_epic} に {conflict}"
            f"（{state_label}）\n"
            f"  #{duplicate_sub['number']} {duplicate_sub['title']}\n"
            f"  {suggestion}",
            err=True,
        )
        raise typer.Exit(1)


def add_to_project(
    ctx: typer.Context,
    issue_ref: str = typer.Argument(
        ...,
        help="Issue reference (`owner/repo/N`, or the short form `N` only with `--repo`)",
    ),
    status: str | None = typer.Option(
        "ready",
        "--status",
        "-s",
        help="Initial status (backlog/pending/ready/active/in_review/archived)",
    ),
) -> None:
    """Add an Issue to the project board with a GraphQL mutation"""
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, issue_ref)
    except typer.BadParameter as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(2) from None

    try:
        client = GitHubClient(host=config.host)

        # 3. リポジトリがプロジェクトに含まれているか確認
        if not config.is_repo_in_project(owner, repo, client):
            typer.echo(f"リポジトリ {owner}/{repo} はプロジェクトに含まれていません", err=True)
            raise typer.Exit(1)

        # 4. Issue Node ID 取得
        issue_node_id = client.get_issue_node_id(owner, repo, issue_number)

        # 5. プロジェクトに追加
        item_id = client.add_to_project(config.project.id, issue_node_id)
        typer.echo(f"追加完了: {issue_ref} → プロジェクト")

        # 6. ステータス設定（オプション）
        if status:
            field_id = config.get_field_id("workflow")
            option_id = config.get_option_id("workflow", status)
            if field_id and option_id:
                client.update_project_item_field(config.project.id, item_id, field_id, option_id)
                typer.echo(f"ステータス設定: {status}")
            else:
                typer.echo(f"警告: ステータス '{status}' が見つかりません", err=True)

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None


# 有効なステータス値
VALID_STATUSES = {"backlog", "pending", "ready", "active", "in_review", "archived"}

# 起票時の status は型対応テンプレートの既定値のみ受理する（#669）。
# pending / archived への配置はボード上の手動操作領域。
TYPE_DEFAULT_STATUS: dict[IssueType, str] = {
    "epic": "backlog",
    "tracker": "backlog",
    "task": "ready",
    "bug": "ready",
}

# Backlog に置く型（quick の status / size / quick フラグの扱いが Epic と同じ）
BACKLOG_TYPES: frozenset[str] = frozenset({"epic", "tracker"})


def _validate_status_for_type(issue_type: IssueType, status: str) -> None:
    """Check that the status at creation matches the default of the type's template (#669).

    Tells apart a value outside the enum (e.g. ``--status foo``) from the default of another template that conflicts with the type.
    An example of the latter is ``--type bug --status backlog``. Both are rejected with exit 1.

    Step 1 (the enum check) is for direct input only.
    For file input, ``WorkflowStatus.value`` is passed, so it is always in ``VALID_STATUSES``.
    A value outside the enum can arrive only through direct input, which takes ``--status`` as is.
    """
    # 1) enum 外の値は不正ステータスとして拒否（現状の silent skip を明示エラー化）
    if status not in VALID_STATUSES:
        typer.echo(
            f"不正なステータス: {status}\n"
            "有効な値: backlog/pending/ready/active/in_review/archived",
            err=True,
        )
        raise typer.Exit(1)

    # 2) 型に対応しない status（別テンプレートの配置値）を拒否
    expected = TYPE_DEFAULT_STATUS[issue_type]
    if status != expected:
        typer.echo(
            f"エラー: type '{issue_type}' の起票時 status は '{expected}' のみです（指定: {status}）\n"
            "HINT: pending 等への配置は起票後にボード上で手動移動してください",
            err=True,
        )
        raise typer.Exit(1)


def update_issue_status(
    ctx: typer.Context,
    issue_ref: str = typer.Argument(
        ...,
        help="Issue reference (`owner/repo/N`, or the short form `N` only with `--repo`)",
    ),
    status: str = typer.Argument(
        ...,
        help="Status (backlog/pending/ready/active/in_review/archived)",
    ),
) -> None:
    """Update the status of an Issue on the project board by Issue number"""
    # 1. ステータスバリデーション
    if status not in VALID_STATUSES:
        typer.echo(
            f"不正なステータス: {status}\n"
            "有効な値: backlog/pending/ready/active/in_review/archived",
            err=True,
        )
        raise typer.Exit(1)

    # 2. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 3. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, issue_ref)
    except typer.BadParameter as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(2) from None

    try:
        client = GitHubClient(host=config.host)

        # 4. リポジトリがプロジェクトに含まれているか確認
        if not config.is_repo_in_project(owner, repo, client):
            typer.echo(f"リポジトリ {owner}/{repo} はプロジェクトに含まれていません", err=True)
            raise typer.Exit(1)

        # 5. Issue番号からプロジェクトアイテムIDを取得
        item_id = client.get_item_id_by_issue(config.project.id, owner, repo, issue_number)

        if item_id is None:
            typer.echo(
                f"Issue #{issue_number} はプロジェクトボードに存在しません\n"
                "HINT: まず add-to-project でボードに追加してください",
                err=True,
            )
            raise typer.Exit(1)

        # 6. ステータス更新
        field_id = config.get_field_id("workflow")
        option_id = config.get_option_id("workflow", status)

        if not field_id or not option_id:
            typer.echo(f"ステータス '{status}' の設定が見つかりません", err=True)
            raise typer.Exit(1)

        client.update_project_item_field(config.project.id, item_id, field_id, option_id)
        typer.echo(f"更新完了: {issue_ref} → {status}")

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None


def issue_reopen_command(
    ctx: typer.Context,
    issue_ref: str = typer.Argument(
        ...,
        help="Issue reference (`owner/repo/N`, or the short form `N` only with `--repo`)",
    ),
    status: str = typer.Option(
        "ready",
        "--status",
        "-s",
        help="Status after reopening (backlog/pending/ready/active/in_review/archived)",
    ),
    comment: str | None = typer.Option(
        None,
        "--comment",
        "-c",
        help="Reason for reopening (posted as a comment)",
    ),
) -> None:
    """Reopen a closed Issue"""
    # 1. ステータスバリデーション
    if status not in VALID_STATUSES:
        typer.echo(
            f"不正なステータス: {status}\n"
            "有効な値: backlog/pending/ready/active/in_review/archived",
            err=True,
        )
        raise typer.Exit(1)

    # 2. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 3. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, issue_ref)
    except typer.BadParameter as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(2) from None

    try:
        client = GitHubClient(host=config.host)

        # 4. リポジトリがプロジェクトに含まれているか確認
        if not config.is_repo_in_project(owner, repo, client):
            typer.echo(f"リポジトリ {owner}/{repo} はプロジェクトに含まれていません", err=True)
            raise typer.Exit(1)

        # 5. Issue再オープン（1回目 — ステータス更新の前提としてOPENにする）
        client.reopen_issue(owner, repo, issue_number)

        # 6. Projects V2ステータス更新
        item_id = client.get_item_id_by_issue(config.project.id, owner, repo, issue_number)

        if item_id is None:
            typer.echo(
                f"警告: Issue #{issue_number} はプロジェクトボードに存在しません",
                err=True,
            )
        else:
            field_id = config.get_field_id("workflow")
            option_id = config.get_option_id("workflow", status)

            if not field_id or not option_id:
                typer.echo(f"警告: ステータス '{status}' の設定が見つかりません", err=True)
            else:
                client.update_project_item_field(config.project.id, item_id, field_id, option_id)
                typer.echo(f"ステータスを更新: {status}")
                # Projects V2 Automationが非同期でIssueをcloseする可能性があるため待機
                time.sleep(3)

        # 7. Issue再オープン（2回目 — Automationによるclose対策）
        result = client.reopen_issue(owner, repo, issue_number)
        if result.get("state") != "open":
            typer.echo(
                f"警告: Issueのstateが 'open' になりませんでした: {result.get('state')}",
                err=True,
            )
            raise typer.Exit(1)
        typer.echo(f"Issue再オープン完了: {issue_ref}")

        # 8. コメント投稿 (--comment指定時)
        if comment:
            client.add_issue_comment(owner, repo, issue_number, comment)
            typer.echo("コメントを投稿しました")

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None


# --- issue create コマンド（統一版: --prepare 対応） ---


def issue_create(
    ctx: typer.Context,
    files: Annotated[
        list[Path] | None,
        typer.Argument(help="Path of a Markdown file with frontmatter (several for a batch post)"),
    ] = None,
    message: Annotated[
        str | None,
        typer.Option("--message", "-m", help="Issue body (direct posting mode)"),
    ] = None,
    title: Annotated[
        str | None,
        typer.Option("--title", "-t", help="Issue title (direct posting mode, required with -m)"),
    ] = None,
    repo: Annotated[
        str | None,
        typer.Option(
            "--repo",
            "-r",
            help="Repository (owner/repo form; required with -m / --prepare unless epic)",
        ),
    ] = None,
    issue_type: Annotated[
        IssueType,
        typer.Option("--type", help="Issue type (task/bug/epic/tracker)"),
    ] = "task",
    status: Annotated[
        str | None,
        typer.Option("--status", help="Status (backlog/pending/ready/active/in_review/archived)"),
    ] = None,
    priority: Annotated[
        str | None,
        typer.Option("--priority", help="Priority (high/medium/low)"),
    ] = None,
    size: Annotated[
        str | None,
        typer.Option("--size", help="Size (xs/s/m/l)"),
    ] = None,
    parent_epic: Annotated[
        str | None,
        typer.Option(
            "--parent-epic",
            help="Parent Epic reference: an integer (relative to aggregation_repo) or the primary form 'owner/repo/N'",
        ),
    ] = None,
    order: Annotated[
        int | None,
        typer.Option("--order", help="Order number of the subtask (used with parent_epic)"),
    ] = None,
    labels: Annotated[
        list[str] | None,
        typer.Option("--label", "-l", help="Label (can be given several times)"),
    ] = None,
    prepare: Annotated[
        bool,
        typer.Option("--prepare", "-p", help="Copy a template to the work directory"),
    ] = False,
    template: Annotated[
        IssueTemplateType,
        typer.Option(
            "--template",
            help="Template type (with --prepare: task/bug/epic/tracker/task-implement)",
        ),
    ] = "task",
    suffix: Annotated[
        str | None,
        typer.Option("--suffix", "-s", help="Suffix of the output file name (only with --prepare)"),
    ] = None,
) -> None:
    """Create Issues from Markdown files with frontmatter

    There are three modes.

    1. Direct posting (the -m option).
       $ pecot issue create -t "Task name" -r owner/repo -m "## Overview..."

    2. Template preparation.
       $ pecot issue create --prepare --template task --repo owner/repo

    3. Create from files. Several files are posted in a batch.
       ``{{issue:<suffix>}}`` in a body expands to the number of an Issue created from an earlier file.
       $ pecot issue create ./tmp/pecot/issue-task-20260116-123456.md

       To post several files in a batch.
       $ pecot issue create phase1.md phase2.md phase3.md
    """
    # モード判定
    if prepare:
        _issue_create_prepare(template, repo, suffix)
    elif files:
        _issue_create_from_files(files)
    elif message is not None:
        _issue_create_message_mode(
            message, title, repo, issue_type, status, priority, size, parent_epic, labels, order
        )
    else:
        # 引数不足
        _exit_with_issue_create_usage()


def _issue_create_message_mode(
    message: str,
    title: str | None,
    repo: str | None,
    issue_type: IssueType,
    status: str | None,
    priority: str | None,
    size: str | None,
    parent_epic: str | None,
    labels: list[str] | None,
    order: int | None,
) -> None:
    """Direct posting mode (-m): validate arguments, decide the target, then delegate to _issue_create_direct"""
    # 直接投稿モード: -t は必須。-r は epic 以外で必須。
    if not title:
        typer.echo("エラー: -m使用時は -t (タイトル) が必須です", err=True)
        raise typer.Exit(1)
    resolved_repo = _resolve_message_mode_repo(issue_type, repo)
    _issue_create_direct(
        message=message,
        title=title,
        repo=resolved_repo,
        issue_type=issue_type,
        status=status,
        priority=priority,
        size=size,
        parent_epic=parent_epic,
        labels=labels,
        order=order,
    )
    consume_flag(FLAG_ISSUE_CREATE_SLASH_PENDING)


def _resolve_message_mode_repo(issue_type: IssueType, repo: str | None) -> str:
    """Decide the target repository in direct posting mode (-r is required except for epic; epic uses aggregation_repo)"""
    if issue_type != "epic" and not repo:
        typer.echo("エラー: -m使用時は -r (リポジトリ) が必須です", err=True)
        raise typer.Exit(1)

    resolved_repo = repo
    if issue_type == "epic":
        config = load_active_config()
        if config is None:
            typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
            raise typer.Exit(1)
        resolved_repo, warn = _resolve_epic_target_repo(repo, config)
        if warn:
            _warn_epic_repo_exception(resolved_repo, config)

    if resolved_repo is None:
        # epic 以外は上の -r 必須チェックで弾かれており、
        # epic は _resolve_epic_target_repo が必ず値か Exit を返す。
        # ここに到達するのは想定外状態なので明示エラーで止める
        # assert は ``-O`` 最適化で無効化されるため、if/raise にしている。
        typer.echo("エラー: Epic 作成先を解決できませんでした", err=True)
        raise typer.Exit(1)
    return resolved_repo


def _exit_with_issue_create_usage() -> NoReturn:
    """Print usage to stderr when arguments are missing, then exit 1"""
    typer.echo("エラー: 引数が不足しています", err=True)
    typer.echo("", err=True)
    typer.echo("使用方法:", err=True)
    typer.echo('  直接投稿: pecot issue create -t "タイトル" -r owner/repo -m "本文"', err=True)
    typer.echo(
        "  テンプレート準備: pecot issue create --prepare --template task --repo owner/repo",
        err=True,
    )
    typer.echo("  ファイルから: pecot issue create <path>", err=True)
    raise typer.Exit(1)


_REPO_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _validate_repo_shape(repo: str) -> None:
    """Validate the ``owner/repo`` form (exit 2 if invalid)."""
    parts = repo.split("/")
    if len(parts) != 2 or not all(_REPO_SEGMENT_RE.match(p) for p in parts):
        typer.echo(f"エラー: 不正なリポジトリ形式: {repo}\n期待: owner/repo", err=True)
        raise typer.Exit(2)


def _issue_create_prepare(
    template: IssueTemplateType, repo: str | None, suffix: str | None = None
) -> None:
    """Copy a template to the work directory (internal function)"""
    # 0. --repo 必須チェック（epic 以外は必須）
    if template != "epic":
        if repo is None:
            typer.echo(
                "エラー: --repo owner/repo は --template task|bug|tracker|task-implement では必須です",
                err=True,
            )
            raise typer.Exit(2)
    if repo is not None:
        _validate_repo_shape(repo)

    # 1. テンプレートファイルのパス
    template_path = TEMPLATES_DIR / f"{template}.md"

    if not template_path.exists():
        typer.echo(f"テンプレートが見つかりません: {template_path}", err=True)
        raise typer.Exit(1)

    # 2. 本文生成（必要なら repository: 行を埋め込む）
    content = template_path.read_text(encoding="utf-8")
    if repo is not None:
        content = content.replace('repository: ""', f"repository: {repo}", 1)

    # 3. 出力パス予約（プロジェクトルート基準・同名があれば ts を 1 秒進めて再試行）
    #    4. 書き込み・パス出力（書き込み前に失敗した場合は予約を撤去する）
    name_suffix = f"-{suffix}" if suffix else ""
    try:
        with reserved_output_path(
            get_output_dir(), lambda ts: f"issue-{template}-{ts}{name_suffix}.md"
        ) as output_path:
            output_path.write_text(content, encoding="utf-8")
            typer.echo(str(output_path))
    except OutputPathReservationError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None


# 一括投稿時の先行 Issue 番号プレースホルダ。<key> は先行ファイルの
# --prepare --suffix 由来サフィックスまたはファイル stem。
_ISSUE_PLACEHOLDER_RE = re.compile(r"\{\{issue:([^{}\s]+)\}\}")
# --prepare --suffix が生成するファイル名: issue-<template>-<YYYYMMDD>-<HHMMSS>-<suffix>.md
_PREPARED_FILENAME_RE = re.compile(r"^issue-.+-\d{8}-\d{6}-(?P<suffix>.+)$")


def _issue_file_keys(file: Path) -> set[str]:
    """Placeholder keys that point to a file (the stem and the suffix from --suffix)"""
    keys = {file.stem}
    m = _PREPARED_FILENAME_RE.match(file.stem)
    if m:
        keys.add(m.group("suffix"))
    return keys


def _validate_issue_placeholders(files: list[Path]) -> None:
    """Validate before a batch post (fail without posting any).

    - Duplicate or missing files
    - Placeholder key collisions
    - Forward references and unknown keys (a dependency must come earlier in the arguments)
    """
    seen: set[Path] = set()
    available: set[str] = set()
    for file in files:
        resolved = file.resolve()
        if resolved in seen:
            typer.echo(f"エラー: ファイルが重複指定されています: {file}", err=True)
            raise typer.Exit(1)
        seen.add(resolved)
        if not file.is_file():
            typer.echo(f"エラー: ファイルが見つかりません: {file}", err=True)
            raise typer.Exit(1)
        # frontmatter と冒頭ガイドコメントは投稿本文に出ないので走査対象から外す
        # （雛形の説明文にある {{issue:<suffix>}} を拾って誤検知していた: #958 F-01）
        body = strip_leading_html_comment(strip_frontmatter(file.read_text(encoding="utf-8")))
        for ref in _ISSUE_PLACEHOLDER_RE.findall(body):
            if ref not in available:
                typer.echo(
                    f"エラー: {file.name} の {{{{issue:{ref}}}}} が先行ファイルを"
                    "指していません（前方参照または未知のキー）。"
                    "依存先ファイルを引数の前方に並べてください",
                    err=True,
                )
                raise typer.Exit(1)
        keys = _issue_file_keys(file)
        if available & keys:
            typer.echo(
                f"エラー: プレースホルダキーが衝突しています: "
                f"{', '.join(sorted(available & keys))}（{file.name}）",
                err=True,
            )
            raise typer.Exit(1)
        available |= keys


def _issue_create_from_files(files: list[Path]) -> None:
    """Post several files in a batch, in argument order (internal function)

    Expands Issue numbers created from earlier files into ``{{issue:<key>}}`` in later files
    before posting. When all succeed, consumes the slash-command exemption flag
    (on a mid-way failure it is not consumed, so the rest can be retried within the user-instructed flow).
    """
    _validate_issue_placeholders(files)
    created: dict[str, tuple[str, int]] = {}
    total = len(files)
    for i, file in enumerate(files, start=1):
        if total > 1:
            typer.echo(f"[{i}/{total}] {file.name}")
        repository, number = _issue_create_from_file(file, substitutions=created)
        for key in _issue_file_keys(file):
            created[key] = (repository, number)
    consume_flag(FLAG_ISSUE_CREATE_SLASH_PENDING)


def _warn_epic_repo_exception(resolved_repo: str, config: ProjectConfig) -> None:
    """Warning for when the Epic target differs from aggregation_repo"""
    typer.echo(
        f"warning: --repo {resolved_repo} は aggregation_repo "
        f"({config.aggregation_repo}) と異なります。\n"
        "         実装リポ運用 Epic の例外として作成を続行します。",
        err=True,
    )


def _create_issue_or_exit(
    client: GitHubClient,
    owner: str,
    repo: str,
    title: str,
    body: str,
    labels: list[str] | None,
) -> dict[str, Any]:
    """Create an Issue (exit 1 on failure)"""
    typer.echo("Creating issue...")
    try:
        return create_issue(client, owner, repo, title, body, labels)
    except GitHubAPIError as e:
        typer.echo(f"エラー: Issue作成失敗: {e.message}", err=True)
        raise typer.Exit(1) from None


def _add_issue_to_board(
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
    issue_node_id: str | None,
    issue_url: str,
) -> tuple[str, str] | None:
    """Add to the board. Returns (item_id, issue_node_id) on success; on failure prints a warning and the URL and returns None."""
    typer.echo("Adding to board...")
    try:
        added = add_issue_to_board(client, config, owner, repo, issue_number, issue_node_id)
        typer.echo("  Added to board")
    except GitHubAPIError as e:
        typer.echo(f"警告: ボード追加失敗: {e.message}", err=True)
        typer.echo(f"\n{issue_url}")
        return None
    return added


def _set_issue_fields(
    client: GitHubClient,
    config: ProjectConfig,
    item_id: str,
    fields: list[tuple[str, str, str]],
) -> None:
    """Set custom fields. fields is (field name, option name, display label). Failures are ignored"""
    fields_set: list[str] = []
    for field_name, option_name, label in fields:
        try:
            if set_issue_field(client, config, item_id, field_name, option_name):
                fields_set.append(label)
        except GitHubAPIError:
            pass  # フィールド設定失敗は無視

    if fields_set:
        typer.echo(f"  Set fields: {', '.join(fields_set)}")


def _link_to_parent_epic(
    client: GitHubClient, parent_ref: IssueRef, issue_node_id: str, issue_url: str
) -> None:
    """Link as a sub-issue (on failure, print the URL and then exit 1)"""
    typer.echo(f"Linking to parent epic {parent_ref.to_cli_ref()}...")
    try:
        parent_node_id = client.get_issue_node_id(
            parent_ref.repo.owner, parent_ref.repo.repo, parent_ref.number
        )
        client.add_sub_issue(parent_node_id, issue_node_id)
        typer.echo(f"  Linked to {parent_ref.to_cli_ref()}")
    except GitHubAPIError as e:
        typer.echo(f"\n{issue_url}")
        typer.echo(f"エラー: サブIssue紐づけ失敗: {e.message}", err=True)
        raise typer.Exit(1) from None


def _ensure_repo_in_project(
    config: ProjectConfig, client: GitHubClient, owner: str, repo: str, display: str
) -> None:
    """Exit 1 if the repository is not linked to the project"""
    if not config.is_repo_in_project(owner, repo, client):
        typer.echo(f"エラー: {display} はプロジェクトに紐づいていません", err=True)
        raise typer.Exit(1)


def _client_for_issue_create(
    config: ProjectConfig,
    owner: str,
    repo: str,
    display: str,
    parent_ref: IssueRef | None,
    order: int | None,
    parallel: str | None = None,
) -> GitHubClient:
    """Initialize the client, check the repository, and check for duplicate order (against the parent Epic's repo)"""
    client = GitHubClient(host=config.host)
    _ensure_repo_in_project(config, client, owner, repo, display)
    if parent_ref is not None and order is not None:
        _check_duplicate_order(
            client, parent_ref.repo.owner, parent_ref.repo.repo, parent_ref.number, order, parallel
        )
    return client


def _resolve_file_target_repo(fm: IssueFrontmatter, config: ProjectConfig) -> tuple[str, str]:
    """2.5. Decide the target (owner, repo) for file input.

    When creating an Epic, applies aggregation_repo routing (FR-017-019).
    An empty frontmatter ``repository`` counts as omitted.
    """
    if fm.type == "epic":
        explicit_repo = fm.repository.strip() if fm.repository else None
        resolved_repo, warn = _resolve_epic_target_repo(explicit_repo, config)
        if warn:
            _warn_epic_repo_exception(resolved_repo, config)
        owner, repo = resolved_repo.split("/")
        return owner, repo
    if "/" not in fm.repository:
        typer.echo(
            f"エラー: フロントマター repository の形式が不正です: {repr(fm.repository)}",
            err=True,
        )
        raise typer.Exit(1)
    owner, repo = fm.repository.split("/")
    return owner, repo


def _expand_issue_placeholders(
    body: str, substitutions: dict[str, tuple[str, int]], owner: str, repo: str
) -> str:
    """2.7. Expand placeholders in a batch post (#N for the same repo, owner/repo#N across repos)"""

    def _sub(m: re.Match[str]) -> str:
        ref = substitutions.get(m.group(1))
        if ref is None:
            return m.group(0)
        ref_repo, ref_number = ref
        return f"#{ref_number}" if ref_repo == f"{owner}/{repo}" else f"{ref_repo}#{ref_number}"

    return _ISSUE_PLACEHOLDER_RE.sub(_sub, body)


def _issue_create_from_file(
    file: Path, substitutions: dict[str, tuple[str, int]] | None = None
) -> tuple[str, int]:
    """Create an Issue from a file (internal function)

    Returns:
        (repository "owner/repo", created Issue number)
    """
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. ファイル読み込み・パース
    try:
        parsed = parse_issue_file(file)
    except FrontmatterError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None

    fm = parsed.frontmatter

    # 2.5. 作成先リポジトリ決定（Epic は aggregation_repo ルーティング）
    owner, repo = _resolve_file_target_repo(fm, config)

    # 2.7. 一括投稿時のプレースホルダ展開
    body = parsed.body
    if substitutions:
        body = _expand_issue_placeholders(body, substitutions, owner, repo)

    # 3. テンプレート準拠チェック
    template_type = fm.template or fm.type
    _validate_issue_template(template_type, body)

    # 3.1. status が型対応テンプレートの既定値と一致するか検証する（#669）。
    #      ``client.create_issue`` より前に純粋判定で拒否する。
    _validate_status_for_type(fm.type, fm.status.value)

    # 3.5. parent_epic の早期解決（aggregation_repo 基準 / クロスリポ対応）
    parent_ref: IssueRef | None = (
        _resolve_parent_epic_ref(fm.parent_epic, config, owner, repo)
        if fm.parent_epic is not None
        else None
    )

    # 4. タイトルにプレフィックス付与
    title = _build_issue_title(
        fm.type,
        fm.title,
        parent_ref.number if parent_ref else None,
        fm.order,
        fm.parallel,
    )

    # 5〜6. クライアント初期化・リポジトリ確認・order重複チェック
    client = _client_for_issue_create(
        config, owner, repo, fm.repository, parent_ref, fm.order, fm.parallel
    )

    # 7. Issue作成
    issue = _create_issue_or_exit(
        client, owner, repo, title, body, fm.labels if fm.labels else None
    )
    issue_number = issue["number"]
    issue_url = issue["html_url"]
    typer.echo(f"  Created: #{issue_number}")
    consume_flag(FLAG_ISSUE_PENDING)

    # 7. ボード追加
    added = _add_issue_to_board(client, config, owner, repo, issue_number, None, issue_url)
    if added is None:
        return f"{owner}/{repo}", issue_number
    item_id, issue_node_id = added

    # 8. カスタムフィールド設定
    fields: list[tuple[str, str, str]] = []
    if fm.status:
        fields.append(("workflow", fm.status, f"status: {fm.status.value}"))
    if fm.priority:
        fields.append(("priority", fm.priority, f"priority: {fm.priority.value}"))
    if fm.size:
        fields.append(("size", fm.size, f"size: {fm.size.value}"))
    _set_issue_fields(client, config, item_id, fields)

    # 8. サブIssue紐づけ
    if parent_ref is not None:
        _link_to_parent_epic(client, parent_ref, issue_node_id, issue_url)

    # 9. 結果出力
    typer.echo(f"\n{issue_url}")
    return f"{owner}/{repo}", issue_number


def _issue_create_direct(
    message: str,
    title: str,
    repo: str,
    issue_type: IssueType,
    status: str | None,
    priority: str | None,
    size: str | None,
    parent_epic: int | str | None,
    labels: list[str] | None,
    order: int | None = None,
) -> None:
    """Create an Issue from direct input (internal function).

    Follows the processing flow of _issue_create_from_file.

    1. Get the config.
    2. Check the repository.
    3. Add the prefix to the title.
    4. Check template conformance.
    5. Create the Issue.
    6. Add to the board.
    7. Set custom fields.
    8. Link as a sub-issue.
    """
    # 0. status の検証・既定値適用（#669）。
    #    I/O 不要の純粋判定なので、設定取得・副作用の前に拒否する。
    if status is None:
        status = TYPE_DEFAULT_STATUS[issue_type]
    else:
        _validate_status_for_type(issue_type, status)

    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. リポジトリ形式確認
    _validate_repo_shape(repo)
    owner, repo_name = repo.split("/")

    # 2.5. parent_epic の早期解決（aggregation_repo 基準 / クロスリポ対応）
    parent_epic = (
        _normalize_parent_epic_cli(parent_epic) if isinstance(parent_epic, str) else parent_epic
    )
    parent_ref: IssueRef | None = (
        _resolve_parent_epic_ref(parent_epic, config, owner, repo_name)
        if parent_epic is not None
        else None
    )

    # 3. タイトルにプレフィックス付与
    final_title = _build_issue_title(
        issue_type, title, parent_ref.number if parent_ref else None, order
    )

    # 4. テンプレート準拠チェック
    _validate_issue_template(issue_type, message)

    # 5〜6. クライアント初期化・リポジトリ確認・order重複チェック
    client = _client_for_issue_create(config, owner, repo_name, repo, parent_ref, order)

    # 7. Issue作成
    issue = _create_issue_or_exit(
        client, owner, repo_name, final_title, message, labels if labels else None
    )
    issue_number = issue["number"]
    issue_url = issue["html_url"]
    typer.echo(f"  Created: #{issue_number}")
    consume_flag(FLAG_ISSUE_PENDING)

    # 8. ボード追加
    added = _add_issue_to_board(
        client, config, owner, repo_name, issue_number, issue.get("node_id"), issue_url
    )
    if added is None:
        return
    item_id, issue_node_id = added

    # 8. カスタムフィールド設定
    # status は step 0 で既定値適用・検証済みのため常に非 None（#669）。
    fields: list[tuple[str, str, str]] = [("workflow", status, f"status: {status}")]
    if priority:
        fields.append(("priority", priority, f"priority: {priority}"))
    if size:
        fields.append(("size", size, f"size: {size}"))
    _set_issue_fields(client, config, item_id, fields)

    # 9. サブIssue紐づけ
    if parent_ref is not None:
        _link_to_parent_epic(client, parent_ref, issue_node_id, issue_url)

    # 10. 結果出力
    typer.echo(f"\n{issue_url}")


# --- issue quick コマンド ---


def _parse_quick_args(message: str, repo: str) -> tuple[str, str]:
    """1. Validate arguments (an empty message or a malformed repository form exits 1)"""
    if not message or not message.strip():
        typer.echo("エラー: メッセージが空です", err=True)
        raise typer.Exit(1)

    parts = repo.split("/")
    if len(parts) != 2:
        typer.echo(f"エラー: 不正なリポジトリ形式: {repo}\n期待: owner/repo", err=True)
        raise typer.Exit(1)
    return parts[0], parts[1]


def _quick_fields(issue_type: IssueType) -> list[tuple[str, str, str]]:
    """7. Fixed fields of quick.

    status is backlog for epic and active otherwise. priority is medium and size is s.
    """
    # status: epic なら "backlog"、それ以外なら "active"
    default_status = "backlog" if issue_type in BACKLOG_TYPES else "active"
    fields: list[tuple[str, str, str]] = [
        ("workflow", default_status, f"status: {default_status}"),
        # priority: medium
        ("priority", "medium", "priority: medium"),
    ]
    # size: s (Backlog に置く型以外)
    if issue_type not in BACKLOG_TYPES:
        fields.append(("size", "s", "size: s"))
    return fields


def _record_quick_work_target(owner: str, repo_name: str, issue_number: int, title: str) -> None:
    """Write to .pecot-active even with --no-branch (a failure is only a warning)"""
    from cli.core.state import ensure_work_dir, write_work_target

    try:
        issue_ref = f"{owner}/{repo_name}/{issue_number}"
        write_work_target(issue_ref, title)
        typer.echo(f"  Saved work target: {issue_ref}")
        if ensure_work_dir(issue_ref):
            typer.echo(f"  作業ファイル置き場: {WORK_DIR}/{issue_number}/")
    except Exception as e:
        typer.echo(f"警告: 作業対象の記録に失敗: {e}", err=True)


def _quick_branch_or_record(
    config: ProjectConfig,
    client: GitHubClient,
    owner: str,
    repo_name: str,
    issue_number: int,
    issue_node_id: str,
    title: str,
    no_branch: bool,
) -> None:
    """9. Create a branch (with --no-branch, only record the work target)"""
    if no_branch:
        _record_quick_work_target(owner, repo_name, issue_number, title)
        return
    typer.echo("Creating linked branch...")
    try:
        _create_branch_for_quick_issue(
            config=config,
            client=client,
            owner=owner,
            repo=repo_name,
            issue_number=issue_number,
            issue_node_id=issue_node_id,
            title=title,
        )
    except GitHubAPIError as e:
        typer.echo(f"警告: ブランチ作成失敗: {e.message}", err=True)
        typer.echo("手動でブランチを作成してください", err=True)


def issue_quick_command(
    message: Annotated[
        str,
        typer.Option("--message", "-m", help="Issue message (free format)"),
    ],
    repo: Annotated[
        str,
        typer.Option("--repo", "-r", help="Repository (owner/repo form)"),
    ],
    parent_epic: Annotated[
        str | None,
        typer.Option(
            "--parent-epic",
            help="Parent Epic reference: an integer (relative to aggregation_repo) or the primary form 'owner/repo/N'",
        ),
    ] = None,
    order: Annotated[
        int | None,
        typer.Option("--order", help="Order number of the subtask (used with parent_epic)"),
    ] = None,
    no_branch: Annotated[
        bool,
        typer.Option("--no-branch", help="Skip creating a branch"),
    ] = False,
    issue_type: Annotated[
        IssueType,
        typer.Option("--type", help="Issue type (task/bug/epic/tracker)"),
    ] = "task",
) -> None:
    """Create an Issue at once from a free-format message

    A quick-create command for keeping a record even of small tasks.
    The title is generated automatically and template validation is skipped.

    Fixed settings.

      - type: set with the --type option (default: task).
      - status: "backlog" for epic, "active" otherwise.
        For quick, creating the Issue is the start of the work, so it is active (see issue-flow-rules.md §4).
      - priority: medium.
      - size: s (not set for epic).
      - Branch name: feat/{YYYYMMDD-HHMMSS}/{issue_number}.

    Example.
      $ pecot issue quick -r owner/repo -m "Add an API endpoint"

    With a parent Epic.
      $ pecot issue quick -r owner/repo -m "Fix a bug" --parent-epic 353

    Without creating a branch.
      $ pecot issue quick -r owner/repo -m "Update the docs" --no-branch

    To create an Epic.
      $ pecot issue quick -r owner/repo --type epic -m "Authentication" --no-branch
    """
    # 1. 引数バリデーション
    owner, repo_name = _parse_quick_args(message, repo)

    # 2. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2.5. parent_epic の早期解決（aggregation_repo 基準 / クロスリポ対応）
    parent_epic_value = _normalize_parent_epic_cli(parent_epic)
    parent_ref: IssueRef | None = (
        _resolve_parent_epic_ref(parent_epic_value, config, owner, repo_name)
        if parent_epic_value is not None
        else None
    )

    # 3. タイトル自動生成（先頭50文字、改行・連続空白を単一スペースに正規化）
    title_clean = re.sub(r"\s+", " ", message[:50]).strip()
    final_title = _build_issue_title(
        issue_type, title_clean, parent_ref.number if parent_ref else None, order
    )

    # 4〜5. クライアント初期化・リポジトリ確認・order重複チェック
    client = _client_for_issue_create(config, owner, repo_name, repo, parent_ref, order)

    # 6. Issue作成（テンプレート検証をスキップ）
    body = message.rstrip() + "\n\n" + _QUICK_BODY_FOOTER
    issue = _create_issue_or_exit(client, owner, repo_name, final_title, body, None)
    issue_number = issue["number"]
    typer.echo(f"  Created: #{issue_number}")
    consume_flag(FLAG_ISSUE_PENDING)
    consume_flag(FLAG_ISSUE_CREATE_SLASH_PENDING)

    # 6〜11. ボード追加・フィールド設定・親Epic紐づけ・ブランチ作成・結果出力
    _finish_quick_issue(config, client, owner, repo_name, issue, issue_type, parent_ref, no_branch)


def _finish_quick_issue(
    config: ProjectConfig,
    client: GitHubClient,
    owner: str,
    repo_name: str,
    issue: dict[str, Any],
    issue_type: IssueType,
    parent_ref: IssueRef | None,
    no_branch: bool,
) -> None:
    """Post-process an Issue created by quick (stop there if adding to the board failed)"""
    issue_number = issue["number"]
    issue_url = issue["html_url"]

    # 6. ボード追加
    added = _add_issue_to_board(
        client, config, owner, repo_name, issue_number, issue.get("node_id"), issue_url
    )
    if added is None:
        return
    item_id, issue_node_id = added

    # 7. カスタムフィールド設定（status=epic時backlog/それ以外active, priority=medium, size=s）
    _set_issue_fields(client, config, item_id, _quick_fields(issue_type))

    # 8. 親Epic紐づけ（オプション）
    if parent_ref is not None:
        # Epic に親Epic を指定した場合は警告
        if issue_type == "epic":
            typer.echo("警告: Epicに親Epicを指定することは推奨されません", err=True)
        _link_to_parent_epic(client, parent_ref, issue_node_id, issue_url)

    # 9. ブランチ作成（--no-branchでスキップ可能）
    _quick_branch_or_record(
        config,
        client,
        owner,
        repo_name,
        issue_number,
        issue_node_id,
        issue.get("title", ""),
        no_branch,
    )

    # 10. クイックモードフラグを作成（Backlog に置く型を除く）
    if issue_type not in BACKLOG_TYPES:
        from cli.core.state import FLAG_PECOT_QUICK_MODE, touch_flag

        touch_flag(FLAG_PECOT_QUICK_MODE)

    # 11. 結果出力
    typer.echo(f"\n{issue_url}")


def _create_branch_for_quick_issue(
    config: ProjectConfig,
    client: GitHubClient,
    owner: str,
    repo: str,
    issue_number: int,
    issue_node_id: str,
    title: str,
) -> None:
    """Create a branch after the Issue is created (internal function).

    Args:
        config: Project config.
        client: GitHub client.
        owner: Repository owner.
        repo: Repository name.
        issue_number: Issue number.
        issue_node_id: Issue node ID.
        title: Issue title (material for the session name).
    """
    from cli.core.state import ensure_work_dir, write_work_target

    # 1. ベースブランチ決定
    repo_config = config.find_repository(owner, repo)
    if not repo_config or not repo_config.develop_branch:
        typer.echo(
            f"エラー: リポジトリ {owner}/{repo} の develop_branch が設定されていません", err=True
        )
        typer.echo("", err=True)
        typer.echo("以下のコマンドで設定してください:", err=True)
        typer.echo(f"  pecot project set-repo {owner}/{repo} --develop-branch develop", err=True)
        typer.echo("  # または: --develop-branch develop-aist, --develop-branch main", err=True)
        raise typer.Exit(1)

    base_branch = repo_config.develop_branch

    # 2. タイムスタンプ形式のブランチ名生成（Issue番号を明示的に付与）
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    branch_name = f"feat/{timestamp}/{issue_number}"

    # 3. ベースブランチのSHA取得
    base_sha = client.get_branch_sha(owner, repo, base_branch)

    # 4. LinkedBranch作成
    created_branch = client.create_linked_branch(
        issue_id=issue_node_id,
        oid=base_sha,
        name=branch_name,
    )
    typer.echo(f"  Created branch: {created_branch}")

    # 5. ブランチ切り替え案内（具体的なコマンドを表示）
    from cli.core.worktree import get_current_worktree_name

    typer.echo("")
    try:
        wt_name = get_current_worktree_name(Path.cwd())
    except Exception:
        wt_name = None

    if wt_name:
        typer.echo(f"  ★ 作業対象リポジトリのワークツリー({wt_name})で以下を実行してください:")
    else:
        typer.echo("  ★ 以下のコマンドを即座に実行してブランチを切り替えてください:")
    typer.echo("    git fetch origin")
    typer.echo(f"    git checkout {created_branch}")

    # 6. .pecot-active と .pecot-session-title の書き込み
    issue_ref = f"{owner}/{repo}/{issue_number}"
    write_work_target(issue_ref, title)
    typer.echo(f"  Saved work target: {issue_ref}")
    if ensure_work_dir(issue_ref):
        typer.echo(f"  作業ファイル置き場: {WORK_DIR}/{issue_number}/")


# --- issue comment コマンド ---


def _report_template_violations(
    body: str, template_path: Path, *, em_dash_hint: bool = False
) -> bool:
    """Validate a body against a template and print violations as error lines to stderr (shared function).

    There are five kinds of error line, and one line is printed for each kind that has a violation:
    missing sections, heading summary rule violations, unusable notation, collapse rule violations,
    and headings not in the template (only for templates with closed headings).

    Args:
        body: Body to post.
        template_path: Path of the template used for validation.
        em_dash_hint: Whether to print the U+2014 hint when an em-dash heading is missing.

    Returns:
        True if there is a violation.
    """
    required_sections = extract_sections_from_template(template_path)
    missing = validate_sections(body, required_sections) if required_sections else []
    summary_errors = (
        validate_heading_summaries(body, required_sections) if required_sections else []
    )
    # 記法チェックはテンプレート抽出の成否に依らず掛ける
    style_errors = validate_body_style(body)
    # 折りたたみの規則と見出しの集合はテンプレごとに決まる（対象外のテンプレは検証しない）
    closed_guidance = CLOSED_HEADINGS_BY_TEMPLATE.get(template_path.stem)
    fold_errors = validate_fold_balance(body) if closed_guidance is not None else []
    extra_headings = (
        validate_closed_headings(body, required_sections)
        if closed_guidance is not None and required_sections
        else []
    )
    fold_summary = FOLD_SUMMARY_BY_TEMPLATE.get(template_path.stem)
    if fold_summary is not None:
        fold_errors += validate_fold_summaries(body, fold_summary)

    if missing:
        typer.echo(f"エラー: 不足セクション: {', '.join(missing)}", err=True)
        if em_dash_hint and any(" — <サマリ>" in m for m in missing):
            typer.echo(
                "ヒント: em-dash は U+2014 (—) 必須。半角ハイフン (-)・EN DASH (–) は不可",
                err=True,
            )
    if summary_errors:
        typer.echo(f"エラー: 見出しサマリの規則違反: {', '.join(summary_errors)}", err=True)
    if style_errors:
        typer.echo(f"エラー: 使用できない記法: {', '.join(style_errors)}", err=True)
    if fold_errors:
        typer.echo(f"エラー: 折りたたみの規則違反: {', '.join(fold_errors)}", err=True)
    if extra_headings:
        typer.echo(
            f"エラー: テンプレに無い見出し: {', '.join(extra_headings)}（{closed_guidance}）",
            err=True,
        )
    if missing or summary_errors or style_errors or fold_errors or extra_headings:
        typer.echo(f"テンプレート: {template_path}", err=True)
        return True
    return False


def _validate_issue_template(template_type: IssueTemplateType, body: str) -> None:
    """Check an Issue against its template (shared function).

    Args:
        template_type: Template type (task/bug/epic/tracker/task-implement).
        body: Issue body.

    Raises:
        typer.Exit: On a validation error (exit code 1).
    """
    template_path = TEMPLATES_DIR / f"{template_type}.md"
    if _report_template_violations(body, template_path, em_dash_hint=True):
        raise typer.Exit(1)


# --- 統一 issue comment コマンド ---


def issue_comment(
    ctx: typer.Context,
    file: Annotated[
        Path | None,
        typer.Argument(help="Path of a Markdown file with frontmatter"),
    ] = None,
    message: Annotated[
        str | None,
        typer.Option(
            "--message",
            "-m",
            help="Comment body",
        ),
    ] = None,
    issue: Annotated[
        str | None,
        typer.Option(
            "--issue",
            "-i",
            help="Issue reference (owner/repo/123 form, required with -m)",
        ),
    ] = None,
    prepare: Annotated[
        bool,
        typer.Option(
            "--prepare",
            "-p",
            help="Copy a template to the work directory",
        ),
    ] = False,
    template: Annotated[
        CommentTemplate | None,
        typer.Option(
            "--template",
            "-t",
            help=(
                "Template type (required with --prepare and -m; plan/merge-diff/review-findings/review-resolution/precede-notify)"
            ),
        ),
    ] = None,
) -> None:
    """Post a comment on an Issue

    There are three modes.

    1. Direct posting (the -m option).
       $ pecot issue comment -m "## Merge — ..." -t merge-diff --issue owner/repo/123

    2. Template preparation.
       $ pecot issue comment --prepare -t plan [--issue owner/repo/123]

    3. Post from a file (the template is decided by the template in the frontmatter).
       $ pecot issue comment ./tmp/pecot/comment-plan-xxx.md

       After posting, the comment URL is written back to comment_url in the frontmatter of the same file.
       Given a file that has comment_url, it rewrites that comment instead of posting a new one.

    Exit codes: a template validation failure is 3.
    A failure means a missing section, a heading summary rule violation, unusable notation,
    a collapse rule violation, or a heading not in the template.
    A network failure, a missing config, or missing arguments is 1.
    """
    # モード判定
    if (prepare or (file is None and message is not None)) and template is None:
        typer.echo(
            f"エラー: -t でテンプレートを指定してください（{_COMMENT_TEMPLATE_CHOICES}）", err=True
        )
        raise typer.Exit(1)
    if prepare:
        assert template is not None
        _issue_comment_prepare(template, issue)
    elif file is not None:
        _issue_comment_from_file(ctx, file)
    elif message is not None:
        if not issue:
            typer.echo("エラー: -m使用時は --issue (Issue参照) が必須です", err=True)
            raise typer.Exit(1)
        assert template is not None
        _issue_comment_direct(ctx, issue, message, template)
    else:
        # 引数不足
        typer.echo("エラー: 引数が不足しています", err=True)
        typer.echo("", err=True)
        typer.echo("使用方法:", err=True)
        typer.echo(
            '  直接投稿: pecot issue comment -m "メッセージ" --issue owner/repo/123', err=True
        )
        typer.echo("  テンプレート準備: pecot issue comment --prepare -t <テンプレート>", err=True)
        typer.echo("  ファイルから: pecot issue comment <path>", err=True)
        raise typer.Exit(1)


_COMMENT_TEMPLATE_CHOICES = " / ".join(get_args(CommentTemplate))


def _issue_comment_prepare(template: CommentTemplate, issue_ref: str | None) -> None:
    """Copy a template to the work directory (internal function)"""
    # 1. テンプレートファイルのパス
    template_path = COMMENT_TEMPLATES_DIR / f"{template}.md"

    if not template_path.exists():
        typer.echo(f"テンプレートが見つかりません: {template_path}", err=True)
        raise typer.Exit(1)

    # 2. テンプレート読み込み
    content = template_path.read_text(encoding="utf-8")

    # 3. issue_ref が指定されている場合はフロントマターを更新
    if issue_ref:
        content = content.replace('issue_ref: ""', f'issue_ref: "{issue_ref}"')

    # 4. 出力パス予約（プロジェクトルート基準・同名があれば ts を 1 秒進めて再試行）
    #    5. 書き込み・パス出力（書き込み前に失敗した場合は予約を撤去する）
    try:
        with reserved_output_path(
            get_output_dir(), lambda ts: f"comment-{template}-{ts}.md"
        ) as output_path:
            output_path.write_text(content, encoding="utf-8")
            typer.echo(str(output_path))
    except OutputPathReservationError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None


def _issue_comment_from_file(ctx: typer.Context | None, file: Path) -> None:
    """Post a comment from a file (internal function)"""
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. ファイル読み込み・パース
    try:
        parsed = parse_comment_file(file)
    except FrontmatterError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None

    fm = parsed.frontmatter

    # 3. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, fm.issue_ref)
    except typer.BadParameter as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(2) from None

    # 4. バリデーション: テンプレートからセクションを動的抽出してチェック
    if fm.template is None:
        typer.echo(
            f"エラー: frontmatter の template を指定してください（{_COMMENT_TEMPLATE_CHOICES}）",
            err=True,
        )
        raise typer.Exit(1)
    template_path = COMMENT_TEMPLATES_DIR / f"{fm.template}.md"
    if _report_template_violations(parsed.body, template_path):
        raise typer.Exit(COMMENT_VALIDATION_EXIT_CODE)

    # 5. comment_url は、issue_ref と同じ Issue のコメントに限る
    comment_id = 0
    if fm.comment_url:
        comment_id = _comment_id_for_issue(fm.comment_url, config.host, owner, repo, issue_number)

    # 6. クライアント初期化
    client = GitHubClient(host=config.host)

    # 7. リポジトリがプロジェクトに含まれているか確認（警告のみ）
    if not config.is_repo_in_project(owner, repo, client):
        typer.echo(f"警告: {owner}/{repo} はプロジェクトに含まれていません", err=True)

    # 8. comment_url があれば、そのコメントを書き換える
    if fm.comment_url:
        try:
            comment = client.update_issue_comment(owner, repo, comment_id, parsed.body)
        except GitHubAPIError as e:
            typer.echo(f"エラー: コメント更新失敗: {e.message}", err=True)
            raise typer.Exit(1) from None
        typer.echo(f"コメント更新完了: {owner}/{repo}/{issue_number}")
        typer.echo(comment.get("html_url", fm.comment_url))
        return

    # 9. コメント投稿
    try:
        comment = client.add_issue_comment(owner, repo, issue_number, parsed.body)
    except GitHubAPIError as e:
        typer.echo(f"エラー: コメント投稿失敗: {e.message}", err=True)
        raise typer.Exit(1) from None
    comment_url = comment.get("html_url", "")
    typer.echo(f"コメント投稿完了: {owner}/{repo}/{issue_number}")
    typer.echo(comment_url)

    # 10. 次に同じファイルを渡したとき更新になるよう、URL を書き戻す
    if comment_url:
        try:
            content = file.read_text(encoding="utf-8")
            file.write_text(
                set_frontmatter_value(content, "comment_url", comment_url), encoding="utf-8"
            )
        except (OSError, FrontmatterError) as e:
            typer.echo(f"警告: comment_url をファイルに書き戻せませんでした: {e}", err=True)


# PR へのコメントは GitHub が /pull/ の形で html_url を返すので、両方受ける
_COMMENT_URL_RE = re.compile(
    r"^https?://(?P<host>[^/]+)/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?:issues|pull)/(?P<number>\d+)#issuecomment-(?P<id>\d+)$"
)


def _comment_id_for_issue(
    comment_url: str, host: str, owner: str, repo: str, issue_number: int
) -> int:
    """Get the comment id from comment_url. Stop if it points to an Issue other than issue_ref"""
    match = _COMMENT_URL_RE.match(comment_url.strip())
    if match is None:
        typer.echo(
            f"エラー: comment_url の形が違います: {comment_url}"
            "。https://<host>/<owner>/<repo>/{issues|pull}/<番号>#issuecomment-<id> の形で指定してください",
            err=True,
        )
        raise typer.Exit(1)
    if match["host"].lower() != host.lower():
        typer.echo(
            f"エラー: comment_url のホスト（{match['host']}）が設定のホスト（{host}）と違います",
            err=True,
        )
        raise typer.Exit(1)
    target = (match["owner"].lower(), match["repo"].lower(), int(match["number"]))
    if target != (owner.lower(), repo.lower(), issue_number):
        typer.echo(
            f"エラー: comment_url（{match['owner']}/{match['repo']}/{match['number']}）が"
            f" issue_ref（{owner}/{repo}/{issue_number}）と違う Issue を指しています",
            err=True,
        )
        raise typer.Exit(1)
    return int(match["id"])


def _issue_comment_direct(
    ctx: typer.Context | None,
    issue_ref: str,
    message: str,
    template: CommentTemplate,
) -> None:
    """Post a comment directly (internal function).

    Args:
        ctx: Typer Context (used to resolve base_repo for ``--repo``).
        issue_ref: Issue reference (owner/repo/N, or the short form N).
        message: Comment body.
        template: Template type.
    """
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, issue_ref)
    except typer.BadParameter as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(2) from None

    # 3. バリデーション: テンプレートからセクションを動的抽出してチェック
    template_path = COMMENT_TEMPLATES_DIR / f"{template}.md"
    if _report_template_violations(message, template_path):
        raise typer.Exit(COMMENT_VALIDATION_EXIT_CODE)

    # 4. クライアント初期化
    client = GitHubClient(host=config.host)

    # 6. コメント投稿
    try:
        comment = client.add_issue_comment(owner, repo, issue_number, message)
        comment_url = comment.get("html_url", "")
        typer.echo(f"コメント投稿完了: {issue_ref}")
        typer.echo(comment_url)
    except GitHubAPIError as e:
        typer.echo(f"エラー: コメント投稿失敗: {e.message}", err=True)
        raise typer.Exit(1) from None


# --- issue read コマンド ---


def _format_issue_markdown(issue: dict[str, Any]) -> str:
    """Format Issue information as Markdown

    Args:
        issue: Return value of get_issue_slim

    Returns:
        A string in Markdown
    """
    lines: list[str] = []

    # ヘッダー
    lines.append(f"## #{issue['number']} {issue['title']}")
    lines.append("")

    # メタ情報
    meta_parts = [f"**State:** {issue['state']}"]
    if issue["comments"]["total_count"] > 0:
        meta_parts.append(f"**Comments:** {issue['comments']['total_count']}")
    lines.append(" | ".join(meta_parts))
    lines.append("")

    # 親Issue
    if issue.get("parent"):
        parent = issue["parent"]
        parent_owner = parent.get("owner")
        parent_repo = parent.get("repo")
        current_owner = issue.get("owner")
        current_repo = issue.get("repo")
        is_cross_repo = (
            parent_owner is not None
            and parent_repo is not None
            and current_owner is not None
            and current_repo is not None
            and (parent_owner != current_owner or parent_repo != current_repo)
        )
        if is_cross_repo:
            lines.append(
                f"**Parent:** {parent_owner}/{parent_repo}#{parent['number']} "
                f"{parent['title']} ({parent['state']})"
            )
        else:
            lines.append(f"**Parent:** #{parent['number']} {parent['title']} ({parent['state']})")
        lines.append("")

    # リンクブランチ
    if issue.get("linked_branches"):
        lines.append("**Branches:**")
        for branch in issue["linked_branches"]:
            lines.append(f"  - `{branch}`")
        lines.append("")

    # リンクPR
    if issue.get("linked_prs"):
        lines.append("**Linked PRs:**")
        for pr in issue["linked_prs"]:
            state_mark = "✓" if pr["state"] == "MERGED" else "○"
            lines.append(f"  - [{state_mark}] #{pr['number']} {pr['title']} ({pr['state']})")
        lines.append("")

    # サブIssue
    if issue.get("sub_issues"):
        lines.append("**Sub-issues:**")
        for sub in issue["sub_issues"]:
            state_mark = "✓" if sub["state"] == "CLOSED" else "○"
            lines.append(f"  - [{state_mark}] #{sub['number']} {sub['title']}")
        lines.append("")

    # 本文
    lines.append("---")
    lines.append("")
    lines.append(issue["body"])

    # コメント
    if issue.get("comments", {}).get("nodes"):
        comments = issue["comments"]["nodes"]
        total_count = issue["comments"]["total_count"]
        lines.append("")
        lines.append("")
        lines.append(f"### Comments ({len(comments)}/{total_count})")
        lines.append("")

        for comment in comments:
            lines.append("---")
            lines.append("")
            created_at = comment["created_at"][:10]  # YYYY-MM-DD
            lines.append(f"**@{comment['author']}** - {created_at}")
            lines.append("")
            lines.append(comment["body"])
            lines.append("")

    return "\n".join(lines)


def issue_read(
    ctx: typer.Context,
    issue_ref: Annotated[
        str,
        typer.Argument(
            help="Issue reference (`owner/repo/N`, or the short form `N` only with `--repo`)"
        ),
    ],
    json_output: Annotated[
        bool,
        typer.Option(
            "--json",
            "-j",
            help="Output as JSON",
        ),
    ] = False,
    comment_limit: Annotated[
        int,
        typer.Option(
            "--comment-limit",
            "-c",
            help="Number of comments to show (0-20; 0 hides them)",
            min=0,
            max=20,
        ),
    ] = 5,
) -> None:
    """Fetch Issue details efficiently (GraphQL, only the needed fields)

    Compared with the REST API and MCP, it has these advantages.

    - Cuts token use by leaving out unneeded fields.
    - Fetches the parent Issue, sub-issues, and linked branches in one query.
    """
    import json

    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. issue_ref をパース
    try:
        base = _resolve_base_repo(ctx)
        ref = parse_issue_ref(issue_ref, base_repo=base)
    except RefParseError as e:
        typer.echo(str(e.message), err=True)
        raise typer.Exit(2) from None

    # 3. クライアント初期化・Issue取得
    owner, repo, issue_number = ref.repo.owner, ref.repo.repo, ref.number
    try:
        client = GitHubClient(host=config.host)
        issue = client.get_issue_slim(owner, repo, issue_number, comment_limit=comment_limit)
        issue["owner"] = owner
        issue["repo"] = repo
    except GitHubAPIError as e:
        typer.echo(f"エラー: {e.message}", err=True)
        raise typer.Exit(1) from None

    # 4. 出力
    if json_output:
        typer.echo(json.dumps(issue, ensure_ascii=False, indent=2))
    else:
        typer.echo(_format_issue_markdown(issue))
