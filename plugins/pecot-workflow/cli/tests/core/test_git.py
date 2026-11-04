"""tests/core/test_git.py - core/git.py のユニットテスト"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from cli.core.git import (
    git_current_branch,
    git_remote_url,
    git_toplevel,
    origin_repo,
    run_git,
)


def _completed(stdout: str = "", returncode: int = 0) -> MagicMock:
    cp = MagicMock()
    cp.stdout = stdout
    cp.returncode = returncode
    return cp


class TestRunGit:
    """run_git のテスト"""

    def test_prepends_git_and_passes_options(self, tmp_path: Path) -> None:
        with patch("subprocess.run", return_value=_completed("ok")) as mock_run:
            result = run_git(["status", "--short"], tmp_path, check=True)

        assert result.stdout == "ok"
        mock_run.assert_called_once_with(
            ["git", "status", "--short"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=True,
            env=None,
        )

    def test_cwd_none_is_passed_through(self) -> None:
        with patch("subprocess.run", return_value=_completed()) as mock_run:
            run_git(["status"], check=False)

        assert mock_run.call_args.kwargs["cwd"] is None
        assert mock_run.call_args.kwargs["check"] is False
        assert mock_run.call_args.kwargs["env"] is None

    def test_strip_git_env_removes_git_variables(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GIT_DIR", "/elsewhere/.git")
        monkeypatch.setenv("PECOT_TEST_KEEP", "1")
        with patch("subprocess.run", return_value=_completed()) as mock_run:
            run_git(["rev-parse", "--show-toplevel"], check=True, strip_git_env=True)

        env = mock_run.call_args.kwargs["env"]
        assert "GIT_DIR" not in env
        assert not any(k.startswith("GIT_") for k in env)
        assert env["PECOT_TEST_KEEP"] == "1"

    def test_check_true_propagates_error(self) -> None:
        err = subprocess.CalledProcessError(128, ["git", "status"])
        with (
            patch("subprocess.run", side_effect=err),
            pytest.raises(subprocess.CalledProcessError),
        ):
            run_git(["status"], check=True)

    def test_check_false_returns_nonzero_result(self, tmp_path: Path) -> None:
        """実 git: リポジトリ外では check=False で非 0 の結果が返る"""
        result = run_git(
            ["rev-parse", "--is-inside-work-tree"], tmp_path, check=False, strip_git_env=True
        )
        assert result.returncode != 0


class TestGitToplevel:
    """git_toplevel のテスト"""

    def test_returns_path(self) -> None:
        with patch("subprocess.run", return_value=_completed("/repo/root\n")) as mock_run:
            assert git_toplevel(Path("/repo/root/sub")) == Path("/repo/root")
        assert mock_run.call_args.args[0] == ["git", "rev-parse", "--show-toplevel"]
        assert mock_run.call_args.kwargs["cwd"] == Path("/repo/root/sub")

    def test_returns_none_on_error(self) -> None:
        with patch("subprocess.run", side_effect=subprocess.CalledProcessError(128, "git")):
            assert git_toplevel() is None

    def test_returns_none_when_git_missing(self) -> None:
        with patch("subprocess.run", side_effect=FileNotFoundError("git")):
            assert git_toplevel() is None

    def test_real_repository(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """実 git: GIT_* を除いて CWD 基準のルートを返す"""
        for key in list(os.environ):
            if key.startswith("GIT_"):
                monkeypatch.delenv(key, raising=False)
        subprocess.run(["git", "init"], cwd=str(tmp_path), capture_output=True, check=True)
        sub = tmp_path / "a" / "b"
        sub.mkdir(parents=True)
        monkeypatch.setenv("GIT_DIR", str(tmp_path / "nonexistent.git"))

        assert git_toplevel(sub, strip_git_env=True) == tmp_path.resolve()

    def test_real_outside_repository(self, tmp_path: Path) -> None:
        assert git_toplevel(tmp_path, strip_git_env=True) is None


class TestGitRemoteUrl:
    """git_remote_url のテスト"""

    def test_returns_stripped_url(self) -> None:
        stdout = "https://github.com/owner/repo.git\n"
        with patch("subprocess.run", return_value=_completed(stdout)) as mock_run:
            assert git_remote_url(Path("/r")) == "https://github.com/owner/repo.git"
        assert mock_run.call_args.args[0] == ["git", "remote", "get-url", "origin"]

    def test_other_remote(self) -> None:
        with patch("subprocess.run", return_value=_completed("u\n")) as mock_run:
            git_remote_url(remote="upstream")
        assert mock_run.call_args.args[0] == ["git", "remote", "get-url", "upstream"]

    def test_returns_none_on_error(self) -> None:
        with patch("subprocess.run", side_effect=subprocess.CalledProcessError(2, "git")):
            assert git_remote_url() is None


class TestGitCurrentBranch:
    """git_current_branch のテスト"""

    def test_returns_branch(self) -> None:
        with patch("subprocess.run", return_value=_completed("feat/x/1\n")) as mock_run:
            assert git_current_branch(Path("/r")) == "feat/x/1"
        assert mock_run.call_args.args[0] == ["git", "rev-parse", "--abbrev-ref", "HEAD"]

    def test_detached_head_returns_head(self) -> None:
        with patch("subprocess.run", return_value=_completed("HEAD\n")):
            assert git_current_branch(Path("/r")) == "HEAD"

    def test_returns_none_on_error(self) -> None:
        with patch("subprocess.run", side_effect=FileNotFoundError("git")):
            assert git_current_branch(Path("/r")) is None


class TestOriginRepo:
    """origin_repo のテスト"""

    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("git@github.com:owner/repo.git", ("github.com", "owner", "repo")),
            ("https://github.com/owner/repo.git", ("github.com", "owner", "repo")),
            (
                "https://ghes.example.com/acme-labs/my.repo.git",
                ("ghes.example.com", "acme-labs", "my.repo"),
            ),
            (
                "ssh://git@ghes.example.com/acme-labs/aist-plugin.git",
                ("ghes.example.com", "acme-labs", "aist-plugin"),
            ),
        ],
    )
    def test_parses_origin_url(self, url: str, expected: tuple[str, str, str]) -> None:
        with patch("subprocess.run", return_value=_completed(url + "\n")):
            assert origin_repo(Path("/r")) == expected

    def test_returns_none_for_unparsable_url(self) -> None:
        with patch("subprocess.run", return_value=_completed("invalid\n")):
            assert origin_repo() is None

    def test_returns_none_without_origin(self) -> None:
        with patch("subprocess.run", side_effect=subprocess.CalledProcessError(2, "git")):
            assert origin_repo() is None
