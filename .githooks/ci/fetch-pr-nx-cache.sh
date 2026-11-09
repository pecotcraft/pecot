#!/usr/bin/env bash
# tests の job が nx のキャッシュを取り込む run を選ぶ。同じ repo の同じ PR の、成功した pull_request の run だけを対象にする。
# env: EVENT_NAME・PR_NUMBER・HEAD_REF（merge_group のとき）・REPO・GH_TOKEN・GITHUB_RUN_ID・GITHUB_OUTPUT。
# 見つかれば GITHUB_OUTPUT に run_id= を書く。API の失敗でも 0 で終える。
# 結果は NX_SOURCE_FILE（既定は .pecot/tmp/ci/nx-source.txt）に key=value で書く。
# --download-failed: download の失敗時に、途中の物を消して理由を書き直す。
# そのときの env: SRC_RUN_ID・ARTIFACT_NAME・NX_REMOTE_DIR。

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source_file="${NX_SOURCE_FILE:-$repo_root/.pecot/tmp/ci/nx-source.txt}"
repo="${REPO:-}"
own_run="${GITHUB_RUN_ID:-}"
max_commits=30

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
    [ "$count" != "0" ] || finish_none "artifact なし"
    finish_none "取得の失敗"
fi

case "${EVENT_NAME:-}" in
    pull_request) pr="${PR_NUMBER:-}" ;;
    merge_group)
        pr=$(sed -nE 's#^(refs/heads/)?gh-readonly-queue/[^/]+/pr-([0-9]+)-[0-9a-f]+$#\2#p' <<< "${HEAD_REF:-}")
        ;;
    *) finish_none "対象外の event" ;;
esac
if ! [[ "$pr" =~ ^[0-9]+$ ]] || [ -z "$repo" ]; then
    finish_none "取得の失敗"
fi

pull=$(gh api "repos/$repo/pulls/$pr") || finish_none "取得の失敗"
pull_head_sha=$(jq -r '.head.sha // ""' <<< "$pull") || finish_none "取得の失敗"
pull_head_repo=$(jq -r '.head.repo.full_name // ""' <<< "$pull") || finish_none "取得の失敗"
if [ "$pull_head_repo" != "$repo" ]; then
    finish_none "fork の PR"
fi

commits=$(gh api --paginate "repos/$repo/pulls/$pr/commits?per_page=100" \
    | jq -s -r --argjson n "$max_commits" '(add // []) | map(.sha) | reverse | .[:$n][]') || finish_none "取得の失敗"

# head_repository が repo と一致するかを見る。ブランチ名で絞ると、同名ブランチの fork の run に当たる。
candidates=""
for sha in $commits; do
    found=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?event=pull_request&status=success&head_sha=$sha&per_page=20" \
        | jq -c --arg repo "$repo" --arg own "$own_run" \
            '.workflow_runs[] | select(.event == "pull_request" and .conclusion == "success" and .head_repository.full_name == $repo and (.id | tostring) != $own) | {id, head_sha, created_at}') \
        || finish_none "取得の失敗"
    [ -n "$found" ] && candidates+="$found"$'\n'
done

if [ -z "$candidates" ]; then
    finish_none "run なし"
fi

if [ "$EVENT_NAME" = "merge_group" ]; then
    selected=$(jq -s -c --arg head "$pull_head_sha" 'map(select(.head_sha == $head)) | sort_by(.created_at) | last // empty' <<< "$candidates") || finish_none "取得の失敗"
    [ -n "$selected" ] || finish_none "head 不一致"
else
    selected=$(jq -s -c 'sort_by(.created_at) | last' <<< "$candidates") || finish_none "取得の失敗"
fi

run_id=$(jq -r '.id' <<< "$selected")
run_head=$(jq -r '.head_sha' <<< "$selected")
tree=$(gh api "repos/$repo/git/commits/$run_head" 2> /dev/null | jq -r '.tree.sha // ""') || tree=""

write_source "status=imported" "run_id=$run_id" "pr=$pr" "head_sha=$run_head" "tree=$tree"
echo "nx キャッシュの取り込み元: run $run_id（PR #$pr、head $run_head）"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "run_id=$run_id" >> "$GITHUB_OUTPUT"
fi
