"""bash-post-match.sh（PostToolUse(Bash) の一致判定）のテスト（#1229 T056）。

成功した `git commit` を PECOT_POST_COMMIT で判定して export する。
一致したときだけ、project-root と対象リポジトリ（PECOT_POST_REPO_DIR）を解決する。
tool の出力（stdout）は export しない。
環境変数 1 個が 128KiB を超えると、execve が失敗するため。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

_SOURCE_AND_DUMP = (
    "PECOT_PROJECT_ROOT_LAZY=1; "
    'source "$1/core/project-root.sh" "$2" && source "$1/post-tool-use/bash-post-match.sh" "$2" && '
    'printf "%s\\0%s\\0%s\\0%s\\0" "$PECOT_POST_COMMIT" "$PECOT_POST_MATCHED" "$PECOT_POST_REPO_DIR" "${CLAUDE_PROJECT_DIR:-}" && '
    "env | grep -c '^PECOT_POST_STDOUT' || true"
)

COMMIT_OUT = "[feat/x abc1234] msg\n 1 file changed, 1 insertion(+)"


def _payload(
    command: str, stdout: str, *, client: str = "claude", cwd: Path | None = None, **extra
):
    base: dict = {
        "hook_event_name": "PostToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": command},
        **extra,
    }
    if cwd is not None:
        base["cwd"] = str(cwd)
    if client == "claude":
        base["tool_response"] = {"stdout": stdout, "interrupted": extra.get("interrupted", False)}
        base.pop("interrupted", None)
    else:
        base["tool_result"] = {
            "result_type": "success",
            "text_result_for_llm": f"{stdout}\n<shellId: 0 completed with exit code 0>",
        }
    return json.dumps(base)


@pytest.fixture
def lib_dir(hooks_dir: Path) -> Path:
    return hooks_dir / "lib"


@pytest.fixture
def repo(git_repo: Callable[..., Path]) -> Path:
    return git_repo("post-match")


def _match(lib_dir: Path, payload: str, cwd: Path) -> tuple[str, str, str, str]:
    out = subprocess.run(
        ["bash", "-c", _SOURCE_AND_DUMP, "_", str(lib_dir), payload],
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=25,
    )
    assert out.returncode == 0, out.stderr
    commit, matched, repo_dir, project, rest = out.stdout.split("\0", 4)
    # 判定結果を "commit" / "" にまとめる（MATCHED は COMMIT と一致する）。
    kind = "commit" if commit == "1" else ""
    assert matched == ("1" if kind else "")
    return kind, repo_dir, project, rest.strip()


@pytest.mark.parametrize("client", ["claude", "copilot"])
def test_successful_commit_is_matched_and_resolved(lib_dir, repo, client) -> None:
    kind, repo_dir, project, leaked = _match(
        lib_dir, _payload("git commit -m x", COMMIT_OUT, client=client, cwd=repo), repo
    )
    assert kind == "commit"
    assert repo_dir == str(repo)
    assert project == str(repo)
    assert leaked == "0"


@pytest.mark.parametrize(
    "command",
    [
        "git\tcommit -m x",
        "git  commit -m x",
        "echo a;  git\tcommit -m x",
        "echo a &&\tgit  commit -m x",
    ],
)
def test_tab_and_multiple_space_separators_match_commit(lib_dir, repo, command) -> None:
    kind, repo_dir, _, _ = _match(lib_dir, _payload(command, COMMIT_OUT, cwd=repo), repo)
    assert kind == "commit"
    assert repo_dir == str(repo)


def test_tab_separated_git_dash_c_commit_resolves_target_repo(lib_dir, repo, tmp_path) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    kind, repo_dir, _, _ = _match(
        lib_dir,
        _payload(f"git\t-C\t{repo}  commit -m x", COMMIT_OUT, cwd=elsewhere),
        elsewhere,
    )
    assert kind == "commit"
    assert repo_dir == str(repo)


def test_git_dash_c_commit_resolves_target_repo(lib_dir, repo, tmp_path) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    kind, repo_dir, _, _ = _match(
        lib_dir,
        _payload(f"git -C {repo} commit -m x", COMMIT_OUT, cwd=elsewhere),
        elsewhere,
    )
    assert kind == "commit"
    assert repo_dir == str(repo)


def test_concatenated_command_matches_only_the_succeeded_part(lib_dir, repo) -> None:
    kind, repo_dir, _, _ = _match(
        lib_dir,
        _payload("git commit -m x && pecot issue create x.md", COMMIT_OUT, cwd=repo),
        repo,
    )
    assert kind == "commit"
    assert repo_dir == str(repo)


@pytest.mark.parametrize(
    ("command", "stdout"),
    [
        ("ls", "f.txt"),
        ("git status", "On branch main"),
        ("git commit -m x", "nothing to commit"),  # 成功出力（[branch sha]）が無い
        ("pecot issue create x.md", "Created: #12"),  # issue 起票は CLI が処理し、hook は見ない
        ("echo 'git commit'", "git commit"),  # コマンド先頭でない
    ],
)
def test_non_matching_commands_leave_kind_empty_and_skip_resolution(
    lib_dir, repo, command, stdout
) -> None:
    kind, repo_dir, project, _ = _match(lib_dir, _payload(command, stdout, cwd=repo), repo)
    assert kind == ""
    assert repo_dir == ""
    # 一致しなければ project-root は解決しない（CLAUDE_PROJECT_DIR は呼び出し元の値のまま）。
    assert project != str(repo)


def test_interrupted_commit_is_not_matched(lib_dir, repo) -> None:
    payload = json.dumps(
        {
            "tool_input": {"command": "git commit -m x"},
            "tool_response": {"stdout": COMMIT_OUT, "interrupted": True},
            "cwd": str(repo),
        }
    )
    kind, _, _, _ = _match(lib_dir, payload, repo)
    assert kind == ""


def test_sourcing_does_not_clobber_caller_positional_parameters(lib_dir, repo) -> None:
    script = (
        "PECOT_PROJECT_ROOT_LAZY=1; "
        'source "$1/core/project-root.sh" "$2" && source "$1/post-tool-use/bash-post-match.sh" "$2" && '
        'printf "%s|%s" "$1" "$#"'
    )
    out = subprocess.run(
        [
            "bash",
            "-c",
            script,
            "_",
            str(lib_dir),
            _payload("git commit -m x", COMMIT_OUT, cwd=repo),
        ],
        capture_output=True,
        text=True,
        cwd=repo,
        timeout=25,
    )
    assert out.stdout == f"{lib_dir}|2"
