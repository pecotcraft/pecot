"""junit-lanes.json から、合否のレーンごとの GitHub Actions の matrix（1 行の JSON）を出す。

引数で junit-lanes.json のパスを渡せる。
outputs に junit があるかは、iface_defs.py の load_junit_lanes が確かめる。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import cast

DEFAULT_LANES = Path(__file__).resolve().parents[3] / "libs/interface-spec/docs/junit-lanes.json"


def slug_of(lane: str) -> str:
    # .githooks/ci/list-test-lanes.sh の slug と同じ作り方。artifact の名前に使う。
    return re.sub(r"[^A-Za-z0-9._-]", "-", lane)


def matrix(lanes: object) -> list[dict[str, str]]:
    if not isinstance(lanes, list):
        raise ValueError("junit-lanes.json: レーンの配列ではありません")
    jobs: list[dict[str, str]] = []
    for i, item in enumerate(cast("list[object]", lanes), start=1):
        if not isinstance(item, dict):
            raise ValueError(f"junit-lanes.json #{i}: レーンがオブジェクトではありません")
        entry = cast("dict[str, object]", item)
        target, junit = entry.get("target"), entry.get("junit")
        if not isinstance(target, str) or not isinstance(junit, str):
            raise ValueError(f"junit-lanes.json #{i}: target と junit の文字列が要ります")
        jobs.append({"lane": target, "slug": slug_of(target), "junit": junit})
    seen: dict[str, str] = {}
    for job in jobs:
        if job["slug"] in seen:
            raise ValueError(
                f"junit-lanes.json: slug {job['slug']} が {seen[job['slug']]} と {job['lane']} で重なります"
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
