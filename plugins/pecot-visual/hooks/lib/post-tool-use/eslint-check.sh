#!/bin/bash
# PostToolUse hook: v-slidev 生成プロジェクトで編集された MD に対し ESLint を自動実行
#
# プロジェクト root の決め方:
#   編集ファイルの dir から上方向に、`slides.md` と `pages/` を両方持つ dir を探す（git 非依存）。
#   見つかった dir を TALK_ROOT とする。
#
# eslint は plugin 側の deck-lint.env.config.js と node_modules（どちらも assets/slidev/）を直接参照して動かす。
# テーマ固有の値は、実行用ミラーの CLI（slide theme --json）が解釈した lint を、環境変数 PECOTV_DECK_LINT に JSON で渡して受ける。
# hook は宣言（pecot-theme.json）を読まない。
# standalone の talk-dir には lint plugin を同梱しない方針。
# 設定を `eslint.config.*` の名前にしないのは、ESLint 10 の挙動のため。
# ESLint 10 は、対象ファイルに最も近い `eslint.config.*` を上方向の探索で使う。
# そこで `--config` で明示して渡す。
#
# 出力チャネル:
#   stdout = model に届けるものだけ（additionalContext を持つ JSON）。
#            どの分岐でも、空または妥当な JSON にする。
#            呼び出し元の merge-hook-outputs.sh は、非 JSON の stdout を additionalContext に丸める。
#            そのため診断ログを stdout に出してはならない。
#   stderr = 開発者向けの trace を 1 行。
#            exit 0 の hook の stderr は、model と debug ログのどちらにも出ない。
#            ただし session transcript の hook_success.stderr には恒久的に残る。
#
# 分岐の分類。「lint していない」ことと「違反があった」ことを区別する。
# 違反とするのは exit 1 だけで、それ以外の非 0 と空出力は未実施として扱う。
#   対象外   → trace のみ。対象の MD でない、talk-dir の外、lint 対象パスでない、plugin root を解決できない場合。
#   設定不備 → 【ESLint 未実施】。eslint の binary、config、CLI が無い場合。
#   テーマ   → 【ESLint 未実施】。テーマを引けない場合（未リンク、移行前の talk-dir、宣言の誤り）。復旧の案内を添える。
#   pass     → trace のみ。
#   違反     → 【ESLint違反検出】。
#   未実施   → 【ESLint 未実施】。timeout、config の致命的エラー、実行時の異常、設定対象外の場合。

# 開発者診断 trace。verdict は skip / pass / not-linted / violation / canary。
trace() {
    echo "[eslint-check] $1" >&2
}

# talk-dir の探索と plugin hooks root の解決は、3 本の post-tool-use hook で共有する。
# 共有ライブラリを解決できない配置で、未定義関数のまま動かすと、talk-dir 外と区別できない skip になる。
# そのため明示的に対象外として終える。
SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_PATHS_LIB="${SCRIPT_DIR%/*}/core/hook-paths.sh"
if [ ! -f "$HOOK_PATHS_LIB" ]; then
    trace "skip: shared library cannot be resolved ($HOOK_PATHS_LIB)"
    exit 0
fi
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/hook-paths.sh
. "$HOOK_PATHS_LIB"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/hook-message.sh
. "${SCRIPT_DIR%/*}/core/hook-message.sh"

# lint 未実施の通知。model には「lint されていない」ことだけを伝え、修正指示は出さない。
notify_not_linted() {
    local message
    message=$(hook_message warning "eslint not run: $FILE_PATH
$1
No eslint result exists for this file, so violations have not been detected.")
    jq -n --arg message "$message" '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": $message}}'
}

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [ -z "$FILE_PATH" ]; then
    trace "skip: tool_input.file_path is empty"
    exit 0
fi

# MD のみ対象（YAML は validate-references-check.sh が処理）
case "$FILE_PATH" in
    *.md) ;;
    *)
        trace "skip: not a .md file ($FILE_PATH)"
        exit 0
        ;;
esac

# 編集ファイルの dir から上方向に talk-dir マーカーを探す。
# 探索は logical パスで行う（cd / pwd に -P を付けない）。物理化すると pages/ 自体や
# その配下が talk-dir 外への symlink だった場合に、上方向探索が talk-dir を通らず
# マーカーを見失う。ORIG_DIR は下の相対パス算出でも使う。
ORIG_DIR=$(CDPATH= cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd)
TALK_ROOT=$(find_talk_root "$ORIG_DIR" "pages")

if [ -z "$TALK_ROOT" ]; then
    trace "skip: talk-dir marker (slides.md + pages/) not found ($FILE_PATH)"
    exit 0
fi

# plugin の hooks root を解決。逆算が成立しない配置（別所へコピーされた等）は
# 「解決不能」として対象外に落とす。設定不備（解決できたが binary/config が無い）
# とは区別する。
HOOKS_ROOT=$(resolve_hooks_root "$SCRIPT_DIR" "/lib/post-tool-use")

if [ -z "$HOOKS_ROOT" ]; then
    trace "skip: plugin root cannot be resolved (PLUGIN_HOOKS and CLAUDE_PLUGIN_ROOT are unset, and SCRIPT_DIR=$SCRIPT_DIR does not lead back to it)"
    exit 0
fi

# eslint には TALK_ROOT からの相対パスを渡す。
# eslint (Node) は base path を物理 cwd で解決し、引数と字句で比較する。
# そのため絶対パスを渡すと、symlink を跨いだ時点で "outside of base path" と判定され、検出されないまま skip される。
# 相対パスなら path.resolve(cwd, rel) で、必ず base path の配下に収まる。
# 相対パスは、生の $FILE_PATH ではなく、探索起点の ORIG_DIR から算出する。
# TALK_ROOT と同じ logical 空間なので、前方一致が保証される。
# ORIG_DIR と TALK_ROOT が同じときは、basename だけになる。
REL_FILE=$(talk_relative_path "$TALK_ROOT" "$ORIG_DIR" "$FILE_PATH")

# deck lint の対象（pages/**/*.md と slides.md）かは、slide theme を起こす前に判定する。
# talk-dir 内でも、対象外のパス（README.md 等）は lint されないのが正しい。
# 後ろへ回すと、テーマ未リンクの talk-dir で対象外の編集まで【ESLint 未実施】になる。
if ! is_talk_lint_target "$REL_FILE"; then
    trace "skip: not a lint target path ($REL_FILE)"
    exit 0
fi

# 実行用ミラー（データ置き場の runtime/）側の assets/slidev を eslint config + node_modules の供給元として参照。
# 依存と build 成果物は bin/pecotv が作るミラーにしか無い。ミラーが無い（初回の build 中など）ときは
# 【ESLint 未実施】に倒す。
if ! RUNTIME_DIR="$(resolve_runtime_dir "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"; then
    trace "not-linted: runtime mirror is missing"
    notify_not_linted "The lint environment is not ready (the runtime mirror has not been created yet).
Running the \`pecotv\` command once runs the plugin bootstrap, which restores it."
    exit 0
fi
ASSETS_DIR="$(resolve_slidev_assets_dir "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"

# テーマの宣言の解釈結果を CLI から取る。取れた結果の theme.directory は、不足の通知に添える。
# CLI が失敗しても stdout に slide.theme.error の JSON が出る。reason が theme-* のときは復旧の案内になる。
THEME_ERR_FILE=$(mktemp)
trap 'rm -f "$THEME_ERR_FILE"' EXIT
THEME_JSON="$(resolve_talk_theme_json "$RUNTIME_DIR" "$TALK_ROOT" "$THEME_ERR_FILE")"
THEME_EXIT=$?
# CLI の stderr の先頭 1 行。JSON を出せない失敗（Node の版不足など）の原因を、通知と trace に添える。
THEME_ERR=$(head -n 1 "$THEME_ERR_FILE")
THEME_DIR=""
if [ $THEME_EXIT -eq 0 ]; then
    THEME_DIR=$(printf '%s\n' "$THEME_JSON" | jq -r '.theme.directory // empty' 2>/dev/null)
fi

# eslint の bin は、assets/slidev 基準で eslint/package.json を引いて解決する。
# `.bin/eslint` の symlink は、版を 1 つにまとめた hoisted 配置では作られないことがある。
# そのため、パッケージの bin を node で直接起動する（cli の resolveEslintBin と同じ流儀）。
# require.resolve は親の node_modules や NODE_PATH まで遡る。
# そこで、解決した版のメジャーを、assets/slidev/package.json の devDependencies.eslint の宣言と照らし合わせる。
# 外れたら未解決として扱う（cli の assertEslintMatchesAssets と同じ判定）。
# range の最初の数字をメジャーとみなす。
# node の起動は 1 回。結果は "OK<TAB>bin パス" か "NG<TAB>種別<TAB>詳細" で返す。
# 種別は undeclared（宣言なし）、major（メジャー違い）、error（それ以外）の 3 つ。
# 理由は trace に残す。
ESLINT_RESOLVE=$(cd "$ASSETS_DIR" 2>/dev/null && node -p "
const fs = require('node:fs')
const path = require('node:path')
try {
  const manifestPath = require.resolve('eslint/package.json')
  const manifest = require(manifestPath)
  const want = JSON.parse(fs.readFileSync('package.json', 'utf8')).devDependencies?.eslint ?? ''
  const wantMajor = /\\d+/.exec(want)?.[0]
  const gotMajor = /^\\d+/.exec(manifest.version ?? '')?.[0]
  if (wantMajor === undefined) throw Object.assign(new Error(''), { kind: 'undeclared' })
  if (wantMajor !== gotMajor) throw Object.assign(new Error(manifest.version + ' (' + manifestPath + ') want ' + want), { kind: 'major' })
  const bin = manifest.bin
  'OK\\t' + path.resolve(path.dirname(manifestPath), typeof bin === 'string' ? bin : bin.eslint)
} catch (error) {
  'NG\\t' + (error.kind ?? 'error') + '\\t' + String(error.message).split('\\n')[0]
}" 2>&1)
# node の警告が、結果の前に付くことがある。結果は最終行だけを見る。
TAB=$(printf '\t')
ESLINT_RESOLVE_LAST=${ESLINT_RESOLVE##*$'\n'}
case "$ESLINT_RESOLVE_LAST" in
    OK"$TAB"*) ESLINT_BIN=${ESLINT_RESOLVE_LAST#*"$TAB"} ;;
    NG"$TAB"*)
        ESLINT_BIN=""
        NG_REASON=${ESLINT_RESOLVE_LAST#*"$TAB"}
        NG_KIND=${NG_REASON%%"$TAB"*}
        NG_DETAIL=${NG_REASON#*"$TAB"}
        case "$NG_KIND" in
            undeclared) NG_TEXT="assets/slidev/package.json does not declare devDependencies.eslint" ;;
            major) NG_TEXT="eslint ${NG_DETAIL%% want *} differs in major version from the assets/slidev requirement ${NG_DETAIL##* want }" ;;
            *) NG_TEXT="$NG_DETAIL" ;;
        esac
        trace "eslint resolution failed: $NG_TEXT (assets: $ASSETS_DIR)"
        ;;
    *)
        ESLINT_BIN=""
        trace "eslint resolution failed: node returned no result (${ESLINT_RESOLVE:-no output} / assets: $ASSETS_DIR)"
        ;;
esac

DECK_LINT_CONFIG="$(resolve_deck_lint_env_config "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"

MISSING=""
{ [ -n "$ESLINT_BIN" ] && [ -f "$ESLINT_BIN" ]; } || MISSING="node_modules/eslint"
if [ ! -f "$DECK_LINT_CONFIG" ]; then
    MISSING="${MISSING:+$MISSING, }deck-lint.env.config.js"
fi
if [ ! -f "$RUNTIME_DIR/cli/dist/cli.js" ]; then
    MISSING="${MISSING:+$MISSING, }cli/dist/cli.js"
fi
if [ -n "$MISSING" ]; then
    trace "not-linted: lint environment is incomplete ($MISSING / theme: ${THEME_DIR:-unresolved})"
    notify_not_linted "The lint environment is incomplete (missing: $MISSING / theme: ${THEME_DIR:-unresolved}).
Running the \`pecotv\` command once runs the plugin bootstrap, which restores it."
    exit 0
fi

# テーマを引けなかったときは、lint の入力（規則・参照の場所）が無いので lint しない。
# 原因が未リンクや移行前の talk-dir なら、復旧の手順を添える。
if [ $THEME_EXIT -ne 0 ]; then
    THEME_REASON=$(printf '%s\n' "$THEME_JSON" | jq -r '.reason // empty' 2>/dev/null)
    THEME_DETAIL=$(printf '%s\n' "$THEME_JSON" | jq -r '.detail // empty' 2>/dev/null)
    case "$THEME_REASON" in
        theme-unlinked)
            trace "not-linted: theme is not linked ($TALK_ROOT)"
            notify_not_linted "The theme could not be resolved (reason: theme-unlinked). ${THEME_DETAIL}
Relinking node_modules with slide_sync (node_modules_only: true) restores it."
            ;;
        theme-none)
            trace "not-linted: talk-dir does not reference a theme ($TALK_ROOT)"
            notify_not_linted "The theme could not be resolved (reason: theme-none). ${THEME_DETAIL}"
            ;;
        theme-*)
            trace "not-linted: theme declaration cannot be read ($THEME_REASON)"
            notify_not_linted "The theme declaration could not be read (reason: ${THEME_REASON}). ${THEME_DETAIL}"
            ;;
        *)
            trace "not-linted: slide theme failed (exit $THEME_EXIT)${THEME_ERR:+ / stderr: $THEME_ERR}"
            notify_not_linted "The theme declaration could not be fetched (slide theme exited with $THEME_EXIT). ${THEME_ERR:+
stderr: $THEME_ERR}
Running the \`pecotv\` command once runs the plugin bootstrap, which restores it."
            ;;
    esac
    exit 0
fi

LINT_JSON=$(printf '%s\n' "$THEME_JSON" | jq -c '.lint // empty' 2>/dev/null)
if [ -z "$LINT_JSON" ]; then
    trace "not-linted: slide theme output has no lint"
    notify_not_linted "The lint input could not be read from the slide theme output (theme: ${THEME_DIR:-unresolved})."
    exit 0
fi

# ESLint を実行する。PostToolUse は検出専用なので --no-fix を付ける。
# wrapper 側は --fix で自動整形する。
# 探索は logical、実行 cwd は物理にする（eslint の base path の導出に合わせる）。
ESLINT_OUTPUT=$(CDPATH= cd -P "$TALK_ROOT" && PECOTV_DECK_LINT="$LINT_JSON" timeout 30 \
    node "$ESLINT_BIN" \
    --no-fix --config "$DECK_LINT_CONFIG" \
    "$REL_FILE" 2>&1)
ESLINT_EXIT=$?

# 出力は最大 100 行にする。終了コードを捕捉した後に行うこと。
# ここで別コマンドを挟むと、どの分岐も exit 0 になり、分類が崩れる。
ESLINT_OUTPUT=$(echo "$ESLINT_OUTPUT" | head -n 100)

if [ $ESLINT_EXIT -eq 0 ]; then
    # カナリア。base path 外の判定は、lint 対象が丸ごと lint されなかったことを意味する。
    # 相対パス方式では通常ここに来ない。
    # ESLint が base path の導出を変えると、検出されないまま skip する状態に戻る。
    # 例は、将来のメジャーで config ファイルの位置が基準になる場合。
    # それを検知する保険として残す。
    # grep は "outside of base path" だけにする。
    # eslint 10 の base path 外のメッセージも、設定対象外のメッセージも、"File ignored because ..." で始まる。
    # 広い "File ignored" で拾うと、下の設定対象外の分岐と衝突する。
    if echo "$ESLINT_OUTPUT" | grep -q "outside of base path"; then
        trace "canary: eslint judged the file outside its base path (arg: $REL_FILE / talk root: $TALK_ROOT)"
        CANARY_MESSAGE=$(hook_message warning "eslint skipped: $FILE_PATH

eslint did not lint the file because it judged the file to be outside its base path (talk root: $TALK_ROOT / eslint argument: $REL_FILE). No lint ran, so violations in this file have not been detected.")
        jq -n --arg message "$CANARY_MESSAGE" '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": $message}}'
        exit 0
    fi

    if [ -z "$ESLINT_OUTPUT" ]; then
        trace "pass: no violations ($REL_FILE)"
        exit 0
    fi

    # 設定対象外。lint 対象のパスなら、config 側の不整合で lint が行われなかったことになる。
    # その場合は model に伝える。
    # 対象外のパス（talk-dir 内の README.md 等）は、正当な skip。
    if echo "$ESLINT_OUTPUT" | grep -q "no matching configuration"; then
        trace "not-linted: lint target path judged outside the configuration ($REL_FILE)"
        notify_not_linted "eslint judged the file to be outside its configuration (eslint argument: $REL_FILE / talk root: $TALK_ROOT). The path is a lint target, so the eslint config may be inconsistent."
        exit 0
    fi

    # exit 0 で、未知の出力が空でないとき。
    # node の ExperimentalWarning 等が 2>&1 で出力に入る場合がある。
    # 違反として報告すると誤報になる（この hook が防いでいる誤報と同じ形）。
    # pass として扱い、trace に残す。transcript から追えるようにするため。
    UNKNOWN_HEAD=$(echo "$ESLINT_OUTPUT" | head -n 3 | tr '\n' ' ')
    trace "pass: exit 0 with unrecognized output ($UNKNOWN_HEAD)"
    exit 0
fi

# eslint のクラッシュバナー。exit code によらず、クラッシュを見分ける第 2 の手掛かり。
# カナリアと同じく文言をピン留めする（ピン留めのテストで、文言と exit code を固定する）。
# eslint 10 でこの文言を出すのは、bin/eslint.js の onFatalError だけ。
# この関数は文言より前に、exitCode 2 と hadFatalError を立てる。
# lint 結果の 1 や 0 で上書きされないよう、ガードもしている。
# そのため現行の eslint で「バナー + exit 1」は起こらない。
# 下の exit 1 側の判定は、将来 eslint が exit code の割り当てを変えた場合の保険。
# クラッシュが exit 1 で終わっても、lint されていないファイルの修正指示は model へ流さない。
# バナー文言は、違反の stylish 出力には混入しない。md 本文に同じ文字列があっても同じ。
CRASH_BANNER="Oops! Something went wrong"
ESLINT_CRASHED=false
echo "$ESLINT_OUTPUT" | grep -q "$CRASH_BANNER" && ESLINT_CRASHED=true

# 違反とするのは、exit 1 で出力があり、クラッシュでないものだけ。
# それ以外の非 0 と、非 0 で出力が空のものは、lint が最後まで動いていない。
# 非 0 の例は、config fatal の 2、timeout の 124、cd 失敗、127 など。
# これらは未実施として扱う。
if [ $ESLINT_EXIT -eq 1 ] && [ -n "$ESLINT_OUTPUT" ] && [ "$ESLINT_CRASHED" = false ]; then
    trace "violation: violations found ($REL_FILE)"
    # stylish の出力は空行で始まるので、見出しの後の空行が重ならないよう先頭の空行を落とす。
    ESLINT_BODY=$(printf '%s\n' "$ESLINT_OUTPUT" | sed '/./,$!d')
    VIOLATION_MESSAGE=$(hook_message warning "eslint violations: $FILE_PATH

$ESLINT_BODY

The output above lists the eslint violations in this file.")
    jq -n --arg message "$VIOLATION_MESSAGE" '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": $message}}'
    exit 0
fi

if [ "$ESLINT_CRASHED" = true ]; then
    REASON="eslint crashed (exit $ESLINT_EXIT / config resolution failure, plugin load failure, etc.)"
else
    case $ESLINT_EXIT in
        124) REASON="eslint timed out (over 30 seconds)" ;;
        2)   REASON="eslint exited with a fatal error (exit 2 / config resolution failure, etc.)" ;;
        *)   REASON="eslint exited abnormally (exit $ESLINT_EXIT)" ;;
    esac
fi

HEAD=$(echo "$ESLINT_OUTPUT" | head -n 10)
trace "not-linted: $REASON ($(echo "$HEAD" | head -n 3 | tr '\n' ' '))"
notify_not_linted "$REASON.${HEAD:+
eslint output: $HEAD}"
