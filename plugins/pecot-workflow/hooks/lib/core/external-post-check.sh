#!/bin/bash
# 外部反映コマンド（pecot pr create / pecot issue quick・create の実投稿、gh pr merge）を検出し、ask を要求するコアチェック。
# 入力は HOOK_COMMAND。出力は exit 0 + 空 stdout = 素通し、exit 11 + stdout = ask、exit 2 + stderr = 内部エラー。
# HOOK_COMMAND をセグメントに分け、セグメント先頭（環境変数前置のみ許容）の起動形で判定する。確認フラグ（--prepare / -p / --dry-run / -n / --help）は同一セグメント内だけ見る。
# time / xargs / { …; } / ${PECOT} など、別語を前置した形や展開形は捕捉できない（検出抜け）。
# スラッシュコマンド起点のフラグ（.pecot/state/*-pending）は存在確認のみで削除しない。消費は CLI 側（merge は pecot pr cleanup の成功時）。
# 正規表現は POSIX ERE の [[:space:]] を使う。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"
source "${SCRIPT_DIR}/command-segments.sh"

if [ -z "$HOOK_COMMAND" ]; then
  hook_message error "HOOK_COMMAND environment variable is required" >&2
  exit 2
fi

# 改行区切りを ; と同じ区切りとして扱い、クオートを正規化してから判定する。
HOOK_COMMAND="${HOOK_COMMAND//$'\n'/;}"
HOOK_COMMAND="$(_dequote "$HOOK_COMMAND")"

PECOT_PR_CREATE_PATTERN="${_SEG_ANCHOR}${_PECOT}[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
PECOT_ISSUE_CREATE_PATTERN="${_SEG_ANCHOR}${_PECOT}[[:space:]]+issue[[:space:]]+(quick|create)([[:space:]]|$)"
GH_PR_MERGE_PATTERN="${_SEG_ANCHOR}${_GH}[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)"

# 除外フラグ（語境界つき、位置不問）。pecot 専用（gh pr merge には適用しない）。
# pr create は --dry-run / -n を持つが issue create には無いため個別に定義する。
PECOT_PR_SKIP_PATTERN='(^|[[:space:]])(--prepare|-p|--dry-run|-n|--help)([[:space:]]|=|$)'
PECOT_ISSUE_SKIP_PATTERN='(^|[[:space:]])(--prepare|-p|--help)([[:space:]]|=|$)'

# config キー有効かつ、いずれかのセグメントが pattern に一致した時点で ask（exit 11）する。
# skip_pattern は同一セグメント内に一致したら素通し（空なら免除なし）。flag_file が存在すればコマンド全体を素通しする。
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

# スラッシュコマンド起点の免除フラグ（設置は user-prompt-submit、残骸掃除は session-start）。
# 設置側は CLAUDE_PROJECT_DIR、本スクリプトは HOOK_WORKING_DIR を見る。ずれたときは免除が働かず ask のまま（fail-safe）。
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
