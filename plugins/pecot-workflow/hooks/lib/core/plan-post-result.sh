#!/bin/bash
# 計画の Issue 投稿と結果分岐（plan-issue-poster / plan-post-fallback 共通）。
#
# 提供関数は次のとおり。
# - `pecot_plan_post_submit <issue_ref> <plan_file> <slug>`
#
#     計画を ${CLAUDE_PROJECT_DIR}/.pecot/tmp/plan-post/<slug>.md に書き、`pecot issue comment <ファイル>` で投稿する。
#     書くときは、frontmatter（issue_ref / template: plan）を付ける。
#     ファイル入力にするのは、`-m` の 1 引数上限（MAX_ARG_STRLEN 128 KiB）を避けるため。
#     投稿後は一時ファイルを消す。
#     CLI の出力（stdout+stderr）は PECOT_PLAN_POST_OUTPUT に入れる。
#     戻り値は CLI の exit code（一時ディレクトリを作れないときは 1）。
# - pecot_plan_post_is_validation_failure <exit_code>
#     exit code 3（CLI のテンプレ検証失敗）なら 0。それ以外の非 0 は通信失敗・設定なし等。
# - pecot_plan_post_clear_on_validation_failure <flag_path>
#     検証失敗時の後始末。同じ計画で再試行しても通らないため、再試行用のフラグを消す。
#     消すのは、フラグ（poster: .plan-post-pending / fallback: .processing ロック）と .pecot-quick-mode。
# - pecot_plan_post_manual_message <issue_ref> <issue_number> <output>
#     検証失敗時に返す案内文を stdout に出す。
#     案内文は、--prepare -t plan からの手動投稿 2 手順。
#
# source されるため、自己ディレクトリは BASH_SOURCE[0] から導出する。

_PECOT_PLAN_POST_RESULT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_PECOT_PLAN_POST_RESULT_DIR}/pecot-state-guard.sh"

# CLI がテンプレ検証失敗に割り当てている exit code。
PECOT_PLAN_POST_VALIDATION_EXIT=3

pecot_plan_post_submit() {
    local issue_ref="$1" plan_file="$2" slug="$3"
    local post_dir="${CLAUDE_PROJECT_DIR}/.pecot/tmp/plan-post"
    local post_file="${post_dir}/${slug}.md"
    PECOT_PLAN_POST_OUTPUT=""

    if ! pecot_state_dir_ensure "$post_dir"; then
        PECOT_PLAN_POST_OUTPUT="計画の一時ファイルを置く ${post_dir} を作成できません"
        return 1
    fi

    {
        printf -- '---\n'
        printf 'issue_ref: "%s"\n' "$issue_ref"
        printf 'template: plan\n'
        printf -- '---\n\n'
        cat "$plan_file"
    } > "$post_file"

    local code
    PECOT_PLAN_POST_OUTPUT=$(cd "$CLAUDE_PROJECT_DIR" && env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
        -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
        "${CLAUDE_PLUGIN_ROOT}/bin/pecot" issue comment "$post_file" 2>&1)
    code=$?
    rm -f "$post_file"
    return "$code"
}

pecot_plan_post_is_validation_failure() {
    [ "${1:-}" = "$PECOT_PLAN_POST_VALIDATION_EXIT" ]
}

pecot_plan_post_clear_on_validation_failure() {
    local flag_path="$1"
    rm -f "$flag_path"
    rm -f "${CLAUDE_PROJECT_DIR}/.pecot/state/.pecot-quick-mode"
}

pecot_plan_post_manual_message() {
    local issue_ref="$1" issue_number="$2" output="$3"
    local pecot_bin="\"${CLAUDE_PLUGIN_ROOT}/bin/pecot\""
    printf '%s\n' "計画が Issue コメントの規約を満たさないため、Issue #${issue_number} に投稿しませんでした:
${output}

手動で計画を投稿してください。
  1. ${pecot_bin} issue comment --prepare -t plan -i ${issue_ref} で生成したファイルに計画を書く
  2. ${pecot_bin} issue comment <生成したファイル> で投稿する。"
}
