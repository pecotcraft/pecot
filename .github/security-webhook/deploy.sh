#!/usr/bin/env bash
# security alert の webhook を受ける Lambda（#175）を、CloudFormation で作り、handler.mjs を載せる。
#
#   --profile <name>          AWS の SSO プロファイル。
#   --region <region>         既定は ap-northeast-1。
#   --installation-id <id>    組織への App の installation id。初回は必須。2 回目以降は省くと前回の値を使う。
#   --client-id <id>          App の Client ID。省くと変数 SECURITY_APP_CLIENT_ID を gh で読む。
#   --repository-id <id>      pecot の repository id。省くと gh api で読む。
#   --put-secrets <keyfile>   App の秘密鍵のファイルを SSM に書く。webhook の secret は標準入力から読む。
#   --rotate                  CONFIG_VERSION を上げ、温まった実行環境を入れ替える。
set -euo pipefail

STACK="pecot-security-webhook"
FUNCTION="pecot-security-webhook"
KEY_PARAM="/pecot/security-webhook/app-private-key"
SECRET_PARAM="/pecot/security-webhook/webhook-secret"
REGION="ap-northeast-1"
PROFILE=""
INSTALLATION_ID=""
CLIENT_ID=""
REPOSITORY_ID=""
KEY_FILE=""
ROTATE=false
SCRATCH=""

usage() {
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
        --profile | --region | --installation-id | --client-id | --repository-id | --put-secrets)
            [ $# -ge 2 ] || die "$1 には値が要ります"
            case "$1" in
                --profile) PROFILE="$2" ;;
                --region) REGION="$2" ;;
                --installation-id) INSTALLATION_ID="$2" ;;
                --client-id) CLIENT_ID="$2" ;;
                --repository-id) REPOSITORY_ID="$2" ;;
                --put-secrets) KEY_FILE="$2" ;;
            esac
            shift 2
            ;;
        --rotate)
            ROTATE=true
            shift
            ;;
        *) die "未対応の引数: $1 (--help で使用可能な引数を表示)" ;;
    esac
done

if [ -n "$INSTALLATION_ID" ] && ! [[ "$INSTALLATION_ID" =~ ^[0-9]+$ ]]; then
    die "--installation-id は数字だけです: $INSTALLATION_ID"
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

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# 1. SSM に鍵と secret を書く。secret は引数に出さず、一時ファイルの file:// で渡す。
if [ -n "$KEY_FILE" ]; then
    printf 'webhook の secret を入力してください（表示されません）: ' >&2
    IFS= read -rs WEBHOOK_SECRET
    echo >&2
    [ -n "$WEBHOOK_SECRET" ] || die "webhook の secret が空です"
    umask 077
    printf '%s' "$WEBHOOK_SECRET" >"$SCRATCH/secret"
    unset WEBHOOK_SECRET
    "${AWS[@]}" ssm put-parameter --name "$KEY_PARAM" --type SecureString --overwrite \
        --value "file://$KEY_FILE" >/dev/null
    "${AWS[@]}" ssm put-parameter --name "$SECRET_PARAM" --type SecureString --overwrite \
        --value "file://$SCRATCH/secret" >/dev/null
    echo "SSM に鍵と webhook の secret を書きました"
fi

# 2. スタックを作る・更新する。
OVERRIDES=()
if [ -z "$CLIENT_ID" ]; then
    CLIENT_ID="$(gh variable get SECURITY_APP_CLIENT_ID -R pecotcraft/pecot)"
fi
if [ -z "$REPOSITORY_ID" ]; then
    REPOSITORY_ID="$(gh api repos/pecotcraft/pecot --jq .id)"
fi
OVERRIDES+=("GitHubAppClientId=$CLIENT_ID" "GitHubRepositoryId=$REPOSITORY_ID")
if [ -n "$INSTALLATION_ID" ]; then
    OVERRIDES+=("GitHubAppInstallationId=$INSTALLATION_ID")
elif ! "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
    die "初回は --installation-id が要ります（org の Settings → GitHub Apps → Configure の URL の末尾の数字）"
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

# 4. 同時実行の予約。予約していない枠が 100 未満にならないときだけ置ける。
UNRESERVED="$("${AWS[@]}" lambda get-account-settings \
    --query 'AccountLimit.UnreservedConcurrentExecutions' --output text)"
if [ "$UNRESERVED" -ge 101 ]; then
    "${AWS[@]}" lambda put-function-concurrency --function-name "$FUNCTION" \
        --reserved-concurrent-executions 2 >/dev/null
    echo "同時実行の予約を 2 に置きました"
else
    echo "WARN: 予約していない同時実行の枠が ${UNRESERVED} で、予約を置けません。" >&2
    echo "上限が上がったら、このスクリプトを打ち直してください" >&2
fi

# 5. function URL を表示する。
URL="$("${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text)"
echo "function URL: $URL"
