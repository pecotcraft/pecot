#!/usr/bin/env bash
# ci-result の判定。checks・lanes・tests の結果を照らし、レーンごとの結論を 1 行ずつ出す。
# env: CHECKS_RESULT・LANES_RESULT・TESTS_RESULT・LANES_COUNT・LANES_JSON・GH_TOKEN。
# CI_RESULT_JOBS_FILE があれば、gh run view の代わりにそのファイル（--json jobs の出力）を読む。

set -euo pipefail

echo "checks: $CHECKS_RESULT"
echo "lanes: $LANES_RESULT"
if [ "$CHECKS_RESULT" != "success" ]; then
    echo "checks が success ではありません: $CHECKS_RESULT"
    exit 1
fi
if [ "$LANES_RESULT" != "success" ]; then
    echo "lanes が success ではありません: $LANES_RESULT"
    exit 1
fi

# lanes が success のときだけ出力が意味を持つ。数と配列の長さが合わなければ、理由を出して止める。
if ! [[ "${LANES_COUNT:-}" =~ ^[0-9]+$ ]]; then
    echo "LANES_COUNT が数ではありません: '${LANES_COUNT:-}'"
    exit 1
fi
lanes_len=$(jq -r 'if type == "array" then length else "not-array" end' <<< "${LANES_JSON:-}") || lanes_len="invalid"
if [ "$lanes_len" != "$LANES_COUNT" ]; then
    echo "LANES_JSON が配列でないか、長さ ($lanes_len) が LANES_COUNT ($LANES_COUNT) と一致しません。"
    exit 1
fi

if [ -n "${CI_RESULT_JOBS_FILE:-}" ]; then
    jobs=$(cat "$CI_RESULT_JOBS_FILE")
else
    jobs=$(gh run view "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" --json jobs)
fi

# 名前に当たる job がちょうど 1 件なら conclusion、それ以外は missing を返す。
conclusion_of() {
    jq -r --arg name "$1" '[.jobs[] | select(.name == $name)] | if length == 1 then .[0].conclusion else "missing" end' <<< "$jobs"
}

failed=0
for part in lint githooks; do
    conclusion=$(conclusion_of "checks ($part)")
    echo "checks ($part): $conclusion"
    [ "$conclusion" = "success" ] || failed=1
done

if [ "$LANES_COUNT" = "0" ]; then
    # 飛ばした job は展開前の名前で出るため、名前で数えず needs.tests.result で確かめる。
    echo "tests: 0 レーン ($TESTS_RESULT)"
    [ "$TESTS_RESULT" = "skipped" ] || failed=1
    exit "$failed"
fi

lane_names=$(jq -r '.[].lane' <<< "$LANES_JSON")
while IFS= read -r lane; do
    conclusion=$(conclusion_of "tests ($lane)")
    echo "tests ($lane): $conclusion"
    [ "$conclusion" = "success" ] || failed=1
done <<< "$lane_names"

# 一覧に無いレーンの job が success 以外で残っていないかを確かめる。
extra=$(jq -r --argjson lanes "$LANES_JSON" '
    ($lanes | map("tests (" + .lane + ")")) as $known
    | .jobs[]
    | select((.name | startswith("tests (")) and (.conclusion != "success")
        and (.name as $n | $known | any(. == $n) | not))
    | .name + ": " + (.conclusion // "none")' <<< "$jobs")
if [ -n "$extra" ]; then
    echo "一覧に無い tests の job が success ではありません。"
    echo "$extra"
    failed=1
fi
exit "$failed"
