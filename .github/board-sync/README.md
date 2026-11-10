# board-sync

ボードの Tracker をそろえる 2 つの workflow を起こす AWS Lambda である（#175）。
`security-alerts.yml` と `dependabot-prs.yml` を `workflow_dispatch` で起こす。
Actions のトリガーには security alert のイベントが無く、dependabot が起こした run には secret が渡らない。
そのため、Actions の外で受けている。
受け口は、このリポの運用のためのもので、配布物ではない。

## 構成

```text
GitHub App の webhook ---> Lambda function URL (認証なし。署名の確認で弾く)
  POST /security          security の App (dependabot_alert / code_scanning_alert / secret_scanning_alert)
  POST /dependabot-prs    dependabot-prs の App (pull_request / workflow_run)
EventBridge Scheduler (rate(1 hour)) ---> Lambda を直接起動 (署名なし。固定の Input だけ受ける)

Lambda (handler.mjs)
  -> App の installation token を発行
  -> workflow_dispatch で security-alerts.yml / dependabot-prs.yml を起動
```

| 呼び出し元 | 起こす workflow |
|---|---|
| `POST /security` | `security-alerts.yml` |
| `POST /dependabot-prs` | `dependabot-prs.yml` |
| Scheduler | 両方 |

- 鍵と webhook の secret は、App ごとに SSM Parameter Store の SecureString に置く。2 つの App で secret を共有しない
  - `/pecot/board-sync/security/app-private-key`
  - `/pecot/board-sync/security/webhook-secret`
  - `/pecot/board-sync/dependabot-prs/app-private-key`
  - `/pecot/board-sync/dependabot-prs/webhook-secret`
- 構成は `template.yaml`（CloudFormation）である。スタック名と関数名は `pecot-board-sync`、リージョンは `ap-southeast-2` である
  - アカウントは、新しい AWS エクスペリエンスのプロジェクトのアカウントである。リージョンは連絡先の国で決まり、日本はシドニーになる
  - ほかのリージョンは、組織の SCP で拒否される
- 関数のコードは `deploy.sh` が `update-function-code` で載せる。CloudFormation の `ZipFile` は仮のコードである
- 非同期呼び出しの再試行は 0 回にしている。sync は冪等で、`concurrency` が重なりを畳むため、再試行は要らない
- 課金の歯止めとして、署名で弾くこと、`deploy.sh` による同時実行の予約（2）、AWS Budgets のアラートの 3 つを置く

### Scheduler の役割

Scheduler は毎時 1 回、関数に固定の Input（`{"source":"pecot-scheduler"}`）を渡し、2 つの workflow を起こす。
次の 2 つを拾う。

- 時間で決まる理由。30 分たって auto-merge が無い、24 時間たって検証が終わらない、といったもの。webhook は届かない
- 配送の取りこぼし。GitHub は失敗した配送を自動で再送しない

遅れの上限は次のとおり。

- 時間で決まる理由は、GRACE か 24 時間 ＋ 最大 1 時間
- 配送の取りこぼしは、最大 1 時間

2 つの workflow の `schedule`（cron）は、AWS 側の障害で Scheduler と webhook の両方が止まったときの最後の補助になる。
数時間遅れることがある。そのため、各 workflow は毎時最大 2 回ずつ動く。

### 公開の許可

関数は、公開の許可を 2 つ持つ。

- `lambda:InvokeFunctionUrl`（`FunctionUrlAuthType: NONE`）
- `lambda:InvokeFunction`（`InvokedViaFunctionUrl: true`）

2 つ目の条件が無いと、誰でも Invoke API で任意の event を渡せ、Scheduler の固定の Input も偽れる。
デプロイの後、次で条件を確かめる。

```bash
aws lambda get-policy --function-name pecot-board-sync \
  --query Policy --output text | jq '.Statement[] | {Action: .Action, Condition: .Condition}'
```

`lambda:InvokeFunction` の Statement に `lambda:InvokedViaFunctionUrl` の条件が付いていれば正しい。
付いていなければ、スタックを作り直す前に公開をやめ、原因を直す。

## 初回の手順

次の順で行う。1 から 6 は AWS の準備、7 以降が App と `deploy.sh`。

1. AWS アカウントを、GitHub のログインで作る（新しい AWS エクスペリエンス）
   - root ユーザーは作られない。サインインの強さは GitHub の 2 要素認証で決まる
   - 最初のプロジェクトのアカウントが自動で作られる。関数はこのアカウントに置く
2. プランを Paid plan にする
   - Free plan は 6 か月で終わり、アカウントが自動で閉じて、受け口が消える
   - この用途なら、費用は無料の利用枠に収まる。Scheduler は毎時 1 回で月に約 720 回、無料枠は月 1,400 万回である
3. devcontainer で、プロジェクトのアカウントにログインする。ブラウザでプロジェクトのアカウントを選び、表示されたコードを貼る

   ```bash
   aws login --remote --profile pecot --region ap-southeast-2
   ```

4. エージェント用の IAM ロール `claude-agent` を作り、既定のプロファイルにする。詳しくは「エージェントの権限」を参照
5. AWS Budgets で、月 $1 を超えたらメールで知らせるアラートを作る。実際の費用と予測の両方で知らせる
6. ログインの期限が切れたら、3 のコマンドを打ち直す。更新は 12 時間ごとに自動で行われ、最長 90 日続く
7. 2 つの App で、それぞれ秘密鍵をもう 1 本作り、ダウンロードする。Actions の鍵とは別に失効できる
   - security の App（変数 `SECURITY_APP_CLIENT_ID`）
   - dependabot-prs の App（変数 `DEPENDABOT_PRS_APP_CLIENT_ID`）
8. `deploy.sh` を打つ。App ごとに `--put-secrets` を 1 回ずつ打つ。1 回目で関数と Scheduler を置き、2 回目は前回の installation id を使う

   ```bash
   openssl rand -hex 32   # security の webhook の secret。控えておく
   .github/board-sync/deploy.sh --profile <profile> \
     --security-installation-id <id> --dependabot-prs-installation-id <id> \
     --put-secrets security <security の鍵のファイル>
   openssl rand -hex 32   # dependabot-prs の webhook の secret。上と別の値にする
   .github/board-sync/deploy.sh --profile <profile> --put-secrets dependabot-prs <dependabot-prs の鍵のファイル>
   ```

   - installation id は、org の Settings → GitHub Apps → Configure の URL の末尾の数字である。初回は 2 つとも要る
   - webhook の secret は、標準入力から求められる。画面には出ない
   - 1 回目は、スタックが無いので installation id の指定が要る。1 回目にも同じ 2 つの引数を付ける
   - 終わりに表示される 2 つの Webhook URL を控える
   - ダウンロードした 2 つの鍵のファイルを消す
9. security の App の設定で次を行う
   - Repository permissions の Actions を Read and write にする
   - Webhook を Active にし、URL に `<function URL>security`、secret に手順 8 の security の値を入れる
   - Subscribe to events で Dependabot alert・Code scanning alert・Secret scanning alert を選ぶ
10. dependabot-prs の App の設定で次を行う
    - Repository permissions の Actions を Read and write にする
    - Webhook を Active にし、URL に `<function URL>dependabot-prs`、secret に手順 8 の dependabot-prs の値を入れる
    - Subscribe to events で Pull request・Workflow run を選ぶ
11. org の 2 つの App の installation で、権限の追加を承認する

2 回目以降は、installation id を省くと CloudFormation の前回の値を使う。
`--security-client-id`・`--dependabot-prs-client-id`・`--repository-id` は、省くと `gh` で読む。

## エージェントの権限

このリポで Claude Code を起動すると、AWS 公式のプラグイン `aws-core` が有効になる（`.claude/settings.json`）。
プラグインの MCP サーバは、既定のプロファイルの認証情報で AWS を呼ぶ。
既定のプロファイルを、権限を絞った IAM ロール `claude-agent` にする。人のログイン（`pecot`）の全権限を、エージェントに渡さない。

- 読み取りは `ReadOnlyAccess` で、アカウント全体を読める
- 書き込みは `pecot-board-sync` のスタック・関数・ロール・Scheduler・ロググループと、`/pecot/board-sync/*` の SSM に限る
- SSM と Secrets Manager の secret は読めない。鍵は入れられるが、読み返せない

ロールは、次で作る。`<ACCOUNT_ID>` には、プロジェクトのアカウントの ID を入れる。

```bash
A=<ACCOUNT_ID>; R=ap-southeast-2; D=.github/board-sync
sed "s/<ACCOUNT_ID>/$A/g" $D/agent-role-trust.json > trust.json
sed "s/<ACCOUNT_ID>/$A/g; s/<REGION>/$R/g" $D/agent-role-policy.json > policy.json
aws iam create-role --profile pecot --role-name claude-agent --max-session-duration 43200 \
  --assume-role-policy-document file://trust.json
aws iam attach-role-policy --profile pecot --role-name claude-agent \
  --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
aws iam put-role-policy --profile pecot --role-name claude-agent \
  --policy-name board-sync-deploy --policy-document file://policy.json
rm trust.json policy.json
```

既定のプロファイルは、次で `claude-agent` にする。

```bash
aws configure set role_arn arn:aws:iam::<ACCOUNT_ID>:role/claude-agent --profile default
aws configure set source_profile pecot --profile default
aws configure set role_session_name claude-code --profile default
aws configure set region ap-southeast-2 --profile default
aws sts get-caller-identity   # Arn が assumed-role/claude-agent/ で始まれば正しい
```

`~/.aws` は devcontainer のボリュームに置いている。devcontainer を作り直しても、プロファイルとログインは残る。

## 鍵の入れ替え

App ごとに行う。

1. App の設定で新しい秘密鍵を作る
2. `deploy.sh --put-secrets <security|dependabot-prs> <新しい鍵のファイル>` で SSM に入れる。webhook の secret は同じ値を入れ直す
3. `deploy.sh --rotate` を打つ。温まった実行環境が入れ替わり、新しい鍵を読む
4. 古い鍵を App の設定で失効させる
5. 新しい鍵のファイルを消す

## 鍵が漏れたとき

Lambda の鍵を持つ者は、その App の全権限の token を発行できる。影響は App ごとに違う。

- security の App の鍵: 同じ権限で、security alert の読み取りと Tracker の更新ができる
- dependabot-prs の App の鍵: 同じ権限で、PR の読み取りと Tracker の更新ができる

漏れたと分かったら、すぐに App の設定でその鍵を失効させる。
そのあと、上の「鍵の入れ替え」で新しい鍵を入れる。
webhook の secret が漏れたときは、その App の設定で secret を作り直し、`--put-secrets` で SSM にも入れ直す。
もう一方の App は、secret を共有していないので影響を受けない。

## 配送の失敗の見方

GitHub は、失敗した配送を自動で再送しない。

1. 該当する App の設定の Advanced → Recent Deliveries で、失敗した配送を探す
2. 3 日以内なら Redeliver する
3. 関数のログ（CloudWatch Logs の `/aws/lambda/pecot-board-sync`）を見る
   - 呼び出し元（`url` / `scheduler`）、path、イベント、action、番号、run の id だけが残る

Redeliver が間に合わなくても、Scheduler が最大 1 時間で拾う。
Scheduler の起動は、ログの呼び出し元が `scheduler` の行で確かめる。

## 同時実行の上限

新しいアカウントは同時実行の上限が小さく、予約を置けないことがある。
その間、`deploy.sh` は警告を出す。
上限が上がったら、`deploy.sh` を打ち直すと予約が置かれる。
