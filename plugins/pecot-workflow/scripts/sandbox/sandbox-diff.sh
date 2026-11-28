#!/usr/bin/env bash
# このリポと検証用の設定（FR-001〜003）を比べ、ずれを出す。何も書き換えない。
# 終了コード: 0 = ずれ 0 件、1 = ずれあり、2 = 読めない（gh の失敗・比べるキーの欠け）。
set -euo pipefail

THIS_REPO="pecotcraft/pecot"
THIS_PROJECT=1
SANDBOX_REPO="pecotcraft/pecot-sandbox"
SANDBOX_PROJECT=3
WORKFLOWS=".github/workflows"
HOST="github.com"
CONFIG_DIR=".pecot/config/projects"
# 有無だけを比べる workflow。検証用のものは、必須チェックの名前を出すだけ。
PRESENCE_WORKFLOWS=(ci.yml codeql.yml)
# 有無と中身を比べる workflow。比べる相手は、このリポの main にある同じファイル（FR-032）。
COPIED_WORKFLOWS=(pecot-board-sync.yml pecot-github-ops.yml pecot-handoff.yml pecot-review.yml)
# pecot の action を、このリポは ./actions/<処理> で呼び、検証用は pecotcraft/pecot/actions/<処理>@<ref> で呼ぶ。そろえてから比べる。
# このリポだけの step（Check out the pecot actions）も落とす
PECOT_ACTIONS='
    def pecot_actions:
        reduce .[] as $l ({out: [], skip: false};
            if ($l | test("^      - name: Check out the pecot actions$")) then
                .skip = true | .out |= (if ((.[-1] // "") | test("^      # ")) then .[:-1] else . end)
            elif .skip and ($l | test("^        ")) then .
            elif .skip then .skip = false | (if $l == "" then . else .out += [$l] end)
            else .out += [$l] end)
        | .out
        | map(sub("^(?<p>\\s*(?:- )?uses: )(?:\\./(?:\\.pecot-actions/)?actions/|pecotcraft/pecot/actions/)(?<a>[a-z-]+)(?:@\\S+)?(?:\\s+#.*)?$"; "\(.p)pecotcraft/pecot/actions/\(.a)@<ref>"));'

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
items_file="$script_dir/sandbox-diff-items.json"

fail() {
    echo "error: $*" >&2
    exit 2
}

if ! top=$(git rev-parse --show-toplevel 2>/dev/null); then
    fail "git の作業ツリーの中で打ってください（作業用の場所を .pecot/tmp に作るため）"
fi
tmp_base="$top/.pecot/tmp"
mkdir -p "$tmp_base"
work=$(mktemp -d "$tmp_base/sandbox-diff.XXXXXX")
trap 'rm -rf "$work"' EXIT

items=$(jq -c '.' "$items_file")

# gh api の出力を RESP に入れる。失敗したら、読めなかった先と gh の最後の行を出して 2 で終わる。
api() {
    local label="$1"
    shift
    if ! RESP=$(gh api "$@" 2> "$work/err"); then
        local msg
        msg=$(grep -v '^[[:space:]]*$' "$work/err" | tail -n 1 || true)
        fail "$label を読めません（${msg:-gh が失敗しました}）"
    fi
}

# 応答の JSON（$RESP）で、パスの値が null か欠けていれば止める。両方 null を「同じ」としないため。
require() {
    local label="$1" key="$2" path="$3"
    jq -e "$path != null" <<< "$RESP" > /dev/null 2>&1 \
        || fail "$label の応答に $key がありません（権限の不足とみられます）"
}

ignore_of() {
    jq -c --arg n "$1" '[.[] | select(.compare and .name == $n) | .ignore[]] | unique' <<< "$items"
}

match_of() {
    jq -c --arg k "$1" '[.[] | select(.compare | not) | .match // {} | .[$k] // empty] | flatten' <<< "$items"
}

compared() {
    jq -e --arg n "$1" 'any(.[]; .compare and .name == $n)' <<< "$items" > /dev/null
}

# 読み飛ばすキーを、どの深さでも外す。
# shellcheck disable=SC2016
STRIP='def strip($ign): walk(if type == "object" then with_entries(select(.key as $k | $ign | index($k) | not)) else . end);'

read_merge_settings() {
    local repo="$1" label="repos/$1" k
    api "$label" "repos/$repo"
    for k in allow_squash_merge allow_merge_commit allow_rebase_merge allow_auto_merge delete_branch_on_merge; do
        require "$label" "$k" ".$k"
    done
    jq -c --argjson ign "$(ignore_of merge-settings)" "$STRIP"'
        {allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}
        | strip($ign)' <<< "$RESP"
}

read_rulesets() {
    local repo="$1" list id label k out="{}"
    api "repos/$repo/rulesets" --paginate "repos/$repo/rulesets?includes_parents=false"
    list=$(jq -s --argjson skip "$(match_of ruleset_name)" \
        'add // [] | map(select(.name as $n | $skip | index($n) | not))' <<< "$RESP")
    for id in $(jq -r '.[].id' <<< "$list"); do
        label="repos/$repo/rulesets/$id"
        api "$label" "$label"
        for k in name target enforcement conditions rules; do
            require "$label" "$k" ".$k"
        done
        out=$(jq -c --argjson acc "$out" --argjson ign "$(ignore_of ruleset)" \
            --argjson skip "$(match_of ruleset_rule_type)" "$STRIP"'
            . as $rs
            | ([.rules[] | select(.type as $t | $skip | index($t) | not)]
                | group_by(.type)
                | map(if length == 1 then [{key: .[0].type, value: (.[0].parameters // {})}]
                      else to_entries | map({key: "\(.value.type)#\(.key + 1)", value: (.value.parameters // {})}) end)
                | add // [] | from_entries) as $rules
            | $acc + {($rs.name): ({target, enforcement, conditions} + {rules: $rules} | strip($ign))}' <<< "$RESP")
    done
    echo "$out"
}

read_board_fields() {
    local owner="${1%%/*}" number="$2" label
    label="orgs/$owner/projectsV2/$number"
    # shellcheck disable=SC2016
    local query='query($owner: String!, $number: Int!) {
  organization(login: $owner) { projectV2(number: $number) { fields(first: 100) { nodes {
    __typename
    ... on ProjectV2FieldCommon { id name dataType }
    ... on ProjectV2SingleSelectField { options { id name color description } }
  } } } }
}'
    api "$label" graphql -f query="$query" -F owner="$owner" -F number="$number"
    require "$label" fields '.data.organization.projectV2.fields.nodes'
    jq -c --argjson ign "$(ignore_of board-fields)" "$STRIP"'
        [.data.organization.projectV2.fields.nodes[]
            | {key: .name, value: ({dataType, options: (.options // [])} | strip($ign))}]
        | from_entries' <<< "$RESP"
}

read_workflows() {
    local repo="$1" label="repos/$1/contents/$WORKFLOWS" list out name file
    api "$label" "$label?ref=main"
    require "$label" "ファイルの一覧" 'if type == "array" then . else null end'
    list="$RESP"
    out=$(jq -c --arg present "あり" '
        . as $l
        | [$ARGS.positional[] | select(. as $n | any($l[]; .name == $n)) | {key: ., value: $present}]
        | from_entries' --args "${PRESENCE_WORKFLOWS[@]}" <<< "$list")
    for name in "${COPIED_WORKFLOWS[@]}"; do
        jq -e --arg n "$name" 'any(.[]; .name == $n)' <<< "$list" > /dev/null || continue
        file="$label/$name"
        api "$file" "$file?ref=main"
        require "$file" content '.content'
        require "$file" sha '.sha'
        out=$(jq -c --argjson acc "$out" --arg n "$name" "$PECOT_ACTIONS"'
            $acc + {($n): {sha, lines: (.content | gsub("\\s"; "") | @base64d | split("\n") | pecot_actions)}}' <<< "$RESP")
    done
    echo "$out"
}

# 比べるボードを指す設定ファイルの名前の形と、欄ごとの選択肢のキーを読む。番号・題・ID はリポごとに違う。読めない JSON は、CLI と同じく飛ばす。
read_config_file() {
    local repo="$1" project="$2" label="repos/$1/contents/$CONFIG_DIR" list name file entries="[]"
    api "$label" "$label?ref=main"
    require "$label" "ファイルの一覧" 'if type == "array" then . else null end'
    list="$RESP"
    while IFS= read -r name; do
        file="$label/$name"
        api "$file" "$file?ref=main"
        require "$file" content '.content'
        entries=$(jq -c --argjson acc "$entries" --arg n "$name" --arg host "$HOST" --arg owner "${repo%%/*}" --argjson p "$project" \
            --arg current "<host>_<owner>_<number>.json" --arg legacy "<host>_<owner>_<題>_<suffix>.json" '
            (try (.content | gsub("\\s"; "") | @base64d | fromjson) catch null) as $c
            | if ($c | type) == "object" and $c.host == $host and $c.owner == $owner and (try $c.project.number catch null) == $p then
                  "\($host)_\($owner)_" as $pre
                  | (if $n == "\($pre)\($p).json" then $current
                     elif ($c.workflow_suffix | type) == "string" and ($n | startswith($pre))
                          and ($n | endswith("_\($c.workflow_suffix).json")) then $legacy
                     else $n end) as $form
                  | (try ($c.project.fields | to_entries
                          | map({key, value: (.value.options | if type == "object" then keys else [] end)}) | from_entries)
                     catch {}) as $options
                  | $acc + [{name: $n, form: $form, options: $options}]
              else $acc end' <<< "$RESP")
    done < <(jq -r '.[] | select(.type == "file" and (.name | endswith(".json"))) | .name' <<< "$list")
    # 選択肢のキーは、ファイルが 1 つのときだけ出す。0 個か 2 個以上は config-file のずれとして出る
    jq -c 'if length == 0 then {}
           else {"config-file": (sort_by(.name) | map(.form) | join("、"))}
                + (if length == 1 then {"config-options": .[0].options} else {} end) end' <<< "$entries"
}

snapshot() {
    local repo="$1" project="$2" snap="{}" v
    if compared merge-settings; then
        v=$(read_merge_settings "$repo")
        snap=$(jq -c --argjson v "$v" '. + {"merge-settings": $v}' <<< "$snap")
    fi
    if compared ruleset; then
        v=$(read_rulesets "$repo")
        snap=$(jq -c --argjson v "$v" '. + {ruleset: $v}' <<< "$snap")
    fi
    if compared board-fields; then
        v=$(read_board_fields "$repo" "$project")
        snap=$(jq -c --argjson v "$v" '. + {"board-fields": $v}' <<< "$snap")
    fi
    if compared config-file || compared config-options; then
        v=$(read_config_file "$repo" "$project")
        if compared config-file; then
            snap=$(jq -c --argjson v "$v" '. + {"config-file": ($v | del(."config-options"))}' <<< "$snap")
        fi
        if compared config-options; then
            snap=$(jq -c --argjson v "$v" '. + ($v | with_entries(select(.key == "config-options")))' <<< "$snap")
        fi
    fi
    if compared workflows; then
        v=$(read_workflows "$repo")
        snap=$(jq -c --argjson v "$v" '. + {workflows: $v}' <<< "$snap")
    fi
    echo "$snap"
}

snapshot "$THIS_REPO" "$THIS_PROJECT" > "$work/this.json"
snapshot "$SANDBOX_REPO" "$SANDBOX_PROJECT" > "$work/sandbox.json"

jq -r -n --slurpfile a "$work/this.json" --slurpfile b "$work/sandbox.json" \
    --arg none "なし" --arg no_line "（行なし）" --arg line_unit " 行目: " \
    --arg count_head "ずれは " --arg count_tail " 件" --arg this_head "  このリポ: " --arg sandbox_head "  検証用: " '
    def compared_value: if type == "object" and has("lines") then .lines else . end;
    def pairs($prefix; $x; $y):
        (($x // {}) | keys) + (($y // {}) | keys) | unique[] as $k
        | select((($x // {})[$k] | compared_value) != (($y // {})[$k] | compared_value))
        | {name: "\($prefix)\($k)", this: ($x // {})[$k], sandbox: ($y // {})[$k],
           has_this: (($x // {}) | has($k)), has_sandbox: (($y // {}) | has($k))};
    def rules_pairs($x; $y):
        ($x | keys) + ($y | keys) | unique[] as $n
        | if ($x | has($n)) and ($y | has($n)) then
              pairs("ruleset \($n) / "; $x[$n] | del(.rules); $y[$n] | del(.rules)),
              pairs("ruleset \($n) / "; $x[$n].rules; $y[$n].rules)
          else pairs("ruleset "; {($n): $x[$n]} | with_entries(select(.value != null));
                                 {($n): $y[$n]} | with_entries(select(.value != null))) end;
    def first_diff($l; $m):
        first(range(0; [($l | length), ($m | length)] | max) | select($l[.] != $m[.])) // 0;
    def show($v; $has; $other):
        if $has | not then $none
        elif ($v | type) == "object" and ($v | has("lines")) then
            (if ($other | type) == "object" and ($other | has("lines")) then first_diff($v.lines; $other.lines) else 0 end) as $i
            | "blob \($v.sha)、\($i + 1)\($line_unit)\($v.lines[$i] // $no_line)"
        elif ($v | type) == "string" then $v
        else $v | tojson end;
    $a[0] as $x | $b[0] as $y
    | [ pairs("merge-settings / "; $x["merge-settings"]; $y["merge-settings"]),
        rules_pairs($x.ruleset // {}; $y.ruleset // {}),
        pairs("board-fields / "; $x["board-fields"]; $y["board-fields"]),
        pairs(""; $x["config-file"]; $y["config-file"]),
        (if ($x | has("config-options")) and ($y | has("config-options"))
         then pairs("config-options / "; $x["config-options"]; $y["config-options"]) else empty end),
        pairs("workflows / "; $x.workflows; $y.workflows) ]
    | "\($count_head)\(length)\($count_tail)",
      (.[] | .name,
             "\($this_head)\(show(.this; .has_this; .sandbox))",
             "\($sandbox_head)\(show(.sandbox; .has_sandbox; .this))")' > "$work/out"

cat "$work/out"
[ "$(wc -l < "$work/out")" -eq 1 ] || exit 1
