#!/usr/bin/env bash
# ci-result の判定。checks・lanes・tests の結果を照らし、レーンごとの結論を 1 行ずつ出す。
# env: CHECKS_RESULT・LANES_RESULT・TESTS_RESULT・LANES_COUNT・LANES_JSON・GH_TOKEN。
# CI_RESULT_JOBS_FILE があれば、gh run view の代わりにそのファイル（--json jobs の出力）を読む。

set -euo pipefail

echo "checks: $CHECKS_RESULT"
echo "lanes: $LANES_RESULT"
[ "$CHECKS_RESULT" = "success" ]
[ "$LANES_RESULT" = "success" ]

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
    [ "$failed" = "0" ]
    exit
fi

while IFS= read -r lane; do
    conclusion=$(conclusion_of "tests ($lane)")
    echo "tests ($lane): $conclusion"
    [ "$conclusion" = "success" ] || failed=1
done < <(jq -r '.[].lane' <<< "$LANES_JSON")

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
[ "$failed" = "0" ]
