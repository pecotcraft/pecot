"""report-lanes.json から、Allure の結果を残すレーンごとの GitHub Actions の matrix（1 行の JSON）を出す。

引数で report-lanes.json のパスを渡せる。
nx の target との突き合わせと outputs の確かめは、.githooks/tests/test_report_lanes.py が行う。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import cast

DEFAULT_LANES = Path(__file__).resolve().parent / "report-lanes.json"


def slug_of(lane: str) -> str:
    # .githooks/ci/list-test-lanes.sh の slug と同じ作り方。artifact の名前に使う。
    return re.sub(r"[^A-Za-z0-9._-]", "-", lane)


def matrix(lanes: object) -> list[dict[str, str]]:
    if not isinstance(lanes, list):
        raise ValueError("report-lanes.json: レーンの配列ではありません")
    jobs: list[dict[str, str]] = []
    for i, item in enumerate(cast("list[object]", lanes), start=1):
        if not isinstance(item, dict):
            raise ValueError(f"report-lanes.json #{i}: レーンがオブジェクトではありません")
        entry = cast("dict[str, object]", item)
        project, target = entry.get("project"), entry.get("target")
        if not isinstance(project, str) or not isinstance(target, str):
            raise ValueError(f"report-lanes.json #{i}: project と target の文字列が要ります")
        results, excluded = entry.get("results"), entry.get("excluded")
        if (results is None) == (excluded is None):
            raise ValueError(
                f"report-lanes.json #{i}: results と excluded のどちらか一方だけが要ります"
            )
        if excluded is not None:
            if not isinstance(excluded, str):
                raise ValueError(f"report-lanes.json #{i}: excluded は文字列にします")
            continue
        if not isinstance(results, str):
            raise ValueError(f"report-lanes.json #{i}: results は文字列にします")
        lane = f"{project}:{target}"
        jobs.append({"lane": lane, "slug": slug_of(lane), "results": results})
    seen: dict[str, str] = {}
    for job in jobs:
        if job["slug"] in seen:
            raise ValueError(
                f"report-lanes.json: slug {job['slug']} が {seen[job['slug']]} と {job['lane']} で重なります"
            )
        seen[job["slug"]] = job["lane"]
    return sorted(jobs, key=lambda job: job["lane"])


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else DEFAULT_LANES
    try:
        jobs = matrix(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(json.dumps(jobs, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
