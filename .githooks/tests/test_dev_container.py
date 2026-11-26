"""dev-container.sh のユニットテスト。

docker・devcontainer・sudo・npm は PATH の先頭に置く偽物で置き換え、打たれた引数を 1 呼び出し 1 行で記録して確かめる。
git は temp repo の本物を使う。
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

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
        return run_attached(
            ["bash", str(self.script), *args],
            env={**self.env, **extra},
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def calls(self) -> list[str]:
        return read_output(self.log).splitlines() if self.log.exists() else []

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
    return run_attached(
        "git ls-tree HEAD -- .devcontainer/Dockerfile .devcontainer/devcontainer.json"
        " .devcontainer/devcontainer-lock.json .devcontainer/features | git hash-object --stdin",
        shell=True,
        cwd=work,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _image_output(env: Env) -> str:
    lines = [ln for ln in read_output(env.out).splitlines() if ln.startswith("image=")]
    assert len(lines) == 1
    return lines[0][len("image=") :]


@allure.title("up でイメージの pull に成功すると、build せずにそのイメージを使う")
def test_pull_success_skips_build(env: Env) -> None:
    """`dev-container.sh up` の、`docker pull` が成功する場合のテストです。終了コード 0 で終わり、`devcontainer build` を呼ばず、`image` に `def-` で始まるタグと digest を含むイメージを出力することを確認します。"""
    with allure.step("イメージを pull して up する"):
        result = env.run("up")
    with allure.step("終了コードと build を呼ばないことと出力のイメージを確かめる"):
        assert result.returncode == 0, result.stderr
        assert env.calls_of("devcontainer build") == []
        assert _image_output(env).startswith(f"{_REPO}:def-{env.key}@sha256:")
        assert f"PECOT_CI_IMAGE={_image_output(env)}" in result.stdout


@allure.title("up でイメージの pull に失敗すると、PR の定義から build して、そのイメージを使う")
def test_pull_failure_falls_back_to_build(env: Env) -> None:
    """`docker pull` が失敗する場合のテストです。終了コード 0 で終わり、`devcontainer build` を 1 回呼び、`image` にローカルのイメージ `pecot-ci-local` を出力することを確認します。"""
    with allure.step("pull が失敗する状態で up する"):
        result = env.run("up", STUB_PULL_RC="1")
    with allure.step("build の呼び出しの引数と出力のイメージを確かめる"):
        assert result.returncode == 0, result.stderr
        builds = env.calls_of("devcontainer build")
        assert len(builds) == 1
        assert "--image-name pecot-ci-local" in builds[0]
        assert f"--cache-from {_REPO}:latest" in builds[0]
        assert _image_output(env) == "pecot-ci-local（PR の定義から build, sha256:localid）"
        assert (
            json.loads(read_output(env.state / "override" / "devcontainer.json"))["image"]
            == "pecot-ci-local"
        )


@allure.title(
    "up で pull と build の両方に失敗すると、失敗を示すイメージを出力して終了コード 1 で終わる"
)
def test_build_failure_exits_1_with_failure_image(env: Env) -> None:
    """`docker pull` と `devcontainer build` がどちらも失敗する場合のテストです。終了コード 1 で終わり、`image` に「失敗」を含む値を出力し、`devcontainer up` を呼ばないことを確認します。"""
    with allure.step("pull と build が失敗する状態で up する"):
        result = env.run("up", STUB_PULL_RC="1", STUB_BUILD_RC="1")
    with allure.step("終了コード 1 と失敗のイメージと up を呼ばないことを確かめる"):
        assert result.returncode == 1
        assert _image_output(env) == "pecot-ci-local（PR の定義から build, 失敗）"
        assert env.calls_of("devcontainer up") == []


@allure.title("up は、最小限の設定の上書きを使い、UID の更新をせずに起動する")
def test_up_uses_minimal_override_and_no_uid_update(env: Env) -> None:
    """`dev-container.sh up` が `devcontainer up` に渡す引数のテストです。上書きの設定が `image` などの 3 項目だけで、`--update-remote-user-uid-default never` を指定し、コンテナ ID を保存することを確認します。"""
    with allure.step("devcontainer を up する"):
        result = env.run("up")
    with allure.step("override の内容と up の引数と chown とコンテナ ID を確かめる"):
        assert result.returncode == 0, result.stderr
        override = env.state / "override" / "devcontainer.json"
        assert json.loads(read_output(override)) == {
            "image": f"{_REPO}:def-{env.key}",
            "workspaceFolder": "/workspaces/pecot",
            "workspaceMount": "source=x,target=/workspaces/pecot,type=bind",
        }
        ups = env.calls_of("devcontainer up")
        assert len(ups) == 1
        assert f"--override-config {override}" in ups[0]
        assert "--update-remote-user-uid-default never" in ups[0]
        assert env.calls_of("sudo") == [f"sudo chown -R 1000:1000 {env.work}"]
        assert read_output(env.state / "container-id").strip() == "cid123"


@allure.title("devcontainer up の結果が success でないと、up は終了コード 1 で終わる")
def test_up_fails_when_outcome_is_not_success(env: Env) -> None:
    """`devcontainer up` の結果の JSON の `outcome` が `error` の場合のテストです。`dev-container.sh up` が終了コード 1 で終わることを確認します。"""
    with allure.step("up の結果が success でないと、終了コード 1 で終わることを確かめる"):
        assert env.run("up", STUB_UP_OUTCOME="error").returncode == 1


@allure.title("exec は、保存したコンテナ ID を渡し、コマンドの終了コードを返す")
def test_exec_passes_container_id_and_returns_exit_code(env: Env) -> None:
    """`up` のあとに `exec -- 'echo hi'` を実行するテストです。`--container-id` と `--override-config` を渡し、コマンドを `bash -c` で実行して、終了コード 7 をそのまま返すことを確認します。"""
    with allure.step("up してから exec を動かして、終了コードと exec の引数を確かめる"):
        assert env.run("up").returncode == 0
        result = env.run("exec", "--", "echo hi", STUB_EXEC_RC="7")
        assert result.returncode == 7
        execs = env.calls_of("devcontainer exec")
        assert len(execs) == 1
        assert "--container-id cid123" in execs[0]
        assert "--override-config" in execs[0]
        assert shlex.split(execs[0])[-3:] == ["bash", "-c", "echo hi"]


@allure.title("コンテナ ID が存在しないと、exec は終了コード 1 で終わる")
def test_exec_without_container_id_fails(env: Env) -> None:
    """`up` を実行せずに `exec` を実行する場合のテストです。終了コード 1 で終わり、`devcontainer exec` を呼ばないことを確認します。"""
    with allure.step("コンテナ ID が無い状態で exec する"):
        result = env.run("exec", "--", "true")
    with allure.step("終了コード 1 と exec を呼ばないことを確かめる"):
        assert result.returncode == 1
        assert env.calls_of("devcontainer exec") == []


@allure.title("空ではない環境変数だけを、remote-env として渡す")
def test_only_non_empty_env_is_passed_as_remote_env(env: Env) -> None:
    """`DEVCONTAINER_ENV` に `FOO`・`BAR`・`EMPTY` を指定して、`up` と `exec` を実行するテストです。値のある `FOO` と `BAR` を `--remote-env` として渡し、空の `EMPTY` は渡さないことを確認します。"""
    with allure.step(
        "空の値を含む環境変数を渡して up と exec を動かし、空でない値だけが remote-env に渡ることを確かめる"
    ):
        extra = {"DEVCONTAINER_ENV": "FOO BAR\nEMPTY", "FOO": "1", "BAR": "two", "EMPTY": ""}
    with allure.step(
        "空の値を含む環境変数を渡して up と exec を動かし、空でない値だけが remote-env に渡ることを確かめる"
    ):
        assert env.run("up", **extra).returncode == 0
        assert env.run("exec", "--", "true", **extra).returncode == 0
        for call in (env.calls_of("devcontainer up")[0], env.calls_of("devcontainer exec")[0]):
            assert "--remote-env FOO=1" in call
            assert "--remote-env BAR=two" in call
            assert "EMPTY" not in call


@allure.title("prefetch のあとに up を実行しても、pull は 1 回だけにする")
def test_prefetch_then_up_pulls_once(env: Env) -> None:
    """`prefetch` と `up` を続けて実行するテストです。`docker pull` が 1 回だけで、イメージの参照と、pull の終了コードと秒数が、状態のディレクトリに保存されることを確認します。"""
    with allure.step("prefetch を動かす"):
        result = env.run("prefetch")
    with allure.step("先読みの ref と、続く up が pull を 1 回だけ使うことを確かめる"):
        assert result.returncode == 0, result.stderr
        assert read_output(env.state / "ref").strip() == f"{_REPO}:def-{env.key}"
        assert env.run("up").returncode == 0
        assert env.calls_of("docker pull") == [f"docker pull {_REPO}:def-{env.key}"]
        assert read_output(env.state / "pull.rc").strip() == "0"
        assert read_output(env.state / "pull.seconds").strip().isdigit()


@allure.title("restore-owner は、ワークスペースの所有者を現在のユーザーに戻す")
def test_restore_owner_chowns_to_current_user(env: Env) -> None:
    """`restore-owner` を実行するテストです。`sudo chown -R` で、現在のユーザーと group の ID を、ワークスペースに設定することを確認します。"""
    with allure.step("restore-owner が現在のユーザーへ chown することを確かめる"):
        assert env.run("restore-owner").returncode == 0
        assert env.calls_of("sudo") == [f"sudo chown -R {os.getuid()}:{os.getgid()} {env.work}"]


@allure.title("devcontainer up が失敗すると、up は理由を出力して終了コード 1 で終わる")
def test_up_fails_when_devcontainer_up_fails(env: Env) -> None:
    """`devcontainer up` が終了コード 3 で失敗する場合のテストです。`dev-container.sh up` が終了コード 1 で終わり、`devcontainer up が失敗した` 旨を標準エラーに出力することを確認します。"""
    with allure.step("devcontainer up が失敗する状態で up する"):
        result = env.run("up", STUB_UP_RC="3")
    with allure.step("終了コード 1 とエラーの出力を確かめる"):
        assert result.returncode == 1
        assert "devcontainer up が失敗した" in result.stderr


@allure.title("結果の JSON に containerId が存在しないと、up は失敗し、コンテナ ID を保存しない")
def test_up_fails_without_container_id(env: Env) -> None:
    """`devcontainer up` の結果の JSON に `containerId` が存在しない場合のテストです。終了コード 1 で終わり、`containerId` に関するメッセージを出力して、コンテナ ID のファイルを作らないことを確認します。"""
    with allure.step("containerId の無い結果で up する"):
        result = env.run("up", STUB_UP_MODE="noid")
    with allure.step("終了コード 1 とエラーの出力とコンテナ ID が残らないことを確かめる"):
        assert result.returncode == 1
        assert "containerId が無い" in result.stderr
        assert not (env.state / "container-id").exists()


@allure.title("up は、JSON の行の後ろに JSON ではない行が続いても、最後の JSON の行を使う")
def test_up_takes_last_json_line_even_if_non_json_follows(env: Env) -> None:
    """`devcontainer up` の出力の最後に、JSON ではない行が続く場合のテストです。終了コード 0 で終わり、最後の JSON の行の `containerId` を保存することを確認します。"""
    with allure.step(
        "JSON の後に JSON でない行が続いても up が通り、最後の JSON のコンテナ ID を使うことを確かめる"
    ):
        assert env.run("up", STUB_UP_MODE="trailing").returncode == 0
        assert read_output(env.state / "container-id").strip() == "cid123"


@allure.title("結果の JSON の行が存在しないと、up は理由を出力して終了コード 1 で終わる")
def test_up_fails_without_json_line(env: Env) -> None:
    """`devcontainer up` の出力に、JSON の行が 1 つも存在しない場合のテストです。終了コード 1 で終わり、結果の JSON が存在しない旨を標準エラーに出力することを確認します。"""
    with allure.step("JSON の行が無い結果で up する"):
        result = env.run("up", STUB_UP_MODE="nojson")
    with allure.step("終了コード 1 とエラーの出力を確かめる"):
        assert result.returncode == 1
        assert "結果の JSON が無い" in result.stderr


@allure.title("prefetch の pull に失敗しても、up は build にフォールバックする")
def test_prefetch_pull_failure_falls_back_to_build(env: Env) -> None:
    """`prefetch` の `docker pull` が失敗したあとに、`up` を実行するテストです。終了コード 0 で終わり、`devcontainer build` を 1 回呼び、pull が失敗したため build する旨を出力することを確認します。"""
    with allure.step("pull が失敗する prefetch の後に up して、build に戻ることを確かめる"):
        assert env.run("prefetch", STUB_PULL_RC="1").returncode == 0
        result = env.run("up")
        assert result.returncode == 0, result.stderr
        assert len(env.calls_of("devcontainer build")) == 1
        assert "docker pull が失敗したため" in result.stderr


@allure.title("exec のコマンドは、展開せずに 1 つの引数として渡す")
def test_exec_command_is_passed_as_one_unexpanded_argument(env: Env) -> None:
    """ホストの環境変数 `CHECKS_PART` を含むコマンドを、`exec` に渡すテストです。コマンドを展開せず 1 つの引数のまま渡し、ホストの値がコマンドの行に含まれないことを確認します。"""
    with allure.step("exec のコマンドが展開されずに 1 つの引数で渡ることを確かめる"):
        assert env.run("up").returncode == 0
        cmd = 'echo "$CHECKS_PART" && true'
        assert env.run("exec", "--", cmd, CHECKS_PART="host-value").returncode == 0
        call = env.calls_of("devcontainer exec")[0]
        assert shlex.split(call)[-1] == cmd
        assert "host-value" not in call


@allure.title("install-cli は、CLI が存在しない場合か版が異なる場合だけ、npm で指定の版を入れる")
def test_install_cli_runs_npm_only_when_missing_or_other_version(env: Env) -> None:
    """`install-cli` を、版が一致する場合・異なる場合・`devcontainer` が存在しない場合で実行するテストです。版が一致するときは `npm` を呼ばず、異なるときと存在しないときは `npm install -g @devcontainers/cli@0.90.0` を呼ぶことを確認します。"""
    with allure.step("install-cli が、CLI が無いか版が違うときだけ npm を動かすことを確かめる"):
        assert env.run("install-cli").returncode == 0
        assert env.calls_of("npm") == []
        assert env.run("install-cli", STUB_CLI_VERSION="0.89.0").returncode == 0
        assert env.calls_of("npm") == ["npm install -g @devcontainers/cli@0.90.0"]
        (env.bin_dir / "devcontainer").unlink()
        assert env.run("install-cli").returncode == 0
        assert len(env.calls_of("npm")) == 2


@allure.title("未知のサブコマンドを渡すと、使い方を出力して終了コード 2 で終わる")
def test_unknown_subcommand_exits_2(env: Env) -> None:
    """`dev-container.sh bogus` を実行するテストです。終了コード 2 で終わり、標準エラーに `tag` や `install-cli` などのサブコマンドの案内を出力することを確認します。"""
    with allure.step("未知のサブコマンドを動かす"):
        result = env.run("bogus")
    with allure.step("終了コード 2 と使い方の出力を確かめる"):
        assert result.returncode == 2
        assert "tag" in result.stderr
        assert "install-cli" in result.stderr


@allure.title("{missing} が存在しないと、その名前を出力して終了コード 1 で終わる")
@pytest.mark.parametrize("missing", ["GITHUB_WORKSPACE", "RUNNER_TEMP"])
def test_missing_runner_env_exits_1(env: Env, missing: str) -> None:
    """`GITHUB_WORKSPACE` か `RUNNER_TEMP` を外して、`restore-owner` を実行するテストです。終了コード 1 で終わり、外した環境変数の名前を標準エラーに出力することを確認します。"""
    with allure.step("runner の環境変数を 1 つ消して restore-owner を動かす"):
        del env.env[missing]
        result = env.run("restore-owner")
    with allure.step("終了コード 1 と消した変数名の出力を確かめる"):
        assert result.returncode == 1
        assert missing in result.stderr


@allure.title("pull がタイムアウトすると、pull のプロセスを止め、build にフォールバックする")
def test_pull_timeout_kills_puller_and_builds(env: Env) -> None:
    """`PECOT_DC_PULL_TIMEOUT` を 1 秒にして、終わらない pull のプロセスがある場合のテストです。終了コード 0 で終わり、秒数を超えた旨を出力して、そのプロセスを終了させ、`devcontainer build` を 1 回呼ぶことを確認します。"""
    with allure.step("pull の途中の状態を用意する"):
        env.state.mkdir(parents=True)
        (env.state / "pull.started").touch()
        sleeper = subprocess.Popen(["sleep", "60"])
    with allure.step("タイムアウトで pull の子を止め、build に戻ることを確かめる"):
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


@allure.title("pull のプロセスが結果を残さず終了していると、待たずに build へフォールバックする")
def test_dead_pull_process_falls_back_to_build_immediately(env: Env) -> None:
    """`pull.pid` が、すでに終了したプロセスを指す場合のテストです。タイムアウトの 30 秒を待たず、10 秒以内に終了し、結果を残さず終了した旨を出力して、`devcontainer build` を 1 回呼ぶことを確認します。"""
    with allure.step("pull のプロセスが終わった状態を用意して up する"):
        env.state.mkdir(parents=True)
        (env.state / "pull.started").touch()
        dead = subprocess.Popen(["true"])
        dead.wait()
        (env.state / "pull.pid").write_text(str(dead.pid))
        start = time.time()
        result = env.run("up", PECOT_DC_PULL_TIMEOUT="30")
    with allure.step("終了コードと待たずに build へ戻ることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert time.time() - start < 10
        assert "結果を残さず終了した" in result.stderr
        assert len(env.calls_of("devcontainer build")) == 1


@allure.title("環境変数の名前が不正だと、その名前を出力して終了コード 1 で終わる")
def test_invalid_env_name_is_rejected(env: Env) -> None:
    """`DEVCONTAINER_ENV` に、`bad-name` のようなシェルの変数として不正な名前を指定する場合のテストです。終了コード 1 で終わり、不正な名前を標準エラーに出力することを確認します。"""
    with allure.step("不正な環境変数名を渡して up する"):
        result = env.run("up", DEVCONTAINER_ENV="GOOD bad-name")
    with allure.step("終了コード 1 と不正な名前の出力を確かめる"):
        assert result.returncode == 1
        assert "bad-name" in result.stderr


@allure.title("設定に workspaceMount が存在しないと、up は失敗し、devcontainer up を呼ばない")
def test_up_fails_when_workspace_mount_is_missing(env: Env) -> None:
    """`devcontainer read-configuration` の結果に、`workspaceMount` が存在しない場合のテストです。終了コード 1 で終わり、`workspaceMount` に関するメッセージを出力して、`devcontainer up` を呼ばないことを確認します。"""
    with allure.step("workspaceMount の無い設定で up する"):
        result = env.run("up", STUB_READCONF="nomount")
    with allure.step("終了コード 1 とエラーの出力と up を呼ばないことを確かめる"):
        assert result.returncode == 1
        assert "workspaceMount" in result.stderr
        assert env.calls_of("devcontainer up") == []


@allure.title("NX_BASE と CI の共通の環境変数は、宣言しなくても remote-env として渡す")
def test_common_env_is_passed_without_declaring_it(env: Env) -> None:
    """`DEVCONTAINER_ENV` を指定せずに、`NX_BASE` と `CI` を環境変数に設定して `up` を実行するテストです。2 つの変数を `--remote-env` として `devcontainer up` に渡すことを確認します。"""
    with allure.step("宣言していない共通の環境変数を渡して up し、remote-env に渡ることを確かめる"):
        assert env.run("up", NX_BASE="abc", CI="true").returncode == 0
        call = env.calls_of("devcontainer up")[0]
        assert "--remote-env NX_BASE=abc" in call
        assert "--remote-env CI=true" in call


@allure.title("tag は、イメージの参照を出力し、イメージに入らないファイルの変更では変わらない")
def test_tag_prints_ref_and_ignores_files_outside_the_image(
    env: Env, git: Callable[..., object]
) -> None:
    """`tag` を実行するテストです。`.devcontainer/README.md` を変更しても出力は変わらず、`Dockerfile` を変更したときだけ出力が変わることを確認します。"""
    first = env.run("tag")
    with allure.step(
        "イメージ外のファイルを変えても tag が変わらず、イメージの定義を変えると変わることを確かめる"
    ):
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


@allure.title("publish にフラグを付けないと、build だけを実行する")
def test_publish_without_flags_builds_only(env: Env) -> None:
    """`publish` をフラグなしで実行するテストです。`devcontainer build` の引数が、ワークスペースとイメージ名と、`latest` のキャッシュだけであることを確認します。"""
    with allure.step("引数なしで publish する"):
        result = env.run("publish")
    with allure.step("終了コードと build の引数を確かめる"):
        assert result.returncode == 0, result.stderr
        assert _build_args(env) == [
            "--workspace-folder", str(env.work),
            "--image-name", f"{_REPO}:def-{env.key}",
            "--cache-from", f"{_REPO}:latest",
        ]  # fmt: skip


@allure.title("push しない publish は、タグがすでに存在しても build する")
def test_publish_without_push_builds_even_if_tag_exists(env: Env) -> None:
    """タグが存在する状態で、`--push` を付けずに `publish` を実行するテストです。`docker buildx` で存在を確認せず、`devcontainer build` に `--output` を渡さないことを確認します。"""
    with allure.step("push なしの publish が、tag があっても build することを確かめる"):
        assert env.run("publish", STUB_TAG_EXISTS_RC="0").returncode == 0
        assert env.calls_of("docker buildx") == []
        assert "--output" not in _build_args(env)


@allure.title("publish --push は、zstd で圧縮する registry の出力を指定する")
def test_publish_push_uses_zstd_registry_output(env: Env) -> None:
    """`publish --push` を実行するテストです。`--output` に、zstd で圧縮する registry の指定を渡し、`--image-name` が 1 つだけであることを確認します。"""
    with allure.step("push 付きの publish が zstd の registry 出力を使うことを確かめる"):
        assert env.run("publish", "--push").returncode == 0
        args = _build_args(env)
        assert args[args.index("--output") + 1] == _ZSTD
        assert args.count("--image-name") == 1


@allure.title("publish --push は、タグがすでに存在すると build しない")
def test_publish_push_skips_build_when_tag_exists(env: Env) -> None:
    """`docker buildx imagetools inspect` が成功する（タグが存在する）場合のテストです。終了コード 0 で終わり、`already exists` を出力して、`devcontainer build` を呼ばないことを確認します。"""
    with allure.step("tag が既にある状態で push 付きの publish をする"):
        result = env.run("publish", "--push", STUB_TAG_EXISTS_RC="0")
    with allure.step("終了コードと build を飛ばすことと buildx の呼び出しを確かめる"):
        assert result.returncode == 0, result.stderr
        assert "already exists" in result.stdout
        assert env.calls_of("devcontainer build") == []
        assert env.calls_of("docker buildx") == [
            f"docker buildx imagetools inspect {_REPO}:def-{env.key}"
        ]


@allure.title("publish --latest は、タグがすでに存在しても build し、latest のタグも付ける")
def test_publish_latest_builds_even_if_tag_exists(env: Env) -> None:
    """タグが存在する状態で、`publish --push --latest` を実行するテストです。`devcontainer build` を呼び、`--image-name` を 2 つ（`latest` を含む）と `--output` を渡すことを確認します。"""
    with allure.step("latest 付きの publish が、tag があっても build することを確かめる"):
        assert env.run("publish", "--push", "--latest", STUB_TAG_EXISTS_RC="0").returncode == 0
        args = _build_args(env)
        assert args.count("--image-name") == 2
        assert f"{_REPO}:latest" in args
        assert "--output" in args


@allure.title("publish --no-cache は、build に --no-cache を渡す")
def test_publish_no_cache_is_passed(env: Env) -> None:
    """`publish --push --latest --no-cache` を実行するテストです。`devcontainer build` の引数に `--no-cache` が含まれることを確認します。"""
    with allure.step("no-cache の指定が build に渡ることを確かめる"):
        assert env.run("publish", "--push", "--latest", "--no-cache").returncode == 0
        assert "--no-cache" in _build_args(env)


@allure.title("publish に未知の引数を渡すと、終了コード 2 で終わり、build しない")
def test_publish_rejects_unknown_argument(env: Env) -> None:
    """`publish --bogus` を実行するテストです。終了コード 2 で終わり、`devcontainer build` を呼ばないことを確認します。"""
    with allure.step("未知の引数で publish する"):
        result = env.run("publish", "--bogus")
    with allure.step("終了コード 2 と build を呼ばないことを確かめる"):
        assert result.returncode == 2
        assert env.calls_of("devcontainer build") == []


@allure.title("publish --base に値を渡さないと、終了コード 2 で終わり、build しない")
def test_publish_base_without_value_exits_2(env: Env) -> None:
    """値を付けずに `publish --base` を実行するテストです。終了コード 2 で終わり、`--base` に値が必要である旨を出力して、`devcontainer build` を呼ばないことを確認します。"""
    with allure.step("--base に値を付けずに publish する"):
        result = env.run("publish", "--base")
    with allure.step("終了コード 2 とエラーの出力と build を呼ばないことを確かめる"):
        assert result.returncode == 2
        assert "--base に値が要る" in result.stderr
        assert env.calls_of("devcontainer build") == []


@allure.title("publish は、build が失敗すると、終了コード 1 で終わる")
def test_publish_propagates_build_failure(env: Env) -> None:
    """`devcontainer build` が失敗する場合の、`publish --push` のテストです。終了コード 1 で終わることを確認します。"""
    with allure.step("build が失敗すると publish の終了コードが 1 になることを確かめる"):
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


@allure.title("publish --base は、base との merge 後の key が異なると、警告を出力する")
def test_publish_warns_when_merged_key_differs(env: Env, git: Callable[..., object]) -> None:
    """`main` の側で `Dockerfile` が変わっている状態で、`publish --base main` を実行するテストです。終了コード 0 で終わり、`origin/main` との merge 後の key が異なる旨の警告を出力して、build を 1 回呼ぶことを確認します。"""
    _drift_setup(env, git, drift=True)
    result = env.run("publish", "--base", "main")
    with allure.step("警告が出て build が 1 回呼ばれることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert "::warning::origin/main との merge 後の key" in result.stdout
        assert len(env.calls_of("devcontainer build")) == 1


@allure.title("publish --base は、base との merge 後の key が一致すると、警告を出力しない")
def test_publish_is_silent_when_merged_key_matches(env: Env, git: Callable[..., object]) -> None:
    """`main` の側で、イメージに入らないファイルだけが変わっている状態で、`publish --base main` を実行するテストです。終了コード 0 で終わり、警告を出力しないことを確認します。"""
    _drift_setup(env, git, drift=False)
    result = env.run("publish", "--base", "main")
    with allure.step("警告が出ないことを確かめる"):
        assert result.returncode == 0, result.stderr
        assert "::warning::" not in result.stdout


@allure.title("publish --base の ref が存在しないと、key のずれの確認を飛ばして build する")
def test_publish_skips_drift_check_when_base_ref_is_missing(env: Env) -> None:
    """存在しない ref を `--base` に指定して `publish` を実行するテストです。終了コード 0 で終わり、警告を出力せず、key のずれの確認を飛ばす旨を出力して、build を 1 回呼ぶことを確認します。"""
    with allure.step("存在しない base の ref で publish する"):
        result = env.run("publish", "--base", "nonexistent")
    with allure.step("key のずれの確認を飛ばして build することを確かめる"):
        assert result.returncode == 0, result.stderr
        assert "::warning::" not in result.stdout
        assert "key のずれの確認を飛ばす" in result.stdout
        assert len(env.calls_of("devcontainer build")) == 1
