"""gitlint の title-requires-japanese の dependabot 例外のテスト (#69)。

リポの .gitlint を、実際の gitlint で動かす。違反は stderr の規則 ID（UC1）で見分ける。
"""

from __future__ import annotations

import functools
import re
import sys
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import run_attached  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[2]


@functools.cache
def _gitlint_version() -> str:
    config = (_REPO_ROOT / ".pre-commit-config.yaml").read_text(encoding="utf-8")
    found = re.search(
        r"repo:\s*https://github\.com/jorisroovers/gitlint\s*\n\s*rev:\s*\"?v?([0-9.]+)",
        config,
    )
    assert found, ".pre-commit-config.yaml から gitlint の rev を読めない"
    return found.group(1)


def _violates_uc1(tmp_path: Path, title: str, config: Path | None = None) -> bool:
    msg = tmp_path / "msg.txt"
    msg.write_text(title + "\n", encoding="utf-8")
    # extra-path が cwd からの相対のため、cwd はリポのルートにする。
    result = run_attached(
        [
            "uvx",
            "--python",
            "3.12",
            "--from",
            f"gitlint=={_gitlint_version()}",
            "gitlint",
            "--config",
            str(config) if config else ".gitlint",
            "--msg-filename",
            str(msg),
        ],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    # 252 以上は gitlint 自体の失敗（253 USAGE・254 GIT_CONTEXT・255 CONFIG）。
    assert result.returncode < 252, result.stderr
    return "UC1" in result.stderr


@allure.title("タイトルが「{title}」のコミットは、日本語の規則に違反しない")
@pytest.mark.parametrize(
    "title",
    [
        "build(pecot-tools): bump commander in /plugins/pecot-tools",
        "build(repo): bump the root-minor-patch group across 1 directory with 28 updates",
        "build(repo): 依存を上げる",
        "build(repo): bump foo from 1.0.0 to 1.0.1 [security]",
    ],
)
def test_title_passes(tmp_path: Path, title: str) -> None:
    """`.gitlint` の `title-requires-japanese`（`UC1`）のテストです。Dependabot の英語のタイトルや、日本語のタイトルを渡した場合に、`UC1` の違反を出力しないことを確認します。"""
    with allure.step("gitlint でタイトルをチェックし、UC1 に違反しないことを確かめる"):
        assert not _violates_uc1(tmp_path, title)


@allure.title("Dependabot ではない英語のタイトルは、日本語の規則に違反する")
def test_non_dependabot_english_title_fails(tmp_path: Path) -> None:
    """`build(pecot-tools): update deps` のように、Dependabot の形ではない英語のタイトルを渡した場合のテストです。`UC1` の違反を出力することを確認します。"""
    with allure.step("gitlint で英語のタイトルをチェックし、UC1 に違反することを確かめる"):
        assert _violates_uc1(tmp_path, "build(pecot-tools): update deps")


@allure.title(
    "タイトルが「{title}」のように、Dependabot の形に近いだけだと、日本語の規則に違反する"
)
@pytest.mark.parametrize(
    "title",
    [
        "build(repo)!: bump foo from 1 to 2",
        "build(repo): bumpy english",
    ],
)
def test_near_miss_title_fails(tmp_path: Path, title: str) -> None:
    """`!` を付けた形や `bumpy` のように、Dependabot のタイトルに近い英語のタイトルを渡した場合のテストです。例外にならず、`UC1` の違反を出力することを確認します。"""
    with allure.step(
        "gitlint で dependabot に似たタイトルをチェックし、UC1 に違反することを確かめる"
    ):
        assert _violates_uc1(tmp_path, title)


@allure.title("allow-dependabot を false にすると、Dependabot のタイトルも日本語の規則に違反する")
def test_dependabot_title_fails_when_option_disabled(tmp_path: Path) -> None:
    """`.gitlint` の `allow-dependabot` を `false` に変えた設定のテストです。Dependabot のタイトルを渡した場合に、`UC1` の違反を出力することを確認します。"""
    with allure.step("元の .gitlint を読む"):
        config = tmp_path / "gitlint.ini"
        text = (_REPO_ROOT / ".gitlint").read_text(encoding="utf-8")

    with allure.step("allow-dependabot が有効なことを確かめる"):
        assert "allow-dependabot = true" in text

    with allure.step("allow-dependabot を無効にした設定を書く"):
        config.write_text(
            text.replace("allow-dependabot = true", "allow-dependabot = false"),
            encoding="utf-8",
        )
        title = "build(pecot-tools): bump commander in /plugins/pecot-tools"

    with allure.step("gitlint でチェックし、UC1 に違反することを確かめる"):
        assert _violates_uc1(tmp_path, title, config)
