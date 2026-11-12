"""hooks/conftest.py - hooks テスト共通フィクスチャとヘルパー

bats から pytest へ移行した hooks テスト（hooks/tests/ と hooks/lib/tests/）が
共有するフィクスチャを定義する。bats の test_helper/common_setup.bash 相当の
セットアップ（GIT_* 隔離・test git repo 生成・mock コマンド配置）を提供する。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

import pytest

# グローバル環境隔離（pre-push フック配下の GIT_* リーク対策）。
# pre-push/pre-commit 配下で pytest を動かすと、親 git が GIT_DIR 等を export している。
# テスト内の subprocess.run（素の git 呼び出し）がそれを継承して、実リポに書き込んでしまう。
# bats 側は _isolated_git ラッパー（env -u ...）で逐一剥がしていた。
# pytest 側は autouse で os.environ から一括除去する。
# これでテストは、素の git を呼ぶだけで隔離される（cli/tests/conftest.py:18-39 を踏襲）。

_GIT_ENV_LEAK_KEYS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
)


@pytest.fixture(autouse=True)
def _isolate_git_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in _GIT_ENV_LEAK_KEYS:
        monkeypatch.delenv(key, raising=False)


# プラグインのデータ置き場の隔離（#1230）。
# 開発者の Claude セッションの子として動くと、クライアントが渡した CLAUDE_PLUGIN_DATA を継承する。
# そのままだと、bin/pecot 経由のテストが導入先の置き場を読み書きする。
# 変数を外しただけでは、既定の場所（~/.local/share/pecot/pecot-workflow）に書く。
# そこで全テストで CLAUDE_PLUGIN_DATA を一時ディレクトリへ向け、PLUGIN_DATA は外す。
# XDG_DATA_HOME は付け替えない（uv の Python の置き場まで動くため）。
# 既定の場所を確かめるテストだけが、CLAUDE_PLUGIN_DATA を外して XDG_DATA_HOME / HOME を子プロセスに渡す。


@pytest.fixture(autouse=True)
def _isolate_plugin_data_env(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    for key in ("PLUGIN_DATA", "PECOT_BOOTSTRAP_SKIP", "PECOT_BOOTSTRAP_FORCE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("CLAUDE_PLUGIN_DATA", str(tmp_path_factory.mktemp("plugin-data")))


# 作業ディレクトリ隔離（project-root.sh の pwd 解決対策）。
# エントリポイントは lib/core/project-root.sh で git toplevel を求める。
# 求める順は、hook 入力の cwd → CLAUDE_PROJECT_DIR → プロセスの pwd で、結果は CLAUDE_PROJECT_DIR に export する。
# pytest の既定 cwd（plugins/pecot-workflow/）のまま subprocess を起動すると、問題が起きる。
# CLAUDE_PROJECT_DIR が未設定や非 git の tmp を指すテストで、実 worktree が基準になり、実 .pecot/state を読み書きする。
# cwd を tmp_path へ移し、cwd= を明示しない subprocess の pwd 解決を git 外に固定する。


@pytest.fixture(autouse=True)
def _isolate_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)


# パス解決（リポルート / core / adapters）
# このファイルは plugins/pecot-workflow/hooks/conftest.py に置かれる。
# parents[0]=hooks, [1]=pecot, [2]=plugins, [3]=リポルート。


@pytest.fixture(scope="session")
def project_root() -> Path:
    return Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session")
def core_dir(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "lib" / "core"


@pytest.fixture(scope="session")
def adapter_dir(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks" / "lib" / "adapters"


# CLAUDE_PROJECT_DIR / hooks-config 隔離。


@pytest.fixture
def claude_project_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """tmp 配下に project/.pecot を作り CLAUDE_PROJECT_DIR を指す。"""
    project = tmp_path / "project"
    (project / ".pecot").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    return project


class _HooksConfig:
    """PECOT_HOOKS_CONFIG_PATH が指すファイルへ dict を書く薄いヘルパ。"""

    def __init__(self, path: Path) -> None:
        self.path = path

    def write(self, config: dict) -> None:
        self.path.write_text(json.dumps(config))


@pytest.fixture
def hooks_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> _HooksConfig:
    """PECOT_HOOKS_CONFIG_PATH を tmp の hooks-config.json に向けるヘルパ。"""
    path = tmp_path / "hooks-config.json"
    monkeypatch.setenv("PECOT_HOOKS_CONFIG_PATH", str(path))
    return _HooksConfig(path)


# テスト用 git リポジトリ生成（bats create_test_git_repo 相当）。


@pytest.fixture
def git_repo(tmp_path: Path) -> Callable[..., Path]:
    """呼ぶたびに初期コミット済みの git リポを tmp 配下に作る factory。

    bats の create_test_git_repo（common_setup.bash:30-41）相当。
    init / user.email・user.name のローカル設定 / .gitkeep 初期コミットまで実施。
    _isolate_git_env autouse により素の git 呼び出しで隔離される。
    """
    counter = {"n": 0}

    def _make(name: str | None = None) -> Path:
        if name is None:
            counter["n"] += 1
            name = f"test-repo-{counter['n']}"
        repo_dir = tmp_path / name
        repo_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "--quiet"], cwd=repo_dir, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=repo_dir,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"],
            cwd=repo_dir,
            check=True,
        )
        subprocess.run(
            ["git", "config", "commit.gpgsign", "false"],
            cwd=repo_dir,
            check=True,
        )
        (repo_dir / ".gitkeep").touch()
        subprocess.run(["git", "add", ".gitkeep"], cwd=repo_dir, check=True)
        subprocess.run(
            ["git", "commit", "--quiet", "-m", "initial commit"],
            cwd=repo_dir,
            check=True,
        )
        return repo_dir

    return _make


# worktree の .pecot/work（base への相対 symlink）。


@pytest.fixture
def work_layout(tmp_path: Path, git_repo: Callable[..., Path]) -> dict[str, Path]:
    """本物の git worktree と、本番どおりの相対 symlink（wt/.pecot/work -> base の .pecot/work）。

    base の .pecot/work には 1244/sub を、.pecot には .pecot/work の名前に似た work2 を作る。
    wt には .pecot/work の link だけを作る。
    戻り値のキーは次のとおり。
      base: base の worktree。
      wt: 追加した worktree。
      work: base 側の .pecot/work の実体。
      wt_work: wt 側の .pecot/work（base への link 経由のパス）。
    """
    base = git_repo("base")
    wt = tmp_path / "wt"
    subprocess.run(["git", "worktree", "add", "-q", "-b", "feat/x", str(wt)], cwd=base, check=True)
    (base / ".pecot" / "work" / "1244" / "sub").mkdir(parents=True)
    (base / ".pecot" / "work2").mkdir()
    (wt / ".pecot").mkdir()
    (wt / ".pecot" / "work").symlink_to(os.path.relpath(base / ".pecot" / "work", wt / ".pecot"))
    return {
        "base": base,
        "wt": wt,
        "work": base / ".pecot" / "work",
        "wt_work": wt / ".pecot" / "work",
    }


# モックコマンド配置（PATH 先頭の mock-bin）。


class _MockBin:
    """PATH 先頭に挿入した mock-bin ディレクトリへ実行可能スクリプトを配置する。"""

    def __init__(self, bin_dir: Path) -> None:
        self.bin_dir = bin_dir

    def install(self, name: str, script_body: str) -> Path:
        target = self.bin_dir / name
        body = script_body if script_body.startswith("#!") else f"#!/bin/bash\n{script_body}"
        target.write_text(body)
        target.chmod(0o755)
        return target


@pytest.fixture
def mock_bin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> _MockBin:
    """tmp/mock-bin を PATH 先頭に挿入し install() でモックコマンドを置く。"""
    bin_dir = tmp_path / "mock-bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    return _MockBin(bin_dir)


# bin/pecot 実体モック配置（フルパス実行される ${CLAUDE_PLUGIN_ROOT}/bin/pecot 用）。
# hooks は pecot CLI を次のパスでフルパス実行する。
# `"${CLAUDE_PLUGIN_ROOT}/bin/pecot"`
# そのため、PATH 挿入型 mock_bin では差し替えられない。
# CLAUDE_PLUGIN_ROOT 配下に実体スクリプトを置く必要がある。
# 呼び出しの事実は marker への追記で判定し、exit code は PECOT_MOCK_EXIT で可変にする。
# CLI の exit code は、0=成功 / 3=テンプレ検証失敗 / 1=通信失敗・設定なし等。
# 最後の引数が既存ファイルなら、その内容を <marker>.body に写す。
# hooks は投稿後に一時ファイルを消すため、投稿内容は写しで検証する。
# PECOT_MOCK_STDERR を設定すると、URL の代わりにその文言を stderr に出す。
# hook が CLI の出力を案内文へ埋め込むことの検証に使う。
# 実体モックは、poster / fallback / post-exit で共通に使う。

_PECOT_BIN_MOCK_BODY = """#!/bin/bash
echo "$@" >> "$PECOT_MOCK_MARKER"
last_arg="${!#}"
if [ "$#" -gt 0 ] && [ -f "$last_arg" ]; then
    cp "$last_arg" "${PECOT_MOCK_MARKER}.body"
fi
if [ -n "${PECOT_MOCK_STDERR:-}" ]; then
    echo "$PECOT_MOCK_STDERR" >&2
else
    echo "https://example.test/issue/comment/1"
fi
exit "${PECOT_MOCK_EXIT:-0}"
"""


class _PecotBinMock:
    """CLAUDE_PLUGIN_ROOT 配下の bin/pecot へ実体モックを書き込むヘルパ。

    install(plugin_root) を明示的に呼んで配置する 1 パターン API。marker 属性は
    PECOT_MOCK_MARKER が指すパスと同一で、投稿呼び出しの有無判定に使う。body 属性は
    ファイル入力で投稿された内容の写し（<marker>.body）。
    """

    def __init__(self, marker: Path) -> None:
        self.marker = marker
        self.body = marker.with_name(marker.name + ".body")

    def install(self, plugin_root: Path) -> Path:
        bin_dir = plugin_root / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        target = bin_dir / "pecot"
        target.write_text(_PECOT_BIN_MOCK_BODY)
        target.chmod(0o755)
        return self.marker


@pytest.fixture
def pecot_bin_mock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> _PecotBinMock:
    """PECOT_MOCK_MARKER を tmp に向け、install(plugin_root) で bin/pecot を配置する。"""
    marker = tmp_path / "pecot-mock-marker"
    monkeypatch.setenv("PECOT_MOCK_MARKER", str(marker))
    return _PecotBinMock(marker)


# bash スクリプト実行ヘルパ。


@pytest.fixture
def run_script() -> Callable[..., subprocess.CompletedProcess]:
    """`bash <script> [args...]` を実行する薄いラッパを返す。

    位置引数 args はスクリプトへそのまま渡す（.githooks 側の run_script と同一
    シグネチャ）。既存の呼び出し（script のみ + キーワード引数）は無改修で動く。
    env 契約: env=None なら subprocess に env= を渡さない（_isolate_git_env
    と monkeypatch 済みの os.environ をそのまま継承する）。env が dict のときは
    {**os.environ, **env} でマージして渡す（GIT_* 再注入や PATH 喪失を防ぐ）。
    """

    def _run(
        script: str | Path,
        *args: str,
        stdin: str | None = None,
        cwd: str | Path | None = None,
        env: dict | None = None,
    ) -> subprocess.CompletedProcess:
        kwargs: dict = {}
        if env is not None:
            kwargs["env"] = {**os.environ, **env}
        return subprocess.run(
            ["bash", str(script), *args],
            input=stdin,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=25,
            **kwargs,
        )

    return _run


# アダプター経由のコアスクリプト実行ヘルパ（bats run_claude_adapter 相当）。
# adapter スクリプトは core_script を引数に取り、stdin JSON からコマンドを抽出する。
# 抽出したコマンドを HOOK_COMMAND に export した上で、コアを実行する。
# bats の common_setup.bash:47-61 では、JSON を echo して claude-adapter.sh にパイプしていた。
# copilot-adapter.sh は #1229 で削除した。
# env 契約は run_script と同一（env=None なら monkeypatch 済みの os.environ を継承）。


@pytest.fixture
def claude_adapter(
    adapter_dir: Path,
) -> Callable[..., subprocess.CompletedProcess]:
    """Claude Code アダプター経由でコアスクリプトを実行する。

    bats run_claude_adapter（common_setup.bash:47-52）相当。
    `{"tool_input":{"command":<command>}}` を JSON stdin として claude-adapter.sh に
    流し、引数に core_script を渡す。
    """

    def _run(
        command: str,
        core_script: str | Path,
        cwd: str | Path | None = None,
        env: dict | None = None,
    ) -> subprocess.CompletedProcess:
        payload = json.dumps({"tool_input": {"command": command}})
        kwargs: dict = {}
        if env is not None:
            kwargs["env"] = {**os.environ, **env}
        return subprocess.run(
            ["bash", str(adapter_dir / "claude-adapter.sh"), str(core_script)],
            input=payload,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=25,
            **kwargs,
        )

    return _run


# hooks スクリプトの lib 参照抽出（静的解析ヘルパ）。
# hooks 配下のスクリプトは lib をチェーン実行するが、途中の呼び出しの rc を見ない。
# rc を見ない呼び出しは、最終パイプラインの終端・末尾 `exit 0`・rc 未確認のいずれか。
# 削除済み lib スクリプトへの参照は、rc 127 のまま握り潰され、実行時に表面化しない。
# この構造は、hooks/ 直下のエントリポイントに限らず、lib 配下の被呼び出し側でも同じ。
# そのため抽出器は、hooks 全域（エントリポイント・2 次ディスパッチャ・lib 内部）を対象に使う（#864）。
# 参照を静的に抽出して実在を固定するためのヘルパは、hooks/tests と hooks/lib/tests の双方へ fixture で公開する。
# run-tests.sh が --import-mode=importlib を渡すため、テストから import できる共有モジュールは置けない。
# 親 conftest の fixture が、唯一の共有手段になる。
# CLAUDE_PLUGIN_ROOT は os.environ から読まず、引数の plugin_root へ解決する。
# pass2 は env -i で環境を組み直すため、環境変数は存在しない。
# lib が読む `templates/*.md` も同じ構造になる。
# 参照先の欠落は、`[ -f ]` のすり抜けか `cat` の rc 握り潰しで、気づかれないまま劣化する。
# テンプレ参照は、別 regex・同一解決規則で扱う（#869）。

_COMMENT_LINE_RE = re.compile(r"^\s*#")

# 自己ディレクトリ変数は、識別子名を決め打ちせず、代入イディオムから認識する。
# SCRIPT_DIR という命名に依存しない。
_SELF_DIR_ASSIGN_RE = re.compile(
    r"^\s*([A-Za-z_][A-Za-z0-9_]*)="
    r'"\$\(cd "\$\(dirname "(?:\$0|\$\{BASH_SOURCE\[0\]\})"\)" && pwd\)"\s*$'
)
# 既知ディレクトリ変数からの派生代入（LIB_DIR="$SCRIPT_DIR/lib/notification" 等）。
_DERIVED_DIR_ASSIGN_RE = re.compile(
    r'^\s*([A-Za-z_][A-Za-z0-9_]*)="\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/([^"$]+)"\s*$'
)
# ディレクトリ変数プレフィックス付きの .sh 参照（サブディレクトリを含む）。
# `${VAR%…}` のパラメータ展開修飾も、1 つのトークンとして捕捉する。
# 解決可否は _extract_refs 側で修飾ごとに判定し、未知の修飾は未解決として ValueError にする。
# ここで取りこぼすと、会計不一致という弱い網にしか掛からない。
# 末尾の否定先読みは、`foo.shellcheckrc` から `foo.sh` を切り出さないための語境界。
# 会計側の鈍い走査（test_entry_point_lib_refs.py）と同一の境界にしないと、問題が起きる。
# 一方だけが偽トークンを拾って、会計が恒常的に不一致になる。
_VAR_SH_REF_RE = re.compile(
    r"\$(?:"
    r"\{(?P<braced>[A-Za-z_][A-Za-z0-9_]*)(?P<modifier>%[^}]*)?\}"
    r"|(?P<bare>[A-Za-z_][A-Za-z0-9_]*)"
    r")/(?P<rel>[A-Za-z0-9._/-]+\.sh)(?![A-Za-z0-9_-])"
)
# ディレクトリ変数プレフィックス付きの `.md` テンプレ参照。
# 上の `.sh` 版と同形だが、rel が `templates/` セグメントを含むものだけを対象にする。
# `templates/x.md` に加え、`hooks/templates/x.md` のような深い rel も対象になる。
# `.md` 参照全数へ広げない理由は、次のとおり。
# `$HOME/.claude/plans/${SLUG}.md` のような参照は、`${SLUG}` が rel の文字クラスに乗らない。
# そのため、変数プレフィックス型 regex ではトークン化されない。
# 一方で会計側の鈍い走査だけが拾うため、対象を広げると会計が恒常的に不一致になる。
# 次のものも、同じく会計側のみの雑音になる。
# heredoc 内の定義（pecot-gitignore-ensure.sh）の `!/config/...` 行。
# `$HOME` を解決対象にしないのは、pass1 と pass2 の食い違いを避けるためでもある。
# pass2 は env -i で HOME を tmp の空ディレクトリへ差し替える。
# 解決先が変わり、junit に食い違いが出る。
# 末尾の否定先読みは、`x.mdx` から `x.md` を切り出さないための語境界。
# `.sh` 側と同じく、会計側の鈍い走査と揃える必要がある。
_VAR_MD_TEMPLATE_REF_RE = re.compile(
    r"\$(?:"
    r"\{(?P<braced>[A-Za-z_][A-Za-z0-9_]*)(?P<modifier>%[^}]*)?\}"
    r"|(?P<bare>[A-Za-z_][A-Za-z0-9_]*)"
    r")/(?P<rel>(?:[A-Za-z0-9._-]+/)*templates/[A-Za-z0-9._/-]+\.md)(?![A-Za-z0-9_-])"
)
# 解決できる唯一の `%` 修飾。`${SCRIPT_DIR%/*}/core/x.sh`（親ディレクトリ剥がし）は
# lib 配下の慣行イディオムで、`dir_vars[VAR].parent` 起点へ解決する。
_PARENT_STRIP_MODIFIER = "%/*"

# config-dispatcher.sh を source する行。
# source 済みのスクリプトだけが PLUGIN_HOOKS の seed を受ける（下記 _resolve_dir_vars）。
# イディオムは複数ある。
# `source "$SCRIPT_DIR/…"` / `source "${SCRIPT_DIR%/*}/core/…"` など。
# `source "${_BRANCH_GUARD_DIR}/…"` のような形もある。
# 基底の書き方には依存させず、source 文であることと参照先名だけを見る。
# 前後の境界は、別名ファイルの source を seed 条件へ誤マッチさせないためにある。
# 別名ファイルとは、名前の一部に config-dispatcher.sh を含むものを指す。
# 例は `my-config-dispatcher.sh` / `config-dispatcher.sh.bak` 等。
# 後方は、`.sh` 参照側の語境界（`_VAR_SH_REF_RE`）より厳しく `.` も弾く。
# `config-dispatcher.sh.bak` のような拡張子追加形を除くため。
# ここは会計と突合するトークンではないので、両側同一境界にする必要がない。
_CONFIG_DISPATCHER_SOURCE_RE = re.compile(
    r"^\s*(?:source|\.)\s.*(?<![A-Za-z0-9._-])config-dispatcher\.sh(?![A-Za-z0-9._-])"
)

_PLUGIN_ROOT_VAR = "CLAUDE_PLUGIN_ROOT"
# config-dispatcher.sh が source 先の shell へ与える hooks/ ルート変数
# （export ではなく source による同一 shell 共有）。
_PLUGIN_HOOKS_VAR = "PLUGIN_HOOKS"


class LibRef(NamedTuple):
    """抽出した参照 1 件（lib スクリプト / テンプレ共通）。

    token はソース上の生表記、path は解決後の実パス。
    """

    token: str
    path: Path


def _code_lines(text: str) -> list[str]:
    """行頭コメント行（`^\\s*#`）を落とし、残る行から行末コメントを切り落とす。

    行末コメントの除去は、最初の `#` で単純に切る。
    クオート内に `#` を含む行は hooks 全域に存在する（gh-command-check.sh の案内 echo 等）。
    ただし、`#` 以降に `.sh` 参照を持つ行は、現状 0 件という前提を置く。
    この方針は、姉妹テスト `tests/test_readme_flow_table_sync.py` の `_strip_comment` と揃えている。
    前提が崩れたら、双方を直す。
    コメント内に `merge-hook-outputs.sh` 等が裸で登場するため、`.sh` 抽出の前段に必須。
    抽出器側と会計側でこの行フィルタを共有することで、コメント扱いの非対称による偽 fail / 偽 pass を防ぐ。
    """
    return [line.split("#", 1)[0] for line in text.splitlines() if not _COMMENT_LINE_RE.match(line)]


def _is_file_like(rel: str) -> bool:
    """末端要素に `.` を含む相対パスをファイルパスとみなす。

    `HELPER="$LIB_DIR/x.sh"` や `TEMPLATE="${PLUGIN_HOOKS}/templates/x.md"` の値は、登録しない。
    ディレクトリ変数として登録すると、後続の `$HELPER/….sh` が `…/x.sh/….sh` として「解決済み」になる。
    その参照は、fail-closed の網から外れてしまう。
    ドット入り basename のディレクトリ（`.pecot` 等）も登録対象から外れる。
    ただし、それを基底とする `.sh` 参照は未解決（ValueError）となるため、fail-closed 側に倒れる。
    """
    return "." in rel.rsplit("/", 1)[-1]


def _resolve_dir_vars(text: str, script_dir: Path, plugin_root: Path) -> dict[str, Path]:
    """スクリプト中のディレクトリ変数を実パスへ解決した写像を返す。

    公開 fixture 用の薄いラッパ。行フィルタを 1 回だけ適用して実体へ渡す。
    """
    return _resolve_dir_vars_from_lines(_code_lines(text), script_dir, plugin_root)


def _resolve_dir_vars_from_lines(
    lines: list[str], script_dir: Path, plugin_root: Path
) -> dict[str, Path]:
    """行フィルタ済みの行リストからディレクトリ変数を解決する。

    値が file-like（末端に `.` を含む）な代入は登録しない（_is_file_like）。
    同名変数の 2 回目の代入は ValueError（fail-closed）。dict の last-wins に
    任せると、先行代入を使う分岐の参照が静かに後続の解決先へ寄せられる。

    PLUGIN_HOOKS は config-dispatcher.sh が source 先の shell へ与える hooks/ ルート。
    `CORE_DIR="${PLUGIN_HOOKS}/lib/core"` のような派生代入の基底になる。
    seed するのは、source しているスクリプトに限る。
    無条件に seed すると、source を欠いたまま `${PLUGIN_HOOKS}/…` を書いたスクリプトがテストを pass してしまう。
    そのスクリプトは、runtime では空展開で fail-open になる。

    seed した PLUGIN_HOOKS への実代入は、重複の判定から外し、seed 値を維持する。
    守る対象は、config-dispatcher.sh を source しつつ自前でも PLUGIN_HOOKS を組み立てるファイル。
    どちらの方法でも解決先は hooks/ ルートのため、重複 ValueError は誤爆になる。
    config-dispatcher.sh 自身は自らを source しないので seed 対象外であり、この分岐には掛からない。
    除外は PLUGIN_HOOKS 限定で、CLAUDE_PLUGIN_ROOT への再代入は従来どおり重複 ValueError（fail-closed）。
    """
    dir_vars: dict[str, Path] = {_PLUGIN_ROOT_VAR: Path(plugin_root)}
    if any(_CONFIG_DISPATCHER_SOURCE_RE.match(line) for line in lines):
        dir_vars[_PLUGIN_HOOKS_VAR] = Path(plugin_root) / "hooks"
    seed_kept = {_PLUGIN_HOOKS_VAR} & dir_vars.keys()

    def _register(name: str, path: Path) -> None:
        if name in seed_kept:
            return
        if name in dir_vars:
            raise ValueError(
                f"ディレクトリ変数 {name} が 2 回代入されています"
                f"（解決先: {dir_vars[name]} → {path}）。"
                "last-wins で先行代入を使う分岐の参照が静かに誤解決されるため、"
                "変数名を分けてください"
            )
        dir_vars[name] = path

    for line in lines:
        self_dir = _SELF_DIR_ASSIGN_RE.match(line)
        if self_dir:
            _register(self_dir.group(1), Path(script_dir))
            continue
        derived = _DERIVED_DIR_ASSIGN_RE.match(line)
        if derived:
            name, base, rel = derived.groups()
            if _is_file_like(rel) or base not in dir_vars:
                continue
            _register(name, dir_vars[base] / rel)
    return dir_vars


def _extract_by_pattern(
    pattern: re.Pattern[str], text: str, script_dir: Path, plugin_root: Path
) -> list[LibRef]:
    """`$VAR/…` 形の参照 regex を受け取り、実パスへ解決して出現順に返す。

    解決できないトークンが 1 件でもあれば ValueError を投げる（fail-closed）。
    読み飛ばしを許すと、抽出器の知らない参照形式が増えたとき、ガードは静かに空振りする。
    `%/*`（親ディレクトリ剥がし）以外の `%` 修飾も、未解決として扱う。
    `%/lib/*` 等は剥がす段数が異なり、parent では解決できない。
    `.sh` 参照とテンプレ参照で解決規則を分岐させないため、両者はこの 1 実装を regex だけ差し替えて共有する。
    """
    lines = _code_lines(text)
    dir_vars = _resolve_dir_vars_from_lines(lines, script_dir, plugin_root)
    refs: list[LibRef] = []
    unresolved: list[str] = []
    for line in lines:
        for match in pattern.finditer(line):
            name = match.group("braced") or match.group("bare")
            modifier = match.group("modifier")
            base = dir_vars.get(name)
            if base is None or (modifier is not None and modifier != _PARENT_STRIP_MODIFIER):
                unresolved.append(match.group(0))
                continue
            if modifier is not None:
                base = base.parent
            refs.append(LibRef(match.group(0), base / match.group("rel")))
    if unresolved:
        raise ValueError(
            f"ディレクトリ変数を解決できない参照があります: {unresolved}。"
            "代入イディオムが抽出器の想定外か、変数の定義が失われています。"
            f"{_PLUGIN_HOOKS_VAR} 起点の参照は、config-dispatcher.sh を source している"
            "ファイルでのみ解決されます。source 行の有無も確認してください。"
        )
    return refs


def _extract_refs(text: str, script_dir: Path, plugin_root: Path) -> list[LibRef]:
    """`$VAR/<path>.sh` / `${VAR%/*}/<path>.sh` 形の参照を実パスへ解決して出現順に返す。"""
    return _extract_by_pattern(_VAR_SH_REF_RE, text, script_dir, plugin_root)


def _extract_template_refs(text: str, script_dir: Path, plugin_root: Path) -> list[LibRef]:
    """`$VAR/…/templates/<name>.md` 形のテンプレ参照を実パスへ解決して出現順に返す。

    テンプレ参照は、`TEMPLATE="${PLUGIN_HOOKS}/templates/x.md"` のような代入形しか現れない。
    抽出器は代入行の右辺も参照として拾う（`.sh` 側と同じ）ため、代入形専用の扱いは要らない。
    この形の代入が dir var として登録されないことは、`_is_file_like` が保証している。
    tests/test_entry_point_lib_refs.py の `test_self_file_like_value_is_not_a_dir_var` が、前提として固定している。
    """
    return _extract_by_pattern(_VAR_MD_TEMPLATE_REF_RE, text, script_dir, plugin_root)


@pytest.fixture(scope="session")
def code_lines() -> Callable[[str], list[str]]:
    """行頭コメントを除いた行リストを返すヘルパ（抽出器と会計側で共有する）。"""
    return _code_lines


@pytest.fixture(scope="session")
def resolve_dir_vars() -> Callable[[str, Path, Path], dict[str, Path]]:
    """ディレクトリ変数 → 実パスの写像を返すヘルパ。"""
    return _resolve_dir_vars


@pytest.fixture(scope="session")
def extract_refs() -> Callable[[str, Path, Path], list[LibRef]]:
    """hooks スクリプトの lib 参照を抽出・解決するヘルパ。"""
    return _extract_refs


@pytest.fixture(scope="session")
def extract_template_refs() -> Callable[[str, Path, Path], list[LibRef]]:
    """hooks スクリプトの `.md` テンプレ参照を抽出・解決するヘルパ。"""
    return _extract_template_refs


# git 呼び出しの記録シム / hook エントリの実行ヘルパ（#1229）。
# hook の git 呼び出し回数（リポジトリ解決の回数）を数えるテストと、エントリを実入力で起動して JSON 応答を検証するテストが共有する。シムは mock_bin（PATH 先頭）に
# 置き、引数を記録してから本物の git へ exec する。本物の git の絶対パスは
# モジュールロード時（PATH が書き換わる前）に解決する。

_REAL_GIT_FOR_SHIM = shutil.which("git") or "git"

_GIT_SHIM_BODY = """#!/bin/bash
printf '%s\\t' "$@" >> "$GIT_SHIM_LOG"
printf '\\n' >> "$GIT_SHIM_LOG"
exec "$REAL_GIT_FOR_SHIM" "$@"
"""


class GitCallLog:
    """git シムの呼び出し記録。1 呼び出し = 引数リスト 1 件。"""

    def __init__(self, log: Path) -> None:
        self.log = log

    def reset(self) -> None:
        self.log.write_text("")

    def calls(self) -> list[list[str]]:
        if not self.log.exists():
            return []
        lines = self.log.read_text().splitlines()
        return [line.rstrip("\t").split("\t") for line in lines if line]

    @staticmethod
    def _subcommand_args(args: list[str]) -> list[str]:
        """`-C <path>` を除いた、サブコマンド以降の引数列。"""
        rest = list(args)
        while rest and rest[0] == "-C":
            rest = rest[2:]
        return rest

    def count(self, subcommand: str) -> int:
        return sum(1 for a in self.calls() if self._subcommand_args(a)[:1] == [subcommand])

    def rev_parse_counts(self) -> dict[str, int]:
        """`rev-parse` の呼び出しを、直後の引数（--show-toplevel 等）ごとに数える。"""
        counts: dict[str, int] = {}
        for args in self.calls():
            sub = self._subcommand_args(args)
            if sub[:1] != ["rev-parse"]:
                continue
            key = sub[1] if len(sub) > 1 else ""
            counts[key] = counts.get(key, 0) + 1
        return counts


@pytest.fixture
def git_call_log(tmp_path: Path, mock_bin: _MockBin, monkeypatch: pytest.MonkeyPatch) -> GitCallLog:
    """PATH 先頭に git シムを置き、呼び出しを記録する。"""
    log = tmp_path / "git-shim.log"
    log.write_text("")
    monkeypatch.setenv("GIT_SHIM_LOG", str(log))
    monkeypatch.setenv("REAL_GIT_FOR_SHIM", _REAL_GIT_FOR_SHIM)
    mock_bin.install("git", _GIT_SHIM_BODY)
    return GitCallLog(log)


@pytest.fixture(scope="session")
def hooks_dir(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks"


@pytest.fixture
def run_hook_entry(hooks_dir: Path) -> Callable[..., subprocess.CompletedProcess]:
    """hooks/ 直下のエントリを JSON 入力で起動する。`bash <entry>` を stdin 付きで実行する。"""

    def _run(
        entry: str,
        payload: dict,
        cwd: str | Path | None = None,
        env: dict | None = None,
    ) -> subprocess.CompletedProcess:
        kwargs: dict = {}
        if env is not None:
            kwargs["env"] = {**os.environ, **env}
        return subprocess.run(
            ["bash", str(hooks_dir / entry)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=25,
            **kwargs,
        )

    return _run


_SOURCE_HOOK_INPUT_THEN_EXEC = (
    'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"'
)


@pytest.fixture
def run_hook_script() -> Callable[..., subprocess.CompletedProcess]:
    """サブスクリプト（lib/<dir>/x.sh）を hook-input.sh を source してから起動する。

    サブスクリプトは stdin の JSON を読まず PECOT_HOOK_*（エントリの project-root.sh が
    hook-input.sh で export）だけを読む。本番と同じ方法で入力を渡すため、
    `source hook-input.sh && pecot_hook_input_load <json> && exec bash <script>` で実行する。
    env 契約は run_script と同一（env=None なら monkeypatch 済みの os.environ を継承）。
    """

    def _run(
        script: str | Path,
        stdin: str,
        cwd: str | Path | None = None,
        env: dict | None = None,
    ) -> subprocess.CompletedProcess:
        kwargs: dict = {}
        if env is not None:
            kwargs["env"] = {**os.environ, **env}
        return subprocess.run(
            ["bash", "-c", _SOURCE_HOOK_INPUT_THEN_EXEC, "_", str(script), stdin],
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=25,
            **kwargs,
        )

    return _run


# project-root の解決（git toplevel）は無効化する。
# サブスクリプトのテストは CLAUDE_PROJECT_DIR を自前で用意するため、cwd の toplevel で上書きされると状態ディレクトリがずれる。
# 解決そのものは、test_hook_resolution_count.py がエントリ経由で検証する。
_SOURCE_POST_MATCH_THEN_EXEC = (
    "PECOT_PROJECT_ROOT_LAZY=1; "
    'source "$(dirname "$1")/../core/project-root.sh" "$2" && '
    "pecot_export_project_root() { :; } && "
    'source "$(dirname "$1")/bash-post-match.sh" "$2" && exec bash "$1"'
)


@pytest.fixture
def run_post_script() -> Callable[..., subprocess.CompletedProcess]:
    """PostToolUse(Bash) のサブスクリプト（lib/post-tool-use/x.sh）を、エントリと同じ前段で起動する。

    サブスクリプトは stdin の JSON を読まず、PECOT_POST_KIND / PECOT_POST_REPO_DIR を読む。
    この 2 つは、lib/post-tool-use/bash-post-match.sh が成功した commit / issue 起票を判定して export する。
    エントリ post-tool-use-bash.sh と同じく、project-root.sh（遅延）→ bash-post-match.sh を source してから起動する。
    toplevel の解決は無効化し、CLAUDE_PROJECT_DIR はテストが用意した値のままにする。
    env 契約は run_script と同一。
    """

    def _run(
        script: str | Path,
        stdin: str,
        cwd: str | Path | None = None,
        env: dict | None = None,
    ) -> subprocess.CompletedProcess:
        kwargs: dict = {}
        if env is not None:
            kwargs["env"] = {**os.environ, **env}
        return subprocess.run(
            ["bash", "-c", _SOURCE_POST_MATCH_THEN_EXEC, "_", str(script), stdin],
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=25,
            **kwargs,
        )

    return _run
