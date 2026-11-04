#!/bin/bash
# Git同期: カレントブランチをgit pullで最新化。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "git-sync" true || exit 0

# 基準ディレクトリはエントリポイントの project-root.sh が CLAUDE_PROJECT_DIR に揃える。
# 未設定（git 外で起動）のときは同期対象が無いので何もしない。
REPO_ROOT="${CLAUDE_PROJECT_DIR:-}"
[ -n "$REPO_ROOT" ] || exit 0

# リポジトリルートの検証（.gitはworktreeではファイル、通常はディレクトリ）。
if [ ! -d "$REPO_ROOT/.git" ] && [ ! -f "$REPO_ROOT/.git" ]; then
    echo "Warning: リポジトリルートが見つかりません: $REPO_ROOT" >&2
    exit 0
fi

# pecot CLIが利用可能か確認（uvxでインストールされている場合）。
if command -v uvx >/dev/null 2>&1; then
    # 未コミットの変更がある場合はスキップ。
    if git -C "$REPO_ROOT" diff --quiet 2>/dev/null && git -C "$REPO_ROOT" diff --staged --quiet 2>/dev/null; then
        CURRENT_BRANCH=$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)

        # すべてのブランチを git pull で同期する（worktree sync は廃止）。
        # pull は 1 回だけ実行して出力を保持する。
        # 失敗時に再実行すると、到達できない remote で待ち時間が倍になるため。
        # 認証プロンプトで SessionStart を止めないようにする。
        # HTTPS の資格情報は GIT_TERMINAL_PROMPT=0 で止める。
        # SSH のパスフレーズ・ホスト鍵確認は BatchMode=yes で止める。
        # 利用者が設定済みの GIT_SSH_COMMAND は残す。
        if PULL_OUTPUT=$(cd "$REPO_ROOT" && GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes" git pull 2>&1); then
            echo "# Git Sync"
            echo ""
            echo "ブランチと同期完了（ブランチ: $CURRENT_BRANCH）"
            echo ""
        else
            # エラー時は保持した出力を stderr に表示。
            printf '%s\n' "$PULL_OUTPUT" >&2
        fi
    fi
fi
