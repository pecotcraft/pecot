"""リリース版の側を、dev container を立てたホストで作る（contracts/pages.md の「リリース版の build」）。

--sources に release_sources.py の標準出力、--out に側の artifact のディレクトリを渡す。
env の RUNNER_TEMP・GITHUB_WORKSPACE を使い、dev-container.sh up の後に呼ぶ。
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, TextIO

from release_sources import ReleaseSources, ReleaseSourcesError, from_json

CONTAINER_ROOT = "/workspaces/base/pecot"
SITE_ENV = ("PECOT_SITE_SIDE", "PECOT_SITE_LANES")
# --update-remote-user-uid-default never のため、コンテナの vscode の UID は 1000（dev-container.sh の up と同じ前提）。


class Runner(Protocol):
    def __call__(
        self, argv: Sequence[str], *, env: Mapping[str, str], stdout: TextIO | None = None
    ) -> int: ...


class BuildError(RuntimeError):
    pass


@dataclass
class Build:
    sources: ReleaseSources
    workspace: Path
    temp: Path
    out: Path
    env: Mapping[str, str]
    run: Runner
    summary: TextIO

    @property
    def tools(self) -> Path:
        return self.temp / "pages-release-tools"

    @property
    def junit_store(self) -> Path:
        return self.temp / "pages-release-junit"

    def _must(self, argv: Sequence[str], env: Mapping[str, str] | None = None) -> None:
        rc = self.run(argv, env=env or self.env)
        if rc != 0:
            raise BuildError(f"{shlex.join(argv)} が {rc} で終わりました")

    def _dc(self, *args: str) -> list[str]:
        return [str(self.tools / "dev-container.sh"), *args]

    def _exec(self, cmd: str) -> list[str]:
        return self._dc("exec", "--", f"cd {CONTAINER_ROOT} && {cmd}")

    def _restore_owner(self) -> None:
        self._must(self._dc("restore-owner"))

    def _checkout(self, commit: str) -> None:
        # restore-owner の後はランナーの持ち物なので、give-owner でコンテナの UID へ戻してから中で書かせる。
        self._restore_owner()
        self._must(["git", "-C", str(self.workspace), "checkout", "--force", commit])
        self._must(self._dc("give-owner"))
        self._must(self._exec("pnpm install --frozen-lockfile"))

    def _copy_tools(self) -> None:
        # checkout でタグの古い版に替わらないよう、呼ぶスクリプトを作業ツリーの外へ写してから使う。
        self.tools.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            self.workspace / ".githooks/ci/dev-container.sh", self.tools / "dev-container.sh"
        )
        for script in (self.workspace / ".githooks/scripts/pages_site").glob("*.py"):
            shutil.copy2(script, self.tools / script.name)

    def run_plugin_lanes(self, plugin: str) -> None:
        lanes = [lane for lane in self.sources.lanes if lane["plugin"] == plugin]
        self._checkout(self.sources.commits[plugin])
        for lane in lanes:
            (self.workspace / lane["junit"]).unlink(missing_ok=True)
        for lane in lanes:
            target = lane["target"]
            rc = self.run(
                self._exec(f"pnpm exec nx run {shlex.quote(target)} --skip-nx-cache"), env=self.env
            )
            if rc != 0:
                print(f"::warning::{target} exited with {rc}")
        self._restore_owner()
        for lane in lanes:
            source = self.workspace / lane["junit"]
            if source.is_file():
                dest = self.junit_store / lane["junit"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(source, dest)

    def assemble(self) -> None:
        self._checkout(self.sources.skeleton)
        self._restore_owner()
        git = ["git", "-C", str(self.workspace)]
        for plugin, commit in sorted(self.sources.commits.items()):
            self._must([*git, "rm", "-r", "-q", "--ignore-unmatch", f"plugins/{plugin}"])
            self._must([*git, "checkout", commit, "--", f"plugins/{plugin}"])
        for lane in self.sources.lanes:
            stored = self.junit_store / lane["junit"]
            if stored.is_file():
                dest = self.workspace / lane["junit"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(stored, dest)

    def collect(self) -> None:
        lanes_file = self.temp / "pages-release-lanes.json"
        lanes_file.write_text(json.dumps(self.sources.lanes, ensure_ascii=False), encoding="utf-8")
        argv = [
            "python3",
            str(self.tools / "collect.py"),
            "--lanes",
            str(lanes_file),
            "--side",
            "release",
            "--sha",
            self.sources.skeleton,
            "--root",
            str(self.workspace),
            "--out",
            str(self.out),
        ]
        rc = self.run(argv, env=self.env, stdout=self.summary)
        if rc != 0:
            raise BuildError(f"JUnit のそろわないレーンがあり、collect.py は {rc} で終わりました")

    def site_env(self) -> dict[str, str]:
        env = dict(self.env)
        env["PECOT_SITE_SIDE"] = "release"
        env["PECOT_SITE_LANES"] = json.dumps(
            self.sources.lanes, ensure_ascii=False, separators=(",", ":")
        )
        env["DEVCONTAINER_ENV"] = "\n".join(
            part for part in (env.get("DEVCONTAINER_ENV", "").strip(), *SITE_ENV) if part
        )
        return env

    def build_site(self) -> None:
        self._must(self._dc("give-owner"))
        self._must(
            self._exec("pnpm exec nx run interface-spec:docs --skip-nx-cache"), env=self.site_env()
        )

    def pack(self) -> None:
        self._restore_owner()
        self.out.mkdir(parents=True, exist_ok=True)
        build_dir = self.workspace / "libs/interface-spec/docs/_build"
        self._must(["tar", "-C", str(build_dir), "-cf", str(self.out / "site.tar"), "."])
        (self.out / "release-sources.json").write_text(
            json.dumps(self.sources.record(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def all(self) -> None:
        self._copy_tools()
        for plugin in sorted(self.sources.commits):
            self.run_plugin_lanes(plugin)
        self.assemble()
        self.collect()
        self.build_site()
        self.pack()


def _subprocess_runner(cwd: Path) -> Runner:
    def run(argv: Sequence[str], *, env: Mapping[str, str], stdout: TextIO | None = None) -> int:
        sys.stdout.flush()
        return subprocess.run(
            list(argv), cwd=cwd, env=dict(env), stdout=stdout, check=False
        ).returncode

    return run


def main(
    argv: list[str], env: Mapping[str, str] | None = None, runner: Runner | None = None
) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv[1:])
    env = dict(os.environ if env is None else env)
    workspace, temp = env.get("GITHUB_WORKSPACE"), env.get("RUNNER_TEMP")
    if not workspace or not temp:
        print("ERROR: GITHUB_WORKSPACE と RUNNER_TEMP が要ります", file=sys.stderr)
        return 1
    try:
        sources = from_json(json.loads(args.sources.read_text(encoding="utf-8")))
    except (OSError, ValueError) as error:
        print(f"ERROR: {args.sources}: {error}", file=sys.stderr)
        return 1
    summary_path = env.get("GITHUB_STEP_SUMMARY")
    summary = open(summary_path, "a", encoding="utf-8") if summary_path else sys.stdout
    try:
        Build(
            sources=sources,
            workspace=Path(workspace),
            temp=Path(temp),
            out=args.out.resolve(),
            env=env,
            run=runner or _subprocess_runner(Path(workspace)),
            summary=summary,
        ).all()
    except (BuildError, ReleaseSourcesError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    finally:
        if summary is not sys.stdout:
            summary.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
