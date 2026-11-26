"""公開サイトの workflow（pages-build.yml・pages-deploy.yml）・ci.yml がサイトを作らないこと・ruleset の静的な確かめ。

契機・権限・concurrency・artifact の決まりは specs/028-pages-site/contracts/pages.md にある。
pages-deploy.yml は workflow_run で main の定義だけが動き、マージの後でないと確かめられないため、形をここで固定する。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import allure
import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BUILD = _REPO_ROOT / ".github/workflows/pages-build.yml"
_DEPLOY = _REPO_ROOT / ".github/workflows/pages-deploy.yml"
_REPORT = _REPO_ROOT / ".github/workflows/test-report.yml"
_CI = _REPO_ROOT / ".github/workflows/ci.yml"
_WORKFLOWS = _REPO_ROOT / ".github/workflows"
_ACTIONLINT = _REPO_ROOT / ".github/actionlint.yaml"
_RULESETS = _REPO_ROOT / ".github/rulesets"

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
    with allure.step("pages-build.yml の on を読む"):
        on = _load(_BUILD)[True]
    with allure.step("push・pull_request・workflow_dispatch の形を確かめる"):
        assert on["push"] == {"branches": ["main"]}
        # closed の run は、閉じた PR の掃除を起こすためだけにある。
        assert on["pull_request"] == {"types": ["opened", "synchronize", "reopened", "closed"]}
        inputs = on["workflow_dispatch"]["inputs"]
        assert set(inputs) == {"side"}
        assert inputs["side"]["type"] == "choice"
        assert inputs["side"]["options"] == ["release", "dev"]
        assert set(on) == {"push", "pull_request", "workflow_dispatch"}


def test_build_has_side_and_build_jobs() -> None:
    with allure.step("pages-build.yml の job を読む"):
        jobs = _load(_BUILD)["jobs"]
    with allure.step("side と build の 2 つで、build が side に続くことを確かめる"):
        assert list(jobs) == ["side", "build"]
        assert jobs["build"]["needs"] == "side"
        assert jobs["build"]["if"] == "${{ needs.side.outputs.build == 'true' }}"


def test_dispatch_outside_main_fails_before_anything_else() -> None:
    with allure.step("side の job の最初の step を読む"):
        first = _steps(_BUILD, "side")[0]
    with allure.step("main の外の dispatch を最初に失敗させることを確かめる"):
        assert first["if"] == (
            "${{ github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main' }}"
        )
        assert "exit 1" in first["run"]


def test_side_builds_nothing_for_closed_and_fork_pull_requests() -> None:
    with allure.step("side を決める step の env と run を読む"):
        step = next(s for s in _steps(_BUILD, "side") if s.get("id") == "decide")
        env = step["env"]
    with allure.step("閉じた PR と fork の PR では build しないことを確かめる"):
        assert env["PR_HEAD_SHA"] == "${{ github.event.pull_request.head.sha }}"
        assert env["PR_ACTION"] == "${{ github.event.action }}"
        assert env["PR_HEAD_REPO"] == "${{ github.event.pull_request.head.repo.full_name }}"
        assert env["REPO"] == "${{ github.repository }}"
        # 手での起動の開発版は、起動した run のコミット（github.sha）で作る。
        assert env["PUSH_SHA"] == "${{ github.sha }}"
        assert env["INPUT_SIDE"] == "${{ inputs.side }}"
        pull_branch = step["run"].split('if [ "$EVENT_NAME" = "pull_request" ]; then', 1)[1]
        pull_branch = pull_branch.split("elif", 1)[0]
        assert (
            'if [ "$PR_ACTION" = "closed" ] || [ "$PR_HEAD_REPO" != "$REPO" ]; then\n    build=false\n'
        ) in pull_branch
        assert '[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]' in step["run"]


def test_release_resolves_sources_from_full_history() -> None:
    with allure.step("side の job の checkout と release の元の step を読む"):
        (checkout,) = _uses(_BUILD, "side", "actions/checkout")
    with allure.step("全履歴から release の元を決めることを確かめる"):
        assert checkout["if"] == "steps.decide.outputs.side == 'release'"
        assert checkout["with"]["fetch-depth"] == 0
        resolve = _step(_BUILD, "side", "Resolve release sources")
        assert "release_sources.py --main origin/main" in resolve["run"]
        outputs = _job(_BUILD, "side")["outputs"]
        assert outputs["sha"] == "${{ steps.release.outputs.sha || steps.decide.outputs.sha }}"
        assert outputs["sources"] == "${{ steps.release.outputs.sources }}"


def test_release_passes_report_sources_to_release_build() -> None:
    with allure.step("release の元の step を読む"):
        resolve = _step(_BUILD, "side", "Resolve release sources")
    with allure.step("report の元を release の build へ渡すことを確かめる"):
        assert "release_sources.py --report release --main origin/main" in resolve["run"]
        assert "report_sources=$(printf '%s' \"$report\" | jq -c .sources)" in resolve["run"]
        outputs = _job(_BUILD, "side")["outputs"]
        assert outputs["report_sources"] == "${{ steps.release.outputs.report_sources }}"
        env = _job(_BUILD, "build")["env"]
        assert env["REPORT_SOURCES"] == "${{ needs.side.outputs.report_sources }}"
        release = _step(_BUILD, "build", "Build release side")
        assert '"$REPORT_SOURCES" > "$RUNNER_TEMP/report-sources.json"' in release["run"]
        assert '--report-sources "$RUNNER_TEMP/report-sources.json"' in release["run"]


def test_build_makes_the_site_without_running_tests() -> None:
    with allure.step("build の job の step の名前を読む"):
        names = [s["name"] for s in _steps(_BUILD, "build")]
    with allure.step("サイトを作るだけで、テストは動かさないことを確かめる"):
        assert names == [
            "Checkout",
            "Start pulling dev container image",
            "Start dev container",
            "Build site",
            "Build release side",
            "Restore workspace owner",
            "Pack site",
            "Upload side",
        ]
        runs = "\n".join(s.get("run", "") for s in _all_steps(_BUILD))
        assert re.findall(r"nx run \S+", runs) == ["nx run interface-spec:docs"]
        assert "run-pr-checks.sh" not in runs
        release = _step(_BUILD, "build", "Build release side")
        assert release["if"] == "env.SIDE == 'release'"
        assert "release_build.py" in release["run"]


def test_build_passes_site_env_into_container() -> None:
    with allure.step("build の job の env を読む"):
        env = _job(_BUILD, "build")["env"]
    with allure.step("サイトの env をコンテナへ渡すことを確かめる"):
        assert env["PECOT_SITE_SIDE"] == "${{ needs.side.outputs.side }}"
        assert env["PECOT_SITE_PR"] == "${{ needs.side.outputs.pr }}"
        assert env["DEVCONTAINER_ENV"].split() == ["PECOT_SITE_SIDE", "PECOT_SITE_PR"]


def test_build_permissions_are_contents_read_only() -> None:
    with allure.step("権限が contents の read だけで、job に権限が無いことを確かめる"):
        assert _load(_BUILD)["permissions"] == {"contents": "read"}
        for name, job in _load(_BUILD)["jobs"].items():
            assert "permissions" not in job, name


def test_build_concurrency_keeps_only_the_latest_per_side() -> None:
    with allure.step("concurrency の設定を読む"):
        concurrency = _load(_BUILD)["concurrency"]
    with allure.step("side ごとに最新の 1 つだけを残すことを確かめる"):
        assert concurrency["group"] == (
            "pages-build-${{ github.event_name == 'pull_request' && 'pr' || inputs.side || 'dev' }}"
            "-${{ github.event.pull_request.number || github.ref }}"
        )
        assert concurrency["cancel-in-progress"] is True


def test_build_uploads_one_side_for_seven_days() -> None:
    with allure.step("upload の step を集める"):
        uploads = [
            s
            for s in _all_steps(_BUILD)
            if s.get("uses", "").startswith("actions/upload-artifact@")
        ]
    with allure.step("1 つの side を 7 日間 upload することを確かめる"):
        assert len(uploads) == 1
        (upload,) = uploads
        assert upload["with"]["name"] == "${{ needs.side.outputs.artifact }}"
        assert upload["with"]["path"] == "${{ runner.temp }}/pages-side/"
        assert upload["with"]["retention-days"] == 7
        # PR 版は、同じ run をやり直しても上げられる。
        assert upload["with"]["overwrite"] is True
        assert upload["with"]["if-no-files-found"] == "error"


def test_checkout_refs_come_from_github_not_step_outputs() -> None:
    with allure.step("build と side の checkout を読む"):
        # step の出力の SHA を checkout すると、CodeQL の actions/cache-poisoning が手での起動で止める。
        # PR 版は、merge のコミットでなく PR の head で作る。
        (build,) = _uses(_BUILD, "build", "actions/checkout")
    with allure.step("ref を step の output でなく github から取ることを確かめる"):
        assert build["with"]["ref"] == "${{ github.event.pull_request.head.sha || github.sha }}"
        (side,) = _uses(_BUILD, "side", "actions/checkout")
        assert side["with"]["ref"] == "${{ github.sha }}"


def test_build_restores_owner_always() -> None:
    with allure.step("owner を戻す step を読む"):
        step = _step(_BUILD, "build", "Restore workspace owner")
    with allure.step("いつでも動き、restore-owner を呼ぶことを確かめる"):
        assert step["if"] == "always()"
        assert step["run"] == ".githooks/ci/dev-container.sh restore-owner"


# ---------------------------------------------------------------- pages-deploy.yml


def test_deploy_triggers() -> None:
    with allure.step("pages-deploy.yml の on を読む"):
        on = _load(_DEPLOY)[True]
    with allure.step("workflow_run と workflow_dispatch の形を確かめる"):
        # ci の run を待つと、PR 版がテストの終わりまで出ない。レポートは test-report の run から受ける。
        assert on["workflow_run"] == {
            "workflows": ["pages-build", "test-report"],
            "types": ["completed"],
        }
        assert on["workflow_dispatch"] is None
        assert set(on) == {"workflow_run", "workflow_dispatch"}


def test_deploy_jobs_permissions_and_environments() -> None:
    with allure.step("pages-deploy.yml の job を読む"):
        workflow = _load(_DEPLOY)
    with allure.step("job ごとの権限と environment を確かめる"):
        assert workflow["permissions"] == {}
        jobs = workflow["jobs"]
        assert list(jobs) == ["verify", "store", "upload", "deploy", "preview-status"]
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
        # configure-pages は enablement が偽なら GET /repos/{owner}/{repo}/pages だけを呼ぶ。
        assert jobs["upload"]["permissions"] == {"contents": "read", "pages": "read"}
        assert "environment" not in jobs["upload"]
        assert jobs["deploy"]["permissions"] == {
            "contents": "read",
            "pages": "write",
            "id-token": "write",
        }
        assert jobs["deploy"]["environment"]["name"] == "github-pages"


def test_no_workflow_has_actions_write() -> None:
    with allure.step("3 つの workflow に actions の write が無いことを確かめる"):
        for path in (_BUILD, _DEPLOY, _CI):
            text = path.read_text(encoding="utf-8")
            assert not re.search(r"actions:\s*write", text), path.name


def test_deploy_concurrency() -> None:
    with allure.step("store・upload・deploy の concurrency を確かめる"):
        assert _job(_DEPLOY, "store")["concurrency"] == {
            "group": "pages-store",
            "cancel-in-progress": False,
            "queue": "max",
        }
        # PR への push のたびに deploy が起きる。既定の queue: single では待っている deploy が取り消される。
        # upload も同じ group に入れ、deploy を upload を終えた順に並べる。
        for job in ("upload", "deploy"):
            assert _job(_DEPLOY, job)["concurrency"] == {
                "group": "pages",
                "cancel-in-progress": False,
                "queue": "max",
            }, job


def test_deploy_job_conditions() -> None:
    with allure.step("verify・store・upload・deploy の条件と needs を確かめる"):
        assert _job(_DEPLOY, "verify")["if"] == "${{ github.event_name == 'workflow_run' }}"
        store = _job(_DEPLOY, "store")
        assert store["needs"] == "verify"
        assert store["if"] == (
            "${{ github.event_name == 'workflow_run' && needs.verify.result == 'success' }}"
        )
        upload = _job(_DEPLOY, "upload")
        assert upload["needs"] == ["verify", "store"]
        # 手での起動は verify と store を飛ばし、pages-store の今の中身を公開し直す。
        assert upload["if"] == (
            "${{ !cancelled() && (github.event_name == 'workflow_dispatch'"
            " || needs.store.outputs.changed == 'true') }}"
        )
        deploy = _job(_DEPLOY, "deploy")
        assert deploy["needs"] == "upload"
        # 手での起動では verify と store が飛ぶので、既定の success() に任せず upload の結果を見る。
        assert deploy["if"] == "${{ !cancelled() && needs.upload.result == 'success' }}"


def test_preview_status_runs_after_deploy_of_a_stored_pr_side() -> None:
    with allure.step("preview-status の job を読む"):
        job = _job(_DEPLOY, "preview-status")
    with allure.step("deploy の後で、保管した PR の side にだけ動くことを確かめる"):
        assert job["needs"] == ["verify", "store", "deploy"]
        # 変更が無く deploy を飛ばしたときも、保管済みの PR 版を指して付ける。
        assert job["if"] == _PREVIEW_IF


def test_preview_status_sets_pages_preview_on_the_verified_head() -> None:
    with allure.step("preview-status の step を読む"):
        (step,) = _steps(_DEPLOY, "preview-status")
    with allure.step("確かめた head に pages / preview の status を付けることを確かめる"):
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
    with allure.step("pages / preview を書く workflow を集める"):
        writers = [
            p.name
            for p in sorted(_WORKFLOWS.glob("*.y*ml"))
            if "pages / preview" in p.read_text(encoding="utf-8")
        ]
    with allure.step("pages-deploy.yml だけが書き、必須の check に入らないことを確かめる"):
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
    with allure.step("verify の checkout と step を読む"):
        (checkout,) = _uses(_DEPLOY, "verify", "actions/checkout")
    with allure.step("main から読み、artifact を作業ツリーの外に置くことを確かめる"):
        assert checkout["with"] == {
            "ref": "main",
            "fetch-depth": 0,
            "filter": "blob:none",
            "persist-credentials": False,
        }
        step = _step(_DEPLOY, "verify", "Verify run")
        assert step["env"]["RUN_ID"] == "${{ github.event.workflow_run.id }}"
        assert "verify.py" in step["run"]
        assert '--out "$RUNNER_TEMP/pages-verified"' in step["run"]


def test_store_writes_with_the_pages_store_app_from_environment_only() -> None:
    with allure.step("store の App token の step を読む"):
        (token,) = _uses(_DEPLOY, "store", "actions/create-github-app-token")
    with allure.step("pages-store の App を environment からだけ使うことを確かめる"):
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


def test_deploy_workflow_run_names_match_the_build_and_report_workflows() -> None:
    with allure.step("build と report の workflow の名前を集める"):
        names = {_load(path)["name"] for path in (_BUILD, _REPORT)}
    with allure.step("deploy の workflow_run の名前と一致することを確かめる"):
        assert set(_load(_DEPLOY)[True]["workflow_run"]["workflows"]) == names


def test_verify_outputs_the_kind_to_store() -> None:
    with allure.step("verify の output を読む"):
        outputs = _job(_DEPLOY, "verify")["outputs"]
    with allure.step("保管する種類を store へ渡すことを確かめる"):
        assert outputs["kind"] == "${{ steps.verify.outputs.kind }}"
        env = _job(_DEPLOY, "store")["env"]
        assert env["KIND"] == "${{ needs.verify.outputs.kind }}"
        assert env["SIDE"] == "${{ needs.verify.outputs.side }}"


def _store_branches() -> tuple[str, str, str]:
    """Store side の run を、側を受けたときのレポート・定義書の分岐と、受けないときの分岐に分ける。"""
    run = _step(_DEPLOY, "store", "Store side")["run"]
    accepted, rest = run.split('if [ -n "$SIDE" ]; then', 1)[1].split("\nelse\n", 1)
    report, site = accepted.split('if [ "$KIND" = "report" ]; then', 1)[1].split("\n  else\n", 1)
    return report, site, rest


def test_store_passes_the_report_tar_and_sources_for_a_report() -> None:
    with allure.step("store の run を読む"):
        run = _step(_DEPLOY, "store", "Store side")["run"]
    with allure.step("report・site・それ以外で、渡す引数が分かれることを確かめる"):
        assert '--side "$SIDE" --kind "$KIND" --sha "$HEAD_SHA"' in run
        report, site, rest = _store_branches()
        assert '--tar "$verified/report.tar"' in report
        assert (
            '[ ! -f "$verified/report-sources.json" ] || args+=(--sources "$verified/report-sources.json")'
            in report
        )
        for word in ("site.tar", "release-sources.json", "--pr"):
            assert word not in report, word
        assert '--tar "$verified/site.tar"' in site
        assert '[ -z "$PR" ] || args+=(--pr "$PR")' in site
        assert (
            '[ ! -f "$verified/release-sources.json" ] || args+=(--sources "$verified/release-sources.json")'
            in site
        )
        for word in ("report.tar", "report-sources.json"):
            assert word not in site, word
        assert "args+=(--side none)" in rest
        assert "--kind" not in rest


def test_deploy_publishes_pages_store() -> None:
    with allure.step("upload の checkout と action の並びを読む"):
        (checkout,) = _uses(_DEPLOY, "upload", "actions/checkout")
    with allure.step("pages-store を公開する並びであることを確かめる"):
        assert checkout["with"]["ref"] == "pages-store"
        upload = [s.get("uses", "").split("@")[0] for s in _steps(_DEPLOY, "upload")]
        deploy = [s.get("uses", "").split("@")[0] for s in _steps(_DEPLOY, "deploy")]
        assert upload[1:] + deploy == list(_PAGES_ACTIONS)


def test_pages_artifact_is_uploaded_in_an_earlier_job_than_deploy() -> None:
    with allure.step("Pages の artifact の upload が、deploy より前の job にあることを確かめる"):
        # 上げた直後の artifact は deploy-pages の照会に出ないことがある（actions/deploy-pages#451）。
        for name, job in _load(_DEPLOY)["jobs"].items():
            uses = {s.get("uses", "").split("@")[0] for s in job["steps"]}
            assert not {"actions/upload-pages-artifact", "actions/deploy-pages"} <= uses, name


def test_pages_actions_are_pinned_to_the_contract_versions() -> None:
    with allure.step("pages-deploy.yml の行を読む"):
        # 版は SHA の後ろのコメントにだけある。YAML の読み込みではコメントが消えるので、行で見る。
        lines = _DEPLOY.read_text(encoding="utf-8").splitlines()
    with allure.step("Pages の action が決めた版で固定されていることを確かめる"):
        for action, version in _PAGES_ACTIONS.items():
            (line,) = [line for line in lines if f"uses: {action}@" in line]
            assert line.endswith(f" # {version}"), line


def test_actionlint_ignores_queue_for_pages_deploy() -> None:
    with allure.step("actionlint の設定を読む"):
        paths = _load(_ACTIONLINT)["paths"]
    with allure.step("pages-deploy.yml の無視が publish-npm.yml と同じであることを確かめる"):
        assert (
            paths[".github/workflows/pages-deploy.yml"]
            == paths[".github/workflows/publish-npm.yml"]
        )


# ---------------------------------------------------------------- ci.yml


def test_ci_does_not_build_the_site() -> None:
    with allure.step("ci.yml にサイトを作る job が無いことを確かめる"):
        assert "pages-preview" not in _load(_CI)["jobs"]
        assert "interface-spec:docs" not in _CI.read_text(encoding="utf-8")


# ---------------------------------------------------------------- 共通


def test_checkouts_do_not_persist_credentials() -> None:
    with allure.step("3 つの workflow の checkout が認証情報を残さないことを確かめる"):
        for path in (_BUILD, _DEPLOY, _CI):
            for step in _all_steps(path):
                if step.get("uses", "").startswith("actions/checkout@"):
                    assert step["with"]["persist-credentials"] is False, path.name


def test_actions_are_pinned_by_sha() -> None:
    with allure.step("3 つの workflow の action が sha で固定されていることを確かめる"):
        for path in (_BUILD, _DEPLOY, _CI):
            for step in _all_steps(path):
                if "uses" in step:
                    assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", step["uses"]), step["uses"]


def test_run_has_no_expressions_and_no_japanese() -> None:
    with allure.step("3 つの workflow の run に式と日本語が無いことを確かめる"):
        for path in (_BUILD, _DEPLOY, _CI):
            for step in _all_steps(path):
                run = step.get("run", "")
                assert "${{" not in run, step["name"]
                assert not re.search(r"[^\x00-\x7f]", run), step["name"]


# ---------------------------------------------------------------- ruleset


def _ruleset(name: str) -> dict[str, Any]:
    return json.loads((_RULESETS / f"{name}.json").read_text(encoding="utf-8"))


def test_pages_store_ruleset_lets_only_the_pages_store_app_write() -> None:
    with allure.step("pages-store の ruleset を読む"):
        data = _ruleset("pages-store")
    with allure.step("pages-store の App だけが書けることを確かめる"):
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
    with allure.step("release-tags と main の ruleset を読む"):
        data = _ruleset("release-tags")
        main = _ruleset("main")
    with allure.step("release の App だけが書けることを確かめる"):
        assert data["target"] == "tag"
        assert data["conditions"]["ref_name"]["include"] == ["refs/tags/*-v*"]
        assert data["bypass_actors"] == main["bypass_actors"]
        assert {r["type"] for r in data["rules"]} == {"creation", "update", "deletion"}
