"""Compare two JUnit XML files by (classname, name) and report any differences."""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def _classify(tc: ET.Element) -> str:
    if tc.find("error") is not None:
        return "error"
    if tc.find("failure") is not None:
        return "failed"
    skipped = tc.find("skipped")
    if skipped is not None:
        kind = (skipped.get("type") or "").lower()
        if "xfail" in kind:
            return "xfailed"
        return "skipped"
    if (tc.get("status") or "").lower() == "xpassed":
        return "xpassed"
    return "passed"


def _load(path: Path) -> tuple[dict[tuple[str, str], str], int]:
    tree = ET.parse(path)
    root = tree.getroot()
    suites = root.findall("testsuite") if root.tag == "testsuites" else [root]
    cases: dict[tuple[str, str], str] = {}
    warnings = 0
    for suite in suites:
        warnings += int(suite.get("warnings") or 0)
        for tc in suite.findall("testcase"):
            key = (tc.get("classname") or "", tc.get("name") or "")
            cases[key] = _classify(tc)
    return cases, warnings


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: compare_junit.py <xml1> <xml2>", file=sys.stderr)
        return 2
    a, a_warn = _load(Path(argv[1]))
    b, b_warn = _load(Path(argv[2]))

    only_a = sorted(a.keys() - b.keys())
    only_b = sorted(b.keys() - a.keys())
    diff_result = sorted(k for k in a.keys() & b.keys() if a[k] != b[k])

    ok = not only_a and not only_b and not diff_result and a_warn == b_warn
    if ok:
        return 0

    if only_a:
        print(f"Testcases only in {argv[1]}:", file=sys.stderr)
        for k in only_a:
            print(f"  {k[0]}::{k[1]} [{a[k]}]", file=sys.stderr)
    if only_b:
        print(f"Testcases only in {argv[2]}:", file=sys.stderr)
        for k in only_b:
            print(f"  {k[0]}::{k[1]} [{b[k]}]", file=sys.stderr)
    if diff_result:
        print("Testcases with differing results:", file=sys.stderr)
        for k in diff_result:
            print(f"  {k[0]}::{k[1]}  pass1={a[k]}  pass2={b[k]}", file=sys.stderr)
    if a_warn != b_warn:
        print(f"Warnings count differs: pass1={a_warn} pass2={b_warn}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
