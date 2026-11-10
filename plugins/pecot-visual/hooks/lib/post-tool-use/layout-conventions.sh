#!/bin/bash
# PostToolUse hook: v-slidev 生成プロジェクトで編集された pages/**/*.md に対し、
# その layout の参照 YAML の抜粋を提示する。
# 抜粋対象: status / best_practices / anti_patterns。
#
# 判定装置ではない。
# eslint-check.sh が機械判定できるのは文字数・prop 構造までで、
# best_practices / anti_patterns が扱う表現面の規約は判定できない。
# 本 hook は違反を探さず、出典パスと YAML の原文だけを model に渡す（地の文・修正指示は付けない）。
# 出典パスは talk-dir 内の相対ではなく logical 絶対パスで出す。
# 複数の talk-dir を跨いで編集したときに、どのプロジェクトの規約かを model 側で判別できるようにするためだ。
#
# プロジェクト root 決定方式:
#   編集ファイルの dir から上方向に、dir を探す。
#   探す dir は、`slides.md` ファイルと `pages/` ディレクトリを持つ。
#   git には依存しない（eslint-check.sh と同一方式）。
#
# frontmatter と YAML の解釈は、layout-conventions.mjs 経由で lint 側の実装に委ねる。
# 委ねる先: plugin 側 assets/slidev の scripts/eslint/_shared/dist。
# 読む YAML の場所は、実行用ミラーの CLI（slide theme --json）が返す lint.referencesDirectories の順。
# talk-dir の references/ が先に来る。
# lint の no-unknown-props などが読む場所と同じ一覧を使うので、提示内容と lint の適用対象が食い違わない。
#
# 出力チャネル:
#   stdout = model に届けるべきものだけ（additionalContext を持つ JSON）。
#            どの分岐でも「空または妥当な JSON」を維持する。
#            呼び出し元 merge-hook-outputs.sh は、非 JSON の stdout を additionalContext に丸める。
#            そのため診断ログを stdout に出してはならない。
#   stderr = 開発者診断の trace 1 行。
#            exit 0 の hook stderr は、model と debug ログのどちらにも出ない。
#            session transcript の hook_success.stderr には恒久記録される。
#
# 分岐の分類（提示するか、しないかの 2 択。「未実施」の通知は出さない）:
#   対象外 → trace のみ。
#            対象 MD でない / talk-dir 外 / plugin root 解決不能 / 実行環境不足 /
#            layout 不明 / 参照 YAML 不在 / 抜粋対象が無い、のいずれか。
#   提示   → 出典パス 1 行 + YAML 原文の抜粋を additionalContext に載せる。

# 自身の絶対パス。trace に含めて、実セッションの transcript から「どの配置の実体が
# 動いたか」を特定できるようにする。
SELF="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SELF")"

# 開発者診断 trace。verdict は skip / present。
trace() {
    echo "[layout-conventions] $1 (self: $SELF)" >&2
}

# talk-dir 探索と plugin hooks root 解決は、3 本の post-tool-use hook で共有する。
# 共有ライブラリを解決できない配置では、未定義関数のまま実行すると、talk-dir 外と区別できない無音 skip になる。
# そのため、明示的に対象外として扱う。
HOOK_PATHS_LIB="${SCRIPT_DIR%/*}/core/hook-paths.sh"
if [ ! -f "$HOOK_PATHS_LIB" ]; then
    trace "skip: shared library cannot be resolved ($HOOK_PATHS_LIB)"
    exit 0
fi
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/hook-paths.sh
. "$HOOK_PATHS_LIB"

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [ -z "$FILE_PATH" ]; then
    trace "skip: tool_input.file_path is empty"
    exit 0
fi

case "$FILE_PATH" in
    *.md) ;;
    *)
        trace "skip: not a .md file ($FILE_PATH)"
        exit 0
        ;;
esac

# 編集ファイルの dir から上方向に talk-dir マーカーを探す。
# 探索は logical パスで行う（cd / pwd に -P を付けない）。
# 物理パスにすると、pages/ 自体やその配下が talk-dir 外への symlink だった場合に、
# 上方向探索が talk-dir を通らずマーカーを見失う。
# ORIG_DIR は下の相対パス算出でも使う。
ORIG_DIR=$(CDPATH= cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd)
TALK_ROOT=$(find_talk_root "$ORIG_DIR" "pages")

if [ -z "$TALK_ROOT" ]; then
    trace "skip: talk-dir marker (slides.md + pages/) not found ($FILE_PATH)"
    exit 0
fi

# 対象判定は TALK_ROOT 相対パスで行う。
# 絶対パスを `pages/*.md` と比較すると、先頭の `/` で必ず外れ、全ファイルが対象外になる。
# 相対パスは、生の $FILE_PATH ではなく探索起点 ORIG_DIR から算出する。
# TALK_ROOT と同じ logical 空間なので、前方一致が保証される。
REL_DIR=${ORIG_DIR#"$TALK_ROOT"}
REL_DIR=${REL_DIR#/}
REL_FILE="${REL_DIR:+$REL_DIR/}$(basename "$FILE_PATH")"

# case のパターンは `/` も `*` で食う。
# 参照 YAML の dir 配下の md は、下で referencesDirectories と比べて外す。
# slides.md は個別ページではなく束ねる側なので対象外。
case "$REL_FILE" in
    pages/*.md) ;;
    *)
        trace "skip: not an md file under pages ($REL_FILE)"
        exit 0
        ;;
esac

# plugin の hooks root を解決する。
# 逆算が成立しない配置（別所へコピーされた等）は、対象外として扱う。
HOOKS_ROOT=$(resolve_hooks_root "$SCRIPT_DIR" "/lib/post-tool-use")

if [ -z "$HOOKS_ROOT" ]; then
    trace "skip: plugin root cannot be resolved (PLUGIN_HOOKS and CLAUDE_PLUGIN_ROOT are unset, and SCRIPT_DIR=$SCRIPT_DIR does not lead back to it)"
    exit 0
fi

# 実行用ミラー（データ置き場の runtime/）側の assets/slidev と CLI を参照する。
# ミラーが無いときは何も出さない。
# 本 hook は判定装置ではないので、提示できなかったことを通知しても model の判断材料にならない。
if ! RUNTIME_DIR="$(resolve_runtime_dir "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"; then
    trace "skip: runtime mirror is missing"
    exit 0
fi
ASSETS_DIR="$(resolve_slidev_assets_dir "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"
SHARED_DIST="$ASSETS_DIR/scripts/eslint/_shared/dist/index.js"
HELPER="$SCRIPT_DIR/layout-conventions.mjs"

# 実行環境が欠けても model には何も出さない。
# 本 hook は判定装置ではないので、提示できなかったことを通知しても model の判断材料にならない。
MISSING=""
[ ! -f "$SHARED_DIST" ] && MISSING="$SHARED_DIST"
[ ! -f "$HELPER" ] && MISSING="${MISSING:+$MISSING, }$HELPER"
[ ! -f "$RUNTIME_DIR/cli/dist/cli.js" ] && MISSING="${MISSING:+$MISSING, }cli/dist/cli.js"
if ! command -v node > /dev/null 2>&1; then
    MISSING="${MISSING:+$MISSING, }node"
fi
if [ -n "$MISSING" ]; then
    trace "skip: runtime environment is incomplete ($MISSING / assets: $ASSETS_DIR)"
    exit 0
fi

# 参照 dir の一覧は、CLI の slide theme が返す lint.referencesDirectories を使う。
# テーマを引けない talk-dir（未リンク・移行前）では、提示する規約が無いので何も出さない。
THEME_ERR_FILE=$(mktemp)
trap 'rm -f "$THEME_ERR_FILE"' EXIT
THEME_JSON="$(resolve_talk_theme_json "$RUNTIME_DIR" "$TALK_ROOT" "$THEME_ERR_FILE")"
THEME_EXIT=$?
THEME_ERR=$(head -n 1 "$THEME_ERR_FILE")
if [ $THEME_EXIT -ne 0 ]; then
    THEME_REASON=$(printf '%s\n' "$THEME_JSON" | jq -r '.reason // empty' 2>/dev/null)
    trace "skip: theme cannot be resolved (reason: ${THEME_REASON:-none} / exit $THEME_EXIT)${THEME_ERR:+ / stderr: $THEME_ERR}"
    exit 0
fi
REFERENCES_DIRS=()
while IFS= read -r reference_dir; do
    [ -n "$reference_dir" ] && REFERENCES_DIRS+=("$reference_dir")
done < <(printf '%s\n' "$THEME_JSON" | jq -r '.lint.referencesDirectories[]? // empty' 2>/dev/null)
if [ ${#REFERENCES_DIRS[@]} -eq 0 ]; then
    trace "skip: slide theme output has no referencesDirectories"
    exit 0
fi

# 参照 YAML の dir 配下の md は、レイアウトの利用ではないので対象外。
PHYSICAL_DIR=$(CDPATH= cd -P "$ORIG_DIR" 2>/dev/null && pwd -P)
for reference_dir in "${REFERENCES_DIRS[@]}"; do
    if [ "$PHYSICAL_DIR" = "$(CDPATH= cd -P "$reference_dir" 2>/dev/null && pwd -P)" ]; then
        trace "skip: under a references YAML dir ($REL_FILE)"
        exit 0
    fi
done

# stdout（提示本文）と stderr（診断）を分けて捕捉する。
# node が異常終了した場合の stderr は trace に畳み込む。
# そのため hook 自身の stderr へ素通しせず、一時ファイルへ受ける。
HELPER_ERR_FILE=$(mktemp)
trap 'rm -f "$THEME_ERR_FILE" "$HELPER_ERR_FILE"' EXIT
BODY=$(timeout 10 node "$HELPER" "$SHARED_DIST" "$FILE_PATH" "${REFERENCES_DIRS[@]}" \
    2>"$HELPER_ERR_FILE")
HELPER_EXIT=$?
HELPER_ERR=$(head -n 1 "$HELPER_ERR_FILE")

# 提示本文を切り詰める（$ の終了コードの捕捉より後で行う）。
# 参照 YAML が想定外に肥大していても、additionalContext を占有しないようにする。
BODY=$(echo "$BODY" | head -n 200)

if [ $HELPER_EXIT -ne 0 ] || [ -z "$BODY" ]; then
    case $HELPER_EXIT in
        10) REASON="frontmatter or layout is missing" ;;
        11) REASON="layout value is invalid as a references YAML file name" ;;
        12) REASON="no matching references YAML (${REFERENCES_DIRS[*]})" ;;
        13) REASON="references YAML has none of status / best_practices / anti_patterns" ;;
        14) REASON="references YAML cannot be read (unparsable or unreadable; ${REFERENCES_DIRS[*]})" ;;
        124) REASON="helper timed out (over 10 seconds)" ;;
        0)  REASON="helper exited with 0 and printed nothing" ;;
        *)  REASON="helper exited abnormally (exit $HELPER_EXIT)" ;;
    esac
    trace "skip: $REASON ($REL_FILE)${HELPER_ERR:+ / stderr: $HELPER_ERR}"
    exit 0
fi

trace "present: references YAML excerpt presented ($REL_FILE)"
jq -n --arg body "$BODY" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $body
  }
}'
