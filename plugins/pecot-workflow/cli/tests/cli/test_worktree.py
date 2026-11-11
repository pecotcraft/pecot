"""tests/cli/test_worktree.py - worktree CLI サブコマンドのテスト (v2)"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner, Result
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands.main import app
from cli.core.config import FieldOptions, Project, ProjectConfig, ProjectFields, Repository
from cli.core.repo_resolver import RepoRef
from cli.core.worktree import CopyResult, SetupResult, WorktreeCreateResult
from cli.tests.conftest import git_init_and_commit

runner = CliRunner()


# ヘルプ


class TestHelp:
    def test_worktree_help(self) -> None:
        result = runner.invoke(app, ["worktree", "--help"])
        assert result.exit_code == 0

    def test_add_help(self) -> None:
        result = runner.invoke(app, ["worktree", "add", "--help"])
        assert result.exit_code == 0
        assert "--allow-existing-branch" in result.output

    def test_remove_help(self) -> None:
        result = runner.invoke(app, ["worktree", "remove", "--help"])
        assert result.exit_code == 0

    def test_init_help(self) -> None:
        result = runner.invoke(app, ["worktree", "init", "--help"])
        assert result.exit_code == 0

    def test_link_help(self) -> None:
        result = runner.invoke(app, ["worktree", "link", "--help"])
        assert result.exit_code == 0


# worktree add


class TestWorktreeAdd:
    @patch("cli.core.worktree.create_worktree")
    def test_add_auto_name(self, mock_create: MagicMock, tmp_path: Path) -> None:
        """NAME は受け付けず、自動採番のみ"""
        mock_create.return_value = WorktreeCreateResult(
            name="wt1",
            path=tmp_path / "wt1" / "repo",
            branch="wt1",
            base_branch="main",
            copied_files=[],
        )
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code == 0
        assert "wt1" in result.output
        # create_worktree は name 引数なしで呼ばれる
        _, kwargs = mock_create.call_args
        assert "name" not in kwargs

    @add_test_properties(verifies=["PW-WORKTREE-ADD-23"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_core_warning_has_prefix(self, mock_create: MagicMock, tmp_path: Path) -> None:
        """main の import だけで handler が付き、core の警告が `warning:` 付きで出る"""
        from cli.core.worktree_links import WorktreeLinkItem, _process_link

        def create(*_args: object, **_kwargs: object) -> WorktreeCreateResult:
            link = WorktreeLinkItem(path="x", target_repo="none", target_path="missing")
            _process_link(
                link, tmp_path, tmp_path / "wt1" / "repo", confirm_callback=lambda *_: False
            )
            return WorktreeCreateResult(
                name="wt1",
                path=tmp_path / "wt1" / "repo",
                branch="wt1",
                base_branch="main",
                copied_files=[],
            )

        mock_create.side_effect = create
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        assert any(line.startswith("warning: target does not exist:") for line in lines)
        assert not any(line.startswith("target does not exist:") for line in lines)

    @add_test_properties(verifies=["PW-WORKTREE-ADD-16"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_dry_run(self, mock_create: MagicMock, tmp_path: Path) -> None:
        mock_create.return_value = WorktreeCreateResult(
            name="wt1",
            path=tmp_path / "wt1" / "repo",
            branch="wt1",
            base_branch="main",
            copied_files=[],
        )
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path), "--dry-run"])
        assert result.exit_code == 0
        assert "dry-run" in result.output

    @add_test_properties(verifies=["PW-WORKTREE-ADD-12"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_allow_existing_branch_flag(self, mock_create: MagicMock, tmp_path: Path) -> None:
        mock_create.return_value = WorktreeCreateResult(
            name="wt1",
            path=tmp_path / "wt1" / "repo",
            branch="wt1",
            base_branch="main",
            copied_files=[],
        )
        result = runner.invoke(
            app,
            [
                "worktree",
                "add",
                "-D",
                str(tmp_path),
                "--allow-existing-branch",
            ],
        )
        assert result.exit_code == 0
        _, kwargs = mock_create.call_args
        assert kwargs["allow_existing_branch"] is True

    @patch("cli.core.worktree.create_worktree")
    def test_add_error(self, mock_create: MagicMock, tmp_path: Path) -> None:
        mock_create.side_effect = RuntimeError("boom")
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: boom" in result.output

    @add_test_properties(verifies=["PW-WORKTREE-ADD-40"])
    def test_add_without_remote_exits_1(self, tmp_path: Path) -> None:
        """remote の無いリポでは、error の行を出して終了コード 1 になる"""
        from cli.tests.conftest import make_worktree_required_configs

        repo = tmp_path / "base" / "myrepo"
        repo.mkdir(parents=True)
        git_init_and_commit(repo, {"README.md": "hi"})
        make_worktree_required_configs(repo)

        with (
            patch("cli.core.worktree.ensure_devcontainer_environment"),
            patch("cli.core.worktree.load_active_config", return_value=MagicMock()),
        ):
            result = runner.invoke(app, ["worktree", "add", "-D", str(repo)])

        assert result.exit_code == 1
        assert (
            "error: cannot get the repository information: "
            "check that a git remote is set to a GitHub repository URL"
        ) in result.output
        assert not (tmp_path / "wt1").exists()

    def test_add_rejects_positional_name(self, tmp_path: Path) -> None:
        """NAME を位置引数で渡すと typer が拒否する"""
        result = runner.invoke(app, ["worktree", "add", "wt1", "-D", str(tmp_path)])
        assert result.exit_code != 0

    @patch("cli.core.worktree.create_worktree")
    def test_add_displays_setup_success(self, mock_create: MagicMock, tmp_path: Path) -> None:
        """setup_result が成功の場合、setup の行は出ない"""
        mock_create.return_value = WorktreeCreateResult(
            name="wt1",
            path=tmp_path / "wt1" / "repo",
            branch="wt1",
            base_branch="main",
            copied_files=[],
            setup_result=SetupResult(
                command="echo done",
                returncode=0,
                stdout="done\n",
                stderr="",
            ),
        )
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code == 0
        assert "setup command" not in result.output
        assert "echo done" not in result.output

    @add_test_properties(verifies=["PW-WORKTREE-ADD-24", "PW-WORKTREE-ADD-25"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_displays_setup_failure(self, mock_create: MagicMock, tmp_path: Path) -> None:
        """setup が失敗すると core の警告が 1 本だけ出て、exit code は 0 のまま"""
        result = self._add_with_setup(
            mock_create,
            tmp_path,
            SetupResult(command="exit 42", returncode=42, stdout="", stderr="oops\n"),
        )
        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        assert [ln for ln in lines if "setup command" in ln] == [
            "warning: setup command failed (exit 42): exit 42"
        ]
        assert (
            lines[lines.index("warning: setup command failed (exit 42): exit 42") + 1]
            == "  err: oops"
        )
        assert "setup_command exited" not in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-ADD-10"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_passes_setup_option_to_core(self, mock_create: MagicMock, tmp_path: Path) -> None:
        """--setup で指定したコマンドが create_worktree に渡される"""
        mock_create.return_value = WorktreeCreateResult(
            name="wt1",
            path=tmp_path / "wt1" / "repo",
            branch="wt1",
            base_branch="main",
            copied_files=[],
        )
        result = runner.invoke(
            app,
            ["worktree", "add", "-D", str(tmp_path), "--setup", "echo cli-setup"],
        )
        assert result.exit_code == 0
        _, kwargs = mock_create.call_args
        assert kwargs["setup_command"] == "echo cli-setup"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-24", "PW-WORKTREE-ADD-25"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_displays_setup_timeout(self, mock_create: MagicMock, tmp_path: Path) -> None:
        """timeout した際は timed out の警告が 1 本だけ出る"""
        result = self._add_with_setup(
            mock_create,
            tmp_path,
            SetupResult(
                command="sleep 600", returncode=-1, stdout="", stderr="timeout after 60 seconds"
            ),
        )
        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        assert [ln for ln in lines if "setup command" in ln] == [
            "warning: setup command timed out: sleep 600"
        ]
        assert lines[lines.index("warning: setup command timed out: sleep 600") + 1] == (
            "  err: timeout after 60 seconds"
        )
        assert "setup_command exited" not in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-ADD-23"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_tracked_link_is_one_warning(self, mock_create: MagicMock, tmp_path: Path) -> None:
        """追跡しているパスの link は core の警告 1 行だけで、error: の行は出ない"""
        wt_repo = tmp_path / "wt1" / "repo"
        wt_repo.mkdir(parents=True)
        git_init_and_commit(wt_repo, {"README.md": "x"})
        (tmp_path / "base" / "src").mkdir(parents=True)
        (tmp_path / "base" / "src" / "README.md").write_text("shared")
        result = self._add_with_link(mock_create, tmp_path, "README.md")
        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        tracked = f"warning: symlink creation skipped because the path is tracked by git: {wt_repo / 'README.md'}"
        assert lines.count(tracked) == 1
        assert not any(ln.startswith(("error:", "warning: symlink /")) for ln in lines)

    @add_test_properties(verifies=["PW-WORKTREE-ADD-19", "PW-WORKTREE-ADD-23"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_symlink_failure_is_one_warning(
        self, mock_create: MagicMock, tmp_path: Path
    ) -> None:
        """symlink の作成失敗は core の警告 1 行だけで、error: と symlink <path>: の行は出ない"""
        wt_repo = tmp_path / "wt1" / "repo"
        wt_repo.mkdir(parents=True)
        (wt_repo / "a").write_text("plain file")
        (tmp_path / "base" / "src").mkdir(parents=True)
        (tmp_path / "base" / "src" / "b").write_text("shared")
        result = self._add_with_link(mock_create, tmp_path, "a/b", target_path="b")
        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        assert (
            len([ln for ln in lines if ln.startswith("warning: failed to create the symlink:")])
            == 1
        )
        assert not any(ln.startswith(("error:", "warning: symlink /")) for ln in lines)
        assert "count: symlink errors: 1" in result.output

    @staticmethod
    def _created(tmp_path: Path, **extra: object) -> WorktreeCreateResult:
        return WorktreeCreateResult(
            name="wt1",
            path=tmp_path / "wt1" / "repo",
            branch="wt1",
            base_branch="main",
            copied_files=[],
            **extra,  # type: ignore[arg-type]
        )

    def _add_with_setup(self, mock_create: MagicMock, tmp_path: Path, setup: SetupResult) -> Result:
        """本物の _run_effective_setup を通し、_run_setup_command だけを差し替えて worktree add を打つ"""
        from cli.core.worktree import _run_effective_setup

        def create(*_args: object, **_kwargs: object) -> WorktreeCreateResult:
            config = MagicMock(setup_command=None, setup_command_timeout=None)
            with patch("cli.core.worktree._run_setup_command", return_value=setup):
                sr = _run_effective_setup(setup.command, config, tmp_path)
            return self._created(tmp_path, setup_result=sr)

        mock_create.side_effect = create
        return runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])

    def _add_with_link(
        self, mock_create: MagicMock, tmp_path: Path, path: str, target_path: str | None = None
    ) -> Result:
        """本物の _process_link を通して worktree add を打つ（<tmp>/base/src が link 先）"""
        from cli.core.worktree_links import WorktreeLinkItem, _process_link

        def create(*_args: object, **_kwargs: object) -> WorktreeCreateResult:
            link = WorktreeLinkItem(path=path, target_repo="src", target_path=target_path or path)
            r = _process_link(
                link, tmp_path, tmp_path / "wt1" / "repo", confirm_callback=lambda *_: False
            )
            return self._created(tmp_path, linked_files=[r])

        mock_create.side_effect = create
        return runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])

    @add_test_properties(verifies=["PW-WORKTREE-ADD-05"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_base_option_is_passed_to_core(
        self, mock_create: MagicMock, tmp_path: Path
    ) -> None:
        mock_create.return_value = self._created(tmp_path)
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path), "--base", "release"])
        assert result.exit_code == 0
        assert mock_create.call_args.kwargs["base_branch"] == "release"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-08"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_no_link_passes_link_false(self, mock_create: MagicMock, tmp_path: Path) -> None:
        mock_create.return_value = self._created(tmp_path)
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path), "--no-link"])
        assert result.exit_code == 0
        assert mock_create.call_args.kwargs["link"] is False

    @add_test_properties(verifies=["PW-WORKTREE-ADD-09"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_no_copy_passes_copy_false(self, mock_create: MagicMock, tmp_path: Path) -> None:
        mock_create.return_value = self._created(tmp_path)
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path), "--no-copy"])
        assert result.exit_code == 0
        assert mock_create.call_args.kwargs["copy"] is False

    @add_test_properties(verifies=["PW-WORKTREE-ADD-14"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_prints_created_line(self, mock_create: MagicMock, tmp_path: Path) -> None:
        mock_create.return_value = self._created(tmp_path)
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code == 0
        assert (
            f"created: worktree wt1 at {tmp_path / 'wt1' / 'repo'} (branch wt1 from main)"
            in result.stderr.splitlines()
        )

    @add_test_properties(verifies=["PW-WORKTREE-ADD-15"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_prints_path_to_stdout(self, mock_create: MagicMock, tmp_path: Path) -> None:
        mock_create.return_value = self._created(tmp_path)
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code == 0
        assert result.stdout == f"{tmp_path / 'wt1' / 'repo'}\n"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-17"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_dry_run_prints_planned_path_to_stdout(
        self, mock_create: MagicMock, tmp_path: Path
    ) -> None:
        mock_create.return_value = self._created(tmp_path)
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path), "--dry-run"])
        assert result.exit_code == 0
        assert result.stdout == f"{tmp_path / 'wt1' / 'repo'}\n"

    @add_test_properties(verifies=["PW-WORKTREE-ADD-18"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_prints_symlinks_created_count(
        self, mock_create: MagicMock, tmp_path: Path
    ) -> None:
        wt_repo = tmp_path / "wt1" / "repo"
        wt_repo.mkdir(parents=True)
        (tmp_path / "base" / "src").mkdir(parents=True)
        (tmp_path / "base" / "src" / "a.txt").write_text("shared")
        result = self._add_with_link(mock_create, tmp_path, "a.txt")
        assert result.exit_code == 0
        assert "count: symlinks created: 1" in result.stderr.splitlines()

    @add_test_properties(verifies=["PW-WORKTREE-ADD-20"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_prints_files_copied_count(self, mock_create: MagicMock, tmp_path: Path) -> None:
        copied = [
            CopyResult(source=tmp_path / f"s{i}", dest=tmp_path / f"d{i}", action="copied")
            for i in range(2)
        ]
        mock_create.return_value = WorktreeCreateResult(
            name="wt1",
            path=tmp_path / "wt1" / "repo",
            branch="wt1",
            base_branch="main",
            copied_files=copied,
        )
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code == 0
        assert "count: files copied: 2" in result.stderr.splitlines()

    @add_test_properties(verifies=["PW-WORKTREE-ADD-21"])
    @patch("cli.core.worktree.create_worktree")
    def test_add_prints_warning_per_copy_error(
        self, mock_create: MagicMock, tmp_path: Path
    ) -> None:
        failed = [
            CopyResult(
                source=tmp_path / f"s{i}", dest=tmp_path / f"d{i}", action="error", message=f"m{i}"
            )
            for i in range(2)
        ]
        mock_create.return_value = WorktreeCreateResult(
            name="wt1",
            path=tmp_path / "wt1" / "repo",
            branch="wt1",
            base_branch="main",
            copied_files=failed,
        )
        result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        assert f"warning: copy {tmp_path / 's0'}: m0" in lines
        assert f"warning: copy {tmp_path / 's1'}: m1" in lines
        assert len([ln for ln in lines if ln.startswith("warning: copy ")]) == 2

    @add_test_properties(verifies=["PW-WORKTREE-ADD-32"])
    def test_add_outside_git_exits_1(self, tmp_path: Path) -> None:
        with patch("cli.core.worktree.ensure_devcontainer_environment"):
            result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: cannot get the worktree list" in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-ADD-34"])
    def test_add_non_base_layout_exits_1(self, tmp_path: Path) -> None:
        main_wt = tmp_path / "elsewhere" / "myrepo"
        main_wt.mkdir(parents=True)
        with (
            patch("cli.core.worktree.ensure_devcontainer_environment"),
            patch("cli.core.worktree.find_main_worktree", return_value=main_wt),
        ):
            result = runner.invoke(app, ["worktree", "add", "-D", str(main_wt)])
        assert result.exit_code == 1
        assert "error: this repository is not placed in the layout" in result.stderr
        assert not (tmp_path / "wt1").exists()

    @add_test_properties(verifies=["PW-WORKTREE-ADD-36"])
    def test_add_without_worktree_config_exits_1(self, tmp_path: Path) -> None:
        repo = tmp_path / "base" / "myrepo"
        repo.mkdir(parents=True)
        git_init_and_commit(repo, {"README.md": "hi"})
        result = self._add_in_repo(repo, tmp_path)
        assert result.exit_code == 1
        assert "error: worktree config not found" in result.stderr
        assert not (tmp_path / "wt1").exists()

    @add_test_properties(verifies=["PW-WORKTREE-ADD-38"])
    def test_add_without_project_config_exits_1(self, tmp_path: Path) -> None:
        result = self._add_in_repo(self._repo(tmp_path), tmp_path, project_config=None)
        assert result.exit_code == 1
        assert "error: project config not found" in result.stderr
        assert not (tmp_path / "wt1").exists()

    @add_test_properties(verifies=["PW-WORKTREE-ADD-42"])
    def test_add_without_develop_branch_exits_1(self, tmp_path: Path) -> None:
        result = self._add_in_repo(
            self._repo(tmp_path), tmp_path, project_config=self._project(develop=None)
        )
        assert result.exit_code == 1
        assert "error: develop_branch is not set" in result.stderr
        assert not (tmp_path / "wt1").exists()

    @add_test_properties(verifies=["PW-WORKTREE-ADD-44"])
    def test_add_all_numbers_in_use_exits_1(self, tmp_path: Path) -> None:
        repo = self._repo(tmp_path)
        for n in range(1, 10):
            (tmp_path / f"wt{n}" / "myrepo").mkdir(parents=True)
        result = self._add_in_repo(repo, tmp_path, project_config=self._project(develop="develop"))
        assert result.exit_code == 1
        assert "error: all of wt1 to wt9 are in use" in result.stderr
        assert not (tmp_path / "wt10").exists()

    @add_test_properties(verifies=["PW-WORKTREE-ADD-47"])
    def test_add_git_worktree_add_failure_prints_error(self, tmp_path: Path) -> None:
        result = self._add_in_repo(
            self._repo(tmp_path), tmp_path, project_config=self._project(develop="develop")
        )
        assert "error: failed to create the worktree" in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-ADD-48"])
    def test_add_git_worktree_add_failure_exits_1(self, tmp_path: Path) -> None:
        result = self._add_in_repo(
            self._repo(tmp_path), tmp_path, project_config=self._project(develop="develop")
        )
        assert result.exit_code == 1

    @add_test_properties(verifies=["PW-WORKTREE-ADD-50"])
    def test_add_broken_worktree_config_exits_1(self, tmp_path: Path) -> None:
        repo = self._repo(tmp_path)
        (repo / ".pecot" / "config" / "worktree-config.json").write_text("{not json")
        with patch("cli.core.worktree._run_git_worktree_add"):
            result = self._add_in_repo(
                repo, tmp_path, project_config=self._project(develop="develop")
            )
        assert result.exit_code == 1
        assert "error: failed to load the worktree config" in result.stderr

    @staticmethod
    def _project(develop: str | None) -> MagicMock:
        cfg = MagicMock()
        cfg.get_develop_branch.return_value = develop
        return cfg

    @staticmethod
    def _repo(tmp_path: Path) -> Path:
        """<tmp>/base/myrepo に、remote の無い git リポと必須の設定ファイルを置く"""
        from cli.tests.conftest import make_worktree_required_configs

        repo = tmp_path / "base" / "myrepo"
        repo.mkdir(parents=True)
        git_init_and_commit(repo, {"README.md": "hi"})
        make_worktree_required_configs(repo)
        return repo

    @staticmethod
    def _add_in_repo(
        repo: Path,
        tmp_path: Path,
        project_config: MagicMock | None = None,
    ) -> Result:
        """git と設定の読みだけ本物で、remote とアクティブな設定を差し替えて worktree add を打つ"""
        with (
            patch("cli.core.worktree.ensure_devcontainer_environment"),
            patch(
                "cli.core.worktree._read_remote_repos",
                return_value=[("origin", RepoRef(owner="o", repo="myrepo"))],
            ),
            patch("cli.core.worktree.load_active_config", return_value=project_config),
        ):
            return runner.invoke(app, ["worktree", "add", "-D", str(repo)])


# worktree remove


class TestWorktreeRemove:
    @patch("cli.core.worktree.remove_worktree")
    def test_remove_ok(self, mock_remove: MagicMock, tmp_path: Path) -> None:
        mock_remove.return_value = None
        result = runner.invoke(app, ["worktree", "remove", "wt1", "-D", str(tmp_path)])
        assert result.exit_code == 0

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-16"])
    @patch("cli.core.worktree.remove_worktree")
    def test_remove_error(self, mock_remove: MagicMock, tmp_path: Path) -> None:
        mock_remove.side_effect = RuntimeError("not found")
        result = runner.invoke(app, ["worktree", "remove", "wt1", "-D", str(tmp_path)])
        assert result.exit_code == 1

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-06"])
    @patch("cli.core.worktree.remove_worktree")
    def test_remove_keep_branch(self, mock_remove: MagicMock, tmp_path: Path) -> None:
        result = runner.invoke(
            app, ["worktree", "remove", "wt1", "--keep-branch", "-D", str(tmp_path)]
        )
        assert result.exit_code == 0
        assert mock_remove.call_args.kwargs["keep_branch"] is True
        assert "removed: worktree wt1" in result.stderr
        assert "local branch" not in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-07"])
    @patch("cli.core.worktree.remove_worktree")
    def test_remove_deletes_branch_by_default(self, mock_remove: MagicMock, tmp_path: Path) -> None:
        mock_remove.return_value = None
        result = runner.invoke(app, ["worktree", "remove", "wt1", "-D", str(tmp_path)])
        assert result.exit_code == 0
        assert mock_remove.call_args.kwargs["keep_branch"] is False
        assert "deleted: local branch wt1" in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-07"])
    @patch("cli.core.worktree.remove_worktree")
    def test_remove_force(self, mock_remove: MagicMock, tmp_path: Path) -> None:
        mock_remove.return_value = None
        result = runner.invoke(app, ["worktree", "remove", "wt1", "--force", "-D", str(tmp_path)])
        assert result.exit_code == 0
        assert mock_remove.call_args.kwargs["force"] is True
        assert "deleted: local branch wt1" in result.stderr

    @add_test_properties(
        verifies=["PW-WORKTREE-REMOVE-06", "PW-WORKTREE-REMOVE-09", "PW-WORKTREE-REMOVE-23"]
    )
    @patch("cli.core.worktree.remove_worktree")
    def test_remove_branch_delete_failure_warns(
        self, mock_remove: MagicMock, tmp_path: Path
    ) -> None:
        mock_remove.return_value = "error: branch 'wt1' not found"
        result = runner.invoke(app, ["worktree", "remove", "wt1", "-D", str(tmp_path)])
        assert result.exit_code == 0
        assert "removed: worktree wt1" in result.stderr
        assert "warning: could not delete local branch wt1: error: branch 'wt1' not found" in (
            result.stderr
        )
        assert "deleted: local branch" not in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-11", "PW-WORKTREE-REMOVE-12"])
    @patch("cli.core.worktree.run_git")
    def test_remove_unknown_name(self, mock_git: MagicMock, tmp_path: Path) -> None:
        mock_git.return_value = MagicMock(
            returncode=0,
            stdout=f"worktree {tmp_path}\nHEAD {'a' * 40}\nbranch refs/heads/main\n",
            stderr="",
        )
        result = runner.invoke(app, ["worktree", "remove", "nope", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: worktree not found: nope" in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-14"])
    def test_remove_git_failure_exits_1(self, tmp_path: Path) -> None:
        result = self._remove_with_git_failure(tmp_path)
        assert result.exit_code == 1

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-15"])
    def test_remove_git_failure_prints_error_line(self, tmp_path: Path) -> None:
        result = self._remove_with_git_failure(tmp_path)
        assert "error: failed to remove the worktree: fatal: has changes\n" in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-15"])
    @patch("cli.core.worktree.remove_worktree")
    def test_remove_runtime_error_prints_error_line(
        self, mock_remove: MagicMock, tmp_path: Path
    ) -> None:
        mock_remove.side_effect = RuntimeError("not found")
        result = runner.invoke(app, ["worktree", "remove", "wt1", "-D", str(tmp_path)])
        assert "error: not found\n" in result.stderr

    @staticmethod
    def _remove_with_git_failure(tmp_path: Path) -> Result:
        """git worktree remove が変更ありで失敗する状態で worktree remove を打つ"""
        main_wt = tmp_path / "base" / "myrepo"
        main_wt.mkdir(parents=True)
        wt = tmp_path / "wt1" / "myrepo"
        listing = (
            f"worktree {main_wt}\nHEAD {'a' * 40}\nbranch refs/heads/main\n\n"
            f"worktree {wt}\nHEAD {'a' * 40}\nbranch refs/heads/wt1\n"
        )

        def fake_git(args: list[str], *_a: object, **_k: object) -> MagicMock:
            if args[:2] == ["worktree", "remove"]:
                return MagicMock(returncode=1, stdout="", stderr="fatal: has changes")
            return MagicMock(returncode=0, stdout=listing, stderr="")

        with (
            patch("cli.core.worktree.ensure_devcontainer_environment"),
            patch("cli.core.worktree.run_git", side_effect=fake_git),
            patch("cli.core.worktree._read_recorded_name_of", return_value="wt1"),
            patch("cli.core.worktree.find_main_worktree", return_value=main_wt),
        ):
            return runner.invoke(app, ["worktree", "remove", "wt1", "-D", str(main_wt)])


# worktree init


class TestWorktreeInit:
    @add_test_properties(verifies=["PW-WORKTREE-INIT-01"])
    def test_init_creates_v3_template(self, tmp_path: Path) -> None:
        with (
            patch("cli.core.worktree.find_main_worktree", return_value=tmp_path),
            patch("cli.core.config.load_active_config", return_value=None),
        ):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])
        assert result.exit_code == 0
        config_path = tmp_path / ".pecot" / "config" / "worktree-config.json"
        assert config_path.exists()
        data = json.loads(config_path.read_text())
        assert data["version"] == 3
        paths = [link["path"] for link in data["links"]]
        assert "CLAUDE.local.md" in paths
        assert ".claude/settings.local.json" in paths
        # setup_command はデフォルト None なので出力されない
        assert "setup_command" not in data

    @add_test_properties(
        verifies=["PW-WORKTREE-INIT-16", "PW-WORKTREE-INIT-17", "PW-WORKTREE-INIT-18"]
    )
    def test_init_fails_on_invalid_active_config(self, tmp_path: Path) -> None:
        with (
            patch("cli.core.worktree.find_main_worktree", return_value=tmp_path),
            patch("cli.core.config.load_active_config", side_effect=ValueError("bad format")),
        ):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: could not read the active config: bad format" in result.stderr
        assert not (tmp_path / ".pecot" / "config" / "worktree-config.json").exists()
        assert not (tmp_path / ".pecot" / "config" / ".worktreeignore").exists()

    @add_test_properties(verifies=["PW-WORKTREE-INIT-02", "PW-WORKTREE-INIT-05"])
    def test_init_creates_worktreeignore(self, tmp_path: Path) -> None:
        """init は .worktreeignore も同時に生成する"""
        with (
            patch("cli.core.worktree.find_main_worktree", return_value=tmp_path),
            patch("cli.core.config.load_active_config", return_value=None),
        ):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])
        assert result.exit_code == 0
        ignore_path = tmp_path / ".pecot" / "config" / ".worktreeignore"
        assert ignore_path.exists()
        content = ignore_path.read_text()
        # 代表的なパターンが入っていること
        assert ".git/" in content
        assert "__pycache__/" in content
        assert "*.pyc" in content
        assert "node_modules/" in content
        assert ".pecot/" in content
        # CLI 出力にも両ファイル名が載る
        assert "worktree-config.json" in result.output
        assert ".worktreeignore" in result.output

    @add_test_properties(
        verifies=["PW-WORKTREE-INIT-01", "PW-WORKTREE-INIT-02", "PW-WORKTREE-INIT-05"]
    )
    def test_init_creates_both_files_in_single_invocation(self, tmp_path: Path) -> None:
        """1 回の `pecot worktree init` で worktree-config.json と .worktreeignore の
        両方が揃う（片方だけ作られる中間状態が存在しない）ことを保証"""
        with (
            patch("cli.core.worktree.find_main_worktree", return_value=tmp_path),
            patch("cli.core.config.load_active_config", return_value=None),
        ):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])

        assert result.exit_code == 0
        config_path = tmp_path / ".pecot" / "config" / "worktree-config.json"
        ignore_path = tmp_path / ".pecot" / "config" / ".worktreeignore"

        # 両方存在する
        assert config_path.exists()
        assert ignore_path.exists()

        # config は v3 JSON、ignore は gitignore テキスト
        data = json.loads(config_path.read_text())
        assert data["version"] == 3
        ignore_content = ignore_path.read_text()
        assert ".git/" in ignore_content
        assert ".pecot/" in ignore_content

        # CLI 出力に両ファイルが報告されている
        assert "worktree-config.json" in result.output
        assert ".worktreeignore" in result.output

    @add_test_properties(verifies=["PW-WORKTREE-INIT-08"])
    def test_init_exists_config_only(self, tmp_path: Path) -> None:
        """worktree-config.json だけ既存でも exit 1"""
        config_path = tmp_path / ".pecot" / "config" / "worktree-config.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text("{}")
        with patch("cli.core.worktree.find_main_worktree", return_value=tmp_path):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: worktree config already exists" in result.output

    @add_test_properties(verifies=["PW-WORKTREE-INIT-07", "PW-WORKTREE-INIT-08"])
    def test_init_exists_ignore_only(self, tmp_path: Path) -> None:
        """.worktreeignore だけ既存でも exit 1"""
        ignore_path = tmp_path / ".pecot" / "config" / ".worktreeignore"
        ignore_path.parent.mkdir(parents=True)
        ignore_path.write_text(".git/\n")
        with patch("cli.core.worktree.find_main_worktree", return_value=tmp_path):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: worktree config already exists" in result.output
        assert ".worktreeignore" in result.output

    @add_test_properties(verifies=["PW-WORKTREE-INIT-04"])
    def test_init_target_repo_fallbacks_to_self_when_no_project(self, tmp_path: Path) -> None:
        """active project が無い場合、target_repo は main WT のディレクトリ名に揃う"""
        main_wt = tmp_path / "myrepo"
        main_wt.mkdir()
        with (
            patch("cli.core.worktree.find_main_worktree", return_value=main_wt),
            patch("cli.core.config.load_active_config", return_value=None),
        ):
            result = runner.invoke(app, ["worktree", "init", "-D", str(main_wt)])
        assert result.exit_code == 0
        data = json.loads((main_wt / ".pecot" / "config" / "worktree-config.json").read_text())
        # 共有 link 群（CLAUDE.local.md / .env / .claude/settings.local.json）の
        # target_repo が self に解決される
        shared = [link for link in data["links"] if link["path"] == "CLAUDE.local.md"]
        assert shared and shared[0]["target_repo"] == "myrepo"

    @staticmethod
    def _project_config(aggregation_repo: str | None) -> ProjectConfig:
        return ProjectConfig(
            host="github.com",
            owner="owner",
            workflow_suffix="x",
            project=Project(
                number=1,
                id="proj-id",
                fields=ProjectFields(
                    workflow=FieldOptions(id="F_workflow", options={"ready": "o_ready"})
                ),
            ),
            repositories=[
                Repository(owner="owner", name="first-repo"),
                Repository(owner="owner", name="myrepo"),
            ],
            aggregation_repo=aggregation_repo,
        )

    def _init_targets(self, tmp_path: Path, aggregation_repo: str | None) -> dict[str, str]:
        main_wt = tmp_path / "myrepo"
        main_wt.mkdir()
        with (
            patch("cli.core.worktree.find_main_worktree", return_value=main_wt),
            patch(
                "cli.core.config.load_active_config",
                return_value=self._project_config(aggregation_repo),
            ),
        ):
            result = runner.invoke(app, ["worktree", "init", "-D", str(main_wt)])
        assert result.exit_code == 0
        data = json.loads((main_wt / ".pecot" / "config" / "worktree-config.json").read_text())
        return {link["path"]: link["target_repo"] for link in data["links"]}

    @add_test_properties(verifies=["PW-WORKTREE-INIT-03"])
    def test_init_shared_links_point_to_aggregation_repo(self, tmp_path: Path) -> None:
        """aggregation_repo があれば、共有 3 リンクはそのリポ、自リポ 3 リンクは main WT のディレクトリ名を指す"""
        assert self._init_targets(tmp_path, "owner/roadmap-repo") == {
            "CLAUDE.local.md": "roadmap-repo",
            ".env": "roadmap-repo",
            ".claude/settings.local.json": "roadmap-repo",
            ".pecot/config/hooks-config.json": "myrepo",
            ".pecot/config/projects/.active": "myrepo",
            ".pecot/work": "myrepo",
        }

    @add_test_properties(verifies=["PW-WORKTREE-INIT-04"])
    def test_init_shared_links_point_to_self_without_aggregation_repo(self, tmp_path: Path) -> None:
        """aggregation_repo が無ければ、repositories に別のリポがあっても共有 3 リンクは自リポを指す"""
        assert set(self._init_targets(tmp_path, None).values()) == {"myrepo"}

    @add_test_properties(verifies=["PW-WORKTREE-INIT-06"])
    def test_init_existing_config_leaves_ignore_file_uncreated(self, tmp_path: Path) -> None:
        config_path = tmp_path / ".pecot" / "config" / "worktree-config.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text("{}")
        with patch("cli.core.worktree.find_main_worktree", return_value=tmp_path):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert not (tmp_path / ".pecot" / "config" / ".worktreeignore").exists()
        assert config_path.read_text() == "{}"

    @add_test_properties(verifies=["PW-WORKTREE-INIT-06"])
    def test_init_existing_ignore_file_leaves_config_uncreated(self, tmp_path: Path) -> None:
        ignore_path = tmp_path / ".pecot" / "config" / ".worktreeignore"
        ignore_path.parent.mkdir(parents=True)
        ignore_path.write_text(".git/\n")
        with patch("cli.core.worktree.find_main_worktree", return_value=tmp_path):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert not (tmp_path / ".pecot" / "config" / "worktree-config.json").exists()
        assert ignore_path.read_text() == ".git/\n"

    @add_test_properties(verifies=["PW-WORKTREE-INIT-09"])
    def test_init_main_worktree_lookup_failure_exits_1(self, tmp_path: Path) -> None:
        with (
            patch("cli.core.worktree.ensure_devcontainer_environment"),
            patch(
                "cli.core.worktree.find_main_worktree",
                side_effect=RuntimeError("cannot get the worktree list"),
            ),
        ):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: cannot get the worktree list" in result.stderr


# worktree link


class TestWorktreeLink:
    @add_test_properties(verifies=["PW-WORKTREE-LINK-21", "PW-WORKTREE-LINK-22"])
    def test_link_no_config(self, tmp_path: Path) -> None:
        with patch("cli.core.worktree_links.find_config_file", return_value=None):
            result = runner.invoke(app, ["worktree", "link", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: worktree config not found" in result.output
        assert "run: pecot worktree init -D <directory>" in result.output

    def _run_link(
        self,
        tmp_path: Path,
        path: str,
        target_path: str,
        args: list[str] | None = None,
        input: str | None = None,
    ) -> Result:
        """<tmp>/wt1/myrepo で worktree link を打つ（link 先は <tmp>/base/src）"""
        from cli.core.worktree_links import WorktreeConfig, WorktreeLinkItem

        (tmp_path / "base" / "myrepo").mkdir(parents=True)
        (tmp_path / "base" / "src").mkdir(parents=True)
        (tmp_path / "base" / "src" / target_path).write_text("shared")
        wt = tmp_path / "wt1" / "myrepo"
        wt.mkdir(parents=True, exist_ok=True)
        config = WorktreeConfig(
            links=[WorktreeLinkItem(path=path, target_repo="src", target_path=target_path)]
        )
        with (
            patch("cli.core.worktree.ensure_devcontainer_environment"),
            patch(
                "cli.core.worktree.find_main_worktree", return_value=tmp_path / "base" / "myrepo"
            ),
            patch("cli.core.worktree.detect_project_root", return_value=tmp_path),
            patch("cli.core.worktree_links.find_config_file", return_value=tmp_path / "cfg"),
            patch("cli.core.worktree_links.load_config", return_value=config),
        ):
            return runner.invoke(
                app,
                ["worktree", "link", "-D", str(wt), *(["--force"] if args is None else args)],
                input=input,
            )

    def _real_file_link(
        self, tmp_path: Path, args: list[str], input: str | None = None
    ) -> tuple[Result, Path]:
        """配置先に実ファイルがある状態で worktree link を打つ（実ファイルのパスも返す）"""
        real = tmp_path / "wt1" / "myrepo" / "a.txt"
        real.parent.mkdir(parents=True, exist_ok=True)
        real.write_text("local")
        with patch("cli.core.worktree.get_worktree_dirs", return_value=[real.parent]):
            result = self._run_link(tmp_path, "a.txt", "a.txt", args=args, input=input)
        return result, real

    @add_test_properties(verifies=["PW-WORKTREE-LINK-18"])
    def test_link_tracked_path_is_one_warning(self, tmp_path: Path) -> None:
        wt = tmp_path / "wt1" / "myrepo"
        wt.mkdir(parents=True, exist_ok=True)
        git_init_and_commit(wt, {"README.md": "x"})
        result = self._run_link(tmp_path, "README.md", "README.md")
        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        tracked = f"warning: symlink creation skipped because the path is tracked by git: {wt / 'README.md'}"
        assert lines.count(tracked) == 1
        assert not any(ln.startswith(("error:", "warning: symlink /")) for ln in lines)

    @add_test_properties(verifies=["PW-WORKTREE-LINK-18"])
    def test_link_symlink_failure_is_one_warning(self, tmp_path: Path) -> None:
        wt = tmp_path / "wt1" / "myrepo"
        wt.mkdir(parents=True, exist_ok=True)
        (wt / "a").write_text("plain file")
        result = self._run_link(tmp_path, "a/b", "b")
        assert result.exit_code == 0
        lines = result.stderr.splitlines()
        assert (
            len([ln for ln in lines if ln.startswith("warning: failed to create the symlink:")])
            == 1
        )
        assert not any(ln.startswith(("error:", "warning: symlink /")) for ln in lines)

    @add_test_properties(
        verifies=["PW-WORKTREE-LINK-05", "PW-WORKTREE-LINK-06", "PW-WORKTREE-LINK-07"]
    )
    def test_link_real_file_answered_y_is_replaced(self, tmp_path: Path) -> None:
        result, real = self._real_file_link(tmp_path, [], input="y\n")
        assert result.exit_code == 0
        assert "real file exists" in result.stderr
        assert real.is_symlink()

    def test_link_real_file_answered_n_is_kept(self, tmp_path: Path) -> None:
        result, real = self._real_file_link(tmp_path, [], input="n\n")
        assert result.exit_code == 0
        assert not real.is_symlink()
        assert real.read_text() == "local"

    def test_link_real_file_eof_is_kept(self, tmp_path: Path) -> None:
        result, real = self._real_file_link(tmp_path, [], input="")
        assert not real.is_symlink()
        assert real.read_text() == "local"

    @add_test_properties(verifies=["PW-WORKTREE-LINK-10"])
    def test_link_real_file_with_all_is_skipped_without_asking(self, tmp_path: Path) -> None:
        result, real = self._real_file_link(tmp_path, ["--all"])
        assert result.exit_code == 0
        assert "overwrite it?" not in result.stderr
        assert not real.is_symlink()
        assert real.read_text() == "local"

    @add_test_properties(
        verifies=["PW-WORKTREE-LINK-01", "PW-WORKTREE-LINK-08", "PW-WORKTREE-LINK-09"]
    )
    def test_link_real_file_with_force_is_replaced_without_asking(self, tmp_path: Path) -> None:
        result, real = self._real_file_link(tmp_path, ["--force"])
        assert result.exit_code == 0
        assert "overwrite it?" not in result.stderr
        assert real.is_symlink()

    @add_test_properties(verifies=["PW-WORKTREE-LINK-11"])
    def test_link_dry_run_all_real_file_is_skip(self, tmp_path: Path) -> None:
        result, real = self._real_file_link(tmp_path, ["--all", "--dry-run"])
        assert result.exit_code == 0
        assert f"symlink {real} (a real file exists)" in result.output
        assert not real.is_symlink()

    @add_test_properties(verifies=["PW-WORKTREE-LINK-11", "PW-WORKTREE-LINK-16"])
    def test_link_dry_run_force_real_file_is_update(self, tmp_path: Path) -> None:
        result, real = self._real_file_link(tmp_path, ["--force", "--dry-run"])
        assert result.exit_code == 0
        assert f"symlink {real} -> " in result.output
        assert "a real file exists" not in result.output
        assert not real.is_symlink()

    @add_test_properties(verifies=["PW-WORKTREE-LINK-16"])
    def test_link_dry_run_single_real_file_asks_first(self, tmp_path: Path) -> None:
        result, real = self._real_file_link(tmp_path, ["--dry-run"])
        assert result.exit_code == 0
        assert "(real file, asks first)" in result.output
        assert not real.is_symlink()

    @add_test_properties(verifies=["PW-WORKTREE-LINK-11", "PW-WORKTREE-LINK-16"])
    def test_link_dry_run_tracked_path_is_skip(self, tmp_path: Path) -> None:
        wt = tmp_path / "wt1" / "myrepo"
        wt.mkdir(parents=True, exist_ok=True)
        git_init_and_commit(wt, {"README.md": "x"})
        result = self._run_link(tmp_path, "README.md", "README.md", args=["--dry-run"])
        assert result.exit_code == 0
        assert f"symlink {wt / 'README.md'} (tracked by git)" in result.output
        assert not (wt / "README.md").is_symlink()

    @add_test_properties(verifies=["PW-WORKTREE-LINK-01", "PW-WORKTREE-LINK-34"])
    def test_link_from_subdirectory_targets_worktree_root(self, tmp_path: Path) -> None:
        wt = tmp_path / "wt1" / "myrepo"
        wt.mkdir(parents=True, exist_ok=True)
        git_init_and_commit(wt, {"keep.md": "x"})
        sub = wt / "sub" / "dir"
        sub.mkdir(parents=True)
        # _run_link は wt を -D に渡すので、サブディレクトリを渡す形で直接打つ
        (tmp_path / "base" / "myrepo").mkdir(parents=True)
        (tmp_path / "base" / "src").mkdir(parents=True)
        (tmp_path / "base" / "src" / "a.txt").write_text("shared")
        from cli.core.worktree_links import WorktreeConfig, WorktreeLinkItem

        config = WorktreeConfig(
            links=[WorktreeLinkItem(path="a.txt", target_repo="src", target_path="a.txt")]
        )
        with (
            patch("cli.core.worktree.ensure_devcontainer_environment"),
            patch(
                "cli.core.worktree.find_main_worktree", return_value=tmp_path / "base" / "myrepo"
            ),
            patch("cli.core.worktree.detect_project_root", return_value=tmp_path),
            patch("cli.core.worktree_links.find_config_file", return_value=tmp_path / "cfg"),
            patch("cli.core.worktree_links.load_config", return_value=config),
        ):
            result = runner.invoke(app, ["worktree", "link", "-D", str(sub), "--force"])
        assert result.exit_code == 0
        assert (wt / "a.txt").is_symlink()
        assert not (sub / "a.txt").exists()

    def _invoke_link(
        self,
        tmp_path: Path,
        directory: Path,
        args: list[str],
        detect_root: object = None,
    ) -> Result:
        """設定は差し替え、-D に directory を渡して worktree link を打つ（メインの worktree は <tmp>/base/myrepo）"""
        from cli.core.worktree_links import WorktreeConfig, WorktreeLinkItem

        config = WorktreeConfig(
            links=[WorktreeLinkItem(path="a.txt", target_repo="src", target_path="a.txt")]
        )
        root_patch = (
            {"side_effect": detect_root}
            if isinstance(detect_root, Exception)
            else {"return_value": tmp_path}
        )
        with (
            patch("cli.core.worktree.ensure_devcontainer_environment"),
            patch(
                "cli.core.worktree.find_main_worktree", return_value=tmp_path / "base" / "myrepo"
            ),
            patch("cli.core.worktree.detect_project_root", **root_patch),
            patch("cli.core.worktree_links.find_config_file", return_value=tmp_path / "cfg"),
            patch("cli.core.worktree_links.load_config", return_value=config),
        ):
            return runner.invoke(app, ["worktree", "link", "-D", str(directory), *args])

    def _two_worktrees(self, tmp_path: Path) -> list[Path]:
        (tmp_path / "base" / "myrepo").mkdir(parents=True)
        (tmp_path / "base" / "src").mkdir(parents=True)
        (tmp_path / "base" / "src" / "a.txt").write_text("shared")
        wts = [tmp_path / "wt1" / "myrepo", tmp_path / "wt2" / "myrepo"]
        for wt in wts:
            wt.mkdir(parents=True)
        return wts

    @add_test_properties(verifies=["PW-WORKTREE-LINK-02"])
    def test_link_all_links_every_sub_worktree(self, tmp_path: Path) -> None:
        wts = self._two_worktrees(tmp_path)
        with patch("cli.core.worktree.get_worktree_dirs", return_value=wts):
            result = self._invoke_link(tmp_path, wts[0], ["--all"])
        assert result.exit_code == 0
        assert all((wt / "a.txt").is_symlink() for wt in wts)

    @add_test_properties(verifies=["PW-WORKTREE-LINK-12"])
    def test_link_all_without_sub_worktrees_prints_zero_count(self, tmp_path: Path) -> None:
        self._two_worktrees(tmp_path)
        with patch("cli.core.worktree.get_worktree_dirs", return_value=[]):
            result = self._invoke_link(tmp_path, tmp_path / "base" / "myrepo", ["--all"])
        assert result.exit_code == 0
        assert "count: sub-worktrees: 0" in result.stderr.splitlines()

    @add_test_properties(verifies=["PW-WORKTREE-LINK-13"])
    def test_link_prints_symlinks_created_count_per_worktree(self, tmp_path: Path) -> None:
        result = self._run_link(tmp_path, "a.txt", "a.txt")
        wt = (tmp_path / "wt1" / "myrepo").resolve()
        assert result.exit_code == 0
        assert f"count: symlinks created in {wt}: 1" in result.stderr.splitlines()

    @add_test_properties(verifies=["PW-WORKTREE-LINK-14"])
    def test_link_all_prints_total_counts(self, tmp_path: Path) -> None:
        wts = self._two_worktrees(tmp_path)
        with patch("cli.core.worktree.get_worktree_dirs", return_value=wts):
            result = self._invoke_link(tmp_path, wts[0], ["--all"])
        lines = result.stderr.splitlines()
        assert "count: symlinks created: 2" in lines
        assert "count: symlinks skipped: 0" in lines
        assert "count: symlink errors: 0" in lines

    @add_test_properties(verifies=["PW-WORKTREE-LINK-15"])
    def test_link_skipped_result_prints_skip_line(self, tmp_path: Path) -> None:
        result, real = self._real_file_link(tmp_path, ["--all"])
        assert f"skipped: symlink {real} (a real file exists: {real})" in (
            result.stderr.splitlines()
        )

    @add_test_properties(verifies=["PW-WORKTREE-LINK-20"])
    def test_link_real_file_eof_exits_1(self, tmp_path: Path) -> None:
        result, _real = self._real_file_link(tmp_path, [], input="")
        assert result.exit_code == 1

    @add_test_properties(verifies=["PW-WORKTREE-LINK-25"])
    def test_link_in_main_worktree_without_all_prints_error(self, tmp_path: Path) -> None:
        self._two_worktrees(tmp_path)
        result = self._invoke_link(tmp_path, tmp_path / "base" / "myrepo", [])
        assert "error: use --all in the main worktree\n" in result.stderr

    @add_test_properties(verifies=["PW-WORKTREE-LINK-26"])
    def test_link_in_main_worktree_without_all_exits_1(self, tmp_path: Path) -> None:
        self._two_worktrees(tmp_path)
        result = self._invoke_link(tmp_path, tmp_path / "base" / "myrepo", [])
        assert result.exit_code == 1

    @add_test_properties(verifies=["PW-WORKTREE-LINK-27"])
    def test_link_project_root_failure_exits_1(self, tmp_path: Path) -> None:
        wts = self._two_worktrees(tmp_path)
        result = self._invoke_link(
            tmp_path, wts[0], [], detect_root=RuntimeError("this repository is not placed")
        )
        assert result.exit_code == 1
        assert "error: this repository is not placed\n" in result.stderr


# devcontainer 前提ガード


class TestDevcontainerGuard:
    """devcontainer の外では、4 コマンドとも error: の 1 行と終了コード 1 で止まる"""

    MESSAGE = "このコマンドは devcontainer 内で実行してください。"

    def _assert_error_line(self, result: Result) -> None:
        assert result.exit_code == 1
        assert any(line.startswith("error: ") for line in result.stderr.splitlines())
        assert self.MESSAGE in result.stderr
        assert "Traceback" not in result.output + result.stderr

    def _invoke_outside(self, tmp_path: Path, args: list[str]) -> Result:
        with patch(
            "cli.core.worktree.ensure_devcontainer_environment",
            side_effect=RuntimeError(self.MESSAGE),
        ):
            return runner.invoke(app, ["worktree", *args, "-D", str(tmp_path)])

    @add_test_properties(verifies=["PW-WORKTREE-ADD-30", "PW-WORKTREE-ADD-31"])
    def test_add_fails_outside_devcontainer(self, tmp_path: Path) -> None:
        self._assert_error_line(self._invoke_outside(tmp_path, ["add"]))

    @add_test_properties(verifies=["PW-WORKTREE-REMOVE-21", "PW-WORKTREE-REMOVE-22"])
    def test_remove_fails_outside_devcontainer(self, tmp_path: Path) -> None:
        self._assert_error_line(self._invoke_outside(tmp_path, ["remove", "wt1"]))

    @add_test_properties(verifies=["PW-WORKTREE-INIT-14", "PW-WORKTREE-INIT-15"])
    def test_init_fails_outside_devcontainer(self, tmp_path: Path) -> None:
        self._assert_error_line(self._invoke_outside(tmp_path, ["init"]))

    @add_test_properties(verifies=["PW-WORKTREE-LINK-32", "PW-WORKTREE-LINK-33"])
    def test_link_fails_outside_devcontainer(self, tmp_path: Path) -> None:
        self._assert_error_line(self._invoke_outside(tmp_path, ["link"]))


class TestLinkInvalidConfig:
    @add_test_properties(verifies=["PW-WORKTREE-LINK-23", "PW-WORKTREE-LINK-24"])
    def test_malformed_json_is_error_line(self, tmp_path: Path) -> None:
        cfg = tmp_path / "worktree-config.json"
        cfg.write_text("{not json", encoding="utf-8")
        with (
            patch("cli.core.worktree.ensure_devcontainer_environment"),
            patch("cli.core.worktree_links.find_config_file", return_value=cfg),
        ):
            result = runner.invoke(app, ["worktree", "link", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert any(
            line.startswith("error: JSON parse error:") for line in result.stderr.splitlines()
        )
        assert "Traceback" not in result.output + result.stderr
