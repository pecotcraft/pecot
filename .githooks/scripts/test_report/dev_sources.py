"""開発版のテストレポートの材料（ReportSources）を、CI の run が上げたレーンの結果から決める。

resolve は材料と matrix を出し、fetch は拾った結果をリポのルートに写し、pack は lane-latest の木と index を作る。
決まりの正は specs/030-allure-test-report/data-model.md の ReportSources・LaneLatest。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

REPORT_LANES = ".githooks/scripts/test_report/report-lanes.json"
CI_PATH = ".github/workflows/ci.yml"
REPORT_PATH = ".github/workflows/test-report.yml"
LANE_SOURCES = "lane-sources"
LANE_LATEST = "lane-latest"
LANE_LATEST_INDEX = "lane-latest-index"
RESULTS_PREFIX = "allure-results-"
DEFAULT_MAX_COMMITS = 50

_SHA = re.compile(r"[0-9a-f]{40}")
_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


def _load_lanes() -> tuple[Callable[[object], list[dict[str, str]]], Callable[[str], str]]:
    # このディレクトリは sys.path に無いことがあるので、release_sources.py と同じくパスで読む
    path = Path(__file__).resolve().parent / "lanes.py"
    spec = importlib.util.spec_from_file_location("test_report_lanes", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"{path} を読めません")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return (
        cast("Callable[[object], list[dict[str, str]]]", module.matrix),
        cast("Callable[[str], str]", module.slug_of),
    )


report_matrix, slug_of = _load_lanes()


class DevSourcesError(ValueError):
    pass


ApiGet = Callable[[str, Mapping[str, str]], object]
Download = Callable[[int, str, Path], None]
ListLanes = Callable[[str], list[str]]
IsAncestor = Callable[[str, str], bool]
Log = Callable[[str], None]


@dataclass(frozen=True)
class Latest:
    """拾ったレーンの結果。commit はレーンの結果のコミット、run_id は試した run、from_run・artifact は取り出す元。"""

    lane: str
    commit: str
    run_id: int
    from_run: int
    artifact: str

    def to_json(self) -> dict[str, object]:
        return {
            "lane": self.lane,
            "commit": self.commit,
            "run_id": self.run_id,
            "from_run": self.from_run,
            "artifact": self.artifact,
        }


@dataclass(frozen=True)
class DevReport:
    head: str
    on_main: list[str]
    latest: list[Latest]
    jobs: list[dict[str, str]]

    def record(self) -> dict[str, object]:
        """report-sources.json の形。"""
        runs: list[dict[str, object]] = (
            [{"commit": self.head, "lanes": self.on_main}] if self.on_main else []
        )
        return {
            "side": "dev",
            "runs": runs,
            "missing": [],
            "latest": [entry.to_json() for entry in self.latest],
        }

    def to_json(self) -> dict[str, object]:
        return {"sources": self.record(), "matrix": self.jobs}


@dataclass
class GitHub:
    """GitHub の API と artifact の取り出し。テストは関数を差し替える。"""

    repo: str
    api: ApiGet
    download: Download
    work: Path


# ---------------------------------------------------------------- JSON の読み方


def _map(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return cast("Mapping[str, object]", value)
    return {}


def _list(value: object) -> list[object]:
    return cast("list[object]", value) if isinstance(value, list) else []


def _str(data: Mapping[str, object], *keys: str) -> str | None:
    value: object = data
    for key in keys:
        value = _map(value).get(key)
    return value if isinstance(value, str) else None


def _int(value: object) -> int | None:
    # bool は int の派生なので外す。
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _same_repo(full_name: str | None, repo: str) -> bool:
    # GitHub のリポの名前は大文字と小文字を区別しない。
    return full_name is not None and full_name.lower() == repo.lower()


def _str_list(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    items = cast("list[object]", value)
    if not all(isinstance(item, str) for item in items):
        return None
    return cast("list[str]", items)


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DevSourcesError(f"{path.name} を JSON として読めません: {error}") from error


# ---------------------------------------------------------------- GitHub の run と artifact


def _runs(gh: GitHub, path: str, params: Mapping[str, str]) -> list[Mapping[str, object]]:
    data = _map(gh.api(path, {**params, "per_page": "100"}))
    runs = [_map(run) for run in _list(data.get("workflow_runs"))]
    return sorted(runs, key=lambda run: _int(run.get("id")) or 0, reverse=True)


def _artifacts(gh: GitHub, run_id: int) -> set[str]:
    """run の、期限の切れていない artifact の名前。"""
    names: set[str] = set()
    page = 1
    while True:
        data = _map(
            gh.api(
                f"repos/{gh.repo}/actions/runs/{run_id}/artifacts",
                {"per_page": "100", "page": str(page)},
            )
        )
        items = [_map(item) for item in _list(data.get("artifacts"))]
        for item in items:
            name = _str(item, "name")
            if name is not None and item.get("expired") is not True:
                names.add(name)
        if len(items) < 100:
            return names
        page += 1


def _download_json(gh: GitHub, run_id: int, artifact: str, name: str) -> object:
    dest = Path(tempfile.mkdtemp(prefix="dev-sources-", dir=gh.work))
    try:
        gh.download(run_id, artifact, dest)
        return _read_json(dest / name)
    finally:
        shutil.rmtree(dest, ignore_errors=True)


def _ci_result_passed(gh: GitHub, run_id: int) -> bool:
    data = _map(
        gh.api(
            f"repos/{gh.repo}/actions/runs/{run_id}/jobs", {"filter": "latest", "per_page": "100"}
        )
    )
    jobs = [_map(job) for job in _list(data.get("jobs"))]
    return any(
        _str(job, "name") == "ci-result" and _str(job, "conclusion") == "success" for job in jobs
    )


@dataclass(frozen=True)
class PrevRun:
    run_id: int
    lanes: dict[str, tuple[str, int]]


def _index_lanes(data: object, head_sha: str) -> dict[str, tuple[str, int]] | None:
    """lane-latest-index.json を読む。commit が run の head と違うか、形が違えば None。"""
    index = _map(data)
    if _str(index, "commit") != head_sha:
        return None
    lanes: dict[str, tuple[str, int]] = {}
    raw = index.get("lanes")
    if not isinstance(raw, Mapping):
        return None
    for lane, value in cast("Mapping[object, object]", raw).items():
        entry = _map(value)
        commit, run_id = _str(entry, "commit"), _int(entry.get("run_id"))
        if not isinstance(lane, str) or commit is None or not _SHA.fullmatch(commit):
            return None
        if run_id is None:
            return None
        lanes[lane] = (commit, run_id)
    return lanes


def find_prev_run(
    gh: GitHub,
    commit: str,
    head: str,
    *,
    is_ancestor: IsAncestor,
    current_run: int | None,
    notes: list[str],
) -> PrevRun | None:
    """commit を head に持つ、前の開発版の run を探す。外れた run の理由は notes に足す。"""
    runs = _runs(
        gh,
        f"repos/{gh.repo}/actions/workflows/test-report.yml/runs",
        {"head_sha": commit, "status": "success"},
    )
    for run in runs:
        run_id = _int(run.get("id"))
        if run_id is None or run_id == current_run:
            continue
        if (
            _str(run, "path") != REPORT_PATH
            or _str(run, "event") not in ("push", "workflow_dispatch")
            or _str(run, "conclusion") != "success"
            or not _same_repo(_str(run, "head_repository", "full_name"), gh.repo)
            or _str(run, "head_sha") != commit
        ):
            notes.append(f"開発版の run {run_id} は出どころが合わない")
            continue
        if not is_ancestor(commit, head):
            notes.append(f"開発版の run {run_id} の head が祖先でない")
            continue
        artifacts = _artifacts(gh, run_id)
        if not {LANE_LATEST, LANE_LATEST_INDEX} <= artifacts:
            notes.append(f"開発版の run {run_id} に {LANE_LATEST} か {LANE_LATEST_INDEX} が無い")
            continue
        data = _download_json(gh, run_id, LANE_LATEST_INDEX, "lane-latest-index.json")
        lanes = _index_lanes(data, commit)
        if lanes is None:
            notes.append(f"開発版の run {run_id} の {LANE_LATEST_INDEX} が run の head と合わない")
            continue
        return PrevRun(run_id=run_id, lanes=lanes)
    return None


def _merge_queue_run(gh: GitHub, commit: str, notes: list[str]) -> tuple[int, set[str]] | None:
    """commit を試して ci-result が成功したマージキューの run と、その artifact の名前。"""
    runs = _runs(gh, f"repos/{gh.repo}/actions/runs", {"event": "merge_group", "head_sha": commit})
    for run in runs:
        run_id = _int(run.get("id"))
        if run_id is None:
            continue
        if (
            _str(run, "path") != CI_PATH
            or _str(run, "event") != "merge_group"
            or not _same_repo(_str(run, "head_repository", "full_name"), gh.repo)
            or _str(run, "head_sha") != commit
        ):
            continue
        if not _ci_result_passed(gh, run_id):
            notes.append(f"マージキューの run {run_id} は ci-result が成功していない")
            continue
        return run_id, _artifacts(gh, run_id)
    return None


@dataclass(frozen=True)
class LaneSources:
    merge_group: list[str]
    pull_request: list[str]
    pr: int | None
    pr_head: str | None
    pr_run: int | None


def _lane_sources(data: object, commit: str) -> LaneSources | None:
    obj = _map(data)
    merge_group, pull_request = (
        _str_list(obj.get("merge_group")),
        _str_list(obj.get("pull_request")),
    )
    if _str(obj, "commit") != commit or merge_group is None or pull_request is None:
        return None
    pr, pr_head, pr_run = _int(obj.get("pr")), _str(obj, "pr_head"), _int(obj.get("pr_run"))
    if pr_head is not None and not _SHA.fullmatch(pr_head):
        return None
    return LaneSources(merge_group, pull_request, pr, pr_head, pr_run)


def verify_pr_run(gh: GitHub, sources: LaneSources, notes: list[str]) -> set[str] | None:
    """lane-sources が指す PR の run を確かめ、その artifact の名前を返す。確かめに外れれば None。"""
    if sources.pr is None or sources.pr_head is None or sources.pr_run is None:
        notes.append("lane-sources に PR の run が無い")
        return None
    run = _map(gh.api(f"repos/{gh.repo}/actions/runs/{sources.pr_run}", {}))
    if (
        _str(run, "path") != CI_PATH
        or _str(run, "event") != "pull_request"
        or not _same_repo(_str(run, "head_repository", "full_name"), gh.repo)
        or _str(run, "head_sha") != sources.pr_head
    ):
        notes.append(f"PR の run {sources.pr_run} は出どころが合わない")
        return None
    # run の pull_requests は PR が閉じると空になるので、PR の側から head を確かめる。
    pull = _map(gh.api(f"repos/{gh.repo}/pulls/{sources.pr}", {}))
    if (
        not _same_repo(_str(pull, "base", "repo", "full_name"), gh.repo)
        or not _same_repo(_str(pull, "head", "repo", "full_name"), gh.repo)
        or _str(pull, "head", "sha") != sources.pr_head
        or _str(pull, "head", "ref") != _str(run, "head_branch")
    ):
        notes.append(f"PR #{sources.pr} の head が PR の run {sources.pr_run} と合わない")
        return None
    return _artifacts(gh, sources.pr_run)


# ---------------------------------------------------------------- 材料の決め方


@dataclass
class _Walk:
    jobs: dict[str, dict[str, str]]
    undecided: set[str]
    on_main: set[str] = field(default_factory=lambda: set[str]())
    latest: dict[str, Latest] = field(default_factory=lambda: dict[str, Latest]())

    def take(self, lane: str, entry: Latest) -> None:
        self.latest[lane] = entry
        self.undecided.discard(lane)

    def run_on_main(self, lane: str) -> None:
        self.on_main.add(lane)
        self.undecided.discard(lane)


def _names(lanes: list[str]) -> str:
    return ", ".join(lanes) if lanes else "なし"


def _decide_commit(gh: GitHub, walk: _Walk, commit: str, list_lanes: ListLanes, log: Log) -> None:
    notes: list[str] = []
    short = commit[:7]
    queue = _merge_queue_run(gh, commit, notes)
    sources: LaneSources | None = None
    if queue is not None:
        run_id, artifacts = queue
        if LANE_SOURCES in artifacts:
            data = _download_json(gh, run_id, LANE_SOURCES, "lane-sources.json")
            sources = _lane_sources(data, commit)
            if sources is None:
                notes.append(f"マージキューの run {run_id} の {LANE_SOURCES} が commit と合わない")
        else:
            notes.append(f"マージキューの run {run_id} に {LANE_SOURCES} が無い")

    if queue is None or sources is None:
        changed = sorted(set(list_lanes(commit)) & walk.undecided)
        for lane in changed:
            walk.run_on_main(lane)
        reason = "マージキューの run が無い" if queue is None and not notes else "; ".join(notes)
        log(
            f"{short}: {reason}。list-test-lanes.sh で届いたレーンを main で流す: {_names(changed)}"
        )
        return

    run_id, artifacts = queue
    queued = [lane for lane in sources.merge_group if lane in walk.undecided]
    from_pr = [
        lane
        for lane in sources.pull_request
        if lane in walk.undecided and lane not in sources.merge_group
    ]
    pr_artifacts = verify_pr_run(gh, sources, notes) if from_pr else None
    pr_run = sources.pr_run
    taken_queue: list[str] = []
    taken_pr: list[str] = []
    missing: list[str] = []
    for lane in sorted(set(queued + from_pr)):
        artifact = f"{RESULTS_PREFIX}{walk.jobs[lane]['slug']}"
        if lane in queued and artifact in artifacts:
            walk.take(lane, Latest(lane, commit, run_id, run_id, artifact))
            taken_queue.append(lane)
        elif (
            lane in from_pr
            and pr_run is not None
            and pr_artifacts is not None
            and artifact in pr_artifacts
        ):
            walk.take(lane, Latest(lane, commit, pr_run, pr_run, artifact))
            taken_pr.append(lane)
        else:
            walk.run_on_main(lane)
            missing.append(lane)
    parts = [f"マージキューの run {run_id} から: {_names(taken_queue)}"]
    if from_pr:
        parts.append(f"PR #{sources.pr} の run {sources.pr_run} から: {_names(taken_pr)}")
    if missing:
        parts.append(f"結果の artifact が無いので main で流す: {_names(missing)}")
    if notes:
        parts.append(f"（{'; '.join(notes)}）")
    log(f"{short}: " + " / ".join(parts))


def resolve(
    head: str,
    commits: list[str],
    report_lanes: object,
    gh: GitHub,
    *,
    list_lanes: ListLanes,
    is_ancestor: IsAncestor,
    max_commits: int = DEFAULT_MAX_COMMITS,
    current_run: int | None = None,
    log: Log = lambda line: None,
) -> DevReport:
    """head から first-parent で遡り、レーンごとに結果を拾う。commits は head から始まる first-parent の並び。"""
    if not _SHA.fullmatch(head) or not commits or commits[0] != head:
        raise DevSourcesError(f"head が 40 桁の SHA でないか、commits の先頭でありません: {head}")
    try:
        jobs = {job["lane"]: job for job in report_matrix(report_lanes)}
    except ValueError as error:
        raise DevSourcesError(f"{head[:7]}:{REPORT_LANES}: {error}") from error
    walk = _Walk(jobs=jobs, undecided=set(jobs))
    reached = False
    for depth, commit in enumerate(commits[: max_commits + 1]):
        if not walk.undecided:
            reached = True
            break
        notes: list[str] = []
        prev = find_prev_run(
            gh, commit, head, is_ancestor=is_ancestor, current_run=current_run, notes=notes
        )
        if prev is not None:
            carried = sorted(walk.undecided & set(prev.lanes))
            added = sorted(walk.undecided - set(prev.lanes))
            for lane in carried:
                lane_commit, lane_run = prev.lanes[lane]
                walk.take(lane, Latest(lane, lane_commit, lane_run, prev.run_id, LANE_LATEST))
            for lane in added:
                walk.run_on_main(lane)
            line = f"{commit[:7]}: 前の開発版の run {prev.run_id} から持ち越す: {len(carried)} 本"
            if added:
                line += f" / 前の結果に無いので main で流す: {_names(added)}"
            log(line)
            reached = True
            break
        if notes:
            log(f"{commit[:7]}: 前の開発版の run として使わない（{'; '.join(notes)}）")
        if depth == max_commits:
            break
        _decide_commit(gh, walk, commit, list_lanes, log)
    if walk.undecided:
        rest = sorted(walk.undecided)
        if not reached:
            log(
                f"前の開発版の run が {max_commits} コミット以内に無いので、main で流す: {_names(rest)}"
            )
        for lane in rest:
            walk.run_on_main(lane)
    on_main = sorted(walk.on_main)
    matrix = [{**jobs[lane], "commit": head} for lane in on_main]
    latest = [walk.latest[lane] for lane in sorted(walk.latest)]
    return DevReport(head=head, on_main=on_main, latest=latest, jobs=matrix)


# ---------------------------------------------------------------- report-sources.json と取り出し


@dataclass(frozen=True)
class SourcesFile:
    runs: list[tuple[str, list[str]]]
    latest: list[Latest]


def parse_sources(data: object) -> SourcesFile:
    """開発版の report-sources.json を読む。artifact の名前はレーンから決まるものだけを受ける。"""
    obj = _map(data)
    if _str(obj, "side") != "dev":
        raise DevSourcesError("report-sources.json が開発版ではありません")
    runs: list[tuple[str, list[str]]] = []
    for item in _list(obj.get("runs")):
        run = _map(item)
        commit, lanes = _str(run, "commit"), _str_list(run.get("lanes"))
        if commit is None or not _SHA.fullmatch(commit) or lanes is None:
            raise DevSourcesError("report-sources.json の runs の形が違います")
        runs.append((commit, lanes))
    latest: list[Latest] = []
    for item in _list(obj.get("latest")):
        entry = _map(item)
        lane, commit, artifact = _str(entry, "lane"), _str(entry, "commit"), _str(entry, "artifact")
        run_id, from_run = _int(entry.get("run_id")), _int(entry.get("from_run"))
        if lane is None or commit is None or not _SHA.fullmatch(commit) or artifact is None:
            raise DevSourcesError("report-sources.json の latest の形が違います")
        if run_id is None or from_run is None:
            raise DevSourcesError(f"report-sources.json の latest の {lane} に run の ID が無い")
        if artifact not in (LANE_LATEST, f"{RESULTS_PREFIX}{slug_of(lane)}"):
            raise DevSourcesError(f"{lane} の artifact の名前が違います: {artifact}")
        latest.append(Latest(lane, commit, run_id, from_run, artifact))
    lanes = [lane for _, names in runs for lane in names] + [e.lane for e in latest]
    if len(lanes) != len(set(lanes)):
        raise DevSourcesError("report-sources.json の runs と latest でレーンが重なります")
    return SourcesFile(runs=runs, latest=latest)


def _results_of(root: Path) -> dict[str, str]:
    data = _read_json(root / REPORT_LANES)
    try:
        return {job["lane"]: job["results"] for job in report_matrix(data)}
    except ValueError as error:
        raise DevSourcesError(str(error)) from error


def _copy_results(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)

    # artifact から来た木なので、リンクは辿らずに外す。
    def links(directory: str, names: list[str]) -> list[str]:
        return [name for name in names if (Path(directory) / name).is_symlink()]

    shutil.copytree(src, dst, symlinks=True, ignore=links)


def _write_source(results_dir: Path, lane: str, commit: str) -> None:
    text = json.dumps({"lane": lane, "commit": commit}, ensure_ascii=False) + "\n"
    (results_dir.parent / "source.json").write_text(text, encoding="utf-8")


def _results_path(results: dict[str, str], lane: str) -> str:
    path = results.get(lane)
    if path is None:
        raise DevSourcesError(f"{lane} は {REPORT_LANES} のレポートのレーンではありません")
    return path


def fetch(sources: SourcesFile, root: Path, gh: GitHub, log: Log = lambda line: None) -> None:
    """latest のレーンの結果を取り出し元ごとに取り、ルートの同じ場所に写して source.json を書く。"""
    results = _results_of(root)
    groups: dict[tuple[int, str], list[Latest]] = {}
    for entry in sources.latest:
        groups.setdefault((entry.from_run, entry.artifact), []).append(entry)
    for (run_id, artifact), entries in sorted(groups.items()):
        dest = Path(tempfile.mkdtemp(prefix="dev-sources-", dir=gh.work))
        try:
            gh.download(run_id, artifact, dest)
            for entry in entries:
                path = _results_path(results, entry.lane)
                src = dest / path
                if not src.is_dir():
                    raise DevSourcesError(
                        f"run {run_id} の {artifact} に {entry.lane} の結果がありません: {path}"
                    )
                _copy_results(src, root / path)
                _write_source(root / path, entry.lane, entry.commit)
        finally:
            shutil.rmtree(dest, ignore_errors=True)
        log(f"run {run_id} の {artifact} から: {_names([e.lane for e in entries])}")


def pack(sources: SourcesFile, root: Path, out: Path, *, commit: str, run_id: int) -> None:
    """全レーンの結果と source.json を out/lane-latest に、index を out/lane-latest-index に置く。"""
    if not _SHA.fullmatch(commit):
        raise DevSourcesError(f"--commit が 40 桁の SHA ではありません: {commit}")
    results = _results_of(root)
    entries: dict[str, tuple[str, int]] = {}
    for run_commit, lanes in sources.runs:
        if run_commit != commit:
            raise DevSourcesError(f"runs のコミットが --commit と違います: {run_commit}")
        for lane in lanes:
            entries[lane] = (commit, run_id)
    for entry in sources.latest:
        entries[entry.lane] = (entry.commit, entry.run_id)
    tree, index_dir = out / LANE_LATEST, out / LANE_LATEST_INDEX
    for directory in (tree, index_dir):
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True)
    for lane, (lane_commit, _) in sorted(entries.items()):
        path = _results_path(results, lane)
        src = root / path
        if not src.is_dir():
            raise DevSourcesError(f"{lane} の結果がありません: {path}")
        _copy_results(src, tree / path)
        _write_source(tree / path, lane, lane_commit)
    index = {
        "commit": commit,
        "lanes": {
            lane: {"commit": lane_commit, "run_id": lane_run}
            for lane, (lane_commit, lane_run) in sorted(entries.items())
        },
    }
    (index_dir / "lane-latest-index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


# ---------------------------------------------------------------- 実物（git・gh・list-test-lanes.sh）


def _run(args: list[str], root: Path, env: Mapping[str, str] | None = None) -> str:
    result = subprocess.run(args, cwd=root, capture_output=True, text=True, check=False, env=env)
    if result.returncode != 0:
        raise DevSourcesError(f"{' '.join(args)} が失敗しました: {result.stderr.strip()}")
    return result.stdout


def gh_api(root: Path) -> ApiGet:
    def get(path: str, params: Mapping[str, str]) -> object:
        args = ["gh", "api", "--method", "GET", path]
        for key, value in params.items():
            args += ["-f", f"{key}={value}"]
        return json.loads(_run(args, root))

    return get


def gh_download(root: Path, repo: str) -> Download:
    def download(run_id: int, artifact: str, dest: Path) -> None:
        _run(
            ["gh", "run", "download", str(run_id), "-R", repo, "-n", artifact, "-D", str(dest)],
            root,
        )

    return download


def git_ancestor(root: Path) -> IsAncestor:
    def is_ancestor(a: str, b: str) -> bool:
        result = subprocess.run(
            ["git", "merge-base", "--is-ancestor", a, b],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode not in (0, 1):
            raise DevSourcesError(
                f"git merge-base --is-ancestor {a} {b} が失敗しました: {result.stderr.strip()}"
            )
        return result.returncode == 0

    return is_ancestor


def list_test_lanes(root: Path) -> ListLanes:
    """list-test-lanes.sh C^1 C の lanes の名前。NO_PREV は渡さない。"""
    env = {k: v for k, v in os.environ.items() if k != "NO_PREV"}

    def lanes(commit: str) -> list[str]:
        out = _run([".githooks/ci/list-test-lanes.sh", f"{commit}^1", commit], root, env)
        line = next((ln for ln in out.splitlines() if ln.startswith("lanes=")), None)
        if line is None:
            raise DevSourcesError(f"list-test-lanes.sh が {commit[:7]} の lanes を出しません")
        items = _list(json.loads(line.removeprefix("lanes=")))
        names = [_str(_map(item), "lane") for item in items]
        return [name for name in names if name is not None]

    return lanes


def _work_dir(root: Path) -> Path:
    temp = os.environ.get("RUNNER_TEMP")
    base = Path(temp) if temp else root / ".pecot/tmp"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _repo_arg(value: str) -> str:
    if not _REPO.fullmatch(value):
        raise argparse.ArgumentTypeError(f"owner/repo の形ではありません: {value}")
    return value


def _log(line: str) -> None:
    print(line, file=sys.stderr)


def _read_lanes_at(root: Path, commit: str) -> object:
    # blob の無い clone では show が blob を取りに行くので、パスの有無は tree だけで引く。
    spec = f"{commit}:{REPORT_LANES}"
    check = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", spec],
        cwd=root,
        capture_output=True,
        check=False,
    )
    if check.returncode != 0:
        raise DevSourcesError(f"{commit[:7]} に {REPORT_LANES} がありません")
    try:
        return json.loads(_run(["git", "show", spec], root))
    except json.JSONDecodeError as error:
        raise DevSourcesError(f"{spec} を JSON として読めません: {error}") from error


def _cmd_resolve(args: argparse.Namespace) -> int:
    root: Path = args.root
    head = _run(["git", "rev-parse", "--verify", f"{args.head}^{{commit}}"], root).strip()
    commits = _run(
        ["git", "rev-list", "--first-parent", f"--max-count={args.max_commits + 1}", head], root
    ).split()
    run_id = os.environ.get("GITHUB_RUN_ID")
    work = Path(tempfile.mkdtemp(prefix="dev-sources-", dir=_work_dir(root)))
    try:
        gh = GitHub(args.repo, gh_api(root), gh_download(root, args.repo), work)
        report = resolve(
            head,
            commits,
            _read_lanes_at(root, head),
            gh,
            list_lanes=list_test_lanes(root),
            is_ancestor=git_ancestor(root),
            max_commits=args.max_commits,
            current_run=int(run_id) if run_id and run_id.isdigit() else None,
            log=_log,
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(json.dumps(report.to_json(), ensure_ascii=False, separators=(",", ":")))
    return 0


def _cmd_fetch(args: argparse.Namespace) -> int:
    root: Path = args.root
    sources = parse_sources(_read_json(args.sources))
    work = Path(tempfile.mkdtemp(prefix="dev-sources-", dir=_work_dir(root)))
    try:
        gh = GitHub(args.repo, gh_api(root), gh_download(root, args.repo), work)
        fetch(sources, root, gh, _log)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return 0


def _cmd_pack(args: argparse.Namespace) -> int:
    sources = parse_sources(_read_json(args.sources))
    pack(sources, args.root, args.out, commit=args.commit, run_id=args.run_id)
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="開発版のテストレポートの材料")
    commands = parser.add_subparsers(dest="command", required=True)

    p_resolve = commands.add_parser("resolve", help="ReportSources と matrix を出す")
    p_resolve.add_argument("--head", required=True)
    p_resolve.add_argument("--repo", required=True, type=_repo_arg)
    p_resolve.add_argument("--max-commits", type=int, default=DEFAULT_MAX_COMMITS)
    p_resolve.add_argument("--root", type=Path, default=Path("."))
    p_resolve.set_defaults(handler=_cmd_resolve)

    p_fetch = commands.add_parser("fetch", help="latest のレーンの結果を取り出す")
    p_fetch.add_argument("--sources", required=True, type=Path)
    p_fetch.add_argument("--repo", required=True, type=_repo_arg)
    p_fetch.add_argument("--root", required=True, type=Path)
    p_fetch.set_defaults(handler=_cmd_fetch)

    p_pack = commands.add_parser("pack", help="lane-latest と lane-latest-index を作る")
    p_pack.add_argument("--sources", required=True, type=Path)
    p_pack.add_argument("--root", required=True, type=Path)
    p_pack.add_argument("--out", required=True, type=Path)
    p_pack.add_argument("--commit", required=True)
    p_pack.add_argument("--run-id", required=True, type=int)
    p_pack.set_defaults(handler=_cmd_pack)

    args = parser.parse_args(argv[1:])
    if args.command == "resolve" and args.max_commits < 1:
        parser.error("--max-commits は 1 以上にします")
    try:
        return cast("Callable[[argparse.Namespace], int]", args.handler)(args)
    except DevSourcesError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
