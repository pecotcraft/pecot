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


def test_single_job_without_approval_environment() -> None:
    wf = _workflow()
    assert list(wf["jobs"]) == ["release"]
    assert wf["jobs"]["release"]["environment"] == "release-plan"
    assert not re.search(r"environment:\s*release\s*$", _WORKFLOW.read_text(encoding="utf-8"), re.M)


def test_inputs_default_to_dry_run() -> None:
    inputs = _workflow()[True]["workflow_dispatch"]["inputs"]
    assert inputs["dry-run"]["type"] == "boolean"
    assert inputs["dry-run"]["default"] is True
    assert inputs["sha"]["type"] == "string"


def test_checkout_uses_input_sha_and_never_main() -> None:
    checkout = _step("Checkout")["with"]
    assert checkout["ref"] == "${{ inputs.sha || github.sha }}"
    assert not re.search(r"ref:\s*main\b", _WORKFLOW.read_text(encoding="utf-8"))
    assert not any(s.get("name") == "Verify main has not advanced" for s in _steps())


def test_does_not_use_stringly_typed_inputs() -> None:
    assert "github.event.inputs" not in _WORKFLOW.read_text(encoding="utf-8")


def test_sha_is_required_for_production_and_checked_against_main() -> None:
    run = _step("Verify sha")["run"]
    assert '"$DRY_RUN" != "true"' in run
    assert "merge-base --is-ancestor" in run
    assert "origin/main" in run


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


def test_dry_run_branch_runs_nx_dry_run_and_only_production_lands() -> None:
    cmd = _run_cmd()
    dry, prod = cmd.split("else", 1)
    assert "nx release --dry-run" in dry
    assert "release-land.sh" not in dry
    assert "--dry-run" not in prod
    assert "nx release --verbose --yes" in prod
    assert "release-land.sh" in prod


def test_production_lands_even_when_nx_fails() -> None:
    prod = _run_cmd().split("else", 1)[1]
    nx_pos = prod.index("nx release --verbose --yes")
    assert "|| nx_rc=$?" in prod[nx_pos:].splitlines()[0]
    assert prod.index("ls-remote --exit-code") < prod.index("release-land.sh")
    assert "push.default" in prod
    assert 'exit "$nx_rc"' in prod
    assert 'exit "$land_rc"' in prod
    assert 'git switch -c "$branch"' in prod


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

    def release(self, *, commit: bool = True, file: str = "version.txt") -> str:
        _git(self.work, "switch", "-q", "-c", self.branch)
        if commit:
            _commit_file(self.work, file, "1.0.0\n", "chore(release): publish")
            _git(self.work, "tag", "-a", "v1.0.0", "-m", "v1.0.0")
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


def test_nx_style_push_moves_only_branch_and_tag(scene: Scene) -> None:
    release = scene.release(commit=True)
    # release() は --follow-tags 付きの push 済み。nx と同じ形で、もう 1 度 push して冪等であることも見る。
    _commit_file(scene.work, "more.txt", "x\n", "chore(release): more")
    _git(scene.work, "tag", "-a", "v1.0.1", "-m", "v1.0.1")
    result = _git(
        scene.work,
        "push",
        "--follow-tags",
        "--no-verify",
        "--atomic",
        env={
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "push.default",
            "GIT_CONFIG_VALUE_0": "current",
        },
    )
    assert result.returncode == 0
    assert scene.origin_ref(f"refs/heads/{scene.branch}") == _out(scene.work, "rev-parse", "HEAD")
    assert scene.origin_ref("refs/tags/v1.0.1")
    assert scene.origin_ref("refs/heads/main") == scene.base
    assert release != scene.base


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
        == "chore(release): merge main into chore(release): publish"
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


def test_land_conflict_errors_and_keeps_branch(scene: Scene) -> None:
    scene.release(file="CHANGELOG.md")
    _advance_main(scene.other, "CHANGELOG.md", "conflicting\n")
    result = scene.land()
    assert result.returncode == 1
    assert result.stderr.startswith("error:")
    assert scene.branch in result.stderr
    assert scene.origin_ref(f"refs/heads/{scene.branch}")


def test_land_gives_up_after_five_attempts(tmp_path: Path, scene: Scene) -> None:
    scene.release()
    shim_env = _push_shim(tmp_path, scene, times=99)
    result = scene.land(shim_env)
    assert result.returncode == 1
    assert "error:" in result.stderr
    assert scene.branch in result.stderr
    assert (tmp_path / "counter").read_text(encoding="utf-8").strip() == "5"
    assert scene.origin_ref(f"refs/heads/{scene.branch}")


def test_land_stops_at_once_when_remote_hook_rejects(scene: Scene) -> None:
    scene.release()
    hook = scene.origin / "hooks/pre-receive"
    hook.write_text("#!/bin/sh\necho denied >&2\nexit 1\n", encoding="utf-8")
    hook.chmod(0o755)
    result = scene.land()
    assert result.returncode == 1
    assert "error:" in result.stderr
    assert scene.branch in result.stderr
    assert "retry:" not in result.stderr
    assert scene.origin_ref("refs/heads/main") == scene.base
    assert scene.origin_ref(f"refs/heads/{scene.branch}")
