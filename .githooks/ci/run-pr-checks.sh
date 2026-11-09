#!/usr/bin/env bash
# CI で、pre-commit の 3 つの stage を <base>..<head> の範囲指定で流す（使い方: run-pr-checks.sh [--part=<lint|githooks|tests>] <base> <head>）。
# --part=tests には --lane=<project>:<target> を足せる。そのレーン 1 本だけを動かす。
# --part を付けると、その部分の stage だけを流す。オプションは位置引数の前後どちらにも置ける。
#   lint: pre-commit と pre-push。githooks: manual（nx-affected-tests を除く）。tests: manual（githooks-tests を除く）。
# 落ちても最後まで動かし、完了の印 .pecot/tmp/ci/done に exit code を書く。
# NO_PREV=true または base が履歴に無いときは、全レーンのモード（--all-files）にする。

set -euo pipefail

# shellcheck source=../lib/timing.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/timing.sh"
# shellcheck source=../lib/push-range.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/push-range.sh"

usage="使い方: run-pr-checks.sh [--part=<lint|githooks|tests>] [--lane=<project>:<target>] <base> <head>"
part=""
lane=""
positional=()
for arg in "$@"; do
    case "$arg" in
        --part=*) part="${arg#--part=}" ;;
        --lane=*) lane="${arg#--lane=}" ;;
        *) positional+=("$arg") ;;
    esac
done
case "$part" in
    "" | lint | githooks | tests) ;;
    *)
        echo "ERROR: --part は lint・githooks・tests のどれかです: $part" >&2
        echo "$usage" >&2
        exit 2
        ;;
esac
# lane は tests の part で 1 レーンだけ動かすときの指定。形は run-affected-tests.sh が確かめる。
if [ -n "$lane" ] && [ "$part" != "tests" ]; then
    echo "ERROR: --lane は --part=tests と組み合わせて指定します: $lane" >&2
    echo "$usage" >&2
    exit 2
fi
if [ "${#positional[@]}" -ne 2 ] || [ -z "${positional[0]}" ] || [ -z "${positional[1]}" ]; then
    echo "$usage" >&2
    exit 2
fi
base="${positional[0]}"
head="${positional[1]}"

repo_root=$(git rev-parse --show-toplevel 2> /dev/null || echo "")
if [ -z "$repo_root" ]; then
    echo "ERROR: repo root を解決できません（git rev-parse --show-toplevel 失敗）。" >&2
    exit 1
fi
cd "$repo_root"

ci_dir="$repo_root/.pecot/tmp/ci"
done_file="$ci_dir/done"
nx_log="$repo_root/.pecot/tmp/nx-affected-tests/nx-affected-tests.log"
timing_file="$repo_root/$TIMING_RELPATH"

# buildx が無いと Action は警告だけで成功するため、呼び出し側は印の有無で完了を判定する。
# shellcheck disable=SC2329  # trap から呼ばれる
write_done() {
    local rc="$1"
    mkdir -p "$ci_dir" 2> /dev/null || return 0
    printf '%s\n' "$rc" > "$done_file" 2> /dev/null || true
}
nx_cache_pid=""
# shellcheck disable=SC2329  # trap から呼ばれる
stop_nx_cache_server() {
    [ -n "$nx_cache_pid" ] || return 0
    kill -TERM "$nx_cache_pid" 2> /dev/null || true
    wait "$nx_cache_pid" 2> /dev/null || true
    nx_cache_pid=""
}
# shellcheck disable=SC2329  # trap から呼ばれる
on_exit() {
    local rc=$?
    stop_nx_cache_server
    write_done "$rc"
}
trap on_exit EXIT

mkdir -p "$ci_dir"
rm -f "$done_file" "$nx_log"

# この行数より後ろだけを、この run のレーンとして読む。
timing_start_lines=0
if [ -f "$timing_file" ]; then
    timing_start_lines=$(wc -l < "$timing_file")
fi

resolve_pre_commit() {
    if [ -n "${PECOT_PRE_COMMIT:-}" ]; then
        printf '%s\n' "$PECOT_PRE_COMMIT"
        return 0
    fi
    if command -v pre-commit > /dev/null 2>&1; then
        command -v pre-commit
        return 0
    fi
    if ! command -v uv > /dev/null 2>&1; then
        echo "ERROR: pre-commit と uv のどちらも見つかりません。" >&2
        return 1
    fi
    uv tool install pre-commit >&2 || return 1
    printf '%s/pre-commit\n' "$(uv tool dir --bin)"
}
pre_commit=$(resolve_pre_commit) || exit 1

# モードを決める。
mode="通常"
if needs_all_lanes "$base"; then
    mode="全レーン"
fi
base_sha=$(git rev-parse --verify --quiet "${base}^{commit}" 2> /dev/null || printf '%s' "$base")
head_sha=$(git rev-parse --verify --quiet "${head}^{commit}" 2> /dev/null || printf '%s' "$head")

export PECOT_NX_CI=1

# 取り込んだ成果物を返すサーバを立てる。立てられなければ今までどおりキャッシュを使わない。
start_nx_cache_server() {
    local dir="$1" port_file="$ci_dir/nx-cache-port" used_file="$ci_dir/nx-used.txt" token port="" i imported
    local wait_ticks="${PECOT_CI_NX_CACHE_WAIT_TICKS:-100}"
    rm -f "$port_file" "$port_file.tmp" "$used_file" "$used_file.tmp"
    if ! command -v node > /dev/null 2>&1; then
        echo "WARN: node が無いため nx のリモートキャッシュを使いません。" >&2
        return 1
    fi
    token=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    mkdir -p "$dir" || { echo "WARN: 保存先 $dir を作れません。" >&2; return 1; }
    NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN="$token" node "$(dirname "${BASH_SOURCE[0]}")/nx-cache-server.mjs" \
        --dir="$dir" --port-file="$port_file" --used-file="$used_file" >&2 &
    nx_cache_pid=$!
    for ((i = 0; i < wait_ticks; i++)); do
        [ ! -s "$port_file" ] || break
        kill -0 "$nx_cache_pid" 2> /dev/null || break
        sleep 0.1
    done
    port=$(cat "$port_file" 2> /dev/null || true)
    if [ -z "$port" ]; then
        echo "WARN: nx のキャッシュサーバが起動しませんでした。" >&2
        stop_nx_cache_server
        return 1
    fi
    export NX_SELF_HOSTED_REMOTE_CACHE_SERVER="http://127.0.0.1:$port"
    export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN="$token"
    imported=$(find "$dir" -maxdepth 1 -name '*.tar.gz' | wc -l)
    echo "nx のキャッシュサーバ: $NX_SELF_HOSTED_REMOTE_CACHE_SERVER、取り込み済み $imported 件" >&2
}

# 取り込み元の tree と自分の tree、lock の hash、apt のパッケージ一覧の hash を 3 行で出す。キャッシュが外れた原因の切り分けに使う。
nx_diag_lines() {
    local own_tree src_tree lock deb
    own_tree=$(git rev-parse "HEAD^{tree}" 2> /dev/null || echo "-")
    src_tree=$(head -n 1 "$nx_cache_dir/tested-tree.txt" 2> /dev/null || true)
    lock=$(git hash-object pnpm-lock.yaml 2> /dev/null || echo "-")
    deb="-"
    if command -v dpkg-query > /dev/null 2>&1; then
        deb=$(dpkg-query -W -f='${Package}=${Version}\n' 2> /dev/null | sha256sum | cut -c1-12)
    fi
    echo "キャッシュの入力: 取り込み元の tree ${src_tree:--}、自分の tree $own_tree"
    echo "キャッシュの入力: pnpm-lock.yaml の hash $lock"
    echo "キャッシュの入力: apt のパッケージ一覧の hash $deb"
}

# サーバが manual の stage の前に止まっていたら、nx が接続できず task が失敗するため、キャッシュなしに切り替える。
check_nx_cache_alive() {
    [ -n "$nx_cache_pid" ] || return 0
    kill -0 "$nx_cache_pid" 2> /dev/null && return 0
    echo "WARN: nx のキャッシュサーバが落ちているため、キャッシュを使いません。" >&2
    stop_nx_cache_server
    unset NX_SELF_HOSTED_REMOTE_CACHE_SERVER NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN
    export NX_SKIP_NX_CACHE=true
}

# この run でサーバが使った hash の成果物だけを、upload 用の場所に写す。取り込んだだけの古い物は上げない。
collect_nx_upload() {
    local upload="$ci_dir/nx-upload" used="$ci_dir/nx-used.txt" hash
    rm -rf "$upload"
    [ -n "$nx_cache_dir" ] || return 0
    mkdir -p "$upload"
    [ -f "$used" ] || return 0
    while IFS= read -r hash; do
        [[ $hash =~ ^[A-Za-z0-9]+$ ]] || continue
        if [ -f "$nx_cache_dir/$hash.tar.gz" ]; then
            cp "$nx_cache_dir/$hash.tar.gz" "$upload/" || echo "WARN: $hash を写せませんでした。" >&2
        fi
    done < "$used"
    compgen -G "$upload/*.tar.gz" > /dev/null || return 0
    # 取り込む側が tree を比べられるよう、テストした tree（PR では merge commit の tree）を一緒に上げる。
    git rev-parse "HEAD^{tree}" > "$upload/tested-tree.txt" 2> /dev/null || rm -f "$upload/tested-tree.txt"
}

nx_cache_dir=""
if [ "$part" = "tests" ] && [ -n "${PECOT_CI_NX_CACHE:-}" ]; then
    nx_cache_dir="$PECOT_CI_NX_CACHE"
    unset NX_SKIP_NX_CACHE
    start_nx_cache_server "$nx_cache_dir" || export NX_SKIP_NX_CACHE=true
    nx_diag_lines >&2
else
    export NX_SKIP_NX_CACHE=true
fi

stages=(pre-commit pre-push manual)
# part 指定時に、manual の stage で飛ばす hook。テストの 2 つの hook は manual の stage に載っている。
part_skip=""
case "$part" in
    lint) stages=(pre-commit pre-push) ;;
    githooks)
        stages=(manual)
        part_skip="nx-affected-tests"
        ;;
    tests)
        stages=(manual)
        part_skip="githooks-tests"
        ;;
esac
declare -A stage_rc=()

run_stage() {
    # version plan の判定はここでは動かさない。CI では `version-plan` の job が判定する。
    local stage="$1" skip="check-version-plan-required" plan_base=""
    local -a range_args=() extra_env=()
    [ -z "$part_skip" ] || skip="$skip,$part_skip"
    [ -z "${SKIP:-}" ] || skip="$SKIP,$skip"
    if [ "$mode" = "全レーン" ]; then
        range_args=(--all-files)
        if [ "$stage" != "pre-commit" ]; then
            extra_env+=("PRE_COMMIT_TO_REF=$head" "PECOT_VERSION_PLAN_BASE=refs/pecot/ci-no-base")
        fi
    else
        range_args=(--from-ref "$base" --to-ref "$head")
        [ "$stage" = "pre-commit" ] || plan_base="$base"
        [ -z "$plan_base" ] || extra_env+=("PECOT_VERSION_PLAN_BASE=$plan_base")
    fi
    echo "=== stage: $stage ($mode) ==="
    local rc=0
    [ "$stage" != "manual" ] || check_nx_cache_alive
    [ -z "$lane" ] || [ "$stage" != "manual" ] || extra_env+=("PECOT_NX_LANE=$lane")
    env "SKIP=$skip" "${extra_env[@]}" "$pre_commit" run --hook-stage "$stage" \
        "${range_args[@]}" --show-diff-on-failure --color=never || rc=$?
    stage_rc["$stage"]=$rc
    echo "=== stage: $stage 終了 exit=$rc ==="
}

print_lane_rows() {
    [ -f "$timing_file" ] || return 0
    local kind name sec detail target status label
    while IFS=$'\t' read -r _ kind name sec detail; do
        [ "$kind" = "task" ] || continue
        target=$(cut -d: -f2 <<< "$name")
        [[ $target == test-* ]] || continue
        status=${detail#*status=}
        status=${status%% *}
        label=$status
        case "$status" in
            success) label="成功" ;;
            local-cache* | remote-cache) label="成功（キャッシュ）" ;;
            failure) label="失敗" ;;
        esac
        printf '| %s | %s | %ss |\n' "$name" "$label" "$sec"
    done < <(tail -n "+$((timing_start_lines + 1))" "$timing_file")
}

print_lane_table() {
    local rows
    rows=$(print_lane_rows)
    if [ -z "$rows" ]; then
        echo "対象なし（成功）"
        return 0
    fi
    echo "| レーン | 成否 | 所要 |"
    echo "|---|---|---|"
    printf '%s\n' "$rows"
}

# 取り込み元を 1 行で出す。入力は fetch-pr-nx-cache.sh が書く nx-source.txt（key=value の行）。
print_nx_source_line() {
    [ -n "$nx_cache_dir" ] || return 0
    local file="$ci_dir/nx-source.txt" key value status="" run_id="" pr="" head_sha="" reason=""
    if [ -f "$file" ]; then
        while IFS='=' read -r key value; do
            case "$key" in
                status) status=$value ;;
                run_id) run_id=$value ;;
                pr) pr=$value ;;
                head_sha) head_sha=$value ;;
                reason) reason=$value ;;
            esac
        done < "$file"
    fi
    case "$status" in
        imported) echo "キャッシュ: run $run_id（PR #$pr、head $head_sha）から取り込み" ;;
        none) echo "キャッシュ: 取り込みなし（${reason:-記録なし}）" ;;
        *) echo "キャッシュ: 取り込みなし（記録なし）" ;;
    esac
    echo
    nx_diag_lines | sed 's/^/- /'
    echo
}

# nx のログの `Failed tasks:` 以降の `- <project>:<target>` 行を、重複なしで出す。
print_failed_lanes() {
    [ -f "$nx_log" ] || return 0
    local line on=0 lane
    local -A seen=()
    while IFS= read -r line; do
        if [[ $line =~ ^\ *NX\  ]]; then
            on=0
        fi
        if [[ $line == *"Failed tasks:"* ]]; then
            on=1
            continue
        fi
        [ "$on" -eq 1 ] || continue
        if [[ $line =~ ^[[:space:]]*-[[:space:]]+([^:[:space:]]+:[^[:space:]]+) ]]; then
            lane=${BASH_REMATCH[1]}
            if [ -z "${seen[$lane]:-}" ]; then
                seen[$lane]=1
                printf '%s\n' "$lane"
            fi
        fi
    done < "$nx_log"
}

# static 出力の task の塊（見出しは `> nx run <project>:<target>`）から、レーンごとの skip の件数を出す。
print_skip_counts() {
    [ -f "$nx_log" ] || return 0
    local line lane="" task_id target
    local -a order=()
    local -A skipped=()
    local head_re='^(::group::[^ ]+ )?> nx run ([^ ]+)'
    local vitest_re='^[[:space:]]*([^[:space:]]+: )?Tests[[:space:]].*[^0-9]([0-9]+) skipped'
    local pytest_re='([0-9]+) skipped.* in [0-9.]+s'
    while IFS= read -r line; do
        if [[ $line =~ $head_re ]]; then
            task_id=${BASH_REMATCH[2]}
            target=$(cut -d: -f2 <<< "$task_id")
            lane=""
            if [[ $target == test-* ]]; then
                lane=$(cut -d: -f1-2 <<< "$task_id")
                if [ -z "${skipped[$lane]+set}" ]; then
                    skipped[$lane]=0
                    order+=("$lane")
                fi
            fi
        elif [[ $line =~ ^\ *NX\  ]]; then
            lane=""
        elif [ -n "$lane" ]; then
            if [[ $line =~ $vitest_re ]]; then
                skipped[$lane]=$((skipped[$lane] + BASH_REMATCH[2]))
            elif [[ $line =~ $pytest_re ]]; then
                skipped[$lane]=$((skipped[$lane] + BASH_REMATCH[1]))
            fi
        fi
    done < "$nx_log"
    for lane in "${order[@]}"; do
        printf '%s\t%d\n' "$lane" "${skipped[$lane]}"
    done
}

first_line_of() {
    local out
    if command -v "$1" > /dev/null 2>&1 && out=$("$@" 2>&1 | head -n 1) && [ -n "$out" ]; then
        printf '%s\n' "$out"
    else
        echo "なし"
    fi
}

# Step Summary を stdout へ出す。
emit_summary() {
    local stage overall="成功"
    local ci_logs="ci-logs"
    if [ -n "$lane" ]; then
        echo "## 検証の結果（tests: $lane）"
        # ワークフローの matrix.slug と同じ規則（env CHECKS_SLUG があればそれを使う）。
        ci_logs="ci-logs-tests-${CHECKS_SLUG:-${lane//[^A-Za-z0-9._-]/-}}"
    elif [ -n "$part" ]; then
        echo "## 検証の結果（$part）"
        ci_logs="ci-logs-$part"
    else
        echo "## 検証の結果"
    fi
    echo
    echo "### 範囲"
    echo
    echo "- base: \`$base_sha\`"
    echo "- head: \`$head_sha\`（PR では head は merge commit）"
    echo "- モード: $mode"
    echo
    echo "| stage | 成否 |"
    echo "|---|---|"
    for stage in "${stages[@]}"; do
        if [ "${stage_rc[$stage]:-1}" -eq 0 ]; then
            echo "| $stage | 成功 |"
        else
            echo "| $stage | 失敗（exit ${stage_rc[$stage]:-1}） |"
            overall="失敗"
        fi
    done
    echo
    echo "全体: $overall"
    echo
    if [ -z "$part" ] || [ "$part" = "tests" ]; then
        emit_lane_sections "$ci_logs"
    fi
    echo "### 環境"
    echo
    echo "- イメージ: ${PECOT_CI_IMAGE:--}"
    echo "- node: $(first_line_of node --version)"
    echo "- aws: $(first_line_of aws --version)"
    echo "- actionlint: $(first_line_of actionlint --version)"
}

# レーン・失敗・skip の欄。レーンを動かす part（tests と省略時）だけ出す。
emit_lane_sections() {
    local ci_logs="$1" lane count failed
    echo "### レーン"
    echo
    print_lane_table
    echo
    print_nx_source_line
    echo "### 失敗"
    echo
    failed=$(print_failed_lanes)
    if [ -n "$failed" ]; then
        while IFS= read -r lane; do
            echo "- $lane"
        done <<< "$failed"
        echo
        echo "ログは artifact \`$ci_logs\` と、\`Run checks\` の step のログの \`=== 失敗レーン: ... ===\` を見る。"
    else
        echo "なし"
    fi
    echo
    echo "### skip"
    echo
    local skips
    skips=$(print_skip_counts)
    if [ -n "$skips" ]; then
        echo "| レーン | skip |"
        echo "|---|---|"
        while IFS=$'\t' read -r lane count; do
            echo "| $lane | $count |"
        done <<< "$skips"
    else
        echo "なし"
    fi
    echo
}

for stage in "${stages[@]}"; do
    run_stage "$stage"
done

stop_nx_cache_server
collect_nx_upload

if [ -n "${PECOT_CI_SUMMARY:-}" ]; then
    mkdir -p "$(dirname "$PECOT_CI_SUMMARY")"
    emit_summary > "$PECOT_CI_SUMMARY" || echo "WARN: Summary を書けませんでした。" >&2
else
    emit_summary || echo "WARN: Summary を出せませんでした。" >&2
fi

final=0
for stage in "${stages[@]}"; do
    [ "${stage_rc[$stage]:-1}" -eq 0 ] || final=1
done
exit "$final"
