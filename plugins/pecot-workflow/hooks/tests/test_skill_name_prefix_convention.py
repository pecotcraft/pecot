"""pecot スキル名の `w-` プレフィックス規約の固定。

hooks 側の 3 スクリプトは、名前空間なしの短縮形入力（`/w-pr`）を、コマンド名の列挙ではなく `w-` プレフィックスで捕捉する（#939）。
3 スクリプトは、workflow-compliance-injector.sh / create-slash-flag.sh / core/pecot-dir-init-detect.sh。
列挙にすると、コマンド追加時に対象外のまま気づけないため、この形を選んだ。
この設計は、「pecot のコマンドはすべて `w-` で始まる」という命名規約に依存している。
規約が破れると、当該コマンドは短縮形での検知から外れる。
フル修飾では動くため、実行時に気づきにくい。

コマンドの実体はスキルディレクトリなので、その名前を規約の代表として固定する。
"""

from __future__ import annotations

from pathlib import Path

_SKILLS_DIR = Path(__file__).resolve().parents[2] / "skills"
_SKILL_PREFIX = "w-"
# 列挙が空振り（パス取り違え・glob ミス）したまま全 pass するのを防ぐ下限。
# 確認 15 スキル。正当な追加・削除で落ちないよう保守的な値を置く。
_MIN_SKILLS = 10


def _skill_dirs() -> list[Path]:
    """skills/ 直下のスキルディレクトリ（テスト資材ディレクトリを除く）。"""
    return sorted(p for p in _SKILLS_DIR.iterdir() if p.is_dir() and p.name != "tests")


def test_all_skill_names_use_a_prefix() -> None:
    violations = sorted(p.name for p in _skill_dirs() if not p.name.startswith(_SKILL_PREFIX))
    assert violations == [], (
        f"`{_SKILL_PREFIX}` で始まらないスキルがあります: {violations}。"
        "hooks の短縮形検知は、このプレフィックスで pecot コマンドを判別します。"
        "対象は workflow-compliance-injector.sh / create-slash-flag.sh / "
        "lib/core/pecot-dir-init-detect.sh の 3 スクリプトです。"
        "規約を変えるなら、3 スクリプトの判定も同時に見直してください"
    )


def test_skill_enumeration_lower_bound() -> None:
    """列挙が下限を割らないこと（パス取り違えによる空振りの検知）。

    列挙 0 件だと規約テストは空リスト同士の一致で pass する。
    """
    skills = _skill_dirs()
    assert len(skills) >= _MIN_SKILLS, (
        f"スキルが {len(skills)} 件しか列挙できていません（下限 {_MIN_SKILLS}）。"
        f"探索先 {_SKILLS_DIR} が正しいか確認してください"
    )
