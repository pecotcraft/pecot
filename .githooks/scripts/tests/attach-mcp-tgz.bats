# attach-mcp-tgz.sh（npm pack から gh の 3 回の呼び出しまで）の検証。gh は PATH 先頭のスタブで差し替え、npm pack は本物を使う。

ATTACH="$BATS_TEST_DIRNAME/../attach-mcp-tgz.sh"
SLUG="acme-labs/example-repo"
TAG="example-v1.2.3"

setup_file() {
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
    # gh スタブ。呼び出しの引数を 1 行ずつ記録する。GH_STUB_NO_RELEASE=1 のとき release view は標準エラーを出して失敗する。
    mkdir -p "$BATS_FILE_TMPDIR/bin"
    cat > "$BATS_FILE_TMPDIR/bin/gh" << 'STUB_GH'
#!/bin/bash
printf '%s\n' "$*" >> "$GH_STUB_LOG"
if [ "$1 $2" = "release view" ] && [ "${GH_STUB_NO_RELEASE:-}" = 1 ]; then
    echo "gh: HTTP 401 stub failure" >&2
    exit 1
fi
exit 0
STUB_GH
    chmod +x "$BATS_FILE_TMPDIR/bin/gh"
    export PATH="$BATS_FILE_TMPDIR/bin:$PATH"
}

setup() {
    bats_load_library pecot-bats
    export GH_STUB_LOG="$BATS_TEST_TMPDIR/gh.log"
    : > "$GH_STUB_LOG"
    # 配布ツリーと、origin を持つ使い捨てリポ。
    DIST="$BATS_TEST_TMPDIR/dist"
    mkdir -p "$DIST"
    printf '{"name":"@example/attach-test","version":"1.2.3","files":["package.json"]}\n' > "$DIST/package.json"
    REPO="$BATS_TEST_TMPDIR/repo"
    git init --quiet --initial-branch=main "$REPO"
}

set_origin() {
    git -C "$REPO" remote remove origin 2> /dev/null || true
    git -C "$REPO" remote add origin "$1"
}

run_attach() {
    bash "$ATTACH" --dist="$DIST" --tag="$TAG" --package="@example/attach-test" --version=1.2.3 \
        --repo-root="$REPO" "$@"
}

gh_lines() {
    wc -l < "$GH_STUB_LOG" | tr -d ' '
}

@test "origin の URL の形が違っても、-R が owner/name になり dry-run は gh を呼ばない" {
    explains "\`origin\` の URL から owner/name を求める部分のテストです。https・scp 形式・ssh:// の各形で \`-R\` が owner/name になり、dry-run では \`gh\` を呼ばないことを確認します。"
    local url
    for url in "https://github.com/$SLUG.git" "https://github.com/$SLUG" \
        "https://user:token@github.com/$SLUG.git" "https://github.com/$SLUG/" \
        "https://github.com/$SLUG.git/" "git@github.com:$SLUG.git" "git@github.com:$SLUG" \
        "ssh://git@github.com/$SLUG.git" "ssh://git@github.com:22/$SLUG.git" \
        "ssh://git@github.com:2222/$SLUG/"; do
        set_origin "$url"
        : > "$GH_STUB_LOG"
        run run_attach --dry-run
        assert_success
        assert_line "    gh release view $TAG -R $SLUG"
        assert_equal "$(gh_lines)" "0"
    done
}

@test "origin から owner/name を求められないと、gh を呼ばずに止まる" {
    explains "\`origin\` の URL が owner/name の形でない場合のテストです。3 階層・1 階層・URL でない文字列・ローカルパスで止まり、\`gh\` を呼ばないことを確認します。"
    local url
    for url in "https://github.com/a/b/c.git" "https://github.com/onlyone" "not-a-url" "/srv/git/repo.git"; do
        set_origin "$url"
        : > "$GH_STUB_LOG"
        run run_attach --dry-run
        assert_failure
        assert_output --partial "origin の URL から owner/name を求められません"
        assert_equal "$(gh_lines)" "0"
    done
}

@test "dry-run が正常終了し、tgz の名前と中身の一覧を出力する" {
    explains "\`--dry-run\` で実行するテストです。正常終了し、tgz の名前と中身の一覧が出力され、\`gh\` を呼ばないことを確認します。"
    set_origin "https://github.com/$SLUG.git"
    run run_attach --dry-run
    assert_success
    assert_output --partial "tgz: example-attach-test-1.2.3.tgz"
    assert_line "    package.json"
    assert_equal "$(gh_lines)" "0"
}

@test "dry-run が、実行する gh の 3 つのコマンドを表示する" {
    explains "\`--dry-run\` の表示のテストです。\`release view\`・\`release upload\`・\`workflow run\` の 3 つのコマンドが表示されることを確認します。"
    set_origin "https://github.com/$SLUG.git"
    run run_attach --dry-run
    assert_success
    assert_line "    gh release view $TAG -R $SLUG"
    assert_line "    gh release upload $TAG example-attach-test-1.2.3.tgz --clobber -R $SLUG"
    assert_line "    gh workflow run publish-npm.yml -f tag=$TAG --ref $TAG -R $SLUG"
}

@test "dry-run がタグの版は本実行で変わり得ると注記する" {
    explains "\`--dry-run\` の注記のテストです。タグの版が本実行で変わり得るという注記が表示されることを確認します。"
    set_origin "https://github.com/$SLUG.git"
    run run_attach --dry-run
    assert_success
    assert_output --partial "版は version の段階より前の値です"
}

@test "本実行が gh を 3 回、release view・release upload・workflow run の順に呼ぶ" {
    explains "\`gh\` をスタブにした本実行のテストです。正常終了し、\`release view\`・\`release upload\`・\`workflow run\` の順に 3 回呼び、完了の行にパッケージ名と版が出ることを確認します。"
    set_origin "https://github.com/$SLUG.git"
    run run_attach
    assert_success
    assert_output --partial "@example/attach-test v1.2.3 を Release に添え"
    assert_equal "$(gh_lines)" "3"
    assert_equal "$(sed -n 1p "$GH_STUB_LOG")" "release view $TAG -R $SLUG"
    assert_regex "$(sed -n 2p "$GH_STUB_LOG")" "^release upload $TAG /.*/example-attach-test-1\.2\.3\.tgz --clobber -R $SLUG\$"
    assert_equal "$(sed -n 3p "$GH_STUB_LOG")" "workflow run publish-npm.yml -f tag=$TAG --ref $TAG -R $SLUG"
}

@test "release view が失敗すると、gh の出力を添えて upload へ進む前に止まり、Release の不在は言い切らない" {
    explains "\`release view\` が失敗する場合のテストです。非ゼロで終了し、\`gh\` を 1 回だけ呼び、進捗の行と \`gh\` の出力を表示し、Release の不在は言い切らないことを確認します。"
    set_origin "https://github.com/$SLUG.git"
    GH_STUB_NO_RELEASE=1 run run_attach
    assert_failure 1
    assert_equal "$(gh_lines)" "1"
    assert_output --partial "==> gh release view $TAG -R $SLUG"
    assert_output --partial "Release $TAG を確認できません: gh: HTTP 401 stub failure"
    refute_output --partial "ありません"
}

@test "引数が不正だと、非ゼロ終了になる" {
    explains "引数の検証のテストです。未対応の引数・必須の引数の欠け・存在しない \`--dist\` のそれぞれで、非ゼロ終了になることを確認します。"
    set_origin "https://github.com/$SLUG.git"
    run run_attach --bogus
    assert_failure
    run bash "$ATTACH" --dist="$DIST" --tag="$TAG" --package=x --version=1
    assert_failure
    run run_attach --dry-run --dist="$BATS_TEST_TMPDIR/no-such-dir"
    assert_failure
}
