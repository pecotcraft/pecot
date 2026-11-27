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

# サイトのビルドが読む材料（定義書・Sphinx の設定・ロゴ）と、ビルドの手順と環境。
_SITE_PATHS = [
    "libs/interface-spec/docs/**",
    "libs/interface-spec/targets.json",
    "libs/interface-spec/project.json",
    "plugins/*/interface/**",
    "actions/interface/**",
    ".github/assets/**",
    ".github/workflows/pages-build.yml",
    ".githooks/ci/dev-container.sh",
    ".devcontainer/**",
    "nx.json",
]
_PAGES_CONCURRENCY = {"group": "pages", "cancel-in-progress": False, "queue": "max"}
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


def _path_filter_matches(file: str, pattern: str) -> bool:
    """Actions の paths の `*`（/ を含まない）と `**`（/ を含む）だけを読む。"""
    regex = "".join(
        ".*" if part == "**" else "[^/]*" if part == "*" else re.escape(part)
        for part in re.split(r"(\*\*|\*)", pattern)
    )
    return re.fullmatch(regex, file) is not None


def _all_steps(path: Path) -> list[dict[str, Any]]:
    return [step for job in _load(path)["jobs"].values() for step in job["steps"]]


# ---------------------------------------------------------------- pages-build.yml


@allure.title(
    "pages-build は、main への push・PR の更新・手動の起動で動き、手動の起動では側を選べる"
)
def test_build_triggers() -> None:
    """`pages-build.yml` の契機のテストです。`push` は main だけ、`pull_request` はサイトの材料に触る PR の 4 種類のイベントで動くことを確認します。`workflow_dispatch` は、`release` と `dev` から選ぶ `side` だけを入力に持ちます。"""
    with allure.step("pages-build.yml の on を読む"):
        on = _load(_BUILD)[True]
    with allure.step("push・pull_request・workflow_dispatch の形を確かめる"):
        assert on["push"] == {"branches": ["main"]}
        # closed の run は、閉じた PR の掃除を起こすためだけにある。
        assert on["pull_request"] == {
            "types": ["opened", "synchronize", "reopened", "closed"],
            "paths": _SITE_PATHS,
        }
        inputs = on["workflow_dispatch"]["inputs"]
        assert set(inputs) == {"side"}
        assert inputs["side"]["type"] == "choice"
        assert inputs["side"]["options"] == ["release", "dev"]
        assert set(on) == {"push", "pull_request", "workflow_dispatch"}


@allure.title("PR の pages-build の paths は、サイトが読むすべての定義書のディレクトリに当たる")
def test_build_paths_cover_every_interface_directory() -> None:
    """`pages-build.yml` の `pull_request` の `paths` のテストです。サイトのビルドが読む `plugins/*/interface` と `targets.json` の `root` の `interface` のどのファイルも、いずれかの `paths` に当たることを確認します。"""
    with allure.step("サイトが読む定義書のディレクトリを集める"):
        roots = json.loads(
            (_REPO_ROOT / "libs/interface-spec/targets.json").read_text(encoding="utf-8")
        )
        bases = {spec["root"] for spec in roots["plugins"].values() if "root" in spec}
        bases |= {
            f"plugins/{p.parent.parent.name}"
            for p in (_REPO_ROOT / "plugins").glob("*/interface/generated.json")
        }
        files = [f"{base}/interface/generated.json" for base in sorted(bases)]
        files += [f"{base}/interface/authored.yaml" for base in sorted(bases)]
        files += ["libs/interface-spec/docs/conf.py", ".github/assets/pecot-icon-light.svg"]
    with allure.step("どのファイルも paths のいずれかに当たることを確かめる"):
        paths = _load(_BUILD)[True]["pull_request"]["paths"]
        assert "actions/interface/generated.json" in files
        for file in files:
            assert any(_path_filter_matches(file, pattern) for pattern in paths), file


@allure.title("pages-build は、側を決める job の後に、ビルドの job を実行する")
def test_build_has_side_and_build_jobs() -> None:
    """`pages-build.yml` の job のテストです。`side` と `build` の 2 つがこの順に存在し、`build` が `side` の結果に応じて動くことを確認します。"""
    with allure.step("pages-build.yml の job を読む"):
        jobs = _load(_BUILD)["jobs"]
    with allure.step("side と build の 2 つで、build が side に続くことを確かめる"):
        assert list(jobs) == ["side", "build"]
        assert jobs["build"]["needs"] == "side"
        assert jobs["build"]["if"] == "${{ needs.side.outputs.build == 'true' }}"


@allure.title("main 以外のブランチから手動で起動すると、最初の step で失敗する")
def test_dispatch_outside_main_fails_before_anything_else() -> None:
    """`pages-build.yml` の `side` の job の最初の step のテストです。`workflow_dispatch` かつ main 以外のブランチのときだけ動き、`exit 1` で終了することを確認します。"""
    with allure.step("side の job の最初の step を読む"):
        first = _steps(_BUILD, "side")[0]
    with allure.step("main の外の dispatch を最初に失敗させることを確かめる"):
        assert first["if"] == (
            "${{ github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main' }}"
        )
        assert "exit 1" in first["run"]


@allure.title("閉じた PR とフォークの PR では、サイトをビルドしない")
def test_side_builds_nothing_for_closed_and_fork_pull_requests() -> None:
    """`pages-build.yml` の `decide` の step のテストです。PR が閉じられたときとフォークからの PR のときに、`build=false` になることを確認します。あわせて、PR の情報が環境変数で渡され、sha が 40 桁の 16 進数であることを検証していることも確認します。"""
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


@allure.title("リリース版は、全履歴を取得して材料を求める")
def test_release_resolves_sources_from_full_history() -> None:
    """リリース版の `side` の job のテストです。全履歴の checkout が行われ、`release_sources.py` が呼ばれ、`sha` と `sources` が job の出力に含まれることを確認します。"""
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


@allure.title("リリース版のビルドには、レポートの材料を渡す")
def test_release_passes_report_sources_to_release_build() -> None:
    """リリース版のレポートの材料のテストです。`release_sources.py --report release` の結果が、`build` の job を経て `--report-sources` の引数に渡されることを確認します。"""
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


@allure.title("ビルドの job は、テストを実行せずにサイトだけを作る")
def test_build_makes_the_site_without_running_tests() -> None:
    """`pages-build.yml` の `build` の job のテストです。step の並びが期待どおりで、実行する nx のコマンドが `interface-spec:docs` だけであり、`run-pr-checks.sh` が呼ばれないことを確認します。"""
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


@allure.title("サイトの側と PR 番号を、開発用のコンテナに渡す")
def test_build_passes_site_env_into_container() -> None:
    """`build` の job の環境変数のテストです。`PECOT_SITE_SIDE` と `PECOT_SITE_PR` が `side` の出力から設定され、`DEVCONTAINER_ENV` にこの 2 つが並ぶことを確認します。"""
    with allure.step("build の job の env を読む"):
        env = _job(_BUILD, "build")["env"]
    with allure.step("サイトの env をコンテナへ渡すことを確かめる"):
        assert env["PECOT_SITE_SIDE"] == "${{ needs.side.outputs.side }}"
        assert env["PECOT_SITE_PR"] == "${{ needs.side.outputs.pr }}"
        assert env["DEVCONTAINER_ENV"].split() == ["PECOT_SITE_SIDE", "PECOT_SITE_PR"]


@allure.title("pages-build の権限は、contents の読み取りだけに限る")
def test_build_permissions_are_contents_read_only() -> None:
    """`pages-build.yml` の権限のテストです。workflow に `contents: read` だけが指定され、job ごとの権限の指定が存在しないことを確認します。"""
    with allure.step("権限が contents の read だけで、job に権限が無いことを確かめる"):
        assert _load(_BUILD)["permissions"] == {"contents": "read"}
        for name, job in _load(_BUILD)["jobs"].items():
            assert "permissions" not in job, name


@allure.title("pages-build は、側ごとに最新の run だけを残す")
def test_build_concurrency_keeps_only_the_latest_per_side() -> None:
    """`pages-build.yml` の `concurrency` のテストです。グループが側と PR 番号またはブランチで決まり、`cancel-in-progress` が `true` であることを確認します。"""
    with allure.step("concurrency の設定を読む"):
        concurrency = _load(_BUILD)["concurrency"]
    with allure.step("side ごとに最新の 1 つだけを残すことを確かめる"):
        assert concurrency["group"] == (
            "pages-build-${{ github.event_name == 'pull_request' && 'pr' || inputs.side || 'dev' }}"
            "-${{ github.event.pull_request.number || github.ref }}"
        )
        assert concurrency["cancel-in-progress"] is True


@allure.title("ビルドの job は、1 つの側を artifact として 7 日間保存する")
def test_build_uploads_one_side_for_seven_days() -> None:
    """`pages-build.yml` の artifact のアップロードのテストです。`upload-artifact` が 1 つだけで、名前・パス・保存期間 7 日・上書きの許可・ファイルが存在しないときのエラーが期待どおりであることを確認します。"""
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


@allure.title("checkout の参照は、step の出力ではなく github のコンテキストから取得する")
def test_checkout_refs_come_from_github_not_step_outputs() -> None:
    """`pages-build.yml` の `actions/checkout` の `ref` のテストです。`build` は PR の head の sha か `github.sha`、`side` は `github.sha` であることを確認します。"""
    with allure.step("build と side の checkout を読む"):
        # step の出力の SHA を checkout すると、CodeQL の actions/cache-poisoning が手での起動で止める。
        # PR 版は、merge のコミットでなく PR の head で作る。
        (build,) = _uses(_BUILD, "build", "actions/checkout")
    with allure.step("ref を step の output でなく github から取ることを確かめる"):
        assert build["with"]["ref"] == "${{ github.event.pull_request.head.sha || github.sha }}"
        (side,) = _uses(_BUILD, "side", "actions/checkout")
        assert side["with"]["ref"] == "${{ github.sha }}"


@allure.title("ワークスペースの所有者は、失敗した場合も含めて必ず元に戻す")
def test_build_restores_owner_always() -> None:
    """`Restore workspace owner` の step のテストです。条件が `always()` で、`dev-container.sh restore-owner` を実行することを確認します。"""
    with allure.step("owner を戻す step を読む"):
        step = _step(_BUILD, "build", "Restore workspace owner")
    with allure.step("いつでも動き、restore-owner を呼ぶことを確かめる"):
        assert step["if"] == "always()"
        assert step["run"] == ".githooks/ci/dev-container.sh restore-owner"


# ---------------------------------------------------------------- pages-deploy.yml


@allure.title("pages-deploy は、pages-build と test-report の run の完了で動く")
def test_deploy_triggers() -> None:
    """`pages-deploy.yml` の契機のテストです。`workflow_run` が 2 つの workflow の完了を待ち、`workflow_dispatch` も使え、それ以外の契機が存在しないことを確認します。"""
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


@allure.title("pages-deploy の job は、最小の権限と決まった environment を持つ")
def test_deploy_jobs_permissions_and_environments() -> None:
    """`pages-deploy.yml` の job の並びと権限のテストです。verify・store・deploy の 3 つが必要な権限だけを持ち、決まった environment を使うことを確認します。`store` は `pages-store`、`deploy` は `github-pages` を使います。"""
    with allure.step("pages-deploy.yml の job を読む"):
        workflow = _load(_DEPLOY)
    with allure.step("job ごとの権限と environment を確かめる"):
        assert workflow["permissions"] == {}
        jobs = workflow["jobs"]
        assert list(jobs) == ["verify", "store", "deploy"]
        assert jobs["verify"]["permissions"] == {
            "contents": "read",
            "actions": "read",
            "pull-requests": "read",
        }
        assert "environment" not in jobs["verify"]
        # configure-pages は enablement が偽なら GET /repos/{owner}/{repo}/pages だけを呼ぶ。
        assert jobs["store"]["permissions"] == {
            "contents": "read",
            "pages": "read",
            "statuses": "write",
        }
        assert jobs["store"]["environment"] == "pages-store"
        assert jobs["deploy"]["permissions"] == {
            "contents": "read",
            "pages": "write",
            "id-token": "write",
            "statuses": "write",
        }
        assert jobs["deploy"]["environment"]["name"] == "github-pages"


@allure.title("サイトに関する workflow は、actions の書き込み権限を持たない")
def test_no_workflow_has_actions_write() -> None:
    """`pages-build.yml`・`pages-deploy.yml`・`ci.yml` のテストです。いずれも `actions: write` を含まないことを確認します。"""
    with allure.step("3 つの workflow に actions の write が無いことを確かめる"):
        for path in (_BUILD, _DEPLOY, _CI):
            text = path.read_text(encoding="utf-8")
            assert not re.search(r"actions:\s*write", text), path.name


@allure.title("pages-deploy の `concurrency` は、実行中の run を取り消さず、順番に実行する")
def test_deploy_concurrency() -> None:
    """`pages-deploy.yml` の `concurrency` のテストです。`store` と `deploy` が、どちらも `queue: max` で `cancel-in-progress` が `false` の `pages` のグループを使うことを確認します。"""
    with allure.step("store・deploy の concurrency を確かめる"):
        # PR への push のたびに deploy が起きる。既定の queue: single では待っている deploy が取り消される。
        # starter workflow と同じく、上げる job と deploy を同じ group に並べる。
        for job in ("store", "deploy"):
            assert _job(_DEPLOY, job)["concurrency"] == _PAGES_CONCURRENCY, job


@allure.title("pages-deploy の job は、前の job の結果に応じた条件で動く")
def test_deploy_job_conditions() -> None:
    """`pages-deploy.yml` の job の `needs` と `if` のテストです。手動の起動では `verify` を飛ばして `store` が公開し直す中身を上げ、`deploy` は `store` が上げたときだけ動くことを確認します。"""
    with allure.step("verify・store・deploy の条件と needs を確かめる"):
        assert _job(_DEPLOY, "verify")["if"] == "${{ github.event_name == 'workflow_run' }}"
        store = _job(_DEPLOY, "store")
        assert store["needs"] == "verify"
        # 手での起動では verify が飛ぶので、既定の success() に任せない。
        assert store["if"] == (
            "${{ !cancelled() && (github.event_name == 'workflow_dispatch'"
            " || needs.verify.result == 'success') }}"
        )
        assert store["outputs"]["uploaded"] == "${{ steps.decide.outputs.uploaded }}"
        deploy = _job(_DEPLOY, "deploy")
        assert deploy["needs"] == ["verify", "store"]
        assert deploy["if"] == (
            "${{ !cancelled() && needs.store.result == 'success'"
            " && needs.store.outputs.uploaded == 'true' }}"
        )


@allure.title("保管の job は、保管の step を workflow_run だけで動かし、上げるかを決めてから上げる")
def test_store_stores_only_for_workflow_run_and_uploads_when_decided() -> None:
    """`store` の job の step の並びのテストです。保管の step は `workflow_run` のときだけ動き、上げる step は `Decide upload` の `uploaded` が真のときだけ動くことを確認します。"""
    with allure.step("store の step を読む"):
        steps = _steps(_DEPLOY, "store")
        names = [s["name"] for s in steps]
    with allure.step("step の並びと条件を確かめる"):
        assert names == [
            "Checkout",
            "Download verified side",
            "Generate GitHub App token",
            "Store side",
            "Decide upload",
            "Checkout pages-store",
            "Setup Pages",
            "Upload artifact",
            "Set preview status",
        ]
        for name in ("Checkout", "Generate GitHub App token", "Store side"):
            assert _step(_DEPLOY, "store", name)["if"] == "github.event_name == 'workflow_run'", (
                name
            )
        assert _step(_DEPLOY, "store", "Download verified side")["if"] == (
            "github.event_name == 'workflow_run' && env.SIDE != ''"
        )
        for name in ("Checkout pages-store", "Setup Pages", "Upload artifact"):
            assert (
                _step(_DEPLOY, "store", name)["if"] == "steps.decide.outputs.uploaded == 'true'"
            ), name


@allure.title("手での起動・store のやり直し・保管の変更のどれかで、pages-store を上げる")
def test_store_decides_to_upload_for_dispatch_rerun_or_change() -> None:
    """`Decide upload` の step のテストです。手での起動、`run_attempt` が 2 以上のやり直し、`changed` が真のどれかの場合に、`uploaded` を真にすることを確認します。"""
    with allure.step("Decide upload の step を読む"):
        step = _step(_DEPLOY, "store", "Decide upload")
    with allure.step("3 つの場合で uploaded を真にすることを確かめる"):
        assert step["env"] == {
            "EVENT_NAME": "${{ github.event_name }}",
            "RUN_ATTEMPT": "${{ github.run_attempt }}",
            "CHANGED": "${{ steps.publish.outputs.changed }}",
        }
        run = step["run"]
        # push の後で落ちた store をやり直すと、store.py は push 済みの中身に changed=false を返す。
        assert (
            'if [ "$EVENT_NAME" = "workflow_dispatch" ] || [ "$RUN_ATTEMPT" != "1" ]'
            ' || [ "$CHANGED" = "true" ]; then'
        ) in run
        assert 'echo "uploaded=$uploaded" >> "$GITHUB_OUTPUT"' in run


@allure.title("プレビューのステータスは、deploy の後か、上げずに済んだ store の最後に付ける")
def test_preview_status_runs_after_deploy_or_in_store_without_upload() -> None:
    """`Set preview status` の step の置き場所のテストです。PR 版のとき、`deploy` では公開の後に、`store` では上げなかったときだけ、最後の step として動くことを確認します。"""
    with allure.step("store と deploy の最後の step を読む"):
        store = _steps(_DEPLOY, "store")[-1]
        deploy = _steps(_DEPLOY, "deploy")
    with allure.step("PR 版にだけ、公開の後か上げなかったときに付くことを確かめる"):
        assert store["name"] == "Set preview status"
        # 変更が無く deploy を飛ばしたときも、保管済みの PR 版を指して付ける。
        assert store["if"] == "env.SIDE == 'pr' && steps.decide.outputs.uploaded != 'true'"
        assert [s["name"] for s in deploy] == ["Deploy to GitHub Pages", "Set preview status"]
        # 開いたときに中身があるように、deploy の後に付ける。
        assert deploy[-1]["if"] == "needs.verify.outputs.side == 'pr'"


@allure.title("検証した head のコミットに、pages / preview のステータスを付ける")
def test_preview_status_sets_pages_preview_on_the_verified_head() -> None:
    """`store` と `deploy` の `Set preview status` の step のテストです。どちらも同じ形で、`pages / preview` の context と PR のプレビューの URL を送信することを確認します。"""
    with allure.step("store と deploy の Set preview status を読む"):
        steps = [_step(_DEPLOY, job, "Set preview status") for job in ("store", "deploy")]
    with allure.step("確かめた head に pages / preview の status を付けることを確かめる"):
        for step in steps:
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
        assert steps[0]["run"] == steps[1]["run"]


@allure.title("pages / preview のステータスは、pages-deploy だけが書き込む")
def test_pages_preview_context_is_written_only_by_pages_deploy() -> None:
    """ステータスの context `pages / preview` のテストです。この文字列を含む workflow が `pages-deploy.yml` だけで、main の必須チェックの名前と重ならないことを確認します。"""
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


@allure.title("検証の job は、main を checkout して run を読み、artifact をツリーの外に置く")
def test_verify_reads_the_run_from_main_and_keeps_artifact_outside_the_tree() -> None:
    """`verify` の job のテストです。checkout が main の全履歴で認証情報を残さず、`RUN_ID` が `workflow_run` の id から設定され、出力先が `RUNNER_TEMP` の下であることを確認します。"""
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


@allure.title("保管の job は、environment の GitHub App のトークンだけで書き込む")
def test_store_writes_with_the_pages_store_app_from_environment_only() -> None:
    """`store` の job のテストです。トークンを `PAGES_STORE_APP_CLIENT_ID` と秘密鍵から作り、秘密鍵の参照が 1 か所だけで、トークンを remote の URL に入れず、マスクすることを確認します。"""
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


@allure.title("pages-deploy が待つ workflow の名前は、ビルドとレポートの workflow の名前と一致する")
def test_deploy_workflow_run_names_match_the_build_and_report_workflows() -> None:
    """`workflow_run` に指定した名前のテストです。`pages-build.yml` と `test-report.yml` の `name` と過不足なく一致することを確認します。"""
    with allure.step("build と report の workflow の名前を集める"):
        names = {_load(path)["name"] for path in (_BUILD, _REPORT)}
    with allure.step("deploy の workflow_run の名前と一致することを確かめる"):
        assert set(_load(_DEPLOY)[True]["workflow_run"]["workflows"]) == names


@allure.title("検証した種類と側を、保管の job に渡す")
def test_verify_outputs_the_kind_to_store() -> None:
    """`verify` の job の出力のテストです。`kind` が出力に含まれ、`store` の環境変数 `KIND` と `SIDE` に `verify` の出力が設定されることを確認します。"""
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


@allure.title("保管の job は、種類に応じて渡す tar と材料のファイルを切り替える")
def test_store_passes_the_report_tar_and_sources_for_a_report() -> None:
    """`Store side` の step のテストです。レポートの場合は `report.tar` と `report-sources.json` を、定義書の場合は `site.tar` などを渡すことを確認します。側が決まらないときは `--side none` になります。"""
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


@allure.title("公開の job は、pages-store を checkout して Pages に公開する")
def test_deploy_publishes_pages_store() -> None:
    """`pages-deploy.yml` の公開のテストです。`store` の job が保管の後に `pages-store` を checkout して上げ、`store` と `deploy` が Pages の 3 つの action を順に使うことを確認します。"""
    with allure.step("store の pages-store の checkout と action の並びを読む"):
        checkout = _step(_DEPLOY, "store", "Checkout pages-store")
        upload = _step(_DEPLOY, "store", "Upload artifact")
    with allure.step("pages-store を公開する並びであることを確かめる"):
        assert checkout["with"] == {
            "ref": "pages-store",
            "path": "pages-site",
            "persist-credentials": False,
        }
        assert upload["with"] == {"path": "pages-site"}
        store = [s.get("uses", "").split("@")[0] for s in _steps(_DEPLOY, "store")]
        deploy = [s.get("uses", "").split("@")[0] for s in _steps(_DEPLOY, "deploy")]
        pages = [u for u in store + deploy if u in _PAGES_ACTIONS]
        assert pages == list(_PAGES_ACTIONS)


@allure.title("Pages の artifact は、deploy より前の job でアップロードする")
def test_pages_artifact_is_uploaded_in_an_earlier_job_than_deploy() -> None:
    """`pages-deploy.yml` のテストです。`upload-pages-artifact` と `deploy-pages` を同じ job で使う job が存在しないことを確認します。"""
    with allure.step("Pages の artifact の upload が、deploy より前の job にあることを確かめる"):
        # 上げた直後の artifact は deploy-pages の照会に出ないことがある（actions/deploy-pages#451）。
        for name, job in _load(_DEPLOY)["jobs"].items():
            uses = {s.get("uses", "").split("@")[0] for s in job["steps"]}
            assert not {"actions/upload-pages-artifact", "actions/deploy-pages"} <= uses, name


@allure.title("Pages の action は、定めた版に固定する")
def test_pages_actions_are_pinned_to_the_contract_versions() -> None:
    """`pages-deploy.yml` の 3 つの Pages の action のテストです。SHA の後ろのコメントに、定めた版が書かれていることを確認します。"""
    with allure.step("pages-deploy.yml の行を読む"):
        # 版は SHA の後ろのコメントにだけある。YAML の読み込みではコメントが消えるので、行で見る。
        lines = _DEPLOY.read_text(encoding="utf-8").splitlines()
    with allure.step("Pages の action が決めた版で固定されていることを確かめる"):
        for action, version in _PAGES_ACTIONS.items():
            (line,) = [line for line in lines if f"uses: {action}@" in line]
            assert line.endswith(f" # {version}"), line


@allure.title("actionlint は、pages-deploy の `queue` を publish-npm と同じ設定で除外する")
def test_actionlint_ignores_queue_for_pages_deploy() -> None:
    """`.github/actionlint.yaml` のテストです。`pages-deploy.yml` の除外の設定が、`publish-npm.yml` と同じであることを確認します。"""
    with allure.step("actionlint の設定を読む"):
        paths = _load(_ACTIONLINT)["paths"]
    with allure.step("pages-deploy.yml の無視が publish-npm.yml と同じであることを確かめる"):
        assert (
            paths[".github/workflows/pages-deploy.yml"]
            == paths[".github/workflows/publish-npm.yml"]
        )


# ---------------------------------------------------------------- ci.yml


@allure.title("ci.yml は、サイトをビルドしない")
def test_ci_does_not_build_the_site() -> None:
    """`ci.yml` のテストです。`pages-preview` の job が存在せず、`interface-spec:docs` を実行しないことを確認します。"""
    with allure.step("ci.yml にサイトを作る job が無いことを確かめる"):
        assert "pages-preview" not in _load(_CI)["jobs"]
        assert "interface-spec:docs" not in _CI.read_text(encoding="utf-8")


# ---------------------------------------------------------------- 共通


@allure.title("すべての checkout は、認証情報を残さない")
def test_checkouts_do_not_persist_credentials() -> None:
    """`pages-build.yml`・`pages-deploy.yml`・`ci.yml` の `actions/checkout` のテストです。すべてで `persist-credentials` が `false` であることを確認します。"""
    with allure.step("3 つの workflow の checkout が認証情報を残さないことを確かめる"):
        for path in (_BUILD, _DEPLOY, _CI):
            for step in _all_steps(path):
                if step.get("uses", "").startswith("actions/checkout@"):
                    assert step["with"]["persist-credentials"] is False, path.name


@allure.title("すべての action は、40 桁の SHA で固定する")
def test_actions_are_pinned_by_sha() -> None:
    """`pages-build.yml`・`pages-deploy.yml`・`ci.yml` の `uses` のテストです。すべての参照が `owner/repo@<40 桁の 16 進数>` の形であることを確認します。"""
    with allure.step("3 つの workflow の action が sha で固定されていることを確かめる"):
        for path in (_BUILD, _DEPLOY, _CI):
            for step in _all_steps(path):
                if "uses" in step:
                    assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", step["uses"]), step["uses"]


@allure.title("run の中に、式と日本語を書かない")
def test_run_has_no_expressions_and_no_japanese() -> None:
    """`pages-build.yml`・`pages-deploy.yml`・`ci.yml` の `run` のテストです。すべての step で `${{` が含まれず、ASCII 以外の文字も含まれないことを確認します。"""
    with allure.step("3 つの workflow の run に式と日本語が無いことを確かめる"):
        for path in (_BUILD, _DEPLOY, _CI):
            for step in _all_steps(path):
                run = step.get("run", "")
                assert "${{" not in run, step["name"]
                assert not re.search(r"[^\x00-\x7f]", run), step["name"]


# ---------------------------------------------------------------- ruleset


def _ruleset(name: str) -> dict[str, Any]:
    return json.loads((_RULESETS / f"{name}.json").read_text(encoding="utf-8"))


@allure.title("pages-store の ruleset は、専用の GitHub App だけに書き込みを許す")
def test_pages_store_ruleset_lets_only_the_pages_store_app_write() -> None:
    """`pages-store.json` のテストです。対象が `pages-store` ブランチで、迂回できるのは Integration 1 件だけであり、リリース用の App と別であることを確認します。"""
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


@allure.title("リリースのタグの ruleset は、リリース用の GitHub App だけに書き込みを許す")
def test_release_tags_ruleset_lets_only_the_release_app_write() -> None:
    """`release-tags.json` のテストです。対象が `refs/tags/*-v*` のタグで、迂回できる対象が main の ruleset と同じであることを確認します。"""
    with allure.step("release-tags と main の ruleset を読む"):
        data = _ruleset("release-tags")
        main = _ruleset("main")
    with allure.step("release の App だけが書けることを確かめる"):
        assert data["target"] == "tag"
        assert data["conditions"]["ref_name"]["include"] == ["refs/tags/*-v*"]
        assert data["bypass_actors"] == main["bypass_actors"]
        assert {r["type"] for r in data["rules"]} == {"creation", "update", "deletion"}
