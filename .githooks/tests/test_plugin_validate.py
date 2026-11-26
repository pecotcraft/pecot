"""plugin-validate.sh のユニットテスト（#1231）。

hook は git のトップレベルを基準に、3 プラグインとリポジトリルートの 4 対象へ
`claude plugin validate --strict` を掛ける。
失敗した対象の出力だけを出して非 0 で終える。
claude CLI が無い環境でも skip せず失敗する。実 claude を使うケースは claude 不在時に skip する。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import allure
import pytest

_TARGETS = ["plugins/pecot-workflow", "plugins/pecot-visual", "plugins/pecot-tools"]

requires_claude = pytest.mark.skipif(
    shutil.which("claude") is None,
    reason="claude CLI が無い環境では検証系ケースを実行できない",
)

_VALID_SKILL = "---\nname: {name}\ndescription: テスト用スキル\n---\n\n# {name}\n"


@pytest.fixture
def repo_root(script_dir: Path) -> Path:
    """リポジトリルート（script_dir = .githooks/pre-commit）。"""
    return script_dir.parents[1]


def _make_marketplace_repo(root: Path) -> None:
    """3 プラグインと marketplace.json だけの最小構成。git init 済みで warning が出ない形にする。"""
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    (root / ".claude-plugin").mkdir()
    (root / ".claude-plugin" / "marketplace.json").write_text(
        json.dumps(
            {
                "name": "fixture",
                "owner": {"name": "fixture"},
                "metadata": {"description": "fixture"},
                "plugins": [
                    {"name": Path(t).name, "source": f"./{t}", "description": "fixture"}
                    for t in _TARGETS
                ],
            }
        )
    )
    for target in _TARGETS:
        name = Path(target).name
        plugin = root / target
        (plugin / ".claude-plugin").mkdir(parents=True)
        (plugin / ".claude-plugin" / "plugin.json").write_text(
            json.dumps(
                {
                    "name": name,
                    "version": "0.0.1",
                    "description": "fixture",
                    "author": {"name": "fixture"},
                }
            )
        )
        skill = plugin / "skills" / f"{name}-skill" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text(_VALID_SKILL.format(name=f"{name}-skill"))


@allure.title(
    "claude CLI が PATH に存在しないと、skip せずに非 0 で終了し、見つからない旨を表示する"
)
def test_fails_without_claude(
    script_dir: Path, repo_root: Path, run_script, tmp_path: Path
) -> None:
    """`plugin-validate.sh` を、claude CLI が PATH に存在しない環境で実行した場合のテストです。skip されず終了コードが 0 以外になり、標準エラー出力に `claude` が `not found` である旨が表示されることを確認します。"""
    with allure.step("PATH を bash と git だけにして plugin-validate.sh を動かす"):
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        for cmd in ("bash", "git"):
            found = shutil.which(cmd)
            assert found is not None
            (bin_dir / cmd).symlink_to(found)
        result = run_script(
            script_dir / "plugin-validate.sh",
            cwd=repo_root,
            env={"PATH": str(bin_dir)},
        )
    with allure.step("終了コードが 0 でなく、claude が無い旨を stderr に出すことを確かめる"):
        assert result.returncode != 0
        assert "claude" in result.stderr
        assert "not found" in result.stderr


@allure.title("現在のリポジトリの 4 つの対象を検証すると、終了コード 0 で終了する")
@requires_claude
def test_current_repo_passes(script_dir: Path, repo_root: Path, run_script) -> None:
    """`plugin-validate.sh` を現在のリポジトリで実行した場合のテストです。3 つのプラグインとリポジトリルートの検証がすべて成功し、終了コードが 0 になることを確認します。"""
    with allure.step("現リポで plugin-validate.sh を動かす"):
        result = run_script(script_dir / "plugin-validate.sh", cwd=repo_root)
    with allure.step("終了コードが 0 であることを確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr


@allure.title("壊す前の最小構成のリポジトリを検証すると、終了コード 0 で終了する")
@requires_claude
def test_fixture_repo_passes(script_dir: Path, run_script, tmp_path: Path) -> None:
    """3 つのプラグインと `marketplace.json` だけの最小構成で `plugin-validate.sh` を実行した場合のテストです。終了コードが 0 になり、後続の失敗が SKILL.md を壊したことだけに起因することを確認します。"""
    with allure.step("最小構成のリポを作り、plugin-validate.sh を動かす"):
        _make_marketplace_repo(tmp_path)
        result = run_script(script_dir / "plugin-validate.sh", cwd=tmp_path)
    with allure.step("終了コードが 0 であることを確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr


@allure.title("SKILL.md の frontmatter が閉じていないと、非 0 で終了し、失敗した対象だけを表示する")
@requires_claude
def test_broken_skill_frontmatter_fails(script_dir: Path, run_script, tmp_path: Path) -> None:
    """1 つのプラグインの `SKILL.md` の frontmatter を閉じずに `plugin-validate.sh` を実行した場合のテストです。終了コードが 0 以外になり、`plugins/pecot-visual` と `frontmatter` が出力に含まれ、`plugins/pecot-workflow` が含まれないことを確認します。"""
    with allure.step("SKILL.md の frontmatter を壊し、plugin-validate.sh を動かす"):
        _make_marketplace_repo(tmp_path)
        skill = tmp_path / "plugins" / "pecot-visual" / "skills" / "pecot-visual-skill" / "SKILL.md"
        skill.write_text(
            "---\nname: pecot-visual-skill\ndescription: |\n  不正な frontmatter\n\n# x\n"
        )
        result = run_script(script_dir / "plugin-validate.sh", cwd=tmp_path)
    with allure.step("失敗した対象だけが出力に出ることを確かめる"):
        assert result.returncode != 0
        output = result.stdout + result.stderr
        assert "plugins/pecot-visual" in output
        assert "frontmatter" in output
        assert "plugins/pecot-workflow" not in output
