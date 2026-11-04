""".pecot 書き込み規約の lint テスト（#666）（test_pecot_state_write_convention.bats 移植）。

lib/ 配下（tests/ 除外）の .sh から mkdir を直接含むものを検出し、allowlist 3 ファイル以外に存在しないことを pin する。
bats 版の grep -rlP '^[^#]*\bmkdir\b' を、subprocess でそのまま再現する。
コメント行の mkdir は除外する正規表現の挙動を保つため、Python 側で書き換えず grep をそのまま使う。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

_ALLOWLIST = {
    "pecot-dir-init.sh",
    "pecot-gitignore-ensure.sh",
    "pecot-state-guard.sh",
}


def test_only_allowlist_sh_contain_direct_mkdir(project_root: Path) -> None:
    lib_dir = project_root / "plugins" / "pecot-workflow" / "hooks" / "lib"

    # grep -rlP --include='*.sh' --exclude-dir=tests '^[^#]*\bmkdir\b'
    #   手前に # が無い行の mkdir のみ一致 → コメント行は除外。-l でファイル名のみ。
    result = subprocess.run(
        [
            "grep",
            "-rlP",
            "--include=*.sh",
            "--exclude-dir=tests",
            r"^[^#]*\bmkdir\b",
            str(lib_dir),
        ],
        capture_output=True,
        text=True,
        timeout=25,
    )
    # grep の exit 1（マッチなし）は許容。2 以上は実行エラー。
    assert result.returncode in (0, 1), f"grep failed: {result.stderr}"

    offenders = [
        str(Path(line).relative_to(project_root))
        for line in result.stdout.splitlines()
        if line and Path(line).name not in _ALLOWLIST
    ]

    assert offenders == [], (
        "allowlist 外で mkdir を直接含む .sh: "
        f"{offenders} — pecot_state_dir_ensure() 経由へ置換してください"
        "（gitignore-before-write #666）。"
    )
