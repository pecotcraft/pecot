# pecotv-dir-init 起動の検知レイヤのテスト。
# user-prompt-submit.sh と pre-tool-use-skill.sh が、`/pecot-v:` / `pecot-v:*` を正しく検知することを確かめる。

bats_require_minimum_version 1.5.0

# 親リポの GIT_DIR などが漏れると、一時リポの操作が親リポへ向き、フックの git ls-files も誤判定する。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

HOOKS_DIR="$BATS_TEST_DIRNAME/.."
UPS_SCRIPT="$HOOKS_DIR/user-prompt-submit.sh"
PTUS_SCRIPT="$HOOKS_DIR/pre-tool-use-skill.sh"
PLUGIN_ROOT="$(cd "$HOOKS_DIR/.." && pwd)"

# 親リポの GIT_* が漏れても、git の操作とフックの起動を一時リポに向けるため外して行う。
_GIT_ISOLATE=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES)
_git() {
    "${_GIT_ISOLATE[@]}" git "$@"
}

setup_file() {
    bats_load_library pecot-bats
    command -v jq >/dev/null 2>&1 || fail "jq が無いため hooks.json を読めない"
}

setup() {
    bats_load_library pecot-bats
    PROJ="$BATS_TEST_TMPDIR/proj"
    mkdir -p "$PROJ"
}

# $1=標準入力の JSON
_ups() {
    printf '%s\n' "$1" | "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$UPS_SCRIPT"
}

_ptus() {
    printf '%s\n' "$1" | "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT"
}

@test "プロンプトの行頭が /pecot-v: なら、.pecotv/ を作る" {
    explains '行頭が `/pecot-v:` のプロンプトを user-prompt-submit.sh に渡すテストです。init が呼ばれて `.pecotv/work` が作られることを確認します。'
    run_attached --separate-stderr _ups '{"prompt": "/pecot-v:v-drawio"}'
    assert [ -d "$PROJ/.pecotv/work" ]
}

@test "通常のプロンプトなら、.pecotv/ を作らない" {
    explains '`/pecot-v:` を含まない通常のプロンプトを user-prompt-submit.sh に渡すテストです。init は呼ばれず、`.pecotv` も作られないことを確認します。'
    run_attached --separate-stderr _ups '{"prompt": "今日の天気は"}'
    assert [ ! -d "$PROJ/.pecotv" ]
}

@test "行頭でない /pecot-v: を含むプロンプトでは、.pecotv/ を作らない" {
    explains 'コードブロックの中に `/pecot-v:` を含むプロンプトを user-prompt-submit.sh に渡すテストです。行頭でないので誤反応せず、`.pecotv` が作られないことを確認します。'
    run_attached --separate-stderr _ups '{"prompt": "説明: `/pecot-v:v-drawio`"}'
    assert [ ! -d "$PROJ/.pecotv" ]
}

@test "プロンプトが /pecot-w: なら、pecotv 側では .pecotv/ を作らない" {
    explains '`/pecot-w:` のプロンプトを user-prompt-submit.sh に渡すテストです。pecotv 側の hook はスルーし、`.pecotv` が作られないことを確認します。'
    run_attached --separate-stderr _ups '{"prompt": "/pecot-w:w-help"}'
    assert [ ! -d "$PROJ/.pecotv" ]
}

@test "pecot-v: のスキルを呼ぶと、.pecotv/ を作る" {
    explains '`pecot-v:v-drawio` のスキル呼び出しを pre-tool-use-skill.sh に渡すテストです。init が呼ばれて `.pecotv/work` が作られることを確認します。'
    run_attached --separate-stderr _ptus '{"tool_input": {"skill": "pecot-v:v-drawio"}}'
    assert [ -d "$PROJ/.pecotv/work" ]
}

@test "pecot-w: のスキルを呼んでも、pecotv 側では .pecotv/ を作らない" {
    explains '`pecot-w:w-help` のスキル呼び出しを pre-tool-use-skill.sh に渡すテストです。pecotv 側の hook はスルーし、`.pecotv` が作られないことを確認します。'
    run_attached --separate-stderr _ptus '{"tool_input": {"skill": "pecot-w:w-help"}}'
    assert [ ! -d "$PROJ/.pecotv" ]
}

@test "pecotv 以外のスキルを呼ぶと、stdout に何も出さない" {
    explains '`claude-code-guide` のスキル呼び出しを pre-tool-use-skill.sh に渡すテストです。stdout が空であることを確認します。'
    run_attached --separate-stderr _ptus '{"tool_input": {"skill": "claude-code-guide"}}'
    assert_output ""
}

@test "pecot-v: のスキルを呼んでも、stdout は空で init は副作用だけになる" {
    explains '`pecot-v:v-drawio` のスキル呼び出しを pre-tool-use-skill.sh に渡すテストです。stdout は空のまま `.pecotv/work` が作られることを確認します。'
    run_attached --separate-stderr _ptus '{"tool_input": {"skill": "pecot-v:v-drawio"}}'
    assert_output ""
    assert [ -d "$PROJ/.pecotv/work" ]
}

# Copilot CLI は名前空間なしのスキル名で届く。同名が複数あるときだけ接頭辞が付く（T050 の観測）。
@test "名前空間なしで自プラグインのスキルを呼ぶと、stdout は空で .pecotv/ を作る" {
    explains 'Copilot CLI の形で名前空間なしの `v-drawio` を pre-tool-use-skill.sh に渡すテストです。自プラグインのスキルとして init が呼ばれ、stdout は空であることを確認します。'
    run_attached --separate-stderr _ptus '{"tool_name": "skill", "tool_input": {"skill": "v-drawio"}}'
    assert_output ""
    assert [ -d "$PROJ/.pecotv/work" ]
}

# 名前を printf で JSON に埋めるため、題ごとの関数にして渡す。
assert_foreign_skill_ignored() {
    explains '名前空間なしで自プラグインに無い名前のスキル呼び出しを pre-tool-use-skill.sh に渡すテストです。pecot-workflow のスキル名・遡上・空の名前でも init が呼ばれず、`.pecotv` が作られないことを確認します。'
    run_attached --separate-stderr _ptus "$(printf '{"tool_name": "skill", "tool_input": {"skill": "%s"}}' "$1")"
    assert [ ! -d "$PROJ/.pecotv" ]
}

bats_test_function --description "自プラグインのスキルでない名前 w-help を渡すと、スルーする" -- assert_foreign_skill_ignored "w-help"
bats_test_function --description "自プラグインのスキルでない名前 v-no-such-skill を渡すと、スルーする" -- assert_foreign_skill_ignored "v-no-such-skill"
bats_test_function --description "自プラグインのスキルでない名前 ../hooks を渡すと、スルーする" -- assert_foreign_skill_ignored "../hooks"
bats_test_function --description "自プラグインのスキルでない空の名前を渡すと、スルーする" -- assert_foreign_skill_ignored ""

@test "hooks.json の SessionStart は、session-start.sh を指す" {
    explains '`hooks/hooks.json` の SessionStart を調べるテストです。既存リポの追跡案内を出す `session-start.sh` が command に入っていることを確認します（#676）。'
    run jq -e '[.hooks.SessionStart[].hooks[].command] | any(test("session-start\\.sh$"))' "$PLUGIN_ROOT/hooks/hooks.json"
    assert_success
}

@test "Copilot の hooks.json は、3 つの command 配列が hooks.json と一致する" {
    explains '`hooks/hooks.json` と `com.github.copilot/hooks/hooks.json` を比べるテストです。SessionStart・UserPromptSubmit・PreToolUse(Skill) の command 配列が一致することを確認します（#662・#676）。'
    local orig="$PLUGIN_ROOT/hooks/hooks.json"
    local copilot="$PLUGIN_ROOT/com.github.copilot/hooks/hooks.json"
    assert_equal "$(jq -c '[.hooks.SessionStart[].hooks[].command] | sort' "$copilot")" \
        "$(jq -c '[.hooks.SessionStart[].hooks[].command] | sort' "$orig")"
    assert_equal "$(jq -c '[.hooks.UserPromptSubmit[].hooks[].command] | sort' "$copilot")" \
        "$(jq -c '[.hooks.UserPromptSubmit[].hooks[].command] | sort' "$orig")"
    # Copilot のツール名は小文字の skill で Claude 名に写されないため、matcher は Skill|skill（全体一致）
    local orig_ptus
    orig_ptus="$(jq -c '[.hooks.PreToolUse[] | select(.matcher == "Skill") | .hooks[].command] | sort' "$orig")"
    assert_not_equal "$orig_ptus" "[]"
    assert_equal "$(jq -c '[.hooks.PreToolUse[] | select(.matcher == "Skill|skill") | .hooks[].command] | sort' "$copilot")" \
        "$orig_ptus"
}

@test "実 git のリポで init すると、.pecotv/work 配下のファイルがコミット候補に出ない" {
    explains '実 git のリポで `pecotv-dir-init.sh` を動かし、`.pecotv/work/drawio` にファイルを置くテストです。そのファイルが ignore されて `git status` に出ないことを確認します。'
    ( cd "$PROJ" && _git init -q && _git config user.email t@t && _git config user.name t )
    run_attached --separate-stderr "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
        bash "$PLUGIN_ROOT/hooks/lib/core/pecotv-dir-init.sh"
    assert_success
    mkdir -p "$PROJ/.pecotv/work/drawio"
    touch "$PROJ/.pecotv/work/drawio/dummy.drawio"
    run _git -C "$PROJ" status --porcelain -- .pecotv/work/drawio/dummy.drawio
    assert_output ""
}
