"""check-version-plan-format.sh のユニットテスト（test_check_version_plan_format.bats 移植）。

Issue #227 で追加されたファイル名規則検証（`<番号>-<slug>.md`）を中心に検証する。
既存の本文 4 ルール（空行 / 行長 / '- ' / '#'）は別途維持されており、ここでは
ファイル名 Rule 0 の正例・負例を網羅する。

負例 6 件は同一の assert（exit 1 / "<番号>-<slug>.md" を含む）のため parametrize で
集約する（bats 版の負例 6 @test を 1 関数へ）。
"""

from __future__ import annotations

from pathlib import Path

import pytest


def _make_plan(path: Path) -> None:
    """最小限の正しい frontmatter + 本文を持つ plan ファイルを生成。"""
    path.write_text(
        "---\npecot-workflow: patch\n---\n\nファイル名規則の検証用ダミー本文。1 段落で記述する。\n"
    )


@pytest.fixture
def plan_dir(tmp_path: Path) -> Path:
    d = tmp_path / "plans"
    d.mkdir()
    return d


@pytest.mark.parametrize(
    "filename",
    [
        "227-foo-bar.md",
        "227-version-plan-naming.md",
    ],
)
def test_valid_filename_passes(script_dir: Path, plan_dir: Path, run_script, filename: str) -> None:
    """正例: <番号>-<slug>.md は pass。"""
    f = plan_dir / filename
    _make_plan(f)
    result = run_script(script_dir / "check-version-plan-format.sh", str(f))
    assert result.returncode == 0


@pytest.mark.parametrize(
    "filename",
    [
        "foo-bar.md",  # 番号なし
        "227.md",  # slug なし
        "227_foo.md",  # アンダースコア区切り
        "227--foo.md",  # 連続ハイフン
        "227-foo-.md",  # 末尾ハイフン
        "227-Foo.md",  # 大文字
    ],
)
def test_invalid_filename_fails(
    script_dir: Path, plan_dir: Path, run_script, filename: str
) -> None:
    """負例: 規則外のファイル名は exit 1 で "<番号>-<slug>.md" を含む。"""
    f = plan_dir / filename
    _make_plan(f)
    result = run_script(script_dir / "check-version-plan-format.sh", str(f))
    assert result.returncode == 1
    assert "<番号>-<slug>.md" in (result.stdout + result.stderr)


def test_stale_group_key_fails(script_dir: Path, plan_dir: Path, run_script) -> None:
    """旧 group 名 `pecot` は nx.json の release.groups に無いので弾く。"""
    f = plan_dir / "227-stale-key.md"
    f.write_text("---\npecot: patch\n---\n\n旧キーの検証用ダミー本文。\n")
    result = run_script(script_dir / "check-version-plan-format.sh", str(f))
    assert result.returncode == 1
    output = result.stdout + result.stderr
    assert "'pecot'" in output
    assert "release.groups" in output
    assert "pecot-workflow" in output  # 有効なキーの一覧


def test_all_release_group_keys_pass(script_dir: Path, plan_dir: Path, run_script) -> None:
    """3 つの release group すべてをキーにした plan は pass。"""
    f = plan_dir / "227-all-groups.md"
    f.write_text(
        "---\npecot-workflow: patch\npecot-visual: minor\npecot-tools: major\n---\n\n"
        "全 group の検証用ダミー本文。\n"
    )
    result = run_script(script_dir / "check-version-plan-format.sh", str(f))
    assert result.returncode == 0, result.stdout + result.stderr


def test_text_rules_group_key_passes(script_dir: Path, plan_dir: Path, run_script) -> None:
    """libs/text-rules の release group `text-rules` をキーにした plan は pass。"""
    f = plan_dir / "1278-text-rules.md"
    f.write_text("---\ntext-rules: patch\n---\n\ntext-rules 用の検証ダミー本文。\n")
    result = run_script(script_dir / "check-version-plan-format.sh", str(f))
    assert result.returncode == 0, result.stdout + result.stderr
