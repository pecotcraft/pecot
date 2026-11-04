#!/bin/bash
# VSCodeワークスペース情報の検出と出力。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "vscode-workspace-detector" true || exit 0

# 基準ディレクトリはエントリポイントの project-root.sh が CLAUDE_PROJECT_DIR に揃える。
# 未設定（git 外で起動）のときは検索対象のリポジトリが無いので何もしない。
REPO_ROOT="${CLAUDE_PROJECT_DIR:-}"
[ -n "$REPO_ROOT" ] || exit 0

# code --status からワークスペース情報を取得（WSL対応）。
CODE_STATUS=$(code --status 2>&1)
if [ $? -ne 0 ]; then
    exit 0
fi

# ウィンドウタイトルからワークスペース名を抽出する。
# 形式は window [N] (ファイル名 - ワークスペース名 (ワークスペース) [WSL: Ubuntu] - Visual Studio Code)。
# 「(ワークスペース)」か「(Workspace)」の前の名前が、ワークスペース名。
# 日本語の語は変数に出し、grep のパターンを組み立てる。
WS_JA='ワークスペース'
WORKSPACE_NAME=$(echo "$CODE_STATUS" | \
    grep -oP "window \[\d+\].*?- \K[^(]+(?= \((${WS_JA}|Workspace)\))" | \
    head -1 | xargs)

if [ -z "$WORKSPACE_NAME" ]; then
    # ワークスペースが開かれていない（単一フォルダ等）。
    exit 0
fi

# ワークスペース名から対応する.code-workspaceファイルを検索
# 検索場所: REPO_ROOT/workspaces/, REPO_ROOT/, ホームディレクトリ。
WORKSPACE_FILE=""
for search_dir in "$REPO_ROOT/workspaces" "$REPO_ROOT" "$HOME"; do
    found=$(find "$search_dir" -maxdepth 2 -name "${WORKSPACE_NAME}.code-workspace" 2>/dev/null | head -1)
    if [ -n "$found" ] && [ -f "$found" ]; then
        WORKSPACE_FILE="$found"
        break
    fi
done

echo "# VSCode Workspace Context"
echo ""
echo "セッション開始時、最初の応答で以下のワークスペース情報をウェルカムメッセージとして表示してください："
echo ""
echo "**Workspace:** $WORKSPACE_NAME"
echo ""

# ワークスペースファイルが見つかった場合はフォルダ情報を表示。
if [ -n "$WORKSPACE_FILE" ] && [ -f "$WORKSPACE_FILE" ]; then
    echo "**Folders:**"
    jq -r '.folders[] | "- \(.name // .path): `\(.path)`"' "$WORKSPACE_FILE" 2>/dev/null
    echo ""
fi
