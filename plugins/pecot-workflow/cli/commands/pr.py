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

from cli.commands._output import Operation, Output, Verb
from cli.commands._tracker_sync import settle
from cli.commands.options import DirectoryOption
from cli.core.config import ProjectConfig, load_active_config
from cli.core.frontmatter import (
    FrontmatterError,
    parse_pr_file,
)
from cli.core.git import git_current_branch, git_remote_url, git_toplevel, origin_repo, run_git
from cli.core.git_url import parse_remote_url
from cli.core.github import GitHubAPIError, GitHubClient, GitHubNotFoundError
from cli.core.github.errors import describe_api_error, is_missing_ref_error
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
    out: Output,
) -> None:
    """After a PR is created, set the related Issue's status to In Review

    The Issue number comes from the end of the branch name. Every failure is a warning
    and does not affect the PR creation result.
    """
    issue_number = extract_issue_number_from_branch(head_branch)
    if issue_number is None:
        return

    try:
        item_id = client.get_item_id_by_issue(
            project_id=config.project.id,
            owner=owner,
            repo=repo,
            issue_number=issue_number,
        )
    except Exception as e:
        out.warning(f"board item lookup for Issue #{issue_number} failed: {e}")
        return

    if item_id is None:
        out.warning(f"Issue #{issue_number} is not on the board; status not updated")
        return

    option_id = config.get_option_id("workflow", "in_review")
    if option_id is None:
        out.warning("workflow field has no in_review status; status not updated")
        return

    field_id = config.get_field_id("workflow")
    if field_id is None:
        out.warning("workflow field not found; status not updated")
        return

    try:
        client.update_project_item_field(
            project_id=config.project.id,
            item_id=item_id,
            field_id=field_id,
            option_id=option_id,
        )
    except Exception as e:
        out.warning(f"status update of Issue #{issue_number} failed: {e}")
        return
    out.done(_in_review_op(issue_number))


def _in_review_op(issue_number: int) -> Operation:
    return Operation(Verb.SET, f"Issue #{issue_number} status to In Review")


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
    out: Output,
) -> None:
    """Exit 1 before validation if a branch setting needed to check base is missing"""
    is_release = _is_release_pr(template, base, head, develop_branch, release_branch)
    if is_release and not release_branch:
        out.error(
            "release_branch is not set\n"
            "set it with: pecot project set-repo owner/repo --release-branch main"
        )
        raise typer.Exit(1)
    if not is_release and not develop_branch:
        out.error(
            "develop_branch is not set\n"
            "set it with: pecot project set-repo owner/repo --develop-branch develop"
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
            "PR body has no Issue reference `#N` (use `--no-issue-ref` for a PR not tied to an Issue)"
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
            errors.append(f"missing sections: {', '.join(missing_sections)}")
        summary_errors = validate_heading_summaries(body, required_sections)
        if summary_errors:
            errors.append(f"heading summary rule violations: {', '.join(summary_errors)}")

    # 記法チェック（テンプレート抽出の成否に依らず掛ける）
    style_errors = validate_body_style(body)
    if style_errors:
        errors.append(f"disallowed syntax: {', '.join(style_errors)}")

    # 画像チェック（リリースPRは対象外）
    if not is_release and not screenshot and not has_summary_image(body):
        errors.append(SCREENSHOT_MISSING_ERROR)

    # baseブランチチェック（開発ブランチ運用。ブランチ未設定は呼び出し側で先に止める）
    if is_release:
        if release_branch and base != release_branch:
            errors.append(f"release PR base branch must be {release_branch} (given: {base})")
    else:
        if develop_branch and base != develop_branch:
            errors.append(f"base branch must be {develop_branch} (given: {base})")

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


def _expected_title_scope(toplevel: Path, base: str, head: str, out: Output) -> list[str] | None:
    """Return the scope expected from the changed nx projects

    If it cannot be determined, warns and returns None (the comparison is skipped).
    Returns an empty list (no comparison) if the diff is empty or only has a version plan.
    """
    projects = nx_projects(toplevel)
    files = changed_files(toplevel, f"origin/{base}", head) if projects else None
    if projects is None or files is None:
        out.warning("cannot read nx projects or the diff; skipped the PR title scope check")
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
    out: Output,
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
    expected = _expected_title_scope(toplevel, base, head, out)
    if not expected:
        return []
    given = parse_title_scope(title)
    if given is not None and set(given) == set(expected):
        return []
    shown = ",".join(given) if given else "none"
    return [
        f"PR title scope must be {','.join(expected)} "
        f"(given: {shown}; computed from the tags of the changed nx projects)"
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
    out = Output(dry_run)

    _validate_template_option(template, out)

    if prepare:
        _pr_create_prepare(directory, Output(False), template=template)
    elif file is not None:
        _exit_on_screenshot_option(screenshot, out)
        _pr_create_from_file(file, dry_run, no_issue_ref, directory, template=template)
    elif message is not None:
        title, base = _require_title_and_base(title, base, out)
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
        _exit_with_pr_create_usage(out)


def _exit_on_screenshot_option(screenshot: str | None, out: Output) -> None:
    """If --screenshot is passed in file mode, say to put it in the front matter and exit 1"""
    if screenshot is not None:
        out.error(
            "--screenshot is for -m; write the reason in the `screenshot` frontmatter field instead"
        )
        raise typer.Exit(1)


def _require_title_and_base(title: str | None, base: str | None, out: Output) -> tuple[str, str]:
    """Exit 1 if -t or -b is missing with -m, otherwise return (title, base)"""
    if not title or not base:
        out.error("-t (title) and -b (base branch) are required with -m")
        raise typer.Exit(1)
    return title, base


def _validate_template_option(template: str, out: Output) -> None:
    """Exit 1 if --template is anything other than default / release"""
    if template not in ("default", "release"):
        out.error(f"--template must be 'default' or 'release' (given: {template})")
        raise typer.Exit(1)


def _exit_with_pr_create_usage(out: Output) -> NoReturn:
    """Print usage as one error and exit 1 for missing arguments"""
    out.error(
        "missing arguments\n"
        "usage:\n"
        "pecot pr create --prepare\n"
        "pecot pr create <path>\n"
        'pecot pr create -m "<body>" -t "<title>" -b <base-branch>'
    )
    raise typer.Exit(1)


def _add_scope_hint(
    content: str,
    config: ProjectConfig,
    owner: str,
    repo: str,
    base: str,
    directory: Path,
    out: Output,
) -> str:
    """Write the scope computed from the changed nx projects as a comment on the title line"""
    toplevel = _nx_scope_toplevel(config, owner, repo, base, directory)
    if toplevel is None:
        return content
    head = git_current_branch(directory)
    expected = _expected_title_scope(toplevel, base, head, out) if head else None
    if not expected:
        return content
    scope = ",".join(expected)
    # The comment goes after the closing quote so the YAML title stays "".
    content = re.sub(
        r'^(title:\s*"[^"]*")',
        lambda m: f"{m.group(1)}  # expected scope: {scope}",
        content,
        count=1,
        flags=re.MULTILINE,
    )
    out.done(Operation(Verb.SET, f"title scope hint to {scope}"))
    return content


def _pr_create_prepare(directory: Path, out: Output, *, template: str = "default") -> None:
    """Copy the template to the work directory

    Gets develop_branch from the project config and sets it as the template's base.
    This prevents creating a PR to main by mistake.

    Args:
        directory: Target directory
        out: Output functions
        template: Template kind ("default" or "release")
    """
    if template == "release":
        template_path = TEMPLATES_DIR / "release.md"
    else:
        template_path = TEMPLATES_DIR / "create.md"

    if not template_path.exists():
        out.error(f"template not found: {template_path}")
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
                    out.done(Operation(Verb.SET, f"base to {develop_branch}"))
                    content = _add_scope_hint(
                        content, config, owner, repo, develop_branch, directory, out
                    )

        # Closes #N 自動埋め込み (#358)
        content = _fill_closes_in_template(content, directory, repo_info, out)

    # 出力パス予約（同名があれば ts を 1 秒進めて再試行）。
    # 書き込み前に失敗した場合は予約を撤去する。
    prefix = "pr-release" if template == "release" else "pr-create"
    try:
        with reserved_output_path(get_output_dir(), lambda ts: f"{prefix}-{ts}.md") as output_path:
            output_path.write_text(content, encoding="utf-8")
            out.data(str(output_path))
    except OutputPathReservationError as e:
        out.error(str(e))
        raise typer.Exit(1) from None


def _fill_closes_in_template(
    content: str,
    directory: Path,
    repo_info: tuple[str, str, str] | None,
    out: Output,
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
        out.warning(f"kind check of Issue #{target_number} failed: {msg}; fill Closes by hand")
        return content

    if is_epic_issue(kind):
        out.warning(f"Issue #{target_number} is an Epic; Closes left empty")
        return content

    new_content, n_subs = re.subn(
        r"^Closes #\s*$",
        f"Closes #{target_number}",
        content,
        count=1,
        flags=re.MULTILINE,
    )
    if n_subs > 0:
        out.done(Operation(Verb.SET, f"Closes to #{target_number}"))
    return new_content


def _resolve_head_branch(head: str | None, directory: Path, out: Output) -> str:
    """Decide the head branch (the current branch if unspecified, exit 1 if it cannot be determined)"""
    if head:
        return head
    head_branch = git_current_branch(directory)
    if not head_branch:
        out.error("cannot determine the head branch")
        raise typer.Exit(1)
    return head_branch


def _append_close_unless_epic(
    config: ProjectConfig, owner: str, repo: str, body: str, issue_number: int, out: Output
) -> str:
    """Add Closes to the body unless the Issue at the end of the branch is an Epic (added if the judgment fails)"""
    try:
        _kind_client = GitHubClient(host=config.host)
        kind = _kind_client.get_issue_kind(owner, repo, issue_number)
        if is_epic_issue(kind):
            out.warning(
                f"Issue #{issue_number} at the end of the branch is an Epic; Closes not added"
            )
        else:
            body = _append_issue_close_if_needed(body, issue_number)
    except (GitHubAPIError, GitHubNotFoundError):
        body = _append_issue_close_if_needed(body, issue_number)
    return body


# 本文の検証の失敗。1（通信・設定・引数）と 2（preflight）と区別する
PR_VALIDATION_EXIT_CODE = 3


def _exit_on_validation_errors(errors: list[str], out: Output) -> None:
    """If there are validation errors, print one error line each and exit 3"""
    if errors:
        for error in errors:
            out.error(error)
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

    def create_op(self) -> Operation:
        kind = "draft PR" if self.draft else "PR"
        suffix = " (release template)" if self.is_release else ""
        target = f"{kind} {self.owner}/{self.repo} {self.head} -> {self.base}: {self.title}{suffix}"
        return Operation(Verb.CREATE, target)


def _plan_dry_run(pr: _PrDraft, out: Output) -> None:
    """Print the plan lines of a validated dry-run (the status update only for a regular PR)"""
    out.planned(pr.create_op())
    issue_number = extract_issue_number_from_branch(pr.head)
    if not pr.is_release and issue_number is not None:
        out.planned(_in_review_op(issue_number))


def _submit_pull_request(
    config: ProjectConfig, directory: Path, pr_draft: _PrDraft, out: Output
) -> None:
    """Early preflight check -> create the PR -> update to In Review -> print the URL"""
    _run_preflight_checks_or_exit(directory, out)

    client = GitHubClient(host=config.host)

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
        out.error(f"PR creation failed: {e.message}")
        raise typer.Exit(1) from None
    out.done(pr_draft.create_op())

    if not pr_draft.is_release:
        _update_issue_status_to_in_review(
            config, client, pr_draft.owner, pr_draft.repo, pr_draft.head, out
        )

    consume_flag(FLAG_PR_CREATE_SLASH_PENDING)
    out.data(pr["html_url"])


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
    out = Output(dry_run)

    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    try:
        parsed = parse_pr_file(file)
    except FrontmatterError as e:
        out.error(str(e))
        raise typer.Exit(1) from None

    fm = parsed.frontmatter
    if not fm.repository or "/" not in fm.repository:
        out.error("repository is required (e.g. owner/repo)")
        raise typer.Exit(1)
    owner, repo = fm.repository.split("/")

    head_branch = _resolve_head_branch(fm.head, directory, out)

    # リリースPR判定
    is_release = template == "release"

    # 4. Issue参照自動追加（リリースPRではスキップ）
    body = parsed.body
    issue_number: int | None = None
    if not is_release and not no_issue_ref:
        issue_number = extract_issue_number_from_branch(head_branch)
        if issue_number:
            body = _append_close_unless_epic(config, owner, repo, body, issue_number, out)

    # 5. 開発ブランチ・リリースブランチを取得（バリデーション用）
    develop_branch = config.get_develop_branch(owner, repo)
    release_branch = config.get_release_branch(owner, repo)

    # 6. バリデーション
    # 免除は `--no-issue-ref` と release テンプレだけ（release は _validate_pr_content が判定）
    _exit_on_unset_branch(template, fm.base, head_branch, develop_branch, release_branch, out)
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
        config, owner, repo, fm.title, fm.base, head_branch, directory, out, template=template
    )
    _exit_on_validation_errors(errors, out)

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
        _plan_dry_run(pr_draft, out)
        return

    _submit_pull_request(config, directory, pr_draft, out)


def _resolve_direct_repository(
    config: ProjectConfig, repository: str | None, out: Output
) -> tuple[str, str]:
    """2. Decide the repository (-r if given, otherwise the single repository in the config)"""
    if repository:
        parts = repository.split("/")
        if len(parts) != 2:
            out.error(f"invalid repository format: {repository} (expected: owner/repo)")
            raise typer.Exit(1)
        return parts[0], parts[1]
    # 設定から取得を試みる
    if config.repositories and len(config.repositories) == 1:
        return config.repositories[0].owner, config.repositories[0].name
    out.error("specify the repository (-r owner/repo)")
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
    out = Output(dry_run)

    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    owner, repo = _resolve_direct_repository(config, repository, out)

    head_branch = _resolve_head_branch(head, directory, out)

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
    _exit_on_unset_branch(template, base, head_branch, develop_branch, release_branch, out)
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
        config, owner, repo, title, base, head_branch, directory, out, template=template
    )
    _exit_on_validation_errors(errors, out)

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
        _plan_dry_run(pr_draft, out)
        return

    _submit_pull_request(config, directory, pr_draft, out)


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
            lines.append(f"    → details: pecot issue read {owner}/{repo}/{issue['number']}")
        lines.append("")

    # 参照Issue（Refs #XXX、詳細確認コマンド付き）
    if pr.get("referenced_issues"):
        lines.append("**Referenced Issues:**")
        for issue in pr["referenced_issues"]:
            title_suffix = f" {issue['title']}" if issue.get("title") else ""
            lines.append(f"  - #{issue['number']}{title_suffix}")
            lines.append(f"    → details: pecot issue read {owner}/{repo}/{issue['number']}")
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
    out = Output(False)

    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    try:
        base = _resolve_base_repo(ctx)
        ref = parse_pr_ref(pr_ref, base_repo=base, repo_flag=True)
    except RefParseError as e:
        out.error(e.message)
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
        out.error(e.message)
        raise typer.Exit(1) from None

    # The extra newline keeps the bytes the body had before the move to Output.
    if json_output:
        out.data(json.dumps(pr, ensure_ascii=False, indent=2) + "\n")
    elif reviews:
        out.data(_format_pr_with_reviews_markdown(pr, owner, repo) + "\n")
    else:
        out.data(_format_pr_markdown(pr) + "\n")


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


def _determine_base_branch(host: str, owner: str, repo: str, cwd: Path, out: Output) -> str:
    """Decide the base branch

    Gets it from projectConfig.develop_branch.
    Raises an error if it is not set.

    Args:
        host: GitHub host
        owner: Repository owner
        repo: Repository name
        cwd: Target directory
        out: Output functions

    Returns:
        Base branch name (origin/xxx form)

    Raises:
        typer.Exit: If there is no project config, or develop_branch is unset
    """
    config = load_active_config()
    if not config:
        out.error(
            "project config not found\nactivate a project with: pecot project activate <PROJECT>"
        )
        raise typer.Exit(1)

    develop_branch = config.get_develop_branch(owner, repo)
    if not develop_branch:
        out.error(
            f"develop_branch is not set for {owner}/{repo}\n"
            f"set it with: pecot project set-repo {owner}/{repo} --develop-branch develop"
        )
        raise typer.Exit(1)

    branch_name = f"origin/{develop_branch}"
    if not _branch_exists(branch_name, cwd):
        out.error(
            f"branch {branch_name} does not exist\ncheck the remote branches with: git branch -r"
        )
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


def _is_same_repo_for_cleanup(cwd: Path, owner: str, repo: str, out: Output) -> bool:
    """Cross-repository check. If the CWD's repository differs from the PR's, warn and return False"""
    skipped = "skipped local cleanup"
    try:
        remote_url = git_remote_url(cwd)
        if remote_url is None:
            out.warning(f"cannot read the remote URL; {skipped}")
            return False
        try:
            _host, local_owner, local_repo = parse_remote_url(remote_url)
        except ValueError:
            out.warning(f"cannot read the repository from the remote URL; {skipped}")
            return False
        if local_owner != owner or local_repo != repo:
            out.warning(
                f"current repository ({local_owner}/{local_repo}) differs from the PR's "
                f"({owner}/{repo}); {skipped}"
            )
            return False
    except Exception:
        out.warning(f"cannot determine the repository; {skipped}")
        return False
    return True


def _resolve_cleanup_checkout_target(
    cwd: Path, config: ProjectConfig, owner: str, repo: str, out: Output
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
        out.warning("develop_branch is not set; skipped local cleanup")
        return None
    except Exception:
        out.warning("cannot determine the worktree; skipped local cleanup")
        return None


def _run_local_step(out: Output, op: Operation, cwd: Path, args: list[str], failure: str) -> bool:
    """Plan the step in dry-run, otherwise run git and print the result. False if git failed"""
    out.planned(op)
    if out.dry_run:
        return True
    try:
        run_git(args, cwd, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        out.warning(f"{failure} failed: {e}")
        return False
    out.done(op)
    return True


def _local_cleanup_after_merge(
    head_branch: str,
    config: ProjectConfig,
    owner: str,
    repo: str,
    out: Output,
) -> None:
    """Local cleanup after a merge (switch branch, pull, delete branch)

    In dry-run, only the plan lines are printed and git is not run.
    """
    cwd = Path.cwd()

    if not _is_same_repo_for_cleanup(cwd, owner, repo, out):
        return

    current_branch = git_current_branch(cwd)

    checkout_target = _resolve_cleanup_checkout_target(cwd, config, owner, repo, out)
    if checkout_target is None:
        return

    develop_branch = config.get_develop_branch(owner, repo)
    if not develop_branch:
        out.warning("develop_branch is not set; skipped local cleanup")
        return

    if current_branch != checkout_target:
        checkout = Operation(Verb.SET, f"current branch to {checkout_target}")
        # A failed checkout stops the rest: pull and branch -D would hit the wrong branch.
        if not _run_local_step(
            out, checkout, cwd, ["checkout", checkout_target], f"checking out {checkout_target}"
        ):
            return
    else:
        settle(out, Operation(Verb.UNCHANGED, f"current branch {checkout_target}"))

    pull = Operation(Verb.UPDATE, f"{checkout_target} from origin/{develop_branch}")
    _run_local_step(out, pull, cwd, ["pull", "origin", develop_branch], f"pulling {develop_branch}")

    if head_branch != checkout_target:
        delete = Operation(Verb.DELETE, f"local branch {head_branch}")
        _run_local_step(
            out, delete, cwd, ["branch", "-D", head_branch], f"deleting local branch {head_branch}"
        )
    else:
        skip = Operation(
            Verb.SKIP,
            f"deleting local branch {head_branch} (it is the checkout target)",
        )
        settle(out, skip)


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
            return False, f"origin/{branch} does not exist (not pushed)"
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
            return True, f"in sync with origin/{branch}"
        elif ahead_count > 0 and behind_count == 0:
            return False, f"{ahead_count} unpushed commits"
        elif ahead_count == 0 and behind_count > 0:
            return True, f"origin/{branch} is {behind_count} commits ahead (pull recommended)"
        else:
            return (
                False,
                f"diverged: local is {ahead_count} commits ahead, origin/{branch} is {behind_count} ahead",
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
    directory: Path, out: Output
) -> tuple[Path, str, str, tuple[str, str, str]]:
    """Validate the preconditions shared by the PR commands, and return the context if they hold.

    Exit(1) on fatal cases (outside a git repository / no origin / branch undetermined / repository undetermined).
    """
    git_root = git_toplevel(directory)
    if git_root is None:
        out.error("not a git repository")
        raise typer.Exit(1)

    remote_url = git_remote_url(directory)
    if remote_url is None:
        out.error("origin remote not found")
        raise typer.Exit(1)

    current_branch = git_current_branch(directory)
    if current_branch is None:
        out.error("cannot determine the current branch")
        raise typer.Exit(1)

    try:
        repo_info = parse_remote_url(remote_url)
    except ValueError:
        out.error("cannot read repository info from the remote URL\ncheck it with: git remote -v")
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
                fix_hint="git push",
            )
        )

    if _status_has_changes(git_status):
        warnings.append(
            PreflightWarning(
                label="Git Status",
                message="modified or untracked files",
                fix_hint="commit",
            )
        )

    if stash_has_entries:
        stash_count = len([line for line in stash_list.splitlines() if line.strip()])
        warnings.append(
            PreflightWarning(
                label="Stash List",
                message=f"{stash_count} stash entries",
                fix_hint="check them",
            )
        )

    return warnings


def _print_preflight_warnings(out: Output, warnings: list[PreflightWarning]) -> None:
    for w in warnings:
        out.warning(f"{w.label}: {w.message} (fix: {w.fix_hint})")


def _run_preflight_checks_or_exit(directory: Path, out: Output) -> None:
    """Shared helper called from pr create.

    Fatal cases (outside a git repository, no origin, branch undetermined, repository undetermined) end with Exit(1).
    When a warning is found, fail early with Exit(2). With no warnings, do nothing and return.
    """
    _, _, current_branch, _ = _validate_pr_context(directory, out)

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
        out.error("preflight found warnings; fix them before creating a PR")
        _print_preflight_warnings(out, warnings)
        raise typer.Exit(2)


def _emit(out: Output, text: str) -> None:
    """Print stdout data with the trailing newline the old output added (git output may already end with one)"""
    out.data(text + "\n")


def pr_preflight(
    directory: DirectoryOption = ...,  # type: ignore[assignment]
) -> None:
    """Show all the information to check before creating a PR

    Prints the following information.
    - Git Remote (origin URL)
    - Current Branch (current branch name)
    - Push Status (push state to the remote)
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

    The sections go to stdout. The warning count and each warning go to stderr.
    """
    out = Output(False)

    _, remote_url, current_branch, repo_info = _validate_pr_context(directory, out)
    host, owner, repo = repo_info
    base_branch = _determine_base_branch(host, owner, repo, directory, out)

    # 5. 各種情報収集
    git_status = _get_git_status(directory)
    gitignore_content = _read_gitignore(directory)
    git_exclude_content = _read_git_exclude(directory)
    commits = _get_commits_vs_base(base_branch, directory)
    diff_summary = _get_diff_summary(base_branch, directory)
    worktree_info = _get_worktree_info(directory)

    is_pushed, push_message = _get_push_status(current_branch, directory)
    stash_list = _get_stash_list(directory)
    stash_has_entries = _stash_has_entries(stash_list)

    sections = (
        ("=== Git Remote ===", remote_url),
        ("=== Current Branch ===", current_branch),
        ("=== Push Status ===", push_message),
        ("=== Base Branch ===", base_branch),
        ("=== Git Status ===", git_status),
        ("=== .gitignore ===", gitignore_content),
        ("=== Git Exclude ===", git_exclude_content),
        (f"=== Commits (vs {base_branch}) ===", commits),
        (f"=== Diff Summary (vs {base_branch}) ===", diff_summary),
        ("=== Worktree Info ===", worktree_info),
        ("=== Stash List ===", stash_list),
    )
    for index, (heading, content) in enumerate(sections):
        if index:
            _emit(out, "")
        _emit(out, heading)
        _emit(out, content)

    warnings = _collect_preflight_warnings(
        git_status=git_status,
        stash_list=stash_list,
        is_pushed=is_pushed,
        push_message=push_message,
        stash_has_entries=stash_has_entries,
    )
    out.count("preflight warnings", len(warnings))
    _print_preflight_warnings(out, warnings)
    if warnings:
        raise typer.Exit(2)


# PRマージ後の片付けコマンド


def _fetch_pr_for_cleanup(
    config: ProjectConfig, owner: str, repo: str, pr_number: int, out: Output
) -> tuple[GitHubClient, dict[str, Any]]:
    """Initialize the client and get the PR info (exit 1 on failure)"""
    try:
        client = GitHubClient(host=config.host)
        pr = client.get_pull_request_slim(owner, repo, pr_number)
    except GitHubNotFoundError:
        out.error(f"PR not found: {owner}/{repo}/{pr_number}")
        raise typer.Exit(1) from None
    except GitHubAPIError as e:
        out.error(e.message)
        raise typer.Exit(1) from None
    return client, pr


def _require_merged(pr: dict[str, Any], pr_number: int, out: Output) -> None:
    """If the PR is not MERGED, do nothing and exit 1"""
    if pr["state"] != "MERGED":
        out.error(
            f"PR #{pr_number} is not merged yet (state: {pr['state']}); "
            "merge it with gh pr merge first"
        )
        raise typer.Exit(1)


def _collect_closing_issue_numbers(pr: dict[str, Any]) -> set[int]:
    """Collect the Issue numbers to close"""
    closing_issue_numbers: set[int] = set()

    for issue in pr.get("closing_issues", []):
        closing_issue_numbers.add(issue["number"])

    body_issue_numbers = _extract_closing_issue_numbers(pr.get("body", "") or "")
    closing_issue_numbers.update(body_issue_numbers)

    branch_issue_number = extract_issue_number_from_branch(pr["head_ref"])
    if branch_issue_number:
        closing_issue_numbers.add(branch_issue_number)
    return closing_issue_numbers


def _find_epic_protected_numbers(
    client: GitHubClient, owner: str, repo: str, issue_numbers: set[int], out: Output
) -> set[int]:
    """Epic protection: return the Issue numbers with Issue Type=Epic or sub-issues>0 (#358)"""
    epic_protected_numbers: set[int] = set()
    for issue_number in sorted(issue_numbers):
        try:
            kind = client.get_issue_kind(owner, repo, issue_number)
        except GitHubNotFoundError:
            continue
        except GitHubAPIError as e:
            out.warning(f"kind check of Issue #{issue_number} failed: {e.message}; not protected")
            continue
        if is_epic_issue(kind):
            epic_protected_numbers.add(issue_number)
    return epic_protected_numbers


def _close_related_issues(
    out: Output,
    client: GitHubClient,
    owner: str,
    repo: str,
    closing_issue_numbers: set[int],
    epic_protected_numbers: set[int],
) -> None:
    """Skip the Epic-protected Issues and close the others in number order (plans only in dry-run)"""
    for issue_number in sorted(epic_protected_numbers):
        settle(out, Operation(Verb.SKIP, f"closing Issue #{issue_number} (Epic)"))
    for issue_number in sorted(closing_issue_numbers):
        op = Operation(Verb.CLOSE, f"Issue #{issue_number}")
        out.planned(op)
        if out.dry_run:
            continue
        try:
            client.close_issue(owner, repo, issue_number)
        except GitHubNotFoundError:
            out.warning(f"Issue #{issue_number} not found; skipped")
        except GitHubAPIError as e:
            if _is_closed_by_another_request(e):
                out.done(Operation(Verb.UNCHANGED, f"Issue #{issue_number} (already closed)"))
                continue
            out.warning(f"closing Issue #{issue_number} failed: {describe_api_error(e)}")
        else:
            out.done(op)


def _is_closed_by_another_request(e: GitHubAPIError) -> bool:
    """Whether this is a 422 meaning another request (such as the PR's Closes auto-close) closed it at the same time"""
    return (
        e.status_code == 422
        and e.response_body is not None
        and "closed by another request" in e.response_body
    )


def _delete_merged_branch(
    out: Output, client: GitHubClient, owner: str, repo: str, head_branch: str
) -> None:
    """Delete the head branch and then the WIP branch (plans only the head in dry-run)

    If the head is already gone (such as GitHub's auto-delete), the WIP branch is still tried.
    A failure other than a missing ref skips the WIP branch.
    """
    op = Operation(Verb.DELETE, f"remote branch {head_branch}")
    out.planned(op)
    if out.dry_run:
        return
    try:
        client.delete_branch(owner, repo, head_branch)
        out.done(op)
    except GitHubAPIError as e:
        if not is_missing_ref_error(e):
            out.warning(f"deleting remote branch {head_branch} failed: {describe_api_error(e)}")
            return
        out.done(Operation(Verb.UNCHANGED, f"remote branch {head_branch} (already deleted)"))
    wip_branch = f"wip/{head_branch}"
    try:
        client.delete_branch(owner, repo, wip_branch)
        out.done(Operation(Verb.DELETE, f"remote branch {wip_branch}"))
    except GitHubAPIError:
        pass  # The WIP branch usually does not exist.


def _remove_active_flags(out: Output) -> None:
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
        out.warning(f"removing flag files failed: {e}")


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
    out = Output(dry_run)

    config = load_active_config()
    if config is None:
        out.error("no active project")
        raise typer.Exit(1)

    try:
        base = _resolve_base_repo(ctx)
        ref = parse_pr_ref(pr_ref, base_repo=base, repo_flag=True)
    except RefParseError as e:
        out.error(e.message)
        raise typer.Exit(2) from None

    owner, repo, pr_number = ref.repo.owner, ref.repo.repo, ref.number

    client, pr = _fetch_pr_for_cleanup(config, owner, repo, pr_number, out)
    _require_merged(pr, pr_number, out)

    closing_issue_numbers = _collect_closing_issue_numbers(pr)
    epic_protected_numbers = _find_epic_protected_numbers(
        client, owner, repo, closing_issue_numbers, out
    )
    closing_issue_numbers -= epic_protected_numbers
    head_branch = pr["head_ref"]

    out.count("Issues to close", len(closing_issue_numbers))
    _close_related_issues(out, client, owner, repo, closing_issue_numbers, epic_protected_numbers)
    if delete_branch:
        _delete_merged_branch(out, client, owner, repo, head_branch)
    if skip_local_cleanup:
        return
    _local_cleanup_after_merge(head_branch, config, owner, repo, out)
    if not dry_run:
        _remove_active_flags(out)
        consume_flag(FLAG_MERGE_SLASH_PENDING)
