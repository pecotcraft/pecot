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

- `ci.yml`: PR・merge queue・main への push で、変更が届いたレーンを devcontainer で検証する。`checks (lint)` とレーンごとの `tests` を `ci-result` にまとめ、PR・merge queue では `version-plan` も動かす
  - tests の job は job 内に nx リモートキャッシュのサーバを持ち、同じ PR の前の run で成功したレーンの結果だけを取り込む
- `devcontainer-image.yml`: CI 用の devcontainer イメージを GHCR に載せる（`.claude/rules/devcontainer.md`）
- `release.yml`: 人が手で起動する。入力 `dry-run`（既定 `true`）では案だけを出す。本番は一時ブランチへ push してタグと Release を出し、その後で `main` を取り込んで push する
- `publish-npm.yml`: MCP サーバの tgz を npm へ publish する
- `dependabot-auto-merge.yml`: minor・patch の PR に auto-merge を入れる
- `dependabot-commit.yml`: 各 `runtime-lock.yaml` を root の lock から作り直し、version plan を足して同じブランチへ push する
- `dependabot-prs.yml`: 人の判断を待つ dependabot の PR を Tracker 1 件にそろえる
- `security-alerts.yml`: main の security alert を Tracker 1 件にそろえる
- 上の 2 本は App の webhook と Scheduler で起動し、cron は補助
  - 変数 `DEPENDABOT_PRS_APP_CLIENT_ID`・`SECURITY_APP_CLIENT_ID` が空の間は動かない
- `dependabot-*`・`release.yml` の push と auto-merge は、リリースの App のトークンで行う
