#!/bin/bash
# gh pr create / gh issue create コマンドを検出するコアチェックスクリプト。
#
# 入力は環境変数 HOOK_COMMAND（確認対象のコマンド文字列）。
# 出力は次のとおり。
#   exit 0 + 空stdout = 許可
#   exit 1 + stdout   = ブロック（理由テキスト）
#   exit 2 + stderr   = 内部エラー。
#
# ブロックするパターン（gh pr create / gh issue create 共通）:
#   - 先頭の gh <pr|issue> create
#   - GH_HOST=... gh <pr|issue> create (環境変数後)
#   - echo test && gh <pr|issue> create ... (チェイニング後)
#   - echo test & gh <pr|issue> create ... (バックグラウンド区切り後)
#   - echo test | gh <pr|issue> create ... (パイプ後)
#   - 改行で連結した複数行コマンドの 2 行目以降の gh <pr|issue> create
#   - /usr/bin/gh <pr|issue> create (フルパス指定)
#
# ブロックしないパターンは次のとおり。
#   - gh api / gh issue view / gh issue list / gh pr view / gh pr list 等（読み取り・汎用操作）。
#   - cat high.txt (ファイル名に含まれるgh)
#   - echo "gh pr create" (文字列内)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"
source "${SCRIPT_DIR}/mcp-guidance.sh"

if [ -z "$HOOK_COMMAND" ]; then
  hook_message error "HOOK_COMMAND environment variable is required" >&2
  exit 2
fi

# 改行連結を `;` と同等に扱うため、改行を `;` へ正規化する。
# ただし `<<` を含むコマンドは対象外とする。ヒアドキュメント本文の行頭に
# gh pr create ... が現れると、実行されないテキストを hard deny してしまうため。
# その結果、`<<` を含む複数行コマンド内の改行連結は検出抜けとなる。
if [[ "$HOOK_COMMAND" != *"<<"* ]]; then
  HOOK_COMMAND="${HOOK_COMMAND//$'\n'/;}"
fi

# 共通の先頭・区切り文字パターン。
# - 先頭、または区切り文字（`;` `&&` `&` `||` `|` `$(` `(`）の後。
# - オプションで環境変数(VAR=value)が前にある
# - gh という単語か、フルパス(/*/gh)。
GH_PR_CREATE_PATTERN='(^|;|&&|&|\|\||\||`|\$\(|\()[[:space:]]*([A-Z_]+=[^ ]*[[:space:]]+)*(/[^ ]*/)?gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'
GH_ISSUE_CREATE_PATTERN='(^|;|&&|&|\|\||\||`|\$\(|\()[[:space:]]*([A-Z_]+=[^ ]*[[:space:]]+)*(/[^ ]*/)?gh[[:space:]]+issue[[:space:]]+create([[:space:]]|$)'

if pecot_hook_enabled "gh-pr-create-check" true && [[ "$HOOK_COMMAND" =~ $GH_PR_CREATE_PATTERN ]]; then
  hook_message error "$(mcp_guidance_gh_pr_create)"
  exit 1
fi

if pecot_hook_enabled "gh-issue-create-check" true && [[ "$HOOK_COMMAND" =~ $GH_ISSUE_CREATE_PATTERN ]]; then
  hook_message error "$(mcp_guidance_gh_issue_create)"
  exit 1
fi

exit 0
