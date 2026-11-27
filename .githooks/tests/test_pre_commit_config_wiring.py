"""`.pre-commit-config.yaml` の所要記録の配線テスト（#1083）。

自前 hook は with-timing.sh で包んで所要を記録する。成功時の合計行を端末へ出すため
`verbose: true` は nx-affected-tests だけに付ける。
スクリプト単体テストでは守れない配線のため、リポ実体の config を読んで pin する。
yaml パーサに依存しない切り出しは test_check_release_group_changelog.py と同方式。
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import allure
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import run_attached  # noqa: E402

_WRAPPED_HOOKS = [
    "check-text",
    "check-text-push",
    "check-commit-text",
    "nx-affected-lint",
    "check-version-plan-required",
    "nx-env-inputs",
    "nx-affected-tests",
    "plugin-validate",
]


def _hook_entry_lines(config_text: str, hook_id: str) -> list[str]:
    """`- id: <hook_id>` から次の同インデント `- id:` までを切り出す。"""
    lines = config_text.splitlines()
    start = next(
        (i for i, line in enumerate(lines) if line.strip() == f"- id: {hook_id}"),
        None,
    )
    assert start is not None, f"{hook_id} のエントリが .pre-commit-config.yaml に無い"
    indent = len(lines[start]) - len(lines[start].lstrip())
    block = [lines[start]]
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if stripped.startswith("- id:") and len(line) - len(line.lstrip()) <= indent:
            break
        block.append(line)
    return block


def _config_text(script_dir: Path) -> str:
    return (script_dir.parents[1] / ".pre-commit-config.yaml").read_text()


def _hook_ids(config_text: str) -> list[str]:
    return [
        line.strip().removeprefix("- id:").strip()
        for line in config_text.splitlines()
        if line.strip().startswith("- id:")
    ]


@allure.title("hook {hook_id} の entry は、with-timing.sh で元のスクリプトを包んでいる")
@pytest.mark.parametrize("hook_id", _WRAPPED_HOOKS)
def test_entry_wrapped_with_timing(script_dir: Path, hook_id: str) -> None:
    """`.pre-commit-config.yaml` の自前 hook の `entry` のテストです。`with-timing.sh` の後ろに自分の hook id と元のスクリプトが並び、元のスクリプトがリポジトリに実在することを確認します。"""
    with allure.step("hook の entry を .pre-commit-config.yaml から取り出す"):
        block = _hook_entry_lines(_config_text(script_dir), hook_id)
        entries = [line.strip() for line in block if line.strip().startswith("entry:")]
    with allure.step("with-timing.sh で包まれ、元の script が実在することを確かめる"):
        assert len(entries) == 1
        entry = entries[0].removeprefix("entry:").strip()
        prefix = f".githooks/lib/with-timing.sh {hook_id} "
        assert entry.startswith(prefix)
        wrapped = entry[len(prefix) :].split()[0]
        assert (script_dir.parents[1] / wrapped).is_file()


@allure.title("`verbose: true` は、成功時にも行を出力する nx-affected-tests にだけ指定する")
def test_verbose_only_on_hooks_that_print_a_success_line(script_dir: Path) -> None:
    """`.pre-commit-config.yaml` の `verbose: true` のテストです。この指定を持つ hook が `nx-affected-tests` の 1 つだけであることを確認します。"""
    with allure.step("verbose: true を持つ hook を集める"):
        text = _config_text(script_dir)
        verbose = [
            hook_id
            for hook_id in _hook_ids(text)
            if "verbose: true" in [line.strip() for line in _hook_entry_lines(text, hook_id)]
        ]
    with allure.step("nx-affected-tests だけであることを確かめる"):
        assert verbose == ["nx-affected-tests"]


def _hook_files_pattern(script_dir: Path, hook_id: str) -> re.Pattern[str]:
    block = _hook_entry_lines(_config_text(script_dir), hook_id)
    patterns = [line.strip() for line in block if line.strip().startswith("files:")]
    assert len(patterns) == 1, f"{hook_id} に files: が 1 つだけ必要"
    return re.compile(patterns[0].removeprefix("files:").strip())


@allure.title("{changed_path} を変更すると、nx-env-inputs が起動する")
@pytest.mark.parametrize(
    "changed_path",
    [
        # 宣言の抜けを探す静的解析（test_nx_env_inputs.py）が探す範囲と、その解析が読む nx.json。
        # ここが外れると、未宣言の環境変数を足しただけの push で解析が起動しない。
        # その結果、キャッシュの誤再利用に気づけなくなる (#1225)。
        "plugins/pecot-tools/scripts/ci/run-tests.sh",
        "plugins/pecot-tools/scripts/ci/install.sh",
        "plugins/pecot-visual/scripts/ci/run-lint.sh",
        "plugins/pecot-visual/scripts/ci/check-pm-guard.sh",
        "plugins/pecot-visual/scripts/ci/pnpm-lib.sh",
        "plugins/pecot-visual/cli/package.json",
        "plugins/pecot-visual/package.json",
        "plugins/pecot-visual/cli/vitest.config.ts",
        "plugins/pecot-visual/cli/vitest.e2e.config.ts",
        "plugins/pecot-visual/cli/src/infra/drawio/pdf.ts",
        "plugins/pecot-visual/cli/tests/e2e/mcp-tools.test.ts",
        "plugins/pecot-visual/scripts/pptx-compare/lib/cli-dist.mjs",
        "plugins/pecot-visual/scripts/pptx-compare/tests/compare-pptx.bats",
        "plugins/pecot-workflow/cli/src/cli.ts",
        "plugins/pecot-workflow/cli/tests/hooks/_helpers/run.ts",
        "nx.json",
        # libs/<name>/ のライブラリも同じ走査範囲に入れる。
        "libs/text-rules/index.ts",
        "libs/text-rules/bin/pecot-text-lint.ts",
        "libs/text-rules/tests/bin.test.ts",
        "libs/text-rules/vitest.config.ts",
        "libs/text-rules/package.json",
    ],
)
def test_nx_env_inputs_runs_when_env_scan_inputs_change(
    script_dir: Path, changed_path: str
) -> None:
    """環境変数の宣言の抜けを調べる hook の `files` のテストです。調べる範囲のファイルと `nx.json` が、`nx-env-inputs` の `files` の正規表現に一致することを確認します。"""
    with allure.step("nx-env-inputs の files の正規表現を読む"):
        pattern = _hook_files_pattern(script_dir, "nx-env-inputs")
    with allure.step("変更したパスに一致することを確かめる"):
        assert pattern.search(changed_path), (
            f"nx-env-inputs の files が {changed_path} に一致しない"
        )


@allure.title("{changed_path} を変更しても、nx-env-inputs は起動しない")
@pytest.mark.parametrize(
    "changed_path",
    [
        "README.md",
        "plugins/pecot-workflow/skills/w-pr/SKILL.md",
        "plugins/pecot-visual/CHANGELOG.md",
        "libs/text-rules/CHANGELOG.md",
        "libs/text-rules/package-lock.json",
    ],
)
def test_nx_env_inputs_skips_unrelated_paths(script_dir: Path, changed_path: str) -> None:
    """環境変数の宣言の抜けを調べる hook の `files` のテストです。README や CHANGELOG などの無関係なファイルが、`nx-env-inputs` の `files` の正規表現に一致しないことを確認します。"""
    with allure.step("nx-env-inputs の files の正規表現を読む"):
        pattern = _hook_files_pattern(script_dir, "nx-env-inputs")
    with allure.step("関係の無いパスに一致しないことを確かめる"):
        assert not pattern.search(changed_path)


@allure.title("{changed_path} を変更すると、plugin-validate が起動する")
@pytest.mark.parametrize(
    "changed_path",
    [
        ".claude-plugin/marketplace.json",
        ".github/plugin/marketplace.json",
        "plugins/pecot-workflow/.claude-plugin/plugin.json",
        "plugins/pecot-visual/.github/plugin/plugin.json",
        "plugins/pecot-workflow/hooks/hooks.json",
        "plugins/pecot-tools/.mcp.json",
        "plugins/pecot-workflow/skills/w-pr/SKILL.md",
        "plugins/pecot-visual/skills/v-drawio/SKILL.md",
        "plugins/pecot-visual/agents/v-diagram-creator.md",
    ],
)
def test_plugin_validate_runs_when_definitions_change(script_dir: Path, changed_path: str) -> None:
    """プラグインの定義を検証する hook の `files` のテストです。マーケットプレイスやプラグインの定義、スキルとエージェントのファイルが、`plugin-validate` の `files` の正規表現に一致することを確認します。"""
    with allure.step("plugin-validate の files の正規表現を読む"):
        pattern = _hook_files_pattern(script_dir, "plugin-validate")
    with allure.step("変更したパスに一致することを確かめる"):
        assert pattern.search(changed_path), (
            f"plugin-validate の files が {changed_path} に一致しない"
        )


@allure.title("{changed_path} を変更しても、plugin-validate は起動しない")
@pytest.mark.parametrize(
    "changed_path",
    [
        "plugins/pecot-workflow/project.json",
        "plugins/pecot-workflow/scripts/ci/tests/test_x.py",
        "README.md",
    ],
)
def test_plugin_validate_skips_unrelated_paths(script_dir: Path, changed_path: str) -> None:
    """プラグインの定義を検証する hook の `files` のテストです。`project.json` や README などの定義ではないファイルが、`plugin-validate` の `files` の正規表現に一致しないことを確認します。"""
    with allure.step("plugin-validate の files の正規表現を読む"):
        pattern = _hook_files_pattern(script_dir, "plugin-validate")
    with allure.step("関係の無いパスに一致しないことを確かめる"):
        assert not pattern.search(changed_path), (
            f"plugin-validate の files が {changed_path} に一致する"
        )


_TEXT_FILES_HOOK = "check-text"
_LONG_SENTENCE = "あ" * 101 + "。"


@allure.title("{changed_path} を変更すると、check-text が起動する")
@pytest.mark.parametrize(
    "changed_path",
    [
        "README.md",
        "plugins/pecot-workflow/cli/src/cli.ts",
        ".githooks/pre-commit/check-text.sh",
        "nx.json",
        "plugins/pecot-workflow/hooks/hooks.json",
        "libs/text-rules/package-lock.json",
        "plugins/pecot-visual/scripts/page-compare/tests/compare-pages.bats",
    ],
)
def test_check_text_runs_for_text_sources(script_dir: Path, changed_path: str) -> None:
    """文章の規則を検証する hook の `files` のテストです。Markdown やソースコード、設定ファイルのパスが、`check-text` の `files` の正規表現に一致することを確認します。"""
    with allure.step("check-text の files の正規表現を読む"):
        pattern = _hook_files_pattern(script_dir, _TEXT_FILES_HOOK)
    with allure.step("文章の元のファイルに一致することを確かめる"):
        assert pattern.search(changed_path), f"check-text の files が {changed_path} に一致しない"


@allure.title("{changed_path} を変更しても、check-text は起動しない")
@pytest.mark.parametrize("changed_path", [".yamllint", "docs/index.html"])
def test_check_text_skips_other_files(script_dir: Path, changed_path: str) -> None:
    """文章の規則を検証する hook の `files` のテストです。対象外の拡張子や場所のファイルが、`check-text` の `files` の正規表現に一致しないことを確認します。"""
    with allure.step("check-text の files の正規表現を読む"):
        pattern = _hook_files_pattern(script_dir, _TEXT_FILES_HOOK)
    with allure.step("文章でないファイルに一致しないことを確かめる"):
        assert not pattern.search(changed_path), f"check-text の files が {changed_path} に一致する"


# .textlintignore で外すファイルと、外さない手書きのファイル。
_IGNORED_TEXT_PATHS = [
    "plugins/pecot-visual/CHANGELOG.md",
    "plugins/pecot-workflow/cli/tests/parity/golden/pr-create-ok.json",
    "libs/workflow-core/tests/python-output/sections.json",
    ".nx/nx-release/tests/_fixtures/dependabot-real.json",
    ".specify/templates/spec-template.md",
    ".claude/skills/speckit-plan/SKILL.md",
    ".claude/skills/speckit-notes.md",
    ".claude/rules/aws-agent-rules.md",
    "specs/026-pre-merge-test-env/spec.md",
]
_KEPT_TEXT_PATHS = [
    "README.md",
    "plugins/pecot-workflow/docs-guide.md",
    "plugins/pecot-workflow/cli/tests/parity/run.ts",
    "plugins/pecot-workflow/cli/src/python-output/x.ts",
    ".nx/nx-release/tests/dependabot-plans.test.mjs",
    "plugins/pecot-workflow/specs/x.md",
]


def _lint_with_textlintignore(
    script_dir: Path, tmp_path: Path, paths: list[str]
) -> subprocess.CompletedProcess:
    """実物の .textlintignore を置いた一時ディレクトリで、違反を書いた paths を bin に渡す。"""
    root = script_dir.parents[1]
    shutil.copyfile(root / ".textlintignore", tmp_path / ".textlintignore")
    for rel in paths:
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        # .md 以外も、コメントと文字列を見る plugin が読む形にする
        target.write_text(
            f"# {_LONG_SENTENCE}\n" if target.suffix == ".md" else f'"{_LONG_SENTENCE}"\n'
        )
    return run_attached(
        ["node", str(root / "libs/text-rules/dist/bin/pecot-text-lint.js"), *paths],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )


@allure.title("`.textlintignore` に載せたパスは、文章の検証から除外する")
def test_check_text_skips_textlintignore_paths(script_dir: Path, tmp_path: Path) -> None:
    """実物の `.textlintignore` を置いた一時ディレクトリで、除外対象のファイルに長すぎる文を書いて検証する場合のテストです。終了コードが 0 になり、何も出力されないことを確認します。"""
    with allure.step("除外するパスに違反を書き、.textlintignore を置いて text-lint を動かす"):
        result = _lint_with_textlintignore(script_dir, tmp_path, _IGNORED_TEXT_PATHS)
    with allure.step("違反が 1 件も出ないことを確かめる"):
        assert (result.returncode, result.stdout) == (0, ""), result.stdout + result.stderr


@allure.title("手書きのファイルは、文章の検証から除外しない")
def test_check_text_keeps_hand_written_files(script_dir: Path, tmp_path: Path) -> None:
    """実物の `.textlintignore` を置いた一時ディレクトリで、手書きのファイルに長すぎる文を書いて検証する場合のテストです。終了コードが 1 になり、すべてのファイルが違反として報告されることを確認します。"""
    with allure.step("手書きのパスに違反を書き、.textlintignore を置いて text-lint を動かす"):
        result = _lint_with_textlintignore(script_dir, tmp_path, _KEPT_TEXT_PATHS)
    with allure.step("すべてのパスで違反が出ることを確かめる"):
        assert result.returncode == 1, result.stderr
        reported = {line.split(":", 1)[0] for line in result.stdout.splitlines()}
        assert reported == set(_KEPT_TEXT_PATHS)


@allure.title("check-text には、`.textlintignore` と重複する exclude を指定しない")
def test_check_text_has_no_exclude(script_dir: Path) -> None:
    """`check-text` の hook の定義に `exclude:` が存在しないことを確認するテストです。除外の一覧は `.textlintignore` の 1 か所に置きます。"""
    with allure.step("check-text の設定の行を取り出す"):
        block = _hook_entry_lines(_config_text(script_dir), _TEXT_FILES_HOOK)
    with allure.step("exclude: が無いことを確かめる"):
        assert not [line for line in block if line.strip().startswith("exclude:")]


@allure.title(
    "check-text は pre-commit の stage だけで動き、fail_fast と require_serial を指定する"
)
def test_check_text_stages_and_flags(script_dir: Path) -> None:
    """`check-text` の hook の定義のテストです。`stages` が `pre-commit` だけで、`fail_fast: true` と `require_serial: true` が指定されていることを確認します。"""
    with allure.step("check-text の設定の行を取り出す"):
        block = [line.strip() for line in _hook_entry_lines(_config_text(script_dir), "check-text")]
    with allure.step("stages・fail_fast・require_serial を確かめる"):
        assert "stages: [pre-commit]" in block
        assert "fail_fast: true" in block
        assert "require_serial: true" in block


@allure.title("check-text-push は pre-push の stage で常に実行し、ファイル名を渡さない")
def test_check_text_push_stage_and_flags(script_dir: Path) -> None:
    """`check-text-push` の hook の定義のテストです。`stages` が `pre-push`、`always_run` と `fail_fast` が `true`、`pass_filenames` が `false` であることを確認します。"""
    with allure.step("check-text-push の設定の行を取り出す"):
        block = [
            line.strip() for line in _hook_entry_lines(_config_text(script_dir), "check-text-push")
        ]
    with allure.step("stages・always_run・pass_filenames・fail_fast を確かめる"):
        assert "stages: [pre-push]" in block
        assert "always_run: true" in block
        assert "pass_filenames: false" in block
        assert "fail_fast: true" in block


def _script_regex(script_dir: Path, name: str) -> str:
    text = (script_dir.parent / "pre-push" / "check-text-push.sh").read_text()
    matches = re.findall(rf"^{name}='(.*)'$", text, flags=re.MULTILINE)
    assert len(matches) == 1, f"check-text-push.sh に {name} が 1 行だけ必要"
    return matches[0]


@allure.title("check-text-push.sh の対象判定は、check-text の files と一致する")
def test_check_text_push_regexes_match_config(script_dir: Path) -> None:
    """`check-text-push.sh` の `TEXT_FILES_RE` のテストです。この正規表現が、`.pre-commit-config.yaml` の `check-text` の `files` と同じ文字列であることを確認します。"""
    with allure.step("check-text の files の正規表現を読む"):
        files = _hook_files_pattern(script_dir, _TEXT_FILES_HOOK).pattern
    with allure.step("check-text-push.sh の正規表現と同じことを確かめる"):
        assert _script_regex(script_dir, "TEXT_FILES_RE") == files


@allure.title("check-commit-text は commit-msg の stage で常に実行する")
def test_check_commit_text_stage_and_always_run(script_dir: Path) -> None:
    """`check-commit-text` の hook の定義のテストです。コミットメッセージは `files` の対象にならないため、`stages` が `commit-msg` で、`always_run` が `true` であることを確認します。"""
    with allure.step("check-commit-text の設定の行を取り出す"):
        block = [
            line.strip()
            for line in _hook_entry_lines(_config_text(script_dir), "check-commit-text")
        ]
    with allure.step("stages と always_run を確かめる"):
        assert "stages: [commit-msg]" in block
        assert "always_run: true" in block


@allure.title("check-text は、重い nx-affected-lint より前に実行する順序で定義する")
def test_check_text_runs_before_heavy_hooks(script_dir: Path) -> None:
    """`.pre-commit-config.yaml` の hook の並びのテストです。`check-text` が `nx-affected-lint` より前に定義されていることを確認します。"""
    with allure.step("hook の並びを読む"):
        ids = _hook_ids(_config_text(script_dir))
    with allure.step("check-text が nx-affected-lint より前にあることを確かめる"):
        assert ids.index("check-text") < ids.index("nx-affected-lint")


@allure.title("check-text-push は、check-version-plan-required より前に実行する順序で定義する")
def test_check_text_push_runs_before_heavy_hooks(script_dir: Path) -> None:
    """`.pre-commit-config.yaml` の hook の並びのテストです。`check-text-push` が `check-version-plan-required` より前に定義されていることを確認します。"""
    with allure.step("hook の並びを読む"):
        ids = _hook_ids(_config_text(script_dir))
    with allure.step("check-text-push が check-version-plan-required より前にあることを確かめる"):
        assert ids.index("check-text-push") < ids.index("check-version-plan-required")


@allure.title("Pages の公開ビルドの hook と、docs/ を除外する設定は存在しない")
def test_pages_build_hook_is_removed(script_dir: Path) -> None:
    """`.pre-commit-config.yaml` のテストです。`build-pages-slides` の hook と `^docs/` の設定が、どちらも存在しないことを確認します。"""
    with allure.step("設定の本文を読む"):
        text = _config_text(script_dir)
    with allure.step("Pages のビルドの hook も docs/ の除外も無いことを確かめる"):
        assert "build-pages-slides" not in _hook_ids(text)
        assert "^docs/" not in text


@allure.title("旧 check-pecotv-skill-frontmatter の hook は存在しない")
def test_pecotv_skill_frontmatter_hook_is_replaced(script_dir: Path) -> None:
    """`check-pecotv-skill-frontmatter` が `plugin-validate` に統合された後の、`.pre-commit-config.yaml` のテストです。旧 hook の id が存在しないことを確認します。"""
    with allure.step("旧 check-pecotv-skill-frontmatter が残っていないことを確かめる"):
        assert "check-pecotv-skill-frontmatter" not in _hook_ids(_config_text(script_dir))


@allure.title("local hook の language は新しい表記で、pre-commit の下限もそれ以上に固定する")
def test_local_hooks_use_unsupported_languages(script_dir: Path) -> None:
    """`repo: local` の hook の `language` のテストです。値が `unsupported` と `unsupported_script` のいずれかで、`minimum_pre_commit_version` が 4.4.0 以上であることを確認します。"""
    with allure.step("local の hook の language と最低版を読む"):
        text = _config_text(script_dir)
        local_part = text.split("  - repo: https://", 1)[0]
        languages = re.findall(r"^\s+language:\s*(\S+)", local_part, flags=re.MULTILINE)
    with allure.step("language が新表記で、最低版が 4.4.0 以上であることを確かめる"):
        assert languages
        assert set(languages) <= {"unsupported", "unsupported_script"}
        match = re.search(r'^minimum_pre_commit_version:\s*"?([\d.]+)"?', text, flags=re.MULTILINE)
        assert match, "minimum_pre_commit_version が無い"
        assert tuple(int(p) for p in match.group(1).split(".")) >= (4, 4, 0)


# --- 置き場のディレクトリと stages の一致（#64） ---
#
# hook の実体が `pre-commit/`・`commit-msg/`・`pre-push/` の直下にあるとき、
# そのディレクトリ名がその hook の stages と一致する。
# `.githooks/ci/` 直下に実体がある hook は manual で動く。

_STAGE_DIRS = ("pre-commit", "commit-msg", "pre-push")


def _local_hook_blocks(config_text: str) -> dict[str, list[str]]:
    """`repo: local` の hook を id ごとに切り出す。"""
    lines = config_text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == "- repo: local")
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("- repo:")),
        len(lines),
    )
    section = lines[start + 1 : end]
    blocks: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in section:
        stripped = line.strip()
        if stripped.startswith("- id:"):
            current = blocks.setdefault(stripped.removeprefix("- id:").strip(), [])
        if current is not None:
            current.append(line)
    return blocks


def _entry_script(block: list[str]) -> str | None:
    """entry から実体の script を取り出す。entry が無ければ None。"""
    entries = [line.strip() for line in block if line.strip().startswith("entry:")]
    if not entries:
        return None
    assert len(entries) == 1
    words = entries[0].removeprefix("entry:").strip().split()
    if Path(words[0]).name == "with-timing.sh":
        return words[2]
    if words[0] in ("bash", "node"):
        return words[1]
    return words[0]


def _stages(block: list[str]) -> list[str] | None:
    for line in block:
        stripped = line.strip()
        if stripped.startswith("stages:"):
            value = stripped.removeprefix("stages:").strip().strip("[]")
            return [item.strip() for item in value.split(",") if item.strip()]
    return None


def _local_scripts(script_dir: Path) -> dict[str, str]:
    blocks = _local_hook_blocks(_config_text(script_dir))
    return {
        hook_id: script
        for hook_id, block in blocks.items()
        if (script := _entry_script(block)) is not None
    }


@allure.title("local hook は、すべて stages を指定する")
def test_local_hooks_declare_stages(script_dir: Path) -> None:
    """`repo: local` の hook のテストです。`stages` を指定していない hook が 1 つも存在しないことを確認します。"""
    with allure.step("local の hook を切り出し、stages の無いものを集める"):
        blocks = _local_hook_blocks(_config_text(script_dir))
        missing = [hook_id for hook_id, block in blocks.items() if _stages(block) is None]
    with allure.step("stages の無い hook が無いことを確かめる"):
        assert missing == []


@allure.title("local hook の entry のスクリプトは、すべて実在する")
def test_local_hook_entry_scripts_exist(script_dir: Path) -> None:
    """`repo: local` の hook の `entry` のテストです。参照するスクリプトがリポジトリに存在しない hook が 1 つも存在しないことを確認します。"""
    with allure.step("local の hook の entry の実体を集め、無いものを挙げる"):
        root = script_dir.parents[1]
        missing = [
            f"{hook_id}: {script}"
            for hook_id, script in _local_scripts(script_dir).items()
            if not (root / script).is_file()
        ]
    with allure.step("実体の無い hook が無いことを確かめる"):
        assert missing == []


@allure.title("stage 名のディレクトリ直下のスクリプトを使う hook は、その stage だけで動く")
def test_stage_dir_matches_stages(script_dir: Path) -> None:
    """`pre-commit`・`commit-msg`・`pre-push` の直下にスクリプトを置く hook のテストです。`stages` がディレクトリ名と同じ 1 つだけであることを確認します。"""
    with allure.step("stage の置き場の hook の stages を集め、置き場と合わないものを挙げる"):
        blocks = _local_hook_blocks(_config_text(script_dir))
        mismatched = []
        for hook_id, script in _local_scripts(script_dir).items():
            parts = Path(script).parts  # 直下 = (.githooks, <dir>, <file>) の 3 要素
            if len(parts) == 3 and parts[0] == ".githooks" and parts[1] in _STAGE_DIRS:
                if _stages(blocks[hook_id]) != [parts[1]]:
                    mismatched.append(f"{hook_id}: {script} stages={_stages(blocks[hook_id])}")
    with allure.step("置き場と stages の食い違いが無いことを確かめる"):
        assert mismatched == []


@allure.title("`.githooks/ci/` 直下のスクリプトを使う hook は、manual の stage だけで動く")
def test_ci_dir_hooks_run_only_in_manual(script_dir: Path) -> None:
    """`.githooks/ci/` 直下にスクリプトを置く local hook のテストです。1 件以上存在し、すべての `stages` が `manual` だけであることを確認します。"""
    with allure.step("ci/ 直下の hook を集める"):
        blocks = _local_hook_blocks(_config_text(script_dir))
        ci_hooks = {
            hook_id: script
            for hook_id, script in _local_scripts(script_dir).items()
            if (parts := Path(script).parts)[:2] == (".githooks", "ci") and len(parts) == 3
        }
    with allure.step("stages が manual だけであることを確かめる"):
        assert ci_hooks
        assert {hook_id: _stages(blocks[hook_id]) for hook_id in ci_hooks} == {
            hook_id: ["manual"] for hook_id in ci_hooks
        }


@allure.title("pre-push で動く hook は、期待する 3 つの local hook だけに限る")
def test_pre_push_hooks_are_only_the_expected_local_ones(script_dir: Path) -> None:
    """pre-push で動く hook のテストです。既定の stages に `pre-push` が含まれないことを確認します。指定する hook は、`check-text-push`・`check-version-plan-required`・`nx-env-inputs` の 3 つの local hook だけです。外部のリポジトリの hook は、`pre-push` を指定しません。"""
    with allure.step("pre-push で動く hook を設定から集める"):
        text = _config_text(script_dir)
        default = re.search(r"^default_stages:\s*\[(.*)\]", text, re.MULTILINE)
        assert default is not None
        assert "pre-push" not in [item.strip() for item in default.group(1).split(",")]

        blocks = _local_hook_blocks(text)
        local_pre_push = {
            hook_id for hook_id, block in blocks.items() if "pre-push" in (_stages(block) or [])
        }
        assert local_pre_push == {"check-text-push", "check-version-plan-required", "nx-env-inputs"}

        lines = text.splitlines()
        local_start = next(i for i, line in enumerate(lines) if line.strip() == "- repo: local")
        local_end = next(
            (
                i
                for i in range(local_start + 1, len(lines))
                if lines[i].strip().startswith("- repo:")
            ),
            len(lines),
        )
        external = lines[:local_start] + lines[local_end:]
        stage_lines = [line for line in external if line.strip().startswith("stages:")]
        assert all("pre-push" not in line for line in stage_lines)


@allure.title("stage 名のディレクトリ直下の *.sh は、すべてどれかの entry から参照される")
def test_stage_dir_scripts_are_referenced_by_entries(script_dir: Path) -> None:
    """`.githooks` の `pre-commit`・`commit-msg`・`pre-push` の直下にあるシェルスクリプトのテストです。どの hook の `entry` からも参照されない未使用のスクリプトが存在しないことを確認します。"""
    with allure.step("entry に参照される script を集め、参照されない *.sh を挙げる"):
        root = script_dir.parents[1]
        referenced = set(_local_scripts(script_dir).values())
        orphans = [
            str(path.relative_to(root))
            for stage_dir in _STAGE_DIRS
            if (root / ".githooks" / stage_dir).is_dir()
            for path in sorted((root / ".githooks" / stage_dir).glob("*.sh"))
            if str(path.relative_to(root)) not in referenced
        ]
    with allure.step("参照されない *.sh が無いことを確かめる"):
        assert orphans == []


@allure.title("{hook_id} は、manual の stage だけで動く")
@pytest.mark.parametrize("hook_id", ["nx-affected-tests"])
def test_test_hooks_run_only_in_manual(script_dir: Path, hook_id: str) -> None:
    """テストを実行する hook の `stages` のテストです。`manual` だけが指定され、CI と手動の実行にだけ使われることを確認します。"""
    with allure.step("テストの hook の設定の行を取り出す"):
        block = _hook_entry_lines(_config_text(script_dir), hook_id)
    with allure.step("stages が manual だけであることを確かめる"):
        assert _stages(block) == ["manual"]
