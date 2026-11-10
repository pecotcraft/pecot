"""Python の CLI の出力を fixture（JSON）に記録する。

テストが期待値に使う Python の出力を、文字を組み立てずに逐語で置くための記録である。
テキスト規則に当たる文字（絵文字・感嘆符・疑問符・長い文など）も、そのまま置ける。
このディレクトリは、テキスト規則の除外に入れてある。

各 fixture は、入力と Python の出力を持つ。入力は fixture に書き、出力はこのスクリプトが Python で作り直す。
ケースを足すときは、fixture に入力だけを足して、このスクリプトを書き込みモードで流す。

使い方（plugins/pecot-workflow で実行する）::

    cli/.venv/bin/python cli-node/tests/python-output/record.py          # 書き込み
    cli/.venv/bin/python cli-node/tests/python-output/record.py --check  # 差だけを出す（差があれば終了コード 1）
    cli/.venv/bin/python cli-node/tests/python-output/record.py frontmatter sections  # 名前を絞る
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parents[2]
sys.path.insert(0, str(PLUGIN_ROOT))

import httpx  # noqa: E402
from pydantic import BaseModel, ValidationError  # noqa: E402

from cli.core import sections as sections_module  # noqa: E402
from cli.core.config import ProjectConfig  # noqa: E402
from cli.core.frontmatter import (  # noqa: E402
    FrontmatterError,
    parse_comment_content,
    parse_frontmatter,
    parse_pr_content,
)
from cli.core.ref_parser import RefParseError, parse_issue_ref  # noqa: E402
from cli.core.repo_resolver import RepoRef  # noqa: E402
from cli.core.worktree_links import (  # noqa: E402
    DEFAULT_WORKTREEIGNORE_CONTENT,
    WorktreeConfig,
    get_default_config,
)

Json = Any


def dumps_config(config: BaseModel) -> str:
    """save_config と同じ形（indent=2・ensure_ascii=False・末尾の改行）"""
    text = json.dumps(config.model_dump(exclude_none=True), indent=2, ensure_ascii=False)
    return text + "\n"


def frontmatter_result(parse: Callable[[str], Any], yaml_text: str) -> Json:
    content = f"---\n{yaml_text}---\n\nbody\n"
    try:
        return {"ok": parse(content).frontmatter.model_dump(mode="json", exclude_none=True)}
    except FrontmatterError as error:
        return {"error": str(error)}


def record_frontmatter(data: Json) -> Json:
    parsers = {
        "issue": parse_frontmatter,
        "keyAndTag": parse_frontmatter,
        "comment": parse_comment_content,
        "pullRequest": parse_pr_content,
    }
    out: dict[str, Json] = {}
    for kind, parse in parsers.items():
        out[kind] = [
            [yaml_text, frontmatter_result(parse, yaml_text)] for yaml_text, _ in data[kind]
        ]
    # YAML の構文エラーは、文言を比べない（接頭辞だけ）。入力が失敗することだけを確かめる
    for yaml_text in data["yamlFailures"]:
        result = frontmatter_result(parse_frontmatter, yaml_text)
        prefix = "failed to parse YAML: "
        if not result.get("error", "").startswith(prefix):
            raise SystemExit(f"YAML の失敗にならない入力: {yaml_text!r}")
    out["yamlFailures"] = data["yamlFailures"]
    return out


def record_sections(data: Json) -> Json:
    required = [[(item["level"], item["name"]) for item in group] for group in data["required"]]
    fold_summary = sections_module.PLAN_FOLD_SUMMARY
    cases = []
    for case in data["cases"]:
        body = case["body"]
        cases.append(
            {
                "body": body,
                "style": sections_module.validate_body_style(body),
                "sections": [sections_module.validate_sections(body, r) for r in required],
                "summaries": [
                    sections_module.validate_heading_summaries(body, r) for r in required
                ],
                "balance": sections_module.validate_fold_balance(body),
                "closed": [sections_module.validate_closed_headings(body, r) for r in required],
                "fold": sections_module.validate_fold_summaries(body, fold_summary),
            }
        )
    return {
        "required": data["required"],
        "closedHeadingsByTemplate": sections_module.CLOSED_HEADINGS_BY_TEMPLATE,
        "cases": cases,
    }


def record_worktree_config(data: Json) -> Json:
    cases = []
    for case in data["cases"]:
        entry: dict[str, Json] = {"name": case["name"], "input": case["input"]}
        try:
            entry["saved"] = dumps_config(WorktreeConfig.model_validate(case["input"]))
        except ValidationError as error:
            entry["error"] = str(error)
        cases.append(entry)
    return {
        "cases": cases,
        "defaultConfigSaved": dumps_config(get_default_config("shared")),
        "defaultConfigWithSelfSaved": dumps_config(get_default_config("shared", "myrepo")),
        "defaultIgnoreContent": DEFAULT_WORKTREEIGNORE_CONTENT,
    }


def validation_message(kind: str, value: Json) -> str:
    """検証エラーの文。kind はどの入口で作るか"""
    try:
        if kind == "ProjectConfig":
            ProjectConfig.model_validate(value)
        elif kind == "issueRef":
            parse_issue_ref(value)
        elif kind == "repoRef":
            RepoRef.parse(value)
        else:
            raise SystemExit(f"未知の kind: {kind}")
    except (ValidationError, ValueError, RefParseError) as error:
        return str(error)
    raise SystemExit(f"エラーにならない入力: {kind} {value!r}")


def record_validation_errors(data: Json) -> Json:
    return {
        "cases": [
            {
                "id": case["id"],
                "kind": case["kind"],
                "input": case["input"],
                "message": validation_message(case["kind"], case["input"]),
            }
            for case in data["cases"]
        ]
    }


class _IntField(BaseModel):
    a: int


def input_value_text(value: Json) -> str:
    """検証エラーの文に出る input_value（長いと省略される）"""
    try:
        _IntField(a=value)
    except ValidationError as error:
        line = str(error).split("\n")[2]
        start = line.index("input_value=") + len("input_value=")
        return line[start : line.rindex(", input_type=")]
    raise SystemExit(f"エラーにならない入力: {value!r}")


def record_input_values(data: Json) -> Json:
    return {
        "cases": [
            {
                "name": case["name"],
                "input": case["input"],
                "inputValue": input_value_text(case["input"]),
            }
            for case in data["cases"]
        ]
    }


def record_http_query(data: Json) -> Json:
    cases = []
    for case in data["cases"]:
        url = str(httpx.URL("http://host/path", params=case["params"]))
        cases.append({"params": case["params"], "query": url.removeprefix("http://host/path")})
    return {"cases": cases}


GROUPS: dict[str, Callable[[Json], Json]] = {
    "frontmatter": record_frontmatter,
    "sections": record_sections,
    "worktree-config": record_worktree_config,
    "validation-errors": record_validation_errors,
    "input-values": record_input_values,
    "http-query": record_http_query,
}


def render(value: Json) -> str:
    """最上位の各キーと、配列の各要素を 1 行ずつにする（差分を読みやすくするため）"""
    lines = ["{"]
    keys = list(value)
    for key_index, key in enumerate(keys):
        item = value[key]
        comma = "," if key_index < len(keys) - 1 else ""
        if isinstance(item, list):
            lines.append(f"{json.dumps(key)}: [")
            for index, element in enumerate(item):
                tail = "," if index < len(item) - 1 else ""
                lines.append("  " + json.dumps(element, ensure_ascii=False) + tail)
            lines.append("]" + comma)
        else:
            lines.append(f"{json.dumps(key)}: {json.dumps(item, ensure_ascii=False)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("names", nargs="*", help="記録する fixture の名前（省略すると全部）")
    parser.add_argument(
        "--check", action="store_true", help="書き込まずに、今の Python の出力との差を出す"
    )
    args = parser.parse_args()
    names = args.names or list(GROUPS)
    differing: list[str] = []
    for name in names:
        path = HERE / f"{name}.json"
        text = render(GROUPS[name](json.loads(path.read_text(encoding="utf-8"))))
        if path.read_text(encoding="utf-8") == text:
            continue
        if args.check:
            differing.append(name)
        else:
            path.write_text(text, encoding="utf-8")
    if differing:
        print("Python の出力と違う fixture: " + ", ".join(differing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
