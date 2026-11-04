"""cross-repo テスト（test_cross_repo.bats からの移植・FR-014）。

フックがワークスペース内のどのリポジトリでも正しく動作することを検証する。
PROJECT_ROOT とは別パスの cross-repo を作る。
-C フラグ / cd チェイン / pwd フォールバックの各手段で、WIP push と比較 URL 書き込みが正しいリポで行われることを確認する。

GIT_* 隔離・test git repo 生成・mock コマンド配置は conftest の fixture が担保する。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

# モジュールロード時点（mock_bin が PATH を書き換える前）に、実 git の絶対パスを解決する。
# 解決した値は、mock git の REAL_GIT として埋め込む（test_auto_push.py と同じ手法）。
# 解決失敗時は "git" にフォールバックして、モジュールロード（collection）を通す。
# git 不在環境では、テスト実行時に mock git の解決が失敗して、自然に落ちる。
_REAL_GIT = shutil.which("git") or "git"


def _mock_git_body(push_log: Path, push_exit: str = "0") -> str:
    """push を記録しそれ以外は実 git へ exec する mock git の本体（cross-repo 版）。"""
    return f"""#!/bin/bash
REAL_GIT={json.dumps(_REAL_GIT)}
PUSH_LOG={json.dumps(str(push_log))}
PUSH_EXIT={json.dumps(push_exit)}
cmd="$1"
if [ "$1" = "-C" ]; then
    cmd="$3"
fi
if [ "$cmd" = "push" ]; then
    echo "$@" > "$PUSH_LOG"
    exit "$PUSH_EXIT"
fi
exec "$REAL_GIT" "$@"
"""


def _mock_gh_body(default_branch: str = "main") -> str:
    """デフォルトブランチ取得に応答する mock gh の本体（cross-repo 版）。"""
    return f"""#!/bin/bash
if [ "$1" = "api" ]; then
    echo {json.dumps(default_branch)}
    exit 0
fi
exit 1
"""


def _commit_success_json(
    branch: str = "feat/cross-repo-test/999",
    repo_dir: str | None = None,
) -> str:
    """コミット成功 PostToolUse JSON を生成する（bats _commit_success_json 相当）。

    repo_dir を渡すと command に `git -C <repo_dir> commit ...` を埋め込む。
    """
    c_flag = f"-C {repo_dir} " if repo_dir else ""
    return json.dumps(
        {
            "tool_input": {"command": f'git {c_flag}commit -m "feat: cross repo change"'},
            "tool_response": {
                "stdout": (
                    f"[{branch} abc1234] feat: cross repo change\n 1 file changed, 1 insertion(+)"
                ),
                "interrupted": False,
            },
        }
    )


@pytest.fixture
def auto_push_script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "post-tool-use"
        / "auto-push.sh"
    )


@pytest.fixture
def commit_info_script(project_root: Path) -> Path:
    return (
        project_root
        / "plugins"
        / "pecot-workflow"
        / "hooks"
        / "lib"
        / "post-tool-use"
        / "commit-info-display.sh"
    )


@pytest.fixture
def push_log(tmp_path: Path) -> Path:
    return tmp_path / "mock-git-push.log"


@pytest.fixture
def cross_repo_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mock_bin,
    git_repo: Callable[..., Path],
    push_log: Path,
) -> dict:
    """bats setup() 相当: auto-push 有効化・別リポ作成・mock git/gh 配置。

    CLAUDE_PROJECT_DIR/.pecot を用意する。
    auto-push は pecot 管理リポでのみ発火し、pecot_state_dir_ensure が .pecot の存在を要求するため。
    """
    config_path = tmp_path / "hooks-config.json"
    config_path.write_text(json.dumps({"auto-push": True}))
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(config_path))

    project = tmp_path / "project"
    (project / "tmp").mkdir(parents=True)
    (project / ".pecot").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))

    # 別リポジトリ（cross-repo）— PROJECT_ROOT とは異なるパス。
    cross_repo = git_repo("cross-repo")

    mock_bin.install("git", _mock_git_body(push_log))
    mock_bin.install("gh", _mock_gh_body())

    return {
        "config_path": config_path,
        "project": project,
        "cross_repo": cross_repo,
        "push_log": push_log,
        "flag_file": project / ".pecot" / "state" / ".auto-push-urls",
    }


def _checkout(repo: Path, branch: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-b", branch],
        check=True,
        capture_output=True,
    )


def _set_remote(repo: Path, url: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "remote", "add", "origin", url],
        check=True,
        capture_output=True,
    )


# サブスクリプトは stdin の JSON を読まず、PECOT_POST_*（bash-post-match.sh が export）を読む。
# そのため、エントリ post-tool-use-bash.sh と同じ前段を source してから起動する。
# toplevel の解決は無効化し、CLAUDE_PROJECT_DIR はテストが用意した値のままにする。
# 対象リポは、-C / cd / cwd から解決する。
_SOURCE_POST_MATCH = (
    "PECOT_PROJECT_ROOT_LAZY=1; "
    'source "$(dirname "$1")/../core/project-root.sh" "$2" && '
    "pecot_export_project_root() { :; } && "
    'source "$(dirname "$1")/bash-post-match.sh" "$2" && exec bash "$1"'
)


def _run(script: Path, stdin: str, cwd: str | Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", _SOURCE_POST_MATCH, "_", str(script), stdin],
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=25,
    )


# cross-repo 正常系。


def test_push_executed_on_cross_repo_feature_branch(cross_repo_env, auto_push_script):
    repo = cross_repo_env["cross_repo"]
    _checkout(repo, "feat/cross-repo-test/999")

    result = _run(auto_push_script, _commit_success_json(), cwd=repo)
    assert result.returncode == 0
    assert cross_repo_env["push_log"].exists()


def test_wip_branch_name_built_from_cross_repo_branch(cross_repo_env, auto_push_script):
    repo = cross_repo_env["cross_repo"]
    _checkout(repo, "feat/cross-repo-test/999")

    result = _run(auto_push_script, _commit_success_json(), cwd=repo)
    assert result.returncode == 0
    assert "HEAD:refs/heads/wip/feat/cross-repo-test/999" in cross_repo_env["push_log"].read_text()


def test_compare_url_from_ssh_remote(cross_repo_env, auto_push_script):
    repo = cross_repo_env["cross_repo"]
    _checkout(repo, "feat/cross-repo-test/999")
    _set_remote(repo, "git@github.com:otherorg/otherrepo.git")

    result = _run(auto_push_script, _commit_success_json(), cwd=repo)
    assert result.returncode == 0
    assert result.stdout == ""

    flag_file = cross_repo_env["flag_file"]
    assert flag_file.exists()
    assert (
        "github.com/otherorg/otherrepo/compare/main...wip/feat/cross-repo-test/999"
        in flag_file.read_text()
    )


def test_compare_url_from_https_remote(cross_repo_env, auto_push_script):
    repo = cross_repo_env["cross_repo"]
    _checkout(repo, "feat/cross-repo-test/999")
    _set_remote(repo, "https://github.com/otherorg/otherrepo.git")

    result = _run(auto_push_script, _commit_success_json(), cwd=repo)
    assert result.returncode == 0
    assert result.stdout == ""

    flag_file = cross_repo_env["flag_file"]
    assert flag_file.exists()
    assert (
        "github.com/otherorg/otherrepo/compare/main...wip/feat/cross-repo-test/999"
        in flag_file.read_text()
    )


# git -C <path> フラグ経由（cd せずに別リポを操作する場合）。


def test_dash_c_flag_pushes_correct_repo(cross_repo_env, auto_push_script):
    repo = cross_repo_env["cross_repo"]
    _checkout(repo, "feat/cross-repo-test/999")
    _set_remote(repo, "git@github.com:otherorg/otherrepo.git")

    # cd せずに -C フラグでリポを指定（cwd は repo に置かない）。
    result = _run(
        auto_push_script,
        _commit_success_json(repo_dir=str(repo)),
    )
    assert result.returncode == 0
    assert cross_repo_env["push_log"].exists()
    assert "HEAD:refs/heads/wip/feat/cross-repo-test/999" in cross_repo_env["push_log"].read_text()


def test_dash_c_flag_compare_url_written(cross_repo_env, auto_push_script):
    repo = cross_repo_env["cross_repo"]
    _checkout(repo, "feat/cross-repo-test/999")
    _set_remote(repo, "git@github.com:otherorg/otherrepo.git")

    result = _run(auto_push_script, _commit_success_json(repo_dir=str(repo)))
    assert result.returncode == 0
    assert result.stdout == ""

    flag_file = cross_repo_env["flag_file"]
    assert flag_file.exists()
    assert (
        "github.com/otherorg/otherrepo/compare/main...wip/feat/cross-repo-test/999"
        in flag_file.read_text()
    )


def test_dash_c_flag_commit_info_display(cross_repo_env, commit_info_script):
    repo = cross_repo_env["cross_repo"]
    # commit-info-display を有効化。
    cross_repo_env["config_path"].write_text(json.dumps({"commit-info-display": True}))
    _checkout(repo, "feat/cross-repo-test/999")

    result = _run(commit_info_script, _commit_success_json(repo_dir=str(repo)))
    assert result.returncode == 0
    assert "コミット完了" in result.stdout
    # cross-repo のコミットメッセージ（initial commit）が表示される。
    assert "initial commit" in result.stdout


# cd チェインコマンド（cd /path && git commit 等）。


def _cd_chain_json(repo: Path, sep: str) -> str:
    """`cd <repo><sep> git commit ...` 形式の commit 成功 JSON を生成する。"""
    return json.dumps(
        {
            "tool_input": {"command": f'cd {repo}{sep} git commit -m "feat: cd chain test"'},
            "tool_response": {
                "stdout": (
                    "[feat/cross-repo-test/999 abc1234] feat: cd chain test\n"
                    " 1 file changed, 1 insertion(+)"
                ),
                "interrupted": False,
            },
        }
    )


@pytest.mark.parametrize("sep", [" &&", ";"])
def test_cd_chain_pushes(cross_repo_env, auto_push_script, sep):
    repo = cross_repo_env["cross_repo"]
    _checkout(repo, "feat/cross-repo-test/999")
    _set_remote(repo, "git@github.com:otherorg/otherrepo.git")

    result = _run(auto_push_script, _cd_chain_json(repo, sep), cwd=repo)
    assert result.returncode == 0
    assert cross_repo_env["push_log"].exists()
    assert "HEAD:refs/heads/wip/feat/cross-repo-test/999" in cross_repo_env["push_log"].read_text()


def test_pwd_fallback_pushes(cross_repo_env, auto_push_script):
    repo = cross_repo_env["cross_repo"]
    _checkout(repo, "feat/cross-repo-test/999")
    _set_remote(repo, "git@github.com:otherorg/otherrepo.git")

    # -C と cd チェインのどちらも無いコマンド（pwd が cross_repo になる）。
    pwd_json = json.dumps(
        {
            "tool_input": {"command": 'git commit -m "feat: pwd fallback test"'},
            "tool_response": {
                "stdout": (
                    "[feat/cross-repo-test/999 abc1234] feat: pwd fallback test\n"
                    " 1 file changed, 1 insertion(+)"
                ),
                "interrupted": False,
            },
        }
    )

    result = _run(auto_push_script, pwd_json, cwd=repo)
    assert result.returncode == 0
    assert cross_repo_env["push_log"].exists()
    assert "HEAD:refs/heads/wip/feat/cross-repo-test/999" in cross_repo_env["push_log"].read_text()


def test_tool_cwd_pushes(cross_repo_env, auto_push_script, git_repo):
    """hook 入力 JSON の cwd（resolver Priority 3）は pwd より優先される（#1087）。

    env を自前で立てず、実手段と同じく PostToolUse の入力 JSON で cwd を渡す。
    """
    repo = cross_repo_env["cross_repo"]
    _checkout(repo, "feat/cross-repo-test/999")
    _set_remote(repo, "git@github.com:otherorg/otherrepo.git")
    # pwd 側は別リポ・別ブランチ。
    # -C と cd チェインのどちらも無いコマンドで、選ばれたのが入力 JSON の cwd 側であることを、push 先のブランチ名で判別する。
    other = git_repo("pwd-side")
    _checkout(other, "feat/pwd-side/000")
    payload = json.loads(_commit_success_json())
    payload["cwd"] = str(repo)

    result = _run(auto_push_script, json.dumps(payload), cwd=other)
    assert result.returncode == 0
    assert cross_repo_env["push_log"].exists()
    assert "HEAD:refs/heads/wip/feat/cross-repo-test/999" in cross_repo_env["push_log"].read_text()


def test_cd_chain_commit_info_display(cross_repo_env, commit_info_script):
    repo = cross_repo_env["cross_repo"]
    cross_repo_env["config_path"].write_text(json.dumps({"commit-info-display": True}))
    _checkout(repo, "feat/cross-repo-test/999")

    result = _run(commit_info_script, _cd_chain_json(repo, " &&"), cwd=repo)
    assert result.returncode == 0
    assert "コミット完了" in result.stdout
    assert "initial commit" in result.stdout
