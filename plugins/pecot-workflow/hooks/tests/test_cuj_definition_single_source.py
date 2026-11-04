"""CUJ 定義段落が配布物 2 箇所で同一であることを固定するテスト（#1091）。

定義の複製先は 2 箇所。

- plan テンプレ `plugins/pecot-workflow/cli/templates/comment/plan.md`
- `plugins/pecot-workflow/agents/w-e2e-planner.md`

1 箇所だけ変えると、計画の CUJ 書式と w-e2e-planner の差し戻し基準がずれる。
すると、レビューで落とすべき項目が計画へ残る。2 つの `CUJ = ` 段落の完全一致をここで固定する。
"""

from __future__ import annotations

from pathlib import Path

_SOURCES = (
    "plugins/pecot-workflow/cli/templates/comment/plan.md",
    "plugins/pecot-workflow/agents/w-e2e-planner.md",
)


def _extract_definition(path: Path) -> str:
    """`CUJ = ` で始まる行から次の空行の手前までを 1 段落として返す。"""
    lines = path.read_text(encoding="utf-8").split("\n")
    for index, line in enumerate(lines):
        if line.startswith("CUJ = "):
            paragraph: list[str] = []
            for body_line in lines[index:]:
                if not body_line.strip():
                    break
                paragraph.append(body_line)
            return "\n".join(paragraph)
    raise AssertionError(f"`CUJ = ` で始まる定義段落が見つからない: {path}")


def test_cuj_definition_is_single_source(project_root: Path) -> None:
    definitions: dict[str, str] = {}
    for rel in _SOURCES:
        path = project_root / rel
        assert path.exists(), f"定義の複製先が移動している: {rel}"
        definitions[rel] = _extract_definition(path)

    assert len(set(definitions.values())) == 1, (
        "CUJ 定義段落が 2 箇所で一致していない:\n"
        + "\n".join(f"--- {rel} ---\n{text}" for rel, text in definitions.items())
    )
