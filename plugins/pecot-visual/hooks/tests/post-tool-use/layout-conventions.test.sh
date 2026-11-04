#!/bin/bash
# layout-conventions.sh の単体テスト。
#
# 検証の軸は 3 つ。
#
# 1. 分岐の分類: 提示する分岐としない分岐を固定する。
#    次の場合は、すべて無音（stdout 空）であること。
#    対象 MD でない / talk-dir 外 / 参照 YAML の dir 配下 / slides.md。
#    layout 不明 / layout 値が不正 / 参照 YAML 不在 / 実行環境不足。
# 2. 提示内容: 出典パス 1 行 + YAML 原文の抜粋だけであること。
#    地の文・指示文・見出しマーカーが含まれないことを固定する。
#    抜粋が出典ブロックを欠落なく含むことも固定する。
#    本 hook は判定装置ではない。
#    「修正してください」に類する文言が入った時点で、lint との区別が崩れる。
# 3. 出力チャネル: model 向けは stdout の JSON、開発者診断 trace は stderr。
#    stdout は全分岐で「空または妥当な JSON」であること。
#    呼び出し元 merge-hook-outputs.sh が、非 JSON stdout を additionalContext に丸めるためだ。
#
# 全ケースで stdout と stderr を分離して捕捉する。
# 2>&1 で混ぜると、trace 1 行が JSON パースを壊す。
# その場合、上記 3 のチェック自体が成立しない。
#
# 併せて次を固定する:
# - 出典パスが logical 絶対パスであること。
#   symlink トポロジ A / B を経由しても、編集時に通ったパスのまま出る。
# - 本番エントリポイントの post-tool-use-edit.sh と post-tool-use-write.sh を経由する。
#   その場合、1 つの additionalContext に「抜粋 → ESLint 違反」の順で入ること。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK="$HOOKS_DIR/lib/post-tool-use/layout-conventions.sh"
MERGE="$HOOKS_DIR/lib/core/merge-hook-outputs.sh"
PLUGIN_ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
# shellcheck source=mirror-helper.sh
. "$SCRIPT_DIR/mirror-helper.sh"
ASSETS_DIR="$PLUGIN_ROOT/assets/slidev"
# 参照 yaml は fixture テーマのもの。参照 dir の一覧は、ミラーの stub CLI（mirror-helper.sh）が返す。
# 初期値は「<talk>/references」だけ。
REFERENCES_DIR="$PLUGIN_ROOT/cli/tests/fixtures/themes/with-declaration/references"
# ASSETS_DIR / REFERENCES_DIR 自体の不在は、リポジトリ内では常に異常（移動し損ねた状態）。
# eslint の解決不能（bootstrap 前）と違い、SKIP にすると全ケースが通知なしで空振りする。
# そのため FAIL にする。
[ -d "$ASSETS_DIR" ] || { echo "FAIL: ASSETS_DIR 不在: $ASSETS_DIR"; exit 1; }
[ -d "$REFERENCES_DIR" ] || { echo "FAIL: REFERENCES_DIR 不在: $REFERENCES_DIR"; exit 1; }

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

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(CDPATH= cd -P "$TMP" && pwd -P)

ERRFILE="$TMP/hook-stderr.txt"
# 非 JSON の stdout を出した分岐をここに溜め、最後にまとめて 1 件の assert にする。
BAD_STDOUT=""

# hook を 1 回起動し、stdout を $OUT / stderr を $ERR / 終了コードを $EXIT に入れる。
# $1 = ラベル, $2 = 標準入力に渡す JSON, $3 = CLAUDE_PLUGIN_ROOT
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

# 無音であるべき分岐の共通 assert。stdout が空 + stderr が skip trace。
# $1 = ラベル, $2 = trace に現れるべき理由の断片
assert_silent() {
    local label="$1" reason="$2"
    if [ "$EXIT" -ne 0 ]; then
        fail "$label: exit が 0 でない (exit=$EXIT)"
    elif [ -n "$OUT" ]; then
        fail "$label: stdout が空でない stdout='$OUT'"
    elif ! echo "$ERR" | grep -q "\[layout-conventions\] skip: $reason"; then
        fail "$label: 期待する skip trace ('$reason') が無い stderr='$ERR'"
    else
        pass "$label: stdout 空 / stderr skip trace"
    fi
}

# あるトップレベルキーのブロック（キー行 + 字下げ継続行）の非空行数を数える。
# 空行を数えないのは、抜粋側が末尾の空行を落とすため（出典側と数え方を揃える）。
# $1 = テキスト, $2 = キー
count_block_lines() {
    printf '%s\n' "$1" | LC_ALL=C awk -v key="$2" '
        index($0, key ":") == 1 { inb = 1; n++; next }
        inb && /^[^[:space:]]/ { inb = 0 }
        inb && NF > 0 { n++ }
        END { print n + 0 }'
}

# 提示本文が「出典パス 1 行 + YAML 原文の抜粋」だけであることを確かめる。
# 地の文の禁止は、語の denylist では確かめられない。
# anti_patterns の原文に「確認」等が実在するため、denylist は原文そのものを弾いてしまう。
# 代わりに、次の 4 点を確かめる。
#   - 1 行目が出典 YAML の logical 絶対パス
#   - 行の形が 出典パス / 抜粋キー行 / 字下げ継続行 / 空行 のいずれか
#   - 2 行目以降の非空行がすべて出典 YAML に原文のまま存在する
#   - 抜粋した各ブロックの行数が出典 YAML の当該ブロックと一致する（途中欠落の検知）
# この 4 点で、hook が行を足していないことと、落としていないことを示す。
# $1 = ラベル, $2 = additionalContext, $3 = 出典 YAML の期待パス
assert_excerpt() {
    local label="$1" ctx="$2" src="$3"
    local bad stray="" line src_text key n_ctx n_src
    if [ "$(printf '%s\n' "$ctx" | head -n 1)" != "$src:" ]; then
        MSG_DETAIL_1="$(printf '%s\n' "$ctx" | head -n 1)"
        fail "$label: 1 行目が出典 YAML の絶対パスでない（期待 '$src:'）実際='$MSG_DETAIL_1'"
        return
    fi
    if [ ! -f "$src" ]; then
        fail "$label: 出典 YAML が存在しない ($src)"
        return
    fi
    src_text=$(cat "$src")

    bad=$(printf '%s\n' "$ctx" | \
        grep -nvE '^(/.*/references/[A-Za-z0-9._-]+\.yaml:|status:.*|best_practices:|anti_patterns:| .*|)$')
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        grep -qxF -- "$line" "$src" || stray="${stray}[$line] "
    done < <(printf '%s\n' "$ctx" | tail -n +2)

    if [ -n "$bad" ]; then
        MSG_DETAIL_2="$(echo "$bad" | tr '\n' ' ')"
        fail "$label: 抜粋以外の形の行がある（地の文混入の疑い）: $MSG_DETAIL_2"
        return
    fi
    if [ -n "$stray" ]; then
        fail "$label: 出典 YAML に無い行がある（hook が文字列を足した疑い）: $stray"
        return
    fi
    if printf '%s\n' "$ctx" | grep -q '【'; then
        fail "$label: 見出しマーカーがある（判定装置の出力形式に寄っている）ctx='$ctx'"
        return
    fi
    for key in status best_practices anti_patterns; do
        n_ctx=$(count_block_lines "$ctx" "$key")
        [ "$n_ctx" -eq 0 ] && continue
        n_src=$(count_block_lines "$src_text" "$key")
        if [ "$n_ctx" -ne "$n_src" ]; then
            fail "$label: $key ブロックの行数が出典と不一致（抜粋 $n_ctx / 出典 $n_src）"
            return
        fi
    done
    pass "$label: 出典パス + YAML 原文の抜粋のみ（過不足なし）"
}

# talk-dir fixture。参照 YAML は fixture テーマから talk-dir の references/ に複製する。
# 提示元は stub CLI が返す参照 dir の一覧で、初期状態では talk-dir の references/ だけ。
TALK="$TMP/talk"
mkdir -p "$TALK/pages"
touch "$TALK/slides.md"
cp -r "$REFERENCES_DIR" "$TALK/references"

# $1 = pages/ 配下の相対パス, $2 = ページ本文。書いたファイルの絶対パスを返す。
write_page() {
    mkdir -p "$(dirname "$TALK/pages/$1")"
    printf '%s' "$2" > "$TALK/pages/$1"
    printf '%s' "$TALK/pages/$1"
}

# --- ケース1: 対象 MD でない分岐 ---
run_hook_json "no-file-path" '{}' "$PLUGIN_ROOT"
assert_silent "file_path 空" "tool_input.file_path が空"

run_hook "non-md" "$TALK/pages/foo.txt" "$PLUGIN_ROOT"
assert_silent "非 .md" ".md 以外"

NON_TALK="$TMP/non-talk"
mkdir -p "$NON_TALK"
echo "# foo" > "$NON_TALK/foo.md"
run_hook "outside-talk" "$NON_TALK/foo.md" "$PLUGIN_ROOT"
assert_silent "talk-dir 外" "talk-dir マーカー"

# 参照 YAML の dir 配下。case のパターンは `/` も `*` で食うため、pages/ の下に参照 dir があると
# その中の MD が対象に紛れ込む。参照 dir の一覧（stub CLI が返す）と比べて外す。
mkdir -p "$TALK/pages/shared-refs"
echo "# note" > "$TALK/pages/shared-refs/note.md"
STUB_THEME_REFERENCES="$TALK/references,$TALK/pages/shared-refs" \
    run_hook "references-dir" "$TALK/pages/shared-refs/note.md" "$PLUGIN_ROOT"
assert_silent "参照 YAML の dir 配下" "参照 YAML の dir 配下"

# slides.md は束ねる側。個別ページの layout 規約は持たない。
printf -- '---\nlayout: plain\n---\n' > "$TALK/slides.md"
run_hook "slides-md" "$TALK/slides.md" "$PLUGIN_ROOT"
assert_silent "slides.md" "pages 配下の MD でない"

# talk-dir 内だが pages 配下でない MD
echo "# readme" > "$TALK/README.md"
run_hook "talk-readme" "$TALK/README.md" "$PLUGIN_ROOT"
assert_silent "talk-dir 直下の README.md" "pages 配下の MD でない"

# --- ケース2: layout が取れない / 使えない分岐 ---
run_hook "no-frontmatter" "$(write_page plain.md '# 見出しだけ
')" "$PLUGIN_ROOT"
assert_silent "frontmatter 無し" "frontmatter か layout が無い"

run_hook "no-layout" "$(write_page nolayout.md '---
title: "layout を書いていない"
---
')" "$PLUGIN_ROOT"
assert_silent "layout 未指定" "frontmatter か layout が無い"

# パストラバーサル。`../` を通すと参照 dir の外の YAML を読み出せる。
run_hook "traversal-layout" "$(write_page traversal.md '---
layout: ../../etc/passwd
---
')" "$PLUGIN_ROOT"
assert_silent "layout が ../ を含む" "layout 値が参照 YAML のファイル名として不正"

# `_` 始まりは layout として指定されない内部ファイル（_template / _common 等）。
run_hook "underscore-layout" "$(write_page underscore.md '---
layout: _template
---
')" "$PLUGIN_ROOT"
assert_silent "layout が _ 始まり" "layout 値が参照 YAML のファイル名として不正"

run_hook "unknown-layout" "$(write_page unknown.md '---
layout: no-such-layout
---
')" "$PLUGIN_ROOT"
assert_silent "対応する参照 YAML 不在" "対応する参照 YAML が無い"

# 参照 YAML はあるが読めない場合。不在（綴り違い・テーマ側の欠落）と別分岐であること。
printf 'layout: [broken\n  - yaml\n' > "$TALK/references/brokenlayout.yaml"
run_hook "broken-yaml" "$(write_page broken.md '---
layout: brokenlayout
---
')" "$PLUGIN_ROOT"
assert_silent "参照 YAML がパース不能" "参照 YAML を読めない"

# 参照 YAML はあるが抜粋対象のキーが無い場合。
cat > "$TALK/references/barelayout.yaml" <<'EOF'
layout: 'barelayout'
description: '抜粋対象のキーを持たない参照 YAML'
props:
  title:
    type: 'string'
EOF
run_hook "no-sections" "$(write_page bare.md '---
layout: barelayout
---
')" "$PLUGIN_ROOT"
assert_silent "抜粋対象が無い参照 YAML" "参照 YAML に status / best_practices / anti_patterns のいずれも無い"

# --- ケース3: 実行環境が不足する分岐（未実施通知を出さないこと） ---
# 本 hook は判定装置ではないので、提示できなかったことを model に伝えない。
# eslint-check.sh の【ESLint 未実施】に相当する出力を持たないことが要点。
STEP1=$(write_page step1.md '---
layout: plain
---
')
run_hook "dist-missing" "$STEP1" "$TMP/no-such-plugin"
assert_silent "_shared/dist 不在" "実行環境が不足"

# node 不在。PATH から node だけを外した最小 bin を組み、hook が必要とする他の
# コマンドは実体への symlink で残す。
NO_NODE_BIN="$TMP/no-node-bin"
mkdir -p "$NO_NODE_BIN"
for cmd in cat jq dirname basename head timeout mktemp rm sha256sum xargs sort tr cut find awk sed; do
    ln -sf "$(command -v "$cmd")" "$NO_NODE_BIN/$cmd"
done
OUT=$(printf '%s' "{\"tool_input\":{\"file_path\":\"$STEP1\"}}" | \
    env PATH="$NO_NODE_BIN" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$PLUGIN_ROOT")" "$(command -v bash)" "$HOOK" 2>"$ERRFILE")
EXIT=$?
ERR=$(cat "$ERRFILE")
[ -n "$OUT" ] && BAD_STDOUT="${BAD_STDOUT}[no-node] "
assert_silent "node 不在" "実行環境が不足"

# 共有ライブラリは、hook の dir の 1 段上の core/ から source される。
# 逆算不能を確かめたい。
# そのため hook 自体は $TMP/detached に置き、ライブラリは兄弟の $TMP/core に置く（$TMP/detached/../core）。
# ここを欠くと、「共有ライブラリを解決できない」で先に止まる。
# その場合、plugin root 逆算の分岐に到達しない。
mkdir -p "$TMP/core"
cp "$HOOKS_DIR/lib/core/hook-paths.sh" "$TMP/core/hook-paths.sh"

# plugin root 解決不能（env 未設定かつ SCRIPT_DIR からの逆算も成立しない配置）
DETACHED="$TMP/detached"
mkdir -p "$DETACHED"
cp "$HOOK" "$DETACHED/layout-conventions.sh"
OUT=$(printf '%s' "{\"tool_input\":{\"file_path\":\"$STEP1\"}}" | \
    env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_HOOKS bash "$DETACHED/layout-conventions.sh" 2>"$ERRFILE")
EXIT=$?
ERR=$(cat "$ERRFILE")
[ -n "$OUT" ] && BAD_STDOUT="${BAD_STDOUT}[detached] "
assert_silent "plugin root 解決不能" "plugin root を解決できない"

# 共有ライブラリ自体が無い配置。未定義関数のまま実行すると、talk-dir 外と区別できない
# 無音 skip になるので、専用の trace で落ちること。
NOLIB="$TMP/nolib/lib/post-tool-use"
mkdir -p "$NOLIB"
cp "$HOOK" "$NOLIB/layout-conventions.sh"
OUT=$(printf '%s' "{\"tool_input\":{\"file_path\":\"$STEP1\"}}" | \
    CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$PLUGIN_ROOT")" bash "$NOLIB/layout-conventions.sh" 2>"$ERRFILE")
EXIT=$?
ERR=$(cat "$ERRFILE")
[ -n "$OUT" ] && BAD_STDOUT="${BAD_STDOUT}[nolib] "
assert_silent "共有ライブラリ不在" "共有ライブラリを解決できない"

# --- ケース4: 提示分岐 ---
run_hook "plain" "$STEP1" "$PLUGIN_ROOT"
CTX=$(ctx_of "$OUT")
if ! printf '%s\n' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' > /dev/null 2>&1; then
    fail "plain: hookEventName が PostToolUse でない stdout='$OUT'"
elif ! echo "$CTX" | grep -q '^anti_patterns:$'; then
    fail "plain: anti_patterns 行が無い ctx='$CTX'"
elif ! echo "$CTX" | grep -q '見出しに文章を書く'; then
    fail "plain: anti_patterns の原文が抜粋されていない ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[layout-conventions\] present:"; then
    fail "plain: stderr trace が present でない stderr='$ERR'"
else
    pass "plain: 出典パス + anti_patterns 抜粋 + present trace"
fi
assert_excerpt "plain" "$CTX" "$TALK/references/plain.yaml"

# best_practices も抜粋対象。anti_patterns だけを見ていると落ちる。
if echo "$CTX" | grep -q '^best_practices:$'; then
    pass "plain: best_practices ブロックも抜粋される"
else
    fail "plain: best_practices ブロックが無い ctx='$CTX'"
fi

# ブロックの順序は出典 YAML の出現順（best_practices → anti_patterns）に従う。
BP_LINE=$(printf '%s\n' "$CTX" | grep -n '^best_practices:$' | head -n 1 | cut -d: -f1)
AP_LINE=$(printf '%s\n' "$CTX" | grep -n '^anti_patterns:$' | head -n 1 | cut -d: -f1)
if [ -n "$BP_LINE" ] && [ -n "$AP_LINE" ] && [ "$BP_LINE" -lt "$AP_LINE" ]; then
    pass "plain: ブロック順が出典 YAML の出現順（best_practices → anti_patterns）"
else
    fail "plain: ブロック順が出現順でない (best_practices=$BP_LINE anti_patterns=$AP_LINE)"
fi

# trace には実体の絶対パスが入る。
# 実セッションの transcript から、どの配置の hook が動いたかを特定するためだ。
if echo "$ERR" | grep -qF "(self: $HOOK)"; then
    pass "trace: 実行された実体の絶対パスを含む"
else
    fail "trace: 実体の絶対パスが無い stderr='$ERR'"
fi

# layout ごとに内容が変わること（YAML を読まずに固定文字列を返していないこと）
run_hook "panel" "$(write_page radar.md '---
layout: panel
---
')" "$PLUGIN_ROOT"
RADAR_CTX=$(ctx_of "$OUT")
if ! echo "$RADAR_CTX" | grep -q '図の枠に収まらない画像を置く'; then
    fail "panel: 当該 layout の anti_patterns が出ていない ctx='$RADAR_CTX'"
elif echo "$RADAR_CTX" | grep -q '見出しに文章を書く'; then
    fail "panel: 別 layout の anti_patterns が含まれている ctx='$RADAR_CTX'"
else
    pass "panel: layout ごとに内容が切り替わる"
fi
assert_excerpt "panel" "$RADAR_CTX" "$TALK/references/panel.yaml"

# deprecated / hidden は status 行を先頭ブロックに含める
cat > "$TALK/references/legacy.yaml" <<'EOF'
layout: 'legacy'
description: '非推奨のレイアウト'
status: 'deprecated'
best_practices:
  - '使わずに別のレイアウトを選ぶ'
anti_patterns:
  - '新しいページに使う'
EOF
run_hook "deprecated-layout" "$(write_page dep.md '---
layout: legacy
---
')" "$PLUGIN_ROOT"
DEP_CTX=$(ctx_of "$OUT")
STATUS_LINE=$(printf '%s\n' "$DEP_CTX" | grep -n '^status:' | head -n 1 | cut -d: -f1)
ANTI_LINE=$(printf '%s\n' "$DEP_CTX" | grep -n '^anti_patterns:$' | head -n 1 | cut -d: -f1)
if [ -z "$STATUS_LINE" ]; then
    fail "deprecated layout: status 行が無い ctx='$DEP_CTX'"
elif ! echo "$DEP_CTX" | grep -q "^status: 'deprecated'$"; then
    fail "deprecated layout: status の原文が抜粋されていない ctx='$DEP_CTX'"
elif [ -z "$ANTI_LINE" ] || [ "$STATUS_LINE" -ge "$ANTI_LINE" ]; then
    fail "deprecated layout: status が anti_patterns より先頭に無い ctx='$DEP_CTX'"
else
    pass "deprecated layout: status 行を anti_patterns の前に含める"
fi
assert_excerpt "deprecated layout" "$DEP_CTX" "$TALK/references/legacy.yaml"

# pages/ 直下でないページ。REL_FILE の case は `/` も `*` で食うので対象に入る。
# 参照 dir は編集ファイルの隣ではなく talk root 直下を見る。
run_hook "nested-page" "$(write_page sub/step2.md '---
layout: plain
---
')" "$PLUGIN_ROOT"
NESTED_CTX=$(ctx_of "$OUT")
if echo "$ERR" | grep -q "\[layout-conventions\] present:.*pages/sub/step2.md"; then
    pass "pages/sub 配下: 提示される（trace の相対パスは pages/sub/step2.md）"
else
    fail "pages/sub 配下: present trace に相対パスが出ていない stderr='$ERR'"
fi
assert_excerpt "pages/sub 配下" "$NESTED_CTX" "$TALK/references/plain.yaml"

# --- ケース5: ページ側の表記ゆれに対する頑健性 ---
# frontmatter の解釈は、lint 側の実装に委ねている。
# 委譲が外れて自前の行単位の比較に戻った場合、これらが最初に失敗する。
CRLF_PAGE="$TALK/pages/crlf.md"
printf -- '--- \r\nlayout: plain\r\ntitle: "CRLF"\r\n---\r\n' > "$CRLF_PAGE"
run_hook "crlf-page" "$CRLF_PAGE" "$PLUGIN_ROOT"
if [ "$(ctx_of "$OUT" | head -n 1)" = "$TALK/references/plain.yaml:" ]; then
    pass "CRLF ページ + 区切り行の末尾空白: 提示される"
else
    fail "CRLF ページ + 区切り行の末尾空白: 提示されない stdout='$OUT' stderr='$ERR'"
fi

run_hook "quoted-layout" "$(write_page quoted.md '---
layout: "plain"
---
')" "$PLUGIN_ROOT"
if [ "$(ctx_of "$OUT" | head -n 1)" = "$TALK/references/plain.yaml:" ]; then
    pass "クォート付き layout 値: 提示される"
else
    fail "クォート付き layout 値: 提示されない stdout='$OUT' stderr='$ERR'"
fi

# --- ケース6: 巨大な参照 YAML の切り詰め ---
# 異常に長い参照 YAML（あるいは不正に肥大した参照 YAML）が、additionalContext を占有しないこと。
{
    echo "layout: 'biglayout'"
    echo "anti_patterns:"
    for i in $(seq 1 250); do
        echo "  - 'アンチパターン $i'"
    done
} > "$TALK/references/biglayout.yaml"
run_hook "big-yaml" "$(write_page big.md '---
layout: biglayout
---
')" "$PLUGIN_ROOT"
BIG_CTX=$(ctx_of "$OUT")
BIG_LINES=$(printf '%s\n' "$BIG_CTX" | wc -l | tr -d ' ')
if ! printf '%s\n' "$OUT" | jq empty 2>/dev/null; then
    MSG_DETAIL_3="$(printf '%s' "$OUT" | head -c 200)"
    fail "巨大な参照 YAML: stdout が妥当な JSON でない stdout（先頭）='$MSG_DETAIL_3'"
elif [ "$BIG_LINES" -ne 200 ]; then
    fail "巨大な参照 YAML: 200 行に切り詰められていない（$BIG_LINES 行）"
elif ! printf '%s\n' "$BIG_CTX" | grep -q "アンチパターン 190"; then
    fail "巨大な参照 YAML: 切り詰め位置が早すぎる（190 件目が落ちている）"
elif printf '%s\n' "$BIG_CTX" | grep -q "アンチパターン 250"; then
    fail "巨大な参照 YAML: 切り詰められていない（250 件目が残っている）"
else
    pass "巨大な参照 YAML: 200 行に切り詰め + stdout は妥当な JSON"
fi

# --- ケース7: symlink トポロジでも提示される ---
# 期待は、symlink トポロジでも提示され、出典パスが logical のまま出ること。
# A = pages/ 自体が talk-dir 外への symlink。
# B = 祖先 dir が symlink（#836 の本番トリガー: worktree の .pecot/work → base）。
# 探索を物理パスにすると、A は通知なしの skip になる。
# 出典パスを物理パスにすると、編集時に通ったパスと食い違う。
# その場合、model が別プロジェクトの規約と誤認する。
PAGE_BODY='---
layout: plain
---
'
assert_topology() {
    local label="$1" page="$2" expected_src="$3" ctx
    run_hook "topo-$label" "$page" "$PLUGIN_ROOT"
    ctx=$(ctx_of "$OUT")
    if [ -z "$ctx" ]; then
        fail "トポロジ $label: 提示されない stdout='$OUT' stderr='$ERR'"
        return
    fi
    assert_excerpt "トポロジ $label" "$ctx" "$expected_src"
}

TOPO="$TMP/topo"
mkdir -p "$TOPO/A/talk" "$TOPO/A/elsewhere"
touch "$TOPO/A/talk/slides.md"
printf '%s' "$PAGE_BODY" > "$TOPO/A/elsewhere/step.md"
ln -s "$TOPO/A/elsewhere" "$TOPO/A/talk/pages"
cp -r "$REFERENCES_DIR" "$TOPO/A/talk/references"
assert_topology "A (pages 自体が symlink)" \
    "$TOPO/A/talk/pages/step.md" \
    "$TOPO/A/talk/references/plain.yaml"

mkdir -p "$TOPO/B/real/talk/pages"
touch "$TOPO/B/real/talk/slides.md"
printf '%s' "$PAGE_BODY" > "$TOPO/B/real/talk/pages/step.md"
cp -r "$REFERENCES_DIR" "$TOPO/B/real/talk/references"
ln -s "$TOPO/B/real" "$TOPO/B/link"
assert_topology "B (祖先 dir が symlink)" \
    "$TOPO/B/link/talk/pages/step.md" \
    "$TOPO/B/link/talk/references/plain.yaml"

# --- ケース8: merge-hook-outputs.sh 経由 ---
# 対象は、skip 分岐の stdout 汚染。
# skip 分岐で merge の stdout が空であること（trace が stdout を汚していないこと）。
MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$NON_TALK/foo.md\"}}"
MERGE_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$PLUGIN_ROOT")" bash "$MERGE" "$HOOK" 2>"$ERRFILE")
MERGE_ERR=$(cat "$ERRFILE")
if [ -n "$MERGE_OUT" ]; then
    fail "merge 経由 (skip 分岐): stdout が空でない（trace が additionalContext に丸められた疑い）stdout='$MERGE_OUT'"
elif ! echo "$MERGE_ERR" | grep -q "\[layout-conventions\] skip:"; then
    fail "merge 経由 (skip 分岐): stderr に trace がそのまま出ていない stderr='$MERGE_ERR'"
else
    pass "merge 経由 (skip 分岐): stdout が空 / stderr に trace がそのまま出る"
fi

# --- ケース9: 本番エントリポイント経由の結合順 ---
# post-tool-use-edit.sh / post-tool-use-write.sh が、merge に引数を渡す。
# layout-conventions.sh を第 1 引数、eslint-check.sh を第 2 引数とする。
# このテストはその順序に依存する。
# テスト自身が引数順を組み立てると、エントリポイント側の並びが入れ替わっても検知できない。
# 違反は、frontmatter を壊さない種類（text-constraints/max-chars）で作る。
# no-content-before-frontmatter 系の fixture では layout 自体が取れず、抜粋側が出ない。
# そのため、結合順のチェックにならない。
# eslint-check.sh と同じ解決（assets/slidev 基準で eslint/package.json を引く）。
if (cd "$ASSETS_DIR" && node -p "require.resolve('eslint/package.json')") > /dev/null 2>&1; then
    BOTH_PAGE="$TALK/pages/both.md"
    cat > "$BOTH_PAGE" <<'EOF'
---
layout: plain
heading: "これは max_chars 20 を大幅に超過する非常に長いセクションタイトルです"
---
EOF
    MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$BOTH_PAGE\"}}"
    for ENTRY in post-tool-use-edit.sh post-tool-use-write.sh; do
        ENTRY_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$PLUGIN_ROOT")" \
            bash "$HOOKS_DIR/$ENTRY" 2>"$ERRFILE")
        ENTRY_CTX=$(ctx_of "$ENTRY_OUT")
        EXCERPT_LINE=$(printf '%s\n' "$ENTRY_CTX" | \
            grep -nF "$TALK/references/plain.yaml:" | head -n 1 | cut -d: -f1)
        VIOLATION_LINE=$(printf '%s\n' "$ENTRY_CTX" | grep -n '【ESLint違反検出】' | head -n 1 | cut -d: -f1)
        if ! printf '%s\n' "$ENTRY_OUT" | jq empty 2>/dev/null; then
            fail "$ENTRY 経由: stdout が妥当な JSON でない stdout='$ENTRY_OUT'"
        elif [ -z "$EXCERPT_LINE" ]; then
            fail "$ENTRY 経由: 抜粋が additionalContext に無い ctx='$ENTRY_CTX'"
        elif [ -z "$VIOLATION_LINE" ]; then
            fail "$ENTRY 経由: ESLint 違反が additionalContext に無い ctx='$ENTRY_CTX'"
        elif [ "$EXCERPT_LINE" -ge "$VIOLATION_LINE" ]; then
            fail "$ENTRY 経由: 抜粋が違反より後にある (抜粋=$EXCERPT_LINE 違反=$VIOLATION_LINE)"
        else
            pass "$ENTRY 経由: 1 つの additionalContext に「抜粋 → 違反」の順で入る"
        fi
    done
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないのでエントリポイント結合順ケースを skip"
fi

# --- ケース10: テーマの宣言（slide theme）の結果で参照 dir を決める ---
# 10a: テーマを引けない talk-dir は、提示する規約が無いので無音。
STEP2=$(write_page step-theme.md '---
layout: plain
---
')
for reason in theme-unlinked theme-none crash; do
    STUB_THEME_FAIL="$reason" run_hook "theme-$reason" "$STEP2" "$PLUGIN_ROOT"
    assert_silent "slide theme が失敗 ($reason)" "テーマを引けない"
done

# 10b: 参照 dir の一覧は先頭が優先。talk-dir の references/ の yaml が、テーマ側の同名の yaml に勝つ。
MULTI="$TMP/multi"
mkdir -p "$MULTI/pages" "$MULTI/references" "$MULTI/theme-refs"
touch "$MULTI/slides.md"
cp "$REFERENCES_DIR/plain.yaml" "$MULTI/theme-refs/plain.yaml"
cat > "$MULTI/references/plain.yaml" <<'EOF'
layout: 'plain'
best_practices:
  - 'talk-dir 側の上書き'
EOF
printf -- '---\nlayout: plain\n---\n' > "$MULTI/pages/p.md"
STUB_THEME_REFERENCES="$MULTI/references,$MULTI/theme-refs" run_hook "multi-first" "$MULTI/pages/p.md" "$PLUGIN_ROOT"
CTX=$(ctx_of "$OUT")
if [ "$(printf '%s\n' "$CTX" | head -n 1)" = "$MULTI/references/plain.yaml:" ] && echo "$CTX" | grep -q "talk-dir 側の上書き"; then
    pass "参照 dir が複数: 先頭（talk-dir 側）の yaml を提示"
else
    fail "参照 dir が複数: 先頭の yaml が提示されない stdout='$OUT' stderr='$ERR'"
fi

# テーマ側にしか無い layout は 2 つ目の dir から提示する。
printf -- '---\nlayout: panel\n---\n' > "$MULTI/pages/q.md"
cp "$REFERENCES_DIR/panel.yaml" "$MULTI/theme-refs/panel.yaml"
STUB_THEME_REFERENCES="$MULTI/references,$MULTI/theme-refs" run_hook "multi-second" "$MULTI/pages/q.md" "$PLUGIN_ROOT"
CTX=$(ctx_of "$OUT")
if [ "$(printf '%s\n' "$CTX" | head -n 1)" = "$MULTI/theme-refs/panel.yaml:" ]; then
    pass "参照 dir が複数: 先頭に無い layout は 2 つ目の dir の yaml を提示"
else
    fail "参照 dir が複数: 2 つ目の dir の yaml が提示されない stdout='$OUT' stderr='$ERR'"
fi

# 10b2: pages/ 配下の md でない編集は、slide theme を起こさない。
THEME_LOG="$TMP/theme-spawn.log"
rm -f "$THEME_LOG"
STUB_THEME_LOG="$THEME_LOG" run_hook "non-pages-no-theme" "$TALK/README.md" "$PLUGIN_ROOT"
if [ -z "$OUT" ] && [ ! -e "$THEME_LOG" ]; then
    pass "pages 配下でない md: slide theme を起こさない"
else
    THEME_LOG_TEXT=$(cat "$THEME_LOG" 2>/dev/null)
    fail "pages 配下でない md: slide theme を起こした stdout='$OUT' log='${THEME_LOG_TEXT:-}'"
fi

# 10b3: slide theme が落ちたとき、stderr の先頭 1 行を trace に添える。
STUB_THEME_FAIL=crash STUB_THEME_STDERR="Node.js 24.22.1 以上が要ります" run_hook "theme-crash-stderr" "$STEP2" "$PLUGIN_ROOT"
if [ -z "$OUT" ] && echo "$ERR" | grep -q "stderr: Node.js 24.22.1 以上が要ります"; then
    pass "slide theme の stderr: 先頭 1 行を trace に添える（通知はしない）"
else
    fail "slide theme の stderr: trace に無い stdout='$OUT' stderr='$ERR'"
fi

# 10c: マーカーは slides.md + pages/。start.mjs だけの dir は talk-dir とみなさない。
OLD_MARKER="$TMP/old-marker"
mkdir -p "$OLD_MARKER/pages"
touch "$OLD_MARKER/start.mjs"
printf -- '---\nlayout: plain\n---\n' > "$OLD_MARKER/pages/a.md"
run_hook "old-marker" "$OLD_MARKER/pages/a.md" "$PLUGIN_ROOT"
assert_silent "start.mjs だけの dir" "talk-dir マーカー (slides.md + pages/)"

# --- ガードレール: 全分岐で stdout が「空または妥当な JSON」 ---
if [ -z "$BAD_STDOUT" ]; then
    pass "ガードレール: 全分岐の stdout が空または妥当な JSON"
else
    fail "ガードレール: stdout が非 JSON の分岐がある: $BAD_STDOUT"
fi

echo ""
echo "===== summary: PASS=$PASS FAIL=$FAIL ====="
[ $FAIL -eq 0 ]
