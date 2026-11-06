"""session-start-common.sh のユニットテスト（test_session_start_common.bats から移植）。

次の 3 つを検証する。
環境変数の永続化（CLAUDE_ENV_FILE 経由）、flock 排他制御、.pecot/.gitignore 生成。
flock 系はバックグラウンドプロセスを保持するため、run_script fixture（capture 待ち切り型）ではなく subprocess.Popen を直接管理する。
lock ファイルは tmp_path 由来にする（固定パスは xdist 並列で競合する）。
終了時に確実に terminate/wait する。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest


@pytest.fixture
def common_script(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "lib" / "session-start-common.sh"


@pytest.fixture
def env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """CLAUDE_ENV_FILE のモック（空ファイルを作成して env を向ける）。"""
    path = tmp_path / "env_file"
    path.touch()
    monkeypatch.setenv("CLAUDE_ENV_FILE", str(path))
    return path


# CLAUDE_ENV_FILE テスト。


def _run_common_script(common_script: Path, project_dir: Path) -> subprocess.CompletedProcess:
    """session-start-common.sh を CLAUDE_PROJECT_DIR を向けて実行する。

    git-sync は pull 失敗時も `|| true` で exit 0 を保つため、テストは副作用
    （CLAUDE_ENV_FILE への追記等）だけを検証する。
    """
    return subprocess.run(
        ["bash", str(common_script)],
        capture_output=True,
        text=True,
        timeout=25,
        env={
            **os.environ,
            "CLAUDE_PROJECT_DIR": str(project_dir),
            "PECOT_ORIGINAL_CLAUDE_PROJECT_DIR": str(project_dir),
        },
    )


def test_env_file_gets_session_project_dir(common_script, env_file, tmp_path):
    # ディスパッチャ経由で session-project-dir.sh が PECOT_SESSION_PROJECT_DIR を追記する。
    project_dir = tmp_path / "proj"
    project_dir.mkdir(parents=True)
    subprocess.run(["git", "-C", str(project_dir), "init", "--quiet"], check=True)

    _run_common_script(common_script, project_dir)

    assert f"export PECOT_SESSION_PROJECT_DIR={project_dir.resolve()}\n" in env_file.read_text()


def test_no_write_when_env_file_unset(common_script, env_file, monkeypatch, tmp_path):
    # CLAUDE_ENV_FILE 未設定なら session-project-dir.sh は書き込まない（空ファイルのまま）。
    monkeypatch.delenv("CLAUDE_ENV_FILE", raising=False)
    project_dir = tmp_path / "proj"
    project_dir.mkdir(parents=True)
    subprocess.run(["git", "-C", str(project_dir), "init", "--quiet"], check=True)

    _run_common_script(common_script, project_dir)

    assert env_file.read_text() == ""


# flock 排他制御テスト。


# これらの flock テストは、`flock` コマンド自体の相互排他セマンティクスのみを検証する。
# session-start-common.sh 本体の lock 配線は対象外。
# 対象外の配線は、_LOCK_ID 由来のパス生成と、exec 9> / flock -n 9 による多重実行スキップ。
# 本体配線の通し検証は、test_session_start_common_lock_skips_concurrent_run が担う。


def test_flock_acquires_lock(tmp_path):
    """flock コマンド単体の相互排他のみ検証（本体 _LOCK_ID 配線は対象外）。"""
    lock_dir = tmp_path / "tmp"
    lock_dir.mkdir(parents=True)
    lock_file = lock_dir / ".session-start-common.lock"

    result = subprocess.run(
        ["bash", "-c", f'exec 9>"{lock_file}" && flock -n 9 && echo ok'],
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "ok"


def test_flock_second_concurrent_acquire_fails(tmp_path):
    """flock コマンド単体の相互排他のみ検証（本体 _LOCK_ID 配線は対象外）。"""
    lock_dir = tmp_path / "tmp"
    lock_dir.mkdir(parents=True)
    lock_file = lock_dir / ".session-start-common.lock"
    ready_file = lock_dir / ".holder-ready"

    # 1 番目のプロセスがロックを保持（バックグラウンド）。
    # capture 待ち切りにせず Popen で保持し、終了時に確実に止める。
    # holder は、flock 取得 *後* に ready ファイルを touch する。
    # 待機側は、その出現を polling する。
    # 待機側が自前で flock -n を probe すると、holder と probe がレースして、稀に probe が先にロックを掴む。
    # すると holder が早期終了する（自前 probe を廃止した経緯）。
    holder = subprocess.Popen(
        ["bash", "-c", f'exec 9>"{lock_file}" && flock -n 9 && touch "{ready_file}" && sleep 5'],
    )
    try:
        # holder がロックを取得し ready ファイルを置くまで待つ。
        _wait_until_ready(ready_file, holder)

        # 2 番目のプロセスはロック取得に失敗するはず。
        result = subprocess.run(
            ["bash", "-c", f'exec 9>"{lock_file}" && flock -n 9'],
            capture_output=True,
            text=True,
            timeout=25,
        )
        assert result.returncode != 0
    finally:
        holder.terminate()
        holder.wait()


def test_flock_reacquire_after_release(tmp_path):
    """flock コマンド単体の相互排他のみ検証（本体 _LOCK_ID 配線は対象外）。"""
    lock_dir = tmp_path / "tmp"
    lock_dir.mkdir(parents=True)
    lock_file = lock_dir / ".session-start-common.lock"

    # ロック取得 → 解放（サブシェルが完了すれば自動解放）。
    subprocess.run(
        ["bash", "-c", f'exec 9>"{lock_file}" && flock -n 9'],
        capture_output=True,
        text=True,
        timeout=25,
    )

    # 解放後は再取得できる。
    result = subprocess.run(
        ["bash", "-c", f'exec 9>"{lock_file}" && flock -n 9 && echo ok'],
        capture_output=True,
        text=True,
        timeout=25,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "ok"


def _wait_until_ready(
    ready_file: Path,
    holder: subprocess.Popen,
    timeout: float = 10.0,
) -> None:
    """holder プロセスがロック取得後に置く ready ファイルの出現をポーリングで待つ。

    待機側が自前で `flock -n` を probe すると、holder とロックを取り合うレースになる。
    そのため probe は廃止し、holder 自身が flock 取得直後に touch する ready ファイルの出現だけを監視する。
    bats の固定 sleep 0.2 より決定論的で、xdist 並列でも安定する。
    holder の bash が cold start で flock 取得に至るまでの遅延は、xdist 高負荷下で 1 秒を超えうる。
    そのため、wall-clock の timeout で待つ（固定回数だと負荷で取りこぼす）。
    holder が flock を取れずに早期終了した場合は、poll() で検知して即座に失敗させる（無駄な待機を避ける）。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if ready_file.exists():
            return
        if holder.poll() is not None:
            raise AssertionError(
                f"holder プロセスがロック取得前に終了した (rc={holder.returncode})"
            )
        time.sleep(0.02)
    raise AssertionError("ロックが取得されなかった")


def _lock_file(tmpdir: Path, project_dir: Path) -> Path:
    """本体と同じ規則（PROJECT_DIR の cksum）で lock のパスを再現する。"""
    cksum = subprocess.run(
        ["cksum"], input=str(project_dir), capture_output=True, text=True, check=True
    )
    return tmpdir / f".session-start-common-{cksum.stdout.split()[0]}.lock"


def test_session_start_common_lock_skips_concurrent_run(common_script, tmp_path, monkeypatch):
    """本体の lock 配線（_LOCK_ID 由来パス + exec 9> / flock -n 9）を通しで検証する。

    別プロセスが本体と同一の lock を保持している間は、session-start-common.sh は flock -n の取得に失敗する。
    失敗したら exit 0 で即スキップし、.gitignore 再生成等の本処理を行わない。
    lock パスは、TMPDIR 配下に `_LOCK_ID`（PROJECT_DIR の cksum）で生成される。
    そのため、テストは同じ規則でパスを再現して、holder に先取りさせる。
    """
    project_dir = tmp_path / "proj"
    (project_dir / ".pecot").mkdir(parents=True)
    subprocess.run(["git", "-C", str(project_dir), "init", "--quiet"], check=True)
    # 本体と同じ TMPDIR 規則で lock パスを再現する。
    tmpdir = tmp_path / "tmpdir"
    tmpdir.mkdir()
    monkeypatch.setenv("TMPDIR", str(tmpdir))
    lock_file = _lock_file(tmpdir, project_dir)
    ready_file = tmpdir / ".holder-ready"

    holder = subprocess.Popen(
        ["bash", "-c", f'exec 9>"{lock_file}" && flock -n 9 && touch "{ready_file}" && sleep 5'],
    )
    try:
        _wait_until_ready(ready_file, holder)
        gitignore = project_dir / ".pecot" / ".gitignore"
        assert not gitignore.exists()

        result = subprocess.run(
            ["bash", str(common_script)],
            capture_output=True,
            text=True,
            timeout=25,
            env={
                **os.environ,
                "CLAUDE_PROJECT_DIR": str(project_dir),
                "TMPDIR": str(tmpdir),
            },
        )
        # lock 取得失敗 → exit 0 でスキップ、.gitignore 再生成は動かない。
        assert result.returncode == 0
        assert not gitignore.exists()
    finally:
        holder.terminate()
        holder.wait()


# flock が無い環境（標準の macOS）。


@pytest.fixture
def path_without_flock(tmp_path: Path) -> str:
    """PATH 上の実行ファイルを、flock だけ除いて symlink した bin ディレクトリ。"""
    bin_dir = tmp_path / "bin-no-flock"
    bin_dir.mkdir()
    for entry in os.environ["PATH"].split(os.pathsep):
        if not os.path.isdir(entry):
            continue
        for name in os.listdir(entry):
            target = Path(entry) / name
            if name != "flock" and os.access(target, os.X_OK) and not (bin_dir / name).exists():
                (bin_dir / name).symlink_to(target)
    assert shutil.which("flock", path=str(bin_dir)) is None
    return str(bin_dir)


def _run_common_without_flock(
    common_script: Path, project_dir: Path, tmpdir: Path, path: str, **extra: str
) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(common_script)],
        capture_output=True,
        text=True,
        timeout=25,
        env={
            **os.environ,
            "PATH": path,
            "CLAUDE_PROJECT_DIR": str(project_dir),
            "TMPDIR": str(tmpdir),
            **extra,
        },
    )


def test_subscripts_run_without_flock(common_script, tmp_path, path_without_flock):
    """flock が PATH に無くても、サブスクリプトが動き、終了後にロックが残らない。"""
    project_dir = tmp_path / "proj"
    (project_dir / ".pecot").mkdir(parents=True)
    subprocess.run(["git", "-C", str(project_dir), "init", "--quiet"], check=True)
    tmpdir = tmp_path / "tmpdir"
    tmpdir.mkdir()
    env_file = tmp_path / "claude_env"
    env_file.touch()
    result = _run_common_without_flock(
        common_script,
        project_dir,
        tmpdir,
        path_without_flock,
        CLAUDE_ENV_FILE=str(env_file),
        PECOT_ORIGINAL_CLAUDE_PROJECT_DIR=str(project_dir),
    )

    assert result.returncode == 0
    assert (project_dir / ".pecot" / ".gitignore").is_file()
    assert "export PECOT_SESSION_PROJECT_DIR=" in env_file.read_text()
    assert list(tmpdir.iterdir()) == []  # flock が無いときはロックを掛けない


# .pecot/.gitignore 生成の配線テスト。


def test_no_pecot_dir_is_not_created_when_absent(common_script, tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    project_dir.mkdir(parents=True)
    subprocess.run(["git", "-C", str(project_dir), "init", "--quiet"], check=True)

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project_dir))
    result = subprocess.run(
        ["bash", str(common_script)],
        capture_output=True,
        text=True,
        timeout=25,
    )

    # git-sync は pull 失敗時も || true で exit 0 を維持するため returncode 0 は安定する。
    assert result.returncode == 0
    # 新規作成は利用検知側（pecot-dir-init.sh）に一本化（#662）。
    # session-start は .pecot 不在リポに .pecot を作らない。
    assert not (project_dir / ".pecot").exists()


def test_gitignore_written_when_pecot_exists(common_script, tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    (project_dir / ".pecot").mkdir(parents=True)
    subprocess.run(["git", "-C", str(project_dir), "init", "--quiet"], check=True)

    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project_dir))
    subprocess.run(
        ["bash", str(common_script)],
        capture_output=True,
        text=True,
        timeout=25,
    )

    # git pull 失敗等で出力や exit code は問わない。.gitignore 生成の配線のみ検証する。
    gitignore = project_dir / ".pecot" / ".gitignore"
    assert gitignore.is_file()
    lines = gitignore.read_text().splitlines()
    assert lines[lines.index("*") + 1] == "!/config/"
    assert "!/config/projects/*.json" in lines
