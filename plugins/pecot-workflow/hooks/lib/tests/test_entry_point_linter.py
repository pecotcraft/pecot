"""エントリーポイントリンターのテスト（test_entry_point_linter.bats 移植）。

.githooks/pre-commit/check-entry-point-logic.sh の挙動を検証する。
ディスパッチャに含めてよい構文は PASS とする（shebang / SCRIPT_DIR / 早期リターン / スクリプト呼び出し）。
ロジックは VIOLATION として報告する（for / while / case / 関数定義 / grep-sed-awk / mkdir-touch-rm）。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def linter(project_root: Path) -> Path:
    return project_root / ".githooks" / "pre-commit" / "check-entry-point-logic.sh"


def _run_linter(linter: Path, *targets: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(linter), *[str(t) for t in targets]],
        capture_output=True,
        text=True,
        timeout=25,
    )


# パスするケース。

_PASS_FIXTURES = {
    "clean.sh": (
        '#!/bin/bash\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n"$SCRIPT_DIR/lib/handler.sh"\n'
    ),
    "jq_dispatch.sh": (
        "#!/bin/bash\n"
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
        "INPUT=$(cat)\n"
        "TOOL_NAME=$(echo \"$INPUT\" | jq -r '.tool_name')\n"
        '[ -z "$TOOL_NAME" ] && exit 0\n'
        '"$SCRIPT_DIR/lib/handler.sh"\n'
        "exit 0\n"
    ),
    "source_export.sh": (
        "#!/bin/bash\n"
        "set -euo pipefail\n"
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
        'LIB_DIR="$SCRIPT_DIR/lib"\n'
        'source "$LIB_DIR/common.sh"\n'
        'export HOOK_COMMAND="$COMMAND"\n'
        'OUTPUT=$("$LIB_DIR/core/check.sh")\n'
        "if [ $? -eq 1 ]; then\n"
        '    echo "$OUTPUT"\n'
        "    exit 1\n"
        "fi\n"
        "exit 0\n"
    ),
    "comments_only.sh": (
        "#!/bin/bash\n# This is a comment\n# Another comment\n\n# More comments\n\n"
    ),
    "pipe_exec.sh": (
        "#!/bin/bash\n"
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
        "INPUT=$(cat)\n"
        'echo "$INPUT" | "$SCRIPT_DIR/lib/handler.sh"\n'
        "exit 0\n"
    ),
    "early_return.sh": (
        "#!/bin/bash\n"
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
        "INPUT=$(cat)\n"
        "MODE=$(echo \"$INPUT\" | jq -r '.mode')\n"
        '[ "$MODE" != "active" ] && exit 0\n'
        '"$SCRIPT_DIR/lib/handler.sh"\n'
        "exit 0\n"
    ),
}


@pytest.mark.parametrize("fixture_name", list(_PASS_FIXTURES))
def test_clean_dispatcher_passes(linter, tmp_path, fixture_name) -> None:
    target = tmp_path / fixture_name
    target.write_text(_PASS_FIXTURES[fixture_name])
    result = _run_linter(linter, target)
    assert result.returncode == 0
    assert "PASS:" in result.stdout


def test_real_clean_entry_point_passes(linter, project_root) -> None:
    target = project_root / "plugins" / "pecot-workflow" / "hooks" / "session-start.sh"
    result = _run_linter(linter, target)
    assert result.returncode == 0
    assert "PASS:" in result.stdout


# 違反するケース。

_VIOLATION_FIXTURES = {
    "for_loop.sh": (
        '#!/bin/bash\nfor file in *.sh; do\n    echo "$file"\ndone\n',
        "for file",
    ),
    "while_loop.sh": (
        '#!/bin/bash\nwhile read -r line; do\n    echo "$line"\ndone\n',
        "while read",
    ),
    "case_esac.sh": (
        '#!/bin/bash\ncase "$1" in\n    start) echo "starting" ;;\n'
        '    stop) echo "stopping" ;;\nesac\n',
        'case "$1"',
    ),
    "func_def.sh": (
        '#!/bin/bash\nmy_function() {\n    echo "hello"\n}\n',
        "my_function()",
    ),
    "grep_sed.sh": (
        "#!/bin/bash\nINPUT=$(cat)\n"
        "RESULT=$(echo \"$INPUT\" | grep -oP 'pattern')\n"
        "echo \"$RESULT\" | sed 's/old/new/'\n",
        "grep -oP",
    ),
    "file_ops.sh": (
        '#!/bin/bash\nmkdir -p "$WORK_DIR/test"\n'
        'touch "$WORK_DIR/test/file"\nrm -f "$WORK_DIR/test/file"\n',
        "mkdir",
    ),
}


@pytest.mark.parametrize(
    ("fixture_name", "marker"),
    [(name, marker) for name, (_, marker) in _VIOLATION_FIXTURES.items()],
)
def test_logic_reports_violation(linter, tmp_path, fixture_name, marker) -> None:
    target = tmp_path / fixture_name
    target.write_text(_VIOLATION_FIXTURES[fixture_name][0])
    result = _run_linter(linter, target)
    assert result.returncode == 1
    assert "VIOLATION:" in result.stdout
    assert marker in result.stdout


# 実エントリポイント全件（ガード本体と一覧のドリフト検知）。
# guard は .pre-commit-config.yaml では、staged ファイルのみを確認する。
# そのため、「全 entry point が違反 0」と「一覧が実ファイルと一致」は、ここで担保する。
# .githooks/tests/ 側の同名ファイルは、files: ^\.githooks/ の pre-push でしか動かない。
# entry point の変更では発火しない。


def _run_linter_all_entry_points(linter: Path, project_root: Path) -> subprocess.CompletedProcess:
    """引数なし実行（= guard 内蔵の ALL_ENTRY_POINTS を対象）。パスはリポルート相対。"""
    return subprocess.run(
        ["bash", str(linter)],
        cwd=project_root,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _real_entry_points(project_root: Path) -> set[str]:
    hooks_dir = project_root / "plugins" / "pecot-workflow" / "hooks"
    return {p.relative_to(project_root).as_posix() for p in hooks_dir.glob("*.sh")}


def _reported_targets(stdout: str) -> set[str]:
    """guard 出力から確認対象パスを復元する（PASS / VIOLATION / WARNING の 3 形態）。"""
    targets: set[str] = set()
    for line in stdout.splitlines():
        for prefix in ("PASS: ", "VIOLATION: ", "WARNING: File not found: "):
            if line.startswith(prefix):
                targets.add(line[len(prefix) :].strip())
                break
    return targets


def test_all_real_entry_points_pass(linter, project_root) -> None:
    """実エントリポイント全件が violation 0 / exit 0 で、未確認（WARNING）も無いこと。"""
    result = _run_linter_all_entry_points(linter, project_root)
    expected_count = len(_real_entry_points(project_root))
    assert "WARNING" not in result.stdout, (
        f"実在しないパスが一覧に残っています（clean へ誤計上される）:\n{result.stdout}"
    )
    assert result.returncode == 0, result.stdout
    assert f"0 files with violations, {expected_count} files clean" in result.stdout


def test_all_entry_points_list_matches_real_files(linter, project_root) -> None:
    """ALL_ENTRY_POINTS と plugins/pecot-workflow/hooks/*.sh が双方向で一致すること。

    一覧に実在しないパスが残ると WARNING 付きで clean 計上され、実在するエントリが
    一覧から抜けると恒久的に未確認になる。どちらも guard を pass させてしまうため、
    実ファイル集合との一致をここで固定する。
    """
    result = _run_linter_all_entry_points(linter, project_root)
    reported = _reported_targets(result.stdout)
    actual = _real_entry_points(project_root)
    assert reported == actual, (
        f"ALL_ENTRY_POINTS へ追加が必要: {sorted(actual - reported)} / "
        f"実在せず削除が必要: {sorted(reported - actual)}"
    )


def test_mixed_clean_and_dirty(linter, tmp_path) -> None:
    clean = tmp_path / "clean.sh"
    clean.write_text(
        '#!/bin/bash\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n"$SCRIPT_DIR/lib/handler.sh"\n'
    )
    dirty = tmp_path / "dirty.sh"
    dirty.write_text('#!/bin/bash\nfor i in 1 2 3; do\n    echo "$i"\ndone\n')

    result = _run_linter(linter, clean, dirty)
    assert result.returncode == 1
    assert "PASS:" in result.stdout
    assert "VIOLATION:" in result.stdout
    assert "1 files with violations, 1 files clean" in result.stdout
