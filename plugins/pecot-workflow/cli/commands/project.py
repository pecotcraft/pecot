"""cli/project.py - プロジェクト関連コマンド実装

project サブコマンドグループを定義する。
対象は list / search / init / create / info / activate / set-repo。
ほかに set-aggregation-repo / unset-aggregation-repo / show-aggregation-repo がある。
"""

from __future__ import annotations

import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, NoReturn, cast

import typer

from cli.commands.options import RepoOption
from cli.core.config import (
    FieldOptions,
    Package,
    Project,
    ProjectConfig,
    ProjectFields,
    Repository,
    get_active_config_path,
    get_projects_dir,
    load_active_config,
    load_config,
    save_config,
    set_active_config,
)
from cli.core.dependabot import (
    DependabotAlertError,
    DependabotAlertStatus,
    fetch_dependabot_alert_status,
)
from cli.core.github import GitHubAPIError, GitHubClient

_AGGREGATION_REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
# Dependabot alert 取得の並列数の上限（GitHub の同時リクエスト制限 100 より十分小さい）
_ALERT_FETCH_MAX_WORKERS = 8


def project_list() -> None:
    """利用可能なプロジェクト一覧を表示

    config/projects/ 配下の設定ファイルを列挙し、
    アクティブなプロジェクトには [ACTIVE] マーカーを付ける。
    """
    typer.echo("=== 利用可能なプロジェクト ===")

    projects_dir = get_projects_dir()
    active_config_path = get_active_config_path()

    # 設定ファイルを列挙
    config_files = sorted(projects_dir.glob("*.json"))

    if not config_files:
        typer.echo("  (プロジェクト設定がありません)")
        return

    for config_file in config_files:
        project_name = config_file.stem
        active_marker = ""
        if active_config_path and config_file.resolve() == active_config_path.resolve():
            active_marker = " [ACTIVE]"
        typer.echo(f"  {project_name}{active_marker}")


def _link_project_repository(
    host: str, project_number: int, owner: str, repo: str
) -> tuple[bool, str]:
    """GitHub Projectにリポジトリをリンク

    GraphQL APIを使用してプロジェクトにリポジトリをリンクする。

    Args:
        host: GitHubホスト
        project_number: プロジェクト番号
        owner: プロジェクトオーナー
        repo: owner/repo形式のリポジトリ名

    Returns:
        (成功フラグ, メッセージ) のタプル。
        成功時: (True, "リンク成功メッセージ")。
        既にリンク済み: (True, "既にリンク済みメッセージ")。
        失敗時: (False, "エラーメッセージ")。
    """
    # owner/repo形式からowner, repoを分離
    if "/" in repo:
        repo_owner, repo_name = repo.split("/", 1)
    else:
        repo_owner = owner
        repo_name = repo

    try:
        client = GitHubClient(host=host)
        return client.link_repository_to_project(owner, project_number, repo_owner, repo_name)
    except GitHubAPIError as e:
        return (False, f"リンクに失敗しました: {e.message}")


def _validate_release_type(release_type: str | None) -> None:
    """--release-type 検証（single / multi / nx 以外は exit 1）"""
    valid_release_types = {"single", "multi", "nx"}
    if release_type is not None and release_type not in valid_release_types:
        typer.echo(
            f"エラー: --release-type は {sorted(valid_release_types)} から選んでください "
            f"(指定値: {repr(release_type)})",
            err=True,
        )
        raise typer.Exit(1)


def _parse_package_specs(
    package: list[str] | None, changelog_file: str | None, clear_packages: bool
) -> list[Package] | None:
    """--package パース・検証（未指定なら None）"""
    if not package:
        return None
    if changelog_file is not None:
        typer.echo(
            "エラー: --package と --changelog-file は同時指定できません",
            err=True,
        )
        raise typer.Exit(1)
    if clear_packages:
        typer.echo(
            "エラー: --package と --clear-packages は同時指定できません",
            err=True,
        )
        raise typer.Exit(1)

    parsed_packages: list[Package] = []
    seen_names: set[str] = set()
    for spec in package:
        if ":" not in spec:
            typer.echo(
                f"エラー: --package は NAME:PATH 形式で指定してください: {repr(spec)}",
                err=True,
            )
            raise typer.Exit(1)
        name, _, path = spec.partition(":")
        name = name.strip()
        path = path.strip()
        if not name or not path:
            typer.echo(
                f"エラー: --package の NAME と PATH は空にできません: {repr(spec)}",
                err=True,
            )
            raise typer.Exit(1)
        if name in seen_names:
            typer.echo(
                f"エラー: --package の NAME が重複しています: {repr(name)}",
                err=True,
            )
            raise typer.Exit(1)
        seen_names.add(name)
        parsed_packages.append(Package(name=name, changelog=path))
    return parsed_packages


def _parse_set_repo_target(owner_repo: str, config: ProjectConfig) -> tuple[str, str]:
    """owner/repo 形式とプロジェクトオーナー一致を検証して (owner, repo_name) を返す"""
    # owner/repo形式の検証
    if "/" not in owner_repo or owner_repo.count("/") != 1:
        typer.echo("エラー: 引数は owner/repo 形式で指定してください", err=True)
        typer.echo("例: pecot project set-repo example-org/my-repo", err=True)
        raise typer.Exit(1)

    owner, repo_name = owner_repo.split("/")

    # オーナーチェック
    if owner != config.owner:
        typer.echo(
            f"エラー: リポジトリオーナー({owner})が"
            f"プロジェクトオーナー({config.owner})と異なります",
            err=True,
        )
        typer.echo("GitHub Projects V2は同一オーナーのリポジトリのみリンク可能です", err=True)
        raise typer.Exit(1)
    return owner, repo_name


def _link_repository_or_exit(config: ProjectConfig, owner_repo: str) -> None:
    """新規リポジトリを GitHub Project にリンクする（失敗は exit 1）"""
    typer.echo(f"GitHub Projectにリポジトリをリンク中: {owner_repo}")
    success, message = _link_project_repository(
        config.host, config.project.number, config.owner, owner_repo
    )
    typer.echo(message)
    if not success:
        raise typer.Exit(1)


def _load_set_repo_context(owner_repo: str) -> tuple[ProjectConfig, str, str, Path]:
    """アクティブ設定・(owner, repo_name)・設定ファイルパスを取得（取れなければ exit 1）"""
    # アクティブ設定確認
    config = load_active_config()
    if config is None:
        typer.echo("アクティブなプロジェクトがありません", err=True)
        typer.echo("ヒント: pecot project activate <PROJECT> でプロジェクトを設定", err=True)
        raise typer.Exit(1)

    # owner/repo形式とオーナーの検証
    owner, repo_name = _parse_set_repo_target(owner_repo, config)

    # 設定ファイルパス取得
    config_path = get_active_config_path()
    if config_path is None:
        typer.echo("エラー: 設定ファイルパスを取得できません", err=True)
        raise typer.Exit(1)
    return config, owner, repo_name, config_path


def _update_existing_repository(
    existing_repo: Repository,
    develop_branch: str | None,
    release_branch: str | None,
    changelog_file: str | None,
    parsed_packages: list[Package] | None,
    clear_packages: bool,
    release_type: str | None,
) -> None:
    """既存エントリの更新（明示的に指定された場合のみ）"""
    if develop_branch is not None:
        existing_repo.develop_branch = develop_branch
    if release_branch is not None:
        existing_repo.release_branch = release_branch
    if parsed_packages is not None:
        # --package 指定時は packages を置換、排他の changelog_file をクリア
        existing_repo.packages = parsed_packages
        existing_repo.changelog_file = None
    elif clear_packages:
        existing_repo.packages = None
    if changelog_file is not None:
        if existing_repo.packages:
            typer.echo(
                "エラー: このリポジトリには packages が設定されています。"
                "--changelog-file に切り替えるには先に --clear-packages を実行してください",
                err=True,
            )
            raise typer.Exit(1)
        existing_repo.changelog_file = changelog_file
    if release_type is not None:
        existing_repo.release_type = release_type  # type: ignore[assignment]


def project_set_repo(
    owner_repo: str = typer.Argument(..., help="owner/repo形式のリポジトリ名"),
    develop_branch: str | None = typer.Option(
        None, "--develop-branch", "-b", help="開発ブランチ名"
    ),
    release_branch: str | None = typer.Option(None, "--release-branch", help="リリースブランチ名"),
    changelog_file: str | None = typer.Option(None, "--changelog-file", help="CHANGELOGファイル名"),
    package: list[str] | None = typer.Option(  # noqa: B008
        None,
        "--package",
        help=(
            "monorepo の package 登録。NAME:PATH 形式で指定。複数回指定可。"
            "例: --package pecot:plugins/pecot-workflow/CHANGELOG.md"
        ),
    ),
    clear_packages: bool = typer.Option(
        False,
        "--clear-packages",
        help=(
            "既存の packages 設定をクリア。"
            "clear 後の CHANGELOG は --changelog-file または CHANGELOG.md デフォルトに戻る"
        ),
    ),
    release_type: str | None = typer.Option(
        None,
        "--release-type",
        help=(
            "リリース方式を明示宣言。w-release スキルがこの値で進め方を選ぶ。"
            "single (1 CHANGELOG) / multi (packages 方式) / nx (Nx Release 方式)。"
            "未指定 (None) なら packages 有無から自動推測 (有→multi、無→single)"
        ),
    ),
) -> None:
    """リポジトリをプロジェクト設定に追加/更新

    GitHub Projectにリポジトリをリンクし、設定ファイルに登録する。
    リンクに成功した場合のみ設定ファイルを更新する。
    既存リポジトリの場合はdevelop_branch/release_branchを更新する。

    GitHub Projects V2は同一オーナーのリポジトリのみリンク可能なため、
    リポジトリオーナーとプロジェクトオーナーの一致を確認する。

    monorepo 構成（1 リポ複数 CHANGELOG）の場合は ``--package NAME:PATH`` を
    複数回指定して packages を登録する。``--package`` と ``--changelog-file``
    は排他。
    """
    # --release-type 検証
    _validate_release_type(release_type)

    # --package パース・検証
    parsed_packages = _parse_package_specs(package, changelog_file, clear_packages)

    # アクティブ設定確認・owner/repo 検証・設定ファイルパス取得
    config, owner, repo_name, config_path = _load_set_repo_context(owner_repo)

    # 既存リポジトリかどうか確認
    existing_repo = config.find_repository(owner, repo_name)

    # 新規の場合はGitHub Projectにリンク
    if not existing_repo:
        _link_repository_or_exit(config, owner_repo)

        # リンクが成功したら設定へ追加する
        new_repo = Repository(
            owner=owner,
            name=repo_name,
            develop_branch=develop_branch,
            release_branch=release_branch,
            changelog_file=changelog_file if parsed_packages is None else None,
            packages=parsed_packages,
            release_type=release_type,  # type: ignore[arg-type]
        )
        config.repositories.append(new_repo)
        typer.echo(f"新規リポジトリを追加しました: {owner}/{repo_name}")
    else:
        _update_existing_repository(
            existing_repo,
            develop_branch,
            release_branch,
            changelog_file,
            parsed_packages,
            clear_packages,
            release_type,
        )
        typer.echo(f"{owner}/{repo_name} の設定を更新しました")

    # 設定保存
    save_config(config, config_path)
    typer.echo(f"設定ファイルを更新: {config_path}")


# aggregation_repo 管理コマンド (FR-017-019)


def _load_active_config_with_path() -> tuple[ProjectConfig, Path]:
    """アクティブ設定とそのパスを取得 (両方無ければ exit 1)。

    Returns:
        ``(config, config_path)``
    """
    config = load_active_config()
    if config is None:
        typer.echo("アクティブなプロジェクトがありません", err=True)
        typer.echo("ヒント: pecot project activate <PROJECT> でプロジェクトを設定", err=True)
        raise typer.Exit(1)

    config_path = get_active_config_path()
    if config_path is None:
        typer.echo("エラー: 設定ファイルパスを取得できません", err=True)
        raise typer.Exit(1)

    return config, config_path


def set_aggregation_repo_command(
    value: str = typer.Argument(..., help="集約リポジトリ (owner/repo 形式)"),
    yes: bool = typer.Option(
        False,
        "--yes",
        "-y",
        help="既存値があっても確認せずに上書き (警告は stderr に出力)",
    ),
) -> None:
    """Epic 集約リポジトリ (``aggregation_repo``) を設定

    ``pecot issue create --type epic`` の作成先として使われる。
    既存値を上書きする場合は常に stderr に警告を出し、``--yes`` が無ければ
    確認用ヒント行も併せて出力する (``--yes`` 時はヒントのみ抑制)。
    """
    if not _AGGREGATION_REPO_PATTERN.fullmatch(value):
        typer.echo(
            f"エラー: aggregation_repo は 'owner/repo' 形式で指定してください: {repr(value)}",
            err=True,
        )
        raise typer.Exit(1)

    config, config_path = _load_active_config_with_path()

    if config.aggregation_repo and config.aggregation_repo != value:
        typer.echo(
            f"警告: aggregation_repo を上書きします: {config.aggregation_repo} → {value}",
            err=True,
        )
        if not yes:
            typer.echo("       上書きを抑制するには --yes を付けてください", err=True)

    config.aggregation_repo = value
    save_config(config, config_path)
    typer.echo(f"aggregation_repo を設定しました: {value}")


def unset_aggregation_repo_command() -> None:
    """Epic 集約リポジトリ (``aggregation_repo``) をクリア"""
    config, config_path = _load_active_config_with_path()

    if config.aggregation_repo is None:
        typer.echo("aggregation_repo は未設定です")
        return

    previous = config.aggregation_repo
    config.aggregation_repo = None
    save_config(config, config_path)
    typer.echo(f"aggregation_repo をクリアしました (以前の値: {previous})")


def show_aggregation_repo_command() -> None:
    """Epic 集約リポジトリ (``aggregation_repo``) を表示"""
    config = load_active_config()
    if config is None:
        typer.echo("アクティブなプロジェクトがありません", err=True)
        raise typer.Exit(1)

    if config.aggregation_repo is None:
        typer.echo("未設定")
    else:
        typer.echo(config.aggregation_repo)


# project サブコマンドグループ


def _slugify(text: str) -> str:
    """テキストをファイル名用にslug化

    Args:
        text: 変換するテキスト

    Returns:
        slug化されたテキスト

    Example:
        >>> _slugify("AI Starter Kit Development")
        'ai-starter-kit-development'
    """
    slug = text.lower().replace(" ", "-")
    slug = re.sub(r"[^a-z0-9-]", "", slug)
    return slug


def search_github_projects(
    owner: str = typer.Argument(..., help="プロジェクトオーナー"),
    host: str = typer.Option("github.com", "--host", "-h", help="GitHubホスト"),
) -> None:
    """GitHub APIでプロジェクトを検索

    指定されたオーナーのGitHub Projects V2一覧を表示する。
    user/organization両対応。
    """
    try:
        client = GitHubClient(host=host)
        projects = client.list_projects(owner)

        if not projects:
            typer.echo(f"{owner} のプロジェクトが見つかりません", err=True)
            raise typer.Exit(1)

        typer.echo(f"=== {owner} のプロジェクト一覧 ({host}) ===")
        typer.echo()
        typer.echo(f"{'#':<4} {'タイトル':<40} URL")
        typer.echo("-" * 80)

        for project in projects:
            number = project.get("number", "?")
            title = project.get("title", "(無題)")
            url = project.get("url", "")
            # タイトルが長い場合は省略
            if len(title) > 38:
                title = title[:35] + "..."
            typer.echo(f"{number:<4} {title:<40} {url}")

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None


_WORKFLOW_FIELD_PREFIX = "pecot-workflow-"


def _extract_workflow_suffix(field_name: str) -> str:
    """ワークフローフィールド名からサフィックスを抽出

    "pecot-workflow-xxx" 形式 → "xxx"

    Args:
        field_name: フィールド名（例: "pecot-workflow-abc"）

    Returns:
        サフィックス部分（例: "abc"）

    Raises:
        ValueError: "pecot-workflow-" プレフィックスで始まらない場合
    """
    if field_name.startswith(_WORKFLOW_FIELD_PREFIX):
        return field_name[len(_WORKFLOW_FIELD_PREFIX) :]
    msg = f"Invalid workflow field name: {field_name} (must start with '{_WORKFLOW_FIELD_PREFIX}')"
    raise ValueError(msg)


def _is_workflow_field(field_name: str) -> bool:
    """ワークフローフィールド名かどうかを判定

    "pecot-workflow-{suffix}" 形式のみに対応。

    Args:
        field_name: フィールド名

    Returns:
        ワークフローフィールドの場合True
    """
    return field_name.startswith(_WORKFLOW_FIELD_PREFIX)


def _validate_workflow_field(
    fields: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, list[str]]:
    """Workflowフィールドを検証

    pecot-workflow準拠のプロジェクトかどうかを確認する。
    Workflowフィールドには次のオプションが必要。
    Backlog / Pending / Ready / Active / In Review / Archived。
    "pecot-workflow-{suffix}" 形式に対応する。

    Args:
        fields: プロジェクトのフィールド一覧

    Returns:
        (Workflowフィールド, 不足オプションリスト) のタプル
        Workflowフィールドがない場合は (None, [])
    """
    required_options = {"Backlog", "Pending", "Ready", "Active", "In Review", "Archived"}

    for field in fields:
        field_name = str(field.get("name", ""))
        if _is_workflow_field(field_name) and "options" in field:
            options: list[dict[str, Any]] = field.get("options", [])
            existing_options = {opt.get("name") for opt in options}
            missing = required_options - existing_options
            return (field, list(missing))

    return (None, [])


def _find_project_by_title(client: GitHubClient, owner: str, name: str) -> dict[str, Any]:
    """1. プロジェクト一覧からタイトル一致のプロジェクトを返す（無ければ一覧を出して exit 1）"""
    typer.echo(f"プロジェクト情報を取得中: {owner}/{name}")
    projects = client.list_projects(owner)

    for p in projects:
        if p.get("title") == name:
            return p

    typer.echo(f"プロジェクトが見つかりません: {name}", err=True)
    typer.echo()
    typer.echo("利用可能なプロジェクト:")
    for p in projects:
        typer.echo(f"  - {p.get('title')}")
    raise typer.Exit(1)


def _fetch_validated_fields(
    client: GitHubClient, owner: str, name: str, host: str, project_number: int
) -> tuple[dict[str, Any], list[dict[str, Any]], int | None]:
    """2〜3. フィールド情報を取得し Workflow フィールドを検証して
    (workflow_field, fields, view_number) を返す。view_number は先頭ビューの番号（無ければ None）"""
    typer.echo("フィールド情報を取得中...")
    project_info = client.get_project_fields(owner, project_number)

    if not project_info:
        typer.echo("プロジェクト情報の取得に失敗しました", err=True)
        raise typer.Exit(1)

    fields: list[dict[str, Any]] = project_info.get("fields", {}).get("nodes", [])

    workflow_field, missing_options = _validate_workflow_field(fields)

    if not workflow_field:
        typer.echo(f"プロジェクト「{name}」にpecot-workflow-*フィールドがありません", err=True)
        typer.echo()
        typer.echo("pecot-workflowでは以下のフィールドが必要です:")
        typer.echo("  - pecot-workflow-<suffix> (Backlog/Pending/Ready/Active/In Review/Archived)")
        typer.echo()
        typer.echo("解決方法:")
        typer.echo(f'  pecot project init --host {host} --suffix <suffix> {owner} "{name}"')
        raise typer.Exit(1)

    if missing_options:
        typer.echo(
            f"pecot-workflowフィールドに必要なオプションがありません: {', '.join(missing_options)}",
            err=True,
        )
        typer.echo()
        typer.echo("必要なオプション: Backlog / Pending / Ready / Active / In Review / Archived")
        raise typer.Exit(1)
    views: dict[str, Any] = project_info.get("views") or {}
    view_nodes: list[dict[str, Any]] = views.get("nodes") or []
    view_number: int | None = None
    if view_nodes:
        view_number = cast("int | None", view_nodes[0].get("number"))
    return workflow_field, fields, view_number


def _load_existing_repo_meta(config_path: Path) -> tuple[dict[str, Repository], str | None]:
    """5. 既存設定からリポ単位のメタデータと aggregation_repo を取り出す"""
    existing_repo_meta: dict[str, Repository] = {}
    existing_aggregation_repo: str | None = None

    if config_path.exists():
        existing_config = load_config(config_path)
        if existing_config:
            for repo in existing_config.repositories:
                existing_repo_meta[f"{repo.owner}/{repo.name}"] = repo
            existing_aggregation_repo = existing_config.aggregation_repo
    return existing_repo_meta, existing_aggregation_repo


def _build_repositories(
    linked_repos: list[dict[str, Any]], existing_repo_meta: dict[str, Repository]
) -> list[Repository]:
    """6. リンク済みリポジトリに既存のリポ単位メタデータを引き継いだ Repository 一覧

    並びは既存設定の順を先頭にし、リンクされていないものは落とし、新規は linked_repos の順で末尾に足す。
    """
    linked_by_key: dict[str, dict[str, Any]] = {}
    for linked_repo in linked_repos:
        key = f"{linked_repo.get('owner', '')}/{linked_repo.get('name', '')}"
        linked_by_key.setdefault(key, linked_repo)

    ordered_keys = [k for k in existing_repo_meta if k in linked_by_key]
    ordered_keys += [k for k in linked_by_key if k not in existing_repo_meta]

    repositories: list[Repository] = []
    for key in ordered_keys:
        linked_repo = linked_by_key[key]
        prev = existing_repo_meta.get(key)
        repositories.append(
            Repository(
                owner=linked_repo.get("owner", ""),
                name=linked_repo.get("name", ""),
                develop_branch=prev.develop_branch if prev else None,
                release_branch=prev.release_branch if prev else None,
                changelog_file=prev.changelog_file if prev else None,
                packages=prev.packages if prev else None,
                release_type=prev.release_type if prev else None,
            )
        )
    return repositories


def _field_options_config(field: dict[str, Any], keys: dict[str, str]) -> FieldOptions:
    """フィールドのオプション ID を設定キーに対応付けた FieldOptions（keys は 設定キー→小文字名）"""
    field_options: list[dict[str, Any]] = field.get("options", [])
    options_by_name = {opt["name"].lower(): opt["id"] for opt in field_options}
    return FieldOptions(
        id=field["id"],
        options={key: options_by_name.get(label, "") for key, label in keys.items()},
    )


def _build_project_fields(
    workflow_field: dict[str, Any], fields: list[dict[str, Any]]
) -> ProjectFields:
    """4・7・8. Workflow / pecot-priority / pecot-size のフィールド構造を構築"""
    # pecot-priority/pecot-size フィールドを取得（存在する場合のみ）
    priority_field = None
    size_field = None
    for field in fields:
        if field.get("name") == "pecot-priority" and "options" in field:
            priority_field = field
        elif field.get("name") == "pecot-size" and "options" in field:
            size_field = field

    workflow_keys = {
        "backlog": "backlog",
        "pending": "pending",
        "ready": "ready",
        "active": "active",
        "in_review": "in review",
        "archived": "archived",
    }
    priority_keys = {"high": "high", "medium": "medium", "low": "low"}
    size_keys = {"xs": "xs", "s": "s", "m": "m", "l": "l"}
    return ProjectFields(
        workflow=_field_options_config(workflow_field, workflow_keys),
        priority=_field_options_config(priority_field, priority_keys) if priority_field else None,
        size=_field_options_config(size_field, size_keys) if size_field else None,
    )


def _build_board_url(
    project_url: str, workflow_field: dict[str, Any], view_number: int | None
) -> str:
    """9. ボードURL構築（Workflowフィールドでグループ化）

    GitHub API が返すプロジェクト URL・フィールドの databaseId・先頭ビュー番号を使う。
    databaseId かビュー番号が取れないときは layout を付けない。
    """
    workflow_db_id = workflow_field.get("databaseId")

    # filterQuery: ワークフローフィールドのステータス値でフィルタ（"No value"カラム非表示）
    # スペース入りの値（"In Review"）を末尾に配置してURLパースエラーを回避
    workflow_field_name = workflow_field["name"]
    filter_values = sorted(
        (opt["name"] for opt in WORKFLOW_FIELD_OPTIONS),
        key=lambda v: " " in v,
    )
    status_values = ",".join(f'"{v}"' if " " in v else v for v in filter_values)
    filter_query = urllib.parse.quote(f" {workflow_field_name}:{status_values}")

    if workflow_db_id and view_number:
        return (
            f"{project_url}/views/{view_number}"
            f"?layout=board&verticalGroupedBy%5BcolumnId%5D={workflow_db_id}"
            f"&filterQuery={filter_query}"
        )
    return f"{project_url}?filterQuery={filter_query}"


def _sync_project_config(
    client: GitHubClient,
    owner: str,
    name: str,
    host: str,
) -> Path:
    """プロジェクト設定ファイルを生成・更新

    GitHub Projects V2から情報を取得し、ローカル設定ファイルを生成する。
    pecot-workflow準拠（Workflowフィールド必須）のプロジェクトのみ対応。

    Args:
        client: GitHubClient インスタンス
        owner: プロジェクトオーナー
        name: プロジェクトタイトル
        host: GitHubホスト

    Returns:
        生成した設定ファイルのパス

    Raises:
        typer.Exit: プロジェクトが見つからない、またはpecot-workflow非準拠の場合
    """
    # 1. プロジェクト一覧から番号を取得
    target_project = _find_project_by_title(client, owner, name)
    project_number = target_project["number"]
    project_id = target_project["id"]

    # 2〜3. フィールド情報を取得し Workflow フィールドを検証
    workflow_field, fields, view_number = _fetch_validated_fields(
        client, owner, name, host, project_number
    )

    # 5. 既存設定からリポ単位のメタデータを保持
    # （develop_branch / release_branch / changelog_file / packages / release_type）
    workflow_suffix = _extract_workflow_suffix(workflow_field["name"])
    project_slug = _slugify(name)
    config_path = get_projects_dir() / f"{host}_{owner}_{project_slug}_{workflow_suffix}.json"
    existing_repo_meta, existing_aggregation_repo = _load_existing_repo_meta(config_path)

    # 6. リンク済みリポジトリを取得
    typer.echo("リンク済みリポジトリを取得中...")
    linked_repos = client.get_linked_repositories(owner, project_number)
    repositories = _build_repositories(linked_repos, existing_repo_meta)

    # 10. 設定オブジェクト作成（4・7・8 フィールド構造、9 ボードURL）
    project_config = ProjectConfig(
        host=host,
        owner=owner,
        workflow_suffix=workflow_suffix,
        project=Project(
            number=project_number,
            id=project_id,
            board_url=_build_board_url(target_project.get("url", ""), workflow_field, view_number),
            fields=_build_project_fields(workflow_field, fields),
        ),
        repositories=repositories,
        aggregation_repo=existing_aggregation_repo,
    )

    # 11. 設定ファイル保存
    save_config(project_config, config_path)
    typer.echo(f"設定ファイルを生成しました: {config_path}")

    # 12. アクティベート
    set_active_config(config_path)
    typer.echo("生成した設定をアクティベートしました")

    return config_path


# pecot-workflow フィールドのオプション定義
WORKFLOW_FIELD_OPTIONS = [
    {
        "name": "Pending",
        "color": "GRAY",
        "description": (
            "Items on hold (Epic or Task). Moved from Ready/Backlog when deprioritized or blocked."
        ),
    },
    {
        "name": "Backlog",
        "color": "RED",
        "description": (
            "Items waiting to be planned."
            " Not for direct work - break down into smaller tasks first."
        ),
    },
    {
        "name": "Ready",
        "color": "GREEN",
        "description": (
            "Tasks ready for implementation. AI agent picks from here and moves to Active on start."
        ),
    },
    {
        "name": "Active",
        "color": "BLUE",
        "description": (
            "Currently being worked on."
            " One active task per worktree - track progress and updates here."
        ),
    },
    {
        "name": "In Review",
        "color": "YELLOW",
        "description": (
            "Pull request created and waiting for review."
            " Moves to Archived after merge is completed."
        ),
    },
    {
        "name": "Archived",
        "color": "PURPLE",
        "description": (
            "Storage for completed or cancelled items."
            " Moved here after issue is closed or no longer needed."
        ),
    },
]

# pecot-priority フィールドのオプション定義
PRIORITY_FIELD_OPTIONS = [
    {"name": "High", "color": "RED", "description": "優先度: 高"},
    {"name": "Medium", "color": "YELLOW", "description": "優先度: 中"},
    {"name": "Low", "color": "GREEN", "description": "優先度: 低"},
]

# pecot-size フィールドのオプション定義
SIZE_FIELD_OPTIONS = [
    {"name": "XS", "color": "GREEN", "description": "サイズ: 極小"},
    {"name": "S", "color": "BLUE", "description": "サイズ: 小"},
    {"name": "M", "color": "YELLOW", "description": "サイズ: 中"},
    {"name": "L", "color": "RED", "description": "サイズ: 大"},
]


def _has_field(fields: list[dict[str, Any]], field_name: str) -> bool:
    """指定名のフィールドが存在するかチェック

    Args:
        fields: プロジェクトのフィールド一覧
        field_name: 検索するフィールド名

    Returns:
        指定名のフィールドが存在すればTrue
    """
    for field in fields:
        if field.get("name") == field_name:
            return True
    return False


def init(
    owner: str = typer.Argument(..., help="プロジェクトオーナー"),
    name: str = typer.Argument(..., help="プロジェクトタイトル"),
    host: str = typer.Option("github.com", "--host", "-h", help="GitHubホスト"),
    suffix: str = typer.Option(..., "--suffix", "-s", help="ワークフローフィールドのサフィックス"),
) -> None:
    """既存プロジェクトにpecot-workflow関連フィールドを追加

    pecot-workflow準拠のプロジェクトにするため、以下のフィールドを追加する。
    - pecot-workflow-<suffix>: Backlog/Pending/Ready/Active/In Review/Archived
    - pecot-priority: High/Medium/Low
    - pecot-size: XS/S/M/L

    既にフィールドが存在する場合は個別にスキップする。
    """
    try:
        client = GitHubClient(host=host)

        # 1. プロジェクト一覧から対象を検索
        typer.echo(f"プロジェクト情報を取得中: {owner}/{name}")
        projects = client.list_projects(owner)

        target_project = None
        for p in projects:
            if p.get("title") == name:
                target_project = p
                break

        if not target_project:
            typer.echo(f"プロジェクトが見つかりません: {name}", err=True)
            typer.echo()
            typer.echo("利用可能なプロジェクト:")
            for p in projects:
                typer.echo(f"  - {p.get('title')}")
            raise typer.Exit(1)

        project_id = target_project["id"]
        project_number = target_project["number"]

        # 2. フィールド情報を取得
        typer.echo("フィールド情報を取得中...")
        project_info = client.get_project_fields(owner, project_number)

        if not project_info:
            typer.echo("プロジェクト情報の取得に失敗しました", err=True)
            raise typer.Exit(1)

        fields = project_info.get("fields", {}).get("nodes", [])

        # 3. 各フィールドを作成（既存ならスキップ）
        workflow_field_name = f"pecot-workflow-{suffix}"
        fields_to_create = [
            (workflow_field_name, WORKFLOW_FIELD_OPTIONS),
            ("pecot-priority", PRIORITY_FIELD_OPTIONS),
            ("pecot-size", SIZE_FIELD_OPTIONS),
        ]

        created_count = 0
        for field_name, field_options in fields_to_create:
            if _has_field(fields, field_name):
                typer.echo(f"{field_name}フィールドは既に存在します。スキップします。")
                continue

            typer.echo(f"{field_name}フィールドを作成中...")
            result = client.create_project_field(
                project_id=project_id,
                name=field_name,
                options=field_options,
            )
            typer.echo(f"{field_name}フィールドを作成しました (ID: {result['id']})")
            created_count += 1

        if created_count > 0:
            typer.echo()
            typer.echo(f"{created_count}件のフィールドを作成しました")

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None


def create(
    owner: str = typer.Argument(..., help="プロジェクトオーナー"),
    title: str = typer.Argument(..., help="プロジェクトタイトル"),
    host: str = typer.Option("github.com", "--host", "-h", help="GitHubホスト"),
    suffix: str = typer.Option(..., "--suffix", "-s", help="ワークフローフィールドのサフィックス"),
) -> None:
    """新規プロジェクトを作成

    GitHub Projects V2を新規作成し、pecot-workflow準拠のフィールドを自動設定する。
    作成後、init（フィールド追加）とactivate（設定ファイル生成・アクティベート）を実行する。
    """
    from cli.core.github import GitHubNotFoundError

    try:
        client = GitHubClient(host=host)

        # 1. オーナーのNode IDを取得
        typer.echo(f"オーナー情報を取得中: {owner}")
        try:
            owner_id = client.get_owner_node_id(owner)
        except GitHubNotFoundError:
            typer.echo(f"オーナーが見つかりません: {owner}", err=True)
            raise typer.Exit(1) from None

        # 2. 同名プロジェクトの存在確認
        typer.echo("既存プロジェクトを確認中...")
        projects = client.list_projects(owner)
        for p in projects:
            if p.get("title") == title:
                typer.echo(f"同名のプロジェクトが既に存在します: {title}", err=True)
                typer.echo(f"URL: {p.get('url')}", err=True)
                raise typer.Exit(1)

        # 3. プロジェクト作成
        typer.echo(f"プロジェクトを作成中: {title}")
        project = client.create_project(owner_id, title)
        typer.echo(f"プロジェクトを作成しました: {project['url']}")
        typer.echo(f"  番号: {project['number']}")
        typer.echo()

        # 4. pecot-workflowフィールドを追加（init相当）
        typer.echo("pecot-workflowフィールドを追加中...")
        init(owner=owner, name=title, host=host, suffix=suffix)
        typer.echo()

        # 5. 設定ファイル生成とアクティベート
        typer.echo("設定ファイルを生成中...")
        _sync_project_config(client, owner, title, host)

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None


# activateコマンド


def _has_pecot_workflow_field(fields: list[dict[str, Any]]) -> bool:
    """pecot-workflowフィールドが存在するか確認

    "pecot-workflow-{suffix}" 形式に対応。

    Args:
        fields: プロジェクトのフィールド一覧

    Returns:
        pecot-workflowフィールドが存在すればTrue
    """
    for field in fields:
        if _is_workflow_field(field.get("name", "")):
            return True
    return False


def _list_initialized_projects(client: GitHubClient, owner: str) -> list[dict[str, Any]]:
    """init済みプロジェクト（pecot-workflowフィールドあり）を取得

    Args:
        client: GitHubClient インスタンス
        owner: プロジェクトオーナー

    Returns:
        init済みプロジェクト情報のリスト
        各プロジェクトには number, title, url, id を含む
    """
    initialized: list[dict[str, Any]] = []
    projects = client.list_projects(owner)

    for project in projects:
        project_number = project.get("number")
        if project_number is None:
            continue

        # フィールド情報を取得
        project_info = client.get_project_fields(owner, project_number)
        if not project_info:
            continue

        fields: list[dict[str, Any]] = project_info.get("fields", {}).get("nodes", [])
        if _has_pecot_workflow_field(fields):
            initialized.append(project)

    return initialized


def _find_config_file_arg(project: str) -> Path | None:
    """ステップ1: 引数を設定ファイルパス/ファイル名として解釈できればそのパスを返す"""
    # 1-1: パスとして解釈（相対/絶対パス）
    path_as_path = Path(project)
    if path_as_path.exists() and path_as_path.is_file():
        return path_as_path.resolve()

    # 1-2: ファイル名として解釈（projects/ディレクトリ内）
    # .json拡張子がない場合は追加して試す
    filename = project if project.endswith(".json") else f"{project}.json"
    path_as_filename = get_projects_dir() / filename
    if path_as_filename.exists() and path_as_filename.is_file():
        return path_as_filename
    return None


def _activate_from_config_file(config_path: Path, host: str | None) -> None:
    """設定ファイルの host/owner/number で GitHub API から最新情報を同期してアクティベート"""
    typer.echo(f"設定ファイル「{config_path.name}」から同期中...")

    try:
        # 設定ファイルを読み込んでhost/owner/numberを取得
        config = load_config(config_path)
    except Exception as e:
        typer.echo(f"設定ファイルの読み込みに失敗しました: {e}", err=True)
        raise typer.Exit(1) from None

    config_host = config.host
    config_owner = config.owner
    config_number = config.project.number

    try:
        # hostパラメータと設定ファイルのhostが一致するか確認
        if host is not None and config_host != host:
            typer.echo(
                f"警告: --host オプション ({host}) と"
                f"設定ファイルのhost ({config_host}) が一致しません",
                err=True,
            )
            typer.echo("設定ファイルのhostを使用します", err=True)

        # GitHub APIからプロジェクト情報を取得してタイトルを得る
        client = GitHubClient(host=config_host)
        project_info = client.get_project_fields(config_owner, config_number)
        if not project_info:
            typer.echo(f"プロジェクト #{config_number} が見つかりません", err=True)
            raise typer.Exit(1)

        title = project_info.get("title", "")
        if not title:
            typer.echo("プロジェクトタイトルの取得に失敗しました", err=True)
            raise typer.Exit(1)

        # GitHub APIから最新情報を同期してアクティベート
        typer.echo(f"プロジェクト「{title}」を同期中...")
        _sync_project_config(client, config_owner, title, config_host)

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None


def _exit_host_required() -> NoReturn:
    """--host 未指定時の案内を出して exit 1"""
    typer.echo("エラー: --host オプションは必須です", err=True)
    typer.echo()
    typer.echo("GitHub.com の場合:")
    typer.echo("  pecot project activate --host github.com --owner example-org")
    typer.echo()
    typer.echo("GitHub Enterprise の場合:")
    typer.echo("  pecot project activate --host ghes.example.com --owner example-org")
    typer.echo()
    typer.echo("設定ファイル名で指定する場合（--host不要）:")
    typer.echo("  pecot project activate ghes.example.com_example-org_example-project_example-org")
    raise typer.Exit(1)


def _resolve_activate_owner(client: GitHubClient, owner: str | None) -> str:
    """owner 省略時は認証ユーザーを取得"""
    if owner is not None:
        return owner
    try:
        user_info = client.get_authenticated_user()
        login = user_info.get("login")
        if not login:
            typer.echo("認証ユーザーの取得に失敗しました", err=True)
            raise typer.Exit(1)
        typer.echo(f"認証ユーザー: {login}")
    except GitHubAPIError as e:
        typer.echo(f"認証ユーザーの取得に失敗しました: {e.message}", err=True)
        typer.echo()
        typer.echo("ヒント: --owner オプションで明示的に指定してください")
        raise typer.Exit(1) from None
    return login


def _echo_initialized_projects(client: GitHubClient, host: str, owner: str) -> None:
    """一覧表示モード: init済みプロジェクトを [ACTIVE] 付きで表示"""
    typer.echo(f"=== init済みプロジェクト ({host}/{owner}) ===")
    initialized = _list_initialized_projects(client, owner)

    if not initialized:
        typer.echo("  (init済みプロジェクトがありません)")
        typer.echo()
        typer.echo("ヒント: pecot project init でプロジェクトを初期化してください")
        return

    # アクティブプロジェクトの取得
    active_config_path = get_active_config_path()
    active_project_number = None
    if active_config_path:
        try:
            active_config = load_config(active_config_path)
            if active_config.host == host and active_config.owner == owner:
                active_project_number = active_config.project.number
        except Exception:
            pass

    for proj in initialized:
        number = proj.get("number")
        title = proj.get("title", "(無題)")
        active_marker = ""
        if active_project_number == number:
            active_marker = " [ACTIVE]"
        typer.echo(f"  #{number}: {title}{active_marker}")

    typer.echo()
    typer.echo(
        "アクティベート: pecot project activate <PROJECT> --host " + host + " --owner " + owner
    )


def _fetch_project_info_by_ref(client: GitHubClient, owner: str, project: str) -> dict[str, Any]:
    """番号/名前指定のプロジェクト情報を取得（見つからなければ exit 1）"""
    if project.isdigit():
        project_number = int(project)
        typer.echo(f"プロジェクト #{project_number} を確認中...")
        # 番号で直接取得
        project_info = client.get_project_fields(owner, project_number)
        if not project_info:
            typer.echo(f"プロジェクト #{project_number} が見つかりません", err=True)
            raise typer.Exit(1)
        return project_info

    project_name = project
    typer.echo(f"プロジェクト「{project_name}」を検索中...")
    # 名前で検索
    projects = client.list_projects(owner)
    target_project = None
    for p in projects:
        if p.get("title") == project_name:
            target_project = p
            break

    if not target_project:
        typer.echo(f"プロジェクト「{project_name}」が見つかりません", err=True)
        typer.echo()
        typer.echo("利用可能なプロジェクト:")
        for p in projects:
            typer.echo(f"  - {p.get('title')}")
        raise typer.Exit(1)

    project_number = int(target_project["number"])
    project_info = client.get_project_fields(owner, project_number)
    if not project_info:
        typer.echo("プロジェクト情報の取得に失敗しました", err=True)
        raise typer.Exit(1)
    return project_info


def _activate_by_project_ref(client: GitHubClient, host: str, owner: str, project: str) -> None:
    """アクティベートモード（番号/名前検索）"""
    project_info = _fetch_project_info_by_ref(client, owner, project)
    fields = project_info.get("fields", {}).get("nodes", [])

    # init済みか確認
    if not _has_pecot_workflow_field(fields):
        title = project_info.get("title", "")
        typer.echo(
            f"プロジェクト「{title}」はinit済みではありません",
            err=True,
        )
        typer.echo()
        typer.echo("ヒント: まず以下のコマンドでプロジェクトを初期化してください:")
        typer.echo(f'  pecot project init --host {host} --suffix <suffix> {owner} "{title}"')
        raise typer.Exit(1)

    # 設定ファイルを生成/更新してアクティベート
    title = project_info.get("title", "")
    typer.echo(f"プロジェクト「{title}」をアクティベート中...")

    # _sync_project_config で設定ファイル生成＆アクティベート
    _sync_project_config(client, owner, title, host)


def project_activate(
    project: str | None = typer.Argument(
        None, help="プロジェクト番号または名前、設定ファイルパス/ファイル名"
    ),
    owner: str | None = typer.Option(
        None, "--owner", "-o", help="プロジェクトオーナー（省略時は認証ユーザー）"
    ),
    host: str | None = typer.Option(None, "--host", "-h", help="GitHubホスト"),
) -> None:
    """init済みプロジェクトをアクティベート

    引数なしの場合はinit済みプロジェクト一覧を表示。
    プロジェクト番号または名前を指定するとアクティベートする。
    設定ファイルパス/ファイル名でも指定可能（この場合--host不要）。
    --owner を省略すると認証ユーザーのプロジェクトを対象にする。

    \b
    使用例:
      pecot project activate --host github.com
          # 認証ユーザーのinit済み一覧

      pecot project activate --host github.com --owner example-org
          # owner指定でinit済み一覧

      pecot project activate 1 --host github.com --owner example-org
          # 番号で指定

      pecot project activate "Example Project" --host github.com --owner example-org
          # 名前で指定

      pecot project activate ghes.example.com_example-org_example-project_example-org
          # 設定ファイル名で指定

      pecot project activate ghes.example.com_example-org_example-project_suffix
          # パスで指定（--host不要）
    """
    # ステップ1: 設定ファイルパス/ファイル名かチェック（--host不要モード）
    if project is not None:
        config_path = _find_config_file_arg(project)
        # 設定ファイルが見つかった場合、GitHub APIから最新情報を同期してアクティベート
        if config_path is not None:
            _activate_from_config_file(config_path, host)
            return

    # ステップ2: 一覧表示/名前・番号指定モード（--host必須）
    try:
        # --host オプションのバリデーション
        if host is None:
            _exit_host_required()

        client = GitHubClient(host=host)

        # owner 省略時は認証ユーザーを取得
        owner = _resolve_activate_owner(client, owner)

        if project is None:
            # 一覧表示モード
            _echo_initialized_projects(client, host, owner)
        else:
            # アクティベートモード（番号/名前検索）
            _activate_by_project_ref(client, host, owner, project)

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        raise typer.Exit(1) from None


def _load_info_config() -> tuple[ProjectConfig, str]:
    """設定とプロジェクト名を取得（設定が無ければ exit 1）"""
    config = load_active_config()
    if config is None:
        typer.echo("エラー: アクティブなプロジェクト設定が見つかりません", err=True)
        typer.echo(
            "ヒント: pecot project activate <PROJECT> でプロジェクトを設定してください", err=True
        )
        raise typer.Exit(1)

    # プロジェクト名を取得
    config_path = get_active_config_path()
    if config_path:
        project_name = config_path.stem
    else:
        project_name = f"{config.host}_{config.owner}_{config.project.number}"
    return config, project_name


def _prune_archived_items(
    client: GitHubClient, config: ProjectConfig, all_items: list[dict[str, Any]]
) -> None:
    """Archivedアイテムを updatedAt 降順で並べ、最新20件以外をボードから削除する"""
    archived_items = [item for item in all_items if item.get("workflow") == "Archived"]
    archived_items.sort(key=lambda x: x.get("updatedAt", ""), reverse=True)

    if len(archived_items) > 20:
        items_to_delete = archived_items[20:]
        typer.echo(
            f"古いArchivedアイテムを削除中... ({len(items_to_delete)}件)",
            err=True,
        )
        deleted_count = 0
        for item in items_to_delete:
            try:
                client.delete_project_item(config.project.id, item["id"])
                deleted_count += 1
            except GitHubAPIError:
                # 削除失敗は無視して続行
                pass
        typer.echo(f"削除完了: {deleted_count}件", err=True)


def _collect_dependabot_alert_statuses(
    client: GitHubClient, config: ProjectConfig
) -> dict[str, DependabotAlertStatus | str]:
    """登録リポごとの Dependabot alert の状態を集める（キーは full_name、登録順）

    取得に失敗したリポは理由の文字列を入れる。ボード表示の用途で
    1 リポの失敗が全体を止めないよう、DependabotAlertError はここで握る。

    取得はリポ間で並列に行う。
    前提: client は 401 フォールバックが並列中に起きない状態で渡すこと
    （フォールバックは httpx クライアントを作り直すため、並列中に起きると競合する）。
    info は同じトークンで list_project_items を先に通しているため、ここで 401 は想定しない。
    """

    def fetch_one(repo_entry: Repository) -> DependabotAlertStatus | str:
        try:
            return fetch_dependabot_alert_status(
                client, config.host, repo_entry.owner, repo_entry.name
            )
        except DependabotAlertError as e:
            return str(e)

    repos = config.repositories
    # ThreadPoolExecutor の max_workers は 1 以上が必要なため、0 件はここで返す
    if not repos:
        return {}
    with ThreadPoolExecutor(max_workers=min(len(repos), _ALERT_FETCH_MAX_WORKERS)) as executor:
        results = executor.map(fetch_one, repos)
        return {
            repo_entry.full_name: status for repo_entry, status in zip(repos, results, strict=True)
        }


def _dependabot_alerts_json(status: DependabotAlertStatus | str) -> dict[str, Any]:
    if isinstance(status, str):
        return {"error": status}
    return status.model_dump()


def _dependabot_alerts_line(status: DependabotAlertStatus | str) -> str:
    if isinstance(status, str):
        return f"    dependabot_alerts: 取得失敗 ({status})"
    if not status.enabled:
        return "    dependabot_alerts: 無効"
    return f"    dependabot_alerts: open {status.open_count}"


def _info_json(
    config: ProjectConfig,
    project_name: str,
    board: dict[str, Any],
    statuses: dict[str, DependabotAlertStatus | str],
) -> dict[str, Any]:
    """info --json の出力データ"""
    return {
        "project": {
            "name": project_name,
            "host": config.host,
            "owner": config.owner,
            "number": config.project.number,
            "aggregation_repo": config.aggregation_repo,
        },
        "repositories": [
            {
                "full_name": repo_entry.full_name,
                "owner": repo_entry.owner,
                "name": repo_entry.name,
                "develop_branch": repo_entry.develop_branch,
                "release_branch": repo_entry.release_branch,
                "dependabot_alerts": _dependabot_alerts_json(statuses[repo_entry.full_name]),
            }
            for repo_entry in config.repositories
        ],
        "board": board,
    }


def _info_repository_lines(
    config: ProjectConfig, statuses: dict[str, DependabotAlertStatus | str]
) -> list[str]:
    """「登録済みリポジトリ」節の行"""
    lines: list[str] = ["## 登録済みリポジトリ"]
    if not config.repositories:
        lines.append("- (なし)")
        return lines
    for repo_entry in config.repositories:
        branch_info: list[str] = []
        if repo_entry.develop_branch:
            branch_info.append(f"develop: {repo_entry.develop_branch}")
        if repo_entry.release_branch:
            branch_info.append(f"release: {repo_entry.release_branch}")
        if branch_info:
            lines.append(f"- {repo_entry.full_name} ({', '.join(branch_info)})")
        else:
            lines.append(f"- {repo_entry.full_name}")
        lines.append(f"    release_type: {repo_entry.effective_release_type}")
        lines.append(_dependabot_alerts_line(statuses[repo_entry.full_name]))
        if repo_entry.packages:
            for pkg in repo_entry.packages:
                lines.append(f"    package: {pkg.name} → {pkg.changelog}")
        elif repo_entry.changelog_file:
            lines.append(f"    changelog: {repo_entry.changelog_file}")
    return lines


def _info_markdown(
    config: ProjectConfig,
    project_name: str,
    effective_repo: str | None,
    board_output: str,
    statuses: dict[str, DependabotAlertStatus | str],
) -> str:
    """info の Markdown 出力"""
    lines: list[str] = []

    lines.append("# プロジェクト情報")
    lines.append("")

    lines.append("## 基本情報")
    lines.append(f"- プロジェクト: {project_name}")
    lines.append(f"- Host: {config.host}")
    lines.append(f"- Owner: {config.owner}")
    if config.aggregation_repo:
        lines.append(f"- ロードマップリポ: `{config.aggregation_repo}`")
    else:
        lines.append("- ロードマップリポ: 未設定")
    lines.append("")

    lines.extend(_info_repository_lines(config, statuses))
    lines.append("")

    if effective_repo:
        lines.append(f"## ボード状況 (フィルタ: {effective_repo})")
    else:
        lines.append("## ボード状況")
    lines.append("")
    lines.append(board_output)
    return "\n".join(lines)


def info(
    ctx: typer.Context,
    json_output: bool = typer.Option(
        False,
        "--json",
        "-j",
        help="JSON形式で出力",
    ),
    repo: RepoOption = None,
) -> None:
    """プロジェクト情報ダッシュボードを表示

    アクティブなプロジェクトの総合情報を表示する。
    - プロジェクト基本情報（名前、host、owner）
    - 登録済みリポジトリ一覧（develop-branch設定含む）
    - ボード状況（デフォルトでBacklog/Ready/Activeのみ、高速表示）

    ``--repo owner/repo`` 指定時はボード items を当該リポのみに絞り込む。
    local (サブコマンド) 未指定時は global ``pecot --repo ...`` の値を採用し、
    どちらも未指定なら絞り込みを行わず全 items を表示する (FR-013)。
    """
    from cli.core.format import (
        format_board_output,
        format_items_json,
        transform_items,
    )

    raw_ctx_obj: Any = ctx.obj
    ctx_obj: dict[str, Any] = (
        cast("dict[str, Any]", raw_ctx_obj) if isinstance(raw_ctx_obj, dict) else {}
    )
    effective_repo: str | None = repo if repo is not None else ctx_obj.get("repo")

    # 設定取得（設定なしは _load_info_config が案内を出して exit する。try の外に置く）
    config, project_name = _load_info_config()

    try:
        # GitHubクライアント初期化
        client = GitHubClient(host=config.host)

        # プロジェクトボードから全アイテムを取得
        typer.echo("プロジェクト情報を取得中...", err=True)
        raw_items = client.list_project_items(
            config.project.id,
            workflow_field_name=config.workflow_field_name,
        )
        all_items = transform_items(raw_items, workflow_field_name=config.workflow_field_name)

        # 登録リポの Dependabot alert の状態（取得失敗はコマンドを止めず行に出す）
        alert_statuses = _collect_dependabot_alert_statuses(client, config)

        # 最新20件以外のArchivedアイテムを削除
        _prune_archived_items(client, config, all_items)

        # OPENなIssueのみをフィルタリングしてActive/In Review/Ready/Backlogを抽出
        target_statuses = {"Backlog", "Pending", "Ready", "Active", "In Review"}
        items = [
            item
            for item in all_items
            if item["content"].get("state") == "OPEN" and item.get("workflow") in target_statuses
        ]

        if effective_repo:
            items = [i for i in items if i["content"].get("repository") == effective_repo]

        # 出力
        if json_output:
            # JSON形式
            output_data = _info_json(config, project_name, format_items_json(items), alert_statuses)
            import json

            typer.echo(json.dumps(output_data, ensure_ascii=False, indent=2))
        else:
            # Markdown形式
            typer.echo(
                _info_markdown(
                    config,
                    project_name,
                    effective_repo,
                    format_board_output(items),
                    alert_statuses,
                )
            )

    except GitHubAPIError as e:
        typer.echo(f"GitHub APIエラー: {e.message}", err=True)
        if e.status_code:
            typer.echo(f"ステータスコード: {e.status_code}", err=True)
        raise typer.Exit(1) from None
    except Exception as e:
        typer.echo(f"予期しないエラー: {e}", err=True)
        raise typer.Exit(1) from None
