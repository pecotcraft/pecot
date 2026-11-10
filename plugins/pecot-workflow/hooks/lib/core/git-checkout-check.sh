#!/bin/bash
# git checkout/switch実行前にuntrackedファイルを警告するコアチェックスクリプト。
#
# 入力は次のとおり。
#   環境変数 HOOK_COMMAND（確認対象のコマンド文字列、必須）。
#   環境変数 HOOK_TOOL_CWD（ツール呼び出し時点の作業ディレクトリ、任意）。
#   環境変数 HOOK_WORKING_DIR（セッション起点の作業ディレクトリ、任意）。
# 出力は次のとおり。
#   exit 0 + 空stdout   = 許可（checkout以外、またはuntracked無し）。
#   exit 0 + 非空stdout = 警告（untrackedファイルあり）。
#   exit 2 + stderr     = 内部エラー。
#
# 注意: このスクリプトは常にexit 0を返す（ブロックしない、警告のみ）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"
pecot_hook_enabled "git-checkout-check" true || exit 0

if [ -z "$HOOK_COMMAND" ]; then
  hook_message error "HOOK_COMMAND environment variable is required" >&2
  exit 2
fi

# git checkout/switchを含むか確認。
CHECKOUT_PATTERN='git[[:space:]]+(checkout|switch)[[:space:]]'
if ! [[ "$HOOK_COMMAND" =~ $CHECKOUT_PATTERN ]]; then
  exit 0
fi

# 作業ディレクトリを決定する。
# 優先順位は、git -C パース > cd チェイン > HOOK_TOOL_CWD > HOOK_WORKING_DIR > pwd。
# 前 3 つは git-repo-resolver.sh に委ね、git-worktree-branch-check.sh と統一する。
# セッション起点（HOOK_WORKING_DIR）だけを見ると、別 checkout を対象にした操作を
# 起点リポジトリの状態で判定してしまう（#1087）。
source "${SCRIPT_DIR}/git-repo-resolver.sh"
_resolve_repo_dir_with_session_default "$HOOK_COMMAND"

# untrackedファイルを確認。
if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  hook_message warning "not a git repository: $REPO_DIR" >&2
  exit 0
fi
UNTRACKED=$(git -C "$REPO_DIR" status --porcelain 2>/dev/null | grep '^??' | head -10)

if [ -n "$UNTRACKED" ]; then
  hook_message warning "git-checkout-check: untracked files exist and may be lost after switching branches:

$UNTRACKED

Reason: Git does not manage untracked files per branch, so files are lost when the target branch has
a file with the same name or a different .gitignore.

What to do (in order of preference):
1. git add to include them in a commit (if they are work products)
2. git stash --include-untracked to set them aside (if they are temporary)
3. git clean to delete them (if unneeded)"
fi

exit 0
