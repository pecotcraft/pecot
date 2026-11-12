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

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest
import yaml

# parents[0]=tests, [1]=.githooks, [2]=リポルート。
_REPO_ROOT = Path(__file__).resolve().parents[2]

# nx の判定を左右する root 設定ファイル。
# --base/--head ケースの複製リポへ、作業ツリー側の内容を持ち込むために使う。
# 本テストは、未コミットの設定変更も対象にする。
_NX_CONFIG_FILES = (".nxignore", "nx.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "package.json")

# nx が認識する project の集合。入れ子のメンバーは `nx.root` / `nx.name` でプラグインの project へ束ねる (#113)。
_EXPECTED_PROJECTS = {
    "githooks",
    "interface-spec",
    "nx-release",
    "pecot",
    "pecot-tools",
    "pecot-visual",
    "pecot-workflow",
    "text-rules",
}


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
    result = subprocess.run(
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


@pytest.mark.parametrize(
    "changed_file",
    [
        # root lockfile では、@nx/js の lockfile locator が全 project を touched にする。
        # この既定を、.nxignore の /pnpm-lock.yaml で止めている。
        "pnpm-lock.yaml",
    ],
)
def test_outside_project_file_affects_nothing(nx_bin: Path, changed_file: str) -> None:
    assert _affected(nx_bin, _REPO_ROOT, f"--files={changed_file}") == []


@pytest.mark.parametrize(
    "changed_file",
    [
        # markdownlint 設定: nx の lint target は markdownlint を実行しない（実行元は
        # .pre-commit-config.yaml の外部 hook）。sharedGlobals から外して発火を止めている。
        ".markdownlint-cli2.jsonc",
        # プロジェクト外の一般ファイル。どの namedInputs にも載らない。
        ".pecot/config/.worktreeignore",
        # CI で使わない .devcontainer のファイル。sharedGlobals に載せていない。
        ".devcontainer/tmux/pecot-open.sh",
        ".devcontainer/scripts/install-git-hooks.sh",
    ],
)
def test_outside_project_file_affects_only_the_root_project(
    nx_bin: Path, changed_file: str
) -> None:
    """プラグインの外のファイルは、root の project（pecot）だけに属する。pecot はレーンの target を持たない (#113)。"""
    assert _affected(nx_bin, _REPO_ROOT, f"--files={changed_file}") == ["pecot"]


def test_project_set_is_the_expected_one(nx_bin: Path) -> None:
    """project の集合を pin する。入れ子のメンバーが独立した project になると、レーンの選択が崩れる (#113)。"""
    result = subprocess.run(
        [str(nx_bin), "show", "projects", "--json"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=180,
        env=_nx_env(),
    )
    assert result.returncode == 0, f"nx 失敗: {result.stderr}"
    assert set(json.loads(result.stdout.strip().splitlines()[-1])) == _EXPECTED_PROJECTS


@pytest.mark.parametrize(
    ("changed_file", "expected"),
    [
        ("plugins/pecot-workflow/cli/src/cli.ts", {"pecot-workflow"}),
        ("plugins/pecot-visual/cli/src/cli.ts", {"pecot-visual"}),
        ("libs/text-rules/index.ts", {"text-rules"}),
    ],
)
def test_plugin_source_affects_own_projects(
    nx_bin: Path, changed_file: str, expected: set[str]
) -> None:
    # 存在しないパスを --files に渡すと、nx は何も言わずに [] を返す。
    # そのため代表ファイルの移動や改名は、「affected が空」ではなく明示的な失敗として出す。
    assert (_REPO_ROOT / changed_file).exists(), f"代表ファイルが移動している: {changed_file}"
    assert expected <= set(_affected(nx_bin, _REPO_ROOT, f"--files={changed_file}"))


def test_nx_json_still_affects_all_projects(nx_bin: Path) -> None:
    """nx.json は sharedGlobals に残す設計。全 project 発火が生きていることを pin する。"""
    affected = set(_affected(nx_bin, _REPO_ROOT, "--files=nx.json"))
    assert {"pecot-workflow", "pecot-visual", "pecot-tools", "text-rules"} <= affected


@pytest.mark.parametrize(
    "changed_file",
    [
        ".devcontainer/devcontainer.json",
        ".devcontainer/features/playwright-deps/install.sh",
        ".devcontainer/scripts/post-create.sh",
    ],
)
def test_devcontainer_change_affects_all_projects(nx_bin: Path, changed_file: str) -> None:
    """CI のイメージと起動に関わる .devcontainer のファイルは、sharedGlobals で全 project に届く。"""
    assert (_REPO_ROOT / changed_file).exists(), f"代表ファイルが移動している: {changed_file}"
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


def _nx(nx_bin: Path, *args: str) -> str:
    # stdout はパイプでなくファイルで受ける。nx は stdout がパイプのとき大きな JSON を書き切る前に
    # 終了することがあり、切れた出力を受け取って JSONDecodeError になる (#1217)。
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
        assert result.returncode == 0, f"nx 失敗: {result.stderr}"
        out.seek(0)
        return out.read()


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
    return {
        lane: set(json.loads(_nx(nx_bin, "show", "target", "inputs", lane, "--json"))["files"])
        for lane in lanes
    }


def _lanes_reading(lane_input_files: dict[str, set[str]], changed_file: str) -> set[str]:
    assert (_REPO_ROOT / changed_file).exists(), f"代表ファイルが移動している: {changed_file}"
    return {lane for lane, files in lane_input_files.items() if changed_file in files}


@pytest.mark.parametrize(
    ("changed_file", "expected"),
    [
        # pecot-visual の agents/*.md を読むテストは 2 つある。
        # 1 つは v-drawio の references の実在を確認するテストになる。
        # もう 1 つは、スキルとエージェント定義の型を確認するテストで、pecot-workflow の test_agent_definitions (#1231) を指す。
        (
            "plugins/pecot-visual/agents/v-diagram-creator.md",
            {"pecot-visual:test-skills", "pecot-workflow:test-hooks"},
        ),
        # w-e2e-planner.md を読むテストは 2 つある。
        # 1 つは CUJ 定義の単一化を確かめるテストで、test-hooks が持つ (#1091)。
        # 1 つは本文のツール名と入力名を COMMANDS の定義と比べるテスト（cli/tests/skills/）で、test-skills が持つ (#1185, #350)。
        (
            "plugins/pecot-workflow/agents/w-e2e-planner.md",
            {"pecot-workflow:test-hooks", "pecot-workflow:test-skills"},
        ),
        # scripts/ci/tests の *.test.sh を実行するのは、run-tests.sh --scope=skills だけとなる (#1225)。
        # pecotvPluginTestGlobals（pecot-visual 全レーン共有）に置くと、1 ファイルの変更で全レーンが再実行される。
        (
            "plugins/pecot-visual/scripts/ci/tests/references-path-existence.test.sh",
            {"pecot-visual:test-skills"},
        ),
        # fake-aws を使うのは pecot-tools の cli のテストだけ (#1225)。
        ("plugins/pecot-tools/cli/tests/_fixtures/fake-aws/aws", {"pecot-tools:test-cli"}),
        # bin/pecotv を起動するのは cli の E2E と bootstrap のテストだけ (#1225, #1235)。
        (
            "plugins/pecot-visual/bin/pecotv",
            {"pecot-visual:test-cli", "pecot-visual:test-bootstrap"},
        ),
        # Agent Plugins 1.0 形式の manifest を確かめるのは、cli/tests/bootstrap/manifest.sh だけとなる。
        # 版の更新（nx release）は、nx-release の単体テストが読む (#1230, #1235)。
        (
            "plugins/pecot-visual/plugin.json",
            {"pecot-visual:test-bootstrap", "nx-release:test-unit"},
        ),
        ("plugins/pecot-visual/mcp.json", {"pecot-visual:test-bootstrap"}),
        (
            "plugins/pecot-visual/com.github.copilot/hooks/hooks.json",
            {"pecot-visual:test-bootstrap", "pecot-visual:test-hooks", "pecot-workflow:test-hooks"},
        ),
        # hook から実行用ミラーを引く解決のテストは hooks レーンだけ (#1230)。
        (
            "plugins/pecot-visual/hooks/tests/runtime-dir-for-hooks.test.sh",
            {"pecot-visual:test-hooks"},
        ),
        # ミラーの回数・解決順のテストは bootstrap のレーンだけ (#1230, #1235)。
        (
            "plugins/pecot-visual/cli/tests/bootstrap/install-record.sh",
            {"pecot-visual:test-bootstrap"},
        ),
        ("plugins/pecot-visual/cli/tests/bootstrap/data-dir.sh", {"pecot-visual:test-bootstrap"}),
        ("plugins/pecot-tools/cli/tests/bootstrap/data-dir.sh", {"pecot-tools:test-bootstrap"}),
        (
            "plugins/pecot-workflow/cli/tests/bootstrap/data-dir.sh",
            {"pecot-workflow:test-bootstrap"},
        ),
        (
            "plugins/pecot-workflow/cli/tests/bootstrap/install-record.sh",
            {"pecot-workflow:test-bootstrap"},
        ),
        # pecot-workflow の登録ファイルは test-bootstrap が確かめる。com.github.copilot/hooks/hooks.json は hooks のテストも読む。
        (
            "plugins/pecot-workflow/mcp.json",
            {"pecot-workflow:test-bootstrap", "pecot-workflow:test-hooks"},
        ),
        (
            "plugins/pecot-workflow/com.github.copilot/hooks/hooks.json",
            {"pecot-workflow:test-bootstrap", "pecot-workflow:test-hooks"},
        ),
        # 出力の行の期待値は、Node の出力のテストと githooks の一致のテストが読む (#205)。
        (
            "plugins/pecot-workflow/cli/tests/output/cases.json",
            {"pecot-workflow:test-cli", "githooks:test-checks"},
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
    ],
)
def test_out_of_lane_input_reruns_only_consumer_lane(
    lane_input_files: dict[str, set[str]], changed_file: str, expected: set[str]
) -> None:
    """レーンのディレクトリ外の入力は、消費者レーンの inputs だけに宣言する設計を pin する（#1080）。

    nx.json の pecotvPluginTestGlobals（pecot-visual 全レーンが共有）へ戻すと、
    1 ファイルの変更で pecot-visual の全レーンが再実行される。
    """
    assert _lanes_reading(lane_input_files, changed_file) == expected


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
    """SKILL.md の frontmatter を確かめる test_agent_definitions は、pecot-workflow の hooks レーンが持つ (#1231)。

    skills と pecot-visual の SKILL.md は hooks/ の外にある。
    レーンの inputs に直接宣言しないと、nx キャッシュが定義の変更を見逃し、確認が行われなくなる。
    """
    assert "pecot-workflow:test-hooks" in _lanes_reading(lane_input_files, changed_file)


@pytest.mark.parametrize(
    "changed_file",
    [
        "plugins/pecot-workflow/skills/w-pr/SKILL.md",
        "plugins/pecot-workflow/agents/w-e2e-planner.md",
        "plugins/pecot-workflow/cli/src/cli.ts",
    ],
)
def test_skill_body_change_runs_skills_lane(
    lane_input_files: dict[str, set[str]], changed_file: str
) -> None:
    """スキル・エージェント・hooks テンプレートの本文を確認する test-skills は、本文と COMMANDS の変更で動く (#350)。"""
    assert "pecot-workflow:test-skills" in _lanes_reading(lane_input_files, changed_file)


@pytest.mark.parametrize(
    ("changed_file", "release_lane"),
    [
        ("plugins/pecot-visual/cli/src/domain/drawio/url.ts", "pecot-visual:test-release"),
        ("plugins/pecot-visual/skills/v-slidev/SKILL.md", "pecot-visual:test-release"),
        ("plugins/pecot-visual/hooks/hooks.json", "pecot-visual:test-release"),
        ("plugins/pecot-tools/cli/src/cli.ts", "pecot-tools:test-release"),
        ("plugins/pecot-workflow/cli/src/cli.ts", "pecot-workflow:test-release"),
    ],
)
def test_release_lane_is_cached_and_not_run_by_unrelated_changes(
    nx_bin: Path,
    tmp_path: Path,
    lane_input_files: dict[str, set[str]],
    changed_file: str,
    release_lane: str,
) -> None:
    """cli/src・SKILL.md・hooks の変更で release レーンはキャッシュから再利用される（#1080）。

    release レーンは配布ツリー用の dist を自前で build するので、cli/src を inputs に入れない。
    加えてレーンは cache: true なので、inputs に入らない変更では入力ハッシュが変わらない。
    その場合はキャッシュが再利用される。
    外部レジストリの状態はハッシュに表せない。その変化は、リリース時の dry-run と監査で拾う。
    """
    assert release_lane not in _lanes_reading(lane_input_files, changed_file)
    graph_file = tmp_path / "graph.json"
    _nx(nx_bin, "graph", f"--file={graph_file}")
    project, target = release_lane.split(":")
    nodes = json.loads(graph_file.read_text(encoding="utf-8"))["graph"]["nodes"]
    assert nodes[project]["data"]["targets"][target].get("cache") is True


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
    """`.nx/nx-release` のレーンが nx 更新・リリース設定の変更でも再実行される。"""
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


def test_pecotv_test_lanes_depend_on_shared_install_and_build(tmp_path: Path, nx_bin: Path) -> None:
    graph_file = tmp_path / "graph.json"
    _nx(nx_bin, "run-many", "-t", "test", "-p", "pecot-visual", f"--graph={graph_file}")
    tasks = json.loads(graph_file.read_text(encoding="utf-8"))["tasks"]
    # nx 24 の dependencies は、task id から `[{"id": <依存 task id>}]` への対応になる。
    # nx 22 では、id の文字列の配列だった。
    deps = {task: {dep["id"] for dep in entries} for task, entries in tasks["dependencies"].items()}
    lanes = [t for t in tasks["tasks"] if t.startswith("pecot-visual:test-")]
    assert "pecot-visual:test-compare" in lanes, lanes
    for lane in lanes:
        assert "pecot-visual:install" in deps[lane], f"{lane} が install に依存しない"
    for lane in ("pecot-visual:test-cli", "pecot-visual:test-release", "pecot-visual:test-compare"):
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


def test_bootstrap_lanes_wait_for_install_and_pecot_tools_also_for_build_cli(
    tmp_path: Path, nx_bin: Path
) -> None:
    """bootstrap のレーン (#1235) は install を共有し、pecot-tools のレーンは build-cli の後に実行する。

    pecot-tools の `cli/tests/bootstrap/run.sh` は、本体の cli/dist/cli.js を bootstrap が書き換えていないか、mtime で確かめる。
    build-cli が並行すると、dist の再生成を本体への書き込みと誤判定する。
    pecot-visual のレーンは本体の cli/dist を使わないので、build-cli に依存しない。
    """
    graph_file = tmp_path / "graph.json"
    _nx(nx_bin, "run-many", "-t", "test", "-p", "pecot-visual,pecot-tools", f"--graph={graph_file}")
    tasks = json.loads(graph_file.read_text(encoding="utf-8"))["tasks"]
    deps = {task: {dep["id"] for dep in entries} for task, entries in tasks["dependencies"].items()}
    assert "pecot-visual:install" in deps["pecot-visual:test-bootstrap"]
    assert "pecot-visual:build-cli" not in deps["pecot-visual:test-bootstrap"]
    assert {"pecot-tools:install", "pecot-tools:build-cli"} <= deps["pecot-tools:test-bootstrap"]


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


def test_lockfile_only_commit_affects_nothing_via_base_head(nx_bin: Path, tmp_path: Path) -> None:
    probe = tmp_path / "probe"
    # --no-hardlinks は必須とする。
    # tmp_path はリポジトリと別マウントになり得る。
    # devcontainer の bind mount 構成では、実際に別デバイスになる。
    # その場合、既定のハードリンク複製は "Invalid cross-device link" で失敗する。
    subprocess.run(
        ["git", "clone", "--local", "--no-hardlinks", "-q", str(_REPO_ROOT), str(probe)],
        check=True,
        capture_output=True,
    )
    # 複製には node_modules が無いので実体を貼る（nx 本体と plugin 依存の解決用）。
    (probe / "node_modules").symlink_to(_REPO_ROOT / "node_modules")

    def git(*args: str) -> None:
        subprocess.run(
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
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=probe, check=True, capture_output=True, text=True
    ).stdout.strip()

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
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=probe, check=True, capture_output=True, text=True
    ).stdout.strip()

    assert (
        _affected(nx_bin, probe, f"--base={base}", f"--head={head}", nx_state=tmp_path / "nx-state")
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
    wanted = set(lanes)
    return {task for task in tasks if task.split(":")[1] in wanted}


# githooks のレーンのうち、graph を作るファイル（package.json など）に反応する 3 本と、hook・設定のテストの 1 本。
_GITHOOKS_CHECKS = {"githooks:test-checks"}
_GITHOOKS_GRAPH = _GITHOOKS_CHECKS | {"githooks:test-nx-cache", "githooks:test-nx-affected"}

_PECOTV_TEST_LANES = {
    f"pecot-visual:test-{lane}"
    for lane in ("cli", "bootstrap", "slidev", "hooks", "compare", "release", "skills")
}


@pytest.mark.parametrize(
    ("changed_file", "expected"),
    [
        # 1 パッケージのソースだけの変更は、そのソースを読むレーンだけが選ばれる。
        (
            "plugins/pecot-visual/cli/src/version.ts",
            {"pecot-visual:test-cli", "pecot-visual:test-compare"},
        ),
        ("plugins/pecot-tools/cli/src/version.ts", {"pecot-tools:test-cli"}),
        # 起動スクリプトは Globals が全レーンに引く / E2E と bootstrap が起動する (#1235、実 push で確認済み)。
        (
            "plugins/pecot-tools/bin/pecot-tools",
            {"pecot-tools:test-cli", "pecot-tools:test-bootstrap", "pecot-tools:test-release"},
        ),
        (
            "plugins/pecot-visual/bin/pecotv",
            {"pecot-visual:test-cli", "pecot-visual:test-bootstrap"},
        ),
        # setup.sh はどのレーンも読まない (#1235、pecot-visual:test-bootstrap の inputs から外した)。
        ("plugins/pecot-visual/setup.sh", set()),
        # bootstrap の bash テストの変更は、test-bootstrap だけに届く。cli の test は再実行されない (#1235)。
        ("plugins/pecot-visual/cli/tests/bootstrap/data-dir.sh", {"pecot-visual:test-bootstrap"}),
        ("plugins/pecot-tools/cli/tests/bootstrap/data-dir.sh", {"pecot-tools:test-bootstrap"}),
        # root の package.json は pecot-visual の全レーンの Globals と、nx 本体の版を読む nx-release が読む。
        ("package.json", _PECOTV_TEST_LANES | {"nx-release:test-unit"} | _GITHOOKS_GRAPH),
        # libs/text-rules のレーンは 1 本で、テストの変更は test-unit だけを選ぶ。
        # ソースの変更は、配布ツリーに同梱する dist の元になるので、pecot-visual の release レーンにも届く (#1281)。
        # pecot-visual は text-rules をリンク（vendor/text-rules）で載せていて、nx がリンク先の変更を検知しない。
        # そのため text-constraints を使う test-cli / test-hooks / test-slidev も inputs に持つ (#1297)。
        # ミラーを実 build する test-bootstrap も同じ。
        # nx-release の dependabot-plans は、作った plan に check-text をかける (#67)。
        (
            "libs/text-rules/index.ts",
            {
                "text-rules:test-unit",
                "nx-release:test-unit",
                "pecot-visual:test-release",
                "pecot-visual:test-cli",
                "pecot-visual:test-hooks",
                "pecot-visual:test-slidev",
                "pecot-visual:test-bootstrap",
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
                "pecot-visual:test-hooks",
                "pecot-visual:test-slidev",
                "pecot-visual:test-bootstrap",
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
                "pecot-tools:test-bootstrap",
                "pecot-tools:test-release",
                "pecot-visual:test-cli",
                *_GITHOOKS_GRAPH,
            },
        ),
        # 検証対象の wrapper の変更は、bootstrap のレーンに届く。
        # pecot-tools は Globals に持つので、全レーンが再実行される (#1235)。
        (
            "plugins/pecot-tools/bin/_lib.sh",
            {
                "pecot-tools:test-cli",
                "pecot-tools:test-bootstrap",
                "pecot-tools:test-release",
                "pecot-visual:test-bootstrap",
            },
        ),
        # pecot-workflow の Node の CLI のソースは、次のレーンを選ぶ (#1313)。
        # cli/src/ は COMMANDS を持ち、本文を確認する test-skills も読む。
        # test-bootstrap の run.sh は、実の cli/src をミラーに build して tools/list を確かめる。
        # test-hooks の state-directory-resolution は、build 済みの CLI を起動する。
        (
            "plugins/pecot-workflow/cli/src/cli.ts",
            {
                "pecot-workflow:test-cli",
                "pecot-workflow:test-bootstrap",
                "pecot-workflow:test-hooks",
                "pecot-workflow:test-skills",
            },
        ),
        # baseline.json は test-cli の閾値と、test-hooks の起動スクリプトの実在確認と、test-skills の並べ替えの関数（baseline.ts と対）が読む。
        (
            "plugins/pecot-workflow/cli/tests/parity/baseline.json",
            {"pecot-workflow:test-cli", "pecot-workflow:test-hooks", "pecot-workflow:test-skills"},
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
                "pecot-tools:test-cli",
                "pecot-visual:test-cli",
                "pecot-workflow:test-cli",
                *_GITHOOKS_GRAPH,
            },
        ),
        # 定義書の書き出し結果は、一致のテストの pecot-visual:test-cli に届く。
        ("plugins/pecot-visual/interface/generated.json", {"pecot-visual:test-cli"}),
        # 配布物と配布スクリプトの変更は、pecot-workflow の test-release に届く。
        (
            "plugins/pecot-workflow/cli/templates/comment/plan.md",
            {"pecot-workflow:test-cli", "pecot-workflow:test-release"},
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
        # 3 つの publish-mcp-dist.sh が source する共通の関数と、そのテストの変更は、3 つの test-release に届く（lib は githooks のレーンにも届く）。
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
            ".githooks/scripts/tests/mcp-publish-common.test.sh",
            {
                "pecot-tools:test-release",
                "pecot-visual:test-release",
                "pecot-workflow:test-release",
            },
        ),
        # pecot-workflow の定義書は、一致のテストの test-cli に届く。
        ("plugins/pecot-workflow/interface/generated.json", {"pecot-workflow:test-cli"}),
        ("plugins/pecot-workflow/interface/authored.yaml", {"pecot-workflow:test-cli"}),
        # root の lockfile は .nxignore で入力から外す。依存の変更は、各 project の runtime-lock.yaml で届く。
        ("pnpm-lock.yaml", set()),
        (
            "plugins/pecot-workflow/runtime-lock.yaml",
            {
                "pecot-workflow:test-cli",
                "pecot-workflow:test-bootstrap",
                "pecot-workflow:test-hooks",
                "pecot-workflow:test-release",
                "pecot-workflow:test-skills",
                *_GITHOOKS_CHECKS,
            },
        ),
        (
            "plugins/pecot-tools/runtime-lock.yaml",
            {
                "pecot-tools:test-cli",
                "pecot-tools:test-bootstrap",
                "pecot-tools:test-release",
                *_GITHOOKS_CHECKS,
            },
        ),
        # permissions・engineStrict・minimumReleaseAge・skills.dirs は lock に出ないので、workspace も入力にする。
        (
            "plugins/pecot-tools/runtime-workspace.yaml",
            {
                "pecot-tools:test-cli",
                "pecot-tools:test-bootstrap",
                "pecot-tools:test-release",
                *_GITHOOKS_CHECKS,
            },
        ),
        (
            "plugins/pecot-visual/runtime-workspace.yaml",
            {
                "pecot-visual:test-bootstrap",
                "pecot-visual:test-cli",
                "pecot-visual:test-compare",
                "pecot-visual:test-hooks",
                "pecot-visual:test-release",
                "pecot-visual:test-skills",
                "pecot-visual:test-slidev",
                *_GITHOOKS_CHECKS,
            },
        ),
        (
            "plugins/pecot-visual/runtime-lock.yaml",
            {
                "pecot-visual:test-bootstrap",
                "pecot-visual:test-cli",
                "pecot-visual:test-compare",
                "pecot-visual:test-hooks",
                "pecot-visual:test-release",
                "pecot-visual:test-skills",
                "pecot-visual:test-slidev",
                *_GITHOOKS_CHECKS,
            },
        ),
    ],
)
def test_gate_selects_only_the_lanes_the_change_reaches(
    nx_bin: Path, tmp_path: Path, changed_file: str, expected: set[str]
) -> None:
    lanes = _graph_lane_names(nx_bin, tmp_path, "test")
    assert _selected_lanes(nx_bin, tmp_path, lanes, changed_file) == expected


@pytest.mark.parametrize(
    ("changed_file", "expected"),
    [
        # 当たる側。.githooks/ の外のファイルも、テストが読むなら、それを読むレーンが動く。
        (".githooks/ci/run-pr-checks.sh", {"githooks:test-ci"}),
        (".githooks/scripts/gen-runtime-lock.mjs", _GITHOOKS_CHECKS),
        (".githooks/scripts/run-pnpm.sh", _GITHOOKS_CHECKS),
        (".github/board-sync/handler.mjs", _GITHOOKS_CHECKS),
        (".github/board-sync/template.yaml", _GITHOOKS_CHECKS),
        (".github/workflows/dependabot-commit.yml", _GITHOOKS_CHECKS),
        ("plugins/pecot-workflow/scripts/ci/run-tests.sh", _GITHOOKS_CHECKS),
        ("plugins/pecot-workflow/scripts/ci/run-lint.sh", _GITHOOKS_CHECKS),
        ("pyproject.toml", _GITHOOKS_CHECKS),
        ("uv.lock", _GITHOOKS_CHECKS),
        ("pnpm-workspace.yaml", _GITHOOKS_GRAPH),
        ("nx.json", _GITHOOKS_GRAPH | {"githooks:test-ci"}),
        (".nxignore", _GITHOOKS_GRAPH | {"githooks:test-ci"}),
        ("libs/text-rules/project.json", _GITHOOKS_GRAPH),
        # test-checks が読む設定。外れると、整合の確認が古い成功を返す。
        (".pre-commit-config.yaml", _GITHOOKS_CHECKS),
        (".github/workflows/ci.yml", _GITHOOKS_CHECKS),
        (".github/rulesets/main.json", _GITHOOKS_CHECKS),
        (".gitlint", _GITHOOKS_CHECKS),
        (".github/plugin/marketplace.json", _GITHOOKS_CHECKS),
        (".claude-plugin/marketplace.json", _GITHOOKS_CHECKS),
        (".claude/rules/repo-root-layout.md", _GITHOOKS_CHECKS),
        (
            "plugins/pecot-workflow/hooks/lib/session-start/plugin-update-notice.sh",
            _GITHOOKS_CHECKS,
        ),
        ("libs/text-rules/index.ts", _GITHOOKS_CHECKS),
        (
            ".githooks/ci/run-affected-tests.sh",
            _GITHOOKS_CHECKS | {"githooks:test-ci", "githooks:test-nx-cache"},
        ),
        ("libs/text-rules/package.json", _GITHOOKS_GRAPH),
        # 新しいテストのファイルは tests/test_*.py の glob で test-checks に届く。自分のレーンの入力にも載る。
        (".githooks/tests/test_ruleset_main.py", _GITHOOKS_CHECKS),
        (".githooks/tests/test_nx_task_cache.py", _GITHOOKS_CHECKS | {"githooks:test-nx-cache"}),
        # graph を作るファイル。nx は .gitignore に従ってファイルの一覧を作る。
        (".gitignore", _GITHOOKS_GRAPH | {"githooks:test-ci"}),
        ("plugins/pecot-visual/.gitignore", _GITHOOKS_GRAPH),
        # pnpm-workspace.yaml の packages にある package.json だけが graph を作る。
        ("plugins/pecot-visual/cli/tests/fixtures/minimal-slidev/package.json", _GITHOOKS_GRAPH),
        ("plugins/pecot-visual/assets/slidev/scripts/eslint/2layer/package.json", _GITHOOKS_GRAPH),
        # 当たらない側。githooks のレーンは選ばれない。
        ("plugins/pecot-visual/cli/tests/fixtures/themes/with-declaration/package.json", set()),
        ("plugins/pecot-visual/scripts/release/audit-canary/package.json", set()),
        ("plugins/pecot-visual/bin/pecotv", set()),
        ("plugins/pecot-visual/scripts/ci/run-lint.sh", set()),
        ("README.md", set()),
        ("plugins/pecot-workflow/skills/w-pr/SKILL.md", set()),
        ("plugins/pecot-visual/CHANGELOG.md", set()),
        ("plugins/pecot-visual/cli/src/infra/drawio/pdf.ts", set()),
        ("plugins/pecot-tools/cli/tests/bootstrap/run.sh", set()),
        ("plugins/pecot-workflow/cli/src/commands/cell-table.ts", set()),
    ],
)
def test_gate_selects_the_githooks_lanes_that_read_the_change(
    nx_bin: Path, tmp_path: Path, changed_file: str, expected: set[str]
) -> None:
    """githooks のレーンだけを見る。ほかの project も読むファイルは、そちらのレーンも選ぶため。"""
    lanes = _graph_lane_names(nx_bin, tmp_path, "test")
    selected = _selected_lanes(nx_bin, tmp_path, lanes, changed_file)
    assert {lane for lane in selected if lane.startswith("githooks:")} == expected


@pytest.mark.parametrize(
    "lane", ["githooks:test-nx-cache", "githooks:test-nx-affected", "githooks:test-checks"]
)
def test_graph_lanes_read_every_workspace_package_json(
    lane_input_files: dict[str, set[str]], lane: str
) -> None:
    """graph を作る package.json は pnpm-workspace.yaml の packages で決まる。入力が過不足なく追随する。"""
    workspace = yaml.safe_load((_REPO_ROOT / "pnpm-workspace.yaml").read_text(encoding="utf-8"))
    expected = {f"{package}/package.json" for package in workspace["packages"]} | {"package.json"}
    tracked = subprocess.run(
        ["git", "ls-files", "--", "*package.json"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    read = {f for f in lane_input_files[lane] if f in set(tracked)}
    assert read == expected & set(tracked), sorted(read ^ expected)


@pytest.mark.parametrize(
    ("changed_file", "expected"),
    [
        # pecot-visual の起点の lint（nx:noop）は inputs を持たず、全レーンを連れてこない。
        (
            "plugins/pecot-visual/cli/src/version.ts",
            {"pecot-visual:lint-cli", "interface-spec:lint-defs"},
        ),
        # pecot-tools の lint は実体の target。plugins/pecot-tools/package.json は pecot-visual:lint-cli も読む。
        ("plugins/pecot-tools/package.json", {"pecot-tools:lint", "pecot-visual:lint-cli"}),
        # root の package.json は、どのプロジェクトの lint のレーンにも届かない。
        ("package.json", set()),
        # pecot-workflow の lint は lint-cli だけ。
        (
            "plugins/pecot-workflow/cli/src/cli.ts",
            {"pecot-workflow:lint-cli", "interface-spec:lint-defs"},
        ),
        # tests/hooks/ のテストも型の確認と eslint の対象。
        (
            "plugins/pecot-workflow/cli/tests/hooks/baseline-scripts.test.ts",
            {"pecot-workflow:lint-cli", "interface-spec:lint-defs"},
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
        # describe の題の規則は、interface-spec の lint と、これを読む 4 つの lint に届く。
        (
            "libs/interface-spec/src/eslint/describe-title.ts",
            {
                "interface-spec:lint",
                "interface-spec:lint-defs",
                "pecot-tools:lint",
                "pecot-visual:lint-cli",
                "pecot-workflow:lint-cli",
                "text-rules:lint",
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
    ],
)
def test_lint_gate_selects_only_the_lanes_the_change_reaches(
    nx_bin: Path, tmp_path: Path, changed_file: str, expected: set[str]
) -> None:
    lanes = _graph_lane_names(nx_bin, tmp_path, "lint")
    assert _selected_lanes(nx_bin, tmp_path, lanes, changed_file) == expected


@pytest.mark.parametrize("kind", ["test", "lint"])
def test_gate_lane_names_match_the_lib(nx_bin: Path, tmp_path: Path, kind: str) -> None:
    """lib/nx-lanes.sh が返すレーン名は、graph の定義から機械的に集めた名前と一致する。"""
    lib = _REPO_ROOT / ".githooks" / "lib" / "nx-lanes.sh"
    result = subprocess.run(
        ["bash", "-c", f'source "{lib}" && nx_lane_targets "{nx_bin}" "{_REPO_ROOT}" {kind}'],
        capture_output=True,
        text=True,
        timeout=180,
        env=_nx_env(),
    )
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


def test_representative_files_list_matches_the_parametrized_ones() -> None:
    """githooks:test-nx-affected の runtime 入力が実在を見る一覧は、このファイルの代表ファイルと一致する。"""
    listed = set(
        (_REPO_ROOT / ".githooks/tests/representative-files.txt")
        .read_text(encoding="utf-8")
        .split()
    )
    assert _parametrized_changed_files() - _NOT_LISTED == listed


def test_lint_defs_reads_the_definitions_of_every_plugin() -> None:
    """定義書は plugins/*/interface/ に置かれる。実在を要る選び方のテストでなく、入力の宣言で固定する。"""
    project = json.loads((_REPO_ROOT / "libs/interface-spec/project.json").read_text("utf-8"))
    inputs = project["targets"]["lint-defs"]["inputs"]
    assert "{workspaceRoot}/plugins/*/interface/**/*" in inputs


def test_lint_defs_inputs_cover_the_sources_and_tests_of_every_plugin() -> None:
    """targets.json の各プラグインの sources と tests の glob が、lint-defs の inputs に覆われる。

    覆われないと、ソースの環境変数の読みが増えても nx affected が lint-defs を選ばず、キャッシュも当たる。
    plugins が空の間は何も確かめない。
    """
    targets = json.loads((_REPO_ROOT / "libs/interface-spec/targets.json").read_text("utf-8"))
    project = json.loads((_REPO_ROOT / "libs/interface-spec/project.json").read_text("utf-8"))
    inputs = {
        entry.removeprefix("{workspaceRoot}/")
        for entry in project["targets"]["lint-defs"]["inputs"]
        if isinstance(entry, str) and entry.startswith("{workspaceRoot}/")
    }
    for name, plugin in targets["plugins"].items():
        for key in ("sources", "tests"):
            for glob in plugin[key]:
                # glob は plugins/<name>/ から、inputs はリポのルートから。
                path = f"plugins/{name}/{glob}"
                assert path in inputs, f"{name} の {key} の {glob} が lint-defs の inputs に無い"


def test_pecot_workflow_sources_list_every_directory_of_cli_node_src() -> None:
    """cli/src の .ts を直下に持つディレクトリ（tests は除く）が、どれも sources の glob に載る。

    sources は ** を使わずディレクトリを列挙するので、載らないと環境変数の確認から漏れる。
    """
    sources = json.loads((_REPO_ROOT / "libs/interface-spec/targets.json").read_text("utf-8"))[
        "plugins"
    ]["pecot-workflow"]["sources"]
    plugin_root = _REPO_ROOT / "plugins/pecot-workflow"
    src = plugin_root / "cli/src"
    directories = {
        path.parent for path in src.rglob("*.ts") if "tests" not in path.relative_to(src).parts
    }
    assert directories, "cli/src に .ts が無い"
    for directory in sorted(directories):
        glob = f"{directory.relative_to(plugin_root).as_posix()}/*.ts"
        assert glob in sources, f"{glob} が targets.json の pecot-workflow の sources に無い"
