"""tests/cli/test_repo.py - repo.pyのCLIテスト

create-branch コマンドのテスト。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from cli.commands.main import app
from cli.core.repo_resolver import RepoRef

runner = CliRunner()


@pytest.fixture(autouse=True)
def _stub_current_git_repo():
    """``@require_repo_match`` decorator 対策として、subprocess モック下でも
    カレント Git remote を既定値にスタブする。
    --repo 無しの呼び出しが「リポジトリが曖昧です」で弾かれないようにする。
    """
    with patch(
        "cli.core.repo_resolver._detect_current_git_repo",
        return_value=(RepoRef(owner="owner", repo="repo"), "origin"),
    ):
        yield


def _make_create_branch_client(
    *, sha: str = "abc123def456", branch: str = "feat/test/123", title: str = "[Task] テスト"
) -> MagicMock:
    """create-branch が呼ぶ API を成功で組んだ GitHubClient モック"""
    client = MagicMock()
    client.get_issue_node_id_and_title.return_value = ("I_kwDOtest123", title)
    client.get_branch_sha.return_value = sha
    client.create_linked_branch.return_value = branch
    return client


# create-branch コマンドテスト


class TestCreateBranchCommand:
    """create-branch コマンドのテスト"""

    def test_no_active_config(self) -> None:
        """アクティブ設定がない場合はエラー"""
        with patch("cli.commands.repo.load_active_config", return_value=None):
            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test"])
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output

    def test_invalid_issue_ref(self) -> None:
        """不正なIssue参照形式はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.repo.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["create-branch", "invalid-format", "feat/test"])
            assert result.exit_code == 2
            assert "invalid reference" in result.output

    def test_repo_not_in_project(self) -> None:
        """リポジトリがプロジェクトに含まれていない場合はエラー"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.owner = "project-owner"
        mock_config.project.number = 1
        mock_config.is_repo_in_project.return_value = False
        # develop_branchを設定してdevelop_branchチェックを通過させる
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = MagicMock()

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test"])
            assert result.exit_code == 1
            assert "プロジェクトに含まれていません" in result.output

    def test_create_branch_success(self) -> None:
        """正常にブランチ作成（ブランチ名末尾にIssue番号が自動付与される）"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client(branch="feat/test-branch/123")

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("subprocess.run") as mock_subprocess,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            # git fetch と git checkout のモック
            mock_subprocess.return_value = MagicMock(returncode=0)
            # get_project_root が呼ばれてもディレクトリが作成されないようにモック
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test-branch"])
            assert result.exit_code == 0
            assert "feat/test-branch/123" in result.output
            assert "作成完了" in result.output

            # API呼び出し確認
            mock_client.get_issue_node_id_and_title.assert_called_once_with("owner", "repo", 123)
            mock_client.get_branch_sha.assert_called_once_with("owner", "repo", "develop")
            # ブランチ名末尾に /issue番号 が付与される
            mock_client.create_linked_branch.assert_called_once_with(
                issue_id="I_kwDOtest123",
                oid="abc123def456",
                name="feat/test-branch/123",
            )

    def test_create_branch_records_issue_title_for_session_name(self) -> None:
        """Node ID と同じ応答で得た Issue タイトルが作業対象の記録に渡る"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client(title="[Bug] 取得したタイトル")

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.commands.repo.write_work_target") as mock_write,
            patch("subprocess.run") as mock_subprocess,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_subprocess.return_value = MagicMock(returncode=0)
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(
                app, ["create-branch", "owner/repo/123", "feat/test", "--no-checkout"]
            )
            assert result.exit_code == 0
            mock_write.assert_called_once_with("owner/repo/123", "[Bug] 取得したタイトル")
            # タイトルのための追加の Issue 取得は行わない
            mock_client.get_issue_slim.assert_not_called()

    def test_create_branch_updates_status_to_active(self) -> None:
        """ブランチ作成時にステータスが自動的に 'active' に更新される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")
        mock_config.project.id = "PVT_test123"
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "active_option_id"

        mock_client = _make_create_branch_client(branch="feat/test-branch/123")
        mock_client.get_item_id_by_issue.return_value = "PVTI_item123"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("subprocess.run") as mock_subprocess,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_subprocess.return_value = MagicMock(returncode=0)
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test-branch"])
            assert result.exit_code == 0
            assert "ステータスを 'active' に設定しました" in result.output

            # ステータス更新API呼び出し確認
            mock_client.get_item_id_by_issue.assert_called_once_with(
                project_id="PVT_test123",
                owner="owner",
                repo="repo",
                issue_number=123,
            )
            mock_client.update_project_item_field.assert_called_once_with(
                "PVT_test123", "PVTI_item123", "PVTF_workflow", "active_option_id"
            )

    def test_create_branch_continues_on_status_update_failure(self) -> None:
        """ステータス更新API失敗時も処理続行する"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")
        mock_config.project.id = "PVT_test123"
        mock_config.get_field_id.return_value = "PVTF_workflow"
        mock_config.get_option_id.return_value = "active_option_id"

        mock_client = _make_create_branch_client(branch="feat/test-branch/123")
        mock_client.get_item_id_by_issue.side_effect = GitHubAPIError(
            "Failed to get item", status_code=500
        )

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("subprocess.run") as mock_subprocess,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_subprocess.return_value = MagicMock(returncode=0)
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test-branch"])
            # エラーが発生してもブランチ作成は成功
            assert result.exit_code == 0
            assert "作成完了" in result.output
            # ステータス更新のメッセージは表示されない
            assert "ステータスを 'active' に設定しました" not in result.output

    def test_create_branch_handles_issue_not_in_project(self) -> None:
        """Issueがプロジェクトに存在しない場合でも処理続行する"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")
        mock_config.project.id = "PVT_test123"

        mock_client = _make_create_branch_client(branch="feat/test-branch/123")
        # Issueがプロジェクトに存在しない（item_id が None）
        mock_client.get_item_id_by_issue.return_value = None

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("subprocess.run") as mock_subprocess,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_subprocess.return_value = MagicMock(returncode=0)
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test-branch"])
            # ブランチ作成は成功
            assert result.exit_code == 0
            assert "作成完了" in result.output
            # ステータス更新は試みられない
            mock_client.update_project_item_field.assert_not_called()

    def test_create_branch_handles_missing_field_config(self) -> None:
        """フィールドIDまたはオプションIDが取得できない場合も処理続行する"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")
        mock_config.project.id = "PVT_test123"
        # フィールドIDまたはオプションIDが取得できない
        mock_config.get_field_id.return_value = None
        mock_config.get_option_id.return_value = None

        mock_client = _make_create_branch_client(branch="feat/test-branch/123")
        mock_client.get_item_id_by_issue.return_value = "PVTI_item123"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("subprocess.run") as mock_subprocess,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_subprocess.return_value = MagicMock(returncode=0)
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test-branch"])
            # ブランチ作成は成功
            assert result.exit_code == 0
            assert "作成完了" in result.output
            # ステータス更新は試みられない
            mock_client.update_project_item_field.assert_not_called()

    def test_create_branch_no_checkout(self) -> None:
        """--no-checkout オプション"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client(branch="feat/no-checkout/123")

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("subprocess.run") as mock_subprocess,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(
                app,
                ["create-branch", "owner/repo/123", "feat/no-checkout", "--no-checkout"],
            )
            assert result.exit_code == 0
            assert "feat/no-checkout/123" in result.output

            # git checkout が呼ばれていないことを確認
            # git fetch のみ呼ばれる（checkout は呼ばれない）
            calls = mock_subprocess.call_args_list
            checkout_calls = [c for c in calls if "checkout" in str(c)]
            assert len(checkout_calls) == 0

    def test_create_branch_custom_base(self) -> None:
        """--base オプション"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client(sha="main123sha", branch="feat/from-main/123")

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("subprocess.run") as mock_subprocess,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_subprocess.return_value = MagicMock(returncode=0)
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(
                app,
                ["create-branch", "owner/repo/123", "feat/from-main", "--base", "main"],
            )
            assert result.exit_code == 0

            # main ブランチから分岐
            mock_client.get_branch_sha.assert_called_once_with("owner", "repo", "main")

    def test_github_api_error(self) -> None:
        """GitHub APIエラー時"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = MagicMock()
        mock_client.get_issue_node_id_and_title.side_effect = GitHubAPIError(
            "Issue not found", status_code=404
        )

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test"])
            assert result.exit_code == 1
            assert "GitHub APIエラー" in result.output

    def test_no_develop_branch_raises_error(self) -> None:
        """develop_branchが未設定の場合はエラーを発生"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_repo = MagicMock()
        mock_repo.develop_branch = None
        mock_config.find_repository.return_value = mock_repo

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
        ):
            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test"])
            assert result.exit_code == 1
            assert "develop_branch が設定されていません" in result.output


# create-branch セッションスコープガード (#564)


class TestCreateBranchSessionScopeGuards:
    """A-1 (CWD–Issue ref 整合) / A-2 (.pecot-active 上書き) ガードのテスト"""

    def test_create_branch_rejects_cwd_repo_mismatch(self) -> None:
        """A-1: CWD git remote の owner/repo と issue_ref が異なれば exit 2"""
        mock_config = MagicMock()

        # CWD は other-owner/other-repo を指す
        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch(
                "cli.core.repo_resolver._detect_current_git_repo",
                return_value=(RepoRef(owner="other-owner", repo="other-repo"), "origin"),
            ),
        ):
            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test"])
            assert result.exit_code == 2
            assert "作業対象 Issue のリポ (owner/repo)" in result.output
            assert "CWD git remote (other-owner/other-repo)" in result.output
            assert "/pecot-w:w-worktree-add" in result.output
            assert "--allow-cross-repo" in result.output

    def test_create_branch_allows_cross_repo_with_flag(self) -> None:
        """A-1: --allow-cross-repo でリポ不一致をバイパスできる"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client()

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.commands.repo.read_flag", return_value=None),
            patch("cli.commands.repo.write_work_target"),
            patch(
                "cli.core.repo_resolver._detect_current_git_repo",
                return_value=(RepoRef(owner="other-owner", repo="other-repo"), "origin"),
            ),
            patch("subprocess.run") as mock_subprocess,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_subprocess.return_value = MagicMock(returncode=0)
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(
                app,
                [
                    "create-branch",
                    "owner/repo/123",
                    "feat/test",
                    "--allow-cross-repo",
                    "--no-checkout",
                ],
            )
            assert result.exit_code == 0
            assert "作成完了" in result.output

    def test_create_branch_rejects_open_active_overwrite(self) -> None:
        """A-2: .pecot-active に OPEN な別 Issue があれば exit 2 + API 未呼び出し"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = MagicMock()
        mock_client.get_issue_slim.return_value = {"state": "OPEN"}

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.commands.repo.read_flag", return_value="owner/repo/999"),
        ):
            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test"])
            assert result.exit_code == 2
            assert "owner/repo/999" in result.output
            assert "OPEN" in result.output
            assert "/pecot-w:w-worktree-add" in result.output
            assert "--force-overwrite-active" in result.output
            # ブランチ作成系の API は呼ばれない
            mock_client.get_issue_node_id_and_title.assert_not_called()
            mock_client.create_linked_branch.assert_not_called()
            mock_client.get_issue_slim.assert_called_once_with("owner", "repo", 999)

    def test_create_branch_overwrites_closed_active_silently(self) -> None:
        """A-2: .pecot-active の Issue が CLOSED なら note を出して続行"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client()
        mock_client.get_issue_slim.return_value = {"state": "CLOSED"}

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.commands.repo.read_flag", return_value="owner/repo/999"),
            patch("cli.commands.repo.write_work_target") as mock_write,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(
                app, ["create-branch", "owner/repo/123", "feat/test", "--no-checkout"]
            )
            assert result.exit_code == 0
            assert "stale" in result.output
            assert "CLOSED" in result.output
            assert "owner/repo/999" in result.output
            mock_write.assert_called_once_with("owner/repo/123", "[Task] テスト")

    def test_create_branch_treats_unparseable_active_as_stale(self) -> None:
        """A-2: パース不能な .pecot-active は note 1 行 + 続行（get_issue_slim 未呼び出し）"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client()

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.commands.repo.read_flag", return_value="garbage-value"),
            patch("cli.commands.repo.write_work_target") as mock_write,
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(
                app, ["create-branch", "owner/repo/123", "feat/test", "--no-checkout"]
            )
            assert result.exit_code == 0
            assert "note:" in result.output
            assert "不正な形式" in result.output
            assert "stale" in result.output
            mock_client.get_issue_slim.assert_not_called()
            mock_write.assert_called_once_with("owner/repo/123", "[Task] テスト")

    def test_create_branch_allows_force_overwrite_active(self) -> None:
        """A-2: --force-overwrite-active で OPEN でも上書き可能 + get_issue_slim 未呼び出し"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client()

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.commands.repo.read_flag", return_value="owner/repo/999"),
            patch("cli.commands.repo.write_work_target"),
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(
                app,
                [
                    "create-branch",
                    "owner/repo/123",
                    "feat/test",
                    "--force-overwrite-active",
                    "--no-checkout",
                ],
            )
            assert result.exit_code == 0
            assert "作成完了" in result.output
            mock_client.get_issue_slim.assert_not_called()

    def test_create_branch_no_check_when_active_matches(self) -> None:
        """A-2: .pecot-active が新 ref と一致するなら get_issue_slim を呼ばずに続行"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client()

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.commands.repo.read_flag", return_value="owner/repo/123"),
            patch("cli.commands.repo.write_work_target"),
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(
                app, ["create-branch", "owner/repo/123", "feat/test", "--no-checkout"]
            )
            assert result.exit_code == 0
            mock_client.get_issue_slim.assert_not_called()

    def test_create_branch_no_check_when_active_empty(self) -> None:
        """A-2: .pecot-active 不在なら get_issue_slim を呼ばずに続行"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client()

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.commands.repo.read_flag", return_value=None),
            patch("cli.commands.repo.write_work_target"),
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(
                app, ["create-branch", "owner/repo/123", "feat/test", "--no-checkout"]
            )
            assert result.exit_code == 0
            mock_client.get_issue_slim.assert_not_called()


# create-branch WT環境メッセージテスト


class TestCreateBranchWorktreeMessage:
    """create-branch コマンドのWT環境向け案内メッセージのテスト"""

    def test_worktree_env_shows_wt_message(self) -> None:
        """WT環境ではWT名入りメッセージが表示される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client()

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.core.worktree.get_current_worktree_name", return_value="wt2"),
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test"])
            assert result.exit_code == 0
            assert "owner/repo のワークツリー(wt2)で以下を実行してください" in result.output

    def test_non_worktree_env_shows_default_message(self) -> None:
        """非WT環境では従来メッセージが表示される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client()

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch("cli.core.worktree.get_current_worktree_name", return_value=None),
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test"])
            assert result.exit_code == 0
            assert (
                "owner/repo で以下のコマンドを実行してブランチを切り替えてください" in result.output
            )

    def test_worktree_detection_error_shows_default_message(self) -> None:
        """WT判定エラー時は従来メッセージが表示される"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.is_repo_in_project.return_value = True
        mock_config.find_repository.return_value = MagicMock(develop_branch="develop")

        mock_client = _make_create_branch_client()

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
            patch(
                "cli.core.worktree.get_current_worktree_name",
                side_effect=RuntimeError("git error"),
            ),
            patch("cli.core.state.get_project_root") as mock_get_root,
        ):
            mock_get_root.return_value = MagicMock()

            result = runner.invoke(app, ["create-branch", "owner/repo/123", "feat/test"])
            assert result.exit_code == 0
            assert (
                "owner/repo で以下のコマンドを実行してブランチを切り替えてください" in result.output
            )


# ヘルプ表示テスト


# delete-branch コマンドテスト


class TestDeleteBranchCommand:
    """delete-branch コマンドのテスト"""

    def test_invalid_repo_ref(self) -> None:
        """不正なリポジトリ参照形式はエラー"""
        mock_config = MagicMock()
        with patch("cli.commands.repo.load_active_config", return_value=mock_config):
            result = runner.invoke(app, ["delete-branch", "invalid-format", "feat/test"])
            assert result.exit_code == 2
            assert "invalid owner/repo form" in result.output
            assert "owner/repo" in result.output

    def test_no_active_config(self) -> None:
        """アクティブ設定がない場合はエラー"""
        with patch("cli.commands.repo.load_active_config", return_value=None):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "feat/test"])
            assert result.exit_code == 1
            assert "アクティブなプロジェクトがありません" in result.output

    def test_protected_branch_default(self) -> None:
        """デフォルトブランチの削除はブロック"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.find_repository.return_value = None

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "main"])
            assert result.exit_code == 1
            assert "保護ブランチ" in result.output

    def test_protected_branch_develop(self) -> None:
        """develop_branchの削除はブロック"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_repo = MagicMock()
        mock_repo.develop_branch = "develop-aist"
        mock_repo.release_branch = None
        mock_config.find_repository.return_value = mock_repo

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "develop-aist"])
            assert result.exit_code == 1
            assert "保護ブランチ" in result.output

    def test_protected_branch_release(self) -> None:
        """release_branchの削除はブロック"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_repo = MagicMock()
        mock_repo.develop_branch = "develop"
        mock_repo.release_branch = "release"
        mock_config.find_repository.return_value = mock_repo

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "release"])
            assert result.exit_code == 1
            assert "保護ブランチ" in result.output

    def test_api_error_on_default_branch_fetch(self) -> None:
        """デフォルトブランチ取得時のAPIエラー"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.find_repository.return_value = None

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.side_effect = GitHubAPIError(
            "Not Found", status_code=404
        )

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "feat/test"])
            assert result.exit_code == 1
            assert "GitHub APIエラー" in result.output

    def test_api_error_on_delete(self) -> None:
        """ブランチ削除時のAPIエラー"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.find_repository.return_value = None

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"
        mock_client.delete_branch.side_effect = GitHubAPIError(
            "Reference does not exist", status_code=422
        )

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "feat/nonexistent"])
            assert result.exit_code == 1
            assert "GitHub APIエラー" in result.output

    def test_delete_success(self) -> None:
        """正常にブランチ削除"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.find_repository.return_value = None

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "feat/old-branch"])
            assert result.exit_code == 0
            assert "削除しました" in result.output
            assert "feat/old-branch" in result.output
            # featureブランチとWIPブランチの両方が削除される
            assert mock_client.delete_branch.call_count == 2
            mock_client.delete_branch.assert_any_call("owner", "repo", "feat/old-branch")
            mock_client.delete_branch.assert_any_call("owner", "repo", "wip/feat/old-branch")

    def test_delete_also_deletes_wip_branch(self) -> None:
        """ブランチ削除時にWIPブランチも連動削除"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.find_repository.return_value = None

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "feat/my-feature"])
            assert result.exit_code == 0
            assert "WIPブランチ 'wip/feat/my-feature' も削除しました" in result.output
            assert mock_client.delete_branch.call_count == 2
            mock_client.delete_branch.assert_any_call("owner", "repo", "feat/my-feature")
            mock_client.delete_branch.assert_any_call("owner", "repo", "wip/feat/my-feature")

    def test_delete_wip_branch_not_found_silently_skipped(self) -> None:
        """WIPブランチが存在しない場合はスキップ"""
        from cli.core.github import GitHubAPIError

        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.find_repository.return_value = None

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"
        mock_client.delete_branch.side_effect = [
            None,  # feat/my-feature 成功
            GitHubAPIError("Reference does not exist", status_code=422),
        ]

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "feat/my-feature"])
            assert result.exit_code == 0
            assert "削除しました" in result.output
            # WIPブランチ削除のメッセージは出ない
            assert "WIPブランチ" not in result.output

    def test_delete_success_with_repo_config(self) -> None:
        """リポジトリ設定ありで正常にブランチ削除"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_repo = MagicMock()
        mock_repo.develop_branch = "develop-aist"
        mock_repo.release_branch = "release-v1"
        mock_config.find_repository.return_value = mock_repo

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "feat/done-branch"])
            assert result.exit_code == 0
            assert "削除しました" in result.output

    def test_dry_run(self) -> None:
        """--dry-run で削除せず情報表示"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.find_repository.return_value = None

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(
                app, ["delete-branch", "owner/repo", "feat/test-branch", "--dry-run"]
            )
            assert result.exit_code == 0
            assert "[dry-run]" in result.output
            assert "feat/test-branch" in result.output
            mock_client.delete_branch.assert_not_called()

    def test_dry_run_short_option(self) -> None:
        """-n で dry-run"""
        mock_config = MagicMock()
        mock_config.host = "ghes.example.com"
        mock_config.find_repository.return_value = None

        mock_client = MagicMock()
        mock_client.get_repository_default_branch.return_value = "main"

        with (
            patch("cli.commands.repo.load_active_config", return_value=mock_config),
            patch("cli.commands.repo.GitHubClient", return_value=mock_client),
        ):
            result = runner.invoke(app, ["delete-branch", "owner/repo", "feat/test", "-n"])
            assert result.exit_code == 0
            assert "[dry-run]" in result.output
            mock_client.delete_branch.assert_not_called()


class TestRepoCommandsHelp:
    """repo系コマンドのヘルプ表示テスト"""

    def test_create_branch_help(self) -> None:
        """create-branch --help"""
        result = runner.invoke(app, ["create-branch", "--help"])
        assert result.exit_code == 0
        assert "Create a branch linked to an Issue" in result.output

    def test_delete_branch_help(self) -> None:
        """delete-branch --help"""
        result = runner.invoke(app, ["delete-branch", "--help"])
        assert result.exit_code == 0
        assert "Delete a remote branch" in result.output
