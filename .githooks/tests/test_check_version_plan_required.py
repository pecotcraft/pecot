"""check-version-plan-required.sh のユニットテスト。

temp repo は実 nx ワークスペースではないため、PATH 先頭の nx スタブが graph を返す（stub_nx）。
実 nx に対する判定は末尾の「実 nx」節で pin する。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_IGNORE_GLOBS = ["README.md", "CHANGELOG.md"]


def _nx_json(root_globs=_IGNORE_GLOBS, group_vp: dict | None = None) -> str:
    """実 nx.json と同型の release.groups（1 プラグイン = 1 project）。

    root_globs が None なら root の versionPlans は true。group_vp は group 名 → その group の versionPlans。
    """
    groups = {}
    for name in ("pecot-workflow", "pecot-visual", "pecot-tools", "text-rules"):
        groups[name] = {"projects": [name], "projectsRelationship": "fixed"}
        if group_vp and name in group_vp:
            groups[name]["versionPlans"] = group_vp[name]
    root_vp = True if root_globs is None else {"ignorePatternsForPlanCheck": root_globs}
    release = {"projectsRelationship": "independent", "groups": groups, "versionPlans": root_vp}
    return json.dumps({"release": release}, indent=2) + "\n"


_NX_JSON = _nx_json()

# project 名 → projectRoot の対応（nx スタブが graph の nodes として返す）。
# pecot-workflowx は root の前方一致で plugins/pecot-workflow に吸われないことの確認用。
_NX_ROOTS = """pecot-workflow=plugins/pecot-workflow
pecot-visual=plugins/pecot-visual
pecot-tools=plugins/pecot-tools
text-rules=libs/text-rules
nx-release=.nx/nx-release
pecot-workflowx=plugins/pecot-workflowx"""

# PATH 先頭に置く nx スタブ本体。`nx graph --file=<path>` だけに答える。
# STUB_NX_GRAPH_FAIL=1 なら graph の生成に失敗する。
_NX_STUB = r"""#!/bin/bash
[ "$1" = graph ] || exit 1
[ "${STUB_NX_GRAPH_FAIL:-0}" = 1 ] && exit 1
out=
for a in "$@"; do
    case "$a" in --file=*) out="${a#--file=}" ;; esac
done
[ -n "$out" ] || exit 1
printf '%s\n' "${STUB_NX_ROOTS:-}" | node -e '
    let d = "";
    process.stdin.on("data", (c) => { d += c; });
    process.stdin.on("end", () => {
        const nodes = {};
        for (const line of d.split("\n")) {
            const i = line.indexOf("=");
            if (i < 0) continue;
            const name = line.slice(0, i);
            nodes[name] = { name, data: { root: line.slice(i + 1) } };
        }
        require("fs").writeFileSync(
            process.argv[1],
            JSON.stringify({ graph: { nodes, dependencies: {} } }),
        );
    });
' "$out"
"""


class _VprRepo:
    """check-version-plan-required.sh テスト用の temp repo 操作ヘルパ。"""

    def __init__(self, repo: Path, mock_bin, git, git_rev_parse) -> None:
        self.repo = repo
        self.mock_bin = mock_bin
        self._git = git
        self._git_rev_parse = git_rev_parse
        self.main_sha = git_rev_parse(repo, "HEAD")
        self.feature_sha: str | None = None
        # stub_nx が export する env（run_script へ渡す）。
        self.nx_env: dict[str, str] = {}

    # --- git ショートカット（repo 固定）-------------------------------------
    def git(self, *args: str):
        return self._git(self.repo, *args)

    def head_sha(self) -> str:
        return self._git_rev_parse(self.repo, "HEAD")

    # --- nx スタブ -----------------------------------------------------------
    def stub_nx(self) -> None:
        """nx スタブを PATH 先頭に設置し STUB_NX_ROOTS を用意する。"""
        self.mock_bin.install("nx", _NX_STUB)
        self.nx_env["STUB_NX_ROOTS"] = _NX_ROOTS

    # --- origin/* 擬似生成 ---------------------------------------------------
    def fake_remote_ref(self, ref: str, sha: str) -> None:
        self._git(self.repo, "update-ref", f"refs/remotes/origin/{ref}", sha)

    def fake_origin_head(self, ref: str) -> None:
        self._git(
            self.repo,
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            f"refs/remotes/origin/{ref}",
        )

    # --- plan 生成 -----------------------------------------------------------
    def make_plan(self, rel_path: str, proj: str) -> None:
        path = self.repo / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"---\n{proj}: patch\n---\n\nplan body\n")

    # --- 共通シナリオ --------------------------------------------------------
    def build_base_with_plan(self) -> None:
        """main に既存 plan を merge 済みにする（main_sha を更新）。#185 回帰防止。"""
        self.make_plan(".nx/version-plans/000-existing.md", "pecot-workflow")
        self._git(self.repo, "add", ".nx/version-plans/000-existing.md")
        self._git(self.repo, "commit", "-q", "-m", "chore: existing plan on main")
        self.main_sha = self._git_rev_parse(self.repo, "HEAD")

    def build_feature(
        self,
        *,
        rel_path: str = "plugins/pecot-workflow/cli/probe.py",
        content: str = "print('probe')\n",
        message: str = "feat(pecot-workflow): probe",
        plan_group: str | None = None,
        plan_path: str = ".nx/version-plans/100-feature-plan.md",
    ) -> str:
        """main(既存 plan merge 済)→feature を構築する。

        既定は pecot-workflow 配下の変更・plan 未同梱。plan_group を渡すと同じ commit へ
        その group を宣言する version plan を同梱する。戻り値は feature の HEAD sha
        （self.feature_sha にも入る）。
        """
        self.build_base_with_plan()
        self._git(self.repo, "checkout", "-q", "-b", "feature")
        probe = self.repo / rel_path
        probe.parent.mkdir(parents=True, exist_ok=True)
        probe.write_text(content)
        paths = [rel_path]
        if plan_group is not None:
            self.make_plan(plan_path, plan_group)
            paths.append(plan_path)
        self._git(self.repo, "add", *paths)
        self._git(self.repo, "commit", "-q", "-m", message)
        self.feature_sha = self._git_rev_parse(self.repo, "HEAD")
        self.fake_remote_ref("main", self.main_sha)
        self.fake_origin_head("main")
        return self.feature_sha


@pytest.fixture
def vpr_repo(git_repo: Callable[..., Path], mock_bin, git, git_rev_parse) -> _VprRepo:
    """init/初期コミット（nx.json 同梱）済みの temp repo を構築する。nx は本体の node_modules/nx を借りる。"""
    host_nx = _REPO_ROOT / "node_modules" / "nx"
    if not host_nx.exists():
        pytest.skip(
            "node_modules/nx が無い（install 前）ため、hook が ignore を解決できず skip する"
        )
    repo = git_repo("repo", initial_branch="main")
    (repo / "node_modules").mkdir()
    (repo / "node_modules" / "nx").symlink_to(host_nx)
    with (repo / ".git" / "info" / "exclude").open("a") as f:
        f.write("node_modules\n")
    for d in (
        "plugins/pecot-workflow/cli/pecot",
        "plugins/pecot-workflow/skills",
        "plugins/pecot-workflow/hooks",
        "plugins/pecot-visual/cli",
        "plugins/pecot-visual/hooks",
        "plugins/pecot-visual/assets/slidev",
        "plugins/pecot-visual/skills/v-slidev",
        "plugins/pecot-visual/skills/v-drawio",
        "plugins/pecot-tools/cli",
        "libs/text-rules/tests",
        ".nx/version-plans",
        ".nx/nx-release",
    ):
        (repo / d).mkdir(parents=True, exist_ok=True)
    (repo / "README.md").write_text("main\n")
    (repo / "nx.json").write_text(_NX_JSON)
    git(repo, "add", "README.md", "nx.json")
    git(repo, "commit", "-q", "-m", "chore: init")
    return _VprRepo(repo, mock_bin, git, git_rev_parse)


def _run(script_dir: Path, h: _VprRepo, run_script, *, to_ref: str | None = None, env=None):
    full_env = dict(h.nx_env)
    if to_ref is not None:
        full_env["PRE_COMMIT_TO_REF"] = to_ref
    if env:
        full_env.update(env)
    return run_script(
        script_dir.parent / "pre-push" / "check-version-plan-required.sh",
        cwd=h.repo,
        env=full_env,
    )


# 基本の判定


def _commit_feature(h: _VprRepo, files: dict[str, str], message: str = "feat: probe") -> str:
    """main(既存 plan merge 済)→feature で files を 1 commit にし、feature の sha を返す。"""
    h.build_base_with_plan()
    h.git("checkout", "-q", "-b", "feature")
    for rel, content in files.items():
        path = h.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    h.git("add", *files)
    h.git("commit", "-q", "-m", message)
    h.fake_remote_ref("main", h.main_sha)
    h.fake_origin_head("main")
    return h.head_sha()


def _plan(group: str) -> str:
    return f"---\n{group}: patch\n---\n\nplan body\n"


def test_01_block_no_plan(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """1. pecot-workflow のファイルを変更 / plan 未同梱 → block (exit 1)。"""
    vpr_repo.build_feature()
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=vpr_repo.feature_sha)
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "ERROR:" in out
    assert "release group [pecot-workflow]" in out


def test_02_pass_feature_adds_own_plan(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """2. feature が自分の plan(pecot-workflow)を追加 → pass。"""
    vpr_repo.build_feature()
    vpr_repo.stub_nx()
    vpr_repo.make_plan(".nx/version-plans/100-my-plan.md", "pecot-workflow")
    vpr_repo.git("add", ".nx/version-plans/100-my-plan.md")
    vpr_repo.git("commit", "-q", "-m", "chore: add version plan")
    result = _run(script_dir, vpr_repo, run_script, to_ref=vpr_repo.head_sha())
    assert result.returncode == 0


def test_03_pass_doc_only_readme(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """3. README.md だけの変更 → pass。"""
    feature_sha = _commit_feature(vpr_repo, {"plugins/pecot-workflow/README.md": "docs update\n"})
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0


def test_04_pass_release_commit(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """4. release commit (chore(release): ...) → pass。"""
    feature_sha = _commit_feature(
        vpr_repo,
        {"plugins/pecot-workflow/cli/pecot/probe.py": "print('probe')\n"},
        message="chore(release): v1.0",
    )
    # release commit 判定は nx 呼び出し前に pass するためスタブ不要。
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0


def test_05a_explicit_base_override_block(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """5a. PECOT_VERSION_PLAN_BASE で明示 override → 指定 ref で判定 / block。"""
    vpr_repo.build_feature()
    vpr_repo.stub_nx()
    vpr_repo.fake_remote_ref("custom-base", vpr_repo.main_sha)
    result = _run(
        script_dir,
        vpr_repo,
        run_script,
        to_ref=vpr_repo.feature_sha,
        env={"PECOT_VERSION_PLAN_BASE": "origin/custom-base"},
    )
    assert result.returncode == 1
    assert "ERROR:" in (result.stdout + result.stderr)


def test_05b_nonexistent_base_skips(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """5b. PECOT_VERSION_PLAN_BASE=存在しない ref → skip (exit 0 / WARN)。"""
    vpr_repo.build_feature()
    vpr_repo.stub_nx()
    result = _run(
        script_dir,
        vpr_repo,
        run_script,
        to_ref=vpr_repo.feature_sha,
        env={"PECOT_VERSION_PLAN_BASE": "refs/non-existent"},
    )
    assert result.returncode == 0
    assert "WARN" in (result.stdout + result.stderr)


def test_06_block_main_direct_branch(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """6. 既存 plan なしの main 直分岐 → origin/HEAD(main) で判定 → block。"""
    vpr_repo.git("checkout", "-q", "-b", "feature")
    probe = vpr_repo.repo / "plugins/pecot-workflow/cli/pecot/probe.py"
    probe.write_text("print('probe')\n")
    vpr_repo.git("add", "plugins/pecot-workflow/cli/pecot/probe.py")
    vpr_repo.git("commit", "-q", "-m", "feat(pecot-workflow): probe single-repo")
    feature_sha = vpr_repo.head_sha()
    vpr_repo.fake_remote_ref("main", vpr_repo.main_sha)
    vpr_repo.fake_origin_head("main")
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    assert "ERROR:" in (result.stdout + result.stderr)


def test_07_pass_origin_head_over_develop_pecot(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """7. 残存 origin/develop-aist がいても origin/HEAD(main) を採用 (#702)。"""
    vpr_repo.git("checkout", "-q", "-b", "develop-aist")
    vpr_repo.make_plan(".nx/version-plans/000-existing.md", "pecot-workflow")
    vpr_repo.git("add", ".nx/version-plans/000-existing.md")
    vpr_repo.git("commit", "-q", "-m", "chore: existing plan on develop-aist")
    dev_sha = vpr_repo.head_sha()

    vpr_repo.git("checkout", "-q", "-b", "feature")
    probe = vpr_repo.repo / "plugins/pecot-workflow/cli/pecot/probe.py"
    probe.write_text("print('probe')\n")
    vpr_repo.git("add", "plugins/pecot-workflow/cli/pecot/probe.py")
    vpr_repo.git("commit", "-q", "-m", "feat(pecot-workflow): probe from develop-aist")
    feature_sha = vpr_repo.head_sha()

    vpr_repo.fake_remote_ref("main", vpr_repo.main_sha)
    vpr_repo.fake_remote_ref("develop-aist", dev_sha)
    vpr_repo.fake_origin_head("main")
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0


def test_08_block_plan_declares_wrong_group(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """8. pecot-workflow を変更したが plan は pecot-visual のみ宣言 → block (宣言と変更の対応)。"""
    vpr_repo.build_feature(plan_group="pecot-visual")
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=vpr_repo.feature_sha)
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "ERROR:" in out
    assert "release group [pecot-workflow]" in out


def test_09_nx_unresolved_skips(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """9. nx 解決不能 (nx 未インストール) → skip (exit 0 / WARN)。"""
    vpr_repo.build_feature()
    # stub_nx を呼ばない。PATH 上と node_modules のどちらにも nx は無い。
    result = _run(script_dir, vpr_repo, run_script, to_ref=vpr_repo.feature_sha)
    assert result.returncode == 0
    assert "WARN" in (result.stdout + result.stderr)


def test_10_nx_graph_failure_skips(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """10. nx graph の生成に失敗 → skip (exit 0 / WARN)。"""
    vpr_repo.build_feature()
    vpr_repo.stub_nx()
    vpr_repo.nx_env["STUB_NX_GRAPH_FAIL"] = "1"
    result = _run(script_dir, vpr_repo, run_script, to_ref=vpr_repo.feature_sha)
    assert result.returncode == 0
    assert "WARN" in (result.stdout + result.stderr)


# touched の判定（持ち主の project と release group）


def test_11_pass_root_config_only(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """11. ルート設定 (nx.json) だけの変更 → どの project にも属さないので pass。

    nx.json は nx affected では全 project を affected にするが、touched ではない
    （`nx release plan:check` と同じ）。
    """
    vpr_repo.build_base_with_plan()
    vpr_repo.git("checkout", "-q", "-b", "feature")
    (vpr_repo.repo / "nx.json").write_text(_NX_JSON + "\n")
    vpr_repo.git("add", "nx.json")
    vpr_repo.git("commit", "-q", "-m", "chore: tweak root config")
    vpr_repo.fake_remote_ref("main", vpr_repo.main_sha)
    vpr_repo.fake_origin_head("main")
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=vpr_repo.head_sha())
    assert result.returncode == 0


def test_12_pass_files_outside_projects(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """12. どの project にも属さないファイル（.githooks 等）だけの変更 → pass。"""
    feature_sha = _commit_feature(vpr_repo, {".githooks/pre-commit/probe.sh": "echo probe\n"})
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0


def test_13_pass_project_outside_groups(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """13. release group に入っていない project（nx-release）だけの変更 → pass。"""
    feature_sha = _commit_feature(vpr_repo, {".nx/nx-release/src/probe.js": "// probe\n"})
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0


def test_14_block_nested_dir_maps_to_plugin(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """14. プラグイン配下の深いディレクトリの変更も、そのプラグインの group に写る。"""
    feature_sha = _commit_feature(
        vpr_repo, {"plugins/pecot-visual/skills/v-drawio/references/x.md": "ref\n"}
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    assert "release group [pecot-visual]" in (result.stdout + result.stderr)


def test_15_block_skill_md_only(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """15. SKILL.md のみの変更 → block (doc 除外は README.md/CHANGELOG.md のみ)。"""
    feature_sha = _commit_feature(
        vpr_repo, {"plugins/pecot-workflow/skills/foo/SKILL.md": "skill doc\n"}
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "ERROR:" in out
    assert "release group [pecot-workflow]" in out


def test_16_block_mixed_doc_and_code(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """16. README.md とコードを同じ group で変更 → block。"""
    feature_sha = _commit_feature(
        vpr_repo,
        {
            "plugins/pecot-visual/skills/v-drawio/README.md": "docs\n",
            "plugins/pecot-visual/cli/probe.ts": "export const x = 1;\n",
        },
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    assert "release group [pecot-visual]" in (result.stdout + result.stderr)


def test_17_pass_doc_only_across_dirs(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """17. 複数ディレクトリの README.md / CHANGELOG.md だけの変更 → pass。"""
    feature_sha = _commit_feature(
        vpr_repo,
        {
            "plugins/pecot-visual/skills/v-drawio/README.md": "docs\n",
            "plugins/pecot-visual/cli/CHANGELOG.md": "log\n",
        },
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0


def test_18_pass_other_group_file_in_test_inputs(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """18. pecot-visual の project.json だけを変更 → pecot-visual の宣言だけで pass。

    実 nx では pecot-workflow の test-hooks の inputs がこのファイルを参照する。
    そのため nx affected では pecot-workflow も affected になる。
    ただし touched ではないので、宣言を求めない。
    """
    feature_sha = _commit_feature(
        vpr_repo,
        {
            "plugins/pecot-visual/project.json": '{"name": "pecot-visual"}\n',
            ".nx/version-plans/100-visual.md": _plan("pecot-visual"),
        },
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0, result.stdout + result.stderr


def test_19_pass_root_prefix_is_not_owner(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """19. plugins/pecot-workflowx 配下は plugins/pecot-workflow の持ち物ではない → pass。

    root の判定を `/` 区切りなしの前方一致にすると pecot-workflow に吸われる。境界を固定する。
    """
    feature_sha = _commit_feature(vpr_repo, {"plugins/pecot-workflowx/probe.py": "print(1)\n"})
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0
    assert "release group [pecot-workflow]" not in (result.stdout + result.stderr)


def _set_nx_json(h: _VprRepo, text: str) -> None:
    """hook が読む作業ツリーの nx.json を差し替える（commit しない）。"""
    (h.repo / "nx.json").write_text(text)


def test_17b_block_readme_without_glob_in_nx_json(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """17b. nx.json に glob が無い（versionPlans: true）→ README.md だけでも block。"""
    feature_sha = _commit_feature(vpr_repo, {"plugins/pecot-workflow/README.md": "docs\n"})
    _set_nx_json(vpr_repo, _nx_json(root_globs=None))
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    assert "release group [pecot-workflow]" in (result.stdout + result.stderr)


def test_17c_pass_txt_with_glob_added(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """17c. root の glob に *.txt を足す → .txt だけの変更は pass。足さなければ block。"""
    feature_sha = _commit_feature(vpr_repo, {"plugins/pecot-workflow/cli/a.txt": "x\n"})
    vpr_repo.stub_nx()
    blocked = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert blocked.returncode == 1
    _set_nx_json(vpr_repo, _nx_json(root_globs=[*_IGNORE_GLOBS, "*.txt"]))
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0, result.stdout + result.stderr


def test_17d_group_true_cancels_root_glob(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """17d. group が versionPlans: true を書くと root の glob は使われない。ほかの group は継承する。"""
    feature_sha = _commit_feature(
        vpr_repo,
        {
            "plugins/pecot-workflow/README.md": "docs\n",
            "plugins/pecot-visual/README.md": "docs\n",
        },
    )
    _set_nx_json(vpr_repo, _nx_json(group_vp={"pecot-workflow": True}))
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "release group [pecot-workflow]" in out
    assert "pecot-visual" not in out.split("release group [")[1].split("]")[0]


def test_17e_pass_other_group_inherits_root_glob(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """17e. 17d と同じ nx.json で、ほかの group の README.md だけの変更は pass。"""
    feature_sha = _commit_feature(vpr_repo, {"plugins/pecot-visual/README.md": "docs\n"})
    _set_nx_json(vpr_repo, _nx_json(group_vp={"pecot-workflow": True}))
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0, result.stdout + result.stderr


def test_17f_pass_readme_case_insensitive(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """17f. readme.md（小文字）も pass。nx の ignore() と同じく大文字小文字を区別しない。"""
    feature_sha = _commit_feature(vpr_repo, {"plugins/pecot-workflow/readme.md": "docs\n"})
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0, result.stdout + result.stderr


def test_17g_ignore_unresolved_skips(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """17g. nx 配下の ignore を解決できない → 専用の WARN を出して skip (exit 0)。"""
    feature_sha = _commit_feature(vpr_repo, {"plugins/pecot-workflow/cli/probe.py": "x = 1\n"})
    (vpr_repo.repo / "node_modules" / "nx").unlink()
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha, env={"NODE_PATH": ""})
    assert result.returncode == 0
    assert "nx 配下の ignore を解決できないため version plan check を skip" in result.stderr


# version plan の宣言


def test_20_block_empty_bump_value(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """20. plan の bump 値が空 → 宣言扱いされず block。"""
    feature_sha = _commit_feature(
        vpr_repo,
        {
            "plugins/pecot-workflow/cli/pecot/probe.py": "print('probe')\n",
            ".nx/version-plans/300-empty-bump.md": "---\npecot-workflow:\n---\n\nplan body\n",
        },
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    assert "ERROR:" in (result.stdout + result.stderr)


def test_21_block_non_group_key_plan(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """21. plan が group 名以外のキー (pecot-visual-drawio) で宣言 → 宣言扱いされず block。"""
    feature_sha = _commit_feature(
        vpr_repo,
        {
            "plugins/pecot-visual/skills/v-drawio/SKILL.md": "drawio change\n",
            ".nx/version-plans/616-subdir-key.md": _plan("pecot-visual-drawio"),
        },
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    assert "release group [pecot-visual]" in (result.stdout + result.stderr)


def test_22_block_both_plugins(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """22. pecot-workflow と pecot-visual を変更 / plan 未同梱 → 両 group を列挙して block。"""
    feature_sha = _commit_feature(
        vpr_repo,
        {
            "plugins/pecot-workflow/cli/pecot/probe.py": "print('probe')\n",
            "plugins/pecot-visual/cli/probe.ts": "export const x = 1;\n",
        },
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    assert "release group [pecot-visual pecot-workflow]" in (result.stdout + result.stderr)


def test_23_block_only_missing_group_listed(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """23. 2 group を変更し片方だけ宣言 → 宣言の無い group だけを挙げて block。"""
    feature_sha = _commit_feature(
        vpr_repo,
        {
            "plugins/pecot-tools/cli/probe.ts": "export const x = 1;\n",
            "plugins/pecot-visual/cli/probe.ts": "export const x = 1;\n",
            ".nx/version-plans/1052-tools.md": _plan("pecot-tools"),
        },
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    assert "release group [pecot-visual]" in (result.stdout + result.stderr)


def test_24_pass_pecot_tools_plan(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """24. pecot-tools を変更 + plan が pecot-tools を宣言 → pass。"""
    feature_sha = vpr_repo.build_feature(
        rel_path="plugins/pecot-tools/cli/probe.ts",
        content="export const x = 1;\n",
        message="feat(pecot-tools): probe",
        plan_group="pecot-tools",
        plan_path=".nx/version-plans/1052-tools.md",
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0


def test_24b_block_libs_project_without_plan(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """24b. libs/text-rules を変更 / plan 未同梱 → release group [text-rules] で block。"""
    vpr_repo.build_feature(
        rel_path="libs/text-rules/index.ts",
        content="export const x = 1;\n",
        message="feat(text-rules): probe",
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=vpr_repo.feature_sha)
    assert result.returncode == 1
    assert "release group [text-rules]" in (result.stdout + result.stderr)


def test_24c_pass_libs_project_with_text_rules_plan(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """24c. libs/text-rules を変更 + plan が text-rules を宣言 → pass。"""
    feature_sha = vpr_repo.build_feature(
        rel_path="libs/text-rules/index.ts",
        content="export const x = 1;\n",
        message="feat(text-rules): probe",
        plan_group="text-rules",
        plan_path=".nx/version-plans/1278-text-rules.md",
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 0


def test_25_block_three_groups(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """25. 3 group を変更 / plan 未同梱 → 3 group を列挙して block。"""
    feature_sha = _commit_feature(
        vpr_repo,
        {
            "plugins/pecot-workflow/cli/pecot/probe.py": "print('probe')\n",
            "plugins/pecot-visual/cli/probe.ts": "export const x = 1;\n",
            "plugins/pecot-tools/cli/probe.ts": "export const x = 1;\n",
        },
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    # sort 済み。末尾の `t` (0x74) < `v` (0x76) < `w` (0x77) の順で並ぶ。
    assert "release group [pecot-tools pecot-visual pecot-workflow]" in (
        result.stdout + result.stderr
    )


def test_26_block_non_ascii_path(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """26. 非 ASCII パスの変更もクォートされずに持ち主の project へ写る → block。"""
    feature_sha = _commit_feature(
        vpr_repo, {"plugins/pecot-visual/skills/日本語/SKILL.md": "日本語の skill\n"}
    )
    vpr_repo.stub_nx()
    result = _run(script_dir, vpr_repo, run_script, to_ref=feature_sha)
    assert result.returncode == 1
    assert "release group [pecot-visual]" in (result.stdout + result.stderr)


def test_27_no_temp_files_left(script_dir: Path, vpr_repo: _VprRepo, run_script) -> None:
    """27. 判定後に .pecot/tmp の一時ファイルが残らない。"""
    vpr_repo.build_feature()
    vpr_repo.stub_nx()
    _run(script_dir, vpr_repo, run_script, to_ref=vpr_repo.feature_sha)
    tmp = vpr_repo.repo / ".pecot" / "tmp"
    assert list(tmp.iterdir()) == [] if tmp.exists() else True


def test_28_error_nested_project_outside_group(
    script_dir: Path, vpr_repo: _VprRepo, run_script
) -> None:
    """28. group に属さない project がプラグイン project の配下にある → ERROR (exit 1)。

    変更が README だけでも構成の誤りとして止める（判定不能のまま素通ししない）。
    """
    vpr_repo.build_feature(rel_path="plugins/pecot-workflow/cli/pecot/README.md")
    vpr_repo.stub_nx()
    vpr_repo.nx_env["STUB_NX_ROOTS"] = _NX_ROOTS + "\npecot-workflow-cli=plugins/pecot-workflow/cli"
    result = _run(script_dir, vpr_repo, run_script, to_ref=vpr_repo.feature_sha)
    assert result.returncode == 1
    out = result.stdout + result.stderr
    assert "ERROR:" in out
    assert "pecot-workflow-cli" in out
    assert "1 プラグイン = 1 nx project" in out


# 実 nx（スタブでは捕捉できない project graph と affected の関係を pin する）
#
# 使い捨て clone に実 nx（NX_DAEMON=false）を向け、ケースごとにブランチを切って hook を実行する。
# clone は 1 回だけ作る。node_modules/.bin/nx が無ければ skip。

_NX_BIN = _REPO_ROOT / "node_modules" / ".bin" / "nx"


def _clean_env(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["NX_DAEMON"] = "false"
    env.update(extra)
    return env


class _RealNx:
    def __init__(self, probe: Path) -> None:
        self.probe = probe

    def git(self, *args: str) -> str:
        return subprocess.run(
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
            cwd=self.probe,
            check=True,
            capture_output=True,
            text=True,
            env=_clean_env(),
        ).stdout

    def tracked(self, prefix: str, suffix: str = "") -> str:
        files = self.git("ls-files", prefix).splitlines()
        return next(
            f for f in files if f.endswith(suffix) and not f.endswith(("README.md", "CHANGELOG.md"))
        )

    def case(self, name: str) -> None:
        self.git("checkout", "-q", "-B", name, "base")

    def commit(self, message: str = "probe") -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def plan(self, *groups: str) -> None:
        body = "".join(f"{g}: patch\n" for g in groups)
        path = self.probe / ".nx" / "version-plans" / "900-probe.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"---\n{body}---\n\nprobe\n")

    def run_hook(self) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", str(_REPO_ROOT / ".githooks/pre-push/check-version-plan-required.sh")],
            cwd=self.probe,
            capture_output=True,
            text=True,
            timeout=300,
            env=_clean_env(PECOT_VERSION_PLAN_BASE="base", PRE_COMMIT_TO_REF="HEAD"),
        )

    def affected(self) -> list[str]:
        out = subprocess.run(
            [
                str(_NX_BIN),
                "show",
                "projects",
                "--affected",
                "--json",
                "--base=base",
                "--head=HEAD",
            ],
            cwd=self.probe,
            capture_output=True,
            text=True,
            timeout=300,
            env=_clean_env(),
            check=True,
        ).stdout
        return json.loads(out.strip().splitlines()[-1])


@pytest.fixture(scope="module")
def real_nx(tmp_path_factory: pytest.TempPathFactory) -> Iterator[_RealNx]:
    if not _NX_BIN.exists():
        pytest.skip("node_modules/.bin/nx が無い（npm ci 前）ため実 nx テストを skip する")
    workdir = tmp_path_factory.mktemp("real-nx")
    probe = workdir / "probe"
    # --no-hardlinks は必須（tmp_path はリポジトリと別マウントになり得る）。
    subprocess.run(
        ["git", "clone", "--local", "--no-hardlinks", "-q", str(_REPO_ROOT), str(probe)],
        check=True,
        capture_output=True,
        env=_clean_env(),
    )
    (probe / "node_modules").symlink_to(_REPO_ROOT / "node_modules")
    h = _RealNx(probe)
    # clone は HEAD の commit から作るため、未 commit の nx.json の変更を作業ツリーから取り込む。
    shutil.copyfile(_REPO_ROOT / "nx.json", probe / "nx.json")
    h.git("add", "nx.json")
    if h.git("diff", "--cached", "--name-only").strip():
        h.git("commit", "-q", "-m", "chore: sync working-tree nx.json")
    h.git("branch", "-f", "base", "HEAD")
    # nx 24 は repo ごとの id で `~/.nx/<id>/` にキャッシュと索引 db を作る。一時 clone の分が
    # 残らないよう、module 単位の一時ディレクトリへ向ける（_clean_env が os.environ を引き継ぐ）。
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("NX_CACHE_DIRECTORY", str(workdir / "nx-state" / "cache"))
        mp.setenv("NX_WORKSPACE_DATA_DIRECTORY", str(workdir / "nx-state" / "workspace-data"))
        yield h


def test_real_01_block_skill_md_without_plan(real_nx: _RealNx) -> None:
    """実 nx (a): pecot-visual の SKILL.md 変更・宣言なし → block [pecot-visual]。"""
    real_nx.case("real-01")
    skill = real_nx.probe / real_nx.tracked("plugins/pecot-visual", "SKILL.md")
    skill.write_text(skill.read_text() + "\nprobe\n")
    real_nx.commit()
    result = real_nx.run_hook()
    assert result.returncode == 1, result.stderr
    assert "release group [pecot-visual]" in result.stderr


def test_real_02_block_move_into_other_plugin(real_nx: _RealNx) -> None:
    """実 nx (b): pecot-visual のファイルを pecot-workflow へ移動し pecot-workflow だけ宣言 → block。"""
    real_nx.case("real-02")
    src = real_nx.tracked("plugins/pecot-visual/skills")
    dst = f"plugins/pecot-workflow/moved/{Path(src).name}"
    (real_nx.probe / dst).parent.mkdir(parents=True, exist_ok=True)
    real_nx.git("mv", src, dst)
    real_nx.plan("pecot-workflow")
    real_nx.commit()
    result = real_nx.run_hook()
    assert result.returncode == 1, result.stderr
    assert "release group [pecot-visual]" in result.stderr


def test_real_03_block_delete_only(real_nx: _RealNx) -> None:
    """実 nx (c): pecot-tools のファイル削除だけ → block [pecot-tools]。"""
    real_nx.case("real-03")
    real_nx.git("rm", "-q", real_nx.tracked("plugins/pecot-tools/cli"))
    real_nx.commit()
    result = real_nx.run_hook()
    assert result.returncode == 1, result.stderr
    assert "release group [pecot-tools]" in result.stderr


def test_real_04_pass_project_json_with_own_plan(real_nx: _RealNx) -> None:
    """実 nx (d): project.json の変更は他 project も affected にするが、触れた group の宣言だけで pass。"""
    real_nx.case("real-04")
    project_json = real_nx.probe / "plugins/pecot-visual/project.json"
    project_json.write_text(project_json.read_text() + "\n")
    real_nx.plan("pecot-visual")
    real_nx.commit()
    # テストの前提: 同じ範囲の affected には pecot-workflow が含まれる（touched ではない）。
    assert "pecot-workflow" in real_nx.affected()
    result = real_nx.run_hook()
    assert result.returncode == 0, result.stderr


def test_real_05_error_nested_project(real_nx: _RealNx) -> None:
    """実 nx (e): プラグイン配下に group 外の project がある → ERROR (exit 1)。"""
    real_nx.case("real-05")
    nested = real_nx.probe / "plugins/pecot-visual/nested-probe"
    nested.mkdir(parents=True)
    (nested / "project.json").write_text(json.dumps({"name": "nested-probe"}))
    (nested / "x.txt").write_text("x\n")
    real_nx.plan("pecot-visual")
    real_nx.commit()
    result = real_nx.run_hook()
    assert result.returncode == 1, result.stderr
    assert "ERROR:" in result.stderr
    assert "nested-probe" in result.stderr


def test_real_06_pass_readme_only_and_plan_check_agrees(real_nx: _RealNx) -> None:
    """実 nx (f): README.md だけの変更は pass し、plan:check も同じ glob で対象なしと判定する。"""
    real_nx.case("real-06")
    readme = real_nx.probe / "plugins/pecot-visual/README.md"
    readme.write_text(readme.read_text() + "\nprobe\n")
    real_nx.commit()
    result = real_nx.run_hook()
    assert result.returncode == 0, result.stderr
    assert "WARN" not in result.stderr
    # 未リリースの plan がある group を nx は判定せず飛ばすため、作業ツリーで外す（commit しない）。
    plans = sorted((real_nx.probe / ".nx" / "version-plans").glob("*.md"))
    try:
        for plan in plans:
            plan.unlink()
        check = subprocess.run(
            [str(_NX_BIN), "release", "plan:check", "--base=base", "--head=HEAD"],
            cwd=real_nx.probe,
            capture_output=True,
            text=True,
            timeout=300,
            env=_clean_env(),
        )
    finally:
        real_nx.git("checkout", "--", ".nx/version-plans")
    out = check.stdout + check.stderr
    assert check.returncode == 0, out
    assert (
        'No touched projects found based on changed files combined with configured ignore patterns under release group "pecot-visual"'
        in out
    )
