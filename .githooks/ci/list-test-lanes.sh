#!/usr/bin/env bash
# CI の lanes job が、変更が届いた test レーンの一覧を `lanes=<JSON>` と `count=<n>` の 2 行で出す（使い方: list-test-lanes.sh <base> <head>）。
# graph を取れないときは非 0 で止める。空の一覧で通すと、検証を素通しするため。

# shellcheck disable=SC2154  # repo_root と nx_bin は require_repo_node_nx が設定する
set -euo pipefail

# shellcheck source=../lib/push-range.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/push-range.sh"
# shellcheck source=../lib/nx-lanes.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/nx-lanes.sh"

if [ "$#" -ne 2 ]; then
    echo "使い方: list-test-lanes.sh <base> <head>" >&2
    exit 2
fi
base="$1"
head="$2"

require_repo_node_nx ci || exit 1

lane_names=$(nx_lane_targets "$nx_bin" "$repo_root" test) || exit 1

tmp_base="$repo_root/.pecot/tmp"
mkdir -p "$tmp_base"
work=$(mktemp -d "$tmp_base/list-test-lanes.XXXXXX") || {
    echo "ERROR: 一時ディレクトリを作れません（$tmp_base）。" >&2
    exit 1
}
trap 'rm -rf "$work"' EXIT
graph_file="$work/tasks-graph.json"

if needs_all_lanes "$base"; then
    echo "モード: 全レーン（nx run-many -t $lane_names）" >&2
    nx_args=(run-many -t "$lane_names" --graph="$graph_file")
else
    echo "モード: 通常（nx affected -t $lane_names --base=$base --head=$head）" >&2
    nx_args=(affected -t "$lane_names" --base="$base" --head="$head" --graph="$graph_file")
fi

# nx の出力はログへ回し、stdout は 2 行の出力だけにする。
if ! (cd "$repo_root" && env -u FORCE_COLOR -u NX_LEGACY_AFFECTED NO_COLOR=1 "$nx_bin" "${nx_args[@]}") \
    > "$work/nx.log" 2>&1; then
    {
        echo "ERROR: nx の task graph を取れませんでした。"
        sed 's/^/       /' "$work/nx.log"
    } >&2
    exit 1
fi

# shellcheck disable=SC2016  # node へ渡す JS 本文
js='
const fs = require("fs");
const lanes = new Set(process.argv[2].split(","));
const tasks = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).tasks.tasks;
const out = [];
for (const task of Object.values(tasks)) {
    const { project, target } = task.target;
    if (!lanes.has(target)) continue;
    const lane = `${project}:${target}`;
    out.push({ lane, slug: lane.replace(/[^A-Za-z0-9._-]/g, "-") });
}
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
'
# slug の重なりは JS 内で数えて止める。upload-artifact の名前が重なると後の job が 409 で落ちる。
if ! result=$(node -e "$js" "$graph_file" "$lane_names" 2> "$work/node.err"); then
    {
        echo "ERROR: nx の task graph からレーンを読めませんでした。"
        sed 's/^/       /' "$work/node.err"
    } >&2
    exit 1
fi
printf '%s\n' "$result"
