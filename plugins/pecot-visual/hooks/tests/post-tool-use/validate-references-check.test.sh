#!/bin/bash
# validate-references-check.sh の単体テスト。「検証していない」と「違反があった」を混同しないことと、
# stdout が空か妥当な JSON であることを確かめる。違反とクラッシュはどちらも exit 1 なので、完走フッターで分ける。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
HOOK="$SCRIPT_DIR/../../lib/post-tool-use/validate-references-check.sh"
MERGE="$SCRIPT_DIR/../../lib/core/merge-hook-outputs.sh"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=mirror-helper.sh
. "$SCRIPT_DIR/mirror-helper.sh"
# 参照 yaml は fixture テーマのもの。参照 dir の一覧は、ミラーの stub CLI（mirror-helper.sh）が返す。
# 初期値は「<talk>/references」だけ。
REF_SRC="$PLUGIN_ROOT/cli/tests/fixtures/themes/with-declaration/references"
# REF_SRC が無いのはリポの異常なので、skip にはせず止める（runner が broken にする）。
[ -d "$REF_SRC" ] || { echo "FAIL: REF_SRC 不在: $REF_SRC"; exit 1; }
VALIDATOR="$PLUGIN_ROOT/assets/slidev/scripts/eslint/validate-references/dist/index.js"

# macOS の mktemp は /private/var の symlink 配下を返すので、物理パスにそろえる。
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(CDPATH= cd -P "$TMP" && pwd -P)

ERRFILE="$TMP/hook-stderr.txt"
# 非 JSON の stdout を出した分岐をここに溜め、最後にまとめて 1 件の assert にする。
BAD_STDOUT=""

# hook を 1 回起動し、stdout を $OUT / stderr を $ERR / 終了コードを $EXIT に入れる。
# $1 = ラベル（ガードレール違反時の表示用）, $2 = 標準入力に渡す JSON, $3 = CLAUDE_PLUGIN_ROOT
run_hook_json() {
    local label="$1" json="$2" root="$3"
    OUT=$(printf '%s' "$json" | CLAUDE_PLUGIN_ROOT="$root" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$root")" bash "$HOOK" 2>"$ERRFILE")
    EXIT=$?
    ERR=$(cat "$ERRFILE")
    if [ -n "$OUT" ] && ! printf '%s\n' "$OUT" | jq empty 2>/dev/null; then
        BAD_STDOUT="${BAD_STDOUT}[$label] "
    fi
}

# $1 = ラベル, $2 = file_path, $3 = CLAUDE_PLUGIN_ROOT
run_hook() {
    run_hook_json "$1" "{\"tool_input\":{\"file_path\":\"$2\"}}" "$3"
}

ctx_of() {
    printf '%s\n' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null
}

# schema 違反 YAML（トップレベルが object でない → `[#/type] must be object`）
BAD_YAML='- title: x
  bogus_key: 1
'

# 正常な talk-dir を作る。validator は参照 dir 全体を見るので、fixture の references 一式を置く。$1 = talk root
make_talk() {
    mkdir -p "$1/pages"
    touch "$1/slides.md"
    cp -r "$REF_SRC" "$1/references"
}

# 偽 plugin root に JS のスタブ validator を置き、そのパスを返す。
# $1 = ディレクトリ名, $2 = exit code, $3 / $4 = stdout / stderr の文字列（空なら無出力）
make_stub_plugin() {
    local name="$1" code="$2" out="$3" err="$4"
    local dist="$TMP/$name/assets/slidev/scripts/eslint/validate-references/dist"
    mkdir -p "$dist"
    {
        [ -n "$out" ] && printf 'console.log(%s);\n' "$(printf '%s' "$out" | jq -Rs .)"
        [ -n "$err" ] && printf 'console.error(%s);\n' "$(printf '%s' "$err" | jq -Rs .)"
        echo "process.exit($code);"
    } > "$dist/index.js"
    printf '%s' "$TMP/$name"
}

HAVE_VALIDATOR=false
NO_VALIDATOR_REASON="$VALIDATOR が無い"
[ -f "$VALIDATOR" ] && HAVE_VALIDATOR=true

# --- ケース1: talk-dir マーカー不在 → stdout 空 / stderr に skip trace ---
NON_TALK="$TMP/non-talk/references"
mkdir -p "$NON_TALK"
echo "description: foo" > "$NON_TALK/00.yaml"
run_hook "marker-absent" "$NON_TALK/00.yaml" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: talk-dir marker"; then
    bt_pass "talk-dir マーカー不在: exit 0 / stdout 空 / stderr skip trace"
else
    bt_fail "talk-dir マーカー不在: exit 0 / stdout 空 / stderr skip trace" "exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース2: yaml でないファイル → stdout 空 / stderr skip ---
run_hook "non-yaml" "$TMP/foo.txt" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: not a yaml file"; then
    bt_pass "yaml 以外: exit 0 / stdout 空 / stderr skip trace"
else
    bt_fail "yaml 以外: exit 0 / stdout 空 / stderr skip trace" "exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース3: file_path 空 → stdout 空 / stderr skip ---
run_hook_json "no-file-path" '{}' "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: tool_input.file_path"; then
    bt_pass "file_path 空: exit 0 / stdout 空 / stderr skip trace"
else
    bt_fail "file_path 空: exit 0 / stdout 空 / stderr skip trace" "exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース4: _template.yaml → 対象外 ---
# validator の SKIP_FILES にあるので、検証しないのが正しい。未実施の通知も出さない。
TALK="$TMP/talk"
mkdir -p "$TALK/references" "$TALK/pages"
touch "$TALK/slides.md"
echo "description: foo" > "$TALK/references/00.yaml"
echo "description: tpl" > "$TALK/references/_template.yaml"
run_hook "skip-files" "$TALK/references/_template.yaml" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: validator SKIP_FILES"; then
    bt_pass "_template.yaml: exit 0 / stdout 空 / stderr skip trace (SKIP_FILES)"
else
    bt_fail "_template.yaml: exit 0 / stdout 空 / stderr skip trace (SKIP_FILES)" \
        "exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース5: plugin root 解決不能 → 対象外（stdout 空 / stderr skip） ---
# 逆算できない配置にする。共有ライブラリは hook の 1 段上の core/ から読むので、$TMP/core に置く。
mkdir -p "$TMP/core"
cp "$SCRIPT_DIR/../../lib/core/hook-paths.sh" "$TMP/core/hook-paths.sh"
DETACHED="$TMP/detached"
mkdir -p "$DETACHED"
cp "$HOOK" "$DETACHED/validate-references-check.sh"
OUT=$(printf '%s' "{\"tool_input\":{\"file_path\":\"$TALK/references/00.yaml\"}}" | \
    env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_HOOKS bash "$DETACHED/validate-references-check.sh" 2>"$ERRFILE")
EXIT=$?
ERR=$(cat "$ERRFILE")
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: plugin root"; then
    bt_pass "plugin root 解決不能: exit 0 / stdout 空 / stderr skip trace"
else
    bt_fail "plugin root 解決不能: exit 0 / stdout 空 / stderr skip trace" \
        "exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース6: 設定不備（plugin root は解決できるが validator dist が無い） ---
# pass と区別できるよう、「未実施」を model に伝える。
run_hook "dist-missing" "$TALK/references/00.yaml" "$TMP/no-such-plugin"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | head -n 1 | grep -q "^warning: references validation not run: "; then
    bt_fail "validator dist 不在: 未実施通知 + assets/slidev パス + bootstrap 案内" "未実施通知が出ていない stdout='$OUT'"
elif ! echo "$CTX" | grep -q "assets: .*/assets/slidev"; then
    bt_fail "validator dist 不在: 未実施通知 + assets/slidev パス + bootstrap 案内" \
        "解決済み assets/slidev のパスが通知に無い ctx='$CTX'"
elif ! echo "$CTX" | grep -q "pecotv"; then
    bt_fail "validator dist 不在: 未実施通知 + assets/slidev パス + bootstrap 案内" \
        "bootstrap 案内 (pecotv コマンド) が通知に無い ctx='$CTX'"
elif echo "$CTX" | grep -q "schema violations"; then
    bt_fail "validator dist 不在: 未実施通知 + assets/slidev パス + bootstrap 案内" "違反として報告している ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[validate-references-check\] not-linted:"; then
    bt_fail "validator dist 不在: 未実施通知 + assets/slidev パス + bootstrap 案内" \
        "stderr trace が not-linted でない stderr='$ERR'"
else
    bt_pass "validator dist 不在: 未実施通知 + assets/slidev パス + bootstrap 案内"
fi

# --- ケース6b: 実行用ミラーが無い（初回の build 中・データ置き場を解決できない） ---
MIRROR_ABSENT=1 run_hook "mirror-absent" "$TALK/references/00.yaml" "$PLUGIN_ROOT"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: references validation not run:"; then
    bt_fail "ミラー不在: 未実施通知 + bootstrap 案内" "未実施通知が出ていない stdout='$OUT'"
elif ! echo "$CTX" | grep -q "pecotv"; then
    bt_fail "ミラー不在: 未実施通知 + bootstrap 案内" "bootstrap 案内 (pecotv コマンド) が通知に無い ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[validate-references-check\] not-linted: runtime mirror is missing"; then
    bt_fail "ミラー不在: 未実施通知 + bootstrap 案内" "stderr trace が not-linted でない stderr='$ERR'"
else
    bt_pass "ミラー不在: 未実施通知 + bootstrap 案内"
fi

# --- ケース7: 真の pass（実 validator + fixture テーマの正常な references 一式） ---
# 「検証して違反ゼロ」を「検証していない」と区別する対照群。
if [ "$HAVE_VALIDATOR" = true ]; then
    REAL="$TMP/real-talk"
    make_talk "$REAL"
    run_hook "true-pass" "$REAL/references/plain.yaml" "$PLUGIN_ROOT"
    if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] pass:"; then
        bt_pass "真の pass: stdout 空 / stderr pass trace"
    else
        bt_fail "真の pass: stdout 空 / stderr pass trace" "exit=$EXIT stdout='$OUT' stderr='$ERR'"
    fi
else
    bt_skip "真の pass: stdout 空 / stderr pass trace" "$NO_VALIDATOR_REASON"
fi

# --- ケース8: 実 assets/slidev で違反検出 ---
if [ "$HAVE_VALIDATOR" = true ]; then
    VIOL="$TMP/violation-talk"
    make_talk "$VIOL"
    printf '%s' "$BAD_YAML" > "$VIOL/references/plain.yaml"
    run_hook "real-violation" "$VIOL/references/plain.yaml" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$OUT$ERR" | grep -q "ERR_MODULE_NOT_FOUND"; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" \
            "ERR_MODULE_NOT_FOUND が出ている stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -q "warning: references schema violations:"; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" "違反見出しが無い stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -q "must be object"; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" \
            "違反内容が additionalContext に含まれない ctx='$CTX'"
    elif ! printf '%s\n' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' > /dev/null 2>&1; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" \
            "hookSpecificOutput.hookEventName が PostToolUse でない stdout='$OUT'"
    elif ! echo "$ERR" | grep -q "\[validate-references-check\] violation:"; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" \
            "stderr trace が violation でない stderr='$ERR'"
    else
        bt_pass "実 assets: 違反検出 + hookEventName 正常 + violation trace"
    fi

    # 件数フッターが本文先頭側（1 行目）にあること。additionalContext の文字数上限と
    # head -n 100 で末尾が落ちても、何件検出されたかは残る必要がある。
    if echo "$CTX" | head -n 1 | grep -qE 'files checked, [0-9]+ error\(s\) found\.$'; then
        bt_pass "違反通知: 件数フッターが本文先頭行にある"
    else
        MSG_DETAIL_1="$(echo "$CTX" | head -n 3)"
        bt_fail "違反通知: 件数フッターが本文先頭行にある" "件数フッターが本文先頭行に無い ctx='$MSG_DETAIL_1'"
    fi

    # 通知の帰属。validator は参照 dir 全体を検証するので、他ファイル
    # 由来の違反を編集ファイルの違反として提示してはならない。
    if echo "$CTX" | grep -q "validation result for the whole references directory"; then
        bt_pass "違反通知: ディレクトリ全体の結果であることを明示している"
    else
        bt_fail "違反通知: ディレクトリ全体の結果であることを明示している" "帰属の但し書きが無い ctx='$CTX'"
    fi

    # category 欠落以外の違反に category 導線を混ぜない（BAD_YAML は type 違反のみ）。
    if echo "$CTX" | grep -q "layout_categories"; then
        bt_fail "違反通知: category 欠落でなければ category 導線を出さない" "category 欠落でないのに category 導線が付いている ctx='$CTX'"
    else
        bt_pass "違反通知: category 欠落でなければ category 導線を出さない"
    fi

    # --- ケース8b: category 欠落の復旧導線 ---
    # required 違反は何を書けばよいかを示さないので、語彙の元データと張り直しの手段を添える。
    NOCAT="$TMP/no-category-talk"
    make_talk "$NOCAT"
    grep -v '^category:' "$REF_SRC/plain.yaml" > "$NOCAT/references/plain.yaml"
    run_hook "no-category" "$NOCAT/references/plain.yaml" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if ! echo "$CTX" | grep -q "warning: references schema violations:"; then
        bt_fail "category 欠落: 違反検出 + category 導線" "違反見出しが無い stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -qF "required property 'category'"; then
        bt_fail "category 欠落: 違反検出 + category 導線" "validator の違反行が通知に無い ctx='$CTX'"
    elif ! echo "$CTX" | grep -q "layout_categories"; then
        bt_fail "category 欠落: 違反検出 + category 導線" "語彙の元データへの導線が無い ctx='$CTX'"
    elif ! echo "$CTX" | grep -q "relinking node_modules with slide_sync (node_modules_only: true)"; then
        bt_fail "category 欠落: 違反検出 + category 導線" "node_modules を張り直す導線が無い ctx='$CTX'"
    elif echo "$CTX" | grep -q "テンプレートを同期"; then
        bt_fail "category 欠落: 違反検出 + category 導線" "旧文言（テンプレートを同期）が残っている ctx='$CTX'"
    elif ! echo "$ERR" | grep -q "\[validate-references-check\] violation:"; then
        bt_fail "category 欠落: 違反検出 + category 導線" "stderr trace が violation でない stderr='$ERR'"
    else
        bt_pass "category 欠落: 違反検出 + category 導線"
    fi
else
    bt_skip "実 assets: 違反検出 + hookEventName 正常 + violation trace" "$NO_VALIDATOR_REASON"
    bt_skip "違反通知: 件数フッターが本文先頭行にある" "$NO_VALIDATOR_REASON"
    bt_skip "違反通知: ディレクトリ全体の結果であることを明示している" "$NO_VALIDATOR_REASON"
    bt_skip "違反通知: category 欠落でなければ category 導線を出さない" "$NO_VALIDATOR_REASON"
    bt_skip "category 欠落: 違反検出 + category 導線" "$NO_VALIDATOR_REASON"
fi

# --- ケース9: 無音 no-op 検知（exit 0 だが検証されていない） ---
# main() が動かない退行などで、validator が exit 0 のまま無音になる場合を未実施にする。
expect_not_linted_at() {
    local label="$1" target="$2" root="$3" expect="$4" ctx
    run_hook "$label" "$target" "$root"
    ctx=$(ctx_of "$OUT")
    if echo "$ctx" | grep -q "schema violations"; then
        bt_fail "$label: 未実施へ振り分け（違反と報告しない）" "違反として報告している ctx='$ctx'"
    elif ! echo "$ctx" | grep -q "warning: references validation not run:"; then
        bt_fail "$label: 未実施へ振り分け（違反と報告しない）" "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
    elif ! echo "$ctx" | grep -q "$expect"; then
        bt_fail "$label: 未実施へ振り分け（違反と報告しない）" "期待する理由 ('$expect') が通知に無い ctx='$ctx'"
    elif ! echo "$ERR" | grep -q "\[validate-references-check\] not-linted:"; then
        bt_fail "$label: 未実施へ振り分け（違反と報告しない）" "stderr trace が not-linted でない stderr='$ERR'"
    else
        bt_pass "$label: 未実施へ振り分け（違反と報告しない）"
    fi
}

expect_not_linted() {
    expect_not_linted_at "$1" "$TALK/references/00.yaml" "$2" "$3"
}

# このスタブのケースは、validator の main が実行されず無音で exit 0 になる退行の未実施判定を、唯一守っている。
# 実 validator では、もう再現できない。消すと、この退行を検知できなくなる。
STUB_SILENT=$(make_stub_plugin stub-exit0-silent 0 "" "")
expect_not_linted "exit 0 かつ完全無音 (main 未実行相当)" "$STUB_SILENT" "printed no completion footer"

# 実 validator を symlink を含む CLAUDE_PLUGIN_ROOT で起動する。validator の自己実行判定が
# argv[1] を realpath に揃えているため、symlink 経由でも完走して pass に振り分けられる。
if [ "$HAVE_VALIDATOR" = true ]; then
    LINK_PLUGIN="$TMP/link-plugin"
    ln -s "$PLUGIN_ROOT" "$LINK_PLUGIN"
    run_hook "symlink-real-validator" "$REAL/references/plain.yaml" "$LINK_PLUGIN"
    if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] pass:"; then
        bt_pass "実 validator を symlink 経由起動: 完走して pass（stdout 空 / stderr pass trace）"
    else
        bt_fail "実 validator を symlink 経由起動: 完走して pass（stdout 空 / stderr pass trace）" \
            "exit=$EXIT stdout='$OUT' stderr='$ERR'"
    fi
else
    bt_skip "実 validator を symlink 経由起動: 完走して pass（stdout 空 / stderr pass trace）" "$NO_VALIDATOR_REASON"
fi

# hook のトリガ条件と validator の対象集合の不一致。どちらも validator は完走する
# （フッターあり・exit 0）が、編集ファイル自身は 1 度も読まれていない。
if [ "$HAVE_VALIDATOR" = true ]; then
    printf '%s' "$BAD_YAML" > "$REAL/references/ignored.yml"
    expect_not_linted_at ".yml 編集 (validator は *.yaml しか読まない)" \
        "$REAL/references/ignored.yml" "$PLUGIN_ROOT" "is not among the validated files"

    # ネスト配下は参照 dir そのものではないので、検証の対象にしない（readdirSync は非再帰）。
    mkdir -p "$REAL/references/sub"
    printf '%s' "$BAD_YAML" > "$REAL/references/sub/nested.yaml"
    run_hook "nested-yaml" "$REAL/references/sub/nested.yaml" "$PLUGIN_ROOT"
    if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: not a yaml in a theme references dir"; then
        bt_pass "ネスト配下の yaml: 参照 dir そのものでないので skip"
    else
        bt_fail "ネスト配下の yaml: 参照 dir そのものでないので skip" "skip していない stdout='$OUT' stderr='$ERR'"
    fi
else
    bt_skip ".yml 編集 (validator は *.yaml しか読まない): 未実施へ振り分け（違反と報告しない）" "$NO_VALIDATOR_REASON"
    bt_skip "ネスト配下の yaml: 参照 dir そのものでないので skip" "$NO_VALIDATOR_REASON"
fi

# --- ケース10: 非 0 で完走していない分岐 → 未実施（違反と報告しない） ---
# #861。違反とクラッシュはどちらも exit 1 なので、exit code だけでは分けられない。
STUB_TIMEOUT=$(make_stub_plugin stub-exit124 124 "" "")
expect_not_linted "exit 124 (timeout)" "$STUB_TIMEOUT" "timed out"

STUB_EXIT1_EMPTY=$(make_stub_plugin stub-exit1-empty 1 "" "")
expect_not_linted "exit 1 かつ出力空 (cd 失敗相当)" "$STUB_EXIT1_EMPTY" "exited abnormally without output"

STUB_CRASH=$(make_stub_plugin stub-exit1-crash 1 "Validating: /somewhere/pages/_references" \
    "node:internal/modules/esm/resolve:275
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml'")
expect_not_linted "exit 1 + スタックトレースのみ (フッター無し = クラッシュ)" "$STUB_CRASH" "crashed"

# 実行異常時は原因追跡のため validator 出力の先頭を通知に添える
run_hook "crash-output-head" "$TALK/references/00.yaml" "$STUB_CRASH"
if ctx_of "$OUT" | grep -q "ERR_MODULE_NOT_FOUND"; then
    bt_pass "クラッシュ: validator 出力の先頭を通知に添えている"
else
    bt_fail "クラッシュ: validator 出力の先頭を通知に添えている" "validator 出力が通知に含まれない stdout='$OUT'"
fi

STUB_EXIT2=$(make_stub_plugin stub-exit2 2 "" "some fatal error")
expect_not_linted "exit 2 (その他の異常終了)" "$STUB_EXIT2" "exit 2"

# フッターがあっても exit 1 以外は完走とみなさない（違反判定は exit 1 に限る）。
STUB_EXIT3_FOOTER=$(make_stub_plugin stub-exit3-footer 3 \
    "Validating: /somewhere

  ✗ 00.yaml
    [#/type] must be object

1 files checked, 1 error(s) found." "")
expect_not_linted "exit 3 + フッターあり" "$STUB_EXIT3_FOOTER" "exit 3"

# --- ケース11: 大出力（validator 側 process.exitCode 化の退行検知を含む） ---
if [ "$HAVE_VALIDATOR" = true ]; then
    BIG="$TMP/big-talk"
    mkdir -p "$BIG/references" "$BIG/pages"
    touch "$BIG/slides.md"
    # 300 文字のキー名 × 60 件 × 12 ファイル。ajv のエラーメッセージにはキー名を含む
    # instancePath が載るので、1 件あたり数百文字・全体で数百 KB の出力になる。
    LONG_KEY=$(printf 'k%.0s' $(seq 1 300))
    PROPS=""
    for j in $(seq 1 60); do
        PROPS="${PROPS}  ${LONG_KEY}${j}: {}
"
    done
    for i in $(seq 1 12); do
        {
            printf 'layout: big%02d\ndescription: d\nincludes:\n  - x\n' "$i"
            printf 'text_constraints: {}\nclicks: {}\nbest_practices: []\n'
            printf 'anti_patterns: []\nexamples: []\nprops:\n'
            printf '%s' "$PROPS"
        } > "$BIG/references/big$(printf '%02d' "$i").yaml"
    done

    # 実 validator を遅い読み手で直に起動する。process.exit() に戻ると pipe に残った出力とフッターが消える。
    BIG_OUT=$( (CDPATH= cd -P "$BIG" && timeout 60 node "$VALIDATOR" --dir references 2>/dev/null) \
        | { sleep 1; cat; } )
    if [ "${#BIG_OUT}" -lt 100000 ]; then
        bt_fail "大出力ピン留め: 遅い読み手でも全量と完走フッターが残る" \
            "遅い読み手で出力が切り捨てられた (${#BIG_OUT} bytes)。validate-references/index.ts が process.exit() に戻っていないか確認すること"
    elif ! echo "$BIG_OUT" | grep -qE '^[0-9]+ files checked, [0-9]+ error\(s\) found\.$'; then
        bt_fail "大出力ピン留め: 遅い読み手でも全量と完走フッターが残る" \
            "遅い読み手で完走フッターが失われた (${#BIG_OUT} bytes)。validate-references/index.ts が process.exit() に戻っていないか確認すること"
    else
        bt_pass "大出力ピン留め: 遅い読み手でも全量と完走フッターが残る"
    fi

    run_hook "big-output" "$BIG/references/big01.yaml" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "warning: references validation not run:"; then
        MSG_DETAIL_2="$(echo "$CTX" | head -n 3)"
        bt_fail "大出力: hook 経由で違反として報告され件数フッターが先頭行に残る" "違反が未実施に化けている ctx='$MSG_DETAIL_2'"
    elif ! echo "$CTX" | head -n 1 | grep -qE '^warning: references schema violations: 12 files checked, [0-9]+ error\(s\) found\.$'; then
        MSG_DETAIL_3="$(echo "$CTX" | head -n 1)"
        bt_fail "大出力: hook 経由で違反として報告され件数フッターが先頭行に残る" "件数フッターが先頭行に無い head='$MSG_DETAIL_3'"
    else
        bt_pass "大出力: hook 経由で違反として報告され件数フッターが先頭行に残る"
    fi

    # 通知本文が 3000 バイトで頭打ちになり、最後の行が残りの違反数を示すこと。
    BIG_SHOWN=$(echo "$CTX" | grep -cE '^ +\[')
    BIG_REST=$(echo "$CTX" | tail -n 1 | sed -nE 's/^ *Truncated at 3000 bytes: ([0-9]+) more violations not shown\.$/\1/p')
    BIG_TOTAL=$(echo "$BIG_OUT" | grep -cE '^    \[')
    if [ "$(printf '%s' "$CTX" | wc -c)" -le 3600 ] && [ -n "$BIG_REST" ] && [ $((BIG_SHOWN + BIG_REST)) -eq "$BIG_TOTAL" ]; then
        bt_pass "大出力: 3000 バイトで頭打ちになり、末尾の行の N が残りの違反数と合う"
    else
        BIG_LAST=$(echo "$CTX" | tail -n 1)
        bt_fail "大出力: 3000 バイトで頭打ちになり、末尾の行の N が残りの違反数と合う" \
            "切り詰めが合わない shown=$BIG_SHOWN rest='$BIG_REST' total=$BIG_TOTAL last='$BIG_LAST'"
    fi
else
    bt_skip "大出力ピン留め: 遅い読み手でも全量と完走フッターが残る" "$NO_VALIDATOR_REASON"
    bt_skip "大出力: hook 経由で違反として報告され件数フッターが先頭行に残る" "$NO_VALIDATOR_REASON"
    bt_skip "大出力: 3000 バイトで頭打ちになり、末尾の行の N が残りの違反数と合う" "$NO_VALIDATOR_REASON"
fi

# --- ケース12: symlink トポロジでも talk-dir マーカーを見失わない ---
# A は references/ 自体、B は祖先 dir（#836）が symlink。どちらもマーカーを見失わずに違反を報告する。
if [ "$HAVE_VALIDATOR" = true ]; then
    expect_detected() {
        local label="$1" target="$2"
        run_hook "topo-$label" "$target" "$PLUGIN_ROOT"
        if ctx_of "$OUT" | grep -q "warning: references schema violations:"; then
            bt_pass "トポロジ $label: schema violations"
        else
            bt_fail "トポロジ $label: schema violations" "schema 違反が報告されない stdout='$OUT' stderr='$ERR'"
        fi
    }

    TOPO="$TMP/topo"
    mkdir -p "$TOPO/A/talk/pages" "$TOPO/A/elsewhere"
    touch "$TOPO/A/talk/slides.md"
    cp -r "$REF_SRC" "$TOPO/A/elsewhere/references"
    printf '%s' "$BAD_YAML" > "$TOPO/A/elsewhere/references/plain.yaml"
    ln -s "$TOPO/A/elsewhere/references" "$TOPO/A/talk/references"
    expect_detected "A (references 自体が symlink)" "$TOPO/A/talk/references/plain.yaml"

    mkdir -p "$TOPO/B/real/talk/pages"
    touch "$TOPO/B/real/talk/slides.md"
    cp -r "$REF_SRC" "$TOPO/B/real/talk/references"
    printf '%s' "$BAD_YAML" > "$TOPO/B/real/talk/references/plain.yaml"
    ln -s "$TOPO/B/real" "$TOPO/B/link"
    expect_detected "B (祖先 dir が symlink)" "$TOPO/B/link/talk/references/plain.yaml"
else
    bt_skip "トポロジ A (references 自体が symlink): schema violations" "$NO_VALIDATOR_REASON"
    bt_skip "トポロジ B (祖先 dir が symlink): schema violations" "$NO_VALIDATOR_REASON"
fi

# --- ケース13: merge-hook-outputs.sh 経由 ---
# merge は非 JSON の stdout を additionalContext に丸める。skip のとき stdout が空であること。
MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$NON_TALK/00.yaml\"}}"
MERGE_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$PLUGIN_ROOT")" bash "$MERGE" "$HOOK" 2>"$ERRFILE")
MERGE_ERR=$(cat "$ERRFILE")
if [ -n "$MERGE_OUT" ]; then
    bt_fail "merge 経由 (skip 分岐): stdout が空 / stderr に trace がそのまま出る" \
        "stdout が空でない（trace が additionalContext に丸められた疑い）stdout='$MERGE_OUT'"
elif ! echo "$MERGE_ERR" | grep -q "\[validate-references-check\] skip:"; then
    bt_fail "merge 経由 (skip 分岐): stdout が空 / stderr に trace がそのまま出る" \
        "stderr に trace がそのまま出ていない stderr='$MERGE_ERR'"
else
    bt_pass "merge 経由 (skip 分岐): stdout が空 / stderr に trace がそのまま出る"
fi

# 未実施通知は merge を通っても additionalContext として model に届くこと
MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$TALK/references/00.yaml\"}}"
MERGE_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$STUB_CRASH" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$STUB_CRASH")" bash "$MERGE" "$HOOK" 2>"$ERRFILE")
MERGE_CTX=$(ctx_of "$MERGE_OUT")
if ! printf '%s\n' "$MERGE_OUT" | jq empty 2>/dev/null; then
    bt_fail "merge 経由 (未実施分岐): additionalContext + hookEventName 正常" \
        "stdout が妥当な JSON でない stdout='$MERGE_OUT'"
elif ! echo "$MERGE_CTX" | grep -q "warning: references validation not run:"; then
    bt_fail "merge 経由 (未実施分岐): additionalContext + hookEventName 正常" \
        "additionalContext に未実施通知が無い stdout='$MERGE_OUT'"
elif ! printf '%s\n' "$MERGE_OUT" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' > /dev/null 2>&1; then
    bt_fail "merge 経由 (未実施分岐): additionalContext + hookEventName 正常" \
        "hookEventName が PostToolUse でない stdout='$MERGE_OUT'"
else
    bt_pass "merge 経由 (未実施分岐): additionalContext + hookEventName 正常"
fi

# --- ケース14: ピン留め — 実 validator の exit code と完走フッターの対応 ---
# hook はフッターの有無だけで完走を判定する。頼る文言と exit code を、実 dist を直に起動して固定する。
if [ "$HAVE_VALIDATOR" = true ]; then
    PIN_ERR="$TMP/pin-stderr.txt"
    FOOTER_RE='^[0-9]+ files checked, [0-9]+ error\(s\) found\.$'

    PIN_OUT=$(timeout 30 node "$VALIDATOR" --dir "$REAL/references" 2>"$PIN_ERR")
    PIN_EXIT=$?
    # $REAL には .yml とネスト yaml を足してあるが、どちらも validator の対象外なので
    # 検証結果は fixture テーマの一式そのまま（違反ゼロ）になる。
    if [ $PIN_EXIT -ne 0 ]; then
        MSG_DETAIL_5="$(echo "$PIN_OUT" | tail -n 3)"
        bt_fail "ピン留め: pass = exit 0 + 完走フッター + stderr 空" \
            "正常な references が exit 0 でない (exit=$PIN_EXIT) out='$MSG_DETAIL_5'"
    elif ! echo "$PIN_OUT" | grep -qE "$FOOTER_RE"; then
        MSG_DETAIL_6="$(echo "$PIN_OUT" | tail -n 3)"
        bt_fail "ピン留め: pass = exit 0 + 完走フッター + stderr 空" \
            "pass 時に完走フッターが出ない（validator 側の文言変更の可能性。hook のフッター判定を更新すること）out='$MSG_DETAIL_6'"
    elif [ -s "$PIN_ERR" ]; then
        MSG_DETAIL_7="$(cat "$PIN_ERR")"
        bt_fail "ピン留め: pass = exit 0 + 完走フッター + stderr 空" "正常系で stderr が空でない stderr='$MSG_DETAIL_7'"
    else
        bt_pass "ピン留め: pass = exit 0 + 完走フッター + stderr 空"
    fi

    PIN_OUT=$(timeout 30 node "$VALIDATOR" --dir "$VIOL/references" 2>"$PIN_ERR")
    PIN_EXIT=$?
    if [ $PIN_EXIT -ne 1 ]; then
        bt_fail "ピン留め: 違反 = exit 1 + 完走フッター" "違反時の exit code が 1 でない (exit=$PIN_EXIT)"
    elif ! echo "$PIN_OUT" | grep -qE "$FOOTER_RE"; then
        MSG_DETAIL_8="$(echo "$PIN_OUT" | tail -n 3)"
        bt_fail "ピン留め: 違反 = exit 1 + 完走フッター" "違反時に完走フッターが出ない out='$MSG_DETAIL_8'"
    else
        bt_pass "ピン留め: 違反 = exit 1 + 完走フッター"
    fi

    # 検証対象の dir が無いと、違反と同じ exit 1 でもフッターが出ない。フッターだけが判別の軸になる。
    PIN_OUT=$(timeout 30 node "$VALIDATOR" --dir "$TMP/no-such-references" 2>"$PIN_ERR")
    PIN_EXIT=$?
    if [ $PIN_EXIT -ne 1 ]; then
        bt_fail "ピン留め: ENOENT = exit 1 + フッター無し（exit code だけでは違反と判別不能）" \
            "ENOENT 時の exit code が 1 でない (exit=$PIN_EXIT)"
    elif echo "$PIN_OUT" | grep -qE "$FOOTER_RE"; then
        bt_fail "ピン留め: ENOENT = exit 1 + フッター無し（exit code だけでは違反と判別不能）" \
            "ENOENT なのに完走フッターが出ている out='$PIN_OUT'"
    elif ! echo "$PIN_OUT" | grep -q "^Validating:"; then
        bt_fail "ピン留め: ENOENT = exit 1 + フッター無し（exit code だけでは違反と判別不能）" \
            "ENOENT 時の stdout が 'Validating:' で始まらない out='$PIN_OUT'"
    elif ! grep -q "ENOENT" "$PIN_ERR"; then
        MSG_DETAIL_9="$(head -n 3 "$PIN_ERR")"
        bt_fail "ピン留め: ENOENT = exit 1 + フッター無し（exit code だけでは違反と判別不能）" \
            "ENOENT のスタックトレースが stderr に出ていない stderr='$MSG_DETAIL_9'"
    else
        bt_pass "ピン留め: ENOENT = exit 1 + フッター無し（exit code だけでは違反と判別不能）"
    fi
else
    bt_skip "ピン留め: pass = exit 0 + 完走フッター + stderr 空" "$NO_VALIDATOR_REASON"
    bt_skip "ピン留め: 違反 = exit 1 + 完走フッター" "$NO_VALIDATOR_REASON"
    bt_skip "ピン留め: ENOENT = exit 1 + フッター無し（exit code だけでは違反と判別不能）" "$NO_VALIDATOR_REASON"
fi

# --- ケース15: テーマの宣言（slide theme）の結果で対象を決める ---
# 15a: talk-dir 内でも、参照 dir でない yaml は検証しない（skip）。
if [ "$HAVE_VALIDATOR" = true ]; then
    mkdir -p "$REAL/public"
    printf '%s' "$BAD_YAML" > "$REAL/public/other.yaml"
    run_hook "not-reference-dir" "$REAL/public/other.yaml" "$PLUGIN_ROOT"
    if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: yaml outside a references-like dir"; then
        bt_pass "参照 dir でない yaml: 検証せず skip"
    else
        bt_fail "参照 dir でない yaml: 検証せず skip" "skip していない stdout='$OUT' stderr='$ERR'"
    fi

    # 15b: referencesDirectories の 2 つ目（テーマ側）の dir の yaml は、その dir を検証する。
    THEME_SIDE="$TMP/theme-side"
    mkdir -p "$THEME_SIDE/pages"
    touch "$THEME_SIDE/slides.md"
    mkdir -p "$THEME_SIDE/theme-refs"
    cp "$REF_SRC"/*.yaml "$THEME_SIDE/theme-refs/"
    printf '%s' "$BAD_YAML" > "$THEME_SIDE/theme-refs/plain.yaml"
    STUB_THEME_REFERENCES="$THEME_SIDE/references,$THEME_SIDE/theme-refs" \
        run_hook "second-reference-dir" "$THEME_SIDE/theme-refs/plain.yaml" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "warning: references schema violations:" && echo "$CTX" | grep -q "must be object"; then
        bt_pass "2 つ目の参照 dir: その dir の yaml を検証して違反を検出"
    else
        bt_fail "2 つ目の参照 dir: その dir の yaml を検証して違反を検出" "違反が報告されない stdout='$OUT' stderr='$ERR'"
    fi

    # 15c: 検証するのは編集ファイルの dir だけ。もう一方の参照 dir の違反は混ぜない。
    mkdir -p "$THEME_SIDE/references"
    printf '%s' "$BAD_YAML" > "$THEME_SIDE/references/bad-in-talk.yaml"
    cp "$REF_SRC/plain.yaml" "$THEME_SIDE/theme-refs/plain.yaml"
    STUB_THEME_REFERENCES="$THEME_SIDE/references,$THEME_SIDE/theme-refs" \
        run_hook "only-edited-dir" "$THEME_SIDE/theme-refs/plain.yaml" "$PLUGIN_ROOT"
    if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] pass:"; then
        bt_pass "編集ファイルの dir だけを検証: 別の参照 dir の違反は報告に入らない"
    else
        bt_fail "編集ファイルの dir だけを検証: 別の参照 dir の違反は報告に入らない" "別 dir の違反が混入した stdout='$OUT' stderr='$ERR'"
    fi
else
    bt_skip "参照 dir でない yaml: 検証せず skip" "$NO_VALIDATOR_REASON"
    bt_skip "2 つ目の参照 dir: その dir の yaml を検証して違反を検出" "$NO_VALIDATOR_REASON"
    bt_skip "編集ファイルの dir だけを検証: 別の参照 dir の違反は報告に入らない" "$NO_VALIDATOR_REASON"
fi

# 15a2: 参照 dir らしくない場所の yaml は、slide theme を起こさず、テーマ未リンクでも通知しない。
THEME_LOG="$TMP/theme-spawn.log"
rm -f "$THEME_LOG"
mkdir -p "$TALK/public"
echo "description: other" > "$TALK/public/other.yaml"
STUB_THEME_LOG="$THEME_LOG" STUB_THEME_FAIL=theme-unlinked run_hook "non-reference-no-theme" "$TALK/public/other.yaml" "$PLUGIN_ROOT"
if [ -z "$OUT" ] && [ ! -e "$THEME_LOG" ] && echo "$ERR" | grep -q "skip: yaml outside a references-like dir"; then
    bt_pass "参照 dir らしくない yaml: slide theme を起こさず、通知しない"
else
    bt_fail "参照 dir らしくない yaml: slide theme を起こさず、通知しない" "slide theme を起こした/通知した stdout='$OUT' stderr='$ERR'"
fi

# 15d: テーマを引けない talk-dir は検証せず、未実施として原因別に案内する。
STUB_NOCALL=$(make_stub_plugin stub-nocall 0 "SHOULD-NOT-RUN" "")
STUB_THEME_FAIL=theme-unlinked run_hook "theme-unlinked" "$TALK/references/00.yaml" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: references validation not run:"; then
    bt_fail "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（validator は起動しない）" \
        "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
elif ! echo "$CTX" | grep -q "Relinking node_modules with slide_sync (node_modules_only: true)"; then
    bt_fail "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（validator は起動しない）" \
        "node_modules を張り直す案内が無い ctx='$CTX'"
elif echo "$CTX" | grep -q "SHOULD-NOT-RUN"; then
    bt_fail "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（validator は起動しない）" \
        "validator を起動している ctx='$CTX'"
else
    bt_pass "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（validator は起動しない）"
fi

STUB_THEME_FAIL=theme-none run_hook "theme-none" "$TALK/references/00.yaml" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: references validation not run:" && echo "$CTX" | grep -q "theme-none"; then
    bt_pass "theme-none: 未実施 + reason を通知"
else
    bt_fail "theme-none: 未実施 + reason を通知" "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

STUB_THEME_FAIL=crash run_hook "theme-crash" "$TALK/references/00.yaml" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: references validation not run:" && echo "$CTX" | grep -q "slide theme exited with 3"; then
    bt_pass "slide theme の異常終了: 未実施 + exit code を通知"
else
    bt_fail "slide theme の異常終了: 未実施 + exit code を通知" "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

# 15d2: slide theme が JSON を出せずに終了したとき、stderr の先頭 1 行を通知と trace に添える。
STUB_THEME_FAIL=crash STUB_THEME_STDERR="Node.js 24.22.1 以上が要ります" run_hook "theme-crash-stderr" "$TALK/references/00.yaml" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "stderr: Node.js 24.22.1 以上が要ります" && echo "$ERR" | grep -q "stderr: Node.js 24.22.1 以上が要ります"; then
    bt_pass "slide theme の stderr: 先頭 1 行を通知と trace に添える"
else
    bt_fail "slide theme の stderr: 先頭 1 行を通知と trace に添える" "通知か trace に無い ctx='$CTX' stderr='$ERR'"
fi

# 15e: マーカーは slides.md + pages/。start.mjs だけの dir は talk-dir とみなさない。
OLD_MARKER="$TMP/old-marker"
mkdir -p "$OLD_MARKER/pages" "$OLD_MARKER/references"
touch "$OLD_MARKER/start.mjs"
echo "description: foo" > "$OLD_MARKER/references/a.yaml"
run_hook "old-marker" "$OLD_MARKER/references/a.yaml" "$PLUGIN_ROOT"
if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: talk-dir marker (slides.md + pages/)"; then
    bt_pass "start.mjs だけの dir: talk-dir とみなさず skip"
else
    bt_fail "start.mjs だけの dir: talk-dir とみなさず skip" "skip していない stdout='$OUT' stderr='$ERR'"
fi

# --- ケース16: 実 CLI（cli/dist）を通す ---
# ここだけ build 済みの cli/dist で slide theme を起こす。cli/dist が無いか古いときは skip する。
REAL_CLI_DIST="${PECOTV_TEST_CLI_DIST:-$PLUGIN_ROOT/cli/dist}"
if [ "$HAVE_VALIDATOR" = true ] && [ -f "$REAL_CLI_DIST/commands/slidev-project/theme.js" ]; then
    REAL_CLI_TALK="$TMP/real-cli-talk"
    FIXTURE_THEME="$PLUGIN_ROOT/cli/tests/fixtures/themes/with-declaration"
    mkdir -p "$REAL_CLI_TALK/pages" "$REAL_CLI_TALK/node_modules" "$REAL_CLI_TALK/references"
    ln -s "$FIXTURE_THEME" "$REAL_CLI_TALK/node_modules/slidev-theme-pecotv-test-declared"
    printf '%s\n' '---' 'theme: slidev-theme-pecotv-test-declared' '---' > "$REAL_CLI_TALK/slides.md"
    printf '{"name":"real-cli-talk","dependencies":{"slidev-theme-pecotv-test-declared":"file:%s"}}\n' "$FIXTURE_THEME" > "$REAL_CLI_TALK/package.json"
    printf '%s' "$BAD_YAML" > "$REAL_CLI_TALK/references/bad.yaml"
    MIRROR_REAL_CLI_DIST="$REAL_CLI_DIST" run_hook "real-cli" "$REAL_CLI_TALK/references/bad.yaml" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "warning: references schema violations:" && echo "$CTX" | grep -q "must be object"; then
        bt_pass "実 CLI: talk-dir の references/ の不正な yaml を検証して違反を検出"
    else
        bt_fail "実 CLI: talk-dir の references/ の不正な yaml を検証して違反を検出" "違反が報告されない stdout='$OUT' stderr='$ERR'"
    fi
else
    bt_skip "実 CLI: talk-dir の references/ の不正な yaml を検証して違反を検出" \
        "cli/dist に slide theme が無い（build 前か古い build）か、validator が無い"
fi

# --- ガードレール: 全分岐で stdout が「空または妥当な JSON」 ---
if [ -z "$BAD_STDOUT" ]; then
    bt_pass "ガードレール: 全分岐の stdout が空または妥当な JSON"
else
    bt_fail "ガードレール: 全分岐の stdout が空または妥当な JSON" "stdout が非 JSON の分岐がある: $BAD_STDOUT"
fi

bt_finish
