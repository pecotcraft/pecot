"""pages_site/provenance.py のテスト。workflow_run で受けた run の出どころ（RunProvenance）を決める。"""

from __future__ import annotations

import copy
import sys
from pathlib import Path
from typing import Any

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/pages_site"))

from provenance import (  # noqa: E402
    ARTIFACT_REPORT_DEV,
    ARTIFACT_REPORT_RELEASE,
    BUILD_PATH,
    REPORT_PATH,
    Verdict,
    decide,
    open_prs,
    pr_candidates,
    run_kind,
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


@allure.title("push の run は、開発版として受け付ける")
def test_push_run_is_dev() -> None:
    """`pages_site/provenance.py` の `decide` の、開発版の判定のテストです。`main` を祖先に持つ commit の `push` の run が、`dev` 側として受理され、artifact 名が `pages-side-dev` になることを確認します。"""
    with allure.step("push の run が dev として受け付けられることを確かめる"):
        assert _accepted(_decide(_run("push"))) == ("dev", None, HEAD, "pages-side-dev", False)


@allure.title("手動実行の run は、開発版の artifact を持つと、開発版として受け付ける")
def test_dispatch_with_dev_artifact_is_dev() -> None:
    """`workflow_dispatch` の run の artifact に、`pages-side-dev` が含まれる場合のテストです。`dev` 側として受理され、artifact 名が `pages-side-dev` になることを確認します。"""
    with allure.step("dev の artifact を持つ手動実行の run を判定する"):
        verdict = _decide(_run("workflow_dispatch"), artifact_names=["pages-side-dev", "junit-a"])
    with allure.step("dev として受け付けられることを確かめる"):
        assert _accepted(verdict) == ("dev", None, HEAD, "pages-side-dev", False)


@allure.title("手動実行の run は、リリース版の artifact を持つと、リリース版として受け付ける")
def test_dispatch_with_release_artifact_is_release() -> None:
    """`workflow_dispatch` の run の artifact に、`pages-side-release` が含まれる場合のテストです。`release` 側として受理され、artifact 名が `pages-side-release` になることを確認します。"""
    with allure.step("release の artifact を持つ手動実行の run を判定する"):
        verdict = _decide(_run("workflow_dispatch"), artifact_names=["pages-side-release"])
    with allure.step("release として受け付けられることを確かめる"):
        assert _accepted(verdict) == ("release", None, HEAD, "pages-side-release", False)


@allure.title(
    "手動実行の run は、側の artifact が 1 つに決まらないと、artifact 名が {names} の場合に破棄する"
)
@pytest.mark.parametrize(
    "names", [[], ["junit-a"], ["pages-side-dev", "pages-side-release"], ["pages-side-pr-5"]]
)
def test_dispatch_without_exactly_one_side_artifact_is_dropped(names: list[str]) -> None:
    """`workflow_dispatch` の run の artifact が、存在しない場合や、開発版とリリース版の両方がある場合のテストです。側を 1 つに決められないため、どの側としても受理しないことを確認します。"""
    with allure.step("side の artifact が 1 つでない手動実行の run が捨てられることを確かめる"):
        assert _accepted(_decide(_run("workflow_dispatch"), artifact_names=names)) == DROPPED


@allure.title("push の run は、artifact 名にかかわらず、開発版として受け付ける")
def test_push_ignores_artifact_names() -> None:
    """`push` の run に、リリース版の artifact 名を渡す場合のテストです。artifact 名は参照せず、`dev` 側として受理されることを確認します。"""
    with allure.step("release の artifact 名を持つ push の run を判定する"):
        verdict = _decide(_run("push"), artifact_names=["pages-side-release"])
    with allure.step("artifact 名を問わず、dev と判定することを確かめる"):
        assert _accepted(verdict) == ("dev", None, HEAD, "pages-side-dev", False)


@allure.title("{event} の run は、head が main の祖先でないと破棄する")
@pytest.mark.parametrize("event", ["push", "workflow_dispatch"])
def test_head_not_ancestor_of_main_is_dropped(event: str) -> None:
    """`push` と `workflow_dispatch` の run で、head の commit が `main` の祖先ではない場合のテストです。どちらの event も、どの側としても受理しないことを確認します。"""
    with allure.step("head が main の祖先でない run を判定する"):
        verdict = _decide(
            _run(event), head_vs_main=NOT_IN_MAIN, artifact_names=["pages-side-release"]
        )
    with allure.step("捨てられることを確かめる"):
        assert _accepted(verdict) == DROPPED


@allure.title("main という名前のタグから手動実行した run は、head が main の祖先でないと破棄する")
def test_dispatch_from_tag_named_main_is_dropped() -> None:
    """`main` という名前のタグから `workflow_dispatch` を実行して、`head_branch` が `main` になる場合のテストです。`head_branch` では判定せず、祖先の確認に失敗して破棄することを確認します。"""
    with allure.step("main という名前のタグから動いた手動実行の run を用意して判定する"):
        # main という名前のタグで dispatch した run は head_branch=main になる。head_branch では受けない。
        run = _run("workflow_dispatch", head_branch="main")
        verdict = _decide(run, head_vs_main=NOT_IN_MAIN, artifact_names=["pages-side-release"])
    with allure.step("捨てられることを確かめる"):
        assert _accepted(verdict) == DROPPED


@allure.title(
    "head_branch が main でなくても、main の祖先の commit なら、リリース版として受け付ける"
)
def test_head_branch_is_not_used_for_ancestor_run() -> None:
    """`head_branch` が `v1.2.3` の `workflow_dispatch` の run のテストです。ブランチ名ではなく祖先の確認で判定し、`release` 側として受理することを確認します。"""
    with allure.step("ブランチ名が版のタグの形の手動実行の run を用意して判定する"):
        run = _run("workflow_dispatch", head_branch="v1.2.3")
        verdict = _decide(run, artifact_names=["pages-side-release"])
    with allure.step("ブランチ名を使わず release になることを確かめる"):
        assert _accepted(verdict) == ("release", None, HEAD, "pages-side-release", False)


@allure.title("main との比較の結果が存在しないと、破棄する")
def test_missing_compare_is_dropped() -> None:
    """`head_vs_main` に `None` を渡す場合のテストです。祖先の確認ができないため、`push` の run でも、どの側としても受理しないことを確認します。"""
    with allure.step("main との比較の無い run が捨てられることを確かめる"):
        assert _accepted(_decide(_run("push"), head_vs_main=None)) == DROPPED


@allure.title("{event} の run は、他のリポジトリの PR が含まれていても、開発版を受け付ける")
@pytest.mark.parametrize("event", ["push", "workflow_dispatch"])
def test_other_repo_pr_in_pull_requests_does_not_drop_dev_or_release(event: str) -> None:
    """fork から上流の `main` に開いた PR が、`pull_requests` に含まれる場合のテストです。開発版とリリース版の判定には影響せず、`dev` 側として受理することを確認します。"""
    with allure.step("別のリポの PR を含む run を用意して判定する"):
        # fork が上流の main から開いた PR が pull_requests に入っても、開発版・リリース版は落ちない。
        run = _run(event, pull_requests=[_run_pr(7, base="someone/pecot")])
        verdict = _decide(run, artifact_names=["pages-side-dev"])
    with allure.step("dev か release として受け付けられることを確かめる"):
        assert _accepted(verdict) == ("dev", None, HEAD, "pages-side-dev", False)


@allure.title("保存済みの開発版の commit との関係が {status} のとき、開発版の判定は {side} になる")
@pytest.mark.parametrize(
    ("status", "side"),
    [("identical", "dev"), ("ahead", "dev"), ("behind", None), ("diverged", None)],
)
def test_dev_against_stored_sha(status: str, side: str | None) -> None:
    """`push` の run を、保存済みの開発版の commit と比較する場合のテストです。`identical` と `ahead` では `dev` 側として受理し、`behind` と `diverged` では受理しないことを確認します。"""
    with allure.step("保存済みの SHA と比べた状態で dev の run を判定する"):
        verdict = _decide(
            _run("push"),
            stored_dev_sha=STORED,
            stored_vs_head=_compare(status, 0 if status == "identical" else 1, 0),
        )
    with allure.step("比較の結果ごとの判定を確かめる"):
        assert verdict.side == side


@allure.title("保存済みと同じ commit の開発版を再実行した run は、受け付ける")
def test_dev_rerun_of_stored_sha_is_accepted() -> None:
    """`push` の run の commit が、保存済みの開発版の commit と同じ場合のテストです。比較の結果が `identical` で、`dev` 側として受理することを確認します。"""
    with allure.step("保存済みの SHA と同じ run を判定する"):
        verdict = _decide(
            _run("push"), stored_dev_sha=HEAD, stored_vs_head=_compare("identical", 0, 0)
        )
    with allure.step("再実行として受け付けられることを確かめる"):
        assert _accepted(verdict) == ("dev", None, HEAD, "pages-side-dev", False)


@allure.title("保存済みの commit があるのに、比較の結果が存在しないと、破棄する")
def test_dev_with_stored_sha_but_no_compare_is_dropped() -> None:
    """保存済みの開発版の commit を渡し、`stored_vs_head` に `None` を渡す場合のテストです。新しさを判定できないため、どの側としても受理しないことを確認します。"""
    with allure.step("保存済みの SHA を持ち、比較の無い run が捨てられることを確かめる"):
        assert (
            _accepted(_decide(_run("push"), stored_dev_sha=STORED, stored_vs_head=None)) == DROPPED
        )


@allure.title("リリース版は、保存済みの開発版の commit を参照しない")
def test_release_does_not_look_at_stored_dev_sha() -> None:
    """`pages-side-release` の `workflow_dispatch` の run に、新しい commit と比べて古い、保存済みの開発版の commit を渡す場合のテストです。それでも `release` 側として受理することを確認します。"""
    with allure.step("保存済みの dev の SHA がある状態で release の run を判定する"):
        verdict = _decide(
            _run("workflow_dispatch"),
            artifact_names=["pages-side-release"],
            stored_dev_sha=STORED,
            stored_vs_head=_compare("behind", 0, 2),
        )
    with allure.step("release として受け付けられることを確かめる"):
        assert _accepted(verdict) == ("release", None, HEAD, "pages-side-release", False)


# 全側に共通の確かめ


@allure.title(
    "{event} の run は、path・head のリポジトリ・結論のいずれかが条件に合わないと、{over} の場合に破棄する"
)
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
    """run の `path`、`head_repository`、`conclusion` のいずれかが、条件に合わない場合のテストです。`ci.yaml` などの別の workflow や fork、失敗した run は、どの event でも受理しないことを確認します。"""
    with allure.step("path・head のリポ・結論のどれかを外した run を用意して判定する"):
        run = _run(event, pull_requests=[_run_pr(5)], **over)
        verdict = _decide(run, artifact_names=["pages-side-dev"], pulls={5: _pull(5)})
    with allure.step("捨てられることを確かめる"):
        assert _accepted(verdict) == DROPPED


@allure.title("{event} の event で起動した run は、破棄する")
@pytest.mark.parametrize("event", ["schedule", "workflow_run", "pull_request_target", "release"])
def test_other_events_are_dropped(event: str) -> None:
    """`schedule` や `release` など、受け付けない event の run のテストです。artifact や PR の情報が揃っていても、どの側としても受理しないことを確認します。"""
    with allure.step("対象外のイベントの run を判定する"):
        verdict = _decide(
            _run(event, pull_requests=[_run_pr(5)]),
            artifact_names=["pages-side-dev"],
            pulls={5: _pull(5)},
        )
    with allure.step("捨てられることを確かめる"):
        assert _accepted(verdict) == DROPPED


# PR 版（pages-build.yml の pull_request の run から受ける）


def _pr_run(*prs: dict[str, Any], **over: Any) -> dict[str, Any]:
    pulls = list(prs) if prs else [_run_pr(5)]
    run = _run("pull_request", pull_requests=pulls, head_branch="feat/x/5")
    run.update(over)
    return run


def _decide_pr(
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


@allure.title("pull_request の run は、PR 版として受け付ける")
def test_build_pull_request_run_is_pr_side() -> None:
    """`pages-build.yml` の `pull_request` の run のテストです。`pr` 側として、PR 番号 5 と head の commit と artifact 名 `pages-side-pr-5` で受理することを確認します。"""
    with allure.step("build の pull_request の run が PR 側として受け付けられることを確かめる"):
        assert _accepted(_decide_pr(_pr_run())) == PR5


@allure.title("pull_request の run は、結論が {conclusion} だと破棄する")
@pytest.mark.parametrize(
    "conclusion", ["failure", "cancelled", "timed_out", "skipped", "action_required", None]
)
def test_pull_request_run_with_other_conclusion_is_dropped(conclusion: str | None) -> None:
    """`pull_request` の run の `conclusion` が、`success` 以外の場合のテストです。`failure` や `cancelled` などでは、どの側としても受理しないことを確認します。"""
    with allure.step("結論が success でない pull_request の run が捨てられることを確かめる"):
        assert _accepted(_decide_pr(_pr_run(conclusion=conclusion))) == DROPPED


@allure.title("pull_request の run は、その PR の artifact が {names} だと破棄する")
@pytest.mark.parametrize(
    "names", [[], ["pages-junit-pecot-tools-test-cli"], ["pages-side-pr-6"], ["pages-side-dev"]]
)
def test_pull_request_run_without_its_pr_artifact_is_dropped(names: list[str]) -> None:
    """`pull_request` の run の artifact に、その PR 用の `pages-side-pr-5` が存在しない場合のテストです。側と artifact は決まらず、理由に `pages-side-pr-5` を含めることを確認します。"""
    with allure.step("PR の artifact が無い pull_request の run を判定する"):
        verdict = _decide_pr(_pr_run(), artifact_names=names)
    with allure.step("捨てられて理由に artifact 名が出ることを確かめる"):
        assert (verdict.side, verdict.artifact, verdict.closed_pr) == (None, None, False)
        assert "pages-side-pr-5" in verdict.reason


@allure.title(
    "pull_request の run は、開発版やリリース版の artifact があっても、開発版やリリース版として受け付けない"
)
def test_pull_request_run_is_never_dev_or_release() -> None:
    """`pull_request` の run に、開発版とリリース版の artifact を渡すテストです。側は決まらず、PR 番号 5 だけが残ることを確認します。"""
    with allure.step("pull_request の run を dev か release の条件で判定する"):
        # PR の作者は自分のブランチの pages-build.yml を書き換えられるので、pull_request の run から開発版・リリース版は受けない。
        verdict = _decide(
            _pr_run(),
            artifact_names=["pages-side-dev", "pages-side-release"],
            pulls={5: _pull(5)},
        )
    with allure.step("PR 側にだけなり、artifact を持たないことを確かめる"):
        assert (verdict.side, verdict.pr, verdict.artifact) == (None, 5, None)


@allure.title("ci の workflow の run は、破棄する")
def test_ci_run_is_dropped() -> None:
    """`path` が `.github/workflows/ci.yml` の `pull_request` の run のテストです。`pages-build.yml` ではないため、どの側としても受理しないことを確認します。"""
    with allure.step("ci のワークフローの run を用意して判定する"):
        run = _pr_run(path=".github/workflows/ci.yml", name="ci")
    with allure.step("捨てられることを確かめる"):
        assert _accepted(_decide_pr(run)) == DROPPED


@allure.title("fork から開いた PR の run は、破棄する")
def test_pull_request_run_from_fork_is_dropped() -> None:
    """`head_repository` が fork の `pull_request` の run のテストです。信頼できない出どころのため、どの側としても受理しないことを確認します。"""
    with allure.step("フォークの pull_request の run を用意して判定する"):
        run = _pr_run(head_repository={"full_name": "someone/pecot", "fork": True})
    with allure.step("捨てられることを確かめる"):
        assert _accepted(_decide_pr(run)) == DROPPED


@allure.title("PR 版は、head が main の祖先でなくても、受け付ける")
def test_pull_request_does_not_need_main_ancestor() -> None:
    """PR の head が `main` の祖先ではない場合のテストです。PR 版では祖先の確認を求めず、`pr` 側として受理することを確認します。"""
    with allure.step("main の祖先でない pull_request の run を判定する"):
        verdict = _decide(
            _pr_run(),
            head_vs_main=NOT_IN_MAIN,
            artifact_names=["pages-side-pr-5"],
            pulls={5: _pull(5)},
        )
    with allure.step("PR 側として受け付けられることを確かめる"):
        assert verdict.side == "pr"


@allure.title("閉じた PR の run は、どの側としても受け付けず、後片付けの対象にする")
def test_closed_pull_request_only_triggers_cleanup() -> None:
    """対象の PR が `closed` で、artifact が存在しない場合のテストです。側と artifact は決まらず、PR 番号 5 と `closed_pr` が `True` であることを確認します。"""
    with allure.step("閉じた PR の run を判定する"):
        # closed の run は artifact を持たない。
        verdict = _decide_pr(_pr_run(), artifact_names=[], pulls={5: _pull(5, state="closed")})
    with allure.step("掃除だけの判定になることを確かめる"):
        assert (verdict.side, verdict.pr, verdict.artifact, verdict.closed_pr) == (
            None,
            5,
            None,
            True,
        )


@allure.title("PR の候補は、base のリポジトリと head の commit が一致するものだけに絞る")
def test_pr_candidates_filter_base_repo_and_head_sha() -> None:
    """`pr_candidates` に、他のリポジトリを base にした PR や、head の commit が異なる PR を含めて渡す場合のテストです。このリポジトリの PR で、head の commit が一致する 5 番だけが返ることを確認します。"""
    with allure.step("base のリポと head の SHA が違う PR を混ぜた run を用意する"):
        run = _pr_run(
            _run_pr(5),
            _run_pr(6, base="someone/pecot"),
            _run_pr(7, base="pecotcraft/other"),
            _run_pr(8, head_sha=OTHER),
        )
    with allure.step("候補が条件に合う PR だけになることを確かめる"):
        assert pr_candidates(run, REPO) == [5]


@allure.title("PR の候補は、リポジトリ名だけでなく url の所有者まで確認する")
def test_pr_candidates_need_url_not_only_name() -> None:
    """fork 先のリポジトリが、同じ `pecot` という名前で、url の所有者だけが異なる場合のテストです。`pr_candidates` の結果が空になることを確認します。"""
    with allure.step("base のリポの名前だけ同じで URL が違う PR を用意する"):
        # fork 先のリポも name は同じ pecot なので、url の owner まで見る。
        fork_base = {"id": 9, "url": f"{API}/someone/pecot", "name": "pecot"}
        pull = _run_pr(5)
        pull["base"]["repo"] = fork_base
    with allure.step("候補に入らないことを確かめる"):
        assert pr_candidates(_pr_run(pull), REPO) == []


@allure.title("他のリポジトリを base にした PR だけを持つ run は、破棄する")
def test_pull_request_from_other_repo_base_only_is_dropped() -> None:
    """`pull_requests` が、他のリポジトリを base にした PR だけを含む場合のテストです。このリポジトリの PR が存在しないため、どの側としても受理しないことを確認します。"""
    with allure.step("別のリポを base にした PR だけの run を用意して判定する"):
        run = _pr_run(_run_pr(6, base="someone/pecot"))
        verdict = _decide_pr(run, artifact_names=["pages-side-pr-6"], pulls={6: _pull(6)})
    with allure.step("捨てられることを確かめる"):
        assert _accepted(verdict) == DROPPED


@allure.title("pull_request の run は、PR が 1 件に絞れないと、{param_id} の場合に破棄する")
@pytest.mark.parametrize("prs", [[], [_run_pr(5), _run_pr(6)]])
def test_pull_request_not_narrowed_to_one_is_dropped(prs: list[dict[str, Any]]) -> None:
    """`pull_requests` が空の場合と、PR が 2 件ある場合のテストです。PR を 1 件に決められないため、どちらも受理しないことを確認します。"""
    with allure.step("PR が 1 つに絞れない run を用意して判定する"):
        run = _pr_run(pull_requests=prs)
        verdict = _decide_pr(
            run,
            artifact_names=["pages-side-pr-5", "pages-side-pr-6"],
            pulls={5: _pull(5), 6: _pull(6)},
        )
    with allure.step("捨てられることを確かめる"):
        assert _accepted(verdict) == DROPPED


@allure.title(
    "他のリポジトリの PR が含まれていても、このリポジトリの PR が 1 件なら、その PR で受け付ける"
)
def test_pull_request_with_other_repo_pr_still_narrows_to_one() -> None:
    """`pull_requests` に、このリポジトリの PR と他のリポジトリの PR が 1 件ずつある場合のテストです。他のリポジトリの PR を除いて 1 件に絞り、PR 番号 5 の PR 版として受理することを確認します。"""
    with allure.step("別のリポの PR を含む run を用意して判定する"):
        run = _pr_run(_run_pr(5), _run_pr(6, base="someone/pecot"))
    with allure.step("自分のリポの PR 1 つに絞れることを確かめる"):
        assert _accepted(_decide_pr(run)) == PR5


@allure.title("PR の head が run の commit から進んでいると、破棄する")
def test_pull_request_whose_head_moved_is_dropped() -> None:
    """PR の取得結果の head の commit が、run の commit と異なる場合のテストです。側と artifact は決まらず、`closed_pr` も `False` であることを確認します。"""
    with allure.step("head が動いた PR の run を判定する"):
        verdict = _decide_pr(_pr_run(), pulls={5: _pull(5, head_sha=OTHER)})
    with allure.step("捨てられて掃除も起きないことを確かめる"):
        assert (verdict.side, verdict.closed_pr, verdict.artifact) == (None, False, None)


@allure.title("PR の取得結果の base が他のリポジトリだと、破棄する")
def test_pull_request_whose_pull_base_is_other_repo_is_dropped() -> None:
    """PR の取得結果で、base のリポジトリが他のリポジトリになっている場合のテストです。側は決まらず、`closed_pr` も `False` であることを確認します。"""
    with allure.step("PR の base が別のリポの run を判定する"):
        verdict = _decide_pr(_pr_run(), pulls={5: _pull(5, base="someone/pecot")})
    with allure.step("捨てられて掃除も起きないことを確かめる"):
        assert (verdict.side, verdict.closed_pr) == (None, False)


@allure.title("PR の取得結果が存在しないと、破棄する")
def test_pull_request_without_pull_response_is_dropped() -> None:
    """`pulls` が空の場合のテストです。PR の状態を確認できないため、`side` が `None` になることを確認します。"""
    with allure.step("PR の応答の無い run が捨てられることを確かめる"):
        assert _decide_pr(_pr_run(), pulls={}).side is None


@allure.title("decide は、渡された run の内容を変更しない")
def test_decide_does_not_change_inputs() -> None:
    """`decide` を呼んだ前後の、run の辞書のテストです。呼び出しのあとも、run の内容が呼び出しの前の複製と一致することを確認します。"""
    with allure.step("入力の run の控えを取って判定する"):
        run = _pr_run()
        before = copy.deepcopy(run)
        _decide_pr(run)
    with allure.step("判定が入力を書き換えないことを確かめる"):
        assert run == before


@allure.title("判定の理由は、受理する場合と破棄する場合のどちらでも、1 行の文になる")
def test_reason_is_one_line() -> None:
    """受理する場合や破棄する場合など、6 通りの判定のテストです。どの結果でも `reason` が空ではなく、改行を含まないことを確認します。"""
    with allure.step("どの判定の理由も 1 行であることを確かめる"):
        for verdict in (
            _decide(_run("push")),
            _decide(_run("push"), head_vs_main=NOT_IN_MAIN),
            _decide(_run("workflow_dispatch")),
            _decide_pr(_pr_run()),
            _decide_pr(_pr_run(), artifact_names=[]),
            _decide_pr(_pr_run(path=".github/workflows/ci.yml")),
        ):
            assert verdict.reason
            assert "\n" not in verdict.reason


# open_prs


@allure.title("開いている PR の一覧は、このリポジトリの PR だけを番号の昇順で返す")
def test_open_prs_keeps_this_repo_and_sorts() -> None:
    """`open_prs` に、他のリポジトリを base にした PR や、base が空の項目を含めて渡す場合のテストです。このリポジトリの PR だけが、`3, 5, 12` の昇順で返ることを確認します。"""
    with allure.step("別のリポの PR を混ぜた一覧を用意する"):
        pulls = [
            _pull(12),
            _pull(3),
            _pull(7, base="someone/pecot"),
            _pull(5),
            {"number": 9, "base": {}},
        ]
    with allure.step("自分のリポの PR だけが番号順に残ることを確かめる"):
        assert open_prs(pulls, REPO) == [3, 5, 12]


@allure.title("PR が存在しないと、開いている PR の一覧は空になる")
def test_open_prs_empty() -> None:
    """`open_prs` に空の一覧を渡す場合のテストです。結果が空の一覧であることを確認します。"""
    with allure.step("空の一覧から開いた PR が空になることを確かめる"):
        assert open_prs([], REPO) == []


# レポート（test-report.yml の run）。形は main の run 45627254351 の応答に合わせる。

REPORT_HEAD = "cc8e7b6bb7a45ac768fa995df639dd45313df27a"
_RESULTS = [
    f"allure-results-{lane}"
    for lane in (
        "pecot-workflow-test-cli",
        "pecot-tools-test-cli",
        "pecot-visual-test-cli",
        "githooks-test-nx-affected",
        "pecot-workflow-test-hooks",
        "pecot-workflow-test-skills",
        "githooks-test-ci",
        "interface-spec-test-unit",
        "githooks-test-checks",
        "githooks-test-nx-cache",
        "text-rules-test-unit",
        "interface-spec-test-site",
    )
]


def _report_run(event: str = "push", **over: Any) -> dict[str, Any]:
    run = _run(
        event,
        id=45627254351,
        name="test-report",
        path=REPORT_PATH,
        head_sha=REPORT_HEAD,
    )
    run.update(over)
    return run


def _decide_report(
    run: dict[str, Any], *, artifact_names: list[str] | None = None, **kw: Any
) -> Verdict:
    names = [*_RESULTS, ARTIFACT_REPORT_DEV] if artifact_names is None else artifact_names
    return _decide(run, artifact_names=names, **kw)


def _report(verdict: Verdict) -> tuple[str | None, str | None, str | None, str | None]:
    return (verdict.kind, verdict.side, verdict.head_sha, verdict.artifact)


@allure.title("レポートの定数は、test-report の workflow の path と artifact 名に一致する")
def test_report_constants_match_test_report_workflow() -> None:
    """`REPORT_PATH`、`ARTIFACT_REPORT_DEV`、`ARTIFACT_REPORT_RELEASE` の定数のテストです。それぞれが `.github/workflows/test-report.yml`、`test-report-dev`、`test-report-release` と一致することを確認します。"""
    with allure.step("レポートの定数がテストレポートのワークフローと合うことを確かめる"):
        assert (REPORT_PATH, ARTIFACT_REPORT_DEV, ARTIFACT_REPORT_RELEASE) == (
            ".github/workflows/test-report.yml",
            "test-report-dev",
            "test-report-release",
        )


@allure.title("定義書の build の run は、種類が site になる")
def test_build_runs_are_kind_site() -> None:
    """`push`、`workflow_dispatch`、`pull_request` の、`pages-build.yml` の run のテストです。どの run も `kind` が `site` になることを確認します。"""
    with allure.step("build の run がすべてサイトの種類になることを確かめる"):
        assert _decide(_run("push")).kind == "site"
        assert (
            _decide(_run("workflow_dispatch"), artifact_names=["pages-side-release"]).kind == "site"
        )
        assert _decide_pr(_pr_run()).kind == "site"


@allure.title("レポートの push の run は、開発版のレポートとして受け付ける")
def test_report_push_run_is_dev_report() -> None:
    """`test-report.yml` の `push` の run のテストです。`report` の種類で `dev` 側として受理し、PR 番号が存在せず、`closed_pr` が `False` であることを確認します。"""
    with allure.step("レポートの push の run を判定する"):
        verdict = _decide_report(_report_run())
    with allure.step("dev のレポートとして受け付けられることを確かめる"):
        assert _report(verdict) == ("report", "dev", REPORT_HEAD, "test-report-dev")
        assert verdict.pr is None and not verdict.closed_pr


@allure.title(
    "レポートの手動実行の run は、レポートの artifact が {names} だと、{side} 側として受け付ける"
)
@pytest.mark.parametrize(
    ("names", "side", "artifact"),
    [
        ([*_RESULTS, "test-report-dev"], "dev", "test-report-dev"),
        ([*_RESULTS, "test-report-release"], "release", "test-report-release"),
        (["test-report-release"], "release", "test-report-release"),
    ],
)
def test_report_dispatch_takes_the_side_of_its_only_report_artifact(
    names: list[str], side: str, artifact: str
) -> None:
    """`test-report.yml` の `workflow_dispatch` の run のテストです。artifact にレポートが 1 つだけ含まれる場合に、その artifact の側で受理し、artifact 名も一致することを確認します。"""
    with allure.step("レポートの手動実行の run を判定する"):
        verdict = _decide_report(_report_run("workflow_dispatch"), artifact_names=names)
    with allure.step("唯一のレポートの artifact の側になることを確かめる"):
        assert _report(verdict) == ("report", side, REPORT_HEAD, artifact)


@allure.title(
    "レポートの手動実行の run は、レポートの artifact が 1 つに決まらないと、{names} の場合に破棄する"
)
@pytest.mark.parametrize(
    "names",
    [
        [],
        _RESULTS,
        ["test-report-dev", "test-report-release"],
        # 定義書の artifact はレポートの run の側を決めない。
        ["pages-side-dev"],
        ["pages-side-release", "test-report-dev", "test-report-release"],
    ],
)
def test_report_dispatch_without_exactly_one_report_artifact_is_dropped(
    names: list[str],
) -> None:
    """`workflow_dispatch` の run の artifact に、レポートが存在しない場合や 2 つある場合のテストです。定義書の artifact は側の判定に使われず、どの側としても受理しないことを確認します。"""
    with allure.step("レポートの artifact が 1 つでない手動実行の run を判定する"):
        verdict = _decide_report(_report_run("workflow_dispatch"), artifact_names=names)
    with allure.step("捨てられることを確かめる"):
        assert _report(verdict) == (None, None, None, None)


@allure.title("定義書の build の手動実行は、レポートの artifact を側の判定に使わない")
def test_build_dispatch_does_not_take_report_artifacts() -> None:
    """`pages-build.yml` の `workflow_dispatch` の run に、`test-report-release` を渡す場合のテストです。側の artifact が存在しないため、どの側としても受理しないことを確認します。"""
    with allure.step("レポートの artifact を持つ build の手動実行の run を判定する"):
        verdict = _decide(_run("workflow_dispatch"), artifact_names=["test-report-release"])
    with allure.step("捨てられることを確かめる"):
        assert _accepted(verdict) == DROPPED


@allure.title("レポートの pull_request の run は、破棄する")
def test_report_pull_request_run_is_dropped() -> None:
    """PR の作者が書き換えた、`test-report.yml` の `pull_request` の run のテストです。種類と側が決まらず、PR 番号が存在せず、`closed_pr` が `False` であることを確認します。"""
    with allure.step("レポートの pull_request の run を用意して判定する"):
        # test-report.yml は pull_request を契機にしないが、PR の作者が書き換えた run も受けない。
        run = _report_run("pull_request", pull_requests=[_run_pr(5)], head_branch="feat/x/5")
        verdict = _decide_report(run, head_vs_main=None, pulls={5: _pull(5)})
    with allure.step("捨てられることを確かめる"):
        assert (_report(verdict), verdict.pr, verdict.closed_pr) == (
            (None, None, None, None),
            None,
            False,
        )


@allure.title("レポートの {event} の event で起動した run は、破棄する")
@pytest.mark.parametrize("event", ["schedule", "workflow_run", "pull_request_target", "release"])
def test_report_other_events_are_dropped(event: str) -> None:
    """`schedule` や `release` など、受け付けない event の、`test-report.yml` の run のテストです。`side` が `None` になることを確認します。"""
    with allure.step("レポートの対象外のイベントの run が捨てられることを確かめる"):
        assert _decide_report(_report_run(event)).side is None


@allure.title("レポートの {event} の run は、head が main の祖先でないと破棄する")
@pytest.mark.parametrize("event", ["push", "workflow_dispatch"])
def test_report_head_not_ancestor_of_main_is_dropped(event: str) -> None:
    """`push` と `workflow_dispatch` の、`test-report.yml` の run で、head の commit が `main` の祖先ではない場合のテストです。`side` が `None` になることを確認します。"""
    with allure.step("main の祖先でないレポートの run を判定する"):
        verdict = _decide_report(_report_run(event), head_vs_main=NOT_IN_MAIN)
    with allure.step("捨てられることを確かめる"):
        assert verdict.side is None


@allure.title("レポートの run は、共通の確認に合わない場合、{over} の場合に破棄する")
@pytest.mark.parametrize(
    "over",
    [
        {"head_repository": {"full_name": "someone/pecot", "fork": True}},
        {"conclusion": "failure"},
        {"path": ".github/workflows/test-report.yaml"},
    ],
)
def test_report_common_checks_still_apply(over: dict[str, Any]) -> None:
    """fork の `head_repository`、失敗した `conclusion`、`test-report.yaml` の `path` など、共通の確認に合わない場合のテストです。レポートの run でも `side` が `None` になることを確認します。"""
    with allure.step("レポートの run にも共通の verify が働き、捨てられることを確かめる"):
        assert _decide_report(_report_run(**over)).side is None


@allure.title(
    "保存済みのレポートの commit との関係が {status} のとき、レポートの判定は {side} になる"
)
@pytest.mark.parametrize(
    ("status", "side"),
    [("identical", "dev"), ("ahead", "dev"), ("behind", None), ("diverged", None)],
)
def test_report_dev_against_stored_report_sha(status: str, side: str | None) -> None:
    """開発版のレポートの `push` の run を、保存済みの commit と比較する場合のテストです。`identical` と `ahead` では `dev` 側として受理し、`behind` と `diverged` では受理しないことを確認します。"""
    with allure.step("保存済みのレポートの SHA と比べた状態でレポートの run を判定する"):
        verdict = _decide_report(
            _report_run(),
            stored_dev_sha=STORED,
            stored_vs_head=_compare(status, 0 if status == "identical" else 1, 0),
        )
    with allure.step("比較の結果ごとの判定を確かめる"):
        assert verdict.side == side


@allure.title("リリース版のレポートは、保存済みの開発版の commit を参照しない")
def test_report_release_does_not_look_at_stored_dev_sha() -> None:
    """`test-report-release` の `workflow_dispatch` の run に、新しい commit と比べて古い、保存済みの開発版の commit を渡す場合のテストです。それでも `release` 側のレポートとして受理することを確認します。"""
    with allure.step("保存済みの dev の SHA がある状態で release のレポートの run を判定する"):
        verdict = _decide_report(
            _report_run("workflow_dispatch"),
            artifact_names=["test-report-release"],
            stored_dev_sha=STORED,
            stored_vs_head=_compare("behind", 0, 2),
        )
    with allure.step("release のレポートとして受け付けられることを確かめる"):
        assert _report(verdict) == ("report", "release", REPORT_HEAD, "test-report-release")


@allure.title("レポートの判定の理由は、レポートの run だと分かる 1 行の文になる")
def test_report_reason_names_the_report() -> None:
    """開発版のレポートの `push` の run と、`pull_request` の run の、`reason` のテストです。前者はレポートに関する文言を含み、後者は改行を含まないことを確認します。"""
    with allure.step("理由にレポートの名前が入り、1 行であることを確かめる"):
        assert "レポート" in _decide_report(_report_run()).reason
        assert "\n" not in _decide_report(_report_run("pull_request")).reason


@allure.title("run の path が {path} のとき、種類は {kind} になる")
@pytest.mark.parametrize(
    ("path", "kind"),
    [
        (BUILD_PATH, "site"),
        (".github/workflows/test-report.yml", "report"),
        (".github/workflows/ci.yml", None),
        (None, None),
    ],
)
def test_run_kind_follows_the_workflow_path(path: str | None, kind: str | None) -> None:
    """`run_kind` の、workflow の `path` から種類を決める処理のテストです。`pages-build.yml` では `site`、`test-report.yml` では `report`、それ以外と `None` では `None` を返すことを確認します。"""
    with allure.step("ワークフローの path から run の種類が決まることを確かめる"):
        assert run_kind({"path": path}) == kind
