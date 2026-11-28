#!/usr/bin/env bash
# bash のテストの結果を Allure の結果（{uuid}-result.json）に書く関数。source 専用。
# bats の run.sh と allure-formatter が使う。

if [ -n "${_ALLURE_RESULT_LOADED:-}" ]; then
    return 0
fi
_ALLURE_RESULT_LOADED=1

allure_result_json() {
    local s="$1" i ch code
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    if [[ "$s" == *[$'\001'-$'\037']* ]]; then
        for ((i = 1; i < 32; i++)); do
            printf -v ch "\\$(printf '%03o' "$i")"
            if [[ "$s" == *"$ch"* ]]; then
                printf -v code '\\u%04x' "$i"
                s="${s//"$ch"/$code}"
            fi
        done
    fi
    printf '"%s"' "$s"
}

# allure_result_now_ms: いまの時刻（エポックからのミリ秒）。
allure_result_now_ms() {
    local t="${EPOCHREALTIME:-}"
    t="${t//[!0-9]/}"
    if [ -n "$t" ]; then
        printf '%s' "$((10#$t / 1000))"
    else
        printf '%s000' "$(date +%s)"
    fi
}

# allure_result_layer <相対パス> <リポのルート>: project の root の test-layers.txt で当たる規則のうち、パスの長いものの層を印字する。
allure_result_layer() {
    local rel="$1" root="$2" dir project="" layer path best="" best_len=-1
    dir="$(dirname "$rel")"
    while [ "$dir" != . ] && [ "$dir" != / ]; do
        if [ -f "$root/$dir/project.json" ]; then
            project="$dir"
            break
        fi
        dir="$(dirname "$dir")"
    done
    [ -n "$project" ] && [ -f "$root/$project/test-layers.txt" ] || return 0
    rel="${rel#"$project"/}"
    while read -r layer path _; do
        [ -n "$path" ] && [[ "$layer" != \#* ]] || continue
        if [ "$rel" = "$path" ] || { [[ "$path" == */ ]] && [[ "$rel" == "$path"* ]]; }; then
            if [ "${#path}" -gt "$best_len" ]; then
                best="$layer"
                best_len="${#path}"
            fi
        fi
    done < "$root/$project/test-layers.txt"
    printf '%s' "$best"
}

# allure_result_severity_default <project> <lane>: 重大度の表（test-conventions.md）を上から読んだ段階。bash に verifies は無く、critical にならない。
allure_result_severity_default() {
    case "$1" in
        githooks | interface-spec) printf 'minor' ;;
        nx-release) printf 'blocker' ;;
        *)
            if [ "$2" = test-release ]; then
                printf 'blocker'
            else
                printf 'normal'
            fi
            ;;
    esac
}

# allure_result_write: 結果を 1 件書く。引数は、結果のディレクトリ・相対パス・枠組み・status・題の順。
# 続けて、理由・start・stop・説明・trace・層・重大度・添付を渡し、比べた値があれば expected と actual を足す。
# 添付は allure_result_attachment の断片を `,` でつないだもの。空なら attachments を書かない。
# 結果のディレクトリが空なら何も書かず、`-` なら 1 行の JSON を stdout に出す。
# ラベルは nx のレーンの値（NX_TASK_TARGET_*）とファイルの場所から決める。重大度が空なら場所から決める。
allure_result_write() {
    local results="$1" rel="$2" framework="$3" status="$4" title="$5" message="$6"
    local start="$7" stop="$8" description="$9" trace="${10}" layer="${11}" severity="${12}" attachments="${13:-}"
    [ -n "$results" ] || return 0
    local project="${NX_TASK_TARGET_PROJECT:-}" lane="${NX_TASK_TARGET_TARGET:-}"
    local uuid details labels feature extra=""
    read -r uuid < /proc/sys/kernel/random/uuid
    details=""
    if [ -n "$message" ]; then
        details="\"message\":$(allure_result_json "$message")"
    fi
    if [ "$#" -ge 15 ]; then
        details="${details:+$details,}\"expected\":$(allure_result_json "${14}"),\"actual\":$(allure_result_json "${15}")"
    fi
    if [ -n "$trace" ]; then
        details="${details:+$details,}\"trace\":$(allure_result_json "$trace")"
    fi
    if [ -n "$description" ]; then
        extra=",\"description\":$(allure_result_json "$description")"
    fi
    if [ -n "$attachments" ]; then
        extra+=",\"attachments\":[$attachments]"
    fi
    labels="{\"name\":\"parentSuite\",\"value\":$(allure_result_json "$rel")}"
    labels+=",{\"name\":\"host\",\"value\":$(allure_result_json "${HOSTNAME:-}")}"
    labels+=",{\"name\":\"thread\",\"value\":$(allure_result_json "$$")}"
    labels+=",{\"name\":\"language\",\"value\":\"bash\"},{\"name\":\"framework\",\"value\":$(allure_result_json "$framework")}"
    [ -n "$project" ] && labels+=",{\"name\":\"project\",\"value\":$(allure_result_json "$project")}"
    [ -n "$lane" ] && labels+=",{\"name\":\"lane\",\"value\":$(allure_result_json "$lane")}"
    [ -n "$project" ] && labels+=",{\"name\":\"epic\",\"value\":$(allure_result_json "$project")}"
    feature=.
    [[ "$rel" == */* ]] && feature="${rel%/*}"
    labels+=",{\"name\":\"feature\",\"value\":$(allure_result_json "$feature")},{\"name\":\"story\",\"value\":$(allure_result_json "$rel")}"
    [ -n "$layer" ] && labels+=",{\"name\":\"layer\",\"value\":$(allure_result_json "$layer")}"
    labels+=",{\"name\":\"severity\",\"value\":\"${severity:-$(allure_result_severity_default "$project" "$lane")}\"}"
    local json
    printf -v json '{"uuid":"%s","name":%s,"fullName":%s,"status":"%s","stage":"finished","statusDetails":{%s},"start":%s,"stop":%s%s,"labels":[%s]}' \
        "$uuid" "$(allure_result_json "$title")" "$(allure_result_json "$project:$lane $rel#$title")" \
        "$status" "$details" "$start" "$stop" "$extra" "$labels"
    if [ "$results" = - ]; then
        printf '%s\n' "$json"
        return 0
    fi
    mkdir -p "$results"
    printf '%s\n' "$json" > "$results/$uuid-result.json"
}

# allure_result_attachment <名前> <source> <型>: 結果の attachments に入れる 1 件の JSON を印字する。
allure_result_attachment() {
    printf '{"name":%s,"source":%s,"type":%s}' "$(allure_result_json "$1")" "$(allure_result_json "$2")" "$(allure_result_json "$3")"
}

# allure_result_split <report の行のファイル> <結果のディレクトリ>: `{"uuid":"…"` で始まる行を、uuid ごとの結果のファイルに書く。
allure_result_split() {
    local line uuid
    mkdir -p "$2"
    while IFS= read -r line; do
        [[ "$line" =~ ^\{\"uuid\":\"([0-9a-f-]+)\" ]] || continue
        uuid="${BASH_REMATCH[1]}"
        printf '%s\n' "$line" > "$2/$uuid-result.json"
    done < "$1"
}

# allure_result_relpath <ファイル> <リポのルート>: リポのルートからの相対パス（.. や symlink を解いた形）。
allure_result_relpath() {
    local dir
    dir="$(cd -P "$(dirname "$1")" 2> /dev/null && pwd -P)" || dir="$(dirname "$1")"
    local abs="$dir/$(basename "$1")"
    printf '%s' "${abs#"$2"/}"
}
