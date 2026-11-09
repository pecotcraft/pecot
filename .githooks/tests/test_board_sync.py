"""Lambda の webhook 受け口（.github/board-sync/handler.mjs）の node:test を pytest から動かす (#175)。

ディレクトリを渡すと失敗し、引数なしでは .github を探さず 0 件で通る。そのためファイル名を明示する。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


def test_handler_node_tests_pass() -> None:
    result = subprocess.run(
        ["node", "--test", "--test-reporter=tap", ".github/board-sync/handler.test.mjs"],
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


def _permission_blocks() -> list[str]:
    text = (_REPO_ROOT / ".github/board-sync/template.yaml").read_text(encoding="utf-8")
    return [b for b in re.split(r"\n(?=  \S)", text) if "Type: AWS::Lambda::Permission" in b]


def test_public_invoke_function_requires_function_url() -> None:
    # 条件が無いと、誰でも Invoke API で Scheduler と同じ event を渡せる。
    blocks = [
        b for b in _permission_blocks() if re.search(r"Action: lambda:InvokeFunction$", b, re.M)
    ]
    assert len(blocks) == 1
    assert re.search(r"^\s+InvokedViaFunctionUrl: true$", blocks[0], re.M)


def test_public_invoke_function_url_is_auth_none_only() -> None:
    blocks = [b for b in _permission_blocks() if "Action: lambda:InvokeFunctionUrl" in b]
    assert len(blocks) == 1
    assert re.search(r"^\s+FunctionUrlAuthType: NONE$", blocks[0], re.M)
