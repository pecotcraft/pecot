# session-start.sh の単体テスト。.pecotv が無いリポでは何も作らず（#662/#676）、あるリポでは .gitignore を
# 定義へ書き直し（追跡中は書き換えない）、追跡の手順や直す手順を案内することを確かめる。

bats_require_minimum_version 1.5.0

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

HOOK="$BATS_TEST_DIRNAME/../session-start.sh"
ENSURE="$BATS_TEST_DIRNAME/../lib/core/pecotv-gitignore-ensure.sh"
NODE_OLD_MESSAGE="pecotv: Node.js 0.0.0 は起動しません。"

setup_file() {
    bats_load_library pecot-bats
    command -v jq >/dev/null 2>&1 || fail "jq が無いためフックの JSON を読めない"
}

setup() {
    bats_load_library pecot-bats
}

# 親リポの GIT_DIR などが漏れると、一時リポの操作が親リポへ向く。
# そのためテストの git（_git）もフックの起動（_run_hook）も GIT_* を外して行う。
_GIT_ISOLATE=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES)
_git() {
    "${_GIT_ISOLATE[@]}" git "$@"
}
# フックを GIT_* 隔離下で起動する。VAR=val を引数前置きで渡せる（例: _run_hook CLAUDE_PROJECT_DIR=...）。
_run_hook() {
    "${_GIT_ISOLATE[@]}" "$@" bash "$HOOK"
}

# $1 に git リポを作り、commit できるよう user を設定する。
_git_repo() {
    _git -C "$1" init -q
    _git -C "$1" config user.email t@t
    _git -C "$1" config user.name t
}

# node を PATH 先頭のスタブで差し替える。checkNodeRuntime の判定そのものは cli 側のテストが担う。
# STUB_BLOCK は起動を拒む版の案内を出し、STUB_OK は何も出さない。
make_node_stubs() {
    STUB_BLOCK="$BATS_TEST_TMPDIR/stub-block"
    STUB_OK="$BATS_TEST_TMPDIR/stub-ok"
    mkdir -p "$STUB_BLOCK" "$STUB_OK"
    printf '#!/bin/sh\n' > "$STUB_BLOCK/node"
    printf 'printf "%%s" "Node.js 0.0.0 は起動しません。"\n' >> "$STUB_BLOCK/node"
    printf '#!/bin/sh\nexit 0\n' > "$STUB_OK/node"
    chmod +x "$STUB_BLOCK/node" "$STUB_OK/node"
}

@test ".pecotv が無いリポでは、何も作らずに 0 で終わる" {
    explains "\`.pecotv\` が無いディレクトリで \`session-start.sh\` を起動するテストです。終了コード 0 で終わり、\`.pecotv\` が作成されないことを確認します。"
    local proj="$BATS_TEST_TMPDIR/p"
    mkdir -p "$proj"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj"
    assert_success
    assert [ ! -e "$proj/.pecotv" ]
}

@test "追跡していない .gitignore が定義と違うと、定義の内容へ書き直す" {
    explains "追跡していない \`.pecotv/.gitignore\` に別の内容が入ったリポのテストです。終了コード 0 で終わり、中身が \`pecotv-gitignore-ensure.sh --print\` の定義に書き直されることを確認します。"
    local proj="$BATS_TEST_TMPDIR/p" definition
    definition="$(bash "$ENSURE" --print)"
    mkdir -p "$proj/.pecotv"
    echo "汚染" > "$proj/.pecotv/.gitignore"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj"
    assert_success
    local written
    written="$(read_output "$proj/.pecotv/.gitignore")"
    assert_equal "$written" "$definition"
}

@test "追跡している .gitignore は、書き換えずに差分を残さない" {
    explains "利用者が書いた \`.pecotv/.gitignore\` を commit したリポのテストです。終了コード 0 で終わり、中身が変わらず \`git diff\` に差分が出ないことを確認します。"
    local proj="$BATS_TEST_TMPDIR/p"
    mkdir -p "$proj/.pecotv"
    _git_repo "$proj"
    printf '*\n# local\n' > "$proj/.pecotv/.gitignore"
    _git -C "$proj" add -f .pecotv/.gitignore
    _git -C "$proj" commit -q -m "track gitignore"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj"
    assert_success
    local kept
    kept="$(read_output "$proj/.pecotv/.gitignore")"
    assert_equal "$kept" "$(printf '*\n# local')"
    run _git -C "$proj" diff --quiet
    assert_success
}

# 親ディレクトリの git を拾わないよう GIT_CEILING_DIRECTORIES を付ける。
@test "git の外のディレクトリでは、.gitignore を書き、追跡の案内を出さない" {
    explains "git のリポでないディレクトリに \`.pecotv\` だけがある場合のテストです。終了コード 0 で \`.gitignore\` が作成され、標準出力に \`git add -f\` の案内が出ないことを確認します。"
    local proj="$BATS_TEST_TMPDIR/p"
    mkdir -p "$proj/.pecotv"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj" GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR"
    assert_success
    assert [ -f "$proj/.pecotv/.gitignore" ]
    refute_output --partial 'git add -f .pecotv/.gitignore'
}

@test "CLAUDE_PROJECT_DIR の末尾にスラッシュがあっても、.gitignore を作る" {
    explains "\`CLAUDE_PROJECT_DIR\` を末尾の \`/\` 付きで渡すテストです。終了コード 0 で終わり、\`.pecotv/.gitignore\` が作成されることを確認します。"
    local proj="$BATS_TEST_TMPDIR/p"
    mkdir -p "$proj/.pecotv"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj/"
    assert_success
    assert [ -f "$proj/.pecotv/.gitignore" ]
}

# hookSpecificOutput とトップレベルに同じ additionalContext を入れる。
# Copilot CLI 1.0.103 はトップレベルだけを、Claude Code は hookSpecificOutput だけを読む。
@test "追跡していて * の行が欠けたリポでは、直す手順を JSON 1 個で案内し、index と中身を変えない" {
    explains "\`*\` の行が無い古い \`.gitignore\` を commit したリポのテストです。直す手順が 1 つの JSON の \`additionalContext\` で案内され、index とファイルの中身が変わらないことを確認します。"
    local proj="$BATS_TEST_TMPDIR/p"
    mkdir -p "$proj/.pecotv"
    _git_repo "$proj"
    printf 'tmp/\n' > "$proj/.pecotv/.gitignore"
    _git -C "$proj" add -f .pecotv/.gitignore
    _git -C "$proj" commit -q -m "track old gitignore"
    assert_equal "$(_git -C "$proj" ls-files -- .pecotv/.gitignore)" ".pecotv/.gitignore"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj"
    assert_success
    assert_output --partial -- '--print'
    assert_output --partial 'note: The tracked'
    refute_output --partial 'git add -f .pecotv/.gitignore'
    assert_equal "$(_git -C "$proj" ls-files -- .pecotv/.gitignore)" ".pecotv/.gitignore"
    local kept
    kept="$(read_output "$proj/.pecotv/.gitignore")"
    assert_equal "$kept" "tmp/"
    run jq -e '
        .hookSpecificOutput.hookEventName == "SessionStart"
        and (.hookSpecificOutput.additionalContext | contains("--print"))
        and .additionalContext == .hookSpecificOutput.additionalContext
        and (has("systemMessage") | not)' <<< "$output"
    assert_success
}

@test "追跡していないリポでは追跡の手順を案内し、追跡した後は何も出さない" {
    explains "\`.pecotv/.gitignore\` を追跡していないリポで、案内どおりに commit する前後のテストです。前は \`git add -f\` の案内が出て index が変わらず、後は何も出ずに作業ツリーが clean であることを確認します。"
    local proj="$BATS_TEST_TMPDIR/p"
    mkdir -p "$proj/.pecotv"
    _git_repo "$proj"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj"
    assert_success
    assert_output --partial "note: \`.pecotv/.gitignore\` is not tracked"
    assert_output --partial 'git add -f .pecotv/.gitignore'
    assert_equal "$(_git -C "$proj" ls-files -- .pecotv/.gitignore)" ""

    _git -C "$proj" add -f .pecotv/.gitignore
    _git -C "$proj" commit -q -m "track gitignore"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj"
    assert_success
    refute_output
    assert_equal "$(_git -C "$proj" status --porcelain)" ""
}

@test "hooks-config で追跡の案内を無効にすると、未追跡のリポでも案内を出さない" {
    explains "\`gitignore-track-notice\` を \`false\` にした hooks-config で、未追跡のリポを起動するテストです。終了コード 0 で何も出ず、設定が無い場合は案内が出ることを確認します。"
    local proj="$BATS_TEST_TMPDIR/p" cfg="$BATS_TEST_TMPDIR/hooks-config.json"
    mkdir -p "$proj/.pecotv"
    _git -C "$proj" init -q
    printf '{"gitignore-track-notice": false}\n' > "$cfg"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj" PECOTV_HOOKS_CONFIG_PATH="$cfg"
    assert_success
    refute_output
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj"
    assert_output --partial 'git add -f .pecotv/.gitignore'
}

@test "古い node では、systemMessage と additionalContext に起動しない旨を案内する" {
    explains "起動しない版の案内を返す \`node\` のスタブで起動するテストです。終了コード 0 で、\`systemMessage\` と 2 つの \`additionalContext\` に同じ案内が入ることを確認します。"
    local proj="$BATS_TEST_TMPDIR/p"
    mkdir -p "$proj"
    make_node_stubs
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj" PATH="$STUB_BLOCK:$PATH"
    assert_success
    assert_equal "$(jq -r '.additionalContext' <<< "$output")" "$NODE_OLD_MESSAGE"
    assert_equal "$(jq -r '.systemMessage' <<< "$output")" "$NODE_OLD_MESSAGE"
    assert_equal "$(jq -r '.hookSpecificOutput.hookEventName' <<< "$output")" "SessionStart"
    assert_equal "$(jq -r '.hookSpecificOutput.additionalContext' <<< "$output")" "$NODE_OLD_MESSAGE"
}

@test "node の案内とほかの案内は、1 個の JSON の additionalContext に束ねる" {
    explains "古い \`node\` のスタブで、追跡していないリポを起動するテストです。node の案内と \`git add -f\` の案内が、1 つの JSON の \`additionalContext\` にまとまることを確認します。"
    local proj="$BATS_TEST_TMPDIR/p"
    mkdir -p "$proj/.pecotv"
    _git -C "$proj" init -q
    make_node_stubs
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj" PATH="$STUB_BLOCK:$PATH"
    run jq -e '.hookSpecificOutput.additionalContext | contains("git add -f .pecotv/.gitignore") and contains("Node.js 0.0.0")' <<< "$output"
    assert_success
}

@test "許可する版の node では、何も出さずに 0 で終わる" {
    explains "何も出力しない \`node\` のスタブで起動するテストです。許可する版の場合に、終了コード 0 で標準出力が空であることを確認します。"
    local proj="$BATS_TEST_TMPDIR/p"
    mkdir -p "$proj"
    make_node_stubs
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj" PATH="$STUB_OK:$PATH"
    assert_success
    refute_output
}

@test "hooks-config で node の案内を無効にすると、古い node でも何も出さない" {
    explains "\`node-runtime-notice\` を \`false\` にした hooks-config で、古い \`node\` のスタブを使って起動するテストです。終了コード 0 で標準出力が空であることを確認します。"
    local proj="$BATS_TEST_TMPDIR/p" cfg="$BATS_TEST_TMPDIR/hooks-config.json"
    mkdir -p "$proj"
    make_node_stubs
    printf '{"node-runtime-notice": false}\n' > "$cfg"
    run_attached --separate-stderr _run_hook CLAUDE_PROJECT_DIR="$proj" PECOTV_HOOKS_CONFIG_PATH="$cfg" PATH="$STUB_BLOCK:$PATH"
    assert_success
    refute_output
}
