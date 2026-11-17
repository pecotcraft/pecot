"""sandbox-sweep.sh のユニットテスト。

偽の gh は、呼び出しの引数を 1 行ずつ記録する。読む呼び出しには、エンドポイントごとのフィクスチャを返す。
書き込みの有無と順は、その記録で見る。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

SANDBOX = "pecotcraft/pecot-sandbox"
REFS = f"repos/{SANDBOX}/git/matching-refs/heads/cuj/"
ISSUES = f"repos/{SANDBOX}/issues?state=open&per_page=100"
RELEASES = f"repos/{SANDBOX}/releases?per_page=100"

# 記録は 1 呼び出し 1 行（引数を空白でつなぐ）。FAKE_GH_FAIL の部分文字列を含む呼び出しは失敗する。
# 読む呼び出し（-X の無い api）は、エンドポイントの記号を _ に替えた名前のフィクスチャを返す。
_FAKE_GH = """#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_GH_DIR/calls"
if [ -n "${FAKE_GH_FAIL:-}" ] && [[ "$*" == *"$FAKE_GH_FAIL"* ]]; then
    echo "HTTP 422: Reference does not exist" >&2
    exit 1
fi
[ "$1" = "api" ] || exit 0
shift
endpoint=""; method=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -X) method="$2"; shift 2 ;;
        -f|-F|-H) shift 2 ;;
        -*) shift ;;
        *) [ -z "$endpoint" ] && endpoint="$1"; shift ;;
    esac
done
[ -n "$method" ] && exit 0
f="$FAKE_GH_DIR/${endpoint//[^A-Za-z0-9]/_}"
[ -f "$f" ] || { echo "HTTP 404: Not Found ($endpoint)" >&2; exit 1; }
cat "$f"
"""


def ref(name: str) -> dict:
    return {"ref": f"refs/heads/{name}", "object": {"sha": "0" * 40}}


def issue(number: int, title: str, pr: bool = False) -> dict:
    body: dict = {"number": number, "title": title}
    if pr:
        body["pull_request"] = {"url": f"https://api.github.com/repos/{SANDBOX}/pulls/{number}"}
    return body


def card(item_id: str, number: int, title: str, archived: bool = False) -> dict:
    return {
        "id": item_id,
        "isArchived": archived,
        "content": {
            "__typename": "Issue",
            "number": number,
            "title": title,
            "repository": {"nameWithOwner": SANDBOX},
        },
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
        self.cwd = tmp_path
        self.script = script
        self.fail = ""
        # 何も無い状態を既定にする。
        self.refs()
        self.issues()
        self.cards()
        self.releases()

    def _put(self, endpoint: str, pages: list[object]) -> None:
        # --paginate の出力は、ページごとの JSON を続けて並べた形になる。
        text = "\n".join(json.dumps(p) for p in pages)
        (self.fake / re.sub(r"[^A-Za-z0-9]", "_", endpoint)).write_text(text)

    def refs(self, *names: str) -> None:
        self._put(REFS, [[ref(n) for n in names]])

    def issues(self, *pages: list[dict]) -> None:
        self._put(ISSUES, list(pages) or [[]])

    def cards(self, *pages: list[dict]) -> None:
        self._put(
            "graphql",
            [
                {"data": {"organization": {"projectV2": {"items": {"nodes": p}}}}}
                for p in (pages or ([],))
            ],
        )

    def releases(self, *tags: str) -> None:
        self._put(RELEASES, [[{"tag_name": t, "name": t} for t in tags]])

    def run(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FAKE_GH_DIR": str(self.fake),
            "FAKE_GH_FAIL": self.fail,
        }
        calls = self.fake / "calls"
        calls.unlink(missing_ok=True)
        return subprocess.run(
            [str(self.script), *args], env=env, cwd=self.cwd, capture_output=True, text=True
        )

    def calls(self) -> list[str]:
        path = self.fake / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def writes(self) -> list[str]:
        return [c for c in self.calls() if not _is_read(c)]


def _is_read(call: str) -> bool:
    return call.startswith("api ") and " -X " not in f" {call} "


@pytest.fixture
def env(tmp_path: Path, githooks_dir: Path) -> Env:
    return Env(tmp_path, githooks_dir / "scripts" / "sandbox-sweep.sh")


def _full_scene(env: Env) -> None:
    """456 の PR・ブランチ・Issue・カード・リリースと、形に合わないもの、457 のもの。"""
    env.refs("cuj/456-ab12", "cuj/456-ab12/7", "cuj/457-cd34", "cuj/4560-ab12", "cuj/notes")
    env.issues(
        [
            issue(11, "[Task] [cuj 456-ab12] 1 行直す"),
            issue(12, "[cuj 456-ab12] 1 行直す", pr=True),
            issue(13, "[Task] [cuj 457-cd34] 別の確かめ"),
            issue(14, "ci.yml を直す", pr=True),
            issue(15, "[Task] [cuj 4560-ab12] 番号が長い"),
        ]
    )
    env.cards(
        [
            card("PVTI_11", 11, "[Task] [cuj 456-ab12] 1 行直す"),
            card("PVTI_14", 14, "ci.yml を直す"),
        ]
    )
    env.releases("cuj/456-ab12-tgz", "v1.0.0")


# 契約の 6 つの場合


def test_sweeps_matching_pr_branch_issue(env: Env) -> None:
    env.refs("cuj/456-ab12")
    env.issues([issue(11, "[Task] [cuj 456-ab12] 直す"), issue(12, "[cuj 456-ab12] 直す", pr=True)])
    r = env.run()
    assert r.returncode == 0, r.stderr
    assert r.stdout.splitlines() == [
        "PR #12 [cuj 456-ab12] 直す",
        "ブランチ cuj/456-ab12",
        "Issue #11 [Task] [cuj 456-ab12] 直す",
    ]
    assert env.writes() == [
        f"pr close 12 -R {SANDBOX}",
        f"api -X DELETE repos/{SANDBOX}/git/refs/heads/cuj/456-ab12",
        f"issue close 11 -R {SANDBOX}",
    ]


def test_leaves_names_without_the_form(env: Env) -> None:
    env.refs("main", "cuj/notes", "fix/ci", "cuj/456-ab12", "cuj/456-ab12x", "cuj/456-AB12")
    env.issues(
        [
            issue(14, "ci.yml を直す", pr=True),
            issue(15, "[cuj 456] 乱数が無い"),
            issue(16, "[Task] [cuj 456-ab12] 直す"),
        ]
    )
    r = env.run()
    assert r.returncode == 0, r.stderr
    assert env.writes() == [
        f"api -X DELETE repos/{SANDBOX}/git/refs/heads/cuj/456-ab12",
        f"issue close 16 -R {SANDBOX}",
    ]


def test_issue_option_picks_only_that_number(env: Env) -> None:
    _full_scene(env)
    r = env.run("--issue", "456")
    assert r.returncode == 0, r.stderr
    joined = "\n".join(env.writes())
    assert "457" not in joined
    assert "4560" not in joined
    assert " 13 " not in f" {joined} "
    assert " 15 " not in f" {joined} "


def test_dry_run_lists_without_writing(env: Env) -> None:
    _full_scene(env)
    r = env.run("--dry-run", "--issue", "456")
    assert r.returncode == 0, r.stderr
    assert r.stdout.splitlines() == [
        "PR #12 [cuj 456-ab12] 1 行直す",
        "ブランチ cuj/456-ab12",
        "ブランチ cuj/456-ab12/7",
        "Issue #11 [Task] [cuj 456-ab12] 1 行直す",
        "カード #11 [Task] [cuj 456-ab12] 1 行直す",
        "リリース cuj/456-ab12-tgz",
        "--dry-run のため、6 件を書き換えていない",
    ]
    assert env.calls()
    assert env.writes() == []


def test_nothing_to_sweep(env: Env) -> None:
    env.refs("main")
    r = env.run()
    assert (r.returncode, r.stdout, r.stderr) == (0, "片付けるものは 0 件\n", "")
    assert env.writes() == []


def test_one_branch_delete_fails_and_rest_continue(env: Env) -> None:
    _full_scene(env)
    env.fail = "git/refs/heads/cuj/456-ab12/7"
    r = env.run("--issue", "456")
    assert r.returncode == 1
    assert r.stderr.splitlines() == [
        "error: ブランチ cuj/456-ab12/7 を消せない: HTTP 422: Reference does not exist"
    ]
    assert "ブランチ cuj/456-ab12/7" not in r.stdout.splitlines()
    assert env.writes() == [
        f"pr close 12 -R {SANDBOX}",
        f"api -X DELETE repos/{SANDBOX}/git/refs/heads/cuj/456-ab12",
        f"api -X DELETE repos/{SANDBOX}/git/refs/heads/cuj/456-ab12/7",
        f"issue close 11 -R {SANDBOX}",
        "project item-archive 3 --owner pecotcraft --id PVTI_11",
        f"release delete cuj/456-ab12-tgz --cleanup-tag --yes -R {SANDBOX}",
    ]


# 足した 5 つの場合


def test_deletes_release_and_tag(env: Env) -> None:
    env.releases("cuj/456-ab12-tgz", "cuj/457-cd34-tgz", "v1.0.0", "cuj/456-ab12")
    r = env.run("--issue", "456")
    assert r.returncode == 0, r.stderr
    assert r.stdout.splitlines() == ["リリース cuj/456-ab12-tgz"]
    assert env.writes() == [f"release delete cuj/456-ab12-tgz --cleanup-tag --yes -R {SANDBOX}"]


def test_finds_cuj_tag_in_middle_of_title(env: Env) -> None:
    env.issues([issue(21, "[Task] [cuj 456-ab12] 題の途中にある")])
    env.cards(
        [card("PVTI_20", 20, "[Task] [cuj 456-ab12] 閉じた Issue のカード")],
        [
            card("PVTI_21", 21, "[Task] [cuj 456-ab12] 題の途中にある"),
            card("PVTI_22", 22, "[Task] [cuj 456-ab12] アーカイブ済み", archived=True),
        ],
    )
    r = env.run()
    assert r.returncode == 0, r.stderr
    assert env.writes() == [
        f"issue close 21 -R {SANDBOX}",
        "project item-archive 3 --owner pecotcraft --id PVTI_20",
        "project item-archive 3 --owner pecotcraft --id PVTI_21",
    ]


def test_branch_with_session_suffix_and_number_boundary(env: Env) -> None:
    env.refs("cuj/456-ab12/7", "cuj/4560-ab12", "cuj/4560-ab12/9")
    r = env.run("--issue", "456")
    assert r.returncode == 0, r.stderr
    assert env.writes() == [f"api -X DELETE repos/{SANDBOX}/git/refs/heads/cuj/456-ab12/7"]
    # 引数なしなら、番号の長いものも形に合う。
    r = env.run()
    assert r.returncode == 0, r.stderr
    assert len(env.writes()) == 3


def test_every_call_names_the_sandbox(env: Env) -> None:
    _full_scene(env)
    r = env.run()
    assert r.returncode == 0, r.stderr
    calls = env.calls()
    reads = [c for c in calls if _is_read(c)]
    assert reads and all("--paginate" in c for c in reads)
    for c in calls:
        if c.startswith("project ") or c.startswith("api graphql "):
            assert "pecotcraft" in c and re.search(r"(^| )3( |$)|number=3", c), c
        else:
            assert f"-R {SANDBOX}" in c or f"repos/{SANDBOX}/" in c, c
    assert all("--delete-branch" not in c for c in calls)


def test_closes_pr_before_deleting_branch(env: Env) -> None:
    _full_scene(env)
    r = env.run()
    assert r.returncode == 0, r.stderr
    kinds = [c.split(" ")[0] if not c.startswith("api") else "branch" for c in env.writes()]
    order = ["pr", "branch", "issue", "project", "release"]
    assert kinds == sorted(kinds, key=order.index)
    assert kinds[0] == "pr"


# 引数と読めない場合


def test_second_run_after_sweep_is_zero(env: Env) -> None:
    """片付けた後の検証用（開いたものもアーカイブされていないカードも無い）では 0 件。"""
    env.refs("cuj/notes")
    env.cards([card("PVTI_11", 11, "[Task] [cuj 456-ab12] 1 行直す", archived=True)])
    r = env.run("--issue", "456")
    assert (r.returncode, r.stdout) == (0, "片付けるものは 0 件\n")


@pytest.mark.parametrize(
    "args",
    [
        ["--issue"],
        ["--issue", "45a"],
        ["--issue", "cuj/456"],
        ["--repo", "pecotcraft/pecot"],
        ["-R", "pecotcraft/pecot"],
        ["extra"],
    ],
)
def test_rejects_other_arguments(env: Env, args: list[str]) -> None:
    r = env.run(*args)
    assert r.returncode == 2
    assert r.stderr.startswith("error: ")
    assert env.calls() == []


def test_read_failure_stops_before_writing(env: Env) -> None:
    _full_scene(env)
    env.fail = "releases?per_page=100"
    r = env.run()
    assert r.returncode == 2
    assert r.stderr.splitlines()[0].startswith("error: リリースの一覧を読めない: ")
    assert env.writes() == []
