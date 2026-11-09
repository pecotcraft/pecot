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


def test_all_groups_satisfied_passes(script_dir: Path, repo: Path, run_script) -> None:
    """正例: 全 group の CHANGELOG が存在・非空・末尾改行なら exit 0。"""
    result = run_script(script_dir / SCRIPT, cwd=repo)
    assert result.returncode == 0, result.stdout + result.stderr


def test_missing_file_fails_with_group_and_seed_hint(
    script_dir: Path, repo: Path, run_script
) -> None:
    """負例: group を追加して CHANGELOG を置かないと exit 1。group 名と seed 手順を出す。"""
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
    assert result.returncode == 1
    assert "pecot-tools" in out
    assert "plugins/pecot-tools/CHANGELOG.md" in out
    assert "printf" in out


def test_empty_file_fails(script_dir: Path, repo: Path, run_script) -> None:
    """負例: 空ファイルは Nx の CREATE 処理と同じ結果になるため exit 1。"""
    _write_changelog(repo, "plugins/pecot-visual/CHANGELOG.md", "")
    result = run_script(script_dir / SCRIPT, cwd=repo)
    out = result.stdout + result.stderr
    assert result.returncode == 1
    assert "pecot-visual" in out
    assert "空" in out


def test_missing_trailing_newline_fails(script_dir: Path, repo: Path, run_script) -> None:
    """負例: 末尾改行がないと end-of-file-fixer が commit を落とすため exit 1。"""
    _write_changelog(repo, "plugins/pecot-workflow/CHANGELOG.md", "# pecot-workflow")
    result = run_script(script_dir / SCRIPT, cwd=repo)
    out = result.stdout + result.stderr
    assert result.returncode == 1
    assert "plugins/pecot-workflow/CHANGELOG.md" in out
    assert "改行" in out


def test_directory_path_fails_with_not_a_file_message(
    script_dir: Path, repo: Path, run_script
) -> None:
    """負例: パスがディレクトリなら「存在しません」ではなく「ファイルではありません」。"""
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
    assert result.returncode == 1
    assert "pecot-tools" in out
    assert "ファイルではありません" in out
    assert "リポジトリルートからの相対パス" in out


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
    """project CHANGELOG を無効化した group は生成物が無いので WARN も出さない。"""
    _write_nx_json(
        repo,
        {
            "pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md"),
            "pecot-visual": _group("plugins/pecot-visual/CHANGELOG.md"),
            "nofile": _group_changelog(changelog),
        },
    )
    result = run_script(script_dir / SCRIPT, cwd=repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "nofile" not in result.stderr


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
    """既定パスが有効な（= 文字列でない）group は確認できないので WARN + exit 0。"""
    _write_nx_json(
        repo,
        {
            "pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md"),
            "pecot-visual": _group("plugins/pecot-visual/CHANGELOG.md"),
            "nofile": _group_changelog(changelog),
        },
    )
    result = run_script(script_dir / SCRIPT, cwd=repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "WARN" in result.stderr
    assert "nofile" in result.stderr


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
    """nx の補間トークンを含むパスは解決しないので exit 1 にせず WARN + exit 0。"""
    _write_nx_json(
        repo,
        {
            "pecot-workflow": _group("plugins/pecot-workflow/CHANGELOG.md"),
            "pecot-visual": _group("plugins/pecot-visual/CHANGELOG.md"),
            "interp": _group(file_value),
        },
    )
    result = run_script(script_dir / SCRIPT, cwd=repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "WARN" in result.stderr
    assert "interp" in result.stderr


def test_root_project_changelogs_warns_and_skips(script_dir: Path, repo: Path, run_script) -> None:
    """root の projectChangelogs は既定パスを有効化するだけなので WARN + exit 0。"""
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
    assert result.returncode == 0, result.stdout + result.stderr
    assert "projectChangelogs" in result.stderr


def test_missing_nx_json_skips(script_dir: Path, git_repo, run_script) -> None:
    """fail-open: nx.json 不在は WARN + exit 0。"""
    r = git_repo("nonx")
    result = run_script(script_dir / SCRIPT, cwd=r)
    assert result.returncode == 0
    assert "WARN" in result.stderr


def test_broken_nx_json_skips(script_dir: Path, repo: Path, run_script) -> None:
    """fail-open: nx.json が不正で解析できない場合も WARN + exit 0。"""
    (repo / "nx.json").write_text("{ not json")
    result = run_script(script_dir / SCRIPT, cwd=repo)
    assert result.returncode == 0
    assert "WARN" in result.stderr


def test_no_release_groups_passes(script_dir: Path, git_repo, run_script) -> None:
    """release.groups が無い nx.json は検証対象ゼロで exit 0。"""
    r = git_repo("nogroups")
    (r / "nx.json").write_text(
        json.dumps({"release": {"versionPlans": {"ignorePatternsForPlanCheck": ["README.md"]}}})
    )
    result = run_script(script_dir / SCRIPT, cwd=r)
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


def test_pre_commit_config_wiring_catches_deletions(script_dir: Path) -> None:
    """CHANGELOG 削除 commit の検知は `always_run: true` + `files:` 無しに依存する。

    `files:` を付けると、CHANGELOG に触れない commit で hook 自体が起動しない。
    その場合は削除 commit をすり抜ける。
    `fail_fast: true` は後続の nx affected lint（数分）を実行させないための配線。
    いずれもスクリプト単体テストでは守れない。
    """
    repo_root = script_dir.parents[1]
    block = _hook_entry_lines(
        (repo_root / ".pre-commit-config.yaml").read_text(),
        "check-release-group-changelog",
    )
    stripped = [line.strip() for line in block]
    assert "always_run: true" in stripped
    assert "fail_fast: true" in stripped
    assert not [line for line in stripped if line.startswith("files:")]
