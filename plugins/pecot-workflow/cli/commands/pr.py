"""cli/pr.py - PR command implementation

Provides the PR create and read commands.
Works with the GitHub MCP disabled, and guards PR creation with a PR permission flag.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, NoReturn

import typer

from cli.commands.options import DirectoryOption
from cli.core.config import ProjectConfig, load_active_config
from cli.core.frontmatter import (
    FrontmatterError,
    parse_pr_file,
)
from cli.core.git import git_current_branch, git_remote_url, git_toplevel, origin_repo, run_git
from cli.core.git_url import parse_remote_url
from cli.core.github import GitHubAPIError, GitHubClient, GitHubNotFoundError
from cli.core.github.errors import describe_api_error
from cli.core.issue_kind import is_epic_issue
from cli.core.nx_scope import changed_files, expected_scope, nx_projects, parse_title_scope
from cli.core.paths import OutputPathReservationError, get_output_dir, reserved_output_path
from cli.core.ref_parser import RefParseError, parse_pr_ref
from cli.core.repo_resolver import AmbiguousRepoError, RepoRef, resolve_repo
from cli.core.sections import (
    extract_sections_from_template,
    has_summary_image,
    validate_body_style,
    validate_heading_summaries,
    validate_sections,
)
from cli.core.state import (
    FLAG_MERGE_SLASH_PENDING,
    FLAG_PECOT_ACTIVE,
    FLAG_PR_CREATE_SLASH_PENDING,
    consume_flag,
    read_flag,
)

# 定数

# テンプレートディレクトリ
TEMPLATES_DIR = Path(__file__).parent.parent / "templates" / "pr"

# Issue参照パターン（#XXX形式、URL内フラグメント除外）
ISSUE_REF_PATTERN = re.compile(r"(^|[^/])#[0-9]+|[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+#[0-9]+")

# Closing Issue抽出パターン（Closes/Fixes/Resolves #XXX 形式）。
# GitHubが認識するキーワードは close・fix・resolve と、それぞれの -s / -es / -d 付きの形。
CLOSING_KEYWORDS_PATTERN = re.compile(
    r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+)?#(\d+)",
    re.IGNORECASE,
)


# ユーティリティ関数


def _resolve_base_repo(ctx: typer.Context | None) -> RepoRef | None:
    """Resolve base_repo from the CLI Context: ``--repo`` or the current git repository.

    ``AmbiguousRepoError`` is swallowed and ``None`` is returned, so that users of the
    primary ``owner/repo/N`` form still work outside a git repository (FR-001/FR-003).
    """
    if ctx is None or ctx.obj is None:
        return None
    try:
        return resolve_repo(ctx.obj.get("repo"), cwd=Path.cwd()).repo
    except AmbiguousRepoError:
        return None


def extract_issue_number_from_branch(branch: str) -> int | None:
    """Extract the Issue number from the end of a branch name

    Branches created by pecot create-branch end with /issue-number.
    This extracts the Issue number from a branch in that form.

    Args:
        branch: Branch name

    Returns:
        Issue number (None if the name does not end with a number)

    Examples:
        >>> extract_issue_number_from_branch("feat/description/470")
        470

        >>> extract_issue_number_from_branch("fix/bug-fix/123")
        123

        >>> extract_issue_number_from_branch("main")
        None

        >>> extract_issue_number_from_branch("feat/no-issue-number")
        None
    """
    parts = branch.split("/")
    if parts and parts[-1].isdigit():
        return int(parts[-1])
    return None


def _update_issue_status_to_in_review(
    config: ProjectConfig,
    client: GitHubClient,
    owner: str,
    repo: str,
    head_branch: str,
) -> None:
    """After a PR is created, set the related Issue's status to In Review

    Extracts the Issue number from the branch name and sets the board status to In Review.
    Every error is printed as a warning and does not affect the PR creation result.

    Args:
        config: Project config
        client: GitHub client
        owner: Repository owner
        repo: Repository name
        head_branch: Head branch name
    """
    # 1. ブランチ名からIssue番号を抽出
    issue_number = extract_issue_number_from_branch(head_branch)
    if issue_number is None:
        return

    # 2. ボード上のアイテムIDを取得
    try:
        item_id = client.get_item_id_by_issue(
            project_id=config.project.id,
            owner=owner,
            repo=repo,
            issue_number=issue_number,
        )
    except Exception as e:
        typer.echo(f"  ⚠ Issue #{issue_number} のボードアイテム取得に失敗: {e}", err=True)
        return

    if item_id is None:
        typer.echo(
            f"  ⚠ Issue #{issue_number} はボードに登録されていません（ステータス更新スキップ）",
            err=True,
        )
        return

    # 3. In ReviewオプションIDを取得
    option_id = config.get_option_id("workflow", "in_review")
    if option_id is None:
        typer.echo(
            "  ⚠ ワークフローにin_reviewステータスが設定されていません（ステータス更新スキップ）",
            err=True,
        )
        return

    # 4. ステータスを更新
    field_id = config.get_field_id("workflow")
    if field_id is None:
        typer.echo(
            "  ⚠ ワークフローフィールドが見つかりません（ステータス更新スキップ）",
            err=True,
        )
        return

    try:
        client.update_project_item_field(
            project_id=config.project.id,
            item_id=item_id,
            field_id=field_id,
            option_id=option_id,
        )
        typer.echo(f"  Issue #{issue_number} のステータスを In Review に更新しました")
    except Exception as e:
        typer.echo(f"  ⚠ Issue #{issue_number} のステータス更新に失敗: {e}", err=True)


def _extract_closing_issue_numbers(body: str) -> list[int]:
    """Extract closing Issue numbers from the PR body

    Extracts the Issue numbers that follow a keyword GitHub recognizes (Closes/Fixes/Resolves).
    The owner/repo#XXX form is also supported.

    Args:
        body: PR body

    Returns:
        List of Issue numbers (no duplicates)

    Examples:
        >>> _extract_closing_issue_numbers("Closes #123, Fixes #456")
        [123, 456]

        >>> _extract_closing_issue_numbers("Closes owner/repo#789")
        [789]
    """
    matches = CLOSING_KEYWORDS_PATTERN.findall(body)
    # 重複を除去しつつ順序を保持
    seen: set[int] = set()
    result: list[int] = []
    for issue_number_str in matches:
        issue_number = int(issue_number_str)
        if issue_number not in seen:
            seen.add(issue_number)
            result.append(issue_number)
    return result


def _append_issue_close_if_needed(body: str, issue_number: int) -> str:
    """Append a Closes reference at the end if the body has no Issue reference

    If the PR body does not already contain the Issue number extracted from the branch name,
    appends it at the end in the `Closes #XXX` form.

    Args:
        body: PR body
        issue_number: Issue number

    Returns:
        Body with the Issue reference added (or the original body)

    Examples:
        >>> _append_issue_close_if_needed("Changes", 123)
        'Changes\\n\\nCloses #123'

        >>> _append_issue_close_if_needed("Closes #123", 123)
        'Closes #123'
    """
    # 既に該当Issue番号の参照があるかチェック
    # URL内フラグメントを除くため (^|[^/]) でマッチする。
    # 直後に数字が続くものを除くため、否定の先読みを使う。
    pattern = rf"(^|[^/])#{issue_number}(?!\d)"
    if re.search(pattern, body):
        return body

    # 末尾に追加
    return body.rstrip() + f"\n\nCloses #{issue_number}"


# バリデーション


def _validate_issue_reference(body: str) -> bool:
    """Check that the body contains an Issue reference"""
    return bool(ISSUE_REF_PATTERN.search(body))


def _is_release_pr(
    template: str,
    base: str,
    head: str | None,
    develop_branch: str | None,
    release_branch: str | None,
) -> bool:
    """Whether this is a release PR (release template, or a PR from develop to release)"""
    return template == "release" or bool(
        release_branch and base == release_branch and head == develop_branch
    )


SCREENSHOT_MISSING_ERROR = (
    "Summary has no image and `screenshot` gives no reason to omit one. "
    "If the change alters a screen, Markdown the tool writes for GitHub, or CLI output text, "
    "take a screenshot and add it to Summary as `![alt](./<file>.png)`. "
    "Otherwise, write the reason in the `screenshot` frontmatter field (`--screenshot` with `-m`)"
)


def _exit_on_unset_branch(
    template: str,
    base: str,
    head: str | None,
    develop_branch: str | None,
    release_branch: str | None,
) -> None:
    """Exit 1 before validation if a branch setting needed to check base is missing"""
    is_release = _is_release_pr(template, base, head, develop_branch, release_branch)
    if is_release and not release_branch:
        typer.echo(
            "release_branchが設定されていません。\n"
            "    → `pecot project set-repo owner/repo "
            "--release-branch main` で設定してください。",
            err=True,
        )
        raise typer.Exit(1)
    if not is_release and not develop_branch:
        typer.echo(
            "develop_branchが設定されていません。\n"
            "    → `pecot project set-repo owner/repo "
            "--develop-branch develop` で設定してください。",
            err=True,
        )
        raise typer.Exit(1)


def _validate_pr_content(
    body: str,
    title: str,
    base: str,
    develop_branch: str | None,
    skip_issue_ref_check: bool = False,
    *,
    release_branch: str | None = None,
    head: str | None = None,
    template: str = "default",
    screenshot: str | None = None,
) -> list[str]:
    """Validate the PR content

    Args:
        body: PR body.
        title: PR title.
        base: Base branch.
        develop_branch: Development branch (from config).
        skip_issue_ref_check: Whether to skip the Issue reference check.
        release_branch: Release branch (from config).
        head: Head branch.
        template: Template kind ("default" or "release").
        screenshot: Reason the Summary has no image (normalized, None if absent).

    Returns:
        List of error messages (empty if there are no errors)

    Note:
        The caller must stop first if a branch (develop_branch / release_branch) is unset.
    """
    errors: list[str] = []

    is_release = _is_release_pr(template, base, head, develop_branch, release_branch)

    # Issue参照チェック（リリースPR・skip_issue_ref_check=Trueならスキップ）
    if not is_release and not skip_issue_ref_check and not _validate_issue_reference(body):
        errors.append(
            "PR 本文に Issue 参照 `#N` がありません（Issue 起点でない PR は `--no-issue-ref`）"
        )

    # 必須セクションチェック（テンプレートから動的に抽出）
    if template == "release":
        template_path = TEMPLATES_DIR / "release.md"
    else:
        template_path = TEMPLATES_DIR / "create.md"
    required_sections = extract_sections_from_template(template_path)
    if required_sections:
        missing_sections = validate_sections(body, required_sections)
        if missing_sections:
            errors.append(f"不足セクション: {', '.join(missing_sections)}")
        summary_errors = validate_heading_summaries(body, required_sections)
        if summary_errors:
            errors.append(f"見出しサマリの規則違反: {', '.join(summary_errors)}")

    # 記法チェック（テンプレート抽出の成否に依らず掛ける）
    style_errors = validate_body_style(body)
    if style_errors:
        errors.append(f"使用できない記法: {', '.join(style_errors)}")

    # 画像チェック（リリースPRは対象外）
    if not is_release and not screenshot and not has_summary_image(body):
        errors.append(SCREENSHOT_MISSING_ERROR)

    # baseブランチチェック（開発ブランチ運用。ブランチ未設定は呼び出し側で先に止める）
    if is_release:
        if release_branch and base != release_branch:
            errors.append(
                f"★ 警告 ★ リリースPRのbaseブランチが不正です。\n"
                f"    正しいbase: {release_branch}\n"
                f"    指定されたbase: {base}\n"
                f"    → baseブランチを '{release_branch}' に変更してください。"
            )
    else:
        if develop_branch and base != develop_branch:
            errors.append(
                f"★ 警告 ★ baseブランチが不正です。\n"
                f"    正しいbase: {develop_branch}\n"
                f"    指定されたbase: {base}\n"
                f"    → baseブランチを '{develop_branch}' に変更してください。"
            )

    return errors


def _nx_scope_toplevel(
    config: ProjectConfig,
    owner: str,
    repo: str,
    base: str,
    directory: Path,
) -> Path | None:
    """Return the worktree root if the title scope is to be compared with nx projects

    Returns it only when all of the following hold (otherwise returns None, with no comparison or warning).

    - The target's ``effective_release_type`` is ``nx``
    - base equals develop_branch (not a release PR)
    - ``origin`` matches the target, and the worktree root has ``nx.json``
    """
    repository = config.find_repository(owner, repo)
    if repository is None or repository.effective_release_type != "nx":
        return None
    if base != config.get_develop_branch(owner, repo):
        return None
    origin = origin_repo(directory)
    if origin is None or (origin[1].lower(), origin[2].lower()) != (owner.lower(), repo.lower()):
        return None
    toplevel = git_toplevel(directory)
    if toplevel is None or not (toplevel / "nx.json").is_file():
        return None
    return toplevel


def _expected_title_scope(toplevel: Path, base: str, head: str) -> list[str] | None:
    """Return the scope expected from the changed nx projects

    If it cannot be determined, warns and returns None (the comparison is skipped).
    Returns an empty list (no comparison) if the diff is empty or only has a version plan.
    """
    projects = nx_projects(toplevel)
    files = changed_files(toplevel, f"origin/{base}", head) if projects else None
    if projects is None or files is None:
        typer.echo(
            "⚠ nx のプロジェクトまたは差分を取得できないため、"
            "PR タイトルの scope の比較を飛ばしました",
            err=True,
        )
        return None
    return expected_scope(files, projects)


def _title_scope_errors(
    config: ProjectConfig,
    owner: str,
    repo: str,
    title: str,
    base: str,
    head: str,
    directory: Path,
    *,
    template: str = "default",
) -> list[str]:
    """Return the error when the PR title scope does not match the changed nx projects' scope

    Applies only to regular PRs in repositories with ``release_type: nx``. The comparison condition is ``_nx_scope_toplevel``.
    """
    develop_branch = config.get_develop_branch(owner, repo)
    release_branch = config.get_release_branch(owner, repo)
    if _is_release_pr(template, base, head, develop_branch, release_branch):
        return []
    toplevel = _nx_scope_toplevel(config, owner, repo, base, directory)
    if toplevel is None:
        return []
    expected = _expected_title_scope(toplevel, base, head)
    if not expected:
        return []
    given = parse_title_scope(title)
    if given is not None and set(given) == set(expected):
        return []
    shown = ",".join(given) if given else "なし"
    return [
        f"PR タイトルの scope を `{','.join(expected)}` にしてください"
        f"（指定: `{shown}`。変更した nx プロジェクトの tag から算出）"
    ]


# PR作成コマンド


def pr_create(
    file: Annotated[
        Path | None,
        typer.Argument(help="Path to a Markdown file with front matter"),
    ] = None,
    message: Annotated[
        str | None,
        typer.Option("--message", "-m", help="PR body, given directly"),
    ] = None,
    title: Annotated[
        str | None,
        typer.Option("--title", "-t", help="PR title (required with -m)"),
    ] = None,
    base: Annotated[
        str | None,
        typer.Option("--base", "-b", help="Base branch (required with -m)"),
    ] = None,
    head: Annotated[
        str | None,
        typer.Option("--head", help="Head branch (default: the current branch)"),
    ] = None,
    draft: Annotated[
        bool,
        typer.Option("--draft", "-d", help="Create as a draft PR"),
    ] = False,
    prepare: Annotated[
        bool,
        typer.Option("--prepare", "-p", help="Copy the template to the work directory"),
    ] = False,
    dry_run: Annotated[
        bool,
        typer.Option(
            "--dry-run",
            "-n",
            help="Validate only (skip the early preflight check, do not create the PR)",
        ),
    ] = False,
    repository: Annotated[
        str | None,
        typer.Option("--repo", "-r", help="Repository in owner/repo form (with -m)"),
    ] = None,
    no_issue_ref: Annotated[
        bool,
        typer.Option(
            "--no-issue-ref",
            help="Skip the automatic related-Issue setup (extraction from the branch name, adding it to the body, and the validation check)",
        ),
    ] = False,
    template: Annotated[
        str,
        typer.Option("--template", help="PR template kind (default / release)"),
    ] = "default",
    screenshot: Annotated[
        str | None,
        typer.Option("--screenshot", help="Reason to omit an image from Summary (with -m)"),
    ] = None,
) -> None:
    """Create a PR (pull request)

    There are 3 modes:

    1. Prepare a template:
       $ pecot pr create --prepare

    2. Create a PR from a file:
       $ pecot pr create ./tmp/pecot/pr-create-xxx.md

    3. Create a PR with direct arguments:
       $ pecot pr create -m "body" -t "title" -b <base-branch>
       (e.g. develop-aist, develop, main)
    """
    directory = Path.cwd()

    # template バリデーション
    _validate_template_option(template)

    # モード判定
    if prepare:
        _pr_create_prepare(directory, template=template)
    elif file is not None:
        _exit_on_screenshot_option(screenshot)
        _pr_create_from_file(file, dry_run, no_issue_ref, directory, template=template)
    elif message is not None:
        title, base = _require_title_and_base(title, base)
        _pr_create_direct(
            message=message,
            title=title,
            base=base,
            head=head,
            draft=draft,
            dry_run=dry_run,
            repository=repository,
            no_issue_ref=no_issue_ref,
            directory=directory,
            template=template,
            screenshot=(screenshot or "").strip() or None,
        )
    else:
        _exit_with_pr_create_usage()


def _exit_on_screenshot_option(screenshot: str | None) -> None:
    """If --screenshot is passed in file mode, say to put it in the front matter and exit 1"""
    if screenshot is not None:
        typer.echo(
            "--screenshot is for -m; write the reason in the `screenshot` "
            "frontmatter field instead",
            err=True,
        )
        raise typer.Exit(1)


def _require_title_and_base(title: str | None, base: str | None) -> tuple[str, str]:
    """Exit 1 if -t or -b is missing with -m, otherwise return (title, base)"""
    if not title or not base:
        typer.echo(
            "エラー: -m オプション使用時は -t (タイトル) と -b (baseブランチ) が必須です",
            err=True,
        )
        raise typer.Exit(1)
    return title, base


def _validate_template_option(template: str) -> None:
    """Exit 1 if --template is anything other than default / release"""
    if template not in ("default", "release"):
        typer.echo(
            "エラー: --template は 'default' または 'release' を指定してください"
            f"（指定値: {template}）",
            err=True,
        )
        raise typer.Exit(1)


def _exit_with_pr_create_usage() -> NoReturn:
    """Print usage to stderr for missing arguments and exit 1"""
    typer.echo("エラー: 引数が不足しています", err=True)
    typer.echo("", err=True)
    typer.echo("使用方法:", err=True)
    typer.echo("  テンプレート準備: pecot pr create --prepare", err=True)
    typer.echo("  ファイルから: pecot pr create <path>", err=True)
    typer.echo('  直接指定: pecot pr create -m "本文" -t "タイトル" -b <base-branch>', err=True)
    raise typer.Exit(1)


def _echo_expected_scope(
    config: ProjectConfig, owner: str, repo: str, base: str, directory: Path
) -> None:
    """When the comparison condition holds, show the scope computed from the changed nx projects"""
    toplevel = _nx_scope_toplevel(config, owner, repo, base, directory)
    if toplevel is None:
        return
    head = git_current_branch(directory)
    expected = _expected_title_scope(toplevel, base, head) if head else None
    if expected:
        typer.echo(
            f"scope: {','.join(expected)}（変更した nx プロジェクトの tag から算出）", err=True
        )


def _pr_create_prepare(directory: Path, *, template: str = "default") -> None:
    """Copy the template to the work directory

    Gets develop_branch from the project config and sets it as the template's base.
    This prevents creating a PR to main by mistake.

    Args:
        directory: Target directory
        template: Template kind ("default" or "release")
    """
    if template == "release":
        template_path = TEMPLATES_DIR / "release.md"
    else:
        template_path = TEMPLATES_DIR / "create.md"

    if not template_path.exists():
        typer.echo(f"テンプレートが見つかりません: {template_path}", err=True)
        raise typer.Exit(1)

    # テンプレートを読み込み
    content = template_path.read_text(encoding="utf-8")

    # releaseテンプレートの場合、baseは自動設定スキップ（テンプレートのデフォルト "main" を維持）
    if template != "release":
        # リポジトリのdevelop_branchを取得してbaseを自動設定
        repo_info = origin_repo(directory)
        if repo_info:
            _host, owner, repo = repo_info
            config = load_active_config()
            if config:
                develop_branch = config.get_develop_branch(owner, repo)
                if develop_branch:
                    # テンプレートのbaseを置換
                    content = re.sub(
                        r'^base:\s*"[^"]*"',
                        f'base: "{develop_branch}"',
                        content,
                        count=1,
                        flags=re.MULTILINE,
                    )
                    typer.echo(f"baseブランチを自動設定: {develop_branch}", err=True)
                    _echo_expected_scope(config, owner, repo, develop_branch, directory)

        # Closes #N 自動埋め込み (#358)
        content = _fill_closes_in_template(content, directory, repo_info)

    # 出力パス予約（同名があれば ts を 1 秒進めて再試行）。
    # 書き込み前に失敗した場合は予約を撤去する。
    prefix = "pr-release" if template == "release" else "pr-create"
    try:
        with reserved_output_path(get_output_dir(), lambda ts: f"{prefix}-{ts}.md") as output_path:
            output_path.write_text(content, encoding="utf-8")
            typer.echo(str(output_path))
    except OutputPathReservationError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None


def _fill_closes_in_template(
    content: str,
    directory: Path,
    repo_info: tuple[str, str, str] | None,
) -> str:
    """Fill the empty `Closes #` at the end of the template with the active task number.

    Priority:
    1. `owner/repo/N` from `.pecot-active`
    2. The trailing branch number, with owner/repo derived from the remote

    If the Issue is judged to be an Epic, it is not filled and a warning is shown. If the judging API fails, it fails open (not filled, with a warning).
    """
    target_owner: str | None = None
    target_repo: str | None = None
    target_number: int | None = None

    active = read_flag(FLAG_PECOT_ACTIVE)
    if active and active.count("/") == 2:
        ao, ar, an = active.split("/")
        if an.isdigit():
            target_owner, target_repo, target_number = ao, ar, int(an)

    if target_number is None and repo_info is not None:
        branch = git_current_branch(directory)
        if branch:
            n = extract_issue_number_from_branch(branch)
            if n:
                _host, owner, repo = repo_info
                target_owner, target_repo, target_number = owner, repo, n

    if target_number is None or not target_owner or not target_repo:
        return content

    config = load_active_config()
    try:
        client = GitHubClient(host=config.host) if config else GitHubClient()
        kind = client.get_issue_kind(target_owner, target_repo, target_number)
    except (GitHubAPIError, GitHubNotFoundError) as e:
        msg = getattr(e, "message", str(e))
        typer.echo(
            f"⚠ Issue #{target_number} の種別判定に失敗: {msg}（Closes は手動で埋めてください）",
            err=True,
        )
        return content

    if is_epic_issue(kind):
        typer.echo(
            f"⚠ Issue #{target_number} は Epic と判定されたため Closes 自動埋め込みをスキップしました",
            err=True,
        )
        return content

    new_content, n_subs = re.subn(
        r"^Closes #\s*$",
        f"Closes #{target_number}",
        content,
        count=1,
        flags=re.MULTILINE,
    )
    if n_subs > 0:
        typer.echo(f"Closes 自動埋め込み: #{target_number}", err=True)
    return new_content


def _resolve_head_branch(head: str | None, directory: Path) -> str:
    """Decide the head branch (the current branch if unspecified, exit 1 if it cannot be determined)"""
    if head:
        return head
    head_branch = git_current_branch(directory)
    if not head_branch:
        typer.echo("エラー: headブランチを特定できません", err=True)
        raise typer.Exit(1)
    return head_branch


def _append_close_unless_epic(
    config: ProjectConfig, owner: str, repo: str, body: str, issue_number: int
) -> str:
    """Add Closes to the body unless the Issue at the end of the branch is an Epic (added if the judgment fails)"""
    try:
        _kind_client = GitHubClient(host=config.host)
        kind = _kind_client.get_issue_kind(owner, repo, issue_number)
        if is_epic_issue(kind):
            typer.echo(
                f"⚠ ブランチ末尾の #{issue_number} は Epic と判定されたため Closes 自動付与をスキップ",
                err=True,
            )
        else:
            body = _append_issue_close_if_needed(body, issue_number)
    except (GitHubAPIError, GitHubNotFoundError):
        body = _append_issue_close_if_needed(body, issue_number)
    return body


# 本文の検証の失敗。1（通信・設定・引数）と 2（preflight）と区別する
PR_VALIDATION_EXIT_CODE = 3


def _exit_on_validation_errors(errors: list[str]) -> None:
    """If there are validation errors, list them on stderr and exit 3"""
    if errors:
        typer.echo("バリデーションエラー:", err=True)
        for error in errors:
            typer.echo(f"  - {error}", err=True)
        raise typer.Exit(PR_VALIDATION_EXIT_CODE)


@dataclass(frozen=True)
class _PrDraft:
    """Content passed to the PR create API"""

    owner: str
    repo: str
    title: str
    body: str
    head: str
    base: str
    draft: bool
    is_release: bool


def _echo_dry_run_summary(pr: _PrDraft) -> None:
    """Show the validation success for dry-run"""
    typer.echo("バリデーション成功（dry-run）")
    typer.echo(f"  タイトル: {pr.title}")
    typer.echo(f"  リポジトリ: {pr.owner}/{pr.repo}")
    typer.echo(f"  base: {pr.base}")
    typer.echo(f"  head: {pr.head}")
    typer.echo(f"  draft: {pr.draft}")
    if pr.is_release:
        typer.echo("  template: release")


def _submit_pull_request(config: ProjectConfig, directory: Path, pr_draft: _PrDraft) -> None:
    """Early preflight check -> create the PR -> update to In Review -> print the result"""
    # 7. preflight 早期チェック（警告あれば API コール前に exit 2）
    _run_preflight_checks_or_exit(directory)

    # 8. クライアント初期化
    client = GitHubClient(host=config.host)

    # 9. PR作成
    typer.echo("Creating pull request...")
    try:
        pr = client.create_pull_request(
            owner=pr_draft.owner,
            repo=pr_draft.repo,
            title=pr_draft.title,
            body=pr_draft.body,
            head=pr_draft.head,
            base=pr_draft.base,
            draft=pr_draft.draft,
        )
    except GitHubAPIError as e:
        typer.echo(f"エラー: PR作成失敗: {e.message}", err=True)
        raise typer.Exit(1) from None

    # 10. Issue ステータスを In Review に更新（リリースPRではスキップ）
    if not pr_draft.is_release:
        _update_issue_status_to_in_review(
            config, client, pr_draft.owner, pr_draft.repo, pr_draft.head
        )

    # 11. 結果出力
    pr_number = pr["number"]
    pr_url = pr["html_url"]
    typer.echo(f"  Created: #{pr_number}")
    consume_flag(FLAG_PR_CREATE_SLASH_PENDING)
    typer.echo(f"\n{pr_url}")


def _pr_create_from_file(
    file: Path,
    dry_run: bool,
    no_issue_ref: bool,
    directory: Path,
    *,
    template: str = "default",
) -> None:
    """Create a PR from a file

    Args:
        file: Path to a Markdown file with front matter.
        dry_run: Whether to validate only.
        no_issue_ref: Whether to skip the automatic Issue reference setup.
        directory: Target directory.
        template: Template kind ("default" or "release").
    """
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. ファイル読み込み・パース
    try:
        parsed = parse_pr_file(file)
    except FrontmatterError as e:
        typer.echo(f"エラー: {e}", err=True)
        raise typer.Exit(1) from None

    fm = parsed.frontmatter
    if not fm.repository or "/" not in fm.repository:
        typer.echo("エラー: repositoryを指定してください（例: owner/repo）", err=True)
        raise typer.Exit(1)
    owner, repo = fm.repository.split("/")

    # 3. headブランチ決定（未指定時は現在のブランチ）
    head_branch = _resolve_head_branch(fm.head, directory)

    # リリースPR判定
    is_release = template == "release"

    # 4. Issue参照自動追加（リリースPRではスキップ）
    body = parsed.body
    issue_number: int | None = None
    if not is_release and not no_issue_ref:
        issue_number = extract_issue_number_from_branch(head_branch)
        if issue_number:
            body = _append_close_unless_epic(config, owner, repo, body, issue_number)

    # 5. 開発ブランチ・リリースブランチを取得（バリデーション用）
    develop_branch = config.get_develop_branch(owner, repo)
    release_branch = config.get_release_branch(owner, repo)

    # 6. バリデーション
    # 免除は `--no-issue-ref` と release テンプレだけ（release は _validate_pr_content が判定）
    _exit_on_unset_branch(template, fm.base, head_branch, develop_branch, release_branch)
    errors = _validate_pr_content(
        body,
        fm.title,
        fm.base,
        develop_branch,
        skip_issue_ref_check=no_issue_ref,
        release_branch=release_branch,
        head=head_branch,
        template=template,
        screenshot=fm.screenshot,
    )
    errors += _title_scope_errors(
        config, owner, repo, fm.title, fm.base, head_branch, directory, template=template
    )
    _exit_on_validation_errors(errors)

    pr_draft = _PrDraft(
        owner=owner,
        repo=repo,
        title=fm.title,
        body=body,
        head=head_branch,
        base=fm.base,
        draft=fm.draft,
        is_release=is_release,
    )
    if dry_run:
        _echo_dry_run_summary(pr_draft)
        return

    # 7〜11. preflight → PR作成 → ステータス更新 → 結果出力
    _submit_pull_request(config, directory, pr_draft)


def _resolve_direct_repository(config: ProjectConfig, repository: str | None) -> tuple[str, str]:
    """2. Decide the repository (-r if given, otherwise the single repository in the config)"""
    if repository:
        parts = repository.split("/")
        if len(parts) != 2:
            typer.echo(f"不正なリポジトリ形式: {repository}\n期待: owner/repo", err=True)
            raise typer.Exit(1)
        return parts[0], parts[1]
    # 設定から取得を試みる
    if config.repositories and len(config.repositories) == 1:
        return config.repositories[0].owner, config.repositories[0].name
    typer.echo("エラー: リポジトリを指定してください（-r owner/repo）", err=True)
    raise typer.Exit(1)


def _pr_create_direct(
    message: str,
    title: str,
    base: str,
    head: str | None,
    draft: bool,
    dry_run: bool,
    repository: str | None,
    no_issue_ref: bool,
    directory: Path,
    *,
    template: str = "default",
    screenshot: str | None = None,
) -> None:
    """Create a PR with direct arguments

    Args:
        message: PR body.
        title: PR title.
        base: Base branch.
        head: Head branch (default: the current branch).
        draft: Whether to create as a draft PR.
        dry_run: Whether to validate only.
        repository: Repository in owner/repo form.
        no_issue_ref: Whether to skip the automatic Issue reference setup.
        directory: Target directory.
        template: Template kind ("default" or "release").
        screenshot: Reason the Summary has no image (normalized).
    """
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. リポジトリ決定
    owner, repo = _resolve_direct_repository(config, repository)

    # 3. headブランチ決定
    head_branch = _resolve_head_branch(head, directory)

    # リリースPR判定
    is_release = template == "release"

    # 4. Issue参照自動追加（リリースPRではスキップ）
    body = message
    if not is_release and not no_issue_ref:
        issue_number = extract_issue_number_from_branch(head_branch)
        if issue_number:
            body = _append_issue_close_if_needed(body, issue_number)

    # 5. 開発ブランチ・リリースブランチを取得（バリデーション用）
    develop_branch = config.get_develop_branch(owner, repo)
    release_branch = config.get_release_branch(owner, repo)

    # 6. バリデーション
    _exit_on_unset_branch(template, base, head_branch, develop_branch, release_branch)
    errors = _validate_pr_content(
        body,
        title,
        base,
        develop_branch,
        skip_issue_ref_check=no_issue_ref,
        release_branch=release_branch,
        head=head_branch,
        template=template,
        screenshot=screenshot,
    )
    errors += _title_scope_errors(
        config, owner, repo, title, base, head_branch, directory, template=template
    )
    _exit_on_validation_errors(errors)

    pr_draft = _PrDraft(
        owner=owner,
        repo=repo,
        title=title,
        body=body,
        head=head_branch,
        base=base,
        draft=draft,
        is_release=is_release,
    )
    if dry_run:
        _echo_dry_run_summary(pr_draft)
        return

    # 7〜11. preflight → PR作成 → ステータス更新 → 結果出力
    _submit_pull_request(config, directory, pr_draft)


# PR読み取りコマンド


def _format_pr_markdown(pr: dict[str, Any]) -> str:
    """Format PR info as Markdown"""
    lines: list[str] = []

    # ヘッダー
    lines.append(f"## PR #{pr['number']} {pr['title']}")
    lines.append("")

    # メタ情報
    meta_parts = [f"**State:** {pr['state']}"]
    if pr.get("is_draft"):
        meta_parts.append("**Draft**")
    if pr.get("mergeable"):
        meta_parts.append(f"**Mergeable:** {pr['mergeable']}")
    if pr.get("comments", 0) > 0:
        meta_parts.append(f"**Comments:** {pr['comments']}")
    lines.append(" | ".join(meta_parts))
    lines.append("")

    # ブランチ情報
    lines.append(f"**Branch:** `{pr['head_ref']}` → `{pr['base_ref']}`")
    lines.append("")

    # 関連Issue
    if pr.get("closing_issues"):
        lines.append("**Closing Issues:**")
        for issue in pr["closing_issues"]:
            lines.append(f"  - #{issue['number']} {issue['title']}")
        lines.append("")

    # 参照Issue（Refs #XXX）
    if pr.get("referenced_issues"):
        lines.append("**Referenced Issues:**")
        for issue in pr["referenced_issues"]:
            title_suffix = f" {issue['title']}" if issue.get("title") else ""
            lines.append(f"  - #{issue['number']}{title_suffix}")
        lines.append("")

    # レビュー状態
    if pr.get("reviews"):
        lines.append("**Reviews:**")
        for review in pr["reviews"]:
            lines.append(f"  - {review['author']}: {review['state']}")
        lines.append("")

    # 本文
    lines.append("---")
    lines.append("")
    lines.append(pr["body"])

    return "\n".join(lines)


def _format_reviews_markdown(reviews: list[dict[str, Any]]) -> str:
    """Format review info as Markdown

    Args:
        reviews: List of reviews (state, author, body, submitted_at)

    Returns:
        Review info in Markdown
    """
    if not reviews:
        return ""

    lines: list[str] = []
    lines.append("## Reviews")
    lines.append("")

    for review in reviews:
        author = review.get("author") or "(unknown)"
        state = review.get("state", "COMMENTED")
        submitted_at = review.get("submitted_at", "")
        body = review.get("body", "")

        # 日付フォーマット（ISO8601からYYYY-MM-DD形式に変換）
        date_str = ""
        if submitted_at and len(submitted_at) >= 10:
            date_str = f" - {submitted_at[:10]}"

        lines.append(f"### @{author} ({state}){date_str}")
        if body.strip():
            lines.append("")
            lines.append(body.strip())
        lines.append("")

    return "\n".join(lines)


def _format_review_threads_markdown(threads: list[dict[str, Any]]) -> str:
    """Format line comments (reviewThreads) as Markdown

    Args:
        threads: List of line comments (is_resolved, path, line, comments)

    Returns:
        Line comment info in Markdown
    """
    if not threads:
        return ""

    lines: list[str] = []
    lines.append("## Line Comments")
    lines.append("")

    for thread in threads:
        path = thread.get("path") or "(unknown file)"
        line = thread.get("line")
        is_resolved = thread.get("is_resolved", False)
        status = "Resolved" if is_resolved else "Open"

        # ヘッダー
        line_info = f":{line}" if line else ""
        lines.append(f"### `{path}{line_info}` [{status}]")
        lines.append("")

        # コメント
        for comment in thread.get("comments", []):
            author = comment.get("author") or "(unknown)"
            body = comment.get("body", "")
            created_at = comment.get("created_at", "")

            date_str = ""
            if created_at and len(created_at) >= 10:
                date_str = f" ({created_at[:10]})"

            lines.append(f"**@{author}**{date_str}:")
            if body.strip():
                # コメント本文を引用形式で表示
                for body_line in body.strip().split("\n"):
                    lines.append(f"> {body_line}")
            lines.append("")

    return "\n".join(lines)


def _format_pr_with_reviews_markdown(pr: dict[str, Any], owner: str, repo: str) -> str:
    """Format PR info with review details as Markdown

    The extended format for the --reviews option.

    Args:
        pr: PR info dict
        owner: Repository owner
        repo: Repository name

    Returns:
        PR info in Markdown (with review details)
    """
    lines: list[str] = []

    # ヘッダー
    lines.append(f"## PR #{pr['number']} {pr['title']}")
    lines.append("")

    # メタ情報
    meta_parts = [f"**State:** {pr['state']}"]
    if pr.get("is_draft"):
        meta_parts.append("**Draft**")
    if pr.get("mergeable"):
        meta_parts.append(f"**Mergeable:** {pr['mergeable']}")
    if pr.get("comments", 0) > 0:
        meta_parts.append(f"**Comments:** {pr['comments']}")
    lines.append(" | ".join(meta_parts))
    lines.append("")

    # ブランチ情報
    lines.append(f"**Branch:** `{pr['head_ref']}` → `{pr['base_ref']}`")
    lines.append("")

    # 関連Issue（詳細確認コマンド付き）
    if pr.get("closing_issues"):
        lines.append("**Closing Issues:**")
        for issue in pr["closing_issues"]:
            lines.append(f"  - #{issue['number']} {issue['title']}")
            lines.append(f"    → 詳細: pecot issue read {owner}/{repo}/{issue['number']}")
        lines.append("")

    # 参照Issue（Refs #XXX、詳細確認コマンド付き）
    if pr.get("referenced_issues"):
        lines.append("**Referenced Issues:**")
        for issue in pr["referenced_issues"]:
            title_suffix = f" {issue['title']}" if issue.get("title") else ""
            lines.append(f"  - #{issue['number']}{title_suffix}")
            lines.append(f"    → 詳細: pecot issue read {owner}/{repo}/{issue['number']}")
        lines.append("")

    # 本文
    lines.append("---")
    lines.append("")
    lines.append(pr.get("body") or "")
    lines.append("")

    # レビュー詳細
    reviews_md = _format_reviews_markdown(pr.get("reviews", []))
    if reviews_md:
        lines.append("---")
        lines.append("")
        lines.append(reviews_md)

    # 行コメント
    threads_md = _format_review_threads_markdown(pr.get("review_threads", []))
    if threads_md:
        lines.append("---")
        lines.append("")
        lines.append(threads_md)

    return "\n".join(lines)


def pr_read(
    ctx: typer.Context,
    pr_ref: Annotated[
        str,
        typer.Argument(help="PR reference (owner/repo/N, or the short form N only with `--repo`)"),
    ],
    json_output: Annotated[
        bool,
        typer.Option(
            "--json",
            "-j",
            help="Output as JSON",
        ),
    ] = False,
    reviews: Annotated[
        bool,
        typer.Option(
            "--reviews",
            "-r",
            help="Include review details (bodies and line comments)",
        ),
    ] = False,
) -> None:
    """Get PR details efficiently (GraphQL, only the needed fields)

    Compared with the REST API or MCP, this has these advantages:
    - Leaves out unneeded fields, which reduces token use
    - Gets the related Issues and review state in 1 query

    With the --reviews option, it also gets the review bodies and line comments.
    """
    # 1. 設定取得
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    # 2. pr_ref をパース
    try:
        base = _resolve_base_repo(ctx)
        ref = parse_pr_ref(pr_ref, base_repo=base)
    except RefParseError as e:
        typer.echo(e.message, err=True)
        raise typer.Exit(2) from None

    owner, repo, pr_number = ref.repo.owner, ref.repo.repo, ref.number

    # 3. クライアント初期化・PR取得
    try:
        client = GitHubClient(host=config.host)
        if reviews:
            pr = client.get_pull_request_with_reviews(owner, repo, pr_number)
        else:
            pr = client.get_pull_request_slim(owner, repo, pr_number)
    except GitHubAPIError as e:
        typer.echo(f"エラー: {e.message}", err=True)
        raise typer.Exit(1) from None

    # 4. 出力
    if json_output:
        typer.echo(json.dumps(pr, ensure_ascii=False, indent=2))
    elif reviews:
        typer.echo(_format_pr_with_reviews_markdown(pr, owner, repo))
    else:
        typer.echo(_format_pr_markdown(pr))


# PR事前確認コマンド


def _branch_exists(branch: str, cwd: Path) -> bool:
    """Check whether the given branch exists

    Args:
        branch: Branch name
        cwd: Target directory

    Returns:
        True if the branch exists
    """
    try:
        run_git(["rev-parse", "--verify", branch], cwd, check=True)
        return True
    except subprocess.CalledProcessError:
        return False


def _get_git_status(cwd: Path) -> str:
    """Get the output of git status

    Args:
        cwd: Target directory

    Returns:
        Output of git status
    """
    try:
        result = run_git(["status"], cwd, check=True)
        return result.stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "(git status failed)"


def _get_commits_vs_base(base: str, cwd: Path) -> str:
    """Get the commit history that differs from the base branch

    Args:
        base: Base branch name
        cwd: Target directory

    Returns:
        Output of the commit history
    """
    try:
        result = run_git(["log", "--oneline", f"{base}..HEAD"], cwd, check=True)
        return result.stdout.strip() or "(no commits)"
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "(git log failed)"


def _get_diff_summary(base: str, cwd: Path) -> str:
    """Get the diff statistics against the base branch

    Args:
        base: Base branch name
        cwd: Target directory

    Returns:
        Output of the diff statistics
    """
    try:
        result = run_git(["diff", "--stat", f"{base}...HEAD"], cwd, check=True)
        return result.stdout.strip() or "(no diff)"
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "(git diff failed)"


def _read_gitignore(cwd: Path) -> str:
    """Read the .gitignore file

    Args:
        cwd: Target directory

    Returns:
        Contents of .gitignore
    """
    git_root = git_toplevel(cwd)
    if git_root is None:
        return "(not a git repository)"

    gitignore_path = git_root / ".gitignore"
    if gitignore_path.exists():
        try:
            return gitignore_path.read_text(encoding="utf-8")
        except Exception:
            return "(read error)"
    return "(no .gitignore)"


def _read_git_exclude(cwd: Path) -> str:
    """Read the .git/info/exclude file

    Args:
        cwd: Target directory

    Returns:
        Contents of .git/info/exclude
    """
    try:
        result = run_git(["rev-parse", "--git-common-dir"], cwd, check=True)
        git_common_dir = Path(result.stdout.strip())
        exclude_path = git_common_dir / "info" / "exclude"
        if exclude_path.exists():
            return exclude_path.read_text(encoding="utf-8")
        return "(no exclude)"
    except Exception:
        return "(read error)"


def _determine_base_branch(host: str, owner: str, repo: str, cwd: Path) -> str:
    """Decide the base branch

    Gets it from projectConfig.develop_branch.
    Raises an error if it is not set.

    Args:
        host: GitHub host
        owner: Repository owner
        repo: Repository name
        cwd: Target directory

    Returns:
        Base branch name (origin/xxx form)

    Raises:
        typer.Exit: If there is no project config, or develop_branch is unset
    """
    config = load_active_config()
    if not config:
        typer.echo("エラー: プロジェクト設定が見つかりません", err=True)
        typer.echo("ヒント: pecot project activate <PROJECT> でプロジェクトを設定", err=True)
        raise typer.Exit(1)

    develop_branch = config.get_develop_branch(owner, repo)
    if not develop_branch:
        typer.echo(
            f"エラー: リポジトリ {owner}/{repo} の develop_branch が設定されていません", err=True
        )
        typer.echo("", err=True)
        typer.echo("以下のコマンドで設定してください:", err=True)
        typer.echo(f"  pecot project set-repo {owner}/{repo} --develop-branch develop", err=True)
        typer.echo("  # または: --develop-branch develop-aist, --develop-branch main", err=True)
        raise typer.Exit(1)

    branch_name = f"origin/{develop_branch}"
    if not _branch_exists(branch_name, cwd):
        typer.echo(f"エラー: ブランチ {branch_name} が存在しません", err=True)
        typer.echo("", err=True)
        typer.echo("以下のコマンドでブランチを確認してください:", err=True)
        typer.echo("  git branch -r", err=True)
        raise typer.Exit(1)

    return branch_name


def _get_worktree_info(cwd: Path) -> str:
    """Get the worktree info

    Args:
        cwd: Target directory

    Returns:
        Worktree info (multiple lines)
    """
    lines: list[str] = []

    # ワークツリー一覧
    try:
        result = run_git(["worktree", "list"], cwd, check=True)
        lines.append(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        lines.append("(git worktree list failed)")

    lines.append("")

    # 対象ディレクトリ名
    try:
        lines.append(f"Current directory name: {cwd.name}")
    except Exception:
        lines.append("Current directory name: (unknown)")

    # ワークツリー判定（git-dir vs git-common-dir方式）
    try:
        git_dir_result = run_git(["rev-parse", "--git-dir"], cwd, check=True)
        common_dir_result = run_git(["rev-parse", "--git-common-dir"], cwd, check=True)
        git_dir = Path(git_dir_result.stdout.strip()).resolve()
        common_dir = Path(common_dir_result.stdout.strip()).resolve()
        is_worktree = git_dir != common_dir
        lines.append(f"Is worktree environment: {'true' if is_worktree else 'false'}")
    except (subprocess.CalledProcessError, FileNotFoundError):
        lines.append("Is worktree environment: (unknown)")

    return "\n".join(lines)


def _is_same_repo_for_cleanup(cwd: Path, owner: str, repo: str) -> bool:
    """Cross-repository check. If the CWD's repository differs from the PR's, show a warning and return False"""
    try:
        remote_url = git_remote_url(cwd)
        if remote_url is None:
            typer.echo(
                "  ⚠ リモートURL取得に失敗したため、ローカルクリーンアップをスキップします",
                err=True,
            )
            return False
        try:
            _host, local_owner, local_repo = parse_remote_url(remote_url)
        except ValueError:
            typer.echo(
                "  ⚠ リモートURLからリポジトリ情報を抽出できないため、"
                "ローカルクリーンアップをスキップします",
                err=True,
            )
            return False
        if local_owner != owner or local_repo != repo:
            typer.echo(
                f"  ⚠ 現在のリポジトリ({local_owner}/{local_repo})と"
                f"PRのリポジトリ({owner}/{repo})が異なるため、"
                "ローカルクリーンアップをスキップします",
                err=True,
            )
            return False
    except Exception:
        typer.echo(
            "  ⚠ リポジトリ判定に失敗したため、ローカルクリーンアップをスキップします", err=True
        )
        return False
    return True


def _resolve_cleanup_checkout_target(
    cwd: Path, config: ProjectConfig, owner: str, repo: str
) -> str | None:
    """Decide the checkout target (the worktree name in a worktree, otherwise the development branch). None if undecided"""
    from cli.core.worktree import get_current_worktree_name, is_worktree_env

    try:
        if is_worktree_env(cwd):
            wt_name = get_current_worktree_name(cwd)
            return wt_name if wt_name else "main"
        develop_branch = config.get_develop_branch(owner, repo)
        if develop_branch:
            return develop_branch
        typer.echo(
            "  ⚠ 開発ブランチが設定されていないため、ローカルクリーンアップをスキップします",
            err=True,
        )
        return None
    except Exception:
        typer.echo(
            "  ⚠ ワークツリー判定に失敗したため、ローカルクリーンアップをスキップします", err=True
        )
        return None


def _echo_cleanup_preview(
    current_branch: str | None, checkout_target: str, develop_branch: str, head_branch: str
) -> None:
    """Preview of the local cleanup for dry_run"""
    typer.echo("\n--- ローカルクリーンアップ（プレビュー） ---")
    if current_branch != checkout_target:
        typer.echo(f"  git checkout {checkout_target}")
    else:
        typer.echo(f"  (既に {checkout_target} ブランチにいるためcheckoutスキップ)")
    typer.echo(f"  git pull origin {develop_branch}")
    if head_branch != checkout_target:
        typer.echo(f"  git branch -D {head_branch}")
    else:
        typer.echo("  (head_branchがcheckout先と同じためブランチ削除スキップ)")


def _run_cleanup_commands(
    cwd: Path,
    current_branch: str | None,
    checkout_target: str,
    develop_branch: str,
    head_branch: str,
) -> None:
    """Run checkout -> pull -> branch -D in order (stop if checkout fails)"""
    typer.echo("\nローカルクリーンアップ中...")

    # git checkout
    if current_branch != checkout_target:
        try:
            run_git(["checkout", checkout_target], cwd, check=True)
            typer.echo(f"  ✔ git checkout {checkout_target}")
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            typer.echo(f"  ⚠ git checkout {checkout_target} に失敗: {e}", err=True)
            return
    else:
        typer.echo(f"  ✔ 既に {checkout_target} ブランチにいるためcheckoutスキップ")

    # git pull
    try:
        run_git(["pull", "origin", develop_branch], cwd, check=True)
        typer.echo(f"  ✔ git pull origin {develop_branch}")
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        typer.echo(f"  ⚠ git pull origin {develop_branch} に失敗: {e}", err=True)

    # git branch -D
    if head_branch != checkout_target:
        try:
            run_git(["branch", "-D", head_branch], cwd, check=True)
            typer.echo(f"  ✔ git branch -D {head_branch}")
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            typer.echo(f"  ⚠ git branch -D {head_branch} に失敗: {e}", err=True)
    else:
        typer.echo("  ✔ head_branchがcheckout先と同じためブランチ削除スキップ")


def _local_cleanup_after_merge(
    head_branch: str,
    config: ProjectConfig,
    owner: str,
    repo: str,
    dry_run: bool = False,
) -> None:
    """Local cleanup after a merge (switch branch, pull, delete branch)

    Args:
        head_branch: Head branch name of the merged PR.
        config: Project config.
        owner: Repository owner of the PR.
        repo: Repository name of the PR.
        dry_run: If True, only show the preview.
    """
    cwd = Path.cwd()

    # クロスリポ判定
    if not _is_same_repo_for_cleanup(cwd, owner, repo):
        return

    # 現在のブランチ取得
    current_branch = git_current_branch(cwd)

    # checkout先の決定
    checkout_target = _resolve_cleanup_checkout_target(cwd, config, owner, repo)
    if checkout_target is None:
        return

    # 開発ブランチ名を取得（pull用）
    develop_branch = config.get_develop_branch(owner, repo)
    if not develop_branch:
        typer.echo(
            "  ⚠ 開発ブランチが設定されていないため、ローカルクリーンアップをスキップします",
            err=True,
        )
        return

    # dry_run プレビュー
    if dry_run:
        _echo_cleanup_preview(current_branch, checkout_target, develop_branch, head_branch)
        return

    # 実行
    _run_cleanup_commands(cwd, current_branch, checkout_target, develop_branch, head_branch)


def _get_push_status(branch: str, cwd: Path) -> tuple[bool, str]:
    """Check the push state to the remote

    Args:
        branch: Branch name
        cwd: Target directory

    Returns:
        Tuple of (is_pushed, message)
        - is_pushed: True if all commits are pushed to the remote
        - message: Message describing the state
    """
    # 1. リモートブランチの存在確認
    try:
        result = run_git(["rev-parse", "--verify", f"origin/{branch}"], cwd, check=False)
        if result.returncode != 0:
            return False, f"リモートブランチ origin/{branch} が存在しません（未プッシュ）"
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False, "(git rev-parse failed)"

    # 2. ローカルとリモートのコミット差分を確認
    try:
        # ローカルにあってリモートにないコミット数
        result = run_git(["rev-list", "--count", f"origin/{branch}..{branch}"], cwd, check=True)
        ahead_count = int(result.stdout.strip())

        # リモートにあってローカルにないコミット数
        result = run_git(["rev-list", "--count", f"{branch}..origin/{branch}"], cwd, check=True)
        behind_count = int(result.stdout.strip())

        if ahead_count == 0 and behind_count == 0:
            return True, "リモートと同期済み"
        elif ahead_count > 0 and behind_count == 0:
            return False, f"未プッシュのコミットが {ahead_count} 件あります → git push が必要"
        elif ahead_count == 0 and behind_count > 0:
            return True, f"リモートが {behind_count} コミット先行（pull推奨）"
        else:
            return (
                False,
                f"ローカルが {ahead_count} 件先行、リモートが {behind_count} 件先行（diverged）",
            )

    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        return False, "(git rev-list failed)"


def _get_stash_list(cwd: Path) -> str:
    """Get the output of git stash list

    Args:
        cwd: Target directory

    Returns:
        The stash list as a string. "(no stash)" if there is no stash
    """
    try:
        result = run_git(["stash", "list"], cwd, check=True)
        return result.stdout.strip() or "(no stash)"
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "(git stash list failed)"


@dataclass(frozen=True)
class PreflightWarning:
    label: str
    message: str
    fix_hint: str


def _status_has_changes(git_status: str) -> bool:
    if not git_status.strip() or git_status.strip() == "(git status failed)":
        return False
    if "nothing to commit" in git_status and "working tree clean" in git_status:
        return False
    return True


def _stash_has_entries(stash_list: str) -> bool:
    return stash_list != "(no stash)" and not stash_list.startswith("(git stash")


def _validate_pr_context(
    directory: Path,
) -> tuple[Path, str, str, tuple[str, str, str]]:
    """Validate the preconditions shared by the PR commands, and return the context if they hold.

    Exit(1) on fatal cases (outside a git repository / no origin / branch undetermined / repository undetermined).
    """
    git_root = git_toplevel(directory)
    if git_root is None:
        typer.echo("エラー: gitリポジトリではありません", err=True)
        raise typer.Exit(1)

    remote_url = git_remote_url(directory)
    if remote_url is None:
        typer.echo("エラー: origin リモートが見つかりません", err=True)
        raise typer.Exit(1)

    current_branch = git_current_branch(directory)
    if current_branch is None:
        typer.echo("エラー: 現在のブランチを取得できません", err=True)
        raise typer.Exit(1)

    try:
        repo_info = parse_remote_url(remote_url)
    except ValueError:
        typer.echo("エラー: リポジトリ情報を取得できません", err=True)
        typer.echo("", err=True)
        typer.echo("リモートURLを確認してください:", err=True)
        typer.echo("  git remote -v", err=True)
        raise typer.Exit(1) from None

    return git_root, remote_url, current_branch, repo_info


def _collect_preflight_warnings(
    *,
    git_status: str,
    stash_list: str,
    is_pushed: bool,
    push_message: str,
    stash_has_entries: bool,
) -> list[PreflightWarning]:
    warnings: list[PreflightWarning] = []

    if not is_pushed:
        warnings.append(
            PreflightWarning(
                label="Push Status",
                message=push_message,
                fix_hint="git push してください",
            )
        )

    if _status_has_changes(git_status):
        warnings.append(
            PreflightWarning(
                label="Git Status",
                message="modified/untracked ファイルがあります",
                fix_hint="commit してください",
            )
        )

    if stash_has_entries:
        stash_count = len([line for line in stash_list.splitlines() if line.strip()])
        warnings.append(
            PreflightWarning(
                label="Stash List",
                message=f"{stash_count} 件のstashがあります",
                fix_hint="確認してください",
            )
        )

    return warnings


def _run_preflight_checks_or_exit(directory: Path) -> None:
    """Shared helper called from pr create.

    Fatal cases (outside a git repository, no origin, branch undetermined, repository undetermined) end with Exit(1).
    When a warning is found, fail early with Exit(2). With no warnings, do nothing and return.
    """
    _, _, current_branch, _ = _validate_pr_context(directory)

    is_pushed, push_message = _get_push_status(current_branch, directory)
    git_status = _get_git_status(directory)
    stash_list = _get_stash_list(directory)
    stash_has_entries = _stash_has_entries(stash_list)

    warnings = _collect_preflight_warnings(
        git_status=git_status,
        stash_list=stash_list,
        is_pushed=is_pushed,
        push_message=push_message,
        stash_has_entries=stash_has_entries,
    )
    if warnings:
        typer.echo(
            "エラー: preflight が警告を返しています。PR作成前に修正してください:",
            err=True,
        )
        for w in warnings:
            typer.echo(f"  ⚠ {w.label}: {w.message}（{w.fix_hint}）", err=True)
        typer.echo("詳細確認: pecot pr preflight", err=True)
        raise typer.Exit(2)


def _echo_push_status_section(is_pushed: bool, push_message: str) -> None:
    """Push Status section (heading and ✔ to stdout, ⚠ and ★ to stderr)"""
    typer.echo("")
    typer.echo("=== Push Status ===")
    if is_pushed:
        typer.echo(f"✔ {push_message}")
    else:
        typer.echo(f"⚠ {push_message}", err=True)
        typer.echo("", err=True)
        typer.echo("  ★ PR作成前に git push を実行してください ★", err=True)


def _echo_stash_list_section(stash_list: str, stash_has_entries: bool) -> None:
    """Stash List section (heading and ✔ to stdout, ⚠ to stderr)"""
    typer.echo("")
    typer.echo("=== Stash List ===")
    if stash_has_entries:
        typer.echo(f"⚠ {stash_list}", err=True)
    else:
        typer.echo(f"✔ {stash_list}")


def _echo_preflight_summary_or_exit(warnings: list[PreflightWarning]) -> None:
    """Summary section. With no warnings, ✔ to stdout; with warnings, the whole section to stderr and exit 2"""
    if not warnings:
        typer.echo("")
        typer.echo("=== Summary ===")
        typer.echo("✔ All checks passed")
        return

    # 警告ありの Summary は節ごと stderr に出す（同じ節を 2 ストリームに割らない）
    typer.echo("", err=True)
    typer.echo("=== Summary ===", err=True)
    for w in warnings:
        typer.echo(f"⚠ {w.label}: {w.message}（{w.fix_hint}）", err=True)
    raise typer.Exit(2)


def pr_preflight(
    directory: DirectoryOption = ...,  # type: ignore[assignment]
) -> None:
    """Show all the information to check before creating a PR

    Prints the following information.
    - Git Remote (origin URL)
    - Current Branch (current branch name)
    - Push Status (push state to the remote) ★
    - Base Branch (branch to compare against)
    - Git Status
    - .gitignore
    - Git Exclude (.git/info/exclude)
    - Commits (commits that differ from the base branch)
    - Diff Summary (diff statistics against the base branch)
    - Worktree Info (worktree list and environment info)
    - Stash List (git stash list)

    exit code semantics:
    - 0: success (all checks pass)
    - 1: fatal error (cannot create a PR: outside a git repository / no origin / branch undetermined / repository undetermined)
    - 2: fixable warning (not pushed / uncommitted / non-empty stash)

    A `=== Summary ===` section is printed at the end and repeats the warnings.
    """

    _, remote_url, current_branch, repo_info = _validate_pr_context(directory)
    host, owner, repo = repo_info
    base_branch = _determine_base_branch(host, owner, repo, directory)

    # 5. 各種情報収集
    git_status = _get_git_status(directory)
    gitignore_content = _read_gitignore(directory)
    git_exclude_content = _read_git_exclude(directory)
    commits = _get_commits_vs_base(base_branch, directory)
    diff_summary = _get_diff_summary(base_branch, directory)
    worktree_info = _get_worktree_info(directory)

    # 6. 出力
    typer.echo("=== Git Remote ===")
    typer.echo(remote_url)

    typer.echo("")
    typer.echo("=== Current Branch ===")
    typer.echo(current_branch)

    # プッシュ状態チェック
    is_pushed, push_message = _get_push_status(current_branch, directory)
    _echo_push_status_section(is_pushed, push_message)

    for heading, content in (
        ("=== Base Branch ===", base_branch),
        ("=== Git Status ===", git_status),
        ("=== .gitignore ===", gitignore_content),
        ("=== Git Exclude ===", git_exclude_content),
        (f"=== Commits (vs {base_branch}) ===", commits),
        (f"=== Diff Summary (vs {base_branch}) ===", diff_summary),
        ("=== Worktree Info ===", worktree_info),
    ):
        typer.echo("")
        typer.echo(heading)
        typer.echo(content)

    # Stash List
    stash_list = _get_stash_list(directory)
    stash_has_entries = _stash_has_entries(stash_list)
    _echo_stash_list_section(stash_list, stash_has_entries)

    # Summary セクション（末尾 tail で見逃し防止）
    warnings = _collect_preflight_warnings(
        git_status=git_status,
        stash_list=stash_list,
        is_pushed=is_pushed,
        push_message=push_message,
        stash_has_entries=stash_has_entries,
    )
    _echo_preflight_summary_or_exit(warnings)


# PRマージ後の片付けコマンド


def _fetch_pr_for_cleanup(
    config: ProjectConfig, owner: str, repo: str, pr_number: int
) -> tuple[GitHubClient, dict[str, Any]]:
    """3. Initialize the client and get the PR info (exit 1 on failure)"""
    try:
        client = GitHubClient(host=config.host)
        pr = client.get_pull_request_slim(owner, repo, pr_number)
    except GitHubNotFoundError:
        typer.echo(f"エラー: PRが見つかりません: {owner}/{repo}/{pr_number}", err=True)
        raise typer.Exit(1) from None
    except GitHubAPIError as e:
        typer.echo(f"エラー: {e.message}", err=True)
        raise typer.Exit(1) from None
    return client, pr


def _require_merged(pr: dict[str, Any], pr_number: int) -> None:
    """4. If the PR is not MERGED, do nothing and exit 1"""
    if pr["state"] != "MERGED":
        typer.echo(
            f"エラー: PR #{pr_number} はまだマージされていません（state: {pr['state']}）",
            err=True,
        )
        typer.echo("  gh pr merge でマージし、main に入ってから打ち直してください", err=True)
        raise typer.Exit(1)


def _collect_closing_issue_numbers(pr: dict[str, Any]) -> set[int]:
    """5.1-5.3 Collect the Issue numbers to close"""
    closing_issue_numbers: set[int] = set()

    # 5.1 closingIssuesReferences から取得
    for issue in pr.get("closing_issues", []):
        closing_issue_numbers.add(issue["number"])

    # 5.2 PR本文からClosing Issueパターンを抽出
    body_issue_numbers = _extract_closing_issue_numbers(pr.get("body", "") or "")
    closing_issue_numbers.update(body_issue_numbers)

    # 5.3 ブランチ名からIssue番号を抽出
    branch_issue_number = extract_issue_number_from_branch(pr["head_ref"])
    if branch_issue_number:
        closing_issue_numbers.add(branch_issue_number)
    return closing_issue_numbers


def _find_epic_protected_numbers(
    client: GitHubClient, owner: str, repo: str, issue_numbers: set[int]
) -> set[int]:
    """5.4 Epic protection: return the Issue numbers with Issue Type=Epic or sub-issues>0 (#358)"""
    epic_protected_numbers: set[int] = set()
    for issue_number in sorted(issue_numbers):
        try:
            kind = client.get_issue_kind(owner, repo, issue_number)
        except GitHubNotFoundError:
            continue
        except GitHubAPIError as e:
            typer.echo(
                f"  ⚠ Issue #{issue_number} の種別判定に失敗: {e.message}（保護せず続行）",
                err=True,
            )
            continue
        if is_epic_issue(kind):
            epic_protected_numbers.add(issue_number)
    return epic_protected_numbers


def _format_issue_numbers(numbers: set[int]) -> str:
    return ", ".join(f"#{n}" for n in sorted(numbers))


def _echo_cleanup_dry_run(
    pr: dict[str, Any],
    pr_label: str,
    closing_issue_numbers: set[int],
    epic_protected_numbers: set[int],
    delete_branch: bool,
) -> None:
    """6. Show what the dry-run would clean up"""
    typer.echo("=== ドライラン（実際には片付けません） ===\n")
    typer.echo(f"PR: {pr_label}")
    typer.echo(f"タイトル: {pr['title']}")
    typer.echo(f"ブランチ: {pr['head_ref']} → {pr['base_ref']}")
    if closing_issue_numbers:
        typer.echo(f"\nクローズ予定: {_format_issue_numbers(closing_issue_numbers)}")
    else:
        typer.echo("\nクローズ予定: なし")
    if epic_protected_numbers:
        typer.echo(f"Epic保護でクローズをスキップ: {_format_issue_numbers(epic_protected_numbers)}")
    if delete_branch:
        typer.echo(f"削除予定ブランチ: {pr['head_ref']}")


def _close_related_issues(
    client: GitHubClient,
    owner: str,
    repo: str,
    closing_issue_numbers: set[int],
    epic_protected_numbers: set[int],
) -> None:
    """8. Close the related Issues (show the Epic-protected ones as skipped)"""
    if epic_protected_numbers:
        typer.echo(
            f"\nEpic保護でクローズをスキップ: {_format_issue_numbers(epic_protected_numbers)}"
        )
    if closing_issue_numbers:
        typer.echo("\n関連Issueをクローズ中...")
        for issue_number in sorted(closing_issue_numbers):
            try:
                client.close_issue(owner, repo, issue_number)
                typer.echo(f"  ✔ Issue #{issue_number} をクローズしました")
            except GitHubNotFoundError:
                typer.echo(f"  ⚠ Issue #{issue_number} が見つかりません（スキップ）", err=True)
            except GitHubAPIError as e:
                if _is_closed_by_another_request(e):
                    typer.echo(f"  ✔ Issue #{issue_number} は既にクローズされています")
                    continue
                typer.echo(
                    f"  ⚠ Issue #{issue_number} のクローズに失敗: {describe_api_error(e)}", err=True
                )


def _is_closed_by_another_request(e: GitHubAPIError) -> bool:
    """Whether this is a 422 meaning another request (such as the PR's Closes auto-close) closed it at the same time"""
    return (
        e.status_code == 422
        and e.response_body is not None
        and "closed by another request" in e.response_body
    )


def _is_missing_ref_error(e: GitHubAPIError) -> bool:
    """Whether this error means the branch (ref) no longer exists"""
    if e.status_code not in (404, 422):
        return False
    return e.response_body is not None and "Reference does not exist" in e.response_body


def _delete_merged_branch(client: GitHubClient, owner: str, repo: str, head_branch: str) -> bool:
    """9. Delete the head branch and the WIP branch, and return whether the head was deleted

    If the head is already gone (such as GitHub's auto-delete), treat it as deleted and also delete the WIP.
    """
    typer.echo(f"\nブランチ '{head_branch}' を削除中...")
    try:
        client.delete_branch(owner, repo, head_branch)
        typer.echo(f"  ✔ ブランチ '{head_branch}' を削除しました")
    except GitHubAPIError as e:
        if not _is_missing_ref_error(e):
            typer.echo(f"  ⚠ ブランチ削除に失敗: {describe_api_error(e)}", err=True)
            return False
        typer.echo(f"  ✔ ブランチ '{head_branch}' は既に削除されています")
    # WIPブランチも連動削除
    wip_branch = f"wip/{head_branch}"
    try:
        client.delete_branch(owner, repo, wip_branch)
        typer.echo(f"  ✔ WIPブランチ '{wip_branch}' も削除しました")
    except GitHubAPIError:
        pass  # 存在しない場合は無視
    return True


def _remove_active_flags() -> None:
    """Clean up the flag files"""
    from cli.core.state import (
        FLAG_PECOT_ACTIVE,
        FLAG_PECOT_QUICK_MODE,
        FLAG_PECOT_SESSION_TITLE,
        FLAG_WIP_BRANCH_LINKED,
        remove_flag,
    )

    try:
        remove_flag(FLAG_PECOT_ACTIVE)
        remove_flag(FLAG_PECOT_SESSION_TITLE)
        remove_flag(FLAG_PECOT_QUICK_MODE)
        remove_flag(FLAG_WIP_BRANCH_LINKED)
    except Exception as e:
        typer.echo(f"  ⚠ フラグファイルの削除に失敗: {e}", err=True)


def _echo_cleanup_summary(
    pr: dict[str, Any],
    pr_label: str,
    closing_issue_numbers: set[int],
    deleted_branch: str | None,
) -> None:
    """11-12. Summary and the message that no merge report is needed"""
    typer.echo("\n=== マージ後の片付け完了 ===")
    typer.echo(f"PR: {pr_label}")
    typer.echo(f"タイトル: {pr['title']}")
    if closing_issue_numbers:
        typer.echo(f"クローズしたIssue: {_format_issue_numbers(closing_issue_numbers)}")
    if deleted_branch:
        typer.echo(f"削除したブランチ: {deleted_branch}")

    typer.echo("")
    typer.echo("※マージ完了報告をIssueにコメントする必要はありません。")


@dataclass
class _CleanupContext:
    client: GitHubClient
    config: ProjectConfig
    owner: str
    repo: str
    pr: dict[str, Any]
    pr_label: str
    closing_issue_numbers: set[int]
    epic_protected_numbers: set[int]
    delete_branch: bool
    skip_local_cleanup: bool


def _finish_cleanup(ctx: _CleanupContext) -> None:
    """8-12. Close Issues, delete branches, local cleanup, summary"""
    _close_related_issues(
        ctx.client, ctx.owner, ctx.repo, ctx.closing_issue_numbers, ctx.epic_protected_numbers
    )
    head_branch = ctx.pr["head_ref"]
    branch_deleted = ctx.delete_branch and _delete_merged_branch(
        ctx.client, ctx.owner, ctx.repo, head_branch
    )
    if not ctx.skip_local_cleanup:
        _local_cleanup_after_merge(
            head_branch=head_branch, config=ctx.config, owner=ctx.owner, repo=ctx.repo
        )
        _remove_active_flags()
        consume_flag(FLAG_MERGE_SLASH_PENDING)
    _echo_cleanup_summary(
        ctx.pr,
        ctx.pr_label,
        ctx.closing_issue_numbers,
        head_branch if branch_deleted else None,
    )


def pr_cleanup(
    ctx: typer.Context,
    pr_ref: Annotated[
        str,
        typer.Argument(help="PR reference (owner/repo/N, or the short form N only with `--repo`)"),
    ],
    dry_run: Annotated[
        bool,
        typer.Option("--dry-run", "-n", help="Dry-run (do not actually clean up)"),
    ] = False,
    delete_branch: Annotated[
        bool,
        typer.Option("--delete-branch", "-d", help="Delete the branch"),
    ] = False,
    skip_local_cleanup: Annotated[
        bool,
        typer.Option("--skip-local-cleanup", help="Skip the local branch switch and deletion"),
    ] = False,
) -> None:
    """Clean up after a merged PR (close related Issues, delete branches, local cleanup)

    Does not merge. Run it after merging with gh pr merge and the change is in main.
    Extracts the Closes/Fixes/Resolves #XXX patterns from the PR body and closes the related Issues.

    Examples:
        pecot pr cleanup owner/repo/123 --delete-branch
        pecot pr cleanup owner/repo/123 --dry-run
    """
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    try:
        base = _resolve_base_repo(ctx)
        ref = parse_pr_ref(pr_ref, base_repo=base)
    except RefParseError as e:
        typer.echo(f"エラー: {e.message}", err=True)
        raise typer.Exit(2) from None

    owner, repo, pr_number = ref.repo.owner, ref.repo.repo, ref.number
    pr_label = f"{owner}/{repo}/{pr_number}"

    client, pr = _fetch_pr_for_cleanup(config, owner, repo, pr_number)
    _require_merged(pr, pr_number)

    closing_issue_numbers = _collect_closing_issue_numbers(pr)
    epic_protected_numbers = _find_epic_protected_numbers(
        client, owner, repo, closing_issue_numbers
    )
    closing_issue_numbers -= epic_protected_numbers
    head_branch = pr["head_ref"]

    if dry_run:
        _echo_cleanup_dry_run(
            pr, pr_label, closing_issue_numbers, epic_protected_numbers, delete_branch
        )
        if not skip_local_cleanup:
            _local_cleanup_after_merge(
                head_branch=head_branch, config=config, owner=owner, repo=repo, dry_run=True
            )
        return

    _finish_cleanup(
        _CleanupContext(
            client=client,
            config=config,
            owner=owner,
            repo=repo,
            pr=pr,
            pr_label=pr_label,
            closing_issue_numbers=closing_issue_numbers,
            epic_protected_numbers=epic_protected_numbers,
            delete_branch=delete_branch,
            skip_local_cleanup=skip_local_cleanup,
        )
    )
