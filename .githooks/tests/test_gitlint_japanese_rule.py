"""gitlint の title-requires-japanese の dependabot 例外のテスト (#69)。

リポの .gitlint を、実際の gitlint で動かす。違反は stderr の規則 ID（UC1）で見分ける。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _gitlint_version() -> str:
    config = (_REPO_ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8")
    found = re.search(
        r"repo:\s*https://github\.com/jorisroovers/gitlint\s*\n\s*rev:\s*\"?v?([0-9.]+)",
        config,
    )
    assert found, ".pre-commit-config.yaml から gitlint の rev を読めない"
    return found.group(1)


def _violates_uc1(tmp_path: Path, title: str) -> bool:
    msg = tmp_path / "msg.txt"
    msg.write_text(title + "\n", encoding="utf-8")
    # extra-path が cwd からの相対のため、cwd はリポのルートにする。
    result = subprocess.run(
        [
            "uvx",
            "--python",
            "3.12",
            "--from",
            f"gitlint=={_gitlint_version()}",
            "gitlint",
            "--config",
            ".gitlint",
            "--msg-filename",
            str(msg),
        ],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 255, result.stderr
    return "UC1" in result.stderr


@pytest.mark.parametrize(
    "title",
    [
        "build(pecot-tools): bump commander in /plugins/pecot-tools",
        "build(repo): bump the root-minor-patch group across 1 directory with 28 updates",
        "build(repo): 依存を上げる",
    ],
)
def test_title_passes(tmp_path: Path, title: str) -> None:
    assert not _violates_uc1(tmp_path, title)


def test_non_dependabot_english_title_fails(tmp_path: Path) -> None:
    assert _violates_uc1(tmp_path, "build(pecot-tools): update deps")
