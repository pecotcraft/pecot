"""test_report/generate.py のテスト。結果のそろいの判定・履歴の扱い・allure generate に渡す引数と、allurerc.mjs の値。

単体のケースは allure の起動（run）だけを差し替える。最後の節は、本物の allure generate を起こす。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/test_report"))

import generate  # noqa: E402
from attach import run_attached  # noqa: E402

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


class Ancestry:
    """git merge-base --is-ancestor の代わり。受けたコミットを残し、outside にあるものだけ祖先でないとする。"""

    def __init__(self, outside: tuple[str, ...] = ()) -> None:
        self.outside = outside
        self.calls: list[tuple[Path, str]] = []

    def __call__(self, root: Path, commit: str) -> bool:
        self.calls.append((root, commit))
        return commit not in self.outside


_GITHUB_ENV = ("GITHUB_STEP_SUMMARY", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_SERVER_URL")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(generate.HISTORY_ENV, raising=False)
    monkeypatch.delenv(generate.VARIABLES_ENV, raising=False)
    for key in _GITHUB_ENV:
        monkeypatch.delenv(key, raising=False)


def _results(root: Path, lane: str, *, count: int = 1, commit: str | None = None) -> Path:
    path = root / next(e["results"] for e in _LANES if f"{e['project']}:{e['target']}" == lane)
    path.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        (path / f"{lane.replace(':', '-')}-{i}-result.json").write_text("{}", encoding="utf-8")
    if commit is not None:
        source = {"lane": lane, "commit": commit}
        (path.parent / "source.json").write_text(json.dumps(source), encoding="utf-8")
    return path


def _sources(tmp_path: Path, runs: list[dict[str, Any]], side: str = "release") -> Path:
    path = tmp_path / "report-sources.json"
    path.write_text(json.dumps({"side": side, "runs": runs, "missing": []}), encoding="utf-8")
    return path


def _latest(lane: str, commit: str, run_id: int = 42) -> dict[str, Any]:
    return {
        "lane": lane,
        "commit": commit,
        "run_id": run_id,
        "from_run": run_id,
        "artifact": f"allure-results-{lane.replace(':', '-')}",
    }


def _dev_sources(tmp_path: Path, runs: list[dict[str, Any]], latest: list[dict[str, Any]]) -> Path:
    path = tmp_path / "report-sources.json"
    body = {"side": "dev", "runs": runs, "missing": [], "latest": latest}
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


def _same_lanes(root: Path, _commit: str) -> object:
    """コミットの report-lanes.json の代わり。どのコミットも、今のファイルと同じとする。"""
    return json.loads((root / "report-lanes.json").read_text(encoding="utf-8"))


def _main(
    root: Path,
    *args: str,
    run: Recorder | None = None,
    ancestry: Ancestry | None = None,
    lanes_at: Callable[[Path, str], object] = _same_lanes,
) -> tuple[int, Recorder]:
    recorder = run or Recorder()
    code = generate.main(
        ["generate.py", *args],
        root=root,
        lanes_path=root / "report-lanes.json",
        run=recorder,
        is_ancestor=ancestry or Ancestry(),
        lanes_at=lanes_at,
    )
    return code, recorder


# --- そろいの判定 ---


@allure.title(
    "`--local` で一部のレーンの結果が存在しないと、不足を表示し、残りのレーンでレポートを作る"
)
def test_local_names_missing_lanes_and_builds_from_the_rest(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`generate.py` を `--local` で実行し、1 つのレーンの結果だけが存在する場合のテストです。終了コードが 0 で、`allure generate` が存在するレーンの結果だけを受け取り、不足したレーンの名前が標準エラー出力に表示されることを確認します。"""
    with allure.step("一部のレーンだけに結果を置いて、ローカルで生成する"):
        alpha = _results(root, "alpha:test-unit")

        code, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    with allure.step("終了コードと allure の引数と欠けたレーンの出力を確かめる"):
        assert code == 0
        assert len(run.calls) == 1
        command = run.calls[0][0]
        assert command[-1] == str(alpha)
        assert str(root / _LANES[1]["results"]) not in command
        assert "beta:test-cli" in capsys.readouterr().err


@allure.title("`--local` で結果のファイルが存在しないレーンは、不足として扱う")
def test_local_counts_a_lane_without_result_files_as_missing(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """結果のディレクトリに `container.json` しかないレーンがある場合の、`--local` のテストです。そのレーンは不足として扱われ、`allure generate` に渡されず、標準エラー出力に名前が表示されることを確認します。"""
    with allure.step("結果のファイルが無いレーンを混ぜて、ローカルで生成する"):
        _results(root, "alpha:test-unit")
        empty = root / _LANES[1]["results"]
        empty.mkdir(parents=True)
        (empty / "x-container.json").write_text("{}", encoding="utf-8")

        code, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    with allure.step("空のレーンが欠けとして数えられることを確かめる"):
        assert code == 0
        assert str(empty) not in run.calls[0][0]
        assert "beta:test-cli" in capsys.readouterr().err


@allure.title(
    "`--local` ですべてのレーンの結果が存在しないと、`allure generate` を起動せずに失敗する"
)
def test_local_fails_when_no_lane_has_results(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """どのレーンにも結果が存在しない状態で、`--local` を指定した場合のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、標準エラー出力にレーンの名前が表示されることを確認します。"""
    with allure.step("結果が無い状態で、ローカルで生成する"):
        code, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と allure を動かさないことと欠けたレーンの出力を確かめる"):
        assert code == 1
        assert run.calls == []
        err = capsys.readouterr().err
        assert "alpha:test-unit" in err
        assert "beta:test-cli" in err


@allure.title(
    "`--sources` で指定したレーンの結果が不足すると、`allure generate` を起動せずに失敗する"
)
def test_sources_run_fails_on_missing_lane_without_running_allure(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """材料に含まれるレーンの結果が存在しない場合の、`--sources` のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、不足したレーンの名前が標準エラー出力に表示されることを確認します。"""
    with allure.step("レーンの 1 つに結果が無い状態で、元の指定で生成する"):
        _results(root, "alpha:test-unit", commit=SHA_A)
        empty = root / _LANES[1]["results"]
        empty.mkdir(parents=True)
        sources = _sources(
            tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit", "beta:test-cli"]}]
        )

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と allure を動かさないことを確かめる"):
        assert code == 1
        assert run.calls == []
        assert "beta:test-cli" in capsys.readouterr().err


# --- 起動の引数 ---


@allure.title(
    "`allure generate` の引数に、設定・出力先・`--clean`・結果のディレクトリをレーンの順に並べる"
)
def test_command_lists_config_output_clean_and_results_in_lane_order(
    root: Path, tmp_path: Path
) -> None:
    """`--sources` で `generate.py` を実行した場合のテストです。`allure generate` の引数が、`--config`・`--output`・`--clean` に続き、`report-lanes.json` のレーンの順で結果のディレクトリが並ぶことを確認します。"""
    with allure.step("結果を置いて、元の指定で生成する"):
        beta = _results(root, "beta:test-cli", commit=SHA_A)
        alpha = _results(root, "alpha:test-unit", commit=SHA_A)
        sources = _sources(
            tmp_path, [{"commit": SHA_A, "lanes": ["beta:test-cli", "alpha:test-unit"]}]
        )

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("allure の引数に設定・出力・clean・レーン順の結果が並ぶことを確かめる"):
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


@allure.title("出力先を相対パスで指定すると、作業ディレクトリを基準にした絶対パスで渡す")
def test_relative_output_is_resolved_from_the_working_directory(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--output report` のように相対パスを指定した場合のテストです。`allure generate` の `--output` に、作業ディレクトリの下の絶対パスが渡されることを確認します。"""
    with allure.step("作業ディレクトリを移して、相対の出力先で生成する"):
        _results(root, "alpha:test-unit")
        work = tmp_path / "work"
        work.mkdir()
        monkeypatch.chdir(work)

        _, run = _main(root, "--local", "--output", "report")

        command = run.calls[0][0]
    with allure.step("出力先が作業ディレクトリからの絶対パスになることを確かめる"):
        assert command[command.index("--output") + 1] == str(work / "report")


@allure.title("`--history` で指定した履歴は、環境変数に絶対パスで渡す")
def test_history_is_passed_by_env_as_an_absolute_path(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--history` に相対パスを指定した場合のテストです。`allure generate` の環境変数に、作業ディレクトリを基準にした絶対パスが設定されることを確認します。"""
    with allure.step("履歴の相対パスを付けて、元の指定で生成する"):
        _results(root, "alpha:test-unit", commit=SHA_A)
        sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}])
        monkeypatch.chdir(tmp_path)

        _, run = _main(
            root, "--sources", str(sources), "--output", "out", "--history", "store/history.jsonl"
        )

    with allure.step("履歴が環境変数で絶対パスとして渡ることを確かめる"):
        assert run.calls[0][1][generate.HISTORY_ENV] == str(tmp_path / "store/history.jsonl")


@allure.title("`--local` では、親の環境の履歴の指定を引き継がない")
def test_local_never_passes_history_from_the_parent_env(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """親の環境に履歴のパスが設定されている状態で、`--local` を指定した場合のテストです。`allure generate` の環境変数に、履歴のパスが含まれないことを確認します。"""
    with allure.step("親の環境に履歴のパスを置いて、ローカルで生成する"):
        _results(root, "alpha:test-unit")
        monkeypatch.setenv(generate.HISTORY_ENV, str(tmp_path / "leaked.jsonl"))

        _, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    with allure.step("親の履歴のパスが渡らないことを確かめる"):
        assert generate.HISTORY_ENV not in run.calls[0][1]


@allure.title("`allure generate` が失敗すると、その終了コードを返し、エラーを表示する")
def test_allure_failure_is_returned(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`allure generate` が終了コード 3 で終了する場合のテストです。`generate.py` が同じ終了コード 3 を返し、標準エラー出力に `allure generate` の失敗が表示されることを確認します。"""
    with allure.step("allure が失敗する状態で生成する"):
        _results(root, "alpha:test-unit")

        code, _ = _main(root, "--local", "--output", str(tmp_path / "out"), run=Recorder(code=3))

    with allure.step("終了コードと allure の失敗の出力を確かめる"):
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


@allure.title("履歴のファイルが存在しなくても、通知せずにそのままのパスを渡す")
def test_missing_history_is_passed_as_is_without_notice(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """指定した履歴のファイルが存在しない場合のテストです。終了コードが 0 で、`allure generate` に同じパスが渡され、ファイルは作成されず、標準エラー出力に履歴に関する通知が出ないことを確認します。"""
    with allure.step("履歴のファイルが無い状態で生成する"):
        history = tmp_path / "history.jsonl"

        code, run = _history_run(root, tmp_path, history)

    with allure.step("終了コードと履歴の渡し方と通知が無いことを確かめる"):
        assert code == 0
        assert run.calls[0][1][generate.HISTORY_ENV] == str(history)
        assert not history.exists()
        assert "履歴" not in capsys.readouterr().err


@allure.title("履歴に読めない行({param_id})があると、履歴を空にして、通知する")
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
    """不正な JSON・`NaN`・`null`・配列・UTF-8 でない行のいずれかを含む履歴で、`generate.py` を実行した場合のテストです。履歴のファイルが空になり、標準エラー出力とジョブのサマリーに履歴に関する通知が表示されることを確認します。"""
    with allure.step("読めない行を含む履歴を置いて生成する"):
        history = tmp_path / "history.jsonl"
        history.write_bytes(b'{"uuid": "1"}\n' + bad)
        summary = tmp_path / "summary.md"
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))

        code, _ = _history_run(root, tmp_path, history)

    with allure.step("終了コードと履歴が空になることと通知を確かめる"):
        assert code == 0
        assert history.read_bytes() == b""
        assert "履歴" in capsys.readouterr().err
        assert "履歴" in summary.read_text(encoding="utf-8")


@allure.title("履歴がすべて読めるときは、内容を変えず、通知もしない")
def test_readable_history_is_left_as_is(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """CRLF や空白だけの行を含む、読める履歴で `generate.py` を実行した場合のテストです。履歴のファイルの内容が変わらず、標準エラー出力に履歴に関する通知が出ないことを確認します。"""
    with allure.step("読める履歴を置いて生成する"):
        history = tmp_path / "history.jsonl"
        body = b'{"uuid": "1", "name": "a b"}\r\n\n  \n{"uuid": "2"}\n'
        history.write_bytes(body)

        code, _ = _history_run(root, tmp_path, history)

    with allure.step("終了コードと履歴が変わらないことと通知が無いことを確かめる"):
        assert code == 0
        assert history.read_bytes() == body
        assert "履歴" not in capsys.readouterr().err


class HistoryWriter(Recorder):
    """allure の代わりに、JSON.stringify と同じく U+2028・U+2029 をそのまま含む 1 行を足す。"""

    def __call__(self, command: list[str], env: dict[str, str]) -> int:
        with Path(env[generate.HISTORY_ENV]).open("a", encoding="utf-8") as f:
            f.write('{"uuid": "2", "name": "a\u2028b\u2029c"}\n')
        return super().__call__(command, env)


@allure.title("allure が書いた U+2028 と U+2029 は、エスケープして履歴に残す")
def test_line_separators_that_allure_writes_are_escaped(root: Path, tmp_path: Path) -> None:
    """`allure generate` の代わりに、U+2028 と U+2029 をそのまま含む行を追記する関数を使った場合のテストです。履歴のファイルでは両方がエスケープされ、読み直すと元の文字に戻り、履歴として読めることを確認します。"""
    with allure.step("allure が書く行区切りの文字を含む履歴を作る"):
        _results(root, "alpha:test-unit", commit=SHA_A)
        sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}])
        history = tmp_path / "history.jsonl"
        history.write_bytes(b'{"uuid": "1"}\n')

        code, _ = _main(
            root,
            "--sources", str(sources),
            "--output", str(tmp_path / "out"),
            "--history", str(history),
            run=HistoryWriter(),
        )  # fmt: skip

    with allure.step("行区切りがエスケープされて履歴が読めることを確かめる"):
        assert code == 0
        assert (
            history.read_bytes() == b'{"uuid": "1"}\n{"uuid": "2", "name": "a\\u2028b\\u2029c"}\n'
        )
        assert generate.read_history(history.read_bytes()) == []
        assert json.loads(_entries(history)[1])["name"] == "a\u2028b\u2029c"


@allure.title("単独の CR と U+2028 でも、Node の readline と同じ位置で行を区切る")
def test_lone_carriage_return_splits_lines_like_node_readline() -> None:
    """`read_history` が、行の区切りを Node の readline と同じに扱うかのテストです。CR のみ、CR の後ろの不正な行、U+2028 を含む行で、読めない行の番号が期待どおりになることを確認します。"""
    with allure.step(
        "単独の CR を含む履歴を読み、node の readline と同じ行の区切りになることを確かめる"
    ):
        assert generate.read_history(b'{"a": 1}\r{"b": 2}\n') == []
        assert generate.read_history(b'{"a": 1}\r{oops\n') == [2]
        # JSON.stringify は U+2028 をエスケープしないが、readline はそこで切る
        assert generate.read_history('{"a": "x\u2028y"}\n'.encode()) == [1, 2]


@allure.title("空行の判定は、JavaScript の `trim()` と同じにする")
def test_blank_lines_are_those_js_trim_empties() -> None:
    """`read_history` が、空行の判定を JavaScript の `trim()` に合わせているかのテストです。U+3000 と U+FEFF だけの行は空行として扱い、U+001C と U+0085 だけの行は読めない行として扱うことを確認します。"""
    with allure.step("JS の trim が空にする行を含む履歴を読み、空行の扱いを確かめる"):
        # JS の trim() は U+3000・U+FEFF を除き、\x1c・U+0085 を除かない（Python の strip() と違う）
        assert generate.read_history('{"a": 1}\n\u3000\ufeff\n'.encode()) == []
        assert generate.read_history(b'{"a": 1}\n\x1c\n') == [2]
        assert generate.read_history('{"a": 1}\n\u0085\n'.encode()) == [2]


# --- 材料（--sources） ---


@allure.title("`source.json` が材料と一致するとき、材料に載ったレーンの結果だけでレポートを作る")
def test_sources_with_matching_source_json_build_only_the_listed_lanes(
    root: Path, tmp_path: Path
) -> None:
    """2 つのレーンの結果があり、材料に 1 つのレーンだけが載っている場合の、`--sources` のテストです。`allure generate` が、材料に載ったレーンの結果だけを受け取ることを確認します。"""
    with allure.step("元の指定に一致する source.json を置いて生成する"):
        alpha = _results(root, "alpha:test-unit", commit=SHA_A)
        _results(root, "beta:test-cli", commit=SHA_A)
        sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}])

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("載せたレーンだけで作られることを確かめる"):
        assert code == 0
        assert run.calls[0][0][-1] == str(alpha)
        assert str(root / _LANES[1]["results"]) not in run.calls[0][0]


@allure.title("`source.json` が {param_id} のとき、レーンの名前を表示して失敗する")
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
    """結果の `source.json` が、存在しない・別のレーンを指す・別のコミットを指す・読めない、のいずれかの場合の、`--sources` のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、問題のあるレーンだけが名指しで表示されることを確認します。"""
    with allure.step("食い違う source.json を置いて生成する"):
        alpha = _results(root, "alpha:test-unit")
        if source == "not json":
            (alpha.parent / "source.json").write_text("{", encoding="utf-8")
        elif source is not None:
            (alpha.parent / "source.json").write_text(json.dumps(source), encoding="utf-8")
        _results(root, "beta:test-cli", commit=SHA_A)
        sources = _sources(
            tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit", "beta:test-cli"]}]
        )

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と食い違ったレーン名の出力を確かめる"):
        assert code == 1
        assert run.calls == []
        err = capsys.readouterr().err
        assert "alpha:test-unit" in err
        assert expected in err
        assert "  beta:test-cli:" not in err


@allure.title("複数の run のレーンは、それぞれの run のコミットで確認する")
def test_lanes_of_several_runs_are_checked_against_their_own_commit(
    root: Path, tmp_path: Path
) -> None:
    """材料に 2 つのコミットの run があり、レーンごとに別のコミットの `source.json` がある場合のテストです。終了コードが 0 になり、`allure generate` が 1 回だけ呼ばれることを確認します。"""
    with allure.step("複数の run の結果を別々の commit で置いて生成する"):
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

    with allure.step("終了コード 0 と allure が 1 回だけ動くことを確かめる"):
        assert code == 0
        assert len(run.calls) == 1


@allure.title("材料の形式が {param_id} のとき、メッセージを表示して失敗する")
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
    """未知のレーン、除外したレーン、重複したレーン、短いコミット、`lanes` の欠落、`runs` が配列でない場合の、`--sources` のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、原因が標準エラー出力に表示されることを確認します。"""
    with allure.step("不正な元の指定を書いて生成する"):
        _results(root, "alpha:test-unit", commit=SHA_A)
        path = tmp_path / "report-sources.json"
        body = {"side": "release", "runs": runs, "missing": []}
        path.write_text(json.dumps(body), encoding="utf-8")

        code, run = _main(root, "--sources", str(path), "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と allure を動かさないことと理由の出力を確かめる"):
        assert code == 1
        assert run.calls == []
        assert expected in capsys.readouterr().err


# --- 開発版の材料（latest） ---


def _dev_results(root: Path) -> None:
    _results(root, "alpha:test-unit", commit=SHA_A)
    _results(root, "beta:test-cli", commit=SHA_B)


@allure.title("開発版の材料の runs と latest のレーンを合わせて、1 つのレポートを作る")
def test_dev_sources_build_from_runs_and_latest(root: Path, tmp_path: Path) -> None:
    """`runs` に 1 レーン、`latest` に 1 レーンを持つ開発版の材料で、`generate.py` を実行した場合のテストです。両方のレーンの結果が `allure generate` に渡り、2 つのコミットを 1 回ずつ祖先か確認することを確認します。"""
    with allure.step("2 つのコミットの結果を置いて、開発版の材料で生成する"):
        _dev_results(root)
        sources = _dev_sources(
            tmp_path,
            [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            [_latest("beta:test-cli", SHA_B)],
        )
        ancestry = Ancestry()

        code, run = _main(
            root, "--sources", str(sources), "--output", str(tmp_path / "out"), ancestry=ancestry
        )

    with allure.step("終了コードと allure に渡る結果と祖先の確認を確かめる"):
        assert code == 0
        assert run.calls[0][0][-2:] == [
            str(root / _LANES[0]["results"]),
            str(root / _LANES[1]["results"]),
        ]
        assert ancestry.calls == [(root, SHA_A), (root, SHA_B)]


@allure.title(
    "開発版の材料の runs と latest が同じコミットを持つと、そのコミットを 1 回だけ確認する"
)
def test_dev_sources_check_each_commit_once(root: Path, tmp_path: Path) -> None:
    """`runs` と `latest` のレーンが同じコミットを持つ開発版の材料のテストです。祖先の確認が、そのコミットについて 1 回だけ呼ばれることを確認します。"""
    with allure.step("同じコミットの結果を置いて、開発版の材料で生成する"):
        _results(root, "alpha:test-unit", commit=SHA_A)
        _results(root, "beta:test-cli", commit=SHA_A)
        sources = _dev_sources(
            tmp_path,
            [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            [_latest("beta:test-cli", SHA_A)],
        )
        ancestry = Ancestry()

        code, _ = _main(
            root, "--sources", str(sources), "--output", str(tmp_path / "out"), ancestry=ancestry
        )

    with allure.step("祖先の確認が 1 回だけであることを確かめる"):
        assert code == 0
        assert ancestry.calls == [(root, SHA_A)]


@allure.title("開発版の材料の runs が空でも、latest にすべてのレーンがあればレポートを作る")
def test_dev_sources_with_only_latest_build(root: Path, tmp_path: Path) -> None:
    """`runs` が空で、`latest` にすべてのレーンを持つ開発版の材料のテストです。終了コードが 0 で、`allure generate` が両方のレーンの結果を受け取ることを確認します。"""
    with allure.step("latest だけの開発版の材料で生成する"):
        _dev_results(root)
        sources = _dev_sources(
            tmp_path,
            [],
            [_latest("alpha:test-unit", SHA_A), _latest("beta:test-cli", SHA_B)],
        )

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("両方のレーンで作られることを確かめる"):
        assert code == 0
        assert str(root / _LANES[0]["results"]) in run.calls[0][0]
        assert str(root / _LANES[1]["results"]) in run.calls[0][0]


@allure.title("開発版の材料にレポートのレーンが欠けると、欠けたレーンの名前を表示して失敗する")
def test_dev_sources_need_every_report_lane(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`runs` と `latest` を合わせても `beta:test-cli` が含まれない開発版の材料のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、欠けたレーンの名前が標準エラー出力に表示されることを確認します。"""
    with allure.step("1 レーンだけの開発版の材料で生成する"):
        _dev_results(root)
        sources = _dev_sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}], [])

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と欠けたレーンの出力を確かめる"):
        assert code == 1
        assert run.calls == []
        assert "開発版の材料に、レーン beta:test-cli がありません" in capsys.readouterr().err


@allure.title("材料の runs と latest に同じレーンがあると、そのレーンの名前を表示して失敗する")
def test_sources_refuse_a_lane_in_both_runs_and_latest(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`alpha:test-unit` が `runs` と `latest` の両方にある開発版の材料のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、重なったレーンの名前が表示されることを確認します。"""
    with allure.step("重なったレーンを持つ開発版の材料で生成する"):
        _dev_results(root)
        sources = _dev_sources(
            tmp_path,
            [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            [_latest("alpha:test-unit", SHA_A), _latest("beta:test-cli", SHA_B)],
        )

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と重なったレーンの出力を確かめる"):
        assert code == 1
        assert run.calls == []
        assert "alpha:test-unit が runs と latest の両方にあります" in capsys.readouterr().err


@allure.title(
    "材料の latest の形式が {param_id} のとき、レーンの名前とメッセージを表示して失敗する"
)
@pytest.mark.parametrize(
    ("latest", "expected"),
    [
        ("nope", "latest が配列ではありません"),
        (["x"], "latest #1 がオブジェクトではありません"),
        ([_latest("gamma:test-unit", SHA_A)], "gamma:test-unit は report-lanes.json にありません"),
        ([_latest("beta:test-bootstrap", SHA_A)], "beta:test-bootstrap は、レポートに入れない"),
        ([{**_latest("beta:test-cli", SHA_A), "lane": 1}], "文字列でないレーン"),
        ([_latest("beta:test-cli", "abc")], "latest #1 のレーン beta:test-cli の commit 'abc'"),
        ([_latest("beta:test-cli", SHA_A, 0)], "latest #1 のレーン beta:test-cli の run_id 0"),
        ([{**_latest("beta:test-cli", SHA_A), "run_id": True}], "の run_id True"),
        ([{**_latest("beta:test-cli", SHA_A), "run_id": "42"}], "の run_id '42'"),
        ([{**_latest("beta:test-cli", SHA_A), "from_run": None}], "の from_run None"),
        (
            [{**_latest("beta:test-cli", SHA_A), "artifact": ""}],
            "のレーン beta:test-cli の artifact",
        ),
        (
            [_latest("beta:test-cli", SHA_A), _latest("beta:test-cli", SHA_B)],
            "beta:test-cli が latest に 2 回あります",
        ),
    ],
    ids=[
        "not-list",
        "not-object",
        "unknown",
        "excluded",
        "lane-not-string",
        "short-commit",
        "zero-run",
        "bool-run",
        "string-run",
        "no-from-run",
        "empty-artifact",
        "twice",
    ],
)
def test_bad_latest_stops_with_a_message(
    root: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    latest: object,
    expected: str,
) -> None:
    """配列でない・オブジェクトでない・未知のレーン・除外したレーン・短いコミット・正の整数でない run・空の artifact・重複したレーンを含む `latest` の、開発版の材料のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、原因が表示されることを確認します。"""
    with allure.step("不正な latest を持つ開発版の材料で生成する"):
        _dev_results(root)
        path = tmp_path / "report-sources.json"
        body = {
            "side": "dev",
            "runs": [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            "missing": [],
            "latest": latest,
        }
        path.write_text(json.dumps(body), encoding="utf-8")

        code, run = _main(root, "--sources", str(path), "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と allure を動かさないことと理由の出力を確かめる"):
        assert code == 1
        assert run.calls == []
        assert expected in capsys.readouterr().err


@allure.title("材料の side が {param_id} のとき、メッセージを表示して失敗する")
@pytest.mark.parametrize(
    ("side", "latest", "expected"),
    [
        ("pr", [], "side 'pr' が dev と release のどちらでもありません"),
        (None, [], "side None が dev と release のどちらでもありません"),
        ("release", [_latest("beta:test-cli", SHA_B)], "リリース版の材料に latest があります"),
    ],
    ids=["other-side", "no-side", "release-with-latest"],
)
def test_sources_side_must_be_dev_or_release(
    root: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    side: str | None,
    latest: list[dict[str, Any]],
    expected: str,
) -> None:
    """`side` が `pr` の材料、`side` が無い材料、`latest` を持つリリース版の材料のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、原因が表示されることを確認します。"""
    with allure.step("side が不正な材料で生成する"):
        _dev_results(root)
        path = tmp_path / "report-sources.json"
        body: dict[str, Any] = {
            "runs": [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            "latest": latest,
        }
        if side is not None:
            body["side"] = side
        path.write_text(json.dumps(body), encoding="utf-8")

        code, run = _main(root, "--sources", str(path), "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と理由の出力を確かめる"):
        assert code == 1
        assert run.calls == []
        assert expected in capsys.readouterr().err


# タグのコミットにだけある、今の report-lanes.json から消えたレーン
_OLD_LANE = {
    "project": "beta",
    "target": "test-old",
    "plugin": "beta",
    "results": "beta/test-results/test-old/allure-results",
}


class TagLanes:
    """コミットの report-lanes.json の代わり。コミットごとの表を返し、読んだコミットを残す。"""

    def __init__(self, by_commit: dict[str, object]) -> None:
        self.by_commit = by_commit
        self.calls: list[str] = []

    def __call__(self, _root: Path, commit: str) -> object:
        self.calls.append(commit)
        if commit not in self.by_commit:
            raise generate.InputError(f"{commit[:7]} の report-lanes.json を読めません")
        return self.by_commit[commit]


def _lane_results(root: Path, entry: dict[str, str], commit: str) -> Path:
    lane = f"{entry['project']}:{entry['target']}"
    path = root / entry["results"]
    path.mkdir(parents=True, exist_ok=True)
    (path / f"{lane.replace(':', '-')}-0-result.json").write_text("{}", encoding="utf-8")
    source = {"lane": lane, "commit": commit}
    (path.parent / "source.json").write_text(json.dumps(source), encoding="utf-8")
    return path


@allure.title(
    "リリース版では、今の report-lanes.json に無いレーンも、run のコミットの表から結果を読む"
)
def test_release_sources_read_lanes_from_each_run_commit(root: Path, tmp_path: Path) -> None:
    """今の `report-lanes.json` から消えたレーンを、タグのコミットで動かしたリリース版の材料のテストです。同じコミットの run が 2 つあっても表は 1 回だけ読むことを確認します。消えたレーンの結果も `allure generate` に渡します。"""
    with allure.step("タグのコミットにだけあるレーンの結果を置き、リリース版の材料で生成する"):
        old = _lane_results(root, _OLD_LANE, SHA_A)
        cli = _results(root, "beta:test-cli", commit=SHA_A)
        alpha = _results(root, "alpha:test-unit", commit=SHA_B)
        lanes_at = TagLanes({SHA_A: [*_LANES, _OLD_LANE], SHA_B: _LANES})
        sources = _sources(
            tmp_path,
            [
                {"commit": SHA_A, "lanes": ["beta:test-cli"]},
                {"commit": SHA_B, "lanes": ["alpha:test-unit"]},
                {"commit": SHA_A, "lanes": ["beta:test-old"]},
            ],
        )

        code, run = _main(
            root, "--sources", str(sources), "--output", str(tmp_path / "out"), lanes_at=lanes_at
        )

    with allure.step("消えたレーンを含む 3 つの結果で allure が動くことを確かめる"):
        assert code == 0
        assert lanes_at.calls == [SHA_A, SHA_B]
        command = run.calls[0][0]
        assert {str(alpha), str(cli), str(old)} <= set(command)


@allure.title("リリース版で run のコミットの表が {param_id} のとき、コミットを示して失敗する")
@pytest.mark.parametrize(
    ("by_commit", "expected"),
    [
        (
            {SHA_A: _LANES},
            "材料のレーン beta:test-old は aaaaaaa の report-lanes.json にありません",
        ),
        ({}, "aaaaaaa の report-lanes.json を読めません"),
        (
            {SHA_A: {"lanes": []}},
            "aaaaaaa の report-lanes.json: report-lanes.json: レーンの配列ではありません",
        ),
    ],
    ids=["レーンが無い", "読めない", "形が違う"],
)
def test_release_sources_name_the_commit_whose_lanes_do_not_fit(
    root: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    by_commit: dict[str, object],
    expected: str,
) -> None:
    """リリース版の材料の run のコミットで、`report-lanes.json` の中にレーンが無い場合と、ファイルを読めない・形の違う場合のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、コミットの 7 桁を含む原因が表示されることを確認します。"""
    with allure.step("表の合わないコミットを持つリリース版の材料で生成する"):
        _lane_results(root, _OLD_LANE, SHA_A)
        sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["beta:test-old"]}])

        code, run = _main(
            root,
            "--sources",
            str(sources),
            "--output",
            str(tmp_path / "out"),
            lanes_at=TagLanes(by_commit),
        )

    with allure.step("終了コード 1 と allure を動かさないことと理由の出力を確かめる"):
        assert code == 1
        assert run.calls == []
        assert expected in capsys.readouterr().err


@allure.title("開発版では、run のコミットの表を読まず、今の report-lanes.json でレーンを確かめる")
def test_dev_sources_use_the_current_lanes(root: Path, tmp_path: Path) -> None:
    """開発版の材料で、コミットの `report-lanes.json` をどのコミットからも読めない場合のテストです。その関数を呼ばずに、今の `report-lanes.json` でレーンを確かめ、レポートを作ることを確認します。"""
    with allure.step("どのコミットの表も読めない状態で、開発版の材料で生成する"):
        _dev_results(root)
        lanes_at = TagLanes({})
        sources = _dev_sources(
            tmp_path,
            [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            [_latest("beta:test-cli", SHA_B)],
        )

        code, _ = _main(
            root, "--sources", str(sources), "--output", str(tmp_path / "out"), lanes_at=lanes_at
        )

    with allure.step("成功し、コミットの表を読まないことを確かめる"):
        assert code == 0
        assert lanes_at.calls == []


@allure.title("git から、コミットの report-lanes.json を読み、無いコミットは読めないと伝える")
def test_git_lanes_at_reads_the_file_of_a_commit(
    git_repo: Callable[..., Path], git: Callable[..., subprocess.CompletedProcess]
) -> None:
    """`git_lanes_at` のテストです。`report-lanes.json` を置いたコミットからはその中身を読み、置く前のコミットでは、7 桁のコミットを含む `InputError` が発生することを確認します。"""
    with allure.step("report-lanes.json の無いコミットと、あるコミットを作る"):
        repo = git_repo()
        git(repo, "commit", "-q", "--allow-empty", "-m", "空")
        before = git(repo, "rev-parse", "HEAD").stdout.strip()
        path = repo / generate.LANES_IN_REPO
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(_LANES), encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "表")
        after = git(repo, "rev-parse", "HEAD").stdout.strip()

    with allure.step("あるコミットは中身を返し、無いコミットは読めないと伝えることを確かめる"):
        assert generate.git_lanes_at(repo, after) == _LANES
        with pytest.raises(
            generate.InputError, match=f"{before[:7]} の report-lanes.json を読めません"
        ):
            generate.git_lanes_at(repo, before)


@allure.title("開発版の材料のコミットが HEAD の祖先でないと、そのレーンの名前を表示して失敗する")
def test_dev_sources_refuse_a_commit_outside_head(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`latest` のレーンのコミットが HEAD の祖先でない開発版の材料のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、祖先でないレーンだけが名指しで表示されることを確認します。"""
    with allure.step("祖先でないコミットを含む開発版の材料で生成する"):
        _dev_results(root)
        sources = _dev_sources(
            tmp_path,
            [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            [_latest("beta:test-cli", SHA_B)],
        )

        code, run = _main(
            root,
            "--sources", str(sources),
            "--output", str(tmp_path / "out"),
            ancestry=Ancestry(outside=(SHA_B,)),
        )  # fmt: skip

    with allure.step("終了コード 1 と祖先でないレーンの出力を確かめる"):
        assert code == 1
        assert run.calls == []
        err = capsys.readouterr().err
        assert f"beta:test-cli: コミット {SHA_B} が HEAD の祖先ではありません" in err
        assert "alpha:test-unit:" not in err


@allure.title("リリース版の材料では、コミットが HEAD の祖先かを確認しない")
def test_release_sources_do_not_check_ancestry(root: Path, tmp_path: Path) -> None:
    """HEAD の祖先でないコミットを持つ、リリース版の材料のテストです。祖先の確認を呼ばずにレポートを作ることを確認します。"""
    with allure.step("リリース版の材料で生成する"):
        _results(root, "alpha:test-unit", commit=SHA_A)
        sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}])
        ancestry = Ancestry(outside=(SHA_A,))

        code, run = _main(
            root, "--sources", str(sources), "--output", str(tmp_path / "out"), ancestry=ancestry
        )

    with allure.step("祖先を確認せずに作ることを確かめる"):
        assert code == 0
        assert len(run.calls) == 1
        assert ancestry.calls == []


@allure.title(
    "開発版の latest のレーンの `source.json` が材料と違うと、そのレーンの名前を表示して失敗する"
)
def test_dev_sources_check_source_json_of_latest_lanes(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`latest` の `beta:test-cli` の `source.json` が、材料と別のコミットを指す開発版の材料のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、そのレーンが名指しで表示されることを確認します。"""
    with allure.step("latest のレーンに食い違う source.json を置いて生成する"):
        _results(root, "alpha:test-unit", commit=SHA_A)
        _results(root, "beta:test-cli", commit=SHA_A)
        sources = _dev_sources(
            tmp_path,
            [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            [_latest("beta:test-cli", SHA_B)],
        )

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と食い違ったレーンの出力を確かめる"):
        assert code == 1
        assert run.calls == []
        err = capsys.readouterr().err
        assert f"beta:test-cli: source.json は beta:test-cli の {SHA_A}" in err
        assert "  alpha:test-unit:" not in err


@allure.title("開発版の材料に `--history` を付けると、`allure generate` を起動せずに失敗する")
def test_dev_sources_refuse_history(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """開発版の材料に `--history` を付けて `generate.py` を実行した場合のテストです。終了コードが 1 になり、`allure generate` が呼ばれず、履歴はリリース版だけである旨が表示されることを確認します。"""
    with allure.step("開発版の材料に履歴を付けて生成する"):
        _dev_results(root)
        sources = _dev_sources(
            tmp_path,
            [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            [_latest("beta:test-cli", SHA_B)],
        )

        code, run = _main(
            root,
            "--sources", str(sources),
            "--output", str(tmp_path / "out"),
            "--history", str(tmp_path / "history.jsonl"),
        )  # fmt: skip

    with allure.step("終了コード 1 と理由の出力を確かめる"):
        assert code == 1
        assert run.calls == []
        assert "開発版の材料には --history を渡せません" in capsys.readouterr().err


@allure.title("`git_is_ancestor` は、HEAD の祖先のコミットだけを祖先とする")
def test_git_is_ancestor_follows_head(
    git_repo: Callable[..., Path],
    git: Callable[..., Any],
    git_rev_parse: Callable[..., str],
) -> None:
    """main の 2 つのコミットと、ほかのブランチのコミットを持つ git のリポで、`git_is_ancestor` を呼んだテストです。HEAD とその親は祖先で、ほかのブランチのコミットと存在しないコミットは祖先でないことを確認します。"""
    with allure.step("main の 2 つのコミットと、ほかのブランチのコミットを作る"):
        repo = git_repo(initial_branch="main")
        git(repo, "commit", "-q", "--allow-empty", "-m", "c1")
        first = git_rev_parse(repo)
        git(repo, "checkout", "-q", "-b", "topic")
        git(repo, "commit", "-q", "--allow-empty", "-m", "topic")
        topic = git_rev_parse(repo)
        git(repo, "checkout", "-q", "main")
        git(repo, "commit", "-q", "--allow-empty", "-m", "c2")
        head = git_rev_parse(repo)
    with allure.step("祖先かどうかの判定を確かめる"):
        assert generate.git_is_ancestor(repo, head) is True
        assert generate.git_is_ancestor(repo, first) is True
        assert generate.git_is_ancestor(repo, topic) is False
        assert generate.git_is_ancestor(repo, "c" * 40) is False


# --- レポートの変数 ---


@allure.title(
    "開発版の変数は、runs のレーンにこの run、latest のレーンに試した run の URL を付ける"
)
def test_dev_variables_name_the_run_of_each_lane(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`GITHUB_REPOSITORY` と `GITHUB_RUN_ID` がある環境で、開発版の材料から `generate.py` を実行した場合のテストです。環境変数 `PECOT_REPORT_VARIABLES` に、レーンごとのコミットと run の URL が JSON で渡ることを確認します。"""
    with allure.step("GitHub の環境変数を置いて、開発版の材料で生成する"):
        _dev_results(root)
        sources = _dev_sources(
            tmp_path,
            [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            [_latest("beta:test-cli", SHA_B, 456)],
        )
        monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
        monkeypatch.setenv("GITHUB_RUN_ID", "123")

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("変数の JSON を確かめる"):
        assert code == 0
        assert json.loads(run.calls[0][1][generate.VARIABLES_ENV]) == {
            "alpha:test-unit": f"{SHA_A} https://github.com/owner/repo/actions/runs/123",
            "beta:test-cli": f"{SHA_B} https://github.com/owner/repo/actions/runs/456",
        }


@allure.title("リリース版の変数は、{param_id} の環境で、runs のコミットとこの run の URL を付ける")
@pytest.mark.parametrize(
    ("env", "expected"),
    [
        (
            {
                "GITHUB_SERVER_URL": "https://ghe.example",
                "GITHUB_REPOSITORY": "o/r",
                "GITHUB_RUN_ID": "9",
            },
            f"{SHA_A} https://ghe.example/o/r/actions/runs/9",
        ),
        ({"GITHUB_RUN_ID": "9"}, SHA_A),
        ({"GITHUB_REPOSITORY": "o/r"}, SHA_A),
    ],
    ids=["server-url", "no-repository", "no-run-id"],
)
def test_release_variables_use_the_commit_of_runs(
    root: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    env: dict[str, str],
    expected: str,
) -> None:
    """GitHub の環境変数の有無を変えて、リリース版の材料から `generate.py` を実行した場合のテストです。サーバーの URL を使い、リポか run が無い場合はコミットだけを変数に渡すことを確認します。"""
    with allure.step("GitHub の環境変数を置いて、リリース版の材料で生成する"):
        _results(root, "alpha:test-unit", commit=SHA_A)
        sources = _sources(tmp_path, [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}])
        for key, value in env.items():
            monkeypatch.setenv(key, value)

        code, run = _main(root, "--sources", str(sources), "--output", str(tmp_path / "out"))

    with allure.step("変数の JSON を確かめる"):
        assert code == 0
        assert json.loads(run.calls[0][1][generate.VARIABLES_ENV]) == {"alpha:test-unit": expected}


@allure.title("`--local` では、変数を渡さず、親の環境の変数も引き継がない")
def test_local_never_passes_variables(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """親の環境に `PECOT_REPORT_VARIABLES` がある状態で、`--local` を指定した場合のテストです。`allure generate` の環境変数に、`PECOT_REPORT_VARIABLES` が含まれないことを確認します。"""
    with allure.step("親の環境に変数を置いて、ローカルで生成する"):
        _results(root, "alpha:test-unit")
        monkeypatch.setenv(generate.VARIABLES_ENV, '{"leaked": "x"}')
        monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")

        _, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    with allure.step("変数が渡らないことを確かめる"):
        assert generate.VARIABLES_ENV not in run.calls[0][1]


# --- 引数の誤り ---


@allure.title("引数の組み合わせが {param_id} のとき、何も実行せずに終了コード 2 で終了する")
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
    """`--local` と `--history` の併用、`--local` と `--sources` の併用、指定なし、履歴を出力先の中に置く場合のテストです。`SystemExit` の終了コードが 2 になることを確認します。"""
    with allure.step("結果を置いて作業ディレクトリを移す"):
        _results(root, "alpha:test-unit", commit=SHA_A)
        monkeypatch.chdir(tmp_path)

    with allure.step("競合する引数で動かし、終了コード 2 で止まることを確かめる"):
        with pytest.raises(SystemExit) as raised:
            _main(root, "--output", "out", *args)

        assert raised.value.code == 2


# --- 環境の情報（environment.properties） ---


def _environment(root: Path, lane: str, text: str) -> None:
    (_results(root, lane) / generate.ENVIRONMENT_FILE).write_text(text, encoding="utf-8")


class EnvironmentRecorder(Recorder):
    """allure の代わりに、最後に渡された結果のディレクトリの environment.properties を読んで残す。"""

    def __init__(self) -> None:
        super().__init__()
        self.environment: str | None = None

    def __call__(self, command: list[str], env: dict[str, str]) -> int:
        path = Path(command[-1]) / generate.ENVIRONMENT_FILE
        self.environment = path.read_text(encoding="utf-8") if path.is_file() else None
        return super().__call__(command, env)


@allure.title(
    "非 ASCII の値・区切りの文字を含むキー・先頭の空白を、エスケープして書き、同じ値に読み戻す"
)
def test_environment_round_trips_through_properties(tmp_path: Path) -> None:
    """`write_environment` と `read_environment` のテストです。日本語や絵文字の値と、`:`・`=`・`\\` を含むキーを、allure-js-commons と同じエスケープで書き、読み戻すと元の値と一致することを確認します。"""
    with allure.step("非 ASCII の値と区切りの文字を含むキーを書く"):
        environment = {
            "OS": "Ubuntu 26.04.1 LTS",
            "a:b=c": "  先頭の空白",
            "x\\y": "タブ\tと😀",
        }
        path = tmp_path / generate.ENVIRONMENT_FILE

        generate.write_environment(path, environment)

    with allure.step("書いた文字列と、読み戻した値を比べる"):
        assert path.read_text(encoding="utf-8") == (
            "OS=Ubuntu 26.04.1 LTS\n"
            "a\\:b\\=c=\\ \\ \\u5148\\u982d\\u306e\\u7a7a\\u767d\n"
            "x\\\\y=\\u30bf\\u30d6\\t\\u3068\\ud83d\\ude00"
        )
        assert generate.read_environment(path) == environment


@allure.title("コメント・区切りの種類・行の継続・エスケープを、Allure の読み方と同じに読む")
def test_environment_reads_comments_separators_and_continuations(tmp_path: Path) -> None:
    """Java の properties の形で書いた `environment.properties` を `read_environment` で読む場合のテストです。`#` と `!` のコメント、`=`・`:`・空白の区切り、行末の `\\` による継続、`\\u` などのエスケープが、Allure の `parseProperties` と同じ値になることを確認します。"""
    with allure.step("いろいろな書き方の properties を置いて読む"):
        path = tmp_path / generate.ENVIRONMENT_FILE
        path.write_bytes(
            b"# comment=1\r\n"
            b"  ! comment=2\n"
            b"OS = Ubuntu\n"
            b"Node.js:v24\n"
            b"Python   3.12\n"
            b"long=first \\\n"
            b"     second\n"
            b"escaped=\\u3042\\n\\\\\\ x\n"
            b"\n"
            b"empty=\n"
        )

        environment = generate.read_environment(path)

    with allure.step("読んだキーと値を比べる"):
        assert environment == {
            "OS": "Ubuntu",
            "Node.js": "v24",
            "Python": "3.12",
            "long": "first second",
            "escaped": "あ\n\\ x",
            "empty": "",
        }


@allure.title("全レーンで値が同じキーを残し、OS・Node.js・Python の後に名前順で並べる")
def test_merge_keeps_keys_with_one_value_in_fixed_order() -> None:
    """一部のレーンにしか無いキーを含む環境の情報を、`merge_environments` でまとめる場合のテストです。値が 1 つに決まるキーがすべて残り、`OS`・`Node.js`・`Python` の後にほかのキーが名前順で並び、値の違うキーが存在しないことを確認します。"""
    with allure.step("レーンごとの環境の情報をまとめる"):
        merged, differing = generate.merge_environments(
            [
                {"ホスト": "開発機", "Node.js": "v24", "OS": "Ubuntu"},
                {"Python": "3.12", "OS": "Ubuntu", "Arch": "x64"},
            ]
        )

    with allure.step("まとめた値とキーの順を比べる"):
        assert list(merged.items()) == [
            ("OS", "Ubuntu"),
            ("Node.js", "v24"),
            ("Python", "3.12"),
            ("Arch", "x64"),
            ("ホスト", "開発機"),
        ]
        assert differing == []


@allure.title("レーンで値の違うキーは、まとめから除き、その名前を名前順で返す")
def test_merge_drops_keys_whose_values_differ() -> None:
    """3 つのレーンのうち、一部で値の違うキーがある環境の情報を、`merge_environments` でまとめる場合のテストです。値の違うキーがまとめに含まれず、その名前が名前順で返ることを確認します。"""
    with allure.step("値の違うキーを含む環境の情報をまとめる"):
        merged, differing = generate.merge_environments(
            [
                {"OS": "Ubuntu", "Python": "3.12", "Node.js": "v24"},
                {"OS": "Ubuntu", "Python": "3.14"},
                {"OS": "Ubuntu", "Node.js": "v22"},
            ]
        )

    with allure.step("残ったキーと、値の違うキーの名前を比べる"):
        assert merged == {"OS": "Ubuntu"}
        assert differing == ["Node.js", "Python"]


@allure.title(
    "まとめた環境の情報を、`--output` の外の一時のディレクトリに書いて最後に渡し、実行の後で消す"
)
def test_main_passes_merged_environment_last_and_removes_it(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """2 つのレーンが `environment.properties` を持ち、`Node.js` の値だけが違う場合の、`generate.py` のテストです。`allure generate` が最後に受け取るディレクトリが `--output` の外にあって共通の値だけを持ち、実行の後で削除され、値の違うキーが表示されることを確認します。"""
    with allure.step("値の一部が違う環境の情報を 2 つのレーンに置いて生成する"):
        alpha = _results(root, "alpha:test-unit")
        beta = _results(root, "beta:test-cli")
        _environment(root, "alpha:test-unit", "OS=Ubuntu\nNode.js=v24\n")
        _environment(root, "beta:test-cli", "OS=Ubuntu\nNode.js=v22\n")
        output = tmp_path / "reports/out"
        recorder = EnvironmentRecorder()

        code, _ = _main(root, "--local", "--output", str(output), run=recorder)

    with allure.step("渡したディレクトリの場所・中身・後始末と、標準エラー出力を確かめる"):
        assert code == 0
        command = recorder.calls[0][0]
        merged = Path(command[-1])
        assert command[-3:-1] == [str(alpha), str(beta)]
        assert merged.parent == output.parent
        assert not merged.is_relative_to(output)
        assert recorder.environment == "OS=Ubuntu"
        assert not merged.exists()
        assert "メタデータに出さないキー: Node.js" in capsys.readouterr().err


@allure.title("一部のレーンにしか `environment.properties` が無いと、あるレーンの値だけでまとめる")
def test_main_merges_only_lanes_with_an_environment_file(root: Path, tmp_path: Path) -> None:
    """1 つのレーンだけが `environment.properties` を持つ場合の、`generate.py` のテストです。最後に渡すディレクトリの `environment.properties` が、そのレーンの値と同じになることを確認します。"""
    with allure.step("1 つのレーンだけに環境の情報を置いて生成する"):
        _results(root, "beta:test-cli")
        _environment(root, "alpha:test-unit", "OS=Ubuntu\nNode.js=v24\n")
        recorder = EnvironmentRecorder()

        code, _ = _main(root, "--local", "--output", str(tmp_path / "out"), run=recorder)

    with allure.step("最後に渡したディレクトリの環境の情報を比べる"):
        assert code == 0
        assert recorder.environment == "OS=Ubuntu\nNode.js=v24"


@allure.title(
    "どのキーもレーンで値が違うと、コメントだけの環境の情報を最後に渡し、レーンの値を出さない"
)
def test_main_passes_comment_only_environment_when_no_key_is_shared(
    root: Path, tmp_path: Path
) -> None:
    """2 つのレーンの `environment.properties` が、どのキーも違う値を持つ場合の、`generate.py` のテストです。最後に渡すディレクトリの `environment.properties` が、キーを持たないコメントだけの内容になることを確認します。"""
    with allure.step("どのキーも値の違う環境の情報を 2 つのレーンに置いて生成する"):
        _results(root, "alpha:test-unit")
        _results(root, "beta:test-cli")
        _environment(root, "alpha:test-unit", "OS=Ubuntu\n")
        _environment(root, "beta:test-cli", "OS=Debian\n")
        recorder = EnvironmentRecorder()

        code, _ = _main(root, "--local", "--output", str(tmp_path / "out"), run=recorder)

    with allure.step("最後に渡したディレクトリの環境の情報がキーを持たないことを確かめる"):
        assert code == 0
        assert recorder.environment is not None
        assert recorder.environment.startswith("#")
        assert generate.parse_properties(recorder.environment) == {}


@allure.title("どのレーンにも `environment.properties` が無いと、追加のディレクトリを渡さない")
def test_main_passes_no_extra_directory_without_environment_files(
    root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """どのレーンも `environment.properties` を持たない場合の、`generate.py` のテストです。`allure generate` に、レーンの結果のディレクトリだけが渡され、値の違うキーの通知も表示されないことを確認します。"""
    with allure.step("環境の情報の無いレーンで生成する"):
        alpha = _results(root, "alpha:test-unit")
        beta = _results(root, "beta:test-cli")

        code, run = _main(root, "--local", "--output", str(tmp_path / "out"))

    with allure.step("結果のディレクトリがレーンの分だけであることを確かめる"):
        assert code == 0
        assert run.calls[0][0][-3:] == ["--clean", str(alpha), str(beta)]
        assert "メタデータ" not in capsys.readouterr().err


# --- allurerc.mjs ---


def _read_config(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """allurerc.mjs の export と、Allure の readConfig が解いた値を、標準出力の最後の行に書く node。"""
    script = (
        f"const {{ default: raw }} = await import({json.dumps(_CONFIG.as_uri())});"
        "const { readConfig } = await import('@allurereport/core');"
        f"const r = await readConfig(process.cwd(), {json.dumps(str(_CONFIG))});"
        "const { normalizeCategoriesConfig } = await import('@allurereport/core-api');"
        "const categories = normalizeCategoriesConfig(r.categories)"
        ".map(({ id, name, groupBy }) => ({ id, name, groupBy }));"
        "const resolved = { name: r.name, historyPath: r.historyPath ?? null,"
        " historyLimit: r.historyLimit, historyBaseUrl: r.historyBaseUrl ?? null,"
        " flakyDetection: r.flakyDetection, categories, variables: r.variables };"
        "process.stdout.write('\\n' + JSON.stringify({ raw, resolved }));"
    )
    # -e の import は作業ディレクトリから解く。@allurereport/core は allure の依存なので、allure の実体から解く
    return run_attached(
        ["node", "--input-type=module", "-e", script],
        cwd=(_REPO / "node_modules/allure").resolve(),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def _config(env: dict[str, str]) -> dict[str, Any]:
    done = _read_config(env)
    assert done.returncode == 0, done.stderr
    # allure の import が、標準出力に見出しを書く。最後の行だけを読む
    return json.loads(done.stdout.splitlines()[-1])


def _base_env() -> dict[str, str]:
    return {
        k: v
        for k, v in os.environ.items()
        if k not in (generate.HISTORY_ENV, generate.VARIABLES_ENV)
    }


@allure.title("allurerc.mjs は、グループの順・言語・履歴の上限などを期待する値で設定する")
def test_config_values() -> None:
    """`allurerc.mjs` の設定のテストです。`awesome` プラグインの `groupBy` と `reportLanguage`、Allure が解いた名前・履歴の上限・不安定なテストの検出・失敗の分類の設定が、期待する値であることを確認します。"""
    with allure.step("allure の設定を読む"):
        config = _config(_base_env())

    with allure.step("設定の値を確かめる"):
        assert config["raw"]["plugins"] == {
            "awesome": {
                "options": {
                    "groupBy": ["epic", "feature", "story"],
                    "reportLanguage": "ja",
                }
            }
        }
        assert config["resolved"] == {
            "name": "pecot テストレポート",
            "historyPath": None,
            "historyLimit": 10,
            "historyBaseUrl": None,
            "flakyDetection": {"includePassedTests": True},
            # 既定の 2 つは後ろに足されるが、書いた規則が failed・broken をすべて取るので、結果が入らず画面に出ない。
            "categories": [
                {
                    "id": "flaky",
                    "name": "不安定なテスト",
                    "groupBy": [{"label": "epic"}, "severity"],
                },
                {
                    "id": "product-errors",
                    "name": "製品の不具合",
                    "groupBy": [{"label": "epic"}, "severity"],
                },
                {
                    "id": "test-errors",
                    "name": "テストの不具合",
                    "groupBy": [{"label": "epic"}, "severity"],
                },
                {"id": "_product_errors_default_category", "name": "Product errors", "groupBy": []},
                {"id": "_test_errors_default_category", "name": "Test errors", "groupBy": []},
            ],
            "variables": {},
        }
        assert config["raw"]["categories"] == {
            "rules": [
                {
                    "id": "flaky",
                    "name": "不安定なテスト",
                    "matchers": {"statuses": ["failed", "broken"], "flaky": True},
                    "groupBy": [{"label": "epic"}, "severity"],
                },
                {
                    "id": "product-errors",
                    "name": "製品の不具合",
                    "matchers": {"statuses": ["failed"]},
                    "groupBy": [{"label": "epic"}, "severity"],
                },
                {
                    "id": "test-errors",
                    "name": "テストの不具合",
                    "matchers": {"statuses": ["broken"]},
                    "groupBy": [{"label": "epic"}, "severity"],
                },
            ]
        }
        assert "variables" not in config["raw"]


@allure.title("履歴のパスは、環境変数から取得する")
def test_config_takes_history_path_from_env(tmp_path: Path) -> None:
    """環境変数に履歴のパスを設定して、`allurerc.mjs` を Allure に読ませた場合のテストです。解決した設定の `historyPath` が、環境変数の値と一致することを確認します。"""
    with allure.step("環境変数に履歴のパスを置いて設定を読む"):
        env = {**_base_env(), generate.HISTORY_ENV: str(tmp_path / "history.jsonl")}

    with allure.step("履歴のパスが環境変数の値になることを確かめる"):
        assert _config(env)["resolved"]["historyPath"] == str(tmp_path / "history.jsonl")


@allure.title("レポートの変数は、環境変数の JSON から取得する")
def test_config_takes_variables_from_env() -> None:
    """環境変数 `PECOT_REPORT_VARIABLES` にレーンごとの値の JSON を設定して、`allurerc.mjs` を Allure に読ませた場合のテストです。解決した設定の `variables` が、JSON の値と一致することを確認します。"""
    with allure.step("環境変数に変数の JSON を置いて設定を読む"):
        variables = {"alpha:test-unit": f"{SHA_A} https://github.com/o/r/actions/runs/1"}
        env = {**_base_env(), generate.VARIABLES_ENV: json.dumps(variables)}

        config = _config(env)

    with allure.step("変数が環境変数の値になることを確かめる"):
        assert config["resolved"]["variables"] == variables


@allure.title("レポートの変数の環境変数が {param_id} のとき、Allure の設定の読み込みを止める")
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("{", "JSON"),
        ("[]", "PECOT_REPORT_VARIABLES"),
        ("null", "PECOT_REPORT_VARIABLES"),
        ('{"a": 1}', "PECOT_REPORT_VARIABLES"),
    ],
    ids=["broken", "array", "null", "number-value"],
)
def test_config_refuses_unreadable_variables(value: str, expected: str) -> None:
    """環境変数 `PECOT_REPORT_VARIABLES` に、JSON として読めない文字列・配列・`null`・値が数のオブジェクトを設定して、`allurerc.mjs` を読ませた場合のテストです。設定の読み込みが失敗し、原因が標準エラー出力に表示されることを確認します。"""
    with allure.step("読めない変数を環境変数に置いて設定を読む"):
        done = _read_config({**_base_env(), generate.VARIABLES_ENV: value})

    with allure.step("読み込みが失敗することを確かめる"):
        assert done.returncode != 0
        assert expected in done.stderr


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


def _entries(history: Path) -> list[str]:
    """Node の readline と trim() で数えた、履歴の行。"""
    text = history.read_bytes().decode("utf-8")
    return [line for line in re.split(r"\r\n|\n|\r", text) if line.strip(generate._JS_TRIM)]  # pyright: ignore[reportPrivateUsage]


@pytest.fixture
def real_build(root: Path, tmp_path: Path) -> tuple[Callable[[], int], Path]:
    """本物の allure generate で、--sources・--history を付けて作る関数と、履歴のパス。"""
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
            lanes_at=_same_lanes,
        )

    return build, history


_needs_pnpm = pytest.mark.skipif(shutil.which("pnpm") is None, reason="pnpm が要る")


@allure.title("本物の allure でレポートを作るたびに、履歴を 1 行ずつ追記する")
@_needs_pnpm
def test_real_allure_appends_a_line_per_report(
    real_build: tuple[Callable[[], int], Path], tmp_path: Path
) -> None:
    """本物の `allure generate` で、`generate.py` を 2 回実行した場合のテストです。1 回目に `index.html` が作られて履歴が 1 行になり、2 回目で 2 行になることを確認します。"""
    with allure.step("実際の allure でレポートを 2 回作り、履歴に 1 行ずつ増えることを確かめる"):
        build, history = real_build

        assert build() == 0
        assert (tmp_path / "report/index.html").is_file()
        assert len(_entries(history)) == 1
        assert json.loads(_entries(history)[0])["name"].startswith("pecot テストレポート")

        assert build() == 0
        assert len(_entries(history)) == 2


@allure.title("本物の allure に 11 行の履歴を渡すと、古い行を捨てて 10 行に詰める")
@_needs_pnpm
def test_real_allure_keeps_ten_entries_of_history(
    real_build: tuple[Callable[[], int], Path],
) -> None:
    """11 行の履歴を渡して、本物の `allure generate` を `allurerc.mjs` の設定で実行した場合のテストです。履歴が 10 行になり、渡した行のうち新しい 9 行と今回の 1 行が順に残ることを確認します。"""
    with allure.step("1 回作った履歴の行を写し、uuid の違う 11 行の履歴を用意する"):
        build, history = real_build
        assert build() == 0
        entry = json.loads(_entries(history)[0])
        old = [f"old-{i}" for i in range(1, 12)]
        history.write_text(
            "".join(json.dumps({**entry, "uuid": uuid}) + "\n" for uuid in old), encoding="utf-8"
        )

    with allure.step("実際の allure でレポートを作る"):
        assert build() == 0

    with allure.step("古い 2 行が消え、新しい 9 行と今回の 1 行が残ることを確かめる"):
        uuids = [json.loads(line)["uuid"] for line in _entries(history)]
        assert len(uuids) == 10
        assert uuids[:9] == old[2:]
        assert uuids[9] not in old


@allure.title("テスト名に U+2028 を含んでも、履歴を維持して追記する")
@_needs_pnpm
def test_real_allure_keeps_history_of_a_test_name_with_line_separator(
    root: Path,
    real_build: tuple[Callable[[], int], Path],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """テスト名に U+2028 を含む結果で、本物の `allure generate` を 2 回実行した場合のテストです。標準エラー出力に履歴に関する通知が出ず、履歴が 2 行になることを確認します。"""
    with allure.step("行区切りを含むテスト名のレポートを 2 回作り、履歴が保たれることを確かめる"):
        build, history = real_build
        result = _allure_result("1") | {"name": "テスト\u2028続き"}
        (root / _LANES[0]["results"] / "1-result.json").write_text(json.dumps(result), "utf-8")

        assert build() == 0
        capsys.readouterr()
        assert build() == 0

        assert "履歴" not in capsys.readouterr().err
        assert len(_entries(history)) == 2


# Allure は空の行も historyLimit に数える。空の行は 1 つずつにする。
_ENDINGS = {
    "blank-line": "\n   \n",
    "ideographic-space-line": "\n\u3000\n",
    "crlf": "\r\n",
    "lone-cr": "\r",
}


@allure.title("履歴が読める形（{param_id}）のとき、本物の allure でも履歴を維持して追記する")
@_needs_pnpm
@pytest.mark.parametrize("case", list(_ENDINGS))
def test_real_allure_reads_what_generate_passes_as_readable(
    real_build: tuple[Callable[[], int], Path],
    capsys: pytest.CaptureFixture[str],
    case: str,
) -> None:
    """空白だけの行や U+3000 の行、CRLF、単独の CR を履歴に足して、本物の `allure generate` を実行した場合のテストです。通知が出ず、履歴の行数が 1 行だけ増えることを確認します。"""
    with allure.step("実際の allure が読める履歴を、generate も読める履歴として通すことを確かめる"):
        build, history = real_build
        assert build() == 0
        history.write_bytes(f"{_entries(history)[0]}{_ENDINGS[case]}".encode())
        before = len(_entries(history))
        capsys.readouterr()

        assert build() == 0

        assert "履歴" not in capsys.readouterr().err
        assert len(_entries(history)) == before + 1


@allure.title("履歴に読めない行({param_id})があると、本物の allure でも空の履歴からレポートを作る")
@_needs_pnpm
@pytest.mark.parametrize(
    "bad",
    ["{oops", '{"a": NaN}', "null", "[1, 2]", "\x1c", '{"a": "x\u2028y"}'],
    ids=["broken", "nan", "null", "array", "not-js-blank", "u2028"],
)
def test_real_allure_builds_from_empty_history_after_unreadable_lines(
    real_build: tuple[Callable[[], int], Path], capsys: pytest.CaptureFixture[str], bad: str
) -> None:
    """不正な JSON・`NaN`・`null`・配列・U+001C・U+2028 を含む行を履歴に足して、本物の `allure generate` を実行した場合のテストです。標準エラー出力に通知が出て、履歴が 1 行になることを確認します。"""
    with allure.step("読めない行のある履歴から、実際の allure が空の履歴で作り直すことを確かめる"):
        build, history = real_build
        assert build() == 0
        with history.open("a", encoding="utf-8") as f:
            f.write(f"{bad}\n")
        capsys.readouterr()

        assert build() == 0

        assert "履歴" in capsys.readouterr().err
        assert len(_entries(history)) == 1


@allure.title(
    "本物の allure で開発版のレポートを作ると、レーンごとの変数を `widgets/variables.json` に書く"
)
@_needs_pnpm
def test_real_allure_writes_the_variables_of_each_lane(
    root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`runs` と `latest` に 1 レーンずつを持つ開発版の材料で、本物の `allure generate` を実行した場合のテストです。レポートの `widgets/variables.json` に、レーンごとのコミットと run の URL が書かれ、履歴が作られないことを確認します。"""
    with allure.step("2 つのレーンの結果と開発版の材料を置いて、本物の allure で生成する"):
        for i, (entry, commit) in enumerate(zip(_LANES[:2], (SHA_A, SHA_B), strict=True), start=1):
            lane = f"{entry['project']}:{entry['target']}"
            results = root / entry["results"]
            results.mkdir(parents=True)
            result = _allure_result(str(i)) | {"historyId": f"h-{i}", "testCaseId": f"t-{i}"}
            (results / f"{i}-result.json").write_text(json.dumps(result), encoding="utf-8")
            source = {"lane": lane, "commit": commit}
            (results.parent / "source.json").write_text(json.dumps(source), encoding="utf-8")
        sources = _dev_sources(
            tmp_path,
            [{"commit": SHA_A, "lanes": ["alpha:test-unit"]}],
            [_latest("beta:test-cli", SHA_B, 456)],
        )
        monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
        monkeypatch.setenv("GITHUB_RUN_ID", "123")
        out = tmp_path / "report"

        code = generate.main(
            ["generate.py", "--sources", str(sources), "--output", str(out)],
            root=root,
            lanes_path=root / "report-lanes.json",
            is_ancestor=Ancestry(),
        )

    with allure.step("変数のファイルにレーンごとの値が入ることを確かめる"):
        assert code == 0
        variables = json.loads((out / "widgets/variables.json").read_text(encoding="utf-8"))
        assert variables == {
            "alpha:test-unit": f"{SHA_A} https://github.com/owner/repo/actions/runs/123",
            "beta:test-cli": f"{SHA_B} https://github.com/owner/repo/actions/runs/456",
        }
        assert not (out / "history.jsonl").exists()


def _write_result(results: Path, result: dict[str, Any]) -> None:
    results.mkdir(parents=True, exist_ok=True)
    (results / f"{result['uuid']}-result.json").write_text(json.dumps(result), encoding="utf-8")


def _build_local(root: Path, out: Path) -> int:
    return generate.main(
        ["generate.py", "--local", "--output", str(out)],
        root=root,
        lanes_path=root / "report-lanes.json",
    )


@allure.title("本物の allure のメタデータに、レーンの間で値が同じ環境の情報だけを出す")
@_needs_pnpm
def test_real_allure_shows_only_environment_values_shared_by_all_lanes(
    root: Path, tmp_path: Path
) -> None:
    """`Node.js` の値だけが違う 2 つのレーンの結果から、本物の `allure generate` でレポートを作る場合のテストです。`widgets/allure_environment.json` に、共通の `OS` と日本語の値が出て、`Node.js` は出ないことを確認します。"""
    with allure.step("値の一部が違う環境の情報を持つ 2 つのレーンの結果を置く"):
        for lane, results, node in (
            ("alpha:test-unit", _LANES[0]["results"], "v24.22.1"),
            ("beta:test-cli", _LANES[1]["results"], "v22.0.0"),
        ):
            uuid = lane.replace(":", "-")
            _write_result(
                root / results,
                _allure_result(uuid) | {"historyId": uuid, "testCaseId": uuid},
            )
            (root / results / generate.ENVIRONMENT_FILE).write_text(
                f"OS=Ubuntu 26.04.1 LTS\nNode.js={node}\nホスト=開発機\n", encoding="utf-8"
            )

    with allure.step("本物の allure でレポートを作る"):
        code = _build_local(root, tmp_path / "report")

    with allure.step("メタデータの項目を比べる"):
        assert code == 0
        widget = tmp_path / "report/widgets/allure_environment.json"
        assert json.loads(widget.read_text(encoding="utf-8")) == [
            {"name": "OS", "values": ["Ubuntu 26.04.1 LTS"]},
            {"name": "ホスト", "values": ["開発機"]},
        ]


@allure.title("どのキーもレーンで値が違うと、本物の allure のメタデータに何も出さない")
@_needs_pnpm
def test_real_allure_shows_no_environment_when_no_key_is_shared(root: Path, tmp_path: Path) -> None:
    """どのキーも値の違う 2 つのレーンの結果から、本物の `allure generate` でレポートを作る場合のテストです。`widgets/allure_environment.json` が空の配列になり、最後のレーンの値が残らないことを確認します。"""
    with allure.step("どのキーも値の違う環境の情報を持つ 2 つのレーンの結果を置く"):
        for lane, results, os_name in (
            ("alpha:test-unit", _LANES[0]["results"], "Ubuntu 26.04.1 LTS"),
            ("beta:test-cli", _LANES[1]["results"], "Debian GNU/Linux 13"),
        ):
            uuid = lane.replace(":", "-")
            _write_result(
                root / results,
                _allure_result(uuid) | {"historyId": uuid, "testCaseId": uuid},
            )
            (root / results / generate.ENVIRONMENT_FILE).write_text(
                f"OS={os_name}\n", encoding="utf-8"
            )

    with allure.step("本物の allure でレポートを作る"):
        code = _build_local(root, tmp_path / "report")

    with allure.step("メタデータが空であることを確かめる"):
        assert code == 0
        widget = tmp_path / "report/widgets/allure_environment.json"
        assert json.loads(widget.read_text(encoding="utf-8")) == []


def _leaves(nodes: dict[str, Any], node_id: str) -> set[str]:
    node = nodes[node_id]
    if node["type"] == "tr":
        return {node["name"]}
    leaves: set[str] = set()
    for child in node.get("childrenIds", []):
        leaves |= _leaves(nodes, child)
    return leaves


@allure.title(
    "本物の allure で、失敗を不安定なテスト・製品の不具合・テストの不具合に分け、epic ごとに並べる"
)
@_needs_pnpm
def test_real_allure_sorts_failures_into_categories_by_epic(root: Path, tmp_path: Path) -> None:
    """failed・broken・不安定な failed と、不安定な passed の結果から、本物の `allure generate` でレポートを作る場合のテストです。`widgets/categories.json` で、各結果が決めた日本語の分類の epic ごとの枝に入り、passed の結果と英語の既定の分類が出ないことを確認します。"""
    with allure.step("状態と epic の違う結果を置く"):
        results = root / _LANES[0]["results"]
        cases = [
            ("assert が落ちる", "alpha", "failed", False),
            ("beta の assert が落ちる", "beta", "failed", False),
            ("例外で止まる", "alpha", "broken", False),
            ("揺れて落ちる", "alpha", "failed", True),
            ("揺れて通る", "alpha", "passed", True),
        ]
        for i, (name, epic, status, flaky) in enumerate(cases):
            base = _allure_result(f"c{i}")
            _write_result(
                results,
                base
                | {
                    "historyId": f"h-c{i}",
                    "testCaseId": f"t-c{i}",
                    "name": name,
                    "fullName": f"alpha/case.test.ts#{name}",
                    "status": status,
                    "statusDetails": {"message": f"{name}の理由", "flaky": flaky},
                    "labels": [*base["labels"], {"name": "epic", "value": epic}],
                },
            )

    with allure.step("本物の allure でレポートを作る"):
        code = _build_local(root, tmp_path / "report")

    with allure.step("分類と epic の枝ごとに、入った結果の名前を比べる"):
        assert code == 0
        widget = json.loads(
            (tmp_path / "report/widgets/categories.json").read_text(encoding="utf-8")
        )
        nodes = widget["nodes"]
        tree = {
            nodes[root_id]["name"]: {
                nodes[group]["name"]: _leaves(nodes, group)
                for group in nodes[root_id]["childrenIds"]
            }
            for root_id in widget["roots"]
        }
        assert list(tree) == ["不安定なテスト", "製品の不具合", "テストの不具合"]
        assert tree == {
            "不安定なテスト": {"epic: alpha": {"揺れて落ちる"}},
            "製品の不具合": {
                "epic: alpha": {"assert が落ちる"},
                "epic: beta": {"beta の assert が落ちる"},
            },
            "テストの不具合": {"epic: alpha": {"例外で止まる"}},
        }
        names = {node["name"] for node in nodes.values()}
        assert not names & {"Product errors", "Test errors", "揺れて通る"}
