"""find-pr-ci-base.sh のユニットテスト。偽の gh は URL ごとのフィクスチャ（無ければ API 失敗）を返す。"""

from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Callable
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import run_attached  # noqa: E402

REPO = "o/r"

_FAKE_GH = """#!/usr/bin/env bash
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
    id="$3"; dir=""
    while [ "$#" -gt 0 ]; do [ "$1" = "-D" ] && dir="$2"; shift; done
    [ -f "$FAKE_GH_DIR/artifact_$id" ] || exit 1
    cp "$FAKE_GH_DIR/artifact_$id" "$dir/ci-base.txt"
    exit 0
fi
url=""
for a in "$@"; do
    case "$a" in -*|api) ;; *) url="$a" ;; esac
done
f="$FAKE_GH_DIR/${url//[^A-Za-z0-9]/_}"
[ -f "$f" ] || exit 1
cat "$f"
"""


def run_entry(
    run_id: int, created: str, prs: tuple[int, ...] = (7,), event: str = "pull_request"
) -> dict:
    return {
        "id": run_id,
        "created_at": created,
        "event": event,
        "pull_requests": [{"number": n} for n in prs],
    }


class Env:
    def __init__(self, tmp_path: Path, repo: Path, script: Path) -> None:
        self.fake = tmp_path / "fake"
        self.fake.mkdir()
        gh = tmp_path / "bin" / "gh"
        gh.parent.mkdir()
        gh.write_text(_FAKE_GH)
        gh.chmod(0o755)
        self.bin = gh.parent
        self.repo = repo
        self.script = script

    def git(self, *args: str) -> str:
        r = run_attached(["git", *args], cwd=self.repo, check=True, capture_output=True, text=True)
        return r.stdout.strip()

    def commit(self, name: str, content: str, parent: str | None = None) -> str:
        if parent:
            self.git("checkout", "-q", "--detach", parent)
        (self.repo / name).write_text(content)
        self.git("add", name)
        self.git("commit", "-q", "-m", f"{name} {content}")
        return self.git("rev-parse", "HEAD")

    def api(self, url: str, body: object) -> None:
        (self.fake / re.sub(r"[^A-Za-z0-9]", "_", url)).write_text(json.dumps(body))

    def pull(self, n: int, head: str, head_repo: str | None = REPO) -> None:
        repo_obj = {"full_name": head_repo} if head_repo else None
        self.api(f"repos/{REPO}/pulls/{n}", {"head": {"sha": head, "repo": repo_obj}})

    def runs(self, head: str, *runs: tuple[int, str] | dict) -> None:
        """List workflow runs の応答。(id, created_at) は PR 7 の pull_request の run になる。"""
        url = f"repos/{REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={head}&status=success&per_page=100"
        self.api(
            url, {"workflow_runs": [r if isinstance(r, dict) else run_entry(*r) for r in runs]}
        )

    def artifact(self, run_id: int, main_sha: str, pr_head: str) -> None:
        (self.fake / f"artifact_{run_id}").write_text(f"main_sha={main_sha}\npr_head={pr_head}\n")

    def go(self, head_ref: str, base: str, head: str, repo: str = REPO) -> tuple[str, str]:
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FAKE_GH_DIR": str(self.fake),
            "HEAD_REF": head_ref,
            "REPO": repo,
            "QUEUE_BASE": base,
            "QUEUE_HEAD": head,
        }
        r = run_attached([str(self.script)], env=env, cwd=self.repo, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        return r.stdout.strip(), r.stderr.strip()


class Scene:
    """M0 -> Q_base（main が 1 つ進む）。PR は M0 から分岐し、Q_head は Q_base の上の squash。"""

    def __init__(self, env: Env) -> None:
        self.env = env
        env.git("checkout", "-q", "-b", "main")
        self.m0 = env.commit("a.txt", "a")
        self.base = env.commit("b.txt", "b")
        self.pr_head = env.commit("pr.txt", "pr", parent=self.m0)
        self.q_head = env.commit("pr.txt", "pr", parent=self.base)
        self.ref = f"refs/heads/gh-readonly-queue/main/pr-7-{self.base}"
        env.pull(7, self.pr_head)

    def good_run(self, run_id: int = 100, created: str = "2026-11-01T00:00:00Z") -> None:
        self.env.runs(self.pr_head, (run_id, created))
        self.env.artifact(run_id, self.m0, self.pr_head)

    def go(self) -> tuple[str, str]:
        return self.env.go(self.ref, self.base, self.q_head)

    def found(self, main_sha: str, run_id: int = 100) -> str:
        """成功したときの標準出力（pr_main・pr_run・pr_head の 3 行）。"""
        return f"pr_main={main_sha}\npr_run={run_id}\npr_head={self.pr_head}"


@pytest.fixture
def env(tmp_path: Path, githooks_dir: Path, git_repo: Callable[..., Path]) -> Env:
    return Env(tmp_path, git_repo(), githooks_dir / "ci" / "find-pr-ci-base.sh")


@pytest.fixture
def scene(env: Env) -> Scene:
    return Scene(env)


@allure.title(
    "すべての条件を満たすと、PR の CI が基にした main の sha と、その run の ID と PR の head を出力する"
)
def test_outputs_pr_main_run_and_head_on_success(scene: Scene) -> None:
    """`find-pr-ci-base.sh` の、merge queue のコミットが PR の CI の結果を再利用できる場合のテストです。標準出力に `pr_main`・`pr_run`・`pr_head` の 3 行を出力し、標準エラーには何も出力しないことを確認します。"""
    with allure.step("成功する run を用意して動かす"):
        scene.good_run()
    with allure.step("出力が pr_main・pr_run・pr_head の 3 行であることを確かめる"):
        assert scene.go() == (
            f"pr_main={scene.m0}\npr_run=100\npr_head={scene.pr_head}",
            "",
        )


@allure.title("HEAD_REF の接頭辞が「{prefix}」でも、pr_main を出力する")
@pytest.mark.parametrize("prefix", ["refs/heads/", ""])
def test_head_ref_forms(scene: Scene, prefix: str) -> None:
    """`HEAD_REF` を `refs/heads/` 付きと接頭辞なしの 2 通りで渡すテストです。どちらの場合も、同じ `pr_main` を出力することを確認します。"""
    with allure.step("成功する run を用意して head の ref の形を変えて動かす"):
        scene.good_run()
        ref = f"{prefix}gh-readonly-queue/main/pr-7-{scene.base}"
    with allure.step("出力が pr_main であることを確かめる"):
        assert scene.env.go(ref, scene.base, scene.q_head)[0] == scene.found(scene.m0)


@allure.title("成功した run が複数あるときは、検証に合格した新しい run の pr_main を出力する")
def test_picks_newer_run_that_passes(scene: Scene) -> None:
    """成功した run が 2 件あり、どちらの artifact も検証に合格する場合のテストです。作成日時が新しい run の `main_sha` を、`pr_main` として出力することを確認します。"""
    with allure.step("新旧 2 つの run と artifact を用意する"):
        scene.env.runs(scene.pr_head, (100, "2026-11-01T00:00:00Z"), (110, "2026-11-02T00:00:00Z"))
        scene.env.artifact(100, scene.m0, scene.pr_head)
        scene.env.artifact(110, scene.base, scene.pr_head)
    with allure.step("新しい run の pr_main が選ばれることを確かめる"):
        assert scene.go()[0] == scene.found(scene.base, 110)


@allure.title("新しい run の artifact が検証に合格しないと、古い run の pr_main を出力する")
def test_falls_back_to_older_run_when_newer_fails_check(scene: Scene) -> None:
    """新しい run の artifact の `pr_head` が、PR の head と異なる場合のテストです。新しい run を選ばず、古い run の `main_sha` を `pr_main` として出力することを確認します。"""
    with allure.step("新しい run の verify が失敗する状態を用意する"):
        scene.env.runs(scene.pr_head, (100, "2026-11-01T00:00:00Z"), (110, "2026-11-02T00:00:00Z"))
        scene.env.artifact(100, scene.m0, scene.pr_head)
        scene.env.artifact(110, scene.m0, "f" * 40)
    with allure.step("古い run の pr_main に戻ることを確かめる"):
        assert scene.go()[0] == scene.found(scene.m0)


@allure.title("別の PR の run は除外し、次の run の pr_main を出力する")
def test_skips_run_of_other_pr(scene: Scene) -> None:
    """新しい run が別の PR（#8）のものである場合のテストです。その run を除外して、PR #7 の古い run の `main_sha` を `pr_main` として出力することを確認します。"""
    with allure.step("別の PR の run を混ぜた状態を用意する"):
        scene.env.runs(
            scene.pr_head,
            (100, "2026-11-01T00:00:00Z"),
            run_entry(110, "2026-11-02T00:00:00Z", prs=(8,)),
        )
        scene.env.artifact(100, scene.m0, scene.pr_head)
        scene.env.artifact(110, scene.base, scene.pr_head)
    with allure.step("別の PR の run が飛ばされることを確かめる"):
        assert scene.go()[0] == scene.found(scene.m0)


@allure.title("イベントが pull_request ではない run は除外し、次の run の pr_main を出力する")
def test_skips_run_of_other_event(scene: Scene) -> None:
    """新しい run のイベントが `push` の場合のテストです。その run を除外して、古い run の `main_sha` を `pr_main` として出力することを確認します。"""
    with allure.step("別のイベントの run を混ぜた状態を用意する"):
        scene.env.runs(
            scene.pr_head,
            (100, "2026-11-01T00:00:00Z"),
            run_entry(110, "2026-11-02T00:00:00Z", event="push"),
        )
        scene.env.artifact(100, scene.m0, scene.pr_head)
        scene.env.artifact(110, scene.base, scene.pr_head)
    with allure.step("別のイベントの run が飛ばされることを確かめる"):
        assert scene.go()[0] == scene.found(scene.m0)


@allure.title("別の PR の run しか存在しないと、run に PR が含まれない理由を出力する")
def test_only_run_of_other_pr_gives_reason(scene: Scene) -> None:
    """成功した run が、別の PR（#8）のものだけの場合のテストです。標準出力は空で、標準エラーに `reason=run に PR が含まれない` を出力することを確認します。"""
    with allure.step("別の PR の run だけを用意して動かす"):
        scene.env.runs(scene.pr_head, run_entry(110, "2026-11-02T00:00:00Z", prs=(8,)))
    with allure.step("理由が「run に PR が含まれない」であることを確かめる"):
        assert scene.go() == ("", "reason=run に PR が含まれない")


@allure.title("成功した run が存在しないと、その理由を出力する")
def test_no_successful_run(scene: Scene) -> None:
    """成功した run が 0 件の場合のテストです。標準出力は空で、標準エラーに `reason=成功した run なし` を出力することを確認します。"""
    with allure.step("成功した run が無い状態で動かす"):
        scene.env.runs(scene.pr_head)
    with allure.step("理由が「成功した run なし」であることを確かめる"):
        assert scene.go() == ("", "reason=成功した run なし")


@allure.title(
    "PR の head と異なる head_sha の run は、結果に含まれず、成功した run なしの理由を出力する"
)
def test_runs_for_other_head_are_not_returned(scene: Scene) -> None:
    """API が、PR の head と異なる `head_sha` の run を返さず、`workflow_runs` が空になる場合のテストです。標準出力は空で、標準エラーに `reason=成功した run なし` を出力することを確認します。"""
    with allure.step("別の head の run だけを返す API を用意する"):
        # PR の head と違う head_sha の run は、API が `workflow_runs: []` で返す
        scene.env.api(
            f"repos/{REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={scene.pr_head}&status=success&per_page=100",
            {"workflow_runs": []},
        )
        scene.env.runs("e" * 40, (100, "2026-11-01T00:00:00Z"))
    with allure.step("理由が「成功した run なし」であることを確かめる"):
        assert scene.go() == ("", "reason=成功した run なし")


def _drop_artifact(scene: Scene) -> None:
    (scene.env.fake / "artifact_100").unlink()


def _artifact_of_other_head(scene: Scene) -> None:
    scene.env.artifact(100, scene.m0, "f" * 40)


def _main_sha_not_ancestor(scene: Scene) -> None:
    scene.env.artifact(100, scene.pr_head, scene.pr_head)


def _main_sha_malformed(scene: Scene) -> None:
    scene.env.artifact(100, "main", scene.pr_head)


_BREAKS = {
    "missing": _drop_artifact,
    "pr_head_differs": _artifact_of_other_head,
    "not_ancestor": _main_sha_not_ancestor,
    "malformed": _main_sha_malformed,
}


@allure.title(
    "artifact の検証（{param_id}）に失敗すると、理由として「{reason}」を出力し、pr_main を出力しない"
)
@pytest.mark.parametrize(
    ("broken", "reason"),
    [
        ("missing", "ci-base なし"),
        ("pr_head_differs", "pr_head 不一致"),
        ("not_ancestor", "main_sha が base の祖先でない"),
        ("malformed", "main_sha が base の祖先でない"),
    ],
    ids=["missing", "pr_head_differs", "not_ancestor", "malformed"],
)
def test_bad_artifact_gives_reason(scene: Scene, broken: str, reason: str) -> None:
    """`ci-base.txt` が存在しない場合や、`pr_head` が異なる場合など、検証に失敗する場合のテストです。標準出力は空で、標準エラーにそれぞれの理由を出力することを確認します。"""
    with allure.step("読めない artifact を用意して動かす"):
        scene.good_run()
        _BREAKS[broken](scene)
    with allure.step("読めない理由ごとの文言が出ることを確かめる"):
        assert scene.go() == ("", f"reason={reason}")


@allure.title("{missing} が空だと、入力の不足の理由を出力する")
@pytest.mark.parametrize("missing", ["REPO", "QUEUE_BASE", "QUEUE_HEAD"])
def test_missing_input(scene: Scene, missing: str) -> None:
    """`REPO`・`QUEUE_BASE`・`QUEUE_HEAD` のいずれかを空にして実行するテストです。標準出力は空で、標準エラーに `reason=入力の不足` を出力することを確認します。"""
    with allure.step("入力の 1 つを空にして動かす"):
        scene.good_run()
        args = {"REPO": REPO, "QUEUE_BASE": scene.base, "QUEUE_HEAD": scene.q_head}
        args[missing] = ""
        out = scene.env.go(scene.ref, args["QUEUE_BASE"], args["QUEUE_HEAD"], repo=args["REPO"])
    with allure.step("理由が「入力の不足」であることを確かめる"):
        assert out == ("", "reason=入力の不足")


@allure.title("queue のコミットの親が base と異なると、その理由を出力する")
def test_queue_head_parent_is_not_queue_base(scene: Scene) -> None:
    """queue の head のコミットの親が、`QUEUE_BASE` と異なる場合のテストです。標準出力は空で、標準エラーに `reason=queue の commit の親が base でない` を出力することを確認します。"""
    with allure.step("queue の commit の親が base と違う状態で動かす"):
        scene.good_run()
        out = scene.env.go(scene.ref, scene.m0, scene.q_head)
    with allure.step("理由が「queue の commit の親が base でない」であることを確かめる"):
        assert out == ("", "reason=queue の commit の親が base でない")


@allure.title("base と PR の head のマージが衝突すると、merge-tree の失敗の理由を出力する")
def test_merge_tree_conflict(env: Env) -> None:
    """base と PR の head が、同じファイルを別の内容に変更していて、マージが衝突する場合のテストです。標準出力は空で、標準エラーに `merge-tree が失敗` の理由を出力することを確認します。"""
    with allure.step("merge-tree が衝突する git のリポを用意して動かす"):
        env.git("checkout", "-q", "-b", "main")
        m0 = env.commit("f.txt", "m0")
        base = env.commit("f.txt", "main side")
        pr_head = env.commit("f.txt", "pr side", parent=m0)
        q_head = env.commit("g.txt", "x", parent=base)
        env.pull(7, pr_head)
        env.runs(pr_head, (100, "2026-11-01T00:00:00Z"))
        env.artifact(100, m0, pr_head)
        ref = f"gh-readonly-queue/main/pr-7-{base}"
    with allure.step("理由が merge-tree の失敗であることを確かめる"):
        assert env.go(ref, base, q_head) == (
            "",
            "reason=merge-tree が失敗（衝突または commit なし）",
        )


@allure.title(
    "base と PR の head をマージした tree が queue の head と異なると、tree 不一致の理由を出力する"
)
def test_tree_differs_from_queue_head(env: Env) -> None:
    """マージした tree が、queue の head のコミットの tree と異なる場合のテストです。標準出力は空で、標準エラーに `reason=tree 不一致` を出力することを確認します。"""
    with allure.step("tree が queue の commit と違う git のリポを用意して動かす"):
        env.git("checkout", "-q", "-b", "main")
        m0 = env.commit("a.txt", "a")
        base = env.commit("b.txt", "b")
        pr_head = env.commit("pr.txt", "pr", parent=m0)
        q_head = env.commit("pr.txt", "different", parent=base)
        env.pull(7, pr_head)
        env.runs(pr_head, (100, "2026-11-01T00:00:00Z"))
        env.artifact(100, m0, pr_head)
        ref = f"gh-readonly-queue/main/pr-7-{base}"
    with allure.step("理由が「tree 不一致」であることを確かめる"):
        assert env.go(ref, base, q_head) == ("", "reason=tree 不一致")


@allure.title("PR の head のコミットがローカルに存在しないと、merge-tree の失敗の理由を出力する")
def test_pr_head_commit_missing_locally(scene: Scene) -> None:
    """PR の head の sha が、ローカルのリポジトリに存在しないコミットの場合のテストです。標準出力は空で、標準エラーに `merge-tree が失敗` の理由を出力することを確認します。"""
    with allure.step("手元に無い PR の head を指して動かす"):
        scene.env.pull(7, "9" * 40)
        out = scene.go()
    with allure.step("理由が merge-tree の失敗であることを確かめる"):
        assert out == ("", "reason=merge-tree が失敗（衝突または commit なし）")


@allure.title("fork の PR だと、fork の PR の理由を出力する")
def test_fork_pr(scene: Scene) -> None:
    """PR の head が別のリポジトリ（`evil/r`）の場合のテストです。標準出力は空で、標準エラーに `reason=fork の PR` を出力することを確認します。"""
    with allure.step("フォークの PR を用意して動かす"):
        scene.env.pull(7, scene.pr_head, head_repo="evil/r")
    with allure.step("理由が「fork の PR」であることを確かめる"):
        assert scene.go() == ("", "reason=fork の PR")


@allure.title("HEAD_REF から PR 番号を取り出せないと、PR 番号不明の理由を出力する")
def test_unparsable_head_ref(scene: Scene) -> None:
    """`HEAD_REF` が `refs/heads/other` のように、`gh-readonly-queue` の形ではない場合のテストです。標準出力は空で、標準エラーに `reason=PR 番号不明` を出力することを確認します。"""
    with allure.step("読めない head の ref で動かす"):
        out = scene.env.go("refs/heads/other", scene.base, scene.q_head)
    with allure.step("理由が「PR 番号不明」であることを確かめる"):
        assert out == ("", "reason=PR 番号不明")


@allure.title("PR の API が失敗すると、取得の失敗の理由を出力する")
def test_pull_api_failure(scene: Scene) -> None:
    """PR の情報を取得する API が失敗する場合のテストです。標準出力は空で、標準エラーに `reason=取得の失敗` を出力することを確認します。"""
    with allure.step("PR を取る API の応答を消して動かす"):
        (scene.env.fake / "repos_o_r_pulls_7").unlink()
    with allure.step("理由が「取得の失敗」であることを確かめる"):
        assert scene.go() == ("", "reason=取得の失敗")
