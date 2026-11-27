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

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/pages_site"))

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


def _store_file(
    dev_sha: str, run_id: object = "55", reports: dict[str, object] | None = None
) -> dict[str, object]:
    meta: dict[str, object] = {"release": None, "dev": {"sha": dev_sha, "run_id": run_id}, "pr": {}}
    if reports is not None:
        meta["reports"] = reports
    return {"content": base64.b64encode(json.dumps(meta).encode()).decode()}


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


@allure.title(
    "pages-store の `.pecot-store.json` の run_id が {run_id} のとき、定義書の開発版の記録を読み取る"
)
@pytest.mark.parametrize(
    ("run_id", "expected"), [("55", "55"), (55, "55"), (None, None), (True, None)]
)
def test_stored_dev_reads_pecot_store_json_on_pages_store(
    run_id: object, expected: str | None
) -> None:
    """`stored_dev` が、`pages-store` ブランチの `.pecot-store.json` から定義書の開発版の記録を読み取る場合のテストです。sha はそのまま取得し、`run_id` は文字列または整数なら文字列で、`None` や真偽値なら `None` で返すことを確認します。"""
    with allure.step("偽の API に保存済みの記録を置く"):
        api = FakeApi({_STORE_PATH: _store_file(STORED, run_id)})
    with allure.step("保存済みの dev の run と SHA を読めることを確かめる"):
        assert stored_dev(api, REPO, "site") == StoredDev(run_id=expected, sha=STORED)


REPORT_SHA = "5" * 40


@allure.title("定義書とレポートの記録が両方存在すると、指定した種類の記録を返す")
def test_stored_dev_reads_the_record_of_its_kind() -> None:
    """`.pecot-store.json` に定義書の開発版とレポートの開発版の両方が記録されている場合のテストです。`site` を指定すると定義書の記録を、`report` を指定するとレポートの記録を返すことを確認します。"""
    with allure.step("サイトとレポートの記録を持つ保存済みの記録を置く"):
        reports = {"dev": {"sha": REPORT_SHA, "run_id": "45627254351"}, "release": None}
        api = FakeApi({_STORE_PATH: _store_file(STORED, "55", reports)})
    with allure.step("種類ごとの記録を読めることを確かめる"):
        assert stored_dev(api, REPO, "site") == StoredDev(run_id="55", sha=STORED)
        assert stored_dev(api, REPO, "report") == StoredDev(run_id="45627254351", sha=REPORT_SHA)


@allure.title("レポートの記録が {reports} のとき、レポートの開発版の記録は空になる")
@pytest.mark.parametrize("reports", [None, {}, {"dev": None}, []], ids=str)
def test_stored_dev_report_without_record_is_empty(reports: object) -> None:
    """`.pecot-store.json` にレポートの開発版の記録が存在しない場合の、`stored_dev` のテストです。`report` を指定したときに、定義書の記録を使わず、`run_id` と `sha` が `None` になることを確認します。"""
    with allure.step("レポートの記録が無い保存済みの記録を置く"):
        meta: dict[str, object] = {"release": None, "dev": {"sha": STORED}, "pr": {}}
        if reports is not None:
            meta["reports"] = reports
        api = FakeApi(
            {_STORE_PATH: {"content": base64.b64encode(json.dumps(meta).encode()).decode()}}
        )
    with allure.step("レポートの保存済みの値が空になることを確かめる"):
        assert stored_dev(api, REPO, "report") == StoredDev(run_id=None, sha=None)


@allure.title("開発版の記録が存在しないと、定義書の開発版の記録は空になる")
def test_stored_dev_without_record_is_empty() -> None:
    """`.pecot-store.json` が存在しない場合と、開発版の記録が `null` の場合の、`stored_dev` のテストです。どちらも `run_id` と `sha` が `None` になることを確認します。"""
    with allure.step(
        "記録が無い、または dev が空の保存済みの記録から読んで、空になることを確かめる"
    ):
        assert stored_dev(FakeApi({}), REPO, "site") == StoredDev(run_id=None, sha=None)
        empty = base64.b64encode(json.dumps({"release": None, "dev": None, "pr": {}}).encode())
        api = FakeApi({_STORE_PATH: {"content": empty.decode()}})
        assert stored_dev(api, REPO, "site") == StoredDev(run_id=None, sha=None)


@allure.title(
    "保管した開発版より新しい push の run は、開発版として採用し、開いている PR の番号を返す"
)
def test_judge_compares_the_stored_dev_with_the_head() -> None:
    """`pages-store` に保管した開発版の sha より、run の head が進んでいる場合の `judge` のテストです。判定の側が `dev`、head の sha と artifact の名前が期待どおりで、開いている PR の番号が返ることを確認します。"""
    with allure.step("保存済みの dev がある偽の API で判定する"):
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
    with allure.step("dev の側・head の SHA・artifact と開いた PR を確かめる"):
        assert (verdict.side, verdict.head_sha, verdict.artifact) == ("dev", HEAD, "pages-side-dev")
        assert opened == [3]


@allure.title("保管した開発版より古い push の run は、採用しない")
def test_judge_drops_an_older_dev_run() -> None:
    """run の head が、保管した開発版の sha より遅れている場合の `judge` のテストです。判定の側が `None` になることを確認します。"""
    with allure.step("保存済みの dev より新しい状態の偽の API を用意する"):
        api = FakeApi(
            _responses(
                _run(),
                **{
                    f"repos/{REPO}/contents/.pecot-store.json?ref=pages-store": _store_file(STORED),
                    f"repos/{REPO}/compare/{STORED}...{HEAD}": {"status": "behind"},
                },
            )
        )
    with allure.step("古い dev の run を判定して、捨てられることを確かめる"):
        assert judge(api, REPO, "7")[0].side is None


def _report_run(event: str = "push") -> dict[str, object]:
    return _run(event, path=".github/workflows/test-report.yml", name="test-report")


@allure.title(
    "レポートの run が保管したレポートより {status} のとき、レポートの採用の可否を判定する"
)
@pytest.mark.parametrize(("status", "side"), [("ahead", "dev"), ("behind", None)])
def test_judge_compares_a_report_run_with_the_stored_report(status: str, side: str | None) -> None:
    """テストレポートの run を `judge` で判定する場合のテストです。定義書の開発版ではなく、保管したレポートの開発版と比較し、進んでいれば `report` の `dev` として採用し、遅れていれば採用しないことを確認します。"""
    with allure.step("保存済みのレポートがある偽の API でレポートの run を判定する"):
        # 定義書の開発版（STORED）でなく、レポートの開発版（REPORT_SHA）と比べる。
        reports = {"dev": {"sha": REPORT_SHA, "run_id": "9"}}
        api = FakeApi(
            _responses(
                _report_run(),
                **{
                    f"repos/{REPO}/actions/runs/7/artifacts?per_page=100": {
                        "artifacts": [{"name": "allure-results-a"}, {"name": "test-report-dev"}]
                    },
                    _STORE_PATH: _store_file(STORED, "55", reports),
                    f"repos/{REPO}/compare/{REPORT_SHA}...{HEAD}": {"status": status},
                },
            )
        )
        verdict, _ = judge(api, REPO, "7")
    with allure.step("種類と側と比較の呼び出しを確かめる"):
        assert (verdict.kind, verdict.side) == (("report" if side else None), side)
        assert f"repos/{REPO}/compare/{STORED}...{HEAD}" not in api.paths


@allure.title("保管したレポートが存在しない最初のレポートの run は、比較せずに採用する")
def test_judge_takes_a_first_report_without_stored_report() -> None:
    """保管したレポートの記録が存在しない状態で、テストレポートの run を `judge` で判定した場合のテストです。種類が `report`、側が `dev`、artifact が `test-report-dev` になり、定義書の開発版とは比較しないことを確認します。"""
    with allure.step("保存済みのレポートが無い偽の API でレポートの run を判定する"):
        api = FakeApi(
            _responses(
                _report_run(),
                **{
                    f"repos/{REPO}/actions/runs/7/artifacts?per_page=100": {
                        "artifacts": [{"name": "test-report-dev"}]
                    },
                    _STORE_PATH: _store_file(STORED),
                },
            )
        )
        verdict, _ = judge(api, REPO, "7")
    with allure.step("最初のレポートとして受け付けられ、比較しないことを確かめる"):
        assert (verdict.kind, verdict.side, verdict.artifact) == (
            "report",
            "dev",
            "test-report-dev",
        )
        assert not any(p.startswith(f"repos/{REPO}/compare/{STORED}") for p in api.paths)


@allure.title("pull_request の run では、main と保管ブランチを参照しない")
def test_judge_does_not_ask_main_or_the_store_for_pull_request_runs() -> None:
    """`pull_request` イベントの run を `judge` で判定した場合のテストです。API の呼び出しに、main との比較と `pecot-store` の取得が含まれないことを確認します。"""
    with allure.step("pull_request の run を判定する"):
        api = FakeApi(_responses(_run("pull_request")))
        judge(api, REPO, "7")
    with allure.step("main と保存先を問い合わせないことを確かめる"):
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


def _verdict(side: str, kind: str = "site") -> Verdict:
    artifact = f"test-report-{side}" if kind == "report" else f"pages-side-{side}"
    return Verdict(side=side, pr=None, head_sha=HEAD, artifact=artifact, reason="", kind=kind)


@allure.title("{side} の定義書が、テストレポートへのリンクを含むとき、検証の結果は {ok} になる")
@pytest.mark.parametrize(("side", "ok"), [("dev", True), ("release", True), ("pr", False)])
def test_check_side_lets_dev_and_release_link_to_their_report(
    tmp_path: Path, side: str, ok: bool
) -> None:
    """定義書にテストレポートへのリンクが含まれる場合の `check_side` のテストです。`dev` と `release` では問題が検出されず、`pr` ではレポートへのリンクが問題として検出されることを確認します。"""
    with allure.step("レポートへのリンクを持つサイトの tar を用意して側を verify する"):
        _tar(
            tmp_path / "site.tar",
            {"./index.html": "<a href='test-report/index.html?tags=PW-A-01'>t</a>"},
        )
        if side == "release":
            (tmp_path / "release-sources.json").write_text(json.dumps(_RELEASE), encoding="utf-8")
        problems = check_side(_verdict(side), tmp_path, "origin/main", lambda _: dict(_RELEASE))
    with allure.step("verify の結果が期待どおりであることを確かめる"):
        assert (problems == []) is ok


_REPORT_SOURCES = {
    "side": "release",
    "runs": [{"commit": "3" * 40, "lanes": ["a:b"]}],
    "missing": [],
}
_REPORT_TREE = {"./index.html": "<html></html>", "./history.jsonl": '{"uuid":"a"}\n'}


@allure.title("レポートの run の artifact に report.tar が存在しないと、問題として報告する")
def test_check_side_report_needs_report_tar(tmp_path: Path) -> None:
    """定義書の `site.tar` だけを含む artifact を、レポートの run として `check_side` で検証した場合のテストです。「artifact に report.tar がありません」という問題が報告されることを確認します。"""
    with allure.step("サイトの tar だけを置く"):
        # 定義書の site.tar があっても、レポートの run では使わない。
        _tar(tmp_path / "site.tar", {"./index.html": "x"})
    with allure.step("レポートの側を verify して、レポートの tar が要ると出ることを確かめる"):
        assert check_side(_verdict("dev", "report"), tmp_path, "origin/main", lambda _: {}) == [
            "artifact に report.tar がありません"
        ]


@allure.title("report.tar の history.jsonl が読めないと、問題として報告する")
def test_check_side_report_runs_report_check(tmp_path: Path) -> None:
    """`history.jsonl` に Allure が読めない行を含む `report.tar` を、`check_side` で検証した場合のテストです。「`history.jsonl` の 1 行目を Allure が読めません」という問題が報告されることを確認します。"""
    with allure.step("履歴に不正な値のあるレポートの tar を置く"):
        _tar(tmp_path / "report.tar", {"./index.html": "x", "./history.jsonl": "NaN\n"})
    with allure.step("レポートの側を verify して、問題が出ることを確かめる"):
        assert check_side(_verdict("dev", "report"), tmp_path, "origin/main", lambda _: {}) == [
            "`history.jsonl` の 1 行目を Allure が読めません"
        ]


@allure.title("開発版のレポートは、材料を求め直さずに検証を通す")
def test_check_side_dev_report_passes_without_comparing_sources(tmp_path: Path) -> None:
    """正しい構成の `report.tar` を、開発版のレポートとして `check_side` で検証した場合のテストです。問題が検出されず、材料を求め直す関数が 1 度も呼ばれないことを確認します。"""
    with allure.step("dev のレポートの tar を置く"):
        _tar(tmp_path / "report.tar", _REPORT_TREE)
        seen: list[str] = []

        def record(main_ref: str) -> dict[str, object]:
            seen.append(main_ref)
            return {}

    with allure.step("元の比較をせずに通ることを確かめる"):
        assert check_side(_verdict("dev", "report"), tmp_path, "origin/main", record) == []
        assert seen == []


@allure.title(
    "リリース版のレポートの report-sources.json が {param_id} のとき、求め直した値と比較して検証する"
)
@pytest.mark.parametrize(
    ("sources", "expected"),
    [
        (_REPORT_SOURCES, []),
        (
            {**_REPORT_SOURCES, "missing": ["pecot-tools"]},
            ["report-sources.json が、タグと main から求め直した値と一致しません"],
        ),
        (None, ["artifact に report-sources.json がありません"]),
    ],
    ids=["same", "different", "missing"],
)
def test_check_side_compares_release_report_sources_with_the_recomputed_ones(
    tmp_path: Path, sources: dict[str, object] | None, expected: list[str]
) -> None:
    """リリース版のレポートの `report-sources.json` を、`check_side` が求め直した値と比較する場合のテストです。値が一致すれば問題なし、異なれば不一致、ファイルが存在しなければ存在しない旨が、問題として報告されることを確認します。"""
    with allure.step("release のレポートの tar と記録を置いて側を verify する"):
        _tar(tmp_path / "report.tar", _REPORT_TREE)
        # 定義書の release-sources.json はレポートの確かめに使わない。
        (tmp_path / "release-sources.json").write_text(json.dumps(_RELEASE), encoding="utf-8")
        if sources is not None:
            (tmp_path / "report-sources.json").write_text(json.dumps(sources), encoding="utf-8")
        problems = check_side(
            _verdict("release", "report"), tmp_path, "origin/main", lambda _: dict(_REPORT_SOURCES)
        )
    with allure.step("再計算した元と比べた問題を確かめる"):
        assert problems == expected


@allure.title("`report_record` は、`release_sources.py --report release` の出力から材料を取り出す")
def test_report_record_is_the_sources_of_release_sources_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`report_record` が `release_sources.py` を呼ぶ場合のテストです。サブプロセスの実行を置き換え、`--report release --main origin/main` の引数で呼ばれ、出力の `sources` の値が返ることを確認します。"""
    with allure.step("子の実行を差し替えて release のレポートの記録を読む"):
        calls: list[list[str]] = []

        class Done:
            returncode = 0
            stdout = json.dumps({"sources": _REPORT_SOURCES, "matrix": [{"lane": "a:b"}]})
            stderr = ""

        def run(args: list[str], **_: object) -> Done:
            calls.append(args)
            return Done()

        monkeypatch.setattr(verify.subprocess, "run", run)
    with allure.step("記録が元と同じで、子の引数が正しいことを確かめる"):
        assert verify.report_record("origin/main") == _REPORT_SOURCES
        (args,) = calls
        assert args[1].endswith("pages_site/release_sources.py")
        assert args[2:] == ["--report", "release", "--main", "origin/main"]


@allure.title("定義書の artifact に site.tar が存在しないと、問題として報告する")
def test_check_side_needs_site_tar(tmp_path: Path) -> None:
    """`site.tar` を含まない artifact を、`check_side` で検証した場合のテストです。「artifact に site.tar がありません」という問題が報告されることを確認します。"""
    with allure.step("サイトの tar が無いと、verify で tar が要ると出ることを確かめる"):
        assert check_side(_verdict("dev"), tmp_path, "origin/main", lambda _: {}) == [
            "artifact に site.tar がありません"
        ]


@allure.title("問題のない開発版の定義書は、検証を通す")
def test_check_side_passes_a_clean_dev_side(tmp_path: Path) -> None:
    """リンク切れのない `site.tar` を、開発版として `check_side` で検証した場合のテストです。問題が 1 件も検出されないことを確認します。"""
    with allure.step("問題の無い dev のサイトの tar を置く"):
        _tar(tmp_path / "site.tar", {"./index.html": "<a href='a.html'>a</a>", "./a.html": "a"})
    with allure.step("dev の側を verify して、問題が出ないことを確かめる"):
        assert check_side(_verdict("dev"), tmp_path, "origin/main", lambda _: {}) == []


@allure.title("site.tar に展開先の外を指すファイルが含まれると、問題として報告する")
def test_check_side_reports_unsafe_members(tmp_path: Path) -> None:
    """`../escape.html` のように展開先の外へ出るファイルを含む `site.tar` を、`check_side` で検証した場合のテストです。問題が報告されることを確認します。"""
    with allure.step("危険な名前の入ったサイトの tar を置く"):
        _tar(tmp_path / "site.tar", {"../escape.html": "x"})
    with allure.step("dev の側を verify して、問題が出ることを確かめる"):
        assert check_side(_verdict("dev"), tmp_path, "origin/main", lambda _: {})


@allure.title(
    "リリース版の release-sources.json が {param_id} のとき、求め直した値と比較して検証する"
)
@pytest.mark.parametrize(
    ("sources", "ok"),
    [(_RELEASE, True), ({**_RELEASE, "skeleton": "4" * 40}, False), (None, False)],
    ids=["same", "different", "missing"],
)
def test_check_side_compares_release_sources_with_the_recomputed_ones(
    tmp_path: Path, sources: dict[str, object] | None, ok: bool
) -> None:
    """リリース版の定義書の `release-sources.json` を、`check_side` が求め直した値と比較する場合のテストです。一致するときだけ問題が報告されず、異なる場合と存在しない場合は問題が報告され、ファイルがあれば求め直しが 1 回行われることを確認します。"""
    with allure.step("release のサイトの tar と記録を置いて側を verify する"):
        _tar(tmp_path / "site.tar", {"./index.html": "x"})
        if sources is not None:
            (tmp_path / "release-sources.json").write_text(json.dumps(sources), encoding="utf-8")
        seen: list[str] = []

        def record(main_ref: str) -> dict[str, object]:
            seen.append(main_ref)
            return dict(_RELEASE)

        problems = check_side(_verdict("release"), tmp_path, "origin/main", record)
    with allure.step("再計算した元と比べた問題を確かめる"):
        assert (problems == []) is ok
        if sources is not None:
            assert seen == ["origin/main"]


def _pr_build_run() -> dict[str, object]:
    pull = {
        "number": 5,
        "head": {"sha": HEAD},
        "base": {"repo": {"url": f"https://api.github.com/repos/{REPO}", "name": "pecot"}},
    }
    return _run(
        "pull_request",
        path=".github/workflows/pages-build.yml",
        head_branch="feat/x/5",
        conclusion="success",
        pull_requests=[pull],
    )


@allure.title("PR の定義書の run は、artifact をダウンロードして検証し、結果を出力する")
def test_pr_side_is_downloaded_checked_and_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """PR のビルドの run を `verify.main` で処理した場合のテストです。対象の artifact だけがダウンロードされ、`site.tar` が出力先に置かれ、`GITHUB_OUTPUT` と標準出力に側・種類・PR 番号が書かれることを確認します。"""
    with allure.step("偽の API とダウンロードを差し替えて PR 側を検証する"):
        api = FakeApi(
            _responses(
                _pr_build_run(),
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

    with allure.step("終了コードとダウンロードと出力のファイルと表示を確かめる"):
        assert code == 0
        assert downloads == [("7", "pages-side-pr-5")]
        assert (out / "site.tar").is_file()
        assert output.read_text(encoding="utf-8") == (
            f"side=pr\nkind=site\npr=5\nhead_sha={HEAD}\nopen_prs=[3]\n"
        )
        printed = capsys.readouterr().out
        assert "- 側: pr" in printed
        assert "- 種類: 定義書" in printed


@allure.title("リリース版のレポートの run は、artifact をダウンロードして検証し、結果を出力する")
def test_release_report_is_downloaded_checked_and_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """手動で起動したリリース版のレポートの run を `verify.main` で処理した場合のテストです。定義書の材料を求め直さず、`report.tar` と `report-sources.json` が出力先に置かれ、`GITHUB_OUTPUT` に側と種類が書かれることを確認します。"""
    with allure.step("偽の API とダウンロードを差し替えて release のレポートを検証する"):
        api = FakeApi(
            _responses(
                _report_run("workflow_dispatch"),
                **{
                    f"repos/{REPO}/actions/runs/7/artifacts?per_page=100": {
                        "artifacts": [{"name": "allure-results-a"}, {"name": "test-report-release"}]
                    },
                },
            )
        )
        downloads: list[tuple[str, str]] = []

        def download(repo: str, run_id: str, artifact: str, dest: Path) -> None:
            downloads.append((run_id, artifact))
            dest.mkdir(parents=True)
            _tar(dest / "report.tar", _REPORT_TREE)
            (dest / "report-sources.json").write_text(json.dumps(_REPORT_SOURCES), encoding="utf-8")

        def release_record(main_ref: str) -> dict[str, object]:
            raise AssertionError("定義書の材料を求め直しています")

        monkeypatch.setattr(verify, "gh_api", api)
        monkeypatch.setattr(verify, "download", download)
        monkeypatch.setattr(verify, "release_record", release_record)
        monkeypatch.setattr(verify, "report_record", lambda _: dict(_REPORT_SOURCES))
        output = tmp_path / "output"
        output.write_text("", encoding="utf-8")
        monkeypatch.setenv("GITHUB_OUTPUT", str(output))
        out = tmp_path / "verified"

        code = verify.main(["verify.py", "--run-id", "7", "--repo", REPO, "--out", str(out)])

    with allure.step("終了コードとダウンロードと出力のファイルと表示を確かめる"):
        assert code == 0
        assert downloads == [("7", "test-report-release")]
        assert sorted(p.name for p in out.iterdir()) == ["report-sources.json", "report.tar"]
        assert output.read_text(encoding="utf-8") == (
            f"side=release\nkind=report\npr=\nhead_sha={HEAD}\nopen_prs=[3]\n"
        )
        printed = capsys.readouterr().out
        assert "- 側: release" in printed
        assert "- 種類: レポート" in printed


@allure.title("採用しないレポートの run は、側と種類を空にして出力する")
def test_dropped_report_outputs_no_kind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`pull_request` イベントのレポートの run を `verify.main` で処理した場合のテストです。終了コードが 0 になり、`GITHUB_OUTPUT` の側と種類が空で、標準出力の種類が `-` になることを確認します。"""
    with allure.step("捨てられるレポートの run を検証する"):
        api = FakeApi(_responses(_report_run("pull_request")))
        monkeypatch.setattr(verify, "gh_api", api)
        output = tmp_path / "output"
        output.write_text("", encoding="utf-8")
        monkeypatch.setenv("GITHUB_OUTPUT", str(output))
        out = tmp_path / "verified"
    with allure.step("種類が空の出力のファイルと表示を確かめる"):
        assert verify.main(["verify.py", "--run-id", "7", "--repo", REPO, "--out", str(out)]) == 0
        assert output.read_text(encoding="utf-8") == "side=\nkind=\npr=\nhead_sha=\nopen_prs=[3]\n"
        assert "- 種類: -" in capsys.readouterr().out
