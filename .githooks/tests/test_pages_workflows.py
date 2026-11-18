"""公開サイトの workflow（pages-build.yml・pages-deploy.yml・ci.yml の PR 版）と ruleset の静的な確かめ。

契機・権限・concurrency・artifact の決まりは specs/028-pages-site/contracts/pages.md にある。
pages-deploy.yml は workflow_run で main の定義だけが動き、マージの後でないと確かめられないため、形をここで固定する。
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
_CI = _REPO_ROOT / ".github/workflows/ci.yml"
_WORKFLOWS = _REPO_ROOT / ".github/workflows"
_ACTIONLINT = _REPO_ROOT / ".github/actionlint.yaml"
_RULESETS = _REPO_ROOT / ".github/rulesets"
_JUNIT_LANES = _REPO_ROOT / "libs/interface-spec/docs/junit-lanes.json"

_SITE_ENV = ("PECOT_SITE_STRICT", "PECOT_SITE_SIDE")
_PR_SITE_ENV = (*_SITE_ENV, "PECOT_SITE_PR")
_SAME_REPO = "github.event.pull_request.head.repo.full_name == github.repository"
_PREVIEW_IF = (
    "${{ !cancelled() && needs.verify.outputs.side == 'pr' && needs.store.result == 'success'"
    " && (needs.deploy.result == 'success'"
    " || (needs.deploy.result == 'skipped' && needs.store.outputs.changed != 'true')) }}"
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
    # PR 版は ci.yml の pages-preview が作る。閉じた PR の run は掃除を起こすためだけにある。
    assert on["pull_request"] == {"types": ["closed"]}
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


def test_side_builds_nothing_for_pull_requests() -> None:
    step = next(s for s in _steps(_BUILD, "side") if s.get("id") == "decide")
    env = step["env"]
    assert env["PR_HEAD_SHA"] == "${{ github.event.pull_request.head.sha }}"
    # 手での起動の開発版は、起動した run のコミット（github.sha）で作る。
    assert env["PUSH_SHA"] == "${{ github.sha }}"
    assert env["INPUT_SIDE"] == "${{ inputs.side }}"
    pull_branch = step["run"].split('if [ "$EVENT_NAME" = "pull_request" ]; then', 1)[1]
    pull_branch = pull_branch.split("elif", 1)[0]
    assert "build=false" in pull_branch
    assert '[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]' in step["run"]


def test_build_job_does_not_build_pr_sides() -> None:
    env = _job(_BUILD, "build")["env"]
    assert "PECOT_SITE_PR" not in env
    assert "PECOT_SITE_PR" not in env["DEVCONTAINER_ENV"].split()
    assert "pull_request" not in yaml.safe_dump(_job(_BUILD, "build"), allow_unicode=True)


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


def test_build_keeps_dev_side_for_ninety_days_and_release_for_seven() -> None:
    uploads = [
        s for s in _all_steps(_BUILD) if s.get("uses", "").startswith("actions/upload-artifact@")
    ]
    assert len(uploads) == 1
    (upload,) = uploads
    assert upload["with"]["name"] == "${{ needs.side.outputs.artifact }}"
    assert upload["with"]["path"] == "${{ runner.temp }}/pages-side/"
    # 開発版は PR 版の埋め合わせに使うので、このリポの上限の 90 日残す。
    assert upload["with"]["retention-days"] == (
        "${{ needs.side.outputs.side == 'dev' && 90 || 7 }}"
    )
    assert upload["with"]["if-no-files-found"] == "error"


def test_checkout_refs_come_from_github_not_step_outputs() -> None:
    # step の出力の SHA を checkout すると、CodeQL の actions/cache-poisoning が手での起動で止める。
    (build,) = _uses(_BUILD, "build", "actions/checkout")
    assert build["with"]["ref"] == "${{ github.sha }}"
    (side,) = _uses(_BUILD, "side", "actions/checkout")
    assert side["with"]["ref"] == "${{ github.sha }}"


def test_build_restores_owner_always() -> None:
    step = _step(_BUILD, "build", "Restore workspace owner")
    assert step["if"] == "always()"
    assert step["run"] == ".githooks/ci/dev-container.sh restore-owner"


# ---------------------------------------------------------------- pages-deploy.yml


def test_deploy_triggers() -> None:
    on = _load(_DEPLOY)[True]
    assert on["workflow_run"] == {"workflows": ["pages-build", "ci"], "types": ["completed"]}
    assert on["workflow_dispatch"] is None
    assert set(on) == {"workflow_run", "workflow_dispatch"}


def test_deploy_jobs_permissions_and_environments() -> None:
    workflow = _load(_DEPLOY)
    assert workflow["permissions"] == {}
    jobs = workflow["jobs"]
    assert list(jobs) == ["verify", "store", "deploy", "preview-status"]
    assert jobs["preview-status"]["permissions"] == {"statuses": "write"}
    assert "environment" not in jobs["preview-status"]
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
    for path in (_BUILD, _DEPLOY, _CI):
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"actions:\s*write", text), path.name


def test_deploy_concurrency() -> None:
    assert _job(_DEPLOY, "store")["concurrency"] == {
        "group": "pages-store",
        "cancel-in-progress": False,
        "queue": "max",
    }
    # ci の run のたびに deploy が起きる。既定の queue: single では待っている deploy が取り消される。
    assert _job(_DEPLOY, "deploy")["concurrency"] == {
        "group": "pages",
        "cancel-in-progress": False,
        "queue": "max",
    }


def test_deploy_job_conditions() -> None:
    assert _job(_DEPLOY, "verify")["if"] == (
        "${{ github.event_name == 'workflow_run'"
        " && github.event.workflow_run.event != 'merge_group' }}"
    )
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


def test_preview_status_runs_after_deploy_of_a_stored_pr_side() -> None:
    job = _job(_DEPLOY, "preview-status")
    assert job["needs"] == ["verify", "store", "deploy"]
    # 変更が無く deploy を飛ばしたときも、保管済みの PR 版を指して付ける。
    assert job["if"] == _PREVIEW_IF


def test_preview_status_sets_pages_preview_on_the_verified_head() -> None:
    (step,) = _steps(_DEPLOY, "preview-status")
    assert step["name"] == "Set preview status"
    assert step["env"] == {
        "GH_TOKEN": "${{ github.token }}",
        "REPO": "${{ github.repository }}",
        "PR": "${{ needs.verify.outputs.pr }}",
        "HEAD_SHA": "${{ needs.verify.outputs.head_sha }}",
    }
    run = step["run"]
    assert 'gh api --method POST "repos/$REPO/statuses/$HEAD_SHA"' in run
    assert "-f state=success" in run
    assert '-f context="pages / preview"' in run
    assert '-f target_url="https://pecotcraft.github.io/pecot/pr/$PR/"' in run


def test_pages_preview_context_is_written_only_by_pages_deploy() -> None:
    writers = [
        p.name
        for p in sorted(_WORKFLOWS.glob("*.y*ml"))
        if "pages / preview" in p.read_text(encoding="utf-8")
    ]
    assert writers == ["pages-deploy.yml"]
    # 必須チェックの名前と重ねない。
    contexts = {
        check["context"]
        for rule in _ruleset("main")["rules"]
        if rule["type"] == "required_status_checks"
        for check in rule["parameters"]["required_status_checks"]
    }
    assert contexts == {"ci-result", "version-plan"}
    assert "pages / preview" not in contexts


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


# ---------------------------------------------------------------- ci.yml の PR 版


def test_tests_stage_junit_after_restoring_owner() -> None:
    names = [s.get("name") for s in _steps(_CI, "tests")]
    assert names.index("Restore workspace owner") < names.index("Stage JUnit")
    assert names.index("Stage JUnit") < names.index("Upload JUnit")
    stage = _step(_CI, "tests", "Stage JUnit")
    assert stage["if"] == "always()"
    assert "lanes.py" in stage["run"]
    assert '"$RUNNER_TEMP/pages-junit/$junit"' in stage["run"]


def test_tests_upload_junit_as_directory_for_same_repo_prs() -> None:
    upload = _step(_CI, "tests", "Upload JUnit")
    assert upload["if"] == f"always() && github.event_name == 'pull_request' && {_SAME_REPO}"
    # ファイル 1 つを渡すと階層が消え、merge-multiple で junit.xml どうしがぶつかる。
    assert upload["with"]["path"] == "${{ runner.temp }}/pages-junit/"
    assert upload["with"]["name"] == "pages-junit-${{ matrix.slug }}"
    assert upload["with"]["retention-days"] == 1


def test_pr_side_uploads_overwrite() -> None:
    assert _step(_CI, "tests", "Upload JUnit")["with"]["overwrite"] is True
    side = _step(_CI, "pages-preview", "Upload side")
    assert side["with"]["overwrite"] is True
    assert side["with"]["name"] == "pages-side-pr-${{ github.event.pull_request.number }}"
    assert side["with"]["path"] == "${{ runner.temp }}/pages-side/"
    assert side["with"]["if-no-files-found"] == "error"


def test_pages_preview_runs_after_tests_for_same_repo_pull_requests_only() -> None:
    job = _job(_CI, "pages-preview")
    assert job["needs"] == ["lanes", "tests"]
    assert job["if"] == (
        "${{ !cancelled() && github.event_name == 'pull_request'"
        f" && {_SAME_REPO} && needs.lanes.result == 'success' }}}}"
    )


def test_pages_preview_is_not_in_ci_result() -> None:
    # PR 版の失敗でマージを止めない。
    assert "pages-preview" not in _job(_CI, "ci-result")["needs"]


def test_pages_preview_builds_the_site_without_running_tests() -> None:
    names = [s.get("name") for s in _steps(_CI, "pages-preview")]
    order = [
        "Checkout",
        "Download lane JUnit",
        "Find dev side",
        "Download dev JUnit",
        "Collect JUnit",
        "Start dev container",
        "Build site",
        "Pack site",
        "Upload side",
    ]
    assert [n for n in names if n in order] == order
    runs = "\n".join(s.get("run", "") for s in _steps(_CI, "pages-preview"))
    assert "run-pr-checks.sh" not in runs
    assert "lanes.py" not in runs
    assert re.findall(r"nx run \S+", runs) == ["nx run interface-spec:docs"]


def test_pages_preview_reads_head_and_both_junit_sources() -> None:
    (checkout,) = _uses(_CI, "pages-preview", "actions/checkout")
    assert checkout["with"]["ref"] == "${{ github.event.pull_request.head.sha }}"
    lanes = _step(_CI, "pages-preview", "Download lane JUnit")
    assert lanes["with"]["pattern"] == "pages-junit-*"
    assert lanes["with"]["merge-multiple"] is True
    dev = _step(_CI, "pages-preview", "Download dev JUnit")
    assert dev["with"]["name"] == "pages-side-dev"
    assert dev["with"]["run-id"] == "${{ steps.dev.outputs.run_id }}"
    assert dev["with"]["github-token"] == "${{ github.token }}"
    explain = _step(_CI, "pages-preview", "Explain missing dev side")
    assert explain["if"] == "failure() && steps.devdl.outcome == 'failure'"
    assert "gh workflow run pages-build.yml --ref main -f side=dev" in explain["run"]
    collect = _step(_CI, "pages-preview", "Collect JUnit")
    assert collect["env"]["RAN"] == "${{ needs.lanes.outputs.lanes }}"
    for flag in ("--ran", "--ci-dir", "--dev-dir", "--dev-sha"):
        assert flag in collect["run"], flag


def test_pages_preview_passes_site_env_into_container() -> None:
    env = _job(_CI, "pages-preview")["env"]
    assert env["PECOT_SITE_SIDE"] == "pr"
    assert env["PECOT_SITE_STRICT"] == "1"
    assert env["PECOT_SITE_PR"] == "${{ github.event.pull_request.number }}"
    assert set(_PR_SITE_ENV) == set(env["DEVCONTAINER_ENV"].split())


def test_junit_lanes_are_nx_outputs() -> None:
    # nx のキャッシュに当たったレーンでも、JUnit が作業ツリーに戻る前提を固定する。
    for lane in json.loads(_JUNIT_LANES.read_text(encoding="utf-8")):
        project = _REPO_ROOT / "plugins" / lane["plugin"]
        targets = json.loads((project / "project.json").read_text(encoding="utf-8"))["targets"]
        target = lane["target"].split(":", 1)[1]
        relative = Path(lane["junit"]).relative_to(Path("plugins") / lane["plugin"]).as_posix()
        assert f"{{projectRoot}}/{relative}" in targets[target].get("outputs", []), lane["target"]


# ---------------------------------------------------------------- 共通


def test_checkouts_do_not_persist_credentials() -> None:
    for path in (_BUILD, _DEPLOY, _CI):
        for step in _all_steps(path):
            if step.get("uses", "").startswith("actions/checkout@"):
                assert step["with"]["persist-credentials"] is False, path.name


def test_actions_are_pinned_by_sha() -> None:
    for path in (_BUILD, _DEPLOY, _CI):
        for step in _all_steps(path):
            if "uses" in step:
                assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", step["uses"]), step["uses"]


def test_run_has_no_expressions_and_no_japanese() -> None:
    for path in (_BUILD, _DEPLOY, _CI):
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
