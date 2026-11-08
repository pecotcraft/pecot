# shellcheck shell=bash
# 文章規則の bin を起動できる状態かを確かめる共通 lib。
#
# check-text.sh と check-commit-text.sh が source して使う。
# ERROR 文を 1 か所に集め、2 つの hook で食い違わないようにする。
#
# 方針:
#   - この lib は `set` しない。source 元のオプションを尊重する。
#   - exit はしない。問題があれば ERROR を stderr へ出して 1 を return する。
#     呼び出し側は `|| exit 1` で止める。
#
# 提供する関数:
#   require_text_rules_ready <repo_root>
#       scripts/ready.mjs で dist と依存の状態を確かめる。
#       依存が欠けていれば、root で pnpm install --frozen-lockfile して確かめ直す (#1313)。
#       dist が無いか古ければ、build.mjs で作り直す (#1331)。
#       古いとは、ソースのハッシュが dist の stamp と違うことを指す。
#       戻せない・作れないときは、ERROR を出して 1 を return する。
#
# build はロックの中で ready を再確認してから行う。
# 複数の hook が同時に 30 を見ても、作り直すのは最初の 1 回だけにする。
# 後続が dist を消すと、先に進んだ hook の bin の起動と重なって落ちる。
# ロックは 120 秒だけ待つ。別プロセスの build が止まっても、無期限には待たない。
#
# ready.mjs の終了コード: 0 は起動できる、20 は dependencies が欠けている、30 は dist が無い・古い、
# 40 はソースか package.json を読めない。
# clone 直後は 20 のあとに 30 が続くため、依存、dist の順に直し、そのつど確かめ直す。
# pnpm と tsc の出力は stderr へ出す。stdout は文章規則の指摘のために空けておく。

require_text_rules_ready() {
    local repo_root="$1"
    local pkg="$repo_root/libs/text-rules"
    local rc

    if [ ! -f "$pkg/scripts/ready.mjs" ]; then
        echo "ERROR: libs/text-rules が無いため文章規則を適用できません。root で pnpm install --frozen-lockfile を実行してください" >&2
        return 1
    fi

    rc=0
    node "$pkg/scripts/ready.mjs" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
        return 0
    fi

    if [ "$rc" -eq 20 ]; then
        echo "==> libs/text-rules の依存が欠けているため、root で pnpm install --frozen-lockfile で戻します" >&2
        # pnpm が PATH に無くても corepack・npx で動くよう、探し方は .githooks/scripts/run-pnpm.sh に任せる。
        local runner
        runner="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)/run-pnpm.sh"
        if ! (cd "$repo_root" && "$runner" install --frozen-lockfile) >&2; then
            echo "ERROR: libs/text-rules の依存が欠けているため文章規則を適用できません。root の pnpm install --frozen-lockfile が失敗しました。上の出力を確認してください" >&2
            return 1
        fi
        rc=0
        node "$pkg/scripts/ready.mjs" >/dev/null 2>&1 || rc=$?
    fi

    if [ "$rc" -eq 30 ]; then
        echo "==> libs/text-rules のソースが dist と違うため、dist を作り直します" >&2
        local lock="$repo_root/.pecot/tmp/text-rules-build.lock"
        mkdir -p "$repo_root/.pecot/tmp"
        local build_rc=0
        if command -v flock >/dev/null 2>&1; then
            # ロックを取れた順に、中で ready を再確認する。先の 1 回が作り直していれば、以後は消さない。
            # shellcheck disable=SC2016  # bash -c へ渡す本文。展開は子 shell で行う
            flock -w 120 "$lock" bash -c 'node "$1" >/dev/null 2>&1 || node "$2"' _ \
                "$pkg/scripts/ready.mjs" "$pkg/scripts/build.mjs" >&2 || build_rc=$?
        else
            node "$pkg/scripts/build.mjs" >&2 || build_rc=$?
        fi
        if [ "$build_rc" -ne 0 ]; then
            echo "ERROR: libs/text-rules/dist を作れません。上の出力を確認してください" >&2
            return 1
        fi
        rc=0
        node "$pkg/scripts/ready.mjs" >/dev/null 2>&1 || rc=$?
    fi

    case "$rc" in
        0)
            return 0
            ;;
        20)
            echo "ERROR: libs/text-rules の依存が欠けているため文章規則を適用できません。root で pnpm install --frozen-lockfile を実行してください" >&2
            ;;
        30)
            echo "ERROR: libs/text-rules/dist が build 後もソースと一致しません。もう一度 commit してください" >&2
            ;;
        40)
            node "$pkg/scripts/ready.mjs" >/dev/null || true
            echo "ERROR: libs/text-rules のソースか package.json を読めません。上の出力を確認してください" >&2
            ;;
        *)
            node "$pkg/scripts/ready.mjs" >/dev/null || true
            echo "ERROR: ready.mjs を実行できません (node が無い等)。root で pnpm install --frozen-lockfile を実行してください" >&2
            ;;
    esac
    return 1
}
