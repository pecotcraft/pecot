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


def test_fails_without_claude(
    script_dir: Path, repo_root: Path, run_script, tmp_path: Path
) -> None:
    """(a) claude CLI が PATH に無い → skip せず非 0 で、claude が無い旨を stderr に出す。

    PATH は bash と git だけを symlink した専用ディレクトリにする。/usr/bin:/bin 固定だと
    claude が /usr/bin にある環境で「無い」状態を作れない。
    """
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
    assert result.returncode != 0
    assert "claude" in result.stderr
    assert "not found" in result.stderr


@requires_claude
def test_current_repo_passes(script_dir: Path, repo_root: Path, run_script) -> None:
    """(b) 現リポの 4 対象 → exit 0。"""
    result = run_script(script_dir / "plugin-validate.sh", cwd=repo_root)
    assert result.returncode == 0, result.stdout + result.stderr


@requires_claude
def test_fixture_repo_passes(script_dir: Path, run_script, tmp_path: Path) -> None:
    """(c の前提) 壊す前の最小構成は exit 0。失敗の原因が壊した SKILL.md だけであることを保証する。"""
    _make_marketplace_repo(tmp_path)
    result = run_script(script_dir / "plugin-validate.sh", cwd=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr


@requires_claude
def test_broken_skill_frontmatter_fails(script_dir: Path, run_script, tmp_path: Path) -> None:
    """(c) 1 プラグインの SKILL.md の frontmatter が閉じていない → 非 0。失敗した対象だけ出す。"""
    _make_marketplace_repo(tmp_path)
    skill = tmp_path / "plugins" / "pecot-visual" / "skills" / "pecot-visual-skill" / "SKILL.md"
    skill.write_text("---\nname: pecot-visual-skill\ndescription: |\n  不正な frontmatter\n\n# x\n")
    result = run_script(script_dir / "plugin-validate.sh", cwd=tmp_path)
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "plugins/pecot-visual" in output
    assert "frontmatter" in output
    assert "plugins/pecot-workflow" not in output
