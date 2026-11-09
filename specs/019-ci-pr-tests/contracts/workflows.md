# Contract: GitHub Actions の workflow と ruleset

外から見える約束は、workflow の起動条件・job 名（必須チェックの名前）・入力・権限と、`main` の ruleset とする。
Action はすべて SHA で固定し、版をコメントに書く（`publish-npm.yml` と同じ書き方）。

## ci.yml（PR の検証）

| 項目 | 約束 |
|---|---|
| 起動 | `pull_request`（opened・synchronize・reopened）・`merge_group`・`main` への `push` |
| 権限 | `contents: read`・`actions: read`・`packages: read`・`pull-requests: read` |
| concurrency | `ci-${{ github.event.pull_request.number \|\| github.ref }}`、PR のときだけ `cancel-in-progress` |
| 時間の上限 | job ごとに `timeout-minutes: 45` |
| push の範囲 | 直前に成功した `main` の run の commit から HEAD まで。成功した run が無い（`noPreviousBuild`）か、base の commit を読めなければ全レーン（FR-029） |
| 秘密 | 使わない（FR-009） |

job は次のとおり。必須チェックは `ci-result` と `version-plan` の 2 つにする。

| job | 中身 | 落ちる条件 |
|---|---|---|
| `checks` | コンテナで `setup.sh` と chromium を入れ、pre-commit・pre-push・manual の 3 stage を範囲指定で動かす。`SKIP=check-version-plan-required` を付ける | どれかの hook が非 0 |
| `version-plan` | `check-version-plan-required.sh` を範囲指定で動かす。`push` では動かさない。bump の宣言はマージの前に確かめ終えているためである。範囲内の commit（merge を除く）の作者がすべて `dependabot[bot]` か `github-actions[bot]` で、`dependabot[bot]` が 1 つ以上なら、スクリプトが要求せずに通し、その旨を Summary に書く。判定できないときも失敗にするため、env `PECOT_VERSION_PLAN_STRICT=1` を渡す | 宣言の無い release group がある |
| `ci-result` | `checks` の結果をまとめる。`checks` が skip・cancel・失敗なら落とす | 上のとおり |

`checks` の Step Summary には次を書く。

| 欄 | 中身 |
|---|---|
| 範囲 | base と head の SHA |
| レーン | 選ばれたレーン名と成否。0 件なら「対象なし（成功）」 |
| 失敗 | 失敗したレーン名と、ログの該当行への案内 |
| skip | レーンごとの skip の件数。手元の devcontainer の件数と比べられるようにする（SC-002） |
| 環境 | 基盤の失敗（イメージの取得・コンテナの起動）はテストの失敗と分けて書く |

## devcontainer-image.yml（イメージの更新）

| 項目 | 約束 |
|---|---|
| 起動 | `main` への push のうち `.devcontainer/**` と workflow 自身が変わったもの、`pull_request`（`.devcontainer/**` と workflow 自身が変わったもの。build だけで push しない）、週 1 回の schedule、`workflow_dispatch` |
| 権限 | `contents: read`・`packages: write` |
| 成果物 | `ghcr.io/pecotcraft/pecot-devcontainer:latest`（public） |

## dependabot-auto-merge.yml（自動マージ）

| 項目 | 約束 |
|---|---|
| 起動 | `pull_request`（opened・synchronize・reopened） |
| 動く条件 | `github.event.pull_request.user.login == 'dependabot[bot]'` かつ `github.actor == 'dependabot[bot]'`（App の push による synchronize では動かさない） |
| 判定 | fetch-metadata の `update-type` が `version-update:semver-minor` か `version-update:semver-patch`。`dependency-names` に `playwright` を含まない。GraphQL の `PullRequest.isMergeQueueEnabled` が true |
| 操作 | App のトークンで `gh pr merge --auto --squash "$PR_URL"` |
| トークンの権限 | `permission-contents: write`・`permission-pull-requests: write` |
| 権限 | `contents: read`・`pull-requests: read`（書き込みは App のトークンで行う） |
| 秘密 | Dependabot secrets の `PECOT_BOT_CLIENT_ID`・`PECOT_BOT_PRIVATE_KEY`。無い間は notice を出して成功で終える |

major のときは何もしない。PR にコメントも付けない（dependabot の PR 本文に更新の種類が出る）。

## release.yml（リリース）

| 項目 | 約束 |
|---|---|
| 起動 | `workflow_dispatch`。入力は無い。各 job に `if: github.ref == 'refs/heads/main' && vars.PECOT_BOT_CLIENT_ID != ''` を付ける |
| concurrency | `release`、`cancel-in-progress: false`。承認待ちの run は group を持ち続け、後から起動した run は pending で待つ。cancel されるのは、さらに後の起動で pending になった側である |
| 権限 | `contents: read`・`packages: read` |
| 秘密 | client id は `vars.PECOT_BOT_CLIENT_ID`。秘密鍵は Environment secret の `PECOT_BOT_PRIVATE_KEY` |
| トークン | App のトークンはコンテナを起こす直前に作る。コンテナへは `GH_TOKEN`・`PECOT_GITHUB_COM_TOKEN` だけを渡し、`GITHUB_TOKEN` は渡さない |
| 時間の上限 | job ごとに `timeout-minutes: 60` |

job は次のとおり。

| job | Environment | トークンの権限 | 中身 |
|---|---|---|---|
| `plan` | `release-plan`（承認者なし。deployment branch は `main` だけ） | `vulnerability-alerts`・`security-events`・`secret-scanning-alerts` の read（preflight が 3 種の alert を読むため） | 依存の更新の version plan を作り（`dependabot-plans`）、`pecot release preflight` と `nx release --dry-run --verbose --yes` を動かす。結果を `.pecot/tmp/release/summary.md` に書き、Step Summary と artifact `release-plan` に出す。commit しない |
| `release` | `release`（必須レビュアーはリリース担当者。deployment branch は `main` だけ） | `contents: write`・`actions: write` | `needs: plan`。承認の後、`ref: main` で checkout し、HEAD が `github.sha` と違えば止める。続けて `gh auth setup-git`・git の作者の設定・`dependabot-plans`・`nx release --verbose --yes` を動かす |

Step Summary は `gh` で取れないため、同じ内容を artifact `release-plan` に残す。w-release は `gh run download` で読む。

`release` は、HEAD が起動時の `github.sha` と違えば、何もせずに失敗する。承認を待つあいだに `main` が進んだ場合を指す。
止めるときの文は env の `MSG_SHA` に置く。「承認を待つ間に main が進みました。release.yml を起動し直してください。」とする。

## main の ruleset

ruleset は `.github/rulesets/main.json` に置き、既存の ruleset 26538811 を `gh api -X PUT` で置き換えて適用する。適用の手順は quickstart に書く。
code scanning の規則は、merge queue の run と、default setup が解析する dependabot の PR を止めない。
緊急の force push では、管理者が ruleset の enforcement を `disabled` にして押し、`active` に戻す（FR-028）。

| 規則 | 値 |
|---|---|
| 対象 | `refs/heads/main` |
| PR 経由を要求 | 必須レビュー数 0、squash のみ |
| 必須チェック | `ci-result`・`version-plan`（どちらも GitHub Actions が出す） |
| merge queue | 有効。方式は squash、グループの大きさは 1 |
| code scanning | CodeQL。Alerts・Security alerts とも All |
| 直接 push・force push・削除 | 禁止 |
| bypass | リリースの App だけ（`Integration`、`always`） |
