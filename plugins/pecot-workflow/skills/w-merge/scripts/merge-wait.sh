#!/usr/bin/env bash
# merge-wait.sh - PR がマージされるまで待ち、待てない状態になったら理由を出して抜ける。
#
# 使い方: merge-wait.sh <owner>/<repo>/<PR番号> [--interval <秒>] [--settle-seconds <秒>] [--stall-minutes <分>]
#
# 待つのは「merge queue の中」と「auto-merge の予約があり、チェックが終わっていない」の 2 つだけ。
# ほかの状態は、理由を stdout に出して抜ける。終了コードは、merged が 0、ほかの理由が 1、引数の誤りが 2。
# gh と gh --jq だけを使う。pecot と単体の jq は呼ばない。
#
# source したテスト側のシェルの設定を変えないよう、set は末尾のガードの中に置く。

# 判定。語を引数で受け、wait:<理由> か exit:<理由> を stdout に返す。
# 引数は 7 つ。
# $1 は state。
# $2 は isInMergeQueue。
# $3 は auto-merge の予約の有無。
# $4 は mergeable。
# $5 は必須チェックの失敗の有無。
# $6 はチェックが終わっていないか。
# $7 は mergeStateStatus（判定には使わない）。
# 待つのは in-queue と checks-running だけで、上のどれでもない状態（未知の値を含む）は blocked。
merge_wait_decide() {
  local state="$1" in_queue="$2" auto_merge="$3" mergeable="$4" failed="$5" running="$6"
  if [[ "$state" == "MERGED" ]]; then
    echo "exit:merged"
  elif [[ "$state" == "CLOSED" ]]; then
    echo "exit:closed"
  elif [[ "$mergeable" == "CONFLICTING" ]]; then
    echo "exit:conflicting"
  elif [[ "$failed" == "true" ]]; then
    echo "exit:required-failed"
  elif [[ "$in_queue" == "true" ]]; then
    echo "wait:in-queue"
  elif [[ "$auto_merge" == "true" && "$running" == "true" ]]; then
    echo "wait:checks-running"
  elif [[ "$auto_merge" != "true" ]]; then
    echo "exit:not-queued"
  else
    echo "exit:blocked"
  fi
}

# PR の状態を GraphQL で 1 回読み、"|" 区切りの 1 行にする。欄の順は次のとおり。
# 前半は state|queue|auto|mergeable|mergeStateStatus|base。
# 後半は required-failed|required-pending|pending|total|name|name|...。
# 未完了の数は checkRunCountsByState と statusContextCountsByState から取る（100 件の上限を受けない）。
# 必須かどうかと名前は、先頭 100 件のノードから取る。
merge_wait_query() {
  local owner="$1" repo="$2" pr="$3"
  local query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){state isInMergeQueue mergeable mergeStateStatus baseRefName autoMergeRequest{enabledAt} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){checkRunCount statusContextCount checkRunCountsByState{state count} statusContextCountsByState{state count} nodes{... on CheckRun{name conclusion isRequired(pullRequestNumber:$n)} ... on StatusContext{context state isRequired(pullRequestNumber:$n)}}}}}}}}}}'
  local expr='.data.repository.pullRequest as $p
    | ($p.commits.nodes[0].commit.statusCheckRollup.contexts // {}) as $c
    | [($c.nodes // [])[] | {name: (.name // .context // ""), r: (.isRequired // false), s: (.conclusion // .state // "")}] as $n
    | [ $p.state, $p.isInMergeQueue, ($p.autoMergeRequest != null), $p.mergeable, $p.mergeStateStatus, $p.baseRefName,
        ([$n[] | select(.r and (.s | IN("FAILURE","ERROR","CANCELLED","TIMED_OUT","ACTION_REQUIRED","STARTUP_FAILURE")))] | length),
        ([$n[] | select(.r and (.s | IN("","PENDING","EXPECTED")))] | length),
        (([($c.checkRunCountsByState // [])[] | select(.state | IN("IN_PROGRESS","PENDING","QUEUED","WAITING","REQUESTED")) | .count] | add // 0)
          + ([($c.statusContextCountsByState // [])[] | select(.state | IN("PENDING","EXPECTED")) | .count] | add // 0)),
        (($c.checkRunCount // 0) + ($c.statusContextCount // 0)),
        ($n | map(.name) | join("|")) ]
      | map(tostring) | join("|")'
  gh api graphql -F o="$owner" -F r="$repo" -F n="$pr" -f query="$query" --jq "$expr"
}

# base に掛かっているルールの type と、必須チェックの名前を取る（起動後 1 回）。
# 結果は MW_RULES_TYPES（", " 区切り）と MW_RULES_REQUIRED（"|" 区切り）、失敗は MW_RULES_ERROR に入れる。
merge_wait_rules() {
  local owner="$1" repo="$2" base="$3" out err_file
  MW_RULES_TYPES="" MW_RULES_REQUIRED="" MW_RULES_ERROR=""
  err_file="$MW_ERR_FILE"
  local expr='([.[].type] | reduce .[] as $t ([]; if index($t) then . else . + [$t] end) | join(", ")),
    ([.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | join("|"))'
  if ! out=$(gh api "repos/${owner}/${repo}/rules/branches/${base}" --jq "$expr" 2>"$err_file"); then
    MW_RULES_ERROR=$(merge_wait_http_status "$(cat "$err_file")")
    return 0
  fi
  MW_RULES_TYPES=$(printf '%s\n' "$out" | sed -n 1p)
  MW_RULES_REQUIRED=$(printf '%s\n' "$out" | sed -n 2p)
}

# gh の stderr から "HTTP 404" の形を取り出す。無ければ 1 行目をそのまま返す。
merge_wait_http_status() {
  local text="$1"
  if [[ "$text" =~ HTTP\ ([0-9]+) ]]; then
    echo "HTTP ${BASH_REMATCH[1]}"
  else
    printf '%s\n' "$text" | sed -n 1p
  fi
}

# 3 行目以降（blocked と stalled のときだけ）。止めているルールの type と、code scanning の開いているアラート。
merge_wait_explain() {
  local owner="$1" repo="$2" pr="$3" base="$4" out
  if [[ -n "$MW_RULES_ERROR" ]]; then
    echo "rules(${base}): 取得できない (${MW_RULES_ERROR})"
  elif [[ -z "$MW_RULES_TYPES" ]]; then
    echo "rules(${base}): なし"
  else
    echo "rules(${base}): ${MW_RULES_TYPES}"
  fi
  if [[ ", ${MW_RULES_TYPES}," == *", code_scanning,"* ]]; then
    if out=$(gh api "repos/${owner}/${repo}/code-scanning/alerts?state=open&pr=${pr}" \
      --jq '[sort_by(.number)[].number | "#\(.)"] | join(" ")' 2>"$MW_ERR_FILE"); then
      echo "code-scanning open alerts: ${out:-なし}"
    else
      out=$(merge_wait_http_status "$(cat "$MW_ERR_FILE")")
      echo "code-scanning open alerts: 取得できない (${out})"
    fi
  fi
}

merge_wait_usage() {
  echo "usage: merge-wait.sh <owner>/<repo>/<PR番号> [--interval <秒>] [--settle-seconds <秒>] [--stall-minutes <分>]" >&2
}

# 理由と最後の状態を出す。blocked と stalled のときだけ、ルールとアラートも出す。
merge_wait_emit() {
  local reason="$1" state_line="$2" owner="$3" repo="$4" pr="$5" base="$6"
  echo "merge-wait: ${reason}"
  echo "state: ${state_line}"
  if [[ "$reason" == "blocked" || "$reason" == "stalled" ]]; then
    merge_wait_explain "$owner" "$repo" "$pr" "$base"
  fi
}

main() {
  local target="" interval=30 settle=120 stall_minutes=15
  while (($# > 0)); do
    case "$1" in
      --interval | --settle-seconds | --stall-minutes)
        if (($# < 2)) || ! [[ "$2" =~ ^[0-9]+$ ]]; then
          merge_wait_usage
          return 2
        fi
        case "$1" in
          --interval) interval="$2" ;;
          --settle-seconds) settle="$2" ;;
          *) stall_minutes="$2" ;;
        esac
        shift 2
        ;;
      -*)
        merge_wait_usage
        return 2
        ;;
      *)
        if [[ -n "$target" ]]; then
          merge_wait_usage
          return 2
        fi
        target="$1"
        shift
        ;;
    esac
  done
  if ! [[ "$target" =~ ^([^/]+)/([^/]+)/([0-9]+)$ ]]; then
    merge_wait_usage
    return 2
  fi
  local owner="${BASH_REMATCH[1]}" repo="${BASH_REMATCH[2]}" pr="${BASH_REMATCH[3]}"

  MW_ERR_FILE=$(mktemp)
  trap 'rm -f "$MW_ERR_FILE"' EXIT
  MW_RULES_TYPES="" MW_RULES_REQUIRED="" MW_RULES_ERROR=""

  local fails=0 rules_loaded=false base="" out
  local last_line="" same_since=0 prev_reason="" reason_since=0 now
  local state queue auto mergeable mss failed rpend pend total names
  local missing running required state_line decision kind reason n
  local -a req_names

  while true; do
    if ! out=$(merge_wait_query "$owner" "$repo" "$pr" 2>"$MW_ERR_FILE"); then
      fails=$((fails + 1))
      if ((fails >= 3)); then
        echo "merge-wait: query-failed"
        echo "state: 取得できない"
        cat "$MW_ERR_FILE"
        return 1
      fi
      sleep "$interval"
      continue
    fi
    fails=0

    IFS='|' read -r state queue auto mergeable mss base failed rpend pend total names <<<"$out"
    if [[ "$rules_loaded" == "false" ]]; then
      merge_wait_rules "$owner" "$repo" "$base"
      rules_loaded=true
    fi

    # ruleset が必須にしているチェックの名前のうち、まだ報告されていないものを数える。
    # 報告が 100 件を超えるときは名前を見切れないので数えない。
    missing=0
    if ((total <= 100)); then
      IFS='|' read -ra req_names <<<"$MW_RULES_REQUIRED"
      for n in ${req_names[@]+"${req_names[@]}"}; do
        [[ -n "$n" ]] || continue
        [[ "|${names}|" == *"|${n}|"* ]] || missing=$((missing + 1))
      done
    fi
    running=false
    if ((pend + missing > 0)); then running=true; fi
    required=passed
    if ((failed > 0)); then
      required=failed
    elif ((rpend + missing > 0)); then
      required=pending
    fi
    state_line="${state} queue=${queue} auto-merge=${auto} mergeable=${mergeable} mergeStateStatus=${mss} required=${required} checks-pending=$((pend + missing))"

    decision=$(merge_wait_decide "$state" "$queue" "$auto" "$mergeable" "$([[ "$failed" -gt 0 ]] && echo true || echo false)" "$running" "$mss")
    kind="${decision%%:*}"
    reason="${decision#*:}"
    now=$(date +%s)

    if [[ "$kind" == "exit" ]]; then
      case "$reason" in
        blocked | not-queued)
          # GitHub が queue へ入れるまでの数十秒や、mergeStateStatus の計算中は、この判定に当たる。続いてから抜ける。
          if [[ "$reason" != "$prev_reason" ]]; then
            prev_reason="$reason"
            reason_since="$now"
          fi
          if ((now - reason_since >= settle)); then
            merge_wait_emit "$reason" "$state_line" "$owner" "$repo" "$pr" "$base"
            return 1
          fi
          ;;
        merged)
          merge_wait_emit "$reason" "$state_line" "$owner" "$repo" "$pr" "$base"
          return 0
          ;;
        *)
          merge_wait_emit "$reason" "$state_line" "$owner" "$repo" "$pr" "$base"
          return 1
          ;;
      esac
    else
      prev_reason=""
    fi

    # 状態の行が変わらないまま上限を超えたら、待つ判定でも抜ける。
    if [[ "$state_line" != "$last_line" ]]; then
      last_line="$state_line"
      same_since="$now"
    elif [[ "$kind" == "wait" ]] && ((now - same_since >= stall_minutes * 60)); then
      merge_wait_emit "stalled" "$state_line" "$owner" "$repo" "$pr" "$base"
      return 1
    fi
    sleep "$interval"
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  main "$@"
fi
