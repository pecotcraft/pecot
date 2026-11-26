#!/bin/bash
# plugin-update-notice.sh の単体テスト。installed が marketplace clone より古いときだけ更新の案内を出すことを、
# Claude と Copilot の両レイアウトで確かめる。フィクスチャは一時 dir の中で閉じ、実環境の ~/.claude を見ない。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
HOOK="$SCRIPT_DIR/../lib/session-start/plugin-update-notice.sh"
SESSION_START="$SCRIPT_DIR/../session-start.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 親リポの GIT_* と実行環境の CLAUDE_CONFIG_DIR を外して起動する（session-start.test.sh と同形）。
# CLAUDE_CONFIG_DIR は、設定するケースだけ引数で渡す。
_GIT_ISOLATE=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u CLAUDE_CONFIG_DIR)
# フックを GIT_* 隔離下で起動する。VAR=val を引数前置きで渡せる（例: _run CLAUDE_PLUGIN_ROOT=...）。
_run() {
    "${_GIT_ISOLATE[@]}" "$@" bash "$HOOK"
}
_run_session() {
    "${_GIT_ISOLATE[@]}" "$@" bash "$SESSION_START"
}

# Claude レイアウトのフィクスチャを作り、CLAUDE_PLUGIN_ROOT として使うパスを出す。
# 引数: $1=ルート dir, $2=installed, $3=latest（空なら clone 側 plugin.json を作らない）。
make_claude_fixture() {
    local base="$1" installed="$2" latest="$3"
    local root="$base/.claude/plugins/cache/pecot/pecot-v/$installed"
    local mp="$base/.claude/plugins/marketplaces/pecot/plugins/pecot-visual/.claude-plugin"
    local mpjson="$base/.claude/plugins/marketplaces/pecot/.claude-plugin"
    mkdir -p "$root/.claude-plugin"
    printf '{"version":"%s"}\n' "$installed" > "$root/.claude-plugin/plugin.json"
    printf '{"pecot":{"installLocation":"%s/.claude/plugins/marketplaces/pecot"}}\n' "$base" \
        > "$base/.claude/plugins/known_marketplaces.json"
    if [ -n "$latest" ]; then
        mkdir -p "$mp" "$mpjson"
        printf '{"version":"%s"}\n' "$latest" > "$mp/plugin.json"
        # dir 名（pecot-visual）とプラグイン名（pecot-v）は一致しない。source が橋渡しする
        printf '{"plugins":[{"name":"pecot-v","source":"./plugins/pecot-visual"}]}\n' > "$mpjson/marketplace.json"
    fi
    printf '%s' "$root"
}

# Copilot レイアウトのフィクスチャ（Claude Code 側の clone を使う形）。
make_copilot_fixture() {
    local base="$1" installed="$2" latest="$3"
    local root="$base/.copilot/installed-plugins/pecot/pecot-v"
    local mp="$base/.claude/plugins/marketplaces/pecot/plugins/pecot-visual/.claude-plugin"
    local mpjson="$base/.claude/plugins/marketplaces/pecot/.claude-plugin"
    mkdir -p "$root/.claude-plugin" "$mp" "$mpjson"
    printf '{"version":"%s"}\n' "$installed" > "$root/.claude-plugin/plugin.json"
    printf '{"version":"%s"}\n' "$latest" > "$mp/plugin.json"
    printf '{"plugins":[{"name":"pecot-v","source":"./plugins/pecot-visual"}]}\n' > "$mpjson/marketplace.json"
    printf '%s' "$root"
}

# --- ケース1: Claude 形 + 古い installed → 更新案内が出る ---
ROOT1=$(make_claude_fixture "$TMP/c1" "0.29.0" "0.30.0")
OUT1=$(_run CLAUDE_PLUGIN_ROOT="$ROOT1")
EXIT=$?
if [ $EXIT -eq 0 ] \
    && printf '%s' "$OUT1" | head -n 1 | grep -q '^note: plugin update available: ' \
    && printf '%s' "$OUT1" | grep -q 'claude plugin update pecot-v@pecot' \
    && printf '%s' "$OUT1" | grep -q 'installed: 0.29.0' \
    && printf '%s' "$OUT1" | grep -q 'pecot-v 0.30.0'; then
    bt_pass "Claude 形 + installed 古い: claude plugin update と両バージョンが含まれる"
else
    bt_fail "Claude 形 + installed 古い: claude plugin update と両バージョンが含まれる" "exit=$EXIT out='$OUT1'"
fi

# --- ケース2: バージョン一致 → 無出力 ---
ROOT2=$(make_claude_fixture "$TMP/c2" "0.30.0" "0.30.0")
OUT2=$(_run CLAUDE_PLUGIN_ROOT="$ROOT2")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT2" ]; then
    bt_pass "一致: 無出力 exit 0"
else
    bt_fail "一致: 無出力 exit 0" "exit=$EXIT out='$OUT2'"
fi

# --- ケース3: Copilot 形 + installed が古い → copilot plugin update ---
ROOT3=$(make_copilot_fixture "$TMP/c3" "0.29.0" "0.30.0")
OUT3=$(_run CLAUDE_PLUGIN_ROOT="$ROOT3")
EXIT=$?
if [ $EXIT -eq 0 ] \
    && printf '%s' "$OUT3" | grep -q 'copilot plugin update pecot-v@pecot'; then
    bt_pass "Copilot 形 + installed 古い: copilot plugin update pecot-v@pecot"
else
    bt_fail "Copilot 形 + installed 古い: copilot plugin update pecot-v@pecot" "exit=$EXIT out='$OUT3'"
fi

# --- ケース4: dev パス形（どちらのレイアウトにも合致しない）→ skip 無出力 ---
DEVROOT="$TMP/dev/plugins/pecot-visual"
mkdir -p "$DEVROOT/.claude-plugin"
printf '{"version":"0.29.0"}\n' > "$DEVROOT/.claude-plugin/plugin.json"
OUT4=$(_run CLAUDE_PLUGIN_ROOT="$DEVROOT")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT4" ]; then
    bt_pass "dev パス形: 非対象レイアウトは無出力 exit 0"
else
    bt_fail "dev パス形: 非対象レイアウトは無出力 exit 0" "exit=$EXIT out='$OUT4'"
fi

# --- ケース5: hooks-config で無効化 → 無出力 ---
ROOT5=$(make_claude_fixture "$TMP/c5" "0.29.0" "0.30.0")
HOOKS_CFG5="$TMP/hooks-config-5.json"
printf '{"plugin-update-notice": false}\n' > "$HOOKS_CFG5"
OUT5=$(_run CLAUDE_PLUGIN_ROOT="$ROOT5" PECOTV_HOOKS_CONFIG_PATH="$HOOKS_CFG5")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT5" ]; then
    bt_pass "hooks-config 無効化: installed が古くても無出力 exit 0"
else
    bt_fail "hooks-config 無効化: installed が古くても無出力 exit 0" "exit=$EXIT out='$OUT5'"
fi

# --- ケース6: 配線 ---
# .pecotv 不在の project で session-start.sh 全体を起動する。
# plugin-update-notice は CLAUDE_PLUGIN_ROOT だけを見るので、通知は出る。
ROOT6=$(make_claude_fixture "$TMP/c6" "0.29.0" "0.30.0")
PROJ6="$TMP/proj6"
mkdir -p "$PROJ6"
OUT6=$(_run_session CLAUDE_PROJECT_DIR="$PROJ6" CLAUDE_PLUGIN_ROOT="$ROOT6")
EXIT=$?
if [ $EXIT -eq 0 ] \
    && printf '%s' "$OUT6" | grep -q 'claude plugin update pecot-v@pecot' \
    && [ ! -e "$PROJ6/.pecotv" ]; then
    bt_pass "配線: session-start.sh 経由で更新案内が stdout に出る（.pecotv 不在）"
else
    CREATED=no
    [ -e "$PROJ6/.pecotv" ] && CREATED=yes
    bt_fail "配線: session-start.sh 経由で更新案内が stdout に出る（.pecotv 不在）" "exit=$EXIT created=$CREATED out='$OUT6'"
fi

# --- ケース7: installed が新しい（逆方向レース）→ 無出力 ---
ROOT7=$(make_claude_fixture "$TMP/c7" "0.30.0" "0.20.0")
OUT7=$(_run CLAUDE_PLUGIN_ROOT="$ROOT7")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT7" ]; then
    bt_pass "installed が新しい（clone 未 pull レース）: 無出力 exit 0"
else
    bt_fail "installed が新しい（clone 未 pull レース）: 無出力 exit 0" "exit=$EXIT out='$OUT7'"
fi

# --- ケース8: CLAUDE_PLUGIN_ROOT 未設定 → 無出力 ---
OUT8=$(_run env -u CLAUDE_PLUGIN_ROOT)
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT8" ]; then
    bt_pass "CLAUDE_PLUGIN_ROOT 未設定: 無出力 exit 0"
else
    bt_fail "CLAUDE_PLUGIN_ROOT 未設定: 無出力 exit 0" "exit=$EXIT out='$OUT8'"
fi

# --- ケース9: marketplace clone 不在（Copilot 単独環境の主な構成）→ 無出力 ---
ROOT9=$(make_claude_fixture "$TMP/c9" "0.29.0" "")
OUT9=$(_run CLAUDE_PLUGIN_ROOT="$ROOT9")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT9" ]; then
    bt_pass "marketplace clone 不在: 無出力 exit 0"
else
    bt_fail "marketplace clone 不在: 無出力 exit 0" "exit=$EXIT out='$OUT9'"
fi

# --- ケース10: installed 側 plugin.json の version 欠落 → 無出力 ---
ROOT10=$(make_claude_fixture "$TMP/c10" "0.29.0" "0.30.0")
printf '{}\n' > "$ROOT10/.claude-plugin/plugin.json"
OUT10=$(_run CLAUDE_PLUGIN_ROOT="$ROOT10")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT10" ]; then
    bt_pass "installed version 欠落: 無出力 exit 0"
else
    bt_fail "installed version 欠落: 無出力 exit 0" "exit=$EXIT out='$OUT10'"
fi

# --- ケース11: 末尾スラッシュ付き ROOT → 正常検知 ---
ROOT11=$(make_claude_fixture "$TMP/c11" "0.29.0" "0.30.0")
OUT11=$(_run CLAUDE_PLUGIN_ROOT="$ROOT11/")
EXIT=$?
if [ $EXIT -eq 0 ] \
    && printf '%s' "$OUT11" | grep -q 'claude plugin update pecot-v@pecot'; then
    bt_pass "末尾スラッシュ付き ROOT: 正常検知"
else
    bt_fail "末尾スラッシュ付き ROOT: 正常検知" "exit=$EXIT out='$OUT11'"
fi

# --- ケース12: marketplace.json に同名項目が無い（source 不一致）→ skip 無出力 ---
ROOT12=$(make_claude_fixture "$TMP/c12" "0.29.0" "0.30.0")
printf '{"plugins":[{"name":"other","source":"./plugins/pecot-visual"}]}\n' \
    > "$TMP/c12/.claude/plugins/marketplaces/pecot/.claude-plugin/marketplace.json"
OUT12=$(_run CLAUDE_PLUGIN_ROOT="$ROOT12")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT12" ]; then
    bt_pass "source 不一致: 無出力 exit 0"
else
    bt_fail "source 不一致: 無出力 exit 0" "exit=$EXIT out='$OUT12'"
fi

# --- ケース13: source がオブジェクト形式 → skip 無出力 ---
ROOT13=$(make_claude_fixture "$TMP/c13" "0.29.0" "0.30.0")
printf '{"plugins":[{"name":"pecot-v","source":{"source":"github","repo":"a/b"}}]}\n' \
    > "$TMP/c13/.claude/plugins/marketplaces/pecot/.claude-plugin/marketplace.json"
OUT13=$(_run CLAUDE_PLUGIN_ROOT="$ROOT13")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT13" ]; then
    bt_pass "オブジェクト形式 source: 無出力 exit 0"
else
    bt_fail "オブジェクト形式 source: 無出力 exit 0" "exit=$EXIT out='$OUT13'"
fi

# 汎用 assert: 出力に更新案内が含まれる / 無出力
expect_notice() {
    local label="$1" exit_code="$2" out="$3" hint="$4"
    if [ "$exit_code" -eq 0 ] && printf '%s' "$out" | grep -q "$hint" \
        && printf '%s' "$out" | head -n 1 | grep -q '^note: ' \
        && printf '%s' "$out" | grep -q 'pecot-v 0.30.0'; then
        bt_pass "$label"
    else
        bt_fail "$label" "exit=$exit_code out='$out'"
    fi
}
expect_silent() {
    local label="$1" exit_code="$2" out="$3"
    if [ "$exit_code" -eq 0 ] && [ -z "$out" ]; then
        bt_pass "$label"
    else
        bt_fail "$label" "exit=$exit_code out='$out'"
    fi
}

# plugins ルート $1 の下に Claude 形（cache + 兄弟 marketplaces + known_marketplaces.json）を作る。
# CLAUDE_PLUGIN_ROOT 用のパスを出力する。$2=installed。
make_claude_at() {
    local plugins="$1" installed="$2"
    local root="$plugins/cache/pecot/pecot-v/$installed"
    mkdir -p "$root/.claude-plugin" "$plugins/marketplaces/pecot/.claude-plugin" \
        "$plugins/marketplaces/pecot/plugins/pecot-visual/.claude-plugin"
    printf '{"version":"%s"}\n' "$installed" > "$root/.claude-plugin/plugin.json"
    printf '{"version":"0.30.0"}\n' > "$plugins/marketplaces/pecot/plugins/pecot-visual/.claude-plugin/plugin.json"
    printf '{"plugins":[{"name":"pecot-v","source":"./plugins/pecot-visual"}]}\n' \
        > "$plugins/marketplaces/pecot/.claude-plugin/marketplace.json"
    printf '{"pecot":{"installLocation":"%s/marketplaces/pecot"}}\n' "$plugins" \
        > "$plugins/known_marketplaces.json"
    printf '%s' "$root"
}

# --- ケース14: CLAUDE_CONFIG_DIR を既定以外にした Claude 形 → 更新案内（環境変数は読まず ROOT から導出）---
CFG14="$TMP/c14/custom-claude-config"
ROOT14=$(make_claude_at "$CFG14/plugins" "0.29.0")
OUT14=$(_run CLAUDE_CONFIG_DIR="$CFG14" CLAUDE_PLUGIN_ROOT="$ROOT14")
expect_notice "CLAUDE_CONFIG_DIR 既定以外: 更新案内が出る" $? "$OUT14" 'claude plugin update pecot-v@pecot'

# --- ケース15: CLAUDE_CONFIG_DIR 末尾スラッシュ ---
OUT15=$(_run CLAUDE_CONFIG_DIR="$CFG14/" CLAUDE_PLUGIN_ROOT="$ROOT14")
expect_notice "CLAUDE_CONFIG_DIR 末尾スラッシュ: 更新案内が出る" $? "$OUT15" 'claude plugin update pecot-v@pecot'

# --- ケース16: 既定の場所の利用者が無関係な CLAUDE_CONFIG_DIR を持っていても検知する ---
ROOT16=$(make_claude_fixture "$TMP/c16" "0.29.0" "0.30.0")
OUT16=$(_run CLAUDE_CONFIG_DIR="$TMP/c16/other" CLAUDE_PLUGIN_ROOT="$ROOT16")
expect_notice "既定の場所 + 無関係な CLAUDE_CONFIG_DIR: 更新案内が出る" $? "$OUT16" 'claude plugin update pecot-v@pecot'

# --- ケース17: CLAUDE_CODE_PLUGIN_CACHE_DIR 相当（.claude を含まない plugins ルート）---
CACHE17="$TMP/c17/elsewhere/plugin-root"
ROOT17=$(make_claude_at "$CACHE17" "0.29.0")
OUT17=$(_run CLAUDE_CODE_PLUGIN_CACHE_DIR="$CACHE17" CLAUDE_PLUGIN_ROOT="$ROOT17")
expect_notice "CLAUDE_CODE_PLUGIN_CACHE_DIR 相当: 更新案内が出る" $? "$OUT17" 'claude plugin update pecot-v@pecot'

# --- ケース18: cowork_plugins レイアウト ---
ROOT18=$(make_claude_at "$TMP/c18/.claude/cowork_plugins" "0.29.0")
OUT18=$(_run CLAUDE_PLUGIN_ROOT="$ROOT18")
expect_notice "cowork_plugins レイアウト: 更新案内が出る" $? "$OUT18" 'claude plugin update pecot-v@pecot'

# --- ケース19: installLocation が兄弟 marketplaces と別の場所を指す → そちらを読む ---
ROOT19=$(make_claude_at "$TMP/c19/plugins" "0.29.0")
mkdir -p "$TMP/c19/clone/.claude-plugin" "$TMP/c19/clone/plugins/pecot-visual/.claude-plugin"
cp "$TMP/c19/plugins/marketplaces/pecot/.claude-plugin/marketplace.json" "$TMP/c19/clone/.claude-plugin/"
printf '{"version":"0.30.0"}\n' > "$TMP/c19/clone/plugins/pecot-visual/.claude-plugin/plugin.json"
rm -r "$TMP/c19/plugins/marketplaces"
printf '{"pecot":{"installLocation":"%s/c19/clone"}}\n' "$TMP" > "$TMP/c19/plugins/known_marketplaces.json"
OUT19=$(_run CLAUDE_PLUGIN_ROOT="$ROOT19")
expect_notice "installLocation 優先: 別の場所の clone を読む" $? "$OUT19" 'claude plugin update pecot-v@pecot'

# --- ケース20: known_marketplaces.json が無い（dev パスとの区別）→ 無出力 ---
ROOT20=$(make_claude_fixture "$TMP/c20" "0.29.0" "0.30.0")
rm "$TMP/c20/.claude/plugins/known_marketplaces.json"
OUT20=$(_run CLAUDE_PLUGIN_ROOT="$ROOT20")
expect_silent "known_marketplaces.json 不在: 無出力 exit 0" $? "$OUT20"

# --- ケース21: ROOT が浅すぎる（版 dir なし）/ 深すぎる → 無出力 ---
ROOT21=$(make_claude_fixture "$TMP/c21" "0.29.0" "0.30.0")
OUT21=$(_run CLAUDE_PLUGIN_ROOT="${ROOT21%/*}")
expect_silent "ROOT が浅すぎる: 無出力 exit 0" $? "$OUT21"
mkdir -p "$ROOT21/sub/.claude-plugin"
OUT21B=$(_run CLAUDE_PLUGIN_ROOT="$ROOT21/sub")
expect_silent "ROOT が深すぎる: 無出力 exit 0" $? "$OUT21B"

# --- ケース22: Copilot 形 + CLAUDE_CONFIG_DIR 下の Claude 側 clone を読む（Copilot キャッシュ無し）---
ROOT22="$TMP/c22/.copilot/installed-plugins/pecot/pecot-v"
mkdir -p "$ROOT22/.claude-plugin"
printf '{"version":"0.29.0"}\n' > "$ROOT22/.claude-plugin/plugin.json"
OUT22=$(_run CLAUDE_CONFIG_DIR="$CFG14" CLAUDE_PLUGIN_ROOT="$ROOT22")
expect_notice "Copilot 形 + CLAUDE_CONFIG_DIR: その下の clone を読む" $? "$OUT22" 'copilot plugin update pecot-v@pecot'

# --- ケース23: Copilot 単独環境（Copilot 自身の marketplace キャッシュのみ）---
ROOT23="$TMP/c23/.copilot/installed-plugins/pecot/pecot-v"
CLONE23="$TMP/c23/.copilot/.cache/copilot/marketplaces/https---example-com-o-r-git"
mkdir -p "$ROOT23/.claude-plugin" "$CLONE23/.claude-plugin" "$CLONE23/plugins/pecot-visual/.claude-plugin"
printf '{"version":"0.29.0"}\n' > "$ROOT23/.claude-plugin/plugin.json"
printf '{"name":"pecot","plugins":[{"name":"pecot-v","source":"./plugins/pecot-visual"}]}\n' > "$CLONE23/.claude-plugin/marketplace.json"
printf '{"version":"0.30.0"}\n' > "$CLONE23/plugins/pecot-visual/.claude-plugin/plugin.json"
OUT23=$(_run CLAUDE_PLUGIN_ROOT="$ROOT23")
expect_notice "Copilot 単独: 自身のキャッシュから最新版を引く" $? "$OUT23" 'copilot plugin update pecot-v@pecot'

# --- ケース24: Copilot のキャッシュの marketplace 名が違う → 無出力 ---
printf '{"name":"other","plugins":[{"name":"pecot-v","source":"./plugins/pecot-visual"}]}\n' > "$CLONE23/.claude-plugin/marketplace.json"
OUT24=$(_run CLAUDE_PLUGIN_ROOT="$ROOT23")
expect_silent "Copilot キャッシュの名前不一致: 無出力 exit 0" $? "$OUT24"

bt_finish
