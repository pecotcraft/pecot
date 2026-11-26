"""pages_site/release_sources.py と release_build.py のテスト。リリース版の材料を決め、その材料で側を作る。"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import read_output, run_attached  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
_PAGES_SITE = _REPO / ".githooks/scripts/pages_site"
_SOURCES = _PAGES_SITE / "release_sources.py"
if str(_PAGES_SITE) not in sys.path:
    sys.path.insert(0, str(_PAGES_SITE))

import release_build  # noqa: E402
import release_sources  # noqa: E402
from release_sources import (  # noqa: E402
    ReleaseSourcesError,
    latest_tags,
    report_dev,
    report_release,
    resolve,
)

A, B, C = "a" * 40, "b" * 40, "c" * 40


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
        main="origin/main",
    )


def test_resolve_takes_skeleton_from_each_tag() -> None:
    # A <- B <- C の順に積まれ、C がほかのすべてを祖先に持つ。
    sources = _resolve({"a": A, "b": B, "c": C}, {(A, B), (A, C), (B, C)})
    assert sources.skeleton == C
    assert sources.tags == {"a": "a-v1.0.0", "b": "b-v1.0.0", "c": "c-v1.0.0"}
    assert sources.commits == {"a": A, "b": B, "c": C}
    assert sources.record() == {
        "tags": {"a": "a-v1.0.0", "b": "b-v1.0.0", "c": "c-v1.0.0"},
        "commits": {"a": A, "b": B, "c": C},
        "skeleton": C,
    }
    assert sources.to_json() == sources.record()


def test_resolve_accepts_tags_on_same_commit() -> None:
    sources = _resolve({"a": A, "b": A}, set())
    assert sources.skeleton == A


def test_resolve_fails_without_skeleton() -> None:
    # B と C が A から分かれ、どちらも他方を祖先に持たない。
    with pytest.raises(ReleaseSourcesError, match="祖先に持つタグがありません"):
        _resolve({"a": A, "b": B, "c": C}, {(A, B), (A, C)})


def test_resolve_fails_when_tag_is_not_ancestor_of_main() -> None:
    with pytest.raises(
        ReleaseSourcesError, match=f"b-v1.0.0（{B}）が origin/main の祖先ではありません"
    ):
        _resolve({"a": A, "b": B}, {(A, B)}, main_ancestors={A})


def test_from_json_reads_back_cli_output() -> None:
    sources = _resolve({"a": A, "b": B}, {(A, B)})
    assert release_sources.from_json(json.loads(json.dumps(sources.to_json()))) == sources


def test_from_json_accepts_sources_without_lanes() -> None:
    data = {"tags": {"a": "a-v1.0.0"}, "commits": {"a": A}, "skeleton": A}
    assert release_sources.from_json(data) == release_sources.ReleaseSources(
        tags={"a": "a-v1.0.0"}, commits={"a": A}, skeleton=A
    )


# --- CLI（一時の git リポ） ---


def _git(repo: Path, *args: str) -> str:
    return run_attached(
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
    return run_attached(
        [sys.executable, str(_SOURCES), "--root", str(repo), "--main", "main", *args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_cli_resolves_from_git_tags(repo: Path, tmp_path: Path) -> None:
    manifests = {
        "plugins/a/.claude-plugin/plugin.json": "{}",
        "plugins/b/.claude-plugin/plugin.json": "{}",
    }
    first = _commit(repo, manifests, "first")
    _git(repo, "tag", "a-v1.9.0")
    _git(repo, "tag", "b-v0.1.0")
    second = _commit(repo, {"plugins/b/x.txt": "x"}, "second")
    _git(repo, "tag", "-a", "-m", "b", "b-v0.2.0")
    _git(repo, "tag", "a-v2.0.0-rc.1")

    record = tmp_path / "out/release-sources.json"
    result = _run_cli(repo, "--record", str(record))

    assert result.returncode == 0, result.stderr
    assert result.stdout.count("\n") == 1
    expected = {
        "tags": {"a": "a-v1.9.0", "b": "b-v0.2.0"},
        "commits": {"a": first, "b": second},
        "skeleton": second,
    }
    # 標準出力は tags・commits・skeleton だけで、レーンの一覧を持たない。
    assert json.loads(result.stdout) == expected
    assert json.loads(read_output(record)) == expected


def test_cli_fails_when_tag_is_off_main(repo: Path) -> None:
    _commit(repo, {"plugins/a/.claude-plugin/plugin.json": "{}"}, "first")
    _git(repo, "checkout", "-q", "-b", "side")
    side = _commit(repo, {"x.txt": "x"}, "side")
    _git(repo, "tag", "a-v1.0.0")

    result = _run_cli(repo)

    assert result.returncode == 1
    assert f"ERROR: a-v1.0.0（{side}）が main の祖先ではありません" in result.stderr


# --- ReportSources（report_release・report_dev） ---

D = "d" * 40
_REPORT_LANES = ".githooks/scripts/test_report/report-lanes.json"


def _rlane(
    project: str, target: str, plugin: str | None = None, *, results: str | None = None
) -> dict[str, str]:
    entry = {"project": project, "target": target}
    if plugin is not None:
        entry["plugin"] = plugin
    entry["results"] = results or f"{project}/test-results/{target}/allure-results"
    return entry


def _excluded(project: str, target: str, plugin: str | None = None) -> dict[str, str]:
    entry = {"project": project, "target": target, "excluded": "bash の *.test.sh"}
    if plugin is not None:
        entry["plugin"] = plugin
    return entry


def _job(entry: dict[str, str], commit: str) -> dict[str, str]:
    lane = f"{entry['project']}:{entry['target']}"
    return {
        "lane": lane,
        "slug": lane.replace(":", "-"),
        "results": entry["results"],
        "commit": commit,
    }


def _report(
    commits: dict[str, str],
    ancestors: set[tuple[str, str]],
    lanes_of: dict[str, object],
    main_ancestors: set[str] | None = None,
) -> release_sources.ReportSources:
    tag_to_commit = {f"{p}-v1.0.0": c for p, c in commits.items()}
    main_ok = set(commits.values()) if main_ancestors is None else main_ancestors

    def is_ancestor(a: str, b: str) -> bool:
        if b == "origin/main":
            return a in main_ok
        return a == b or (a, b) in ancestors

    return report_release(
        [*tag_to_commit, "a-v0.9.0"],
        list(commits),
        commit_of=lambda tag: tag_to_commit.get(tag, "0" * 40),
        is_ancestor=is_ancestor,
        read_lanes=lambda commit: lanes_of.get(commit),
        main="origin/main",
    )


def test_report_release_takes_each_plugins_lanes_from_its_tag() -> None:
    # A・C・D は B の祖先で、B が骨組み。C には report-lanes.json が無く、D には入れるレーンが無い。
    a_cli = _rlane("a", "test-cli", "a", results="plugins/a/old/allure-results")
    lanes_a = [a_cli, _rlane("b", "test-old", "b"), _rlane("githooks", "test-old")]
    b_cli, b_hooks = _rlane("b", "test-cli", "b"), _rlane("b", "test-hooks", "b")
    ci, unit = _rlane("githooks", "test-ci"), _rlane("text-rules", "test-unit")
    lanes_b = [_rlane("a", "test-cli", "a"), b_cli, b_hooks, ci, _excluded("x", "test-bash"), unit]
    lanes_d = [_excluded("d", "test-bootstrap", "d"), _rlane("b", "test-d", "b")]
    sources = _report(
        {"a": A, "b": B, "c": C, "d": D},
        {(A, B), (C, B), (D, B)},
        {A: lanes_a, B: lanes_b, D: lanes_d},
    )

    assert sources.record() == {
        "side": "release",
        "runs": [
            {"commit": A, "lanes": ["a:test-cli"]},
            {"commit": B, "lanes": ["b:test-cli", "b:test-hooks"]},
            {"commit": B, "lanes": ["githooks:test-ci", "text-rules:test-unit"]},
        ],
        "missing": ["c", "d"],
    }
    # results は、そのレーンを入れたコミットの report-lanes.json の値。
    assert sources.jobs == [
        _job(a_cli, A),
        _job(b_cli, B),
        _job(b_hooks, B),
        _job(ci, B),
        _job(unit, B),
    ]


def test_report_release_without_report_lanes_makes_no_runs() -> None:
    sources = _report({"a": A, "b": B}, {(A, B)}, {})
    assert sources.record() == {"side": "release", "runs": [], "missing": ["a", "b"]}
    assert sources.jobs == []


def test_report_release_leaves_out_shared_lanes_when_skeleton_has_no_report_lanes() -> None:
    # 骨組みの B に report-lanes.json が無いので、A のファイルにある githooks のレーンは入れない。
    a_cli = _rlane("a", "test-cli", "a")
    sources = _report({"a": A, "b": B}, {(A, B)}, {A: [a_cli, _rlane("githooks", "test-ci")]})
    assert sources.record() == {
        "side": "release",
        "runs": [{"commit": A, "lanes": ["a:test-cli"]}],
        "missing": ["b"],
    }
    assert sources.jobs == [_job(a_cli, A)]


def test_report_release_makes_no_runs_when_only_shared_lanes_remain() -> None:
    # どのプラグインも結果を出せなければ、骨組みのレーンだけのレポートは作らない。
    lanes = [_excluded("a", "test-bootstrap", "a"), _rlane("githooks", "test-ci")]
    sources = _report({"a": A}, set(), {A: lanes})
    assert sources.record() == {"side": "release", "runs": [], "missing": ["a"]}
    assert sources.jobs == []


def test_report_release_fails_like_release_sources() -> None:
    with pytest.raises(
        ReleaseSourcesError, match=f"b-v1.0.0（{B}）が origin/main の祖先ではありません"
    ):
        _report({"a": A, "b": B}, {(A, B)}, {}, main_ancestors={A})
    with pytest.raises(ReleaseSourcesError, match="祖先に持つタグがありません"):
        _report({"a": A, "b": B, "c": C}, {(A, B), (A, C)}, {})


def test_report_release_fails_naming_tag_of_malformed_report_lanes() -> None:
    with pytest.raises(ReleaseSourcesError, match=f"b-v1.0.0:{_REPORT_LANES}: .*#1"):
        _report({"a": A, "b": B}, {(A, B)}, {B: [{"project": "b"}]})


def test_report_dev_takes_every_report_lane_of_the_commit() -> None:
    cli, ci = _rlane("p", "test-cli", "p"), _rlane("githooks", "test-ci")
    sources = report_dev(
        A,
        read_lanes=lambda commit: {A: [cli, _excluded("p", "test-bootstrap", "p"), ci]}.get(commit),
    )
    assert sources.record() == {
        "side": "dev",
        "runs": [{"commit": A, "lanes": ["githooks:test-ci", "p:test-cli"]}],
        "missing": [],
    }
    assert sources.jobs == [_job(ci, A), _job(cli, A)]


def test_report_dev_fails_without_report_lanes() -> None:
    with pytest.raises(ReleaseSourcesError, match=f"{A[:7]} に {_REPORT_LANES} がありません"):
        report_dev(A, read_lanes=lambda commit: None)


def test_report_dev_requires_full_sha() -> None:
    with pytest.raises(ReleaseSourcesError, match="40 桁の SHA ではありません: HEAD"):
        report_dev("HEAD", read_lanes=lambda commit: [])


def test_cli_report_dev_prints_sources_and_matrix(repo: Path) -> None:
    cli, ci = _rlane("a", "test-cli", "a"), _rlane("githooks", "test-ci")
    head = _commit(
        repo,
        {
            "plugins/a/.claude-plugin/plugin.json": "{}",
            _REPORT_LANES: json.dumps([cli, _excluded("a", "test-bootstrap", "a"), ci]),
        },
        "first",
    )

    result = _run_cli(repo, "--report", "dev", "--commit", head)

    assert result.returncode == 0, result.stderr
    assert result.stdout.count("\n") == 1
    assert json.loads(result.stdout) == {
        "sources": {
            "side": "dev",
            "runs": [{"commit": head, "lanes": ["a:test-cli", "githooks:test-ci"]}],
            "missing": [],
        },
        "matrix": [_job(cli, head), _job(ci, head)],
    }


def test_cli_report_release_resolves_from_git_tags(repo: Path) -> None:
    manifests = {
        "plugins/a/.claude-plugin/plugin.json": "{}",
        "plugins/b/.claude-plugin/plugin.json": "{}",
    }
    _commit(repo, manifests, "first")
    _git(repo, "tag", "a-v1.0.0")
    b_cli, ci = _rlane("b", "test-cli", "b"), _rlane("githooks", "test-ci")
    second = _commit(
        repo, {_REPORT_LANES: json.dumps([_rlane("a", "test-cli", "a"), b_cli, ci])}, "second"
    )
    _git(repo, "tag", "-a", "-m", "b", "b-v1.0.0")
    _git(repo, "tag", "a-v2.0.0-rc.1")

    result = _run_cli(repo, "--report", "release")

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "sources": {
            "side": "release",
            "runs": [
                {"commit": second, "lanes": ["b:test-cli"]},
                {"commit": second, "lanes": ["githooks:test-ci"]},
            ],
            "missing": ["a"],
        },
        "matrix": [_job(b_cli, second), _job(ci, second)],
    }


def test_cli_report_release_without_report_lanes_has_empty_matrix(repo: Path) -> None:
    _commit(repo, {"plugins/a/.claude-plugin/plugin.json": "{}"}, "first")
    _git(repo, "tag", "a-v1.0.0")

    result = _run_cli(repo, "--report", "release")

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "sources": {"side": "release", "runs": [], "missing": ["a"]},
        "matrix": [],
    }


def test_git_reader_returns_none_without_the_path(repo: Path) -> None:
    head = _commit(repo, {"x.txt": "x"}, "first")
    assert release_sources._git_reader(repo, _REPORT_LANES)(head) is None


def _blobless_clone(repo: Path, tmp_path: Path) -> Path:
    """repo を blob:none で clone し、取得元を消したリポ。blob を読むと取りに行って失敗する。"""
    bare, clone = tmp_path / "bare.git", tmp_path / "clone"
    _git(tmp_path, "clone", "-q", "--bare", str(repo), str(bare))
    _git(bare, "config", "uploadpack.allowFilter", "true")
    _git(
        tmp_path, "clone", "-q", "--no-checkout", "--filter=blob:none", f"file://{bare}", str(clone)
    )
    shutil.rmtree(bare)
    return clone


def test_git_reader_tells_unreadable_blob_from_missing_path(repo: Path, tmp_path: Path) -> None:
    head = _commit(repo, {_REPORT_LANES: "[]"}, "first")
    clone = _blobless_clone(repo, tmp_path)
    read = release_sources._git_reader(clone, _REPORT_LANES)

    assert release_sources._git_reader(clone, "none.json")(head) is None
    with pytest.raises(ReleaseSourcesError) as caught:
        read(head)
    message = str(caught.value)
    assert message.startswith(f"git show {head}:{_REPORT_LANES} が失敗しました: ")
    assert "promisor remote" in message


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["--report", "dev"], "--report dev には --commit が要ります"),
        (["--report", "release", "--commit", A], "--commit は --report dev だけで使えます"),
        (["--report", "dev", "--commit", A, "--record", "x.json"], "--report は --record"),
        (["--commit", A], "--commit は --report dev だけで使えます"),
    ],
)
def test_cli_report_rejects_wrong_arguments(repo: Path, args: list[str], message: str) -> None:
    result = _run_cli(repo, *args)
    assert result.returncode == 2
    assert message in result.stderr


# --- release_build ---


class FakeRunner:
    """外のコマンドを記録する。"""

    def __init__(self, workspace: Path, *, fail: Mapping[str, int] | None = None) -> None:
        self.workspace = workspace
        self.fail = dict(fail or {})
        self.calls: list[tuple[str, ...]] = []
        self.envs: list[dict[str, str]] = []

    def __call__(self, argv: Sequence[str], *, env: Mapping[str, str]) -> int:
        call = self._short(argv)
        self.calls.append(call)
        self.envs.append(dict(env))
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
        return tuple(args)


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    (ws / ".githooks/ci").mkdir(parents=True)
    (ws / ".githooks/ci/dev-container.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    return ws


def _sources_file(tmp_path: Path) -> Path:
    path = tmp_path / "sources.json"
    path.write_text(
        json.dumps(
            {
                "tags": {"b": "b-v2.0.0", "a": "a-v1.0.0"},
                "commits": {"b": B, "a": A},
                "skeleton": B,
            }
        ),
        encoding="utf-8",
    )
    return path


def _report_sources_file(tmp_path: Path, record: object) -> Path:
    path = tmp_path / "report-sources.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    return path


def _report_record(missing: list[str]) -> dict[str, object]:
    """release_sources.py --report release の標準出力の sources の形。"""
    commits = {"a": A, "b": B}
    runs = [
        {"commit": c, "lanes": [f"{p}:test-cli"]} for p, c in commits.items() if p not in missing
    ]
    return {"side": "release", "runs": runs, "missing": missing}


def _main(
    tmp_path: Path, workspace: Path, runner: FakeRunner, report: object | None = None
) -> tuple[int, Path, Path]:
    temp, out = tmp_path / "runner-temp", tmp_path / "out"
    temp.mkdir()
    env = {
        "GITHUB_WORKSPACE": str(workspace),
        "RUNNER_TEMP": str(temp),
        "DEVCONTAINER_ENV": "PECOT_SITE_SIDE\nPECOT_SITE_PR\n",
        "PECOT_SITE_SIDE": "release",
    }
    report_file = _report_sources_file(tmp_path, _report_record([]) if report is None else report)
    rc = release_build.main(
        [
            "release_build.py",
            "--sources",
            str(_sources_file(tmp_path)),
            "--report-sources",
            str(report_file),
            "--out",
            str(out),
        ],
        env=env,
        runner=runner,
    )
    return rc, temp, out


def test_build_runs_steps_in_order(
    tmp_path: Path, workspace: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    runner = FakeRunner(workspace)
    rc, temp, out = _main(tmp_path, workspace, runner)

    assert rc == 0, capsys.readouterr().err
    ws = str(workspace)
    expected: list[tuple[str, ...]] = [
        # 1. skeleton に各プラグインのタグの中身を重ねる。テストのレーンは動かさない
        ("restore-owner",),
        ("git", "checkout", "--force", B),
        ("give-owner",),
        ("exec", "pnpm install --frozen-lockfile"),
        ("restore-owner",),
        ("git", "rm", "-r", "-q", "--ignore-unmatch", "plugins/a"),
        ("git", "checkout", A, "--", "plugins/a"),
        ("git", "rm", "-r", "-q", "--ignore-unmatch", "plugins/b"),
        ("git", "checkout", B, "--", "plugins/b"),
        # 2. サイトを作る
        ("give-owner",),
        ("exec", "pnpm exec nx run interface-spec:docs --skip-nx-cache"),
        # 3. 包む
        ("restore-owner",),
        ("tar", "-C", f"{ws}/libs/interface-spec/docs/_build", "-cf", f"{out}/site.tar", "."),
    ]
    assert runner.calls == expected

    assert json.loads(read_output(out / "release-sources.json")) == {
        "tags": {"b": "b-v2.0.0", "a": "a-v1.0.0"},
        "commits": {"b": B, "a": A},
        "skeleton": B,
    }
    # 呼ぶスクリプトは、作業ツリーの外の写しを使う。
    assert (temp / "pages-release-tools/dev-container.sh").is_file()


def test_build_passes_site_env_to_container(tmp_path: Path, workspace: Path) -> None:
    runner = FakeRunner(workspace)
    rc, _, _ = _main(tmp_path, workspace, runner)

    assert rc == 0
    docs = runner.calls.index(("exec", "pnpm exec nx run interface-spec:docs --skip-nx-cache"))
    env = runner.envs[docs]
    assert env["PECOT_SITE_SIDE"] == "release"
    assert env["DEVCONTAINER_ENV"].split() == [
        "PECOT_SITE_SIDE",
        "PECOT_SITE_PR",
        "PECOT_SITE_REPORT_PLUGINS",
    ]
    # 消した版の値を、もう渡さない。
    assert "PECOT_SITE_SHA" not in env
    assert "PECOT_SITE_PLUGIN_COMMITS" not in env
    assert "PECOT_SITE_LANES" not in env
    # サイトを作る段の外では、レポートに入るプラグインを足さない。
    others = [e for i, e in enumerate(runner.envs) if i != docs]
    assert all("PECOT_SITE_REPORT_PLUGINS" not in e for e in others)


@pytest.mark.parametrize(
    ("missing", "expected"),
    [([], "a,b"), (["b"], "a"), (["a", "b"], "")],
    ids=["all", "partial", "empty"],
)
def test_build_passes_plugins_in_the_report_to_container(
    tmp_path: Path, workspace: Path, missing: list[str], expected: str
) -> None:
    runner = FakeRunner(workspace)
    rc, _, _ = _main(tmp_path, workspace, runner, _report_record(missing))

    assert rc == 0
    docs = runner.calls.index(("exec", "pnpm exec nx run interface-spec:docs --skip-nx-cache"))
    env = runner.envs[docs]
    assert env["PECOT_SITE_REPORT_PLUGINS"] == expected
    assert "PECOT_SITE_REPORT_PLUGINS" in env["DEVCONTAINER_ENV"].split()


@pytest.mark.parametrize(
    "record",
    [
        {"side": "dev", "runs": [], "missing": []},
        {"side": "release", "runs": []},
        {"side": "release", "runs": [], "missing": "a"},
        {"side": "release", "runs": [], "missing": [1]},
        [],
    ],
    ids=["dev-side", "no-missing", "missing-not-list", "missing-not-str", "not-object"],
)
def test_build_rejects_malformed_report_sources(
    tmp_path: Path, workspace: Path, record: object, capsys: pytest.CaptureFixture[str]
) -> None:
    runner = FakeRunner(workspace)
    rc, _, _ = _main(tmp_path, workspace, runner, record)

    assert rc == 1
    assert "report-sources.json" in capsys.readouterr().err
    assert runner.calls == []


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
            "--report-sources",
            str(_report_sources_file(tmp_path, _report_record([]))),
            "--out",
            str(tmp_path / "out"),
        ],
        env={},
        runner=FakeRunner(tmp_path),
    )
    assert rc == 1
    assert "GITHUB_WORKSPACE と RUNNER_TEMP" in capsys.readouterr().err
