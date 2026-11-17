#!/usr/bin/env bash
# 確かめで作ったもの（data-model.md の「確かめで作ったもの」）を、検証用のリポとボードから片付ける。
#
#   --issue <番号>  その Issue の番号を持つものだけを片付ける
#   --dry-run       片付けるものを出すだけで、書き換えない
#
# 終了コード: 0 片付けた・0 件 / 1 一部の片付けが失敗 / 2 引数の誤り・一覧を読めない
set -euo pipefail

REPO="pecotcraft/pecot-sandbox"
OWNER="pecotcraft"
PROJECT=3

NUM='[0-9]+'
DRY_RUN=false

die() {
    echo "error: $*" >&2
    exit 2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --issue)
            [ "$#" -ge 2 ] || die "--issue に番号がない"
            [[ "$2" =~ ^[0-9]+$ ]] || die "--issue は数字だけを受ける: $2"
            NUM="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        *) die "未対応の引数: $1 (使用可能: --issue <番号> | --dry-run)" ;;
    esac
done

# <乱数> は [0-9a-z]{4}。session start はブランチの後ろに /<Issue 番号> を付けるので、その形も拾う。
TITLE_RE="\\[cuj ${NUM}-[0-9a-z]{4}\\]"
BRANCH_RE="^refs/heads/cuj/${NUM}-[0-9a-z]{4}(/|$)"
TAG_RE="^cuj/${NUM}-[0-9a-z]{4}-tgz$"

# 一覧を読む。失敗したら、何も書き換えずに 2 で止める。
read_list() {
    local label="$1" out
    shift
    if ! out=$(gh "$@" 2>&1); then
        die "${label}を読めない: ${out##*$'\n'}"
    fi
    printf '%s' "$out"
}

refs_json=$(read_list "ブランチの一覧" api "repos/$REPO/git/matching-refs/heads/cuj/" --paginate)
issues_json=$(read_list "Issue・PR の一覧" api "repos/$REPO/issues?state=open&per_page=100" --paginate)
# shellcheck disable=SC2016 # $owner などは GraphQL の変数
query='query($owner: String!, $number: Int!, $endCursor: String) { organization(login: $owner) { projectV2(number: $number) { items(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { id isArchived content { __typename ... on Issue { number title repository { nameWithOwner } } ... on PullRequest { number title repository { nameWithOwner } } } } } } } }'
cards_json=$(read_list "ボードのカードの一覧" api graphql --paginate -f owner="$OWNER" -F number="$PROJECT" -f query="$query")
releases_json=$(read_list "リリースの一覧" api "repos/$REPO/releases?per_page=100" --paginate)

# 1 行 1 件、「<番号や id>\t<名前>」の形にする。
mapfile -t prs < <(jq -r --arg re "$TITLE_RE" \
    '.[] | select(.pull_request and (.title | test($re))) | "\(.number)\t\(.title)"' <<<"$issues_json")
mapfile -t branches < <(jq -r --arg re "$BRANCH_RE" \
    '.[] | select(.ref | test($re)) | .ref | sub("^refs/heads/"; "")' <<<"$refs_json")
mapfile -t issues < <(jq -r --arg re "$TITLE_RE" \
    '.[] | select((.pull_request | not) and (.title | test($re))) | "\(.number)\t\(.title)"' <<<"$issues_json")
mapfile -t cards < <(jq -r --arg re "$TITLE_RE" --arg repo "$REPO" \
    '.data.organization.projectV2.items.nodes[]
     | select((.isArchived | not) and .content.repository.nameWithOwner == $repo and (.content.title | test($re)))
     | "\(.id)\t#\(.content.number) \(.content.title)"' <<<"$cards_json")
mapfile -t releases < <(jq -r --arg re "$TAG_RE" \
    '.[] | select(.tag_name | test($re)) | .tag_name' <<<"$releases_json")

# 一覧の API は閉じた直後の Issue・PR を開いたまま返すことがあるので、1 件ずつ今の状態を見て、閉じたものを外す。
still_open() {
    local -n list="$1"
    local kept=() line out
    for line in "${list[@]}"; do
        if ! out=$(gh api "repos/$REPO/issues/${line%%$'\t'*}" 2>&1); then
            die "Issue・PR #${line%%$'\t'*} の状態を読めない: ${out##*$'\n'}"
        fi
        [ "$(jq -r '.state' <<<"$out")" = open ] && kept+=("$line")
    done
    list=("${kept[@]}")
}
still_open prs
still_open issues

total=$((${#prs[@]} + ${#branches[@]} + ${#issues[@]} + ${#cards[@]} + ${#releases[@]}))
if [ "$total" -eq 0 ]; then
    echo "片付けるものは 0 件"
    exit 0
fi

failed=0

# 1 件を片付ける。失敗しても残りを続ける。
sweep() {
    local label="$1" verb="$2" out
    shift 2
    if [ "$DRY_RUN" = true ]; then
        echo "$label"
        return
    fi
    if out=$(gh "$@" 2>&1); then
        echo "$label"
    else
        echo "error: $label を${verb}: ${out##*$'\n'}" >&2
        failed=1
    fi
}

# ブランチを先に消すと GitHub が PR を閉じ、後の gh pr close が失敗するので、PR を先に閉じる。
# --delete-branch は手元のブランチまで消すので付けない。
for line in "${prs[@]}"; do
    sweep "PR #${line%%$'\t'*} ${line#*$'\t'}" "閉じられない" pr close "${line%%$'\t'*}" -R "$REPO"
done
for name in "${branches[@]}"; do
    sweep "ブランチ $name" "消せない" api -X DELETE "repos/$REPO/git/refs/heads/$name"
done
for line in "${issues[@]}"; do
    sweep "Issue #${line%%$'\t'*} ${line#*$'\t'}" "閉じられない" issue close "${line%%$'\t'*}" -R "$REPO"
done
for line in "${cards[@]}"; do
    sweep "カード ${line#*$'\t'}" "アーカイブできない" project item-archive "$PROJECT" --owner "$OWNER" --id "${line%%$'\t'*}"
done
for tag in "${releases[@]}"; do
    sweep "リリース $tag" "消せない" release delete "$tag" --cleanup-tag --yes -R "$REPO"
done

if [ "$DRY_RUN" = true ]; then
    echo "--dry-run のため、${total} 件を書き換えていない"
fi
exit "$failed"
