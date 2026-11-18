"""pages_site/verify.py・dev_side.py のテスト。API の応答をつないで provenance に渡すことと、artifact の中身の確かめ。

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

import dev_side  # noqa: E402
import verify  # noqa: E402
from provenance import Verdict  # noqa: E402
from verify import StoredDev, check_side, judge, stored_dev  # noqa: E402

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


def _store_file(dev_sha: str, run_id: object = "55") -> dict[str, object]:
    body = json.dumps(
        {"release": None, "dev": {"sha": dev_sha, "run_id": run_id}, "pr": {}}
    ).encode()
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


_STORE_PATH = f"repos/{REPO}/contents/.pecot-store.json?ref=pages-store"


@pytest.mark.parametrize(
    ("run_id", "expected"), [("55", "55"), (55, "55"), (None, None), (True, None)]
)
def test_stored_dev_reads_pecot_store_json_on_pages_store(
    run_id: object, expected: str | None
) -> None:
    api = FakeApi({_STORE_PATH: _store_file(STORED, run_id)})
    assert stored_dev(api, REPO) == StoredDev(run_id=expected, sha=STORED)


def test_stored_dev_without_record_is_empty() -> None:
    assert stored_dev(FakeApi({}), REPO) == StoredDev(run_id=None, sha=None)
    empty = base64.b64encode(json.dumps({"release": None, "dev": None, "pr": {}}).encode())
    api = FakeApi({_STORE_PATH: {"content": empty.decode()}})
    assert stored_dev(api, REPO) == StoredDev(run_id=None, sha=None)


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


def _ci_pr_run() -> dict[str, object]:
    pull = {
        "number": 5,
        "head": {"sha": HEAD},
        "base": {"repo": {"url": f"https://api.github.com/repos/{REPO}", "name": "pecot"}},
    }
    return _run(
        "pull_request",
        path=".github/workflows/ci.yml",
        head_branch="feat/x/5",
        conclusion="failure",
        pull_requests=[pull],
    )


def test_pr_side_is_downloaded_checked_and_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    api = FakeApi(
        _responses(
            _ci_pr_run(),
            **{
                f"repos/{REPO}/actions/runs/7/artifacts?per_page=100": {
                    "artifacts": [{"name": "pages-side-pr-5"}]
                },
                f"repos/{REPO}/pulls/5": {
                    "state": "open",
                    "head": {"sha": HEAD},
                    "base": {"repo": {"full_name": REPO}},
                },
            },
        )
    )
    downloads: list[tuple[str, str]] = []

    def download(repo: str, run_id: str, artifact: str, dest: Path) -> None:
        downloads.append((run_id, artifact))
        dest.mkdir(parents=True)
        _tar(dest / "site.tar", {"./index.html": "pr"})

    monkeypatch.setattr(verify, "gh_api", api)
    monkeypatch.setattr(verify, "download", download)
    output = tmp_path / "output"
    output.write_text("", encoding="utf-8")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    out = tmp_path / "verified"

    code = verify.main(["verify.py", "--run-id", "7", "--repo", REPO, "--out", str(out)])

    assert code == 0
    assert downloads == [("7", "pages-side-pr-5")]
    assert (out / "site.tar").is_file()
    assert output.read_text(encoding="utf-8") == (f"side=pr\npr=5\nhead_sha={HEAD}\nopen_prs=[3]\n")
    assert "- 側: pr" in capsys.readouterr().out


# dev_side.py（ci.yml の pages-preview が開発版の run を探す）


def test_dev_side_writes_run_id_and_sha(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    output = tmp_path / "output"
    output.write_text("", encoding="utf-8")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    api = FakeApi({_STORE_PATH: _store_file(STORED, "55")})
    assert dev_side.main(["dev_side.py", "--repo", REPO], api) == 0
    assert output.read_text(encoding="utf-8") == f"run_id=55\nsha={STORED}\n"
    assert api.paths == [_STORE_PATH]


@pytest.mark.parametrize(
    "content",
    [
        None,
        _store_file(STORED, None),
        _store_file(STORED, "55\nsha=evil"),
        _store_file("abc1234", "55"),
    ],
    ids=["no-store", "no-run-id", "run-id-not-number", "short-sha"],
)
def test_dev_side_without_a_usable_record_fails_with_rebuild_hint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    content: dict[str, object] | None,
) -> None:
    output = tmp_path / "output"
    output.write_text("", encoding="utf-8")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    api = FakeApi({_STORE_PATH: content} if content is not None else {})
    assert dev_side.main(["dev_side.py", "--repo", REPO], api) == 1
    assert output.read_text(encoding="utf-8") == ""
    assert "gh workflow run pages-build.yml --ref main -f side=dev" in capsys.readouterr().err
