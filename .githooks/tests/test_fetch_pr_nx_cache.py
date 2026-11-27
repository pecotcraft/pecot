"""fetch-pr-nx-cache.sh のユニットテスト。偽の gh は URL ごとのフィクスチャ（無ければ API 失敗）を返す。"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

REPO = "o/r"
OWN_RUN = "900"
BASE_SHA = "b" * 40
HEAD = "a1" * 20
OLD = "c2" * 20

_FAKE_GH = """#!/usr/bin/env bash
url=""
for a in "$@"; do
    case "$a" in -*|api) ;; *) url="$a" ;; esac
done
echo "$url" >> "$FAKE_GH_DIR/calls.log"
f="$FAKE_GH_DIR/${url//[^A-Za-z0-9]/_}"
[ -f "$f" ] || exit 1
cat "$f"
"""


ART = "nx-cache-tests-x"
REPO_ID = 42
ARTIFACTS_URL = f"repos/{REPO}/actions/artifacts?name={ART}&per_page=100"


def _art(
    run_id: int,
    sha: str,
    created: str,
    repo_id: int = REPO_ID,
    expired: bool = False,
) -> dict:
    return {
        "id": run_id * 10,
        "name": ART,
        "expired": expired,
        "created_at": created,
        "workflow_run": {"id": run_id, "head_sha": sha, "head_repository_id": repo_id},
    }


class Env:
    def __init__(self, tmp_path: Path, script: Path) -> None:
        self.fake = tmp_path / "fake"
        self.fake.mkdir()
        gh = tmp_path / "bin" / "gh"
        gh.parent.mkdir()
        gh.write_text(_FAKE_GH)
        gh.chmod(0o755)
        self.bin = gh.parent
        self.script = script
        self.source = tmp_path / "out" / "nx-source.txt"
        self.output = tmp_path / "github_output"

    def api(self, url: str, body: object) -> None:
        (self.fake / re.sub(r"[^A-Za-z0-9]", "_", url)).write_text(json.dumps(body))

    def pr(
        self, n: int, head: str, head_repo: str | None = REPO, commits: list[str] | None = None
    ) -> None:
        repo_obj = {"full_name": head_repo} if head_repo else None
        self.api(f"repos/{REPO}/pulls/{n}", {"head": {"sha": head, "repo": repo_obj}})
        self.api(f"repos/{REPO}", {"id": REPO_ID})
        self.api(
            f"repos/{REPO}/pulls/{n}/commits?per_page=100",
            [{"sha": s} for s in (commits or [OLD, head])],
        )

    def artifacts(self, *arts: dict) -> None:
        self.api(ARTIFACTS_URL, {"artifacts": list(arts)})

    def run_info(self, run_id: int, prs: list[int], event: str = "pull_request") -> None:
        self.api(
            f"repos/{REPO}/actions/runs/{run_id}",
            {"id": run_id, "event": event, "pull_requests": [{"number": n} for n in prs]},
        )

    def go(self, event: str, **extra: str) -> dict[str, str]:
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FAKE_GH_DIR": str(self.fake),
            "EVENT_NAME": event,
            "REPO": REPO,
            "ARTIFACT_NAME": ART,
            "GITHUB_RUN_ID": OWN_RUN,
            "GITHUB_OUTPUT": str(self.output),
            "NX_SOURCE_FILE": str(self.source),
            **extra,
        }
        r = run_attached([str(self.script)], env=env, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        return dict(line.split("=", 1) for line in self.source.read_text().splitlines())

    def run_id_output(self) -> str | None:
        if not self.output.exists():
            return None
        m = re.search(r"^run_id=(.*)$", read_output(self.output), re.M)
        return m.group(1) if m else None

    def calls(self) -> list[str]:
        return read_output(self.fake / "calls.log").splitlines()


@pytest.fixture
def env(tmp_path: Path, githooks_dir: Path) -> Env:
    return Env(tmp_path, githooks_dir / "ci" / "fetch-pr-nx-cache.sh")


def _queue_ref(n: int, prefix: str = "refs/heads/") -> str:
    return f"{prefix}gh-readonly-queue/main/pr-{n}-{BASE_SHA}"


@allure.title("pull_request のとき、PR の head に対応する最新の artifact を選び、run_id を出力する")
def test_pull_request_picks_latest_artifact(env: Env) -> None:
    """`fetch-pr-nx-cache.sh` を `pull_request` のイベントで実行する場合のテストです。PR の head に対応する artifact が複数あるとき、作成日時が最新の run を選び、状態 `imported` と `run_id` を出力することを確認します。"""
    with allure.step("PR・artifact・run を用意して取り込む"):
        env.pr(7, HEAD)
        env.artifacts(
            _art(100, OLD, "2026-11-01T00:00:00Z"),
            _art(120, HEAD, "2026-11-03T00:00:00Z"),
            _art(110, HEAD, "2026-11-02T00:00:00Z"),
        )
        env.run_info(120, [7])
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("取り込みの結果と run の ID を確かめる"):
        assert got == {
            "status": "imported",
            "run_id": "120",
            "pr": "7",
            "head_sha": HEAD,
        }
        assert env.run_id_output() == "120"


@allure.title("artifact が存在しないと、run なしの理由を出力し、run_id を出力しない")
def test_no_artifact_means_no_run(env: Env) -> None:
    """失敗したレーンは artifact を上げないため、候補が 0 件になる場合のテストです。状態が `none`、理由が `run なし` になり、`run_id` を出力しないことを確認します。"""
    with allure.step("artifact の無い状態で取り込む"):
        # 失敗したレーンは artifact を上げないので、候補に出ない
        env.pr(7, HEAD)
        env.artifacts()
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("「run なし」の結果と run の ID が無いことを確かめる"):
        assert got == {"status": "none", "reason": "run なし"}
        assert env.run_id_output() is None


@allure.title("最新の head の artifact が存在しないと、PR の古いコミットの artifact を選ぶ")
def test_falls_back_to_older_commit_artifact(env: Env) -> None:
    """最新の head のコミットの artifact が存在せず、PR の古いコミットの artifact だけがある場合のテストです。古いコミットの run を選び、`run_id` と `head_sha` を出力することを確認します。"""
    with allure.step("古い commit の artifact だけを用意して取り込む"):
        env.pr(7, HEAD)
        env.artifacts(_art(100, OLD, "2026-11-01T00:00:00Z"))
        env.run_info(100, [7])
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("古い commit の run が選ばれることを確かめる"):
        assert got["run_id"] == "100"
        assert got["head_sha"] == OLD


@allure.title("実行中の自分の run の artifact は、候補から除外する")
def test_excludes_own_run(env: Env) -> None:
    """`GITHUB_RUN_ID` と同じ run の artifact だけがある場合のテストです。自分の run は候補にしないため、状態が `none`、理由が `run なし` になることを確認します。"""
    with allure.step("自分の run の artifact だけを用意して取り込む"):
        env.pr(7, HEAD)
        env.artifacts(_art(int(OWN_RUN), HEAD, "2026-11-05T00:00:00Z"))
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("自分の run が除かれて「run なし」になることを確かめる"):
        assert got == {"status": "none", "reason": "run なし"}


@allure.title("期限切れの artifact は選ばず、次の候補を選ぶ")
def test_does_not_pick_expired_artifact(env: Env) -> None:
    """新しい artifact の期限が切れていて、古い artifact が有効な場合のテストです。期限切れのものを選ばず、有効な古い run を出力することを確認します。"""
    with allure.step("期限切れの artifact を混ぜて取り込む"):
        env.pr(7, HEAD)
        env.artifacts(
            _art(130, HEAD, "2026-11-09T00:00:00Z", expired=True),
            _art(100, OLD, "2026-11-01T00:00:00Z"),
        )
        env.run_info(100, [7])
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("期限切れでない run が選ばれることを確かめる"):
        assert got["run_id"] == "100"


@allure.title("head のリポジトリが別の artifact は、選ばない")
def test_does_not_pick_other_repo_head(env: Env) -> None:
    """artifact の run の `head_repository_id` が、別のリポジトリのものだけの場合のテストです。状態が `none`、理由が `run なし` になり、`run_id` を出力しないことを確認します。"""
    with allure.step("別のリポの head の artifact を用意して取り込む"):
        env.pr(7, HEAD)
        env.artifacts(_art(400, HEAD, "2026-11-09T00:00:00Z", repo_id=999))
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("「run なし」で run の ID が無いことを確かめる"):
        assert got == {"status": "none", "reason": "run なし"}
        assert env.run_id_output() is None


@allure.title("PR のコミットに含まれない sha の artifact は、選ばない")
def test_does_not_pick_sha_outside_pr_commits(env: Env) -> None:
    """artifact の `head_sha` が、PR のコミットの一覧に含まれない場合のテストです。その artifact を選ばず、理由が `run なし` になることを確認します。"""
    with allure.step("PR の commit に無い SHA の artifact を用意して取り込む"):
        env.pr(7, HEAD)
        other = "d3" * 20
        env.artifacts(_art(300, other, "2026-11-09T00:00:00Z"))
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("理由が「run なし」であることを確かめる"):
        assert got["reason"] == "run なし"


@allure.title("同じ sha でも別の PR の run は除外し、次の候補を選ぶ")
def test_does_not_pick_other_pr_run_with_same_sha(env: Env) -> None:
    """同じ sha を持つ別の PR（#8）の run がある場合のテストです。run の `pull_requests` を見て除外し、PR #7 の次の候補の run を選ぶことを確認します。"""
    with allure.step("同じ SHA で別の PR の run を混ぜて取り込む"):
        # 同じ sha を持つ別の PR（#8）の run は pull_requests で弾き、次の候補に進む
        env.pr(7, HEAD)
        env.artifacts(
            _art(300, HEAD, "2026-11-09T00:00:00Z"), _art(100, OLD, "2026-11-01T00:00:00Z")
        )
        env.run_info(300, [8])
        env.run_info(100, [7])
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("自分の PR の run が選ばれることを確かめる"):
        assert got["run_id"] == "100"


@allure.title("別の PR の run しか存在しないと、run なしの理由を出力し、run_id を出力しない")
def test_other_pr_run_only_gives_no_run(env: Env) -> None:
    """候補の run が、別の PR（#8）のものだけの場合のテストです。状態が `none`、理由が `run なし` になり、`run_id` を出力しないことを確認します。"""
    with allure.step("別の PR の run だけを用意して取り込む"):
        env.pr(7, HEAD)
        env.artifacts(_art(300, HEAD, "2026-11-09T00:00:00Z"))
        env.run_info(300, [8])
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("「run なし」で run の ID が無いことを確かめる"):
        assert got == {"status": "none", "reason": "run なし"}
        assert env.run_id_output() is None


@allure.title("イベントが pull_request ではない run は、選ばない")
def test_non_pull_request_run_is_rejected(env: Env) -> None:
    """候補の run のイベントが `push` の場合のテストです。その run を選ばず、理由が `run なし` になることを確認します。"""
    with allure.step("push の run だけを用意して取り込む"):
        env.pr(7, HEAD)
        env.artifacts(_art(300, HEAD, "2026-11-09T00:00:00Z"))
        env.run_info(300, [7], event="push")
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("理由が「run なし」であることを確かめる"):
        assert got["reason"] == "run なし"


@allure.title("PR のコミットが複数のページに分かれていても、すべてを対象にして artifact を選ぶ")
def test_commits_are_joined_across_pages(env: Env) -> None:
    """PR のコミットの一覧が 2 ページに分かれて返る場合のテストです。両方のページのコミットを対象にして、古いコミットの artifact も、新しい head の artifact も選べることを確認します。"""
    with allure.step("PR の commit を 2 ページに分けて返す API を用意する"):
        env.pr(7, HEAD)
        page1 = [{"sha": OLD}]
        page2 = [{"sha": HEAD}]
        (
            env.fake / re.sub(r"[^A-Za-z0-9]", "_", f"repos/{REPO}/pulls/7/commits?per_page=100")
        ).write_text(json.dumps(page1) + "\n" + json.dumps(page2))
        env.artifacts(_art(100, OLD, "2026-11-01T00:00:00Z"))
        env.run_info(100, [7])
    with allure.step("1 ページ目と 2 ページ目の commit の run がそれぞれ選ばれることを確かめる"):
        assert env.go("pull_request", PR_NUMBER="7")["run_id"] == "100"
        env.artifacts(_art(110, HEAD, "2026-11-02T00:00:00Z"))
        env.run_info(110, [7])
        assert env.go("pull_request", PR_NUMBER="7")["run_id"] == "110"


@allure.title("fork の PR は取り込まず、fork の PR の理由を出力する")
def test_fork_pr_is_not_imported(env: Env) -> None:
    """PR の head が別のリポジトリ（`evil/r`）の場合のテストです。状態が `none`、理由が `fork の PR` になり、`run_id` を出力しないことを確認します。"""
    with allure.step("フォークの PR を用意して取り込む"):
        env.pr(7, HEAD, head_repo="evil/r")
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("「fork の PR」の結果と run の ID が無いことを確かめる"):
        assert got == {"status": "none", "reason": "fork の PR"}
        assert env.run_id_output() is None


@allure.title("fork のリポジトリが削除された PR も、fork の PR として扱う")
def test_deleted_fork_repo_is_treated_as_fork(env: Env) -> None:
    """PR の head のリポジトリが `null`（削除済み）の場合のテストです。理由が `fork の PR` になることを確認します。"""
    with allure.step("フォーク元が消えた PR を用意して取り込む"):
        env.pr(7, HEAD, head_repo=None)
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("理由が「fork の PR」であることを確かめる"):
        assert got["reason"] == "fork の PR"


@allure.title(
    "merge_group の HEAD_REF の接頭辞が「{prefix}」のとき、キューの PR の artifact を選ぶ"
)
@pytest.mark.parametrize("prefix", ["refs/heads/", ""])
def test_merge_group_head_ref_forms(env: Env, prefix: str) -> None:
    """`merge_group` のイベントで、`HEAD_REF` を `refs/heads/` 付きと接頭辞なしの 2 通りで渡すテストです。どちらの場合も、`gh-readonly-queue` の ref から PR 番号を取り出し、状態 `imported` と `run_id`・PR 番号を出力することを確認します。"""
    with allure.step("merge_group の head の ref の形を変えて取り込む"):
        env.pr(7, HEAD)
        env.artifacts(_art(110, HEAD, "2026-11-02T00:00:00Z"))
        env.run_info(110, [7])
        got = env.go("merge_group", HEAD_REF=_queue_ref(7, prefix))
    with allure.step("取り込めた結果と run の ID と PR 番号を確かめる"):
        assert got["status"] == "imported"
        assert got["run_id"] == "110"
        assert got["pr"] == "7"


@allure.title("merge_group の base のブランチ名にスラッシュを含んでも、PR 番号を取り出す")
def test_merge_group_base_with_slash(env: Env) -> None:
    """`HEAD_REF` の base のブランチ名が `release/x` のようにスラッシュを含む場合のテストです。PR 番号と `run_id` を正しく取り出すことを確認します。"""
    with allure.step("スラッシュを含む base の ref で取り込む"):
        env.pr(7, HEAD)
        env.artifacts(_art(110, HEAD, "2026-11-02T00:00:00Z"))
        env.run_info(110, [7])
        got = env.go("merge_group", HEAD_REF=f"gh-readonly-queue/release/x/pr-7-{BASE_SHA}")
    with allure.step("PR 番号と run の ID を確かめる"):
        assert got["pr"] == "7"
        assert got["run_id"] == "110"


@allure.title("merge_group の HEAD_REF の末尾にある base の sha は、artifact の選択に使わない")
def test_merge_group_does_not_use_trailing_base_sha(env: Env) -> None:
    """`HEAD_REF` の末尾に付く base の sha と同じ `head_sha` の artifact がある場合のテストです。その artifact は選ばず、PR の head の artifact を選ぶことを確認します。"""
    with allure.step("末尾の base の SHA を使わない状態で取り込む"):
        env.pr(7, HEAD)
        env.artifacts(
            _art(110, HEAD, "2026-11-02T00:00:00Z"), _art(500, BASE_SHA, "2026-11-09T00:00:00Z")
        )
        env.run_info(110, [7])
        got = env.go("merge_group", HEAD_REF=_queue_ref(7))
    with allure.step("run の ID を確かめる"):
        assert got["run_id"] == "110"


@allure.title("merge_group で PR の head の artifact が存在しないと、head 不一致の理由を出力する")
def test_merge_group_rejects_head_mismatch(env: Env) -> None:
    """PR の head のコミットと一致する artifact が存在せず、古いコミットの artifact だけがある場合のテストです。`merge_group` では古いコミットを使わず、状態が `none`、理由が `head 不一致` になることを確認します。"""
    with allure.step("head が合わない artifact を用意して取り込む"):
        env.pr(7, HEAD)
        env.artifacts(_art(100, OLD, "2026-11-01T00:00:00Z"))
        got = env.go("merge_group", HEAD_REF=_queue_ref(7))
    with allure.step("「head 不一致」の結果と run の ID が無いことを確かめる"):
        assert got == {"status": "none", "reason": "head 不一致"}
        assert env.run_id_output() is None


@allure.title("merge_group で artifact が存在しないと、run なしの理由を出力する")
def test_merge_group_no_runs(env: Env) -> None:
    """`merge_group` のイベントで、artifact が 0 件の場合のテストです。状態が `none`、理由が `run なし` になることを確認します。"""
    with allure.step("run の無い状態で merge_group を取り込む"):
        env.pr(7, HEAD)
        env.artifacts()
        got = env.go("merge_group", HEAD_REF=_queue_ref(7))
    with allure.step("「run なし」の結果を確かめる"):
        assert got == {"status": "none", "reason": "run なし"}


@allure.title("merge_group で PR が fork のものだと、fork の PR の理由を出力する")
def test_merge_group_fork_pr(env: Env) -> None:
    """`merge_group` のイベントで、PR の head が別のリポジトリ（`evil/r`）の場合のテストです。理由が `fork の PR` になることを確認します。"""
    with allure.step("フォークの PR を merge_group で取り込む"):
        env.pr(7, HEAD, head_repo="evil/r")
        got = env.go("merge_group", HEAD_REF=_queue_ref(7))
    with allure.step("理由が「fork の PR」であることを確かめる"):
        assert got["reason"] == "fork の PR"


@allure.title("対象外のイベントでは、対象外の event の理由を出力する")
def test_other_event(env: Env) -> None:
    """`EVENT_NAME` が `push` の場合のテストです。状態が `none`、理由が `対象外の event` になることを確認します。"""
    with allure.step("対象外のイベントで取り込む"):
        got = env.go("push")
    with allure.step("「対象外の event」の結果を確かめる"):
        assert got == {"status": "none", "reason": "対象外の event"}


@allure.title("API の呼び出しに失敗しても、終了コード 0 で終わり、取得の失敗の理由を出力する")
def test_api_failure_exits_zero_with_reason(env: Env) -> None:
    """偽の `gh` が、フィクスチャが存在しないすべての API で失敗する場合のテストです。スクリプトは終了コード 0 で終わり、状態が `none`、理由が `取得の失敗` になり、`run_id` を出力しないことを確認します。"""
    with allure.step("API が失敗する状態で取り込む"):
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("「取得の失敗」の結果と run の ID が無いことを確かめる"):
        assert got == {"status": "none", "reason": "取得の失敗"}
        assert env.run_id_output() is None


@allure.title("artifact の一覧の API だけが失敗しても、取得の失敗の理由を出力する")
def test_artifacts_api_failure(env: Env) -> None:
    """PR の情報は取得できるが、artifact の一覧の API が失敗する場合のテストです。状態が `none`、理由が `取得の失敗` になることを確認します。"""
    with allure.step("artifact の API だけが失敗する状態で取り込む"):
        env.pr(7, HEAD)
        got = env.go("pull_request", PR_NUMBER="7")
    with allure.step("「取得の失敗」の結果を確かめる"):
        assert got == {"status": "none", "reason": "取得の失敗"}


@allure.title("REPO が空だと、取得の失敗の理由を出力する")
def test_empty_repo(env: Env) -> None:
    """`REPO` が空の場合のテストです。状態が `none`、理由が `取得の失敗` になることを確認します。"""
    with allure.step("リポの名前を空にして取り込む"):
        got = env.go("pull_request", PR_NUMBER="7", REPO="")
    with allure.step("「取得の失敗」の結果を確かめる"):
        assert got == {"status": "none", "reason": "取得の失敗"}


@allure.title("merge_group の HEAD_REF から PR 番号を取り出せないと、PR 番号不明の理由を出力する")
def test_unparsable_head_ref(env: Env) -> None:
    """`HEAD_REF` が `refs/heads/other` のように、`gh-readonly-queue` の形ではない場合のテストです。状態が `none`、理由が `PR 番号不明` になることを確認します。"""
    with allure.step("読めない head の ref で取り込む"):
        got = env.go("merge_group", HEAD_REF="refs/heads/other")
    with allure.step("「PR 番号不明」の結果を確かめる"):
        assert got == {"status": "none", "reason": "PR 番号不明"}


@allure.title("pull_request で PR_NUMBER が空だと、PR 番号不明の理由を出力する")
def test_missing_pr_number(env: Env) -> None:
    """`pull_request` のイベントで、`PR_NUMBER` が空の場合のテストです。状態が `none`、理由が `PR 番号不明` になることを確認します。"""
    with allure.step("PR 番号を空にして取り込む"):
        got = env.go("pull_request", PR_NUMBER="")
    with allure.step("「PR 番号不明」の結果を確かめる"):
        assert got == {"status": "none", "reason": "PR 番号不明"}


def _download_failed(env: Env, tmp_path: Path) -> tuple[dict[str, str], Path]:
    remote = tmp_path / "nx-remote"
    remote.mkdir()
    (remote / "123.tar.gz").write_text("partial")
    run_env = {
        **os.environ,
        "PATH": f"{env.bin}:{os.environ['PATH']}",
        "FAKE_GH_DIR": str(env.fake),
        "REPO": REPO,
        "SRC_RUN_ID": "120",
        "ARTIFACT_NAME": "nx-cache-tests-x",
        "NX_SOURCE_FILE": str(env.source),
        "NX_REMOTE_DIR": str(remote),
    }
    r = run_attached(
        [str(env.script), "--download-failed"], env=run_env, capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr
    return dict(line.split("=", 1) for line in env.source.read_text().splitlines()), remote


@allure.title(
    "--download-failed で artifact が存在しないと、キャッシュのディレクトリを削除し、artifact なしの理由を出力する"
)
def test_download_failed_without_artifact(env: Env, tmp_path: Path) -> None:
    """`--download-failed` を指定して実行し、対象の run に artifact が 0 件の場合のテストです。状態が `none`、理由が `artifact なし` になり、取り込み途中のキャッシュのディレクトリが削除されることを確認します。"""
    with allure.step("artifact が無い状態でダウンロードする"):
        env.api(
            f"repos/{REPO}/actions/runs/120/artifacts?name=nx-cache-tests-x", {"total_count": 0}
        )
        got, remote = _download_failed(env, tmp_path)
    with allure.step("「artifact なし」の結果と何も取り込まれないことを確かめる"):
        assert got == {"status": "none", "reason": "artifact なし"}
        assert not remote.exists()


@allure.title(
    "--download-failed で artifact が存在しても、キャッシュのディレクトリを削除し、download の失敗の理由を出力する"
)
def test_download_failed_with_artifact(env: Env, tmp_path: Path) -> None:
    """`--download-failed` を指定して実行し、対象の run に artifact が 1 件ある場合のテストです。状態が `none`、理由が `download の失敗` になり、取り込み途中のキャッシュのディレクトリが削除されることを確認します。"""
    with allure.step("artifact があるのにダウンロードが失敗する状態にする"):
        env.api(
            f"repos/{REPO}/actions/runs/120/artifacts?name=nx-cache-tests-x", {"total_count": 1}
        )
        got, remote = _download_failed(env, tmp_path)
    with allure.step("「download の失敗」の結果と何も取り込まれないことを確かめる"):
        assert got == {"status": "none", "reason": "download の失敗"}
        assert not remote.exists()


@allure.title("--download-failed で API が失敗すると、取得の失敗の理由を出力する")
def test_download_failed_api_error(env: Env, tmp_path: Path) -> None:
    """`--download-failed` を指定して実行し、artifact を調べる API が失敗する場合のテストです。状態が `none`、理由が `取得の失敗` になることを確認します。"""
    with allure.step("API が失敗する状態でダウンロードする"):
        got, _ = _download_failed(env, tmp_path)
    with allure.step("「取得の失敗」の結果を確かめる"):
        assert got == {"status": "none", "reason": "取得の失敗"}
