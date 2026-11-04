"""skills / agents / hooks / README に書かれた pecot 呼び出しを CLI のコマンド木と比べて確かめる

- 走査対象の pecot 呼び出しのサブコマンドとオプションがコマンド木に存在する。
- w-help の commands.md に木の全 leaf コマンドが載っている
- w-release の release-multi.md が ``project info`` の ``package:`` 行形式を使う
- 検出範囲の境界: クォート付きの語・大文字を含む語はサブコマンドとして扱わない。
"""

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SKILLS_ROOT = PLUGIN_ROOT / "skills"
PECOT_ROOT = PLUGIN_ROOT
COMMANDS_DOC = SKILLS_ROOT / "w-help" / "references" / "commands.md"
RELEASE_MULTI_DOC = SKILLS_ROOT / "w-release" / "references" / "release-multi.md"

sys.path.insert(0, str(PECOT_ROOT))

import typer.main  # noqa: E402

from cli.commands.main import app  # noqa: E402
from cli.commands.project import _info_repository_lines  # noqa: E402
from cli.core.config import Package, ProjectConfig, Repository  # noqa: E402
from cli.core.dependabot import DependabotAlertStatus  # noqa: E402

HELP_OPTION = "--help"
# 区切り記号（パイプ・論理演算・リダイレクト・コメント）以降は別コマンド
SEPARATORS = frozenset({"|", "||", "&&", ";", ">", ">>", "2>&1", "2>", "<<<"})
_TOKEN_RE = re.compile(r'"[^"]*"|\'[^\']*\'|\S+')
_INLINE_CODE_RE = re.compile(r"(?<!`)`([^`\n]+)`(?!`)")
# フェンス行（CommonMark のコードフェンス: ` か ~ の 3 個以上の連続）
_FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
_SUBCOMMAND_RE = re.compile(r"^[a-z][a-z0-9-]*$")
_OPTION_RE = re.compile(r"^--?[A-Za-z]")
# シェル文字列内のエスケープ付きクォートも外す
_QUOTE_CHARS = "\"'`\\"
_LAUNCHERS = frozenset({"$PECOT", "${PECOT}", "pecot"})


@dataclass
class CommandNode:
    options: set[str] = field(default_factory=set)
    # 値を取るオプション（グループ位置で値を読み飛ばすために使う）
    value_options: set[str] = field(default_factory=set)
    children: dict[str, "CommandNode"] = field(default_factory=dict)


def _command_tree() -> CommandNode:
    """Typer アプリから click 互換のコマンド木を取り出す。

    ``typer.main.get_command`` と click の ``commands`` / ``params`` 属性は Typer の公開 API 外にある。
    構造が変わったら、ここで明示的に失敗させる。
    """
    root = typer.main.get_command(app)

    def build(cmd: object, path: str) -> CommandNode:
        params = getattr(cmd, "params", None)
        assert params is not None, (
            f"Typer のコマンド木を取得できない（{path or 'pecot'} に params が無い）。"
            "_command_tree() を更新する"
        )
        node = CommandNode()
        for param in params:
            opts = [*getattr(param, "opts", []), *getattr(param, "secondary_opts", [])]
            for opt in opts:
                if opt.startswith("-"):
                    node.options.add(opt)
                    if not getattr(param, "is_flag", True) and not getattr(param, "count", False):
                        node.value_options.add(opt)
        for name, sub in (getattr(cmd, "commands", None) or {}).items():
            node.children[name] = build(sub, f"{path} {name}".strip())
        return node

    tree = build(root, "")
    assert tree.children, (
        "Typer のコマンド木を取得できない（サブコマンドが取れない）。_command_tree() を更新する"
    )
    return tree


TREE = _command_tree()
ROOT_OPTIONS = TREE.options | {HELP_OPTION}


def _leaf_paths(node: CommandNode, prefix: tuple[str, ...] = ()) -> list[str]:
    if not node.children:
        return [" ".join(prefix)]
    return [p for name, sub in node.children.items() for p in _leaf_paths(sub, (*prefix, name))]


# 文書からの切り出し


def _join_continuations(lines: list[str]) -> list[str]:
    joined: list[str] = []
    buf = ""
    for line in lines:
        stripped = line.rstrip()
        if stripped.endswith("\\"):
            buf += stripped[:-1] + " "
            continue
        joined.append(buf + line)
        buf = ""
    if buf:
        joined.append(buf)
    return joined


def _closes_fence(line: str, opener: str) -> bool:
    """開きフェンスと同じ文字・同じ長さ以上で、後ろに情報文字列の無い行か"""
    match = _FENCE_RE.match(line)
    if match is None:
        return False
    fence, rest = match.groups()
    return fence[0] == opener[0] and len(fence) >= len(opener) and not rest.strip()


def _markdown_snippets(text: str, source: str = "<text>") -> list[str]:
    snippets: list[str] = []
    fenced: list[str] = []
    opener: str | None = None
    opened_at = 0
    for lineno, line in enumerate(text.splitlines(), 1):
        if opener is not None:
            if _closes_fence(line, opener):
                snippets += _join_continuations(fenced)
                fenced = []
                opener = None
            else:
                fenced.append(line)
            continue
        match = _FENCE_RE.match(line)
        # ` のフェンスは情報文字列に ` を含められない（含む行はインラインコード）
        if match and not (match.group(1)[0] == "`" and "`" in match.group(2)):
            opener = match.group(1)
            opened_at = lineno
            continue
        snippets += _INLINE_CODE_RE.findall(line)
    if opener is not None:
        raise AssertionError(f"{source}:{opened_at} のコードフェンス {opener} が閉じていない")
    return snippets


def _shell_snippets(text: str) -> list[str]:
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
    return _join_continuations(lines)


def _snippets(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    return _shell_snippets(text) if path.suffix == ".sh" else _markdown_snippets(text, str(path))


def _bare(token: str) -> str:
    """クォート・コマンド置換の閉じ括弧を外した素のトークン"""
    return token.strip(_QUOTE_CHARS + ")")


def _is_launcher(token: str) -> bool:
    if "=" in token:
        return False
    bare = token.strip(_QUOTE_CHARS)
    if bare.startswith("$("):
        bare = bare[2:].strip(_QUOTE_CHARS)
    return bare in _LAUNCHERS or bare == "bin/pecot" or bare.endswith("/bin/pecot")


def _invocations(snippet: str) -> list[list[str]]:
    """スニペット中の pecot 呼び出しごとの引数トークン列"""
    tokens = _TOKEN_RE.findall(snippet)
    calls: list[list[str]] = []
    for i, token in enumerate(tokens):
        if not _is_launcher(token):
            continue
        args: list[str] = []
        for arg in tokens[i + 1 :]:
            if arg in SEPARATORS or arg.startswith("#") or arg.endswith(";"):
                break
            args.append(arg)
            if arg.endswith(")") or arg.endswith("`"):
                break
        calls.append(args)
    return calls


# 検証


def _check_invocation(args: list[str]) -> str | None:
    """不正なら理由を返す"""
    node = TREE
    path: list[str] = []
    skip_value = False
    for raw in args:
        if skip_value:
            skip_value = False
            continue
        token = _bare(raw)
        if _OPTION_RE.match(raw):
            option = raw.split("=", 1)[0]
            if option not in node.options and option not in ROOT_OPTIONS:
                return f"`{' '.join(['pecot', *path])}` に無いオプション {option}"
            if node.children and option in node.value_options and "=" not in raw:
                skip_value = True
            continue
        if not node.children:
            # leaf 以降は位置引数とオプション値
            continue
        if token in node.children:
            node = node.children[token]
            path.append(token)
            continue
        if _SUBCOMMAND_RE.match(token) and raw == token:
            return f"`{' '.join(['pecot', *path])}` に無いサブコマンド {token}"
        # プレースホルダ・位置引数・非コマンド文脈
        return None
    return None


def find_invalid_references(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        for snippet in _snippets(path):
            for args in _invocations(snippet):
                reason = _check_invocation(args)
                if reason:
                    errors.append(f"{path}: {reason}: {snippet.strip()[:120]}")
    return errors


def _scan_targets() -> list[Path]:
    hooks = PECOT_ROOT / "hooks"
    targets = [
        *sorted(SKILLS_ROOT.rglob("*.md")),
        *sorted((PECOT_ROOT / "agents").glob("*.md")),
        *sorted(p for p in hooks.rglob("*.sh") if "tests" not in p.relative_to(hooks).parts),
        *sorted((hooks / "templates").glob("*.md")),
        PECOT_ROOT / "README.md",
    ]
    return targets


def test_scan_targets_exist() -> None:
    targets = _scan_targets()
    assert any(p.suffix == ".sh" for p in targets)
    assert any(p.name == "SKILL.md" for p in targets)
    assert all(p.is_file() for p in targets)


def test_pecot_invocations_match_command_tree() -> None:
    assert find_invalid_references(_scan_targets()) == []


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("$PECOT issue nonexistent -r owner/repo", "に無いサブコマンド nonexistent"),
        ("$PECOT issue read owner/repo/1 --no-such-option", "に無いオプション --no-such-option"),
        ('"${CLAUDE_PLUGIN_ROOT}/bin/pecot" bogus', "に無いサブコマンド bogus"),
        ("$PECOT --repo owner/repo nosuch", "に無いサブコマンド nosuch"),
    ],
)
def test_invalid_reference_is_detected(tmp_path: Path, line: str, expected: str) -> None:
    doc = tmp_path / "SKILL.md"
    doc.write_text(f"# sample\n\n```bash\n{line}\n```\n", encoding="utf-8")
    errors = find_invalid_references([doc])
    assert len(errors) == 1
    assert expected in errors[0]


def test_valid_reference_forms_pass(tmp_path: Path) -> None:
    doc = tmp_path / "SKILL.md"
    doc.write_text(
        "`pecot` の説明。`pecot CLI` を使う。`$PECOT issue create --type=task` も可。\n\n"
        "```bash\n"
        '$PECOT --repo owner/repo issue comment -i owner/repo/1 -t plan -m "x" \\\n'
        "  --prepare | head\n"
        "STATUS=$($PECOT session status -D .)\n"
        "$PECOT <command> --help\n"
        "```\n",
        encoding="utf-8",
    )
    assert find_invalid_references([doc]) == []


@pytest.mark.parametrize(
    "line",
    [
        # クォート付きの語はプレースホルダ・位置引数とみなし、サブコマンドとして扱わない
        '$PECOT issue "nosuch"',
        # 大文字を含む語はサブコマンド名の形でないため、プレースホルダとみなす
        "$PECOT issue NoSuch",
    ],
)
def test_quoted_or_capitalized_unknown_word_is_not_checked(tmp_path: Path, line: str) -> None:
    """検出範囲の境界: クォート付き・大文字を含む未知語はサブコマンドとして検出しない"""
    doc = tmp_path / "SKILL.md"
    doc.write_text(f"```bash\n{line}\n```\n", encoding="utf-8")
    assert find_invalid_references([doc]) == []


def test_fence_closes_only_with_same_char_and_enough_length() -> None:
    text = (
        "````markdown\n"
        "```bash\n"
        "$PECOT issue nosuch\n"
        "```\n"
        "````\n"
        "~~~\n"
        "```\n"
        "$PECOT pr create\n"
        "~~~~\n"
        "`$PECOT issue read`\n"
    )
    assert _markdown_snippets(text) == [
        "```bash",
        "$PECOT issue nosuch",
        "```",
        "```",
        "$PECOT pr create",
        "$PECOT issue read",
    ]


@pytest.mark.parametrize(
    "text",
    [
        "```bash\n$PECOT issue read\n",
        "````\n$PECOT issue read\n```\n",
        "```\n$PECOT issue read\n~~~\n",
        "```bash\n$PECOT issue read\n```bash\n",
    ],
)
def test_unclosed_fence_fails(text: str) -> None:
    with pytest.raises(AssertionError, match="sample.md:1 のコードフェンス"):
        _markdown_snippets(text, "sample.md")


# commands.md の網羅


def test_commands_doc_lists_every_leaf_command() -> None:
    text = COMMANDS_DOC.read_text(encoding="utf-8")
    missing = [path for path in _leaf_paths(TREE) if f"`{path}`" not in text]
    assert missing == []


# release-multi.md の project info 出力形式


_NO_ALERTS = DependabotAlertStatus(
    enabled=False,
    open_count=0,
    max_severity=None,
    alerts_url="https://example.invalid/owner/repo/security/dependabot",
)


def _project_info_package_line(name: str, changelog: str) -> str:
    """package 設定付きのリポ 1 件で ``project info`` が出す ``package`` 行（前後空白除去）"""
    repo = Repository(
        owner="owner", name="repo", packages=[Package(name=name, changelog=changelog)]
    )
    # 出力に使うのは repositories だけなので、他のフィールドは検証なしで省く
    config = ProjectConfig.model_construct(repositories=[repo])
    lines = [line.strip() for line in _info_repository_lines(config, {repo.full_name: _NO_ALERTS})]
    package_lines = [line for line in lines if line.startswith("package")]
    assert len(package_lines) == 1, lines
    return package_lines[0]


def test_release_multi_uses_project_info_package_line() -> None:
    # release-multi.md は `package: NAME → CHANGELOG パス` の形で出力行を説明している
    line = _project_info_package_line("NAME", "CHANGELOG パス")
    assert line.startswith("package: ")
    text = RELEASE_MULTI_DOC.read_text(encoding="utf-8")
    assert f"`{line}`" in text
    assert "packages:" not in text
    assert "packages[" not in text
