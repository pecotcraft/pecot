"""step-gate.sh と step-gate.mjs のテスト。本物の allure quality-gate に、Allure の結果の JSON を渡す。"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import allure
import pytest

_REPO = Path(__file__).resolve().parents[2]
_GATE = _REPO / ".githooks/scripts/test_report/step-gate.sh"

pytestmark = pytest.mark.skipif(shutil.which("pnpm") is None, reason="pnpm が要る")


def _step(name: str, *steps: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "status": "passed", "stage": "finished", "steps": list(steps)}


def _result(
    uuid: str,
    name: str,
    *,
    status: str = "passed",
    steps: list[dict[str, Any]] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "uuid": uuid,
        "historyId": f"h-{uuid}",
        "name": name,
        "fullName": f"alpha/sample.test.ts#{name}",
        "status": status,
        "stage": "finished",
        "start": 1_700_000_000_000,
        "stop": 1_700_000_000_010,
        "steps": steps or [],
        **extra,
    }


def _write(results: Path, *entries: dict[str, Any]) -> None:
    results.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        (results / f"{entry['uuid']}-result.json").write_text(json.dumps(entry), "utf-8")


def _gate(results: Path, cwd: Path) -> subprocess.CompletedProcess[str]:
    with allure.step("step-gate.sh を動かす"):
        return subprocess.run(
            ["bash", str(_GATE), str(results)], cwd=cwd, capture_output=True, text=True, check=False
        )


def _missing(done: subprocess.CompletedProcess[str]) -> set[str]:
    """gate が並べた、step の無いテストの名前。最後の行には色と規則の名前が付く。"""
    lines = re.sub(r"\x1b\[[0-9;]*m", "", done.stderr).splitlines()
    return {line.strip().split("    ")[0] for line in lines if line.startswith("   alpha/")}


def test_passes_when_every_passed_test_has_a_named_step(tmp_path: Path) -> None:
    with allure.step("名前の付いた step を持つ結果を書く"):
        _write(tmp_path / "results", _result("1", "a", steps=[_step("CLI を動かす")]))
    done = _gate(tmp_path / "results", tmp_path)
    with allure.step("終了コードを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr


def test_fails_and_names_only_the_tests_without_named_steps(tmp_path: Path) -> None:
    with allure.step("step の有る結果と無い結果を書く"):
        _write(
            tmp_path / "results",
            _result("1", "有る", steps=[_step("CLI を動かす")]),
            _result("2", "無い"),
            _result("3", "expect だけ", steps=[_step("expect(1).toBe(1)")]),
            _result(
                "4",
                "添付だけ",
                attachments=[
                    {"name": "stdout", "source": "4-attachment.txt", "type": "text/plain"}
                ],
            ),
        )
        (tmp_path / "results/4-attachment.txt").write_text("out", "utf-8")
    done = _gate(tmp_path / "results", tmp_path)
    with allure.step("終了コードと、並んだ名前を確かめる"):
        assert done.returncode != 0
        assert _missing(done) == {
            "alpha/sample.test.ts#expect だけ",
            "alpha/sample.test.ts#無い",
            "alpha/sample.test.ts#添付だけ",
        }


def test_counts_a_named_step_nested_under_a_matcher_step(tmp_path: Path) -> None:
    with allure.step("自動の step の下に、名前の付いた step を持つ結果を書く"):
        _write(
            tmp_path / "results",
            _result("1", "a", steps=[_step("expect(x).toBe(1)", _step("値を読む"))]),
        )
    done = _gate(tmp_path / "results", tmp_path)
    with allure.step("終了コードを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr


@pytest.mark.parametrize("status", ["failed", "broken", "skipped"])
def test_ignores_tests_that_did_not_pass(tmp_path: Path, status: str) -> None:
    with allure.step(f"step の無い {status} の結果を書く"):
        _write(tmp_path / "results", _result("1", "a", status=status))
    done = _gate(tmp_path / "results", tmp_path)
    with allure.step("終了コードを確かめる"):
        assert done.returncode == 0, done.stdout + done.stderr


def test_leaves_no_report_in_the_working_directory(tmp_path: Path) -> None:
    with allure.step("step の無い結果を書く"):
        _write(tmp_path / "results", _result("1", "a"))
    _gate(tmp_path / "results", tmp_path)
    with allure.step("作業ディレクトリとリポのルートに allure-report が無いことを確かめる"):
        assert not (tmp_path / "allure-report").exists()
        assert not (_REPO / "allure-report").exists()
