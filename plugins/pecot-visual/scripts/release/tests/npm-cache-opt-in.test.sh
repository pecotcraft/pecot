#!/bin/bash
# npm の永続キャッシュ opt-in（PECOT_RELEASE_TEST_NPM_CACHE）の検証 (#1225)。
# publish / audit が npm に渡す CLI フラグを、npm スタブで記録して確かめる。
# publish は --dry-run --skip-build で動かすので、cli・eslint プラグイン・text-rules の dist が build 済みであることが前提。
# `set -e` は使わない。拒否の検証で、非ゼロ終了を意図的に発生させる。
set -u

# git hook から起動されたときの GIT_DIR 等で、被テストスクリプトの `git -C` が呼び出し元リポを巻き込まないよう捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
PECOTV_ROOT="$REPO_ROOT/plugins/pecot-visual"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"
AUDIT="$RELEASE_DIR/audit-mcp-dist.sh"
AUDIT_RECORD_JS="$RELEASE_DIR/audit-record.mjs"
FIXTURE="$SCRIPT_DIR/fixtures/audit"
FIXTURE_RUNTIME="$SCRIPT_DIR/fixtures/audit-runtime"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

for required in "$PECOTV_ROOT/cli/dist" "$REPO_ROOT/libs/text-rules/dist" \
    "$PECOTV_ROOT/assets/slidev/scripts/eslint/_shared/dist"; do
    if [ ! -d "$required" ]; then
        echo "ERROR: $required がありません。build 済みの dist が前提です。" >&2
        echo "  bash plugins/pecot-visual/scripts/ci/run-tests.sh --scope=release" >&2
        exit 1
    fi
done

TMP=$(mktemp -d)
cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

# 失敗の補足に使う。$TMP 配下のログの末尾 N 行を 1 行にまとめて返す。
log_tail() {
    tail -"$2" "$TMP/$1" | tr '\n' ' '
}

# npm スタブ。呼び出しごとに「<サブコマンド> cache=<> prefer_offline=<> offline=<> cwd=<>」を記録する。
# 値は CLI フラグから取り、無ければ unset と書く。
# audit は cwd が canary のときだけカナリアの advisory を返す。
mkdir -p "$TMP/bin"
cat > "$TMP/bin/npm" << 'STUB_NPM'
#!/bin/bash
cache=unset
prefer_offline=unset
offline=unset
for arg in "$@"; do
    case "$arg" in
        --cache=*) cache="${arg#--cache=}" ;;
        --prefer-offline) prefer_offline=true ;;
        --prefer-offline=*) prefer_offline="${arg#--prefer-offline=}" ;;
        --offline) offline=true ;;
        --offline=*) offline="${arg#--offline=}" ;;
    esac
done
printf '%s cache=%s prefer_offline=%s offline=%s cwd=%s\n' \
    "$1" "$cache" "$prefer_offline" "$offline" "$(basename "$PWD")" >> "$NPM_STUB_LOG"
case "$1" in
    pack)
        # publish は pack の JSON から tgz の名前と中身を取る。--pack-destination に空の tgz を置いて返す。
        dest=.
        prev=
        for arg in "$@"; do
            [ "$prev" = "--pack-destination" ] && dest="$arg"
            prev="$arg"
        done
        : > "$dest/stub-1.0.0.tgz"
        printf '%s\n' '[{"filename":"stub-1.0.0.tgz","files":[{"path":"package.json"}]}]'
        ;;
    install)
        printf '{"name":"stub","lockfileVersion":3,"requires":true,"packages":{"":{"name":"stub"}}}\n' > package-lock.json
        ;;
    audit)
        if [ "$(basename "$PWD")" = "canary" ]; then
            printf '%s\n' '{"vulnerabilities":{"minimist":{"name":"minimist","severity":"critical","isDirect":true,"via":[{"source":1,"name":"minimist","title":"stub","url":"https://github.com/advisories/GHSA-xvch-5gv4-984h","severity":"critical","range":"<1.2.6"}],"effects":[],"range":"<1.2.6","nodes":["node_modules/minimist"],"fixAvailable":true}},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":1,"total":1},"dependencies":{"total":1}}}'
        else
            printf '%s\n' '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0},"dependencies":{"total":3}}}'
        fi
        ;;
esac
exit 0
STUB_NPM
chmod +x "$TMP/bin/npm"
# gh は呼ばれない前提（dry-run だけを実行する）。呼ばれたら失敗させる。
cat > "$TMP/bin/gh" << 'STUB_GH'
#!/bin/bash
echo "gh が呼ばれた: $*" >&2
exit 99
STUB_GH
chmod +x "$TMP/bin/gh"
export NPM_STUB_LOG="$TMP/npm-calls.log"

# 呼び出し元の npm 設定に結果を左右させない。
unset npm_config_cache npm_config_prefer_offline npm_config_offline \
    NPM_CONFIG_CACHE NPM_CONFIG_PREFER_OFFLINE NPM_CONFIG_OFFLINE PECOT_RELEASE_TEST_NPM_CACHE
unset NX_DRY_RUN

PERSISTENT="$TMP/persistent-npm-cache"

# 記録から 1 フィールドを取り出す（複数行なら 1 行目）。
log_field() {
    local field="$1"
    head -n 1 "$NPM_STUB_LOG" | tr ' ' '\n' | sed -n "s/^${field}=//p"
}

# publish の監査記録は「スキップ」にして dry-run だけを通す（指紋の突合は本テストの対象外）。
export PECOTV_AUDIT_RECORD="$TMP/audit-record.json"
node "$AUDIT_RECORD_JS" write "$PECOTV_AUDIT_RECORD" skipped "$(git -C "$REPO_ROOT" rev-parse HEAD)"

run_publish() {
    local label="$1"
    shift
    : > "$NPM_STUB_LOG"
    PUBLISH_RC=0
    PATH="$TMP/bin:$PATH" bash "$PUBLISH" "$@" > "$TMP/publish-$label.out" 2> "$TMP/publish-$label.err" || PUBLISH_RC=$?
}

# --- 1. publish: 未設定なら mktemp の使い捨てキャッシュ ---
run_publish unset --dry-run --skip-build --out-dir="$TMP/dist-unset"
bt_eq "publish 未設定: 成功する" "0" "$PUBLISH_RC"
bt_eq "publish 未設定: npm install を 1 回呼ぶ" "1" "$(grep -c '^install ' "$NPM_STUB_LOG")"
bt_ne "publish 未設定: 永続キャッシュは使わない" "$PERSISTENT" "$(log_field cache)"
bt_ne "publish 未設定: キャッシュは mktemp 配下" "unset" "$(log_field cache)"
bt_eq "publish 未設定: prefer-offline を渡さない" "unset" "$(log_field prefer_offline)"

# --- 2. publish: 設定時は指定ディレクトリと prefer-offline ---
export PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT"
run_publish optin --dry-run --skip-build --out-dir="$TMP/dist-optin"
bt_eq "publish opt-in: 成功する" "0" "$PUBLISH_RC"
bt_eq "publish opt-in: 指定ディレクトリを npm cache にする" "$PERSISTENT" "$(log_field cache)"
bt_eq "publish opt-in: prefer-offline で解決する" "true" "$(log_field prefer_offline)"

# 2 回目も同じディレクトリで、掃除で消えない。
run_publish optin2 --dry-run --skip-build --out-dir="$TMP/dist-optin2"
bt_eq "publish opt-in 2 回目: 同じディレクトリを使う" "$PERSISTENT" "$(log_field cache)"
mkdir -p "$PERSISTENT" && : > "$PERSISTENT/marker"
run_publish optin3 --dry-run --skip-build --out-dir="$TMP/dist-optin3"
if [ -f "$PERSISTENT/marker" ]; then
    bt_pass "publish opt-in: 終了時に永続キャッシュを消さない"
else
    bt_fail "publish opt-in: 終了時に永続キャッシュを消さない" "永続キャッシュが消えた"
fi

# 絶対パス以外は、npm が cd 後の cwd で解決して別の場所を使う。そのため、そのまま通さない。
PECOT_RELEASE_TEST_NPM_CACHE="relative/cache" run_publish relative --dry-run --skip-build --out-dir="$TMP/dist-relative"
bt_ne "publish opt-in: 相対パスは拒否する" "0" "$PUBLISH_RC"
bt_eq "publish opt-in: 相対パスなら npm を呼ばない" "0" "$(wc -l < "$NPM_STUB_LOG" | tr -d ' ')"

# --- 3. publish: 実配布では opt-in を拒否する ---
# 実配布とは、dry-run でない実行を指す。
# npm のスタブが呼ばれないことで、依存解決の前に止まることも見る。
run_publish real --skip-build
bt_ne "publish 実配布 + opt-in: 拒否する" "0" "$PUBLISH_RC"
if grep -q 'PECOT_RELEASE_TEST_NPM_CACHE' "$TMP/publish-real.err"; then
    bt_pass "publish 実配布 + opt-in: 拒否の理由に変数名が出る"
else
    bt_fail "publish 実配布 + opt-in: 拒否の理由に変数名が出る" "変数名が出ない: $(log_tail publish-real.err 3)"
fi
bt_eq "publish 実配布 + opt-in: npm を呼ぶ前に止まる" "0" "$(wc -l < "$NPM_STUB_LOG" | tr -d ' ')"

# リリースのタグが HEAD に無いときも、拒否はその確認より先に働く。バージョンを指定しても同じ。
run_publish realver --skip-build --version=0.0.0-optin-test
bt_ne "publish 実配布（版を指定）+ opt-in: 拒否する" "0" "$PUBLISH_RC"
if grep -q 'PECOT_RELEASE_TEST_NPM_CACHE' "$TMP/publish-realver.err"; then
    bt_pass "publish 実配布（版を指定）+ opt-in: 拒否の理由に変数名が出る"
else
    bt_fail "publish 実配布（版を指定）+ opt-in: 拒否の理由に変数名が出る" "変数名が出ない: $(log_tail publish-realver.err 3)"
fi

# nx release --dry-run が伝える NX_DRY_RUN でも dry-run になり、拒否しない。
: > "$NPM_STUB_LOG"
NXDRY_RC=0
NX_DRY_RUN=true PATH="$TMP/bin:$PATH" bash "$PUBLISH" --skip-build --out-dir="$TMP/dist-nxdry" \
    > "$TMP/publish-nxdry.out" 2> "$TMP/publish-nxdry.err" || NXDRY_RC=$?
bt_eq "publish NX_DRY_RUN + opt-in: 成功する" "0" "$NXDRY_RC"
bt_eq "publish NX_DRY_RUN + opt-in: 指定ディレクトリを npm cache にする" "$PERSISTENT" "$(log_field cache)"

# --- 4. audit: opt-in や呼び出し元の npm 設定によらず使い捨て・offline=false ---
unset PECOT_RELEASE_TEST_NPM_CACHE
PLANS="$TMP/plans"
mkdir -p "$PLANS"
printf -- '---\npecot-visual: patch\n---\n\n監査の npm 設定を固定する。\n' > "$PLANS/1225-audit.md"
EXC="$TMP/exceptions.json"
printf '{"exceptions":[]}\n' > "$EXC"
new_tree() {
    local dir="$TMP/$1"
    mkdir -p "$dir"
    cp "$2/package.json" "$2/npm-shrinkwrap.json" "$dir/"
    echo "$dir"
}

run_audit() {
    local label="$1"
    shift
    : > "$NPM_STUB_LOG"
    AUDIT_RC=0
    env "$@" PATH="$TMP/bin:$PATH" bash "$AUDIT" \
        --dist="$(new_tree "audit-dist-$label" "$FIXTURE")" \
        --runtime-dist="$(new_tree "audit-runtime-$label" "$FIXTURE_RUNTIME")" \
        --exceptions="$EXC" --plans-dir="$PLANS" --registry="http://registry.invalid/" \
        > "$TMP/audit-$label.out" 2> "$TMP/audit-$label.err" || AUDIT_RC=$?
}

# 検証用の設定（永続キャッシュ + offline）を呼び出し元が持っていても、audit には反映させない。
# npm は npm_config_* を大文字小文字の区別なく読むので、大文字の NPM_CONFIG_* も持たせる。
run_audit hostile PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT" npm_config_cache="$PERSISTENT" \
    npm_config_offline=true npm_config_prefer_offline=true \
    NPM_CONFIG_CACHE="$PERSISTENT" NPM_CONFIG_OFFLINE=true NPM_CONFIG_PREFER_OFFLINE=true
bt_eq "audit: 成功する" "0" "$AUDIT_RC"
bt_eq "audit: npm audit をカナリア・配布ツリー・永続層の 3 回呼ぶ" "3" "$(grep -c '^audit ' "$NPM_STUB_LOG")"
BAD_CACHE="$(grep '^audit ' "$NPM_STUB_LOG" | grep -c "cache=$PERSISTENT" || true)"
bt_eq "audit: どの呼び出しも永続キャッシュを使わない" "0" "$BAD_CACHE"
# 区切り（行頭か空白）で一致を見る。素の部分一致だと、prefer_offline=false が offline=false に当たる。
NOT_OFFLINE_FALSE="$(grep '^audit ' "$NPM_STUB_LOG" | grep -Evc '(^| )offline=false( |$)' || true)"
bt_eq "audit: どの呼び出しも offline=false" "0" "$NOT_OFFLINE_FALSE"
NOT_PREFER_OFFLINE_FALSE="$(grep '^audit ' "$NPM_STUB_LOG" | grep -Evc '(^| )prefer_offline=false( |$)' || true)"
bt_eq "audit: どの呼び出しも prefer-offline=false" "0" "$NOT_PREFER_OFFLINE_FALSE"
UNSET_CACHE="$(grep '^audit ' "$NPM_STUB_LOG" | grep -c 'cache=unset' || true)"
bt_eq "audit: どの呼び出しも --cache を明示する" "0" "$UNSET_CACHE"
DISTINCT_CACHES="$(grep '^audit ' "$NPM_STUB_LOG" | sed -n 's/^audit cache=\([^ ]*\) .*/\1/p' | sort -u | wc -l | tr -d ' ')"
bt_eq "audit: 3 回とも同じ使い捨てキャッシュ" "1" "$DISTINCT_CACHES"

bt_finish
