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

if [ -z "$HOOK_COMMAND" ]; then
  echo "HOOK_COMMAND environment variable is required" >&2
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
  echo "【gh-pr-create-check ガード】"
  echo "gh pr create は許可されていません。"
  echo ""
  echo "理由: gh pr create を直接使うと、Issue参照の自動付与・PRテンプレートのバリデーション・"
  echo "トレーサビリティ記録が行われず、ワークフローの一貫性が失われます。"
  echo ""
  echo "代わりに以下を使用してください:"
  echo '  pecot pr create'
  exit 1
fi

if pecot_hook_enabled "gh-issue-create-check" true && [[ "$HOOK_COMMAND" =~ $GH_ISSUE_CREATE_PATTERN ]]; then
  echo "【gh-issue-create-check ガード】"
  echo "gh issue create は許可されていません。"
  echo ""
  echo "理由: gh issue create を直接使うと、pecot プロジェクトボードへの自動登録・"
  echo "ステータス/優先度/サイズ等のフィールド設定・テンプレート検証が行われず、"
  echo "ワークフローの一貫性とトレーサビリティが失われます。"
  echo ""
  echo "代わりに以下のいずれかを使用してください:"
  echo '  pecot issue quick   # フリーフォーマット即起票'
  echo '  pecot issue create  # フロントマター付きMarkdownから'
  exit 1
fi

exit 0
