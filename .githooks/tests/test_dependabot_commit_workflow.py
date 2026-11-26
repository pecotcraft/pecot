"""dependabot-commit.yml・dependabot-auto-merge.yml・devcontainer-image.yml の静的な確認。

これらは Dependabot の PR か main への push でしか動かない。退行を merge 前に止めるため、構造を固定する。
CI のイメージの定義（Dockerfile のベースイメージと、それを追う dependabot.yml）も同じく固定する。
"""

from __future__ import annotations

import re
from pathlib import Path

import allure
import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = ".githooks/scripts/sync-playwright-deps.mjs"


def _workflow(name: str) -> dict:
    return yaml.safe_load((_REPO_ROOT / ".github/workflows" / name).read_text(encoding="utf-8"))


def _step_index(steps: list[dict], name: str) -> int:
    i = next((i for i, s in enumerate(steps) if s.get("name") == name), None)
    assert i is not None, f"step が無い: {name}"
    return i


def _step(steps: list[dict], name: str) -> dict:
    return steps[_step_index(steps, name)]


def _commit_steps() -> list[dict]:
    return _workflow("dependabot-commit.yml")["jobs"]["regenerate"]["steps"]


@allure.title(
    "dependabot-commit.yml は、存在するスクリプトを実行し、devcontainer.json もコミットに加える"
)
def test_commit_workflow_runs_an_existing_script_and_adds_devcontainer_json() -> None:
    """`.github/workflows/dependabot-commit.yml` の、playwright-deps の版を同期する step のテストです。実行するスクリプトが存在し、生成したファイルをコミットする step に `.devcontainer/devcontainer.json` が含まれていることを確認します。"""
    with allure.step("dependabot-commit.yml の step を読む"):
        steps = _commit_steps()
        sync = _step(steps, "Sync playwright-deps version")
    with allure.step("実在する script を動かし、devcontainer.json を add することを確かめる"):
        assert sync["run"] == f"node {_SCRIPT}"
        assert (_REPO_ROOT / _SCRIPT).is_file()
        assert ".devcontainer/devcontainer.json" in _step(steps, "Commit generated files")["run"]


@allure.title("dependabot-commit.yml は、コミットの前にイメージの要否を決める")
def test_commit_workflow_decides_image_before_commit() -> None:
    """`dependabot-commit.yml` の、生成したファイルをコミットする step のテストです。`git diff --cached --name-only` が `git commit` より前にあり、`HEAD~1` を使っていないことを確認します。"""
    with allure.step("コミットする step の run を読む"):
        run = _step(_commit_steps(), "Commit generated files")["run"]
    with allure.step("コミットの前にイメージの要否を決めていることを確かめる"):
        assert run.index("git diff --cached --name-only") < run.index("git commit")
        assert "HEAD~1" not in run


@allure.title("dependabot-commit.yml は、push の前にイメージを公開し、公開に失敗しても止めない")
def test_commit_workflow_publishes_image_before_push_without_blocking_it() -> None:
    """`dependabot-commit.yml` の、イメージを公開する step のテストです。GHCR へのログインの結果に依存し、`continue-on-error` と timeout を持ち、ジョブが `packages: write` の権限を持つことを確認します。"""
    with allure.step("dependabot-commit.yml の job と step を読む"):
        job = _workflow("dependabot-commit.yml")["jobs"]["regenerate"]
        steps = job["steps"]
        login = _step(steps, "Log in to GHCR")
        publish = _step(steps, "Publish devcontainer image")
        push = _step(steps, "Push generated files")

    with allure.step("イメージの公開が push の前にあり、止めない作りであることを確かめる"):
        assert login["continue-on-error"] is True
        assert "steps.commit.outputs.image" in login["if"]
        assert "steps.commit.outputs.image" in publish["if"]
        assert "steps.login.outcome" in publish["if"]
        assert publish["continue-on-error"] is True
        assert "timeout-minutes" in publish
        assert "dev-container.sh publish --push" in publish["run"]
        assert "steps.commit.outputs.committed" in push["if"]
        assert _step_index(steps, "Publish devcontainer image") < _step_index(
            steps, "Push generated files"
        )
        assert job["permissions"].get("packages") == "write"


@allure.title("dependabot-commit.yml は、同期に失敗しても push し、最後に失敗で終わる")
def test_commit_workflow_pushes_even_when_sync_fails_and_fails_at_the_end() -> None:
    """`dependabot-commit.yml` の、playwright-deps の同期に失敗した場合のテストです。同期の step が `continue-on-error` を持ち、push の後で同期の結果を見て失敗させる step があることを確認します。"""
    with allure.step("同期の step を読む"):
        steps = _commit_steps()
        sync = _step(steps, "Sync playwright-deps version")
    with allure.step("同期が失敗しても push し、最後に失敗させることを確かめる"):
        assert sync["continue-on-error"] is True
        fail = _step(steps, "Fail when playwright-deps was not synced")
        assert f"steps.{sync['id']}.outcome" in fail["if"]
        assert _step_index(steps, "Push generated files") < _step_index(
            steps, "Fail when playwright-deps was not synced"
        )


@allure.title(
    "dependabot-auto-merge.yml は、更新の種類の許可リストを維持し、依存名の条件を持たない"
)
def test_auto_merge_keeps_the_update_type_allowlist_without_dependency_names() -> None:
    """`.github/workflows/dependabot-auto-merge.yml` の、自動マージの条件のテストです。許可する更新の種類が `semver-minor` と `semver-patch` だけで、`dependency-names` の条件が含まれていないことを確認します。"""
    with allure.step("自動マージの条件を読む"):
        steps = _workflow("dependabot-auto-merge.yml")["jobs"]["auto-merge"]["steps"]
        cond = _step(steps, "Check merge queue")["if"]
        allowed = re.search(r"fromJSON\('(\[[^']*\])'\)", cond)
    with allure.step("更新の種類の許可リストだけで、依存の名前を使わないことを確かめる"):
        assert allowed, cond
        assert yaml.safe_load(allowed.group(1)) == [
            "version-update:semver-minor",
            "version-update:semver-patch",
        ]
        assert "dependency-names" not in cond


@allure.title(
    "devcontainer-image.yml は、Dependabot の PR のうち、アプリの push の実行だけを飛ばす"
)
def test_image_workflow_skips_only_the_app_push_run_of_dependabot_prs() -> None:
    """`.github/workflows/devcontainer-image.yml` の、`build` ジョブの `if` 条件のテストです。条件に `dependabot[bot]` と `github.actor` が含まれていることを確認します。"""
    with allure.step("devcontainer-image.yml の build の条件を読む"):
        cond = _workflow("devcontainer-image.yml")["jobs"]["build"]["if"]
    with allure.step("dependabot の App の push だけを外す条件であることを確かめる"):
        assert "dependabot[bot]" in cond
        assert "github.actor" in cond


@allure.title("devcontainer-image.yml は、イベントと ref から publish の引数を決める")
def test_image_workflow_derives_publish_args_from_event_and_ref() -> None:
    """`devcontainer-image.yml` の、イメージを作成して push する step のテストです。常に `--push` を付け、`main` では `--latest`、`NO_CACHE` が `true` では `--no-cache` を付けることを確認します。"""
    with allure.step("公開の step を読む"):
        steps = _workflow("devcontainer-image.yml")["jobs"]["publish"]["steps"]
        run = _step(steps, "Build and push image")["run"]
    with allure.step("イベントと ref から publish の引数を決めていることを確かめる"):
        assert "dev-container.sh publish" in run
        assert "args=(--push)" in run
        assert re.search(r"\$GITHUB_REF\" = refs/heads/main \]; then\n\s+args\+=\(--latest\)", run)
        assert re.search(r"\$NO_CACHE\" = true \]; then\n\s+args\+=\(--no-cache\)", run)
        env = _step(steps, "Build and push image")["env"]
        assert "github.event_name == 'schedule'" in env["NO_CACHE"]


@allure.title("devcontainer-image.yml は、packages の書き込み権限を、PR ではないジョブにだけ与える")
def test_image_workflow_gives_packages_write_only_to_the_non_pr_job() -> None:
    """`devcontainer-image.yml` の権限のテストです。全体は `contents: read` だけで、PR 用の `build` ジョブは `packages` の権限を持たず、`publish` ジョブだけが `packages: write` を持つことを確認します。"""
    with allure.step("devcontainer-image.yml の権限を読む"):
        wf = _workflow("devcontainer-image.yml")
    with allure.step("packages の書き込みが PR 以外の job だけにあることを確かめる"):
        assert wf["permissions"] == {"contents": "read"}
        build, publish = wf["jobs"]["build"], wf["jobs"]["publish"]
        assert "github.event_name == 'pull_request' &&" in build["if"]
        assert "packages" not in build["permissions"]
        for step in build["steps"]:
            assert "--push" not in step.get("run", "")
            assert "login-action" not in step.get("uses", "")
        assert publish["if"] == "${{ github.event_name != 'pull_request' }}"
        assert publish["permissions"]["packages"] == "write"


@allure.title("devcontainer のベースイメージは digest で固定し、Dependabot が更新を追う設定にする")
def test_devcontainer_base_image_is_pinned_and_followed_by_dependabot() -> None:
    """`.devcontainer/Dockerfile` と `.github/dependabot.yml` のテストです。`FROM` が `sha256` の digest で固定され、`dependabot.yml` に `/.devcontainer` の docker の更新が設定されていることを確認します。"""
    with allure.step("Dockerfile と dependabot.yml を読む"):
        dockerfile = (_REPO_ROOT / ".devcontainer/Dockerfile").read_text(encoding="utf-8")
    with allure.step("ベースイメージが digest で固定され、dependabot が追うことを確かめる"):
        assert re.search(r"^FROM \S+:\S+@sha256:[0-9a-f]{64}$", dockerfile, re.MULTILINE)
        config = yaml.safe_load((_REPO_ROOT / ".github/dependabot.yml").read_text(encoding="utf-8"))
        assert any(
            u["package-ecosystem"] == "docker" and u["directory"] == "/.devcontainer"
            for u in config["updates"]
        )
