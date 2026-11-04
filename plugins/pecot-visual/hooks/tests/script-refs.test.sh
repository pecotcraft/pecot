#!/bin/bash
# hooks スクリプト（エントリポイント + lib 配下）と hooks 設定 command の `.sh` 参照が、実在することを確かめる。
# #870 が起点で、pecot 側 #842 / #852 / #864 の参照実在ガードを pecotv へ横展開したもの。
# 参照切れ（削除・改名）が、実行時の fail-open ではなく、テストの fail として露見する状態にする。
#
# 残存リスク（本テストが pass しても保証しない範囲）:
# - 静的な pass は、runtime の 3 段解決が成功することを含意しない。
#   3 段解決は、PLUGIN_HOOKS > CLAUDE_PLUGIN_ROOT > SCRIPT_DIR 逆算の順。
# - 行末コメントの切り落としは、「語頭の `#`」だけを対象とする（`s/[[:space:]]#.*$//`）。
#   bash パラメータ展開の `#` は、直前が空白でないため切り落とされない。
#   例は `${ROOT#*/…}` 等で、plugin-update-notice.sh / eslint-check.sh に実在する。
#   同一行に並ぶ実参照も、抽出対象に残る。
# - `_HOOKS_ROOT` / `HOOKS_ROOT` のような条件分岐代入の変数は、参照トークンに現れない。
#   そのため確認の対象外になる。参照側から基底を逆引きする方式による。
#   これらを基底とする `.sh` 参照が将来追加された場合は、未知の基底として未解決 fail に倒れる。
#
# `set -e` は使わない。
# パイプ末尾の grep がマッチ 0 件で rc 1 を返し、即死するためだ。
# 参照 0 件のスクリプトが実在する。
# 既存の pecotv hooks テストと同じ `set -u` だけを使う。

# 本テストは `$SCRIPT_DIR` 等を「展開せずリテラル文字列として」扱うのが目的のため、
# 単一引用符内の `$` は全て意図的（SC2016 はファイル全域で抑止する）。
# shellcheck disable=SC2016

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_ROOT="$(cd "$HOOKS_DIR/.." && pwd)"

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

# 参照トークンの基底プレフィックス。case パターン・${var#...} の両方で使うため
# 変数に置く（リテラルを直接書くと引用の取り扱いが読みにくくなる）。
PFX_PLUGIN_BRACE='${CLAUDE_PLUGIN_ROOT}/'
PFX_PLUGIN_PLAIN='$CLAUDE_PLUGIN_ROOT/'
PFX_PARENT='${SCRIPT_DIR%/*}/'
PFX_SCRIPT_BRACE='${SCRIPT_DIR}/'
PFX_SCRIPT_PLAIN='$SCRIPT_DIR/'
PFX_LIB_BRACE='${LIB_DIR}/'
PFX_LIB_PLAIN='$LIB_DIR/'

# --- `.sh` / `.mjs` 参照トークンの抽出 ---
# 本番列挙とセルフテストが共有する、唯一の実装。
# 方式は、「語を欲張って取り、`.sh` / `.mjs` で終わらない語を捨てる」。
# GNU grep の ERE では、PCRE の否定先読みが使えないためだ。
# `foo.shellcheckrc` 等は、この篩で落ちる。
# bracket expression は単一引用符で囲む（二重引用符では `$` `{` `}` が展開されて
# 文字クラスが静かに変質する）。日本語コメント混在のため LC_ALL=C を明示する。
#
# `.mjs` を含めるのは hook が起動する node ヘルパー（layout-conventions.mjs）を
# 参照実在ガードの対象にするため。ただし `start.mjs` は除外する。これは利用者の
# talk-dir を判別するマーカーのファイル名であって plugin 内の資産ではなく、
# 実在するかどうかは実行時にしか決まらない（静的に解決できる基底を持たない）。
extract_sh_tokens() {
    LC_ALL=C sed -E -e '/^[[:space:]]*#/d' -e 's/[[:space:]]#.*$//' \
        | LC_ALL=C grep -oE '[A-Za-z0-9._/${}%*-]*\.(sh|mjs)[A-Za-z0-9_.-]*' \
        | LC_ALL=C grep -E '\.(sh|mjs)$' \
        | LC_ALL=C grep -vE '(^|/)start\.mjs$'
}

# ファイル内の `LIB_DIR="$SCRIPT_DIR/<subdir>"` 代入から LIB_DIR を解決する。
# 代入行がちょうど 1 件でない場合・SCRIPT_DIR 起点でない場合は空を返す（未解決扱い）。
resolve_lib_dir() {
    local file="$1" script_dir="$2"
    local count line val
    count=$(LC_ALL=C grep -cE '^[[:space:]]*LIB_DIR=' "$file")
    [ "$count" = "1" ] || return 0
    line=$(LC_ALL=C grep -E '^[[:space:]]*LIB_DIR=' "$file")
    val=$(printf '%s\n' "$line" | LC_ALL=C sed -E 's/^[[:space:]]*LIB_DIR=//; s/^"//; s/"[[:space:]]*$//')
    if [ "${val#"$PFX_SCRIPT_PLAIN"}" != "$val" ]; then
        printf '%s/%s\n' "$script_dir" "${val#"$PFX_SCRIPT_PLAIN"}"
    elif [ "${val#"$PFX_SCRIPT_BRACE"}" != "$val" ]; then
        printf '%s/%s\n' "$script_dir" "${val#"$PFX_SCRIPT_BRACE"}"
    fi
}

# 1 スクリプトの `.sh` 参照を走査し、1 トークン 1 行で
# `<OK|MISSING|UNRESOLVED><TAB><トークン><TAB><解決先>` を出力する。
# 変数解決は、参照に現れた基底だけを逆引きする方式で、既知イディオム以外はすべて UNRESOLVED（fail-closed）。
# 裸パス・未知変数・`%/*` 以外の `%` 修飾も、UNRESOLVED になる。
scan_file() {
    local file="$1" plugin_root="$2"
    local script_dir lib_dir has_script_dir tok base rest resolved status
    script_dir="$(cd "$(dirname "$file")" && pwd)"
    lib_dir="$(resolve_lib_dir "$file" "$script_dir")"
    # SCRIPT_DIR 起点の参照は、当該ファイル内に SCRIPT_DIR の代入があることを要求する。
    # `$0` 形・`${BASH_SOURCE[0]}` 形のどちらでもよい。
    # 外部から与えられた SCRIPT_DIR へ暗黙に依存する参照を、通さないためだ。
    if LC_ALL=C grep -qE '^[[:space:]]*SCRIPT_DIR=' "$file"; then
        has_script_dir=1
    else
        has_script_dir=0
    fi

    while IFS= read -r tok; do
        [ -n "$tok" ] || continue
        base=""
        rest=""
        if [ "${tok#"$PFX_PLUGIN_BRACE"}" != "$tok" ]; then
            base="$plugin_root"
            rest="${tok#"$PFX_PLUGIN_BRACE"}"
        elif [ "${tok#"$PFX_PLUGIN_PLAIN"}" != "$tok" ]; then
            base="$plugin_root"
            rest="${tok#"$PFX_PLUGIN_PLAIN"}"
        elif [ "${tok#"$PFX_PARENT"}" != "$tok" ] && [ "$has_script_dir" -eq 1 ]; then
            base="${script_dir%/*}"
            rest="${tok#"$PFX_PARENT"}"
        elif [ "${tok#"$PFX_SCRIPT_BRACE"}" != "$tok" ] && [ "$has_script_dir" -eq 1 ]; then
            base="$script_dir"
            rest="${tok#"$PFX_SCRIPT_BRACE"}"
        elif [ "${tok#"$PFX_SCRIPT_PLAIN"}" != "$tok" ] && [ "$has_script_dir" -eq 1 ]; then
            base="$script_dir"
            rest="${tok#"$PFX_SCRIPT_PLAIN"}"
        elif [ "${tok#"$PFX_LIB_BRACE"}" != "$tok" ] && [ -n "$lib_dir" ]; then
            base="$lib_dir"
            rest="${tok#"$PFX_LIB_BRACE"}"
        elif [ "${tok#"$PFX_LIB_PLAIN"}" != "$tok" ] && [ -n "$lib_dir" ]; then
            base="$lib_dir"
            rest="${tok#"$PFX_LIB_PLAIN"}"
        fi

        if [ -z "$base" ] || [ -z "$rest" ]; then
            printf 'UNRESOLVED\t%s\t\n' "$tok"
            continue
        fi
        # 解決後に変数展開・glob が残っていれば、未解決として扱う。
        # F-04: `*` `%` を取りこぼすと、glob 参照を「実在しない」と誤判定する。
        case "$rest" in
            *'$'* | *'{'* | *'}'* | *'*'* | *'%'*)
                printf 'UNRESOLVED\t%s\t\n' "$tok"
                continue
                ;;
        esac
        resolved="$base/$rest"
        if [ -f "$resolved" ]; then
            status="OK"
        else
            status="MISSING"
        fi
        printf '%s\t%s\t%s\n' "$status" "$tok" "$resolved"
    done < <(extract_sh_tokens < "$file")
}

# --- ケース1: ガード対象スクリプトの列挙 ---
TARGETS="$TMP/targets.txt"
{
    find "$HOOKS_DIR" -maxdepth 1 -type f -name '*.sh'
    find "$HOOKS_DIR/lib" -type f -name '*.sh' ! -path '*/tests/*'
} | LC_ALL=C sort > "$TARGETS"
TARGET_COUNT=$(wc -l < "$TARGETS")
TESTS_HITS=$(LC_ALL=C grep -c '/tests/' "$TARGETS")

if [ "$TESTS_HITS" -eq 0 ] && [ "$TARGET_COUNT" -ge 10 ]; then
    pass "ガード対象を $TARGET_COUNT 本列挙（tests/ 配下 0 件）"
else
    fail "列挙が崩れている: count=$TARGET_COUNT tests_hits=$TESTS_HITS"
fi

# --- ケース2: 抽出トークン全件が解決でき、解決先が実在する ---
REF_OK=0
REF_BAD=0
ENTRY_REFS="$TMP/entry-refs.txt"
: > "$ENTRY_REFS"
while IFS= read -r target; do
    REL="${target#"$HOOKS_DIR"/}"
    FILE_OK=0
    while IFS=$'\t' read -r st tok resolved; do
        case "$st" in
            OK)
                REF_OK=$((REF_OK + 1))
                FILE_OK=$((FILE_OK + 1))
                ;;
            MISSING)
                fail "$REL: 参照先が存在しない: $tok -> $resolved"
                REF_BAD=$((REF_BAD + 1))
                ;;
            *)
                fail "$REL: 参照を解決できない（未知の基底・裸パス・未対応の変数修飾）: $tok"
                REF_BAD=$((REF_BAD + 1))
                ;;
        esac
    done < <(scan_file "$target" "$PLUGIN_ROOT")
    # hooks/ 直下のエントリポイントのみ記録する（lib/ 配下は対象外）。
    case "$REL" in
        */*) ;;
        *) printf '%s\t%s\n' "$REL" "$FILE_OK" >> "$ENTRY_REFS" ;;
    esac
done < "$TARGETS"

if [ "$REF_BAD" -eq 0 ]; then
    pass "スクリプト内の .sh 参照 $REF_OK 件すべてが解決でき実在する"
fi

# --- ケース3: 解決済み参照の出現総数の下限（抽出器の空振り検知） ---
# multiset 基準。distinct 基準にすると post-tool-use-{edit,write}.sh の
# 参照が同時に全滅しても検知できない。
if [ "$REF_OK" -ge 10 ]; then
    pass "解決済み参照の出現総数が下限を満たす（$REF_OK >= 10）"
else
    fail "解決済み参照の出現総数が少なすぎる（$REF_OK 件、下限は 10 件）。抽出器の空振りが原因の可能性がある"
fi

# --- ケース3b: エントリポイント各本が最低1件の解決済み参照を持つ ---
# ケース3の総数下限だけでは、他ファイルの参照増で1本の参照全滅を隠せてしまう
# （F-03）。ファイル単位で 0 件を検知する。
ENTRY_COUNT=$(wc -l < "$ENTRY_REFS")
ENTRY_BAD=0
while IFS=$'\t' read -r rel cnt; do
    if [ "$cnt" -lt 1 ]; then
        fail "$rel: 解決済み参照が 0 件（エントリポイントの参照全滅を検知）"
        ENTRY_BAD=$((ENTRY_BAD + 1))
    fi
done < "$ENTRY_REFS"

if [ "$ENTRY_BAD" -eq 0 ] && [ "$ENTRY_COUNT" -eq 5 ]; then
    pass "hooks/ 直下のエントリポイント全 $ENTRY_COUNT 本が最低1件の解決済み参照を持つ"
elif [ "$ENTRY_COUNT" -ne 5 ]; then
    fail "hooks/ 直下のエントリポイント数が想定と違う（$ENTRY_COUNT 本、想定は 5 本）"
fi

# --- ケース4: hooks 設定（hooks*.json）の command ---
if ! command -v jq >/dev/null 2>&1; then
    fail "jq が無いため hooks 設定 command をチェックできない（skip は許容しない）"
else
    CFG_LIST="$TMP/hooks-configs.txt"
    # Claude 向けの hooks/hooks.json と、Copilot 向け（Agent Plugins 1.0 形式）の com.github.copilot/hooks/hooks.json
    {
        find "$HOOKS_DIR" -maxdepth 1 -type f -name 'hooks*.json'
        find "$PLUGIN_ROOT/com.github.copilot/hooks" -maxdepth 1 -type f -name 'hooks*.json' 2>/dev/null
    } | LC_ALL=C sort > "$CFG_LIST"
    CFG_COUNT=$(wc -l < "$CFG_LIST")
    if [ "$CFG_COUNT" -lt 2 ]; then
        fail "hooks 設定ファイルの列挙が想定より少ない（$CFG_COUNT < 2）"
    fi

    while IFS= read -r CFG_PATH; do
        CFG="${CFG_PATH#"$PLUGIN_ROOT"/}"
        WANT_CMDS=5
        CMDS="$TMP/cmds-${CFG//\//_}.txt"
                if ! jq -r '.hooks | to_entries[] | .value[] | .hooks[] | .command' \
            "$CFG_PATH" > "$CMDS" 2>/dev/null; then
            fail "$CFG: jq による command 抽出に失敗した"
            continue
        fi
        CMD_COUNT=$(wc -l < "$CMDS")
        if [ "$CMD_COUNT" -eq "$WANT_CMDS" ]; then
            pass "$CFG: command を $WANT_CMDS 件抽出"
        else
            fail "$CFG: command 件数が想定と違う（$CMD_COUNT 件、想定は $WANT_CMDS 件）"
        fi

        CMD_BAD=0
        while IFS= read -r cmd; do
            [ -n "$cmd" ] || continue
            # command は `"\"${CLAUDE_PLUGIN_ROOT}\"/hooks/x.sh"` のように変数をクォートする（#1229）。
            # クォートの有無は比較の対象外にして、取り除いてから抽出する
            toks="$(printf '%s\n' "${cmd//\"/}" | extract_sh_tokens)"
            if [ -z "$toks" ]; then
                fail "$CFG: command に .sh 参照が無い: $cmd"
                CMD_BAD=$((CMD_BAD + 1))
                continue
            fi
            while IFS= read -r tok; do
                [ -n "$tok" ] || continue
                rest="${tok#"$PFX_PLUGIN_BRACE"}"
                if [ "$rest" = "$tok" ]; then
                    fail "$CFG: command が \${CLAUDE_PLUGIN_ROOT}/ 起点でない: $tok"
                    CMD_BAD=$((CMD_BAD + 1))
                    continue
                fi
                case "$rest" in
                    hooks/*) ;;
                    *)
                        fail "$CFG: command が hooks/ 配下でない: $tok"
                        CMD_BAD=$((CMD_BAD + 1))
                        continue
                        ;;
                esac
                case "${rest#hooks/}" in
                    */*)
                        fail "$CFG: command が hooks/ 直下のエントリポイントでない: $tok"
                        CMD_BAD=$((CMD_BAD + 1))
                        continue
                        ;;
                esac
                if [ ! -f "$PLUGIN_ROOT/$rest" ]; then
                    fail "$CFG: command の参照先が存在しない: $tok -> $PLUGIN_ROOT/$rest"
                    CMD_BAD=$((CMD_BAD + 1))
                fi
            done <<< "$toks"
        done < "$CMDS"

        if [ "$CMD_BAD" -eq 0 ]; then
            pass "$CFG: command 全件が \${CLAUDE_PLUGIN_ROOT}/hooks/ 直下の実在エントリポイント"
        fi
    done < "$CFG_LIST"
fi

# --- セルフテスト: 合成スクリプトで、fail の流れと解決の流れを固定する ---
# 本番列挙と同一の scan_file を通す（恒真化防止）。
SELF="$TMP/self"
mkdir -p "$SELF/sub" "$SELF/libsub"
printf '#!/bin/bash\n' > "$SELF/real-target.sh"
printf '#!/bin/bash\n' > "$SELF/up-target.sh"
printf '#!/bin/bash\n' > "$SELF/libsub/lib-target.sh"

self_status() {
    scan_file "$1" "$SELF" | LC_ALL=C awk -F'\t' -v t="$2" '$2 == t { print $1 }'
}

assert_status() {
    local label="$1" script="$2" tok="$3" want="$4" got
    got=$(self_status "$script" "$tok")
    if [ "$got" = "$want" ]; then
        pass "セルフテスト: $label"
    else
        fail "セルフテスト: $label（期待 $want / 実際 '${got:-（出力なし）}'）"
    fi
}

cat > "$SELF/s-missing.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/does-not-exist.sh"
EOF
assert_status "実在しない .sh 参照は MISSING" \
    "$SELF/s-missing.sh" '$SCRIPT_DIR/does-not-exist.sh' MISSING

cat > "$SELF/s-unknown-var.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$FOO_DIR/probe.sh"
EOF
assert_status "未知の変数プレフィックスは UNRESOLVED" \
    "$SELF/s-unknown-var.sh" '$FOO_DIR/probe.sh' UNRESOLVED

cat > "$SELF/s-bare.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash lib/core/probe.sh
EOF
assert_status "変数プレフィックスなしの裸参照は UNRESOLVED" \
    "$SELF/s-bare.sh" 'lib/core/probe.sh' UNRESOLVED

cat > "$SELF/s-dollar0.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/real-target.sh"
EOF
assert_status '$0 形の SCRIPT_DIR 代入で $SCRIPT_DIR 参照が解決される' \
    "$SELF/s-dollar0.sh" '$SCRIPT_DIR/real-target.sh' OK

cat > "$SELF/s-bash-source.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/real-target.sh"
EOF
assert_status '${BASH_SOURCE[0]} 形の SCRIPT_DIR 代入でも解決される' \
    "$SELF/s-bash-source.sh" '${SCRIPT_DIR}/real-target.sh' OK

cat > "$SELF/sub/s-parent.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/up-target.sh"
EOF
assert_status '${SCRIPT_DIR%/*} は 1 段上のディレクトリ起点で解決される' \
    "$SELF/sub/s-parent.sh" '${SCRIPT_DIR%/*}/up-target.sh' OK

cat > "$SELF/s-lib-dup.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/a"
LIB_DIR="$SCRIPT_DIR/b"
"$LIB_DIR/real-target.sh"
EOF
assert_status 'LIB_DIR 代入がちょうど 1 件でなければ UNRESOLVED' \
    "$SELF/s-lib-dup.sh" '$LIB_DIR/real-target.sh' UNRESOLVED

cat > "$SELF/s-plugin-root.sh" <<'EOF'
#!/bin/bash
"${CLAUDE_PLUGIN_ROOT}/real-target.sh"
EOF
assert_status '${CLAUDE_PLUGIN_ROOT}/ 起点の参照は plugin_root から解決される' \
    "$SELF/s-plugin-root.sh" '${CLAUDE_PLUGIN_ROOT}/real-target.sh' OK

cat > "$SELF/s-lib-single.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/libsub"
"$LIB_DIR/lib-target.sh"
EOF
assert_status 'LIB_DIR 代入が 1 件のとき $LIB_DIR/ 参照が解決される' \
    "$SELF/s-lib-single.sh" '$LIB_DIR/lib-target.sh' OK

cat > "$SELF/s-no-script-dir.sh" <<'EOF'
#!/bin/bash
"$SCRIPT_DIR/real-target.sh"
EOF
assert_status 'SCRIPT_DIR 代入が無いファイルの $SCRIPT_DIR 参照は UNRESOLVED' \
    "$SELF/s-no-script-dir.sh" '$SCRIPT_DIR/real-target.sh' UNRESOLVED

printf '#!/usr/bin/env node\n' > "$SELF/real-helper.mjs"

cat > "$SELF/s-mjs-ok.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/real-helper.mjs"
EOF
assert_status '.mjs 参照も実在チェックの対象になる' \
    "$SELF/s-mjs-ok.sh" '$SCRIPT_DIR/real-helper.mjs' OK

cat > "$SELF/s-mjs-missing.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/no-such-helper.mjs"
EOF
assert_status '実在しない .mjs 参照は MISSING' \
    "$SELF/s-mjs-missing.sh" '$SCRIPT_DIR/no-such-helper.mjs' MISSING

# talk-dir マーカーの start.mjs は plugin 内の資産ではないので抽出対象から外す。
# 除外が外れると、基底を解決できない裸トークンとして UNRESOLVED になる。
# その結果、talk-dir 探索を持つ hook 3 本が一斉に fail する。
cat > "$SELF/s-marker.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/start.mjs" ]; then
    echo "talk-dir マーカー (start.mjs) を検出"
fi
EOF
if [ -z "$(extract_sh_tokens < "$SELF/s-marker.sh")" ]; then
    pass "セルフテスト: talk-dir マーカーの start.mjs は抽出されない"
else
    MSG_DETAIL_1="$(extract_sh_tokens < "$SELF/s-marker.sh" | tr '\n' ' ')"
    fail "セルフテスト: start.mjs が抽出されている: $MSG_DETAIL_1"
fi

cat > "$SELF/s-percent-other.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/lib/*}/x.sh"
EOF
assert_status '${SCRIPT_DIR%/*} 以外の % 修飾は UNRESOLVED' \
    "$SELF/s-percent-other.sh" '${SCRIPT_DIR%/lib/*}/x.sh' UNRESOLVED

echo
echo "==================================="
echo "Passed: $PASS / Failed: $FAIL"
echo "==================================="
[ $FAIL -eq 0 ]
