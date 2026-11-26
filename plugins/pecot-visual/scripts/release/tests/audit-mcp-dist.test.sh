#!/bin/bash
# audit-mcp-dist.sh の検証 (#1050 / #1071)。監査先はローカルのモックで、2 ツリーとも fixture を渡す。
# `set -e` は使わない。監査失敗の検証で、非ゼロ終了を意図的に起こす。
set -u

# git hook から起動されると export される GIT_* が、被テストスクリプトの unset を打ち消すので捨てる。
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
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

# 本体の記録に触れていないことを末尾で見る。並行する別コマンドの書き込みを拾わないよう、前後の一致は比べない。
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

TMP=$(mktemp -d)
export PECOTV_AUDIT_RECORD="$TMP/audit-record.json"
# npm audit の cacache のキーに severity が入らないので、共有キャッシュでは合否がマシンの状態に左右される。
export npm_config_cache="$TMP/npm-cache"
MOCK_PID=""
cleanup() {
    [ -n "$MOCK_PID" ] && kill "$MOCK_PID" > /dev/null 2>&1
    rm -rf "$TMP"
}
trap cleanup EXIT

# --- モックレジストリ ---
# npm audit の bulk advisory だけを模す。argv[2] は応答 JSON か blackhole（応答しない）、argv[3] は到達の記録。
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
# 本監査の前にカナリア監査（minimist）を行うので、成立させる応答にはカナリアを含める。npm はツリーに無い advisory を捨てる。
# lodash の advisory id はケースごとに変える。同じ id では、先に評価した severity が cacache から返る。
CANARY_ADV='"minimist":[{"id":1097678,"url":"https://github.com/advisories/GHSA-xvch-5gv4-984h","title":"Prototype Pollution in minimist","severity":"critical","vulnerable_versions":">=1.0.0 <1.2.6","cwe":["CWE-1321"],"cvss":{"score":9.8,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}}]'
LODASH_HIGH='"lodash":[{"id":1523,"url":"https://github.com/advisories/GHSA-p6mc-m468-83gw","title":"Prototype Pollution in lodash","severity":"high","vulnerable_versions":"<4.17.19","cwe":["CWE-770"],"cvss":{"score":7.4,"vectorString":"CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N"}}]'
LODASH_MODERATE='"lodash":[{"id":1065,"url":"https://github.com/advisories/GHSA-29mw-wpgm-hmr9","title":"Regular Expression Denial of Service (ReDoS) in lodash","severity":"moderate","vulnerable_versions":"<4.17.21","cwe":["CWE-1333"],"cvss":{"score":5.3,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L"}}]'
# 永続層 fixture (image-size@1.2.1) 用。id・url・vulnerable_versions は実在の advisory の写し。
IMAGE_SIZE_HIGH='"image-size":[{"id":1138808,"url":"https://github.com/advisories/GHSA-w3rx-r6r6-pgpr","title":"image-size: ICNS parser allows denial of service through an infinite loop","severity":"high","vulnerable_versions":"<=2.0.2","cwe":["CWE-835"],"cvss":{"score":7.5,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"}},{"id":1138809,"url":"https://github.com/advisories/GHSA-5p2g-fcmc-qvqq","title":"image-size: JXL and HEIF parsers allow denial of service through infinite loops","severity":"high","vulnerable_versions":"<=2.0.2","cwe":["CWE-835"],"cvss":{"score":7.5,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"}}]'
# 実在の lodash の advisory に critical は無いので、severity だけ差し替えた合成応答。
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
# 記録の欠け・破損・フィールドの欠けを、__ABSENT__・__UNREADABLE__・__MISSING__ で分けて返す。
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
# 実リポの plan の有無に左右されないよう、常に --plans-dir で渡す。
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
bt_eq "脆弱性なしで exit 0" "0" "$RC"
bt_contains "配布ツリーの要約行にパッケージ数が出る" "配布ツリー: 1 パッケージ" "$(cat "$OUT")"
bt_contains "脆弱性なしなら要約行に high 0 が出る" "high 0" "$(cat "$OUT")"
bt_contains "永続層の要約行も同じレイアウトで出る" "永続層: 3 パッケージ" "$(cat "$OUT")"
bt_contains "例外を適用していなければ 0 件と出る" "例外 0 件" "$(cat "$OUT")"
bt_contains "要約行に監査先レジストリが出る" "registry $CASE1_REGISTRY" "$(cat "$OUT")"
bt_contains "要約行に依存ツリーの指紋が出る" "指紋 " "$(cat "$OUT")"
bt_contains "要約行は stderr にも出る" "配布ツリー: 1 パッケージ" "$(cat "$ERR")"
bt_contains "脆弱性なしなら pass のメッセージが出る" "監査 pass（high 以上なし）" "$(cat "$OUT")"

# 記録は publish が読む。指紋が dist-fingerprint.mjs の値と一致し、
# 監査時の HEAD が記録されていることを固定する。
FIXTURE_FP="$(node "$FINGERPRINT" "$FIXTURE/npm-shrinkwrap.json")"
bt_eq "記録の dist.fingerprint が dist-fingerprint.mjs の値と一致" "$FIXTURE_FP" "$(record_field dist.fingerprint)"
bt_eq "記録の head が監査時の HEAD" "$REPO_HEAD" "$(record_field head)"
bt_eq "記録の registry が監査先" "$CASE1_REGISTRY" "$(record_field registry)"
bt_eq "記録の dist.vulnerabilities.high が 0" "0" "$(record_field dist.vulnerabilities.high)"
bt_eq "記録の dist.total が fixture のパッケージ数" "1" "$(record_field dist.total)"
FIXTURE_RUNTIME_FP="$(node "$FINGERPRINT" "$FIXTURE_RUNTIME/npm-shrinkwrap.json")"
bt_eq "記録の runtime.fingerprint が永続層 fixture の指紋" "$FIXTURE_RUNTIME_FP" "$(record_field runtime.fingerprint)"
bt_eq "記録の 2 ツリーの指紋は別値" "1" "$([ "$FIXTURE_FP" != "$FIXTURE_RUNTIME_FP" ] && echo 1 || echo 0)"
bt_eq "記録の runtime.vulnerabilities.high が 0" "0" "$(record_field runtime.vulnerabilities.high)"
bt_eq "記録の runtime.total が永続層 fixture のパッケージ数" "3" "$(record_field runtime.total)"
bt_contains "要約行の指紋が記録と同じ値" "指紋 $FIXTURE_FP" "$(cat "$OUT")"
stop_mock

# --- 2. high の advisory でリリースを止める ---

start_mock "$TMP/high.json" case2
place_stale_record
run_audit case2 --dist="$(new_dist case2)" --runtime-dist="$(new_runtime_dist case2)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "high 検出で exit 1" "1" "$RC"
bt_contains "high 検出で high 以上の件数を出す" "high 以上の脆弱なパッケージ 1 件" "$(cat "$ERR")"
bt_contains "high 検出で脆弱なパッケージ名を出す" "lodash (high)" "$(cat "$ERR")"
bt_contains "high 検出で advisory の title を出す" "Prototype Pollution in lodash" "$(cat "$ERR")"
bt_contains "high 検出で advisory の URL を出す" "https://github.com/advisories/GHSA-p6mc-m468-83gw" "$(cat "$ERR")"
bt_contains "要約行も出る（判定条件がログに残る）" "配布ツリー: 1 パッケージ" "$(cat "$ERR")"
# 記録が残ると publish が「監査を通った」と読む。high での中止では消えていること。
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    bt_fail "high 検出で中止したとき監査記録を残さない" "high 検出で中止したのに監査記録が残っている"
else
    bt_pass "high 検出で中止したとき監査記録を残さない"
fi
stop_mock

# --- 3. 監査エンドポイント不達（接続拒否）で止める ---

place_stale_record
run_audit case3 --dist="$(new_dist case3)" --runtime-dist="$(new_runtime_dist case3)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="$CLOSED_REGISTRY"
bt_eq "接続拒否で exit 1" "1" "$RC"
bt_contains "接続拒否を未実施として中止する" "監査未実施のため中止" "$(cat "$ERR")"
if grep -qF "監査 pass" "$OUT"; then
    bt_fail "不達時は pass を出さない" "不達なのに pass を出した"
else
    bt_pass "不達時は pass を出さない"
fi
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    bt_fail "監査未実施で中止したとき監査記録を残さない" "監査未実施で中止したのに監査記録が残っている"
else
    bt_pass "監査未実施で中止したとき監査記録を残さない"
fi

# --- 4. 無応答の監査エンドポイントで待ち上限が働く ---

start_mock blackhole case4
START=$SECONDS
run_audit case4 --dist="$(new_dist case4)" --runtime-dist="$(new_runtime_dist case4)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT" --timeout=3
ELAPSED=$((SECONDS - START))
bt_eq "無応答で exit 1" "1" "$RC"
bt_contains "無応答を未実施として中止する" "監査未実施のため中止" "$(cat "$ERR")"
bt_contains "待ち上限の秒数を出す" "3 秒以内に応答なし" "$(cat "$ERR")"
if [ "$ELAPSED" -le 6 ]; then
    bt_pass "--timeout=3 が 6 秒以内に打ち切る"
else
    bt_fail "--timeout=3 が 6 秒以内に打ち切る" "--timeout=3 が働いていない (${ELAPSED}s)"
fi
# 最初の npm 呼び出しはカナリア監査。そこで無応答になるので bulk への到達は 1 件。
bt_eq "無応答サーバへは到達している" "1" "$(mock_requests)"
stop_mock

# --- 5. --registry が npm_config_registry を上書きする ---
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
bt_eq "--registry が env より優先されて exit 0" "0" "$RC"
# カナリア監査と 2 ツリーの監査で bulk へ 3 回投げる。
bt_eq "モックレジストリに到達している" "3" "$(wc -l < "$MOCK5_COUNT" | tr -d ' ')"
bt_contains "要約行の registry は --registry の値" "registry http://127.0.0.1:$MOCK_PORT" "$(cat "$OUT")"
stop_mock

# --- 6. pecot-visual の version plan が無ければ監査せずスキップ ---
# 別のリリースでも pecot-visual の pre-version は動く。
# HEAD のリリースタグは再監査を開くので、タグ無しを env で固定する。
start_mock "$TMP/canary-only.json" case6
MOCK6_COUNT="$MOCK_COUNT"
OUT="$TMP/case6.out"
ERR="$TMP/case6.err"
RC=0
PECOTV_AUDIT_HEAD_TAGS="" bash "$AUDIT" --dist="$(new_dist case6)" --runtime-dist="$(new_runtime_dist case6)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$PLANS_PECOT_ONLY" --registry="http://127.0.0.1:$MOCK_PORT" \
    > "$OUT" 2> "$ERR" || RC=$?
bt_eq "pecot-visual 宣言が無ければ exit 0" "0" "$RC"
bt_contains "pecot-visual 宣言が無ければスキップの理由を出す" "スキップ: pecot-visual の version plan が無いため" "$(cat "$OUT")"
bt_eq "pecot-visual 宣言が無いスキップではレジストリへ 1 件も投げない" "0" "$(wc -l < "$MOCK6_COUNT" | tr -d ' ')"
# publish はこの記録を読んで「監査していないリリース」と判定する。
bt_eq "pecot-visual 宣言が無いスキップの記録は skipped: true" "true" "$(record_field skipped)"
bt_eq "スキップ時の記録に監査時 HEAD が入る" "$REPO_HEAD" "$(record_field head)"
bt_eq "スキップ時の記録に dist セクションは無い" "__MISSING__" "$(record_field dist.fingerprint)"
stop_mock

# --- 6b. --dev は version plan の探索先が無くても監査する（開発版の build）---

start_mock "$TMP/moderate.json" case6b
run_audit case6b --dist="$(new_dist case6b)" --runtime-dist="$(new_runtime_dist case6b)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$TMP/no-such-plans" --dev --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "--dev は plan が無くても exit 0" "0" "$RC"
bt_contains "--dev は開発版として監査する旨を出す" "開発版: version plan とリリースタグを見ずに監査する" "$(cat "$OUT")"
bt_contains "--dev でも監査の pass を出す" "監査 pass（high 以上なし）" "$(cat "$OUT")"
bt_eq "--dev の記録は skipped ではない" "__MISSING__" "$(record_field skipped)"
stop_mock

# --- 6c. --dev は high を警告にとどめ、件数を記録に残す (#658) ---

start_mock "$TMP/image-size-high.json" case6c
run_audit case6c --dist="$(new_dist case6c)" --runtime-dist="$(new_runtime_dist case6c)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$TMP/no-such-plans" --dev --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "--dev は high があっても exit 0" "0" "$RC"
bt_contains "--dev は high を警告として出す" "WARNING: 永続層: high 以上の脆弱なパッケージ 1 件" "$(cat "$ERR")"
bt_contains "--dev の警告に脆弱なパッケージ名を出す" "image-size (high)" "$(cat "$ERR")"
bt_contains "--dev の警告に advisory の URL を出す" "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr" "$(cat "$ERR")"
bt_contains "--dev は high を残して続行した旨を出す" "開発版: high 以上 1 件を警告して続行" "$(cat "$OUT")"
bt_eq "--dev の記録に永続層の high 件数が入る" "1" "$(record_field runtime.vulnerabilities.high)"
stop_mock

start_mock "$TMP/high.json" case6c-dist
run_audit case6c-dist --dist="$(new_dist case6c-dist)" --runtime-dist="$(new_runtime_dist case6c-dist)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$TMP/no-such-plans" --dev --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "--dev は配布ツリーに high があっても exit 0" "0" "$RC"
bt_contains "--dev は配布ツリーの high を警告として出す" "WARNING: 配布ツリー: high 以上の脆弱なパッケージ 1 件" "$(cat "$ERR")"
bt_contains "--dev の配布ツリーの警告に脆弱なパッケージ名を出す" "lodash (high)" "$(cat "$ERR")"
bt_eq "--dev の記録に配布ツリーの high 件数が入る" "1" "$(record_field dist.vulnerabilities.high)"
stop_mock

# --- 6d. --dev でも、監査結果が得られなければ止める ---

start_mock "$TMP/no-advisory.json" case6d
run_audit case6d --dist="$(new_dist case6d)" --runtime-dist="$(new_runtime_dist case6d)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$TMP/no-such-plans" --dev --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "--dev でもカナリア不検出で exit 1" "1" "$RC"
bt_contains "--dev でも未実施として中止する" "監査未実施のため中止" "$(cat "$ERR")"
bt_eq "--dev の未実施では記録を残さない" "__ABSENT__" "$(record_field head)"
stop_mock

# --- 7. moderate だけなら pass する（判定境界の下側）---

start_mock "$TMP/moderate.json" case7
run_audit case7 --dist="$(new_dist case7)" --runtime-dist="$(new_runtime_dist case7)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "moderate のみで exit 0" "0" "$RC"
bt_contains "要約行に moderate 1 が出る" "moderate 1" "$(cat "$OUT")"
bt_contains "moderate だけなら要約行に high 0 が出る" "high 0" "$(cat "$OUT")"
bt_contains "moderate だけなら pass のメッセージが出る" "監査 pass（high 以上なし）" "$(cat "$OUT")"
stop_mock

# --- 8. critical だけでも止める（判定境界の上側）---

start_mock "$TMP/critical.json" case8
run_audit case8 --dist="$(new_dist case8)" --runtime-dist="$(new_runtime_dist case8)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "critical のみで exit 1" "1" "$RC"
bt_contains "critical のみで high 以上の件数を出す" "high 以上の脆弱なパッケージ 1 件" "$(cat "$ERR")"
bt_contains "severity に critical を出す" "lodash (critical)" "$(cat "$ERR")"
bt_contains "critical のみで advisory の title を出す" "Command Injection in lodash" "$(cat "$ERR")"
stop_mock

# --- 9. advisory を返さないレジストリはカナリアで検知して止める ---
# bulk が 200 と `{}` を返す先は「脆弱性 0 件」と区別が付かないので、カナリアで見分ける。

start_mock "$TMP/no-advisory.json" case9
run_audit case9 --dist="$(new_dist case9)" --runtime-dist="$(new_runtime_dist case9)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "カナリア不検出で exit 1" "1" "$RC"
bt_contains "カナリア不検出を未実施として中止する" "監査未実施のため中止" "$(cat "$ERR")"
bt_contains "advisory 未提供のレジストリとして理由を出す" "既知の advisory を返しません" "$(cat "$ERR")"
if grep -qF "監査 pass" "$OUT"; then
    bt_fail "advisory 未提供のレジストリでは pass を出さない" "advisory 未提供なのに pass を出した"
else
    bt_pass "advisory 未提供のレジストリでは pass を出さない"
fi
stop_mock

# --- 10. pecot-visual 宣言が解釈できない version plan は中止する ---
# スキップに倒すと、bump されるのに監査だけが抜ける。

start_mock "$TMP/canary-only.json" case10
MOCK10_COUNT="$MOCK_COUNT"
run_audit case10 --dist="$(new_dist case10)" --runtime-dist="$(new_runtime_dist case10)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV_QUOTED" \
    --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "解釈できない pecot-visual 宣言で exit 1" "1" "$RC"
bt_contains "解釈できない pecot-visual 宣言を未実施として中止する" "監査未実施のため中止" "$(cat "$ERR")"
bt_contains "解釈できない plan のパスを出す" "998-quoted.md" "$(cat "$ERR")"
bt_eq "中止時はレジストリへ 1 件も投げない" "0" "$(wc -l < "$MOCK10_COUNT" | tr -d ' ')"
stop_mock

# text-rules の宣言も同じ扱いにする。updateDependents: always により、text-rules の bump は pecot-visual のリリースになる。
start_mock "$TMP/canary-only.json" case10b
MOCK10B_COUNT="$MOCK_COUNT"
run_audit case10b --dist="$(new_dist case10b)" --runtime-dist="$(new_runtime_dist case10b)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_TEXT_RULES_QUOTED" \
    --registry="http://127.0.0.1:$MOCK_PORT"
bt_eq "解釈できない text-rules 宣言で exit 1" "1" "$RC"
bt_contains "text-rules の宣言でも未実施として中止する" "監査未実施のため中止" "$(cat "$ERR")"
bt_contains "解釈できない text-rules の plan のパスを出す" "996-quoted.md" "$(cat "$ERR")"
bt_eq "text-rules の宣言で中止するときもレジストリへ 1 件も投げない" "0" "$(wc -l < "$MOCK10B_COUNT" | tr -d ' ')"
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
    bt_eq "引用符付きの $label キーでも exit 0" "0" "$RC"
    bt_contains "引用符付きの $label キーでは監査を実際に行う" "監査 pass（high 以上なし）" "$(cat "$TMP/$case_id.out")"
    bt_eq "引用符付きの $label キーでレジストリへ 3 件投げる" "3" "$(wc -l < "$QUOTED_COUNT" | tr -d ' ')"
    stop_mock
done

# --- 11. version plan の探索先が存在しないときは中止する ---

run_audit case11 --dist="$(new_dist case11)" --runtime-dist="$(new_runtime_dist case11)" --exceptions="$EXC_EMPTY" --plans-dir="$TMP/plans-missing" \
    --registry="$CLOSED_REGISTRY"
bt_eq "探索先の不在で exit 1" "1" "$RC"
bt_contains "探索先が無いことを理由に出す" "version plan の探索先がありません" "$(cat "$ERR")"

# --- 12. --timeout=0 は待ち上限の無効化になるため弾く ---
# coreutils の timeout は duration 0 を「上限なし」として扱う。

run_audit case12 --dist="$(new_dist case12)" --runtime-dist="$(new_runtime_dist case12)" --exceptions="$EXC_EMPTY" --plans-dir="$PLANS_PECOTV" \
    --registry="$CLOSED_REGISTRY" --timeout=0
bt_eq "--timeout=0 で exit 1" "1" "$RC"
bt_contains "正の整数を要求する" "正の整数" "$(cat "$ERR")"

# --- 13. dist-manifest.mjs の直接起動 ---
# --dist 固定ツリーのケースでは argv と stdout の誤りを拾えないので、単体で確かめる。

MANIFEST_JS="$RELEASE_DIR/dist-manifest.mjs"
PECOTV_PLUGIN_ROOT="$(cd "$RELEASE_DIR/../.." && pwd)"
MANIFEST_REPO_ROOT="$(cd "$PECOTV_PLUGIN_ROOT/../.." && pwd)"

MANIFEST_RC=0
node "$MANIFEST_JS" "$PECOTV_PLUGIN_ROOT" 0.0.0-test "$MANIFEST_REPO_ROOT" \
    > "$TMP/manifest.json" 2> "$TMP/manifest.err" || MANIFEST_RC=$?
bt_eq "dist-manifest.mjs の直接起動が exit 0" "0" "$MANIFEST_RC"

# 出力が有効な JSON であること（不正なら node が非ゼロで返り、下の assert が落ちる）。
MANIFEST_VERSION="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version))' \
    "$TMP/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"
bt_eq "出力が有効な JSON で version は引数どおり" "0.0.0-test" "$MANIFEST_VERSION"

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
bt_eq "直接起動の dependencies が import 経由と一致" "$IMPORT_DEPS" "$DIRECT_DEPS"
# 同梱する text-rules の依存は libs/text-rules/package.json の dependencies から導く。名前を列挙せず、
# その宣言と範囲まで比較する（配布 package.json に無い、または範囲が違う名前を列挙する）。
TEXT_RULES_DEP_GAP="$(node -e '
const fs = require("node:fs")
const textRules = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dependencies
const out = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).dependencies
const gap = Object.entries(textRules).filter(([name, range]) => out[name] !== range).map(([name]) => name)
process.stdout.write(Object.keys(textRules).length === 0 ? "TEXT_RULES_HAS_NO_DEPENDENCIES" : gap.sort().join(","))
' "$MANIFEST_REPO_ROOT/libs/text-rules/package.json" "$TMP/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"
bt_eq "直接起動の dependencies が libs/text-rules/package.json の dependencies を範囲ごと全部含む" "" "$TEXT_RULES_DEP_GAP"
if [ -n "$IMPORT_DEPS" ]; then
    bt_pass "dependencies が空でない"
else
    bt_fail "dependencies が空でない" "dependencies が空（比較が無意味になっている）"
fi

USAGE_RC=0
node "$MANIFEST_JS" > "$TMP/manifest-usage.out" 2> "$TMP/manifest-usage.err" || USAGE_RC=$?
bt_eq "dist-manifest.mjs は引数不足で exit 1" "1" "$USAGE_RC"
bt_contains "dist-manifest.mjs は引数不足で usage を出す" "usage: dist-manifest.mjs" "$(cat "$TMP/manifest-usage.err")"
bt_contains "usage が repo root の引数を示す" "<repo-root>" "$(cat "$TMP/manifest-usage.err")"

# --- 14. version plan が無くても HEAD のリリースタグがあれば再監査する ---
# publish が指紋の不一致で止まった後、release commit で記録を作り直す場合。plan は消費済みで無い。
# タグは worktree 間で共有されるので作らず、PECOTV_AUDIT_HEAD_TAGS で差し替える。

start_mock "$TMP/canary-only.json" case14
MOCK14_COUNT="$MOCK_COUNT"
OUT="$TMP/case14.out"
ERR="$TMP/case14.err"
RC=0
PECOTV_AUDIT_HEAD_TAGS="pecot-visual-v$PLUGIN_VERSION" bash "$AUDIT" --dist="$(new_dist case14)" --runtime-dist="$(new_runtime_dist case14)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$PLANS_PECOT_ONLY" --registry="http://127.0.0.1:$MOCK_PORT" \
    > "$OUT" 2> "$ERR" || RC=$?
bt_eq "リリースタグがあれば plan 無しでも exit 0" "0" "$RC"
bt_contains "再監査として実行したことを出す" "再監査: HEAD に pecot-visual-v$PLUGIN_VERSION" "$(cat "$OUT")"
bt_contains "リリースタグがあれば監査を実際に行う" "監査 pass（high 以上なし）" "$(cat "$OUT")"
bt_eq "再監査ではレジストリへ 3 件投げる" "3" "$(wc -l < "$MOCK14_COUNT" | tr -d ' ')"
bt_eq "再監査の記録は skipped ではない" "__MISSING__" "$(record_field skipped)"
bt_eq "再監査の記録に指紋が入る" "$(node "$FINGERPRINT" "$FIXTURE/npm-shrinkwrap.json")" \
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
bt_eq "別版のリリースタグではスキップする" "0" "$RC"
bt_contains "別版のリリースタグではスキップの理由を出す" "スキップ: pecot-visual の version plan が無いため" "$(cat "$OUT")"
stop_mock

# --- 14c. 依存先の group だけの plan でも監査する (#1297) ---
# text-rules の group は updateDependents: always。text-rules だけの plan でも pecot-visual が上がる。
start_mock "$TMP/canary-only.json" case14c
MOCK14C_COUNT="$MOCK_COUNT"
OUT="$TMP/case14c.out"
RC=0
PECOTV_AUDIT_HEAD_TAGS="" bash "$AUDIT" --dist="$(new_dist case14c)" --runtime-dist="$(new_runtime_dist case14c)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$PLANS_TEXT_RULES" --registry="http://127.0.0.1:$MOCK_PORT" \
    > "$OUT" 2> "$TMP/case14c.err" || RC=$?
bt_eq "text-rules だけの plan でも exit 0" "0" "$RC"
bt_contains "text-rules だけの plan でも監査を実際に行う" "監査 pass（high 以上なし）" "$(cat "$OUT")"
SKIP_LINES=0
grep -q 'スキップ' "$OUT" && SKIP_LINES=1
bt_eq "text-rules だけの plan ではスキップの行が出ない" "0" "$SKIP_LINES"
bt_eq "text-rules だけの plan でレジストリへ 3 件投げる" "3" "$(wc -l < "$MOCK14C_COUNT" | tr -d ' ')"
bt_eq "記録は skipped ではない" "__MISSING__" "$(record_field skipped)"
stop_mock

# 無関係な group だけの plan は、従来どおりスキップする。
start_mock "$TMP/canary-only.json" case14d
MOCK14D_COUNT="$MOCK_COUNT"
OUT="$TMP/case14d.out"
RC=0
PECOTV_AUDIT_HEAD_TAGS="" bash "$AUDIT" --dist="$(new_dist case14d)" --runtime-dist="$(new_runtime_dist case14d)" --exceptions="$EXC_EMPTY" \
    --plans-dir="$PLANS_WORKFLOW_ONLY" --registry="http://127.0.0.1:$MOCK_PORT" \
    > "$OUT" 2> "$TMP/case14d.err" || RC=$?
bt_eq "pecot-workflow だけの plan でも exit 0" "0" "$RC"
bt_contains "pecot-workflow だけの plan ではスキップの理由を出す" "スキップ: pecot-visual の version plan が無いため" "$(cat "$OUT")"
bt_eq "pecot-workflow だけの plan のスキップではレジストリへ 1 件も投げない" "0" "$(wc -l < "$MOCK14D_COUNT" | tr -d ' ')"
bt_eq "pecot-workflow だけの plan のスキップの記録は skipped: true" "true" "$(record_field skipped)"
stop_mock

# --- 14e. release-groups.mjs: 依存先の group を workspace: 依存から求める ---
# 実リポジトリでは pecot-visual と text-rules の 2 つになる。
bt_eq "実リポジトリの対象 group は pecot-visual と text-rules" "pecot-visual,text-rules" \
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
bt_eq "workspace: 依存の group だけが対象になる" "pecot-visual,alpha-group,beta-group" \
    "$(node "$RELEASE_DIR/release-groups.mjs" "$GROUPS_REPO" | paste -sd ',' -)"

# 依存先を含む group が nx.json に無ければ、静かに抜けず exit 1 で止める。
cat > "$GROUPS_REPO/nx.json" << 'JSON_EOF'
{ "release": { "groups": { "pecot-visual": { "projects": ["pecot-visual"] } } } }
JSON_EOF
GROUPS_RC=0
node "$RELEASE_DIR/release-groups.mjs" "$GROUPS_REPO" > "$TMP/groups.out" 2> "$TMP/groups.err" || GROUPS_RC=$?
bt_eq "group を引けないときは exit 1" "1" "$GROUPS_RC"
bt_contains "引けない project 名を出す" "alpha-project" "$(cat "$TMP/groups.err")"

# --- 15. dist-fingerprint.mjs の単体 ---
# 指紋はルート "" の version を除いて取る。監査（bump 前）と publish（bump 後）で同じ値になる。

FP_BASE="$(node "$FINGERPRINT" "$FIXTURE/npm-shrinkwrap.json")"
bt_eq "指紋は 64 桁 hex" "1" \
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
bt_eq "ルートの version を変えても指紋は変わらない" "$FP_BASE" \
    "$(node "$FINGERPRINT" "$TMP/sw-root-version.json")"

mutate_shrinkwrap "$TMP/sw-root-deps.json" root-deps
if [ "$(node "$FINGERPRINT" "$TMP/sw-root-deps.json")" != "$FP_BASE" ]; then
    bt_pass "ルートの dependencies 宣言を変えると指紋が変わる"
else
    bt_fail "ルートの dependencies 宣言を変えると指紋が変わる" "ルートの dependencies 宣言を変えても指紋が同じ"
fi

mutate_shrinkwrap "$TMP/sw-dep-version.json" dep-version
if [ "$(node "$FINGERPRINT" "$TMP/sw-dep-version.json")" != "$FP_BASE" ]; then
    bt_pass "依存の version を変えると指紋が変わる"
else
    bt_fail "依存の version を変えると指紋が変わる" "依存の version を変えても指紋が同じ"
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
bt_eq "キー順だけの違いでは指紋が変わらない" "$FP_BASE" \
    "$(node "$FINGERPRINT" "$TMP/sw-reordered.json")"

mutate_shrinkwrap "$TMP/sw-no-packages.json" no-packages
FP_RC=0
node "$FINGERPRINT" "$TMP/sw-no-packages.json" > /dev/null 2> "$TMP/fp-nopkg.err" || FP_RC=$?
bt_eq "packages が無い入力で非ゼロ終了" "1" "$FP_RC"
bt_contains "packages が無い理由を出す" "packages がありません" "$(cat "$TMP/fp-nopkg.err")"

# 依存解決が丸ごと失敗した shrinkwrap（packages にルート "" が無い）を有効な指紋として
# 扱わない。
mutate_shrinkwrap "$TMP/sw-empty-packages.json" empty-packages
FP_EMPTY_RC=0
node "$FINGERPRINT" "$TMP/sw-empty-packages.json" > /dev/null 2> "$TMP/fp-empty.err" || FP_EMPTY_RC=$?
bt_eq "packages が空の入力で非ゼロ終了" "1" "$FP_EMPTY_RC"
bt_contains "ルート \"\" が無い理由を出す" 'ルート "" がありません' "$(cat "$TMP/fp-empty.err")"

FP_USAGE_RC=0
node "$FINGERPRINT" > "$TMP/fp-usage.out" 2> "$TMP/fp-usage.err" || FP_USAGE_RC=$?
bt_eq "dist-fingerprint.mjs は引数不足で exit 1" "1" "$FP_USAGE_RC"
bt_contains "dist-fingerprint.mjs は引数不足で usage を出す" "usage: dist-fingerprint.mjs" "$(cat "$TMP/fp-usage.err")"

# --- 16. 永続層の high を例外で通す ---
# 例外は判定を免れる唯一の仕組みなので、件数・列挙・記録をまとめて固定する。

start_mock "$TMP/image-size-high.json" case16
run_audit case16 --dist="$(new_dist case16)" --runtime-dist="$(new_runtime_dist case16)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_IMAGE_SIZE"
bt_eq "永続層の例外 2 件で exit 0" "0" "$RC"
bt_contains "永続層の要約行に例外件数が出る" "例外 2 件" "$(cat "$OUT")"
bt_contains "免除した advisory を本文に列挙する (1 件目)" \
    "永続層の例外適用: GHSA-w3rx-r6r6-pgpr image-size (high)" "$(cat "$OUT")"
bt_contains "免除した advisory を本文に列挙する (2 件目)" \
    "永続層の例外適用: GHSA-5p2g-fcmc-qvqq image-size (high)" "$(cat "$OUT")"
bt_contains "例外の列挙は stderr にも出る" \
    "永続層の例外適用: GHSA-w3rx-r6r6-pgpr image-size (high)" "$(cat "$ERR")"
bt_contains "永続層の例外 2 件で pass のメッセージが出る" "監査 pass（high 以上なし）" "$(cat "$OUT")"
bt_eq "記録の runtime.excepted は 2 件" "2" "$(record_field runtime.excepted.length)"
bt_eq "記録の runtime.excepted に severity が入る" "high" "$(record_field runtime.excepted.0.severity)"
bt_eq "記録の runtime.excepted は advisory 順" "GHSA-5p2g-fcmc-qvqq" "$(record_field runtime.excepted.0.advisory)"
bt_eq "例外を除いた runtime.vulnerabilities.high は 0" "0" "$(record_field runtime.vulnerabilities.high)"
bt_eq "配布ツリー側の例外は 0 件" "0" "$(record_field dist.excepted.length)"
stop_mock

# --- 17. 例外が無ければ永続層の high で止める ---
# 例外の仕組みが、常に判定を免れさせる実装になっていないことの裏返しとなる。

start_mock "$TMP/image-size-high.json" case17
run_audit case17 --dist="$(new_dist case17)" --runtime-dist="$(new_runtime_dist case17)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_EMPTY"
bt_eq "例外なしの永続層 high で exit 1" "1" "$RC"
bt_contains "どちらのツリーで止めたかを出す" "永続層: high 以上の脆弱なパッケージ 1 件" "$(cat "$ERR")"
bt_contains "永続層の high で脆弱なパッケージ名を出す" "image-size (high)" "$(cat "$ERR")"
bt_contains "永続層の high で advisory の URL を出す" "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr" "$(cat "$ERR")"
bt_contains "配布ツリーの要約行も出る" "配布ツリー: 1 パッケージ" "$(cat "$ERR")"
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    bt_fail "永続層の high で中止したとき監査記録を残さない" "永続層の high で中止したのに監査記録が残っている"
else
    bt_pass "永続層の high で中止したとき監査記録を残さない"
fi
stop_mock

# --- 18. 例外が 1 件足りなければ止める ---

start_mock "$TMP/image-size-high.json" case18
run_audit case18 --dist="$(new_dist case18)" --runtime-dist="$(new_runtime_dist case18)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_IMAGE_SIZE_ONE"
bt_eq "例外 1 件だけでは exit 1" "1" "$RC"
bt_contains "適用した例外は要約行に出る" "例外 1 件" "$(cat "$ERR")"
bt_contains "残る advisory で止める" "永続層: high 以上の脆弱なパッケージ 1 件" "$(cat "$ERR")"
stop_mock

# --- 19. id は一致するが package が違う例外は陳腐化として中止する ---
# 「例外なし」に倒すと、記載が実データと合わないまま運用が続くので、未実施として止める。

start_mock "$TMP/image-size-high.json" case19
run_audit case19 --dist="$(new_dist case19)" --runtime-dist="$(new_runtime_dist case19)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_WRONG_PACKAGE"
bt_eq "例外の陳腐化で exit 1" "1" "$RC"
bt_contains "例外の陳腐化を未実施として中止する" "監査未実施のため中止" "$(cat "$ERR")"
bt_contains "どちらのツリーかを出す" "永続層" "$(cat "$ERR")"
bt_contains "陳腐化した例外の id を出す" "GHSA-w3rx-r6r6-pgpr" "$(cat "$ERR")"
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    bt_fail "例外の陳腐化で中止したとき監査記録を残さない" "例外の陳腐化で中止したのに監査記録が残っている"
else
    bt_pass "例外の陳腐化で中止したとき監査記録を残さない"
fi
stop_mock

# --- 20. 例外は配布ツリーにも同じ規則で適用される ---

start_mock "$TMP/high.json" case20
run_audit case20 --dist="$(new_dist case20)" --runtime-dist="$(new_runtime_dist case20)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_LODASH"
bt_eq "配布ツリーの例外で exit 0" "0" "$RC"
bt_contains "免除した advisory を配布ツリー側でも列挙する" \
    "配布ツリーの例外適用: GHSA-p6mc-m468-83gw lodash (high)" "$(cat "$OUT")"
bt_contains "例外を除いた配布ツリーの high は 0" "配布ツリー: 1 パッケージ / critical 0 / high 0" "$(cat "$OUT")"
bt_contains "配布ツリーの例外で pass のメッセージが出る" "監査 pass（high 以上なし）" "$(cat "$OUT")"
bt_eq "記録の dist.excepted は 1 件" "1" "$(record_field dist.excepted.length)"
stop_mock

# --- 21. 形の違う例外リストは監査未実施として中止する ---
# 例外は判定を緩める唯一の仕組みなので、読めない記載や形の違う記載を「例外なし」に倒さない。

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
    bt_eq "$label で exit 1" "1" "$RC"
    bt_contains "$label を未実施として中止する" "監査未実施のため中止" "$(cat "$ERR")"
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
bt_eq "明示した例外リストの不在で exit 1" "1" "$RC"
bt_contains "指定した例外リストが無いことを理由に出す" "指定された例外リストがありません" "$(cat "$ERR")"

# --- 22. --dist と --runtime-dist は対で渡す ---
# 片方だけだと、もう一方がモックの `{}` で 0 件 pass になり気付けないので、引数の時点で弾く。

run_audit case22a --dist="$(new_dist case22a)" --plans-dir="$PLANS_PECOTV" \
    --registry="$CLOSED_REGISTRY" --exceptions="$EXC_EMPTY"
bt_eq "--dist だけの指定で exit 1" "1" "$RC"
bt_contains "--dist だけの指定では両方指定を要求する" "両方指定するか両方省略" "$(cat "$ERR")"

run_audit case22b --runtime-dist="$(new_runtime_dist case22b)" --plans-dir="$PLANS_PECOTV" \
    --registry="$CLOSED_REGISTRY" --exceptions="$EXC_EMPTY"
bt_eq "--runtime-dist だけの指定で exit 1" "1" "$RC"
bt_contains "--runtime-dist だけの指定では両方指定を要求する" "両方指定するか両方省略" "$(cat "$ERR")"

# --- 23. 永続層に lockfile が無ければ監査未実施として中止する ---
# 2 ツリーを同じ関数で監査するので、中止の文言にツリー名が入ることを確かめる。

CASE23_RUNTIME="$TMP/runtime-case23-nolock"
rm -rf "$CASE23_RUNTIME"
mkdir -p "$CASE23_RUNTIME"
cp "$FIXTURE_RUNTIME/package.json" "$CASE23_RUNTIME/"
start_mock "$TMP/canary-only.json" case23
run_audit case23 --dist="$(new_dist case23)" --runtime-dist="$CASE23_RUNTIME" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" \
    --exceptions="$EXC_EMPTY"
bt_eq "永続層の lockfile 欠落で exit 1" "1" "$RC"
bt_contains "永続層で止まったことを文言に残す" "監査未実施のため中止: 永続層:" "$(cat "$ERR")"
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    bt_fail "永続層の未実施で中止したとき監査記録を残さない" "永続層の未実施で中止したのに監査記録が残っている"
else
    bt_pass "永続層の未実施で中止したとき監査記録を残さない"
fi
stop_mock

# --- 24. runtime-manifest.mjs の直接起動 ---
# --runtime-dist 固定ツリーでは argv と stdout の誤りを拾えないので、単体で確かめる。
# cli の runtimeInstallPlan との同値は runtime-manifest.test.sh が確かめる。

RUNTIME_MANIFEST_RC=0
node "$RUNTIME_MANIFEST_JS" "$PECOTV_PLUGIN_ROOT" \
    > "$TMP/runtime-manifest.json" 2> "$TMP/runtime-manifest.err" || RUNTIME_MANIFEST_RC=$?
bt_eq "runtime-manifest.mjs の直接起動が exit 0" "0" "$RUNTIME_MANIFEST_RC"

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

bt_eq "出力が有効な JSON で name は pecotv-runtime" "pecotv-runtime" "$(runtime_manifest_field name)"

CORE_PIN="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).dependencies["@slidev/cli"]))' \
    "$PECOTV_PLUGIN_ROOT/assets/slidev/runtime/package.json")"
bt_eq "中核パッケージは runtime manifest の @slidev/cli の版で固定する" "$CORE_PIN" "$(runtime_manifest_field @slidev/cli)"
bt_eq "@slidev/client も同じ pin で固定する" "$CORE_PIN" "$(runtime_manifest_field @slidev/client)"
bt_eq "@slidev/parser を明示的に含む" "$CORE_PIN" "$(runtime_manifest_field @slidev/parser)"
bt_ne "dom-to-pptx を含む" "__MISSING__" "$(runtime_manifest_field dom-to-pptx)"
bt_eq "workspace: 等のローカル参照を含まない" "" "$(runtime_manifest_field workspace)"
bt_eq "playwright は install 対象外なので含まない" "__MISSING__" "$(runtime_manifest_field playwright)"

RUNTIME_OVERRIDES="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).overrides))' \
    "$PECOTV_PLUGIN_ROOT/assets/slidev/runtime/package.json")"
bt_eq "overrides が runtime の manifest の写しになっている" "$RUNTIME_OVERRIDES" "$(runtime_manifest_field overrides)"

# vite は catalog: で参照される。直接起動の出力では catalog の範囲に解決され、catalog: が残らない。
CATALOG_VITE="$(cd "$REPO_ROOT" && node -e '
const { parse } = require("yaml")
const w = parse(require("node:fs").readFileSync("pnpm-workspace.yaml", "utf8"))
process.stdout.write(String((w.catalog ?? w.catalogs?.default ?? {}).vite))')"
bt_eq "vite が catalog の範囲に解決される" "$CATALOG_VITE" "$(runtime_manifest_field vite)"
if grep -qF 'catalog:' "$TMP/runtime-manifest.json"; then
    bt_fail "直接起動の出力に catalog: が残らない" "直接起動の出力に catalog: が残っている"
else
    bt_pass "直接起動の出力に catalog: が残らない"
fi

RUNTIME_USAGE_RC=0
node "$RUNTIME_MANIFEST_JS" > "$TMP/runtime-manifest-usage.out" 2> "$TMP/runtime-manifest-usage.err" \
    || RUNTIME_USAGE_RC=$?
bt_eq "runtime-manifest.mjs は引数不足で exit 1" "1" "$RUNTIME_USAGE_RC"
bt_contains "runtime-manifest.mjs は引数不足で usage を出す" "usage: runtime-manifest.mjs" "$(cat "$TMP/runtime-manifest-usage.err")"

# --- 25. audit-summary.mjs の単体 ---
# モック経由では実データに出る形しか通らないので、via の再帰・循環・例外適用の境界を合成入力で固定する。

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

bt_eq "via の文字列要素をたどって high が伝播する" "2" "$(summary_field "$TMP/unit-chain.json" "$EXC_EMPTY" 4)"
bt_eq "伝播した分も blocking に数える" "2" "$(summary_field "$TMP/unit-chain.json" "$EXC_EMPTY" 9)"
bt_eq "例外で葉の advisory が消えると伝播先も消える" "0" "$(summary_field "$TMP/unit-chain.json" "$TMP/exceptions-leaf.json" 4)"
bt_eq "例外で消えた分は例外件数に出る" "1" "$(summary_field "$TMP/unit-chain.json" "$TMP/exceptions-leaf.json" 8)"
bt_eq "総パッケージ数は metadata から取る" "42" "$(summary_field "$TMP/unit-chain.json" "$EXC_EMPTY" 2)"
bt_eq "循環しても止まって high を数える" "2" "$(summary_field "$TMP/unit-cycle.json" "$EXC_EMPTY" 4)"
bt_eq "参照先が報告に無ければ当該パッケージの severity へ倒す" "1" \
    "$(summary_field "$TMP/unit-orphan.json" "$EXC_EMPTY" 5)"
bt_eq "使われなかった例外は件数に載らない" "0" \
    "$(summary_field "$TMP/unit-chain.json" "$TMP/exceptions-unused.json" 8)"
bt_eq "使われなかった例外があっても判定は変わらない" "2" \
    "$(summary_field "$TMP/unit-chain.json" "$TMP/exceptions-unused.json" 4)"

# 一度も一致しなかった例外は excepted-out に「例外未適用」として 1 行残す (#1071 F-11)。
# 判定（件数）は変えない。
UNUSED_EXCEPTED_OUT="$TMP/unused-excepted-out.txt"
node "$SUMMARY_JS" --audit="$TMP/unit-chain.json" --exceptions="$TMP/exceptions-unused.json" \
    --label=テスト --fingerprint=ffff --out="$TMP/unit-summary-unused.json" \
    --excepted-out="$UNUSED_EXCEPTED_OUT" > /dev/null
bt_contains "未適用の例外を要約出力に 1 行残す" \
    "テストの例外未適用: GHSA-zzzz-zzzz-zzzz nothing" "$(cat "$UNUSED_EXCEPTED_OUT")"

# 循環グラフのキー順を逆転しても判定が変わらない (#1071 F-01)。
# 修正前は Object.keys の列挙順に判定が依存し、high 件数が 2 件から 1 件へ減っていた。
bt_eq "循環キー順 a,b で high 2 件になる" "2" "$(summary_field "$TMP/unit-cycle.json" "$EXC_EMPTY" 4)"
bt_eq "循環キー順 b,a でも high 2 件になる（キー順に依存しない）" "2" \
    "$(summary_field "$TMP/unit-cycle-rev.json" "$EXC_EMPTY" 4)"
bt_eq "循環キー順を逆転しても blocking 件数が変わらない" \
    "$(summary_field "$TMP/unit-cycle.json" "$EXC_EMPTY" 9)" "$(summary_field "$TMP/unit-cycle-rev.json" "$EXC_EMPTY" 9)"

# 例外対象の advisory と未解決の文字列参照を併せ持つパッケージ。
# fallback で severity が戻る理由を blocking の advisory 行に残す (#1071 F-02 / F-12)。
bt_eq "例外を適用しても未解決参照の fallback で high が残る" "1" \
    "$(summary_field "$TMP/unit-orphan-mix.json" "$TMP/exceptions-pkg.json" 4)"
bt_eq "例外適用件数は 1 件と出る" "1" \
    "$(summary_field "$TMP/unit-orphan-mix.json" "$TMP/exceptions-pkg.json" 8)"
ORPHAN_MIX_BLOCKING="$TMP/orphan-mix-blocking.txt"
node "$SUMMARY_JS" --audit="$TMP/unit-orphan-mix.json" --exceptions="$TMP/exceptions-pkg.json" \
    --label=テスト --fingerprint=ffff --out="$TMP/unit-summary-orphanmix.json" \
    --blocking-out="$ORPHAN_MIX_BLOCKING" > /dev/null
bt_contains "fallback の理由を blocking の advisory 行に残す" \
    "advisory の参照先 ghost が報告に載っていない" "$(cat "$ORPHAN_MIX_BLOCKING")"

# 同一 advisory id が異なる 2 パッケージへ跨る例外は、重複 throw にならず両方へ独立に
# 適用される (#1071 F-03)。
bt_eq "同一 advisory の 2 パッケージ登録で重複エラーにならず両方消える" "0" \
    "$(summary_field "$TMP/unit-dualpkg.json" "$TMP/exceptions-dualpkg.json" 4)"
bt_eq "両方適用した例外件数は 2 件" "2" \
    "$(summary_field "$TMP/unit-dualpkg.json" "$TMP/exceptions-dualpkg.json" 8)"
# id は一致するが登録 package が違う例外は、単一パッケージのケースと同様に、陳腐化として UNAVAILABLE になる。
# advisory と package の組をキーにしても、通常の不一致検出が働くことを確かめる。
STALE_STDOUT="$TMP/unit-summary-stale.stdout"
node "$SUMMARY_JS" --audit="$TMP/unit-chain.json" --exceptions="$TMP/exceptions-stale-other.json" \
    --label=テスト --fingerprint=ffff --out="$TMP/unit-summary-stale.json" > "$STALE_STDOUT"
bt_eq "登録 package と違う advisory id は UNAVAILABLE" "UNAVAILABLE" "$(sed -n '1p' "$STALE_STDOUT")"
bt_contains "陳腐化の理由に advisory id を含む" "GHSA-aaaa-aaaa-aaaa" "$(cat "$STALE_STDOUT")"

SUMMARY_USAGE_RC=0
node "$SUMMARY_JS" > "$TMP/summary-usage.out" 2> "$TMP/summary-usage.err" || SUMMARY_USAGE_RC=$?
bt_eq "audit-summary.mjs は引数不足で exit 1" "1" "$SUMMARY_USAGE_RC"
bt_contains "audit-summary.mjs は引数不足で usage を出す" "usage: audit-summary.mjs" "$(cat "$TMP/summary-usage.err")"

# --- 26. 両ツリーが同時に blocking のケース ---
# 両方に high がある応答で、2 つの ERROR ブロックが両方出ることを固定する (#1071 F-09)。

echo "{$CANARY_ADV,$LODASH_HIGH,$IMAGE_SIZE_HIGH}" > "$TMP/both-high.json"
start_mock "$TMP/both-high.json" case26
run_audit case26 --dist="$(new_dist case26)" --runtime-dist="$(new_runtime_dist case26)" \
    --plans-dir="$PLANS_PECOTV" --registry="http://127.0.0.1:$MOCK_PORT" --exceptions="$EXC_EMPTY"
bt_eq "両ツリー同時 high で exit 1" "1" "$RC"
bt_contains "配布ツリー側の ERROR ブロックが出る" "配布ツリー: high 以上の脆弱なパッケージ 1 件" "$(cat "$ERR")"
bt_contains "配布ツリー側のパッケージ名を出す" "lodash (high)" "$(cat "$ERR")"
bt_contains "永続層側の ERROR ブロックも出る" "永続層: high 以上の脆弱なパッケージ 1 件" "$(cat "$ERR")"
bt_contains "永続層側のパッケージ名を出す" "image-size (high)" "$(cat "$ERR")"
stop_mock

# --- 27. 永続層の依存解決に失敗（npm install rc≠0）を検知する ---
# npm install だけをスタブにする。1 回目（配布）は成功、2 回目（永続層）は失敗させる (#1071 F-07)。
# npm audit は実 npm だが、監査先は --registry のモックなので実レジストリへは出ない。

CASE27_DIR="$TMP/case27-npm"
mkdir -p "$CASE27_DIR"
CASE27_COUNT="$CASE27_DIR/install-count"
echo 0 > "$CASE27_COUNT"
REAL_NPM="$(command -v npm)"
cat > "$CASE27_DIR/npm" << STUB_EOF
#!/bin/bash
# resolve_tree() の npm install だけを差し替え、ほかは実 npm に委譲する。
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
bt_eq "永続層の依存解決失敗で exit 1" "1" "$CASE27_RC"
bt_contains "永続層で止まったことを理由に出す" \
    "監査未実施のため中止: 永続層: 依存解決に失敗しました" "$(cat "$CASE27_ERR")"
bt_contains "配布ツリー側は install が成功し監査まで進む" "配布ツリーの依存を監査" "$(cat "$CASE27_OUT")"
bt_eq "npm install はちょうど 2 回呼ばれる（配布 成功→永続層 失敗）" "2" "$(cat "$CASE27_COUNT")"
if [ -f "$PECOTV_AUDIT_RECORD" ]; then
    bt_fail "永続層の依存解決失敗で中止したとき監査記録を残さない" "永続層の依存解決失敗で中止したのに監査記録が残っている"
else
    bt_pass "永続層の依存解決失敗で中止したとき監査記録を残さない"
fi
stop_mock

# --- 29. release group の解決結果が空、または空要素を含むなら監査を始めずに止める ---
# 空の group 名は誤判定を招く。grep -qxF "" が空行に一致し、宣言なしの plan を宣言ありと読む。
# release-groups.mjs だけを偽の node で差し替え、ほかの呼び出しは実 node へ exec する。

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
    bt_ne "release group が$case29_label で exit 0 にならない" "0" "$CASE29_RC"
    bt_contains "release group が$case29_label のとき監査未実施として中止する" "監査未実施のため中止: release group" "$(cat "$CASE29_ERR")"
    bt_eq "release group が$case29_label のときレジストリへ問い合わせない" "0" "$(mock_requests)"
    if [ -f "$PECOTV_AUDIT_RECORD" ]; then
        bt_fail "release group が$case29_label で中止したとき監査記録を残さない" "release group が$case29_label で中止したのに監査記録が残っている"
    else
        bt_pass "release group が$case29_label で中止したとき監査記録を残さない"
    fi
    stop_mock
done

# --- 既定の audit-exceptions.json が、例外リストの形を満たす ---
# ほかのケースは一時ファイルの例外を渡すので、実在のファイルの書き損じはここでだけ止まる。
REAL_EXC_RC=0
REAL_EXC_OUT="$(SUMMARY_JS="$SUMMARY_JS" EXC="$RELEASE_DIR/audit-exceptions.json" node --input-type=module -e '
import { pathToFileURL } from "node:url"
const { loadExceptions } = await import(pathToFileURL(process.env.SUMMARY_JS).href)
loadExceptions(process.env.EXC)
' 2>&1)" || REAL_EXC_RC=$?
if [ "$REAL_EXC_RC" -eq 0 ]; then
    bt_pass "既定の audit-exceptions.json を loadExceptions が読める"
else
    bt_fail "既定の audit-exceptions.json を loadExceptions が読める" "exit $REAL_EXC_RC: $REAL_EXC_OUT"
fi

# --- 28. テストはリポジトリ本体の監査記録に触れない ---
# 既定パスの記録が、本テストの fixture 由来の指紋を持たないことだけを見る（記録が無ければ通す）。
REAL_FP="$(real_record_fingerprint)"
if [ -z "$REAL_FP" ]; then
    bt_pass "リポジトリ本体の既定パスの記録が本テスト由来でない"
else
    bt_ne "リポジトリ本体の既定パスの記録が本テスト由来でない" "$FIXTURE_FP" "$REAL_FP"
fi

bt_finish
