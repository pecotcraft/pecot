"""`.githooks/scripts/run-pnpm.sh` の npx の分岐が、root の packageManager の版で pnpm を呼ぶことを確かめる (#126)。

devcontainer では pnpm が PATH にあるため、npx の分岐は手で打っても通らない。
偽の npx と最小限のコマンドだけの PATH で動かす。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO_ROOT / ".githooks" / "scripts" / "run-pnpm.sh"


def _minimal_path(tmp_path: Path) -> Path:
    """偽の npx と、スクリプトが使うコマンドの symlink だけの bin。pnpm・corepack は入れない。"""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("bash", "dirname", "sed", "head"):
        found = shutil.which(name)
        assert found, name
        (bin_dir / name).symlink_to(found)
    npx = bin_dir / "npx"
    npx.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\npwd\n', encoding="utf-8")
    npx.chmod(0o755)
    return bin_dir


def test_npx_branch_passes_pinned_version_dir_and_args(tmp_path: Path) -> None:
    bin_dir = _minimal_path(tmp_path)
    cwd = tmp_path / "work"
    cwd.mkdir()
    manifest = json.loads((_REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    version = re.match(r"pnpm@([^+]+)", manifest["packageManager"])
    assert version

    result = subprocess.run(
        [str(bin_dir / "bash"), str(_SCRIPT), "install"],
        cwd=cwd,
        env={"PATH": str(bin_dir)},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        "--yes",
        f"pnpm@{version.group(1)}",
        "--dir",
        str(cwd.resolve()),
        "install",
        "/",
    ]


def test_script_is_executable() -> None:
    assert os.access(_SCRIPT, os.X_OK)
