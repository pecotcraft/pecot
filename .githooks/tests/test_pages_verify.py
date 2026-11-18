"""pages_site/verify.py のテスト。API の応答をつないで provenance に渡すことと、artifact の中身の確かめ。

判定そのものは test_pages_provenance.py が確かめる。
"""

from __future__ import annotations

import base64
import io
import json
import sys
import tarfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/pages_site"))

from provenance import Verdict  # noqa: E402
from verify import PHASE5, check_side, judge, stored_dev_sha  # noqa: E402

REPO = "pecotcraft/pecot"
HEAD = "1" * 40
STORED = "2" * 40


def _run(event: str = "push", **extra: object) -> dict[str, object]:
    return {
        "id": 7,
        "path": ".github/workflows/pages-build.yml",
        "event": event,
        "head_sha": HEAD,
        "head_branch": "main",
        "head_repository": {"full_name": REPO},
        "conclusion": "success",
        "pull_requests": [],
        **extra,
    }


def _store_file(dev_sha: str) -> dict[str, object]:
    body = json.dumps({"release": None, "dev": {"sha": dev_sha}, "pr": {}}).encode()
    return {"content": base64.b64encode(body).decode()}


class FakeApi:
    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = responses
        self.paths: list[str] = []

    def __call__(self, path: str) -> object | None:
        self.paths.append(path)
        return self.responses.get(path)


def _responses(run: dict[str, object], **extra: object) -> dict[str, object]:
    return {
        f"repos/{REPO}/actions/runs/7": run,
        f"repos/{REPO}/compare/{HEAD}...main": {"behind_by": 0},
        f"repos/{REPO}/actions/runs/7/artifacts?per_page=100": {
            "artifacts": [{"name": "pages-side-dev"}]
        },
        f"repos/{REPO}/pulls?state=open&per_page=100": [
            {"number": 3, "base": {"repo": {"full_name": REPO}}}
        ],
        **extra,
    }


def test_stored_dev_sha_reads_pecot_store_json_on_pages_store() -> None:
    api = FakeApi({f"repos/{REPO}/contents/.pecot-store.json?ref=pages-store": _store_file(STORED)})
    assert stored_dev_sha(api, REPO) == STORED
    assert stored_dev_sha(FakeApi({}), REPO) is None


def test_judge_compares_the_stored_dev_with_the_head() -> None:
    api = FakeApi(
        _responses(
            _run(),
            **{
                f"repos/{REPO}/contents/.pecot-store.json?ref=pages-store": _store_file(STORED),
                f"repos/{REPO}/compare/{STORED}...{HEAD}": {"status": "ahead"},
            },
        )
    )
    verdict, opened = judge(api, REPO, "7")
    assert (verdict.side, verdict.head_sha, verdict.artifact) == ("dev", HEAD, "pages-side-dev")
    assert opened == [3]


def test_judge_drops_an_older_dev_run() -> None:
    api = FakeApi(
        _responses(
            _run(),
            **{
                f"repos/{REPO}/contents/.pecot-store.json?ref=pages-store": _store_file(STORED),
                f"repos/{REPO}/compare/{STORED}...{HEAD}": {"status": "behind"},
            },
        )
    )
    assert judge(api, REPO, "7")[0].side is None


def test_judge_does_not_ask_main_or_the_store_for_pull_request_runs() -> None:
    api = FakeApi(_responses(_run("pull_request")))
    judge(api, REPO, "7")
    assert not any("...main" in p or "pecot-store" in p for p in api.paths)


def _tar(path: Path, files: dict[str, str]) -> Path:
    with tarfile.open(path, "w") as tar:
        for name, body in files.items():
            data = body.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return path


_RELEASE = {"tags": {"a": "a-v1.0.0"}, "commits": {"a": "3" * 40}, "skeleton": "3" * 40}


def _verdict(side: str) -> Verdict:
    return Verdict(side=side, pr=None, head_sha=HEAD, artifact=f"pages-side-{side}", reason="")


def test_check_side_needs_site_tar(tmp_path: Path) -> None:
    assert check_side(_verdict("dev"), tmp_path, "origin/main", lambda _: {}) == [
        "artifact に site.tar がありません"
    ]


def test_check_side_passes_a_clean_dev_side(tmp_path: Path) -> None:
    _tar(tmp_path / "site.tar", {"./index.html": "<a href='a.html'>a</a>", "./a.html": "a"})
    assert check_side(_verdict("dev"), tmp_path, "origin/main", lambda _: {}) == []


def test_check_side_reports_unsafe_members(tmp_path: Path) -> None:
    _tar(tmp_path / "site.tar", {"../escape.html": "x"})
    assert check_side(_verdict("dev"), tmp_path, "origin/main", lambda _: {})


@pytest.mark.parametrize(
    ("sources", "ok"),
    [(_RELEASE, True), ({**_RELEASE, "skeleton": "4" * 40}, False), (None, False)],
    ids=["same", "different", "missing"],
)
def test_check_side_compares_release_sources_with_the_recomputed_ones(
    tmp_path: Path, sources: dict[str, object] | None, ok: bool
) -> None:
    _tar(tmp_path / "site.tar", {"./index.html": "x"})
    if sources is not None:
        (tmp_path / "release-sources.json").write_text(json.dumps(sources), encoding="utf-8")
    seen: list[str] = []

    def record(main_ref: str) -> dict[str, object]:
        seen.append(main_ref)
        return dict(_RELEASE)

    problems = check_side(_verdict("release"), tmp_path, "origin/main", record)
    assert (problems == []) is ok
    if sources is not None:
        assert seen == ["origin/main"]


def test_pr_runs_are_not_stored_until_phase5() -> None:
    assert "Phase 5" in PHASE5
