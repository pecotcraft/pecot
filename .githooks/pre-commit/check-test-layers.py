#!/usr/bin/env python3
"""テストのファイルごとに、project の test-layers.txt で層が 1 つに決まるかを確かめる。

決まりは .claude/rules/test-conventions.md の「テストの層」。--root を渡すと、そのリポを見る。
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

CONVENTION = ".claude/rules/test-conventions.md"
TABLE = "test-layers.txt"
LAYERS = ("unit", "integration", "e2e")


@dataclass(frozen=True)
class Rule:
    layer: str
    path: str
    line: int


def is_test_file(path: str) -> bool:
    name = PurePosixPath(path).name
    if name.endswith((".test.ts", ".test.mjs", ".bats")):
        return True
    return name.startswith("test_") and name.endswith(".py")


def project_of(path: str, projects: set[str]) -> str | None:
    for parent in PurePosixPath(path).parents:
        if str(parent) in projects:
            return str(parent)
    return None


def parse_table(text: str, where: str) -> tuple[list[Rule], list[str]]:
    rules: list[Rule] = []
    problems: list[str] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        if len(fields) != 2:
            problems.append(f"{where}:{number}: 「<層> <パス>」の 2 つに分かれていない")
            continue
        layer, path = fields
        if layer not in LAYERS:
            problems.append(f"{where}:{number}: 層 '{layer}' は {'・'.join(LAYERS)} のどれでもない")
            continue
        rules.append(Rule(layer, path, number))
    return rules, problems


def matching(rules: list[Rule], relative: str) -> Rule | None:
    hits = [
        rule
        for rule in rules
        if relative == rule.path or (rule.path.endswith("/") and relative.startswith(rule.path))
    ]
    return max(hits, key=lambda rule: len(rule.path), default=None)


def problems(root: Path) -> list[str]:
    tracked = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True, text=True
    ).stdout.split("\0")
    tracked = [path for path in tracked if path and (root / path).is_file()]
    projects = {
        str(PurePosixPath(path).parent)
        for path in tracked
        if PurePosixPath(path).name == "project.json"
    }
    projects.discard(".")
    found: list[str] = []
    tables: dict[str, list[Rule]] = {}
    for project in sorted(projects):
        table = root / project / TABLE
        if table.is_file():
            where = f"{project}/{TABLE}"
            tables[project], wrong = parse_table(table.read_text(encoding="utf-8"), where)
            found.extend(wrong)
    used: set[tuple[str, int]] = set()
    for path in tracked:
        if not is_test_file(path):
            continue
        project = project_of(path, projects)
        if project is None:
            continue
        rule = matching(tables.get(project, []), str(PurePosixPath(path).relative_to(project)))
        if rule is None:
            found.append(f"{path}: 層が決まっていない")
        else:
            used.add((project, rule.line))
    for project, rules in tables.items():
        found.extend(
            f"{project}/{TABLE}:{rule.line}: '{rule.path}' に当たるテストのファイルが無い"
            for rule in rules
            if (project, rule.line) not in used
        )
    return found


def main(arguments: list[str]) -> int:
    root = Path(arguments[1]) if arguments[:1] == ["--root"] else Path.cwd()
    found = problems(root)
    for line in found:
        print(line, file=sys.stderr)
    if found:
        print(f"\nテストのファイルの層を {TABLE} で決めてください（{CONVENTION}）", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
