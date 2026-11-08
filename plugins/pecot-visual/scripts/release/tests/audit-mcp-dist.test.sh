#!/bin/bash
# audit-mcp-dist.sh（pecot-visual がリリースする依存ツリーを監査し、問題があれば止める処理）の検証 (#1050 / #1071)。
#
# 監査先レジストリをローカルの node http サーバに差し替えるので、ネットワークには依存しない。
# 監査対象の 2 ツリーは、どちらも fixture を --dist / --runtime-dist で渡す。
# 配布ツリーは fixtures/audit/ の lodash、永続層は fixtures/audit-runtime/ の image-size になる。
# manifest の生成と npm install による依存解決は行わない。本テストの対象は判定と終了コードとなる。
# 例外リストも全ケースで明示し、既定の audit-exceptions.json に合否を左右させない。
#
# `set -e` は使わない。監査失敗の検証で、非ゼロ終了を意図的に発生させる。
set -u

# git hook (pre-push の nx affected 等) から起動されると、git が GIT_DIR / GIT_INDEX_FILE を export する。
# 被テストスクリプトの git env unset の効果を打ち消しかねないので、先頭で捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
AUDIT="$RELEASE_DIR/audit-mcp-dist.sh"
FINGERPRINT="$RELEASE_DIR/dist-fingerprint.mjs"
SUMMARY_JS="$RELEASE_DIR/audit-summary.mjs"
RUNTIME_MANIFEST_JS="$RELEASE_DIR/runtime-manifest.mjs"
FIXTURE="$SCRIPT_DIR/fixtures/audit"
FIXTURE_RUNTIME="$SCRIPT_DIR/fixtures/audit-runtime"

# 被テストスクリプトは、何も指定しなければリポジトリ本体の .nx/release-audit/ へ記録を書く。
# --audit-record や env の渡し忘れで、開発者の記録に触れていないことを末尾で確かめる。
# 実行前後の一致では見られない。同じ checkout で並行して動く別のリリース系コマンドの書き込みを拾い、
# 偽の FAIL になる。そこで、テスト自身が書いたかどうかだけを見る。
REAL_RECORD_FILE="$REPO_ROOT/.nx/release-audit/pecotv-audit.json"
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

PASS=0
FAIL=0
fail() {
    echo "FAIL: $1"
    FAIL=$((FAIL + 1))
}
pass() {
    echo "PASS: $1"
    PASS=$((PASS + 1))
}
# 期待値との一致を 1 行で判定する（不一致時に actual を必ず出す）。
assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$label"
    else
        fail "$label (expected='$expected' actual='$actual')"
    fi
}
# 期待値と一致しないことを 1 行で判定する。
assert_ne() {
    local label="$1" unexpected="$2" actual="$3"
    if [ "$unexpected" != "$actual" ]; then
        pass "$label"
    else
        fail "$label (一致してはいけない値と一致した: '$actual')"
    fi
}
# 出力ファイルに文字列が含まれることを判定する。
assert_contains() {
    local label="$1" needle="$2" file="$3"
    if grep -qF -- "$needle" "$file"; then
        pass "$label"
    else
        OUTPUT_TAIL="$(tail -5 "$file" | tr '\n' ' ')"
        fail "$label (出力に '$needle' が無い: $OUTPUT_TAIL)"
    fi
}

# 語の一覧なしで通ることを確かめるため、開発者の shell の値を引き継がない。
unset PECOT_BRAND_TERMS_FILE
TMP=$(mktemp -d)
# 監査記録の既定は <repo>/.nx/release-audit/pecotv-audit.json。テストは全ケースで
# $TMP 配下へ向け、リポジトリ本体の記録に触れない。
export PECOTV_AUDIT_RECORD="$TMP/audit-record.json"
# npm audit は advisory の評価結果を cacache へ `security-advisory:<name>:<id>` で保存し、
# キーに severity は含まれない。共有キャッシュ (~/.npm/_cacache) のままだと、同じ id を
# 別 severity で評価済みのマシンで判定が変わり、合否がホームディレクトリの状態に左右される。
export npm_config_cache="$TMP/npm-cache"
MOCK_PID=""
cleanup() {
    [ -n "$MOCK_PID" ] && kill "$MOCK_PID" > /dev/null 2>&1
    rm -rf "$TMP"
}
trap cleanup EXIT

# --- モックレジストリ ---
# npm audit の bulk advisory エンドポイントだけを模す。
#   argv[2]: 応答 JSON ファイル。"blackhole" なら受信しても応答を返さない
#   argv[3]: 受信 1 件につき 1 行を追記するファイル（到達件数の検証用）
# 待ち受けポートは stdout に 1 行で出す。
MOCK="$TMP/mock-registry.mjs"
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

# --- モック応答の advisory ---
# 被テストスクリプトは、本監査の前にカナリア監査（audit-canary/ の minimist）を行う。
# 監査先が advisory を返すことを確かめるためで、「監査が成立する」応答には必ずカナリアの advisory を含める。
# npm は、ツリーに存在しないパッケージの advisory を破棄する。
# 根拠は @npmcli/arborist/lib/audit-report.js の nodes.size === 0 での delete となる。
# そのため、カナリア分を混ぜても配布ツリー側の判定には出てこない。
#
# lodash の advisory id は、ケースごとに別の値にする。
# 同一 id では先に評価した severity がキャッシュから返り、後続ケースの境界判定が意図した severity にならない。
CANARY_ADV='"minimist":[{"id":1097678,"url":"https://github.com/advisories/GHSA-xvch-5gv4-984h","title":"Prototype Pollution in minimist","severity":"critical","vulnerable_versions":">=1.0.0 <1.2.6","cwe":["CWE-1321"],"cvss":{"score":9.8,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}}]'
LODASH_HIGH='"lodash":[{"id":1523,"url":"https://github.com/advisories/GHSA-p6mc-m468-83gw","title":"Prototype Pollution in lodash","severity":"high","vulnerable_versions":"<4.17.19","cwe":["CWE-770"],"cvss":{"score":7.4,"vectorString":"CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N"}}]'
LODASH_MODERATE='"lodash":[{"id":1065,"url":"https://github.com/advisories/GHSA-29mw-wpgm-hmr9","title":"Regular Expression Denial of Service (ReDoS) in lodash","severity":"moderate","vulnerable_versions":"<4.17.21","cwe":["CWE-1333"],"cvss":{"score":5.3,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L"}}]'
# 実在の lodash advisory に critical は無いため severity だけ差し替えた合成応答。
# 判定境界（critical 単独でも止まる）を固定するのが目的で、実在の評価の写しではない。
# 永続層 fixture (image-size@1.2.1) 用の応答。
# id・url・vulnerable_versions は実在の advisory の写しで、例外リストの突き合わせを実データと同じ形で確かめられる。
IMAGE_SIZE_HIGH='"image-size":[{"id":1138808,"url":"https://github.com/advisories/GHSA-w3rx-r6r6-pgpr","title":"image-size: ICNS parser allows denial of service through an infinite loop","severity":"high","vulnerable_versions":"<=2.0.2","cwe":["CWE-835"],"cvss":{"score":7.5,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"}},{"id":1138809,"url":"https://github.com/advisories/GHSA-5p2g-fcmc-qvqq","title":"image-size: JXL and HEIF parsers allow denial of service through infinite loops","severity":"high","vulnerable_versions":"<=2.0.2","cwe":["CWE-835"],"cvss":{"score":7.5,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"}}]'
LODASH_CRITICAL='"lodash":[{"id":1673,"url":"https://github.com/advisories/GHSA-35jh-r3h4-6jhm","title":"Command Injection in lodash","severity":"critical","vulnerable_versions":"<4.17.21","cwe":["CWE-77"],"cvss":{"score":9.8,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}}]'

# advisory を 1 件も返さないレジストリ（bulk が 200 と `{}`）。カナリアも落ちる。
echo '{}' > "$TMP/no-advisory.json"
# カナリアのみ（配布ツリーは脆弱性なし）。
echo "{$CANARY_ADV}" > "$TMP/canary-only.json"
echo "{$CANARY_ADV,$LODASH_HIGH}" > "$TMP/high.json"
echo "{$CANARY_ADV,$LODASH_MODERATE}" > "$TMP/moderate.json"
echo "{$CANARY_ADV,$LODASH_CRITICAL}" > "$TMP/critical.json"
# 永続層のみ high（配布ツリーの lodash には advisory を返さない）。
echo "{$CANARY_ADV,$IMAGE_SIZE_HIGH}" > "$TMP/image-size-high.json"

# 常時閉塞アドレス。エフェメラルポートを解放して再利用すると、同時実行中の別プロセスがそのポートを取得した場合、
# 接続拒否にならず偽陰性を生む。
CLOSED_REGISTRY="http://127.0.0.1:1"

MOCK_PORT=""
MOCK_COUNT=""
start_mock() {
    local mode="$1" name="$2"
    MOCK_COUNT="$TMP/$name.count"
    : > "$MOCK_COUNT"
    local portfile="$TMP/$name.port"
    : > "$portfile"
    node "$MOCK" "$mode" "$MOCK_COUNT" > "$portfile" 2> "$TMP/$name.log" &
    MOCK_PID=$!
    local i=0
    while [ ! -s "$portfile" ]; do
        i=$((i + 1))
        if [ "$i" -gt 200 ]; then
            echo "ERROR: モックレジストリが起動しません ($name)" >&2
            exit 1
        fi
        sleep 0.05
    done
    MOCK_PORT="$(tr -d '\n' < "$portfile")"
}
stop_mock() {
    [ -n "$MOCK_PID" ] || return 0
    kill "$MOCK_PID" > /dev/null 2>&1
    wait "$MOCK_PID" > /dev/null 2>&1
    MOCK_PID=""
}
mock_requests() {
    wc -l < "$MOCK_COUNT" | tr -d ' '
}

# --- 監査記録のヘルパー ---
# 記録は JSON で、フィールドの取り出しは node で行う。jq は前提にしない。
# 返す値は 3 通りある。
# 記録そのものが無い場合は __ABSENT__ を返す。
# JSON として読めない場合は __UNREADABLE__ を返す。
# 記録は読めるがフィールドが無い場合は __MISSING__ を返す。
# 3 つを取り違えると、「記録を消した」と「記録が破損した」が同じ結果になってしまう。
record_field() {
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

REPO_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
PLUGIN_VERSION="$(node -e "process.stdout.write(require('$REPO_ROOT/plugins/pecot-visual/.claude-plugin/plugin.json').version)")"

# --- version plan の探索先 ---
# 既定は <repo>/.nx/version-plans。テストは実リポの plan 有無に結果が左右されないよう
# 常に --plans-dir で明示する。
PLANS_PECOTV="$TMP/plans-pecotv"
mkdir -p "$PLANS_PECOTV"
cat > "$PLANS_PECOTV/1050-audit.md" << 'PLAN_EOF'
---
pecot-visual: patch
---

配布ツリーの依存監査をリリース前ゲートに追加。
PLAN_EOF

PLANS_PECOT_ONLY="$TMP/plans-pecot-only"
mkdir -p "$PLANS_PECOT_ONLY"
cat > "$PLANS_PECOT_ONLY/999-pecot-only.md" << 'PLAN_EOF'
---
pecot: patch
---

pecot 単独リリースの plan。
PLAN_EOF

# text-rules だけの plan。updateDependents: always により、nx は依存元の pecot-visual も上げる。
PLANS_TEXT_RULES="$TMP/plans-text-rules"
mkdir -p "$PLANS_TEXT_RULES"
cat > "$PLANS_TEXT_RULES/997-text-rules.md" << 'PLAN_EOF'
---
text-rules: patch
---

text-rules だけの plan。pecot-visual は依存先の更新で上がる。
PLAN_EOF

# pecot-visual と無関係な group だけの plan。
PLANS_WORKFLOW_ONLY="$TMP/plans-workflow-only"
mkdir -p "$PLANS_WORKFLOW_ONLY"
cat > "$PLANS_WORKFLOW_ONLY/996-workflow.md" << 'PLAN_EOF'
---
pecot-workflow: patch
---

pecot-workflow だけの plan。
PLAN_EOF

# pecot-visual を key とする行はあるが、bump 宣言として抽出できない形（引用値）。
PLANS_PECOTV_QUOTED="$TMP/plans-pecotv-quoted"
mkdir -p "$PLANS_PECOTV_QUOTED"
cat > "$PLANS_PECOTV_QUOTED/998-quoted.md" << 'PLAN_EOF'
---
pecot-visual: "patch"
---

引用値のため pre-commit と同じ抽出規則では宣言として拾えない plan。
PLAN_EOF

# text-rules を key とする行はあるが、bump 宣言として抽出できない形（引用値）。
# text-rules の group も pecot-visual のリリースとみなす対象なので、pecot-visual と同じく中止する。
PLANS_TEXT_RULES_QUOTED="$TMP/plans-text-rules-quoted"
mkdir -p "$PLANS_TEXT_RULES_QUOTED"
cat > "$PLANS_TEXT_RULES_QUOTED/996-quoted.md" << 'PLAN_EOF'
---
text-rules: "patch"
---

引用値のため宣言として拾えない text-rules の plan。
PLAN_EOF

# キーを二重引用符・単一引用符で囲んだ形。YAML では引用符なしのキーと同じ宣言になる。
PLANS_TEXT_RULES_QUOTED_KEY="$TMP/plans-text-rules-quoted-key"
mkdir -p "$PLANS_TEXT_RULES_QUOTED_KEY"
cat > "$PLANS_TEXT_RULES_QUOTED_KEY/995-quoted-key.md" << 'PLAN_EOF'
---
"text-rules": minor
---

キーを二重引用符で囲んだ text-rules の plan。
PLAN_EOF

PLANS_PECOTV_QUOTED_KEY="$TMP/plans-pecotv-quoted-key"
mkdir -p "$PLANS_PECOTV_QUOTED_KEY"
cat > "$PLANS_PECOTV_QUOTED_KEY/994-quoted-key.md" << 'PLAN_EOF'
---
'pecot-visual': patch
---

キーを単一引用符で囲んだ pecot-visual の plan。
PLAN_EOF

# --- 監査対象ツリー ---
# npm が対象ディレクトリへ書き込んでも fixture を汚さないよう毎回コピーして使う。
new_dist() {
    local dir="$TMP/dist-$1"
    rm -rf "$dir"
    mkdir -p "$dir"
    cp "$FIXTURE/package.json" "$FIXTURE/npm-shrinkwrap.json" "$dir/"
    echo "$dir"
}
new_runtime_dist() {
    local dir="$TMP/runtime-$1"
    rm -rf "$dir"
    mkdir -p "$dir"
    cp "$FIXTURE_RUNTIME/package.json" "$FIXTURE_RUNTIME/npm-shrinkwrap.json" "$dir/"
    echo "$dir"
}

# --- 例外リスト ---
# 判定を既定の audit-exceptions.json に左右させないため、全ケースで --exceptions を渡す。
EXC_EMPTY="$TMP/exceptions-empty.json"
printf '{"exceptions":[]}\n' > "$EXC_EMPTY"

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

EXC_IMAGE_SIZE="$TMP/exceptions-image-size.json"
write_exceptions "$EXC_IMAGE_SIZE" "GHSA-w3rx-r6r6-pgpr,image-size" "GHSA-5p2g-fcmc-qvqq,image-size"
EXC_IMAGE_SIZE_ONE="$TMP/exceptions-image-size-one.json"
write_exceptions "$EXC_IMAGE_SIZE_ONE" "GHSA-w3rx-r6r6-pgpr,image-size"
# id は実在するが package が違う（上流の登録し直しで陳腐化した記載）。
EXC_WRONG_PACKAGE="$TMP/exceptions-wrong-package.json"
write_exceptions "$EXC_WRONG_PACKAGE" "GHSA-w3rx-r6r6-pgpr,lodash"
EXC_LODASH="$TMP/exceptions-lodash.json"
write_exceptions "$EXC_LODASH" "GHSA-p6mc-m468-83gw,lodash"

RC=0
OUT=""
ERR=""
run_audit() {
    local name="$1"
    shift
    OUT="$TMP/$name.out"
    ERR="$TMP/$name.err"
    RC=0
    bash "$AUDIT" "$@" > "$OUT" 2> "$ERR" || RC=$?
}

# --- 1. 配布ツリーに脆弱性が無ければ pass する ---
# 応答はカナリアの advisory のみ。カナリア監査は通り、配布ツリーは 0 件になる。

start_mock "$TMP/canary-only.json" case1
CASE1_REGISTRY="http://127.0.0.1:$MOCK_PORT"
run_audit case1 --dist="$(new_dist case1)" --runtime-dist="$(new_runtime_dist case1)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" --registry="$CASE1_REGISTRY"
assert_eq "脆弱性なしで exit 0" "0" "$RC"
assert_contains "配布ツリーの要約行にパッケージ数が出る" "配布ツリー: 1 パッケージ" "$OUT"
assert_contains "要約行に high 0 が出る" "high 0" "$OUT"
assert_contains "永続層の要約行も同じレイアウトで出る" "永続層: 3 パッケージ" "$OUT"
assert_contains "例外を適用していなければ 0 件と出る" "例外 0 件" "$OUT"
assert_contains "要約行に監査先レジストリが出る" "registry $CASE1_REGISTRY" "$OUT"
assert_contains "要約行に依存ツリーの指紋が出る" "指紋 " "$OUT"
assert_contains "要約行は stderr にも出る" "配布ツリー: 1 パッケージ" "$ERR"
assert_contains "pass のメッセージが出る" "監査 pass（high 以上なし）" "$OUT"

# 記録は publish が読む。指紋が dist-fingerprint.mjs の値と一致し、
# 監査時の HEAD が記録されていることを固定する。
FIXTURE_FP="$(node "$FINGERPRINT" "$FIXTURE/npm-shrinkwrap.json")"
assert_eq "記録の dist.fingerprint が dist-fingerprint.mjs の値と一致" "$FIXTURE_FP" "$(record_field dist.fingerprint)"
assert_eq "記録の head が監査時の HEAD" "$REPO_HEAD" "$(record_field head)"
assert_eq "記録の registry が監査先" "$CASE1_REGISTRY" "$(record_field registry)"
assert_eq "記録の dist.vulnerabilities.high が 0" "0" "$(record_field dist.vulnerabilities.high)"
assert_eq "記録の dist.total が fixture のパッケージ数" "1" "$(record_field dist.total)"
FIXTURE_RUNTIME_FP="$(node "$FINGERPRINT" "$FIXTURE_RUNTIME/npm-shrinkwrap.json")"
assert_eq "記録の runtime.fingerprint が永続層 fixture の指紋" "$FIXTURE_RUNTIME_FP" "$(record_field runtime.fingerprint)"
assert_eq "記録の 2 ツリーの指紋は別値" "1" "$([ "$FIXTURE_FP" != "$FIXTURE_RUNTIME_FP" ] && echo 1 || echo 0)"
assert_eq "記録の runtime.vulnerabilities.high が 0" "0" "$(record_field runtime.vulnerabilities.high)"
assert_eq "記録の runtime.total が永続層 fixture のパッケージ数" "3" "$(record_field runtime.total)"
assert_contains "要約行の指紋が記録と同じ値" "指紋 $FIXTURE_FP" "$OUT"
stop_mock

# --- 2. high の advisory でリリースを止める ---

start_mock "$TMP/high.json" case2
place_stale_record
run_audit case2 --dist="$(new_dist case2)" --runtime-dist="$(new_runtime_dist case2)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT"
assert_eq "high 検出で exit 1" "1" "$RC"
assert_contains "high 以上の件数を出す" "high 以上の脆弱なパッケージ 1 件" "$ERR"
assert_contains "脆弱なパッケージ名を出す" "lodash (high)" "$ERR"
assert_contains "advisory の title を出す" "Prototype Pollution in lodash" "$ERR"
assert_contains "advisory の URL を出す" "https://github.com/advisories/GHSA-p6mc-m468-83gw" "$ERR"
assert_contains "要約行も出る（判定条件がログに残る）" "配布ツリー: 1 パッケージ" "$ERR"
# 記録が残ると publish が「監査を通った」と読む。high での中止では消えていること。
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    fail "high 検出で中止したのに監査記録が残っている"
else
    pass "high 検出で中止したとき監査記録を残さない"
fi
stop_mock

# --- 3. 監査エンドポイント不達（接続拒否）で止める ---

place_stale_record
run_audit case3 --dist="$(new_dist case3)" --runtime-dist="$(new_runtime_dist case3)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="$CLOSED_REGISTRY"
assert_eq "接続拒否で exit 1" "1" "$RC"
assert_contains "未実施として中止する" "監査未実施のため中止" "$ERR"
if grep -qF "監査 pass" "$OUT"; then
    fail "不達なのに pass を出した"
else
    pass "不達時は pass を出さない"
fi
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    fail "監査未実施で中止したのに監査記録が残っている"
else
    pass "監査未実施で中止したとき監査記録を残さない"
fi

# --- 4. 無応答の監査エンドポイントで待ち上限が働く ---

start_mock blackhole case4
START=$SECONDS
run_audit case4 --dist="$(new_dist case4)" --runtime-dist="$(new_runtime_dist case4)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT" --timeout=3
ELAPSED=$((SECONDS - START))
assert_eq "無応答で exit 1" "1" "$RC"
assert_contains "未実施として中止する" "監査未実施のため中止" "$ERR"
assert_contains "待ち上限の秒数を出す" "3 秒以内に応答なし" "$ERR"
if [ "$ELAPSED" -le 6 ]; then
    pass "--timeout=3 が 6 秒以内に打ち切る (${ELAPSED}s)"
else
    fail "--timeout=3 が働いていない (${ELAPSED}s)"
fi
# 最初の npm 呼び出しはカナリア監査。そこで無応答になるので bulk への到達は 1 件。
assert_eq "無応答サーバへは到達している" "1" "$(mock_requests)"
stop_mock

# --- 5. --registry が npm_config_registry を上書きする ---
#
# env や ~/.npmrc の監査先が優先されると、`{}` を返す先に向いて偽の pass になる。

start_mock "$TMP/canary-only.json" case5
MOCK5_COUNT="$MOCK_COUNT"
CASE5_DIST="$(new_dist case5)"
CASE5_RUNTIME="$(new_runtime_dist case5)"
OUT="$TMP/case5.out"
ERR="$TMP/case5.err"
RC=0
npm_config_registry="$CLOSED_REGISTRY" \
    bash "$AUDIT" --dist="$CASE5_DIST" --runtime-dist="$CASE5_RUNTIME" \
    --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT" > "$OUT" 2> "$ERR" || RC=$?
assert_eq "--registry が env より優先されて exit 0" "0" "$RC"
# カナリア監査と 2 ツリーの監査で bulk へ 3 回投げる。
assert_eq "モックレジストリに到達している" "3" "$(wc -l < "$MOCK5_COUNT" | tr -d ' ')"
assert_contains "要約行の registry は --registry の値" "registry http://127.0.0.1:$MOCK_PORT" "$OUT"
stop_mock

# --- 6. pecot-visual の version plan が無ければ監査せずスキップ ---
#
# pecot-workflow 単独のリリースでも、nx は pecot-visual group の pre-version command を起動する。
#
# HEAD のリリースタグは再監査の処理を開く。そのため、タグ無しの状態を env で固定する。
# リポジトリ本体の HEAD にタグが付いているかで、結果が変わらないようにする。
start_mock "$TMP/canary-only.json" case6
MOCK6_COUNT="$MOCK_COUNT"
OUT="$TMP/case6.out"
ERR="$TMP/case6.err"
RC=0
PECOTV_AUDIT_HEAD_TAGS="" bash "$AUDIT" --dist="$(new_dist case6)" --runtime-dist="$(new_runtime_dist case6)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$PLANS_PECOT_ONLY" --registry="http://127.0.0.1:$MOCK_PORT" \
    > "$OUT" 2> "$ERR" || RC=$?
assert_eq "pecot-visual 宣言が無ければ exit 0" "0" "$RC"
assert_contains "スキップの理由を出す" "スキップ: pecot-visual の version plan が無いため" "$OUT"
assert_eq "スキップ時はレジストリへ 1 件も投げない" "0" "$(wc -l < "$MOCK6_COUNT" | tr -d ' ')"
# publish はこの記録を読んで「監査していないリリース」と判定する。
assert_eq "スキップ時の記録は skipped: true" "true" "$(record_field skipped)"
assert_eq "スキップ時の記録に監査時 HEAD が入る" "$REPO_HEAD" "$(record_field head)"
assert_eq "スキップ時の記録に dist セクションは無い" "__MISSING__" "$(record_field dist.fingerprint)"
stop_mock

# --- 7. moderate だけなら pass する（判定境界の下側）---

start_mock "$TMP/moderate.json" case7
run_audit case7 --dist="$(new_dist case7)" --runtime-dist="$(new_runtime_dist case7)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT"
assert_eq "moderate のみで exit 0" "0" "$RC"
assert_contains "要約行に moderate 1 が出る" "moderate 1" "$OUT"
assert_contains "要約行に high 0 が出る" "high 0" "$OUT"
assert_contains "pass のメッセージが出る" "監査 pass（high 以上なし）" "$OUT"
stop_mock

# --- 8. critical だけでも止める（判定境界の上側）---

start_mock "$TMP/critical.json" case8
run_audit case8 --dist="$(new_dist case8)" --runtime-dist="$(new_runtime_dist case8)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT"
assert_eq "critical のみで exit 1" "1" "$RC"
assert_contains "high 以上の件数を出す" "high 以上の脆弱なパッケージ 1 件" "$ERR"
assert_contains "severity に critical を出す" "lodash (critical)" "$ERR"
assert_contains "advisory の title を出す" "Command Injection in lodash" "$ERR"
stop_mock

# --- 9. advisory を返さないレジストリはカナリアで検知して止める ---
#
# bulk が 200 と `{}` を返す先は、「脆弱性 0 件」と区別が付かない。
# そのため、カナリアの advisory が返らない時点で監査未実施として中止する。

start_mock "$TMP/no-advisory.json" case9
run_audit case9 --dist="$(new_dist case9)" --runtime-dist="$(new_runtime_dist case9)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT"
assert_eq "カナリア不検出で exit 1" "1" "$RC"
assert_contains "未実施として中止する" "監査未実施のため中止" "$ERR"
assert_contains "advisory 未提供のレジストリとして理由を出す" "既知の advisory を返しません" "$ERR"
if grep -qF "監査 pass" "$OUT"; then
    fail "advisory 未提供なのに pass を出した"
else
    pass "advisory 未提供のレジストリでは pass を出さない"
fi
stop_mock

# --- 10. pecot-visual 宣言が解釈できない version plan は中止する ---
#
# スキップに倒すと、nx は実在の plan で bump するのに、監査だけが気付かれずに抜ける。

start_mock "$TMP/canary-only.json" case10
MOCK10_COUNT="$MOCK_COUNT"
run_audit case10 --dist="$(new_dist case10)" --runtime-dist="$(new_runtime_dist case10)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV_QUOTED" \
    --registry="http://127.0.0.1:$MOCK_PORT"
assert_eq "解釈できない pecot-visual 宣言で exit 1" "1" "$RC"
assert_contains "未実施として中止する" "監査未実施のため中止" "$ERR"
assert_contains "解釈できない plan のパスを出す" "998-quoted.md" "$ERR"
assert_eq "中止時はレジストリへ 1 件も投げない" "0" "$(wc -l < "$MOCK10_COUNT" | tr -d ' ')"
stop_mock

# text-rules の宣言も同じ扱いにする。updateDependents: always により、text-rules の bump は pecot-visual のリリースになる。
start_mock "$TMP/canary-only.json" case10b
MOCK10B_COUNT="$MOCK_COUNT"
run_audit case10b --dist="$(new_dist case10b)" --runtime-dist="$(new_runtime_dist case10b)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_TEXT_RULES_QUOTED" \
    --registry="http://127.0.0.1:$MOCK_PORT"
assert_eq "解釈できない text-rules 宣言で exit 1" "1" "$RC"
assert_contains "text-rules の宣言でも未実施として中止する" "監査未実施のため中止" "$ERR"
assert_contains "解釈できない text-rules の plan のパスを出す" "996-quoted.md" "$ERR"
assert_eq "text-rules の宣言で中止するときもレジストリへ 1 件も投げない" "0" "$(wc -l < "$MOCK10B_COUNT" | tr -d ' ')"
stop_mock

# 引用符付きのキーは宣言として読み、スキップせずに監査する。
for quoted_key_case in "10c:$PLANS_TEXT_RULES_QUOTED_KEY:text-rules" "10d:$PLANS_PECOTV_QUOTED_KEY:pecot-visual"; do
    case_id="case${quoted_key_case%%:*}"
    rest="${quoted_key_case#*:}"
    plans="${rest%:*}"
    label="${rest##*:}"
    start_mock "$TMP/canary-only.json" "$case_id"
    QUOTED_COUNT="$MOCK_COUNT"
    run_audit "$case_id" --dist="$(new_dist "$case_id")" --runtime-dist="$(new_runtime_dist "$case_id")" --exceptions="$EXC_EMPTY" --plans-dir="$plans" \
        --registry="http://127.0.0.1:$MOCK_PORT"
    assert_eq "引用符付きの $label キーでも exit 0" "0" "$RC"
    assert_contains "引用符付きの $label キーでは監査を実際に行う" "監査 pass（high 以上なし）" "$TMP/$case_id.out"
    assert_eq "引用符付きの $label キーでレジストリへ 3 件投げる" "3" "$(wc -l < "$QUOTED_COUNT" | tr -d ' ')"
    stop_mock
done

# --- 11. version plan の探索先が存在しないときは中止する ---

run_audit case11 --dist="$(new_dist case11)" --runtime-dist="$(new_runtime_dist case11)" --exceptions="$EXC_EMPTY" --plans-dir="$TMP/plans-missing" \
    --registry="$CLOSED_REGISTRY"
assert_eq "探索先の不在で exit 1" "1" "$RC"
assert_contains "探索先が無いことを理由に出す" "version plan の探索先がありません" "$ERR"

# --- 12. --timeout=0 は待ち上限の無効化になるため弾く ---
# coreutils の timeout は duration 0 を「上限なし」として扱う。

run_audit case12 --dist="$(new_dist case12)" --runtime-dist="$(new_runtime_dist case12)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="$CLOSED_REGISTRY" --timeout=0
assert_eq "--timeout=0 で exit 1" "1" "$RC"
assert_contains "正の整数を要求する" "正の整数" "$ERR"

# --- 13. dist-manifest.mjs の直接起動 ---
# 配布 package.json の生成は、本番では直接起動で使われる。
# argv 処理と stdout 出力が誤っていても、--dist 固定ツリーのケースでは検出できない。
# そのため、ここで単体として確かめる。
# ネットワーク不要。

MANIFEST_JS="$RELEASE_DIR/dist-manifest.mjs"
PECOTV_PLUGIN_ROOT="$(cd "$RELEASE_DIR/../.." && pwd)"
MANIFEST_REPO_ROOT="$(cd "$PECOTV_PLUGIN_ROOT/../.." && pwd)"

MANIFEST_RC=0
node "$MANIFEST_JS" "$PECOTV_PLUGIN_ROOT" 0.0.0-test "$MANIFEST_REPO_ROOT" \
    > "$TMP/manifest.json" 2> "$TMP/manifest.err" || MANIFEST_RC=$?
assert_eq "直接起動が exit 0" "0" "$MANIFEST_RC"

# 出力が有効な JSON であること（不正なら node が非ゼロで返り、下の assert が落ちる）。
MANIFEST_VERSION="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version))' \
    "$TMP/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"
assert_eq "出力が有効な JSON で version は引数どおり" "0.0.0-test" "$MANIFEST_VERSION"

DIRECT_DEPS="$(node -e 'const fs=require("node:fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).dependencies||{};process.stdout.write(Object.keys(d).sort().join(","))' \
    "$TMP/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"

# import 経由（publish が使う呼び方）の結果と比べる。直接起動だけが誤る回帰を拾う。
cat > "$TMP/manifest-import.mjs" << 'IMPORT_EOF'
import { pathToFileURL } from 'node:url'
const [modPath, pecotvRoot, repoRoot] = process.argv.slice(2)
const { buildDistManifest } = await import(pathToFileURL(modPath).href)
const deps = buildDistManifest(pecotvRoot, '0.0.0-test', repoRoot).dependencies
process.stdout.write(Object.keys(deps).sort().join(','))
IMPORT_EOF
IMPORT_DEPS="$(node "$TMP/manifest-import.mjs" "$MANIFEST_JS" "$PECOTV_PLUGIN_ROOT" "$MANIFEST_REPO_ROOT")"
assert_eq "直接起動の dependencies が import 経由と一致" "$IMPORT_DEPS" "$DIRECT_DEPS"
# 同梱する text-rules の依存は libs/text-rules/package.json の dependencies から導く。名前を列挙せず、
# その宣言と範囲まで比較する（配布 package.json に無い、または範囲が違う名前を列挙する）。
TEXT_RULES_DEP_GAP="$(node -e '
const fs = require("node:fs")
const textRules = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dependencies
const out = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).dependencies
const gap = Object.entries(textRules).filter(([name, range]) => out[name] !== range).map(([name]) => name)
process.stdout.write(Object.keys(textRules).length === 0 ? "TEXT_RULES_HAS_NO_DEPENDENCIES" : gap.sort().join(","))
' "$MANIFEST_REPO_ROOT/libs/text-rules/package.json" "$TMP/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"
assert_eq "直接起動の dependencies が libs/text-rules/package.json の dependencies を範囲ごと全部含む" "" "$TEXT_RULES_DEP_GAP"
if [ -n "$IMPORT_DEPS" ]; then
    pass "dependencies が空でない"
else
    fail "dependencies が空（比較が無意味になっている）"
fi

USAGE_RC=0
node "$MANIFEST_JS" > "$TMP/manifest-usage.out" 2> "$TMP/manifest-usage.err" || USAGE_RC=$?
assert_eq "引数不足で exit 1" "1" "$USAGE_RC"
assert_contains "引数不足で usage を出す" "usage: dist-manifest.mjs" "$TMP/manifest-usage.err"
assert_contains "usage が repo root の引数を示す" "<repo-root>" "$TMP/manifest-usage.err"

# --- 14. version plan が無くても HEAD のリリースタグがあれば再監査する ---
#
# publish が指紋の不一致で止まった後に、release commit を checkout して記録を作り直す場合が対象になる。
# plan は release commit で消費済みなので、この場合は存在しない。
# HEAD のタグ一覧は、env PECOTV_AUDIT_HEAD_TAGS で差し替える。
# tag は worktree 間で共有される ref なので、リポジトリ本体には検証用のタグを作らない。

start_mock "$TMP/canary-only.json" case14
MOCK14_COUNT="$MOCK_COUNT"
OUT="$TMP/case14.out"
ERR="$TMP/case14.err"
RC=0
PECOTV_AUDIT_HEAD_TAGS="pecot-visual-v$PLUGIN_VERSION" bash "$AUDIT" --dist="$(new_dist case14)" --runtime-dist="$(new_runtime_dist case14)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$PLANS_PECOT_ONLY" --registry="http://127.0.0.1:$MOCK_PORT" \
    > "$OUT" 2> "$ERR" || RC=$?
assert_eq "リリースタグがあれば plan 無しでも exit 0" "0" "$RC"
assert_contains "再監査として実行したことを出す" "再監査: HEAD に pecot-visual-v$PLUGIN_VERSION" "$OUT"
assert_contains "監査を実際に行う" "監査 pass（high 以上なし）" "$OUT"
assert_eq "再監査ではレジストリへ 3 件投げる" "3" "$(wc -l < "$MOCK14_COUNT" | tr -d ' ')"
assert_eq "再監査の記録は skipped ではない" "__MISSING__" "$(record_field skipped)"
assert_eq "再監査の記録に指紋が入る" "$(node "$FINGERPRINT" "$FIXTURE/npm-shrinkwrap.json")" \
    "$(record_field dist.fingerprint)"
stop_mock

# 無関係なタグしか無ければ従来どおりスキップする（タグ判定が総当たりでないこと）。
start_mock "$TMP/canary-only.json" case14b
OUT="$TMP/case14b.out"
RC=0
PECOTV_AUDIT_HEAD_TAGS="pecot-workflow-v1.0.0
pecot-visual-v0.0.0-other" bash "$AUDIT" --dist="$(new_dist case14b)" --runtime-dist="$(new_runtime_dist case14b)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$PLANS_PECOT_ONLY" --registry="http://127.0.0.1:$MOCK_PORT" \
    > "$OUT" 2> "$TMP/case14b.err" || RC=$?
assert_eq "別版のリリースタグではスキップする" "0" "$RC"
assert_contains "スキップの理由を出す" "スキップ: pecot-visual の version plan が無いため" "$OUT"
stop_mock

# --- 14c. 依存先の group だけの plan でも監査する (#1297) ---
#
# pecot-visual は text-rules を workspace: 依存で持つ。
# text-rules の group は updateDependents: always を持つため、text-rules だけの plan でも nx は pecot-visual を上げる。
# 判定が pecot-visual: の有無だけだと、pecot-visual のリリースなのに監査を飛ばし、skipped の記録で publish が止まる。
start_mock "$TMP/canary-only.json" case14c
MOCK14C_COUNT="$MOCK_COUNT"
OUT="$TMP/case14c.out"
RC=0
PECOTV_AUDIT_HEAD_TAGS="" bash "$AUDIT" --dist="$(new_dist case14c)" --runtime-dist="$(new_runtime_dist case14c)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$PLANS_TEXT_RULES" --registry="http://127.0.0.1:$MOCK_PORT" \
    > "$OUT" 2> "$TMP/case14c.err" || RC=$?
assert_eq "text-rules だけの plan でも exit 0" "0" "$RC"
assert_contains "監査を実際に行う" "監査 pass（high 以上なし）" "$OUT"
SKIP_LINES=0
grep -q 'スキップ' "$OUT" && SKIP_LINES=1
assert_eq "text-rules だけの plan ではスキップの行が出ない" "0" "$SKIP_LINES"
assert_eq "text-rules だけの plan でレジストリへ 3 件投げる" "3" "$(wc -l < "$MOCK14C_COUNT" | tr -d ' ')"
assert_eq "記録は skipped ではない" "__MISSING__" "$(record_field skipped)"
stop_mock

# 無関係な group だけの plan は、従来どおりスキップする。
start_mock "$TMP/canary-only.json" case14d
MOCK14D_COUNT="$MOCK_COUNT"
OUT="$TMP/case14d.out"
RC=0
PECOTV_AUDIT_HEAD_TAGS="" bash "$AUDIT" --dist="$(new_dist case14d)" --runtime-dist="$(new_runtime_dist case14d)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$PLANS_WORKFLOW_ONLY" --registry="http://127.0.0.1:$MOCK_PORT" \
    > "$OUT" 2> "$TMP/case14d.err" || RC=$?
assert_eq "pecot-workflow だけの plan でも exit 0" "0" "$RC"
assert_contains "スキップの理由を出す" "スキップ: pecot-visual の version plan が無いため" "$OUT"
assert_eq "スキップ時はレジストリへ 1 件も投げない" "0" "$(wc -l < "$MOCK14D_COUNT" | tr -d ' ')"
assert_eq "スキップ時の記録は skipped: true" "true" "$(record_field skipped)"
stop_mock

# --- 14e. release-groups.mjs: 依存先の group を workspace: 依存から求める ---
#
# 実リポジトリでは pecot-visual と text-rules の 2 つになる。
assert_eq "実リポジトリの対象 group は pecot-visual と text-rules" "pecot-visual,text-rules" \
    "$(node "$RELEASE_DIR/release-groups.mjs" "$REPO_ROOT" | paste -sd ',' -)"

# 別の workspace 依存が増えても、列挙し直さずに追従する。fixture で依存を 2 つにして確かめる。
GROUPS_REPO="$TMP/groups-repo"
mkdir -p "$GROUPS_REPO/plugins/pecot-visual" "$GROUPS_REPO/libs/alpha" "$GROUPS_REPO/libs/beta" "$GROUPS_REPO/libs/gamma"
cat > "$GROUPS_REPO/plugins/pecot-visual/package.json" << 'JSON_EOF'
{ "name": "fixture", "dependencies": { "@fx/alpha-pkg": "workspace:*", "left-pad": "1.0.0" }, "devDependencies": { "@fx/beta-pkg": "workspace:^" } }
JSON_EOF
printf 'packages:\n  - libs/alpha\n  - libs/beta\n  - libs/gamma\n' > "$GROUPS_REPO/pnpm-workspace.yaml"
for lib in alpha beta gamma; do
    printf '{ "name": "@fx/%s-pkg" }\n' "$lib" > "$GROUPS_REPO/libs/$lib/package.json"
    printf '{ "name": "%s-project" }\n' "$lib" > "$GROUPS_REPO/libs/$lib/project.json"
done
cat > "$GROUPS_REPO/nx.json" << 'JSON_EOF'
{ "release": { "groups": {
  "pecot-visual": { "projects": ["pecot-visual"] },
  "alpha-group": { "projects": ["alpha-project"] },
  "beta-group": { "projects": ["beta-project"] },
  "gamma-group": { "projects": ["gamma-project"] }
} } }
JSON_EOF
assert_eq "workspace: 依存の group だけが対象になる" "pecot-visual,alpha-group,beta-group" \
    "$(node "$RELEASE_DIR/release-groups.mjs" "$GROUPS_REPO" | paste -sd ',' -)"

# 依存先を含む group が nx.json に無ければ、静かに抜けず exit 1 で止める。
cat > "$GROUPS_REPO/nx.json" << 'JSON_EOF'
{ "release": { "groups": { "pecot-visual": { "projects": ["pecot-visual"] } } } }
JSON_EOF
GROUPS_RC=0
node "$RELEASE_DIR/release-groups.mjs" "$GROUPS_REPO" > "$TMP/groups.out" 2> "$TMP/groups.err" || GROUPS_RC=$?
assert_eq "group を引けないときは exit 1" "1" "$GROUPS_RC"
assert_contains "引けない project 名を出す" "alpha-project" "$TMP/groups.err"

# --- 15. dist-fingerprint.mjs の単体 ---
# 指紋はルート "" の version を除いた packages から取る。監査（bump 前）と
# publish（bump 後）で同じ値になり、依存の変化では変わることを固定する。
# ネットワーク不要。

FP_BASE="$(node "$FINGERPRINT" "$FIXTURE/npm-shrinkwrap.json")"
assert_eq "指紋は 64 桁 hex" "1" \
    "$(printf '%s' "$FP_BASE" | grep -cE '^[0-9a-f]{64}$' | tr -d ' ')"

# 変種の生成。ルート "" の version / ルートの dependencies 宣言 / 依存の version を
# それぞれ 1 箇所だけ差し替える。
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
}
fs.writeFileSync(out, JSON.stringify(sw, null, 2) + "\n")
' "$FIXTURE/npm-shrinkwrap.json" "$1" "$2"
}

mutate_shrinkwrap "$TMP/sw-root-version.json" root-version
assert_eq "ルートの version を変えても指紋は変わらない" "$FP_BASE" \
    "$(node "$FINGERPRINT" "$TMP/sw-root-version.json")"

mutate_shrinkwrap "$TMP/sw-root-deps.json" root-deps
if [ "$(node "$FINGERPRINT" "$TMP/sw-root-deps.json")" != "$FP_BASE" ]; then
    pass "ルートの dependencies 宣言を変えると指紋が変わる"
else
    fail "ルートの dependencies 宣言を変えても指紋が同じ"
fi

mutate_shrinkwrap "$TMP/sw-dep-version.json" dep-version
if [ "$(node "$FINGERPRINT" "$TMP/sw-dep-version.json")" != "$FP_BASE" ]; then
    pass "依存の version を変えると指紋が変わる"
else
    fail "依存の version を変えても指紋が同じ"
fi

# キー順だけが違う入力は同じ指紋になる。再帰ソートが働いていることを確かめる。
node -e '
const fs = require("node:fs")
const [src, out] = process.argv.slice(1)
const sw = JSON.parse(fs.readFileSync(src, "utf8"))
const flip = (o) => Object.fromEntries(Object.keys(o).reverse().map((k) => [k, o[k]]))
sw.packages = flip(sw.packages)
sw.packages["node_modules/lodash"] = flip(sw.packages["node_modules/lodash"])
fs.writeFileSync(out, JSON.stringify(sw, null, 2) + "\n")
' "$FIXTURE/npm-shrinkwrap.json" "$TMP/sw-reordered.json"
assert_eq "キー順だけの違いでは指紋が変わらない" "$FP_BASE" \
    "$(node "$FINGERPRINT" "$TMP/sw-reordered.json")"

mutate_shrinkwrap "$TMP/sw-no-packages.json" no-packages
FP_RC=0
node "$FINGERPRINT" "$TMP/sw-no-packages.json" > /dev/null 2> "$TMP/fp-nopkg.err" || FP_RC=$?
assert_eq "packages が無い入力で非ゼロ終了" "1" "$FP_RC"
assert_contains "packages が無い理由を出す" "packages がありません" "$TMP/fp-nopkg.err"

# 依存解決が丸ごと失敗した shrinkwrap（packages にルート "" が無い）を有効な指紋として
# 扱わない。
mutate_shrinkwrap "$TMP/sw-empty-packages.json" empty-packages
FP_EMPTY_RC=0
node "$FINGERPRINT" "$TMP/sw-empty-packages.json" > /dev/null 2> "$TMP/fp-empty.err" || FP_EMPTY_RC=$?
assert_eq "packages が空の入力で非ゼロ終了" "1" "$FP_EMPTY_RC"
assert_contains "ルート \"\" が無い理由を出す" 'ルート "" がありません' "$TMP/fp-empty.err"

FP_USAGE_RC=0
node "$FINGERPRINT" > "$TMP/fp-usage.out" 2> "$TMP/fp-usage.err" || FP_USAGE_RC=$?
assert_eq "引数不足で exit 1" "1" "$FP_USAGE_RC"
assert_contains "引数不足で usage を出す" "usage: dist-fingerprint.mjs" "$TMP/fp-usage.err"

# --- 16. 永続層の high を例外で通す ---
# 例外は、high 以上の判定を免れさせる唯一の仕組みとなる。
# そのため、件数、免除した advisory の列挙、記録への残り方をまとめて固定する。

start_mock "$TMP/image-size-high.json" case16
run_audit case16 --dist="$(new_dist case16)" --runtime-dist="$(new_runtime_dist case16)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_IMAGE_SIZE"
assert_eq "永続層の例外 2 件で exit 0" "0" "$RC"
assert_contains "永続層の要約行に例外件数が出る" "例外 2 件" "$OUT"
assert_contains "免除した advisory を本文に列挙する (1 件目)" \
    "永続層の例外適用: GHSA-w3rx-r6r6-pgpr image-size (high)" "$OUT"
assert_contains "免除した advisory を本文に列挙する (2 件目)" \
    "永続層の例外適用: GHSA-5p2g-fcmc-qvqq image-size (high)" "$OUT"
assert_contains "例外の列挙は stderr にも出る" \
    "永続層の例外適用: GHSA-w3rx-r6r6-pgpr image-size (high)" "$ERR"
assert_contains "pass のメッセージが出る" "監査 pass（high 以上なし）" "$OUT"
assert_eq "記録の runtime.excepted は 2 件" "2" "$(record_field runtime.excepted.length)"
assert_eq "記録の runtime.excepted に severity が入る" "high" "$(record_field runtime.excepted.0.severity)"
assert_eq "記録の runtime.excepted は advisory 順" "GHSA-5p2g-fcmc-qvqq" "$(record_field runtime.excepted.0.advisory)"
assert_eq "例外を除いた runtime.vulnerabilities.high は 0" "0" "$(record_field runtime.vulnerabilities.high)"
assert_eq "配布ツリー側の例外は 0 件" "0" "$(record_field dist.excepted.length)"
stop_mock

# --- 17. 例外が無ければ永続層の high で止める ---
# 例外の仕組みが、常に判定を免れさせる実装になっていないことの裏返しとなる。

start_mock "$TMP/image-size-high.json" case17
run_audit case17 --dist="$(new_dist case17)" --runtime-dist="$(new_runtime_dist case17)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_EMPTY"
assert_eq "例外なしの永続層 high で exit 1" "1" "$RC"
assert_contains "どちらのツリーで止めたかを出す" "永続層: high 以上の脆弱なパッケージ 1 件" "$ERR"
assert_contains "脆弱なパッケージ名を出す" "image-size (high)" "$ERR"
assert_contains "advisory の URL を出す" "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr" "$ERR"
assert_contains "配布ツリーの要約行も出る" "配布ツリー: 1 パッケージ" "$ERR"
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    fail "永続層の high で中止したのに監査記録が残っている"
else
    pass "永続層の high で中止したとき監査記録を残さない"
fi
stop_mock

# --- 18. 例外が 1 件足りなければ止める ---

start_mock "$TMP/image-size-high.json" case18
run_audit case18 --dist="$(new_dist case18)" --runtime-dist="$(new_runtime_dist case18)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_IMAGE_SIZE_ONE"
assert_eq "例外 1 件だけでは exit 1" "1" "$RC"
assert_contains "適用した例外は要約行に出る" "例外 1 件" "$ERR"
assert_contains "残る advisory で止める" "永続層: high 以上の脆弱なパッケージ 1 件" "$ERR"
stop_mock

# --- 19. id は一致するが package が違う例外は陳腐化として中止する ---
#
# 「例外なし」に倒すと止まる方向なので安全に見える。
# ただし、記載が実データと対応していない状態のまま運用が続く。
# そこで、監査未実施として作業を止める。

start_mock "$TMP/image-size-high.json" case19
run_audit case19 --dist="$(new_dist case19)" --runtime-dist="$(new_runtime_dist case19)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_WRONG_PACKAGE"
assert_eq "例外の陳腐化で exit 1" "1" "$RC"
assert_contains "未実施として中止する" "監査未実施のため中止" "$ERR"
assert_contains "どちらのツリーかを出す" "永続層" "$ERR"
assert_contains "陳腐化した例外の id を出す" "GHSA-w3rx-r6r6-pgpr" "$ERR"
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    fail "例外の陳腐化で中止したのに監査記録が残っている"
else
    pass "例外の陳腐化で中止したとき監査記録を残さない"
fi
stop_mock

# --- 20. 例外は配布ツリーにも同じ規則で適用される ---

start_mock "$TMP/high.json" case20
run_audit case20 --dist="$(new_dist case20)" --runtime-dist="$(new_runtime_dist case20)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_LODASH"
assert_eq "配布ツリーの例外で exit 0" "0" "$RC"
assert_contains "免除した advisory を配布ツリー側でも列挙する" \
    "配布ツリーの例外適用: GHSA-p6mc-m468-83gw lodash (high)" "$OUT"
assert_contains "例外を除いた配布ツリーの high は 0" "配布ツリー: 1 パッケージ / critical 0 / high 0" "$OUT"
assert_contains "pass のメッセージが出る" "監査 pass（high 以上なし）" "$OUT"
assert_eq "記録の dist.excepted は 1 件" "1" "$(record_field dist.excepted.length)"
stop_mock

# --- 21. 形の違う例外リストは監査未実施として中止する ---
# 例外は判定を緩められる唯一の仕組みとなる。
# そのため、読めない記載や形が違う記載を、「例外なし」に倒さない。

printf 'not json\n' > "$TMP/exceptions-broken.json"
printf '{"exceptions": {}}\n' > "$TMP/exceptions-not-array.json"
write_exceptions "$TMP/exceptions-bad-id.json" "CVE-2024-0001,image-size"
write_exceptions "$TMP/exceptions-duplicate.json" "GHSA-w3rx-r6r6-pgpr,image-size" "GHSA-w3rx-r6r6-pgpr,image-size"
node - "$TMP/exceptions-empty-reason.json" << 'EMPTY_REASON_JS'
const fs = require("node:fs")
fs.writeFileSync(process.argv[2], JSON.stringify({
  exceptions: [{ advisory: "GHSA-w3rx-r6r6-pgpr", package: "image-size", reason: "" }]
}, null, 2) + "\n")
EMPTY_REASON_JS
# added / reevaluate も reason と同じく必須（非空文字列）(#1071 F-18)。
node - "$TMP/exceptions-empty-added.json" << 'EMPTY_ADDED_JS'
const fs = require("node:fs")
fs.writeFileSync(process.argv[2], JSON.stringify({
  exceptions: [{ advisory: "GHSA-w3rx-r6r6-pgpr", package: "image-size", reason: "テスト用", added: "", reevaluate: "テスト用" }]
}, null, 2) + "\n")
EMPTY_ADDED_JS
node - "$TMP/exceptions-missing-reevaluate.json" << 'MISSING_REEVALUATE_JS'
const fs = require("node:fs")
fs.writeFileSync(process.argv[2], JSON.stringify({
  exceptions: [{ advisory: "GHSA-w3rx-r6r6-pgpr", package: "image-size", reason: "テスト用", added: "2026-09-07" }]
}, null, 2) + "\n")
MISSING_REEVALUATE_JS

start_mock "$TMP/image-size-high.json" case21
CASE21_REGISTRY="http://127.0.0.1:$MOCK_PORT"
check_bad_exceptions() {
    local label="$1" file="$2" name="$3"
    run_audit "$name" --dist="$(new_dist "$name")" --runtime-dist="$(new_runtime_dist "$name")" \
        --plans-dir="$PLANS_PECOTV" --registry="$CASE21_REGISTRY" --exceptions="$file"
    assert_eq "$label で exit 1" "1" "$RC"
    assert_contains "$label を未実施として中止する" "監査未実施のため中止" "$ERR"
}
check_bad_exceptions "破損した JSON の例外リスト" "$TMP/exceptions-broken.json" case21a
check_bad_exceptions "exceptions が配列でない例外リスト" "$TMP/exceptions-not-array.json" case21b
check_bad_exceptions "GHSA- で始まらない advisory" "$TMP/exceptions-bad-id.json" case21c
check_bad_exceptions "advisory が重複した例外リスト" "$TMP/exceptions-duplicate.json" case21d
check_bad_exceptions "reason が空文字の例外リスト" "$TMP/exceptions-empty-reason.json" case21e
check_bad_exceptions "added が空文字の例外リスト" "$TMP/exceptions-empty-added.json" case21f
check_bad_exceptions "reevaluate が無い例外リスト" "$TMP/exceptions-missing-reevaluate.json" case21g
stop_mock

# 明示した例外リストが存在しない場合も中止する（既定パスの不在だけが「例外なし」）。
run_audit case21h --dist="$(new_dist case21h)" --runtime-dist="$(new_runtime_dist case21h)" \
    --plans-dir="$PLANS_PECOTV" --registry="$CLOSED_REGISTRY" \
    --exceptions="$TMP/exceptions-missing.json"
assert_eq "明示した例外リストの不在で exit 1" "1" "$RC"
assert_contains "指定した例外リストが無いことを理由に出す" "指定された例外リストがありません" "$ERR"

# --- 22. --dist と --runtime-dist は対で渡す ---
# 片方だけだと、もう一方は実レジストリで解決されたうえモックの `{}` 応答で 0 件 pass に
# なる。失敗ではなく遅延として現れて気付けないため引数の時点で弾く。

run_audit case22a --dist="$(new_dist case22a)" --plans-dir="$PLANS_PECOTV" \
    --registry="$CLOSED_REGISTRY" --exceptions="$EXC_EMPTY"
assert_eq "--dist だけの指定で exit 1" "1" "$RC"
assert_contains "両方指定を要求する" "両方指定するか両方省略" "$ERR"

run_audit case22b --runtime-dist="$(new_runtime_dist case22b)" --plans-dir="$PLANS_PECOTV" \
    --registry="$CLOSED_REGISTRY" --exceptions="$EXC_EMPTY"
assert_eq "--runtime-dist だけの指定で exit 1" "1" "$RC"
assert_contains "両方指定を要求する" "両方指定するか両方省略" "$ERR"

# --- 23. 永続層に lockfile が無ければ監査未実施として中止する ---
#
# 中止の文言にツリー名が入ることを確かめる。
# 2 ツリーを同じ関数で監査するので、label が無いと、どちらで止まったか見分けが付かない。

CASE23_RUNTIME="$TMP/runtime-case23-nolock"
rm -rf "$CASE23_RUNTIME"
mkdir -p "$CASE23_RUNTIME"
cp "$FIXTURE_RUNTIME/package.json" "$CASE23_RUNTIME/"
start_mock "$TMP/canary-only.json" case23
run_audit case23 --dist="$(new_dist case23)" --runtime-dist="$CASE23_RUNTIME" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_EMPTY"
assert_eq "永続層の lockfile 欠落で exit 1" "1" "$RC"
assert_contains "永続層で止まったことを文言に残す" "監査未実施のため中止: 永続層:" "$ERR"
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    fail "永続層の未実施で中止したのに監査記録が残っている"
else
    pass "永続層の未実施で中止したとき監査記録を残さない"
fi
stop_mock

# --- 24. runtime-manifest.mjs の直接起動 ---
# 監査対象の永続層 package.json は、本番では直接起動で生成される。
# argv 処理と stdout 出力が誤っていても、--runtime-dist 固定ツリーのケースでは検出できない。
# ネットワークは使わない。
# cli の runtimeInstallPlan との同値は、runtime-manifest.test.sh が確かめる。

RUNTIME_MANIFEST_RC=0
node "$RUNTIME_MANIFEST_JS" "$PECOTV_PLUGIN_ROOT" \
    > "$TMP/runtime-manifest.json" 2> "$TMP/runtime-manifest.err" || RUNTIME_MANIFEST_RC=$?
assert_eq "直接起動が exit 0" "0" "$RUNTIME_MANIFEST_RC"

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
' "$TMP/runtime-manifest.json" "$1" 2> /dev/null || echo "__INVALID_JSON__"
}

assert_eq "出力が有効な JSON で name は pecotv-runtime" "pecotv-runtime" "$(runtime_manifest_field name)"

CORE_PIN="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).dependencies["@slidev/parser"]))' \
    "$PECOTV_PLUGIN_ROOT/cli/package.json")"
assert_eq "@slidev/cli は @slidev/parser の pin で固定する" "$CORE_PIN" "$(runtime_manifest_field @slidev/cli)"
assert_eq "@slidev/client も同じ pin で固定する" "$CORE_PIN" "$(runtime_manifest_field @slidev/client)"
assert_eq "@slidev/parser を明示的に含む" "$CORE_PIN" "$(runtime_manifest_field @slidev/parser)"
assert_ne "dom-to-pptx を含む" "__MISSING__" "$(runtime_manifest_field dom-to-pptx)"
assert_eq "workspace: 等のローカル参照を含まない" "" "$(runtime_manifest_field workspace)"
assert_eq "playwright は install 対象外なので含まない" "__MISSING__" "$(runtime_manifest_field playwright)"

RUNTIME_OVERRIDES="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).overrides))' \
    "$PECOTV_PLUGIN_ROOT/assets/slidev/runtime/package.json")"
assert_eq "overrides が runtime の manifest の写しになっている" "$RUNTIME_OVERRIDES" "$(runtime_manifest_field overrides)"

RUNTIME_USAGE_RC=0
node "$RUNTIME_MANIFEST_JS" > "$TMP/runtime-manifest-usage.out" 2> "$TMP/runtime-manifest-usage.err" \
    || RUNTIME_USAGE_RC=$?
assert_eq "引数不足で exit 1" "1" "$RUNTIME_USAGE_RC"
assert_contains "引数不足で usage を出す" "usage: runtime-manifest.mjs" "$TMP/runtime-manifest-usage.err"

# --- 25. audit-summary.mjs の単体 ---
# via の再帰・循環・例外適用は 2 ツリーの判定を決める中核だが、モックレジストリ経由の
# ケースでは実データに現れる形しか通らない。合成入力で境界を直接固定する。
# ネットワーク不要。

write_audit_fixture() {
    # node へ渡す JS は quote 付きの heredoc で渡し、${...} を展開させない。
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
  // cycle と同じグラフをキー順だけ逆にしたもの。Object.keys の列挙順で判定が揺れる
  // 退行を検知する (#1071 F-01)。
  cycleRev: {
    b: { name: "b", severity: "high", via: ["a", adv("bbbb-bbbb-bbbb", "b", "high")], effects: ["a"] },
    a: { name: "a", severity: "high", via: ["b"], effects: ["b"] }
  },
  // via の参照先が vulnerabilities に無い（npm が破棄した等）。npm 報告の severity へ倒す。
  orphan: {
    lonely: { name: "lonely", severity: "moderate", via: ["ghost"], effects: [] }
  },
  // 例外対象の advisory オブジェクトと、報告に無い文字列参照を併せ持つパッケージ。
  // info.severity は npm が例外前提なしに求めた値なので、例外を適用しても fallback で
  // severity が復元され得る (#1071 F-02 / F-12)。
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

write_audit_fixture "$TMP/unit-chain.json" chain
write_audit_fixture "$TMP/unit-cycle.json" cycle
write_audit_fixture "$TMP/unit-cycle-rev.json" cycleRev
write_audit_fixture "$TMP/unit-orphan.json" orphan
write_audit_fixture "$TMP/unit-orphan-mix.json" orphanMix
write_audit_fixture "$TMP/unit-dualpkg.json" dualpkg
write_exceptions "$TMP/exceptions-leaf.json" "GHSA-aaaa-aaaa-aaaa,leaf"
write_exceptions "$TMP/exceptions-unused.json" "GHSA-zzzz-zzzz-zzzz,nothing"
write_exceptions "$TMP/exceptions-pkg.json" "GHSA-aaaa-aaaa-aaaa,pkg"
write_exceptions "$TMP/exceptions-stale-other.json" "GHSA-aaaa-aaaa-aaaa,other-pkg"
write_exceptions "$TMP/exceptions-dualpkg.json" "GHSA-aaaa-aaaa-aaaa,pkg1" "GHSA-aaaa-aaaa-aaaa,pkg2"

# stdout は 10 行で、順に status、message、total、critical、high、moderate、low、info、例外件数、blocking 件数となる。
# $3 は 0 始まりの位置を表す。
summary_field() {
    node "$SUMMARY_JS" --audit="$1" --exceptions="$2" --label=テスト --fingerprint=ffff \
        --out="$TMP/unit-summary.json" | sed -n "$(($3 + 1))p"
}

assert_eq "via の文字列要素をたどって high が伝播する" "2" "$(summary_field "$TMP/unit-chain.json" "$EXC_EMPTY" 4)"
assert_eq "伝播した分も blocking に数える" "2" "$(summary_field "$TMP/unit-chain.json" "$EXC_EMPTY" 9)"
assert_eq "例外で葉の advisory が消えると伝播先も消える" "0" "$(summary_field "$TMP/unit-chain.json" "$TMP/exceptions-leaf.json" 4)"
assert_eq "例外で消えた分は例外件数に出る" "1" "$(summary_field "$TMP/unit-chain.json" "$TMP/exceptions-leaf.json" 8)"
assert_eq "総パッケージ数は metadata から取る" "42" "$(summary_field "$TMP/unit-chain.json" "$EXC_EMPTY" 2)"
assert_eq "循環しても止まって high を数える" "2" "$(summary_field "$TMP/unit-cycle.json" "$EXC_EMPTY" 4)"
assert_eq "参照先が報告に無ければ当該パッケージの severity へ倒す" "1" \
    "$(summary_field "$TMP/unit-orphan.json" "$EXC_EMPTY" 5)"
assert_eq "使われなかった例外は件数に載らない" "0" \
    "$(summary_field "$TMP/unit-chain.json" "$TMP/exceptions-unused.json" 8)"
assert_eq "使われなかった例外があっても判定は変わらない" "2" \
    "$(summary_field "$TMP/unit-chain.json" "$TMP/exceptions-unused.json" 4)"

# 一度も一致しなかった例外は excepted-out に「例外未適用」として 1 行残す (#1071 F-11)。
# 判定（件数）は変えない。
UNUSED_EXCEPTED_OUT="$TMP/unused-excepted-out.txt"
node "$SUMMARY_JS" --audit="$TMP/unit-chain.json" --exceptions="$TMP/exceptions-unused.json" \
    --label=テスト --fingerprint=ffff --out="$TMP/unit-summary-unused.json" \
    --excepted-out="$UNUSED_EXCEPTED_OUT" > /dev/null
assert_contains "未適用の例外を要約出力に 1 行残す" \
    "テストの例外未適用: GHSA-zzzz-zzzz-zzzz nothing" "$UNUSED_EXCEPTED_OUT"

# 循環グラフのキー順を逆転しても判定が変わらない (#1071 F-01)。
# 修正前は Object.keys の列挙順に判定が依存し、high 件数が 2 件から 1 件へ減っていた。
assert_eq "循環キー順 a,b で high 2 件になる" "2" "$(summary_field "$TMP/unit-cycle.json" "$EXC_EMPTY" 4)"
assert_eq "循環キー順 b,a でも high 2 件になる（キー順に依存しない）" "2" \
    "$(summary_field "$TMP/unit-cycle-rev.json" "$EXC_EMPTY" 4)"
assert_eq "循環キー順を逆転しても blocking 件数が変わらない" \
    "$(summary_field "$TMP/unit-cycle.json" "$EXC_EMPTY" 9)" "$(summary_field "$TMP/unit-cycle-rev.json" "$EXC_EMPTY" 9)"

# 例外対象の advisory オブジェクトと未解決の文字列参照を併せ持つパッケージ。例外を適用
# しても fallback で severity が復元され得るが、その理由を blocking の advisory 行として
# 残す (#1071 F-02 / F-12)。
assert_eq "例外を適用しても未解決参照の fallback で high が残る" "1" \
    "$(summary_field "$TMP/unit-orphan-mix.json" "$TMP/exceptions-pkg.json" 4)"
assert_eq "例外適用件数は 1 件と出る" "1" \
    "$(summary_field "$TMP/unit-orphan-mix.json" "$TMP/exceptions-pkg.json" 8)"
ORPHAN_MIX_BLOCKING="$TMP/orphan-mix-blocking.txt"
node "$SUMMARY_JS" --audit="$TMP/unit-orphan-mix.json" --exceptions="$TMP/exceptions-pkg.json" \
    --label=テスト --fingerprint=ffff --out="$TMP/unit-summary-orphanmix.json" \
    --blocking-out="$ORPHAN_MIX_BLOCKING" > /dev/null
assert_contains "fallback の理由を blocking の advisory 行に残す" \
    "advisory の参照先 ghost が報告に載っていない" "$ORPHAN_MIX_BLOCKING"

# 同一 advisory id が異なる 2 パッケージへ跨る例外は、重複 throw にならず両方へ独立に
# 適用される (#1071 F-03)。
assert_eq "同一 advisory の 2 パッケージ登録で重複エラーにならず両方消える" "0" \
    "$(summary_field "$TMP/unit-dualpkg.json" "$TMP/exceptions-dualpkg.json" 4)"
assert_eq "両方適用した例外件数は 2 件" "2" \
    "$(summary_field "$TMP/unit-dualpkg.json" "$TMP/exceptions-dualpkg.json" 8)"
# id は一致するが登録 package が違う例外は、単一パッケージのケースと同様に、陳腐化として UNAVAILABLE になる。
# advisory と package の組をキーにしても、通常の不一致検出が働くことを確かめる。
STALE_STDOUT="$TMP/unit-summary-stale.stdout"
node "$SUMMARY_JS" --audit="$TMP/unit-chain.json" --exceptions="$TMP/exceptions-stale-other.json" \
    --label=テスト --fingerprint=ffff --out="$TMP/unit-summary-stale.json" > "$STALE_STDOUT"
assert_eq "登録 package と違う advisory id は UNAVAILABLE" "UNAVAILABLE" "$(sed -n '1p' "$STALE_STDOUT")"
assert_contains "陳腐化の理由に advisory id を含む" "GHSA-aaaa-aaaa-aaaa" "$STALE_STDOUT"

SUMMARY_USAGE_RC=0
node "$SUMMARY_JS" > "$TMP/summary-usage.out" 2> "$TMP/summary-usage.err" || SUMMARY_USAGE_RC=$?
assert_eq "引数不足で exit 1" "1" "$SUMMARY_USAGE_RC"
assert_contains "引数不足で usage を出す" "usage: audit-summary.mjs" "$TMP/summary-usage.err"

# --- 26. 両ツリーが同時に blocking のケース ---
# 配布ツリー・永続層のどちらか一方だけの high しか固定していなかった (#1071 F-09)。
# 両方に high がある応答で、2 つの ERROR ブロックが両方出ることを固定する。

echo "{$CANARY_ADV,$LODASH_HIGH,$IMAGE_SIZE_HIGH}" > "$TMP/both-high.json"
start_mock "$TMP/both-high.json" case26
run_audit case26 --dist="$(new_dist case26)" --runtime-dist="$(new_runtime_dist case26)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$EXC_EMPTY"
assert_eq "両ツリー同時 high で exit 1" "1" "$RC"
assert_contains "配布ツリー側の ERROR ブロックが出る" "配布ツリー: high 以上の脆弱なパッケージ 1 件" "$ERR"
assert_contains "配布ツリー側のパッケージ名を出す" "lodash (high)" "$ERR"
assert_contains "永続層側の ERROR ブロックも出る" "永続層: high 以上の脆弱なパッケージ 1 件" "$ERR"
assert_contains "永続層側のパッケージ名を出す" "image-size (high)" "$ERR"
stop_mock

# --- 27. 永続層の依存解決に失敗（npm install rc≠0）を検知する ---
#
# --dist と --runtime-dist を省略した実行で、resolve_tree() の npm install が失敗する場合は未検証だった (#1071 F-07)。
# 実レジストリへ一切アクセスしないよう、npm install だけをスタブに差し替える。
# install 以外は実 npm に委譲する。特に npm audit も実 npm を使うが、監査先は常に --registry で渡すモックレジストリになる。
# そのため、実レジストリへはアクセスしない。
# 配布ツリー側の install が先に実行されるので、呼び出し回数で挙動を分ける。
# 1 回目（配布）は fixture の shrinkwrap をコピーして成功させ、2 回目（永続層）で失敗させる。

CASE27_DIR="$TMP/case27-npm"
mkdir -p "$CASE27_DIR"
CASE27_COUNT="$CASE27_DIR/install-count"
echo 0 > "$CASE27_COUNT"
REAL_NPM="$(command -v npm)"
cat > "$CASE27_DIR/npm" << STUB_EOF
#!/bin/bash
# audit-mcp-dist.sh の resolve_tree() が呼ぶ npm install だけを差し替える。
# それ以外（npm audit 等）は実 npm に委譲する。実 npm も監査先は常に --registry で
# 渡されたモックレジストリのため、実レジストリへは一切出ない。
if [ "\$1" != "install" ]; then
    exec "$REAL_NPM" "\$@"
fi
N=\$(( \$(cat "$CASE27_COUNT") + 1 ))
echo "\$N" > "$CASE27_COUNT"
if [ "\$N" -eq 1 ]; then
    cp "$FIXTURE/npm-shrinkwrap.json" package-lock.json
    exit 0
fi
echo "stub npm install: 依存解決に失敗（テスト注入）" >&2
exit 1
STUB_EOF
chmod +x "$CASE27_DIR/npm"

start_mock "$TMP/canary-only.json" case27
CASE27_OUT="$TMP/case27.out"
CASE27_ERR="$TMP/case27.err"
CASE27_RC=0
PATH="$CASE27_DIR:$PATH" bash "$AUDIT" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$EXC_EMPTY" \
    > "$CASE27_OUT" 2> "$CASE27_ERR" || CASE27_RC=$?
assert_eq "永続層の依存解決失敗で exit 1" "1" "$CASE27_RC"
assert_contains "永続層で止まったことを理由に出す" \
    "監査未実施のため中止: 永続層: 依存解決に失敗しました" "$CASE27_ERR"
assert_contains "配布ツリー側は install が成功し監査まで進む" "配布ツリーの依存を監査" "$CASE27_OUT"
assert_eq "npm install はちょうど 2 回呼ばれる（配布 成功→永続層 失敗）" "2" "$(cat "$CASE27_COUNT")"
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    fail "永続層の依存解決失敗で中止したのに監査記録が残っている"
else
    pass "永続層の依存解決失敗で中止したとき監査記録を残さない"
fi
stop_mock

# --- 29. release group の解決結果が空、または空要素を含むなら監査を始めずに止める ---
#
# 空の group 名は grep -qxF "" が空行に一致し、宣言なしの plan を宣言ありと誤判定させる。
# release-groups.mjs だけを偽の node で差し替える。偽の node は作る時点で実 node のパスと出力を埋め込み、
# テストの外の環境変数は読まない。release-groups.mjs 以外の呼び出しは実 node へ exec する。

REAL_NODE="$(command -v node)"
make_fake_node() {
    local dir="$1" groups_output="$2"
    mkdir -p "$dir"
    cat > "$dir/node" << FAKE_NODE_EOF
#!/bin/bash
case "\${1:-}" in
    *release-groups.mjs)
        printf '%s' '$groups_output'
        exit 0
        ;;
esac
exec "$REAL_NODE" "\$@"
FAKE_NODE_EOF
    chmod +x "$dir/node"
}

make_fake_node "$TMP/case29a-node" ""
make_fake_node "$TMP/case29b-node" "$(printf 'pecot-visual\n\ntext-rules')"

for variant in a b; do
    case29_dir="$TMP/case29${variant}-node"
    case29_label="空の出力"
    [ "$variant" = "b" ] && case29_label="空要素を含む出力"
    rm -f "$PECOTV_AUDIT_RECORD"
    start_mock "$TMP/canary-only.json" "case29$variant"
    CASE29_OUT="$TMP/case29$variant.out"
    CASE29_ERR="$TMP/case29$variant.err"
    CASE29_RC=0
    PATH="$case29_dir:$PATH" bash "$AUDIT" --dist="$(new_dist "case29$variant")" --runtime-dist="$(new_runtime_dist "case29$variant")" \
        --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$EXC_EMPTY" \
        > "$CASE29_OUT" 2> "$CASE29_ERR" || CASE29_RC=$?
    assert_ne "release group が$case29_label で exit 0 にならない" "0" "$CASE29_RC"
    assert_contains "release group が$case29_label のとき監査未実施として中止する" "監査未実施のため中止: release group" "$CASE29_ERR"
    assert_eq "release group が$case29_label のときレジストリへ問い合わせない" "0" "$(mock_requests)"
    if [ -f "$PECOTV_AUDIT_RECORD" ]; then
        fail "release group が$case29_label で中止したのに監査記録が残っている"
    else
        pass "release group が$case29_label で中止したとき監査記録を残さない"
    fi
    stop_mock
done

# --- 28. テストはリポジトリ本体の監査記録に触れない ---
#
# 既定パスの記録が、本テストの fixture 由来の指紋を持たないことだけを見る。
# 記録の有無や内容そのものは、同じ checkout で開発者が実行したリリース系コマンドでも変わる。
REAL_FP="$(real_record_fingerprint)"
if [ -z "$REAL_FP" ]; then
    pass "リポジトリ本体の既定パスに指紋付きの記録が無い"
else
    assert_ne "リポジトリ本体の既定パスの記録が本テスト由来でない" "$FIXTURE_FP" "$REAL_FP"
fi

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
