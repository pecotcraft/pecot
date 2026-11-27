---
paths:
  - ".github/workflows/*.yml"
---

# GitHub Actions の workflow の step 名

step 名は英語で、Actions でよく使う形にする。Actions の画面と `gh run view` に出るので、何をする step かが名前だけで分かるようにする。

- 動詞で始める命令形にし、先頭だけ大文字にする。例: `Checkout`・`Set up Node.js`・`Install dependencies`・`Run checks`・`Upload logs`
- `uses:` だけの step にも `name:` を付ける。公式の Action は、その Action の README の呼び方に合わせる（`Checkout`・`Set up uv`・`Log in to GHCR`）
- 失敗の切り分けに使う step は、名前で区別できるようにする。例: 基盤の失敗は `Start dev container`、テストの失敗は `Run checks` に出る
- 必須チェックは `ci-result`・`version-plan` と、`codeql.yml` の `analyze (<言語>)` で、ruleset が参照するので job 名を変えない。
  CodeQL の解析を必須にするのは、merge queue が解析の結果を上げ終わる前にマージして一時ブランチを消すと、merge_group の run が落ちるため。`checks` は matrix で、チェックの名前は `checks (<part>)` になる
- tests は動的な matrix で、チェックの名前は `tests (<project>:<target>)` になる（例: `tests (pecot-visual:test-cli)`）。
  レーンの一覧は `lanes` の job が nx の task graph から作る

# checkout の履歴

`fetch-depth: 0` の `actions/checkout` には、`filter: blob:none` を `fetch-depth` の直後に付ける。
全部のブランチを取ると、保管ブランチ `pages-store`（展開で数百 MB）まで入る。`filter` を付けると、blob は読むものだけをその場で取る。
`.githooks/tests/test_workflow_checkouts.py` が、全 workflow でこれを固定する。

# workflow の一覧

- `ci.yml`: PR・merge queue で、変更が届いたレーンを devcontainer で検証する。`checks (lint)` とレーンごとの `tests` を `ci-result` にまとめ、`version-plan` も動かす
  - tests の job は job 内に nx リモートキャッシュのサーバを持ち、同じ PR の前の run で成功したレーンの結果だけを取り込む
  - 同じリポの PR とマージキューの run は、成功したレーンの Allure の結果を `allure-results-<slug>`（30 日）に上げる。マージキューの lanes の job は、変更が届いたレーンと結果を持つ run を `lane-sources` に上げる。どちらも開発版のテストレポートの材料
  - workflow の env で `PECOT_REPORT_SITE_URL` に開発版の URL を渡す。PR とマージキューで nx のキャッシュの hash をそろえるため
  - 公開サイトは作らない
- `devcontainer-image.yml`: CI 用の devcontainer イメージを GHCR に載せる（`.claude/rules/devcontainer.md`）
- `release.yml`: 人が手で起動する。入力 `dry-run`（既定 `true`）では案だけを出す。本番は一時ブランチへ push してタグと Release を出し、その後で `main` を取り込んで push する
- `publish-npm.yml`: MCP サーバの tgz を npm へ publish する。初回の公開は `.claude/rules/npm-publish.md`
  - 正式版は、tag を渡した dispatch で Release の tgz を出す
  - 開発版は、main への push で変わったプラグインだけを devcontainer で作り、`@pecot/<name>-mcp` の dist-tag `next` で出す。visual は監査を通してから作る。開発版の監査は high 以上を警告にとどめ、本番のリリースだけが止まる
- `pages-build.yml`: 公開サイトの 1 つの側（リリース版・開発版・PR 版）を devcontainer で作り、artifact に上げる。テストは動かさず、サイトは定義書だけを載せる
  - 手での起動は `side`（`release`・`dev`）を取り、main からだけ動く。release.yml の本番が land の後に `side=release` で起こす
  - 同じリポの PR では、開いたときと push のたびに PR 版を作る。fork の PR と `closed` では、何も作らずに終わる。`closed` は、pages-deploy に閉じた PR の掃除をさせるため
  - PR の起動は、サイトの材料（定義書・`libs/interface-spec/docs/**`・ビルドの環境）を変える PR だけ。`paths` で絞る
- `pages-deploy.yml`: `pages-build.yml` と `test-report.yml` の完了で動き、run の出どころを API で確かめる。保管ブランチ `pages-store` のその側だけを差し替え、GitHub Pages に公開する
  - `test-report.yml` の run は、レポートを `<側>/test-report/` に置く。定義書を差し替えても、レポートは残る
  - `pages-store` へは専用の App（秘密鍵は environment `pages-store`）でだけ書く。手での起動は `pages-store` の今の中身を公開し直す
  - job は verify・store・deploy の 3 つ。store が保管して `github-pages` の artifact を上げ、deploy が公開する
  - PR 版を公開したら、deploy の job が PR の head に commit status `pages / preview` を付ける。保管の変更が無ければ、store の job が付ける
- `test-report.yml`: Allure Report を作り、artifact `test-report-<side>`（7 日）に上げる
  - main への push で開発版を作る。手での起動は `side`（`release`・`dev`）を取り、main からだけ動く。release.yml の本番が land の後に `side=release` で起こす
  - `side` の job が材料と matrix を決める。`tests` がレーンごとに dev container で動かし、結果を `allure-results-<slug>`（1 日）に上げる。`report` がレポートを作る
  - リリース版は全レーンを動かす。開発版は、`dev_sources.py` が ci の結果と前の開発版の `lane-latest`（90 日）からレーンを拾い、結果の無いレーンだけを動かす。動かすレーンが無ければ tests の job は飛ぶ
  - テストが落ちても run は成功で終わる。落ちるのは、結果を残さずに止まったレーンがあるときと、`allure generate` が失敗したとき
  - 履歴はリリース版だけで 10 件まで。S3 に置き、`history-get` が取り、`history-put` が戻す。この 2 つだけが environment `test-report-history` と OIDC で AWS に入る
  - pages-deploy が artifact を受けて公開する
- `codeql.yml`: CodeQL の解析（advanced setup）。リポの設定の default setup は止めておく
  - `actions/*/dist` を `paths-ignore` で外す。依存を同梱した生成物で、依存の既知の脆弱性は Dependabot が見る
- `dependabot-auto-merge.yml`: minor・patch の PR に auto-merge を入れる
- `dependabot-commit.yml`: version plan と playwright-deps の版を足し、`actions/<処理>/dist` を作り直して、同じブランチへ push する
- `dependabot-prs.yml`: 人の判断を待つ dependabot の PR を Tracker 1 件にそろえる
- `security-alerts.yml`: main の security alert を Tracker 1 件にそろえる
- 上の 2 本は App の webhook と Scheduler で起動し、cron は補助
  - 変数 `DEPENDABOT_PRS_APP_CLIENT_ID`・`SECURITY_APP_CLIENT_ID` が空の間は動かない
- `pecot-board-sync.yml`: ボードの列と札を判定どおりに直す。`actions/templates/` の雛形の写しで、pecot の action だけ `./actions/<処理>` で呼ぶ
  - PR と Issue のイベントと、Scheduler（毎時）で起動する。変数 `PECOT_BOARD_SYNC_APP_CLIENT_ID` が空の間は動かない
- `issue-surface-drift.yml`: GitHub の今のスキーマを Issue の機能の写しと比べ、差を Tracker 1 件に書き直してボードに載せる。差が無くなれば閉じる。Scheduler（毎時）だけが起こし、変数 `SECURITY_APP_CLIENT_ID` が空の間は動かない
- `dependabot-*`・`release.yml` の push と auto-merge は、リリースの App のトークンで行う
