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

# WIPブランチをIssueのDevelopment欄にリンクする（ベストエフォート）
# 呼び出し元で HOST, OWNER_REPO, WIP_BRANCH が定義済みであること
_link_wip_branch_to_issue() {
    local state_dir="${CLAUDE_PROJECT_DIR}/.pecot/state"
    local active_file="${state_dir}/.pecot-active"

    # .pecot-active がなければスキップ。
    [ -f "$active_file" ] || return 0

    # owner/repo/number をパース。
    local active_content
    active_content=$(cat "$active_file")
    local owner repo number
    IFS='/' read -r owner repo number <<< "$active_content"
    [ -n "$owner" ] && [ -n "$repo" ] && [ -n "$number" ] || return 0

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

# bash-post-match.sh が成功した git commit と判定し、対象リポジトリを解決済み
# （source 時に REPO_DIR が空になるため別名で受ける）。
REPO_DIR="${PECOT_POST_REPO_DIR:-}"

if [ "${PECOT_POST_COMMIT:-}" = "1" ]; then

    # featureブランチでなければスキップ。
    is_feature_branch "${REPO_DIR:-.}" || exit 0

    # WIPブランチ名構築: wip/<current-branch>。
    CURRENT_BRANCH=$(_git symbolic-ref --short HEAD 2>/dev/null)
    WIP_BRANCH="wip/${CURRENT_BRANCH}"

    # リモートURL解析（push前にHOSTが必要なためここで実行）。
    REMOTE_URL=$(_git remote get-url origin 2>/dev/null)
    if [ -n "$REMOTE_URL" ]; then
        if echo "$REMOTE_URL" | grep -q '^git@'; then
            HOST=$(echo "$REMOTE_URL" | sed 's/^git@\([^:]*\):.*/\1/')
            OWNER_REPO=$(echo "$REMOTE_URL" | sed 's/^git@[^:]*:\(.*\)$/\1/' | sed 's/\.git$//')
        elif echo "$REMOTE_URL" | grep -qE '^https?://'; then
            HOST=$(echo "$REMOTE_URL" | sed 's|^https\?://\([^/]*\)/.*|\1|')
            OWNER_REPO=$(echo "$REMOTE_URL" | sed 's|^https\?://[^/]*/\(.*\)$|\1|' | sed 's/\.git$//')
        fi
    fi

    # WIPブランチをIssueのDevelopment欄にリンクする（push前に実行）。
    # createLinkedBranchはブランチ作成+リンクを行うため、push前に呼ぶ必要がある。
    # pushの--forceがその後にブランチ内容を上書きする。
    if [ -n "$HOST" ] && [ -n "$OWNER_REPO" ]; then
        _link_wip_branch_to_issue
    fi

    # WIPブランチへ自動push。
    PUSH_OUTPUT=$(_git push --no-verify --force origin "HEAD:refs/heads/${WIP_BRANCH}" 2>&1)
    PUSH_EXIT=$?

    # 結果に応じたフィードバック。
    if [ $PUSH_EXIT -eq 0 ]; then
        # 比較URL構築。
        COMPARE_URL=""
        if [ -n "$HOST" ] && [ -n "$OWNER_REPO" ]; then
            BASE_BRANCH=$(GH_HOST="$HOST" gh api "repos/${OWNER_REPO}" --jq '.default_branch' 2>/dev/null)
            BASE_BRANCH="${BASE_BRANCH:-main}"
            COMPARE_URL="https://${HOST}/${OWNER_REPO}/compare/${BASE_BRANCH}...${WIP_BRANCH}"
        fi

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
