# shellcheck shell=bash
# shellcheck disable=SC2034
# PR_HEAD_SHA と PR_HEAD_REPO は、呼び出し側が読む（上の disable の理由）。
# merge queue / PR の CI の run を扱う ci スクリプトが共有する関数。
#
# find-pr-ci-base.sh と fetch-pr-nx-cache.sh が source して使う。
#
# 方針（push-range.sh と同じ）:
#   - この lib は `set` しない。source 元のオプションを尊重する。
#   - exit しない。理由の文言も出さない。区分は return で返し、呼び出し側が文言と終わり方を決める。
#   - 参照は `${VAR:-}` を使い、nounset 環境でも安全にする。
#
# 提供する関数:
#   pr_number_from_head_ref <head_ref>
#       → merge_group.head_ref の PR 番号を stdout へ出す。
#         head_ref は `gh-readonly-queue/<base>/pr-<N>-<sha>` の形。
#         読めなければ何も出さず 1 を return する。
#   pr_load_head <repo> <pr>
#       → `pulls/<pr>` から PR_HEAD_SHA と PR_HEAD_REPO を設定する。
#         0: 取得できて repo と同じ repo の PR。
#         1: 取得の失敗。
#         2: fork の PR（repo が違う、または repo が消えている）。
#         PR_HEAD_SHA は空のことがある。要るかどうかは呼び出し側が決める。
#   pr_run_is_for_pr <pr>
#       → stdin の run が、その PR の `pull_request` の run なら 0、違えば 1。
#         run は `event` と `pull_requests` を持つ JSON。
#         run 単体の応答も、List workflow runs の各要素も渡せる。

pr_number_from_head_ref() {
    local pr
    pr=$(sed -nE 's#^(refs/heads/)?gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]+$#\2#p' <<< "${1:-}")
    [[ "$pr" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$pr"
}

pr_load_head() {
    local pull
    PR_HEAD_SHA=""
    PR_HEAD_REPO=""
    if ! pull=$(gh api "repos/${1:-}/pulls/${2:-}"); then
        return 1
    fi
    if ! PR_HEAD_SHA=$(jq -r '.head.sha // ""' <<< "$pull"); then
        return 1
    fi
    if ! PR_HEAD_REPO=$(jq -r '.head.repo.full_name // ""' <<< "$pull"); then
        return 1
    fi
    [ "$PR_HEAD_REPO" = "${1:-}" ] || return 2
    return 0
}

pr_run_is_for_pr() {
    jq -e --argjson pr "${1:-0}" \
        '.event == "pull_request" and ((.pull_requests // []) | map(.number) | index($pr) != null)' > /dev/null
}
