"""tests/conftest.py - pytest共通フィクスチャとヘルパー

全テストで共有されるフィクスチャとユーティリティ関数を定義。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, Mock, patch

import pytest

# グローバル環境隔離（pre-push フック配下の GIT_* リーク対策）
# pre-push 配下で pytest を動かすと、親 git が GIT_DIR 等を export している。
# 本体コードの subprocess.run (core/worktree.py 等) や CliRunner 経由の処理がそれを継承する。
# 継承すると実リポに書き込んでしまう。
# #178 の _git 個別対策だけでは本体コードを守れない。
# そのため全テストで autouse で剥がす。

_GIT_ENV_LEAK_KEYS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
)


@pytest.fixture(autouse=True)
def _isolate_git_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in _GIT_ENV_LEAK_KEYS:
        monkeypatch.delenv(key, raising=False)


# プラグインのデータ置き場の隔離（#1230）
# 開発者の Claude セッションの子として動くと、クライアントが渡した CLAUDE_PLUGIN_DATA を継承する。
# そのままだと bin/pecot 経由のテストが導入先の置き場を読み書きし、変数を外しただけでは既定の場所
# （~/.local/share/pecot/pecot-workflow）に書く。全テストで CLAUDE_PLUGIN_DATA を一時ディレクトリへ向け、
# PLUGIN_DATA は外す。XDG_DATA_HOME は付け替えない（uv の Python の置き場まで動くため）。
# 既定の場所を確かめるテストだけが、CLAUDE_PLUGIN_DATA を外して XDG_DATA_HOME / HOME を子プロセスに渡す。


@pytest.fixture(autouse=True)
def _isolate_plugin_data_env(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    for key in (
        "PLUGIN_DATA",
        "PECOT_BOOTSTRAP_SKIP",
        "PECOT_BOOTSTRAP_FORCE",
        "PECOT_GITHUB_API_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("CLAUDE_PLUGIN_DATA", str(tmp_path_factory.mktemp("plugin-data")))


# トークンと devcontainer 判定の環境変数の隔離。
# 開発者のシェルが export している値を継承すると、テストの結果が変わる。
# 例: PECOT_GITHUB_COM_TOKEN があると、401 の切り替えの警告が出力に入る。
# その結果、出力を比べるテストが落ちる。
# 外す対象は、製品がトークンを読む変数のすべて。
# - config/.env とホスト名から作る PECOT_GITHUB_<HOST>_TOKEN。ホスト名を挟む形も含む。
# - ルート .env 用の変数。auth.ROOT_ENV_VAR_MAP の値で、GITHUB_COM_TOKEN。
# core/worktree.py が devcontainer の判定に読む REMOTE_CONTAINERS・CODESPACES・DEVCONTAINER も外す。
# devcontainer の判定を確かめるテストは、自分で setenv する。


@pytest.fixture(autouse=True)
def _isolate_token_and_container_env(monkeypatch: pytest.MonkeyPatch) -> None:
    from cli.core.github.auth import ROOT_ENV_VAR_MAP

    token_names = {
        key for key in os.environ if key.startswith("PECOT_GITHUB_") and key.endswith("_TOKEN")
    }
    for key in (*token_names, *ROOT_ENV_VAR_MAP.values()):
        monkeypatch.delenv(key, raising=False)
    for key in ("REMOTE_CONTAINERS", "CODESPACES", "DEVCONTAINER"):
        monkeypatch.delenv(key, raising=False)


# プロジェクトルート隔離（ホスト側 .pecot/config/ への暗黙到達を遮断）。
# `pecot.core.state.get_project_root()` は `CLAUDE_PROJECT_DIR` env を最優先で参照する。
# この autouse で tmp の fake root に固定する。
# `get_projects_dir()` / `load_active_config()` 等を mock し忘れたテストがある。
# そのテストがホスト側 `.pecot/config/projects/.active` 等に偶然到達して pass するのを防ぐ。
# real 挙動を検証したいテスト (test_state 系) は自前で
# `monkeypatch.delenv("CLAUDE_PROJECT_DIR")` すれば opt-out できる。


@pytest.fixture(autouse=True)
def _isolate_project_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    fake_root = tmp_path_factory.mktemp("_hermetic_project_root_")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(fake_root))


# `PECOT_SESSION_PROJECT_DIR` も同じ扱い。
# SessionStart hook が書く値を pre-push 等で継承すると、
# get_project_root の結果が実行環境で変わる。
# 必要なテストだけ setenv する。


@pytest.fixture(autouse=True)
def _isolate_session_project_dir(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PECOT_SESSION_PROJECT_DIR", raising=False)


# ensure_env_file の parent dir 補完。
# 認証失敗時に core.github.auth.ensure_env_file が呼ばれる。
# この関数は `$CLAUDE_PROJECT_DIR/.pecot/config/.env` を親 dir 作成なしで書こうとする。
# 空 config 条件下では FileNotFoundError が起きる。
# テストでは parent を事前に作る。
# その後で原関数へ委譲する wrapper に置き換える。


@pytest.fixture(autouse=True)
def _ensure_env_file_parent(monkeypatch: pytest.MonkeyPatch) -> None:
    from cli.core.github import auth as _gh

    original = _gh.ensure_env_file

    def _wrapped(host: str) -> Path:
        _gh.get_config_dir().mkdir(parents=True, exist_ok=True)
        return original(host)

    monkeypatch.setattr(_gh, "ensure_env_file", _wrapped)


# Worktree 必須設定ファイル helper
# `create_worktree` は main_wt に次の 2 ファイルが両方あることを必須にしている。
# `.pecot/config/worktree-config.json` と `.pecot/config/.worktreeignore`。
# core / cli / e2e の 3 レイヤに分散していた同目的のヘルパを集約した。


def make_worktree_required_configs(
    main_wt: Path,
    *,
    config_json: str | None = None,
    ignore_content: str | None = None,
) -> tuple[Path, Path]:
    """`create_worktree` が要求する 2 ファイルをメイン WT に配置する

    Args:
        main_wt: メインワークツリーのルート。
        config_json: worktree-config.json の中身
            （省略時: ``{"version": 3, "links": []}``）。
        ignore_content: .worktreeignore の中身
            （省略時: DEFAULT_WORKTREEIGNORE_CONTENT）。

    Returns:
        (config_path, ignore_path)
    """
    from cli.core.paths import WORKTREE_IGNORE_FILENAME
    from cli.core.worktree_links import DEFAULT_WORKTREEIGNORE_CONTENT

    cfg_path = main_wt / ".pecot" / "config" / "worktree-config.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(config_json or '{"version": 3, "links": []}\n', encoding="utf-8")

    ignore_path = main_wt / WORKTREE_IGNORE_FILENAME
    ignore_path.parent.mkdir(parents=True, exist_ok=True)
    ignore_path.write_text(ignore_content or DEFAULT_WORKTREEIGNORE_CONTENT, encoding="utf-8")

    return cfg_path, ignore_path


def git_init_and_commit(repo: Path, files: dict[str, str]) -> None:
    """repo を git init し、files をコミットする（CI で global config 不在対策込み）"""
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=repo, check=True)
    for rel, content in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)


@pytest.fixture
def session_work_layout(tmp_path: Path) -> dict[str, Path]:
    """base（git リポ）と、その worktree ``wt``（.pecot/work が base への symlink）を作る

    ``<base>/.pecot/work/1244`` と ``<base>/.pecot/work2`` を用意する。
    CLAUDE_PROJECT_DIR は外してあるので git 解決とセッション起点の判定を検証できる。

    Returns:
        ``base`` / ``wt`` のパス（resolve 済み）
    """
    base = (tmp_path / "base").resolve()
    wt = (tmp_path / "wt").resolve()
    base.mkdir()
    git_init_and_commit(base, {"README.md": "x"})
    subprocess.run(["git", "worktree", "add", "-q", "-b", "feat/x", str(wt)], cwd=base, check=True)
    (base / ".pecot" / "work" / "1244").mkdir(parents=True)
    (base / ".pecot" / "work2").mkdir()
    (wt / ".pecot").mkdir()
    (wt / ".pecot" / "work").symlink_to(os.path.relpath(base / ".pecot" / "work", wt / ".pecot"))
    return {"base": base, "wt": wt}


@pytest.fixture
def fake_project(tmp_path: Path) -> tuple[Path, Path]:
    """``<tmp>/workspaces/base/myrepo`` を構築し必須 config を配置する

    Returns:
        (root, repo) の tuple。
        - root: プロジェクトルート (``<tmp>/workspaces``)
        - repo: メイン WT (``<root>/base/myrepo``)
    """
    root = tmp_path / "workspaces"
    repo = root / "base" / "myrepo"
    repo.mkdir(parents=True)
    make_worktree_required_configs(repo, ignore_content=".git/\n__pycache__/\n")
    return root, repo


# 共通フィクスチャ


@pytest.fixture
def mock_subprocess_run(monkeypatch: pytest.MonkeyPatch) -> Mock:
    """subprocess.run の標準モック（git操作用）

    Returns:
        Mock: returncode=0, stdout="", stderr="" を返すモック
    """
    mock = Mock()
    mock.return_value = Mock(returncode=0, stdout="", stderr="")
    monkeypatch.setattr("subprocess.run", mock)
    return mock


@pytest.fixture
def mock_github_client() -> MagicMock:
    """GitHubClient の包括的モック（全メソッド対応）

    Returns:
        MagicMock: GitHubClientのモック
    """
    mock = MagicMock()

    # Issue関連
    mock.create_issue.return_value = {"number": 123, "node_id": "I_test123"}
    mock.get_issue_node_id.return_value = "I_test123"
    mock.add_issue_comment.return_value = True

    # Project関連
    mock.add_to_project.return_value = "PVTI_test456"
    mock.update_project_item_field.return_value = True

    # Epic/SubIssue関連
    mock.add_sub_issue.return_value = True

    # PR関連
    mock.create_pull_request.return_value = {
        "number": 1,
        "url": "https://github.com/test/repo/pull/1",
    }
    mock.get_pull_request.return_value = {
        "number": 1,
        "title": "テストPR",
        "state": "OPEN",
        "mergeable": True,
    }
    mock.merge_pull_request.return_value = True

    return mock


@pytest.fixture
def mock_active_config() -> MagicMock:
    """アクティブプロジェクト設定のモック

    Returns:
        MagicMock: ProjectConfigのモック
    """
    mock = MagicMock()
    mock.host = "ghes.example.com"
    mock.owner = "test-owner"
    mock.project.number = 1
    mock.project.id = "PVT_test123"
    mock.is_repo_in_project.return_value = True
    mock.get_field_id.return_value = "PVTF_status"
    mock.get_option_id.return_value = "opt_active"
    return mock


@pytest.fixture
def tmp_git_repo(tmp_path: Path, mock_subprocess_run: Mock) -> Path:
    """一時的なGitリポジトリディレクトリを作成

    Args:
        tmp_path: pytestのtmp_pathフィクスチャ
        mock_subprocess_run: subprocess.runのモック

    Returns:
        Path: 一時リポジトリのパス
    """
    repo_dir = tmp_path / "test_repo"
    repo_dir.mkdir()

    # .gitディレクトリを作成（gitリポジトリとして認識させる）
    git_dir = repo_dir / ".git"
    git_dir.mkdir()

    return repo_dir


# テストデータ生成ヘルパー


def create_test_issue_data(
    number: int = 123,
    title: str = "テストIssue",
    body: str = "テスト本文",
    state: str = "OPEN",
    labels: list[str] | None = None,
) -> dict[str, Any]:
    """テスト用のIssueデータを生成

    Args:
        number: Issue番号
        title: タイトル
        body: 本文
        state: 状態（OPEN/CLOSED）
        labels: ラベルのリスト

    Returns:
        dict: Issueデータ
    """
    return {
        "number": number,
        "title": title,
        "body": body,
        "state": state,
        "labels": labels or [],
        "node_id": f"I_test{number}",
    }


def create_test_pr_data(
    number: int = 1,
    title: str = "テストPR",
    state: str = "OPEN",
    mergeable: bool = True,
    draft: bool = False,
) -> dict[str, Any]:
    """テスト用のPRデータを生成

    Args:
        number: PR番号
        title: タイトル
        state: 状態（OPEN/CLOSED/MERGED）
        mergeable: マージ可能フラグ
        draft: ドラフトフラグ

    Returns:
        dict: PRデータ
    """
    return {
        "number": number,
        "title": title,
        "state": state,
        "mergeable": mergeable,
        "draft": draft,
        "node_id": f"PR_test{number}",
    }


@pytest.fixture
def no_open_alerts():
    """3 種の alert（Dependabot・code scanning・secret scanning）が open 0 件のリポとして
    release コマンドの GitHub 問い合わせを差し替える

    autouse ではなく ``usefixtures`` で必要なクラス・テストにだけ適用する。
    """
    from cli.core.dependabot import DependabotAlertStatus
    from cli.core.security_alerts import ScanAlertStatus

    status = DependabotAlertStatus(
        enabled=True,
        open_count=0,
        max_severity=None,
        alerts_url="https://ghes.example.com/owner/repo/security/dependabot",
    )
    with (
        patch("cli.commands.release.GitHubClient"),
        patch("cli.commands.release.fetch_dependabot_alert_status", return_value=status),
        patch(
            "cli.commands.release.fetch_code_scanning_status",
            return_value=ScanAlertStatus(enabled=True, open_count=0, alerts_url="https://x/cs"),
        ),
        patch(
            "cli.commands.release.fetch_secret_scanning_status",
            return_value=ScanAlertStatus(enabled=True, open_count=0, alerts_url="https://x/ss"),
        ),
    ):
        yield
