"""リリース版の材料（ReleaseSources）を、プラグインごとの最新のタグから決める。

標準出力に tags・commits・skeleton・lanes の JSON を出す。
--record に release-sources.json、--lanes に junit-lanes.json と同じ形のレーンの一覧を書く。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from lanes import matrix

JUNIT_LANES = "libs/interface-spec/docs/junit-lanes.json"
_SHA = re.compile(r"[0-9a-f]{40}")


class ReleaseSourcesError(ValueError):
    pass


@dataclass(frozen=True)
class ReleaseSources:
    tags: dict[str, str]
    commits: dict[str, str]
    skeleton: str
    lanes: list[dict[str, str]]

    def record(self) -> dict[str, object]:
        return {"tags": self.tags, "commits": self.commits, "skeleton": self.skeleton}

    def to_json(self) -> dict[str, object]:
        return {**self.record(), "lanes": self.lanes}


def _str_map(data: dict[str, object], key: str) -> dict[str, str]:
    value = data.get(key)
    if not isinstance(value, dict):
        raise ReleaseSourcesError(f"{key} がオブジェクトではありません")
    items = cast("dict[object, object]", value)
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in items.items()):
        raise ReleaseSourcesError(f"{key} の値が文字列ではありません")
    return cast("dict[str, str]", items)


def _lane_list(value: object, where: str) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise ReleaseSourcesError(f"{where}: レーンの配列ではありません")
    result: list[dict[str, str]] = []
    for i, item in enumerate(cast("list[object]", value), start=1):
        if not isinstance(item, dict):
            raise ReleaseSourcesError(f"{where} #{i}: レーンがオブジェクトではありません")
        entry = cast("dict[str, object]", item)
        fields = {key: entry.get(key) for key in ("plugin", "target", "junit")}
        if not all(isinstance(v, str) for v in fields.values()):
            raise ReleaseSourcesError(f"{where} #{i}: plugin・target・junit の文字列が要ります")
        result.append(cast("dict[str, str]", fields))
    return result


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
        lanes=_lane_list(obj.get("lanes"), "lanes"),
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


def resolve(
    tag_names: Iterable[str],
    plugins: Iterable[str],
    *,
    commit_of: Callable[[str], str],
    is_ancestor: Callable[[str, str], bool],
    read_lanes: Callable[[str], object | None],
    main: str,
) -> ReleaseSources:
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

    lanes: list[dict[str, str]] = []
    for plugin, tag in tags.items():
        data = read_lanes(commits[plugin])
        if data is None:
            raise ReleaseSourcesError(
                f"{tag} のコミットに {JUNIT_LANES} がありません。"
                "合否のレーンの一覧を持つタグが出るまで、リリース版は作れません"
            )
        own = [
            lane for lane in _lane_list(data, f"{tag}:{JUNIT_LANES}") if lane["plugin"] == plugin
        ]
        lanes.extend(own)
    try:
        matrix(lanes)
    except ValueError as error:
        raise ReleaseSourcesError(str(error)) from error
    return ReleaseSources(tags=tags, commits=commits, skeleton=skeleton, lanes=lanes)


def _git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=False)


def _git_out(root: Path, *args: str) -> str:
    result = _git(root, *args)
    if result.returncode != 0:
        raise ReleaseSourcesError(f"git {' '.join(args)} が失敗しました: {result.stderr.strip()}")
    return result.stdout


def resolve_git(root: Path, main: str) -> ReleaseSources:
    plugins = [p.parent.parent.name for p in root.glob("plugins/*/.claude-plugin/plugin.json")]
    if not plugins:
        raise ReleaseSourcesError(f"{root}/plugins/*/.claude-plugin/plugin.json がありません")

    def is_ancestor(a: str, b: str) -> bool:
        result = _git(root, "merge-base", "--is-ancestor", a, b)
        if result.returncode not in (0, 1):
            raise ReleaseSourcesError(
                f"git merge-base --is-ancestor {a} {b} が失敗しました: {result.stderr.strip()}"
            )
        return result.returncode == 0

    def read_lanes(commit: str) -> object | None:
        result = _git(root, "show", f"{commit}:{JUNIT_LANES}")
        if result.returncode != 0:
            return None
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise ReleaseSourcesError(
                f"{commit[:7]}:{JUNIT_LANES} を JSON として読めません: {error}"
            ) from error

    return resolve(
        _git_out(root, "tag", "-l").split(),
        plugins,
        commit_of=lambda tag: _git_out(root, "rev-parse", f"{tag}^{{commit}}").strip(),
        is_ancestor=is_ancestor,
        read_lanes=read_lanes,
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
    parser.add_argument("--lanes", type=Path)
    args = parser.parse_args(argv[1:])
    try:
        sources = resolve_git(args.root, args.main)
    except ReleaseSourcesError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if args.record is not None:
        _write_json(args.record, sources.record())
    if args.lanes is not None:
        _write_json(args.lanes, sources.lanes)
    print(json.dumps(sources.to_json(), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
