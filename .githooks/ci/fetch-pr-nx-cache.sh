#!/usr/bin/env bash
# tests の job が nx のキャッシュを取り込む run を選ぶ。同じ repo の同じ PR の run で、このレーンの artifact を持つ最新のものにする。
# --download-failed: download の失敗時に、途中の物を消して理由を書き直す。

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/pr-run.sh
source "$repo_root/.githooks/lib/pr-run.sh"
source_file="${NX_SOURCE_FILE:-$repo_root/.pecot/tmp/ci/nx-source.txt}"
repo="${REPO:-}"
own_run="${GITHUB_RUN_ID:-}"

write_source() {
    mkdir -p "$(dirname "$source_file")"
    printf '%s\n' "$@" > "$source_file"
}

finish_none() {
    write_source "status=none" "reason=$1"
    echo "nx キャッシュの取り込みなし: $1"
    exit 0
}

if [ "${1:-}" = "--download-failed" ]; then
    rm -rf "${NX_REMOTE_DIR:-$repo_root/.pecot/tmp/ci/nx-remote}"
    count=$(gh api "repos/$repo/actions/runs/${SRC_RUN_ID:-}/artifacts?name=${ARTIFACT_NAME:-}" \
        | jq -r '.total_count') || count=""
    [ -n "$count" ] || finish_none "取得の失敗"
    [ "$count" != "0" ] || finish_none "artifact なし"
    finish_none "download の失敗"
fi

case "${EVENT_NAME:-}" in
    pull_request) pr="${PR_NUMBER:-}" ;;
    merge_group) pr=$(pr_number_from_head_ref "${HEAD_REF:-}") || pr="" ;;
    *) finish_none "対象外の event" ;;
esac
if ! [[ "$pr" =~ ^[0-9]+$ ]]; then
    finish_none "PR 番号不明"
fi
if [ -z "$repo" ]; then
    finish_none "取得の失敗"
fi

pr_load_head "$repo" "$pr"
case $? in
    0) ;;
    2) finish_none "fork の PR" ;;
    *) finish_none "取得の失敗" ;;
esac
pull_head_sha="$PR_HEAD_SHA"
repo_id=$(gh api "repos/$repo" | jq -r '.id // ""') || finish_none "取得の失敗"
[ -n "$repo_id" ] || finish_none "取得の失敗"

commits=$(gh api --paginate "repos/$repo/pulls/$pr/commits?per_page=100" \
    | jq -s -c '(add // []) | map(.sha)') || finish_none "取得の失敗"

# artifact は job の成功時だけ上がる。head_repository_id で、同名ブランチの fork の run を除く。
candidates=$(gh api "repos/$repo/actions/artifacts?name=${ARTIFACT_NAME:-}&per_page=100" \
    | jq -c --argjson id "$repo_id" --argjson commits "$commits" --arg own "$own_run" \
        '[.artifacts[] | select(.expired == false and .workflow_run.head_repository_id == $id and (.workflow_run.head_sha as $s | $commits | index($s)) and (.workflow_run.id | tostring) != $own) | {id: .workflow_run.id, head_sha: .workflow_run.head_sha, created_at}] | sort_by(.created_at) | reverse') \
    || finish_none "取得の失敗"

if [ "$candidates" = "[]" ]; then
    finish_none "run なし"
fi

if [ "$EVENT_NAME" = "merge_group" ]; then
    candidates=$(jq -c --arg head "$pull_head_sha" 'map(select(.head_sha == $head))' <<< "$candidates") || finish_none "取得の失敗"
    [ "$candidates" != "[]" ] || finish_none "head 不一致"
fi

# stacked PR などで同じ sha を持つ別の PR の run を除く。
selected=""
while IFS= read -r cand; do
    cid=$(jq -r '.id' <<< "$cand")
    info=$(gh api "repos/$repo/actions/runs/$cid") || finish_none "取得の失敗"
    if pr_run_is_for_pr "$pr" <<< "$info"; then
        selected="$cand"
        break
    fi
done < <(jq -c '.[]' <<< "$candidates")
[ -n "$selected" ] || finish_none "run なし"

run_id=$(jq -r '.id' <<< "$selected")
run_head=$(jq -r '.head_sha' <<< "$selected")

write_source "status=imported" "run_id=$run_id" "pr=$pr" "head_sha=$run_head"
echo "nx キャッシュの取り込み元: run $run_id（PR #$pr、head $run_head）"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "run_id=$run_id" >> "$GITHUB_OUTPUT"
fi
