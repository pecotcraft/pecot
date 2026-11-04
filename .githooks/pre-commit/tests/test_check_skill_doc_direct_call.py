"""check-skill-doc-direct-call.sh のユニットテスト（test_check_skill_doc_direct_call.bats 移植）。

hook は git ls-files で対象を列挙するため、テスト用に一時的な git リポジトリを構築し、
その中で hook を起動する。GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する。
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest


@pytest.fixture
def skill_repo(git_repo: Callable[..., Path]) -> Path:
    """temp git repo（init/config 済み）を作る（各 .bats の setup 相当）。"""
    return git_repo("repo")


def _make_skill(git, repo: Path, rel: str, content: str) -> None:
    """plugins/pecot-visual/skills/<rel>/SKILL.md を作る。"""
    path = repo / "plugins" / "pecot-visual" / "skills" / rel / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{content}\n")
    git(repo, "add", str(path.relative_to(repo)))


def test_pecotv_cli_only_passes(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """(a) pecotv slidev create のみ → exit 0。"""
    _make_skill(
        git,
        skill_repo,
        "v-slidev",
        "実行例:\n```bash\npecotv slidev create ./out\n```",
    )
    result = run_script(script_dir / "check-skill-doc-direct-call.sh", cwd=skill_repo)
    assert result.returncode == 0


def test_python3_abs_path_fails(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """(b) python3 plugins/pecot-visual/skills/.../create_presentation.py → exit 1。"""
    _make_skill(
        git,
        skill_repo,
        "v-slidev",
        "実行例:\npython3 plugins/pecot-visual/skills/v-slidev/scripts/create_presentation.py\n",
    )
    result = run_script(script_dir / "check-skill-doc-direct-call.sh", cwd=skill_repo)
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "plugins/pecot-visual/skills/v-slidev/SKILL.md" in out
    assert "python3 plugins/pecot-visual/skills/v-slidev/scripts/create_presentation.py" in out
    assert "allow-list 機構はありません" in out


def test_python3_rel_path_fails(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """(c) python3 scripts/...py 相対形式 → exit 1。"""
    _make_skill(
        git,
        skill_repo,
        "v-drawio",
        "実行例:\npython3 scripts/drawio-url.py ./output/foo.drawio\n",
    )
    result = run_script(script_dir / "check-skill-doc-direct-call.sh", cwd=skill_repo)
    assert result.returncode == 1
    assert "python3 scripts/drawio-url.py" in (result.stdout + result.stderr)


def test_uv_run_fails(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """(d) 任意 uv run XXX → exit 1。"""
    _make_skill(git, skill_repo, "v-slidev", "uv run --directory /x do_something\n")
    result = run_script(script_dir / "check-skill-doc-direct-call.sh", cwd=skill_repo)
    assert result.returncode == 1
    assert "uv run" in (result.stdout + result.stderr)


def test_changelog_out_of_scope(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """(e) CHANGELOG.md 内表記は対象外（glob 範囲外）。

    正常な SKILL.md を 1 つ用意して hook の走査対象を非ゼロにしたうえで、別途
    CHANGELOG.md に違反表記を入れる。glob が CHANGELOG.md を除外しているからこそ
    exit 0 となる構成（対象 0 件で偶然 PASS するケースを排除）。
    """
    _make_skill(
        git,
        skill_repo,
        "v-slidev",
        "実行例:\n```bash\npecotv slidev create ./out\n```",
    )
    cl = skill_repo / "plugins" / "pecot-visual" / "CHANGELOG.md"
    cl.parent.mkdir(parents=True, exist_ok=True)
    cl.write_text("旧表記: python3 scripts/drawio-url.py や uv run create が含まれている\n")
    git(skill_repo, "add", str(cl.relative_to(skill_repo)))
    result = run_script(script_dir / "check-skill-doc-direct-call.sh", cwd=skill_repo)
    assert result.returncode == 0
