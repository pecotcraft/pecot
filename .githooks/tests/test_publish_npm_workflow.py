"""publish-npm.yml の静的な確認と、開発版のスクリプト（dev-version・dev-superseded・dev-targets）の出力。

npm への publish は main でしか試せないため、job の分け方と権限を merge 前にここで固定する。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import allure
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import run_attached  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = _REPO_ROOT / ".github/workflows/publish-npm.yml"
_DEV_VERSION = _REPO_ROOT / ".githooks/scripts/dev-version.mjs"
_NODE = shutil.which("node") or "node"


def _workflow() -> dict:
    return yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))


def _job(name: str) -> dict:
    return _workflow()["jobs"][name]


def _step(job: str, name: str) -> dict:
    step = next((s for s in _job(job)["steps"] if s.get("name") == name), None)
    assert step is not None, f"{job} に step が無い: {name}"
    return step


_MATRIX = "${{ fromJSON(needs.dev-targets.outputs.plugins) }}"


def test_release_and_dev_jobs_are_split_by_trigger() -> None:
    with allure.step("publish-npm.yml の job を読む"):
        jobs = _workflow()["jobs"]
    with allure.step("release と dev の job が、起動の種類で分かれることを確かめる"):
        assert list(jobs) == ["publish", "dev-targets", "build-dev", "publish-dev"]
        assert (
            jobs["publish"]["if"]
            == "${{ github.event_name == 'workflow_dispatch' && inputs.tag != '' }}"
        )
        assert jobs["dev-targets"]["if"] == "${{ github.event_name == 'push' || inputs.tag == '' }}"
        assert jobs["build-dev"]["needs"] == "dev-targets"
        assert jobs["build-dev"]["if"] == "${{ needs.dev-targets.outputs.plugins != '[]' }}"
        assert jobs["publish-dev"]["needs"] == ["dev-targets", "build-dev"]


def test_one_failed_plugin_does_not_stop_the_others() -> None:
    with allure.step(
        "build-dev と publish-dev の strategy と条件が、1 つの失敗で他を止めない形であることを確かめる"
    ):
        for name in ("build-dev", "publish-dev"):
            assert _job(name)["strategy"] == {"fail-fast": False, "matrix": {"include": _MATRIX}}
        assert _job("publish-dev")["if"] == (
            "${{ !cancelled() && needs.dev-targets.outputs.plugins != '[]'"
            " && needs.build-dev.result != 'skipped' }}"
        )


def test_push_runs_only_on_main_for_files_that_change_a_package() -> None:
    with allure.step("push の設定を読む"):
        push = _workflow()[True]["push"]
    with allure.step("main だけで、パッケージを変えるファイルの変更に限ることを確かめる"):
        assert push["branches"] == ["main"]
        assert sorted(push["paths"]) == sorted(json.loads(_dev_targets("--patterns").stdout))


def test_dev_targets_falls_back_to_all_when_before_is_unreachable() -> None:
    with allure.step("対象のプラグインを決める step の run を読む"):
        run = _step("dev-targets", "Resolve target plugins")["run"]
    with allure.step("before に届かないときは全部を対象にする作りであることを確かめる"):
        assert "set -euo pipefail" in run
        assert 'git cat-file -e "${BEFORE}^{commit}"' in run
        assert (
            'git diff --name-only --no-renames "$BEFORE" "$SHA" | node .githooks/scripts/dev-targets.mjs'
            in run
        )
        assert "node .githooks/scripts/dev-targets.mjs --all" in run
        assert "jq -e 'type == \"array\"'" in run
        assert _step("dev-targets", "Checkout")["with"]["fetch-depth"] == 0


def test_dispatch_tag_is_optional_and_dry_run_defaults_to_false() -> None:
    with allure.step("workflow_dispatch の inputs を読む"):
        inputs = _workflow()[True]["workflow_dispatch"]["inputs"]
    with allure.step("tag が任意で、dry-run の既定が false であることを確かめる"):
        assert inputs["tag"]["required"] is False
        assert inputs["dry-run"]["type"] == "boolean"
        assert inputs["dry-run"]["default"] is False


def test_permissions_are_granted_per_job() -> None:
    with allure.step("権限が job ごとに渡され、トップが空であることを確かめる"):
        assert _workflow()["permissions"] == {}
        assert _job("publish")["permissions"] == {"contents": "read", "id-token": "write"}
        assert _job("dev-targets")["permissions"] == {"contents": "read"}
        assert _job("build-dev")["permissions"] == {"contents": "read", "packages": "read"}
        assert _job("publish-dev")["permissions"] == {"contents": "read", "id-token": "write"}


def test_release_main_dev_and_branch_runs_queue_in_separate_groups() -> None:
    with allure.step("concurrency の設定を読む"):
        concurrency = _workflow()["concurrency"]
    with allure.step("release・main の dev・ブランチの実行が別の group で並ぶことを確かめる"):
        assert concurrency["group"] == (
            "publish-npm-${{ inputs.tag || (github.ref == 'refs/heads/main' && 'dev')"
            " || format('dev-{0}', github.ref) }}"
        )
        assert concurrency["cancel-in-progress"] is False
        # single は待っている run を取り消し、その run だけが出すプラグインの開発版が出ない。
        assert concurrency["queue"] == "max"


def test_dev_jobs_have_timeouts() -> None:
    with allure.step("dev の job に timeout-minutes があることを確かめる"):
        assert _job("dev-targets")["timeout-minutes"] == 5
        assert _job("build-dev")["timeout-minutes"] == 45
        assert _job("publish-dev")["timeout-minutes"] == 10


def test_release_job_rejects_dry_run_first() -> None:
    with allure.step("release の job の最初の step を読む"):
        first = _job("publish")["steps"][0]
    with allure.step("release のタグでは dry-run を最初に拒むことを確かめる"):
        assert first["name"] == "Reject dry-run for a release tag"
        assert first["env"]["DRY_RUN"] == "${{ inputs.dry-run }}"
        assert "exit 1" in first["run"]


def test_dev_build_rejects_a_real_publish_outside_main_first() -> None:
    with allure.step("dev の build の最初の step を読む"):
        first = _job("build-dev")["steps"][0]
    with allure.step("main の外での本番の publish を最初に拒むことを確かめる"):
        assert first["name"] == "Reject a real publish outside main"
        assert '"$REF" != "refs/heads/main"' in first["run"]
        assert '"$DRY_RUN" != "true"' in first["run"]


def test_dev_publish_uses_next_tag_and_honors_dry_run() -> None:
    with allure.step("publish の step の run を読む"):
        run = _step("publish-dev", "Publish to npm")["run"]
    with allure.step("next のタグと provenance を使い、dry-run に従うことを確かめる"):
        assert "--tag next" in run
        assert "--provenance" in run
        assert "args+=(--dry-run)" in run
        assert _job("publish-dev")["env"]["DRY_RUN"] == "${{ inputs.dry-run }}"
        assert _job("publish-dev")["env"]["PACKAGE"] == "@pecot/${{ matrix.name }}-mcp"


def test_dev_publish_recomputes_the_version_per_plugin() -> None:
    with allure.step("版を決める step を読む"):
        step = _step("publish-dev", "Resolve dev version")
    with allure.step("プラグインごとに版を決め直し、取り下げの確かめより前にあることを確かめる"):
        assert (
            'node .githooks/scripts/dev-version.mjs "plugins/$PLUGIN/.claude-plugin/plugin.json"'
            ' "$RUN_NUMBER"' in step["run"]
        )
        assert 'echo "VERSION=$version" >> "$GITHUB_ENV"' in step["run"]
        assert "outputs" not in _job("build-dev")
        names = [s["name"] for s in _job("publish-dev")["steps"]]
        assert names.index("Resolve dev version") < names.index("Check if already superseded")


def test_dev_publish_skips_runs_older_than_next() -> None:
    with allure.step("取り下げの確かめの step を読む"):
        step = _step("publish-dev", "Check if already superseded")
    with allure.step("next より古い実行を飛ばす作りであることを確かめる"):
        assert "dist-tags.next" in step["run"]
        assert 'node .githooks/scripts/dev-superseded.mjs "$next" "$RUN_NUMBER"' in step["run"]
        assert step["env"]["RUN_NUMBER"] == "${{ github.run_number }}"
        assert (
            _step("publish-dev", "Publish to npm")["if"]
            == "steps.published.outputs.done == 'false'"
        )
        checkout = _step("publish-dev", "Checkout")["with"]
        assert checkout["sparse-checkout"].splitlines() == [
            ".githooks/scripts/dev-superseded.mjs",
            ".githooks/scripts/dev-version.mjs",
            "plugins/${{ matrix.plugin }}/.claude-plugin/plugin.json",
        ]
        assert checkout["sparse-checkout-cone-mode"] is False


def test_dev_publish_fails_on_a_private_repository_before_publishing() -> None:
    with allure.step("publish の job の step の名前を読む"):
        names = [s["name"] for s in _job("publish-dev")["steps"]]
    with allure.step("private のリポでは publish の前に失敗することを確かめる"):
        assert names.index("Fail if repository is private") < names.index("Publish to npm")


def test_dev_build_packs_into_the_shared_directory() -> None:
    with allure.step("dev の build の run を読む"):
        run_cmd = _step("build-dev", "Build dev package")["with"]["runCmd"]
    with allure.step("共有のディレクトリに pack し、upload と download の名前が合うことを確かめる"):
        assert '--out-dir="$out"' in run_cmd
        assert "--dry-run" in run_cmd
        assert "--pack-destination /workspaces/base/pecot/.pecot/tmp/dev-publish" in run_cmd
        upload = _step("build-dev", "Upload package")["with"]
        assert upload["name"] == "${{ matrix.name }}-mcp-dev"
        assert upload["path"] == ".pecot/tmp/dev-publish/*.tgz"
        assert upload["if-no-files-found"] == "error"
        download = _step("publish-dev", "Download package")["with"]
        assert download["name"] == "${{ matrix.name }}-mcp-dev"


def test_dev_build_audits_visual_before_building() -> None:
    with allure.step("dev の build の step を読む"):
        step = _step("build-dev", "Build dev package")
        run_cmd = step["with"]["runCmd"]
        audit = (
            'if [ "$PLUGIN" = "pecot-visual" ]; then'
            " bash plugins/pecot-visual/scripts/release/audit-mcp-dist.sh --dev; fi"
        )
        build = 'bash "plugins/$PLUGIN/scripts/release/publish-mcp-dist.sh" --dry-run'
    with allure.step("pecot-visual は build の前に audit することを確かめる"):
        # --dev が抜けると記録が skipped になり、publish の dry-run は突合なしで通る。
        assert audit in run_cmd
        assert build in run_cmd
        assert run_cmd.index(audit) < run_cmd.index(build)
        assert step["env"]["PLUGIN"] == "${{ matrix.plugin }}"
        assert "PLUGIN" in step["with"]["env"].split()


def test_every_action_is_pinned_to_a_full_sha() -> None:
    with allure.step("すべての action が 40 桁の sha で固定されていることを確かめる"):
        for name, job in _workflow()["jobs"].items():
            for step in job["steps"]:
                if "uses" in step:
                    assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", step["uses"]), (name, step["uses"])


def test_no_japanese_in_shell() -> None:
    with allure.step("すべての run に日本語が無いことを確かめる"):
        for name, job in _workflow()["jobs"].items():
            for step in job["steps"]:
                for text in (step.get("run", ""), step.get("with", {}).get("runCmd", "")):
                    assert not re.search(r"[^\x00-\x7f]", text), (name, step["name"])


def _dev_version(
    tmp_path: Path, version: object, run_number: str
) -> subprocess.CompletedProcess[str]:
    manifest = tmp_path / "plugin.json"
    manifest.write_text(json.dumps({"name": "pecot-w", "version": version}), encoding="utf-8")
    return run_attached(
        [_NODE, str(_DEV_VERSION), str(manifest), run_number],
        capture_output=True,
        text=True,
        check=False,
    )


def test_dev_version_bumps_patch_and_appends_run_number(tmp_path: Path) -> None:
    with allure.step("版 7.0.0 と run 番号 123 で dev-version.mjs を動かす"):
        result = _dev_version(tmp_path, "7.0.0", "123")
    with allure.step("patch を上げ、run 番号を付けた版が出ることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert result.stdout == "7.0.1-dev.123\n"


@pytest.mark.parametrize(
    ("version", "run_number"),
    [("7.0.0-dev.1", "1"), ("7.0", "1"), (7, "1"), ("7.0.0", "0"), ("7.0.0", "12a")],
)
def test_dev_version_rejects_malformed_input(
    tmp_path: Path, version: object, run_number: str
) -> None:
    with allure.step("不正な版か run 番号で dev-version.mjs を動かす"):
        result = _dev_version(tmp_path, version, run_number)
    with allure.step("終了コード 1 で、ERROR だけが出ることを確かめる"):
        assert result.returncode == 1
        assert result.stdout == ""
        assert result.stderr.startswith("ERROR: ")


_DEV_SUPERSEDED = _REPO_ROOT / ".githooks/scripts/dev-superseded.mjs"


def _dev_superseded(next_version: str, run_number: str) -> subprocess.CompletedProcess[str]:
    return run_attached(
        [_NODE, str(_DEV_SUPERSEDED), next_version, run_number],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize(
    ("next_version", "run_number", "expected"),
    [
        ("", "5", "false"),
        ("7.0.1-dev.5", "4", "true"),
        ("7.0.1-dev.5", "5", "true"),
        ("7.0.1-dev.5", "6", "false"),
        ("8.0.0", "6", "false"),
        ("7.0.1-dev.12\n", "9", "true"),
    ],
)
def test_dev_superseded_skips_runs_not_newer_than_next(
    next_version: str, run_number: str, expected: str
) -> None:
    with allure.step("next の版と run 番号で dev-superseded.mjs を動かす"):
        result = _dev_superseded(next_version, run_number)
    with allure.step("next より新しい実行だけが false になることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert result.stdout == f"{expected}\n"


@pytest.mark.parametrize("run_number", ["", "0", "12a"])
def test_dev_superseded_rejects_malformed_run_number(run_number: str) -> None:
    with allure.step("不正な run 番号で dev-superseded.mjs を動かす"):
        result = _dev_superseded("7.0.1-dev.5", run_number)
    with allure.step("終了コード 1 で、ERROR だけが出ることを確かめる"):
        assert result.returncode == 1
        assert result.stdout == ""
        assert result.stderr.startswith("ERROR: ")


_DEV_TARGETS = _REPO_ROOT / ".githooks/scripts/dev-targets.mjs"
_ALL = ["pecot-visual", "pecot-tools", "pecot-workflow"]


def _dev_targets(*args: str, files: str = "") -> subprocess.CompletedProcess[str]:
    return run_attached(
        [_NODE, str(_DEV_TARGETS), *args],
        input=files,
        capture_output=True,
        text=True,
        check=False,
    )


def _targets(files: list[str]) -> list[str]:
    result = _dev_targets(files="\n".join(files) + "\n")
    assert result.returncode == 0, result.stderr
    return [t["plugin"] for t in json.loads(result.stdout)]


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        (["plugins/pecot-tools/cli/src/index.ts"], ["pecot-tools"]),
        (["plugins/pecot-visual/SKILL.md"], ["pecot-visual"]),
        (["libs/text-rules/src/index.ts"], ["pecot-visual"]),
        (["libs/workflow-core/src/domain/config.ts"], ["pecot-workflow"]),
        (
            ["plugins/pecot-workflow/cli/a.ts", "plugins/pecot-tools/b.ts"],
            ["pecot-tools", "pecot-workflow"],
        ),
        (["pnpm-lock.yaml"], _ALL),
        ([".devcontainer/Dockerfile", "plugins/pecot-tools/b.ts"], _ALL),
        ([".github/workflows/publish-npm.yml"], _ALL),
        (["libs/interface-spec/x.ts", "plugins/pecot-toolsx/a"], []),
        ([], []),
    ],
)
def test_dev_targets_maps_changed_files_to_plugins(files: list[str], expected: list[str]) -> None:
    with allure.step(
        "変更したファイルの一覧から対象のプラグインを決め、期待と一致することを確かめる"
    ):
        assert _targets(files) == expected


def test_dev_targets_all_gives_plugin_and_package_names() -> None:
    with allure.step("dev-targets.mjs を --all で動かす"):
        result = _dev_targets("--all")
    with allure.step("プラグイン名とパッケージ名の一覧が出ることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == [
            {"plugin": "pecot-visual", "name": "visual"},
            {"plugin": "pecot-tools", "name": "tools"},
            {"plugin": "pecot-workflow", "name": "workflow"},
        ]


def test_dev_targets_every_push_path_reaches_a_plugin() -> None:
    with allure.step("push の paths のそれぞれが、どれかのプラグインに届くことを確かめる"):
        for pattern in _workflow()[True]["push"]["paths"]:
            sample = pattern.replace("**", "x")
            assert _targets([sample]), pattern


@pytest.mark.parametrize("args", [["--bogus"], ["--all", "--patterns"]])
def test_dev_targets_rejects_unknown_arguments(args: list[str]) -> None:
    with allure.step("知らない引数で dev-targets.mjs を動かす"):
        result = _dev_targets(*args)
    with allure.step("終了コード 1 で、ERROR だけが出ることを確かめる"):
        assert result.returncode == 1
        assert result.stdout == ""
        assert result.stderr.startswith("ERROR: ")
