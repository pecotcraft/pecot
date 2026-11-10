#!/bin/bash
# validate-references-check.sh の単体テスト。
#
# 検証の軸は 2 つ。
#
# 1. 分岐の分類: 「検証していない」と「違反があった」を混同しないこと。
#    対象外 (skip) / 設定不備・未実施 (not-linted) / pass / 違反検出 (violation) を、それぞれ固定する。
#    validator は、違反の場合とクラッシュの場合で、同じ exit 1 を返す。
#    そのため、判別は完走フッター (`N files checked, N error(s) found.`) の有無が担う。
#    本テストの主目的は、次の 2 つを「違反」や「pass」として扱わないこと。
#    1 つ目は、フッターの無い非 0。
#    2 つ目は、フッターがあっても編集ファイルが検証対象に入っていない exit 0。
# 2. 出力チャネル: model 向け通知は stdout の JSON、開発者診断 trace は stderr。
#    stdout は全分岐で「空または妥当な JSON」であること。
#    呼び出し元 merge-hook-outputs.sh が、非 JSON stdout を additionalContext に丸めるためだ。
#
# 全ケースで stdout と stderr を分離して捕捉する。
# 2>&1 で混ぜると、trace 1 行が JSON パースを壊す。
# その場合、上記 2 のチェック自体が成立しない。
#
# 併せて、既存の退行ガードを維持する。
# - symlink トポロジ A/B で talk-dir マーカーを見失わないこと
# - 実 assets/slidev 起動で ERR_MODULE_NOT_FOUND が出ないこと
# - 大量違反を pipe 越しに流してもフッターが残ること（validator 側 process.exitCode 化）

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../../lib/post-tool-use/validate-references-check.sh"
MERGE="$SCRIPT_DIR/../../lib/core/merge-hook-outputs.sh"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=mirror-helper.sh
. "$SCRIPT_DIR/mirror-helper.sh"
# 参照 yaml は fixture テーマのもの。参照 dir の一覧は、ミラーの stub CLI（mirror-helper.sh）が返す。
# 初期値は「<talk>/references」だけ。
REF_SRC="$PLUGIN_ROOT/cli/tests/fixtures/themes/with-declaration/references"
# REF_SRC 自体の不在は、リポジトリ内では常に異常（移動し損ねた状態）。
# 依存の不在（bootstrap 前）と違い、SKIP にすると全ケースが通知なしで空振りする。
# そのため FAIL にする。
[ -d "$REF_SRC" ] || { echo "FAIL: REF_SRC 不在: $REF_SRC"; exit 1; }
VALIDATOR="$PLUGIN_ROOT/assets/slidev/scripts/eslint/validate-references/dist/index.js"

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

# mktemp の返り値を物理正規化する。macOS の mktemp は /var → /private/var の symlink
# 配下を返すため、正規化しないとトポロジケースの「物理 dir が talk-dir 内」という
# 前提が崩れる。
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

# 正常な talk-dir を作る。validator は参照 dir 全体を検証するため、
# 「pass」の対照群には fixture テーマの実 references 一式が要る。
# $1 = talk root にするパス
make_talk() {
    mkdir -p "$1/pages"
    touch "$1/slides.md"
    cp -r "$REF_SRC" "$1/references"
}

# 偽 plugin root にスタブ validator を置き、そのパスを返す。実 validator に依存せず
# exit code と出力の組み合わせを再現する（timeout を実 sleep で作らない）。
# hook は `node <dist>/index.js` で起動するので、スタブは shell ではなく JS で書く。
# $1 = ディレクトリ名, $2 = exit code, $3 = stdout に出す文字列（空なら無出力）,
# $4 = stderr に出す文字列（空なら無出力）
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
[ -f "$VALIDATOR" ] && HAVE_VALIDATOR=true

# --- ケース1: talk-dir マーカー不在 → stdout 空 / stderr に skip trace ---
NON_TALK="$TMP/non-talk/references"
mkdir -p "$NON_TALK"
echo "description: foo" > "$NON_TALK/00.yaml"
run_hook "marker-absent" "$NON_TALK/00.yaml" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: talk-dir marker"; then
    pass "talk-dir マーカー不在: exit 0 / stdout 空 / stderr skip trace"
else
    fail "talk-dir マーカー不在: exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース2: yaml でないファイル → stdout 空 / stderr skip ---
run_hook "non-yaml" "$TMP/foo.txt" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: not a yaml file"; then
    pass "yaml 以外: exit 0 / stdout 空 / stderr skip trace"
else
    fail "yaml 以外: exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース3: file_path 空 → stdout 空 / stderr skip ---
run_hook_json "no-file-path" '{}' "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: tool_input.file_path"; then
    pass "file_path 空: exit 0 / stdout 空 / stderr skip trace"
else
    fail "file_path 空: exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース4: _template.yaml → 対象外 ---
# 理由は、validator の SKIP_FILES に含まれること。
# 検証されないのが正しい。
# 無音 no-op 検知に流して、毎回通知を出さないこと。
TALK="$TMP/talk"
mkdir -p "$TALK/references" "$TALK/pages"
touch "$TALK/slides.md"
echo "description: foo" > "$TALK/references/00.yaml"
echo "description: tpl" > "$TALK/references/_template.yaml"
run_hook "skip-files" "$TALK/references/_template.yaml" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: validator SKIP_FILES"; then
    pass "_template.yaml: exit 0 / stdout 空 / stderr skip trace (SKIP_FILES)"
else
    fail "_template.yaml: exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース5: plugin root 解決不能 → 対象外（stdout 空 / stderr skip） ---
# env 未設定かつ SCRIPT_DIR からの逆算も成立しない配置。設定不備（解決できたが
# dist が無い = ケース6）と区別され、model には何も出さない。
# 共有ライブラリは、hook の dir の 1 段上の core/ から source される。
# 逆算不能を確かめたい。
# そのため hook 自体は $TMP/detached に置き、ライブラリは兄弟の $TMP/core に置く（$TMP/detached/../core）。
# ここを欠くと、「共有ライブラリを解決できない」で先に止まる。
# その場合、plugin root 逆算の分岐に到達しない。
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
    pass "plugin root 解決不能: exit 0 / stdout 空 / stderr skip trace"
else
    fail "plugin root 解決不能: exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース6: 設定不備（plugin root は解決できるが validator dist が無い） ---
# 旧仕様は、通知なしの exit 0 だった。
# 検証されていないのに pass と区別できないため、「未実施」を additionalContext で model に伝える。
run_hook "dist-missing" "$TALK/references/00.yaml" "$TMP/no-such-plugin"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | head -n 1 | grep -q "^warning: references validation not run: "; then
    fail "validator dist 不在: 未実施通知が出ていない stdout='$OUT'"
elif ! echo "$CTX" | grep -q "assets: .*/assets/slidev"; then
    fail "validator dist 不在: 解決済み assets/slidev のパスが通知に無い ctx='$CTX'"
elif ! echo "$CTX" | grep -q "pecotv"; then
    fail "validator dist 不在: bootstrap 案内 (pecotv コマンド) が通知に無い ctx='$CTX'"
elif echo "$CTX" | grep -q "schema violations"; then
    fail "validator dist 不在: 違反として報告している ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[validate-references-check\] not-linted:"; then
    fail "validator dist 不在: stderr trace が not-linted でない stderr='$ERR'"
else
    pass "validator dist 不在: 未実施通知 + assets/slidev パス + bootstrap 案内"
fi

# --- ケース6b: 実行用ミラーが無い（初回の build 中・データ置き場を解決できない） ---
MIRROR_ABSENT=1 run_hook "mirror-absent" "$TALK/references/00.yaml" "$PLUGIN_ROOT"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: references validation not run:"; then
    fail "ミラー不在: 未実施通知が出ていない stdout='$OUT'"
elif ! echo "$CTX" | grep -q "pecotv"; then
    fail "ミラー不在: bootstrap 案内 (pecotv コマンド) が通知に無い ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[validate-references-check\] not-linted: runtime mirror is missing"; then
    fail "ミラー不在: stderr trace が not-linted でない stderr='$ERR'"
else
    pass "ミラー不在: 未実施通知 + bootstrap 案内"
fi

# --- ケース7: 真の pass（実 validator + fixture テーマの正常な references 一式） ---
# 「検証が実行されて違反ゼロ」を「検証されていない」と区別する対照群。
# 未実施判定側が空振りして、pass を未実施に誤って振り分けていないことを、ここで検知する。
if [ "$HAVE_VALIDATOR" = true ]; then
    REAL="$TMP/real-talk"
    make_talk "$REAL"
    run_hook "true-pass" "$REAL/references/plain.yaml" "$PLUGIN_ROOT"
    if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] pass:"; then
        pass "真の pass: stdout 空 / stderr pass trace"
    else
        fail "真の pass: exit=$EXIT stdout='$OUT' stderr='$ERR'"
    fi
else
    echo "SKIP: $VALIDATOR が無いので真の pass ケースを skip"
fi

# --- ケース8: 実 assets/slidev で違反検出 ---
if [ "$HAVE_VALIDATOR" = true ]; then
    VIOL="$TMP/violation-talk"
    make_talk "$VIOL"
    printf '%s' "$BAD_YAML" > "$VIOL/references/plain.yaml"
    run_hook "real-violation" "$VIOL/references/plain.yaml" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$OUT$ERR" | grep -q "ERR_MODULE_NOT_FOUND"; then
        fail "実 assets: ERR_MODULE_NOT_FOUND が出ている stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -q "warning: references schema violations:"; then
        fail "実 assets: 違反見出しが無い stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -q "must be object"; then
        fail "実 assets: 違反内容が additionalContext に含まれない ctx='$CTX'"
    elif ! printf '%s\n' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' > /dev/null 2>&1; then
        fail "実 assets: hookSpecificOutput.hookEventName が PostToolUse でない stdout='$OUT'"
    elif ! echo "$ERR" | grep -q "\[validate-references-check\] violation:"; then
        fail "実 assets: stderr trace が violation でない stderr='$ERR'"
    else
        pass "実 assets: 違反検出 + hookEventName 正常 + violation trace"
    fi

    # 件数フッターが本文先頭側（1 行目）にあること。additionalContext の文字数上限と
    # head -n 100 で末尾が落ちても、何件検出されたかは残る必要がある。
    if echo "$CTX" | head -n 1 | grep -qE 'files checked, [0-9]+ error\(s\) found\.$'; then
        pass "違反通知: 件数フッターが本文先頭行にある"
    else
        MSG_DETAIL_1="$(echo "$CTX" | head -n 3)"
        fail "違反通知: 件数フッターが本文先頭行に無い ctx='$MSG_DETAIL_1'"
    fi

    # 通知の帰属。validator は参照 dir 全体を検証するので、他ファイル
    # 由来の違反を編集ファイルの違反として提示してはならない。
    if echo "$CTX" | grep -q "validation result for the whole references directory"; then
        pass "違反通知: ディレクトリ全体の結果であることを明示している"
    else
        fail "違反通知: 帰属の但し書きが無い ctx='$CTX'"
    fi

    # category 欠落以外の違反に category 導線を混ぜない（BAD_YAML は type 違反のみ）。
    if echo "$CTX" | grep -q "layout_categories"; then
        fail "違反通知: category 欠落でないのに category 導線が付いている ctx='$CTX'"
    else
        pass "違反通知: category 欠落でなければ category 導線を出さない"
    fi

    # --- ケース8b: category 欠落の復旧導線 ---
    # schema 層の required 違反は、「何を書けばよいか」を示さない。
    # そのため、語彙の元データと node_modules の張り直し手段を 1 行添える。
    NOCAT="$TMP/no-category-talk"
    make_talk "$NOCAT"
    grep -v '^category:' "$REF_SRC/plain.yaml" > "$NOCAT/references/plain.yaml"
    run_hook "no-category" "$NOCAT/references/plain.yaml" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if ! echo "$CTX" | grep -q "warning: references schema violations:"; then
        fail "category 欠落: 違反見出しが無い stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -qF "required property 'category'"; then
        fail "category 欠落: validator の違反行が通知に無い ctx='$CTX'"
    elif ! echo "$CTX" | grep -q "layout_categories"; then
        fail "category 欠落: 語彙の元データへの導線が無い ctx='$CTX'"
    elif ! echo "$CTX" | grep -q "relinking node_modules with slide_sync (node_modules_only: true)"; then
        fail "category 欠落: node_modules を張り直す導線が無い ctx='$CTX'"
    elif echo "$CTX" | grep -q "テンプレートを同期"; then
        fail "category 欠落: 旧文言（テンプレートを同期）が残っている ctx='$CTX'"
    elif ! echo "$ERR" | grep -q "\[validate-references-check\] violation:"; then
        fail "category 欠落: stderr trace が violation でない stderr='$ERR'"
    else
        pass "category 欠落: 違反検出 + category 導線"
    fi
else
    echo "SKIP: $VALIDATOR が無いので実起動チェックを skip"
fi

# --- ケース9: 無音 no-op 検知（exit 0 だが検証されていない） ---
# validator は、exit 0 で無音になることがある（main() が実行されない退行など）。
# 旧仕様は exit 0 を全数 pass にしていたため、無音のまま pass になった。
assert_not_linted_at() {
    local label="$1" target="$2" root="$3" expect="$4" ctx
    run_hook "$label" "$target" "$root"
    ctx=$(ctx_of "$OUT")
    if echo "$ctx" | grep -q "schema violations"; then
        fail "$label: 違反として報告している ctx='$ctx'"
    elif ! echo "$ctx" | grep -q "warning: references validation not run:"; then
        fail "$label: 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
    elif ! echo "$ctx" | grep -q "$expect"; then
        fail "$label: 期待する理由 ('$expect') が通知に無い ctx='$ctx'"
    elif ! echo "$ERR" | grep -q "\[validate-references-check\] not-linted:"; then
        fail "$label: stderr trace が not-linted でない stderr='$ERR'"
    else
        pass "$label: 未実施へ振り分け（違反と報告しない）"
    fi
}

assert_not_linted() {
    assert_not_linted_at "$1" "$TALK/references/00.yaml" "$2" "$3"
}

# このスタブのケースは、validator の main が実行されず無音で exit 0 になる退行の未実施判定を、唯一守っている。
# 実 validator では、もう再現できない。消すと、この退行を検知できなくなる。
STUB_SILENT=$(make_stub_plugin stub-exit0-silent 0 "" "")
assert_not_linted "exit 0 かつ完全無音 (main 未実行相当)" "$STUB_SILENT" "printed no completion footer"

# 実 validator を symlink を含む CLAUDE_PLUGIN_ROOT で起動する。validator の自己実行判定が
# argv[1] を realpath に揃えているため、symlink 経由でも完走して pass に振り分けられる。
if [ "$HAVE_VALIDATOR" = true ]; then
    LINK_PLUGIN="$TMP/link-plugin"
    ln -s "$PLUGIN_ROOT" "$LINK_PLUGIN"
    run_hook "symlink-real-validator" "$REAL/references/plain.yaml" "$LINK_PLUGIN"
    if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] pass:"; then
        pass "実 validator を symlink 経由起動: 完走して pass（stdout 空 / stderr pass trace）"
    else
        fail "実 validator を symlink 経由起動: exit=$EXIT stdout='$OUT' stderr='$ERR'"
    fi
else
    echo "SKIP: $VALIDATOR が無いので symlink 起動ケースを skip"
fi

# hook のトリガ条件と validator の対象集合の不一致。どちらも validator は完走する
# （フッターあり・exit 0）が、編集ファイル自身は 1 度も読まれていない。
if [ "$HAVE_VALIDATOR" = true ]; then
    printf '%s' "$BAD_YAML" > "$REAL/references/ignored.yml"
    assert_not_linted_at ".yml 編集 (validator は *.yaml しか読まない)" \
        "$REAL/references/ignored.yml" "$PLUGIN_ROOT" "is not among the validated files"

    # ネスト配下は参照 dir そのものではないので、検証の対象にしない（readdirSync は非再帰）。
    mkdir -p "$REAL/references/sub"
    printf '%s' "$BAD_YAML" > "$REAL/references/sub/nested.yaml"
    run_hook "nested-yaml" "$REAL/references/sub/nested.yaml" "$PLUGIN_ROOT"
    if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: not a yaml in a theme references dir"; then
        pass "ネスト配下の yaml: 参照 dir そのものでないので skip"
    else
        fail "ネスト配下の yaml: skip していない stdout='$OUT' stderr='$ERR'"
    fi
else
    echo "SKIP: $VALIDATOR が無いので対象集合の不一致ケースを skip"
fi

# --- ケース10: 非 0 で完走していない分岐 → 未実施（違反と報告しない） ---
# #861 の本題。
# validator は、違反の場合とクラッシュの場合で、同じ exit 1 を返す。そのため、exit code 単独では判別できない。
# 旧仕様は、非 0 を全数「schema violations」に振り分けた。
# その結果、検証されていない YAML への修正指示が model に届く誤報が出ていた。
# timeout はスタブの exit 124 で再現する（実 sleep 30 秒を使わない）。
STUB_TIMEOUT=$(make_stub_plugin stub-exit124 124 "" "")
assert_not_linted "exit 124 (timeout)" "$STUB_TIMEOUT" "timed out"

STUB_EXIT1_EMPTY=$(make_stub_plugin stub-exit1-empty 1 "" "")
assert_not_linted "exit 1 かつ出力空 (cd 失敗相当)" "$STUB_EXIT1_EMPTY" "exited abnormally without output"

STUB_CRASH=$(make_stub_plugin stub-exit1-crash 1 "Validating: /somewhere/pages/_references" \
    "node:internal/modules/esm/resolve:275
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml'")
assert_not_linted "exit 1 + スタックトレースのみ (フッター無し = クラッシュ)" "$STUB_CRASH" "crashed"

# 実行異常時は原因追跡のため validator 出力の先頭を通知に添える
run_hook "crash-output-head" "$TALK/references/00.yaml" "$STUB_CRASH"
if ctx_of "$OUT" | grep -q "ERR_MODULE_NOT_FOUND"; then
    pass "クラッシュ: validator 出力の先頭を通知に添えている"
else
    fail "クラッシュ: validator 出力が通知に含まれない stdout='$OUT'"
fi

STUB_EXIT2=$(make_stub_plugin stub-exit2 2 "" "some fatal error")
assert_not_linted "exit 2 (その他の異常終了)" "$STUB_EXIT2" "exit 2"

# フッターがあっても exit 1 以外は完走とみなさない（違反判定は exit 1 に限る）。
STUB_EXIT3_FOOTER=$(make_stub_plugin stub-exit3-footer 3 \
    "Validating: /somewhere

  ✗ 00.yaml
    [#/type] must be object

1 files checked, 1 error(s) found." "")
assert_not_linted "exit 3 + フッターあり" "$STUB_EXIT3_FOOTER" "exit 3"

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

    # 退行検知の本体（実 validator 直叩き）。読み手をわざと遅らせて pipe を詰まらせる。
    # validator が process.exit() で終わると未フラッシュ分（pipe バッファ 64KB を超えた
    # 残り全部）が切り捨てられ、末尾の完走フッターごと消える。hook はフッターの有無で
    # 完走を判定するので、これが起きると違反が「クラッシュ = 未実施」に化けて無音になる。
    # process.exitCode なら node は drain を待って全量を吐く。
    # hook 経由でも同じ切り捨ては起きるが、発生するかは読み手の速度との競争になるため、
    # 退行検知は読み手を固定できるこの直叩きが担う。
    BIG_OUT=$( (CDPATH= cd -P "$BIG" && timeout 60 node "$VALIDATOR" --dir references 2>/dev/null) \
        | { sleep 1; cat; } )
    if [ "${#BIG_OUT}" -lt 100000 ]; then
        fail "大出力ピン留め: 遅い読み手で出力が切り捨てられた (${#BIG_OUT} bytes)。validate-references/index.ts が process.exit() に戻っていないか確認すること"
    elif ! echo "$BIG_OUT" | grep -qE '^[0-9]+ files checked, [0-9]+ error\(s\) found\.$'; then
        fail "大出力ピン留め: 遅い読み手で完走フッターが失われた (${#BIG_OUT} bytes)。validate-references/index.ts が process.exit() に戻っていないか確認すること"
    else
        pass "大出力ピン留め: 遅い読み手でも全量 (${#BIG_OUT} bytes) と完走フッターが残る"
    fi

    run_hook "big-output" "$BIG/references/big01.yaml" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "warning: references validation not run:"; then
        MSG_DETAIL_2="$(echo "$CTX" | head -n 3)"
        fail "大出力: 違反が未実施に化けている ctx='$MSG_DETAIL_2'"
    elif ! echo "$CTX" | head -n 1 | grep -qE '^warning: references schema violations: 12 files checked, [0-9]+ error\(s\) found\.$'; then
        MSG_DETAIL_3="$(echo "$CTX" | head -n 1)"
        fail "大出力: 件数フッターが先頭行に無い head='$MSG_DETAIL_3'"
    else
        pass "大出力: hook 経由で違反として報告され件数フッターが先頭行に残る"
    fi

    # 通知本文が 3000 バイトで頭打ちになり、最後の行が残りの違反数を示すこと。
    BIG_SHOWN=$(echo "$CTX" | grep -cE '^ +\[')
    BIG_REST=$(echo "$CTX" | tail -n 1 | sed -nE 's/^ *Truncated at 3000 bytes: ([0-9]+) more violations not shown\.$/\1/p')
    BIG_TOTAL=$(echo "$BIG_OUT" | grep -cE '^    \[')
    if [ "$(printf '%s' "$CTX" | wc -c)" -le 3600 ] && [ -n "$BIG_REST" ] && [ $((BIG_SHOWN + BIG_REST)) -eq "$BIG_TOTAL" ]; then
        pass "大出力: 3000 バイトで頭打ちになり、末尾の行の N が残りの違反数と合う 表示 $BIG_SHOWN 残り $BIG_REST 全体 $BIG_TOTAL"
    else
        BIG_LAST=$(echo "$CTX" | tail -n 1)
        fail "大出力: 切り詰めが合わない shown=$BIG_SHOWN rest='$BIG_REST' total=$BIG_TOTAL last='$BIG_LAST'"
    fi
else
    echo "SKIP: $VALIDATOR が無いので大出力ケースを skip"
fi

# --- ケース12: symlink トポロジでも talk-dir マーカーを見失わない ---
# A = references/ 自体が talk-dir 外への symlink。
# B = 祖先 dir が symlink（#836 の本番トリガー: worktree の .pecot/work → base）。
# 探索を物理パスにすると、A で編集ファイルの物理 dir が talk-dir の外に出て、マーカーを見失う。
# 参照 dir との比較を論理パスのまま行うと、A で一致せず、通知なしのスキップになる。
if [ "$HAVE_VALIDATOR" = true ]; then
    assert_detected() {
        local label="$1" target="$2"
        run_hook "topo-$label" "$target" "$PLUGIN_ROOT"
        if ctx_of "$OUT" | grep -q "warning: references schema violations:"; then
            pass "トポロジ $label: schema violations"
        else
            fail "トポロジ $label: schema 違反が報告されない stdout='$OUT' stderr='$ERR'"
        fi
    }

    TOPO="$TMP/topo"
    mkdir -p "$TOPO/A/talk/pages" "$TOPO/A/elsewhere"
    touch "$TOPO/A/talk/slides.md"
    cp -r "$REF_SRC" "$TOPO/A/elsewhere/references"
    printf '%s' "$BAD_YAML" > "$TOPO/A/elsewhere/references/plain.yaml"
    ln -s "$TOPO/A/elsewhere/references" "$TOPO/A/talk/references"
    assert_detected "A (references 自体が symlink)" "$TOPO/A/talk/references/plain.yaml"

    mkdir -p "$TOPO/B/real/talk/pages"
    touch "$TOPO/B/real/talk/slides.md"
    cp -r "$REF_SRC" "$TOPO/B/real/talk/references"
    printf '%s' "$BAD_YAML" > "$TOPO/B/real/talk/references/plain.yaml"
    ln -s "$TOPO/B/real" "$TOPO/B/link"
    assert_detected "B (祖先 dir が symlink)" "$TOPO/B/link/talk/references/plain.yaml"
else
    echo "SKIP: $VALIDATOR が無いので symlink トポロジケースを skip"
fi

# --- ケース13: merge-hook-outputs.sh 経由 ---
# 対象は、本番の呼び出し分岐。
# post-tool-use-edit.sh / post-tool-use-write.sh は、merge 経由で hook を起動する。
# merge は非 JSON の stdout を additionalContext に丸める。
# そのため、trace を stdout に出していたら、skip 分岐でも毎回 model に文字列が届く。
# 本ケースの主眼は、skip 分岐で merge の stdout が空であること（= trace が stdout を汚していないこと）。
# merge は `"$script"` を直接起動するので、hook の実行ビットも同時に確かめられる。
MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$NON_TALK/00.yaml\"}}"
MERGE_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$PLUGIN_ROOT")" bash "$MERGE" "$HOOK" 2>"$ERRFILE")
MERGE_ERR=$(cat "$ERRFILE")
if [ -n "$MERGE_OUT" ]; then
    fail "merge 経由 (skip 分岐): stdout が空でない（trace が additionalContext に丸められた疑い）stdout='$MERGE_OUT'"
elif ! echo "$MERGE_ERR" | grep -q "\[validate-references-check\] skip:"; then
    fail "merge 経由 (skip 分岐): stderr に trace がそのまま出ていない stderr='$MERGE_ERR'"
else
    pass "merge 経由 (skip 分岐): stdout が空 / stderr に trace がそのまま出る"
fi

# 未実施通知は merge を通っても additionalContext として model に届くこと
MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$TALK/references/00.yaml\"}}"
MERGE_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$STUB_CRASH" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$STUB_CRASH")" bash "$MERGE" "$HOOK" 2>"$ERRFILE")
MERGE_CTX=$(ctx_of "$MERGE_OUT")
if ! printf '%s\n' "$MERGE_OUT" | jq empty 2>/dev/null; then
    fail "merge 経由 (未実施分岐): stdout が妥当な JSON でない stdout='$MERGE_OUT'"
elif ! echo "$MERGE_CTX" | grep -q "warning: references validation not run:"; then
    fail "merge 経由 (未実施分岐): additionalContext に未実施通知が無い stdout='$MERGE_OUT'"
elif ! printf '%s\n' "$MERGE_OUT" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' > /dev/null 2>&1; then
    fail "merge 経由 (未実施分岐): hookEventName が PostToolUse でない stdout='$MERGE_OUT'"
else
    pass "merge 経由 (未実施分岐): additionalContext + hookEventName 正常"
fi

# --- ケース14: ピン留め — 実 validator の exit code と完走フッターの対応 ---
# hook は、完走フッターの有無だけで「完走した」を判定する。
# 文言と exit code は、validator 側の実装に依存する。
# そのため、変わると分岐の分類が、通知なしで不正になる。
# 実 dist を直接起動して固定する。
if [ "$HAVE_VALIDATOR" = true ]; then
    PIN_ERR="$TMP/pin-stderr.txt"
    FOOTER_RE='^[0-9]+ files checked, [0-9]+ error\(s\) found\.$'

    PIN_OUT=$(timeout 30 node "$VALIDATOR" --dir "$REAL/references" 2>"$PIN_ERR")
    PIN_EXIT=$?
    # $REAL には .yml とネスト yaml を足してあるが、どちらも validator の対象外なので
    # 検証結果は fixture テーマの一式そのまま（違反ゼロ）になる。
    if [ $PIN_EXIT -ne 0 ]; then
        MSG_DETAIL_5="$(echo "$PIN_OUT" | tail -n 3)"
        fail "ピン留め: 正常な references が exit 0 でない (exit=$PIN_EXIT) out='$MSG_DETAIL_5'"
    elif ! echo "$PIN_OUT" | grep -qE "$FOOTER_RE"; then
        MSG_DETAIL_6="$(echo "$PIN_OUT" | tail -n 3)"
        fail "ピン留め: pass 時に完走フッターが出ない（validator 側の文言変更の可能性。hook のフッター判定を更新すること）out='$MSG_DETAIL_6'"
    elif [ -s "$PIN_ERR" ]; then
        MSG_DETAIL_7="$(cat "$PIN_ERR")"
        fail "ピン留め: 正常系で stderr が空でない stderr='$MSG_DETAIL_7'"
    else
        pass "ピン留め: pass = exit 0 + 完走フッター + stderr 空"
    fi

    PIN_OUT=$(timeout 30 node "$VALIDATOR" --dir "$VIOL/references" 2>"$PIN_ERR")
    PIN_EXIT=$?
    if [ $PIN_EXIT -ne 1 ]; then
        fail "ピン留め: 違反時の exit code が 1 でない (exit=$PIN_EXIT)"
    elif ! echo "$PIN_OUT" | grep -qE "$FOOTER_RE"; then
        MSG_DETAIL_8="$(echo "$PIN_OUT" | tail -n 3)"
        fail "ピン留め: 違反時に完走フッターが出ない out='$MSG_DETAIL_8'"
    else
        pass "ピン留め: 違反 = exit 1 + 完走フッター"
    fi

    # ENOENT（検証対象 dir 不在）。
    # 違反と同じ exit 1 だが、完走フッターは出ず、stdout は冒頭の `Validating:` 1 行だけになる。
    # 「exit 1 = 違反」とは言い切れない根拠となる。
    # フッター判定が唯一の判別軸であることを固定する。
    PIN_OUT=$(timeout 30 node "$VALIDATOR" --dir "$TMP/no-such-references" 2>"$PIN_ERR")
    PIN_EXIT=$?
    if [ $PIN_EXIT -ne 1 ]; then
        fail "ピン留め: ENOENT 時の exit code が 1 でない (exit=$PIN_EXIT)"
    elif echo "$PIN_OUT" | grep -qE "$FOOTER_RE"; then
        fail "ピン留め: ENOENT なのに完走フッターが出ている out='$PIN_OUT'"
    elif ! echo "$PIN_OUT" | grep -q "^Validating:"; then
        fail "ピン留め: ENOENT 時の stdout が 'Validating:' で始まらない out='$PIN_OUT'"
    elif ! grep -q "ENOENT" "$PIN_ERR"; then
        MSG_DETAIL_9="$(head -n 3 "$PIN_ERR")"
        fail "ピン留め: ENOENT のスタックトレースが stderr に出ていない stderr='$MSG_DETAIL_9'"
    else
        pass "ピン留め: ENOENT = exit 1 + フッター無し（exit code だけでは違反と判別不能）"
    fi
else
    echo "SKIP: $VALIDATOR が無いのでピン留めチェックを skip"
fi

# --- ケース15: テーマの宣言（slide theme）の結果で対象を決める ---
# 15a: talk-dir 内でも、参照 dir でない yaml は検証しない（skip）。
if [ "$HAVE_VALIDATOR" = true ]; then
    mkdir -p "$REAL/public"
    printf '%s' "$BAD_YAML" > "$REAL/public/other.yaml"
    run_hook "not-reference-dir" "$REAL/public/other.yaml" "$PLUGIN_ROOT"
    if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: yaml outside a references-like dir"; then
        pass "参照 dir でない yaml: 検証せず skip"
    else
        fail "参照 dir でない yaml: skip していない stdout='$OUT' stderr='$ERR'"
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
        pass "2 つ目の参照 dir: その dir の yaml を検証して違反を検出"
    else
        fail "2 つ目の参照 dir: 違反が報告されない stdout='$OUT' stderr='$ERR'"
    fi

    # 15c: 検証するのは編集ファイルの dir だけ。もう一方の参照 dir の違反は混ぜない。
    mkdir -p "$THEME_SIDE/references"
    printf '%s' "$BAD_YAML" > "$THEME_SIDE/references/bad-in-talk.yaml"
    cp "$REF_SRC/plain.yaml" "$THEME_SIDE/theme-refs/plain.yaml"
    STUB_THEME_REFERENCES="$THEME_SIDE/references,$THEME_SIDE/theme-refs" \
        run_hook "only-edited-dir" "$THEME_SIDE/theme-refs/plain.yaml" "$PLUGIN_ROOT"
    if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] pass:"; then
        pass "編集ファイルの dir だけを検証: 別の参照 dir の違反は報告に入らない"
    else
        fail "編集ファイルの dir だけを検証: 別 dir の違反が混入した stdout='$OUT' stderr='$ERR'"
    fi
else
    echo "SKIP: $VALIDATOR が無いので参照 dir の比較ケースを skip"
fi

# 15a2: 参照 dir らしくない場所の yaml は、slide theme を起こさず、テーマ未リンクでも通知しない。
THEME_LOG="$TMP/theme-spawn.log"
rm -f "$THEME_LOG"
mkdir -p "$TALK/public"
echo "description: other" > "$TALK/public/other.yaml"
STUB_THEME_LOG="$THEME_LOG" STUB_THEME_FAIL=theme-unlinked run_hook "non-reference-no-theme" "$TALK/public/other.yaml" "$PLUGIN_ROOT"
if [ -z "$OUT" ] && [ ! -e "$THEME_LOG" ] && echo "$ERR" | grep -q "skip: yaml outside a references-like dir"; then
    pass "参照 dir らしくない yaml: slide theme を起こさず、通知しない"
else
    fail "参照 dir らしくない yaml: slide theme を起こした/通知した stdout='$OUT' stderr='$ERR'"
fi

# 15d: テーマを引けない talk-dir は検証せず、未実施として原因別に案内する。
STUB_NOCALL=$(make_stub_plugin stub-nocall 0 "SHOULD-NOT-RUN" "")
STUB_THEME_FAIL=theme-unlinked run_hook "theme-unlinked" "$TALK/references/00.yaml" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: references validation not run:"; then
    fail "theme-unlinked: 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
elif ! echo "$CTX" | grep -q "Relinking node_modules with slide_sync (node_modules_only: true)"; then
    fail "theme-unlinked: node_modules を張り直す案内が無い ctx='$CTX'"
elif echo "$CTX" | grep -q "SHOULD-NOT-RUN"; then
    fail "theme-unlinked: validator を起動している ctx='$CTX'"
else
    pass "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（validator は起動しない）"
fi

STUB_THEME_FAIL=theme-none run_hook "theme-none" "$TALK/references/00.yaml" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: references validation not run:" && echo "$CTX" | grep -q "theme-none"; then
    pass "theme-none: 未実施 + reason を通知"
else
    fail "theme-none: 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

STUB_THEME_FAIL=crash run_hook "theme-crash" "$TALK/references/00.yaml" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: references validation not run:" && echo "$CTX" | grep -q "slide theme exited with 3"; then
    pass "slide theme の異常終了: 未実施 + exit code を通知"
else
    fail "slide theme の異常終了: 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

# 15d2: slide theme が JSON を出せずに終了したとき、stderr の先頭 1 行を通知と trace に添える。
STUB_THEME_FAIL=crash STUB_THEME_STDERR="Node.js 24.22.1 以上が要ります" run_hook "theme-crash-stderr" "$TALK/references/00.yaml" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "stderr: Node.js 24.22.1 以上が要ります" && echo "$ERR" | grep -q "stderr: Node.js 24.22.1 以上が要ります"; then
    pass "slide theme の stderr: 先頭 1 行を通知と trace に添える"
else
    fail "slide theme の stderr: 通知か trace に無い ctx='$CTX' stderr='$ERR'"
fi

# 15e: マーカーは slides.md + pages/。start.mjs だけの dir は talk-dir とみなさない。
OLD_MARKER="$TMP/old-marker"
mkdir -p "$OLD_MARKER/pages" "$OLD_MARKER/references"
touch "$OLD_MARKER/start.mjs"
echo "description: foo" > "$OLD_MARKER/references/a.yaml"
run_hook "old-marker" "$OLD_MARKER/references/a.yaml" "$PLUGIN_ROOT"
if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[validate-references-check\] skip: talk-dir marker (slides.md + pages/)"; then
    pass "start.mjs だけの dir: talk-dir とみなさず skip"
else
    fail "start.mjs だけの dir: skip していない stdout='$OUT' stderr='$ERR'"
fi

# --- ケース16: 実 CLI（cli/dist）を通す ---
# 他のケースはミラーの stub CLI を使う。ここだけは build 済みの cli/dist の実物で slide theme を起こす。
# talk-dir の references/ に置いた不正な yaml を、実 CLI が返す参照 dir の先頭として検証する。
# cli/dist に slide theme（commands/slidev-project/theme.js）が無い環境（build 前、または古い build）では SKIP する。
# 最新のソースで build してから実行すること。
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
        pass "実 CLI: talk-dir の references/ の不正な yaml を検証して違反を検出"
    else
        fail "実 CLI: 違反が報告されない stdout='$OUT' stderr='$ERR'"
    fi
else
    echo "SKIP: cli/dist に slide theme が無い（build 前か古い build）か validator が無いので、実 CLI のケースを skip"
fi

# --- ガードレール: 全分岐で stdout が「空または妥当な JSON」 ---
if [ -z "$BAD_STDOUT" ]; then
    pass "ガードレール: 全分岐の stdout が空または妥当な JSON"
else
    fail "ガードレール: stdout が非 JSON の分岐がある: $BAD_STDOUT"
fi

echo ""
echo "===== summary: PASS=$PASS FAIL=$FAIL ====="
[ $FAIL -eq 0 ]
