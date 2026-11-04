#!/usr/bin/env bash
# Block commits while a nested .pecot/ directory remains outside the repository root.
#
# Why this exists:
# - 作業ファイルはリポジトリルートの .pecot/work/<Issue番号>/ に置く規約です。
#   しかしエージェントが CWD 相対で .pecot/work/ を解決し、パッケージ配下に誤配置する
#   不具合が再発しています（#730）。
# - 既存の check-forbidden-dirs は git index ベースのため、self-ignore された
#   untracked な誤配置 .pecot/ を検知できません。
# - そこで git index 非依存の find 走査で、ファイルシステムを直接走査します。
#   ルート直下の正規 .pecot/ 以外に .pecot/ が残る間は、commit を exit 1 でブロックします。

set -euo pipefail

PROJECT_DIR="$(git rev-parse --show-toplevel)"

# git index 非依存の find 走査（untracked も検出可能）。
# ルート直下の正規 .pecot/ は prune で除外し、その配下（work 残骸内の fixture
# 由来 .pecot 等）も走査対象外にする。.git / node_modules / .pnpm-store / .venv も prune。
#
# 制約: ルート .pecot/ を丸ごと prune するため、ルート正規 .pecot/ 配下に生成された
# 誤配置は検出対象外となります。
# ルート直下の .pecot だけは、規約上の正規ディレクトリとして信頼する前提です。
#
# 検出した誤配置 .pecot 自身も -prune して、その配下の入れ子 .pecot を二重報告しない
# （誤配置はトップ 1 件に集約する）。
# 読み取り不能ディレクトリで find が exit 1 を返しても、コミットを誤ブロックしない。
# そのため 2>/dev/null でエラー出力を捨て、`|| true` で終了コードを正常化する。
misplaced="$(
    find "$PROJECT_DIR" -mindepth 1 \
        \( -path "$PROJECT_DIR/.pecot" -o -name .git -o -name node_modules -o -name .pnpm-store -o -name .venv \) -prune \
        -o -type d -name .pecot -print -prune \
        2>/dev/null || true
)"

if [ -z "$misplaced" ]; then
    exit 0
fi

{
    echo "ERROR: リポジトリルート以外に .pecot/ ディレクトリが残存しています"
    echo ""
    echo "作業ファイルはリポジトリルートの .pecot/work/<Issue番号>/ に置く規約です。"
    echo "次のパスはパッケージ配下等への誤配置です:"
    while IFS= read -r path; do
        [ -z "$path" ] && continue
        echo "  - $path"
    done <<< "$misplaced"
    echo ""
    echo "対処:"
    echo "  - 必要なファイルはリポジトリルートの .pecot/work/<Issue番号>/ へ移動する"
    echo "  - 不要なら誤配置 .pecot/ を削除する"
} >&2

exit 1
