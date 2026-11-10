"""tests/unit/test_architecture.py - CLI 本体の構造規約を AST で確認する

規則 1〜6 は commands/ と core/ の本番コード、規則 7〜8 は tests/ を対象にする
（build/ は走査しない）。

1. core/ は cli.commands を import しない（関数内の遅延 import と相対 import も含む）
2. git の subprocess 呼び出しは core/git.py にしか無い
3. ⚠ を含む文字列を出す echo / print はすべて stderr に出す
4. 100 行超の関数・メソッドが無い
5. ``.pecot`` のパス文字列定数は core/paths.py にしか無い
6. typer / click の内部モジュール（``typer._*`` / ``click._*``）を import しない
7. tests/unit/ は CliRunner（``typer.testing``）を import しない
   （``from typer import testing`` の形も含む。サブディレクトリも走査する）
8. tests/cli/ は ``cli.core`` の関数をコマンド起動なしに呼ばない。
   （例外・データクラス・定数の import と、コマンド起動後の確認・事前状態の用意に使う呼び出しは可）
   名前 import した関数の直接呼び出しのみ対象で、モジュール経由の属性呼び出しは対象外。
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import inspect
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

CLI_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIRS = ("commands", "core")

# --- 2. git subprocess -------------------------------------------------------

# git 呼び出しを持ってよい唯一のモジュール
GIT_MODULE = "core/git.py"
SUBPROCESS_FUNCS = frozenset({"run", "check_output", "check_call", "Popen"})
# git 以外の subprocess 呼び出し（モジュール, 関数名）。新しい呼び出しは理由を書いて足す
NON_GIT_SUBPROCESS_CALLS = frozenset(
    {
        # gh auth token でフォールバック用トークンを取得する
        ("core/github/client.py", "_get_token_from_gh"),
        # worktree-config の setup_command を shell 経由で実行する
        ("core/worktree.py", "_run_setup_command"),
        # .pecot/.gitignore の生成を hook と同じスクリプトに任せる（中身の本体を 1 つに保つ）
        ("core/worktree_links.py", "_ensure_pecot_gitignore"),
        # nx graph で project root と scope の tag を取る（PR タイトルの scope と変更先の比較）
        ("core/nx_scope.py", "nx_projects"),
    }
)

# --- 3. ⚠ の出力先 -------------------------------------------------------------

WARNING_MARK = "⚠"
# 出力関数（呼び出し式の ast.unparse 結果）
ECHO_FUNCS = frozenset({"typer.echo", "typer.secho", "click.echo", "print"})

# --- 4. 関数の行数 --------------------------------------------------------------

MAX_FUNCTION_LINES = 100

# --- 5. .pecot パス文字列 --------------------------------------------------------

# .pecot/ 配下のパス定義を置いてよい唯一のモジュール
PATHS_MODULE = "core/paths.py"
# `.pecot` 単体の出現（`.pecot-active` 等のフラグ名は state.py のファイル名なので対象外）
PECOT_PATH_PATTERN = re.compile(r"\.pecot(?![-\w])")
# 文字列定数を対象にしない代入先（モジュール, 変数名）
PECOT_PATH_EXEMPT_ASSIGNMENTS = frozenset(
    {
        # `.worktreeignore` の既定内容。gitignore パターンとしての `.pecot/` でパス定義ではない
        ("core/worktree_links.py", "DEFAULT_WORKTREEIGNORE_CONTENT"),
    }
)
# 文字列定数を対象にしないキーワード引数（--help の説明文はパス定義ではない）
PECOT_PATH_EXEMPT_KEYWORDS = frozenset({"help"})


# --- 6. typer / click 内部 API ------------------------------------------------

INTERNAL_MODULE_PATTERN = re.compile(r"^(typer|click)\._")

# --- 7〜8. テスト分類 -----------------------------------------------------------

UNIT_TESTS_DIR = "tests/unit"
CLI_TESTS_DIR = "tests/cli"
CLI_RUNNER_MODULE = "typer.testing"
CORE_PACKAGE = "cli.core"


@dataclass(frozen=True)
class SourceFile:
    rel: str
    tree: ast.Module


def _source_files() -> list[SourceFile]:
    files: list[SourceFile] = []
    for d in SOURCE_DIRS:
        for path in sorted((CLI_ROOT / d).rglob("*.py")):
            rel = path.relative_to(CLI_ROOT).as_posix()
            files.append(SourceFile(rel, ast.parse(path.read_text(encoding="utf-8"), rel)))
    return files


SOURCES = _source_files()


def _test_files(test_dir: str) -> list[SourceFile]:
    """tests/ 配下の 1 ディレクトリ（サブディレクトリを含む）のテストモジュール"""
    files: list[SourceFile] = []
    for path in sorted((CLI_ROOT / test_dir).rglob("*.py")):
        rel = path.relative_to(CLI_ROOT).as_posix()
        files.append(SourceFile(rel, ast.parse(path.read_text(encoding="utf-8"), rel)))
    return files


def _imported_modules(tree: ast.Module) -> Iterator[tuple[int, str, list[str]]]:
    """(行番号, モジュール名, import した名前) を列挙する"""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name, []
        elif isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0:
            yield node.lineno, node.module, [alias.name for alias in node.names]


def _functions(tree: ast.AST) -> Iterator[ast.FunctionDef | ast.AsyncFunctionDef]:
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node


def _enclosing_function_names(tree: ast.Module) -> dict[int, str]:
    """各ノード id → それを含む最も内側の関数名"""
    owner: dict[int, str] = {}
    # 外側から順に上書きするため、浅い関数から処理する
    for fn in sorted(_functions(tree), key=lambda f: f.lineno):
        for node in ast.walk(fn):
            owner[id(node)] = fn.name
    return owner


def _docstring_node_ids(tree: ast.Module) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            # 先頭の文字列式（docstring）と、代入直後の文字列式（属性 docstring）
            for i, stmt in enumerate(body):
                is_first = i == 0
                follows_assign = i > 0 and isinstance(body[i - 1], (ast.Assign, ast.AnnAssign))
                if (
                    (is_first or follows_assign)
                    and isinstance(stmt, ast.Expr)
                    and isinstance(stmt.value, ast.Constant)
                    and isinstance(stmt.value.value, str)
                ):
                    ids.add(id(stmt.value))
    return ids


def _subtree_ids(node: ast.AST) -> set[int]:
    return {id(n) for n in ast.walk(node)}


def _str_constants(node: ast.AST) -> Iterator[ast.Constant]:
    for n in ast.walk(node):
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            yield n


# 1. core → commands の逆依存


def _core_import_violations(src: SourceFile) -> list[str]:
    """core/ のファイルが cli.commands を import している箇所（相対 import は絶対名に解決して判定）"""
    if not src.rel.startswith("core/"):
        return []
    package = "cli." + ".".join(Path(src.rel).parent.parts)
    violations: list[str] = []
    for node in ast.walk(src.tree):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            base = importlib.util.resolve_name("." * node.level + (node.module or ""), package)
            # `from cli import commands` / `from .. import commands` は名前まで連結して判定する
            modules = [base, *(f"{base}.{alias.name}" for alias in node.names)]
        else:
            continue
        for module in modules:
            if module == "cli.commands" or module.startswith("cli.commands."):
                violations.append(f"{src.rel}:{node.lineno} imports {module}")
                break
    return violations


def test_core_does_not_import_commands() -> None:
    violations = [v for src in SOURCES for v in _core_import_violations(src)]
    assert violations == []


def test_core_import_rule_detects_every_import_form() -> None:
    def check(rel: str, code: str) -> list[str]:
        return _core_import_violations(SourceFile(rel, ast.parse(code)))

    assert check(
        "core/x.py",
        "from cli.commands.x import y\n"
        "import cli.commands\n"
        "from cli import commands\n"
        "from ..commands._output import Output\n"
        "from .. import commands\n",
    ) == [
        "core/x.py:1 imports cli.commands.x",
        "core/x.py:2 imports cli.commands",
        "core/x.py:3 imports cli.commands",
        "core/x.py:4 imports cli.commands._output",
        "core/x.py:5 imports cli.commands",
    ]
    assert check("core/github/x.py", "from ...commands import x\n") == [
        "core/github/x.py:1 imports cli.commands",
    ]
    assert (
        check(
            "core/x.py",
            "from .repo_resolver import RepoRef\nfrom ..core import x\nfrom . import y\n",
        )
        == []
    )
    assert check("core/github/x.py", "from ..repo_resolver import RepoRef\n") == []
    assert check("commands/x.py", "from ..commands import y\n") == []


# 2. git subprocess は core/git.py のみ


def _is_subprocess_call(node: ast.Call) -> bool:
    func = node.func
    return (
        isinstance(func, ast.Attribute)
        and isinstance(func.value, ast.Name)
        and func.value.id == "subprocess"
        and func.attr in SUBPROCESS_FUNCS
    )


def _starts_with_git(node: ast.AST) -> bool:
    return (
        isinstance(node, (ast.List, ast.Tuple))
        and bool(node.elts)
        and isinstance(node.elts[0], ast.Constant)
        and node.elts[0].value == "git"
    )


def test_git_subprocess_only_in_git_module() -> None:
    violations: list[str] = []
    unlisted: list[str] = []
    for src in SOURCES:
        if src.rel == GIT_MODULE:
            continue
        owners = _enclosing_function_names(src.tree)
        for node in ast.walk(src.tree):
            # 呼び出しを経由しない形（cmd = ["git", ...]）も git 直書きとみなす
            if _starts_with_git(node):
                violations.append(f"{src.rel}:{node.lineno} git command list")
            if isinstance(node, ast.Call) and _is_subprocess_call(node):
                key = (src.rel, owners.get(id(node), "<module>"))
                if key not in NON_GIT_SUBPROCESS_CALLS:
                    unlisted.append(f"{src.rel}:{node.lineno} in {key[1]}")
    assert violations == []
    assert unlisted == []


# 3. ⚠ を含む出力は stderr


def _warning_names(tree: ast.Module) -> set[str]:
    """⚠ を含む文字列を代入された変数名（変数経由の echo を追うため）"""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
            if any(WARNING_MARK in c.value for c in _str_constants(node.value)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names |= {t.id for t in targets if isinstance(t, ast.Name)}
    return names


def _goes_to_stderr(call: ast.Call) -> bool:
    for kw in call.keywords:
        if kw.arg == "err" and isinstance(kw.value, ast.Constant) and kw.value.value is True:
            return True
        if kw.arg == "file" and ast.unparse(kw.value) == "sys.stderr":
            return True
    return False


def test_warning_output_goes_to_stderr() -> None:
    violations: list[str] = []
    for src in SOURCES:
        warning_names = _warning_names(src.tree)
        for node in ast.walk(src.tree):
            if not (isinstance(node, ast.Call) and ast.unparse(node.func) in ECHO_FUNCS):
                continue
            payload = [*node.args, *(kw.value for kw in node.keywords if kw.arg == "message")]
            has_warning = any(
                WARNING_MARK in c.value for arg in payload for c in _str_constants(arg)
            ) or any(
                isinstance(n, ast.Name) and n.id in warning_names
                for arg in payload
                for n in ast.walk(arg)
            )
            if has_warning and not _goes_to_stderr(node):
                violations.append(f"{src.rel}:{node.lineno}")
    assert violations == []


# 4. 関数の行数


def test_no_function_exceeds_line_limit() -> None:
    violations: list[str] = []
    for src in SOURCES:
        for fn in _functions(src.tree):
            assert fn.end_lineno is not None
            length = fn.end_lineno - fn.lineno + 1
            if length > MAX_FUNCTION_LINES:
                violations.append(f"{src.rel}:{fn.lineno} {fn.name} ({length} lines)")
    assert violations == []


# 5. .pecot パス定義は core/paths.py のみ


def _exempt_pecot_ids(src: SourceFile) -> set[int]:
    exempt = _docstring_node_ids(src.tree)
    for node in ast.walk(src.tree):
        if isinstance(node, ast.keyword) and node.arg in PECOT_PATH_EXEMPT_KEYWORDS:
            exempt |= _subtree_ids(node.value)
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                if isinstance(t, ast.Name) and (src.rel, t.id) in PECOT_PATH_EXEMPT_ASSIGNMENTS:
                    exempt |= _subtree_ids(node.value)
    return exempt


def test_pecot_paths_defined_only_in_paths_module() -> None:
    violations: list[str] = []
    for src in SOURCES:
        if src.rel == PATHS_MODULE:
            continue
        exempt = _exempt_pecot_ids(src)
        for const in _str_constants(src.tree):
            if id(const) in exempt:
                continue
            if PECOT_PATH_PATTERN.search(const.value):
                violations.append(f"{src.rel}:{const.lineno} {repr(const.value[:60])}")
    assert violations == []


# 6. typer / click の内部モジュールを import しない


def test_no_typer_or_click_internal_imports() -> None:
    violations: list[str] = []
    for src in SOURCES:
        for lineno, module, names in _imported_modules(src.tree):
            # `from typer import _click` の形も内部 import とみなす
            targets = [module, *(f"{module}.{n}" for n in names if module in ("typer", "click"))]
            if any(INTERNAL_MODULE_PATTERN.match(t) for t in targets):
                violations.append(f"{src.rel}:{lineno} imports {module}")
    assert violations == []


# 7. tests/unit は CliRunner を使わない


def _cli_runner_import_violations(src: SourceFile) -> list[str]:
    violations: list[str] = []
    for lineno, module, names in _imported_modules(src.tree):
        # `from typer import testing` の形も module と名前を連結して判定する（規則 6 と同じ）
        targets = [module, *(f"{module}.{n}" for n in names)]
        if CLI_RUNNER_MODULE in targets or "CliRunner" in names:
            violations.append(f"{src.rel}:{lineno} imports {module}")
    return violations


def test_unit_tests_do_not_import_cli_runner() -> None:
    files = _test_files(UNIT_TESTS_DIR)
    assert files, UNIT_TESTS_DIR
    violations = [v for src in files for v in _cli_runner_import_violations(src)]
    assert violations == []


def test_cli_runner_rule_detects_every_import_form() -> None:
    code = (
        "import typer.testing\n"
        "from typer import testing\n"
        "from typer.testing import CliRunner\n"
        "from typer import Typer\n"
    )
    src = SourceFile("sample.py", ast.parse(code))
    assert _cli_runner_import_violations(src) == [
        "sample.py:1 imports typer.testing",
        "sample.py:2 imports typer",
        "sample.py:3 imports typer.testing",
    ]


# 8. tests/cli は cli.core の関数そのものを検証しない。
# cli テストはコマンドの起動（CliRunner の ``.invoke`` か cli.commands の関数呼び出し）を検証の主体にする。
# 起動後の永続化確認や事前状態の用意に core 関数を使うのは可。
# コマンドを起動せずに core 関数を呼ぶテスト関数は core/ に置く。


def _imported_functions(tree: ast.Module, package: str) -> dict[str, str]:
    """`from <package>... import name` のうち関数に解決される名前 → 完全修飾名"""
    functions: dict[str, str] = {}
    for node in ast.walk(tree):
        if not (isinstance(node, ast.ImportFrom) and node.module and node.level == 0):
            continue
        if not (node.module == package or node.module.startswith(f"{package}.")):
            continue
        module = importlib.import_module(node.module)
        for alias in node.names:
            obj = getattr(module, alias.name, None)
            if inspect.isfunction(obj):
                functions[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    return functions


def _called_names(fn: ast.AST) -> set[str]:
    return {
        node.func.id
        for node in ast.walk(fn)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }


def _invokes_command(fn: ast.AST, command_names: set[str]) -> bool:
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Attribute) and node.func.attr == "invoke":
            return True
        if isinstance(node.func, ast.Name) and node.func.id in command_names:
            return True
    return False


def _command_side_names(tree: ast.Module) -> set[str]:
    """コマンドを起動する名前（cli.commands の関数と、それを経由するモジュール内ヘルパー）"""
    names = set(_imported_functions(tree, "cli.commands"))
    helpers = {
        fn.name: fn
        for fn in tree.body
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef))
        and not fn.name.startswith("test_")
    }
    changed = True
    while changed:
        changed = False
        for name, fn in helpers.items():
            if name not in names and _invokes_command(fn, names):
                names.add(name)
                changed = True
    return names


def _core_test_violations(src: SourceFile) -> list[str]:
    core_functions = _imported_functions(src.tree, CORE_PACKAGE)
    if not core_functions:
        return []
    command_names = _command_side_names(src.tree)
    violations: list[str] = []
    for fn in _functions(src.tree):
        if not fn.name.startswith("test_"):
            continue
        core_calls = _called_names(fn) & core_functions.keys()
        if core_calls and not _invokes_command(fn, command_names):
            called = ", ".join(sorted(core_functions[n] for n in core_calls))
            violations.append(f"{src.rel}:{fn.lineno} {fn.name} calls {called}")
    return violations


def test_cli_tests_do_not_test_core_functions() -> None:
    """名前 import した core 関数の直接呼び出しのみ対象にする。

    モジュール経由の属性呼び出し（``from cli.core import config`` 後の
    ``config.load_config()``）は対象外。
    """
    files = _test_files(CLI_TESTS_DIR)
    assert files, CLI_TESTS_DIR
    violations = [v for src in files for v in _core_test_violations(src)]
    assert violations == []


def test_core_test_rule_detects_direct_core_test() -> None:
    code = (
        "from cli.core.config import load_config\n"
        "from cli.commands.main import app\n"
        "def _run():\n"
        "    return runner.invoke(app, [])\n"
        "def test_direct(p):\n"
        "    assert load_config(p)\n"
        "def test_after_command(p):\n"
        "    _run()\n"
        "    assert load_config(p)\n"
    )
    src = SourceFile("sample.py", ast.parse(code))
    assert _core_test_violations(src) == [
        "sample.py:5 test_direct calls cli.core.config.load_config"
    ]
