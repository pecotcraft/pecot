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


@allure.title("リリース版と開発版の job を、契機に応じて分けて実行する")
def test_release_and_dev_jobs_are_split_by_trigger() -> None:
    """`publish-npm.yml` の job の分け方のテストです。4 つの job が決まった順に存在し、リリース版は手動の起動でタグを指定したときだけ、開発版は push かタグの指定がないときに動くことを確認します。"""
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


@allure.title("1 つのプラグインが失敗しても、ほかのプラグインの job は止めない")
def test_one_failed_plugin_does_not_stop_the_others() -> None:
    """開発版の `build-dev` と `publish-dev` の job のテストです。`fail-fast` が `false` の matrix を使い、`publish-dev` の条件が取り消しとスキップを除外していることを確認します。"""
    with allure.step(
        "build-dev と publish-dev の strategy と条件が、1 つの失敗で他を止めない形であることを確かめる"
    ):
        for name in ("build-dev", "publish-dev"):
            assert _job(name)["strategy"] == {"fail-fast": False, "matrix": {"include": _MATRIX}}
        assert _job("publish-dev")["if"] == (
            "${{ !cancelled() && needs.dev-targets.outputs.plugins != '[]'"
            " && needs.build-dev.result != 'skipped' }}"
        )


@allure.title("push は main だけで、パッケージに影響するファイルの変更でのみ動く")
def test_push_runs_only_on_main_for_files_that_change_a_package() -> None:
    """`publish-npm.yml` の push の契機のテストです。ブランチが main だけで、`paths` が `dev-targets.mjs --patterns` の出力と一致することを確認します。"""
    with allure.step("push の設定を読む"):
        push = _workflow()[True]["push"]
    with allure.step("main だけで、パッケージを変えるファイルの変更に限ることを確かめる"):
        assert push["branches"] == ["main"]
        assert sorted(push["paths"]) == sorted(json.loads(_dev_targets("--patterns").stdout))


@allure.title("push の前のコミットに到達できないと、すべてのプラグインを対象にする")
def test_dev_targets_falls_back_to_all_when_before_is_unreachable() -> None:
    """`Resolve target plugins` の step のテストです。前のコミットが存在するときは差分のファイルから対象を求め、存在しないときは `--all` で全プラグインを対象にすることを確認します。"""
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


@allure.title("手動の起動では、タグを省略でき、dry-run の既定値は false になる")
def test_dispatch_tag_is_optional_and_dry_run_defaults_to_false() -> None:
    """`workflow_dispatch` の入力のテストです。`tag` が必須ではなく、`dry-run` が真偽値で既定値が `false` であることを確認します。"""
    with allure.step("workflow_dispatch の inputs を読む"):
        inputs = _workflow()[True]["workflow_dispatch"]["inputs"]
    with allure.step("tag が任意で、dry-run の既定が false であることを確かめる"):
        assert inputs["tag"]["required"] is False
        assert inputs["dry-run"]["type"] == "boolean"
        assert inputs["dry-run"]["default"] is False


@allure.title("権限は workflow ではなく、job ごとに必要なものだけを付与する")
def test_permissions_are_granted_per_job() -> None:
    """`publish-npm.yml` の権限のテストです。workflow の権限が空で、各 job に `contents`・`packages`・`id-token` が必要な分だけ指定されていることを確認します。"""
    with allure.step("権限が job ごとに渡され、トップが空であることを確かめる"):
        assert _workflow()["permissions"] == {}
        assert _job("publish")["permissions"] == {"contents": "read", "id-token": "write"}
        assert _job("dev-targets")["permissions"] == {"contents": "read"}
        assert _job("build-dev")["permissions"] == {"contents": "read", "packages": "read"}
        assert _job("publish-dev")["permissions"] == {"contents": "read", "id-token": "write"}


@allure.title("リリース・main の開発版・ブランチの開発版は、別のグループで順番に実行する")
def test_release_main_dev_and_branch_runs_queue_in_separate_groups() -> None:
    """`publish-npm.yml` の `concurrency` のテストです。グループ名がタグ、main、ブランチごとに分かれ、`cancel-in-progress` が `false` で、`queue` が `max` であることを確認します。"""
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


@allure.title("開発版の job には、それぞれ実行時間の上限を指定する")
def test_dev_jobs_have_timeouts() -> None:
    """`dev-targets`・`build-dev`・`publish-dev` の `timeout-minutes` が、それぞれ 5 分・45 分・10 分であることを確認するテストです。"""
    with allure.step("dev の job に timeout-minutes があることを確かめる"):
        assert _job("dev-targets")["timeout-minutes"] == 5
        assert _job("build-dev")["timeout-minutes"] == 45
        assert _job("publish-dev")["timeout-minutes"] == 10


@allure.title("リリース版の job は、最初の step で dry-run の指定を拒否する")
def test_release_job_rejects_dry_run_first() -> None:
    """`publish` の job の最初の step のテストです。`DRY_RUN` に入力が渡され、`exit 1` で終了することを確認します。"""
    with allure.step("release の job の最初の step を読む"):
        first = _job("publish")["steps"][0]
    with allure.step("release のタグでは dry-run を最初に拒むことを確かめる"):
        assert first["name"] == "Reject dry-run for a release tag"
        assert first["env"]["DRY_RUN"] == "${{ inputs.dry-run }}"
        assert "exit 1" in first["run"]


@allure.title("開発版のビルドは、main 以外での本番の publish を最初の step で拒否する")
def test_dev_build_rejects_a_real_publish_outside_main_first() -> None:
    """`build-dev` の job の最初の step のテストです。参照が main ではなく、`DRY_RUN` が `true` でない場合を判定していることを確認します。"""
    with allure.step("dev の build の最初の step を読む"):
        first = _job("build-dev")["steps"][0]
    with allure.step("main の外での本番の publish を最初に拒むことを確かめる"):
        assert first["name"] == "Reject a real publish outside main"
        assert '"$REF" != "refs/heads/main"' in first["run"]
        assert '"$DRY_RUN" != "true"' in first["run"]


@allure.title("開発版の publish は next タグと provenance を使い、dry-run の指定に従う")
def test_dev_publish_uses_next_tag_and_honors_dry_run() -> None:
    """`Publish to npm` の step のテストです。`--tag next` と `--provenance` を指定し、dry-run のときは `--dry-run` を追加し、`PACKAGE` の環境変数にパッケージ名が設定されることを確認します。"""
    with allure.step("publish の step の run を読む"):
        run = _step("publish-dev", "Publish to npm")["run"]
    with allure.step("next のタグと provenance を使い、dry-run に従うことを確かめる"):
        assert "--tag next" in run
        assert "--provenance" in run
        assert "args+=(--dry-run)" in run
        assert _job("publish-dev")["env"]["DRY_RUN"] == "${{ inputs.dry-run }}"
        assert _job("publish-dev")["env"]["PACKAGE"] == "@pecot/${{ matrix.name }}-mcp"


@allure.title("開発版の publish は、プラグインごとに版を求め直す")
def test_dev_publish_recomputes_the_version_per_plugin() -> None:
    """`Resolve dev version` の step のテストです。`dev-version.mjs` に `plugin.json` と run 番号を渡し、結果を `VERSION` に保存することを確認します。この step は、`Check if already superseded` より前に実行します。"""
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


@allure.title("開発版の publish は、next より古い run を skip する")
def test_dev_publish_skips_runs_older_than_next() -> None:
    """`Check if already superseded` の step のテストです。`dist-tags.next` と run 番号を `dev-superseded.mjs` に渡し、その結果が `Publish to npm` の実行条件になることを確認します。あわせて、sparse checkout の範囲も確認します。"""
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


@allure.title("開発版の publish は、private のリポジトリでは publish の前に失敗する")
def test_dev_publish_fails_on_a_private_repository_before_publishing() -> None:
    """`publish-dev` の job の step の順序のテストです。`Fail if repository is private` が、`Publish to npm` より前に実行されることを確認します。"""
    with allure.step("publish の job の step の名前を読む"):
        names = [s["name"] for s in _job("publish-dev")["steps"]]
    with allure.step("private のリポでは publish の前に失敗することを確かめる"):
        assert names.index("Fail if repository is private") < names.index("Publish to npm")


@allure.title(
    "開発版のビルドは、共有のディレクトリにパッケージを作り、artifact としてアップロードする"
)
def test_dev_build_packs_into_the_shared_directory() -> None:
    """`build-dev` の job のテストです。`--pack-destination` が共有のディレクトリを指し、アップロードの名前とパスが決まり、`publish-dev` が同じ名前の artifact をダウンロードすることを確認します。"""
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


@allure.title("開発版のビルドは、pecot-visual の場合に監査してからビルドする")
def test_dev_build_audits_visual_before_building() -> None:
    """`Build dev package` の step のテストです。`PLUGIN` が `pecot-visual` のときだけ `audit-mcp-dist.sh --dev` を実行し、その後で `publish-mcp-dist.sh` を実行することを確認します。"""
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


@allure.title("すべての action は、40 桁の SHA で固定する")
def test_every_action_is_pinned_to_a_full_sha() -> None:
    """`publish-npm.yml` のすべての `uses` のテストです。参照が `owner/repo@<40 桁の 16 進数>` の形であることを確認します。"""
    with allure.step("すべての action が 40 桁の sha で固定されていることを確かめる"):
        for name, job in _workflow()["jobs"].items():
            for step in job["steps"]:
                if "uses" in step:
                    assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", step["uses"]), (name, step["uses"])


@allure.title("シェルのスクリプトに、日本語を書かない")
def test_no_japanese_in_shell() -> None:
    """`publish-npm.yml` の `run` と `runCmd` のテストです。ASCII 以外の文字が含まれないことを確認します。"""
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


@allure.title("`dev-version.mjs` は、パッチの版を 1 つ上げて、run 番号を付ける")
def test_dev_version_bumps_patch_and_appends_run_number(tmp_path: Path) -> None:
    """`dev-version.mjs` に版 `7.0.0` と run 番号 `123` を渡した場合のテストです。終了コードが 0 になり、`7.0.1-dev.123` を出力することを確認します。"""
    with allure.step("版 7.0.0 と run 番号 123 で dev-version.mjs を動かす"):
        result = _dev_version(tmp_path, "7.0.0", "123")
    with allure.step("patch を上げ、run 番号を付けた版が出ることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert result.stdout == "7.0.1-dev.123\n"


@allure.title(
    "`dev-version.mjs` は、版 {version} と run 番号 {run_number} を渡すと、エラーで終了する"
)
@pytest.mark.parametrize(
    ("version", "run_number"),
    [("7.0.0-dev.1", "1"), ("7.0", "1"), (7, "1"), ("7.0.0", "0"), ("7.0.0", "12a")],
)
def test_dev_version_rejects_malformed_input(
    tmp_path: Path, version: object, run_number: str
) -> None:
    """`dev-version.mjs` に、開発版の版・桁の足りない版・数値の版・不正な run 番号を渡した場合のテストです。終了コードが 1 になり、標準出力が空で、標準エラー出力が `ERROR: ` で始まることを確認します。"""
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


@allure.title(
    "next の版 {next_version} と run 番号 {run_number} を渡すと、`dev-superseded.mjs` は {expected} を出力する"
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
    """`dev-superseded.mjs` が、run が next より新しいかを判定する場合のテストです。next が空か run が新しい場合は `false`、run が同じか古い場合は `true` を出力することを確認します。"""
    with allure.step("next の版と run 番号で dev-superseded.mjs を動かす"):
        result = _dev_superseded(next_version, run_number)
    with allure.step("next より新しい実行だけが false になることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert result.stdout == f"{expected}\n"


@allure.title("`dev-superseded.mjs` は、run 番号が {run_number} のとき、エラーで終了する")
@pytest.mark.parametrize("run_number", ["", "0", "12a"])
def test_dev_superseded_rejects_malformed_run_number(run_number: str) -> None:
    """`dev-superseded.mjs` に、空・0・数字ではない run 番号を渡した場合のテストです。終了コードが 1 になり、標準出力が空で、標準エラー出力が `ERROR: ` で始まることを確認します。"""
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


@allure.title(
    "変更ファイルが {files} のとき、`dev-targets.mjs` は対象のプラグインを {expected} に決める"
)
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
    """`dev-targets.mjs` に変更ファイルの一覧を渡す場合のテストです。プラグインやライブラリのファイルは対応するプラグインに、共通の設定は全プラグインに対応し、無関係なファイルは対象外になることを確認します。"""
    with allure.step(
        "変更したファイルの一覧から対象のプラグインを決め、期待と一致することを確かめる"
    ):
        assert _targets(files) == expected


@allure.title("`dev-targets.mjs --all` は、全プラグインのプラグイン名とパッケージ名を出力する")
def test_dev_targets_all_gives_plugin_and_package_names() -> None:
    """`dev-targets.mjs` を `--all` で実行した場合のテストです。終了コードが 0 になり、3 つのプラグインの `plugin` と `name` を JSON で出力することを確認します。"""
    with allure.step("dev-targets.mjs を --all で動かす"):
        result = _dev_targets("--all")
    with allure.step("プラグイン名とパッケージ名の一覧が出ることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == [
            {"plugin": "pecot-visual", "name": "visual"},
            {"plugin": "pecot-tools", "name": "tools"},
            {"plugin": "pecot-workflow", "name": "workflow"},
        ]


@allure.title("push の契機の `paths` に指定したパスは、すべていずれかのプラグインに対応する")
def test_dev_targets_every_push_path_reaches_a_plugin() -> None:
    """`publish-npm.yml` の push の `paths` のテストです。各パターンから作ったサンプルのパスが、`dev-targets.mjs` でいずれかのプラグインに対応することを確認します。"""
    with allure.step("push の paths のそれぞれが、どれかのプラグインに届くことを確かめる"):
        for pattern in _workflow()[True]["push"]["paths"]:
            sample = pattern.replace("**", "x")
            assert _targets([sample]), pattern


@allure.title("`dev-targets.mjs` は、引数が {args} のとき、エラーで終了する")
@pytest.mark.parametrize("args", [["--bogus"], ["--all", "--patterns"]])
def test_dev_targets_rejects_unknown_arguments(args: list[str]) -> None:
    """`dev-targets.mjs` に、未知の引数や併用できない引数を渡した場合のテストです。終了コードが 1 になり、標準出力が空で、標準エラー出力が `ERROR: ` で始まることを確認します。"""
    with allure.step("知らない引数で dev-targets.mjs を動かす"):
        result = _dev_targets(*args)
    with allure.step("終了コード 1 で、ERROR だけが出ることを確かめる"):
        assert result.returncode == 1
        assert result.stdout == ""
        assert result.stderr.startswith("ERROR: ")
