"""作業ツリーの各レーンの JUnit を側の artifact の置き場所へ写し、job summary の markdown を出す。

JUnit が無いか読めないレーンがあれば、その名前を標準エラーに出して 1 で終わる。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from lanes import DEFAULT_LANES, matrix

_REPO = Path(__file__).resolve().parents[3]
# サイトの iface_defs.py の _RESULT_ELEMENT と同じ区分で数える。
_KINDS = ("failure", "error", "skipped")
_LABELS = {"release": "リリース版", "dev": "開発版"}


def count(path: Path) -> dict[str, int]:
    counts = {"tests": 0, "passed": 0, "failure": 0, "error": 0, "skipped": 0}
    for case in ET.parse(path).getroot().iter("testcase"):
        counts["tests"] += 1
        kind = next((k for k in _KINDS if case.find(k) is not None), None)
        counts[kind or "passed"] += 1
    return counts


def _side_label(side: str, pr: str) -> str:
    return f"PR #{pr}" if side == "pr" else _LABELS.get(side, side)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--side", required=True)
    parser.add_argument("--pr", default="")
    parser.add_argument("--sha", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--lanes", type=Path, default=DEFAULT_LANES)
    parser.add_argument("--root", type=Path, default=_REPO)
    args = parser.parse_args(argv[1:])

    rows: list[str] = []
    missing: list[str] = []
    for job in matrix(json.loads(args.lanes.read_text(encoding="utf-8"))):
        source = args.root / job["junit"]
        if not source.is_file():
            missing.append(job["lane"])
            rows.append(f"| {job['lane']} | JUnit 無し |")
            continue
        try:
            c = count(source)
        except ET.ParseError:
            missing.append(job["lane"])
            rows.append(f"| {job['lane']} | JUnit を読めない |")
            continue
        target = args.out / "junit" / job["junit"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        rows.append(
            f"| {job['lane']} | {c['tests']} | {c['passed']} | {c['failure']} | {c['error']} | {c['skipped']} |"
        )

    print("## 側を作る run")
    print()
    print(f"- 側: {_side_label(args.side, args.pr)}")
    print(f"- コミット: `{args.sha}`")
    print()
    print("| レーン | tests | passed | failures | errors | skipped |")
    print("|---|---|---|---|---|---|")
    print("\n".join(rows))
    if missing:
        print(f"ERROR: JUnit がそろわないレーン: {', '.join(missing)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
