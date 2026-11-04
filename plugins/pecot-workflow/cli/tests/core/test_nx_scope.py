"""tests/core/test_nx_scope.py - core/nx_scope.py のユニットテスト

nx は ``subprocess.run``、git は ``cli.core.nx_scope.run_git`` を差し替える。
実 nx の契約（graph の出力形式）は ``TestRealNxContract`` が固定する。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from cli.core.nx_scope import (
    NxProject,
    changed_files,
    expected_scope,
    nx_projects,
    parse_title_scope,
    resolve_nx,
)

# parents[0]=core / [1]=tests / [2]=cli / [3]=pecot-workflow / [4]=plugins / [5]=リポルート
_REPO_ROOT = Path(__file__).resolve().parents[5]

# (root, tags)
GRAPH = {
    "pecot-workflow": ("plugins/pecot-workflow", ["type:plugin", "scope:p-w"]),
    "pecot-visual": ("plugins/pecot-visual", ["scope:p-v"]),
    "nx-release": (".nx/nx-release", ["scope:repo"]),
    "text-rules": ("libs/text-rules", ["scope:libs"]),
    "slide-kit": ("libs/slide-kit", ["scope:libs"]),
    "no-tag": ("tools/no-tag", ["type:tool"]),
}
PROJECTS = {
    "pecot-workflow": NxProject("plugins/pecot-workflow", "p-w"),
    "pecot-visual": NxProject("plugins/pecot-visual", "p-v"),
    "nx-release": NxProject(".nx/nx-release", "repo"),
    "text-rules": NxProject("libs/text-rules", "libs"),
    "slide-kit": NxProject("libs/slide-kit", "libs"),
    "no-tag": NxProject("tools/no-tag", "no-tag"),
}


def _make_nx(toplevel: Path) -> Path:
    nx = toplevel / "node_modules" / ".bin" / "nx"
    nx.parent.mkdir(parents=True)
    nx.write_text("#!/bin/sh\n")
    nx.chmod(0o755)
    return nx


def _graph(projects: dict[str, tuple[str, list[str]]]) -> str:
    nodes = {
        name: {"name": name, "data": {"root": root, "tags": tags}}
        for name, (root, tags) in projects.items()
    }
    return json.dumps({"graph": {"nodes": nodes}})


def _fake_nx_run(graph_text: str, *, returncode: int = 0, stderr: str = "") -> Any:
    """``--file=`` に graph を書いて CompletedProcess を返す subprocess.run の代役"""

    def run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        file_arg = next(a for a in cmd if a.startswith("--file="))
        Path(file_arg.removeprefix("--file=")).write_text(graph_text, encoding="utf-8")
        return subprocess.CompletedProcess(cmd, returncode, stdout="", stderr=stderr)

    return run


class TestResolveNx:
    def test_prefers_local_node_modules(self, tmp_path: Path) -> None:
        nx = _make_nx(tmp_path)
        with patch("shutil.which", return_value="/usr/bin/nx"):
            assert resolve_nx(tmp_path) == nx

    def test_falls_back_to_path(self, tmp_path: Path) -> None:
        with patch("shutil.which", return_value="/usr/bin/nx"):
            assert resolve_nx(tmp_path) == Path("/usr/bin/nx")

    def test_none_when_missing(self, tmp_path: Path) -> None:
        with patch("shutil.which", return_value=None):
            assert resolve_nx(tmp_path) is None


class TestNxProjects:
    def test_reads_roots_and_scope_tags_from_graph_file(self, tmp_path: Path) -> None:
        nx = _make_nx(tmp_path)
        with patch("subprocess.run", side_effect=_fake_nx_run(_graph(GRAPH))) as run:
            assert nx_projects(tmp_path) == PROJECTS
        cmd = run.call_args.args[0]
        assert cmd[:2] == [str(nx), "graph"]
        assert run.call_args.kwargs["cwd"] == tmp_path
        assert run.call_args.kwargs["stdin"] == subprocess.DEVNULL
        assert run.call_args.kwargs["timeout"] > 0

    def test_graph_file_is_under_pecot_tmp_and_removed(self, tmp_path: Path) -> None:
        _make_nx(tmp_path)
        seen: list[str] = []

        def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            seen.append(next(a for a in cmd if a.startswith("--file=")))
            return _fake_nx_run(_graph(GRAPH))(cmd, **kwargs)

        with patch("subprocess.run", side_effect=run):
            nx_projects(tmp_path)
        assert seen[0].startswith(f"--file={tmp_path / '.pecot' / 'tmp'}/")
        assert list((tmp_path / ".pecot" / "tmp").iterdir()) == []

    def test_dot_root_is_kept(self, tmp_path: Path) -> None:
        _make_nx(tmp_path)
        with patch("subprocess.run", side_effect=_fake_nx_run(_graph({"root": (".", [])}))):
            assert nx_projects(tmp_path) == {"root": NxProject(".", "root")}

    @pytest.mark.parametrize("tags", [None, [], ["scope:"], "scope:x"])
    def test_project_name_is_used_without_scope_tag(self, tmp_path: Path, tags: Any) -> None:
        _make_nx(tmp_path)
        data: dict[str, Any] = {"root": "a"} if tags is None else {"root": "a", "tags": tags}
        text = json.dumps({"graph": {"nodes": {"a-b": {"name": "a-b", "data": data}}}})
        with patch("subprocess.run", side_effect=_fake_nx_run(text)):
            assert nx_projects(tmp_path) == {"a-b": NxProject("a", "a-b")}

    def test_none_without_nx(self, tmp_path: Path) -> None:
        with patch("shutil.which", return_value=None):
            assert nx_projects(tmp_path) is None

    def test_none_on_nonzero_exit(self, tmp_path: Path) -> None:
        _make_nx(tmp_path)
        with patch("subprocess.run", side_effect=_fake_nx_run(_graph(GRAPH), returncode=1)):
            assert nx_projects(tmp_path) is None

    def test_none_on_partial_graph(self, tmp_path: Path) -> None:
        _make_nx(tmp_path)
        run = _fake_nx_run(_graph(GRAPH), stderr="Showing partial graph (errors)")
        with patch("subprocess.run", side_effect=run):
            assert nx_projects(tmp_path) is None

    def test_none_on_timeout(self, tmp_path: Path) -> None:
        _make_nx(tmp_path)
        err = subprocess.TimeoutExpired(cmd="nx", timeout=1)
        with patch("subprocess.run", side_effect=err):
            assert nx_projects(tmp_path) is None

    def test_none_when_nx_cannot_start(self, tmp_path: Path) -> None:
        _make_nx(tmp_path)
        with patch("subprocess.run", side_effect=OSError("exec format error")):
            assert nx_projects(tmp_path) is None

    @pytest.mark.parametrize(
        "text", ["not json", "{}", '{"graph": {"nodes": {"a": {"name": "a"}}}}', "[]"]
    )
    def test_none_on_unparsable_graph(self, tmp_path: Path, text: str) -> None:
        _make_nx(tmp_path)
        with patch("subprocess.run", side_effect=_fake_nx_run(text)):
            assert nx_projects(tmp_path) is None


class TestChangedFiles:
    def test_splits_on_nul_and_uses_triple_dot(self, tmp_path: Path) -> None:
        calls: list[list[str]] = []

        def run_git(args: list[str], cwd: Path | None = None, *, check: bool) -> MagicMock:
            calls.append(args)
            assert cwd == tmp_path
            assert check is True
            return MagicMock(stdout="a/b.py\0日本語/c.md\0")

        with patch("cli.core.nx_scope.run_git", side_effect=run_git):
            files = changed_files(tmp_path, "origin/main", "feat/x/1")

        assert files == ["a/b.py", "日本語/c.md"]
        assert calls[-1] == [
            "diff",
            "-z",
            "--name-only",
            "--no-renames",
            "origin/main...feat/x/1",
        ]
        assert ["rev-parse", "--verify", "--quiet", "feat/x/1^{commit}"] in calls

    def test_empty_diff_is_empty_list(self, tmp_path: Path) -> None:
        with patch("cli.core.nx_scope.run_git", return_value=MagicMock(stdout="")):
            assert changed_files(tmp_path, "origin/main", "HEAD") == []

    def test_none_when_ref_unresolved(self, tmp_path: Path) -> None:
        err = subprocess.CalledProcessError(1, "git")
        with patch("cli.core.nx_scope.run_git", side_effect=err):
            assert changed_files(tmp_path, "origin/main", "HEAD") is None

    def test_none_when_git_missing(self, tmp_path: Path) -> None:
        with patch("cli.core.nx_scope.run_git", side_effect=FileNotFoundError):
            assert changed_files(tmp_path, "origin/main", "HEAD") is None


class TestExpectedScope:
    def test_single_project(self) -> None:
        files = ["plugins/pecot-workflow/cli/a.py", "plugins/pecot-workflow/README.md"]
        assert expected_scope(files, PROJECTS) == ["p-w"]

    def test_multiple_projects_sorted(self) -> None:
        files = ["plugins/pecot-workflow/a.py", "plugins/pecot-visual/b.ts"]
        assert expected_scope(files, PROJECTS) == ["p-v", "p-w"]

    def test_longest_match_wins(self) -> None:
        roots = {
            "outer": NxProject("plugins/x", "outer"),
            "inner": NxProject("plugins/x/sub", "inner"),
        }
        assert expected_scope(["plugins/x/sub/f.py"], roots) == ["inner"]
        assert expected_scope(["plugins/x/other.py"], roots) == ["outer"]

    def test_prefix_of_directory_name_is_not_a_match(self) -> None:
        assert expected_scope(["plugins/pecot-workflow-extra/a.py"], PROJECTS) == ["repo"]

    def test_file_outside_projects_adds_repo_last(self) -> None:
        files = ["plugins/pecot-workflow/a.py", "CLAUDE.md"]
        assert expected_scope(files, PROJECTS) == ["p-w", "repo"]

    def test_only_outside_files(self) -> None:
        assert expected_scope([".githooks/pre-commit/x.sh"], PROJECTS) == ["repo"]

    def test_dot_root_project_owns_everything(self) -> None:
        roots = {"root": NxProject(".", "root"), "lib": NxProject("packages/lib", "lib")}
        assert expected_scope(["README.md", "packages/lib/a.ts"], roots) == ["lib", "root"]

    def test_version_plans_are_excluded(self) -> None:
        files = ["plugins/pecot-workflow/a.py", ".nx/version-plans/1-x.md"]
        assert expected_scope(files, PROJECTS) == ["p-w"]

    def test_only_version_plans_is_empty(self) -> None:
        assert expected_scope([".nx/version-plans/1-x.md"], PROJECTS) == []

    def test_nx_release_project_is_not_version_plans(self) -> None:
        assert expected_scope([".nx/nx-release/src/x.js"], PROJECTS) == ["repo"]

    def test_empty_diff(self) -> None:
        assert expected_scope([], PROJECTS) == []

    def test_projects_with_the_same_scope_tag_share_one_scope(self) -> None:
        files = ["libs/text-rules/a.ts", "libs/slide-kit/b.ts", "plugins/pecot-workflow/c.py"]
        assert expected_scope(files, PROJECTS) == ["libs", "p-w"]

    def test_project_tagged_repo_is_listed_last(self) -> None:
        files = [".nx/nx-release/src/x.js", "plugins/pecot-workflow/c.py", "CLAUDE.md"]
        assert expected_scope(files, PROJECTS) == ["p-w", "repo"]

    def test_project_without_scope_tag_uses_its_name(self) -> None:
        assert expected_scope(["tools/no-tag/a.sh"], PROJECTS) == ["no-tag"]


class TestParseTitleScope:
    @pytest.mark.parametrize(
        ("title", "expected"),
        [
            ("feat(pecot-workflow): #1 x", ["pecot-workflow"]),
            ("feat(a,b): #1 x", ["a", "b"]),
            ("feat(a, b): #1 x", ["a", " b"]),
            ("fix(a)!: #1 x", ["a"]),
            ("feat(pecot-workflow,repo): x", ["pecot-workflow", "repo"]),
            ("feat: #1 x", None),
            ("feat(): #1 x", None),
            ("(a): x", None),
            ("plain title", None),
            ("", None),
        ],
    )
    def test_parse(self, title: str, expected: list[str] | None) -> None:
        assert parse_title_scope(title) == expected


class TestRealNxContract:
    """リポジトリ実体の nx で graph の形式を固定する（nx の版上げで形式が変わると落ちる）"""

    def test_reads_plugin_roots_from_real_graph(self) -> None:
        if not (_REPO_ROOT / "node_modules" / ".bin" / "nx").exists():
            pytest.skip("node_modules/.bin/nx が無い（npm ci 前）ため実 nx テストを skip する")

        projects = nx_projects(_REPO_ROOT)

        assert projects is not None
        assert projects["pecot-workflow"] == NxProject("plugins/pecot-workflow", "p-w")
        assert projects["pecot-visual"] == NxProject("plugins/pecot-visual", "p-v")
        assert projects["pecot-tools"] == NxProject("plugins/pecot-tools", "p-t")
        assert projects["text-rules"] == NxProject("libs/text-rules", "libs")
        assert projects["nx-release"].scope == "repo"
