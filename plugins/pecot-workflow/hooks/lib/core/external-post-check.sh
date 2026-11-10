#!/bin/bash
# 外部反映コマンドを検出し、ユーザー承認（ask）を要求するコアチェックスクリプト。
# 対象は、pecot pr create 実投稿 / gh pr merge / pecot issue quick・create 実投稿。
#
# 入力は環境変数 HOOK_COMMAND（確認対象のコマンド文字列）。
# 出力は次のとおり。
#   exit 0  + 空stdout = 素通し（承認不要）。
#   exit 11 + stdout   = ask（ユーザー承認を要求。理由テキスト）。
#   exit 2  + stderr   = 内部エラー（HOOK_COMMAND 未設定）。
#
# 検出パターンは次のとおり。
# HOOK_COMMAND を区切り文字でセグメント分割し、各セグメントを個別に判定する。
# 捕捉するのは、セグメント先頭（環境変数前置のみ許容）で起動形に一致した場合で、1 セグメントでも該当すれば確定する。
# `pecot pr create --prepare && pecot pr create body.md` のように、確認フラグ付きセグメントと実投稿セグメントが連結された場合も、後者で確定になる。
# time / xargs / { …; } のように別語を前置した形は、セグメント先頭に一致せず捕捉できない（検出抜け）。
#   - pecot issue quick / issue create（実投稿）→ ask  … pecot-issue-create-ask
#   - pecot pr create <file> / -m 直接指定（実投稿）→ ask … pecot-pr-create-ask
#   - gh pr merge → ask（/w-merge 起点フラグ存在時は素通し） … gh-pr-merge-ask。
#   pecot 起動形は pecot / $PECOT / "$PECOT" / フルパス / クオート付きパスを捕捉する。
#   クオート付きパスは "${CLAUDE_PLUGIN_ROOT}/bin/pecot" を含む。${PECOT} 展開形は対象外。
#
# 検出しないパターンは次のとおり。
#   - --prepare / -p（issue/pr 共通の確認用フラグ）、--dry-run / -n（pr create のみ）
#     … 同一セグメント内にある場合。
#   - pecot issue read / pr read / pr cleanup / pr preflight 等（対象外サブコマンド）
#   - echo "gh pr merge"（文字列内・区切り前置なし）
#   - config キー false 時
#   - スラッシュコマンド起点フラグ存在時。
#     これはユーザー明示指示の免除で、フラグは user-prompt-submit/create-slash-flag.sh が設置する。
#     CLI が実投稿成功時に消費し、本スクリプトは存在確認のみで削除しない。
#       pecot issue quick/create … HOOK_WORKING_DIR/.pecot/state/issue-create-slash-pending。
#       pecot pr create          … HOOK_WORKING_DIR/.pecot/state/pr-create-slash-pending。
#       gh pr merge              … HOOK_WORKING_DIR/.pecot/state/merge-slash-pending。
#         消費は pecot pr cleanup の成功時。gh pr merge の時点では消さない（マージ待ちのあと cleanup を打つため）。
#   gh pr merge は確認フラグの免除を持たない。
#
# 正規表現は POSIX ERE の [[:space:]] を使用する。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"

if [ -z "$HOOK_COMMAND" ]; then
  hook_message error "HOOK_COMMAND environment variable is required" >&2
  exit 2
fi

# 改行区切りのコマンド（例: $'echo done\ngh pr merge 5'）を ; と同じ区切りとして
# 扱うため、パターンマッチ前に正規化する。
HOOK_COMMAND="${HOOK_COMMAND//$'\n'/;}"

# クオート正規化: パターンマッチとスコープ抽出を同一文字列で行うための前処理。
#   - 空白を含むクオート span（引数値・デコイ文字列）は、スパンごと除去する。
#     例は -m "fix -n bug" / echo "&& gh pr merge -n stuff"。
#     内部の疑似コマンド・疑似フラグを無効化する（クオート内 -n を除外フラグと誤認しない既存挙動を維持）。
#   - 空白を含まないクオート（コマンドパス）は、アンラップしてパスを裸にする。
#     例は "$PECOT" / '/home/user/pecot' / "${CLAUDE_PLUGIN_ROOT}/bin/pecot"。
#     _PECOT の裸パス形で捕捉できるようにする。
_dequote() {
  printf '%s' "$1" \
    | sed "s/'[^']* [^']*'//g" \
    | sed 's/"[^"]* [^"]*"//g' \
    | tr -d "'\""
}
HOOK_COMMAND="$(_dequote "$HOOK_COMMAND")"

# セグメント先頭アンカー: 判定は _split_segments で分割済みのセグメント単位で行うため、
# 区切り文字は含めず「セグメント先頭 + 任意の環境変数前置」だけを見る。
_SEG_ANCHOR='^[[:space:]]*([A-Z_]+=[^ ]*[[:space:]]+)*'
# pecot 起動形（クオート正規化後の裸形）: $PECOT / フルパス(/…/pecot) / pecot。
_PECOT='(\$PECOT|[^[:space:]]*/pecot|pecot)'
# gh 起動形: gh / フルパス(/…/gh)。
_GH='(/[^ ]*/)?gh'

PECOT_PR_CREATE_PATTERN="${_SEG_ANCHOR}${_PECOT}[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
PECOT_ISSUE_CREATE_PATTERN="${_SEG_ANCHOR}${_PECOT}[[:space:]]+issue[[:space:]]+(quick|create)([[:space:]]|$)"
GH_PR_MERGE_PATTERN="${_SEG_ANCHOR}${_GH}[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)"

# 除外フラグ（語境界つき、位置不問）。pecot 専用（gh pr merge には適用しない）。
# pr create は --dry-run / -n を持つが issue create には無いため個別に定義する。
PECOT_PR_SKIP_PATTERN='(^|[[:space:]])(--prepare|-p|--dry-run|-n)([[:space:]]|=|$)'
PECOT_ISSUE_SKIP_PATTERN='(^|[[:space:]])(--prepare|-p)([[:space:]]|=|$)'

# コマンド文字列を区切り文字（; && || & | ` $( ( ) ）で分割し、改行区切りで出力する。
# 分割後の各セグメントが 1 コマンド相当となり、確認フラグの比較を同一コマンド内に
# 限定できる。&& は単独 & より先に置換し、|| は | より先に置換する（2 文字の区切りを
# 先に消費させる）。2>&1 等のリダイレクトも分割されるが、断片はパターンに一致しない
# ため誤検知にはならない。クオートは _dequote 済みのため除去不要。
_split_segments() {
  local s="$1"
  s=${s//&&/$'\n'}
  s=${s//&/$'\n'}
  s=${s//||/$'\n'}
  s=${s//;/$'\n'}
  s=${s//|/$'\n'}
  s=${s//\`/$'\n'}
  s=${s//\$(/$'\n'}
  s=${s//)/$'\n'}
  s=${s//(/$'\n'}
  printf '%s' "$s"
}

# config キー有効かつ、いずれかのセグメントが pattern に一致した時点で ask（exit 11）で終了する共通ヘルパー。
# 判定はセグメント単位で行う。
# skip_pattern が非空で同一セグメント内に一致した場合のみ、そのセグメントを素通しする（確認フラグ免除）。
# skip_pattern が空文字なら免除なし（gh pr merge 用）。
# flag_file が非空で存在する場合は、コマンド全体を素通しする。
# これはスラッシュコマンド起点の免除で、存在確認のみで削除しない。確認フラグ免除の後に評価する。
#
# ループ入力は here-string で渡す。
# パイプだとサブシェルになり、exit がスクリプト全体へ及ばず素通しになる。
_external_post_check() {
  local config_key="$1" pattern="$2" skip_pattern="$3" message="$4" flag_file="$5"
  pecot_hook_enabled "$config_key" true || return 0
  local seg
  while IFS= read -r seg; do
    [[ "$seg" =~ $pattern ]] || continue
    if [ -n "$skip_pattern" ] && [[ "$seg" =~ $skip_pattern ]]; then
      continue
    fi
    if [ -n "$flag_file" ] && [ -f "$flag_file" ]; then
      return 0
    fi
    hook_message warning "$message"
    exit 11
  done <<< "$(_split_segments "$HOOK_COMMAND")"
  return 0
}

ISSUE_MSG='external-post-check: pecot issue quick / pecot issue create (a real post) publishes an Issue externally.

Do not run it until the user has explicitly approved.
The canonical routes for filing are these skills:
/pecot-w:w-quick, /pecot-w:w-ready, /pecot-w:w-backlog, /pecot-w:w-issueize.
To only generate a template, add --prepare (or -p) to pecot issue create
The quick subcommand has no --prepare / -p.'

CREATE_MSG='external-post-check: pecot pr create (a real post) publishes a PR externally.

Do not run it until the user has explicitly approved.
To only review the content, use --prepare / -p (template generation) or --dry-run / -n.'

GH_MSG='external-post-check: gh pr merge publishes a PR merge externally.

Do not run it until the user has explicitly approved.
The canonical route for merging is /pecot-w:w-merge.
Merge with gh pr merge, then clean up with pecot pr cleanup.'

# スラッシュコマンド起点の免除フラグ。
# 設置は user-prompt-submit の create-slash-flag.sh、消費は CLI が実投稿成功時（merge は pecot pr cleanup 成功時）に削除する。
# 残骸掃除は session-start の create-slash-cleanup.sh が担う。
#
# 設置側は CLAUDE_PROJECT_DIR を参照するが、本スクリプトは HOOK_WORKING_DIR を参照する。
# Claude Code 経由では、claude-bash-guards.sh が HOOK_WORKING_DIR=CLAUDE_PROJECT_DIR を export するため一致する。
# Copilot CLI 手段（git toplevel 由来）でずれた場合は、免除が働かず ask のまま（fail-safe）。
# 参照の統一はしない。
PR_SLASH_FLAG="${HOOK_WORKING_DIR}/.pecot/state/pr-create-slash-pending"
ISSUE_SLASH_FLAG="${HOOK_WORKING_DIR}/.pecot/state/issue-create-slash-pending"
MERGE_SLASH_FLAG="${HOOK_WORKING_DIR}/.pecot/state/merge-slash-pending"

# pecot issue quick / create（実投稿）: 確認フラグ免除・スラッシュコマンドフラグ免除あり。ask。
_external_post_check "pecot-issue-create-ask" "$PECOT_ISSUE_CREATE_PATTERN" "$PECOT_ISSUE_SKIP_PATTERN" "$ISSUE_MSG" "$ISSUE_SLASH_FLAG"
# pecot pr create（実投稿）: 確認フラグ免除・スラッシュコマンドフラグ免除あり。ask。
_external_post_check "pecot-pr-create-ask" "$PECOT_PR_CREATE_PATTERN" "$PECOT_PR_SKIP_PATTERN" "$CREATE_MSG" "$PR_SLASH_FLAG"
# gh pr merge: 確認フラグ免除なし。/w-merge 起点フラグがあれば素通し（存在確認のみ・削除しない）。
_external_post_check "gh-pr-merge-ask" "$GH_PR_MERGE_PATTERN" "" "$GH_MSG" "$MERGE_SLASH_FLAG"

exit 0
