"""test_report/generate.py のテスト。結果のそろいの判定・履歴の扱い・allure generate に渡す引数と、allurerc.mjs の値。

単体のケースは allure の起動（run）だけを差し替える。最後の節は、本物の allure generate を起こす。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import allure
import pytest

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
        path.write_text(json.dumps({"side": "dev", "runs": runs, "missing": []}), encoding="utf-8")

        code, run = _main(root, "--sources", str(path), "--output", str(tmp_path / "out"))

    with allure.step("終了コード 1 と allure を動かさないことと理由の出力を確かめる"):
        assert code == 1
        assert run.calls == []
        assert expected in capsys.readouterr().err


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


# --- allurerc.mjs ---


def _config(env: dict[str, str]) -> dict[str, Any]:
    """allurerc.mjs の export と、Allure の readConfig が解いた値。"""
    script = (
        f"const {{ default: raw }} = await import({json.dumps(_CONFIG.as_uri())});"
        "const { readConfig } = await import('@allurereport/core');"
        f"const r = await readConfig(process.cwd(), {json.dumps(str(_CONFIG))});"
        "const { normalizeCategoriesConfig } = await import('@allurereport/core-api');"
        "const categories = normalizeCategoriesConfig(r.categories)"
        ".map(({ id, name, groupBy }) => ({ id, name, groupBy }));"
        "const resolved = { name: r.name, historyPath: r.historyPath ?? null,"
        " historyLimit: r.historyLimit, historyBaseUrl: r.historyBaseUrl ?? null,"
        " flakyDetection: r.flakyDetection, categories };"
        "process.stdout.write('\\n' + JSON.stringify({ raw, resolved }));"
    )
    # -e の import は作業ディレクトリから解く。@allurereport/core は allure の依存なので、allure の実体から解く
    done = run_attached(
        ["node", "--input-type=module", "-e", script],
        cwd=(_REPO / "node_modules/allure").resolve(),
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    # allure の import が、標準出力に見出しを書く。最後の行だけを読む
    return json.loads(done.stdout.splitlines()[-1])


@allure.title("allurerc.mjs は、グループの順・言語・履歴の上限などを期待する値で設定する")
def test_config_values() -> None:
    """`allurerc.mjs` の設定のテストです。`awesome` プラグインの `groupBy` と `reportLanguage`、Allure が解いた名前・履歴の上限・不安定なテストの検出・失敗の分類の設定が、期待する値であることを確認します。"""
    with allure.step("allure の設定を読む"):
        env = {k: v for k, v in os.environ.items() if k != generate.HISTORY_ENV}

        config = _config(env)

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
            "historyLimit": 3,
            "historyBaseUrl": None,
            "flakyDetection": {"includePassedTests": True},
            # 既定と同じ名前の分類は、既定の id にまとまり、書いた groupBy を持つ。
            "categories": [
                {
                    "id": "_product_errors_default_category",
                    "name": "Product errors",
                    "groupBy": ["severity"],
                },
                {
                    "id": "_test_errors_default_category",
                    "name": "Test errors",
                    "groupBy": ["severity"],
                },
            ],
        }
        assert config["raw"]["categories"] == {
            "rules": [
                {
                    "name": "Product errors",
                    "matchers": {"statuses": ["failed"]},
                    "groupBy": ["severity"],
                },
                {
                    "name": "Test errors",
                    "matchers": {"statuses": ["broken"]},
                    "groupBy": ["severity"],
                },
            ]
        }


@allure.title("履歴のパスは、環境変数から取得する")
def test_config_takes_history_path_from_env(tmp_path: Path) -> None:
    """環境変数に履歴のパスを設定して、`allurerc.mjs` を Allure に読ませた場合のテストです。解決した設定の `historyPath` が、環境変数の値と一致することを確認します。"""
    with allure.step("環境変数に履歴のパスを置いて設定を読む"):
        env = {**os.environ, generate.HISTORY_ENV: str(tmp_path / "history.jsonl")}

    with allure.step("履歴のパスが環境変数の値になることを確かめる"):
        assert _config(env)["resolved"]["historyPath"] == str(tmp_path / "history.jsonl")


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
