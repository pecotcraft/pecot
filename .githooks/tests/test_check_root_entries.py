"""check-root-entries.sh のユニットテスト (#126)。

追跡しているファイルの先頭のディレクトリのうち、. で始まらないものを許可の一覧と比べる。
一覧に無いディレクトリがあれば exit 1 で止める。一覧は hook の ALLOWED とルールファイルの表で同じにする。
"""

from __future__ import annotations

import re
from pathlib import Path

import allure

_RULE = ".claude/rules/repo-root-layout.md"


def _allowed(script: Path) -> list[str]:
    body = re.search(r"ALLOWED=\(\n(.*?)\n\)", script.read_text(encoding="utf-8"), re.S)
    assert body, "ALLOWED が読めない"
    return body.group(1).split()


@allure.title("許可された名前のディレクトリとルート直下のファイルだけなら、成功で終わる")
def test_allowed_names_only_pass(script_dir: Path, git_repo, git, run_script) -> None:
    """`check-root-entries.sh` の、許可された名前だけを追跡している場合のテストです。ルート直下のファイルと `plugins` ディレクトリだけを追跡しているときに、終了コード 0 で終わることを確認します。"""
    with allure.step("許可の名前のファイルとディレクトリを追跡して hook を動かす"):
        repo = git_repo()
        for name in ("README.md", "package.json", ".gitignore"):
            (repo / name).write_text("x")
        (repo / "plugins" / "p").mkdir(parents=True)
        (repo / "plugins" / "p" / "a.txt").write_text("x")
        git(repo, "add", "-A")

        result = run_script(script_dir / "check-root-entries.sh", cwd=repo)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0, result.stderr


@allure.title(". で始まるディレクトリとルート直下のファイルは、制限の対象にしない")
def test_dot_dirs_and_root_files_are_not_restricted(
    script_dir: Path, git_repo, git, run_script
) -> None:
    """`.newtool` のようなドットで始まるディレクトリと、ルート直下の新しいファイルを追跡している場合のテストです。制限の対象外のため、終了コード 0 で終わることを確認します。"""
    with allure.step("ドット始まりのディレクトリとルート直下のファイルを追跡して hook を動かす"):
        repo = git_repo()
        for name in ("setup.sh", "NEW-ROOT-FILE.md"):
            (repo / name).write_text("x")
        (repo / ".newtool").mkdir()
        (repo / ".newtool" / "config").write_text("x")
        git(repo, "add", "-A")

        result = run_script(script_dir / "check-root-entries.sh", cwd=repo)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0, result.stderr


@allure.title(
    "許可の一覧に存在しないルート直下のディレクトリがあると、名前と案内を出力して失敗で終わる"
)
def test_unlisted_root_dir_blocks_with_name_and_guidance(
    script_dir: Path, git_repo, git, run_script
) -> None:
    """許可の一覧に存在しない `scripts` ディレクトリを追跡している場合のテストです。終了コード 1 で終わり、ディレクトリの名前と、ユーザーの同意が必要である旨の案内を出力することを確認します。"""
    with allure.step("一覧に無いディレクトリを追跡して hook を動かす"):
        repo = git_repo()
        (repo / "README.md").write_text("x")
        (repo / "scripts").mkdir()
        (repo / "scripts" / "x.sh").write_text("x")
        git(repo, "add", "-A")

        result = run_script(script_dir / "check-root-entries.sh", cwd=repo)

    with allure.step("終了コード 1 と、名前・案内の表示を確かめる"):
        assert result.returncode == 1
        assert "  - scripts/" in result.stderr
        assert "README.md" not in result.stderr
        assert "ユーザーの明示の同意" in result.stderr
        assert _RULE in result.stderr
        assert ".githooks/scripts/" in result.stderr


@allure.title("Git が追跡していないディレクトリは、許可の一覧に存在しなくても対象にしない")
def test_untracked_unlisted_name_is_ignored(script_dir: Path, git_repo, run_script) -> None:
    """`node_modules` のように、Git が追跡していないディレクトリがある場合のテストです。対象外のため、終了コード 0 で終わることを確認します。"""
    with allure.step("追跡していない node_modules を置いて hook を動かす"):
        repo = git_repo()
        (repo / "node_modules").mkdir()
        (repo / "node_modules" / "x").write_text("x")

        result = run_script(script_dir / "check-root-entries.sh", cwd=repo)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0, result.stderr


@allure.title("このリポジトリの作業ツリーに対して実行すると、成功で終わる")
def test_working_tree_repo_passes(script_dir: Path, run_script) -> None:
    """実際のリポジトリの作業ツリーで `check-root-entries.sh` を実行するテストです。ルート直下のディレクトリが許可の一覧に収まっており、終了コード 0 で終わることを確認します。"""
    with allure.step("作業ツリーのリポで hook を動かす"):
        result = run_script(script_dir / "check-root-entries.sh", cwd=script_dir.parents[1])

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0, result.stderr


@allure.title("ルールファイルの表のディレクトリは、hook の ALLOWED の一覧と一致する")
def test_rule_table_matches_hook_allowed_list(script_dir: Path) -> None:
    """`.claude/rules/repo-root-layout.md` の先頭の表と、hook の `ALLOWED` のテストです。2 つの一覧が並び順を除いて一致し、`ALLOWED` に重複が存在しないことを確認します。"""
    with allure.step("ルールファイルの表と hook の ALLOWED を読む"):
        root = script_dir.parents[1]
        rule = (root / _RULE).read_text(encoding="utf-8")
        first_table = rule.split("## ", 1)[0]
        in_table = re.findall(r"^\| `([^`]+)` \|", first_table, re.M)

        allowed = _allowed(script_dir / "check-root-entries.sh")

    with allure.step("表と一覧が同じで、重複が無いことを確かめる"):
        assert sorted(in_table) == sorted(allowed)
        assert len(set(allowed)) == len(allowed)
