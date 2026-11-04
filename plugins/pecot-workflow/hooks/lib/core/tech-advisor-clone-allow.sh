#!/bin/bash
# w-tech-advisor 定型 clone の自動許可判定。
#
# HOOK_COMMAND が、次のコマンドに厳密一致する場合のみ exit 10 を返す。
# 対象は「.pecot/work/<数字>/tech-advisor/<名前> を clone 先とする単一の git clone コマンド」。
# exit 10 は allow 判定で、stdout に理由を出す。
# それ以外は exit 0（判定なし。通常の許可フローに委ねる）。
# HOOK_COMMAND が未設定・空文字の場合は exit 2 + stderr（他コアガードと同一契約）。
#
# 呼び出し元（adapters）は、既存 deny ガードをすべて通過した後でだけ、本判定を呼ぶ。
# deny/ask が allow より常に優先される不変条件を維持するため。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config-dispatcher.sh"
pecot_hook_enabled "tech-advisor-clone-allow" true || exit 0

CMD="${HOOK_COMMAND:-}"
if [ -z "$CMD" ]; then
    echo "HOOK_COMMAND environment variable is required" >&2
    exit 2
fi

# 連結・展開・リダイレクト・パス遡上のいずれかを含むコマンドは対象外。
case "$CMD" in
    *';'* | *'&'* | *'|'* | *'$'* | *'`'* | *'>'* | *'<'* | *'..'*) exit 0 ;;
esac
case "$CMD" in
    *$'\n'*) exit 0 ;;
esac

# 許可 envelope は次のとおり。
#   git clone [--オプション]... <URL> <DEST>。
#
# オプションは、既知安全オプションの明示 allowlist のみ許容する。
# 未知オプションは allowlist 外になる。
# 危険オプションの例は、--upload-pack / --template / --separate-git-dir / --recurse-submodules 等。
# allowlist 外のコマンドは envelope 不一致となり、exit 0 へ進む。
# 許容するオプションは次の 4 種。
#   --depth=<数字> | --depth <数字>。
#   --branch=<値> | --branch <値>。
#   --filter=<値> | --filter <値>。
#   --single-branch / --no-tags / --quiet（値なしフラグ）。
#
# URL は https:// または git@ 形式のみ。
#
# DEST は次のいずれかの形のみ許容する（末尾 / 可）。
#   .pecot/work/<数字>/tech-advisor/<名前>（相対）。
#   ./.pecot/work/<数字>/tech-advisor/<名前>（./ 前置）。
#   <HOOK_WORKING_DIR>/.pecot/work/<数字>/tech-advisor/<名前>（プロジェクト内絶対パス）。
# HOOK_WORKING_DIR はプレフィックス文字列比較（quoted変数）で剥がしてから、残りを相対パス regex で検証する。
# 正規表現へパスを直接埋め込まない。
OPT_DEPTH='--depth(=[0-9]+|[[:space:]]+[0-9]+)'
OPT_BRANCH='--branch(=[A-Za-z0-9._/-]+|[[:space:]]+[A-Za-z0-9._/-]+)'
OPT_FILTER='--filter(=[A-Za-z0-9:._/-]+|[[:space:]]+[A-Za-z0-9:._/-]+)'
OPT_FLAG='--(single-branch|no-tags|quiet)'
OPT_ONE="(${OPT_DEPTH}|${OPT_BRANCH}|${OPT_FILTER}|${OPT_FLAG})"
OPT="(${OPT_ONE}[[:space:]]+)*"
URL='(https://[A-Za-z0-9._/:%-]+|git@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+)'
DEST_BODY='\.pecot/work/[0-9]+/tech-advisor/[A-Za-z0-9][A-Za-z0-9._-]*/?'

PREFIX_RE="^[[:space:]]*git[[:space:]]+clone[[:space:]]+${OPT}${URL}[[:space:]]+"
if [[ "$CMD" =~ $PREFIX_RE ]]; then
    dest_raw="${CMD:${#BASH_REMATCH[0]}}"

    rel_dest="$dest_raw"
    if [ -n "${HOOK_WORKING_DIR:-}" ] && [[ "$dest_raw" == "$HOOK_WORKING_DIR"/* ]]; then
        rel_dest="${dest_raw#"$HOOK_WORKING_DIR"/}"
    elif [[ "$dest_raw" == ./* ]]; then
        rel_dest="${dest_raw#./}"
    fi

    if [[ "$rel_dest" =~ ^${DEST_BODY}[[:space:]]*$ ]]; then
        echo ".pecot/work/<Issue番号>/tech-advisor/ 宛の定型 git clone のため自動許可（tech-advisor-clone-allow）"
        exit 10
    fi
fi

exit 0
