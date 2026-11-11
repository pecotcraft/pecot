"""tests/cli/test_options.py - cli/options.py のユニットテスト

Phase 2 Foundational (T015) — ``_validate_repo_option`` 検証。
"""

from __future__ import annotations

import pytest
import typer
from ub_test_reports.pytest_plugin import add_test_properties

from cli.commands.options import (
    RepoOption,
    ShowRepoOption,
    _validate_repo_option,
)


class TestValidateRepoOption:
    def test_none_returns_none(self) -> None:
        assert _validate_repo_option(None) is None

    @pytest.mark.parametrize(
        "value",
        ["owner/repo", "my-org/my-repo", "owner.io/my.repo", "a_b/c_d"],
    )
    def test_valid_formats_pass_through(self, value: str) -> None:
        assert _validate_repo_option(value) == value

    @add_test_properties(verifies=["PW-COMMON-10"])
    @pytest.mark.parametrize(
        "value",
        ["", "ownerrepo", "owner/repo/extra", "owner with space/repo", "owner/"],
    )
    def test_invalid_raises_bad_parameter(self, value: str) -> None:
        with pytest.raises(typer.BadParameter):
            _validate_repo_option(value)


class TestAnnotatedTypesExist:
    def test_repo_option_importable(self) -> None:
        assert RepoOption is not None

    def test_show_repo_option_importable(self) -> None:
        assert ShowRepoOption is not None
