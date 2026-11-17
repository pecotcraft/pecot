"""sandbox-diff.sh のユニットテスト。偽の gh は URL ごとのフィクスチャ（無ければ API 失敗）を返す。"""

from __future__ import annotations

import base64
import copy
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

import pytest

THIS = "pecotcraft/pecot"
SANDBOX = "pecotcraft/pecot-sandbox"
WORKFLOWS = ".github/workflows"

# test_find_pr_ci_base.py の偽の gh を写す。GraphQL は `-F number=` の値で graphql_<番号> を返す。
# FAKE_GH_AUTH_FAIL が立っていれば、認証の失敗（stderr に HTTP 401、終了コード 1）を返す。
_FAKE_GH = """#!/usr/bin/env bash
if [ -n "${FAKE_GH_AUTH_FAIL:-}" ]; then
    echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2
    exit 1
fi
url=""; number=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -f|-F|-X|-H)
            case "$2" in number=*) number="${2#number=}" ;; esac
            shift 2; continue ;;
        -*|api) ;;
        *) url="$1" ;;
    esac
    shift
done
[ "$url" = "graphql" ] && url="graphql_$number"
f="$FAKE_GH_DIR/${url//[^A-Za-z0-9]/_}"
[ -f "$f" ] || exit 1
cat "$f"
"""

BOARD_SYNC = "name: pecot-board-sync\non: workflow_dispatch\njobs:\n  sync:\n    steps:\n      - run: npx -y @pecot/workflow-mcp@next\n"


def compact(v: object) -> str:
    """jq -c と同じ形（キーの順は入力のまま）。"""
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def repo_settings() -> dict[str, Any]:
    return {
        "id": 1,
        "full_name": "x",
        "allow_squash_merge": True,
        "allow_merge_commit": False,
        "allow_rebase_merge": False,
        "allow_auto_merge": True,
        "delete_branch_on_merge": True,
        "updated_at": "2026-11-01T00:00:00Z",
    }


def ruleset(rid: int, repo: str) -> dict[str, Any]:
    return {
        "id": rid,
        "name": "main",
        "target": "branch",
        "source_type": "Repository",
        "source": repo,
        "enforcement": "active",
        "conditions": {"ref_name": {"exclude": [], "include": ["~DEFAULT_BRANCH"]}},
        "rules": [
            {"type": "deletion"},
            {"type": "non_fast_forward"},
            {
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 0,
                    "allowed_merge_methods": ["squash"],
                },
            },
            {
                "type": "required_status_checks",
                "parameters": {
                    "strict_required_status_checks_policy": False,
                    "required_status_checks": [
                        {"context": "ci-result", "integration_id": 15368},
                        {"context": "version-plan", "integration_id": 15368},
                    ],
                },
            },
            {
                "type": "merge_queue",
                "parameters": {
                    "merge_method": "SQUASH",
                    "max_entries_to_build": 1,
                    "grouping_strategy": "ALLGREEN",
                },
            },
            {
                "type": "code_scanning",
                "parameters": {
                    "code_scanning_tools": [{"tool": "CodeQL", "alerts_threshold": "all"}]
                },
            },
        ],
        "node_id": f"RRS_{rid}",
        "created_at": "2026-11-04T14:35:37.581Z",
        "updated_at": "2026-11-09T09:26:49.361Z",
        "bypass_actors": [
            {"actor_id": 5676665, "actor_type": "Integration", "bypass_mode": "always"}
        ],
        "current_user_can_bypass": "never",
        "_links": {"self": {"href": f"https://api.github.com/repos/{repo}/rulesets/{rid}"}},
    }


def board(workflow_field: str) -> dict[str, Any]:
    def single(fid: str, name: str, options: list[str]) -> dict[str, Any]:
        return {
            "__typename": "ProjectV2SingleSelectField",
            "id": fid,
            "name": name,
            "dataType": "SINGLE_SELECT",
            "options": [
                {"id": f"{fid}-{i}", "name": o, "color": "GRAY", "description": ""}
                for i, o in enumerate(options)
            ],
        }

    nodes = [
        {"__typename": "ProjectV2Field", "id": "F_title", "name": "Title", "dataType": "TITLE"},
        single("F_status", "Status", ["Todo", "In Progress", "Done"]),
        single(
            "F_wf",
            workflow_field,
            ["Pending", "Backlog", "Blocked", "Ready", "Active", "In Review", "Archived"],
        ),
        single("F_pri", "pecot-priority", ["High", "Medium", "Low"]),
        single("F_size", "pecot-size", ["XS", "S", "M", "L"]),
    ]
    return {"data": {"organization": {"projectV2": {"fields": {"nodes": nodes}}}}}


def blob(text: str) -> str:
    """git の blob の sha の代わり。中身が同じなら同じ値になる。"""
    return format(abs(hash(text)) % (16**12), "012x")


class Env:
    def __init__(self, tmp_path: Path, script: Path) -> None:
        self.fake = tmp_path / "fake"
        self.fake.mkdir()
        gh = tmp_path / "bin" / "gh"
        gh.parent.mkdir()
        gh.write_text(_FAKE_GH)
        gh.chmod(0o755)
        self.bin = gh.parent
        self.cwd = tmp_path
        self.script = script

    def api(self, url: str, body: object) -> None:
        (self.fake / re.sub(r"[^A-Za-z0-9]", "_", url)).write_text(json.dumps(body))

    def run(self, **extra_env: str) -> subprocess.CompletedProcess[str]:
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FAKE_GH_DIR": str(self.fake),
            **extra_env,
        }
        return subprocess.run(
            [str(self.script)], env=env, cwd=self.cwd, capture_output=True, text=True
        )


class Side:
    """片方のリポとボードの設定。write() でフィクスチャに書き出す。"""

    def __init__(self, repo: str, project: int, ruleset_id: int, workflow_field: str) -> None:
        self.repo = repo
        self.project = project
        self.settings = repo_settings()
        self.rulesets = [ruleset(ruleset_id, repo)]
        self.board = board(workflow_field)
        self.files: dict[str, str] = {"ci.yml": "name: ci\n", "pecot-board-sync.yml": BOARD_SYNC}

    def rules(self, name: str = "main") -> list[dict[str, Any]]:
        return next(r for r in self.rulesets if r["name"] == name)["rules"]

    def fields(self) -> list[dict[str, Any]]:
        return self.board["data"]["organization"]["projectV2"]["fields"]["nodes"]

    def write(self, env: Env) -> None:
        r = self.repo
        env.api(f"repos/{r}", self.settings)
        env.api(
            f"repos/{r}/rulesets?includes_parents=false",
            [
                {"id": rs["id"], "name": rs["name"], "source_type": "Repository"}
                for rs in self.rulesets
            ],
        )
        for rs in self.rulesets:
            env.api(f"repos/{r}/rulesets/{rs['id']}", rs)
        env.api(f"graphql_{self.project}", self.board)
        env.api(
            f"repos/{r}/contents/{WORKFLOWS}?ref=main",
            [{"name": n, "type": "file", "sha": blob(t)} for n, t in self.files.items()],
        )
        for n, t in self.files.items():
            env.api(
                f"repos/{r}/contents/{WORKFLOWS}/{n}?ref=main",
                {
                    "name": n,
                    "sha": blob(t),
                    "encoding": "base64",
                    "content": base64.encodebytes(t.encode()).decode(),
                },
            )


class Scene:
    """このリポ（Projects 1 番）と検証用（Projects 3 番）が、比べる項目で同じ状態から始める。"""

    def __init__(self, env: Env) -> None:
        self.env = env
        self.this = Side(THIS, 1, 26538811, "pecot-workflow-pecotcraft")
        self.sandbox = Side(SANDBOX, 3, 27130266, "pecot-workflow-sandbox")

    def run(self, **extra_env: str) -> subprocess.CompletedProcess[str]:
        self.this.write(self.env)
        self.sandbox.write(self.env)
        return self.env.run(**extra_env)


@pytest.fixture
def scene(tmp_path: Path, githooks_dir: Path) -> Scene:
    return Scene(Env(tmp_path, githooks_dir / "scripts" / "sandbox-diff.sh"))


def drift(name: str, this: str, sandbox: str) -> list[str]:
    return [name, f"  このリポ: {this}", f"  検証用: {sandbox}"]


def assert_drifts(r: subprocess.CompletedProcess[str], *drifts: list[str]) -> None:
    assert r.returncode == 1, r.stderr
    expected = [f"ずれは {len(drifts)} 件"] + [line for d in drifts for line in d]
    assert r.stdout.splitlines() == expected


def without_integration_id(params: dict[str, Any]) -> dict[str, Any]:
    p = copy.deepcopy(params)
    for c in p.get("required_status_checks", []):
        c.pop("integration_id", None)
    return p


def test_same_settings_give_zero(scene: Scene) -> None:
    r = scene.run()
    assert (r.returncode, r.stdout, r.stderr) == (0, "ずれは 0 件\n", "")


def test_missing_required_check(scene: Scene) -> None:
    checks = next(x for x in scene.sandbox.rules() if x["type"] == "required_status_checks")
    checks["parameters"]["required_status_checks"].pop()
    this = next(x for x in scene.this.rules() if x["type"] == "required_status_checks")
    r = scene.run()
    assert_drifts(
        r,
        drift(
            "ruleset main / required_status_checks",
            compact(without_integration_id(this["parameters"])),
            compact(without_integration_id(checks["parameters"])),
        ),
    )
    assert "version-plan" in r.stdout.splitlines()[2]
    assert "version-plan" not in r.stdout.splitlines()[3]


def test_missing_merge_queue(scene: Scene) -> None:
    scene.sandbox.rules()[:] = [x for x in scene.sandbox.rules() if x["type"] != "merge_queue"]
    mq = next(x for x in scene.this.rules() if x["type"] == "merge_queue")
    assert_drifts(
        scene.run(), drift("ruleset main / merge_queue", compact(mq["parameters"]), "なし")
    )


def test_missing_code_scanning_is_not_compared(scene: Scene) -> None:
    """FR-004: code_scanning の規則は match で外す。"""
    scene.sandbox.rules()[:] = [x for x in scene.sandbox.rules() if x["type"] != "code_scanning"]
    r = scene.run()
    assert (r.returncode, r.stdout) == (0, "ずれは 0 件\n")


def test_extra_board_option(scene: Scene) -> None:
    wf = next(f for f in scene.sandbox.fields() if f["name"] == "pecot-workflow-sandbox")
    before = {"dataType": "SINGLE_SELECT", "options": [{"name": o["name"]} for o in wf["options"]]}
    wf["options"].append({"id": "x", "name": "Done", "color": "GREEN", "description": ""})
    after = {"dataType": "SINGLE_SELECT", "options": [*before["options"], {"name": "Done"}]}
    assert_drifts(
        scene.run(), drift("board-fields / pecot-workflow-*", compact(before), compact(after))
    )


def test_board_option_order_is_compared(scene: Scene) -> None:
    pri = next(f for f in scene.sandbox.fields() if f["name"] == "pecot-priority")
    pri["options"].reverse()
    r = scene.run()
    assert r.returncode == 1
    assert r.stdout.splitlines()[:2] == ["ずれは 1 件", "board-fields / pecot-priority"]


def test_ids_and_dates_only_differ(scene: Scene) -> None:
    rs = scene.sandbox.rulesets[0]
    rs.update(
        node_id="RRS_other", created_at="2020-01-01T00:00:00Z", updated_at="2020-01-02T00:00:00Z"
    )
    rs["bypass_actors"] = []
    rs["current_user_can_bypass"] = "always"
    for c in next(x for x in rs["rules"] if x["type"] == "required_status_checks")["parameters"][
        "required_status_checks"
    ]:
        c["integration_id"] = 1
    for f in scene.sandbox.fields():
        f["id"] = f"other-{f['id']}"
        for o in f.get("options", []):
            o.update(id=f"other-{o['id']}", color="RED", description="x")
    scene.sandbox.settings.update(id=99, updated_at="2020-01-01T00:00:00Z")
    r = scene.run()
    assert (r.returncode, r.stdout) == (0, "ずれは 0 件\n")


def test_board_sync_content_differs(scene: Scene) -> None:
    """FR-032: 中身が違えば、両方の blob の sha と、違う最初の行を出す。"""
    other = BOARD_SYNC.replace("@next", "@6")
    scene.sandbox.files["pecot-board-sync.yml"] = other
    line = 6
    assert_drifts(
        scene.run(),
        drift(
            "workflows / pecot-board-sync.yml",
            f"blob {blob(BOARD_SYNC)}、{line} 行目: {BOARD_SYNC.splitlines()[line - 1]}",
            f"blob {blob(other)}、{line} 行目: {other.splitlines()[line - 1]}",
        ),
    )


def test_ci_yml_presence_only(scene: Scene) -> None:
    scene.sandbox.files["ci.yml"] = "name: other ci\n"
    r = scene.run()
    assert (r.returncode, r.stdout) == (0, "ずれは 0 件\n")
    del scene.sandbox.files["ci.yml"]
    assert_drifts(scene.run(), drift("workflows / ci.yml", "あり", "なし"))


def test_merge_setting_differs(scene: Scene) -> None:
    scene.sandbox.settings["allow_rebase_merge"] = True
    assert_drifts(scene.run(), drift("merge-settings / allow_rebase_merge", "false", "true"))


def test_auth_failure(scene: Scene) -> None:
    r = scene.run(FAKE_GH_AUTH_FAIL="1")
    assert r.returncode == 2
    assert r.stdout == ""
    assert r.stderr.splitlines() == [
        f"error: repos/{THIS} を読めません（HTTP 401: Bad credentials (https://api.github.com/graphql)）"
    ]


def _null_auto_merge(scene: Scene) -> str:
    scene.sandbox.settings["allow_auto_merge"] = None
    return (
        f"error: repos/{SANDBOX} の応答に allow_auto_merge がありません（権限の不足とみられます）"
    )


def _no_rules(scene: Scene) -> str:
    del scene.this.rulesets[0]["rules"]
    return f"error: repos/{THIS}/rulesets/26538811 の応答に rules がありません（権限の不足とみられます）"


def _no_project(scene: Scene) -> str:
    scene.sandbox.board = {"data": {"organization": {"projectV2": None}}}
    return (
        "error: orgs/pecotcraft/projectsV2/3 の応答に fields がありません（権限の不足とみられます）"
    )


@pytest.mark.parametrize("breaks", [_null_auto_merge, _no_rules, _no_project])
def test_null_key_is_error(scene: Scene, breaks: Any) -> None:
    """比べるキーが無い（null を含む）ときは、両方 null でも同じとせず error で 2。"""
    expected = breaks(scene)
    r = scene.run()
    assert (r.returncode, r.stdout) == (2, "")
    assert r.stderr.splitlines() == [expected]


def test_both_null_is_error(scene: Scene) -> None:
    scene.this.settings["allow_auto_merge"] = None
    scene.sandbox.settings["allow_auto_merge"] = None
    r = scene.run()
    assert r.returncode == 2
    assert r.stderr.startswith(f"error: repos/{THIS} の応答に allow_auto_merge がありません")


def test_unreadable_ruleset(scene: Scene) -> None:
    scene.this.write(scene.env)
    scene.sandbox.write(scene.env)
    (scene.env.fake / re.sub(r"[^A-Za-z0-9]", "_", f"repos/{SANDBOX}/rulesets/27130266")).unlink()
    r = scene.env.run()
    assert r.returncode == 2
    assert r.stderr.splitlines() == [
        f"error: repos/{SANDBOX}/rulesets/27130266 を読めません（gh が失敗しました）"
    ]


def _spec_table(spec: str, heading: str) -> dict[str, str]:
    """spec.md の太字の見出しの下の表から、ID → 最後の列（訳）を拾う。"""
    block = spec.split(f"**{heading}**", 1)[1].split("**", 1)[0]
    rows = [line.split("|")[1:-1] for line in block.splitlines() if line.startswith("| FR-")]
    return {cells[0].strip(): cells[-1].strip() for cells in rows}


def test_items_match_spec(githooks_dir: Path) -> None:
    items = json.loads((githooks_dir / "scripts" / "sandbox-diff-items.json").read_text())
    spec = (githooks_dir.parent / "specs" / "026-pre-merge-test-env" / "spec.md").read_text()
    compared = sorted({i["id"] for i in items if i["compare"]})
    assert compared == ["FR-001", "FR-002", "FR-003"]
    reasons = {i["id"]: i["reason"] for i in items if not i["compare"]}
    assert reasons == _spec_table(spec, "同じにしなくてよいもの")
    assert {i["name"] for i in items if i["compare"]} == {
        "merge-settings",
        "ruleset",
        "board-fields",
        "workflows",
    }
    assert all(isinstance(i["ignore"], list) for i in items if i["compare"])
