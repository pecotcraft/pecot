"""各レーンの JUnit を側の artifact の置き場所へ写し、job summary の markdown を出す。

--ran が無いときは作業ツリーの JUnit を集める（pages-build.yml）。
--ran があるときは、ci が動かしたレーンを --ci-dir から、ほかを開発版の --dev-dir/junit から取る。
取った JUnit は作業ツリーにも写す。
今は呼ぶ workflow が無い（#648）。片付けは #645。
JUnit が無いか読めないレーンがあれば、その名前を標準エラーに出して 1 で終わる。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import cast

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


def ran_lanes(raw: str) -> set[str]:
    """ci の needs.lanes.outputs.lanes（lane を持つ要素の配列）からレーンの名前。空の文字列は 0 本。"""
    loaded: object = json.loads(raw) if raw.strip() else []
    if not isinstance(loaded, list):
        raise ValueError("--ran は JSON の配列です")
    names: set[str] = set()
    for item in cast("list[object]", loaded):
        lane = cast("dict[str, object]", item).get("lane") if isinstance(item, dict) else None
        if not isinstance(lane, str):
            raise ValueError(f"--ran の要素に lane がありません: {json.dumps(item)}")
        names.add(lane)
    return names


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--side", required=True)
    parser.add_argument("--pr", default="")
    parser.add_argument("--sha", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--lanes", type=Path, default=DEFAULT_LANES)
    parser.add_argument("--root", type=Path, default=_REPO)
    parser.add_argument("--ran")
    parser.add_argument("--ci-dir", type=Path)
    parser.add_argument("--dev-dir", type=Path)
    parser.add_argument("--dev-sha", default="")
    args = parser.parse_args(argv[1:])
    if args.ran is not None and (args.ci_dir is None or args.dev_dir is None):
        parser.error("--ran には --ci-dir と --dev-dir が要ります")

    try:
        ran = ran_lanes(args.ran) if args.ran is not None else None
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    dev_label = f"開発版 {args.dev_sha[:7]}".rstrip()

    rows: list[str] = []
    missing: list[str] = []
    for job in matrix(json.loads(args.lanes.read_text(encoding="utf-8"))):
        lane, junit = job["lane"], job["junit"]
        if ran is None:
            source, origin, absent = args.root / junit, "この run", "JUnit 無し"
        elif lane in ran:
            # 落ちたレーンを開発版の合格で隠さないため、ci が動かしたレーンは埋めない。
            source, origin, absent = args.ci_dir / junit, "この PR の ci", "ci の JUnit 無し"
        else:
            source, origin, absent = (
                args.dev_dir / "junit" / junit,
                dev_label,
                "開発版にこのレーンの JUnit 無し",
            )
        if not source.is_file():
            missing.append(lane)
            rows.append(f"| {lane} | {absent} |")
            continue
        try:
            c = count(source)
        except ET.ParseError:
            missing.append(lane)
            rows.append(f"| {lane} | JUnit を読めない |")
            continue
        targets = [args.out / "junit" / junit]
        if ran is not None:
            targets.append(args.root / junit)
        for target in targets:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        rows.append(
            f"| {lane} | {c['tests']} | {c['passed']} | {c['failure']} | {c['error']} | {c['skipped']} | {origin} |"
        )

    print("## 側を作る run")
    print()
    print(f"- 側: {_side_label(args.side, args.pr)}")
    print(f"- コミット: `{args.sha}`")
    print()
    print("| レーン | tests | passed | failures | errors | skipped | 出どころ |")
    print("|---|---|---|---|---|---|---|")
    print("\n".join(rows))
    if missing:
        print(f"ERROR: JUnit がそろわないレーン: {', '.join(missing)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
