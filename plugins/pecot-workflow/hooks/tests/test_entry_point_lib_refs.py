"""hooks 全域（エントリポイント・2 次ディスパッチャ・lib 内部）の参照実在ガード。

hooks 配下のスクリプトは lib をチェーン実行するが、途中の呼び出しの rc を見ない。
rc を見ない呼び出しは、最終パイプラインの終端・末尾 `exit 0`・rc 未確認のいずれか。
削除・改名された lib への参照は、rc 127 のまま握り潰され、実行時に表面化しない。
2 次ディスパッチャのフォールバック段（`$SCRIPT_DIR/<name>.sh`）も、同じ構造になる。
参照名が 1 文字でも崩れると、Copilot CLI の本番で rc 0 / stdout 空の fail-open（deny が消える）へ落ちる。

#842 で user-prompt-submit.sh だけに入れた実在ガードを、#852 で hooks/ 直下 17 本と 2 次ディスパッチャ 3 本へ広げた。
#864 で対象を hooks 全域へ全数化し、#869 で `.md` テンプレ参照を加えた。
hooks 全域は、lib 配下の被呼び出し側と、hooks 設定 command が指すスクリプトを含む。
固定する不変条件は次の 5 点。

- 参照先ファイルが実在すること（hooks/ 直下 ＋ lib/**/*.sh の全数）
- lib が読むテンプレの参照先が実在すること（`templates/` セグメントを含む `.md` 参照）
- 抽出器が参照を取りこぼしていないこと（非コメント行の `.sh` ／ テンプレ `.md` トークン会計）。
- hooks.json / hooks-copilot.json の command が実在し、かつエントリポイント（hooks/ 直下）であること。
- 列挙・解決の総量が下限を割らないこと（glob 取り違え・行フィルタ過剰除去の空振り検知）

参照の抽出は、conftest の extract_refs / extract_template_refs fixture（共有抽出器）を消費する。
regex の二重化によるサブディレクトリ精度差は、作らない。

テンプレ参照ガードの正味価値は次の 3 点。
現状の 4 件自体は、テンプレ本文を assert する既存の behavior テストが、参照切れを既に捕捉している。

- behavior テストを伴わずに追加される将来のテンプレ参照を保護する
- `[ -f "$TEMPLATE" ]` のすり抜け・`cat` の rc 握り潰しによる気づけない劣化を、「参照切れ」として名指しできる。
- fail 帰属が「本文 assert の不一致」ではなく「参照切れ」として読める

残存リスク（本テストが pass しても保証しない範囲）は次のとおり。

- テンプレ参照の対象は、`templates/` セグメントを含む `.md` に限る。
  lib/core/pecot-dir-init.sh の `${_HOOKS_ROOT}/../CHANGELOG.md` はテンプレではないため、対象外のまま残る。
  `$HOME/.claude/plans/${SLUG}.md` 等の理由は conftest 側に記載している。
- 静的 pass は、runtime の 3 段解決（PLUGIN_HOOKS > CLAUDE_PLUGIN_ROOT > SCRIPT_DIR 逆算）が成功することを含意しない。
  本テストが固定するのは、「参照名の指すファイルが repo に実在する」ことだけ。
  env が欠けた実行時の空展開までは検知できない。
- 条件分岐で複数イディオムに分かれて代入される変数は、片枝しか確かめられない。
  lib/core/pecot-dir-init.sh の `_HOOKS_ROOT` は 3 枝を持つ。
  3 枝は `$PLUGIN_HOOKS` / `${CLAUDE_PLUGIN_ROOT}/hooks` / `${SCRIPT_DIR%/lib/core}` 。
  このうち、抽出器の代入イディオムに合致する 1 枝だけが登録される。
  全枝の再代入検出は、正当な再代入が 20 件超あり誤爆するため採らない。
- 行フィルタは行末の最初の `#` で切るため、クオート内 `#` の後ろに書かれた `.sh` 参照は、抽出器・鈍い走査の両系統から同時に見えなくなる。
  共有前段のため、総数下限でも検知できない。
  `#` 以降に `.sh` を含む非コメント行は、現状 0 件。
- PLUGIN_HOOKS の条件付き seed は、行順を見ない（ファイル全体に source 行が 1 つでもあれば seed する）。
  source 行より前に置かれた `${PLUGIN_HOOKS}/…` 参照も解決される。
  runtime では空展開で fail-open するため、この配置順の誤りは検知できない（現行 hooks に該当ファイルはない）。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

# parametrize の列挙はコレクション時に評価されるため、fixture を使えない。
# 参照ガードの対象は、hooks/ 直下の *.sh（hooks.json の command 実体）と lib 配下全数。
# lib/tests/ はテスト資材（フィクスチャ用の合成スクリプト）で本番の対象ではないため、除外する。
_HOOKS_DIR = Path(__file__).resolve().parents[1]
_PLUGIN_ROOT = _HOOKS_DIR.parent
_EXCLUDED_LIB_PART = "tests"

_ENTRY_POINTS = sorted(_HOOKS_DIR.glob("*.sh"))
_LIB_SCRIPTS = sorted(
    path
    for path in _HOOKS_DIR.glob("lib/**/*.sh")
    if _EXCLUDED_LIB_PART not in path.relative_to(_HOOKS_DIR).parts
)
_GUARDED_SCRIPTS = [*_ENTRY_POINTS, *_LIB_SCRIPTS]

# 列挙の下限。確認は 67 ファイル（hooks/ 直下 17 ＋ lib 配下 50）・解決参照 108 件。
# glob の相対パス取り違えや symlink 非追跡で列挙が空振り／半減したとき、「対象 0 件で全 pass」を green と誤認しないための保険。
# 確認値そのままだと正当なファイル追加・削除で落ちるため、変動幅を見込んだ保守的な値を置く。
_MIN_GUARDED_SCRIPTS = 60
# 解決参照総数の下限。
# 会計テストは、両系統（抽出器と鈍い走査）が同時に空振りすると一致してしまう（`_code_lines` の過剰除去等）。
# そのため、総量の下限で別方向から検知する。
_MIN_RESOLVED_REFS = 90
# テンプレ参照の解決総数の下限。
# 確認は 4 件（plan-issue-poster.sh / plan-mode-reminder.sh ×2 / exit-plan-mode-first-block.sh）。
# スコープ規則を誤って 0 件抽出になっても、実在チェック・会計とも全 pass する。
# そこで、別方向から空振りを検知する。
_MIN_RESOLVED_TEMPLATE_REFS = 3

_CONFIG_FILES = ("hooks.json", "hooks-copilot.json")
_PLUGIN_ROOT_PREFIX = "${CLAUDE_PLUGIN_ROOT}/"

# 抽出器とは独立な「鈍い」走査。
# ディレクトリ変数プレフィックスを要求せず、`.sh` トークンを拾う。
# 抽出結果から導出すると恒真になるため、意図的に別実装にしている（同一量を 2 通りに独立導出して一致を見る形）。
# 文字クラスの `%` `*` は、`${SCRIPT_DIR%/*}/core/x.sh` を 1 トークンとして拾うために要る。
# 欠けると `}/core/x.sh` を切り出して、抽出器側のトークン文字列と恒常的にずれる。
# 末尾の否定先読みは、`foo.shellcheckrc` から `foo.sh` を切り出さないための語境界。
# conftest の `_VAR_SH_REF_RE` と揃えてある（片方だけだと会計が恒常的にずれる）。
_BLUNT_SH_TOKEN_RE = re.compile(r"[A-Za-z0-9._/${}%*-]*\.sh(?![A-Za-z0-9_-])")

# テンプレ参照側の鈍い走査。
# `.sh` 版と同じく前置文字クラスでトークンの左端を伸ばし、`templates/` セグメントと `.md` を要求する。
# 切り出し開始位置と語境界は、conftest の `_VAR_MD_TEMPLATE_REF_RE` と厳密に一致させる。
# 一致させないと、多重集合の比較が恒常的に不一致になる。
# 前置クラスに `${}` が要るのは、`${PLUGIN_HOOKS}/templates/x.md` を 1 トークンとして拾うため。
# `templates/` の直前に置いた否定後読みは、`mytemplates/x.md` から `templates/x.md` を切り出さないためのセグメント境界。
# 抽出器側の rel（`(?:seg/)*templates/…`）が構造的に持つ境界と揃えてある。
_BLUNT_TEMPLATE_TOKEN_RE = re.compile(
    r"[A-Za-z0-9._/${}%*-]*(?<![A-Za-z0-9._-])templates/[A-Za-z0-9._/${}%*-]*\.md(?![A-Za-z0-9_-])"
)

# conftest の PLUGIN_HOOKS seed の根拠行（config-dispatcher.sh 側）。
# 代入と `${CLAUDE_PLUGIN_ROOT}/hooks` を 1 行内に要求する tripwire。
_HOOKS_ROOT_DERIVATION_RE = re.compile(
    r"^\s*PLUGIN_HOOKS=.*\$\{CLAUDE_PLUGIN_ROOT\}/hooks", re.MULTILINE
)


def _script_id(path: Path) -> str:
    """parametrize の id・assert メッセージ用の hooks 相対 posix パス。

    ファイル名だけだと lib 配下の同名（post-tool-use/auto-push.sh と
    stop/auto-push.sh）が衝突して fail 帰属が読めなくなる。
    """
    return path.relative_to(_HOOKS_DIR).as_posix()


def _blunt_sh_tokens(text: str, code_lines) -> list[str]:
    return [token for line in code_lines(text) for token in _BLUNT_SH_TOKEN_RE.findall(line)]


def _missing_ref_paths(refs) -> list[str]:
    return sorted({str(ref.path) for ref in refs if not ref.path.is_file()})


def _token_accounting(text: str, refs, code_lines, own_name: str) -> tuple[list[str], list[str]]:
    """(鈍い走査で得た全 `.sh` トークン, 抽出器が解決したトークン) を返す。

    重複を除くと、1 行に 3 参照ある post-tool-use-bash.sh 等で件数不一致が埋もれる。
    そのため、set ではなくソート済みリスト（多重集合）で比較する。
    `/` を含まない自ファイル名そのものは、会計から外す。
    対象は usage 文字列 `echo "Usage: claude-adapter.sh <core-script>"` の自己言及で、参照ではなく実在も自明だから。
    他ファイルの裸 basename は除外せず、不一致として残す。
    own_name に既定値は置かない。
    渡し忘れが自己名例外の無効化として通るより、TypeError で即座に止まる方が良い。
    """
    blunt = [
        token
        for token in _blunt_sh_tokens(text, code_lines)
        if not ("/" not in token and token == own_name)
    ]
    return sorted(blunt), sorted(ref.token for ref in refs)


def _template_token_accounting(text: str, refs, code_lines) -> tuple[list[str], list[str]]:
    """(鈍い走査で得た全テンプレトークン, 抽出器が解決したトークン) を返す。

    `.sh` 側の `_token_accounting` と違い自己名例外を持たない（自ファイル名は `.sh` で
    テンプレトークンにならない）。多重集合として比較するためソート済みリストを返す。
    """
    blunt = [token for line in code_lines(text) for token in _BLUNT_TEMPLATE_TOKEN_RE.findall(line)]
    return sorted(blunt), sorted(ref.token for ref in refs)


def _config_command_scripts(config_path: Path) -> list[str]:
    """hooks 設定の command から plugin root 相対のスクリプトパスを取り出す。"""
    data = json.loads(config_path.read_text())
    scripts: list[str] = []
    for entries in data["hooks"].values():
        for entry in entries:
            for hook in entry["hooks"]:
                command = hook["command"]
                # command は `"\"${CLAUDE_PLUGIN_ROOT}\"/hooks/x.sh"` のように変数をクォートする（#1229）。
                # クォートの有無は比較の対象外（test_hooks_definitions.py が固定する）
                tokens = _BLUNT_SH_TOKEN_RE.findall(command.replace('"', ""))
                # `.sh` を含まない command（インライン bash 等）を通知なしで飛ばすと、
                # そのフックだけガード対象から静かに外れる。
                assert tokens, f"command から `.sh` を抽出できませんでした: {command}"
                for token in tokens:
                    assert token.startswith(_PLUGIN_ROOT_PREFIX), (
                        f"command が ${{CLAUDE_PLUGIN_ROOT}} 起点でありません: {command}"
                    )
                    scripts.append(token[len(_PLUGIN_ROOT_PREFIX) :])
    return scripts


# 対象列挙のクロスチェック


def test_config_commands_are_all_enumerated() -> None:
    """hooks.json / hooks-copilot.json の command がすべてエントリポイントであること。

    許容集合は、hooks/ 直下 glob（＝エントリポイント）に限る。
    参照ガード側の全数列挙（`_GUARDED_SCRIPTS`）を流用すると、「command はエントリポイント」という不変条件が消える。
    その結果、lib 内部スクリプトを直接指す command を検知できなくなる。
    逆方向は課さない。
    2 次ディスパッチャは command ではなく、hooks-copilot.json は Notification / WebSearch を持たない部分集合になる。
    """
    enumerated = {path.relative_to(_PLUGIN_ROOT).as_posix() for path in _ENTRY_POINTS}
    for config_name in _CONFIG_FILES:
        scripts = _config_command_scripts(_HOOKS_DIR / config_name)
        assert scripts, f"{config_name} から command を抽出できませんでした"
        unenumerated = sorted(set(scripts) - enumerated)
        assert unenumerated == [], (
            f"{config_name} の command がエントリポイント（hooks/ 直下）ではありません: "
            f"{unenumerated}。hooks 設定は lib 内部を直接指さない規約"
        )


@pytest.mark.parametrize("config_name", _CONFIG_FILES)
def test_config_command_scripts_exist(config_name: str) -> None:
    """hooks 設定の command の指すスクリプトが、実在すること。

    列挙集合は実在ファイル glob 由来のため、⊆ 判定（上記）が実在も間接的に担保する。
    それでも、command 側の参照切れを「列挙抜け」ではなく「参照切れ」として名指しで落とす。
    崩れた symlink（glob には現れるが is_file() が偽）はこのテストだけが検知する。
    """
    scripts = _config_command_scripts(_HOOKS_DIR / config_name)
    assert scripts, f"{config_name} から command を抽出できませんでした"
    missing = sorted({s for s in scripts if not (_PLUGIN_ROOT / s).is_file()})
    assert missing == [], (
        f"{config_name} の command が実在しないスクリプトを指しています: {missing}"
    )


def test_guarded_script_count_lower_bound() -> None:
    """ガード対象の列挙が下限を割らないこと（glob 空振りの検知）。"""
    assert len(_GUARDED_SCRIPTS) >= _MIN_GUARDED_SCRIPTS, (
        f"ガード対象が {len(_GUARDED_SCRIPTS)} 件しか列挙できていません"
        f"（下限 {_MIN_GUARDED_SCRIPTS}）。glob の相対パスや除外条件を確認してください"
    )
    assert _ENTRY_POINTS, "hooks/ 直下のエントリポイントが 0 件です"
    assert _LIB_SCRIPTS, "lib 配下のスクリプトが 0 件です"


def test_resolved_ref_total_lower_bound(extract_refs) -> None:
    """全対象を通算した解決参照数が下限を割らないこと。

    会計テストは抽出器と鈍い走査が同時に空振りすると一致して pass するため
    （行フィルタの過剰除去など両系統に共通の前段が崩れた場合）、総量を別途固定する。
    """
    total = sum(
        len(extract_refs(path.read_text(), path.parent, _PLUGIN_ROOT)) for path in _GUARDED_SCRIPTS
    )
    assert total >= _MIN_RESOLVED_REFS, (
        f"解決できた参照が通算 {total} 件しかありません（下限 {_MIN_RESOLVED_REFS}）。"
        "行フィルタや抽出規則が参照を落としていないか確認してください"
    )


def test_resolved_template_ref_total_lower_bound(extract_template_refs) -> None:
    """全対象を通算したテンプレ参照の解決数が下限を割らないこと。

    スコープ規則（`templates/` セグメント要求）の書き損じで抽出が 0 件になっても、
    実在チェックと会計は両系統 0 件で一致して pass する。総量下限だけがそれを落とす。
    """
    total = sum(
        len(extract_template_refs(path.read_text(), path.parent, _PLUGIN_ROOT))
        for path in _GUARDED_SCRIPTS
    )
    assert total >= _MIN_RESOLVED_TEMPLATE_REFS, (
        f"解決できたテンプレ参照が通算 {total} 件しかありません"
        f"（下限 {_MIN_RESOLVED_TEMPLATE_REFS}）。"
        "テンプレ参照の抽出規則が空振りしていないか確認してください"
    )


# 参照の実在とトークン会計


@pytest.mark.parametrize("script", _GUARDED_SCRIPTS, ids=_script_id)
def test_lib_refs_exist(script: Path, extract_refs) -> None:
    """hooks 配下のスクリプトの呼ぶ lib スクリプトが、すべて実在すること。"""
    refs = extract_refs(script.read_text(), script.parent, _PLUGIN_ROOT)
    assert _missing_ref_paths(refs) == [], (
        f"{_script_id(script)} が存在しないスクリプトを呼んでいます: {_missing_ref_paths(refs)}"
    )


@pytest.mark.parametrize("script", _GUARDED_SCRIPTS, ids=_script_id)
def test_sh_tokens_all_extracted(script: Path, extract_refs, code_lines) -> None:
    """非コメント行の `.sh` トークンがすべて抽出器で解決されていること。

    実在チェックは「抽出できた参照」しか見ないため、抽出器が知らない記法
    （変数プレフィックスなしの相対パス呼び出し等）で追加された参照はすり抜けする。
    鈍い走査による独立導出と突合して抽出抜けを検知する。
    """
    text = script.read_text()
    refs = extract_refs(text, script.parent, _PLUGIN_ROOT)
    blunt, extracted = _token_accounting(text, refs, code_lines, script.name)
    assert blunt == extracted, (
        f"{_script_id(script)} の `.sh` トークンに抽出器が解決していないものがあります。"
        f"未解決: {sorted(set(blunt) - set(extracted))}。"
        "参照を `$VAR/<path>.sh` 形式へ揃えるか、conftest の抽出規則を拡張してください。"
        'glob（`"$LIB_DIR"/*.sh`）や変数で組む動的ファイル名は静的解決できないため、'
        "これらも不一致要因になる"
    )


@pytest.mark.parametrize("script", _GUARDED_SCRIPTS, ids=_script_id)
def test_template_refs_exist(script: Path, extract_template_refs) -> None:
    """hooks 配下のスクリプトの読むテンプレ（`templates/*.md`）が、すべて実在すること。

    テンプレの読み出しは `[ -f "$TEMPLATE" ]` のガード付きか `cat` の rc 無確認で、
    参照切れは、実行時に気づかれないまま劣化する（リマインダが出ないだけ）。
    """
    refs = extract_template_refs(script.read_text(), script.parent, _PLUGIN_ROOT)
    assert _missing_ref_paths(refs) == [], (
        f"{_script_id(script)} が存在しないテンプレを参照しています: {_missing_ref_paths(refs)}"
    )


@pytest.mark.parametrize("script", _GUARDED_SCRIPTS, ids=_script_id)
def test_template_tokens_all_extracted(script: Path, extract_template_refs, code_lines) -> None:
    """非コメント行のテンプレトークンがすべて抽出器で解決されていること。

    実在チェックは「抽出できた参照」しか見ないため、変数プレフィックスなしの相対パスや
    動的に組むファイル名で追加されたテンプレ参照はすり抜けする。鈍い走査との突合で
    抽出抜けを検知する。
    """
    text = script.read_text()
    refs = extract_template_refs(text, script.parent, _PLUGIN_ROOT)
    blunt, extracted = _template_token_accounting(text, refs, code_lines)
    assert blunt == extracted, (
        f"{_script_id(script)} のテンプレトークンに抽出器が解決していないものがあります。"
        f"未解決: {sorted(set(blunt) - set(extracted))}。"
        "参照を `$VAR/templates/<name>.md` 形式へ揃えるか、conftest の抽出規則を"
        "拡張してください"
    )


# 抽出器の前提と実装の突合


def test_config_dispatcher_derives_hooks_root_from_plugin_root() -> None:
    """config-dispatcher.sh が `${CLAUDE_PLUGIN_ROOT}/hooks` を PLUGIN_HOOKS へ導く行を持つこと。

    抽出器は「config-dispatcher.sh を source したスクリプトでは PLUGIN_HOOKS が
    plugin_root/hooks を指す」前提で seed する。導出が別手段へ変わったら（例えば
    hooks/ 以外のルートを指すようになったら）seed の意味が変わるため、実装側の
    根拠行の存在をここで固定する。両者を別 substring で探すと無関係な 2 箇所へ
    散在しても pass するため、1 行内に同時に現れることを要求する。
    """
    dispatcher = (_HOOKS_DIR / "lib" / "core" / "config-dispatcher.sh").read_text()
    assert _HOOKS_ROOT_DERIVATION_RE.search(dispatcher), (
        "config-dispatcher.sh に ${CLAUDE_PLUGIN_ROOT}/hooks 起点の PLUGIN_HOOKS 導出行が"
        "ありません。conftest の PLUGIN_HOOKS seed の前提が崩れています"
    )


# 抽出器の自己テスト（合成スクリプトで fail 手段を固定する）

_SYNTHETIC_NAME = "synthetic-entry.sh"
_SYNTHETIC_HEADER = (
    "#!/bin/bash\n"
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
    'LIB_DIR="$SCRIPT_DIR/lib/pre-tool-use"\n'
)
# config-dispatcher.sh を source する lib 配下スクリプトの合成ヘッダ
# （PLUGIN_HOOKS seed の条件を満たす形）。
_SYNTHETIC_LIB_HEADER = (
    "#!/bin/bash\n"
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
    'source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"\n'
)


def test_self_missing_lib_ref_is_detected(extract_refs) -> None:
    text = _SYNTHETIC_HEADER + 'echo "$INPUT" | "$LIB_DIR/does-not-exist.sh"\n'
    refs = extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)
    assert _missing_ref_paths(refs) == [
        str(_HOOKS_DIR / "lib" / "pre-tool-use" / "does-not-exist.sh")
    ]


def test_self_unknown_dir_var_fails_closed(extract_refs) -> None:
    text = _SYNTHETIC_HEADER + '"$UNKNOWN_DIR/handler.sh"\n'
    with pytest.raises(ValueError, match="UNKNOWN_DIR"):
        extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)


def test_self_script_path_assignment_is_not_a_dir_var(extract_refs, resolve_dir_vars) -> None:
    """値が `.sh` で終わる代入をディレクトリ変数として登録しないこと。

    登録すると `$HELPER/nested.sh` が `…/helper.sh/nested.sh` として「解決済み」に
    なり、未解決トークンの fail-closed の網から漏れる。
    """
    text = _SYNTHETIC_HEADER + 'HELPER="$LIB_DIR/helper.sh"\n'
    assert "HELPER" not in resolve_dir_vars(text, _HOOKS_DIR, _PLUGIN_ROOT)
    with pytest.raises(ValueError, match=r"\$HELPER/nested\.sh"):
        extract_refs(text + '"$HELPER/nested.sh"\n', _HOOKS_DIR, _PLUGIN_ROOT)


def test_self_file_like_value_is_not_a_dir_var(extract_refs, resolve_dir_vars) -> None:
    """`.sh` 以外の拡張子を持つ値（テンプレパス等）も登録しないこと。

    `TEMPLATE="${PLUGIN_HOOKS}/templates/x.md"` を if/else の両枝で代入するスクリプトがある。
    これを登録すると、重複代入 ValueError を誤爆する。
    一方で非登録にしたことで、その値を基底とする `.sh` 参照は未解決＝fail-closed に倒れる。
    """
    text = _SYNTHETIC_LIB_HEADER + 'TEMPLATE="${PLUGIN_HOOKS}/templates/reminder.md"\n'
    assert "TEMPLATE" not in resolve_dir_vars(text, _HOOKS_DIR / "lib" / "adapters", _PLUGIN_ROOT)
    with pytest.raises(ValueError, match=r"\$TEMPLATE/nested\.sh"):
        extract_refs(
            text + '"$TEMPLATE/nested.sh"\n', _HOOKS_DIR / "lib" / "adapters", _PLUGIN_ROOT
        )


def test_self_duplicate_dir_var_assignment_fails_closed(extract_refs) -> None:
    """同名ディレクトリ変数の 2 回目の代入で fail すること。

    dict の last-wins に任せると、先行代入を使う分岐の参照が静かに後続の解決先へ
    寄せられ、実在チェックが別ディレクトリのファイルを見て pass する。
    """
    text = _SYNTHETIC_HEADER + 'LIB_DIR="$SCRIPT_DIR/lib/post-tool-use"\n"$LIB_DIR/auto-push.sh"\n'
    with pytest.raises(ValueError, match="LIB_DIR"):
        extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)


def test_self_assignment_to_seeded_name_is_not_a_duplicate(resolve_dir_vars) -> None:
    """seed 済み PLUGIN_HOOKS への実代入で重複 ValueError を誤爆しないこと。

    守る対象は、config-dispatcher.sh を source しつつ自前でも PLUGIN_HOOKS を組み立てるファイル。
    どちらの手段でも解決先は hooks/ ルートのため、重複扱いは誤爆になる。
    config-dispatcher.sh 自身は自らを source しないので seed 対象外で、この分岐には掛からない。
    """
    text = _SYNTHETIC_LIB_HEADER + 'PLUGIN_HOOKS="${CLAUDE_PLUGIN_ROOT}/hooks"\n'
    dir_vars = resolve_dir_vars(text, _HOOKS_DIR / "lib" / "adapters", _PLUGIN_ROOT)
    assert dir_vars["PLUGIN_HOOKS"] == _PLUGIN_ROOT / "hooks"


def test_self_plugin_root_reassignment_still_fails_closed(extract_refs) -> None:
    """seed 除外は PLUGIN_HOOKS 限定で、CLAUDE_PLUGIN_ROOT の再代入は fail すること。

    除外を seed 全体へ広げると、CLAUDE_PLUGIN_ROOT への再代入が無視される。
    以降の `${CLAUDE_PLUGIN_ROOT}/…` 参照は、実際とは違うルートで解決されうる。
    """
    text = _SYNTHETIC_LIB_HEADER + 'CLAUDE_PLUGIN_ROOT="$SCRIPT_DIR/elsewhere"\n'
    with pytest.raises(ValueError, match="CLAUDE_PLUGIN_ROOT"):
        extract_refs(text, _HOOKS_DIR / "lib" / "adapters", _PLUGIN_ROOT)


def test_self_bare_path_ref_breaks_accounting(extract_refs, code_lines) -> None:
    """変数プレフィックスなしの参照は抽出されず、会計不一致として現れること。"""
    text = _SYNTHETIC_HEADER + "bash lib/pre-tool-use/handler.sh\n"
    refs = extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)
    blunt, extracted = _token_accounting(text, refs, code_lines, _SYNTHETIC_NAME)
    assert extracted == []
    assert blunt == ["lib/pre-tool-use/handler.sh"]


def test_self_own_name_token_is_excluded_from_accounting(extract_refs, code_lines) -> None:
    """自ファイル名の裸トークン（usage 文字列）は会計から外れること。"""
    text = _SYNTHETIC_HEADER + f'echo "Usage: {_SYNTHETIC_NAME} <core-script>" >&2\n'
    refs = extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)
    assert _token_accounting(text, refs, code_lines, _SYNTHETIC_NAME) == ([], [])


def test_self_foreign_bare_name_stays_in_accounting(extract_refs, code_lines) -> None:
    """自己名例外は他ファイルの裸 basename まで免除しないこと。

    免除を basename 一般へ広げると、`bash handler.sh` のような相対呼び出しが
    会計から気づかれないまま消える。免除条件と同じ「`/` を含まない裸トークン」で
    自己名不一致の側を固定する。
    """
    text = _SYNTHETIC_HEADER + 'echo "Usage: other-handler.sh <core-script>" >&2\n'
    refs = extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)
    blunt, extracted = _token_accounting(text, refs, code_lines, _SYNTHETIC_NAME)
    assert extracted == []
    assert blunt == ["other-handler.sh"]


def test_self_sh_prefixed_filename_is_not_a_token(extract_refs, code_lines) -> None:
    """`.sh` で始まる別拡張子（`foo.shellcheckrc`）を偽トークンにしないこと。

    語境界を欠くと鈍い走査と抽出器の一方だけが `foo.sh` を切り出し、会計が
    恒常的に不一致になる（実害のない行で常時 fail する）。
    """
    text = _SYNTHETIC_HEADER + 'cat "$LIB_DIR/foo.shellcheckrc"\n'
    refs = extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)
    assert _token_accounting(text, refs, code_lines, _SYNTHETIC_NAME) == ([], [])


def test_self_comment_is_ignored(extract_refs, code_lines) -> None:
    """行頭コメント・行末コメント内の `.sh` は両側とも 0 件になること。

    行フィルタを抽出器と会計側で共有しているため、どちらか一方だけがコメント内の
    `.sh` を拾って偽 fail することはない。
    """
    text = (
        _SYNTHETIC_HEADER
        + "# merge-hook-outputs.sh で出力を統合する\n"
        + 'export HOOK_EVENT_NAME="PreToolUse"  # auto-push.sh 側で参照する\n'
    )
    refs = extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)
    assert _token_accounting(text, refs, code_lines, _SYNTHETIC_NAME) == ([], [])


def test_self_bash_source_idiom_and_plugin_root_resolve(extract_refs) -> None:
    """BASH_SOURCE 版の自己ディレクトリイディオム・`${VAR}` 形・サブディレクトリを扱えること。

    CLAUDE_PLUGIN_ROOT の解決も働くこと（環境変数は参照しない）。
    """
    text = (
        "#!/bin/bash\n"
        'SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n'
        'GUARD_DIR="$SELF_DIR/lib"\n'
        'echo "$INPUT" | "${GUARD_DIR}/adapters/claude-bash-guards.sh"\n'
        '"${CLAUDE_PLUGIN_ROOT}/hooks/lib/core/pecot-dir-init.sh"\n'
    )
    refs = extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)
    assert [ref.path for ref in refs] == [
        _HOOKS_DIR / "lib" / "adapters" / "claude-bash-guards.sh",
        _PLUGIN_ROOT / "hooks" / "lib" / "core" / "pecot-dir-init.sh",
    ]
    assert _missing_ref_paths(refs) == []


def test_self_parent_strip_ref_resolves(extract_refs) -> None:
    """`${VAR%/*}/…`（親ディレクトリ剥がし）が 1 段上を起点に解決されること。

    lib 配下の 30 本超が、`source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"` の形で書かれている。
    この規則がないと、全件 ValueError（fail-closed）になる。
    """
    text = _SYNTHETIC_LIB_HEADER + 'source "${SCRIPT_DIR%/*}/core/branch-guard.sh"\n'
    refs = extract_refs(text, _HOOKS_DIR / "lib" / "adapters", _PLUGIN_ROOT)
    assert [ref.path for ref in refs] == [
        _HOOKS_DIR / "lib" / "core" / "config-dispatcher.sh",
        _HOOKS_DIR / "lib" / "core" / "branch-guard.sh",
    ]
    assert _missing_ref_paths(refs) == []


def test_self_unknown_parameter_expansion_modifier_fails_closed(extract_refs) -> None:
    """`%/*` 以外の `%` 修飾は解決せず ValueError にすること。

    剥がす段数が異なる `${VAR%/lib/*}` を parent で解決すると別ディレクトリの
    ファイルを見て pass しうる。規則の上限をここでピン留めする。
    """
    text = _SYNTHETIC_LIB_HEADER + 'source "${SCRIPT_DIR%/lib/*}/core/branch-guard.sh"\n'
    with pytest.raises(ValueError, match=r"SCRIPT_DIR%/lib/\*"):
        extract_refs(text, _HOOKS_DIR / "lib" / "adapters", _PLUGIN_ROOT)


def test_self_plugin_hooks_seed_resolves_when_dispatcher_is_sourced(extract_refs) -> None:
    """config-dispatcher.sh を source していれば `${PLUGIN_HOOKS}` 起点が解決されること。

    claude/copilot-bash-guards.sh の `CORE_DIR="${PLUGIN_HOOKS}/lib/core"` 経由で、コアを呼ぶ箇所が 13 本ある。
    #865 レビュー F-03 の主対象で、この seed で解決される。
    """
    text = (
        _SYNTHETIC_LIB_HEADER + 'CORE_DIR="${PLUGIN_HOOKS}/lib/core"\n"$CORE_DIR/branch-guard.sh"\n'
    )
    refs = extract_refs(text, _HOOKS_DIR / "lib" / "adapters", _PLUGIN_ROOT)
    assert [ref.path for ref in refs] == [
        _HOOKS_DIR / "lib" / "core" / "config-dispatcher.sh",
        _HOOKS_DIR / "lib" / "core" / "branch-guard.sh",
    ]
    assert _missing_ref_paths(refs) == []


def test_self_plugin_hooks_without_dispatcher_source_fails_closed(extract_refs) -> None:
    """config-dispatcher.sh を source しないスクリプトの `${PLUGIN_HOOKS}` は未解決にすること。

    PLUGIN_HOOKS を与えるのは config-dispatcher.sh のみ。
    source を欠いたスクリプトでは、runtime に空展開されて `/lib/core/x.sh` を叩き、rc 127 で fail-open する。
    無条件 seed だと、この不具合が静的テストを pass してしまう。
    """
    text = _SYNTHETIC_HEADER + '"${PLUGIN_HOOKS}/lib/core/branch-guard.sh"\n'
    with pytest.raises(ValueError, match="PLUGIN_HOOKS"):
        extract_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)


def test_self_alias_dispatcher_source_does_not_seed(extract_refs, resolve_dir_vars) -> None:
    """末尾に config-dispatcher.sh を含む別名ファイルの source では seed しないこと。

    語境界を欠くと、`my-config-dispatcher.sh` の source が seed 条件に誤マッチする。
    その結果、PLUGIN_HOOKS を与えないファイルの `${PLUGIN_HOOKS}/…` が解決済みになる。
    """
    adapters = _HOOKS_DIR / "lib" / "adapters"
    text = (
        "#!/bin/bash\n"
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
        'source "${SCRIPT_DIR%/*}/core/my-config-dispatcher.sh"\n'
        '"${PLUGIN_HOOKS}/lib/core/branch-guard.sh"\n'
    )
    assert "PLUGIN_HOOKS" not in resolve_dir_vars(text, adapters, _PLUGIN_ROOT)
    with pytest.raises(ValueError, match="PLUGIN_HOOKS"):
        extract_refs(text, adapters, _PLUGIN_ROOT)


def test_self_broken_symlink_ref_is_missing(extract_refs, tmp_path: Path) -> None:
    """崩れた symlink への参照を実在ありと判定しないこと。

    glob 列挙には現れるため列挙クロスチェックでは検知できず、`is_file()` を使う
    実在チェックだけが落とせる手段。
    """
    core_dir = tmp_path / "hooks" / "lib" / "core"
    core_dir.mkdir(parents=True)
    (core_dir / "dangling.sh").symlink_to(tmp_path / "nowhere.sh")
    text = _SYNTHETIC_HEADER + '"$SCRIPT_DIR/lib/core/dangling.sh"\n'
    refs = extract_refs(text, tmp_path / "hooks", tmp_path)
    assert _missing_ref_paths(refs) == [str(core_dir / "dangling.sh")]


# テンプレ参照抽出器の自己テスト
# script_dir は実在する lib 配下ディレクトリを渡す（`${SCRIPT_DIR%/*}` 起点の
# source 行を解決させるため）。テンプレ参照自体は PLUGIN_HOOKS seed 経由で解決される。

_SYNTHETIC_LIB_DIR = _HOOKS_DIR / "lib" / "post-tool-use"


def test_self_missing_template_ref_is_detected(extract_template_refs) -> None:
    text = _SYNTHETIC_LIB_HEADER + 'TEMPLATE="${PLUGIN_HOOKS}/templates/does-not-exist.md"\n'
    refs = extract_template_refs(text, _SYNTHETIC_LIB_DIR, _PLUGIN_ROOT)
    assert _missing_ref_paths(refs) == [str(_HOOKS_DIR / "templates" / "does-not-exist.md")]


def test_self_template_ref_without_dispatcher_source_fails_closed(extract_template_refs) -> None:
    """config-dispatcher.sh を source しないスクリプトのテンプレ参照は未解決にすること。

    PLUGIN_HOOKS を与えるのは config-dispatcher.sh のみ。
    source を欠くと、runtime では空展開されて `/templates/x.md` を見にいく。
    `[ -f ]` が偽になり、何も出さないまま終わる。
    無条件 seed だと、この不具合が静的テストを pass してしまう。
    """
    text = _SYNTHETIC_HEADER + 'TEMPLATE="${PLUGIN_HOOKS}/templates/reminder.md"\n'
    with pytest.raises(ValueError, match="PLUGIN_HOOKS"):
        extract_template_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)


def test_self_comment_template_ref_is_ignored(extract_template_refs, code_lines) -> None:
    """コメント内のテンプレ参照は抽出・会計とも 0 件になること。"""
    text = (
        _SYNTHETIC_LIB_HEADER
        + "# ${PLUGIN_HOOKS}/templates/plan-mode-reminder.md を読み込む\n"
        + 'MODE="quick"  # ${PLUGIN_HOOKS}/templates/plan-mode-reminder-quick.md を使う\n'
    )
    refs = extract_template_refs(text, _SYNTHETIC_LIB_DIR, _PLUGIN_ROOT)
    assert _template_token_accounting(text, refs, code_lines) == ([], [])


def test_self_mdx_suffix_is_not_a_template_token(extract_template_refs, code_lines) -> None:
    """`.md` で始まる別拡張子（`x.mdx`）を偽トークンにしないこと。

    語境界を欠くと鈍い走査と抽出器の一方だけが `x.md` を切り出し、会計が恒常的に
    不一致になる。両系統 0 件で固定する。
    """
    text = _SYNTHETIC_LIB_HEADER + 'TEMPLATE="${PLUGIN_HOOKS}/templates/reminder.mdx"\n'
    refs = extract_template_refs(text, _SYNTHETIC_LIB_DIR, _PLUGIN_ROOT)
    assert _template_token_accounting(text, refs, code_lines) == ([], [])


def test_self_md_outside_templates_is_out_of_scope(extract_template_refs, code_lines) -> None:
    """`templates/` セグメントを含まない `.md` は抽出・会計とも対象外であること。

    次のものを対象に含めると、会計側の鈍い走査だけが拾って恒常的に不一致になる。
    `$HOME/.claude/plans/${SLUG}.md`（plan-issue-poster.sh）と、echo 文字列の `CLAUDE.md`。
    スコープを `templates/` に限る根拠をここで固定する。
    """
    text = (
        _SYNTHETIC_LIB_HEADER
        + 'PLAN_FILE="$HOME/.claude/plans/${SLUG}.md"\n'
        + 'echo "CLAUDE.mdのルール"\n'
    )
    refs = extract_template_refs(text, _SYNTHETIC_LIB_DIR, _PLUGIN_ROOT)
    assert _template_token_accounting(text, refs, code_lines) == ([], [])


def test_self_nested_template_rel_resolves(extract_template_refs) -> None:
    """`hooks/templates/x.md` のような深い rel も対象に入ること（誤除外の防止）。"""
    text = (
        _SYNTHETIC_HEADER
        + 'REMIND="${CLAUDE_PLUGIN_ROOT}/hooks/templates/exit-plan-mode-remind.md"\n'
    )
    refs = extract_template_refs(text, _HOOKS_DIR, _PLUGIN_ROOT)
    assert [ref.path for ref in refs] == [_HOOKS_DIR / "templates" / "exit-plan-mode-remind.md"]
    assert _missing_ref_paths(refs) == []
