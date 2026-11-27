# plugin-update-notice.sh を確かめる。installed が marketplace clone より古いときだけ更新の案内を出すことを、
# Claude と Copilot の両レイアウトで見る。フィクスチャは一時 dir の中で閉じ、実環境の ~/.claude を見ない。

bats_require_minimum_version 1.5.0

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

HOOK="$BATS_TEST_DIRNAME/../lib/session-start/plugin-update-notice.sh"
SESSION_START="$BATS_TEST_DIRNAME/../session-start.sh"

# 親リポの GIT_* と実行環境の CLAUDE_CONFIG_DIR を外して起動する（session-start.bats と同形）。
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

# Copilot 単独環境（Copilot 自身の marketplace キャッシュのみ）を $1 の下に作る。ROOT_SOLO・CLONE_SOLO に置く。
make_copilot_solo() {
    ROOT_SOLO="$1/.copilot/installed-plugins/pecot/pecot-v"
    CLONE_SOLO="$1/.copilot/.cache/copilot/marketplaces/https---example-com-o-r-git"
    mkdir -p "$ROOT_SOLO/.claude-plugin" "$CLONE_SOLO/.claude-plugin" "$CLONE_SOLO/plugins/pecot-visual/.claude-plugin"
    printf '{"version":"0.29.0"}\n' > "$ROOT_SOLO/.claude-plugin/plugin.json"
    printf '{"name":"pecot","plugins":[{"name":"pecot-v","source":"./plugins/pecot-visual"}]}\n' > "$CLONE_SOLO/.claude-plugin/marketplace.json"
    printf '{"version":"0.30.0"}\n' > "$CLONE_SOLO/plugins/pecot-visual/.claude-plugin/plugin.json"
}

# 直前の run の結果が、更新案内（先頭が note:・$1 を含む・最新版 0.30.0 を含む）であること。
expect_notice() {
    assert_success
    assert_line --index 0 --regexp '^note: '
    assert_output --partial "$1"
    assert_output --partial 'pecot-v 0.30.0'
}

# 直前の run の結果が、終了コード 0 で stdout に何も出さないこと。
expect_silent() {
    assert_success
    assert_output ""
}

setup() {
    bats_load_library pecot-bats
    T="$BATS_TEST_TMPDIR"
}

setup_file() {
    bats_load_library pecot-bats
    command -v jq >/dev/null 2>&1 || fail "jq が無い"
}

@test "Claude 形で installed が古いと、claude plugin update と両バージョンを含む案内を出す" {
    explains "Claude 形のレイアウトで installed が 0.29.0、最新が 0.30.0 のテストです。先頭が \`note:\` の案内に更新コマンドと両バージョンが含まれることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c1" "0.29.0" "0.30.0")
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_notice 'claude plugin update pecot-v@pecot'
    assert_line --index 0 --regexp '^note: plugin update available: '
    assert_output --partial 'installed: 0.29.0'
}

@test "installed と最新のバージョンが一致するとき、何も出さない" {
    explains "installed と最新がどちらも 0.30.0 のテストです。stdout が空で終了コード 0 になることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c2" "0.30.0" "0.30.0")
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_silent
}

@test "Copilot 形で installed が古いと、copilot plugin update の案内を出す" {
    explains "Copilot 形のレイアウトで installed が最新より古いテストです。案内に \`copilot plugin update pecot-v@pecot\` が含まれることを確認します。"
    local root
    root=$(make_copilot_fixture "$T/c3" "0.29.0" "0.30.0")
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    assert_success
    assert_output --partial 'copilot plugin update pecot-v@pecot'
}

@test "どちらのレイアウトにも合わない dev パス形では、何も出さない" {
    explains "\`plugins/pecot-visual\` を直に指す dev パス形のテストです。非対象のレイアウトとして skip され、stdout が空で終了コード 0 になることを確認します。"
    local dev="$T/dev/plugins/pecot-visual"
    mkdir -p "$dev/.claude-plugin"
    printf '{"version":"0.29.0"}\n' > "$dev/.claude-plugin/plugin.json"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$dev"
    expect_silent
}

@test "hooks-config で無効化したとき、installed が古くても何も出さない" {
    explains "hooks-config で \`plugin-update-notice\` を false にしたテストです。installed が古くても stdout が空で終了コード 0 になることを確認します。"
    local root cfg="$T/hooks-config-5.json"
    root=$(make_claude_fixture "$T/c5" "0.29.0" "0.30.0")
    printf '{"plugin-update-notice": false}\n' > "$cfg"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root" PECOTV_HOOKS_CONFIG_PATH="$cfg"
    expect_silent
}

@test "session-start.sh 経由でも更新案内を出し、.pecotv は作らない" {
    explains "\`.pecotv\` が無いプロジェクトで \`session-start.sh\` 全体を起動するテストです。更新案内が stdout に出て、\`.pecotv\` が作られないことを確認します。"
    local root proj="$T/proj6"
    root=$(make_claude_fixture "$T/c6" "0.29.0" "0.30.0")
    mkdir -p "$proj"
    run --separate-stderr _run_session CLAUDE_PROJECT_DIR="$proj" CLAUDE_PLUGIN_ROOT="$root"
    assert_success
    assert_output --partial 'claude plugin update pecot-v@pecot'
    assert [ ! -e "$proj/.pecotv" ]
}

@test "installed が最新より新しいとき、何も出さない" {
    explains "installed が 0.30.0 で marketplace clone が 0.20.0 と古いテストです。clone を pull する前の状態として stdout が空で終了コード 0 になることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c7" "0.30.0" "0.20.0")
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_silent
}

@test "CLAUDE_PLUGIN_ROOT が未設定のとき、何も出さない" {
    explains "\`CLAUDE_PLUGIN_ROOT\` を外して起動するテストです。stdout が空で終了コード 0 になることを確認します。"
    run --separate-stderr _run env -u CLAUDE_PLUGIN_ROOT
    expect_silent
}

@test "marketplace clone が無いとき、何も出さない" {
    explains "marketplace clone が無い構成のテストです。Copilot 単独環境の主な形で、stdout が空で終了コード 0 になることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c9" "0.29.0" "")
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_silent
}

@test "installed 側の plugin.json に version が無いとき、何も出さない" {
    explains "installed 側の \`plugin.json\` を空のオブジェクトにしたテストです。version が読めず、stdout が空で終了コード 0 になることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c10" "0.29.0" "0.30.0")
    printf '{}\n' > "$root/.claude-plugin/plugin.json"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_silent
}

@test "CLAUDE_PLUGIN_ROOT の末尾にスラッシュがあっても、更新案内を出す" {
    explains "\`CLAUDE_PLUGIN_ROOT\` の末尾にスラッシュを付けたテストです。付けない場合と同じく更新案内が出ることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c11" "0.29.0" "0.30.0")
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root/"
    assert_success
    assert_output --partial 'claude plugin update pecot-v@pecot'
}

@test "marketplace.json に同名の項目が無いとき、何も出さない" {
    explains "\`marketplace.json\` の項目名を別の名前に変えたテストです。source が一致せず、stdout が空で終了コード 0 になることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c12" "0.29.0" "0.30.0")
    printf '{"plugins":[{"name":"other","source":"./plugins/pecot-visual"}]}\n' \
        > "$T/c12/.claude/plugins/marketplaces/pecot/.claude-plugin/marketplace.json"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_silent
}

@test "marketplace.json の source がオブジェクト形式のとき、何も出さない" {
    explains "\`marketplace.json\` の source を github 形式のオブジェクトにしたテストです。対象外として stdout が空で終了コード 0 になることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c13" "0.29.0" "0.30.0")
    printf '{"plugins":[{"name":"pecot-v","source":{"source":"github","repo":"a/b"}}]}\n' \
        > "$T/c13/.claude/plugins/marketplaces/pecot/.claude-plugin/marketplace.json"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_silent
}

# 環境変数は読まず、ROOT から plugins のルートを導出する。
@test "CLAUDE_CONFIG_DIR が既定以外の場所でも、更新案内を出す" {
    explains "\`CLAUDE_CONFIG_DIR\` を既定以外にした Claude 形のテストです。ROOT から導出した clone を読んで更新案内が出ることを確認します。"
    local cfg="$T/c14/custom-claude-config" root
    root=$(make_claude_at "$cfg/plugins" "0.29.0")
    run --separate-stderr _run CLAUDE_CONFIG_DIR="$cfg" CLAUDE_PLUGIN_ROOT="$root"
    expect_notice 'claude plugin update pecot-v@pecot'
}

@test "CLAUDE_CONFIG_DIR の末尾にスラッシュがあっても、更新案内を出す" {
    explains "\`CLAUDE_CONFIG_DIR\` の末尾にスラッシュを付けたテストです。付けない場合と同じく更新案内が出ることを確認します。"
    local cfg="$T/c14/custom-claude-config" root
    root=$(make_claude_at "$cfg/plugins" "0.29.0")
    run --separate-stderr _run CLAUDE_CONFIG_DIR="$cfg/" CLAUDE_PLUGIN_ROOT="$root"
    expect_notice 'claude plugin update pecot-v@pecot'
}

@test "既定の場所の利用者が無関係な CLAUDE_CONFIG_DIR を持っていても、更新案内を出す" {
    explains "既定の場所に入れたうえで、別の場所を指す \`CLAUDE_CONFIG_DIR\` を渡すテストです。この変数に惑わされず更新案内が出ることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c16" "0.29.0" "0.30.0")
    run --separate-stderr _run CLAUDE_CONFIG_DIR="$T/c16/other" CLAUDE_PLUGIN_ROOT="$root"
    expect_notice 'claude plugin update pecot-v@pecot'
}

@test "plugins のルートが .claude を含まない場所でも、更新案内を出す" {
    explains "\`CLAUDE_CODE_PLUGIN_CACHE_DIR\` 相当の、\`.claude\` を含まない plugins ルートのテストです。更新案内が出ることを確認します。"
    local cache="$T/c17/elsewhere/plugin-root" root
    root=$(make_claude_at "$cache" "0.29.0")
    run --separate-stderr _run CLAUDE_CODE_PLUGIN_CACHE_DIR="$cache" CLAUDE_PLUGIN_ROOT="$root"
    expect_notice 'claude plugin update pecot-v@pecot'
}

@test "cowork_plugins のレイアウトでも、更新案内を出す" {
    explains "plugins のルートが \`.claude/cowork_plugins\` のテストです。このレイアウトでも更新案内が出ることを確認します。"
    local root
    root=$(make_claude_at "$T/c18/.claude/cowork_plugins" "0.29.0")
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_notice 'claude plugin update pecot-v@pecot'
}

@test "installLocation が兄弟の marketplaces と別の場所を指すとき、そちらの clone を読む" {
    explains "\`known_marketplaces.json\` の installLocation が別の clone を指すテストです。兄弟の marketplaces を消しても、その clone から最新版を引くことを確認します。"
    local root
    root=$(make_claude_at "$T/c19/plugins" "0.29.0")
    mkdir -p "$T/c19/clone/.claude-plugin" "$T/c19/clone/plugins/pecot-visual/.claude-plugin"
    cp "$T/c19/plugins/marketplaces/pecot/.claude-plugin/marketplace.json" "$T/c19/clone/.claude-plugin/"
    printf '{"version":"0.30.0"}\n' > "$T/c19/clone/plugins/pecot-visual/.claude-plugin/plugin.json"
    rm -r "$T/c19/plugins/marketplaces"
    printf '{"pecot":{"installLocation":"%s/c19/clone"}}\n' "$T" > "$T/c19/plugins/known_marketplaces.json"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_notice 'claude plugin update pecot-v@pecot'
}

# known_marketplaces.json が無いことで、dev パスと見分ける。
@test "known_marketplaces.json が無いとき、何も出さない" {
    explains "\`known_marketplaces.json\` を消したテストです。dev パスと見分けて、stdout が空で終了コード 0 になることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c20" "0.29.0" "0.30.0")
    rm "$T/c20/.claude/plugins/known_marketplaces.json"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root"
    expect_silent
}

@test "CLAUDE_PLUGIN_ROOT が浅すぎて版のディレクトリを含まないとき、何も出さない" {
    explains "\`CLAUDE_PLUGIN_ROOT\` を版のディレクトリの 1 つ上にしたテストです。レイアウトに合わず、stdout が空で終了コード 0 になることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c21" "0.29.0" "0.30.0")
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="${root%/*}"
    expect_silent
}

@test "CLAUDE_PLUGIN_ROOT が深すぎるとき、何も出さない" {
    explains "\`CLAUDE_PLUGIN_ROOT\` を版のディレクトリの 1 つ下にしたテストです。レイアウトに合わず、stdout が空で終了コード 0 になることを確認します。"
    local root
    root=$(make_claude_fixture "$T/c21" "0.29.0" "0.30.0")
    mkdir -p "$root/sub/.claude-plugin"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$root/sub"
    expect_silent
}

@test "Copilot 形では、CLAUDE_CONFIG_DIR の下にある Claude 側の clone を読む" {
    explains "Copilot 形で Copilot 側のキャッシュが無いテストです。\`CLAUDE_CONFIG_DIR\` の下の Claude 側の clone を読み、\`copilot plugin update\` の案内が出ることを確認します。"
    local cfg="$T/c14/custom-claude-config" root22="$T/c22/.copilot/installed-plugins/pecot/pecot-v"
    make_claude_at "$cfg/plugins" "0.29.0" > /dev/null
    mkdir -p "$root22/.claude-plugin"
    printf '{"version":"0.29.0"}\n' > "$root22/.claude-plugin/plugin.json"
    run --separate-stderr _run CLAUDE_CONFIG_DIR="$cfg" CLAUDE_PLUGIN_ROOT="$root22"
    expect_notice 'copilot plugin update pecot-v@pecot'
}

@test "Copilot 単独環境では、自身のキャッシュから最新版を引いて更新案内を出す" {
    explains "Copilot 自身の marketplace キャッシュだけがある環境のテストです。そのキャッシュから最新版を引き、\`copilot plugin update\` の案内が出ることを確認します。"
    make_copilot_solo "$T/c23"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$ROOT_SOLO"
    expect_notice 'copilot plugin update pecot-v@pecot'
}

@test "Copilot のキャッシュの marketplace 名が違うとき、何も出さない" {
    explains "Copilot 単独環境で、キャッシュの \`marketplace.json\` の名前を別の名前に変えたテストです。stdout が空で終了コード 0 になることを確認します。"
    make_copilot_solo "$T/c23"
    printf '{"name":"other","plugins":[{"name":"pecot-v","source":"./plugins/pecot-visual"}]}\n' > "$CLONE_SOLO/.claude-plugin/marketplace.json"
    run --separate-stderr _run CLAUDE_PLUGIN_ROOT="$ROOT_SOLO"
    expect_silent
}
