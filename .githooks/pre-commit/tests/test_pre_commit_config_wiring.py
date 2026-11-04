"""`.pre-commit-config.yaml` の所要記録の配線テスト（#1083）。

自前 hook は with-timing.sh で包んで所要を記録する。成功 push の合計行と一致 0 件の表示を
端末へ出すため `verbose: true` は nx-affected-tests と check-brand-terms だけに付ける。いずれも
スクリプト単体テストでは守れない配線のため、リポ実体の config を読んで pin する。
yaml パーサに依存しない切り出しは test_check_release_group_changelog.py と同方式。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_WRAPPED_HOOKS = [
    "check-text",
    "check-text-push",
    "check-commit-text",
    "nx-affected-lint",
    "check-brand-terms",
    "check-version-plan-required",
    "githooks-tests",
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


@pytest.mark.parametrize("hook_id", _WRAPPED_HOOKS)
def test_entry_wrapped_with_timing(script_dir: Path, hook_id: str) -> None:
    """entry が `with-timing.sh <自分の id> <元の script>` の形で、元の script が実在する。"""
    block = _hook_entry_lines(_config_text(script_dir), hook_id)
    entries = [line.strip() for line in block if line.strip().startswith("entry:")]
    assert len(entries) == 1
    entry = entries[0].removeprefix("entry:").strip()
    prefix = f".githooks/pre-commit/with-timing.sh {hook_id} "
    assert entry.startswith(prefix)
    wrapped = entry[len(prefix) :].split()[0]
    assert (script_dir.parents[1] / wrapped).is_file()


def test_verbose_only_on_hooks_that_print_a_success_line(script_dir: Path) -> None:
    """`verbose: true` を持つ hook は、成功時にも端末へ出す行がある 2 つだけ。"""
    text = _config_text(script_dir)
    verbose = [
        hook_id
        for hook_id in _hook_ids(text)
        if "verbose: true" in [line.strip() for line in _hook_entry_lines(text, hook_id)]
    ]
    assert verbose == ["check-brand-terms", "nx-affected-tests"]


def _hook_files_pattern(script_dir: Path, hook_id: str) -> re.Pattern[str]:
    block = _hook_entry_lines(_config_text(script_dir), hook_id)
    patterns = [line.strip() for line in block if line.strip().startswith("files:")]
    assert len(patterns) == 1, f"{hook_id} に files: が 1 つだけ必要"
    return re.compile(patterns[0].removeprefix("files:").strip())


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
        "plugins/pecot-visual/bin/pecotv",
        "plugins/pecot-tools/setup.sh",
        "plugins/pecot-tools/cli/tests/bootstrap/run.sh",
        "plugins/pecot-visual/cli/package.json",
        "plugins/pecot-visual/package.json",
        "plugins/pecot-visual/cli/vitest.config.ts",
        "plugins/pecot-visual/cli/vitest.e2e.config.ts",
        "plugins/pecot-visual/cli/src/infra/drawio/pdf.ts",
        "plugins/pecot-visual/cli/tests/e2e/mcp-tools.test.ts",
        "plugins/pecot-visual/scripts/pptx-compare/lib/cli-dist.mjs",
        "plugins/pecot-workflow/cli/core/paths.py",
        "plugins/pecot-workflow/hooks/tests/test_session_start_common.py",
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
    pattern = _hook_files_pattern(script_dir, "nx-env-inputs")
    assert pattern.search(changed_path), f"nx-env-inputs の files が {changed_path} に一致しない"


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
    pattern = _hook_files_pattern(script_dir, "nx-env-inputs")
    assert not pattern.search(changed_path)


@pytest.mark.parametrize(
    "changed_path",
    [
        ".githooks/pre-commit/run-affected-tests.sh",
        ".githooks/pre-commit/tests/test_nx_env_inputs.py",
        "nx.json",
        ".nxignore",
        "pyproject.toml",
        "uv.lock",
        "plugins/pecot-workflow/cli/pyproject.toml",
        "plugins/pecot-workflow/cli/uv.lock",
        "plugins/pecot-workflow/scripts/ci/run-tests.sh",
        "plugins/pecot-workflow/scripts/ci/run-lint.sh",
        "plugins/pecot-workflow/scripts/ci/python-version.sh",
        # root の package.json は nx workspace の形を test_root_package_manifest.py が読む。
        # libs/<name>/ の package.json と project.json は、nx のグラフ確認も読む。
        "package.json",
        "libs/text-rules/package.json",
        "libs/text-rules/project.json",
    ],
)
def test_githooks_tests_runs_when_their_inputs_change(script_dir: Path, changed_path: str) -> None:
    pattern = _hook_files_pattern(script_dir, "githooks-tests")
    assert pattern.search(changed_path), f"githooks-tests の files が {changed_path} に一致しない"


@pytest.mark.parametrize(
    "changed_path",
    [
        "README.md",
        "plugins/pecot-workflow/skills/w-pr/SKILL.md",
        "plugins/pecot-visual/CHANGELOG.md",
        # 環境変数の宣言不足の確認は nx-env-inputs が受け持つ。
        # plugins のソースを変えた push で、githooks の pytest 全体（約 9 秒）を実行しない。
        "plugins/pecot-visual/cli/src/infra/drawio/pdf.ts",
        "plugins/pecot-visual/bin/pecotv",
        "plugins/pecot-visual/scripts/ci/run-lint.sh",
        "plugins/pecot-tools/cli/tests/bootstrap/run.sh",
        "plugins/pecot-visual/cli/package.json",
        "plugins/pecot-workflow/cli/core/paths.py",
        "plugins/pecot-visual/package.json",
        "libs/text-rules/index.ts",
        "libs/text-rules/tests/index.test.ts",
    ],
)
def test_githooks_tests_skips_unrelated_paths(script_dir: Path, changed_path: str) -> None:
    pattern = _hook_files_pattern(script_dir, "githooks-tests")
    assert not pattern.search(changed_path), f"githooks-tests の files が {changed_path} に一致する"


@pytest.mark.parametrize(
    "changed_path",
    [
        ".claude-plugin/marketplace.json",
        ".github/plugin/marketplace.json",
        "plugins/pecot-workflow/.claude-plugin/plugin.json",
        "plugins/pecot-visual/.github/plugin/plugin.json",
        "plugins/pecot-workflow/hooks/hooks.json",
        "plugins/pecot-workflow/hooks/hooks-copilot.json",
        "plugins/pecot-tools/.mcp.json",
        "plugins/pecot-workflow/skills/w-pr/SKILL.md",
        "plugins/pecot-visual/skills/v-drawio/SKILL.md",
        "plugins/pecot-visual/agents/v-slide-creator.md",
    ],
)
def test_plugin_validate_runs_when_definitions_change(script_dir: Path, changed_path: str) -> None:
    pattern = _hook_files_pattern(script_dir, "plugin-validate")
    assert pattern.search(changed_path), f"plugin-validate の files が {changed_path} に一致しない"


@pytest.mark.parametrize(
    "changed_path",
    [
        "plugins/pecot-workflow/project.json",
        "plugins/pecot-workflow/scripts/ci/tests/test_x.py",
        "README.md",
    ],
)
def test_plugin_validate_skips_unrelated_paths(script_dir: Path, changed_path: str) -> None:
    pattern = _hook_files_pattern(script_dir, "plugin-validate")
    assert not pattern.search(changed_path), (
        f"plugin-validate の files が {changed_path} に一致する"
    )


_TEXT_FILES_HOOK = "check-text"


@pytest.mark.parametrize(
    "changed_path",
    [
        "README.md",
        "plugins/pecot-workflow/cli/core/paths.py",
        ".githooks/pre-commit/check-text.sh",
        "nx.json",
        "plugins/pecot-workflow/hooks/hooks.json",
        "libs/text-rules/package-lock.json",
    ],
)
def test_check_text_runs_for_text_sources(script_dir: Path, changed_path: str) -> None:
    pattern = _hook_files_pattern(script_dir, _TEXT_FILES_HOOK)
    assert pattern.search(changed_path), f"check-text の files が {changed_path} に一致しない"


@pytest.mark.parametrize("changed_path", [".yamllint", "docs/index.html"])
def test_check_text_skips_other_files(script_dir: Path, changed_path: str) -> None:
    pattern = _hook_files_pattern(script_dir, _TEXT_FILES_HOOK)
    assert not pattern.search(changed_path), f"check-text の files が {changed_path} に一致する"


def _hook_exclude_pattern(script_dir: Path, hook_id: str) -> re.Pattern[str]:
    block = _hook_entry_lines(_config_text(script_dir), hook_id)
    patterns = [line.strip() for line in block if line.strip().startswith("exclude:")]
    assert len(patterns) == 1, f"{hook_id} に exclude: が 1 つだけ必要"
    return re.compile(patterns[0].removeprefix("exclude:").strip())


@pytest.mark.parametrize(
    "changed_path",
    [
        "plugins/pecot-visual/CHANGELOG.md",
        "plugins/pecot-workflow/cli-node/tests/parity/golden/pr-create-ok.json",
        "plugins/pecot-workflow/cli-node/tests/python-output/sections.json",
        "plugins/pecot-workflow/cli-node/tests/python-output/record.py",
    ],
)
def test_check_text_excludes_generated_files(script_dir: Path, changed_path: str) -> None:
    """生成物の CHANGELOG.md、Python の出力の記録（golden・python-output）は exclude で対象から外れる。"""
    assert _hook_exclude_pattern(script_dir, _TEXT_FILES_HOOK).search(changed_path)


@pytest.mark.parametrize(
    "changed_path",
    [
        "README.md",
        "plugins/pecot-workflow/docs-guide.md",
        "plugins/pecot-workflow/cli-node/tests/parity/run.ts",
        "plugins/pecot-workflow/cli-node/src/python-output/x.ts",
    ],
)
def test_check_text_keeps_hand_written_files(script_dir: Path, changed_path: str) -> None:
    assert not _hook_exclude_pattern(script_dir, _TEXT_FILES_HOOK).search(changed_path)


def test_check_text_stages_and_flags(script_dir: Path) -> None:
    """check-text は pre-commit だけで動き、fail_fast と require_serial を付ける。"""
    block = [line.strip() for line in _hook_entry_lines(_config_text(script_dir), "check-text")]
    assert "stages: [pre-commit]" in block
    assert "fail_fast: true" in block
    assert "require_serial: true" in block


def test_check_text_push_stage_and_flags(script_dir: Path) -> None:
    """pre-push はステージ済みの差分でなく push 範囲を自前で解決するため、常に動く。"""
    block = [
        line.strip() for line in _hook_entry_lines(_config_text(script_dir), "check-text-push")
    ]
    assert "stages: [pre-push]" in block
    assert "always_run: true" in block
    assert "pass_filenames: false" in block
    assert "fail_fast: true" in block


def _script_regex(script_dir: Path, name: str) -> str:
    text = (script_dir / "check-text-push.sh").read_text()
    matches = re.findall(rf"^{name}='(.*)'$", text, flags=re.MULTILINE)
    assert len(matches) == 1, f"check-text-push.sh に {name} が 1 行だけ必要"
    return matches[0]


def test_check_text_push_regexes_match_config(script_dir: Path) -> None:
    """check-text-push.sh の対象判定は、check-text の files および exclude と同一にする。"""
    files = _hook_files_pattern(script_dir, _TEXT_FILES_HOOK).pattern
    exclude = _hook_exclude_pattern(script_dir, _TEXT_FILES_HOOK).pattern
    assert _script_regex(script_dir, "TEXT_FILES_RE") == files
    assert _script_regex(script_dir, "TEXT_EXCLUDE_RE") == exclude


def test_check_commit_text_stage_and_always_run(script_dir: Path) -> None:
    """コミットメッセージは files: の対象にならないため、commit-msg stage で常に動く。"""
    block = [
        line.strip() for line in _hook_entry_lines(_config_text(script_dir), "check-commit-text")
    ]
    assert "stages: [commit-msg]" in block
    assert "always_run: true" in block


def test_check_text_runs_before_heavy_hooks(script_dir: Path) -> None:
    """check-text は重い nx-affected-lint と nx-affected-tests より前に置く。"""
    ids = _hook_ids(_config_text(script_dir))
    assert ids.index("check-text") < ids.index("nx-affected-lint")
    assert ids.index("check-text") < ids.index("nx-affected-tests")


def test_check_text_push_runs_before_heavy_hooks(script_dir: Path) -> None:
    """check-text-push は version plan ガードと nx-affected-tests より前に置く。"""
    ids = _hook_ids(_config_text(script_dir))
    assert ids.index("check-text-push") < ids.index("check-version-plan-required")
    assert ids.index("check-text-push") < ids.index("nx-affected-tests")


def test_check_brand_terms_stage_and_flags(script_dir: Path) -> None:
    """語の確認は pre-push で常に動き、飛ばしたことも端末へ出す。"""
    block = [
        line.strip() for line in _hook_entry_lines(_config_text(script_dir), "check-brand-terms")
    ]
    assert "stages: [pre-push]" in block
    assert "always_run: true" in block
    assert "pass_filenames: false" in block
    assert "verbose: true" in block
    assert "fail_fast: true" in block


def test_check_brand_terms_runs_before_nx_affected_tests(script_dir: Path) -> None:
    """語の確認は数分かかるテストより前に置き、一致があれば先に止める。"""
    ids = _hook_ids(_config_text(script_dir))
    assert ids.index("check-brand-terms") < ids.index("nx-affected-tests")


def test_pages_build_hook_is_removed(script_dir: Path) -> None:
    """Pages の公開ビルドは持たない。docs/ を除外する設定も残さない。"""
    text = _config_text(script_dir)
    assert "build-pages-slides" not in _hook_ids(text)
    assert "^docs/" not in text


def test_pecotv_skill_frontmatter_hook_is_replaced(script_dir: Path) -> None:
    """旧 check-pecotv-skill-frontmatter は plugin-validate に吸収済みで、残さない。"""
    assert "check-pecotv-skill-frontmatter" not in _hook_ids(_config_text(script_dir))


def test_local_hooks_use_unsupported_languages(script_dir: Path) -> None:
    """repo: local の language は pre-commit 4.4.0 の新表記で、下限もそれ以上に固定する。

    旧 `script` / `system` は pre-commit 側で読み替え対象（将来撤去）になっている。
    """
    text = _config_text(script_dir)
    local_part = text.split("  - repo: https://", 1)[0]
    languages = re.findall(r"^\s+language:\s*(\S+)", local_part, flags=re.MULTILINE)
    assert languages
    assert set(languages) <= {"unsupported", "unsupported_script"}
    match = re.search(r'^minimum_pre_commit_version:\s*"?([\d.]+)"?', text, flags=re.MULTILINE)
    assert match, "minimum_pre_commit_version が無い"
    assert tuple(int(p) for p in match.group(1).split(".")) >= (4, 4, 0)
