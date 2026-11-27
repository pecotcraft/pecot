"""check-text.sh と check-commit-text.sh のテスト（#1280）。

どちらも libs/text-rules/dist の bin を起動する薄いラッパー。
違反ケースは実リポの root を cwd にして実 bin を動かす。
dist が無い場合は、dist を持たない一時リポを cwd にして ERROR を確かめる。
依存が欠けている場合は、dist だけを持ち root の node_modules を持たない一時リポを使う。
フックは root の `pnpm install --frozen-lockfile` で依存を戻してから続ける。pnpm は PATH に置いた偽物で、戻せる場合と戻せない場合を作る。
依存は root の node_modules にある (#113)。
dist が古い・無い場合は、実ソースを複製した一時リポでフックが build.mjs を動かして作り直す (#1331)。
違反文は literal で持たず、101 文字の本文から組み立てる。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

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
        pytest.fail(
            "libs/text-rules/dist が無い。root で pnpm install --frozen-lockfile を実行してください"
        )


def _repo_with_dist_only(git_repo: Callable[..., Path]) -> Path:
    """dist の bin はあるが、root の node_modules が無い一時リポ。

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
    out = run_attached(
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

    link_node_modules が真なら、複製リポの root の node_modules を実リポへの symlink にして dist を作る。
    偽なら、node_modules と dist の両方が無い状態で返す。
    dist は複製側で作る。symlink にすると、フックの build.mjs が実 dist を消してしまう。
    """
    real = _real_root() / "libs/text-rules"
    real_node_modules = _real_root() / "node_modules"
    if not real_node_modules.is_dir():
        pytest.fail(
            "root の node_modules が無い。root で pnpm install --frozen-lockfile を実行してください"
        )
    package_dir = repo / "libs/text-rules"
    for rel in _real_sources():
        (package_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(real / rel, package_dir / rel)
    if link_node_modules:
        os.symlink(real_node_modules, repo / "node_modules")
        subprocess.run(["node", str(package_dir / "scripts/build.mjs")], check=True)
    return package_dir


def _stamp(package_dir: Path) -> str:
    return read_output(package_dir / "dist/source-hash")


def _expected_stamp(package_dir: Path) -> str:
    out = run_attached(
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


def _fake_pnpm(tmp_path: Path, *, restores: bool, link_real: bool = False) -> tuple[dict, Path]:
    """呼び出しと cwd を記録する偽の pnpm を PATH の先頭に置く env と、記録ファイルを返す。

    restores が真なら、cwd（repo root）の node_modules に依存の実体を置いて 0 で終わる。
    link_real も真なら、実体の代わりに実リポの node_modules への symlink を置く。
    偽なら何も置かずに 1 で終わる。
    """
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    calls = tmp_path / "pnpm-calls"
    body = 'echo "$*" >> "$PNPM_CALLS"\n'
    if restores and link_real:
        body += 'ln -s "$REAL_NODE_MODULES" "$PWD/node_modules"\n'
    elif restores:
        body += (
            'dep="$PWD/node_modules/@textlint/kernel"\n'
            'mkdir -p "$dep"\n'
            'printf \'%s\' \'{"name":"@textlint/kernel","type":"module","main":"index.js"}\''
            ' > "$dep/package.json"\n'
            ': > "$dep/index.js"\n'
        )
    else:
        body += "exit 1\n"
    pnpm = bin_dir / "pnpm"
    pnpm.write_text("#!/usr/bin/env bash\n" + body)
    pnpm.chmod(0o755)
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "PNPM_CALLS": str(calls),
        "REAL_NODE_MODULES": str(_real_root() / "node_modules"),
    }
    return env, calls


def _pnpm_calls(calls: Path) -> list[str]:
    return read_output(calls).splitlines() if calls.exists() else []


def _assert_deps_guidance(result) -> None:
    assert result.returncode == 1
    errors = [line for line in result.stderr.splitlines() if line.startswith("ERROR:")]
    assert any(
        "依存が欠けている" in line and "pnpm install --frozen-lockfile" in line for line in errors
    ), result.stderr
    assert "ERR_MODULE_NOT_FOUND" not in result.stderr + result.stdout


@allure.title(
    "文の長さの規則に違反するファイルを渡すと、sentence-length の違反を出力して失敗で終わる"
)
def test_check_text_reports_violation(
    script_dir: Path, repo_root: Path, work_dir: Path, run_script
) -> None:
    """`check-text.sh` に、101 文字の文を含む Markdown を渡した場合のテストです。終了コード 1 で終わり、違反した行を `sentence-length` の規則名とともに出力することを確認します。"""
    with allure.step("長い文を含む bad.md を書き、check-text.sh を動かす"):
        _require_bin(repo_root)
        target = work_dir / "bad.md"
        target.write_text(f"# 見出し\n\n{_LONG_SENTENCE}\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=repo_root)

    with allure.step("終了コード 1 と、sentence-length の違反を確かめる"):
        assert result.returncode == 1
        lines = [line for line in result.stdout.splitlines() if line.startswith(f"{target}:3:")]
        assert any("sentence-length" in line for line in lines), result.stdout


@allure.title("違反のないファイルを渡すと、何も出力せず成功で終わる")
def test_check_text_passes_clean_file(
    script_dir: Path, repo_root: Path, work_dir: Path, run_script
) -> None:
    """`check-text.sh` に、短い文だけを含む Markdown を渡した場合のテストです。終了コード 0 で終わり、標準出力に何も出力しないことを確認します。"""
    with allure.step("短い文だけの ok.md を書き、check-text.sh を動かす"):
        _require_bin(repo_root)
        target = work_dir / "ok.md"
        target.write_text("# 見出し\n\n短い文を書く。\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=repo_root)

    with allure.step("終了コード 0 で、出力が空であることを確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert result.stdout == ""


@allure.title("引数を渡さずに check-text.sh を実行すると、成功で終わる")
def test_check_text_without_arguments_passes(script_dir: Path, repo_root: Path, run_script) -> None:
    """`check-text.sh` を引数なしで実行するテストです。確認の対象が 0 件のため、終了コード 0 で終わることを確認します。"""
    with allure.step("引数なしで check-text.sh を動かす"):
        result = run_script(script_dir / "check-text.sh", cwd=repo_root)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0


@allure.title("ビルド成果物（dist）が存在しないと、pnpm install の案内を出力して失敗で終わる")
def test_check_text_errors_without_dist(
    script_dir: Path, git_repo: Callable[..., Path], run_script
) -> None:
    """`libs/text-rules/dist` を持たない一時リポジトリで、`check-text.sh` を実行した場合のテストです。終了コード 1 で終わり、`pnpm install --frozen-lockfile` を案内する `ERROR:` の行を出力することを確認します。"""
    with allure.step("dist の無いリポで check-text.sh を動かす"):
        repo = git_repo("nodist")
        target = repo / "a.md"
        target.write_text("# 見出し\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=repo)

    with allure.step("終了コード 1 と、pnpm install の案内を確かめる"):
        assert result.returncode == 1
        errors = [line for line in result.stderr.splitlines() if line.startswith("ERROR:")]
        assert any("pnpm install --frozen-lockfile" in line for line in errors), result.stderr


@allure.title("依存が欠けていて pnpm install でも戻せないと、案内を出力して失敗で終わる")
def test_check_text_errors_when_deps_cannot_be_restored(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    """`dist` は存在するが、root の `node_modules` が存在しない状態で、`check-text.sh` を実行したときのテストです。偽の `pnpm` が失敗する場合に、終了コード 1 で終わり、依存が欠けている旨の案内を出力し、`pnpm install --frozen-lockfile` を 1 回だけ呼び出すことを確認します。"""
    with allure.step(
        "dist だけあるリポと、復旧できない偽の pnpm を用意して check-text.sh を動かす"
    ):
        repo = _repo_with_dist_only(git_repo)
        env, calls = _fake_pnpm(tmp_path, restores=False)
        target = repo / "a.md"
        target.write_text("# 見出し\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=repo, env=env)
        _assert_deps_guidance(result)

    with allure.step("依存が欠けている案内と、pnpm の呼び出しを確かめる"):
        assert _pnpm_calls(calls) == ["install --frozen-lockfile"]


@allure.title(
    "依存が欠けていても pnpm install で戻せると、戻してから文章規則を適用して成功で終わる"
)
def test_check_text_restores_missing_deps(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    """`dist` は存在するが、root の `node_modules` が存在しない状態で、`check-text.sh` を実行したときのテストです。偽の `pnpm` が依存を戻す場合に、終了コード 0 で終わり、`pnpm install --frozen-lockfile` を 1 回だけ呼び出して、`ERROR:` を出力しないことを確認します。"""
    with allure.step("dist だけあるリポと、復旧できる偽の pnpm を用意して check-text.sh を動かす"):
        repo = _repo_with_dist_only(git_repo)
        env, calls = _fake_pnpm(tmp_path, restores=True)
        target = repo / "a.md"
        target.write_text("# 見出し\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=repo, env=env)

    with allure.step("終了コード 0 と、install を 1 回呼んだことを確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert result.stdout == ""
        assert _pnpm_calls(calls) == ["install --frozen-lockfile"]
        assert "ERROR:" not in result.stderr


@allure.title("dist がソースより古いと、作り直してから文章規則を適用する")
def test_check_text_rebuilds_stale_dist(script_dir: Path, source_repo: Path, run_script) -> None:
    """規則のソース（`lib/rules.ts`）を変更して、`dist` が古くなった状態で `check-text.sh` を実行するテストです。`dist` を作り直す旨を出力し、新しい規則で確認して成功し、`source-hash` が期待値に更新されることを確認します。"""
    with allure.step("lib/ の規則を変えて dist を古くし、check-text.sh を動かす"):
        package_dir = source_repo / "libs/text-rules"
        before = _stamp(package_dir)
        _disable_all_rules(package_dir)
        target = source_repo / "long.md"
        target.write_text(f"# 見出し\n\n{_LONG_SENTENCE}\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=source_repo)

    with allure.step("dist が作り直され、stamp が更新されたことを確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert result.stdout == ""
        assert "作り直します" in result.stderr
        assert _stamp(package_dir) != before
        assert _stamp(package_dir).strip() == _expected_stamp(package_dir)


@allure.title("依存と dist の両方が存在しないと、依存を戻し、dist を作ってから成功で終わる")
def test_check_text_restores_deps_then_builds_dist(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    """root の `node_modules` と `dist` の両方が存在しない一時リポジトリで、`check-text.sh` を実行したときのテストです。依存が欠けている旨と `dist` を作り直す旨を出力し、終了コード 0 で終わり、`source-hash` が期待値と一致することを確認します。"""
    with allure.step("依存・dist の無いリポで check-text.sh を動かす"):
        repo = git_repo("fresh-clone")
        package_dir = _copy_real_sources(repo, link_node_modules=False)
        env, calls = _fake_pnpm(tmp_path, restores=True, link_real=True)
        target = repo / "a.md"
        target.write_text("# 見出し\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=repo, env=env)

    with allure.step("依存の復旧と dist の作成が順に行われたことを確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert _pnpm_calls(calls) == ["install --frozen-lockfile"]
        assert "依存が欠けている" in result.stderr
        assert "作り直します" in result.stderr
        assert _stamp(package_dir).strip() == _expected_stamp(package_dir)


@allure.title("dist のビルドに失敗すると、ERROR を出力して失敗で終わり、source-hash を書き込まない")
def test_check_text_errors_when_build_fails(
    script_dir: Path, source_repo: Path, run_script
) -> None:
    """ソースに型エラーを入れ、`dist` を削除して `check-text.sh` を実行したときのテストです。終了コード 1 で終わり、`dist` を作れない旨を出力して、`source-hash` を書き込まないことを確認します。"""
    with allure.step("ビルドが失敗して dist が無い状態で check-text.sh を動かす"):
        package_dir = source_repo / "libs/text-rules"
        with (package_dir / "lib/findings.ts").open("a") as f:
            f.write("\nconst broken: number = 'a'\n")
        shutil.rmtree(package_dir / "dist")
        target = source_repo / "ok.md"
        target.write_text("# 見出し\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=source_repo)

    with allure.step("終了コード 1 と、stamp が書かれないことを確かめる"):
        assert result.returncode == 1
        assert "作れません" in result.stderr
        assert result.stdout == ""
        assert not (package_dir / "dist/source-hash").exists()


@allure.title("ソースが dist と同じなら、dist を作り直さない")
def test_check_text_keeps_fresh_dist(script_dir: Path, source_repo: Path, run_script) -> None:
    """ソースと `dist` が一致している状態で `check-text.sh` を実行するテストです。終了コード 0 で終わり、作り直す旨を出力せず、`source-hash` の内容と更新時刻が変わらないことを確認します。"""
    with allure.step("dist が新しい状態で check-text.sh を動かす"):
        package_dir = source_repo / "libs/text-rules"
        stamp_file = package_dir / "dist/source-hash"
        before = (_stamp(package_dir), stamp_file.stat().st_mtime_ns)
        target = source_repo / "ok.md"
        target.write_text("# 見出し\n\n短い文を書く。\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=source_repo)

    with allure.step("作り直さず、stamp が動かないことを確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert "作り直します" not in result.stderr
        assert (_stamp(package_dir), stamp_file.stat().st_mtime_ns) == before


@allure.title("dist が存在しなくても、ソースがあれば作ってから文章規則を適用する")
def test_check_text_builds_missing_dist(script_dir: Path, source_repo: Path, run_script) -> None:
    """`dist` を削除して、違反のあるファイルで `check-text.sh` を実行するテストです。`dist` を作ったうえで、終了コード 1 で終わり、`sentence-length` を出力して、`source-hash` が期待値と一致することを確認します。"""
    with allure.step("dist を消して check-text.sh を動かす"):
        package_dir = source_repo / "libs/text-rules"
        shutil.rmtree(package_dir / "dist")
        target = source_repo / "long.md"
        target.write_text(f"# 見出し\n\n{_LONG_SENTENCE}\n")
        result = run_script(script_dir / "check-text.sh", str(target), cwd=source_repo)

    with allure.step("dist が作られ、違反が出ることを確かめる"):
        assert result.returncode == 1, result.stdout + result.stderr
        assert "sentence-length" in result.stdout
        assert (package_dir / "dist/bin/pecot-text-lint.js").is_file()
        assert _stamp(package_dir).strip() == _expected_stamp(package_dir)


@allure.title(
    "コミットメッセージに文の長さの規則の違反があると、sentence-length を出力して失敗で終わる"
)
def test_check_commit_text_reports_violation(
    script_dir: Path, repo_root: Path, work_dir: Path, run_script
) -> None:
    """`check-commit-text.sh` に、101 文字の文を含むコミットメッセージを渡した場合のテストです。終了コード 1 で終わり、3 行目の違反を `sentence-length` とともに出力することを確認します。"""
    with allure.step("長い文を含むコミットメッセージで check-commit-text.sh を動かす"):
        _require_bin(repo_root)
        message = work_dir / "COMMIT_EDITMSG"
        message.write_text(f"test: 動作確認\n\n{_LONG_SENTENCE}\n")
        result = run_script(
            script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=repo_root
        )

    with allure.step("終了コード 1 と、違反の表示を確かめる"):
        assert result.returncode == 1
        assert f"{message}:3:" in result.stdout
        assert "sentence-length" in result.stdout


@allure.title("コミットメッセージの # で始まるコメント行は、確認の対象にしない")
def test_check_commit_text_ignores_comment_lines(
    script_dir: Path, repo_root: Path, work_dir: Path, run_script
) -> None:
    """違反する文を `#` で始まるコメント行に書いた、コミットメッセージのテストです。コメント行は確認しないため、終了コード 0 で終わることを確認します。"""
    with allure.step("コメント行だけが長いコミットメッセージで check-commit-text.sh を動かす"):
        _require_bin(repo_root)
        message = work_dir / "COMMIT_EDITMSG"
        message.write_text(f"test: 動作確認\n\n# {_LONG_SENTENCE}\n")
        result = run_script(
            script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=repo_root
        )

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr


@allure.title(
    "ビルド成果物（dist）が存在しないと、コミットメッセージの確認は pnpm install の案内を出力して失敗で終わる"
)
def test_check_commit_text_errors_without_dist(
    script_dir: Path, git_repo: Callable[..., Path], run_script
) -> None:
    """`libs/text-rules/dist` を持たない一時リポジトリで、`check-commit-text.sh` を実行した場合のテストです。終了コード 1 で終わり、`pnpm install --frozen-lockfile` を案内する `ERROR:` の行を出力することを確認します。"""
    with allure.step("dist の無いリポで check-commit-text.sh を動かす"):
        repo = git_repo("nodist")
        message = repo / "COMMIT_EDITMSG"
        message.write_text("test: 動作確認\n")
        result = run_script(
            script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=repo
        )

    with allure.step("終了コード 1 と、pnpm install の案内を確かめる"):
        assert result.returncode == 1
        errors = [line for line in result.stderr.splitlines() if line.startswith("ERROR:")]
        assert any("pnpm install --frozen-lockfile" in line for line in errors), result.stderr


@allure.title(
    "依存が欠けていて pnpm install でも戻せないと、コミットメッセージの確認は案内を出力して失敗で終わる"
)
def test_check_commit_text_errors_when_deps_cannot_be_restored(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    """`dist` は存在するが、root の `node_modules` が存在しない状態で、`check-commit-text.sh` を実行したときのテストです。偽の `pnpm` が失敗する場合に、終了コード 1 で終わり、依存が欠けている旨の案内を出力し、`pnpm install --frozen-lockfile` を 1 回だけ呼び出すことを確認します。"""
    with allure.step(
        "dist だけあるリポと、復旧できない偽の pnpm を用意して check-commit-text.sh を動かす"
    ):
        repo = _repo_with_dist_only(git_repo)
        env, calls = _fake_pnpm(tmp_path, restores=False)
        message = repo / "COMMIT_EDITMSG"
        message.write_text("test: 動作確認\n")
        result = run_script(
            script_dir.parent / "commit-msg" / "check-commit-text.sh",
            str(message),
            cwd=repo,
            env=env,
        )

    with allure.step("依存が欠けている案内と、pnpm の呼び出しを確かめる"):
        _assert_deps_guidance(result)
        assert _pnpm_calls(calls) == ["install --frozen-lockfile"]


@allure.title(
    "依存が欠けていても pnpm install で戻せると、コミットメッセージの確認は戻してから成功で終わる"
)
def test_check_commit_text_restores_missing_deps(
    script_dir: Path, git_repo: Callable[..., Path], run_script, tmp_path: Path
) -> None:
    """`dist` は存在するが、root の `node_modules` が存在しない状態で、`check-commit-text.sh` を実行したときのテストです。偽の `pnpm` が依存を戻す場合に、終了コード 0 で終わり、`pnpm install --frozen-lockfile` を 1 回だけ呼び出すことを確認します。"""
    with allure.step(
        "dist だけあるリポと、復旧できる偽の pnpm を用意して check-commit-text.sh を動かす"
    ):
        repo = _repo_with_dist_only(git_repo)
        env, calls = _fake_pnpm(tmp_path, restores=True)
        message = repo / "COMMIT_EDITMSG"
        message.write_text("test: 動作確認\n")
        result = run_script(
            script_dir.parent / "commit-msg" / "check-commit-text.sh",
            str(message),
            cwd=repo,
            env=env,
        )

    with allure.step("終了コード 0 と、install を 1 回呼んだことを確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert _pnpm_calls(calls) == ["install --frozen-lockfile"]


@allure.title("dist がソースより古いと、コミットメッセージの確認は作り直してから文章規則を適用する")
def test_check_commit_text_rebuilds_stale_dist(
    script_dir: Path, source_repo: Path, run_script
) -> None:
    """規則のソース（`lib/rules.ts`）を変更して、`dist` が古くなった状態で `check-commit-text.sh` を実行するテストです。新しい規則で確認して終了コード 0 で終わり、`source-hash` が更新されることを確認します。"""
    with allure.step("lib/ の規則を変えて dist を古くし、check-commit-text.sh を動かす"):
        package_dir = source_repo / "libs/text-rules"
        before = _stamp(package_dir)
        _disable_all_rules(package_dir)
        message = source_repo / "COMMIT_EDITMSG"
        message.write_text(f"test: 動作確認\n\n{_LONG_SENTENCE}\n")
        result = run_script(
            script_dir.parent / "commit-msg" / "check-commit-text.sh", str(message), cwd=source_repo
        )

    with allure.step("終了コード 0 と、stamp の更新を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert _stamp(package_dir) != before


@allure.title(
    "引数を渡さずに check-commit-text.sh を実行すると、パスを渡す案内を出力して失敗で終わる"
)
def test_check_commit_text_without_argument_guides(
    script_dir: Path, repo_root: Path, run_script
) -> None:
    """`check-commit-text.sh` を引数なしで実行するテストです。終了コード 1 で終わり、`COMMIT_EDITMSG` のパスを渡す旨の案内を出力することを確認します。"""
    with allure.step("引数なしで check-commit-text.sh を動かす"):
        result = run_script(
            script_dir.parent / "commit-msg" / "check-commit-text.sh", cwd=repo_root
        )

    with allure.step("終了コード 1 と、COMMIT_EDITMSG の案内を確かめる"):
        assert result.returncode == 1
        assert "COMMIT_EDITMSG のパスを渡してください" in result.stderr


class _PushRepo:
    """base と head を持つ一時リポ。libs/text-rules は実ソースの複製と build 済みの dist で用意する。"""

    def __init__(self, repo: Path, git, git_rev_parse, repo_root: Path) -> None:
        self.repo = repo
        self._git = git
        self._rev = git_rev_parse
        self.package_dir = _copy_real_sources(repo)
        (repo / ".git/info/exclude").write_text("libs/\nnode_modules\n")
        (repo / "README.md").write_text("# 見出し\n")
        shutil.copyfile(repo_root / ".textlintignore", repo / ".textlintignore")
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


@allure.title("push の範囲に違反を含むファイルがあると、ファイルと行を出力して失敗で終わる")
def test_check_text_push_reports_violation_in_range(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    """`check-text-push.sh` の、push の範囲に違反を含む Markdown を追加したコミットがある場合のテストです。終了コード 1 で終わり、`docs-src/bad.md:3:` の形でファイルと行を出力することを確認します。"""
    with allure.step("違反のある文書を commit して、push のチェックを動かす"):
        push_repo.write("docs-src/bad.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
        push_repo.commit("feat: bad")
        result = _run_push(script_dir, run_script, push_repo)

    with allure.step("終了コード 1 と、違反の行を確かめる"):
        assert result.returncode == 1
        assert "docs-src/bad.md:3:" in result.stdout, result.stdout


@allure.title("push の確認でも、dist が古いと作り直してから文章規則を適用する")
def test_check_text_push_rebuilds_stale_dist(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    """規則のソースを変更して `dist` が古くなった状態で、`check-text-push.sh` を実行するテストです。新しい規則で確認して終了コード 0 で終わり、`source-hash` が更新されることを確認します。"""
    with allure.step("規則を変えて dist を古くし、長い文を commit して push のチェックを動かす"):
        before = _stamp(push_repo.package_dir)
        _disable_all_rules(push_repo.package_dir)
        push_repo.write("docs-src/long.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
        push_repo.commit("feat: long")
        result = _run_push(script_dir, run_script, push_repo)

    with allure.step("終了コード 0 と、stamp の更新を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert _stamp(push_repo.package_dir) != before


@allure.title("push の確認で依存が欠けていると、案内を出力して失敗で終わる")
def test_check_text_push_errors_without_deps(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    """root の `node_modules` を削除した状態で、`check-text-push.sh` を実行するテストです。終了コード 1 で終わり、依存が欠けている旨の案内を出力することを確認します。"""
    with allure.step("依存を消し、文書を commit して push のチェックを動かす"):
        (push_repo.repo / "node_modules").unlink()
        push_repo.write("docs-src/a.md", "# 見出し\n")
        push_repo.commit("feat: add")
        result = _run_push(script_dir, run_script, push_repo)

    with allure.step("依存が欠けている案内を確かめる"):
        _assert_deps_guidance(result)


@allure.title("push の範囲の外にある main の既存の違反は、確認の対象にしない")
def test_check_text_push_ignores_violation_outside_range(
    script_dir: Path, run_script, push_repo: _PushRepo, git
) -> None:
    """`main` に違反のあるファイルを追加し、`main` を取り込んだブランチで、違反のない変更を push する場合のテストです。範囲の外の違反は対象外のため、終了コード 0 で終わることを確認します。"""
    with allure.step(
        "main に違反を commit し、feature を rebase して違反の無い文書を足し、push のチェックを動かす"
    ):
        git(push_repo.repo, "checkout", "-q", "main")
        push_repo.write("old.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
        push_repo.commit("chore: old violation on main")
        git(push_repo.repo, "update-ref", "refs/remotes/origin/main", push_repo.head())
        git(push_repo.repo, "checkout", "-q", "feature")
        git(push_repo.repo, "rebase", "-q", "main")
        push_repo.write("new.md", "# 見出し\n\n短い文を書く。\n")
        push_repo.commit("feat: clean")
        result = _run_push(script_dir, run_script, push_repo)

    with allure.step("終了コード 0（範囲外の違反は対象外）を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr


@allure.title("push の範囲の変更が確認の対象外のファイルだけなら、違反があっても成功で終わる")
def test_check_text_push_passes_without_text_targets(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    """対象外の拡張子のファイルと、生成物（`CHANGELOG.md` と golden のファイル）だけを変更した場合のテストです。いずれも違反を含んでいても、終了コード 0 で終わることを確認します。"""
    with allure.step("対象外の拡張子と生成物に違反を書いて commit し、push のチェックを動かす"):
        push_repo.write("logo.txt", _LONG_SENTENCE)
        push_repo.write(
            "plugins/pecot-workflow/cli/tests/parity/golden/x.md",
            f"# 見出し\n\n{_LONG_SENTENCE}\n",
        )
        push_repo.write("pkg/CHANGELOG.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
        push_repo.commit("feat: non targets")
        result = _run_push(script_dir, run_script, push_repo)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr


@allure.title(
    ".textlintignore で除外したファイルの違反は通し、除外していないファイルの違反は止める"
)
def test_check_text_push_skips_textlintignore(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    """`.textlintignore` で除外した `specs/` の Markdown と、除外していない Markdown に、それぞれ違反がある場合のテストです。前者だけのときは終了コード 0、後者を追加したときは終了コード 1 で終わり、後者のファイルだけを出力することを確認します。"""
    with allure.step("specs/ に違反のある文書を commit する"):
        push_repo.write("specs/001-x/spec.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
        push_repo.commit("docs: spec")

    with allure.step("push のチェックを動かし、終了コード 0 を確かめる"):
        assert _run_push(script_dir, run_script, push_repo).returncode == 0

    with allure.step("docs-src に違反のある文書を commit して、push のチェックを動かす"):
        push_repo.write("docs-src/bad.md", f"# 見出し\n\n{_LONG_SENTENCE}\n")
        push_repo.commit("feat: bad")
        result = _run_push(script_dir, run_script, push_repo)

    with allure.step("終了コード 1 と、違反の表示の有無を確かめる"):
        assert result.returncode == 1
        assert "specs/001-x/spec.md" not in result.stdout, result.stdout
        assert "docs-src/bad.md:3:" in result.stdout, result.stdout


@allure.title("push の範囲で削除したファイルは、確認の対象にしない")
def test_check_text_push_skips_deleted_files(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    """追加したファイルを、次のコミットで削除した場合のテストです。存在しないファイルを確認せず、終了コード 0 で終わることを確認します。"""
    with allure.step("ファイルを追加して削除し、push のチェックを動かす"):
        push_repo.write("gone.md", "# 見出し\n")
        push_repo.commit("feat: add")
        (push_repo.repo / "gone.md").unlink()
        push_repo.commit("feat: remove")
        result = _run_push(script_dir, run_script, push_repo)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr


@allure.title("push の情報が渡されないと、警告を出力して成功で終わる")
def test_check_text_push_without_push_info_warns_and_passes(
    script_dir: Path, run_script, push_repo: _PushRepo
) -> None:
    """標準入力が空で、push の情報が渡されない場合の、`check-text-push.sh` のテストです。終了コード 0 で終わり、標準エラーに `WARN` を出力することを確認します。"""
    with allure.step("push の情報なしで check-text-push.sh を動かす"):
        result = run_script(
            script_dir.parent / "pre-push" / "check-text-push.sh", stdin="", cwd=push_repo.repo
        )

    with allure.step("終了コード 0 と、WARN の表示を確かめる"):
        assert result.returncode == 0
        assert "WARN" in result.stderr
