"""pages-deploy.yml の verify の job。workflow_run で受けた run を API で読み直して側を決め、artifact を確かめる。

判定は provenance.py、tar の確かめは store.side_check、リリース版の求め直しは release_sources.py が持つ。
ここは API と git を呼んで、それらに渡すだけにする。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import cast

from provenance import Verdict, decide, open_prs, pr_candidates
from store import side_check

_HERE = Path(__file__).resolve().parent
STORE_BRANCH = "pages-store"
PHASE5 = "PR 版の保管は Phase 5 から（#590）。この run の側は保管しない"

Api = Callable[[str], object | None]


def gh_api(path: str) -> object | None:
    """gh api の JSON。404 は None。"""
    done = subprocess.run(["gh", "api", path], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        if "HTTP 404" in done.stderr:
            return None
        raise RuntimeError(f"gh api {path}: {done.stderr.strip()}")
    return json.loads(done.stdout)


def _dict(value: object) -> dict[str, object]:
    return cast("dict[str, object]", value) if isinstance(value, dict) else {}


def _list(value: object) -> list[object]:
    return cast("list[object]", value) if isinstance(value, list) else []


def stored_dev_sha(api: Api, repo: str) -> str | None:
    content = _dict(api(f"repos/{repo}/contents/.pecot-store.json?ref={STORE_BRANCH}"))
    raw = content.get("content")
    if not isinstance(raw, str):
        return None
    record = _dict(json.loads(base64.b64decode(raw)))
    sha = _dict(record.get("dev")).get("sha")
    return sha if isinstance(sha, str) else None


def judge(api: Api, repo: str, run_id: str) -> tuple[Verdict, list[int]]:
    run = _dict(api(f"repos/{repo}/actions/runs/{run_id}"))
    head = run.get("head_sha")
    head_sha = head if isinstance(head, str) else ""
    pull_event = run.get("event") == "pull_request"
    head_vs_main = (
        None if pull_event or not head_sha else api(f"repos/{repo}/compare/{head_sha}...main")
    )
    names = [
        n
        for a in _list(
            _dict(api(f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100")).get(
                "artifacts"
            )
        )
        if isinstance(n := _dict(a).get("name"), str)
    ]
    stored = None if pull_event else stored_dev_sha(api, repo)
    stored_vs_head = (
        api(f"repos/{repo}/compare/{stored}...{head_sha}") if stored and head_sha else None
    )
    pulls = {n: _dict(api(f"repos/{repo}/pulls/{n}")) for n in pr_candidates(run, repo)}
    verdict = decide(
        run,
        repo=repo,
        head_vs_main=_dict(head_vs_main) if head_vs_main is not None else None,
        artifact_names=names,
        stored_dev_sha=stored,
        stored_vs_head=_dict(stored_vs_head) if stored_vs_head is not None else None,
        pulls=pulls,
    )
    opened = open_prs(
        [_dict(p) for p in _list(api(f"repos/{repo}/pulls?state=open&per_page=100"))], repo
    )
    return verdict, opened


def release_record(main_ref: str) -> dict[str, object]:
    done = subprocess.run(
        [sys.executable, str(_HERE / "release_sources.py"), "--main", main_ref],
        capture_output=True,
        text=True,
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip())
    full = _dict(json.loads(done.stdout))
    return {k: full.get(k) for k in ("tags", "commits", "skeleton")}


def download(repo: str, run_id: str, artifact: str, dest: Path) -> None:
    subprocess.run(
        ["gh", "run", "download", run_id, "--repo", repo, "--name", artifact, "--dir", str(dest)],
        check=True,
    )


def check_side(
    verdict: Verdict, raw: Path, main_ref: str, record: Callable[[str], dict[str, object]]
) -> list[str]:
    tar = raw / "site.tar"
    if not tar.is_file():
        return ["artifact に site.tar がありません"]
    problems = side_check(tar)
    if verdict.side == "release":
        sources = raw / "release-sources.json"
        if not sources.is_file():
            problems.append("artifact に release-sources.json がありません")
        elif json.loads(sources.read_text(encoding="utf-8")) != record(main_ref):
            problems.append("release-sources.json が、タグと main から求め直した値と一致しません")
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--main-ref", default="origin/main")
    args = parser.parse_args(argv[1:])

    verdict, opened = judge(gh_api, args.repo, args.run_id)
    side, reason = verdict.side, verdict.reason
    if side == "pr":
        side, reason = None, PHASE5
    if side is not None and verdict.artifact is not None:
        raw = args.out.parent / "pages-raw"
        shutil.rmtree(raw, ignore_errors=True)
        download(args.repo, args.run_id, verdict.artifact, raw)
        problems = check_side(verdict, raw, args.main_ref, release_record)
        if problems:
            side, reason = None, "側の中身を捨てた: " + " / ".join(problems)
        else:
            args.out.mkdir(parents=True, exist_ok=True)
            for name in ("site.tar", "release-sources.json"):
                if (raw / name).is_file():
                    shutil.copyfile(raw / name, args.out / name)

    outputs = {
        "side": side or "",
        "pr": str(verdict.pr or "") if side else "",
        "head_sha": (verdict.head_sha or "") if side else "",
        "open_prs": json.dumps(opened),
    }
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as f:
            f.writelines(f"{k}={v}\n" for k, v in outputs.items())
    print("## 受けた run の確かめ")
    print()
    print(f"- run: {args.run_id}")
    print(f"- 側: {side or '受けない'}")
    print(f"- コミット: `{verdict.head_sha or '-'}`")
    print(f"- 理由: {reason}")
    print(f"- 開いている PR: {', '.join(f'#{n}' for n in opened) or 'なし'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
