#!/usr/bin/env bash
# pecot-visual がリリースする依存ツリーを監査する (#1050 / #1071)。
#
# nx release の `release.groups.pecot-visual.version.groupPreVersionCommand` から起動される。
# 本コマンドが非ゼロで終了すると、nx は versioning を始める前に終了する。
# そのため high 以上の脆弱性がある場合や、監査結果が得られない場合は、
# version commit・タグ・push のどれも作られない。
#
# 監査するのは 2 ツリーで、どちらも利用者の環境へ入る依存であり、ビルド成果物には依存しない。
#   配布ツリー: publish と同じ関数（dist-manifest.mjs）が組む、配布 package.json の依存。
#   永続層:     setup ツールが置き場の mcp-dist/ へ入れる依存（runtime-manifest.mjs）。
#
#   --dist=<dir>       package.json と npm-shrinkwrap.json を持つ既存ディレクトリを、
#                      配布ツリーとして監査する。テスト用で、manifest 生成と依存解決は省く。
#   --runtime-dist=<dir>
#                      同じく永続層として監査するディレクトリ。テスト用。
#                      --dist との併用だけを許容する。
#                      片方だけ渡すと、もう一方は実レジストリで解決される。
#                      モックレジストリ下では、それが偽の pass として静かに通る。
#   --exceptions=<path>
#                      監査例外リスト。既定は <this-dir>/audit-exceptions.json。
#                      env PECOTV_AUDIT_EXCEPTIONS でも指定でき、両ツリーに同じ規則で適用する。
#   --registry=<url>   監査先レジストリ。既定は https://registry.npmjs.org/ で、
#                      env PECOTV_AUDIT_REGISTRY でも指定できる。npm へは常に --registry として渡す。
#   --timeout=<sec>    npm 呼び出し 1 回あたりの待ち上限。既定は 180 秒で、
#                      env PECOTV_AUDIT_TIMEOUT_SEC でも指定できる。
#                      呼び出しは最大 5 回で、内訳はカナリア監査、2 ツリーの依存解決、2 ツリーの監査となる。
#   --plans-dir=<dir>  version plan の探索先。既定は <repo>/.nx/version-plans。テスト用。
#   --audit-record=<path>
#                      監査記録の書き出し先。既定は <repo>/.nx/release-audit/pecotv-audit.json で、
#                      env PECOTV_AUDIT_RECORD でも指定できる。
#                      publish がこの記録を読み、監査した依存ツリーと配布ツリーの指紋を突合する (#1059)。
#
# 監査の前に、ブランドの語の一覧（env PECOT_BRAND_TERMS_FILE のファイル）の有無を確かめる。
# 無ければ監査も記録の作成もせず、非ゼロで止まる。
#
# 監査先は CLI の --registry で必ず明示する。~/.npmrc と npm_config_registry は、
# 監査先を無断で差し替えてしまう。
# `{}` を返す先に向くと、脆弱性 0 件の偽の pass になる。
# 加えて、その先が advisory を実装していない場合（bulk が常に `{}` を返す）も、
# 「脆弱性 0 件」と区別が付かない。
# そこで、既知の advisory を持つカナリア依存を 1 件だけ audit-canary/ に置き、
# 本監査の前に検出できることを確かめる。
#
# NX_DRY_RUN は意図的に参照しない。dry-run でも本実行と同一に、実レジストリへ依存解決と監査をかける。
# Acceptance #1050 が、dry-run の出力に監査結果を載せることを求めている。
# オフライン環境では dry-run も、監査未実施で止まる。
set -euo pipefail

# git hook (pre-push 等) から起動されると、git が GIT_DIR / GIT_INDEX_FILE を export する。
# その状態では `git -C <dir>` の -C が無視され、**呼び出し元リポの index** が書き換わる。
# 本スクリプトも git (rev-parse / tag) を呼び、npm も git 依存の解決で git を起動する。
# そのため、継承した git env は先頭で必ず捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PECOTV_ROOT="$REPO_ROOT/plugins/pecot-visual"

# 要約行とエラー文言に出すツリーの表示名。記録のセクション名（audit-record.mjs の
# FIELD.DIST / FIELD.RUNTIME）と 1 対 1 で対応する。
LABEL_DIST="配布ツリー"
LABEL_RUNTIME="永続層"

DIST=""
RUNTIME_DIST=""
REGISTRY="${PECOTV_AUDIT_REGISTRY:-https://registry.npmjs.org/}"
TIMEOUT_SEC="${PECOTV_AUDIT_TIMEOUT_SEC:-180}"
PLANS_DIR="$REPO_ROOT/.nx/version-plans"
AUDIT_RECORD="${PECOTV_AUDIT_RECORD:-$REPO_ROOT/.nx/release-audit/pecotv-audit.json}"

# 例外リストが無いときの扱いは、明示指定と既定パスで違う。
# 明示した先が無いのは指定ミスなので中止し、既定パスが無いのは「例外なし」として続行する。
# 例外なしは判定が厳しくなる方向のため、続行して構わない。
# PECOTV_AUDIT_EXCEPTIONS="" や --exceptions= の空文字指定は、「明示した」側として扱い中止する。
# REGISTRY / TIMEOUT_SEC の `${VAR:-既定値}` と違い、空文字を既定値へは倒さない。
# 例外は、判定を緩められる唯一の仕組みとなる。
# 空文字を「明示なし」と区別できないまま通すより、fail-closed に倒すことを意図して選んでいる。
EXCEPTIONS=""
EXCEPTIONS_EXPLICIT=false
if [ -n "${PECOTV_AUDIT_EXCEPTIONS+x}" ]; then
    EXCEPTIONS="$PECOTV_AUDIT_EXCEPTIONS"
    EXCEPTIONS_EXPLICIT=true
fi

for arg in "$@"; do
    case "$arg" in
        --dist=*) DIST="${arg#--dist=}" ;;
        --runtime-dist=*) RUNTIME_DIST="${arg#--runtime-dist=}" ;;
        --exceptions=*)
            EXCEPTIONS="${arg#--exceptions=}"
            EXCEPTIONS_EXPLICIT=true
            ;;
        --registry=*) REGISTRY="${arg#--registry=}" ;;
        --timeout=*) TIMEOUT_SEC="${arg#--timeout=}" ;;
        --plans-dir=*) PLANS_DIR="${arg#--plans-dir=}" ;;
        --audit-record=*) AUDIT_RECORD="${arg#--audit-record=}" ;;
        *)
            echo "ERROR: 未対応の引数: $arg" >&2
            echo "       使用可能: --dist=<dir>|--runtime-dist=<dir>|--exceptions=<path>|--registry=<url>" >&2
            echo "                 |--timeout=<sec>|--plans-dir=<dir>|--audit-record=<path>" >&2
            exit 1
            ;;
    esac
done

# --dist / --runtime-dist はテスト用の対を成すフラグ。片方だけ渡すと、もう一方は実
# レジストリへ 30 秒以上かけて依存を解決したうえ、モックレジストリが未知パッケージへ
# `{}` を返すため脆弱性 0 件で通る。失敗ではなく遅延として現れて気付けないので弾く。
if { [ -n "$DIST" ] && [ -z "$RUNTIME_DIST" ]; } || { [ -z "$DIST" ] && [ -n "$RUNTIME_DIST" ]; }; then
    echo "ERROR: --dist と --runtime-dist は両方指定するか両方省略してください" >&2
    exit 1
fi

if [ "$EXCEPTIONS_EXPLICIT" = false ]; then
    EXCEPTIONS="$SCRIPT_DIR/audit-exceptions.json"
    [ -f "$EXCEPTIONS" ] || EXCEPTIONS=""
elif [ ! -f "$EXCEPTIONS" ]; then
    echo "ERROR: 監査未実施のため中止: 指定された例外リストがありません: $EXCEPTIONS" >&2
    exit 1
fi

# 数字以外を case で弾いたうえで 0 も弾く。coreutils の timeout は duration 0 を
# 「上限なし」として扱うため、通すと env / 引数から待ち上限そのものを無効化できてしまう。
if case "$TIMEOUT_SEC" in '' | *[!0-9]*) true ;; *) [ "$TIMEOUT_SEC" -le 0 ] ;; esac; then
    echo "ERROR: --timeout は正の整数（秒）で指定してください: $TIMEOUT_SEC" >&2
    exit 1
fi

if ! command -v timeout > /dev/null 2>&1; then
    echo "ERROR: coreutils の timeout がありません。npm の接続待ちに上限を掛けられないため中止します。" >&2
    exit 1
fi

# 前回の記録は、処理の先頭で必ず消す。
# 監査が途中で中止したときに古い記録が残っていると、publish がそれを「今回の監査結果」として読んでしまう。
rm -f "$AUDIT_RECORD"

# ブランドの語の一覧が無いときは、監査を始める前に止める。
# 前回の記録を消した後に確かめるので、止まった後に古い記録が残らない。
# 一覧は本体の外にあり、環境変数 PECOT_BRAND_TERMS_FILE のファイルで渡す。
# リリースの version より前の監査で確かめるのは、一覧が無いまま version commit・タグ・push へ進ませないため。
# 配布ツリーの語の確認（publish-mcp-dist.sh）も、同じ一覧で行う。
if [ -z "${PECOT_BRAND_TERMS_FILE:-}" ] || [ ! -f "${PECOT_BRAND_TERMS_FILE:-}" ]; then
    echo "ERROR: ブランドの語の一覧が無いため中止: PECOT_BRAND_TERMS_FILE が未設定か、指す先がありません（現在: ${PECOT_BRAND_TERMS_FILE:-未設定}）。" >&2
    echo "       CLAUDE.md の「ブランドの語の確認」の節に従って、一覧ファイルの絶対パスを渡してください。" >&2
    exit 1
fi

PLUGIN_VERSION="$(node -e "process.stdout.write(require('$PECOTV_ROOT/.claude-plugin/plugin.json').version)")"
RELEASE_TAG="pecot-visual-v$PLUGIN_VERSION"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

# 監査記録を書き出す。スキーマのフィールド名・型・原子的な置換は、audit-record.mjs だけが定義する。
# publish-mcp-dist.sh の読み手も同じモジュールを使う。
#   write_audit_record skipped <head>
#
#   write_audit_record pass <head> <registry> <dist-summary.json> <runtime-summary.json>
write_audit_record() {
    node "$SCRIPT_DIR/audit-record.mjs" write "$AUDIT_RECORD" "$@"
}

# 結果が得られずに中止する処理。どちらのツリーで起きたかを、必ず文言に残す。
# 2 ツリーを同じ関数で監査するので、label が無いと見分けが付かない。
abort_unaudited() {
    echo "ERROR: 監査未実施のため中止: $1: $2" >&2
    exit 1
}

# HEAD が持つタグの一覧。env PECOTV_AUDIT_HEAD_TAGS が設定されていれば、その改行区切りの値を使う。
# テスト用で、リポジトリ本体に検証用タグを作らずに、再監査の処理を通すために置く。
head_tags() {
    if [ -n "${PECOTV_AUDIT_HEAD_TAGS+x}" ]; then
        printf '%s\n' "$PECOTV_AUDIT_HEAD_TAGS"
    else
        git -C "$REPO_ROOT" tag --points-at HEAD
    fi
}

# --- 1. 監査対象の判定 ---
# nx の release group フィルタは --groups と --projects だけを持つ。
# そのため pecot-workflow 単独のリリースでも、pecot-visual group の pre-version command は起動する。
# pecot-visual の bump 宣言が無いリリースでは配布物が更新されないので、監査せずに抜ける。
# frontmatter の bump 宣言の抽出は、.githooks/pre-push/check-version-plan-required.sh と同じ awk/sed 規則を使う。
# 宣言として扱うのは、値が妥当な semver ReleaseType になっている行だけとする。
#
# 失敗したときはスキップせず、中止する側に倒す。次の 2 つの場合は exit 1 で止める。
# 1 つ目は、探索先そのものが無い場合で、スクリプトの移設などで REPO_ROOT の解決がずれたときに起きる。
# 2 つ目は、pecot-visual を key とする行はあるのに、宣言として抽出できない場合で、
# たとえば `pecot-visual: "patch"` のような引用値が当たる。
# どちらも、nx は実在の plan で bump するのに、監査だけが気付かれずに抜ける状態を生む。
if [ ! -d "$PLANS_DIR" ]; then
    echo "ERROR: 監査未実施のため中止: version plan の探索先がありません: $PLANS_DIR" >&2
    exit 1
fi

# pecot-visual のリリースとみなす group は、pecot-visual 自身と、pecot-visual が依存する project の group。
# text-rules の group は updateDependents: always を持つ。
# そのため、text-rules だけの plan でも、nx は依存元の pecot-visual を上げる。
# 判定を pecot-visual: の有無だけにすると、pecot-visual のリリースなのに監査を飛ばしてしまう。
# 依存する project は、release-groups.mjs が pecot-visual の workspace: 依存から求める。
RELEASE_GROUPS_OUTPUT="$(node "$SCRIPT_DIR/release-groups.mjs" "$REPO_ROOT")" || {
    echo "ERROR: 監査未実施のため中止: release group を解決できません" >&2
    exit 1
}
mapfile -t RELEASE_GROUPS <<< "$RELEASE_GROUPS_OUTPUT"
# 空の group 名は、grep -qxF "" が空行に一致して、宣言なしの plan を宣言ありと誤判定させる。
# 空の要素を含むなら、監査を始めずに止める。出力が空のときも、mapfile は空の要素を 1 つ作るのでここで止まる。
for group in "${RELEASE_GROUPS[@]}"; do
    if [ -z "$group" ]; then
        echo "ERROR: 監査未実施のため中止: release group に空の名前が含まれています" >&2
        exit 1
    fi
done

# 0=宣言あり / 1=対象 group の行なし（スキップ）/ 2=対象 group の行はあるが宣言として解釈できない
UNPARSABLE_PLAN=""
pecot_visual_plan_declared() {
    local plan front keys group rc=1
    for plan in "$PLANS_DIR"/*.md; do
        [ -f "$plan" ] || continue
        front="$(awk 'BEGIN{c=0} /^---[[:space:]]*$/{c++; next} c==1{print}' "$plan")"
        # キーは、引用符なし・二重引用符・単一引用符の 3 通りを宣言として読む。
        # YAML では "pecot-visual": patch も pecot-visual: patch と同じキーで、nx もそう読んで bump する。
        keys="$(printf '%s\n' "$front" \
            | sed -n \
                -e 's/^\([A-Za-z0-9_][A-Za-z0-9_-]*\)[[:space:]]*:[[:space:]]*\(major\|premajor\|minor\|preminor\|patch\|prepatch\|prerelease\)[[:space:]]*$/\1/p' \
                -e 's/^"\([A-Za-z0-9_][A-Za-z0-9_-]*\)"[[:space:]]*:[[:space:]]*\(major\|premajor\|minor\|preminor\|patch\|prepatch\|prerelease\)[[:space:]]*$/\1/p' \
                -e "s/^'\\([A-Za-z0-9_][A-Za-z0-9_-]*\\)'[[:space:]]*:[[:space:]]*\\(major\\|premajor\\|minor\\|preminor\\|patch\\|prepatch\\|prerelease\\)[[:space:]]*\$/\\1/p")"
        for group in "${RELEASE_GROUPS[@]}"; do
            if printf '%s\n' "$keys" | grep -qxF "$group"; then
                return 0
            fi
            if printf '%s\n' "$front" | grep -qE "^[\"']?${group}[\"']?[[:space:]]*:"; then
                UNPARSABLE_PLAN="$plan"
                rc=2
            fi
        done
    done
    return "$rc"
}

PLAN_RC=0
pecot_visual_plan_declared || PLAN_RC=$?
case "$PLAN_RC" in
    0) ;;
    2)
        echo "ERROR: 監査未実施のため中止: version plan の pecot-visual 関連の宣言を解釈できません: $UNPARSABLE_PLAN" >&2
        exit 1
        ;;
    *)
        # version plan が無くても、HEAD にリリースタグがあれば再監査として実行する。
        # publish が指紋の不一致で止まった後に、release commit を checkout して記録を作り直す場合が対象になる。
        # plan は release commit で消費済みなので、この場合は存在しない。
        if printf '%s\n' "$(head_tags)" | grep -Fxq "$RELEASE_TAG"; then
            echo "==> 再監査: HEAD に $RELEASE_TAG があるため監査する"
        else
            echo "==> スキップ: pecot-visual の version plan が無いため pecot-visual のリリースではありません"
            write_audit_record skipped "$HEAD_SHA"
            exit 0
        fi
        ;;
esac

# --- 2. 作業ディレクトリと監査専用 npm キャッシュ ---
CLEANUP_DIRS=()
# set -e 下の EXIT trap は、最後に実行したコマンドの非ゼロがそのまま終了コードになる。
# 元の rc を退避して明示 exit する（空配列時の判定失敗で成功実行が失敗扱いになるのを防ぐ）。
# trap EXIT から間接的に呼ばれる。
# shellcheck disable=SC2329
cleanup() {
    local rc=$?
    if [ "${#CLEANUP_DIRS[@]}" -gt 0 ]; then
        rm -rf "${CLEANUP_DIRS[@]}"
    fi
    exit "$rc"
}
trap cleanup EXIT

WORK="$(mktemp -d)"
CLEANUP_DIRS+=("$WORK")

# npm audit は advisory の評価結果を、cacache へ `security-advisory:<name>:<id>` で保存する。
# このキーに severity は含まれない。
# 共有キャッシュ (~/.npm/_cacache) を使うと、古い評価を返すことがある。
# 実在の advisory を moderate から high へ再評価し、vulnerable_versions は変えない場合が当たる。
# その結果、high 以上を止める判定が働かなくなる。
# そこで install・カナリア監査・本監査のすべてを使い捨てキャッシュに閉じ、EXIT trap の rm -rf で破棄する。
#
# 設定は環境変数ではなく、npm の CLI フラグで渡す。
# npm は npm_config_* を大文字小文字の区別なく読む。
# 環境に NPM_CONFIG_OFFLINE 等があると、後から列挙した側を採用することがある。
# CLI フラグは常に環境変数より優先される。
# リリース系 test の永続キャッシュ opt-in (#1225) や、呼び出し元の offline=true を、監査へ及ぼさない。
# advisory の取得は本質的にオンラインで、キャッシュ済みの古い評価が返ると、監査が働かなくなる。
# 依存解決（resolve_tree）も同じ使い捨てキャッシュを使い、常にレジストリへアクセスする。
NPM_FLAGS=(--cache="$WORK/npm-cache" --offline=false --prefer-offline=false)

# --- 3. カナリア監査（監査先が advisory を実装していることの確認）---
# bulk エンドポイントが 200 と `{}` を返すレジストリでは「脆弱性 0 件」と区別が付かない。
# 既知の advisory を 1 件だけ持つツリーを先に監査し、検出できなければ監査未実施として止める。
# 監査対象の 2 ツリーとは別ツリーなので、この結果は要約行には含めない。
CANARY_PKG="minimist"
CANARY="$WORK/canary"
# audit-canary/ は git 管理下の読み取り専用ソース。npm が書き込むため WORK へ複製して使う。
cp -R "$SCRIPT_DIR/audit-canary" "$CANARY"

echo "==> 監査先の advisory 応答を確認 (canary $CANARY_PKG)"
CANARY_RC=0
(cd "$CANARY" && timeout "$TIMEOUT_SEC" npm audit --json --package-lock-only \
    --audit-level=none --fetch-retries=0 --registry="$REGISTRY" "${NPM_FLAGS[@]}") \
    > "$WORK/canary.json" 2> "$WORK/canary.err" || CANARY_RC=$?

if [ "$CANARY_RC" -eq 124 ]; then
    echo "ERROR: 監査未実施のため中止: カナリア監査: ${TIMEOUT_SEC} 秒以内に応答なし" >&2
    exit 1
fi

# npm audit --json の解釈は audit-summary.mjs に集約する（jq を前提にせず、監査が
# 成立したかの判定を本監査と 1 つのコードで共有する）。出力は status / message の 2 行。
# 1 フィールド 1 行で受ける。タブ区切りの read はタブが IFS whitespace のため連続タブが
# 1 個の区切りに畳まれ、空フィールドがあると値が 1 つずれる（mapfile は IFS を使わない）。
mapfile -t CANARY_FIELDS < <(node "$SCRIPT_DIR/audit-summary.mjs" \
    --audit="$WORK/canary.json" --canary="$CANARY_PKG")
CANARY_STATUS="${CANARY_FIELDS[0]:-}"
CANARY_MSG="${CANARY_FIELDS[1]:-}"

case "$CANARY_STATUS" in
    FOUND) ;;
    MISSING)
        echo "ERROR: 監査未実施のため中止: 監査先 ${REGISTRY} が既知の advisory を返しません（advisory 未提供のレジストリ）" >&2
        exit 1
        ;;
    *)
        if [ -z "$CANARY_MSG" ]; then
            CANARY_MSG="$(tail -3 "$WORK/canary.err" | tr '\n' ' ')" || true
        fi
        echo "ERROR: 監査未実施のため中止: $CANARY_MSG" >&2
        exit 1
        ;;
esac
if [ "$CANARY_RC" -ne 0 ]; then
    CANARY_ERR_TAIL="$(tail -3 "$WORK/canary.err" | tr '\n' ' ')"
    echo "ERROR: 監査未実施のため中止: カナリア監査が rc=$CANARY_RC で終了しました ($CANARY_ERR_TAIL)" >&2
    exit 1
fi

# --- 4. ツリー 1 本分の依存解決と監査 ---
# 依存を解決する。レジストリは publish / setup と同じ npm 既定設定のままにする。
# 差し替えるのは監査エンドポイントだけにとどめ、解決結果を配布や実 install と揃える。
resolve_tree() {
    local label="$1" dir="$2" slug="$3" rc=0
    echo "==> ${label}の依存を解決 (npm install --package-lock-only)"
    (cd "$dir" && timeout "$TIMEOUT_SEC" npm install --package-lock-only --ignore-scripts --no-audit --no-fund \
        "${NPM_FLAGS[@]}") \
        > "$WORK/$slug-install.log" 2>&1 || rc=$?
    if [ "$rc" -eq 124 ]; then
        abort_unaudited "$label" "${TIMEOUT_SEC} 秒以内に応答なし"
    fi
    if [ "$rc" -ne 0 ]; then
        echo "ERROR: 監査未実施のため中止: ${label}: 依存解決に失敗しました (npm install rc=$rc)" >&2
        tail -20 "$WORK/$slug-install.log" >&2
        exit 1
    fi
    if [ ! -f "$dir/package-lock.json" ]; then
        abort_unaudited "$label" "依存解決後に package-lock.json がありません"
    fi
    mv "$dir/package-lock.json" "$dir/npm-shrinkwrap.json"
}

# ツリーを監査する。結果は TREE_* へ返し、呼び出した直後にツリーごとの変数へ写す。
# 監査が未実施になる場合は、その場で中止する。対象は timeout・不達・UNAVAILABLE・例外リストの不正になる。
# もう一方のツリーへ進んでも得られる情報は増えず、待ち上限をもう 1 回分消費するだけになる。
# 脆弱性の判定は、両ツリーが揃ってから呼び出し側で行う。
TREE_SUMMARY_LINE=""
TREE_SUMMARY_JSON=""
TREE_EXCEPTED_FILE=""
TREE_BLOCKING_FILE=""
TREE_BLOCKING=""
audit_tree() {
    local label="$1" dir="$2" slug="$3" rc=0 lockfile fp status message AUDIT_ERR_TAIL
    local fields=()

    lockfile="$dir/npm-shrinkwrap.json"
    [ -f "$lockfile" ] || lockfile="$dir/package-lock.json"
    if [ ! -f "$lockfile" ]; then
        abort_unaudited "$label" "$dir に npm-shrinkwrap.json / package-lock.json がありません"
    fi
    # 指紋は、ルート "" の version を除いた packages から取る（dist-fingerprint.mjs）。
    # publish は bump 後の版で同じ manifest を解決し直す。
    # そのため、ファイル全体の sha256 は、依存が同一でも必ず食い違う。
    fp="$(node "$SCRIPT_DIR/dist-fingerprint.mjs" "$lockfile")"

    echo "==> ${label}の依存を監査 (registry $REGISTRY)"
    # --audit-level=none を付けると、「脆弱性あり」による非ゼロ終了が出なくなる。
    # 残る非ゼロはレジストリの不達などの監査失敗だけになり、rc で「未実施」と「監査完了」を見分けられる。
    (cd "$dir" && timeout "$TIMEOUT_SEC" npm audit --json --package-lock-only \
        --audit-level=none --fetch-retries=0 --registry="$REGISTRY" "${NPM_FLAGS[@]}") \
        > "$WORK/$slug-audit.json" 2> "$WORK/$slug-audit.err" || rc=$?

    if [ "$rc" -eq 124 ]; then
        abort_unaudited "$label" "${TIMEOUT_SEC} 秒以内に応答なし"
    fi

    # 集計・例外の適用・出力の生成は、audit-summary.mjs に委ねる。
    # シェルは JSON を解釈せず、1 フィールド 1 行の stdout と、生成されたファイルだけを扱う。
    # 1 フィールド 1 行にする理由は、CANARY_FIELDS と同じとなる。
    mapfile -t fields < <(node "$SCRIPT_DIR/audit-summary.mjs" \
        --audit="$WORK/$slug-audit.json" --exceptions="$EXCEPTIONS" --label="$label" \
        --fingerprint="$fp" --out="$WORK/$slug-summary.json" \
        --excepted-out="$WORK/$slug-excepted.txt" --blocking-out="$WORK/$slug-blocking.txt")

    status="${fields[0]:-}"
    message="${fields[1]:-}"
    if [ "$status" != "OK" ]; then
        # npm が JSON に理由を書かなかった場合は stderr の末尾を添える。
        if [ -z "$message" ]; then
            message="$(tail -3 "$WORK/$slug-audit.err" | tr '\n' ' ')" || true
        fi
        abort_unaudited "$label" "$message"
    fi
    if [ "$rc" -ne 0 ]; then
        AUDIT_ERR_TAIL="$(tail -3 "$WORK/$slug-audit.err" | tr '\n' ' ')"
        abort_unaudited "$label" "npm audit が rc=$rc で終了しました ($AUDIT_ERR_TAIL)"
    fi

    TREE_SUMMARY_LINE="${label}: ${fields[2]} パッケージ"
    TREE_SUMMARY_LINE+=" / critical ${fields[3]} / high ${fields[4]} / moderate ${fields[5]} / low ${fields[6]}"
    TREE_SUMMARY_LINE+=" / info ${fields[7]} / 例外 ${fields[8]} 件 / 指紋 ${fp}"
    TREE_SUMMARY_JSON="$WORK/$slug-summary.json"
    TREE_EXCEPTED_FILE="$WORK/$slug-excepted.txt"
    TREE_BLOCKING_FILE="$WORK/$slug-blocking.txt"
    TREE_BLOCKING="${fields[9]}"
}

# --- 5. 配布ツリーの監査 ---
if [ -n "$DIST" ]; then
    if [ ! -f "$DIST/package.json" ]; then
        echo "ERROR: --dist に package.json がありません: $DIST" >&2
        exit 1
    fi
else
    DIST="$WORK/dist"
    mkdir -p "$DIST"
    # 配布 package.json は publish と同じ関数で組む。これで依存集合が publish とずれない。
    node "$SCRIPT_DIR/dist-manifest.mjs" "$PECOTV_ROOT" "$PLUGIN_VERSION" "$REPO_ROOT" > "$DIST/package.json"
    resolve_tree "$LABEL_DIST" "$DIST" dist
fi

audit_tree "$LABEL_DIST" "$DIST" dist
DIST_SUMMARY_LINE="$TREE_SUMMARY_LINE"
DIST_SUMMARY_JSON="$TREE_SUMMARY_JSON"
DIST_EXCEPTED_FILE="$TREE_EXCEPTED_FILE"
DIST_BLOCKING_FILE="$TREE_BLOCKING_FILE"
DIST_BLOCKING="$TREE_BLOCKING"

# --- 6. 永続層の監査 ---
# setup ツールが置き場の mcp-dist/ へ入れるのと同じ依存集合を監査する。
# 実 install は --no-package-lock で毎回解決し直す。ここで得る shrinkwrap は、監査した時点の解決結果になる。
if [ -n "$RUNTIME_DIST" ]; then
    if [ ! -f "$RUNTIME_DIST/package.json" ]; then
        echo "ERROR: --runtime-dist に package.json がありません: $RUNTIME_DIST" >&2
        exit 1
    fi
else
    RUNTIME_DIST="$WORK/runtime"
    mkdir -p "$RUNTIME_DIST"
    node "$SCRIPT_DIR/runtime-manifest.mjs" "$PECOTV_ROOT" > "$RUNTIME_DIST/package.json"
    resolve_tree "$LABEL_RUNTIME" "$RUNTIME_DIST" runtime
fi

audit_tree "$LABEL_RUNTIME" "$RUNTIME_DIST" runtime
RUNTIME_SUMMARY_LINE="$TREE_SUMMARY_LINE"
RUNTIME_SUMMARY_JSON="$TREE_SUMMARY_JSON"
RUNTIME_EXCEPTED_FILE="$TREE_EXCEPTED_FILE"
RUNTIME_BLOCKING_FILE="$TREE_BLOCKING_FILE"
RUNTIME_BLOCKING="$TREE_BLOCKING"

# --- 7. 要約と判定 ---
# 要約は stdout と stderr の両方へ出す。
# nx は pre-version command の stdio を --verbose のときだけ inherit する。
# 失敗時は execSync の Error（stderr のみ）を出力する。
# これで、どちらの場合も監査条件がログへ残る。
# 配布ツリーの指紋は、publish が同じ値を再計算して突合する (#1059)。不一致なら配布しない。
# 永続層の指紋に突合相手は無く、何を監査したかの証跡として記録に残すだけになる。
SUMMARY_LINES="$DIST_SUMMARY_LINE
$RUNTIME_SUMMARY_LINE
registry $REGISTRY"
echo "$SUMMARY_LINES"
echo "$SUMMARY_LINES" >&2

# 例外は、high 以上の判定を免れさせる唯一の仕組みとなる。
# そのため件数だけでなく、免除した advisory もリリースログに残す。
for excepted_file in "$DIST_EXCEPTED_FILE" "$RUNTIME_EXCEPTED_FILE"; do
    if [ -s "$excepted_file" ]; then
        cat "$excepted_file"
        cat "$excepted_file" >&2
    fi
done

if [ $((DIST_BLOCKING + RUNTIME_BLOCKING)) -gt 0 ]; then
    if [ "$DIST_BLOCKING" -gt 0 ]; then
        echo "ERROR: ${LABEL_DIST}: high 以上の脆弱なパッケージ ${DIST_BLOCKING} 件" >&2
        cat "$DIST_BLOCKING_FILE" >&2
    fi
    if [ "$RUNTIME_BLOCKING" -gt 0 ]; then
        echo "ERROR: ${LABEL_RUNTIME}: high 以上の脆弱なパッケージ ${RUNTIME_BLOCKING} 件" >&2
        cat "$RUNTIME_BLOCKING_FILE" >&2
    fi
    exit 1
fi

# 記録は、監査が pass したときだけ書く。
# high 以上を検出して中止した場合と、監査が未実施で中止した場合は書かない。
# 記録は処理の先頭で消してあるので、どちらの場合も記録が無い状態になる。
write_audit_record pass "$HEAD_SHA" "$REGISTRY" "$DIST_SUMMARY_JSON" "$RUNTIME_SUMMARY_JSON"

echo "==> 監査 pass（high 以上なし）"
exit 0
