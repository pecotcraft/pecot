#!/usr/bin/env bash
# push 範囲のファイルに文章規則を適用する hook（#1280）。
#
# Hook stage: pre-push
#
# pre-commit が pre-push で渡すファイル一覧は remote_sha...local_sha の差分です。
# main を取り込んだブランチでは、この差分がブランチ外のファイルを含みます。
# そこで lib/push-range.sh の base/head 解決を使います。
# version plan ガードと同じ解決で、対象は merge-base(default, local)..local の変更だけです。
#
# 対象は、.pre-commit-config.yaml にある check-text の正規表現と同じ条件で絞ります。
# 条件は files と exclude の 2 つです。
# 作業ツリーに存在するファイルだけを渡します。
# 適用は check-text.sh に任せるため、dist と依存の確認もそちらが行う。
# 範囲を解決できないときは WARN を出して通します（version plan ガードと同じ方針）。

set -euo pipefail

# 次の 2 行は .pre-commit-config.yaml の check-text と一致させる（テストが固定する）
TEXT_FILES_RE='\.(md|ts|mts|cts|tsx|js|mjs|cjs|jsx|vue|py|pyi|json|jsonc|yaml|yml|toml|sh|bash)$'
TEXT_EXCLUDE_RE='(^|/)CHANGELOG\.md$|^plugins/pecot-workflow/cli-node/tests/(parity/golden|python-output)/|^\.specify/|^\.claude/skills/speckit-'

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=../lib/push-range.sh
source "$here/../lib/push-range.sh"

declare -a tips=()
while IFS= read -r tip; do
    [ -z "$tip" ] && continue
    tips+=("$tip")
done < <(collect_push_tips)

if [ "${#tips[@]}" -eq 0 ]; then
    echo "WARN: push 情報が無い（pre-commit の環境変数も pre-push の stdin も未取得）ため文章規則の適用を skip" >&2
    exit 0
fi

root=$(git rev-parse --show-toplevel)
declare -a targets=()

for tip in "${tips[@]}"; do
    rc=0
    range=$(resolve_push_range "$tip") || rc=$?
    case "$rc" in
        0) ;;
        10 | 14 | 16) continue ;;
        *)
            echo "WARN: push range 解決不能のため文章規則の適用を skip" >&2
            continue ;;
    esac
    from_sha="${range%% *}"
    to_sha="${range##* }"
    while IFS= read -r -d '' path; do
        [ -f "$root/$path" ] || continue
        printf '%s\n' "$path" | grep -Eq "$TEXT_FILES_RE" || continue
        if printf '%s\n' "$path" | grep -Eq "$TEXT_EXCLUDE_RE"; then
            continue
        fi
        targets+=("$path")
    done < <(git -C "$root" diff -z --name-only --diff-filter=ACMRTUXB --no-renames "${from_sha}..${to_sha}")
done

if [ "${#targets[@]}" -eq 0 ]; then
    exit 0
fi

cd "$root"
exec "$here/../pre-commit/check-text.sh" "${targets[@]}"
