#!/usr/bin/env bats
# publish-mcp-dist.sh の検証 (#352)。gh は偽物に差し替え、cli/dist と libs/workflow-core/dist は build 済みを前提に --skip-build で流す。
# 重い dry-run・smoke 用の install・最初の本実行は setup_file で 1 回だけ動かし、@test はその出力を確かめる。

bats_require_minimum_version 1.5.0

RELEASE_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd -P)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd -P)"
WORKFLOW_ROOT="$REPO_ROOT/plugins/pecot-workflow"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"
# gh の -R は origin の URL から求める。合成した owner/name の https URL を置く。
TEST_SLUG="acme-labs/example-repo"
# tools/list の期待値。TOOLS（cli/src/commands/registry.ts）の並びを写している。
EXPECTED_TOOL_COUNT=25
EXPECTED_FIRST_TOOL="project_list"

# setup_file が作り、@test が読むもの。@test はここへ書き込まない。
SF="$BATS_FILE_TMPDIR"
DIST="$SF/dist"
TEST_REPO="$SF/repo"
TEST_WORKFLOW="$TEST_REPO/plugins/pecot-workflow"
TAGGED_PUBLISH="$TEST_WORKFLOW/scripts/release/publish-mcp-dist.sh"
SMOKE_MJS="$SF/smoke.mjs"
SMOKE_ROOT="$SF/smoke-install"
SMOKE_BIN="$SMOKE_ROOT/node_modules/.bin/pecot-workflow-mcp"

setup_file() {
    # git hook から継いだ GIT_DIR 等があると `git -C` が本体の index を書き換えるので捨てる。
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
    # 継承した NX_DRY_RUN は、非 dry-run の検証まで dry-run にする。
    unset NX_DRY_RUN
    # 並べた publish の `git status` が、使い捨てリポの index.lock を取り合わないようにする。
    export GIT_OPTIONAL_LOCKS=0
    export GIT_AUTHOR_NAME="pecot-workflow release test" GIT_AUTHOR_EMAIL="pecot-workflow-release-test@example.invalid"
    export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

    # build 済み dist の存在を先に確かめる（無いと publish が途中で落ち、原因が分からない出力になる）。
    local dir
    for dir in "$WORKFLOW_ROOT/cli/dist" "$REPO_ROOT/libs/workflow-core/dist"; do
        if [ ! -d "$dir" ]; then
            echo "ERROR: $dir がありません。build 済みの dist が前提です。" >&2
            echo "  bash plugins/pecot-workflow/scripts/ci/run-tests.sh --scope=release" >&2
            return 1
        fi
    done

    PLUGIN_VERSION="$(node -e "process.stdout.write(require('$WORKFLOW_ROOT/.claude-plugin/plugin.json').version)")"
    # @test は別のプロセスで動き `$$` が変わるので、版とタグはここで 1 回だけ決める。
    TEST_VERSION="0.0.0-test$$"
    TEST_TAG="pecot-workflow-v$TEST_VERSION"
    TEST_VERSION_2="0.0.0-test$$-2"
    TEST_TAG_2="pecot-workflow-v$TEST_VERSION_2"
    export PLUGIN_VERSION TEST_VERSION TEST_TAG TEST_VERSION_2 TEST_TAG_2

    # 偽 gh は引数を GH_STUB_LOG に記録し、upload された tgz を GH_STUB_DIR へ写す。
    mkdir -p "$SF/bin" "$SF/npmbin"
    cat > "$SF/bin/gh" << 'STUB_GH'
#!/bin/bash
printf '%s\n' "$*" >> "$GH_STUB_LOG"
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
    chmod +x "$SF/bin/gh"
    export PATH="$SF/bin:$PATH"
    # 非 dry-run の実行は PECOT_RELEASE_TEST_NPM_CACHE を拒否する。代わりに偽 npm が install にだけ永続キャッシュを足す。
    REAL_NPM="$(command -v npm)"
    NPM_PERSIST_CACHE="${PECOT_RELEASE_TEST_NPM_CACHE:-$SF/npm-persist-cache}"
    export REAL_NPM NPM_PERSIST_CACHE
    cat > "$SF/npmbin/npm" << 'STUB_NPM'
#!/bin/bash
case "$1" in
    install) exec "$REAL_NPM" "$@" "--cache=$NPM_PERSIST_CACHE" --prefer-offline ;;
esac
exec "$REAL_NPM" "$@"
STUB_NPM
    chmod +x "$SF/npmbin/npm"

    write_smoke_mjs
    make_test_repo

    # 2 つの流れは互いの gh の記録・構築先を使わないので、同時に動かす。
    local dryrun_pid publish_pid dryrun_rc=0 publish_rc=0
    run_dryrun_chain 3>&- &
    dryrun_pid=$!
    run_publish_chain 3>&- &
    publish_pid=$!
    wait "$publish_pid" || publish_rc=$?
    wait "$dryrun_pid" || dryrun_rc=$?
    [ "$dryrun_rc" -eq 0 ] && [ "$publish_rc" -eq 0 ]
}

setup() {
    bats_load_library pecot-bats
    T="$BATS_TEST_TMPDIR"
    export GH_STUB_DIR="$T/gh-stub" GH_STUB_LOG="$T/gh-stub/calls.txt"
    mkdir -p "$GH_STUB_DIR"
    : > "$GH_STUB_LOG"
}

# --- 5-5. テストはリポジトリ本体に検証用のタグを残さない ---
teardown_file() {
    bats_load_library pecot-bats
    assert_equal "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG" | wc -l | tr -d ' ')" 0
    assert_equal "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG_2" | wc -l | tr -d ' ')" 0
}

# タグは worktree 間で共有されるので本体に作らず、publish の入力だけを持つ使い捨てリポに立てる。
make_test_repo() {
    mkdir -p "$TEST_REPO"
    git init --quiet --initial-branch=main "$TEST_REPO"
    git -C "$TEST_REPO" remote add origin "https://github.com/$TEST_SLUG.git"
    # git 管理の入力を ls-files で写す。pnpm-lib.sh は publish が resolve_pnpm のために source する。
    (cd "$REPO_ROOT" && git ls-files -z -- \
        plugins/pecot-workflow/.claude-plugin \
        plugins/pecot-workflow/scripts/ci/pnpm-lib.sh \
        plugins/pecot-workflow/package.json \
        plugins/pecot-workflow/cli/package.json \
        plugins/pecot-workflow/cli/templates \
        plugins/pecot-workflow/hooks/lib/core/pecot-gitignore-ensure.sh \
        plugins/pecot-workflow/scripts/release \
        LICENSE \
        | tar --null -T - -cf -) | tar -xf - -C "$TEST_REPO"
    # ls-files は未追跡ファイルを落とすので、追加直後のスクリプトも入るよう scripts/release は作業ツリーから上書きする。
    rm -rf "$TEST_WORKFLOW/scripts/release"
    mkdir -p "$TEST_WORKFLOW/scripts"
    cp -a "$WORKFLOW_ROOT/scripts/release" "$TEST_WORKFLOW/scripts/release"
    # 共通スクリプト（pack から gh まで）も同じ理由で作業ツリーから置く。
    mkdir -p "$TEST_REPO/.githooks/scripts" "$TEST_REPO/.githooks/lib"
    cp -a "$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "$REPO_ROOT/.githooks/scripts/origin-slug.mjs" "$TEST_REPO/.githooks/scripts/"
    cp -a "$REPO_ROOT/.githooks/lib/mcp-publish-common.sh" "$TEST_REPO/.githooks/lib/"
    # git 管理外の build 生成物は実体を持ち込む。vendor のリンクと lib の package.json も作業ツリーから写す。
    cp -a "$WORKFLOW_ROOT/cli/dist" "$TEST_WORKFLOW/cli/dist"
    cp -a "$WORKFLOW_ROOT/vendor" "$TEST_WORKFLOW/vendor"
    mkdir -p "$TEST_REPO/libs/workflow-core"
    cp -a "$REPO_ROOT/libs/workflow-core/package.json" "$REPO_ROOT/libs/workflow-core/dist" "$TEST_REPO/libs/workflow-core/"
    git -C "$TEST_REPO" add -A > /dev/null 2>&1
    git -C "$TEST_REPO" commit --quiet -m "test fixture" > /dev/null 2>&1
    git -C "$TEST_REPO" tag "$TEST_TAG" HEAD
}

# 1 の dry-run で $DIST を作り、4 の smoke 用に tgz を install する。配布ツリーを作れなければ 1 で終わる。
run_dryrun_chain() {
    local rc=0 tgz_name
    export GH_STUB_DIR="$SF/gh-dryrun" GH_STUB_LOG="$SF/gh-dryrun/calls.txt"
    mkdir -p "$GH_STUB_DIR"
    : > "$GH_STUB_LOG"
    bash "$PUBLISH" --dry-run --skip-build --out-dir="$DIST" > "$SF/dryrun.log" 2>&1 || rc=$?
    echo "$rc" > "$SF/dryrun.rc"
    if [ "$rc" -ne 0 ]; then
        echo "dry-run で配布ツリーを構築できません" >&2
        cat "$SF/dryrun.log" >&2
        return 1
    fi
    # npm はリポの外で打つ（リポの中は devEngines で EBADDEVENGINES になる）。
    mkdir -p "$SF/smoke-pack" "$SMOKE_ROOT"
    printf '{"private":true}\n' > "$SMOKE_ROOT/package.json"
    rc=0
    {
        tgz_name="$(cd "$SF" && "$REAL_NPM" pack "$DIST" --ignore-scripts --pack-destination "$SF/smoke-pack" 2> "$SF/smoke-pack-stderr.txt" | tail -n 1)"
        [ -n "$tgz_name" ] && (cd "$SMOKE_ROOT" && "$REAL_NPM" install "$SF/smoke-pack/$tgz_name" \
            --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1 \
            "--cache=$NPM_PERSIST_CACHE" --prefer-offline > "$SF/smoke-install.txt" 2>&1)
    } || rc=$?
    echo "$rc" > "$SF/smoke-install.rc"
}

# 5-2 の本実行。タグのある使い捨てリポ側のスクリプトを起動する。終了コードはファイルに残す。
run_publish_chain() {
    local rc=0
    export GH_STUB_DIR="$SF/gh-publish1" GH_STUB_LOG="$SF/gh-publish1/calls.txt"
    mkdir -p "$GH_STUB_DIR"
    : > "$GH_STUB_LOG"
    publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
        --out-dir="$SF/dist-1" > "$SF/publish1.log" 2>&1 || rc=$?
    echo "$rc" > "$SF/publish1.rc"
}

# 非 dry-run の publish を起動する。opt-in 付きでは拒否されるので外し、偽 npm に永続キャッシュを足させる。
publish_real() {
    env -u PECOT_RELEASE_TEST_NPM_CACHE PATH="$SF/npmbin:$PATH" "$@"
}

# gh の呼び出しの記録（省略時は GH_STUB_LOG）を読んで添付し、中身を gh_log、行数を gh_count に置く。
read_gh_log() {
    gh_log="$(read_output "${1:-$GH_STUB_LOG}")"
    gh_count="$(printf '%s' "$gh_log" | grep -c '' || true)"
}
gh_line() {
    sed -n "${1}p" <<< "$gh_log"
}

# 使い捨てリポを $T/repo に写し、その中の publish-mcp-dist.sh のパスを返す。リポを書き換える @test が使う。
copy_test_repo() {
    cp -a "$TEST_REPO" "$T/repo"
    echo "$T/repo/plugins/pecot-workflow/scripts/release/publish-mcp-dist.sh"
}

# tgz の package/package.json を $2 に出して添付し、$3 のキーの値を返す。
tgz_manifest_value() {
    tar -xzOf "$1" package/package.json > "$2" 2> /dev/null || :
    attach_file "$2"
    node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0, 'utf8'))[process.argv[1]]))" "$3" < "$2" 2> /dev/null || true
}

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

# 期待値を列挙で持つと drift を検出できないので、cli と lib の package.json の dependencies（lib そのものを除く）から作る。
cli_dep_set() {
    node -e "
const cli = require('$WORKFLOW_ROOT/cli/package.json').dependencies, lib = require('$REPO_ROOT/libs/workflow-core/package.json').dependencies
const names = new Set([...Object.keys(cli), ...Object.keys(lib)])
names.delete('@pecot/workflow-core')
process.stdout.write([...names].sort().join(','))"
}

# smoke の起動はプラグインとセッションの環境変数を外す。残ると、同梱し忘れもソースツリーから読めて通ってしまう。
smoke_node() {
    env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT -u COPILOT_PLUGIN_ROOT \
        -u COPILOT_SESSION_CWD -u CLAUDE_PROJECT_DIR \
        node "$SMOKE_MJS" "$@"
}

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

# $1 = smoke の出力 json, $2 = calls 配列の index, $3 = 'isError'・'branch'・'text'。$4 に reads を渡すと reads 配列を読む。
call_value() {
    node -e "
const fs = require('node:fs')
let value
try { value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')) }
catch { process.stdout.write('PARSE_ERROR'); process.exit(0) }
const call = (value[process.argv[4] ?? 'calls'] ?? [])[Number(process.argv[2])]
const field = call === undefined ? undefined : call[process.argv[3]]
process.stdout.write(field === undefined || field === null ? '' : String(field))
" "$1" "$2" "$3" "${4:-calls}"
}

# smoke（$1 = 結果、$2 = stderr）が MCP サーバとして起動しなかったら、理由を添えてテストを落とす。
smoke_must_start() {
    local head result stderr_tail
    attach_file "$1"
    head="$(head -c 5 "$1" 2> /dev/null)"
    result="$(cat "$1" 2> /dev/null)"
    stderr_tail="$(tail -n 3 "$2" | tr '\n' ' ')"
    case "$head" in
        FAIL:) fail "配布ツリーが MCP サーバとして起動しない: $result :: $stderr_tail" ;;
        '') fail "smoke が何も出力しなかった: $stderr_tail" ;;
    esac
}

# smoke を $1 に出し、tools/list が期待の件数と先頭を返すことを確かめる。$2 以降は起動するコマンド。
smoke_tools_list() {
    local out="$1" error
    shift
    smoke_node "$@" > "$out" 2> "$out.err" || true
    smoke_must_start "$out" "$out.err"
    error="$(smoke_value "$out" error)"
    [ -z "$error" ] || fail "tools/list がエラーを返した (error.message: $error)"
    assert_equal "$(smoke_value "$out" toolCount)" "$EXPECTED_TOOL_COUNT"
    assert_equal "$(smoke_value "$out" firstTool)" "$EXPECTED_FIRST_TOOL"
}

# --out-dir のガードで止まることを確かめる。構築前に rm -rf する引数のため、消してはいけない場所を弾く。
reject_out_dir() {
    run_attached bash "$PUBLISH" --dry-run --skip-build --out-dir="$1"
    assert_failure
    assert_output --partial "ERROR: --out-dir"
}

write_smoke_mjs() {
    cat > "$SMOKE_MJS" << 'SMOKE'
// node smoke.mjs <command> [args...]: MCP サーバに initialize / tools/list（と SMOKE_TOOL_CALLS・SMOKE_RESOURCE_READS）を送り、要約を 1 行 JSON で返す。
// 起動そのものに失敗したときだけ `FAIL: <理由>` を返す。SMOKE_CWD があれば、それをサーバの cwd にする。
import { spawn } from 'node:child_process'

const command = process.argv.slice(2)
const TIMEOUT_MS = 120_000
const CALLS = process.env['SMOKE_TOOL_CALLS'] === undefined
  ? []
  : JSON.parse(process.env['SMOKE_TOOL_CALLS'])
const CALL_ID_BASE = 100
const READS = process.env['SMOKE_RESOURCE_READS'] === undefined
  ? []
  : JSON.parse(process.env['SMOKE_RESOURCE_READS'])
const READ_ID_BASE = 200
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ...CALLS.map((call, index) => ({ jsonrpc: '2.0', id: CALL_ID_BASE + index, method: 'tools/call', params: call })),
  ...READS.map((uri, index) => ({ jsonrpc: '2.0', id: READ_ID_BASE + index, method: 'resources/read', params: { uri } }))
]
const expected = requests.filter((message) => message.id !== undefined).map((message) => message.id)

const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.env['SMOKE_CWD'] })
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
  const outcome = response?.result?.structuredContent
  const branch = outcome?.branch ?? ''
  return { isError: response === undefined ? null : response.result?.isError ?? false, branch }
})
const reads = READS.map((_, index) => {
  const response = seen.get(READ_ID_BASE + index)
  return { isError: response === undefined ? null : response.error !== undefined, text: response?.result?.contents?.[0]?.text ?? '' }
})
const initialized = seen.get(1)
process.stdout.write(JSON.stringify({
  toolCount: tools.length,
  firstTool: tools[0]?.name ?? '',
  toolNames: tools.map((tool) => tool.name),
  serverName: initialized?.result?.serverInfo?.name ?? '',
  calls,
  reads
}))
SMOKE
}

# --- 1. dry-run で配布ツリーを構築する ---

@test "dry-run で配布ツリーを構築すると、gh を呼ばずに tgz の名前と中身と予定の gh コマンドを表示する" {
    explains "\`--dry-run\` で配布ツリーを構築するテストです。正常終了し、\`gh\` を呼ばずに tgz の名前と中身、予定の \`gh\` コマンド、版の注記を表示することを確認します。"
    local log="$SF/dryrun.log" rc
    rc="$(read_output "$SF/dryrun.rc")"
    assert_equal "$rc" 0
    run read_output "$log"
    assert_success
    assert_output --partial "dry-run=true"
    assert_output --partial "dry-run のため gh は実行しません"
    # dry-run は npm pack まで実行する。tgz の名前と中身の一覧を出力に残す。
    assert_output --partial "tgz: pecot-workflow-mcp-$PLUGIN_VERSION.tgz"
    assert_line "    LICENSE"
    assert_equal "$(grep -E '^    ' "$log" | grep -E '\.map$|cert' | tr '\n' ' ')" ""
    assert_line --regexp "gh release upload pecot-workflow-v$PLUGIN_VERSION pecot-workflow-mcp-$PLUGIN_VERSION.tgz --clobber -R [^ /]+/[^ /]+\$"
    assert_line --regexp "gh workflow run publish-npm.yml -f tag=pecot-workflow-v$PLUGIN_VERSION --ref pecot-workflow-v$PLUGIN_VERSION -R [^ /]+/[^ /]+\$"
    # dry-run の表示は、タグの版が nx の上げる前の値であることを添える。
    assert_output --partial "版は version の段階より前の値です"
    read_gh_log "$SF/gh-dryrun/calls.txt"
    assert_equal "$gh_count" 0
}

# forwardAllArgs: false のため、本番で dry-run が届くのは NX_DRY_RUN 環境変数だけ。
@test "--dry-run を付けずに NX_DRY_RUN=1 で起動すると、dry-run として gh を呼ばずに終わる" {
    explains "\`--dry-run\` を付けずに \`NX_DRY_RUN=1\` だけで起動するテストです。dry-run であることをログに出し、\`gh\` を呼ばずに正常終了することを確認します。"
    run_attached env NX_DRY_RUN=1 bash "$PUBLISH" --skip-build --out-dir="$T/dist-nx-dry-run"
    assert_success
    assert_output --partial "dry-run=true"
    assert_output --partial "dry-run のため gh は実行しません"
    read_gh_log
    assert_equal "$gh_count" 0
}

# forwardAllArgs: false を選んだ根拠そのもの。
@test "nx の引数の形の --dryRun=true を渡すと、未対応の引数として終了コード 1 で止まる" {
    explains "nx の引数の形の \`--dryRun=true\` を渡して起動するテストです。未対応の引数として、終了コード 1 で止まることを確認します。"
    run_attached bash "$PUBLISH" --dryRun=true --skip-build --out-dir="$T/dist-badflag"
    assert_failure 1
    assert_output --partial "未対応の引数: --dryRun=true"
}

@test "配布先を上書きする --repo を渡すと、未対応の引数として終了コード 1 で止まる" {
    explains "配布先の上書きを意図した \`--repo\` を渡して \`--dry-run\` を実行するテストです。未対応の引数として、終了コード 1 で止まることを確認します。"
    run_attached bash "$PUBLISH" --dry-run --skip-build --repo=acme-labs/example-repo --out-dir="$T/dist-repoflag"
    assert_failure 1
    assert_output --partial "未対応の引数: --repo=acme-labs/example-repo"
}

# --- 2. 配布ツリーの中身 ---

@test "生成する package.json が公開名・版・bin・依存を宣言し、shrinkwrap と plugin.json が実版を持つ" {
    explains "配布ツリーに生成する \`package.json\` のテストです。公開名・版・\`bin\`・依存がソースの宣言と一致し、shrinkwrap と \`plugin.json\` が実版を持つことを確認します。"
    attach_file "$DIST/package.json"
    attach_file "$DIST/npm-shrinkwrap.json"
    attach_file "$DIST/.claude-plugin/plugin.json"
    assert_equal "$(read_manifest name)" "@pecot/workflow-mcp"
    assert_equal "$(read_manifest version)" "$PLUGIN_VERSION"
    assert_equal "$(read_manifest bin)" '{"pecot-workflow-mcp":"cli/dist/main.js"}'
    assert_equal "$(read_manifest license)" "MIT"
    assert_equal "$(read_manifest repository)" \
        '{"type":"git","url":"git+https://github.com/pecotcraft/pecot.git","directory":"plugins/pecot-workflow"}'
    assert_equal "$(read_manifest engines)" "node"
    # devEngines に pnpm を写すと、npm が EBADDEVENGINES で止まり、npx 自身が起動しない。
    assert_equal "$(read_manifest hasDevEngines)" "false"
    # 配布物は npx が展開するだけで、ビルド・テストの script は持たない。
    assert_equal "$(read_manifest hasScripts)" "false"
    assert_equal "$(read_manifest deps)" "$(cli_dep_set)"
    # サーバは引数を読まないので、引数の解釈の commander は配布物に要らない。
    [[ ",$(read_manifest deps)," != *",commander,"* ]] || fail "配布 package.json の dependencies に commander がある"
    assert_equal "$(node -e "process.stdout.write(String(require('$DIST/npm-shrinkwrap.json').lockfileVersion))" 2> /dev/null)" 3
    assert_equal "$(node -e "process.stdout.write(require('$DIST/.claude-plugin/plugin.json').version)" 2> /dev/null)" "$PLUGIN_VERSION"
}

@test "配布ツリーの import を同梱の workflow-core への相対パスに書き換え、残る bare import をすべて宣言する" {
    explains "配布ツリーの \`cli/dist\` と \`vendor/workflow-core/dist\` の import のテストです。\`@pecot/workflow-core\` の import が残らず、ほかの bare import がすべて \`package.json\` で宣言されていることを確認します。"
    local scan="$T/bare-import-scan.json"
    assert_equal "$(grep -rlE '(from|import)[[:space:](]*.@pecot/workflow-core' "$DIST/cli/dist" | wc -l | tr -d ' ')" 0
    [ -f "$DIST/vendor/workflow-core/dist/commands-shared/output.js" ] || fail "vendor/workflow-core/dist が配布ツリーに無い"
    # 宣言の無い bare import は、npm の hoisting 次第で解決できたりできなかったりする。
    node - "$DIST" > "$scan" << 'SCAN_JS'
const fs = require('node:fs'), path = require('node:path')
const dist = process.argv[2]
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
// tsc の出力がダブルクォートに変わっても走査が無効化されないよう両方の引用符に対応する。
for (const file of [...walk(path.join(dist, 'cli/dist')), ...walk(path.join(dist, 'vendor/workflow-core/dist'))]) {
  if (!file.endsWith('.js')) continue
  const source = fs.readFileSync(file, 'utf8')
  // 指定子は 1 行に収まる。行をまたぐ一致は、文字列の中の from の後ろを拾ったもの
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*(['"])([^'"\n]+)\1/g)) {
    matchCount++
    const specifier = match[2]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    const name = packageOf(specifier)
    if (!declared.has(name)) missing.add(name)
  }
}
process.stdout.write(JSON.stringify({ missing: [...missing].sort(), matchCount }))
SCAN_JS
    attach_file "$scan"
    assert_equal "$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).missing.join(','))" "$scan")" ""
    # 走査 0 件での無条件 pass を防ぐ。
    local match_count
    match_count="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).matchCount))" "$scan")"
    [ "$match_count" -ge 1 ] 2> /dev/null || fail "bare import の走査が 0 件になった。正規表現が無効化されている疑い (matchCount=$match_count)"
}

@test "配布ツリーが MCP サーバの起動と実行時に読むファイルをすべて同梱する" {
    explains "配布ツリーに同梱するファイルのテストです。\`cli/dist\` の起動に要るファイルと、ソースと同じ一覧のテンプレートと、\`pecot-gitignore-ensure.sh\` があることを確認します。"
    local entry template_source_list
    # cp の -a 落ちや部分コピーを拾うため、起動に要る 4 点を cli/dist の階層ごと見る。
    for entry in main.js package.json infra/template-store.js mcp/server.js; do
        [ -f "$DIST/cli/dist/$entry" ] || fail "cli/dist/$entry が配布ツリーに無い"
    done
    # サーバが dist の外から読むテンプレートは、ソースの全ファイルの一覧と比べる。
    template_source_list="$(cd "$WORKFLOW_ROOT/cli/templates" && find . -type f | sort)"
    assert_equal "$(cd "$DIST/cli/templates" && find . -type f | sort)" "$template_source_list"
    [ -n "$template_source_list" ] || fail "cli/templates の一覧が空で、空同士の一致になっている"
    [ -f "$DIST/hooks/lib/core/pecot-gitignore-ensure.sh" ] || fail "hooks/lib/core/pecot-gitignore-ensure.sh が配布ツリーに無い"
}

@test "配布ツリーが .gitignore・ソースマップ・cert を含まず、ルートの LICENSE を同梱する" {
    explains "配布ツリーから除外するものと許諾表示のテストです。\`.gitignore\` とソースマップと cert を含むパスが無く、ルートと同じ \`LICENSE\` があることを確認します。"
    assert_equal "$(find "$DIST" -name '.gitignore' | wc -l | tr -d ' ')" 0
    # ソースマップは npm の配布物に入れない（spec 018 US4）。
    assert_equal "$(find "$DIST" -name '*.map' -type f | wc -l | tr -d ' ')" 0
    # MIT は許諾表示の同梱を条件にする。
    run read_output "$DIST/LICENSE"
    assert_success
    cmp -s "$REPO_ROOT/LICENSE" "$DIST/LICENSE" || fail "LICENSE が無いか、ルートの LICENSE と違う"
    assert_equal "$(find "$DIST" -iname '*cert*' | wc -l | tr -d ' ')" 0
}

# --- 3. README の登録例 ---

@test "README の登録例が公開名とサーバ名を使い、--prefix=/ で npx を起動する" {
    explains "配布ツリーの \`README.md\` の登録例のテストです。未置換のプレースホルダと git の URL が無く、公開名・\`--prefix=/\`・サーバ名を使うことを確認します。"
    local readme="$DIST/README.md"
    run read_output "$readme"
    assert_success
    assert_equal "$(grep -c 'git+' "$readme" | tr -d ' ')" 0
    assert_equal "$(grep -cE '__[A-Za-z0-9_]+__' "$readme" | tr -d ' ')" 0
    # 2 件 = npx 起動の登録例 + WSL 経由の登録例（bash -lc の行は引用符が付かず対象外）。
    assert_equal "$(grep -cF '"--prefix=/", "@pecot/workflow-mcp"]' "$readme" | tr -d ' ')" 2
    # --package= で渡すと子に npm_config_package が残り、子の npx が別のパッケージを実行する。
    assert_equal "$(grep -cF -- '--package=@' "$readme" | tr -d ' ')" 0
    assert_equal "$(grep -cF 'npx -y --prefix=/ @pecot/workflow-mcp' "$readme" | tr -d ' ')" 1
    # 3 件 = npx 起動 + 事前インストール後の直接起動 + WSL 経由。名前は initialize の serverInfo.name に合わせる。
    assert_equal "$(grep -cF '"pecot-workflow":' "$readme" | tr -d ' ')" 3
}

# --- 4. 配布物の起動 smoke ---
# tsc の出力は実行権を持たない。実行権は npm の bin-links が導入時に付ける。

@test "配布物の tgz を npm install すると、node_modules/.bin に実行できる pecot-workflow-mcp を張る" {
    explains "配布ツリーを pack した tgz を、リポの外で \`npm install\` するテストです。導入が成功し、\`node_modules/.bin/pecot-workflow-mcp\` が実行できる形で張られることを確認します。"
    local rc pack_err install_log
    rc="$(read_output "$SF/smoke-install.rc")"
    attach_file "$SF/smoke-pack-stderr.txt"
    attach_file "$SF/smoke-install.txt"
    pack_err="$(tail -n 3 "$SF/smoke-pack-stderr.txt" | tr '\n' ' ')"
    install_log="$(tail -n 3 "$SF/smoke-install.txt" 2> /dev/null | tr '\n' ' ')"
    [ "$rc" = 0 ] || fail "npm install が失敗した: $pack_err $install_log"
    [ -x "$SMOKE_BIN" ] || fail "node_modules/.bin/pecot-workflow-mcp が無いか、実行できない"
}

@test "導入した配布物を引数なしで起動すると、tools/list が README のツール表と同じ順で全ツールを返す" {
    explains "導入した \`pecot-workflow-mcp\` を、登録例と同じ引数なしで起動するテストです。\`tools/list\` が期待の件数と順で返り、README のツール表とサーバ名に一致することを確認します。"
    local out="$T/smoke-default.json" readme readme_tool_names
    smoke_tools_list "$out" "$SMOKE_BIN"
    # ツールの追加・改名・順序変更で README の表だけが古くなるのを防ぐ。
    readme="$(read_output "$DIST/README.md")"
    readme_tool_names="$(grep -oE '^\| `[a-z][a-z0-9_]+`' <<< "$readme" | sed -E 's/^\| `//; s/`$//' | paste -sd, -)"
    assert_equal "$(smoke_value "$out" toolNames)" "$readme_tool_names"
    assert_equal "$(smoke_value "$out" serverName)" "pecot-workflow"
}

@test "導入した配布物を mcp を付けて起動しても、引数を読まずに tools/list が全ツールを返す" {
    explains "導入した \`pecot-workflow-mcp\` を、\`mcp\` を付けて起動するテストです。サーバが引数を読まず、\`tools/list\` が引数なしの起動と同じ件数と先頭を返すことを確認します。"
    smoke_tools_list "$T/smoke-mcp.json" "$SMOKE_BIN" mcp
}

# tools/list が緑でも、dist の外のファイルを読めないと tools/call は失敗する。
@test "導入した配布物に session_show とテンプレートの resource を要求すると、ブランチ名と同梱のテンプレートを返す" {
    explains "一時の git リポを cwd にして、\`session_show\` と \`pecot-template://comment/plan\` を要求するテストです。どちらも成功し、ブランチ名と同梱のテンプレートの \`## Plan\` 節を返すことを確認します。"
    local call_repo="$T/call-repo" out="$T/smoke-calls.json"
    # ブランチ名に Issue 番号を持たない一時リポで、gh を呼ばない session_show を投げる。
    mkdir -p "$call_repo"
    git init --quiet --initial-branch=smoke-branch "$call_repo"
    git -C "$call_repo" commit --quiet --allow-empty -m "smoke" > /dev/null 2>&1
    SMOKE_CWD="$call_repo" \
        SMOKE_TOOL_CALLS='[{"name":"session_show","arguments":{"directory":"."}}]' \
        SMOKE_RESOURCE_READS='["pecot-template://comment/plan"]' \
        smoke_node "$SMOKE_BIN" > "$out" 2> "$out.err" || true
    smoke_must_start "$out" "$out.err"
    assert_equal "$(call_value "$out" 0 isError)" "false"
    assert_equal "$(call_value "$out" 0 branch)" "smoke-branch"
    assert_equal "$(call_value "$out" 0 isError reads)" "false"
    call_value "$out" 0 text reads | grep -qxF '## Plan' || fail "resource で読んだテンプレートに '## Plan' 節が無い"
}

# worktree_link は pecot-gitignore-ensure.sh を呼ぶ。同梱し忘れは警告で済んで link だけ通るので、生成物で確かめる。
@test "導入した配布物に worktree_link を要求すると、symlink を張り、同梱のスクリプトで .pecot/.gitignore を作る" {
    explains "一時の base と worktree の構成で、\`worktree_link\` を要求するテストです。成功して symlink を張り、同梱のスクリプトで \`.pecot/.gitignore\` を実ファイルで作ることを確認します。"
    local link_root="$T/link-project" out="$T/smoke-link.json"
    local link_main="$link_root/base/repo" link_wt="$link_root/wt1/repo"
    # <root>/base/repo（設定と link 先）と <root>/wt1/repo（link を張る側）を、ネットワークなしで作る。
    mkdir -p "$link_main/.pecot/config" "$link_main/.pecot/work" "$link_root/wt1"
    git init --quiet --initial-branch=main "$link_main"
    git -C "$link_main" remote add origin https://github.com/example/link-fixture.git
    git -C "$link_main" commit --quiet --allow-empty -m "link fixture" > /dev/null 2>&1
    git -C "$link_main" worktree add --quiet -b link-wt "$link_wt" > /dev/null 2>&1
    printf '%s\n' '{"version":3,"links":[{"path":".pecot/work","target_repo":"repo","target_path":".pecot/work"}]}' \
        > "$link_main/.pecot/config/worktree-config.json"
    DEVCONTAINER=1 SMOKE_CWD="$link_wt" \
        SMOKE_TOOL_CALLS="[{\"name\":\"worktree_link\",\"arguments\":{\"directory\":\"$link_wt\"}}]" \
        smoke_node "$SMOKE_BIN" > "$out" 2> "$out.err" || true
    smoke_must_start "$out" "$out.err"
    assert_equal "$(call_value "$out" 0 isError)" "false"
    [ -L "$link_wt/.pecot/work" ] || fail "worktree_link が worktree に symlink を張らなかった"
    [ -f "$link_wt/.pecot/.gitignore" ] && [ ! -L "$link_wt/.pecot/.gitignore" ] \
        || fail "worktree_link が .pecot/.gitignore を実ファイルで作らなかった"
    run read_output "$link_wt/.pecot/.gitignore"
    assert_success
    assert_line '!/config/worktree-config.json'
}

# --- 5. 冪等性の確認と Release への添付 ---

@test "HEAD にリリースタグが無いと、gh を呼ばず配布ツリーも作らずに正常終了する" {
    explains "リリースタグの無い HEAD で本実行するテストです。\`gh\` を呼ばず、配布ツリーも構築せずに正常終了することを確認します。"
    # 検証用の版のタグはリポ本体に無い。
    run_attached publish_real bash "$PUBLISH" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-gate"
    assert_success
    assert_output --partial "スキップ"
    [ ! -d "$T/dist-gate" ] || fail "リリースタグが無いのに配布ツリーを構築した"
    read_gh_log
    assert_equal "$gh_count" 0
}

@test "HEAD にリリースタグがあると、tgz を Release に添えてから npm 配布のワークフローを起動する" {
    explains "リリースタグを立てた使い捨てのリポで本実行するテストです。\`gh\` を確認・添付・起動の順に 3 回呼び、添付した tgz に配布物だけが入ることを確認します。"
    local tgz="$SF/gh-publish1/uploaded.tgz" list="$T/tgz-list.txt" rc upload_line entry excluded
    rc="$(read_output "$SF/publish1.rc")"
    assert_equal "$rc" 0
    run read_output "$SF/publish1.log"
    assert_success
    assert_output --partial "tgz: pecot-workflow-mcp-$TEST_VERSION.tgz"
    # 順序は view → upload → workflow run。-R は origin の URL から求めた値になる。
    read_gh_log "$SF/gh-publish1/calls.txt"
    assert_equal "$gh_count" 3
    assert_equal "$(gh_line 1)" "release view $TEST_TAG -R $TEST_SLUG"
    upload_line="$(gh_line 2)"
    [[ "$upload_line" == "release upload $TEST_TAG "*"/pecot-workflow-mcp-$TEST_VERSION.tgz --clobber -R $TEST_SLUG" ]] \
        || fail "2 番目が tgz・--clobber・-R 付きの gh release upload でない: $upload_line"
    assert_equal "$(gh_line 3)" "workflow run publish-npm.yml -f tag=$TEST_TAG --ref $TEST_TAG -R $TEST_SLUG"
    assert_equal "$(tgz_manifest_value "$tgz" "$T/uploaded-package.json" name)" "@pecot/workflow-mcp"
    assert_equal "$(tgz_manifest_value "$tgz" "$T/uploaded-package.json" version)" "$TEST_VERSION"
    tar -tzf "$tgz" > "$list" 2> /dev/null || : > "$list"
    attach_file "$list"
    for entry in package/package.json package/npm-shrinkwrap.json package/README.md package/LICENSE \
        package/.claude-plugin/plugin.json package/cli/dist/main.js package/cli/templates/comment/plan.md \
        package/hooks/lib/core/pecot-gitignore-ensure.sh; do
        grep -qxF "$entry" "$list" || fail "tgz に $entry が入っていない"
    done
    assert_equal "$(grep '^package/cli/templates/' "$list" | grep -v '/$' | sort)" \
        "$(cd "$WORKFLOW_ROOT/cli/templates" && find . -type f | sed 's|^\./|package/cli/templates/|' | sort)"
    assert_equal "$(grep -E '\.map$|cert' "$list" | head -3 | tr '\n' ' ')" ""
    for excluded in package/node_modules/ package/cli/src/ package/cli/tests/ package/.gitignore; do
        if grep -qF "$excluded" "$list"; then
            fail "tgz に $excluded が混入している"
        fi
    done
}

# --clobber で上書きし、publish 済みの版はワークフロー側が飛ばす。
@test "同じ版で再実行しても、初回と同じく gh を 3 回呼んで正常終了する" {
    explains "同じ版で本実行をやり直すテストです。\`--clobber\` で上書きするため正常終了し、\`gh\` を 3 回呼ぶことを確認します。"
    run_attached publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-2"
    assert_success
    read_gh_log
    assert_equal "$gh_count" 3
}

@test "版を上げて publish すると、新しい版のタグと tgz でワークフローを起動する" {
    explains "使い捨てのリポの写しで版を上げ、新しいタグを立てて本実行するテストです。ワークフローの起動が新しいタグを指し、添付した tgz が新しい版を持つことを確認します。"
    local script
    script="$(copy_test_repo)"
    node -e "
const fs = require('node:fs')
const file = process.argv[1]
const m = JSON.parse(fs.readFileSync(file, 'utf8'))
m.version = process.argv[2]
fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n')
" "$T/repo/plugins/pecot-workflow/.claude-plugin/plugin.json" "$TEST_VERSION_2"
    git -C "$T/repo" add -A > /dev/null 2>&1
    git -C "$T/repo" commit --quiet -m "test fixture v2" > /dev/null 2>&1
    git -C "$T/repo" tag "$TEST_TAG_2" HEAD
    run_attached publish_real bash "$script" --version="$TEST_VERSION_2" --skip-build --out-dir="$T/dist-3"
    assert_success
    read_gh_log
    assert_equal "$(gh_line 3)" "workflow run publish-npm.yml -f tag=$TEST_TAG_2 --ref $TEST_TAG_2 -R $TEST_SLUG"
    assert_equal "$(tgz_manifest_value "$GH_STUB_DIR/uploaded.tgz" "$T/uploaded-package.json" version)" "$TEST_VERSION_2"
}

@test "origin が scp 形式の URL でも、gh の -R に owner/name を渡す" {
    explains "使い捨てのリポの写しで、origin を \`git@github.com:\` の形にして本実行するテストです。\`gh release view\` の \`-R\` に owner/name を渡すことを確認します。"
    local script
    script="$(copy_test_repo)"
    git -C "$T/repo" remote set-url origin "git@github.com:$TEST_SLUG.git"
    run_attached publish_real bash "$script" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-ssh"
    read_gh_log
    assert_equal "$(gh_line 1)" "release view $TEST_TAG -R $TEST_SLUG"
}

@test "origin が ssh:// 形式の URL でも、gh の -R に owner/name を渡す" {
    explains "使い捨てのリポの写しで、origin を \`ssh://git@github.com/\` の形にして本実行するテストです。\`gh release view\` の \`-R\` に owner/name を渡すことを確認します。"
    local script
    script="$(copy_test_repo)"
    git -C "$T/repo" remote set-url origin "ssh://git@github.com/$TEST_SLUG.git"
    run_attached publish_real bash "$script" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-ssh2"
    read_gh_log
    assert_equal "$(gh_line 1)" "release view $TEST_TAG -R $TEST_SLUG"
}

@test "Release が無いと、理由を表示し、添付もワークフローの起動もせずに非ゼロ終了する" {
    explains "\`gh release view\` が失敗する状態で本実行するテストです。\`gh\` の理由を表示し、確認の 1 回だけで終了コード 1 になることを確認します。"
    export GH_STUB_NO_RELEASE=1
    run_attached publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-norelease"
    assert_failure 1
    assert_output --partial "release not found"
    read_gh_log
    assert_equal "$gh_count" 1
}

# タグの指すコミットに対応しない配布物を防ぐ。共有のリポを汚さないよう、写しで動かす。
@test "作業ツリーが HEAD と乖離していると、gh を呼ばずに publish を拒否する" {
    explains "使い捨てのリポの写しの作業ツリーに、未コミットの変更を置いて本実行するテストです。\`gh\` を呼ばずに、未コミットの変更を理由に拒否することを確認します。"
    local script
    script="$(copy_test_repo)"
    printf '\ndirty\n' >> "$T/repo/plugins/pecot-workflow/scripts/release/mcp-dist-README.md"
    run_attached publish_real bash "$script" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-dirty"
    assert_failure
    assert_output --partial "未コミットの変更"
    read_gh_log
    assert_equal "$gh_count" 0
}

# --- 6. --out-dir ガード ---

@test "--out-dir が消してはいけない場所を指すと、消さずに拒否する" {
    explains "\`--out-dir\` に消してはいけない場所を渡すテストです。リポの中・ルート・空でないディレクトリ・ファイルなどを拒否し、対象を消さないことを確認します。"
    reject_out_dir "$REPO_ROOT/plugins/pecot-workflow/scripts"
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

# REPO_ROOT は pwd -P で確定するので、起動パスだけを symlink にしても前方一致（条件 a）が働く。
@test "symlink を経由して起動しても、リポの中を指す --out-dir をリポの外を求める文言で拒否する" {
    explains "symlink を経由したパスで起動し、\`--out-dir\` にリポの中を渡すテストです。物理パスで比べ、リポの外を指定するよう求める文言で拒否することを確認します。"
    local out="$REPO_ROOT/plugins/pecot-workflow/scripts/release/.f02-outdir-check-$$"
    ln -s "$REPO_ROOT" "$T/repo-link"
    run_attached bash "$T/repo-link/plugins/pecot-workflow/scripts/release/publish-mcp-dist.sh" --dry-run --skip-build --out-dir="$out"
    assert_failure
    assert_output --partial "の外を指定してください: $out"
}
