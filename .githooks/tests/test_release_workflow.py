"""release.yml の静的な確認と、release-land.sh の実際の動き。

本番の流れは main でしか動かせないため、構造と land のスクリプトを merge 前にここで固定する。
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import allure
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = _REPO_ROOT / ".github/workflows/release.yml"
_LAND = _REPO_ROOT / ".githooks/scripts/release-land.sh"
_REAL_GIT = shutil.which("git") or "git"


def _workflow() -> dict:
    return yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))


def _steps() -> list[dict]:
    return _workflow()["jobs"]["release"]["steps"]


def _step(name: str) -> dict:
    step = next((s for s in _steps() if s.get("name") == name), None)
    assert step is not None, f"step が無い: {name}"
    return step


def _run_cmd() -> str:
    return _step("Run release")["with"]["runCmd"]


@allure.title("リリースの workflow は、release-plan の environment で 1 つの job を実行する")
def test_single_job_runs_in_release_plan_environment() -> None:
    """`release.yml` の job のテストです。job が `release` の 1 つだけで、environment が `release-plan` であることを確認します。"""
    with allure.step("release.yml の workflow を読む"):
        wf = _workflow()
    with allure.step("job が 1 つで、release-plan の environment で動くことを確かめる"):
        assert list(wf["jobs"]) == ["release"]
        assert wf["jobs"]["release"]["environment"] == "release-plan"


@allure.title("手動の起動で dry-run の指定を省略すると、dry-run で実行する")
def test_inputs_default_to_dry_run() -> None:
    """`release.yml` の `workflow_dispatch` の入力のテストです。`dry-run` が真偽値で既定値が `true`、`sha` が文字列であることを確認します。"""
    with allure.step("workflow_dispatch の inputs を読む"):
        inputs = _workflow()[True]["workflow_dispatch"]["inputs"]
    with allure.step("dry-run の既定が true で、sha が文字列であることを確かめる"):
        assert inputs["dry-run"]["type"] == "boolean"
        assert inputs["dry-run"]["default"] is True
        assert inputs["sha"]["type"] == "string"


@allure.title("sha の形式を確認した後に、入力の sha を checkout する")
def test_checkout_uses_input_sha_after_the_sha_form_is_checked() -> None:
    """`release.yml` の step の順序のテストです。`Check sha input` が `Checkout` より前に実行され、checkout の `ref` が入力の `sha` か `github.sha` になることを確認します。"""
    with allure.step("step の並びを読む"):
        names = [s.get("name") for s in _steps()]
    with allure.step("sha の形を確かめた後に、入力の sha で checkout することを確かめる"):
        assert names.index("Check sha input") < names.index("Checkout")
        assert _step("Checkout")["with"]["ref"] == "${{ inputs.sha || github.sha }}"


@allure.title("入力は、文字列として扱う `github.event.inputs` を使わない")
def test_does_not_use_stringly_typed_inputs() -> None:
    """`release.yml` の全文のテストです。`github.event.inputs` が含まれないことを確認します。"""
    with allure.step("workflow の本文に github.event.inputs が無いことを確かめる"):
        assert "github.event.inputs" not in _WORKFLOW.read_text(encoding="utf-8")


@allure.title("App のトークンの権限は、dry-run の指定に応じて変わる")
def test_token_permissions_follow_dry_run() -> None:
    """`Generate GitHub App token` の step のテストです。dry-run のときは `contents` を `read` にして `actions` を付与せず、本番のときは `write` にします。脆弱性に関する 3 つの権限は、常に `read` であることを確認します。"""
    with allure.step("App token の step の権限を読む"):
        with_ = _step("Generate GitHub App token")["with"]
    with allure.step("権限が dry-run に従い、読み取りの権限が read であることを確かめる"):
        assert with_["permission-contents"] == "${{ inputs.dry-run && 'read' || 'write' }}"
        assert with_["permission-actions"] == "${{ !inputs.dry-run && 'write' || '' }}"
        for key in (
            "permission-vulnerability-alerts",
            "permission-security-events",
            "permission-secret-scanning-alerts",
        ):
            assert with_[key] == "read"


@allure.title("シェルのスクリプトに、日本語を書かない")
def test_no_japanese_in_shell() -> None:
    """`release.yml` の `run` と `runCmd` のテストです。ASCII 以外の文字が含まれないことを確認します。"""
    with allure.step("すべての step の run に日本語が無いことを確かめる"):
        for step in _steps():
            for text in (step.get("run", ""), step.get("with", {}).get("runCmd", "")):
                assert not re.search(r"[^\x00-\x7f]", text), step["name"]


@allure.title("release の job は、actions の書き込み権限を持たない")
def test_release_job_has_no_actions_write() -> None:
    """`release.yml` の権限のテストです。workflow の権限が `contents` と `packages` の読み取りだけで、job ごとの権限の指定が存在しないことを確認します。"""
    with allure.step("workflow の権限を読む"):
        wf = _workflow()
    with allure.step("job に権限が無く、actions の write が無いことを確かめる"):
        assert wf["permissions"] == {"contents": "read", "packages": "read"}
        assert "permissions" not in wf["jobs"]["release"]


@allure.title("リリース版のサイトのビルドは、本番のリリースが main に反映された後にだけ起動する")
def test_pages_release_build_is_triggered_after_land_in_production_only() -> None:
    """`Trigger pages release build` の step のテストです。`Run release` の後に動き、dry-run でないときだけ実行され、`land.log` を確認してから `pages-build.yml` を `side=release` で起動することを確認します。"""
    with allure.step("step の並びと Pages のビルドを起こす step を読む"):
        names = [s.get("name") for s in _steps()]
        step = _step("Trigger pages release build")
    with allure.step("land の後で、本番のときだけ起こすことを確かめる"):
        assert names.index("Run release") < names.index("Trigger pages release build")
        assert names.index("Trigger pages release build") < names.index("Write job summary")
        # nx が落ちても land が済んでいれば起こすので、step の成否ではなく land.log を見る。
        assert step["if"] == "${{ !cancelled() && !inputs.dry-run }}"
        assert step["env"]["GH_TOKEN"] == "${{ steps.app-token.outputs.token }}"
        assert "grep -q '^landed:' .pecot/tmp/release/land.log" in step["run"]
        assert (
            'gh workflow run pages-build.yml --repo "$REPO" --ref main -f side=release'
            in step["run"]
        )


@allure.title("land.log が {param_id} のとき、リリース版のサイトのビルドを起動するかを決める")
@pytest.mark.parametrize(
    ("land_log", "called"),
    [
        ("landed: abc1234 (fast-forward)\n", True),
        ("skipped: no release commit\n", False),
        ("error: merge conflict (branch: release/run-1-1)\n", False),
        (None, False),
    ],
    ids=["landed", "skipped", "error", "no-log"],
)
def test_pages_release_build_trigger_reads_land_log(
    tmp_path: Path, land_log: str | None, called: bool
) -> None:
    """偽の `gh` を使って `Trigger pages release build` の step を実行した場合のテストです。`land.log` が `landed:` で始まる場合だけ `gh workflow run` が呼ばれ、それ以外の場合は呼ばれないことを確認します。"""
    with allure.step("land.log と偽の gh を置き、Pages のビルドを起こす step の run を動かす"):
        if land_log is not None:
            (tmp_path / ".pecot/tmp/release").mkdir(parents=True)
            (tmp_path / ".pecot/tmp/release/land.log").write_text(land_log, encoding="utf-8")
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        calls = tmp_path / "gh-calls"
        gh = bin_dir / "gh"
        gh.write_text(f'#!/bin/sh\necho "$*" >> {calls}\n', encoding="utf-8")
        gh.chmod(0o755)
        env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "REPO": "o/r"}
        result = run_attached(
            ["bash", "-e", "-c", _step("Trigger pages release build")["run"]],
            cwd=tmp_path,
            env=env,
            text=True,
            capture_output=True,
        )
    with allure.step("land.log の内容に応じて gh を呼ぶか確かめる"):
        assert result.returncode == 0, result.stderr
        if called:
            assert read_output(calls) == (
                "workflow run pages-build.yml --repo o/r --ref main -f side=release\n"
            )
        else:
            assert not calls.exists()


@allure.title("`release-land.sh` には、実行権限が付いている")
def test_land_script_is_executable() -> None:
    """`.githooks/scripts/release-land.sh` が存在し、所有者の実行権限が付いていることを確認するテストです。"""
    with allure.step("land.sh が実在し、実行できることを確かめる"):
        assert _LAND.is_file()
        assert _LAND.stat().st_mode & stat.S_IXUSR


# ---- git のフィクスチャ ----


def _env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_CONFIG_GLOBAL="/dev/null",
        GIT_CONFIG_SYSTEM="/dev/null",
        GIT_AUTHOR_NAME="t",
        GIT_AUTHOR_EMAIL="t@example.com",
        GIT_COMMITTER_NAME="t",
        GIT_COMMITTER_EMAIL="t@example.com",
    )
    env.update(extra or {})
    return env


def _git(
    cwd: Path, *args: str, env: dict[str, str] | None = None, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return run_attached(
        ["git", *args], cwd=cwd, env=_env(env), text=True, capture_output=True, check=check
    )


def _out(cwd: Path, *args: str) -> str:
    return _git(cwd, *args).stdout.strip()


def _commit_file(repo: Path, name: str, content: str, message: str) -> str:
    (repo / name).write_text(content, encoding="utf-8")
    _git(repo, "add", name)
    _git(repo, "commit", "-q", "-m", message)
    return _out(repo, "rev-parse", "HEAD")


def _advance_main(other: Path, name: str, content: str) -> str:
    _git(other, "fetch", "-q", "origin")
    _git(other, "checkout", "-q", "--detach", "origin/main")
    sha = _commit_file(other, name, content, f"feat: advance {name}")
    _git(other, "push", "-q", "origin", "HEAD:refs/heads/main")
    return sha


class Scene:
    def __init__(self, root: Path) -> None:
        self.origin = root / "origin.git"
        self.work = root / "work"
        self.other = root / "other"
        self.branch = "release/run-1-1"
        _git(root, "init", "-q", "--bare", "-b", "main", str(self.origin))
        _git(root, "clone", "-q", str(self.origin), str(self.work))
        _git(self.work, "checkout", "-q", "-b", "main")
        self.base = _commit_file(self.work, "CHANGELOG.md", "base\n", "chore: base")
        _git(self.work, "push", "-q", "origin", "main")
        _git(root, "clone", "-q", str(self.origin), str(self.other))

    def release(self, *, commit: bool = True, file: str = "version.txt", push: bool = True) -> str:
        _git(self.work, "switch", "-q", "-c", self.branch)
        if commit:
            _commit_file(self.work, file, "1.0.0\n", "chore(release): publish")
            _git(self.work, "tag", "-a", "v1.0.0", "-m", "v1.0.0")
        if push:
            _git(self.work, "push", "-q", "--follow-tags", "origin", self.branch)
        return _out(self.work, "rev-parse", "HEAD")

    def land(self, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return run_attached(
            ["bash", str(_LAND), self.base, self.branch],
            cwd=self.work,
            env=_env(env),
            text=True,
            capture_output=True,
        )

    def origin_ref(self, ref: str) -> str:
        return _git(self.origin, "rev-parse", "--verify", "-q", ref, check=False).stdout.strip()


@pytest.fixture
def scene(tmp_path: Path) -> Scene:
    return Scene(tmp_path)


def _push_shim(tmp_path: Path, scene: Scene, times: int) -> dict[str, str]:
    """push の直前に別の clone から main を進める git の shim。times 回まで進める。"""
    shim_dir = tmp_path / "shim"
    shim_dir.mkdir()
    counter = tmp_path / "counter"
    counter.write_text("0", encoding="utf-8")
    shim = shim_dir / "git"
    shim.write_text(
        f"""#!/usr/bin/env bash
if [ "${{1:-}}" = push ]; then
  n=$(cat {counter})
  if [ "$n" -lt {times} ]; then
    echo $((n + 1)) > {counter}
    "{_REAL_GIT}" -C {scene.other} fetch -q origin
    "{_REAL_GIT}" -C {scene.other} checkout -q --detach origin/main
    echo "$n" > {scene.other}/adv-$n.txt
    "{_REAL_GIT}" -C {scene.other} add .
    "{_REAL_GIT}" -C {scene.other} commit -q -m "feat: advance $n"
    "{_REAL_GIT}" -C {scene.other} push -q origin HEAD:refs/heads/main
  fi
fi
exec "{_REAL_GIT}" "$@"
""",
        encoding="utf-8",
    )
    shim.chmod(0o755)
    return {"PATH": f"{shim_dir}{os.pathsep}{os.environ['PATH']}"}


# ---- push の前提 ----


_NX_PUSH_ENV = {
    "GIT_CONFIG_COUNT": "1",
    "GIT_CONFIG_KEY_0": "push.default",
    "GIT_CONFIG_VALUE_0": "current",
}


@allure.title("ローカルの main が進んでいても、nx と同じ形の push はブランチとタグだけを送信する")
def test_nx_style_push_moves_only_branch_and_tag_even_when_local_main_is_ahead(
    scene: Scene,
) -> None:
    """ローカルの main にだけコミットがある状態で、nx と同じ引数の `git push` を実行した場合のテストです。リリースのブランチとタグだけが origin に反映され、origin の main は変わらないことを確認します。"""
    with allure.step("ローカルの main を進め、nx と同じ形で push する"):
        _commit_file(scene.work, "local-only.txt", "x\n", "chore: local only")
        scene.release(push=False)
        _git(scene.work, "push", "--follow-tags", "--no-verify", "--atomic", env=_NX_PUSH_ENV)
    with allure.step("origin のブランチとタグだけが進み、main は動かないことを確かめる"):
        assert scene.origin_ref(f"refs/heads/{scene.branch}") == _out(
            scene.work, "rev-parse", "HEAD"
        )
        assert scene.origin_ref("refs/tags/v1.0.0")
        assert scene.origin_ref("refs/heads/main") == scene.base


# ---- release-land.sh ----


@allure.title("main が進んでいないとき、`release-land.sh` は fast-forward で main に反映する")
def test_land_fast_forward(scene: Scene) -> None:
    """`release-land.sh` で、origin の main がリリースのブランチの元から進んでいない場合のテストです。出力が `landed: <sha> (fast-forward)` になり、main がリリースのコミットを指し、ブランチが削除されることを確認します。"""
    with allure.step("release を用意し、land.sh を動かす"):
        release = scene.release()
        result = scene.land()
    with allure.step("fast-forward で main に載り、ブランチが消えることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == f"landed: {release} (fast-forward)"
        assert scene.origin_ref("refs/heads/main") == release
        assert scene.origin_ref(f"refs/heads/{scene.branch}") == ""


@allure.title("main が進んでいるとき、`release-land.sh` は main をマージして反映する")
def test_land_merges_advanced_main(scene: Scene) -> None:
    """origin の main が別のコミットで進んでいる場合の `release-land.sh` のテストです。マージのコミットの親が新しい main とリリースのコミットになり、タグがその祖先に含まれ、ブランチが削除されることを確認します。"""
    with allure.step("release を用意し、origin の main を進めて、land.sh を動かす"):
        release = scene.release()
        new_main = _advance_main(scene.other, "other.txt", "o\n")
        result = scene.land()
    with allure.step("main を merge して載せ、ブランチが消えることを確かめる"):
        assert result.returncode == 0, result.stderr
        landed = scene.origin_ref("refs/heads/main")
        assert result.stdout.strip() == f"landed: {landed} (merged {new_main})"
        assert _out(scene.origin, "rev-parse", f"{landed}^1") == new_main
        assert _out(scene.origin, "rev-parse", f"{landed}^2") == release
        assert (
            _out(scene.origin, "log", "-1", "--format=%s", landed)
            == "chore(release): merge main into publish"
        )
        assert (
            _git(
                scene.origin, "merge-base", "--is-ancestor", "v1.0.0", landed, check=False
            ).returncode
            == 0
        )
        assert scene.origin_ref(f"refs/heads/{scene.branch}") == ""


@allure.title(
    "リリースのコミットが存在しないとき、`release-land.sh` はブランチを削除するだけにする"
)
def test_land_without_release_commit_only_deletes_branch(scene: Scene) -> None:
    """リリースのコミットを持たないブランチで `release-land.sh` を実行した場合のテストです。出力が `skipped: no release commit` になり、ブランチが削除され、main は変わらないことを確認します。"""
    with allure.step("commit の無い release のブランチを用意し、origin にあることを確かめる"):
        scene.release(commit=False)
        assert scene.origin_ref(f"refs/heads/{scene.branch}")
    with allure.step("land.sh を動かす"):
        result = scene.land()
    with allure.step("ブランチだけが消え、main は動かないことを確かめる"):
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "skipped: no release commit"
        assert scene.origin_ref(f"refs/heads/{scene.branch}") == ""
        assert scene.origin_ref("refs/heads/main") == scene.base


@allure.title("push の直前に main が進んでも、`release-land.sh` は再試行して反映する")
def test_land_retries_when_main_advances_just_before_push(tmp_path: Path, scene: Scene) -> None:
    """push の直前に別の clone から main を進める git の shim を使った場合のテストです。再試行後に main をマージして反映し、進めたコミットが親に含まれ、ブランチが削除されることを確認します。"""
    with allure.step("release を用意し、push の直前に main が進む shim を置いて、land.sh を動かす"):
        release = scene.release()
        shim_env = _push_shim(tmp_path, scene, times=1)
        result = scene.land(shim_env)
    with allure.step("取り込み直して載り、ブランチが消えることを確かめる"):
        assert result.returncode == 0, result.stderr
        landed = scene.origin_ref("refs/heads/main")
        assert result.stdout.strip().startswith(f"landed: {landed} (merged ")
        assert _out(scene.origin, "rev-parse", f"{landed}^2") == release
        assert (scene.other / "adv-0.txt").is_file()
        assert _out(scene.origin, "show", f"{landed}^1:adv-0.txt") == "0"
        assert scene.origin_ref(f"refs/heads/{scene.branch}") == ""


def _assert_land_error(result: subprocess.CompletedProcess[str], scene: Scene) -> None:
    assert result.returncode == 1
    errors = [line for line in result.stderr.splitlines() if line.startswith("error:")]
    assert len(errors) == 1, result.stderr
    assert errors[0].endswith(f"(branch: {scene.branch})")
    assert scene.origin_ref(f"refs/heads/{scene.branch}")


@allure.title("マージが競合すると、`release-land.sh` はエラーで終了し、ブランチを残す")
def test_land_conflict_errors_and_keeps_branch(scene: Scene) -> None:
    """main と同じファイルを別の内容で変更した場合の `release-land.sh` のテストです。終了コードが 1 になり、`error:` で始まる行が 1 つだけ出力され、ブランチが残ることを確認します。"""
    with allure.step(
        "release と main の変更を衝突させ、land.sh を動かして、ERROR とブランチの残りを確かめる"
    ):
        scene.release(file="CHANGELOG.md")
        _advance_main(scene.other, "CHANGELOG.md", "conflicting\n")
        _assert_land_error(scene.land(), scene)


@allure.title("main が進み続けると、`release-land.sh` は 5 回で諦めてエラーで終了する")
def test_land_gives_up_after_five_attempts(tmp_path: Path, scene: Scene) -> None:
    """push のたびに main が進む shim を使った場合のテストです。終了コードが 1 になり、push の試行が 5 回で止まり、ブランチが残ることを確認します。"""
    with allure.step("push を毎回失敗させて、land.sh を動かし、ERROR を確かめる"):
        scene.release()
        shim_env = _push_shim(tmp_path, scene, times=99)
        _assert_land_error(scene.land(shim_env), scene)
    with allure.step("試行が 5 回で止まることを確かめる"):
        assert read_output(tmp_path / "counter").strip() == "5"


@allure.title(
    "リモートの hook が拒否したときは、メッセージに fetch first を含んでも再試行せずに止まる"
)
def test_land_stops_at_once_when_remote_hook_rejects_even_if_it_says_fetch_first(
    scene: Scene,
) -> None:
    """origin の `pre-receive` が `denied: fetch first` を出力して拒否する場合の `release-land.sh` のテストです。エラーで終了し、`retry:` が出力されず、main が変わらないことを確認します。"""
    with allure.step("origin の hook で push を拒み、land.sh を動かして、ERROR を確かめる"):
        scene.release()
        hook = scene.origin / "hooks/pre-receive"
        hook.write_text("#!/bin/sh\necho 'denied: fetch first' >&2\nexit 1\n", encoding="utf-8")
        hook.chmod(0o755)
        result = scene.land()
        _assert_land_error(result, scene)
    with allure.step("再試行せず、main が動かないことを確かめる"):
        assert "retry:" not in result.stderr
        assert scene.origin_ref("refs/heads/main") == scene.base


@allure.title("ブランチの削除に失敗したとき、`release-land.sh` はその出力を表示する")
def test_land_shows_branch_delete_failure_output(scene: Scene) -> None:
    """origin の `pre-receive` が削除を拒否する場合の `release-land.sh` のテストです。エラーで終了し、標準エラー出力に hook のメッセージ `no delete` が含まれることを確認します。"""
    with allure.step("origin の hook でブランチの削除を拒み、land.sh を動かして、ERROR を確かめる"):
        scene.release(commit=False)
        hook = scene.origin / "hooks/pre-receive"
        hook.write_text("#!/bin/sh\necho 'no delete' >&2\nexit 1\n", encoding="utf-8")
        hook.chmod(0o755)
        result = scene.land()
        _assert_land_error(result, scene)
    with allure.step("拒んだ理由が stderr に出ることを確かめる"):
        assert "no delete" in result.stderr


@allure.title("checkout しているブランチが main でも、`release-land.sh` は反映できる")
def test_land_does_not_depend_on_the_checked_out_branch(scene: Scene) -> None:
    """作業ツリーが main を checkout している状態で `release-land.sh` を実行した場合のテストです。終了コードが 0 になり、origin の main がリリースのコミットを指すことを確認します。"""
    with allure.step("release を用意し、main に切り替えて、land.sh を動かす"):
        release = scene.release()
        _git(scene.work, "switch", "-q", "main")
        result = scene.land()
    with allure.step("どのブランチを開いていても main に載ることを確かめる"):
        assert result.returncode == 0, result.stderr
        assert scene.origin_ref("refs/heads/main") == release


# ---- sha の確認（step の run をそのまま bash で動かす） ----


def _run_step(name: str, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return run_attached(
        ["bash", "-e", "-c", _step(name)["run"]],
        cwd=cwd,
        env=_env(env),
        text=True,
        capture_output=True,
    )


def _sha_flow(scene: Scene, dry_run: str, sha: str) -> int:
    env = {"DRY_RUN": dry_run, "INPUT_SHA": sha}
    for name in ("Check sha input", "Verify sha"):
        result = _run_step(name, scene.work, env)
        if result.returncode != 0:
            return result.returncode
    return 0


@allure.title(
    "dry-run が {dry_run} で sha が {sha_kind} のとき、sha の確認の終了コードは {expected} になる"
)
@pytest.mark.parametrize(
    ("dry_run", "sha_kind", "expected"),
    [
        ("false", "empty", 1),
        ("false", "branch-name", 1),
        ("false", "short", 1),
        ("false", "upper", 1),
        ("false", "multi-line", 1),
        ("false", "not-ancestor", 1),
        ("true", "branch-name", 1),
        ("true", "empty", 0),
        ("true", "base", 0),
        ("false", "base", 0),
    ],
)
def test_sha_flow(scene: Scene, dry_run: str, sha_kind: str, expected: int) -> None:
    """`Check sha input` と `Verify sha` の step を、bash で続けて実行した場合のテストです。本番では空・短縮形・大文字・複数行・祖先でない sha を拒否し、dry-run では空を許可することを確認します。"""
    with allure.step("origin に無い commit を作り、sha の入力を用意する"):
        _git(scene.work, "switch", "-q", "-c", "local-only")
        local_only = _commit_file(scene.work, "x.txt", "x\n", "feat: not pushed")
        sha = {
            "empty": "",
            "branch-name": "main",
            "short": scene.base[:7],
            "upper": scene.base.upper(),
            "multi-line": scene.base + "\n" + scene.base,
            "not-ancestor": local_only,
            "base": scene.base,
        }[sha_kind]
    with allure.step("sha の入力の確かめを動かし、終了コードを確かめる"):
        assert _sha_flow(scene, dry_run, sha) == expected


@allure.title(
    "preflight は、App のトークンと checkout の後、コンテナを起こす前に、release-check の action で動く"
)
def test_preflight_runs_release_check_action_before_the_container() -> None:
    """`release.yml` の `Run release preflight` の step のテストです。`./actions/release-check` を使い、App のトークンの生成と `Checkout` の後、`Start dev container` の前に置かれることを確認します。App のトークンを渡し、`preflight.log` に出力を残すことも確認します。"""
    with allure.step("step の並びと preflight の step を読む"):
        names = [s.get("name") for s in _steps()]
        step = _step("Run release preflight")
    with allure.step("順序と、action・入力・ログの置き場を確かめる"):
        assert names.index("Generate GitHub App token") < names.index("Run release preflight")
        assert names.index("Checkout") < names.index("Run release preflight")
        assert names.index("Run release preflight") < names.index("Start dev container")
        assert step["uses"] == "./actions/release-check"
        assert step["with"]["token"] == "${{ steps.app-token.outputs.token }}"
        assert step["with"]["log-file"] == ".pecot/tmp/release/preflight.log"
        assert "continue-on-error" not in step


@allure.title("release の runCmd は、preflight を実行しない")
def test_run_cmd_has_no_preflight() -> None:
    """`Run release` の `runCmd` のテストです。preflight は action の step が行うので、`runCmd` に `preflight` が含まれないことを確認します。"""
    with allure.step("runCmd を読む"):
        cmd = _run_cmd()
    with allure.step("preflight と pecot の起動ファイルを呼ばないことを確かめる"):
        assert "preflight" not in cmd
        assert "bin/pecot" not in cmd


# ---- runCmd（stub の pnpm・gh と本物の git・release-land.sh で動かす） ----

# nx の push は、フックを飛ばす git の引数を変数で組み立てて nx と同じ形にする。
_NX_STUB = """#!/usr/bin/env bash
case "$*" in
  *--dry-run*) echo "dry-run plan"; exit 0 ;;
esac
[ "$NX_MODE" = fail-before ] && { echo "nx failed" >&2; exit 1; }
echo 1.0.0 > version.txt
git add version.txt
git commit -q -m "chore(release): publish"
git tag -a v1.0.0 -m v1.0.0
skip=verify
git push --follow-tags "--no-$skip" --atomic
[ "$NX_MODE" = fail-after ] && { echo "nx failed after push" >&2; exit 3; }
exit 0
"""

_GIT_SHIM = """#!/usr/bin/env bash
if [ "${{1:-}}" = ls-remote ] && [ -n "${{LS_REMOTE_FAIL:-}}" ]; then
  echo "fatal: authentication failed" >&2
  exit 128
fi
exec "{real}" "$@"
"""


class RunScene(Scene):
    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.root_dir = root
        self.stubs = root / "stubs"
        self.stubs.mkdir()
        self._script(self.stubs / "pnpm", _NX_STUB)
        self._script(self.stubs / "gh", "#!/usr/bin/env bash\nexit 0\n")
        self._script(self.stubs / "git", _GIT_SHIM.format(real=_REAL_GIT))
        land = self.work / ".githooks/scripts/release-land.sh"
        land.parent.mkdir(parents=True)
        shutil.copy(_LAND, land)
        self.logs = self.work / ".pecot/tmp/release"
        self.logs.mkdir(parents=True)

    @staticmethod
    def _script(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        path.chmod(0o755)

    def run_cmd(self, *, dry_run: bool, **extra: str) -> subprocess.CompletedProcess[str]:
        cmd = _run_cmd()
        assert "cd /workspaces/base/pecot &&" in cmd
        cmd = cmd.replace("cd /workspaces/base/pecot", f"cd {self.work}")
        env = {
            "PATH": f"{self.stubs}{os.pathsep}{os.environ['PATH']}",
            "DRY_RUN": "true" if dry_run else "false",
            "BOT_NAME": "bot",
            "BOT_EMAIL": "bot@example.com",
            "RUN_ID": "1",
            "RUN_ATTEMPT": "1",
            **extra,
        }
        return run_attached(
            ["bash", "-c", cmd], cwd=self.root_dir, env=_env(env), text=True, capture_output=True
        )


@pytest.fixture
def run_scene(tmp_path: Path) -> RunScene:
    return RunScene(tmp_path)


@allure.title("dry-run のとき、`runCmd` は計画を作るだけで、main には何も反映しない")
def test_run_cmd_dry_run_only_plans(run_scene: RunScene) -> None:
    """偽の `pnpm`・`gh` を使って `runCmd` を dry-run で実行した場合のテストです。`nx.log` が作られ、`land.log` は作られず、origin の main とブランチが変わらないことを確認します。"""
    with allure.step("dry-run で release の run コマンドを動かす"):
        result = run_scene.run_cmd(dry_run=True)
    with allure.step("plan を出すだけで、land と push は行わないことを確かめる"):
        assert result.returncode == 0, result.stderr
        assert not (run_scene.logs / "preflight.log").exists()
        assert "dry-run plan" in read_output(run_scene.logs / "nx.log")
        assert not (run_scene.logs / "land.log").exists()
        assert run_scene.origin_ref("refs/heads/main") == run_scene.base
        assert run_scene.origin_ref(f"refs/heads/{run_scene.branch}") == ""


@allure.title("本番のとき、`runCmd` はリリースを作り、main に反映する")
def test_run_cmd_production_lands_release(run_scene: RunScene) -> None:
    """`runCmd` を本番で実行した場合のテストです。タグを付けたコミットを origin の main に反映し、リリースのブランチを削除することを確認します。あわせて、`land.log` が `landed:` と fast-forward で始まることも確認します。"""
    with allure.step("本番で release の run コマンドを動かす"):
        result = run_scene.run_cmd(dry_run=False, NX_MODE="ok")
    with allure.step("release が main に載り、ブランチが消えることを確かめる"):
        assert result.returncode == 0, result.stderr
        released = run_scene.origin_ref("refs/tags/v1.0.0^{commit}")
        assert released
        assert run_scene.origin_ref("refs/heads/main") == released
        assert run_scene.origin_ref(f"refs/heads/{run_scene.branch}") == ""
        land_log = read_output(run_scene.logs / "land.log")
        assert land_log.startswith(f"landed: {released} (fast-forward)")


@allure.title("push の前に nx が失敗すると、`runCmd` は main に反映しない")
def test_run_cmd_nx_failure_before_push_skips_land(run_scene: RunScene) -> None:
    """push の前に nx が失敗する場合の `runCmd` のテストです。終了コードが 1 になり、`land.log` が作られず、origin の main が変わらないことを確認します。"""
    with allure.step("push の前に nx を失敗させて、run コマンドを動かす"):
        result = run_scene.run_cmd(dry_run=False, NX_MODE="fail-before")
    with allure.step("終了コード 1 で、land せず main が動かないことを確かめる"):
        assert result.returncode == 1
        assert not (run_scene.logs / "land.log").exists()
        assert run_scene.origin_ref("refs/heads/main") == run_scene.base


@allure.title("push の後に nx が失敗しても、`runCmd` は main に反映し、nx の終了コードを返す")
def test_run_cmd_nx_failure_after_push_still_lands_and_returns_nx_code(
    run_scene: RunScene,
) -> None:
    """push の後に nx が終了コード 3 で失敗する場合の `runCmd` のテストです。終了コードが 3 になり、リリースのコミットが main に反映され、`land.log` が `landed:` で始まることを確認します。"""
    with allure.step("push の後に nx を失敗させて、run コマンドを動かす"):
        result = run_scene.run_cmd(dry_run=False, NX_MODE="fail-after")
    with allure.step("land は行い、nx の終了コードを返すことを確かめる"):
        assert result.returncode == 3
        released = run_scene.origin_ref("refs/tags/v1.0.0^{commit}")
        assert run_scene.origin_ref("refs/heads/main") == released
        assert read_output(run_scene.logs / "land.log").startswith("landed:")


@allure.title("`git ls-remote` が失敗すると、`runCmd` はその旨を land.log に記録する")
def test_run_cmd_ls_remote_failure_is_reported_in_land_log(run_scene: RunScene) -> None:
    """`git ls-remote` が終了コード 128 で失敗する場合の `runCmd` のテストです。終了コードが 128 になり、`land.log` に `error: git ls-remote failed` で始まる行が残り、main が変わらないことを確認します。"""
    with allure.step("git ls-remote を失敗させて、run コマンドを動かす"):
        result = run_scene.run_cmd(dry_run=False, NX_MODE="ok", LS_REMOTE_FAIL="1")
    with allure.step("失敗が land.log に出て、main が動かないことを確かめる"):
        assert result.returncode == 128
        land_log = read_output(run_scene.logs / "land.log")
        assert land_log.startswith(
            f"error: git ls-remote failed with exit code 128 (branch: {run_scene.branch})"
        )
        assert run_scene.origin_ref("refs/heads/main") == run_scene.base


# ---- Write job summary ----


def _summary(tmp_path: Path, logs: dict[str, str], **env: str) -> str:
    cwd = tmp_path / "summary-cwd"
    d = cwd / ".pecot/tmp/release"
    d.mkdir(parents=True)
    for name, text in logs.items():
        (d / f"{name}.log").write_text(text, encoding="utf-8")
    out = tmp_path / "step-summary.md"
    out.write_text("", encoding="utf-8")
    step = _step("Write job summary")
    base_env = {
        k: v for k, v in step["env"].items() if k.startswith("MSG_") and "${{" not in str(v)
    }
    base_env.update(
        DRY_RUN="false",
        SHA_INPUT_OUTCOME="success",
        SHA_VERIFY_OUTCOME="success",
        PREFLIGHT_OUTCOME="success",
        UP_OUTCOME="success",
        RUN_OUTCOME="success",
        GITHUB_STEP_SUMMARY=str(out),
    )
    base_env.update(env)
    result = run_attached(
        ["bash", "-e", "-c", step["run"]],
        cwd=cwd,
        env=_env(base_env),
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    return read_output(out)


def _msg(name: str) -> str:
    return _step("Write job summary")["env"][name]


@allure.title("dry-run のとき、ジョブのサマリーの見出しは Release plan になる")
def test_summary_dry_run_heading(tmp_path: Path) -> None:
    """`Write job summary` の step を dry-run で実行した場合のテストです。サマリーが `## Release plan` で始まり、`preflight` と `nx` のログが `details` として含まれることを確認します。"""
    with allure.step("dry-run のログから要約を作る"):
        text = _summary(tmp_path, {"preflight": "ok\n", "nx": "plan\n"}, DRY_RUN="true")
    with allure.step("plan の見出しと、ログごとの details があることを確かめる"):
        assert text.startswith("## Release plan\n")
        assert "<details><summary>preflight</summary>" in text
        assert "<details><summary>nx</summary>" in text


@allure.title("本番のとき、ジョブのサマリーは landed の行を表示し、git のエラーは除外する")
def test_summary_production_shows_landed_line_without_git_errors(tmp_path: Path) -> None:
    """`land.log` に git のエラーの行が含まれる状態で、本番の `Write job summary` を実行した場合のテストです。`landed:` と `error: push to main was rejected` は表示され、`failed to push some refs` は表示されないことを確認します。"""
    with allure.step("git のエラーを含む land のログから要約を作る"):
        land = (
            "landed: abc123 (merged def456)\n"
            "  error: failed to push some refs to 'origin'\n"
            "error: push to main was rejected (branch: release/run-1-1)\n"
        )
        text = _summary(tmp_path, {"land": land, "nx": "x\n"})
    with allure.step("landed の行と error の行だけが出て、git のエラーは出ないことを確かめる"):
        assert text.startswith("## Release\n")
        section = text.split("### land", 1)[1].split("```", 2)[1]
        assert "landed: abc123 (merged def456)" in section
        assert "error: push to main was rejected (branch: release/run-1-1)" in section
        assert "failed to push some refs" not in section
        assert "<summary>land</summary>" not in text


@allure.title("sha の確認が失敗したとき、サマリーは基盤の失敗として報告しない")
def test_summary_sha_failure_is_not_reported_as_infrastructure(tmp_path: Path) -> None:
    """`Verify sha` の結果が失敗の場合の `Write job summary` のテストです。sha の失敗のメッセージが含まれ、コンテナの起動の失敗のメッセージが含まれないことを確認します。"""
    with allure.step("sha の確認が失敗した状態の要約を作る"):
        text = _summary(
            tmp_path, {}, SHA_VERIFY_OUTCOME="failure", UP_OUTCOME="skipped", RUN_OUTCOME="skipped"
        )
    with allure.step("sha の失敗の文が出て、基盤の失敗の文は出ないことを確かめる"):
        assert _msg("MSG_SHA_FAILED") in text
        assert _msg("MSG_UP_FAILED") not in text


@allure.title("コンテナの起動の失敗と skip で、サマリーのメッセージを分ける")
def test_summary_container_failure_and_skipped_are_told_apart(tmp_path: Path) -> None:
    """コンテナの起動が失敗した場合と、skip された場合の `Write job summary` のテストです。失敗のときは起動の失敗のメッセージを、skip のときは未実行のメッセージを表示することを確認します。"""
    with allure.step("コンテナの起動が失敗した状態の要約を作る"):
        failed = _summary(tmp_path, {}, UP_OUTCOME="failure", RUN_OUTCOME="skipped")
    with allure.step("失敗と未実行で、別の文が出ることを確かめる"):
        assert _msg("MSG_UP_FAILED") in failed
        skipped = _summary(tmp_path / "b", {}, UP_OUTCOME="skipped", RUN_OUTCOME="skipped")
        assert _msg("MSG_NOT_RUN") in skipped
        assert _msg("MSG_UP_FAILED") not in skipped


@allure.title("リリースの step が失敗したとき、サマリーは本番と dry-run でメッセージを分ける")
def test_summary_release_failure_messages(tmp_path: Path) -> None:
    """`Run release` の結果が失敗の場合の `Write job summary` のテストです。本番ではリリースの失敗のメッセージを、dry-run では計画の失敗のメッセージを表示することを確認します。"""
    with allure.step("release の失敗と plan の失敗の要約が、それぞれの文を出すことを確かめる"):
        assert _msg("MSG_RELEASE_FAILED") in _summary(tmp_path, {}, RUN_OUTCOME="failure")
        plan = _summary(tmp_path / "b", {}, RUN_OUTCOME="failure", DRY_RUN="true")
        assert _msg("MSG_PLAN_FAILED") in plan


@allure.title("preflight が失敗したとき、サマリーは失敗を告げ、preflight のログを details に載せる")
def test_summary_preflight_failure(tmp_path: Path) -> None:
    """`Run release preflight` の step が失敗し、後の step が飛ばされた場合の `Write job summary` のテストです。メッセージが「進みませんでした」でなく失敗の文になり、`preflight` のログの warning が `preflight warnings` に載ることを確認します。"""
    with allure.step("preflight の失敗で、後の step が飛ばされた状態の要約を作る"):
        text = _summary(
            tmp_path,
            {"preflight": "warning: w\n  detail\nerror: x\n"},
            DRY_RUN="true",
            PREFLIGHT_OUTCOME="failure",
            UP_OUTCOME="skipped",
            RUN_OUTCOME="skipped",
        )
    with allure.step("失敗の文と、preflight のログが出ることを確かめる"):
        assert _msg("MSG_PLAN_FAILED") in text
        assert _msg("MSG_NOT_RUN") not in text
        assert "### preflight warnings" in text
        assert "<details><summary>preflight</summary>" in text


@allure.title("ログが非常に大きくても、サマリーは 1 MiB 未満に収める")
def test_summary_stays_under_one_mebibyte(tmp_path: Path) -> None:
    """3 つのログがそれぞれ約 2 MB になる状態で `Write job summary` を実行した場合のテストです。サマリーの大きさが 1 MiB 未満であることを確認します。"""
    with allure.step("大きなログから要約を作る"):
        big = "x" * 100 + "\n"
        logs = dict.fromkeys(("preflight", "nx", "land"), big * 20000)
        logs["preflight"] = ("warning: w\n  detail\n" * 40000) + logs["preflight"]
        text = _summary(tmp_path, logs)
    with allure.step("要約が 1 MiB を超えないことを確かめる"):
        assert len(text.encode("utf-8")) < 1024 * 1024
