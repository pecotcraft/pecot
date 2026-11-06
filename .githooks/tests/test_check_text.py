"""check-text.sh と check-commit-text.sh のテスト（#1280）。

どちらも libs/text-rules/dist の bin を起動する薄いラッパー。
違反ケースは実リポの root を cwd にして実 bin を動かす。
dist が無い場合は、dist を持たない一時リポを cwd にして ERROR を確かめる。
依存が欠けている場合は、dist だけを持ち node_modules を持たない一時リポを使う。
フックは npm ci で依存を戻してから続ける。npm は PATH に置いた偽物で、戻せる場合と戻せない場合を作る。
dist が古い・無い場合は、実ソースを複製した一時リポでフックが build.mjs を動かして作り直す (#1331)。
違反文は literal で持たず、101 文字の本文から組み立てる。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

_LONG_SENTENCE = "あ" * 101 + "。"
_LIST_SOURCES = (
    'import { pathToFileURL } from "node:url";'
    " const { sourceFiles } = await import(pathToFileURL(process.env.HASH_MODULE).href);"
    " console.log(JSON.stringify(sourceFiles(process.env.PACKAGE_ROOT)));"
)


@pytest.fixture
def repo_root(script_dir: Path) -> Path:
    return script_dir.parents[1]


@pytest.fixture
def work_dir(tmp_path: Path) -> Path:
    path = tmp_path / "work"
    path.mkdir()
    return path


def _real_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _require_bin(repo_root: Path) -> None:
    if not (repo_root / "libs/text-rules/dist/bin/pecot-text-lint.js").is_file():
        pytest.fail("libs/text-rules/dist が無い。root で npm install を実行してください")


def _repo_with_dist_only(git_repo: Callable[..., Path]) -> Path:
    """dist の bin はあるが、libs/text-rules/node_modules が無い一時リポ。

    実物と同じく dist を ESM として扱い、bin は起動時に依存を import する。
    依存の確認が無ければ、bin が ERR_MODULE_NOT_FOUND のスタックを出す。
    """
    repo = git_repo("nodeps")
    package_dir = repo / "libs/text-rules"
    bin_path = package_dir / "dist/bin/pecot-text-lint.js"
    bin_path.parent.mkdir(parents=True)
    (package_dir / "package.json").write_text(
        json.dumps({"type": "module", "dependencies": {"@textlint/kernel": "*"}})
    )
    (package_dir / "dist/package.json").write_text(json.dumps({"type": "module"}))
    bin_path.write_text('import "@textlint/kernel";\n')
    # ready.mjs が dist の stamp と比べるため、実リポの scripts を複製し、package.json の後に stamp を書く。
    shutil.copytree(_real_root() / "libs/text-rules/scripts", package_dir / "scripts")
    _write_stamp(package_dir)
    return repo


def _write_stamp(package_dir: Path) -> None:
    (package_dir / "dist/source-hash").write_text(_expected_stamp(package_dir))


def _real_sources() -> list[str]:
    """dist の入力になるソースの相対パス。数え方は実リポの source-hash.mjs に任せる。"""
    real = _real_root() / "libs/text-rules"
    out = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            _LIST_SOURCES,
        ],
        env={
            **os.environ,
            "HASH_MODULE": str(real / "scripts/source-hash.mjs"),
            "PACKAGE_ROOT": str(real),
        },
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(out.stdout)


def _copy_real_sources(repo: Path, link_node_modules: bool = True) -> Path:
    """実ソースを複製した一時リポの libs/text-rules を返す。

    link_node_modules が真なら、node_modules を実リポへの symlink にして dist を作る。
    偽なら、node_modules と dist の両方が無い状態で返す。
    dist は複製側で作る。symlink にすると、フックの build.mjs が実 dist を消してしまう。
    """
    real = _real_root() / "libs/text-rules"
    if not (real / "node_modules").is_dir():
        pytest.fail("libs/text-rules/node_modules が無い。root で npm install を実行してください")
    package_dir = repo / "libs/text-rules"
    for rel in _real_sources():
        (package_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(real / rel, package_dir / rel)
    if link_node_modules:
        os.symlink(real / "node_modules", package_dir / "node_modules")
        subprocess.run(["node", str(package_dir / "scripts/build.mjs")], check=True)
    return package_dir


def _stamp(package_dir: Path) -> str:
    return (package_dir / "dist/source-hash").read_text()


def _expected_stamp(package_dir: Path) -> str:
    out = subprocess.run(
        ["node", str(package_dir / "scripts/source-hash.mjs")],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


def _disable_all_rules(package_dir: Path) -> None:
    """lib/rules.ts が全規則を外すように書き換え、ソースだけを dist より新しくする。

    古い dist が使われれば違反が出て、作り直されれば違反が出なくなる。
    """
    rules = package_dir / "lib/rules.ts"
    old = ".filter(([ruleId]) => !EXCLUDED_RULE_IDS.has(ruleId))"
    text = rules.read_text()
    assert old in text
    rules.write_text(text.replace(old, ".filter(() => false)"))


@pytest.fixture
def source_repo(git_repo: Callable[..., Path]) -> Path:
    repo = git_repo("rebuild")
    _copy_real_sources(repo)
    return repo


def _fake_npm(tmp_path: Path, *, restores: bool, link_real: bool = False) -> tuple[dict, Path]:
    """呼び出しを記録する偽の npm を PATH の先頭に置く env と、記録ファイルを返す。

    restores が真なら、`--prefix <dir> ci` の <dir> に依存の実体を置いて 0 で終わる。
    link_real も真なら、実体の代わりに実リポの node_modules への symlink を置く。
    偽なら何も置かずに 1 で終わる。
    """
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    calls = tmp_path / "npm-calls"
    body = 'echo "$*" >> "$NPM_CALLS"\n'
    if restores and link_real:
        body += 'ln -s "$REAL_NODE_MODULES" "$2/node_modules"\n'
    elif restores:
        body += (
            'dep="$2/node_modules/@textlint/kernel"\n'
            'mkdir -p "$dep"\n'
            'printf \'%s\' \'{"name":"@textlint/kernel","type":"module","main":"index.js"}\''
            ' > "$dep/package.json"\n'
            ': > "$dep/index.js"\n'
        )
    else:
        body += "exit 1\n"
    npm = bin_dir / "npm"
    npm.write_text("#!/usr/bin/env bash\n" + body)
    npm.chmod(0o755)
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "NPM_CALLS": str(calls),
        "REAL_NODE_MODULES": str(_real_root() / "libs/text-rules/node_modules"),
    }
    return env, calls


def _npm_calls(calls: Path) -> list[str]:
    return calls.read_text().splitlines() if calls.exists() else []


def _assert_deps_guidance(result) -> None:
    assert result.returncode == 1
    errors = [line for line in result.stderr.splitlines() if line.startswith("ERROR:")]
    assert any("依存が欠けている" in line and "npm install" in line for line in errors), (
        result.stderr
    )
    assert "ERR_MODULE_NOT_FOUND" not in result.stderr + result.stdout


def test_check_text_reports_violation(
    script_dir: Path, repo_root: Path, work_dir: Path, run_script
) -> None:
    _require_bin(repo_root)
    target = work_dir / "bad.md"
    target.write_text(f"# 見出し\n\n{_LONG_SENTENCE}\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=repo_root)
    assert result.returncode == 1
    lines = [line for line in result.stdout.splitlines() if line.startswith(f"{target}:3:")]
    assert any("sentence-length" in line for line in lines), result.stdout


def test_check_text_passes_clean_file(
    script_dir: Path, repo_root: Path, work_dir: Path, run_script
) -> None:
    _require_bin(repo_root)
    target = work_dir / "ok.md"
    target.write_text("# 見出し\n\n短い文を書く。\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=repo_root)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout == ""


def test_check_text_without_arguments_passes(script_dir: Path, repo_root: Path, run_script) -> None:
    result = run_script(script_dir / "check-text.sh", cwd=repo_root)
    assert result.returncode == 0


def test_check_text_errors_without_dist(
    script_dir: Path, git_repo: Callable[..., Path], run_script
) -> None:
    repo = git_repo("nodist")
    target = repo / "a.md"
    target.write_text("# 見出し\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=repo)
    assert result.returncode == 1
    errors = [line for line in result.stderr.splitlines() if line.startswith("ERROR:")]
    assert any("npm install" in line for line in errors), result.stderr


def test_check_text_errors_when_deps_cannot_be_restored(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    repo = _repo_with_dist_only(git_repo)
    env, calls = _fake_npm(tmp_path, restores=False)
    target = repo / "a.md"
    target.write_text("# 見出し\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=repo, env=env)
    _assert_deps_guidance(result)
    assert _npm_calls(calls) == ["--prefix libs/text-rules ci"]


def test_check_text_restores_missing_deps(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    """push の確認が install の npm ci を途中で止めると、依存が空のまま残る (#1313)。

    次の commit を止めないよう、フックが npm ci で戻してから文章規則を適用する。
    """
    repo = _repo_with_dist_only(git_repo)
    env, calls = _fake_npm(tmp_path, restores=True)
    target = repo / "a.md"
    target.write_text("# 見出し\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=repo, env=env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout == ""
    assert _npm_calls(calls) == ["--prefix libs/text-rules ci"]
    assert "ERROR:" not in result.stderr


def test_check_text_rebuilds_stale_dist(script_dir: Path, source_repo: Path, run_script) -> None:
    """lib/ が変わったのに dist が古いままなら、フックが作り直してから適用する (#1331)。"""
    package_dir = source_repo / "libs/text-rules"
    before = _stamp(package_dir)
    _disable_all_rules(package_dir)
    target = source_repo / "long.md"
    target.write_text(f"# 見出し\n\n{_LONG_SENTENCE}\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=source_repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout == ""
    assert "作り直します" in result.stderr
    assert _stamp(package_dir) != before
    assert _stamp(package_dir).strip() == _expected_stamp(package_dir)


def test_check_text_restores_deps_then_builds_dist(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    """依存と dist の両方が無いと、ready は 20 のあとに 30 を返す。フックは両方を順に直す (#1331)。"""
    repo = git_repo("fresh-clone")
    package_dir = _copy_real_sources(repo, link_node_modules=False)
    env, calls = _fake_npm(tmp_path, restores=True, link_real=True)
    target = repo / "a.md"
    target.write_text("# 見出し\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=repo, env=env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert _npm_calls(calls) == ["--prefix libs/text-rules ci"]
    assert "依存が欠けている" in result.stderr
    assert "作り直します" in result.stderr
    assert _stamp(package_dir).strip() == _expected_stamp(package_dir)


def test_check_text_errors_when_build_fails(
    script_dir: Path, source_repo: Path, run_script
) -> None:
    """tsc が落ちて dist を作れないとき、ERROR を出し、stamp を書かない (#1331)。"""
    package_dir = source_repo / "libs/text-rules"
    with (package_dir / "lib/findings.ts").open("a") as f:
        f.write("\nconst broken: number = 'a'\n")
    shutil.rmtree(package_dir / "dist")
    target = source_repo / "ok.md"
    target.write_text("# 見出し\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=source_repo)
    assert result.returncode == 1
    assert "作れません" in result.stderr
    assert result.stdout == ""
    assert not (package_dir / "dist/source-hash").exists()


def test_check_text_keeps_fresh_dist(script_dir: Path, source_repo: Path, run_script) -> None:
    """ソースが dist と同じなら、作り直さず stamp も動かさない (#1331)。"""
    package_dir = source_repo / "libs/text-rules"
    stamp_file = package_dir / "dist/source-hash"
    before = (_stamp(package_dir), stamp_file.stat().st_mtime_ns)
    target = source_repo / "ok.md"
    target.write_text("# 見出し\n\n短い文を書く。\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=source_repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "作り直します" not in result.stderr
    assert (_stamp(package_dir), stamp_file.stat().st_mtime_ns) == before


def test_check_text_builds_missing_dist(script_dir: Path, source_repo: Path, run_script) -> None:
    """dist が無くても、ソースがあればフックが作ってから適用する (#1331)。"""
    package_dir = source_repo / "libs/text-rules"
    shutil.rmtree(package_dir / "dist")
    target = source_repo / "long.md"
    target.write_text(f"# 見出し\n\n{_LONG_SENTENCE}\n")
    result = run_script(script_dir / "check-text.sh", str(target), cwd=source_repo)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "sentence-length" in result.stdout
    assert (package_dir / "dist/bin/pecot-text-lint.js").is_file()
    assert _stamp(package_dir).strip() == _expected_stamp(package_dir)


def test_check_commit_text_reports_violation(
    script_dir: Path, repo_root: Path, work_dir: Path, run_script
) -> None:
    _require_bin(repo_root)
    message = work_dir / "COMMIT_EDITMSG"
    message.write_text(f"test: 動作確認\n\n{_LONG_SENTENCE}\n")
    result = run_script(
        script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=repo_root
    )
    assert result.returncode == 1
    assert f"{message}:3:" in result.stdout
    assert "sentence-length" in result.stdout


def test_check_commit_text_ignores_comment_lines(
    script_dir: Path, repo_root: Path, work_dir: Path, run_script
) -> None:
    _require_bin(repo_root)
    message = work_dir / "COMMIT_EDITMSG"
    message.write_text(f"test: 動作確認\n\n# {_LONG_SENTENCE}\n")
    result = run_script(
        script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=repo_root
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_check_commit_text_errors_without_dist(
    script_dir: Path, git_repo: Callable[..., Path], run_script
) -> None:
    repo = git_repo("nodist")
    message = repo / "COMMIT_EDITMSG"
    message.write_text("test: 動作確認\n")
    result = run_script(
        script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=repo
    )
    assert result.returncode == 1
    errors = [line for line in result.stderr.splitlines() if line.startswith("ERROR:")]
    assert any("npm install" in line for line in errors), result.stderr


def test_check_commit_text_errors_when_deps_cannot_be_restored(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    repo = _repo_with_dist_only(git_repo)
    env, calls = _fake_npm(tmp_path, restores=False)
    message = repo / "COMMIT_EDITMSG"
    message.write_text("test: 動作確認\n")
    result = run_script(
        script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=repo, env=env
    )
    _assert_deps_guidance(result)
    assert _npm_calls(calls) == ["--prefix libs/text-rules ci"]


def test_check_commit_text_restores_missing_deps(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    repo = _repo_with_dist_only(git_repo)
    env, calls = _fake_npm(tmp_path, restores=True)
    message = repo / "COMMIT_EDITMSG"
    message.write_text("test: 動作確認\n")
    result = run_script(
        script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=repo, env=env
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert _npm_calls(calls) == ["--prefix libs/text-rules ci"]


def test_check_commit_text_rebuilds_stale_dist(
    script_dir: Path, source_repo: Path, run_script
) -> None:
    package_dir = source_repo / "libs/text-rules"
    before = _stamp(package_dir)
    _disable_all_rules(package_dir)
    message = source_repo / "COMMIT_EDITMSG"
    message.write_text(f"test: 動作確認\n\n{_LONG_SENTENCE}\n")
    result = run_script(
        script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=source_repo
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert _stamp(package_dir) != before


def test_check_commit_text_without_argument_guides(
    script_dir: Path, repo_root: Path, run_script
) -> None:
    result = run_script(script_dir.parent / "commit-msg" / "check-commit-text.sh", cwd=repo_root)
    assert result.returncode == 1
    assert "COMMIT_EDITMSG のパスを渡してください" in result.stderr


class _PushRepo:
    """base と head を持つ一時リポ。libs/text-rules は実ソースの複製と build 済みの dist で用意する。"""

    def __init__(self, repo: Path, git, git_rev_parse, repo_root: Path) -> None:
        self.repo = repo
        self._git = git
        self._rev = git_rev_parse
        self.package_dir = _copy_real_sources(repo)
        (repo / ".git/info/exclude").write_text("libs/\n")
        (repo / "README.md").write_text("# 見出し\n")
        self.commit("chore: init")
        self.base = self._rev(repo, "HEAD")
        git(repo, "update-ref", "refs/remotes/origin/main", self.base)
        git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
        git(repo, "checkout", "-q", "-b", "feature")

    def commit(self, message: str) -> None:
        self._git(self.repo, "add", "-A")
        self._git(self.repo, "commit", "-q", "-m", message)

    def write(self, rel: str, text: str) -> None:
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def head(self) -> str:
        return self._rev(self.repo, "HEAD")


@pytest.fixture
def push_repo(git_repo, git, git_rev_parse, repo_root: Path) -> _PushRepo:
    _require_bin(repo_root)
    return _PushRepo(git_repo("push", initial_branch="main"), git, git_rev_parse, repo_root)


def _run_push(script_dir: Path, run_script, h: _PushRepo):
    return run_script(
        script_dir.parent / "pre-push" / "check-text-push.sh",
        cwd=h.repo,
        env={"PRE_COMMIT_TO_REF": h.head()},
    )


def test_check_text_push_reports_violation_in_range(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    push_repo.write("docs-src/bad.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
    push_repo.commit("feat: bad")
    result = _run_push(script_dir, run_script, push_repo)
    assert result.returncode == 1
    assert "docs-src/bad.md:3:" in result.stdout, result.stdout


def test_check_text_push_rebuilds_stale_dist(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    before = _stamp(push_repo.package_dir)
    _disable_all_rules(push_repo.package_dir)
    push_repo.write("docs-src/long.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
    push_repo.commit("feat: long")
    result = _run_push(script_dir, run_script, push_repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert _stamp(push_repo.package_dir) != before


def test_check_text_push_errors_without_deps(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    (push_repo.package_dir / "node_modules").unlink()
    push_repo.write("docs-src/a.md", "# 見出し\n")
    push_repo.commit("feat: add")
    result = _run_push(script_dir, run_script, push_repo)
    _assert_deps_guidance(result)


def test_check_text_push_ignores_violation_outside_range(
    script_dir: Path, run_script, push_repo: _PushRepo, git
) -> None:
    """main 側の既存違反は、main を取り込んだブランチの範囲に入らない。"""
    git(push_repo.repo, "checkout", "-q", "main")
    push_repo.write("old.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
    push_repo.commit("chore: old violation on main")
    git(push_repo.repo, "update-ref", "refs/remotes/origin/main", push_repo.head())
    git(push_repo.repo, "checkout", "-q", "feature")
    git(push_repo.repo, "rebase", "-q", "main")
    push_repo.write("new.md", "# 見出し\n\n短い文を書く。\n")
    push_repo.commit("feat: clean")
    result = _run_push(script_dir, run_script, push_repo)
    assert result.returncode == 0, result.stdout + result.stderr


def test_check_text_push_passes_without_text_targets(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    """範囲内の変更が対象外の拡張子と生成物（CHANGELOG・golden）だけなら、違反があっても通る。"""
    push_repo.write("logo.txt", _LONG_SENTENCE)
    push_repo.write(
        "plugins/pecot-workflow/cli-node/tests/parity/golden/x.md",
        f"# 見出し\n\n{_LONG_SENTENCE}\n",
    )
    push_repo.write("pkg/CHANGELOG.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
    push_repo.commit("feat: non targets")
    result = _run_push(script_dir, run_script, push_repo)
    assert result.returncode == 0, result.stdout + result.stderr


def test_check_text_push_skips_deleted_files(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    push_repo.write("gone.md", "# 見出し\n")
    push_repo.commit("feat: add")
    (push_repo.repo / "gone.md").unlink()
    push_repo.commit("feat: remove")
    result = _run_push(script_dir, run_script, push_repo)
    assert result.returncode == 0, result.stdout + result.stderr


def test_check_text_push_without_push_info_warns_and_passes(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    result = run_script(
        script_dir.parent / "pre-push" / "check-text-push.sh", stdin="", cwd=push_repo.repo
    )
    assert result.returncode == 0
    assert "WARN" in result.stderr
