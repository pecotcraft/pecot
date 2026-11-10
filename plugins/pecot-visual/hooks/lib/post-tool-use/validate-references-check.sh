#!/bin/bash
# PostToolUse hook: v-slidev の talk-dir で編集された references の yaml に validate-references を実行する。
# TALK_ROOT は `slides.md` と `pages/` を持つ最も近い上位 dir（git 非依存）。
# 編集ファイルの dir が CLI（slide theme --json）の lint.referencesDirectories のどれかに一致するときだけ、その dir を --dir に渡す。
# 出力: stdout は additionalContext を持つ JSON か空だけ（merge-hook-outputs.sh が非 JSON を文脈に丸めるため）。診断は stderr に trace 1 行。
# validator は違反とクラッシュがどちらも exit 1 なので、完走フッター `N files checked, N error(s) found.` を完走の証跡にする。
# フッターの無い非 0 と、exit 0 でも編集ファイルの `✓/✗ <basename>` 行が無いものは「未実施」にする。

# 開発者診断 trace。verdict は skip / pass / not-linted / violation。
trace() {
    echo "[validate-references-check] $1" >&2
}

# talk-dir 探索と plugin hooks root 解決は、3 本の post-tool-use hook で共有する。
# 共有ライブラリを解決できない配置では、未定義関数のまま実行すると、talk-dir 外と区別できない無音 skip になる。
# そのため、明示的に対象外として扱う。
SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_PATHS_LIB="${SCRIPT_DIR%/*}/core/hook-paths.sh"
if [ ! -f "$HOOK_PATHS_LIB" ]; then
    trace "skip: shared library cannot be resolved ($HOOK_PATHS_LIB)"
    exit 0
fi
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/hook-paths.sh
. "$HOOK_PATHS_LIB"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/hook-message.sh
. "${SCRIPT_DIR%/*}/core/hook-message.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/context-cap.sh
. "${SCRIPT_DIR%/*}/core/context-cap.sh"

# 検証未実施の通知。model には「検証されていない」ことだけを伝え、修正指示は出さない。
notify_not_linted() {
    # 通知本文は、未実施の理由と、違反が検出されていないことを伝える。
    local message
    message=$(hook_message warning "references validation not run: ${FILE_PATH}
${1}
No validation ran for this file, so violations have not been detected.")
    jq -n --arg ctx "$message" '{
      "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": $ctx
      }
    }'
}

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [ -z "$FILE_PATH" ]; then
    trace "skip: tool_input.file_path is empty"
    exit 0
fi

# yaml のみ対象。参照の dir かどうかは、テーマの宣言を引いたあとで判定する。
case "$FILE_PATH" in
    *.yaml|*.yml) ;;
    *)
        trace "skip: not a yaml file ($FILE_PATH)"
        exit 0
        ;;
esac

BASE_NAME=$(basename "$FILE_PATH")

# _template.yaml は validator の SKIP_FILES。
# 検証されないのが正しいので、対象外として扱う。
# 下の無音 no-op 検知に流すと、正当なスキップが毎回通知されてしまう。
if [ "$BASE_NAME" = "_template.yaml" ]; then
    trace "skip: validator SKIP_FILES ($BASE_NAME)"
    exit 0
fi

# 編集ファイルの dir から上方向に talk-dir マーカーを探す。
# 探索は logical パスで行う（eslint-check.sh と同一方式）。
# 物理パスにすると、pages/ 自体やその配下が talk-dir 外への symlink だった場合にマーカーを見失う。
DIR=$(CDPATH= cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd)
TALK_ROOT=$(find_talk_root "$DIR" "pages")

if [ -z "$TALK_ROOT" ]; then
    trace "skip: talk-dir marker (slides.md + pages/) not found ($FILE_PATH)"
    exit 0
fi

# 参照 dir かどうかの安価な絞り込みを、slide theme を起こす前に行う。
# 参照 dir の場所はテーマの宣言（layouts.references）で決まるが、dir の名前には "ref" を含む前提を置く。
# talk-dir 内の別の yaml（public/ 配下など）の編集で、テーマ未リンクの通知を出さないため。
# 正確な判定は、slide theme が返す参照 dir の一覧と比べて後から行う。
REL_DIR=${DIR#"$TALK_ROOT"}
case "$REL_DIR" in
    *[Rr]ef*) ;;
    *)
        trace "skip: yaml outside a references-like dir ($FILE_PATH)"
        exit 0
        ;;
esac

# plugin の hooks root を解決する。
# 逆算が成立しない配置（別所へコピーされた等）は、「解決不能」として対象外にする。
# 設定不備（解決できたが dist が無い）とは区別する。
HOOKS_ROOT=$(resolve_hooks_root "$SCRIPT_DIR" "/lib/post-tool-use")

if [ -z "$HOOKS_ROOT" ]; then
    trace "skip: plugin root cannot be resolved (PLUGIN_HOOKS and CLAUDE_PLUGIN_ROOT are unset, and SCRIPT_DIR=$SCRIPT_DIR does not lead back to it)"
    exit 0
fi

# 実行用ミラー（データ置き場の runtime/）側 assets/slidev の validator dist と CLI を供給元として参照する。
# ミラーが無い（初回の build 中など）ときは、未実施の通知を出す。
if ! RUNTIME_DIR="$(resolve_runtime_dir "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"; then
    trace "not-linted: runtime mirror is missing"
    notify_not_linted "The validation environment is not ready (the runtime mirror has not been created yet).
Running the \`pecotv\` command once runs the plugin bootstrap, which restores it."
    exit 0
fi
ASSETS_DIR="$(resolve_slidev_assets_dir "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"
VALIDATOR="$ASSETS_DIR/scripts/eslint/validate-references/dist/index.js"

MISSING=""
[ ! -f "$VALIDATOR" ] && MISSING="assets/slidev/scripts/eslint/validate-references/dist/index.js"
[ ! -f "$RUNTIME_DIR/cli/dist/cli.js" ] && MISSING="${MISSING:+$MISSING, }cli/dist/cli.js"
if ! command -v node > /dev/null 2>&1; then
    MISSING="${MISSING:+$MISSING, }node"
fi
if [ -n "$MISSING" ]; then
    trace "not-linted: validation environment is incomplete ($MISSING / assets: $ASSETS_DIR)"
    notify_not_linted "The validation environment is incomplete (missing: $MISSING / assets: $ASSETS_DIR).
Running the \`pecotv\` command once runs the plugin bootstrap, which restores it."
    exit 0
fi

# テーマの宣言の解釈結果から、参照 yaml を置く dir の一覧を取る。
# テーマを引けないときは、どの dir が参照の dir か決められないので検証できない。
THEME_ERR_FILE=$(mktemp)
trap 'rm -f "$THEME_ERR_FILE"' EXIT
THEME_JSON="$(resolve_talk_theme_json "$RUNTIME_DIR" "$TALK_ROOT" "$THEME_ERR_FILE")"
THEME_EXIT=$?
# CLI の stderr の先頭 1 行。JSON を出せない失敗（Node の版不足など）の原因を、通知と trace に添える。
THEME_ERR=$(head -n 1 "$THEME_ERR_FILE")
if [ $THEME_EXIT -ne 0 ]; then
    THEME_REASON=$(printf '%s\n' "$THEME_JSON" | jq -r '.reason // empty' 2>/dev/null)
    THEME_DETAIL=$(printf '%s\n' "$THEME_JSON" | jq -r '.detail // empty' 2>/dev/null)
    trace "not-linted: theme cannot be resolved (${THEME_REASON:-exit $THEME_EXIT})${THEME_ERR:+ / stderr: $THEME_ERR}"
    case "$THEME_REASON" in
        theme-unlinked)
            notify_not_linted "The theme could not be resolved (reason: theme-unlinked). ${THEME_DETAIL}
Relinking node_modules with slide_sync (node_modules_only: true) restores it."
            ;;
        theme-*)
            notify_not_linted "The theme could not be resolved (reason: ${THEME_REASON}). ${THEME_DETAIL}"
            ;;
        *)
            notify_not_linted "The theme declaration could not be fetched (slide theme exited with $THEME_EXIT). ${THEME_ERR:+
stderr: $THEME_ERR}"
            ;;
    esac
    exit 0
fi

# 編集ファイルの dir（物理パス）が参照 dir のどれかに一致したときだけ、その dir を検証する。
PHYSICAL_DIR=$(CDPATH= cd -P "$DIR" 2>/dev/null && pwd -P)
REFERENCES_DIR=""
while IFS= read -r reference_dir; do
    [ -z "$reference_dir" ] && continue
    if [ "$PHYSICAL_DIR" = "$(CDPATH= cd -P "$reference_dir" 2>/dev/null && pwd -P)" ]; then
        REFERENCES_DIR="$PHYSICAL_DIR"
        break
    fi
done < <(printf '%s\n' "$THEME_JSON" | jq -r '.lint.referencesDirectories[]? // empty' 2>/dev/null)
if [ -z "$REFERENCES_DIR" ]; then
    trace "skip: not a yaml in a theme references dir ($FILE_PATH)"
    exit 0
fi

# validator を実行する。--dir は参照 dir の物理パスを渡す。
# 探索は logical、実行 cwd は物理パスで行う（eslint-check.sh と同型）。
# cd が失敗すると && で短絡し、空出力 + exit 1 になる。
# この場合は、下の「フッター無し」判定が拾う。
OUTPUT=$(CDPATH= cd -P "$TALK_ROOT" && timeout 30 \
    node "$VALIDATOR" --dir "$REFERENCES_DIR" 2>&1)
EXIT=$?

# 完走フッター。
# validator は全ファイルの検証を終えてから結果を出力する構造。
# そのためクラッシュ時は、出力ループに到達せずフッターも出ない。
# exit code は違反とクラッシュで同じ 1 になるため、完走の判別はこのフッターだけが担う。
# 行全体で一致を見る。validator の詳細行は 4 スペース字下げで出る。
# そのため、YAML 由来の文字列がエラーメッセージに載っても行頭一致しない。
# フッターと下の basename 判定は、切り詰める前の全出力に対して行う（フッターは末尾にある）。
FOOTER=$(echo "$OUTPUT" | grep -E '^[0-9]+ files checked, [0-9]+ error\(s\) found\.$' | tail -n 1)

# 編集ファイル自身の検証結果行。
# hook のトリガ条件は *.yaml / *.yml で、ネスト配下も含む。
# validator の対象集合は 参照 dir 直下の *.yaml のみ。
# 両者はずれているため、validator が完走しても編集ファイルが検証されていないことがある。
# 詳細行と衝突しないよう、行全体を固定文字列として比べる。
FILE_CHECKED=false
echo "$OUTPUT" | grep -qxF -e "  ✓ $BASE_NAME" -e "  ✗ $BASE_NAME" && FILE_CHECKED=true

# `category` 欠落の復旧導線。
# schema 層の required 違反は、「何を書けばよいか」を示さない。
# そのため、語彙の元データ（_common.yaml の layout_categories）と同期手段を 1 行で添える。
# 判定は切り詰め前の全出力に対して行い、本文が切れても導線は残す。
CATEGORY_HINT=""
if echo "$OUTPUT" | grep -qF "required property 'category'"; then
    CATEGORY_HINT="
A layout yaml without \`category\` takes an id from \`layout_categories\` in \`_common.yaml\`. Right after a theme update, relinking node_modules with slide_sync (node_modules_only: true) refreshes that vocabulary."
fi

if [ $EXIT -eq 0 ]; then
    # カナリア: validator の main() が実行されないまま、exit 0 で無音終了する退行がある。
    # pass と区別できないので、未実施に振り分ける。
    if [ -z "$FOOTER" ]; then
        trace "not-linted: exit 0 without a completion footer (validator main may not have run / validator: $VALIDATOR)"
        notify_not_linted "The validator exited with 0 but printed no completion footer (validator: $VALIDATOR). The validation may not have run."
        exit 0
    fi

    if [ "$FILE_CHECKED" = false ]; then
        trace "not-linted: validator completed but the edited file is not validated ($BASE_NAME / $FOOTER)"
        notify_not_linted "The validator completed ($FOOTER), but $BASE_NAME is not among the validated files. The validator reads only *.yaml directly under the references dir (*.yml and subdirectories are excluded)."
        exit 0
    fi

    trace "pass: no violations ($BASE_NAME / $FOOTER)"
    exit 0
fi

# 完走したうえでの exit 1 だけを違反とする。
# それ以外の非 0（timeout の 124 / クラッシュ / cd 失敗）と、フッターの無い exit 1 は、
# 検証が完走していないので未実施として扱う。
if [ $EXIT -eq 1 ] && [ -n "$FOOTER" ]; then
    # validator は参照 dir 全体を検証するため、報告は編集ファイル単体の結果ではない。
    # 件数フッターは本文先頭側に置く。
    # 本文が切れても件数が残るよう、フッターは先頭側に置く。
    NOTE=""
    if [ "$FILE_CHECKED" = false ]; then
        NOTE="
$BASE_NAME itself is not among the validated files (the validator reads only *.yaml directly under the references dir)."
    fi
    trace "violation: violations found ($FOOTER / edited file: $BASE_NAME)"
    # 通知本文は、件数フッター・帰属の但し書き・違反の出力・修正依頼の順に並べる。
    cap_context "$PECOTV_CONTEXT_MAX_REFERENCES" '^    \[' violations <<<"$OUTPUT"
    MESSAGE=$(hook_message warning "references schema violations: ${FOOTER}
This is the validation result for the whole references directory (edited file: ${FILE_PATH}).${NOTE}

${CAPPED_BODY}

The output above lists the schema violations.${CATEGORY_HINT}${CAP_NOTE:+
$CAP_NOTE}")
    jq -n --arg ctx "$MESSAGE" '{
      "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": $ctx
      }
    }'
    exit 0
fi

case $EXIT in
    124) REASON="the validator timed out (over 30 seconds)" ;;
    1)
        if [ -n "$OUTPUT" ]; then
            REASON="the validator crashed (exit 1 / no completion footer: broken dist, module resolution failure, missing target dir, etc.)"
        else
            REASON="the validator exited abnormally without output (exit 1 / failed cd to the talk root, etc.)"
        fi
        ;;
    *)   REASON="the validator exited abnormally (exit $EXIT)" ;;
esac

HEAD=$(echo "$OUTPUT" | head -n 10)
trace "not-linted: $REASON ($(echo "$HEAD" | head -n 3 | tr '\n' ' '))"
notify_not_linted "${REASON^}.${HEAD:+
validator output: $HEAD}"
