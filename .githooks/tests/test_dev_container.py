"""dev-container.sh のユニットテスト。

docker・devcontainer・sudo・npm は PATH の先頭に置く偽物で置き換え、打たれた引数を 1 呼び出し 1 行で記録して確かめる。
git は temp repo の本物を使う。
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

_REPO = "ghcr.io/example/img"

_DOCKER = r"""#!/bin/bash
echo "docker $*" >> "$STUB_LOG"
case "$1" in
    pull) exit "${STUB_PULL_RC:-0}" ;;
    image)
        case "$*" in
            *RepoDigests*) echo "${!#%%:*}@sha256:beef" ;;
            *.Id*) echo "sha256:localid" ;;
        esac ;;
esac
"""

_DEVCONTAINER = r"""#!/bin/bash
echo "devcontainer $*" >> "$STUB_LOG"
case "$1" in
    read-configuration)
        echo '{"configuration":{"workspaceFolder":"/workspaces/pecot","workspaceMount":"source=x,target=/workspaces/pecot,type=bind","postCreateCommand":"x"}}' ;;
    build) exit "${STUB_BUILD_RC:-0}" ;;
    up)
        echo '{"type":"log"}'
        echo "{\"outcome\":\"${STUB_UP_OUTCOME:-success}\",\"containerId\":\"cid123\"}" ;;
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
    tree: str

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
    tree = subprocess.run(
        ["git", "-C", str(work), "rev-parse", "HEAD:.devcontainer"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

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
        tree=tree,
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


def _image_output(env: Env) -> str:
    lines = [ln for ln in env.out.read_text().splitlines() if ln.startswith("image=")]
    assert len(lines) == 1
    return lines[0][len("image=") :]


def test_pull_success_skips_build(env: Env) -> None:
    result = env.run("up")
    assert result.returncode == 0, result.stderr
    assert env.calls_of("devcontainer build") == []
    assert _image_output(env).startswith(f"{_REPO}:def-{env.tree}@sha256:")
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
        "image": f"{_REPO}:def-{env.tree}",
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
    assert execs[0].endswith("bash -c echo hi")


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
    assert (env.state / "ref").read_text().strip() == f"{_REPO}:def-{env.tree}"
    assert env.run("up").returncode == 0
    assert env.calls_of("docker pull") == [f"docker pull {_REPO}:def-{env.tree}"]
    assert (env.state / "pull.rc").read_text().strip() == "0"
    assert (env.state / "pull.seconds").read_text().strip().isdigit()


def test_restore_owner_chowns_to_current_user(env: Env) -> None:
    assert env.run("restore-owner").returncode == 0
    assert env.calls_of("sudo") == [f"sudo chown -R {os.getuid()}:{os.getgid()} {env.work}"]
