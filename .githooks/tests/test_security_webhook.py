"""Lambda の webhook 受け口（.github/security-webhook/handler.mjs）の node:test を pytest から動かす (#175)。

ディレクトリを渡すと失敗し、引数なしでは .github を探さず 0 件で通る。そのためファイル名を明示する。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


def test_handler_node_tests_pass() -> None:
    result = subprocess.run(
        ["node", "--test", "--test-reporter=tap", ".github/security-webhook/handler.test.mjs"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    count = re.search(r"^# tests (\d+)$", result.stdout, flags=re.M)
    assert count, result.stdout
    assert int(count.group(1)) >= 1
    assert re.search(r"^# fail 0$", result.stdout, flags=re.M)
