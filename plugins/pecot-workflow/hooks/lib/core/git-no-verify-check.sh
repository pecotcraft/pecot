#!/bin/bash
# git --no-verifyオプションを検出するコアチェックスクリプト。
#
# 入力は環境変数 HOOK_COMMAND（確認対象のコマンド文字列）。
# 出力は次のとおり。
#   exit 0 + 空stdout = 許可
#   exit 1 + stdout   = ブロック（理由テキスト）
#   exit 2 + stderr   = 内部エラー。
#
# ブロックするパターンは次のとおり。
#   - git commit --no-verify
#   - git push --no-verify
#   - git commit -n (ショートオプション)
#   - git push -n
#   - git commit --no-verify -m "message"
#   - git merge --no-verify (ロング形式は全 git サブコマンド対象)
#
# 検出しないパターンは次のとおり。
#   - git log --no-merges (他の--no-*オプション)
#   - echo "--no-verify" (文字列内)
#   - git status --short | head -n 5 (複合コマンドの後続コマンドの -n)
#   - git log --oneline; sed -n 200,215p file.md (後続 sed の -n)
#   - git commit -m "use -n flag" (クォート内の -n)
#   - git log -n 5 / git rev-list -n 5 HEAD / git tag -n (git 自身の -n)。
#     commit/push 以外では --no-verify を意味しないため許可する。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"
pecot_hook_enabled "git-no-verify-check" true || exit 0

if [ -z "$HOOK_COMMAND" ]; then
  hook_message error "HOOK_COMMAND environment variable is required" >&2
  exit 2
fi

# クォート内の内容を除去する。
# クォート内の -n / --no-verify をオプション指定と誤認しないため。
# 1. シングルクォート内を除去 2. ダブルクォート内を除去
stripped=$(printf '%s' "$HOOK_COMMAND" | sed "s/'[^']*'//g" | sed 's/"[^"]*"//g')

# コマンド区切り（&& & || ; |）を改行へ正規化し、セグメント単位で確認する。
# 単一正規表現だと .* が区切りをまたいで後続コマンドの -n まで拾うため
# （例: git status --short | head -n 5）、セグメントへ分割してから判定する。
#
# この置換順序は入れ替え不可。理由は次のとおり。
#   | を || より先に置換すると、|| が "二重の改行" に化けてセグメントが崩れる。
#   同様に & を && より先に置換すると、&& が "二重の改行" に化けて崩れる。
#   必ず && || の 2 文字区切りを先に処理し、単独 & | を後に処理する。
stripped=${stripped//&&/$'\n'}
stripped=${stripped//&/$'\n'}
stripped=${stripped//||/$'\n'}
stripped=${stripped//;/$'\n'}
stripped=${stripped//|/$'\n'}

# セグメント自体が git コマンドであることの判定。
# [a-z-]+ は「git 直後トークンの存在確認」であり厳密なサブコマンド検証ではない。
# クラスに `-` を含むため git -C /repo commit -n では -C の `-` がこの位置で
# マッチし、グローバルオプション併用形も git セグメントとして検知できる。
GIT_SEGMENT_PATTERN='^[[:space:]]*git[[:space:]]+[a-z-]+'
# 単語境界つきの --no-verify 指定の判定（ロング形式は全 git サブコマンド対象）。
NO_VERIFY_LONG_PATTERN='(^|[[:space:]])--no-verify([[:space:]]|$)'
# -n が --no-verify を意味するサブコマンド（commit / push）の判定。
SUBCOMMAND_PATTERN='(^|[[:space:]])(commit|push)([[:space:]]|$)'
# 単語境界つきの -n ショートオプションの判定。
SHORT_N_PATTERN='(^|[[:space:]])-n([[:space:]]|$)'

# パターンは小文字前提。git Commit -n のような大文字バリアントも検知するため
# セグメントを ${segment,,}（bash 小文字化展開）で正規化してから比較する。
blocked=false
while IFS= read -r segment; do
  segment=${segment,,}
  [[ "$segment" =~ $GIT_SEGMENT_PATTERN ]] || continue
  if [[ "$segment" =~ $NO_VERIFY_LONG_PATTERN ]]; then
    blocked=true
    break
  fi
  if [[ "$segment" =~ $SUBCOMMAND_PATTERN ]] && [[ "$segment" =~ $SHORT_N_PATTERN ]]; then
    blocked=true
    break
  fi
done <<< "$stripped"

if [[ "$blocked" == true ]]; then
  hook_message error "git-no-verify-check: the git --no-verify (-n) option is not allowed.

This project does not allow skipping CI or quality checks (pre-commit, pre-push, gitlint, etc.) at all.
Every way of skipping is prohibited, not only --no-verify: SKIP=..., --no-gpg-sign, and so on.

When a hook reports an error:
  1. Read the error message and identify what is violated
  2. Fix the root cause of the violation
  3. Re-run normally (without any skip option) after the fix"
  exit 1
fi

exit 0
