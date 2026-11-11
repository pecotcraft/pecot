#!/usr/bin/env bash
# merge queue の lanes job が、PR の CI がテストした main の SHA（M0）を探す。
# env: HEAD_REF（merge_group.head_ref）・REPO・GH_TOKEN。
# QUEUE_BASE は merge_group.base_sha、QUEUE_HEAD は merge_group.head_sha。
# 出力: 成功時は stdout に `pr_main=<sha>` の 1 行。出せないときは stdout に何も出さず、stderr に `reason=<理由>` を 1 行出して exit 0。

set -uo pipefail

repo="${REPO:-}"
queue_base="${QUEUE_BASE:-}"
queue_head="${QUEUE_HEAD:-}"

none() {
    echo "reason=$1" >&2
    exit 0
}

pr=$(sed -nE 's#^(refs/heads/)?gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]+$#\2#p' <<< "${HEAD_REF:-}")
[[ "$pr" =~ ^[0-9]+$ ]] || none "PR 番号不明"
[ -n "$repo" ] && [ -n "$queue_base" ] && [ -n "$queue_head" ] || none "入力の不足"

pull=$(gh api "repos/$repo/pulls/$pr") || none "取得の失敗"
pr_head=$(jq -r '.head.sha // ""' <<< "$pull") || none "取得の失敗"
head_repo=$(jq -r '.head.repo.full_name // ""' <<< "$pull") || none "取得の失敗"
[ "$head_repo" = "$repo" ] || none "fork の PR"
[ -n "$pr_head" ] || none "取得の失敗"

parent=$(git rev-parse "$queue_head^1" 2> /dev/null) || none "queue の commit を読めない"
[ "$parent" = "$queue_base" ] || none "queue の commit の親が base でない"

merged=$(git merge-tree --write-tree "$queue_base" "$pr_head" 2> /dev/null) || none "merge-tree が失敗（衝突または commit なし）"
merged_tree=$(head -n 1 <<< "$merged")
queue_tree=$(git rev-parse "$queue_head^{tree}" 2> /dev/null) || none "queue の tree を読めない"
[ "$merged_tree" = "$queue_tree" ] || none "tree 不一致"

runs=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?event=pull_request&head_sha=$pr_head&status=success&per_page=100" \
    | jq -c '[.workflow_runs[]? | {id, created_at}] | sort_by(.created_at) | reverse') || none "取得の失敗"
[ "$runs" != "[]" ] || none "成功した run なし"

tmp_base="$(git rev-parse --show-toplevel)/.pecot/tmp"
mkdir -p "$tmp_base"
work=$(mktemp -d "$tmp_base/find-pr-ci-base.XXXXXX") || none "一時ディレクトリを作れない"
trap 'rm -rf "$work"' EXIT

last_reason="成功した run なし"
while IFS= read -r id; do
    info=$(gh api "repos/$repo/actions/runs/$id") || { last_reason="取得の失敗"; continue; }
    if ! jq -e --argjson pr "$pr" '.event == "pull_request" and ((.pull_requests // []) | map(.number) | index($pr) != null)' <<< "$info" > /dev/null; then
        last_reason="run に PR が含まれない"
        continue
    fi
    dir="$work/$id"
    mkdir -p "$dir"
    if ! gh run download "$id" -R "$repo" -n ci-base -D "$dir" > /dev/null 2>&1 || [ ! -f "$dir/ci-base.txt" ]; then
        last_reason="ci-base なし"
        continue
    fi
    main_sha=$(sed -nE 's/^main_sha=(.*)$/\1/p' "$dir/ci-base.txt" | head -n 1)
    art_head=$(sed -nE 's/^pr_head=(.*)$/\1/p' "$dir/ci-base.txt" | head -n 1)
    if [ "$art_head" != "$pr_head" ]; then
        last_reason="pr_head 不一致"
        continue
    fi
    if ! [[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || ! git merge-base --is-ancestor "$main_sha" "$queue_base" 2> /dev/null; then
        last_reason="main_sha が base の祖先でない"
        continue
    fi
    echo "pr_main=$main_sha"
    exit 0
done < <(jq -r '.[].id' <<< "$runs")

none "$last_reason"
