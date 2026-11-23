"""test_report/generate.py のテスト。結果のそろいの判定・履歴の扱い・allure generate に渡す引数と、allurerc.mjs の値。

単体のケースは allure の起動（run）だけを差し替える。最後の 1 本は本物の allure generate を起こす。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/test_report"))

import generate  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
_CONFIG = _REPO / ".githooks/scripts/test_report/allurerc.mjs"
SHA_A = "a" * 40
SHA_B = "b" * 40

_LANES = [
    {
        "project": "alpha",
        "target": "test-unit",
        "results": "alpha/test-results/test-unit/allure-results",
    },
    {
        "project": "beta",
        "target": "test-cli",
        "plugin": "beta",
        "results": "beta/test-results/test-cli/allure-results",
    },
    {
        "project": "beta",
        "target": "test-bootstrap",
        "plugin": "beta",
        "excluded": "bash の *.test.sh",
    },
]


class Recorder:
    """allure の起動の代わり。受けたコマンドと環境を残し、決めた終了コードを返す。"""

    def __init__(self, code: int = 0) -> None:
        self.code = code
        self.calls: list[tuple[list[str], dict[str, str]]] = []

    def __call__(self, command: list[str], env: dict[str, str]) -> int:
        self.calls.append((command, env))
        return self.code


@pytest.fixture
def root(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "report-lanes.json").write_text(json.dumps(_LANES), encoding="utf-8")
    return repo


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(generate.HISTORY_ENV, raising=False)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)


def _results(root: Path, lane: str, *, count: int = 1, commit: str | None = None) -> Path:
    path = root / next(e["results"] for e in _LANES if f"{e['project']}:{e['target']}" == lane)
    path.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        (path / f"{lane.replace(':', '-')}-{i}-result.json").write_text("{}", encoding="utf-8")
    if commit is not None:
        source = {"lane": lane, "commit": commit}
        (path.parent / "source.json").write_text(json.dumps(source), encoding="utf-8")
    return path


def _sources(tmp_path: Path, runs: list[dict[str, Any]]) -> Path:
    path = tmp_path / "report-sources.json"
    path.write_text(json.dumps({"side": "dev", "runs": runs, "missing": []}), encoding="utf-8")
    return path


def _main(root: Path, *args: str, run: Recorder | None = None) -> tuple[int, Recorder]:
    recorder = run or Recorder()
    code = generate.main(
        ["generate.py", *args], root=root, lanes_path=root / "report-lanes.json", run=recorder
    )
    return code, recorder


# --- そろいの判定 ---


def test_local_names_missing_lanes_and_builds_from_the_rest(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    alpha = _results(root, "alpha:test-unit")

    code, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    assert code == 0
    assert len(run.calls) == 1
    command = run.calls[0][0]
    assert command[-1] == str(alpha)
    assert str(root / _LANES[1]["results"]) not in command
    assert "beta:test-cli" in capsys.readouterr().err


def test_local_counts_a_lane_without_result_files_as_missing(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _results(root, "alpha:test-unit")
    empty = root / _LANES[1]["results"]
    empty.mkdir(parents=True)
    (empty / "x-container.json").write_text("{}", encoding="utf-8")

    code, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    assert code == 0
    assert str(empty) not in run.calls[0][0]
    assert "beta:test-cli" in capsys.readouterr().err


def test_local_fails_when_no_lane_has_results(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    assert code == 1
    assert run.calls == []
    err = capsys.readouterr().err
    assert "alpha:test-unit" in err
    assert "beta:test-cli" in err


def test_sources_run_fails_on_missing_lane_without_running_allure(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _results(root, "alpha:test-unit", commit=SHA_A)
    empty = root / _LANES[1]["results"]
    empty.mkdir(parents=True)
    sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit", "beta:test-cli"]}])

    code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    assert code == 1
    assert run.calls == []
    assert "beta:test-cli" in capsys.readouterr().err


# --- 起動の引数 ---


def test_command_lists_config_output_clean_and_results_in_lane_order(
    root: Path, tmp_path: Path
) -> None:
    beta = _results(root, "beta:test-cli", commit=SHA_A)
    alpha = _results(root, "alpha:test-unit", commit=SHA_A)
    sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["beta:test-cli", "alpha:test-unit"]}])

    code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    assert code == 0
    command, env = run.calls[0]
    assert command == [
        "pnpm", "exec", "allure", "generate",
        "--config", str(_CONFIG),
        "--output", str(tmp_path / "out"),
        "--clean",
        str(alpha), str(beta),
    ]  # fmt: skip
    assert generate.HISTORY_ENV not in env


def test_relative_output_is_resolved_from_the_working_directory(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _results(root, "alpha:test-unit")
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)

    _, run = _main(root, "--local", "--output", "report")

    command = run.calls[0][0]
    assert command[command.index("--output") + 1] == str(work / "report")


def test_history_is_passed_by_env_as_an_absolute_path(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _results(root, "alpha:test-unit", commit=SHA_A)
    sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}])
    monkeypatch.chdir(tmp_path)

    _, run = _main(
        root, "--sources", str(sources), "--output", "out", "--history", "store/history.jsonl"
    )

    assert run.calls[0][1][generate.HISTORY_ENV] == str(tmp_path / "store/history.jsonl")


def test_local_never_passes_history_from_the_parent_env(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _results(root, "alpha:test-unit")
    monkeypatch.setenv(generate.HISTORY_ENV, str(tmp_path / "leaked.jsonl"))

    _, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    assert generate.HISTORY_ENV not in run.calls[0][1]


def test_allure_failure_is_returned(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _results(root, "alpha:test-unit")

    code, _ = _main(root, "--local", "--output", str(tmp_path / "out"), run=Recorder(code=3))

    assert code == 3
    assert "allure generate" in capsys.readouterr().err


# --- 履歴 ---


def _history_run(root: Path, tmp_path: Path, history: Path) -> tuple[int, Recorder]:
    _results(root, "alpha:test-unit", commit=SHA_A)
    sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}])
    return _main(
        root,
        "--sources",
        str(sources),
        "--output",
        str(tmp_path / "out"),
        "--history",
        str(history),
    )


def test_missing_history_is_passed_as_is_without_notice(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    history = tmp_path / "history.jsonl"

    code, run = _history_run(root, tmp_path, history)

    assert code == 0
    assert run.calls[0][1][generate.HISTORY_ENV] == str(history)
    assert not history.exists()
    assert "履歴" not in capsys.readouterr().err


@pytest.mark.parametrize(
    "bad",
    [
        b"{not json\n",
        b'{"a": NaN}\n',
        b"null\n",
        b"[1, 2]\n",
        b'{"a": "\xff"}\n',
    ],
    ids=["broken", "nan", "null", "array", "not-utf8"],
)
def test_unreadable_history_is_emptied_with_notice(
    root: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    bad: bytes,
) -> None:
    history = tmp_path / "history.jsonl"
    history.write_bytes(b'{"uuid": "1"}\n' + bad)
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))

    code, _ = _history_run(root, tmp_path, history)

    assert code == 0
    assert history.read_bytes() == b""
    assert "履歴" in capsys.readouterr().err
    assert "履歴" in summary.read_text(encoding="utf-8")


def test_readable_history_is_left_as_is(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    history = tmp_path / "history.jsonl"
    # JSON.stringify は U+2028 をエスケープしない。行の区切りに数えない
    body = '{"uuid": "1", "name": "a b"}\r\n\n  \n{"uuid": "2"}\n'.encode()
    history.write_bytes(body)

    code, _ = _history_run(root, tmp_path, history)

    assert code == 0
    assert history.read_bytes() == body
    assert "履歴" not in capsys.readouterr().err


def test_lone_carriage_return_splits_lines_like_node_readline() -> None:
    assert generate.read_history(b'{"a": 1}\r{"b": 2}\n') == []
    assert generate.read_history(b'{"a": 1}\r{oops\n') == [2]


# --- 材料（--sources） ---


def test_sources_with_matching_source_json_build_only_the_listed_lanes(
    root: Path, tmp_path: Path
) -> None:
    alpha = _results(root, "alpha:test-unit", commit=SHA_A)
    _results(root, "beta:test-cli", commit=SHA_A)
    sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}])

    code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    assert code == 0
    assert run.calls[0][0][-1] == str(alpha)
    assert str(root / _LANES[1]["results"]) not in run.calls[0][0]


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        (None, "source.json"),
        ({"lane": "beta:test-cli", "commit": SHA_B}, SHA_B),
        ({"lane": "alpha:test-unit", "commit": SHA_B}, SHA_B),
        ("not json", "source.json"),
    ],
    ids=["absent", "other-lane", "other-commit", "unreadable"],
)
def test_source_mismatch_fails_naming_the_lane(
    root: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    source: object,
    expected: str,
) -> None:
    alpha = _results(root, "alpha:test-unit")
    if source == "not json":
        (alpha.parent / "source.json").write_text("{", encoding="utf-8")
    elif source is not None:
        (alpha.parent / "source.json").write_text(json.dumps(source), encoding="utf-8")
    _results(root, "beta:test-cli", commit=SHA_A)
    sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit", "beta:test-cli"]}])

    code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    assert code == 1
    assert run.calls == []
    err = capsys.readouterr().err
    assert "alpha:test-unit" in err
    assert expected in err
    assert "  beta:test-cli:" not in err


def test_lanes_of_several_runs_are_checked_against_their_own_commit(
    root: Path, tmp_path: Path
) -> None:
    _results(root, "alpha:test-unit", commit=SHA_B)
    _results(root, "beta:test-cli", commit=SHA_A)
    sources = _sources(
        tmp_path,
        [
            {"commit": SHA_A, "lanes": ["beta:test-cli"]},
            {"commit": SHA_B, "lanes": ["alpha:test-unit"]},
        ],
    )

    code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    assert code == 0
    assert len(run.calls) == 1


@pytest.mark.parametrize(
    ("runs", "expected"),
    [
        ([{"commit": SHA_A, "lanes": ["gamma:test-unit"]}], "gamma:test-unit"),
        ([{"commit": SHA_A, "lanes": ["beta:test-bootstrap"]}], "beta:test-bootstrap"),
        (
            [
                {"commit": SHA_A, "lanes": ["alpha:test-unit"]},
                {"commit": SHA_B, "lanes": ["alpha:test-unit"]},
            ],
            "alpha:test-unit",
        ),
        ([{"commit": "abc", "lanes": ["alpha:test-unit"]}], "abc"),
        ([{"commit": SHA_A}], "lanes"),
        ("nope", "runs"),
    ],
    ids=["unknown", "excluded", "twice", "short-commit", "no-lanes", "runs-not-list"],
)
def test_bad_sources_stop_with_a_message(
    root: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    runs: object,
    expected: str,
) -> None:
    _results(root, "alpha:test-unit", commit=SHA_A)
    path = tmp_path / "report-sources.json"
    path.write_text(json.dumps({"side": "dev", "runs": runs, "missing": []}), encoding="utf-8")

    code, run = _main(root, "--sources", str(path), "--output", str(tmp_path / "out"))

    assert code == 1
    assert run.calls == []
    assert expected in capsys.readouterr().err


# --- 引数の誤り ---


@pytest.mark.parametrize(
    "args",
    [
        ["--local", "--history", "h.jsonl"],
        ["--local", "--sources", "s.json"],
        [],
        ["--sources", "s.json", "--history", "out/history.jsonl"],
    ],
    ids=["local-history", "local-sources", "neither", "history-in-output"],
)
def test_conflicting_arguments_stop_before_anything(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, args: list[str]
) -> None:
    _results(root, "alpha:test-unit", commit=SHA_A)
    monkeypatch.chdir(tmp_path)

    with pytest.raises(SystemExit) as raised:
        _main(root, "--output", "out", *args)

    assert raised.value.code == 2


# --- allurerc.mjs ---


def _config(env: dict[str, str]) -> dict[str, Any]:
    script = (
        f"const {{ default: c }} = await import({json.dumps(_CONFIG.as_uri())});"
        "process.stdout.write('\\n' + JSON.stringify(c));"
    )
    done = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=_REPO,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    # allure の import が、標準出力に見出しを書く。最後の行だけを読む
    return json.loads(done.stdout.splitlines()[-1])


def test_config_values() -> None:
    env = {k: v for k, v in os.environ.items() if k != generate.HISTORY_ENV}

    config = _config(env)

    assert config["name"] == "pecot テストレポート"
    assert config["historyLimit"] == 20
    assert config["flakyDetection"] == {"includePassedTests": True}
    assert config["plugins"] == {
        "awesome": {
            "options": {
                "groupBy": ["project", "lane", "parentSuite", "suite", "subSuite"],
                "reportLanguage": "ja",
            }
        }
    }
    assert "historyBaseUrl" not in config
    assert "historyPath" not in config


def test_config_takes_history_path_from_env(tmp_path: Path) -> None:
    env = {**os.environ, generate.HISTORY_ENV: str(tmp_path / "history.jsonl")}

    assert _config(env)["historyPath"] == str(tmp_path / "history.jsonl")


# --- 本物の allure generate ---


def _allure_result(uuid: str) -> dict[str, Any]:
    return {
        "uuid": uuid,
        "historyId": "h-1",
        "testCaseId": "t-1",
        "name": "足し算が合う",
        "fullName": "alpha/sum.test.ts#足し算が合う",
        "status": "passed",
        "stage": "finished",
        "start": 1_700_000_000_000,
        "stop": 1_700_000_000_010,
        "labels": [
            {"name": "project", "value": "alpha"},
            {"name": "lane", "value": "test-unit"},
        ],
    }


@pytest.mark.skipif(shutil.which("pnpm") is None, reason="pnpm が要る")
def test_real_allure_appends_history_and_recovers_from_unreadable_lines(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    results = root / _LANES[0]["results"]
    results.mkdir(parents=True)
    (results / "1-result.json").write_text(json.dumps(_allure_result("1")), encoding="utf-8")
    (results.parent / "source.json").write_text(
        json.dumps({"lane": "alpha:test-unit", "commit": SHA_A}), encoding="utf-8"
    )
    sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}])
    history = tmp_path / "store/history.jsonl"
    out = tmp_path / "report"

    def build() -> int:
        return generate.main(
            [
                "generate.py",
                "--sources",
                str(sources),
                "--output",
                str(out),
                "--history",
                str(history),
            ],  # fmt: skip
            root=root,
            lanes_path=root / "report-lanes.json",
        )

    assert build() == 0
    assert (out / "index.html").is_file()
    assert len(history.read_text(encoding="utf-8").splitlines()) == 1

    assert build() == 0
    assert len(history.read_text(encoding="utf-8").splitlines()) == 2

    with history.open("a", encoding="utf-8") as f:
        f.write("{oops\n")
    capsys.readouterr()
    assert build() == 0
    assert "履歴" in capsys.readouterr().err
    lines = history.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["name"].startswith("pecot テストレポート")
