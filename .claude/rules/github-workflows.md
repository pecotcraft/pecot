---
paths:
  - ".github/workflows/*.yml"
---

# GitHub Actions の workflow の step 名

step 名は英語で、Actions でよく使う形にする。Actions の画面と `gh run view` に出るので、何をする step かが名前だけで分かるようにする。

- 動詞で始める命令形にし、先頭だけ大文字にする。例: `Checkout`・`Set up Node.js`・`Install dependencies`・`Run checks`・`Upload logs`
- `uses:` だけの step にも `name:` を付ける。公式の Action は、その Action の README の呼び方に合わせる（`Checkout`・`Set up uv`・`Log in to GHCR`）
- 失敗の切り分けに使う step は、名前で区別できるようにする。例: 基盤の失敗は `Start dev container`、テストの失敗は `Run checks` に出る
- 必須チェックは `ci-result` と `version-plan` で、ruleset が参照するので job 名を変えない。`checks` は matrix で、チェックの名前は `checks (<part>)` になる
- tests は動的な matrix で、チェックの名前は `tests (<project>:<target>)` になる（例: `tests (pecot-visual:test-cli)`）。
  レーンの一覧は `lanes` の job が nx の task graph から作る

# workflow の一覧

- `ci.yml`: PR・merge queue で、変更が届いたレーンを devcontainer で検証する。`checks (lint)` とレーンごとの `tests` を `ci-result` にまとめ、`version-plan` も動かす
  - tests の job は job 内に nx リモートキャッシュのサーバを持ち、同じ PR の前の run で成功したレーンの結果だけを取り込む
  - 同じリポの PR では、tests が合否のレーンの JUnit を artifact に残す。今は読む job が無く、テストレポートの載せ替え（#645）が使う。公開サイトは作らない
- `devcontainer-image.yml`: CI 用の devcontainer イメージを GHCR に載せる（`.claude/rules/devcontainer.md`）
- `release.yml`: 人が手で起動する。入力 `dry-run`（既定 `true`）では案だけを出す。本番は一時ブランチへ push してタグと Release を出し、その後で `main` を取り込んで push する
- `publish-npm.yml`: MCP サーバの tgz を npm へ publish する。初回の公開は `.claude/rules/npm-publish.md`
  - 正式版は、tag を渡した dispatch で Release の tgz を出す
  - 開発版は、main への push で変わったプラグインだけを devcontainer で作り、`@pecot/<name>-mcp` の dist-tag `next` で出す。visual は監査を通してから作る。開発版の監査は high 以上を警告にとどめ、本番のリリースだけが止まる
- `pages-build.yml`: 公開サイトの 1 つの側（リリース版・開発版・PR 版）を devcontainer で作り、artifact に上げる。テストは動かさず、サイトは定義書だけを載せる
  - 手での起動は `side`（`release`・`dev`）を取り、main からだけ動く。release.yml の本番が land の後に `side=release` で起こす
  - 同じリポの PR では、開いたときと push のたびに PR 版を作る。fork の PR と `closed` では、何も作らずに終わる。`closed` は、pages-deploy に閉じた PR の掃除をさせるため
- `pages-deploy.yml`: `pages-build.yml` と `test-report.yml` の完了で動き、run の出どころを API で確かめる。保管ブランチ `pages-store` のその側だけを差し替え、GitHub Pages に公開する
  - `test-report.yml` の run は、レポートを `<側>/test-report/` に置く。定義書を差し替えても、レポートは残る
  - `pages-store` へは専用の App（秘密鍵は environment `pages-store`）でだけ書く。手での起動は `pages-store` の今の中身を公開し直す
  - PR 版を公開したら、preview-status の job が PR の head に commit status `pages / preview` を付ける
- `test-report.yml`: レポートのレーンを全部動かし、Allure Report と履歴を artifact `test-report-<side>`（7 日）に上げる
  - main への push で開発版を作る。手での起動は `side`（`release`・`dev`）を取り、main からだけ動く。release.yml の本番が land の後に `side=release` で起こす
  - `side` の job が材料と matrix を決める。`tests` がレーンごとに dev container で動かし、結果を `allure-results-<slug>`（1 日）に上げる。`report` がレポートを作る
  - テストが落ちても run は成功で終わる。落ちるのは、結果を残さずに止まったレーンがあるときと、`allure generate` が失敗したとき
  - 履歴は側ごとに 3 件まで。pages-deploy が artifact を受けて公開する
- `dependabot-auto-merge.yml`: minor・patch の PR に auto-merge を入れる
- `dependabot-commit.yml`: 各 `runtime-lock.yaml` を root の lock から作り直し、version plan を足して同じブランチへ push する
- `dependabot-prs.yml`: 人の判断を待つ dependabot の PR を Tracker 1 件にそろえる
- `security-alerts.yml`: main の security alert を Tracker 1 件にそろえる
- 上の 2 本は App の webhook と Scheduler で起動し、cron は補助
  - 変数 `DEPENDABOT_PRS_APP_CLIENT_ID`・`SECURITY_APP_CLIENT_ID` が空の間は動かない
- `pecot-board-sync.yml`: ボードの列と札を判定どおりに直す。pecot-workflow の雛形の写しで、npx の dist-tag だけ `@next`（main の開発版）にする
  - PR と Issue のイベントと、Scheduler（毎時）で起動する。変数 `PECOT_BOARD_SYNC_APP_CLIENT_ID` が空の間は動かない
- `pecot-auto.yml`: 起動ラベルを付けた Issue を、w-auto で直して PR まで作る。pecot-workflow の雛形の写しで、npx の dist-tag だけ `@next` にする
  - job `gate` が CLI だけで進めるかを決め、`run` が claude-code-action を動かす。変数 `PECOT_AGENT_APP_CLIENT_ID` が空の間は、`setup` が Issue に足りない設定を書くだけで動かない
- `dependabot-*`・`release.yml` の push と auto-merge は、リリースの App のトークンで行う
