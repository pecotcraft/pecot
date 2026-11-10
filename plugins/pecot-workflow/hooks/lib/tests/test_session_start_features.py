"""session-start ロジックスクリプト 2 本のユニットテスト
（test_session_start_features.bats 移植）。

対象は、git-sync.sh / vscode-workspace-detector.sh。
git / uvx / code を stub 化して PATH 先頭に置き、出力を検証する。
git-sync / vscode-workspace-detector の基準ディレクトリは、CLAUDE_PROJECT_DIR（エントリポイントの project-root.sh が揃える）。
git は `git -C <基準>` で呼ぶ。
git stub は、-C の値が FAKE_REPO_ROOT と異なれば exit 99 で落とす。
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

_GIT_SYNC_STUB = """#!/bin/bash
if [ "$1" = "-C" ]; then
    [ "$2" = "$FAKE_REPO_ROOT" ] || exit 99
    shift 2
fi
case "$*" in
    "diff --quiet") exit "$FAKE_GIT_DIFF_EXIT" ;;
    "diff --staged --quiet") exit "$FAKE_GIT_STAGED_EXIT" ;;
    "branch --show-current") echo "$FAKE_BRANCH" ;;
    pull) exit "$FAKE_GIT_PULL_EXIT" ;;
    *) exit 0 ;;
esac
"""


@pytest.fixture
def ss_script_dir(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "lib" / "session-start"


def _make_stub(stub_dir: Path, name: str, body: str) -> None:
    path = stub_dir / name
    path.write_text(body)
    path.chmod(0o755)


def _run_with_path(
    script: Path, stub_dir: Path, extra_env: dict[str, str]
) -> subprocess.CompletedProcess:
    env = {**os.environ, **extra_env, "PATH": f"{stub_dir}:{os.environ.get('PATH', '')}"}
    # CLAUDE_PROJECT_DIR は extra_env で明示したときだけ渡す（外部環境の値を持ち込まない）。
    if "CLAUDE_PROJECT_DIR" not in extra_env:
        env.pop("CLAUDE_PROJECT_DIR", None)
    return subprocess.run(
        [str(script)],
        capture_output=True,
        text=True,
        timeout=25,
        env=env,
    )


# git-sync


def _git_sync_env(tmp_path: Path, **overrides: str) -> dict[str, str]:
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)
    base = {
        "CLAUDE_PROJECT_DIR": str(repo_root),
        "FAKE_REPO_ROOT": str(repo_root),
        "FAKE_GIT_DIFF_EXIT": "0",
        "FAKE_GIT_STAGED_EXIT": "0",
        "FAKE_BRANCH": "main",
        "FAKE_GIT_PULL_EXIT": "0",
    }
    base.update(overrides)
    return base


def test_git_sync_clean_pull_success(ss_script_dir, tmp_path) -> None:
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    _make_stub(stub_dir, "git", _GIT_SYNC_STUB)
    _make_stub(stub_dir, "uvx", "#!/bin/bash\nexit 0\n")
    env = _git_sync_env(tmp_path, FAKE_BRANCH="feature/test")

    result = _run_with_path(ss_script_dir / "git-sync.sh", stub_dir, env)
    assert result.returncode == 0
    assert "note: synced the branch with the remote" in result.stdout
    assert "synced the branch with the remote" in result.stdout
    assert "feature/test" in result.stdout


_GIT_SYNC_ENV_STUB = """#!/bin/bash
if [ "$1" = "-C" ]; then
    shift 2
fi
case "$*" in
    "diff --quiet" | "diff --staged --quiet") exit 0 ;;
    "branch --show-current") echo main ;;
    pull) printf '%s\\n' "$GIT_SSH_COMMAND" > "$FAKE_PULL_ENV_LOG"; exit 0 ;;
    *) exit 0 ;;
esac
"""


@pytest.mark.parametrize(
    ("preset", "expected"),
    [(None, "ssh -o BatchMode=yes"), ("ssh -i /k/id", "ssh -i /k/id -o BatchMode=yes")],
)
def test_git_sync_pull_disables_ssh_prompts_and_keeps_user_ssh_command(
    ss_script_dir, tmp_path, monkeypatch, preset, expected
) -> None:
    """GIT_TERMINAL_PROMPT=0 では SSH の認証プロンプトを止められない。BatchMode=yes を足し、既存値は残す。"""
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    _make_stub(stub_dir, "git", _GIT_SYNC_ENV_STUB)
    _make_stub(stub_dir, "uvx", "#!/bin/bash\nexit 0\n")
    log = tmp_path / "pull-env.log"
    env = _git_sync_env(tmp_path, FAKE_PULL_ENV_LOG=str(log))
    if preset is not None:
        env["GIT_SSH_COMMAND"] = preset
    else:
        monkeypatch.delenv("GIT_SSH_COMMAND", raising=False)

    result = _run_with_path(ss_script_dir / "git-sync.sh", stub_dir, env)

    assert result.returncode == 0
    assert log.read_text().strip() == expected


def test_git_sync_uncommitted_changes_no_output(ss_script_dir, tmp_path) -> None:
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    _make_stub(stub_dir, "git", _GIT_SYNC_STUB)
    _make_stub(stub_dir, "uvx", "#!/bin/bash\nexit 0\n")
    env = _git_sync_env(tmp_path, FAKE_GIT_DIFF_EXIT="1")

    result = _run_with_path(ss_script_dir / "git-sync.sh", stub_dir, env)
    assert result.returncode == 0
    assert result.stdout == ""


def test_git_sync_pull_failure_exit_0(ss_script_dir, tmp_path) -> None:
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    _make_stub(stub_dir, "git", _GIT_SYNC_STUB)
    _make_stub(stub_dir, "uvx", "#!/bin/bash\nexit 0\n")
    env = _git_sync_env(tmp_path, FAKE_GIT_PULL_EXIT="1")

    result = _run_with_path(ss_script_dir / "git-sync.sh", stub_dir, env)
    assert result.returncode == 0
    assert "synced the branch with the remote" not in result.stdout


def test_git_sync_unreachable_remote_pulls_once_and_reports_reason(
    ss_script_dir, git_repo, git_call_log, mock_bin, monkeypatch
) -> None:
    """到達できない remote: pull は 1 回だけ。git の失敗理由は stderr に出し、終了コードは 0 (#1229)。"""
    repo = git_repo("sync-repo")
    unreachable = repo.parent / "no-such-remote.git"
    branch = subprocess.run(
        ["git", "branch", "--show-current"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    for args in (
        ["remote", "add", "origin", str(unreachable)],
        ["config", f"branch.{branch}.remote", "origin"],
        ["config", f"branch.{branch}.merge", f"refs/heads/{branch}"],
    ):
        subprocess.run(["git", *args], cwd=repo, check=True)
    mock_bin.install("uvx", "exit 0\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    git_call_log.reset()

    result = subprocess.run(
        [str(ss_script_dir / "git-sync.sh")], capture_output=True, text=True, timeout=25
    )

    assert result.returncode == 0
    assert git_call_log.count("pull") == 1
    assert "synced the branch with the remote" not in result.stdout
    assert "fatal:" in result.stderr
    assert str(unreachable) in result.stderr


def test_git_sync_uv_not_installed_no_output(ss_script_dir, tmp_path) -> None:
    """uv 未インストール → 出力なし。bashrc で PATH が復元されないよう env -i 相当で実行する。"""
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    _make_stub(stub_dir, "git", _GIT_SYNC_STUB)
    # uvx スタブは置かない → command -v uv が失敗する。
    env = _git_sync_env(tmp_path)

    # bats 版: env -i PATH=<stub>:/usr/bin:/bin HOME=... <FAKE...> bash --norc --noprofile <script>。
    isolated_env = {
        "PATH": f"{stub_dir}:/usr/bin:/bin",
        "HOME": os.environ.get("HOME", "/root"),
        **env,
    }
    result = subprocess.run(
        ["bash", "--norc", "--noprofile", str(ss_script_dir / "git-sync.sh")],
        capture_output=True,
        text=True,
        timeout=25,
        env=isolated_env,
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_git_sync_project_dir_unset_is_silent(ss_script_dir, tmp_path) -> None:
    """CLAUDE_PROJECT_DIR 未設定（git 外で起動）なら何もせず、空パスの警告も出さない。"""
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    _make_stub(stub_dir, "git", _GIT_SYNC_STUB)
    _make_stub(stub_dir, "uvx", "#!/bin/bash\nexit 0\n")
    env = _git_sync_env(tmp_path)
    del env["CLAUDE_PROJECT_DIR"]

    result = _run_with_path(ss_script_dir / "git-sync.sh", stub_dir, env)
    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""


# vscode-workspace-detector

# vscode-workspace-detector は git を呼ばない。呼んだら検出できるよう exit 99 にする。
_VSCODE_GIT_STUB = """#!/bin/bash
exit 99
"""

_CODE_WORKSPACE_STUB = """#!/bin/bash
case "$*" in
    --status)
        echo "window [1] (README.md - MyProject (Workspace) - Visual Studio Code)"
        exit 0
        ;;
    *) exit 0 ;;
esac
"""


def test_vscode_workspace_detected(ss_script_dir, tmp_path) -> None:
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _make_stub(stub_dir, "git", _VSCODE_GIT_STUB)
    _make_stub(stub_dir, "code", _CODE_WORKSPACE_STUB)

    result = _run_with_path(
        ss_script_dir / "vscode-workspace-detector.sh",
        stub_dir,
        {"CLAUDE_PROJECT_DIR": str(repo_root)},
    )
    assert result.returncode == 0
    assert "note: VSCode workspace context" in result.stdout
    assert "**Workspace:** MyProject" in result.stdout


def test_vscode_code_status_failure_no_output(ss_script_dir, tmp_path) -> None:
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _make_stub(stub_dir, "git", _VSCODE_GIT_STUB)
    _make_stub(stub_dir, "code", '#!/bin/bash\necho "error" >&2\nexit 1\n')

    result = _run_with_path(
        ss_script_dir / "vscode-workspace-detector.sh",
        stub_dir,
        {"CLAUDE_PROJECT_DIR": str(repo_root)},
    )
    assert result.returncode == 0
    assert "VSCode Workspace Context" not in result.stdout


def test_vscode_single_folder_no_output(ss_script_dir, tmp_path) -> None:
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _make_stub(stub_dir, "git", _VSCODE_GIT_STUB)
    _make_stub(
        stub_dir,
        "code",
        '#!/bin/bash\ncase "$*" in\n    --status)\n'
        '        echo "window [1] (README.md - MyFolder - Visual Studio Code)"\n'
        "        exit 0\n        ;;\n    *) exit 0 ;;\nesac\n",
    )

    result = _run_with_path(
        ss_script_dir / "vscode-workspace-detector.sh",
        stub_dir,
        {"CLAUDE_PROJECT_DIR": str(repo_root)},
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_vscode_code_workspace_file_lists_folders(ss_script_dir, tmp_path) -> None:
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    repo_root = tmp_path / "repo"
    (repo_root / "workspaces").mkdir(parents=True)
    (repo_root / "workspaces" / "MyProject.code-workspace").write_text(
        '{\n    "folders": [\n'
        '        {"name": "frontend", "path": "/home/user/frontend"},\n'
        '        {"name": "backend", "path": "/home/user/backend"}\n'
        "    ]\n}\n"
    )
    _make_stub(stub_dir, "git", _VSCODE_GIT_STUB)
    _make_stub(stub_dir, "code", _CODE_WORKSPACE_STUB)

    result = _run_with_path(
        ss_script_dir / "vscode-workspace-detector.sh",
        stub_dir,
        {"CLAUDE_PROJECT_DIR": str(repo_root)},
    )
    assert result.returncode == 0
    assert "note: VSCode workspace context" in result.stdout
    assert "**Workspace:** MyProject" in result.stdout
    assert "**Folders:**" in result.stdout
    assert "frontend" in result.stdout
    assert "backend" in result.stdout


def test_vscode_project_dir_unset_no_output(ss_script_dir, tmp_path) -> None:
    """CLAUDE_PROJECT_DIR 未設定（git 外で起動）なら、code --status を呼ばず、何も出さない。"""
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    code_marker = tmp_path / "code-called"
    _make_stub(stub_dir, "git", _VSCODE_GIT_STUB)
    _make_stub(stub_dir, "code", f'#!/bin/bash\ntouch "{code_marker}"\nexit 0\n')

    result = _run_with_path(ss_script_dir / "vscode-workspace-detector.sh", stub_dir, {})
    assert result.returncode == 0
    assert result.stdout == ""
    assert not code_marker.exists()


def test_session_start_entry_pulls_once_for_copilot_new_source(
    hooks_dir, git_repo, git_call_log, mock_bin, monkeypatch
) -> None:
    """Copilot の SessionStart(source=new) でも session-start.sh は git pull を 1 回だけ実行する。

    旧構成は Copilot が matcher を無視して new / clear / resume の 3 本を起動し、pull が 3 回動いた。
    """
    repo = git_repo("sync-entry")
    unreachable = repo.parent / "no-such-remote.git"
    branch = subprocess.run(
        ["git", "branch", "--show-current"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    for args in (
        ["remote", "add", "origin", str(unreachable)],
        ["config", f"branch.{branch}.remote", "origin"],
        ["config", f"branch.{branch}.merge", f"refs/heads/{branch}"],
    ):
        subprocess.run(["git", *args], cwd=repo, check=True)
    mock_bin.install("uvx", "exit 0\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    git_call_log.reset()

    result = subprocess.run(
        ["bash", str(hooks_dir / "session-start.sh")],
        input=json.dumps(
            {
                "hook_event_name": "SessionStart",
                "source": "new",
                "cwd": str(repo),
                "session_id": "c",
            }
        ),
        capture_output=True,
        text=True,
        timeout=25,
    )

    assert result.returncode == 0
    assert git_call_log.count("pull") == 1
    assert "fatal:" in result.stderr


def test_session_start_entry_output_is_json_with_both_additional_contexts(
    hooks_dir, git_repo, mock_bin, monkeypatch
) -> None:
    """git-sync の結果（素のテキスト）が JSON になり、hookSpecificOutput とトップレベルの両方に入る。

    Copilot CLI 1.0.103 は SessionStart ではトップレベルの additionalContext だけをモデルに渡す。
    Claude Code は hookSpecificOutput を読みトップレベルは読まないため、両方に出しても二重に入らない。
    """
    repo = git_repo("sync-json")
    mock_bin.install("uvx", "exit 0\n")
    mock_bin.install("code", "exit 1\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    branch = subprocess.run(
        ["git", "branch", "--show-current"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    # pull が成功するよう、同じ repo を origin にした上流を設定する。
    bare = repo.parent / "sync-json-remote.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(repo), str(bare)], check=True)
    for args in (
        ["remote", "add", "origin", str(bare)],
        ["fetch", "-q", "origin"],
        ["branch", "-q", f"--set-upstream-to=origin/{branch}", branch],
    ):
        subprocess.run(["git", *args], cwd=repo, check=True)

    result = subprocess.run(
        ["bash", str(hooks_dir / "session-start.sh")],
        input=json.dumps(
            {
                "hook_event_name": "SessionStart",
                "source": "new",
                "cwd": str(repo),
                "session_id": "c",
            }
        ),
        capture_output=True,
        text=True,
        timeout=25,
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    context = data["hookSpecificOutput"]["additionalContext"]
    assert data["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    assert "note: synced the branch with the remote" in context
    assert "synced the branch with the remote" in context
    assert data["additionalContext"] == context


def test_session_start_entry_keeps_session_title_out_of_additional_context(
    hooks_dir, git_repo, mock_bin, monkeypatch
) -> None:
    """git-sync が素テキストを出す状態でも、sessionTitle は additionalContext に入り込まない。

    session-title.sh は session-start-common.sh とは別のスクリプトとして merge に渡す。
    同じスクリプトの出力に素テキストと JSON が入り込むと、JSON が文脈の文字列になってしまう。
    """
    repo = git_repo("sync-title")
    mock_bin.install("uvx", "exit 0\n")
    mock_bin.install("code", "exit 1\n")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(repo))
    branch = subprocess.run(
        ["git", "branch", "--show-current"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    bare = repo.parent / "sync-title-remote.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(repo), str(bare)], check=True)
    for args in (
        ["remote", "add", "origin", str(bare)],
        ["fetch", "-q", "origin"],
        ["branch", "-q", f"--set-upstream-to=origin/{branch}", branch],
    ):
        subprocess.run(["git", *args], cwd=repo, check=True)
    state = repo / ".pecot" / "state"
    state.mkdir(parents=True)
    (repo / ".pecot" / ".gitignore").write_text("*\n")
    (state / ".pecot-active").write_text("owner/repo/1253\n")
    (state / ".pecot-session-title").write_text("#1253 題名\n")

    result = subprocess.run(
        ["bash", str(hooks_dir / "session-start.sh")],
        input=json.dumps(
            {
                "hook_event_name": "SessionStart",
                "source": "startup",
                "cwd": str(repo),
                "session_id": "c",
                "transcript_path": "/t/c.jsonl",
            }
        ),
        capture_output=True,
        text=True,
        timeout=25,
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    hook_output = data["hookSpecificOutput"]
    assert hook_output["sessionTitle"] == "#1253 題名"
    assert "note: synced the branch with the remote" in hook_output["additionalContext"]
    assert "sessionTitle" not in hook_output["additionalContext"]
    assert "sessionTitle" not in data["additionalContext"]


# session-project-dir


def _run_session_project_dir(
    ss_script_dir, env_file: Path | None, project_dir: Path | None, **extra: str
) -> subprocess.CompletedProcess:
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ("CLAUDE_ENV_FILE", "CLAUDE_PROJECT_DIR", "PECOT_ORIGINAL_CLAUDE_PROJECT_DIR")
    }
    if env_file is not None:
        env["CLAUDE_ENV_FILE"] = str(env_file)
    if project_dir is not None:
        env["PECOT_ORIGINAL_CLAUDE_PROJECT_DIR"] = str(project_dir)
    env.update(extra)
    return subprocess.run(
        [str(ss_script_dir / "session-project-dir.sh")],
        capture_output=True,
        text=True,
        timeout=25,
        env=env,
    )


def test_session_project_dir_appends_export(ss_script_dir, tmp_path, git_repo) -> None:
    env_file = tmp_path / "claude_env"
    env_file.touch()
    project = git_repo("proj")

    result = _run_session_project_dir(ss_script_dir, env_file, project)

    assert result.returncode == 0
    assert env_file.read_text() == f"export PECOT_SESSION_PROJECT_DIR={project.resolve()}\n"


def test_session_project_dir_writes_toplevel_of_original_dir(
    ss_script_dir, tmp_path, git_repo
) -> None:
    """元の CLAUDE_PROJECT_DIR がリポ内のサブディレクトリでも、書く値はその toplevel。"""
    env_file = tmp_path / "claude_env"
    env_file.touch()
    project = git_repo("proj")
    sub = project / "sub"
    sub.mkdir()

    _run_session_project_dir(ss_script_dir, env_file, sub)

    assert env_file.read_text() == f"export PECOT_SESSION_PROJECT_DIR={project.resolve()}\n"


def test_session_project_dir_ignores_overwritten_project_dir(
    ss_script_dir, tmp_path, git_repo
) -> None:
    """project-root.sh が上書き後の CLAUDE_PROJECT_DIR を使わず、元の値の toplevel を書く。"""
    env_file = tmp_path / "claude_env"
    env_file.touch()
    origin = git_repo("origin")
    other = git_repo("other")

    _run_session_project_dir(ss_script_dir, env_file, origin, CLAUDE_PROJECT_DIR=str(other))

    assert env_file.read_text() == f"export PECOT_SESSION_PROJECT_DIR={origin.resolve()}\n"


def test_session_project_dir_quotes_path_with_spaces(ss_script_dir, tmp_path, git_repo) -> None:
    env_file = tmp_path / "claude_env"
    env_file.touch()
    project = git_repo("my proj")

    _run_session_project_dir(ss_script_dir, env_file, project)

    out = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; printf %s "$PECOT_SESSION_PROJECT_DIR"',
            "bash",
            str(env_file),
        ],
        capture_output=True,
        text=True,
        timeout=25,
        check=True,
    )
    assert out.stdout == str(project.resolve())


@pytest.mark.parametrize("missing", ["env_file", "project_dir"])
def test_session_project_dir_noop_when_unset(ss_script_dir, tmp_path, git_repo, missing) -> None:
    env_file = tmp_path / "claude_env"
    env_file.touch()
    result = _run_session_project_dir(
        ss_script_dir,
        None if missing == "env_file" else env_file,
        None if missing == "project_dir" else git_repo("proj"),
    )
    assert result.returncode == 0
    assert result.stdout == ""
    assert env_file.read_text() == ""


def test_session_project_dir_noop_outside_git(ss_script_dir, tmp_path) -> None:
    env_file = tmp_path / "claude_env"
    env_file.touch()
    outside = tmp_path / "outside"
    outside.mkdir()

    result = _run_session_project_dir(ss_script_dir, env_file, outside)

    assert result.returncode == 0
    assert env_file.read_text() == ""


def test_session_project_dir_can_be_disabled(
    ss_script_dir, tmp_path, git_repo, hooks_config
) -> None:
    hooks_config.write({"session-project-dir": False})
    env_file = tmp_path / "claude_env"
    env_file.touch()

    result = _run_session_project_dir(ss_script_dir, env_file, git_repo("proj"))

    assert result.returncode == 0
    assert env_file.read_text() == ""
