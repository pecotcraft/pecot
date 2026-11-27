"""レポートのレーンの Allure の結果から、1 つのテストレポートを作る。

手元では `generate.py --local --output <dir>` と打つ。
公開の run は `generate.py --sources <材料> --output <dir> [--history <history.jsonl>]` と打つ。`--history` はリリース版だけ。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple, cast

_HERE = Path(__file__).resolve().parent


def _load_matrix() -> Callable[[object], list[dict[str, str]]]:
    # store.py がこのファイルをパスで読むと、このディレクトリは sys.path に無い。lanes.py もパスで読む
    spec = importlib.util.spec_from_file_location("test_report_lanes", _HERE / "lanes.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"{_HERE / 'lanes.py'} を読めません")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return cast("Callable[[object], list[dict[str, str]]]", module.matrix)


matrix = _load_matrix()

REPO_ROOT = _HERE.parents[2]
DEFAULT_LANES = _HERE / "report-lanes.json"
CONFIG = _HERE / "allurerc.mjs"
HISTORY_ENV = "PECOT_REPORT_HISTORY"
VARIABLES_ENV = "PECOT_REPORT_VARIABLES"
_SHA = re.compile(r"[0-9a-f]{40}")
# Node の readline と同じ区切り（U+2028・U+2029 でも切る）
_LINE_BREAK = re.compile(r"\r\n|\n|\r|\u2028|\u2029")
# JS の String.prototype.trim が除く文字（WhiteSpace と LineTerminator）。Allure は trim() で空行を飛ばす
_JS_TRIM = "\t\v\f \u00a0\ufeff\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000\n\r\u2028\u2029"

Runner = Callable[[list[str], dict[str, str]], int]


class InputError(Exception):
    pass


def report_lanes(raw: object) -> dict[str, str]:
    """レーンの名前から、結果のディレクトリ（リポのルートからのパス）を引く。excluded のレーンは入らない。"""
    return {job["lane"]: job["results"] for job in matrix(raw)}


def excluded_lanes(raw: object) -> set[str]:
    entries = cast("list[dict[str, object]]", raw)
    return {f"{e['project']}:{e['target']}" for e in entries if "excluded" in e}


class ReportSources(NamedTuple):
    side: str
    # runs と latest の全レーンの、結果のコミット
    commits: dict[str, str]
    # latest のレーンを試した run。runs のレーンは、この run で流す
    latest_runs: dict[str, int]


def _check_lane(name: object, where: str, lanes: dict[str, str], excluded: set[str]) -> str:
    if not isinstance(name, str):
        raise InputError(f"材料の {where} に、文字列でないレーンがあります")
    if name in excluded:
        raise InputError(f"材料のレーン {name} は、レポートに入れないレーンです")
    if name not in lanes:
        raise InputError(f"材料のレーン {name} は report-lanes.json にありません")
    return name


def _check_commit(commit: object, where: str) -> str:
    if not isinstance(commit, str) or not _SHA.fullmatch(commit):
        raise InputError(f"材料の {where} の commit {repr(commit)} が 40 桁の 16 進ではありません")
    return commit


def _is_run_id(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def required_lanes(sources: object, lanes: dict[str, str], excluded: set[str]) -> dict[str, str]:
    """ReportSources の runs から、レーンの名前とそのコミットを引く。形の誤りは InputError。"""
    if not isinstance(sources, dict):
        raise InputError("材料がオブジェクトではありません")
    runs = cast("dict[str, object]", sources).get("runs")
    if not isinstance(runs, list):
        raise InputError("材料の runs が配列ではありません")
    commits: dict[str, str] = {}
    for i, item in enumerate(cast("list[object]", runs), start=1):
        if not isinstance(item, dict):
            raise InputError(f"材料の runs #{i} がオブジェクトではありません")
        run = cast("dict[str, object]", item)
        commit, names = _check_commit(run.get("commit"), f"runs #{i}"), run.get("lanes")
        if not isinstance(names, list) or not names:
            raise InputError(f"材料の runs #{i} の lanes が、空でない配列ではありません")
        for value in cast("list[object]", names):
            name = _check_lane(value, f"runs #{i} の lanes", lanes, excluded)
            if name in commits:
                raise InputError(f"材料のレーン {name} が 2 回あります")
            commits[name] = commit
    return commits


def latest_lanes(
    sources: dict[str, object], lanes: dict[str, str], excluded: set[str]
) -> dict[str, tuple[str, int]]:
    """ReportSources の latest から、レーンの名前とそのコミット・試した run を引く。形の誤りは InputError。"""
    latest = sources.get("latest", [])
    if not isinstance(latest, list):
        raise InputError("材料の latest が配列ではありません")
    found: dict[str, tuple[str, int]] = {}
    for i, item in enumerate(cast("list[object]", latest), start=1):
        if not isinstance(item, dict):
            raise InputError(f"材料の latest #{i} がオブジェクトではありません")
        entry = cast("dict[str, object]", item)
        name = _check_lane(entry.get("lane"), f"latest #{i}", lanes, excluded)
        where = f"latest #{i} のレーン {name}"
        commit = _check_commit(entry.get("commit"), where)
        run_id, from_run, artifact = (
            entry.get("run_id"),
            entry.get("from_run"),
            entry.get("artifact"),
        )
        if not _is_run_id(run_id):
            raise InputError(f"材料の {where} の run_id {repr(run_id)} が正の整数ではありません")
        if not _is_run_id(from_run):
            raise InputError(
                f"材料の {where} の from_run {repr(from_run)} が正の整数ではありません"
            )
        if not isinstance(artifact, str) or not artifact:
            raise InputError(f"材料の {where} の artifact が、空でない文字列ではありません")
        if name in found:
            raise InputError(f"材料のレーン {name} が latest に 2 回あります")
        found[name] = (commit, cast("int", run_id))
    return found


def read_sources(sources: object, lanes: dict[str, str], excluded: set[str]) -> ReportSources:
    """ReportSources を読む。開発版は、runs と latest を合わせてレポートのレーンが全部そろうこと。"""
    commits = required_lanes(sources, lanes, excluded)
    raw = cast("dict[str, object]", sources)
    side = raw.get("side")
    if side not in ("dev", "release"):
        raise InputError(f"材料の side {repr(side)} が dev と release のどちらでもありません")
    latest = latest_lanes(raw, lanes, excluded)
    if side == "release" and latest:
        raise InputError("リリース版の材料に latest があります")
    both = sorted(set(commits) & set(latest))
    if both:
        raise InputError(f"材料のレーン {', '.join(both)} が runs と latest の両方にあります")
    commits.update({name: commit for name, (commit, _) in latest.items()})
    absent = sorted(set(lanes) - set(commits))
    if side == "dev" and absent:
        raise InputError(f"開発版の材料に、レーン {', '.join(absent)} がありません")
    return ReportSources(
        cast("str", side), commits, {name: run for name, (_, run) in latest.items()}
    )


def git_is_ancestor(root: Path, commit: str) -> bool:
    """commit が root の HEAD の祖先（HEAD 自身を含む）か。"""
    done = subprocess.run(
        ["git", "merge-base", "--is-ancestor", commit, "HEAD"], cwd=root, check=False
    )
    return done.returncode == 0


def not_ancestors(
    root: Path, commits: dict[str, str], is_ancestor: Callable[[Path, str], bool]
) -> list[str]:
    """コミットが HEAD の祖先でないレーンの説明。同じコミットは 1 回だけ確かめる。"""
    verdicts = {commit: is_ancestor(root, commit) for commit in sorted(set(commits.values()))}
    return [
        f"{name}: コミット {commits[name]} が HEAD の祖先ではありません"
        for name in sorted(commits)
        if not verdicts[commits[name]]
    ]


def report_variables(sources: ReportSources, env: dict[str, str]) -> dict[str, str]:
    """レーンごとの「コミット 試した run の URL」。リポか run が分からなければコミットだけ。"""
    server = env.get("GITHUB_SERVER_URL") or "https://github.com"
    repo, this_run = env.get("GITHUB_REPOSITORY"), env.get("GITHUB_RUN_ID")
    variables: dict[str, str] = {}
    for name in sorted(sources.commits):
        run = sources.latest_runs.get(name, this_run)
        commit = sources.commits[name]
        variables[name] = f"{commit} {server}/{repo}/actions/runs/{run}" if repo and run else commit
    return variables


def missing_lanes(root: Path, lanes: dict[str, str]) -> list[str]:
    """結果のディレクトリが無いか、*-result.json が 1 つも無いレーン。"""
    return [
        name
        for name, results in sorted(lanes.items())
        if not any((root / results).glob("*-result.json"))
    ]


def source_mismatches(root: Path, lanes: dict[str, str], commits: dict[str, str]) -> list[str]:
    """source.json（結果のディレクトリの親）が、レーンとコミットに合わないレーンの説明。"""
    problems: list[str] = []
    for name in sorted(commits):
        path = (root / lanes[name]).parent / "source.json"
        try:
            source = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            problems.append(f"{name}: source.json を読めません（{path}）")
            continue
        got = cast("dict[str, object]", source) if isinstance(source, dict) else {}
        if got.get("lane") != name or got.get("commit") != commits[name]:
            problems.append(
                f"{name}: source.json は {got.get('lane')} の {got.get('commit')} で、"
                f"材料の {commits[name]} と違います"
            )
    return problems


def _reject_constant(name: str) -> object:
    raise ValueError(name)


def read_history(data: bytes) -> list[int]:
    """Allure の履歴（JSONL）のうち、Allure が読めない行の番号。UTF-8 でなければ [0]。"""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return [0]
    bad: list[int] = []
    for number, line in enumerate(_LINE_BREAK.split(text), start=1):
        if not line.strip(_JS_TRIM):
            continue
        try:
            entry = json.loads(line, parse_constant=_reject_constant)
        except ValueError:
            bad.append(number)
            continue
        if not isinstance(entry, dict):
            bad.append(number)
    return bad


def allure_command(output: Path, results: list[Path]) -> list[str]:
    return [
        "pnpm", "exec", "allure", "generate",
        "--config", str(CONFIG),
        "--output", str(output),
        "--clean",
        *(str(path) for path in results),
    ]  # fmt: skip


def run_allure(command: list[str], env: dict[str, str]) -> int:
    return subprocess.run(command, cwd=REPO_ROOT, env=env, check=False).returncode


def _notify(message: str) -> None:
    print(f"WARNING: {message}", file=sys.stderr)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"\n> [!WARNING]\n> {message}\n")


def _prepare_history(history: Path) -> None:
    if not history.exists():
        return
    bad = read_history(history.read_bytes())
    if not bad:
        return
    where = "UTF-8 として" if bad == [0] else f"{', '.join(map(str, bad))} 行目が JSON として"
    _notify(f"履歴 {history} の {where}読めません。空の履歴でレポートを作ります")
    history.write_bytes(b"")


def _parse(argv: list[str]) -> tuple[argparse.Namespace, Path, Path | None, Path | None]:
    parser = argparse.ArgumentParser(
        description="レポートのレーンの Allure の結果から、テストレポートを作る"
    )
    parser.add_argument(
        "--local",
        action="store_true",
        help="手元の結果だけで作る。欠けたレーンは名前を出して飛ばす",
    )
    parser.add_argument("--output", required=True, help="レポートを書くディレクトリ")
    parser.add_argument("--history", help="Allure の履歴（JSONL）。読んで 1 行足す")
    parser.add_argument("--sources", help="ReportSources の JSON。手元でないときは要る")
    args = parser.parse_args(argv[1:])
    if args.local and (args.history or args.sources):
        parser.error(
            "--local は --history・--sources と一緒に使えません（手元は履歴を読まず、材料を確かめません）"
        )
    if not args.local and not args.sources:
        parser.error("--local でないときは --sources が要ります")
    output = Path(args.output).resolve()
    history = Path(args.history).resolve() if args.history else None
    if history is not None and history.is_relative_to(output):
        parser.error(
            "--history を --output の中に置けません（allure generate --clean が出力を消せません）"
        )
    sources = Path(args.sources).resolve() if args.sources else None
    return args, output, history, sources


def main(
    argv: list[str],
    *,
    root: Path = REPO_ROOT,
    lanes_path: Path = DEFAULT_LANES,
    run: Runner = run_allure,
    is_ancestor: Callable[[Path, str], bool] = git_is_ancestor,
) -> int:
    args, output, history, sources_path = _parse(argv)
    sources: ReportSources | None = None
    try:
        raw = json.loads(lanes_path.read_text(encoding="utf-8"))
        lanes = report_lanes(raw)
        if sources_path is None:
            commits: dict[str, str] = {}
            wanted = lanes
        else:
            sources = read_sources(
                json.loads(sources_path.read_text(encoding="utf-8")), lanes, excluded_lanes(raw)
            )
            if sources.side == "dev" and history is not None:
                raise InputError("開発版の材料には --history を渡せません（履歴はリリース版だけ）")
            commits = sources.commits
            wanted = {name: lanes[name] for name in commits}
    except (OSError, ValueError, InputError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    missing = missing_lanes(root, wanted)
    if args.local:
        if missing:
            print(f"結果の無いレーンを飛ばします: {', '.join(missing)}", file=sys.stderr)
        if len(missing) == len(wanted):
            print("ERROR: 結果のあるレーンが 1 つも無いので、レポートを作れません", file=sys.stderr)
            return 1
    else:
        problems = [f"{name}: 結果がありません" for name in missing]
        problems += source_mismatches(
            root, wanted, {n: c for n, c in commits.items() if n not in missing}
        )
        if sources is not None and sources.side == "dev":
            problems += not_ancestors(root, commits, is_ancestor)
        if problems:
            print("ERROR: 結果がそろっていないので、レポートを作りません", file=sys.stderr)
            for problem in problems:
                print(f"  {problem}", file=sys.stderr)
            return 1

    env = {k: v for k, v in os.environ.items() if k not in (HISTORY_ENV, VARIABLES_ENV)}
    if sources is not None:
        env[VARIABLES_ENV] = json.dumps(report_variables(sources, env), ensure_ascii=False)
    if history is not None:
        _prepare_history(history)
        env[HISTORY_ENV] = str(history)
    results = [root / wanted[name] for name in sorted(wanted) if name not in missing]
    code = run(allure_command(output, results), env)
    if code != 0:
        print(f"ERROR: allure generate が {code} で終わりました", file=sys.stderr)
        return code
    if history is not None and history.is_file():
        escape_line_separators(history)
    return code


def escape_line_separators(history: Path) -> None:
    """Allure が JSON.stringify で書いた U+2028・U+2029 を、次の回の readline で切れないようにエスケープする。"""
    # JSON の文字列の外には U+2028・U+2029 は現れないので、値は変わらない。
    text = history.read_bytes().decode("utf-8")
    escaped = text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    if escaped != text:
        history.write_bytes(escaped.encode("utf-8"))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
