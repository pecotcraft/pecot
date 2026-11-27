# audit-mcp-dist.sh の検証 (#1050 / #1071)。監査先はローカルのモックで、2 ツリーとも fixture を渡す。
# 監査記録・npm のキャッシュ・モックの到達の記録は @test ごとに $BATS_TEST_TMPDIR へ閉じる。

bats_require_minimum_version 1.5.0

RELEASE_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
PECOTV_PLUGIN_ROOT="$(cd "$RELEASE_DIR/../.." && pwd)"
AUDIT="$RELEASE_DIR/audit-mcp-dist.sh"
FINGERPRINT="$RELEASE_DIR/dist-fingerprint.mjs"
SUMMARY_JS="$RELEASE_DIR/audit-summary.mjs"
MANIFEST_JS="$RELEASE_DIR/dist-manifest.mjs"
RUNTIME_MANIFEST_JS="$RELEASE_DIR/runtime-manifest.mjs"
FIXTURE="$BATS_TEST_DIRNAME/fixtures/audit"
FIXTURE_RUNTIME="$BATS_TEST_DIRNAME/fixtures/audit-runtime"
REAL_RECORD_FILE="$REPO_ROOT/.nx/release-audit/pecotv-audit.json"

# 本監査の前にカナリア監査（minimist）を行うので、成立させる応答にはカナリアを含める。
# lodash の advisory id はケースごとに変える。同じ id では、先に評価した severity が cacache から返る。
CANARY_ADV='"minimist":[{"id":1097678,"url":"https://github.com/advisories/GHSA-xvch-5gv4-984h","title":"Prototype Pollution in minimist","severity":"critical","vulnerable_versions":">=1.0.0 <1.2.6","cwe":["CWE-1321"],"cvss":{"score":9.8,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}}]'
LODASH_HIGH='"lodash":[{"id":1523,"url":"https://github.com/advisories/GHSA-p6mc-m468-83gw","title":"Prototype Pollution in lodash","severity":"high","vulnerable_versions":"<4.17.19","cwe":["CWE-770"],"cvss":{"score":7.4,"vectorString":"CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N"}}]'
LODASH_MODERATE='"lodash":[{"id":1065,"url":"https://github.com/advisories/GHSA-29mw-wpgm-hmr9","title":"Regular Expression Denial of Service (ReDoS) in lodash","severity":"moderate","vulnerable_versions":"<4.17.21","cwe":["CWE-1333"],"cvss":{"score":5.3,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L"}}]'
# 永続層 fixture (image-size@1.2.1) 用。id・url・vulnerable_versions は実在の advisory の写し。
IMAGE_SIZE_HIGH='"image-size":[{"id":1138808,"url":"https://github.com/advisories/GHSA-w3rx-r6r6-pgpr","title":"image-size: ICNS parser allows denial of service through an infinite loop","severity":"high","vulnerable_versions":"<=2.0.2","cwe":["CWE-835"],"cvss":{"score":7.5,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"}},{"id":1138809,"url":"https://github.com/advisories/GHSA-5p2g-fcmc-qvqq","title":"image-size: JXL and HEIF parsers allow denial of service through infinite loops","severity":"high","vulnerable_versions":"<=2.0.2","cwe":["CWE-835"],"cvss":{"score":7.5,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"}}]'
# 実在の lodash の advisory に critical は無いので、severity だけ差し替えた合成応答。
LODASH_CRITICAL='"lodash":[{"id":1673,"url":"https://github.com/advisories/GHSA-35jh-r3h4-6jhm","title":"Command Injection in lodash","severity":"critical","vulnerable_versions":"<4.17.21","cwe":["CWE-77"],"cvss":{"score":9.8,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}}]'

# 常時閉塞アドレス。解放したエフェメラルポートは、並行する別プロセスが取ると接続拒否にならない。
CLOSED_REGISTRY="http://127.0.0.1:1"

setup_file() {
    bats_load_library pecot-bats
    # git hook から起動されると export される GIT_* が、被テストスクリプトの unset を打ち消すので捨てる。
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

    # npm audit の bulk advisory だけを模す。argv[2] は応答 JSON か blackhole（応答しない）、argv[3] は到達の記録。
    export MOCK="$BATS_FILE_TMPDIR/mock-registry.mjs"
    cat > "$MOCK" << 'MOCK_EOF'
import http from 'node:http'
import { readFileSync, appendFileSync } from 'node:fs'

const mode = process.argv[2]
const countFile = process.argv[3]
const body = mode === 'blackhole' ? null : readFileSync(mode, 'utf8')

const server = http.createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    if (req.url !== '/-/npm/v1/security/advisories/bulk') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    appendFileSync(countFile, `${req.method} ${req.url}\n`)
    // blackhole は接続を保持したまま応答しない（待ち上限の検証用）。
    if (body === null) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
})
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port)
})
MOCK_EOF

    export RESPONSES="$BATS_FILE_TMPDIR/responses"
    mkdir -p "$RESPONSES"
    # advisory を 1 件も返さないレジストリ（bulk が 200 と `{}`）。カナリアも落ちる。
    echo '{}' > "$RESPONSES/no-advisory.json"
    echo "{$CANARY_ADV}" > "$RESPONSES/canary-only.json"
    echo "{$CANARY_ADV,$LODASH_HIGH}" > "$RESPONSES/high.json"
    echo "{$CANARY_ADV,$LODASH_MODERATE}" > "$RESPONSES/moderate.json"
    echo "{$CANARY_ADV,$LODASH_CRITICAL}" > "$RESPONSES/critical.json"
    # 永続層のみ high（配布ツリーの lodash には advisory を返さない）。
    echo "{$CANARY_ADV,$IMAGE_SIZE_HIGH}" > "$RESPONSES/image-size-high.json"
    echo "{$CANARY_ADV,$LODASH_HIGH,$IMAGE_SIZE_HIGH}" > "$RESPONSES/both-high.json"

    # 判定を既定の audit-exceptions.json に左右させないため、全ケースで --exceptions を渡す。
    export EXC_EMPTY="$BATS_FILE_TMPDIR/exceptions-empty.json"
    printf '{"exceptions":[]}\n' > "$EXC_EMPTY"

    # version plan の探索先。実リポの plan の有無に左右されないよう、常に --plans-dir で渡す。
    export PLANS_PECOTV="$BATS_FILE_TMPDIR/plans-pecotv"
    write_plan "$PLANS_PECOTV/1050-audit.md" 'pecot-visual: patch'
    export PLANS_PECOT_ONLY="$BATS_FILE_TMPDIR/plans-pecot-only"
    write_plan "$PLANS_PECOT_ONLY/999-pecot-only.md" 'pecot: patch'
    # text-rules の group は updateDependents: always なので、nx は依存元の pecot-visual も上げる。
    export PLANS_TEXT_RULES="$BATS_FILE_TMPDIR/plans-text-rules"
    write_plan "$PLANS_TEXT_RULES/997-text-rules.md" 'text-rules: patch'
    export PLANS_WORKFLOW_ONLY="$BATS_FILE_TMPDIR/plans-workflow-only"
    write_plan "$PLANS_WORKFLOW_ONLY/996-workflow.md" 'pecot-workflow: patch'
    # key の行はあるが、引用値のため bump 宣言として抽出できない形。
    export PLANS_PECOTV_QUOTED="$BATS_FILE_TMPDIR/plans-pecotv-quoted"
    write_plan "$PLANS_PECOTV_QUOTED/998-quoted.md" 'pecot-visual: "patch"'
    export PLANS_TEXT_RULES_QUOTED="$BATS_FILE_TMPDIR/plans-text-rules-quoted"
    write_plan "$PLANS_TEXT_RULES_QUOTED/996-quoted.md" 'text-rules: "patch"'
    # キーを引用符で囲んだ形。YAML では引用符なしのキーと同じ宣言になる。
    export PLANS_TEXT_RULES_QUOTED_KEY="$BATS_FILE_TMPDIR/plans-text-rules-quoted-key"
    write_plan "$PLANS_TEXT_RULES_QUOTED_KEY/995-quoted-key.md" '"text-rules": minor'
    export PLANS_PECOTV_QUOTED_KEY="$BATS_FILE_TMPDIR/plans-pecotv-quoted-key"
    write_plan "$PLANS_PECOTV_QUOTED_KEY/994-quoted-key.md" "'pecot-visual': patch"

    REPO_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    PLUGIN_VERSION="$(node -e "process.stdout.write(require('$PECOTV_PLUGIN_ROOT/.claude-plugin/plugin.json').version)")"
    # 判定に使う @test が read_fixture_fp で添付できるよう、指紋をファイルにも残す。
    node "$FINGERPRINT" "$FIXTURE/npm-shrinkwrap.json" > "$BATS_FILE_TMPDIR/fixture-fingerprint.txt"
    FIXTURE_FP="$(cat "$BATS_FILE_TMPDIR/fixture-fingerprint.txt")"
    export REPO_HEAD PLUGIN_VERSION FIXTURE_FP
}

teardown_file() {
    # 既定パスの記録が、本テストの fixture 由来の指紋を持たないことだけを見る（記録が無ければ通す）。
    local real_fp
    real_fp="$(real_record_fingerprint)"
    [ -z "$real_fp" ] || assert_not_equal "$real_fp" "$FIXTURE_FP"
}

setup() {
    bats_load_library pecot-bats
    T="$BATS_TEST_TMPDIR"
    export PECOTV_AUDIT_RECORD="$T/audit-record.json"
    # npm audit の cacache のキーに severity が入らないので、共有キャッシュでは合否がマシンの状態に左右される。
    export npm_config_cache="$T/npm-cache"
    MOCK_PID=""
}

teardown() {
    stop_mock
}

# $1 にリリース対象の宣言 $2 を持つ version plan を書く。
write_plan() {
    mkdir -p "$(dirname "$1")"
    printf -- '---\n%s\n---\n\nテスト用の plan。\n' "$2" > "$1"
}

# 既定パスの記録の配布ツリー指紋。記録が無い・読めない・指紋を持たない場合は空を返す。
real_record_fingerprint() {
    [ -f "$REAL_RECORD_FILE" ] || return 0
    node -e '
const fs = require("node:fs")
let data = null
try { data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch { data = null }
const dist = data !== null && typeof data === "object" ? data.dist : undefined
const fp = dist !== null && typeof dist === "object" ? dist.fingerprint : undefined
process.stdout.write(typeof fp === "string" ? fp : "")
' "$REAL_RECORD_FILE" 2> /dev/null
}

# モックを起こし、MOCK_PORT・MOCK_COUNT・MOCK_PID を置く。fd 3 を閉じないと bats が終わらない。
start_mock() {
    local mode="$1" name="$2"
    MOCK_COUNT="$T/$name.count"
    : > "$MOCK_COUNT"
    local portfile="$T/$name.port"
    : > "$portfile"
    node "$MOCK" "$mode" "$MOCK_COUNT" > "$portfile" 2> "$T/$name.log" 3>&- &
    MOCK_PID=$!
    local i=0
    while [ ! -s "$portfile" ]; do
        i=$((i + 1))
        [ "$i" -le 200 ] || fail "モックレジストリが起動しません ($name)"
        sleep 0.05
    done
    MOCK_PORT="$(tr -d '\n' < "$portfile")"
}

stop_mock() {
    [ -n "${MOCK_PID:-}" ] || return 0
    kill "$MOCK_PID" > /dev/null 2>&1 || true
    wait "$MOCK_PID" > /dev/null 2>&1 || true
    MOCK_PID=""
}

# モックへの到達の記録を読んで添付し、到達の回数を mock_count に置く。
read_mock_requests() {
    local log
    log="$(read_output "$MOCK_COUNT")"
    mock_count="$(printf '%s' "$log" | grep -c '' || true)"
}

# setup_file が求めた fixture の指紋を読んで添付し、fixture_fp に置く。
read_fixture_fp() {
    fixture_fp="$(read_output "$BATS_FILE_TMPDIR/fixture-fingerprint.txt")"
}

# 記録の欠け・破損・フィールドの欠けを、__ABSENT__・__UNREADABLE__・__MISSING__ で分けて返す。記録は添付する。
record_field() {
    attach_file "$PECOTV_AUDIT_RECORD"
    node -e '
const fs = require("node:fs")
const [file, query] = process.argv.slice(1)
if (!fs.existsSync(file)) {
  process.stdout.write("__ABSENT__")
  process.exit(0)
}
let data = null
try {
  data = JSON.parse(fs.readFileSync(file, "utf8"))
} catch {
  process.stdout.write("__UNREADABLE__")
  process.exit(0)
}
let cur = data
for (const key of query.split(".")) cur = cur !== null && typeof cur === "object" ? cur[key] : undefined
process.stdout.write(cur === undefined ? "__MISSING__" : String(cur))
' "$PECOTV_AUDIT_RECORD" "$1"
}

# 有効な記録を事前に置く。中止したときに記録が消えることの検証に使う。
place_stale_record() {
    cat > "$PECOTV_AUDIT_RECORD" << 'STALE_EOF'
{
  "head": "0000000000000000000000000000000000000000",
  "registry": "https://registry.npmjs.org/",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "dist": {
    "fingerprint": "0000000000000000000000000000000000000000000000000000000000000000",
    "total": 1,
    "vulnerabilities": { "critical": 0, "high": 0, "moderate": 0, "low": 0, "info": 0 },
    "excepted": []
  },
  "runtime": {
    "fingerprint": "1111111111111111111111111111111111111111111111111111111111111111",
    "total": 3,
    "vulnerabilities": { "critical": 0, "high": 0, "moderate": 0, "low": 0, "info": 0 },
    "excepted": []
  }
}
STALE_EOF
}

# npm が対象ディレクトリへ書き込んでも fixture を汚さないよう、毎回コピーして使う。
new_dist() {
    local dir="$T/dist-$1"
    mkdir -p "$dir"
    cp "$FIXTURE/package.json" "$FIXTURE/npm-shrinkwrap.json" "$dir/"
    echo "$dir"
}

new_runtime_dist() {
    local dir="$T/runtime-$1"
    mkdir -p "$dir"
    cp "$FIXTURE_RUNTIME/package.json" "$FIXTURE_RUNTIME/npm-shrinkwrap.json" "$dir/"
    echo "$dir"
}

# write_exceptions <出力> <advisory,package>...
write_exceptions() {
    local out="$1"
    shift
    node - "$out" "$@" << 'WRITE_EXCEPTIONS_JS'
const fs = require("node:fs")
const [out, ...pairs] = process.argv.slice(2)
const exceptions = []
for (const pair of pairs) {
  const [advisory, pkg] = pair.split(",")
  exceptions.push({ advisory, package: pkg, reason: "テスト用", added: "2026-09-07", reevaluate: "テスト用" })
}
fs.writeFileSync(out, JSON.stringify({ exceptions }, null, 2) + "\n")
WRITE_EXCEPTIONS_JS
}

# 監査を動かし、出力を添付する。結果は $status・$output（stdout）・$stderr に入る。
run_audit() {
    run_attached --separate-stderr bash "$AUDIT" "$@"
}

# 形の違う例外リストで、監査未実施として中止することを見る。
check_bad_exceptions() {
    local name="$1" file="$2" registry="$3"
    run_audit --dist="$(new_dist "$name")" --runtime-dist="$(new_runtime_dist "$name")" \
        --plans-dir="$PLANS_PECOTV" --registry="$registry" --exceptions="$file"
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止"
}

# ルート "" の version / ルートの dependencies 宣言 / 依存の version などを 1 箇所だけ差し替える。
mutate_shrinkwrap() {
    node -e '
const fs = require("node:fs")
const [src, out, kind] = process.argv.slice(1)
const sw = JSON.parse(fs.readFileSync(src, "utf8"))
if (kind === "root-version") {
  sw.version = "9.9.9"
  sw.packages[""].version = "9.9.9"
} else if (kind === "root-deps") {
  sw.packages[""].dependencies = { lodash: "^4.17.15" }
} else if (kind === "dep-version") {
  sw.packages["node_modules/lodash"].version = "4.17.21"
} else if (kind === "no-packages") {
  delete sw.packages
} else if (kind === "empty-packages") {
  sw.packages = {}
} else if (kind === "reordered") {
  const flip = (o) => Object.fromEntries(Object.keys(o).reverse().map((k) => [k, o[k]]))
  sw.packages = flip(sw.packages)
  sw.packages["node_modules/lodash"] = flip(sw.packages["node_modules/lodash"])
}
fs.writeFileSync(out, JSON.stringify(sw, null, 2) + "\n")
' "$FIXTURE/npm-shrinkwrap.json" "$1" "$2"
}

runtime_manifest_field() {
    node -e '
const fs = require("node:fs")
const [file, query] = process.argv.slice(1)
const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
const deps = manifest.dependencies || {}
if (query === "name") process.stdout.write(String(manifest.name))
else if (query === "workspace") process.stdout.write(Object.values(deps).filter((r) => /^(workspace|link|file|portal):/.test(r)).join(","))
else if (query === "overrides") process.stdout.write(JSON.stringify(manifest.overrides))
else process.stdout.write(deps[query] === undefined ? "__MISSING__" : String(deps[query]))
' "$T/runtime-manifest.json" "$1" 2> /dev/null || echo "__INVALID_JSON__"
}

write_audit_fixture() {
    node - "$1" "$2" << 'AUDIT_FIXTURE_JS'
const fs = require("node:fs")
const [out, kind] = process.argv.slice(2)
const adv = (id, name, severity) => ({
  source: id, name, dependency: name, title: `${name} advisory`,
  url: `https://github.com/advisories/GHSA-${id}`, severity, range: "*"
})
const trees = {
  // leaf の advisory 1 件が mid へ伝播する（via の文字列要素は経由を表す辺）。
  chain: {
    leaf: { name: "leaf", severity: "high", via: [adv("aaaa-aaaa-aaaa", "leaf", "high")], effects: ["mid"] },
    mid: { name: "mid", severity: "high", via: ["leaf"], effects: [] }
  },
  // 相互参照。訪問中集合で止めないと無限再帰になる。
  cycle: {
    a: { name: "a", severity: "high", via: ["b"], effects: ["b"] },
    b: { name: "b", severity: "high", via: ["a", adv("bbbb-bbbb-bbbb", "b", "high")], effects: ["a"] }
  },
  // cycle のキー順だけを逆にしたもの。列挙順で判定が揺れる退行を検知する (#1071 F-01)。
  cycleRev: {
    b: { name: "b", severity: "high", via: ["a", adv("bbbb-bbbb-bbbb", "b", "high")], effects: ["a"] },
    a: { name: "a", severity: "high", via: ["b"], effects: ["b"] }
  },
  // via の参照先が vulnerabilities に無い（npm が破棄した等）。npm 報告の severity へ倒す。
  orphan: {
    lonely: { name: "lonely", severity: "moderate", via: ["ghost"], effects: [] }
  },
  // 例外対象の advisory と報告に無い文字列参照を併せ持つ。fallback で severity が戻る (#1071 F-02 / F-12)。
  orphanMix: {
    pkg: { name: "pkg", severity: "high", via: [adv("aaaa-aaaa-aaaa", "pkg", "high"), "ghost"], effects: [] }
  },
  // 同一 advisory id が異なる 2 パッケージへ跨るケース (#1071 F-03)。
  dualpkg: {
    pkg1: { name: "pkg1", severity: "high", via: [adv("aaaa-aaaa-aaaa", "pkg1", "high")], effects: [] },
    pkg2: { name: "pkg2", severity: "high", via: [adv("aaaa-aaaa-aaaa", "pkg2", "high")], effects: [] }
  }
}
fs.writeFileSync(out, JSON.stringify({
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, dependencies: { total: 42 } },
  vulnerabilities: trees[kind]
}, null, 2) + "\n")
AUDIT_FIXTURE_JS
}

# stdout は 10 行で、順に status、message、total、critical、high、moderate、low、info、例外件数、blocking 件数。$3 は 0 始まり。
# stdout を監査結果と例外リストの組ごとのファイルに書いて添付し、$3 の行を summary_value に置く。
summary_field() {
    local audit="${1##*/}" exceptions="${2##*/}" out summary
    out="$T/summary-${audit%.json}-${exceptions%.json}.txt"
    node "$SUMMARY_JS" --audit="$1" --exceptions="$2" --label=テスト --fingerprint=ffff \
        --out="$T/unit-summary.json" > "$out"
    summary="$(read_output "$out")"
    summary_value="$(sed -n "$(($3 + 1))p" <<< "$summary")"
}

# release-groups.mjs だけを出力 $2 に差し替え、ほかの呼び出しは実 node へ exec する偽の node を $1 に置く。
make_fake_node() {
    local dir="$1" groups_output="$2" real_node
    real_node="$(command -v node)"
    mkdir -p "$dir"
    cat > "$dir/node" << FAKE_NODE_EOF
#!/bin/bash
case "\${1:-}" in
    *release-groups.mjs)
        printf '%s' '$groups_output'
        exit 0
        ;;
esac
exec "$real_node" "\$@"
FAKE_NODE_EOF
    chmod +x "$dir/node"
}

@test "配布ツリーと永続層に脆弱性が無いと、監査を通して指紋と HEAD を監査記録に残す" {
    explains "カナリアの advisory だけを返す監査先で、配布ツリーと永続層を監査するテストです。終了コード 0 で要約行と pass が出て、監査記録に 2 つの指紋と HEAD と監査先が入ることを確認します。"
    start_mock "$RESPONSES/canary-only.json" case1
    local registry="http://127.0.0.1:$MOCK_PORT" runtime_fp
    run_audit --dist="$(new_dist case1)" --runtime-dist="$(new_runtime_dist case1)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOTV" --registry="$registry"
    assert_success
    assert_output --partial "配布ツリー: 1 パッケージ"
    assert_output --partial "high 0"
    assert_output --partial "永続層: 3 パッケージ"
    assert_output --partial "例外 0 件"
    assert_output --partial "registry $registry"
    assert_output --partial "指紋 "
    assert_stderr --partial "配布ツリー: 1 パッケージ"
    assert_output --partial "監査 pass（high 以上なし）"
    read_fixture_fp
    assert_output --partial "指紋 $fixture_fp"
    # 記録は publish が読む。指紋が dist-fingerprint.mjs の値と一致し、監査時の HEAD が入ることを固定する。
    assert_equal "$(record_field dist.fingerprint)" "$fixture_fp"
    assert_equal "$(record_field head)" "$REPO_HEAD"
    assert_equal "$(record_field registry)" "$registry"
    assert_equal "$(record_field dist.vulnerabilities.high)" "0"
    assert_equal "$(record_field dist.total)" "1"
    run_attached --separate-stderr node "$FINGERPRINT" "$FIXTURE_RUNTIME/npm-shrinkwrap.json"
    assert_success
    runtime_fp="$output"
    assert_equal "$(record_field runtime.fingerprint)" "$runtime_fp"
    assert_not_equal "$runtime_fp" "$fixture_fp"
    assert_equal "$(record_field runtime.vulnerabilities.high)" "0"
    assert_equal "$(record_field runtime.total)" "3"
}

@test "配布ツリーに high の advisory があると、パッケージと advisory を示して中止し、監査記録を消す" {
    explains "配布ツリーの lodash に high の advisory を返す監査先で監査するテストです。終了コード 1 で件数・パッケージ名・title・URL が出て、事前に置いた監査記録が消えることを確認します。"
    start_mock "$RESPONSES/high.json" case2
    place_stale_record
    run_audit --dist="$(new_dist case2)" --runtime-dist="$(new_runtime_dist case2)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_failure 1
    assert_stderr --partial "high 以上の脆弱なパッケージ 1 件"
    assert_stderr --partial "lodash (high)"
    assert_stderr --partial "Prototype Pollution in lodash"
    assert_stderr --partial "https://github.com/advisories/GHSA-p6mc-m468-83gw"
    assert_stderr --partial "配布ツリー: 1 パッケージ"
    # 記録が残ると publish が「監査を通った」と読む。
    refute [ -f "$PECOTV_AUDIT_RECORD" ]
}

@test "監査先が接続を拒否すると、監査未実施として中止し、監査記録を消す" {
    explains "接続を拒否するアドレスを監査先に渡すテストです。終了コード 1 で監査未実施として中止し、pass を出さず、事前に置いた監査記録が消えることを確認します。"
    place_stale_record
    run_audit --dist="$(new_dist case3)" --runtime-dist="$(new_runtime_dist case3)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOTV" --registry="$CLOSED_REGISTRY"
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止"
    refute_output --partial "監査 pass"
    refute [ -f "$PECOTV_AUDIT_RECORD" ]
}

@test "監査先が応答しないと、--timeout の秒数で打ち切って監査未実施として中止する" {
    explains "接続を受けて応答を返さない監査先に、\`--timeout=3\` を付けて監査するテストです。6 秒以内に終了コード 1 で打ち切り、待ち上限の秒数を示して中止することを確認します。"
    start_mock blackhole case4
    local start=$SECONDS elapsed
    run_audit --dist="$(new_dist case4)" --runtime-dist="$(new_runtime_dist case4)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --timeout=3
    elapsed=$((SECONDS - start))
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止"
    assert_stderr --partial "3 秒以内に応答なし"
    [ "$elapsed" -le 6 ] || fail "--timeout=3 が働いていない (${elapsed}s)"
    # 最初の npm 呼び出しはカナリア監査。そこで無応答になるので bulk への到達は 1 件。
    read_mock_requests
    assert_equal "$mock_count" "1"
}

@test "npm_config_registry と --registry の両方があると、--registry の監査先へ問い合わせる" {
    explains "\`npm_config_registry\` に接続を拒否する先を置き、\`--registry\` にモックを渡すテストです。env や \`~/.npmrc\` の監査先が優先されず、モックへ 3 回問い合わせて監査を通すことを確認します。"
    start_mock "$RESPONSES/canary-only.json" case5
    run_attached --separate-stderr env npm_config_registry="$CLOSED_REGISTRY" \
        bash "$AUDIT" --dist="$(new_dist case5)" --runtime-dist="$(new_runtime_dist case5)" \
        --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    # カナリア監査と 2 ツリーの監査で bulk へ 3 回投げる。
    read_mock_requests
    assert_equal "$mock_count" "3"
    assert_output --partial "registry http://127.0.0.1:$MOCK_PORT"
}

@test "pecot-visual の version plan が無いと、監査せずにスキップし、skipped の記録を残す" {
    explains "pecot だけの version plan を渡し、HEAD のリリースタグを空にして監査するテストです。監査先へ問い合わせずにスキップし、HEAD を持つ \`skipped: true\` の記録を残すことを確認します。"
    start_mock "$RESPONSES/canary-only.json" case6
    run_attached --separate-stderr env PECOTV_AUDIT_HEAD_TAGS="" bash "$AUDIT" --dist="$(new_dist case6)" \
        --runtime-dist="$(new_runtime_dist case6)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOT_ONLY" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    assert_output --partial "スキップ: pecot-visual の version plan が無いため"
    read_mock_requests
    assert_equal "$mock_count" "0"
    # publish はこの記録を読んで「監査していないリリース」と判定する。
    assert_equal "$(record_field skipped)" "true"
    assert_equal "$(record_field head)" "$REPO_HEAD"
    assert_equal "$(record_field dist.fingerprint)" "__MISSING__"
}

@test "--dev を付けると、version plan の探索先が無くても開発版として監査する" {
    explains "存在しない version plan の探索先と \`--dev\` を渡すテストです。開発版として監査して pass を出し、\`skipped\` を持たない記録を残すことを確認します。"
    start_mock "$RESPONSES/moderate.json" case6b
    run_audit --dist="$(new_dist case6b)" --runtime-dist="$(new_runtime_dist case6b)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$T/no-such-plans" --dev --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    assert_output --partial "開発版: version plan とリリースタグを見ずに監査する"
    assert_output --partial "監査 pass（high 以上なし）"
    assert_equal "$(record_field skipped)" "__MISSING__"
}

@test "--dev を付けると、high を警告にとどめて続行し、件数を監査記録に残す" {
    explains "\`--dev\` を付けて、永続層と配布ツリーのそれぞれに high の advisory を返す監査先で監査するテストです。どちらも終了コード 0 で警告を出し、high の件数を記録に残すことを確認します。"
    start_mock "$RESPONSES/image-size-high.json" case6c
    run_audit --dist="$(new_dist case6c)" --runtime-dist="$(new_runtime_dist case6c)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$T/no-such-plans" --dev --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    assert_stderr --partial "WARNING: 永続層: high 以上の脆弱なパッケージ 1 件"
    assert_stderr --partial "image-size (high)"
    assert_stderr --partial "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr"
    assert_output --partial "開発版: high 以上 1 件を警告して続行"
    assert_equal "$(record_field runtime.vulnerabilities.high)" "1"
    stop_mock

    start_mock "$RESPONSES/high.json" case6c-dist
    run_audit --dist="$(new_dist case6c-dist)" --runtime-dist="$(new_runtime_dist case6c-dist)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$T/no-such-plans" --dev --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    assert_stderr --partial "WARNING: 配布ツリー: high 以上の脆弱なパッケージ 1 件"
    assert_stderr --partial "lodash (high)"
    # 1 回目と同じパスの記録は添付し直されないので、書き直された記録の写しを添付する。
    cp "$PECOTV_AUDIT_RECORD" "$T/audit-record-case6c-dist.json"
    attach_file "$T/audit-record-case6c-dist.json"
    assert_equal "$(record_field dist.vulnerabilities.high)" "1"
}

@test "--dev を付けても、カナリアを検出できないと監査未実施として中止する" {
    explains "\`--dev\` を付けて、advisory を 1 件も返さない監査先で監査するテストです。開発版でも終了コード 1 で監査未実施として中止し、記録を残さないことを確認します。"
    start_mock "$RESPONSES/no-advisory.json" case6d
    run_audit --dist="$(new_dist case6d)" --runtime-dist="$(new_runtime_dist case6d)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$T/no-such-plans" --dev --registry="http://127.0.0.1:$MOCK_PORT"
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止"
    assert_equal "$(record_field head)" "__ABSENT__"
}

@test "moderate の advisory だけなら、要約行に件数を出して監査を通す" {
    explains "配布ツリーに moderate の advisory だけを返す監査先で監査する、判定の境界の下側のテストです。終了コード 0 で、要約行に \`moderate 1\` と \`high 0\` が出て pass することを確認します。"
    start_mock "$RESPONSES/moderate.json" case7
    run_audit --dist="$(new_dist case7)" --runtime-dist="$(new_runtime_dist case7)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    assert_output --partial "moderate 1"
    assert_output --partial "high 0"
    assert_output --partial "監査 pass（high 以上なし）"
}

@test "critical の advisory だけでも、パッケージと advisory を示して中止する" {
    explains "配布ツリーに critical の advisory だけを返す監査先で監査する、判定の境界の上側のテストです。終了コード 1 で、severity の \`critical\` と advisory の title を示して中止することを確認します。"
    start_mock "$RESPONSES/critical.json" case8
    run_audit --dist="$(new_dist case8)" --runtime-dist="$(new_runtime_dist case8)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_failure 1
    assert_stderr --partial "high 以上の脆弱なパッケージ 1 件"
    assert_stderr --partial "lodash (critical)"
    assert_stderr --partial "Command Injection in lodash"
}

@test "advisory を返さない監査先は、カナリアで見分けて監査未実施として中止する" {
    explains "bulk が 200 と \`{}\` を返す監査先で監査するテストです。脆弱性 0 件と取り違えず、カナリアの不検出で監査未実施として中止し、pass を出さないことを確認します。"
    start_mock "$RESPONSES/no-advisory.json" case9
    run_audit --dist="$(new_dist case9)" --runtime-dist="$(new_runtime_dist case9)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止"
    assert_stderr --partial "既知の advisory を返しません"
    refute_output --partial "監査 pass"
}

@test "pecot-visual か text-rules の宣言を解釈できない version plan があると、問い合わせずに中止する" {
    explains "pecot-visual と text-rules の bump を引用値で書いた version plan を渡すテストです。スキップに倒さず、plan のパスを示して監査未実施として中止し、監査先へ問い合わせないことを確認します。"
    start_mock "$RESPONSES/canary-only.json" case10
    run_audit --dist="$(new_dist case10)" --runtime-dist="$(new_runtime_dist case10)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOTV_QUOTED" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止"
    assert_stderr --partial "998-quoted.md"
    read_mock_requests
    assert_equal "$mock_count" "0"
    stop_mock

    # updateDependents: always により、text-rules の bump は pecot-visual のリリースになる。
    start_mock "$RESPONSES/canary-only.json" case10b
    run_audit --dist="$(new_dist case10b)" --runtime-dist="$(new_runtime_dist case10b)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_TEXT_RULES_QUOTED" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止"
    assert_stderr --partial "996-quoted.md"
    read_mock_requests
    assert_equal "$mock_count" "0"
}

@test "version plan のキーを引用符で囲んでも、宣言として読んで監査する" {
    explains "text-rules と pecot-visual のキーを引用符で囲んだ version plan を渡すテストです。どちらもスキップせずに監査し、監査先へ 3 回問い合わせて pass することを確認します。"
    local plans case_id
    for plans in "$PLANS_TEXT_RULES_QUOTED_KEY" "$PLANS_PECOTV_QUOTED_KEY"; do
        case_id="case-${plans##*/}"
        start_mock "$RESPONSES/canary-only.json" "$case_id"
        run_audit --dist="$(new_dist "$case_id")" --runtime-dist="$(new_runtime_dist "$case_id")" --exceptions="$EXC_EMPTY" \
            --plans-dir="$plans" --registry="http://127.0.0.1:$MOCK_PORT"
        assert_success
        assert_output --partial "監査 pass（high 以上なし）"
        read_mock_requests
        assert_equal "$mock_count" "3"
        stop_mock
    done
}

@test "version plan の探索先が存在しないと、中止する" {
    explains "存在しないディレクトリを \`--plans-dir\` に渡すテストです。終了コード 1 で、探索先が無いことを理由に示して中止することを確認します。"
    run_audit --dist="$(new_dist case11)" --runtime-dist="$(new_runtime_dist case11)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$T/plans-missing" --registry="$CLOSED_REGISTRY"
    assert_failure 1
    assert_stderr --partial "version plan の探索先がありません"
}

@test "--timeout=0 を渡すと、正の整数を求めて中止する" {
    explains "待ち上限の無効化にあたる \`--timeout=0\` を渡すテストです。coreutils の \`timeout\` が上限なしと扱う値を受け付けず、終了コード 1 で正の整数を求めることを確認します。"
    run_audit --dist="$(new_dist case12)" --runtime-dist="$(new_runtime_dist case12)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOTV" --registry="$CLOSED_REGISTRY" --timeout=0
    assert_failure 1
    assert_stderr --partial "正の整数"
}

@test "dist-manifest.mjs を直接起動すると、import 経由と同じ依存を持つ配布 package.json を出力する" {
    explains "\`dist-manifest.mjs\` を直接起動して、出力の JSON を publish が使う import 経由の結果と比べるテストです。依存が一致し、text-rules の依存を範囲ごと含み、引数不足では usage を出すことを確認します。"
    run_attached --separate-stderr node "$MANIFEST_JS" "$PECOTV_PLUGIN_ROOT" 0.0.0-test "$REPO_ROOT"
    assert_success
    printf '%s\n' "$output" > "$T/manifest.json"

    local version direct_deps import_deps gap
    version="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version))' \
        "$T/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"
    assert_equal "$version" "0.0.0-test"

    direct_deps="$(node -e 'const fs=require("node:fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).dependencies||{};process.stdout.write(Object.keys(d).sort().join(","))' \
        "$T/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"
    cat > "$T/manifest-import.mjs" << 'IMPORT_EOF'
import { pathToFileURL } from 'node:url'
const [modPath, pecotvRoot, repoRoot] = process.argv.slice(2)
const { buildDistManifest } = await import(pathToFileURL(modPath).href)
const deps = buildDistManifest(pecotvRoot, '0.0.0-test', repoRoot).dependencies
process.stdout.write(Object.keys(deps).sort().join(','))
IMPORT_EOF
    run_attached --separate-stderr node "$T/manifest-import.mjs" "$MANIFEST_JS" "$PECOTV_PLUGIN_ROOT" "$REPO_ROOT"
    assert_success
    import_deps="$output"
    assert_equal "$direct_deps" "$import_deps"
    # 同梱する text-rules の依存は、名前を列挙せず libs/text-rules/package.json の宣言と範囲まで比べる。
    gap="$(node -e '
const fs = require("node:fs")
const textRules = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dependencies
const out = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).dependencies
const gap = Object.entries(textRules).filter(([name, range]) => out[name] !== range).map(([name]) => name)
process.stdout.write(Object.keys(textRules).length === 0 ? "TEXT_RULES_HAS_NO_DEPENDENCIES" : gap.sort().join(","))
' "$REPO_ROOT/libs/text-rules/package.json" "$T/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"
    assert_equal "$gap" ""
    [ -n "$import_deps" ] || fail "dependencies が空（比較が無意味になっている）"

    run_attached --separate-stderr node "$MANIFEST_JS"
    assert_failure 1
    assert_stderr --partial "usage: dist-manifest.mjs"
    assert_stderr --partial "<repo-root>"
}

@test "version plan が無くても HEAD に同じ版のリリースタグがあると、再監査する" {
    explains "publish が指紋の不一致で止まった後に、release commit で記録を作り直す場面のテストです。HEAD に同じ版のタグがあれば plan 無しでも監査し、別版のタグだけならスキップすることを確認します。"
    # タグは worktree 間で共有されるので作らず、PECOTV_AUDIT_HEAD_TAGS で差し替える。
    start_mock "$RESPONSES/canary-only.json" case14
    run_attached --separate-stderr env PECOTV_AUDIT_HEAD_TAGS="pecot-visual-v$PLUGIN_VERSION" bash "$AUDIT" \
        --dist="$(new_dist case14)" --runtime-dist="$(new_runtime_dist case14)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOT_ONLY" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    assert_output --partial "再監査: HEAD に pecot-visual-v$PLUGIN_VERSION"
    assert_output --partial "監査 pass（high 以上なし）"
    read_mock_requests
    assert_equal "$mock_count" "3"
    assert_equal "$(record_field skipped)" "__MISSING__"
    read_fixture_fp
    assert_equal "$(record_field dist.fingerprint)" "$fixture_fp"
    stop_mock

    # 無関係なタグしか無ければスキップする（タグ判定が総当たりでないこと）。
    start_mock "$RESPONSES/canary-only.json" case14b
    run_attached --separate-stderr env PECOTV_AUDIT_HEAD_TAGS="$(printf 'pecot-workflow-v1.0.0\npecot-visual-v0.0.0-other')" bash "$AUDIT" \
        --dist="$(new_dist case14b)" --runtime-dist="$(new_runtime_dist case14b)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_PECOT_ONLY" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    assert_output --partial "スキップ: pecot-visual の version plan が無いため"
}

@test "依存先の text-rules の version plan だけでも監査し、無関係な group だけの plan ではスキップする" {
    explains "text-rules だけの version plan と、pecot-workflow だけの version plan を渡すテストです。前者は監査先へ 3 回問い合わせて監査し、後者は問い合わせずに \`skipped: true\` の記録を残すことを確認します。"
    start_mock "$RESPONSES/canary-only.json" case14c
    run_attached --separate-stderr env PECOTV_AUDIT_HEAD_TAGS="" bash "$AUDIT" \
        --dist="$(new_dist case14c)" --runtime-dist="$(new_runtime_dist case14c)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_TEXT_RULES" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    assert_output --partial "監査 pass（high 以上なし）"
    refute_output --partial "スキップ"
    read_mock_requests
    assert_equal "$mock_count" "3"
    assert_equal "$(record_field skipped)" "__MISSING__"
    stop_mock

    start_mock "$RESPONSES/canary-only.json" case14d
    run_attached --separate-stderr env PECOTV_AUDIT_HEAD_TAGS="" bash "$AUDIT" \
        --dist="$(new_dist case14d)" --runtime-dist="$(new_runtime_dist case14d)" --exceptions="$EXC_EMPTY" \
        --plans-dir="$PLANS_WORKFLOW_ONLY" --registry="http://127.0.0.1:$MOCK_PORT"
    assert_success
    assert_output --partial "スキップ: pecot-visual の version plan が無いため"
    read_mock_requests
    assert_equal "$mock_count" "0"
    # 1 回目と同じパスの記録は添付し直されないので、書き直された記録の写しを添付する。
    cp "$PECOTV_AUDIT_RECORD" "$T/audit-record-case14d.json"
    attach_file "$T/audit-record-case14d.json"
    assert_equal "$(record_field skipped)" "true"
}

@test "release-groups.mjs は、workspace: 依存のある group だけを対象にし、引けない group があると中止する" {
    explains "\`release-groups.mjs\` を、実リポジトリと、workspace の依存を 2 つ持つ fixture で動かすテストです。依存先の group だけを列挙し、依存先を含む group が \`nx.json\` に無ければ終了コード 1 で止まることを確認します。"
    run_attached --separate-stderr node "$RELEASE_DIR/release-groups.mjs" "$REPO_ROOT"
    assert_success
    assert_equal "$(paste -sd ',' - <<< "$output")" "pecot-visual,text-rules"

    # 別の workspace 依存が増えても、列挙し直さずに追従することを fixture で見る。
    local repo="$T/groups-repo" lib
    mkdir -p "$repo/plugins/pecot-visual" "$repo/libs/alpha" "$repo/libs/beta" "$repo/libs/gamma"
    cat > "$repo/plugins/pecot-visual/package.json" << 'JSON_EOF'
{ "name": "fixture", "dependencies": { "@fx/alpha-pkg": "workspace:*", "left-pad": "1.0.0" }, "devDependencies": { "@fx/beta-pkg": "workspace:^" } }
JSON_EOF
    printf 'packages:\n  - libs/alpha\n  - libs/beta\n  - libs/gamma\n' > "$repo/pnpm-workspace.yaml"
    for lib in alpha beta gamma; do
        printf '{ "name": "@fx/%s-pkg" }\n' "$lib" > "$repo/libs/$lib/package.json"
        printf '{ "name": "%s-project" }\n' "$lib" > "$repo/libs/$lib/project.json"
    done
    cat > "$repo/nx.json" << 'JSON_EOF'
{ "release": { "groups": {
  "pecot-visual": { "projects": ["pecot-visual"] },
  "alpha-group": { "projects": ["alpha-project"] },
  "beta-group": { "projects": ["beta-project"] },
  "gamma-group": { "projects": ["gamma-project"] }
} } }
JSON_EOF
    run_attached --separate-stderr node "$RELEASE_DIR/release-groups.mjs" "$repo"
    assert_success
    assert_equal "$(paste -sd ',' - <<< "$output")" "pecot-visual,alpha-group,beta-group"

    cat > "$repo/nx.json" << 'JSON_EOF'
{ "release": { "groups": { "pecot-visual": { "projects": ["pecot-visual"] } } } }
JSON_EOF
    run_attached --separate-stderr node "$RELEASE_DIR/release-groups.mjs" "$repo"
    assert_failure 1
    assert_stderr --partial "alpha-project"
}

@test "dist-fingerprint.mjs は、ルートの version とキー順を除いた依存ツリーから指紋を求める" {
    explains "\`dist-fingerprint.mjs\` に、shrinkwrap を 1 箇所ずつ変えた変種を渡すテストです。監査と publish で同じ値になるようルートの version とキー順では変わらず、依存の変化では変わることを確認します。"
    read_fixture_fp
    assert_regex "$fixture_fp" '^[0-9a-f]{64}$'

    mutate_shrinkwrap "$T/sw-root-version.json" root-version
    run_attached --separate-stderr node "$FINGERPRINT" "$T/sw-root-version.json"
    assert_success
    assert_output "$fixture_fp"
    mutate_shrinkwrap "$T/sw-root-deps.json" root-deps
    run_attached --separate-stderr node "$FINGERPRINT" "$T/sw-root-deps.json"
    assert_success
    refute_output "$fixture_fp"
    mutate_shrinkwrap "$T/sw-dep-version.json" dep-version
    run_attached --separate-stderr node "$FINGERPRINT" "$T/sw-dep-version.json"
    assert_success
    refute_output "$fixture_fp"
    mutate_shrinkwrap "$T/sw-reordered.json" reordered
    run_attached --separate-stderr node "$FINGERPRINT" "$T/sw-reordered.json"
    assert_success
    assert_output "$fixture_fp"

    mutate_shrinkwrap "$T/sw-no-packages.json" no-packages
    run_attached --separate-stderr node "$FINGERPRINT" "$T/sw-no-packages.json"
    assert_failure 1
    assert_stderr --partial "packages がありません"
    # 依存解決が丸ごと失敗した shrinkwrap（ルート "" が無い）を、有効な指紋として扱わない。
    mutate_shrinkwrap "$T/sw-empty-packages.json" empty-packages
    run_attached --separate-stderr node "$FINGERPRINT" "$T/sw-empty-packages.json"
    assert_failure 1
    assert_stderr --partial 'ルート "" がありません'

    run_attached --separate-stderr node "$FINGERPRINT"
    assert_failure 1
    assert_stderr --partial "usage: dist-fingerprint.mjs"
}

@test "永続層の high を例外リストで免除すると、免除した advisory を列挙して監査を通す" {
    explains "永続層の image-size の advisory 2 件を、例外リストで免除するテストです。終了コード 0 で、免除した advisory を出力と記録に列挙し、high の件数が 0 になることを確認します。"
    local exceptions="$T/exceptions-image-size.json"
    write_exceptions "$exceptions" "GHSA-w3rx-r6r6-pgpr,image-size" "GHSA-5p2g-fcmc-qvqq,image-size"
    start_mock "$RESPONSES/image-size-high.json" case16
    run_audit --dist="$(new_dist case16)" --runtime-dist="$(new_runtime_dist case16)" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$exceptions"
    assert_success
    assert_output --partial "例外 2 件"
    assert_output --partial "永続層の例外適用: GHSA-w3rx-r6r6-pgpr image-size (high)"
    assert_output --partial "永続層の例外適用: GHSA-5p2g-fcmc-qvqq image-size (high)"
    assert_stderr --partial "永続層の例外適用: GHSA-w3rx-r6r6-pgpr image-size (high)"
    assert_output --partial "監査 pass（high 以上なし）"
    assert_equal "$(record_field runtime.excepted.length)" "2"
    assert_equal "$(record_field runtime.excepted.0.severity)" "high"
    assert_equal "$(record_field runtime.excepted.0.advisory)" "GHSA-5p2g-fcmc-qvqq"
    assert_equal "$(record_field runtime.vulnerabilities.high)" "0"
    assert_equal "$(record_field dist.excepted.length)" "0"
}

@test "例外リストが空だと、永続層の high で中止し、監査記録を残さない" {
    explains "永続層に high の advisory を返す監査先で、空の例外リストを渡すテストです。例外の仕組みが常に判定を免れさせず、終了コード 1 で永続層の high を示して中止することを確認します。"
    start_mock "$RESPONSES/image-size-high.json" case17
    run_audit --dist="$(new_dist case17)" --runtime-dist="$(new_runtime_dist case17)" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$EXC_EMPTY"
    assert_failure 1
    assert_stderr --partial "永続層: high 以上の脆弱なパッケージ 1 件"
    assert_stderr --partial "image-size (high)"
    assert_stderr --partial "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr"
    assert_stderr --partial "配布ツリー: 1 パッケージ"
    refute [ -f "$PECOTV_AUDIT_RECORD" ]
}

@test "例外リストが 1 件不足していると、残る advisory で中止する" {
    explains "永続層の advisory 2 件のうち 1 件だけを例外リストに載せるテストです。終了コード 1 で、適用した例外の件数を要約行に出し、残る advisory で中止することを確認します。"
    local exceptions="$T/exceptions-image-size-one.json"
    write_exceptions "$exceptions" "GHSA-w3rx-r6r6-pgpr,image-size"
    start_mock "$RESPONSES/image-size-high.json" case18
    run_audit --dist="$(new_dist case18)" --runtime-dist="$(new_runtime_dist case18)" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$exceptions"
    assert_failure 1
    assert_stderr --partial "例外 1 件"
    assert_stderr --partial "永続層: high 以上の脆弱なパッケージ 1 件"
}

@test "advisory の id は一致するが package が違う例外は、陳腐化として監査未実施で中止する" {
    explains "実在する advisory の id を、別の package の名前で例外リストに載せるテストです。例外なしに倒さず、終了コード 1 でツリーと id を示して監査未実施として中止し、記録を残さないことを確認します。"
    local exceptions="$T/exceptions-wrong-package.json"
    write_exceptions "$exceptions" "GHSA-w3rx-r6r6-pgpr,lodash"
    start_mock "$RESPONSES/image-size-high.json" case19
    run_audit --dist="$(new_dist case19)" --runtime-dist="$(new_runtime_dist case19)" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$exceptions"
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止"
    assert_stderr --partial "永続層"
    assert_stderr --partial "GHSA-w3rx-r6r6-pgpr"
    refute [ -f "$PECOTV_AUDIT_RECORD" ]
}

@test "配布ツリーの high も、例外リストの同じ規則で免除する" {
    explains "配布ツリーの lodash の advisory を例外リストで免除するテストです。終了コード 0 で、配布ツリー側でも免除した advisory を列挙し、high が 0 件の要約行と記録になることを確認します。"
    local exceptions="$T/exceptions-lodash.json"
    write_exceptions "$exceptions" "GHSA-p6mc-m468-83gw,lodash"
    start_mock "$RESPONSES/high.json" case20
    run_audit --dist="$(new_dist case20)" --runtime-dist="$(new_runtime_dist case20)" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$exceptions"
    assert_success
    assert_output --partial "配布ツリーの例外適用: GHSA-p6mc-m468-83gw lodash (high)"
    assert_output --partial "配布ツリー: 1 パッケージ / critical 0 / high 0"
    assert_output --partial "監査 pass（high 以上なし）"
    assert_equal "$(record_field dist.excepted.length)" "1"
}

@test "形の違う例外リストや存在しない例外リストを渡すと、監査未実施として中止する" {
    explains "破損した JSON や必須の項目が欠けた例外リストと、存在しない例外リストを渡すテストです。判定を緩める記載を例外なしに倒さず、どれも終了コード 1 で中止することを確認します。"
    local bad="$T/bad-exceptions"
    mkdir -p "$bad"
    printf 'not json\n' > "$bad/broken.json"
    printf '{"exceptions": {}}\n' > "$bad/not-array.json"
    write_exceptions "$bad/bad-id.json" "CVE-2024-0001,image-size"
    write_exceptions "$bad/duplicate.json" "GHSA-w3rx-r6r6-pgpr,image-size" "GHSA-w3rx-r6r6-pgpr,image-size"
    cat > "$bad/empty-reason.json" << 'JSON_EOF'
{ "exceptions": [{ "advisory": "GHSA-w3rx-r6r6-pgpr", "package": "image-size", "reason": "" }] }
JSON_EOF
    # added / reevaluate も reason と同じく必須（非空文字列）(#1071 F-18)。
    cat > "$bad/empty-added.json" << 'JSON_EOF'
{ "exceptions": [{ "advisory": "GHSA-w3rx-r6r6-pgpr", "package": "image-size", "reason": "テスト用", "added": "", "reevaluate": "テスト用" }] }
JSON_EOF
    cat > "$bad/missing-reevaluate.json" << 'JSON_EOF'
{ "exceptions": [{ "advisory": "GHSA-w3rx-r6r6-pgpr", "package": "image-size", "reason": "テスト用", "added": "2026-09-07" }] }
JSON_EOF

    start_mock "$RESPONSES/image-size-high.json" case21
    local registry="http://127.0.0.1:$MOCK_PORT" kind
    for kind in broken not-array bad-id duplicate empty-reason empty-added missing-reevaluate; do
        check_bad_exceptions "case21-$kind" "$bad/$kind.json" "$registry"
    done
    stop_mock

    # 既定パスの不在だけが「例外なし」。明示した例外リストの不在は中止する。
    run_audit --dist="$(new_dist case21h)" --runtime-dist="$(new_runtime_dist case21h)" \
        --plans-dir="$PLANS_PECOTV" --registry="$CLOSED_REGISTRY" --exceptions="$T/exceptions-missing.json"
    assert_failure 1
    assert_stderr --partial "指定された例外リストがありません"
}

@test "--dist と --runtime-dist の片方だけを渡すと、両方の指定を求めて中止する" {
    explains "\`--dist\` だけ、\`--runtime-dist\` だけを渡すテストです。もう一方がモックの \`{}\` による 0 件の pass にならないよう、引数を読んだ時点で終了コード 1 を返すことを確認します。"
    run_audit --dist="$(new_dist case22a)" --plans-dir="$PLANS_PECOTV" \
        --registry="$CLOSED_REGISTRY" --exceptions="$EXC_EMPTY"
    assert_failure 1
    assert_stderr --partial "両方指定するか両方省略"

    run_audit --runtime-dist="$(new_runtime_dist case22b)" --plans-dir="$PLANS_PECOTV" \
        --registry="$CLOSED_REGISTRY" --exceptions="$EXC_EMPTY"
    assert_failure 1
    assert_stderr --partial "両方指定するか両方省略"
}

@test "永続層に lockfile が無いと、永続層で止まった旨を示して監査未実施として中止する" {
    explains "\`npm-shrinkwrap.json\` の無い永続層を渡すテストです。2 つのツリーを同じ関数で監査するので、中止の文言に永続層の名前が入り、記録を残さないことを確認します。"
    local runtime="$T/runtime-case23-nolock"
    mkdir -p "$runtime"
    cp "$FIXTURE_RUNTIME/package.json" "$runtime/"
    start_mock "$RESPONSES/canary-only.json" case23
    run_audit --dist="$(new_dist case23)" --runtime-dist="$runtime" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$EXC_EMPTY"
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止: 永続層:"
    refute [ -f "$PECOTV_AUDIT_RECORD" ]
}

@test "runtime-manifest.mjs を直接起動すると、中核パッケージの版を固定した永続層の package.json を出力する" {
    explains "\`runtime-manifest.mjs\` を直接起動して、出力の JSON を見るテストです。\`@slidev/cli\` の版で中核パッケージを固定し、overrides と catalog の範囲を写し、ローカル参照を含まないことを確認します。"
    run_attached --separate-stderr node "$RUNTIME_MANIFEST_JS" "$PECOTV_PLUGIN_ROOT"
    assert_success
    printf '%s\n' "$output" > "$T/runtime-manifest.json"

    assert_equal "$(runtime_manifest_field name)" "pecotv-runtime"
    local core_pin overrides catalog_vite
    core_pin="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).dependencies["@slidev/cli"]))' \
        "$PECOTV_PLUGIN_ROOT/assets/slidev/runtime/package.json")"
    assert_equal "$(runtime_manifest_field @slidev/cli)" "$core_pin"
    assert_equal "$(runtime_manifest_field @slidev/client)" "$core_pin"
    assert_equal "$(runtime_manifest_field @slidev/parser)" "$core_pin"
    assert_not_equal "$(runtime_manifest_field dom-to-pptx)" "__MISSING__"
    assert_equal "$(runtime_manifest_field workspace)" ""
    assert_equal "$(runtime_manifest_field playwright)" "__MISSING__"

    overrides="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).overrides))' \
        "$PECOTV_PLUGIN_ROOT/assets/slidev/runtime/package.json")"
    assert_equal "$(runtime_manifest_field overrides)" "$overrides"

    # vite は catalog: で参照される。直接起動の出力では catalog の範囲に解決され、catalog: が残らない。
    catalog_vite="$(cd "$REPO_ROOT" && node -e '
const { parse } = require("yaml")
const w = parse(require("node:fs").readFileSync("pnpm-workspace.yaml", "utf8"))
process.stdout.write(String((w.catalog ?? w.catalogs?.default ?? {}).vite))')"
    assert_equal "$(runtime_manifest_field vite)" "$catalog_vite"
    refute grep -qF 'catalog:' "$T/runtime-manifest.json"

    run_attached --separate-stderr node "$RUNTIME_MANIFEST_JS"
    assert_failure 1
    assert_stderr --partial "usage: runtime-manifest.mjs"
}

@test "audit-summary.mjs は、via の伝播・循環・例外の適用を、キーの並びによらず数える" {
    explains "\`audit-summary.mjs\` に、via の連鎖・循環・参照先の欠け・同じ advisory の 2 パッケージを持つ合成の監査結果を渡すテストです。high と例外の件数が期待どおりで、陳腐化した例外は \`UNAVAILABLE\` になることを確認します。"
    local kind cycle_blocking
    for kind in chain cycle cycleRev orphan orphanMix dualpkg; do
        write_audit_fixture "$T/unit-$kind.json" "$kind"
    done
    write_exceptions "$T/exceptions-leaf.json" "GHSA-aaaa-aaaa-aaaa,leaf"
    write_exceptions "$T/exceptions-unused.json" "GHSA-zzzz-zzzz-zzzz,nothing"
    write_exceptions "$T/exceptions-pkg.json" "GHSA-aaaa-aaaa-aaaa,pkg"
    write_exceptions "$T/exceptions-stale-other.json" "GHSA-aaaa-aaaa-aaaa,other-pkg"
    write_exceptions "$T/exceptions-dualpkg.json" "GHSA-aaaa-aaaa-aaaa,pkg1" "GHSA-aaaa-aaaa-aaaa,pkg2"

    summary_field "$T/unit-chain.json" "$EXC_EMPTY" 4
    assert_equal "$summary_value" "2"
    summary_field "$T/unit-chain.json" "$EXC_EMPTY" 9
    assert_equal "$summary_value" "2"
    summary_field "$T/unit-chain.json" "$T/exceptions-leaf.json" 4
    assert_equal "$summary_value" "0"
    summary_field "$T/unit-chain.json" "$T/exceptions-leaf.json" 8
    assert_equal "$summary_value" "1"
    summary_field "$T/unit-chain.json" "$EXC_EMPTY" 2
    assert_equal "$summary_value" "42"
    summary_field "$T/unit-cycle.json" "$EXC_EMPTY" 4
    assert_equal "$summary_value" "2"
    summary_field "$T/unit-orphan.json" "$EXC_EMPTY" 5
    assert_equal "$summary_value" "1"
    summary_field "$T/unit-chain.json" "$T/exceptions-unused.json" 8
    assert_equal "$summary_value" "0"
    summary_field "$T/unit-chain.json" "$T/exceptions-unused.json" 4
    assert_equal "$summary_value" "2"

    # 一度も一致しなかった例外は、判定を変えずに excepted-out へ「例外未適用」として 1 行残す (#1071 F-11)。
    node "$SUMMARY_JS" --audit="$T/unit-chain.json" --exceptions="$T/exceptions-unused.json" \
        --label=テスト --fingerprint=ffff --out="$T/unit-summary-unused.json" \
        --excepted-out="$T/unused-excepted-out.txt" > /dev/null
    run read_output "$T/unused-excepted-out.txt"
    assert_success
    assert_output --partial "テストの例外未適用: GHSA-zzzz-zzzz-zzzz nothing"

    # 修正前は Object.keys の列挙順に判定が依存し、high 件数が 2 件から 1 件へ減っていた (#1071 F-01)。
    summary_field "$T/unit-cycle.json" "$EXC_EMPTY" 4
    assert_equal "$summary_value" "2"
    summary_field "$T/unit-cycleRev.json" "$EXC_EMPTY" 4
    assert_equal "$summary_value" "2"
    summary_field "$T/unit-cycle.json" "$EXC_EMPTY" 9
    cycle_blocking="$summary_value"
    summary_field "$T/unit-cycleRev.json" "$EXC_EMPTY" 9
    assert_equal "$summary_value" "$cycle_blocking"

    # fallback で severity が戻る理由を blocking の advisory 行に残す (#1071 F-02 / F-12)。
    summary_field "$T/unit-orphanMix.json" "$T/exceptions-pkg.json" 4
    assert_equal "$summary_value" "1"
    summary_field "$T/unit-orphanMix.json" "$T/exceptions-pkg.json" 8
    assert_equal "$summary_value" "1"
    node "$SUMMARY_JS" --audit="$T/unit-orphanMix.json" --exceptions="$T/exceptions-pkg.json" \
        --label=テスト --fingerprint=ffff --out="$T/unit-summary-orphanmix.json" \
        --blocking-out="$T/orphan-mix-blocking.txt" > /dev/null
    run read_output "$T/orphan-mix-blocking.txt"
    assert_success
    assert_output --partial "advisory の参照先 ghost が報告に載っていない"

    # 同一 advisory id が 2 パッケージへ跨る例外は、重複エラーにならず両方へ独立に適用される (#1071 F-03)。
    summary_field "$T/unit-dualpkg.json" "$T/exceptions-dualpkg.json" 4
    assert_equal "$summary_value" "0"
    summary_field "$T/unit-dualpkg.json" "$T/exceptions-dualpkg.json" 8
    assert_equal "$summary_value" "2"
    # advisory と package の組をキーにしても、登録 package の不一致は陳腐化として UNAVAILABLE になる。
    run_attached --separate-stderr node "$SUMMARY_JS" --audit="$T/unit-chain.json" --exceptions="$T/exceptions-stale-other.json" \
        --label=テスト --fingerprint=ffff --out="$T/unit-summary-stale.json"
    assert_line --index 0 "UNAVAILABLE"
    assert_output --partial "GHSA-aaaa-aaaa-aaaa"

    run_attached --separate-stderr node "$SUMMARY_JS"
    assert_failure 1
    assert_stderr --partial "usage: audit-summary.mjs"
}

@test "配布ツリーと永続層の両方に high があると、両方のツリーのエラーを出して中止する" {
    explains "配布ツリーの lodash と永続層の image-size の両方に high の advisory を返す監査先で監査するテストです。終了コード 1 で、2 つのツリーのエラーのまとまりが両方出ることを確認します。"
    start_mock "$RESPONSES/both-high.json" case26
    run_audit --dist="$(new_dist case26)" --runtime-dist="$(new_runtime_dist case26)" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$EXC_EMPTY"
    assert_failure 1
    assert_stderr --partial "配布ツリー: high 以上の脆弱なパッケージ 1 件"
    assert_stderr --partial "lodash (high)"
    assert_stderr --partial "永続層: high 以上の脆弱なパッケージ 1 件"
    assert_stderr --partial "image-size (high)"
}

@test "永続層の依存解決に失敗すると、永続層で止まった旨を示して監査未実施として中止する" {
    explains "\`npm install\` だけを差し替え、配布ツリーでは成功させ、永続層では失敗させるテストです。\`install\` を 2 回呼んだ後に永続層で止まった旨を示して中止し、記録を残さないことを確認します。"
    # npm audit は実 npm だが、監査先は --registry のモックなので実レジストリへは出ない。
    local stub="$T/case27-npm" count real_npm install_count
    count="$stub/install-count"
    real_npm="$(command -v npm)"
    mkdir -p "$stub"
    echo 0 > "$count"
    cat > "$stub/npm" << STUB_EOF
#!/bin/bash
# resolve_tree() の npm install だけを差し替え、ほかは実 npm に委譲する。
if [ "\$1" != "install" ]; then
    exec "$real_npm" "\$@"
fi
N=\$(( \$(cat "$count") + 1 ))
echo "\$N" > "$count"
if [ "\$N" -eq 1 ]; then
    cp "$FIXTURE/npm-shrinkwrap.json" package-lock.json
    exit 0
fi
echo "stub npm install: 依存解決に失敗（テスト注入）" >&2
exit 1
STUB_EOF
    chmod +x "$stub/npm"

    start_mock "$RESPONSES/canary-only.json" case27
    run_attached --separate-stderr env PATH="$stub:$PATH" bash "$AUDIT" --plans-dir="$PLANS_PECOTV" \
        --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$EXC_EMPTY"
    assert_failure 1
    assert_stderr --partial "監査未実施のため中止: 永続層: 依存解決に失敗しました"
    assert_output --partial "配布ツリーの依存を監査"
    install_count="$(read_output "$count")"
    assert_equal "$install_count" "2"
    refute [ -f "$PECOTV_AUDIT_RECORD" ]
}

@test "release group の解決結果が空か空要素を含むと、監査先へ問い合わせずに中止する" {
    explains "偽の \`node\` で \`release-groups.mjs\` の出力を、空と、空行を含む形に差し替えるテストです。空の group 名を宣言ありと読まず、問い合わせずに監査未実施として中止し、記録を残さないことを確認します。"
    make_fake_node "$T/case29a-node" ""
    make_fake_node "$T/case29b-node" "$(printf 'pecot-visual\n\ntext-rules')"
    local variant
    for variant in a b; do
        rm -f "$PECOTV_AUDIT_RECORD"
        start_mock "$RESPONSES/canary-only.json" "case29$variant"
        run_attached --separate-stderr env PATH="$T/case29$variant-node:$PATH" bash "$AUDIT" \
            --dist="$(new_dist "case29$variant")" --runtime-dist="$(new_runtime_dist "case29$variant")" \
            --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$EXC_EMPTY"
        assert_failure
        assert_stderr --partial "監査未実施のため中止: release group"
        read_mock_requests
        assert_equal "$mock_count" "0"
        refute [ -f "$PECOTV_AUDIT_RECORD" ]
        stop_mock
    done
}

@test "同梱の audit-exceptions.json は、loadExceptions が読める例外リストの形を満たす" {
    explains "既定の \`audit-exceptions.json\` を \`audit-summary.mjs\` の \`loadExceptions\` で読むテストです。ほかのケースは一時ファイルを渡すので、実在のファイルの書き損じをここで検出できることを確認します。"
    run_attached env SUMMARY_JS="$SUMMARY_JS" EXC="$RELEASE_DIR/audit-exceptions.json" node --input-type=module -e '
import { pathToFileURL } from "node:url"
const { loadExceptions } = await import(pathToFileURL(process.env.SUMMARY_JS).href)
loadExceptions(process.env.EXC)
'
    assert_success
}
