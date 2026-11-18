"""pages_site/release_sources.py と release_build.py のテスト。リリース版の材料を決め、その材料で側を作る。"""

from __future__ import annotations

import io
import json
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import TextIO

import pytest

_REPO = Path(__file__).resolve().parents[2]
_PAGES_SITE = _REPO / ".githooks/scripts/pages_site"
_SOURCES = _PAGES_SITE / "release_sources.py"
if str(_PAGES_SITE) not in sys.path:
    sys.path.insert(0, str(_PAGES_SITE))

import release_build  # noqa: E402
import release_sources  # noqa: E402
from release_sources import ReleaseSourcesError, latest_tags, resolve  # noqa: E402

A, B, C = "a" * 40, "b" * 40, "c" * 40


def _lane(plugin: str, name: str) -> dict[str, str]:
    return {
        "plugin": plugin,
        "target": f"{plugin}:{name}",
        "junit": f"plugins/{plugin}/cli/test-results/{name}.xml",
    }


# --- latest_tags ---


def test_latest_tags_take_numeric_max_without_prerelease() -> None:
    tags = [
        "pecot-visual-v1.9.0",
        "pecot-visual-v1.10.0",
        "pecot-visual-v2.0.0-rc.1",
        "pecot-visual-v1.10.0-beta",
        "pecot-workflow-v8.0.0",
        "pecot-workflow-v10.0.0",
        "text-rules-v0.2.8",
    ]
    assert latest_tags(tags, ["pecot-workflow", "pecot-visual"]) == {
        "pecot-visual": "pecot-visual-v1.10.0",
        "pecot-workflow": "pecot-workflow-v10.0.0",
    }


def test_latest_tags_do_not_take_tags_of_plugin_with_longer_name() -> None:
    tags = ["pecot-visual-v1.0.0", "pecot-visual-x-v9.0.0", "pecot-visual-x-v1.0.0"]
    assert latest_tags(tags, ["pecot-visual", "pecot-visual-x"]) == {
        "pecot-visual": "pecot-visual-v1.0.0",
        "pecot-visual-x": "pecot-visual-x-v9.0.0",
    }


def test_latest_tags_fail_for_plugin_without_tag() -> None:
    with pytest.raises(ReleaseSourcesError, match="pecot-tools のリリースのタグ"):
        latest_tags(
            ["pecot-workflow-v1.0.0", "pecot-tools-v1.0.0-rc.1"], ["pecot-workflow", "pecot-tools"]
        )


# --- resolve ---


def _resolve(
    commits: dict[str, str],
    ancestors: set[tuple[str, str]],
    lanes_of: dict[str, object],
    main_ancestors: set[str] | None = None,
) -> release_sources.ReleaseSources:
    tag_to_commit = {f"{p}-v1.0.0": c for p, c in commits.items()}
    main_ok = set(commits.values()) if main_ancestors is None else main_ancestors

    def is_ancestor(a: str, b: str) -> bool:
        if b == "origin/main":
            return a in main_ok
        return a == b or (a, b) in ancestors

    return resolve(
        [*tag_to_commit, "a-v0.9.0"],
        list(commits),
        commit_of=lambda tag: tag_to_commit.get(tag, "0" * 40),
        is_ancestor=is_ancestor,
        read_lanes=lambda commit: lanes_of.get(commit),
        main="origin/main",
    )


def test_resolve_takes_skeleton_and_lanes_from_each_tag() -> None:
    # A <- B <- C の順に積まれ、C がほかのすべてを祖先に持つ。
    lanes_a = [_lane("a", "test-cli"), _lane("b", "old-lane")]
    lanes_b = [_lane("a", "test-new"), _lane("b", "test-cli"), _lane("b", "test-hooks")]
    lanes_c = [_lane("c", "test-cli")]
    sources = _resolve(
        {"a": A, "b": B, "c": C},
        {(A, B), (A, C), (B, C)},
        {A: lanes_a, B: lanes_b, C: lanes_c},
    )
    assert sources.skeleton == C
    assert sources.tags == {"a": "a-v1.0.0", "b": "b-v1.0.0", "c": "c-v1.0.0"}
    assert sources.commits == {"a": A, "b": B, "c": C}
    assert sources.lanes == [
        _lane("a", "test-cli"),
        _lane("b", "test-cli"),
        _lane("b", "test-hooks"),
        _lane("c", "test-cli"),
    ]
    assert sources.record() == {
        "tags": {"a": "a-v1.0.0", "b": "b-v1.0.0", "c": "c-v1.0.0"},
        "commits": {"a": A, "b": B, "c": C},
        "skeleton": C,
    }


def test_resolve_accepts_tags_on_same_commit() -> None:
    sources = _resolve({"a": A, "b": A}, set(), {A: [_lane("a", "t"), _lane("b", "t")]})
    assert sources.skeleton == A


def test_resolve_fails_without_skeleton() -> None:
    # B と C が A から分かれ、どちらも他方を祖先に持たない。
    with pytest.raises(ReleaseSourcesError, match="祖先に持つタグがありません"):
        _resolve({"a": A, "b": B, "c": C}, {(A, B), (A, C)}, {})


def test_resolve_fails_when_tag_is_not_ancestor_of_main() -> None:
    with pytest.raises(
        ReleaseSourcesError, match=f"b-v1.0.0（{B}）が origin/main の祖先ではありません"
    ):
        _resolve({"a": A, "b": B}, {(A, B)}, {}, main_ancestors={A})


def test_resolve_fails_naming_tag_without_junit_lanes() -> None:
    with pytest.raises(
        ReleaseSourcesError,
        match="a-v1.0.0 のコミットに libs/interface-spec/docs/junit-lanes.json がありません",
    ):
        _resolve({"a": A, "b": B}, {(A, B)}, {B: [_lane("b", "t")]})


def test_resolve_fails_on_malformed_lanes() -> None:
    with pytest.raises(
        ReleaseSourcesError, match="b-v1.0.0:libs/interface-spec/docs/junit-lanes.json #1"
    ):
        _resolve({"a": A, "b": B}, {(A, B)}, {A: [_lane("a", "t")], B: [{"plugin": "b"}]})


def test_from_json_reads_back_cli_output() -> None:
    sources = _resolve({"a": A, "b": B}, {(A, B)}, {A: [_lane("a", "t")], B: [_lane("b", "t")]})
    assert release_sources.from_json(json.loads(json.dumps(sources.to_json()))) == sources


# --- CLI（一時の git リポ） ---


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    ).stdout.strip()


def _commit(repo: Path, files: dict[str, str], message: str) -> str:
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "t")
    _git(repo, "config", "commit.gpgsign", "false")
    _git(repo, "config", "tag.gpgsign", "false")
    return repo


def _run_cli(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(_SOURCES), "--root", str(repo), "--main", "main", *args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_cli_resolves_from_git_tags(repo: Path, tmp_path: Path) -> None:
    lanes_file = "libs/interface-spec/docs/junit-lanes.json"
    manifests = {
        "plugins/a/.claude-plugin/plugin.json": "{}",
        "plugins/b/.claude-plugin/plugin.json": "{}",
    }
    first = _commit(
        repo,
        {**manifests, lanes_file: json.dumps([_lane("a", "test-cli"), _lane("b", "test-old")])},
        "first",
    )
    _git(repo, "tag", "a-v1.9.0")
    _git(repo, "tag", "b-v0.1.0")
    second = _commit(
        repo, {lanes_file: json.dumps([_lane("a", "test-new"), _lane("b", "test-cli")])}, "second"
    )
    _git(repo, "tag", "-a", "-m", "b", "b-v0.2.0")
    _git(repo, "tag", "a-v2.0.0-rc.1")

    record, lanes = tmp_path / "out/release-sources.json", tmp_path / "out/junit-lanes.json"
    result = _run_cli(repo, "--record", str(record), "--lanes", str(lanes))

    assert result.returncode == 0, result.stderr
    assert result.stdout.count("\n") == 1
    expected_lanes = [_lane("a", "test-cli"), _lane("b", "test-cli")]
    assert json.loads(result.stdout) == {
        "tags": {"a": "a-v1.9.0", "b": "b-v0.2.0"},
        "commits": {"a": first, "b": second},
        "skeleton": second,
        "lanes": expected_lanes,
    }
    assert json.loads(record.read_text(encoding="utf-8")) == {
        "tags": {"a": "a-v1.9.0", "b": "b-v0.2.0"},
        "commits": {"a": first, "b": second},
        "skeleton": second,
    }
    assert json.loads(lanes.read_text(encoding="utf-8")) == expected_lanes


def test_cli_fails_naming_tag_without_junit_lanes(repo: Path) -> None:
    _commit(repo, {"plugins/a/.claude-plugin/plugin.json": "{}"}, "first")
    _git(repo, "tag", "a-v8.0.0")

    result = _run_cli(repo)

    assert result.returncode == 1
    assert result.stdout == ""
    assert (
        "ERROR: a-v8.0.0 のコミットに libs/interface-spec/docs/junit-lanes.json がありません"
        in result.stderr
    )


def test_cli_fails_when_tag_is_off_main(repo: Path) -> None:
    lanes_file = "libs/interface-spec/docs/junit-lanes.json"
    _commit(
        repo,
        {"plugins/a/.claude-plugin/plugin.json": "{}", lanes_file: json.dumps([_lane("a", "t")])},
        "first",
    )
    _git(repo, "checkout", "-q", "-b", "side")
    side = _commit(repo, {"x.txt": "x"}, "side")
    _git(repo, "tag", "a-v1.0.0")

    result = _run_cli(repo)

    assert result.returncode == 1
    assert f"ERROR: a-v1.0.0（{side}）が main の祖先ではありません" in result.stderr


# --- release_build ---

_LANES = [_lane("a", "test-cli"), _lane("a", "test-hooks"), _lane("b", "test-cli")]


class FakeRunner:
    """外のコマンドを記録する。nx run のレーンでは、作業ツリーへ JUnit を書いたことにする。"""

    def __init__(self, workspace: Path, *, fail: Mapping[str, int] | None = None) -> None:
        self.workspace = workspace
        self.fail = dict(fail or {})
        self.calls: list[tuple[str, ...]] = []
        self.envs: list[dict[str, str]] = []
        self.junit_at_collect: list[str] = []

    def __call__(
        self, argv: Sequence[str], *, env: Mapping[str, str], stdout: TextIO | None = None
    ) -> int:
        call = self._short(argv)
        self.calls.append(call)
        self.envs.append(dict(env))
        if call[0] == "exec" and "nx run " in call[1] and "interface-spec:docs" not in call[1]:
            target = call[1].split("nx run ")[1].split()[0]
            lane = next(lane for lane in _LANES if lane["target"] == target)
            path = self.workspace / lane["junit"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"<testsuites name='{target}'/>", encoding="utf-8")
        if call[0] == "collect":
            assert stdout is not None
            stdout.write("## summary\n")
            self.junit_at_collect = sorted(
                str(p.relative_to(self.workspace)) for p in self.workspace.rglob("*.xml")
            )
        text = " ".join(call)
        return next((rc for key, rc in self.fail.items() if key in text), 0)

    def _short(self, argv: Sequence[str]) -> tuple[str, ...]:
        args = list(argv)
        if args[0].endswith("dev-container.sh"):
            if args[1] == "exec":
                return ("exec", args[3].removeprefix("cd /workspaces/base/pecot && "))
            return (args[1],)
        if args[0] == "git":
            return ("git", *args[3:])
        if args[0] == "python3":
            return ("collect", *args[2:])
        return tuple(args)


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    (ws / ".githooks/ci").mkdir(parents=True)
    (ws / ".githooks/ci/dev-container.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    (ws / ".githooks/scripts/pages_site").mkdir(parents=True)
    for name in ("collect.py", "lanes.py"):
        (ws / ".githooks/scripts/pages_site" / name).write_text("", encoding="utf-8")
    # 前の run の JUnit が残っていても、レーンの前に消す。
    stale = ws / "plugins/b/cli/test-results/test-cli.xml"
    stale.parent.mkdir(parents=True)
    stale.write_text("stale", encoding="utf-8")
    return ws


def _sources_file(tmp_path: Path) -> Path:
    path = tmp_path / "sources.json"
    path.write_text(
        json.dumps(
            {
                "tags": {"b": "b-v2.0.0", "a": "a-v1.0.0"},
                "commits": {"b": B, "a": A},
                "skeleton": B,
                "lanes": _LANES,
            }
        ),
        encoding="utf-8",
    )
    return path


def _main(tmp_path: Path, workspace: Path, runner: FakeRunner) -> tuple[int, Path, Path]:
    temp, out, summary = tmp_path / "runner-temp", tmp_path / "out", tmp_path / "summary.md"
    temp.mkdir()
    env = {
        "GITHUB_WORKSPACE": str(workspace),
        "RUNNER_TEMP": str(temp),
        "GITHUB_STEP_SUMMARY": str(summary),
        "DEVCONTAINER_ENV": "PECOT_SITE_STRICT\n",
        "PECOT_SITE_STRICT": "1",
    }
    rc = release_build.main(
        ["release_build.py", "--sources", str(_sources_file(tmp_path)), "--out", str(out)],
        env=env,
        runner=runner,
    )
    return rc, temp, out


def test_build_runs_steps_in_order(
    tmp_path: Path, workspace: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    runner = FakeRunner(workspace, fail={"nx run a:test-hooks": 3})
    rc, temp, out = _main(tmp_path, workspace, runner)

    assert rc == 0, capsys.readouterr().err
    ws = str(workspace)
    install = ("exec", "pnpm install --frozen-lockfile")
    expected: list[tuple[str, ...]] = [
        # 1. プラグインごとに、タグのコミットでそのプラグインのレーンを動かす（名前順）
        ("restore-owner",),
        ("git", "checkout", "--force", A),
        ("give-owner",),
        install,
        ("exec", "pnpm exec nx run a:test-cli --skip-nx-cache"),
        ("exec", "pnpm exec nx run a:test-hooks --skip-nx-cache"),
        ("restore-owner",),
        ("restore-owner",),
        ("git", "checkout", "--force", B),
        ("give-owner",),
        install,
        ("exec", "pnpm exec nx run b:test-cli --skip-nx-cache"),
        ("restore-owner",),
        # 2. skeleton に各プラグインのタグの中身を重ねる
        ("restore-owner",),
        ("git", "checkout", "--force", B),
        ("give-owner",),
        install,
        ("restore-owner",),
        ("git", "rm", "-r", "-q", "--ignore-unmatch", "plugins/a"),
        ("git", "checkout", A, "--", "plugins/a"),
        ("git", "rm", "-r", "-q", "--ignore-unmatch", "plugins/b"),
        ("git", "checkout", B, "--", "plugins/b"),
        # 3. JUnit をそろえて写す
        (
            "collect",
            "--lanes",
            str(temp / "pages-release-lanes.json"),
            "--side",
            "release",
            "--sha",
            B,
            "--root",
            ws,
            "--out",
            str(out),
        ),
        # 4. サイトを作る
        ("give-owner",),
        ("exec", "pnpm exec nx run interface-spec:docs --skip-nx-cache"),
        # 5. 包む
        ("restore-owner",),
        ("tar", "-C", f"{ws}/libs/interface-spec/docs/_build", "-cf", f"{out}/site.tar", "."),
    ]
    assert runner.calls == expected

    # レーンの JUnit は、collect の時点で元の場所に戻っている。落ちたレーンは warning を出して続ける。
    assert runner.junit_at_collect == [
        "plugins/a/cli/test-results/test-cli.xml",
        "plugins/a/cli/test-results/test-hooks.xml",
        "plugins/b/cli/test-results/test-cli.xml",
    ]
    assert "<testsuites name='b:test-cli'/>" == (
        workspace / "plugins/b/cli/test-results/test-cli.xml"
    ).read_text(encoding="utf-8")
    assert "::warning::a:test-hooks exited with 3" in capsys.readouterr().out
    assert json.loads((temp / "pages-release-lanes.json").read_text(encoding="utf-8")) == _LANES
    assert (tmp_path / "summary.md").read_text(encoding="utf-8") == "## summary\n"
    assert json.loads((out / "release-sources.json").read_text(encoding="utf-8")) == {
        "tags": {"b": "b-v2.0.0", "a": "a-v1.0.0"},
        "commits": {"b": B, "a": A},
        "skeleton": B,
    }
    # 呼ぶスクリプトは、作業ツリーの外の写しを使う。
    assert (temp / "pages-release-tools/dev-container.sh").is_file()
    assert (temp / "pages-release-tools/collect.py").is_file()


def test_build_passes_site_env_to_container(tmp_path: Path, workspace: Path) -> None:
    runner = FakeRunner(workspace)
    rc, _, _ = _main(tmp_path, workspace, runner)

    assert rc == 0
    docs = runner.calls.index(("exec", "pnpm exec nx run interface-spec:docs --skip-nx-cache"))
    env = runner.envs[docs]
    assert env["PECOT_SITE_SIDE"] == "release"
    assert json.loads(env["PECOT_SITE_LANES"]) == _LANES
    assert env["PECOT_SITE_STRICT"] == "1"
    assert env["DEVCONTAINER_ENV"].split() == [
        "PECOT_SITE_STRICT",
        "PECOT_SITE_SIDE",
        "PECOT_SITE_LANES",
    ]
    # 消した版の値を、もう渡さない。
    assert "PECOT_SITE_SHA" not in env
    assert "PECOT_SITE_PLUGIN_COMMITS" not in env
    # サイトを作る段の外では、PECOT_SITE_* を足さない。
    others = [e for i, e in enumerate(runner.envs) if i != docs]
    assert all("PECOT_SITE_SIDE" not in e for e in others)


def test_build_stops_when_collect_fails(
    tmp_path: Path, workspace: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    runner = FakeRunner(workspace, fail={"--side release": 1})
    rc, _, out = _main(tmp_path, workspace, runner)

    assert rc == 1
    assert "JUnit のそろわないレーンがあり" in capsys.readouterr().err
    assert runner.calls[-1][0] == "collect"
    assert not (out / "release-sources.json").exists()


@pytest.mark.parametrize(
    ("fail", "last"),
    [
        (f"checkout --force {B}", ("git", "checkout", "--force", B)),
        ("pnpm install", ("exec", "pnpm install --frozen-lockfile")),
        ("interface-spec:docs", ("exec", "pnpm exec nx run interface-spec:docs --skip-nx-cache")),
    ],
)
def test_build_stops_on_host_or_install_or_site_failure(
    tmp_path: Path,
    workspace: Path,
    fail: str,
    last: tuple[str, ...],
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = FakeRunner(workspace, fail={fail: 2})
    rc, _, _ = _main(tmp_path, workspace, runner)

    assert rc == 1
    assert runner.calls[-1] == last
    assert "が 2 で終わりました" in capsys.readouterr().err


def test_build_requires_runner_env(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    rc = release_build.main(
        [
            "release_build.py",
            "--sources",
            str(_sources_file(tmp_path)),
            "--out",
            str(tmp_path / "out"),
        ],
        env={},
        runner=FakeRunner(tmp_path),
    )
    assert rc == 1
    assert "GITHUB_WORKSPACE と RUNNER_TEMP" in capsys.readouterr().err


def test_collect_writes_summary_to_given_stream(tmp_path: Path, workspace: Path) -> None:
    runner = FakeRunner(workspace)
    buffer = io.StringIO()
    build = release_build.Build(
        sources=release_sources.from_json(
            json.loads(_sources_file(tmp_path).read_text(encoding="utf-8"))
        ),
        workspace=workspace,
        temp=tmp_path,
        out=tmp_path / "out",
        env={},
        run=runner,
        summary=buffer,
    )
    build.collect()
    assert buffer.getvalue() == "## summary\n"
