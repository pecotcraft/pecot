"""nx-cache-server.mjs のテスト。

nx 公式の self-hosted HTTP リモートキャッシュの口（GET/PUT /v1/cache/{hash}）を、実サーバに HTTP で当てて確かめる。
さらに実 nx を一時リポで動かし、1 回目の PUT と、ローカルを消した 2 回目のリモートからの再生を確かめる。
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SERVER = _REPO_ROOT / ".githooks" / "ci" / "nx-cache-server.mjs"
_TOKEN = "secret-token"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node が無い")


class _Server:
    def __init__(self, proc: subprocess.Popen, dir: Path, port: int) -> None:
        self.proc = proc
        self.dir = dir
        self.url = f"http://127.0.0.1:{port}"

    def request(
        self, method: str, path: str, body: bytes | None = None, token: str | None = _TOKEN
    ) -> tuple[int, bytes]:
        req = urllib.request.Request(self.url + path, data=body, method=method)
        if token is not None:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def stop(self) -> str:
        self.proc.send_signal(signal.SIGTERM)
        out, _ = self.proc.communicate(timeout=10)
        return out


def _start(dir: Path, port_file: Path, used_file: Path | None = None) -> _Server:
    extra = [f"--used-file={used_file}"] if used_file else []
    proc = subprocess.Popen(
        ["node", str(_SERVER), f"--dir={dir}", f"--port-file={port_file}", *extra],
        env={**os.environ, "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN": _TOKEN},
        stdout=subprocess.PIPE,
        text=True,
    )
    for _ in range(100):
        if port_file.exists() and port_file.read_text().strip():
            return _Server(proc, dir, int(port_file.read_text()))
        time.sleep(0.1)
    proc.kill()
    raise AssertionError("サーバが port を書かなかった")


@pytest.fixture
def server(tmp_path: Path) -> Iterator[_Server]:
    srv = _start(tmp_path / "store", tmp_path / "port")
    yield srv
    if srv.proc.poll() is None:
        srv.proc.kill()
        srv.proc.communicate()


def test_get_miss_is_404(server: _Server) -> None:
    assert server.request("GET", "/v1/cache/abc123")[0] == 404


def test_put_then_get_returns_stored_bytes(server: _Server) -> None:
    assert server.request("PUT", "/v1/cache/abc123", b"tarball")[0] == 200
    status, body = server.request("GET", "/v1/cache/abc123")
    assert (status, body) == (200, b"tarball")
    assert (server.dir / "abc123.tar.gz").read_bytes() == b"tarball"
    assert [p.name for p in server.dir.iterdir()] == ["abc123.tar.gz"]


def test_put_existing_is_409_and_keeps_content(server: _Server) -> None:
    server.request("PUT", "/v1/cache/abc123", b"first")
    assert server.request("PUT", "/v1/cache/abc123", b"second")[0] == 409
    assert server.request("GET", "/v1/cache/abc123")[1] == b"first"


@pytest.mark.parametrize("token", [None, "wrong"])
def test_bad_token_is_401(server: _Server, token: str | None) -> None:
    assert server.request("GET", "/v1/cache/abc123", token=token)[0] == 401
    assert server.request("PUT", "/v1/cache/abc123", b"x", token=token)[0] == 401
    assert not list(server.dir.iterdir())


@pytest.mark.parametrize("bad", ["a.b", "..", "a%2Fb", "a-b"])
def test_non_alphanumeric_hash_is_400(server: _Server, bad: str) -> None:
    assert server.request("GET", f"/v1/cache/{bad}")[0] == 400
    assert server.request("PUT", f"/v1/cache/{bad}", b"x")[0] == 400
    assert not list(server.dir.iterdir())


def test_summary_line_on_sigterm(server: _Server) -> None:
    server.request("PUT", "/v1/cache/abc123", b"x")
    server.request("GET", "/v1/cache/abc123")
    server.request("GET", "/v1/cache/zzz")
    assert "GET hit=1 miss=1 PUT=1 conflict=0 保存=1" in server.stop()


def test_other_methods_are_405(server: _Server) -> None:
    for method in ("POST", "DELETE"):
        assert (
            server.request(method, "/v1/cache/abc123", b"x" if method == "POST" else None)[0] == 405
        )
    assert not list(server.dir.iterdir())


@pytest.mark.parametrize("path", ["/", "/v1/other/abc", "/v1/cache/", "/v1/cache/a/b"])
def test_other_paths_are_404(server: _Server, path: str) -> None:
    assert server.request("GET", path)[0] == 404
    assert server.request("PUT", path, b"x")[0] == 404


def test_concurrent_puts_one_wins(server: _Server) -> None:
    codes: list[int] = []
    body = b"x" * 1_000_000

    def put() -> None:
        codes.append(server.request("PUT", "/v1/cache/race", body)[0])

    threads = [threading.Thread(target=put) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes) == [200] + [409] * 7
    assert [p.name for p in server.dir.iterdir()] == ["race.tar.gz"]


def test_aborted_put_leaves_no_temp_file(server: _Server) -> None:
    port = int(server.url.rsplit(":", 1)[1])
    with socket.create_connection(("127.0.0.1", port)) as s:
        s.sendall(
            f"PUT /v1/cache/cut HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {_TOKEN}\r\n"
            "Content-Length: 100\r\n\r\nshort".encode()
        )
    time.sleep(1)
    assert not list(server.dir.iterdir())


@pytest.mark.skipif(os.geteuid() == 0, reason="root は書き込み権限を無視する")
def test_unwritable_store_is_500_not_409(server: _Server) -> None:
    server.dir.chmod(0o500)
    try:
        assert server.request("PUT", "/v1/cache/abc123", b"x")[0] == 500
    finally:
        server.dir.chmod(0o700)


def test_used_file_lists_hits_and_puts_only(tmp_path: Path) -> None:
    used = tmp_path / "used.txt"
    srv = _start(tmp_path / "store", tmp_path / "port", used)
    (srv.dir / "old1.tar.gz").write_bytes(b"o")
    (srv.dir / "old2.tar.gz").write_bytes(b"o")
    srv.request("GET", "/v1/cache/old1")
    srv.request("GET", "/v1/cache/old1")
    srv.request("GET", "/v1/cache/missing")
    srv.request("PUT", "/v1/cache/new1", b"n")
    srv.request("PUT", "/v1/cache/new1", b"n")
    srv.request("PUT", "/v1/cache/old2", b"n")
    srv.stop()
    assert sorted(used.read_text().splitlines()) == ["new1", "old1"]
    assert not list(tmp_path.glob("used.txt.tmp"))


def test_no_used_file_without_arg(server: _Server, tmp_path: Path) -> None:
    server.request("PUT", "/v1/cache/abc123", b"x")
    server.stop()
    assert not any(p.name.startswith("used") for p in tmp_path.iterdir())


def test_sigterm_exits_when_store_is_gone(server: _Server) -> None:
    shutil.rmtree(server.dir)
    server.stop()
    assert server.proc.returncode == 0


def test_missing_args_exit_2() -> None:
    result = subprocess.run(["node", str(_SERVER)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 2


def test_real_nx_puts_then_replays_from_remote(tmp_path: Path, git_repo, git) -> None:
    nx_bin = _REPO_ROOT / "node_modules" / ".bin" / "nx"
    if not nx_bin.exists():
        pytest.skip("node_modules/.bin/nx が無い（npm ci 前）")
    repo = git_repo("nxrepo", initial_branch="main")
    (repo / "package.json").write_text('{"name": "fx", "private": true}\n')
    (repo / "nx.json").write_text(json.dumps({"targetDefaults": {"test": {"cache": True}}}))
    (repo / "fx").mkdir()
    (repo / "fx" / "project.json").write_text(
        json.dumps(
            {
                "name": "fx",
                "targets": {
                    "test": {"executor": "nx:run-commands", "options": {"command": "echo hi"}}
                },
            }
        )
    )
    (repo / "fx" / "src.txt").write_text("v0\n")
    (repo / ".gitignore").write_text("node_modules/\n.nx/\n")
    (repo / "node_modules").symlink_to(_REPO_ROOT / "node_modules")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "chore: init")

    srv = _start(tmp_path / "store", tmp_path / "port")
    try:

        def run_nx(state: str) -> str:
            env = {
                **os.environ,
                "NX_DAEMON": "false",
                "NX_CACHE_DIRECTORY": str(tmp_path / state / "cache"),
                "NX_WORKSPACE_DATA_DIRECTORY": str(tmp_path / state / "data"),
                "NX_SELF_HOSTED_REMOTE_CACHE_SERVER": srv.url,
                "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN": _TOKEN,
            }
            env.pop("NX_SKIP_NX_CACHE", None)
            result = subprocess.run(
                [str(nx_bin), "run", "fx:test", "--outputStyle=static"],
                cwd=repo,
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
            )
            assert result.returncode == 0, result.stdout + result.stderr
            return result.stdout + result.stderr

        run_nx("first")
        deadline = time.time() + 15
        while time.time() < deadline and not list((tmp_path / "store").glob("*.tar.gz")):
            time.sleep(0.2)
        assert list((tmp_path / "store").glob("*.tar.gz")), "1 回目の結果が PUT されていない"

        second = run_nx("second")
        assert "remote cache" in second, second
    finally:
        srv.stop()
