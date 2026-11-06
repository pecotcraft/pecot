"""pecot-dir-init 起動の検知レイヤテスト（test_pecot_dir_init_detection.bats 移植）。

user-prompt-submit.sh と pre-tool-use-skill.sh が `/pecot:` プレフィックスを正しく検知するかを確かめる。
判定は、.pecot ディレクトリを生成するか（= init 発火）で行う。

user-prompt-submit.sh は LIB_DIR 配下の実装スクリプトを呼ぶ。
副作用を避けるため、LIB_DIR を「何もしないモック」へ差し替えたコピーを作って実行する（bats 版の sed 相当）。
CORE_DIR（検知スクリプト）は検証対象そのものなので、実体の絶対パスへ差し替える。
pre-tool-use-skill.sh は、副作用が .pecot 生成に限られるため、実体をそのまま実行する。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_MOCK_LIB_SCRIPTS = (
    "workflow-compliance-injector.sh",
    "pecot-issue-pending-state.sh",
    "create-slash-flag.sh",
)

# 検知スクリプトを呼ぶエントリ × 参照変数 → lib サブディレクトリ。
# モック突合・生パス禁止ガードと変数解決先の突合が共有する対象表。
_DIR_REF_CASES = (
    ("user-prompt-submit.sh", "LIB_DIR", "lib/user-prompt-submit"),
    ("user-prompt-submit.sh", "CORE_DIR", "lib/core"),
    ("pre-tool-use-skill.sh", "LIB_DIR", "lib/pre-tool-use"),
    ("pre-tool-use-skill.sh", "CORE_DIR", "lib/core"),
)

# LIB_DIR / CORE_DIR 自体の定義行のみ生パスを許す。
_DIR_ASSIGN_RE = re.compile(r"^\s*(LIB_DIR|CORE_DIR)=")
# SCRIPT_DIR は標準形（$(cd ... && pwd)）なので、差し替え対象から除く。
_UPS_DIR_ASSIGN_ANY_RE = re.compile(r"^([A-Z][A-Z_0-9]*_DIR)=", re.MULTILINE)


def _extract_subdir_references(
    hooks_dir: Path, entry: str, lib_subdir: str, extract_refs
) -> list[str]:
    """<entry> が呼ぶ <lib_subdir> 配下のスクリプト名を返す。

    抽出は conftest の共有抽出器（hooks/tests の実在ガードと同一）を消費する。
    ここで regex を持つと、サブディレクトリ精度差のある二重実装になる。
    """
    src = (hooks_dir / entry).read_text()
    target_dir = hooks_dir / lib_subdir
    refs = extract_refs(src, hooks_dir, hooks_dir.parent)
    referenced = [ref.path.name for ref in refs if ref.path.parent == target_dir]
    assert referenced, f"{entry} から {lib_subdir} 配下の参照を抽出できませんでした"
    return referenced


@pytest.fixture
def hooks_dir(project_root: Path) -> Path:
    return project_root / "plugins" / "pecot-workflow" / "hooks"


@pytest.fixture
def detection_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    project_root: Path,
    hooks_dir: Path,
) -> dict:
    """bats setup() 相当。CLAUDE_PROJECT_DIR / PLUGIN 環境変数を設定し、
    user-prompt-submit.sh の LIB_DIR をモックへ差し替えたコピーを用意する。
    """
    project = tmp_path / "project"
    project.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(project_root / "plugins" / "pecot-workflow"))
    monkeypatch.setenv("PLUGIN_HOOKS", str(hooks_dir))

    mock_lib = tmp_path / "mock-ups-lib"
    mock_lib.mkdir(parents=True)
    for name in _MOCK_LIB_SCRIPTS:
        script = mock_lib / name
        script.write_text("#!/bin/bash\ncat >/dev/null 2>&1 || true\nexit 0\n")
        script.chmod(0o755)

    ups_src = (hooks_dir / "user-prompt-submit.sh").read_text()

    # コピーで実行すると、SCRIPT_DIR は tmp を指す。
    # そのため、SCRIPT_DIR 相対の *_DIR 代入は、すべて絶対パスへ差し替える。
    # 差し替え先は、LIB_DIR がモック、CORE_DIR が実体。
    # SCRIPT_DIR 自体は標準形のまま残す。
    # 差し替え抜けを防ぐため、対象の網羅をここで固定する。
    # 差し替え抜けとは、新しい *_DIR が増えたのに tmp を指したまま、rc 127 で空振りすること。
    dir_overrides = {"LIB_DIR": str(mock_lib), "CORE_DIR": str(hooks_dir / "lib" / "core")}
    assigned = {name for name in _UPS_DIR_ASSIGN_ANY_RE.findall(ups_src) if name != "SCRIPT_DIR"}
    assert assigned == set(dir_overrides), (
        f"user-prompt-submit.sh の *_DIR 代入と差し替え対象が一致しません。"
        f"差し替えが必要: {sorted(assigned - set(dir_overrides))} / "
        f"stale: {sorted(set(dir_overrides) - assigned)}。"
        "dir_overrides を実体パスまたはモックへ向けて更新してください"
    )

    ups_patched = ups_src
    for name, path in dir_overrides.items():
        ups_patched = re.sub(
            rf"^{name}=.*$",
            lambda _m, _n=name, _p=path: f'{_n}="{_p}"',
            ups_patched,
            flags=re.MULTILINE,
        )
    ups_test = tmp_path / "user-prompt-submit.sh"
    ups_test.write_text(ups_patched)
    ups_test.chmod(0o755)

    return {
        "project": project,
        "ups_script": ups_test,
        "ptus_script": hooks_dir / "pre-tool-use-skill.sh",
    }


def _pecot_dir_created(project: Path) -> bool:
    return (project / ".pecot").is_dir()


# 静的ガード（#842: モック突合・生パス禁止・変数解決先の突合）。
# 検知スクリプトを呼ぶエントリ 2 本（user-prompt-submit.sh / pre-tool-use-skill.sh）へ、同じガードを掛ける。
# どちらもチェーン途中の呼び出しの rc を見ない。
# そのため、参照先が崩れて rc 127 になっても、実行時には表面化しない。
# 参照先の実在自体は hooks/tests/test_entry_point_lib_refs.py が全エントリポイント分を
# 担保する（#852）。ここに残るのは detection_env の忠実性を守るエントリ固有ガードのみ。


@pytest.mark.parametrize(("entry", "dir_var", "lib_subdir"), _DIR_REF_CASES)
def test_dir_vars_resolve_to_expected_subdirs(
    hooks_dir: Path, resolve_dir_vars, extract_refs, entry: str, dir_var: str, lib_subdir: str
) -> None:
    """各エントリの LIB_DIR / CORE_DIR が _DIR_REF_CASES の subdir へ解決され、
    かつ当該 subdir 配下への参照が 1 件以上あること。

    _DIR_REF_CASES の lib_subdir は、下のモック突合・生パス迂回ガードが探す literal になっている。
    変数の実際の解決先が別ディレクトリへ移ると、それらのガードは何にもマッチせず、常に pass する（fail-open）。
    literal と実態を、ここで繋ぐ。
    解決先が合っていても、当該 subdir 配下への参照が 0 件になると、モック突合は空集合同士の一致で pass しうる。
    そこで、ケースごとに参照の存在も併せて固定する。
    """
    src = (hooks_dir / entry).read_text()
    dir_vars = resolve_dir_vars(src, hooks_dir, hooks_dir.parent)
    assert dir_vars[dir_var] == hooks_dir / lib_subdir
    assert _extract_subdir_references(hooks_dir, entry, lib_subdir, extract_refs)


def test_mock_lib_scripts_matches_ups_references(hooks_dir: Path, extract_refs) -> None:
    """detection_env のモック一覧が user-prompt-submit.sh の実参照と一致すること。

    injector が増減したときにモック生成が追随しないと、未登録の injector は `<mock_lib>/<名前>.sh` として解決され、rc 127 で終わる。
    このとき実体は実行されない。
    entry point の `exit 0` がこれを握り潰すため、当該 injector は「モックによる no-op」ではなく「実行エラー」になる。
    その結果、検知系テストが ups チェーンを忠実に再現しなくなる。不要なモックが残ることもある。
    どちらも実行時には表面化しないため、参照集合との一致をここで固定する。

    pre-tool-use-skill.sh 側は実体をそのまま実行する（モック差し替えをしない）ため、
    この突合は user-prompt-submit.sh のみが対象。
    """
    referenced = set(
        _extract_subdir_references(
            hooks_dir, "user-prompt-submit.sh", "lib/user-prompt-submit", extract_refs
        )
    )
    mocked = set(_MOCK_LIB_SCRIPTS)
    assert referenced == mocked, (
        f"user-prompt-submit.sh の $LIB_DIR 参照と _MOCK_LIB_SCRIPTS が一致しません。"
        f"モックリストへ追加が必要: {sorted(referenced - mocked)} / "
        f"参照が消え stale: {sorted(mocked - referenced)}。"
        "injector の増減に合わせて _MOCK_LIB_SCRIPTS を更新してください"
    )


@pytest.mark.parametrize(("entry", "dir_var", "lib_subdir"), _DIR_REF_CASES)
def test_lib_scripts_referenced_only_via_dir_var(
    hooks_dir: Path, entry: str, dir_var: str, lib_subdir: str
) -> None:
    """lib サブディレクトリ配下の参照が `$LIB_DIR` / `$CORE_DIR` 経由のみであること。

    `$SCRIPT_DIR/lib/core/foo.sh` のような生パス呼び出しは、参照抽出（実在チェック・モック突合）にも、detection_env の *_DIR 差し替えにも掛からない。
    その結果、ガードをすべてすり抜ける。
    参照手段を変数一本に固定して、抜け道を塞ぐ。
    変数自体の定義行のみ、生パスを許す。
    """
    src = (hooks_dir / entry).read_text()
    path_re = re.compile(re.escape(lib_subdir))
    raw_refs = [
        line.strip()
        for line in src.splitlines()
        if path_re.search(line) and not _DIR_ASSIGN_RE.match(line)
    ]
    assert raw_refs == [], (
        f"{entry} が {lib_subdir}/ を ${dir_var} 経由でなく生パスで参照しています: {raw_refs}。"
        "実在チェック・モック突合・モック差し替えのいずれも掛からないため、"
        f"${dir_var}/<name>.sh 形式へ書き換えてください"
    )


# UserPromptSubmit


@pytest.mark.parametrize("prompt", ["/pecot-w:w-help", "/w-help", "/w-quick READMEのtypo修正"])
def test_ups_pecot_prompt_triggers_init(detection_env, run_script, prompt: str) -> None:
    """名前空間付き・短縮形のどちらの入力でも init が発火すること。

    .prompt にはユーザーの生入力がそのまま渡り、短縮形で起動されたときは名前空間が
    付かない。フル修飾だけを見ていると pecot 未使用リポで .pecot が作られない（#939）。
    """
    result = run_script(detection_env["ups_script"], stdin=f'{{"prompt": "{prompt}"}}')
    assert result.returncode == 0
    assert _pecot_dir_created(detection_env["project"])


def test_ups_normal_prompt_no_init(detection_env, run_script) -> None:
    result = run_script(detection_env["ups_script"], stdin='{"prompt": "今日の天気を教えて"}')
    assert result.returncode == 0
    assert not _pecot_dir_created(detection_env["project"])
    # UserPromptSubmit の stdout は全プロンプトへ文脈注入される。検知スクリプトが
    # 1 バイトでも漏らすと全プロンプトが汚染されるため、無出力を固定する。
    assert result.stdout == ""


@pytest.mark.parametrize("prompt", ["/v-slidev", "/help"])
def test_ups_non_pecot_slash_no_init(detection_env, run_script, prompt: str) -> None:
    """pecot 以外のスラッシュコマンドでは発火しないこと。

    短縮形の捕捉は `w-` プレフィックス（pecot の命名規約）に限る。`/` 全般へ広げると
    pecot を使わないリポでも .pecot が作られる。
    """
    result = run_script(detection_env["ups_script"], stdin=f'{{"prompt": "{prompt}"}}')
    assert result.returncode == 0
    assert not _pecot_dir_created(detection_env["project"])


def test_ups_code_block_pecot_no_false_trigger(detection_env, run_script) -> None:
    result = run_script(detection_env["ups_script"], stdin='{"prompt": "説明: `/pecot-w:w-help`"}')
    assert result.returncode == 0
    assert not _pecot_dir_created(detection_env["project"])


# jq or 統合式の意味論（クロス payload）。
# pecot-dir-init-detect.sh は、単一の `or` 式で 2 つを判定する。
# 判定対象は、`/pecot:` プレフィックス（UserPromptSubmit）と、`pecot:` skill（PreToolUse(Skill)）。
# ホスト payload スキーマは、UserPromptSubmit 入力に .tool_input が無く、PreToolUse 入力に .prompt が無い前提になっている。
# この前提のもとでは、実害がない。
# これは設計判断だが、その前提自体はテストで固定されていない。
# 以下 2 件で、統合式の意味論を宣言として明示する。


def test_ups_cross_payload_skill_field_triggers_init(detection_env, run_script) -> None:
    """UserPromptSubmit へ `.tool_input.skill` が混入すると発火すること。

    prompt が非 pecot でも `.tool_input.skill` が `pecot:` なら、init が動く。
    これが `or` 統合式の意味論になる。
    ホスト payload にクロスフィールドが現れた場合の挙動を、宣言として固定する（変わったら意図的に判断し直す）。
    """
    result = run_script(
        detection_env["ups_script"],
        stdin='{"prompt": "今日の天気を教えて", "tool_input": {"skill": "pecot-w:w-help"}}',
    )
    assert result.returncode == 0
    assert _pecot_dir_created(detection_env["project"])
    # 発火しても検知スクリプトは stdout へ何も出さない（全プロンプト汚染の防止）。
    assert result.stdout == ""


def test_ptus_cross_payload_prompt_field_triggers_init(detection_env, run_script) -> None:
    """PreToolUse(Skill) へ `.prompt` が混入すると発火すること。

    skill が非 pecot でも `.prompt` が `/pecot:` なら、init が動く。
    これが `or` 統合式の意味論になる。
    ホスト payload にクロスフィールドが現れた場合の挙動を、宣言として固定する（変わったら意図的に判断し直す）。
    """
    result = run_script(
        detection_env["ptus_script"],
        stdin='{"prompt": "/pecot-w:w-help", "tool_input": {"skill": "claude-code-guide"}}',
    )
    assert result.returncode == 0
    assert _pecot_dir_created(detection_env["project"])


# PreToolUse(Skill)


def test_ptus_pecot_skill_triggers_init(detection_env, run_script) -> None:
    result = run_script(
        detection_env["ptus_script"], stdin='{"tool_input": {"skill": "pecot-w:w-help"}}'
    )
    assert result.returncode == 0
    assert _pecot_dir_created(detection_env["project"])


def test_ptus_non_pecot_skill_no_init(detection_env, run_script) -> None:
    result = run_script(
        detection_env["ptus_script"],
        stdin='{"tool_input": {"skill": "claude-code-guide"}}',
    )
    assert result.returncode == 0
    assert not _pecot_dir_created(detection_env["project"])


def test_ptus_pecot_skill_outputs_additional_context(detection_env, run_script) -> None:
    result = run_script(
        detection_env["ptus_script"], stdin='{"tool_input": {"skill": "pecot-w:w-help"}}'
    )
    assert result.returncode == 0
    assert '"additionalContext"' in result.stdout
    assert _pecot_dir_created(detection_env["project"])


def test_ptus_non_pecot_skill_empty_stdout(detection_env, run_script) -> None:
    result = run_script(
        detection_env["ptus_script"],
        stdin='{"tool_input": {"skill": "claude-code-guide"}}',
    )
    assert result.returncode == 0
    assert result.stdout == ""
