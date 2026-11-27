# npm の永続キャッシュ opt-in（PECOT_RELEASE_TEST_NPM_CACHE）の検証 (#1225)。
# publish / audit が npm に渡す CLI フラグを、npm スタブで記録して確かめる。
# publish は --dry-run --skip-build で動かすので、cli・eslint プラグイン・text-rules の dist が build 済みであることが前提。
# @test は並べて動く。各 @test が要る env を自分で置き、スタブのログは @test ごとの一時ディレクトリに置く。

SCRIPT_DIR="$BATS_TEST_DIRNAME"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
PECOTV_ROOT="$REPO_ROOT/plugins/pecot-visual"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"
AUDIT="$RELEASE_DIR/audit-mcp-dist.sh"
AUDIT_RECORD_JS="$RELEASE_DIR/audit-record.mjs"
FIXTURE="$SCRIPT_DIR/fixtures/audit"
FIXTURE_RUNTIME="$SCRIPT_DIR/fixtures/audit-runtime"

setup_file() {
    # git hook から起動されたときの GIT_DIR 等で、被テストスクリプトの `git -C` が呼び出し元リポを巻き込まないよう捨てる。
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
    # 呼び出し元の npm 設定に結果を左右させない。
    unset npm_config_cache npm_config_prefer_offline npm_config_offline \
        NPM_CONFIG_CACHE NPM_CONFIG_PREFER_OFFLINE NPM_CONFIG_OFFLINE PECOT_RELEASE_TEST_NPM_CACHE
    unset NX_DRY_RUN

    local required
    for required in "$PECOTV_ROOT/cli/dist" "$REPO_ROOT/libs/text-rules/dist" \
        "$PECOTV_ROOT/assets/slidev/scripts/eslint/_shared/dist"; do
        if [ ! -d "$required" ]; then
            echo "ERROR: $required がありません。build 済みの dist が前提です。" >&2
            echo "  bash plugins/pecot-visual/scripts/ci/run-tests.sh --scope=release" >&2
            return 1
        fi
    done

    # npm スタブ。呼び出しごとに「<サブコマンド> cache=<> prefer_offline=<> offline=<> cwd=<>」を記録する。
    # 値は CLI フラグから取り、無ければ unset と書く。
    # audit は cwd が canary のときだけカナリアの advisory を返す。
    mkdir -p "$BATS_FILE_TMPDIR/bin"
    cat > "$BATS_FILE_TMPDIR/bin/npm" << 'STUB_NPM'
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
    chmod +x "$BATS_FILE_TMPDIR/bin/npm"
    # gh は呼ばれない前提（dry-run だけを実行する）。呼ばれたら失敗させる。
    cat > "$BATS_FILE_TMPDIR/bin/gh" << 'STUB_GH'
#!/bin/bash
echo "gh が呼ばれた: $*" >&2
exit 99
STUB_GH
    chmod +x "$BATS_FILE_TMPDIR/bin/gh"
}

setup() {
    bats_load_library pecot-bats
    TMP="$BATS_TEST_TMPDIR"
    STUB_BIN="$BATS_FILE_TMPDIR/bin"
    PERSISTENT="$TMP/persistent-npm-cache"
    export NPM_STUB_LOG="$TMP/npm-calls.log"
    # publish の監査記録は「スキップ」にして dry-run だけを通す（指紋の突合は本テストの対象外）。
    export PECOTV_AUDIT_RECORD="$TMP/audit-record.json"
    node "$AUDIT_RECORD_JS" write "$PECOTV_AUDIT_RECORD" skipped "$(git -C "$REPO_ROOT" rev-parse HEAD)"
}

# 失敗の補足に使う。$TMP 配下のログの末尾 N 行を 1 行にまとめて返す。
log_tail() {
    tail -"$2" "$TMP/$1" | tr '\n' ' '
}

# npm スタブの記録を読んで添付し、中身を npm_log に置く。
read_npm_log() {
    npm_log="$(read_output "$NPM_STUB_LOG")"
}

# 記録から 1 フィールドを取り出す（複数行なら 1 行目）。
log_field() {
    local field="$1"
    head -n 1 <<< "$npm_log" | tr ' ' '\n' | sed -n "s/^${field}=//p"
}

# npm スタブの呼び出し行数。
npm_call_count() {
    printf '%s' "$npm_log" | grep -c '' || true
}

run_publish() {
    local label="$1"
    shift
    export NPM_STUB_LOG="$TMP/npm-calls-$label.log"
    : > "$NPM_STUB_LOG"
    PUBLISH_RC=0
    PATH="$STUB_BIN:$PATH" bash "$PUBLISH" "$@" > "$TMP/publish-$label-stdout.txt" 2> "$TMP/publish-$label-stderr.txt" || PUBLISH_RC=$?
    attach_file "$TMP/publish-$label-stdout.txt"
    attach_file "$TMP/publish-$label-stderr.txt"
    read_npm_log
}

# 拒否の理由（stderr）に変数名が出ること。
assert_err_names_variable() {
    if ! grep -q 'PECOT_RELEASE_TEST_NPM_CACHE' "$TMP/publish-$1-stderr.txt"; then
        local tail_text
        tail_text="$(log_tail "publish-$1-stderr.txt" 3)"
        fail "変数名が出ない。stderr の末尾は次のとおり。${tail_text}"
    fi
}

new_tree() {
    local dir="$TMP/$1"
    mkdir -p "$dir"
    cp "$2/package.json" "$2/npm-shrinkwrap.json" "$dir/"
    echo "$dir"
}

run_audit() {
    local label="$1"
    shift
    export NPM_STUB_LOG="$TMP/npm-calls-$label.log"
    : > "$NPM_STUB_LOG"
    local PLANS="$TMP/plans" EXC="$TMP/exceptions.json"
    mkdir -p "$PLANS"
    printf -- '---\npecot-visual: patch\n---\n\n監査の npm 設定を固定する。\n' > "$PLANS/1225-audit.md"
    printf '{"exceptions":[]}\n' > "$EXC"
    AUDIT_RC=0
    env "$@" PATH="$STUB_BIN:$PATH" bash "$AUDIT" \
        --dist="$(new_tree "audit-dist-$label" "$FIXTURE")" \
        --runtime-dist="$(new_tree "audit-runtime-$label" "$FIXTURE_RUNTIME")" \
        --exceptions="$EXC" --plans-dir="$PLANS" --registry="http://registry.invalid/" \
        > "$TMP/audit-$label-stdout.txt" 2> "$TMP/audit-$label-stderr.txt" || AUDIT_RC=$?
    attach_file "$TMP/audit-$label-stdout.txt"
    attach_file "$TMP/audit-$label-stderr.txt"
    read_npm_log
}

@test "opt-in を設定せずに publish の dry-run を動かすと、使い捨てのキャッシュで依存を解決する" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` を設定せずに `publish-mcp-dist.sh --dry-run` を動かすテストです。成功し、`npm install` が 1 回だけ呼ばれ、永続キャッシュを使わず `--prefer-offline` も渡さないことを確認します。'
    run_publish unset --dry-run --skip-build --out-dir="$TMP/dist-unset"
    assert_equal "$PUBLISH_RC" "0"
    assert_equal "$(grep -c '^install ' <<< "$npm_log")" "1"
    assert_not_equal "$(log_field cache)" "$PERSISTENT"
    assert_not_equal "$(log_field cache)" "unset"
    assert_equal "$(log_field prefer_offline)" "unset"
}

@test "opt-in を設定して publish の dry-run を動かすと、指定ディレクトリを npm cache にして prefer-offline で解決する" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` に絶対パスを設定して `publish-mcp-dist.sh --dry-run` を動かすテストです。成功し、npm の cache が指定したディレクトリになり、`--prefer-offline` が渡されることを確認します。'
    export PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT"
    run_publish optin --dry-run --skip-build --out-dir="$TMP/dist-optin"
    assert_equal "$PUBLISH_RC" "0"
    assert_equal "$(log_field cache)" "$PERSISTENT"
    assert_equal "$(log_field prefer_offline)" "true"
}

@test "opt-in を設定して publish の dry-run を繰り返すと、同じディレクトリを使い、終了時に永続キャッシュを消さない" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` を設定して `publish-mcp-dist.sh --dry-run` を続けて動かすテストです。2 回目も同じディレクトリを npm cache にし、永続キャッシュに置いたファイルが終了後も残ることを確認します。'
    export PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT"
    run_publish optin2 --dry-run --skip-build --out-dir="$TMP/dist-optin2"
    assert_equal "$(log_field cache)" "$PERSISTENT"
    mkdir -p "$PERSISTENT" && : > "$PERSISTENT/marker"
    run_publish optin3 --dry-run --skip-build --out-dir="$TMP/dist-optin3"
    [ -f "$PERSISTENT/marker" ] || fail "永続キャッシュが消えた"
}

@test "opt-in に相対パスを設定して publish を動かすと、npm を呼ばずに拒否する" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` に絶対パス以外を設定して `publish-mcp-dist.sh --dry-run` を動かすテストです。npm が cd 後の cwd で別の場所を使うのを防ぐため、非ゼロで終了し、npm を呼ばないことを確認します。'
    PECOT_RELEASE_TEST_NPM_CACHE="relative/cache" run_publish relative --dry-run --skip-build --out-dir="$TMP/dist-relative"
    assert_not_equal "$PUBLISH_RC" "0"
    assert_equal "$(npm_call_count)" "0"
}

@test "opt-in を設定して dry-run でない publish を動かすと、依存の解決の前に拒否し、理由に変数名を出す" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` を設定したまま、dry-run でない実配布の `publish-mcp-dist.sh` を動かすテストです。非ゼロで終了し、理由に変数名が出て、npm が呼ばれる前に止まることを確認します。'
    export PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT"
    run_publish real --skip-build
    assert_not_equal "$PUBLISH_RC" "0"
    assert_err_names_variable real
    assert_equal "$(npm_call_count)" "0"
}

@test "opt-in を設定して版を指定した実配布の publish を動かすと、リリースのタグの確認より先に拒否する" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` を設定し、`--version` を指定した実配布の `publish-mcp-dist.sh` を動かすテストです。HEAD にリリースのタグが無くても、非ゼロで終了し、理由に変数名が出ることを確認します。'
    export PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT"
    run_publish realver --skip-build --version=0.0.0-optin-test
    assert_not_equal "$PUBLISH_RC" "0"
    assert_err_names_variable realver
}

@test "opt-in を設定して NX_DRY_RUN で publish を動かすと、dry-run として拒否せず指定ディレクトリを npm cache にする" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` を設定し、`NX_DRY_RUN` で `publish-mcp-dist.sh` を動かすテストです。dry-run として扱われて成功し、npm の cache が指定したディレクトリになることを確認します。'
    export PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT"
    : > "$NPM_STUB_LOG"
    local rc=0
    NX_DRY_RUN=true PATH="$STUB_BIN:$PATH" bash "$PUBLISH" --skip-build --out-dir="$TMP/dist-nxdry" \
        > "$TMP/publish-nxdry-stdout.txt" 2> "$TMP/publish-nxdry-stderr.txt" || rc=$?
    attach_file "$TMP/publish-nxdry-stdout.txt"
    attach_file "$TMP/publish-nxdry-stderr.txt"
    read_npm_log
    assert_equal "$rc" "0"
    assert_equal "$(log_field cache)" "$PERSISTENT"
}

@test "呼び出し元が永続キャッシュと offline の設定を持っていても、audit は使い捨てのキャッシュと offline=false で npm を呼ぶ" {
    explains '検証用の永続キャッシュと offline の設定を、小文字と大文字の `npm_config_*` も含めて持たせて `audit-mcp-dist.sh` を動かすテストです。成功し、npm audit の 3 回の呼び出しがすべて同じ使い捨てキャッシュと `offline=false` で動くことを確認します。'
    unset PECOT_RELEASE_TEST_NPM_CACHE
    # npm は npm_config_* を大文字小文字の区別なく読むので、大文字の NPM_CONFIG_* も持たせる。
    run_audit hostile PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT" npm_config_cache="$PERSISTENT" \
        npm_config_offline=true npm_config_prefer_offline=true \
        NPM_CONFIG_CACHE="$PERSISTENT" NPM_CONFIG_OFFLINE=true NPM_CONFIG_PREFER_OFFLINE=true
    assert_equal "$AUDIT_RC" "0"
    assert_equal "$(grep -c '^audit ' <<< "$npm_log")" "3"
    assert_equal "$(grep '^audit ' <<< "$npm_log" | grep -c "cache=$PERSISTENT" || true)" "0"
    # 区切り（行頭か空白）で一致を見る。素の部分一致だと、prefer_offline=false が offline=false に当たる。
    assert_equal "$(grep '^audit ' <<< "$npm_log" | grep -Evc '(^| )offline=false( |$)' || true)" "0"
    assert_equal "$(grep '^audit ' <<< "$npm_log" | grep -Evc '(^| )prefer_offline=false( |$)' || true)" "0"
    assert_equal "$(grep '^audit ' <<< "$npm_log" | grep -c 'cache=unset' || true)" "0"
    assert_equal "$(grep '^audit ' <<< "$npm_log" | sed -n 's/^audit cache=\([^ ]*\) .*/\1/p' | sort -u | wc -l | tr -d ' ')" "1"
}
