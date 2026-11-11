#!/usr/bin/env bash
# CI の lanes job が、変更が届いた test レーンの一覧を `lanes=<JSON>`・`count=<n>`・`lint=run|skip` の 3 行で出す。
# 使い方: list-test-lanes.sh [--pr-main=<sha> --queue-base=<sha>] <base> <head>（オプションは位置引数の前後どちらでも可）
# 2 つのオプションは組で使う（積モード）。lanes は、PR の変更のレーン（queue-base..head）と main の変更のレーン（pr-main..queue-base）の積。
# lint=skip は積モードで pr-main と queue-base が同じ commit のときだけ。graph を取れないときは非 0 で止める。

# shellcheck disable=SC2154  # repo_root と nx_bin は require_repo_node_nx が設定する
set -euo pipefail

# shellcheck source=../lib/push-range.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/push-range.sh"
# shellcheck source=../lib/nx-lanes.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/nx-lanes.sh"

usage="使い方: list-test-lanes.sh [--pr-main=<sha> --queue-base=<sha>] <base> <head>"
pr_main=""
queue_base=""
positional=()
for arg in "$@"; do
    case "$arg" in
        --pr-main=*) pr_main="${arg#--pr-main=}" ;;
        --queue-base=*) queue_base="${arg#--queue-base=}" ;;
        *) positional+=("$arg") ;;
    esac
done
if { [ -n "$pr_main" ] && [ -z "$queue_base" ]; } || { [ -z "$pr_main" ] && [ -n "$queue_base" ]; }; then
    echo "ERROR: --pr-main と --queue-base は組で指定します。" >&2
    echo "$usage" >&2
    exit 2
fi
if [ "${#positional[@]}" -ne 2 ]; then
    echo "$usage" >&2
    exit 2
fi
base="${positional[0]}"
head="${positional[1]}"

require_repo_node_nx ci || exit 1

lane_names=$(nx_lane_targets "$nx_bin" "$repo_root" test) || exit 1

tmp_base="$repo_root/.pecot/tmp"
mkdir -p "$tmp_base"
work=$(mktemp -d "$tmp_base/list-test-lanes.XXXXXX") || {
    echo "ERROR: 一時ディレクトリを作れません（$tmp_base）。" >&2
    exit 1
}
trap 'rm -rf "$work"' EXIT
graph_pr="$work/tasks-graph-pr.json"
graph_main="$work/tasks-graph-main.json"

run_nx() {
    # nx の出力はログへ回し、stdout は 3 行の出力だけにする。
    if ! (cd "$repo_root" && env -u FORCE_COLOR -u NX_LEGACY_AFFECTED NO_COLOR=1 "$nx_bin" "$@") \
        > "$work/nx.log" 2>&1; then
        {
            echo "ERROR: nx の task graph を取れませんでした。"
            sed 's/^/       /' "$work/nx.log"
        } >&2
        exit 1
    fi
}

stack=false
if [ -n "$pr_main" ]; then
    if git cat-file -e "${pr_main}^{commit}" 2> /dev/null \
        && git cat-file -e "${queue_base}^{commit}" 2> /dev/null \
        && git cat-file -e "${head}^{commit}" 2> /dev/null; then
        stack=true
    else
        echo "WARN: --pr-main・--queue-base・head のどれかが commit として読めません。積を取らず通常のモードに戻します。" >&2
    fi
fi

lint=run
# 積は pr_main..queue_base と queue_base..head の 2 つの範囲だけで決まるので、needs_all_lanes（NO_PREV）を通らない。SHA が読めなければ通常のモードに戻る。
if [ "$stack" = true ]; then
    echo "モード: 積（PR: nx affected --base=$queue_base --head=$head / main: $pr_main..$queue_base）" >&2
    run_nx affected -t "$lane_names" --base="$queue_base" --head="$head" --graph="$graph_pr"
    if [ "$(git rev-parse "${pr_main}^{commit}")" = "$(git rev-parse "${queue_base}^{commit}")" ]; then
        lint=skip
        printf '%s\n' '{"tasks":{"tasks":{}}}' > "$graph_main"
    else
        run_nx affected -t "$lane_names" --base="$pr_main" --head="$queue_base" --graph="$graph_main"
    fi
elif needs_all_lanes "$base"; then
    echo "モード: 全レーン（nx run-many -t $lane_names）" >&2
    run_nx run-many -t "$lane_names" --graph="$graph_pr"
else
    echo "モード: 通常（nx affected -t $lane_names --base=$base --head=$head）" >&2
    run_nx affected -t "$lane_names" --base="$base" --head="$head" --graph="$graph_pr"
fi

# shellcheck disable=SC2016  # node へ渡す JS 本文
js='
const fs = require("fs");
const lanes = new Set(process.argv[1].split(","));
const readLanes = (file) => {
    const found = new Map();
    const tasks = JSON.parse(fs.readFileSync(file, "utf8")).tasks.tasks;
    for (const task of Object.values(tasks)) {
        const { project, target } = task.target;
        if (!lanes.has(target)) continue;
        const lane = `${project}:${target}`;
        found.set(lane, { lane, slug: lane.replace(/[^A-Za-z0-9._-]/g, "-") });
    }
    return found;
};
const prLanes = readLanes(process.argv[2]);
const mainLanes = process.argv[3] ? readLanes(process.argv[3]) : null;
const out = [...prLanes.values()].filter((x) => !mainLanes || mainLanes.has(x.lane));
const bySlug = new Map();
for (const { lane, slug } of out) bySlug.set(slug, [...(bySlug.get(slug) || []), lane]);
for (const [slug, names] of bySlug) {
    if (names.length > 1) {
        console.error(`duplicate slug ${slug}: ${names.join(", ")}`);
        process.exit(3);
    }
}
out.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
process.stdout.write(`lanes=${JSON.stringify(out)}\ncount=${out.length}\n`);
if (mainLanes) {
    process.stdout.write(`pr=${[...prLanes.keys()].join(",")}\nmain=${[...mainLanes.keys()].join(",")}\nproduct=${out.map((x) => x.lane).join(",")}\n`);
}
'
# slug の重なりは JS 内で数えて止める。upload-artifact の名前が重なると後の job が 409 で落ちる。
main_file=""
[ "$stack" = true ] && main_file="$graph_main"
if ! result=$(node -e "$js" "$lane_names" "$graph_pr" "$main_file" 2> "$work/node.err"); then
    {
        echo "ERROR: nx の task graph からレーンを読めませんでした。"
        sed 's/^/       /' "$work/node.err"
    } >&2
    exit 1
fi
cat "$work/node.err" >&2
if [ "$stack" = true ]; then
    show() { v=$(printf '%s\n' "$result" | sed -n "s/^$1=//p"); echo "$2: ${v:-なし}" >&2; }
    show pr "PR の変更のレーン"
    show main "main の変更のレーン"
    show product 積
fi
printf '%s\n' "$result" | grep -E '^(lanes|count)='
printf 'lint=%s\n' "$lint"
