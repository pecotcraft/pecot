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

from cli.commands._output import Operation, Output, Verb
from cli.commands._work_target import record_work_target
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
    out: Output,
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
        out: Functions that print lines.
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
            out.error(
                "cannot decide where to create the Epic\n"
                "declare aggregation_repo in the project config, or pass --repo"
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
        ref = parse_issue_ref(raw, base_repo=base, repo_flag=True)
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

    The resolved reference is shown on the line that links the sub-issue, so nothing is printed here.
    """
    base = config.aggregation_repo_ref or RepoRef(owner=task_owner, repo=task_repo)
    try:
        return parse_issue_ref(str(raw), base_repo=base)
    except RefParseError as e:
        raise typer.BadParameter(
            f"could not resolve parent_epic: {e.message}\n"
            "accepted forms: an integer (Issue number in aggregation_repo) or the primary form 'owner/repo/N'"
        ) from None


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
    out: Output,
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
        out: Functions that print lines.
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
        out.warning(f"could not fetch the parent Epic #{parent_epic}: {e.message}")
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
            conflict = f"an Issue with order={order}"
            suggestion = f"next available order: {next_order}"
        else:
            letter = next(
                (c for c in string.ascii_lowercase if c not in same_order_parallels), None
            )
            if None in same_order_parallels or letter is None:
                suggestion = f"next available order: {max(used_orders) + 1}"
            else:
                suggestion = f"next available number: {_order_label(order, letter)}"
            conflict = (
                f"an Issue ({_order_label(order, duplicate_parallel)}) "
                f"that conflicts with order={_order_label(order, parallel)}"
            )
        out.error(
            f"Epic #{parent_epic} already has {conflict} ({state_label})\n"
            f"#{duplicate_sub['number']} {duplicate_sub['title']}\n"
            f"{suggestion}"
        )
        raise typer.Exit(1)


def add_to_project(
    ctx: typer.Context,
    issue_ref: str = typer.Argument(
        ...,
        help="Issue reference (`owner/repo/N`, or the short form `N` in the repository of `--repo`, or else of the git remote of the current directory)",
    ),
    status: str | None = typer.Option(
        "ready",
        "--status",
        "-s",
        help="Initial status (backlog/pending/ready/active/in_review/archived)",
    ),
) -> None:
    """Add an Issue to the project board with a GraphQL mutation"""
    out = Output(dry_run=False)
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    # 2. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, issue_ref)
    except typer.BadParameter as e:
        out.error(str(e))
        raise typer.Exit(2) from None
    target = f"Issue {owner}/{repo}/{issue_number}"

    try:
        client = GitHubClient(host=config.host)

        # 3. リポジトリがプロジェクトに含まれているか確認
        if not config.is_repo_in_project(owner, repo, client):
            out.error(f"repository {owner}/{repo} is not in the project")
            raise typer.Exit(1)

        # 4. Issue Node ID 取得
        issue_node_id = client.get_issue_node_id(owner, repo, issue_number)

        # 5. プロジェクトに追加
        item_id = client.add_to_project(config.project.id, issue_node_id)
        out.done(Operation(Verb.ADD, f"{target} to project"))

        # 6. ステータス設定（オプション）
        if status:
            field_id = config.get_field_id("workflow")
            option_id = config.get_option_id("workflow", status)
            if field_id and option_id:
                client.update_project_item_field(config.project.id, item_id, field_id, option_id)
                out.done(Operation(Verb.SET, f"{target} status {status}"))
            else:
                out.warning(f"status '{status}' not found in the project")

    except GitHubAPIError as e:
        out.error(f"could not add {target} to project: {e.message}")
        raise typer.Exit(1) from None


# 有効なステータス値
VALID_STATUSES = {"backlog", "pending", "ready", "active", "in_review", "archived"}


def _exit_invalid_status(out: Output, status: str) -> NoReturn:
    """Print the invalid status error with the valid values, then exit 1"""
    out.error(
        f"invalid status: {status}\nvalid values: backlog/pending/ready/active/in_review/archived"
    )
    raise typer.Exit(1)


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


def _validate_status_for_type(out: Output, issue_type: IssueType, status: str) -> None:
    """Check that the status at creation matches the default of the type's template (#669).

    Tells apart a value outside the enum (e.g. ``--status foo``) from the default of another template that conflicts with the type.
    An example of the latter is ``--type bug --status backlog``. Both are rejected with exit 1.

    Step 1 (the enum check) is for direct input only.
    For file input, ``WorkflowStatus.value`` is passed, so it is always in ``VALID_STATUSES``.
    A value outside the enum can arrive only through direct input, which takes ``--status`` as is.
    """
    # 1) enum 外の値は不正ステータスとして拒否（現状の silent skip を明示エラー化）
    if status not in VALID_STATUSES:
        _exit_invalid_status(out, status)

    # 2) 型に対応しない status（別テンプレートの配置値）を拒否
    expected = TYPE_DEFAULT_STATUS[issue_type]
    if status != expected:
        out.error(
            f"the status at creation for type '{issue_type}' is only '{expected}' (given: {status})\n"
            "hint: move it to pending or another status on the board after creation"
        )
        raise typer.Exit(1)


def update_issue_status(
    ctx: typer.Context,
    issue_ref: str = typer.Argument(
        ...,
        help="Issue reference (`owner/repo/N`, or the short form `N` in the repository of `--repo`, or else of the git remote of the current directory)",
    ),
    status: str = typer.Argument(
        ...,
        help="Status (backlog/pending/ready/active/in_review/archived)",
    ),
) -> None:
    """Update the status of an Issue on the project board by Issue number"""
    out = Output(dry_run=False)
    # 1. ステータスバリデーション
    if status not in VALID_STATUSES:
        _exit_invalid_status(out, status)

    # 2. 設定取得
    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    # 3. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, issue_ref)
    except typer.BadParameter as e:
        out.error(str(e))
        raise typer.Exit(2) from None
    target = f"Issue {owner}/{repo}/{issue_number}"

    try:
        client = GitHubClient(host=config.host)

        # 4. リポジトリがプロジェクトに含まれているか確認
        if not config.is_repo_in_project(owner, repo, client):
            out.error(f"repository {owner}/{repo} is not in the project")
            raise typer.Exit(1)

        # 5. Issue番号からプロジェクトアイテムIDを取得
        item_id = client.get_item_id_by_issue(config.project.id, owner, repo, issue_number)

        if item_id is None:
            out.error(
                f"{target} is not on the project board\n"
                "hint: add it to the board first with add-to-project"
            )
            raise typer.Exit(1)

        # 6. ステータス更新
        field_id = config.get_field_id("workflow")
        option_id = config.get_option_id("workflow", status)

        if not field_id or not option_id:
            out.error(f"status '{status}' is not configured in the project")
            raise typer.Exit(1)

        client.update_project_item_field(config.project.id, item_id, field_id, option_id)
        out.done(Operation(Verb.SET, f"{target} status {status}"))

    except GitHubAPIError as e:
        out.error(f"could not set {target} status {status}: {e.message}")
        raise typer.Exit(1) from None


def issue_reopen_command(
    ctx: typer.Context,
    issue_ref: str = typer.Argument(
        ...,
        help="Issue reference (`owner/repo/N`, or the short form `N` in the repository of `--repo`, or else of the git remote of the current directory)",
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
    out = Output(dry_run=False)
    # 1. ステータスバリデーション
    if status not in VALID_STATUSES:
        _exit_invalid_status(out, status)

    # 2. 設定取得
    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    # 3. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, issue_ref)
    except typer.BadParameter as e:
        out.error(str(e))
        raise typer.Exit(2) from None
    target = f"Issue {owner}/{repo}/{issue_number}"

    try:
        client = GitHubClient(host=config.host)

        # 4. リポジトリがプロジェクトに含まれているか確認
        if not config.is_repo_in_project(owner, repo, client):
            out.error(f"repository {owner}/{repo} is not in the project")
            raise typer.Exit(1)

        # 5. Issue再オープン（1回目 — ステータス更新の前提としてOPENにする）
        client.reopen_issue(owner, repo, issue_number)

        # 6. Projects V2ステータス更新
        item_id = client.get_item_id_by_issue(config.project.id, owner, repo, issue_number)

        if item_id is None:
            out.warning(f"{target} is not on the project board")
        else:
            field_id = config.get_field_id("workflow")
            option_id = config.get_option_id("workflow", status)

            if not field_id or not option_id:
                out.warning(f"status '{status}' is not configured in the project")
            else:
                client.update_project_item_field(config.project.id, item_id, field_id, option_id)
                out.done(Operation(Verb.SET, f"{target} status {status}"))
                # Projects V2 Automationが非同期でIssueをcloseする可能性があるため待機
                time.sleep(3)

        # 7. Issue再オープン（2回目 — Automationによるclose対策）
        result = client.reopen_issue(owner, repo, issue_number)
        if result.get("state") != "open":
            out.error(f"{target} did not become open (state: {result.get('state')})")
            raise typer.Exit(1)
        out.done(Operation(Verb.REOPEN, target))

        # 8. コメント投稿 (--comment指定時)
        if comment:
            client.add_issue_comment(owner, repo, issue_number, comment)
            out.done(Operation(Verb.CREATE, f"comment on {owner}/{repo}/{issue_number}"))

    except GitHubAPIError as e:
        out.error(f"could not reopen {target}: {e.message}")
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
    out = Output(dry_run=False)
    # モード判定
    if prepare:
        _issue_create_prepare(out, template, repo, suffix)
    elif files:
        _issue_create_from_files(out, files)
    elif message is not None:
        _issue_create_message_mode(
            message, title, repo, issue_type, status, priority, size, parent_epic, labels, order
        )
    else:
        # 引数不足
        _exit_with_issue_create_usage(out)


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
    out = Output(dry_run=False)
    # 直接投稿モード: -t は必須。-r は epic 以外で必須。
    if not title:
        out.error("-t (title) is required with -m")
        raise typer.Exit(1)
    resolved_repo = _resolve_message_mode_repo(out, issue_type, repo)
    _issue_create_direct(
        out,
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


def _resolve_message_mode_repo(out: Output, issue_type: IssueType, repo: str | None) -> str:
    """Decide the target repository in direct posting mode (-r is required except for epic; epic uses aggregation_repo)"""
    if issue_type != "epic" and not repo:
        out.error("-r (repository) is required with -m")
        raise typer.Exit(1)

    resolved_repo = repo
    if issue_type == "epic":
        config = load_active_config()
        if config is None:
            out.error("no active project")
            raise typer.Exit(1)
        resolved_repo, warn = _resolve_epic_target_repo(out, repo, config)
        if warn:
            _warn_epic_repo_exception(out, resolved_repo, config)

    if resolved_repo is None:
        # epic 以外は上の -r 必須チェックで弾かれており、
        # epic は _resolve_epic_target_repo が必ず値か Exit を返す。
        # ここに到達するのは想定外状態なので明示エラーで止める
        # assert は ``-O`` 最適化で無効化されるため、if/raise にしている。
        out.error("could not resolve the repository to create the Epic in")
        raise typer.Exit(1)
    return resolved_repo


def _exit_with_issue_create_usage(out: Output) -> NoReturn:
    """Print usage to stderr when arguments are missing, then exit 1"""
    out.error(
        "missing arguments\n"
        'direct posting: pecot issue create -t "TITLE" -r owner/repo -m "BODY"\n'
        "prepare a template: pecot issue create --prepare --template task --repo owner/repo\n"
        "from a file: pecot issue create <path>"
    )
    raise typer.Exit(1)


_REPO_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _validate_repo_shape(out: Output, repo: str) -> None:
    """Validate the ``owner/repo`` form (exit 2 if invalid)."""
    parts = repo.split("/")
    if len(parts) != 2 or not all(_REPO_SEGMENT_RE.match(p) for p in parts):
        out.error(f"invalid repository format: {repo}\nexpected: owner/repo")
        raise typer.Exit(2)


def _issue_create_prepare(
    out: Output, template: IssueTemplateType, repo: str | None, suffix: str | None = None
) -> None:
    """Copy a template to the work directory (internal function)"""
    # 0. --repo 必須チェック（epic 以外は必須）
    if template != "epic":
        if repo is None:
            out.error(
                "--repo owner/repo is required with --template task|bug|tracker|task-implement"
            )
            raise typer.Exit(2)
    if repo is not None:
        _validate_repo_shape(out, repo)

    # 1. テンプレートファイルのパス
    template_path = TEMPLATES_DIR / f"{template}.md"

    if not template_path.exists():
        out.error(f"template not found: {template_path}")
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
            out.data(str(output_path))
    except OutputPathReservationError as e:
        out.error(str(e))
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


def _validate_issue_placeholders(out: Output, files: list[Path]) -> None:
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
            out.error(f"file specified more than once: {file}")
            raise typer.Exit(1)
        seen.add(resolved)
        if not file.is_file():
            out.error(f"file not found: {file}")
            raise typer.Exit(1)
        # frontmatter と冒頭ガイドコメントは投稿本文に出ないので走査対象から外す
        # （雛形の説明文にある {{issue:<suffix>}} を拾って誤検知していた: #958 F-01）
        body = strip_leading_html_comment(strip_frontmatter(file.read_text(encoding="utf-8")))
        for ref in _ISSUE_PLACEHOLDER_RE.findall(body):
            if ref not in available:
                out.error(
                    f"{{{{issue:{ref}}}}} in {file.name} does not point to an earlier file "
                    "(forward reference or unknown key)\n"
                    "put the file it depends on earlier in the arguments"
                )
                raise typer.Exit(1)
        keys = _issue_file_keys(file)
        if available & keys:
            out.error(
                f"placeholder keys collide: {', '.join(sorted(available & keys))} ({file.name})"
            )
            raise typer.Exit(1)
        available |= keys


def _issue_create_from_files(out: Output, files: list[Path]) -> None:
    """Post several files in a batch, in argument order (internal function)

    Expands Issue numbers created from earlier files into ``{{issue:<key>}}`` in later files
    before posting. When all succeed, consumes the slash-command exemption flag
    (on a mid-way failure it is not consumed, so the rest can be retried within the user-instructed flow).
    """
    _validate_issue_placeholders(out, files)
    created: dict[str, tuple[str, int]] = {}
    for file in files:
        repository, number = _issue_create_from_file(out, file, substitutions=created)
        for key in _issue_file_keys(file):
            created[key] = (repository, number)
    consume_flag(FLAG_ISSUE_CREATE_SLASH_PENDING)


def _warn_epic_repo_exception(out: Output, resolved_repo: str, config: ProjectConfig) -> None:
    """Warning for when the Epic target differs from aggregation_repo"""
    out.warning(
        f"--repo {resolved_repo} differs from aggregation_repo "
        f"({config.aggregation_repo})\n"
        "continuing as an exception for an Epic in an implementation repo"
    )


def _create_issue_or_exit(
    out: Output,
    client: GitHubClient,
    owner: str,
    repo: str,
    title: str,
    body: str,
    labels: list[str] | None,
    source: str | None = None,
) -> dict[str, Any]:
    """Create an Issue and print the result line (exit 1 on failure)

    Args:
        source: Name of the file the Issue is created from (shown after ``from``)
    """
    try:
        issue = create_issue(client, owner, repo, title, body, labels)
    except GitHubAPIError as e:
        out.error(f"could not create an Issue in {owner}/{repo}: {e.message}")
        raise typer.Exit(1) from None
    target = f"Issue {owner}/{repo}/{issue['number']}"
    out.done(Operation(Verb.CREATE, f"{target} from {source}" if source else target))
    return issue


def _add_issue_to_board(
    out: Output,
    client: GitHubClient,
    config: ProjectConfig,
    owner: str,
    repo: str,
    issue_number: int,
    issue_node_id: str | None,
    issue_url: str,
) -> tuple[str, str] | None:
    """Add to the board. Returns (item_id, issue_node_id) on success; on failure prints a warning and the URL and returns None."""
    try:
        added = add_issue_to_board(client, config, owner, repo, issue_number, issue_node_id)
    except GitHubAPIError as e:
        out.warning(f"could not add Issue {owner}/{repo}/{issue_number} to project: {e.message}")
        out.data(issue_url)
        return None
    out.done(Operation(Verb.ADD, f"Issue {owner}/{repo}/{issue_number} to project"))
    return added


def _set_issue_fields(
    out: Output,
    client: GitHubClient,
    config: ProjectConfig,
    item_id: str,
    target: str,
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
        out.done(Operation(Verb.SET, f"{target} {', '.join(fields_set)}"))


def _link_to_parent_epic(
    out: Output,
    client: GitHubClient,
    target: str,
    parent_ref: IssueRef,
    issue_node_id: str,
    issue_url: str,
) -> None:
    """Link as a sub-issue (on failure, print the URL and then exit 1)"""
    parent = parent_ref.to_cli_ref()
    try:
        parent_node_id = client.get_issue_node_id(
            parent_ref.repo.owner, parent_ref.repo.repo, parent_ref.number
        )
        client.add_sub_issue(parent_node_id, issue_node_id)
    except GitHubAPIError as e:
        out.data(issue_url)
        out.error(f"could not add {target} as sub-issue of {parent}: {e.message}")
        raise typer.Exit(1) from None
    out.done(Operation(Verb.ADD, f"{target} as sub-issue of {parent}"))


def _ensure_repo_in_project(
    out: Output, config: ProjectConfig, client: GitHubClient, owner: str, repo: str, display: str
) -> None:
    """Exit 1 if the repository is not linked to the project"""
    if not config.is_repo_in_project(owner, repo, client):
        out.error(f"{display} is not linked to the project")
        raise typer.Exit(1)


def _client_for_issue_create(
    out: Output,
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
    _ensure_repo_in_project(out, config, client, owner, repo, display)
    if parent_ref is not None and order is not None:
        _check_duplicate_order(
            out,
            client,
            parent_ref.repo.owner,
            parent_ref.repo.repo,
            parent_ref.number,
            order,
            parallel,
        )
    return client


def _resolve_file_target_repo(
    out: Output, fm: IssueFrontmatter, config: ProjectConfig
) -> tuple[str, str]:
    """2.5. Decide the target (owner, repo) for file input.

    When creating an Epic, applies aggregation_repo routing (FR-017-019).
    An empty frontmatter ``repository`` counts as omitted.
    """
    if fm.type == "epic":
        explicit_repo = fm.repository.strip() if fm.repository else None
        resolved_repo, warn = _resolve_epic_target_repo(out, explicit_repo, config)
        if warn:
            _warn_epic_repo_exception(out, resolved_repo, config)
        owner, repo = resolved_repo.split("/")
        return owner, repo
    if "/" not in fm.repository:
        out.error(f"invalid repository format in the frontmatter: {fm.repository!r}")
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
    out: Output, file: Path, substitutions: dict[str, tuple[str, int]] | None = None
) -> tuple[str, int]:
    """Create an Issue from a file (internal function)

    Returns:
        (repository "owner/repo", created Issue number)
    """
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    # 2. ファイル読み込み・パース
    try:
        parsed = parse_issue_file(file)
    except FrontmatterError as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    fm = parsed.frontmatter

    # 2.5. 作成先リポジトリ決定（Epic は aggregation_repo ルーティング）
    owner, repo = _resolve_file_target_repo(out, fm, config)

    # 2.7. 一括投稿時のプレースホルダ展開
    body = parsed.body
    if substitutions:
        body = _expand_issue_placeholders(body, substitutions, owner, repo)

    # 3. テンプレート準拠チェック
    template_type = fm.template or fm.type
    _validate_issue_template(out, template_type, body)

    # 3.1. status が型対応テンプレートの既定値と一致するか検証する（#669）。
    #      ``client.create_issue`` より前に純粋判定で拒否する。
    _validate_status_for_type(out, fm.type, fm.status.value)

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
        out, config, owner, repo, fm.repository, parent_ref, fm.order, fm.parallel
    )

    # 7. Issue作成
    issue = _create_issue_or_exit(
        out,
        client,
        owner,
        repo,
        title,
        body,
        fm.labels if fm.labels else None,
        source=file.name,
    )
    issue_number = issue["number"]
    issue_url = issue["html_url"]
    target = f"Issue {owner}/{repo}/{issue_number}"
    consume_flag(FLAG_ISSUE_PENDING)

    # 7. ボード追加
    added = _add_issue_to_board(out, client, config, owner, repo, issue_number, None, issue_url)
    if added is None:
        return f"{owner}/{repo}", issue_number
    item_id, issue_node_id = added

    # 8. カスタムフィールド設定
    fields: list[tuple[str, str, str]] = []
    if fm.status:
        fields.append(("workflow", fm.status, f"status {fm.status.value}"))
    if fm.priority:
        fields.append(("priority", fm.priority, f"priority {fm.priority.value}"))
    if fm.size:
        fields.append(("size", fm.size, f"size {fm.size.value}"))
    _set_issue_fields(out, client, config, item_id, target, fields)

    # 8. サブIssue紐づけ
    if parent_ref is not None:
        _link_to_parent_epic(out, client, target, parent_ref, issue_node_id, issue_url)

    # 9. 結果出力
    out.data(issue_url)
    return f"{owner}/{repo}", issue_number


def _issue_create_direct(
    out: Output,
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
        _validate_status_for_type(out, issue_type, status)

    # 1. 設定取得
    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    # 2. リポジトリ形式確認
    _validate_repo_shape(out, repo)
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
    _validate_issue_template(out, issue_type, message)

    # 5〜6. クライアント初期化・リポジトリ確認・order重複チェック
    client = _client_for_issue_create(out, config, owner, repo_name, repo, parent_ref, order)

    # 7. Issue作成
    issue = _create_issue_or_exit(
        out, client, owner, repo_name, final_title, message, labels if labels else None
    )
    issue_number = issue["number"]
    issue_url = issue["html_url"]
    target = f"Issue {owner}/{repo_name}/{issue_number}"
    consume_flag(FLAG_ISSUE_PENDING)

    # 8. ボード追加
    added = _add_issue_to_board(
        out, client, config, owner, repo_name, issue_number, issue.get("node_id"), issue_url
    )
    if added is None:
        return
    item_id, issue_node_id = added

    # 8. カスタムフィールド設定
    # status は step 0 で既定値適用・検証済みのため常に非 None（#669）。
    fields: list[tuple[str, str, str]] = [("workflow", status, f"status {status}")]
    if priority:
        fields.append(("priority", priority, f"priority {priority}"))
    if size:
        fields.append(("size", size, f"size {size}"))
    _set_issue_fields(out, client, config, item_id, target, fields)

    # 9. サブIssue紐づけ
    if parent_ref is not None:
        _link_to_parent_epic(out, client, target, parent_ref, issue_node_id, issue_url)

    # 10. 結果出力
    out.data(issue_url)


# --- issue quick コマンド ---


def _parse_quick_args(out: Output, message: str, repo: str) -> tuple[str, str]:
    """1. Validate arguments (an empty message or a malformed repository form exits 1)"""
    if not message or not message.strip():
        out.error("the message is empty")
        raise typer.Exit(1)

    parts = repo.split("/")
    if len(parts) != 2:
        out.error(f"invalid repository format: {repo}\nexpected: owner/repo")
        raise typer.Exit(1)
    return parts[0], parts[1]


def _quick_fields(issue_type: IssueType) -> list[tuple[str, str, str]]:
    """7. Fixed fields of quick.

    status is backlog for epic and active otherwise. priority is medium and size is s.
    """
    # status: epic なら "backlog"、それ以外なら "active"
    default_status = "backlog" if issue_type in BACKLOG_TYPES else "active"
    fields: list[tuple[str, str, str]] = [
        ("workflow", default_status, f"status {default_status}"),
        # priority: medium
        ("priority", "medium", "priority medium"),
    ]
    # size: s (Backlog に置く型以外)
    if issue_type not in BACKLOG_TYPES:
        fields.append(("size", "s", "size s"))
    return fields


def _quick_branch_or_record(
    out: Output,
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
        record_work_target(out, owner, repo_name, issue_number, title)
        return
    try:
        _create_branch_for_quick_issue(
            out,
            config=config,
            client=client,
            owner=owner,
            repo=repo_name,
            issue_number=issue_number,
            issue_node_id=issue_node_id,
            title=title,
        )
    except GitHubAPIError as e:
        out.warning(f"could not create the branch: {e.message}\ncreate the branch manually")


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
    out = Output(dry_run=False)
    # 1. 引数バリデーション
    owner, repo_name = _parse_quick_args(out, message, repo)

    # 2. 設定取得
    config = load_active_config()
    if config is None:
        out.error("no active project")
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
    client = _client_for_issue_create(out, config, owner, repo_name, repo, parent_ref, order)

    # 6. Issue作成（テンプレート検証をスキップ）
    body = message.rstrip() + "\n\n" + _QUICK_BODY_FOOTER
    issue = _create_issue_or_exit(out, client, owner, repo_name, final_title, body, None)
    consume_flag(FLAG_ISSUE_PENDING)
    consume_flag(FLAG_ISSUE_CREATE_SLASH_PENDING)

    # 6〜11. ボード追加・フィールド設定・親Epic紐づけ・ブランチ作成・結果出力
    _finish_quick_issue(
        out, config, client, owner, repo_name, issue, issue_type, parent_ref, no_branch
    )


def _finish_quick_issue(
    out: Output,
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
    target = f"Issue {owner}/{repo_name}/{issue_number}"

    # 6. ボード追加
    added = _add_issue_to_board(
        out, client, config, owner, repo_name, issue_number, issue.get("node_id"), issue_url
    )
    if added is None:
        return
    item_id, issue_node_id = added

    # 7. カスタムフィールド設定（status=epic時backlog/それ以外active, priority=medium, size=s）
    _set_issue_fields(out, client, config, item_id, target, _quick_fields(issue_type))

    # 8. 親Epic紐づけ（オプション）
    if parent_ref is not None:
        # Epic に親Epic を指定した場合は警告
        if issue_type == "epic":
            out.warning("giving a parent Epic to an Epic is not recommended")
        _link_to_parent_epic(out, client, target, parent_ref, issue_node_id, issue_url)

    # 9. ブランチ作成（--no-branchでスキップ可能）
    _quick_branch_or_record(
        out,
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
    out.data(issue_url)


def _create_branch_for_quick_issue(
    out: Output,
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
        out: Functions that print lines.
        config: Project config.
        client: GitHub client.
        owner: Repository owner.
        repo: Repository name.
        issue_number: Issue number.
        issue_node_id: Issue node ID.
        title: Issue title (material for the session name).
    """
    # 1. ベースブランチ決定
    repo_config = config.find_repository(owner, repo)
    if not repo_config or not repo_config.develop_branch:
        out.error(
            f"develop_branch is not set for repository {owner}/{repo}\n"
            f"set it with: pecot project set-repo {owner}/{repo} --develop-branch develop\n"
            "(or --develop-branch develop-aist / --develop-branch main)"
        )
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
    out.done(Operation(Verb.CREATE, f"branch {created_branch} in {owner}/{repo}"))

    # 5. .pecot-active と .pecot-session-title の書き込み
    record_work_target(out, owner, repo, issue_number, title)


# --- issue comment コマンド ---


def _report_template_violations(
    out: Output, body: str, template_path: Path, *, em_dash_hint: bool = False
) -> bool:
    """Validate a body against a template and print the violations as one error (shared function).

    The first line of the error is the template path. The following lines list each kind that has a violation:
    missing sections, heading summary rule violations, unusable notation, collapse rule violations,
    and headings not in the template (only for templates with closed headings).

    Args:
        out: Functions that print lines.
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

    if not (missing or summary_errors or style_errors or fold_errors or extra_headings):
        return False

    lines = [f"the body does not follow the template {template_path}"]
    if missing:
        lines.append(f"missing sections: {', '.join(missing)}")
        if em_dash_hint and any(" \u2014 <" in m for m in missing):
            lines.append(
                "hint: the em dash must be U+2014; hyphen-minus (-) and EN DASH (U+2013) are not allowed"
            )
    if summary_errors:
        lines.append(f"heading summary rule violations: {', '.join(summary_errors)}")
    if style_errors:
        lines.append(f"unusable notation: {', '.join(style_errors)}")
    if fold_errors:
        lines.append(f"collapse rule violations: {', '.join(fold_errors)}")
    if extra_headings:
        lines.append(
            f"headings not in the template: {', '.join(extra_headings)} ({closed_guidance})"
        )
    out.error("\n".join(lines))
    return True


def _validate_issue_template(out: Output, template_type: IssueTemplateType, body: str) -> None:
    """Check an Issue against its template (shared function).

    Args:
        out: Functions that print lines.
        template_type: Template type (task/bug/epic/tracker/task-implement).
        body: Issue body.

    Raises:
        typer.Exit: On a validation error (exit code 1).
    """
    template_path = TEMPLATES_DIR / f"{template_type}.md"
    if _report_template_violations(out, body, template_path, em_dash_hint=True):
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
    out = Output(dry_run=False)
    # モード判定
    if (prepare or (file is None and message is not None)) and template is None:
        out.error(f"specify a template with -t ({_COMMENT_TEMPLATE_CHOICES})")
        raise typer.Exit(1)
    if prepare:
        assert template is not None
        _issue_comment_prepare(out, template, issue)
    elif file is not None:
        _issue_comment_from_file(out, ctx, file)
    elif message is not None:
        if not issue:
            out.error("--issue (Issue reference) is required with -m")
            raise typer.Exit(1)
        assert template is not None
        _issue_comment_direct(out, ctx, issue, message, template)
    else:
        # 引数不足
        out.error(
            "missing arguments\n"
            'direct posting: pecot issue comment -m "MESSAGE" -t <template> --issue owner/repo/123\n'
            "prepare a template: pecot issue comment --prepare -t <template>\n"
            "from a file: pecot issue comment <path>"
        )
        raise typer.Exit(1)


_COMMENT_TEMPLATE_CHOICES = " / ".join(get_args(CommentTemplate))


def _issue_comment_prepare(out: Output, template: CommentTemplate, issue_ref: str | None) -> None:
    """Copy a template to the work directory (internal function)"""
    # 1. テンプレートファイルのパス
    template_path = COMMENT_TEMPLATES_DIR / f"{template}.md"

    if not template_path.exists():
        out.error(f"template not found: {template_path}")
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
            out.data(str(output_path))
    except OutputPathReservationError as e:
        out.error(str(e))
        raise typer.Exit(1) from None


def _issue_comment_from_file(out: Output, ctx: typer.Context | None, file: Path) -> None:
    """Post a comment from a file (internal function)"""
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    # 2. ファイル読み込み・パース
    try:
        parsed = parse_comment_file(file)
    except FrontmatterError as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    fm = parsed.frontmatter

    # 3. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, fm.issue_ref)
    except typer.BadParameter as e:
        out.error(str(e))
        raise typer.Exit(2) from None
    target = f"{owner}/{repo}/{issue_number}"

    # 4. バリデーション: テンプレートからセクションを動的抽出してチェック
    if fm.template is None:
        out.error(f"specify template in the frontmatter ({_COMMENT_TEMPLATE_CHOICES})")
        raise typer.Exit(1)
    template_path = COMMENT_TEMPLATES_DIR / f"{fm.template}.md"
    if _report_template_violations(out, parsed.body, template_path):
        raise typer.Exit(COMMENT_VALIDATION_EXIT_CODE)

    # 5. comment_url は、issue_ref と同じ Issue のコメントに限る
    comment_id = 0
    if fm.comment_url:
        comment_id = _comment_id_for_issue(
            out, fm.comment_url, config.host, owner, repo, issue_number
        )

    # 6. クライアント初期化
    client = GitHubClient(host=config.host)

    # 7. リポジトリがプロジェクトに含まれているか確認（警告のみ）
    if not config.is_repo_in_project(owner, repo, client):
        out.warning(f"{owner}/{repo} is not in the project")

    # 8. comment_url があれば、そのコメントを書き換える
    if fm.comment_url:
        try:
            comment = client.update_issue_comment(owner, repo, comment_id, parsed.body)
        except GitHubAPIError as e:
            out.error(f"could not update the comment on Issue {target}: {e.message}")
            raise typer.Exit(1) from None
        out.done(Operation(Verb.UPDATE, f"comment on {target}"))
        out.data(comment.get("html_url", fm.comment_url))
        return

    # 9. コメント投稿
    try:
        comment = client.add_issue_comment(owner, repo, issue_number, parsed.body)
    except GitHubAPIError as e:
        out.error(f"could not create a comment on Issue {target}: {e.message}")
        raise typer.Exit(1) from None
    comment_url = comment.get("html_url", "")
    out.done(Operation(Verb.CREATE, f"comment on {target}"))
    out.data(comment_url)

    # 10. 次に同じファイルを渡したとき更新になるよう、URL を書き戻す
    if comment_url:
        try:
            content = file.read_text(encoding="utf-8")
            file.write_text(
                set_frontmatter_value(content, "comment_url", comment_url), encoding="utf-8"
            )
        except (OSError, FrontmatterError) as e:
            out.warning(f"could not write comment_url back to the file: {e}")


# PR へのコメントは GitHub が /pull/ の形で html_url を返すので、両方受ける
_COMMENT_URL_RE = re.compile(
    r"^https?://(?P<host>[^/]+)/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?:issues|pull)/(?P<number>\d+)#issuecomment-(?P<id>\d+)$"
)


def _comment_id_for_issue(
    out: Output, comment_url: str, host: str, owner: str, repo: str, issue_number: int
) -> int:
    """Get the comment id from comment_url. Stop if it points to an Issue other than issue_ref"""
    match = _COMMENT_URL_RE.match(comment_url.strip())
    if match is None:
        out.error(
            f"comment_url has the wrong form: {comment_url}\n"
            "expected: https://<host>/<owner>/<repo>/{issues|pull}/<number>#issuecomment-<id>"
        )
        raise typer.Exit(1)
    if match["host"].lower() != host.lower():
        out.error(
            f"the host of comment_url ({match['host']}) differs from the configured host ({host})"
        )
        raise typer.Exit(1)
    target = (match["owner"].lower(), match["repo"].lower(), int(match["number"]))
    if target != (owner.lower(), repo.lower(), issue_number):
        out.error(
            f"comment_url ({match['owner']}/{match['repo']}/{match['number']}) "
            f"points to a different Issue than issue_ref ({owner}/{repo}/{issue_number})"
        )
        raise typer.Exit(1)
    return int(match["id"])


def _issue_comment_direct(
    out: Output,
    ctx: typer.Context | None,
    issue_ref: str,
    message: str,
    template: CommentTemplate,
) -> None:
    """Post a comment directly (internal function).

    Args:
        out: Functions that print lines.
        ctx: Typer Context (used to resolve base_repo for ``--repo``).
        issue_ref: Issue reference (owner/repo/N, or the short form N).
        message: Comment body.
        template: Template type.
    """
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    # 2. issue_ref をパース
    try:
        owner, repo, issue_number = _parse_issue_ref_from_ctx(ctx, issue_ref)
    except typer.BadParameter as e:
        out.error(str(e))
        raise typer.Exit(2) from None
    target = f"{owner}/{repo}/{issue_number}"

    # 3. バリデーション: テンプレートからセクションを動的抽出してチェック
    template_path = COMMENT_TEMPLATES_DIR / f"{template}.md"
    if _report_template_violations(out, message, template_path):
        raise typer.Exit(COMMENT_VALIDATION_EXIT_CODE)

    # 4. クライアント初期化
    client = GitHubClient(host=config.host)

    # 6. コメント投稿
    try:
        comment = client.add_issue_comment(owner, repo, issue_number, message)
    except GitHubAPIError as e:
        out.error(f"could not create a comment on Issue {target}: {e.message}")
        raise typer.Exit(1) from None
    out.done(Operation(Verb.CREATE, f"comment on {target}"))
    out.data(comment.get("html_url", ""))


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
            lines.append(f"  - #{pr['number']} {pr['title']} ({pr['state']})")
        lines.append("")

    # サブIssue
    if issue.get("sub_issues"):
        lines.append("**Sub-issues:**")
        for sub in issue["sub_issues"]:
            lines.append(f"  - #{sub['number']} {sub['title']} ({sub['state']})")
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
            help="Issue reference (`owner/repo/N`, or the short form `N` in the repository of `--repo`, or else of the git remote of the current directory)"
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

    out = Output(dry_run=False)

    # 1. 設定取得
    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    # 2. issue_ref をパース
    try:
        base = _resolve_base_repo(ctx)
        ref = parse_issue_ref(issue_ref, base_repo=base, repo_flag=True)
    except RefParseError as e:
        out.error(str(e.message))
        raise typer.Exit(2) from None

    # 3. クライアント初期化・Issue取得
    owner, repo, issue_number = ref.repo.owner, ref.repo.repo, ref.number
    try:
        client = GitHubClient(host=config.host)
        issue = client.get_issue_slim(owner, repo, issue_number, comment_limit=comment_limit)
        issue["owner"] = owner
        issue["repo"] = repo
    except GitHubAPIError as e:
        out.error(f"could not read Issue {owner}/{repo}/{issue_number}: {e.message}")
        raise typer.Exit(1) from None

    # 4. 出力
    if json_output:
        out.data(json.dumps(issue, ensure_ascii=False, indent=2))
    else:
        out.data(_format_issue_markdown(issue))
