"""auto-push.sh / stop/auto-push.sh のテスト（test_auto_push.bats からの移植）。

コミット成功後の WIP ブランチへの自動 push 動作と、Stop hook での URL 表示を検証する。
GIT_* 隔離・test git repo 生成・mock コマンド配置は conftest の fixture を消費する。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

# モジュールロード時点（mock_bin fixture が PATH を書き換える前）に実 git の
# 絶対パスを解決し、mock git の REAL_GIT として埋め込む。bats 版の
# `which -a git | grep -v "$0"` は hermetic/xdist 下で不安定なため使わない。
# 解決失敗時は "git" にフォールバックしてモジュールロード（collection）を通す。
# git 不在環境では、テスト実行時に mock git の解決が失敗して、自然に落ちる。
_REAL_GIT = shutil.which("git") or "git"


def _commit_success_json(branch: str = "feat/add-auth/1443") -> str:
    """コミット成功 PostToolUse JSON を生成する（bats _commit_success_json 相当）。"""
    return json.dumps(
        {
            "tool_input": {"command": 'git commit -m "feat: add auth"'},
            "tool_response": {
                "stdout": (f"[{branch} abc1234] feat: add auth\n 1 file changed, 1 insertion(+)"),
                "interrupted": False,
            },
        }
    )


def _mock_git_body(push_log: Path, push_exit: str = "0", push_stderr: str = "") -> str:
    """push を記録しそれ以外は実 git へ exec する mock git の本体。

    REAL_GIT はモジュールロード時に解決した絶対パスを埋め込む。
    push_stderr が非空なら push 時に stderr へ出力する（push 失敗系で使用）。
    """
    stderr_line = f"    echo {json.dumps(push_stderr)} >&2\n" if push_stderr else ""
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
    for arg in "$@"; do
        case "$arg" in
            HEAD:refs/heads/*)
                dst="${{arg#HEAD:refs/heads/}}"
                if [ "$1" = "-C" ]; then
                    "$REAL_GIT" -C "$2" update-ref "refs/remotes/origin/$dst" HEAD
                else
                    "$REAL_GIT" update-ref "refs/remotes/origin/$dst" HEAD
                fi ;;
        esac
    done
{stderr_line}    exit "$PUSH_EXIT"
fi
exec "$REAL_GIT" "$@"
"""


def _mock_gh_body(
    graphql_log: Path,
    graphql_exit: str = "0",
    default_branch: str = "main",
    mutation_response: str = "",
) -> str:
    """デフォルトブランチ取得 + GraphQL（query/mutation）に応答する mock gh の本体。

    graphql_log にコマンドを追記し、呼び出し回数カウンタ（<log>.count）で
    1 回目（query 結果）/ 2 回目（mutation 結果）を出し分ける。bats 版と同一挙動。
    """
    mutation_default = json.dumps(
        '{"data":{"createLinkedBranch":{"linkedBranch":{"id":"LB_789"}}}}'
    )
    mutation_override = json.dumps(mutation_response) if mutation_response else ""
    mutation_line = (
        f"        echo {mutation_override}\n"
        if mutation_override
        else f"        echo {mutation_default}\n"
    )
    return f"""#!/bin/bash
GRAPHQL_LOG={json.dumps(str(graphql_log))}
GRAPHQL_EXIT={json.dumps(graphql_exit)}
DEFAULT_BRANCH={json.dumps(default_branch)}
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
    echo "$@" >> "$GRAPHQL_LOG"
    if [ "$GRAPHQL_EXIT" != "0" ]; then
        exit "$GRAPHQL_EXIT"
    fi
    COUNTER_FILE="${{GRAPHQL_LOG}}.count"
    if [ ! -f "$COUNTER_FILE" ]; then
        echo "1" > "$COUNTER_FILE"
    else
        count=$(cat "$COUNTER_FILE")
        echo $((count + 1)) > "$COUNTER_FILE"
    fi
    count=$(cat "$COUNTER_FILE")
    if [ "$count" -eq 1 ]; then
        echo "I_issue123 R_repo456 abc123def456abc123def456abc123def456abc1"
    else
{mutation_line}    fi
    exit 0
fi
if [ "$1" = "api" ]; then
    echo "$DEFAULT_BRANCH"
    exit 0
fi
exit 1
"""


_DEFAULT_ORIGIN = "git@ghes.example.com:testowner/testrepo.git"


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
def stop_script(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "lib" / "stop" / "auto-push.sh"


@pytest.fixture
def push_log(tmp_path: Path) -> Path:
    return tmp_path / "mock-git-push.log"


@pytest.fixture
def graphql_log(tmp_path: Path) -> Path:
    return tmp_path / "mock-gh-graphql.log"


@pytest.fixture
def env_setup(
    claude_project_dir: Path,
    hooks_config,
    mock_bin,
    git_repo: Callable[..., Path],
    push_log: Path,
    graphql_log: Path,
) -> dict:
    """auto-push 正常系の共通セットアップ。

    auto-push を有効化し、push/gh の標準モックを配置し、テスト用リポを作って返す。
    claude_project_dir/.pecot は conftest が作成済み。
    """
    hooks_config.write({"auto-push": True})
    mock_bin.install("git", _mock_git_body(push_log))
    mock_bin.install("gh", _mock_gh_body(graphql_log))
    repo = git_repo()
    subprocess.run(
        ["git", "-C", str(repo), "remote", "add", "origin", _DEFAULT_ORIGIN],
        check=True,
        capture_output=True,
    )
    state_dir = claude_project_dir / ".pecot" / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / ".pecot-active").write_text("testowner/testrepo/1443\n")
    return {
        "project": claude_project_dir,
        "repo": repo,
        "mock_bin": mock_bin,
        "push_log": push_log,
        "graphql_log": graphql_log,
        "state_dir": claude_project_dir / ".pecot" / "state",
    }


def _checkout(repo: Path, branch: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "checkout", "-b", branch],
        check=True,
        capture_output=True,
    )


def _set_remote(repo: Path, url: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "remote", "set-url", "origin", url],
        check=True,
        capture_output=True,
    )


def _run_auto_push(
    run_post_script, script: Path, repo: Path, stdin: str
) -> subprocess.CompletedProcess:
    """auto-push.sh を repo を cwd（pwd 解決）にして、エントリと同じ前段（bash-post-match.sh）付きで実行する。"""
    return run_post_script(script, stdin, cwd=repo)


class _FlagFile:
    """auto-push フラグファイル（.pecot/state/.auto-push-urls）の path 保持 + 書き込みヘルパ。

    Stop hook 系テストが共通で使う「parent.mkdir → write_text」を 1 メソッドに集約する。
    write() を呼ばなければファイルは未作成のまま（不存在ケースのテストで使える）。
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def write(self, content: str) -> Path:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(content)
        return self.path

    def exists(self) -> bool:
        return self.path.exists()


@pytest.fixture
def auto_push_flag_file(claude_project_dir: Path) -> _FlagFile:
    """Stop hook が読む .pecot/state/.auto-push-urls を扱う _FlagFile を返す。"""
    return _FlagFile(claude_project_dir / ".pecot" / "state" / ".auto-push-urls")


# 正常系。


def test_push_executed_on_commit_success(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert env_setup["push_log"].exists()


def test_wip_branch_name_is_correct(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert "HEAD:refs/heads/wip/feat/add-auth/1443" in env_setup["push_log"].read_text()


def test_push_includes_no_verify_force_flags(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert "--no-verify --force" in env_setup["push_log"].read_text()


def test_compare_url_written_on_push_success_ssh(env_setup, run_post_script, auto_push_script):
    """push 成功時: stdout は空（additionalContext 廃止）でフラグファイルにのみ URL を書く。

    旧 test_no_stdout_on_push_success は、本テストへ統合済み。
    auto-push は成功時に stdout へ何も出さない（hook の additionalContext 出力を廃止した）。
    compare URL は、state のフラグファイル経由で Stop hook に引き渡す。
    この契約を、ここで一括検証する。
    """
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/testrepo.git")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    # stdout 出力なし = additionalContext 廃止（成功時はフラグファイルへの書き込みのみ）。
    assert result.stdout == "", (
        "push 成功時に stdout へ出力してはならない（additionalContext 廃止）"
    )

    flag_file = env_setup["state_dir"] / ".auto-push-urls"
    assert flag_file.exists()
    assert (
        "ghes.example.com/testowner/testrepo/compare/main...wip/feat/add-auth/1443"
        in flag_file.read_text()
    )


def test_compare_url_written_for_https_remote(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "https://github.com/testowner/testrepo.git")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert result.stdout == ""

    flag_file = env_setup["state_dir"] / ".auto-push-urls"
    assert flag_file.exists()
    assert (
        "github.com/testowner/testrepo/compare/main...wip/feat/add-auth/1443"
        in flag_file.read_text()
    )


# 非 feature ブランチでスキップ。


@pytest.mark.parametrize(
    "branch",
    ["wt1", "develop-aist", "main"],
)
def test_push_skipped_on_non_feature_branch(env_setup, run_post_script, auto_push_script, branch):
    _checkout(env_setup["repo"], branch)

    result = _run_auto_push(
        run_post_script,
        auto_push_script,
        env_setup["repo"],
        _commit_success_json(branch),
    )

    assert result.returncode == 0
    assert not env_setup["push_log"].exists()


# エラー系。


def test_error_message_on_push_failure(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    # push 失敗を返す mock git に差し替え（stderr にエラー出力）。
    env_setup["mock_bin"].install(
        "git",
        _mock_git_body(
            push_log=env_setup["push_log"],
            push_exit="1",
            push_stderr="fatal: could not read from remote repository",
        ),
    )

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert "auto-push failed" in result.stdout


# hooks-config.json 制御。


def test_disabled_via_hooks_config(env_setup, run_post_script, auto_push_script, hooks_config):
    hooks_config.write({"auto-push": False})
    _checkout(env_setup["repo"], "feat/add-auth/1443")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert result.stdout == ""
    assert not env_setup["push_log"].exists()


# 非 commit コマンド。


def test_non_commit_command_no_output(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    non_commit_json = json.dumps(
        {
            "tool_input": {"command": "git status"},
            "tool_response": {
                "stdout": "On branch feat/add-auth/1443",
                "interrupted": False,
            },
        }
    )

    result = _run_auto_push(run_post_script, auto_push_script, env_setup["repo"], non_commit_json)

    assert result.returncode == 0
    assert result.stdout == ""
    assert not env_setup["push_log"].exists()


# フラグファイル書き込み。


def test_flag_file_url_content(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/testrepo.git")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0

    flag_file = env_setup["state_dir"] / ".auto-push-urls"
    assert flag_file.exists()
    content = flag_file.read_text()
    assert "auto-push complete: wip/feat/add-auth/1443" in content
    assert (
        "  compare: https://ghes.example.com/testowner/testrepo/compare/main...wip/feat/add-auth/1443"
        in content
    )


def test_flag_file_appended_on_multiple_commits(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/testrepo.git")

    _run_auto_push(run_post_script, auto_push_script, env_setup["repo"], _commit_success_json())
    _run_auto_push(run_post_script, auto_push_script, env_setup["repo"], _commit_success_json())

    flag_file = env_setup["state_dir"] / ".auto-push-urls"
    assert flag_file.exists()
    # 2 エントリ分の「auto-push complete」が含まれる。
    assert flag_file.read_text().count("auto-push complete") == 2


# Stop hook: auto-push URL 表示。


def test_stop_outputs_system_message(auto_push_flag_file, run_script, stop_script):
    auto_push_flag_file.write(
        "note: auto-push complete: wip/feat/test/123\n"
        "  compare: https://ghes.example.com/owner/repo/compare/main...wip/feat/test/123\n"
        "\n"
    )

    result = run_script(stop_script, stdin="")

    assert result.returncode == 0
    assert '"systemMessage"' in result.stdout
    assert "auto-push complete: wip/feat/test/123" in result.stdout
    assert "https://ghes.example.com/owner/repo/compare/main...wip/feat/test/123" in result.stdout


def test_stop_removes_flag_file_after_display(auto_push_flag_file, run_script, stop_script):
    auto_push_flag_file.write(
        "note: auto-push complete: wip/feat/test/123\n  compare: https://example.com\n\n"
    )

    result = run_script(stop_script, stdin="")

    assert result.returncode == 0
    assert not auto_push_flag_file.exists()


def test_stop_no_output_without_flag_file(auto_push_flag_file, run_script, stop_script):
    # フラグファイルが存在しないことを保証（write() を呼ばないので未作成）。
    assert not auto_push_flag_file.exists()

    result = run_script(stop_script, stdin="")

    assert result.returncode == 0
    assert result.stdout == ""


def test_stop_includes_all_accumulated_urls(auto_push_flag_file, run_script, stop_script):
    auto_push_flag_file.write(
        "note: auto-push complete: wip/feat/a/1\n"
        "  compare: https://ghes.example.com/o/r/compare/main...wip/feat/a/1\n"
        "\n"
        "note: auto-push complete: wip/feat/b/2\n"
        "  compare: https://ghes.example.com/o/r/compare/main...wip/feat/b/2\n"
        "\n"
    )

    result = run_script(stop_script, stdin="")

    assert result.returncode == 0
    assert "wip/feat/a/1" in result.stdout
    assert "wip/feat/b/2" in result.stdout


# WIP ブランチ → Issue リンク。


def test_wip_branch_linked_to_issue(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/testrepo.git")

    state_dir = env_setup["state_dir"]
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / ".pecot-active").write_text("testowner/testrepo/1443\n")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0

    # GraphQL が 2 回呼ばれていること（query + mutation）。
    graphql_log = env_setup["graphql_log"]
    assert graphql_log.exists()
    graphql_calls = [line for line in graphql_log.read_text().splitlines() if "graphql" in line]
    assert len(graphql_calls) == 2

    # .wip-branch-linked に WIP ブランチ名が記録されていること
    linked_file = state_dir / ".wip-branch-linked"
    assert linked_file.exists()
    assert linked_file.read_text() == "wip/feat/add-auth/1443"


def test_link_api_not_called_on_second_push(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/testrepo.git")

    state_dir = env_setup["state_dir"]
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / ".pecot-active").write_text("testowner/testrepo/1443\n")
    # 同一ブランチ名を事前記録。
    (state_dir / ".wip-branch-linked").write_text("wip/feat/add-auth/1443")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    # GraphQL ログが存在しないこと（API 呼び出しなし）。
    assert not env_setup["graphql_log"].exists()
    # push は実行されること
    assert env_setup["push_log"].exists()


def test_push_skipped_without_pecot_active(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    (env_setup["state_dir"] / ".pecot-active").unlink()

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert result.stdout == ""
    assert not env_setup["push_log"].exists()
    assert not env_setup["graphql_log"].exists()


def test_push_success_even_if_link_api_fails(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/testrepo.git")

    state_dir = env_setup["state_dir"]
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / ".pecot-active").write_text("testowner/testrepo/1443\n")
    # GraphQL API を失敗させる（終了コード非 0）。
    env_setup["mock_bin"].install("gh", _mock_gh_body(env_setup["graphql_log"], graphql_exit="1"))

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    # push 自体は成功していること（フラグファイルが存在）。
    flag_file = state_dir / ".auto-push-urls"
    assert flag_file.exists()
    # .wip-branch-linked は書かれていないこと（次回リトライ可能）。
    assert not (state_dir / ".wip-branch-linked").exists()


def test_flag_written_when_mutation_linkedbranch_null(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/testrepo.git")

    state_dir = env_setup["state_dir"]
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / ".pecot-active").write_text("testowner/testrepo/1443\n")
    # mutation がエラーなしだが linkedBranch=null（既にリンク済みの場合）。
    env_setup["mock_bin"].install(
        "gh",
        _mock_gh_body(
            env_setup["graphql_log"],
            mutation_response='{"data":{"createLinkedBranch":{"linkedBranch":null}}}',
        ),
    )

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert env_setup["push_log"].exists()
    # .wip-branch-linked が書かれていること（エラーなし = 成功扱い）。
    linked_file = state_dir / ".wip-branch-linked"
    assert linked_file.exists()
    assert linked_file.read_text() == "wip/feat/add-auth/1443"


def test_flag_not_written_on_mutation_graphql_error(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/testrepo.git")

    state_dir = env_setup["state_dir"]
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / ".pecot-active").write_text("testowner/testrepo/1443\n")
    # mutation が GraphQL エラーを返す（終了コード 0 だが errors あり）。
    env_setup["mock_bin"].install(
        "gh",
        _mock_gh_body(
            env_setup["graphql_log"],
            mutation_response='{"data":{"createLinkedBranch":null},"errors":[{"message":"Something went wrong"}]}',
        ),
    )

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert env_setup["push_log"].exists()
    # .wip-branch-linked が書かれていないこと（次回リトライ可能）。
    assert not (state_dir / ".wip-branch-linked").exists()


def test_flag_written_on_already_exists_error(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/testrepo.git")

    state_dir = env_setup["state_dir"]
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / ".pecot-active").write_text("testowner/testrepo/1443\n")
    # mutation が "already exists" エラーを返す。
    env_setup["mock_bin"].install(
        "gh",
        _mock_gh_body(
            env_setup["graphql_log"],
            mutation_response='{"data":{"createLinkedBranch":null},"errors":[{"message":"A branch with the name already exists"}]}',
        ),
    )

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert env_setup["push_log"].exists()
    # .wip-branch-linked が書かれていること（リトライ不要）。
    linked_file = state_dir / ".wip-branch-linked"
    assert linked_file.exists()
    assert linked_file.read_text() == "wip/feat/add-auth/1443"


def test_push_skipped_when_pecot_active_empty(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    (env_setup["state_dir"] / ".pecot-active").write_text("")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert result.stdout == ""
    assert not env_setup["push_log"].exists()
    assert not env_setup["graphql_log"].exists()


def test_push_skipped_when_pecot_active_malformed(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    (env_setup["state_dir"] / ".pecot-active").write_text("testowner/testrepo\n")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert not env_setup["push_log"].exists()


# active な Issue のブランチだけ対象にする。


def test_push_skipped_on_other_issue_number(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/999")

    result = _run_auto_push(
        run_post_script,
        auto_push_script,
        env_setup["repo"],
        _commit_success_json("feat/add-auth/999"),
    )

    assert result.returncode == 0
    assert not env_setup["push_log"].exists()
    assert not env_setup["graphql_log"].exists()


def test_push_skipped_on_other_repo(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], "git@ghes.example.com:testowner/otherrepo.git")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert not env_setup["push_log"].exists()
    assert not env_setup["graphql_log"].exists()


@pytest.mark.parametrize(
    ("url", "host"),
    [
        ("ssh://git@ghes.example.com:2222/testowner/testrepo.git", "ghes.example.com"),
        ("ssh://ghes.example.com/testowner/testrepo.git/", "ghes.example.com"),
        ("https://user:token@ghes.example.com/testowner/testrepo.git", "ghes.example.com"),
        ("https://ghes.example.com/testowner/testrepo/", "ghes.example.com"),
        ("git@ghes.example.com:TestOwner/TestRepo.git", "ghes.example.com"),
    ],
)
def test_push_for_url_forms_and_case(env_setup, run_post_script, auto_push_script, url, host):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    _set_remote(env_setup["repo"], url)

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert env_setup["push_log"].exists()
    flag = (env_setup["state_dir"] / ".auto-push-urls").read_text()
    assert f"https://{host}/" in flag
    assert "token" not in flag


# 追跡 ref の削除と除外の refspec。


def _list_refs(repo: Path, prefix: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), "for-each-ref", prefix],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def _fetch_refspecs(repo: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(repo), "config", "--get-all", "remote.origin.fetch"],
        capture_output=True,
        text=True,
    )
    return result.stdout.splitlines()


def test_tracking_ref_removed_after_push(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert _list_refs(env_setup["repo"], "refs/remotes/origin/wip/") == ""


def test_tracking_ref_removed_even_if_push_fails(env_setup, run_post_script, auto_push_script):
    _checkout(env_setup["repo"], "feat/add-auth/1443")
    subprocess.run(
        [
            "git",
            "-C",
            str(env_setup["repo"]),
            "update-ref",
            "refs/remotes/origin/wip/old/1",
            "HEAD",
        ],
        check=True,
    )
    env_setup["mock_bin"].install(
        "git", _mock_git_body(env_setup["push_log"], push_exit="1", push_stderr="fatal: x")
    )

    result = _run_auto_push(
        run_post_script, auto_push_script, env_setup["repo"], _commit_success_json()
    )

    assert result.returncode == 0
    assert "auto-push failed" in result.stdout
    assert _list_refs(env_setup["repo"], "refs/remotes/origin/wip/") == ""


def test_exclude_refspec_added_once(env_setup, run_post_script, auto_push_script):
    repo = env_setup["repo"]
    _checkout(repo, "feat/add-auth/1443")
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/origin/*",
        ],
        check=True,
    )

    for _ in range(2):
        result = _run_auto_push(run_post_script, auto_push_script, repo, _commit_success_json())
        assert result.returncode == 0

    specs = _fetch_refspecs(repo)
    assert specs.count("^refs/heads/wip/*") == 1
    assert "+refs/heads/*:refs/remotes/origin/*" in specs


def test_exclude_refspec_not_added_without_positive_refspec(
    env_setup, run_post_script, auto_push_script
):
    repo = env_setup["repo"]
    _checkout(repo, "feat/add-auth/1443")
    subprocess.run(
        ["git", "-C", str(repo), "config", "--unset-all", "remote.origin.fetch"], check=True
    )

    result = _run_auto_push(run_post_script, auto_push_script, repo, _commit_success_json())

    assert result.returncode == 0
    assert "^refs/heads/wip/*" not in _fetch_refspecs(repo)


def test_real_push_leaves_no_tracking_ref(env_setup, run_post_script, auto_push_script, tmp_path):
    """mock git を使わず、pushInsteadOf で bare に向けた実 push で追跡 ref の有無を確かめる。"""
    repo = env_setup["repo"]
    bare = tmp_path / "bare.git"
    subprocess.run(["git", "init", "--bare", "--quiet", str(bare)], check=True)
    for args in (
        ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        ["config", f"url.{bare}.pushInsteadOf", _DEFAULT_ORIGIN],
    ):
        subprocess.run(["git", "-C", str(repo), *args], check=True)
    _checkout(repo, "feat/add-auth/1443")
    env_setup["mock_bin"].install("git", f'#!/bin/bash\nexec {json.dumps(_REAL_GIT)} "$@"\n')

    result = _run_auto_push(run_post_script, auto_push_script, repo, _commit_success_json())

    assert result.returncode == 0
    remote_refs = subprocess.run(
        ["git", "-C", str(bare), "for-each-ref", "refs/heads/wip/"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert "refs/heads/wip/feat/add-auth/1443" in remote_refs
    assert _list_refs(repo, "refs/remotes/origin/wip/") == ""
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            f"url.{bare}.insteadOf={_DEFAULT_ORIGIN}",
            "fetch",
            "origin",
        ],
        check=True,
        capture_output=True,
    )
    assert _list_refs(repo, "refs/remotes/origin/wip/") == ""
