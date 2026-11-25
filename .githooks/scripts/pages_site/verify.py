"""pages-deploy.yml の verify の job。workflow_run で受けた run を API で読み直して側を決め、artifact を確かめる。

判定は provenance.py、tar の確かめは store.py（定義書は side_check、レポートは report_check）が持つ。
リリース版の材料の求め直しは release_sources.py が持つ。ここは API と git を呼んで、それらに渡すだけにする。
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
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from provenance import Verdict, decide, open_prs, pr_candidates, run_kind
from store import REPORT_SIDES, report_check, side_check

_HERE = Path(__file__).resolve().parent
STORE_BRANCH = "pages-store"

Api = Callable[[str], object | None]


@dataclass(frozen=True)
class StoredDev:
    run_id: str | None
    sha: str | None


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


def stored_dev(api: Api, repo: str, kind: str) -> StoredDev:
    """pages-store の .pecot-store.json の開発版の記録（定義書は dev、レポートは reports.dev）。無い値は None。"""
    content = _dict(api(f"repos/{repo}/contents/.pecot-store.json?ref={STORE_BRANCH}"))
    raw = content.get("content")
    if not isinstance(raw, str):
        return StoredDev(run_id=None, sha=None)
    meta = _dict(json.loads(base64.b64decode(raw)))
    dev = _dict((_dict(meta.get("reports")) if kind == "report" else meta).get("dev"))
    run_id, sha = dev.get("run_id"), dev.get("sha")
    # store.py は run_id を文字列で書くが、数で書かれていても読む。
    if isinstance(run_id, int) and not isinstance(run_id, bool):
        run_id = str(run_id)
    return StoredDev(
        run_id=run_id if isinstance(run_id, str) else None,
        sha=sha if isinstance(sha, str) else None,
    )


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
    kind = run_kind(run)
    stored = None if pull_event or kind is None else stored_dev(api, repo, kind).sha
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


def report_record(main_ref: str) -> dict[str, object]:
    """リリース版のレポートの材料（report-sources.json の形）を、タグと main から求め直す。"""
    done = subprocess.run(
        [
            sys.executable,
            str(_HERE / "release_sources.py"),
            "--report",
            "release",
            "--main",
            main_ref,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip())
    return _dict(_dict(json.loads(done.stdout)).get("sources"))


def download(repo: str, run_id: str, artifact: str, dest: Path) -> None:
    subprocess.run(
        ["gh", "run", "download", run_id, "--repo", repo, "--name", artifact, "--dir", str(dest)],
        check=True,
    )


_FILES = {
    "site": ("site.tar", "release-sources.json"),
    "report": ("report.tar", "report-sources.json"),
}
_KIND_LABELS = {"site": "定義書", "report": "レポート"}


def check_side(
    verdict: Verdict, raw: Path, main_ref: str, record: Callable[[str], dict[str, object]]
) -> list[str]:
    """artifact を確かめる。record は、その種類のリリース版の材料を求め直す関数。"""
    kind = verdict.kind or "site"
    tar_name, sources_name = _FILES[kind]
    tar = raw / tar_name
    if not tar.is_file():
        return [f"artifact に {tar_name} がありません"]
    if kind == "report":
        problems = report_check(tar)
    else:
        problems = side_check(tar, report_links=verdict.side in REPORT_SIDES)
    if verdict.side == "release":
        sources = raw / sources_name
        if not sources.is_file():
            problems.append(f"artifact に {sources_name} がありません")
        elif json.loads(sources.read_text(encoding="utf-8")) != record(main_ref):
            problems.append(f"{sources_name} が、タグと main から求め直した値と一致しません")
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
    if side is not None and verdict.artifact is not None:
        raw = args.out.parent / "pages-raw"
        shutil.rmtree(raw, ignore_errors=True)
        download(args.repo, args.run_id, verdict.artifact, raw)
        record = report_record if verdict.kind == "report" else release_record
        problems = check_side(verdict, raw, args.main_ref, record)
        if problems:
            side, reason = None, "側の中身を捨てた: " + " / ".join(problems)
        else:
            args.out.mkdir(parents=True, exist_ok=True)
            for name in (name for names in _FILES.values() for name in names):
                if (raw / name).is_file():
                    shutil.copyfile(raw / name, args.out / name)

    kind = (verdict.kind or "") if side else ""
    outputs = {
        "side": side or "",
        "kind": kind,
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
    print(f"- 種類: {_KIND_LABELS.get(verdict.kind or '', '-')}")
    print(f"- コミット: `{verdict.head_sha or '-'}`")
    print(f"- 理由: {reason}")
    print(f"- 開いている PR: {', '.join(f'#{n}' for n in opened) or 'なし'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
