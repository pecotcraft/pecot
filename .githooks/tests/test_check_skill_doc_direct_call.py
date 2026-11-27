"""check-skill-doc-direct-call.sh のユニットテスト（test_check_skill_doc_direct_call.bats 移植）。

hook は git ls-files で対象を列挙するため、テスト用に一時的な git リポジトリを構築し、
その中で hook を起動する。GIT_* 隔離は conftest の _isolate_git_env autouse に委譲する。
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import allure
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


@allure.title("SKILL.md が pecotv の CLI だけを使っていると、成功で終わる")
def test_pecotv_cli_only_passes(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """`check-skill-doc-direct-call.sh` の、SKILL.md に `pecotv slidev create` だけを書いた場合のテストです。終了コード 0 で終わることを確認します。"""
    with allure.step("pecotv の CLI だけを書いた SKILL.md を用意して hook を動かす"):
        _make_skill(
            git,
            skill_repo,
            "v-slidev",
            "実行例:\n```bash\npecotv slidev create ./out\n```",
        )
        result = run_script(script_dir / "check-skill-doc-direct-call.sh", cwd=skill_repo)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0


@allure.title("SKILL.md が python3 でプラグインのスクリプトを直接呼んでいると、失敗で終わる")
def test_python3_abs_path_fails(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """SKILL.md に `python3 plugins/pecot-visual/skills/` から始まるパスで、スクリプトを直接呼ぶ記述がある場合のテストです。終了コード 1 で終わり、SKILL.md のパスと該当の記述、許可リストの機構が存在しない旨を出力することを確認します。"""
    with allure.step("python3 で絶対パスの script を呼ぶ SKILL.md を用意して hook を動かす"):
        _make_skill(
            git,
            skill_repo,
            "v-slidev",
            "実行例:\npython3 plugins/pecot-visual/skills/v-slidev/scripts/create_presentation.py\n",
        )
        result = run_script(script_dir / "check-skill-doc-direct-call.sh", cwd=skill_repo)

    with allure.step("終了コード 1 と、違反箇所の表示を確かめる"):
        assert result.returncode == 1
        out = result.stdout + result.stderr
        assert "plugins/pecot-visual/skills/v-slidev/SKILL.md" in out
        assert "python3 plugins/pecot-visual/skills/v-slidev/scripts/create_presentation.py" in out
        assert "allow-list 機構はありません" in out


@allure.title("SKILL.md が python3 で scripts の相対パスのスクリプトを呼んでいると、失敗で終わる")
def test_python3_rel_path_fails(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """SKILL.md に `python3 scripts/drawio-url.py` の形の記述がある場合のテストです。終了コード 1 で終わり、該当の記述を出力することを確認します。"""
    with allure.step("python3 で相対パスの script を呼ぶ SKILL.md を用意して hook を動かす"):
        _make_skill(
            git,
            skill_repo,
            "v-drawio",
            "実行例:\npython3 scripts/drawio-url.py ./output/foo.drawio\n",
        )
        result = run_script(script_dir / "check-skill-doc-direct-call.sh", cwd=skill_repo)

    with allure.step("終了コード 1 と、違反箇所の表示を確かめる"):
        assert result.returncode == 1
        assert "python3 scripts/drawio-url.py" in (result.stdout + result.stderr)


@allure.title("SKILL.md に uv run の記述があると、失敗で終わる")
def test_uv_run_fails(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """SKILL.md に `uv run` でスクリプトを実行する記述がある場合のテストです。終了コード 1 で終わり、`uv run` を含むメッセージを出力することを確認します。"""
    with allure.step("uv run を書いた SKILL.md を用意して hook を動かす"):
        _make_skill(git, skill_repo, "v-slidev", "uv run --directory /x do_something\n")
        result = run_script(script_dir / "check-skill-doc-direct-call.sh", cwd=skill_repo)

    with allure.step("終了コード 1 と、違反箇所の表示を確かめる"):
        assert result.returncode == 1
        assert "uv run" in (result.stdout + result.stderr)


@allure.title("CHANGELOG.md の中の違反の表記は、対象にしない")
def test_changelog_out_of_scope(script_dir: Path, skill_repo: Path, run_script, git) -> None:
    """正常な SKILL.md を 1 件用意したうえで、`CHANGELOG.md` に `python3 scripts/` や `uv run` の記述を入れた場合のテストです。`CHANGELOG.md` は対象の範囲外のため、終了コード 0 で終わることを確認します。"""
    with allure.step("正常な SKILL.md と、違反表記のある CHANGELOG.md を用意して hook を動かす"):
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

    with allure.step("終了コード 0（CHANGELOG は対象外）を確かめる"):
        assert result.returncode == 0
