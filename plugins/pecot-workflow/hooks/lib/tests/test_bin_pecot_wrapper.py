"""bin/pecot wrapper の動作テスト（データ置き場の venv 方式、#1230）。

uv をモックして、wrapper が行う一連の処理を検証する。
モックでは、`uv sync` が UV_PROJECT_ENVIRONMENT に `bin/python` と `bin/pecot` の stub を作る。
検証する処理は次の順に並ぶ。
データ置き場の解決（CLAUDE_PLUGIN_DATA → PLUGIN_DATA → 既定の場所）→ ハッシュ計算 → ステージからの venv 作成。
続けて、完成印 → current 切替 → 世代削除 → exec。
実 uv の起動は test_entrypoint.py 側の範囲。

wrapper はリポ実体ではなく tmp に複製した「隔離ツリー」から起動する。隔離ツリーは
bin/pecot・bin/_lib.sh・plugin.json と、cli/ の最小 stub（pyproject.toml・uv.lock・ソース）を持つ。
"""

from __future__ import annotations

import fcntl
import os
import shutil
import subprocess
import threading
from pathlib import Path

import pytest

# CLAUDE_PLUGIN_DATA は消さない。
# conftest.py の autouse が一時ディレクトリへ向けており、隔離を兼ねる。
# 置き場を渡し忘れたテストが、実ホームの既定の場所（~/.local/share/pecot/pecot-workflow）へ書き込まないようにするため。
# 「変数なし」を試すテストだけが、値に None を渡して外す。
# XDG_DATA_HOME は付け替えない。
ENV_KEYS_CLEARED = (
    "PLUGIN_DATA",
    "CLAUDE_PLUGIN_ROOT",
    "PECOT_BOOTSTRAP_SKIP",
    "VIRTUAL_ENV",
    "UV_NO_SYNC",
    "UV_PROJECT_ENVIRONMENT",
)

MSG_NO_HOME = "pecot-workflow: cannot decide the data directory because HOME is unset"
BUILDING = "pecot: building"
INSTALLING = "pecot: installing dependencies"


@pytest.fixture
def plugin_root(tmp_path: Path, project_root: Path) -> Path:
    """実 wrapper・実 _lib.sh・実 plugin.json と cli/ の stub を持つ隔離プラグインルート。"""
    real = project_root / "plugins" / "pecot-workflow"
    root = tmp_path / "iso" / "plugins" / "pecot-workflow"
    (root / "bin").mkdir(parents=True)
    (root / ".claude-plugin").mkdir(parents=True)
    for name in ("pecot", "_lib.sh"):
        (root / "bin" / name).write_bytes((real / "bin" / name).read_bytes())
    (root / "bin" / "pecot").chmod(0o755)
    (root / ".claude-plugin" / "plugin.json").write_text(
        '{ "name": "pecot-w", "version": "1.0.0" }\n'
    )
    cli = root / "cli"
    (cli / "commands").mkdir(parents=True)
    (cli / "pyproject.toml").write_text('[project]\nname = "pecot"\n')
    (cli / "uv.lock").write_text("lock-v1\n")
    (cli / "__init__.py").write_text("")
    (cli / "commands" / "main.py").write_text("print('v1')\n")
    # 本体直下に残り得る生成物。ステージには複製されず、src-hash にも入らない。
    (cli / "__pycache__").mkdir()
    (cli / "__pycache__" / "x.pyc").write_bytes(b"\0")
    (cli / "pecot.egg-info").mkdir()
    (cli / "pecot.egg-info" / "PKG-INFO").write_text("x")
    return root


@pytest.fixture
def wrapper(plugin_root: Path) -> Path:
    return plugin_root / "bin" / "pecot"


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    path = tmp_path / "plugin-data"
    path.mkdir()
    return path


@pytest.fixture
def mock_uv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """uv をモックして PATH 先頭へ置く。記録は `<tmp>/uv.log`（1 呼び出し 1 行 + env）に残す。

    UV_FAIL=1 なら sync が失敗する。
    UV_DELAY（秒）で sync に時間をかける。
    sync が作る `bin/pecot` は、次の値を 1 行ずつ stdout に出す。
    出す値は、受けた引数・CLAUDE_PLUGIN_ROOT・CLAUDE_PLUGIN_DATA・PECOT_BOOTSTRAP_SKIP。
    """
    mock_bin = tmp_path / "mock-bin"
    mock_bin.mkdir()
    log = tmp_path / "uv.log"
    uv = mock_bin / "uv"
    uv.write_text(
        f"""#!/usr/bin/env bash
{{
  echo "ARGS:$*"
  echo "ENV:UV_PROJECT_ENVIRONMENT=${{UV_PROJECT_ENVIRONMENT:-}}"
  echo "ENV:VIRTUAL_ENV=${{VIRTUAL_ENV-<unset>}}"
  echo "ENV:UV_NO_SYNC=${{UV_NO_SYNC-<unset>}}"
}} >> "{log}"
[ "$1" = sync ] || exit 0
stage=""
while [ $# -gt 0 ]; do
  [ "$1" = --project ] && stage="$2"
  shift
done
ls -A "$stage" | sed 's/^/STAGE:/' >> "{log}"
sleep "${{UV_DELAY:-0}}"
[ "${{UV_FAIL:-}}" = 1 ] && exit 1
mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
printf '#!/bin/sh\\nexit 0\\n' > "$UV_PROJECT_ENVIRONMENT/bin/python"
cat > "$UV_PROJECT_ENVIRONMENT/bin/pecot" <<'STUB'
#!/usr/bin/env bash
echo "argv:$*"
echo "root:${{CLAUDE_PLUGIN_ROOT:-}}"
echo "data:${{CLAUDE_PLUGIN_DATA:-}}"
echo "skip:${{PECOT_BOOTSTRAP_SKIP-<unset>}}"
echo "self:$0"
STUB
chmod +x "$UV_PROJECT_ENVIRONMENT/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/pecot"
"""
    )
    uv.chmod(0o755)
    monkeypatch.setenv("PATH", f"{mock_bin}:{os.environ.get('PATH', '')}")
    return log


def _env(extra: dict[str, str | None]) -> dict[str, str]:
    merged = {k: v for k, v in os.environ.items() if k not in ENV_KEYS_CLEARED}
    for key, value in extra.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


def _run(
    wrapper: Path, args: list[str], env: dict[str, str | None]
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(wrapper), *args],
        capture_output=True,
        text=True,
        timeout=25,
        env=_env(env),
        check=False,
    )


def _stderr_lines(result: subprocess.CompletedProcess[str]) -> list[str]:
    return [line for line in result.stderr.splitlines() if line]


def _counts(result: subprocess.CompletedProcess[str]) -> tuple[int, int]:
    """(install 行数, build 行数)。"""
    lines = _stderr_lines(result)
    return lines.count(INSTALLING), lines.count(BUILDING)


def _venv_dirs(data_dir: Path) -> list[str]:
    venv = data_dir / "venv"
    if not venv.is_dir():
        return []
    return sorted(
        p.name for p in venv.iterdir() if p.is_dir() and not p.is_symlink() and p.name[0] != "."
    )


def _current(data_dir: Path) -> str:
    return os.readlink(data_dir / "venv" / "current")


def _snapshot(root: Path) -> dict[str, float]:
    return {str(p): p.lstat().st_mtime_ns for p in sorted(root.rglob("*"))}


def _stdout_map(result: subprocess.CompletedProcess[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition(":")
        out[key] = value
    return out


# 解決順と停止。


def test_prefers_claude_plugin_data_over_plugin_data(wrapper, mock_uv, data_dir, tmp_path):
    other = tmp_path / "other-data"
    other.mkdir()
    result = _run(
        wrapper,
        ["--version"],
        {"CLAUDE_PLUGIN_DATA": str(data_dir), "PLUGIN_DATA": str(other)},
    )
    assert result.returncode == 0, result.stderr
    assert _venv_dirs(data_dir) != []
    assert _venv_dirs(other) == []


def test_falls_back_to_plugin_data(wrapper, mock_uv, data_dir):
    result = _run(
        wrapper, ["--version"], {"CLAUDE_PLUGIN_DATA": None, "PLUGIN_DATA": str(data_dir)}
    )
    assert result.returncode == 0, result.stderr
    assert len(_venv_dirs(data_dir)) == 1


@pytest.mark.parametrize(
    "invalid",
    ["", "relative/dir", "${CLAUDE_PLUGIN_DATA}", "${PLUGIN_DATA}/x"],
    ids=["empty", "relative", "unexpanded", "unexpanded-prefix"],
)
def test_invalid_value_skips_to_next_candidate(wrapper, mock_uv, data_dir, invalid):
    result = _run(
        wrapper,
        ["--version"],
        {"CLAUDE_PLUGIN_DATA": invalid, "PLUGIN_DATA": str(data_dir)},
    )
    assert result.returncode == 0, result.stderr
    assert len(_venv_dirs(data_dir)) == 1


def test_nonexistent_absolute_dir_is_created_and_used(wrapper, mock_uv, tmp_path):
    """クライアントの値は実在しなくても作って使う（既定の場所へ落とすと置き場が 2 か所に割れる）。"""
    data = tmp_path / "not-yet" / "created" / "data"
    result = _run(wrapper, ["--version"], {"CLAUDE_PLUGIN_DATA": str(data)})
    assert result.returncode == 0, result.stderr
    assert len(_venv_dirs(data)) == 1


@pytest.mark.parametrize("suffix", ["\n", "\r\n", "\r"], ids=["lf", "crlf", "cr"])
def test_trailing_newline_and_cr_are_tolerated(wrapper, mock_uv, data_dir, suffix):
    result = _run(wrapper, ["--version"], {"CLAUDE_PLUGIN_DATA": f"{data_dir}{suffix}"})
    assert result.returncode == 0, result.stderr
    assert len(_venv_dirs(data_dir)) == 1


# 既定の場所（クライアントが置き場を渡さない起動。Bash から呼ぶ pecot）。

_NO_CLIENT_DATA: dict[str, str | None] = {"CLAUDE_PLUGIN_DATA": None, "PLUGIN_DATA": None}


def test_default_location_uses_valid_xdg_data_home(wrapper, mock_uv, tmp_path):
    xdg = tmp_path / "xdg-share"
    home = tmp_path / "home"
    home.mkdir()
    result = _run(
        wrapper, ["--version"], {**_NO_CLIENT_DATA, "XDG_DATA_HOME": str(xdg), "HOME": str(home)}
    )
    assert result.returncode == 0, result.stderr
    assert len(_venv_dirs(xdg / "pecot" / "pecot-workflow")) == 1
    assert not (home / ".local").exists(), "有効な XDG_DATA_HOME があれば HOME 側には作らない"


@pytest.mark.parametrize(
    "xdg", ["", "relative/share", "${XDG_DATA_HOME}"], ids=["empty", "relative", "unexpanded"]
)
def test_default_location_falls_back_to_home_when_xdg_is_invalid(wrapper, mock_uv, tmp_path, xdg):
    home = tmp_path / "home"
    home.mkdir()
    result = _run(
        wrapper, ["--version"], {**_NO_CLIENT_DATA, "XDG_DATA_HOME": xdg, "HOME": str(home)}
    )
    assert result.returncode == 0, result.stderr
    assert len(_venv_dirs(home / ".local" / "share" / "pecot" / "pecot-workflow")) == 1


def test_default_location_works_without_home_when_xdg_is_valid(wrapper, mock_uv, tmp_path):
    xdg = tmp_path / "xdg-share"
    result = _run(
        wrapper, ["--version"], {**_NO_CLIENT_DATA, "XDG_DATA_HOME": str(xdg), "HOME": ""}
    )
    assert result.returncode == 0, result.stderr
    assert len(_venv_dirs(xdg / "pecot" / "pecot-workflow")) == 1


@pytest.mark.parametrize(
    "env",
    [
        {**_NO_CLIENT_DATA, "XDG_DATA_HOME": "", "HOME": ""},
        {**_NO_CLIENT_DATA, "XDG_DATA_HOME": "relative/share", "HOME": ""},
        {
            "CLAUDE_PLUGIN_DATA": "relative",
            "PLUGIN_DATA": "${PLUGIN_DATA}",
            "XDG_DATA_HOME": "",
            "HOME": "",
        },
    ],
    ids=["nothing", "relative-xdg", "all-invalid"],
)
def test_stops_with_one_line_only_when_no_home_and_no_valid_xdg(wrapper, plugin_root, mock_uv, env):
    before = _snapshot(plugin_root)
    result = _run(wrapper, ["project", "info"], env)
    assert result.returncode != 0
    assert result.stdout == ""
    lines = _stderr_lines(result)
    assert len(lines) == 1
    assert lines[0].startswith(MSG_NO_HOME)
    assert _snapshot(plugin_root) == before, "本体配下に何も作らない"
    assert not mock_uv.exists(), "uv を呼ばない"


# SKIP


def test_skip_runs_source_tree_venv_without_touching_data_dir(
    wrapper, plugin_root, mock_uv, data_dir
):
    venv_bin = plugin_root / "cli" / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    dev_pecot = venv_bin / "pecot"
    dev_pecot.write_text(
        '#!/usr/bin/env bash\necho "argv:$*"\necho "root:${CLAUDE_PLUGIN_ROOT:-}"\n'
        'echo "skip:${PECOT_BOOTSTRAP_SKIP-<unset>}"\n'
    )
    dev_pecot.chmod(0o755)
    result = _run(
        wrapper,
        ["--version"],
        {"PECOT_BOOTSTRAP_SKIP": "1", "CLAUDE_PLUGIN_DATA": str(data_dir)},
    )
    assert result.returncode == 0, result.stderr
    out = _stdout_map(result)
    assert out["argv"] == "--version"
    assert out["root"] == str(plugin_root)
    assert list(data_dir.iterdir()) == [], "SKIP=1 ではデータ置き場に何も作らない"
    assert not mock_uv.exists()


def test_skip_without_data_dir_still_runs(wrapper, plugin_root, mock_uv):
    """SKIP はデータ置き場に触れない。置き場を決められない環境でも動く。"""
    venv_bin = plugin_root / "cli" / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    dev_pecot = venv_bin / "pecot"
    dev_pecot.write_text('#!/usr/bin/env bash\necho "argv:$*"\n')
    dev_pecot.chmod(0o755)
    result = _run(
        wrapper,
        ["a"],
        {**_NO_CLIENT_DATA, "XDG_DATA_HOME": "", "HOME": "", "PECOT_BOOTSTRAP_SKIP": "1"},
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "argv:a"


def test_skip_without_dev_venv_fails_with_one_line(wrapper, plugin_root, mock_uv, data_dir):
    result = _run(
        wrapper, ["a"], {"PECOT_BOOTSTRAP_SKIP": "1", "CLAUDE_PLUGIN_DATA": str(data_dir)}
    )
    assert result.returncode != 0
    assert result.stdout == ""
    assert len(_stderr_lines(result)) == 1
    assert list(data_dir.iterdir()) == []


# 呼び出しの形（uv sync と exec）。


def test_uv_sync_invocation_and_environment(wrapper, plugin_root, mock_uv, data_dir):
    result = _run(
        wrapper,
        ["issue", "read", "owner/repo#1", "--json"],
        {
            "CLAUDE_PLUGIN_DATA": str(data_dir),
            "VIRTUAL_ENV": "/user/project/.venv",
            "UV_NO_SYNC": "1",
            "UV_PROJECT_ENVIRONMENT": "/somewhere/else/.venv",
        },
    )
    assert result.returncode == 0, result.stderr
    (venv_name,) = _venv_dirs(data_dir)
    log = mock_uv.read_text().splitlines()
    args_line = next(line for line in log if line.startswith("ARGS:"))
    stage = data_dir / "venv" / f".stage-{venv_name}"
    assert args_line == f"ARGS:sync --frozen --no-dev --no-editable --quiet --project {stage}"
    assert f"ENV:UV_PROJECT_ENVIRONMENT={data_dir}/venv/{venv_name}" in log
    assert "ENV:VIRTUAL_ENV=<unset>" in log
    assert "ENV:UV_NO_SYNC=<unset>" in log


def test_exec_real_entry_with_plugin_root_exported(wrapper, plugin_root, mock_uv, data_dir):
    args = ["issue", "read", "owner/repo#1", "--json"]
    result = _run(wrapper, args, {"CLAUDE_PLUGIN_DATA": str(data_dir)})
    assert result.returncode == 0, result.stderr
    (venv_name,) = _venv_dirs(data_dir)
    out = _stdout_map(result)
    assert out["argv"] == " ".join(args)
    assert out["root"] == str(plugin_root)
    assert out["data"] == str(data_dir), "受け継いだ CLAUDE_PLUGIN_DATA はそのまま実体に届く"
    assert out["skip"] == "<unset>", "wrapper は SKIP を export しない"
    assert out["self"] == f"{data_dir}/venv/{venv_name}/bin/pecot"


def test_stage_excludes_generated_files_and_plugin_root_is_untouched(
    wrapper, plugin_root, mock_uv, data_dir
):
    before = _snapshot(plugin_root)
    result = _run(wrapper, ["--version"], {"CLAUDE_PLUGIN_DATA": str(data_dir)})
    assert result.returncode == 0, result.stderr
    staged = {
        line[len("STAGE:") :]
        for line in mock_uv.read_text().splitlines()
        if line.startswith("STAGE:")
    }
    assert {"pyproject.toml", "uv.lock", "__init__.py", "commands"} <= staged
    assert not staged & {".venv", "__pycache__", "pecot.egg-info", "build"}
    assert _snapshot(plugin_root) == before
    assert not list((data_dir / "venv").glob(".stage-*")), "ステージは残さない"


def test_current_points_at_built_directory(wrapper, mock_uv, data_dir):
    result = _run(wrapper, ["--version"], {"CLAUDE_PLUGIN_DATA": str(data_dir)})
    assert result.returncode == 0, result.stderr
    (venv_name,) = _venv_dirs(data_dir)
    assert _current(data_dir) == venv_name
    assert (data_dir / "venv" / "current" / "bin" / "python").is_file()


# plugin root の解決（従来どおり）。


def test_claude_plugin_root_takes_precedence(wrapper, plugin_root, mock_uv, data_dir, tmp_path):
    other = tmp_path / "other-root"
    shutil.copytree(plugin_root, other)
    (other / "cli" / "commands" / "main.py").write_text("print('other')\n")
    result = _run(
        wrapper,
        ["--version"],
        {"CLAUDE_PLUGIN_ROOT": str(other), "CLAUDE_PLUGIN_DATA": str(data_dir)},
    )
    assert result.returncode == 0, result.stderr
    assert _stdout_map(result)["root"] == str(other)


def test_plugin_root_without_plugin_json_falls_back_to_wrapper_location(
    wrapper, plugin_root, mock_uv, data_dir, tmp_path
):
    no_manifest = tmp_path / "no-manifest"
    no_manifest.mkdir()
    result = _run(
        wrapper,
        ["--version"],
        {"CLAUDE_PLUGIN_ROOT": str(no_manifest), "CLAUDE_PLUGIN_DATA": str(data_dir)},
    )
    assert result.returncode == 0, result.stderr
    assert _stdout_map(result)["root"] == str(plugin_root)


def test_plugin_root_resolved_from_wrapper_location(wrapper, plugin_root, mock_uv, data_dir):
    result = _run(wrapper, ["--version"], {"CLAUDE_PLUGIN_DATA": str(data_dir)})
    assert result.returncode == 0, result.stderr
    assert _stdout_map(result)["root"] == str(plugin_root)


def test_symlink_resolves_plugin_root(wrapper, plugin_root, mock_uv, data_dir, tmp_path):
    link_dir = tmp_path / "path-bin"
    link_dir.mkdir()
    link = link_dir / "pecot"
    link.symlink_to(wrapper)
    result = _run(link, ["--version"], {"CLAUDE_PLUGIN_DATA": str(data_dir)})
    assert result.returncode == 0, result.stderr
    assert _stdout_map(result)["root"] == str(plugin_root)


# install / build の回数。


def _go(wrapper: Path, data_dir: Path, **extra: str | None):
    return _run(wrapper, ["--version"], {"CLAUDE_PLUGIN_DATA": str(data_dir), **extra})


def test_counts_first_run_then_unchanged(wrapper, mock_uv, data_dir):
    first = _go(wrapper, data_dir)
    assert first.returncode == 0, first.stderr
    assert _counts(first) == (1, 1)
    second = _go(wrapper, data_dir)
    assert second.returncode == 0, second.stderr
    assert _counts(second) == (0, 0)
    assert _stderr_lines(second) == []


def test_counts_version_only_update_builds_nothing(wrapper, plugin_root, mock_uv, data_dir):
    assert _go(wrapper, data_dir).returncode == 0
    before = _venv_dirs(data_dir)
    (plugin_root / ".claude-plugin" / "plugin.json").write_text(
        '{ "name": "pecot-w", "version": "2.0.0" }\n'
    )
    (plugin_root / "CHANGELOG.md").write_text("# 2.0.0\n")
    result = _go(wrapper, data_dir)
    assert result.returncode == 0, result.stderr
    assert _counts(result) == (0, 0)
    assert _venv_dirs(data_dir) == before
    assert _current(data_dir) == before[0]


def test_counts_source_only_update_builds_once_without_install(
    wrapper, plugin_root, mock_uv, data_dir
):
    assert _go(wrapper, data_dir).returncode == 0
    first_dir = _current(data_dir)
    (plugin_root / "cli" / "commands" / "main.py").write_text("print('v2')\n")
    result = _go(wrapper, data_dir)
    assert result.returncode == 0, result.stderr
    assert _counts(result) == (0, 1)
    assert _current(data_dir) != first_dir
    assert len(_venv_dirs(data_dir)) == 2
    assert _counts(_go(wrapper, data_dir)) == (0, 0)


def test_pyproject_change_counts_as_source_change(wrapper, plugin_root, mock_uv, data_dir):
    assert _go(wrapper, data_dir).returncode == 0
    (plugin_root / "cli" / "pyproject.toml").write_text('[project]\nname = "pecot"\n# x\n')
    assert _counts(_go(wrapper, data_dir)) == (0, 1)


def test_counts_lock_change_installs_and_builds(wrapper, plugin_root, mock_uv, data_dir):
    assert _go(wrapper, data_dir).returncode == 0
    (plugin_root / "cli" / "uv.lock").write_text("lock-v2\n")
    result = _go(wrapper, data_dir)
    assert result.returncode == 0, result.stderr
    assert _counts(result) == (1, 1)
    assert _counts(_go(wrapper, data_dir)) == (0, 0)


def test_generated_files_do_not_change_source_hash(wrapper, plugin_root, mock_uv, data_dir):
    assert _go(wrapper, data_dir).returncode == 0
    (plugin_root / "cli" / "__pycache__" / "y.pyc").write_bytes(b"\1")
    (plugin_root / "cli" / "pecot.egg-info" / "SOURCES.txt").write_text("y")
    (plugin_root / "cli" / ".venv").mkdir()
    (plugin_root / "cli" / ".venv" / "junk").write_text("y")
    assert _counts(_go(wrapper, data_dir)) == (0, 0)


def test_directory_name_is_lock_hash_and_src_hash(wrapper, mock_uv, data_dir):
    # lock-hash と src-hash はディレクトリ名 `<lock>-<src>` の 2 要素で、どちらも sha256 の 16 進。
    assert _go(wrapper, data_dir).returncode == 0
    (name,) = _venv_dirs(data_dir)
    lock_hash, _, src_hash = name.partition("-")
    assert len(lock_hash) >= 12
    assert len(src_hash) >= 12
    assert all(c in "0123456789abcdef" for c in lock_hash + src_hash)


# 途中で止まったとき・同時起動・世代削除。


def test_failed_sync_leaves_no_mark_and_keeps_current(wrapper, plugin_root, mock_uv, data_dir):
    assert _go(wrapper, data_dir).returncode == 0
    good = _current(data_dir)
    (plugin_root / "cli" / "commands" / "main.py").write_text("print('broken')\n")
    result = _go(wrapper, data_dir, UV_FAIL="1")
    assert result.returncode != 0
    assert result.stdout == ""
    assert _current(data_dir) == good
    broken = [n for n in _venv_dirs(data_dir) if n != good]
    for name in broken:
        assert not (data_dir / "venv" / name / ".pecot-complete").exists()
    assert not list((data_dir / "venv").glob(".stage-*"))
    # 直せば作り直される。
    (plugin_root / "cli" / "commands" / "main.py").write_text("print('fixed')\n")
    again = _go(wrapper, data_dir)
    assert again.returncode == 0, again.stderr
    assert _counts(again) == (0, 1)
    assert _current(data_dir) != good


def test_unmarked_directory_is_rebuilt(wrapper, mock_uv, data_dir):
    assert _go(wrapper, data_dir).returncode == 0
    (name,) = _venv_dirs(data_dir)
    (data_dir / "venv" / name / ".pecot-complete").unlink()
    result = _go(wrapper, data_dir)
    assert result.returncode == 0, result.stderr
    assert _counts(result) == (1, 1)  # 完成済みの同 lock の venv が無いので依存の導入も伴う
    assert (data_dir / "venv" / name / ".pecot-complete").is_file()


def test_marked_directory_without_python_is_rebuilt(wrapper, mock_uv, data_dir):
    assert _go(wrapper, data_dir).returncode == 0
    (name,) = _venv_dirs(data_dir)
    (data_dir / "venv" / name / "bin" / "python").unlink()
    result = _go(wrapper, data_dir)
    assert result.returncode == 0, result.stderr
    assert _counts(result) == (1, 1)
    assert (data_dir / "venv" / name / "bin" / "python").is_file()


def test_concurrent_start_installs_once(wrapper, mock_uv, data_dir):
    results: list[subprocess.CompletedProcess[str]] = []

    def worker() -> None:
        results.append(_go(wrapper, data_dir, UV_DELAY="1"))

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r.returncode for r in results] == [0, 0], [r.stderr for r in results]
    installs = sum(_counts(r)[0] for r in results)
    builds = sum(_counts(r)[1] for r in results)
    assert (installs, builds) == (1, 1)
    sync_calls = [line for line in mock_uv.read_text().splitlines() if line.startswith("ARGS:sync")]
    assert len(sync_calls) == 1


def _bump_source(plugin_root: Path, n: int) -> None:
    (plugin_root / "cli" / "commands" / "main.py").write_text(f"print({n})\n")


def test_generations_keep_current_and_newest_two(wrapper, plugin_root, mock_uv, data_dir):
    names = []
    for n in range(2, 6):
        _bump_source(plugin_root, n)
        assert _go(wrapper, data_dir).returncode == 0
        names.append(_current(data_dir))
        os.utime(data_dir / "venv" / names[-1] / ".pecot-complete", (n * 1000, n * 1000))
    assert len(set(names)) == 4
    remaining = _venv_dirs(data_dir)
    assert sorted(remaining) == sorted(names[-2:])
    assert _current(data_dir) == names[-1]


def test_generation_in_use_is_not_removed(wrapper, plugin_root, mock_uv, data_dir):
    _bump_source(plugin_root, 2)
    assert _go(wrapper, data_dir).returncode == 0
    oldest = _current(data_dir)
    os.utime(data_dir / "venv" / oldest / ".pecot-complete", (1000, 1000))
    held = open(data_dir / "venv" / oldest / ".inuse", "a")  # noqa: SIM115
    fcntl.flock(held, fcntl.LOCK_SH)
    try:
        for n in range(3, 6):
            _bump_source(plugin_root, n)
            assert _go(wrapper, data_dir).returncode == 0
            os.utime(
                data_dir / "venv" / _current(data_dir) / ".pecot-complete", (n * 1000, n * 1000)
            )
        remaining = _venv_dirs(data_dir)
        assert oldest in remaining, "使用中（.inuse に共有ロックあり）の世代は消さない"
        assert _current(data_dir) in remaining
        assert len(remaining) == 3
    finally:
        fcntl.flock(held, fcntl.LOCK_UN)
        held.close()


def test_exec_keeps_inuse_shared_lock_while_running(wrapper, plugin_root, mock_uv, data_dir):
    """exec 後の実体が生きている間、<hash>/.inuse には共有ロックが残る（排他ロックが取れない）。"""
    assert _go(wrapper, data_dir).returncode == 0
    (name,) = _venv_dirs(data_dir)
    sleeper = data_dir / "venv" / name / "bin" / "pecot"
    sleeper.write_text("#!/bin/sh\nsleep 3\n")
    proc = subprocess.Popen(
        [str(wrapper), "x"],
        env=_env({"CLAUDE_PLUGIN_DATA": str(data_dir)}),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    inuse = data_dir / "venv" / name / ".inuse"
    blocked = False
    try:
        for _ in range(50):
            with open(inuse, "a") as fh:
                try:
                    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    blocked = True
                    break
            threading.Event().wait(0.1)
    finally:
        proc.wait(timeout=10)
    assert blocked, "実体が生きている間は共有ロックが残る"
    with open(inuse, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)


def test_first_prepare_works_with_read_only_plugin_root(wrapper, plugin_root, mock_uv, data_dir):
    subprocess.run(["chmod", "-R", "a-w", str(plugin_root)], check=True)
    try:
        result = _go(wrapper, data_dir)
        assert result.returncode == 0, result.stderr
        assert _counts(result) == (1, 1)
    finally:
        subprocess.run(["chmod", "-R", "u+w", str(plugin_root)], check=True)


def test_prepare_output_keeps_stdout_clean(wrapper, mock_uv, data_dir):
    """準備の進捗は stderr だけに出す。stdout は実体の出力のみ。"""
    result = _go(wrapper, data_dir)
    assert result.returncode == 0, result.stderr
    assert not any(line.startswith("pecot:") for line in result.stdout.splitlines())


# 新旧 2 つのプラグインルートが同じデータ置き場を共有するとき。


def _make_old_root(plugin_root: Path, tmp_path: Path) -> Path:
    """新しいルート（2.0.0）のコピーを、古い版（1.0.0・別ソース）のルートにする。"""
    old = tmp_path / "old-root"
    shutil.copytree(plugin_root, old)
    (old / ".claude-plugin" / "plugin.json").write_text(
        '{ "name": "pecot-w", "version": "1.0.0" }\n'
    )
    (old / "cli" / "commands" / "main.py").write_text("print('old')\n")
    return old


def test_old_root_session_does_not_move_current_back(
    wrapper, plugin_root, mock_uv, data_dir, tmp_path
):
    (plugin_root / ".claude-plugin" / "plugin.json").write_text(
        '{ "name": "pecot-w", "version": "2.0.0" }\n'
    )
    old = _make_old_root(plugin_root, tmp_path)
    old_wrapper = old / "bin" / "pecot"

    assert _go(wrapper, data_dir).returncode == 0
    new_dir = _current(data_dir)
    old_result = _go(old_wrapper, data_dir, CLAUDE_PLUGIN_ROOT=str(old))
    assert old_result.returncode == 0, old_result.stderr
    assert _stdout_map(old_result)["root"] == str(old)
    assert _current(data_dir) == new_dir, "旧版の準備で current を戻さない"
    assert len(_venv_dirs(data_dir)) == 2
    again = _go(wrapper, data_dir)
    assert _counts(again) == (0, 0)
    assert _current(data_dir) == new_dir
    # 旧版は、2 回目以降の準備がなく、current も動かない。
    assert _counts(_go(old_wrapper, data_dir, CLAUDE_PLUGIN_ROOT=str(old))) == (0, 0)
    assert _current(data_dir) == new_dir


def test_newer_root_takes_over_current_from_older(
    wrapper, plugin_root, mock_uv, data_dir, tmp_path
):
    (plugin_root / ".claude-plugin" / "plugin.json").write_text(
        '{ "name": "pecot-w", "version": "2.0.0" }\n'
    )
    old = _make_old_root(plugin_root, tmp_path)
    assert _go(old / "bin" / "pecot", data_dir, CLAUDE_PLUGIN_ROOT=str(old)).returncode == 0
    old_dir = _current(data_dir)
    assert _go(wrapper, data_dir).returncode == 0
    assert _current(data_dir) != old_dir


# flock が無い環境のロックファイル。


@pytest.fixture
def no_flock_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """flock だけを除いた PATH（macOS 相当）。mock uv の PATH 先頭は維持する。"""
    shim = tmp_path / "noflock-bin"
    shim.mkdir()
    for directory in ("/usr/bin", "/bin"):
        for entry in Path(directory).iterdir():
            if entry.name != "flock" and not (shim / entry.name).exists():
                (shim / entry.name).symlink_to(entry)
    current = os.environ["PATH"].split(":")
    kept = [
        d for d in current if d not in ("/usr/bin", "/bin") and not (Path(d) / "flock").exists()
    ]
    monkeypatch.setenv("PATH", ":".join([*kept, str(shim)]))
    assert shutil.which("flock") is None


def _assert_concurrent_start_installs_once(wrapper: Path, data_dir: Path) -> None:
    results: list[subprocess.CompletedProcess[str]] = []

    def worker() -> None:
        results.append(_go(wrapper, data_dir, UV_DELAY="1"))

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r.returncode for r in results] == [0, 0], [r.stderr for r in results]
    assert (sum(_counts(r)[0] for r in results), sum(_counts(r)[1] for r in results)) == (1, 1)
    assert not (data_dir / "venv" / ".lock.pid").exists()


def test_no_flock_concurrent_start_installs_once(wrapper, mock_uv, data_dir, no_flock_path):
    _assert_concurrent_start_installs_once(wrapper, data_dir)


def test_no_flock_lock_holds_with_non_atomic_mkdir(
    wrapper, mock_uv, data_dir, no_flock_path, tmp_path, monkeypatch
):
    # 既にあっても成功を返す mkdir（同時に呼ぶと 2 人とも成功する uutils coreutils を再現する）。
    lax = tmp_path / "lax-mkdir-bin"
    lax.mkdir()
    real = shutil.which("mkdir")
    (lax / "mkdir").write_text(f'#!/bin/sh\n"{real}" -p "$@" 2>/dev/null\nexit 0\n')
    (lax / "mkdir").chmod(0o755)
    monkeypatch.setenv("PATH", f"{lax}:{os.environ['PATH']}")
    _assert_concurrent_start_installs_once(wrapper, data_dir)


def test_no_flock_reaps_stale_lock_by_rename(wrapper, mock_uv, data_dir, no_flock_path):
    stale = data_dir / "venv" / ".lock.pid"
    stale.parent.mkdir(parents=True)
    dead = subprocess.Popen(["true"])
    dead.wait()
    stale.write_text(f"{dead.pid}\n")
    result = _go(wrapper, data_dir)
    assert result.returncode == 0, result.stderr
    assert _counts(result) == (1, 1)
    assert not stale.exists()
    assert not list((data_dir / "venv").glob(".lock.pid.stale.*"))


# 失敗には理由の 1 行が付く。


def test_lock_failure_has_reason(wrapper, mock_uv, tmp_path):
    data = tmp_path / "ro-data"
    data.mkdir()
    (data / "venv").write_text("a file, not a directory")
    result = _go(wrapper, data)
    assert result.returncode != 0
    assert result.stdout == ""
    assert any(line.startswith("pecot: ") for line in _stderr_lines(result))
