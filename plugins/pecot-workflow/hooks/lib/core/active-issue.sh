#!/bin/bash
# 作業中の Issue の番号を、git のブランチ名と remote から求める。CLI の activeIssueFromBranch と同じ規則。

# 番号を出す。末尾の区切りが数字だけのブランチで、主の remote の URL が CLI の parseRemoteUrl の 3 形式に合うときだけ。
# @param $1 dir  git の作業ディレクトリ。
pecot_active_issue_number() {
    local dir="$1" branch number remotes remote url
    [ -n "$dir" ] || return 1
    branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null) || return 1
    number="${branch##*/}"
    [[ "$number" =~ ^[0-9]+$ ]] || return 1
    number="${number#"${number%%[!0]*}"}"
    [ -n "$number" ] || return 1

    remotes=$(git -C "$dir" remote 2>/dev/null) || return 1
    if grep -qxF origin <<< "$remotes"; then
        remote=origin
    else
        remote=$(head -n1 <<< "$remotes")
    fi
    [ -n "$remote" ] || return 1
    url=$(git -C "$dir" remote get-url "$remote" 2>/dev/null) || return 1

    local https_re='^https?://[^/]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    local scp_re='^git@[^:]+:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    local ssh_re='^ssh://([^@/]+@)?[^/:@]+(:[0-9]+)?/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$'
    [[ "$url" =~ $https_re || "$url" =~ $scp_re || "$url" =~ $ssh_re ]] || return 1
    printf '%s\n' "$number"
}
