#!/bin/bash
# セッション開始共通処理（ディスパッチャ）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/core/config-dispatcher.sh"
pecot_hook_enabled "session-start-common" true || exit 0

# .pecot/ の新規作成は利用検知側（pecot-dir-init.sh）に一本化する（#662）。
# session-start では .pecot が既に存在するリポに限り、.gitignore の ensure を呼ぶ（書くかは ensure が決める）。
# CLAUDE_PROJECT_DIR は、エントリポイント（session-start-*.sh）が project-root.sh で揃えたもの。
# 値は hook 入力の cwd の git toplevel で、git 外では未設定のまま。
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
# 末尾スラッシュを除去（F-07）
PROJECT_DIR="${PROJECT_DIR%/}"
PECOT_DIR="${PROJECT_DIR}/.pecot"

# 多重実行防止（flock があるときのみ）。
# 複数 matcher の定義が並行して動く場合への備えで、今の SessionStart の定義は 1 本（session-start.sh）にまとまっている。
# 標準の macOS には flock(1) と md5sum が無いため、識別子は POSIX の cksum で作る。
# flock が無ければ、ロックを掛けずに実行する。
# mkdir 等の代替ロックは使わない。
# hook が SIGKILL されるとロックが残り、以後の SessionStart がずっとスキップされるため。
# lock ファイルは、.pecot に依存しない TMPDIR 配下へ置く（.pecot 不在リポでも対称に多重実行を防ぐ）。
# PROJECT_DIR のパスから識別子を生成し、プロジェクト間の lock 衝突を避ける。
if command -v flock >/dev/null 2>&1; then
    _LOCK_ID="$(printf '%s' "${PROJECT_DIR}" | cksum | cut -d' ' -f1)"
    LOCK_FILE="${TMPDIR:-/tmp}/.session-start-common-${_LOCK_ID}.lock"
    exec 9>"$LOCK_FILE"
    # ロック取得失敗 = 別プロセスが実行中 → スキップ
flock -n 9 || exit 0
fi

if [ -n "$PROJECT_DIR" ] && [ -d "$PECOT_DIR" ]; then
    # 書く条件（無い・未追跡）は ensure に任せる。
    "${SCRIPT_DIR}/core/pecot-gitignore-ensure.sh" || true
fi

LIB_DIR="$SCRIPT_DIR/session-start"
"$LIB_DIR/issue-pending-cleanup.sh"
"$LIB_DIR/create-slash-cleanup.sh"
"$LIB_DIR/session-project-dir.sh"
"$LIB_DIR/git-sync.sh"
"$LIB_DIR/vscode-workspace-detector.sh"
# gitignore-track-notice は ensure の後に追跡の有無を見るため、列の末尾側に置く。
"$LIB_DIR/gitignore-track-notice.sh"
"$LIB_DIR/plugin-update-notice.sh"
