# shellcheck shell=bash
# pre-push チェック共通の base/head 解決ロジック。
#
# version-plan ガード（check-version-plan-required.sh）が source して使う。
# affected テストのチェック（run-affected-tests.sh）も同様に source して使う。
# 両チェックが「同一の base/head 解決」を構造的に共有することを保証する共通 lib。
#
# 方針:
#   - この lib は `set` しない。source 元のオプションを尊重する。
#   - nounset 環境でも安全なように、参照は `${VAR:-}` を使う。
#   - source 元が `set -e` の場合、lib 内のコマンドの非 0 が source 元へ伝播してはならない。
#     そのため、失敗を区分コードで返す処理は否定条件の if でガードする。
#     裸の `cmd || ...` は && 連鎖で `set -e` 免除になる。
#     ただし可読性のため、if ガードを基本形とする。
#   - WARN / ERROR は出さず、exit もしない。
#     skip / fallback / fail の方針は、呼び出し側が区分コードを見て決める。
#     version-plan は判定不能なら skip + warn とする。
#     テストのチェックは判定不能なら run-many フォールバックとし、nx・node 不在のときだけ fail-closed とする。
#     この意図的な非対称を、呼び出し側に閉じ込めるための分担。
#   - source は呼び出し側の `$(dirname "${BASH_SOURCE[0]}")/../lib/push-range.sh` 基準で行う。
#     cwd には依存しない。
#
# 提供する関数:
#   resolve_base_branch              → base ref を stdout へ出す。解決不能で非 0。
#   resolve_nx <repo_root>           → nx 実行ファイルパスを stdout へ出す。不能で非 0。
#   needs_all_lanes <base>           → 全レーンのモードなら 0、通常なら 1 を return する。
#                                      env NO_PREV=true、または base が commit として読めないとき全レーン。
#   collect_push_tips                → push される local_sha を 1 行 1 件で stdout へ出す。
#                                      元は env PRE_COMMIT_TO_REF または pre-push stdin。
#   resolve_push_range <to_sha>      → "<from_sha> <to_sha>" を stdout へ出し、区分コードを return する。

PUSH_RANGE_ZERO_SHA="0000000000000000000000000000000000000000"

# merge-base 計算用 base ref を stdout へ。見つからなければ非 0。
#   1. env PECOT_VERSION_PLAN_BASE（既存 env 名を維持。両チェックで共有）
#   2. origin/HEAD が指す ref
resolve_base_branch() {
    if [ -n "${PECOT_VERSION_PLAN_BASE:-}" ]; then
        echo "$PECOT_VERSION_PLAN_BASE"
        return 0
    fi
    local default_ref
    default_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo "")
    if [ -n "$default_ref" ]; then
        echo "$default_ref"
        return 0
    fi
    return 1
}

# 全レーンのモードか（CI の一覧づくりとレーンの実行が同じ判定を共有する）。
needs_all_lanes() {
    [ "${NO_PREV:-}" = "true" ] || ! git cat-file -e "${1}^{commit}" 2> /dev/null
}

# nx 実行ファイルのパスを stdout へ。見つからなければ非 0。
# fail-open / fail-closed の判断はしない（呼び出し側が return 値で決める）。
resolve_nx() {
    local repo_root="$1"
    if [ -x "$repo_root/node_modules/.bin/nx" ]; then
        echo "$repo_root/node_modules/.bin/nx"
        return 0
    fi
    local p
    p=$(command -v nx 2>/dev/null || true)
    if [ -n "$p" ]; then
        echo "$p"
        return 0
    fi
    return 1
}

# push される評価対象の local_sha を 1 行 1 件で stdout へ。
#   (a) env PRE_COMMIT_TO_REF（pre-commit 経由）→ それ 1 件。
#   (b) pre-push stdin（<local_ref> <local_sha> <remote_ref> <remote_sha>）→ 各 local_sha。
# どちらも無い場合は何も出力しない（refs なしの pre-commit run など）。
# pre-commit は git の stdin を自分で読み、hook には渡さない。(b) は pre-commit を経ない起動のためにある。
# remote_sha は参照しない。
# FROM は呼び出し側が merge-base で算出する（既存挙動）。
# PRE_COMMIT_FROM_REF も参照しない。
# FROM は base との merge-base で算出するため、pre-commit が渡す FROM は使わない。
# tip の commit への peel は行わない。
# annotated tag の peel は、resolve_push_range の起点で行う。
# collect_push_tips は git push が渡す生の local_sha をそのまま列挙する。
collect_push_tips() {
    if [ -n "${PRE_COMMIT_TO_REF:-}" ]; then
        printf '%s\n' "$PRE_COMMIT_TO_REF"
        return 0
    fi
    if [ ! -t 0 ]; then
        local local_ref local_sha remote_ref remote_sha
        while read -r local_ref local_sha remote_ref remote_sha; do
            [ -z "${local_ref:-}" ] && continue
            printf '%s\n' "$local_sha"
        done
    fi
}

# push range を解決する。成功時は "<from_sha> <to_sha>" を stdout へ出し 0 を返す。
# 解決不能・skip 対象は区分コードで返す（WARN は出さない）。
#   0  : 範囲解決成功（"<from> <to>" を stdout へ出す）。
#   10 : ブランチ削除 push（to=ZERO_SHA）。skip する。
#   11 : base 解決失敗。fallback / fail は呼び出し側が決める。
#   12 : base ref が未解決（rev-parse 失敗）。fallback / fail する。
#   13 : merge-base 計算失敗。fallback / fail する。
#   14 : from==to（no-op または default の祖先）。skip する。
#   15 : from / to の commit がローカルで読めない。fallback / fail する。
#   16 : tip を commit object へ peel できない。skip する。
#        annotated tag 等の tip object が commit に解決できない push が該当する。
#        テストと version-plan の評価対象となる commit が存在しないため、ZERO_SHA と同様に skip する。
#
# 起点で tip を commit object へ peel する。
# annotated tag を単独 push すると、pre-push stdin の local_sha は tag object の SHA になる。
# それをそのまま nx affected の --head へ渡すと、nx は commit を期待して失敗する。
# そこで `git rev-parse <sha>^{commit}` で指す commit へ解決してから、range 計算に使う。
# lightweight tag や commit SHA は、peel しても同じ SHA を返すため無害。
resolve_push_range() {
    local raw_to="$1"

    if [ "$raw_to" = "$PUSH_RANGE_ZERO_SHA" ]; then
        return 10
    fi

    # tip object を commit へ peel（annotated tag → 指す commit）。
    local to_sha
    if ! to_sha=$(git rev-parse --verify --quiet "${raw_to}^{commit}" 2>/dev/null); then
        return 16
    fi

    local base
    if ! base=$(resolve_base_branch); then
        return 11
    fi
    if ! git rev-parse --verify --quiet "$base" > /dev/null; then
        return 12
    fi

    local from_sha
    from_sha=$(git merge-base "$base" "$to_sha" 2>/dev/null || echo "")
    if [ -z "$from_sha" ]; then
        return 13
    fi

    if [ "$from_sha" = "$to_sha" ]; then
        return 14
    fi

    if ! git cat-file -e "$from_sha" 2>/dev/null; then
        return 15
    fi
    if ! git cat-file -e "$to_sha" 2>/dev/null; then
        return 15
    fi

    printf '%s %s\n' "$from_sha" "$to_sha"
    return 0
}
