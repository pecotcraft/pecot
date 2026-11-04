#!/bin/bash
# PostToolUse hook: v-slidev 生成プロジェクトで編集された references の yaml に対し、
# validate-references を自動実行する。
#
# プロジェクト root 決定方式:
#   編集ファイルの dir から上方向に、dir を探す。
#   探す dir は、`slides.md` ファイルと `pages/` ディレクトリを持つ。
#   git には依存しない。見つかった dir を TALK_ROOT とする。
#
# 対象の dir は、実行用ミラーの CLI（slide theme --json）が返す lint.referencesDirectories。
# 編集ファイルの dir がその一覧のどれかに一致するときだけ、その dir を validator の --dir に渡す。
# 一致しない yaml（talk-dir 内の別の yaml）は対象外として skip する。
#
# validator は plugin 側 assets/slidev の dist を直接 node 実行する。
# standalone talk-dir には validator dist を同梱しない方針。
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
# 分岐の分類（「検証していない」ことと「違反があった」ことを区別する）:
#   validator は exit code だけでは違反とクラッシュを判別できない（どちらも exit 1）。
#   完走フッター `N files checked, N error(s) found.` の有無を完走の証跡に使う。
#   フッターの無い非 0 は、すべて未実施として扱う。
#   さらに exit 0 でも、検証が実行されていない場合がある。
#   原因は、validator の main が実行されない退行と、
#   hook のトリガ条件と validator の対象集合の不一致。
#   そのため、編集ファイル自身の `✓/✗ <basename>` 行の有無で無音 no-op を検知する。
#     対象外   → trace のみ（対象 YAML でない / talk-dir 外 / plugin root 解決不能）。
#     設定不備 → 【references YAML 検証未実施】（validator dist、node、CLI が無い）。
#     pass     → trace のみ。
#     違反検出 → 【references YAML schema 違反検出】。
#     未実施   → 【references YAML 検証未実施】（無音 no-op / クラッシュ / timeout / 実行異常）。

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
    trace "skip: 共有ライブラリを解決できない ($HOOK_PATHS_LIB)"
    exit 0
fi
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/hook-paths.sh
. "$HOOK_PATHS_LIB"

# 検証未実施の通知。model には「検証されていない」ことだけを伝え、修正指示は出さない。
notify_not_linted() {
    # 通知本文は、未実施の理由と、違反が検出されていないことを伝える。
    local message="【references YAML 検証未実施】ファイル: ${FILE_PATH}
${1}
このファイルの検証は実行されていないため、違反は検出されていません。"
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
    trace "skip: tool_input.file_path が空"
    exit 0
fi

# yaml のみ対象。参照の dir かどうかは、テーマの宣言を引いたあとで判定する。
case "$FILE_PATH" in
    *.yaml|*.yml) ;;
    *)
        trace "skip: yaml でない ($FILE_PATH)"
        exit 0
        ;;
esac

BASE_NAME=$(basename "$FILE_PATH")

# _template.yaml は validator の SKIP_FILES。
# 検証されないのが正しいので、対象外として扱う。
# 下の無音 no-op 検知に流すと、正当なスキップが毎回通知されてしまう。
if [ "$BASE_NAME" = "_template.yaml" ]; then
    trace "skip: validator の SKIP_FILES ($BASE_NAME)"
    exit 0
fi

# 編集ファイルの dir から上方向に talk-dir マーカーを探す。
# 探索は logical パスで行う（eslint-check.sh と同一方式）。
# 物理パスにすると、pages/ 自体やその配下が talk-dir 外への symlink だった場合にマーカーを見失う。
DIR=$(CDPATH= cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd)
TALK_ROOT=$(find_talk_root "$DIR" "pages")

if [ -z "$TALK_ROOT" ]; then
    trace "skip: talk-dir マーカー (slides.md + pages/) が見つからない ($FILE_PATH)"
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
        trace "skip: 参照 dir らしくない場所の yaml ($FILE_PATH)"
        exit 0
        ;;
esac

# plugin の hooks root を解決する。
# 逆算が成立しない配置（別所へコピーされた等）は、「解決不能」として対象外にする。
# 設定不備（解決できたが dist が無い）とは区別する。
HOOKS_ROOT=$(resolve_hooks_root "$SCRIPT_DIR" "/lib/post-tool-use")

if [ -z "$HOOKS_ROOT" ]; then
    trace "skip: plugin root を解決できない (PLUGIN_HOOKS / CLAUDE_PLUGIN_ROOT 未設定 かつ SCRIPT_DIR=$SCRIPT_DIR から逆算不能)"
    exit 0
fi

# 実行用ミラー（データ置き場の runtime/）側 assets/slidev の validator dist と CLI を供給元として参照する。
# ミラーが無い（初回の build 中など）ときは、未実施の通知を出す。
if ! RUNTIME_DIR="$(resolve_runtime_dir "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"; then
    trace "not-linted: 実行用ミラーが無い"
    notify_not_linted "検証環境が未準備です（実行用ミラーがまだ作られていません）。
\`pecotv\` コマンドを一度実行すると plugin の bootstrap が走り復旧します。"
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
    trace "not-linted: 検証環境が不足 ($MISSING / assets: $ASSETS_DIR)"
    notify_not_linted "検証環境が不足しています（不足: $MISSING / assets: $ASSETS_DIR）。
\`pecotv\` コマンドを一度実行すると plugin の bootstrap が走り復旧します。"
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
    trace "not-linted: テーマを引けない (${THEME_REASON:-exit $THEME_EXIT})${THEME_ERR:+ / stderr: $THEME_ERR}"
    case "$THEME_REASON" in
        theme-unlinked)
            notify_not_linted "テーマを引けませんでした（reason: theme-unlinked）。${THEME_DETAIL}
slide_sync（node_modules_only: true）で node_modules を張り直してください。"
            ;;
        theme-*)
            notify_not_linted "テーマを引けませんでした（reason: ${THEME_REASON}）。${THEME_DETAIL}"
            ;;
        *)
            notify_not_linted "テーマの宣言を取得できませんでした（slide theme が exit $THEME_EXIT で終了しました）。${THEME_ERR:+
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
    trace "skip: テーマの参照 dir の yaml でない ($FILE_PATH)"
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
# フッターと下の basename 判定は、どちらも head -n 100 で切り詰める前の全出力に対して行う。
# フッターは末尾にあり、切り詰めた後では必ず失われる。
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
# 判定は切り詰め前の全出力に対して行い、本文末尾に置く。
# 該当行が head -n 100 で切れても、導線は残す。
CATEGORY_HINT=""
if echo "$OUTPUT" | grep -qF "required property 'category'"; then
    CATEGORY_HINT="
\`category\` が無いレイアウト yaml では、\`_common.yaml\` の \`layout_categories\` から id を選んで書いてください。テーマを更新した直後なら、slide_sync（node_modules_only: true）で node_modules を張り直してください。"
fi

# 出力を最大 100 行に制限する。
# 終了コードの捕捉と、フッター / basename 判定より後で行う。
# ここで別コマンドを挟む位置を誤ると、全分岐が exit 0 になり、分類が崩れる。
OUTPUT=$(echo "$OUTPUT" | head -n 100)

if [ $EXIT -eq 0 ]; then
    # カナリア: validator の main() が実行されないまま、exit 0 で無音終了する退行がある。
    # pass と区別できないので、未実施に振り分ける。
    if [ -z "$FOOTER" ]; then
        trace "not-linted: exit 0 だが完走フッターが無い (validator の main が実行されていない疑い / validator: $VALIDATOR)"
        notify_not_linted "validator が exit 0 で終了しましたが、完走を示す出力がありません（validator: $VALIDATOR）。検証が実行されていない可能性があります。"
        exit 0
    fi

    if [ "$FILE_CHECKED" = false ]; then
        trace "not-linted: validator は完走したが編集ファイルが検証対象に含まれない ($BASE_NAME / $FOOTER)"
        notify_not_linted "validator は完走しましたが（$FOOTER）、$BASE_NAME は検証対象に含まれていません。validator が読むのは 参照 dir 直下の *.yaml のみです（*.yml・サブディレクトリ配下は対象外）。"
        exit 0
    fi

    trace "pass: 違反なし ($BASE_NAME / $FOOTER)"
    exit 0
fi

# 完走したうえでの exit 1 だけを違反とする。
# それ以外の非 0（timeout の 124 / クラッシュ / cd 失敗）と、フッターの無い exit 1 は、
# 検証が完走していないので未実施として扱う。
if [ $EXIT -eq 1 ] && [ -n "$FOOTER" ]; then
    # validator は参照 dir 全体を検証するため、報告は編集ファイル単体の結果ではない。
    # 件数フッターは本文先頭側に置く。
    # additionalContext の文字数上限や head -n 100 で末尾が落ちても、件数は残る。
    NOTE=""
    if [ "$FILE_CHECKED" = false ]; then
        NOTE="
なお $BASE_NAME 自体は検証対象に含まれていません（validator が読むのは 参照 dir 直下の *.yaml のみ）。"
    fi
    trace "violation: 違反検出 ($FOOTER / 編集ファイル: $BASE_NAME)"
    # 通知本文は、件数フッター・帰属の但し書き・違反の出力・修正依頼の順に並べる。
    MESSAGE="【references YAML schema 違反検出】${FOOTER}
references ディレクトリ全体の検証結果です（編集ファイル: ${FILE_PATH}）。${NOTE}

${OUTPUT}

上記の違反を修正してください。${CATEGORY_HINT}"
    jq -n --arg ctx "$MESSAGE" '{
      "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": $ctx
      }
    }'
    exit 0
fi

case $EXIT in
    124) REASON="validator が timeout しました (30 秒超過)" ;;
    1)
        if [ -n "$OUTPUT" ]; then
            REASON="validator がクラッシュしました (exit 1 / 完走フッター無し。dist 破損・module 解決失敗・検証対象 dir 不在等)"
        else
            REASON="validator が出力なしで異常終了しました (exit 1 / talk root への cd 失敗等)"
        fi
        ;;
    *)   REASON="validator が異常終了しました (exit $EXIT)" ;;
esac

HEAD=$(echo "$OUTPUT" | head -n 10)
trace "not-linted: $REASON ($(echo "$HEAD" | head -n 3 | tr '\n' ' '))"
notify_not_linted "$REASON。${HEAD:+
validator 出力: $HEAD}"
