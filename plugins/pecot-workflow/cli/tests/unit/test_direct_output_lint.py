"""tests/unit/test_direct_output_lint.py - ruff stops direct output outside Output.

Code is passed on stdin, so no file is written. The same result is expected whether
ruff runs with the cwd at cli/ or at the repo root with --config (as pre-commit does).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

CLI_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = CLI_DIR.parents[2]
CONFIG = CLI_DIR / "pyproject.toml"

CASES: dict[str, str] = {
    "typer.echo": "import typer\ntyper.echo('x')\n",
    "typer.secho": "import typer\ntyper.secho('x')\n",
    "click.echo": "import click\nclick.echo('x')\n",
    "sys.stdout": "import sys\nsys.stdout.write('x')\n",
    "sys.stderr": "import sys\nsys.stderr.write('x')\n",
    "rich.print": "import rich\nrich.print('x')\n",
}


def _ruff(code: str, filename: str, from_root: bool) -> set[str]:
    if from_root:
        cwd = REPO_ROOT
        name = f"plugins/pecot-workflow/cli/{filename}"
        config = ["--config", "plugins/pecot-workflow/cli/pyproject.toml"]
    else:
        cwd = CLI_DIR
        name = filename
        config = []
    proc = subprocess.run(
        [sys.executable, "-m", "ruff", "check", *config, "--output-format", "json",
         "--stdin-filename", name, "-"],
        input=code, capture_output=True, text=True, cwd=cwd, check=False,
    )  # fmt: skip
    assert proc.returncode in (0, 1), proc.stderr
    return {d["code"] for d in json.loads(proc.stdout)}


STOPPED_PATHS = ["commands/issue.py", "core/github/client.py"]


@pytest.mark.parametrize("from_root", [False, True], ids=["cwd-cli", "cwd-root"])
@pytest.mark.parametrize("filename", STOPPED_PATHS)
@pytest.mark.parametrize("api", list(CASES))
def test_banned_api_stops(api: str, filename: str, from_root: bool) -> None:
    assert "TID251" in _ruff(CASES[api], filename, from_root)


@pytest.mark.parametrize("from_root", [False, True], ids=["cwd-cli", "cwd-root"])
@pytest.mark.parametrize("filename", STOPPED_PATHS)
def test_print_stops(filename: str, from_root: bool) -> None:
    assert "T201" in _ruff("print('x')\n", filename, from_root)


def test_pecot_workflow_scripts_are_exempt() -> None:
    code = "import sys\nprint('x')\nsys.stderr.write('x')\n"
    codes = _ruff_at_root(code, "plugins/pecot-workflow/scripts/ci/compare_junit.py")
    assert not codes & {"T201", "TID251"}


def _ruff_at_root(code: str, name: str) -> set[str]:
    proc = subprocess.run(
        [sys.executable, "-m", "ruff", "check", "--config",
         "plugins/pecot-workflow/cli/pyproject.toml", "--output-format", "json",
         "--stdin-filename", name, "-"],
        input=code, capture_output=True, text=True, cwd=REPO_ROOT, check=False,
    )  # fmt: skip
    assert proc.returncode in (0, 1), proc.stderr
    return {d["code"] for d in json.loads(proc.stdout)}


@pytest.mark.parametrize("from_root", [False, True], ids=["cwd-cli", "cwd-root"])
@pytest.mark.parametrize("api", list(CASES))
def test_output_module_is_exempt_from_banned_api(api: str, from_root: bool) -> None:
    assert "TID251" not in _ruff(CASES[api], "commands/_output.py", from_root)


@pytest.mark.parametrize("from_root", [False, True], ids=["cwd-cli", "cwd-root"])
def test_tests_are_exempt(from_root: bool) -> None:
    codes = _ruff("import sys\nprint('x')\nsys.stderr.write('x')\n", "tests/x.py", from_root)
    assert not codes & {"T201", "TID251"}
