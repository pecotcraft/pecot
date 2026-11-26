"""check-release-group-changelog.sh のユニットテスト（#1087）。

nx release は CHANGELOG が既存のときだけ新しい節を先頭へ結合する。
不在・空だと末尾改行なしで新規作成され、end-of-file-fixer が release commit を落とす。
そのため、release group の CHANGELOG が「存在・非空・末尾改行」を満たすことを、
commit 時に強制する。
ここではその判定と fail-open 挙動を検証する。

スクリプトは `git rev-parse --show-toplevel` でリポルートを解決する。
そのためテストは、git_repo fixture で作った temp リポを cwd にして起動する。
"""

from __future__ import annotations

import json
from pathlib import Path

import allure
import pytest

SCRIPT = "check-release-group-changelog.sh"


def _group(file: object) -> dict:
    """`changelog.file` に任意値を持つ release group 定義を作る。

    `file=None` は `changelog: {}`（`file` 未定義）を意味する。
    `changelog` 自体に値を入れたいときは `_group_changelog()` を使う。
    """
    return {
        "projects": ["dummy"],
        "changelog": {"file": file} if file is not None else {},
    }


def _group_changelog(changelog: object) -> dict:
    """`changelog` キーそのものに任意値を持つ release group 定義を作る。"""
    return {"projects": ["dummy"], "changelog": changelog}


def _write_nx_json(repo: Path, groups: dict) -> None:
    (repo / "nx.json").write_text(
        json.dumps(
            {"release": {"groups": groups, "changelog": {"workspaceChangelog": False}}},
            ensure_ascii=False,
        )
    )


def _write_changelog(repo: Path, rel: str, content: str) -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


@pytest.fixture
def repo(git_repo) -> Path:
    """nx.json（pecot-workflow / pecot-visual の 2 group）と正しい CHANGELOG を持つ temp リポ。"""
    r = git_repo("nxrepo")
    _write_nx_json(
        r,
        {
            "pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md"),
            "pecot-visual": _group("plugins/pecot-visual/CHANGELOG.md"),
        },
    )
    _write_changelog(r, "plugins/pecot-workflow/CHANGELOG.md", "# pecot-workflow\n")
    _write_changelog(r, "plugins/pecot-visual/CHANGELOG.md", "# pecot-visual\n")
    return r


@allure.title(
    "すべての release group の CHANGELOG が存在し、空でなく、末尾に改行があれば、成功で終わる"
)
def test_all_groups_satisfied_passes(script_dir: Path, repo: Path, run_script) -> None:
    """`check-release-group-changelog.sh` の、正常な場合のテストです。すべての group の CHANGELOG が存在し、空ではなく、末尾が改行で終わっているときに、終了コード 0 で終わることを確認します。"""
    with allure.step("全 group の CHANGELOG がそろった状態で hook を動かす"):
        result = run_script(script_dir / SCRIPT, cwd=repo)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr


@allure.title("CHANGELOG が存在しない group があると、group 名と作成の手順を出力して失敗で終わる")
def test_missing_file_fails_with_group_and_seed_hint(
    script_dir: Path, repo: Path, run_script
) -> None:
    """group を追加して、CHANGELOG を作成していない場合のテストです。終了コード 1 で終わり、group 名とファイルのパス、作成用の `printf` の手順を出力することを確認します。"""
    with allure.step("CHANGELOG の無い group を足して hook を動かす"):
        _write_nx_json(
            repo,
            {
                "pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md"),
                "pecot-visual": _group("plugins/pecot-visual/CHANGELOG.md"),
                "pecot-tools": _group("plugins/pecot-tools/CHANGELOG.md"),
            },
        )
        result = run_script(script_dir / SCRIPT, cwd=repo)
        out = result.stdout + result.stderr

    with allure.step("終了コード 1 と、group 名・seed の手順の表示を確かめる"):
        assert result.returncode == 1
        assert "pecot-tools" in out
        assert "plugins/pecot-tools/CHANGELOG.md" in out
        assert "printf" in out


@allure.title("CHANGELOG が空ファイルだと、失敗で終わる")
def test_empty_file_fails(script_dir: Path, repo: Path, run_script) -> None:
    """CHANGELOG が空ファイルの場合のテストです。Nx が新規作成する場合と同じ状態になるため、終了コード 1 で終わり、group 名と、空であることを示すメッセージを出力することを確認します。"""
    with allure.step("CHANGELOG を空にして hook を動かす"):
        _write_changelog(repo, "plugins/pecot-visual/CHANGELOG.md", "")
        result = run_script(script_dir / SCRIPT, cwd=repo)
        out = result.stdout + result.stderr

    with allure.step("終了コード 1 と、group 名・「空」の表示を確かめる"):
        assert result.returncode == 1
        assert "pecot-visual" in out
        assert "空" in out


@allure.title("CHANGELOG の末尾に改行が存在しないと、失敗で終わる")
def test_missing_trailing_newline_fails(script_dir: Path, repo: Path, run_script) -> None:
    """CHANGELOG の末尾に改行が存在しない場合のテストです。end-of-file-fixer がコミットを失敗させるため、終了コード 1 で終わり、ファイルのパスと改行に関するメッセージを出力することを確認します。"""
    with allure.step("末尾改行の無い CHANGELOG を置いて hook を動かす"):
        _write_changelog(repo, "plugins/pecot-workflow/CHANGELOG.md", "# pecot-workflow")
        result = run_script(script_dir / SCRIPT, cwd=repo)
        out = result.stdout + result.stderr

    with allure.step("終了コード 1 と、パス・「改行」の表示を確かめる"):
        assert result.returncode == 1
        assert "plugins/pecot-workflow/CHANGELOG.md" in out
        assert "改行" in out


@allure.title("CHANGELOG のパスがディレクトリだと、ファイルではない旨を出力して失敗で終わる")
def test_directory_path_fails_with_not_a_file_message(
    script_dir: Path, repo: Path, run_script
) -> None:
    """CHANGELOG のパスがディレクトリの場合のテストです。終了コード 1 で終わり、「存在しません」ではなく「ファイルではありません」と、リポジトリルートからの相対パスで指定する旨を出力することを確認します。"""
    with allure.step("CHANGELOG のパスをディレクトリにして hook を動かす"):
        _write_nx_json(
            repo,
            {
                "pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md"),
                "pecot-visual": _group("plugins/pecot-visual/CHANGELOG.md"),
                "pecot-tools": _group("plugins/pecot-tools/CHANGELOG.md"),
            },
        )
        (repo / "plugins/pecot-tools/CHANGELOG.md").mkdir(parents=True)
        result = run_script(script_dir / SCRIPT, cwd=repo)
        out = result.stdout + result.stderr

    with allure.step("終了コード 1 と、「ファイルではありません」の表示を確かめる"):
        assert result.returncode == 1
        assert "pecot-tools" in out
        assert "ファイルではありません" in out
        assert "リポジトリルートからの相対パス" in out


@allure.title("CHANGELOG を無効にした group（{changelog}）は、警告を出さずに確認を飛ばす")
@pytest.mark.parametrize(
    "changelog",
    [
        pytest.param(False, id="changelog-false"),
        pytest.param({"file": False}, id="file-false"),
    ],
)
def test_disabled_project_changelog_is_silently_skipped(
    script_dir: Path, repo: Path, run_script, changelog: object
) -> None:
    """`changelog` に `false` を指定した場合や、`file` に `false` を指定した場合のテストです。生成物が存在しないため、終了コード 0 で終わり、標準エラーに group 名を出力しないことを確認します。"""
    with allure.step("CHANGELOG を無効にした group を足して hook を動かす"):
        _write_nx_json(
            repo,
            {
                "pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md"),
                "pecot-visual": _group("plugins/pecot-visual/CHANGELOG.md"),
                "nofile": _group_changelog(changelog),
            },
        )
        result = run_script(script_dir / SCRIPT, cwd=repo)

    with allure.step("終了コード 0 で、WARN が出ないことを確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert "nofile" not in result.stderr


@allure.title("CHANGELOG のパスが文字列でない group（{changelog}）は、警告を出して確認を飛ばす")
@pytest.mark.parametrize(
    "changelog",
    [
        pytest.param(True, id="changelog-true"),
        pytest.param({}, id="file-undefined"),
        pytest.param({"file": 1}, id="file-non-string"),
    ],
)
def test_non_string_changelog_file_warns_and_skips(
    script_dir: Path, repo: Path, run_script, changelog: object
) -> None:
    """`changelog` が `true` の場合や、`file` が未定義または文字列でない場合のテストです。既定のパスが有効になり確認できないため、終了コード 0 で終わり、標準エラーに `WARN` と group 名を出力することを確認します。"""
    with allure.step("file が文字列でない group を足して hook を動かす"):
        _write_nx_json(
            repo,
            {
                "pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md"),
                "pecot-visual": _group("plugins/pecot-visual/CHANGELOG.md"),
                "nofile": _group_changelog(changelog),
            },
        )
        result = run_script(script_dir / SCRIPT, cwd=repo)

    with allure.step("終了コード 0 と、WARN の表示を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert "WARN" in result.stderr
        assert "nofile" in result.stderr


@allure.title("CHANGELOG のパスに補間のトークン（{file_value}）があると、警告を出して確認を飛ばす")
@pytest.mark.parametrize(
    "file_value",
    [
        "{projectRoot}/CHANGELOG.md",
        "{workspaceRoot}/plugins/{projectName}/CHANGELOG.md",
    ],
)
def test_interpolated_changelog_file_warns_and_skips(
    script_dir: Path, repo: Path, run_script, file_value: str
) -> None:
    """`projectRoot` などの nx の補間トークンを含むパスの場合のテストです。パスを解決できないため、失敗にはせず、終了コード 0 で終わり、標準エラーに `WARN` と group 名を出力することを確認します。"""
    with allure.step("補間トークンを含む file の group を足して hook を動かす"):
        _write_nx_json(
            repo,
            {
                "pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md"),
                "pecot-visual": _group("plugins/pecot-visual/CHANGELOG.md"),
                "interp": _group(file_value),
            },
        )
        result = run_script(script_dir / SCRIPT, cwd=repo)

    with allure.step("終了コード 0 と、WARN の表示を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert "WARN" in result.stderr
        assert "interp" in result.stderr


@allure.title("root の projectChangelogs が有効だと、警告を出して確認を飛ばす")
def test_root_project_changelogs_warns_and_skips(script_dir: Path, repo: Path, run_script) -> None:
    """`nx.json` の `release.changelog` で `projectChangelogs` を有効にした場合のテストです。既定のパスを有効にするだけで確認できないため、終了コード 0 で終わり、標準エラーに `projectChangelogs` を出力することを確認します。"""
    with allure.step("projectChangelogs を有効にした nx.json で hook を動かす"):
        (repo / "nx.json").write_text(
            json.dumps(
                {
                    "release": {
                        "groups": {"pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md")},
                        "changelog": {"workspaceChangelog": False, "projectChangelogs": True},
                    }
                },
                ensure_ascii=False,
            )
        )
        result = run_script(script_dir / SCRIPT, cwd=repo)

    with allure.step("終了コード 0 と、WARN の表示を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr
        assert "projectChangelogs" in result.stderr


@allure.title("nx.json が存在しないと、警告を出して成功で終わる")
def test_missing_nx_json_skips(script_dir: Path, git_repo, run_script) -> None:
    """リポジトリに `nx.json` が存在しない場合のテストです。確認を飛ばす設計のため、終了コード 0 で終わり、標準エラーに `WARN` を出力することを確認します。"""
    with allure.step("nx.json の無いリポで hook を動かす"):
        r = git_repo("nonx")
        result = run_script(script_dir / SCRIPT, cwd=r)

    with allure.step("終了コード 0 と、WARN の表示を確かめる"):
        assert result.returncode == 0
        assert "WARN" in result.stderr


@allure.title("nx.json が不正で解析できないと、警告を出して成功で終わる")
def test_broken_nx_json_skips(script_dir: Path, repo: Path, run_script) -> None:
    """`nx.json` の内容が JSON として不正な場合のテストです。確認を飛ばす設計のため、終了コード 0 で終わり、標準エラーに `WARN` を出力することを確認します。"""
    with allure.step("読めない nx.json で hook を動かす"):
        (repo / "nx.json").write_text("{ not json")
        result = run_script(script_dir / SCRIPT, cwd=repo)

    with allure.step("終了コード 0 と、WARN の表示を確かめる"):
        assert result.returncode == 0
        assert "WARN" in result.stderr


@allure.title("release.groups が存在しない nx.json は、確認の対象がなく成功で終わる")
def test_no_release_groups_passes(script_dir: Path, git_repo, run_script) -> None:
    """`nx.json` に `release.groups` が存在しない場合のテストです。確認の対象が 0 件のため、終了コード 0 で終わることを確認します。"""
    with allure.step("release.groups の無い nx.json で hook を動かす"):
        r = git_repo("nogroups")
        (r / "nx.json").write_text(
            json.dumps({"release": {"versionPlans": {"ignorePatternsForPlanCheck": ["README.md"]}}})
        )
        result = run_script(script_dir / SCRIPT, cwd=r)

    with allure.step("終了コード 0 を確かめる"):
        assert result.returncode == 0, result.stdout + result.stderr


def _hook_entry_lines(config_text: str, hook_id: str) -> list[str]:
    """`.pre-commit-config.yaml` から 1 hook エントリのブロックを切り出す。

    テストランナー（run.sh）は pytest / pytest-xdist しか入れない。
    そのため yaml パーサに依存せず、素朴に取り出す。
    範囲は「`- id: <hook_id>` から次の同インデント `- id:` まで」。
    """
    lines = config_text.splitlines()
    start = next(
        (i for i, line in enumerate(lines) if line.strip() == f"- id: {hook_id}"),
        None,
    )
    assert start is not None, f"{hook_id} のエントリが .pre-commit-config.yaml に無い"
    indent = len(lines[start]) - len(lines[start].lstrip())
    block = [lines[start]]
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if stripped.startswith("- id:") and len(line) - len(line.lstrip()) <= indent:
            break
        block.append(line)
    return block


@allure.title("pre-commit の設定は、CHANGELOG を削除したコミットを検知できる形にする")
def test_pre_commit_config_wiring_catches_deletions(script_dir: Path) -> None:
    """`.pre-commit-config.yaml` の `check-release-group-changelog` の設定のテストです。`always_run: true` と `fail_fast: true` があり、`files:` が存在しないことを確認します。"""
    with allure.step("pre-commit の設定から hook のエントリを切り出す"):
        repo_root = script_dir.parents[1]
        block = _hook_entry_lines(
            (repo_root / ".pre-commit-config.yaml").read_text(),
            "check-release-group-changelog",
        )
        stripped = [line.strip() for line in block]

    with allure.step("always_run と fail_fast があり、files が無いことを確かめる"):
        assert "always_run: true" in stripped
        assert "fail_fast: true" in stripped
        assert not [line for line in stripped if line.startswith("files:")]
