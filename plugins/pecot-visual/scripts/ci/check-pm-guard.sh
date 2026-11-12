#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 確認対象の root。失敗時の挙動を確かめる単体テストが fixture へ差し替えられるよう、source 後に代入し直せる。
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck disable=SC2034  # 単体テストが fixture へ差し替える
PECOTV_PLUGIN_ROOT="$REPO_ROOT/plugins/pecot-visual"

# 違うパッケージマネージャの install を機械検知するガード (#806 / #52)。
# 方式: 各 package.json の devEngines.packageManager に使うものを宣言する。
#   宣言の形と置き場所は pm-guard-lib.sh の check_package_manager_declarations が確かめる。
# npm は、ローカルの package.json が別のパッケージマネージャを宣言していると、
# global でないコマンドを EBADDEVENGINES で止める。pnpm 11 以降は ERR_PNPM_OTHER_PM_EXPECTED で止める。
# yarn は corepack の shim が packageManager か devEngines を読んで止める。
# どれも fetch の前に即 fail するので、node_modules や lockfile を残さない（#802 の npm 残骸の再発防止）。
# ルートの .npmrc の engine-strict=true は、依存の engines.node を厳格に確かめる設定として残す。
#
# 役割分担:
#   静的確認 = 常に実行する恒久の確認。宣言の書き忘れ・置き場所の誤り・未分類の package.json を検知する。
#   挙動確認 = npm / yarn / pnpm が実在する場合だけ行う補強。不在のときは skip とログに書く。
# nx target `pecot-visual:check-pm-guard` から 1 push 1 回だけ実行する（test のレーンが dependsOn で参照する）。
#
# 挙動確認は隔離 install を十数回起動する。
# 対象は package.json の宣言、.npmrc、workspace のメンバー、本スクリプト自体。
# これらが push range で変わらない限り結果は変わらない。
# そのため pre-push フックが PECOTV_PM_GUARD_BEHAVIOR=0 を渡してきたときは、静的確認だけに絞る (#1080)。
# 未設定のとき（手動実行とフォールバック）は、従来どおり両方を実行する。安全側に倒した既定とする。

# 挙動確認の install に被せる timeout 秒数。ガードが即時に発火すれば 1 秒未満で返る。
# 万一ガードが働かずに hang した場合の上限になる。
# 失敗時の挙動を確かめる単体テストが小さい値に上書きできるよう、env にしてある。
PM_GUARD_TIMEOUT="${PM_GUARD_TIMEOUT:-120}"

# 静的 / 挙動の 2 フェーズで違反数を分離集計する。fail() は $FAIL_PHASE が指す
# カウンタ（STATIC_FAIL / BEHAVIOR_FAIL）を増やし、途中 exit せず最終サマリまで到達させる。
STATIC_FAIL=0
BEHAVIOR_FAIL=0
FAIL_PHASE=STATIC
fail() {
    echo "  NG: $1" >&2
    declare -n _counter="${FAIL_PHASE}_FAIL"
    _counter=$((_counter + 1))
}

# 確認用の関数は、pecot-tools・pecot-workflow の check-pm-scripts.sh と共有する。
# 例は check_package_manager_declarations と list_pm_invoking_scripts。
# shellcheck source=pm-guard-lib.sh
. "$SCRIPT_DIR/pm-guard-lib.sh"

# ---- 静的確認 ----
run_static_check() {
    FAIL_PHASE=STATIC
    echo "==> check-pm-guard: 静的確認 (devEngines / engines / .npmrc / scripts)"

    local -a members
    mapfile -t members < <(list_workspace_members "$REPO_ROOT/pnpm-workspace.yaml")
    if [ "${#members[@]}" -eq 0 ]; then
        fail "pnpm-workspace.yaml の packages ブロックからメンバーを取得できません（フォーマット変更の疑い）"
    fi

    local linker
    linker="$(read_workspace_setting "$REPO_ROOT/pnpm-workspace.yaml" nodeLinker)"
    [ "$linker" = "hoisted" ] || fail "nodeLinker: hoisted が無い: $REPO_ROOT/pnpm-workspace.yaml"

    # 全 package.json の宣言と、プラグインの下に .npmrc が無いこと。
    check_package_manager_declarations "$REPO_ROOT"
    # ルートの .npmrc は、依存の engines.node を厳格に確かめるために残している。
    grep -qx 'engine-strict=true' "$REPO_ROOT/.npmrc" 2>/dev/null || fail "engine-strict=true が無い: $REPO_ROOT/.npmrc"
    check_scripts_pm_free_under "$REPO_ROOT" pecotv plugins/pecot-visual libs/text-rules

    if [ "$STATIC_FAIL" -ne 0 ]; then
        echo "check-pm-guard: 静的確認 FAILED ($STATIC_FAIL 件)" >&2
        return 1
    fi
    local total
    total="$(list_package_jsons "$REPO_ROOT" | grep -c .)"
    echo "  OK: 全 package.json の宣言と .npmrc、pecotv の scripts を確認 (${total} 件)"
}

# ---- 挙動確認 ----
# 該当する package.json を mktemp の隔離 dir へ複製して install を実行する。
# 非 0 終了で、node_modules と lockfile が無いことを assert する。
# 実ツリーで install を実行すると、node_modules は gitignore 済みなので残骸を検出できない。
# その結果 #802 が再発するため、必ず隔離 dir で行う。
# EBADDEVENGINES / ERR_PNPM_OTHER_PM_EXPECTED は fetch 前に発火するためネットワーク不要。
ISOLATED_DIRS=()
cleanup() {
    local d
    if [ "${#ISOLATED_DIRS[@]}" -gt 0 ]; then
        for d in "${ISOLATED_DIRS[@]}"; do
            rm -rf "$d"
        done
    fi
}

# 隔離 dir を作り、src の package.json を複製する。
# 生成したパスは、呼び出し元が参照できるよう $_ISOLATED_TMP に返す。
# $(...) 経由だと ISOLATED_DIRS への登録がサブシェルに閉じ、trap cleanup が掃除できない。
# そのため、代入で現在のシェルに反映する。
make_isolated() {
    local src="$1"
    _ISOLATED_TMP="$(mktemp -d)"
    ISOLATED_DIRS+=("$_ISOLATED_TMP")
    cp "$src/package.json" "$_ISOLATED_TMP/package.json"
}

# 隔離 dir で install コマンドを実行し、非 0 終了 && 残骸不在を assert する。
# timeout があれば PM_GUARD_TIMEOUT 秒で打ち切る。
# rc=124（timeout）は「ガードが即時に発火していない疑い」として fail にする。EBADDEVENGINES などなら 1 秒未満で返るはず。
# timeout コマンド不在時は timeout 無しで実行する。
# $1=ラベル $2=隔離元 dir $3...=install コマンド
assert_blocked() {
    local label="$1" src="$2"
    shift 2
    local tmp rc local_fail=0
    make_isolated "$src"
    tmp="$_ISOLATED_TMP"
    set +e
    if command -v timeout >/dev/null 2>&1; then
        ( cd "$tmp" && timeout "$PM_GUARD_TIMEOUT" "$@" >/dev/null 2>&1 )
    else
        ( cd "$tmp" && "$@" >/dev/null 2>&1 )
    fi
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
        fail "$label: install が成功してしまった（ガード不発）"
        local_fail=1
    elif [ "$rc" -eq 124 ]; then
        fail "$label: ${PM_GUARD_TIMEOUT}s で timeout（ガードが即時発火していない疑い）"
        local_fail=1
    fi
    local residue
    for residue in node_modules package-lock.json yarn.lock pnpm-lock.yaml; do
        if [ -e "$tmp/$residue" ]; then
            fail "$label: 残骸 $residue が生成された"
            local_fail=1
        fi
    done
    if [ "$local_fail" -eq 0 ]; then
        echo "  OK: $label は非 0 終了・残骸なし (exit $rc)"
    fi
}

# npx がローカルの宣言で止まるかを、隔離 dir で確かめる。
# npm は、pnpm を宣言した package.json の下では npx も EBADDEVENGINES で止める。
# pnpm を宣言した dir の下（package.json の無い dir を含む）で npx を呼ぶ箇所は、cwd を / にして呼ぶ。
# $1=ラベル、$2=宣言を持つ dir（package.json の複製元）。
# $3=cwd にする dir（隔離 dir からの相対）、$4=cwd を / に替えるなら "root"。
# $4 が空なら止まること、root なら止まらないことを assert する。
assert_npx_declaration() {
    local label="$1" src="$2" sub="$3" mode="${4:-}" tmp err
    make_isolated "$src"
    tmp="$_ISOLATED_TMP"
    mkdir -p "$tmp/$sub"
    set +e
    if [ "$mode" = "root" ]; then
        err="$(cd / && npx --no-install pm-guard-probe-not-installed 2>&1 >/dev/null)"
    else
        err="$(cd "$tmp/$sub" && npx --no-install pm-guard-probe-not-installed 2>&1 >/dev/null)"
    fi
    set -e
    if [ "$mode" = "root" ]; then
        if [[ "$err" == *EBADDEVENGINES* ]]; then
            fail "$label: cwd を / にしても EBADDEVENGINES で止まった"
        else
            echo "  OK: $label は宣言で止まらない"
        fi
    elif [[ "$err" == *EBADDEVENGINES* ]]; then
        echo "  OK: $label は EBADDEVENGINES で止まる（cwd を / にする回避が要る理由）"
    else
        fail "$label: EBADDEVENGINES で止まらなかった（npx の呼び方の前提が変わった疑い）"
    fi
}

run_behavior_check() {
    FAIL_PHASE=BEHAVIOR
    echo "==> check-pm-guard: 挙動確認 (隔離 install)"

    local plugins_dir="$REPO_ROOT/plugins"
    if command -v npm >/dev/null 2>&1; then
        assert_blocked "repo root × npm install" "$REPO_ROOT" npm install
        assert_blocked "libs/text-rules × npm install" "$REPO_ROOT/libs/text-rules" npm install
        assert_blocked "pecot-visual root × npm install" "$plugins_dir/pecot-visual" npm install
        assert_blocked "pecot-visual cli × npm install" "$plugins_dir/pecot-visual/cli" npm install
        assert_blocked "pecot-tools root × npm install" "$plugins_dir/pecot-tools" npm install
        assert_blocked "pecot-tools cli × npm install" "$plugins_dir/pecot-tools/cli" npm install
        assert_blocked "pecot-workflow root × npm install" "$plugins_dir/pecot-workflow" npm install
        assert_blocked "pecot-workflow cli × npm install" "$plugins_dir/pecot-workflow/cli" npm install
        # package.json の無い dir（plugins/pecot-workflow/cli）は、上の plugins/pecot-workflow/package.json の宣言を受ける。
        assert_npx_declaration "pecot-workflow cli（package.json の無い dir）× npx" "$plugins_dir/pecot-workflow" cli
        assert_npx_declaration "pecot-workflow cli（cwd を /）× npx" "$plugins_dir/pecot-workflow" cli root
    else
        echo "  SKIP: npm 不在のため npm の挙動確認を skip"
    fi

    if command -v yarn >/dev/null 2>&1; then
        # pecot-visual root の yarn は、packageManager=pnpm 固定（corepack 経由）でも block され得る。
        # そのため、この挙動確認の非 0 終了は devEngines の証明にならない。
        # 宣言自体の確認は静的確認が受け持つ。この挙動確認は、残骸が無いことの補強にとどまる。
        assert_blocked "pecot-visual root × yarn install" "$plugins_dir/pecot-visual" yarn install
        assert_blocked "repo root × yarn install" "$REPO_ROOT" yarn install
    else
        echo "  SKIP: yarn 不在のため yarn の挙動確認を skip"
    fi

    if [ "$BEHAVIOR_FAIL" -ne 0 ]; then
        echo "check-pm-guard: 挙動確認 FAILED ($BEHAVIOR_FAIL 件)" >&2
        return 1
    fi
}

# source したとき（失敗時の挙動を確かめる単体テスト）は関数定義だけを読み込む。main の実行は直接起動したときだけ。
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
    return 0 2>/dev/null || true
fi

trap cleanup EXIT

overall=0
run_static_check || overall=1
if [ "${PECOTV_PM_GUARD_BEHAVIOR:-1}" = "0" ]; then
    echo "==> check-pm-guard: 隔離 install の確認は skip (PECOTV_PM_GUARD_BEHAVIOR=0)。push range に package.json / .npmrc / pnpm-workspace.yaml / check-pm-guard.sh の変更が無い"
else
    run_behavior_check || overall=1
fi
if [ "$overall" -ne 0 ]; then
    echo "check-pm-guard: FAILED (static=$STATIC_FAIL behavior=$BEHAVIOR_FAIL)" >&2
    exit 1
fi
echo "check-pm-guard: passed"
