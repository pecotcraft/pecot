"""結果を左右する環境変数の宣言を確かめる静的テスト（#1225 / FR-008）。

nx の task cache は、宣言した入力が変わらない限りレーンを再実行しない。
レーンが読む環境変数のうち、結果を左右するものが nx.json の env 系 namedInput に無いと、
値が変わっても前回の成功が再利用され、退行が検出されない。
そこで、レーンが読むコードと設定から「自分では代入しない大文字の変数」を抜き出す。
抜き出した変数が、次のどれかに載っていることを要求する。

  - nx.json の namedInputs.env。全レーン共通で、node 自身が読む変数など、どのレーンにも関わるものを置く。
  - そのプラグインの env。pecotPluginEnv / pecotvPluginEnv / pecotToolsPluginEnv のどれかで、
    変数を読むファイルのあるプラグインのレーンだけが、値の変化で再実行される。
  - 本ファイルの _EXEMPT。宣言しない理由を添える。

外から読む変数の数え方は次のとおり。
  - シェルは行の順に見る。その行より前の行で代入や束縛をしていない変数の読み取りを数える。
    `X="${X:-1}"` のような既定値つきの展開は、同じ行の代入より先に外の値を読むので数える。
    ファイルの後ろで代入していても、それより前の読み取りは外の値を読む。
  - `interface-env:` のコメントの名前は、代入や stub に関わらず数える。`none` は数えない。
    interface-spec と違い、直前の行に限らずファイル全体を数え、行頭のコメント（.py は `#`、JS 系は `//` か `/*`）に限る。
    行頭に限るのは、文字列の中の目印を拾わないため。
  - JS は、`process.env.X || 既定値` の形か、null 合体演算子で既定値を付けた形の読み取りを、
    ファイル内の代入に関わらず数える。
    それ以外は、ファイル内で代入や stub をしている変数を数えない。

走査の対象は、レーンが実行するコード全体に絞らず、広げてある。
run-tests.sh / install.sh が外から読む変数は少ない。
結果を左右する変数（PLAYWRIGHT_BROWSERS_PATH、PECOTV_SINGLE_PASS 等）は、テストコードと設定の側にある。
シェルは scripts/ci/*.sh・bin/*・setup.sh に加え、レーンが直接実行する tests 配下の *.sh を走査する。
tests 配下の例は plugins/pecot-tools/cli/tests/bootstrap/run.sh になる。
hooks 配下の *.sh（hooks/**/*.sh と hooks/tests/*.test.sh）は走査しない。
hook スクリプトは、dispatcher や別のスクリプトが設定して渡す変数を大量に読む。
HOOK_COMMAND、REPO_DIR、FILE_PATH 等がその例で、環境変数と見分けがつかない。
手元で確認すると、hooks 配下のシェルから外の値として拾う 23 変数のうち、半数ほどがこの内部変数だった。
これを数えると、宣言と _EXEMPT の信頼を損なう。
hooks が外から読む変数は、プラグインの env に手で載せる。
PECOT_HOOKS_CONFIG_PATH、PECOTV_HOOKS_CONFIG_PATH、CLAUDE_CONFIG_DIR 等がその例になる。
載せた名前が実在するかは、test_plugin_env_is_mentioned_in_that_plugin が見る。

対象を変えたときにこのテストが起動するよう、.pre-commit-config.yaml の nx-env-inputs に同じ範囲を載せている。
この範囲は test_pre_commit_config_wiring.py が固定する。
このテストは約 0.3 秒で終わる。
githooks のレーンの入力には plugins と libs の全体を入れず、この確認を nx-env-inputs の hook が受け持つ。
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

# parents[0]=tests, [1]=.githooks, [2]=リポルート。
_REPO_ROOT = Path(__file__).resolve().parents[2]

# 宣言しない変数と、その理由を置く。
# 対象は、値が結果を左右しない変数、レーンの外で決まる変数、レーン自身が必ず上書きする変数に限る。
# 足すときは理由を 1 行で書く。
# 読まれなくなった変数は test_exempt_entries_are_still_read が落とす。そのときは行ごと消す。
_EXEMPT: dict[str, str] = {
    "PATH": (
        "実行ファイルの版は runtime 入力（node / uv / aws の --version）で見る。値そのものは"
        "端末・フック・IDE ごとに揺れ、入れると無関係な再実行が増える"
    ),
    "PECOTV_SKIP_INSTALL": "test target の command が 1 を渡す。install と共有 build を nx の別 target に分ける",
    "PECOTV_SKIP_LIB_BUILD": (
        "build-slidev の command が 1 を渡す定数。nx では text-rules:build が先に dist を作る。"
        "ミラーの bootstrap は渡さず、build.mjs が text-rules も build する"
    ),
    "PECOT_TOOLS_SKIP_INSTALL": "test target の command が 1 を渡す。PECOTV_SKIP_INSTALL と同じ",
    "PECOT_WORKFLOW_SKIP_INSTALL": (
        "test-cli・test-hooks・lint-cli の command が 1 を渡す。PECOTV_SKIP_INSTALL と同じ。"
        "install を nx の別 target に分ける"
    ),
    "PECOTV_REQUIRE_HOST_DEPS": "bin/pecotv が自分で設定して子へ渡す。外からの値はテストが上書きする",
    "PECOTV_TEST": "process.test.ts が子プロセスの env へ渡す値で、外の値は読まれない",
    "BIN_PECOTV": "bootstrap の run.sh が export して mcp-call.mjs へ渡す。呼び出し元が必ず設定する",
    "PECOTV_PM_GUARD_BEHAVIOR": (
        "install target（cache: false）が pre-push フック経由で渡す。ガード単体の test は"
        "値を自分で env に渡し、source しただけでは読まれない"
    ),
    "PM_GUARD_TIMEOUT": (
        "挙動の確認を打ち切る秒数。値で結果が変わるのは時間切れの失敗だけで、失敗は nx がキャッシュしない。"
        "実行するのは cache: false の install"
    ),
    "PECOTV_BOOTSTRAP_TEST_HEAVY": (
        "cli/tests/bootstrap/run.sh は手動実行専用。レーンが実行するのは host-deps-marker.sh だけ"
    ),
    "NODE_EXTRA_CA_CERTS": (
        "テストが vi.stubEnv で上書きする。null 合体演算子で `process.env.NODE_EXTRA_CA_CERTS` を読む箇所は、テストが書く偽の子プロセスの中にある"
    ),
    "PECOT_RELEASE_TEST_NPM_CACHE": (
        "test-release の command が必ず絶対パスで渡し、レーンの外からは値が変わらない"
    ),
    "NPM_STUB_LOG": "テストが export し、heredoc で書く npm スタブが実行時に読む。外の値は読まれない",
    "GH_STUB_DIR": "release テストが export し、heredoc で書く gh スタブが実行時に読む。外の値は読まれない",
    "GH_STUB_LOG": "release テストが export し、gh スタブが呼び出しを記録する先。外の値は読まれない",
    "GH_STUB_NO_RELEASE": "release テストが env に渡す gh スタブの失敗注入。外の値は読まれない",
    "GH_VIEW_RC": "release テストが env に渡す gh スタブの終了コード。外の値は読まれない",
    "REMOTE_CONTAINERS": "ensureDevcontainerEnvironment だけが読み、そのテストが毎回外す。外の値は結果を左右しない",
    "CODESPACES": "ensureDevcontainerEnvironment だけが読み、そのテストが毎回外す。外の値は結果を左右しない",
    "DEVCONTAINER": "ensureDevcontainerEnvironment だけが読み、そのテストが毎回外す。外の値は結果を左右しない",
    "PECOTV_PLUGIN_ROOT": "source した check-pm-guard.sh が設定するシェル変数。環境変数ではない",
    "REPO_ROOT": "source した check-pm-guard.sh が設定するシェル変数。環境変数ではない",
    # --- #1230 プラグインのデータ置き場 ---
    "PECOT_BOOTSTRAP_SKIP": (
        "pre-push で動く run-tests.sh と conftest が unset して固定する。bin/pecot の SKIP は"
        "テストが自分で env に渡す"
    ),
    "PECOT_GITHUB_API_URL": (
        "cli/tests/conftest.py が unset して固定する。前後比較のテストは、子プロセスの env に偽サーバの URL を"
        "自分で渡す"
    ),
    "CLAUDE_PLUGIN_DATA": (
        "hook と MCP に上流が渡すデータ置き場。pre-push で動く run-tests.sh が unset して固定し、"
        "bootstrap テストと pytest の conftest・vitest の setupFiles は一時ディレクトリを自分で向ける"
    ),
    "PLUGIN_DATA": (
        "Agent Plugins 1.0 の MCP と単体配布の登録の env が渡すデータ置き場。pre-push で動く run-tests.sh が"
        "unset して固定し、解決順を確かめるテストだけが自分で env に渡す"
    ),
    "XDG_DATA_HOME": (
        "既定のデータ置き場（${XDG_DATA_HOME}/pecot/<project 名>）の解決にだけ読む。テストは CLAUDE_PLUGIN_DATA で"
        "一時ディレクトリへ向けるので、値は結果を左右しない。既定の場所を確かめるテストだけが子プロセスへ渡す。"
        "全体では付け替えない（pnpm の store と uv の Python の置き場まで動くため）"
    ),
    "PECOTV_DEPENDENCY_ROOT": (
        "scripts/ci/run-tests.sh が unset し、vitest の setupFiles（unset-plugin-data-environment.ts）も消す。"
        "PLUGIN_DATA と同じ"
    ),
    "PECOTV_RUNTIME_DIR": (
        "scripts/ci/run-tests.sh が unset し、vitest の setupFiles（unset-plugin-data-environment.ts）も消す。"
        "PLUGIN_DATA と同じ"
    ),
    "PECOT_GITHUB_*_TOKEN": (
        "nx の env は 1 つの名前しか取らず、`*` の名前を宣言できない。読む cli/core/github/client.py が動くのは"
        "test-py だけで、cli/tests/conftest.py の autouse が外して固定する。cli-node の同じ読みは"
        "useIsolatedEnvironment が外す。秘密の値をハッシュに入れない点も合う"
    ),
    "GITHUB_COM_TOKEN": "PECOT_GITHUB_*_TOKEN と同じ読みの組なので、同じ扱い",
    "SCRIPT_DIR": "bootstrap テストの stub-root.sh が自分の置き場所から求める内部変数",
    "STUB_FAIL_BUILD": "bootstrap テストの stub pnpm の失敗注入。テストが自分で env に渡す",
    "STUB_FAIL_INSTALL": "bootstrap テストの stub pnpm の失敗注入。テストが自分で env に渡す",
    "PLUGIN_RUNTIME_DIR": "source した bin/_lib.sh の plugin_runtime_ensure が設定するシェル変数。環境変数ではない",
    "PLUGIN_RUNTIME_FORCE": "wrapper が PECOTV_BOOTSTRAP_FORCE から設定し、source した bin/_lib.sh が読むシェル変数",
    "PLUGIN_RUNTIME_NAME": "source した bin/_lib.sh が設定するシェル変数。環境変数ではない",
    # source した helper（stub-root.sh）が設定するシェル変数。環境変数ではない。
    "PASS": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "FAIL": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "BASE": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "ROOT": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "DATA": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "CALLS": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "OUT": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "ERR": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "REV": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "NOFLOCK_BIN": "source した stub-root.sh の make_noflock_bin が設定するシェル変数。環境変数ではない",
    "LAX_MKDIR_BIN": "source した stub-root.sh の make_lax_mkdir_bin が設定するシェル変数。環境変数ではない",
    "RUN_ROOT": "install-record.sh が版の並走の再現で設定し、source した stub-root.sh が読むシェル変数。外の値は読まれない",
    "STUB_PNPM_DELAY": "テストが env に渡す stub pnpm の遅延秒数。外の値は読まれない",
    "STUB_BIN": "source した stub-root.sh が設定するシェル変数。環境変数ではない",
    "STUB_NODE_MAJOR": "テストが env に渡す stub node の値。外の値は読まれない",
}

_ENV_NAME = r"[A-Z][A-Z0-9_]{2,}"

# シェルの内部変数。環境変数ではない。
_SHELL_BUILTINS = {
    "BASH_SOURCE",
    "BASH_REMATCH",
    "BASH_VERSION",
    "BASH_VERSINFO",
    "BASHPID",
    "EPOCHREALTIME",
    "EPOCHSECONDS",
    "FUNCNAME",
    "IFS",
    "LINENO",
    "OLDPWD",
    "PIPESTATUS",
    "PWD",
    "RANDOM",
    "SECONDS",
    "SHLVL",
}

# `$NAME`・`${NAME}`・`${NAME:-x}` 等。JS のテンプレートリテラル（`${JSON.stringify(...)}`）や
# perl の `$SIG{INT}` など、シェルの展開ではない文字列を拾わないよう、名前の直後を限る。
_SH_READ = re.compile(
    rf"\$(?:\{{({_ENV_NAME})(?=[}}:=+?#%/^,@\[-])|({_ENV_NAME})(?![A-Za-z0-9_{{]))"
)
# `${X:-…}` `${X-…}` `${X:=…}` `${X=…}`。外の値を読んでから既定値を使う展開。
_SH_READ_DEFAULT = re.compile(rf"\$\{{({_ENV_NAME})(?::?[-=])")
_SH_ASSIGN = re.compile(
    rf"(?:^|[;&|(\s])(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)?)?({_ENV_NAME})\+?=",
    re.MULTILINE,
)
_SH_BIND = re.compile(
    rf"\bfor\s+({_ENV_NAME})\s+in\b|\bread\s+(?:-\w+\s+)*({_ENV_NAME})|\bmapfile\s+(?:-\w+\s+)*({_ENV_NAME})"
)
_SH_UNSET = re.compile(r"\bunset\s+(?:-\w+\s+)*([^;&|\n]*)")
_JS_READ = re.compile(rf"process\.env\.({_ENV_NAME})|process\.env\[['\"]({_ENV_NAME})['\"]\]")
# 既定値つきの読み取り。同じファイルで代入していても、その前に外の値を読む。
_JS_READ_DEFAULT = re.compile(
    rf"process\.env\.({_ENV_NAME})\s*(?:\?\?|\|\|)|process\.env\[['\"]({_ENV_NAME})['\"]\]\s*(?:\?\?|\|\|)"
)
_JS_ASSIGN = re.compile(
    rf"process\.env\.({_ENV_NAME})\s*=[^=]|process\.env\[['\"]({_ENV_NAME})['\"]\]\s*=[^=]"
    rf"|stubEnv\(\s*['\"]({_ENV_NAME})|delete\s+process\.env\.({_ENV_NAME})"
)
_PY_READ = re.compile(
    rf"(?:os\.environ(?:\.get)?|environ\.get|os\.getenv|getenv)\s*[(\[]\s*['\"]({_ENV_NAME})['\"]"
)
_PY_ASSIGN = re.compile(
    rf"(?:setenv|delenv)\(\s*['\"]({_ENV_NAME})|os\.environ\[['\"]({_ENV_NAME})['\"]\]\s*=[^=]"
    rf"|os\.environ\.(?:pop|setdefault)\(\s*['\"]({_ENV_NAME})"
)
# package.json の scripts は 1 行のシェル。`NAME=value cmd` の前置代入は代入、`$NAME` は読み取り。
_PKG_ASSIGN = re.compile(rf"(?:^|[;&|(\s])({_ENV_NAME})=")
_PY_INTERFACE_ENV = re.compile(r"^[ \t]*#[ \t]*interface-env:(.*)$", re.MULTILINE)
_JS_INTERFACE_ENV = re.compile(r"^[ \t]*(?://|/\*)[ \t]*interface-env:(.*)$", re.MULTILINE)
# libs/interface-spec の isValidEnvironmentName と同じ形。
_INTERFACE_ENV_NAME = re.compile(r"[A-Za-z_]\w*|[A-Z0-9_]+\*[A-Z0-9_]+")

_JS_SUFFIXES = {".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"}


def _flat(matches: list) -> set[str]:
    return {g for m in matches for g in (m if isinstance(m, tuple) else (m,)) if g}


def _interface_env_names(text: str, marker: re.Pattern[str]) -> set[str]:
    """`interface-env:` の行に書かれた名前。`none` と、名前の形でない説明の語は除く。"""
    names: set[str] = set()
    for m in marker.finditer(text):
        for token in re.split(r"[\s,]+", m.group(1).replace("*/", " ")):
            if token != "none" and _INTERFACE_ENV_NAME.fullmatch(token):
                names.add(token)
    return names


def _strip_shell_comments(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def _is_shell_in_scope(rel: str) -> bool:
    """レーンが呼ぶシェル。ci スクリプト・bin の wrapper・setup.sh・tests 配下の *.sh。

    hooks 配下は含めない（理由はモジュールの docstring）。
    """
    if "/hooks/" in rel:
        return False
    return bool(
        re.fullmatch(r"plugins/[^/]+/scripts/ci/[^/]+\.sh", rel)
        or re.fullmatch(r"plugins/[^/]+/bin/[^/]+", rel)
        or re.fullmatch(r"plugins/[^/]+/setup\.sh", rel)
        or re.fullmatch(r"plugins/[^/]+/(?:[^/]+/)*tests/(?:[^/]+/)*[^/]+\.sh", rel)
    )


def _shell_external_reads(code: str) -> set[str]:
    """行の順に見て、その位置より前で代入・束縛していない変数の読み取りを集める。

    ファイルの後ろで代入していても、それより前の行の読み取りは外の値を読む。
    同じ行では、代入より前の読み取りと、既定値つきの展開を数える。
    `X="${X:-1}"` は、代入の右辺で外の値を読む形にあたる。
    `TMP=$(mktemp -d); rm "$TMP"` のような代入より後の読み取りは、数えない。
    """
    assigned: set[str] = set()
    external: set[str] = set()
    for line in code.splitlines():
        assigns = {
            name: min(m.start() for m in _SH_ASSIGN.finditer(line) if name in m.groups())
            for name in _flat(_SH_ASSIGN.findall(line))
        }
        defaults = _flat(_SH_READ_DEFAULT.findall(line))
        for m in _SH_READ.finditer(line):
            name = m.group(1) or m.group(2)
            if name in assigned:
                continue
            if name in assigns and assigns[name] < m.start() and name not in defaults:
                continue
            external.add(name)
        assigned |= set(assigns) | _flat(_SH_BIND.findall(line))
        for unset in _SH_UNSET.findall(line):
            assigned |= {tok for tok in unset.split() if re.fullmatch(_ENV_NAME, tok)}
    return external - _SHELL_BUILTINS


def scan_env_reads(root: Path, rels: list[str]) -> dict[str, set[str]]:
    """rels（root からの相対パス）が外から読む大文字の環境変数 → 読むファイル。

    同じファイルの中で、読む前に代入・束縛している変数は外の値に左右されないので数えない
    （数え方の詳細はモジュールの docstring）。
    """
    reads: dict[str, set[str]] = {}

    def add(names: set[str], rel: str) -> None:
        for name in names:
            reads.setdefault(name, set()).add(rel)

    for rel in rels:
        path = root / rel
        if not path.is_file():
            continue
        suffix = path.suffix
        if rel.endswith("/package.json"):
            try:
                scripts = json.loads(path.read_text(encoding="utf-8")).get("scripts", {})
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            for command in scripts.values():
                if not isinstance(command, str):
                    continue
                names = _flat(_SH_READ.findall(command)) | _flat(_JS_READ.findall(command))
                add(names - _flat(_PKG_ASSIGN.findall(command)) - _SHELL_BUILTINS, rel)
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if _is_shell_in_scope(rel):
            add(_shell_external_reads(_strip_shell_comments(text)), rel)
        elif suffix in _JS_SUFFIXES:
            plain = _flat(_JS_READ.findall(text)) - _flat(_JS_ASSIGN.findall(text))
            add(plain | _flat(_JS_READ_DEFAULT.findall(text)), rel)
            add(_interface_env_names(text, _JS_INTERFACE_ENV), rel)
        elif suffix == ".py":
            add(_flat(_PY_READ.findall(text)) - _flat(_PY_ASSIGN.findall(text)), rel)
            add(_interface_env_names(text, _PY_INTERFACE_ENV), rel)
    return reads


def _tracked_plugin_files() -> list[str]:
    """走査する追跡ファイル。プラグインと、プラグインではないライブラリ（libs/<name>/）。"""
    out = subprocess.run(
        ["git", "ls-files", "plugins", "libs"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    # interface-spec の fixture のソースは検証にかけるデータで、どのレーンも実行しない。
    return [
        line
        for line in out.splitlines()
        if "/node_modules/" not in line
        and not line.startswith("libs/interface-spec/tests/fixtures/")
    ]


# プラグインのディレクトリ名 → そのプラグインのレーンが使う env の namedInput。
_PLUGIN_ENV_INPUT = {
    "pecot-workflow": "pecotPluginEnv",
    "pecot-visual": "pecotvPluginEnv",
    "pecot-tools": "pecotToolsPluginEnv",
}
# プラグインのディレクトリ名 → そのプラグインの test / lint の Globals。
_PLUGIN_GLOBALS = {
    "pecot-workflow": ("pecotPluginTestGlobals", "pecotPluginLintGlobals"),
    "pecot-visual": ("pecotvPluginTestGlobals", "pecotvPluginLintGlobals"),
    "pecot-tools": ("pecotToolsPluginTestGlobals", "pecotToolsPluginLintGlobals"),
}


def _named_env(input_name: str) -> set[str]:
    nx_json = json.loads((_REPO_ROOT / "nx.json").read_text(encoding="utf-8"))
    return {
        e["env"]
        for e in nx_json["namedInputs"].get(input_name, [])
        if isinstance(e, dict) and "env" in e
    }


def _declared_env() -> set[str]:
    """全レーン共通の env。"""
    return _named_env("env")


def _plugin_of(rel: str) -> str:
    """ファイルの持ち主。プラグインはディレクトリ名、ライブラリは `libs/<name>`。"""
    parts = rel.split("/")
    return parts[1] if parts[0] == "plugins" else "/".join(parts[:2])


def _declared_for(plugin: str) -> set[str]:
    """そのプラグインのレーンで値の変化が再実行を起こす変数（共通 + プラグイン別）。

    libs/<name>/ のライブラリは専用の env を持たず、共通の env だけを宣言済みとみなす。
    """
    if plugin not in _PLUGIN_ENV_INPUT:
        return _declared_env()
    return _declared_env() | _named_env(_PLUGIN_ENV_INPUT[plugin])


def _all_declared_env() -> set[str]:
    return _declared_env().union(*(_named_env(name) for name in _PLUGIN_ENV_INPUT.values()))


@pytest.fixture(scope="module")
def repo_reads() -> dict[str, set[str]]:
    return scan_env_reads(_REPO_ROOT, _tracked_plugin_files())


def test_every_env_read_is_declared_or_exempt(repo_reads: dict[str, set[str]]) -> None:
    """変数を読むファイルのあるプラグインの env か、共通の env に宣言されていること。"""
    undeclared: dict[str, list[str]] = {}
    for name, files in sorted(repo_reads.items()):
        if name in _EXEMPT:
            continue
        missing = sorted(f for f in files if name not in _declared_for(_plugin_of(f)))
        if missing:
            undeclared[name] = missing[:3]
    assert not undeclared, (
        "次の環境変数が、どこにも宣言されていません。"
        "宣言先は、読むファイルのあるプラグインの env、共通の env、_EXEMPT のどれかです。"
        "プラグインの env は nx.json の pecotPluginEnv / pecotvPluginEnv / pecotToolsPluginEnv を指します。"
        "結果を左右するなら、そのプラグインの env へ載せてください。"
        "全レーンに関わるなら、共通の env へ載せてください。"
        "結果を左右しないなら、理由を添えて _EXEMPT へ載せてください:\n"
        + "\n".join(f"  {name}: {files}" for name, files in undeclared.items())
    )


def test_common_env_is_only_what_every_plugin_reads(repo_reads: dict[str, set[str]]) -> None:
    """共通の env に置くのは、全レーンに関わる変数だけとする。

    1 プラグインしか読まない変数は、その他のプラグインのレーンを無関係に再実行する。
    そのため、プラグインの env へ移す。
    node 自身が読む変数（NODE_OPTIONS 等）は走査では見えないため、読み取りが見えた変数だけを見る。
    """
    narrow = {
        name: sorted({_plugin_of(f) for f in repo_reads[name]} & set(_PLUGIN_ENV_INPUT))
        for name in sorted(_declared_env())
        if name in repo_reads
        and len({_plugin_of(f) for f in repo_reads[name]} & set(_PLUGIN_ENV_INPUT))
        < len(_PLUGIN_ENV_INPUT)
    }
    assert not narrow, f"共通の env にあるが、一部のプラグインしか読まない変数: {narrow}"


@pytest.mark.parametrize("plugin", sorted(_PLUGIN_ENV_INPUT))
def test_plugin_env_is_mentioned_in_that_plugin(plugin: str) -> None:
    """プラグインの env に載せた変数は、そのプラグインのファイルに名前が出てくること。

    走査で見えない読み取り（hooks のテスト、monkeypatch 経由）を手で載せた変数が、
    別のプラグインのレーンを再実行する場所に紛れ込むのを防ぐ。
    """
    pending = _named_env(_PLUGIN_ENV_INPUT[plugin])
    for rel in _tracked_plugin_files():
        if not pending:
            break
        if not rel.startswith(f"plugins/{plugin}/"):
            continue
        try:
            text = (_REPO_ROOT / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        pending = {name for name in pending if name not in text}
    absent = sorted(pending)
    assert not absent, f"plugins/{plugin} のどのファイルにも出てこない変数: {absent}"


@pytest.mark.parametrize("plugin", sorted(_PLUGIN_ENV_INPUT))
def test_lane_globals_include_common_and_plugin_env(plugin: str) -> None:
    nx_json = json.loads((_REPO_ROOT / "nx.json").read_text(encoding="utf-8"))
    for globals_name in _PLUGIN_GLOBALS[plugin]:
        entries = [e for e in nx_json["namedInputs"][globals_name] if isinstance(e, str)]
        assert "env" in entries, f"{globals_name} に共通の env が無い"
        assert _PLUGIN_ENV_INPUT[plugin] in entries, f"{globals_name} にプラグインの env が無い"
        others = {v for k, v in _PLUGIN_ENV_INPUT.items() if k != plugin}
        assert not others & set(entries), f"{globals_name} に他プラグインの env が入っている"


def test_library_project_files_are_scanned_against_the_common_env() -> None:
    """libs/<name>/ の追跡ファイルも走査し、宣言済みとみなすのは共通の env だけにする。"""
    files = _tracked_plugin_files()
    assert "libs/text-rules/index.ts" in files
    assert _plugin_of("libs/text-rules/index.ts") == "libs/text-rules"
    assert _plugin_of("plugins/pecot-tools/cli/src/a.ts") == "pecot-tools"
    assert _declared_for("libs/text-rules") == _declared_env()


def test_exempt_entries_are_still_read(repo_reads: dict[str, set[str]]) -> None:
    """読まれなくなった変数が _EXEMPT へ残り続けないようにする。"""
    stale = sorted(name for name in _EXEMPT if name not in repo_reads)
    assert not stale, f"_EXEMPT に残っているが、どこからも読まれていない変数: {stale}"


def test_exempt_and_declared_do_not_overlap() -> None:
    both = sorted(set(_EXEMPT) & _all_declared_env())
    assert not both, f"env に宣言済みの変数が _EXEMPT にもある: {both}"


def test_exempt_reasons_are_not_empty() -> None:
    assert all(reason.strip() for reason in _EXEMPT.values())


# --- 検出の仕組み自体を固定する。走査が対象を取りこぼさないことを確かめる ---


def test_scan_finds_undeclared_variable_in_each_kind_of_file(tmp_path: Path) -> None:
    files = {
        "plugins/p/scripts/ci/run-tests.sh": 'echo "${UNDECLARED_SH:-x}"\n',
        "plugins/p/scripts/ci/run-lint.sh": 'if [ -n "$UNDECLARED_LINT" ]; then :; fi\n',
        "plugins/p/bin/wrapper": "echo $UNDECLARED_BIN\n",
        "plugins/p/cli/package.json": json.dumps(
            {"scripts": {"test": "vitest run $UNDECLARED_PKG"}}
        ),
        "plugins/p/cli/vitest.config.ts": "export default { x: process.env.UNDECLARED_VITEST }\n",
        "plugins/p/cli/src/a.ts": "const v = process.env['UNDECLARED_SRC']\n",
        "plugins/p/cli/tests/a.test.ts": "const v = process.env.UNDECLARED_TS_TEST\n",
        "plugins/p/cli/core.py": 'import os\nv = os.environ.get("UNDECLARED_PY")\n',
    }
    for rel, text in files.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text, encoding="utf-8")

    reads = scan_env_reads(tmp_path, list(files))
    assert set(reads) == {
        "UNDECLARED_SH",
        "UNDECLARED_LINT",
        "UNDECLARED_BIN",
        "UNDECLARED_PKG",
        "UNDECLARED_VITEST",
        "UNDECLARED_SRC",
        "UNDECLARED_TS_TEST",
        "UNDECLARED_PY",
    }


def test_scan_ignores_variables_the_file_assigns_itself(tmp_path: Path) -> None:
    files = {
        "plugins/p/scripts/ci/run-tests.sh": 'LOCAL_SH=1\nexport EXPORTED_SH=2\necho "$LOCAL_SH $EXPORTED_SH"\n',
        "plugins/p/cli/package.json": json.dumps(
            {"scripts": {"test": "SET_PKG=1 vitest run $SET_PKG"}}
        ),
        "plugins/p/cli/src/a.test.ts": (
            "process.env.SET_TS = 'x'\nconst v = process.env.SET_TS\n"
            "vi.stubEnv('STUBBED', '1')\nconst w = process.env.STUBBED\n"
        ),
        "plugins/p/cli/t.py": (
            'import os\nmonkeypatch.setenv("SET_PY", "1")\nv = os.environ.get("SET_PY")\n'
        ),
    }
    for rel, text in files.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text, encoding="utf-8")

    assert scan_env_reads(tmp_path, list(files)) == {}


def test_scan_skips_comments_and_shell_builtins(tmp_path: Path) -> None:
    rel = "plugins/p/scripts/ci/run-tests.sh"
    (tmp_path / rel).parent.mkdir(parents=True)
    (tmp_path / rel).write_text(
        '# NODE_V8_COVERAGE=\'\' bash run-tests.sh\nDIR="$(dirname "${BASH_SOURCE[0]}")"\ncd "$PWD"\n',
        encoding="utf-8",
    )
    assert scan_env_reads(tmp_path, [rel]) == {}


def _write_files(root: Path, files: dict[str, str]) -> list[str]:
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    return list(files)


@pytest.mark.parametrize("operator", [":-", "-", ":=", "="])
def test_scan_counts_default_expansion_even_when_the_file_assigns_the_variable(
    tmp_path: Path, operator: str
) -> None:
    """`X="${X:-1}"` は外の値を読んでから代入する。代入があっても外の値の読み取りとして数える。"""
    rels = _write_files(
        tmp_path,
        {
            "plugins/p/scripts/ci/run-tests.sh": f'DEFAULTED_SH="${{DEFAULTED_SH{operator}1}}"\necho "$DEFAULTED_SH"\n'
        },
    )
    assert set(scan_env_reads(tmp_path, rels)) == {"DEFAULTED_SH"}


def test_scan_counts_shell_reads_before_the_first_assignment(tmp_path: Path) -> None:
    """ファイルの後ろで代入していても、それより前の読み取りは外の値を読む。"""
    rels = _write_files(
        tmp_path,
        {
            "plugins/p/bin/wrapper": (
                'if [ "${READ_FIRST:-}" != "1" ]; then :; fi\n'
                "export READ_FIRST=1\n"
                'echo "$READ_FIRST"\n'
                "ASSIGNED_FIRST=0\n"
                'echo "${ASSIGNED_FIRST:-x}"\n'
            )
        },
    )
    assert set(scan_env_reads(tmp_path, rels)) == {"READ_FIRST"}


@pytest.mark.parametrize("default", ["??", "||"])
@pytest.mark.parametrize("read", ["process.env.DEFAULTED_JS", "process.env['DEFAULTED_JS']"])
def test_scan_counts_js_default_reads_even_when_the_file_assigns_the_variable(
    tmp_path: Path, default: str, read: str
) -> None:
    rels = _write_files(
        tmp_path,
        {
            "plugins/p/cli/src/a.ts": (
                f"process.env.DEFAULTED_JS = 'x'\nconst v = {read} {default} 'fallback'\n"
            )
        },
    )
    assert set(scan_env_reads(tmp_path, rels)) == {"DEFAULTED_JS"}


def test_scan_reads_shell_under_tests_but_not_under_hooks(tmp_path: Path) -> None:
    """レーンが直接実行する tests 配下の *.sh は走査する。hooks 配下は走査しない（docstring 参照）。"""
    rels = _write_files(
        tmp_path,
        {
            "plugins/p/cli/tests/bootstrap/run.sh": 'echo "${UNDECLARED_TESTS_SH:-}"\n',
            "plugins/p/scripts/release/tests/audit.test.sh": 'echo "$UNDECLARED_RELEASE_TEST"\n',
            "plugins/p/hooks/tests/session-start.test.sh": 'echo "$HOOKS_TEST_ONLY"\n',
            "plugins/p/hooks/lib/core/dispatcher.sh": 'echo "$HOOKS_LIB_ONLY"\n',
            "plugins/p/cli/src/helper.sh": 'echo "$NOT_IN_SCOPE_SH"\n',
        },
    )
    assert set(scan_env_reads(tmp_path, rels)) == {"UNDECLARED_TESTS_SH", "UNDECLARED_RELEASE_TEST"}


def test_scan_counts_interface_env_names_for_reads_by_a_constant(tmp_path: Path) -> None:
    """名前を定数で渡す読みは、直前の `interface-env:` の名前で数える。同じファイルの stub では引かない。"""
    rels = _write_files(
        tmp_path,
        {
            "plugins/p/cli/src/a.test.ts": (
                "vi.stubEnv('A', '1')\n// interface-env: A B\nconst v = process.env[NAMES.a]\n"
            ),
            "plugins/p/cli/core.py": (
                "import os\n# interface-env: C, D\nv = os.environ.get(name)\n"
            ),
        },
    )
    assert set(scan_env_reads(tmp_path, rels)) == {"A", "B", "C", "D"}


def test_scan_skips_interface_env_none_and_markers_inside_strings(tmp_path: Path) -> None:
    rels = _write_files(
        tmp_path,
        {
            "plugins/p/cli/src/a.test.ts": (
                "// interface-env: none\n"
                "  // interface-env: KEPT\n"
                "const s = '// interface-env: E\\n'\n"
                "const t = `x\\n// interface-env: F`\n"
            ),
            "plugins/p/cli/core.py": "# interface-env: none\ns = '# interface-env: G'\n",
        },
    )
    assert set(scan_env_reads(tmp_path, rels)) == {"KEPT"}


def test_scan_keeps_only_valid_names_in_interface_env(tmp_path: Path) -> None:
    rels = _write_files(
        tmp_path,
        {
            "plugins/p/cli/src/a.ts": (
                "/* interface-env: PECOT_GITHUB_*_TOKEN (see foo.bar) PLAIN_NAME */\n"
            ),
        },
    )
    assert set(scan_env_reads(tmp_path, rels)) == {"PECOT_GITHUB_*_TOKEN", "PLAIN_NAME"}
