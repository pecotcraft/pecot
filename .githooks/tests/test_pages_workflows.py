"""公開サイトの workflow（pages-build.yml・pages-deploy.yml）と ruleset の静的な確かめ。

契機・権限・concurrency・artifact の決まりは specs/028-pages-site/contracts/pages.md にある。
どちらもマージの後でないと動かない（pages-deploy.yml は workflow_run）ため、形をここで固定する。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BUILD = _REPO_ROOT / ".github/workflows/pages-build.yml"
_DEPLOY = _REPO_ROOT / ".github/workflows/pages-deploy.yml"
_ACTIONLINT = _REPO_ROOT / ".github/actionlint.yaml"
_RULESETS = _REPO_ROOT / ".github/rulesets"

_SITE_ENV = (
    "PECOT_SITE_STRICT",
    "PECOT_SITE_SIDE",
    "PECOT_SITE_PR",
    "PECOT_SITE_SHA",
    "PECOT_SITE_RUN_URL",
    "PECOT_SITE_BUILT_AT",
)
_PAGES_ACTIONS = {
    "actions/configure-pages": "v6.0.0",
    "actions/upload-pages-artifact": "v5.0.0",
    "actions/deploy-pages": "v5.0.1",
}


def _load(path: Path) -> dict[Any, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _job(path: Path, name: str) -> dict[str, Any]:
    return _load(path)["jobs"][name]


def _steps(path: Path, job: str) -> list[dict[str, Any]]:
    return _job(path, job)["steps"]


def _step(path: Path, job: str, name: str) -> dict[str, Any]:
    return next(s for s in _steps(path, job) if s.get("name") == name)


def _uses(path: Path, job: str, action: str) -> list[dict[str, Any]]:
    return [s for s in _steps(path, job) if s.get("uses", "").startswith(f"{action}@")]


def _all_steps(path: Path) -> list[dict[str, Any]]:
    return [step for job in _load(path)["jobs"].values() for step in job["steps"]]


# ---------------------------------------------------------------- pages-build.yml


def test_build_triggers() -> None:
    on = _load(_BUILD)[True]
    assert on["push"] == {"branches": ["main"]}
    assert on["pull_request"] == {"types": ["opened", "synchronize", "reopened", "closed"]}
    inputs = on["workflow_dispatch"]["inputs"]
    assert set(inputs) == {"side"}
    assert inputs["side"]["type"] == "choice"
    assert inputs["side"]["options"] == ["release", "dev"]
    assert set(on) == {"push", "pull_request", "workflow_dispatch"}


def test_build_has_side_and_build_jobs() -> None:
    jobs = _load(_BUILD)["jobs"]
    assert list(jobs) == ["side", "build"]
    assert jobs["build"]["needs"] == "side"
    assert jobs["build"]["if"] == "${{ needs.side.outputs.build == 'true' }}"


def test_dispatch_outside_main_fails_before_anything_else() -> None:
    first = _steps(_BUILD, "side")[0]
    assert first["if"] == (
        "${{ github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main' }}"
    )
    assert "exit 1" in first["run"]


def test_side_builds_only_open_prs_from_this_repo() -> None:
    step = next(s for s in _steps(_BUILD, "side") if s.get("id") == "decide")
    env = step["env"]
    assert env["PR_ACTION"] == "${{ github.event.action }}"
    assert env["PR_HEAD_REPO"] == "${{ github.event.pull_request.head.repo.full_name }}"
    assert env["REPO"] == "${{ github.repository }}"
    assert env["PR_HEAD_SHA"] == "${{ github.event.pull_request.head.sha }}"
    # 手での起動の開発版は、起動した run のコミット（github.sha）で作る。
    assert env["PUSH_SHA"] == "${{ github.sha }}"
    assert env["INPUT_SIDE"] == "${{ inputs.side }}"
    assert '"$PR_ACTION" = "closed"' in step["run"]
    assert '"$PR_HEAD_REPO" != "$REPO"' in step["run"]
    assert '[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]' in step["run"]


def test_release_resolves_sources_from_full_history() -> None:
    (checkout,) = _uses(_BUILD, "side", "actions/checkout")
    assert checkout["if"] == "steps.decide.outputs.side == 'release'"
    assert checkout["with"]["fetch-depth"] == 0
    resolve = _step(_BUILD, "side", "Resolve release sources")
    assert "release_sources.py --main origin/main" in resolve["run"]
    outputs = _job(_BUILD, "side")["outputs"]
    assert outputs["sha"] == "${{ steps.release.outputs.sha || steps.decide.outputs.sha }}"
    assert outputs["sources"] == "${{ steps.release.outputs.sources }}"


def test_build_runs_lanes_in_order_then_site_in_one_job() -> None:
    names = [s["name"] for s in _steps(_BUILD, "build")]
    assert names.index("Start dev container") < names.index("Run lanes")
    assert names.index("Run lanes") < names.index("Collect JUnit") < names.index("Build site")
    lanes = _step(_BUILD, "build", "Run lanes")
    assert "lanes.py" in lanes["run"]
    assert "--skip-nx-cache" in lanes["run"]
    # テストが落ちても次のレーンへ進む。
    assert "|| rc=$?" in lanes["run"]
    release = _step(_BUILD, "build", "Build release side")
    assert release["if"] == "env.SIDE == 'release'"
    assert "release_build.py" in release["run"]


def test_build_passes_site_env_into_container() -> None:
    env = _job(_BUILD, "build")["env"]
    assert env["PECOT_SITE_STRICT"] == "1"
    assert env["PECOT_CI_BROWSER"] == "1"
    for name in _SITE_ENV:
        assert name in env, name
    assert {*_SITE_ENV, "PECOT_CI_BROWSER"} <= set(env["DEVCONTAINER_ENV"].split())


def test_build_permissions_are_contents_read_only() -> None:
    assert _load(_BUILD)["permissions"] == {"contents": "read"}
    for name, job in _load(_BUILD)["jobs"].items():
        assert "permissions" not in job, name


def test_build_concurrency_keeps_only_the_latest_per_side() -> None:
    concurrency = _load(_BUILD)["concurrency"]
    assert concurrency["group"] == (
        "pages-build-${{ github.event_name == 'pull_request' && 'pr' || inputs.side || 'dev' }}"
        "-${{ github.event.pull_request.number || github.ref }}"
    )
    assert concurrency["cancel-in-progress"] is True


def test_build_uploads_one_side_artifact_for_seven_days() -> None:
    uploads = [
        s for s in _all_steps(_BUILD) if s.get("uses", "").startswith("actions/upload-artifact@")
    ]
    assert len(uploads) == 1
    (upload,) = uploads
    assert upload["with"]["name"] == "${{ needs.side.outputs.artifact }}"
    assert upload["with"]["path"] == "${{ runner.temp }}/pages-side/"
    assert upload["with"]["retention-days"] == 7
    assert upload["with"]["if-no-files-found"] == "error"


def test_checkout_refs_come_from_github_not_step_outputs() -> None:
    # step の出力の SHA を checkout すると、CodeQL の actions/cache-poisoning が手での起動で止める。
    (build,) = _uses(_BUILD, "build", "actions/checkout")
    assert build["with"]["ref"] == (
        "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}"
    )
    (side,) = _uses(_BUILD, "side", "actions/checkout")
    assert side["with"]["ref"] == "${{ github.sha }}"


def test_build_restores_owner_always() -> None:
    step = _step(_BUILD, "build", "Restore workspace owner")
    assert step["if"] == "always()"
    assert step["run"] == ".githooks/ci/dev-container.sh restore-owner"


# ---------------------------------------------------------------- pages-deploy.yml


def test_deploy_triggers() -> None:
    on = _load(_DEPLOY)[True]
    assert on["workflow_run"] == {"workflows": ["pages-build"], "types": ["completed"]}
    assert on["workflow_dispatch"] is None
    assert set(on) == {"workflow_run", "workflow_dispatch"}


def test_deploy_jobs_permissions_and_environments() -> None:
    workflow = _load(_DEPLOY)
    assert workflow["permissions"] == {}
    jobs = workflow["jobs"]
    assert list(jobs) == ["verify", "store", "deploy"]
    assert jobs["verify"]["permissions"] == {
        "contents": "read",
        "actions": "read",
        "pull-requests": "read",
    }
    assert "environment" not in jobs["verify"]
    assert jobs["store"]["permissions"] == {"contents": "read"}
    assert jobs["store"]["environment"] == "pages-store"
    assert jobs["deploy"]["permissions"] == {
        "contents": "read",
        "pages": "write",
        "id-token": "write",
    }
    assert jobs["deploy"]["environment"]["name"] == "github-pages"


def test_no_workflow_has_actions_write() -> None:
    for path in (_BUILD, _DEPLOY):
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"actions:\s*write", text), path.name


def test_deploy_concurrency() -> None:
    assert _job(_DEPLOY, "store")["concurrency"] == {
        "group": "pages-store",
        "cancel-in-progress": False,
        "queue": "max",
    }
    assert _job(_DEPLOY, "deploy")["concurrency"] == {
        "group": "pages",
        "cancel-in-progress": False,
    }


def test_deploy_job_conditions() -> None:
    assert _job(_DEPLOY, "verify")["if"] == "${{ github.event_name == 'workflow_run' }}"
    store = _job(_DEPLOY, "store")
    assert store["needs"] == "verify"
    assert store["if"] == (
        "${{ github.event_name == 'workflow_run' && needs.verify.result == 'success' }}"
    )
    deploy = _job(_DEPLOY, "deploy")
    assert deploy["needs"] == ["verify", "store"]
    # 手での起動は verify と store を飛ばし、pages-store の今の中身を公開し直す。
    assert deploy["if"] == (
        "${{ !cancelled() && (github.event_name == 'workflow_dispatch'"
        " || needs.store.outputs.changed == 'true') }}"
    )


def test_verify_reads_the_run_from_main_and_keeps_artifact_outside_the_tree() -> None:
    (checkout,) = _uses(_DEPLOY, "verify", "actions/checkout")
    assert checkout["with"] == {"ref": "main", "fetch-depth": 0, "persist-credentials": False}
    step = _step(_DEPLOY, "verify", "Verify run")
    assert step["env"]["RUN_ID"] == "${{ github.event.workflow_run.id }}"
    assert "verify.py" in step["run"]
    assert '--out "$RUNNER_TEMP/pages-verified"' in step["run"]


def test_store_writes_with_the_pages_store_app_from_environment_only() -> None:
    (token,) = _uses(_DEPLOY, "store", "actions/create-github-app-token")
    assert token["with"] == {
        "client-id": "${{ vars.PAGES_STORE_APP_CLIENT_ID }}",
        "private-key": "${{ secrets.PAGES_STORE_APP_PRIVATE_KEY }}",
        "permission-contents": "write",
    }
    text = _DEPLOY.read_text(encoding="utf-8")
    assert text.count("PAGES_STORE_APP_PRIVATE_KEY") == 1
    store = _step(_DEPLOY, "store", "Store side")
    assert store["env"] == {"GH_TOKEN": "${{ steps.app-token.outputs.token }}"}
    # トークンを remote の URL に入れない。
    assert '--remote-url "https://github.com/$REPO.git"' in store["run"]
    assert "::add-mask::" in store["run"]


def test_deploy_publishes_pages_store() -> None:
    (checkout,) = _uses(_DEPLOY, "deploy", "actions/checkout")
    assert checkout["with"]["ref"] == "pages-store"
    names = [s.get("uses", "").split("@")[0] for s in _steps(_DEPLOY, "deploy")]
    assert names[1:] == list(_PAGES_ACTIONS)


def test_pages_actions_are_pinned_to_the_contract_versions() -> None:
    # 版は SHA の後ろのコメントにだけある。YAML の読み込みではコメントが消えるので、行で見る。
    lines = _DEPLOY.read_text(encoding="utf-8").splitlines()
    for action, version in _PAGES_ACTIONS.items():
        (line,) = [line for line in lines if f"uses: {action}@" in line]
        assert line.endswith(f" # {version}"), line


def test_actionlint_ignores_queue_for_pages_deploy() -> None:
    paths = _load(_ACTIONLINT)["paths"]
    assert paths[".github/workflows/pages-deploy.yml"] == paths[".github/workflows/publish-npm.yml"]


# ---------------------------------------------------------------- 共通


def test_checkouts_do_not_persist_credentials() -> None:
    for path in (_BUILD, _DEPLOY):
        for step in _all_steps(path):
            if step.get("uses", "").startswith("actions/checkout@"):
                assert step["with"]["persist-credentials"] is False, path.name


def test_actions_are_pinned_by_sha() -> None:
    for path in (_BUILD, _DEPLOY):
        for step in _all_steps(path):
            if "uses" in step:
                assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", step["uses"]), step["uses"]


def test_run_has_no_expressions_and_no_japanese() -> None:
    for path in (_BUILD, _DEPLOY):
        for step in _all_steps(path):
            run = step.get("run", "")
            assert "${{" not in run, step["name"]
            assert not re.search(r"[^\x00-\x7f]", run), step["name"]


# ---------------------------------------------------------------- ruleset


def _ruleset(name: str) -> dict[str, Any]:
    return json.loads((_RULESETS / f"{name}.json").read_text(encoding="utf-8"))


def test_pages_store_ruleset_lets_only_the_pages_store_app_write() -> None:
    data = _ruleset("pages-store")
    assert data["target"] == "branch"
    assert data["conditions"]["ref_name"]["include"] == ["refs/heads/pages-store"]
    (actor,) = data["bypass_actors"]
    assert actor["actor_type"] == "Integration"
    assert actor["bypass_mode"] == "always"
    # リリースの App（PECOT_BOT）とは別の App にする。main とタグに書ける鍵を store の job に渡さない。
    release_app_ids = {a["actor_id"] for a in _ruleset("release-tags")["bypass_actors"]}
    assert isinstance(actor["actor_id"], int) and actor["actor_id"] not in release_app_ids
    assert {r["type"] for r in data["rules"]} == {"creation", "update", "deletion"}


def test_release_tags_ruleset_lets_only_the_release_app_write() -> None:
    data = _ruleset("release-tags")
    main = _ruleset("main")
    assert data["target"] == "tag"
    assert data["conditions"]["ref_name"]["include"] == ["refs/tags/*-v*"]
    assert data["bypass_actors"] == main["bypass_actors"]
    assert {r["type"] for r in data["rules"]} == {"creation", "update", "deletion"}
