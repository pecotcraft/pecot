"""テストが判定に使った子プロセスの出力と、書き出したファイルを、Allure の添付に残す。

テストは `sys.path.insert` で読む（run.sh の --import-mode=importlib では、このディレクトリが sys.path に無い）。
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

_LABEL_LENGTH = 200

Output = str | bytes | None


def _attach(body: str | bytes, name: str, *, json: bool = False) -> None:
    # 動いているテストの外で呼ぶと allure-pytest が落ちる。allure-pytest を入れない pytest では読めない。
    if not os.environ.get("PYTEST_CURRENT_TEST"):
        return
    try:
        import allure
    except ImportError:
        return
    kind = allure.attachment_type.JSON if json else allure.attachment_type.TEXT
    allure.attach(body, name=name, attachment_type=kind)


def _command(args: Any) -> str:
    items = [args] if isinstance(args, str | bytes | os.PathLike) else list(args)
    return " ".join(
        os.fsdecode(item) if isinstance(item, str | bytes | os.PathLike) else str(item)
        for item in items
    )[:_LABEL_LENGTH]


def attach_output(command: str, stdout: Output, stderr: Output, returncode: int | None) -> None:
    """空でない stdout・stderr を添付する。両方空なら空の stdout を 1 つ添付する。"""
    label = (
        command[:_LABEL_LENGTH]
        if returncode is None
        else f"{command[:_LABEL_LENGTH]}（終了コード {returncode}）"
    )
    if stdout or not stderr:
        _attach(stdout or "", f"{label} stdout")
    if stderr:
        _attach(stderr, f"{label} stderr")


def run_attached(
    args: Sequence[Any] | str, *, check: bool = False, **kwargs: Any
) -> subprocess.CompletedProcess:
    """`subprocess.run` と同じ引数で動かし、出力を添付してから結果を返す。

    check で落ちるときも timeout のときも、添付してから例外を投げる。
    """
    command = _command(args)
    try:
        result = subprocess.run(args, check=False, **kwargs)  # noqa: S603, PLW1510
    except subprocess.TimeoutExpired as error:
        attach_output(f"{command}（timeout）", error.stdout, error.stderr, None)
        raise
    attach_output(command, result.stdout, result.stderr, result.returncode)
    if check:
        result.check_returncode()
    return result


def read_output(path: str | Path) -> str:
    """テスト対象が書き出したファイルを UTF-8 で読み、読んだ中身を添付して返す。"""
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    _attach(text, target.name, json=target.suffix == ".json")
    return text
