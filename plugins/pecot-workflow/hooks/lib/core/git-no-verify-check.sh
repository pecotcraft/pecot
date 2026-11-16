#!/bin/bash
# git のフックを飛ばす形を検出するコアチェックスクリプト。
# 初期値は無効。hooks-config.json で "git-no-verify-check": true にしたときだけ動く。
#
# 入力は環境変数 HOOK_COMMAND（確認対象のコマンド文字列）。
# 出力は次のとおり。
#   exit 0 + 空stdout = 許可
#   exit 1 + stdout   = ブロック（理由テキスト）
#   exit 2 + stderr   = 内部エラー。
#
# ブロックするパターンは次のとおり。
#   - --no-verify（全サブコマンド）、git commit -n・-anm x、引用符で囲んだ "--no-verify"・'-n'
#   - git -c core.hooksPath=...、git config で core.hooksPath を書く・消す形（set・unset・--unset を含む）
#   - SKIP=... / HUSKY=0 を前に置いた、フックを呼ぶ git のサブコマンド（commit・push など）
#
# 検出しないパターンは次のとおり。
#   - git log --no-merges、echo "--no-verify"、git status | head -n 5
#   - 値を取るオプションの値（git commit -m "-n"・-mn・-Fnote）、引用符の中の区切り
#   - commit 以外の -n（git log -n 5・git push -n。push -n は --dry-run）
#   - 読む形（git config --get core.hooksPath・get・値の無い形）、git -c user.name=x
#   - SKIP=x git status など、フックを呼ばないサブコマンド
#   - ヒアドキュメントの本文

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"
pecot_hook_enabled "git-no-verify-check" false || exit 0

if [ -z "$HOOK_COMMAND" ]; then
  hook_message error "HOOK_COMMAND environment variable is required" >&2
  exit 2
fi

# bash 3.2（macOS 標準）でも動くよう、${var,,} と連想配列は使わない。
to_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# 引用符を考えてトークンに分け、引用符の外の && || ; | & 改行を区切りにする。ヒアドキュメントの本文は飛ばす。
# 長いコマンドでも線形の時間で済むよう、awk で 1 回だけ読み通す。出力は 1 行 1 トークン（S = 区切り、W/Q = 先頭が引用符でない/引用符の語）。
# shellcheck disable=SC2016
TOKENIZE_AWK='
function flush() {
  if (kind != "") { gsub(/\n/, " ", cur); print kind cur }
  cur = ""; kind = ""
}
function piece(text, quoted) {
  if (kind == "") kind = quoted ? "Q" : "W"
  cur = cur text
}
function separator() { flush(); print "S" }
function special(c) {
  return c == " " || c == "\t" || c == "\n" || c == ";" || c == "&" || c == "|" || c == "<" || c == ">" || c == sq || c == "\"" || c == "\\"
}
function heredoc(   dash, delim, c) {
  i += 2
  if (substr(s, i, 1) == "-") { dash = 1; i++ }
  while (substr(s, i, 1) == " " || substr(s, i, 1) == "\t") i++
  delim = ""
  while (i <= n) {
    c = substr(s, i, 1)
    if (c != sq && c != "\"" && c != "\\" && special(c)) break
    if (c != sq && c != "\"" && c != "\\") delim = delim c
    i++
  }
  if (delim != "") { hcount++; hdelim[hcount] = delim; hdash[hcount] = dash }
}
function skip_bodies(   k, start, line) {
  for (k = 1; k <= hcount; k++) {
    while (i <= n) {
      start = i
      while (i <= n && substr(s, i, 1) != "\n") i++
      line = substr(s, start, i - start)
      i++
      if (hdash[k]) sub(/^\t+/, "", line)
      if (line == hdelim[k]) break
    }
  }
  hcount = 0
}
{ s = (NR > 1) ? s "\n" $0 : $0 }
END {
  sq = sprintf("%c", 39); n = length(s); i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == " " || c == "\t") { flush(); i++ }
    else if (c == "\n") { separator(); i++; if (hcount) skip_bodies() }
    else if (c == ";") { separator(); i++ }
    else if (c == "&" || c == "|") { separator(); i++; if (substr(s, i, 1) == c) i++ }
    else if (c == "#" && kind == "") { while (i <= n && substr(s, i, 1) != "\n") i++ }
    else if (substr(s, i, 2) == "<<" && substr(s, i + 2, 1) != "<") { flush(); heredoc() }
    else if (c == sq) {
      start = ++i
      while (i <= n && substr(s, i, 1) != sq) i++
      piece(substr(s, start, i - start), 1); i++
    }
    else if (c == "\"") {
      start = ++i
      while (i <= n && substr(s, i, 1) != "\"") { if (substr(s, i, 1) == "\\") i++; i++ }
      text = substr(s, start, i - start); gsub(/\\"/, "\"", text)
      piece(text, 1); i++
    }
    else if (c == "\\") {
      if (substr(s, i + 1, 1) != "\n") piece(substr(s, i + 1, 1), 0)
      i += 2
    }
    else if (special(c)) { piece(c, 0); i++ }
    else {
      start = i
      while (i <= n && !special(substr(s, i, 1))) i++
      piece(substr(s, start, i - start), 0)
    }
  }
  flush()
}
'

# KINDS: sep / word / qword（先頭が引用符の語。環境変数の代入と見なさない）。
TOKENS=()
KINDS=()
while IFS= read -r line; do
  case "$line" in
    S) TOKENS+=(""); KINDS+=(sep) ;;
    W*) TOKENS+=("${line#W}"); KINDS+=(word) ;;
    Q*) TOKENS+=("${line#Q}"); KINDS+=(qword) ;;
  esac
done < <(printf '%s\n' "$HOOK_COMMAND" | LC_ALL=C awk "$TOKENIZE_AWK")

RE_ASSIGNMENT='^([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
# commit の短いオプションのうち、値を取るもの（m F C c t）と値を省けるもの（u S）。
COMMIT_VALUE_SHORT='mFCct'
COMMIT_OPTIONAL_SHORT='uS'

is_hooks_path_key() {
  [[ "$(to_lower "$1")" == "core.hookspath" ]]
}

# git が client hook を呼ぶサブコマンド（SKIP= / HUSKY=0 で飛ばせるもの）か。
runs_hooks() {
  case "$1" in
    am|checkout|cherry-pick|clone|commit|merge|pull|push|rebase|revert|switch|worktree) return 0 ;;
  esac
  return 1
}

# 値を次のトークンで取るオプションか。$1 = サブコマンド、$2 = トークン。
takes_value() {
  local subcommand=$1 token=$2
  if [[ "$subcommand" == commit ]]; then
    case "$token" in
      --message|--file|--author|--date|--reuse-message|--reedit-message|--fixup|--squash|--template|--cleanup|--trailer|--pathspec-from-file) return 0 ;;
    esac
    return 1
  fi
  case "$token" in
    -m|-F|--message|--file) return 0 ;;
  esac
  return 1
}

# commit の短いオプションの束（-anm など）に、値を取るオプションより前の n があるか。
commit_bundle_has_n() {
  local bundle=${1#-} ch i
  for (( i = 0; i < ${#bundle}; i++ )); do
    ch=${bundle:i:1}
    [[ "$ch" == n ]] && return 0
    [[ "$COMMIT_VALUE_SHORT$COMMIT_OPTIONAL_SHORT" == *"$ch"* ]] && return 1
  done
  return 1
}

# commit の短いオプションの束が、次のトークンを値として取るか（-am x の m など）。
commit_bundle_takes_next() {
  local bundle=${1#-} ch i
  for (( i = 0; i < ${#bundle}; i++ )); do
    ch=${bundle:i:1}
    if [[ "$COMMIT_VALUE_SHORT" == *"$ch"* ]]; then
      (( i == ${#bundle} - 1 ))
      return
    fi
    [[ "$COMMIT_OPTIONAL_SHORT" == *"$ch"* ]] && return 1
  done
  return 1
}

# git config の引数（$@）が core.hooksPath を書く・消す形か。
config_writes_hooks_path() {
  local token skip_next=false positional=() unset=false read=false write_flag=false
  for token in "$@"; do
    if [[ "$skip_next" == true ]]; then
      skip_next=false
      continue
    fi
    case "$token" in
      -f|--file|--blob|--type|--default|--comment|--value) skip_next=true ;;
      --unset|--unset-all) unset=true ;;
      --get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|-l|--list) read=true ;;
      --add|--replace-all) write_flag=true ;;
      -*) ;;
      *) positional+=("$token") ;;
    esac
  done
  [[ ${#positional[@]} -gt 0 ]] || return 1

  case "${positional[0]}" in
    set|unset)
      [[ ${#positional[@]} -ge 2 ]] && is_hooks_path_key "${positional[1]}"
      return
      ;;
    get|list|edit|rename-section|remove-section)
      return 1
      ;;
  esac

  is_hooks_path_key "${positional[0]}" || return 1
  [[ "$unset" == true ]] && return 0
  [[ "$read" == true ]] && return 1
  [[ "$write_flag" == true ]] && return 0
  [[ ${#positional[@]} -ge 2 ]]
}

# 1 セグメント（$@ = トークン、$SEGMENT_KINDS = 種類）を判定する。止めるなら 0 を返す。
segment_blocked() {
  local -a words=("$@")
  local count=${#words[@]} i=0 env_skip=false name value

  # 前に置いた環境変数の代入を読み飛ばす。SKIP=... と HUSKY=0 を覚える。
  while (( i < count )); do
    [[ "${SEGMENT_KINDS[i]}" == word ]] || break
    [[ "${words[i]}" =~ $RE_ASSIGNMENT ]] || break
    name=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    if [[ "$name" == SKIP && -n "$value" ]] || [[ "$name" == HUSKY && "$value" == 0 ]]; then
      env_skip=true
    fi
    (( i++ ))
  done

  (( i < count )) || return 1
  [[ "${words[i]}" == git ]] || return 1
  (( i++ ))

  # git のグローバルオプション。
  while (( i < count )); do
    case "${words[i]}" in
      -c)
        (( i++ ))
        (( i < count )) && is_hooks_path_key "${words[i]%%=*}" && return 0
        ;;
      -C|--git-dir|--work-tree|--namespace|--super-prefix|--config-env)
        (( i++ ))
        ;;
      --no-verify)
        return 0
        ;;
      -*) ;;
      *) break ;;
    esac
    (( i++ ))
  done
  (( i < count )) || return 1

  local subcommand
  subcommand=$(to_lower "${words[i]}")
  (( i++ ))

  [[ "$env_skip" == true ]] && runs_hooks "$subcommand" && return 0

  if [[ "$subcommand" == config ]]; then
    config_writes_hooks_path "${words[@]:i}"
    return
  fi

  local token
  while (( i < count )); do
    token=${words[i]}
    if [[ "$token" == -- ]]; then
      break
    elif [[ "$token" == --no-verify ]]; then
      return 0
    elif takes_value "$subcommand" "$token"; then
      (( i++ ))
    elif [[ "$subcommand" == commit && "$token" =~ ^-[^-] ]]; then
      commit_bundle_has_n "$token" && return 0
      commit_bundle_takes_next "$token" && (( i++ ))
    fi
    (( i++ ))
  done
  return 1
}

blocked=false
segment=()
SEGMENT_KINDS=()
for (( t = 0; t <= ${#TOKENS[@]}; t++ )); do
  if (( t == ${#TOKENS[@]} )) || [[ "${KINDS[t]}" == sep ]]; then
    if [[ ${#segment[@]} -gt 0 ]] && segment_blocked "${segment[@]}"; then
      blocked=true
      break
    fi
    segment=()
    SEGMENT_KINDS=()
    continue
  fi
  segment+=("${TOKENS[t]}")
  SEGMENT_KINDS+=("${KINDS[t]}")
done

if [[ "$blocked" == true ]]; then
  hook_message error "git-no-verify-check: skipping git hooks is not allowed.

This project does not allow skipping CI or quality checks (pre-commit, pre-push, gitlint, etc.).
Every way of skipping hooks is blocked: --no-verify, -n on git commit, git -c core.hooksPath=...,
setting or unsetting core.hooksPath with git config, and SKIP=... or HUSKY=0 before git.

When a hook reports an error:
  1. Read the error message and identify what is violated
  2. Fix the root cause of the violation
  3. Re-run normally (without any skip option) after the fix"
  exit 1
fi

exit 0
