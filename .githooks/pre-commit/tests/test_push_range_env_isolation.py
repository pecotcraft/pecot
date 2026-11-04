"""conftest.py の _isolate_git_env が push 範囲の env を外すことの回帰テスト (#1225)。

pre-push 配下では pre-commit が PRE_COMMIT_FROM_REF / PRE_COMMIT_TO_REF を渡す。
計測や検証では PECOT_VERSION_PLAN_BASE を付けて push する。
これらが pytest に引き継がれると、temp repo の base 解決（lib/push-range.sh の merge-base）が
実リポの値で上書きされて、無関係なテストが落ちる。

conftest の _PUSH_RANGE_ENV を空にしても、この env を外す autouse が機能しているかは外から見えない。
そこで存在しない sha を env に付けたまま、block 系のケースを別 pytest プロセスで流す。
ケースは test_check_version_plan_required.py の test_01 を使う。
通れば、env が外れてテスト内の base 解決が失敗していないことを固定できる。
env が残っていると hook は base を解決できず skip（exit 0）して、test_01 の
`returncode == 1` が落ちる。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

# git に存在しない 40 桁の sha。
_MISSING_SHA = "0123456789abcdef0123456789abcdef01234567"

_BLOCK_CASE = "test_check_version_plan_required.py::test_01_block_no_plan"


def test_block_case_passes_with_push_range_env_set() -> None:
    """PECOT_VERSION_PLAN_BASE が親から引き継がれていても、block 系のケースが通る。"""
    tests_dir = Path(__file__).resolve().parent
    env = {**os.environ, "PECOT_VERSION_PLAN_BASE": _MISSING_SHA}
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            str(tests_dir / _BLOCK_CASE),
            "-q",
            "--import-mode=importlib",
            "-p",
            "no:cacheprovider",
            "-p",
            "no:xdist",
        ],
        cwd=tests_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "1 passed" in result.stdout
