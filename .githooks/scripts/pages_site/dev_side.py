"""保管中の開発版の run_id と sha を GITHUB_OUTPUT に書く。今は呼ぶ workflow が無い（#648）。片付けは #645。

開発版の run の artifact pages-side-dev の JUnit で、PR が動かさなかったレーンを埋めるためのもの。
"""

from __future__ import annotations

import argparse
import os
import re
import sys

from verify import Api, gh_api, stored_dev

REBUILD = "gh workflow run pages-build.yml --ref main -f side=dev"


def find(api: Api, repo: str) -> tuple[str, str] | None:
    """(run_id, sha)。記録が無いか形が合わなければ None。"""
    dev = stored_dev(api, repo)
    if dev.run_id is None or dev.sha is None:
        return None
    # 値は GITHUB_OUTPUT と download-artifact の run-id に渡すので、形を確かめてから出す。
    if not re.fullmatch(r"[0-9]+", dev.run_id) or not re.fullmatch(r"[0-9a-f]{40}", dev.sha):
        return None
    return dev.run_id, dev.sha


def main(argv: list[str], api: Api = gh_api) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    args = parser.parse_args(argv[1:])

    found = find(api, args.repo)
    if found is None:
        print(
            f"ERROR: pages-store に開発版の記録（run_id と sha）がありません。`{REBUILD}` で作ってください",
            file=sys.stderr,
        )
        return 1
    run_id, sha = found
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as f:
            f.write(f"run_id={run_id}\nsha={sha}\n")
    print(f"開発版: run {run_id}・コミット {sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
