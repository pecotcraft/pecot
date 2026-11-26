#!/bin/bash
# hooks スクリプト（エントリポイント + lib 配下）と hooks 設定 command の `.sh` 参照が実在することを確かめる（#870）。
# 実行時の 3 段解決が通ることまでは保証しない。set -e は、grep の 0 件（rc 1）で止まるので使わない。

# 本テストは `$SCRIPT_DIR` 等を「展開せずリテラル文字列として」扱うのが目的のため、
# 単一引用符内の `$` は全て意図的（SC2016 はファイル全域で抑止する）。
# shellcheck disable=SC2016

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
HOOKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_ROOT="$(cd "$HOOKS_DIR/.." && pwd)"

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
# 語を欲張って取り、`.sh` / `.mjs` で終わらない語を捨てる（ERE は否定先読みを使えない）。日本語のため LC_ALL=C。
# `start.mjs` は利用者の talk-dir のマーカーで、plugin 内の資産ではないので外す。
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

# 1 スクリプトの `.sh` 参照を `<OK|MISSING|UNRESOLVED><TAB><トークン><TAB><解決先>` で 1 行ずつ出す。
# 参照に現れた基底だけを逆引きし、既知のイディオム以外はすべて UNRESOLVED にする（fail-closed）。
scan_file() {
    local file="$1" plugin_root="$2"
    local script_dir lib_dir has_script_dir tok base rest resolved status
    script_dir="$(cd "$(dirname "$file")" && pwd)"
    lib_dir="$(resolve_lib_dir "$file" "$script_dir")"
    # SCRIPT_DIR 起点の参照は、ファイル内に SCRIPT_DIR の代入（$0 形・BASH_SOURCE 形）があるときだけ解決する。
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
    bt_pass "ガード対象を 10 本以上列挙（tests/ 配下 0 件）"
else
    bt_fail "ガード対象を 10 本以上列挙（tests/ 配下 0 件）" "列挙が崩れている: count=$TARGET_COUNT tests_hits=$TESTS_HITS"
fi

# --- ケース2: 抽出トークン全件が解決でき、解決先が実在する ---
REF_OK=0
REF_BAD=""
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
                REF_BAD+=$'\n'"$REL: 参照先が存在しない: $tok -> $resolved"
                ;;
            *)
                REF_BAD+=$'\n'"$REL: 参照を解決できない（未知の基底・裸パス・未対応の変数修飾）: $tok"
                ;;
        esac
    done < <(scan_file "$target" "$PLUGIN_ROOT")
    # hooks/ 直下のエントリポイントのみ記録する（lib/ 配下は対象外）。
    case "$REL" in
        */*) ;;
        *) printf '%s\t%s\n' "$REL" "$FILE_OK" >> "$ENTRY_REFS" ;;
    esac
done < "$TARGETS"

bt_eq "スクリプト内の .sh 参照すべてが解決でき実在する" "" "$REF_BAD"

# --- ケース3: 解決済み参照の出現総数の下限（抽出器の空振り検知） ---
# multiset 基準。distinct 基準にすると post-tool-use-{edit,write}.sh の参照が同時に全滅しても検知できない。
if [ "$REF_OK" -ge 10 ]; then
    bt_pass "解決済み参照の出現総数が下限（10 件）を満たす"
else
    bt_fail "解決済み参照の出現総数が下限（10 件）を満たす" "$REF_OK 件しかない。抽出器の空振りが原因の可能性がある"
fi

# --- ケース3b: エントリポイント各本が最低1件の解決済み参照を持つ ---
# 総数の下限だけでは、他ファイルの参照増で 1 本の参照全滅を隠せる（F-03）。ファイル単位で 0 件を検知する。
ENTRY_COUNT=$(wc -l < "$ENTRY_REFS")
ENTRY_BAD=""
while IFS=$'\t' read -r rel cnt; do
    if [ "$cnt" -lt 1 ]; then
        ENTRY_BAD+=$'\n'"$rel: 解決済み参照が 0 件（エントリポイントの参照全滅を検知）"
    fi
done < "$ENTRY_REFS"
if [ "$ENTRY_COUNT" -ne 5 ]; then
    ENTRY_BAD+=$'\n'"hooks/ 直下のエントリポイント数が想定と違う（$ENTRY_COUNT 本、想定は 5 本）"
fi
bt_eq "hooks/ 直下のエントリポイント全 5 本が最低1件の解決済み参照を持つ" "" "$ENTRY_BAD"

# --- ケース4: hooks 設定（hooks*.json）の command ---
if ! command -v jq >/dev/null 2>&1; then
    bt_fail "hooks 設定の command を確かめる" "jq が無いため確かめられない（skip は許容しない）"
else
    CFG_LIST="$TMP/hooks-configs.txt"
    # Claude 向けの hooks/hooks.json と、Copilot 向け（Agent Plugins 1.0 形式）の com.github.copilot/hooks/hooks.json
    {
        find "$HOOKS_DIR" -maxdepth 1 -type f -name 'hooks*.json'
        find "$PLUGIN_ROOT/com.github.copilot/hooks" -maxdepth 1 -type f -name 'hooks*.json' 2>/dev/null
    } | LC_ALL=C sort > "$CFG_LIST"
    CFG_COUNT=$(wc -l < "$CFG_LIST")
    if [ "$CFG_COUNT" -ge 2 ]; then
        bt_pass "hooks 設定ファイルを 2 本以上列挙"
    else
        bt_fail "hooks 設定ファイルを 2 本以上列挙" "列挙が想定より少ない（$CFG_COUNT < 2）"
    fi

    while IFS= read -r CFG_PATH; do
        CFG="${CFG_PATH#"$PLUGIN_ROOT"/}"
        WANT_CMDS=5
        CMDS="$TMP/cmds-${CFG//\//_}.txt"
        if ! jq -r '.hooks | to_entries[] | .value[] | .hooks[] | .command' \
            "$CFG_PATH" > "$CMDS" 2>/dev/null; then
            bt_fail "$CFG: command を $WANT_CMDS 件抽出" "jq による command 抽出に失敗した"
            continue
        fi
        CMD_COUNT=$(wc -l < "$CMDS")
        bt_eq "$CFG: command を $WANT_CMDS 件抽出" "$WANT_CMDS" "$CMD_COUNT"

        CMD_BAD=""
        while IFS= read -r cmd; do
            [ -n "$cmd" ] || continue
            # command は `"\"${CLAUDE_PLUGIN_ROOT}\"/hooks/x.sh"` のように変数をクォートする（#1229）。
            # クォートの有無は比較の対象外にして、取り除いてから抽出する
            toks="$(printf '%s\n' "${cmd//\"/}" | extract_sh_tokens)"
            if [ -z "$toks" ]; then
                CMD_BAD+=$'\n'"command に .sh 参照が無い: $cmd"
                continue
            fi
            while IFS= read -r tok; do
                [ -n "$tok" ] || continue
                rest="${tok#"$PFX_PLUGIN_BRACE"}"
                if [ "$rest" = "$tok" ]; then
                    CMD_BAD+=$'\n'"command が \${CLAUDE_PLUGIN_ROOT}/ 起点でない: $tok"
                    continue
                fi
                case "$rest" in
                    hooks/*) ;;
                    *)
                        CMD_BAD+=$'\n'"command が hooks/ 配下でない: $tok"
                        continue
                        ;;
                esac
                case "${rest#hooks/}" in
                    */*)
                        CMD_BAD+=$'\n'"command が hooks/ 直下のエントリポイントでない: $tok"
                        continue
                        ;;
                esac
                if [ ! -f "$PLUGIN_ROOT/$rest" ]; then
                    CMD_BAD+=$'\n'"command の参照先が存在しない: $tok -> $PLUGIN_ROOT/$rest"
                fi
            done <<< "$toks"
        done < "$CMDS"

        bt_eq "$CFG: command 全件が \${CLAUDE_PLUGIN_ROOT}/hooks/ 直下の実在エントリポイント" "" "$CMD_BAD"
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

expect_status() {
    local label="$1" script="$2" tok="$3" want="$4" got
    got=$(self_status "$script" "$tok")
    if [ "$got" = "$want" ]; then
        bt_pass "セルフテスト: $label"
    else
        bt_fail "セルフテスト: $label" "期待 $want / 実際 '${got:-（出力なし）}'"
    fi
}

cat > "$SELF/s-missing.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/does-not-exist.sh"
EOF
expect_status "実在しない .sh 参照は MISSING" \
    "$SELF/s-missing.sh" '$SCRIPT_DIR/does-not-exist.sh' MISSING

cat > "$SELF/s-unknown-var.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$FOO_DIR/probe.sh"
EOF
expect_status "未知の変数プレフィックスは UNRESOLVED" \
    "$SELF/s-unknown-var.sh" '$FOO_DIR/probe.sh' UNRESOLVED

cat > "$SELF/s-bare.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash lib/core/probe.sh
EOF
expect_status "変数プレフィックスなしの裸参照は UNRESOLVED" \
    "$SELF/s-bare.sh" 'lib/core/probe.sh' UNRESOLVED

cat > "$SELF/s-dollar0.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/real-target.sh"
EOF
expect_status '$0 形の SCRIPT_DIR 代入で $SCRIPT_DIR 参照が解決される' \
    "$SELF/s-dollar0.sh" '$SCRIPT_DIR/real-target.sh' OK

cat > "$SELF/s-bash-source.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/real-target.sh"
EOF
expect_status '${BASH_SOURCE[0]} 形の SCRIPT_DIR 代入でも解決される' \
    "$SELF/s-bash-source.sh" '${SCRIPT_DIR}/real-target.sh' OK

cat > "$SELF/sub/s-parent.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/up-target.sh"
EOF
expect_status '${SCRIPT_DIR%/*} は 1 段上のディレクトリ起点で解決される' \
    "$SELF/sub/s-parent.sh" '${SCRIPT_DIR%/*}/up-target.sh' OK

cat > "$SELF/s-lib-dup.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/a"
LIB_DIR="$SCRIPT_DIR/b"
"$LIB_DIR/real-target.sh"
EOF
expect_status 'LIB_DIR 代入がちょうど 1 件でなければ UNRESOLVED' \
    "$SELF/s-lib-dup.sh" '$LIB_DIR/real-target.sh' UNRESOLVED

cat > "$SELF/s-plugin-root.sh" <<'EOF'
#!/bin/bash
"${CLAUDE_PLUGIN_ROOT}/real-target.sh"
EOF
expect_status '${CLAUDE_PLUGIN_ROOT}/ 起点の参照は plugin_root から解決される' \
    "$SELF/s-plugin-root.sh" '${CLAUDE_PLUGIN_ROOT}/real-target.sh' OK

cat > "$SELF/s-lib-single.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/libsub"
"$LIB_DIR/lib-target.sh"
EOF
expect_status 'LIB_DIR 代入が 1 件のとき $LIB_DIR/ 参照が解決される' \
    "$SELF/s-lib-single.sh" '$LIB_DIR/lib-target.sh' OK

cat > "$SELF/s-no-script-dir.sh" <<'EOF'
#!/bin/bash
"$SCRIPT_DIR/real-target.sh"
EOF
expect_status 'SCRIPT_DIR 代入が無いファイルの $SCRIPT_DIR 参照は UNRESOLVED' \
    "$SELF/s-no-script-dir.sh" '$SCRIPT_DIR/real-target.sh' UNRESOLVED

printf '#!/usr/bin/env node\n' > "$SELF/real-helper.mjs"

cat > "$SELF/s-mjs-ok.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/real-helper.mjs"
EOF
expect_status '.mjs 参照も実在チェックの対象になる' \
    "$SELF/s-mjs-ok.sh" '$SCRIPT_DIR/real-helper.mjs' OK

cat > "$SELF/s-mjs-missing.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/no-such-helper.mjs"
EOF
expect_status '実在しない .mjs 参照は MISSING' \
    "$SELF/s-mjs-missing.sh" '$SCRIPT_DIR/no-such-helper.mjs' MISSING

# talk-dir マーカーの start.mjs は plugin 内の資産ではないので抽出対象から外す。
# 除外が外れると裸トークンとして UNRESOLVED になり、talk-dir 探索を持つ hook 3 本が一斉に失敗する。
cat > "$SELF/s-marker.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/start.mjs" ]; then
    echo "talk-dir マーカー (start.mjs) を検出"
fi
EOF
if [ -z "$(extract_sh_tokens < "$SELF/s-marker.sh")" ]; then
    bt_pass "セルフテスト: talk-dir マーカーの start.mjs は抽出されない"
else
    MSG_DETAIL_1="$(extract_sh_tokens < "$SELF/s-marker.sh" | tr '\n' ' ')"
    bt_fail "セルフテスト: talk-dir マーカーの start.mjs は抽出されない" "start.mjs が抽出されている: $MSG_DETAIL_1"
fi

cat > "$SELF/s-percent-other.sh" <<'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/lib/*}/x.sh"
EOF
expect_status '${SCRIPT_DIR%/*} 以外の % 修飾は UNRESOLVED' \
    "$SELF/s-percent-other.sh" '${SCRIPT_DIR%/lib/*}/x.sh' UNRESOLVED

bt_finish
