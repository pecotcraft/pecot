"""tests/cli/test_worktree.py - worktree CLI サブコマンドのテスト (v2)"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner, Result

from cli.commands.main import app
from cli.core.config import FieldOptions, Project, ProjectConfig, ProjectFields, Repository
from cli.core.worktree import SetupResult, WorktreeCreateResult
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

    @patch("cli.core.worktree.create_worktree")
    def test_add_core_warning_has_prefix(self, mock_create: MagicMock, tmp_path: Path) -> None:
        """main の import だけで handler が付き、core の警告が `warning:` 付きで出る"""
        from cli.core.worktree_links import WorktreeLinkItem, _process_link

        def create(*_args: object, **_kwargs: object) -> WorktreeCreateResult:
            link = WorktreeLinkItem(path="x", target_repo="none", target_path="missing")
            _process_link(link, tmp_path, "wt1", "repo", lambda *_: False)
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
            r = _process_link(link, tmp_path, "wt1", "repo", lambda *_: False)
            return self._created(tmp_path, linked_files=[r])

        mock_create.side_effect = create
        return runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])


# worktree remove


class TestWorktreeRemove:
    @patch("cli.core.worktree.remove_worktree")
    def test_remove_ok(self, mock_remove: MagicMock, tmp_path: Path) -> None:
        mock_remove.return_value = None
        result = runner.invoke(app, ["worktree", "remove", "wt1", "-D", str(tmp_path)])
        assert result.exit_code == 0

    @patch("cli.core.worktree.remove_worktree")
    def test_remove_error(self, mock_remove: MagicMock, tmp_path: Path) -> None:
        mock_remove.side_effect = RuntimeError("not found")
        result = runner.invoke(app, ["worktree", "remove", "wt1", "-D", str(tmp_path)])
        assert result.exit_code == 1


# worktree init


class TestWorktreeInit:
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

    def test_init_exists_config_only(self, tmp_path: Path) -> None:
        """worktree-config.json だけ既存でも exit 1"""
        config_path = tmp_path / ".pecot" / "config" / "worktree-config.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text("{}")
        with patch("cli.core.worktree.find_main_worktree", return_value=tmp_path):
            result = runner.invoke(app, ["worktree", "init", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: worktree config already exists" in result.output

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

    def test_init_shared_links_point_to_self_without_aggregation_repo(self, tmp_path: Path) -> None:
        """aggregation_repo が無ければ、repositories に別のリポがあっても共有 3 リンクは自リポを指す"""
        assert set(self._init_targets(tmp_path, None).values()) == {"myrepo"}


# worktree link


class TestWorktreeLink:
    def test_link_no_config(self, tmp_path: Path) -> None:
        with patch("cli.core.worktree_links.find_config_file", return_value=None):
            result = runner.invoke(app, ["worktree", "link", "-D", str(tmp_path)])
        assert result.exit_code == 1
        assert "error: worktree config not found" in result.output
        assert "run: pecot worktree init -D <directory>" in result.output

    def _run_link(self, tmp_path: Path, path: str, target_path: str) -> Result:
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
            return runner.invoke(app, ["worktree", "link", "-D", str(wt), "--force"])

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


# devcontainer 前提ガード


class TestDevcontainerGuard:
    def test_add_fails_outside_devcontainer(self, tmp_path: Path) -> None:
        """devcontainer 外で pecot worktree add を呼ぶと RuntimeError で非 0 終了"""
        with patch(
            "cli.core.worktree.ensure_devcontainer_environment",
            side_effect=RuntimeError("このコマンドは devcontainer 内で実行してください。"),
        ):
            result = runner.invoke(app, ["worktree", "add", "-D", str(tmp_path)])
        assert result.exit_code != 0
        # RuntimeError は CLI 側の try/except で拾われるか、
        # そうでなくても非 0 終了すればガードの役割を果たしている
