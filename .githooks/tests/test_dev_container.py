"""dev-container.sh のユニットテスト。

docker・devcontainer・sudo・npm は PATH の先頭に置く偽物で置き換え、打たれた引数を 1 呼び出し 1 行で記録して確かめる。
git は temp repo の本物を使う。
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

_REPO = "ghcr.io/example/img"

_DOCKER = r"""#!/bin/bash
echo "docker $*" >> "$STUB_LOG"
case "$1" in
    pull) exit "${STUB_PULL_RC:-0}" ;;
    buildx) exit "${STUB_TAG_EXISTS_RC:-1}" ;;
    image)
        case "$*" in
            *RepoDigests*) echo "${!#%%:*}@sha256:beef" ;;
            *.Id*) echo "sha256:localid" ;;
        esac ;;
esac
"""

_DEVCONTAINER = r"""#!/bin/bash
{ printf 'devcontainer '; printf '%q ' "$@"; echo; } >> "$STUB_LOG"
case "$1" in
    --version) echo "${STUB_CLI_VERSION:-0.90.0}" ;;
    read-configuration)
        if [ "${STUB_READCONF:-}" = nomount ]; then
            echo '{"configuration":{"workspaceFolder":"/workspaces/pecot"}}'
        else
            echo '{"configuration":{"workspaceFolder":"/workspaces/pecot","workspaceMount":"source=x,target=/workspaces/pecot,type=bind","postCreateCommand":"x"}}'
        fi ;;
    build) exit "${STUB_BUILD_RC:-0}" ;;
    up)
        [ "${STUB_UP_MODE:-ok}" = nojson ] || echo '{"type":"log"}'
        case "${STUB_UP_MODE:-ok}" in
            ok) echo "{\"outcome\":\"${STUB_UP_OUTCOME:-success}\",\"containerId\":\"cid123\"}" ;;
            noid) echo '{"outcome":"success"}' ;;
            trailing)
                echo '{"outcome":"success","containerId":"cid123"}'
                echo "done" ;;
            nojson) echo "no json here" ;;
        esac
        exit "${STUB_UP_RC:-0}" ;;
    exec) exit "${STUB_EXEC_RC:-0}" ;;
esac
"""

_RECORD = '#!/bin/bash\necho "$(basename "$0") $*" >> "$STUB_LOG"\n'


@dataclass
class Env:
    script: Path
    work: Path
    state: Path
    log: Path
    out: Path
    env: dict[str, str]
    key: str
    bin_dir: Path

    def run(self, *args: str, **extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", str(self.script), *args],
            env={**self.env, **extra},
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def calls_of(self, prefix: str) -> list[str]:
        return [c for c in self.calls() if c.startswith(prefix)]


@pytest.fixture
def env(
    githooks_dir: Path, tmp_path: Path, git_repo: Callable[..., Path], git: Callable[..., object]
) -> Env:
    work = git_repo("ws")
    (work / ".devcontainer").mkdir()
    (work / ".devcontainer" / "devcontainer.json").write_text("{}\n")
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "init")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (
        ("docker", _DOCKER),
        ("devcontainer", _DEVCONTAINER),
        ("sudo", _RECORD),
        ("npm", _RECORD),
    ):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)

    runner_temp = tmp_path / "runner"
    runner_temp.mkdir()
    out = tmp_path / "gh-output"
    out.write_text("")
    log = tmp_path / "calls.log"
    return Env(
        script=githooks_dir / "ci" / "dev-container.sh",
        work=work,
        state=runner_temp / "pecot-dc",
        log=log,
        out=out,
        key=_key(work),
        bin_dir=bin_dir,
        env={
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "HOME": str(tmp_path),
            "GITHUB_WORKSPACE": str(work),
            "RUNNER_TEMP": str(runner_temp),
            "GITHUB_OUTPUT": str(out),
            "PECOT_CI_IMAGE_REPO": _REPO,
            "STUB_LOG": str(log),
        },
    )


def _key(work: Path) -> str:
    return subprocess.run(
        "git ls-tree HEAD -- .devcontainer/Dockerfile .devcontainer/devcontainer.json"
        " .devcontainer/devcontainer-lock.json .devcontainer/features | git hash-object --stdin",
        shell=True,
        cwd=work,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _image_output(env: Env) -> str:
    lines = [ln for ln in env.out.read_text().splitlines() if ln.startswith("image=")]
    assert len(lines) == 1
    return lines[0][len("image=") :]


def test_pull_success_skips_build(env: Env) -> None:
    result = env.run("up")
    assert result.returncode == 0, result.stderr
    assert env.calls_of("devcontainer build") == []
    assert _image_output(env).startswith(f"{_REPO}:def-{env.key}@sha256:")
    assert f"PECOT_CI_IMAGE={_image_output(env)}" in result.stdout


def test_pull_failure_falls_back_to_build(env: Env) -> None:
    result = env.run("up", STUB_PULL_RC="1")
    assert result.returncode == 0, result.stderr
    builds = env.calls_of("devcontainer build")
    assert len(builds) == 1
    assert "--image-name pecot-ci-local" in builds[0]
    assert f"--cache-from {_REPO}:latest" in builds[0]
    assert _image_output(env) == "pecot-ci-local（PR の定義から build, sha256:localid）"
    assert (
        json.loads((env.state / "override" / "devcontainer.json").read_text())["image"]
        == "pecot-ci-local"
    )


def test_build_failure_exits_1_with_failure_image(env: Env) -> None:
    result = env.run("up", STUB_PULL_RC="1", STUB_BUILD_RC="1")
    assert result.returncode == 1
    assert _image_output(env) == "pecot-ci-local（PR の定義から build, 失敗）"
    assert env.calls_of("devcontainer up") == []


def test_up_uses_minimal_override_and_no_uid_update(env: Env) -> None:
    result = env.run("up")
    assert result.returncode == 0, result.stderr
    override = env.state / "override" / "devcontainer.json"
    assert json.loads(override.read_text()) == {
        "image": f"{_REPO}:def-{env.key}",
        "workspaceFolder": "/workspaces/pecot",
        "workspaceMount": "source=x,target=/workspaces/pecot,type=bind",
    }
    ups = env.calls_of("devcontainer up")
    assert len(ups) == 1
    assert f"--override-config {override}" in ups[0]
    assert "--update-remote-user-uid-default never" in ups[0]
    assert env.calls_of("sudo") == [f"sudo chown -R 1000:1000 {env.work}"]
    assert (env.state / "container-id").read_text().strip() == "cid123"


def test_up_fails_when_outcome_is_not_success(env: Env) -> None:
    assert env.run("up", STUB_UP_OUTCOME="error").returncode == 1


def test_exec_passes_container_id_and_returns_exit_code(env: Env) -> None:
    assert env.run("up").returncode == 0
    result = env.run("exec", "--", "echo hi", STUB_EXEC_RC="7")
    assert result.returncode == 7
    execs = env.calls_of("devcontainer exec")
    assert len(execs) == 1
    assert "--container-id cid123" in execs[0]
    assert "--override-config" in execs[0]
    assert shlex.split(execs[0])[-3:] == ["bash", "-c", "echo hi"]


def test_exec_without_container_id_fails(env: Env) -> None:
    result = env.run("exec", "--", "true")
    assert result.returncode == 1
    assert env.calls_of("devcontainer exec") == []


def test_only_non_empty_env_is_passed_as_remote_env(env: Env) -> None:
    extra = {"DEVCONTAINER_ENV": "FOO BAR\nEMPTY", "FOO": "1", "BAR": "two", "EMPTY": ""}
    assert env.run("up", **extra).returncode == 0
    assert env.run("exec", "--", "true", **extra).returncode == 0
    for call in (env.calls_of("devcontainer up")[0], env.calls_of("devcontainer exec")[0]):
        assert "--remote-env FOO=1" in call
        assert "--remote-env BAR=two" in call
        assert "EMPTY" not in call


def test_prefetch_then_up_pulls_once(env: Env) -> None:
    result = env.run("prefetch")
    assert result.returncode == 0, result.stderr
    assert (env.state / "ref").read_text().strip() == f"{_REPO}:def-{env.key}"
    assert env.run("up").returncode == 0
    assert env.calls_of("docker pull") == [f"docker pull {_REPO}:def-{env.key}"]
    assert (env.state / "pull.rc").read_text().strip() == "0"
    assert (env.state / "pull.seconds").read_text().strip().isdigit()


def test_restore_owner_chowns_to_current_user(env: Env) -> None:
    assert env.run("restore-owner").returncode == 0
    assert env.calls_of("sudo") == [f"sudo chown -R {os.getuid()}:{os.getgid()} {env.work}"]


def test_up_fails_when_devcontainer_up_fails(env: Env) -> None:
    result = env.run("up", STUB_UP_RC="3")
    assert result.returncode == 1
    assert "devcontainer up が失敗した" in result.stderr


def test_up_fails_without_container_id(env: Env) -> None:
    result = env.run("up", STUB_UP_MODE="noid")
    assert result.returncode == 1
    assert "containerId が無い" in result.stderr
    assert not (env.state / "container-id").exists()


def test_up_takes_last_json_line_even_if_non_json_follows(env: Env) -> None:
    assert env.run("up", STUB_UP_MODE="trailing").returncode == 0
    assert (env.state / "container-id").read_text().strip() == "cid123"


def test_up_fails_without_json_line(env: Env) -> None:
    result = env.run("up", STUB_UP_MODE="nojson")
    assert result.returncode == 1
    assert "結果の JSON が無い" in result.stderr


def test_prefetch_pull_failure_falls_back_to_build(env: Env) -> None:
    assert env.run("prefetch", STUB_PULL_RC="1").returncode == 0
    result = env.run("up")
    assert result.returncode == 0, result.stderr
    assert len(env.calls_of("devcontainer build")) == 1
    assert "docker pull が失敗したため" in result.stderr


def test_exec_command_is_passed_as_one_unexpanded_argument(env: Env) -> None:
    assert env.run("up").returncode == 0
    cmd = 'echo "$CHECKS_PART" && true'
    assert env.run("exec", "--", cmd, CHECKS_PART="host-value").returncode == 0
    call = env.calls_of("devcontainer exec")[0]
    assert shlex.split(call)[-1] == cmd
    assert "host-value" not in call


def test_install_cli_runs_npm_only_when_missing_or_other_version(env: Env) -> None:
    assert env.run("install-cli").returncode == 0
    assert env.calls_of("npm") == []
    assert env.run("install-cli", STUB_CLI_VERSION="0.89.0").returncode == 0
    assert env.calls_of("npm") == ["npm install -g @devcontainers/cli@0.90.0"]
    (env.bin_dir / "devcontainer").unlink()
    assert env.run("install-cli").returncode == 0
    assert len(env.calls_of("npm")) == 2


def test_unknown_subcommand_exits_2(env: Env) -> None:
    result = env.run("bogus")
    assert result.returncode == 2
    assert "tag" in result.stderr
    assert "install-cli" in result.stderr


@pytest.mark.parametrize("missing", ["GITHUB_WORKSPACE", "RUNNER_TEMP"])
def test_missing_runner_env_exits_1(env: Env, missing: str) -> None:
    del env.env[missing]
    result = env.run("restore-owner")
    assert result.returncode == 1
    assert missing in result.stderr


def test_pull_timeout_kills_puller_and_builds(env: Env) -> None:
    env.state.mkdir(parents=True)
    (env.state / "pull.started").touch()
    sleeper = subprocess.Popen(["sleep", "60"])
    try:
        (env.state / "pull.pid").write_text(str(sleeper.pid))
        result = env.run("up", PECOT_DC_PULL_TIMEOUT="1")
        assert result.returncode == 0, result.stderr
        assert "1 秒で終わらない" in result.stderr
        assert len(env.calls_of("devcontainer build")) == 1
        deadline = time.time() + 5
        while sleeper.poll() is None and time.time() < deadline:
            time.sleep(0.1)
        assert sleeper.poll() is not None
    finally:
        sleeper.kill()
        sleeper.wait()


def test_dead_pull_process_falls_back_to_build_immediately(env: Env) -> None:
    env.state.mkdir(parents=True)
    (env.state / "pull.started").touch()
    dead = subprocess.Popen(["true"])
    dead.wait()
    (env.state / "pull.pid").write_text(str(dead.pid))
    start = time.time()
    result = env.run("up", PECOT_DC_PULL_TIMEOUT="30")
    assert result.returncode == 0, result.stderr
    assert time.time() - start < 10
    assert "結果を残さず終了した" in result.stderr
    assert len(env.calls_of("devcontainer build")) == 1


def test_invalid_env_name_is_rejected(env: Env) -> None:
    result = env.run("up", DEVCONTAINER_ENV="GOOD bad-name")
    assert result.returncode == 1
    assert "bad-name" in result.stderr


def test_up_fails_when_workspace_mount_is_missing(env: Env) -> None:
    result = env.run("up", STUB_READCONF="nomount")
    assert result.returncode == 1
    assert "workspaceMount" in result.stderr
    assert env.calls_of("devcontainer up") == []


def test_common_env_is_passed_without_declaring_it(env: Env) -> None:
    assert env.run("up", NX_BASE="abc", CI="true").returncode == 0
    call = env.calls_of("devcontainer up")[0]
    assert "--remote-env NX_BASE=abc" in call
    assert "--remote-env CI=true" in call


def test_tag_prints_ref_and_ignores_files_outside_the_image(
    env: Env, git: Callable[..., object]
) -> None:
    first = env.run("tag")
    assert first.stdout.strip() == f"{_REPO}:def-{env.key}"
    (env.work / ".devcontainer" / "README.md").write_text("doc\n")
    git(env.work, "add", "-A")
    git(env.work, "commit", "-q", "-m", "doc")
    assert env.run("tag").stdout == first.stdout
    (env.work / ".devcontainer" / "Dockerfile").write_text("FROM scratch\n")
    git(env.work, "add", "-A")
    git(env.work, "commit", "-q", "-m", "image")
    assert env.run("tag").stdout != first.stdout


_ZSTD = "type=registry,compression=zstd,force-compression=true,oci-mediatypes=true"


def _build_args(env: Env) -> list[str]:
    builds = env.calls_of("devcontainer build")
    assert len(builds) == 1
    return shlex.split(builds[0])[2:]


def test_publish_without_flags_builds_only(env: Env) -> None:
    result = env.run("publish")
    assert result.returncode == 0, result.stderr
    assert _build_args(env) == [
        "--workspace-folder", str(env.work),
        "--image-name", f"{_REPO}:def-{env.key}",
        "--cache-from", f"{_REPO}:latest",
    ]  # fmt: skip


def test_publish_without_push_builds_even_if_tag_exists(env: Env) -> None:
    assert env.run("publish", STUB_TAG_EXISTS_RC="0").returncode == 0
    assert env.calls_of("docker buildx") == []
    assert "--output" not in _build_args(env)


def test_publish_push_uses_zstd_registry_output(env: Env) -> None:
    assert env.run("publish", "--push").returncode == 0
    args = _build_args(env)
    assert args[args.index("--output") + 1] == _ZSTD
    assert args.count("--image-name") == 1


def test_publish_push_skips_build_when_tag_exists(env: Env) -> None:
    result = env.run("publish", "--push", STUB_TAG_EXISTS_RC="0")
    assert result.returncode == 0, result.stderr
    assert "already exists" in result.stdout
    assert env.calls_of("devcontainer build") == []
    assert env.calls_of("docker buildx") == [
        f"docker buildx imagetools inspect {_REPO}:def-{env.key}"
    ]


def test_publish_latest_builds_even_if_tag_exists(env: Env) -> None:
    assert env.run("publish", "--push", "--latest", STUB_TAG_EXISTS_RC="0").returncode == 0
    args = _build_args(env)
    assert args.count("--image-name") == 2
    assert f"{_REPO}:latest" in args
    assert "--output" in args


def test_publish_no_cache_is_passed(env: Env) -> None:
    assert env.run("publish", "--push", "--latest", "--no-cache").returncode == 0
    assert "--no-cache" in _build_args(env)


def test_publish_rejects_unknown_argument(env: Env) -> None:
    result = env.run("publish", "--bogus")
    assert result.returncode == 2
    assert env.calls_of("devcontainer build") == []


def test_publish_base_without_value_exits_2(env: Env) -> None:
    result = env.run("publish", "--base")
    assert result.returncode == 2
    assert "--base に値が要る" in result.stderr
    assert env.calls_of("devcontainer build") == []


def test_publish_propagates_build_failure(env: Env) -> None:
    assert env.run("publish", "--push", STUB_BUILD_RC="1").returncode == 1


def _commit_all(env: Env, git: Callable[..., object], message: str) -> None:
    git(env.work, "add", "-A")
    git(env.work, "commit", "-q", "-m", message)


def _drift_setup(env: Env, git: Callable[..., object], *, drift: bool) -> None:
    git(env.work, "branch", "-M", "main")
    git(env.work, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(env.work, "checkout", "-q", "-b", "pr")
    (env.work / "f.txt").write_text("pr\n")
    _commit_all(env, git, "pr")
    git(env.work, "checkout", "-q", "main")
    if drift:
        (env.work / ".devcontainer" / "Dockerfile").write_text("FROM scratch\n")
    else:
        (env.work / "g.txt").write_text("main\n")
    _commit_all(env, git, "main moves")
    git(env.work, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(env.work, "checkout", "-q", "pr")


def test_publish_warns_when_merged_key_differs(env: Env, git: Callable[..., object]) -> None:
    _drift_setup(env, git, drift=True)
    result = env.run("publish", "--base", "main")
    assert result.returncode == 0, result.stderr
    assert "::warning::origin/main との merge 後の key" in result.stdout
    assert len(env.calls_of("devcontainer build")) == 1


def test_publish_is_silent_when_merged_key_matches(env: Env, git: Callable[..., object]) -> None:
    _drift_setup(env, git, drift=False)
    result = env.run("publish", "--base", "main")
    assert result.returncode == 0, result.stderr
    assert "::warning::" not in result.stdout


def test_publish_skips_drift_check_when_base_ref_is_missing(env: Env) -> None:
    result = env.run("publish", "--base", "nonexistent")
    assert result.returncode == 0, result.stderr
    assert "::warning::" not in result.stdout
    assert "key のずれの確認を飛ばす" in result.stdout
    assert len(env.calls_of("devcontainer build")) == 1
