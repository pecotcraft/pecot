"""pages_site/release_sources.py と release_build.py のテスト。リリース版の材料を決め、その材料で側を作る。"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

import allure
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
    Unit,
    latest_tags,
    report_release,
    resolve,
    units,
)

A, B, C = "a" * 40, "b" * 40, "c" * 40


def _unit(name: str, sep: str = "-") -> Unit:
    """plugins/<名前> に置き、タグが <名前><sep>v<semver> の単位。"""
    return Unit(name=name, root=f"plugins/{name}", tag=f"{name}{sep}v{{version}}")


# --- latest_tags ---


@allure.title("最新のタグは、プレリリースを除き、版を数値として比べた最大のものを選ぶ")
def test_latest_tags_take_numeric_max_without_prerelease() -> None:
    """`release_sources.py` の `latest_tags` のテストです。`1.9.0` と `1.10.0` を数値として比較して後者を選び、`rc` や `beta` のタグと、対象外の単位のタグは選ばないことを確認します。"""
    with allure.step("タグの一覧を用意する"):
        tags = [
            "pecot-visual-v1.9.0",
            "pecot-visual-v1.10.0",
            "pecot-visual-v2.0.0-rc.1",
            "pecot-visual-v1.10.0-beta",
            "pecot-workflow-v8.0.0",
            "pecot-workflow-v10.0.0",
            "text-rules-v0.2.8",
        ]
    with allure.step("プレリリースを除いた数の最大のタグが選ばれることを確かめる"):
        assert latest_tags(tags, [_unit("pecot-workflow"), _unit("pecot-visual")]) == {
            "pecot-visual": "pecot-visual-v1.10.0",
            "pecot-workflow": "pecot-workflow-v10.0.0",
        }


@allure.title("最新のタグは、名前が長い別の単位のタグを、同じ単位のものとして扱わない")
def test_latest_tags_do_not_take_tags_of_plugin_with_longer_name() -> None:
    """`pecot-visual` と `pecot-visual-x` のように、一方の名前が他方の接頭辞になっている場合のテストです。`latest_tags` が、それぞれの単位のタグだけから最新を選ぶことを確認します。"""
    with allure.step("名前が長い別の単位のタグを混ぜた一覧を用意する"):
        tags = ["pecot-visual-v1.0.0", "pecot-visual-x-v9.0.0", "pecot-visual-x-v1.0.0"]
    with allure.step("名前が長い単位のタグを取らないことを確かめる"):
        assert latest_tags(tags, [_unit("pecot-visual"), _unit("pecot-visual-x")]) == {
            "pecot-visual": "pecot-visual-v1.0.0",
            "pecot-visual-x": "pecot-visual-x-v9.0.0",
        }


@allure.title("タグの形が <名前>/v{version} の単位は、その形のタグだけから最新を選ぶ")
def test_latest_tags_follow_slash_v_tag_form() -> None:
    """タグの形が `pecot-actions/v{version}` の単位を渡す場合のテストです。`/v` のタグから数値の最大を選び、`-v` のタグとプレリリースのタグは選ばないことを確認します。"""
    with allure.step("/v と -v のタグを混ぜた一覧を用意する"):
        tags = [
            "pecot-actions/v1.9.0",
            "pecot-actions/v1.10.0",
            "pecot-actions/v2.0.0-rc.1",
            "pecot-actions-v9.0.0",
        ]
    with allure.step("/v の形のタグだけから最新が選ばれることを確かめる"):
        assert latest_tags(tags, [_unit("pecot-actions", "/")]) == {
            "pecot-actions": "pecot-actions/v1.10.0"
        }


@allure.title(
    "単位にリリースのタグが存在しないと、最新のタグの選択で、その単位のタグの形を示す例外が発生する"
)
@pytest.mark.parametrize(
    ("unit", "message"),
    [
        (
            _unit("pecot-tools"),
            r"pecot-tools のリリースのタグ（pecot-tools-v<semver>）がありません",
        ),
        (
            _unit("pecot-actions", "/"),
            r"pecot-actions のリリースのタグ（pecot-actions/v<semver>）がありません",
        ),
    ],
    ids=["dash-v", "slash-v"],
)
def test_latest_tags_fail_for_plugin_without_tag(unit: Unit, message: str) -> None:
    """プレリリースのタグと、形の違うタグしか存在しない単位を渡す場合のテストです。`ReleaseSourcesError` が発生し、メッセージに単位の名前とタグの形が含まれることを確認します。"""
    with allure.step("タグの無い単位があると失敗することを確かめる"):
        with pytest.raises(ReleaseSourcesError, match=message):
            latest_tags(
                [
                    "pecot-workflow-v1.0.0",
                    "pecot-tools-v1.0.0-rc.1",
                    "pecot-actions-v1.0.0",
                    "pecot-actions/v1.0.0-rc.1",
                ],
                [_unit("pecot-workflow"), unit],
            )


# --- units ---


def _group(name: str, pattern: str | None = None) -> dict[str, object]:
    """nx.json の release.groups の 1 項目。pattern を省くと <名前>-v{version}。"""
    return {
        "projects": [name],
        "projectsRelationship": "fixed",
        "releaseTag": {"pattern": pattern or f"{name}-v{{version}}"},
    }


def _unit_files(
    plugins: Mapping[str, Mapping[str, object]], groups: Mapping[str, object]
) -> dict[str, str]:
    """targets.json と nx.json を、リポのルートからのパスと中身で返す。"""
    return {
        release_sources.TARGETS: json.dumps({"format": 1, "plugins": plugins}),
        release_sources.NX_JSON: json.dumps({"release": {"groups": groups}}),
    }


def _plain_units(*names: str) -> dict[str, str]:
    """root を持たず、タグが <名前>-v{version} の単位だけの targets.json と nx.json。"""
    return _unit_files({n: {} for n in names}, {n: _group(n) for n in names})


def _write(root: Path, files: Mapping[str, str]) -> None:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


@allure.title(
    "単位は、targets.json の plugins の各キーと、nx.json の同じ名前のグループのタグの形から決まる"
)
def test_units_read_targets_and_release_groups(tmp_path: Path) -> None:
    """`units` に、`root` を持つ項目と持たない項目の `targets.json` と、`nx.json` のグループを渡す場合のテストです。`root` の既定が `plugins/<名前>` で、`{releaseGroupName}` をグループ名で補ったタグの形になることを確認します。"""
    with allure.step("targets.json と nx.json を書く"):
        _write(
            tmp_path,
            _unit_files(
                {"acts": {"root": "actions", "entries": "complete"}, "p": {}},
                {
                    "acts": _group("acts", "{releaseGroupName}/v{version}"),
                    "p": _group("p", "p-v{version}"),
                    "text-rules": _group("text-rules"),
                },
            ),
        )
    with allure.step("単位を読む"):
        found = units(tmp_path)
    with allure.step("名前・置き場所・タグの形を確かめる"):
        # targets.json に無いグループ（text-rules）は単位にしない。
        assert found == {
            "acts": Unit(name="acts", root="actions", tag="acts/v{version}"),
            "p": Unit(name="p", root="plugins/p", tag="p-v{version}"),
        }


@allure.title("nx.json のグループが {param_id} の場合、単位の決定で理由を示す例外が発生する")
@pytest.mark.parametrize(
    ("groups", "message"),
    [
        (
            {"q": _group("q")},
            "nx.json に、libs/interface-spec/targets.json の p と同じ名前のリリースのグループがありません",
        ),
        (
            {"p": {**_group("p"), "projects": ["p", "q"]}},
            r'グループ p の projects が \["p"\] ではありません: \["p", "q"\]',
        ),
        (
            {"p": {**_group("p"), "projects": ["q"]}},
            r'グループ p の projects が \["p"\] ではありません: \["q"\]',
        ),
        (
            {"p": {"projects": ["p"]}},
            r"グループ p に releaseTag.pattern がありません（nx の既定の形は読みません）",
        ),
        (
            {"p": _group("p", "{projectName}-v{version}")},
            r"nx は \{projectName\} を補わずにタグを打ちます",
        ),
        (
            {"p": _group("p", "v{version}")},
            r"releaseTag.pattern（v\{version\}）を補った形が p-v\{version\} でも p/v\{version\} でもありません",
        ),
        ({"p": _group("p", "p@{version}")}, r"releaseTag.pattern（p@\{version\}）を補った形が"),
    ],
    ids=[
        "no-group",
        "two-projects",
        "other-project",
        "no-pattern",
        "project-name",
        "no-prefix",
        "at-sign",
    ],
)
def test_units_fail_for_wrong_release_group(
    tmp_path: Path, groups: dict[str, object], message: str
) -> None:
    """`targets.json` の単位 `p` に対して、`nx.json` のグループが不正な場合のテストです。`units` が `ReleaseSourcesError` を発生し、メッセージに不正な理由が含まれることを確認します。"""
    with allure.step("不正なグループの nx.json を書く"):
        _write(tmp_path, _unit_files({"p": {}}, groups))
    with allure.step("単位の決定が失敗することを確かめる"):
        with pytest.raises(ReleaseSourcesError, match=message):
            units(tmp_path)


@allure.title(
    "このリポの targets.json と nx.json から、4 つのリリース版の単位と、そのタグの形が決まる"
)
def test_units_of_this_repo() -> None:
    """このリポジトリの `targets.json` と `nx.json` で `units` を呼ぶ場合のテストです。サイトの名前とリリースのグループがそろい、`pecot-actions` の置き場所が `actions` で、タグの形が `pecot-actions/v{version}` であることを確認します。"""
    with allure.step("このリポの単位を読む"):
        found = units(_REPO)
    with allure.step("4 つの単位の置き場所とタグの形を確かめる"):
        assert found == {
            "pecot-actions": Unit(
                name="pecot-actions", root="actions", tag="pecot-actions/v{version}"
            ),
            "pecot-tools": _unit("pecot-tools"),
            "pecot-visual": _unit("pecot-visual"),
            "pecot-workflow": _unit("pecot-workflow"),
        }


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
        [_unit(p) for p in commits],
        commit_of=lambda tag: tag_to_commit.get(tag, "0" * 40),
        is_ancestor=is_ancestor,
        main="origin/main",
    )


@allure.title("骨組みは、すべてのタグの commit を祖先に持つ commit から選ぶ")
def test_resolve_takes_skeleton_from_each_tag() -> None:
    """`resolve` に、`A`、`B`、`C` の順に積まれた 3 つのタグの commit を渡す場合のテストです。`C` が骨組みになり、`tags`、`commits`、`record()` と `to_json()` の内容が期待どおりであることを確認します。"""
    with allure.step("祖先の関係があるタグを解決する"):
        # A <- B <- C の順に積まれ、C がほかのすべてを祖先に持つ。
        sources = _resolve({"a": A, "b": B, "c": C}, {(A, B), (A, C), (B, C)})
    with allure.step("骨組み・タグ・commit・記録を確かめる"):
        assert sources.skeleton == C
        assert sources.tags == {"a": "a-v1.0.0", "b": "b-v1.0.0", "c": "c-v1.0.0"}
        assert sources.commits == {"a": A, "b": B, "c": C}
        assert sources.record() == {
            "tags": {"a": "a-v1.0.0", "b": "b-v1.0.0", "c": "c-v1.0.0"},
            "commits": {"a": A, "b": B, "c": C},
            "skeleton": C,
        }
        assert sources.to_json() == sources.record()


@allure.title("複数のタグが同じ commit を指していても、その commit を骨組みにする")
def test_resolve_accepts_tags_on_same_commit() -> None:
    """2 つのタグが、同じ commit `A` を指す場合のテストです。`resolve` の結果の `skeleton` が `A` であることを確認します。"""
    with allure.step("同じ commit のタグを解決する"):
        sources = _resolve({"a": A, "b": A}, set())
    with allure.step("骨組みがその commit になることを確かめる"):
        assert sources.skeleton == A


@allure.title("すべてのタグの commit を祖先に持つ commit が存在しないと、例外が発生する")
def test_resolve_fails_without_skeleton() -> None:
    """`B` と `C` が `A` から分岐していて、どちらも他方を祖先に持たない場合のテストです。`ReleaseSourcesError` が発生し、祖先に持つタグが存在しない旨のメッセージが含まれることを確認します。"""
    with allure.step("骨組みになるタグが無いと解決が失敗することを確かめる"):
        # B と C が A から分かれ、どちらも他方を祖先に持たない。
        with pytest.raises(ReleaseSourcesError, match="祖先に持つタグがありません"):
            _resolve({"a": A, "b": B, "c": C}, {(A, B), (A, C)})


@allure.title("タグの commit が main の祖先でないと、そのタグ名と commit を示す例外が発生する")
def test_resolve_fails_when_tag_is_not_ancestor_of_main() -> None:
    """タグ `b-v1.0.0` の commit が、`origin/main` の祖先ではない場合のテストです。`ReleaseSourcesError` が発生し、タグ名と commit を含むメッセージになることを確認します。"""
    with allure.step("main の祖先でないタグがあると解決が失敗することを確かめる"):
        with pytest.raises(
            ReleaseSourcesError, match=f"b-v1.0.0（{B}）が origin/main の祖先ではありません"
        ):
            _resolve({"a": A, "b": B}, {(A, B)}, main_ancestors={A})


@allure.title("from_json は、to_json の出力を読み戻して、元の内容に戻す")
def test_from_json_reads_back_cli_output() -> None:
    """`resolve` の結果を JSON にして、読み込み直す場合のテストです。`from_json` の戻り値が、元の `ReleaseSources` と一致することを確認します。"""
    with allure.step("解決の結果を JSON にして読み戻す"):
        sources = _resolve({"a": A, "b": B}, {(A, B)})
    with allure.step("元の結果と同じになることを確かめる"):
        assert release_sources.from_json(json.loads(json.dumps(sources.to_json()))) == sources


@allure.title("from_json は、レーンの一覧が存在しない材料も読み込める")
def test_from_json_accepts_sources_without_lanes() -> None:
    """`tags`、`commits`、`skeleton` だけを持つ辞書を渡す場合のテストです。`from_json` が、同じ値の `ReleaseSources` を返すことを確認します。"""
    with allure.step("レーンの無い JSON を読み込む"):
        data = {"tags": {"a": "a-v1.0.0"}, "commits": {"a": A}, "skeleton": A}
    with allure.step("読み込めてレーンが空になることを確かめる"):
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


@allure.title("CLI は、git のタグから各単位の最新の版と骨組みを決めて出力する")
def test_cli_resolves_from_git_tags(repo: Path, tmp_path: Path) -> None:
    """一時の git リポジトリに、2 つの単位のタグを付けて `release_sources.py` を実行する場合のテストです。標準出力が `tags`、`commits`、`skeleton` だけの 1 行の JSON で、`--record` のファイルも同じ内容になることを確認します。"""
    with allure.step("タグを打った git のリポで CLI を動かす"):
        first = _commit(repo, _plain_units("a", "b"), "first")
        _git(repo, "tag", "a-v1.9.0")
        _git(repo, "tag", "b-v0.1.0")
        second = _commit(repo, {"plugins/b/x.txt": "x"}, "second")
        _git(repo, "tag", "-a", "-m", "b", "b-v0.2.0")
        _git(repo, "tag", "a-v2.0.0-rc.1")

        record = tmp_path / "out/release-sources.json"
        result = _run_cli(repo, "--record", str(record))

    with allure.step("終了コードと標準出力と記録のファイルを確かめる"):
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


@allure.title("CLI は、nx.json のグループのタグの形が /v の単位を、その形のタグから決める")
def test_cli_resolves_slash_v_tags_of_a_unit(repo: Path) -> None:
    """`root` が `actions` で、タグの形が `{releaseGroupName}/v{version}` の単位を持つ一時の git リポジトリのテストです。`/v` のタグから最新を選び、同じ名前の `-v` のタグは選ばないことを確認します。"""
    with allure.step("/v のタグを打った git のリポで CLI を動かす"):
        files = _unit_files(
            {"acts": {"root": "actions"}, "b": {}},
            {"acts": _group("acts", "{releaseGroupName}/v{version}"), "b": _group("b")},
        )
        first = _commit(repo, files, "first")
        _git(repo, "tag", "acts/v1.0.0")
        _git(repo, "tag", "b-v1.0.0")
        _commit(repo, {"actions/x.txt": "x"}, "second")
        _git(repo, "tag", "acts-v9.0.0")
        _git(repo, "tag", "acts/v1.1.0-rc.1")

        result = _run_cli(repo)

    with allure.step("終了コードと標準出力を確かめる"):
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == {
            "tags": {"acts": "acts/v1.0.0", "b": "b-v1.0.0"},
            "commits": {"acts": first, "b": first},
            "skeleton": first,
        }


@allure.title("CLI は、単位のリリースのグループが nx.json に存在しないと、終了コード 1 で終わる")
def test_cli_fails_when_unit_has_no_release_group(repo: Path) -> None:
    """`targets.json` の単位 `b` と同じ名前のグループが、`nx.json` に存在しない一時の git リポジトリのテストです。終了コード 1 で終わり、グループが存在しない旨を標準エラーに出力することを確認します。"""
    with allure.step("グループの無い単位を持つ git のリポで CLI を動かす"):
        _commit(repo, _unit_files({"a": {}, "b": {}}, {"a": _group("a")}), "first")
        _git(repo, "tag", "a-v1.0.0")

        result = _run_cli(repo)

    with allure.step("終了コード 1 とエラーの出力を確かめる"):
        assert result.returncode == 1
        assert "の b と同じ名前のリリースのグループがありません" in result.stderr


@allure.title("CLI は、タグが main の祖先でないと、終了コード 1 で終わる")
def test_cli_fails_when_tag_is_off_main(repo: Path) -> None:
    """`main` から分岐したブランチの commit に、タグを付ける場合のテストです。終了コード 1 で終わり、タグ名と commit を含むエラーを標準エラーに出力することを確認します。"""
    with allure.step("main の外にタグがある git のリポで CLI を動かす"):
        _commit(repo, _plain_units("a"), "first")
        _git(repo, "checkout", "-q", "-b", "side")
        side = _commit(repo, {"x.txt": "x"}, "side")
        _git(repo, "tag", "a-v1.0.0")

        result = _run_cli(repo)

    with allure.step("終了コード 1 とエラーの出力を確かめる"):
        assert result.returncode == 1
        assert f"ERROR: a-v1.0.0（{side}）が main の祖先ではありません" in result.stderr


# --- ReportSources（report_release） ---

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
        [_unit(p) for p in commits],
        commit_of=lambda tag: tag_to_commit.get(tag, "0" * 40),
        is_ancestor=is_ancestor,
        read_lanes=lambda commit: lanes_of.get(commit),
        main="origin/main",
    )


@allure.title(
    "リリース版のレポートは、各プラグインのレーンを、そのタグの commit の report-lanes.json から選ぶ"
)
def test_report_release_takes_each_plugins_lanes_from_its_tag() -> None:
    """`report_release` に、複数のプラグインのタグと、commit ごとのレーンの一覧を渡す場合のテストです。`runs` と `missing` が期待どおりで、`jobs` の `results` がレーンを入れた commit の値になることを確認します。"""
    with allure.step("プラグインごとのタグのレーンを用意して release のレポートを作る"):
        # A・C・D は B の祖先で、B が骨組み。C には report-lanes.json が無く、D には入れるレーンが無い。
        a_cli = _rlane("a", "test-cli", "a", results="plugins/a/old/allure-results")
        lanes_a = [a_cli, _rlane("b", "test-old", "b"), _rlane("githooks", "test-old")]
        b_cli, b_hooks = _rlane("b", "test-cli", "b"), _rlane("b", "test-hooks", "b")
        ci, unit = _rlane("githooks", "test-ci"), _rlane("text-rules", "test-unit")
        lanes_b = [
            _rlane("a", "test-cli", "a"),
            b_cli,
            b_hooks,
            ci,
            _excluded("x", "test-bash"),
            unit,
        ]
        lanes_d = [_excluded("d", "test-bootstrap", "d"), _rlane("b", "test-d", "b")]
        sources = _report(
            {"a": A, "b": B, "c": C, "d": D},
            {(A, B), (C, B), (D, B)},
            {A: lanes_a, B: lanes_b, D: lanes_d},
        )

    with allure.step("記録とジョブの一覧を確かめる"):
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


@allure.title(
    "どの commit にも report-lanes.json が存在しないと、リリース版のレポートの run は 0 件になる"
)
def test_report_release_without_report_lanes_makes_no_runs() -> None:
    """どの commit からも、レーンの一覧を読めない場合のテストです。`runs` と `jobs` が空で、すべてのプラグインが `missing` に入ることを確認します。"""
    with allure.step("レポートのレーンが無い状態で release のレポートを作る"):
        sources = _report({"a": A, "b": B}, {(A, B)}, {})
    with allure.step("run が空で missing に全プラグインが入ることを確かめる"):
        assert sources.record() == {"side": "release", "runs": [], "missing": ["a", "b"]}
        assert sources.jobs == []


@allure.title(
    "骨組みに report-lanes.json が存在しないと、共通のレーンはリリース版のレポートに含めない"
)
def test_report_release_leaves_out_shared_lanes_when_skeleton_has_no_report_lanes() -> None:
    """骨組みの commit にレーンの一覧が存在せず、プラグインの commit にだけ存在する場合のテストです。プラグインのレーンだけが `runs` に入り、`githooks` のレーンは含まれないことを確認します。"""
    with allure.step("骨組みにレポートのレーンが無い状態を用意する"):
        # 骨組みの B に report-lanes.json が無いので、A のファイルにある githooks のレーンは入れない。
        a_cli = _rlane("a", "test-cli", "a")
        sources = _report({"a": A, "b": B}, {(A, B)}, {A: [a_cli, _rlane("githooks", "test-ci")]})
    with allure.step("共有のレーンが除かれることを確かめる"):
        assert sources.record() == {
            "side": "release",
            "runs": [{"commit": A, "lanes": ["a:test-cli"]}],
            "missing": ["b"],
        }
        assert sources.jobs == [_job(a_cli, A)]


@allure.title("プラグインのレーンが 1 つも残らないと、共通のレーンだけのレポートは作らない")
def test_report_release_makes_no_runs_when_only_shared_lanes_remain() -> None:
    """プラグインのレーンがすべて除外対象で、共通の `githooks` のレーンだけが残る場合のテストです。`runs` と `jobs` が空になり、プラグインが `missing` に入ることを確認します。"""
    with allure.step("共有のレーンだけが残る状態を用意する"):
        # どのプラグインも結果を出せなければ、骨組みのレーンだけのレポートは作らない。
        lanes = [_excluded("a", "test-bootstrap", "a"), _rlane("githooks", "test-ci")]
        sources = _report({"a": A}, set(), {A: lanes})
    with allure.step("run が空になることを確かめる"):
        assert sources.record() == {"side": "release", "runs": [], "missing": ["a"]}
        assert sources.jobs == []


@allure.title("リリース版のレポートは、タグの検証に失敗すると、材料の決定と同じ例外が発生する")
def test_report_release_fails_like_release_sources() -> None:
    """タグの commit が `main` の祖先でない場合と、骨組みが存在しない場合のテストです。`report_release` が、どちらも `ReleaseSourcesError` を発生することを確認します。"""
    with allure.step("release のレポートが release_sources と同じ失敗をすることを確かめる"):
        with pytest.raises(
            ReleaseSourcesError, match=f"b-v1.0.0（{B}）が origin/main の祖先ではありません"
        ):
            _report({"a": A, "b": B}, {(A, B)}, {}, main_ancestors={A})
        with pytest.raises(ReleaseSourcesError, match="祖先に持つタグがありません"):
            _report({"a": A, "b": B, "c": C}, {(A, B), (A, C)}, {})


@allure.title("report-lanes.json の形が不正だと、そのタグ名を示す例外が発生する")
def test_report_release_fails_naming_tag_of_malformed_report_lanes() -> None:
    """タグの commit の `report-lanes.json` の要素に、必須の項目が存在しない場合のテストです。`ReleaseSourcesError` が発生し、タグ名と要素の番号をメッセージに含むことを確認します。"""
    with allure.step("読めないレポートのレーンがあると、失敗の文にタグが入ることを確かめる"):
        with pytest.raises(ReleaseSourcesError, match=f"b-v1.0.0:{_REPORT_LANES}: .*#1"):
            _report({"a": A, "b": B}, {(A, B)}, {B: [{"project": "b"}]})


@allure.title("CLI は、--report release で、git のタグからレポートの材料とジョブの一覧を決める")
def test_cli_report_release_resolves_from_git_tags(repo: Path) -> None:
    """一時の git リポジトリで、`release_sources.py --report release` を実行する場合のテストです。単位ごとの最新のタグから `runs` と `matrix` を作り、レーンの一覧を持たない単位は `missing` に入ることを確認します。単位 `b` のタグは `/v` の形です。"""
    with allure.step("タグを打った git のリポで release のレポートの CLI を動かす"):
        files = _unit_files(
            {"a": {}, "b": {"root": "acts"}},
            {"a": _group("a"), "b": _group("b", "{releaseGroupName}/v{version}")},
        )
        _commit(repo, files, "first")
        _git(repo, "tag", "a-v1.0.0")
        b_cli, ci = _rlane("b", "test-cli", "b"), _rlane("githooks", "test-ci")
        second = _commit(
            repo, {_REPORT_LANES: json.dumps([_rlane("a", "test-cli", "a"), b_cli, ci])}, "second"
        )
        _git(repo, "tag", "-a", "-m", "b", "b/v1.0.0")
        _git(repo, "tag", "a-v2.0.0-rc.1")

        result = _run_cli(repo, "--report", "release")

    with allure.step("終了コードと標準出力を確かめる"):
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


@allure.title(
    "report-lanes.json が存在しないと、CLI の --report release は空のジョブの一覧を出力する"
)
def test_cli_report_release_without_report_lanes_has_empty_matrix(repo: Path) -> None:
    """レーンの一覧が存在しない一時の git リポジトリで、`--report release` を実行する場合のテストです。終了コード 0 で終わり、`runs` と `matrix` が空で、プラグインが `missing` に入ることを確認します。"""
    with allure.step("レポートのレーンが無い git のリポで release のレポートの CLI を動かす"):
        _commit(repo, _plain_units("a"), "first")
        _git(repo, "tag", "a-v1.0.0")

        result = _run_cli(repo, "--report", "release")

    with allure.step("終了コードと matrix が空の標準出力を確かめる"):
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == {
            "sources": {"side": "release", "runs": [], "missing": ["a"]},
            "matrix": [],
        }


@allure.title("git のリーダーは、指定のパスが存在しない commit に対して、None を返す")
def test_git_reader_returns_none_without_the_path(repo: Path) -> None:
    """`_git_reader` に、存在しないパスを持つ commit を渡す場合のテストです。例外を発生させず、`None` を返すことを確認します。"""
    with allure.step("path の無い commit を用意する"):
        head = _commit(repo, {"x.txt": "x"}, "first")
    with allure.step("読み込みが None を返すことを確かめる"):
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


@allure.title("git のリーダーは、パスが存在しない場合と、blob を読めない場合を区別する")
def test_git_reader_tells_unreadable_blob_from_missing_path(repo: Path, tmp_path: Path) -> None:
    """`blob:none` で clone して、取得元を消したリポジトリのテストです。存在しないパスには `None` を返し、blob を読めないときは `git show` が失敗した旨と `promisor remote` を含む例外が発生することを確認します。"""
    with allure.step("blob を持たない clone を用意する"):
        head = _commit(repo, {_REPORT_LANES: "[]"}, "first")
        clone = _blobless_clone(repo, tmp_path)
        read = release_sources._git_reader(clone, _REPORT_LANES)

    with allure.step("path が無いときは None で、blob が読めないときはエラーになることを確かめる"):
        assert release_sources._git_reader(clone, "none.json")(head) is None
        with pytest.raises(ReleaseSourcesError) as caught:
            read(head)
        message = str(caught.value)
        assert message.startswith(f"git show {head}:{_REPORT_LANES} が失敗しました: ")
        assert "promisor remote" in message


@allure.title("CLI は、引数が {args} だと、終了コード 2 で終わり、{message} を出力する")
@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["--report", "dev"], "invalid choice: 'dev'"),
        (["--report", "release", "--commit", A], f"unrecognized arguments: --commit {A}"),
        (["--report", "release", "--record", "x.json"], "--report は --record"),
    ],
)
def test_cli_report_rejects_wrong_arguments(repo: Path, args: list[str], message: str) -> None:
    """`--report` と `--record` の誤った組み合わせと、開発版の引数を渡す場合のテストです。開発版は `dev_sources.py` が扱うので、終了コード 2 で終わり、その理由を標準エラーに出力することを確認します。"""
    with allure.step("誤った引数で CLI を動かす"):
        result = _run_cli(repo, *args)
    with allure.step("終了コード 2 とエラーの出力を確かめる"):
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
    _write(ws, _plain_units("a", "b"))
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


@allure.title("リリース版の build は、骨組みの取得からサイトの作成、梱包までを決まった順に実行する")
def test_build_runs_steps_in_order(
    tmp_path: Path, workspace: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`release_build.main` を、外部のコマンドを記録する `FakeRunner` で実行する場合のテストです。骨組みの取得、タグの重ね合わせ、サイトの作成、梱包の順にコマンドを実行し、`release-sources.json` が作られることを確認します。"""
    with allure.step("偽の runner で build を動かす"):
        runner = FakeRunner(workspace)
        rc, temp, out = _main(tmp_path, workspace, runner)

    with allure.step("終了コードと手順の順序と出力のファイルを確かめる"):
        assert rc == 0, capsys.readouterr().err
        ws = str(workspace)
        expected: list[tuple[str, ...]] = [
            # 1. skeleton に各単位のタグの中身を重ねる。テストのレーンは動かさない
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


@allure.title(
    "リリース版の build は、targets.json の root を持つ単位を、その root の場所で差し替える"
)
def test_build_assembles_each_unit_at_its_root(
    tmp_path: Path, workspace: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """作業ツリーの `targets.json` で、単位 `a` が `root` に `actions` を持つ場合のテストです。骨組みに重ねるとき、`a` は `actions` を、`b` は `plugins/b` を、それぞれのタグの commit の中身に差し替えることを確認します。"""
    with allure.step("root を持つ単位の targets.json を置いて build を動かす"):
        _write(
            workspace,
            _unit_files(
                {"a": {"root": "actions"}, "b": {}},
                {"a": _group("a", "{releaseGroupName}/v{version}"), "b": _group("b")},
            ),
        )
        runner = FakeRunner(workspace)
        rc, _, _ = _main(tmp_path, workspace, runner)

    with allure.step("単位ごとの差し替えの場所を確かめる"):
        assert rc == 0, capsys.readouterr().err
        swaps = [call for call in runner.calls if call[:2] in (("git", "rm"), ("git", "checkout"))]
        assert swaps == [
            ("git", "checkout", "--force", B),
            ("git", "rm", "-r", "-q", "--ignore-unmatch", "actions"),
            ("git", "checkout", A, "--", "actions"),
            ("git", "rm", "-r", "-q", "--ignore-unmatch", "plugins/b"),
            ("git", "checkout", B, "--", "plugins/b"),
        ]


@allure.title(
    "リリース版の build は、材料の単位が作業ツリーの単位とそろわない（{param_id}）と、何も実行せずに終了コード 1 で終わる"
)
@pytest.mark.parametrize(
    "names",
    [("a",), ("a", "b", "c")],
    ids=["fewer", "more"],
)
def test_build_stops_when_units_differ_from_sources(
    tmp_path: Path, workspace: Path, names: tuple[str, ...], capsys: pytest.CaptureFixture[str]
) -> None:
    """作業ツリーの `targets.json` の単位が、材料の `commits` の単位（`a` と `b`）と異なる場合のテストです。終了コード 1 で終わり、単位がそろわない旨を出力し、外部のコマンドを 1 つも実行しないことを確認します。"""
    with allure.step("材料と異なる単位の targets.json を置いて build を動かす"):
        _write(workspace, _plain_units(*names))
        runner = FakeRunner(workspace)
        rc, _, _ = _main(tmp_path, workspace, runner)

    with allure.step("終了コード 1 とエラーの出力と何も動かないことを確かめる"):
        assert rc == 1
        err = capsys.readouterr().err
        assert f"の単位（a, b）が、作業ツリーの単位（{', '.join(names)}）とそろいません" in err
        assert runner.calls == []


@allure.title(
    "リリース版の build は、作業ツリーの単位を決められないと、何も実行せずに終了コード 1 で終わる"
)
def test_build_stops_when_units_cannot_be_read(
    tmp_path: Path, workspace: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """作業ツリーの `nx.json` に、単位 `b` のリリースのグループが存在しない場合のテストです。終了コード 1 で終わり、グループが存在しない旨を出力し、外部のコマンドを 1 つも実行しないことを確認します。"""
    with allure.step("グループの無い単位の nx.json を置いて build を動かす"):
        _write(workspace, _unit_files({"a": {}, "b": {}}, {"a": _group("a")}))
        runner = FakeRunner(workspace)
        rc, _, _ = _main(tmp_path, workspace, runner)

    with allure.step("終了コード 1 とエラーの出力と何も動かないことを確かめる"):
        assert rc == 1
        assert "の b と同じ名前のリリースのグループがありません" in capsys.readouterr().err
        assert runner.calls == []


@allure.title("リリース版の build は、サイトを作る段のコンテナに、サイトの環境変数だけを渡す")
def test_build_passes_site_env_to_container(tmp_path: Path, workspace: Path) -> None:
    """`interface-spec:docs` を実行する段の環境のテストです。`PECOT_SITE_SIDE` などを渡し、廃止した変数は渡さず、レポートに入るプラグインの変数はこの段にだけ渡すことを確認します。"""
    with allure.step("偽の runner で build を動かす"):
        runner = FakeRunner(workspace)
        rc, _, _ = _main(tmp_path, workspace, runner)

    with allure.step("コンテナに渡すサイトの環境変数を確かめる"):
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


@allure.title(
    "リリース版の build は、レポートに入るプラグインを、{param_id} の場合の値でコンテナに渡す"
)
@pytest.mark.parametrize(
    ("missing", "expected"),
    [([], "a,b"), (["b"], "a"), (["a", "b"], "")],
    ids=["all", "partial", "empty"],
)
def test_build_passes_plugins_in_the_report_to_container(
    tmp_path: Path, workspace: Path, missing: list[str], expected: str
) -> None:
    """レポートの材料の `missing` を変えて、`release_build.main` を実行する場合のテストです。`PECOT_SITE_REPORT_PLUGINS` に、`missing` を除いたプラグインがカンマ区切りで入ることを確認します。"""
    with allure.step("レポートの記録を付けて build を動かす"):
        runner = FakeRunner(workspace)
        rc, _, _ = _main(tmp_path, workspace, runner, _report_record(missing))

    with allure.step("コンテナに渡すレポートのプラグインを確かめる"):
        assert rc == 0
        docs = runner.calls.index(("exec", "pnpm exec nx run interface-spec:docs --skip-nx-cache"))
        env = runner.envs[docs]
        assert env["PECOT_SITE_REPORT_PLUGINS"] == expected
        assert "PECOT_SITE_REPORT_PLUGINS" in env["DEVCONTAINER_ENV"].split()


@allure.title(
    "リリース版の build は、レポートの材料の形が不正だと、{param_id} の場合に終了コード 1 で終わる"
)
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
    """`report-sources.json` の形が不正な場合のテストです。終了コード 1 で終わり、`report-sources.json` を含むエラーを出力して、外部のコマンドを 1 つも実行しないことを確認します。"""
    with allure.step("読めないレポートの記録で build を動かす"):
        runner = FakeRunner(workspace)
        rc, _, _ = _main(tmp_path, workspace, runner, record)

    with allure.step("終了コード 1 と記録のファイル名のエラーと何も動かないことを確かめる"):
        assert rc == 1
        assert "report-sources.json" in capsys.readouterr().err
        assert runner.calls == []


@allure.title(
    "リリース版の build は、{fail} のコマンドが失敗すると、そこで止まって終了コード 1 で終わる"
)
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
    """checkout、`pnpm install`、`interface-spec:docs` のいずれかが、終了コード 2 で失敗する場合のテストです。そのコマンドが最後の呼び出しになり、終了コード 1 で終わって、失敗の旨を標準エラーに出力することを確認します。"""
    with allure.step("手順の 1 つが失敗する runner で build を動かす"):
        runner = FakeRunner(workspace, fail={fail: 2})
        rc, _, _ = _main(tmp_path, workspace, runner)

    with allure.step("終了コード 1 と失敗した手順で止まることを確かめる"):
        assert rc == 1
        assert runner.calls[-1] == last
        assert "が 2 で終わりました" in capsys.readouterr().err


@allure.title(
    "リリース版の build は、GITHUB_WORKSPACE と RUNNER_TEMP が存在しないと、終了コード 1 で終わる"
)
def test_build_requires_runner_env(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """環境変数を空にして `release_build.main` を実行する場合のテストです。終了コード 1 で終わり、2 つの環境変数が必要である旨を標準エラーに出力することを確認します。"""
    with allure.step("runner の環境変数を渡さずに build を動かす"):
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
    with allure.step("終了コード 1 とエラーの出力を確かめる"):
        assert rc == 1
        assert "GITHUB_WORKSPACE と RUNNER_TEMP" in capsys.readouterr().err
