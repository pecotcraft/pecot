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
#   - SKIP=... / HUSKY=0 を前に置いた git のコマンド
#
# 検出しないパターンは次のとおり。
#   - git log --no-merges、echo "--no-verify"、git status | head -n 5
#   - 値を取るオプションの値（git commit -m "-n"・-mn・-Fnote）、引用符の中の区切り
#   - commit 以外の -n（git log -n 5・git push -n。push -n は --dry-run）
#   - 読む形（git config --get core.hooksPath・get・値の無い形）、git -c user.name=x

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

# 引用符の中の区切りで分けないよう、先にトークンへ分け、引用符の外の && || ; | & 改行を sep にする。
# KINDS: sep / word / qword（先頭が引用符の語。環境変数の代入と見なさない）。
TOKENS=()
KINDS=()

RE_BLANK='^[[:blank:]]+'
RE_NEWLINE=$'^\n'
RE_SEP='^(&&|\|\||;|\||&)'
RE_COMMENT=$'^#[^\n]*'
RE_PLAIN='^[^[:space:]"'"'"'\;&|]+'
RE_SQUOTE="^'([^']*)'"
RE_DQUOTE='^"(([^"\\]|\\.)*)"'
RE_ESCAPE='^\\(.)'

rest=$HOOK_COMMAND
current=""
current_kind=""

flush_word() {
  if [[ -n "$current_kind" ]]; then
    TOKENS+=("$current")
    KINDS+=("$current_kind")
  fi
  current=""
  current_kind=""
}

add_piece() {
  # $1 = 中身、$2 = 引用符で囲んだ片なら q
  if [[ -z "$current_kind" ]]; then
    if [[ "$2" == q ]]; then current_kind=qword; else current_kind=word; fi
  fi
  current+="$1"
}

while [[ -n "$rest" ]]; do
  if [[ "$rest" =~ $RE_BLANK ]]; then
    flush_word
  elif [[ "$rest" =~ $RE_NEWLINE ]] || [[ "$rest" =~ $RE_SEP ]]; then
    flush_word
    TOKENS+=("")
    KINDS+=(sep)
  elif [[ -z "$current_kind" ]] && [[ "$rest" =~ $RE_COMMENT ]]; then
    :
  elif [[ "$rest" =~ $RE_PLAIN ]]; then
    add_piece "${BASH_REMATCH[0]}"
  elif [[ "$rest" =~ $RE_SQUOTE ]]; then
    add_piece "${BASH_REMATCH[1]}" q
  elif [[ "$rest" =~ $RE_DQUOTE ]]; then
    add_piece "${BASH_REMATCH[1]}" q
  elif [[ "$rest" =~ $RE_ESCAPE ]]; then
    # 行の継続（\ + 改行）は何も足さない。
    [[ "${BASH_REMATCH[1]}" == $'\n' ]] || add_piece "${BASH_REMATCH[1]}"
  else
    # 閉じていない引用符・末尾の \ は、残りを 1 つの片として扱う。
    if [[ "${rest:0:1}" == "'" || "${rest:0:1}" == '"' ]]; then
      add_piece "${rest:1}" q
    else
      add_piece "${rest:1}"
    fi
    rest=""
    break
  fi
  rest=${rest:${#BASH_REMATCH[0]}}
done
flush_word

RE_ASSIGNMENT='^([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
# commit の短いオプションのうち、値を取るもの（m F C c t）と値を省けるもの（u S）。
COMMIT_VALUE_SHORT='mFCct'
COMMIT_OPTIONAL_SHORT='uS'

is_hooks_path_key() {
  [[ "$(to_lower "$1")" == "core.hookspath" ]]
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
  [[ "$env_skip" == true ]] && return 0
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
