# security-webhook

security alert の操作を App の webhook で受ける AWS Lambda である（#175）。
`security-alerts.yml` を `workflow_dispatch` で起こす。
Actions のトリガーには security alert のイベントが無い。
そのため、Actions の外で受けている。
受け口は、このリポの運用のためのもので、配布物ではない。

## 構成

```text
GitHub App の webhook (dependabot_alert / code_scanning_alert / secret_scanning_alert)
  -> Lambda function URL (認証なし。署名の確認で弾く)
  -> handler.mjs (署名の確認、main に関わる alert だけを通す、installation token を発行)
  -> workflow_dispatch で security-alerts.yml を起動
```

- 鍵と webhook の secret は、SSM Parameter Store の SecureString に置く
  - `/pecot/security-webhook/app-private-key`
  - `/pecot/security-webhook/webhook-secret`
- 構成は `template.yaml`（CloudFormation）である。スタック名と関数名は `pecot-security-webhook`、リージョンは `ap-northeast-1` である
- 関数のコードは `deploy.sh` が `update-function-code` で載せる。CloudFormation の `ZipFile` は仮のコードである
- 課金の歯止めとして、`deploy.sh` が同時実行の予約を 2 に置く。あわせて AWS Budgets のアラートで知る
- `security-alerts.yml` の cron（毎時 17 分）は、配送の失敗も漏れたときの最後の補助である。数時間遅れることがある

## 初回の手順

次の順で行う。1 から 6 は AWS の準備、7 以降が App と `deploy.sh`。

1. AWS アカウントを新しく作る
   - プランは Paid plan を選ぶ
   - Free plan は 6 か月で終わり、アカウントが自動で閉じて、受け口が消える
   - この用途なら、費用は無料の利用枠に収まる
2. root ユーザーに MFA を付ける
3. AWS Organizations を有効にする。IAM Identity Center で権限セットを使うのに要る
4. IAM Identity Center を有効にし、管理者の権限セットを作って、自分のユーザーに割り当てる
5. devcontainer で `aws configure sso` を打ち、プロファイルを作る
6. AWS Budgets で、月 $1 を超えたらメールで知らせるアラートを作る
7. GitHub App（変数 `SECURITY_APP_CLIENT_ID` の App）の設定で、秘密鍵をもう 1 本作り、ダウンロードする。Actions の鍵とは別に失効できる
8. `deploy.sh --put-secrets` を打つ

   ```bash
   openssl rand -hex 32   # webhook の secret。控えておく
   .github/security-webhook/deploy.sh --profile <profile> --installation-id <id> --put-secrets <鍵のファイル>
   ```

   - installation id は、org の Settings → GitHub Apps → Configure の URL の末尾の数字である
   - webhook の secret は、標準入力から求められる。画面には出ない
   - 終わりに表示される function URL を控える
   - ダウンロードした鍵のファイルを消す
9. App の設定で次を行う
   - Repository permissions の Actions を Read and write にする
   - Webhook を Active にし、URL に function URL、secret に手順 8 の値を入れる
   - Subscribe to events で Dependabot alert・Code scanning alert・Secret scanning alert を選ぶ
10. org の App の installation で、権限の追加を承認する

2 回目以降は、`--installation-id` を省くと CloudFormation の前回の値を使う。
`--client-id`・`--repository-id` は、省くと `gh` で読む。

## 鍵の入れ替え

1. App の設定で新しい秘密鍵を作る
2. `deploy.sh --put-secrets <新しい鍵のファイル>` で SSM に入れる。webhook の secret は同じ値を入れ直す
3. `deploy.sh --rotate` を打つ。温まった実行環境が入れ替わり、新しい鍵を読む
4. 古い鍵を App の設定で失効させる
5. 新しい鍵のファイルを消す

## 鍵が漏れたとき

Lambda の鍵を持つ者は、App の全権限の token を発行できる。
漏れたと分かったら、すぐに App の設定でその鍵を失効させる。
そのあと、上の「鍵の入れ替え」で新しい鍵を入れる。
webhook の secret が漏れたときは、App の設定で secret を作り直し、`--put-secrets` で SSM にも入れ直す。

## 配送の失敗の見方

GitHub は、失敗した配送を自動で再送しない。

1. App の設定の Advanced → Recent Deliveries で、失敗した配送を探す
2. 3 日以内なら Redeliver する
3. 関数のログ（CloudWatch Logs の `/aws/lambda/pecot-security-webhook`）を見る
   - 残るのは、イベント・action・alert の番号・run の id だけである

Redeliver が間に合わなくても、cron が最後の補助として拾う。1 時間以内は保証しない。

## 同時実行の上限

新しいアカウントは同時実行の上限が小さく、予約を置けないことがある。
その間、`deploy.sh` は警告を出す。
上限が上がったら、`deploy.sh` を打ち直すと予約が置かれる。
