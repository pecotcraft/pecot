# .githooks/lib/mcp-publish-common.sh（3 プラグインの publish-mcp-dist.sh が共有する関数）の検証。
# 各関数を子 bash で source して呼び、終了コードと出力を固定する。npm はスタブ、git は使い捨てリポで確かめる。
# shellcheck disable=SC2016

LIB="$BATS_TEST_DIRNAME/../../lib/mcp-publish-common.sh"

setup_file() {
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
    unset NX_DRY_RUN PECOT_RELEASE_TEST_NPM_CACHE
}

setup() {
    bats_load_library pecot-bats
}

# 子 bash で lib を source してコードを実行し、出力を添付する。終了コードは status、標準出力と標準エラーは output に入る。
run_lib() {
    run_attached bash -c "set -euo pipefail; . '$LIB'; $1"
}

# 使い捨てリポ用の git の作者。
use_git_author() {
    export GIT_AUTHOR_NAME="mcp-publish-common test" GIT_AUTHOR_EMAIL="mcp-publish-common-test@example.invalid"
    export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
}

@test "sanitize_env が GIT_DIR と FORCE_COLOR を捨てる" {
    explains "\`mcp_publish_sanitize_env\` のテストです。\`GIT_DIR\` と \`FORCE_COLOR\` を設定して呼ぶと、どちらも空になることを確認します。"
    run_lib 'export GIT_DIR=/x FORCE_COLOR=1; mcp_publish_sanitize_env; echo "[${GIT_DIR:-}][${FORCE_COLOR:-}]"'
    assert_output "[][]"
}

@test "defaults が dry-run なし・build ありの初期値を置き、NX_DRY_RUN で dry-run が決まる" {
    explains "\`mcp_publish_defaults\` のテストです。初期値が dry-run なし・build ありで、\`NX_DRY_RUN\` が 1 のときだけ dry-run になることを確認します。"
    run_lib 'mcp_publish_defaults; echo "$DRY_RUN $SKIP_BUILD [$VERSION] [$OUT_DIR]"'
    assert_output "false false [] []"
    run_lib 'NX_DRY_RUN=1; mcp_publish_defaults; echo "$DRY_RUN"'
    assert_output "true"
    run_lib 'NX_DRY_RUN=false; mcp_publish_defaults; echo "$DRY_RUN"'
    assert_output "false"
}

@test "共通の 4 引数を解釈し、共通でない引数は呼び出し側に回す" {
    explains "\`mcp_publish_parse_arg\` のテストです。共通の 4 引数を解釈して変数に入れ、共通でない引数は 1 を返して呼び出し側に回すことを確認します。"
    run_lib 'mcp_publish_defaults; for a in --version=1.2.3 --out-dir=/x/y --dry-run --skip-build; do mcp_publish_parse_arg "$a"; done; echo "$VERSION $OUT_DIR $DRY_RUN $SKIP_BUILD"'
    assert_output "1.2.3 /x/y true true"
    run_lib 'mcp_publish_defaults; if mcp_publish_parse_arg --audit-record=x; then echo consumed; else echo passthrough; fi'
    assert_output "passthrough"
}

@test "未対応の引数は、引数名と固有の引数を示して exit 1 になる" {
    explains "\`mcp_publish_unknown_arg\` のテストです。未対応の引数を渡すと exit 1 になり、引数名と使用可能な引数の一覧が文に出ることを確認します。"
    run_lib 'mcp_publish_unknown_arg --repo=o/n "|--audit-record=<path>"'
    assert_failure 1
    assert_output --partial "未対応の引数: --repo=o/n (使用可能: --version=<ver>|--out-dir=<dir>|--dry-run|--skip-build|--audit-record=<path>)"
}

@test "npm キャッシュの opt-in が無ければ通る" {
    explains "\`mcp_publish_check_npm_cache_opt_in\` のテストです。\`PECOT_RELEASE_TEST_NPM_CACHE\` を設定しない場合に通り、opt-in が空になることを確認します。"
    run_lib 'DRY_RUN=false; mcp_publish_check_npm_cache_opt_in; echo "[$NPM_CACHE_OPT_IN]"'
    assert_output "[]"
}

@test "npm キャッシュの opt-in が相対パスだと、変数名を示して exit 1 になる" {
    explains "\`mcp_publish_check_npm_cache_opt_in\` のテストです。\`PECOT_RELEASE_TEST_NPM_CACHE\` が相対パスの場合に、変数名を示して exit 1 になることを確認します。"
    PECOT_RELEASE_TEST_NPM_CACHE=relative/path run_lib 'DRY_RUN=true; mcp_publish_check_npm_cache_opt_in'
    assert_failure 1
    assert_output --partial "PECOT_RELEASE_TEST_NPM_CACHE は絶対パスで指定してください"
}

@test "実配布での npm キャッシュの opt-in は、検証用と示して exit 1 になる" {
    explains "\`mcp_publish_check_npm_cache_opt_in\` のテストです。dry-run でない実配布で opt-in を指定した場合に、検証用であると示して exit 1 になることを確認します。"
    PECOT_RELEASE_TEST_NPM_CACHE=/abs/cache run_lib 'DRY_RUN=false; mcp_publish_check_npm_cache_opt_in'
    assert_failure 1
    assert_output --partial "検証用です"
}

@test "dry-run での絶対パスの npm キャッシュの opt-in は通る" {
    explains "\`mcp_publish_check_npm_cache_opt_in\` のテストです。dry-run で絶対パスの opt-in を指定した場合に通り、指定のパスが変数に入ることを確認します。"
    PECOT_RELEASE_TEST_NPM_CACHE=/abs/cache run_lib 'DRY_RUN=true; mcp_publish_check_npm_cache_opt_in; echo "$NPM_CACHE_OPT_IN"'
    assert_output "/abs/cache"
}

@test "out-dir にリポ配下・中身のあるディレクトリ・ファイル・親の不在を指定すると拒否し、symlink の親は実体のパスで通す" {
    explains "\`mcp_publish_validate_out_dir\` のテストです。リポ配下・中身のあるディレクトリ・ファイル・親の不在は拒否し、空の指定・symlink の親・空のディレクトリは通すことを確認します。"
    local tmp="$BATS_TEST_TMPDIR" fake_repo
    mkdir -p "$tmp/repo/inner" "$tmp/outside-full" "$tmp/real-parent" "$tmp/empty-dir"
    touch "$tmp/outside-full/keep" "$tmp/a-file"
    ln -s "$tmp/real-parent" "$tmp/link-parent"
    fake_repo="$(cd "$tmp/repo" && pwd -P)"
    ln -s "$fake_repo/inner" "$tmp/link-into-repo"

    check_out_dir() {
        run_lib "REPO_ROOT='$fake_repo'; OUT_DIR='$1'; mcp_publish_validate_out_dir; echo \"\$OUT_DIR\""
    }
    check_out_dir ""
    assert_success
    assert_output ""
    check_out_dir "$fake_repo/inner"
    assert_failure 1
    assert_output --partial "リポジトリ ($fake_repo) の外を指定してください"
    check_out_dir "$fake_repo"
    assert_failure 1
    check_out_dir "$tmp/outside-full"
    assert_failure 1
    assert_output --partial "不在か空のディレクトリのみ"
    check_out_dir "$tmp/a-file"
    assert_failure 1
    assert_output --partial "ディレクトリではありません"
    check_out_dir "$tmp/no-such-parent/child"
    assert_failure 1
    assert_output --partial "親ディレクトリがありません"
    check_out_dir "$tmp/link-parent/new-dist"
    assert_success
    assert_output "$(cd "$tmp/real-parent" && pwd -P)/new-dist"
    check_out_dir "$tmp/empty-dir"
    assert_success
    assert_output "$(cd "$tmp/empty-dir" && pwd -P)"
    check_out_dir "$tmp/link-into-repo"
    assert_failure 1
}

@test "リリースの HEAD の確認が、タグと対象パスの差分に応じて、終える・続ける・止まる" {
    explains "\`mcp_publish_require_release_head\` のテストです。タグが無い場合は終了し、タグと差分の有無に応じて続行または停止することを確認します。"
    use_git_author
    local repo="$BATS_TEST_TMPDIR/git-repo"
    mkdir -p "$repo/plugins/p"
    git init --quiet --initial-branch=main "$repo"
    echo a > "$repo/plugins/p/f"
    git -C "$repo" add -A > /dev/null 2>&1
    git -C "$repo" commit --quiet -m init > /dev/null 2>&1

    head_check() {
        run_lib "REPO_ROOT='$repo'; DRY_RUN=$1; mcp_publish_require_release_head p-v1 p plugins/p; echo continued"
    }
    head_check false
    assert_success
    assert_output --partial "スキップ: HEAD に p-v1 が無いため p のリリースではありません"
    refute_output --partial "continued"
    head_check true
    assert_success
    assert_output --partial "continued"
    git -C "$repo" tag p-v1
    head_check false
    assert_success
    assert_output --partial "continued"
    echo b >> "$repo/plugins/p/f"
    head_check false
    assert_failure 1
    assert_output --partial "plugins/p に未コミットの変更があります"
    head_check true
    assert_success
    assert_output --partial "continued"
    git -C "$repo" checkout --quiet -- plugins/p/f
    echo c > "$repo/unrelated"
    head_check false
    assert_success
    assert_output --partial "continued"
}

@test "make_dist が、out-dir を空にして DIST にし、指定が無ければ終了時に消し、終了コードを保つ" {
    explains "\`mcp_publish_make_dist\` のテストです。\`--out-dir\` は空にして残し、指定が無ければ一時ディレクトリを終了時に削除し、元の終了コードを保つことを確認します。"
    local tmp="$BATS_TEST_TMPDIR" auto_dist
    run_lib "OUT_DIR='$tmp/dist-out'; mkdir -p \"\$OUT_DIR\"; echo old > \"\$OUT_DIR/old\"; mcp_publish_make_dist; echo \"\$DIST \$(ls -A \"\$DIST\" | wc -l | tr -d ' ')\""
    assert_success
    assert_output "$tmp/dist-out 0"
    assert [ -d "$tmp/dist-out" ]
    run_lib "OUT_DIR=''; mcp_publish_make_dist; echo \"\$DIST\" > '$tmp/auto-dist-path'"
    assert_success
    auto_dist="$(read_output "$tmp/auto-dist-path")"
    assert [ ! -e "$auto_dist" ]
    run_lib "OUT_DIR=''; mcp_publish_make_dist; exit 7"
    assert_failure 7
}

@test "write_shrinkwrap が shrinkwrap を作り、npm にタイムアウト・再試行・キャッシュの引数を渡す" {
    explains "\`mcp_publish_write_shrinkwrap\` のテストです。npm をスタブにして、shrinkwrap が作られ、opt-in の有無でキャッシュに関する引数が変わることを確認します。"
    local tmp="$BATS_TEST_TMPDIR" npm_args
    mkdir -p "$tmp/bin" "$tmp/sw-dist"
    cat > "$tmp/bin/npm" << 'STUB_NPM'
#!/bin/bash
printf '%s\n' "$*" > "$NPM_STUB_LOG"
echo '{"lockfileVersion":3}' > package-lock.json
STUB_NPM
    chmod +x "$tmp/bin/npm"
    export NPM_STUB_LOG="$tmp/npm.log"
    PATH="$tmp/bin:$PATH" run_lib "NPM_CACHE_OPT_IN=''; mcp_publish_write_shrinkwrap '$tmp/sw-dist'"
    assert_success
    assert [ -f "$tmp/sw-dist/npm-shrinkwrap.json" ]
    assert [ ! -f "$tmp/sw-dist/package-lock.json" ]
    npm_args="$(read_output "$NPM_STUB_LOG")"
    assert_regex "$npm_args" "--fetch-timeout=30000 --fetch-retries=1"
    assert_regex "$npm_args" "install --package-lock-only --ignore-scripts"
    refute_regex "$npm_args" "--prefer-offline"
    rm -f "$tmp/sw-dist/npm-shrinkwrap.json"
    export NPM_STUB_LOG="$tmp/npm-2.log"
    PATH="$tmp/bin:$PATH" run_lib "NPM_CACHE_OPT_IN='$tmp/persist-cache'; mcp_publish_write_shrinkwrap '$tmp/sw-dist'"
    npm_args="$(read_output "$NPM_STUB_LOG")"
    assert_regex "$npm_args" "--cache=$tmp/persist-cache --prefer-offline"
}
