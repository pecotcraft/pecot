#!/usr/bin/env bash
# ci.yml が、ホストの runner で dev container の取得・起動・実行を担う。サブコマンド: prefetch / up / exec -- <cmd> / restore-owner
# 状態は $RUNNER_TEMP/pecot-dc/ に置く。コンテナに渡す env の名前は DEVCONTAINER_ENV（空白か改行区切り）で受ける。

set -euo pipefail

REPO="${PECOT_CI_IMAGE_REPO:-ghcr.io/pecotcraft/pecot-devcontainer}"
if [ -z "${GITHUB_WORKSPACE:-}" ] || [ -z "${RUNNER_TEMP:-}" ]; then
    echo "GITHUB_WORKSPACE と RUNNER_TEMP が未設定" >&2
    exit 1
fi
OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
STATE="$RUNNER_TEMP/pecot-dc"
OVERRIDE="$STATE/override/devcontainer.json"
LOCAL_IMAGE=pecot-ci-local

mkdir -p "$STATE"

image_ref() {
    local tree
    tree=$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD:.devcontainer)
    echo "$REPO:def-$tree"
}

# 終了コードは最後に書く。待つ側は pull.rc の有無で完了を見る。
pull_image() {
    local ref=$1 start rc=0
    start=$(date +%s)
    docker pull "$ref" > "$STATE/pull.log" 2>&1 || rc=$?
    echo $(($(date +%s) - start)) > "$STATE/pull.seconds"
    echo "$rc" > "$STATE/pull.rc"
}

# 値のあるものだけ渡す（devcontainers/ci と同じ）。
remote_env_args() {
    REMOTE_ENV=()
    local name
    for name in ${DEVCONTAINER_ENV:-}; do
        if [ -n "${!name:-}" ]; then
            REMOTE_ENV+=(--remote-env "$name=${!name}")
        fi
    done
}

cmd_prefetch() {
    local ref
    ref=$(image_ref)
    echo "$ref" > "$STATE/ref"
    rm -f "$STATE/pull.rc" "$STATE/pull.seconds"
    : > "$STATE/pull.started"
    export -f pull_image
    export STATE
    # shellcheck disable=SC2016  # 子の bash に展開させる
    nohup bash -c 'pull_image "$1"' _ "$ref" > /dev/null 2>&1 &
    echo "イメージの取得を始めた: $ref"
}

wait_pull() {
    local i
    for ((i = 0; i < 600; i++)); do
        [ -f "$STATE/pull.rc" ] && return 0
        sleep 1
    done
    echo "イメージの取得が 600 秒で終わらない" >&2
    return 1
}

resolve_image() {
    local ref=$1 digest id secs
    if [ -f "$STATE/pull.started" ]; then
        wait_pull || echo 1 > "$STATE/pull.rc"
    else
        pull_image "$ref"
    fi
    secs=$(cat "$STATE/pull.seconds" 2>/dev/null || echo 不明)
    echo "docker pull の所要: $secs 秒"
    if [ "$(cat "$STATE/pull.rc")" = "0" ]; then
        digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$ref")
        IMAGE_LOCAL=$ref
        image="$ref@${digest##*@}"
        return 0
    fi
    echo "docker pull が失敗したため、PR の定義から build する。pull.log の末尾:" >&2
    tail -n 20 "$STATE/pull.log" >&2 || true
    IMAGE_LOCAL=$LOCAL_IMAGE
    if devcontainer build --workspace-folder "$GITHUB_WORKSPACE" --image-name "$LOCAL_IMAGE" --cache-from "$REPO:latest"; then
        id=$(docker image inspect --format '{{.Id}}' "$LOCAL_IMAGE")
        image="$LOCAL_IMAGE（PR の定義から build, $id）"
    else
        image="$LOCAL_IMAGE（PR の定義から build, 失敗）"
        BUILD_FAILED=1
    fi
}

write_override() {
    local conf
    conf=$(devcontainer read-configuration --workspace-folder "$GITHUB_WORKSPACE")
    mkdir -p "$(dirname "$OVERRIDE")"
    jq --arg image "$IMAGE_LOCAL" \
        '{image: $image, workspaceFolder: .configuration.workspaceFolder, workspaceMount: .configuration.workspaceMount}' \
        <<< "$conf" > "$OVERRIDE"
}

cmd_up() {
    local ref image BUILD_FAILED=0 IMAGE_LOCAL out result
    if ! command -v devcontainer > /dev/null 2>&1; then
        (cd / && npm install -g @devcontainers/cli@0.90.0)
    fi
    ref=$(image_ref)
    resolve_image "$ref"
    echo "image=$image" >> "$OUTPUT"
    echo "PECOT_CI_IMAGE=$image"
    if [ "$BUILD_FAILED" = "1" ]; then
        echo "PR の定義からの build に失敗した" >&2
        exit 1
    fi
    export PECOT_CI_IMAGE="$image"
    echo "$IMAGE_LOCAL" > "$STATE/image-local"
    write_override
    sudo chown -R 1000:1000 "$GITHUB_WORKSPACE"
    remote_env_args
    out=$(devcontainer up --workspace-folder "$GITHUB_WORKSPACE" --override-config "$OVERRIDE" \
        --update-remote-user-uid-default never "${REMOTE_ENV[@]}") || {
        echo "$out"
        echo "devcontainer up が失敗した" >&2
        exit 1
    }
    echo "$out"
    result=$(printf '%s\n' "$out" | tail -n 1)
    if [ "$(jq -r '.outcome' <<< "$result")" != "success" ]; then
        echo "devcontainer up の outcome が success でない" >&2
        exit 1
    fi
    jq -r '.containerId' <<< "$result" > "$STATE/container-id"
}

cmd_exec() {
    [ "${1:-}" = "--" ] && shift
    if [ ! -s "$STATE/container-id" ]; then
        echo "コンテナが起動していない（container-id が無い）" >&2
        exit 1
    fi
    remote_env_args
    devcontainer exec --workspace-folder "$GITHUB_WORKSPACE" --override-config "$OVERRIDE" \
        --container-id "$(cat "$STATE/container-id")" "${REMOTE_ENV[@]}" bash -c "$*"
}

cmd_restore_owner() {
    sudo chown -R "$(id -u):$(id -g)" "$GITHUB_WORKSPACE"
}

sub="${1:-}"
[ $# -gt 0 ] && shift
case "$sub" in
    prefetch) cmd_prefetch ;;
    up) cmd_up ;;
    exec) cmd_exec "$@" ;;
    restore-owner) cmd_restore_owner ;;
    *)
        echo "使い方: dev-container.sh prefetch|up|exec -- <cmd>|restore-owner" >&2
        exit 2
        ;;
esac
