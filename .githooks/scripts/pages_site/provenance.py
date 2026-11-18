"""workflow_run で受けた run の出どころ（RunProvenance）を、GitHub の REST の応答から決める。

決まりの正は specs/028-pages-site/data-model.md の「受け取った run の確かめ（RunProvenance）」。
ここは判定だけを置き、API・git・ファイルには触らない。API を呼ぶのは verify.py。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import cast

BUILD_PATH = ".github/workflows/pages-build.yml"
CI_PATH = ".github/workflows/ci.yml"

ARTIFACT_DEV = "pages-side-dev"
ARTIFACT_RELEASE = "pages-side-release"


@dataclass(frozen=True)
class Verdict:
    side: str | None  # "dev" / "release" / "pr" / None（捨てる）
    pr: int | None
    head_sha: str | None
    artifact: str | None  # "pages-side-dev" / "pages-side-release" / "pages-side-pr-<n>"
    reason: str  # 採否の理由（summary に出す日本語 1 行）
    closed_pr: bool = False  # pull_request の run で PR が閉じている（掃除だけ起こす）


def _map(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return cast("Mapping[str, object]", value)
    return {}


def _str(data: Mapping[str, object], *keys: str) -> str | None:
    value: object = data
    for key in keys:
        value = _map(value).get(key)
    return value if isinstance(value, str) else None


def _int(data: Mapping[str, object], key: str) -> int | None:
    value = data.get(key)
    # bool は int の派生なので外す。
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _list(value: object) -> list[object]:
    return cast("list[object]", value) if isinstance(value, list) else []


def _drop(reason: str, *, pr: int | None = None, closed_pr: bool = False) -> Verdict:
    return Verdict(
        side=None, pr=pr, head_sha=None, artifact=None, reason=reason, closed_pr=closed_pr
    )


def _same_repo(full_name: str | None, repo: str) -> bool:
    # GitHub のリポの名前は大文字と小文字を区別しない。
    return full_name is not None and full_name.lower() == repo.lower()


def _is_this_repo_short(repo_obj: Mapping[str, object], repo: str) -> bool:
    """run の pull_requests の base.repo（id・url・name だけを持つ）がこのリポか。"""
    url, name = _str(repo_obj, "url"), _str(repo_obj, "name")
    if url is None or name is None:
        return False
    owner_name = repo.lower()
    return (
        url.lower().endswith(f"/repos/{owner_name}")
        and name.lower() == owner_name.rsplit("/", 1)[-1]
    )


def pr_candidates(run: Mapping[str, object], repo: str) -> list[int]:
    """run の pull_requests のうち、base がこのリポで head.sha が run の head_sha の PR の番号。"""
    head_sha = _str(run, "head_sha")
    numbers: list[int] = []
    for item in _list(run.get("pull_requests")):
        pull = _map(item)
        number = _int(pull, "number")
        if number is None or head_sha is None:
            continue
        if not _is_this_repo_short(_map(_map(pull.get("base")).get("repo")), repo):
            continue
        if _str(pull, "head", "sha") != head_sha:
            continue
        if number not in numbers:
            numbers.append(number)
    return numbers


def open_prs(pulls: list[Mapping[str, object]], repo: str) -> list[int]:
    """開いている PR の一覧（GET /repos/{repo}/pulls、state=open）から、base がこのリポの PR の番号を昇順で。"""
    numbers: set[int] = set()
    for pull in pulls:
        number = _int(pull, "number")
        if number is not None and _same_repo(_str(pull, "base", "repo", "full_name"), repo):
            numbers.add(number)
    return sorted(numbers)


def _decide_pr(
    run: Mapping[str, object], repo: str, head_sha: str, pulls: Mapping[int, Mapping[str, object]]
) -> Verdict:
    candidates = pr_candidates(run, repo)
    if len(candidates) != 1:
        return _drop(f"PR 版: このリポの PR を 1 件に絞れません（{len(candidates)} 件）")
    number = candidates[0]
    pull = pulls.get(number)
    if pull is None:
        return _drop(f"PR 版: #{number} の PR を読めていません", pr=number)
    if not _same_repo(_str(pull, "base", "repo", "full_name"), repo):
        return _drop(f"PR 版: #{number} の base がこのリポではありません", pr=number)
    if _str(pull, "state") != "open":
        return _drop(
            f"PR 版: #{number} は閉じています（閉じた PR の掃除だけ行います）",
            pr=number,
            closed_pr=True,
        )
    if _str(pull, "head", "sha") != head_sha:
        return _drop(f"PR 版: #{number} の head が run の後に変わっています", pr=number)
    return Verdict(
        side="pr",
        pr=number,
        head_sha=head_sha,
        artifact=f"pages-side-pr-{number}",
        reason=f"PR 版: #{number} の今の head の run です",
    )


def _dispatch_side(artifact_names: list[str]) -> str | None:
    has_dev, has_release = ARTIFACT_DEV in artifact_names, ARTIFACT_RELEASE in artifact_names
    if has_dev == has_release:
        return None
    return "dev" if has_dev else "release"


def _decide_ci(
    run: Mapping[str, object],
    repo: str,
    head_sha: str,
    artifact_names: list[str],
    pulls: Mapping[int, Mapping[str, object]],
) -> Verdict:
    # PR の作者は自分のブランチの ci.yml を書き換えられるので、ci.yml からは PR 版だけを受ける。
    event = _str(run, "event")
    if event != "pull_request":
        return _drop(f"ci.yml の event {event} の run は受けません")
    conclusion = _str(run, "conclusion")
    if conclusion not in ("success", "failure"):
        return _drop(f"run の conclusion が success・failure ではありません（{conclusion}）")
    verdict = _decide_pr(run, repo, head_sha, pulls)
    if verdict.side == "pr" and verdict.artifact not in artifact_names:
        return _drop(f"PR 版: run に {verdict.artifact} がありません", pr=verdict.pr)
    return verdict


def _decide_build_pr(
    run: Mapping[str, object], repo: str, head_sha: str, pulls: Mapping[int, Mapping[str, object]]
) -> Verdict:
    verdict = _decide_pr(run, repo, head_sha, pulls)
    if verdict.side == "pr":
        return _drop(
            f"PR 版: #{verdict.pr} は ci.yml の run から作ります（pages-build の run は掃除だけ）",
            pr=verdict.pr,
        )
    return verdict


def decide(
    run: Mapping[str, object],
    *,
    repo: str,
    head_vs_main: Mapping[str, object] | None,
    artifact_names: list[str],
    stored_dev_sha: str | None,
    stored_vs_head: Mapping[str, object] | None,
    pulls: Mapping[int, Mapping[str, object]],
) -> Verdict:
    """受けた run を、どの側として受けるか（捨てるか）決める。"""
    path = _str(run, "path")
    if path not in (BUILD_PATH, CI_PATH):
        return _drop(f"workflow の path が {BUILD_PATH}・{CI_PATH} のどちらでもありません")
    if not _same_repo(_str(run, "head_repository", "full_name"), repo):
        return _drop("head_repository がこのリポではありません")
    head_sha = _str(run, "head_sha")
    if path == CI_PATH:
        if head_sha is None:
            return _drop("run に head_sha がありません")
        return _decide_ci(run, repo, head_sha, artifact_names, pulls)
    if _str(run, "conclusion") != "success":
        return _drop(f"run の conclusion が success ではありません（{_str(run, 'conclusion')}）")
    if head_sha is None:
        return _drop("run に head_sha がありません")

    # head_branch は判定に使わない（タグで動いた run はタグ名が入る）。
    event = _str(run, "event")
    if event == "pull_request":
        return _decide_build_pr(run, repo, head_sha, pulls)
    if event == "push":
        side = "dev"
    elif event == "workflow_dispatch":
        dispatched = _dispatch_side(artifact_names)
        if dispatched is None:
            return _drop(
                f"手での起動: {ARTIFACT_DEV} と {ARTIFACT_RELEASE} のちょうど 1 つがありません"
            )
        side = dispatched
    else:
        return _drop(f"event {event} の run は受けません")

    # 開発版・リリース版では pull_requests を見ない。
    behind_by = _int(_map(head_vs_main), "behind_by")
    if behind_by != 0:
        return _drop(f"head_sha {head_sha[:7]} が main の祖先ではありません")

    if side == "dev" and stored_dev_sha is not None:
        status = _str(_map(stored_vs_head), "status")
        if status not in ("identical", "ahead"):
            return _drop(f"開発版: 保管中の {stored_dev_sha[:7]} より古い run です（{status}）")

    label = "開発版" if side == "dev" else "リリース版"
    artifact = ARTIFACT_DEV if side == "dev" else ARTIFACT_RELEASE
    return Verdict(
        side=side,
        pr=None,
        head_sha=head_sha,
        artifact=artifact,
        reason=f"{label}: main の祖先 {head_sha[:7]} の run です",
    )
