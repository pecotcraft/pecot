"""公開サイトの側を確かめ、保管ブランチ pages-store に置いて push する（spec 028 の SideCheck・StoreLayout）。

側に置くものは、定義書（kind site）と、開発版・リリース版の test-report/ のテストレポート（kind report。spec 030）。

サブコマンド:
- check [--kind] [--side] <tar>: tar を展開せずに確かめる。問題があれば markdown の箇条で出して 1 で終わる
- extract [--kind] [--side] <tar> <dest>: 確かめてから展開する
- publish ...: pages-store を取り、側を差し替えて orphan のコミット 1 つで push する
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import posixpath
import shutil
import subprocess
import sys
import tarfile
import tempfile
from collections.abc import Callable, Iterable
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import NamedTuple, cast
from urllib.parse import unquote, urlsplit

SITE_BASE = "/pecot/"
META = ".pecot-store.json"
SIDES = ("release", "dev", "pr", "none")
KINDS = ("site", "report")
REPORT_SIDES = ("release", "dev")
REPORT_DIR = "test-report"
HISTORY = "history.jsonl"
SIZE_LIMIT = 900 * 1024**2
MAX_ATTEMPTS = 5
BOT_NAME = "github-actions[bot]"
BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"
_KEEP_AT_ROOT = {"dev", "pr", REPORT_DIR, META, ".git"}
_LABELS = {"release": "リリース版", "dev": "開発版", "none": "なし"}
_KIND_LABELS = {"site": "定義書", "report": "レポート"}
_HTML_SUFFIXES = (".html", ".htm")


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name in ("href", "src") and value is not None:
                self.links.append(value.strip())


def _links(html: str) -> list[str]:
    parser = _LinkParser()
    parser.feed(html)
    parser.close()
    return parser.links


def _member_name(name: str) -> str:
    while name.startswith("./"):
        name = name[2:]
    return name.rstrip("/")


def _member_problem(member: tarfile.TarInfo, name: str) -> str | None:
    if member.name.startswith("/") or posixpath.isabs(name):
        return f"`{member.name}`: 絶対パスです"
    if ".." in name.split("/"):
        return f"`{member.name}`: `..` を含みます"
    if member.issym():
        return f"`{member.name}`: シンボリックリンクです"
    if member.islnk():
        return f"`{member.name}`: ハードリンクです"
    if not (member.isfile() or member.isdir()):
        return f"`{member.name}`: 通常のファイルとディレクトリのどちらでもありません"
    return None


def _local_target(page: str, link: str) -> str | None:
    """側の中のリンクの先を、側のルートからのパスにする。側の中で見ないリンクは None。"""
    if not link or link.startswith("#"):
        return None
    parts = urlsplit(link)
    if parts.scheme or parts.netloc or link.startswith("//"):
        return None
    path = unquote(parts.path)
    if not path:
        return None
    if path.startswith("/"):
        return path
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(page), path))
    if path.endswith("/"):
        joined += "/"
    return joined


def _in_report(path: str) -> bool:
    return path == REPORT_DIR or path.startswith(f"{REPORT_DIR}/")


def side_check(tar_path: Path, *, report_links: bool = False) -> list[str]:
    """側の tar を展開せずに確かめ、問題を 1 行ずつ返す。空なら合格。

    report_links は、保管が `test-report/` を置く側（開発版・リリース版）で True にする。
    """
    problems: list[str] = []
    files: set[str] = set()
    dirs: set[str] = {""}
    pages: dict[str, str] = {}
    report_member: str | None = None
    with tarfile.open(tar_path) as tar:
        for member in tar:
            name = _member_name(member.name)
            problem = _member_problem(member, name)
            if problem:
                problems.append(problem)
                continue
            if name in ("", "."):
                continue
            if report_links and report_member is None and _in_report(name):
                report_member = member.name
                problems.append(f"`{member.name}`: `{REPORT_DIR}/` は保管でレポートを置く所です")
            if member.isdir():
                dirs.add(name)
                continue
            files.add(name)
            if name.endswith(_HTML_SUFFIXES):
                stream = tar.extractfile(member)
                if stream is not None:
                    pages[name] = stream.read().decode("utf-8", errors="replace")
    for path in [*dirs, *files]:
        parent = str(posixpath.dirname(path))
        while parent:
            dirs.add(parent)
            parent = str(posixpath.dirname(parent))
    seen: set[tuple[str, str]] = set()
    for page in sorted(pages):
        for link in _links(pages[page]):
            target = _local_target(page, link)
            if target is None or (page, link) in seen:
                continue
            seen.add((page, link))
            if target.startswith(SITE_BASE):
                continue
            if target.startswith("/"):
                problems.append(f"`{page}`: `{link}` はサイトの外の絶対パスです")
                continue
            if target == ".." or target.startswith("../"):
                problems.append(f"`{page}`: `{link}` は側の外を指します")
                continue
            path = target.rstrip("/")
            if report_links and _in_report(path):
                continue
            if path in ("", ".") or target.endswith("/") or path in dirs:
                path = posixpath.join("" if path == "." else path, "index.html")
            if path not in files:
                problems.append(f"`{page}`: `{link}` の先がありません")
    return problems


def _load_read_history() -> Callable[[bytes], list[int]]:
    # test_report のディレクトリは sys.path に無いので、release_sources.py と同じくパスで読む
    path = Path(__file__).resolve().parents[1] / "test_report/generate.py"
    spec = importlib.util.spec_from_file_location("test_report_generate", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"{path} を読めません")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return cast("Callable[[bytes], list[int]]", module.read_history)


read_history = _load_read_history()


def report_check(tar_path: Path) -> list[str]:
    """レポートの tar を確かめる。SideCheck に加え、index.html と、Allure が全行を読める history.jsonl があること。"""
    problems = side_check(tar_path)
    found: set[str] = set()
    history: bytes | None = None
    with tarfile.open(tar_path) as tar:
        for member in tar:
            name = _member_name(member.name)
            if not member.isfile() or name not in ("index.html", HISTORY):
                continue
            found.add(name)
            if name == HISTORY:
                stream = tar.extractfile(member)
                history = stream.read() if stream is not None else b""
    for name in ("index.html", HISTORY):
        if name not in found:
            problems.append(f"`{name}` がありません")
    if history is not None:
        bad = read_history(history)
        if bad == [0]:
            problems.append(f"`{HISTORY}` が UTF-8 ではありません")
        elif bad:
            problems.append(f"`{HISTORY}` の {', '.join(map(str, bad))} 行目を Allure が読めません")
    return problems


def checker(kind: str, side: str | None) -> Callable[[Path], list[str]]:
    """種類と側に合う確かめ。定義書の開発版・リリース版だけが、保管で置くレポートへのリンクを持てる。"""
    if kind not in KINDS:
        raise ValueError(f"kind が不正です: {kind}")
    if kind == "report":
        return report_check
    report_links = side in REPORT_SIDES
    return lambda tar_path: side_check(tar_path, report_links=report_links)


def extract(tar_path: Path, dest: Path, *, check: Callable[[Path], list[str]]) -> None:
    problems = check(tar_path)
    if problems:
        raise ValueError("側の確かめに通らない tar です: " + "; ".join(problems))
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar_path) as tar:
        tar.extractall(dest, filter="data")


def _empty_meta() -> dict[str, object]:
    return {"release": None, "dev": None, "pr": {}, "reports": {}}


def read_meta(store: Path) -> dict[str, object]:
    path = store / META
    if not path.is_file():
        return _empty_meta()
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError(f"{META}: オブジェクトではありません")
    meta = _empty_meta()
    meta.update(cast("dict[str, object]", loaded))
    for key in ("pr", "reports"):
        if not isinstance(meta[key], dict):
            meta[key] = {}
    return meta


def _pr_records(meta: dict[str, object]) -> dict[str, object]:
    return cast("dict[str, object]", meta["pr"])


def _report_records(meta: dict[str, object]) -> dict[str, object]:
    return cast("dict[str, object]", meta["reports"])


def _report_dir(store: Path, side: str) -> Path:
    return (store if side == "release" else store / "dev") / REPORT_DIR


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def _clear_root(store: Path) -> None:
    for entry in store.iterdir():
        if entry.name not in _KEEP_AT_ROOT:
            _remove(entry)


def _clear_dir(target: Path, keep: Iterable[str] = ()) -> None:
    """target を、keep の名前の子だけを残した空のディレクトリにする。"""
    if target.is_dir() and not target.is_symlink():
        kept = set(keep)
        for entry in target.iterdir():
            if entry.name not in kept:
                _remove(entry)
    else:
        _remove(target)
        target.mkdir(parents=True)


def _replace_dir(target: Path, tree: Path, keep: Iterable[str] = ()) -> None:
    _clear_dir(target, keep)
    shutil.copytree(tree, target, symlinks=True, dirs_exist_ok=True)


def closed_prs(store: Path, open_prs: Iterable[int]) -> list[int]:
    """store に残っている PR の側のうち、開いている一覧に無いものの番号。"""
    keep = {str(n) for n in open_prs}
    names: set[str] = set()
    pr_dir = store / "pr"
    if pr_dir.is_dir():
        names.update(entry.name for entry in pr_dir.iterdir())
    names.update(_pr_records(read_meta(store)))
    return sorted(int(n) for n in names - keep if n.isdigit())


def guide_page(side: str, meta: dict[str, object]) -> str:
    return _guide(f"{_LABELS[side]}はまだありません", meta)


def report_guide_page(meta: dict[str, object]) -> str:
    """レポートがまだ無い側の test-report/index.html。リンクは公開している定義書の側だけ。"""
    return _guide("テストレポートはまだありません", meta)


def _guide(title: str, meta: dict[str, object]) -> str:
    links: list[str] = []
    if meta.get("release") is not None:
        links.append(f'<li><a href="{SITE_BASE}">リリース版</a></li>')
    if meta.get("dev") is not None:
        links.append(f'<li><a href="{SITE_BASE}dev/">開発版</a></li>')
    if links:
        body = "<p>公開している版:</p>\n<ul>\n" + "\n".join(links) + "\n</ul>"
    else:
        body = "<p>公開している版はまだありません。</p>"
    return (
        "<!doctype html>\n"
        '<html lang="ja">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{title}</title>\n"
        "</head>\n"
        "<body>\n"
        f"<h1>{title}</h1>\n"
        f"{body}\n"
        "</body>\n"
        "</html>\n"
    )


def apply(
    store: Path,
    *,
    side: str,
    pr: int | None,
    tree: Path | None,
    record: dict[str, object] | None,
    open_prs: list[int] | None,
    kind: str = "site",
) -> None:
    """受けた側（定義書かレポート）と .pecot-store.json だけを書き換え、閉じた PR の側を消し、無い側に案内のページを置く。"""
    if side not in SIDES:
        raise ValueError(f"side が不正です: {side}")
    if kind not in KINDS:
        raise ValueError(f"kind が不正です: {kind}")
    if kind == "report" and side not in REPORT_SIDES:
        raise ValueError(f"kind が report のときは side が dev か release です: {side}")
    if side == "pr" and pr is None:
        raise ValueError("side が pr のときは pr の番号が要ります")
    if tree is not None and (record is None or side == "none"):
        raise ValueError("側を置くときは side と record が要ります")
    meta = read_meta(store)
    if tree is not None and record is not None and kind == "report":
        _replace_dir(_report_dir(store, side), tree)
        _report_records(meta)[side] = record
    elif tree is not None and record is not None:
        if side == "release":
            _clear_root(store)
            shutil.copytree(tree, store, symlinks=True, dirs_exist_ok=True)
            meta["release"] = record
        elif side == "dev":
            _replace_dir(store / "dev", tree, keep=[REPORT_DIR])
            meta["dev"] = record
        else:
            (store / "pr").mkdir(exist_ok=True)
            _replace_dir(store / "pr" / str(pr), tree)
            _pr_records(meta)[str(pr)] = record
    if open_prs is not None:
        for n in closed_prs(store, open_prs):
            _remove(store / "pr" / str(n))
            _pr_records(meta).pop(str(n), None)
        if (store / "pr").is_dir() and not any((store / "pr").iterdir()):
            (store / "pr").rmdir()
    if meta["release"] is None:
        _clear_root(store)
        (store / "index.html").write_text(guide_page("release", meta), encoding="utf-8")
    if meta["dev"] is None:
        _clear_dir(store / "dev", keep=[REPORT_DIR])
        (store / "dev" / "index.html").write_text(guide_page("dev", meta), encoding="utf-8")
    for report_side in REPORT_SIDES:
        if _report_records(meta).get(report_side) is None:
            target = _report_dir(store, report_side)
            _clear_dir(target)
            (target / "index.html").write_text(report_guide_page(meta), encoding="utf-8")
    (store / META).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _html_files(store: Path) -> list[Path]:
    found: list[Path] = []
    for root, dirnames, filenames in os.walk(store):
        if Path(root) == store and ".git" in dirnames:
            dirnames.remove(".git")
        found.extend(Path(root) / f for f in filenames if f.endswith(_HTML_SUFFIXES))
    return sorted(found)


def check_cross_links(store: Path) -> list[str]:
    """store 全体の HTML の /pecot/... のリンクが、store の中の実在のファイルを指すかを確かめる。"""
    broken: dict[str, list[str]] = {}
    for page in _html_files(store):
        rel = page.relative_to(store).as_posix()
        for link in _links(page.read_text(encoding="utf-8", errors="replace")):
            parts = urlsplit(link)
            if parts.scheme or parts.netloc or not parts.path.startswith(SITE_BASE):
                continue
            path = unquote(parts.path)[len(SITE_BASE) :]
            normalized = posixpath.normpath(path) if path else ""
            if normalized == ".." or normalized.startswith("../"):
                ok = False
            else:
                target = store / normalized if normalized not in ("", ".") else store
                if not path or path.endswith("/") or target.is_dir():
                    target = target / "index.html"
                ok = target.is_file() and ".git" not in target.relative_to(store).parts
            if not ok:
                pages = broken.setdefault(link, [])
                if rel not in pages:
                    pages.append(rel)
    return [
        f"`{link}` の先がありません（{len(pages)} ページ。例: `{pages[0]}`）"
        for link, pages in sorted(broken.items())
    ]


def store_size(store: Path) -> int:
    total = 0
    for root, dirnames, filenames in os.walk(store):
        if Path(root) == store and ".git" in dirnames:
            dirnames.remove(".git")
        total += sum((Path(root) / f).lstat().st_size for f in filenames)
    return total


def _mb(size: int) -> str:
    return f"{size / 1024**2:.1f} MB"


def size_warning(store: Path, limit: int = SIZE_LIMIT) -> str | None:
    size = store_size(store)
    if size <= limit:
        return None
    return f"pages-store の大きさが {_mb(size)} で、{_mb(limit)} を超えました（GitHub Pages の上限は 1 GB）"


def dev_is_newer(
    store_record: dict[str, object],
    head_sha: str,
    is_ancestor: Callable[[str, str], bool],
    kind: str = "site",
) -> bool:
    """保管中の開発版（kind が report なら reports.dev）が head_sha の祖先（同じを含む）なら True。無ければ True。"""
    if kind == "report":
        reports = store_record.get("reports")
        dev = cast("dict[str, object]", reports).get("dev") if isinstance(reports, dict) else None
    else:
        dev = store_record.get("dev")
    if not isinstance(dev, dict):
        return True
    stored = cast("dict[str, object]", dev).get("sha")
    if not isinstance(stored, str) or not stored:
        return True
    return stored == head_sha or is_ancestor(stored, head_sha)


def _git_env() -> dict[str, str]:
    drop = ("GIT_AUTHOR_", "GIT_COMMITTER_", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE")
    return {k: v for k, v in os.environ.items() if not k.startswith(drop)}


def _git(
    cwd: Path, *args: str, check: bool = True, author: bool = False
) -> subprocess.CompletedProcess[str]:
    identity = ["-c", f"user.name={BOT_NAME}", "-c", f"user.email={BOT_EMAIL}"] if author else []
    return subprocess.run(
        ["git", *identity, *args],
        cwd=cwd,
        env=_git_env(),
        capture_output=True,
        text=True,
        check=check,
    )


def git_is_ancestor(history: Path) -> Callable[[str, str], bool]:
    def is_ancestor(older: str, newer: str) -> bool:
        result = _git(history, "merge-base", "--is-ancestor", older, newer, check=False)
        if result.returncode in (0, 1):
            return result.returncode == 0
        raise RuntimeError(f"git merge-base --is-ancestor {older} {newer}: {result.stderr.strip()}")

    return is_ancestor


def _fetch_store(remote_url: str, dest: Path) -> str:
    """pages-store を dest に取り、取ったときの SHA を返す。まだ無ければ空の文字列。"""
    _remove(dest)
    dest.mkdir(parents=True)
    _git(dest, "init", "-q")
    _git(dest, "remote", "add", "origin", remote_url)
    fetched = _git(
        dest,
        "fetch",
        "-q",
        "--depth=1",
        "origin",
        "+refs/heads/pages-store:refs/remotes/origin/pages-store",
        check=False,
    )
    if fetched.returncode != 0:
        listed = _git(
            dest, "ls-remote", "--exit-code", "--heads", "origin", "pages-store", check=False
        )
        if listed.returncode == 2:
            return ""
        raise RuntimeError(f"pages-store を取れません: {fetched.stderr.strip()}")
    lease = _git(dest, "rev-parse", "refs/remotes/origin/pages-store").stdout.strip()
    _git(dest, "checkout", "-q", "--detach", lease)
    return lease


def _remote_sha(store: Path) -> str:
    listed = _git(store, "ls-remote", "--heads", "origin", "refs/heads/pages-store")
    return listed.stdout.split()[0] if listed.stdout.strip() else ""


class PublishOptions:
    def __init__(
        self,
        *,
        remote_url: str,
        side: str,
        pr: int | None,
        tree: Path | None,
        tar: Path | None = None,
        sha: str,
        run_id: str,
        sources: Path | None,
        open_prs: list[int] | None,
        main_ref: str,
        history: Path,
        workdir: Path,
        kind: str = "site",
    ) -> None:
        self.kind = kind
        self.remote_url = remote_url
        self.side = side
        self.pr = pr
        self.tree = tree
        self.tar = tar
        self.sha = sha
        self.run_id = run_id
        self.sources = sources
        self.open_prs = open_prs
        self.main_ref = main_ref
        self.history = history
        self.workdir = workdir


def _record(opts: PublishOptions) -> dict[str, object]:
    record: dict[str, object] = {
        "sha": opts.sha,
        "run_id": opts.run_id,
        "stored_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if opts.side == "release" and opts.sources is not None:
        record["sources"] = json.loads(opts.sources.read_text(encoding="utf-8"))
    return record


def _side_label(side: str, pr: int | None) -> str:
    return f"PR #{pr}" if side == "pr" else _LABELS.get(side, side)


class PublishResult(NamedTuple):
    code: int
    summary: str
    changed: bool


def _head_lines(opts: PublishOptions) -> list[str]:
    return [
        "## 保管",
        "",
        f"- 側: {_side_label(opts.side, opts.pr)}",
        f"- 種類: {_KIND_LABELS.get(opts.kind, opts.kind)}",
    ]


def _failed(opts: PublishOptions, *details: str) -> PublishResult:
    lines = [*_head_lines(opts), *details]
    return PublishResult(1, "\n".join(lines) + "\n", False)


def publish(opts: PublishOptions, before_push: Callable[[], None] | None = None) -> PublishResult:
    """pages-store を差し替え、変わったときだけ push する。"""
    if opts.side not in SIDES:
        raise ValueError(f"side が不正です: {opts.side}")
    if opts.kind not in KINDS:
        raise ValueError(f"kind が不正です: {opts.kind}")
    if opts.kind == "report":
        if opts.side not in REPORT_SIDES:
            raise ValueError(f"--kind report は --side dev か release だけで使えます: {opts.side}")
        if opts.tar is None or opts.tree is not None:
            raise ValueError("--kind report は --tar だけで受けます")
    if opts.tree is not None and opts.tar is not None:
        raise ValueError("--tree と --tar は一緒に渡せません")
    if opts.side != "none" and opts.tree is None and opts.tar is None:
        raise ValueError(f"side が {opts.side} のときは --tree か --tar が要ります")
    if opts.side == "pr" and opts.pr is None:
        raise ValueError("side が pr のときは --pr が要ります")
    if opts.side == "release" and opts.sources is None:
        raise ValueError("side が release のときは --sources が要ります")
    is_ancestor = git_is_ancestor(opts.history)
    if opts.side == "dev" and not is_ancestor(opts.sha, opts.main_ref):
        return _failed(
            opts, f"- 採否: 保管しない（`{opts.sha}` が `{opts.main_ref}` の祖先ではありません）"
        )
    side_tree = opts.tree
    if opts.tar is not None and opts.side != "none":
        check = checker(opts.kind, opts.side)
        problems = check(opts.tar)
        if problems:
            return _failed(
                opts,
                "- 採否: 保管しない（側の確かめに通りません）",
                *(f"  - {p}" for p in problems),
            )
        side_tree = opts.workdir / "side"
        extract(opts.tar, side_tree, check=check)

    store = opts.workdir / "pages-store"
    record = _record(opts)
    newer = "新しい開発版のレポート" if opts.kind == "report" else "新しい開発版"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        lease = _fetch_store(opts.remote_url, store)
        side, tree, kind = opts.side, side_tree, opts.kind
        verdict = "掃除だけ（側は受けていません）" if side == "none" else "保管した"
        if side == "dev" and not dev_is_newer(read_meta(store), opts.sha, is_ancestor, kind):
            side, tree, kind = "none", None, "site"
            verdict = f"保管しない（{newer}が先に保管されています）"
        removed = closed_prs(store, opts.open_prs) if opts.open_prs is not None else []
        apply(
            store,
            side=side,
            pr=opts.pr,
            tree=tree,
            record=record if tree is not None else None,
            open_prs=opts.open_prs,
            kind=kind,
        )
        lines = [
            *_head_lines(opts),
            f"- コミット: `{opts.sha}`" if opts.sha else "- コミット: なし",
            f"- 採否: {verdict}",
            "- 消した PR の側: " + (", ".join(f"#{n}" for n in removed) or "なし"),
            f"- pages-store の大きさ: {_mb(store_size(store))}",
        ]
        problems = check_cross_links(store)
        if problems:
            lines.append("- 側の間のリンクが切れているので push しません")
            lines.extend(f"  - {p}" for p in problems)
            return PublishResult(1, "\n".join(lines) + "\n", False)
        warning = size_warning(store)

        _git(store, "add", "-A", "-f")
        tree_sha = _git(store, "write-tree").stdout.strip()
        changed = not (
            lease and tree_sha == _git(store, "rev-parse", f"{lease}^{{tree}}").stdout.strip()
        )
        if not changed:
            lines.append("- pages-store: 書き換えが無いので push しません")
        else:
            label = _side_label(opts.side, opts.pr)
            if opts.kind == "report":
                label += "のレポート"
            message = f"pages-store: {label} {opts.sha}".rstrip()
            commit = _git(store, "commit-tree", tree_sha, "-m", message, author=True).stdout.strip()
            if before_push is not None:
                before_push()
            pushed = _git(
                store,
                "push",
                "-q",
                f"--force-with-lease=refs/heads/pages-store:{lease}",
                "origin",
                f"{commit}:refs/heads/pages-store",
                check=False,
            )
            if pushed.returncode != 0:
                if _remote_sha(store) != lease and attempt < MAX_ATTEMPTS:
                    print(
                        f"pages-store が先に進んだので取り直します（{attempt} 回目）",
                        file=sys.stderr,
                    )
                    continue
                raise RuntimeError(f"pages-store に push できません: {pushed.stderr.strip()}")
            lines.append(f"- pages-store のコミット: `{commit}`（{attempt} 回目の push）")
        if warning:
            lines.extend(["", "> [!WARNING]", f"> {warning}"])
        return PublishResult(0, "\n".join(lines) + "\n", changed)
    raise RuntimeError("pages-store への push を繰り返し断られました")


def _open_prs(raw: str) -> list[int]:
    loaded = json.loads(raw)
    if not isinstance(loaded, list):
        raise ValueError("--open-prs は JSON の配列です")
    numbers: list[int] = []
    for item in cast("list[object]", loaded):
        if isinstance(item, bool) or not isinstance(item, (int, str)):
            raise ValueError(f"--open-prs の要素が番号ではありません: {json.dumps(item)}")
        numbers.append(int(item))
    return numbers


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.add_argument("tar", type=Path)
    ext = sub.add_parser("extract")
    ext.add_argument("tar", type=Path)
    ext.add_argument("dest", type=Path)
    # --side を渡さない check・extract は、レポートへのリンクを切れたものとする（PR 版と同じ）。
    for command in (check, ext):
        command.add_argument("--kind", choices=KINDS, default="site")
        command.add_argument("--side", choices=SIDES[:3])
    pub = sub.add_parser("publish")
    pub.add_argument("--remote-url", required=True)
    pub.add_argument("--side", choices=SIDES, required=True)
    pub.add_argument("--kind", choices=KINDS, default="site")
    pub.add_argument("--pr", type=int)
    pub.add_argument("--tree", type=Path)
    pub.add_argument("--tar", type=Path)
    pub.add_argument("--sha", default="")
    pub.add_argument("--run-id", default="")
    pub.add_argument("--sources", type=Path)
    pub.add_argument("--open-prs", required=True)
    pub.add_argument("--main-ref", default="origin/main")
    pub.add_argument("--history", type=Path, default=Path.cwd())
    pub.add_argument("--workdir", type=Path)
    args = parser.parse_args(argv[1:])

    if args.command == "check":
        problems = checker(args.kind, args.side)(args.tar)
        if problems:
            print("\n".join(f"- {p}" for p in problems))
            return 1
        return 0
    if args.command == "extract":
        extract(args.tar, args.dest, check=checker(args.kind, args.side))
        return 0

    if args.workdir is not None:
        Path(args.workdir).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.workdir) as tmp:
        result = publish(
            PublishOptions(
                kind=args.kind,
                remote_url=args.remote_url,
                side=args.side,
                pr=args.pr,
                tree=args.tree,
                tar=args.tar,
                sha=args.sha,
                run_id=args.run_id,
                sources=args.sources,
                open_prs=_open_prs(args.open_prs),
                main_ref=args.main_ref,
                history=args.history,
                workdir=Path(tmp),
            )
        )
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as f:
            f.write(f"changed={'true' if result.changed else 'false'}\n")
    print(result.summary, end="")
    return result.code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
