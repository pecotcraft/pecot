# npm の永続キャッシュ opt-in（PECOT_RELEASE_TEST_NPM_CACHE）の検証 (#352)。
# publish が npm に渡す --cache と --prefer-offline を、npm スタブで記録して確かめる。
# cli の dist が build 済みであることが前提。
# @test は並べて動く。各 @test が要る env を自分で置き、スタブのログは @test ごとの一時ディレクトリに置く。

SCRIPT_DIR="$BATS_TEST_DIRNAME"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
WORKFLOW_ROOT="$REPO_ROOT/plugins/pecot-workflow"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"

setup_file() {
    # git hook から起動されたときの GIT_DIR 等で、被テストスクリプトの `git -C` が呼び出し元リポを巻き込まないよう捨てる。
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
    # 呼び出し元の npm 設定に結果を左右させない。
    unset npm_config_cache npm_config_prefer_offline npm_config_offline \
        NPM_CONFIG_CACHE NPM_CONFIG_PREFER_OFFLINE NPM_CONFIG_OFFLINE PECOT_RELEASE_TEST_NPM_CACHE
    unset NX_DRY_RUN

    if [ ! -d "$WORKFLOW_ROOT/cli/dist" ]; then
        echo "ERROR: $WORKFLOW_ROOT/cli/dist がありません。build 済みの dist が前提です。" >&2
        echo "  bash plugins/pecot-workflow/scripts/ci/run-tests.sh --scope=release" >&2
        return 1
    fi

    # npm スタブ。呼び出しごとに「<サブコマンド> cache=<> prefer_offline=<> offline=<> cwd=<>」を記録する。
    # 値は CLI フラグから取り、無ければ unset と書く。
    # pack は本物の npm（PATH を替える前の絶対パス）へそのまま渡す。
    mkdir -p "$BATS_FILE_TMPDIR/bin"
    REAL_NPM="$(command -v npm)"
    export REAL_NPM
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
    install)
        printf '{"name":"stub","lockfileVersion":3,"requires":true,"packages":{"":{"name":"stub"}}}\n' > package-lock.json
        ;;
    pack)
        exec "$REAL_NPM" "$@"
        ;;
esac
exit 0
STUB_NPM
    # gh は呼ばれてはいけない。呼ばれたら記録する。
    cat > "$BATS_FILE_TMPDIR/bin/gh" << 'STUB_GH'
#!/bin/bash
printf '%s\n' "$*" >> "$GH_STUB_LOG"
exit 0
STUB_GH
    chmod +x "$BATS_FILE_TMPDIR/bin/npm" "$BATS_FILE_TMPDIR/bin/gh"
}

setup() {
    bats_load_library pecot-bats
    TMP="$BATS_TEST_TMPDIR"
    STUB_BIN="$BATS_FILE_TMPDIR/bin"
    PERSISTENT="$TMP/persistent-npm-cache"
    export NPM_STUB_LOG="$TMP/npm-calls.log"
    export GH_STUB_LOG="$TMP/gh-calls.log"
    : > "$GH_STUB_LOG"
}

# 失敗の補足に使う。$TMP 配下のログの末尾 N 行を 1 行にまとめて返す。
log_tail() {
    tail -"$2" "$TMP/$1" | tr '\n' ' '
}

# npm スタブと gh スタブの記録を読んで添付し、中身を npm_log・gh_log に置く。
read_stub_logs() {
    npm_log="$(read_output "$NPM_STUB_LOG")"
    gh_log="$(read_output "$GH_STUB_LOG")"
}

# 記録から 1 フィールドを取り出す（複数行なら 1 行目）。
log_field() {
    local field="$1"
    head -n 1 <<< "$npm_log" | tr ' ' '\n' | sed -n "s/^${field}=//p"
}

# 記録の行数。
npm_call_count() {
    printf '%s' "$npm_log" | grep -c '' || true
}

gh_call_count() {
    printf '%s' "$gh_log" | grep -c '' || true
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
    read_stub_logs
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
    assert_equal "$PUBLISH_RC" "0"
    assert_equal "$(log_field cache)" "$PERSISTENT"
    mkdir -p "$PERSISTENT" && : > "$PERSISTENT/marker"
    run_publish optin3 --dry-run --skip-build --out-dir="$TMP/dist-optin3"
    assert_equal "$PUBLISH_RC" "0"
    # 2 回目の実行も、永続キャッシュの残る同じディレクトリを npm cache にする。
    assert_equal "$(log_field cache)" "$PERSISTENT"
    [ -f "$PERSISTENT/marker" ] || fail "永続キャッシュが消えた"
}

@test "opt-in に相対パスを設定して publish を動かすと、npm を呼ばずに拒否する" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` に絶対パス以外を設定して `publish-mcp-dist.sh --dry-run` を動かすテストです。npm が cd 後の cwd で別の場所を使うのを防ぐため、非ゼロで終了し、npm を呼ばないことを確認します。'
    PECOT_RELEASE_TEST_NPM_CACHE="relative/cache" run_publish relative --dry-run --skip-build --out-dir="$TMP/dist-relative"
    assert_not_equal "$PUBLISH_RC" "0"
    assert_equal "$(npm_call_count)" "0"
}

@test "opt-in を設定して dry-run でない publish を動かすと、依存の解決の前に拒否し、理由に変数名を出す" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` を設定したまま、dry-run でない実配布の `publish-mcp-dist.sh` を動かすテストです。非ゼロで終了し、理由に変数名が出て、npm と gh が呼ばれずに止まることを確認します。'
    export PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT"
    # 拒否が働かなかった場合に本物の GitHub へ触れないよう、gh は PATH 先頭のスタブにしてある。
    run_publish real --skip-build
    assert_not_equal "$PUBLISH_RC" "0"
    if ! grep -q 'PECOT_RELEASE_TEST_NPM_CACHE' "$TMP/publish-real-stderr.txt"; then
        local tail_text
        tail_text="$(log_tail publish-real-stderr.txt 3)"
        fail "変数名が出ない。stderr の末尾は次のとおり。${tail_text}"
    fi
    assert_equal "$(npm_call_count)" "0"
    assert_equal "$(gh_call_count)" "0"
}

@test "opt-in に相対パスを設定して dry-run でない publish を動かすと、拒否する" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` に絶対パス以外を設定し、dry-run でない実配布の `publish-mcp-dist.sh` を動かすテストです。絶対パスの確認で先に止まり、非ゼロで終了することを確認します。'
    PECOT_RELEASE_TEST_NPM_CACHE="relative/cache" run_publish realrelative --skip-build
    assert_not_equal "$PUBLISH_RC" "0"
}

@test "opt-in を設定して NX_DRY_RUN で publish を動かすと、dry-run として拒否せず、gh を呼ばない" {
    explains '`PECOT_RELEASE_TEST_NPM_CACHE` を設定し、`NX_DRY_RUN` で `publish-mcp-dist.sh` を動かすテストです。dry-run として扱われて成功し、gh が呼ばれないことを確認します。'
    export PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT"
    NX_DRY_RUN=1 run_publish nxdry --skip-build --out-dir="$TMP/dist-nxdry"
    assert_equal "$PUBLISH_RC" "0"
    assert_equal "$(gh_call_count)" "0"
}
