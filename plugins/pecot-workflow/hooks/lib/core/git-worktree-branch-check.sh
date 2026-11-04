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
pecot_hook_enabled "git-worktree-branch-check" true || exit 0

if [ -z "$HOOK_COMMAND" ]; then
    echo "HOOK_COMMAND environment variable is required" >&2
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
    echo "【git-worktree-branch-check ガード】"
    echo "保護ブランチ '${CURRENT_BRANCH}' への直接 ${OPERATION} は禁止されています。"
    echo ""
    echo "理由: 保護ブランチはPR経由でのみ変更を受け入れます。直接commitすると"
    echo "レビューなしの変更がマージされ、他のワークツリーとの競合が発生します。"
    echo ""
    echo "作業は feature ブランチで行ってください:"
    echo "  1. feature branch を作成: git checkout -b feat/your-feature-name"
    echo "  2. feature branch でコミット・PRを作成"
    if [ "$OPERATION" = "push" ]; then
        echo ""
        echo "リモートブランチ削除が目的の場合:"
        echo '  "${CLAUDE_PLUGIN_ROOT}/bin/pecot" delete-branch <owner/repo> <branch>'
    fi
    exit 1
fi

exit 0
