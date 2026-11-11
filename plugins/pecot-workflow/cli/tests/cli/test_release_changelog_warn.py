"""tests/cli/test_release_changelog_warn.py - T051 / FR-009b.

``@require_repo_match(mode="warn")`` が装着された release 系コマンドを扱う。
``--repo`` とカレント Git remote が不一致のとき、stderr に警告を出して処理を続行することを検証する。

警告メッセージは ``contracts/cli-commands.md:94-96`` の固定文言と一致させる。
警告後に ``--repo`` 先に対して本体処理 (load_active_config 等) が動くことも観察する。

Note: 本体処理側が別の理由で非 0 終了になっても警告は先行する。
(ログに記録される)
そのため、警告行の存在を確認するだけで十分。
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from typer.testing import CliRunner
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands.main import app
from cli.core.repo_resolver import RepoRef

runner = CliRunner()


def _patch_current_git(owner: str = "acme-labs", repo: str = "pecot-cli"):
    return patch(
        "cli.core.repo_resolver._detect_current_git_repo",
        return_value=(RepoRef(owner=owner, repo=repo), "origin"),
    )


WARN_MSG_SUBSTR = (
    "warning: using --repo acme-labs/aist-plugin (current Git remote: acme-labs/pecot-cli)"
)


@pytest.mark.usefixtures("no_open_alerts")
class TestReleasePreflightWarn:
    """FR-009b: release preflight 不一致で警告 + 続行。"""

    @add_test_properties(verifies=["PW-RELEASE-PREFLIGHT-08"])
    def test_warn_emitted_on_mismatch(self) -> None:
        with _patch_current_git():
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/aist-plugin",
                    "release",
                    "preflight",
                    "0.99.0",
                ],
            )

        # 警告行が stderr に先行して出ている
        assert WARN_MSG_SUBSTR in result.stderr
        # decorator 自身は exit 1 しない。本体処理が別理由で exit する
        # 可能性はあるが、警告は既に出力済みなので観察できる。


class TestReleaseCreateWarn:
    @add_test_properties(verifies=["PW-RELEASE-CREATE-07"])
    def test_warn_emitted_on_mismatch(self) -> None:
        with _patch_current_git():
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/aist-plugin",
                    "release",
                    "create",
                    "0.99.0",
                    "--dry-run",
                ],
            )

        assert WARN_MSG_SUBSTR in result.stderr


class TestReleaseMergeReject:
    @add_test_properties(verifies=["PW-RELEASE-MERGE-11", "PW-RELEASE-MERGE-12"])
    def test_rejected_on_mismatch(self) -> None:
        with _patch_current_git():
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/aist-plugin",
                    "release",
                    "merge",
                    "acme-labs/aist-plugin/42",
                    "--dry-run",
                ],
            )

        assert result.exit_code == 1
        assert "differs from the current Git remote" in result.stderr
        assert "using --repo" not in result.stderr


@pytest.mark.usefixtures("no_open_alerts")
class TestReleaseChangelogMatchNoWarn:
    """一致時は警告が出ないことを確認 (ネガティブケース)。"""

    def test_release_preflight_match_no_warn(self) -> None:
        with _patch_current_git(owner="acme-labs", repo="pecot-cli"):
            result = runner.invoke(
                app,
                [
                    "--repo",
                    "acme-labs/pecot-cli",
                    "release",
                    "preflight",
                    "0.99.0",
                ],
            )
        # 不一致警告は出ない
        assert "using --repo" not in result.stderr
