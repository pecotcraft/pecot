#!/usr/bin/env bash
# release.yml の本番で、一時ブランチの release commit を最新の main へ入れ、一時ブランチを消す。
# usage: release-land.sh <起点の SHA> <一時ブランチ>。止まるときは一時ブランチを残す。
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

MAX_ATTEMPTS=5

if [ "$#" -ne 2 ]; then
    echo "error: usage: release-land.sh <base-sha> <branch>" >&2
    exit 1
fi
base="$1"
branch="$2"

die() {
    echo "error: $* (branch: $branch)" >&2
    exit 1
}

release_head="$(git rev-parse "refs/heads/$branch")"

if [ "$release_head" = "$(git rev-parse "$base^{commit}")" ]; then
    if ! delete_out="$(git push origin ":refs/heads/$branch" 2>&1)"; then
        printf '%s\n' "$delete_out" | sed 's/^/  /' >&2
        die "failed to delete the temporary branch"
    fi
    echo "skipped: no release commit"
    exit 0
fi

subject="$(git log -1 --format=%s "$release_head")"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main || die "failed to fetch main"
    main_sha="$(git rev-parse refs/remotes/origin/main)"

    if git merge-base --is-ancestor "$main_sha" "$release_head"; then
        git checkout --quiet --detach "$release_head"
        mode="fast-forward"
    else
        git checkout --quiet --detach "$main_sha"
        if ! git merge --quiet --no-ff --no-verify -m "chore(release): merge main into ${subject#chore(release): }" "$release_head" > /dev/null; then
            git merge --abort > /dev/null 2>&1 || true
            die "failed to merge main into the release commit"
        fi
        mode="merged $main_sha"
    fi
    target="$(git rev-parse HEAD)"

    rc=0
    out="$(git push --porcelain --atomic origin "$target:refs/heads/main" ":refs/heads/$branch" 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then
        echo "landed: $target ($mode)"
        exit 0
    fi
    if printf '%s\n' "$out" | grep -E '^!.*\[(remote )?rejected\]' | grep -qE '\((fetch first|non-fast-forward|cannot lock ref|incorrect old value)'; then
        echo "retry: main advanced during push (attempt $attempt/$MAX_ATTEMPTS)" >&2
        continue
    fi
    printf '%s\n' "$out" | sed 's/^/  /' >&2
    die "push to main was rejected"
done

die "main kept advancing; gave up after $MAX_ATTEMPTS attempts"
