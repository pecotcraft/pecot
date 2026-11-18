"""pages_site/provenance.py のテスト。workflow_run で受けた run の出どころ（RunProvenance）を決める。"""

from __future__ import annotations

import copy
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/pages_site"))

from provenance import (  # noqa: E402
    BUILD_PATH,
    CI_PATH,
    Verdict,
    decide,
    open_prs,
    pr_candidates,
)

REPO = "pecotcraft/pecot"
API = "https://api.github.com/repos"
HEAD = "0e8a6f093da8158262625fe08026fe7c12231d8f"
STORED = "57e94ca7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
OTHER = "fd6e2b19bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def _repo_short(full_name: str, repo_id: int = 1) -> dict[str, Any]:
    # run の pull_requests の head.repo・base.repo は id・url・name だけを持つ。
    return {"id": repo_id, "url": f"{API}/{full_name}", "name": full_name.split("/")[1]}


def _run_pr(number: int, *, base: str = REPO, head_sha: str = HEAD) -> dict[str, Any]:
    return {
        "url": f"{API}/{base}/pulls/{number}",
        "id": 1000 + number,
        "number": number,
        "head": {"ref": f"feat/x/{number}", "sha": head_sha, "repo": _repo_short(REPO)},
        "base": {"ref": "main", "sha": OTHER, "repo": _repo_short(base, 2)},
    }


def _run(
    event: str, *, pull_requests: list[dict[str, Any]] | None = None, **over: Any
) -> dict[str, Any]:
    run: dict[str, Any] = {
        "id": 44214079368,
        "name": "pages-build",
        "path": BUILD_PATH,
        "event": event,
        "status": "completed",
        "conclusion": "success",
        "head_branch": "main",
        "head_sha": HEAD,
        "run_attempt": 1,
        "pull_requests": pull_requests or [],
        "repository": {"full_name": REPO},
        "head_repository": {"full_name": REPO, "fork": False},
    }
    run.update(over)
    return run


def _pull(
    number: int, *, state: str = "open", base: str = REPO, head_sha: str = HEAD
) -> dict[str, Any]:
    # GET /repos/{repo}/pulls/{n} の応答。base.repo は full_name を持つ。
    return {
        "number": number,
        "state": state,
        "head": {"ref": f"feat/x/{number}", "sha": head_sha, "repo": {"full_name": REPO}},
        "base": {"ref": "main", "sha": OTHER, "repo": {"full_name": base}},
    }


def _compare(status: str, ahead_by: int, behind_by: int) -> dict[str, Any]:
    return {
        "status": status,
        "ahead_by": ahead_by,
        "behind_by": behind_by,
        "total_commits": ahead_by,
    }


IN_MAIN = _compare("ahead", 3, 0)  # head_sha...main: main が head_sha を祖先に持つ
NOT_IN_MAIN = _compare("diverged", 2, 1)


def _decide(
    run: dict[str, Any],
    *,
    head_vs_main: dict[str, Any] | None = IN_MAIN,
    artifact_names: list[str] | None = None,
    stored_dev_sha: str | None = None,
    stored_vs_head: dict[str, Any] | None = None,
    pulls: dict[int, dict[str, Any]] | None = None,
) -> Verdict:
    return decide(
        run,
        repo=REPO,
        head_vs_main=head_vs_main,
        artifact_names=artifact_names if artifact_names is not None else [],
        stored_dev_sha=stored_dev_sha,
        stored_vs_head=stored_vs_head,
        pulls=pulls or {},
    )


def _accepted(verdict: Verdict) -> tuple[str | None, int | None, str | None, str | None, bool]:
    return (verdict.side, verdict.pr, verdict.head_sha, verdict.artifact, verdict.closed_pr)


DROPPED = (None, None, None, None, False)


# 開発版・リリース版


def test_push_run_is_dev() -> None:
    assert _accepted(_decide(_run("push"))) == ("dev", None, HEAD, "pages-side-dev", False)


def test_dispatch_with_dev_artifact_is_dev() -> None:
    verdict = _decide(_run("workflow_dispatch"), artifact_names=["pages-side-dev", "junit-a"])
    assert _accepted(verdict) == ("dev", None, HEAD, "pages-side-dev", False)


def test_dispatch_with_release_artifact_is_release() -> None:
    verdict = _decide(_run("workflow_dispatch"), artifact_names=["pages-side-release"])
    assert _accepted(verdict) == ("release", None, HEAD, "pages-side-release", False)


@pytest.mark.parametrize(
    "names", [[], ["junit-a"], ["pages-side-dev", "pages-side-release"], ["pages-side-pr-5"]]
)
def test_dispatch_without_exactly_one_side_artifact_is_dropped(names: list[str]) -> None:
    assert _accepted(_decide(_run("workflow_dispatch"), artifact_names=names)) == DROPPED


def test_push_ignores_artifact_names() -> None:
    verdict = _decide(_run("push"), artifact_names=["pages-side-release"])
    assert _accepted(verdict) == ("dev", None, HEAD, "pages-side-dev", False)


@pytest.mark.parametrize("event", ["push", "workflow_dispatch"])
def test_head_not_ancestor_of_main_is_dropped(event: str) -> None:
    verdict = _decide(_run(event), head_vs_main=NOT_IN_MAIN, artifact_names=["pages-side-release"])
    assert _accepted(verdict) == DROPPED


def test_dispatch_from_tag_named_main_is_dropped() -> None:
    # main という名前のタグで dispatch した run は head_branch=main になる。head_branch では受けない。
    run = _run("workflow_dispatch", head_branch="main")
    verdict = _decide(run, head_vs_main=NOT_IN_MAIN, artifact_names=["pages-side-release"])
    assert _accepted(verdict) == DROPPED


def test_head_branch_is_not_used_for_ancestor_run() -> None:
    run = _run("workflow_dispatch", head_branch="v1.2.3")
    verdict = _decide(run, artifact_names=["pages-side-release"])
    assert _accepted(verdict) == ("release", None, HEAD, "pages-side-release", False)


def test_missing_compare_is_dropped() -> None:
    assert _accepted(_decide(_run("push"), head_vs_main=None)) == DROPPED


@pytest.mark.parametrize("event", ["push", "workflow_dispatch"])
def test_other_repo_pr_in_pull_requests_does_not_drop_dev_or_release(event: str) -> None:
    # fork が上流の main から開いた PR が pull_requests に入っても、開発版・リリース版は落ちない。
    run = _run(event, pull_requests=[_run_pr(7, base="someone/pecot")])
    verdict = _decide(run, artifact_names=["pages-side-dev"])
    assert _accepted(verdict) == ("dev", None, HEAD, "pages-side-dev", False)


@pytest.mark.parametrize(
    ("status", "side"),
    [("identical", "dev"), ("ahead", "dev"), ("behind", None), ("diverged", None)],
)
def test_dev_against_stored_sha(status: str, side: str | None) -> None:
    verdict = _decide(
        _run("push"),
        stored_dev_sha=STORED,
        stored_vs_head=_compare(status, 0 if status == "identical" else 1, 0),
    )
    assert verdict.side == side


def test_dev_rerun_of_stored_sha_is_accepted() -> None:
    verdict = _decide(_run("push"), stored_dev_sha=HEAD, stored_vs_head=_compare("identical", 0, 0))
    assert _accepted(verdict) == ("dev", None, HEAD, "pages-side-dev", False)


def test_dev_with_stored_sha_but_no_compare_is_dropped() -> None:
    assert _accepted(_decide(_run("push"), stored_dev_sha=STORED, stored_vs_head=None)) == DROPPED


def test_release_does_not_look_at_stored_dev_sha() -> None:
    verdict = _decide(
        _run("workflow_dispatch"),
        artifact_names=["pages-side-release"],
        stored_dev_sha=STORED,
        stored_vs_head=_compare("behind", 0, 2),
    )
    assert _accepted(verdict) == ("release", None, HEAD, "pages-side-release", False)


# 全側に共通の確かめ


@pytest.mark.parametrize(
    "over",
    [
        {"path": ".github/workflows/ci.yaml"},
        {"path": ".github/workflows/pages-deploy.yml"},
        {"path": ".github/workflows/pages-build.yaml"},
        {"head_repository": {"full_name": "someone/pecot", "fork": True}},
        {"head_repository": None},
        {"conclusion": "failure"},
        {"conclusion": "cancelled"},
        {"conclusion": None},
    ],
)
@pytest.mark.parametrize("event", ["push", "workflow_dispatch", "pull_request"])
def test_path_head_repository_and_conclusion_must_match(over: dict[str, Any], event: str) -> None:
    run = _run(event, pull_requests=[_run_pr(5)], **over)
    verdict = _decide(run, artifact_names=["pages-side-dev"], pulls={5: _pull(5)})
    assert _accepted(verdict) == DROPPED


@pytest.mark.parametrize("event", ["schedule", "workflow_run", "pull_request_target", "release"])
def test_other_events_are_dropped(event: str) -> None:
    verdict = _decide(
        _run(event, pull_requests=[_run_pr(5)]),
        artifact_names=["pages-side-dev"],
        pulls={5: _pull(5)},
    )
    assert _accepted(verdict) == DROPPED


# PR 版（ci.yml の pull_request の run から受ける）


def _ci_run(*prs: dict[str, Any], **over: Any) -> dict[str, Any]:
    pulls = list(prs) if prs else [_run_pr(5)]
    run = _run("pull_request", pull_requests=pulls, path=CI_PATH, name="ci", head_branch="feat/x/5")
    run.update(over)
    return run


def _decide_ci(
    run: dict[str, Any],
    *,
    artifact_names: list[str] | None = None,
    pulls: dict[int, dict[str, Any]] | None = None,
) -> Verdict:
    return _decide(
        run,
        head_vs_main=None,
        artifact_names=["pages-side-pr-5"] if artifact_names is None else artifact_names,
        pulls={5: _pull(5)} if pulls is None else pulls,
    )


PR5 = ("pr", 5, HEAD, "pages-side-pr-5", False)


@pytest.mark.parametrize("conclusion", ["success", "failure"])
def test_ci_pull_request_run_is_pr_side(conclusion: str) -> None:
    # テストが落ちた PR でも、落ちた合否を PR 版で見せる。
    assert _accepted(_decide_ci(_ci_run(conclusion=conclusion))) == PR5


@pytest.mark.parametrize(
    "conclusion", ["cancelled", "timed_out", "skipped", "action_required", None]
)
def test_ci_run_with_other_conclusion_is_dropped(conclusion: str | None) -> None:
    assert _accepted(_decide_ci(_ci_run(conclusion=conclusion))) == DROPPED


@pytest.mark.parametrize(
    "names", [[], ["pages-junit-pecot-tools-test-cli"], ["pages-side-pr-6"], ["pages-side-dev"]]
)
def test_ci_run_without_its_pr_artifact_is_dropped(names: list[str]) -> None:
    verdict = _decide_ci(_ci_run(), artifact_names=names)
    assert (verdict.side, verdict.artifact, verdict.closed_pr) == (None, None, False)
    assert "pages-side-pr-5" in verdict.reason


@pytest.mark.parametrize(
    "event", ["push", "merge_group", "workflow_dispatch", "pull_request_target"]
)
def test_ci_runs_other_than_pull_request_are_dropped(event: str) -> None:
    # PR の作者は自分のブランチの ci.yml を書き換えられるので、ci.yml から開発版・リリース版は受けない。
    run = _ci_run(event=event, head_branch="main")
    verdict = _decide(
        run,
        artifact_names=["pages-side-dev", "pages-side-release", "pages-side-pr-5"],
        pulls={5: _pull(5)},
    )
    assert _accepted(verdict) == DROPPED


def test_ci_run_from_fork_is_dropped() -> None:
    run = _ci_run(head_repository={"full_name": "someone/pecot", "fork": True})
    assert _accepted(_decide_ci(run)) == DROPPED


def test_pull_request_does_not_need_main_ancestor() -> None:
    verdict = _decide(
        _ci_run(),
        head_vs_main=NOT_IN_MAIN,
        artifact_names=["pages-side-pr-5"],
        pulls={5: _pull(5)},
    )
    assert verdict.side == "pr"


def test_build_run_of_open_pull_request_is_dropped() -> None:
    # PR 版は ci.yml の run から作る。pages-build.yml の PR の run は閉じた PR の掃除だけ起こす。
    run = _run("pull_request", pull_requests=[_run_pr(5)])
    verdict = _decide(
        run, head_vs_main=None, artifact_names=["pages-side-pr-5"], pulls={5: _pull(5)}
    )
    assert (verdict.side, verdict.pr, verdict.artifact, verdict.closed_pr) == (None, 5, None, False)


def test_closed_pull_request_of_build_run_only_triggers_cleanup() -> None:
    run = _run("pull_request", pull_requests=[_run_pr(5)])
    verdict = _decide(run, head_vs_main=None, pulls={5: _pull(5, state="closed")})
    assert (verdict.side, verdict.pr, verdict.artifact, verdict.closed_pr) == (None, 5, None, True)


def test_closed_pull_request_of_ci_run_only_triggers_cleanup() -> None:
    verdict = _decide_ci(_ci_run(), pulls={5: _pull(5, state="closed")})
    assert (verdict.side, verdict.pr, verdict.artifact, verdict.closed_pr) == (None, 5, None, True)


def test_pr_candidates_filter_base_repo_and_head_sha() -> None:
    run = _ci_run(
        _run_pr(5),
        _run_pr(6, base="someone/pecot"),
        _run_pr(7, base="pecotcraft/other"),
        _run_pr(8, head_sha=OTHER),
    )
    assert pr_candidates(run, REPO) == [5]


def test_pr_candidates_need_url_not_only_name() -> None:
    # fork 先のリポも name は同じ pecot なので、url の owner まで見る。
    fork_base = {"id": 9, "url": f"{API}/someone/pecot", "name": "pecot"}
    pull = _run_pr(5)
    pull["base"]["repo"] = fork_base
    assert pr_candidates(_ci_run(pull), REPO) == []


def test_pull_request_from_other_repo_base_only_is_dropped() -> None:
    run = _ci_run(_run_pr(6, base="someone/pecot"))
    verdict = _decide_ci(run, artifact_names=["pages-side-pr-6"], pulls={6: _pull(6)})
    assert _accepted(verdict) == DROPPED


@pytest.mark.parametrize("prs", [[], [_run_pr(5), _run_pr(6)]])
def test_pull_request_not_narrowed_to_one_is_dropped(prs: list[dict[str, Any]]) -> None:
    run = _ci_run(pull_requests=prs)
    verdict = _decide_ci(
        run, artifact_names=["pages-side-pr-5", "pages-side-pr-6"], pulls={5: _pull(5), 6: _pull(6)}
    )
    assert _accepted(verdict) == DROPPED


def test_pull_request_with_other_repo_pr_still_narrows_to_one() -> None:
    run = _ci_run(_run_pr(5), _run_pr(6, base="someone/pecot"))
    assert _accepted(_decide_ci(run)) == PR5


def test_pull_request_whose_head_moved_is_dropped() -> None:
    verdict = _decide_ci(_ci_run(), pulls={5: _pull(5, head_sha=OTHER)})
    assert (verdict.side, verdict.closed_pr, verdict.artifact) == (None, False, None)


def test_pull_request_whose_pull_base_is_other_repo_is_dropped() -> None:
    verdict = _decide_ci(_ci_run(), pulls={5: _pull(5, base="someone/pecot")})
    assert (verdict.side, verdict.closed_pr) == (None, False)


def test_pull_request_without_pull_response_is_dropped() -> None:
    assert _decide_ci(_ci_run(), pulls={}).side is None


def test_decide_does_not_change_inputs() -> None:
    run = _ci_run()
    before = copy.deepcopy(run)
    _decide_ci(run)
    assert run == before


def test_reason_is_one_line() -> None:
    for verdict in (
        _decide(_run("push")),
        _decide(_run("push"), head_vs_main=NOT_IN_MAIN),
        _decide(_run("workflow_dispatch")),
        _decide_ci(_ci_run()),
        _decide_ci(_ci_run(), artifact_names=[]),
        _decide_ci(_ci_run(event="push")),
    ):
        assert verdict.reason
        assert "\n" not in verdict.reason


# open_prs


def test_open_prs_keeps_this_repo_and_sorts() -> None:
    pulls = [
        _pull(12),
        _pull(3),
        _pull(7, base="someone/pecot"),
        _pull(5),
        {"number": 9, "base": {}},
    ]
    assert open_prs(pulls, REPO) == [3, 5, 12]


def test_open_prs_empty() -> None:
    assert open_prs([], REPO) == []
