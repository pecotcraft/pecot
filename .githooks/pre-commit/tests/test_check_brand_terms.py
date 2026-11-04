"""check-brand-terms.sh のユニットテスト。

語の一覧は本体の外のファイル（PECOT_BRAND_TERMS_FILE）から受ける。
実物の語を書くとこのテスト自身が確認に当たるため、語はすべて合成した値にする。
ref モードは git の tree、dir モードは git に頼らないファイル走査を調べる。
GIT_* と push 範囲の env の隔離は conftest の _isolate_git_env autouse に委譲する。
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

TERM = "zzbrandterm"
COLOR_TERM = "#00ff42"


@pytest.fixture(autouse=True)
def _no_inherited_terms(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PECOT_BRAND_TERMS_FILE", raising=False)


@pytest.fixture
def repo(git_repo: Callable[..., Path]) -> Path:
    return git_repo("repo", initial_branch="main")


def _terms_file(tmp_path: Path, text: str | bytes) -> Path:
    path = tmp_path / "terms.txt"
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text)
    return path


def _commit(git, repo: Path, files: dict[str, str | bytes]) -> None:
    for rel, body in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(body, bytes):
            target.write_bytes(body)
        else:
            target.write_text(body)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "x")


@pytest.fixture
def run_check(script_dir: Path, run_script) -> Callable[..., subprocess.CompletedProcess]:
    def _run(repo: Path, terms: Path | None, *args: str, env: dict | None = None):
        merged = dict(env or {})
        if terms is not None:
            merged["PECOT_BRAND_TERMS_FILE"] = str(terms)
        return run_script(script_dir / "check-brand-terms.sh", *args, cwd=repo, env=merged or None)

    return _run


# ref モード: 中身


def test_ref_reports_file_and_term_for_content_match(
    tmp_path: Path, repo: Path, git, run_check
) -> None:
    _commit(git, repo, {"src/a.txt": f"hello {TERM} world\n", "src/b.txt": "clean\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 1
    assert "src/a.txt" in result.stdout + result.stderr
    assert TERM in result.stdout + result.stderr
    assert "src/b.txt" not in result.stdout + result.stderr


def test_ref_passes_with_zero_match_line(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": "clean\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 0
    assert "一致 0 件" in result.stdout


def test_ref_checks_committed_tree_not_worktree(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": "clean\n"})
    (repo / "a.txt").write_text(f"{TERM}\n")
    (repo / "untracked.txt").write_text(f"{TERM}\n")
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 0


def test_ref_checks_the_given_commit(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": f"{TERM}\n"})
    _commit(git, repo, {"a.txt": "clean\n"})
    terms = _terms_file(tmp_path, f"{TERM}\n")
    assert run_check(repo, terms, "--ref", "HEAD").returncode == 0
    assert run_check(repo, terms, "--ref", "HEAD~1").returncode == 1


def test_ref_matches_binary_content(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"img.bin": b"\x00\x01\x02" + TERM.encode() + b"\x00\xff"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 1
    assert "img.bin" in result.stdout + result.stderr


def test_ref_unknown_ref_is_usage_error(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": "clean\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--ref", "no-such-ref")
    assert result.returncode == 2


# ref モード: パスの名前


def test_ref_matches_path_name(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {f"assets/{TERM}-logo.png": "binary-ish\n", "assets/ok.png": "x\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert f"assets/{TERM}-logo.png" in out
    assert TERM in out


def test_ref_matches_directory_name(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {f"{TERM}/deep/file.txt": "clean\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 1


# 一覧の書式


def test_fixed_string_not_regex(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": "zzaxb\n"})
    result = run_check(repo, _terms_file(tmp_path, "zza.b\n"), "--ref", "HEAD")
    assert result.returncode == 0


def test_case_sensitive(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": f"{TERM.upper()}\n"})
    terms = _terms_file(tmp_path, f"{TERM}\n")
    assert run_check(repo, terms, "--ref", "HEAD").returncode == 0
    (tmp_path / "terms.txt").write_text(f"{TERM.upper()}\n")
    assert run_check(repo, terms, "--ref", "HEAD").returncode == 1


def test_color_line_is_a_term(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.css": f"color: {COLOR_TERM};\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{COLOR_TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 1
    assert COLOR_TERM in result.stdout + result.stderr


def test_comment_lines_are_not_terms(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": "# zzcomment text\nzzonly#\n"})
    terms = _terms_file(
        tmp_path,
        f"# zzcomment text\n#\n# {COLOR_TERM}\n{TERM}\n",
    )
    result = run_check(repo, terms, "--ref", "HEAD")
    assert result.returncode == 0, result.stdout + result.stderr


def test_comment_text_does_not_match_even_when_term_appears_only_in_comment(
    tmp_path: Path, repo: Path, git, run_check
) -> None:
    _commit(git, repo, {"a.txt": f"{COLOR_TERM}\n"})
    result = run_check(repo, _terms_file(tmp_path, f"# {COLOR_TERM}\n{TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 0


def test_blank_lines_and_cr_are_ignored(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": "plain text only\n", "b.txt": f"x {TERM} y\n"})
    terms = _terms_file(tmp_path, f"\r\n\n# note\r\n{TERM}\r\n\r\n".encode())
    result = run_check(repo, terms, "--ref", "HEAD")
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "b.txt" in out
    assert "a.txt" not in out


def test_zero_terms_after_stripping_comments_fails(
    tmp_path: Path, repo: Path, git, run_check
) -> None:
    _commit(git, repo, {"a.txt": "anything\n"})
    result = run_check(repo, _terms_file(tmp_path, "# only comment\n\n#\n"), "--ref", "HEAD")
    assert result.returncode == 2


def test_empty_terms_file_fails(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": "anything\n"})
    result = run_check(repo, _terms_file(tmp_path, ""), "--ref", "HEAD")
    assert result.returncode == 2


# CHANGELOG の除外


def test_changelog_content_is_excluded(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(
        git,
        repo,
        {
            "CHANGELOG.md": f"{TERM}\n",
            "plugins/x/CHANGELOG.md": f"{TERM}\n",
            "a.txt": "clean\n",
        },
    )
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 0


def test_changelog_lookalike_is_not_excluded(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"OLD-CHANGELOG.md": f"{TERM}\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--ref", "HEAD")
    assert result.returncode == 1


# 一覧が無いとき


def test_missing_list_is_skipped_with_notice(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": f"{TERM}\n"})
    result = run_check(repo, None, "--ref", "HEAD")
    assert result.returncode == 0
    assert "飛ばし" in result.stdout + result.stderr
    assert "PECOT_BRAND_TERMS_FILE" in result.stdout + result.stderr


def test_nonexistent_list_path_is_skipped_without_require(
    tmp_path: Path, repo: Path, git, run_check
) -> None:
    _commit(git, repo, {"a.txt": f"{TERM}\n"})
    result = run_check(repo, tmp_path / "nope.txt", "--ref", "HEAD")
    assert result.returncode == 0
    assert "飛ばし" in result.stdout + result.stderr


def test_require_terms_fails_without_list(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": "clean\n"})
    result = run_check(repo, None, "--require-terms", "--ref", "HEAD")
    assert result.returncode == 2
    assert "PECOT_BRAND_TERMS_FILE" in result.stdout + result.stderr


def test_require_terms_fails_with_nonexistent_list(
    tmp_path: Path, repo: Path, git, run_check
) -> None:
    _commit(git, repo, {"a.txt": "clean\n"})
    result = run_check(repo, tmp_path / "nope.txt", "--require-terms", "--ref", "HEAD")
    assert result.returncode == 2


def test_require_terms_passes_with_list(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": "clean\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--require-terms", "--ref", "HEAD")
    assert result.returncode == 0


# dir モード


def test_dir_mode_reads_files_without_git(tmp_path: Path, run_check) -> None:
    tree = tmp_path / "tree"
    (tree / "sub").mkdir(parents=True)
    (tree / "sub" / "a.txt").write_text(f"x {TERM} y\n")
    (tree / "sub" / "b.txt").write_text("clean\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    result = run_check(outside, _terms_file(tmp_path, f"{TERM}\n"), "--dir", str(tree))
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "sub/a.txt" in out
    assert TERM in out
    assert "b.txt" not in out


def test_dir_mode_includes_dotfiles_and_gitignored_files(tmp_path: Path, run_check) -> None:
    tree = tmp_path / "tree"
    (tree / ".hidden").mkdir(parents=True)
    (tree / ".hidden" / "cfg").write_text(f"{TERM}\n")
    result = run_check(tmp_path, _terms_file(tmp_path, f"{TERM}\n"), "--dir", str(tree))
    assert result.returncode == 1
    assert ".hidden/cfg" in result.stdout + result.stderr


def test_dir_mode_includes_untracked_files_of_a_git_tree(
    tmp_path: Path, repo: Path, git, run_check
) -> None:
    _commit(git, repo, {"a.txt": "clean\n"})
    (repo / "dist").mkdir()
    (repo / "dist" / "bundle.js").write_text(f"{TERM}\n")
    (repo / ".gitignore").write_text("dist/\n")
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--dir", str(repo))
    assert result.returncode == 1
    assert "dist/bundle.js" in result.stdout + result.stderr


def test_dir_mode_matches_path_names(tmp_path: Path, run_check) -> None:
    tree = tmp_path / "tree"
    (tree / "fonts").mkdir(parents=True)
    (tree / "fonts" / f"{TERM}-Regular.woff2").write_text("clean\n")
    result = run_check(tmp_path, _terms_file(tmp_path, f"{TERM}\n"), "--dir", str(tree))
    assert result.returncode == 1
    assert f"{TERM}-Regular.woff2" in result.stdout + result.stderr


def test_dir_mode_ignores_the_dir_own_location(tmp_path: Path, run_check) -> None:
    """対象にするのは dir の中のパスで、dir 自身の置き場所の名前ではない。"""
    tree = tmp_path / f"{TERM}-holder" / "tree"
    tree.mkdir(parents=True)
    (tree / "a.txt").write_text("clean\n")
    result = run_check(tmp_path, _terms_file(tmp_path, f"{TERM}\n"), "--dir", str(tree))
    assert result.returncode == 0


def test_dir_mode_excludes_changelog(tmp_path: Path, run_check) -> None:
    tree = tmp_path / "tree"
    (tree / "pkg").mkdir(parents=True)
    (tree / "CHANGELOG.md").write_text(f"{TERM}\n")
    (tree / "pkg" / "CHANGELOG.md").write_text(f"{TERM}\n")
    result = run_check(tmp_path, _terms_file(tmp_path, f"{TERM}\n"), "--dir", str(tree))
    assert result.returncode == 0
    assert "一致 0 件" in result.stdout


def test_dir_mode_accepts_multiple_dirs(tmp_path: Path, run_check) -> None:
    clean = tmp_path / "clean"
    dirty = tmp_path / "dirty"
    clean.mkdir()
    dirty.mkdir()
    (clean / "a.txt").write_text("clean\n")
    (dirty / "b.txt").write_text(f"{TERM}\n")
    terms = _terms_file(tmp_path, f"{TERM}\n")
    result = run_check(tmp_path, terms, "--dir", str(clean), "--dir", str(dirty))
    assert result.returncode == 1
    assert "b.txt" in result.stdout + result.stderr


def test_dir_mode_missing_dir_is_usage_error(tmp_path: Path, run_check) -> None:
    result = run_check(tmp_path, _terms_file(tmp_path, f"{TERM}\n"), "--dir", str(tmp_path / "x"))
    assert result.returncode == 2


def test_dir_mode_does_not_read_default_ref(tmp_path: Path, repo: Path, git, run_check) -> None:
    """--dir を渡したときは、引数なしの既定（HEAD の確認）を重ねない。"""
    _commit(git, repo, {"a.txt": f"{TERM}\n"})
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "ok.txt").write_text("clean\n")
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), "--dir", str(tree))
    assert result.returncode == 0


# 引数なし（pre-push）


def test_default_mode_checks_head(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": f"{TERM}\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"))
    assert result.returncode == 1


def test_default_mode_prefers_pre_commit_to_ref(
    tmp_path: Path, repo: Path, git, git_rev_parse, run_check
) -> None:
    _commit(git, repo, {"a.txt": "clean\n"})
    clean_sha = git_rev_parse(repo, "HEAD")
    _commit(git, repo, {"a.txt": f"{TERM}\n"})
    terms = _terms_file(tmp_path, f"{TERM}\n")
    assert run_check(repo, terms).returncode == 1
    assert run_check(repo, terms, env={"PRE_COMMIT_TO_REF": clean_sha}).returncode == 0


def test_default_mode_skips_branch_deletion(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": f"{TERM}\n"})
    result = run_check(
        repo,
        _terms_file(tmp_path, f"{TERM}\n"),
        env={"PRE_COMMIT_TO_REF": "0" * 40},
    )
    assert result.returncode == 0


def test_default_mode_without_list_is_skipped(tmp_path: Path, repo: Path, git, run_check) -> None:
    _commit(git, repo, {"a.txt": f"{TERM}\n"})
    result = run_check(repo, None)
    assert result.returncode == 0
    assert "飛ばし" in result.stdout + result.stderr


# 引数の誤り


@pytest.mark.parametrize(
    "args",
    [
        ("--bogus",),
        ("--ref",),
        ("--dir",),
        ("positional",),
    ],
)
def test_invalid_arguments_exit_2(tmp_path: Path, repo: Path, git, run_check, args) -> None:
    _commit(git, repo, {"a.txt": "clean\n"})
    result = run_check(repo, _terms_file(tmp_path, f"{TERM}\n"), *args)
    assert result.returncode == 2
