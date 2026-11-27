"""dev_sources.py（開発版のテストレポートの材料）の確かめ。

GitHub の API・artifact の取り出し・list-test-lanes.sh は、関数を差し替えて偽の応答を返す。
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/test_report"))

import dev_sources  # noqa: E402
from attach import run_attached  # noqa: E402
from dev_sources import DevSourcesError, GitHub, Latest  # noqa: E402

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts/test_report/dev_sources.py"
_REPO = "o/r"
C0, C1, C2, C3, C4 = ("0" * 39 + str(i) for i in range(5))
P = "f" * 40
_LANES = [
    {"project": "a", "target": "test-unit", "results": "a/test-results/test-unit/allure-results"},
    {"project": "b", "target": "test-unit", "results": "b/test-results/test-unit/allure-results"},
    {"project": ".gh", "target": "test-ci", "results": ".gh/test-results/test-ci/allure-results"},
    {"project": "x", "target": "test-bash", "excluded": "bash の *.test.sh"},
]
A, B, G = "a:test-unit", "b:test-unit", ".gh:test-ci"
_ALL = sorted([A, B, G])


def _art(lane: str) -> str:
    return f"allure-results-{dev_sources.slug_of(lane)}"


def _dev_run(run_id: int, sha: str, **over: object) -> dict[str, object]:
    run: dict[str, object] = {
        "id": run_id,
        "path": ".github/workflows/test-report.yml",
        "event": "push",
        "conclusion": "success",
        "head_sha": sha,
        "head_repository": {"full_name": _REPO},
    }
    return {**run, **over}


def _ci_run(run_id: int, sha: str, event: str, **over: object) -> dict[str, object]:
    run: dict[str, object] = {
        "id": run_id,
        "path": ".github/workflows/ci.yml",
        "event": event,
        "head_sha": sha,
        "head_branch": "feat/x" if event == "pull_request" else "gh-readonly-queue/main/pr-7",
        "head_repository": {"full_name": _REPO},
    }
    return {**run, **over}


class FakeGitHub:
    """GitHub の REST と gh run download の偽物。呼ばれたパスを calls に残す。"""

    def __init__(self) -> None:
        self.dev_runs: dict[str, list[dict[str, object]]] = {}
        self.queue_runs: dict[str, list[dict[str, object]]] = {}
        self.runs: dict[int, dict[str, object]] = {}
        self.ci_result: dict[int, str] = {}
        self.artifacts: dict[int, dict[str, bool]] = {}
        self.files: dict[tuple[int, str], dict[str, str]] = {}
        self.pulls: dict[int, dict[str, object]] = {}
        self.calls: list[str] = []
        self.downloads: list[tuple[int, str]] = []

    def api(self, path: str, params: Mapping[str, str]) -> object:
        self.calls.append(path + "?" + "&".join(f"{k}={v}" for k, v in sorted(params.items())))
        prefix = f"repos/{_REPO}/"
        rest = path.removeprefix(prefix)
        if rest == "actions/workflows/test-report.yml/runs":
            assert params["status"] == "success"
            return {"workflow_runs": self.dev_runs.get(params["head_sha"], [])}
        if rest == "actions/runs":
            assert params["event"] == "merge_group" and "status" not in params
            return {"workflow_runs": self.queue_runs.get(params["head_sha"], [])}
        parts = rest.split("/")
        if parts[:2] == ["actions", "runs"] and len(parts) == 4 and parts[3] == "jobs":
            conclusion = self.ci_result.get(int(parts[2]), "success")
            return {
                "jobs": [
                    {"name": "lanes", "conclusion": "success"},
                    {"name": "ci-result", "conclusion": conclusion},
                ]
            }
        if parts[:2] == ["actions", "runs"] and len(parts) == 4 and parts[3] == "artifacts":
            names = self.artifacts.get(int(parts[2]), {})
            return {"artifacts": [{"name": n, "expired": e} for n, e in names.items()]}
        if parts[:2] == ["actions", "runs"] and len(parts) == 3:
            return self.runs[int(parts[2])]
        if parts[0] == "pulls":
            return self.pulls[int(parts[1])]
        raise AssertionError(f"想定していない API: {path}")

    def download(self, run_id: int, artifact: str, dest: Path) -> None:
        self.downloads.append((run_id, artifact))
        for name, text in self.files[(run_id, artifact)].items():
            (dest / name).parent.mkdir(parents=True, exist_ok=True)
            (dest / name).write_text(text, encoding="utf-8")

    def add_artifacts(self, run_id: int, *names: str, expired: bool = False) -> None:
        self.artifacts.setdefault(run_id, {}).update(dict.fromkeys(names, expired))

    def add_prev(self, run_id: int, sha: str, lanes: dict[str, tuple[str, int]]) -> None:
        """lane-latest と index を持つ、前の開発版の run を置く。"""
        self.dev_runs.setdefault(sha, []).append(_dev_run(run_id, sha))
        self.add_artifacts(run_id, "lane-latest", "lane-latest-index")
        index = {
            "commit": sha,
            "lanes": {k: {"commit": c, "run_id": r} for k, (c, r) in lanes.items()},
        }
        self.files[(run_id, "lane-latest-index")] = {"lane-latest-index.json": json.dumps(index)}

    def add_queue(
        self,
        run_id: int,
        sha: str,
        merge_group: list[str],
        pull_request: list[str] | None = None,
        *,
        results: list[str] | None = None,
        pr_run: int | None = None,
    ) -> None:
        """lane-sources と、results のレーンの結果を持つマージキューの run を置く。"""
        self.queue_runs.setdefault(sha, []).append(_ci_run(run_id, sha, "merge_group"))
        lanes = merge_group if results is None else results
        self.add_artifacts(run_id, "lane-sources", *(_art(lane) for lane in lanes))
        sources = {
            "commit": sha,
            "pr": 7 if pr_run else None,
            "pr_head": P if pr_run else None,
            "pr_run": pr_run,
            "merge_group": merge_group,
            "pull_request": pull_request or [],
        }
        self.files[(run_id, "lane-sources")] = {"lane-sources.json": json.dumps(sources)}

    def add_pr_run(self, run_id: int, lanes: list[str], **over: object) -> None:
        self.runs[run_id] = {**_ci_run(run_id, P, "pull_request"), **over}
        self.add_artifacts(run_id, *(_art(lane) for lane in lanes))
        self.pulls[7] = {
            "number": 7,
            "base": {"repo": {"full_name": _REPO}},
            "head": {"sha": P, "ref": "feat/x", "repo": {"full_name": _REPO}},
        }


def _resolve(
    fake: FakeGitHub,
    tmp_path: Path,
    commits: list[str],
    *,
    changed: Mapping[str, list[str]] | None = None,
    not_ancestor: set[str] | None = None,
    max_commits: int = 50,
    current_run: int | None = None,
) -> tuple[dict[str, Any], list[str], list[str]]:
    """resolve を動かし、出力の JSON・ログ・list-test-lanes.sh を呼んだコミットを返す。"""
    logs: list[str] = []
    listed: list[str] = []

    def list_lanes(commit: str) -> list[str]:
        listed.append(commit)
        return list((changed or {}).get(commit, []))

    gh = GitHub(_REPO, fake.api, fake.download, tmp_path)
    report = dev_sources.resolve(
        commits[0],
        commits,
        _LANES,
        gh,
        list_lanes=list_lanes,
        is_ancestor=lambda a, b: a not in (not_ancestor or set()),
        max_commits=max_commits,
        current_run=current_run,
        log=logs.append,
    )
    return report.to_json(), logs, listed


def _latest(lane: str, commit: str, run_id: int, from_run: int, artifact: str) -> dict[str, object]:
    return Latest(lane, commit, run_id, from_run, artifact).to_json()


def _carried(lane: str, prev: int, commit: str = C4, run_id: int = 1) -> dict[str, object]:
    return _latest(lane, commit, run_id, prev, "lane-latest")


def _matrix(lanes: list[str], head: str = C0) -> list[dict[str, str]]:
    jobs = {job["lane"]: job for job in dev_sources.report_matrix(_LANES)}
    return [{**jobs[lane], "commit": head} for lane in lanes]


# ---------------------------------------------------------------- resolve


@allure.title(
    "マージキューの結果で変更の届いたレーンを替え、ほかのレーンは前の開発版の run から持ち越す"
)
def test_resolve_takes_queue_results_and_carries_the_rest(tmp_path: Path) -> None:
    """マージキューを通ったコミットの後に開発版の run が動く場合のテストです。キューの run が流したレーンはその結果を使い、ほかのレーンは前の run の index の値のまま持ち越すことを確認します。"""
    with allure.step("キューの run と前の開発版の run を置き、材料を決める"):
        fake = FakeGitHub()
        fake.add_queue(100, C0, [A])
        fake.add_prev(90, C1, dict.fromkeys(_ALL, (C4, 1)))
        out, logs, listed = _resolve(fake, tmp_path, [C0, C1, C2])
    with allure.step("キューの結果と持ち越しの結果で、main で流すレーンが無いことを確かめる"):
        assert out == {
            "sources": {
                "side": "dev",
                "runs": [],
                "missing": [],
                "latest": [
                    _carried(G, 90),
                    _latest(A, C0, 100, 100, _art(A)),
                    _carried(B, 90),
                ],
            },
            "matrix": [],
        }
        assert listed == []
        assert logs == [
            f"{C0[:7]}: マージキューの run 100 から: {A}",
            f"{C1[:7]}: 前の開発版の run 90 から持ち越す: 2 本",
        ]


@allure.title(
    "マージキューが省いたレーンは、lane-sources が指す PR の run の結果を、キューのコミットの結果として使う"
)
def test_resolve_takes_pull_request_lanes_from_the_pr_run(tmp_path: Path) -> None:
    """積のモードでマージキューが省いたレーンの場合のテストです。確かめに合う PR の run の artifact を取り出し元にし、レーンのコミットはキューのコミットになることを確認します。"""
    with allure.step("PR の run を指す lane-sources を置き、材料を決める"):
        fake = FakeGitHub()
        fake.add_queue(100, C0, [A], [B], pr_run=200)
        fake.add_pr_run(200, [B])
        fake.add_prev(90, C1, dict.fromkeys(_ALL, (C4, 1)))
        out, logs, _ = _resolve(fake, tmp_path, [C0, C1])
    with allure.step("PR の run の結果と、キューのコミットを確かめる"):
        assert out["sources"]["latest"] == [
            _carried(G, 90),
            _latest(A, C0, 100, 100, _art(A)),
            _latest(B, C0, 200, 200, _art(B)),
        ]
        assert out["sources"]["runs"] == []
        assert f"PR #7 の run 200 から: {B}" in logs[0]


def _pr_defects() -> list[tuple[str, dict[str, object], dict[str, object]]]:
    fork = {"full_name": "fork/r"}
    return [
        ("path", {"path": ".github/workflows/other.yml"}, {}),
        ("event", {"event": "push"}, {}),
        ("head_repository", {"head_repository": fork}, {}),
        ("head_sha", {"head_sha": C3}, {}),
        ("pr-head-sha", {}, {"head": {"sha": C3, "ref": "feat/x", "repo": {"full_name": _REPO}}}),
        ("pr-head-ref", {}, {"head": {"sha": P, "ref": "other", "repo": {"full_name": _REPO}}}),
        ("pr-head-repo", {}, {"head": {"sha": P, "ref": "feat/x", "repo": fork}}),
        ("pr-base-repo", {}, {"base": {"repo": fork}}),
    ]


@allure.title("PR の run が確かめ（{param_id}）に外れると、その結果を使わず main で流す")
@pytest.mark.parametrize(
    ("run_over", "pull_over"),
    [(r, p) for _, r, p in _pr_defects()],
    ids=[name for name, _, _ in _pr_defects()],
)
def test_resolve_runs_pull_request_lanes_on_main_when_the_pr_run_is_off(
    tmp_path: Path, run_over: dict[str, object], pull_over: dict[str, object]
) -> None:
    """lane-sources が指す PR の run か PR が、出どころの確かめに合わない場合のテストです。PR の run の結果を拾わず、省かれたレーンを main で流すことを確認します。"""
    with allure.step("確かめに外れる PR の run を置き、材料を決める"):
        fake = FakeGitHub()
        fake.add_queue(100, C0, [A], [B], pr_run=200)
        fake.add_pr_run(200, [B], **run_over)
        fake.pulls[7] = {**fake.pulls[7], **pull_over}
        fake.add_prev(90, C1, dict.fromkeys(_ALL, (C4, 1)))
        out, _, _ = _resolve(fake, tmp_path, [C0, C1])
    with allure.step("省かれたレーンを main で流すことを確かめる"):
        assert out["sources"]["runs"] == [{"commit": C0, "lanes": [B]}]
        assert out["matrix"] == _matrix([B])
        assert [e["lane"] for e in out["sources"]["latest"]] == [G, A]


@allure.title(
    "マージキューを通らないコミットでは、list-test-lanes.sh で出した変更の届いたレーンを main で流す"
)
def test_resolve_runs_lanes_of_commits_outside_the_queue_on_main(tmp_path: Path) -> None:
    """リリースの land のように、マージキューの run の無いコミットの場合のテストです。`list-test-lanes.sh` のレーンのうち、レポートのレーンだけを main で流し、ほかは持ち越すことを確認します。"""
    with allure.step("キューの run の無いコミットと前の開発版の run を置き、材料を決める"):
        fake = FakeGitHub()
        fake.add_prev(90, C1, dict.fromkeys(_ALL, (C4, 1)))
        out, logs, listed = _resolve(
            fake, tmp_path, [C0, C1], changed={C0: [A, "x:test-bash", "y:lint"]}
        )
    with allure.step("届いたレーンだけを main で流すことを確かめる"):
        assert listed == [C0]
        assert out["sources"]["runs"] == [{"commit": C0, "lanes": [A]}]
        assert out["matrix"] == _matrix([A])
        assert out["sources"]["latest"] == [_carried(G, 90), _carried(B, 90)]
        assert logs[0] == (
            f"{C0[:7]}: マージキューの run が無い。list-test-lanes.sh で届いたレーンを main で流す: {A}"
        )


@allure.title(
    "マージキューの run に {param_id} とき、list-test-lanes.sh で届いたレーンを main で流す"
)
@pytest.mark.parametrize(
    ("over", "ci_result", "artifacts"),
    [
        ({"path": ".github/workflows/other.yml"}, "success", True),
        ({"head_repository": {"full_name": "fork/r"}}, "success", True),
        ({"head_sha": C3}, "success", True),
        ({}, "failure", True),
        ({}, "success", False),
    ],
    ids=["path が違う", "リポが違う", "head が違う", "ci-result が落ちた", "lane-sources が無い"],
)
def test_resolve_falls_back_to_list_test_lanes_when_the_queue_run_is_off(
    tmp_path: Path, over: dict[str, object], ci_result: str, artifacts: bool
) -> None:
    """マージキューの run が確かめに外れるか、`lane-sources` を持たない場合のテストです。キューの結果を使わず、`list-test-lanes.sh` で出したレーンを main で流すことを確認します。"""
    with allure.step("確かめに外れるキューの run を置き、材料を決める"):
        fake = FakeGitHub()
        fake.add_queue(100, C0, [A, B])
        fake.queue_runs[C0][0].update(over)
        fake.ci_result[100] = ci_result
        if not artifacts:
            del fake.artifacts[100]["lane-sources"]
        fake.add_prev(90, C1, dict.fromkeys(_ALL, (C4, 1)))
        out, _, listed = _resolve(fake, tmp_path, [C0, C1], changed={C0: [A]})
    with allure.step("キューの結果を使わず、届いたレーンを main で流すことを確かめる"):
        assert listed == [C0]
        assert out["sources"]["runs"] == [{"commit": C0, "lanes": [A]}]
        assert (100, _art(A)) not in fake.downloads
        assert [e["lane"] for e in out["sources"]["latest"]] == [G, B]


@allure.title("一番新しい変更の結果が無いレーンは、それより古いコミットの結果を使わず main で流す")
def test_resolve_does_not_fall_back_to_older_results(tmp_path: Path) -> None:
    """新しいコミットのキューの run が、変更の届いたレーンの artifact を持たない場合のテストです。古いコミットのキューの run と前の開発版の run に結果があっても、そのレーンを main で流すことを確認します。"""
    with allure.step("新しいキューの run は結果を持たず、古いキューの run は持つ形で材料を決める"):
        fake = FakeGitHub()
        fake.add_queue(101, C0, [A], results=[])
        fake.add_queue(100, C1, [A, B])
        fake.add_prev(90, C2, dict.fromkeys(_ALL, (C4, 1)))
        out, logs, _ = _resolve(fake, tmp_path, [C0, C1, C2])
    with allure.step("古い結果を使わず main で流し、ほかのレーンは新しい順に決まることを確かめる"):
        assert out["sources"]["runs"] == [{"commit": C0, "lanes": [A]}]
        assert out["sources"]["latest"] == [
            _carried(G, 90),
            _latest(B, C1, 100, 100, _art(B)),
        ]
        assert "結果の artifact が無いので main で流す: " + A in logs[0]


@allure.title("期限の切れた artifact は、無いものとして main で流す")
def test_resolve_treats_expired_artifacts_as_missing(tmp_path: Path) -> None:
    """マージキューの run の結果の artifact が、期限切れになっている場合のテストです。その結果を拾わず、そのレーンを main で流すことを確認します。"""
    with allure.step("期限切れの artifact を持つキューの run を置き、材料を決める"):
        fake = FakeGitHub()
        fake.add_queue(100, C0, [A])
        fake.add_artifacts(100, _art(A), expired=True)
        fake.add_prev(90, C1, dict.fromkeys(_ALL, (C4, 1)))
        out, _, _ = _resolve(fake, tmp_path, [C0, C1])
    with allure.step("期限切れのレーンを main で流すことを確かめる"):
        assert out["sources"]["runs"] == [{"commit": C0, "lanes": [A]}]


@allure.title("前の開発版の run が無いと、決まらなかったレーンを main で流す")
def test_resolve_runs_undecided_lanes_on_main_without_a_previous_run(tmp_path: Path) -> None:
    """最初のコミットまで遡っても、前の開発版の run が無い場合のテストです。キューの結果で決まったレーンのほかは、すべて main で流すことを確認します。"""
    with allure.step("前の run の無い履歴で材料を決める"):
        fake = FakeGitHub()
        fake.add_queue(100, C1, [A])
        out, logs, _ = _resolve(fake, tmp_path, [C0, C1])
    with allure.step("キューの結果のほかを main で流すことを確かめる"):
        assert out["sources"]["latest"] == [_latest(A, C1, 100, 100, _art(A))]
        assert out["sources"]["runs"] == [{"commit": C0, "lanes": [G, B]}]
        assert out["matrix"] == _matrix([G, B])
        assert logs[-1] == f"前の開発版の run が 50 コミット以内に無いので、main で流す: {G}, {B}"


@allure.title("前の開発版の run が遡る上限の {param_id} にあるとき、持ち越すかを決める")
@pytest.mark.parametrize(
    ("position", "carried"), [(2, True), (3, False)], ids=["上限ちょうど", "上限の外"]
)
def test_resolve_stops_at_max_commits(tmp_path: Path, position: int, carried: bool) -> None:
    """`--max-commits` を 2 にして、前の開発版の run を上限の位置と、その外に置く場合のテストです。上限ちょうどなら持ち越し、外なら遡りを止めて、決まらなかったレーンを main で流すことを確認します。"""
    with allure.step("前の run を上限の前後に置いて材料を決める"):
        commits = [C0, C1, C2, C3]
        fake = FakeGitHub()
        fake.add_prev(90, commits[position], dict.fromkeys(_ALL, (C4, 1)))
        out, _, listed = _resolve(fake, tmp_path, commits, max_commits=2)
    with allure.step("上限までのコミットだけを調べることを確かめる"):
        assert listed == [C0, C1]
        assert not any(C3 in call for call in fake.calls)
        if carried:
            assert out["sources"]["runs"] == []
            assert [e["lane"] for e in out["sources"]["latest"]] == _ALL
        else:
            assert out["sources"]["runs"] == [{"commit": C0, "lanes": _ALL}]
            assert out["sources"]["latest"] == []


def _dev_defects() -> list[tuple[str, dict[str, object]]]:
    return [
        ("path", {"path": ".github/workflows/pages-build.yml"}),
        ("event", {"event": "pull_request"}),
        ("conclusion", {"conclusion": "failure"}),
        ("head_repository", {"head_repository": {"full_name": "fork/r"}}),
        ("head_sha", {"head_sha": C2}),
    ]


@allure.title("前の開発版の run が確かめ（{param_id}）に外れると、持ち越さない")
@pytest.mark.parametrize("over", [o for _, o in _dev_defects()], ids=[n for n, _ in _dev_defects()])
def test_resolve_skips_previous_runs_off_the_checks(
    tmp_path: Path, over: dict[str, object]
) -> None:
    """前の開発版の run の path・event・conclusion・リポジトリ・head が合わない場合のテストです。その run から持ち越さず、全部のレーンを main で流すことを確認します。"""
    with allure.step("確かめに外れる前の run を置いて材料を決める"):
        fake = FakeGitHub()
        fake.add_prev(90, C1, dict.fromkeys(_ALL, (C4, 1)))
        fake.dev_runs[C1][0].update(over)
        out, _, _ = _resolve(fake, tmp_path, [C0, C1])
    with allure.step("持ち越さず、全部を main で流すことを確かめる"):
        assert out["sources"]["latest"] == []
        assert out["sources"]["runs"] == [{"commit": C0, "lanes": _ALL}]


@allure.title("前の開発版の run が {param_id} とき、持ち越さない")
@pytest.mark.parametrize(
    "defect",
    ["not-ancestor", "no-lane-latest", "index-commit", "index-shape", "current-run"],
    ids=[
        "祖先でない",
        "lane-latest が無い",
        "index の commit が違う",
        "index の形が違う",
        "この run",
    ],
)
def test_resolve_skips_previous_runs_without_a_usable_index(tmp_path: Path, defect: str) -> None:
    """前の開発版の run が祖先でないか、`lane-latest` と index が使えないか、この run そのものの場合のテストです。その run から持ち越さないことを確認します。"""
    with allure.step("使えない前の run を置いて材料を決める"):
        fake = FakeGitHub()
        fake.add_prev(90, C1, dict.fromkeys(_ALL, (C4, 1)))
        index = fake.files[(90, "lane-latest-index")]
        if defect == "no-lane-latest":
            del fake.artifacts[90]["lane-latest"]
        elif defect == "index-commit":
            index["lane-latest-index.json"] = json.dumps({"commit": C2, "lanes": {}})
        elif defect == "index-shape":
            index["lane-latest-index.json"] = json.dumps(
                {"commit": C1, "lanes": {A: {"commit": "x"}}}
            )
        out, logs, _ = _resolve(
            fake,
            tmp_path,
            [C0, C1],
            not_ancestor={C1} if defect == "not-ancestor" else None,
            current_run=90 if defect == "current-run" else None,
        )
    with allure.step("持ち越さず、全部を main で流すことを確かめる"):
        assert out["sources"]["latest"] == []
        assert out["sources"]["runs"] == [{"commit": C0, "lanes": _ALL}]
        if defect != "current-run":
            assert any("前の開発版の run として使わない" in line for line in logs)


@allure.title("前の結果に無いレーンは main で流し、レポートのレーンから外れたレーンは捨てる")
def test_resolve_runs_added_lanes_and_drops_removed_lanes(tmp_path: Path) -> None:
    """前の開発版の run の index と、今の `report-lanes.json` のレーンが違う場合のテストです。足したレーンを main で流し、外れたレーンを材料に入れないことを確認します。"""
    with allure.step("足したレーンと外れたレーンのある index で材料を決める"):
        fake = FakeGitHub()
        fake.add_prev(90, C1, {A: (C4, 1), G: (C3, 2), "old:test-unit": (C4, 1)})
        out, logs, _ = _resolve(fake, tmp_path, [C0, C1])
    with allure.step("足したレーンを main で流し、外れたレーンが無いことを確かめる"):
        assert out["sources"]["runs"] == [{"commit": C0, "lanes": [B]}]
        assert out["sources"]["latest"] == [_carried(G, 90, C3, 2), _carried(A, 90)]
        assert logs[-1].endswith(f"前の結果に無いので main で流す: {B}")


@allure.title("head が 40 桁の SHA でないと、材料を決めずに例外が発生する")
def test_resolve_rejects_a_head_that_is_not_a_full_sha(tmp_path: Path) -> None:
    """`resolve` に `HEAD` という名前を渡す場合のテストです。`DevSourcesError` が発生し、40 桁の SHA でない旨のメッセージが含まれることを確認します。"""
    with allure.step("名前の head で材料を決めると失敗することを確かめる"):
        with pytest.raises(DevSourcesError, match="40 桁の SHA"):
            _resolve(FakeGitHub(), tmp_path, ["HEAD"])


# ---------------------------------------------------------------- fetch・pack


def _root(tmp_path: Path) -> Path:
    root = tmp_path / "root"
    lanes = root / dev_sources.REPORT_LANES
    lanes.parent.mkdir(parents=True)
    lanes.write_text(json.dumps(_LANES), encoding="utf-8")
    return root


def _results(lane: str) -> str:
    return next(job["results"] for job in dev_sources.report_matrix(_LANES) if job["lane"] == lane)


def _sources(runs: list[str], latest: list[Latest]) -> dev_sources.SourcesFile:
    data = {
        "side": "dev",
        "runs": [{"commit": C0, "lanes": runs}] if runs else [],
        "missing": [],
        "latest": [entry.to_json() for entry in latest],
    }
    return dev_sources.parse_sources(data)


@allure.title(
    "fetch は、取り出し元ごとに 1 回ずつ artifact を取り、レーンの結果と source.json をルートに置く"
)
def test_fetch_copies_results_and_writes_source(tmp_path: Path) -> None:
    """キューの run と前の開発版の run から結果を取り出す場合のテストです。取り出し元ごとに 1 回ずつ取り、前の中身を消して写し、親に `source.json` を書くことを確認します。"""
    with allure.step("2 つの取り出し元を持つ材料で fetch を動かす"):
        root = _root(tmp_path)
        stale = root / _results(A) / "old-result.json"
        stale.parent.mkdir(parents=True)
        stale.write_text("{}", encoding="utf-8")
        fake = FakeGitHub()
        fake.files[(100, _art(A))] = {f"{_results(A)}/1-result.json": '{"a":1}'}
        fake.files[(90, "lane-latest")] = {
            f"{_results(B)}/2-result.json": '{"b":1}',
            f"{_results(G)}/3-result.json": '{"g":1}',
            "b/test-results/test-unit/source.json": '{"lane":"b:test-unit","commit":"x"}',
        }
        sources = _sources(
            [],
            [
                Latest(A, C1, 100, 100, _art(A)),
                Latest(B, C3, 2, 90, "lane-latest"),
                Latest(G, C4, 1, 90, "lane-latest"),
            ],
        )
        work = tmp_path / "work"
        work.mkdir()
        dev_sources.fetch(sources, root, GitHub(_REPO, fake.api, fake.download, work))
    with allure.step("写した中身と source.json を確かめる"):
        assert sorted(fake.downloads) == [(90, "lane-latest"), (100, _art(A))]
        assert not stale.exists()
        for lane, name, body, commit in [
            (A, "1-result.json", '{"a":1}', C1),
            (B, "2-result.json", '{"b":1}', C3),
            (G, "3-result.json", '{"g":1}', C4),
        ]:
            results = root / _results(lane)
            assert (results / name).read_text(encoding="utf-8") == body
            source = json.loads((results.parent / "source.json").read_text(encoding="utf-8"))
            assert source == {"lane": lane, "commit": commit}
        assert list(work.iterdir()) == []


@allure.title(
    "fetch は、artifact にレーンの結果が無いと、レーンと artifact の名前を示す例外が発生する"
)
def test_fetch_fails_when_the_artifact_lacks_the_lane(tmp_path: Path) -> None:
    """取り出した artifact に、レーンの結果のディレクトリが無い場合のテストです。`DevSourcesError` が発生し、run・artifact・レーンの名前がメッセージに含まれることを確認します。"""
    with allure.step("結果の無い artifact で fetch を動かすと失敗することを確かめる"):
        root = _root(tmp_path)
        fake = FakeGitHub()
        fake.files[(100, _art(A))] = {"other/x.json": "{}"}
        sources = _sources([], [Latest(A, C1, 100, 100, _art(A))])
        gh = GitHub(_REPO, fake.api, fake.download, tmp_path)
        with pytest.raises(
            DevSourcesError, match=re.escape(f"run 100 の {_art(A)} に {A} の結果がありません")
        ):
            dev_sources.fetch(sources, root, gh)


@allure.title(
    "pack は、全レーンの結果と source.json の木と、レーンのコミットと run の index を作る"
)
def test_pack_writes_lane_latest_and_index(tmp_path: Path) -> None:
    """main で流したレーンと拾ったレーンの結果がルートにある場合のテストです。`lane-latest` に全レーンの結果と `source.json` が入り、index に HEAD とレーンごとのコミットと run が入ることを確認します。"""
    with allure.step("ルートに結果を置いて pack を動かす"):
        root = _root(tmp_path)
        for lane in _ALL:
            (root / _results(lane)).mkdir(parents=True)
            (root / _results(lane) / "r-result.json").write_text(lane, encoding="utf-8")
        sources = _sources(
            [G], [Latest(A, C1, 100, 100, _art(A)), Latest(B, C3, 2, 90, "lane-latest")]
        )
        out = tmp_path / "out"
        dev_sources.pack(sources, root, out, commit=C0, run_id=500)
    with allure.step("木と index の中身を確かめる"):
        tree = out / "lane-latest"
        for lane, commit in [(A, C1), (B, C3), (G, C0)]:
            assert (tree / _results(lane) / "r-result.json").read_text(encoding="utf-8") == lane
            source = json.loads((tree / _results(lane)).parent.joinpath("source.json").read_text())
            assert source == {"lane": lane, "commit": commit}
        index = json.loads((out / "lane-latest-index/lane-latest-index.json").read_text())
        assert index == {
            "commit": C0,
            "lanes": {
                G: {"commit": C0, "run_id": 500},
                A: {"commit": C1, "run_id": 100},
                B: {"commit": C3, "run_id": 2},
            },
        }
        assert sorted(p.name for p in (out / "lane-latest-index").iterdir()) == [
            "lane-latest-index.json"
        ]


@allure.title("pack は、runs のコミットが --commit と違うと、例外が発生する")
def test_pack_rejects_runs_of_another_commit(tmp_path: Path) -> None:
    """report-sources.json の `runs` のコミットが、pack に渡したコミットと違う場合のテストです。`DevSourcesError` が発生することを確認します。"""
    with allure.step("違うコミットで pack を動かすと失敗することを確かめる"):
        sources = _sources([G], [])
        with pytest.raises(DevSourcesError, match="runs のコミットが --commit と違います"):
            dev_sources.pack(sources, _root(tmp_path), tmp_path / "out", commit=C1, run_id=1)


@allure.title(
    "report-sources.json の latest の artifact が {param_id} だと、読まずに例外が発生する"
)
@pytest.mark.parametrize(
    ("artifact", "side"),
    [("ci-base", "dev"), (_art(B), "dev"), (_art(A), "release")],
    ids=["決まりの外の名前", "ほかのレーンの名前", "開発版でない"],
)
def test_parse_sources_rejects_unexpected_artifacts(artifact: str, side: str) -> None:
    """`latest` の artifact の名前がレーンから決まる名前でないか、側が開発版でない場合のテストです。`DevSourcesError` が発生することを確認します。"""
    with allure.step("決まりの外の材料を読むと失敗することを確かめる"):
        data = {
            "side": side,
            "runs": [],
            "missing": [],
            "latest": [Latest(A, C1, 1, 1, artifact).to_json()],
        }
        with pytest.raises(DevSourcesError):
            dev_sources.parse_sources(data)


# ---------------------------------------------------------------- CLI


@allure.title("CLI の pack は、材料のファイルから lane-latest を作り、終了コード 0 で終わる")
def test_cli_pack_writes_the_tree(tmp_path: Path) -> None:
    """`dev_sources.py pack` を、材料のファイルとルートを渡して実行する場合のテストです。終了コード 0 で終わり、index のファイルができることを確認します。"""
    with allure.step("材料のファイルとルートを置き、CLI を動かす"):
        root = _root(tmp_path)
        (root / _results(A)).mkdir(parents=True)
        sources = tmp_path / "report-sources.json"
        sources.write_text(
            json.dumps(
                {"side": "dev", "runs": [{"commit": C0, "lanes": [A]}], "missing": [], "latest": []}
            ),
            encoding="utf-8",
        )
        args = [
            "pack",
            "--sources",
            str(sources),
            "--root",
            str(root),
            "--out",
            str(tmp_path / "out"),
        ]
        result = run_attached(
            [sys.executable, str(_SCRIPT), *args, "--commit", C0, "--run-id", "7"],
            capture_output=True,
            text=True,
            check=False,
        )
    with allure.step("終了コードと index を確かめる"):
        assert result.returncode == 0, result.stderr
        index = json.loads((tmp_path / "out/lane-latest-index/lane-latest-index.json").read_text())
        assert index == {"commit": C0, "lanes": {A: {"commit": C0, "run_id": 7}}}


@allure.title("CLI は、引数が {param_id} だと、終了コード {code} で終わる")
@pytest.mark.parametrize(
    ("args", "code", "message"),
    [
        (["resolve", "--head", "HEAD", "--repo", "o/r/x"], 2, "owner/repo の形ではありません"),
        (["resolve", "--head", "HEAD", "--repo", "o/r", "--max-commits", "0"], 2, "1 以上"),
        (
            [
                "pack",
                "--sources",
                "missing.json",
                "--root",
                ".",
                "--out",
                "o",
                "--commit",
                C0,
                "--run-id",
                "1",
            ],
            1,
            "ERROR:",
        ),
    ],
    ids=["repo の形が違う", "上限が 0", "材料のファイルが無い"],
)
def test_cli_rejects_wrong_arguments(
    tmp_path: Path, args: list[str], code: int, message: str
) -> None:
    """`dev_sources.py` に誤った引数か、無いファイルを渡す場合のテストです。API を呼ぶ前に、決まった終了コードで終わり、理由を標準エラーに出力することを確認します。"""
    with allure.step("誤った引数で CLI を動かす"):
        result = run_attached(
            [sys.executable, str(_SCRIPT), *args],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=False,
        )
    with allure.step("終了コードとエラーの出力を確かめる"):
        assert result.returncode == code
        assert message in result.stderr
