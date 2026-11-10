#!/usr/bin/env bash
# ci.yml と devcontainer-image.yml が、ホストの runner で dev container の取得・起動・実行を担う。
# サブコマンド: prefetch / up / exec -- <cmd> / restore-owner / install-cli / tag / publish。
# 状態は $RUNNER_TEMP/pecot-dc/ に置く。コンテナに渡す env は COMMON_ENV と、job 固有の追加分 DEVCONTAINER_ENV（空白か改行区切り）。

set -euo pipefail

# dependabot が追えないため手で上げる。
CLI_VERSION=0.90.0
COMMON_ENV="CI NX_BASE NX_HEAD NO_PREV PECOT_NX_CI PECOTV_E2E_CEILING_SCALE PECOT_NX_PARALLEL PECOT_CI_IMAGE PECOT_CI_SUMMARY"
REPO="${PECOT_CI_IMAGE_REPO:-ghcr.io/pecotcraft/pecot-devcontainer}"
if [ -z "${GITHUB_WORKSPACE:-}" ] || [ -z "${RUNNER_TEMP:-}" ]; then
    echo "GITHUB_WORKSPACE と RUNNER_TEMP が未設定" >&2
    exit 1
fi
OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
STATE="$RUNNER_TEMP/pecot-dc"
OVERRIDE="$STATE/override/devcontainer.json"
LOCAL_IMAGE=pecot-ci-local
PULL_TIMEOUT="${PECOT_DC_PULL_TIMEOUT:-600}"
IMAGE=""
IMAGE_LOCAL=""
BUILD_FAILED=0

# image に入るファイルだけの hash にする（README などの変更で tag を変えない）。
tag_key() {
    key_of HEAD
}

key_of() {
    git -C "$GITHUB_WORKSPACE" ls-tree "$1" -- .devcontainer/Dockerfile .devcontainer/devcontainer.json \
        .devcontainer/devcontainer-lock.json .devcontainer/features | git hash-object --stdin
}

image_ref() {
    echo "$REPO:def-$(tag_key)"
}

cmd_install_cli() {
    if command -v devcontainer > /dev/null 2>&1 && [ "$(devcontainer --version)" = "$CLI_VERSION" ]; then
        return 0
    fi
    (cd / && npm install -g "@devcontainers/cli@$CLI_VERSION")
}

# 終了コードは最後に、tmp 経由で置く。待つ側は pull.rc の有無で完了を見る。
pull_image() {
    local ref=$1 start rc=0
    start=$(date +%s)
    docker pull "$ref" > "$STATE/pull.log" 2>&1 || rc=$?
    echo $(($(date +%s) - start)) > "$STATE/pull.seconds"
    echo "$rc" > "$STATE/pull.rc.tmp"
    mv "$STATE/pull.rc.tmp" "$STATE/pull.rc"
}

# 値のあるものだけ渡す（devcontainers/ci と同じ）。
remote_env_args() {
    REMOTE_ENV=()
    local name
    for name in $COMMON_ENV ${DEVCONTAINER_ENV:-}; do
        if [[ ! $name =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
            echo "env の名前が不正: $name" >&2
            exit 1
        fi
        if [ -n "${!name:-}" ]; then
            REMOTE_ENV+=(--remote-env "$name=${!name}")
        fi
    done
}

cmd_prefetch() {
    local ref
    mkdir -p "$STATE"
    ref=$(image_ref)
    echo "$ref" > "$STATE/ref"
    rm -f "$STATE/pull.rc" "$STATE/pull.rc.tmp" "$STATE/pull.seconds" "$STATE/pull.pid"
    : > "$STATE/pull.started"
    export -f pull_image
    export STATE
    # shellcheck disable=SC2016  # 子の bash に展開させる
    nohup bash -c 'pull_image "$1"' _ "$ref" > /dev/null 2>&1 &
    echo $! > "$STATE/pull.pid"
    echo "イメージの取得を始めた: $ref"
}

wait_pull() {
    local i pid=""
    [ -f "$STATE/pull.pid" ] && pid=$(cat "$STATE/pull.pid")
    for ((i = 0; i < PULL_TIMEOUT; i++)); do
        [ -f "$STATE/pull.rc" ] && return 0
        if [ -n "$pid" ] && ! kill -0 "$pid" 2> /dev/null; then
            [ -f "$STATE/pull.rc" ] && return 0
            echo "イメージの取得のプロセスが結果を残さず終了した" >&2
            return 1
        fi
        sleep 1
    done
    [ -f "$STATE/pull.rc" ] && return 0
    echo "イメージの取得が $PULL_TIMEOUT 秒で終わらない" >&2
    if [ -n "$pid" ]; then
        pkill -P "$pid" 2> /dev/null || true
        kill "$pid" 2> /dev/null || true
    fi
    rm -f "$STATE/pull.rc" "$STATE/pull.rc.tmp"
    return 1
}

resolve_image() {
    local ref=$1 digest id secs
    if [ -f "$STATE/pull.started" ]; then
        wait_pull || echo 1 > "$STATE/pull.rc"
    else
        pull_image "$ref"
    fi
    secs=$(cat "$STATE/pull.seconds" 2> /dev/null || echo 不明)
    echo "docker pull の所要: $secs 秒"
    if [ "$(cat "$STATE/pull.rc")" = "0" ]; then
        digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$ref") || {
            echo "docker image inspect（RepoDigests）に失敗した" >&2
            exit 1
        }
        IMAGE_LOCAL=$ref
        IMAGE="$ref@${digest##*@}"
        return 0
    fi
    echo "docker pull が失敗したため、PR の定義から build する。pull.log の末尾:" >&2
    tail -n 20 "$STATE/pull.log" >&2 || true
    IMAGE_LOCAL=$LOCAL_IMAGE
    if devcontainer build --workspace-folder "$GITHUB_WORKSPACE" --image-name "$LOCAL_IMAGE" --cache-from "$REPO:latest"; then
        id=$(docker image inspect --format '{{.Id}}' "$LOCAL_IMAGE") || {
            echo "docker image inspect（Id）に失敗した" >&2
            exit 1
        }
        IMAGE="$LOCAL_IMAGE（PR の定義から build, $id）"
    else
        IMAGE="$LOCAL_IMAGE（PR の定義から build, 失敗）"
        BUILD_FAILED=1
    fi
}

# lifecycle・mounts・containerEnv はイメージの devcontainer.metadata の label から来るため、ほかのキーを渡すと重なる。
write_override() {
    local conf
    conf=$(devcontainer read-configuration --workspace-folder "$GITHUB_WORKSPACE") || {
        echo "devcontainer read-configuration に失敗した" >&2
        exit 1
    }
    mkdir -p "$(dirname "$OVERRIDE")"
    jq -e --arg image "$IMAGE_LOCAL" \
        '{image: $image, workspaceFolder: .configuration.workspaceFolder, workspaceMount: .configuration.workspaceMount}
         | select(.workspaceFolder != null and .workspaceMount != null)' \
        <<< "$conf" > "$OVERRIDE" || {
        echo "read-configuration の結果に workspaceFolder か workspaceMount が無い" >&2
        exit 1
    }
}

cmd_up() {
    local ref out result outcome cid
    mkdir -p "$STATE"
    cmd_install_cli
    ref=$(image_ref)
    resolve_image "$ref"
    echo "image=$IMAGE" >> "$OUTPUT"
    echo "PECOT_CI_IMAGE=$IMAGE"
    if [ "$BUILD_FAILED" = "1" ]; then
        echo "PR の定義からの build に失敗した" >&2
        exit 1
    fi
    export PECOT_CI_IMAGE="$IMAGE"
    echo "$IMAGE_LOCAL" > "$STATE/image-local"
    write_override
    # --update-remote-user-uid-default never と対で、イメージの vscode の UID が 1000 である前提。
    sudo chown -R 1000:1000 "$GITHUB_WORKSPACE"
    remote_env_args
    out=$(devcontainer up --workspace-folder "$GITHUB_WORKSPACE" --override-config "$OVERRIDE" \
        --update-remote-user-uid-default never "${REMOTE_ENV[@]}") || {
        echo "$out"
        echo "devcontainer up が失敗した" >&2
        exit 1
    }
    echo "$out"
    result=$(printf '%s\n' "$out" | grep '^{' | tail -n 1 || true)
    if [ -z "$result" ]; then
        echo "devcontainer up の出力に結果の JSON が無い" >&2
        exit 1
    fi
    outcome=$(jq -r '.outcome' <<< "$result" || true)
    if [ "$outcome" != "success" ]; then
        echo "devcontainer up の outcome が success でない" >&2
        exit 1
    fi
    cid=$(jq -er '.containerId // empty' <<< "$result" || true)
    if [ -z "$cid" ]; then
        echo "devcontainer up の結果に containerId が無い" >&2
        exit 1
    fi
    echo "$cid" > "$STATE/container-id"
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

# ci の key は PR の merge commit の tree から出る。base が進んでずれると tag が当たらず、ci は build に回る。
warn_merged_key_drift() {
    local base=$1 tree merged
    tree=$(git -C "$GITHUB_WORKSPACE" merge-tree --write-tree "origin/$base" HEAD 2> /dev/null) || return 0
    merged=$(key_of "${tree%%$'\n'*}") || return 0
    if [ "$merged" != "$(tag_key)" ]; then
        echo "::warning::origin/$base との merge 後の key が def-$merged で、載せる def-$(tag_key) と違う。ci はこの tag を使えない"
    fi
}

# --push と --latest の無い呼び出しは build だけにする。--push だけのときは、既存の tag を上書きしない。
cmd_publish() {
    local push=0 latest=0 no_cache=0 base="" ref
    while [ $# -gt 0 ]; do
        case "$1" in
            --push) push=1 ;;
            --latest) latest=1 ;;
            --no-cache) no_cache=1 ;;
            --base)
                base=${2:?--base に値が要る}
                shift
                ;;
            *)
                echo "publish の引数が不正: $1" >&2
                exit 2
                ;;
        esac
        shift
    done
    ref=$(image_ref)
    if [ "$push" = 1 ] && [ "$latest" = 0 ] && docker buildx imagetools inspect "$ref" > /dev/null 2>&1; then
        echo "$ref already exists. Skip build and push."
        return 0
    fi
    [ -n "$base" ] && warn_merged_key_drift "$base"
    # buildx は何も指定しないと unknown/unknown の attestation manifest を付け、GHCR の一覧に余計な行が出る。
    export BUILDX_NO_DEFAULT_ATTESTATIONS=1
    local args=(--workspace-folder "$GITHUB_WORKSPACE" --image-name "$ref" --cache-from "$REPO:latest")
    [ "$latest" = 1 ] && args+=(--image-name "$REPO:latest")
    # 層は zstd で push する。gzip だと、CI の job の pull で展開に 20 秒以上かかる。
    [ "$push" = 1 ] && args+=(--output "type=registry,compression=zstd,force-compression=true,oci-mediatypes=true")
    [ "$no_cache" = 1 ] && args+=(--no-cache)
    devcontainer build "${args[@]}"
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
    install-cli) cmd_install_cli ;;
    tag) image_ref ;;
    publish) cmd_publish "$@" ;;
    *)
        echo "使い方: dev-container.sh prefetch|up|exec -- <cmd>|restore-owner|install-cli|tag" >&2
        echo "        dev-container.sh publish [--push] [--latest] [--no-cache] [--base <branch>]" >&2
        exit 2
        ;;
esac
