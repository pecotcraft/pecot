"""nx affected のファイル→project マッピングを pin する回帰テスト（#1021）。

このディレクトリの他テスト（test_run_affected_tests.py 等）は、temp repo に nx スタブを置く。
どれも hermetic なユニットテストで、フック側のシェルロジックだけを検証する。
本テストはそれとは意図的に異なる。
リポジトリ実体の nx を実際に起動する。
起動するのは node_modules/.bin/nx で、`.nxignore` と `nx.json` の namedInputs が生む affected の範囲そのものを検証する。
スタブでは、「どのファイルがどの project を affected にするか」を捕捉できない。
今回の回帰対象である、プロジェクト外ファイルでの全 project 発火も、スタブでは見つからない。

実 nx に依存する代償として、次の制約を置く。
  - node_modules/.bin/nx が無ければ skip する。fresh clone の npm ci 前は、正当な未整備として扱う。
  - NX_DAEMON=false を明示し、デーモンのグラフキャッシュによる結果の揺れを排除する。
"""

from __future__ import annotations

import fnmatch
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import allure
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attach import attach_json, attach_output, run_attached  # noqa: E402

# parents[0]=tests, [1]=.githooks, [2]=リポルート。
_REPO_ROOT = Path(__file__).resolve().parents[2]

# nx の判定を左右する root 設定ファイル。
# --base/--head ケースの複製リポへ、作業ツリー側の内容を持ち込むために使う。
# 本テストは、未コミットの設定変更も対象にする。
_NX_CONFIG_FILES = (".nxignore", "nx.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "package.json")

# nx が認識する project の集合。入れ子のメンバーは `nx.root` / `nx.name` でプラグインの project へ束ねる (#113)。
_EXPECTED_PROJECTS = {
    "pecot-actions",
    "githooks",
    "interface-spec",
    "nx-release",
    "pecot",
    "pecot-tools",
    "pecot-visual",
    "pecot-workflow",
    "text-rules",
    "workflow-core",
}


class _Lanes(frozenset[str]):
    # Allure の history ID が実行ごとに変わらないように、要素を並べて表す。
    def __repr__(self) -> str:
        return "{" + ", ".join(repr(item) for item in sorted(self)) + "}" if self else "set()"


def _lane_cases(cases: list[tuple]) -> list[tuple]:
    return [
        tuple(_Lanes(v) if isinstance(v, set | frozenset) else v for v in case) for case in cases
    ]


def _nx_env(isolation: dict[str, str] | None = None) -> dict[str, str]:
    # キャッシュと索引 db の置き場は、conftest.py が立てた env を引き継ぐ。
    return {**os.environ, "NX_DAEMON": "false", **(isolation or {})}


@pytest.fixture(scope="session")
def nx_bin() -> Path:
    """リポジトリ実体の nx 実行ファイル。未導入なら skip。"""
    candidate = _REPO_ROOT / "node_modules" / ".bin" / "nx"
    if not candidate.exists():
        pytest.skip("node_modules/.bin/nx が無い（npm ci 前）ため実 nx テストを skip する")
    return candidate


def _affected(nx_bin: Path, cwd: Path, *args: str, nx_state: Path | None = None) -> list[str]:
    """`nx show projects --affected --json` を実行して project 名リストを返す。

    nx_state を渡すと、キャッシュと索引 db をそこへ向ける。一時 clone など `_REPO_ROOT` 以外で
    動かすときに渡す（nx 24 は repo ごとの id で `~/.nx/<id>/` を作り、一時リポの分が残るため）。
    省くと、conftest.py が 1 回の実行に 1 つ作り、worker で共有する置き場に向く。
    """
    isolation = (
        {
            "NX_CACHE_DIRECTORY": str(nx_state / "cache"),
            "NX_WORKSPACE_DATA_DIRECTORY": str(nx_state / "workspace-data"),
        }
        if nx_state
        else None
    )
    result = run_attached(
        [str(nx_bin), "show", "projects", "--affected", "--json", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=180,
        env=_nx_env(isolation),
    )
    assert result.returncode == 0, f"nx 失敗: {result.stderr}"
    return json.loads(result.stdout.strip().splitlines()[-1])


# -----------------------------------------------------------------------------
#
# --files ケース。軽量で、単一ファイルの変更に対する project 集合を pin する
#
# -----------------------------------------------------------------------------


@allure.title("{changed_file} を変更しても、どの project も affected にならない")
@pytest.mark.parametrize(
    "changed_file",
    [
        # root lockfile では、@nx/js の lockfile locator が全 project を touched にする。
        # この既定を、.nxignore の /pnpm-lock.yaml で止めている。
        "pnpm-lock.yaml",
    ],
)
def test_outside_project_file_affects_nothing(nx_bin: Path, changed_file: str) -> None:
    """実際の nx を使った、ファイルと project の対応のテストです。project の外にあるルートの lockfile を変更したときに、`nx show projects --affected` が空の一覧を返すことを確認します。"""
    with allure.step("project の外のファイルの変更が、どの project にも届かないことを確かめる"):
        assert _affected(nx_bin, _REPO_ROOT, f"--files={changed_file}") == []


@allure.title(
    "プラグインの外の {changed_file} を変更すると、ルートの project だけが affected になる"
)
@pytest.mark.parametrize(
    "changed_file",
    [
        # markdownlint 設定: nx の lint target は markdownlint を実行しない（実行元は
        # .pre-commit-config.yaml の外部 hook）。sharedGlobals から外して発火を止めている。
        ".markdownlint-cli2.jsonc",
        # プロジェクト外の一般ファイル。どの namedInputs にも載らない。
        ".pecot/config/.worktreeignore",
        # CI で使わない .devcontainer のファイル。sharedGlobals に載せていない。
        ".devcontainer/tmux/tmux.conf",
        ".devcontainer/scripts/install-git-hooks.sh",
    ],
)
def test_outside_project_file_affects_only_the_root_project(
    nx_bin: Path, changed_file: str
) -> None:
    """実際の nx を使った、ファイルと project の対応のテストです。`.markdownlint-cli2.jsonc` など、プラグインの外にあるファイルを変更した場合に、affected になる project がルートの `pecot` だけであることを確認します。"""
    with allure.step("project の外のファイルの変更が、root の project だけに届くことを確かめる"):
        assert _affected(nx_bin, _REPO_ROOT, f"--files={changed_file}") == ["pecot"]


@allure.title("nx が認識する project の集合は、期待する 9 件と一致する")
def test_project_set_is_the_expected_one(nx_bin: Path) -> None:
    """実際の nx が認識する project の一覧のテストです。入れ子になったメンバーが独立した project にならず、`nx show projects` の結果が期待する集合と一致することを確認します。"""
    with allure.step("nx show projects を動かす"):
        result = run_attached(
            [str(nx_bin), "show", "projects", "--json"],
            cwd=_REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=180,
            env=_nx_env(),
        )
    with allure.step("終了コード 0 で、project の集合が期待どおりであることを確かめる"):
        assert result.returncode == 0, f"nx 失敗: {result.stderr}"
        assert set(json.loads(result.stdout.strip().splitlines()[-1])) == _EXPECTED_PROJECTS


@allure.title("{changed_file} を変更すると、そのソースを持つ project が affected になる")
@pytest.mark.parametrize(
    ("changed_file", "expected"),
    _lane_cases(
        [
            ("plugins/pecot-workflow/cli/src/main.ts", {"pecot-workflow"}),
            ("plugins/pecot-visual/cli/src/main.ts", {"pecot-visual"}),
            ("libs/text-rules/index.ts", {"text-rules"}),
            # pecot-workflow は package.json の依存で、actions は implicitDependencies で workflow-core を読む。
            (
                "libs/workflow-core/src/domain/config.ts",
                {"workflow-core", "pecot-workflow", "pecot-actions"},
            ),
            # pecot-workflow は actions の雛形の写しを持ち、implicitDependencies で actions に頼る。
            ("actions/src/entry.ts", {"pecot-actions", "pecot-workflow"}),
        ]
    ),
)
def test_plugin_source_affects_own_projects(
    nx_bin: Path, changed_file: str, expected: frozenset[str]
) -> None:
    """プラグインやライブラリのソースを変更した場合のテストです。`nx show projects --affected` の結果に、そのソースを持つ project が含まれることを確認します。`workflow-core` の変更では、依存する `pecot-workflow` も含まれます。"""
    with allure.step("代表ファイルが実在し、変更が自分の project に届くことを確かめる"):
        # 存在しないパスを --files に渡すと、nx は何も言わずに [] を返す。
        # そのため代表ファイルの移動や改名は、「affected が空」ではなく明示的な失敗として出す。
        assert (_REPO_ROOT / changed_file).exists(), f"代表ファイルが移動している: {changed_file}"
        assert expected <= set(_affected(nx_bin, _REPO_ROOT, f"--files={changed_file}"))


@allure.title("nx.json を変更すると、すべての project が affected になる")
def test_nx_json_still_affects_all_projects(nx_bin: Path) -> None:
    """`nx.json` を変更した場合のテストです。`nx.json` は共通の入力に含める設計のため、`pecot-workflow` や `pecot-visual` など、主要な project がすべて affected になることを確認します。"""
    with allure.step("nx.json の変更で affected を調べる"):
        affected = set(_affected(nx_bin, _REPO_ROOT, "--files=nx.json"))
    with allure.step("全プラグインの project に届くことを確かめる"):
        assert {"pecot-workflow", "pecot-visual", "pecot-tools", "text-rules"} <= affected


@allure.title("{changed_file} を変更すると、すべての project が affected になる")
@pytest.mark.parametrize(
    "changed_file",
    [
        ".devcontainer/devcontainer.json",
        ".devcontainer/features/playwright-deps/install.sh",
        ".devcontainer/scripts/post-create.sh",
        ".devcontainer/scripts/post-start.sh",
    ],
)
def test_devcontainer_change_affects_all_projects(nx_bin: Path, changed_file: str) -> None:
    """CI のイメージや起動に関わる、`.devcontainer` のファイルを変更した場合のテストです。代表ファイルが存在し、主要な project がすべて affected になることを確認します。"""
    with allure.step("代表ファイルが実在することを確かめる"):
        assert (_REPO_ROOT / changed_file).exists(), f"代表ファイルが移動している: {changed_file}"
    with allure.step(
        "変更したファイルで affected を調べ、全プラグインの project に届くことを確かめる"
    ):
        affected = set(_affected(nx_bin, _REPO_ROOT, f"--files={changed_file}"))
        assert {"pecot-workflow", "pecot-visual", "pecot-tools", "text-rules"} <= affected


# -----------------------------------------------------------------------------
#
# レーンの inputs ケース。どのファイルの変更でどのレーンが再実行されるかを見る
#
# -----------------------------------------------------------------------------
#
# 1 プラグイン = 1 project で、レーンは project の test-* target になる。
# affected になった project の中で、実際に実行されるのは inputs の変わったレーンだけで、
# ほかはキャッシュを再利用する。
# そのため、ファイルの変更で再実行されるレーンは、各レーンの inputs で決まる。


def _nx(nx_bin: Path, *args: str, attach: bool = True) -> str:
    # stdout はパイプでなくファイルで受ける。nx は stdout がパイプのとき大きな JSON を書き切る前に
    # 終了することがあり、切れた出力を受け取って JSONDecodeError になる (#1217)。
    # attach が偽なら、一部だけを判定に使う大きな出力なので、落ちたときだけ添付する。
    with tempfile.TemporaryFile("w+", encoding="utf-8") as out:
        result = subprocess.run(
            [str(nx_bin), *args],
            cwd=_REPO_ROOT,
            stdout=out,
            stderr=subprocess.PIPE,
            text=True,
            timeout=180,
            env=_nx_env(),
        )
        out.seek(0)
        text = out.read()
        if attach or result.returncode != 0:
            attach_output(f"nx {' '.join(args)}", text, result.stderr, result.returncode)
        assert result.returncode == 0, f"nx 失敗: {result.stderr}"
        return text


@pytest.fixture(scope="module")
def lane_input_files(nx_bin: Path, tmp_path_factory: pytest.TempPathFactory) -> dict[str, set[str]]:
    """全 project の test-* レーン（`project:target`）→ そのレーンの inputs に入るファイル。"""
    graph_file = tmp_path_factory.mktemp("graph") / "graph.json"
    _nx(nx_bin, "graph", f"--file={graph_file}")
    nodes = json.loads(graph_file.read_text(encoding="utf-8"))["graph"]["nodes"]
    lanes = [
        f"{project}:{target}"
        for project, node in nodes.items()
        for target in node["data"]["targets"]
        if target.startswith("test-")
    ]
    attach_json("graph.json の test- のレーン", lanes)
    return {
        lane: set(
            json.loads(_nx(nx_bin, "show", "target", "inputs", lane, "--json", attach=False))[
                "files"
            ]
        )
        for lane in lanes
    }


def _lanes_reading(lane_input_files: dict[str, set[str]], changed_file: str) -> set[str]:
    assert (_REPO_ROOT / changed_file).exists(), f"代表ファイルが移動している: {changed_file}"
    lanes = {lane for lane, files in lane_input_files.items() if changed_file in files}
    attach_json(f"inputs に {changed_file} を持つレーン", sorted(lanes))
    return lanes


@allure.title("{changed_file} は、それを読むレーンの inputs にだけ含まれる")
@pytest.mark.parametrize(
    ("changed_file", "expected"),
    _lane_cases(
        [
            # pecot-visual の agents/*.md を読むテストは 2 つある。
            # 1 つは v-drawio の references の実在を確認するテストになる。
            # もう 1 つは、スキルとエージェント定義の型を確認するテストで、pecot-workflow の test_agent_definitions (#1231) を指す。
            (
                "plugins/pecot-visual/agents/v-diagram-creator.md",
                {
                    "pecot-visual:test-skills",
                    "pecot-visual:test-cli",
                    "pecot-workflow:test-hooks",
                },
            ),
            # w-plan-reviewer.md を読むテストは 2 つある。
            # 1 つは CUJ 定義の単一化を確かめるテストで、test-hooks が持つ (#1091)。
            # 1 つは本文のツール名と入力名を COMMANDS の定義と比べるテスト（cli/tests/skills/）で、test-skills が持つ (#1185, #350)。
            # エージェントの定義の一致は cli/tests/plugin-manifests.test.ts が確かめるので、test-cli も読む。
            (
                "plugins/pecot-workflow/agents/w-plan-reviewer.md",
                {
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-skills",
                },
            ),
            # scripts/ci/tests の *.bats を実行するのは、run-tests.sh --scope=skills だけとなる (#1225)。
            # pecotvPluginTestGlobals（pecot-visual 全レーン共有）に置くと、1 ファイルの変更で全レーンが再実行される。
            (
                "plugins/pecot-visual/scripts/ci/tests/references-path-existence.bats",
                {"pecot-visual:test-skills"},
            ),
            # fake-aws を使うのは pecot-tools の cli のテストだけ (#1225)。
            ("plugins/pecot-tools/cli/tests/_fixtures/fake-aws/aws", {"pecot-tools:test-cli"}),
            # Agent Plugins 1.0 形式の manifest を確かめるのは、cli/tests/plugin-manifests.test.ts だけとなる。
            # 版の更新（nx release）は、nx-release の単体テストが読む (#1230, #1235)。
            (
                "plugins/pecot-visual/plugin.json",
                {"pecot-visual:test-cli", "nx-release:test-unit"},
            ),
            ("plugins/pecot-visual/mcp.json", {"pecot-visual:test-cli"}),
            (
                "plugins/pecot-visual/com.github.copilot/hooks/hooks.json",
                {
                    "pecot-visual:test-cli",
                    "pecot-visual:test-hooks",
                    "pecot-workflow:test-hooks",
                },
            ),
            # manifest の一致のテストは vitest で確かめる test-cli だけに届く。
            ("plugins/pecot-visual/cli/tests/plugin-manifests.test.ts", {"pecot-visual:test-cli"}),
            # hooks.json の形を確かめるのは hooks レーンだけ。
            (
                "plugins/pecot-visual/hooks/tests/hooks-json.bats",
                {"pecot-visual:test-hooks"},
            ),
            # pecot-workflow の登録ファイルは cli/tests/plugin-manifests.test.ts が確かめる。com.github.copilot/hooks/hooks.json は hooks のテストも読む。
            (
                "plugins/pecot-workflow/mcp.json",
                {"pecot-workflow:test-cli", "pecot-workflow:test-hooks"},
            ),
            (
                "plugins/pecot-workflow/com.github.copilot/hooks/hooks.json",
                {"pecot-workflow:test-cli", "pecot-workflow:test-hooks"},
            ),
            # 出力の行の期待値は、Node の出力のテストと githooks の一致のテストが読む (#205)。
            (
                "libs/workflow-core/tests/output/cases.json",
                {"workflow-core:test-unit", "githooks:test-checks"},
            ),
            # 診断行の期待は、3 プラグインの一致のテストが読む (#215)。
            (
                "plugins/pecot-visual/cli/tests/diagnostics-cases.json",
                {"pecot-visual:test-cli", "githooks:test-checks"},
            ),
            (
                "plugins/pecot-tools/cli/tests/diagnostics-cases.json",
                {"pecot-tools:test-cli", "githooks:test-checks"},
            ),
            # vitest の題の重なりを止める setupFiles。読む vitest の設定を持つレーンだけに届く。
            (
                "libs/interface-spec/src/vitest/unique-titles.ts",
                {
                    "pecot-actions:test-unit",
                    "interface-spec:test-unit",
                    "interface-spec:test-site",
                    "nx-release:test-unit",
                    "pecot-tools:test-cli",
                    "pecot-visual:test-cli",
                    "pecot-visual:test-slidev",
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-skills",
                    "text-rules:test-unit",
                    "workflow-core:test-unit",
                },
            ),
            # Allure の結果を残す reporter。題の重なりの setupFiles と同じ vitest のレーンに届く。
            (
                "libs/interface-spec/src/vitest/allure-reporter.ts",
                {
                    "pecot-actions:test-unit",
                    "interface-spec:test-unit",
                    "interface-spec:test-site",
                    "nx-release:test-unit",
                    "pecot-tools:test-cli",
                    "pecot-visual:test-cli",
                    "pecot-visual:test-slidev",
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-skills",
                    "text-rules:test-unit",
                    "workflow-core:test-unit",
                },
            ),
            # verifies の本体。3 つのプラグインの _helpers/verifies.ts が re-export し、cli のテストだけが読む (#695)。
            (
                "libs/interface-spec/src/vitest/verifies.ts",
                {
                    "interface-spec:test-unit",
                    "pecot-tools:test-cli",
                    "pecot-visual:test-cli",
                    "pecot-workflow:test-cli",
                },
            ),
            # 判定に使った出力や成果物の添付。各プラグイン・ライブラリの vitest の補助と test-site が読む (#696, #816)。
            (
                "libs/interface-spec/src/vitest/attach.ts",
                {
                    "interface-spec:test-unit",
                    "interface-spec:test-site",
                    "pecot-visual:test-cli",
                    "pecot-visual:test-slidev",
                    "pecot-tools:test-cli",
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-skills",
                    "text-rules:test-unit",
                    "workflow-core:test-unit",
                },
            ),
            # テストレポートを作るスクリプト。test-site は、このスクリプトが作るレポートを tag で絞り込めるかを確かめる (#695)。
            (
                ".githooks/scripts/test_report/generate.py",
                {"githooks:test-ci", "interface-spec:test-site"},
            ),
            # bash のテストの確かめを Allure の結果にする関数。bash のテストを動かすレーンが読む (#810)。
            (
                ".githooks/scripts/test_report/bash-test.sh",
                {
                    "githooks:test-ci",
                    "pecot-workflow:test-release",
                    "pecot-visual:test-hooks",
                    "pecot-visual:test-compare",
                    "pecot-visual:test-release",
                    "pecot-visual:test-skills",
                    "pecot-tools:test-release",
                },
            ),
            # bash-test.sh と bats の formatter が共有する、Allure の結果を書く関数 (#844)。
            (
                ".githooks/scripts/test_report/allure-result.sh",
                {
                    "githooks:test-ci",
                    "pecot-workflow:test-release",
                    "pecot-visual:test-hooks",
                    "pecot-visual:test-compare",
                    "pecot-visual:test-release",
                    "pecot-visual:test-skills",
                    "pecot-tools:test-release",
                },
            ),
            # bats のテストを動かす仕組み。bats に移したレーンだけが読む (#844)。
            (
                ".githooks/scripts/test_report/bats/run.sh",
                {
                    "githooks:test-ci",
                    "pecot-visual:test-compare",
                    "pecot-visual:test-hooks",
                    "pecot-visual:test-skills",
                    "pecot-visual:test-release",
                    "pecot-tools:test-release",
                },
            ),
        ]
    ),
)
def test_out_of_lane_input_reruns_only_consumer_lane(
    lane_input_files: dict[str, set[str]], changed_file: str, expected: frozenset[str]
) -> None:
    """レーンのディレクトリの外にあるファイルが、レーンの inputs に含まれるかのテストです。そのファイルを使うレーンだけが inputs に宣言していて、ほかのレーンは再実行されないことを確認します。"""
    with allure.step("レーンの外の入力を、消費者のレーンだけが読むことを確かめる"):
        assert _lanes_reading(lane_input_files, changed_file) == expected


@allure.title("{changed_file} を変更すると、pecot-workflow:test-hooks レーンが再実行される")
@pytest.mark.parametrize(
    "changed_file",
    [
        "plugins/pecot-workflow/skills/w-pr/SKILL.md",
        "plugins/pecot-visual/skills/v-slidev/SKILL.md",
    ],
)
def test_skill_definition_change_runs_definition_check(
    lane_input_files: dict[str, set[str]], changed_file: str
) -> None:
    """`SKILL.md` を変更した場合のテストです。frontmatter を確認する `pecot-workflow:test-hooks` レーンの inputs に、そのファイルが含まれることを確認します。"""
    with allure.step("SKILL.md の変更を、pecot-workflow の hooks レーンが読むことを確かめる"):
        assert "pecot-workflow:test-hooks" in _lanes_reading(lane_input_files, changed_file)


@allure.title("{changed_file} を変更すると、pecot-workflow:test-skills レーンが再実行される")
@pytest.mark.parametrize(
    "changed_file",
    [
        "plugins/pecot-workflow/skills/w-pr/SKILL.md",
        "plugins/pecot-workflow/agents/w-plan-reviewer.md",
        "plugins/pecot-workflow/cli/src/main.ts",
    ],
)
def test_skill_body_change_runs_skills_lane(
    lane_input_files: dict[str, set[str]], changed_file: str
) -> None:
    """スキルやエージェントの本文、または `main.ts` を変更した場合のテストです。本文を確認する `pecot-workflow:test-skills` レーンの inputs に、そのファイルが含まれることを確認します。"""
    with allure.step("スキルの本文の変更を、pecot-workflow の skills レーンが読むことを確かめる"):
        assert "pecot-workflow:test-skills" in _lanes_reading(lane_input_files, changed_file)


@allure.title("{changed_file} を変更しても、{release_lane} はキャッシュを再利用する")
@pytest.mark.parametrize(
    ("changed_file", "release_lane"),
    [
        ("plugins/pecot-visual/cli/src/domain/drawio/url.ts", "pecot-visual:test-release"),
        ("plugins/pecot-visual/skills/v-slidev/SKILL.md", "pecot-visual:test-release"),
        ("plugins/pecot-visual/hooks/hooks.json", "pecot-visual:test-release"),
        ("plugins/pecot-tools/cli/src/main.ts", "pecot-tools:test-release"),
        ("plugins/pecot-workflow/cli/src/main.ts", "pecot-workflow:test-release"),
    ],
)
def test_release_lane_is_cached_and_not_run_by_unrelated_changes(
    nx_bin: Path,
    tmp_path: Path,
    lane_input_files: dict[str, set[str]],
    changed_file: str,
    release_lane: str,
) -> None:
    """`cli/src` や `SKILL.md` などを変更した場合の、release レーンのテストです。そのファイルが release レーンの inputs に含まれず、レーンの `cache` が `true` であることを確認します。"""
    with allure.step("cli/src などの変更を、release レーンが読まないことを確かめる"):
        assert release_lane not in _lanes_reading(lane_input_files, changed_file)
    with allure.step("nx graph を書き出し、release レーンの設定を取り出す"):
        graph_file = tmp_path / "graph.json"
        _nx(nx_bin, "graph", f"--file={graph_file}")
        project, target = release_lane.split(":")
        nodes = json.loads(graph_file.read_text(encoding="utf-8"))["graph"]["nodes"]
        config = nodes[project]["data"]["targets"][target]
        attach_json(f"graph.json の {release_lane}", config)
    with allure.step("release レーンが cache: true であることを確かめる"):
        assert config.get("cache") is True


@allure.title("{changed_file} を変更すると、nx-release:test-unit レーンが再実行される")
@pytest.mark.parametrize(
    "changed_file",
    [
        ".nx/nx-release/src/version-actions.js",
        "package.json",  # nx 本体の版
        "libs/text-rules/project.json",  # versionActions / manifestRootsToUpdate
        "libs/text-rules/package.json",  # 実体の版
        ".nx/nx-release/src/package-version-actions.js",
        "plugins/pecot-workflow/project.json",  # versionActions / manifestRootsToUpdate
        "plugins/pecot-tools/.claude-plugin/plugin.json",
        "plugins/pecot-visual/plugin.json",  # Agent Plugins 1.0 形式のルートの plugin.json
        "plugins/pecot-tools/plugin.json",
    ],
)
def test_nx_release_lane_follows_its_inputs(
    lane_input_files: dict[str, set[str]], changed_file: str
) -> None:
    """nx の本体やリリースの設定を変更した場合のテストです。`.nx/nx-release` の `nx-release:test-unit` レーンの inputs に、そのファイルが含まれることを確認します。"""
    with allure.step("nx の更新と release の設定の変更を、nx-release のレーンが読むことを確かめる"):
        assert "nx-release:test-unit" in _lanes_reading(lane_input_files, changed_file)


# -----------------------------------------------------------------------------
#
# task graph ケース。pecot-visual のレーンが共有ステップを nx target に寄せている配線を pin する
#
# -----------------------------------------------------------------------------
#
# pecot-visual の各レーンは、run-tests.sh を別プロセスで起動する。
# install や cli build をレーン内で重ねると、並列実行中の別レーンから CLI を奪うことがある。
# 奪われるのは、test-cli の E2E が起動する bin/pecotv で、prebuild の dist 削除が原因になる。
# #1084 で実 push の間欠的な失敗として観測した。
# pecot-visual の全レーンは install に、cli/dist を読むレーンは build-cli に dependsOn する。
# これを実 nx の task graph で確かめる。


@allure.title("pecot-visual のテストのレーンは、共有の install と build-cli のタスクに依存する")
def test_pecotv_test_lanes_depend_on_shared_install_and_build(tmp_path: Path, nx_bin: Path) -> None:
    """`pecot-visual` のレーンの、task graph のテストです。すべてのレーンが `install` に依存し、`test-cli` などの dist を読むレーンが `build-cli` にも依存することを確認します。"""
    with allure.step("pecot-visual の test の依存を graph に書き出して集める"):
        graph_file = tmp_path / "graph.json"
        _nx(nx_bin, "run-many", "-t", "test", "-p", "pecot-visual", f"--graph={graph_file}")
        tasks = json.loads(graph_file.read_text(encoding="utf-8"))["tasks"]
        # nx 24 の dependencies は、task id から `[{"id": <依存 task id>}]` への対応になる。
        # nx 22 では、id の文字列の配列だった。
        deps = {
            task: {dep["id"] for dep in entries} for task, entries in tasks["dependencies"].items()
        }
        attach_json("graph.json のタスクの依存", {task: sorted(ids) for task, ids in deps.items()})
        lanes = [t for t in tasks["tasks"] if t.startswith("pecot-visual:test-")]
    with allure.step("レーンが install と build を共有して待つことを確かめる"):
        assert "pecot-visual:test-compare" in lanes, lanes
        for lane in lanes:
            assert "pecot-visual:install" in deps[lane], f"{lane} が install に依存しない"
        for lane in (
            "pecot-visual:test-cli",
            "pecot-visual:test-release",
            "pecot-visual:test-compare",
        ):
            assert "pecot-visual:build-cli" in deps[lane], f"{lane} が build-cli に依存しない"
        # 共有ステップは task graph 上で project ごとの 1 件が載る。
        # text-rules:build が text-rules:install を連れてくるので、install は 3 件になる (#1281)。
        # どの project の install も、root の pecot:install（pnpm install --frozen-lockfile）に依存する (#113)。
        assert sorted(t for t in tasks["tasks"] if t.endswith(":install")) == [
            "pecot-visual:install",
            "pecot:install",
            "text-rules:install",
        ]
        assert "pecot:install" in deps["pecot-visual:install"]
        assert "pecot:install" in deps["text-rules:install"]
        # 配布ツリーに同梱する text-rules の dist を、release レーンが先に build する。
        assert "text-rules:build" in deps["pecot-visual:test-release"]
        # pecot:install → text-rules:install → text-rules:build → build-slidev。
        assert "text-rules:install" in deps["text-rules:build"]
        assert "text-rules:build" in deps["pecot-visual:build-slidev"]
        assert "pecot-visual:install" in deps["pecot-visual:build-slidev"]


# -----------------------------------------------------------------------------
#
# --base/--head ケース。実際の呼び方で、使い捨て複製リポ上にプローブコミットを作る
#
# -----------------------------------------------------------------------------
#
# --files 指定の affected は、全て WholeFileChange 扱いになる。
# そのため、JSON の構造差分を見る locator（getTouchedNpmPackages 等）が動かない。
# 実際の pre-push の確認（run-affected-tests.sh）と version-plan ガードは、--base/--head で評価する。
# lockfile のように locator の有無で結果が変わるケースは、こちらで pin する。


@allure.title(
    "lockfile だけを変更したコミットは、base と head の指定でも、どの project も affected にしない"
)
def test_lockfile_only_commit_affects_nothing_via_base_head(nx_bin: Path, tmp_path: Path) -> None:
    """複製したリポジトリで、`pnpm-lock.yaml` の依存の版だけを変更してコミットした場合のテストです。`--base` と `--head` を指定した `nx show projects --affected` が、空の一覧を返すことを確認します。"""
    with allure.step("probe のリポを作り、nx の設定を写して base を決める"):
        probe = tmp_path / "probe"
        # --no-hardlinks は必須とする。
        # tmp_path はリポジトリと別マウントになり得る。
        # devcontainer の bind mount 構成では、実際に別デバイスになる。
        # その場合、既定のハードリンク複製は "Invalid cross-device link" で失敗する。
        run_attached(
            ["git", "clone", "--local", "--no-hardlinks", "-q", str(_REPO_ROOT), str(probe)],
            check=True,
            capture_output=True,
        )
        # 複製には node_modules が無いので実体を貼る（nx 本体と plugin 依存の解決用）。
        (probe / "node_modules").symlink_to(_REPO_ROOT / "node_modules")

        def git(*args: str) -> None:
            run_attached(
                [
                    "git",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "user.email=t@example.com",
                    "-c",
                    "user.name=t",
                    *args,
                ],
                cwd=probe,
                check=True,
                capture_output=True,
            )

        # プローブ 1: 作業ツリー側の nx 設定を複製へ持ち込んで base を作る。clone は
        # コミット済みの内容しか持たないため、未コミットの .nxignore / nx.json 変更でも
        # 同じ判定が pin されるようにする。
        for name in _NX_CONFIG_FILES:
            shutil.copyfile(_REPO_ROOT / name, probe / name)
        git("add", "-A")
        git("commit", "-q", "--allow-empty", "-m", "probe: sync nx config")
        base = run_attached(
            ["git", "rev-parse", "HEAD"], cwd=probe, check=True, capture_output=True, text=True
        ).stdout.strip()

    with allure.step("lockfile の推移的な版を上げて commit する"):
        # プローブ 2: root lockfile だけを変更する（packages の 1 件の版を、キーと参照箇所の両方で書き換える）。
        # 実際の依存の変更にしておく。末尾へのコメント追加では、projectsAffectedByDependencyUpdates が
        # 'auto' でも通ってしまい、.nxignore を外した退行を検出できない。
        lockfile = probe / "pnpm-lock.yaml"
        lock = lockfile.read_text(encoding="utf-8")
        bumped = lock.replace("@antfu/install-pkg@1.1.0", "@antfu/install-pkg@1.1.0-probe")
        assert bumped != lock
        lockfile.write_text(bumped, encoding="utf-8")
        git("add", "-A")
        git("commit", "-q", "-m", "probe: bump transitive lockfile version")
    with allure.step("base と head で affected を調べ、何も届かないことを確かめる"):
        head = run_attached(
            ["git", "rev-parse", "HEAD"], cwd=probe, check=True, capture_output=True, text=True
        ).stdout.strip()

        assert (
            _affected(
                nx_bin, probe, f"--base={base}", f"--head={head}", nx_state=tmp_path / "nx-state"
            )
            == []
        )


# -----------------------------------------------------------------------------
#
# pre-commit と pre-push が要求するレーン単位の affected ケース（#1232）
#
# -----------------------------------------------------------------------------
#
# pre-commit と pre-push の確認は、`nx affected -t <レーン名の列挙>` を呼ぶ。
# 呼ぶのは run-affected-tests.sh と run-affected-lint.sh になる。
# nx 24 のタスク単位 affected は、変更が届いた「要求 target のタスク」だけを選ぶ。
# そのため、起点となる target（test / lint の nx:noop）を要求すると、project 全体を入力にして全レーンを連れてくる。
# レーンを直接要求すれば、変更が届いたレーンだけが選ばれる。
# nx 22 は project 単位で選ぶので、affected になった project の全レーンが残る。このテストは nx 22 で失敗する。


def _graph_lane_names(nx_bin: Path, tmp_path: Path, kind: str) -> list[str]:
    """pre-push と pre-commit の確認と同じ規則で、graph から集めた target 名を返す。

    対象は、名前が `^test(-|$)`（test の場合）か `^lint(-|$)`（lint の場合）に合う target とする。
    ただし executor が nx:noop（起点の target）の場合と、nx:run-script（package.json の scripts 由来）の場合は除く。
    """
    pattern = re.compile(r"^test(-|$)" if kind == "test" else r"^lint(-|$)")
    graph_file = tmp_path / f"graph-{kind}.json"
    _nx(nx_bin, "graph", f"--file={graph_file}")
    nodes = json.loads(graph_file.read_text(encoding="utf-8"))["graph"]["nodes"]
    names = {
        target
        for node in nodes.values()
        for target, config in node["data"]["targets"].items()
        if pattern.match(target) and config.get("executor") not in ("nx:noop", "nx:run-script")
    }
    attach_json(f"graph.json の {kind} のレーン", sorted(names))
    assert names, f"{kind} のレーンが graph に無い"
    return sorted(names)


def _selected_lanes(nx_bin: Path, tmp_path: Path, lanes: list[str], changed_file: str) -> set[str]:
    """`nx affected -t <lanes> --files=<file>` が選んだレーンのタスク（`project:target`）。

    install / build などの依存タスクは含めない。何も選ばれないと nx は graph を書かないことがある。
    """
    assert (_REPO_ROOT / changed_file).exists(), f"代表ファイルが移動している: {changed_file}"
    graph_file = tmp_path / "affected-tasks.json"
    graph_file.unlink(missing_ok=True)
    _nx(
        nx_bin,
        "affected",
        "-t",
        ",".join(lanes),
        f"--files={changed_file}",
        f"--graph={graph_file}",
    )
    if not graph_file.exists():
        return set()
    tasks = json.loads(graph_file.read_text(encoding="utf-8"))["tasks"]["tasks"]
    attach_json("affected-tasks.json のタスク", sorted(tasks))
    wanted = set(lanes)
    return {task for task in tasks if task.split(":")[1] in wanted}


# githooks のレーンのうち、graph を作るファイル（package.json など）に反応する 3 本と、hook・設定のテストの 1 本。
_GITHOOKS_CHECKS = {"githooks:test-checks"}
_GITHOOKS_GRAPH = _GITHOOKS_CHECKS | {"githooks:test-nx-cache", "githooks:test-nx-affected"}

_PECOTV_TEST_LANES = {
    f"pecot-visual:test-{lane}"
    for lane in ("cli", "slidev", "hooks", "compare", "release", "skills")
}


@allure.title("{changed_file} を変更すると、その変更が届くテストのレーンだけが選ばれる")
@pytest.mark.parametrize(
    ("changed_file", "expected"),
    _lane_cases(
        [
            # 1 パッケージのソースだけの変更は、そのソースを読むレーンだけが選ばれる。
            (
                "plugins/pecot-visual/cli/src/version.ts",
                {"pecot-visual:test-cli", "pecot-visual:test-compare"},
            ),
            ("plugins/pecot-tools/cli/src/version.ts", {"pecot-tools:test-cli"}),
            # 層の表は production から外すので、その project のレーンだけに届く (#813)。
            (
                "plugins/pecot-workflow/test-layers.txt",
                {
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-release",
                    "pecot-workflow:test-skills",
                },
            ),
            ("libs/workflow-core/test-layers.txt", {"workflow-core:test-unit"}),
            # 検証用のスクリプトと、それが読む spec は、vitest で確かめる test-cli だけに届く (#562)。
            (
                "plugins/pecot-workflow/scripts/sandbox/sandbox-sweep.sh",
                {"pecot-workflow:test-cli"},
            ),
            ("specs/026-pre-merge-test-env/spec.md", {"pecot-workflow:test-cli"}),
            # pnpm の解決のファイルは Globals が test-cli・test-release に引く。
            (
                "plugins/pecot-tools/scripts/ci/pnpm-lib.sh",
                {"pecot-tools:test-cli", "pecot-tools:test-release"},
            ),
            (
                "plugins/pecot-visual/scripts/ci/pnpm-lib.sh",
                _PECOTV_TEST_LANES,
            ),
            # root の package.json は pecot-visual の全レーンの Globals と、nx 本体の版を読む nx-release が読む。
            # bats の版を持つので、bats を動かす pecot-tools:test-release も読む。
            (
                "package.json",
                _PECOTV_TEST_LANES
                | {"nx-release:test-unit", "pecot-tools:test-release"}
                | _GITHOOKS_GRAPH,
            ),
            # libs/text-rules のレーンは 1 本で、テストの変更は test-unit だけを選ぶ。
            # ソースの変更は、配布ツリーに同梱する dist の元になるので、pecot-visual の release レーンにも届く (#1281)。
            # pecot-visual は text-rules をリンク（vendor/text-rules）で載せていて、nx がリンク先の変更を検知しない。
            # そのため text-constraints を使う test-cli / test-slidev も inputs に持つ (#1297)。
            # nx-release の dependabot-plans は、作った plan に check-text をかける (#67)。
            (
                "libs/text-rules/index.ts",
                {
                    "text-rules:test-unit",
                    "nx-release:test-unit",
                    "pecot-visual:test-release",
                    "pecot-visual:test-cli",
                    "pecot-visual:test-slidev",
                    *_GITHOOKS_CHECKS,
                },
            ),
            # 依存だけの変更も同じ。root の lock が libs/text-rules の importer を持つため、
            # package.json の変更はそのレーンに届く (#1297)。
            (
                "libs/text-rules/package.json",
                {
                    "text-rules:test-unit",
                    "nx-release:test-unit",
                    "pecot-visual:test-release",
                    "pecot-visual:test-cli",
                    "pecot-visual:test-slidev",
                    *_GITHOOKS_GRAPH,
                },
            ),
            ("libs/text-rules/tests/index.test.ts", {"text-rules:test-unit"}),
            # project root の外を読む入力（check-engines-node-drift.sh は 2 つの cli のテストが起動する）。
            (
                ".githooks/pre-commit/check-engines-node-drift.sh",
                {"pecot-tools:test-cli", "pecot-visual:test-cli", *_GITHOOKS_CHECKS},
            ),
            # plugins/pecot-tools/package.json は pecot-visual:test-cli も読む（projectRoot の外）。
            (
                "plugins/pecot-tools/package.json",
                {
                    "pecot-tools:test-cli",
                    "pecot-tools:test-release",
                    "pecot-visual:test-cli",
                    *_GITHOOKS_GRAPH,
                },
            ),
            # pnpm の解決のファイルは pecotPluginNodeInputs が引くレーンに届く。
            (
                "plugins/pecot-workflow/scripts/ci/pnpm-lib.sh",
                {
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-skills",
                    "pecot-workflow:test-release",
                },
            ),
            # pecot-workflow の Node の CLI のソースは、次のレーンを選ぶ (#1313)。
            # cli/src/ は COMMANDS を持ち、本文を確認する test-skills も読む。
            # test-hooks の state-directory-resolution は、build 済みの CLI を起動する。
            (
                "plugins/pecot-workflow/cli/src/main.ts",
                {
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-skills",
                },
            ),
            # libs/workflow-core のソースは、dist を読む pecot-workflow・actions の各レーンへ ^production で届く。
            (
                "libs/workflow-core/src/domain/config.ts",
                {
                    "workflow-core:test-unit",
                    "pecot-actions:test-unit",
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-skills",
                    "pecot-workflow:test-release",
                },
            ),
            ("libs/workflow-core/src/domain/tests/config.test.ts", {"workflow-core:test-unit"}),
            # baseline.json は test-cli の閾値と、test-hooks の起動スクリプトの実在確認と、test-skills の並べ替えの関数（baseline.ts と対）が読む。
            (
                "plugins/pecot-workflow/cli/tests/parity/baseline.json",
                {
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-skills",
                },
            ),
            # hooks/ を読むテストは tests/hooks/ に置き、test-hooks だけが実行する。
            (
                "plugins/pecot-workflow/cli/tests/hooks/baseline-scripts.test.ts",
                {"pecot-workflow:test-hooks"},
            ),
            # interface-spec の単体テストはソースの変更で動く。
            ("libs/interface-spec/src/cli.ts", {"interface-spec:test-unit"}),
            # pecot-tools・pecot-visual の書き出しが import する 3 ファイルは、それぞれの test-cli にも届く。
            (
                "libs/interface-spec/src/domain/diff.ts",
                {
                    "interface-spec:test-unit",
                    "pecot-tools:test-cli",
                    "pecot-visual:test-cli",
                    "pecot-workflow:test-cli",
                },
            ),
            # interface-spec の package.json（zod の版）は、pecot-tools・pecot-visual の test-cli にも届く。
            (
                "libs/interface-spec/package.json",
                {
                    "interface-spec:test-unit",
                    "interface-spec:test-site",
                    "pecot-tools:test-cli",
                    "pecot-visual:test-cli",
                    "pecot-workflow:test-cli",
                    *_GITHOOKS_GRAPH,
                },
            ),
            # 定義書の書き出し結果は、一致のテストの pecot-visual:test-cli に届く。
            # 3 つのプラグインの generated.json は、interface-spec の出力の形のテストも読む。
            (
                "plugins/pecot-visual/interface/generated.json",
                {"pecot-visual:test-cli", "interface-spec:test-unit", "interface-spec:test-site"},
            ),
            (
                "plugins/pecot-tools/interface/generated.json",
                {"pecot-tools:test-cli", "interface-spec:test-unit", "interface-spec:test-site"},
            ),
            # 配布物と配布スクリプトの変更は、pecot-workflow の test-release に届く。
            (
                "plugins/pecot-workflow/cli/templates/comment/plan.md",
                {
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-release",
                    "pecot-workflow:test-skills",
                },
            ),
            (
                "plugins/pecot-workflow/hooks/lib/core/pecot-gitignore-ensure.sh",
                {
                    "pecot-workflow:test-cli",
                    "pecot-workflow:test-hooks",
                    "pecot-workflow:test-release",
                },
            ),
            (
                "plugins/pecot-workflow/scripts/release/publish-mcp-dist.sh",
                {"pecot-workflow:test-release"},
            ),
            (
                ".githooks/scripts/attach-mcp-tgz.sh",
                {
                    "pecot-tools:test-release",
                    "pecot-visual:test-release",
                    "pecot-workflow:test-release",
                },
            ),
            # 3 つの publish-mcp-dist.sh が source する共通の関数は、3 つの test-release と githooks のレーンに届く。
            # そのテストは、テストを動かす 2 つの test-release にだけ届く。
            (
                ".githooks/lib/mcp-publish-common.sh",
                {
                    "pecot-tools:test-release",
                    "pecot-visual:test-release",
                    "pecot-workflow:test-release",
                    "githooks:test-ci",
                    *_GITHOOKS_GRAPH,
                },
            ),
            (
                ".githooks/scripts/tests/mcp-publish-common.bats",
                {
                    "pecot-tools:test-release",
                    "pecot-visual:test-release",
                },
            ),
            # pecot-workflow の定義書は、一致のテストの test-cli に届く。
            (
                "plugins/pecot-workflow/interface/generated.json",
                {"pecot-workflow:test-cli", "interface-spec:test-unit", "interface-spec:test-site"},
            ),
            # 定義書の本文は、サイトの見た目を測る test-site にも届く。
            (
                "plugins/pecot-workflow/interface/authored.yaml",
                {"pecot-workflow:test-cli", "interface-spec:test-site"},
            ),
            # サイトの CSS は、サイトを組む pytest（test-unit）と見た目を測る test-site に届く。
            (
                "libs/interface-spec/docs/_static/pecot.css",
                {"interface-spec:test-unit", "interface-spec:test-site"},
            ),
            # root の lockfile は .nxignore で入力から外す。依存の変更は、各 project の package.json で届く。
            ("pnpm-lock.yaml", set()),
        ]
    ),
)
def test_gate_selects_only_the_lanes_the_change_reaches(
    nx_bin: Path, tmp_path: Path, changed_file: str, expected: frozenset[str]
) -> None:
    """pre-push の確認と同じ、`nx affected` にレーン名を指定する呼び方のテストです。変更したファイルを読むレーンだけが選ばれ、関係のないレーンは選ばれないことを確認します。"""
    with allure.step("test のレーン名を集める"):
        lanes = _graph_lane_names(nx_bin, tmp_path, "test")
    with allure.step("変更したファイルで選ばれるレーンが期待どおりであることを確かめる"):
        assert _selected_lanes(nx_bin, tmp_path, lanes, changed_file) == expected


@allure.title("{changed_file} を変更すると、それを読む githooks のレーンだけが選ばれる")
@pytest.mark.parametrize(
    ("changed_file", "expected"),
    _lane_cases(
        [
            # 当たる側。.githooks/ の外のファイルも、テストが読むなら、それを読むレーンが動く。
            (".githooks/ci/run-pr-checks.sh", {"githooks:test-ci"}),
            # run.sh が step-gate.sh を通して呼ぶので、githooks のすべてのレーンが読む。
            (".githooks/scripts/run-pnpm.sh", _GITHOOKS_GRAPH | {"githooks:test-ci"}),
            (".github/board-sync/handler.mjs", _GITHOOKS_CHECKS),
            (".github/board-sync/template.yaml", _GITHOOKS_CHECKS),
            (".github/workflows/dependabot-commit.yml", _GITHOOKS_CHECKS),
            (".github/workflows/pecot-board-sync.yml", _GITHOOKS_CHECKS),
            (
                "actions/templates/pecot-board-sync.yml",
                _GITHOOKS_CHECKS,
            ),
            (".github/workflows/pecot-review.yml", _GITHOOKS_CHECKS),
            (
                "actions/templates/pecot-review.yml",
                _GITHOOKS_CHECKS,
            ),
            (".github/workflows/pecot-handoff.yml", _GITHOOKS_CHECKS),
            (
                "actions/templates/pecot-handoff.yml",
                _GITHOOKS_CHECKS,
            ),
            ("plugins/pecot-workflow/scripts/ci/run-tests.sh", _GITHOOKS_CHECKS),
            ("plugins/pecot-workflow/scripts/ci/run-lint.sh", _GITHOOKS_CHECKS),
            ("pyproject.toml", _GITHOOKS_CHECKS),
            ("uv.lock", _GITHOOKS_CHECKS),
            # nx 24.0.7 から、差分の無い --files の pnpm-workspace.yaml は overrides を読めず、全 project を選ぶ。
            ("pnpm-workspace.yaml", _GITHOOKS_GRAPH | {"githooks:test-ci"}),
            ("nx.json", _GITHOOKS_GRAPH | {"githooks:test-ci"}),
            (".nxignore", _GITHOOKS_GRAPH | {"githooks:test-ci"}),
            # test-ci の test_report_lanes.py は、全部の project.json の target と outputs を読む。
            ("libs/text-rules/project.json", _GITHOOKS_GRAPH | {"githooks:test-ci"}),
            # test-checks が読む設定。外れると、整合の確認が古い成功を返す。
            (".pre-commit-config.yaml", _GITHOOKS_CHECKS),
            (".textlintignore", _GITHOOKS_CHECKS),
            (".github/workflows/ci.yml", _GITHOOKS_CHECKS),
            (".devcontainer/scripts/exclude-pages-store.sh", _GITHOOKS_CHECKS),
            (".github/rulesets/main.json", _GITHOOKS_CHECKS),
            (".gitlint", _GITHOOKS_CHECKS),
            (".github/plugin/marketplace.json", _GITHOOKS_CHECKS),
            (".claude-plugin/marketplace.json", _GITHOOKS_CHECKS),
            (".claude/rules/repo-root-layout.md", _GITHOOKS_CHECKS),
            ("libs/text-rules/index.ts", _GITHOOKS_CHECKS),
            (
                ".githooks/ci/run-affected-tests.sh",
                _GITHOOKS_CHECKS | {"githooks:test-ci", "githooks:test-nx-cache"},
            ),
            ("libs/text-rules/package.json", _GITHOOKS_GRAPH),
            # 新しいテストのファイルは tests/test_*.py の glob で test-checks に届く。自分のレーンの入力にも載る。
            (".githooks/tests/test_ruleset_main.py", _GITHOOKS_CHECKS),
            (
                ".githooks/tests/test_nx_task_cache.py",
                _GITHOOKS_CHECKS | {"githooks:test-nx-cache"},
            ),
            # graph を作るファイル。nx は .gitignore に従ってファイルの一覧を作る。
            (".gitignore", _GITHOOKS_GRAPH | {"githooks:test-ci"}),
            ("plugins/pecot-visual/.gitignore", _GITHOOKS_GRAPH),
            # pnpm-workspace.yaml の packages にある package.json だけが graph を作る。
            (
                "plugins/pecot-visual/cli/tests/fixtures/minimal-slidev/package.json",
                _GITHOOKS_GRAPH,
            ),
            (
                "plugins/pecot-visual/assets/slidev/scripts/eslint/2layer/package.json",
                _GITHOOKS_GRAPH,
            ),
            # 当たらない側。githooks のレーンは選ばれない。
            ("plugins/pecot-visual/cli/tests/fixtures/themes/with-declaration/package.json", set()),
            ("plugins/pecot-visual/scripts/release/audit-canary/package.json", set()),
            ("plugins/pecot-visual/scripts/ci/run-lint.sh", set()),
            ("README.md", set()),
            ("plugins/pecot-workflow/skills/w-pr/SKILL.md", set()),
            ("plugins/pecot-visual/CHANGELOG.md", set()),
            ("plugins/pecot-visual/cli/src/infra/drawio/pdf.ts", set()),
            ("plugins/pecot-tools/cli/src/main.ts", set()),
            ("libs/workflow-core/src/commands-shared/output.ts", set()),
        ]
    ),
)
def test_gate_selects_the_githooks_lanes_that_read_the_change(
    nx_bin: Path, tmp_path: Path, changed_file: str, expected: frozenset[str]
) -> None:
    """githooks のレーンだけを対象にした、`nx affected` のテストです。変更したファイルを読む githooks のレーンだけが選ばれ、読まないファイルでは 1 つも選ばれないことを確認します。"""
    with allure.step("test のレーン名を集め、変更したファイルで選ぶ"):
        lanes = _graph_lane_names(nx_bin, tmp_path, "test")
        selected = _selected_lanes(nx_bin, tmp_path, lanes, changed_file)
    with allure.step("選ばれた githooks のレーンが期待どおりであることを確かめる"):
        assert {lane for lane in selected if lane.startswith("githooks:")} == expected


def _probe_workspace_yaml_commit(tmp_path: Path, section: str) -> tuple[Path, str, str]:
    """複製したリポで、`pnpm-workspace.yaml` の `section` の最初の値だけを変えて commit する。

    作業ツリーの nx の設定を写した commit を base、値を変えた commit を head として返す。
    """
    probe = tmp_path / "probe"
    run_attached(
        ["git", "clone", "--local", "--no-hardlinks", "-q", str(_REPO_ROOT), str(probe)],
        check=True,
        capture_output=True,
    )
    (probe / "node_modules").symlink_to(_REPO_ROOT / "node_modules")

    def commit(message: str) -> str:
        identity = [
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
        ]
        for args in (["add", "-A"], ["commit", "-q", "--allow-empty", "-m", message]):
            run_attached(["git", *identity, *args], cwd=probe, check=True, capture_output=True)
        return run_attached(
            ["git", "rev-parse", "HEAD"], cwd=probe, check=True, capture_output=True, text=True
        ).stdout.strip()

    for name in _NX_CONFIG_FILES:
        shutil.copyfile(_REPO_ROOT / name, probe / name)
    base = commit("probe: sync nx config")
    workspace = probe / "pnpm-workspace.yaml"
    text = workspace.read_text(encoding="utf-8")
    before = yaml.safe_load(text)[section]
    # 行末のコメントを除き、値の末尾にだけ付ける。
    bumped = re.sub(
        rf"(^{section}:\n(?:  #.*\n)*  [^\s#][^\s#]*: *[^\s#]+)",
        r"\1-probe",
        text,
        count=1,
        flags=re.M,
    )
    assert yaml.safe_load(bumped)[section] != before, (
        f"pnpm-workspace.yaml の {section} の値を変えられない"
    )
    workspace.write_text(bumped, encoding="utf-8")
    return probe, base, commit(f"probe: bump {section}")


def _selected_lanes_between(
    nx_bin: Path, probe: Path, lanes: list[str], base: str, head: str, nx_state: Path
) -> set[str]:
    """複製したリポで `nx affected -t <lanes> --base --head` が選んだレーンのタスク。"""
    graph_file = probe.parent / "affected-tasks.json"
    result = run_attached(
        [
            str(nx_bin),
            "affected",
            "-t",
            ",".join(lanes),
            f"--base={base}",
            f"--head={head}",
            f"--graph={graph_file}",
        ],
        cwd=probe,
        capture_output=True,
        text=True,
        timeout=180,
        env=_nx_env(
            {
                "NX_CACHE_DIRECTORY": str(nx_state / "cache"),
                "NX_WORKSPACE_DATA_DIRECTORY": str(nx_state / "workspace-data"),
            }
        ),
    )
    assert result.returncode == 0, f"nx 失敗: {result.stderr}"
    if not graph_file.exists():
        return set()
    tasks = json.loads(graph_file.read_text(encoding="utf-8"))["tasks"]["tasks"]
    attach_json("affected-tasks.json のタスク", sorted(tasks))
    return {task for task in tasks if task.split(":")[1] in set(lanes)}


@allure.title(
    "pnpm-workspace.yaml の catalog だけを変えた commit は、base と head の指定で、graph を読む githooks のレーンだけを選ぶ"
)
def test_workspace_catalog_commit_selects_graph_lanes_via_base_head(
    nx_bin: Path, tmp_path: Path
) -> None:
    """複製したリポジトリで、`pnpm-workspace.yaml` の `catalog` の値だけを変更してコミットした場合のテストです。`--base` と `--head` を指定した `nx affected` が、`githooks:test-ci` を選ばず、graph を読む 3 つの githooks のレーンだけを選ぶことを確認します。"""
    with allure.step("probe のリポで catalog の値を変えて commit する"):
        lanes = _graph_lane_names(nx_bin, tmp_path, "test")
        probe, base, head = _probe_workspace_yaml_commit(tmp_path, "catalog")
    with allure.step("base と head でレーンを選ぶ"):
        selected = _selected_lanes_between(nx_bin, probe, lanes, base, head, tmp_path / "nx-state")
    with allure.step("選ばれた githooks のレーンが graph を読む 3 つであることを確かめる"):
        assert {lane for lane in selected if lane.startswith("githooks:")} == _GITHOOKS_GRAPH


@allure.title(
    "pnpm-workspace.yaml の overrides を変えた commit は、base と head の指定で、すべての project を affected にする"
)
def test_workspace_overrides_commit_affects_every_project_via_base_head(
    nx_bin: Path, tmp_path: Path
) -> None:
    """複製したリポジトリで、`pnpm-workspace.yaml` の `overrides` の値を変更してコミットした場合のテストです。`--base` と `--head` を指定した `nx show projects --affected` が、すべての project を返すことを確認します。"""
    with allure.step("probe のリポで overrides の値を変えて commit する"):
        probe, base, head = _probe_workspace_yaml_commit(tmp_path, "overrides")
    with allure.step("base と head で affected を調べ、すべての project が届くことを確かめる"):
        affected = _affected(
            nx_bin, probe, f"--base={base}", f"--head={head}", nx_state=tmp_path / "nx-state"
        )
        assert set(affected) == _EXPECTED_PROJECTS


@allure.title("{lane} は、ワークスペースのすべての package.json を入力として読む")
@pytest.mark.parametrize(
    "lane", ["githooks:test-nx-cache", "githooks:test-nx-affected", "githooks:test-checks"]
)
def test_graph_lanes_read_every_workspace_package_json(
    lane_input_files: dict[str, set[str]], lane: str
) -> None:
    """graph を作る `package.json` の、入力の宣言のテストです。`pnpm-workspace.yaml` の `packages` にある `package.json` とルートの `package.json` が、レーンの入力と過不足なく一致することを確認します。"""
    with allure.step("workspace の package.json の一覧と、追跡するファイルを集める"):
        workspace = yaml.safe_load((_REPO_ROOT / "pnpm-workspace.yaml").read_text(encoding="utf-8"))
        expected = {f"{package}/package.json" for package in workspace["packages"]} | {
            "package.json"
        }
        tracked = run_attached(
            ["git", "ls-files", "--", "*package.json"],
            cwd=_REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.split()
        read = {f for f in lane_input_files[lane] if f in set(tracked)}
    with allure.step("レーンが読む package.json が過不足なく一致することを確かめる"):
        assert read == expected & set(tracked), sorted(read ^ expected)


@allure.title("{changed_file} を変更すると、その変更が届く lint のレーンだけが選ばれる")
@pytest.mark.parametrize(
    ("changed_file", "expected"),
    _lane_cases(
        [
            # pecot-visual の起点の lint（nx:noop）は inputs を持たず、全レーンを連れてこない。
            (
                "plugins/pecot-visual/cli/src/version.ts",
                {"pecot-visual:lint-cli", "interface-spec:lint-defs"},
            ),
            # pecot-tools の lint は実体の target。plugins/pecot-tools/package.json は pecot-visual:lint-cli も読む。
            ("plugins/pecot-tools/package.json", {"pecot-tools:lint", "pecot-visual:lint-cli"}),
            ("plugins/pecot-tools/scripts/ci/pnpm-lib.sh", {"pecot-tools:lint"}),
            # root の package.json は、どのプロジェクトの lint のレーンにも届かない。
            ("package.json", set()),
            # pecot-workflow の lint は lint-cli だけ。
            (
                "plugins/pecot-workflow/cli/src/main.ts",
                {"pecot-workflow:lint-cli", "interface-spec:lint-defs"},
            ),
            # tests/hooks/ のテストも型の確認と eslint の対象。
            (
                "plugins/pecot-workflow/cli/tests/hooks/baseline-scripts.test.ts",
                {"pecot-workflow:lint-cli", "interface-spec:lint-defs"},
            ),
            # libs/workflow-core のソースは、自分の lint・lint-cli・actions の lint に届く。lint-cli と actions の lint は dist を読む。
            # まとめ直した dist の確認と、環境変数を確かめる lint-defs にも届く。
            (
                "libs/workflow-core/src/domain/config.ts",
                {
                    "workflow-core:lint",
                    "pecot-workflow:lint-cli",
                    "pecot-actions:lint",
                    "pecot-actions:lint-dist",
                    "interface-spec:lint-defs",
                },
            ),
            # libs/text-rules の lint は実体の target 1 つ。
            # pecot-visual の lint-slidev は、リンクで載せた libs/text-rules を inputs に持つ (#1297)。
            # lint-cli も text-rules:build に依存し、^production で libs/text-rules を取り込む (#1282)。
            (
                "libs/text-rules/index.ts",
                {
                    "text-rules:lint",
                    "pecot-visual:lint-slidev",
                    "pecot-visual:lint-cli",
                },
            ),
            (
                "libs/text-rules/package.json",
                {
                    "text-rules:lint",
                    "pecot-visual:lint-slidev",
                    "pecot-visual:lint-cli",
                },
            ),
            # interface-spec のソースは lint と lint-defs の両方、定義書（plugins/*/interface/）は lint-defs だけに届く。
            ("libs/interface-spec/src/cli.ts", {"interface-spec:lint", "interface-spec:lint-defs"}),
            (
                "libs/interface-spec/src/domain/diff.ts",
                {
                    "interface-spec:lint",
                    "interface-spec:lint-defs",
                    "pecot-tools:lint",
                    "pecot-visual:lint-cli",
                    "pecot-workflow:lint-cli",
                },
            ),
            (
                "libs/interface-spec/package.json",
                {
                    "interface-spec:lint",
                    "interface-spec:lint-defs",
                    "pecot-tools:lint",
                    "pecot-visual:lint-cli",
                    "pecot-workflow:lint-cli",
                },
            ),
            # lint のレーンの表には、定義書の変更が lint-defs に届くことも置く。
            (
                "plugins/pecot-visual/interface/generated.json",
                {"interface-spec:lint-defs", "pecot-visual:lint-cli"},
            ),
            # describe の題の規則は、interface-spec の lint と、これを読む 8 つの lint に届く。
            (
                "libs/interface-spec/src/eslint/describe-title.ts",
                {
                    "pecot-actions:lint",
                    "interface-spec:lint",
                    "interface-spec:lint-defs",
                    "nx-release:lint-eslint",
                    "pecot-tools:lint",
                    "pecot-visual:lint-cli",
                    "pecot-visual:lint-slidev",
                    "pecot-workflow:lint-cli",
                    "text-rules:lint",
                    "workflow-core:lint",
                },
            ),
            (
                "libs/interface-spec/src/eslint/table-key.ts",
                {
                    "pecot-actions:lint",
                    "interface-spec:lint",
                    "interface-spec:lint-defs",
                    "nx-release:lint-eslint",
                    "pecot-tools:lint",
                    "pecot-visual:lint-cli",
                    "pecot-visual:lint-slidev",
                    "pecot-workflow:lint-cli",
                    "text-rules:lint",
                    "workflow-core:lint",
                },
            ),
            (
                "plugins/pecot-workflow/skills/w-help/references/commands.md",
                {"interface-spec:lint-defs"},
            ),
            (
                "libs/interface-spec/tests/fixtures/valid/plugins/pecot-tools/interface/authored.yaml",
                {"interface-spec:lint"},
            ),
        ]
    ),
)
def test_lint_gate_selects_only_the_lanes_the_change_reaches(
    nx_bin: Path, tmp_path: Path, changed_file: str, expected: frozenset[str]
) -> None:
    """pre-commit の確認と同じ、`nx affected` に lint のレーン名を指定する呼び方のテストです。変更したファイルを読む lint のレーンだけが選ばれることを確認します。"""
    with allure.step("lint のレーン名を集める"):
        lanes = _graph_lane_names(nx_bin, tmp_path, "lint")
    with allure.step("変更したファイルで選ばれるレーンが期待どおりであることを確かめる"):
        assert _selected_lanes(nx_bin, tmp_path, lanes, changed_file) == expected


@allure.title("{kind} のレーン名は、nx-lanes.sh が返す名前と graph から集めた名前が一致する")
@pytest.mark.parametrize("kind", ["test", "lint"])
def test_gate_lane_names_match_the_lib(nx_bin: Path, tmp_path: Path, kind: str) -> None:
    """`.githooks/lib/nx-lanes.sh` の `nx_lane_targets` のテストです。この関数のレーン名が、graph の定義から集めた名前と一致することを確認します。"""
    with allure.step("nx-lanes.sh を動かす"):
        lib = _REPO_ROOT / ".githooks" / "lib" / "nx-lanes.sh"
        result = run_attached(
            ["bash", "-c", f'source "{lib}" && nx_lane_targets "{nx_bin}" "{_REPO_ROOT}" {kind}'],
            capture_output=True,
            text=True,
            timeout=180,
            env=_nx_env(),
        )
    with allure.step("終了コード 0 で、graph から集めたレーン名と一致することを確かめる"):
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip().split(",") == _graph_lane_names(nx_bin, tmp_path, kind)


def _parametrized_changed_files() -> set[str]:
    """このファイルの parametrize が `changed_file` に渡す代表ファイルの全部。"""
    found: set[str] = set()
    for obj in globals().values():
        for mark in getattr(obj, "pytestmark", []):
            if mark.name != "parametrize":
                continue
            raw = mark.args[0]
            names = [n.strip() for n in raw.split(",")] if isinstance(raw, str) else list(raw)
            if "changed_file" not in names:
                continue
            index = names.index("changed_file")
            for value in mark.args[1]:
                found.add(value if len(names) == 1 else value[index])
    return found


# 追跡されないか、runtime 入力（pnpm-lock.yaml の hash）が見るため、一覧に載せないもの。
_NOT_LISTED = {"pnpm-lock.yaml", ".pecot/config/.worktreeignore"}


@allure.title("代表ファイルの一覧は、このファイルの parametrize の代表ファイルと一致する")
def test_representative_files_list_matches_the_parametrized_ones() -> None:
    """`representative-files.txt` のテストです。一覧の内容が、このファイルの `parametrize` が `changed_file` に渡す代表ファイルと一致することを確認します。"""
    with allure.step("runtime の入力が実在を見る一覧を読む"):
        listed = set(
            (_REPO_ROOT / ".githooks/tests/representative-files.txt")
            .read_text(encoding="utf-8")
            .split()
        )
    with allure.step("このファイルの代表ファイルと一致することを確かめる"):
        assert _parametrized_changed_files() - _NOT_LISTED == listed


@allure.title("lint-defs は、すべてのプラグインの定義書を入力に宣言している")
def test_lint_defs_reads_the_definitions_of_every_plugin() -> None:
    """`libs/interface-spec/project.json` のテストです。`lint-defs` の inputs に、`plugins/*/interface/` 以下のすべてのファイルが含まれることを確認します。"""
    with allure.step("lint-defs の inputs を読む"):
        project = json.loads((_REPO_ROOT / "libs/interface-spec/project.json").read_text("utf-8"))
        inputs = project["targets"]["lint-defs"]["inputs"]
    with allure.step("全プラグインの定義書を読む宣言があることを確かめる"):
        assert "{workspaceRoot}/plugins/*/interface/**/*" in inputs


@allure.title("lint-defs の inputs は、各プラグインの sources と tests の glob をすべて含む")
def test_lint_defs_inputs_cover_the_sources_and_tests_of_every_plugin() -> None:
    """`targets.json` に記載した各プラグインの `sources` と `tests` の glob のテストです。それらがすべて、`lint-defs` の inputs に含まれることを確認します。"""
    with allure.step("targets.json と lint-defs の inputs を読む"):
        targets = json.loads((_REPO_ROOT / "libs/interface-spec/targets.json").read_text("utf-8"))
        project = json.loads((_REPO_ROOT / "libs/interface-spec/project.json").read_text("utf-8"))
        inputs = {
            entry.removeprefix("{workspaceRoot}/")
            for entry in project["targets"]["lint-defs"]["inputs"]
            if isinstance(entry, str) and entry.startswith("{workspaceRoot}/")
        }
    with allure.step("各プラグインの sources と tests の glob が inputs に覆われることを確かめる"):
        for name, plugin in targets["plugins"].items():
            base = plugin.get("root", f"plugins/{name}")
            for key in ("sources", "tests"):
                for glob in plugin[key]:
                    # glob は root（既定は plugins/<name>）から、inputs はリポのルートから。
                    path = posixpath.normpath(f"{base}/{glob}")
                    assert path in inputs, (
                        f"{name} の {key} の {glob} が lint-defs の inputs に無い"
                    )


def _matches_by_segment(path: str, glob: str) -> bool:
    """** を使わない glob を、/ で区切った段ごとに比べる。"""
    parts, patterns = path.split("/"), glob.split("/")
    return len(parts) == len(patterns) and all(map(fnmatch.fnmatchcase, parts, patterns))


@allure.title(
    "{src_dir} の .ts を持つディレクトリは、すべて pecot-workflow の sources の glob に含まれる"
)
@pytest.mark.parametrize("src_dir", ["cli/src", "../../libs/workflow-core/src"])
def test_pecot_workflow_sources_list_every_directory_of_cli_node_src(src_dir: str) -> None:
    """`targets.json` の `pecot-workflow` の `sources` のテストです。`tests` を除き、`.ts` を直下に持つディレクトリがすべて、`sources` のいずれかの glob に一致することを確認します。"""
    with allure.step("sources の glob と、.ts を持つディレクトリを集める"):
        sources = json.loads((_REPO_ROOT / "libs/interface-spec/targets.json").read_text("utf-8"))[
            "plugins"
        ]["pecot-workflow"]["sources"]
        globs = [posixpath.normpath(f"plugins/pecot-workflow/{glob}") for glob in sources]
        src = _REPO_ROOT / posixpath.normpath(f"plugins/pecot-workflow/{src_dir}")
        directories = {
            path.parent for path in src.rglob("*.ts") if "tests" not in path.relative_to(src).parts
        }
    with allure.step("どのディレクトリも sources の glob に載ることを確かめる"):
        assert directories, f"{src_dir} に .ts が無い"
        for directory in sorted(directories):
            file = f"{directory.relative_to(_REPO_ROOT).as_posix()}/x.ts"
            assert any(_matches_by_segment(file, glob) for glob in globs), (
                f"{directory.relative_to(_REPO_ROOT).as_posix()} が targets.json の pecot-workflow の sources に無い"
            )
