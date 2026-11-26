""".githooks/scripts/gen-runtime-lock.mjs の --check が、ずれを見つけて止まることを確かめる (#113)。"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import allure
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TARGET_DIRS = (
    "plugins/pecot-workflow",
    "libs/text-rules",
)


def _members() -> list[str]:
    text = (_REPO_ROOT / "pnpm-workspace.yaml").read_text(encoding="utf-8")
    return re.findall(r"^  - (\S+)$", text, flags=re.M)


def _first_package(lock_text: str) -> str:
    """runtime-lock の本体の文書で、integrity を持つ scope の無い先頭のキー（例: commander@15.0.0）。"""
    entry = re.search(
        r"^  ([a-z][\w.-]*@\d[\w.-]*):\n    resolution:\n      integrity: ",
        lock_text.split("\n---\n")[-1],
        flags=re.M,
    )
    assert entry, "runtime-lock に integrity を持つ package が無い"
    return entry.group(1)


def _drift_candidate(root_text: str, block: str) -> tuple[str, str, str]:
    """importer の依存のうち、root の lock に別の版も実在するもの（名前・今の版・別の版）。"""
    for name, version in re.findall(
        r"^      '?([^'\s:]+)'?:\n        specifier: .+\n        version: (\d[\w.-]*)$",
        block,
        flags=re.M,
    ):
        others = {
            v
            for v in re.findall(rf"^  '?{re.escape(name)}@(\d[\w.-]*)'?:$", root_text, flags=re.M)
            if v != version
        }
        if others:
            return name, version, sorted(others)[0]
    raise AssertionError("root の lock に別の版を持つ依存が無い")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """gen-runtime-lock.mjs が読むファイルだけを、作業ツリーから複製した repo。"""
    files = [
        ".githooks/scripts/gen-runtime-lock.mjs",
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
    ]
    files += [f"{member}/package.json" for member in _members()]
    files += [f"{d}/runtime-{name}.yaml" for d in _TARGET_DIRS for name in ("lock", "workspace")]
    for file in files:
        destination = tmp_path / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(_REPO_ROOT / file, destination)
    (tmp_path / "node_modules").symlink_to(_REPO_ROOT / "node_modules")
    return tmp_path


def _check(repo: Path) -> subprocess.CompletedProcess[str]:
    return run_attached(
        ["node", ".githooks/scripts/gen-runtime-lock.mjs", "--check"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )


def _edit(path: Path, old: str, new: str, count: int = 1) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text, f"{path} に {old} が無い"
    path.write_text(text.replace(old, new, count), encoding="utf-8")


def test_clean_tree_passes(repo: Path) -> None:
    with allure.step("runtime-lock のチェックを動かす"):
        result = _check(repo)

    with allure.step("終了コード 0 で、stderr が空であることを確かめる"):
        assert (result.returncode, result.stderr) == (0, "")


def test_member_dependency_change_stops_with_hint(repo: Path) -> None:
    with allure.step("メンバーの package.json の依存を書き換え、runtime-lock のチェックを動かす"):
        pkg = repo / "plugins/pecot-workflow/cli/package.json"
        data = json.loads(pkg.read_text(encoding="utf-8"))
        data["dependencies"]["commander"] = "^0.0.1"
        pkg.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        result = _check(repo)

    with allure.step("終了コード 1 と、直し方の案内を確かめる"):
        assert result.returncode == 1
        assert (
            "plugins/pecot-workflow/runtime-lock.yaml: cli の dependencies が package.json と一致しません"
            in result.stderr
        )
        assert "gen-runtime-lock.mjs --write" in result.stderr


def test_importer_missing_in_lock_stops(repo: Path) -> None:
    with allure.step("lock の importer を消し、runtime-lock のチェックを動かす"):
        lock = repo / "plugins/pecot-workflow/runtime-lock.yaml"
        _edit(lock, "  cli:\n", "  cli-gone:\n")
        result = _check(repo)

    with allure.step("終了コード 1 と、importers の不一致の表示を確かめる"):
        assert result.returncode == 1
        assert "plugins/pecot-workflow/runtime-lock.yaml: importers" in result.stderr


def test_workspace_setting_drift_stops(repo: Path) -> None:
    with allure.step("workspace の設定をずらし、runtime-lock のチェックを動かす"):
        _edit(
            repo / "plugins/pecot-workflow/runtime-workspace.yaml",
            "nodeLinker: hoisted",
            "nodeLinker: isolated",
        )
        result = _check(repo)

    with allure.step("終了コード 1 と、workspace の不一致の表示を確かめる"):
        assert result.returncode == 1
        assert "plugins/pecot-workflow/runtime-workspace.yaml" in result.stderr


def test_package_integrity_drift_stops(repo: Path) -> None:
    with allure.step("runtime-lock の最初のパッケージの integrity の位置を探す"):
        lock = repo / "plugins/pecot-workflow/runtime-lock.yaml"
        text = lock.read_text(encoding="utf-8")
        key = _first_package(text)
        entry = re.search(
            rf"^  {re.escape(key)}:\n    resolution:\n      integrity: sha512-", text, flags=re.M
        )

    with allure.step("integrity の位置が見つかることを確かめる"):
        assert entry

    with allure.step("integrity を書き換え、runtime-lock のチェックを動かす"):
        lock.write_text(text[: entry.end()] + "AAAA" + text[entry.end() :], encoding="utf-8")
        result = _check(repo)

    with allure.step("終了コード 1 と、integrity の不一致の表示を確かめる"):
        assert result.returncode == 1
        assert f"{key} の integrity が root の pnpm-lock.yaml と一致しません" in result.stderr


def test_package_missing_in_root_lock_stops(repo: Path) -> None:
    with allure.step("runtime-lock の最初のパッケージを選び、root の lock を読む"):
        key = _first_package(
            (repo / "plugins/pecot-workflow/runtime-lock.yaml").read_text(encoding="utf-8")
        )
        root_lock = repo / "pnpm-lock.yaml"
        text = root_lock.read_text(encoding="utf-8")

    with allure.step("root の lock にそのパッケージがあることを確かめる"):
        assert f"\n  {key}:\n" in text

    with allure.step("root の lock のパッケージ名を変え、runtime-lock のチェックを動かす"):
        root_lock.write_text(
            text.replace(f"\n  {key}:\n", f"\n  {key}-gone:\n", 1), encoding="utf-8"
        )
        result = _check(repo)

    with allure.step("終了コード 1 と、パッケージの不在の表示を確かめる"):
        assert result.returncode == 1
        assert f"{key} が root の pnpm-lock.yaml にありません" in result.stderr


def test_importer_version_drift_from_root_lock_stops(repo: Path) -> None:
    """root の lock で importer の版を別の実在する版に変えると、runtime-lock との差で止まる。"""
    with allure.step("root の lock から importer の block と、変える版を選ぶ"):
        root_lock = repo / "pnpm-lock.yaml"
        text = root_lock.read_text(encoding="utf-8")
        start = text.index("\n  plugins/pecot-workflow/cli:\n")
        end = re.search(r"\n  (?!  )\S", text[start + 1 :]).start() + start + 1
        block = text[start:end]
        name, version, other = _drift_candidate(text, block)
        pattern = re.compile(
            rf"(^      '?{re.escape(name)}'?:\n        specifier: .+\n        version: ){re.escape(version)}$",
            re.M,
        )

    with allure.step("置き換える行が見つかることを確かめる"):
        assert pattern.search(block)

    with allure.step("importer の版を別の版に変え、runtime-lock のチェックを動かす"):
        new_block = pattern.sub(rf"\g<1>{other}", block, count=1)
        root_lock.write_text(text[:start] + new_block + text[end:], encoding="utf-8")
        result = _check(repo)

    with allure.step("終了コード 1 と、importer の版の不一致の表示を確かめる"):
        assert result.returncode == 1
        assert (
            "plugins/pecot-workflow/runtime-lock.yaml: cli の importer の版が root の pnpm-lock.yaml と一致しません"
            in result.stderr
        )


def _write(repo: Path) -> None:
    result = run_attached(
        ["node", ".githooks/scripts/gen-runtime-lock.mjs", "--write"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_write_copies_referenced_catalog_only(repo: Path) -> None:
    # どの importer も参照しない項目を root の catalogs.default に足す。--write はこれを落とす。
    with allure.step("参照されない項目を root の catalogs に足し、--write を動かす"):
        _edit(
            repo / "pnpm-lock.yaml",
            "catalogs:\n  default:\n",
            "catalogs:\n  default:\n    unreferenced-sample:\n      specifier: ^1.0.0\n      version: 1.0.0\n",
        )
        _write(repo)

    with allure.step("参照される項目だけが各 runtime-lock に写ることを確かめる"):
        expected = "catalogs:\n  default:\n    vite:\n      specifier: ^"
        for d in ("plugins/pecot-workflow",):
            text = read_output(repo / d / "runtime-lock.yaml")
            assert expected in text, d
            assert "unreferenced-sample" not in text, d


def test_write_omits_catalogs_for_target_without_reference(repo: Path) -> None:
    with allure.step("--write を動かす"):
        _write(repo)

    with allure.step("参照の無い対象に catalogs が書かれないことを確かめる"):
        assert "catalogs:" not in read_output(repo / "libs/text-rules/runtime-lock.yaml")


def test_catalogs_missing_in_runtime_lock_stops(repo: Path) -> None:
    with allure.step("runtime-lock から catalogs を消し、チェックを動かす"):
        lock = repo / "plugins/pecot-workflow/runtime-lock.yaml"
        text = lock.read_text(encoding="utf-8")
        start = text.index("catalogs:\n")
        end = text.index("overrides:\n", start)
        lock.write_text(text[:start] + text[end:], encoding="utf-8")
        result = _check(repo)

    with allure.step("終了コード 1 と、catalogs の不一致の表示を確かめる"):
        assert result.returncode == 1
        assert (
            "plugins/pecot-workflow/runtime-lock.yaml: catalogs が root の pnpm-lock.yaml と一致しません"
            in result.stderr
        )


def test_runtime_lock_workflow_runs_an_existing_script() -> None:
    """dependabot-commit.yml は Dependabot の PR でしか動かない。run が指す script の実在をここで確かめる。"""
    with allure.step("dependabot-commit.yml から、実行する script を取り出す"):
        workflow = (_REPO_ROOT / ".github/workflows/dependabot-commit.yml").read_text(
            encoding="utf-8"
        )
        paths = re.findall(r"run:\s*node\s+(\S+gen-runtime-lock\.mjs)", workflow)

    with allure.step("script が gen-runtime-lock.mjs で、実在することを確かめる"):
        assert paths == [".githooks/scripts/gen-runtime-lock.mjs"]
        assert (_REPO_ROOT / paths[0]).is_file()


def test_runtime_lock_workflow_marks_commit_for_dependabot_rebase() -> None:
    """印が無いと、dependabot は他者の commit がある PR を rebase しない。"""
    with allure.step("dependabot-commit.yml の git commit の行を集める"):
        workflow = (_REPO_ROOT / ".github/workflows/dependabot-commit.yml").read_text(
            encoding="utf-8"
        )
        commits = re.findall(r"^\s*(git commit\b.*)$", workflow, re.M)

    with allure.step("[dependabot skip] の印が付くことを確かめる"):
        assert commits == ['git commit -m "$COMMIT_MSG" -m "[dependabot skip]"'], (
            f"git commit の行: {commits}"
        )


def test_write_reproduces_committed_files_without_pnpm(repo: Path) -> None:
    """--write は pnpm を呼ばず、commit 済みの生成物と同じものを作る。"""
    with allure.step("pnpm の無い PATH で --write を動かす"):
        empty_bin = repo / "empty-bin"
        empty_bin.mkdir()
        env = {**os.environ, "PATH": f"{empty_bin}:{Path(shutil.which('node') or '').parent}"}
        result = run_attached(
            ["node", ".githooks/scripts/gen-runtime-lock.mjs", "--write"],
            cwd=repo,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    with allure.step("commit 済みの生成物と同じものができ、チェックが通ることを確かめる"):
        assert result.returncode == 0, result.stderr
        for d in _TARGET_DIRS:
            for name in ("lock", "workspace"):
                file = f"{d}/runtime-{name}.yaml"
                assert read_output(repo / file) == (_REPO_ROOT / file).read_text(
                    encoding="utf-8"
                ), file
        assert _check(repo).returncode == 0


def test_workflow_creates_version_plans_before_commit() -> None:
    """version plan は dependabot-plans.js --pr で作り、add -A を先にして staged の差分で判定する。"""
    with allure.step("dependabot-commit.yml を読む"):
        workflow = (_REPO_ROOT / ".github/workflows/dependabot-commit.yml").read_text(
            encoding="utf-8"
        )

    with allure.step("version plan の作成が commit の前にあることを確かめる"):
        assert re.search(
            r'run:\s*node\s+\.nx/nx-release/src/dependabot-plans\.js --pr "\$PR_NUMBER"', workflow
        )
        assert (_REPO_ROOT / ".nx/nx-release/src/dependabot-plans.js").is_file()
        add = "git add -A -- ':(glob)**/runtime-*.yaml' .nx/version-plans"
        assert workflow.index(add) < workflow.index("git diff --cached --quiet")


def _workflow() -> dict:
    return yaml.safe_load(
        (_REPO_ROOT / ".github/workflows/dependabot-commit.yml").read_text(encoding="utf-8")
    )


def _steps() -> list[dict]:
    return _workflow()["jobs"]["regenerate"]["steps"]


def test_workflow_runs_on_every_pull_request_path() -> None:
    """paths で絞ると、lock の変更を含まない更新で plan が作られない。"""
    with allure.step("workflow の on を読む"):
        on = _workflow()[True]  # YAML 1.1 では on が True になる

    with allure.step("pull_request に paths の絞りが無いことを確かめる"):
        assert on["pull_request"] is None or "paths" not in on["pull_request"]


def test_workflow_checks_out_full_history() -> None:
    with allure.step("Checkout の step を探す"):
        checkout = next(s for s in _steps() if s.get("name") == "Checkout")

    with allure.step("fetch-depth が 0 であることを確かめる"):
        assert checkout["with"]["fetch-depth"] == 0


def test_workflow_passes_origin_base_to_plans() -> None:
    with allure.step("plans の step を探す"):
        plans = next(s for s in _steps() if s.get("id") == "plans")

    with allure.step("origin の base を渡し、continue-on-error であることを確かめる"):
        assert '--base "origin/$BASE_REF"' in plans["run"]
        assert plans["continue-on-error"] is True


def test_workflow_fails_after_push_when_plans_failed() -> None:
    with allure.step("step の並びから、Push と失敗の step の位置を探す"):
        steps = _steps()
        names = [s.get("name") for s in steps]
        push = names.index("Push generated files")
        fail = next(
            i
            for i, s in enumerate(steps)
            if s.get("if") == "${{ steps.plans.outcome == 'failure' }}"
        )

    with allure.step("失敗の step が push の後にあり、exit 1 を含むことを確かめる"):
        assert push < fail
        assert "exit 1" in steps[fail]["run"]


def test_workflow_adds_only_generated_paths() -> None:
    """生成物の path に絞る。pathspec が runtime-lock.yaml の置き場に当たることも確かめる。"""
    with allure.step("git ls-files で runtime-*.yaml の pathspec を引く"):
        listed = run_attached(
            ["git", "ls-files", "--", ":(glob)**/runtime-*.yaml"],
            cwd=_REPO_ROOT, capture_output=True, text=True, check=True,
        ).stdout.split()  # fmt: skip

    with allure.step("各 runtime-lock.yaml が含まれることを確かめる"):
        assert {f"{d}/runtime-lock.yaml" for d in _TARGET_DIRS} <= set(listed)
