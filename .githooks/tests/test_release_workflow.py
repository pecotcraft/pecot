"""release.yml の静的な確認と、release-land.sh の実際の動き。

本番の流れは main でしか動かせないため、構造と land のスクリプトを merge 前にここで固定する。
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

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


def test_single_job_runs_in_release_plan_environment() -> None:
    wf = _workflow()
    assert list(wf["jobs"]) == ["release"]
    assert wf["jobs"]["release"]["environment"] == "release-plan"


def test_inputs_default_to_dry_run() -> None:
    inputs = _workflow()[True]["workflow_dispatch"]["inputs"]
    assert inputs["dry-run"]["type"] == "boolean"
    assert inputs["dry-run"]["default"] is True
    assert inputs["sha"]["type"] == "string"


def test_checkout_uses_input_sha_after_the_sha_form_is_checked() -> None:
    names = [s.get("name") for s in _steps()]
    assert names.index("Check sha input") < names.index("Checkout")
    assert _step("Checkout")["with"]["ref"] == "${{ inputs.sha || github.sha }}"


def test_does_not_use_stringly_typed_inputs() -> None:
    assert "github.event.inputs" not in _WORKFLOW.read_text(encoding="utf-8")


def test_token_permissions_follow_dry_run() -> None:
    with_ = _step("Generate GitHub App token")["with"]
    assert with_["permission-contents"] == "${{ inputs.dry-run && 'read' || 'write' }}"
    assert with_["permission-actions"] == "${{ !inputs.dry-run && 'write' || '' }}"
    for key in (
        "permission-vulnerability-alerts",
        "permission-security-events",
        "permission-secret-scanning-alerts",
    ):
        assert with_[key] == "read"


def test_no_japanese_in_shell() -> None:
    for step in _steps():
        for text in (step.get("run", ""), step.get("with", {}).get("runCmd", "")):
            assert not re.search(r"[^\x00-\x7f]", text), step["name"]


def test_land_script_is_executable() -> None:
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
    return subprocess.run(
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
        return subprocess.run(
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


def test_nx_style_push_moves_only_branch_and_tag_even_when_local_main_is_ahead(
    scene: Scene,
) -> None:
    _commit_file(scene.work, "local-only.txt", "x\n", "chore: local only")
    scene.release(push=False)
    _git(scene.work, "push", "--follow-tags", "--no-verify", "--atomic", env=_NX_PUSH_ENV)
    assert scene.origin_ref(f"refs/heads/{scene.branch}") == _out(scene.work, "rev-parse", "HEAD")
    assert scene.origin_ref("refs/tags/v1.0.0")
    assert scene.origin_ref("refs/heads/main") == scene.base


# ---- release-land.sh ----


def test_land_fast_forward(scene: Scene) -> None:
    release = scene.release()
    result = scene.land()
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == f"landed: {release} (fast-forward)"
    assert scene.origin_ref("refs/heads/main") == release
    assert scene.origin_ref(f"refs/heads/{scene.branch}") == ""


def test_land_merges_advanced_main(scene: Scene) -> None:
    release = scene.release()
    new_main = _advance_main(scene.other, "other.txt", "o\n")
    result = scene.land()
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
        _git(scene.origin, "merge-base", "--is-ancestor", "v1.0.0", landed, check=False).returncode
        == 0
    )
    assert scene.origin_ref(f"refs/heads/{scene.branch}") == ""


def test_land_without_release_commit_only_deletes_branch(scene: Scene) -> None:
    scene.release(commit=False)
    assert scene.origin_ref(f"refs/heads/{scene.branch}")
    result = scene.land()
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "skipped: no release commit"
    assert scene.origin_ref(f"refs/heads/{scene.branch}") == ""
    assert scene.origin_ref("refs/heads/main") == scene.base


def test_land_retries_when_main_advances_just_before_push(tmp_path: Path, scene: Scene) -> None:
    release = scene.release()
    shim_env = _push_shim(tmp_path, scene, times=1)
    result = scene.land(shim_env)
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


def test_land_conflict_errors_and_keeps_branch(scene: Scene) -> None:
    scene.release(file="CHANGELOG.md")
    _advance_main(scene.other, "CHANGELOG.md", "conflicting\n")
    _assert_land_error(scene.land(), scene)


def test_land_gives_up_after_five_attempts(tmp_path: Path, scene: Scene) -> None:
    scene.release()
    shim_env = _push_shim(tmp_path, scene, times=99)
    _assert_land_error(scene.land(shim_env), scene)
    assert (tmp_path / "counter").read_text(encoding="utf-8").strip() == "5"


def test_land_stops_at_once_when_remote_hook_rejects_even_if_it_says_fetch_first(
    scene: Scene,
) -> None:
    scene.release()
    hook = scene.origin / "hooks/pre-receive"
    hook.write_text("#!/bin/sh\necho 'denied: fetch first' >&2\nexit 1\n", encoding="utf-8")
    hook.chmod(0o755)
    result = scene.land()
    _assert_land_error(result, scene)
    assert "retry:" not in result.stderr
    assert scene.origin_ref("refs/heads/main") == scene.base


def test_land_shows_branch_delete_failure_output(scene: Scene) -> None:
    scene.release(commit=False)
    hook = scene.origin / "hooks/pre-receive"
    hook.write_text("#!/bin/sh\necho 'no delete' >&2\nexit 1\n", encoding="utf-8")
    hook.chmod(0o755)
    result = scene.land()
    _assert_land_error(result, scene)
    assert "no delete" in result.stderr


def test_land_does_not_depend_on_the_checked_out_branch(scene: Scene) -> None:
    release = scene.release()
    _git(scene.work, "switch", "-q", "main")
    result = scene.land()
    assert result.returncode == 0, result.stderr
    assert scene.origin_ref("refs/heads/main") == release


# ---- sha の確認（step の run をそのまま bash で動かす） ----


def _run_step(name: str, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
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
    assert _sha_flow(scene, dry_run, sha) == expected


# ---- runCmd（stub の pecot・pnpm・gh と本物の git・release-land.sh で動かす） ----

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
        self._script(
            self.work / "plugins/pecot-workflow/bin/pecot",
            "#!/usr/bin/env bash\necho preflight ok\n",
        )
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
        return subprocess.run(
            ["bash", "-c", cmd], cwd=self.root_dir, env=_env(env), text=True, capture_output=True
        )


@pytest.fixture
def run_scene(tmp_path: Path) -> RunScene:
    return RunScene(tmp_path)


def test_run_cmd_dry_run_only_plans(run_scene: RunScene) -> None:
    result = run_scene.run_cmd(dry_run=True)
    assert result.returncode == 0, result.stderr
    assert (run_scene.logs / "preflight.log").is_file()
    assert "dry-run plan" in (run_scene.logs / "nx.log").read_text(encoding="utf-8")
    assert not (run_scene.logs / "land.log").exists()
    assert run_scene.origin_ref("refs/heads/main") == run_scene.base
    assert run_scene.origin_ref(f"refs/heads/{run_scene.branch}") == ""


def test_run_cmd_production_lands_release(run_scene: RunScene) -> None:
    result = run_scene.run_cmd(dry_run=False, NX_MODE="ok")
    assert result.returncode == 0, result.stderr
    released = run_scene.origin_ref("refs/tags/v1.0.0^{commit}")
    assert released
    assert run_scene.origin_ref("refs/heads/main") == released
    assert run_scene.origin_ref(f"refs/heads/{run_scene.branch}") == ""
    land_log = (run_scene.logs / "land.log").read_text(encoding="utf-8")
    assert land_log.startswith(f"landed: {released} (fast-forward)")


def test_run_cmd_nx_failure_before_push_skips_land(run_scene: RunScene) -> None:
    result = run_scene.run_cmd(dry_run=False, NX_MODE="fail-before")
    assert result.returncode == 1
    assert not (run_scene.logs / "land.log").exists()
    assert run_scene.origin_ref("refs/heads/main") == run_scene.base


def test_run_cmd_nx_failure_after_push_still_lands_and_returns_nx_code(
    run_scene: RunScene,
) -> None:
    result = run_scene.run_cmd(dry_run=False, NX_MODE="fail-after")
    assert result.returncode == 3
    released = run_scene.origin_ref("refs/tags/v1.0.0^{commit}")
    assert run_scene.origin_ref("refs/heads/main") == released
    assert (run_scene.logs / "land.log").read_text(encoding="utf-8").startswith("landed:")


def test_run_cmd_ls_remote_failure_is_reported_in_land_log(run_scene: RunScene) -> None:
    result = run_scene.run_cmd(dry_run=False, NX_MODE="ok", LS_REMOTE_FAIL="1")
    assert result.returncode == 128
    land_log = (run_scene.logs / "land.log").read_text(encoding="utf-8")
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
        UP_OUTCOME="success",
        RUN_OUTCOME="success",
        GITHUB_STEP_SUMMARY=str(out),
    )
    base_env.update(env)
    result = subprocess.run(
        ["bash", "-e", "-c", step["run"]],
        cwd=cwd,
        env=_env(base_env),
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    return out.read_text(encoding="utf-8")


def _msg(name: str) -> str:
    return _step("Write job summary")["env"][name]


def test_summary_dry_run_heading(tmp_path: Path) -> None:
    text = _summary(tmp_path, {"preflight": "ok\n", "nx": "plan\n"}, DRY_RUN="true")
    assert text.startswith("## Release plan\n")
    assert "<details><summary>preflight</summary>" in text
    assert "<details><summary>nx</summary>" in text


def test_summary_production_shows_landed_line_without_git_errors(tmp_path: Path) -> None:
    land = (
        "landed: abc123 (merged def456)\n"
        "  error: failed to push some refs to 'origin'\n"
        "error: push to main was rejected (branch: release/run-1-1)\n"
    )
    text = _summary(tmp_path, {"land": land, "nx": "x\n"})
    assert text.startswith("## Release\n")
    section = text.split("### land", 1)[1].split("```", 2)[1]
    assert "landed: abc123 (merged def456)" in section
    assert "error: push to main was rejected (branch: release/run-1-1)" in section
    assert "failed to push some refs" not in section
    assert "<summary>land</summary>" not in text


def test_summary_sha_failure_is_not_reported_as_infrastructure(tmp_path: Path) -> None:
    text = _summary(
        tmp_path, {}, SHA_VERIFY_OUTCOME="failure", UP_OUTCOME="skipped", RUN_OUTCOME="skipped"
    )
    assert _msg("MSG_SHA_FAILED") in text
    assert _msg("MSG_UP_FAILED") not in text


def test_summary_container_failure_and_skipped_are_told_apart(tmp_path: Path) -> None:
    failed = _summary(tmp_path, {}, UP_OUTCOME="failure", RUN_OUTCOME="skipped")
    assert _msg("MSG_UP_FAILED") in failed
    skipped = _summary(tmp_path / "b", {}, UP_OUTCOME="skipped", RUN_OUTCOME="skipped")
    assert _msg("MSG_NOT_RUN") in skipped
    assert _msg("MSG_UP_FAILED") not in skipped


def test_summary_release_failure_messages(tmp_path: Path) -> None:
    assert _msg("MSG_RELEASE_FAILED") in _summary(tmp_path, {}, RUN_OUTCOME="failure")
    plan = _summary(tmp_path / "b", {}, RUN_OUTCOME="failure", DRY_RUN="true")
    assert _msg("MSG_PLAN_FAILED") in plan


def test_summary_stays_under_one_mebibyte(tmp_path: Path) -> None:
    big = "x" * 100 + "\n"
    logs = dict.fromkeys(("preflight", "nx", "land"), big * 20000)
    logs["preflight"] = ("warning: w\n  detail\n" * 40000) + logs["preflight"]
    text = _summary(tmp_path, logs)
    assert len(text.encode("utf-8")) < 1024 * 1024
