#!/bin/bash
# ワークツリー専用ブランチへの commit/push を検出するコアチェックスクリプト。
#
# 入力は次のとおり。
#   環境変数 HOOK_COMMAND（確認対象のコマンド文字列、必須）。
#   環境変数 HOOK_TOOL_CWD（ツール呼び出し時点の作業ディレクトリ、任意）。
#   環境変数 HOOK_WORKING_DIR（セッション起点の作業ディレクトリ、任意）。
# 出力は次のとおり。
#   exit 0 + 空stdout = 許可
#   exit 1 + stdout   = ブロック（理由テキスト）
#   exit 2 + stderr   = 内部エラー。
#
# ブロックするブランチは次のとおり。
#   - wt[0-9]+    : ワークツリー管理用（wt1, wt2, wt3, ...）
#   - develop-aist: 開発統合用（PR経由のみ）
#
# ブロックするコマンドは次のとおり。
#   - git commit / git push（チェイニング、git -C 付きも検出）
#
# 許可は次のとおり。
#   - feature ブランチ（feat/*, fix/*, etc.）
#   - commit/push 以外のコマンド（git status, git log 等）
#   - detached HEAD 状態

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"
source "${SCRIPT_DIR}/mcp-guidance.sh"
pecot_hook_enabled "git-worktree-branch-check" true || exit 0

if [ -z "$HOOK_COMMAND" ]; then
    hook_message error "HOOK_COMMAND environment variable is required" >&2
    exit 2
fi

# git commit/push コマンドを検出する正規表現。
COMMIT_PATTERN='(^|;|&&|\|\||\|)[[:space:]]*git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?commit([[:space:]]|$)'
PUSH_PATTERN='(^|;|&&|\|\||\|)[[:space:]]*git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?push([[:space:]]|$)'

if ! [[ "$HOOK_COMMAND" =~ $COMMIT_PATTERN ]] && ! [[ "$HOOK_COMMAND" =~ $PUSH_PATTERN ]]; then
    exit 0
fi

# 操作タイプを判定（エラーメッセージ用）。
if [[ "$HOOK_COMMAND" =~ $COMMIT_PATTERN ]]; then
    OPERATION="commit"
else
    OPERATION="push"
fi

# 作業ディレクトリを決定する。
# 優先順位は、git -C パース > cd チェイン > HOOK_TOOL_CWD > HOOK_WORKING_DIR > pwd。
# 前 3 つ（コマンドとツール呼び出しが指す実際の対象）は、git-repo-resolver.sh に委ねる。
# HOOK_WORKING_DIR はアダプタが渡すセッション起点で、対象が特定できないときの既定。
# 解決順を明示化したのは、#1087 の事例を受けたため。
# wt セッションから base の main へ release commit を復旧しようとして、セッション起点の wt1 のブランチで誤判定され、block された。
source "${SCRIPT_DIR}/git-repo-resolver.sh"
_resolve_repo_dir_with_session_default "$HOOK_COMMAND"

# git リポジトリでなければ許可（他のチェックに委ねる）。
if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    exit 0
fi

# 現在のブランチを取得（detached HEAD なら許可）。
CURRENT_BRANCH=$(git -C "$REPO_DIR" symbolic-ref --short HEAD 2>/dev/null)
if [ -z "$CURRENT_BRANCH" ]; then
    exit 0
fi

# 保護ブランチパターン。
PROTECTED_BRANCH_PATTERN='^(wt[0-9]+|develop-aist)$'

if [[ "$CURRENT_BRANCH" =~ $PROTECTED_BRANCH_PATTERN ]]; then
    MSG="git-worktree-branch-check: direct ${OPERATION} to the protected branch '${CURRENT_BRANCH}' is not allowed.

Reason: a protected branch accepts changes only through a PR. A direct commit would merge
changes without review and cause conflicts with other worktrees.

Work on a feature branch:
  1. Create a feature branch: git checkout -b feat/your-feature-name
  2. Commit and create the PR on the feature branch"
    if [ "$OPERATION" = "push" ]; then
        MSG="${MSG}

$(mcp_guidance_delete_branch)"
    fi
    hook_message error "$MSG"
    exit 1
fi

exit 0
