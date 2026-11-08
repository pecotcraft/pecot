"""check-root-entries.sh のユニットテスト (#126)。

追跡しているファイルの先頭の名前を許可の一覧と比べ、一覧に無い名前があれば exit 1 で止める。
一覧は hook の ALLOWED と .claude/rules/repo-root-layout.md の表で同じにする。
"""

from __future__ import annotations

import re
from pathlib import Path

_RULE = ".claude/rules/repo-root-layout.md"


def _allowed(script: Path) -> list[str]:
    body = re.search(r"ALLOWED=\(\n(.*?)\n\)", script.read_text(encoding="utf-8"), re.S)
    assert body, "ALLOWED が読めない"
    return body.group(1).split()


def test_allowed_names_only_pass(script_dir: Path, git_repo, git, run_script) -> None:
    repo = git_repo()
    for name in ("README.md", "package.json", ".gitignore"):
        (repo / name).write_text("x")
    (repo / "plugins" / "p").mkdir(parents=True)
    (repo / "plugins" / "p" / "a.txt").write_text("x")
    git(repo, "add", "-A")

    result = run_script(script_dir / "check-root-entries.sh", cwd=repo)

    assert result.returncode == 0, result.stderr


def test_unlisted_root_dir_blocks_with_name_and_guidance(
    script_dir: Path, git_repo, git, run_script
) -> None:
    repo = git_repo()
    (repo / "README.md").write_text("x")
    (repo / "scripts").mkdir()
    (repo / "scripts" / "x.sh").write_text("x")
    git(repo, "add", "-A")

    result = run_script(script_dir / "check-root-entries.sh", cwd=repo)

    assert result.returncode == 1
    assert "  - scripts" in result.stderr
    assert "README.md" not in result.stderr.split("置き場所")[0]
    assert _RULE in result.stderr
    assert ".githooks/scripts/" in result.stderr


def test_untracked_unlisted_name_is_ignored(script_dir: Path, git_repo, run_script) -> None:
    repo = git_repo()
    (repo / "node_modules").mkdir()
    (repo / "node_modules" / "x").write_text("x")

    result = run_script(script_dir / "check-root-entries.sh", cwd=repo)

    assert result.returncode == 0, result.stderr


def test_working_tree_repo_passes(script_dir: Path, run_script) -> None:
    result = run_script(script_dir / "check-root-entries.sh", cwd=script_dir.parents[1])

    assert result.returncode == 0, result.stderr


def test_rule_table_matches_hook_allowed_list(script_dir: Path) -> None:
    root = script_dir.parents[1]
    rule = (root / _RULE).read_text(encoding="utf-8")
    first_table = rule.split("## ", 1)[0]
    in_table = re.findall(r"^\| `([^`]+)` \|", first_table, re.M)

    allowed = _allowed(script_dir / "check-root-entries.sh")

    assert sorted(in_table) == sorted(allowed)
    assert len(set(allowed)) == len(allowed)
