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
| push の範囲 | 直前に成功した `main` の run の commit から HEAD まで。その commit が履歴に無ければ全レーン（FR-029） |
| 秘密 | 使わない（FR-009） |

job は次のとおり。必須チェックは `ci-result` と `version-plan` の 2 つにする。

| job | 中身 | 落ちる条件 |
|---|---|---|
| `checks` | コンテナで `setup.sh` と chromium を入れ、pre-commit・pre-push・manual の 3 stage を範囲指定で動かす。`SKIP=check-version-plan-required` を付ける | どれかの hook が非 0 |
| `version-plan` | `check-version-plan-required.sh` を範囲指定で動かす。`push` では動かさない。bump の宣言はマージの前に確かめ終えているためである。範囲内の commit がすべて `dependabot[bot]` の作なら、スクリプトが要求せずに通し、その旨を Summary に書く | 宣言の無い release group がある |
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
| 動く条件 | `github.event.pull_request.user.login == 'dependabot[bot]'` |
| 判定 | fetch-metadata の `update-type` が `version-update:semver-minor` か `version-update:semver-patch` |
| 操作 | App のトークンで `gh pr merge --auto --squash "$PR_URL"` |
| トークンの権限 | `permission-pull-requests: write`。merge queue への投入に `contents: write` が要るかは実装時に確かめ、要らなければ付けない |
| 権限 | `contents: read`・`pull-requests: read`（書き込みは App のトークンで行う） |
| 秘密 | Dependabot secrets の `PECOT_BOT_CLIENT_ID`・`PECOT_BOT_PRIVATE_KEY` |

major のときは何もしない。PR にコメントも付けない（dependabot の PR 本文に更新の種類が出る）。

## release.yml（リリース）

| 項目 | 約束 |
|---|---|
| 起動 | `workflow_dispatch`。入力は無い。ref は `main` に限る |
| concurrency | `release`、`cancel-in-progress: false` |
| 秘密 | Actions secrets の `PECOT_BOT_CLIENT_ID`・`PECOT_BOT_PRIVATE_KEY` |
| Environment | `release`。必須レビュアーはリリース担当者 |
| トークンの権限 | `plan` は `permission-dependabot-alerts: read` だけ。`release` は research の R6 の表のとおり |

job は次のとおり。

| job | 中身 |
|---|---|
| `plan` | 依存の更新の version plan を作り（`dependabot-plans`）、`pecot release preflight` と `nx release --dry-run --verbose --yes` を動かす。bump と CHANGELOG の案を Summary に出す。commit しない |
| `release` | `plan` の後に Environment の承認を待つ。承認されたら、同じ `main` の SHA で plan を作り直し、`nx release --verbose --yes` を動かす |

`release` は、`plan` の SHA と起動時の `main` の SHA が違えば、何もせずに失敗する。承認を待つあいだに `main` が進んだ場合を指す。

## main の ruleset

ruleset は `.github/rulesets/main.json` に置き、`gh api` で適用する。適用の手順は quickstart に書く。
緊急の force push では、管理者が ruleset の enforcement を `disabled` にして押し、`active` に戻す（FR-028）。

| 規則 | 値 |
|---|---|
| 対象 | `refs/heads/main` |
| PR 経由を要求 | 必須レビュー数 0、squash のみ |
| 必須チェック | `ci-result`・`version-plan`（どちらも GitHub Actions が出す） |
| merge queue | 有効。方式は squash、グループの大きさは 1 |
| 直接 push・force push・削除 | 禁止 |
| bypass | リリースの App だけ（`Integration`、`always`） |
