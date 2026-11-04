"""project.json の test/lint command が指定する --scope= 値が、対象 run-*.sh の case 文（受理値リスト）に含まれることを静的に検証する。
test_ci_scope_consistency.bats の移植。

scope 値を片方だけ変えた場合（project.json か run-*.sh のどちらか一方）を、pre-push / pre-commit 実行を待たず検出するための確認。
スクリプトはフル実行しない。
command 文字列と case 文を付き合わせるだけの、軽量チェック。
node 抽出は、Python の json 標準ライブラリで等価に再実装する。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

# `bash <path>/run-*.sh --scope=<value>` を command 文字列から抽出する正規表現。
# bats 版の node スクリプトの正規表現と同一。
_SCOPE_INVOCATION_RE = re.compile(r"bash\s+(\S*run-[a-z]+\.sh)\s+--scope=(\S+)")
# run-*.sh の `--scope=...` 受理値抽出（case パターン行から）。
_ACCEPTED_SCOPE_RE = re.compile(r"--scope=([a-z]+)")


def _extract_scope_invocation(project_json: Path, target: str) -> tuple[str, str] | None:
    """project.json の指定 target から (script_path, scope_value) を抽出する。

    run-*.sh を含まない command は無視し、見つからなければ None を返す。
    bats 版 _extract_scope_invocation の node 実装を json モジュールで等価再実装。
    """
    data = json.loads(project_json.read_text())
    target_def = (data.get("targets") or {}).get(target)
    if not target_def:
        return None
    opts = target_def.get("options") or {}
    cmds: list[str] = []
    if isinstance(opts.get("command"), str):
        cmds.append(opts["command"])
    if isinstance(opts.get("commands"), list):
        cmds.extend(opts["commands"])
    for c in cmds:
        m = _SCOPE_INVOCATION_RE.search(c)
        if m:
            return m.group(1), m.group(2)
    return None


def _accepted_scopes(script: Path) -> set[str]:
    """run-*.sh の `--scope=...` case パターンから受理値の集合を抽出する。"""
    return set(_ACCEPTED_SCOPE_RE.findall(script.read_text()))


# 各プラグインの project.json（1 プラグイン = 1 project）。
_PLUGINS = ("pecot-workflow", "pecot-visual", "pecot-tools")


def _scope_targets(project_root: Path) -> list[tuple[str, str, str]]:
    """(project.json の相対パス, target, 起動する run-*.sh の相対パス) の一覧。

    `bash scripts/ci/run-*.sh --scope=...` を command に持つ target だけを集める。
    """
    out: list[tuple[str, str, str]] = []
    for plugin in _PLUGINS:
        project_rel = f"plugins/{plugin}/project.json"
        data = json.loads((project_root / project_rel).read_text())
        for target in data.get("targets", {}):
            invocation = _extract_scope_invocation(project_root / project_rel, target)
            if invocation is not None:
                out.append((project_rel, target, f"plugins/{plugin}/{invocation[0]}"))
    return out


_REPO_ROOT = Path(__file__).resolve().parents[4]
_SCOPE_TARGETS = _scope_targets(_REPO_ROOT)


def test_every_plugin_has_scoped_targets():
    """3 プラグインとも run-*.sh を --scope 付きで起動する target を持つ（収集抜けの検出）。"""
    plugins = {project_rel.split("/")[1] for project_rel, _, _ in _SCOPE_TARGETS}
    assert plugins == set(_PLUGINS)


@pytest.mark.parametrize(
    ("project_rel", "target", "script_rel"),
    _SCOPE_TARGETS,
    ids=[f"{p.split('/')[1]}:{t}" for p, t, _ in _SCOPE_TARGETS],
)
def test_scope_consistent(project_root, project_rel, target, script_rel):
    """project.json の target が指す run-*.sh が実在し、その --scope 値を受理する。"""
    project_json = project_root / project_rel
    script = project_root / script_rel
    assert script.is_file(), f"{project_rel}:{target} が起動する {script_rel} が無い"

    invocation = _extract_scope_invocation(project_json, target)
    assert invocation is not None
    _script_path, scope = invocation
    accepted = _accepted_scopes(script)
    assert scope in accepted, (
        f"project.json: {project_rel}:{target} → --scope={scope}\n"
        f"script:       {script_rel} 受理値:{sorted(accepted)}"
    )
