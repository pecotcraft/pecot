"""結果を左右する環境変数の宣言を確かめる静的テスト（#1225 / FR-008）。

nx の task cache は、宣言した入力が変わらない限りレーンを再実行しない。
レーンが読む環境変数のうち、結果を左右するものが nx.json の env 系 namedInput に無いと、
値が変わっても前回の成功が再利用され、退行が検出されない。
そこで、レーンが読むコードと設定から「自分では代入しない大文字の変数」を抜き出す。
抜き出した変数が、次のどれかに載っていることを要求する。

  - nx.json の namedInputs.env。全レーン共通で、node 自身が読む変数など、どのレーンにも関わるものを置く。
  - そのプラグインの env。pecotPluginEnv / pecotvPluginEnv のどちらかで、
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
tests 配下の例は plugins/pecot-visual/cli/tests/bootstrap/run.sh になる。
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

import allure
import pytest

# parents[0]=tests, [1]=.githooks, [2]=リポルート。
_REPO_ROOT = Path(__file__).resolve().parents[2]

# 宣言しない変数と、その理由を置く。
# 対象は、値が結果を左右しない変数、レーンの外で決まる変数、レーン自身が必ず上書きする変数に限る。
# 足すときは理由を 1 行で書く。
# 読まれなくなった変数は test_exempt_entries_are_still_read が落とす。そのときは行ごと消す。
_EXEMPT: dict[str, str] = {
    "COLUMNS": "枠の幅。cli のテストは幅を引数で渡し、前後比較は子プロセスに 80 を渡すので、外の値は結果を変えない",
    "TERMINAL_WIDTH": "COLUMNS と同じ",
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
    "NX_TASK_TARGET_PROJECT": "nx が task ごとに渡す project の名前。キャッシュの鍵のレーンで値が決まる",
    "NX_TASK_TARGET_TARGET": "NX_TASK_TARGET_PROJECT と同じく、nx が task ごとに渡す target の名前",
    "PECOT_WORKFLOW_SKIP_INSTALL": (
        "test-cli・test-hooks・lint-cli の command が 1 を渡す。PECOTV_SKIP_INSTALL と同じ。"
        "install を nx の別 target に分ける"
    ),
    "PECOTV_TEST": "process.test.ts が子プロセスの env へ渡す値で、外の値は読まれない",
    "PECOTV_PM_GUARD_BEHAVIOR": (
        "install target（cache: false）が pre-push フック経由で渡す。ガード単体の test は"
        "値を自分で env に渡し、source しただけでは読まれない"
    ),
    "PM_GUARD_TIMEOUT": (
        "挙動の確認を打ち切る秒数。値で結果が変わるのは時間切れの失敗だけで、失敗は nx がキャッシュしない。"
        "実行するのは cache: false の install"
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
    "GITHUB_RUN_ID": (
        "review-finish の action が目印に入れる。vitest の useIsolatedEnvironment が外し、review-finish のテストが自分で渡す"
    ),
    "GITHUB_RUN_ATTEMPT": "GITHUB_RUN_ID と同じ",
    "GITHUB_ACTOR": "GITHUB_RUN_ID と同じ",
    "PECOT_REVIEW_TRIGGER_PHRASE": "GITHUB_RUN_ID と同じ",
    "PECOT_AUTO_LABEL": "auto の action が読む。GITHUB_RUN_ID と同じく、useIsolatedEnvironment が外し、テストが自分で渡す",
    "GITHUB_REPOSITORY": "PECOT_AUTO_LABEL と同じ",
    "GITHUB_SERVER_URL": "PECOT_AUTO_LABEL と同じ",
    "GITHUB_EVENT_NAME": "auto-gate の action が読む。GITHUB_RUN_ID と同じく、useIsolatedEnvironment が外し、テストが自分で渡す",
    "GITHUB_EVENT_PATH": "GITHUB_EVENT_NAME と同じ",
    "RUNNER_TEMP": "auto-start の action が読む。GITHUB_RUN_ID と同じく、useIsolatedEnvironment が外し、テストが自分で渡す",
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
    "PECOT_GITHUB_*_TOKEN": (
        "nx の env は 1 つの名前しか取らず、`*` の名前を宣言できない。cli の読みは"
        "useIsolatedEnvironment が外して固定する。秘密の値をハッシュに入れない点も合う"
    ),
    "GITHUB_COM_TOKEN": "PECOT_GITHUB_*_TOKEN と同じ読みの組なので、同じ扱い",
    "PYTEST_CURRENT_TEST": "pytest がテストごとに設定する。添付するかどうかだけを決め、テストの成否を変えない",
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
    """走査する追跡ファイル。プラグインと、ライブラリ（libs/<name>/）と、actions/。"""
    # リポのファイルの一覧はテストの入力で、テスト対象の出力でないので添付しない。
    out = subprocess.run(
        ["git", "ls-files", "plugins", "libs", "actions"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    # interface-spec の fixture のソースは検証にかけるデータで、どのレーンも実行しない。actions の dist は src をまとめた生成物。
    return [
        line
        for line in out.splitlines()
        if "/node_modules/" not in line
        and not line.startswith("libs/interface-spec/tests/fixtures/")
        and not re.match(r"actions/[^/]+/dist/", line)
    ]


# プラグインのディレクトリ名 → そのプラグインのレーンが使う env の namedInput。
_PLUGIN_ENV_INPUT = {
    "pecot-workflow": "pecotPluginEnv",
    "pecot-visual": "pecotvPluginEnv",
}
# プラグインのディレクトリ名 → そのプラグインの test / lint の Globals。
_PLUGIN_GLOBALS = {
    "pecot-workflow": ("pecotPluginTestGlobals",),
    "pecot-visual": ("pecotvPluginTestGlobals", "pecotvPluginLintGlobals"),
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


# プラグインの配布物に同梱し、そのプラグインのレーンが読むライブラリ → プラグインのディレクトリ名。
_BUNDLED_LIBS = {"libs/workflow-core": "pecot-workflow"}


def _plugin_of(rel: str) -> str:
    """ファイルの持ち主。プラグインはディレクトリ名、ライブラリは `libs/<name>`、actions/ は `actions`。同梱するライブラリはプラグイン。"""
    parts = rel.split("/")
    if parts[0] == "plugins":
        return parts[1]
    if parts[0] == "actions":
        return "actions"
    lib = "/".join(parts[:2])
    return _BUNDLED_LIBS.get(lib, lib)


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


@allure.title(
    "環境変数の読み取りは、プラグインの env か共通の env に宣言するか、_EXEMPT に理由を添えて載せる"
)
def test_every_env_read_is_declared_or_exempt(repo_reads: dict[str, set[str]]) -> None:
    """レーンが読むコードと設定から抜き出した環境変数の、宣言のテストです。読む変数がすべて、そのファイルのあるプラグインの `env` か共通の `env` に宣言されているか、`_EXEMPT` に載っていることを確認します。"""
    with allure.step("読まれる環境変数のうち、宣言・免除の無いものを集める"):
        undeclared: dict[str, list[str]] = {}
        for name, files in sorted(repo_reads.items()):
            if name in _EXEMPT:
                continue
            missing = sorted(f for f in files if name not in _declared_for(_plugin_of(f)))
            if missing:
                undeclared[name] = missing[:3]

    with allure.step("宣言・免除の無い変数が無いことを確かめる"):
        assert not undeclared, (
            "次の環境変数が、どこにも宣言されていません。"
            "宣言先は、読むファイルのあるプラグインの env、共通の env、_EXEMPT のどれかです。"
            "プラグインの env は nx.json の pecotPluginEnv / pecotvPluginEnv を指します。"
            "結果を左右するなら、そのプラグインの env へ載せてください。"
            "全レーンに関わるなら、共通の env へ載せてください。"
            "結果を左右しないなら、理由を添えて _EXEMPT へ載せてください:\n"
            + "\n".join(f"  {name}: {files}" for name, files in undeclared.items())
        )


@allure.title("共通の env には、すべてのプラグインが読む変数だけを置く")
def test_common_env_is_only_what_every_plugin_reads(repo_reads: dict[str, set[str]]) -> None:
    """`nx.json` の共通の `env` のテストです。読み取りが見える変数について、一部のプラグインしか読まないものが含まれていないことを確認します。"""
    with allure.step("共通の env の変数ごとに、読むプラグインを集める"):
        narrow = {
            name: sorted({_plugin_of(f) for f in repo_reads[name]} & set(_PLUGIN_ENV_INPUT))
            for name in sorted(_declared_env())
            if name in repo_reads
            and len({_plugin_of(f) for f in repo_reads[name]} & set(_PLUGIN_ENV_INPUT))
            < len(_PLUGIN_ENV_INPUT)
        }

    with allure.step("一部のプラグインしか読まない変数が共通の env に無いことを確かめる"):
        assert not narrow, f"共通の env にあるが、一部のプラグインしか読まない変数: {narrow}"


@allure.title("{plugin} の env に載せた変数は、そのプラグインのファイルに名前が出てくる")
@pytest.mark.parametrize("plugin", sorted(_PLUGIN_ENV_INPUT))
def test_plugin_env_is_mentioned_in_that_plugin(plugin: str) -> None:
    """プラグインの `env` に載せた変数のテストです。すべての変数の名前が、そのプラグインの追跡しているファイルのどこかに出てくることを確認します。"""
    with allure.step("プラグインの env の変数が、そのプラグインのファイルに出てくるか探す"):
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

    with allure.step("どのファイルにも出てこない変数が無いことを確かめる"):
        assert not absent, f"plugins/{plugin} のどのファイルにも出てこない変数: {absent}"


@allure.title(
    "{plugin} のレーンの共通入力は、共通の env とそのプラグインの env を含み、ほかのプラグインの env を含まない"
)
@pytest.mark.parametrize("plugin", sorted(_PLUGIN_ENV_INPUT))
def test_lane_globals_include_common_and_plugin_env(plugin: str) -> None:
    """`nx.json` のレーンの共通入力（`namedInputs`）のテストです。共通の `env` とプラグインの `env` が含まれ、ほかのプラグインの `env` が含まれていないことを確認します。"""
    with allure.step("nx.json を読む"):
        nx_json = json.loads((_REPO_ROOT / "nx.json").read_text(encoding="utf-8"))

    with allure.step("レーンの globals に、共通の env とプラグインの env だけが入ることを確かめる"):
        for globals_name in _PLUGIN_GLOBALS[plugin]:
            entries = [e for e in nx_json["namedInputs"][globals_name] if isinstance(e, str)]
            assert "env" in entries, f"{globals_name} に共通の env が無い"
            assert _PLUGIN_ENV_INPUT[plugin] in entries, f"{globals_name} にプラグインの env が無い"
            others = {v for k, v in _PLUGIN_ENV_INPUT.items() if k != plugin}
            assert not others & set(entries), f"{globals_name} に他プラグインの env が入っている"


@allure.title("libs の追跡ファイルは走査し、宣言済みとみなすのは共通の env だけにする")
def test_library_project_files_are_scanned_against_the_common_env() -> None:
    """`libs/<name>/` のファイルの走査のテストです。`libs/text-rules/index.ts` が走査の対象に含まれ、プラグインに属さないため、宣言済みの扱いが共通の `env` だけになることを確認します。"""
    with allure.step("追跡しているファイルの一覧を得る"):
        files = _tracked_plugin_files()

    with allure.step("libs 配下も走査し、宣言済みとみなすのが共通の env だけであることを確かめる"):
        assert "libs/text-rules/index.ts" in files
        assert _plugin_of("libs/text-rules/index.ts") == "libs/text-rules"
        assert _plugin_of("plugins/pecot-tools/cli/src/a.ts") == "pecot-tools"
        assert _declared_for("libs/text-rules") == _declared_env()


@allure.title("プラグインに同梱するライブラリは、そのプラグインの env で宣言済みとみなす")
def test_bundled_library_is_scanned_against_its_plugin_env() -> None:
    """`libs/workflow-core` の走査のテストです。同梱先の `pecot-workflow` のプラグインに属するものとして扱い、`test-unit` の入力に `pecotPluginEnv` を持つことを確認します。"""
    with allure.step("同梱するライブラリの所属するプラグインを確かめる"):
        assert _plugin_of("libs/workflow-core/src/infra/paths.ts") == "pecot-workflow"

    with allure.step("libs/workflow-core の project.json を読む"):
        project = json.loads(
            (_REPO_ROOT / "libs/workflow-core/project.json").read_text(encoding="utf-8")
        )

    with allure.step("test-unit の入力にプラグインの env があることを確かめる"):
        assert "pecotPluginEnv" in project["targets"]["test-unit"]["inputs"]


@allure.title("_EXEMPT の変数は、現在も読み取りが存在する")
def test_exempt_entries_are_still_read(repo_reads: dict[str, set[str]]) -> None:
    """`_EXEMPT` に載せた変数のテストです。読まれなくなった変数が残っておらず、すべてがどこかで読まれていることを確認します。"""
    with allure.step("読まれていない _EXEMPT の項目を集める"):
        stale = sorted(name for name in _EXEMPT if name not in repo_reads)

    with allure.step("残っている項目が無いことを確かめる"):
        assert not stale, f"_EXEMPT に残っているが、どこからも読まれていない変数: {stale}"


@allure.title("_EXEMPT の変数は、env に宣言済みの変数と重ならない")
def test_exempt_and_declared_do_not_overlap() -> None:
    """`_EXEMPT` と、`env` に宣言した変数のテストです。2 つの集合に共通する変数が存在しないことを確認します。"""
    with allure.step("宣言済みの変数と _EXEMPT の重なりを集める"):
        both = sorted(set(_EXEMPT) & _all_declared_env())

    with allure.step("重なりが無いことを確かめる"):
        assert not both, f"env に宣言済みの変数が _EXEMPT にもある: {both}"


@allure.title("_EXEMPT のすべての変数に、理由を添える")
def test_exempt_reasons_are_not_empty() -> None:
    """`_EXEMPT` の各項目のテストです。すべての変数の理由が、空ではない文字列であることを確認します。"""
    with allure.step("_EXEMPT の理由がすべて空でないことを確かめる"):
        assert all(reason.strip() for reason in _EXEMPT.values())


# --- 検出の仕組み自体を固定する。走査が対象を取りこぼさないことを確かめる ---


@allure.title(
    "走査は、シェル・JSON・TypeScript・Python などの各種のファイルから、宣言されていない変数を見つける"
)
def test_scan_finds_undeclared_variable_in_each_kind_of_file(tmp_path: Path) -> None:
    """環境変数の走査（`scan_env_reads`）のテストです。シェルのスクリプトと `bin`、`package.json`、設定とソースとテストの TypeScript、Python のファイルに書いた 8 つの変数を、すべて検出することを確認します。"""
    with allure.step("種類の違うファイルを書き、宣言の無い変数を走査する"):
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

    with allure.step("すべての変数が見つかることを確かめる"):
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


@allure.title("走査は、ファイル自身が代入した変数を数えない")
def test_scan_ignores_variables_the_file_assigns_itself(tmp_path: Path) -> None:
    """シェルの代入や `vi.stubEnv` など、ファイル自身が環境変数を設定する場合のテストです。外の値を読まないため、検出結果が空になることを確認します。"""
    with allure.step("ファイル自身が代入する変数を読むファイルを書き、走査する"):
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

    with allure.step("何も見つからないことを確かめる"):
        assert scan_env_reads(tmp_path, list(files)) == {}


@allure.title("走査は、コメントの中の変数とシェルの組み込みの変数を数えない")
def test_scan_skips_comments_and_shell_builtins(tmp_path: Path) -> None:
    """コメントの中の変数と、`BASH_SOURCE` や `PWD` のようなシェルの組み込みの変数がある場合のテストです。検出結果が空になることを確認します。"""
    with allure.step("コメントとシェル組み込みの変数だけのスクリプトを書き、走査する"):
        rel = "plugins/p/scripts/ci/run-tests.sh"
        (tmp_path / rel).parent.mkdir(parents=True)
        (tmp_path / rel).write_text(
            '# NODE_V8_COVERAGE=\'\' bash run-tests.sh\nDIR="$(dirname "${BASH_SOURCE[0]}")"\ncd "$PWD"\n',
            encoding="utf-8",
        )

    with allure.step("何も見つからないことを確かめる"):
        assert scan_env_reads(tmp_path, [rel]) == {}


def _write_files(root: Path, files: dict[str, str]) -> list[str]:
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    return list(files)


@allure.title("代入があっても、既定値つきの展開（{operator}）は外の値の読み取りとして数える")
@pytest.mark.parametrize("operator", [":-", "-", ":=", "="])
def test_scan_counts_default_expansion_even_when_the_file_assigns_the_variable(
    tmp_path: Path, operator: str
) -> None:
    """同じ変数に `X=${X:-1}` のような既定値つきの展開を代入するシェルのスクリプトのテストです。代入より先に外の値を読むため、その変数を検出することを確認します。"""
    with allure.step("既定値の展開で代入するスクリプトを書き、走査する"):
        rels = _write_files(
            tmp_path,
            {
                "plugins/p/scripts/ci/run-tests.sh": f'DEFAULTED_SH="${{DEFAULTED_SH{operator}1}}"\necho "$DEFAULTED_SH"\n'
            },
        )

    with allure.step("代入があっても、外の値の読み取りとして数えることを確かめる"):
        assert set(scan_env_reads(tmp_path, rels)) == {"DEFAULTED_SH"}


@allure.title("シェルでは、最初の代入より前の読み取りを、外の値の読み取りとして数える")
def test_scan_counts_shell_reads_before_the_first_assignment(tmp_path: Path) -> None:
    """ファイルの後ろで代入している変数の場合のテストです。代入より前の行で読む `READ_FIRST` は検出し、代入より後で読む `ASSIGNED_FIRST` は検出しないことを確認します。"""
    with allure.step("代入の前に読むスクリプトを書き、走査する"):
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

    with allure.step("最初の代入より前の読み取りだけを数えることを確かめる"):
        assert set(scan_env_reads(tmp_path, rels)) == {"READ_FIRST"}


@allure.title("代入があっても、JavaScript の既定値つきの読み取り（{read} {default}）は数える")
@pytest.mark.parametrize("default", ["??", "||"])
@pytest.mark.parametrize("read", ["process.env.DEFAULTED_JS", "process.env['DEFAULTED_JS']"])
def test_scan_counts_js_default_reads_even_when_the_file_assigns_the_variable(
    tmp_path: Path, default: str, read: str
) -> None:
    """ファイルの中で代入している環境変数を、`??` か `||` で既定値を付けて読む TypeScript のテストです。`process.env.X` と `process.env['X']` のどちらの書き方でも、その変数を検出することを確認します。"""
    with allure.step("代入と既定値つきの読み取りを含む JS を書き、走査する"):
        rels = _write_files(
            tmp_path,
            {
                "plugins/p/cli/src/a.ts": (
                    f"process.env.DEFAULTED_JS = 'x'\nconst v = {read} {default} 'fallback'\n"
                )
            },
        )

    with allure.step("代入があっても、既定値つきの読み取りを数えることを確かめる"):
        assert set(scan_env_reads(tmp_path, rels)) == {"DEFAULTED_JS"}


@allure.title("走査は、tests 配下のシェルは読み、hooks 配下と対象外の場所のシェルは読まない")
def test_scan_reads_shell_under_tests_but_not_under_hooks(tmp_path: Path) -> None:
    """tests 配下、release の tests 配下、hooks 配下、`cli/src` 配下にシェルのスクリプトを置いた場合のテストです。tests 配下の 2 つの変数だけを検出し、hooks 配下と `cli/src` 配下の変数は検出しないことを確認します。"""
    with allure.step("tests・hooks・src の下にシェルを書き、走査する"):
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

    with allure.step("tests 配下だけが走査されることを確かめる"):
        assert set(scan_env_reads(tmp_path, rels)) == {
            "UNDECLARED_TESTS_SH",
            "UNDECLARED_RELEASE_TEST",
        }


@allure.title("名前を定数で渡して読む場合は、interface-env のコメントの名前を数える")
def test_scan_counts_interface_env_names_for_reads_by_a_constant(tmp_path: Path) -> None:
    """TypeScript と Python のファイルに、`interface-env:` のコメントと、定数や変数で名前を渡す読み取りを書く場合のテストです。コメントに書いた 4 つの名前を、同じファイルの `stubEnv` に関わらず、すべて検出することを確認します。"""
    with allure.step("interface-env を添えた読み取りを書き、走査する"):
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

    with allure.step("interface-env の名前で数えることを確かめる"):
        assert set(scan_env_reads(tmp_path, rels)) == {"A", "B", "C", "D"}


@allure.title("interface-env の none と、文字列の中の目印は数えない")
def test_scan_skips_interface_env_none_and_markers_inside_strings(tmp_path: Path) -> None:
    """`interface-env: none` と、行頭ではない文字列の中の `interface-env:` がある場合のテストです。行頭のコメントの `KEPT` だけを検出することを確認します。"""
    with allure.step("interface-env: none と、文字列中の印を含むファイルを書き、走査する"):
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

    with allure.step("文字列中の印と none を数えないことを確かめる"):
        assert set(scan_env_reads(tmp_path, rels)) == {"KEPT"}


@allure.title("interface-env のコメントからは、変数名の形をした語だけを取り出す")
def test_scan_keeps_only_valid_names_in_interface_env(tmp_path: Path) -> None:
    """`interface-env:` のコメントに、ワイルドカードを含む名前と、説明の文字列を書く場合のテストです。`PECOT_GITHUB_*_TOKEN` と `PLAIN_NAME` だけを検出し、説明の語は検出しないことを確認します。"""
    with allure.step("無効な語を含む interface-env を書き、走査する"):
        rels = _write_files(
            tmp_path,
            {
                "plugins/p/cli/src/a.ts": (
                    "/* interface-env: PECOT_GITHUB_*_TOKEN (see foo.bar) PLAIN_NAME */\n"
                ),
            },
        )

    with allure.step("有効な名前だけが残ることを確かめる"):
        assert set(scan_env_reads(tmp_path, rels)) == {"PECOT_GITHUB_*_TOKEN", "PLAIN_NAME"}
