#!/usr/bin/env bats
# publish-mcp-dist.sh（pecot-tools MCP サーバの tgz 化と Release への添付）の検証 (#1056)。gh は偽物に差し替え、GitHub と registry へ書き込まない。
# 前提は build 済みの cli/dist。重い dry-run・smoke・本実行は setup_file で 1 回だけ動かし、@test はその出力を確かめる。

bats_require_minimum_version 1.5.0

RELEASE_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd -P)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd -P)"
TOOLS_ROOT="$REPO_ROOT/plugins/pecot-tools"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"
FAKE_AWS_DIR="$TOOLS_ROOT/cli/tests/_fixtures/fake-aws"
# gh の -R は origin の URL から求める。合成した owner/name の URL を置く。
TEST_SLUG="acme-labs/example-repo"
# tools/list の期待値は契約書の表（24 件・先頭 aws_sso_login）。配布ツリーから TS ソースを引けないので写している。
EXPECTED_TOOL_COUNT=24
EXPECTED_FIRST_TOOL="aws_sso_login"

# setup_file が作り、@test が読むもの。@test はここへ書き込まない。
SF="$BATS_FILE_TMPDIR"
DIST="$SF/dist"
TEST_REPO="$SF/repo"
TEST_REPO_2="$SF/repo-v2"
TEST_TOOLS_PATH="plugins/pecot-tools"
SMOKE_MJS="$SF/smoke.mjs"
SMOKE_BIN="$SF/smoke-install/node_modules/.bin/pecot-tools-mcp"

setup_file() {
    # git hook 経由で GIT_DIR 等が export されていると、リポ本体の index を書き換えるので捨てる。
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
    # 継承した NX_DRY_RUN は、非 dry-run の検証まで dry-run にする。
    unset NX_DRY_RUN GH_STUB_NO_RELEASE
    # 並べた publish の `git status` が、使い捨てリポの index.lock を取り合わないようにする。
    export GIT_OPTIONAL_LOCKS=0
    export GIT_AUTHOR_NAME="pecot-tools release test" GIT_AUTHOR_EMAIL="pecot-tools-release-test@example.invalid"
    export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

    # build 済み dist の存在を先に確かめる（無いと publish が途中で落ち、原因が分からない出力になる）。
    if [ ! -d "$TOOLS_ROOT/cli/dist" ]; then
        echo "ERROR: $TOOLS_ROOT/cli/dist がありません。build 済みの dist が前提です。" >&2
        echo "  bash plugins/pecot-tools/scripts/ci/run-tests.sh --scope=release" >&2
        return 1
    fi

    PLUGIN_VERSION="$(node -e "process.stdout.write(require('$TOOLS_ROOT/.claude-plugin/plugin.json').version)")"
    TEST_VERSION="0.0.0-test$$"
    TEST_VERSION_2="0.0.0-test$$-2"
    TEST_TAG="pecot-tools-v$TEST_VERSION"
    TEST_TAG_2="pecot-tools-v$TEST_VERSION_2"
    # 非 dry-run の実行は opt-in を拒否するので、偽 npm が install にだけ永続キャッシュを足す。
    REAL_NPM="$(command -v npm)"
    NPM_PERSIST_CACHE="${PECOT_RELEASE_TEST_NPM_CACHE:-$SF/npm-persist-cache}"
    export PLUGIN_VERSION TEST_VERSION TEST_VERSION_2 TEST_TAG TEST_TAG_2 REAL_NPM NPM_PERSIST_CACHE

    # 偽 gh は引数を GH_STUB_DIR/calls.log に 1 行ずつ記録し、upload された tgz を GH_STUB_DIR に写す。
    export GH_STUB_DIR="$SF/gh-setup"
    mkdir -p "$SF/bin" "$SF/npmbin" "$GH_STUB_DIR"
    cat > "$SF/bin/gh" << 'STUB_GH'
#!/bin/bash
printf '%s\n' "$*" >> "$GH_STUB_DIR/calls.log"
case "$1 $2" in
    "release view")
        if [ "${GH_STUB_NO_RELEASE:-}" = 1 ]; then
            echo "release not found" >&2
            exit 1
        fi
        ;;
    "release upload")
        cp "$4" "$GH_STUB_DIR/uploaded.tgz"
        ;;
esac
exit 0
STUB_GH
    cat > "$SF/npmbin/npm" << 'STUB_NPM'
#!/bin/bash
case "$1" in
    install) exec "$REAL_NPM" "$@" "--cache=$NPM_PERSIST_CACHE" --prefer-offline ;;
esac
exec "$REAL_NPM" "$@"
STUB_NPM
    chmod +x "$SF/bin/gh" "$SF/npmbin/npm"
    export PATH="$SF/bin:$PATH"

    make_test_repo
    make_bumped_repo
    write_smoke_mjs

    # 3 つの流れは互いの gh の記録・構築先・リポを使わないので、同時に動かす。
    local dryrun_pid publish_pid bump_pid dryrun_rc=0
    run_dryrun_chain 3>&- &
    dryrun_pid=$!
    run_publish_chain 3>&- &
    publish_pid=$!
    run_bump_chain 3>&- &
    bump_pid=$!
    wait "$publish_pid"
    wait "$bump_pid"
    wait "$dryrun_pid" || dryrun_rc=$?
    [ "$dryrun_rc" -eq 0 ] || return 1
}

setup() {
    bats_load_library pecot-bats
    T="$BATS_TEST_TMPDIR"
    export GH_STUB_DIR="$T/gh"
    mkdir -p "$GH_STUB_DIR"
    : > "$GH_STUB_DIR/calls.log"
}

# タグは worktree 間で共有されるので本体に作らず、作業ツリーから組んだ使い捨てリポの中に立てる。
make_test_repo() {
    local test_tools="$TEST_REPO/$TEST_TOOLS_PATH"
    mkdir -p "$TEST_REPO"
    git init --quiet --initial-branch=main "$TEST_REPO"
    git -C "$TEST_REPO" remote add origin "https://github.com/$TEST_SLUG.git"
    # git 管理の入力を ls-files で写す。publish は pnpm を解決するため scripts/ci/pnpm-lib.sh を source する。
    (cd "$REPO_ROOT" && git ls-files -z -- \
        plugins/pecot-tools/.claude-plugin \
        plugins/pecot-tools/scripts/ci/pnpm-lib.sh \
        plugins/pecot-tools/package.json \
        plugins/pecot-tools/cli/package.json \
        plugins/pecot-tools/scripts/release \
        LICENSE \
        | tar --null -T - -cf -) | tar -xf - -C "$TEST_REPO"
    # ls-files は未追跡ファイルを落とすので、scripts/release と共通スクリプトは作業ツリーから置く。
    rm -rf "$test_tools/scripts/release"
    cp -a "$TOOLS_ROOT/scripts/release" "$test_tools/scripts/release"
    mkdir -p "$TEST_REPO/.githooks/scripts" "$TEST_REPO/.githooks/lib"
    cp -a "$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "$REPO_ROOT/.githooks/scripts/origin-slug.mjs" "$TEST_REPO/.githooks/scripts/"
    cp -a "$REPO_ROOT/.githooks/lib/mcp-publish-common.sh" "$TEST_REPO/.githooks/lib/"
    # git 管理外の build 生成物は実体を持ち込む。
    cp -a "$TOOLS_ROOT/cli/dist" "$test_tools/cli/dist"
    git -C "$TEST_REPO" add -A > /dev/null 2>&1
    git -C "$TEST_REPO" commit --quiet -m "test fixture" > /dev/null 2>&1
    git -C "$TEST_REPO" tag "$TEST_TAG" HEAD
}

# 版が上がる publish 用に、使い捨てリポの写しで plugin.json の版を上げた commit とタグを作る。
make_bumped_repo() {
    cp -a "$TEST_REPO" "$TEST_REPO_2"
    node -e "
const fs = require('node:fs')
const file = process.argv[1]
const m = JSON.parse(fs.readFileSync(file, 'utf8'))
m.version = process.argv[2]
fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n')
" "$TEST_REPO_2/$TEST_TOOLS_PATH/.claude-plugin/plugin.json" "$TEST_VERSION_2"
    git -C "$TEST_REPO_2" add -A > /dev/null 2>&1
    git -C "$TEST_REPO_2" commit --quiet -m "test fixture v2" > /dev/null 2>&1
    git -C "$TEST_REPO_2" tag "$TEST_TAG_2" HEAD
}

# node smoke.mjs <command> [args...]: MCP サーバに initialize / tools/list（と SMOKE_TOOL_CALLS）を送り、要約を 1 行 JSON で返す。
write_smoke_mjs() {
    cat > "$SMOKE_MJS" << 'SMOKE'
// command はそのまま実行する。起動そのものに失敗したときだけ `FAIL: <理由>` を返す。
import { spawn } from 'node:child_process'

const command = process.argv.slice(2)
const TIMEOUT_MS = 120_000
const CALLS = process.env['SMOKE_TOOL_CALLS'] === undefined
  ? []
  : JSON.parse(process.env['SMOKE_TOOL_CALLS'])
const CALL_ID_BASE = 100
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ...CALLS.map((call, index) => ({ jsonrpc: '2.0', id: CALL_ID_BASE + index, method: 'tools/call', params: call }))
]
const expected = requests.filter((message) => message.id !== undefined).map((message) => message.id)

const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
const seen = new Map()
let stderr = ''
let buffer = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr += chunk })
child.stdout.setEncoding('utf8')

const pending = () => expected.filter((id) => !seen.has(id)).join(',')

const settled = new Promise((resolve) => {
  const finish = (result) => { clearTimeout(timer); resolve(result) }
  const timer = setTimeout(() => finish({ ok: false, reason: `timeout (未応答 id: ${pending()})` }), TIMEOUT_MS)
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      let message
      try { message = JSON.parse(line) } catch { return finish({ ok: false, reason: `stdout が JSON-RPC でない: ${line.slice(0, 200)}` }) }
      if (message.id !== undefined) seen.set(message.id, message)
      if (expected.every((id) => seen.has(id))) finish({ ok: true })
    }
  })
  child.on('error', (error) => finish({ ok: false, reason: `起動失敗: ${error.message}` }))
  child.on('exit', (code) => finish({ ok: false, reason: `応答前に終了 (code=${code}, 未応答 id: ${pending()})` }))
})

for (const message of requests) child.stdin.write(`${JSON.stringify(message)}\n`)

const result = await settled
child.kill('SIGKILL')

if (!result.ok) {
  process.stdout.write(`FAIL: ${result.reason} :: ${stderr.slice(-400).replaceAll('\n', ' ')}`)
  process.exit(1)
}

const listed = seen.get(2)
if (listed?.error !== undefined) {
  process.stdout.write(JSON.stringify({ error: String(listed.error.message ?? '') }))
  process.exit(0)
}
const tools = listed?.result?.tools ?? []
const calls = CALLS.map((_, index) => {
  const response = seen.get(CALL_ID_BASE + index)
  const structured = response?.result?.structuredContent ?? {}
  return { isError: response === undefined ? null : response.result?.isError ?? false, kind: structured.kind ?? null }
})
const initialized = seen.get(1)
process.stdout.write(JSON.stringify({
  toolCount: tools.length,
  firstTool: tools[0]?.name ?? '',
  toolNames: tools.map((tool) => tool.name),
  serverName: initialized?.result?.serverInfo?.name ?? '',
  calls
}))
SMOKE
}

# 非 dry-run の publish を起動する。opt-in を拒否するので外し、永続キャッシュを足す偽 npm を PATH の先頭に置く。
publish_real() {
    env -u PECOT_RELEASE_TEST_NPM_CACHE PATH="$SF/npmbin:$PATH" "$@"
}

# 流れ A: dry-run で配布ツリーを作り、NX_DRY_RUN の dry-run、tgz の npm install、smoke まで進める。配布ツリーを作れなければ 1 で終わる。
run_dryrun_chain() {
    local rc=0
    export GH_STUB_DIR="$SF/gh-dryrun"
    mkdir -p "$GH_STUB_DIR"
    : > "$GH_STUB_DIR/calls.log"
    if ! bash "$PUBLISH" --dry-run --skip-build --out-dir="$DIST" > "$SF/dryrun.txt" 2>&1; then
        echo "dry-run が失敗しました" >&2
        cat "$SF/dryrun.txt" >&2
        return 1
    fi
    GH_STUB_DIR="$SF/gh-nxdryrun"
    mkdir -p "$GH_STUB_DIR"
    : > "$GH_STUB_DIR/calls.log"
    NX_DRY_RUN=1 bash "$PUBLISH" --skip-build --out-dir="$SF/dist-nx-dry-run" > "$SF/nxdryrun.txt" 2>&1 || rc=$?
    echo "$rc" > "$SF/nxdryrun.rc"

    # 配布ツリーの tgz を npm install し、bin-links が張った node_modules/.bin から起動する。npm はリポの外で打つ。
    local smoke_root="$SF/smoke-install" tgz_name
    mkdir -p "$SF/smoke-pack" "$smoke_root"
    printf '{"private":true}\n' > "$smoke_root/package.json"
    tgz_name="$(cd "$SF" && "$REAL_NPM" pack "$DIST" --ignore-scripts --pack-destination "$SF/smoke-pack" 2> "$SF/smoke-pack-stderr.txt" | tail -n 1)"
    rc=0
    if [ -n "$tgz_name" ]; then
        (cd "$smoke_root" && "$REAL_NPM" install "$SF/smoke-pack/$tgz_name" \
            --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1 \
            "--cache=$NPM_PERSIST_CACHE" --prefer-offline) > "$SF/smoke-install.txt" 2>&1 || rc=$?
    else
        rc=1
    fi
    echo "$rc" > "$SF/smoke-install.rc"

    # 登録例と同じ引数なしの起動、`mcp` を付けた起動、偽 awscli への tools/call を同時に流す。
    node "$SMOKE_MJS" "$SMOKE_BIN" > "$SF/smoke-default.json" 2> "$SF/smoke-default-stderr.txt" &
    node "$SMOKE_MJS" "$SMOKE_BIN" mcp > "$SF/smoke-mcp.json" 2> "$SF/smoke-mcp-stderr.txt" &
    SMOKE_TOOL_CALLS='[{"name":"aws_s3_ls","arguments":{}},{"name":"aws_athena_start_query_execution","arguments":{"query_string":"DROP TABLE orders"}}]' \
        PATH="$FAKE_AWS_DIR:$PATH" FAKE_AWS_FIXTURE_DIR="$FAKE_AWS_DIR/fixtures" \
        node "$SMOKE_MJS" "$SMOKE_BIN" > "$SF/smoke-calls.json" 2> "$SF/smoke-calls-stderr.txt" &
    wait
    return 0
}

# 流れ B: タグのある使い捨てリポで本実行を 2 回（初回と同じ版の再実行）動かす。終了コードはファイルに残す。
run_publish_chain() {
    local rc=0
    export GH_STUB_DIR="$SF/gh-publish1"
    mkdir -p "$GH_STUB_DIR"
    : > "$GH_STUB_DIR/calls.log"
    publish_real bash "$TEST_REPO/$TEST_TOOLS_PATH/scripts/release/publish-mcp-dist.sh" --version="$TEST_VERSION" --skip-build \
        --out-dir="$SF/dist-1" > "$SF/publish1.txt" 2>&1 || rc=$?
    echo "$rc" > "$SF/publish1.rc"
    GH_STUB_DIR="$SF/gh-publish2"
    mkdir -p "$GH_STUB_DIR"
    : > "$GH_STUB_DIR/calls.log"
    rc=0
    publish_real bash "$TEST_REPO/$TEST_TOOLS_PATH/scripts/release/publish-mcp-dist.sh" --version="$TEST_VERSION" --skip-build \
        --out-dir="$SF/dist-2" > "$SF/publish2.txt" 2>&1 || rc=$?
    echo "$rc" > "$SF/publish2.rc"
}

# 流れ C: 版を上げたリポで本実行を動かす。
run_bump_chain() {
    local rc=0
    export GH_STUB_DIR="$SF/gh-publish3"
    mkdir -p "$GH_STUB_DIR"
    : > "$GH_STUB_DIR/calls.log"
    publish_real bash "$TEST_REPO_2/$TEST_TOOLS_PATH/scripts/release/publish-mcp-dist.sh" --version="$TEST_VERSION_2" --skip-build \
        --out-dir="$SF/dist-3" > "$SF/publish3.txt" 2>&1 || rc=$?
    echo "$rc" > "$SF/publish3.rc"
}

# 流れの終了コードを読んで添付し、値を返す。
read_rc() {
    local value
    value="$(read_output "$1")" || return 1
    printf '%s' "$value"
}

# gh の呼び出しの記録（$1 の GH_STUB_DIR、省略時は @test の記録）を読んで添付し、中身を gh_log、行数を gh_count に置く。
read_gh_log() {
    local dir="${1:-$GH_STUB_DIR}"
    gh_log="$(read_output "$dir/calls.log")"
    gh_count="$(printf '%s' "$gh_log" | grep -c '' || true)"
}

# 配布ツリーの package.json から 1 項目を取り出す。
read_manifest() {
    node -e "
const m = require('$DIST/package.json')
const q = process.argv[1]
if (q === 'version') process.stdout.write(m.version)
else if (q === 'name') process.stdout.write(m.name)
else if (q === 'bin') process.stdout.write(JSON.stringify(m.bin))
else if (q === 'license') process.stdout.write(m.license)
else if (q === 'repository') process.stdout.write(JSON.stringify(m.repository))
else if (q === 'engines') process.stdout.write(Object.keys(m.engines).sort().join(','))
else if (q === 'hasDevEngines') process.stdout.write(String('devEngines' in m))
else if (q === 'deps') process.stdout.write(Object.keys(m.dependencies).sort().join(','))
else if (q === 'hasScripts') process.stdout.write(String('scripts' in m))
" "$1"
}

# smoke 結果（1 行 JSON）から 1 項目を取り出す。無ければ空文字。
smoke_value() {
    node -e "
const fs = require('node:fs')
let value
try { value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')) }
catch { process.stdout.write('PARSE_ERROR'); process.exit(0) }
value = value[process.argv[2]]
process.stdout.write(value === undefined ? '' : String(value))
" "$1" "$2"
}

# smoke 結果の calls[$2] の $3（isError か kind）を取り出す。
call_value() {
    node -e "
const fs = require('node:fs')
let value
try { value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')) }
catch { process.stdout.write('PARSE_ERROR'); process.exit(0) }
const call = (value.calls ?? [])[Number(process.argv[2])]
const field = call === undefined ? undefined : call[process.argv[3]]
process.stdout.write(field === undefined || field === null ? '' : String(field))
" "$1" "$2" "$3"
}

# smoke（$1 = 結果）が MCP サーバとして起動しなかったか、tools/list がエラーを返したら、理由を添えてテストを落とす。
smoke_must_answer() {
    local head result error stderr_tail
    attach_file "$1"
    head="$(head -c 5 "$1" 2> /dev/null)"
    result="$(cat "$1" 2> /dev/null)"
    stderr_tail="$(tail -n 3 "${1%.json}-stderr.txt" | tr '\n' ' ')"
    case "$head" in
        FAIL:) fail "配布ツリーが MCP サーバとして起動しない: $result" ;;
        '') fail "smoke が何も出力しなかった: $stderr_tail" ;;
    esac
    error="$(smoke_value "$1" error)"
    [ -z "$error" ] || fail "tools/list がエラーを返した (error.message: $error)"
}

# 添付された tgz（$1）の package.json から 1 項目を取り出す。
tgz_manifest() {
    tar -xzOf "$1" package/package.json 2> /dev/null | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8'))[process.argv[1]]))" "$2"
}

# 使い捨てリポを @test の一時ディレクトリに写す。origin と作業ツリーを書き換える確かめは、この写しで動かす。
copy_test_repo() {
    cp -a "$TEST_REPO" "$T/repo"
    echo "$T/repo/$TEST_TOOLS_PATH/scripts/release/publish-mcp-dist.sh"
}

# --out-dir のガードで止まることを確かめる。
reject_out_dir() {
    run_attached bash "$PUBLISH" --dry-run --skip-build --out-dir="$1"
    assert_failure
}

# --- 1. dry-run で配布ツリーを構築する ---

@test "dry-run は、gh を呼ばずに、実行予定の gh コマンドと tgz の名前・中身を表示する" {
    explains '`--dry-run` で配布ツリーを構築するテストです。正常終了し、`gh` を呼ばずに予定の `gh` コマンドと tgz の名前・中身を表示し、中身にソースマップと証明書が無いことを確認します。'
    local log="$SF/dryrun.txt"
    run read_output "$log"
    assert_success
    assert_output --partial "dry-run=true"
    assert_output --partial "dry-run のため gh は実行しません"
    assert_output --partial "tgz: pecot-tools-mcp-$PLUGIN_VERSION.tgz"
    assert_line "    LICENSE"
    assert_equal "$(grep -E '^    ' "$log" | grep -E '\.map$|cert' | tr '\n' ' ')" ""
    grep -qE "gh release upload pecot-tools-v$PLUGIN_VERSION pecot-tools-mcp-$PLUGIN_VERSION.tgz --clobber -R [^ /]+/[^ /]+\$" "$log" \
        || fail "gh release upload の表示が無い"
    grep -qE "gh workflow run publish-npm.yml -f tag=pecot-tools-v$PLUGIN_VERSION --ref pecot-tools-v$PLUGIN_VERSION -R [^ /]+/[^ /]+\$" "$log" \
        || fail "gh workflow run の表示が無い"
    # dry-run の表示は、タグの版が nx の上げる前の値であることを添える。
    assert_output --partial "版は version の段階より前の値です"
    read_gh_log "$SF/gh-dryrun"
    assert_equal "$gh_count" 0
}

@test "NX_DRY_RUN=1 だけを渡しても、dry-run として gh を呼ばずに終わる" {
    explains '`--dry-run` を付けずに環境変数 `NX_DRY_RUN=1` だけで publish を動かすテストです。nx が引数を渡さない本番の起動でも、正常終了して dry-run と表示し、`gh` を呼ばないことを確認します。'
    assert_equal "$(read_rc "$SF/nxdryrun.rc")" 0
    run read_output "$SF/nxdryrun.txt"
    assert_success
    assert_output --partial "dry-run=true"
    assert_output --partial "dry-run のため gh は実行しません"
    read_gh_log "$SF/gh-nxdryrun"
    assert_equal "$gh_count" 0
}

@test "未対応の引数の --dryRun=true と廃止した --repo を渡すと、非ゼロで終了する" {
    explains 'nx の `forwardAllArgs` が注入する `--dryRun=true` と、廃止した配布先の上書き `--repo` を渡して publish を動かすテストです。どちらも未対応の引数として、非ゼロで終了することを確認します。'
    run_attached bash "$PUBLISH" --dryRun=true --skip-build --out-dir="$T/dist-badflag"
    assert_failure
    run_attached bash "$PUBLISH" --dry-run --skip-build --repo=acme-labs/example-repo --out-dir="$T/dist-repoflag"
    assert_failure
}

# --- 2. 配布ツリーの中身 ---

@test "生成する package.json が、公開名・プラグイン版・bin・license・repository を持ち、engines を node だけにする" {
    explains 'dry-run で作った配布ツリーの `package.json` のテストです。公開名・プラグイン版・起動ファイル・公開リポを持ち、`engines` が node だけで、`devEngines` と `scripts` を持たないことを確認します。'
    attach_file "$DIST/package.json"
    assert_equal "$(read_manifest name)" "@pecot/tools-mcp"
    assert_equal "$(read_manifest version)" "$PLUGIN_VERSION"
    assert_equal "$(read_manifest bin)" '{"pecot-tools-mcp":"cli/dist/main.js"}'
    assert_equal "$(read_manifest license)" "MIT"
    assert_equal "$(read_manifest repository)" '{"type":"git","url":"git+https://github.com/pecotcraft/pecot.git","directory":"plugins/pecot-tools"}'
    assert_equal "$(read_manifest engines)" "node"
    # devEngines に pnpm を写すと、npm が EBADDEVENGINES で止まり、npx 自身が起動しない。
    assert_equal "$(read_manifest hasDevEngines)" "false"
    assert_equal "$(read_manifest hasScripts)" "false"
}

@test "配布 package.json の依存が、cli/package.json の dependencies と一致し、commander を含まない" {
    explains '配布ツリーの `package.json` の依存のテストです。`cli/package.json` の `dependencies` と同じ名前の集合で、引数の解釈に使う `commander` を含まないことを確認します。'
    local deps cli_deps
    attach_file "$DIST/package.json"
    deps="$(read_manifest deps)"
    cli_deps="$(node -e "process.stdout.write(Object.keys(require('$TOOLS_ROOT/cli/package.json').dependencies).sort().join(','))")"
    assert_equal "$deps" "$cli_deps"
    # サーバは引数を読まないので、引数の解釈の commander は配布物に要らない。
    if printf ',%s,' "$deps" | grep -qF ',commander,'; then
        fail "commander がある"
    fi
}

@test "cli/dist の bare import が、すべて配布 package.json で宣言されている" {
    explains '配布ツリーの `cli/dist` の JS が読む bare import のテストです。npm の hoisting を当てにせず解決できるよう、すべてが配布 `package.json` で宣言され、走査が 1 件以上を検出することを確認します。'
    local scan
    attach_file "$DIST/package.json"
    scan="$(node -e "
const fs = require('node:fs'), path = require('node:path')
const [dist] = process.argv.slice(1)
const walk = (dir) => fs.readdirSync(dir).flatMap((entry) => {
  const child = path.join(dir, entry)
  return fs.statSync(child).isDirectory() ? walk(child) : [child]
})
const declared = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(dist, 'package.json'), 'utf8')).dependencies))
const packageOf = (specifier) => {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}
const missing = new Set()
let matchCount = 0
for (const file of walk(path.join(dist, 'cli/dist'))) {
  if (!file.endsWith('.js')) continue
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*(['\"])([^'\"]+)\1/g)) {
    matchCount++
    const specifier = match[2]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    const name = packageOf(specifier)
    if (!declared.has(name)) missing.add(name)
  }
}
process.stdout.write(JSON.stringify({ missing: [...missing].sort(), matchCount }))
" "$DIST")"
    assert_equal "$(node -e "process.stdout.write(JSON.parse(process.argv[1]).missing.join(','))" "$scan")" ""
    # 走査 0 件での無条件 pass を防ぐ。
    local matched
    matched="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).matchCount))" "$scan")"
    [ "$matched" -ge 1 ] || fail "走査が 0 件になった。正規表現が無効化されている疑い (matchCount=$matched)"
}

@test "npm-shrinkwrap.json が lockfileVersion 3 で生成され、plugin.json が実版を持つ" {
    explains '配布ツリーの `npm-shrinkwrap.json` と `.claude-plugin/plugin.json` のテストです。shrinkwrap が `lockfileVersion` 3 で生成され、`plugin.json` がプラグインの実版を持つことを確認します。'
    attach_file "$DIST/npm-shrinkwrap.json"
    attach_file "$DIST/.claude-plugin/plugin.json"
    assert_equal "$(node -e "process.stdout.write(String(require('$DIST/npm-shrinkwrap.json').lockfileVersion))" 2> /dev/null)" "3"
    assert_equal "$(node -e "process.stdout.write(require('$DIST/.claude-plugin/plugin.json').version)" 2> /dev/null)" "$PLUGIN_VERSION"
}

@test "配布ツリーが、MCP サーバの起動に要る cli/dist のファイルとルートの LICENSE を持ち、.gitignore・ソースマップ・証明書を含まない" {
    explains '配布ツリーのファイルの構成のテストです。起動に要る `cli/dist` の 4 つのファイルとルートと同じ `LICENSE` を持ち、`.gitignore` とソースマップと証明書を含まないことを確認します。'
    local entry
    find "$DIST" -path "$DIST/node_modules" -prune -o -print | sed "s|^$DIST/||" | LC_ALL=C sort > "$T/dist-files.txt"
    attach_file "$T/dist-files.txt"
    for entry in main.js package.json infra/sso/login-registry.js mcp/tools/sso.js; do
        [ -f "$DIST/cli/dist/$entry" ] || fail "cli/dist/$entry が配布ツリーに無い"
    done
    assert_equal "$(find "$DIST" -name '.gitignore' | wc -l | tr -d ' ')" 0
    # ソースマップは npm の配布物に入れない（spec 018 US4）。
    assert_equal "$(find "$DIST" -name '*.map' -type f | wc -l | tr -d ' ')" 0
    # MIT は許諾表示の同梱を条件にする。
    cmp -s "$REPO_ROOT/LICENSE" "$DIST/LICENSE" || fail "LICENSE が無いか、ルートの LICENSE と違う"
    assert_equal "$(find "$DIST" -iname '*cert*' | wc -l | tr -d ' ')" 0
}

# --- 3. README の登録例 ---

@test "README の登録例が、公開名・--prefix=/・サーバ名 pecot-tools を使い、git の URL とプレースホルダを残さない" {
    explains '配布ツリーの `README.md` の登録例のテストです。npx の登録例が `--prefix=/` 付きで公開名を指し、サーバ名が `pecot-tools` で、git の URL と未置換のプレースホルダが無いことを確認します。'
    local readme
    readme="$(read_output "$DIST/README.md")"
    assert_equal "$(grep -c 'git+' <<< "$readme" || true)" 0
    # プレースホルダの名前は固定せず、`__` で囲んだ語が未置換で残っていないことを見る。
    assert_equal "$(grep -cE '__[A-Za-z0-9_]+__' <<< "$readme" || true)" 0
    # 2 件 = npx 起動の登録例 + WSL 経由の登録例（bash -lc の行は引用符が付かず対象外）。
    assert_equal "$(grep -cF '"--prefix=/", "@pecot/tools-mcp"]' <<< "$readme" || true)" 2
    # --package= で渡すと子に npm_config_package が残り、子の npx が別のパッケージを実行する。
    assert_equal "$(grep -cF -- '--package=@' <<< "$readme" || true)" 0
    assert_equal "$(grep -cF 'npx -y --prefix=/ @pecot/tools-mcp' <<< "$readme" || true)" 1
    # 3 件 = npx 起動 + 事前インストール後の直接起動 + WSL 経由。
    assert_equal "$(grep -cF '"pecot-tools":' <<< "$readme" || true)" 3
}

# --- 4. 配布物の起動 smoke ---

@test "配布物の tgz を npm install すると、実行できる node_modules/.bin/pecot-tools-mcp を張る" {
    explains '配布ツリーを `npm pack` した tgz を、リポの外で `npm install` するテストです。導入が成功し、`node_modules/.bin/pecot-tools-mcp` が実行できる形で張られることを確認します。'
    attach_file "$SF/smoke-pack-stderr.txt"
    attach_file "$SF/smoke-install.txt"
    assert_equal "$(read_rc "$SF/smoke-install.rc")" 0
    # tsc の出力は実行権を持たない。実行権は npm の bin-links が導入時に付ける。
    [ -x "$SMOKE_BIN" ] || fail "node_modules/.bin/pecot-tools-mcp が無いか、実行できない"
}

@test "引数なしと mcp を付けた起動のどちらでも、tools/list が契約表の 24 件を契約表の順で返す" {
    explains '導入した `pecot-tools-mcp` を、登録例と同じ引数なしと `mcp` を付けた形で起動するテストです。どちらも MCP サーバとして応答し、`tools/list` が契約表の 24 件を契約表の順で返すことを確認します。'
    local out
    for out in "$SF/smoke-default.json" "$SF/smoke-mcp.json"; do
        smoke_must_answer "$out"
        assert_equal "$(smoke_value "$out" toolCount)" "$EXPECTED_TOOL_COUNT"
        assert_equal "$(smoke_value "$out" firstTool)" "$EXPECTED_FIRST_TOOL"
    done
}

@test "README のツール表と登録名が、tools/list の名前の並びと initialize の serverInfo.name と一致する" {
    explains '配布ツリーの `README.md` と、起動した MCP サーバの応答を比べるテストです。ツール表の名前が `tools/list` の並びと一致し、登録例のサーバ名が `initialize` の `serverInfo.name` と一致することを確認します。'
    local readme names
    smoke_must_answer "$SF/smoke-default.json"
    readme="$(read_output "$DIST/README.md")"
    names="$(grep -oE '^\| `aws_[A-Za-z0-9_]+`' <<< "$readme" | sed -E 's/^\| `//; s/`$//' | paste -sd, -)"
    assert_equal "$(smoke_value "$SF/smoke-default.json" toolNames)" "$names"
    assert_equal "$(smoke_value "$SF/smoke-default.json" serverName)" "pecot-tools"
}

@test "配布ツリーへの tools/call で、読み取りは成功し、DROP TABLE は not-allowed で拒否される" {
    explains '偽の awscli を置いて、導入した MCP サーバへ `tools/call` を送るテストです。`cli/dist` の外を読まずに、`aws_s3_ls` が成功し、Athena の `DROP TABLE` が `not-allowed` で拒否されることを確認します。'
    local out="$SF/smoke-calls.json"
    smoke_must_answer "$out"
    assert_equal "$(call_value "$out" 0 isError)" "false"
    assert_equal "$(call_value "$out" 1 isError)" "true"
    assert_equal "$(call_value "$out" 1 kind)" "not-allowed"
}

# --- 5. 冪等性の確認と Release への添付 ---

@test "HEAD にリリースタグが無いと、gh を呼ばず配布ツリーも作らずに正常終了する" {
    explains 'HEAD にリリースタグの無いリポジトリ本体で、版を指定した本実行の publish を動かすテストです。スキップを表示して正常終了し、配布ツリーを作らず、`gh` を呼ばないことを確認します。'
    run_attached publish_real bash "$PUBLISH" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-gate"
    assert_success
    assert_output --partial "スキップ"
    [ ! -d "$T/dist-gate" ] || fail "タグが無いのに配布ツリーを作った"
    read_gh_log
    assert_equal "$gh_count" 0
}

@test "タグがあると、gh で tgz を Release に添えてワークフローを起動する" {
    explains 'HEAD にリリースタグのある使い捨てリポで、本実行の publish を動かすテストです。正常終了し、`gh` を `release view`・`release upload`・`workflow run` の順に、origin の owner/name を `-R` に付けて呼ぶことを確認します。'
    assert_equal "$(read_rc "$SF/publish1.rc")" 0
    run read_output "$SF/publish1.txt"
    assert_success
    assert_output --partial "tgz: pecot-tools-mcp-$TEST_VERSION.tgz"
    read_gh_log "$SF/gh-publish1"
    assert_equal "$gh_count" 3
    assert_equal "$(sed -n 1p <<< "$gh_log")" "release view $TEST_TAG -R $TEST_SLUG"
    local upload
    upload="$(sed -n 2p <<< "$gh_log")"
    case "$upload" in
        "release upload $TEST_TAG "*"/pecot-tools-mcp-$TEST_VERSION.tgz --clobber -R $TEST_SLUG") ;;
        *) fail "2 番目の gh の引数が期待と違う: $upload" ;;
    esac
    assert_equal "$(sed -n 3p <<< "$gh_log")" "workflow run publish-npm.yml -f tag=$TEST_TAG --ref $TEST_TAG -R $TEST_SLUG"
}

@test "Release に添えた tgz が、配布に要るファイルを持ち、ソース・node_modules・ソースマップ・証明書を含まない" {
    explains '本実行の publish が `gh release upload` に渡した tgz の中身のテストです。公開名と版の `package.json` と配布に要る 6 つのファイルを持ち、ソースと `node_modules` とソースマップと証明書を含まないことを確認します。'
    local tgz="$SF/gh-publish1/uploaded.tgz" tree entry excluded
    [ -f "$tgz" ] || fail "upload された tgz が無い"
    assert_equal "$(tgz_manifest "$tgz" name)" "@pecot/tools-mcp"
    assert_equal "$(tgz_manifest "$tgz" version)" "$TEST_VERSION"
    tar -tzf "$tgz" > "$T/tgz-list.txt" 2> /dev/null
    tree="$(read_output "$T/tgz-list.txt")"
    for entry in package/package.json package/npm-shrinkwrap.json package/README.md package/LICENSE \
        package/.claude-plugin/plugin.json package/cli/dist/main.js; do
        grep -qxF "$entry" <<< "$tree" || fail "tgz に $entry が入っていない"
    done
    assert_equal "$(grep -E '\.map$|cert' <<< "$tree" | head -3 | tr '\n' ' ')" ""
    for excluded in package/node_modules/ package/cli/src/ package/cli/tests/ package/.gitignore; do
        if grep -qF "$excluded" <<< "$tree"; then
            fail "tgz に $excluded が混入している"
        fi
    done
}

@test "同じ版で再実行しても、gh を 3 回呼んで正常終了し、リポジトリ本体に検証用タグを残さない" {
    explains '同じ版の本実行の publish を続けて 2 回動かすテストです。2 回目も `gh` を 3 回呼んで正常終了し、検証用のタグを使い捨てリポにだけ立てて、リポジトリ本体に残さないことを確認します。'
    attach_file "$SF/publish2.txt"
    assert_equal "$(read_rc "$SF/publish2.rc")" 0
    read_gh_log "$SF/gh-publish2"
    assert_equal "$gh_count" 3
    assert_equal "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG" | wc -l | tr -d ' ')" 0
    assert_equal "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG_2" | wc -l | tr -d ' ')" 0
}

@test "版が上がると、新しい版のタグと tgz で publish する" {
    explains 'プラグインの版を上げた commit にタグを立てた使い捨てリポで、本実行の publish を動かすテストです。正常終了し、`workflow run` が新しい版のタグを指し、添えた tgz の版が新しい版になることを確認します。'
    attach_file "$SF/publish3.txt"
    assert_equal "$(read_rc "$SF/publish3.rc")" 0
    read_gh_log "$SF/gh-publish3"
    assert_equal "$(sed -n 3p <<< "$gh_log")" "workflow run publish-npm.yml -f tag=$TEST_TAG_2 --ref $TEST_TAG_2 -R $TEST_SLUG"
    assert_equal "$(tgz_manifest "$SF/gh-publish3/uploaded.tgz" version)" "$TEST_VERSION_2"
}

@test "origin が scp 形式と ssh:// 形式でも、gh の -R が owner/name になる" {
    explains '使い捨てリポの origin を scp 形式と `ssh://` 形式に替えて、本実行の publish を動かすテストです。どちらの形式でも、`gh release view` の `-R` が origin の owner/name になることを確認します。'
    local script url i=0
    script="$(copy_test_repo)"
    for url in "git@github.com:$TEST_SLUG.git" "ssh://git@github.com/$TEST_SLUG.git"; do
        i=$((i + 1))
        git -C "$T/repo" remote set-url origin "$url"
        # 同じパスは 1 つの @test で 1 回しか添付されないので、形式ごとに記録を分ける。
        export GH_STUB_DIR="$T/gh-origin-$i"
        mkdir -p "$GH_STUB_DIR"
        : > "$GH_STUB_DIR/calls.log"
        run_attached publish_real bash "$script" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-origin-$i"
        read_gh_log
        assert_equal "$(sed -n 1p <<< "$gh_log")" "release view $TEST_TAG -R $TEST_SLUG"
    done
}

@test "Release が無いと、理由を出して、upload とワークフローの起動へ進まずに非ゼロ終了する" {
    explains '`gh release view` が Release の不在により失敗する状態で、本実行の publish を動かすテストです。終了コード 1 で `gh` の理由を表示し、`upload` とワークフローの起動へ進まないことを確認します。'
    GH_STUB_NO_RELEASE=1 run_attached publish_real bash "$TEST_REPO/$TEST_TOOLS_PATH/scripts/release/publish-mcp-dist.sh" \
        --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-norelease"
    assert_failure 1
    assert_output --partial "release not found"
    read_gh_log
    assert_equal "$gh_count" 1
}

@test "作業ツリーが HEAD と乖離していると、gh を呼ばずに publish を拒否する" {
    explains '使い捨てリポの配布の入力に未コミットの変更を置いて、本実行の publish を動かすテストです。タグの指す commit と違う配布物を防ぐため、未コミットの変更を理由に拒否し、`gh` を呼ばないことを確認します。'
    local script
    script="$(copy_test_repo)"
    printf '\ndirty\n' >> "$T/repo/$TEST_TOOLS_PATH/scripts/release/mcp-dist-README.md"
    run_attached publish_real bash "$script" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-dirty"
    assert_failure
    assert_output --partial "未コミットの変更"
    read_gh_log
    assert_equal "$gh_count" 0
}

# --- 6. --out-dir ガード ---

@test "--out-dir が消してはいけない場所を指すと、消さずに拒否する" {
    explains 'publish が最初に消す `--out-dir` へ、リポジトリの配下・ルート・空でないディレクトリ・ファイル・親の無いパスを渡すテストです。どれも非ゼロで終了し、空でないディレクトリの中身を消さないことを確認します。'
    reject_out_dir "$REPO_ROOT/plugins/pecot-tools/scripts"
    reject_out_dir "$REPO_ROOT"
    reject_out_dir "/"
    mkdir -p "$T/nonempty/keep"
    reject_out_dir "$T/nonempty"
    # symlink を経由してリポジトリ配下を指す場合も、正規化して同じ扱いにする。
    ln -s "$REPO_ROOT" "$T/repo-link"
    reject_out_dir "$T/repo-link/plugins"
    touch "$T/plain-file"
    reject_out_dir "$T/plain-file"
    reject_out_dir "$T/does-not-exist/child"
    assert_equal "$(ls -A "$T/nonempty" | wc -l | tr -d ' ')" 1
}

@test "symlink 経由で起動しても、--out-dir のガードがリポジトリ配下を拒否する" {
    explains 'リポジトリ本体を指す symlink を経由して publish を起動し、`--out-dir` にリポジトリ配下を渡すテストです。起動のパスが symlink でも、リポジトリの外を求める理由で拒否することを確認します。'
    local out="$REPO_ROOT/plugins/pecot-tools/scripts/release/.f02-outdir-check-$$"
    ln -s "$REPO_ROOT" "$T/repo-link"
    run_attached bash "$T/repo-link/plugins/pecot-tools/scripts/release/publish-mcp-dist.sh" --dry-run --skip-build --out-dir="$out"
    assert_failure
    assert_output --partial "の外を指定してください: $out"
}
