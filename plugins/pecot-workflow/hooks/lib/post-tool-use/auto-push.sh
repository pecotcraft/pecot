#!/bin/bash
# コミット成功後のWIPブランチへの自動push。
#
# 入力: PECOT_POST_COMMIT / PECOT_POST_REPO_DIR（bash-post-match.sh が成功した commit を判定して export）。
# stdin の JSON は読まない。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/branch-guard.sh"
source "${SCRIPT_DIR%/*}/core/git-repo-resolver.sh"
source "${SCRIPT_DIR%/*}/core/pecot-state-guard.sh"
pecot_hook_enabled "auto-push" false || exit 0

# WIPブランチをIssueのDevelopment欄にリンクする（ベストエフォート）。
# 呼び出し元で、HOST・WIP_BRANCH・ACTIVE_OWNER・ACTIVE_REPO・ACTIVE_NUMBER を定義しておく。
_link_wip_branch_to_issue() {
    local state_dir="${CLAUDE_PROJECT_DIR}/.pecot/state"
    local owner="$ACTIVE_OWNER" repo="$ACTIVE_REPO" number="$ACTIVE_NUMBER"

    # .wip-branch-linked フラグ確認（同一WIPブランチ名が記録済みならスキップ）。
    local linked_file="${state_dir}/.wip-branch-linked"
    if [ -f "$linked_file" ] && [ "$(cat "$linked_file")" = "$WIP_BRANCH" ]; then
        return 0
    fi

    # Issue Node ID, Repository Node ID, デフォルトブランチOIDを一括取得。
    local graphql_result
    graphql_result=$(GH_HOST="$HOST" gh api graphql -f query='
      query($owner:String!,$repo:String!,$number:Int!) {
        repository(owner:$owner,name:$repo) {
          id
          defaultBranchRef { target { oid } }
          issue(number:$number) { id }
        }
      }' -f owner="$owner" -f repo="$repo" -F number="$number" \
      --jq '.data.repository | .issue.id + " " + .id + " " + .defaultBranchRef.target.oid' 2>/dev/null) || return 0

    local issue_node_id repo_node_id oid
    issue_node_id=$(echo "$graphql_result" | awk '{print $1}')
    repo_node_id=$(echo "$graphql_result" | awk '{print $2}')
    oid=$(echo "$graphql_result" | awk '{print $3}')
    [ -n "$issue_node_id" ] && [ -n "$repo_node_id" ] && [ -n "$oid" ] || return 0

    # createLinkedBranch mutation
    local mutation_result
    mutation_result=$(GH_HOST="$HOST" gh api graphql -f query='
      mutation($issueId:ID!,$oid:GitObjectID!,$name:String!,$repoId:ID!) {
        createLinkedBranch(input:{issueId:$issueId,oid:$oid,name:$name,repositoryId:$repoId}) {
          linkedBranch { id }
        }
      }' -f issueId="$issue_node_id" -f oid="$oid" -f name="$WIP_BRANCH" -f repoId="$repo_node_id" \
      2>/dev/null) || return 0

    # エラーチェック: .errors が存在するか。
    local has_errors
    has_errors=$(echo "$mutation_result" | jq -r '.errors // empty' 2>/dev/null)

    if [ -z "$has_errors" ]; then
        # エラーなし（linkedBranch=null含む）: 成功扱い。
        pecot_state_dir_ensure "$(dirname "$linked_file")" || return 0
        printf '%s' "$WIP_BRANCH" > "$linked_file"
        return 0
    fi

    # "already exists" エラー: リトライ不要なのでフラグ書き込み。
    if echo "$mutation_result" | jq -e '.errors[]?.message' 2>/dev/null | grep -qi "already exists"; then
        pecot_state_dir_ensure "$(dirname "$linked_file")" || return 0
        printf '%s' "$WIP_BRANCH" > "$linked_file"
        return 0
    fi

    # その他のエラー: フラグ書かない → 次回コミットでリトライ。
}

# リモート URL を HOST / OWNER / REPO に分ける（cli/core/git_url.py と同じ 3 形式）。
# 読めなければ 1 を返す。https の userinfo は host から外す。
_parse_remote_url() {
    local url="$1"
    url="${url%/}"
    url="${url%.git}"
    local https_re='^https?://([^/]+)/([^/]+)/([^/]+)$'
    local scp_re='^git@([^:]+):([^/]+)/([^/]+)$'
    local ssh_re='^ssh://([^@/]+@)?([^/:@]+)(:[0-9]+)?/([^/]+)/([^/]+)$'
    if [[ "$url" =~ $https_re ]]; then
        HOST="${BASH_REMATCH[1]##*@}"
        OWNER="${BASH_REMATCH[2]}"
        REPO="${BASH_REMATCH[3]}"
    elif [[ "$url" =~ $scp_re ]]; then
        HOST="${BASH_REMATCH[1]}"
        OWNER="${BASH_REMATCH[2]}"
        REPO="${BASH_REMATCH[3]}"
    elif [[ "$url" =~ $ssh_re ]]; then
        HOST="${BASH_REMATCH[2]}"
        OWNER="${BASH_REMATCH[4]}"
        REPO="${BASH_REMATCH[5]}"
    else
        return 1
    fi
    [ -n "$HOST" ] && [ -n "$OWNER" ] && [ -n "$REPO" ]
}

# fetch で wip/ の追跡 ref が戻らないよう、除外の refspec を足す（ベストエフォート）。
# git 2.29 未満は除外の行で fetch が失敗し、正の refspec が無いと fetch が空になるため足さない。
_exclude_wip_refspec() {
    local major minor
    read -r major minor < <(_git version 2>/dev/null | sed -n 's/^git version \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')
    [ -n "$major" ] && [ -n "$minor" ] || return 0
    if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 29 ]; }; then
        return 0
    fi
    local fetches
    fetches=$(_git config --get-all remote.origin.fetch 2>/dev/null) || return 0
    ! grep -qxF '^refs/heads/wip/*' <<< "$fetches" || return 0
    grep -qE '^\+?refs/heads/' <<< "$fetches" || return 0
    _git config --add remote.origin.fetch '^refs/heads/wip/*' >/dev/null 2>&1 || true
}

# bash-post-match.sh が成功した git commit と判定し、対象リポジトリを解決済み
# （source 時に REPO_DIR が空になるため別名で受ける）。
REPO_DIR="${PECOT_POST_REPO_DIR:-}"

if [ "${PECOT_POST_COMMIT:-}" = "1" ]; then

    # featureブランチでなければスキップ。
    is_feature_branch "${REPO_DIR:-.}" || exit 0

    CURRENT_BRANCH=$(_git symbolic-ref --short HEAD 2>/dev/null)

    # active な Issue のブランチだけ対象にする（.pecot-active は、ここで 1 回だけ読む）。
    ACTIVE_CONTENT=$(cat "${CLAUDE_PROJECT_DIR}/.pecot/state/.pecot-active" 2>/dev/null)
    IFS='/' read -r ACTIVE_OWNER ACTIVE_REPO ACTIVE_NUMBER <<< "$ACTIVE_CONTENT"
    [ -n "$ACTIVE_OWNER" ] && [ -n "$ACTIVE_REPO" ] || exit 0
    [[ "$ACTIVE_NUMBER" =~ ^[0-9]+$ ]] || exit 0
    [[ "$CURRENT_BRANCH" =~ /([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" = "$ACTIVE_NUMBER" ] || exit 0

    # リモートURL解析（owner/repo が .pecot-active と一致しなければ対象外）。
    REMOTE_URL=$(_git remote get-url origin 2>/dev/null)
    _parse_remote_url "$REMOTE_URL" || exit 0
    OWNER_REPO="${OWNER}/${REPO}"
    [ "${OWNER_REPO,,}" = "${ACTIVE_OWNER,,}/${ACTIVE_REPO,,}" ] || exit 0

    # WIPブランチ名構築: wip/<current-branch>。
    WIP_BRANCH="wip/${CURRENT_BRANCH}"

    # WIPブランチをIssueのDevelopment欄にリンクする（push前に実行）。
    # createLinkedBranchはブランチ作成+リンクを行うため、push前に呼ぶ必要がある。
    # pushの--forceがその後にブランチ内容を上書きする。
    _link_wip_branch_to_issue

    # WIPブランチへ自動push。
    PUSH_OUTPUT=$(_git push --no-verify --force origin "HEAD:refs/heads/${WIP_BRANCH}" 2>&1)
    PUSH_EXIT=$?

    # push が作る wip/ の追跡 ref を消す（残ると pre-push の範囲が空になる）。成否に関係なく消す。
    _git for-each-ref --format='delete %(refname)' refs/remotes/origin/wip/ 2>/dev/null \
        | _git update-ref --stdin >/dev/null 2>&1 || true
    _exclude_wip_refspec

    # 結果に応じたフィードバック。
    if [ $PUSH_EXIT -eq 0 ]; then
        # 比較URL構築。
        BASE_BRANCH=$(GH_HOST="$HOST" gh api "repos/${OWNER_REPO}" --jq '.default_branch' 2>/dev/null)
        BASE_BRANCH="${BASE_BRANCH:-main}"
        COMPARE_URL="https://${HOST}/${OWNER_REPO}/compare/${BASE_BRANCH}...${WIP_BRANCH}"

        # Stop hookがsystemMessageでユーザーへ表示できるよう、フラグファイルへ追記する。
        if [ -n "$COMPARE_URL" ]; then
            AUTO_PUSH_FLAG="${CLAUDE_PROJECT_DIR}/.pecot/state/.auto-push-urls"
            # 関数外のため return 不可。pecot 未使用リポでは URL フラグを落とすだけ（gitignore-before-write #666）。
            if pecot_state_dir_ensure "$(dirname "$AUTO_PUSH_FLAG")"; then
                printf '%s\n' "自動push完了: ${WIP_BRANCH}" "比較: ${COMPARE_URL}" "" >> "$AUTO_PUSH_FLAG"
            fi
        fi
    else
        MESSAGE="【自動push失敗】${PUSH_OUTPUT}

理由: コミット完了後の自動pushが失敗しました。リモートとの通信エラー、
ブランチ保護ルール、認証問題等が考えられます。

対処方法:
  1. エラーメッセージからpush失敗の原因を特定してください
  2. 手動で git push origin HEAD を実行し、詳細なエラーを確認してください"
        jq -n --arg msg "$MESSAGE" '{
          "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": $msg
          }
        }'
    fi
fi
