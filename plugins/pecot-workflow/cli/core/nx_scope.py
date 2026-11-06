"""core/nx_scope.py - 変更した nx プロジェクトから PR タイトルの scope を算出する

scope は、各プロジェクトの nx の tag ``scope:<名前>`` の値を使う。tag が無ければプロジェクト名を使う。

割り当ては ``.githooks/pre-push/check-version-plan-required.sh`` と同じ規則。
（nx の project graph → git diff → project root との最長一致）。
判定できない場合は例外ではなく ``None`` を返し、呼び出し側が警告して割り当てを飛ばす
（フェイルオープン）。

このモジュールは CLI 内の他モジュールのうち ``cli.core.git`` と ``cli.core.paths`` だけを import する。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import NamedTuple, cast

from cli.core.git import run_git
from cli.core.paths import TMP_DIR

# nx graph の実行上限（秒）
NX_GRAPH_TIMEOUT_SEC = 120

# どの nx プロジェクトにも属さないファイルを表す scope
REPO_SCOPE = "repo"

# PR タイトルの scope を宣言する nx の tag の接頭辞
_SCOPE_TAG_PREFIX = "scope:"

# nx 固定のリリース用メタデータ。scope の算出から除外する
_VERSION_PLANS_PREFIX = ".nx/version-plans/"

# `type(scope): ...` / `type(scope)!: ...` の scope 部分
_TITLE_SCOPE_PATTERN = re.compile(r"^[A-Za-z]+\(([^()]*)\)!?:")


class NxProject(NamedTuple):
    """nx の project graph から読む、プロジェクト 1 つの情報"""

    root: str
    """リポジトリ直下からの root（``.`` はリポジトリ直下）"""
    scope: str
    """PR タイトルの scope。tag ``scope:<名前>`` の値、無ければプロジェクト名"""


def _scope_of(name: str, tags: object) -> str:
    """tag ``scope:<名前>`` の値を返す。無い・空なら、プロジェクト名を返す"""
    if isinstance(tags, list):
        for tag in cast("list[object]", tags):
            if isinstance(tag, str) and tag.startswith(_SCOPE_TAG_PREFIX):
                value = tag.removeprefix(_SCOPE_TAG_PREFIX)
                if value:
                    return value
    return name


def resolve_nx(toplevel: Path) -> Path | None:
    """nx 実行ファイルを返す（``<toplevel>/node_modules/.bin/nx`` → PATH 上の ``nx``）

    ``npx --no-install`` は未導入時に registry へ問い合わせ、symlink 経由では
    別 worktree の nx を拾うため使わない。
    """
    local = toplevel / "node_modules" / ".bin" / "nx"
    if local.is_file() and os.access(local, os.X_OK):
        return local
    found = shutil.which("nx")
    return Path(found) if found else None


def nx_projects(toplevel: Path) -> dict[str, NxProject] | None:
    """nx の project graph から ``{プロジェクト名: NxProject}`` を返す

    ``nx graph --file=<一時 json>`` に書かせて読む（stdout のパイプでは大きな JSON が途中で切れる）。
    一時ファイルは ``<toplevel>/.pecot/tmp`` に作成し、終了時に削除する。

    Returns:
        プロジェクト名から、root と scope への辞書。
        nx が無い・実行失敗・部分 graph・JSON の解析失敗なら None
    """
    nx = resolve_nx(toplevel)
    if nx is None:
        return None
    tmp_base = toplevel / TMP_DIR
    try:
        tmp_base.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="nx-scope.", dir=tmp_base))
    except OSError:
        return None
    try:
        graph_file = work / "graph.json"
        try:
            result = subprocess.run(
                [str(nx), "graph", f"--file={graph_file}"],
                cwd=toplevel,
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
                timeout=NX_GRAPH_TIMEOUT_SEC,
                env={**os.environ, "NX_DAEMON": "false"},
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0 or "Showing partial graph" in (result.stderr or ""):
            return None
        try:
            nodes = json.loads(graph_file.read_text(encoding="utf-8"))["graph"]["nodes"]
            projects = {
                str(name): NxProject(
                    root=str(node["data"]["root"]).rstrip("/") or ".",
                    scope=_scope_of(str(name), node["data"].get("tags")),
                )
                for name, node in nodes.items()
            }
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return None
        return projects or None
    finally:
        shutil.rmtree(work, ignore_errors=True)


def changed_files(toplevel: Path, base_ref: str, head: str) -> list[str] | None:
    """``base_ref...head`` の変更ファイル（リポジトリ root からの相対パス）を返す

    rename 検出だと移動元のプロジェクトが漏れ、``core.quotePath`` だと非 ASCII パスが
    一致しなくなるため、``--no-renames`` と NUL 区切りで取る。

    Returns:
        変更ファイルの一覧。base_ref / head が解決できない・git 失敗なら None
    """
    try:
        for ref in (base_ref, head):
            run_git(["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], toplevel, check=True)
        result = run_git(
            ["diff", "-z", "--name-only", "--no-renames", f"{base_ref}...{head}"],
            toplevel,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return [f for f in result.stdout.split("\0") if f]


def _under(path: str, root: str) -> bool:
    return root == "." or path == root or path.startswith(root + "/")


def expected_scope(files: list[str], projects: dict[str, NxProject]) -> list[str]:
    """変更ファイルから期待する scope の一覧を返す

    - ファイルの持ち主は project root との最長一致で決める（nx の ``findProjectForPath`` と同じ）
    - 持ち主のプロジェクトの ``NxProject.scope`` を使う。同じ scope の複数プロジェクトは 1 つにまとまる
    - どのプロジェクトにも属さないファイルがあれば末尾に ``repo`` を加える
    - ``.nx/version-plans/`` 配下は数えない

    Returns:
        scope の昇順 + 必要なら ``repo``。数えるファイルが無ければ空
    """
    ordered = sorted(projects.values(), key=lambda project: len(project.root), reverse=True)
    names: set[str] = set()
    outside = False
    for path in files:
        if path.startswith(_VERSION_PLANS_PREFIX):
            continue
        owner = next((project for project in ordered if _under(path, project.root)), None)
        if owner is None:
            outside = True
        else:
            names.add(owner.scope)
    scope = sorted(names - {REPO_SCOPE})
    if outside or REPO_SCOPE in names:
        scope.append(REPO_SCOPE)
    return scope


def parse_title_scope(title: str) -> list[str] | None:
    """PR タイトルの ``type(scope):`` から scope を ``,`` で分けて返す

    空白は削らない（規則は空白なしの ``,`` 区切り）。

    Returns:
        scope の一覧。scope が無い・空なら None
    """
    match = _TITLE_SCOPE_PATTERN.match(title)
    if match is None or not match.group(1):
        return None
    return match.group(1).split(",")
