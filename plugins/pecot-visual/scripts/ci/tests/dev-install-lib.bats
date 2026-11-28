# dev-install-lib.sh の pecotv_dev_install を確かめる (#1297 / #113)。偽の pnpm で引数・cwd・終了コードを固定する。

bats_require_minimum_version 1.5.0

CI_DIR="$BATS_TEST_DIRNAME/.."

# 偽の pnpm は、呼び出しの引数と cwd を記録し、FAKE_PNPM_RC で終わる。偽の corepack は先頭の語を捨てて pnpm に渡す。
setup_file() {
    mkdir -p "$BATS_FILE_TMPDIR/bin"
    cat > "$BATS_FILE_TMPDIR/bin/pnpm" << 'FAKE_PNPM'
#!/bin/bash
echo "pnpm $*" >> "$FAKE_PNPM_CALLS"
pwd > "$FAKE_PNPM_CWD"
exit "${FAKE_PNPM_RC:-0}"
FAKE_PNPM
    cat > "$BATS_FILE_TMPDIR/bin/corepack" << 'FAKE_COREPACK'
#!/bin/bash
shift
exec pnpm "$@"
FAKE_COREPACK
    chmod +x "$BATS_FILE_TMPDIR/bin/pnpm" "$BATS_FILE_TMPDIR/bin/corepack"
}

setup() {
    bats_load_library pecot-bats
    # shellcheck source=../dev-install-lib.sh
    . "$CI_DIR/dev-install-lib.sh"
    REPO="$BATS_TEST_TMPDIR/repo"
    ROOT="$REPO/plugins/pecot-visual"
    mkdir -p "$ROOT"
    export FAKE_PNPM_CALLS="$BATS_TEST_TMPDIR/calls" FAKE_PNPM_CWD="$BATS_TEST_TMPDIR/cwd"
    : > "$FAKE_PNPM_CALLS"
    PATH="$BATS_FILE_TMPDIR/bin:$PATH"
}

calls() {
    paste -sd '|' "$FAKE_PNPM_CALLS"
}

@test "plugin root を渡すと、リポジトリの root で frozen install を 1 回だけ動かす" {
    explains "成功する偽の \`pnpm\` で \`pecotv_dev_install\` を呼ぶテストです。リポジトリの root で \`pnpm install --frozen-lockfile\` を 1 回だけ実行し、終了コード 0 を返すことを確認します。"
    run pecotv_dev_install "$ROOT" pnpm
    assert_success
    assert_equal "$(calls)" "pnpm install --frozen-lockfile"
    assert_equal "$(cat "$FAKE_PNPM_CWD")" "$REPO"
}

@test "install が失敗すると、その終了コードをそのまま返し、後の呼び出しをしない" {
    explains "終了コード 7 で失敗する偽の \`pnpm\` で \`pecotv_dev_install\` を呼ぶテストです。7 をそのまま返し、install の後に \`pnpm\` を呼ばないことを確認します。"
    export FAKE_PNPM_RC=7
    run pecotv_dev_install "$ROOT" pnpm
    assert_failure 7
    assert_equal "$(calls)" "pnpm install --frozen-lockfile"
}

@test "起動コマンドが corepack pnpm の 2 語でも、分けて install を動かす" {
    explains "起動コマンドに \`corepack pnpm\` を渡して \`pecotv_dev_install\` を呼ぶテストです。2 語に分けて起動され、\`pnpm\` を渡したときと同じ install を実行して 0 を返すことを確認します。"
    run pecotv_dev_install "$ROOT" "corepack pnpm"
    assert_success
    assert_equal "$(calls)" "pnpm install --frozen-lockfile"
}

@test "plugin root が無いと、install を動かさずに失敗を返す" {
    explains "存在しない plugin root を渡して \`pecotv_dev_install\` を呼ぶテストです。\`pnpm\` を呼ばずに、0 以外の終了コードを返すことを確認します。"
    run pecotv_dev_install "$BATS_TEST_TMPDIR/missing/plugins/pecot-visual" pnpm
    assert_failure
    assert_equal "$(calls)" ""
}
