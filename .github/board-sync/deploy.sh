#!/usr/bin/env bash
# webhook と Scheduler を受ける Lambda（#175）を、CloudFormation で作り、handler.mjs を載せる。
#
#   --profile <name>                       AWS のプロファイル。省くと既定のプロファイルを使う。
#   --region <region>                      既定は ap-southeast-2。
#   --security-installation-id <id>        security の App の installation id。初回は必須。2 回目以降は省くと前回の値を使う。
#   --dependabot-prs-installation-id <id>  dependabot-prs の App の installation id。扱いは同上。
#   --security-client-id <id>              security の App の Client ID。省くと変数 SECURITY_APP_CLIENT_ID を gh で読む。
#   --dependabot-prs-client-id <id>        dependabot-prs の App の Client ID。省くと変数 DEPENDABOT_PRS_APP_CLIENT_ID を gh で読む。
#   --repository-id <id>                   pecot の repository id。省くと gh api で読む。
#   --put-secrets <security|dependabot-prs> <keyfile>
#                                          指定した App の秘密鍵のファイルを SSM に書く。webhook の secret は標準入力から読む。App ごとに 1 回ずつ打つ。
#   --rotate                               CONFIG_VERSION を上げ、温まった実行環境を入れ替える。
set -euo pipefail

STACK="pecot-board-sync"
FUNCTION="pecot-board-sync"
REPO="pecotcraft/pecot"
SSM_PREFIX="/pecot/board-sync"
RESERVED_CONCURRENCY=5
REGION="ap-southeast-2"
PROFILE=""
SECURITY_INSTALLATION_ID=""
DEPENDABOT_INSTALLATION_ID=""
SECURITY_CLIENT_ID=""
DEPENDABOT_CLIENT_ID=""
REPOSITORY_ID=""
PUT_APP=""
KEY_FILE=""
ROTATE=false
SCRATCH=""

usage() {
    sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        --profile | --region | --security-installation-id | --dependabot-prs-installation-id | --security-client-id | --dependabot-prs-client-id | --repository-id)
            { [ $# -ge 2 ] && [[ "$2" != --* ]]; } || die "$1 には値が要ります"
            case "$1" in
                --profile) PROFILE="$2" ;;
                --region) REGION="$2" ;;
                --security-installation-id) SECURITY_INSTALLATION_ID="$2" ;;
                --dependabot-prs-installation-id) DEPENDABOT_INSTALLATION_ID="$2" ;;
                --security-client-id) SECURITY_CLIENT_ID="$2" ;;
                --dependabot-prs-client-id) DEPENDABOT_CLIENT_ID="$2" ;;
                --repository-id) REPOSITORY_ID="$2" ;;
            esac
            shift 2
            ;;
        --put-secrets)
            { [ $# -ge 3 ] && [[ "$2" != --* ]] && [[ "$3" != --* ]]; } || die "--put-secrets には <security|dependabot-prs> と鍵のファイルが要ります"
            PUT_APP="$2"
            KEY_FILE="$3"
            shift 3
            ;;
        --rotate)
            ROTATE=true
            shift
            ;;
        *) die "未対応の引数: $1 (--help で使用可能な引数を表示)" ;;
    esac
done

for ID in "$SECURITY_INSTALLATION_ID" "$DEPENDABOT_INSTALLATION_ID"; do
    if [ -n "$ID" ] && ! [[ "$ID" =~ ^[0-9]+$ ]]; then
        die "installation id は数字だけです: $ID"
    fi
done
if [ -n "$PUT_APP" ]; then
    case "$PUT_APP" in
        security | dependabot-prs) ;;
        *) die "--put-secrets の App は security か dependabot-prs です: $PUT_APP" ;;
    esac
fi
if [ -n "$KEY_FILE" ] && [ ! -r "$KEY_FILE" ]; then
    die "--put-secrets の鍵のファイルを読めません: $KEY_FILE"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/handler.mjs" ] || die "handler.mjs がありません: $HERE"

AWS=(aws --region "$REGION")
if [ -n "$PROFILE" ]; then
    AWS+=(--profile "$PROFILE")
fi

# SSM へ書く前、gh の値とスタックの有無を済ませる。途中で止まっても、SSM だけが変わった状態を残さない。
if [ -z "$SECURITY_CLIENT_ID" ]; then
    SECURITY_CLIENT_ID="$(gh variable get SECURITY_APP_CLIENT_ID -R "$REPO")"
fi
if [ -z "$DEPENDABOT_CLIENT_ID" ]; then
    DEPENDABOT_CLIENT_ID="$(gh variable get DEPENDABOT_PRS_APP_CLIENT_ID -R "$REPO")"
fi
if [ -z "$REPOSITORY_ID" ]; then
    REPOSITORY_ID="$(gh api "repos/$REPO" --jq .id)"
fi
[ -n "$SECURITY_CLIENT_ID" ] || die "security の App の Client ID が空です（--security-client-id か変数 SECURITY_APP_CLIENT_ID）"
[ -n "$DEPENDABOT_CLIENT_ID" ] || die "dependabot-prs の App の Client ID が空です（--dependabot-prs-client-id か変数 DEPENDABOT_PRS_APP_CLIENT_ID）"
[ -n "$REPOSITORY_ID" ] || die "repository id が空です（--repository-id か gh api）"
if [ -z "$SECURITY_INSTALLATION_ID" ] || [ -z "$DEPENDABOT_INSTALLATION_ID" ]; then
    if ! "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
        die "初回は --security-installation-id と --dependabot-prs-installation-id が要ります（Configure の URL の末尾の数字）"
    fi
fi

umask 077
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# 1. SSM に指定した App の鍵と secret を書く。secret は引数に出さず、一時ファイルの file:// で渡す。
if [ -n "$KEY_FILE" ]; then
    printf 'webhook の secret を入力してください（表示されません）: ' >&2
    IFS= read -rs WEBHOOK_SECRET || die "webhook の secret を読めません"
    echo >&2
    [ -n "$WEBHOOK_SECRET" ] || die "webhook の secret が空です"
    printf '%s' "$WEBHOOK_SECRET" >"$SCRATCH/secret"
    unset WEBHOOK_SECRET
    KEY_PARAM="$SSM_PREFIX/$PUT_APP/app-private-key"
    SECRET_PARAM="$SSM_PREFIX/$PUT_APP/webhook-secret"
    "${AWS[@]}" ssm put-parameter --name "$KEY_PARAM" --type SecureString --overwrite \
        --value "file://$KEY_FILE" >/dev/null
    "${AWS[@]}" ssm put-parameter --name "$SECRET_PARAM" --type SecureString --overwrite \
        --value "file://$SCRATCH/secret" >/dev/null
    echo "SSM に $PUT_APP の鍵と webhook の secret を書きました"
fi

# 2. スタックを作る・更新する。
OVERRIDES=("SecurityAppClientId=$SECURITY_CLIENT_ID" "DependabotPrsAppClientId=$DEPENDABOT_CLIENT_ID" "GitHubRepositoryId=$REPOSITORY_ID")
if [ -n "$SECURITY_INSTALLATION_ID" ]; then
    OVERRIDES+=("SecurityAppInstallationId=$SECURITY_INSTALLATION_ID")
fi
if [ -n "$DEPENDABOT_INSTALLATION_ID" ]; then
    OVERRIDES+=("DependabotPrsAppInstallationId=$DEPENDABOT_INSTALLATION_ID")
fi
if [ "$ROTATE" = true ]; then
    OVERRIDES+=("ConfigVersion=$(date +%s)")
fi

"${AWS[@]}" cloudformation deploy \
    --stack-name "$STACK" \
    --template-file "$HERE/template.yaml" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides "${OVERRIDES[@]}"

# 3. handler.mjs だけを zip にして載せる。
(cd "$HERE" && zip -q -j "$SCRATCH/function.zip" handler.mjs)
"${AWS[@]}" lambda update-function-code --function-name "$FUNCTION" \
    --zip-file "fileb://$SCRATCH/function.zip" >/dev/null
"${AWS[@]}" lambda wait function-updated --function-name "$FUNCTION"
echo "handler.mjs を載せました"

# 4. 同時実行の予約。アカウントは予約していない枠を 100 以上残す必要がある。
UNRESERVED="$("${AWS[@]}" lambda get-account-settings \
    --query 'AccountLimit.UnreservedConcurrentExecutions' --output text)"
if ! [[ "$UNRESERVED" =~ ^[0-9]+$ ]]; then
    echo "WARN: 予約していない同時実行の枠を読めず（${UNRESERVED}）、予約を飛ばします。" >&2
elif [ "$UNRESERVED" -ge $((100 + RESERVED_CONCURRENCY)) ]; then
    "${AWS[@]}" lambda put-function-concurrency --function-name "$FUNCTION" \
        --reserved-concurrent-executions "$RESERVED_CONCURRENCY" >/dev/null
    echo "同時実行の予約を ${RESERVED_CONCURRENCY} に置きました"
else
    echo "WARN: 予約していない同時実行の枠が ${UNRESERVED} で、予約を置けません。" >&2
    echo "上限が上がったら、このスクリプトを打ち直してください" >&2
fi

# 5. 各 App の Webhook URL を表示する（function URL は末尾が /）。
URL="$("${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text)"
echo "security の App の Webhook URL: ${URL}security"
echo "dependabot-prs の App の Webhook URL: ${URL}dependabot-prs"
