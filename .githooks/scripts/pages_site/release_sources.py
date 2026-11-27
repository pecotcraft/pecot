"""リリース版の材料（ReleaseSources）を、プラグインごとの最新のタグから決める。

標準出力に tags・commits・skeleton の JSON を出す。--record に release-sources.json を書く。
--report release のときは、リリース版のテストレポートの材料（ReportSources）と matrix を出す。
開発版の材料は .githooks/scripts/test_report/dev_sources.py が決める。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import subprocess
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

REPORT_LANES = ".githooks/scripts/test_report/report-lanes.json"
_SHA = re.compile(r"[0-9a-f]{40}")


def _load_report_matrix() -> Callable[[object], list[dict[str, str]]]:
    # test_report のディレクトリは sys.path に無いので、generate.py と同じくパスで読む
    path = Path(__file__).resolve().parents[1] / "test_report/lanes.py"
    spec = importlib.util.spec_from_file_location("test_report_lanes", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"{path} を読めません")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return cast("Callable[[object], list[dict[str, str]]]", module.matrix)


report_matrix = _load_report_matrix()


class ReleaseSourcesError(ValueError):
    pass


@dataclass(frozen=True)
class ReleaseSources:
    tags: dict[str, str]
    commits: dict[str, str]
    skeleton: str

    def record(self) -> dict[str, object]:
        return {"tags": self.tags, "commits": self.commits, "skeleton": self.skeleton}

    def to_json(self) -> dict[str, object]:
        return self.record()


@dataclass(frozen=True)
class ReportSources:
    side: str
    runs: list[dict[str, object]]
    missing: list[str]
    jobs: list[dict[str, str]]

    def record(self) -> dict[str, object]:
        """report-sources.json の形。"""
        return {"side": self.side, "runs": self.runs, "missing": self.missing}

    def to_json(self) -> dict[str, object]:
        return {"sources": self.record(), "matrix": self.jobs}


def _str_map(data: dict[str, object], key: str) -> dict[str, str]:
    value = data.get(key)
    if not isinstance(value, dict):
        raise ReleaseSourcesError(f"{key} がオブジェクトではありません")
    items = cast("dict[object, object]", value)
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in items.items()):
        raise ReleaseSourcesError(f"{key} の値が文字列ではありません")
    return cast("dict[str, str]", items)


def from_json(data: object) -> ReleaseSources:
    """release_sources.py の標準出力の JSON を読み戻す。"""
    if not isinstance(data, dict):
        raise ReleaseSourcesError("ReleaseSources がオブジェクトではありません")
    obj = cast("dict[str, object]", data)
    skeleton = obj.get("skeleton")
    if not isinstance(skeleton, str):
        raise ReleaseSourcesError("skeleton が文字列ではありません")
    sources = ReleaseSources(
        tags=_str_map(obj, "tags"),
        commits=_str_map(obj, "commits"),
        skeleton=skeleton,
    )
    if set(sources.tags) != set(sources.commits) or not sources.tags:
        raise ReleaseSourcesError("tags と commits のプラグインがそろいません")
    return sources


def _version_of(tag: str, plugin: str) -> tuple[int, int, int] | None:
    # fullmatch なので、プレリリースの接尾辞のあるタグと、名前が前方一致する別のプラグインのタグは外れる。
    match = re.fullmatch(re.escape(plugin) + r"-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", tag)
    if match is None:
        return None
    return (int(match[1]), int(match[2]), int(match[3]))


def latest_tags(tag_names: Iterable[str], plugins: Iterable[str]) -> dict[str, str]:
    names = list(tag_names)
    result: dict[str, str] = {}
    for plugin in sorted(set(plugins)):
        versions = [(v, tag) for tag in names if (v := _version_of(tag, plugin)) is not None]
        if not versions:
            raise ReleaseSourcesError(
                f"{plugin} のリリースのタグ（{plugin}-v<semver>）がありません"
            )
        result[plugin] = max(versions)[1]
    return result


def resolve_tags(
    tag_names: Iterable[str],
    plugins: Iterable[str],
    *,
    commit_of: Callable[[str], str],
    is_ancestor: Callable[[str, str], bool],
    main: str,
) -> tuple[dict[str, str], dict[str, str], str]:
    """プラグインごとのタグとそのコミット、骨組みのコミットを決める。"""
    tags = latest_tags(tag_names, plugins)
    commits: dict[str, str] = {}
    for plugin, tag in tags.items():
        commit = commit_of(tag)
        if not _SHA.fullmatch(commit):
            raise ReleaseSourcesError(f"{tag} のコミットが 40 桁の SHA ではありません: {commit}")
        if not is_ancestor(commit, main):
            raise ReleaseSourcesError(f"{tag}（{commit}）が {main} の祖先ではありません")
        commits[plugin] = commit

    unique = list(dict.fromkeys(commits.values()))
    skeleton = next(
        (c for c in unique if all(is_ancestor(other, c) for other in unique)),
        None,
    )
    if skeleton is None:
        listed = ", ".join(f"{tags[p]}（{c[:7]}）" for p, c in commits.items())
        raise ReleaseSourcesError(
            f"ほかのすべてのタグのコミットを祖先に持つタグがありません: {listed}"
        )
    return tags, commits, skeleton


def resolve(
    tag_names: Iterable[str],
    plugins: Iterable[str],
    *,
    commit_of: Callable[[str], str],
    is_ancestor: Callable[[str, str], bool],
    main: str,
) -> ReleaseSources:
    tags, commits, skeleton = resolve_tags(
        tag_names, plugins, commit_of=commit_of, is_ancestor=is_ancestor, main=main
    )
    return ReleaseSources(tags=tags, commits=commits, skeleton=skeleton)


def _owned_by(plugin: str | None) -> Callable[[dict[str, object]], bool]:
    """そのプラグインのレーンか。None はプラグインに属さないレーン（libs と .githooks）。"""
    return lambda entry: entry.get("plugin") == plugin


def _report_jobs(
    data: object, where: str, commit: str, keep: Callable[[dict[str, object]], bool]
) -> list[dict[str, str]]:
    """report-lanes.json のうち keep に当たるレーンの matrix に、取り出すコミットを足す。"""
    try:
        report_matrix(data)
        entries = [e for e in cast("list[dict[str, object]]", data) if keep(e)]
        return [{**job, "commit": commit} for job in report_matrix(entries)]
    except ValueError as error:
        raise ReleaseSourcesError(f"{where}: {error}") from error


def _report_sources(
    side: str, groups: list[list[dict[str, str]]], missing: list[str]
) -> ReportSources:
    runs: list[dict[str, object]] = [
        {"commit": jobs[0]["commit"], "lanes": [job["lane"] for job in jobs]} for jobs in groups
    ]
    jobs = sorted((job for group in groups for job in group), key=lambda job: job["lane"])
    seen: dict[str, str] = {}
    for job in jobs:
        if job["slug"] in seen:
            raise ReleaseSourcesError(
                f"slug {job['slug']} が {seen[job['slug']]} と {job['lane']} で重なります"
            )
        seen[job["slug"]] = job["lane"]
    return ReportSources(side=side, runs=runs, missing=missing, jobs=jobs)


def report_release(
    tag_names: Iterable[str],
    plugins: Iterable[str],
    *,
    commit_of: Callable[[str], str],
    is_ancestor: Callable[[str, str], bool],
    read_lanes: Callable[[str], object | None],
    main: str,
) -> ReportSources:
    """リリース版の ReportSources。read_lanes はコミットの report-lanes.json を読み、無ければ None。"""
    tags, commits, skeleton = resolve_tags(
        tag_names, plugins, commit_of=commit_of, is_ancestor=is_ancestor, main=main
    )
    groups: list[list[dict[str, str]]] = []
    missing: list[str] = []
    for plugin, tag in tags.items():
        data = read_lanes(commits[plugin])
        where = f"{tag}:{REPORT_LANES}"
        jobs = [] if data is None else _report_jobs(data, where, commits[plugin], _owned_by(plugin))
        if jobs:
            groups.append(jobs)
        else:
            missing.append(plugin)
    # 結果を出せるプラグインが無ければ、プラグインに属さないレーンだけのレポートは作らない。
    shared = read_lanes(skeleton) if groups else None
    if shared is not None:
        where = f"{skeleton[:7]}:{REPORT_LANES}"
        jobs = _report_jobs(shared, where, skeleton, _owned_by(None))
        if jobs:
            groups.append(jobs)
    return _report_sources("release", groups, missing)


def _git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=False)


def _git_out(root: Path, *args: str) -> str:
    result = _git(root, *args)
    if result.returncode != 0:
        raise ReleaseSourcesError(f"git {' '.join(args)} が失敗しました: {result.stderr.strip()}")
    return result.stdout


def _plugins(root: Path) -> list[str]:
    plugins = [p.parent.parent.name for p in root.glob("plugins/*/.claude-plugin/plugin.json")]
    if not plugins:
        raise ReleaseSourcesError(f"{root}/plugins/*/.claude-plugin/plugin.json がありません")
    return plugins


def _git_ancestor(root: Path) -> Callable[[str, str], bool]:
    def is_ancestor(a: str, b: str) -> bool:
        result = _git(root, "merge-base", "--is-ancestor", a, b)
        if result.returncode not in (0, 1):
            raise ReleaseSourcesError(
                f"git merge-base --is-ancestor {a} {b} が失敗しました: {result.stderr.strip()}"
            )
        return result.returncode == 0

    return is_ancestor


def _git_reader(root: Path, path: str) -> Callable[[str], object | None]:
    """コミットの path を JSON で読む。ファイルが無ければ None。"""

    def read(commit: str) -> object | None:
        # blob の無い clone では show が blob を取りに行くので、パスの有無は tree だけで引く。
        if _git(root, "rev-parse", "--verify", "--quiet", f"{commit}:{path}").returncode != 0:
            return None
        text = _git_out(root, "show", f"{commit}:{path}")
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise ReleaseSourcesError(
                f"{commit[:7]}:{path} を JSON として読めません: {error}"
            ) from error

    return read


def _git_commit_of(root: Path) -> Callable[[str], str]:
    return lambda tag: _git_out(root, "rev-parse", f"{tag}^{{commit}}").strip()


def resolve_git(root: Path, main: str) -> ReleaseSources:
    plugins = _plugins(root)
    return resolve(
        _git_out(root, "tag", "-l").split(),
        plugins,
        commit_of=_git_commit_of(root),
        is_ancestor=_git_ancestor(root),
        main=main,
    )


def resolve_report_git(root: Path, *, main: str) -> ReportSources:
    return report_release(
        _git_out(root, "tag", "-l").split(),
        _plugins(root),
        commit_of=_git_commit_of(root),
        is_ancestor=_git_ancestor(root),
        read_lanes=_git_reader(root, REPORT_LANES),
        main=main,
    )


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--main", default="origin/main")
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--record", type=Path)
    parser.add_argument(
        "--report", choices=["release"], help="リリース版のテストレポートの材料と matrix を出す"
    )
    args = parser.parse_args(argv[1:])
    if args.report is not None and args.record is not None:
        parser.error("--report は --record と一緒に使えません")
    try:
        if args.report is not None:
            report = resolve_report_git(args.root, main=args.main)
            print(json.dumps(report.to_json(), ensure_ascii=False, separators=(",", ":")))
            return 0
        sources = resolve_git(args.root, args.main)
    except ReleaseSourcesError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if args.record is not None:
        _write_json(args.record, sources.record())
    print(json.dumps(sources.to_json(), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
