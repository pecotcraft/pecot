#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 確認対象の root。失敗時の挙動を確かめる単体テストが fixture へ差し替えられるよう、source 後に代入し直せる。
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PECOTV_PLUGIN_ROOT="$REPO_ROOT/plugins/pecot-visual"

# pecotv への npm / yarn 混入と repo root への pnpm / yarn 混入を機械検知するガード (#806)。
# 方式: engines に不可能レンジ "<0.0.0" を宣言し .npmrc engine-strict=true で強制する。
# npm 11 は EBADENGINE、pnpm 10 は ERR_PNPM_UNSUPPORTED_ENGINE で止まる。
# yarn 1 は validate 段階で止まる。
# どれも fetch の前に即 fail するので、node_modules や lockfile を残さない（#802 の npm 残骸の再発防止）。
# pnpm 11 以降は .npmrc の engine-strict を読まず、engines では止まらない。
# そのため repo root は devEngines.packageManager に npm を宣言し、ERR_PNPM_OTHER_PM_EXPECTED で止める (#1217)。
#
# 役割分担:
#   静的確認 = 常に実行する恒久の確認。メンバーを足したときの宣言の書き忘れと、逆方向ガードの回帰を検知する。
#   挙動確認 = npm / yarn / pnpm が実在する場合だけ行う補強。不在のときは skip とログに書く。
# nx target `pecot-visual:check-pm-guard` から 1 push 1 回だけ実行する（test のレーンが dependsOn で参照する）。
#
# 挙動確認は隔離 install を最大 5 回起動するため、8〜26s かかる。
# ガードが守る対象は、package.json の engines、.npmrc の engine-strict、pnpm-workspace.yaml のメンバー、本スクリプト自体。
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

# 確認用の関数（read_engine / list_pm_invoking_scripts など）は、pecot-tools の install.sh と共有する。
# shellcheck source=pm-guard-lib.sh
. "$SCRIPT_DIR/pm-guard-lib.sh"

# ---- 静的確認 ----
# 走査対象は pnpm-workspace.yaml の packages リスト + pecotv root + repo root の明示列挙。
run_static_check() {
    FAIL_PHASE=STATIC
    echo "==> check-pm-guard: 静的確認 (engines / .npmrc / scripts)"

    local -a members
    mapfile -t members < <(list_workspace_members "$PECOTV_PLUGIN_ROOT/pnpm-workspace.yaml")
    if [ "${#members[@]}" -eq 0 ]; then
        fail "pnpm-workspace.yaml の packages ブロックからメンバーを取得できません（フォーマット変更の疑い）"
    fi

    # hoisted linker は bootstrap / テストの依存解決の前提（plugins/pecot-visual/node_modules 直下に並ぶ）。
    local linker
    linker="$(read_workspace_setting "$PECOTV_PLUGIN_ROOT/pnpm-workspace.yaml" nodeLinker)"
    [ "$linker" = "hoisted" ] || fail "nodeLinker: hoisted が無い: $PECOTV_PLUGIN_ROOT/pnpm-workspace.yaml"

    # pecotv 側: root + 全メンバーで engines.npm / engines.yarn = "<0.0.0" と engine-strict=true を assert。
    local rel dir pkg checked=0
    for rel in "." "${members[@]}"; do
        # 例外は libs/text-rules の 1 件だけ。repo 共通のライブラリをリンクで載せたメンバー。
        # aist-roadmap 向けに npm で build するので、npm を禁止できない。
        # scripts が package manager を呼ばないことの確認は、このメンバーにも掛けたままにする。
        [ "$rel" != "libs/text-rules" ] || continue
        [ "$rel" = "." ] || checked=$((checked + 1))
        dir="$PECOTV_PLUGIN_ROOT/$rel"
        pkg="$dir/package.json"
        if [ ! -f "$pkg" ]; then
            fail "pecotv メンバーの package.json が不在: $pkg"
            continue
        fi
        [ "$(read_engine "$pkg" npm)" = "<0.0.0" ] || fail "engines.npm != \"<0.0.0\": $pkg"
        [ "$(read_engine "$pkg" yarn)" = "<0.0.0" ] || fail "engines.yarn != \"<0.0.0\": $pkg"
        has_engine_strict "$dir" || fail "engine-strict=true が無い: $dir/.npmrc"
        local violation
        while IFS= read -r violation; do
            [ -n "$violation" ] && fail ".npmrc に pnpm 固有の設定がある（pnpm 11 以降は読まないため pnpm-workspace.yaml へ移す）: $dir/.npmrc の $violation"
        done < <(list_pnpm_only_npmrc_keys "$dir")
    done
    check_plugin_scripts_pm_free "$PECOTV_PLUGIN_ROOT" pecotv

    # repo root 側: 逆方向ガード（pnpm / yarn を block、npm は許可）。
    local root_pkg="$REPO_ROOT/package.json"
    [ "$(read_engine "$root_pkg" pnpm)" = "<0.0.0" ] || fail "engines.pnpm != \"<0.0.0\": $root_pkg"
    [ "$(read_engine "$root_pkg" yarn)" = "<0.0.0" ] || fail "engines.yarn != \"<0.0.0\": $root_pkg"
    # repo root は npm が主なので、engines.npm を宣言してはならない（宣言すると、npm の正常な使い方まで止まる）。
    [ -z "$(read_engine "$root_pkg" npm)" ] || fail "repo root は engines.npm を宣言してはいけない（npm の正常な使い方まで block してしまう）: $root_pkg"
    has_engine_strict "$REPO_ROOT" || fail "engine-strict=true が無い: $REPO_ROOT/.npmrc"
    [ "$(read_dev_engine_pm "$root_pkg")" = "npm:error" ] || fail "devEngines.packageManager が {name: npm, onFail: error} でない（pnpm 11 以降を止められない）: $root_pkg"

    if [ "$STATIC_FAIL" -ne 0 ]; then
        echo "check-pm-guard: 静的確認 FAILED ($STATIC_FAIL 件)" >&2
        return 1
    fi
    echo "  OK: pecotv root + ${checked} メンバー + repo root の engines / .npmrc と pecotv の scripts を確認。libs/text-rules は engines の確認の対象外"
}

# ---- 挙動確認 ----
# 該当する package.json と .npmrc を mktemp の隔離 dir へ複製して install を実行する。
# 非 0 終了で、node_modules と lockfile が無いことを assert する。
# 実ツリーで install を実行すると、node_modules は gitignore 済みなので残骸を検出できない。
# その結果 #802 が再発するため、必ず隔離 dir で行う。
# EBADENGINE / engines validate は fetch 前に発火するためネットワーク不要。
ISOLATED_DIRS=()
cleanup() {
    local d
    if [ "${#ISOLATED_DIRS[@]}" -gt 0 ]; then
        for d in "${ISOLATED_DIRS[@]}"; do
            rm -rf "$d"
        done
    fi
}

# 隔離 dir を作り、src の package.json と .npmrc を複製する。
# 生成したパスは、呼び出し元が参照できるよう $_ISOLATED_TMP に返す。
# $(...) 経由だと ISOLATED_DIRS への登録がサブシェルに閉じ、trap cleanup が掃除できない。
# そのため、代入で現在のシェルに反映する。
make_isolated() {
    local src="$1"
    _ISOLATED_TMP="$(mktemp -d)"
    ISOLATED_DIRS+=("$_ISOLATED_TMP")
    cp "$src/package.json" "$_ISOLATED_TMP/package.json"
    if [ -f "$src/.npmrc" ]; then
        cp "$src/.npmrc" "$_ISOLATED_TMP/.npmrc"
    fi
}

# 隔離 dir で install コマンドを実行し、非 0 終了 && 残骸不在を assert する。
# timeout があれば PM_GUARD_TIMEOUT 秒で打ち切る。
# rc=124（timeout）は「ガードが即時に発火していない疑い」として fail にする。EBADENGINE などなら 1 秒未満で返るはず。
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

run_behavior_check() {
    FAIL_PHASE=BEHAVIOR
    echo "==> check-pm-guard: 挙動確認 (隔離 install)"

    if command -v npm >/dev/null 2>&1; then
        assert_blocked "pecotv root × npm install" "$PECOTV_PLUGIN_ROOT" npm install
        assert_blocked "pecotv cli × npm install" "$PECOTV_PLUGIN_ROOT/cli" npm install
    else
        echo "  SKIP: npm 不在のため pecotv × npm の挙動確認を skip"
    fi

    if command -v yarn >/dev/null 2>&1; then
        # pecotv root の yarn は、packageManager=pnpm 固定（corepack 経由）でも block され得る。
        # そのため、この挙動確認の非 0 終了は engines.yarn="<0.0.0" の証明にならない。
        # engines.yarn 自体の確認は静的確認が受け持つ。この挙動確認は、残骸が無いことを補強にとどまる。
        assert_blocked "pecotv root × yarn install" "$PECOTV_PLUGIN_ROOT" yarn install
        assert_blocked "repo root × yarn install" "$REPO_ROOT" yarn install
    else
        echo "  SKIP: yarn 不在のため yarn の挙動確認を skip"
    fi

    if command -v pnpm >/dev/null 2>&1; then
        assert_blocked "repo root × pnpm install" "$REPO_ROOT" pnpm install
    else
        echo "  SKIP: pnpm 不在のため repo root × pnpm の挙動確認を skip"
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
