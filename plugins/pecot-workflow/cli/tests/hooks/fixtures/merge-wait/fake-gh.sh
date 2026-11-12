#!/bin/bash
# merge-wait.sh のテスト用の偽の gh。応答は FAKE_GH_BASE 配下のファイルから返す。
base="$FAKE_GH_BASE"
[ "$1" = "api" ] || exit 96
args=("$@")
jq_expr="."
for ((i = 0; i < ${#args[@]} - 1; i++)); do
  [ "${args[i]}" = "--jq" ] && jq_expr="${args[i + 1]}"
done

count() { [ -f "$1" ] && cat "$1" || echo 0; }

emit() {
  if jq -e 'type == "object" and has("__error__")' "$1" > /dev/null; then
    jq -r '.__error__' "$1" >&2
    exit 1
  fi
  jq -r "$jq_expr" "$1"
  exit $?
}

case "$2" in
  graphql)
    n=""
    for a in "${args[@]}"; do [[ "$a" == n=* ]] && n="${a#n=}"; done
    [[ "$n" =~ ^[0-9]+$ ]] || exit 99
    echo graphql >> "$base/calls"
    done_count=$(count "$base/count")
    src="$base/queue/$((done_count + 1)).json"
    if [ ! -f "$src" ]; then
      echo "gh: queue exhausted (HTTP 502)" >&2
      exit 98
    fi
    echo $((done_count + 1)) > "$base/count"
    emit "$src"
    ;;
  */rules/branches/*)
    echo rules >> "$base/calls"
    done_count=$(count "$base/rules_count")
    echo $((done_count + 1)) > "$base/rules_count"
    if [ -f "$base/rules_failures" ] && [ "$done_count" -lt "$(cat "$base/rules_failures")" ]; then
      echo "gh: Bad Gateway (HTTP 502)" >&2
      exit 1
    fi
    [[ "$2" == *per_page=100* ]] || exit 95
    emit "$base/rules.json"
    ;;
  */code-scanning/alerts*)
    [[ "$2" == *state=open* && "$2" == *pr=* && "$2" == *per_page=100* ]] || exit 94
    echo code-scanning >> "$base/calls"
    emit "$base/alerts.json"
    ;;
  *)
    exit 97
    ;;
esac
