# test-report-history

リリース版のテストレポートの履歴（`history.jsonl`）を置く AWS のスタックである（#822）。
履歴は 10 回分で約 225 MB になり、git の 1 ファイル 100 MB を超えるので、`pages-store` に置けない。
`test-report.yml` の `history-get`・`history-put` の 2 つの job だけが、OIDC でロールを引き受けて読み書きする。
このリポの運用のためのもので、配布物ではない。
運用の手順は `.claude/rules/pages-site.md` にある。

## 構成

```text
test-report.yml (main の run。environment test-report-history)
  history-get / history-put
    -> OIDC のトークン (sub = <前置き>:environment:test-report-history)
    -> sts:AssumeRoleWithWebIdentity でロール pecot-test-report-history-actions を引き受ける
    -> S3 の pecot-test-report-history-<アカウント ID>/release/history.jsonl を読み書きする
```

- 構成は `template.yaml`（CloudFormation）である。スタック名は `pecot-test-report-history`、リージョンは `ap-southeast-2` である
  - アカウントは、board-sync と同じプロジェクトのアカウントである
- バケット `pecot-test-report-history-<アカウント ID>`
  - 公開のブロックを全部有効にし、`BucketOwnerEnforced` と既定の暗号化（SSE-S3）を付ける
  - バージョニングを有効にする。古い版は 7 日で消え、終わらないマルチパートは 1 日で消える
  - 置くのは `release/history.jsonl` の 1 つだけである
- OIDC のプロバイダ `token.actions.githubusercontent.com`
  - アカウントに 1 つしか置けない。今はこのスタックが持つ
  - ほかの用途が使うようになったら、プロバイダを別のスタックへ移す
  - アカウントに既にあれば作らず、その ARN を Parameter `ExistingOidcProviderArn` に渡す
- ロール `pecot-test-report-history-actions`
  - 信頼の条件は、`aud` が `sts.amazonaws.com`、`sub` が `<前置き>:environment:test-report-history` で、どちらも `StringEquals` である
  - 前置きは、このリポの OIDC の subject の形で決まる。このリポは ID の形（immutable subject）を使う
  - 許可は、`release/history.jsonl` の `s3:GetObject`・`s3:PutObject` と、バケットの `s3:ListBucket` だけである
  - 権限の境界 `pecot-test-report-history-boundary`（`role-boundary.json`）を付ける。中身は、ロールの許可と同じ範囲である
- environment `test-report-history`
  - デプロイ先は、種類が Branch の `main` だけである。environment を参照する job の `sub` は、どの契機でも同じ値である。`main` 以外の ref の run は、このデプロイ先の決まりで job が止まり、ロールに入れない
  - ロールの ARN とバケットの名前は、この environment の変数に置く。アカウント ID をリポに書かない

| Parameter | 既定値 | 値 |
|---|---|---|
| `SubjectPrefix` | なし | OIDC の `sub` の前置き |
| `EnvironmentName` | `test-report-history` | ロールを引き受けられる job の environment |
| `ExistingOidcProviderArn` | 空 | 既にあるプロバイダの ARN。空ならスタックで作る |

| Output | 入れる先 |
|---|---|
| `RoleArn` | environment の変数 `TEST_REPORT_HISTORY_ROLE_ARN` |
| `BucketName` | environment の変数 `TEST_REPORT_HISTORY_BUCKET` |

## 初回の手順

1・2・4 は利用者が行い、3・5 はエージェントが行う。

1. devcontainer で、プロジェクトのアカウントにログインする。対話式なので、Claude Code の外の端末で打つ

   ```bash
   aws login --remote --profile pecot --region ap-southeast-2
   ```

2. 人のログイン（`pecot`）で、ロールの境界を作り、`claude-agent` の許可を差し替える
   - 境界は、スタックの外で人が作る。`claude-agent` が自分で境界を作れると、境界の意味が無くなるため
   - `claude-agent` の許可は `.github/board-sync/agent-role-policy.json` である。このスタックの分も、同じファイルに入っている

   ```bash
   A=$(aws sts get-caller-identity --profile pecot --query Account --output text); R=ap-southeast-2
   sed "s/<ACCOUNT_ID>/$A/g; s/<REGION>/$R/g" .github/test-report-history/role-boundary.json > boundary.json
   sed "s/<ACCOUNT_ID>/$A/g; s/<REGION>/$R/g" .github/board-sync/agent-role-policy.json > policy.json
   aws iam create-policy --profile pecot --policy-name pecot-test-report-history-boundary \
     --policy-document file://boundary.json
   aws iam put-role-policy --profile pecot --role-name claude-agent \
     --policy-name board-sync-deploy --policy-document file://policy.json
   rm boundary.json policy.json
   ```

3. 既定のプロファイル（`claude-agent`）で、スタックを作る
   - 先に、アカウントに GitHub の OIDC のプロバイダがあるかを見る

     ```bash
     aws iam list-open-id-connect-providers
     ```

   - `oidc-provider/token.actions.githubusercontent.com` が無ければ、次で作る

     ```bash
     P=$(gh api repos/pecotcraft/pecot/actions/oidc/customization/sub --jq .sub_claim_prefix)
     aws cloudformation deploy --stack-name pecot-test-report-history \
       --template-file .github/test-report-history/template.yaml \
       --capabilities CAPABILITY_NAMED_IAM \
       --parameter-overrides SubjectPrefix="$P"
     ```

     - `P` は、今は `repo:pecotcraft@351183614/pecot@1445775113` である
   - あれば、上の `--parameter-overrides` に `ExistingOidcProviderArn=<一覧の ARN>` を足す
   - 終わったら、Outputs を読む

     ```bash
     aws cloudformation describe-stacks --stack-name pecot-test-report-history \
       --query 'Stacks[0].Outputs' --output table
     ```

4. リポの Settings → Environments で、environment `test-report-history` を作る
   - New environment を押し、名前に `test-report-history` を入れる
   - Deployment branches and tags を「Selected branches and tags」にする
   - Add deployment branch or tag rule を押し、Ref type を Branch、Name pattern を `main` にする
     - 種類を Tag にしない。`main` という名前のタグが通る
   - Environment variables の Add environment variable で、次の 2 つを入れる。値は、手順 3 の Outputs である
     - `TEST_REPORT_HISTORY_ROLE_ARN`: `RoleArn` の値
     - `TEST_REPORT_HISTORY_BUCKET`: `BucketName` の値
   - secret は置かない
5. ロールの信頼の条件を確かめる

   ```bash
   aws iam get-role --role-name pecot-test-report-history-actions \
     --query Role.AssumeRolePolicyDocument
   ```

   - `Principal.Federated` が `oidc-provider/token.actions.githubusercontent.com` の ARN であれば正しい
   - `Condition.StringEquals` に、次の 2 つだけがあれば正しい
     - `token.actions.githubusercontent.com:aud` が `sts.amazonaws.com`
     - `token.actions.githubusercontent.com:sub` が、手順 3 の `P` に `:environment:test-report-history` を足したもの
   - `StringLike` やワイルドカードがあれば、environment の外の run も引き受けられる。スタックを直すまで、environment の変数を空にする
6. environment のデプロイ先を確かめる。`sub` はどの契機でも同じなので、`main` 以外の ref の run を止めるのはこの決まりだけである

   ```bash
   gh api repos/pecotcraft/pecot/environments/test-report-history --jq .deployment_branch_policy
   gh api repos/pecotcraft/pecot/environments/test-report-history/deployment-branch-policies \
     --jq '.branch_policies[] | [.type, .name]'
   ```

   - 1 つ目が `{"custom_branch_policies":true,"protected_branches":false}` であれば正しい
   - 2 つ目が `["branch","main"]` の 1 行だけであれば正しい
   - 違えば、手順 4 のとおりに直すまで、environment の変数を空にする
