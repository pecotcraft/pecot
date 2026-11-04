"""tests/core/test_config_aggregation.py - T059: aggregation_repo フィールド検証。

config-schema.md §テスト観点に準拠。
- 未指定 → None
- 正常値 "a/b" → aggregation_repo_ref == RepoRef("a","b")
- 不正形式 "a" → ValidationError
- 配列 ["a/b"] → ValidationError
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from cli.core.config import ProjectConfig
from cli.core.repo_resolver import RepoRef


def _base_config_dict() -> dict:
    return {
        "host": "github.com",
        "owner": "acme-labs",
        "workflow_suffix": "pecot",
        "project": {
            "number": 1,
            "id": "PVT_xxx",
            "fields": {
                "workflow": {
                    "id": "F_workflow",
                    "options": {
                        "backlog": "o1",
                        "active": "o2",
                    },
                }
            },
        },
        "repositories": [],
    }


class TestAggregationRepoField:
    def test_unspecified_defaults_to_none(self) -> None:
        cfg = ProjectConfig.model_validate(_base_config_dict())
        assert cfg.aggregation_repo is None
        assert cfg.aggregation_repo_ref is None

    def test_explicit_none(self) -> None:
        data = _base_config_dict()
        data["aggregation_repo"] = None
        cfg = ProjectConfig.model_validate(data)
        assert cfg.aggregation_repo is None
        assert cfg.aggregation_repo_ref is None

    def test_valid_owner_repo(self) -> None:
        data = _base_config_dict()
        data["aggregation_repo"] = "a/b"
        cfg = ProjectConfig.model_validate(data)
        assert cfg.aggregation_repo == "a/b"
        assert cfg.aggregation_repo_ref == RepoRef(owner="a", repo="b")

    def test_invalid_missing_slash(self) -> None:
        data = _base_config_dict()
        data["aggregation_repo"] = "a"
        with pytest.raises(ValidationError):
            ProjectConfig.model_validate(data)

    def test_invalid_extra_segment(self) -> None:
        data = _base_config_dict()
        data["aggregation_repo"] = "owner/repo/extra"
        with pytest.raises(ValidationError):
            ProjectConfig.model_validate(data)

    def test_rejects_array_value(self) -> None:
        data = _base_config_dict()
        data["aggregation_repo"] = ["a/b"]
        with pytest.raises(ValidationError):
            ProjectConfig.model_validate(data)

    def test_rejects_empty_string(self) -> None:
        data = _base_config_dict()
        data["aggregation_repo"] = ""
        with pytest.raises(ValidationError):
            ProjectConfig.model_validate(data)
